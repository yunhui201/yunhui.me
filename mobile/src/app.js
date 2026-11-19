import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { createRpcClient, normalizeEndpoint } from './connection.js';
import { summaryCache, requestCache, requestOutput } from './usage.js';
import { providerBalanceView } from './providerBalance.js';
import packageInfo from '../package.json';

const app = document.getElementById('app');
const overlay = document.getElementById('overlay');
const storage = { get: key => { try { return localStorage.getItem(key); } catch { return null; } }, set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional preference */ } } };
let endpoint = storage.get('yunhui.gateway') || storage.get('aurora.gateway') || '';
let rpc = null;
let state = null;
let summary = null;
let recent = [];
let live = [];
let liveHost = null;
let liveTimer;
let liveFlight = false;
let liveRetryAt = 0;
let liveError = '';
let liveUpdatedAt = '';
let sessions = null;
let page = 'home';
let epoch = 0;
let refreshSequence = 0;
let sessionSequence = 0;
let updatedAt = '';
let toastTimer;
const paths = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  clients: 'M4 4h16v12H4z M8 21h8 M12 16v5',
  providers: 'M4 6c0-4 16-4 16 0s-16 4-16 0v12c0 4 16 4 16 0V6 M4 12c0 4 16 4 16 0',
  sessions: 'M4 4h16v13H9l-5 4Z M8 8h8 M8 12h5',
  settings: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-2a8 8 0 0 1 16 0v2',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 14 6 M4 12a8 8 0 0 0 14 6',
  arrow: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12 M6 18 18 6',
  shield: 'M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7Z m-5 9 3 3 7-7',
  chart: 'M4 3v18h17 M8 16v-5 M13 16V7 M18 16v-8',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || paths.clients);
  svg.append(path);
  return svg;
}
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}
function button(text, onClick, className = 'button') {
  const n = el('button', className, text);
  n.type = 'button';
  n.addEventListener('click', onClick);
  return n;
}
function iconButton(name, label, onClick) {
  const n = button('', onClick, 'icon-button');
  n.setAttribute('aria-label', label);
  n.append(icon(name));
  return n;
}
function badge(text, good = false) { return el('span', good ? 'badge good' : 'badge', text); }
function note(text, error = false) { return el('p', error ? 'notice error' : 'notice', text); }
function empty(title, text) {
  const n = el('div', 'empty');
  n.append(icon('sessions'), el('h3', '', title), el('p', 'muted', text));
  return n;
}
function label(text, input) {
  const n = el('label', 'field');
  input.setAttribute('aria-label', text);
  n.append(el('span', '', text), input);
  return n;
}
function heading(title, text) {
  const n = el('div', 'page-heading');
  n.append(el('h1', '', title));
  if (text) n.append(el('p', 'muted', text));
  return n;
}
const number = n => n == null ? '—' : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const money = n => n == null ? '—' : `$${Number(n).toFixed(n > 0 && n < .01 ? 4 : 2)}`;
const date = v => { const d = new Date(v); return Number.isNaN(d.valueOf()) ? '—' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
function toast(message) {
  const n = document.getElementById('toast');
  n.textContent = message;
  n.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.classList.remove('visible'), 4500);
}
async function busy(n, task) {
  n.disabled = true;
  n.setAttribute('aria-busy', 'true');
  try { await task(); } catch (e) { toast(e.message || '操作未完成，请重试'); }
  finally { n.disabled = false; n.removeAttribute('aria-busy'); }
}
async function transport(options) {
  if (Capacitor.isNativePlatform()) return CapacitorHttp.request({ ...options, connectTimeout: 12000, readTimeout: 45000, responseType: 'json', disableRedirects: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const r = await fetch(options.url, { method: options.method, headers: options.headers, body: JSON.stringify(options.data), signal: controller.signal, credentials: 'omit', redirect: 'error' });
    return { status: r.status, data: await r.text() };
  } finally { clearTimeout(timer); }
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  storage.set('yunhui.mobile.theme', theme);
}
setTheme(storage.get('yunhui.mobile.theme') || 'system');

function renderConnect() {
  app.replaceChildren();
  overlay.replaceChildren();
  const wrap = el('div', 'connect-screen');
  const brand = el('div', 'brand');
  brand.append(el('div', 'brand-mark', '云'), el('span', '', 'yunhui.me'), badge('手机伴侣'));
  const hero = el('div', 'connect-hero');
  hero.append(el('span', 'eyebrow', 'YOUR AI, CONNECTED'), el('h1', '', 'AI 工作台，\n随手可达。'), el('p', 'muted', '连接电脑，随时查看模型、用量与会话。'));
  const form = el('form', 'card connect-form');
  const url = el('input');
  url.type = 'url'; url.inputMode = 'url'; url.autocapitalize = 'off'; url.spellcheck = false; url.autocomplete = 'url'; url.placeholder = '输入电脑端显示的网关地址'; url.value = endpoint;
  const token = el('input');
  token.type = 'password'; token.autocomplete = 'off'; token.placeholder = '输入网关访问令牌'; token.autocapitalize = 'off'; token.spellcheck = false;
  const error = el('p', 'form-error'); error.setAttribute('role', 'alert');
  const go = button('连接工作台', () => {}); go.type = 'submit';
  form.noValidate = true;
  form.append(el('h2', '', '连接你的电脑'), label('网关地址', url), label('访问令牌', token), error, go);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (go.disabled) return;
    go.disabled = true; error.textContent = ''; go.textContent = '正在连接…';
    try {
      const base = normalizeEndpoint(url.value);
      const nextRpc = createRpcClient(base, token.value, transport);
      const nextState = await nextRpc('state.get');
      if (!nextState || !Array.isArray(nextState.providers) || !Array.isArray(nextState.agentCatalog)) throw new Error('网关版本不兼容，请先更新桌面端');
      epoch++; endpoint = base; rpc = nextRpc; state = nextState; summary = null; recent = []; sessions = null; page = 'home';
      token.value = ''; storage.set('yunhui.gateway', base); updatedAt = new Date().toISOString();
      live = []; liveError = ''; liveUpdatedAt = ''; liveRetryAt = 0;
      render(); startLive(); await refresh(false).catch(e => toast(e.message || '已连接，暂时无法刷新用量'));
    } catch (e) {
      error.textContent = /fetch|network|timed|abort/i.test(e.message) ? '暂时连不上。请确认电脑在线、已开启局域网共享，并检查地址、端口和防火墙。' : e.message;
    } finally { go.disabled = false; go.textContent = '连接工作台'; }
  });
  const help = el('div', 'connect-help');
  help.append(icon('shield'), el('p', '', '在电脑「设置 → 网关」开启局域网共享并设置访问令牌。令牌只保留在当前会话，断开后清除。'));
  wrap.append(brand, hero, form, help, el('p', 'connect-footer', '电脑与手机处于同一网络，或使用可访问的 HTTPS 网关。'));
  app.append(wrap);
}

