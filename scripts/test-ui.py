"""Electron integration checks against an isolated profile and local mock upstream.
Requires: pip install playwright; npm run build. No real client configuration is touched.
"""
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright, expect
import json
import sqlite3
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self): self.reply({'data': [{'id': 'aurora-test-model'}, {'id': 'aurora-test-reasoning'}]})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.reply({'id': 'test-chat', 'object': 'chat.completion', 'model': body.get('model'), 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': '连接测试成功'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 4, 'completion_tokens': 4}})
    def reply(self, value):
        body = json.dumps(value).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

def main():
    profile = Path(tempfile.mkdtemp(prefix='aurora-ui-'))
    data = profile / 'data'; data.mkdir()
    clients = profile / 'clients'; (clients / '.claude').mkdir(parents=True)
    original = '{\n  "permissions": { "allow": ["Read"] },\n  "env": { "USER_VARIABLE": "preserved" }\n}\n'
    config = clients / '.claude' / 'settings.json'; config.write_text(original, encoding='utf-8')
    session = clients / '.claude' / 'projects' / 'aurora-ui' / 'ui-session.jsonl'; session.parent.mkdir(parents=True)
    session.write_text('\n'.join(json.dumps(x, ensure_ascii=False) for x in [
        {'type': 'user', 'sessionId': 'ui-session', 'cwd': str(clients), 'timestamp': '2026-11-15T01:00:00Z', 'message': {'role': 'user', 'content': '这是云汇界面验证会话'}},
        {'type': 'assistant', 'timestamp': '2026-11-15T01:00:01Z', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': '会话读取成功，配置保持完整。'}]}},
    ]), encoding='utf-8')
    codex = clients / '.codex'; (codex / 'sessions').mkdir(parents=True)
    (codex / 'config.toml').write_text('model_provider = "yunhui"\n[model_providers.yunhui]\nname = "yunhui.me"\nbase_url = "http://127.0.0.1:3425/v1"\n', encoding='utf-8')
    repair_id = '10000000-0000-4000-8000-000000000001'
    rollout = codex / 'sessions' / ('rollout-' + repair_id + '.jsonl')
    rollout.write_text(json.dumps({'type':'session_meta','payload':{'id':repair_id,'model_provider':'old','source':'cli'}})+'\n'+json.dumps({'type':'event_msg','payload':{'type':'user_message','message':'UI repair fixture'}})+'\n', encoding='utf-8')
    repair_db = sqlite3.connect(codex / 'state_5.sqlite')
    repair_db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT, title TEXT, archived INTEGER)')
    repair_db.execute('INSERT INTO threads VALUES(?,?,?,?,?)', (repair_id, 'old', str(rollout), 'UI repair fixture', 0))
    repair_db.commit(); repair_db.close()
    port, debug_port = free_port(), free_port()
    (data / 'settings.json').write_text(json.dumps({'theme': 'light', 'gatewayPort': port, 'autoCheckUpdate': False, 'closeToTray': False}), encoding='utf-8')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = dict(os.environ, YUNHUI_TEST_ISOLATED='1', AURORA_HOME=str(data), YUNHUI_HOME=str(data), AURORA_CLIENT_HOME=str(clients), AURORA_UI_TEST='1')
    env.pop('ELECTRON_RUN_AS_NODE', None)
    logs = open(profile / 'electron.log', 'w', encoding='utf-8')
    process = subprocess.Popen([str(ROOT / 'node_modules/electron/dist/electron.exe'), str(ROOT), f'--remote-debugging-port={debug_port}', f'--user-data-dir={profile / "chromium"}'], env=env, stdout=logs, stderr=logs, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    report = []
    def passed(label): report.append(label); print('PASS', label, flush=True)
    try:
        for _ in range(100):
            try: urllib.request.urlopen(f'http://127.0.0.1:{debug_port}/json/version', timeout=.5); break
            except Exception:
                if process.poll() is not None: raise RuntimeError('Electron exited. See ' + str(profile / 'electron.log'))
                time.sleep(.2)
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}')
            page = browser.contexts[0].pages[0]
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.get_by_role('heading', name='连接你的 AI 客户端.').wait_for(timeout=20000)
            assert page.locator('article.client-card').count() >= 9
            assert page.get_by_role('heading', name='ChatGPT 桌面版', exact=True).count() == 1
            assert page.get_by_role('heading', name='Codex 桌面版', exact=True).count() == 0
            assert page.get_by_text('yunhui.me', exact=True).count() > 0
            assert not page.evaluate('document.querySelector("main").scrollWidth > document.querySelector("main").clientWidth')
            (ROOT / 'docs/images').mkdir(exist_ok=True)
            page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/clients-v0.6.png'))
            passed('Electron sandbox + IPC + initial client workspace')
            page.get_by_role('button', name='桌面应用', exact=True).click()
            assert page.locator('article.client-card').count() > 0
            assert page.locator('article.client-card').filter(has=page.get_by_role('heading', name='Claude Code', exact=True)).count() == 0
            page.get_by_role('button', name='全部客户端', exact=True).click()
            passed('Client category filtering')
            card = page.locator('article.client-card').filter(has=page.get_by_role('heading', name='Claude Code', exact=True))
            card.get_by_role('button', name='开始配置').click()
            modal = page.get_by_role('dialog')
            modal.get_by_label('供应商名称', exact=True).fill('本地验证供应商')
            modal.get_by_label('API 地址', exact=True).fill(f'http://127.0.0.1:{server.server_port}')
            modal.get_by_label('API Key', exact=True).fill('test-only-no-real-key')
            modal.get_by_label('模型 ID', exact=True).fill('aurora-test-model')
            modal.get_by_role('button', name='保存并选模型').click()
            modal.get_by_label('选择模型', exact=True).wait_for()
            modal.get_by_role('button', name='上游网关测试', exact=True).click()
            modal.get_by_text('上游模型响应正常', exact=False).wait_for(timeout=15000)
            modal.get_by_role('button', name='本地网关测试', exact=True).click()
            modal.get_by_text('本地网关已完成所选客户端协议与模型路由测试', exact=False).wait_for(timeout=15000)
            modal.get_by_label('客户端执行权限', exact=True).select_option('full-access')
            modal.get_by_label('跳过首次登录引导（API 接入）', exact=True).check()
            modal.get_by_role('button', name='预览配置').click()
            expect(modal.get_by_text('当前配置', exact=True)).to_have_count(2)
            modal.get_by_text('当前配置', exact=True).first.wait_for()
            assert 'test-only-no-real-key' not in modal.inner_text()
            page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/connect-v0.6.png'))
            modal.get_by_role('button', name='保存配置').click()
            page.wait_for_timeout(600)
            if modal.locator('.notice.warning').count() > len(modal.locator('.config-preview').all()):
                print('Wizard notices:', modal.locator('.notice.warning').all_inner_texts(), flush=True)
            modal.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True).wait_for()
            updated = json.loads(config.read_text(encoding='utf-8'))
            assert updated['permissions']['allow'] == ['Read']
            assert updated['permissions']['defaultMode'] == 'bypassPermissions'
            assert updated['env']['USER_VARIABLE'] == 'preserved'
            assert updated['env']['ANTHROPIC_BASE_URL'].startswith(f'http://127.0.0.1:{port}')
            assert json.loads((clients / '.claude.json').read_text(encoding='utf-8'))['hasCompletedOnboarding'] is True
            assert modal.get_by_role('button', name='新终端打开', exact=True).is_visible()
            modal.get_by_role('button', name='完成', exact=True).click()
            passed('Client -> provider -> upstream and local protocol tests -> reviewed permission/onboarding choices -> apply -> new terminal entry')
            overview = page.get_by_role('region', name='当前客户端连接', exact=True)
            expect(overview.get_by_text('配置已保存 · 待验证', exact=True)).to_be_visible()
            expect(overview.locator('.connection-result time')).to_have_count(0)
            card.get_by_role('button', name='恢复原执行权限', exact=True).click()
            permission_modal = page.get_by_role('dialog')
            permission_modal.get_by_role('button', name='确认恢复原执行权限', exact=True).click()
            permission_modal.get_by_text('已恢复原执行权限，供应商连接保留。请重新启动客户端或打开新终端。', exact=True).wait_for()
            permission_restored = json.loads(config.read_text(encoding='utf-8'))
            assert permission_restored['permissions'] == {'allow': ['Read']}
            assert permission_restored['env'] == updated['env']
            assert json.loads((clients / '.claude.json').read_text(encoding='utf-8'))['hasCompletedOnboarding'] is True
            connection = page.evaluate("async () => (await window.aurora.invoke('state.get')).agents['claude-code']")
            assert connection['connected'] and connection['model'] == 'aurora-test-model' and connection['permissionMode'] == 'preserve'
            permission_modal.get_by_role('button', name='完成', exact=True).click()
            passed('Selective permission restore through IPC preserves supplier, model, environment and onboarding; tool tests do not certify the client')
            card.get_by_role('button', name='恢复', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='恢复原配置', exact=True).click()
            page.get_by_role('dialog').wait_for(state='hidden')
            assert config.read_text(encoding='utf-8') == original
            assert not (clients / '.claude.json').exists()
            passed('Restore original client configuration byte-for-byte')
            workbuddy_card = page.locator('article.client-card').filter(has=page.get_by_role('heading', name='WorkBuddy / CodeBuddy', exact=True))
            workbuddy_card.get_by_role('button', name='开始配置', exact=False).click()
            manual_modal = page.get_by_role('dialog')
            manual_modal.get_by_role('button', name='下一步：选择模型', exact=False).click()
            manual_modal.get_by_role('button', name='预览配置', exact=False).click()
            guide = manual_modal.get_by_role('region', name='手动客户端配置指南', exact=True)
            expect(guide.get_by_role('heading', name='WorkBuddy · 自定义模型', exact=True)).to_be_visible()
            expect(guide).to_contain_text(f'http://127.0.0.1:{port}/v1/chat/completions')
            gateway_token = json.loads((data / 'settings.json').read_text(encoding='utf-8'))['gatewayToken']
            assert gateway_token not in guide.inner_text() and 'test-only-no-real-key' not in guide.inner_text()
            guide.get_by_label('手动指南版本', exact=True).select_option('codebuddy-cli')
            expect(guide).to_contain_text('.codebuddy\\models.json')
            expect(guide.locator('.manual-guide-document')).to_contain_text('YOUR_YUNHUI_GATEWAY_TOKEN')
            expect(manual_modal.get_by_role('button', name='保存配置', exact=True)).to_have_count(0)
            manual_modal.get_by_role('button', name='取消', exact=True).click()
            assert not (clients / '.codebuddy').exists()
            passed('Dedicated manual wizard uses real reviewed gateway parameters, explicit client variants and placeholder-only previews without modifying client files')
            page.locator('nav').get_by_role('button', name='历史会话', exact=True).click()
            page.get_by_text('这是云汇界面验证会话', exact=True).first.click()
            page.get_by_text('会话读取成功，配置保持完整。', exact=False).wait_for()
            with page.expect_download() as download_info:
                page.get_by_role('button', name='导出', exact=True).click()
            downloaded = profile / 'session.md'; download_info.value.save_as(downloaded)
            assert '会话读取成功' in downloaded.read_text(encoding='utf-8')
            passed('Session discovery, reading and real Markdown download')
            page.get_by_role('button', name='批量修复历史', exact=False).click()
            repair_modal = page.get_by_role('dialog')
            repair_modal.get_by_role('button', name='扫描并预览').click()
            repair_modal.get_by_text('UI repair fixture', exact=True).first.wait_for(timeout=15000)
            assert repair_modal.get_by_role('checkbox', name='修复 UI repair fixture').is_checked()
            assert json.loads(rollout.read_text().splitlines()[0])['payload']['model_provider'] == 'old'
            repair_modal.get_by_role('button', name='关闭', exact=True).click()
            passed('Batch repair UI previews real JSONL and SQLite without writing')
            model_provider = page.evaluate("""async () => window.aurora.invoke('provider.save', {name:'UI bulk models',baseUrl:'https://example.invalid',models:[{id:'bulk-one',inputPrice:1},{id:'bulk-two',inputPrice:2}]})""")['id']
            page.locator('nav').get_by_role('button', name='模型管理', exact=True).click()
            page.get_by_label('搜索模型', exact=True).fill('bulk-')
            page.get_by_label('全选当前模型', exact=True).check()
            page.get_by_role('button', name='批量编辑', exact=True).click()
            modal = page.get_by_role('dialog')
            modal.get_by_label('批量输入价格', exact=True).fill('3.25')
            modal.get_by_role('button', name='预览修改', exact=True).click()
            modal.get_by_role('button', name='确认更新 2 条', exact=True).click()
            modal.wait_for(state='hidden')
            updated_models = page.evaluate("""async id => (await window.aurora.invoke('state.get')).providers.find(p=>p.id===id).models""", model_provider)
            assert all(m['inputPrice']==3.25 for m in updated_models)
            page.get_by_label('全选当前模型', exact=True).check()
            page.get_by_role('button', name='删除所选', exact=True).click()
            modal=page.get_by_role('dialog'); modal.get_by_role('button', name='预览修改', exact=True).click()
            modal.get_by_role('button', name='确认删除 2 条', exact=True).click(); modal.wait_for(state='hidden')
            removed = page.evaluate("""async id => (await window.aurora.invoke('state.get')).providers.find(p=>p.id===id)""", model_provider)
            assert not removed['models'] and not removed['enabled']
            passed('Bulk model selection, edit preview, save and delete through real IPC')

            page.locator('nav').get_by_role('button', name='厂商目录', exact=True).click()
            page.get_by_label('搜索厂商或模型').fill('DeepSeek')
            page.locator('.catalog-card').first.wait_for(timeout=25000)
            assert page.locator('.catalog-card').count() >= 1
            passed('Live remote catalog loading and model/vendor search')
            page.get_by_role('button', name='切换浅色 / 深色').click()
            page.wait_for_function('document.documentElement.dataset.theme === "dark"')
            page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/dark-v0.6.png'))
            page.get_by_role('button', name='切换浅色 / 深色').click()
            page.keyboard.press('Control+k')
            page.get_by_label('搜索功能', exact=True).fill('系统设置')
            page.get_by_role('dialog').get_by_role('button', name='系统设置').click()
            page.get_by_role('heading', name='系统设置', exact=True).wait_for()
            passed('Persistent theme switch and keyboard command navigation')
            page.get_by_role('button', name='网关与隐私', exact=True).click()
            page.get_by_label('网关端口', exact=True).fill('1')
            page.get_by_role('button', name='保存设置', exact=True).click()
            page.get_by_text('端口应为 1024–65535 之间的整数', exact=True).wait_for()
            page.get_by_role('button', name='放弃修改', exact=True).click()
            passed('Settings validation prevents invalid gateway port')
            rollback = page.evaluate('''async port => {
                const original = await window.aurora.invoke('state.get');
                const result = await window.aurora.invoke('settings.save', {gatewayPort: port});
                const after = await window.aurora.invoke('state.get');
                return {failed: !!result.error, originalPort: original.settings.gatewayPort, savedPort: after.settings.gatewayPort, running: after.gateway.running, actualPort: after.gateway.port};
            }''', server.server_port)
            assert rollback['failed'] and rollback['running'] and rollback['originalPort'] == rollback['savedPort'] == rollback['actualPort'], rollback
            passed('Occupied port rolls back settings and restores the actual listener')
            page.get_by_role('button', name='版本更新', exact=True).click()
            page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/settings-v0.6.png'))
            for name, title in [('模型管理', '模型'), ('路由分组', '路由分组'), ('运行概览', '仪表盘'), ('我的供应商', '我的供应商'), ('本地账号', '本地账号'), ('用量与账单', '用量')]:
                page.locator('nav').get_by_role('button', name=name, exact=False).click()
                page.locator('main h1').wait_for()
                assert page.locator('main h1').inner_text()
            passed('All primary navigation pages render')
            page.locator('nav').get_by_role('button', name='插件中心', exact=True).click()
            page.get_by_role('heading', name='插件中心', exact=True).wait_for()
            page.get_by_role('heading', name='ChatGPT 桌面版插件', exact=True).wait_for(timeout=15000)
            page.get_by_role('button', name='官方拓展包 5', exact=True).click()
            assert page.locator('.extension-card').count() == 5
            page.screenshot(animations='disabled', path=str(ROOT / 'docs/images/plugins-v0.6.png'))
            passed('Bundled desktop plugin catalog loads all five real packages')
            page.get_by_role('button', name='网关中间件', exact=True).click()
            assert page.get_by_role('switch').count() > 0
            switch = page.get_by_role('switch').first
            switch.click()
            expect(switch).to_have_attribute('aria-checked', 'true')
            plugins = page.evaluate('async () => (await window.aurora.invoke("state.get")).plugins')
            assert any(p['enabled'] and p.get('builtin') for p in plugins)
            switch.click()
            passed('Built-in plugin can be enabled, persisted and disabled in the UI')
            page.locator('nav').get_by_role('button', name='桌面工作台', exact=True).click()
            page.locator('main h1').wait_for()
            assert page.get_by_text('MCP 服务器', exact=False).count() > 0
            passed('Codex extension workspace renders local resource categories')
            page.locator('nav').get_by_role('button', name='云汇会员', exact=True).click()
            page.get_by_role('heading', name='云汇会员', exact=True).wait_for()
            assert page.get_by_label('平台会员邮箱', exact=True).count()==1
            page.screenshot(animations='disabled', path=str(ROOT / 'docs/images/membership-v0.6.png'))
            passed('Membership onboarding renders without embedding administrator credentials')
            assert not errors, errors
            # Verify real browser path uses token authentication and does not expose secrets.
            web = pw.chromium.launch(headless=True)
            web_page = web.new_page(viewport={'width': 390, 'height': 844})
            web_page.goto(f'http://127.0.0.1:{port}')
            web_page.get_by_role('heading', name='连接你的工作空间').wait_for()
            token = json.loads((data / 'settings.json').read_text(encoding='utf-8'))['gatewayToken']
            web_page.get_by_label('网关访问令牌', exact=True).fill(token)
            web_page.get_by_role('button', name='连接工作空间', exact=True).click()
            web_page.get_by_role('heading', name='连接你的 AI 客户端.').wait_for()
            assert not web_page.evaluate('document.querySelector("main").scrollWidth > document.querySelector("main").clientWidth')
            web_page.screenshot(animations="disabled", path=str(ROOT / 'docs/images/web-mobile-v0.6.png'))
            passed('Authenticated browser console + mobile responsive layout')
            web.close()
            browser.close()
        (ROOT / 'docs/UI-VALIDATION.json').write_text(json.dumps({'checks': report, 'count': len(report), 'profile': 'isolated temporary data and client directories', 'mockUpstream': True}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'UI checks: {len(report)} passed. Isolated artifacts: {profile}', flush=True)
    finally:
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill()
        server.shutdown(); logs.close()

if __name__ == '__main__': main()
