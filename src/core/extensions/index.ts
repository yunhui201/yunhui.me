import fs from 'node:fs';
import path from 'node:path';
import type { AuroraStore } from '../store/index.js';
import { desktopInfo, inspectCodingDesktop, validateDebugPort, type CodexDesktopInfo } from '../injector.js';
import { BUILTINS, BUNDLED, effectiveEntry, loadState, saveState, manifest, validateConfig, validatePackageConfig } from './catalog.js';
import { installedPlugins, installNative, loadIndex, nativeKey, packagePresent, refreshMarkets, removeNative, resourceRoot, toggleNative, type MarketSource } from './market.js';
import { runtimeFor } from './runtime.js';
import { setWorkViewDisabled } from './workView.js';
import { desktopModelCatalog } from './models.js';
import { dictationConfiguration } from './dictation.js';
import { stepwiseSettings } from './stepwise.js';
import { extensionOperation } from './operations.js';
import { planned } from '../agents/configFiles.js';
function sourceKey(id:string):{source:MarketSource;id:string}|null{const m=/^(public|full):(.+)$/.exec(id);return m?{source:m[1] as MarketSource,id:m[2]}:null;}
const clientSnapshots=new WeakMap<AuroraStore,{key:string;value:CodexDesktopInfo}>();
export async function listExtensions(store:AuroraStore,payload:any={}):Promise<any>{
  const state=loadState(store),rt=runtimeFor(store);
  const probeClient=payload.probeClient!==false,key=JSON.stringify(state.connection),previous=clientSnapshots.get(store);
  const [runtime,client]=probeClient
    ?await Promise.all([rt.status(),desktopInfo(state.connection.lastVersion,state.connection.exePath,state.connection.port)])
    :[rt.snapshot(),previous?.key===key?previous.value:{installed:false,supportsCodexConfig:false,evidence:[],running:false,debugPortOpen:false,versionChanged:false,lastVersion:state.connection.lastVersion} as CodexDesktopInfo];
  if(probeClient)clientSnapshots.set(store,{key,value:client});
  const upstream=JSON.parse(fs.readFileSync(path.join(resourceRoot(),'UPSTREAM.json'),'utf8'));const applied=new Set(runtime.applied),errors=new Map(runtime.errors.map(e=>[e.id,e.message]));
  const missingConfig=new Map<string,string>(),dictation=dictationConfiguration(store).status,stepwise=stepwiseSettings(store).settings;
  if(dictation.enabled&&!dictation.configured)missingConfig.set('builtin:dictation',dictation.message);
  if(stepwise.enabled&&(!stepwise.baseUrlConfigured||!stepwise.apiKeyConfigured||!stepwise.model))missingConfig.set('builtin:stepwise','请先为 ChatGPT 桌面版配置可用供应商与模型，或在下一步建议设置中指定供应商 ID 与模型');
  const status=(id:string,installed:boolean,enabled:boolean,unsupported?:string)=>id==='builtin:reasoning-collapse'||id==='builtin:disable-work-view'?'installed':unsupported?'unsupported':errors.has(id)||(enabled&&errors.has('runtime'))?'error':missingConfig.has(id)?'installed':applied.has(id)?'active':enabled?'needs-connection':installed?'installed':'available';
  let items:any[]=[...BUILTINS.map(b=>{const id=`builtin:${b.id}`,e=effectiveEntry(state,id);return{...b,id,version:'2.6.9',source:'builtin',license:'AGPL-3.0-only',...e,status:status(id,true,e.enabled,b.unsupported),reason:b.unsupported||errors.get(id)||(e.enabled?errors.get('runtime'):undefined)||missingConfig.get(id)||(b.id==='reasoning-collapse'?'开关已保存；仅处理经云汇网关的 ChatGPT/Codex Responses 请求':b.id==='disable-work-view'?'设置写入客户端配置，重启客户端生效':undefined),configSchema:b.configSchema};}),...BUNDLED.map(name=>{const m=manifest(name),id=`bundled:${name}`,e=effectiveEntry(state,id);return{id,name:m.name,description:m.description,version:m.version,source:'bundled',license:name==='agent-pet'?'AGPL-3.0-only；鲸鱼素材另见 PROVENANCE.md':'AGPL-3.0-only',...e,status:status(id,e.installed,e.enabled),reason:errors.get(id)||(e.enabled?errors.get('runtime'):undefined),configSchema:m.config||{},upstreamId:name};})];
  const installed=installedPlugins(store),catalogs:any={};
  for(const source of ['public','full'] as const){const index=loadIndex(store,source);catalogs[source]={count:index.plugins.length,revision:index.revision,updatedAt:index.updatedAt,repository:index.repository};
    items.push(...index.plugins.map(p=>{const id=nativeKey(source,p.id),saved=installed[id],present=!!saved&&packagePresent(store,saved);return{id,name:p.displayName||p.name,description:p.description,version:saved?.version||p.version,availableVersion:p.version,updateAvailable:!!saved&&saved.tree!==p.tree,source,license:saved?.license||p.license||'未声明许可',installed:!!saved,packagePresent:present,missingFiles:!!saved&&!present,catalogMissing:false,enabled:!!saved?.enabled,status:saved&&!present?'error':present?'installed':'available',reason:!present&&saved?'本地插件文件已丢失，请修复安装或移除注册':saved?.enabled?'已写入客户端插件配置；重启客户端后按原生规则加载':p.requiresAuth?'此插件需要登录对应服务，安装不会自动授权':undefined,requiresRestart:true,requiresAuth:p.requiresAuth,tags:p.tags,author:p.author,skills:p.skills,bytes:p.bytes,revision:saved?.revision||index.revision};}));
    const knownIds=new Set(index.plugins.map(p=>p.id));
    for(const saved of Object.values(installed).filter(p=>p.source===source&&!knownIds.has(p.id))){const present=packagePresent(store,saved);items.push({id:nativeKey(source,saved.id),name:saved.name,description:'此插件已从当前目录下架，保留本地安装管理',version:saved.version,availableVersion:null,updateAvailable:false,source,license:saved.license,installed:true,packagePresent:present,missingFiles:!present,catalogMissing:true,enabled:saved.enabled,status:present?'installed':'error',reason:present?'目录已下架；仍可管理本地启停和移除注册':'目录已下架且本地文件丢失；可停用或移除注册',requiresRestart:true,revision:saved.revision});}
  }
  if(payload.source)items=items.filter(i=>i.source===payload.source);
  if(payload.query){const q=String(payload.query).toLowerCase();items=items.filter(i=>`${i.name} ${i.description} ${(i.tags||[]).join(' ')}`.toLowerCase().includes(q));}
  const total=items.length;if(payload.limit)items=items.slice(Math.max(0,Number(payload.offset)||0),Math.max(0,Number(payload.offset)||0)+Math.min(1000,Math.max(1,Number(payload.limit)||200)));
  return{ok:true,upstream:{repository:upstream.repository,version:'2.6.9',revision:upstream.commit,license:upstream.license},client:{...client,connected:runtime.connected,compatible:runtime.connected||client.supportsCodexConfig,detecting:!probeClient},items,total,catalogs,connection:state.connection,runtime};
}
export async function runExtensionAction(deps:{store:AuroraStore},action:string,payload:any={}):Promise<any|null>{
  if(!action.startsWith('extension.'))return null;const store=deps.store;
  if(action==='extension.list')return listExtensions(store,payload);
  return extensionOperation(store,async()=>{
    const state=loadState(store),runtime=runtimeFor(store);
    if(action==='extension.configure'){
      if(payload.port!==undefined)state.connection.port=validateDebugPort(payload.port);
      if(payload.exePath!==undefined){if(typeof payload.exePath!=='string')throw new Error('程序路径无效');const exe=payload.exePath.trim();const detected=exe?inspectCodingDesktop(exe):undefined;if(exe&&!detected?.installed)throw new Error('指定的桌面程序不存在；macOS 请选择完整 .app 应用包');state.connection.exePath=detected?.exePath||undefined;state.connection.lastVersion=undefined;}
      await runtime.disconnect();saveState(store,state);return{ok:true,connection:state.connection};
    }
    if(action==='extension.connect')return runtime.connect(payload);
    if(action==='extension.disconnect'){await runtime.disconnect();return{ok:true};}
    if(action==='extension.refresh')return refreshMarkets(store,payload.source?[payload.source]:['public','full']);
    const id=String(payload.id||''),native=sourceKey(id);
    if(native){if(action==='extension.install'){const item=await installNative(store,native.source,native.id);return{ok:true,item,message:'插件已校验并安装，启用后重启客户端生效'};}if(action==='extension.toggle'){if(typeof payload.enabled!=='boolean')throw new Error('启用状态无效');return{ok:true,item:toggleNative(store,native.source,native.id,payload.enabled)};}if(action==='extension.remove'){removeNative(store,native.source,native.id);return{ok:true,message:'已移除客户端注册，保留源码与许可证缓存'};}throw new Error('此原生插件不支持该操作');}
    const builtin=BUILTINS.find(b=>`builtin:${b.id}`===id),bundled=id.startsWith('bundled:')&&BUNDLED.includes(id.slice(8));if(!builtin&&!bundled)throw new Error('未知扩展');
    const entry=effectiveEntry(state,id);
    if(action==='extension.install'){entry.installed=true;}
    else if(action==='extension.toggle'){if(typeof payload.enabled!=='boolean')throw new Error('启用状态无效');if(builtin?.unsupported&&payload.enabled)throw new Error(builtin.unsupported);if(!entry.installed&&payload.enabled)throw new Error('请先安装扩展');entry.enabled=payload.enabled;}
    else if(action==='extension.remove'){if(builtin)throw new Error('系统增强可停用，不能移除');entry.installed=false;entry.enabled=false;}
    else if(action==='extension.config'){const values=bundled?validatePackageConfig(id.slice(8),payload.config):validateConfig(builtin?.configSchema||{},payload.config);entry.config={...entry.config,...values};}
    else throw new Error('未知扩展操作');
    if(id==='builtin:model-whitelist-unlock'&&entry.enabled&&desktopModelCatalog(store).status!=='ok')throw new Error('请先在客户端页为 ChatGPT 桌面版应用供应商配置');
    state.entries[id]=entry;
    if(id==='builtin:disable-work-view'&&action==='extension.toggle')setWorkViewDisabled(store,entry.enabled,[planned(path.join(store.dir,'extensions.json'),JSON.stringify(state,null,2))]);else saveState(store,state);
    await runtime.apply();return{ok:true,item:{id,...entry},runtime:await runtime.status()};
  });
}