async function refresh(showMessage = true) {
  if (!rpc) return;
  const currentEpoch = epoch;
  const sequence = ++refreshSequence;
  const results = await Promise.allSettled([rpc('state.get'), rpc('usage.summary', { days: 7 }), rpc('usage.recent')]);
  if (currentEpoch !== epoch || sequence !== refreshSequence) return;
  if (results[0].status === 'rejected') throw results[0].reason;
  state = results[0].value;
  if (results[1].status === 'fulfilled') summary = results[1].value;
  if (results[2].status === 'fulfilled') recent = results[2].value;
  updatedAt = new Date().toISOString();
  render();
  const failed = results.slice(1).filter(x => x.status === 'rejected');
  if (failed.length) toast('已连接，部分用量数据暂时无法读取');
  else if (showMessage) toast('已更新');
}

function stopLive() { clearInterval(liveTimer); liveTimer = undefined; }
function startLive() {
  stopLive();
  liveTimer = setInterval(() => { void pollLive(); }, 1500);
  void pollLive();
}
async function pollLive() {
  if (!rpc || page !== 'home' || document.hidden || liveFlight || Date.now() < liveRetryAt) return;
  const currentEpoch = epoch;
  const call = rpc;
  liveFlight = true;
  try {
    const next = await call('usage.live');
    if (currentEpoch !== epoch) return;
    if (!Array.isArray(next)) throw new Error('实时请求数据格式不兼容');
    const completed = live.some(previous => !next.some(request => request.id === previous.id));
    live = next; liveError = ''; liveUpdatedAt = new Date().toISOString();
    renderLive();
    if (completed) {
      const results = await Promise.allSettled([call('usage.summary', { days: 7 }), call('usage.recent')]);
      if (currentEpoch !== epoch) return;
      if (results[0].status === 'fulfilled') summary = results[0].value;
      if (results[1].status === 'fulfilled') recent = results[1].value;
      if (page === 'home') render();
    }
  } catch (error) {
    if (currentEpoch !== epoch) return;
    liveError = `实时数据暂不可用：${error.message || '请检查网关版本与连接'}`;
    liveRetryAt = Date.now() + 15000;
    renderLive();
  } finally { liveFlight = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollLive(); });

