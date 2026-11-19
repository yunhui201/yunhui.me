import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yunhui-extension-history-'));
process.env.AURORA_CLIENT_HOME=path.join(tmp,'client');
const root=path.join(process.env.AURORA_CLIENT_HOME,'.codex'),dir=path.join(root,'sessions');fs.mkdirSync(dir,{recursive:true});
await build({stdin:{contents:"export { sessionRoute } from './src/core/extensions/sessions.ts'; export { AuroraStore } from './src/core/store/index.ts';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:path.join(tmp,'bundle.cjs'),logLevel:'silent'});
const m=createRequire(import.meta.url)(path.join(tmp,'bundle.cjs')),store=new m.AuroraStore(path.join(tmp,'store'));
const db=new DatabaseSync(path.join(root,'state_5.sqlite'));
db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,rollout_path TEXT,title TEXT,cwd TEXT,model TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,first_user_message TEXT,git_branch TEXT)');
const rows=[
  {type:'session_meta',payload:{id:'thread-a',cwd:'/work/demo'}},
  {type:'turn_context',payload:{turn_id:'turn-1'}},
  {type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'INJECTED_DEVELOPER_SECRET'}]}},
  {type:'response_item',payload:{type:'message',role:'user',id:'u1',content:[{type:'input_text',text:'<environment_context>INJECTED_CONTEXT_SECRET</environment_context>'},{type:'input_text',text:'帮我画图'}]}},
  {type:'response_item',payload:{type:'reasoning',summary:[{type:'summary_text',text:'先想想'}],encrypted_content:'ENCRYPTED_SECRET'}},
  {type:'response_item',payload:{type:'function_call',name:'shell',arguments:'{"cmd":"ls"}',call_id:'c1'}},
  {type:'response_item',payload:{type:'function_call_output',call_id:'c1',output:'a.txt'}},
  {type:'response_item',timestamp:'2026-11-15T01:00:00Z',payload:{type:'message',role:'assistant',id:'m1',phase:'final_answer',content:[{type:'output_text',text:'画好了'}]}},
  {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:120},last_token_usage:{total_tokens:20},model_context_window:1000}}},
  {type:'event_msg',payload:{type:'task_complete',turn_id:'turn-1',duration_ms:1500,last_agent_message:'画好了'}},
  {type:'event_msg',payload:{type:'task_started',turn_id:'turn-2'}},
  {type:'response_item',payload:{type:'message',role:'user',id:'u2',content:[{type:'input_text',text:'再改改'}]}},
  {type:'event_msg',payload:{type:'turn_aborted',turn_id:'turn-2',reason:'interrupted'}},
];
const rollout=path.join(dir,'rollout-a.jsonl');fs.writeFileSync(rollout,rows.map(JSON.stringify).join('\n')+'\nnot json\n');
const insert=db.prepare("INSERT INTO threads VALUES (?,?,?, '/work/demo','fixture',1,?,?,?, 'main')");
insert.run('thread-a',rollout,'重命名后的标题',30,0,'帮我画图');insert.run('thread-b','','修 100% 的 bug',20,0,'bug');insert.run('thread-c','','旧会话',10,1,'archived');
const call=async(method,params={})=>(await m.sessionRoute(store,undefined,'/extensions/history',{method,params})).result;
let passed=0;async function test(name,fn){await fn();passed++;console.log(`✓ ${name}`);}
try{
  await test('all ten query methods match native metadata, archive filters and cursor shapes',async()=>{
    assert.deepEqual((await call('listSessions')).map(s=>s.id),['thread-a','thread-b']);assert.deepEqual((await call('listSessions',{archived:true})).map(s=>s.id),['thread-c']);
    assert.equal(await call('readTitle','thread-a'),'重命名后的标题');assert.equal((await call('listSessions'))[0].createdAt,1);assert.equal((await call('listSessions'))[0].gitBranch,'main');
    assert.deepEqual((await call('filterSessions',{id:'thread-c'})).map(s=>s.id),['thread-c']);assert.equal((await call('filterSessions',{cwd:'/wo',createdAfter:1,createdBefore:2})).length,2);assert.equal((await call('filterSessions',{createdBefore:1})).length,0);
    const found=await call('searchSessions',{query:'100%'});assert.equal(found.items[0].id,'thread-b');assert.equal(found.nextCursor,null);
    const first=await call('searchSessions',{query:'',limit:1}),second=await call('searchSessions',{query:'',limit:1,cursor:first.nextCursor});assert.equal(first.nextCursor,'1');assert.equal(second.items[0].id,'thread-b');assert.equal(second.nextCursor,null);
    assert.equal((await call('searchSessions',{query:'帮我画图'})).items[0].id,'thread-a');await assert.rejects(()=>call('deleteSession','thread-a'),/尚未适配/);await assert.rejects(()=>call('readSession','thread-b'),/rollout/);
  });
  await test('event log preserves tool arguments, calls, phases and usage without injected or encrypted content',async()=>{
    const result=await call('readSession',{id:'thread-a'}),events=result.events;
    assert.equal(result.session.title,'重命名后的标题');assert.deepEqual(events.map(e=>e.type),['turn/start','user/message','assistant/reasoning','tool/call','tool/result','assistant/message','token/usage','turn/complete','turn/start','user/message','turn/aborted']);
    assert.deepEqual(events.map(e=>e.seq),Array.from({length:11},(_,i)=>i));assert.equal(events[1].data.text,'帮我画图');assert.equal(events[3].data.callId,'c1');assert.equal(events[3].data.input,'{"cmd":"ls"}');assert.equal(events[4].data.output,'a.txt');assert.equal(events[5].data.phase,'final_answer');assert.equal(events[5].time,'2026-11-15T01:00:00Z');assert.equal(events[6].data.contextWindow,1000);assert.equal(events[10].data.reason,'interrupted');assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.deepEqual((await call('listEvents',{id:'thread-a',options:{types:['user/message','assistant/message'],fromEnd:true,limit:2}})).map(e=>e.data.text),['画好了','再改改']);
    assert.equal((await call('filterEvents',{id:'thread-a',options:{text:'A.TXT'}}))[0].type,'tool/result');assert.deepEqual((await call('readEvent',{sessionId:'thread-a',seq:3,before:1,after:1})).map(e=>e.seq),[2,3,4]);
    assert.equal((await call('searchEvents',{query:'再改'})).items[0].event.seq,9);assert.equal((await call('readEventsSince',{sessionId:'thread-a',seq:9})).length,2);await assert.rejects(()=>call('readEvent',{sessionId:'thread-a',seq:999}),/seq/);
  });
  await test('upstream service projects actual logs and observes newly appended events exactly once',async()=>{
    const source=fs.readFileSync('third_party/codexplusplus/assets/inject/renderer-inject/91-extension-runtime.js','utf8');const start=source.indexOf('  function codexPlusSessionQueryService()'),end=source.indexOf('\n  /**\n   * 会话写入',start);assert.ok(start>0&&end>start);
    const timers=[],context=vm.createContext({window:{__codexSessionDeleteBridge:(route,payload)=>m.sessionRoute(store,undefined,route,payload)},codexPlusInjectionStillCurrent:()=>true,setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{}});
    const service=vm.runInContext(source.slice(start,end)+'\ncodexPlusSessionQueryService()',context);assert.equal(await service.project('thread-a',{init:0,apply:(state,event)=>state+(event.type==='tool/call'?1:0)}),1);
    const received=[],stop=service.observeSession('thread-a',event=>received.push(event));for(let i=0;i<100&&!timers.length;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(timers.length,1);assert.equal(received.length,0);
    fs.appendFileSync(rollout,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'改好了'}]}})+'\n');await timers.shift()();assert.equal(received.length,1);assert.equal(received[0].seq,11);assert.equal(received[0].data.text,'改好了');await timers.shift()();assert.equal(received.length,1);stop();assert.equal((await call('searchEvents',{query:'改好'})).items[0].event.seq,11);
  });
  await test('search event pagination and lightweight text keep full read results intact',async()=>{
    const long='匹配 '+ 'x'.repeat(260);fs.appendFileSync(rollout,[long,long].map(text=>JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}})).join('\n')+'\n');
    const first=await call('searchEvents',{query:'匹配',limit:1}),second=await call('searchEvents',{query:'匹配',limit:1,cursor:first.nextCursor});assert.equal(first.nextCursor,'1');assert.equal(second.nextCursor,null);assert.equal(first.items[0].event.data.text.length,201);assert.equal((await call('readEventsSince',{sessionId:'thread-a',seq:first.items[0].event.seq,limit:1}))[0].data.text,long);
  });
  await test('long sessions remain observable beyond the former 1000-message and 4 MB caps',async()=>{
    const long=path.join(dir,'long.jsonl');fs.writeFileSync(long,JSON.stringify({type:'session_meta',payload:{id:'thread-long'}})+'\n');const row=JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'z'.repeat(2200)}]}})+'\n';fs.appendFileSync(long,row.repeat(2100));insert.run('thread-long',long,'超长会话',5,0,'');
    assert.equal((await call('listEvents',{id:'thread-long',options:{fromEnd:true,limit:1}}))[0].seq,2099);assert.equal((await call('readEventsSince',{sessionId:'thread-long',seq:2099}))[0].data.text.length,2200);
  });
  await test('indexed external paths and mismatched IDs fail without returning other data',async()=>{
    const external=path.join(tmp,'outside.jsonl');fs.writeFileSync(external,'OUTSIDE_SECRET');insert.run('thread-external',external,'external',0,0,'');await assert.rejects(()=>call('readSession',{id:'thread-external'}),/路径不属于/);
    const wrong=path.join(dir,'wrong.jsonl');fs.writeFileSync(wrong,JSON.stringify({type:'session_meta',payload:{id:'wrong-id'}}));insert.run('thread-wrong',wrong,'wrong',0,0,'');await assert.rejects(()=>call('readSession',{id:'thread-wrong'}),/ID 与原生索引不一致/);await assert.rejects(()=>call('readSession',{id:'../../secret'}),/未找到/);
    const huge=path.join(dir,'huge.jsonl');fs.writeFileSync(huge,'');fs.truncateSync(huge,256*1024*1024+1);insert.run('thread-huge',huge,'huge',0,0,'');await assert.rejects(()=>call('readSession',{id:'thread-huge'}),/超过 256 MB/);
    assert.equal(fs.readFileSync(external,'utf8'),'OUTSIDE_SECRET');assert.equal(db.prepare('SELECT title FROM threads WHERE id=?').get('thread-a').title,'重命名后的标题');
  });
  await test('log-only fallback and event cache remain isolated to the current client root',async()=>{
    const previous=process.env.AURORA_CLIENT_HOME;process.env.AURORA_CLIENT_HOME=path.join(tmp,'other-client');
    try{const other=path.join(process.env.AURORA_CLIENT_HOME,'.codex','sessions','other.jsonl');fs.mkdirSync(path.dirname(other),{recursive:true});fs.writeFileSync(other,[{type:'session_meta',payload:{id:'thread-a'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'另一个客户端的独立会话'}]}}].map(JSON.stringify).join('\n')+'\n');const result=await call('readSession',{id:'thread-a'});assert.equal(result.session.title,'另一个客户端的独立会话');assert.equal(result.events.length,1);assert.equal(result.events[0].data.text,'另一个客户端的独立会话');assert.deepEqual((await call('listSessions')).map(s=>s.id),['thread-a']);}finally{process.env.AURORA_CLIENT_HOME=previous;}
    assert.equal(await call('readTitle',{id:'thread-a'}),'重命名后的标题');
  });
  console.log(`Extension history: ${passed} tests passed`);
}finally{
  db.close();const resolved=path.resolve(tmp);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('yunhui-extension-history-'))fs.rmSync(resolved,{recursive:true,force:true});
}
