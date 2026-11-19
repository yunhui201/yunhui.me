"""Local diagnosis UI with mocked IPC; no real configs, processes or network."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory(prefix='yunhui-diagnostics-ui-') as temporary:
    bundle = Path(temporary) / 'ui.js'
    source = """import React from 'react';import {createRoot} from 'react-dom/client';
import ClientDiagnostics from './ui/src/components/ClientDiagnostics.tsx';import {Modal,ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.render=()=>root.render(<ToastHost>{window.visible && (window.nested ? <Modal title="配置已应用" onClose={()=>{window.outerClosed++;window.visible=false;window.render();}}><ClientDiagnostics agent={window.agent}/></Modal> : <ClientDiagnostics agent={window.agent}/>)}</ToastHost>);"""
    options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
    subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1200, 'height': 900})
        page.route('**/*', lambda route: route.abort())
        errors, checks = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_default_timeout(5000)
        page.set_content('<html data-theme="light"><div id="root"></div></html>')
        for style in ['app.css', 'workspace.css']:
            page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
        page.add_style_tag(path=str(bundle.with_suffix('.css')))
        page.evaluate("""()=>{
          window.visible=true;window.agent={id:'claude-code',name:'Claude Code',category:'cli'};
          window.calls=[];window.pending=[];window.hold=false;window.fail=false;window.copied='';
          Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copied=text},configurable:true});
          window.fixture=()=>({ok:true,agentId:window.agent.id,checkedAt:new Date().toISOString(),checks:[
            {id:'gateway',status:'error',title:'本地网关',detail:'网关未运行，请在系统设置中启动网关，然后重试。'},
            {id:'runtime',status:'info',title:'运行与上游验证',detail:'只检查本机配置，不发送模型请求。'}],report:'SAFE DIAGNOSTIC REPORT'});
          window.aurora={invoke:async(action,payload)=>{window.calls.push({action,payload});
            if(action!=='agent.diagnose')throw Error('Unexpected mutation');
            if(window.hold)return new Promise((resolve,reject)=>window.pending.push({resolve,reject}));
            if(window.fail)throw Error('SECRET-RAW-IPC-FAULT');return window.fixture();}};
        }""")
        page.add_script_tag(path=str(bundle))
        page.evaluate('window.render()')
        trigger = page.get_by_role('button', name='连接诊断', exact=True)
        dialog = page.get_by_role('dialog')
        expect(trigger).to_be_visible()
        assert page.evaluate('window.calls.length') == 0
        trigger.click()
        expect(dialog).to_contain_text('1 项需要检查')
        expect(dialog.locator('[data-check-id="gateway"]')).to_contain_text('待处理')
        assert page.evaluate('window.calls') == [{'action': 'agent.diagnose', 'payload': {'agentId': 'claude-code'}}]
        dialog.get_by_role('button', name='复制诊断报告').click()
        expect(page.locator('.toast')).to_contain_text('诊断报告已复制')
        assert page.evaluate('window.copied') == 'SAFE DIAGNOSTIC REPORT'
        checks.append('Explicit local-only diagnosis and safe report copy; exact client ID payload')

        page.evaluate('window.hold=true')
        dialog.get_by_role('button', name='重新检查').click()
        expect(dialog.get_by_role('button', name='正在诊断…')).to_be_disabled()
        expect(dialog.get_by_role('button', name='复制诊断报告')).to_have_count(0)
        expect(trigger).to_be_disabled()
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        page.evaluate('window.pending.shift().resolve(window.fixture())')
        expect(dialog).to_have_count(0)
        checks.append('Duplicate actions blocked and closing invalidates in-flight results')

        trigger.click()
        page.evaluate("window.agent={id:'codex-cli',name:'Codex CLI',category:'cli'};window.render()")
        expect(dialog).to_have_count(0)
        page.evaluate('window.pending.shift().resolve(window.fixture())')
        expect(dialog).to_have_count(0)
        page.evaluate('window.hold=false;window.fail=true')
        trigger.click()
        expect(dialog.get_by_role('alert')).to_contain_text('本机诊断未完成')
        assert 'SECRET-RAW-IPC-FAULT' not in dialog.inner_text()
        page.evaluate('window.fail=false')
        dialog.get_by_role('button', name='重新检查').click()
        expect(dialog).to_contain_text('本地网关')
        checks.append('Client changes reject stale responses; failed requests sanitize errors and allow retry')

        for theme in ['dark', 'light']:
            page.evaluate('(theme)=>document.documentElement.dataset.theme=theme', theme)
            page.set_viewport_size({'width': 390, 'height': 844})
            expect(dialog.get_by_role('button', name='复制诊断报告')).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        checks.append('Diagnosis and actions remain usable in narrow light/dark layouts')
        dialog.get_by_role('button', name='关闭', exact=True).click()
        page.evaluate('window.nested=true;window.outerClosed=0;window.render()')
        trigger.click()
        nested_dialog = page.get_by_role('dialog', name='Codex CLI · 连接诊断', exact=True)
        expect(nested_dialog).to_be_visible()
        page.keyboard.press('Escape')
        expect(nested_dialog).to_have_count(0)
        expect(page.get_by_role('dialog', name='配置已应用', exact=True)).to_be_visible()
        assert page.evaluate('window.outerClosed') == 0
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        assert page.evaluate('window.outerClosed') == 1
        checks.append('Escape closes only the top diagnosis dialog and preserves the completed configuration wizard')
        page.evaluate('window.nested=false;window.visible=true')
        page.evaluate('window.aurora=null;window.render()')
        expect(trigger).to_have_count(0)
        page.evaluate("window.aurora={};window.agent={id:'deepseek',name:'DeepSeek',category:'service'};window.render()")
        expect(trigger).to_have_count(0)
        checks.append('Remote browsers and model services do not expose local client diagnostics')
        assert not errors, errors
        browser.close()
        print(json.dumps({'ok': True, 'checks': checks}, ensure_ascii=False, indent=2))
