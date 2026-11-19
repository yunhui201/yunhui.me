import fs from 'node:fs';
import path from 'node:path';
import type { AuroraStore } from '../store/index.js';
import { resourceRoot } from './market.js';
export interface ExtensionState { connection: { port: number; exePath?: string; lastVersion?: string }; entries: Record<string, { installed: boolean; enabled: boolean; config?: Record<string, any> }>; settings: Record<string, any> }
export interface BuiltinDefinition { id: string; name: string; description: string; setting?: string; unsupported?: string; requiresRestart?: boolean; configSchema?: Record<string, any> }
export const BUILTINS: BuiltinDefinition[] = [
  { id:'dictation',name:'语音听写',description:'录音转文字后回填原生输入框；需要供应商支持 /audio/transcriptions，会消耗 ASR 额度',configSchema:{providerId:{type:'string',title:'语音供应商 ID',default:''},model:{type:'string',title:'ASR 模型',default:'whisper-1'},language:{type:'string',title:'识别语言（如 zh，留空自动）',default:'zh'}} },
  { id:'turn-rewind',name:'轮次回退',description:'通过原生管理器执行安全回退，保留恢复记录；需要客户端支持 thread/revert' },
  { id:'side-chat-save',name:'侧聊保存',description:'将临时侧聊保存为独立会话',unsupported:'需要原生会话分叉与索引事务，当前适配器未提供。' },
  { id:'history-turn-recovery',name:'历史轮次补全',description:'通过原生分页 API 补载当前会话缺失的历史轮次；丢失索引请先使用历史修复' },
  { id:'capacity-auto-retry',name:'容量不足自动重试',description:'识别容量提示并重试当前请求',setting:'codexAppCapacityAutoRetry' },
  { id:'model-picker-groups',name:'模型分组',description:'在原生模型菜单按供应商分组' },
  { id:'dream-skin',name:'梦皮主题',description:'梦皮、雪境、玻璃与虎主题，支持自定义背景图',setting:'codexAppDreamSkinEnabled',configSchema:{theme:{type:'select',title:'主题',default:'dream',options:[{value:'dream',label:'梦皮'},{value:'snow',label:'雪境'},{value:'glass',label:'玻璃'},{value:'tiger',label:'虎主题'}]},imagePath:{type:'file',title:'自定义背景图（留空用内置图）',default:''}} },
  { id:'plugin-market-unlock',name:'插件市场解锁',description:'开放原生插件入口并接入公开库与完整库；服务授权仍由客户端处理',setting:'codexAppPluginMarketUnlock' },
  { id:'instance-identity',name:'实例身份提示',description:'在桌面窗口显示当前连接名称',configSchema:{label:{type:'string',title:'实例名称',default:'云汇 AI'}} },
  { id:'session-title-hook',name:'会话标题中间件',description:'为已注册 session/title 处理器的扩展提供原生标题读写' },
  { id:'session-delete',name:'会话归档与撤销',description:'通过原生客户端移入归档并可撤销，保留完整会话文件' },
  { id:'markdown-export',name:'Markdown 导出',description:'导出本地对话 Markdown；超长会话会标明导出范围' },
  { id:'thread-id-badge',name:'会话 ID 角标',description:'显示并复制原生会话 ID' },
  { id:'thread-scroll-restore',name:'滚动位置恢复',description:'切换会话时恢复阅读位置',setting:'codexAppThreadScrollRestore' },
  { id:'conversation-view',name:'对话宽度',description:'在原生对话中切换内容显示宽度' },
  { id:'activity-overlay-right',name:'消息导航条靠右',description:'调整原生消息导航位置',setting:'codexAppActivityOverlayRight' },
  { id:'paste-fix',name:'粘贴修复',description:'修复原生桌面输入框的粘贴兼容问题' },
  { id:'offline-auto-review',name:'离线审批入口',description:'远程功能开关不可用时补全原生审批入口' },
  { id:'statsig-overrides',name:'Statsig 界面增强',description:'为兼容客户端启用上游界面增强开关' },
  { id:'weixin-desktop-sync',name:'微信会话同步',description:'将微信消息同步到桌面会话',unsupported:'需要微信账号连接、消息接收和 app-server 写入；尚未接入微信。' },
  { id:'stepwise',name:'下一步建议',description:'通过已配置模型生成中文下一步建议，使用本地网关并消耗模型额度；默认手动触发',configSchema:{providerId:{type:'string',title:'供应商 ID（留空用桌面绑定）',default:''},model:{type:'string',title:'模型（留空用桌面绑定）',default:''},generationMode:{type:'select',title:'生成方式',default:'manual',options:[{value:'manual',label:'手动生成'},{value:'auto',label:'自动生成'}]}} },
  { id:'answer-outline',name:'回答大纲',description:'提取回答标题并快速跳转',setting:'codexAppAnswerOutlineEnabled' },
  { id:'pet-real-mouse',name:'原生桌宠跟随鼠标',description:'打开客户端原生桌宠后，通过独立桌宠窗口同步系统光标' },
  { id:'model-whitelist-unlock',name:'模型白名单解锁',description:'把已应用供应商的真实模型目录接入原生模型菜单与请求层' },
  { id:'native-fast-unlock',name:'原生 Fast 入口',description:'为使用本地 API 的兼容版本启用原生 Fast 入口',setting:'codexAppNativeFastUnlock',requiresRestart:true },
  { id:'native-predictions',name:'原生输入预测',description:'为使用本地 API 的兼容版本启用原生输入预测',setting:'codexAppNativePredictions',requiresRestart:true },
  { id:'reported-usage-compaction',name:'按上报用量判断压缩',description:'以实际 token 用量触发原生上下文压缩',unsupported:'需要原生 app-server 压缩控制；不能仅修改界面开关。' },
  { id:'reasoning-collapse',name:'回答后折叠思考',description:'通过云汇网关补齐 Responses 消息阶段，工具过程作为 commentary，最终回答标为 final_answer；保留已有阶段' },
  { id:'disable-work-view',name:'禁用 Work 视图',description:'将纯 API 模式切换为命令详情视图，停用时恢复原设置；重启客户端生效',requiresRestart:true },
  { id:'force-chinese-locale',name:'中文界面',description:'为兼容客户端强制使用中文界面',requiresRestart:true },
  { id:'native-browser-identification',name:'浏览器请求标识兼容',description:'兼容 Edge / Chrome 原生请求',unsupported:'需要原生网络层请求标识适配。' },
  { id:'standalone-quota-unlock',name:'官方额度入口兼容',description:'兼容第三方 API 的原生额度门控，不增加服务端额度',unsupported:'需要原生额度 gate 与网络层适配；不会改变官方账户额度。' },
];
export const BUNDLED = ['agent-pet','typing-effects','image-overlay','usage-statusline','proxy-request-status'];
export function loadState(store: AuroraStore): ExtensionState {
  const saved = store.readExtra<Partial<ExtensionState>>('extensions.json', {});
  return { connection: { port: 9222, ...saved.connection }, entries: saved.entries || {}, settings: saved.settings || {} };
}
export function saveState(store: AuroraStore, state: ExtensionState): void { store.writeExtra('extensions.json', state); }
export function manifest(id: string): any { if (!BUNDLED.includes(id)) throw new Error('未知内置扩展包'); return JSON.parse(fs.readFileSync(path.join(resourceRoot(),'materialized','extensions',id,'codexpp.json'),'utf8')); }
export function effectiveEntry(state: ExtensionState,id:string): {installed:boolean;enabled:boolean;config:Record<string,any>} {
  const saved=state.entries[id]; const defaults:Record<string,any>={};
  const schema=id.startsWith('bundled:')?manifest(id.slice(8)).config:BUILTINS.find(b=>`builtin:${b.id}`===id)?.configSchema;
  for(const [k,v]of Object.entries(schema||{})) defaults[k]=(v as any).default;
  return {installed:saved?.installed??true,enabled:saved?.enabled??['builtin:plugin-market-unlock','builtin:paste-fix','bundled:usage-statusline'].includes(id),config:{...defaults,...saved?.config}};
}
export function validateConfig(schema: Record<string,any>, input:any):Record<string,any>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('扩展配置必须是对象');const out:Record<string,any>={};
  for(const [key,value]of Object.entries(input)){const f=schema[key];if(!f||['__proto__','constructor','prototype'].includes(key))throw new Error(`未知配置项：${key}`);
    if(!['boolean','number','string','file','select'].includes(f.type))throw new Error(`不支持此配置类型：${key}`);
    if(f.type==='boolean'&&typeof value!=='boolean')throw new Error(`${key} 必须是开关值`);
    if(f.type==='number'&&(typeof value!=='number'||!Number.isFinite(value)||(f.min!=null&&value<f.min)||(f.max!=null&&value>f.max)))throw new Error(`${key} 数值超出范围`);
    if(['string','file','select'].includes(f.type)&&(typeof value!=='string'||value.length>4000))throw new Error(`${key} 文本无效`);
    if(f.type==='select'&&!f.options?.some((o:any)=>(typeof o==='string'?o:o.value)===value))throw new Error(`${key} 不是可选值`);out[key]=value;
  }return out;
}
export function validatePackageConfig(id:string,input:any):Record<string,any>{
  const result=validateConfig(manifest(id).config||{},input);
  if(id==='agent-pet'){
    if((result.soundSet!==undefined&&!['duck','fx1'].includes(result.soundSet))||result.customSoundPress||result.customSoundRelease)throw new Error('自定义或下载音效尚未接入；请使用内置 duck / fx1 音效');
    if(result.image!==undefined&&!['whale','custom'].includes(result.image))throw new Error('此桌宠图库尚未接入；请选择 whale 或 custom');
    if(result.codexAppWhaleBalanceProtocol==='custom'||result.codexAppWhaleBalancePath||result.codexAppWhaleBalanceField)throw new Error('自定义余额接口尚未接入；实时用量请查看用量状态栏');
  }
  return result;
}
