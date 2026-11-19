# 云汇 AI · yunhui.me 0.6.3

发布于 **2026 年 11 月 16 日**。

本版完善 Claude 历史会话的来源识别，并修复 Windows 命令行客户端的 **新终端打开**。Windows 与 macOS Apple Silicon / Intel 安装包已发布，可从 [GitHub Releases](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.3) 下载，或在 **系统设置 → 版本更新** 检查更新；GitHub 不可用时使用官网备用源。

## Claude 历史会话

- 历史列表新增存储来源角标及筛选，区分 `.claude` 命令行目录、Claude Desktop 默认目录和 `Claude-3p` 桌面数据目录。
- 来源角标只说明存储位置。历史没有记录模型供应商时，保持未知，不根据模型名或当前设置猜测。
- 可发现 Windows 常规安装、Microsoft Store 安装及 macOS 上的本机 Claude Desktop 会话记录。
- 桌面记录能按会话 ID 与项目目录明确对应到正文时，可以直接阅读和导出；原 CLI 会话记录仍保留。
- 只有会话记录、只能读取历史片段或正文关联不唯一时，页面说明原因，不自动拼接不确定的内容。完整对话请在原 Claude 桌面客户端查看。
- Claude Desktop 会话需回原客户端继续，不提供普通 CLI 恢复命令。Codex 的供应商区域迁移、路径检查和备份恢复继续按原有流程使用。

## Windows 新终端打开

- 修复点击 **新终端打开** 后没有可交互窗口的问题，确认新终端已建立后再报告成功。
- 支持已检测到的 `.exe`、`.cmd` 客户端入口，以及带空格等特殊字符的安装路径。
- 保留原终端与正在进行的会话。新窗口未建立时显示失败原因；客户端自身的登录和运行结果在新窗口查看。

默认 **深夜** 主题、简化后的 **当前连接** 卡片，以及桌面客户端强制结束后重新启动的功能继续保留。升级会保留已有主题、供应商和本机设置。

## 下载与升级

| 平台 | 安装文件 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.3/YunHuiAI-0.6.3-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.3/YunHuiAI-0.6.3-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.3/YunHuiAI-0.6.3-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.3/YunHuiAI-0.6.3-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.3/YunHuiAI-0.6.3-mac-arm64.zip) |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.3/YunHuiAI-0.6.3-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.3/YunHuiAI-0.6.3-mac-x64.zip) |

发布页附带 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.3/SHA256SUMS.txt)。升级前退出云汇；Windows 运行新版安装包，ZIP 版完整解压到新文件夹后运行 `YunHuiAI.exe`，macOS 将 `YunHuiAI.app` 拖入“应用程序”并替换旧应用。npm 用户可按[源码安装说明](../INSTALLATION.md#npm-从源码安装运行)获取本版标签并安装依赖后启动。

macOS 构建尚未签名与公证。确认应用来自项目发布页后，若首次打开提示“已损坏”，在终端运行：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

安装与首次打开方法见[安装说明](../INSTALLATION.md)，完整功能说明见[使用指南](../USER-GUIDE.md)。此前的当前连接卡片改动见 [0.6.2 版本说明](RELEASE-0.6.2.md)。
