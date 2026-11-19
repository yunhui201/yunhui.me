"""Management UI failures and delayed IPC responses; no real client files or services."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-management-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Settings from './ui/src/pages/Settings.tsx';import Groups from './ui/src/pages/Groups.tsx';import Providers from './ui/src/pages/Providers.tsx';import Models from './ui/src/pages/Models.tsx';import Membership from './ui/src/pages/Membership.tsx';import Usage from './ui/src/pages/Usage.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));const pages={Settings,Groups,Providers,Models,Membership,Usage};
window.renderPage=()=>{const Page=pages[window.page];root.render(<ToastHost key={window.generation}><Page state={structuredClone(window.state)} reload={async()=>{window.reloads++;window.renderPage();}} go={target=>window.navigation=target}/></ToastHost>);};"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 1100})
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: dialog.accept())
            page.set_content('<html data-theme="light"><main id="root"></main></html>')
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate("""()=>{
              window.generation=0;window.calls=[];window.reloads=0;window.responses={};window.fail={};window.defer={};window.pending={};
              window.provider={id:'p1',name:'测试供应商',format:'openai-chat',baseUrl:'https://fixture.invalid/v1',enabled:true,priority:10,apiKeys:[],models:[{id:'model-a'},{id:'model-b'}]};
              window.fixture={version:'0.6.0',platform:'win32',dataDir:'fixture',gatewayUrl:'http://127.0.0.1:3425',gateway:{running:true},groups:[],providers:[window.provider],presets:[],agents:{},settings:{theme:'light',accent:'#4f66e8',gatewayPort:3425,gatewayHost:'127.0.0.1',gatewayToken:'fixture-token',proxy:'',requestTimeoutMs:60000,maxRetries:2,usageRetentionDays:90,autoSyncModels:true}};
              window.reset=name=>{window.page=name;window.generation++;window.state=structuredClone(window.fixture);window.calls=[];window.responses={};window.fail={};window.defer={};window.pending={};window.navigation='';window.renderPage();};
              window.aurora={onUsage:()=>()=>{},invoke:async(action,payload={})=>{
                window.calls.push({action,payload:structuredClone(payload)});
                if(window.defer[action]) return new Promise((resolve,reject)=>{window.pending[action]={resolve,reject};});
                if(window.fail[action])throw Error(window.fail[action]);
                if(Object.hasOwn(window.responses,action))return structuredClone(window.responses[action]);
                if(action==='settings.save'){Object.assign(window.state.settings,payload);return window.state.settings;}
                if(action==='provider.save'){const saved={...window.provider,...payload,id:payload.id||'created-provider'};window.state.providers=[saved];return structuredClone(saved);}
                if(action==='provider.models')return {ok:true,added:0,models:[]};
                if(action==='group.save')return {...payload,id:payload.id||'created-group'};
                if(action==='group.delete'||action==='provider.delete')return {ok:true};
                if(action==='model.batch.preview')return {ok:true,revision:'reviewed-revision',count:payload.items.length,conflicts:[]};
                if(action==='model.batch.apply')return {ok:false,message:'模型目录已变化，请重新预览'};
                if(action==='member.status')return {ok:true,loggedIn:true,config:{enabled:true},member:{email:'fixture@example.test'},gift:{}};
                if(action==='member.groups')return {ok:true,groups:[{id:7,name:'默认',platform:'test',supported:true}]};
                if(action==='member.addProvider')return {ok:true,providerId:'member-provider',message:'供应商已添加'};
                if(action==='usage.live')return [];
                if(action==='usage.summary')return {totals:{calls:2,cost:0,unpricedCalls:1,inputTokens:10,outputTokens:10,errors:0},byDay:[],byProvider:[],byModel:[],byAgent:[]};
                if(action==='usage.recent')return [{requestId:'unknown',ts:'2026-11-15',status:200,model:'a',requestModel:'a',cost:0,costKnown:false},{requestId:'free',ts:'2026-11-15',status:200,model:'free',requestModel:'free',cost:0,costKnown:true}];
                throw Error('Unexpected RPC '+action);
              }};
            }""")
            page.add_script_tag(path=str(bundle))

            page.evaluate("window.reset('Settings')")
            page.get_by_role('button', name='深夜', exact=True).click()
            page.evaluate("window.state.settings.gatewayPort=4567;window.state.settings.gatewayToken='new-remote-token';window.state.settings.proxy='http://new-proxy.test';window.renderPage()")
            page.get_by_role('button', name='保存设置', exact=True).click()
            page.wait_for_function("window.calls.some(x=>x.action==='settings.save')")
            assert page.evaluate("window.calls.find(x=>x.action==='settings.save').payload") == {'theme': 'dark'}
            page.get_by_role('button', name='网关与隐私', exact=True).click()
            expect(page.get_by_label('网关端口')).to_have_value('4567')
            expect(page.get_by_label('网关访问令牌')).to_have_value('new-remote-token')
            expect(page.get_by_text('用量保留天数', exact=True)).to_have_count(0)
            checks.append('Saving a dirty settings field preserves concurrently refreshed port, token and proxy; inactive retention control is hidden')

            page.get_by_role('button', name='外观与启动', exact=True).click()
            page.get_by_role('button', name='云白', exact=True).click()
            page.get_by_role('button', name='数据与关于', exact=True).click()
            page.evaluate("window.responses['app.import']={ok:false}")
            page.get_by_role('button', name='导入配置', exact=True).click()
            expect(page.get_by_text('有未保存的修改', exact=True)).to_be_visible()
            page.evaluate("window.fail['app.export']='备份文件不可写'")
            page.get_by_role('button', name='导出配置', exact=True).click()
            expect(page.locator('.toast.bad')).to_contain_text('备份文件不可写')
            checks.append('Canceled import keeps unsaved settings and export write failures stay visible')

            page.evaluate("window.reset('Groups');window.defer['group.save']=true")
            page.get_by_role('button', name='新建分组', exact=True).click()
            group = page.get_by_role('dialog', name='新建分组', exact=True)
            group.get_by_label('分组名', exact=True).fill('coding')
            group.get_by_role('button', name='保存', exact=True).click()
            expect(group.get_by_label('分组名', exact=True)).to_be_disabled()
            expect(group.get_by_role('button', name='保存中…', exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(group).to_be_visible()
            page.evaluate("delete window.defer['group.save'];window.pending['group.save'].reject(Error('分组成员无效'))")
            expect(group.get_by_role('alert')).to_have_text('分组成员无效')
            expect(group.get_by_label('分组名', exact=True)).to_have_value('coding')
            group.get_by_role('button', name='保存', exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            assert page.evaluate("window.calls.filter(x=>x.action==='group.save').length") == 2
            checks.append('Group saves lock editing and closing, display validation errors, and preserve the draft for one explicit retry')

            page.evaluate("window.reset('Groups');window.state.groups=[{id:'g1',name:'coding',mode:'order',members:[],enabled:true}];window.fail['group.delete']='分组仍被引用';window.renderPage()")
            page.get_by_title('删除分组 coding', exact=True).click()
            expect(page.get_by_role('alert')).to_have_text('分组仍被引用')
            page.get_by_role('switch', name='启用分组 coding', exact=True).click()
            page.wait_for_function("window.calls.some(x=>x.action==='group.save')")
            assert page.evaluate("window.calls.find(x=>x.action==='group.save').payload") == {'id': 'g1', 'enabled': False}
            checks.append('Group deletion failures remain visible and toggling sends only the enabled field')

            page.evaluate("window.reset('Providers');window.defer['provider.models']=true")
            page.get_by_role('button', name='添加供应商', exact=True).click()
            provider = page.get_by_role('dialog')
            provider.locator('input.input').first.fill('新建测试')
            provider.get_by_role('button', name='从上游拉取', exact=True).click()
            page.wait_for_function("!!window.pending['provider.models']")
            expect(provider.locator('input.input').first).to_be_disabled()
            expect(provider.get_by_role('button', name='保存', exact=True)).to_be_disabled()
            expect(provider.get_by_role('button', name='取消', exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(provider).to_be_visible()
            page.evaluate("delete window.defer['provider.models'];window.pending['provider.models'].reject(Error('网络中断'))")
            expect(provider.get_by_role('alert')).to_contain_text('供应商已保存，但模型同步失败：网络中断')
            provider.get_by_role('button', name='保存', exact=True).click()
            expect(provider).not_to_be_visible()
            saved = page.evaluate("window.calls.filter(x=>x.action==='provider.save').map(x=>x.payload)")
            assert len(saved) == 2 and saved[0].get('id') is None and saved[1]['id'] == 'created-provider'
            checks.append('Supplier model fetch locks the editor, preserves the saved ID after RPC rejection, and retries update that supplier')

            page.evaluate("window.reset('Providers');window.fail['provider.delete']='请先更换或恢复已连接的客户端配置'")
            page.get_by_title('删除供应商 测试供应商', exact=True).click()
            expect(page.get_by_role('alert')).to_have_text('请先更换或恢复已连接的客户端配置')
            page.locator('.provider-card').get_by_role('button', name='编辑', exact=True).click()
            page.evaluate("window.fail['provider.save']='无法保存供应商'")
            provider.get_by_role('button', name='保存', exact=True).click()
            expect(provider.get_by_role('alert')).to_have_text('无法保存供应商')
            expect(provider).to_be_visible()
            checks.append('Supplier delete and save errors are caught and remain in the relevant page or editor')

            page.evaluate("window.reset('Models')")
            page.get_by_label('全选当前模型').check()
            page.get_by_role('button', name='删除所选', exact=True).click()
            model = page.get_by_role('dialog', name='批量删除模型', exact=True)
            model.get_by_role('button', name='预览修改', exact=True).click()
            expect(model.get_by_role('button', name='确认删除 2 条', exact=True)).to_be_visible()
            page.evaluate("window.state.providers[0].models=[{id:'model-b'}];window.renderPage()")
            model.get_by_role('button', name='确认删除 2 条', exact=True).click()
            expect(model.get_by_role('alert')).to_have_text('模型目录已变化，请重新预览')
            applied = page.evaluate("window.calls.find(x=>x.action==='model.batch.apply').payload")
            assert applied['items'] == [{'providerId': 'p1', 'modelId': 'model-a'}, {'providerId': 'p1', 'modelId': 'model-b'}]
            assert applied['revision'] == 'reviewed-revision'
            expect(model.get_by_role('button', name='预览修改', exact=True)).to_be_visible()
            checks.append('Model apply carries the exact reviewed selection and revision; stale catalog rejection requires a fresh preview')

            page.evaluate("window.reset('Membership');window.responses['member.groups']={ok:false,message:'平台分组读取失败'}")
            expect(page.get_by_role('alert')).to_contain_text('平台分组读取失败')
            expect(page.get_by_role('button', name='添加云汇供应商 →', exact=True)).to_be_disabled()
            page.evaluate("delete window.responses['member.groups'];window.fail['provider.models']='模型同步连接中断'")
            page.get_by_role('button', name='重试', exact=True).click()
            expect(page.get_by_role('button', name='添加云汇供应商 →', exact=True)).to_be_enabled()
            page.get_by_role('button', name='添加云汇供应商 →', exact=True).click()
            page.wait_for_function("window.navigation==='agents'")
            expect(page.locator('.toast.bad')).to_contain_text('供应商已添加，模型同步暂未成功')
            assert page.evaluate("window.calls.filter(x=>x.action==='member.addProvider').length") == 1
            checks.append('Membership group failure disables adding; successful addition followed by failed model sync still advances without creating duplicates')

            page.evaluate("window.reset('Usage')")
            expect(page.get_by_text('已知价格估算', exact=True)).to_be_visible()
            expect(page.get_by_text('1 次请求价格未配置，未计入费用估算。可在模型管理中补充价格。', exact=True)).to_be_visible()
            page.get_by_role('button', name='请求日志 (2)', exact=True).click()
            expect(page.get_by_role('cell', name='价格未配置', exact=True)).to_have_count(1)
            expect(page.get_by_role('cell', name='$0', exact=True)).to_have_count(1)
            checks.append('Usage distinguishes an unpriced request from a confirmed free request and labels the partial estimate')
            page.evaluate("window.reset('Usage');window.fail['usage.recent']='日志暂不可读'")
            expect(page.get_by_role('alert')).to_contain_text('请求日志：日志暂不可读')
            expect(page.get_by_text('1 次请求价格未配置，未计入费用估算。可在模型管理中补充价格。', exact=True)).to_be_visible()
            page.evaluate("delete window.fail['usage.recent']")
            page.get_by_role('button', name='刷新', exact=True).click()
            expect(page.get_by_role('alert')).to_have_count(0)
            expect(page.get_by_role('button', name='请求日志 (2)', exact=True)).to_be_visible()
            checks.append('A request-log failure does not discard successfully loaded usage totals, and a later refresh recovers')
            assert not errors, errors
            browser.close()
            report = {'passed': True, 'count': len(checks), 'checks': checks, 'scope': 'Real React components, controlled IPC and deferred failures; no client files or paid accounts'}
            (ROOT / 'docs/MANAGEMENT-UI-VALIDATION.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    main()
