"""Acceptance of an unpacked Windows/macOS application, using isolated profiles.

Run after packaging: python scripts/test-packaged.py
Requires Python Playwright. Refuses an old/missing app.asar before launching an EXE.
"""
import argparse
import base64
from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def sha256(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def history_rows(file):
    with closing(sqlite3.connect(Path(file).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        return {table: [dict(row) for row in db.execute(f'SELECT * FROM {table} ORDER BY rowid')]
                for table in ['threads', 'local_thread_catalog_hosts', 'local_thread_catalog', 'private_payload']}


def packaged_history_fixture(home):
    """Real SQLite fixtures; no client-process bypass or host-profile access."""
    existing_id = '60000000-0000-4000-8000-000000000001'
    missing_id = '60000000-0000-4000-8000-000000000002'
    duplicate_id = '60000000-0000-4000-8000-000000000003'
    ambiguous_id = '60000000-0000-4000-8000-000000000004'
    rollout = home / 'sessions' / f'rollout-{existing_id}.jsonl'
    missing = home / 'sessions' / f'rollout-{missing_id}.jsonl'
    rollout.parent.mkdir(parents=True, exist_ok=True)
    records = [json.dumps({'type': 'session_meta', 'payload': {'id': existing_id, 'model_provider': 'retired-provider', 'model': 'retired-model', 'source': 'cli', 'cwd': str(home)}}, separators=(',', ':')),
               ' {"type":"event_msg","payload":{"type":"user_message","message":"keep conversation bytes"}} ',
               '{"type":"response_item","payload":{"encrypted_content":"fixture-opaque-history"}}']
    rollout.write_bytes(('\r\n'.join(records) + '\r\n').encode('utf-8'))
    duplicate = home / 'sessions' / f'rollout-{duplicate_id}.jsonl'
    ambiguous = home / 'sessions' / f'rollout-{ambiguous_id}.jsonl'
    archived = home / 'archived_sessions' / f'rollout-{ambiguous_id}.jsonl'
    archived.parent.mkdir(parents=True, exist_ok=True)
    for file, session_id in [(duplicate, duplicate_id), (ambiguous, ambiguous_id), (archived, ambiguous_id)]:
        file.write_bytes(('\r\n'.join(records).replace(existing_id, session_id) + '\r\n').encode('utf-8'))
    invalid_json = home / 'sessions' / 'unparseable-json.jsonl'
    invalid_utf8 = home / 'sessions' / 'unparseable-utf8.jsonl'
    invalid_json.write_bytes(b'{"type":"session_meta","payload":\r\nnot valid JSON\r\n')
    invalid_utf8.write_bytes(b'\xff\xfe\x00\x80 invalid UTF-8 history\r\n')
    untouched_files = {file: file.read_bytes() for file in [duplicate, ambiguous, archived, invalid_json, invalid_utf8]}
    databases = [home / 'state_5.sqlite', home / 'state_6.sqlite']
    for index, database in enumerate(databases):
        # DELETE mode and closed connections keep the busy-client zero-write
        # assertion independent of SQLite reader-created WAL sidecars.
        with closing(sqlite3.connect(database)) as db:
            db.executescript("""PRAGMA journal_mode=DELETE;
CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,rollout_path TEXT,title TEXT,archived INTEGER,untouched TEXT);
CREATE TABLE local_thread_catalog_hosts(host_id TEXT PRIMARY KEY,host_kind TEXT);
INSERT INTO local_thread_catalog_hosts VALUES('desktop','local'),('remote','remote');
CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,model_provider TEXT,PRIMARY KEY(host_id,thread_id));
CREATE TABLE private_payload(id INTEGER PRIMARY KEY,opaque TEXT);
INSERT INTO private_payload VALUES(1,'keep unrelated database content');""")
            rows = [(missing_id, f'missing-region-{index}', missing), (duplicate_id, 'retired-provider', duplicate)]
            if index == 0:
                rows.extend([(existing_id, 'retired-provider', rollout), (ambiguous_id, 'retired-provider', ambiguous)])
            for session_id, provider, file in rows:
                db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?)', (session_id, provider, str(file), 'Fixture history', 0, 'keep native metadata'))
                db.execute('INSERT INTO local_thread_catalog VALUES(?,?,?)', ('desktop', session_id, provider))
                db.execute('INSERT INTO local_thread_catalog VALUES(?,?,?)', ('remote', session_id, 'remote-original'))
            db.commit()
    before_rows = {database: history_rows(database) for database in databases}
    before_log = rollout.read_bytes()

    def assert_provider(provider):
        assert not missing.exists(), 'Missing-source history must not be fabricated'
        assert all(file.read_bytes() == content for file, content in untouched_files.items()), 'Skipped corrupt or ambiguous history bytes changed'
        before_lines, lines = before_log.splitlines(keepends=True), rollout.read_bytes().splitlines(keepends=True)
        assert lines[1:] == before_lines[1:], 'Conversation body or opaque history bytes changed'
        expected_metadata = json.loads(before_lines[0])
        expected_metadata['payload']['model_provider'] = provider
        assert json.loads(lines[0]) == expected_metadata, 'History metadata differs beyond the provider'
        for database in databases:
            expected = json.loads(json.dumps(before_rows[database]))
            for row in expected['threads']:
                if row['id'] == existing_id:
                    row['model_provider'] = provider
            for row in expected['local_thread_catalog']:
                if row['host_id'] == 'desktop' and row['thread_id'] == existing_id:
                    row['model_provider'] = provider
            assert history_rows(database) == expected, 'Missing-source copies, remote rows or unrelated database content changed'

    def snapshot():
        return {'files': {file: file.read_bytes() for file in [rollout, *untouched_files]},
                'databases': {database: history_rows(database) for database in databases}}

    def assert_backup(backup_path, before, repaired):
        journal = json.loads((Path(backup_path) / 'manifest.json').read_text(encoding='utf-8'))
        assert journal['status'] == 'complete' and journal['sessions'] == repaired, journal
        assert len(journal['files']) == 6 and len(journal['databases']) == 2, 'Every source including corrupt files and every index database needs an actual backup'
        logs = {Path(entry['path']).resolve(): entry for entry in journal['files']}
        assert set(logs) == {file.resolve() for file in before['files']}
        for file, content in before['files'].items():
            assert Path(logs[file.resolve()]['original']).read_bytes() == content, 'Backup did not retain raw original history bytes'
        assert len(journal['skipped']) == 4 and all(item['reason'] for item in journal['skipped']), 'Skipped history must be recorded with its reason in the backup manifest'
        entries = {Path(entry['path']).resolve(): entry for entry in journal['databases']}
        assert set(entries) == {database.resolve() for database in databases}
        for database in databases:
            assert history_rows(entries[database.resolve()]['backup']) == before['databases'][database], 'Database backup lost cross-database history or unrelated content'

    return {'databases': databases, 'rollout': rollout, 'assert_provider': assert_provider, 'snapshot': snapshot, 'assert_backup': assert_backup}


def assert_history_preview(preview, repairable, unchanged):
    assert preview['ok'] and preview['revision'], preview
    history = preview['history']
    assert history['status'] == 'pending', history
    expected = {'total': 6, 'repairable': repairable, 'unchanged': unchanged, 'preserved': 1, 'skipped': 4, 'blocked': 0,
                'filesToBackUp': 6, 'indexDatabasesToBackUp': 2, 'backupRequired': True}
    assert {key: history[key] for key in expected} == expected, history
    assert not history['blockedReasons'], history
    assert history['skippedReasons'], 'Skipped reasons must be available without blocking configuration'


def assert_history_result(result, repaired, unchanged):
    assert result['ok'], result
    history = result['history']
    assert history['status'] == 'completed', history
    expected = {'backedUp': 6, 'indexBackedUp': 2, 'repaired': repaired, 'unchanged': unchanged, 'preserved': 1, 'skipped': 4}
    assert {key: history[key] for key in expected} == expected, history
    assert history['backupId'] and history['backupPath'], history


def release_resource_manifest():
    """Share the reviewed distribution exclusions with the resource build step."""
    policy = json.loads((ROOT / 'scripts/extension-resource-policy.json').read_text(encoding='utf-8'))
    source = ROOT / 'third_party/codexplusplus'
    manifest = json.loads((source / 'FILES.sha256.json').read_text(encoding='utf-8'))
    assert policy['schemaVersion'] == 1
    assert len(manifest) == policy['sourceFiles'], 'Pinned resource count changed; review the distribution policy'
    assert json.loads((source / 'UPSTREAM.json').read_text(encoding='utf-8'))['commit'] == policy['upstreamCommit']
    excluded = set(policy['excluded'])
    assert len(excluded) == len(policy['excluded']), 'Duplicate resource exclusion'
    paths = set()
    for record in manifest:
        name = record['path']
        assert isinstance(name, str) and name and '\\' not in name, 'Invalid resource path'
        assert all(part and part not in ('.', '..') and not re.search(r'[<>:"|?*\x00-\x1f]|[. ]$', part) for part in name.split('/')), name
        assert name != 'FILES.sha256.json' and name.lower() not in paths, 'Duplicate resource path'
        paths.add(name.lower())
        assert type(record['bytes']) is int and record['bytes'] >= 0 and re.fullmatch(r'[a-f0-9]{64}', record['sha256']), name
        if name.endswith('.test.cjs') or name.startswith('source/'):
            assert name in excluded, f'Unreviewed source-only resource: {name}'
    assert excluded <= {record['path'] for record in manifest}, 'Excluded source assets are missing'
    return [record for record in manifest if record['path'] not in excluded]


def verify_packaged_resources(bundled):
    """Require the exact reviewed subset, including no unmanifested test files."""
    bundled = Path(bundled).absolute()
    for directory in (bundled, *bundled.parents):
        assert not directory.is_symlink() and not getattr(directory, 'is_junction', lambda: False)(), f'Linked resource directory: {directory}'
    expected = release_resource_manifest()
    actual = set()
    for file in bundled.rglob('*'):
        assert not file.is_symlink() and not getattr(file, 'is_junction', lambda: False)(), f'Linked packaged resource: {file}'
        assert file.is_file() or file.is_dir(), f'Not a regular packaged resource: {file}'
        if file.is_file():
            actual.add(file.relative_to(bundled).as_posix())
    assert actual == {record['path'] for record in expected} | {'FILES.sha256.json'}, 'Unexpected or missing packaged resource files'
    manifest = json.loads((bundled / 'FILES.sha256.json').read_text(encoding='utf-8'))
    assert manifest == expected, 'Packaged resource manifest differs from the reviewed source subset'
    for record in expected:
        file = bundled / record['path']
        assert file.stat().st_size == record['bytes'] and sha256(file) == record['sha256'], f'Packaged resource integrity mismatch: {record["path"]}'
    return manifest


def read_asar(file, relative):
    """Read one ordinary file from Electron's Chromium-pickle ASAR header."""
    with Path(file).open('rb') as stream:
        first = stream.read(8)
        if len(first) != 8:
            raise AssertionError('app.asar is incomplete; finish packaging first')
        size, header_size = struct.unpack('<II', first)
        assert size == 4 and 8 <= header_size <= 32 * 1024 * 1024, 'Invalid ASAR header'
        header = stream.read(header_size)
        assert len(header) == header_size, 'Incomplete ASAR header'
        text_size = struct.unpack('<I', header[4:8])[0]
        tree = json.loads(header[8:8 + text_size])
        entry = tree
        for part in relative.split('/'):
            entry = entry['files'][part]
        assert not entry.get('unpacked') and not entry.get('link'), 'Expected an ordinary packed file'
        assert 0 <= entry['size'] <= 4 * 1024 * 1024, 'Unexpected test metadata size'
        stream.seek(8 + header_size + int(entry['offset']))
        content = stream.read(entry['size'])
        assert len(content) == entry['size'], 'Incomplete packed file'
        return content


class CatalogHandler(BaseHTTPRequestHandler):
    catalog = (ROOT / 'server/seed-catalog.json').read_bytes()

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path != '/catalog':
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(self.catalog)))
        self.end_headers()
        self.wfile.write(self.catalog)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, default=ROOT / 'release/win-unpacked/YunHuiAI.exe')
    parser.add_argument('--launcher', type=Path, help='Launch a portable wrapper and verify its extracted runtime against --exe')
    parser.add_argument('--version', default=json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version'])
    parser.add_argument('--expect-history-deferred', '--expect-client-busy', dest='expect_history_deferred', action='store_true', help='Require successful isolated configuration apply/restore while a real running client defers history without history writes')
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert executable.is_file(), f'Build the release first: {executable}'
    launcher = args.launcher.resolve() if args.launcher else executable
    assert launcher.is_file(), f'Portable wrapper is missing: {launcher}'
    resources = executable.parent.parent / 'Resources' if sys.platform == 'darwin' else executable.parent / 'resources'
    asar = resources / 'app.asar'
    assert asar.is_file(), 'Packaged app.asar is missing'
    package = json.loads(read_asar(asar, 'package.json'))
    assert package['version'] == args.version, f"Refusing old artifact {package['version']}; expected {args.version}"
    built_main = ROOT / 'dist/main/main.cjs'
    assert built_main.is_file(), 'Build the current source before packaged acceptance'
    assert read_asar(asar, 'dist/main/main.cjs') == built_main.read_bytes(), 'Packaged main process differs from the current build'
    assert package['license'] == 'AGPL-3.0-only'
    assert b'GNU AFFERO GENERAL PUBLIC LICENSE' in read_asar(asar, 'LICENSE')
    assert b'Facebook, Inc.' in read_asar(asar, 'THIRD_PARTY_NOTICES.md')
    bundled = resources / 'codexplusplus'
    manifest = verify_packaged_resources(bundled)

    profile = Path(tempfile.mkdtemp(prefix='yunhui-packaged-')).resolve()
    data, clients, chromium = profile / 'data', profile / 'clients', profile / 'chromium'
    for folder in [data, clients / '.claude', clients / '.codex', chromium, profile / 'appdata', profile / 'localappdata']:
        folder.mkdir(parents=True, exist_ok=True)
    fixture_files = {
        clients / '.claude/settings.json': '{"permissions":{"allow":["Read"]},"env":{"FIXTURE":"unchanged"}}\n',
        clients / '.codex/config.toml': 'model = "fixture-model"\n',
        clients / '.codex/auth.json': '{"auth_mode":"chatgpt","tokens":{"refresh_token":"fixture-not-a-real-login"}}\n',
    }
    for file, value in fixture_files.items():
        file.write_text(value, encoding='utf-8')
    original = {file: file.read_bytes() for file in fixture_files}
    history_fixture = packaged_history_fixture(clients / '.codex')
    history_original = history_fixture['snapshot']()
    catalog = ThreadingHTTPServer(('127.0.0.1', 0), CatalogHandler)
    threading.Thread(target=catalog.serve_forever, daemon=True).start()
    port, debug_port = free_port(), free_port()
    (data / 'settings.json').write_text(json.dumps({
        'theme': 'light', 'gatewayHost': '127.0.0.1', 'gatewayPort': port,
        'autoStartGateway': True, 'autoCheckUpdate': False, 'closeToTray': False,
        'autoSyncModels': False, 'updateUrl': 'https://yunhui.me/pub.php?action=update',
        'catalogUrl': f'http://127.0.0.1:{catalog.server_port}/catalog',
    }), encoding='utf-8')
    environment = dict(os.environ, YUNHUI_TEST_ISOLATED='1', AURORA_HOME=str(data), YUNHUI_HOME=str(data), AURORA_CLIENT_HOME=str(clients),
                       APPDATA=str(profile / 'appdata'), LOCALAPPDATA=str(profile / 'localappdata'))
    for key in ['ELECTRON_RUN_AS_NODE', 'AURORA_EXTENSION_ASSETS', 'AURORA_DEV', 'AURORA_UI_URL', 'AURORA_SHOT', 'AURORA_PAGE']:
        environment.pop(key, None)
    logs = (profile / 'packaged.log').open('w', encoding='utf-8')
    process = None
    checks = ['Packaged version and AGPL notices', f'All {len(manifest)} distributed resource hashes match pinned source; upstream tests and Rust reference sources are absent']
    errors = []
    try:
        process = subprocess.Popen([
            str(launcher), f'--remote-debugging-port={debug_port}', f'--user-data-dir={chromium}',
        ], cwd=profile, env=environment, stdout=logs, stderr=logs,
           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        deadline = time.monotonic() + (60 if args.launcher else 35)
        while time.monotonic() < deadline:
            assert process.poll() is None, f'Packaged executable exited with code {process.returncode}; see {profile / "packaged.log"}'
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{debug_port}/json/version', timeout=.5).close()
                break
            except (OSError, urllib.error.URLError):
                time.sleep(.2)
        else:
            raise AssertionError(f'Packaged CDP startup timed out; see {profile / "packaged.log"}')
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}')
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event('page')
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.get_by_role('heading', name='连接你的 AI 客户端.', exact=True).wait_for(timeout=30000)
            location = urllib.parse.unquote(page.url).replace('\\', '/').lower()
            assert '/resources/app.asar/dist/ui/index.html' in location, location
            state = page.evaluate("async () => {const s=await window.aurora.invoke('state.get');return {version:s.version,dataDir:s.dataDir,gateway:s.gateway,providers:s.providers.length};}")
            assert state['version'] == args.version and Path(state['dataDir']).resolve() == data.resolve(), state
            assert state['providers'] == 0, 'Acceptance must use a fresh supplier profile'
            packaged = page.evaluate("() => window.aurora.invoke('app.isDev')")
            runtime_asar = Path(packaged['root']).resolve()
            assert packaged['dev'] is False and runtime_asar.is_file(), packaged
            if args.launcher:
                assert sha256(runtime_asar) == sha256(asar), 'Portable wrapper extracted a different app.asar'
                assert verify_packaged_resources(runtime_asar.parent / 'codexplusplus') == manifest
                checks.append(f'Portable wrapper extracts the verified application and exactly {len(manifest)} distributed resources')
            else:
                assert runtime_asar == asar.resolve(), packaged
            expect(page.locator('.app')).to_have_attribute('data-platform', 'darwin' if sys.platform == 'darwin' else 'win32')
            expect(page.locator('.win-controls')).to_have_count(0 if sys.platform == 'darwin' else 1)
            expect(page.locator('.quick-search kbd')).to_have_text('⌘ K' if sys.platform == 'darwin' else 'Ctrl K')
            checks.append('Actual native packaged application renders app.asar with platform-specific controls and isolated data')

            deadline = time.monotonic() + 15
            while not page.evaluate("async () => (await window.aurora.invoke('gateway.status')).running === true"):
                assert time.monotonic() < deadline, 'Packaged gateway startup timed out'
                page.wait_for_timeout(200)
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=5) as response:
                health = json.load(response)
                assert health == {'ok': True, 'running': True}, health
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state', timeout=5)
                raise AssertionError('Unauthenticated management request was accepted')
            except urllib.error.HTTPError as error:
                assert error.code == 401, error.code
            checks.append('Packaged gateway health is ready and management rejects missing credentials')

            extensions = page.evaluate("""async () => {
                const r=await window.aurora.invoke('extension.list');
                if(r.error)throw new Error(r.error);
                return {ok:r.ok,bundled:r.items.filter(i=>i.source==='bundled').map(i=>i.id),builtin:r.items.filter(i=>i.source==='builtin').length,catalogs:r.catalogs};
            }""")
            assert extensions['ok'] and extensions['builtin'] == 32, extensions
            assert set(extensions['bundled']) == {'bundled:' + name for name in ['agent-pet', 'typing-effects', 'image-overlay', 'usage-statusline', 'proxy-request-status']}
            assert extensions['catalogs']['public']['count'] == 520 and extensions['catalogs']['full']['count'] == 5491
            checks.append('Installed runtime loads 5 complete packages, 32 builtins and both pinned markets')

            images = ROOT / 'docs/images'
            images.mkdir(exist_ok=True)
            page.get_by_role('button', name='系统设置', exact=True).click()
            page.get_by_role('button', name='版本更新', exact=True).click()
            expect(page.get_by_role('button', name='检查更新', exact=True)).to_be_visible()
            expect(page.get_by_label('远端目录地址', exact=True)).to_have_count(0)
            expect(page.get_by_text('供应商目录', exact=True)).to_have_count(0)
            expect(page.get_by_text('更新接口地址', exact=True)).to_have_count(0)
            settings = page.evaluate("async () => (await window.aurora.invoke('state.get')).settings")
            assert settings['autoSyncModels'] is True
            assert settings['updateUrl'] == 'https://api.github.com/repos/yunhui201/yunhui.me/releases/latest'
            page.screenshot(path=str(images / 'settings-v0.6.png'), animations='disabled', style='.toast-wrap{visibility:hidden!important}')
            checks.append('Packaged settings hide catalog controls and migrate legacy preferences to automatic sync and GitHub releases')
            build = page.evaluate("async () => (await window.aurora.invoke('state.get')).build")
            assert build and build['id'] and build['builtAt'], 'Actual package must identify its build, not only its version number'
            if build['channel'] == 'local':
                expect(page.get_by_text('本地调试版', exact=False)).to_be_visible()
            page.get_by_role('button', name='数据与关于', exact=True).click()
            expect(page.get_by_role('link', name='项目源码 ↗', exact=True)).to_have_attribute('href', 'https://github.com/yunhui201/yunhui.me')
            checks.append('The packaged build is identifiable and source links do not depend on an unpublished release tag')
            page.locator('nav').get_by_role('button', name='历史会话', exact=True).click()
            page.get_by_role('button', name='批量修复历史 / 区域迁移', exact=True).click()
            dialog = page.get_by_role('dialog', name='历史会话 · 批量修复', exact=True)
            expect(dialog.get_by_label('目标供应商标识', exact=True)).to_be_enabled()
            regions = page.evaluate("async () => await window.aurora.invoke('codex.repair.providers')")
            assert regions['ok'] and any(item['id'] == 'openai' for item in regions['targets'])
            dialog.get_by_role('button', name='关闭', exact=True).click()
            checks.append('Native packaged IPC exposes history region selection and provider discovery')

            page.locator('nav').get_by_role('button', name='插件中心', exact=True).click()
            page.get_by_role('heading', name='ChatGPT 桌面版插件', exact=True).wait_for(timeout=15000)
            page.get_by_role('button', name='官方拓展包 5', exact=True).click()
            expect(page.locator('.extension-card')).to_have_count(5)
            expect(page.get_by_text('云汇桌面扩展', exact=True)).to_be_visible()
            assert 'CODEX++' not in page.locator('main').inner_text().upper()
            extension_state = page.evaluate("() => window.aurora.invoke('extension.list')")
            assert extension_state['client']['installed'] is False, 'Isolated acceptance must not discover a real desktop client'
            recovery = page.get_by_role('region', name='桌面插件连接处理', exact=True)
            expect(recovery).to_be_visible()
            expect(recovery.get_by_role('alert')).to_have_count(1)
            for label in ['选择程序', '重新连接', '恢复默认连接设置']:
                expect(recovery.get_by_role('button', name=label, exact=True)).to_be_enabled()
            assert page.get_by_role('alert').count() == 1, 'Unexpected error outside the missing-client recovery panel'
            page.screenshot(path=str(images / 'plugins-v0.6.png'), animations='disabled', style='.toast-wrap{visibility:hidden!important}')
            checks.append('Packaged plugin page renders all five packages and offers three recovery actions for the isolated missing client without unrelated errors')

            page.locator('nav').get_by_role('button', name='云汇会员', exact=True).click()
            page.get_by_role('heading', name='云汇会员', exact=True).wait_for()
            expect(page.get_by_label('平台会员邮箱', exact=True)).to_be_visible()
            expect(page.get_by_label('平台会员密码', exact=True)).to_have_value('')
            expect(page.get_by_label('会员访问令牌', exact=True)).to_have_value('')
            # Wait only for the public configuration read; never log in, bind or claim a gift.
            page.wait_for_function("() => !document.querySelector('button[type=submit]')?.disabled || !!document.querySelector('[role=alert], main .notice')", timeout=40000)
            membership_warning = page.get_by_role('alert').all_text_contents()
            page.screenshot(path=str(images / 'membership-v0.6.png'), animations='disabled', style='.toast-wrap{visibility:hidden!important}')
            checks.append('Packaged membership onboarding renders without authenticated user state')
            page.locator('nav').get_by_role('button', name='客户端接入', exact=True).click()
            expect(page.get_by_role('button', name='重新启动客户端', exact=True).first).to_be_visible()
            expect(page.get_by_role('button', name='新终端打开', exact=True).first).to_be_visible()
            lifecycle = page.evaluate("() => window.aurora.invoke('agent.lifecycle', {agentId:'claude-desktop'})")
            assert lifecycle['ok'] and lifecycle['kind'] == 'desktop' and not lifecycle['installed'] and not lifecycle['supported'], lifecycle
            service = page.evaluate("() => window.aurora.invoke('agent.restart', {agentId:'deepseek'})")
            assert not service['ok'] and service['operation'] == 'unsupported', service
            rejected = page.evaluate("() => window.aurora.invoke('agent.restart', {agentId:'claude-desktop', pid:1})")
            assert rejected.get('error'), 'Native lifecycle accepted a renderer-supplied process ID'
            checks.append('Packaged client cards expose restart and terminal actions; native IPC rejects API services and process overrides without launching any client')
            assert not errors, errors
            assert all(file.read_bytes() == before for file, before in original.items()), 'A read-only check changed a client config'
            assert history_fixture['snapshot']() == history_original, 'A read-only view changed isolated history'
            checks.append('Read-only views leave isolated client configurations unchanged')

            supplier = page.evaluate("""() => window.aurora.invoke('provider.save', {
                name:'Native configuration acceptance',baseUrl:'http://127.0.0.1:9/v1',format:'openai-responses',enabled:true,
                apiKeys:[{id:'fixture',label:'fixture',key:'fixture-not-a-real-key',enabled:true,weight:1}],models:[{id:'gpt-6.1-sol'}]
            })""")
            detected = page.evaluate("async () => (await window.aurora.invoke('agent.detect'))['chatgpt-desktop']")
            assert detected['configured'] is True and detected['installed'] is False, detected
            assert Path(detected['configPath']).resolve() == (clients / '.codex/config.toml').resolve()
            page.locator('nav').get_by_role('button', name='我的供应商', exact=True).click()
            page.locator('nav').get_by_role('button', name='客户端接入', exact=True).click()
            # The fixture was saved through IPC; refresh UI state before opening
            # a wizard whose initial provider choice is intentionally preserved.
            page.get_by_role('button', name='检测本地客户端', exact=True).click()
            expect(page.locator('nav').get_by_role('button', name='我的供应商', exact=True).locator('.badge')).to_have_text('1')
            card = page.locator('.client-card').filter(has=page.get_by_text('ChatGPT 桌面版', exact=True))
            expect(card.get_by_text('发现本地配置', exact=True)).to_be_visible()
            card.get_by_role('button', name='开始配置 →', exact=True).click()
            wizard = page.get_by_role('dialog', name='配置 ChatGPT 桌面版', exact=True)
            wizard.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
            expect(wizard.get_by_role('region', name='共享编程配置')).to_be_visible()
            wizard.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(wizard.get_by_role('button', name='保存配置', exact=True)).to_be_enabled()
            history_summary = wizard.locator('details[aria-label="历史会话辅助处理"]')
            expect(history_summary).not_to_have_attribute('open', '')
            expect(wizard.get_by_role('alert')).to_have_count(0)
            selection = {'agentId': 'chatgpt-desktop', 'providerId': supplier['id'], 'model': 'gpt-6.1-sol', 'authMode': 'api', 'mode': 'gateway'}
            initial_preview = page.evaluate("p => window.aurora.invoke('agent.preview', p)", selection)
            assert initial_preview['ok'] and initial_preview['revision'], initial_preview
            history_files_before = {file: file.read_bytes() for file in [*history_original['files'], *history_original['databases']]}
            if args.expect_history_deferred:
                assert initial_preview['history']['status'] == 'deferred', initial_preview
            else:
                assert_history_preview(initial_preview, 1, 0)
            assert history_fixture['snapshot']() == history_original, 'Configuration preview wrote isolated history'
            assert (clients / '.codex/config.toml').read_bytes() == original[clients / '.codex/config.toml']

            def assert_deferred_history(result=None):
                if result is not None:
                    assert result['ok'], result
                    history = result['history']
                    assert history['status'] == 'deferred' and history['code'] == 'CLIENT_HISTORY_BUSY', history
                    assert not any(history.get(key) for key in ['backedUp', 'indexBackedUp', 'repaired', 'backupId', 'backupPath']), history
                assert history_fixture['snapshot']() == history_original, 'A running client must leave history rows and log contents unchanged'
                assert all(file.read_bytes() == before for file, before in history_files_before.items()), 'Deferred history changed raw SQLite or log bytes'
                assert not list((clients / '.codex').rglob('manifest.json')), 'Deferred history created a backup or migration manifest'
                assert (clients / '.codex/auth.json').read_bytes() == original[clients / '.codex/auth.json']

            wizard.get_by_role('button', name='保存配置', exact=True).click()
            expect(wizard.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            expect(wizard.get_by_role('alert')).to_have_count(0)
            expect(wizard.get_by_role('button', name='已退出，重新应用', exact=True)).to_have_count(0)
            history_outcome = wizard.locator('details[aria-label="历史会话处理结果"]')
            expect(history_outcome).not_to_have_attribute('open', '')
            history_outcome.locator(':scope > summary').click()
            if args.expect_history_deferred:
                expect(history_outcome).to_contain_text('历史稍后处理 · 配置已保存')
                expect(history_outcome).not_to_contain_text('已备份')
                expect(history_outcome).not_to_contain_text('已修复')
                assert_deferred_history()
                first_backup = None
            else:
                expect(history_outcome).to_contain_text('已备份 6 个会话文件和 2 个索引数据库')
                expect(history_outcome).to_contain_text('已修复 1 个会话，0 个无需修改')
                expect(history_outcome).to_contain_text('1 条未找到原文件的会话索引已随数据库备份并原样保留')
                expect(history_outcome).to_contain_text('4 个会话未修复，已完整备份并原样保留')
                first_backups = page.evaluate("() => window.aurora.invoke('codex.repair.backups')")
                assert first_backups['ok'] and len(first_backups['backups']) == 1, first_backups
                first_backup = first_backups['backups'][0]
                history_fixture['assert_backup'](first_backup['path'], history_original, 1)
            configured = (clients / '.codex/config.toml').read_text(encoding='utf-8')
            assert 'model_provider = "yunhui"' in configured and supplier['id'] + '/gpt-6.1-sol' in configured
            limits = tomllib.loads(configured)
            target_blocks = re.findall(r'^# yunhui-history-provider:v1:([A-Za-z0-9_-]+):([a-f0-9]{64})\n(.*?)^# yunhui-history-provider:end:\1$', configured, re.MULTILINE | re.DOTALL)
            owned_targets = []
            for encoded_id, digest, body in target_blocks:
                if body.startswith('# yunhui-history-target:v1\n'):
                    assert hashlib.sha256(body.encode('utf-8')).hexdigest() == digest
                    owned_targets.append(base64.urlsafe_b64decode(encoded_id + '=' * (-len(encoded_id) % 4)).decode('utf-8'))
            assert len(owned_targets) == 1, 'Automatic history needs one verified owned provider for the selected route'
            history_target = owned_targets[0]
            assert history_target != limits['model_provider'], 'Historical model routing must not alter the default client model menu'
            if not args.expect_history_deferred:
                history_fixture['assert_provider'](history_target)
            assert limits['model_context_window'] == 272000 and limits['model_auto_compact_token_limit'] == 244800
            def assert_legacy_provider_routes(configuration):
                providers = configuration.get('model_providers', {})
                for legacy_id in ['retired-provider', 'missing-region-0', 'missing-region-1', history_target]:
                    alias = providers[legacy_id]
                    route = urllib.parse.urlparse(alias['base_url'])
                    assert route.hostname == '127.0.0.1' and route.path.startswith('/codex-history/')
                    encoded = route.path.split('/')[2]
                    target = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode('utf-8')
                    assert target == supplier['id'] + '/gpt-6.1-sol', 'Historical provider must bind the selected supplier and model'
                    assert alias['requires_openai_auth'] is False and alias['experimental_bearer_token']
                assert 'openai' not in providers, 'Historical compatibility must not redefine the built-in official provider'
            assert_legacy_provider_routes(limits)
            assert (clients / '.codex/auth.json').read_bytes() == original[clients / '.codex/auth.json']
            shared = page.evaluate("async () => (await window.aurora.invoke('state.get')).agents")
            assert all(shared[client]['connected'] is True for client in ['codex-cli', 'chatgpt-desktop'])
            wizard.get_by_role('button', name='完成', exact=True).click()
            page.evaluate("id => window.aurora.invoke('provider.save', {id,models:[{id:'gpt-6.1-sol',contextWindow:200000}]})", supplier['id'])
            updated = page.evaluate("p => window.aurora.invoke('agent.preview', p)", selection)
            assert updated['ok'] and updated['revision'], updated
            if args.expect_history_deferred:
                assert updated['history']['status'] == 'deferred', updated
            else:
                assert_history_preview(updated, 0, 1)
            selection['revision'] = updated['revision']
            before_reapply = history_fixture['snapshot']()
            applied = page.evaluate("p => window.aurora.invoke('agent.connect', p)", selection)
            if args.expect_history_deferred:
                assert_deferred_history(applied)
            else:
                assert_history_result(applied, 0, 1)
                assert applied['history']['backupId'] != first_backup['id'], 'Reapply must create its own full history backup'
                history_fixture['assert_provider'](history_target)
                history_fixture['assert_backup'](applied['history']['backupPath'], before_reapply, 0)
            limits = tomllib.loads((clients / '.codex/config.toml').read_text(encoding='utf-8'))
            assert limits['model_context_window'] == 200000 and limits['model_auto_compact_token_limit'] == 180000
            assert_legacy_provider_routes(limits)
            assert (clients / '.codex/auth.json').read_bytes() == original[clients / '.codex/auth.json']
            checks.append('Native configuration apply and reapply write 272000/244800 then 200000/180000, preserve official auth and shared CLI state; history defers without writes for a running client or completes verified raw-file/database backups for an idle client')
            before_restore = history_fixture['snapshot']()
            restored = page.evaluate("() => window.aurora.invoke('agent.disconnect', {agentId:'chatgpt-desktop'})")
            if args.expect_history_deferred:
                assert_deferred_history(restored)
            else:
                assert_history_result(restored, 1, 0)
                assert restored['history']['backupId'] not in [first_backup['id'], applied['history']['backupId']]
                history_fixture['assert_provider']('openai')
                history_fixture['assert_backup'](restored['history']['backupPath'], before_restore, 1)
            assert all(file.read_bytes() == before for file, before in original.items()), 'Shared configuration restore changed original bytes'
            restored_states = page.evaluate("async () => (await window.aurora.invoke('state.get')).agents")
            assert all(restored_states[client]['connected'] is False for client in ['codex-cli', 'chatgpt-desktop'])
            assert not errors, errors
            checks.append('Native configuration-first wizard and IPC successfully apply, reapply and restore isolated client configuration without launching or stopping a client; history outcome remains independent and all skipped or deferred original history stays intact')
            report = {
                'version': args.version, 'platform': sys.platform, 'passed': True, 'count': len(checks), 'checks': checks,
                'configurationAcceptance': 'native-apply-restore',
                'legacyProviderAcceptance': 'missing-history-providers-bound-to-selected-route',
                'automaticHistoryProviderAcceptance': 'dedicated-bound-provider',
                'historyAcceptance': 'deferred-running-client' if args.expect_history_deferred else 'native-backup-repair-restore',
                'crossDatabaseHistoryAcceptance': 'preserved-while-deferred' if args.expect_history_deferred else 'native-apply-restore',
                'skippedHistoryAcceptance': 'preserved-while-deferred' if args.expect_history_deferred else 'native-apply-restore',
                'limitations': ['Native configuration apply, reapply and restore passed while a real client was running; history was deferred and its bytes stayed unchanged. Successful history backup and repair were not exercised in this mode.'] if args.expect_history_deferred else [],
                **({'historyDeferredCode': 'CLIENT_HISTORY_BUSY'} if args.expect_history_deferred else {}),
                'executable': str(executable.relative_to(ROOT)) if executable.is_relative_to(ROOT) else str(executable),
                'exeSha256': sha256(executable), 'asarSha256': sha256(asar),
                **({'portable': str(launcher.relative_to(ROOT)), 'portableSha256': sha256(launcher)} if args.launcher and launcher.is_relative_to(ROOT) else {}),
                'build': build,
                'resourceFilesVerified': len(manifest), 'profile': 'isolated temporary app, gateway and client directories',
                'membershipPublicConfigWarning': membership_warning,
                'screenshots': ['docs/images/settings-v0.6.png', 'docs/images/plugins-v0.6.png', 'docs/images/membership-v0.6.png'],
            }
            (ROOT / f'docs/PACKAGED-VALIDATION-{args.version}.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True), flush=True)
            browser.close()
    finally:
        if process and process.poll() is None:
            if args.launcher and os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        catalog.shutdown()
        catalog.server_close()
        logs.close()
        print(f'Isolated acceptance logs: {profile}', flush=True)


if __name__ == '__main__':
    main()
