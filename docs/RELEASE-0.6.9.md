# 云汇 AI · yunhui.me 0.6.9

[下载本版](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.9) · [安装说明](../INSTALLATION.md) · [使用指南](../USER-GUIDE.md)

历史记录存在问题时，先备份，再跳过无法修复的部分，继续完成客户端配置。

- 会话内容格式错误、重复记录、路径或归属不明确时，完整备份后原样保留，不再仅因这些历史问题挡住配置。
- 能安全修复的会话继续迁移；暂不支持的索引结构会备份保留。
- 预览和完成结果分别显示已修复、原样保留、已跳过，以及会话文件与数据库的实际备份数量。
- 跳过不代表修复或恢复了聊天内容。备份失败、客户端仍在运行等无法安全写入的情况仍会提示处理。

## 升级后怎么操作

1. 在 **客户端接入** 选好供应商和模型，重新点击 **预览配置**，核对备份与历史处理数量。
2. 保存工作并完全退出相关桌面客户端和 CLI，再点击 **备份历史并应用配置**。
3. 配置完成后重新启动客户端。需要时可查看跳过原因和历史备份，不必为继续配置而删除旧会话。

## 下载与升级

| 平台 | 安装文件 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.9/YunHuiAI-0.6.9-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.9/YunHuiAI-0.6.9-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.9/YunHuiAI-0.6.9-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.9/YunHuiAI-0.6.9-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.9/YunHuiAI-0.6.9-mac-arm64.zip) |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.9/YunHuiAI-0.6.9-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.9/YunHuiAI-0.6.9-mac-x64.zip) |

发布页提供 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.9/SHA256SUMS.txt)。升级前退出云汇并保留原数据。ZIP 版完整解压后运行 `YunHuiAI.exe`；Mac 将 `YunHuiAI.app` 放入“应用程序”并替换旧应用。

macOS 包尚未签名与公证。确认来自项目发布页后，若首次打开提示“已损坏”，在终端运行：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

应用内更新优先使用 GitHub，官网为备用下载来源。

详细历史处理说明见[历史迁移指南](HISTORY-PROVIDER-MIGRATION.md)。上一版：[0.6.8](RELEASE-0.6.8.md)。
