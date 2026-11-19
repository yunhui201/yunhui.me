import { createHash } from 'node:crypto';
import type { AuroraStore } from '../store/index.js';
import { readTomlValue } from '../codex.js';
import { getCoexistCatalog, isCodexCoexistConfigured } from '../gateway/coexist.js';
import { extensionClientConfig } from './clientConfig.js';
export function desktopModelCatalog(store:AuroraStore):any{
  if(isCodexCoexistConfigured(store)){
    const catalog=getCoexistCatalog(store),models=catalog.models.map(m=>m.id),model=readTomlValue('model')||models[0]||'';
    const modelMetadata=Object.fromEntries(catalog.models.map(m=>{const native=catalog.nativeCatalog.models.find(n=>n.slug===m.id);return[m.id,{displayName:m.displayName,description:m.providerName,...(m.contextWindow?{contextWindow:m.contextWindow,maxContextWindow:m.contextWindow}:{}),...(native?.default_reasoning_level?{defaultReasoningEffort:native.default_reasoning_level}:{}),...(native?.supported_reasoning_levels?{supportedReasoningEfforts:native.supported_reasoning_levels.map((e:any)=>({reasoningEffort:e.effort,description:e.description||e.effort}))}: {})}];}));
    return{status:models.length?'ok':'not_configured',models,model,default_model:model,model_provider:'aurora-coexist',codex_model_provider:'openai',provider_name:'官方账号与第三方供应商',modelMetadata,sources:[...new Map(catalog.models.map(m=>[m.providerId,{id:m.providerId,name:m.providerName}])).values()],responses_api:{status:'configured',message:'官方模型直达官方后端，第三方模型按供应商前缀路由'},warnings:catalog.warnings};
  }
  const agents=store.listAgents(),agent=agents['chatgpt-desktop']||agents['codex-desktop']||agents['codex-cli'];
  let config: ReturnType<typeof extensionClientConfig>;
  try { config=extensionClientConfig(); }
  catch { return{status:'not_configured',models:[],modelMetadata:{},message:'客户端配置无法解析，请检查后重新应用供应商'}; }
  const configured=config.provider;
  const provider=agent?.providerId?store.getProvider(agent.providerId):undefined;
  if(!agent?.connected||!configured||!['yunhui','aurora'].includes(configured)||!provider?.enabled)return{status:'not_configured',models:[],modelMetadata:{},message:'请先使用云汇为 ChatGPT 桌面版配置并应用供应商'};
  const nativeModel=(typeof config.root.profile==='string'?config.root.profiles?.[config.root.profile]?.model:undefined)??config.root.model;
  const models=provider.models.map(m=>m.id);const model=(typeof nativeModel==='string'?nativeModel:undefined)||agent.model||models[0]||'';
  const modelMetadata=Object.fromEntries(provider.models.map(m=>[m.id,{displayName:m.displayName||m.id,description:provider.name,...(m.contextWindow?{contextWindow:m.contextWindow,maxContextWindow:m.contextWindow}:{}),...(m.capabilities?.thinking===false?{defaultReasoningEffort:'none',supportedReasoningEfforts:[{reasoningEffort:'none',description:'此模型未启用额外思考'}]}:{})}]));
  return{status:'ok',models,model,default_model:model,model_provider:configured,codex_model_provider:configured,provider_name:provider.name,modelMetadata,sources:[{id:`${configured}:${provider.id}`,name:provider.name}],responses_api:{status:agent.mode==='gateway'||provider.format==='openai-responses'?'configured':'unknown',message:'使用已保存的供应商模型目录'}};
}
export function modelCatalogFingerprint(store:AuroraStore):string{return createHash('sha256').update(JSON.stringify(desktopModelCatalog(store))).digest('hex');}
