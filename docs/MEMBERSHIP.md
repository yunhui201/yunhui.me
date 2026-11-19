# 会员绑定与首次使用赠金

后端入口为 `server/member.php`，管理页为 `server/member_admin.php`（沿用云端后台管理员登录和 CSRF）。赠金是云汇会员站点的 USD 使用额度，每个经过上游验证的会员账户、每个安装标识各限一次；不以客户端自报的账户 ID 发放。安装 ID 和秘密由客户端随机生成，属于安装绑定，并不是不可伪造的硬件证明。重装或复制安装凭据的风险不能靠客户端标识彻底解决，账户唯一约束始终在服务器执行。

## 服务器配置

需要 PHP **8.1+**，`pdo_sqlite`、`openssl`、`curl` 扩展，可信 CA，HTTPS。安装依赖后先运行 `php scripts/test-members.php` 和 `python scripts/test-member-admin-policy.py`。后者使用本地 PHP HTTP 服务测试真实管理员登录、CSRF、表单保存、并发修改冲突和原申请重试；可通过 `--php` 指定 PHP 路径，通过 `--php-extension-dir` 指定扩展目录。本地集成测试使用独立临时账本和模拟上游，不申请真实赠金、不访问生产账户。

安装 Playwright 和 Chromium 后，可为管理员测试加 `--browser`，同时检查桌面与手机宽度下的实际页面。会员服务未完成配置时，后台只显示配置提示，不初始化会员账本。

环境变量优先，也支持 PHP-FPM 无法继承环境时的固定私密文件 `/www/aurora-data/member-secrets.json`。该文件必须位于网站目录之外，所有者为 PHP 工作用户，权限 `0600`；发现组/其他用户权限或符号链接时拒绝加载。不要放入 git、公开目录、客户端安装包或目录 API。

| 环境变量 | 私密 JSON 字段 | 说明 |
| --- | --- | --- |
| `AURORA_MEMBERS_ENABLED` | `enabled` | 环境值 `1` 或 JSON 布尔 `true` 启用，默认关闭 |
| `AURORA_SUB2API_URL` | `origin` | 默认 `https://api.yunhui.me`，仅 HTTPS 源地址，不允许路径、用户名、重定向 |
| `AURORA_SUB2API_ADMIN_KEY` | `adminKey` | sub2api 管理密钥，仅在 PHP 服务端使用 |
| `AURORA_MEMBER_SECRET` | `secret` | 至少 32 字符的随机秘密，用于令牌加密和稳定凭据生成 |
| `AURORA_MEMBER_DATA_DIR` | `dataDir` | 默认 `/www/aurora-data/members`，必须在 Web 根目录之外 |

先备份生产站点，再通过 `scripts/deploy_php.py --apply` 发布 PHP 源码。部署程序不会写入私密配置，需单独通过受保护的 SSH 通道部署配置。确认 PHP-FPM 用户能读私密文件、能写会员数据目录。Nginx 只提供站点根目录中的 PHP 入口，不为 `/www/aurora-data` 建静态映射。会员页面显示启用状态，`member.php?a=config` 不返回任何密钥。

账本 `members.sqlite` 使用 WAL、`synchronous=FULL`、事务和账户/安装唯一约束。备份应使用 SQLite 在线 backup API 或 `VACUUM INTO`，不要仅在运行时复制主文件并漏掉 WAL。配置秘密与账本必须一起备份。不要删除账本、变更活动 ID 或用空库“修复”损坏；这可能破坏去重依据。更改上游站点需要人工迁移，已有账本会拒绝悄悄切换 origin。轮换秘密会使原会话失效，且需保留旧密钥用于已创建客户端 Key 的迁移。

## 管理赠金活动

登录云端后台，进入“会员与首次使用赠金”，在“首次使用赠金设置”中调整以下内容并保存：

- **开启新申请赠金**：控制是否接受新的首次赠金申请。关闭后会员仍可登录、查询余额和配置客户端；已有待确认申请仍可核对、重试。
- **每位会员赠送额度（USD）**：范围为 0.01 至 10000 美元，最多两位小数。旧站点升级后的初始值仍为 $10.00。
- **客户端活动说明**：可选，最多 200 字，显示在客户端会员页。留空时由客户端显示默认说明。

设置保存在服务器会员账本中，保存后立即影响新的申请和会员配置接口，无需重新编译客户端。客户端下次刷新会员信息时获取当前设置。页面同时打开在不同窗口时，过期表单会提示设置已被其他管理员修改，并显示最新设置；核对后再保存，避免覆盖他人的调整。

