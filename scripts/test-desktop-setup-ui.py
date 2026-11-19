"""Client configuration routing and desktop recovery with isolated IPC."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

FIXTURE = """() => {
 window.generation=0;window.calls=[];window.navigatedPage='';
 window.initialDetection={installed:false,configured:true,configPath:'C:/Fixture/.codex/config.toml',supportsCodexConfig:false,evidence:[]};
 window.readyDetection={...window.initialDetection,installed:true,command:'C:/Fixture/Codex.exe',productName:'Codex',version:'2.0',supportsCodexConfig:true,evidence:['已找到 Codex 编程模块']};
 window.resetFixture=()=>{
   window.generation++;window.calls=[];window.pending=[];window.holdTest=false;window.pendingTests=[];window.testFailure='';window.holdSelect=false;window.holdDetect=false;window.selectFailure='';window.selectCanceled=false;window.previewFailure='';window.connectFailure='';window.detectFailure='';window.selectionNextSupport='automatic';window.selectedDetection=structuredClone(window.readyDetection);window.nextDetection=structuredClone(window.readyDetection);
   window.state={settings:{},platform:'win32',agents:{},presets:[],providers:[{id:'supplier',name:'已测试供应商',baseUrl:'https://fixture.invalid/v1',format:'openai-responses',enabled:true,models:[{id:'gpt-5.4'},{id:'gpt-5.4-codex',contextWindow:128000}],apiKeys:[]}],detected:{'chatgpt-desktop':structuredClone(window.initialDetection)},agentCatalog:[{id:'chatgpt-desktop',name:'ChatGPT 桌面版',category:'desktop',vendor:'OpenAI',description:'桌面客户端',protocol:'openai-responses',configPath:'C:/Fixture/.codex/config.toml',support:'automatic',supportNote:'共享编程配置可直接应用，程序能力单独识别'}],codexCoexist:{identity:{available:false},models:[],warnings:[]}};
 };
 window.resetFixture();
 window.aurora={invoke:async(action,payload={})=>{
   window.calls.push({action,payload:structuredClone(payload)});
   if(action==='agent.test'){
     if(window.holdTest)await new Promise(resolve=>window.pendingTests.push(resolve));
     return {ok:!window.testFailure,message:window.testFailure||'测试通过，供应商 API 可用',requestId:payload.requestId,target:payload.target};
   }
   if(action==='agent.test.cancel')return {ok:true,canceled:true};
   if(action==='agent.preview'){
     if(window.previewFailure)return {ok:false,message:window.previewFailure};
     return {ok:true,revision:'reviewed-revision-'+window.calls.length,files:[{path:'C:/Fixture/.codex/config.toml',before:'old',after:'new'}],warnings:[],requiresRestart:true};
   }
   if(action==='agent.connect')return window.connectFailure?{ok:false,message:window.connectFailure}:{ok:true,message:'隔离配置已应用'};
   if(action==='agent.desktop.select'){
     if(window.holdSelect)await new Promise(resolve=>window.pending.push(resolve));
     if(window.selectCanceled)return {ok:false,canceled:true};
     const detected=structuredClone(window.selectedDetection);
     if(window.selectFailure)return {ok:false,message:window.selectFailure,detected};
     window.state.detected['chatgpt-desktop']=detected;
     window.state.agentCatalog[0].support=window.selectionNextSupport;
     return {ok:true,detected};
   }
   if(action==='agent.detect'){
     if(window.holdDetect)await new Promise(resolve=>window.pending.push(resolve));
     if(window.detectFailure)throw Error(window.detectFailure);
     window.state.detected['chatgpt-desktop']=structuredClone(window.nextDetection);
     return structuredClone(window.state.detected);
   }
   if(action==='agent.diagnose')return {ok:true,agentId:'chatgpt-desktop',checkedAt:new Date().toISOString(),checks:[{id:'installation',title:'客户端安装',status:'warning',detail:'可在向导中重新选择实际程序'}],report:'Fixture diagnostic without paths'};
   throw Error('Unexpected isolated RPC '+action);
 }};
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--screenshots', type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    checks, errors, network = [], [], []
    with tempfile.TemporaryDirectory(prefix='yunhui-desktop-setup-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Agents from './ui/src/pages/Agents.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderAgents=()=>root.render(<ToastHost key={window.generation}><Agents state={structuredClone(window.state)} reload={async()=>window.renderAgents()} go={page=>window.navigatedPage=page}/></ToastHost>);
window.renderAgents();"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle),
                   'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1380, 'height': 1050})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/*', lambda route: (network.append(route.request.url), route.abort()))
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            page.add_style_tag(path=str(bundle.with_suffix('.css')))
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate(FIXTURE)
            page.add_script_tag(path=str(bundle))

            def passed(label):
                checks.append(label)
                print('PASS', label, flush=True)

            def open_wizard(reset=True, setup=None, selected_model='gpt-5.4-codex'):
                if reset:
                    page.evaluate('window.resetFixture()')
                if setup:
                    page.evaluate(setup)
                page.evaluate('window.renderAgents()')
                connected = page.evaluate('!!window.state.agents[window.state.agentCatalog[0].id]?.connected')
                page.get_by_role('button', name='更换配置 →' if connected else '开始配置 →', exact=True).click()
                client_name = page.evaluate('window.state.agentCatalog[0].name')
                dialog = page.get_by_role('dialog', name='配置 ' + client_name, exact=True)
                dialog.locator('.provider-choice').filter(has=page.get_by_text('已测试供应商', exact=True)).click()
                codex = page.evaluate("['chatgpt-desktop','codex-desktop','codex-cli'].includes(window.state.agentCatalog[0].id)")
                if codex and page.evaluate("window.state.codexCoexist.identity.available"):
                    checkbox = dialog.get_by_label('保留官方账号并与第三方模型共存', exact=True)
                    if checkbox.is_checked():
                        expect(dialog.get_by_text('共存模式保留官方账号身份；第三方服务仅使用你配置的供应商密钥。', exact=True)).to_be_visible()
                    checkbox.uncheck()
                    expect(dialog.get_by_text('API 模式保留官方登录文件', exact=False)).to_be_visible()
                    expect(dialog.get_by_text('官方聊天及云功能可能暂不可用', exact=False)).to_be_visible()
                elif codex:
                    expect(dialog.get_by_text('API 模式保留官方登录文件', exact=False)).to_be_visible()
                dialog.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
                dialog.get_by_role('combobox', name='选择模型', exact=True).select_option(selected_model)
                dialog.get_by_role('button', name='上游网关测试', exact=True).click()
                expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
                return dialog

            def count(action):
                return page.evaluate('action=>window.calls.filter(call=>call.action===action).length', action)

            def last_payload(action):
                return page.evaluate('action=>window.calls.filter(call=>call.action===action).at(-1).payload', action)

            def panel_for(dialog, expand=False):
                panel = dialog.get_by_role('region', name='共享编程配置', exact=True)
                if expand:
                    panel.locator('.desktop-setup-program > summary').click()
                return panel

            dialog = open_wizard(False)
            expect(dialog.locator('#client-context-compact-hint')).to_have_text('自动压缩：115200 tokens（90%）')
            dialog.get_by_role('combobox', name='选择模型', exact=True).select_option('gpt-5.4')
            expect(dialog.locator('#client-context-compact-hint')).to_have_count(0)
            expect(dialog.get_by_text('应用时按上下文的 90% 同步默认自动压缩阈值', exact=False)).to_be_visible()
            dialog.get_by_role('combobox', name='选择模型', exact=True).select_option('gpt-5.4-codex')
            expect(dialog.locator('#client-context-compact-hint')).to_have_text('自动压缩：115200 tokens（90%）')
            passed('Model selection previews 90 percent of a saved window without inventing a limit for legacy models missing context')
            panel = panel_for(dialog)
            expect(page.locator('.client-card').get_by_text('发现本地配置', exact=True)).to_be_visible()
            expect(panel.get_by_text('C:/Fixture/.codex/config.toml', exact=True)).to_be_visible()
            expect(panel.get_by_text('已发现配置', exact=True)).to_be_visible()
            expect(panel.get_by_text('尚未定位程序', exact=True)).not_to_be_visible()
            expect(panel.get_by_text('无需先定位客户端程序', exact=False)).to_be_visible()
            expect(panel.get_by_text('直连时写入供应商 URL、Key 和模型 ID', exact=False)).to_be_visible()
            expect(panel.get_by_text('由云汇使用对应供应商的 URL 与 Key 转发请求', exact=False)).to_be_visible()
            expect(dialog.get_by_role('combobox', name='接入方式', exact=True)).to_have_value('gateway')
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_visible()
            assert count('agent.desktop.select') == count('agent.detect') == count('agent.connect') == 0
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            assert count('agent.connect') == 1
            assert last_payload('agent.connect')['mode'] == 'gateway'
            passed('Existing user configuration can be previewed and applied with no executable and no confirmed programming module')

            dialog = open_wizard()
            dialog.get_by_role('combobox', name='接入方式', exact=True).select_option('direct')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_have_count(0)
            expect(dialog.get_by_text('客户端直接请求供应商', exact=True)).to_be_visible()
            expect(dialog.get_by_text('首个已启用的 Key', exact=False)).to_be_visible()
            expect(dialog.get_by_text('配置加载后无需保持云汇运行', exact=False)).to_be_visible()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.locator('.review-summary .chip')).to_have_text('直连供应商')
            direct_selection = last_payload('agent.preview')
            assert direct_selection == {'agentId': 'chatgpt-desktop', 'providerId': 'supplier', 'model': 'gpt-5.4-codex', 'mode': 'direct', 'authMode': 'api', 'permissionMode': 'preserve', 'skipOnboarding': False}
            expected_revision = 'reviewed-revision-' + str(page.evaluate('window.calls.length'))
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            assert last_payload('agent.connect') == {**direct_selection, 'revision': expected_revision}
            passed('Direct mode explains URL and key routing, clears prior test feedback, and applies the exact reviewed selection')

            dialog = open_wizard()
            tests = dialog.get_by_role('region', name='连接测试', exact=True)
            dialog.get_by_role('button', name='本地网关测试', exact=True).click()
            expect(tests.get_by_role('status')).to_have_count(2)
            assert last_payload('agent.test')['target'] == 'local'
            assert last_payload('agent.test')['model'] == 'gpt-5.4-codex'
            expect(tests.get_by_text('可能产生少量费用', exact=False)).to_be_visible()
            page.evaluate('window.holdTest=true')
            dialog.get_by_role('button', name='上游网关测试', exact=True).click()
            page.wait_for_function('window.pendingTests.length===1')
            expect(dialog.get_by_role('button', name='预览配置 →', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('button', name='本地网关测试', exact=True)).to_be_disabled()
            pending_id = last_payload('agent.test')['requestId']
            dialog.get_by_role('button', name='取消测试', exact=True).click()
            expect(tests.get_by_text('测试已取消。', exact=True)).to_be_visible()
            assert last_payload('agent.test.cancel')['requestId'] == pending_id
            page.evaluate('window.pendingTests.shift()();window.holdTest=false')
            expect(tests.get_by_text('测试已取消。', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='预览配置 →', exact=True)).to_be_enabled()
            passed('Upstream and local gateway tests keep separate results, lock duplicate requests, and cancel without accepting a late success')

            page.evaluate('window.holdTest=true')
            dialog.get_by_role('button', name='本地网关测试', exact=True).click()
            page.wait_for_function('window.pendingTests.length===1')
            dialog.get_by_role('combobox', name='选择模型', exact=True).select_option('gpt-5.4')
            expect(tests.get_by_role('status')).to_have_count(0)
            page.evaluate('window.pendingTests.shift()();window.holdTest=false')
            expect(tests.get_by_role('status')).to_have_count(0)
            assert count('agent.test.cancel') == 2
            passed('Changing the selected model cancels the old test and clears results for the previous route')

            dialog = open_wizard()
            expect(dialog.get_by_role('combobox', name='客户端执行权限', exact=True)).to_have_value('preserve')
            dialog.get_by_role('combobox', name='客户端执行权限', exact=True).select_option('full-access')
            expect(dialog.get_by_text('沙箱外的文件', exact=False)).to_be_visible()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            assert last_payload('agent.preview')['permissionMode'] == 'full-access'
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            assert last_payload('agent.connect')['permissionMode'] == 'full-access'
            assert 'primary' in dialog.get_by_role('button', name='重新启动客户端', exact=True).get_attribute('class').split()
            passed('Advanced permissions are opt-in, reviewed before application, and successful setup prominently offers restart')

            dialog = open_wizard(setup="window.state.agentCatalog[0]={...window.state.agentCatalog[0],id:'claude-code',name:'Claude Code',category:'cli',protocol:'anthropic'};window.state.providers[0].format='anthropic'")
            onboarding = dialog.get_by_label('跳过首次登录引导（API 接入）', exact=True)
            expect(onboarding).not_to_be_checked()
            onboarding.check()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            assert last_payload('agent.preview')['skipOnboarding'] is True
            assert last_payload('agent.preview')['permissionMode'] == 'preserve'
            passed('Claude API onboarding compatibility is an independent opt-in and does not silently enable full permissions')

            claude_setup = "window.state.agentCatalog[0]={...window.state.agentCatalog[0],id:'claude-code',name:'Claude Code',category:'cli',protocol:'anthropic'};window.state.providers[0].format='anthropic';window.state.agents['claude-code']={connected:false,permissionMode:'full-access',skipOnboarding:true}"
            dialog = open_wizard(setup=claude_setup)
            expect(dialog.get_by_role('combobox', name='客户端执行权限', exact=True)).to_have_value('preserve')
            expect(dialog.get_by_label('跳过首次登录引导（API 接入）', exact=True)).not_to_be_checked()
            dialog = open_wizard(setup=claude_setup + ";window.state.agents['claude-code'].connected=true")
            expect(dialog.get_by_role('combobox', name='客户端执行权限', exact=True)).to_have_value('full-access')
            expect(dialog.get_by_label('跳过首次登录引导（API 接入）', exact=True)).to_be_checked()
            passed('Restoring a client requires a fresh permission opt-in; an active managed client keeps its previously chosen options')

            previous_direct = "window.state.agents['chatgpt-desktop']={mode:'direct',providerId:'supplier',model:'gpt-5.4-codex',connected:false}"
            official_login = "window.state.codexCoexist.identity.available=true;window.state.codexCoexist.models=[{official:true,upstreamModel:'gpt-official',displayName:'官方模型'}]"
            dialog = open_wizard(setup=previous_direct + ';' + official_login)
            expect(dialog.get_by_role('combobox', name='接入方式', exact=True)).to_have_value('direct')
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            first_revision = 'reviewed-revision-' + str(page.evaluate('window.calls.length'))
            dialog.get_by_role('button', name='上一步', exact=True).click()
            dialog.get_by_role('combobox', name='接入方式', exact=True).select_option('gateway')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_have_count(0)
            expect(dialog.get_by_text('将本地网关地址和令牌写入客户端配置', exact=False)).to_be_visible()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.locator('.review-summary .chip')).to_have_text('本地网关')
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            assert count('agent.preview') == 2
            assert last_payload('agent.connect')['mode'] == 'gateway'
            assert last_payload('agent.connect')['revision'] != first_revision
            passed('Previous direct mode survives reopening with an official login; switching mode requires and applies a fresh preview')

            for setup, reason in [
                ("window.state.providers[0].format='openai-chat'", '供应商与客户端协议不同'),
                ("window.state.providers[0].headers={'x-vendor-feature':'enabled'}", '此供应商有自定义请求头'),
                ("window.state.providers[0].proxy='http://proxy.invalid:8080'", '此供应商使用独立代理'),
                ("window.state.settings.proxy='http://proxy.invalid:8080'", '云汇已设置网络代理'),
                ("window.state.agentCatalog[0].support='manual'", '此客户端当前提供手动接入参数'),
                ("Object.assign(window.state.agentCatalog[0],{id:'claude-code',name:'Claude Code',protocol:'anthropic',category:'cli'});Object.assign(window.state.providers[0],{format:'anthropic',baseUrl:'https://fixture.invalid/proxy/v2'})", '此 API 版本无法由 Claude 客户端直连配置'),
            ]:
                dialog = open_wizard(setup=previous_direct + ';' + setup)
                expect(dialog.get_by_role('combobox', name='接入方式', exact=True)).to_have_value('gateway')
                expect(dialog.locator('option[value="direct"]')).to_be_disabled()
                expect(dialog.get_by_text(reason, exact=False)).to_be_visible()
                dialog.get_by_role('button', name='预览配置 →', exact=True).click()
                assert last_payload('agent.preview')['mode'] == 'gateway'
                assert count('agent.connect') == 0
            passed('Protocol conversion, custom headers, supplier or global proxy and manual setup cannot silently produce an incomplete direct configuration')

            for use_official_provider in [False, True]:
                dialog = open_wizard(setup=previous_direct + ';' + official_login)
                expect(dialog.get_by_role('combobox', name='接入方式', exact=True)).to_have_value('direct')
                dialog.get_by_role('button', name='上一步', exact=True).click()
                if use_official_provider:
                    dialog.locator('.provider-choice').filter(has=page.get_by_text('ChatGPT 官方账号', exact=True)).click()
                else:
                    dialog.get_by_label('保留官方账号并与第三方模型共存', exact=True).check()
                dialog.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
                expect(dialog.get_by_role('combobox', name='接入方式', exact=True)).to_have_value('gateway')
                expect(dialog.locator('option[value="direct"]')).to_be_disabled()
                expect(dialog.get_by_text('配置指向本地共存入口', exact=False)).to_be_visible()
                dialog.get_by_role('button', name='预览配置 →', exact=True).click()
                assert last_payload('agent.preview')['mode'] == 'gateway'
                assert last_payload('agent.preview')['authMode'] == 'coexist'
            passed('Both coexist selection and official-provider selection force gateway routing after a previous direct connection')

            claude_setup = "Object.assign(window.state.agentCatalog[0],{id:'claude-desktop',name:'Claude 桌面版',protocol:'anthropic'});Object.assign(window.state.providers[0],{format:'anthropic',models:[{id:'claude-sonnet-4-5'},{id:'custom-model'}]})"
            dialog = open_wizard(setup=claude_setup, selected_model='claude-sonnet-4-5')
            dialog.get_by_role('combobox', name='接入方式', exact=True).select_option('direct')
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            assert last_payload('agent.preview')['mode'] == 'direct'
            assert last_payload('agent.preview')['agentId'] == 'claude-desktop'
            dialog.get_by_role('button', name='上一步', exact=True).click()
            dialog.get_by_role('combobox', name='选择模型', exact=True).select_option('custom-model')
            expect(dialog.get_by_role('combobox', name='接入方式', exact=True)).to_have_value('gateway')
            expect(dialog.locator('option[value="direct"]')).to_be_disabled()
            expect(dialog.get_by_text('Claude 桌面直连需要 Claude 角色模型', exact=False)).to_be_visible()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            assert last_payload('agent.preview')['mode'] == 'gateway'
            passed('Claude Desktop accepts recognizable role models for direct mode and returns to gateway for arbitrary model mapping')

            dialog = open_wizard(setup="window.state.detected['chatgpt-desktop'].configured=false;window.state.codexCoexist.identity.available=true;window.state.codexCoexist.models=[{official:true,upstreamModel:'gpt-official',displayName:'官方模型'}]")
            dialog.get_by_role('button', name='上一步', exact=True).click()
            dialog.locator('.provider-choice').filter(has=page.get_by_text('ChatGPT 官方账号', exact=True)).click()
            dialog.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
            expect(dialog.locator('#client-context-compact-hint')).to_have_count(0)
            panel = panel_for(dialog)
            expect(panel.get_by_text('应用时创建', exact=True)).to_be_visible()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_visible()
            assert count('agent.connect') == 0
            passed('A missing configuration is described as ready to create and reaches a reviewable preview without installing or selecting a program')

            dialog = open_wizard(setup="window.previewFailure='配置文件正在被修改，请重新预览'")
            panel = panel_for(dialog, expand=True)
            expect(panel.get_by_text('尚未定位程序', exact=True)).to_be_visible()
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('配置文件正在被修改')
            page.evaluate('window.selectCanceled=true')
            previews = count('agent.preview')
            panel.get_by_role('button', name='选择程序并预览', exact=True).click()
            expect(dialog.get_by_role('button', name='预览配置 →', exact=True)).to_be_enabled()
            assert count('agent.preview') == previews and count('agent.connect') == 0
            expect(dialog.get_by_role('alert')).to_contain_text('配置文件正在被修改')
            expect(dialog.get_by_role('combobox', name='选择模型')).to_have_value('gpt-5.4-codex')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
            passed('Canceling native selection preserves the preview error, chosen provider and model, and successful API test')

            page.evaluate("window.selectCanceled=false;window.selectedDetection={...window.initialDetection,installed:true,command:'D:/Chosen/ChatGPT.exe',version:'1.1',evidence:['尚未发现编程模块'],detectionError:'程序元数据读取失败'};window.selectFailure='所选程序无法读取'")
            panel.get_by_role('button', name='选择程序并预览', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('所选程序无法读取')
            expect(panel.get_by_text('D:/Chosen/ChatGPT.exe', exact=True)).to_be_visible()
            expect(panel.get_by_text('程序元数据读取失败', exact=True)).to_be_visible()
            panel.locator('.desktop-setup-evidence > summary').click()
            expect(panel.get_by_text('尚未发现编程模块', exact=True)).to_be_visible()
            assert count('agent.preview') == previews and count('agent.connect') == 0
            expect(dialog.get_by_role('combobox', name='选择模型')).to_have_value('gpt-5.4-codex')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
            passed('Selection failures expose available program details while preserving model choices and API test results')

            page.evaluate("window.selectFailure='';window.previewFailure='';window.holdSelect=true")
            panel.get_by_role('button', name='选择程序并预览', exact=True).click()
            page.wait_for_function('window.pending.length===1')
            expect(dialog.get_by_role('combobox', name='选择模型')).to_be_disabled()
            expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_disabled()
            expect(panel.get_by_role('button', name='重新检测并预览', exact=True)).to_be_disabled()
            expect(panel.get_by_role('button', name='连接诊断', exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(dialog).to_be_visible()
            page.evaluate('window.pending.shift()();window.holdSelect=false')
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_visible()
            assert count('agent.connect') == 0
            selections = page.evaluate("window.calls.filter(call=>call.action==='agent.desktop.select').map(call=>call.payload)")
            assert all(payload == {'agentId': 'chatgpt-desktop'} for payload in selections)
            last_preview = page.evaluate("window.calls.filter(call=>call.action==='agent.preview').at(-1).payload")
            assert last_preview['providerId'] == 'supplier' and last_preview['model'] == 'gpt-5.4-codex'
            passed('Selecting an unconfirmed program locks editing, sends only agentId, and creates a fresh preview without applying automatically')

            page.evaluate("window.connectFailure='配置已在其他窗口变化，请重新预览'")
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('请重新预览')
            expect(dialog.get_by_role('combobox', name='选择模型')).to_have_value('gpt-5.4-codex')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
            page.evaluate("window.connectFailure=''")
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            passed('Application conflicts return to the same choices for a new preview and successful retry')

            dialog = open_wizard(setup="window.state.agentCatalog[0].support='manual';window.state.detected['chatgpt-desktop']=structuredClone(window.readyDetection)")
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).not_to_be_visible()
            dialog.get_by_role('button', name='上一步', exact=True).click()
            panel = panel_for(dialog, expand=True)
            page.evaluate('window.selectedDetection=structuredClone(window.initialDetection)')
            panel.get_by_role('button', name='选择程序并预览', exact=True).click()
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_visible()
            assert count('agent.connect') == 0
            passed('Apply capability follows the latest catalog, independently of detected module support and the originally selected card')

            dialog = open_wizard()
            panel = panel_for(dialog, expand=True)
            page.evaluate('window.holdDetect=true;window.nextDetection=structuredClone(window.initialDetection)')
            panel.get_by_role('button', name='重新检测并预览', exact=True).click()
            page.wait_for_function('window.pending.length===1')
            expect(dialog.get_by_role('combobox', name='选择模型')).to_be_disabled()
            page.evaluate('window.pending.shift()();window.holdDetect=false')
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_visible()
            assert count('agent.desktop.select') == 0 and count('agent.connect') == 0
            dialog.get_by_role('button', name='上一步', exact=True).click()
            panel = panel_for(dialog, expand=True)
            expect(panel.get_by_text('尚未定位程序', exact=True)).to_be_visible()
            expect(dialog.get_by_role('combobox', name='选择模型')).to_have_value('gpt-5.4-codex')
            expect(dialog.get_by_text('测试通过，供应商 API 可用', exact=False)).to_be_visible()
            panel.get_by_role('button', name='连接诊断', exact=True).click()
            diagnostic = page.get_by_role('dialog', name='ChatGPT 桌面版 · 连接诊断', exact=True)
            expect(diagnostic.get_by_text('可在向导中重新选择实际程序', exact=True)).to_be_visible()
            page.keyboard.press('Escape')
            expect(diagnostic).not_to_be_visible()
            expect(dialog).to_be_visible()
            passed('Redetection without an executable still previews; nested diagnostics preserve the wizard and model selection')

            dialog = open_wizard(setup="window.state.platform='darwin';window.state.detected['chatgpt-desktop']={...window.initialDetection,command:'/Applications/Long Client Name/ChatGPT.app/Contents/MacOS/ChatGPT',configPath:'/Users/Fixture/.codex/config.toml',version:undefined}")
            panel = panel_for(dialog, expand=True)
            expect(panel.get_by_text('.app 应用包', exact=False)).to_be_visible()
            expect(panel.get_by_text('尚未读取到版本', exact=True)).to_be_visible()
            page.evaluate("document.documentElement.dataset.theme='dark'")
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'desktop-recovery-dark.png'), animations='disabled')
            page.set_viewport_size({'width': 390, 'height': 844})
            panel.scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            for button in panel.get_by_role('button').all():
                box = button.bounding_box()
                assert box and box['x'] >= 0 and box['x'] + box['width'] <= 390, box
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'desktop-recovery-narrow-dark.png'), animations='disabled')
            passed('macOS program guidance, unknown version, long paths and the narrow dark layout remain usable')
            assert not errors, errors
            assert not network, network
            assert page.evaluate('window.navigatedPage') == ''
            browser.close()
    print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
