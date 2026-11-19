# 云汇 AI · yunhui.me

**解锁桌面插件市场，把客户端、供应商、模型和历史会话放进一个中文工作空间。**

从你正在使用的客户端开始：选择 Claude Code、兼容的 ChatGPT 桌面版或 Codex CLI，连接自己的 API 供应商，选好模型，预览后应用。支持国内外模型服务与自定义中转地址。新安装默认使用 **深夜** 主题，可在设置中切换为云白或跟随系统；升级保留已保存的主题选择。

[下载 0.6.11](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.11) · [安装说明](INSTALLATION.md) · [使用指南](USER-GUIDE.md) · [反馈问题](https://github.com/yunhui201/yunhui.me/issues) · [用户讨论](https://github.com/yunhui201/yunhui.me/discussions)

> 文档更新于 **2026 年 11 月 18 日**。本文对应 **0.6.11**，Windows 与 macOS 安装包请从 [Releases 下载页](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.11)直接下载。旧版可能不包含下文全部功能。

**本次更新：旧会话迁移后也能继续使用当前选择的模型。** 补齐可识别的历史供应商入口，并为自动修复的会话建立兼容连接。在网关或官方账号共存模式下，桌面端重新打开旧会话时，即使记录中仍是旧模型，也会使用本次选择的供应商和模型。Codex CLI 可在历史页复制带有对应供应商的恢复命令。配置保存与历史处理仍分别进行。完整说明见 [0.6.11 版本说明](docs/RELEASE-0.6.11.md)。

ChatGPT / Codex 先保存客户端配置，再单独尝试历史备份与修复。历史暂时无法处理时保留原样并显示原因，已保存的配置仍可使用；保存工作后重启客户端加载新设置。配置文件本身无法安全保存时仍会明确报错。网关或共存模式的旧会话入口连接已选择的供应商和模型，使用期间请保持云汇运行；直连模式保留旧会话模型名，需上游仍支持该模型。兼容入口不能恢复缺失正文，也不能保证跨账号加密内容可以继续使用。操作与恢复说明见[历史迁移指南](docs/HISTORY-PROVIDER-MIGRATION.md)。

![云汇 AI 客户端工作台](docs/images/clients-v0.6.png)

## 能做什么

1. **插件市场解锁。** 为兼容的桌面客户端开放插件入口，浏览公开市场和完整索引，安装、更新与启停插件。提供中文界面、主题、模型分组、会话导出、历史轮次补全等增强，并显示每项插件是否真正生效。需要服务授权的插件仍按其要求登录。
2. **按客户端配置中转。** 先选客户端，再选或添加供应商和模型。向导支持已有配置发现、云端厂商预设、上游测试、本地网关测试、配置预览、自动备份和恢复；WorkBuddy、CodeBuddy、Kimi、OpenCode 和 Qwen 提供各自的手动接入步骤与示例。
3. **网关与直连任选。** 本地网关支持常用模型协议转换、多密钥轮换、路由分组和用量统计；符合条件时可直连供应商。兼容的 ChatGPT / Codex 编程客户端还可保留官方账号，与第三方模型共存。
4. **查看当前连接与权限。** “当前连接”集中显示客户端、供应商、模型、余额和状态，详细说明可按需展开；桌面应用可强制结束后重新启动，命令行工具可在新终端打开。支持的编程客户端可预览并单独恢复原执行权限，保留供应商连接。
5. **找回与整理历史。** 搜索、阅读和导出本机会话，区分主会话与子任务；Claude 会话可按存储来源筛选，桌面会话会说明正文是否已找到。对 Codex 编程会话提供供应商区域迁移、路径检查和消息索引修复。配置应用和恢复先完成配置，再尝试历史备份与修复；无法处理时保留原历史并提示，独立修复入口继续用于指定范围的整理。
6. **统一管理模型、余额和使用量。** 厂商目录优先展示 OpenAI、Anthropic、Google，再展示其他国际、国内、中转和本地服务。同步供应商模型，分页查找并批量编辑能力、价格与上下文；查询支持接口的供应商余额和各 Key 额度，查看实时请求、Token、缓存命中与估算费用。
7. **按自己的习惯使用。** 管理 MCP、Skills 与全局提示词，调整外观、托盘、自启、代理和网关设置，导入导出配置；通过远程控制台查看电脑上的工作空间。
8. **会员登录自动续期。** 用邮箱和密码登录、完成所需验证后，在平台支持时后台续期，无需因短期访问令牌到期而反复登录。页面会说明续期状态，手动绑定访问令牌的方式需到期后重新绑定；会员活动和额度以平台实时结果为准。

本地客户端识别、历史与资源扫描在后台进行，扫描期间可继续切换页面。模型列表分页展示，长会话分批显示并可展开完整消息；桌面工作台按当前标签读取内容，减少进入页面时的等待。

插件中心优先显示本地目录，返回页面时直接显示已缓存的列表，连接状态在后台更新。需要核对远端目录时点击“同步市场索引”；“刷新状态”用于重新检查本机连接和插件状态。

需要多家服务共同提供一个模型入口时，在 **路由分组** 创建分组并按 **接入参数** 配置客户端，模型名使用 `group/分组名`。可选依次、轮换、按权重、用得少的优先、额度余量优先、健康与优先级六种策略；生效条件与重试边界见[使用指南](USER-GUIDE.md#7-路由mcpskills-与提示词)。

## 第一次使用

1. 安装并打开云汇 AI，进入 **客户端接入**，点击目标客户端的 **开始配置**。
2. 选择已有供应商，或填写供应商给出的 API 地址、API Key 和模型。厂商目录可帮助填写预设。
3. 选择模型和接入方式。通常使用 **本地网关**；不需要网关功能时，可选择界面允许的 **直连供应商**。
4. 测试后点击 **预览配置**，核对实际路径和计划修改，点击 **保存配置**。ChatGPT / Codex 即使正在运行也可先保存配置，历史处理结果会单独说明；手动接入按专属指南完成。测试可能产生少量费用。
5. 重新启动客户端，发起一条对话。使用本地网关时，保持云汇 AI 运行。

ChatGPT / Codex 的配置结果与历史状态分开显示。配置先保存，历史能安全处理时才备份并修复；客户端运行中、历史异常或历史备份失败时，保留原历史并提示稍后处理。配置成功后无需等待历史完成即可重启使用；“待处理”不代表历史已迁移。自动历史修复完成后，可在桌面客户端重新打开旧对话；在 Codex CLI 续聊时，请到 **历史会话** 选择记录并点击 **复制恢复命令**，Windows 粘贴到 PowerShell，macOS 粘贴到终端。命令会携带会话实际使用的供应商，避免直接输入旧命令时出现供应商不一致。

要使用插件，保存工作并完全退出原客户端，在 **插件中心 → 桌面插件与市场** 顶部的 **插件市场解锁** 中点击 **启用并连接**。确认 **已生效** 后点击 **浏览插件市场**。完整操作见[使用指南](USER-GUIDE.md)。

## 支持哪些客户端

| 客户端 | 使用方式 |
| --- | --- |
| Claude Code | 自动配置 API 地址、密钥和模型，支持备份恢复 |
| Claude Desktop | 支持第三方推理配置的版本可自动接入；以本机检测结果为准 |
| Codex CLI | 自动配置 API、模型和上下文，可使用官方账号共存模式 |
| ChatGPT 桌面版 / 原 Codex 桌面版 | 支持 Codex 编程配置的版本可配置第三方模型；桌面插件按版本检测兼容性 |
| Gemini CLI | 自动配置 Gemini 接口和模型 |
| WorkBuddy / CodeBuddy | WorkBuddy 提供自定义模型界面步骤，CodeBuddy CLI / IDE 提供独立配置示例 |
| Kimi、OpenCode、Qwen Code | 提供对应协议、配置文件与启动步骤；OpenCode 区分 V1 / V2，Kimi 核对实际上下文容量 |
| DeepSeek API 与其他兼容客户端 | 生成标准连接参数，需在支持自定义 API 的应用中手动填写 |

桌面客户端的第三方 API 和插件能力以实际版本为准。应用配置后请重启客户端并发起对话验证；专属工具、思考内容和旧会话续聊能力也取决于模型与客户端。详细说明见[使用指南](USER-GUIDE.md)。

## 下载与安装

| 平台 | 0.6.11 下载 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-mac-arm64.zip)，适用于 Apple M 系列芯片 |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-mac-x64.zip)，适用于 Intel 处理器 |
| iPhone / iPad | 目前没有可直接安装的正式 App，可通过浏览器连接电脑端 |

