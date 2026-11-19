"""Saved client connection overview: real React with mocked IPC and usage events, no network or tracked reports."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = """()=>{
  window.calls=[];window.navigation=[];window.configurations=[];window.generation=0;window.listeners=new Set();window.pendingUsage=[];
  window.holdUsage=false;window.usageError='';window.balanceError='';window.now=Date.now();window.iso=offset=>new Date(window.now+offset).toISOString();
  const agent=(id,name)=>({id,name,vendor:'Fixture',protocol:'openai-responses',support:'automatic',category:id.endsWith('cli')?'cli':'desktop'});
  const connection=id=>({id,connected:true,providerId:'supplier',model:'fixture-model',mode:'gateway',authMode:'api',configPath:'C:/Fixture/'+(id==='claude-code'?'claude.json':'codex.toml'),lastSyncAt:window.iso(-3600000)});
  window.state={settings:{proxy:'',logRequests:true},gateway:{running:true},providers:[{id:'supplier',name:'测试模型供应商',enabled:true,format:'openai-responses',baseUrl:'https://fixture.invalid/v1',updatedAt:window.iso(-3600000),models:[{id:'fixture-model'}],apiKeys:[{id:'key',label:'主账户',key:'fake-ui-key',enabled:true,weight:1}]}],
    agentCatalog:[agent('claude-code','Claude Code'),agent('codex-cli','Codex CLI'),agent('chatgpt-desktop','ChatGPT 桌面版')],
    agents:Object.fromEntries(['claude-code','codex-cli','chatgpt-desktop'].map(id=>[id,connection(id)])),codexCoexist:{identity:{available:true}}};
  window.record=(id,agent,offset,status=200,patch={})=>({requestId:id,agent,ts:window.iso(offset),providerId:'supplier',providerName:'测试模型供应商',model:'fixture-model',requestModel:'supplier/fixture-model',protocol:'openai-responses',stream:true,status,inputTokens:3,outputTokens:1,latencyMs:20,cost:0,...patch});
  window.usage=[window.record('claude-success','Claude Code',-120000),window.record('codex-success','Codex',-90000)];
  window.balance={providerId:'supplier',adapter:'custom',items:[{keyId:'key',keyLabel:'主账户',status:'ok',entries:[{label:'账户余额',scope:'account',currency:'CNY',remaining:0}],updatedAt:window.iso(-300000),checkedAt:window.iso(-300000)}]};
  window.emit=record=>window.listeners.forEach(listener=>listener(structuredClone(record)));
  window.aurora={invoke:async(action,payload={})=>{window.calls.push({action,payload:structuredClone(payload)});
    if(action==='usage.recent'){
      const snapshot=structuredClone(window.usage);
      if(window.holdUsage)return await new Promise((resolve,reject)=>window.pendingUsage.push({snapshot,resolve,reject}));
      if(window.usageError)throw Error(window.usageError);
      return snapshot;
    }
    if(action==='provider.balance'){if(window.balanceError)throw Error(window.balanceError);return {...structuredClone(window.balance),providerId:payload.providerId};}
    throw Error('Unexpected action '+action);
  },onUsage:listener=>{window.listeners.add(listener);return ()=>window.listeners.delete(listener);}};
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--screenshots', type=Path)
    arguments = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='yunhui-client-connections-ui-') as temporary:
        bundle = Path(temporary) / 'overview.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import ClientConnectionOverview from './ui/src/components/ClientConnectionOverview.tsx';import {ToastHost} from './ui/src/components/ui.tsx';import {fmtTime} from './ui/src/lib/api.ts';
