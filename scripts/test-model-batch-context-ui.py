"""Model context editing through real React UI, isolated mocked IPC."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='yunhui-model-context-batch-') as temporary:
    bundle = Path(temporary) / 'ui.js'
    source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Models from './ui/src/pages/Models.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.render=()=>root.render(<ToastHost><Models state={structuredClone(window.state)} reload={async()=>{if(window.reloadFail)throw Error('refresh failed');window.render();}} go={()=>{}}/></ToastHost>);"""
    options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
    subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1300, 'height': 1000})
        page.route('**/*', lambda route: route.abort())
        page.set_default_timeout(4000)
        errors, checks = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content('<html data-theme="light"><main id="root"></main></html>')
        for style in ['app.css', 'workspace.css']:
            page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
        page.evaluate("""()=>{
          window.calls=[];window.fail=false;
          window.state={providers:[
            {id:'one',name:'甲',models:[{id:'gpt-6-sol',contextWindow:128000},{id:'gpt-image-2'},{id:'deepseek-chat'},{id:'codex-auto-review'},{id:'codex-mini-latest'}]},
            {id:'two',name:'乙',models:[{id:'gpt-5.3-codex',contextWindow:400000},{id:'gpt-realtime'}]}]};
          window.aurora={invoke:async(action,payload)=>{
            window.calls.push({action,payload:structuredClone(payload)});
            if(action==='model.batch.preview')return {ok:true,revision:'revision',count:payload.items.length,conflicts:[]};
            if(action==='model.batch.apply'){
              if(window.fail)return {ok:false,message:'配置已变化，请重新预览'};
              for(const selected of payload.items){const model=window.state.providers.find(p=>p.id===selected.providerId).models.find(m=>m.id===selected.modelId);Object.assign(model,payload.patch);}
              return {ok:true,message:'已保存上下文'};
            }throw Error('unexpected action '+action);
          }};
        }""")
        page.add_script_tag(path=str(bundle))
        page.evaluate('window.render()')
        select = page.get_by_role('button', name='选择当前 ChatGPT 文本模型（3）', exact=True)
        select.click()
        expect(page.get_by_text('已选 3 条', exact=True)).to_be_visible()
        page.get_by_role('button', name='批量编辑', exact=True).click()
        dialog = page.get_by_role('dialog', name='批量编辑模型', exact=True)
        field = dialog.get_by_label('批量上下文窗口', exact=True)
        dialog.get_by_role('button', name='填入 ChatGPT 建议值 272000', exact=True).click()
        expect(field).to_have_value('272000')
        expect(dialog.locator('#model-batch-compact-hint')).to_have_text('自动压缩：244800 tokens（90%）')
        expect(page.get_by_text('应用时按上下文的 90% 同步自动压缩阈值', exact=False)).to_be_visible()
        dialog.get_by_role('button', name='预览修改', exact=True).click()
        reviewed = page.evaluate('window.calls.at(-1).payload')
        assert reviewed['patch'] == {'contextWindow': 272000}
        assert {item['modelId'] for item in reviewed['items']} == {'gpt-6-sol', 'codex-mini-latest', 'gpt-5.3-codex'}
        dialog.get_by_role('button', name='确认更新 3 条', exact=True).click()
        expect(dialog).to_have_count(0)
        assert page.evaluate("window.state.providers[0].models.find(m=>m.id==='gpt-image-2').contextWindow") is None
        checks.append('Suggested selection and 272000 preset update only selected text models, excluding media and auxiliary models')

        page.get_by_label('按供应商筛选模型', exact=True).select_option('two')
        page.get_by_role('button', name='选择当前 ChatGPT 文本模型（1）', exact=True).click()
        expect(page.get_by_text('已选 1 条', exact=True)).to_be_visible()
        page.get_by_role('button', name='批量编辑', exact=True).click()
        before = page.evaluate('window.calls.length')
        for invalid in ['0', '-1', '12.5', '1e6', '9007199254740992', 'NaN']:
            field.fill(invalid)
            expect(dialog.locator('#model-batch-compact-hint')).to_have_count(0)
            dialog.get_by_role('button', name='预览修改', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('正整数')
            assert page.evaluate('window.calls.length') == before
        field.fill('200000')
        expect(dialog.locator('#model-batch-compact-hint')).to_have_text('自动压缩：180000 tokens（90%）')
        field.fill('300000')
        dialog.get_by_role('button', name='预览修改', exact=True).click()
        field.fill('400000')
        expect(dialog.locator('#model-batch-compact-hint')).to_have_text('自动压缩：360000 tokens（90%）')
        expect(dialog.get_by_role('button', name='确认更新 1 条', exact=True)).to_have_count(0)
        dialog.get_by_role('button', name='预览修改', exact=True).click()
        page.evaluate('window.fail=true')
        dialog.get_by_role('button', name='确认更新 1 条', exact=True).click()
        expect(field).to_have_value('400000')
        expect(dialog.get_by_role('alert')).to_contain_text('重新预览')
        checks.append('Filtered selection is explicit; invalid token counts do not reach IPC, edits invalidate previews and failures retain drafts')
        dialog.get_by_role('button', name='取消', exact=True).click()

        page.get_by_label('按供应商筛选模型', exact=True).select_option('one')
        page.get_by_role('row').filter(has=page.get_by_role('cell', name='gpt-6-sol', exact=True)).get_by_role('button', name='编辑', exact=True).click()
        expect(field).to_have_value('272000')
        field.fill('350000')
        dialog.get_by_role('button', name='预览修改', exact=True).click()
        assert page.evaluate('window.calls.at(-1).payload.patch.contextWindow') == 350000
        page.evaluate('window.fail=false;window.reloadFail=true')
        dialog.get_by_role('button', name='确认更新 1 条', exact=True).click()
        expect(dialog).to_have_count(0)
        expect(page.get_by_role('alert')).to_contain_text('模型修改已保存')
        committed = page.evaluate("window.calls.filter(call=>call.action==='model.batch.apply').length")
        page.evaluate('window.reloadFail=false')
        page.get_by_role('button', name='重新加载列表', exact=True).click()
        expect(page.get_by_role('alert')).to_have_count(0)
        assert page.evaluate("window.calls.filter(call=>call.action==='model.batch.apply').length") == committed
        checks.append('A successful save followed by a failed refresh stays committed and retry only refreshes the list')
        page.get_by_label('全选当前模型', exact=True).check()
        page.get_by_role('button', name='批量编辑', exact=True).click()
        expect(dialog.get_by_role('button', name='填入 ChatGPT 建议值 272000', exact=True)).to_be_disabled()
        expect(field).to_have_value('')
        expect(dialog.locator('#model-batch-compact-hint')).to_have_count(0)
        checks.append('Single-model editing loads its current window; mixed selections do not enable the ChatGPT-specific preset')
        assert not errors, errors
        browser.close()
        print(json.dumps({'ok': True, 'checks': checks}, ensure_ascii=False, indent=2))
