"""Exercise history organization in Chromium using isolated native-format logs only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def bundle(source, output, platform, loader):
    options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': loader},
               'bundle': True, 'platform': platform, 'format': 'cjs' if platform == 'node' else 'iife',
               'outfile': str(output), 'logLevel': 'silent'}
    if platform == 'browser':
        options['define'] = {'process.env.NODE_ENV': '"production"'}
    subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)


def main():
    checks, errors = [], []
    with tempfile.TemporaryDirectory(prefix='yunhui-session-relations-ui-') as temporary:
        scratch = Path(temporary).resolve()
        clients = scratch / 'clients'
        originals = {}

        def write(relative, rows):
            file = clients / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in rows) + '\n', encoding='utf-8')
            originals[file] = (file.read_bytes(), file.stat().st_mtime_ns)

        def codex(uid, title, metadata=None, filename=None):
            write(f'.codex/sessions/{filename or uid}.jsonl', [
                {'type': 'session_meta', 'payload': {'id': uid, 'source': 'cli', 'model_provider': 'fixture', **(metadata or {})}},
                {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': title}},
            ])

        codex('root', '主任务 A')
        codex('child', '子任务 A1', {'source': {'subagent': {'thread_spawn': {'parent_thread_id': 'root', 'depth': 1}}}})
        codex('grandchild', '子任务 A2', {'parent_thread_id': 'child'})
        codex('orphan', '孤立子任务', {'parent_thread_id': 'missing-root'})
        codex('fork', '独立分支', {'forked_from_id': 'root'})
        codex('duplicate', '重复 ID 甲', filename='duplicate-a')
        codex('duplicate', '重复 ID 乙', filename='duplicate-b')
        codex('ambiguous', '父会话不唯一', {'parent_thread_id': 'duplicate'})
        claude_id = '10000000-0000-4000-8000-000000000001'
        write(f'.claude/projects/fixture/{claude_id}.jsonl', [{'type': 'user', 'sessionId': claude_id, 'message': {'role': 'user', 'content': 'Claude 主任务'}}])
        write(f'.claude/projects/fixture/{claude_id}/subagents/agent-a1.jsonl', [{'type': 'user', 'sessionId': claude_id, 'isSidechain': True, 'agentId': 'a1', 'message': {'role': 'user', 'content': 'Claude 子任务'}}])

        scan_file, ui_file = scratch / 'scan.cjs', scratch / 'ui.js'
        bundle("""import {scanSessions,readSession} from './src/core/sessions.ts';
const sessions=scanSessions();process.stdout.write(JSON.stringify({sessions,messages:Object.fromEntries(sessions.map(s=>[s.path,readSession(s.path)]))}));""", scan_file, 'node', 'ts')
        fixture = json.loads(subprocess.check_output(['node', str(scan_file)], cwd=ROOT, env=dict(os.environ, AURORA_CLIENT_HOME=str(clients)), text=True, encoding='utf-8'))
        assert len(fixture['sessions']) == 10
        bundle("""import React from 'react';import {createRoot} from 'react-dom/client';
