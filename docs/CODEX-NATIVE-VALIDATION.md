# 真实 Codex CLI 共存验证

验证对象是本机已安装 VS Code 插件携带的 `codex-cli 0.169.0-alpha.11.1`。独立可选脚本为 `node scripts/test-coexist-native.mjs`；不加入默认 `npm test`，没有二进制时可通过 `AURORA_NATIVE_CODEX` 指定现有可执行文件，脚本不会下载安装客户端。

实测 5 项通过：

1. 由项目 `codex-cli` adapter 实际预览并应用配置，真实 CLI 使用 `--strict-config` 接受根级 `model_provider = "openai"`、`openai_base_url` 和 `model_catalog_json`。第三方模型通过云汇 AI 网关到达本地模拟供应商，模型前缀正确还原，CLI 接收完整 Responses SSE 并输出 `RELAY_NATIVE_OK`。
2. 同一配置切换 `official/gpt-fixture` 后进入官方分支，官方请求经测试注入的传输到达本地模拟服务，CLI 输出 `OFFICIAL_NATIVE_OK`，不会转到第三方供应商。
3. 假 OAuth 仅进入官方模拟传输；第三方仅收到测试供应商 Key，不含 OAuth 或 account ID。临时 auth.json 和生成的模型目录字节保持不变。
4. 此 alpha 版本的独立 `work.config.toml` 配合 `--profile work` 能继承根级共存端点和目录，真实会话成功。
5. 独立 profile 的同名 provider 逐字段合并：根级保留 `base_url`/`wire_api`，profile 仅覆盖 `name` 和 `requires_openai_auth=false`，实际请求仍到达本地供应商且不附 OAuth。

兼容边界也已实测，不能把这些失败算成功：

- 此 alpha 版本已经完全移除旧的 `profile = "work.v2"` + `[profiles."work.v2"]` 激活方式，会明确报错要求 `--profile` 和独立文件。它还拒绝 `--profile work.v2` 中的点号，要求普通名称。原本采用旧 schema 的配置已经不被该二进制接受；这不代表云汇默认生成的根级配置失败。
- 根级 `model_catalog_json` / `openai_base_url` 真实可用。旧 profile 表嵌套这些字段会被严格配置检查拒绝。adapter 已改为只在根级写入，在选中的旧 profile 中移除这两项，让仍支持旧 schema 的客户端继承根级配置；不改其他 profile，不自动迁移旧配置。
- 此修改的现有配置、恢复与客户端测试分别为 20 项及 35 项通过。旧 profile schema 的真实旧版本二进制未另行下载安装验证。

隔离方式：

- 使用临时工作目录及独立 HOME、USERPROFILE、CODEX_HOME、APPDATA、LOCALAPPDATA；仅白名单继承操作系统启动变量，不继承真实 API、OAuth、云厂商或代理凭据。
- 只生成假 JWT/假供应商 Key，未读取真实 auth.json、真实用户模型缓存或真实会话。
- CLI 使用 `--ephemeral`、`--ignore-rules`、`--sandbox read-only`，模拟模型只返回文本，不调用工具。
- HTTP/HTTPS/ALL_PROXY 指向本地拒绝代理，仅回环地址绕过。最后一次运行拦截了 64 次 CLI 外部后台连接尝试（后台尝试数量会随运行不同）；测试未访问真实官方推理或供应商服务，不产生真实额度消耗。
- 官方推理上游通过 `officialTransport` 注入本地 HTTP 模拟服务。此验证证明真实 CLI 配置、身份传递、目录与网关协议互通；不证明某个真实账户具有模型权限、余额或真实官方服务已联通。

本轮未修改真实客户端配置、未发布安装包、未改变 GitHub release 状态。
