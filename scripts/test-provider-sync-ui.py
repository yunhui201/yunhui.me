"""Provider save triggers model discovery with both local and redacted remote key records."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-provider-sync-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Providers from './ui/src/pages/Providers.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderProvider=()=>root.render(<ToastHost key={window.generation}><Providers state={structuredClone(window.state)} reload={async()=>{window.reloads++;}} go={()=>{}}/></ToastHost>);"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle),
                   'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1380, 'height': 1050})
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/*', lambda route: route.abort())
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate("""()=>{window.generation=0;window.calls=[];window.reloads=0;
window.state={settings:{autoSyncModels:false},presets:[],providers:[]};
window.aurora={invoke:async(action,payload)=>{window.calls.push({action,payload:structuredClone(payload)});
if(action==='provider.balance')return {providerId:payload.providerId,adapter:'auto',items:[]};
if(action==='provider.save')return structuredClone(window.state.providers[0]);
if(action==='provider.models'){if(window.modelError)throw Error(window.modelError);return window.modelResult||{ok:true,added:1};}throw Error('Unexpected RPC '+action);}};}""")
            page.add_script_tag(path=str(bundle))
            for label, key, should_sync in [
                ('redacted remote hasKey', {'hasKey': True, 'enabled': True}, True),
                ('local plaintext key', {'key': 'fixture-local-key', 'enabled': True}, True),
                ('disabled redacted key', {'hasKey': True, 'enabled': False}, False),
                ('missing credential', {'hasKey': False, 'key': '', 'enabled': True}, False),
            ]:
                page.evaluate("""key=>{window.generation++;window.calls=[];window.reloads=0;
window.state.providers=[{id:'provider-fixture',name:'同步验证',format:'openai-chat',baseUrl:'https://fixture.invalid/v1',enabled:true,models:[],apiKeys:[{id:'key-fixture',label:'默认',weight:1,...key}]}];window.renderProvider();}""", key)
                page.locator('.provider-card').get_by_role('button', name='编辑', exact=True).click()
                dialog = page.get_by_role('dialog', name='编辑供应商', exact=True)
                dialog.get_by_role('button', name='保存', exact=True).click()
                expect(dialog).not_to_be_visible()
                if should_sync:
                    page.wait_for_function("window.calls.some(call=>call.action==='provider.models')")
                calls = page.evaluate("window.calls.filter(call=>['provider.save','provider.models'].includes(call.action))")
                assert [call['action'] for call in calls] == ['provider.save'] + (['provider.models'] if should_sync else [])
                if should_sync:
                    assert calls[-1]['payload'] == {'providerId': 'provider-fixture'}
                assert page.evaluate('window.reloads') >= 1
                checks.append(label)
                print('PASS', label, flush=True)

            for failure, message in [('response', '模型已获取，但本地保存失败'), ('rejection', '模型请求连接中断')]:
                page.evaluate("""({failure,message})=>{window.generation++;window.calls=[];window.reloads=0;
window.modelError=failure==='rejection'?message:'';window.modelResult={ok:false,message};
window.state.providers=[{id:'provider-fixture',name:'同步验证',format:'openai-chat',baseUrl:'https://fixture.invalid/v1',enabled:true,models:[],apiKeys:[{id:'key-fixture',label:'默认',weight:1,key:'fixture-key',enabled:true}]}];window.renderProvider();}""", {'failure': failure, 'message': message})
                card = page.locator('.provider-card')
                card.get_by_role('button', name='编辑', exact=True).click()
                dialog = page.get_by_role('dialog', name='编辑供应商', exact=True)
                dialog.get_by_role('button', name='保存', exact=True).click()
                expect(dialog).not_to_be_visible()
                expect(card.get_by_role('alert')).to_contain_text('供应商已保存，但模型同步失败：' + message)
                expect(page.locator('.toast.ok')).to_have_text('供应商已保存')
                assert page.evaluate("window.calls.filter(x=>x.action==='provider.save').length") == 1
                card.get_by_role('button', name='手动添加模型', exact=True).click()
                expect(dialog).to_be_visible()
                dialog.get_by_role('button', name='添加模型', exact=True).click()
                expect(dialog.get_by_placeholder('模型 API ID', exact=True)).to_have_count(1)
                dialog.get_by_role('button', name='取消', exact=True).click()
                expect(card.get_by_role('alert')).to_contain_text(message)
                page.evaluate("window.modelError='';window.modelResult={ok:false,message:'本次重试仍然失败'}")
                card.get_by_role('button', name='同步模型', exact=True).click()
                expect(card.get_by_role('alert')).to_contain_text('本次重试仍然失败')
                assert '已同步模型，新增 0 个' not in page.locator('.toast.ok').all_text_contents()
                page.evaluate('window.modelResult={ok:true,added:0}')
                card.get_by_role('button', name='同步模型', exact=True).click()
                expect(card.get_by_role('alert')).to_have_count(0)
                expect(page.get_by_text('已同步模型，新增 0 个', exact=True)).to_be_visible()
                checks.append(f'{failure}: saved supplier survives visible sync failure, manual model entry is reachable, failed retry stays explicit and zero-add success clears it')
                print('PASS', failure, 'failure and recovery', flush=True)

            page.evaluate("""()=>{window.generation++;window.calls=[];window.modelError='';window.modelResult={ok:true,added:0};window.renderProvider();}""")
            page.locator('.provider-card').get_by_role('button', name='编辑', exact=True).click()
            page.get_by_role('dialog', name='编辑供应商', exact=True).get_by_role('button', name='保存', exact=True).click()
            page.wait_for_function("window.calls.some(x=>x.action==='provider.models')")
            expect(page.locator('.provider-card').get_by_role('alert')).to_have_count(0)
            expect(page.locator('.toast.ok')).to_have_text('供应商已保存')
            checks.append('Automatic zero-add synchronization is successful and does not create a false error or fabricated additions')
            assert not errors, errors
            browser.close()
            print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