const root=createRoot(document.getElementById('root'));
window.formatConnectionTime=fmtTime;
window.renderOverview=()=>root.render(<ToastHost><ClientConnectionOverview key={window.generation} state={structuredClone(window.state)} go={page=>window.navigation.push(page)} onConfigure={agent=>window.configurations.push(agent.id)}/></ToastHost>);
window.renderOverview();"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            checks, pages = [], []

            def new_page(setup=None):
                page = browser.new_page(viewport={'width': 1250, 'height': 1000})
                errors, network = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.route('**/*', lambda route: (network.append(route.request.url), route.abort()))
                page.set_default_timeout(4000)
                page.clock.install()
                page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
                for stylesheet in ['app.css', 'workspace.css', 'providers.css', 'client-connections.css']:
                    page.add_style_tag(path=str(ROOT / 'ui/src/styles' / stylesheet))
                page.evaluate(FIXTURE)
                if setup:
                    page.evaluate(setup)
                page.add_script_tag(path=str(bundle))
                pages.append((page, errors, network))
                return page

            def row(page, client='Claude Code'):
                return page.get_by_role('article', name=client + ' 当前连接', exact=True)

            def shared(page):
                return row(page, 'Codex CLI / ChatGPT 桌面版')

            def balance_summary(page):
                return row(page).get_by_label('测试模型供应商 当前余额', exact=True)

            def details(page, client='Claude Code'):
                return row(page, client).locator('details.connection-details')

            def open_details(page, client='Claude Code'):
                panel = details(page, client)
                if panel.get_attribute('open') is None:
                    panel.locator('summary').click()
                expect(panel).to_have_attribute('open', '')
                return panel

            def calls(page, action):
                return page.evaluate('(action)=>window.calls.filter(call=>call.action===action)', action)

            def ready(page):
                expect(page.get_by_role('button', name='刷新连接状态', exact=True)).to_be_enabled()

            page = new_page()
            ready(page)
            expect(page.get_by_role('region', name='当前客户端连接', exact=True)).to_be_visible()
            expect(page.locator('.client-connection-row')).to_have_count(2)
            expect(row(page).locator('.connection-route > strong')).to_have_text('Claude Code')
            expect(row(page).locator('.connection-route b')).to_have_text('测试模型供应商')
            expect(row(page).locator('.connection-route code')).to_have_text('fixture-model')
            expect(row(page).get_by_text('Claude 请求成功 · 待客户端核验', exact=True)).to_be_visible()
            expect(row(page).locator('time').first).to_have_attribute('datetime', page.evaluate('window.usage[0].ts'))
            expect(balance_summary(page).locator('strong')).to_have_text(re.compile(r'^0\s*CNY$'))
            expect(balance_summary(page).locator('strong')).to_be_visible()
            expect(details(page)).not_to_have_attribute('open', '')
            expect(details(page, 'Codex CLI / ChatGPT 桌面版')).not_to_have_attribute('open', '')
            expect(shared(page).get_by_text('共享编程配置已有成功请求，记录不区分桌面端、CLI 或共存入口；请在原客户端核对。', exact=True)).not_to_be_visible()
            expect(row(page).get_by_text('余额更新时间：', exact=False)).not_to_be_visible()
            expect(row(page).get_by_role('button', name='配置与测试', exact=True)).to_be_visible()
            expect(row(page).get_by_role('button', name='查看请求', exact=True)).to_be_visible()
            assert len(calls(page, 'provider.balance')) == 1
            if arguments.screenshots:
                arguments.screenshots.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(arguments.screenshots / 'client-connections-summary.png'), full_page=True)
            open_details(page, 'Codex CLI / ChatGPT 桌面版')
            expect(shared(page).get_by_text('共享编程配置已有成功请求，记录不区分桌面端、CLI 或共存入口；请在原客户端核对。', exact=True)).to_be_visible()
            panel = open_details(page)
            expect(panel.get_by_label('测试模型供应商 余额摘要', exact=True)).to_contain_text('存在零或负余额')
            expect(panel.locator('.provider-balance-preview strong')).to_have_text('0 CNY')
            expect(panel.get_by_text('余额更新时间：', exact=False)).to_be_visible()
            panel.locator('summary').click()
            expect(panel).not_to_have_attribute('open', '')
            expect(panel.locator('.provider-balance-preview strong')).not_to_be_visible()
            open_details(page)
            assert len(calls(page, 'provider.balance')) == 1, 'Expanding details must reuse the balance already fetched'
            checks.append('Compact overview retains route, status and quick actions; details start collapsed and reveal exact balance and shared-client limits without refetching')

            shared(page).get_by_role('button', name='配置与测试', exact=True).click()
            row(page).get_by_role('button', name='配置与测试', exact=True).click()
            row(page).get_by_role('button', name='查看请求', exact=True).click()
            row(page).get_by_role('button', name='余额详情与供应商设置 →', exact=True).click()
            assert page.evaluate('window.configurations') == ['chatgpt-desktop', 'claude-code']
            assert page.evaluate('window.navigation') == ['usage', 'providers']
            page.evaluate('window.state.gateway.running=false;window.renderOverview()')
            expect(row(page).get_by_text('本地网关已停止', exact=True)).to_be_visible()
            row(page).get_by_role('button', name='打开网关设置', exact=True).click()
            assert page.evaluate('window.navigation.at(-1)') == 'settings'
            checks.append('Configuration, usage, supplier and stopped-gateway buttons invoke their intended callbacks')

            for value, shown in [(-2.5, '-2.5'), (-0.001, '-0.001')]:
                page = new_page(f'window.balance.items[0].entries[0].remaining={value};')
                ready(page)
                expect(balance_summary(page).locator('strong')).to_have_text(re.compile(r'^' + re.escape(shown) + r'\s*CNY$'))
                expect(balance_summary(page)).to_contain_text('存在零或负余额')
                expect(details(page)).not_to_have_attribute('open', '')
            page = new_page('window.balance.items[0].entries=[];')
            ready(page)
            expect(balance_summary(page).get_by_text('余额未知', exact=True)).to_be_visible()
            page = new_page('window.balance.items[0].entries[0]={label:"套餐额度",scope:"subscription",currency:"USD",unlimited:true};')
            ready(page)
            expect(balance_summary(page).get_by_text('不限额', exact=True)).to_be_visible()
            expect(balance_summary(page)).not_to_contain_text('存在零或负余额')
            page = new_page("window.balance.items.push({keyId:'other',keyLabel:'备用账户',status:'ok',entries:[{label:'密钥额度',scope:'key',currency:'USD',remaining:20}],updatedAt:window.iso(-200000),checkedAt:window.iso(-200000)});")
            ready(page)
            expect(balance_summary(page).get_by_text('首项额度', exact=True)).to_be_visible()
            expect(balance_summary(page).locator('strong')).to_have_text(re.compile(r'^0\s*CNY$'))
            expect(balance_summary(page)).to_contain_text('另 1 项')
            panel = open_details(page)
            expect(panel.locator('.provider-balance-preview strong')).to_have_text([re.compile(r'^0\s+CNY$'), re.compile(r'^20\s+USD$')])
            expect(panel).to_contain_text('各 Key 不合并计数')
            expect(panel.get_by_text('首项余额更新时间：', exact=False)).to_be_visible()
            checks.append('Summary distinguishes negative and tiny-negative balances, unknown and unlimited values; multiple keys/currencies show a first item rather than a false total')

            page = new_page("window.balance.items.unshift({keyId:'disabled',keyLabel:'已停用账户',status:'disabled',entries:[{label:'账户余额',scope:'account',currency:'CNY',remaining:999}],updatedAt:window.iso(-7200000)},{keyId:'empty',keyLabel:'空账户',status:'unknown',entries:[],updatedAt:window.iso(-3600000)});")
            ready(page)
            expect(balance_summary(page).locator('strong')).to_have_text(re.compile(r'^0\s*CNY$'))
            panel = open_details(page)
            expect(panel.get_by_text('余额更新时间：', exact=False)).to_have_text('余额更新时间：' + page.evaluate('window.formatConnectionTime(window.balance.items[2].updatedAt)'))
            expect(panel.locator('.provider-balance-preview strong')).to_have_text(re.compile(r'^0\s+CNY$'))

            page = new_page("delete window.balance.items[0].updatedAt;window.balance.items.push({keyId:'second',keyLabel:'第二账户',status:'ok',entries:[{label:'账户余额',scope:'account',currency:'USD',remaining:20}],updatedAt:window.iso(-200000)});")
            ready(page)
            expect(balance_summary(page).locator('strong')).to_have_text(re.compile(r'^0\s*CNY$'))
            panel = open_details(page)
            expect(panel.get_by_text('余额更新时间：', exact=False)).to_have_count(0)

            page = new_page('window.balance.items[0].status="disabled";')
            ready(page)
            expect(balance_summary(page).get_by_text('余额未知', exact=True)).to_be_visible()
            panel = open_details(page)
            expect(panel.get_by_text('余额更新时间：', exact=False)).to_have_count(0)
            expect(panel.locator('.provider-balance-preview')).to_have_count(0)

            for pause in ['window.state.providers[0].enabled=false;', "window.state.providers[0].balanceQuery={adapter:'disabled'};"]:
                page = new_page()
                ready(page)
                expect(balance_summary(page).locator('strong')).to_have_text(re.compile(r'^0\s*CNY$'))
                before = len(calls(page, 'provider.balance'))
                page.evaluate(pause + 'window.renderOverview();')
                expect(balance_summary(page).get_by_text('已暂停', exact=True)).to_be_visible()
                panel = open_details(page)
                expect(panel.get_by_text('余额更新时间：', exact=False)).to_have_count(0)
                expect(panel.locator('.provider-balance-preview')).to_have_count(0)
                assert len(calls(page, 'provider.balance')) == before
            checks.append('Balance timestamp belongs to the visible first item; disabled or empty entries cannot supply it, a missing timestamp is not borrowed, and paused balances hide old amounts and timestamps')

            page = new_page("window.usage=['云汇AI 工具箱','yunhui-connection-test','aurora','test-client',''].map((agent,index)=>window.record('tool-'+index,agent,-10000));")
            ready(page)
            expect(row(page).get_by_text('配置已保存 · 待验证', exact=True)).to_be_visible()
            expect(shared(page).get_by_text('配置已保存 · 待验证', exact=True)).to_be_visible()
            expect(page.locator('.connection-result time')).to_have_count(0)
            page.evaluate("window.emit(window.record('wrong-provider','Claude Code',-5000,200,{providerId:'other'}));window.emit(window.record('wrong-model','Codex',-4000,200,{model:'other'}))")
            expect(page.locator('.connection-result time')).to_have_count(0)
            checks.append('Toolbox tests, unknown client identities and mismatched suppliers/models cannot certify a real client connection')

            page = new_page("window.usage.unshift(window.record('latest-failure','Claude Code',-30000,401,{error:'PRIVATE-CREDENTIAL-MUST-NOT-RENDER'}))")
            ready(page)
            expect(row(page).get_by_text('最近请求失败', exact=True)).to_be_visible()
            expect(row(page)).to_contain_text('认证或权限被拒绝')
            expect(row(page).get_by_text('认证或权限被拒绝，请检查供应商密钥和模型权限。', exact=True)).to_be_visible()
            open_details(page)
            expect(row(page).locator('time')).to_have_count(2)
            expect(row(page).locator('time').first).to_have_attribute('datetime', page.evaluate("window.usage.find(record=>record.requestId==='claude-success').ts"))
            expect(row(page)).not_to_contain_text('PRIVATE-CREDENTIAL-MUST-NOT-RENDER')
            page.evaluate('window.state.providers[0].updatedAt=window.iso(-1000);window.renderOverview()')
            expect(row(page).get_by_text('配置已保存 · 待验证', exact=True)).to_be_visible()
            expect(row(page).locator('time')).to_have_count(0)
            expect(shared(page).locator('time')).to_have_count(0)
            page.evaluate("window.emit(window.record('after-config','Claude Code',-500))")
            expect(row(page).get_by_text('Claude 请求成功 · 待客户端核验', exact=True)).to_be_visible()
            expect(row(page).locator('time').first).to_have_attribute('datetime', page.evaluate('window.iso(-500)'))
            checks.append('A newer failure retains the earlier success time without revealing raw errors; supplier changes invalidate old evidence until a new client request arrives')

            page = new_page('window.holdUsage=true;')
            expect(page.get_by_role('button', name='刷新中…', exact=True)).to_be_disabled()
            assert len(calls(page, 'usage.recent')) == 1
            page.get_by_role('button', name='刷新中…', exact=True).evaluate('(button)=>{button.click();button.click();}')
            page.clock.run_for(16000)
            assert len(calls(page, 'usage.recent')) == 1
            page.evaluate("window.emit(window.record('live-new','Claude Code',-1000,429,{error:'PRIVATE-LIVE-ERROR'}))")
            expect(row(page).get_by_text('最近请求失败', exact=True)).to_be_visible()
            page.evaluate('window.holdUsage=false;window.pendingUsage.shift().resolve(window.usage)')
            ready(page)
            expect(row(page).get_by_text('最近请求失败', exact=True)).to_be_visible()
            open_details(page)
            expect(row(page).locator('time').last).to_have_attribute('datetime', page.evaluate('window.iso(-1000)'))
            page.evaluate("window.emit(window.record('live-new','Claude Code',-1000,200))")
            expect(row(page).get_by_text('Claude 请求成功 · 待客户端核验', exact=True)).to_be_visible()
            expect(row(page).locator('time')).to_have_count(1)
            checks.append('Duplicate refreshes are locked and a delayed snapshot cannot overwrite newer live usage, including an updated request ID')

            page = new_page("window.state.agents['claude-code'].mode='direct';")
            ready(page)
            expect(row(page).get_by_text('直连配置 · 待客户端验证', exact=True)).to_be_visible()
            open_details(page)
            expect(row(page)).to_contain_text('直连无法观测')
            expect(row(page).locator('time')).to_have_count(0)
            expect(shared(page).get_by_text('近期请求成功', exact=True)).to_be_visible()
            checks.append('Direct connections remain explicitly unobserved even when matching gateway history exists')

            page = new_page()
            ready(page)
            page.evaluate("window.balanceError='余额接口暂不可用';window.usageError='请求日志读取失败'")
            page.get_by_role('button', name='刷新连接状态', exact=True).click()
            ready(page)
            expect(page.get_by_role('alert')).to_contain_text('请求记录暂时无法更新')
            expect(row(page).get_by_text('Claude 请求成功 · 待客户端核验', exact=True)).to_be_visible()
            expect(balance_summary(page)).to_contain_text('上次成功结果')
            expect(balance_summary(page).locator('strong')).to_have_text(re.compile(r'^0\s*CNY$'))
            open_details(page)
            expect(row(page)).to_contain_text('有查询失败')
            expect(row(page)).to_contain_text('上次成功结果')
            expect(row(page).locator('.provider-balance-preview strong')).to_have_text('0 CNY')
            page.evaluate("window.balanceError='';window.usageError=''")
            page.get_by_role('button', name='刷新连接状态', exact=True).click()
            ready(page)
            expect(page.get_by_role('alert')).to_have_count(0)
            expect(row(page)).not_to_contain_text('有查询失败')
            checks.append('Balance and log refresh errors preserve last-known data without turning a successful connection into an access failure')

            page = new_page("window.state.agents={};")
            expect(page.get_by_role('region', name='当前客户端连接', exact=True)).to_have_count(0)
            page.clock.run_for(310000)
            assert page.evaluate('window.calls.length') == 0
            assert page.evaluate('window.listeners.size') == 0
            page.evaluate("window.state.agents['claude-code']={id:'claude-code',connected:true,providerId:'supplier',model:'fixture-model',mode:'gateway',lastSyncAt:window.iso(-3600000)};window.renderOverview()")
            ready(page)
            assert len(calls(page, 'usage.recent')) == 1 and len(calls(page, 'provider.balance')) == 1
            page.evaluate('window.state.agents={};window.renderOverview()')
            expect(page.get_by_role('region', name='当前客户端连接', exact=True)).to_have_count(0)
            before = len(page.evaluate('window.calls'))
            page.clock.run_for(310000)
            assert len(page.evaluate('window.calls')) == before
            assert page.evaluate('window.listeners.size') == 0
            checks.append('No saved connections means no usage or balance queries; removing the last connection unsubscribes live usage and stops queries')

            page = new_page("window.state.providers[0].name='国内供应商与很长的模型服务名称'.repeat(5);window.state.agents['claude-code'].model='very-long-model-id-'.repeat(12);")
            ready(page)
            for theme in ['light', 'dark']:
                page.evaluate('(theme)=>document.documentElement.dataset.theme=theme', theme)
                page.set_viewport_size({'width': 390, 'height': 844})
                expect(row(page).get_by_role('button', name='配置与测试', exact=True)).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'), 'Overview overflows the narrow viewport'
                if arguments.screenshots:
                    arguments.screenshots.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(arguments.screenshots / f'client-connections-{theme}-narrow.png'), full_page=True)
                panel = open_details(page)
                expect(panel.get_by_role('button', name='余额详情与供应商设置 →', exact=True)).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'), 'Expanded details overflow the narrow viewport'
                if arguments.screenshots:
                    page.screenshot(path=str(arguments.screenshots / f'client-connections-{theme}-narrow-details.png'), full_page=True)
                panel.locator('summary').click()
                expect(panel).not_to_have_attribute('open', '')
            checks.append('Long supplier/model labels and expanded details fit a narrow light and dark window without horizontal overflow')

            for page, errors, network in pages:
                assert not errors, errors
                assert not network, network
                page.close()
            browser.close()
            report = {'passed': True, 'count': len(checks), 'checks': checks, 'scope': 'Actual React overview with mocked IPC and usage events; no external network, real clients or tracked reports'}
            (Path(temporary) / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
