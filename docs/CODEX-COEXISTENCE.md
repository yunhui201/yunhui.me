# 官方账号与第三方推理供应商共存

云汇 AI 实现适用于具有 Codex 编程模块的 ChatGPT / Codex 桌面版及共享配置的 Codex CLI，不会把普通 ChatGPT 聊天、官方登录、云端项目、订阅额度接口整体替换为第三方服务。

`openai_base_url` 是内置 OpenAI 推理传输覆盖，不是 OAuth 登录 API 地址。云汇 AI 不改 `chatgpt_base_url`、OAuth 浏览器登录回调、Cookie、官方订阅和额度身份，也不把第三方模型宣称为官方授权模型。不同客户端版本可能还有自己的原生模型限制，需实际客户端验证。

## 当前实现

实现位置为 `src/core/gateway/coexist.ts`、`server.ts` 和 `src/core/extensions/models.ts`。配置与界面由客户端接入层控制。

配置示例：

```toml
model_provider = "openai"
model = "official/<本机官方模型slug>"
openai_base_url = "http://127.0.0.1:3425/codex-coexist/v1"
model_catalog_json = "<云汇数据目录>/codex-model-catalog.json"
```

模型目录以 `official/<slug>` 标识官方，`<providerId>/<model>` 标识第三方。同名模型也保持两个入口。旧会话裸模型名只有确实属于已读官方目录时才识别为官方，未知模型报错；官方失败不转第三方、第三方失败也不偷偷消耗官方账号。

官方身份安全状态只返回是否可用、过期时间和提示，不返回 OAuth、账号 ID、邮件或刷新凭据。每次请求校验：已显式应用共存模式、当前 root/active profile 仍是 openai 与本工具端点、请求来自本机回环、Host/端口匹配、没有 Origin/浏览器来源头、Bearer 恒时匹配当前 auth.json 的 access_token。该 OAuth 不可访问通用 `/api/rpc` 或 LAN；读取请求体后再次核对凭据代次，原生客户端刚换账号/刷新时请重试。

官方 Responses 与 `/responses/compact` 只能发固定 HTTPS 官方地址；传输不跟随重定向，401 直接提示官方客户端续登，不读取使用 refresh_token，不向外部 API 失败转移。第三方路径在进入 Router 之前重建安全请求头，删除入站 OAuth、Cookie、账号头、actor authorization 和任意鉴权字段，再使用该供应商自己的 API Key。第三方 compact 暂明确返回 501，不伪造压缩结果。

共存接口有 32 MiB 请求与解压输出上限，支持 identity、zstd、gzip。HTTP Upgrade 明确返回 426 而不是静默断开；目录标记 `prefer_websockets=false`。官方和第三方请求均支持首包前取消，及时终止上游。流式原始事件保持原样，真实上报 usage 更新实时状态；未上报的缓存用量保持未知。

官方模型资料取自 `models_cache.json` 的真实原生条目，补齐必要的 `base_instructions`。本工具不会改这个文件。已写回的 `official/` 前缀只去掉一次；供应商前缀不会成为官方模型。非内置 openai 模式下生成的裸模型缓存不采集为官方目录。

已识别的官方目录保存到云汇自己的 `codex-official-models.json`：只保存模型资料和账号作用域哈希，不存 token/账号 ID。原生缓存丢失或只剩第三方条目时，同一账号可从此快照恢复，返回 `officialModelSource="saved-cache"` 及说明。换账号不借用旧快照；本地目录不证明账号拥有某项远端权限。首次既无真实官方缓存又无同账号快照时，应先在官方客户端正常登录并加载模型列表，不能用静态营销列表充当授权目录。

首次接入与 root/active profile 冲突由配置预览处理。存在会覆盖内置 openai 路由/鉴权的自定义 provider 表时应明确阻断，不猜测私有配置优先级。退出共存只清工具拥有的端点/模型目录，保留用户其他配置。账号身份和推理供应商的切换无需新增 CDP 私有 native bridge；模型列表扩展复用已有 `/codex-model-catalog`。

## 导出接口

- `readOfficialCodexIdentity()` / `officialCodexStatus()`：脱敏身份状态，不写客户端文件。
- `codexCoexistBaseUrl(port)`：专用回环端点；`CODEX_COEXIST_BASE_PATH` 是 `/codex-coexist/v1`。
- `getCoexistCatalog(store)`：`identity`、公开 `models`、原生 `nativeCatalog`、`officialModelCount`、`officialModelSource`、`warnings`。界面只用公开字段，原生目录存本机。
- `isCodexCoexistConfigured(store)`：验证当前实际配置与已保存的共存 Agent 状态。
- `authorizeCodexCoexistRequest(req, store)`：只为专用路径产生不含 token 的 opaque 授权对象。
- `readCodexCoexistBody(req)`：有界解压与严格 UTF-8 JSON 解析。
- `prepareCodexCoexistRequest(authorization, store, pathname, body, incomingHeaders)`：固定官方请求计划或清理后的第三方 Router 计划；只在后端使用，不能序列化到 IPC/日志。

## 验证边界

`node scripts/test-coexist.mjs` 的 19 组检查用隔离 auth/config/cache、真实回环 HTTP 服务器和官方传输 fixture 验证两条路由。包括模型重名、缓存回写恢复、浏览器/LAN/RPC 拒绝、头隔离、zstd、Upgrade 426、官方/第三方 compact、401/重定向、token 轮换、配置漂移、流式真实 usage、首包前取消、失效身份和日志脱敏。未调用真实模型，不消耗 API 额度，不修改真实用户配置。

Electron 38 的内嵌 Node 22.22.0 已实测提供 `zstdDecompress`。现有网关 48 项与桌面扩展真实 CDP 20 项回归通过。**尚未在实际官方 ChatGPT/Codex 发行版完成账号共存的端到端验证**，受控 mock 验收不能代替私有客户端版本的运行验收；官方登录、目录权限、原生窗口和远端会话表现仍应由用户本地验证。
