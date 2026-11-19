# 云汇模型目录自动同步

后台侧栏的「模型自动同步」读取云汇 sub2api 的活动分组和模型候选列表。完整候选与精选推荐分开：定时任务更新完整目录，管理员按协议选取模型后点击「将所选加入精选」，客户端公开目录才会得到新增推荐。这样不会每日恢复手工删除的模型，也不会把未经验证的所有平台默认模型自动推为推荐。

管理密钥复用会员模块的服务器私密配置（见 [MEMBERSHIP.md](MEMBERSHIP.md)）。只允许服务端配置中的固定 `https://api.yunhui.me`；HTTP 请求不能传入上游 URL 或密钥。上游读取仅使用：

```text
GET /api/v1/admin/groups/all
GET /api/v1/admin/groups/{id}/model-allowlist-candidates
```

分组读取最多 32 组、单组最多 2000 个候选、总计最多 5000 个模型，整轮超时约 112 秒。不会逐页遍历供应商账户，不发起模型推理。任何分组接口失败或返回异常时，整轮放弃发布新缓存。候选 ID 去重，过滤分组白名单，并拒绝把 `*` 通配符、HTML 或未知对象作为模型 ID 发布。

此上游接口返回「候选」，可能含平台默认模型，不能据此宣称每个用户当前都可调用。最终列表仍由客户端通过用户自己的 API Key 获取。上游私有信息（账号、凭据、利润率、路由映射）不落入目录，只有模型 ID、平台和分组 ID/名称被保存。

## 每日任务

先由管理员手动同步一次，确认接口可用和候选符合站点实际情况。然后为 PHP 网站用户配置 cron，例如网站 PHP 用户为 `www` 时使用该用户的 crontab：

```cron
17 4 * * * /www/server/php/82/bin/php /www/wwwroot/yunhui.me/catalog_sync.php >> /www/aurora-data/catalog-sync.log 2>&1
```

默认 PHP CLI 可能是 7.4，必须使用网站对应的 PHP 8.1+ 路径。任务成功只输出同步数量/时间，不输出密钥。内部 `catalog-sync.lock` 防止任务重叠，Web 管理员写入与 CLI 合并共用 `catalog-write.lock`，网络读取期间不占用目录写锁。

`/www/aurora-data/catalog-sync-state.json` 包含完整候选缓存、最近成功时间、最近错误代码、最多 50 条审计记录，以及手工删除推荐的抑制记录。缓存与成功状态通过同一次原子重命名提交；失败保留之前缓存和成功时间。精选目录中的名称、定价、能力、启用状态与其他厂商记录不被自动覆盖，新增 ID 没有猜测价格或上下文大小。

后台 API 沿用管理员会话与 CSRF：

| 动作 | 方法 | 参数 |
| --- | --- | --- |
| `catalog.sync.status` | GET | 无 |
| `catalog.sync.run` | POST | `{}` |
| `catalog.sync.select` | POST | `providerKey,ids:string[]`，最多100个，与目标供应商协议匹配 |

仅 `baseUrl` 主机为 `api.yunhui.me` 的供应商允许加入精选。DeepSeek/Grok 分组映射到 `openai-chat`，OpenAI 到 Responses/Chat，Anthropic/Gemini 使用各自协议。未知平台仍可查看，禁止未经验证的一键接入。

离线测试：`php scripts/test-catalog-sync.php`，覆盖缓存保留、白名单、手工字段和下架状态、协议限制、管理员在同步期间修改目录、删除抑制和运行锁。测试不需要生产管理密钥。