function render() {
  if (!rpc || !state) return renderConnect();
  app.replaceChildren();
  liveHost = null;
  const header = el('header', 'app-header');
  const brand = el('div', 'brand'); brand.append(el('div', 'brand-mark small', '云'), el('strong', '', 'yunhui.me'));
  const refreshButton = iconButton('refresh', '刷新数据', () => busy(refreshButton, () => refresh()));
  header.append(brand, badge(state.gateway?.running ? '网关在线' : '网关已停止', state.gateway?.running), refreshButton);
  const content = el('section', 'page');
  if (page === 'home') renderHome(content);
  if (page === 'clients') renderClients(content);
  if (page === 'providers') renderProviders(content);
  if (page === 'sessions') renderSessions(content);
  if (page === 'settings') renderSettings(content);
  const nav = el('nav', 'bottom-nav'); nav.setAttribute('aria-label', '主导航');
  for (const [id, title] of [['home', '工作台'], ['clients', '客户端'], ['providers', '供应商'], ['sessions', '会话'], ['settings', '我的']]) {
    const n = button('', () => { page = id; render(); window.scrollTo({ top: 0 }); if (id === 'sessions' && sessions === null) loadSessions(); if (id === 'home') void pollLive(); }, page === id ? 'nav-item active' : 'nav-item');
    if (page === id) n.setAttribute('aria-current', 'page');
    n.append(icon(id), el('span', '', title)); nav.append(n);
  }
  app.append(header, content, nav);
}

