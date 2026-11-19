<?php
/**
 * 管理 API。所有写操作要求登录 + CSRF。
 * 调用方式：POST /api.php?a=动作名   （body 为 JSON）
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

// The administration API is same-origin only. Public catalog CORS lives in pub.php.
if (!empty($_SERVER['HTTP_ORIGIN'])) {
    $originHost = parse_url((string)$_SERVER['HTTP_ORIGIN'], PHP_URL_HOST);
    $requestHost = parse_url('http://' . ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST);
    if (!$originHost || strcasecmp($originHost, (string)$requestHost) !== 0) {
        json_out(['error' => '不允许的来源地址'], 403);
    }
}
boot_session();
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
set_exception_handler(function (Throwable $error): void {
    json_out(['error' => $error instanceof InvalidArgumentException ? $error->getMessage() : '操作失败，请检查服务器日志'], $error instanceof InvalidArgumentException ? 400 : 500);
});

$action = $_GET['a'] ?? ($_GET['action'] ?? '');
$document = null;
$body = body_json($document);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$readActions = ['whoami', 'catalog.get', 'analytics.get', 'catalog.sync.status'];
if (!in_array($action, $readActions, true) && $method !== 'POST') {
    header('Allow: POST');
    json_out(['error' => '写操作必须使用 POST'], 405);
}

/* ------------------------------ 登录 ------------------------------ */

if ($action === 'login') {
    $pass = (string)($body['password'] ?? '');
    $cfg = config();
    $attempt = admin_login_attempt($pass, $cfg['passwordHash'], (string)($_SERVER['REMOTE_ADDR'] ?? '0'));
    if ($attempt['retryAfter'] > 0) {
        header('Retry-After: ' . $attempt['retryAfter']);
        json_out(['error' => '尝试太频繁，请 ' . $attempt['retryAfter'] . ' 秒后再试'], 429);
    }
    if (!$attempt['accepted']) json_out(['error' => '密码不正确'], 401);
    session_regenerate_id(true);
    $_SESSION['aurora_admin'] = true;
    $_SESSION['loginAt'] = time();
    json_out(['ok' => true, 'csrf' => csrf_token()]);
}

if ($action === 'logout') {
    require_login();
    check_csrf();
    $_SESSION = [];
    session_destroy();
    json_out(['ok' => true]);
}

if ($action === 'whoami') {
    json_out(['ok' => true, 'loggedIn' => is_logged_in(), 'csrf' => csrf_token()]);
}

/* ------------------------------ 以下都需要登录 ------------------------------ */

require_login();
if ($method !== 'GET') {
    check_csrf();
}

// Stable file lock shared with daily model discovery and curated selection.
// Keep it across the complete read/modify/write sequence, not only the final rename.
$catalogLock = null;
if (in_array($action, ['provider.save', 'provider.delete', 'provider.toggle', 'provider.bulkAdd', 'catalog.import'], true)) {
    $catalogLock = fopen(data_path('catalog-write.lock'), 'c');
    if (!$catalogLock || !flock($catalogLock, LOCK_EX)) json_out(['error' => '供应商目录正在更新，请稍后重试'], 503);
}

