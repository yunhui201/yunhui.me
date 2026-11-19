<?php
declare(strict_types=1);
require_once __DIR__ . '/lib.php';
require_once __DIR__ . '/member_service.php';
boot_session();
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
if (!is_logged_in()) { header('Location: index.php'); exit; }
$message = '';
$errorMessage = '';
$overview = ['enabled' => false, 'totals' => ['claimed' => 0, 'pending' => 0, 'review' => 0, 'amountUsd' => 0], 'grants' => []];
$policy = null;
$service = null;
try {
    $service = new MemberService(MemberService::environment());
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        check_csrf();
        $action = $_POST['action'] ?? '';
        if ($action === 'save-policy') {
            $enabled = $_POST['enabled'] ?? null;
            $revision = filter_var($_POST['revision'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
            if (($enabled !== null && $enabled !== '1') || $revision === false
                || !is_string($_POST['amountUsd'] ?? null) || !is_string($_POST['message'] ?? null)) {
                throw new MemberError('INVALID_GIFT_POLICY', '赠金设置格式无效，请刷新页面后重试');
            }
            $saved = $service->adminSaveGiftPolicy(['enabled' => $enabled === '1',
                'amountUsd' => $_POST['amountUsd'], 'message' => $_POST['message'], 'revision' => $revision]);
            $message = $saved['enabled']
                ? '赠金设置已保存，新申请按每位 $' . member_money($saved['amountUsd']) . ' 发放。'
                : '赠金活动已暂停。已有申请仍按原金额核对、重试；会员登录和使用不受影响。';
        } elseif (in_array($action, ['reconcile', 'retry'], true)) {
            $userId = filter_var($_POST['userId'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
            if ($userId === false) throw new MemberError('INVALID_ACTION', '会员 ID 无效');
            $result = $service->adminReconcile((int)$userId, $action === 'retry');
            $message = '账户 #' . $userId . ' 的 $' . member_money($result['gift']['amountUsd']) . ' 赠金已根据上游核销凭据确认到账。';
        } else {
            throw new MemberError('INVALID_ACTION', '操作参数无效');
        }
    }
} catch (MemberError $error) {
    http_response_code($error->httpStatus);
    $errorMessage = $error->getMessage();
} catch (Throwable $error) {
    http_response_code(503);
    $errorMessage = '会员存储或配置不可用，请检查 PHP 扩展、配置文件权限与服务器日志。';
    error_log('yunhui.me member administration failure: ' . get_class($error));
}
if ($service !== null) {
    try {
        $overview = $service->adminOverview();
        if ($overview['enabled']) $policy = $service->adminGiftPolicy();
    } catch (Throwable $error) {
        http_response_code(503);
        $errorMessage = '赠金设置或账本暂不可用，请检查服务器配置与日志后重试。';
        error_log('yunhui.me member administration read failure: ' . get_class($error));
    }
}
function member_h($value): string { return htmlspecialchars((string)$value, ENT_QUOTES, 'UTF-8'); }
function member_money($value): string { return number_format((float)$value, 2, '.', ''); }
$labels = ['pending' => '待确认', 'claimed' => '已到账', 'review' => '待核对'];
?>
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>会员与赠金 · 云汇AI</title>
<style>
:root{font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:#233047;background:#f5f7fb;font-size:14px}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1200px;margin:0 auto;padding:36px 28px}a{color:#5265db;text-decoration:none}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:26px;gap:24px}h1{font-size:28px;margin:10px 0}p{line-height:1.8;color:#69758a;margin:0}.tag{border-radius:30px;padding:7px 13px;background:#e7f6ee;color:#24845b;white-space:nowrap}.tag.off{background:#fff0df;color:#a7641b}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0}.card{border:1px solid #e3e8f1;background:white;border-radius:16px;padding:22px;box-shadow:0 4px 16px #273c5d04}.card strong{display:block;font-size:30px;margin-top:8px}.panel{padding:24px;border:1px solid #e3e8f1;border-radius:18px;background:white;margin-top:18px}h2{font-size:17px;margin:0 0 12px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:710px;text-align:left;font-size:13px}th{color:#7b8595;font-weight:500;background:#fafbfe}th,td{padding:15px 12px;border-bottom:1px solid #eef1f6}form{display:inline}button{border:1px solid #dce2f0;border-radius:8px;background:white;color:#4858bb;padding:8px 11px;cursor:pointer;margin:2px}.status{font-weight:600}.claimed{color:#268461}.pending{color:#b07821}.review{color:#bd4b4b}.notice{padding:14px 18px;border-radius:12px;background:#e7f6ee;color:#236e50;margin:16px 0}.error{background:#fff0ee;color:#ab4940}.empty{text-align:center;padding:45px;color:#8892a5}.small{font-size:12px;color:#8a93a4}.footer{padding:18px 2px}@media(max-width:720px){.wrap{padding:20px 16px}.cards{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start;flex-direction:column}.card{padding:16px}.panel{padding:15px}h1{font-size:24px}}
.policy-form{display:block}.policy-grid{display:grid;grid-template-columns:1fr 2fr;gap:18px;margin:18px 0}.policy-form label{display:block;color:#34425b;font-weight:600}.policy-form input[type=number],.policy-form textarea{display:block;width:100%;margin-top:9px;border:1px solid #dce2f0;border-radius:9px;padding:11px 12px;color:#233047;background:#fff;font:inherit}.policy-form textarea{resize:vertical;min-height:88px}.policy-form .toggle{display:flex;align-items:center;gap:9px;font-weight:500}.toggle input{width:17px;height:17px;accent-color:#5265db}.policy-form button{background:#5265db;color:white;border-color:#5265db;padding:10px 18px}.policy-form .small{display:block;line-height:1.7;margin-top:7px}.policy-title{display:flex;align-items:center;gap:15px;margin-bottom:12px}.policy-title h2{margin:0}.policy-title .tag{font-size:12px}.notice[role=alert]{line-height:1.7}@media(max-width:720px){.policy-grid{grid-template-columns:1fr}}
</style></head><body><main class="wrap">
<header><div><a href="index.php">← 返回云端管理</a><h1>会员与首次使用赠金</h1><p>设置新会员体验额度，查看领取记录与到账结果。</p></div><span class="tag <?= $overview['enabled'] ? '' : 'off' ?>"><?= $overview['enabled'] ? '会员服务已启用' : '会员服务未就绪' ?></span></header>
<?php if ($message): ?><div class="notice"><?= member_h($message) ?></div><?php endif; ?>
<?php if ($errorMessage): ?><div class="notice error" role="alert"><?= member_h($errorMessage) ?></div><?php endif; ?>
<section class="panel" aria-labelledby="gift-policy-title"><div class="policy-title"><h2 id="gift-policy-title">首次使用赠金设置</h2><?php if ($policy !== null): ?><span class="tag <?= $policy['enabled'] ? '' : 'off' ?>"><?= $policy['enabled'] ? '活动开启' : '活动暂停' ?></span><?php endif; ?></div>
<?php if ($policy !== null): ?>
<form method="post" class="policy-form" id="gift-policy-form"><input type="hidden" name="_csrf" value="<?= member_h(csrf_token()) ?>"><input type="hidden" name="action" value="save-policy"><input type="hidden" name="revision" value="<?= member_h($policy['revision']) ?>">
<label class="toggle"><input type="checkbox" name="enabled" value="1" <?= $policy['enabled'] ? 'checked' : '' ?>>开启新申请赠金</label>
<div class="policy-grid"><label>每位会员赠送额度（USD）<input type="number" name="amountUsd" min="0.01" max="10000" step="0.01" inputmode="decimal" required value="<?= member_h(member_money($policy['amountUsd'])) ?>"><span class="small">0.01 至 10000 美元，最多两位小数。</span></label><label>客户端活动说明<textarea name="message" maxlength="200" rows="2" placeholder="可选，最多 200 字"><?= member_h($policy['message']) ?></textarea><span class="small">显示在客户端会员页；留空时使用默认说明。</span></label></div>
<button type="submit">保存赠金设置</button><span class="small">保存后对新申请立即生效，无需重新编译客户端。关闭活动只暂停新申请；待确认申请保留原金额，仍可核对和重试。修改金额或重新开启不会重置已领取资格。</span></form>
<?php else: ?><p><?= $overview['enabled'] ? '赠金设置暂不可用，恢复会员存储后可继续管理。' : '会员服务尚未启用，请先完成服务器会员配置后管理赠金。' ?></p><?php endif; ?></section>
<div class="cards"><div class="card">已到账会员<strong><?= member_h($overview['totals']['claimed']) ?></strong></div><div class="card">累计赠送额度<strong>$<?= member_h(member_money($overview['totals']['amountUsd'])) ?></strong></div><div class="card">等待确认<strong><?= member_h($overview['totals']['pending']) ?></strong></div><div class="card">需要核对<strong><?= member_h($overview['totals']['review']) ?></strong></div></div>
<section class="panel"><h2>发放流程</h2><p>登录验证会员身份 → 绑定本机安装 → 按申请时的活动金额生成兑换凭据 → 自动核销到同一会员账户。每个会员账户和每份客户端安装各限一次。</p><p>连接中断时，先用“核对到账”读取上游凭据；尚未到账的申请可用“重试原申请”继续。重试始终使用原有兑换码、原金额和同一账户。</p></section>
<section class="panel"><h2>最近 200 条赠金申请</h2><div class="scroll"><table><thead><tr><th>会员 ID</th><th>状态</th><th>金额（USD）</th><th>申请时间</th><th>上游凭据</th><th>最近结果</th><th>处理</th></tr></thead><tbody>
<?php foreach ($overview['grants'] as $grant): ?><tr><td>#<?= member_h($grant['userId']) ?></td><td class="status <?= member_h($grant['status']) ?>"><?= member_h($labels[$grant['status']] ?? $grant['status']) ?></td><td>$<?= member_h(member_money($grant['amountUsd'])) ?></td><td><?= member_h(date('Y-m-d H:i:s', (int)$grant['createdAt'])) ?></td><td><?= $grant['upstreamId'] ? '#' . member_h($grant['upstreamId']) : '—' ?></td><td class="small"><?= member_h($grant['lastError'] ?: '—') ?></td><td>
<?php if ($grant['status'] !== 'claimed'): ?><form method="post"><input type="hidden" name="_csrf" value="<?= member_h(csrf_token()) ?>"><input type="hidden" name="userId" value="<?= member_h($grant['userId']) ?>"><button name="action" value="reconcile">核对到账</button><?php if ($grant['status'] === 'pending'): ?><button name="action" value="retry">重试原申请</button><?php endif; ?></form><?php else: ?><span class="small"><?= member_h(date('m-d H:i', (int)$grant['claimedAt'])) ?> 已确认</span><?php endif; ?>
</td></tr><?php endforeach; ?>
<?php if (!$overview['grants']): ?><tr><td colspan="7" class="empty">暂无赠金申请。会员首次在客户端领取后会显示在这里。</td></tr><?php endif; ?>
</tbody></table></div></section><p class="footer small">余额和最终核销结果以云汇会员站点为准。此页面不会显示管理员密钥、登录令牌或客户 API Key。</p>
</main><footer style="text-align:center;padding:20px;color:#7b8595;font-size:12px"><a href="https://github.com/yunhui201/yunhui.me/tree/main" target="_blank" rel="noopener noreferrer">yunhui.me · 项目源码</a> · <a href="https://github.com/yunhui201/yunhui.me/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">AGPL-3.0 许可</a></footer>
</body></html>
