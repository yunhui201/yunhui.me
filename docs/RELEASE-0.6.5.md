# 云汇 AI · yunhui.me 0.6.5

[下载本版](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.5) · [安装说明](../INSTALLATION.md) · [使用指南](../USER-GUIDE.md)

为 ChatGPT / Codex 编程客户端应用、重新应用或恢复原配置时，云汇现在自动备份历史并衔接供应商归属，无需再到历史页执行一次批量迁移。

## 配置与历史一起完成

- 预览显示当前配置目录中的历史总数、需要修复和无需修改的数量。
- 自动备份全部未归档、已归档和子任务会话及历史索引，再迁移到本次配置使用的供应商区域，最后保存配置。
- 已经属于目标区域的会话也会备份；没有历史时正常配置，不创建空的历史备份批次。
- 完成后显示已备份、已修复和无需修改的数量，可展开查看历史备份位置。
- 恢复原配置时同样先备份当前历史，再衔接到原配置的区域，保留现有正文和后来新建的会话。

## 使用步骤

1. 在 **客户端接入** 选择客户端、供应商和模型，点击 **预览配置**。
2. 核对配置路径与历史处理数量，保存工作，完全退出共享这份配置的桌面客户端及相关 CLI 会话。
3. 有历史时点击 **备份历史并应用配置**；没有历史时点击 **备份并应用配置**。提示仍在运行时，退出相关客户端后点击 **已退出，重新应用**。
4. 查看处理结果和备份位置，再重新打开客户端验证模型与历史。

该流程不会自动强行关闭正在执行任务的客户端。发现历史损坏、归属不明或无法安全处理的记录时，会停止整次配置应用并提示检查。

## 失败与中断恢复

历史迁移或配置保存失败时，会尝试恢复本批次修改。其他程序已修改的配置、历史或供应商状态会被保留，并显示恢复冲突。程序意外退出后，下次配置预览或应用会检查未完成批次，确认客户端已退出且内容可核验后自动恢复。

迁移保留正文、归档状态、父子任务关系与加密字段。它不会转换加密内容的账号或供应商身份；旧会话能否跨服务续聊仍由原客户端和模型服务决定。

本次自动处理适用于当前配置目录中的 Codex 编程历史。Claude、其他独立配置目录和云端聊天不属于处理范围。独立历史迁移与按批次恢复入口继续保留。

## 下载与升级

| 平台 | 安装文件 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.5/YunHuiAI-0.6.5-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.5/YunHuiAI-0.6.5-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.5/YunHuiAI-0.6.5-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.5/YunHuiAI-0.6.5-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.5/YunHuiAI-0.6.5-mac-arm64.zip) |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.5/YunHuiAI-0.6.5-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.5/YunHuiAI-0.6.5-mac-x64.zip) |

发布页提供 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.5/SHA256SUMS.txt)。在 **系统设置 → 版本更新** 也可检查新版，GitHub 为首选下载来源，官网为备用来源。

升级前退出云汇，保留本机数据和配置备份。Windows 运行新版安装包；ZIP 版完整解压到新目录后运行 `YunHuiAI.exe`。macOS 按芯片选择安装包，将 `YunHuiAI.app` 放入“应用程序”并替换旧应用。

macOS 包尚未签名与公证。确认应用来自项目发布页后，若首次打开提示“已损坏”，在终端运行：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

完整步骤见[安装说明](../INSTALLATION.md)；配置与历史的范围、恢复和冲突处理见[历史迁移指南](HISTORY-PROVIDER-MIGRATION.md)。上一版说明：[0.6.4](RELEASE-0.6.4.md)。
