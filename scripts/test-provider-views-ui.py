"""Provider layouts and truthful balance filters, isolated React + mocked IPC only."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://provider-ui.test/'

FIXTURE = """() => {
  window.generation=0;window.calls=[];window.failBalance={};window.modelFailure='';
  const key=(id,label=id)=>({id,label,key:'isolated-fixture-'+id,enabled:true,weight:1});
  const provider=(id,name,format='openai-chat',patch={})=>({id,name,format,baseUrl:'https://fixture.invalid/'+id+'/v1',enabled:true,models:[],apiKeys:[key(id)],...patch});
  const entry=(remaining,currency='USD',scope='account',label='账户余额')=>({remaining,currency,scope,label});
  const item=(id,entries,status='ok',patch={})=>({keyId:id,keyLabel:id,status,entries,updatedAt:'2026-11-15T05:00:00.000Z',...patch});
  window.state={settings:{autoSyncModels:false},presets:[],providers:[
    provider('mixed','多账号供应商','openai-chat',{apiKeys:[key('zero','主账号'),key('positive','备用账号'),key('missing-value','未提供数值')],models:[{id:'focus-model-v1',contextWindow:128000}]}),
    provider('negative','负余额供应商','anthropic'),
    provider('stale','刷新失败有旧余额','gemini'),
    provider('failed','首次查询失败','openai-responses'),
    provider('unknown','不支持余额查询'),
    provider('unlimited','不限额供应商'),
    provider('paused','主动关闭查询','openai-chat',{balanceQuery:{adapter:'disabled'}}),
    provider('disabled','已停用供应商','anthropic',{enabled:false}),
    provider('missing','尚未填写密钥','openai-chat',{apiKeys:[{...key('missing'),key:''}]}),
    provider('partial','部分账号尚未返回','openai-chat',{apiKeys:[key('partial-one'),key('partial-two')]}),
    provider('empty','接口未返回数值')
  ]};
  window.responses={
    mixed:[item('zero',[entry(0,'CNY'),entry(12,'USD','subscription','月套餐')],'ok',{keyLabel:'主账号'}),item('positive',[entry(23.5)],'ok',{keyLabel:'备用账号'}),item('missing-value',[entry(undefined,'UNKNOWN')],'ok',{keyLabel:'未提供数值'})],
    negative:[item('negative',[entry(-3)])],
    stale:[item('stale',[entry(0)],'error',{stale:true,message:'余额接口暂时超时'})],
    unknown:[item('unknown',[],'unsupported',{message:'未提供余额接口'})],
    unlimited:[item('unlimited',[{...entry(0),unlimited:true}])],
    partial:[item('partial-one',[entry(20)])],empty:[item('empty',[])]
  };
  window.failBalance.failed='余额查询连接中断';
  window.aurora={invoke:async(action,payload)=>{
    window.calls.push({action,payload:structuredClone(payload)});
    if(action==='provider.balance'){
      if(window.failBalance[payload.providerId])throw Error(window.failBalance[payload.providerId]);
      const items=structuredClone(window.responses[payload.providerId]||[]);
      return {providerId:payload.providerId,adapter:'custom',items:payload.keyId?items.filter(item=>item.keyId===payload.keyId):items};
    }
    if(action==='provider.models'){if(window.modelFailure)throw Error(window.modelFailure);return {ok:true,added:0};}
    if(action==='provider.test')return {ok:true,latencyMs:12,message:'隔离测试连接成功'};
    if(action==='provider.save'){
      const index=window.state.providers.findIndex(provider=>provider.id===payload.id);
      window.state.providers[index]={...window.state.providers[index],...structuredClone(payload)};
      return structuredClone(window.state.providers[index]);
    }
    if(action==='provider.delete'){window.state.providers=window.state.providers.filter(provider=>provider.id!==payload.id);return {ok:true};}
    throw Error('Unexpected isolated RPC '+action);
  }};
}"""


def initialize(page, bundle, setup=None):
    # Page-local CSS is imported through App before main.tsx imports the shared styles.
    page.add_style_tag(path=str(bundle.with_suffix('.css')))
    for style in ['app.css', 'workspace.css']:
        page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
    page.evaluate(FIXTURE)
    if setup:
        page.evaluate(setup)
    page.add_script_tag(path=str(bundle))
    page.wait_for_function("window.calls.filter(call=>call.action==='provider.balance').length===8")
    expect(page.get_by_role('button', name='刷新全部余额', exact=True)).to_be_enabled()


def card(page, provider_id):
    return page.locator(f'.provider-card[data-provider-id="{provider_id}"]')


def assert_ids(page, expected):
    expect(page.locator('.provider-card')).to_have_count(len(expected))
    actual = page.locator('.provider-card').evaluate_all('(cards)=>cards.map(card=>card.dataset.providerId).sort()')
    assert actual == sorted(expected), (actual, expected)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--screenshots', type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    checks, errors, network = [], [], []
    with tempfile.TemporaryDirectory(prefix='yunhui-provider-views-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Providers from './ui/src/pages/Providers.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderProviders=()=>root.render(<ToastHost key={window.generation}><Providers state={structuredClone(window.state)} reload={async()=>window.renderProviders()} go={()=>{}}/></ToastHost>);
window.renderProviders();"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle),
                   'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)

            def new_page(setup=None):
                page = browser.new_page(viewport={'width': 1380, 'height': 1000})
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('dialog', lambda dialog: dialog.accept())
                def route(request):
                    if request.request.url == ORIGIN:
                        request.fulfill(status=200, content_type='text/html', body='<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
                    else:
                        network.append(request.request.url)
                        request.abort()
                page.route('**/*', route)
                page.goto(ORIGIN)
                initialize(page, bundle, setup)
                return page

            def passed(label):
                checks.append(label)
                print('PASS', label, flush=True)

            page = new_page()
            expect(page.get_by_role('button', name='卡片', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert_ids(page, ['mixed', 'negative', 'stale', 'failed', 'unknown', 'unlimited', 'paused', 'disabled', 'missing', 'partial', 'empty'])
            grid_height = card(page, 'mixed').bounding_box()['height']
            page.get_by_role('button', name='紧凑列表', exact=True).focus()
            page.keyboard.press('Enter')
            expect(page.get_by_role('button', name='紧凑列表', exact=True)).to_have_attribute('aria-pressed', 'true')
            assert card(page, 'mixed').bounding_box()['height'] < grid_height - 100
            assert page.evaluate("localStorage.getItem('aurora.providers.view')") == 'list'
            page.reload()
            initialize(page, bundle)
            expect(page.get_by_role('button', name='紧凑列表', exact=True)).to_have_attribute('aria-pressed', 'true')
            page.get_by_role('button', name='卡片', exact=True).focus()
            page.keyboard.press('Space')
            expect(page.get_by_role('button', name='卡片', exact=True)).to_have_attribute('aria-pressed', 'true')
            page.get_by_role('button', name='紧凑列表', exact=True).click()
            passed('Grid default, denser compact rows, keyboard switching and persisted preference survive reload')

            balance_filter = page.get_by_role('combobox', name='供应商余额状态', exact=True)
            for state, ids in [
                ('failed', ['stale', 'failed']),
                ('unknown', ['mixed', 'stale', 'failed', 'unknown', 'missing', 'partial', 'empty']),
                ('nonpositive', ['mixed', 'negative']),
                ('paused', ['paused', 'disabled']),
            ]:
                balance_filter.select_option(state)
                assert_ids(page, ids)
            passed('Failed, unknown, zero/negative and paused filters distinguish stale, unlimited, missing and partial results')

            balance_filter.select_option('unknown')
            page.get_by_role('combobox', name='供应商协议', exact=True).select_option('openai-chat')
            page.get_by_role('combobox', name='供应商启用状态', exact=True).select_option('enabled')
            page.get_by_role('textbox', name='搜索供应商或本地账号', exact=True).fill('focus-model')
            assert_ids(page, ['mixed'])
            page.get_by_role('combobox', name='供应商启用状态', exact=True).select_option('disabled')
            assert_ids(page, [])
            expect(page.get_by_text('没有匹配的供应商', exact=True)).to_be_visible()
            page.get_by_role('button', name='清除筛选', exact=True).click()
            expect(page.locator('.provider-card')).to_have_count(11)
            page.get_by_role('combobox', name='供应商启用状态', exact=True).select_option('disabled')
            assert_ids(page, ['disabled'])
            page.get_by_role('button', name='清除筛选', exact=True).click()
            passed('Search, protocol, enablement and balance filters combine, empty results explain recovery and clear resets all')

            mixed = card(page, 'mixed')
            summary = mixed.get_by_label('多账号供应商 余额摘要', exact=True)
            expect(summary).to_contain_text('存在零或负余额')
            expect(summary).to_contain_text('有余额未知')
            expect(summary).to_contain_text('0 CNY')
            expect(summary).to_contain_text('12 USD')
            assert '耗尽' not in mixed.inner_text()
            expect(mixed.get_by_role('region', name='多账号供应商 余额与额度', exact=True)).not_to_be_visible()
            detail_toggle = mixed.get_by_label('查看 多账号供应商 的模型与各 Key 余额', exact=True)
            detail_toggle.focus()
            page.keyboard.press('Enter')
            expect(mixed.get_by_text('focus-model-v1', exact=False)).to_be_visible()
            expect(mixed.locator('.provider-balance-item[data-key-id="zero"]')).to_be_visible()
            mixed.locator('.balance-more > summary').click()
            expect(mixed.locator('.provider-balance-item[data-key-id="positive"]')).to_contain_text('23.50')
            expect(mixed.locator('.provider-balance-item[data-key-id="missing-value"]')).to_contain_text('单位未提供')
            passed('Compact summary preserves separate currencies and mixed states; keyboard expansion exposes model and all key details')

            page.evaluate("window.failBalance.mixed='本次单 Key 查询失败'")
            mixed.get_by_title('刷新 主账号 余额', exact=True).click()
            expect(summary).to_contain_text('有查询失败')
            expect(summary).to_contain_text('上次成功结果')
            expect(summary).not_to_contain_text('存在零或负余额')
            balance_filter.select_option('nonpositive')
            assert_ids(page, ['negative'])
            page.get_by_role('button', name='清除筛选', exact=True).click()
            page.evaluate("delete window.failBalance.mixed")
            page.get_by_role('button', name='刷新全部余额', exact=True).click()
            expect(mixed.get_by_label('多账号供应商 余额摘要', exact=True)).to_contain_text('存在零或负余额')
            expect(mixed.get_by_label('多账号供应商 余额摘要', exact=True)).not_to_contain_text('有查询失败')
            passed('Per-key refresh failure retains labelled old values without treating stale zero as a current zero, then recovers')

            page.evaluate("window.modelFailure='模型接口临时不可用'")
            mixed.get_by_role('button', name='同步模型', exact=True).click()
            expect(mixed.get_by_role('alert')).to_contain_text('模型接口临时不可用')
            expect(mixed.locator('.provider-list-details')).not_to_have_attribute('open', '')
            mixed.get_by_role('button', name='手动添加模型', exact=True).click()
            dialog = page.get_by_role('dialog', name='编辑供应商', exact=True)
            expect(dialog).to_be_visible()
            dialog.get_by_role('button', name='取消', exact=True).click()
            page.evaluate("window.modelFailure=''")
            mixed.get_by_role('button', name='同步模型', exact=True).click()
            expect(mixed.get_by_role('alert')).to_have_count(0)
            mixed.get_by_role('button', name='测试', exact=True).click()
            expect(mixed.get_by_text('隔离测试连接成功', exact=True)).to_be_visible()
            negative = card(page, 'negative')
            negative.get_by_role('switch', name='启用供应商 负余额供应商', exact=True).click()
            expect(negative.get_by_role('switch')).to_have_attribute('aria-checked', 'false')
            expect(negative.get_by_label('负余额供应商 余额摘要', exact=True)).to_contain_text('供应商已停用')
            card(page, 'disabled').get_by_role('button', name='删除供应商 已停用供应商', exact=True).click()
            expect(card(page, 'disabled')).to_have_count(0)
            passed('Compact rows retain visible sync failures, manual model editing, retry, connection test, enablement and deletion')

            page.evaluate("document.documentElement.dataset.theme='dark'")
            if args.screenshots:
                page.evaluate('window.scrollTo(0, 0)')
                page.screenshot(path=str(args.screenshots / 'providers-list-dark.png'), animations='disabled')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.evaluate("window.state.providers[0].name='超长供应商名称用于检查手机布局不会横向溢出';window.renderProviders()")
            mixed.locator('.provider-list-details > summary').click()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Narrow page overflow'
            for button in mixed.locator('.provider-actions button').all():
                bounds = button.bounding_box()
                assert bounds and bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 390, bounds
            expect(mixed.locator('.provider-balance')).to_be_visible()
            if args.screenshots:
                mixed.screenshot(path=str(args.screenshots / 'providers-list-narrow-dark.png'), animations='disabled')
            passed('Dark narrow viewport keeps expanded balances and every action within the viewport, including long provider names')

            for setup in [
                "()=>{Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Denied','SecurityError')}})}",
                "()=>{Storage.prototype.setItem=function(){throw new DOMException('Full','QuotaExceededError')}}",
                "()=>{localStorage.setItem('aurora.providers.view','invalid-old-value')}",
            ]:
                storage_page = new_page(setup)
                expect(storage_page.get_by_role('button', name='卡片', exact=True)).to_have_attribute('aria-pressed', 'true')
                storage_page.get_by_role('button', name='紧凑列表', exact=True).click()
                expect(storage_page.get_by_role('button', name='紧凑列表', exact=True)).to_have_attribute('aria-pressed', 'true')
                storage_page.close()
            passed('Denied reads, denied writes and invalid saved preferences never prevent page rendering or layout switching')
            assert not errors, errors
            assert not network, network
            browser.close()
    print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors, 'unexpectedNetwork': network}, ensure_ascii=False))


if __name__ == '__main__':
    main()