import Sessions from './ui/src/pages/Sessions.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
createRoot(document.getElementById('root')).render(<ToastHost><Sessions state={{}} reload={async()=>{}} go={()=>{}}/></ToastHost>);""", ui_file, 'browser', 'tsx')

        def passed(name):
            checks.append(name)
            print('PASS', name, flush=True)

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1450, 'height': 1000}, locale='zh-CN')
            page.route('**/*', lambda route: route.abort())
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate("""data => {
window.historyFixture=data;window.originalSessions=data.sessions;window.pending=[];window.deferReads=false;
window.aurora={invoke:async(action,payload={})=>{
  if(action==='sessions.scan')return window.historyFixture.sessions;
  if(action==='sessions.read'){
    if(window.deferReads)return new Promise((resolve,reject)=>window.pending.push({path:payload.path,resolve,reject}));
    return window.historyFixture.messages[payload.path];
  }
  throw Error('Unexpected action '+action);
}};
}""", fixture)
            page.add_script_tag(path=str(ui_file))
            rows = page.locator('.split .list-row[role="button"]')
            kinds = page.get_by_role('group', name='会话类型', exact=True)
            search = page.get_by_label('搜索历史会话', exact=True)
            detail = page.locator('.split > .card').nth(1)

            def row(title):
                return rows.filter(has=page.get_by_text(title, exact=True))

            def show_all():
                search.fill('')
                page.get_by_role('button', name='全部 10', exact=True).click()
                kinds.get_by_role('button', name='全部会话').click()
                expect(rows).to_have_count(10)

            expect(rows).to_have_count(5)
            expect(kinds.get_by_role('button', name='主会话 5', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(page.get_by_text('已隐藏 5 个子代理会话', exact=False)).to_be_visible()
            expect(row('独立分支')).to_be_visible()
            kinds.get_by_role('button', name='子代理 5', exact=True).click()
            expect(rows).to_have_count(5)
            show_all()
            passed('Main view hides only verified child sessions; child/all views preserve every log and normal forks')

            row('子任务 A2').click()
            expect(detail.get_by_text('父会话 ID：child', exact=True)).to_be_visible()
            expect(detail.get_by_role('button', name='复制恢复命令')).to_be_disabled()
            detail.get_by_role('button', name='查看父会话', exact=True).click()
            expect(search).to_have_value('child')
            expect(row('子任务 A1')).to_be_visible()
            expect(detail.locator('.card-title')).to_contain_text('子任务 A1')
            detail.get_by_role('button', name='查看父会话', exact=True).click()
            expect(search).to_have_value('root')
            expect(detail.locator('.card-title')).to_contain_text('主任务 A')
            expect(detail.get_by_role('button', name='复制恢复命令')).to_be_enabled()
            passed('Nested Codex children navigate to the correct parent and then root without resuming the wrong session')

            show_all()
            row('Claude 子任务').click()
            expect(detail.get_by_text(f'所属主会话 ID：{claude_id}', exact=True)).to_be_visible()
            detail.get_by_role('button', name='查看所属主会话', exact=True).click()
            expect(detail.locator('.card-title')).to_contain_text('Claude 主任务')
            expect(rows).to_have_count(1)
            show_all()
            row('孤立子任务').click()
            expect(detail.get_by_text('本次扫描未找到对应会话', exact=False)).to_be_visible()
            expect(detail.get_by_role('button', name='查看父会话', exact=True)).to_have_count(0)
            row('父会话不唯一').click()
            expect(detail.get_by_text('找到多个同 ID 会话', exact=False)).to_be_visible()
            expect(detail.get_by_role('button', name='查看父会话', exact=True)).to_have_count(0)
            passed('Claude shared IDs resolve to the main transcript; missing or ambiguous parents stay readable without arbitrary links')

            search.fill('孤立子任务')
            kinds.get_by_role('button', name='主会话 0', exact=True).click()
            expect(rows).to_have_count(0)
            expect(page.get_by_text('当前筛选下只有子代理会话', exact=True)).to_be_visible()
            kinds.get_by_role('button', name='子代理 1', exact=True).click()
            expect(rows).to_have_count(1)
            passed('Search counts and empty states explain filtered children and allow immediate recovery')

            show_all()
            page.evaluate('window.deferReads=true;window.pending=[]')
            row('子任务 A1').click()
            row('子任务 A2').click()
            row('子任务 A1').click()
            page.wait_for_function('window.pending.length===3')
            page.evaluate("window.pending[2].resolve([{role:'assistant',text:'最新一次读取'}])")
            expect(detail.locator('.chat-msg')).to_contain_text('最新一次读取')
            page.evaluate("window.pending[0].reject(Error('旧请求错误不应出现'));window.pending[1].resolve([{role:'assistant',text:'过期内容'}])")
            expect(detail.locator('.chat-msg')).to_contain_text('最新一次读取')
            expect(page.get_by_text('旧请求错误不应出现', exact=False)).to_have_count(0)
            expect(detail.locator('.chat-msg').filter(has_text='过期内容')).to_have_count(0)
            passed('Out-of-order and repeated same-path reads cannot replace newer content or show stale errors')

            row('子任务 A2').click()
            page.wait_for_function('window.pending.length===4')
            page.evaluate("window.historyFixture.sessions=window.originalSessions.filter(s=>s.id!=='grandchild')")
            page.get_by_role('button', name='重新扫描', exact=True).click()
            expect(detail.get_by_text('选一个会话看内容', exact=True)).to_be_visible()
            page.evaluate("window.pending[3].resolve([{role:'assistant',text:'已消失会话的旧内容'}])")
            expect(detail.locator('.chat-msg').filter(has_text='已消失会话的旧内容')).to_have_count(0)
            passed('Rescan invalidates a pending read when its selected file is no longer present')

            assert not errors, errors
            browser.close()

        for file, (original, modified) in originals.items():
            assert file.read_bytes() == original
            assert file.stat().st_mtime_ns == modified
        passed('No native history bytes or modification times changed')
        print(json.dumps({'passed': len(checks), 'pageErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
