"""Real Electron acceptance of local discovery and official/API coexistence.

Run after npm run build. Every app, Chromium and client path is isolated.
"""
import base64
import argparse
import hashlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def token():
    claims = json.dumps({'exp': int(time.time()) + 3600}).encode()
    return 'fixture.' + base64.urlsafe_b64encode(claims).decode().rstrip('=') + '.fixture'


def configuration(key='fixture-source-key-one', model='relay-model-one'):
    # The native account remains selected. Inactive named providers are also discoverable.
    return f'''# Preserve official login, permissions and MCP
model_provider = "openai"
model = "gpt-fixture"
approval_policy = "on-request"

[model_providers.relay]
name = "国内中转"
base_url = "https://relay.example.test/v1"
wire_api = "responses"
experimental_bearer_token = "{key}"
[model_providers.relay_backup]
name = "备用线路"
base_url = "https://relay.example.test/v1"
wire_api = "responses"
experimental_bearer_token = "{key}"
[profiles.work]
model_provider = "relay"
model = "{model}"
[profiles.backup]
model_provider = "relay_backup"
model = "{model}"
[mcp_servers.keep]
command = "fixture"
args = ["--preserve"]
'''


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
    parser.add_argument('--exe', type=Path, help='Use the actual packaged local debug EXE')
    args = parser.parse_args()
    executable = args.exe.resolve() if args.exe else ROOT / 'node_modules/electron/dist/electron.exe'
    assert executable.is_file() and (ROOT / 'dist/main/main.cjs').is_file(), 'Run npm run build first'
    profile = Path(tempfile.mkdtemp(prefix='yunhui-coexist-ui-')).resolve()
    data, clients, chromium = profile / 'data', profile / 'clients', profile / 'chromium'
    for folder in [data, clients / '.codex', clients / '.claude', chromium, profile / 'appdata', profile / 'localappdata']:
        folder.mkdir(parents=True, exist_ok=True)
    auth_file, config_file = clients / '.codex/auth.json', clients / '.codex/config.toml'
    auth_file.write_text(json.dumps({'auth_mode': 'chatgpt', 'tokens': {'access_token': token(), 'refresh_token': 'fixture-refresh-never-import', 'account_id': 'fixture-account'}}), encoding='utf-8')
    (clients / '.codex/models_cache.json').write_text(json.dumps({'models': [{'slug': 'gpt-fixture', 'display_name': 'GPT 官方模型', 'visibility': 'list', 'context_window': 128000, 'base_instructions': 'Fixture native instructions'}]}), encoding='utf-8')
    (clients / '.claude/.credentials.json').write_text(json.dumps({'claudeAiOauth': {'accessToken': 'fixture-expired-claude', 'refreshToken': 'fixture-claude-refresh', 'expiresAt': int(time.time() * 1000) - 60000}}), encoding='utf-8')
    config_file.write_text(configuration(), encoding='utf-8', newline='\n')
    original_config, original_auth = config_file.read_bytes(), auth_file.read_bytes()
    catalog = ThreadingHTTPServer(('127.0.0.1', 0), CatalogHandler)
    threading.Thread(target=catalog.serve_forever, daemon=True).start()
    gateway_port, debug_port = free_port(), free_port()
    (data / 'settings.json').write_text(json.dumps({'theme': 'light', 'gatewayHost': '127.0.0.1', 'gatewayPort': gateway_port, 'gatewayToken': 'fixture-local-gateway-token',
        'autoStartGateway': True, 'autoCheckUpdate': False, 'autoSyncModels': False, 'closeToTray': False, 'launchAtLogin': False,
        'catalogUrl': f'http://127.0.0.1:{catalog.server_port}/catalog'}), encoding='utf-8')
    environment = dict(os.environ, YUNHUI_TEST_ISOLATED='1', AURORA_HOME=str(data), YUNHUI_HOME=str(data), AURORA_CLIENT_HOME=str(clients),
                       APPDATA=str(profile / 'appdata'), LOCALAPPDATA=str(profile / 'localappdata'), AURORA_UI_TEST='1')
    for key in ['ELECTRON_RUN_AS_NODE', 'AURORA_EXTENSION_ASSETS', 'AURORA_DEV', 'AURORA_UI_URL', 'AURORA_SHOT', 'AURORA_PAGE']:
        environment.pop(key, None)
    logs = (profile / 'electron.log').open('w', encoding='utf-8')
    process, browser = None, None
    checks, errors = [], []
    try:
        process = subprocess.Popen([str(executable), *([] if args.exe else [str(ROOT)]), f'--remote-debugging-port={debug_port}', f'--user-data-dir={chromium}'],
                                   cwd=ROOT, env=environment, stdout=logs, stderr=logs, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            assert process.poll() is None, f'Electron exited; see {profile / "electron.log"}'
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{debug_port}/json/version', timeout=.5).close()
                break
            except (OSError, urllib.error.URLError):
                time.sleep(.2)
        else:
            raise AssertionError(f'Electron startup timed out; see {profile / "electron.log"}')
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}')
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event('page')
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.get_by_role('heading', name='连接你的 AI 客户端.', exact=True).wait_for(timeout=30000)

            def rpc(action, payload=None):
                result = page.evaluate('([action,payload])=>window.aurora.invoke(action,payload)', [action, payload or {}])
                assert not (isinstance(result, dict) and result.get('error')), result.get('error')
                return result

            def state():
                return rpc('state.get')

            def go(label):
                page.locator('nav').get_by_role('button', name=label, exact=True).click()

            def source_scan():
                button = page.get_by_role('button', name='重新扫描本机', exact=True)
                button.click()
                expect(button).to_be_enabled()
                return state()

            def open_wizard():
                go('客户端接入')
                card = page.locator('.client-card').filter(has=page.get_by_role('heading', name='Codex CLI', exact=True))
                card.get_by_role('button', name='开始配置 →', exact=True).click() if card.get_by_role('button', name='开始配置 →', exact=True).count() else card.get_by_role('button', name='更换配置 →', exact=True).click()
                return page.get_by_role('dialog', name='配置 Codex CLI', exact=True)

            def apply_selected(dialog, provider_name, model):
                dialog.locator('.provider-choice').filter(has=page.get_by_text(provider_name, exact=True)).click()
                checkbox = dialog.get_by_label('保留官方账号并与第三方模型共存', exact=True)
                expect(checkbox).to_be_checked()
                if checkbox.is_enabled():
                    checkbox.uncheck()
                    expect(checkbox).not_to_be_checked()
                    checkbox.check()
                    expect(checkbox).to_be_checked()
                dialog.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
                dialog.get_by_label('选择模型', exact=True).select_option(model)
                before = config_file.read_bytes()
                dialog.get_by_role('button', name='预览配置 →', exact=True).click()
                file_preview = dialog.locator('.config-preview:has(> .preview-columns)')
                expect(file_preview).to_have_count(1)
                assert config_file.read_bytes() == before
                preview = file_preview.inner_text()
                for secret in ['fixture-source-key-one', 'fixture-local-gateway-token', 'fixture-refresh-never-import']:
                    assert secret not in preview
                dialog.get_by_role('button', name='保存配置', exact=True).click()
                expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
                assert auth_file.read_bytes() == original_auth
                dialog.get_by_role('button', name='完成', exact=True).click()

            def restore():
                go('客户端接入')
                card = page.locator('.client-card').filter(has=page.get_by_role('heading', name='Codex CLI', exact=True))
                card.get_by_role('button', name='恢复', exact=True).click()
                dialog = page.get_by_role('dialog', name='恢复 Codex CLI 的原配置', exact=True)
                dialog.get_by_role('button', name='恢复原配置', exact=True).click()
                expect(dialog).not_to_be_visible()

            deadline = time.monotonic() + 15
            while not rpc('gateway.status')['running']:
                assert time.monotonic() < deadline, 'Isolated gateway startup timed out'
                page.wait_for_timeout(200)
            initial = state()
            assert Path(initial['dataDir']).resolve() == data
            assert len(initial['providers']) == 1 and len(initial['localClients']['sources']) == 2
            supplier = initial['providers'][0]
            assert supplier['apiKeys'][0]['key'] == 'fixture-source-key-one'
            assert all(source['providerId'] == supplier['id'] for source in initial['localClients']['sources'])
            assert initial['codexCoexist']['identity']['available'] and initial['codexCoexist']['officialModelCount'] == 1
            assert config_file.read_bytes() == original_config and auth_file.read_bytes() == original_auth
            checks.append('Real Electron startup imports two matching native sources into one supplier without modifying native files')

            go('我的供应商')
            expect(page.locator('.provider-card')).to_have_count(1)
            expect(page.locator('.local-identity-card')).to_have_count(2)
            expect(page.locator('.provider-origin')).to_contain_text('国内中转')
            expect(page.locator('.provider-origin')).to_contain_text('备用线路')
            expect(page.get_by_text('已检测到凭据', exact=True)).to_be_visible()
            expect(page.get_by_text('凭据已过期', exact=True)).to_be_visible()
            assert 'fixture-source-key-one' not in page.inner_text('body')
            checks.append('Supplier page separates official identities, credential status and both API configuration sources')
            go('本地账号')
            expect(page.get_by_role('heading', name='本地账号', exact=True)).to_be_visible()
            expect(page.get_by_text('已检测到凭据', exact=True)).to_be_visible()
            expect(page.get_by_text('凭据已过期', exact=True)).to_be_visible()
            expect(page.get_by_text('未发现登录记录', exact=True)).to_have_count(2)
            checks.append('Accounts page distinguishes detected, expired and missing credentials without claiming subscription validity')

            dialog = open_wizard()
            expect(dialog.get_by_label('保留官方账号并与第三方模型共存', exact=True)).to_be_checked()
            expect(dialog.locator('.provider-choice')).to_have_count(2)
            expect(page.locator('.toast-wrap > *')).to_have_count(0, timeout=10000)
            images = ROOT / 'docs/images'
            images.mkdir(exist_ok=True)
            page.screenshot(path=str(images / 'coexist-v0.6.png'), animations='disabled')
            apply_selected(dialog, 'ChatGPT 官方账号', 'gpt-fixture')
            connected = state()
            parsed = tomllib.loads(config_file.read_text(encoding='utf-8'))
            assert parsed['model_provider'] == 'openai' and parsed['model'] == 'official/gpt-fixture'
            assert parsed['openai_base_url'] == f'http://127.0.0.1:{gateway_port}/codex-coexist/v1'
            assert parsed['approval_policy'] == 'on-request' and parsed['mcp_servers']['keep']['args'] == ['--preserve']
            assert all(connected['agents'][key]['connected'] and connected['agents'][key]['authMode'] == 'coexist' for key in ['codex-cli', 'chatgpt-desktop', 'codex-desktop'])
            native_catalog = json.loads((data / 'codex-model-catalog.json').read_text(encoding='utf-8'))
            assert [model['slug'] for model in native_catalog['models']] == ['official/gpt-fixture', supplier['id'] + '/relay-model-one']
            checks.append('Official wizard applies dedicated loopback routing, synchronizes CLI/desktop state and preserves OAuth, permissions and MCP')

            dialog = open_wizard()
            apply_selected(dialog, supplier['name'], 'relay-model-one')
            assert tomllib.loads(config_file.read_text(encoding='utf-8'))['model'] == supplier['id'] + '/relay-model-one'
            assert auth_file.read_bytes() == original_auth
            checks.append('Same wizard switches from official account to API supplier with redacted preview and unchanged native authentication')
            restore()
            assert config_file.read_bytes() == original_config and auth_file.read_bytes() == original_auth
            assert all(not state()['agents'][key]['connected'] for key in ['codex-cli', 'chatgpt-desktop', 'codex-desktop'])
            checks.append('UI restore returns the exact original configuration across repeated choices and disconnects both entry points')

            config_file.write_text(configuration('fixture-source-key-two', 'relay-model-two'), encoding='utf-8', newline='\n')
            go('我的供应商')
            # Do not invoke localClients.scan: the running main process must discover this change itself.
            # wait_for_function polls a synchronous predicate; an async Promise can be truthy
            # before its boolean result resolves. Await each IPC call explicitly in Python.
            deadline = time.monotonic() + 45
            while True:
                refreshed = state()
                updated = next((item for item in refreshed['providers'] if item['id'] == supplier['id']), None)
                if updated and updated['apiKeys'][0]['key'] == 'fixture-source-key-two' and any(model['id'] == 'relay-model-two' for model in updated['models']):
                    break
                assert time.monotonic() < deadline, 'Background scanning did not import the changed source key and model within 45 seconds'
                page.wait_for_timeout(1000)
            updated = next(item for item in refreshed['providers'] if item['id'] == supplier['id'])
            assert len(refreshed['providers']) == 1 and updated['apiKeys'][0]['key'] == 'fixture-source-key-two'
            assert set(model['id'] for model in updated['models']) == {'relay-model-one', 'relay-model-two'}
            expect(page.locator('.provider-card')).to_contain_text('2 个模型')
            checks.append('The running application automatically discovers source rotation and new models without clicking rescan')

            rpc('provider.save', {'id': supplier['id'], 'name': '用户手工维护的供应商'})
            config_file.write_text(configuration('fixture-source-key-three', 'relay-model-three'), encoding='utf-8', newline='\n')
            preserved = source_scan()
            manual = next(item for item in preserved['providers'] if item['id'] == supplier['id'])
            assert manual['name'] == '用户手工维护的供应商' and manual['apiKeys'][0]['key'] == 'fixture-source-key-two'
            assert 'relay-model-three' not in [model['id'] for model in manual['models']]
            assert any(item['status'] == 'modified' for item in preserved['localClients']['sources'])
            checks.append('Explicit rescan retains user changes instead of replacing them with subsequently changed source files')
            rpc('provider.delete', {'id': supplier['id']})
            deleted = source_scan()
            assert not deleted['providers']
            expect(page.locator('.provider-card')).to_have_count(0)
            assert all(item['status'] == 'ignored' and item.get('canRestore') for item in deleted['localClients']['sources'])
            checks.append('Deleted imported providers stay deleted during subsequent forced scans')

            empty = rpc('provider.save', {'name': '手填模型服务', 'baseUrl': 'https://manual.example.test/v1', 'format': 'openai-responses', 'enabled': True,
                'models': [], 'apiKeys': [{'id': 'manual-fixture', 'label': 'fixture', 'key': 'fixture-manual-api-key', 'enabled': True, 'weight': 1}]})
            source_scan()
            before_manual = config_file.read_bytes()
            dialog = open_wizard()
            dialog.locator('.provider-choice').filter(has=page.get_by_text('手填模型服务', exact=True)).click()
            dialog.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
            dialog.get_by_label('手动模型 ID', exact=True).fill('manual-model-valid')
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.locator('.config-preview:has(> .preview-columns)')).to_have_count(1)
            assert config_file.read_bytes() == before_manual
            saved = next(item for item in state()['providers'] if item['id'] == empty['id'])
            assert [model['id'] for model in saved['models']] == ['manual-model-valid']
            assert 'fixture-manual-api-key' not in dialog.inner_text()
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            dialog.get_by_role('button', name='完成', exact=True).click()
            assert tomllib.loads(config_file.read_text(encoding='utf-8'))['model'] == empty['id'] + '/manual-model-valid'
            restore()
            assert config_file.read_bytes() == before_manual and auth_file.read_bytes() == original_auth
            checks.append('An empty supplier accepts a manually typed model ID, persists it before preview, applies and restores successfully')
            assert not errors, errors
            checks.append('No renderer exceptions, real client profile writes or OAuth mutations')
            report = {'version': '0.6.0', 'passed': True, 'count': len(checks), 'checkedAt': datetime.now(timezone.utc).isoformat(), 'checks': checks,
                'runtime': 'packaged Windows EXE' if args.exe else 'actual local Electron with built UI and main process',
                'executable': str(executable), 'exeSha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
                'asarSha256': hashlib.sha256((executable.parent / 'resources/app.asar').read_bytes()).hexdigest() if args.exe else None,
                'profile': 'isolated temporary app, Chromium and native client directories',
                'screenshots': ['docs/images/coexist-v0.6.png'], 'scope': 'local validation only; no real provider requests or publication'}
            (ROOT / 'docs/COEXIST-UI-VALIDATION-0.6.0.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True), flush=True)
            browser.close()
            browser = None
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        catalog.shutdown()
        catalog.server_close()
        logs.close()
        print(f'Isolated Electron logs: {profile}', flush=True)


if __name__ == '__main__':
    main()
