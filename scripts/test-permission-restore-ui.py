"""Selective permission recovery UI; mocked IPC only, no client or filesystem mutation."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='yunhui-permission-ui-') as temporary:
    bundle = Path(temporary) / 'ui.js'
    source = """import React from 'react';import {createRoot} from 'react-dom/client';
import ClientPermissions from './ui/src/components/ClientPermissions.tsx';
const root=createRoot(document.getElementById('root'));
window.render=()=>root.render(window.visible ? <ClientPermissions agent={window.agent} onRestored={async()=>{window.restored++}} onActiveChange={active=>window.active=active}/> : null);"""
    options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
    subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 900})
        page.route('**/*', lambda route: route.abort())
        page.set_default_timeout(4000)
        errors, checks = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content('<html data-theme="light"><div id="root"></div></html>')
        for style in ['app.css', 'workspace.css']:
            page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
        page.evaluate("""()=>{
          window.agent={id:'codex-cli',name:'Codex CLI',category:'cli'};window.visible=true;
          window.calls=[];window.pending=[];window.hold='';window.fail='';window.active=false;window.restored=0;window.already=false;
          window.fixture=id=>({ok:true,agentId:id,revision:'a'.repeat(64),alreadyOriginal:window.already,message:'仅恢复原执行权限，保留供应商连接。',changes:[{scope:'用户配置',field:'approval_policy',before:'never',after:window.already?'never':'on-request'}],warnings:['恢复后请重新启动客户端。',...(window.already?['原本已经开启高权限。']:[])]});
          window.mock={invoke:async(action,payload)=>{window.calls.push({action,payload:structuredClone(payload)});
            if(!['agent.permissions.preview','agent.permissions.restore'].includes(action))throw Error('Unexpected action');
            if(window.hold===action)return new Promise((resolve,reject)=>window.pending.push({resolve,reject,agentId:payload.agentId}));
            if(window.fail===action)return {ok:false,message:'配置已变化，请重新预览'};
            return action.endsWith('preview')?window.fixture(payload.agentId):{ok:true,agentId:payload.agentId,restartRequired:true,message:'已恢复原执行权限，供应商连接保留。请重新启动客户端。'};
          }};window.aurora=window.mock;
        }""")
        page.add_script_tag(path=str(bundle))
        page.evaluate('window.render()')
        trigger = page.get_by_role('button', name='恢复原执行权限', exact=True)
        dialog = page.get_by_role('dialog')
        def calls(action):
            return page.evaluate('(action)=>window.calls.filter(c=>c.action===action)', action)
        def reset():
            page.evaluate("window.visible=false;window.render()")
            expect(trigger).to_have_count(0)
            page.evaluate("window.calls=[];window.pending=[];window.hold='';window.fail='';window.already=false;window.restored=0;window.agent={id:'codex-cli',name:'Codex CLI',category:'cli'};window.aurora=window.mock;window.visible=true;window.render()")
            expect(trigger).to_be_visible()

        trigger.click()
        expect(dialog).to_contain_text('on-request')
        assert calls('agent.permissions.preview') == [{'action': 'agent.permissions.preview', 'payload': {'agentId': 'codex-cli'}}]
        assert not calls('agent.permissions.restore')
        dialog.get_by_role('button', name='取消', exact=True).click()
        expect(dialog).to_have_count(0)
        assert not calls('agent.permissions.restore')
        checks.append('Opening and canceling preview does not restore permissions')

        reset()
        trigger.click()
        page.evaluate("window.hold='agent.permissions.restore'")
        dialog.get_by_role('button', name='确认恢复原执行权限', exact=True).click()
        expect(dialog.get_by_role('button', name='正在恢复…', exact=True)).to_be_disabled()
        expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_disabled()
        page.keyboard.press('Escape')
        expect(dialog).to_be_visible()
        assert page.evaluate('window.active')
        assert calls('agent.permissions.restore') == [{'action': 'agent.permissions.restore', 'payload': {'agentId': 'codex-cli', 'revision': 'a' * 64, 'confirmed': True}}]
        page.evaluate("window.pending.shift().resolve({ok:true,agentId:'codex-cli',restartRequired:true,message:'已恢复原执行权限，供应商连接保留。请重新启动客户端。'})")
        expect(dialog.get_by_role('status')).to_contain_text('供应商连接保留')
        assert page.evaluate('window.restored') == 1
        dialog.get_by_role('button', name='完成', exact=True).click()
        expect(dialog).to_have_count(0)
        assert not page.evaluate('window.active')
        checks.append('Explicit confirmation binds the reviewed revision, blocks repeat submit and close, and refreshes after success')

        reset()
        trigger.click()
        page.evaluate("window.fail='agent.permissions.restore'")
        dialog.get_by_role('button', name='确认恢复原执行权限', exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('重新预览')
        expect(dialog.get_by_role('button', name='确认恢复原执行权限', exact=True)).to_have_count(0)
        assert page.evaluate('window.restored') == 0
        page.evaluate("window.fail=''")
        dialog.get_by_role('button', name='重新预览', exact=True).click()
        expect(dialog.get_by_role('button', name='确认恢复原执行权限', exact=True)).to_be_enabled()
        assert len(calls('agent.permissions.preview')) == 2
        checks.append('Restore failure discards the old revision and requires a fresh preview')

        reset()
        page.evaluate("window.hold='agent.permissions.preview'")
        trigger.click()
        expect(dialog.get_by_role('status')).to_contain_text('核验')
        dialog.get_by_role('button', name='取消', exact=True).click()
        expect(dialog).to_have_count(0)
        page.evaluate("window.pending.shift().resolve(window.fixture('codex-cli'))")
        expect(dialog).to_have_count(0)
        assert not page.evaluate('window.active')
        assert not calls('agent.permissions.restore')
        checks.append('Canceling a pending preview ignores its eventual result')

        reset()
        page.evaluate("window.hold='agent.permissions.preview'")
        trigger.click()
        page.evaluate("window.agent={id:'claude-code',name:'Claude Code',category:'cli'};window.render()")
        expect(dialog).to_have_count(0)
        page.evaluate("window.pending.shift().resolve(window.fixture('codex-cli'));window.hold=''")
        trigger.click()
        expect(dialog).to_have_attribute('aria-label', 'Claude Code · 恢复原执行权限')
        assert calls('agent.permissions.preview')[-1]['payload'] == {'agentId': 'claude-code'}
        checks.append('Changing clients invalidates an in-flight response and its revision')

        reset()
        page.evaluate('window.already=true')
        trigger.click()
        expect(dialog).to_contain_text('此操作不会降低原有权限')
        expect(dialog).to_contain_text('原本已经开启高权限')
        expect(dialog.get_by_role('button', name='确认恢复原执行权限', exact=True)).to_be_enabled()
        for theme in ['light', 'dark']:
            page.evaluate('(theme)=>document.documentElement.dataset.theme=theme', theme)
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        checks.append('Already-original high privileges remain explicit and reviewable in both themes at narrow width')

        reset()
        page.evaluate('window.aurora=undefined;window.render()')
        expect(trigger).to_have_count(0)
        page.evaluate("window.aurora=window.mock;window.agent={id:'workbuddy',name:'WorkBuddy',category:'desktop'};window.render()")
        expect(trigger).to_have_count(0)
        assert not page.evaluate('window.calls.length')
        checks.append('Browser and unsupported clients expose no permission mutation control')
        assert not errors, errors
        browser.close()
        for check in checks:
            print('PASS', check)
        print(f'Permission recovery UI: {len(checks)} checks passed.')
