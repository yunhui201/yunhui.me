"""Plugin management browser acceptance with real package schemas and controlled RPC faults."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-plugin-ui-') as temporary:
        bundle = Path(temporary) / 'plugin-ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Plugins from './ui/src/pages/Plugins.tsx';import CodexEnhance from './ui/src/pages/CodexEnhance.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));let fixtureGeneration;
// A fixture generation represents a new desktop workspace, not navigation in one workspace.
window.renderPage=(page='plugins')=>{if(fixtureGeneration!==window.generation&&window.aurora)window.aurora={...window.aurora};fixtureGeneration=window.generation;window.page=page;const Page=page==='codex'?CodexEnhance:Plugins;root.render(<ToastHost><Page key={page+window.generation} state={structuredClone(window.appState)} reload={async()=>window.renderPage(window.page)} go={target=>{window.navigation=target;}}/></ToastHost>);};window.renderPage();"""
        build = "require('esbuild').buildSync(" + json.dumps({'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'bundle': True, 'platform': 'browser', 'format': 'iife', 'outfile': str(bundle), 'define': {'process.env.NODE_ENV': '"production"'}}) + ')'
        subprocess.run(['node', '-e', build], cwd=ROOT, check=True)
        packages = []
        for name in ['image-overlay', 'agent-pet', 'typing-effects', 'usage-statusline', 'proxy-request-status']:
            manifest = json.loads((ROOT / f'third_party/codexplusplus/materialized/extensions/{name}/codexpp.json').read_text(encoding='utf-8'))
            schema = manifest.get('config', {})
            packages.append({'id': 'bundled:' + name, 'name': manifest['name'], 'description': manifest['description'], 'source': 'bundled', 'version': manifest['version'], 'license': 'AGPL-3.0-only', 'installed': True, 'enabled': False, 'status': 'installed', 'configSchema': schema, 'config': {key: value.get('default') for key, value in schema.items()}})
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1380, 'height': 1100})
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: dialog.accept())
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate("""packages=>{
              window.generation=0;window.calls=[];window.fail={};window.navigation='';window.okToasts=[];
              new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node instanceof Element){if(node.matches('.toast.ok'))window.okToasts.push(node.textContent);for(const toast of node.querySelectorAll('.toast.ok'))window.okToasts.push(toast.textContent);}}).observe(document.getElementById('root'),{childList:true,subtree:true});
              window.ext={ok:true,upstream:{repository:'https://example.test/source',version:'2.6.9',revision:'fixture123',license:'AGPL-3.0-only'},client:{installed:true,version:'1',running:false},connection:{port:9222},runtime:{connected:false,applied:[],errors:[]},items:[...packages,
                {id:'builtin:unsupported',name:'暂不支持功能',description:'尚未适配',source:'builtin',installed:true,enabled:true,status:'unsupported',reason:'缺少原生接口'},
                {id:'public:new',name:'待安装插件',description:'公开插件',source:'public',installed:false,enabled:false,status:'available',version:'1',license:'MIT',tags:['special-search-tag'],requiresAuth:true,requiresRestart:true},
                {id:'public:update',name:'待更新插件',description:'目录提供新版本',source:'public',installed:true,enabled:false,status:'installed',version:'1',availableVersion:'2',updateAvailable:true,requiresRestart:true},
                {id:'full:missing',name:'缺失文件插件',description:'可修复',source:'full',installed:true,enabled:false,status:'installed',version:'1',missingFiles:true},
                {id:'full:removed',name:'已下架插件',description:'保留本机版本',source:'full',installed:true,enabled:true,status:'installed',version:'1',catalogMissing:true} ]};
              window.appState={plugins:[],builtinMiddleware:[{id:'system-prompt',name:'统一提示词',description:'追加提示词',defaultOptions:{text:'中文回答'}}]};
              window.assets=[{id:'skill:fixture',kind:'skill',name:'Fixture Skill',enabled:true,mutable:true,path:'/fixture/skills/demo'},{id:'plugin:fixture',kind:'plugin',name:'Native Plugin',enabled:true,mutable:false,path:'/fixture/plugins/demo'}];
              window.codexFlags={flags:{model_context_window:'272000',model_auto_compact_token_limit:'100000'},schema:[{key:'model_context_window',label:'上下文窗口',type:'number',hint:'保存后同步为窗口的90%'},{key:'model_auto_compact_token_limit',label:'自动压缩阈值',type:'number',hint:'可单独修改'}]};
              window.aurora={invoke:async(action,payload={})=>{
                window.calls.push({action,payload:structuredClone(payload)});
                if(window.fail[action])throw new Error(window.fail[action]);
                if(action==='extension.list')return structuredClone(window.ext);
                if(action==='extension.refresh'){
                  if(window.holdRefresh)await new Promise(resolve=>window.finishRefresh=resolve);
                  return window.refreshResult||{ok:true,message:'插件目录已更新',results:(payload.source?[payload.source]:['public','full']).map(source=>({source,ok:true,sourceType:'remote',count:2,fetchedAt:'2026-11-15T01:00:00Z'}))};
                }
                if(action==='extension.configure') {if(payload.port<1024)return {ok:false,message:'调试端口无效'};return {ok:true};}
                if(action==='extension.connect'){window.ext.runtime.connected=true;return {ok:true};}
                if(action==='extension.disconnect'){window.ext.runtime.connected=false;return {ok:true};}
                if(action==='app.chooseImage')return {ok:true,path:'C:/fixture/background.png'};
                if(action.startsWith('extension.')){const item=window.ext.items.find(x=>x.id===payload.id);if(!item)throw new Error('Unknown item');
                  if(action==='extension.config'){if(payload.config.opacity>100)return {ok:false,message:'opacity 数值超出范围'};item.config=payload.config;return {ok:true};}
                  if(action==='extension.install'){item.installed=true;item.enabled=false;item.status='installed';item.version=item.availableVersion||item.version;item.updateAvailable=false;item.missingFiles=false;return {ok:true,message:'已安装，启用后重启客户端生效'};}
                  if(action==='extension.toggle'){item.enabled=payload.enabled;return {ok:true};}
                  if(action==='extension.remove'){item.installed=false;item.enabled=false;item.status='available';return {ok:true};}}
                if(action==='plugin.sample')return 'function onRequest(ir, ctx) { return ir; }';
                if(action==='plugin.save'){const index=window.appState.plugins.findIndex(x=>x.id===payload.id);const record={...(index<0?{}:window.appState.plugins[index]),...payload,id:payload.id||'plg-fixture'};if(index<0)window.appState.plugins.push(record);else window.appState.plugins[index]=record;return record;}
                if(action==='plugin.delete'){window.appState.plugins=window.appState.plugins.filter(x=>x.id!==payload.id);return {ok:true};}
                if(action==='codex.assets')return window.badAssetResult?{ok:false,message:'资源目录不可读'}:{assets:structuredClone(window.assets)};
                if(action==='codex.flags')return structuredClone(window.codexFlags);
                if(action==='codex.setFlag'){
                  window.codexFlags.flags[payload.key]=payload.value;
                  if(payload.key==='model_context_window')window.codexFlags.flags.model_auto_compact_token_limit=payload.value?String(Math.floor(Number(payload.value)*0.9)):'';
                  return {ok:true,message:'已保存隔离测试配置'};
                }
                if(action==='codex.diagnose')return {ok:true,total:0,byProvider:[],samples:[]};
                if(action==='codex.toggleAsset'){window.assets.find(x=>x.id===payload.id).enabled=payload.enabled;return {ok:true,message:'设置已保存'};}
                throw new Error('Unexpected '+action);
              }};
            }""", packages)
            page.add_script_tag(path=str(bundle))
            expect(page.locator('.extension-card')).to_have_count(10)
            card = lambda name: page.locator('.extension-card').filter(has=page.get_by_role('heading', name=name, exact=True))
            page.evaluate("window.ext.items.push({id:'builtin:plugin-market-unlock',name:'插件市场解锁',description:'开放插件入口',source:'builtin',installed:true,enabled:true,status:'needs-connection'});window.generation++;window.renderPage()")
            feature = page.get_by_role('region', name='插件市场解锁快捷入口', exact=True)
            expect(feature).to_be_visible()
            expect(page.locator('.extension-card').first.get_by_role('heading')).to_have_text('插件市场解锁')
            expect(feature.get_by_text('连接桌面客户端后才会生效', exact=False)).to_be_visible()
            page.evaluate("window.fail['extension.connect']='请先退出正在运行的客户端'")
            feature.get_by_role('button', name='启动并连接', exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('请先退出正在运行的客户端')
            expect(feature.get_by_text('等待连接', exact=True)).to_be_visible()
            page.evaluate("delete window.fail['extension.connect'];window.ext.items.find(x=>x.id==='builtin:plugin-market-unlock').enabled=false;window.generation++;window.renderPage()")
            feature.get_by_role('button', name='启用并连接', exact=True).click()
            page.wait_for_function('window.ext.runtime.connected===true')
            toggled = page.evaluate("window.calls.filter(x=>x.action==='extension.toggle').at(-1)")
            assert toggled['payload'] == {'id': 'builtin:plugin-market-unlock', 'enabled': True}
            page.evaluate("window.ext.items.find(x=>x.id==='builtin:plugin-market-unlock').status='active';window.generation++;window.renderPage()")
            feature.get_by_role('button', name='浏览插件市场', exact=True).click()
            expect(page.get_by_role('button', name='公开市场 2', exact=True)).to_have_class('selected')
            checks.append('Plugin marketplace unlock is first, explains waiting status, retries connection failure and opens the public market only after active status')
            page.evaluate("window.ext.items=window.ext.items.filter(x=>x.id!=='builtin:plugin-market-unlock');window.ext.runtime.connected=false;window.generation++;window.renderPage()")
            page.get_by_role('button', name='官方拓展包 5', exact=True).click()
            expect(page.locator('.extension-card')).to_have_count(5)
            assert 'CODEX++' not in page.locator('main').inner_text().upper()
            expect(card('请求状态条').locator('.extension-description')).to_contain_text('请求经过云汇网关时')
            card('请求状态条').get_by_role('button', name='详情与来源 ↗', exact=True).click()
            request_detail = page.get_by_role('dialog', name='请求状态条', exact=True)
            expect(request_detail.get_by_text('AGPL-3.0-only', exact=True)).to_be_visible()
            assert 'CODEX++' not in request_detail.inner_text().upper()
            request_detail.get_by_role('button', name='关闭', exact=True).click()
            page.get_by_role('button', name='全部插件', exact=True).click()
            checks.append('All five bundled packages use product-facing descriptions while retaining their original license in details')
            card('背景图').get_by_role('button', name='设置', exact=True).click()
            dialog = page.get_by_role('dialog', name='背景图 · 插件设置', exact=True)
            dialog.get_by_role('button', name='选择图片', exact=True).click()
            expect(dialog.get_by_label('图片', exact=True)).to_have_value('C:/fixture/background.png')
            page.evaluate("window.fail['app.chooseImage']='图片选择器不可用'")
            dialog.get_by_role('button', name='选择图片', exact=True).click()
            expect(dialog.get_by_role('alert')).to_have_text('图片选择器不可用')
            page.evaluate("delete window.fail['app.chooseImage']")
            dialog.get_by_label('透明度（%）', exact=True).fill('999')
            dialog.get_by_role('button', name='保存设置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_have_text('opacity 数值超出范围')
            dialog.get_by_label('透明度（%）', exact=True).fill('45')
            dialog.get_by_role('button', name='保存设置', exact=True).click()
            expect(dialog).not_to_be_visible()
            assert page.evaluate("window.ext.items.find(x=>x.id==='bundled:image-overlay').config.opacity") == 45
            checks.append('Real upstream format:file exposes the image chooser; picker and validation failures remain inside the open modal')

            card('背景图').get_by_role('button', name='设置', exact=True).click()
            dialog.get_by_text('高级 JSON 配置', exact=True).click()
            dialog.get_by_label('桌面插件配置', exact=True).fill('{broken')
            before = page.evaluate("window.calls.filter(x=>x.action==='extension.config').length")
            dialog.get_by_role('button', name='保存设置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('不是有效 JSON')
            assert page.evaluate("window.calls.filter(x=>x.action==='extension.config').length") == before
            dialog.get_by_role('button', name='取消', exact=True).click()
            checks.append('Malformed advanced configuration is rejected locally without invoking the backend')

            card('打字特效').get_by_role('button', name='设置', exact=True).click()
            typing = page.get_by_role('dialog', name='打字特效 · 插件设置', exact=True)
            typing.get_by_role('button', name='移除插件', exact=True).click()
            expect(typing).not_to_be_visible()
            expect(card('打字特效').get_by_role('button', name='安装', exact=True)).to_be_visible()
            card('打字特效').get_by_role('button', name='安装', exact=True).click()
            expect(card('打字特效').get_by_role('switch')).not_to_be_checked()
            card('打字特效').get_by_role('switch').click()
            expect(card('打字特效').get_by_role('switch')).to_be_checked()
            page.evaluate("window.ext.items.find(x=>x.id==='bundled:typing-effects').status='error';window.ext.runtime.errors=[{id:'bundled:typing-effects',message:'原生输入框不存在'}]")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(card('打字特效').get_by_text('运行异常', exact=True)).to_be_visible()
            page.get_by_text('有 1 个扩展未能生效，查看原因', exact=True).click()
            expect(page.get_by_text('bundled:typing-effects：原生输入框不存在', exact=True)).to_be_visible()
            checks.append('Bundled extension removal and reinstall preserve explicit enablement while runtime errors never claim activation')

            card('Agent 桌宠').get_by_role('button', name='设置', exact=True).click()
            pet = page.get_by_role('dialog', name='Agent 桌宠 · 插件设置', exact=True)
            expect(pet.get_by_text('支持随附图片、动图与音效。自定义音效导入、大肥鱼余额及专项统计尚未接入。', exact=True)).to_be_visible()
            assert pet.get_by_label('大肥鱼余额接口', exact=True).count() == 0
            assert pet.get_by_label('自定义按压音', exact=True).count() == 0
            assert pet.get_by_label('音效组', exact=True).locator('option').all_text_contents() == ['鸭子音效', '特效音效']
            pet.get_by_role('button', name='取消', exact=True).click()
            checks.append('Pet settings disclose backend limitations and expose only supported native sound choices')

            disabled = card('暂不支持功能').get_by_role('switch')
            expect(disabled).to_be_enabled()
            disabled.click()
            expect(disabled).not_to_be_checked()
            expect(disabled).to_be_disabled()
            checks.append('Legacy unsupported enhancements can be disabled while unsupported enabling stays blocked')

            page.get_by_role('button', name='同步市场索引', exact=True).click()
            page.wait_for_function("window.calls.some(x=>x.action==='extension.refresh')")
            assert page.evaluate("window.calls.filter(x=>x.action==='extension.refresh').at(-1).payload") == {}
            page.get_by_role('button', name='完整索引 2', exact=True).click()
            page.get_by_role('button', name='同步市场索引', exact=True).click()
            page.wait_for_function("window.calls.filter(x=>x.action==='extension.refresh').length===2")
            assert page.evaluate("window.calls.filter(x=>x.action==='extension.refresh').at(-1).payload") == {'source': 'full'}
            page.get_by_role('button', name='全部插件', exact=True).click()
            page.get_by_label('搜索桌面插件', exact=True).fill(' special-search-tag ')
            expect(page.locator('.extension-card')).to_have_count(1)
            expect(card('待安装插件')).to_be_visible()
            page.get_by_label('搜索桌面插件', exact=True).fill('')
            checks.append('All-market refresh includes both catalogs, source refresh is scoped, and tag search ignores surrounding spaces')

            page.get_by_role('button', name='完整索引 2', exact=True).click()
            page.evaluate("window.fail['extension.refresh']='The operation was aborted due to timeout';window.beforeSyncToasts=window.okToasts.length")
            page.get_by_role('button', name='同步市场索引', exact=True).click()
            sync_notice = page.get_by_role('alert', name='市场同步状态', exact=True)
            expect(sync_notice).to_contain_text('连接插件市场超时，请检查网络或代理后重试。')
            expect(sync_notice).to_contain_text('完整索引 · 市场索引同步失败')
            assert 'The operation was aborted' not in sync_notice.inner_text()
            expect(sync_notice.get_by_role('button', name='重试同步', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='重新检测', exact=True)).to_have_count(0)
            expect(page.locator('.extension-card')).to_have_count(2)
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(sync_notice).to_contain_text('连接插件市场超时')
            assert page.evaluate('window.okToasts.length === window.beforeSyncToasts')
            checks.append('Market timeout is translated into Chinese, preserves the list, and stays separate from desktop/list refresh controls')

            page.get_by_role('button', name='公开市场 2', exact=True).click()
            page.evaluate("delete window.fail['extension.refresh'];window.holdRefresh=true;window.beforeSyncCalls=window.calls.filter(x=>x.action==='extension.refresh').length")
            sync_notice.get_by_role('button', name='重试同步', exact=True).evaluate('(button)=>{button.click();button.click();}')
            expect(page.get_by_role('button', name='同步中…', exact=True)).to_be_disabled()
            expect(page.get_by_role('status', name='市场同步状态', exact=True)).to_contain_text('正在同步完整索引')
            expect(page.get_by_role('button', name='刷新状态', exact=True)).to_be_disabled()
            expect(page.locator('.extension-card')).to_have_count(2)
            assert page.evaluate("window.calls.filter(x=>x.action==='extension.refresh').length === window.beforeSyncCalls+1")
            assert page.evaluate("window.calls.filter(x=>x.action==='extension.refresh').at(-1).payload") == {'source': 'full'}
            page.evaluate("window.holdRefresh=false;window.finishRefresh()")
            expect(page.get_by_role('status', name='市场同步状态', exact=True)).to_contain_text('完整索引：已更新远端索引')
            expect(page.get_by_role('button', name='同步市场索引', exact=True)).to_be_enabled()
            assert page.evaluate('window.okToasts.length === window.beforeSyncToasts+1')
            checks.append('Retry preserves the failed source after filter changes, synchronously blocks duplicate submissions, and shows an in-progress label')

            page.get_by_role('button', name='全部插件', exact=True).click()
            page.evaluate("""window.beforeSyncToasts=window.okToasts.length;window.refreshResult={ok:false,message:'部分市场未能联网',warning:'完整索引暂时无法联网',results:[{source:'public',ok:true,sourceType:'remote',count:2},{source:'full',ok:false,sourceType:'cache',count:245,fetchedAt:'2026-11-14T10:00:00Z',message:'The operation was aborted due to timeout'}]}""")
            page.get_by_role('button', name='同步市场索引', exact=True).click()
            expect(sync_notice).to_contain_text('部分市场索引已更新')
            expect(sync_notice).to_contain_text('公开市场：已更新远端索引 · 2 项')
            expect(sync_notice).to_contain_text('完整索引：使用本地缓存 · 245 项')
            expect(sync_notice).to_contain_text('缓存时间')
            expect(sync_notice).to_contain_text('可继续浏览已有条目')
            expect(page.locator('.extension-card')).to_have_count(10)
            assert page.evaluate('window.okToasts.length === window.beforeSyncToasts')
            checks.append('Partial market synchronization displays the updated source and dated usable cache without reporting full success')

            page.evaluate("""window.refreshResult={ok:true,message:'目录请求已完成',results:[{source:'public',ok:false,sourceType:'builtin',count:130},{source:'full',ok:false,sourceType:'cache',count:245,message:'Failed to fetch'}]}""")
            sync_notice.get_by_role('button', name='重试同步', exact=True).click()
            expect(sync_notice).to_contain_text('市场索引暂未更新')
            expect(sync_notice).to_contain_text('公开市场：使用随附离线索引 · 130 项')
            expect(sync_notice).to_contain_text('完整索引：使用本地缓存 · 245 项')
            expect(sync_notice).to_contain_text('暂时无法连接插件市场')
            assert page.evaluate('window.okToasts.length === window.beforeSyncToasts')
            checks.append('Offline cache and bundled indexes stay usable; per-source failure overrides an inconsistent top-level success flag')

            page.evaluate("window.refreshResult={ok:true,message:'目录已完成'}")
            sync_notice.get_by_role('button', name='重试同步', exact=True).click()
            expect(sync_notice).to_contain_text('已保留可用的本地索引和当前插件列表')
            assert page.evaluate('window.okToasts.length === window.beforeSyncToasts')
            page.evaluate("delete window.refreshResult;window.fail['extension.list']='本地列表暂不可读'")
            sync_notice.get_by_role('button', name='重试同步', exact=True).click()
            expect(page.get_by_role('status', name='市场同步状态', exact=True)).to_contain_text('市场索引已同步')
            expect(page.get_by_role('alert')).to_contain_text('插件列表刷新失败：本地列表暂不可读')
            expect(page.get_by_role('button', name='重试同步', exact=True)).to_have_count(0)
            expect(page.locator('.extension-card')).to_have_count(10)
            assert page.evaluate('window.okToasts.length === window.beforeSyncToasts')
            page.evaluate("delete window.fail['extension.list']")
            page.get_by_role('button', name='刷新列表', exact=True).click()
            expect(page.get_by_role('alert')).to_have_count(0)
            checks.append('Incomplete results never claim synchronization; a successful remote update with a failed local list refresh offers the correct separate retry')

            page.evaluate("window.fail['extension.list']='插件列表暂不可读'")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('插件列表暂不可读')
            expect(page.locator('.extension-card')).to_have_count(10)
            page.evaluate("delete window.fail['extension.list']")
            page.get_by_role('button', name='刷新列表', exact=True).click()
            expect(page.get_by_role('alert')).to_have_count(0)
            checks.append('A failed plugin list refresh retains visible installed entries and can recover without restarting')

            card('待安装插件').get_by_role('button', name='安装', exact=True).click()
            expect(card('待安装插件').get_by_role('switch')).not_to_be_checked()
            expect(card('待安装插件').get_by_text('已安装', exact=True)).to_be_visible()
            expect(card('待安装插件').get_by_text('需服务授权', exact=True)).to_be_visible()
            card('待安装插件').get_by_role('switch').click()
            expect(card('待安装插件').get_by_role('switch')).to_be_checked()
            checks.append('Market installation remains disabled until explicit enabling and preserves authorization and restart notices')

            expect(card('待更新插件').get_by_text('v1', exact=True)).to_be_visible()
            card('待更新插件').get_by_role('button', name='更新', exact=True).click()
            expect(card('待更新插件').get_by_text('v2', exact=True)).to_be_visible()
            expect(card('待更新插件').get_by_role('button', name='更新', exact=True)).to_have_count(0)
            expect(card('缺失文件插件').get_by_role('switch')).to_be_disabled()
            card('缺失文件插件').get_by_role('button', name='修复安装', exact=True).click()
            expect(card('缺失文件插件').get_by_role('switch')).to_be_enabled()
            checks.append('Installed version, update and missing-package repair actions follow the backend contract')

            removed = card('已下架插件')
            expect(removed.get_by_role('button', name='更新', exact=True)).to_have_count(0)
            removed.get_by_role('button', name='管理', exact=True).click()
            detail = page.get_by_role('dialog', name='已下架插件', exact=True)
            expect(detail.get_by_text('当前市场目录已不再收录此插件。已安装的版本仍可停用或移除。', exact=True)).to_be_visible()
            page.evaluate("window.fail['extension.remove']='原生配置写入失败'")
            detail.get_by_role('button', name='移除插件', exact=True).click()
            expect(detail.get_by_role('alert')).to_have_text('原生配置写入失败')
            page.evaluate("delete window.fail['extension.remove']")
            detail.get_by_role('button', name='移除插件', exact=True).click()
            expect(detail).not_to_be_visible()
            checks.append('Delisted plugins remain manageable and uninstall failures stay visible without dismissing details')

            page.get_by_role('button', name='连接设置', exact=True).click()
            connection = page.get_by_role('dialog', name='连接 ChatGPT 桌面版', exact=True)
            connection.get_by_label('桌面调试端口', exact=True).fill('100')
            connection.get_by_role('button', name='保存连接设置', exact=True).click()
            expect(connection.get_by_role('alert')).to_have_text('调试端口无效')
            connection.get_by_role('button', name='取消', exact=True).click()
            page.evaluate("window.ext.client.versionChanged=true;window.ext.client.version='2'")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(page.get_by_role('button', name='启动并连接', exact=True)).to_be_disabled()
            page.get_by_role('checkbox').check()
            expect(page.get_by_role('button', name='启动并连接', exact=True)).to_be_enabled()
            page.evaluate("window.ext.client.version='3'")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(page.get_by_role('checkbox')).not_to_be_checked()
            expect(page.get_by_role('button', name='启动并连接', exact=True)).to_be_disabled()
            checks.append('Connection validation stays in its modal and a new client version requires a new compatibility acknowledgement')

            page.get_by_role('button', name='网关中间件', exact=True).click()
            page.get_by_role('button', name='新建插件', exact=True).click()
            custom = page.get_by_role('dialog', name='编辑自定义插件', exact=True)
            custom.get_by_label('插件名称', exact=True).fill('可用中间件')
            custom.get_by_label('中间件参数', exact=True).fill('[]')
            custom.get_by_role('button', name='保存配置', exact=True).click()
            expect(custom.get_by_role('alert')).to_contain_text('JSON 对象')
            custom.get_by_label('中间件参数', exact=True).fill('{"text":"fixture"}')
            page.evaluate("window.fail['plugin.save']='中间件保存失败'")
            custom.get_by_role('button', name='保存配置', exact=True).click()
            expect(custom.get_by_role('alert')).to_have_text('中间件保存失败')
            page.evaluate("delete window.fail['plugin.save']")
            custom.get_by_role('button', name='保存配置', exact=True).click()
            expect(custom).not_to_be_visible()
            expect(page.get_by_role('switch', name='启用可用中间件', exact=True)).not_to_be_checked()
            page.get_by_role('switch', name='启用可用中间件', exact=True).click()
            expect(page.get_by_role('switch', name='启用可用中间件', exact=True)).to_be_checked()
            assert page.evaluate("window.calls.filter(x=>x.action==='plugin.save').at(-1).payload") == {'id': 'plg-fixture', 'enabled': True}
            expect(page.get_by_text('等待请求验证', exact=True)).to_be_visible()
            page.evaluate("window.appState.middlewareStatus={'plg-fixture':{status:'error',checkedAt:'2026-11-15T01:00:00Z',message:'中间件执行失败，已保留原请求'}};window.renderPage()")
            expect(page.get_by_text('最近运行失败', exact=True)).to_be_visible()
            expect(page.get_by_text('中间件执行失败，已保留原请求', exact=True)).to_be_visible()
            page.evaluate("window.appState.middlewareStatus['plg-fixture'].status='blocked';window.appState.middlewareStatus['plg-fixture'].message='已按配置拦截';window.renderPage()")
            expect(page.get_by_text('最近请求被拦截', exact=True)).to_be_visible()
            page.evaluate("window.appState.middlewareStatus['plg-fixture'].status='ok';window.appState.middlewareStatus['plg-fixture'].message='';window.renderPage()")
            expect(page.get_by_text('最近运行正常', exact=True)).to_be_visible()
            assert page.locator('.middleware-status time').get_attribute('datetime') == '2026-11-15T01:00:00Z'
            page.get_by_role('switch', name='启用可用中间件', exact=True).click()
            expect(page.get_by_role('switch', name='启用可用中间件', exact=True)).not_to_be_checked()
            expect(page.get_by_text('最近运行正常', exact=True)).to_have_count(0)
            assert page.evaluate("window.calls.filter(x=>x.action==='plugin.save').at(-1).payload") == {'id': 'plg-fixture', 'enabled': False}
            checks.append('Custom middleware validates JSON, displays backend save errors in the editor and starts disabled')
            checks.append('Middleware separates enabled state from waiting, successful, failed and blocked execution with verification time')

            page.get_by_role('button', name='删除可用中间件', exact=True).click()
            deletion = page.get_by_role('dialog', name='删除「可用中间件」？', exact=True)
            page.evaluate("window.fail['plugin.delete']='删除失败'")
            deletion.get_by_role('button', name='删除插件', exact=True).click()
            expect(deletion.get_by_role('alert')).to_have_text('删除失败')
            page.evaluate("delete window.fail['plugin.delete']")
            deletion.get_by_role('button', name='删除插件', exact=True).click()
            expect(deletion).not_to_be_visible()
            expect(page.get_by_role('switch', name='启用可用中间件', exact=True)).to_have_count(0)
            checks.append('Custom middleware deletion keeps failure visible and removes the card only after success')

            page.evaluate("window.renderPage('codex')")
            expect(page.get_by_role('switch', name='启用Fixture Skill', exact=True)).to_be_checked()
            page.get_by_role('switch', name='启用Fixture Skill', exact=True).click()
            expect(page.get_by_role('switch', name='启用Fixture Skill', exact=True)).not_to_be_checked()
            page.get_by_role('button', name='管理云汇插件 →', exact=True).click()
            assert page.evaluate('window.navigation') == 'plugins'
            page.evaluate('window.badAssetResult=true')
            page.get_by_role('button', name='重新检测', exact=True).click()
            expect(page.get_by_role('alert')).to_have_text('资源读取失败：资源目录不可读')
            expect(page.get_by_text('Native Plugin', exact=True)).to_be_visible()
            checks.append('Workspace asset failure preserves the last list and the native-plugin card links to managed plugins')

            page.get_by_role('button', name='高级设置', exact=True).click()
            window_field = page.locator('.field').filter(has=page.get_by_text('上下文窗口', exact=True))
            threshold_field = page.locator('.field').filter(has=page.get_by_text('自动压缩阈值', exact=True))
            window_input = window_field.get_by_role('textbox')
            threshold_input = threshold_field.get_by_role('textbox')
            window_save = window_field.get_by_role('button', name='保存', exact=True)
            expect(window_save).to_be_enabled()
            expect(page.locator('#codex-context-compact-hint')).to_have_text('自动压缩：244800 tokens（90%）')
            threshold_input.fill('150000')
            window_input.fill('300000')
            expect(page.locator('#codex-context-compact-hint')).to_have_text('自动压缩：270000 tokens（90%）')
            expect(threshold_input).to_have_value('150000')
            page.evaluate("window.fail['codex.setFlag']='配置保存失败'")
            window_save.click()
            expect(page.locator('.toast.bad').last).to_contain_text('配置保存失败')
            expect(threshold_input).to_have_value('150000')
            page.evaluate("delete window.fail['codex.setFlag']")
            window_input.fill('272000')
            expect(window_save).to_be_enabled()
            window_save.click()
            expect(threshold_input).to_have_value('244800')
            expect(window_save).to_be_disabled()
            page.evaluate("window.codexFlags.flags={model_context_window:'',model_auto_compact_token_limit:'100000'}")
            page.get_by_role('button', name='重新检测', exact=True).click()
            expect(window_input).to_have_value('')
            expect(window_save).to_be_enabled()
            expect(page.locator('#codex-context-compact-hint')).to_have_count(0)
            window_save.click()
            expect(threshold_input).to_have_value('')
            expect(window_save).to_be_disabled()
            checks.append('Saving an unchanged context repairs a stale 90 percent threshold; typing or failed saves preserve manual drafts, and an empty window can clear a leftover threshold')

            page.evaluate("window.aurora=undefined;window.generation++;window.renderPage('plugins')")
            expect(page.get_by_text('请在电脑上管理桌面插件', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='启动并连接', exact=True)).to_have_count(0)
            page.get_by_role('button', name='网关中间件', exact=True).click()
            expect(page.get_by_role('button', name='新建插件', exact=True)).to_be_disabled()
            expect(page.get_by_role('switch')).to_have_count(0)
            assert not errors, errors
            checks.append('Remote mode exposes no desktop mutation controls or editable middleware scripts; no renderer exceptions')
            browser.close()
            report = {'passed': True, 'count': len(checks), 'checks': checks, 'scope': 'Chromium UI with real bundled manifest schemas and controlled IPC responses; no real client injection or downloads'}
            (ROOT / 'docs/PLUGIN-UI-VALIDATION.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
