<?php
/**
 * 客户端公开接口（无需登录，带 CORS + ETag）
 *
 *  GET  ?action=catalog              供应商目录
 *  GET  ?action=update&platform=win&arch=x64&current=0.1.0
 *  POST ?action=ping                 安装量统计（匿名）
 *  GET  ?action=stats                公开统计（给首页用）
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';
set_exception_handler(function (Throwable $error): void {
    error_log('yunhui.me public service failure: ' . get_class($error));
    header('Cache-Control: no-store');
    json_out(['error' => '服务暂不可用，请稍后重试'], 503);
});

cors();

$action = $_GET['action'] ?? 'catalog';

switch ($action) {
    case 'catalog': {
        track('catalog');
        $c = catalog();
        $etag = '"c' . ($c['version'] ?? 0) . '"';
        header('ETag: ' . $etag);
        header('Cache-Control: public, max-age=60');
        header('X-Aurora-Version: ' . ($c['version'] ?? 0));
        if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
            http_response_code(304);
            exit;
        }
        // 只发启用的
        $out = [
            'version' => $c['version'] ?? 0,
            'updatedAt' => $c['updatedAt'] ?? now(),
            'providers' => array_values(array_map(function ($p) {
                // Catalogs are public metadata, never a transport for provider keys or arbitrary fields.
                $allowed = ['key', 'name', 'vendor', 'format', 'baseUrl', 'customBaseUrl', 'region', 'color', 'icon', 'docs', 'note', 'tags', 'official', 'sort', 'updatedAt'];
                $out = array_intersect_key($p, array_flip($allowed));
                $out['models'] = array_map(function ($m) {
                    $model = array_intersect_key($m, array_flip(['id', 'displayName', 'contextWindow', 'inputPrice', 'outputPrice', 'maxOutput', 'cacheReadPrice', 'cacheWritePrice']));
                    $model['capabilities'] = array_intersect_key((array)($m['capabilities'] ?? []), array_flip(['tools', 'vision', 'thinking']));
                    return $model;
                }, array_values(array_filter((array)($p['models'] ?? []), 'is_array')));
                return $out;
            }, array_filter($c['providers'] ?? [], function ($p) {
                return !empty($p['enabled']);
            }))),
        ];
        json_out($out);
    }

    case 'update': {
        $cfg = config();
        $platform = preg_replace('/[^a-z0-9-]/i', '', (string)($_GET['platform'] ?? 'win'));
        $arch = preg_replace('/[^a-z0-9-]/i', '', (string)($_GET['arch'] ?? 'x64'));
        $current = (string)($_GET['current'] ?? '0.0.0');
        track('update', ['version' => $current, 'platform' => $platform, 'arch' => $arch]);
        $u = $cfg['update'] ?? [];
        $files = (array)($u['files'] ?? []);
        $key = $platform . '-' . $arch;
        $fileKey = isset($files[$key]) ? $key : $platform;
        $url = $files[$fileKey] ?? '';
        $version = (string)($u['version'] ?? '');
        $hasUpdate = $version !== '' && $url !== '' && version_compare($version, $current, '>');
        json_out([
            'version' => $version,
            'notes' => $u['notes'] ?? '',
            'mandatory' => (bool)($u['mandatory'] ?? false),
            'hasUpdate' => $hasUpdate,
            'platform' => $platform,
            'arch' => $arch,
            'url' => $url,
            'sha256' => (string)($u['sha256'][$fileKey] ?? ''),
            'publishedAt' => $u['publishedAt'] ?? null,
        ]);
    }

    case 'ping': {
        track('ping');
        config_update(static function (array $cfg): array {
            $stats = $cfg['stats'] ?? ['pings' => 0, 'installs' => 0];
            $stats['pings'] = (int)($stats['pings'] ?? 0) + 1;
            $cfg['stats'] = $stats;
            return $cfg;
        });
        json_out(['ok' => true]);
    }

    case 'stats': {
        $cfg = config();
        $c = catalog();
        $models = 0;
        foreach ($c['providers'] ?? [] as $p) {
            $models += count($p['models'] ?? []);
        }
        json_out([
            'providers' => count($c['providers'] ?? []),
            'enabled' => count(array_filter($c['providers'] ?? [], fn($p) => !empty($p['enabled']))),
            'models' => $models,
            'version' => $c['version'] ?? 0,
            'updatedAt' => $c['updatedAt'] ?? null,
            'appVersion' => ($cfg['update']['version'] ?? '') !== '' ? $cfg['update']['version'] : null,
        ]);
    }

    default:
        json_out(['error' => '未知操作'], 404);
}