每条申请在创建时锁定赠送金额；更改活动金额或暂停活动不会改变已到账、待确认或待核对申请的金额。最近申请列表显示每条申请的实际金额，累计赠送额度按已到账记录的原金额相加。暂停后重新开启也不会重置会员账户或客户端安装的领取资格。

升级会保留原有账户、安装、兑换码、金额和状态，将旧版固定 $10 的账本约束迁移为以美分保存的金额范围约束；活动设置与预约记录在同一个 SQLite 事务中读取/写入，防止修改设置与领取并发时产生错误金额。不要手动修改账本金额或删除活动设置记录。

## 客户端接口

所有请求均固定访问 `https://yunhui.me/member.php?a=<action>`。`config`、`status` 支持 GET，其他动作要求 POST JSON。响应禁止缓存。错误为 `{ok:false,code,error}`，不透传上游原始报错。

除 `config` 外，客户端发送：

```text
X-Aurora-Installation: 本机随机 UUID
X-Aurora-Installation-Proof: 本机随机 32 字节的小写 hex（64 字符）
Authorization: Bearer 本服务 sessionToken（登录后）
```

安装秘密和会话令牌保存在操作系统安全存储中，不进入供应商导出或通用配置备份。登录密码仅用于即时登录，不落盘。服务端使用 AES-256-GCM 保存上游访问令牌和平台提供的刷新令牌，分别记录访问令牌与安装会话的有效期；刷新成功后延长安装会话，最长保留至该次刷新后 30 天。上游凭据撤销、失效或长期未使用后仍需重新登录。

客户端启动后约 5 秒、运行期间每 15 分钟，在已有加密登录和安装凭据时后台检查并按需续期；临时网络失败保留凭据，下次维护重试。服务端对同一会话的令牌轮换串行处理，新令牌先持久化，再核对原会员身份；没有验证成功前不处理分组、密钥或赠金操作。退出或切换账号不能被迟到请求恢复。刷新令牌不会发给客户端界面。旧会话因未保存刷新令牌，需要通过账号重新登录一次；手动绑定的访问令牌按自身有效期使用，不能自动续期。

| action | JSON 参数 | 返回或效果 |
| --- | --- | --- |
| `config` | 无 | `enabled,giftEnabled,giftUsd,giftMessage,giftPolicyRevision,currency:'USD',accountUrl,campaign`；`enabled` 为会员服务状态，`giftEnabled` 单独控制新赠金申请 |
| `login` | `email,password` | 会话结果；需要双因素时返回 `requires2fa:true,tempToken,emailMasked` |
| `login2fa` | `tempToken,totpCode` | 六位动态验证码校验后返回会话结果 |
| `bind` | `accessToken` | 从会员站点获得的用户访问 JWT，由服务端 `/auth/me` 验证 |
| `status` | 无 | `member,gift,expiresAt`，不返回密钥 |
| `claim` | 无 | 按服务器当前活动金额预约首次申请，自动核销并确认凭据；已有申请始终使用原金额 |
| `groups` | 无 | `groups:[{id,name,platform,rateMultiplier}]` 当前用户可用的模型分组 |
| `create-client-key` | `groupId` | 用户显式操作后返回其本人的 `apiKey,id,memberId,name,group,baseUrl,format` |
| `logout` | 无 | 删除安装会话，并尽力撤销对应上游刷新凭据；网络失败不恢复已退出的本地登录 |

注册、密码恢复、站点风控验证码通过 `accountUrl` 完成。`login` 支持转交 `turnstile_token`、`tencent_captcha_ticket`、`tencent_captcha_randstr`，不绕过上游风控。

成功登录返回示例（活动金额设为 $10 时）：

```json
{
  "ok": true,
  "sessionToken": "仅示意，真实值为随机64字符hex",
  "expiresAt": "2026-11-15T12:00:00+00:00",
  "member": { "id": 123, "email": "user@example.com", "username": "云汇会员", "balance": 10 },
  "gift": { "status": "eligible", "amountUsd": 10, "currency": "USD", "campaign": "aurora-first-member-v1" }
}
```

`gift.status` 为 `eligible`、`disabled`、`pending`、`claimed`、`ineligible` 或 `review`。`disabled` 表示活动暂停且该账户尚未预约赠金；已有申请仍返回原状态和金额。仅 `claimed` 返回已核销 `code`、`claimedAt`；兑换码已入账，不能再转赠使用。服务器不接受 `userId/user_id/amount/amountUsd/value/code/origin/adminKey` 等客户端自报的权威字段。

