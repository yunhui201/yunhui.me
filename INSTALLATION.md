# 云汇 AI · yunhui.me 安装说明

云汇 AI 是独立的桌面工具。请先安装你要使用的 Claude、ChatGPT、Codex 或其他客户端，再用云汇连接自己的模型服务。

本说明更新于 **2026 年 11 月 18 日**，对应 **0.6.11**。Windows 与 macOS 安装包可从 [Releases 下载页](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.11)直接下载。

[打开 0.6.11 下载页](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.11) · [使用指南](USER-GUIDE.md) · [返回介绍](README.md)

## 获取安装文件

打开 [0.6.11 发布页](https://github.com/yunhui201/yunhui.me/releases/tag/v0.6.11)，展开 **Assets**，选择与你的系统一致的文件；也可直接点击下表下载。这里提供可使用的安装文件，通常无需登录 GitHub。不要将 GitHub 自动生成的 **Source code** 压缩包当作客户端安装包。

| 系统与用途 | 0.6.11 安装文件 |
| --- | --- |
| Windows x64 安装版 | [YunHuiAI-0.6.11-win-x64-setup.exe](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-win-x64-setup.exe) |
| Windows x64 免安装版 | [YunHuiAI-0.6.11-win-x64-portable.exe](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-win-x64-portable.exe) |
| Windows x64 完整解压版 | [YunHuiAI-0.6.11-win-x64.zip](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-win-x64.zip) |
| macOS Apple M 系列 | [YunHuiAI-0.6.11-mac-arm64.dmg](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-mac-arm64.dmg) |
| macOS Intel | [YunHuiAI-0.6.11-mac-x64.dmg](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-mac-x64.dmg) |

更新内容见 [0.6.11 版本说明](docs/RELEASE-0.6.11.md)。

macOS 同时提供 [Apple Silicon ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-mac-arm64.zip) 和 [Intel ZIP](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/YunHuiAI-0.6.11-mac-x64.zip)，可完整解压后将 `YunHuiAI.app` 放入“应用程序”；一般优先使用 DMG。[SHA256SUMS.txt](https://github.com/yunhui201/yunhui.me/releases/download/v0.6.11/SHA256SUMS.txt) 可用于核对下载文件是否完整。

需要体验开发构建时，打开 [GitHub Actions 的 build 页面](https://github.com/yunhui201/yunhui.me/actions/workflows/build.yml)，选择对应平台已成功完成的构建，在 **Artifacts** 中下载；通常需要登录 GitHub，下载后先解压外层压缩包。开发构建可能包含尚未正式发布的改动。

## Windows

### 安装版

1. 下载名称以 `win-x64-setup.exe` 结尾的文件。
2. 双击安装包，按提示选择安装目录并完成安装。
3. 从桌面或开始菜单打开 **云汇AI 工具箱**。

当前安装包未做代码签名。若 Windows 显示“已保护你的电脑”，先确认文件来自上述发布页，再在提示中选择 **更多信息 → 仍要运行**。如果电脑由单位管理且没有该选项，请联系管理员安装。

### 免安装版

下载名称以 `win-x64-portable.exe` 结尾的文件，放到固定目录后双击。启动时会先显示准备提示，待准备完成后打开主窗口，请勿连续双击。

免安装版也会保存你的设置。需要找到这些数据时，进入 **系统设置 → 数据与关于 → 打开数据目录**；不要仅凭程序所在文件夹判断数据位置。

### ZIP 完整解压版

下载名称以 `win-x64.zip` 结尾的文件，将压缩包中的全部文件解压到同一个固定文件夹，再双击其中的 `YunHuiAI.exe`。不要在压缩包内直接运行，也不要只取出这个 EXE；它需要同目录的资源和运行文件。

更新 ZIP 版时先退出云汇，把新版完整解压到新文件夹后运行，避免旧文件混入。已有的本机供应商和设置会保留；切换安装版、portable 或 ZIP 无需先删除数据。

### Windows 打不开或没有出现窗口

先检查托盘是否已有云汇窗口；使用 portable 时，等待准备提示结束。ZIP 版请确认已完整解压，文件没有被安全软件隔离；可重新解压到新文件夹重试，保留原数据目录。仍无窗口或启动后立即退出时，记录包的版本、包类型、Windows 版本和错误提示，再反馈给项目。

在云汇中点击命令行客户端的 **新终端打开**，会打开可交互的 PowerShell 窗口，原终端与会话保留。若未收到新窗口的启动确认，界面会显示失败原因；请检查终端窗口和系统拦截提示。终端成功打开后，客户端本身的登录或启动错误会显示在该窗口中。

### Windows 商店客户端的插件连接

使用 Microsoft Store 安装的 ChatGPT / Codex 桌面客户端时，云汇会按当前 Windows 用户的应用注册信息启动。若提示程序包身份、安装记录或权限问题：

1. 保存工作，从开始菜单打开目标客户端，确认该 Windows 账号能正常使用。
2. 确认后再次完全退出客户端，包括托盘和后台运行。
3. 以普通用户权限打开云汇，在 **插件中心 → 桌面插件与市场** 点击 **选择程序**，核对当前安装位置。
4. 点击 **启动并连接**（尚未启用市场时显示 **启用并连接**），等待连接状态；以 **已生效** 为准。

如果客户端已打开但连接未完成，等待窗口加载后点击 **重新连接**。提示程序已更新时重新检测和选择程序；提示没有当前账号的安装记录时，修复或重新安装客户端。不要在确认开始菜单可用后，让未退出的客户端继续占用旧连接。

## macOS

### 选择对应芯片的安装包

点击屏幕左上角 ** → 关于本机**，查看芯片或处理器信息。

| 电脑 | 选择的文件 |
| --- | --- |
| Apple M 系列芯片 | 名称以 `mac-arm64.dmg` 结尾 |
| Intel 处理器 | 名称以 `mac-x64.dmg` 结尾 |

请按电脑的实际芯片下载，不要将 Intel 与 Apple Silicon 安装包混用。

### 安装和首次打开

1. 打开对应的 DMG，将 **YunHuiAI.app** 拖入 **应用程序 / Applications**。
2. 推出 DMG，从“应用程序”打开 **YunHuiAI.app**，进入云汇AI 工具箱。
3. 若系统提示无法验证开发者，可先尝试在“应用程序”中按住 Control 点击应用，选择 **打开**；也可在 **系统设置 → 隐私与安全性** 中查看此次打开被阻止的提示。

当前构建包未做 Apple 签名与公证。**确认应用来自项目发布者后**，若仍提示“已损坏”或无法打开，在系统“终端”中运行以下命令，再重新打开应用：

```bash
xattr -cr "/Applications/YunHuiAI.app"
```

本版应用包文件名为 `YunHuiAI.app`；如果安装在其他位置或已改名，请将命令路径替换成实际完整路径。这条命令只用于清除该应用的扩展属性，不需要关闭整个系统的安全保护。

如果仍无法打开，请重新下载对应芯片的完整 DMG，重新拖入“应用程序”，并记录系统提示以便反馈。

### Mac 上的常用操作

- 选择桌面客户端位置时，选完整的 `.app` 应用包。插件页未找到客户端或连接失败时，可点击 **选择程序**，保存后点击 **重新连接**。
- 点击命令行客户端的 **新终端打开** 时，macOS 可能询问是否允许云汇控制 Terminal；允许后才能自动打开命令行工具。
- 开启关闭窗口后保留运行时，关窗口不会停止网关。要完全退出，可按 **⌘Q** 或使用应用退出菜单。

## npm 从源码安装运行

这种方式会下载项目源码、安装依赖，再启动云汇桌面应用。请先安装 **Node.js 22.x（22.13 或更新版本）**（安装时包含 npm）和 **Git**；本项目目前没有发布 npm 全局安装包。

### Windows PowerShell

打开 PowerShell，进入准备存放项目的目录，依次执行：

```powershell
git clone --branch v0.6.11 --depth 1 https://github.com/yunhui201/yunhui.me.git yunhui.me
cd yunhui.me
npm.cmd install --include=dev
npm.cmd start
```

这里使用 `npm.cmd`，可避免 PowerShell 对 `npm.ps1` 的执行策略限制，无需修改系统执行策略。

### macOS 终端

打开“终端”，进入准备存放项目的目录，依次执行：

```bash
git clone --branch v0.6.11 --depth 1 https://github.com/yunhui201/yunhui.me.git yunhui.me
cd yunhui.me
npm install --include=dev
npm start
```

首次安装需联网下载依赖和 Electron 运行文件。启动命令会构建所需资源并打开桌面窗口，请等待终端完成；若提示找不到 `node`、`npm` 或 `git`，确认已安装对应工具后重新打开终端。若安装时出现 `electron/install.js` 下载超时，请检查终端能否访问 GitHub 下载服务，网络恢复后重新执行安装命令；不要添加 `--ignore-scripts` 跳过下载，否则应用无法启动。

### 再次启动与更新

请保留下载的 `yunhui.me` 源码目录。以后在该目录中执行 `npm.cmd start`（Windows PowerShell）或 `npm start`（macOS）即可打开；这种运行方式不会生成系统安装包或快捷方式。

后续更新时，可从[发布页](https://github.com/yunhui201/yunhui.me/releases)选择新版本，按照上面的步骤将对应标签克隆到新的目录，再安装依赖并启动。也可在原源码目录运行 `git fetch --tags`，用 `git switch --detach 版本标签` 切换到选定的发布版本（将“版本标签”替换为实际的 `v` 开头标签），然后重新执行依赖安装和启动命令。保留自行修改的源码后再切换版本；发布标签安装请使用上述手动更新步骤，应用内的 Git 更新按钮不适用，也不要直接执行 `git pull`。

## 首次连接模型

1. 打开 **客户端接入**，找到要配置的客户端，点击 **开始配置**。
2. 在向导中添加供应商，填写服务商提供的 API 地址和 API Key，再选择模型。
3. 选择 **本地网关** 或符合条件的 **直连供应商**。
4. 测试后点击 **预览配置**，核对实际路径和计划修改，点击 **保存配置**。ChatGPT / Codex 正在运行也可先保存配置，历史是否处理会单独说明；其他自动配置客户端按预览应用，手动接入按专属指南完成设置。
5. 保存工作后点击 **重新启动客户端** 并确认，云汇会强制结束该桌面客户端（包括托盘和后台运行），确认退出后再打开。命令行工具使用 **新终端打开**，原终端和会话保留。使用网关时请保持云汇运行。

ChatGPT / Codex 会先保存配置，再单独尝试历史备份与修复。客户端运行中或历史遇到问题时，历史保持原样并说明原因；已保存的配置可在重启后使用。配置文件自身无法备份或写入时仍会提示失败，不会把历史待处理显示为已迁移。旧会话提示供应商不存在时，请升级后重新选择有效供应商和模型、保存配置，再重启客户端。自动历史修复完成后，桌面旧对话通过兼容连接使用所选供应商和模型，即使会话记录仍保留旧模型名。网关或共存模式使用期间需保持云汇运行；直连会话保留旧模型名，能否继续由上游支持情况决定。接口无权限、模型不可用或缺失聊天正文仍需分别处理。完整步骤见[历史迁移指南](docs/HISTORY-PROVIDER-MIGRATION.md)。

要在 Codex CLI 继续旧对话，进入 **历史会话**，选择记录并点击 **复制恢复命令**；Windows 使用 PowerShell，macOS 使用终端粘贴执行。命令会自动指定该会话的供应商，避免与新会话的默认供应商冲突。

手动接入使用本地网关参数，云汇不自动修改或备份该客户端的配置。示例中的令牌是占位文字；电脑端的 **复制真实令牌** 或 **复制可用配置（含令牌）** 才会复制可用凭据。已有配置请先自行备份、再合并。插件市场的连接和启用步骤见[使用指南](USER-GUIDE.md)。

## 更新、换电脑与卸载

**更新：** 在 **系统设置 → 版本更新 → 检查更新** 查看新版本，也可直接打开[发布页](https://github.com/yunhui201/yunhui.me/releases)。安装前退出云汇；Windows 运行新安装包，Mac 用新应用替换“应用程序”中的旧应用。预览版是否提供更新，以发布页为准。

使用 Actions 构建包时，可按本文步骤下载较新的成功构建；构建产物不等于已进入正式自动更新渠道。更新后，原有供应商与设置会保留。旧版会员会话需要用邮箱与密码重新登录一次，平台支持时即可启用后台自动续期。

**换电脑：** 在旧电脑打开 **系统设置 → 数据与关于 → 导出配置**，在新电脑安装云汇后选择 **导入配置**，然后重新应用客户端连接。导出文件含 API 密钥；客户端安装位置及本地历史需另行迁移，导入云汇配置不会自动搬走这些文件。

**卸载：** 如果客户端仍使用本地网关，先处理它的连接：由云汇自动配置的客户端可在 **客户端接入** 点击 **恢复 → 恢复原配置**，或改为可用的直连配置；手动接入的客户端需在原客户端中改回连接参数。随后退出并卸载云汇。Windows 从系统应用列表卸载；Mac 将应用移到废纸篓。需要删除本地数据时，先在系统设置中查看实际数据目录并保存所需备份。

## iPhone 与 iPad

当前没有可直接安装的正式 iOS App 或公开 TestFlight 入口。发布页中的 iOS 源码、模拟器文件和未签名设备文件都不能通过普通点击安装到手机。

现阶段可使用手机浏览器访问电脑的云汇控制台：电脑和手机连接同一局域网，在电脑中开启局域网监听，再输入电脑地址与访问令牌。具体操作见[使用指南](USER-GUIDE.md)。
