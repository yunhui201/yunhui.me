"""Update settings and download browser acceptance with isolated mocked IPC/RPC.

Uses the production React pages. No real provider, gateway, download, or browser
navigation is invoked. Failures are collected so one regression does not hide
other independent checks.
"""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'docs/UPDATE-UI-VALIDATION.json'

HARNESS = """import React from 'react';import {createRoot} from 'react-dom/client';
import App from './ui/src/App.tsx';import Settings from './ui/src/pages/Settings.tsx';
import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));let generation=0;
window.mount=(mode='settings')=>root.render(mode==='app'?<App key={++generation}/>:<ToastHost key={++generation}><Settings state={structuredClone(window.appState)} reload={async()=>{}} go={()=>{}}/></ToastHost>);
window.mount();
"""

FIXTURE = """()=>{
  window.calls=[];window.opened=[];window.windowOpens=[];window.pending=[];
  window.hold={};window.manualError='';window.websiteError='';
  window.latest={ok:true,current:'0.6.0',version:'0.7.0',hasUpdate:true,mandatory:false,source:'github',url:'https://github.com/yunhui201/yunhui.me/releases/download/v0.7.0/YunHuiAI-0.7.0-win-x64-setup.exe',releaseUrl:'https://github.com/yunhui201/yunhui.me/releases/tag/v0.7.0',assetName:'YunHuiAI-0.7.0-win-x64-setup.exe',notes:'改进客户端配置与更新体验。'};
  window.manual=structuredClone(window.latest);
  window.website={...window.latest,source:'website',url:'https://yunhui.me/downloads/YunHuiAI-0.7.0-win-x64-setup.exe'};
  window.openResult={ok:true};
  window.appState={settings:{language:'zh-CN',theme:'light',accent:'#4f66e8',gatewayHost:'127.0.0.1',gatewayPort:3425,autoStartGateway:true,launchAtLogin:false,closeToTray:true,proxy:'',maskSecrets:false,autoTrimContext:false,maxRetries:2,requestTimeoutMs:60000,usageRetentionDays:30,lanShare:false,gatewayToken:'isolated-test-token',webdavUrl:'',webdavUser:'',webdavPass:'',firstByteTimeoutMs:30000,logRequests:true,catalogUrl:'https://catalog.fixture.test/private',updateUrl:'https://legacy.fixture.test/update',autoCheckUpdate:true,adminUrl:'',autoSyncModels:true,updatedAt:''},providers:[],plugins:[],groups:[],presets:[],agents:{},agentCatalog:[],detected:{},gateway:{running:true,host:'127.0.0.1',port:3425},gatewayUrl:'http://127.0.0.1:3425',version:'0.6.0',platform:'win32',dataDir:'C:/isolated-fixture',mode:'desktop'};
  const gate=async label=>{if(window.hold[label])await new Promise(resolve=>window.pending.push({label,resolve}));};
  window.release=label=>{window.hold[label]=false;const ready=window.pending.filter(p=>p.label===label);window.pending=window.pending.filter(p=>p.label!==label);ready.forEach(p=>p.resolve());};
  window.rpc=async(action,payload={})=>{
    window.calls.push({action,payload:structuredClone(payload)});
    if(action==='state.get')return structuredClone(window.appState);
    if(action==='update.check'){
      const website=payload.source==='website';await gate(website?'website':'manual');
      const error=website?window.websiteError:window.manualError;if(error)throw new Error(error);
      return structuredClone(website?window.website:window.manual);
    }
    if(action==='app.openExternal'){await gate('open');if(window.openResult.ok)window.opened.push(payload.url);return structuredClone(window.openResult);}
    if(action==='settings.save'){Object.assign(window.appState.settings,payload);return {ok:true};}
    throw new Error('Unexpected RPC: '+action);
  };
  window.desktop={invoke:window.rpc,onGateway:()=>()=>{},onUsage:()=>()=>{},recent:async()=>[]};
  window.aurora=window.desktop;
  window.open=(...args)=>{window.windowOpens.push(args);return null;};
  window.fetch=async(url,options)=>{
    if(url!=='/api/rpc')throw new Error('Unexpected network: '+url);
    const request=JSON.parse(options.body);const result=await window.rpc(request.action,request.payload);
    return new Response(JSON.stringify({result}),{status:200,headers:{'content-type':'application/json'}});
  };
  window.location.hash='settings';
}"""


