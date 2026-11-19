# yunhui.me 手机伴侣 0.6.0 · iOS / Android

手机端内置独立管理界面。连接电脑或服务器上的云汇网关后，可以查看用量与请求、选择客户端并预览/应用供应商和模型、启停供应商、查看模型能力、搜索和阅读本地会话，以及查看插件状态。

0.6.0 工作台增加缓存读取、缓存写入与命中率，以及每 1.5 秒更新的实时请求。明确区分未提供字段、真实零值和生成中输出估算；请求完成后刷新统计，切换到后台或断开连接后停止轮询。命中率采用服务端对已报告缓存的请求计算的结果，不把未报告缓存的请求当作零命中。

电脑负责网关和客户端配置，手机负责远程管理。API Key 留在电脑；访问令牌只保留在当前应用内存中，断开连接后清除。仅保存网关地址和外观偏好。

本版本按 [AGPL-3.0-only](../LICENSE) 发布，[项目源码与构建材料](https://github.com/yunhui201/yunhui.me)公开可用，0.6.0 仍在本地验证；源码包附带许可证和第三方声明，应用「我的」页面也提供对应源码入口。

## 已验证的构建与下载

2026-11-15，0.5.0 的 GitHub Actions macOS runner 已成功完成依赖安装、移动接口测试、CocoaPods 同步，以及 Xcode 模拟器和 iPhone 设备二进制编译。以下是这次已有成功记录；0.6.0 的源码、网页构建及测试已更新，原生二进制以新提交对应的 Actions 结果为准。

- [查看成功的 iOS 构建任务](https://github.com/jxb412/yunqiao.me/actions/runs/43617930882/job/132517017996)
- [下载模拟器构建产物](https://github.com/jxb412/yunqiao.me/actions/runs/43617930882/artifacts/14122749347)：`yunhui-ios-simulator`，内含 `YunHuiAI-iOS-simulator.zip` 和 `App.app`
- [下载未签名 iPhone 设备产物](https://github.com/jxb412/yunqiao.me/actions/runs/43617930882/artifacts/14123405186)：`yunhui-ios-device-unsigned`，内含 `YunHuiAI-iOS-device-unsigned.zip` 和 `App.app`
- [查看两种目标的构建日志](https://github.com/jxb412/yunqiao.me/actions/runs/43617930882/artifacts/14122951333)

Actions 产物可能需要登录 GitHub，并受保留期限限制；后续构建见[工作流列表](https://github.com/yunhui201/yunhui.me/actions/workflows/build.yml)。模拟器 `.app` 用于 Mac 上的 iOS 模拟器，设备 `.app` 需要补签名后才能安装；**两者都不是可直接安装到 iPhone 的签名 IPA**。

解压出 `App.app`，打开 Xcode 的 Simulator 后，可以将它拖入模拟器安装，或执行：

```bash
xcrun simctl install booted /path/to/App.app
xcrun simctl launch booted io.yunhui.ai.companion
```

已验证的是原生编译与打包；iPhone 真机网络、系统权限和后台行为仍需在签名安装后测试。

## 使用

1. 在电脑的云汇 AI 设置中开启局域网共享，设置访问令牌，并确认网关正在运行。
2. 手机与电脑连接同一网络，输入 `http://电脑局域网IP:3425` 和访问令牌；也可以连接你部署的 HTTPS 网关。
3. 「客户端」选择已有供应商/模型，预览电脑上将修改的配置，再确认应用。需要重启的客户端，在电脑上重启后生效。
4. 「会话」只读扫描电脑会话，搜索标题/项目并阅读内容。完整会话解析和续聊能力取决于客户端格式。

供应商新增、Key 编辑、安装/编写插件和系统级操作在电脑端完成。官方客户端没有开放第三方接入时，手机也不会把它标记为已经接入。请勿把访问令牌填进 URL；远程公网连接使用 HTTPS。

## 本地资源与验证

要求 Node.js 22+。依赖锁定为 Capacitor 7.6.10；最低 iOS 16。

```bash
cd mobile
npm ci
npm test
npm run build
```

`src/` 是界面源码，`www/` 是构建结果。iOS 使用 Capacitor 原生 HTTP 网络请求，浏览器预览使用 Fetch。`tests/connection.test.mjs` 验证地址、认证头、失败响应；`tests/usage.test.mjs` 验证缓存缺失与零值、正确的命中率来源，以及估算值被上游真实输出替代。

可选浏览器流程验证（需要 Python Playwright 和 Chromium）：

```bash
python tests/browser-smoke.py
```

它使用模拟 RPC，不读取本机真实密钥，覆盖连接失败/成功、预览与版本校验、客户端限制、供应商启停、模型、会话文本安全、主题、窄屏和退出。截图写入 `build/mobile-workspace.png`。这不代替 iOS 真机测试。

## 生成 Xcode 工程

```bash
npm run sync:ios
```

该命令构建页面、首次生成 `ios/`，配置本地网络权限、iOS 16 目标和图标，再同步到原生工程。可在 Windows 上生成这些源文件。Windows 没有 Xcode/CocoaPods，跳过原生依赖与编译的提示是预期结果。

Windows 生成的原生项目为 `mobile/ios/App/App.xcodeproj`。在 Mac 上运行 `npm run sync:ios` 完成 CocoaPods 安装后，使用 **`mobile/ios/App/App.xcworkspace`** 构建。仅生成工程不等于编译成功。

## 编译模拟器版本（macOS）

需要 macOS、Xcode 16+、Command Line Tools 和 CocoaPods。在 Mac 上重新运行 `npm ci` 与 `npm run sync:ios`，安装本机所需的依赖后执行：

```bash
xcodebuild -workspace ios/App/App.xcworkspace \
  -scheme App -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
```

产物：`mobile/build/Build/Products/Release-iphonesimulator/App.app`，只能运行在 iOS 模拟器。

仓库根目录 [`.github/workflows/build.yml`](../.github/workflows/build.yml) 的 `ios` job 使用 macOS runner 完成相同流程，上传 `yunhui-ios-simulator`（内含 `.app` ZIP）和构建日志。构建错误会使任务失败，不会通过管道或 `|| true` 被隐藏。上方链接提供实际成功的运行记录；后续产物以对应运行结果为准。

## 编译 iPhone 设备版本（未签名）

工作流在模拟器构建成功后，还会构建面向真实 iPhone 的原生二进制，并单独上传 `yunhui-ios-device-unsigned`。本地 Mac 对应命令：

```bash
xcodebuild -workspace ios/App/App.xcworkspace \
  -scheme App -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath build-device \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO 'CODE_SIGN_IDENTITY=' build
```

产物 `build-device/Build/Products/Release-iphoneos/App.app` 被打包为 `YunHuiAI-iOS-device-unsigned.zip`。它不包含签名证书或描述文件，**不能直接安装到 iPhone，也不能提交 TestFlight**；它与模拟器包的目标平台不同。需要安装或分发时，请按下节使用自己的 Apple 团队签名并导出 IPA。

## 真机 IPA / TestFlight

```bash
npm run open:ios
```

在 Xcode 中选择 App target，设置自己的 Bundle Identifier 和开发团队，连接 iPhone 运行；要分发则选择 iOS Device → Product → Archive → Distribute App。可分发 IPA 需要有效的 Apple 开发者团队、签名证书及描述文件；App Store / TestFlight 还需要相应账号配置。

Windows 工作区提供源码与网页资源；上方所列 **0.5.0** 模拟器与未签名设备 `.app` 已由 macOS Actions 实际编译。**0.6.0** 原生编译状态以对应提交的 Actions 记录为准。尚未配置 Apple 签名资料，因此当前不提供可安装到 iPhone 的签名 IPA。`iOS-source` 是源码包，不能当作安装包。

## Android

```bash
npm run build
npm run add:android   # 仅首次
npm run sync
npm run open:android
```

Android Studio 中编译。当前发布目标是 Windows，以及 iOS 模拟器和未签名设备版本；原生构建状态以对应版本记录为准。Android 不是已验证的产物。

## 源码包

```bash
python scripts/package-source.py
```

生成 `build/YunHuiAI-0.6.0-iOS-source.zip`，含 mobile 源码、锁文件、资源和已生成的 `ios/` 工程，不含依赖、构建缓存或本地连接信息。在 Mac 解压后进入 `mobile`，运行 `npm ci && npm run sync:ios` 即可补齐依赖并打开工程。脚本从 package.json 读取版本号，避免原生工程和界面版本不一致。