function renderHome(content) {
  content.append(heading('一切，尽在掌握', '你的 AI 工作台已连接。'));
  const hero = el('div', 'workspace-card');
  const left = el('div');
  left.append(el('span', 'eyebrow', 'CONNECTED WORKSPACE'), el('h2', '', '我的云汇工作台'), el('p', 'server-address', endpoint));
  hero.append(left, icon('clients'));
  const meta = el('div', 'workspace-meta');
  meta.append(el('span', '', `${Object.values(state.agents || {}).filter(a => a.connected).length} 个客户端已连接`), el('span', '', `${state.providers.filter(p => p.enabled).length} 家供应商已启用`));
  hero.append(meta); content.append(hero);
  const statTitle = el('div', 'section-title'); statTitle.append(el('h2', '', '近 7 天用量'), el('span', 'muted', '网关记录'));
  content.append(statTitle);
  const stats = el('div', 'stats-grid');
  const t = summary?.totals;
  for (const [name, value, sub] of [['请求次数', number(t?.calls), '经过网关的请求'], ['Token 用量', number(t ? t.inputTokens + t.outputTokens : null), '输入与输出合计'], ['已知价格估算', money(t?.cost), t?.unpricedCalls ? `${t.unpricedCalls} 次请求未计价` : '按已设置模型价格'], ['失败请求', number(t?.errors), '查看下方请求原因']]) {
    const s = el('div', 'card stat'); s.append(el('span', 'muted', name), el('strong', '', value), el('small', 'muted', sub)); stats.append(s);
  }
  content.append(stats);
  const cache = summaryCache(t);
  const cacheTitle = el('div', 'section-title'); cacheTitle.append(el('h2', '', '缓存表现'), el('span', 'muted', '近 7 天'));
  const cacheStats = el('div', 'stats-grid cache-stats'); cacheStats.setAttribute('aria-label', '缓存用量');
  for (const [name, value, sub] of [['缓存读取', number(cache.read), '命中已有上下文的 Token'], ['缓存写入', number(cache.write), '新建缓存的 Token'], ['缓存命中率', cache.rate == null ? '—' : `${(cache.rate * 100).toFixed(1)}%`, '仅统计上游提供缓存数据的请求']]) {
    const stat = el('div', 'card stat'); stat.append(el('span', 'muted', name), el('strong', '', value), el('small', 'muted', sub)); cacheStats.append(stat);
  }
  content.append(cacheTitle, cacheStats, el('p', 'usage-explainer muted', '输入总量包含缓存。未返回的缓存字段显示「—」，不会按零命中计算。费用是本地估算，以供应商账单为准。'));
  liveHost = el('div', 'live-section'); liveHost.setAttribute('aria-label', '实时请求'); content.append(liveHost); renderLive();
  const title = el('div', 'section-title'); title.append(el('h2', '', '最近请求'), el('span', 'muted', '最近 8 条')); content.append(title);
  if (!recent.length) content.append(empty('还没有请求记录', '客户端开始调用模型后，这里会显示结果与用量。'));
  else {
    const list = el('div', 'card list');
    for (const r of recent.slice(0, 8)) {
      const row = el('div', 'request-row'); const info = el('div', 'grow');
      info.append(el('strong', 'truncate', r.model || '未知模型'), el('p', 'muted small-text', `${r.agent || '客户端'} · ${r.providerName || '供应商'} · ${date(r.ts)}`));
      info.append(el('p', 'request-usage muted', `输入 ${number(r.inputTokens)} · 输出 ${number(r.outputTokens)}${r.estimated ? '（估算）' : ''}`), el('p', 'request-usage muted', `缓存读 ${number(requestCache(r, 'cacheRead'))} · 缓存写 ${number(requestCache(r, 'cacheWrite'))}`));
      info.append(el('p', 'request-usage muted', r.costKnown === false ? '价格未配置' : `估算费用 ${money(r.cost)}`));
      if (r.error) info.append(el('p', 'error-text', r.error));
      row.append(info, badge(r.status >= 200 && r.status < 300 ? '成功' : `失败 ${r.status || ''}`, r.status >= 200 && r.status < 300)); list.append(row);
    }
    content.append(list);
  }
}