def main():
    checks, failures, errors, blocked_network = [], [], [], []
    with tempfile.TemporaryDirectory(prefix='yunhui-update-ui-') as temporary:
        bundle = Path(temporary) / 'update-ui.js'
        build = 'require("esbuild").buildSync(' + json.dumps({
            'stdin': {'contents': HARNESS, 'resolveDir': str(ROOT), 'loader': 'tsx'},
            'bundle': True, 'platform': 'browser', 'format': 'iife',
            'outfile': str(bundle), 'define': {'process.env.NODE_ENV': '"production"'},
        }) + ')'
        subprocess.run(['node', '-e', build], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1280, 'height': 1000})

            def route(request):
                if request.request.url == 'https://aurora.fixture.test/':
                    request.fulfill(status=200, content_type='text/html', body='<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
                else:
                    blocked_network.append(request.request.url)
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()
            page.set_default_timeout(3000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto('https://aurora.fixture.test/')
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate(FIXTURE)
            page.add_script_tag(path=str(bundle))

            def reset(mode='settings', remote=False, theme='light'):
                page.set_viewport_size({'width': 1280, 'height': 1000})
                page.evaluate("""({mode,remote,theme})=>{
                  for(const pending of window.pending)pending.resolve();window.pending=[];
                  window.hold={};window.calls=[];window.opened=[];window.windowOpens=[];
                  window.manual=structuredClone(window.latest);window.manualError='';window.websiteError='';window.openResult={ok:true};
                  window.website={...window.latest,source:'website',url:'https://yunhui.me/downloads/YunHuiAI-0.7.0-win-x64-setup.exe'};
                  window.appState.settings.theme=theme;window.appState.settings.autoCheckUpdate=true;
                  window.aurora=remote?undefined:window.desktop;window.appState.mode=remote?'web':'desktop';
                  document.documentElement.dataset.theme=theme;
                  document.getElementById('root').style.padding=mode==='app'?'0':'24px';
                  window.mount(mode);
                }""", {'mode': mode, 'remote': remote, 'theme': theme})
                expect(page.get_by_role('heading', name='系统设置', exact=True)).to_be_visible()

            def update_tab():
                page.get_by_role('button', name='版本更新', exact=True).click()

            def check_update():
                page.get_by_role('button', name='检查更新', exact=True).click()

            def no_navigation():
                assert page.evaluate("window.calls.filter(x=>x.action==='app.openExternal').length") == 0
                assert page.evaluate('window.windowOpens.length') == 0

            def run(name, test):
                try:
                    reset()
                    test()
                    checks.append(name)
                except Exception as error:
                    failures.append({'check': name, 'error': str(error)})

            def hidden_controls():
                for tab in ['外观与启动', '网关与隐私', '版本更新', '数据与关于']:
                    page.get_by_role('button', name=tab, exact=True).click()
                    for text in ['供应商目录', '远端目录地址', '保存供应商后同步模型', '更新地址']:
                        expect(page.get_by_text(text, exact=True)).to_have_count(0)
                    expect(page.get_by_label('远端目录地址', exact=True)).to_have_count(0)
                    expect(page.get_by_role('switch', name='保存供应商后同步模型', exact=True)).to_have_count(0)
                    assert not page.locator('input').evaluate_all("nodes=>nodes.some(n=>/catalog.fixture.test|legacy.fixture.test/.test(n.value))")
                no_navigation()
            run('All Settings tabs hide directory address, model-sync switch, and update-source URL', hidden_controls)

            def explicit_download():
                update_tab(); check_update()
                expect(page.get_by_text('发现新版本 v0.7.0', exact=True)).to_be_visible()
                expect(page.get_by_role('button', name='GitHub 下载', exact=True)).to_be_visible()
                no_navigation()
                assert page.evaluate("window.calls.find(x=>x.action==='update.check').payload") == {}
                page.get_by_role('button', name='GitHub 下载', exact=True).click()
                page.wait_for_function('window.opened.length===1')
                assert page.evaluate('window.opened[0]') == page.evaluate('window.latest.url')
            run('Manual checks ignore legacy URL settings and only an explicit GitHub download opens a link', explicit_download)

            def fallback_payload():
                update_tab(); check_update()
                page.get_by_role('button', name='官网备用', exact=True).click()
                page.wait_for_function('window.opened.length===1')
                assert page.evaluate("window.calls.filter(x=>x.action==='update.check').at(-1).payload") == {'source': 'website', 'minimumVersion': '0.7.0'}
                assert page.evaluate('window.opened') == ['https://yunhui.me/downloads/YunHuiAI-0.7.0-win-x64-setup.exe']
            run('Website fallback passes source and minimumVersion and opens only the validated returned URL', fallback_payload)

            def bad_website(kind):
                update_tab(); check_update()
                if kind == 'old':
                    page.evaluate("window.website={ok:false,message:'官网当前仅提供 v0.6.0，请使用 GitHub 下载 v0.7.0'}")
                    message = '官网当前仅提供 v0.6.0，请使用 GitHub 下载 v0.7.0'
                elif kind == 'package':
                    page.evaluate("window.website={...window.website,url:'',message:'官网尚未提供 Windows 安装包'}")
                    message = '官网尚未提供 Windows 安装包'
                else:
                    page.evaluate("window.websiteError='官网连接超时，请稍后重试'")
                    message = '官网连接超时，请稍后重试'
                page.get_by_role('button', name='官网备用', exact=True).click()
                expect(page.get_by_role('alert')).to_have_text(message)
                no_navigation()
                page.evaluate("window.websiteError='';window.website={...window.latest,source:'website',url:'https://yunhui.me/verified-new-installer.exe'}")
                page.get_by_role('button', name='官网备用', exact=True).click()
                page.wait_for_function('window.opened.length===1')
                expect(page.get_by_role('alert')).to_have_count(0)
                assert page.evaluate('window.opened[0]') == 'https://yunhui.me/verified-new-installer.exe'
            for kind, label in [('old', 'Older website release'), ('package', 'Missing platform package'), ('network', 'Website network rejection')]:
                run(label + ' remains visible without navigation and can recover on retry', lambda kind=kind: bad_website(kind))

            def check_failure(thrown):
                update_tab()
                if thrown:
                    page.evaluate("window.manualError='更新服务网络不可达'")
                else:
                    page.evaluate("window.manual={ok:false,message:'更新服务网络不可达'}")
                check_update()
                expect(page.get_by_role('alert')).to_have_text('更新服务网络不可达')
                no_navigation()
                page.evaluate('window.manualError="";window.manual=structuredClone(window.latest)')
                check_update()
                expect(page.get_by_role('alert')).to_have_count(0)
                expect(page.get_by_text('发现新版本 v0.7.0', exact=True)).to_be_visible()
                no_navigation()
            run('Update RPC failure stays on the page and a new check recovers without navigation', lambda: check_failure(False))
            run('Rejected update IPC stays on the page and a new check recovers without navigation', lambda: check_failure(True))

            def duplicate_check():
                update_tab(); page.evaluate('window.hold.manual=true'); check_update()
                busy = page.get_by_role('button', name='正在检查…', exact=True)
                expect(busy).to_be_disabled()
                busy.evaluate('node=>{node.click();node.click();}')
                assert page.evaluate("window.calls.filter(x=>x.action==='update.check').length") == 1
                page.evaluate("window.release('manual')")
                expect(page.get_by_role('button', name='检查更新', exact=True)).to_be_enabled()
                expect(page.get_by_text('发现新版本 v0.7.0', exact=True)).to_be_visible()
            run('A pending manual check disables repeated clicks until it completes', duplicate_check)

            def duplicate_download():
                update_tab(); check_update(); page.evaluate('window.hold.website=true')
                page.get_by_role('button', name='官网备用', exact=True).click()
                processing = page.get_by_role('button', name='处理中…', exact=True)
                expect(processing).to_be_disabled()
                primary = page.get_by_role('button', name='GitHub 下载', exact=True)
                expect(primary).to_be_disabled()
                processing.evaluate('node=>{node.click();node.click();}')
                primary.evaluate('node=>node.click()')
                assert page.evaluate("window.calls.filter(x=>x.action==='update.check'&&x.payload.source==='website').length") == 1
                no_navigation()
                page.evaluate("window.release('website')")
                page.wait_for_function('window.opened.length===1')
                expect(primary).to_be_enabled()
                page.evaluate("window.hold.open=true")
                primary.click()
                expect(primary).to_be_disabled()
                primary.evaluate('node=>node.click()')
                assert page.evaluate("window.calls.filter(x=>x.action==='app.openExternal').length") == 2
                page.evaluate("window.release('open')")
                expect(primary).to_be_enabled()
            run('Both download actions disable duplicate website requests and pending browser opens', duplicate_download)

            def opening_failure():
                update_tab(); check_update()
                page.evaluate("window.openResult={ok:false,message:'系统无法打开默认浏览器'}")
                page.get_by_role('button', name='GitHub 下载', exact=True).click()
                expect(page.get_by_role('alert')).to_have_text('系统无法打开默认浏览器')
                assert page.evaluate('window.opened.length') == 0
                page.evaluate('window.openResult={ok:true}')
                page.get_by_role('button', name='GitHub 下载', exact=True).click()
                expect(page.get_by_role('alert')).to_have_count(0)
                page.wait_for_function('window.opened.length===1')
            run('Browser-open failures remain visible and retry succeeds', opening_failure)

            def no_update():
                update_tab()
                page.evaluate("window.manual={...window.latest,version:'0.6.0',hasUpdate:false,url:''}")
                check_update()
                expect(page.get_by_text('当前版本无需更新', exact=True)).to_be_visible()
                expect(page.get_by_role('button', name='GitHub 下载', exact=True)).to_have_count(0)
                expect(page.get_by_role('button', name='官网备用', exact=True)).to_have_count(0)
                no_navigation()
            run('An up-to-date installation shows no installer actions', no_update)

            def direct_website():
                update_tab(); page.evaluate('window.manual=structuredClone(window.website)'); check_update()
                expect(page.get_by_text('最新正式版 v0.7.0 · 来源：官网备用', exact=True)).to_be_visible()
                no_navigation()
                expect(page.get_by_role('button', name='官网备用', exact=True)).to_have_count(0)
                page.get_by_role('button', name='官网下载', exact=True).click()
                page.wait_for_function('window.opened.length===1')
                assert page.evaluate('window.opened[0]') == page.evaluate('window.website.url')
            run('Automatic website fallback is labelled and still requires an explicit download', direct_website)

            def desktop_banner():
                reset(mode='app')
                expect(page.get_by_text('新版本 v0.7.0 已发布 · GitHub', exact=True)).to_be_visible()
                no_navigation()
                page.get_by_role('button', name='官网备用', exact=True).click()
                page.wait_for_function('window.opened.length===1')
                assert page.evaluate("window.calls.filter(x=>x.action==='update.check').at(-1).payload") == {'source': 'website', 'minimumVersion': '0.7.0'}
                page.get_by_role('button', name='稍后', exact=True).click()
                expect(page.get_by_text('新版本 v0.7.0 已发布 · GitHub', exact=True)).to_have_count(0)
            run('Desktop App banner checks automatically but downloads and dismisses only on user action', desktop_banner)

            def remote_app():
                reset(mode='app', remote=True)
                expect(page.get_by_text('当前是远程控制台。系统设置和密钥管理请在电脑上的云汇 AI 桌面端完成。', exact=True)).to_be_visible()
                # Wait through two paint cycles so mount effects have run; no real polling delay needed.
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                assert page.evaluate("window.calls.filter(x=>x.action==='update.check').length") == 0
                update_tab()
                expect(page.get_by_role('button', name='检查更新', exact=True)).to_be_disabled()
                expect(page.get_by_role('button', name='GitHub 下载', exact=True)).to_have_count(0)
                no_navigation()
            run('Remote Web App never checks host updates and disables desktop update controls', remote_app)

            def narrow_dark():
                reset(mode='app', theme='dark')
                update_tab(); check_update()
                page.set_viewport_size({'width': 720, 'height': 900})
                expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
                for button in page.get_by_role('button', name='GitHub 下载', exact=True).all():
                    expect(button).to_be_visible()
                    box = button.bounding_box()
                    assert box['x'] >= 0 and box['x'] + box['width'] <= 720
                dims = page.locator('#main-content').evaluate('(node)=>({width:node.clientWidth,scroll:node.scrollWidth})')
                assert dims['scroll'] <= dims['width'] + 1, dims
                assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
            run('Dark theme update result and banner fit a 720px desktop window without horizontal overflow', narrow_dark)

            if errors:
                failures.append({'check': 'No renderer exceptions', 'error': errors})
            else:
                checks.append('No renderer exceptions during the exercised update flows')
            if blocked_network:
                failures.append({'check': 'No unexpected network or external navigation', 'error': blocked_network})
            else:
                checks.append('All IPC, RPC and external downloads remain isolated; no network requests escape the fixture')
            browser.close()

    report = {
        'passed': not failures, 'count': len(checks), 'checks': checks, 'failures': failures,
        'scope': 'Chromium real Settings/App/UpdateActions with controlled IPC and RPC responses; no real update services, downloads, or local client changes',
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True), flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
