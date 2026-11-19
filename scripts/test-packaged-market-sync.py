"""Exercise real packaged plugin-market failure handling through a local rejecting proxy.

Requires a freshly packaged Windows EXE and Python Playwright. Runs only when an
explicit --exe is supplied; all application, client and Chromium data is isolated.
No IPC implementation is mocked and no desktop client is launched or connected.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('packaged_helpers', ROOT / 'scripts/test-packaged.py')
HELPERS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPERS)


class RejectingProxy(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(('127.0.0.1', 0), RejectingProxyHandler)
        self.release = threading.Event()
        self.lock = threading.Lock()
        self.status = 502
        self.phase = 'startup'
        self.targets = []

    def begin(self, phase, status=502, hold=False):
        with self.lock:
            self.phase, self.status = phase, status
        if hold:
            self.release.clear()
        else:
            self.release.set()

    def records(self, phase=None):
        with self.lock:
            return [record.copy() for record in self.targets if phase is None or record['phase'] == phase]


class RejectingProxyHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def reject(self, hostname):
        # Store only destination hostnames and synthetic status, never proxy headers.
        with self.server.lock:
            status = self.server.status
            self.server.targets.append({'hostname': hostname, 'method': self.command,
                                        'status': status, 'phase': self.server.phase})
        self.server.release.wait(timeout=20)
        self.send_response(status)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        if status == 407:
            self.send_header('Proxy-Authenticate', 'Basic realm="isolated-test"')
        self.end_headers()
        self.close_connection = True

    def do_CONNECT(self):
        self.reject(urllib.parse.urlsplit('//' + self.path).hostname or 'invalid-target')

    def do_GET(self):
        self.reject(urllib.parse.urlsplit(self.path).hostname or 'invalid-target')

    def do_POST(self):
        self.do_GET()


def relative(file):
    return str(file.relative_to(ROOT)).replace('\\', '/') if file.is_relative_to(ROOT) else str(file)


def wait_for_proxy(page, proxy, phase, minimum=1):
    deadline = time.monotonic() + 10
    while len(proxy.records(phase)) < minimum:
        assert time.monotonic() < deadline, f'No expected proxy traffic for {phase}'
        page.wait_for_timeout(40)


def own_process_cleanup(process):
    if process is None or process.poll() is not None:
        return
    # Kill only the tree rooted at the exact Popen PID; never match a process name.
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True, help='Fresh unpacked YunHuiAI.exe supplied by the build owner')
    parser.add_argument('--version', default='0.6.0')
    parser.add_argument('--live', action='store_true', help='After isolated failures, clear only the test proxy and verify real read-only GitHub synchronization')
    args = parser.parse_args()
    executable = args.exe.resolve()
    assert executable.is_file(), f'Packaged executable is missing: {executable}'
    resources = executable.parent / 'resources'
    asar = resources / 'app.asar'
    package = json.loads(HELPERS.read_asar(asar, 'package.json'))
    assert package['version'] == args.version, 'The supplied package has an unexpected version'
    built_main = ROOT / 'dist/main/main.cjs'
    assert built_main.is_file(), 'Build the source before packaged acceptance'
    packaged_main = HELPERS.read_asar(asar, 'dist/main/main.cjs')
    assert packaged_main == built_main.read_bytes(), 'The package does not contain the current main build'
    assert b'YUNHUI_TEST_ISOLATED' in packaged_main, 'Refusing to launch a package without the isolated-test login-item guard'
    assert HELPERS.read_asar(asar, 'dist/ui/index.html') == (ROOT / 'dist/ui/index.html').read_bytes(), 'The package does not contain the current UI build'
    resource_manifest = HELPERS.verify_packaged_resources(resources / 'codexplusplus')

    profile = Path(tempfile.mkdtemp(prefix='yunhui-packaged-market-'))
    data, clients, chromium = profile / 'data', profile / 'clients', profile / 'chromium'
    for folder in [data, clients / '.claude', clients / '.codex', chromium, profile / 'appdata', profile / 'localappdata']:
        folder.mkdir(parents=True, exist_ok=True)
    client_files = {
        clients / '.claude/settings.json': '{"permissions":{"allow":["Read"]},"env":{"FIXTURE":"unchanged"}}\n',
        clients / '.codex/config.toml': 'model = "fixture-model"\n',
    }
    for file, text in client_files.items():
        file.write_text(text, encoding='utf-8')
    original_clients = {file: file.read_bytes() for file in client_files}
    public_index = json.loads((resources / 'codexplusplus/catalog/public.json').read_text(encoding='utf-8'))
    full_index = json.loads((resources / 'codexplusplus/catalog/full.json').read_text(encoding='utf-8'))
    public_index['fetchedAt'] = '2026-11-14T10:00:00Z'
    public_cache = data / 'extension-catalog-public.json'
    public_cache.write_text(json.dumps(public_index, ensure_ascii=False), encoding='utf-8')
    original_cache = public_cache.read_bytes()
    expected_counts = {'public': len(public_index['plugins']), 'full': len(full_index['plugins'])}

    catalog = ThreadingHTTPServer(('127.0.0.1', 0), HELPERS.CatalogHandler)
    proxy = RejectingProxy()
    for server in [catalog, proxy]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    proxy_url = f'http://127.0.0.1:{proxy.server_port}'
    gateway_port, debug_port = HELPERS.free_port(), HELPERS.free_port()
    (data / 'settings.json').write_text(json.dumps({
        'theme': 'light', 'gatewayHost': '127.0.0.1', 'gatewayPort': gateway_port,
        'gatewayToken': 'isolated-market-test-token', 'autoStartGateway': False,
        'autoCheckUpdate': False, 'closeToTray': False, 'launchAtLogin': False,
        'proxy': proxy_url, 'catalogUrl': f'http://127.0.0.1:{catalog.server_port}/catalog',
    }), encoding='utf-8')
    keep = {'systemroot', 'windir', 'path', 'pathext', 'comspec', 'temp', 'tmp', 'programfiles',
            'programfiles(x86)', 'programdata', 'commonprogramfiles', 'commonprogramfiles(x86)',
            'processor_architecture', 'number_of_processors', 'os'}
    environment = {key: value for key, value in os.environ.items() if key.lower() in keep}
    environment.update(AURORA_HOME=str(data), YUNHUI_HOME=str(data), AURORA_CLIENT_HOME=str(clients), YUNHUI_TEST_ISOLATED='1',
                       USERPROFILE=str(clients), HOME=str(clients), CODEX_HOME=str(clients / '.codex'),
                       APPDATA=str(profile / 'appdata'), LOCALAPPDATA=str(profile / 'localappdata'),
                       HTTP_PROXY=proxy_url, HTTPS_PROXY=proxy_url, ALL_PROXY=proxy_url,
                       NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost')
    if args.live:
        # The explicit application setting still routes fault tests to the local
        # proxy; clearing it later must permit an actual direct Electron request.
        for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
            environment.pop(key, None)
    report_path = ROOT / 'docs/PLUGIN-SYNC-PACKAGED-VALIDATION.json'
    images = ROOT / 'docs/images'
    images.mkdir(exist_ok=True)
    screenshot = images / 'plugin-sync-offline-v0.6.png'
    retry_screenshot = images / 'plugin-sync-retry-v0.6.png'
    logs = (profile / 'packaged.log').open('w', encoding='utf-8')
    process, page = None, None
    checks, errors = [], []
    report = {'passed': False, 'version': args.version, 'executable': relative(executable),
              'exeSha256': HELPERS.sha256(executable), 'asarSha256': HELPERS.sha256(asar),
              'resourceFilesVerified': len(resource_manifest),
              'profile': 'isolated temporary application, client and Chromium directories',
              'isolatedTestFlag': True, 'liveRequested': args.live,
              'scope': 'Actual packaged renderer, IPC and market downloader; rejecting local CONNECT proxy; optional read-only GitHub synchronization; no real client connection or paid requests'}
    try:
        process = subprocess.Popen([str(executable), f'--remote-debugging-port={debug_port}', f'--user-data-dir={chromium}'],
                                   cwd=profile, env=environment, stdout=logs, stderr=logs,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        deadline = time.monotonic() + 35
        local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while time.monotonic() < deadline:
            assert process.poll() is None, f'Test executable exited; logs: {profile / "packaged.log"}'
            try:
                local_http.open(f'http://127.0.0.1:{debug_port}/json/version', timeout=.5).close()
                break
            except (OSError, urllib.error.URLError):
                time.sleep(.2)
        else:
            raise AssertionError(f'Test executable CDP startup timed out; logs: {profile / "packaged.log"}')
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}')
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event('page')
            page.set_default_timeout(15000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.get_by_role('heading', name='连接你的 AI 客户端.', exact=True).wait_for(timeout=30000)
            location = urllib.parse.unquote(page.url).replace('\\', '/').lower()
            assert '/resources/app.asar/dist/ui/index.html' in location, 'The test is not using packaged UI assets'
            runtime = page.evaluate("async()=>{const info=await window.aurora.invoke('app.isDev');const state=await window.aurora.invoke('state.get');return {dev:info.dev,root:info.root,version:state.version,dataDir:state.dataDir,providers:state.providers.length,build:state.build,proxy:state.settings.proxy,autoCheckUpdate:state.settings.autoCheckUpdate};}")
            assert runtime['dev'] is False and Path(runtime['root']).resolve() == asar.resolve()
            assert runtime['version'] == args.version and Path(runtime['dataDir']).resolve() == data.resolve()
            assert runtime['providers'] == 0 and runtime['proxy'] == proxy_url and runtime['autoCheckUpdate'] is False
            report['build'] = runtime.get('build')
            checks.append('The supplied packaged EXE runs its own ASAR in isolated application/client/Chromium profiles with updates disabled')
            page.locator('nav').get_by_role('button', name='插件中心', exact=True).click()
            page.get_by_role('heading', name='ChatGPT 桌面版插件', exact=True).wait_for()
            page.get_by_role('button', name=f"公开市场 {expected_counts['public']}", exact=True).wait_for()
            first_cards = page.locator('.extension-card h3').all_text_contents()
            assert first_cards, 'The packaged bundled/cache plugin list must be visible before synchronization'
            page.evaluate("""()=>{window.marketSyncOkToasts=[];new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node instanceof Element){if(node.matches('.toast.ok'))window.marketSyncOkToasts.push(node.textContent);for(const toast of node.querySelectorAll('.toast.ok'))window.marketSyncOkToasts.push(toast.textContent);}}).observe(document.querySelector('.toast-wrap'),{childList:true,subtree:true});}""")
            proxy.begin('all-markets-502', status=502, hold=True)
            page.get_by_role('button', name='同步市场索引', exact=True).evaluate('(button)=>{button.click();button.click();}')
            expect(page.get_by_role('button', name='同步中…', exact=True)).to_be_disabled()
            expect(page.get_by_role('button', name='刷新状态', exact=True)).to_be_disabled()
            wait_for_proxy(page, proxy, 'all-markets-502', minimum=2)
            proxy.release.set()
            notice = page.get_by_role('alert', name='市场同步状态', exact=True)
            expect(notice).to_contain_text('市场索引暂未更新', timeout=30000)
            expect(notice).to_contain_text(f"公开市场：使用本地缓存 · {expected_counts['public']} 项")
            expect(notice).to_contain_text(f"完整索引：使用随附离线索引 · {expected_counts['full']} 项")
            expect(notice).to_contain_text('缓存时间')
            expect(notice).to_contain_text('可继续浏览已有条目')
            expect(notice.get_by_role('button', name='重试同步', exact=True)).to_be_enabled()
            expect(page.get_by_role('button', name='重新检测', exact=True)).to_have_count(0)
            assert 'The operation was aborted' not in notice.inner_text()
            assert '重启' not in notice.inner_text()
            assert page.evaluate('window.marketSyncOkToasts') == [], 'An offline refresh must not display a success toast'
            assert page.locator('.extension-card h3').all_text_contents() == first_cards
            all_requests = proxy.records('all-markets-502')
            assert len(all_requests) == 4, 'One all-market operation should try raw/API once per market, even after a same-tick double click'
            assert {row['hostname'] for row in all_requests} == {'raw.githubusercontent.com', 'api.github.com'}
            checks.append('Real all-market refresh honors the configured proxy, rejects both GitHub routes, blocks duplicate clicks and preserves the list')
            checks.append('Chinese source-specific failure displays the dated local cache and bundled offline index with retry, no success toast or desktop-restart instruction')
            page.screenshot(path=str(screenshot), animations='disabled')

            page.get_by_role('button', name=f"完整索引 {expected_counts['full']}", exact=True).click()
            full_cards = page.locator('.extension-card h3').all_text_contents()
            proxy.begin('full-market-407', status=407)
            page.get_by_role('button', name='同步市场索引', exact=True).click()
            expect(notice).to_contain_text('完整索引 · 市场索引暂未更新', timeout=30000)
            expect(notice.get_by_role('button', name='重试同步', exact=True)).to_be_enabled()
            assert '公开市场：' not in notice.inner_text()
            assert page.locator('.extension-card h3').all_text_contents() == full_cards
            assert len(proxy.records('full-market-407')) == 2
            page.get_by_role('button', name=f"公开市场 {expected_counts['public']}", exact=True).click()
            public_cards = page.locator('.extension-card h3').all_text_contents()
            proxy.begin('retry-original-full-407', status=407, hold=True)
            notice.get_by_role('button', name='重试同步', exact=True).click()
            expect(page.get_by_role('status', name='市场同步状态', exact=True)).to_contain_text('正在同步完整索引')
            expect(page.get_by_role('button', name='同步中…', exact=True)).to_be_disabled()
            wait_for_proxy(page, proxy, 'retry-original-full-407')
            proxy.release.set()
            expect(notice).to_contain_text('完整索引 · 市场索引暂未更新', timeout=30000)
            expect(notice.get_by_role('button', name='重试同步', exact=True)).to_be_enabled()
            assert '公开市场：' not in notice.inner_text()
            assert len(proxy.records('retry-original-full-407')) == 2, 'Retry must contact one original market, not both markets'
            assert page.locator('.extension-card h3').all_text_contents() == public_cards
            assert page.evaluate('window.marketSyncOkToasts') == []
            page.screenshot(path=str(retry_screenshot), animations='disabled')
            checks.append('After selecting another tab, the real retry still targets the failed full market; HTTP 407 leaves the selected visible list intact')

            proxy.begin('ipc-contract-407', status=407)
            refresh_result = page.evaluate("async()=>await window.aurora.invoke('extension.refresh', {})")
            assert refresh_result['ok'] is False and refresh_result.get('warning')
            actual = {item['source']: item for item in refresh_result['results']}
            assert set(actual) == {'public', 'full'}
            for source, fallback in [('public', 'cache'), ('full', 'builtin')]:
                assert actual[source]['ok'] is False and actual[source]['sourceType'] == fallback
                assert actual[source]['count'] == expected_counts[source]
                assert actual[source]['message'] and 'The operation was aborted' not in actual[source]['message']
            assert actual['public']['fetchedAt'] == public_index['fetchedAt']
            assert public_cache.read_bytes() == original_cache, 'Offline attempts overwrote the valid cache'
            assert not (data / 'extension-catalog-full.json').exists(), 'Failed network access must not fabricate a downloaded cache'
            assert all(file.read_bytes() == before for file, before in original_clients.items())
            runtime_status = page.evaluate("async()=>{const s=await window.aurora.invoke('extension.list',{source:'bundled'});return {connected:s.runtime.connected,items:s.items.length};}")
            assert runtime_status['connected'] is False and runtime_status['items'] == 5
            assert all(record['hostname'] in {'raw.githubusercontent.com', 'api.github.com'} and record['method'] == 'CONNECT' for record in proxy.records())
            assert not errors, errors
            checks.append('Real IPC returns both structured fallback results; cached bytes, fixture client configuration and disconnected native runtime remain unchanged')
            if args.live:
                proxy.begin('live-direct')
                saved = page.evaluate("async()=>await window.aurora.invoke('settings.save',{proxy:''})")
                assert not isinstance(saved, dict) or not saved.get('error'), 'Could not clear the isolated application proxy'
                assert page.evaluate("async()=>(await window.aurora.invoke('state.get')).settings.proxy") == ''
                page.get_by_role('button', name='全部插件', exact=True).click()
                page.get_by_role('button', name='同步市场索引', exact=True).click()
                expect(page.get_by_role('button', name='同步市场索引', exact=True)).to_be_enabled(timeout=150000)
                success = page.get_by_role('status', name='市场同步状态', exact=True)
                expect(success).to_contain_text('市场索引已同步')
                expect(success).to_contain_text('公开市场：已更新远端索引')
                expect(success).to_contain_text('完整索引：已更新远端索引')
                assert page.evaluate('window.marketSyncOkToasts') == ['市场索引已同步']
                assert proxy.records('live-direct') == [], 'Clearing the explicit proxy must stop contacting the fault proxy'
                synced = {}
                for source in ['public', 'full']:
                    index = json.loads((data / f'extension-catalog-{source}.json').read_text(encoding='utf-8'))
                    assert index.get('fetchedAt') and index.get('remoteBlobSha') and index.get('cacheContentSha256')
                    synced[source] = {'count': len(index['plugins']), 'fetchedAt': index['fetchedAt'], 'revision': index['revision']}
                live_screenshot = images / 'plugin-sync-live-v0.6.png'
                page.screenshot(path=str(live_screenshot), animations='disabled')
                report['live'] = {'passed': True, 'sources': synced, 'screenshot': relative(live_screenshot)}
                checks.append('With only the isolated proxy setting cleared, the actual Electron application synchronizes both live GitHub markets and persists verified caches')
                assert all(file.read_bytes() == before for file, before in original_clients.items())
                assert not errors, errors
            report.update(passed=True, checks=checks, count=len(checks), refreshResult=refresh_result,
                          proxy={'mode': 'local CONNECT rejection only; no upstream forwarding', 'requests': proxy.records()},
                          browserErrors=errors, screenshots=[relative(screenshot), relative(retry_screenshot)])
            browser.close()
    except Exception as error:
        report.update(checks=checks, count=len(checks), failure=str(error), browserErrors=errors,
                      proxy={'mode': 'local CONNECT rejection only; no upstream forwarding', 'requests': proxy.records()})
        raise
    finally:
        proxy.release.set()
        own_process_cleanup(process)
        for server in [catalog, proxy]:
            server.shutdown()
            server.server_close()
        logs.close()
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(report, ensure_ascii=True), flush=True)
        print(f'Isolated package logs: {profile}', flush=True)


if __name__ == '__main__':
    main()
