"""Actual App navigation under held IPC and large fixtures; no real client or network access."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-navigation-ui-') as temporary:
        bundle = Path(temporary) / 'app.js'
        options = {
            'stdin': {'contents': "import React from 'react';import {createRoot} from 'react-dom/client';import App from './ui/src/App.tsx';createRoot(document.getElementById('root')).render(<App/>);", 'resolveDir': str(ROOT), 'loader': 'tsx'},
            'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife',
            'define': {'process.env.NODE_ENV': '"production"'},
        }
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors, checks, metrics = [], [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/*', lambda route: route.fulfill(content_type='text/html', body='<html data-theme="light"><main id="root"></main></html>') if route.request.is_navigation_request() and route.request.url.startswith('http://fixture.test/') else route.abort())
            page.goto('http://fixture.test/#settings')
            if bundle.with_suffix('.css').exists():
                page.add_style_tag(path=str(bundle.with_suffix('.css')))
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate("""()=>{
              const provider={id:'p1',name:'大模型目录',format:'openai-chat',baseUrl:'https://fixture.invalid/v1',enabled:false,priority:10,apiKeys:[],models:Array.from({length:20000},(_,i)=>({id:'model-'+i}))};
              window.fixture={version:'0.6.0',platform:'win32',dataDir:'fixture',gatewayUrl:'http://127.0.0.1:3425',gateway:{running:true,requests:0,errors:0},groups:[],providers:[provider],plugins:[],builtinMiddleware:[],presets:[],agents:{},detected:{},agentCatalog:[{id:'codex-cli',name:'Codex CLI',vendor:'OpenAI',description:'Fixture',support:'automatic',protocol:'openai-responses',category:'cli'}],settings:{theme:'light',accent:'#4f66e8',autoCheckUpdate:false,gatewayPort:3425,gatewayHost:'127.0.0.1',gatewayToken:'fixture-token',proxy:'',requestTimeoutMs:60000,maxRetries:2,usageRetentionDays:90,autoSyncModels:true},localClients:{ok:true,checkedAt:'',accounts:[],sources:[],warnings:[],added:0,updated:0},codexCoexist:{identity:{available:false},warnings:[],models:[],officialModelCount:0},catalog:{version:1,source:'builtin',syncing:false}};
              window.sessions=Array.from({length:10000},(_,i)=>({id:'session-'+i,agent:'Codex CLI',title:'session-title-'+i,path:'fixture/session-'+i+'.jsonl',sizeBytes:100000,messageCount:400,updatedAt:'2026-11-16T10:00:00Z',modelProvider:'fixture'}));
              window.messages=Array.from({length:400},(_,i)=>({role:i%2?'assistant':'user',text:'message-'+i+' '+('长文本 fixture '.repeat(800))+' END-'+i}));
              window.usage={totals:{calls:2,cost:0,unpricedCalls:0,inputTokens:10,outputTokens:10,errors:0},byDay:[],byProvider:[],byModel:[],byAgent:[]};
              window.record={requestId:'recent-1',ts:'2026-11-16T10:00:00Z',status:200,model:'old-request-model',requestModel:'old-request-model',cost:0,costKnown:true};
              window.extension={ok:true,upstream:{repository:'fixture',version:'1',revision:'fixture',license:'MIT'},client:{installed:true,running:true,message:'current-extension-result'},connection:{port:9222},runtime:{connected:true,errors:[]},items:[]};
              window.calls=[];window.held=new Set();window.pending=[];window.responses={};window.unexpected=[];
              const gatewayListeners=new Set(),usageListeners=new Set();
              window.emitGateway=()=>{for(const cb of gatewayListeners)cb(window.fixture.gateway);};
              window.emitUsage=(record=window.record)=>{for(const cb of usageListeners)cb(record);};
              window.pendingFor=action=>window.pending.filter(p=>p.action===action&&!p.done);
              window.settle=(action,index=0,value,reject=false)=>{const p=window.pendingFor(action)[index];if(!p)throw Error('No pending '+action);p.done=true;reject?p.reject(Error(value)):p.resolve(value===undefined?p.value:value);};
              window.aurora={onGateway:cb=>{gatewayListeners.add(cb);return()=>gatewayListeners.delete(cb);},onUsage:cb=>{usageListeners.add(cb);return()=>usageListeners.delete(cb);},invoke:async(action,payload={})=>{
                window.calls.push({action,payload:structuredClone(payload)});
                let value;
                if(Object.hasOwn(window.responses,action))value=window.responses[action];
                else if(action==='state.get')value=window.fixture;
                else if(action==='sessions.scan')value=window.sessions;
                else if(action==='sessions.read')value=window.messages;
                else if(action==='codex.assets')value={ok:true,assets:[{id:'skill-1',kind:'skill',name:'current-skill',enabled:true}]};
                else if(action==='codex.flags')value={flags:{},schema:[{key:'model_context_window',label:'上下文容量',type:'number',hint:'fixture'}]};
                else if(action==='extension.list')value=window.extension;
                else if(action==='usage.summary')value=window.usage;
                else if(action==='usage.recent')value=[window.record];
                else if(action==='usage.live')value=[];
                else {window.unexpected.push(action);throw Error('Unexpected RPC '+action);}
                value=structuredClone(value);
                if(window.held.has(action))return new Promise((resolve,reject)=>window.pending.push({action,payload,value,resolve,reject,done:false}));
                return value;
              }};
            }""")
            page.add_script_tag(path=str(bundle))
            expect(page.get_by_role('heading', name='系统设置', exact=True)).to_be_visible()

            def navigate(label, heading=None):
                metric = page.evaluate("""async ({label,heading})=>{
                  const button=document.querySelector('aside button[aria-label="'+label+'"]');
                  if(!button)throw Error('Missing navigation '+label);
                  const start=performance.now();button.click();
                  while(document.querySelector('#main-content h1')?.textContent!==heading){
                    if(performance.now()-start>2000)throw Error('Navigation blocked '+label);
                    await new Promise(requestAnimationFrame);
                  }
                  await new Promise(requestAnimationFrame);
                  return {page:label,milliseconds:Math.round((performance.now()-start)*10)/10,pending:window.pending.filter(p=>!p.done).map(p=>p.action)};
                }""", {'label': label, 'heading': heading or label})
                assert metric['milliseconds'] < 1000, metric
                metrics.append(metric)

            def settle(action, index=0, value=None, reject=False):
                if value is None:
                    page.evaluate('([action,index])=>window.settle(action,index)', [action, index])
                else:
                    page.evaluate('([action,index,value,reject])=>window.settle(action,index,value,reject)', [action, index, value, reject])

            # A gateway burst shares one active read and takes one fresh trailing snapshot.
            page.evaluate("window.held.add('state.get');window.fixture.version='stale-version';window.emitGateway();window.fixture.version='0.6.2';for(let i=0;i<20;i++)window.emitGateway()")
            assert page.evaluate("window.pendingFor('state.get').length") == 1
            navigate('模型管理')
            expect(page.locator('#main-content tbody tr')).to_have_count(100)
            settle('state.get')
            page.wait_for_function("window.pendingFor('state.get').length===1 && window.calls.filter(c=>c.action==='state.get').length===3")
            expect(page.locator('.sidebar .version')).to_have_text('v0.6.0')
            settle('state.get')
            expect(page.locator('.sidebar .version')).to_have_text('v0.6.2')
            page.evaluate("window.held.delete('state.get')")
            checks.append('Sidebar commits with state.get held; 20 change events cause one trailing read and the obsolete snapshot never reaches the UI')

            page.get_by_role('button', name='下一页', exact=True).click()
            expect(page.get_by_role('cell', name='model-100', exact=True)).to_be_visible()
            page.get_by_label('全选当前模型').check()
            expect(page.get_by_text('已选 20000 条', exact=True)).to_be_visible()
            page.get_by_role('button', name='删除所选', exact=True).click()
            modal = page.get_by_role('dialog', name='批量删除模型', exact=True)
            expect(modal).to_contain_text('20000')
            assert modal.locator('.list-row').count() <= 100
            modal.get_by_role('button', name='取消', exact=True).click()
            page.get_by_label('全选当前模型').uncheck()
            page.get_by_label('搜索模型').fill('model-19999')
            expect(page.locator('#main-content tbody tr')).to_have_count(1)
            expect(page.get_by_role('cell', name='model-19999', exact=True)).to_be_visible()
            checks.append('20,000 models mount only 100 rows; pagination and distant search work, while select-all and batch intent retain the full filtered selection')

            # Resolve the newer page first and reject the abandoned page afterwards.
            page.evaluate("window.held.add('sessions.scan')")
            navigate('历史会话')
            page.wait_for_function("window.pendingFor('sessions.scan').length===1")
            navigate('系统设置')
            navigate('历史会话')
            page.wait_for_function("window.pendingFor('sessions.scan').length===2")
            settle('sessions.scan', 1)
            expect(page.locator('#main-content .list-row[role=button]')).to_have_count(100)
            settle('sessions.scan', 0, 'obsolete history failure', True)
            page.evaluate("window.held.delete('sessions.scan')")
            expect(page.locator('.toast.bad')).to_have_count(0)
            page.locator('#main-content .list-row[role=button]').first.click()
            expect(page.locator('.chat-msg')).to_have_count(50)
            expect(page.locator('.chat-msg').first).not_to_contain_text('END-0')
            page.locator('.chat-msg').first.get_by_role('button').click()
            expect(page.locator('.chat-msg').first).to_contain_text('END-0')
            # The final button is deliberately outside the viewport; invoke its actual handler.
            page.get_by_role('button', name='继续显示消息（还剩 350 条）', exact=True).evaluate('(el)=>el.click()')
            expect(page.locator('.chat-msg')).to_have_count(100)
            page.get_by_label('搜索历史会话').fill('session-title-9999')
            expect(page.locator('#main-content .list-row[role=button]')).to_have_count(1)
            navigate('系统设置')
            checks.append('10,000 history entries render 100 initially; 400 long messages render 50 initially with reversible text expansion, and stale page failures never produce toasts')

            page.evaluate("window.held.add('codex.assets')")
            navigate('桌面工作台')
            page.wait_for_function("window.pendingFor('codex.assets').length===1")
            assert page.evaluate("window.calls.filter(c=>c.action==='codex.flags'||c.action==='codex.diagnose').length") == 0
            page.get_by_role('button', name='高级设置', exact=True).click()
            expect(page.get_by_text('上下文容量', exact=True)).to_be_visible()
            assert page.evaluate("window.pendingFor('codex.assets').length") == 1
            page.get_by_role('button', name='会话诊断', exact=True).click()
            expect(page.get_by_role('button', name='打开批量修复', exact=True)).to_be_visible()
            navigate('系统设置')
            navigate('桌面工作台')
            page.wait_for_function("window.pendingFor('codex.assets').length===2")
            settle('codex.assets', 1)
            expect(page.get_by_text('current-skill', exact=True)).to_be_visible()
            settle('codex.assets', 0, {'ok': True, 'assets': [{'id': 'old', 'kind': 'skill', 'name': 'obsolete-skill', 'enabled': True}]})
            expect(page.get_by_text('obsolete-skill', exact=True)).to_have_count(0)
            page.evaluate("window.held.delete('codex.assets')")
            assert page.evaluate("window.calls.filter(c=>c.action==='codex.diagnose').length") == 0
            checks.append('Workbench loads only the active tab; held asset discovery cannot block flags, diagnostics entry, or navigation, and stale assets cannot replace a remounted page')

            page.evaluate("window.held.add('extension.list')")
            navigate('插件中心')
            page.wait_for_function("window.pendingFor('extension.list').length===1")
            navigate('系统设置')
            navigate('插件中心')
            assert page.evaluate("window.pendingFor('extension.list').length") == 1
            settle('extension.list')
            expect(page.get_by_text('current-extension-result', exact=True)).to_be_visible()
            expect(page.get_by_role('alert')).to_have_count(0)
            page.evaluate("window.held.delete('extension.list');window.held.add('extension.refresh');window.responses['extension.refresh']={ok:true,results:[]}")
            page.get_by_role('button', name='同步市场索引', exact=True).click()
            page.wait_for_function("window.pendingFor('extension.refresh').length===1")
            before = page.evaluate("window.calls.filter(c=>c.action==='extension.list').length")
            navigate('系统设置')
            settle('extension.refresh')
            page.evaluate("window.held.delete('extension.refresh')")
            page.wait_for_function("window.calls.filter(c=>c.action==='extension.list').length>" + str(before))
            assert page.evaluate("window.calls.filter(c=>c.action==='extension.list').length") == before + 1
            navigate('插件中心')
            expect(page.get_by_text('current-extension-result', exact=True)).to_be_visible()
            assert page.evaluate("window.calls.filter(c=>c.action==='extension.list').length") == before + 1
            navigate('系统设置')
            expect(page.locator('.toast')).to_have_count(0)
            checks.append('Plugin navigation shares a held scan; off-page market completion refreshes the shared snapshot without toasts, and returning uses that fresh snapshot without another scan')

            page.evaluate("window.held.add('usage.summary')")
            navigate('用量与账单', '用量统计')
            page.wait_for_function("window.pendingFor('usage.summary').length===1")
            page.evaluate("for(let i=0;i<20;i++)window.emitUsage()")
            assert page.evaluate("window.pendingFor('usage.summary').length") == 1
            page.get_by_role('button', name='7 天', exact=True).click()
            page.wait_for_function("window.pendingFor('usage.summary').length===2")
            page.evaluate("window.settle('usage.summary',1,{...window.usage,totals:{...window.usage.totals,calls:777}})")
            expect(page.locator('.stat').filter(has_text='调用次数')).to_contain_text('777')
            settle('usage.summary')
            expect(page.locator('.stat').filter(has_text='调用次数')).to_contain_text('777')
            navigate('系统设置')
            checks.append('Usage event bursts share the pending summary; changing the time range starts a fresh request and the old result cannot overwrite it')

            page.evaluate("window.held.add('usage.recent')")
            navigate('运行概览')
            page.wait_for_function("window.pendingFor('usage.summary').length===1 && window.pendingFor('usage.recent').length===1")
            page.evaluate("window.emitUsage({...window.record,model:'live-request-model',requestModel:'live-request-model'})")
            expect(page.get_by_text('live-request-model', exact=True)).to_be_visible()
            settle('usage.recent')
            expect(page.get_by_text('live-request-model', exact=True)).to_be_visible()
            expect(page.get_by_text('old-request-model', exact=True)).to_have_count(0)
            assert page.evaluate("window.pendingFor('usage.summary').length") == 1
            navigate('模型管理')
            settle('usage.summary')
            page.evaluate("window.held.clear()")
            checks.append('Overview starts summary and recent reads independently, preserves fresher live requests, and navigation stays responsive while its summary is unresolved')

            assert not errors, errors
            assert page.evaluate('window.unexpected') == []
            assert page.evaluate('window.pending.filter(p=>!p.done).length') == 0
            browser.close()
            report = {'passed': True, 'count': len(checks), 'checks': checks, 'navigation': metrics, 'maximumNavigationMs': max(m['milliseconds'] for m in metrics), 'scope': 'Actual App in Chromium, controlled asynchronous IPC, 20,000 models, 10,000 sessions and 400 long messages; no real client files, services or paid requests'}
            output = ROOT / 'tmp/navigation-ui'
            output.mkdir(parents=True, exist_ok=True)
            (output / 'validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    main()
