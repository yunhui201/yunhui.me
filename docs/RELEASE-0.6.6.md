# 云汇 AI · yunhui.me 0.6.6

[下载本版](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.6) · [安装说明](../INSTALLATION.md) · [使用指南](../USER-GUIDE.md)

新客活动现在以平台实时配置为准。客户端展示当前可领取金额与开放状态，已申请或已到账的额度继续显示原领取金额，不会因后来调整活动而改变。

## 会员额度与登录

- 会员页从平台获取活动金额、说明和开放状态；加载中、离线或金额未确认时显示待确认，不预设固定赠送额度。
- 活动暂停只停止新的领取，会员登录、自动续期、已有余额和添加云汇供应商仍可使用。
- 已提交但仍待确认的申请，可继续点击 **重新确认到账**；按该次申请记录核对原金额。
- 已到账或需人工核对的申请保留原金额；每个会员、每个客户端安装限领一次，重复点击不会重复发放。
- 活动状态读取失败时先刷新确认，不自动重发领取请求。平台确认的到账结果会保留显示。

## 第一次使用

1. 打开 **云汇会员**，查看当前活动说明，使用平台账号登录并绑定本机。
2. 核对可领取额度与资格。活动开放且符合资格时，点击显示当前金额的领取按钮。
3. 已提交的申请若显示 **到账确认中**，点击 **重新确认到账** 核对；遇到网络问题，按提示刷新状态。
4. 选择平台服务分组，点击 **添加云汇供应商**，再到 **客户端接入** 选择模型并预览配置。

使用自己已有的 API 供应商无需开通会员或领取赠金。实际发放金额、资格和到账结果以平台返回为准。

## 配置与历史保护

保留 0.6.5 的自动历史处理：为 ChatGPT / Codex 编程客户端应用、重新应用或恢复原配置时，先备份当前目录内全部未归档、已归档和子任务会话及索引，再同步供应商归属。已有历史无需另外到历史页手动迁移；没有历史时不创建空备份。

请在应用前保存工作并完全退出相关桌面客户端和 CLI。运行提示出现后，退出客户端再点击 **已退出，重新应用**。配置流程不会强行关闭正在执行的任务；失败时尝试恢复本批次修改，外部改动和恢复冲突会保留并提示。迁移不改变正文或加密字段，也不保证跨服务继续使用原加密上下文。

## 下载与升级

| 平台 | 安装文件 |
| --- | --- |
| Windows x64 | [安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.6/YunHuiAI-0.6.6-win-x64-setup.exe) · [免安装版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.6/YunHuiAI-0.6.6-win-x64-portable.exe) · [完整解压版](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.6/YunHuiAI-0.6.6-win-x64.zip) |
| macOS Apple Silicon | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.6/YunHuiAI-0.6.6-mac-arm64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.6/YunHuiAI-0.6.6-mac-arm64.zip) |
| macOS Intel | [DMG](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.6/YunHuiAI-0.6.6-mac-x64.dmg) · [ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.6/YunHuiAI-0.6.6-mac-x64.zip) |

发布页附带 [SHA256 校验清单](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.6/SHA256SUMS.txt)。升级前退出云汇并保留原数据；Windows ZIP 完整解压到新目录后运行 `YunHuiAI.exe`，macOS 将 `YunHuiAI.app` 拖入“应用程序”并替换旧应用。

macOS 包尚未签名与公证。确认应用来自项目发布页后，若首次打开提示“已损坏”，在终端运行：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

安装和首次打开方法见[安装说明](../INSTALLATION.md)，完整功能见[使用指南](../USER-GUIDE.md)。历史自动保护的范围与恢复步骤见[历史迁移指南](HISTORY-PROVIDER-MIGRATION.md)。应用内更新优先使用 GitHub，官网提供备用下载。上一版：[0.6.5](RELEASE-0.6.5.md)。
