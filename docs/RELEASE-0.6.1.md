# 云汇 AI · yunhui.me 0.6.1

发布于 **2026 年 11 月 16 日**。

本版修复桌面客户端缩至托盘或只在后台运行时无法重新启动的问题。Windows 与 macOS Apple Silicon / Intel 安装包已发布，可从 [GitHub Releases](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.1) 下载，客户端也可通过 **系统设置 → 版本更新** 检查更新；GitHub 不可用时使用官网备用源。

## 重新启动客户端

- 在 **客户端接入** 或配置完成页点击 **重新启动客户端**，确认后强制结束所选桌面客户端的进程，包括托盘和后台运行；确认退出后再重新打开。
- 客户端尚未运行时直接启动。启动后会检查目标程序是否已运行；结束失败时显示原因，不会重复打开或误报成功。
- 核对程序路径、当前用户与进程身份，只处理所选客户端；不会按相同程序名批量结束其他安装位置的程序。云汇自身及启动云汇的进程受到保护。
- 确认窗口明确提示：当前会话会中断，未保存内容可能丢失。请先保存工作，再确认重新启动。
- Claude Code、Codex CLI 等命令行工具仍使用 **新终端打开**，原终端与会话保留。API 服务不显示本机重启入口。

桌面插件增强连接会随原客户端退出而断开；重新启动后，按插件中心提示重新连接。配置加载是否生效，请在实际客户端中发起一条对话验证。

## 默认深夜主题

新安装默认使用 **深夜** 主题。可在 **系统设置 → 外观与启动** 切换为云白或跟随系统；已有用户升级后保留已保存的主题选择。

## 下载与升级

| 平台 | 安装文件 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.1/YunHuiAI-0.6.1-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.1/YunHuiAI-0.6.1-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.1/YunHuiAI-0.6.1-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.1/YunHuiAI-0.6.1-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.1/YunHuiAI-0.6.1-mac-arm64.zip) |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.1/YunHuiAI-0.6.1-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.1/YunHuiAI-0.6.1-mac-x64.zip) |

发布页附带 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.1/SHA256SUMS.txt)。升级前退出云汇；Windows 运行新版安装包，ZIP 版完整解压到新文件夹后运行 `YunHuiAI.exe`，macOS 将 `YunHuiAI.app` 拖入“应用程序”并替换旧应用。已有本机供应商与设置会保留。

macOS 构建尚未签名与公证。确认应用来自项目发布页后，若首次打开提示“已损坏”，在终端运行：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

更多安装方法见[安装说明](../INSTALLATION.md)，配置、插件与历史功能见[使用指南](../USER-GUIDE.md)。此前功能说明保留在 [0.6.0 版本说明](RELEASE-0.6.0.md)。
