# 客户端更新检查（2026-11-15）

更新默认先查询 `https://api.github.com/repos/yunhui201/yunhui.me/releases/latest`，只接受正式发布。GitHub 超时、404、限流、无效响应或缺少当前平台资源时，查询官网 `https://yunhui.me/pub.php?action=update`。

客户端根据平台和架构选取实际发布资源，Windows 优先 setup、其次 portable；macOS 为 DMG/PKG，Linux 为 AppImage。文件名必须与正式版本、平台和架构匹配；GitHub URL 必须属于本仓库、对应 tag 和资源。官网下载限定官方 releases 路径或经验证的 GitHub 资源。HTTPS、凭据、版本、正式发布状态及资源状态均验证。

iOS 不把未签名 ZIP、模拟器 ZIP 或普通 IPA 当安装入口，只接受官网提供的 App Store / TestFlight URL。

`update.check` 返回 `source`、`releaseUrl`、`fallbackUrl`、`assetName`。GitHub 成功时不额外查询官网，`fallbackUrl` 为空。用户选择官网备用时，UI 调用 `{ source: 'website', minimumVersion: 已显示版本 }`；只有同版本或更新的正式安装包才返回下载地址。官网未同步会明确提示，不跳到管理后台首页，不把旧安装包当新版本镜像。

版本比较采用 SemVer 规则，包括预发布和构建元数据；服务端自报 `hasUpdate` 不作为升级依据。版本不高于当前客户端时 `hasUpdate=false`，清空下载和备用地址，忽略强制更新标记。桌面动作层优先使用实际应用版本，避免请求参数把当前版本伪装得更低。

验证：

- `node scripts/test-updates.mjs`：21 项通过。
- `npx tsc --noEmit -p tsconfig.json`：通过。
- 回归覆盖安装包优先级、平台架构、GitHub 网络错误/404/403/429、坏 JSON、draft/prerelease、资源与 URL 伪造、官网旧镜像、iOS 安装限制及禁止降级。
- 使用模拟响应执行测试，未发布、部署或修改真实用户数据。

本轮由主代理只读核对线上状态：GitHub `/releases/latest` 返回 404，v0.5.0 为 prerelease、v0.6.0 为 draft；官网当前版本为 0.4.0。该状态下本地 0.6.0 会通过官网回退报告无需更新，且不提供 0.4.0 下载按钮。发布状态未作修改。

实际调用本轮 `checkUpdate('0.6.0', { platform: 'win', arch: 'x64' })`，读取真实公开接口，返回 `source: website`、`version: 0.4.0`、`hasUpdate: false`、`url: ''`，确认真实回退链路与禁止降级均生效；未下载安装包。