普通用户请下载上表安装包；[Releases 的 Assets](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.11)同时提供 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/SHA256SUMS.txt)。具体文件名和步骤见[安装说明](INSTALLATION.md)。[GitHub Actions](https://github.com/yunhui201/yunhui.me/actions/workflows/build.yml) 中的产物用于体验开发构建，可能包含尚未正式发布的改动。

Windows ZIP 版需完整解压后双击同目录的 `YunHuiAI.exe`；portable 启动会显示准备提示。macOS 将 `YunHuiAI.app` 拖入“应用程序”，未签名包的首次打开方法见[安装说明](INSTALLATION.md#安装和首次打开)。更新或切换包形式会保留已有本机数据。

电脑端已运行时，可用手机浏览器访问远程控制台。局域网连接方法见[使用指南](USER-GUIDE.md)。

### npm 从源码安装

安装 [Node.js 22.x](https://nodejs.org/)（22.13 或更新版本，含 npm）和 [Git](https://git-scm.com/downloads) 后，可通过源码运行桌面应用：

```bash
git clone --branch v0.6.11 --depth 1 https://github.com/yunhui201/yunhui.me.git yunhui.me
cd yunhui.me
npm install --include=dev
npm start
```

Windows PowerShell 请将最后两条命令写为 `npm.cmd install --include=dev` 和 `npm.cmd start`。首次安装需联网下载依赖；以后在保留的源码目录中运行启动命令，不会生成系统快捷方式。Windows、macOS 的完整命令与更新方法见 [npm 源码安装说明](INSTALLATION.md#npm-从源码安装运行)。

版本说明：[0.6.11](docs/RELEASE-0.6.11.md) · [0.6.10](docs/RELEASE-0.6.10.md) · [0.6.9](docs/RELEASE-0.6.9.md) · [0.6.8](docs/RELEASE-0.6.8.md) · [0.6.7](docs/RELEASE-0.6.7.md) · [0.6.6](docs/RELEASE-0.6.6.md) · [0.6.5](docs/RELEASE-0.6.5.md) · [0.6.4](docs/RELEASE-0.6.4.md) · [0.6.3](docs/RELEASE-0.6.3.md) · [0.6.2](docs/RELEASE-0.6.2.md) · [0.6.1](docs/RELEASE-0.6.1.md)。

## 数据与反馈

供应商密钥和配置保存在本机。云端目录提供公开的厂商信息；模型请求发送到你选择的服务。导出的配置包含密钥，请妥善保管。余额以供应商返回为准，用量费用按配置价格估算。

遇到问题可提交[问题反馈](https://github.com/yunhui201/yunhui.me/issues)。请提供云汇版本、系统、客户端名称和版本、所选接入方式及错误提示，并遮住 API Key、访问令牌和个人会话内容。

本项目按 [AGPL-3.0-only](LICENSE) 开源。[查看源码](https://github.com/yunhui201/yunhui.me) · [第三方许可](THIRD_PARTY_NOTICES.md)
