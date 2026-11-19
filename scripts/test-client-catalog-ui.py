"""Focused client setup and live catalog UI regression; isolated IPC and no downloads."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-client-catalog-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Agents from './ui/src/pages/Agents.tsx';import Providers from './ui/src/pages/Providers.tsx';import Catalog from './ui/src/pages/Catalog.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));const pages={agents:Agents,providers:Providers,catalog:Catalog};
window.renderPage=(page=window.page||'agents')=>{window.page=page;const Page=pages[page];root.render(<ToastHost key={page+window.generation}><Page state={structuredClone(window.state)} reload={async()=>{window.reloads++;window.renderPage();}} go={page=>window.navigation=page}/></ToastHost>);};"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'},
                   'bundle': True, 'platform': 'browser', 'format': 'iife', 'outfile': str(bundle),
                   'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1280, 'height': 1050})
            context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body='<html><main id="root" style="padding:24px"></main></html>') if route.request.url == 'https://fixture.test/' else route.abort())
            page = context.new_page()
            page.set_default_timeout(3500)
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto('https://fixture.test/')
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate("""()=>{
              window.generation=0;
              window.reset=()=>{
                window.generation++;window.calls=[];window.reloads=0;window.navigation='';window.discovery='ok';window.scanOk=true;window.importResult={ok:true,added:1,merged:0};window.holdImport=false;window.holdNextCatalog=false;window.pendingCatalog=[];window.holdPreview=false;window.connectFailure='';
                const provider={key:'fixture',name:'测试预设',vendor:'Fixture',format:'openai-chat',baseUrl:'https://fixture.invalid/v1',region:'cn',models:[{id:'preset-model',contextWindow:64000}]};
                window.catalog={ok:true,version:1,source:'cache',syncing:true,warning:'更新暂不可用，保留本地缓存',updatedAt:'2026-11-15T01:00:00Z',fetchedAt:'old',providers:[provider]};
                window.state={settings:{},providers:[],presets:[{...provider,id:provider.key,nameZh:provider.name}],catalog:{version:1,source:'cache',syncing:true,fetchedAt:'old'},agents:{},detected:{},agentCatalog:[{id:'codex-cli',name:'Codex CLI',vendor:'OpenAI',description:'Fixture client',support:'automatic',protocol:'openai-responses',category:'cli'}],codexCoexist:{identity:{available:false},warnings:[],models:[]},localClients:{ok:true,checkedAt:'',accounts:[],sources:[],warnings:[],added:0,updated:0}};
              };
              window.reset();
              window.aurora={invoke:async(action,payload={})=>{
                window.calls.push({action,payload:structuredClone(payload)});
                if(action==='provider.save'){
                  const index=window.state.providers.findIndex(p=>p.id===payload.id);
                  const saved={...(index<0?{}:window.state.providers[index]),...payload,id:payload.id||'saved-'+window.state.providers.length};
                  if(index<0)window.state.providers.push(saved);else window.state.providers[index]=saved;
                  return structuredClone(saved);
                }
                if(action==='provider.models'){
                  if(window.discovery==='reject')throw Error('模型请求连接中断');
                  if(window.discovery==='unavailable')return {ok:false,message:'服务商未开放模型接口'};
                  const p=window.state.providers.find(p=>p.id===payload.providerId);if(!p.models.some(m=>m.id==='fresh-model'))p.models.push({id:'fresh-model'});
                  return {ok:true,models:structuredClone(p.models),added:1};
                }
                if(action==='agent.preview'){
                  const p=window.state.providers.find(p=>p.id===payload.providerId);
                  if(payload.providerId!=='official'&&!p.models.some(m=>m.id===payload.model))throw Error('Model was not saved before preview');
                  if(window.holdPreview)await new Promise(resolve=>window.finishPreview=resolve);
                  return {ok:true,revision:'fixture-preview',files:[{path:'C:/fixture/config.toml',before:'',after:'fixture'}],warnings:[]};
                }
                if(action==='agent.connect')return window.connectFailure?{ok:false,message:window.connectFailure}:{ok:true,message:'配置已应用'};
                if(action==='localClients.scan')return {ok:window.scanOk,warnings:window.scanOk?[]:['部分配置读取失败，请检查文件权限']};
                if(action==='agent.detect')return {};
                if(action==='cloud.catalog'){
                  const result=structuredClone(window.catalog);
                  if(window.holdNextCatalog){window.holdNextCatalog=false;await new Promise(resolve=>window.pendingCatalog.push(resolve));}
                  return result;
                }
                if(action==='cloud.import'){if(window.holdImport)await new Promise(resolve=>window.finishImport=resolve);return structuredClone(window.importResult);}
                throw Error('Unexpected action '+action);
              }};
            }""")
            page.add_script_tag(path=str(bundle))

            def reset(which='agents'):
                page.evaluate('which=>{window.reset();window.renderPage(which)}', which)

            def wizard():
                page.get_by_role('button', name='开始配置 →', exact=True).click()
                return page.get_by_role('dialog', name='配置 Codex CLI', exact=True)

            def fill_new(dialog):
                dialog.get_by_title('测试预设 · Fixture', exact=True).click()
                dialog.get_by_label('API Key', exact=True).fill('fixture-api-key')
                dialog.get_by_role('button', name='保存并选模型 →', exact=True).click()

            reset(); dialog = wizard(); fill_new(dialog)
            expect(dialog.get_by_label('选择模型', exact=True)).to_be_visible()
            assert dialog.get_by_label('选择模型', exact=True).locator('option').all_text_contents() == ['请选择模型', 'preset-model · 64K 上下文', 'fresh-model']
            assert page.evaluate("window.calls.filter(c=>c.action==='provider.models').length") == 1
            expect(dialog.get_by_label('选择模型', exact=True)).to_have_value('preset-model')
            checks.append('A provider created from a nonempty preset synchronizes upstream models and preserves the selected preset model')

            page.evaluate("window.holdPreview=true")
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_label('选择模型', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('button', name='手动输入其他模型 ID', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(dialog).to_be_visible()
            page.evaluate("window.finishPreview();window.holdPreview=false;window.connectFailure='配置已被其他程序修改，请重新预览'")
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('配置已被其他程序修改，请重新预览')
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_have_count(0)
            expect(dialog.get_by_label('选择模型', exact=True)).to_be_enabled()
            dialog.get_by_label('选择模型', exact=True).select_option('fresh-model')
            page.evaluate("window.connectFailure=''")
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            assert page.evaluate("window.calls.filter(c=>c.action==='agent.connect').at(-1).payload.model") == 'fresh-model'
            assert page.evaluate("window.calls.filter(c=>c.action==='agent.connect').at(-1).payload.revision") == 'fixture-preview'
            checks.append('Pending client preview locks model edits; failed application requires a fresh reviewed selection and revision')

            for failure in ['unavailable', 'reject']:
                reset(); page.evaluate('value=>window.discovery=value', failure); dialog = wizard(); fill_new(dialog)
                expect(dialog.get_by_label('选择模型', exact=True)).to_be_visible()
                expect(dialog.get_by_role('alert')).to_contain_text('供应商已保存，模型列表暂未同步')
                assert page.evaluate('window.state.providers.length') == 1
                dialog.get_by_role('button', name='手动输入其他模型 ID', exact=True).click()
                manual = dialog.get_by_label('手动模型 ID', exact=True)
                manual.fill('')
                expect(dialog.get_by_role('button', name='预览配置 →', exact=True)).to_be_disabled()
                manual.fill('not-in-preset')
                dialog.get_by_role('button', name='预览配置 →', exact=True).click()
                expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_visible()
                assert page.evaluate('window.state.providers.length') == 1
                calls = page.evaluate("window.calls.filter(c=>['provider.save','agent.preview'].includes(c.action))")
                assert [c['action'] for c in calls] == ['provider.save', 'provider.save', 'agent.preview']
                assert calls[-1]['payload']['model'] == 'not-in-preset'
                assert calls[-2]['payload']['id'] == calls[-1]['payload']['providerId']
                checks.append(f'{failure} model discovery keeps the saved provider usable; manual IDs are saved before preview without duplicate providers')

            reset()
            page.evaluate("window.state.codexCoexist={identity:{available:true},warnings:[],models:[{official:true,upstreamModel:'official-model'}]};window.renderPage()")
            dialog = wizard()
            dialog.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
            expect(dialog.get_by_role('button', name='手动输入其他模型 ID', exact=True)).to_have_count(0)
            expect(dialog.get_by_label('手动模型 ID', exact=True)).to_have_count(0)
            checks.append('Official-account models stay restricted to the verified native model catalog')

            reset(); page.evaluate('window.scanOk=false')
            page.get_by_role('button', name='检测本地客户端', exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('部分配置读取失败，请检查文件权限')
            expect(page.locator('.toast.ok')).to_have_count(0)
            page.get_by_role('button', name='查看本机扫描详情', exact=True).click()
            assert page.evaluate('window.navigation') == 'providers'
            page.evaluate('window.scanOk=true')
            page.get_by_role('button', name='检测本地客户端', exact=True).click()
            expect(page.get_by_role('alert')).to_have_count(0)
            expect(page.locator('.toast.ok')).to_contain_text('本地客户端与已有供应商配置已更新')
            checks.append('Partial local scan failures remain visible, link to scan details and only report success after recovery')

            def next_catalog():
                page.evaluate("""()=>{window.catalog={...window.catalog,version:2,source:'remote',syncing:false,warning:'',fetchedAt:'new',providers:[{...window.catalog.providers[0],key:'new',name:'新目录服务'}]};window.state.catalog={version:2,source:'remote',syncing:false,fetchedAt:'new'};window.renderPage();}""")

            reset('providers')
            page.get_by_role('button', name='云端目录', exact=True).click()
            cloud = page.get_by_role('dialog', name='云端目录', exact=True)
            expect(cloud.get_by_text('更新暂不可用，保留本地缓存', exact=True)).to_be_visible()
            expect(cloud.locator('.sub')).to_contain_text('本地缓存')
            cloud.get_by_text('测试预设', exact=True).click()
            next_catalog()
            expect(cloud.get_by_text('新目录服务', exact=True)).to_be_visible()
            expect(cloud.get_by_text('测试预设', exact=True)).to_have_count(0)
            expect(cloud.get_by_role('button', name='导入选中的 0 家', exact=True)).to_be_disabled()
            expect(cloud.get_by_text('更新暂不可用，保留本地缓存', exact=True)).to_have_count(0)
            cloud.get_by_role('button', name='刷新目录', exact=True).click()
            page.wait_for_function("window.calls.some(c=>c.action==='cloud.catalog'&&c.payload.refresh===true)")
            checks.append('Cloud import shows cache warnings, follows background catalog updates, drops removed selections and supports explicit refresh')

            cloud.get_by_text('新目录服务', exact=True).click()
            page.evaluate("window.importResult={ok:false,message:'目录导入写入失败'}")
            cloud.get_by_role('button', name='导入选中的 1 家', exact=True).click()
            expect(cloud.get_by_role('alert')).to_have_text('目录导入写入失败')
            expect(cloud).to_be_visible()
            expect(cloud.get_by_role('button', name='导入选中的 1 家', exact=True)).to_be_enabled()
            expect(page.locator('.toast.ok')).to_have_count(0)
            page.evaluate('window.importResult={ok:true,added:1,merged:0};window.holdImport=true')
            cloud.get_by_role('button', name='导入选中的 1 家', exact=True).click()
            importing = cloud.get_by_role('button', name='正在导入…', exact=True)
            expect(importing).to_be_disabled(); importing.evaluate('node=>{node.click();node.click()}')
            expect(cloud.get_by_role('button', name='关闭', exact=True)).to_be_disabled()
            assert page.evaluate("window.calls.filter(c=>c.action==='cloud.import').length") == 2
            page.evaluate('window.finishImport()')
            expect(cloud).not_to_be_visible()
            expect(page.locator('.toast.ok')).to_contain_text('导入完成：新增 1 家')
            checks.append('Failed cloud imports preserve the dialog and selection; retry disables duplicate requests and closes only after success')

            reset('providers'); page.evaluate('window.holdNextCatalog=true')
            page.get_by_role('button', name='云端目录', exact=True).click()
            cloud = page.get_by_role('dialog', name='云端目录', exact=True)
            page.wait_for_function('window.pendingCatalog.length===1')
            cloud.get_by_role('button', name='关闭', exact=True).click()
            page.evaluate('window.pendingCatalog[0]()')
            expect(cloud).not_to_be_visible()
            checks.append('Closing a loading catalog prevents its late response from reopening the modal')

            reset('catalog')
            expect(page.get_by_role('heading', name='测试预设', exact=True)).to_be_visible()
            page.get_by_label('选择 测试预设', exact=True).check()
            next_catalog()
            expect(page.get_by_role('heading', name='新目录服务', exact=True)).to_be_visible()
            expect(page.get_by_role('heading', name='测试预设', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='添加所选', exact=True)).to_be_disabled()
            checks.append('The vendor directory follows completed startup synchronization without a manual refresh and removes stale selections')

            reset('catalog')
            expect(page.get_by_role('heading', name='测试预设', exact=True)).to_be_visible()
            page.evaluate('window.holdNextCatalog=true')
            page.get_by_role('button', name='刷新目录', exact=True).click()
            page.wait_for_function('window.pendingCatalog.length===1')
            next_catalog()
            expect(page.get_by_role('heading', name='新目录服务', exact=True)).to_be_visible()
            page.evaluate('window.pendingCatalog[0]()')
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            expect(page.get_by_role('heading', name='新目录服务', exact=True)).to_be_visible()
            expect(page.get_by_role('heading', name='测试预设', exact=True)).to_have_count(0)
            checks.append('A late stale directory response cannot overwrite a newer background snapshot')

            # Use the real shipped directory in reverse order to exercise presentation after remote updates.
            catalog_entries = json.loads((ROOT / 'server/seed-catalog.json').read_text(encoding='utf-8'))['providers']
            reset('catalog')
            page.evaluate("""providers=>{
              window.catalog={...window.catalog,providers:[...providers].reverse(),version:3,source:'remote',syncing:false,warning:'',fetchedAt:'ordered-3'};
              window.state.presets=window.catalog.providers.map(p=>({...p,id:p.key,nameZh:p.name,models:p.models||[]}));
              window.state.catalog={version:3,source:'remote',syncing:false,fetchedAt:'ordered-3'};window.renderPage();
            }""", catalog_entries)
            names = page.locator('.catalog-card h3')
            expect(names).to_have_count(len(catalog_entries))
            assert names.all_text_contents()[:3] == ['OpenAI', 'Anthropic Claude', 'Google Gemini']
            ordered = names.all_text_contents()
            assert ordered.index('xAI Grok') < ordered.index('深度求索') < ordered.index('云汇AI 官方中转') < ordered.index('Ollama 本地')
            assert ordered.index('云汇AI 官方中转') < ordered.index('OpenRouter')
            page.get_by_label('搜索厂商或模型').fill('ChatGPT')
            expect(names.first).to_have_text('OpenAI')
            page.get_by_label('搜索厂商或模型').fill('Claude')
            page.get_by_role('button', name='国际服务', exact=True).click()
            expect(names).to_have_text(['Anthropic Claude'])
            page.get_by_label('选择 Anthropic Claude', exact=True).check()
            page.evaluate("""()=>{
              window.catalog={...window.catalog,providers:[...window.catalog.providers].reverse(),version:4,fetchedAt:'ordered-4'};
              window.state.catalog={...window.state.catalog,version:4,fetchedAt:'ordered-4'};window.renderPage();
            }""")
            expect(page.locator('.page-footnote')).to_contain_text('目录 v4')
            expect(names).to_have_text(['Anthropic Claude'])
            expect(page.get_by_label('选择 Anthropic Claude', exact=True)).to_be_checked()
            expect(page.get_by_label('搜索厂商或模型')).to_have_value('Claude')
            page.get_by_role('button', name='全部厂商', exact=True).click()
            page.get_by_label('搜索厂商或模型').fill('')
            assert names.all_text_contents() == ordered
            checks.append('Real directory keeps OpenAI, Anthropic and Gemini first, then international/domestic/relay/local groups across reordered remote updates; filters and selection survive')

            page.evaluate("window.renderPage('agents')")
            dialog = wizard()
            assert dialog.locator('.preset-item .ellipsis').all_text_contents()[:3] == ['OpenAI', 'Anthropic Claude', 'Google Gemini']
            dialog.get_by_label('搜索供应商预设').fill('ChatGPT')
            expect(dialog.locator('.preset-item .ellipsis')).to_have_text(['OpenAI'])
            dialog.get_by_role('button', name='国际', exact=True).click()
            expect(dialog.locator('.preset-item .ellipsis')).to_have_text(['OpenAI'])
            checks.append('Shared client/provider preset picker uses the same priority and finds the OpenAI preset by ChatGPT alias')

            page.evaluate("window.renderPage('providers')")
            page.get_by_role('button', name='云端目录', exact=True).click()
            cloud = page.get_by_role('dialog', name='云端目录', exact=True)
            expect(cloud.locator('.cloud-item')).to_have_count(len(catalog_entries))
            assert cloud.locator('.cloud-item .ellipsis').all_text_contents()[0:6:2] == ['OpenAI', 'Anthropic Claude', 'Google Gemini']
            checks.append('Cloud-import chooser presents the same international-first order without changing imported data')

            assert not errors, errors
            checks.append('No renderer exceptions or real client/configuration/network actions occurred')
            browser.close()
            report = {'passed': True, 'count': len(checks), 'checks': checks, 'scope': 'Real React components with controlled IPC; no real client, provider or published catalog changes'}
            (ROOT / 'docs/CLIENT-CATALOG-UI-VALIDATION.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