function renderLive() {
  if (!liveHost || !liveHost.isConnected && page !== 'home') return;
  liveHost.replaceChildren();
  const title = el('div', 'section-title'); title.append(el('h2', '', '实时请求'), el('span', 'muted', liveError ? '连接中断' : `${live.length} 个进行中 · 1.5 秒刷新`)); liveHost.append(title);
  if (liveError) liveHost.append(note(`${liveError}${liveUpdatedAt ? `；保留 ${date(liveUpdatedAt)} 的最后状态。` : ''}`, true));
  if (!live.length) { liveHost.append(el('p', 'live-empty muted', liveError ? '恢复连接后自动更新。' : '等待下一次对话。请求完成后会计入上方统计。')); return; }
  const list = el('div', 'card live-list');
  for (const request of live) {
    const row = el('article', 'live-request'), top = el('div', 'live-heading');
    const phase = { connecting: '连接中', streaming: '生成中', retrying: '正在重试' }[request.phase] || '进行中';
    top.append(el('strong', 'truncate', request.model || '等待模型'), badge(liveError ? '待更新' : phase, !liveError));
    row.append(top, el('p', 'muted small-text', `${request.agent || '客户端'} · ${request.providerName || '等待路由'} · ${Math.max(0, Math.floor((Date.now() - request.startedAtMs) / 1000)) || 0} 秒`));
    const values = el('div', 'live-metrics'), output = requestOutput(request);
    const outputLabel = output.tokens == null ? '待返回' : `${output.estimated ? '约 ' : ''}${number(output.tokens)}`;
    for (const [name, value] of [['输入', request.inputTokens == null ? '待返回' : number(request.inputTokens)], ['输出', outputLabel], ['缓存读', requestCache(request, 'cacheRead', true) == null ? '未提供' : number(request.cacheRead)], ['缓存写', requestCache(request, 'cacheWrite', true) == null ? '未提供' : number(request.cacheWrite)]]) values.append(el('span', '', `${name} ${value}`));
    row.append(values);
    if (request.autoRetries) row.append(el('p', 'muted small-text', `自动重试 ${request.autoRetries} 次`));
    list.append(row);
  }
  liveHost.append(list, el('p', 'usage-explainer muted', '「约」表示生成中的输出估算，完成后以上游返回数据为准。'));
}

function renderClients(content) {
  content.append(heading('我的客户端', '先选客户端，再为它选择供应商与模型。'));
  const list = el('div', 'stack');
  for (const a of state.agentCatalog) {
    const binding = state.agents?.[a.id];
    const p = state.providers.find(p => p.id === binding?.providerId);
    const row = button('', () => openClient(a), 'card client-card');
    const logo = el('span', 'client-logo', a.name.slice(0, 1));
    const text = el('div', 'grow');
    text.append(el('strong', '', a.name), el('p', 'muted truncate', binding?.connected ? `${p?.name || '供应商'} · ${binding.model || '未选择模型'}` : a.supportNote || a.description));
    const status = binding?.connected ? '已接入' : a.support === 'unsupported' ? '官方服务' : a.support === 'manual' ? '手动配置' : '待配置';
    row.append(logo, text, badge(status, binding?.connected), icon('arrow')); list.append(row);
  }
  content.append(list, note('这里管理的是电脑上的客户端。需要重启的客户端，请在电脑端重启后使用。'));
}

function sheet(title) {
  overlay.replaceChildren();
  const dialog = el('dialog', 'sheet');
  const head = el('div', 'sheet-header');
  let locked = false;
  const close = iconButton('close', '关闭', () => { if (!locked) dialog.close(); });
  head.append(el('h2', '', title), close);
  const body = el('div', 'sheet-body');
  dialog.append(head, body); overlay.append(dialog); dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('cancel', event => { if (locked) event.preventDefault(); });
  return { dialog, body, lock: value => { locked = value; close.disabled = value; } };
}

