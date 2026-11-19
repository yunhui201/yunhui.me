"""Focused local-discovery UI checks using isolated mock snapshots and RPC calls."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-local-client-ui-') as temporary:
        bundle = str(Path(temporary) / 'local-clients.js')
        source = """import React from 'react';
import {createRoot} from 'react-dom/client';
import Providers from './ui/src/pages/Providers.tsx';
import Accounts from './ui/src/pages/Accounts.tsx';
import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderPage=(page='providers')=>{window.currentPage=page;const Page=page==='accounts'?Accounts:Providers;
root.render(<ToastHost><Page state={structuredClone(window.fixture)} reload={async()=>{window.reloads++;window.renderPage(window.currentPage);}} go={page=>{window.lastNavigation=page;}}/></ToastHost>);};
window.renderPage();"""
        build = "require('esbuild').buildSync(" + json.dumps({
            'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'},
            'bundle': True, 'platform': 'browser', 'format': 'iife', 'outfile': bundle,
            'define': {'process.env.NODE_ENV': '"production"'},
        }) + ')'
        subprocess.run(['node', '-e', build], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1260, 'height': 980})
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            for stylesheet in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / stylesheet))
            page.evaluate("""() => {
              window.calls=[];window.reloads=0;window.failScan=false;
              const identity=(kind,status)=>({id:kind,kind,label:kind+' official',source:'/fixture/'+kind+'/auth.json',email:kind+'@example.test',authKind:'oauth',credentialStatus:status,found:true,format:'openai-responses'});
              window.fixture={settings:{autoSyncModels:false},presets:[],providers:[{id:'api-1',name:'已有中转 API',format:'openai-responses',baseUrl:'https://relay.example/v1',apiKeys:[{id:'key-1',key:'fixture-api-key',enabled:true}],models:[{id:'model-a'}],enabled:true}],localClients:{ok:true,checkedAt:'2026-11-15T01:00:00Z',added:0,updated:0,warnings:[],accounts:[identity('chatgpt','present'),identity('claude','expired'),identity('gemini','record-only'),identity('copilot','unknown')],sources:[{id:'codex',clientId:'codex-cli',label:'Codex CLI · 工作配置',path:'/fixture/.codex/config.toml',status:'imported',providerId:'api-1'},{id:'claude',clientId:'claude-code',label:'Claude Code · 默认配置',path:'/fixture/.claude/settings.json',status:'linked',providerId:'api-1'},{id:'ignored',clientId:'gemini-cli',label:'Gemini CLI',path:'/fixture/.gemini/.env',status:'ignored',canRestore:true},{id:'gateway',clientId:'claude-code',label:'Cloud bridge loopback',path:'/fixture/.claude/gateway.json',status:'ignored'}]}};
              window.aurora={invoke:async(action,payload)=>{
                window.calls.push({action,payload});
                if(action==='localClients.scan'){if(window.failScan)throw new Error('本机扫描暂时失败');return structuredClone(window.fixture.localClients);}
                if(action==='localClients.restore'){if(payload.sourceId!=='ignored')throw new Error('Unexpected source');window.fixture.localClients.sources[2].status='imported';return structuredClone(window.fixture.localClients);}
                throw new Error('Unexpected action '+action);
              }};
            }""")
            page.add_script_tag(path=bundle)
            expect(page.get_by_role('heading', name='我的供应商')).to_be_visible()
            expect(page.locator('.provider-card')).to_have_count(1)
            expect(page.locator('.local-identity-card')).to_have_count(4)
            assert 'fixture-api-key' not in page.inner_text('body')
            assert page.locator('.local-identity-card').get_by_role('switch').count() == 0
            checks.append('Official identities stay separate from routable API supplier cards and keys')

            expect(page.locator('.provider-origin')).to_contain_text('Codex CLI · 工作配置')
            expect(page.locator('.provider-origin')).to_contain_text('Claude Code · 默认配置')
            checks.append('One API supplier displays both discovered client sources')

            for status in ['已检测到凭据', '凭据已过期', '仅有登录记录', '状态待确认']:
                expect(page.get_by_text(status, exact=True)).to_be_visible()
            assert '订阅有效' not in page.inner_text('body')
            checks.append('Present, expired, record-only and unknown credentials are not subscription assertions')

            page.get_by_role('button', name='重新扫描本机', exact=True).click()
            page.wait_for_function('window.reloads===1')
            assert page.evaluate('window.calls[0].action') == 'localClients.scan'
            page.locator('.local-scan-details > summary').click()
            expect(page.get_by_role('button', name='重新导入此来源', exact=True)).to_have_count(1)
            page.get_by_role('button', name='重新导入此来源', exact=True).click()
            page.wait_for_function('window.reloads===2')
            assert page.evaluate('window.calls[1]') == {'action': 'localClients.restore', 'payload': {'sourceId': 'ignored'}}
            expect(page.get_by_role('button', name='重新导入此来源', exact=True)).to_have_count(0)
            checks.append('Rescan and explicit ignored-source restore use the agreed actions and reload state')

            page.evaluate('window.failScan=true')
            page.get_by_role('button', name='重新扫描本机', exact=True).click()
            expect(page.get_by_role('alert')).to_have_text('本机扫描暂时失败')
            expect(page.locator('.provider-card')).to_have_count(1)
            expect(page.locator('.local-identity-card')).to_have_count(4)
            checks.append('A failed scan preserves visible account and supplier data')

            page.evaluate("window.renderPage('accounts')")
            expect(page.get_by_role('heading', name='本地账号')).to_be_visible()
            expect(page.locator('.local-identity-card')).to_have_count(4)
            page.get_by_role('button', name='管理官方与 API 连接', exact=True).click()
            assert page.evaluate('window.lastNavigation') == 'agents'
            assert '恢复原配置，再回到官方客户端登录' not in page.inner_text('body')
            checks.append('Account management links to client coexistence without removing official or API settings')

            page.set_viewport_size({'width': 390, 'height': 844})
            page.wait_for_timeout(100)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.evaluate("window.renderPage('providers')")
            expect(page.get_by_role('heading', name='我的供应商')).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Supplier page must fit a narrow viewport'
            page.evaluate("window.aurora=undefined;window.renderPage('accounts')")
            expect(page.get_by_role('button', name='重新扫描本机', exact=True)).to_be_disabled()
            assert not errors, errors
            checks.append('Remote account view remains read-only and fits a narrow viewport')
            browser.close()
            print(json.dumps({'passed': True, 'count': len(checks), 'checks': checks}, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
