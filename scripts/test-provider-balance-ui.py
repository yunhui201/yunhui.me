"""Isolated supplier-balance UI acceptance: no app, real profile or network access.

Requires Python Playwright + Chromium. Only compiles the tested React page into
a temporary directory; does not run the application's build or packaging steps.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

FIXTURE = """() => {
  window.calls=[];window.pending=[];window.reloads=0;window.holdBalance=false;window.failBalance='';
  window.hiddenFixture=false;
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.hiddenFixture});
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.hiddenFixture?'hidden':'visible'});
  window.originalTime='2026-11-15T05:00:00.000Z';
  const key=(id,label)=>({id,label,key:'isolated-not-a-real-key-'+id,enabled:true,weight:1});
  window.state={settings:{autoSyncModels:false},presets:[],providers:[{
    id:'balance-fixture',name:'余额隔离验证',format:'openai-chat',baseUrl:'https://fixture.invalid/v1',
    enabled:true,models:[],priority:10,apiKeys:[key('zero','零余额'),key('debt','欠费账户'),key('plan','套餐'),key('unknown','未知余额')]
  }]};
  window.response={providerId:'balance-fixture',adapter:'sub2api',items:[
    {keyId:'zero',keyLabel:'零余额',status:'ok',entries:[{label:'人民币钱包',scope:'account',currency:'CNY',remaining:0}],updatedAt:window.originalTime,checkedAt:window.originalTime,cached:true},
    {keyId:'debt',keyLabel:'欠费账户',status:'ok',entries:[{label:'密钥额度',scope:'key',currency:'USD',remaining:-1.25,total:10,used:11.25}],updatedAt:window.originalTime,checkedAt:window.originalTime},
    {keyId:'plan',keyLabel:'套餐',status:'ok',entries:[
      {label:'每周套餐',scope:'subscription',currency:'USD',remaining:20,total:30,used:10},
      {label:'原始额度',scope:'key',currency:'POINTS',remaining:1250},
      {label:'单位缺失',scope:'key',currency:'UNKNOWN',remaining:8.75}
    ],updatedAt:window.originalTime,checkedAt:window.originalTime},
    {keyId:'unknown',keyLabel:'未知余额',status:'unsupported',entries:[],message:'供应商没有余额接口',checkedAt:window.originalTime}
  ]};
  window.aurora={invoke:async(action,payload)=>{
    window.calls.push({action,payload:structuredClone(payload)});
    if(action==='provider.balance'){
      const response=structuredClone(window.response);
      response.providerId=payload.providerId;
      if(payload.keyId)response.items=response.items.filter(item=>item.keyId===payload.keyId);
      if(window.holdBalance)return await new Promise((resolve,reject)=>window.pending.push({payload:structuredClone(payload),response,resolve,reject}));
      if(window.failBalance)throw Error(window.failBalance);
      return response;
    }
    if(action==='provider.save'){
      const index=window.state.providers.findIndex(provider=>provider.id===payload.id);
      if(index<0)throw Error('Unknown isolated supplier');
      window.state.providers[index]={...window.state.providers[index],...structuredClone(payload)};
      return structuredClone(window.state.providers[index]);
    }
    if(action==='provider.models')return {ok:true,added:0};
    if(action==='provider.delete'){window.state.providers=window.state.providers.filter(provider=>provider.id!==payload.id);return {ok:true};}
    throw Error('Unexpected RPC '+action);
  }};
}"""


def new_page(browser, bundle, setup=None, expand=True):
    page = browser.new_page(viewport={'width': 1380, 'height': 1100})
    errors, network = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/*', lambda route: (network.append(route.request.url), route.abort()))
    page.on('dialog', lambda dialog: dialog.accept())
    page.clock.install()
    page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
    for stylesheet in ['app.css', 'workspace.css']:
        page.add_style_tag(path=str(ROOT / 'ui/src/styles' / stylesheet))
    page.evaluate(FIXTURE)
    if setup:
        page.evaluate(setup)
    page.add_script_tag(path=str(bundle))
    if expand:
        expect(page.locator('.provider-balance-item[data-key-id="zero"]').first).to_be_visible()
        for details in page.locator('.balance-more').all():
            details.locator('summary').click()
    return page, errors, network


def balance_calls(page):
    return page.evaluate("window.calls.filter(call=>call.action==='provider.balance')")


def item(page, key):
    return page.locator(f'.provider-balance-item[data-key-id="{key}"]')


def assert_clean(errors, network):
    assert not errors, errors
    assert not network, 'The isolated component attempted a network request'


def run_cases(browser, bundle, screenshots=None):
    checks = []
    page, errors, network = new_page(browser, bundle, expand=False)
    try:
        expect(item(page, 'zero')).to_contain_text('CNY')
        expect(item(page, 'zero')).to_contain_text('账户余额')
        expect(item(page, 'zero').locator('.balance-amount')).to_have_text('0.00')
        expect(item(page, 'debt')).not_to_be_visible()
        expect(page.locator('.balance-more summary')).to_have_text('其他 3 个 Key 的余额')
        if screenshots:
            screenshots.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(screenshots / 'provider-balance-preview.png'), full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            page.screenshot(path=str(screenshots / 'provider-balance-preview-mobile.png'), full_page=True)
        page.locator('.balance-more summary').click()
        expect(item(page, 'debt')).to_be_visible()
        expect(item(page, 'debt')).to_contain_text('USD')
        expect(item(page, 'debt')).to_contain_text('密钥额度')
        expect(item(page, 'debt')).to_contain_text('-1.25')
        expect(item(page, 'plan')).to_contain_text('套餐额度')
        expect(item(page, 'plan')).to_contain_text('20')
        expect(item(page, 'plan')).to_contain_text('额度点数')
        expect(item(page, 'plan')).to_contain_text('单位未提供')
        expect(item(page, 'plan')).not_to_contain_text('POINTS')
        expect(item(page, 'plan')).not_to_contain_text('UNKNOWN')
        expect(item(page, 'unknown')).to_contain_text('—')
        expect(item(page, 'unknown')).to_contain_text('供应商没有余额接口')
        assert len(balance_calls(page)) == 1
        assert not balance_calls(page)[0]['payload'].get('force', False)
        checks.append('Initial query folds additional keys and keeps zero, negative, unknown, account, key and subscription values distinct')
        assert_clean(errors, network)
    finally:
        page.close()

    page, errors, network = new_page(browser, bundle)
    try:
        expect(item(page, 'zero')).to_be_visible()
        page.evaluate("""()=>{const value=window.response.items.find(item=>item.keyId==='zero');
          value.status='error';value.stale=true;value.cached=false;value.message='上游暂时不可用';
          value.checkedAt='2026-11-15T06:00:00.000Z';}""")
        page.get_by_title('刷新 零余额 余额', exact=True).click()
        expect(item(page, 'zero')).to_contain_text('上游暂时不可用')
        expect(item(page, 'zero')).to_contain_text('CNY')
        expect(item(page, 'zero').locator('.balance-amount')).to_have_text('0.00')
        expect(item(page, 'zero').locator('time')).to_have_attribute('datetime', '2026-11-15T05:00:00.000Z')
        expect(item(page, 'zero')).to_contain_text('刷新失败，显示上次成功的余额')
        assert balance_calls(page)[-1]['payload'] == {'providerId': 'balance-fixture', 'keyId': 'zero', 'force': True}
        expect(item(page, 'debt')).to_contain_text('-1.25')
        page.evaluate("""()=>{const value=window.response.items.find(item=>item.keyId==='zero');
          value.status='ok';value.stale=false;value.message='';value.entries[0].remaining=4.5;
          value.updatedAt='2026-11-15T06:00:00.000Z';}""")
        page.get_by_title('刷新 零余额 余额', exact=True).click()
        expect(item(page, 'zero')).to_contain_text('4.5')
        expect(item(page, 'zero')).not_to_contain_text('上游暂时不可用')
        expect(item(page, 'zero').locator('time')).to_have_attribute('datetime', '2026-11-15T06:00:00.000Z')
        expect(page.locator('.balance-more')).to_have_attribute('open', '')
        expect(page.locator('.provider-balance-item').first).to_have_attribute('data-key-id', 'zero')
        checks.append('A key-specific forced refresh preserves other keys and stale data through failure, then recovers')
        assert_clean(errors, network)
    finally:
        page.close()

    page, errors, network = new_page(browser, bundle)
    try:
        expect(item(page, 'zero')).to_be_visible()
        initial = len(balance_calls(page))
        page.evaluate("window.response.items[0].entries[0].remaining=8.75")
        page.clock.run_for(300000)
        expect(item(page, 'zero')).to_contain_text('8.75')
        assert len(balance_calls(page)) == initial + 1
        assert page.evaluate('window.reloads') == 0
        page.evaluate("window.hiddenFixture=true;document.dispatchEvent(new Event('visibilitychange'));window.response.items[0].entries[0].remaining=9.25")
        before = len(balance_calls(page))
        page.clock.run_for(600000)
        assert len(balance_calls(page)) == before
        expect(item(page, 'zero')).to_contain_text('8.75')
        page.evaluate("window.hiddenFixture=false;document.dispatchEvent(new Event('visibilitychange'))")
        expect(item(page, 'zero')).to_contain_text('9.25')
        assert len(balance_calls(page)) == before + 1
        checks.append('Visible five-minute polling and visibility restoration update balances without application-state reloads')
        assert_clean(errors, network)
    finally:
        page.close()

    page, errors, network = new_page(browser, bundle)
    try:
        expect(item(page, 'zero')).to_be_visible()
        page.evaluate('window.holdBalance=true')
        page.get_by_title('刷新 零余额 余额', exact=True).click()
        page.wait_for_function('window.pending.length===1')
        # Dispatching another click also exercises the handler guard, independently
        # of pointer timing or the button's disabled appearance.
        page.get_by_title('刷新 零余额 余额', exact=True).dispatch_event('click')
        assert page.evaluate('window.pending.length') == 1
        page.evaluate("""()=>{window.holdBalance=false;window.response.items[0].entries[0].remaining=42;
          window.state.providers[0].balanceQuery={adapter:'custom',url:'https://fixture.invalid/balance',balancePath:'balance',currency:'CNY'};
          window.renderProviders();}""")
        page.evaluate('window.pending[0].resolve(window.pending[0].response)')
        expect(item(page, 'zero')).to_contain_text('42')
        checks.append('Duplicate refreshes do not fan out, and changing balance configuration discards an older pending response')
        assert_clean(errors, network)
    finally:
        page.close()

    page, errors, network = new_page(browser, bundle)
    try:
        expect(item(page, 'zero')).to_be_visible()
        page.evaluate('window.holdBalance=true')
        page.get_by_title('刷新 零余额 余额', exact=True).click()
        page.wait_for_function('window.pending.length===1')
        page.get_by_title('删除供应商 余额隔离验证', exact=True).click()
        expect(page.locator('.provider-card')).to_have_count(0)
        page.evaluate('window.pending[0].resolve(window.pending[0].response)')
        expect(page.locator('.provider-balance')).to_have_count(0)
        assert page.evaluate("window.calls.filter(call=>call.action==='provider.delete').length") == 1
        checks.append('Deleting a supplier while its balance request is pending cannot restore the removed card')
        assert_clean(errors, network)
    finally:
        page.close()

    page, errors, network = new_page(browser, bundle)
    try:
        expect(item(page, 'zero')).to_be_visible()
        page.evaluate("window.failBalance='隔离模拟：连接中断'")
        page.get_by_title('刷新 零余额 余额', exact=True).click()
        expect(item(page, 'zero')).to_contain_text('隔离模拟：连接中断')
        expect(item(page, 'zero')).to_contain_text('刷新失败，显示上次成功的余额')
        expect(item(page, 'zero').locator('.balance-amount')).to_have_text('0.00')
        expect(item(page, 'zero').locator('time')).to_have_attribute('datetime', '2026-11-15T05:00:00.000Z')
        expect(item(page, 'debt')).not_to_contain_text('连接中断')
        page.evaluate("window.failBalance='';window.response.items[0].entries[0].remaining=12.5")
        page.get_by_title('刷新 零余额 余额', exact=True).click()
        expect(item(page, 'zero')).to_contain_text('12.50')
        expect(item(page, 'zero')).not_to_contain_text('连接中断')
        checks.append('RPC rejection preserves the last successful value and timestamp only for the refreshed key, then recovers')
        assert_clean(errors, network)
    finally:
        page.close()

    setup = """()=>{const original=window.state.providers[0];window.state.providers.push(
      {...structuredClone(original),id:'second-fixture',name:'第二供应商'},
      {...structuredClone(original),id:'disabled-fixture',name:'停用供应商',enabled:false},
      {...structuredClone(original),id:'no-query-fixture',name:'关闭查询供应商',balanceQuery:{adapter:'disabled'}}
    );}"""
    page, errors, network = new_page(browser, bundle, setup)
    try:
        expect(page.locator('.provider-balance-item[data-key-id="zero"]')).to_have_count(2)
        assert {call['payload']['providerId'] for call in balance_calls(page)} == {'balance-fixture', 'second-fixture'}
        expect(page.get_by_role('region', name='停用供应商 余额与额度')).to_contain_text('供应商已停用')
        expect(page.get_by_role('region', name='关闭查询供应商 余额与额度')).to_contain_text('已关闭余额查询')
        before = len(balance_calls(page))
        page.evaluate('window.holdBalance=true')
        page.get_by_role('button', name='刷新全部余额', exact=True).click()
        page.wait_for_function('window.pending.length===2')
        expect(page.get_by_role('button', name='正在刷新余额…', exact=True)).to_be_disabled()
        page.get_by_role('button', name='正在刷新余额…', exact=True).dispatch_event('click')
        assert page.evaluate('window.pending.length') == 2
        forced = balance_calls(page)[before:]
        assert len(forced) == 2 and all(call['payload'].get('force') for call in forced)
        assert {call['payload']['providerId'] for call in forced} == {'balance-fixture', 'second-fixture'}
        page.evaluate('window.holdBalance=false;window.pending.forEach(request=>request.resolve(request.response))')
        expect(page.get_by_role('button', name='刷新全部余额', exact=True)).to_be_enabled()
        page.clock.run_for(300000)
        assert len(balance_calls(page)) == before + 4
        assert all(call['payload']['providerId'] in {'balance-fixture', 'second-fixture'} for call in balance_calls(page))
        assert page.evaluate('window.reloads') == 0
        checks.append('Batch refresh and polling skip disabled suppliers and disabled queries, with one in-flight batch')
        assert_clean(errors, network)
    finally:
        page.close()

    page, errors, network = new_page(browser, bundle)
    try:
        expect(item(page, 'zero')).to_be_visible()
        page.locator('.provider-card').get_by_role('button', name='编辑', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.locator('.balance-query-editor summary').click()
        dialog.get_by_label('余额查询方式', exact=True).select_option('custom')
        save = dialog.get_by_role('button', name='保存', exact=True)
        expect(save).to_be_disabled()
        dialog.get_by_label('余额查询地址', exact=True).fill('https://fixture.invalid/account/balance')
        dialog.get_by_label('总额字段路径', exact=True).fill('data.total')
        dialog.get_by_label('已用字段路径', exact=True).fill('data.used')
        expect(save).to_be_enabled()
        dialog.get_by_label('余额查询地址', exact=True).fill('https://query.fixture.invalid/balance')
        expect(save).to_be_disabled()
        expect(dialog.get_by_role('alert')).to_contain_text('必须与供应商接口同源')
        dialog.get_by_label('余额查询认证', exact=True).select_option('token')
        expect(save).to_be_disabled()
        dialog.get_by_label('独立查询 Token', exact=True).fill('isolated-query-token-not-a-real-secret')
        dialog.get_by_label('余额请求方式', exact=True).select_option('POST')
        dialog.get_by_label('余额请求正文', exact=True).fill('{broken')
        expect(save).to_be_disabled()
        dialog.get_by_label('余额请求正文', exact=True).fill('{"account":"fixture"}')
        dialog.get_by_label('余额附加请求头', exact=True).fill('{"X-Query":3}')
        expect(save).to_be_disabled()
        dialog.get_by_label('余额附加请求头', exact=True).fill('{"X-Query":"fixture"}')
        dialog.get_by_label('余额认证请求头', exact=True).fill('X-Balance-Token')
        dialog.get_by_label('余额认证格式', exact=True).select_option('raw')
        dialog.get_by_label('查询结果含义', exact=True).select_option('key')
        dialog.get_by_label('余额币种', exact=True).fill('CNY')
        dialog.get_by_label('余额换算倍率', exact=True).fill('0.01')
        expect(save).to_be_enabled()
        save.click()
        expect(dialog).not_to_be_visible()
        payloads = page.evaluate("window.calls.filter(call=>call.action==='provider.save').map(call=>call.payload)")
        assert len(payloads) == 1
        saved = payloads[0]
        assert saved['baseUrl'] == 'https://fixture.invalid/v1'
        assert saved['balanceQuery'] == {
            'adapter': 'custom', 'url': 'https://query.fixture.invalid/balance',
            'totalPath': 'data.total', 'usedPath': 'data.used', 'auth': 'token',
            'token': 'isolated-query-token-not-a-real-secret', 'method': 'POST',
            'body': '{"account":"fixture"}', 'headers': {'X-Query': 'fixture'},
            'authHeader': 'X-Balance-Token', 'authScheme': 'raw', 'scope': 'key',
            'currency': 'CNY', 'multiplier': 0.01,
        }, saved['balanceQuery']
        checks.append('Custom query validation blocks invalid or cross-origin key settings and saves dedicated credentials, static POST body, scope, paths and conversion')
        assert_clean(errors, network)
    finally:
        page.close()
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots-dir', type=Path, help='Optional directory for isolated fixture screenshots')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='yunhui-balance-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Providers from './ui/src/pages/Providers.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderProviders=()=>root.render(<ToastHost><Providers state={structuredClone(window.state)} reload={async()=>{window.reloads++;window.renderProviders();}} go={()=>{}}/></ToastHost>);
window.renderProviders();"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle),
                   'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                checks = run_cases(browser, bundle, args.screenshots_dir)
                for check in checks:
                    print('PASS', check, flush=True)
                print(json.dumps({'passed': True, 'checks': checks, 'scope': 'Isolated temporary React page, mocked RPC and all network blocked'}, ensure_ascii=False))
            finally:
                browser.close()


if __name__ == '__main__':
    main()
