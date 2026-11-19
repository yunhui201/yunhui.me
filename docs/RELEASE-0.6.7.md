# 云汇 AI · yunhui.me 0.6.7

[下载本版](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.7) · [安装说明](../INSTALLATION.md) · [使用指南](../USER-GUIDE.md)

修复配置预览被缺少原会话文件的历史索引阻止的问题。可以确认安全保留的记录，会随索引数据库完整备份并保持原样；其他正常历史继续按本次配置迁移，不必删除旧索引才能配置客户端。

## 历史索引不再误阻止配置

- 只有索引记录、找不到对应会话原文件时，先完整备份索引数据库，再保留该记录的原路径和供应商归属。
- 预览区分需要修复、无需修改、原样保留和需要检查的记录，完成后说明实际处理数量。
- 原样保留的记录不会被当成已迁移，也不会凭空补建聊天正文或改写索引归属。
- 会话损坏、现存文件对应错误、归属冲突或其他无法安全处理的情况，仍会阻止应用并说明原因。
- 向导底部显示当前需要处理的提示，便于判断何时可以应用，以及何时需要先退出客户端或重新检查。

## 升级后怎么操作

1. 在 **客户端接入** 重新选择客户端、供应商和模型，点击 **预览配置**。
2. 核对实际配置目录与历史分类。仅缺少原文件且可以安全保留的索引，不再阻止本次应用。
3. 保存工作并完全退出相关桌面客户端和 CLI，再点击 **备份历史并应用配置**；没有历史时显示 **备份并应用配置**。
4. 提示仍在运行时，退出相关客户端后点击 **已退出，重新应用**。完成后核对备份与处理结果，再重新打开客户端。

不需要删除历史数据库或关闭历史保护。完整备份用于保留现状；缺少原文件的记录不能据此恢复已丢失的正文，也不表示它已迁移到新的供应商区域。

## 原有保护继续保留

应用、重新应用和恢复原配置仍会自动处理当前目录内可确认的 Codex 编程历史，包含未归档、已归档和子任务会话。客户端正在运行时停止写入；配置流程不会强行关闭正在执行的任务。保存失败时尝试恢复本批次修改，遇到外部改动则保留现状和备份并提示冲突。

迁移保持正文、归档状态、父子关系和加密字段；跨账号或跨供应商的加密上下文能否续聊仍取决于原客户端和模型服务。会员活动继续读取平台当前金额和开放状态，已有申请保留原金额。

## 下载与升级

| 平台 | 安装文件 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.7/YunHuiAI-0.6.7-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.7/YunHuiAI-0.6.7-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.7/YunHuiAI-0.6.7-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.7/YunHuiAI-0.6.7-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.7/YunHuiAI-0.6.7-mac-arm64.zip) |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.7/YunHuiAI-0.6.7-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.7/YunHuiAI-0.6.7-mac-x64.zip) |

发布页提供 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.7/SHA256SUMS.txt)。升级前退出云汇并保留原数据与备份。ZIP 版完整解压后运行 `YunHuiAI.exe`；Mac 将 `YunHuiAI.app` 放入“应用程序”并替换旧应用。

macOS 包尚未签名与公证。确认应用来自项目发布页后，若首次打开提示“已损坏”，在终端运行：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

应用内更新优先使用 GitHub，官网为备用下载来源。完整操作见[安装说明](../INSTALLATION.md)、[使用指南](../USER-GUIDE.md)及[历史迁移指南](HISTORY-PROVIDER-MIGRATION.md)。上一版：[0.6.6](RELEASE-0.6.6.md)。
