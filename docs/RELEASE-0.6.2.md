# 云汇 AI · yunhui.me 0.6.2

发布于 **2026 年 11 月 16 日**。

本版简化 **客户端接入 → 当前连接** 卡片，让客户端、供应商、模型、余额和连接状态更容易查看。Windows 与 macOS Apple Silicon / Intel 安装包已发布，可从 [GitHub Releases](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.2) 下载，或在 **系统设置 → 版本更新** 检查更新；GitHub 不可用时使用官网备用源。

## 当前连接

- 卡片以客户端名称为标题，下方显示“供应商 → 模型”，右侧展示供应商余额。
- 当前状态及 **配置与测试**、**查看请求** 等常用操作直接可见。
- 接入方式、详细说明、余额更新时间和统计口径集中放在 **连接详情**，需要时展开查看。
- 请求失败、网关停止等异常提示仍直接显示，方便及时处理。

余额仍以供应商实际返回为准。直连请求不经过本地网关，无法据此确认最近成功时间；共享配置的请求来源也需在实际客户端核验。详细解释可在卡片的 **连接详情** 中查看。

新安装继续默认使用 **深夜** 主题，可在 **系统设置 → 外观与启动** 切换；升级保留已保存的主题选择。桌面客户端的 **重新启动客户端** 仍会强制结束所选客户端、确认退出后再打开，操作前请保存工作；CLI 的 **新终端打开** 保留原终端与会话。

## 下载与升级

| 平台 | 安装文件 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.2/YunHuiAI-0.6.2-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.2/YunHuiAI-0.6.2-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.2/YunHuiAI-0.6.2-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.2/YunHuiAI-0.6.2-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.2/YunHuiAI-0.6.2-mac-arm64.zip) |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.2/YunHuiAI-0.6.2-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.2/YunHuiAI-0.6.2-mac-x64.zip) |

发布页附带 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.2/SHA256SUMS.txt)。升级前退出云汇；Windows 运行新版安装包，ZIP 版完整解压到新文件夹后运行 `YunHuiAI.exe`，macOS 将 `YunHuiAI.app` 拖入“应用程序”并替换旧应用。已有本机供应商与设置会保留。

macOS 构建尚未签名与公证。确认应用来自项目发布页后，若首次打开提示“已损坏”，在终端运行：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

安装与首次打开方法见[安装说明](../INSTALLATION.md)，完整功能说明见[使用指南](../USER-GUIDE.md)。此前的强制重启与默认深夜主题改动见 [0.6.1 版本说明](RELEASE-0.6.1.md)。