switch ($action) {
    case 'catalog.sync.status':
    case 'catalog.sync.run':
    case 'catalog.sync.select': {
        require_once __DIR__ . '/catalog_sync.php';
        try {
            $sync = new CatalogSyncService(MemberService::environment(), AURORA_DATA_DIR);
            if ($action === 'catalog.sync.status') json_out($sync->status());
            if ($action === 'catalog.sync.run') json_out($sync->sync('administrator'));
            json_out($sync->addSelected((string)($body['providerKey'] ?? ''), (array)($body['ids'] ?? [])));
        } catch (MemberError $error) { json_out(['ok' => false, 'code' => $error->errorCode, 'error' => $error->getMessage()], $error->httpStatus); }
    }
    /* ---------- 目录 ---------- */
    case 'catalog.get': {
        $c = catalog();
        $cfg = config();
        json_out([
            'ok' => true,
            'catalog' => $c,
            'update' => $cfg['update'],
            'stats' => $cfg['stats'] ?? [],
            'siteName' => $cfg['siteName'] ?? '云汇AI 工具箱 云端目录',
            'publicUrl' => (isset($_SERVER['HTTPS']) ? 'https://' : 'http://') . ($_SERVER['HTTP_HOST'] ?? ''),
        ]);
    }

    case 'provider.save': {
        $p = normalize_provider($body);
        $c = catalog();
        $found = false;
        foreach ($c['providers'] as $i => $old) {
            if (($old['key'] ?? '') === $p['key']) {
                $c['providers'][$i] = $p;
                $found = true;
                break;
            }
        }
        if (!$found) {
            $p['createdAt'] = now();
            array_unshift($c['providers'], $p);
        }
        // 按 sort 排，同序按名字
        usort($c['providers'], function ($a, $b) {
            $s = ((int)($a['sort'] ?? 100)) <=> ((int)($b['sort'] ?? 100));
            return $s !== 0 ? $s : strcmp((string)($a['name'] ?? ''), (string)($b['name'] ?? ''));
        });
        save_catalog($c);
        json_out(['ok' => true, 'provider' => $p, 'version' => $c['version']]);
    }

    case 'provider.delete': {
        $keys = (array)($body['keys'] ?? [$body['key'] ?? '']);
        $keys = array_values(array_filter(array_map('strval', $keys)));
        $c = catalog();
        $before = count($c['providers']);
        $c['providers'] = array_values(array_filter($c['providers'], function ($p) use ($keys) {
            return !in_array((string)($p['key'] ?? ''), $keys, true);
        }));
        save_catalog($c);
        json_out(['ok' => true, 'deleted' => $before - count($c['providers']), 'version' => $c['version']]);
    }

    case 'provider.toggle': {
        $keys = array_values(array_filter(array_map('strval', (array)($body['keys'] ?? [$body['key'] ?? '']))));
        $enabled = (bool)($body['enabled'] ?? true);
        $c = catalog();
        foreach ($c['providers'] as $i => $p) {
            if (in_array((string)($p['key'] ?? ''), $keys, true)) {
                $c['providers'][$i]['enabled'] = $enabled;
            }
        }
        save_catalog($c);
        json_out(['ok' => true, 'version' => $c['version']]);
    }

    case 'provider.bulkAdd': {
        $list = $body['providers'] ?? [];
        if (!is_array($list)) {
            json_out(['error' => 'providers 必须是数组'], 400);
        }
        $c = catalog();
        $byKey = [];
        foreach ($c['providers'] as $i => $p) {
            $byKey[(string)($p['key'] ?? '')] = $i;
        }
        $added = 0;
        $updated = 0;
        foreach ($list as $raw) {
            if (!is_array($raw)) {
                continue;
            }
            $p = normalize_provider($raw);
            if (isset($byKey[$p['key']])) {
                $c['providers'][$byKey[$p['key']]] = $p;
                $updated++;
            } else {
                $p['createdAt'] = now();
                $c['providers'][] = $p;
                $byKey[$p['key']] = count($c['providers']) - 1;
                $added++;
            }
        }
        save_catalog($c);
        json_out(['ok' => true, 'added' => $added, 'updated' => $updated, 'version' => $c['version']]);
    }

    case 'catalog.import': {
        // 整体替换（导入备份）
        $rawProviders = $document->catalog->providers ?? $document->providers ?? null;
        $incoming = $body['catalog']['providers'] ?? $body['providers'] ?? null;
        if (!is_array($rawProviders) || !is_array($incoming) || !array_is_list($incoming)) {
            json_out(['error' => '格式不正确'], 400);
        }
        $list = [];
        $keys = [];
        foreach ($incoming as $raw) {
            if (!is_array($raw) || array_is_list($raw)) throw new InvalidArgumentException('供应商记录必须为对象，未导入任何数据');
            $provider = normalize_provider($raw);
            if ($provider['key'] === '' || isset($keys[$provider['key']])) throw new InvalidArgumentException('供应商标识缺失或重复，未导入任何数据');
            $keys[$provider['key']] = true;
            $list[] = $provider;
        }
        $c = ['version' => (int)(catalog()['version'] ?? 0), 'updatedAt' => now(), 'providers' => $list];
        save_catalog($c);
        json_out(['ok' => true, 'count' => count($list), 'version' => $c['version']]);
    }

    case 'analytics.get': {
        $a = store_read('analytics.json', ['days' => [], 'clients' => []]);
        json_out(['ok' => true, 'analytics' => analytics_summary($a)]);
    }

    case 'analytics.reset': {
        store_update('analytics.json', static fn(array $previous): array => ['days' => [], 'clients' => []]);
        json_out(['ok' => true]);
    }

    /* ---------- 更新 ---------- */
    case 'update.save': {
        $cfg = config_update(static function (array $cfg) use ($body): array {
            $cfg['update'] = normalize_update($body, (array)($cfg['update'] ?? []));
            return $cfg;
        });
        json_out(['ok' => true, 'update' => $cfg['update']]);
    }

    case 'settings.save': {
        $newPasswordHash = null;
        if (!empty($body['password'])) {
            $pwd = (string)$body['password'];
            if (strlen($pwd) < 8) {
                json_out(['error' => '密码至少 8 位'], 400);
            }
            $newPasswordHash = password_hash($pwd, PASSWORD_DEFAULT);
        }
        config_update(static function (array $cfg) use ($body, $newPasswordHash): array {
            if (!empty($body['siteName'])) $cfg['siteName'] = (string)$body['siteName'];
            if ($newPasswordHash !== null) $cfg['passwordHash'] = $newPasswordHash;
            return $cfg;
        });
        json_out(['ok' => true]);
    }

    case 'stats.reset': {
        config_update(static function (array $cfg): array {
            $cfg['stats'] = ['pings' => 0, 'installs' => 0, 'lastPing' => null];
            return $cfg;
        });
        json_out(['ok' => true]);
    }

    default:
        json_out(['error' => '未知操作: ' . $action], 404);
}


