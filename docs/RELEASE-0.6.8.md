# 云汇 AI · yunhui.me 0.6.8

[下载本版](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.8) · [安装说明](../INSTALLATION.md) · [使用指南](../USER-GUIDE.md)

修复自动配置时，缺少原会话文件的同一条索引出现在多个数据库，导致整次应用被误判为重复冲突的问题。

- 符合条件的缺失历史索引可以跨数据库原样保留，不再仅因重复出现在多个库中而阻止配置。
- 各索引数据库完整备份，保留原记录、路径和供应商归属；界面分别显示会话文件与数据库的实际备份数量，扫描到 8 个数据库也会逐个备份。
- 同库重复、真实归属冲突、现存文件错误或运行中的客户端仍会提示处理。有原文件的多库归属不明仍需检查。
- 原样保留不表示已迁移到新供应商，也不会恢复缺失的聊天正文；实际结果以重新预览为准。

## 升级后怎么操作

1. 在 **客户端接入** 选择供应商和模型，重新点击 **预览配置**，核对历史分类和备份数量。
2. 保存工作并完全退出相关桌面客户端和 CLI，再点击 **备份历史并应用配置**。仍有冲突时点击 **查看具体原因**，处理后 **重新检查历史**。
3. 完成后核对结果，再重新启动客户端。无需删除历史数据库；请保留原数据与备份。

## 下载与升级

| 平台 | 安装文件 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.8/YunHuiAI-0.6.8-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.8/YunHuiAI-0.6.8-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.8/YunHuiAI-0.6.8-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.8/YunHuiAI-0.6.8-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.8/YunHuiAI-0.6.8-mac-arm64.zip) |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.8/YunHuiAI-0.6.8-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.8/YunHuiAI-0.6.8-mac-x64.zip) |

发布页提供 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.8/SHA256SUMS.txt)。升级前退出云汇。ZIP 版完整解压后运行 `YunHuiAI.exe`；Mac 将 `YunHuiAI.app` 放入“应用程序”并替换旧应用。

macOS 包尚未签名与公证。确认来自项目发布页后，若首次打开提示“已损坏”，在终端运行：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

应用内更新优先使用 GitHub，官网为备用下载来源。

详细历史处理说明见[历史迁移指南](HISTORY-PROVIDER-MIGRATION.md)。上一版：[0.6.7](RELEASE-0.6.7.md)。
