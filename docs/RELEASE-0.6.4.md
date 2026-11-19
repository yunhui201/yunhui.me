# 云汇 AI · yunhui.me 0.6.4

发布于 **2026 年 11 月 16 日**。

本版修正插件中心启动 Windows 商店版 ChatGPT / Codex 桌面客户端的方式，处理“进程没有程序包标识符”等启动问题，并完善等待和失败提示。Windows 与 macOS Apple Silicon / Intel 安装包可从 [GitHub Releases](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.4) 下载，或在 **系统设置 → 版本更新** 检查更新；GitHub 不可用时使用官网备用源。

## 插件中心连接

- 商店客户端按当前 Windows 用户的应用注册身份启动，保留插件连接所需的启动参数。
- 只有确认先前启动的进程已退出，且没有其他实例或端口占用时，才尝试保留应用身份的兼容启动方式。状态不明时停止重复启动。
- 启动后等待连接端口就绪；某个桌面页面连接失败时继续尝试其他可用页面。超过等待时间会显示下一步操作，不一直停留在连接中。
- 失败时提供安装记录、普通用户权限、程序更新或端口占用等中文提示，不再退回容易丢失程序包身份的直接启动方式。

普通 Windows 安装版和 macOS 客户端仍使用各自的启动方式。现有主题、供应商、插件和本机设置保留。

## 商店版连接操作

1. 保存工作，从开始菜单打开目标客户端，确认当前 Windows 账号能正常使用。
2. 确认后再次完全退出客户端，包括托盘和后台运行。
3. 以普通用户权限打开云汇，在 **插件中心 → 桌面插件与市场** 点击 **选择程序**，核对当前安装位置。
4. 点击 **启动并连接**；尚未启用市场时使用 **启用并连接**。等待页面显示 **已生效**，再使用插件。

若客户端已经打开但连接未完成，等待窗口加载后点击 **重新连接**。提示程序已更新时重新检测；提示当前账号没有对应安装记录时，修复或重新安装客户端。不要在检查开始菜单启动后省略完全退出步骤。

启动分支、失败处理和连接流程已通过隔离测试。测试电脑未安装已注册的目标商店客户端，尚未完成真实商店安装包的成功启动验收；具体兼容性仍以实际客户端版本和连接结果为准。

## 下载与升级

| 平台 | 安装文件 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.4/YunHuiAI-0.6.4-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.4/YunHuiAI-0.6.4-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.4/YunHuiAI-0.6.4-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.4/YunHuiAI-0.6.4-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.4/YunHuiAI-0.6.4-mac-arm64.zip) |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.4/YunHuiAI-0.6.4-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.4/YunHuiAI-0.6.4-mac-x64.zip) |

发布页附带 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.4/SHA256SUMS.txt)。升级前退出云汇；Windows 运行新版安装包，ZIP 版完整解压到新文件夹后运行 `YunHuiAI.exe`；macOS 将 `YunHuiAI.app` 拖入“应用程序”并替换旧应用。npm 用户可按[源码安装说明](../INSTALLATION.md#npm-从源码安装运行)获取本版标签并安装依赖后启动。

macOS 构建尚未签名与公证。确认应用来自项目发布页后，若首次打开提示“已损坏”，在终端运行：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

安装与首次打开方法见[安装说明](../INSTALLATION.md)，完整功能说明见[使用指南](../USER-GUIDE.md)。历史版本说明：[0.6.3](RELEASE-0.6.3.md) · [0.6.2](RELEASE-0.6.2.md) · [0.6.1](RELEASE-0.6.1.md)。
