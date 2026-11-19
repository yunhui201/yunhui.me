/**
 * 无界面模式：`node dist/main/gateway-cli.cjs`
 * 适合放服务器 / NAS / Docker / 开机自启；桌面 UI 只是可选的管理壳。
 * 同时把 dist/ui 当作 Web 控制台提供，手机和平板连过来就能用。
 */
import path from 'node:path';
import { AuroraStore, setDataDir } from '../core/store/index.js';
import { GatewayServer } from '../core/gateway/server.js';
import { runAction } from '../core/actions.js';
import metadata from '../../package.json';

const args = process.argv.slice(2);
const get = (k: string): string | undefined => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

if (get('--data')) setDataDir(get('--data')!);
const store = new AuroraStore(get('--data'));
const settings = store.getSettings();
const host = get('--host') ?? (process.env.AURORA_HOST || settings.gatewayHost);
const port = Number(get('--port') ?? process.env.AURORA_PORT ?? settings.gatewayPort);

const deps = {
  store,
  dataDir: store.dir,
  gatewayStatus: () => gw.getStatus(),
  gatewayUrl: () => { const state = gw.getStatus(); const host = state.host === '0.0.0.0' || state.host === '::' ? '127.0.0.1' : state.host; return `http://${host.includes(':') ? `[${host}]` : host}:${state.port}`; },
  platform: 'web',
  version: metadata.version,
};

const gw = new GatewayServer({
  store,
  uiDir: path.join(__dirname, '..', 'ui'),
  actions: async (action, payload) => {
    const r = await runAction(deps, action, payload);
    return r === null ? { error: `该操作只在桌面端可用：${action}` } : r;
  },
});

gw.start(host, port)
  .then((st) => {
    console.log('==============================================');
    console.log('  云汇AI 工具箱 网关已启动');
    console.log(`  接口: http://${st.host}:${st.port}`);
    console.log(`  控制台: http://${st.host}:${st.port}/`);
    console.log(`  数据: ${store.dir}`);
    console.log('  端点: /v1/messages  /v1/chat/completions  /v1/responses');
    console.log(`  供应商: ${store.listProviders().filter((p) => p.enabled).length} 家已启用`);
    console.log('==============================================');
  })
  .catch((e) => {
    console.error('启动失败:', e?.message ?? e);
    process.exit(1);
  });

process.on('SIGINT', async () => {
  await gw.stop();
  process.exit(0);
});