function openClient(agent) {
  const { dialog, body, lock } = sheet(agent.name);
  const clientEpoch = epoch, clientRpc = rpc;
  let selectionVersion = 0;
  body.append(note(agent.supportNote || agent.description || '配置电脑上的客户端。'));
  if (agent.support === 'unsupported' || agent.support === 'manual') {
    body.append(note(agent.support === 'unsupported' ? '此客户端暂不支持通过云汇自动更换模型服务。请在电脑端查看官方接入方式。' : '此客户端需要在应用内手动完成设置，请在电脑端复制参数并按接入说明操作。'));
    return;
  }
  const providers = state.providers.filter(p => p.enabled && p.models?.length);
  if (!providers.length) { body.append(empty('还没有可用供应商', '先在电脑端添加供应商和模型，再回来选择。')); return; }
  const binding = state.agents?.[agent.id];
  const authMode = ['codex-cli', 'chatgpt-desktop'].includes(agent.id) && binding?.authMode === 'coexist' ? 'coexist' : 'api';
  if (authMode === 'coexist') body.append(note('保留电脑端已启用的官方账号共存模式。官方模型选择与账号设置请在电脑端管理。'));
  const provider = el('select'); const model = el('select');
  providers.forEach(p => { const opt = el('option', '', p.name); opt.value = p.id; provider.append(opt); });
  provider.value = providers.some(p => p.id === binding?.providerId) ? binding.providerId : providers[0].id;
  const previewBox = el('div', 'preview');
  const updateModels = () => {
    selectionVersion++;
    model.replaceChildren();
    (providers.find(p => p.id === provider.value)?.models || []).forEach(m => { const opt = el('option', '', m.displayName ? `${m.displayName} · ${m.id}` : m.id); opt.value = m.id; model.append(opt); });
    if (Array.from(model.options).some(o => o.value === binding?.model)) model.value = binding.model;
    previewBox.replaceChildren();
  };
  provider.addEventListener('change', updateModels); model.addEventListener('change', () => { selectionVersion++; previewBox.replaceChildren(); }); updateModels();
  body.append(label('供应商', provider), label('模型', model));
  const preview = button('预览电脑上的配置变更', () => busy(preview, async () => {
    const payload = { agentId: agent.id, providerId: provider.value, model: model.value, mode: 'gateway', authMode };
    const version = selectionVersion;
    previewBox.replaceChildren();
    const result = await clientRpc('agent.preview', payload);
    if (!dialog.open || clientEpoch !== epoch || version !== selectionVersion) return;
    previewBox.replaceChildren();
    if (result.manual) { previewBox.append(note('该客户端需要手动设置，请在电脑端查看配置参数。')); return; }
    previewBox.append(note(result.message || '确认后将备份并修改电脑上的客户端配置。'));
    for (const warning of result.warnings || []) previewBox.append(note(warning));
    for (const file of result.files || []) {
      const detail = el('details', 'file-preview'); detail.append(el('summary', '', file.path));
      detail.append(el('p', 'muted small-text', '应用后的配置（密钥已隐藏）'), el('pre', '', file.after || '')); previewBox.append(detail);
    }
    if (!(result.files || []).length) { previewBox.append(note('没有可应用的文件变更。')); return; }
    const confirm = button('确认应用到电脑', () => busy(confirm, async () => {
      if (!dialog.open || clientEpoch !== epoch || version !== selectionVersion) return;
      lock(true); provider.disabled = true; model.disabled = true; preview.disabled = true;
      try {
        const applied = await clientRpc('agent.connect', { ...payload, revision: result.revision });
        if (clientEpoch !== epoch) return;
        dialog.close();
        try { await refresh(false); } catch { toast('配置已应用，但工作台刷新失败，请手动刷新查看。'); return; }
        toast(applied.restartRequired ? '配置已应用，请在电脑上重启客户端' : applied.message || '配置已应用');
      } catch (error) {
        previewBox.replaceChildren(note(error.message || '应用失败，请重新预览后重试', true));
      } finally { lock(false); provider.disabled = false; model.disabled = false; preview.disabled = false; }
    }));
    previewBox.append(confirm);
  }));
  body.append(preview, previewBox);
}

