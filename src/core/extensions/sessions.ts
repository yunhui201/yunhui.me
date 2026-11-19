import { randomBytes } from 'node:crypto';
import type { AuroraStore } from '../store/index.js';
import type { DesktopCdp } from '../injector.js';
import { scanSessions, exportSessionMarkdown } from '../sessions.js';
import { extensionOperation } from './operations.js';
import { queryExtensionHistory } from './sessionQuery.js';
const ALLOWED=['thread/read','thread/archive','thread/unarchive'];
/** Inserted inside the upstream renderer closure, after its native manager discovery helpers exist. */
export const nativeSessionBootstrap=`window.__auroraNativeSessionRequest=async(method,params)=>{if(!${JSON.stringify(ALLOWED)}.includes(method))throw new Error('原生会话操作未授权');const client=await codexPlusAppServerClient('local');return client.sendRequest(method,params);};`;
export function augmentSessionRenderer(source:string):string{
  const marker='window.codexPlus = buildCodexPlusExtensionApi();';if(!source.includes(marker))throw new Error('原生会话桥接入口已变化');
  return source.replace(marker,marker+'\n'+nativeSessionBootstrap)
    // The compatible row action archives through the native server and never deletes session files.
    .replaceAll('删除会话','归档会话').replaceAll('删除“${escapeHtml(title)}”？','归档“${escapeHtml(title)}”？')
    .replaceAll('这将永久删除远端任务及其子任务，无法撤销。','云汇仅支持本地会话归档。')
    .replaceAll('data-codex-delete-confirm="true">删除','data-codex-delete-confirm="true">归档')
    .replace('label: "删除",','label: "归档",');
}
function sessionId(value:any):string{const id=String(value||'').replace(/^local:/,'');if(!/^[a-zA-Z0-9_-]{8,150}$/.test(id))throw new Error('会话 ID 无效');return id;}
export async function sessionRoute(store:AuroraStore,cdp:DesktopCdp|undefined,route:string,payload:any):Promise<any|null>{
  if(!['/delete','/undo','/export-markdown','/archived-thread','/extensions/history'].includes(route))return null;
  if(payload.host_id&&payload.host_id!=='local')throw new Error('仅支持本地会话操作');
  const native=async(method:string,params:any)=>{if(!cdp?.connected)throw new Error('请先连接桌面客户端');return cdp.evaluate(`window.__auroraNativeSessionRequest(${JSON.stringify(method)},${JSON.stringify(params)})`);};
  if(route==='/archived-thread'){const title=String(payload.title||'');const matches=scanSessions().filter(s=>s.agent==='Codex'&&s.title===title);if(matches.length!==1)throw new Error('无法唯一识别此归档会话，请从云汇历史会话中按 ID 导出');return{status:'ok',session_id:matches[0].id,host_id:'local',title:matches[0].title};}
  if(route==='/export-markdown'){const id=sessionId(payload.session_id),item=scanSessions().find(s=>s.agent==='Codex'&&s.id===id);if(!item)throw new Error('未找到此本地会话');return{status:'exported',filename:`${id}.md`,markdown:exportSessionMarkdown(item),message:'已导出本地会话'};}
  if(route==='/extensions/history'){
    return{status:'ok',result:await queryExtensionHistory(String(payload.method||''),payload.params)};
  }
  return extensionOperation(store,async()=>{
  const pending=store.readExtra<Record<string,{id:string;at:number}>>('extension-session-undo.json',{});
  for(const[token,entry]of Object.entries(pending))if(Date.now()-entry.at>86400000)delete pending[token];
  if(route==='/delete'){
    const id=sessionId(payload.session_id);const read=await native('thread/read',{threadId:id,includeTurns:false});if(!read?.thread||read.thread.id!==id)throw new Error('原生客户端未确认此会话');
    if(['active','inProgress','running'].includes(read.thread.status?.type||read.thread.status))throw new Error('会话正在运行，请先停止当前轮次再归档');
    const token=randomBytes(24).toString('hex');pending[token]={id,at:Date.now()};store.writeExtra('extension-session-undo.json',pending);
    try{await native('thread/archive',{threadId:id});}catch(e){delete pending[token];try{store.writeExtra('extension-session-undo.json',pending);}catch{/* Retain the recoverable intent if storage becomes unavailable. */}throw e;}
    return{status:'local_deleted',session_id:id,host_id:'local',undo_token:token,message:'会话已移至原生归档，可撤销；会话文件已保留'};
  }
  const token=String(payload.undo_token||''),entry=/^[a-f0-9]{48}$/.test(token)&&Object.hasOwn(pending,token)?pending[token]:undefined;if(!entry)throw new Error('撤销记录不存在或已过期，可在客户端归档列表恢复');sessionId(entry.id);
  await native('thread/unarchive',{threadId:entry.id});delete pending[token];let message='会话已从原生归档恢复';try{store.writeExtra('extension-session-undo.json',pending);}catch{message+='；撤销记录清理失败，可稍后重试清理';}return{status:'undone',session_id:entry.id,host_id:'local',message};
  });
}
