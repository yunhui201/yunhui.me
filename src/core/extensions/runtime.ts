import fs from 'node:fs';
import path from 'node:path';
import { DesktopCdp, desktopInfo, openDesktopConnection } from '../injector.js';
import type { AuroraStore } from '../store/index.js';
import { BUILTINS, BUNDLED, effectiveEntry, loadState, saveState, manifest, validatePackageConfig, type ExtensionState } from './catalog.js';
import { resourceRoot, loadIndex, managedIndex, refreshMarkets, installNative, installedPlugins, nativeKey, nativeRequest, nativeInstallStatus, packagePresent } from './market.js';
import { enhanceUsageSource, threadUsage } from './usage.js';
import { activeRequests } from '../gateway/liveUsage.js';
import { extensionClientConfig } from './clientConfig.js';
import { dreamThemeSource } from './theme.js';
import { augmentSessionRenderer, sessionRoute } from './sessions.js';
import { prepareNativeModules } from './nativeModules.js';
import { desktopModelCatalog, modelCatalogFingerprint } from './models.js';
import { captureNativeClient } from './nativeCapture.js';
import { generateSuggestions, stepwiseSettings } from './stepwise.js';
import { DictationBridge, dictationConfiguration } from './dictation.js';
import { extensionOperation, extensionOperationBusy } from './operations.js';
const SETTING_IDS:Record<string,string> = { 'plugin-market-unlock':'PluginMarketplaceUnlock','model-whitelist-unlock':'ModelWhitelistUnlock','session-delete':'SessionDelete','side-chat-save':'SideChatSave','markdown-export':'MarkdownExport','thread-id-badge':'ThreadIdBadge','conversation-view':'ConversationView','thread-scroll-restore':'ThreadScrollRestore','history-turn-recovery':'HistoryTurnRecovery','native-fast-unlock':'NativeFastUnlock','native-predictions':'NativePredictions','pet-real-mouse':'PetRealMouseLook','activity-overlay-right':'ActivityOverlayRight','stepwise':'StepwiseEnabled','answer-outline':'AnswerOutlineEnabled','capacity-auto-retry':'CapacityAutoRetry','turn-rewind':'TurnRewind','paste-fix':'PasteFix','offline-auto-review':'OfflineAutoReview','statsig-overrides':'StatsigOverrides','reported-usage-compaction':'ReportedUsageCompaction','dream-skin':'DreamSkinEnabled' };
export function backendSettings(store:AuroraStore,state:ExtensionState):Record<string,any>{
  const settings:Record<string,any>={enhancementsEnabled:true,providerSyncEnabled:false,codexAppVersion:state.connection.lastVersion||'',codexAppNativeMenuPlacement:true,codexAppSessionDeleteSkipConfirm:false,codexAppCapacityAutoRetryMaxAttempts:3,codexAppCapacityAutoRetryIntervalSeconds:5,codexAppDreamSkinPaused:false,codexAppDreamSkinThemeConfig:{},codexAppDreamSkinImagePath:'',weixinDesktopSync:[],...state.settings};
  for(const [id,key]of Object.entries(SETTING_IDS))settings[`codexApp${key}`]=!BUILTINS.find(x=>x.id===id)?.unsupported&&effectiveEntry(state,`builtin:${id}`).enabled;
  let custom=false;try{custom=extensionClientConfig().customApi;}catch(error){settings.nativeLocalApiConfigurationError=(error as Error).message;}
  settings.nativeFastLocalApiConfigured=custom;settings.nativePredictionsLocalApiConfigured=custom;
  settings.modelCatalogFingerprint=modelCatalogFingerprint(store);
  settings.dictation=dictationConfiguration(store).status;
  return settings;
}
const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg'};
function dataUrl(file:string,max=12*1024*1024):string{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw new Error('媒体文件无效或过大');const type=mime[path.extname(file).toLowerCase()];if(!type)throw new Error('不支持此媒体格式');return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;}
function bundledAssets(root:string):Record<string,string>{const assets:Record<string,string>={};function walk(dir:string){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile()&&mime[path.extname(f).toLowerCase()])assets[path.relative(root,f).replace(/\\/g,'/')]=dataUrl(f);}}walk(path.join(root,'assets'));return assets;}
function script(file:string):string{return fs.readFileSync(path.join(resourceRoot(),'assets','inject',file),'utf8');}
export function packageScript(id:string,state:ExtensionState):string{
  const root=path.join(resourceRoot(),'materialized','extensions',id),m=manifest(id),key=`bundled:${id}`,entry=effectiveEntry(state,key);
  const renderManifest={id:m.id,name:m.name,version:m.version,description:m.description,engines:m.engines,permissions:m.permissions||{routes:[]},config:entry.config,assets:bundledAssets(root)};
  let source=m.renderer.map((f:string)=>{const s=fs.readFileSync(path.join(root,f),'utf8');return id==='usage-statusline'&&f==='statusline.js'?enhanceUsageSource(s):s;}).join('\n;\n');
  return `(()=>{const runtime=window.__codexPlusUserScripts; const key=${JSON.stringify(key)};runtime.currentKey=key;runtime.scripts[key]={key,name:${JSON.stringify(m.name)},source:'bundled',manifest:${JSON.stringify(renderManifest)},status:'loading',error:'',loadedAt:new Date().toISOString()};try{\n${source}\n; if(runtime.scripts[key].status!=='failed')runtime.scripts[key].status='loaded';}catch(e){runtime.scripts[key].status='failed';runtime.scripts[key].error=String(e.stack||e.message||e);}finally{runtime.currentKey=null;}})();`;
}
const FLOATING_FILES=['runtime/state.js','core/appearance-runtime.js','runtime/dom.js','runtime/bridge-client.js','runtime/answer-context.js','stepwise/suggestions.js','stepwise/generation.js','runtime/lifecycle.js','runtime/settings.js','core/appearance.js','core/host.js','core/geometry.js','core/interaction.js','core/views.js','outline/parser.js','outline/navigation.js','outline/feature.js','outline/view.js','core/scroll-state.js'];
export function buildRuntimeSource(store:AuroraStore,state:ExtensionState,bridge:string,nativeModules=''):string{
  const enabled=(id:string)=>!BUILTINS.find(b=>b.id===id)?.unsupported&&effectiveEntry(state,`builtin:${id}`).enabled;
  const disabled=BUILTINS.filter(b=>!enabled(b.id)).map(b=>b.id),settings=backendSettings(store,state);
  const flags=`window.__codexPlusBuiltinExtensionState=${JSON.stringify({disabled,replacedBy:{}})};globalThis.__codexPlusBuiltinInactive=new Set(${JSON.stringify(disabled)});window.__CODEX_PLUS_VERSION__='2.6.9 / yunhui.me';window.__CODEX_PLUS_BUILD__='yunhui.me-0.6';window.__CODEX_PLUS_INSTANCE_LABEL__=${JSON.stringify(effectiveEntry(state,'builtin:instance-identity').config.label||'云汇 AI')};window.__CODEX_PLUS_PASTE_FIX__={enabled:${enabled('paste-fix')}};window.__CODEX_PLUS_FORCE_CHINESE_LOCALE__={enabled:${enabled('force-chinese-locale')},locale:'zh-CN'};window.__CODEX_PLUS_STATSIG_OVERRIDES__={enabled:${enabled('statsig-overrides')}};window.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__={enabled:false};window.__CODEX_PLUS_EXTERNAL_DREAM_SKIN_RUNTIME__=true;`;
  const prelude=script('composer-readiness.js')+'\n'+script('native-fast-unlock.js')+'\n'+script('native-fast-rspack.js')+`\nwindow.__codexPlusNativeFastUnlock?.runtime.update(${JSON.stringify(settings)});\n`+script('native-predictions.js')+`\nwindow.__codexPlusNativePredictions?.runtime.update(${JSON.stringify(settings)});\n`;
  const bundled=BUNDLED.filter(id=>{const e=effectiveEntry(state,`bundled:${id}`);return e.installed&&e.enabled;}).map(id=>packageScript(id,state)).join('\n');
  const theme=enabled('dream-skin')?dreamThemeSource(effectiveEntry(state,'builtin:dream-skin').config):'';
  const floating=enabled('answer-outline')||enabled('stepwise')?'(()=>{'+FLOATING_FILES.map(f=>script(`floating-panel/${f}`)).join('\n')+script('floating-panel-inject.js')+'})();':'';
  const statsig={enabled:enabled('statsig-overrides'),gates:{'1174206456':true},dynamicConfigs:{'3165814200':{MIN_RETRY_INTERVAL:400,MAX_RETRY_INTERVAL:8000,RETRY_FACTOR:1.6,MAX_RETRY_COUNT:15},'3608673692':{sse_initial_open_timeout_ms:90000,sse_between_bytes_timeout_ms:90000},'339548201':{websocket_initial_idle_timeout_ms:15000,websocket_idle_timeout_ms:45000},'2808262316':{enabled:true}}};
  return `(()=>{if(window!==top||!/^app:\\/\\/-\\//i.test(location.href))return;\n${bridge}\n${flags}\nwindow.__CODEX_PLUS_STATSIG_OVERRIDES__=${JSON.stringify(statsig)};\n${prelude}\n${nativeModules}\nconst start=()=>{if(!window.electronBridge){window.__auroraExtensionError='此页面没有 electronBridge';return;}try{\n${augmentSessionRenderer(script('renderer-inject.js'))}\n${script('user-scripts-runtime.js')}\n${bundled}\n${floating}\n${theme}\nwindow.__auroraExtensionReady=true;}catch(e){window.__auroraExtensionError=String(e.stack||e.message||e)}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();})();`;
}
interface RuntimeStatus { connected:boolean;targetTitle?:string;targetUrl?:string;applied:string[];errors:Array<{id:string;message:string}>;checking?:boolean }
const runtimes=new Map<string,ExtensionRuntime>();
export function runtimeFor(store:AuroraStore):ExtensionRuntime{let rt=runtimes.get(store.dir);if(!rt){rt=new ExtensionRuntime(store);runtimes.set(store.dir,rt);}return rt;}
export class ExtensionRuntime{
  private dictation:DictationBridge;
  private nativeSource='';
  private stopCapture?:()=>Promise<void>;
  private historyTimer?:NodeJS.Timeout;private historyBusy=false;private historyError='';private historyGeneration=0;private reloadTimer?:NodeJS.Timeout;
  private petCdp?:DesktopCdp;private cursorTimer?:NodeJS.Timeout;private cursorBusy=false;private cursorError='';private cursorGeneration=0;
  private observedStatus?:{client:DesktopCdp;value:RuntimeStatus};
  cdp?:DesktopCdp;private bridge='';private lastError='';private nativeErrors:Array<{id:string;message:string}>=[];private nativeRequested:string[]=[];private diagnostics:Array<{time:string,event:string,message:string}>=[];
  constructor(private store:AuroraStore){this.dictation=new DictationBridge(store);}
  snapshot():RuntimeStatus{
    const client=this.cdp,connected=!!client?.connected;
    const errors=connected&&this.observedStatus?.client===client?this.observedStatus.value.errors.map(error=>({...error})):[];
    if(this.lastError&&!errors.some(error=>error.id==='runtime'))errors.push({id:'runtime',message:this.lastError});
    // A live transport confirms the connection, but only status() confirms loaded extensions.
    return{connected,...(connected?{targetTitle:client!.target.title,targetUrl:client!.target.url}:{}),applied:[],errors,checking:true};
  }
  private rememberStatus(client:DesktopCdp,value:RuntimeStatus):RuntimeStatus{if(this.cdp===client)this.observedStatus={client,value};return value;}
  async status():Promise<RuntimeStatus>{
    const cdp=this.cdp;if(!cdp?.connected)return{connected:false,applied:[],errors:this.lastError?[{id:'runtime',message:this.lastError}]:[]};
    try{const result=await cdp.evaluate(`({ready:!!window.__auroraExtensionReady,error:window.__auroraExtensionError||'',scripts:Object.values(window.__codexPlusUserScripts?.scripts||{}).map(s=>({key:s.key,status:s.status,error:s.error||''})),builtins:window.codexPlus?.builtins?.()||[],nativeInstall:window.__auroraNativeInstallResult,nativeCompiled:window.__codexPlusNativeFastCompiled==='v1'})`);
      const errors=[...this.nativeErrors,...result.scripts.filter((s:any)=>s.status==='failed').map((s:any)=>({id:s.key,message:s.error}))];if(this.historyError)errors.push({id:'builtin:history-turn-recovery',message:this.historyError});if(this.cursorError)errors.push({id:'builtin:pet-real-mouse',message:this.cursorError});if(result.error||this.lastError)errors.push({id:'runtime',message:result.error||this.lastError});if(!result.ready&&!errors.some(e=>e.id==='runtime'))errors.push({id:'runtime',message:'桌面扩展尚未完成加载'});if(this.nativeRequested.length&&!this.nativeErrors.length&&!result.nativeCompiled)for(const id of this.nativeRequested)errors.push({id,message:'原生模块未完成加载：'+String(result.nativeInstall?.diagnostics?.reason||result.nativeInstall?.reason||'等待兼容模块')});
      return this.rememberStatus(cdp,{connected:true,targetTitle:cdp.target.title,targetUrl:cdp.target.url,applied:result.ready&&!errors.some(e=>e.id==='runtime')?[...result.scripts.filter((s:any)=>s.status==='loaded').map((s:any)=>s.key),...result.builtins.filter((b:any)=>b.active&&!errors.some(e=>e.id===`builtin:${b.id}`)).map((b:any)=>`builtin:${b.id}`)]:[],errors});
    }catch(e){return this.rememberStatus(cdp,{connected:cdp.connected,targetTitle:cdp.target.title,targetUrl:cdp.target.url,applied:[],errors:[{id:'runtime',message:(e as Error).message}]});}
  }
  async connect(payload:any):Promise<any>{
    const state=loadState(this.store),info=await desktopInfo(state.connection.lastVersion,state.connection.exePath,state.connection.port,true);
    if(info.versionChanged&&!payload.acknowledgeVersion)throw new Error(`客户端已从 ${info.lastVersion} 更新到 ${info.version}，请勾选确认版本变化后重新连接`);
    if(this.cdp?.connected)await this.disconnect();
    try{const opened=await openDesktopConnection({...state.connection,launch:payload.launch===true});this.cdp=opened.cdp;this.bridge=await this.cdp.setBridge((route,p)=>this.route(route,p));state.connection.lastVersion=info.version;saveState(this.store,state);this.lastError='';await this.apply();return{ok:true,message:'已连接兼容桌面，扩展按实际加载结果显示',launched:opened.launched,runtime:await this.status()};}
    catch(e){await this.disconnect().catch(()=>{});this.lastError=(e as Error).message;throw e;}
  }
  async apply():Promise<void>{
    if(!this.cdp?.connected)return;try{this.dictation.cancelAll();this.stopHistory();await this.stopCapture?.();this.stopCapture=undefined;await this.stopCursor();const state=loadState(this.store),plan=await prepareNativeModules(this.cdp,backendSettings(this.store,state));this.nativeErrors=plan.errors;this.nativeRequested=plan.requested;
    this.nativeSource=plan.source;const effective=structuredClone(state);for(const error of plan.errors)effective.entries[error.id]={...effectiveEntry(state,error.id),enabled:false};
    const source=buildRuntimeSource(this.store,effective,this.bridge,plan.source);await this.cdp.replaceScripts(source,true);
    for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));const result=await this.cdp.evaluate('({ready:!!window.__auroraExtensionReady,error:window.__auroraExtensionError||""})').catch(()=>null);if(result?.error)throw new Error(`桌面扩展加载失败：${result.error}`);if(result?.ready){this.lastError='';if(!this.stopCapture)this.stopCapture=captureNativeClient(this.cdp);if(effectiveEntry(state,'builtin:pet-real-mouse').enabled)this.startCursor(state.connection.port);if(effectiveEntry(state,'builtin:history-turn-recovery').enabled)this.startHistory();return;}}
    throw new Error('桌面扩展加载超时；请在兼容桌面版本打开主窗口后重试');
    }catch(e){this.lastError=(e as Error).message;throw e;}
  }
  private startHistory():void{
    const generation=++this.historyGeneration;
    const tick=async()=>{if(generation!==this.historyGeneration||this.historyBusy||!this.cdp?.connected)return;this.historyBusy=true;try{const result=await this.cdp.evaluate('window.__codexPlusHistoryTurnRecoveryRuntime?.run(crypto.randomUUID())');if(generation===this.historyGeneration)this.historyError=result?.status==='unavailable'?`此客户端暂不支持原生历史分页：${result.reason}`:'';}catch(e){if(generation===this.historyGeneration)this.historyError=(e as Error).message;}finally{if(generation===this.historyGeneration)this.historyBusy=false;}};this.historyTimer=setInterval(()=>void tick(),15000);this.historyTimer.unref?.();void tick();
  }
  private stopHistory():void{this.historyGeneration++;if(this.historyTimer)clearInterval(this.historyTimer);this.historyTimer=undefined;this.historyBusy=false;this.historyError='';}
  private startCursor(port:number):void{
    const generation=++this.cursorGeneration;
    const tick=async()=>{if(generation!==this.cursorGeneration||this.cursorBusy||!this.cdp?.connected)return;this.cursorBusy=true;try{
      const electron=await import('electron');if(generation!==this.cursorGeneration)return;const screen=electron.screen;if(!screen?.getCursorScreenPoint)throw new Error('系统光标同步需要云汇 Windows/macOS 桌面进程');
      if(!this.petCdp?.connected){const connected=await DesktopCdp.connect(port,'avatar');if(generation!==this.cursorGeneration){connected.close();return;}this.petCdp=connected;await this.petCdp.replaceScripts(`(()=>{const start=()=>{${script('pet-real-mouse-inject.js')}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();})();`,false);}
      if(generation!==this.cursorGeneration)return;const point=screen.getCursorScreenPoint();const accepted=await this.petCdp.evaluate(`window.__codexPlusPetRealMouseLook?.updateScreenPoint(${JSON.stringify(point)})===true`);if(!accepted)throw new Error('原生桌宠尚未准备好');if(generation===this.cursorGeneration)this.cursorError='';
    }catch(e){if(generation===this.cursorGeneration)this.cursorError=`等待原生桌宠窗口：${(e as Error).message}`;}finally{if(generation===this.cursorGeneration)this.cursorBusy=false;}};
    this.cursorTimer=setInterval(()=>void tick(),2000);this.cursorTimer.unref?.();void tick();
  }
  private async stopCursor():Promise<void>{this.cursorGeneration++;this.cursorBusy=false;if(this.cursorTimer)clearInterval(this.cursorTimer);this.cursorTimer=undefined;this.cursorError='';await this.petCdp?.evaluate('window.__codexPlusPetRealMouseLook?.stop()').catch(()=>{});await this.petCdp?.dispose(false);this.petCdp=undefined;}
  private scheduleApply():void{if(this.reloadTimer)clearTimeout(this.reloadTimer);this.reloadTimer=setTimeout(()=>{this.reloadTimer=undefined;if(extensionOperationBusy(this.store)){this.scheduleApply();return;}void extensionOperation(this.store,()=>this.apply()).catch(e=>{this.lastError=(e as Error).message;});},100);this.reloadTimer.unref?.();}
  async disconnect():Promise<void>{if(this.reloadTimer)clearTimeout(this.reloadTimer);this.reloadTimer=undefined;this.dictation.cancelAll();this.stopHistory();await this.stopCapture?.();this.stopCapture=undefined;await this.stopCursor();const cdp=this.cdp;this.cdp=undefined;await cdp?.dispose(true);this.lastError='';}
  async route(route:string,payload:any):Promise<any>{
    const dictationResult=await this.dictation.route(route,payload);if(dictationResult!==null)return dictationResult;
    const state=loadState(this.store);
    if(route==='/settings/get'||route==='/settings/public')return backendSettings(this.store,state);
    if(route==='/codex-model-catalog'||route==='/model-catalog/public')return desktopModelCatalog(this.store);
    if(route==='/settings/set')return extensionOperation(this.store,async()=>{
      const allowed=Object.fromEntries(Object.entries(SETTING_IDS).map(([id,key])=>[`codexApp${key}`,id]));
      for(const[key,value]of Object.entries(payload)){const id=allowed[key];if(id){const def=BUILTINS.find(b=>b.id===id)!;if(def.unsupported&&value)throw new Error(def.unsupported);if(typeof value!=='boolean')throw new Error('设置值必须是开关');state.entries[`builtin:${id}`]={...effectiveEntry(state,`builtin:${id}`),enabled:value};}else if(['codexAppConversationViewMaxWidth','codexAppCapacityAutoRetryMaxAttempts','codexAppCapacityAutoRetryIntervalSeconds'].includes(key)&&typeof value==='number'&&value>=0&&value<=4000)state.settings[key]=value;else throw new Error(`云汇尚未开放此上游设置：${key}`);}
      if(payload.codexAppModelWhitelistUnlock===true&&desktopModelCatalog(this.store).status!=='ok')throw new Error('请先在客户端页为 ChatGPT 桌面版应用供应商配置');
      saveState(this.store,state);this.scheduleApply();return backendSettings(this.store,state);
    });
    if(route==='/settings/catalog')return {status:'ok',groups:[],items:[]};
    if(route==='/backend/status')return {status:'ok',version:'2.6.9 / yunhui.me',build:'yunhui.me-0.6',available:true};
    if(route==='/stepwise/settings'){const info=stepwiseSettings(this.store);return{status:info.status,settings:info.settings};}
    if(route==='/stepwise/generate')return generateSuggestions(this.store,payload);
    if(route==='/stepwise/test'){const info=stepwiseSettings(this.store);return{status:info.settings.apiKeyConfigured?'ok':'failed',message:info.settings.apiKeyConfigured?'已配置供应商；点击生成建议将实际调用模型':'请先配置供应商 API Key'};}
    if(route==='/diagnostics/log'){this.diagnostics.push({time:new Date().toISOString(),event:String(payload.event||'').slice(0,120),message:String(payload.message||payload.detail?.message||'').slice(0,1000)});this.diagnostics=this.diagnostics.slice(-50);return{status:'ok'};}
    if(route==='/thread-usage-live'){
      const id=String(payload.session_id||'').replace(/^local:/,'');const result=threadUsage(id);
      if(!result.events.length){
        result.events=this.store.recentRequests(300).filter(r=>r.threadId===id).reverse().map(r=>({t:r.ts,turn_id:null,input_tokens:r.estimated?null:r.inputTokens,output_tokens:r.estimated?null:r.outputTokens,cached_input_tokens:r.cacheReadKnown?r.cacheRead:null,cache_write_tokens:r.cacheWriteKnown?r.cacheWrite:null,total_tokens:r.estimated?null:r.inputTokens+r.outputTokens,context_window:null,turn_output_tokens:null,source:'yunhui.me-gateway'}));
        if(result.events.length)result.status='ok';
      }
      const live=activeRequests(this.store).filter(r=>r.threadId===id).at(-1);
      if(live&&[live.inputTokens,live.outputTokens,live.cacheRead,live.cacheWrite].some(v=>v!==undefined)){
        result.events.push({t:new Date().toISOString(),turn_id:`gateway:${live.id}`,input_tokens:live.inputTokens??null,output_tokens:live.outputTokens??null,cached_input_tokens:live.cacheRead??null,cache_write_tokens:live.cacheWrite??null,total_tokens:live.inputTokens!==undefined&&live.outputTokens!==undefined?live.inputTokens+live.outputTokens:null,context_window:result.events.at(-1)?.context_window??null,turn_output_tokens:null,source:'yunhui.me-gateway-live'});result.status='ok';
      }
      return result;
    }
    if(route==='/proxy-status')return {status:'ok',requests:activeRequests(this.store).filter(r=>r.threadId).map(r=>({...r,phase:r.phase==='streaming'?'generating':r.phase==='connecting'?'requesting':'retrying',attemptDetails:[]}))};
    const sessionResult=await sessionRoute(this.store,this.cdp,route,payload);if(sessionResult!==null)return sessionResult;
    if(route==='/image-overlay/image'){
      const file=effectiveEntry(state,'bundled:image-overlay').config.imagePath;if(!file)throw new Error('请先在云汇扩展设置选择背景图片');return{status:'ok',dataUrl:dataUrl(path.resolve(file))};
    }
    if(route==='/agent-pet/image'){
      const config=effectiveEntry(state,'bundled:agent-pet').config;
      if(config.image==='custom'&&config.customImageUrl){const url=new URL(config.customImageUrl);if(url.protocol!=='https:'||url.username||url.password)throw new Error('自定义图片必须是 HTTPS 地址');const r=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'});const type=r.headers.get('content-type')?.split(';')[0]||'';if(!r.ok||!/^image\/(png|jpeg|gif|webp)$/.test(type))throw new Error('图片下载失败或格式不支持');const chunks:Buffer[]=[];let size=0;for await(const chunk of r.body as any){size+=chunk.length;if(size>8*1024*1024)throw new Error('图片超过8MB');chunks.push(Buffer.from(chunk));}return{status:'ok',image:`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`};}
      return{status:'ok',image:dataUrl(path.join(resourceRoot(),'assets','inject','upstream','whale-widget','DSniang1.png'))};
    }
    if(route==='/agent-pet/catalog')return{status:'ok',images:[{id:'whale',name:'大肥鱼'}],sounds:[{id:'duck',name:'鸭鸭'},{id:'fx1',name:'特效音'}]};
    if(route==='/agent-pet/sound'){
      const conf=effectiveEntry(state,'bundled:agent-pet').config,set=conf.soundSet==='fx1'?'D':'Ya';if(conf.soundSet==='custom')throw new Error('自定义音效导入尚未接入；可使用内置音效');const dir=path.join(resourceRoot(),'assets','inject','agent-pet','sounds');return{status:'ok',key:conf.soundSet||'duck',press:dataUrl(path.join(dir,`${set}1.mp3`)),release:dataUrl(path.join(dir,`${set}2.mp3`))};
    }
    if(route==='/whale/media'){const dir=path.join(resourceRoot(),'assets','inject','upstream','whale-widget'),assets:Record<string,string>={};for(const f of fs.readdirSync(dir))if(mime[path.extname(f)])assets[f]=dataUrl(path.join(dir,f));return{status:'ok',image:assets['DSniang1.png'],assets};}
    if(['/whale/full','/whale/history','/whale/session'].includes(route))return{status:'unavailable',balance:null,usage:null,message:'此供应商未提供余额/大肥鱼统计接口；实时用量请查看用量状态栏'};
    if(route==='/plugin-market/native')return nativeRequest(this.store,payload);
    if(route==='/plugin-market/list'){
      if(payload.source!==undefined&&!['public','full'].includes(payload.source))throw new Error('未知插件市场');
      const source=payload.source==='public'?'public':'full';
      const refresh=payload.refresh===true?await refreshMarkets(this.store,[source]):undefined;
      const index=managedIndex(this.store,source,loadIndex(this.store,source)),installed=installedPlugins(this.store);
      return{status:'ok',...index,source,refresh,cached:refresh?.ok===false,
        message:refresh?.results[0]?.message,warning:refresh?.ok===false?refresh.results[0]?.message:undefined,
        plugins:index.plugins.map(p=>{const saved=installed[nativeKey(source,p.id)];return{...p,installed:!!saved,installedVersion:saved?.version,updateAvailable:!p.catalogMissing&&!!saved&&(saved.tree!==p.tree||!packagePresent(this.store,saved)),enabled:saved?.enabled||false};})};
    }
    if(route==='/plugin-market/install'){const source=payload.source==='public'?'public':'full';await installNative(this.store,source,String(payload.id));return nativeInstallStatus(this.store,source,String(payload.id));}
    if(route==='/plugin-market/install-status'){const source=payload.source==='public'?'public':'full';return nativeInstallStatus(this.store,source,String(payload.id));}
    if(route==='/user-scripts/set-config')return extensionOperation(this.store,async()=>{
      const key=String(payload.key||''),id=key.slice(8);if(!key.startsWith('bundled:')||!BUNDLED.includes(id))throw new Error('此配置页仅支持已安装的随附扩展');const entry=effectiveEntry(state,key);if(!entry.installed)throw new Error('请先安装扩展');entry.config={...entry.config,...validatePackageConfig(id,payload.values)};state.entries[key]=entry;saveState(this.store,state);
      if(this.cdp?.connected)await this.cdp.updateDocumentSource(buildRuntimeSource(this.store,state,this.bridge,this.nativeSource));return{status:'ok',config:entry.config};
    });
    if(route==='/user-scripts/readme'){
      const id=String(payload.key||'').replace(/^bundled:/,'');if(!BUNDLED.includes(id))throw new Error('未知随附扩展');const root=path.join(resourceRoot(),'materialized','extensions',id),file=['README.zh-CN.md','README.md'].map(f=>path.join(root,f)).find(f=>fs.existsSync(f));return{status:'ok',markdown:file?fs.readFileSync(file,'utf8').slice(0,512*1024):manifest(id).description,assets:bundledAssets(root),truncated:file?fs.statSync(file).size>512*1024:false};
    }
    if(route==='/user-scripts/set-script-enabled'||route==='/user-scripts/delete'){
      const {runExtensionAction}=await import('./index.js');await runExtensionAction({store:this.store},route==='/user-scripts/delete'?'extension.remove':'extension.toggle',{id:payload.key,enabled:payload.enabled});return this.route('/user-scripts/list',{});
    }
    if(route==='/user-scripts/reload'){this.scheduleApply();return this.route('/user-scripts/list',{});}
    if(route==='/user-scripts/list'){
      const runtime=await this.status(),applied=new Set(runtime.applied),errors=new Map(runtime.errors.map(e=>[e.id,e.message]));
      return{status:'ok',scripts:BUNDLED.filter(id=>effectiveEntry(state,`bundled:${id}`).installed).map(id=>{const key=`bundled:${id}`,m=manifest(id),entry=effectiveEntry(state,key);return{key,name:m.name,source:'bundled',enabled:entry.enabled,status:errors.has(key)?'failed':applied.has(key)?'loaded':entry.enabled?'pending':'disabled',error:errors.get(key)||'',package:{...m,configSchema:m.config,config:entry.config}};}),builtins:BUILTINS.map(b=>({...b,key:`builtin:${b.id}`,...effectiveEntry(state,`builtin:${b.id}`)}))};
    }
    if(route==='/extensions/request-capture'){if(this.cdp?.connected&&!this.stopCapture)this.stopCapture=captureNativeClient(this.cdp);return{status:'ok',message:'已启动原生客户端能力识别'};}
    throw new Error(`云汇尚未适配此后台能力：${route}`);
  }
}