function renderProviders(content) {
  content.append(heading('供应商与模型', '查看余额、密钥额度与可用模型，查询配置在电脑端管理。'));
  if (!state.providers.length) { content.append(empty('还没有供应商', '在电脑端从云端目录导入，或手动添加 API 供应商。')); return; }
  const search = el('input', 'search'); search.type = 'search'; search.placeholder = '搜索供应商或模型'; search.setAttribute('aria-label', '搜索供应商或模型');
  const list = el('div', 'stack');
  const show = () => {
    list.replaceChildren();
    const q = search.value.toLowerCase();
    const filtered = state.providers.filter(p => `${p.name} ${(p.models || []).map(m => m.id).join(' ')}`.toLowerCase().includes(q));
    if (!filtered.length) list.append(empty('没有匹配结果', '换个名称或模型 ID 试试。'));
    for (const p of filtered) {
      const card = el('div', 'card provider-card'); const head = el('div', 'provider-heading');
      const info = el('div', 'grow'); info.append(el('h3', '', p.name), el('p', 'muted small-text', `${p.models?.length || 0} 个模型 · ${p.format}`));
      const toggle = button(p.enabled ? '已启用' : '已停用', () => busy(toggle, async () => {
        await rpc('provider.toggle', { id: p.id, enabled: !p.enabled }); await refresh(false); toast(p.enabled ? '供应商已停用' : '供应商已启用');
      }), p.enabled ? 'toggle enabled' : 'toggle');
      toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(p.enabled)); toggle.setAttribute('aria-label', `${p.name} 启用状态`);
      head.append(info, toggle); card.append(head);
      const balanceEpoch = epoch, balanceRpc = rpc, balanceConfiguration = JSON.stringify(p);
      card.append(providerBalanceView(p, balanceRpc, () => balanceEpoch === epoch && rpc === balanceRpc
        && page === 'providers' && state?.providers.some(current => current.id === p.id && JSON.stringify(current) === balanceConfiguration)));
      const detail = el('details', 'models-detail'); detail.append(el('summary', '', '查看模型'));
      if (!p.models?.length) detail.append(el('p', 'muted', '请在电脑端同步模型列表。'));
      for (const m of p.models || []) {
        const row = el('div', 'model-row'); row.append(el('strong', '', m.displayName || m.id), el('code', 'muted', m.id));
        const caps = [m.contextWindow ? `${number(m.contextWindow)} 上下文` : '', m.capabilities?.tools ? '工具' : '', m.capabilities?.vision ? '视觉' : '', m.capabilities?.thinking ? '推理' : ''].filter(Boolean);
        if (caps.length) row.append(el('small', 'muted', caps.join(' · '))); detail.append(row);
      }
      card.append(detail); list.append(card);
    }
  };
  search.addEventListener('input', show); show(); content.append(search, list);
}

