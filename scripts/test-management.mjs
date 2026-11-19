import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'yunhui-management-'));
const bundle=path.join(scratch,'core.cjs');
await build({stdin:{contents:['store/index','catalog','cloud','modelManagement','gateway/server','gateway/liveUsage','actions','protocol/index'].map(p=>`export * from './src/core/${p}.ts';`).join('\n'),resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:bundle});
const {AuroraStore,ensureCatalog,refreshCatalog,catalogPresets,validateCloudProvider,fetchProviderModels,manageModels,GatewayServer,activeRequests,summarizeUsage}=createRequire(import.meta.url)(bundle);
let checks=0;function check(name,fn){fn();checks++;console.log('PASS',name);}
let reads=0,offline=false,release,releaseCatalog,delayedStarted;
let delayedReady=new Promise(r=>{delayedStarted=r;});
const upstream=http.createServer(async(req,res)=>{
 if(req.url==='/catalog'){reads++;res.writeHead(offline?503:200,{'content-type':'application/json'});res.end(JSON.stringify({version:20,providers:[{key:'test',name:'Official test',format:'openai-chat',baseUrl:'https://example.test',models:[{id:'current',cacheReadPrice:0.1}]}]}));return;}
 if(req.url==='/catalog-delayed'){await new Promise(r=>{releaseCatalog=r;delayedStarted();});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({version:21,providers:[{key:'previous',name:'Previous endpoint',format:'openai-chat',baseUrl:'https://previous.test',models:[{id:'previous-model'}]}]}));return;}
 if(req.url==='/catalog-new'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({version:22,providers:[{key:'latest',name:'Latest endpoint',format:'openai-chat',baseUrl:'https://latest.test',models:[]}]}));return;}
 const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));
 res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'live test'}}]})+'\n\n');
 await new Promise(r=>{release=r;});
 res.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:70,cache_creation_input_tokens:10}})+'\n\ndata: [DONE]\n\n');
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${upstream.address().port}`;
const store=new AuroraStore(path.join(scratch,'data'));store.saveSettings({catalogUrl:base+'/catalog'});
let gateway;
try {
 const defaults=new AuroraStore(path.join(scratch,'blank-defaults'));
 check('A fresh profile contains no demo suppliers, routes, client connections or synthetic usage',()=>{assert.deepEqual(defaults.listProviders(),[]);assert.deepEqual(defaults.listGroups(),[]);assert.deepEqual(defaults.listAgents(),{});assert.deepEqual(defaults.readUsage(),[]);assert.deepEqual(activeRequests(defaults),[]);assert.equal(summarizeUsage(defaults.readUsage()).totals.calls,0);});
 const custom=catalogPresets(defaults).filter(p=>p.customBaseUrl);
 check('Every custom-address template starts without example endpoints, credentials or invented models',()=>{
  assert.equal(custom.length,4);
  for(const preset of custom){assert.equal(preset.baseUrl,'');assert.equal(preset.customBaseUrl,true);assert.deepEqual(preset.models,[]);const p=defaults.saveProvider({presetId:preset.id});assert.equal(p.baseUrl,'');assert.deepEqual(p.models,[]);assert.ok(p.apiKeys.every(k=>k.key===''));}
  const seed=JSON.parse(fs.readFileSync(path.join(process.cwd(),'server','seed-catalog.json'),'utf8')).providers.filter(p=>p.customBaseUrl);
  assert.equal(seed.length,custom.length);assert.ok(seed.every(p=>p.baseUrl===''));
 });
 check('Legacy custom catalog placeholders are cleared while real custom endpoints remain intact',()=>{
  const template={key:'relay',name:'Custom relay',format:'openai-chat',customBaseUrl:true,models:[]};
  for(const baseUrl of ['https://api.example.com','https://api.example.com/v1'])assert.equal(validateCloudProvider({...template,baseUrl}).baseUrl,'');
  const cached={getSettings:()=>({catalogUrl:base+'/old-custom-directory'}),readExtra:()=>({version:1,providers:[{...template,baseUrl:'https://api.example.com/v1'}]})};
  assert.equal(catalogPresets(cached)[0].baseUrl,'');
  assert.equal(validateCloudProvider({...template,baseUrl:base}).baseUrl,base);
  assert.equal(validateCloudProvider({...template,baseUrl:''}).baseUrl,'');
  assert.throws(()=>validateCloudProvider({...template,customBaseUrl:false,baseUrl:''}),/地址/);
 });
 check('Legacy Azure placeholders are cleared from cached catalogs without changing real Azure endpoints',()=>{
  const template={key:'azure-openai',name:'Azure OpenAI',format:'openai-chat',customBaseUrl:true,models:[]};
  for(const baseUrl of ['https://{resource}.openai.azure.com/openai/deployments/{deployment}','https://{resource}.openai.azure.com/openai/deployments/%7Bdeployment%7D']){
   const cached={getSettings:()=>({catalogUrl:base+'/old-azure-directory'}),readExtra:()=>({version:1,providers:[{...template,baseUrl}]})};
   assert.equal(catalogPresets(cached)[0].baseUrl,'');
  }
  const actual='https://customer-resource.openai.azure.com/openai/deployments/production';
  assert.equal(validateCloudProvider({...template,baseUrl:actual}).baseUrl,actual);
  const provider=defaults.saveProvider({presetId:'azure-openai',baseUrl:actual,models:[{id:'production'}]});
  assert.equal(provider.baseUrl,actual);assert.equal(provider.models[0].id,'production');
 });
 const unfinished=defaults.listProviders()[0],missingAddress=await fetchProviderModels({store:defaults},{providerId:unfinished.id});
 check('An unfinished custom supplier asks for its actual API address before model discovery',()=>{assert.equal(missingAddress.ok,false);assert.match(missingAddress.message,/实际 API 地址/);assert.deepEqual(missingAddress.models,[]);assert.equal(defaults.getProvider(unfinished.id).baseUrl,'');});
 await Promise.all([ensureCatalog(store),ensureCatalog(store),ensureCatalog(store)]);
 check('All startup consumers share one official catalog request',()=>assert.equal(reads,1));
 check('All supplier presets use the same remote list, without appended stale vendors',()=>assert.deepEqual(catalogPresets(store).map(p=>p.id),['test']));
 const local=store.saveProvider({presetId:'test',name:'saved supplier'});
 check('Saving by preset uses remote models and keeps unknown prices undefined',()=>{assert.equal(local.models[0].id,'current');assert.equal(local.models[0].inputPrice,undefined);});
 offline=true;
 const restarted=new AuroraStore(store.dir);const immediate=await ensureCatalog(restarted);
 check('A restart renders durable cached data immediately',()=>assert.equal(immediate.source,'cache'));
 const fallback=await refreshCatalog(restarted);
 check('Failed startup refresh preserves the trusted cache',()=>{assert.equal(fallback.source,'cache');assert.ok(fallback.warning);});
 const switching=new AuroraStore(path.join(scratch,'switching'));switching.saveSettings({catalogUrl:base+'/catalog-delayed'});
 const previous=refreshCatalog(switching);const startup=ensureCatalog(switching);await delayedReady;
 switching.saveSettings({catalogUrl:base+'/catalog-new'});await ensureCatalog(switching);releaseCatalog();
 const [refreshed,started]=await Promise.all([previous,startup]);
 check('A delayed old endpoint cannot replace the new catalog for refresh or startup callers',()=>{assert.equal(refreshed.version,22);assert.equal(started.version,22);assert.deepEqual(catalogPresets(switching).map(p=>p.id),['latest']);assert.equal(refreshed.syncing,false);});
 const empty=store.saveProvider({presetId:'test',name:'Intentionally empty',models:[]});offline=false;await refreshCatalog(store);
 check('Catalog refresh preserves saved models and an explicitly empty local list',()=>{assert.deepEqual(store.getProvider(empty.id).models,[]);assert.deepEqual(store.getProvider(local.id).models.map(m=>m.id),['current']);});
 const p=store.saveProvider({name:'Batch',baseUrl:base,models:[{id:'a',inputPrice:1},{id:'b',inputPrice:2},{id:'c',inputPrice:3}],apiKeys:[{id:'fake',key:'fixture-key',label:'test',weight:1,enabled:true}]});
 const items=[{providerId:p.id,modelId:'a'},{providerId:p.id,modelId:'b'}];
 const payload={items,operation:'update',patch:{inputPrice:4,cacheWritePrice:1.5,capabilities:{tools:true}}};const plan=manageModels(store,payload);
 manageModels(store,{...payload,revision:plan.revision},true);
 check('Batch edits only selected models, includes cache write pricing and backs up without API keys',()=>{assert.deepEqual(store.getProvider(p.id).models.map(m=>m.inputPrice),[4,4,3]);assert.deepEqual(store.getProvider(p.id).models.map(m=>m.cacheWritePrice),[1.5,1.5,undefined]);const backups=fs.readdirSync(store.dir).filter(f=>f.startsWith('models_'));assert.equal(backups.length,1);assert.ok(!fs.readFileSync(path.join(store.dir,backups[0]),'utf8').includes('fixture-key'));});
 const stale=manageModels(store,payload);store.saveProvider({...store.getProvider(p.id),models:[{id:'a'},{id:'b'},{id:'c'}]});
 check('An outdated model preview cannot overwrite newer edits',()=>assert.equal(manageModels(store,{...payload,revision:stale.revision},true).ok,false));
 store.saveAgent({id:'claude-code',connected:true,providerId:p.id,model:'a'});
 check('Bulk deletion identifies active client references',()=>assert.ok(manageModels(store,{items,operation:'delete'}).conflicts.some(c=>c.includes('claude-code'))));
 store.saveAgent({id:'claude-code',connected:true,providerId:p.id,model:'c',modelMap:{sonnet:'a'}});
 check('Bulk deletion protects Claude role mappings even when the main model differs',()=>assert.ok(manageModels(store,{items,operation:'delete'}).conflicts.some(c=>c.includes('claude-code'))));
 store.saveAgent({id:'claude-code',connected:true,providerId:local.id,model:`${p.id}/b`,modelMap:{}});
 check('Bulk deletion resolves an explicitly namespaced model from another provider',()=>assert.ok(manageModels(store,{items,operation:'delete'}).conflicts.some(c=>c.includes('claude-code'))));
 const nested=store.saveProvider({name:'Nested upstream IDs',baseUrl:base,models:[{id:'accounts/fireworks/models/current'},{id:'other'}]});
 store.saveAgent({id:'claude-code',connected:true,providerId:nested.id,model:'accounts/fireworks/models/current'});
 check('A slash inside an upstream model ID remains part of that model',()=>assert.ok(manageModels(store,{items:[{providerId:nested.id,modelId:'accounts/fireworks/models/current'}],operation:'delete'}).conflicts.some(c=>c.includes('claude-code'))));
 check('Invalid model selections return a readable validation error',()=>assert.throws(()=>manageModels(store,{items:[null],operation:'delete'}),/模型选择格式无效/));
 store.saveAgent({id:'claude-code',connected:false});
 const group=store.saveGroup({name:'bound',members:[{providerId:p.id,model:'a',weight:1}]});
 check('Bulk deletion identifies routing references',()=>assert.ok(manageModels(store,{items,operation:'delete'}).conflicts.some(c=>c.includes('bound'))));
 store.deleteGroup(group.id);
 const allItems=store.getProvider(p.id).models.map(m=>({providerId:p.id,modelId:m.id}));const del={items:allItems,operation:'delete'};const dp=manageModels(store,del);manageModels(store,{...del,revision:dp.revision},true);
 check('Removing the last model disables its supplier, preventing wildcard forwarding',()=>assert.equal(store.getProvider(p.id).enabled,false));
 store.saveProvider({...store.getProvider(p.id),enabled:true,models:[{id:'stream',inputPrice:1,outputPrice:2,cacheReadPrice:.1,cacheWritePrice:1.25}]});
 gateway=new GatewayServer({store});await gateway.start('127.0.0.1',0);
 const response=await fetch(`http://127.0.0.1:${gateway.getStatus().port}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${store.getSettings().gatewayToken}`,'content-type':'application/json','x-codex-thread-id':'test-thread-id'},body:JSON.stringify({model:'stream',stream:true,messages:[{role:'user',content:'test'}]})});
 check('Live requests track actual thread identity and remain visible during streaming',()=>{const [r]=activeRequests(store);assert.equal(r.threadId,'test-thread-id');assert.equal(r.phase,'streaming');assert.ok(r.estimatedOutputTokens>0);assert.equal(r.cacheRead,undefined);});
 release();await response.text();await new Promise(r=>setTimeout(r,20));
 const r=store.recentRequests()[0];
 check('Completion records reported cache read/write and clears the active request',()=>{assert.equal(activeRequests(store).length,0);assert.equal(r.cacheRead,70);assert.equal(r.cacheWrite,10);assert.equal(r.threadId,'test-thread-id');assert.equal(r.inputTokens,100);assert.equal(r.cacheReadKnown,true);assert.equal(r.cacheWriteKnown,true);});
 check('Cache rate uses reported input and costs account for write pricing',()=>{const s=summarizeUsage([r]);assert.equal(s.totals.cacheRate,.7);assert.equal(s.totals.cacheWrite,10);assert.ok(Math.abs(r.cost-0.0000795)<1e-10);});
 console.log(`\n${checks} catalog/model/live-usage checks passed.`);
} finally {if(gateway)await gateway.stop();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(scratch,{recursive:true,force:true});}