`create-client-key` 用已验证用户自己的 JWT 调用 sub2api `/api/v1/keys`，不是管理员代其他用户生成 Key。先读取用户可用分组，使用固定名称 `yunhui.me 客户端` 和与账户/安装/分组绑定的稳定 Key，在返回丢失后仍能核对复用。完整 Key 只在用户明确要求添加供应商的操作响应中返回，不进入状态页或管理员列表。桌面按 `memberId + group.id` 分开保存供应商，切换会员不会混合两位会员的密钥轮询池。

## 赠金一致性与恢复

1. 服务端验证 `/api/v1/auth/me`，重新确认账户处于 active；账户 ID 只取该结果。
2. SQLite `BEGIN IMMEDIATE` 在同一事务内读取活动开关、金额并预约账户/安装唯一记录；新申请只在活动开启时建立。原金额以整数美分保存，兑换码落盘提交后才调用外部接口。兑换码使用 `YQW-` 加 28 位 HMAC 十六进制摘要，共 32 字符；必须遵守 Sub2API 数据模型和数据库的 32 字符限制，不能仅按 HTTP 参数校验允许的 128 字符生成。
3. 先通过 `/api/v1/admin/redeem-codes?search=<code>` 查找完全相同的已核销凭据；未核销则调用 `/api/v1/admin/redeem-codes/create-and-redeem`，携带固定 code、`type:balance`、原申请金额对应的 `value`、`user_id` 和稳定 `Idempotency-Key`。
4. 核对凭据 code/type/value/used_by/status/id，只有全部一致才标记 claimed。错误金额/账户或未知凭据转为 review，不报告成功。
5. 网络超时保留 pending，重试使用原兑换码。即使上游幂等缓存过期，固定码唯一性与已核销状态仍防止重复入账；上游成功、本地响应丢失可通过 GET 核对完成。
6. 管理页面“核对到账”只读上游凭据并修正本地状态；“重试原申请”只处理已有 pending 记录，不接受新金额、新账户或新兑换码，活动暂停时也可继续处理。review 只允许核对，不允许盲目再次发放。活动设置通过独立的 `save-policy` 动作保存，沿用管理员登录、CSRF 和版本冲突检查，不需要会员 ID。

客户端领取报错后自动重新读取状态，不自动再次发起领取。服务端记录为 pending 时显示“到账确认中”，用户可点击“重新确认到账”；状态读取也失败时暂停领取，直到重新确认资格。服务分组加载错误单独显示，已确认的到账凭据不会被分组错误覆盖。会员会话过期时清除登录状态，包括代理返回非 JSON 的 HTTP 401；退出成功立即清除账号显示。请求绑定会话版本，旧账号的迟到响应不能清除新登录或返回旧身份。

旧版生成的 75 字符兑换码无法通过 Sub2API 的持久层校验。恢复时必须先精确查找旧码：已有已核销凭据则核对原金额和领取人；只有仍为 pending、旧码符合原生成规则且上游确认无记录时，才把本地预约更新为 32 字符短码。保留原账户、安装和资格约束，不删除申请、不重新初始化账本；claimed 和 review 记录不自动改码。部署前备份账本，替换后等待旧版本进行中的领取请求结束，再恢复原申请。

2026-11-15 已部署此修复并核对原失败申请的 $10 已核销凭据。验证包含 Windows/Linux PHP 各 29 项、桌面会员 15 项及会员界面 8 项，详见[修复验收记录](MEMBERSHIP-REPAIR-VALIDATION.json)。平台实时余额还会受到同期消费影响，不能以界面余额的净差额替代核销凭据。

接口参考（2026-11-15 检查的 upstream main，未拷贝其实现代码）：

- [sub2api 兑换码处理](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/handler/admin/redeem_handler.go)
- [sub2api 用户认证](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/handler/auth_handler.go)
- [sub2api 用户 API Key](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/handler/api_key_handler.go)
- [sub2api 管理员幂等规则](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/handler/admin/idempotency_helper.go)

同一服务端密钥可用于只读的[模型目录定时同步](CATALOG_SYNC.md)，但不向公开目录暴露该密钥。

生产站点若未升级到支持固定码 create-and-redeem 的 sub2api 版本，应保持会员赠金关闭。不得回退为每次调用随机 generate 或任意余额增加接口。
