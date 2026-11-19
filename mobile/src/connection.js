export function normalizeEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('请填写电脑或服务器的网关地址');
  const prefixed = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try { parsed = new URL(prefixed); } catch { throw new Error('地址格式不正确，请复制电脑端显示的完整 HTTP(S) 网关地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('网关地址只支持 HTTP 或 HTTPS');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('地址不能包含账号、密码、查询参数或令牌');
  if (!parsed.hostname) throw new Error('请填写有效的电脑或服务器地址');
  return parsed.href.replace(/\/+$/, '');
}

export function decodeRpc(status, data) {
  if (status === 401 || status === 403) throw new Error('连接被拒绝，请检查网关访问令牌及远程访问设置');
  if (status < 200 || status >= 300) throw new Error(`网关请求失败（HTTP ${status}）`);
  let body;
  try { body = typeof data === 'string' ? JSON.parse(data) : data; } catch { throw new Error('地址返回的不是云汇 AI 网关数据'); }
  if (!body || typeof body !== 'object') throw new Error('网关返回了无效数据');
  if (body.error) throw new Error(typeof body.error === 'string' ? body.error : body.error.message || '网关请求失败');
  if (!Object.hasOwn(body, 'result')) throw new Error('网关响应缺少结果，请检查地址和版本');
  if (body.result?.ok === false) throw new Error(body.result.message || body.result.error || '操作未完成');
  return body.result;
}

export function createRpcClient(endpoint, token, transport) {
  const base = normalizeEndpoint(endpoint);
  if (!String(token || '').trim()) throw new Error('请填写桌面端「局域网共享」中的访问令牌');
  return async (action, payload = {}) => {
    const response = await transport({
      url: `${base}/api/rpc`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.trim()}` },
      data: { action, payload },
    });
    return decodeRpc(response.status, response.data);
  };
}
