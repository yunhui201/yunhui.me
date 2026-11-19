"""Plugin navigation cache with real React, 6,000 items and controlled local/probe IPC."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-extension-snapshot-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import DesktopExtensions from './ui/src/pages/DesktopExtensions.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.render=()=>root.render(<ToastHost>{window.visible?<DesktopExtensions key={window.workspace}/>:<h1>其他功能</h1>}</ToastHost>);window.render();"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors, checks, timings = [], [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/*', lambda route: route.fulfill(content_type='text/html', body='<html><main id="root"></main></html>') if route.request.is_navigation_request() and route.request.url.startswith('http://fixture.test/') else route.abort())
            page.goto('http://fixture.test/')
            page.add_style_tag(path=str(bundle.with_suffix('.css')))
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate("""()=>{
              window.visible=true;window.workspace=0;window.now=Date.now();Date.now=()=>window.now;
              window.calls=[];window.pending=[];window.hold=new Set(['probe']);window.fail={};window.unknown=false;
              window.ext={ok:true,upstream:{repository:'fixture',version:'1',revision:'1',license:'MIT'},
                client:{installed:true,running:true,compatible:true,version:'1',message:'检测通过'},connection:{port:9222},runtime:{connected:true,errors:[],applied:['p0']},
                items:Array.from({length:6000},(_,i)=>({id:'p'+i,name:'插件 '+i,description:'搜索测试 '+i,source:'builtin',installed:true,enabled:i===0,status:i===0?'active':'installed',config:{privateSetting:'memory-only'}}))};
              window.pendingFor=kind=>window.pending.filter(p=>p.kind===kind&&!p.done);
              window.finish=(kind,index=0,error)=>{const p=window.pendingFor(kind)[index];if(!p)throw Error('No pending '+kind);p.done=true;error?p.reject(Error(error)):p.resolve(p.value);};
              window.makeTransport=()=>({invoke:async(action,payload={})=>{
                const kind=action==='extension.list'?(payload.probeClient===false?'local':'probe'):action;
                window.calls.push({action,kind,payload:structuredClone(payload)});
                let value;
                if(action==='extension.list'){
                  value=structuredClone(window.ext);
                  if(kind==='local'){value.client={installed:false,running:false,compatible:false,detecting:true,message:'尚未找到客户端'};value.runtime={connected:false,checking:true,applied:[],errors:[]};for(const item of value.items)item.status=item.enabled?'needs-connection':'installed';}
                  if(window.unknown)value={ok:false,message:'未确认的列表失败'};
                }else value={ok:true,results:[{source:'public',ok:true,sourceType:'remote'},{source:'full',ok:true,sourceType:'remote'}]};
                if(window.fail[kind])throw Error(window.fail[kind]);
                if(window.hold.has(kind))value=await new Promise((resolve,reject)=>window.pending.push({kind,value,resolve,reject,done:false}));
                if(action==='extension.refresh'){window.ext.items[0].name='更新后的插件';window.ext.items[0].enabled=false;window.ext.items[0].status='installed';}
                if(action==='extension.toggle'){window.ext.items.find(i=>i.id===payload.id).enabled=payload.enabled;window.ext.items.find(i=>i.id===payload.id).status=payload.enabled?'active':'installed';}
                return value;
              }});
              window.aurora=window.makeTransport();
            }""")
            page.add_script_tag(path=str(bundle))

            def count(kind):
                return page.evaluate('(kind)=>window.calls.filter(c=>c.kind===kind).length', kind)

            def finish(kind, index=0, error=None):
                page.evaluate('([kind,index,error])=>window.finish(kind,index,error)', [kind, index, error])

            def navigate(visible):
                if not visible:
                    page.evaluate('window.visible=false;window.render()')
                    expect(page.get_by_role('heading', name='其他功能')).to_be_visible()
                    return
                elapsed = page.evaluate("""async()=>{const start=performance.now();window.visible=true;window.render();
                  while(!document.querySelector('.extension-card')){if(performance.now()-start>1500)throw Error('Cached cards did not render');await new Promise(requestAnimationFrame);}
                  await new Promise(requestAnimationFrame);return Math.round((performance.now()-start)*10)/10;}""")
                assert elapsed < 1000, elapsed
                timings.append(elapsed)

            expect(page.locator('.extension-card')).to_have_count(60)
            page.wait_for_function("window.pendingFor('probe').length===1")
            assert count('local') == count('probe') == 1
            expect(page.get_by_role('region', name='桌面插件连接处理')).to_have_count(0)
            expect(page.get_by_text('已生效', exact=True)).to_have_count(0)
            expect(page.locator('.desktop-connection').get_by_role('button', name='正在检测连接')).to_be_disabled()
            page.get_by_label('搜索桌面插件').fill('搜索测试 5999')
            expect(page.locator('.extension-card')).to_have_count(1)
            expect(page.get_by_role('heading', name='插件 5999', exact=True)).to_be_visible()
            page.get_by_label('搜索桌面插件').fill('')
            navigate(False)
            navigate(True)
            assert count('local') == count('probe') == 1
            finish('probe')
            expect(page.get_by_text('已连接桌面', exact=True)).to_be_visible()
            navigate(False)
            navigate(True)
            assert count('local') == count('probe') == 1
            checks.append('6,000 local items render 60 cards and remain searchable with probe held; remount shares the pending probe and fresh returns issue no IPC')

            page.evaluate("window.now+=31000;window.hold.add('local')")
            navigate(False)
            navigate(True)
            expect(page.get_by_role('heading', name='插件 0', exact=True)).to_be_visible()
            expect(page.get_by_text('已生效', exact=True)).to_have_count(0)
            assert count('local') == 2 and count('probe') == 1
            finish('local')
            page.wait_for_function("window.pendingFor('probe').length===1")
            finish('probe', error='客户端检测超时')
            expect(page.get_by_role('alert')).to_contain_text('客户端检测超时')
            expect(page.locator('.extension-card')).to_have_count(60)
            expect(page.locator('.desktop-connection').get_by_text('连接状态待确认', exact=True).first).to_be_visible()
            expect(page.get_by_role('region', name='桌面插件连接处理')).to_have_count(0)
            page.get_by_role('button', name='刷新列表', exact=True).evaluate('(button)=>{button.click();button.click()}')
            assert count('local') == 3
            finish('local')
            page.wait_for_function("window.pendingFor('probe').length===1")
            finish('probe')
            expect(page.get_by_role('alert')).to_have_count(0)
            expect(page.get_by_text('已连接桌面', exact=True)).to_be_visible()
            checks.append('Expired cache stays visible during local and probe refresh; failed detection keeps cards, avoids false missing/active states and retries coalesce repeated clicks')

            # Old probe belongs to a snapshot before the write; its later success must be ignored.
            page.evaluate("window.hold.delete('local')")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            page.wait_for_function("window.pendingFor('probe').length===1")
            page.evaluate("window.hold.add('extension.refresh')")
            page.get_by_role('button', name='同步市场索引', exact=True).click()
            page.wait_for_function("window.pendingFor('extension.refresh').length===1")
            navigate(False)
            navigate(True)
            expect(page.get_by_role('button', name='同步市场索引', exact=True)).to_be_disabled()
            finish('extension.refresh')
            page.wait_for_function("window.pendingFor('probe').length===2")
            expect(page.get_by_role('heading', name='更新后的插件', exact=True)).to_be_visible()
            finish('probe', 1)
            expect(page.get_by_role('switch', name='启用 更新后的插件', exact=True)).not_to_be_checked()
            finish('probe', 0)
            expect(page.get_by_role('heading', name='插件 0', exact=True)).to_have_count(0)
            expect(page.get_by_role('switch', name='启用 更新后的插件', exact=True)).not_to_be_checked()
            expect(page.locator('.toast')).to_have_count(0)
            before = count('local') + count('probe')
            navigate(False)
            navigate(True)
            assert count('local') + count('probe') == before
            checks.append('Market write completed after unmount refreshes the shared snapshot; a pre-write probe resolving last cannot resurrect the old plugin name or enablement')

            page.evaluate("window.hold.add('extension.toggle')")
            page.get_by_role('switch', name='启用 更新后的插件', exact=True).click()
            page.wait_for_function("window.pendingFor('extension.toggle').length===1")
            navigate(False)
            finish('extension.toggle')
            page.wait_for_function("window.pendingFor('probe').length===1")
            navigate(True)
            expect(page.get_by_role('switch', name='启用 更新后的插件', exact=True)).to_be_checked()
            expect(page.get_by_role('switch', name='启用 更新后的插件', exact=True)).to_be_disabled()
            finish('probe')
            expect(page.get_by_role('switch', name='启用 更新后的插件', exact=True)).to_be_enabled()
            expect(page.locator('.toast')).to_have_count(0)
            checks.append('Enabling a plugin after leaving the page refreshes installed state before return and gates operations until compatibility probing completes')

            page.evaluate("window.fail.local='本地目录读取失败'")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('本地目录读取失败')
            expect(page.get_by_role('heading', name='更新后的插件', exact=True)).to_be_visible()
            expect(page.get_by_text('没有匹配的插件', exact=True)).to_have_count(0)
            page.evaluate("delete window.fail.local;window.hold.delete('probe')")
            page.get_by_role('button', name='刷新列表', exact=True).click()
            expect(page.get_by_role('alert')).to_have_count(0)
            checks.append('Local list failures retain the prior snapshot without an empty-state claim and explicit retry recovers')

            navigate(False)
            page.evaluate("window.workspace++;window.aurora=window.makeTransport();window.unknown=true;window.ext.items=[{...window.ext.items[0],id:'other',name:'另一个工作空间'}];window.visible=true;window.render()")
            expect(page.get_by_role('alert')).to_contain_text('未确认的列表失败')
            expect(page.locator('.extension-card')).to_have_count(0)
            expect(page.get_by_text('没有匹配的插件', exact=True)).to_have_count(0)
            expect(page.get_by_role('heading', name='更新后的插件', exact=True)).to_have_count(0)
            page.evaluate('window.unknown=false')
            page.get_by_role('button', name='刷新列表', exact=True).click()
            expect(page.get_by_role('heading', name='另一个工作空间', exact=True)).to_be_visible()
            assert page.evaluate('Object.keys(localStorage).length+Object.keys(sessionStorage).length') == 0
            assert not errors, errors
            assert page.evaluate('window.pending.filter(p=>!p.done).length') == 0
            checks.append('Changing the desktop transport never reuses another workspace snapshot; unknown failed responses are not cached as empty success and browser storage stays empty')
            report = {'passed': True, 'count': len(checks), 'checks': checks, 'items': 6000, 'cachedNavigationMs': timings, 'maximumCachedNavigationMs': max(timings), 'scope': 'Real React in Chromium with isolated held IPC, no client processes or external services'}
            directory = ROOT / 'tmp/extension-snapshot-ui'
            directory.mkdir(parents=True, exist_ok=True)
            (directory / 'validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True))
            browser.close()


if __name__ == '__main__':
    main()
