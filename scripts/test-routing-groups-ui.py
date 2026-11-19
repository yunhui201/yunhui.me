"""Routing editor IPC contracts, recovery and connection-copy flows; no paid requests."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='yunhui-routing-ui-') as temporary:
    bundle = Path(temporary) / 'ui.js'
    source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Groups from './ui/src/pages/Groups.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.render=()=>root.render(<ToastHost>{window.visible&&<Groups state={window.state} reload={async()=>{window.reloads++;window.render()}} go={()=>{}}/>}</ToastHost>);"""
    options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
    subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1200, 'height': 950})
        page.route('**/*', lambda route: route.abort())
        page.set_default_timeout(4000)
        errors, checks = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content('<html data-theme="light"><div id="root" style="padding:20px"></div></html>')
        for style in ['app.css', 'workspace.css']:
            page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
        page.evaluate("""()=>{
          window.visible=true;window.calls=[];window.copied=[];window.hold=false;window.fail=false;window.pending=[];window.reloads=0;
          window.initial={providers:[{id:'a',name:'甲供应商',enabled:true,models:[{id:'model-a'},{id:'selected-a'}]},{id:'b',name:'乙供应商',enabled:true,models:[{id:'model-b'}]}],groups:[{id:'g',name:'coding',mode:'order',enabled:true,retries:2,members:[{providerId:'a',model:null,weight:1},{providerId:'b',model:'model-b',weight:2}]}],gateway:{running:true},gatewayUrl:'http://127.0.0.1:3425',settings:{gatewayToken:'fixture-private-token'}};
          window.state=structuredClone(window.initial);
          Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copied.push(text)}});
          window.mock={invoke:async(action,payload)=>{window.calls.push({action,payload:structuredClone(payload)});if(!['group.save','group.delete'].includes(action))throw Error('Unexpected action');
            if(window.hold)return new Promise(resolve=>window.pending.push({resolve,payload:structuredClone(payload)}));
            if(window.fail)return {ok:false,message:'分组名称已存在'};
            if(action==='group.delete'){window.state.groups=window.state.groups.filter(g=>g.id!==payload.id);return {ok:true}};
            const index=window.state.groups.findIndex(g=>g.id===payload.id);const saved=index>=0?{...window.state.groups[index],...payload}:{id:'new-group',...payload};
            if(index>=0)window.state.groups[index]=saved;else window.state.groups.push(saved);return saved;}};window.aurora=window.mock;
        }""")
        page.add_script_tag(path=str(bundle))
        page.evaluate('window.render()')
        dialog = page.get_by_role('dialog')
        def calls():
            return page.evaluate('window.calls')
        def reset():
            page.evaluate('window.visible=false;window.render()')
            expect(page.get_by_role('heading', name='路由分组', exact=True)).to_have_count(0)
            page.evaluate('window.state=structuredClone(window.initial);window.visible=true;window.calls=[];window.copied=[];window.hold=false;window.fail=false;window.pending=[];window.aurora=window.mock;window.render()')
            expect(page.get_by_role('heading', name='路由分组', exact=True)).to_be_visible()

        page.get_by_role('button', name='复制模型名', exact=True).click()
        assert page.evaluate('window.copied') == ['group/coding']
        page.get_by_role('button', name='接入参数', exact=True).click()
        expect(dialog).to_contain_text('http://127.0.0.1:3425/v1')
        expect(dialog).to_contain_text('客户端手动选择或填写')
        assert 'fixture-private-token' not in dialog.inner_text()
        dialog.get_by_role('button', name='复制接口地址', exact=True).click()
        dialog.get_by_role('button', name='复制网关令牌', exact=True).click()
        assert page.evaluate('window.copied') == ['group/coding', 'http://127.0.0.1:3425/v1', 'fixture-private-token']
        assert not calls()
        page.keyboard.press('Escape')
        checks.append('Connection instructions copy the exact alias, gateway base and token without modifying clients or invoking a model')

        reset()
        page.get_by_role('button', name='编辑', exact=True).click()
        dialog.get_by_label('路由策略').select_option('weight')
        dialog.get_by_label('失败重试次数').fill('4')
        dialog.get_by_label('第 1 个成员模型').select_option('selected-a')
        dialog.get_by_label('第 1 个成员权重').fill('0')
        dialog.get_by_title('下移第 1 个成员', exact=True).click()
        expect(dialog.get_by_label('第 1 个成员供应商')).to_have_value('b')
        expect(dialog.get_by_label('第 2 个成员模型')).to_have_value('selected-a')
        dialog.get_by_role('button', name='保存', exact=True).click()
        expect(dialog).to_have_count(0)
        payload = calls()[0]['payload']
        assert payload['mode'] == 'weight' and payload['retries'] == 4
        assert payload['members'] == [{'providerId':'b','model':'model-b','weight':2},{'providerId':'a','model':'selected-a','weight':0}]
        expect(page.get_by_text('不分流', exact=True)).to_be_visible()
        checks.append('Reordering, model selection, zero weight and retry budget reach group.save unchanged')

        reset()
        page.get_by_role('button', name='编辑', exact=True).click()
        expect(dialog.get_by_label('第 1 个成员权重')).to_be_disabled()
        dialog.get_by_label('路由策略').select_option('pace')
        expect(dialog).to_contain_text('还没有额度窗口数据')
        dialog.get_by_label('路由策略').select_option('usage')
        expect(dialog).to_contain_text('重启网关后重新统计')
        dialog.get_by_label('路由策略').select_option('smart')
        expect(dialog).to_contain_text('失败计数')
        expect(dialog.get_by_label('路由策略')).to_contain_text('健康与优先级')
        dialog.get_by_role('button', name='取消', exact=True).click()
        assert not calls()
        checks.append('Strategy descriptions match available runtime evidence and inactive weights cannot be edited')

        reset()
        page.get_by_role('button', name='新建分组', exact=False).click()
        dialog.get_by_label('分组名').fill('coding')
        dialog.get_by_role('button', name='保存', exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('名称已存在')
        dialog.get_by_label('分组名').fill('bad/name')
        dialog.get_by_role('button', name='保存', exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('有效分组名')
        dialog.get_by_label('分组名').fill('new-name')
        dialog.get_by_label('失败重试次数').fill('11')
        dialog.get_by_role('button', name='保存', exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('0–10')
        assert not calls()
        dialog.get_by_role('button', name='取消', exact=True).click()
        checks.append('Duplicate names, unsafe names and invalid retry budgets are rejected before IPC')

        reset()
        page.get_by_role('button', name='编辑', exact=True).click()
        page.evaluate('window.hold=true')
        dialog.get_by_role('button', name='保存', exact=True).click()
        expect(dialog.get_by_role('button', name='保存中…', exact=True)).to_be_disabled()
        expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_disabled()
        page.keyboard.press('Escape')
        expect(dialog).to_be_visible()
        assert len(calls()) == 1
        page.evaluate("window.hold=false;window.pending.shift().resolve({ok:false,message:'分组保存失败，请重试'})")
        expect(dialog.get_by_role('alert')).to_contain_text('分组保存失败')
        expect(dialog.get_by_label('分组名')).to_have_value('coding')
        dialog.get_by_role('button', name='保存', exact=True).click()
        expect(dialog).to_have_count(0)
        assert len(calls()) == 2
        checks.append('Saving blocks duplicates and dismissal; a failed save preserves the draft for retry')

        reset()
        page.evaluate("window.aurora=undefined;window.state.gateway.running=false;window.render()")
        expect(page.get_by_role('button', name='新建分组', exact=False)).to_be_disabled()
        expect(page.get_by_role('button', name='编辑', exact=True)).to_be_disabled()
        page.get_by_role('button', name='接入参数', exact=True).click()
        expect(dialog).to_contain_text('本地网关当前未运行')
        expect(dialog.get_by_role('button', name='复制网关令牌', exact=True)).to_be_disabled()
        assert not calls()
        checks.append('Remote viewers cannot mutate groups or copy a desktop gateway token')

        reset()
        page.evaluate("window.state.groups[0].name='很长的分组模型名称'.repeat(8);window.state.providers[0].models[0].id='very-long-model-'.repeat(15);window.render()")
        page.set_viewport_size({'width':390,'height':844})
        for theme in ['light','dark']:
            page.evaluate('(theme)=>document.documentElement.dataset.theme=theme', theme)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            page.get_by_role('button', name='接入参数', exact=True).click()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            page.keyboard.press('Escape')
            page.get_by_role('button', name='编辑', exact=True).click()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            dialog.get_by_role('button', name='取消', exact=True).click()
        checks.append('Long group/model identifiers fit narrow light and dark layouts and both dialogs')
        assert not errors, errors
        browser.close()
        for check in checks:
            print('PASS', check)
        print(f'Routing group UI: {len(checks)} checks passed.')