async function loadSessions() {
  const captured = epoch;
  const sequence = ++sessionSequence;
  try { const data = await rpc('sessions.scan'); if (captured !== epoch || sequence !== sessionSequence) return; sessions = Array.isArray(data) ? data : []; if (page === 'sessions') render(); }
  catch (e) { if (captured === epoch && sequence === sessionSequence) { toast(e.message); sessions = []; if (page === 'sessions') render(); } }
}
function renderSessions(content) {
  content.append(heading('历史会话', '读取电脑上的本地会话，继续了解工作进展。'));
  const refreshSessions = button('重新扫描', () => busy(refreshSessions, async () => { sessions = null; render(); await loadSessions(); }), 'button secondary compact');
  content.append(refreshSessions);
  if (sessions === null) { content.append(note('正在读取会话…')); return; }
  if (!sessions.length) { content.append(empty('暂未发现会话', '在电脑端使用 Claude Code 或 Codex 后重新扫描。')); return; }
  const search = el('input', 'search'); search.type = 'search'; search.placeholder = '搜索标题、客户端或项目'; search.setAttribute('aria-label', '搜索会话');
  const list = el('div', 'card list');
  const show = () => {
    list.replaceChildren(); const q = search.value.toLowerCase();
    const matches = sessions.filter(s => `${s.title} ${s.agent} ${s.project || ''} ${s.cwd || ''}`.toLowerCase().includes(q));
    if (!matches.length) list.append(empty('没有匹配的会话', '换个标题、客户端或项目名称。'));
    for (const s of matches.slice(0, 200)) {
      const row = button('', () => readSession(s), 'session-row');
      const text = el('div', 'grow'); text.append(el('strong', 'truncate', s.title || '未命名会话'), el('p', 'muted small-text', `${s.agent} · ${date(s.updatedAt)}`));
      if (s.project) text.append(el('p', 'muted small-text truncate', s.project));
      row.append(icon('sessions'), text, icon('arrow')); list.append(row);
    }
    if (matches.length > 200) list.append(note(`找到 ${matches.length} 条，当前显示前 200 条；可搜索缩小范围。`));
  };
  search.addEventListener('input', show); show(); content.append(search, list);
}
async function readSession(session) {
  const { dialog, body } = sheet(session.title || '历史会话');
  body.append(note('正在读取会话内容…'));
  try {
    const messages = await rpc('sessions.read', { path: session.path });
    if (!dialog.open) return;
    body.replaceChildren();
    body.append(el('p', 'muted small-text', `${session.agent} · ${date(session.updatedAt)}`));
    if (!messages.length) body.append(empty('暂无可读取内容', '该文件可能为空，或当前解析器不支持此会话格式。'));
    for (const message of messages) {
      const block = el('article', `message ${message.role === 'user' ? 'user' : ''}`);
      block.append(el('span', 'message-role', { user: '你', assistant: 'AI 助手', tool: '工具', system: '系统' }[message.role] || message.role), el('div', 'message-content', message.text)); body.append(block);
    }
    body.append(note('会话按读取上限展示；完整内容与恢复操作请在电脑端查看。'));
  } catch (e) { body.replaceChildren(note(e.message, true)); }
}

function renderSettings(content) {
  content.append(heading('我的工作台', '连接、外观与扩展状态。'));
  const connection = el('div', 'card settings-card');
  connection.append(el('h2', '', '当前连接'), el('p', 'server-address', endpoint), el('p', 'muted small-text', `桌面端 ${state.version || '—'} · 最近更新 ${date(updatedAt)}`));
  content.append(connection);
  const themeCard = el('div', 'card settings-card');
  themeCard.append(el('h2', '', '外观')); const theme = el('select');
  [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].forEach(([v, text]) => { const option = el('option', '', text); option.value = v; theme.append(option); });
  theme.value = storage.get('yunhui.mobile.theme') || 'system'; theme.addEventListener('change', () => setTheme(theme.value)); themeCard.append(label('主题', theme)); content.append(themeCard);
  const plugins = el('div', 'card settings-card');
  plugins.append(el('h2', '', '已安装的网关插件'));
  if (!state.plugins?.length) plugins.append(el('p', 'muted', '尚未安装插件，可在电脑端添加和管理。'));
  for (const p of state.plugins || []) {
    const row = el('div', 'plugin-row'); row.append(el('span', '', p.name), badge(p.enabled ? '已启用' : '已停用', p.enabled)); plugins.append(row);
  }
  plugins.append(el('p', 'muted small-text', '插件安装和脚本编辑在电脑端完成。')); content.append(plugins);
  content.append(note('手机只连接你选择的工作台。网关需保持运行，访问令牌不会写入地址或本地存储。'));
  const website = el('a', 'website-link', 'yunhui.me'); website.href = 'https://yunhui.me'; website.target = '_blank'; website.rel = 'noopener noreferrer';
  const disconnect = button('断开连接', () => { epoch++; stopLive(); rpc = null; state = null; summary = null; recent = []; live = []; sessions = null; renderConnect(); toast('已断开连接，访问令牌已清除'); }, 'button danger');
  const source = el('a', 'website-link', '开源代码 · AGPL-3.0-only'); source.href = 'https://github.com/yunhui201/yunhui.me'; source.target = '_blank'; source.rel = 'noopener noreferrer';
  content.append(disconnect, website, source, el('p', 'footer-version', `yunhui.me · 手机伴侣 ${packageInfo.version}`));
}

renderConnect();
