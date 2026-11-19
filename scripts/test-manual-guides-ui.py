"""Manual setup UI uses mocked IPC and clipboard only; no real clients, keys, or requests."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = ROOT / 'tmp/manual-guide-ui'
SCREENSHOTS.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='yunhui-manual-guides-ui-') as temporary:
    bundle = Path(temporary) / 'manual.js'
    source = """import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import ManualClientGuide from './ui/src/components/ManualClientGuide.tsx';
const root=createRoot(document.getElementById('root'));
window.render=()=>flushSync(()=>root.render(window.visible?<ManualClientGuide {...window.props}/>:null));"""
    options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
    subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 1400})
        page.route('**/*', lambda route: route.abort())
        errors, checks = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_default_timeout(5000)
        page.set_content('<html data-theme="light"><body style="overflow:auto"><main id="root" style="max-width:860px;padding:20px;margin:auto"></main></body></html>')
        page.add_style_tag(path=str(ROOT / 'ui/src/styles/app.css'))
        page.add_style_tag(path=str(bundle.with_suffix('.css')))
        page.evaluate("""()=>{
          window.visible=true;window.calls=[];window.pending=[];window.copies=[];window.hold=false;window.fail=false;window.clipboardFail=false;
          window.props={agent:{id:'workbuddy',name:'WorkBuddy / CodeBuddy',protocol:'openai-chat'},platform:'win32',
            preview:{ok:true,revision:'fixture-revision',manual:{baseUrl:'http://127.0.0.1:3425/v1',model:'fixture-provider/qwen',apiKey:'DO-NOT-RENDER-PREVIEW-KEY'}},
            selection:{agentId:'workbuddy',providerId:'fixture-provider',model:'qwen',mode:'gateway',authMode:'api'}};
          window.fixture=()=>({ok:true,baseUrl:window.props.preview.manual.baseUrl,model:window.props.preview.manual.model,apiKey:'FIXTURE-PRIVATE-TOKEN'});
          window.ipc={invoke:async(action,payload)=>{window.calls.push({action,payload});
            if(action!=='agent.parameters')throw Error('Unexpected action');
            if(window.fail)throw Error('FIXTURE-PRIVATE-TOKEN RAW-ERROR');
            if(window.hold)return new Promise(resolve=>window.pending.push(resolve));return window.fixture();}};
          window.aurora=window.ipc;
          Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.clipboardFail)throw Error(text);window.copies.push(text);}},configurable:true});
          window.secretDOM=false;window.textareaDOM=false;
          new MutationObserver(()=>{
            if(/FIXTURE-PRIVATE-TOKEN|DO-NOT-RENDER-PREVIEW-KEY|RAW-ERROR/.test(document.body.innerHTML))window.secretDOM=true;
            if(document.querySelector('textarea'))window.textareaDOM=true;
          }).observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
          window.switchAgent=id=>{window.props={...window.props,agent:{id,name:id,protocol:'openai-chat'},selection:{...window.props.selection,agentId:id}};window.render();};
        }""")
        page.add_script_tag(path=str(bundle))
        page.evaluate('window.render()')
        expect(page.get_by_text('WorkBuddy · 自定义模型', exact=True)).to_be_visible()
        expect(page.locator('.manual-guide-fields')).to_contain_text('/v1/chat/completions')
        expect(page.locator('.manual-guide-fields')).to_contain_text('YOUR_YUNHUI_GATEWAY_TOKEN')
        assert page.evaluate('window.calls.length') == 0
        assert 'DO-NOT-RENDER-PREVIEW-KEY' not in page.content()
        page.locator('.manual-client-guide').screenshot(path=str(SCREENSHOTS / 'workbuddy-light.png'))
        page.get_by_role('button', name='复制完整连接参数', exact=True).click()
        expect(page.get_by_role('status')).to_contain_text('复制不代表已配置或已验证')
        assert page.evaluate('window.copies.at(-1)') == '协议: OpenAI Chat Completions\n完整接口 URL: http://127.0.0.1:3425/v1/chat/completions\n模型 ID: fixture-provider/qwen\nAPI Key / 访问令牌: FIXTURE-PRIVATE-TOKEN'
        assert page.evaluate('window.calls[0]') == {'action': 'agent.parameters', 'payload': {'agentId': 'workbuddy', 'providerId': 'fixture-provider', 'model': 'qwen', 'mode': 'gateway', 'authMode': 'api'}}
        checks.append('No eager IPC; real credentials copied only on explicit desktop action without rendering preview or returned keys')

        page.get_by_label('手动指南版本').select_option('codebuddy-cli')
        expect(page.locator('.manual-guide-path')).to_contain_text('%USERPROFILE%\\.codebuddy\\models.json')
        page.get_by_role('button', name='复制占位示例').click()
        assert json.loads(page.evaluate('window.copies.at(-1)'))['models'][0]['apiKey'] == 'YOUR_YUNHUI_GATEWAY_TOKEN'
        assert page.evaluate('window.calls.length') == 1
        page.get_by_role('button', name='复制可用配置（含令牌）').click()
        expect(page.get_by_role('status')).to_contain_text('含访问令牌')
        assert json.loads(page.evaluate('window.copies.at(-1)'))['models'][0]['apiKey'] == 'FIXTURE-PRIVATE-TOKEN'
        checks.append('CodeBuddy has its own path and endpoint; safe example copying does not fetch credentials')

        page.evaluate('window.hold=true;window.copies=[]')
        page.get_by_role('button', name='复制可用配置（含令牌）').click()
        expect(page.get_by_role('button', name='复制真实令牌')).to_be_disabled()
        old_calls = page.evaluate('window.calls.length')
        page.get_by_label('手动指南版本').select_option('codebuddy-ide')
        page.evaluate('window.pending.shift()(window.fixture())')
        expect(page.get_by_text('CodeBuddy IDE · 自定义模型', exact=True)).to_be_visible()
        assert page.evaluate('window.copies.length') == 0
        assert page.evaluate('window.calls.length') == old_calls
        page.get_by_role('button', name='复制真实令牌').click()
        page.evaluate("window.props={...window.props,selection:{...window.props.selection,providerId:'different-provider'}};window.render()")
        page.evaluate('window.pending.shift()(window.fixture())')
        assert page.evaluate('window.copies.length') == 0
        checks.append('Duplicate sensitive copy disabled; variant and provider changes invalidate delayed parameters')

        page.get_by_role('button', name='复制真实令牌').click()
        page.evaluate('window.pending.shift()({...window.fixture(),baseUrl:"http://127.0.0.1:9999/v1"})')
        expect(page.get_by_role('alert')).to_contain_text('重新预览')
        assert page.evaluate('window.copies.length') == 0
        page.get_by_role('button', name='复制真实令牌').click()
        page.evaluate('window.visible=false;window.render()')
        page.evaluate('window.pending.shift()(window.fixture())')
        assert page.evaluate('window.copies.length') == 0
        page.evaluate('window.visible=true;window.hold=false;window.fail=true;window.render()')
        page.get_by_role('button', name='复制真实令牌').click()
        expect(page.get_by_role('alert')).to_contain_text('复制未完成')
        assert 'RAW-ERROR' not in page.content()
        page.evaluate('window.fail=false;window.clipboardFail=true')
        page.get_by_role('button', name='复制真实令牌').click()
        expect(page.get_by_role('alert')).to_contain_text('复制未完成')
        assert page.evaluate('window.copies.length') == 0
        assert not page.evaluate('window.textareaDOM')
        page.evaluate('window.clipboardFail=false')
        checks.append('Changed fresh parameters and unmount refuse copy; IPC and clipboard errors stay sanitized without textarea fallback')

        page.evaluate("window.switchAgent('kimi-code')")
        expect(page.get_by_text('复制未完成，请重新预览并在电脑桌面端重试。', exact=True)).to_have_count(0)
        expect(page.get_by_role('alert')).to_contain_text('max_context_size')
        expect(page.get_by_role('button', name='复制可用配置（含令牌）')).to_have_count(0)
        expect(page.get_by_role('button', name='复制命令')).to_be_disabled()
        page.get_by_label('模型上下文 Token 数').fill('128000')
        expect(page.locator('.manual-guide-document')).to_contain_text('openai_legacy')
        expect(page.locator('.manual-guide-document')).to_contain_text('max_context_size = 128000')
        page.get_by_role('button', name='复制可用配置（含令牌）').click()
        expect(page.get_by_role('status')).to_contain_text('含访问令牌')
        assert 'api_key = "FIXTURE-PRIVATE-TOKEN"' in page.evaluate('window.copies.at(-1)')
        page.evaluate("window.props={...window.props,platform:'darwin',modelContextWindow:64000};window.render()")
        expect(page.locator('.manual-guide-path')).to_contain_text('~/.kimi/yunhui.toml')
        expect(page.get_by_label('模型上下文 Token 数')).to_have_value('64000')
        expect(page.locator('.manual-guide-command')).to_contain_text('"$HOME/.kimi/yunhui.toml"')
        checks.append('Kimi blocks fabricated context and generates distinct Windows/macOS explicit-file commands')

        page.evaluate("window.switchAgent('opencode')")
        expect(page.locator('.manual-guide-document')).to_contain_text('@ai-sdk/openai-compatible')
        page.get_by_label('手动指南版本').select_option('opencode-v2')
        expect(page.locator('.manual-guide-document')).to_contain_text('@opencode/ai/providers/openai-compatible')
        expect(page.locator('.manual-guide-document')).to_contain_text('"modelID": "fixture-provider/qwen"')
        page.evaluate("document.documentElement.dataset.theme='dark'")
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('.manual-client-guide').screenshot(path=str(SCREENSHOTS / 'opencode-dark-narrow.png'))
        page.evaluate("window.switchAgent('qwen-code')")
        expect(page.locator('.manual-guide-document')).to_contain_text('"selectedType": "openai"')
        expect(page.locator('.manual-guide-document')).to_contain_text('"wireApi": "chat-completions"')
        checks.append('OpenCode formats remain explicit and Qwen config selects the verified protocol')

        for theme in ['light', 'dark']:
            page.evaluate('(theme)=>document.documentElement.dataset.theme=theme', theme)
            page.set_viewport_size({'width': 390, 'height': 844})
            expect(page.get_by_role('button', name='复制可用配置（含令牌）')).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.evaluate('window.aurora=null;window.render()')
        expect(page.get_by_role('button', name='复制真实令牌')).to_be_disabled()
        expect(page.get_by_role('button', name='复制完整连接参数')).to_be_disabled()
        expect(page.get_by_role('button', name='复制可用配置（含令牌）')).to_be_disabled()
        calls_before = page.evaluate('window.calls.length')
        page.get_by_role('button', name='复制占位示例').click()
        assert page.evaluate('window.calls.length') == calls_before
        assert 'FIXTURE-PRIVATE-TOKEN' not in page.evaluate('window.copies.at(-1)')
        checks.append('Narrow light/dark layouts fit; remote view permits only placeholder copy')

        assert not page.evaluate('window.secretDOM'), 'A secret reached the DOM'
        assert not page.evaluate('window.textareaDOM'), 'A hidden clipboard textarea was created'
        assert not errors, errors
        browser.close()
        print(json.dumps({'ok': True, 'checks': checks}, ensure_ascii=False, indent=2))
