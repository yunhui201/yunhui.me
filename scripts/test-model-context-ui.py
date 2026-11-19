"""Provider model context editing with isolated React, mocked IPC and no network."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

FIXTURE = """() => {
window.generation=0;window.calls=[];window.nativePrompts=0;window.saveFailure='';window.modelFailure='';window.modelResponse=null;
window.seed={settings:{},presets:[],providers:[{id:'context-fixture',name:'上下文编辑验证',format:'openai-chat',baseUrl:'https://fixture.invalid/v1',enabled:true,apiKeys:[],models:[
  {id:'gpt-5.4',inputPrice:2.5,outputPrice:10,capabilities:{tools:true,vision:true}},
  {id:'gpt-5.4-codex',contextWindow:128000},
  {id:'openai/gpt-4.1',contextWindow:1047576},
  {id:'codex-mini-latest'},
  {id:'gpt-image-1'},
  {id:'gpt-audio'},
  {id:'gpt-4o-audio-preview',contextWindow:32000},
  {id:'claude-sonnet-4',contextWindow:200000},
  {id:'deepseek-chat'},
  {id:'qwen3.5-plus',contextWindow:128000},
  {id:'chatgpt-4o-latest'},
  {id:'gpt-oss-120b'},
  {id:'other/gpt-5.4'}
]}]};
window.state=structuredClone(window.seed);
window.resetFixture=()=>{window.generation++;window.calls=[];window.saveFailure='';window.modelFailure='';window.modelResponse=null;window.state=structuredClone(window.seed);window.renderProviders();};
window.prompt=()=>{window.nativePrompts++;throw Error('prompt() is and will not be supported.')};
window.alert=()=>{throw Error('Native alert must not be required')};
window.aurora={invoke:async(action,payload)=>{
 window.calls.push({action,payload:structuredClone(payload)});
 if(action==='provider.balance')return {providerId:payload.providerId,items:[]};
 if(action==='provider.save'){
   if(window.saveFailure)throw Error(window.saveFailure);
   const saved={...window.state.providers[0],...structuredClone(payload)};
   window.state.providers[0]=saved;
   return structuredClone(saved);
 }
 if(action==='provider.models'){
   if(window.modelFailure)throw Error(window.modelFailure);
   const response=structuredClone(window.modelResponse||{ok:true,models:window.state.providers[0].models,added:0});
   if(response.ok)window.state.providers[0].models=structuredClone(response.models);
   return response;
 }
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
    with tempfile.TemporaryDirectory(prefix='yunhui-model-context-ui-') as temporary:
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
            page = browser.new_page(viewport={'width': 1380, 'height': 1100})
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

            def open_editor(reset=True):
                if reset:
                    page.evaluate('window.resetFixture()')
                page.locator('.provider-card').get_by_role('button', name='编辑', exact=True).click()
                return page.get_by_role('dialog', name='编辑供应商', exact=True)

            def context(index):
                return page.get_by_role('textbox', name=f'第 {index + 1} 行上下文窗口', exact=True)

            def model_values():
                return page.locator('.model-row').evaluate_all("rows=>rows.map(row=>({id:row.querySelector('input').value,context:row.querySelector('.provider-context-cell input').value}))")

            dialog = open_editor(False)
            for index, value in {0: '272000', 1: '128000', 2: '1047576', 3: '272000', 4: '', 5: '', 6: '32000', 7: '200000', 8: '', 9: '128000', 10: '272000', 11: '', 12: ''}.items():
                expect(context(index)).to_have_value(value)
                expect(context(index)).to_be_editable()
            assert context(0).bounding_box()['width'] >= 140
            expect(dialog.get_by_text('推荐值不改变模型的真实能力', exact=False)).to_be_visible()
            expect(dialog.get_by_text('请到“客户端接入”重新预览并应用', exact=False)).to_be_visible()
            expect(dialog.get_by_text('应用时按上下文的 90% 同步自动压缩阈值', exact=False)).to_be_visible()
            expect(dialog.locator('#provider-compact-hint-0')).to_have_text('自动压缩：244800 tokens（90%）')
            expect(dialog.locator('#provider-compact-hint-7')).to_have_text('自动压缩：180000 tokens（90%）')
            expect(dialog.locator('#provider-compact-hint-8')).to_have_count(0)
            assert page.evaluate("window.calls.filter(call=>call.action==='provider.save').length") == 0
            passed('Initial GPT/Codex recommendation preserves explicit limits and excludes image, audio, other vendors and GPT OSS; all fields are editable')

            context(0).fill('')
            context(0).blur()
            expect(context(0)).to_have_value('')
            expect(dialog.locator('#provider-compact-hint-0')).to_have_text('自动压缩：244800 tokens（90%）')
            context(8).press_sequentially('272000')
            expect(context(8)).to_have_value('272000')
            expect(dialog.locator('#provider-compact-hint-8')).to_have_text('自动压缩：244800 tokens（90%）')
            context(8).fill('200000')
            expect(dialog.locator('#provider-compact-hint-8')).to_have_text('自动压缩：180000 tokens（90%）')
            context(8).fill('000320000')
            context(8).blur()
            expect(context(8)).to_have_value('000320000')
            page.evaluate("window.saveFailure='隔离磁盘写入失败'")
            dialog.get_by_role('button', name='保存', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('隔离磁盘写入失败')
            saved = page.evaluate("window.calls.filter(call=>call.action==='provider.save').at(-1).payload")
            assert saved['models'][8]['contextWindow'] == 320000
            assert saved['models'][0].get('contextWindow') is None
            assert saved['models'][4].get('contextWindow') is None
            expect(context(0)).to_have_value('')
            expect(context(8)).to_have_value('000320000')
            passed('String drafts support clearing and uninterrupted typing; save serializes valid integers while failure keeps every draft')

            dialog = open_editor()
            for invalid in ['0', '-1', '1.5', '1e6', 'Infinity', '9007199254740992', 'not-a-number']:
                page.evaluate('window.calls=[]')
                context(8).fill(invalid)
                expect(context(8)).to_have_value(invalid)
                expect(dialog.locator('#provider-compact-hint-8')).to_have_count(0)
                context(8).blur()
                expect(context(8)).to_have_attribute('aria-invalid', 'true')
                dialog.get_by_role('button', name='保存', exact=True).click()
                expect(context(8)).to_be_focused()
                dialog.get_by_role('button', name='从上游拉取', exact=True).click()
                assert page.evaluate("window.calls.filter(call=>['provider.save','provider.models'].includes(call.action)).length") == 0
                expect(context(8)).to_have_value(invalid)
            context(8).fill('1')
            expect(dialog.locator('#provider-compact-hint-8')).to_have_text('自动压缩：1 tokens（90%）')
            context(8).blur()
            expect(context(8)).to_have_attribute('aria-invalid', 'false')
            dialog.get_by_role('button', name='保存', exact=True).click()
            expect(dialog).not_to_be_visible()
            assert page.evaluate('window.state.providers[0].models[8].contextWindow') == 1
            passed('Blur/save/fetch reject zero, negative, fractional, exponent, unsafe and nonnumeric values; correction allows a positive integer')

            dialog = open_editor()
            context(0).fill('')
            context(0).blur()
            dialog.get_by_role('button', name='批量设置上下文', exact=True).click()
            batch = dialog.get_by_role('group', name='批量设置上下文', exact=True)
            expect(batch.locator('#provider-batch-compact-hint')).to_have_text('自动压缩：244800 tokens（90%）')
            expect(batch.get_by_role('combobox', name='批量上下文模型范围')).to_have_value('chatgpt')
            expect(batch.get_by_role('combobox', name='批量上下文应用方式')).to_have_value('missing')
            batch.get_by_role('textbox', name='批量上下文窗口').fill('288000')
            batch.get_by_role('button', name='应用到 1 项', exact=True).click()
            expect(context(0)).to_have_value('288000')
            expect(context(1)).to_have_value('128000')
            expect(context(4)).to_have_value('')
            batch.get_by_role('combobox', name='批量上下文应用方式').select_option('overwrite')
            batch.get_by_role('textbox', name='批量上下文窗口').fill('300000')
            batch.get_by_role('button', name='应用到 5 项', exact=True).click()
            for index in [0, 1, 2, 3, 10]:
                expect(context(index)).to_have_value('300000')
            for index, value in {4: '', 5: '', 6: '32000', 7: '200000', 8: '', 9: '128000', 11: '', 12: ''}.items():
                expect(context(index)).to_have_value(value)
            assert page.evaluate("window.calls.filter(call=>call.action==='provider.save').length") == 0
            dialog.get_by_role('button', name='保存', exact=True).click()
            expect(dialog).not_to_be_visible()
            saved = page.evaluate('window.state.providers[0].models')
            assert saved[0]['inputPrice'] == 2.5 and saved[0]['outputPrice'] == 10
            assert saved[0]['capabilities'] == {'tools': True, 'vision': True}
            passed('Application-native batch defaults to GPT/Codex and blank-only; explicit overwrite changes only matched text models, preserving prices and capabilities')

            dialog = open_editor()
            dialog.get_by_role('button', name='批量设置上下文', exact=True).click()
            batch = dialog.get_by_role('group', name='批量设置上下文', exact=True)
            batch.get_by_role('combobox', name='批量上下文模型范围').select_option('all')
            expect(batch.get_by_text('将包含当前供应商所有类型及厂商的模型', exact=False)).to_be_visible()
            for invalid in ['', '0', '-10', '2.5', '3e5', '9007199254740992']:
                before = model_values()
                batch.get_by_role('textbox', name='批量上下文窗口').fill(invalid)
                expect(batch.locator('#provider-batch-compact-hint')).to_have_count(0)
                batch.get_by_role('button', name='应用到 5 项', exact=True).click()
                expect(batch.get_by_role('alert')).to_be_visible()
                assert model_values() == before
            batch.get_by_role('textbox', name='批量上下文窗口').fill('64000')
            expect(batch.locator('#provider-batch-compact-hint')).to_have_text('自动压缩：57600 tokens（90%）')
            batch.get_by_role('button', name='应用到 5 项', exact=True).click()
            for index in [4, 5, 8, 11, 12]:
                expect(context(index)).to_have_value('64000')
            expect(context(7)).to_have_value('200000')
            batch.get_by_role('combobox', name='批量上下文应用方式').select_option('overwrite')
            batch.get_by_role('textbox', name='批量上下文窗口').fill('100000')
            batch.get_by_role('button', name='应用到 13 项', exact=True).click()
            assert {row['context'] for row in model_values()} == {'100000'}
            dialog.get_by_role('button', name='取消', exact=True).click()
            assert page.evaluate('JSON.stringify(window.state)===JSON.stringify(window.seed)')
            assert page.evaluate('window.nativePrompts') == 0
            passed('All-model scope is explicit; batch input validates before editing, supports blank-only/overwrite and cancellation leaves stored data intact without native prompt')

            dialog = open_editor()
            context(0).fill('321000')
            context(1).fill('222000')
            page.locator('.model-row').first.get_by_title('删除这一行', exact=True).click()
            expect(context(0)).to_have_value('222000')
            expect(dialog.get_by_role('textbox', name='第 1 行模型 ID')).to_have_value('gpt-5.4-codex')
            dialog.get_by_role('button', name='添加模型', exact=True).click()
            expect(context(12)).to_have_value('')
            dialog.get_by_role('textbox', name='第 13 行模型 ID').fill('custom-text-model')
            context(12).fill('48000')
            dialog.get_by_role('button', name='保存', exact=True).click()
            expect(dialog).not_to_be_visible()
            saved = page.evaluate('window.state.providers[0].models')
            assert saved[0]['id'] == 'gpt-5.4-codex' and saved[0]['contextWindow'] == 222000
            assert saved[12]['id'] == 'custom-text-model' and saved[12]['contextWindow'] == 48000
            passed('Removing a row keeps drafts aligned with remaining models and adding a model starts with an independent editable context')

            dialog = open_editor()
            context(1).fill('256000')
            page.evaluate("window.modelResponse={ok:false,message:'模型同步失败且没有返回列表',models:[]}")
            dialog.get_by_role('button', name='从上游拉取', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('模型同步失败且没有返回列表')
            expect(page.locator('.model-row')).to_have_count(13)
            expect(context(1)).to_have_value('256000')
            page.evaluate("window.modelFailure='模型请求中断'")
            dialog.get_by_role('button', name='从上游拉取', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('模型请求中断')
            expect(page.locator('.model-row')).to_have_count(13)
            expect(context(1)).to_have_value('256000')
            page.evaluate("window.modelFailure='';window.modelResponse={ok:true,models:[...window.state.providers[0].models,{id:'gpt-5.5'}],added:1}")
            dialog.get_by_role('button', name='从上游拉取', exact=True).click()
            expect(page.locator('.model-row')).to_have_count(14)
            expect(context(1)).to_have_value('256000')
            expect(context(13)).to_have_value('272000')
            passed('Failed or rejected model fetch preserves all edited rows; successful retry keeps existing values and initializes newly discovered text-model recommendations')

            page.evaluate("document.documentElement.dataset.theme='dark'")
            dialog.get_by_role('button', name='批量设置上下文', exact=True).click()
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'model-context-desktop-dark.png'), animations='disabled')
            page.set_viewport_size({'width': 390, 'height': 844})
            batch = dialog.get_by_role('group', name='批量设置上下文', exact=True)
            batch.scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Page overflows at mobile width'
            for control in batch.locator('input, select, button').all():
                bounds = control.bounding_box()
                assert bounds and bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 390, bounds
            context(13).scroll_into_view_if_needed()
            context(13).fill('384000')
            expect(context(13)).to_have_value('384000')
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'model-context-narrow-dark.png'), animations='disabled')
            passed('Dark desktop and narrow layouts expose labelled context fields and keep batch controls within the viewport')
            assert not errors, errors
            assert not network, network
            browser.close()
    print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors, 'unexpectedNetwork': network}, ensure_ascii=False))


if __name__ == '__main__':
    main()
