<?php
/**
 * 云汇AI 工具箱 · 云端目录后台
 * 公共库：存储、鉴权、响应、CORS
 *
 * 这个目录要放在网站根目录之外，或者配合 nginx 的 deny 规则。
 */
declare(strict_types=1);

const AURORA_DATA_DIR = '/www/aurora-data';
const AURORA_VERSION = '1.0.0';
const ADMIN_SESSION_LIFETIME = 43200;

function data_path(string $name): string
{
    if (!is_dir(AURORA_DATA_DIR)) {
        @mkdir(AURORA_DATA_DIR, 0700, true);
    }
    return AURORA_DATA_DIR . '/' . $name;
}

/** 读 JSON 文件，失败返回默认值 */
function store_read(string $name, array $default = []): array
{
    $f = data_path($name);
    if (!is_file($f)) {
        return $default;
    }
    $raw = @file_get_contents($f);
    if ($raw === false || $raw === '') {
        return $default;
    }
    $j = json_decode($raw, true);
    return is_array($j) ? $j : $default;
}

/** Authoritative configuration must never turn an unreadable/corrupt file into an empty store. */
function store_read_strict(string $name, array $default = []): array
{
    $file = data_path($name);
    if (!file_exists($file)) return $default;
    $raw = @file_get_contents($file);
    if ($raw === false || trim($raw) === '') throw new RuntimeException('配置文件无法读取，请恢复备份后重试');
    try { $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR); }
    catch (JsonException $error) { throw new RuntimeException('配置文件损坏，已停止写入，请恢复备份'); }
    if (!is_array($data) || array_is_list($data)) throw new RuntimeException('配置文件结构无效，已停止写入');
    return $data;
}

/** 原子写：先写临时文件再 rename，带 flock */
function store_write(string $name, array $data): bool
{
    $f = data_path($name);
    $tmp = $f . '.tmp' . getmypid();
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) {
        return false;
    }
    if (@file_put_contents($tmp, $json, LOCK_EX) !== strlen($json)) {
        @unlink($tmp);
        return false;
    }
    if (!@rename($tmp, $f)) {
        @unlink($tmp);
        return false;
    }
    @chmod($f, 0600);
    return true;
}

/** Internal: caller holds the stable configuration lock for initialization/read/modify/write. */
function config_read_locked(): array
{
    $exists = file_exists(data_path('config.json')) || is_link(data_path('config.json'));
    $cfg = store_read_strict('config.json', []);
    if ($exists && (!is_string($cfg['passwordHash'] ?? null) || $cfg['passwordHash'] === '')) {
        throw new RuntimeException('后台密码配置缺失或损坏，请恢复备份，不能重新初始化');
    }
    if (!$exists) {
        // Existing installs keep their password. Fresh installs have no shared default credential.
        $initialPassword = getenv('AURORA_ADMIN_PASSWORD');
        if (!$initialPassword || strlen($initialPassword) < 12) {
            $initialPassword = bin2hex(random_bytes(18));
            $initialFile = data_path('initial-admin-password.txt');
            if (@file_put_contents($initialFile, $initialPassword . PHP_EOL, LOCK_EX) === false) {
                throw new RuntimeException('Cannot initialize administration credentials');
            }
            @chmod($initialFile, 0600);
        }
        $cfg['passwordHash'] = password_hash($initialPassword, PASSWORD_DEFAULT);
        $cfg['siteName'] = '云汇AI 工具箱 云端目录';
        $cfg['update'] = [
            'version' => '',
            'notes' => '',
            'mandatory' => false,
            'files' => new stdClass(),
        ];
        $cfg['stats'] = ['pings' => 0, 'installs' => 0, 'lastPing' => null];
        $cfg['createdAt'] = date('c');
        if (!store_write('config.json', $cfg)) throw new RuntimeException('无法保存后台初始配置');
    }
    return $cfg;
}

function config_locked(callable $operation): array
{
    $lock = @fopen(data_path('config-write.lock'), 'c');
    if (!$lock || !flock($lock, LOCK_EX)) {
        if ($lock) fclose($lock);
        throw new RuntimeException('后台配置暂不可用，请稍后重试');
    }
    try { return $operation(); }
    finally { flock($lock, LOCK_UN); fclose($lock); }
}

function config(): array
{
    return config_locked(static fn(): array => config_read_locked());
}

/** The callback sees fresh data under the same lock used by every configuration writer. */
function config_update(callable $change): array
{
    return config_locked(static function () use ($change): array {
        $next = $change(config_read_locked());
        if (!is_array($next)) throw new RuntimeException('后台配置更新结果无效');
        if (!store_write('config.json', $next)) throw new RuntimeException('后台配置保存失败');
        return $next;
    });
}

function catalog(): array
{
    $c = store_read_strict('catalog.json', [
        'version' => 0,
        'updatedAt' => date('c'),
        'providers' => [],
    ]);
    if (!isset($c['providers']) || !is_array($c['providers'])) {
        throw new RuntimeException('供应商目录结构无效，已停止写入');
    }
    return $c;
}

function save_catalog(array &$c): void
{
    $next = $c;
    $next['version'] = (int)($c['version'] ?? 0) + 1;
    $next['updatedAt'] = date('c');
    if (!store_write('catalog.json', $next)) throw new RuntimeException('供应商目录保存失败');
    $c = $next;
}

/** Keep checksums when editing release notes; never carry a previous build hash to a changed URL/version. */
function normalize_update(array $body, array $previous): array
{
    $version = trim((string)($body['version'] ?? $previous['version'] ?? ''));
    if ($version === '') throw new InvalidArgumentException('请填写实际发布的版本号');
    $previousFiles = (array)($previous['files'] ?? []);
    $files = (array)($body['files'] ?? $previous['files'] ?? []);
    foreach ($files as $platform => $url) {
        if (!preg_match('/^[a-zA-Z0-9-]+$/D', (string)$platform) || !is_string($url)) throw new InvalidArgumentException('安装包平台或下载地址无效');
        if ($url === '') continue;
        $parts = parse_url($url);
        if (!$parts || !in_array($parts['scheme'] ?? '', ['https', 'http'], true) || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) throw new InvalidArgumentException('安装包下载地址必须为 HTTP(S) URL');
    }
    $hashes = [];
    if ($version === (string)($previous['version'] ?? '')) {
        foreach ((array)($previous['sha256'] ?? []) as $platform => $hash) {
            if (isset($files[$platform]) && $files[$platform] === ($previousFiles[$platform] ?? null) && is_string($hash) && preg_match('/^[a-fA-F0-9]{64}$/D', $hash)) $hashes[$platform] = strtolower($hash);
        }
    }
    if (array_key_exists('sha256', $body)) {
        if (!is_array($body['sha256'])) throw new InvalidArgumentException('安装包 SHA256 格式无效');
        foreach ($body['sha256'] as $platform => $hash) {
            if (!isset($files[$platform]) || !is_string($hash) || !preg_match('/^[a-fA-F0-9]{64}$/D', $hash)) throw new InvalidArgumentException('安装包 SHA256 必须为64位十六进制且匹配下载平台');
            $hashes[$platform] = strtolower($hash);
        }
    }
    return array_merge($previous, ['version' => $version, 'notes' => (string)($body['notes'] ?? $previous['notes'] ?? ''),
        'mandatory' => (bool)($body['mandatory'] ?? $previous['mandatory'] ?? false), 'files' => (object)$files,
        'sha256' => (object)$hashes, 'publishedAt' => now()]);
}

/* ------------------------------ 会话与鉴权 ------------------------------ */

/** Failed attempts and password verification share one IP lock, including concurrent sessions. */
function admin_login_attempt(string $password, string $passwordHash, string $address): array
{
    $name = 'fail_' . md5($address) . '.json';
    $lock = @fopen(data_path($name . '.lock'), 'c');
    if (!$lock || !flock($lock, LOCK_EX)) {
        if ($lock) fclose($lock);
        throw new RuntimeException('登录验证暂不可用');
    }
    try {
        $failure = store_read_strict($name, ['n' => 0, 'until' => 0]);
        $remaining = (int)($failure['until'] ?? 0) - time();
        if ($remaining > 0) return ['accepted' => false, 'retryAfter' => $remaining];
        $accepted = password_verify($password, $passwordHash);
        if ($accepted) $failure = ['n' => 0, 'until' => 0];
        else {
            $failure['n'] = (int)($failure['n'] ?? 0) + 1;
            if ($failure['n'] >= 5) $failure = ['n' => 0, 'until' => time() + 300];
        }
        if (!store_write($name, $failure)) throw new RuntimeException('无法保存登录验证状态');
        return ['accepted' => $accepted, 'retryAfter' => 0];
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}

function boot_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    // A shared PHP session directory can be collected by another site's 24-minute
    // default. Keep our sessions private and align storage with the login limit.
    $directory = data_path('admin-sessions');
    if (is_link($directory) || (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory))) {
        throw new RuntimeException('无法初始化管理登录存储');
    }
    @chmod($directory, 0700);
    if (!is_writable($directory)) throw new RuntimeException('管理登录存储不可写');
    session_save_path($directory);
    ini_set('session.gc_maxlifetime', (string)ADMIN_SESSION_LIFETIME);
    // System cron jobs often clean only PHP's shared directory, with PHP GC off.
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '100');
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_set_cookie_params([
        'lifetime' => ADMIN_SESSION_LIFETIME,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => !empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off',
    ]);
    session_name('aurora_sid');
    if (!session_start()) throw new RuntimeException('无法读取管理登录状态');
}

function is_logged_in(): bool
{
    boot_session();
    return !empty($_SESSION['aurora_admin']) && (int)($_SESSION['loginAt'] ?? 0) > time() - ADMIN_SESSION_LIFETIME;
}

function require_login(): void
{
    if (!is_logged_in()) {
        json_out(['error' => '未登录', 'needLogin' => true], 401);
    }
}

function csrf_token(): string
{
    boot_session();
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(16));
    }
    return $_SESSION['csrf'];
}

function check_csrf(): void
{
    boot_session();
    $sent = $_SERVER['HTTP_X_CSRF'] ?? ($_POST['_csrf'] ?? '');
    if (empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], (string)$sent)) {
        json_out(['error' => 'CSRF 校验失败，请刷新页面'], 419);
    }
}

/* ------------------------------ 输出 ------------------------------ */

function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function cors(): void
{
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Headers: Content-Type, X-CSRF, Authorization');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Max-Age: 86400');
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function body_json(?stdClass &$document = null): array
{
    $raw = file_get_contents('php://input', false, null, 0, 4194305);
    if ($raw === false || strlen($raw) > 4194304) json_out(['error' => '请求内容超过4MB限制'], 413);
    if ($raw === '') return [];
    try {
        $decoded = json_decode($raw, false, 64, JSON_THROW_ON_ERROR);
        if (!$decoded instanceof stdClass) throw new InvalidArgumentException('请求内容必须是 JSON 对象');
        $document = $decoded;
        return json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) { throw new InvalidArgumentException('请求 JSON 格式无效'); }
}

function now(): string
{
    return date('c');
}

/** 校验并规整一条供应商记录 */
function normalize_provider(array $p): array
{
    $formats = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];
    $regions = ['cn', 'global', 'local', 'relay', 'subscription'];
    $baseUrl = trim((string)($p['baseUrl'] ?? ''));
    $parts = parse_url($baseUrl);
    if (!(($p['customBaseUrl'] ?? false) === true && $baseUrl === '') && (!$parts || !in_array($parts['scheme'] ?? '', ['http', 'https'], true) || empty($parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment']))) {
        throw new InvalidArgumentException('供应商地址必须为不含账号密码的 HTTP(S) 地址');
    }
    if (!empty($p['format']) && !in_array($p['format'], $formats, true)) {
        throw new InvalidArgumentException('不支持的供应商协议');
    }
    $docs = trim((string)($p['docs'] ?? ''));
    if ($docs !== '') {
        $docUrl = parse_url($docs);
        if (!$docUrl || !in_array($docUrl['scheme'] ?? '', ['http', 'https'], true) || empty($docUrl['host']) || isset($docUrl['user']) || isset($docUrl['pass'])) {
            throw new InvalidArgumentException('文档地址必须为 HTTP(S) 地址');
        }
    }
    $models = [];
    $modelIds = [];
    if (!is_array($p['models'] ?? []) || count($p['models'] ?? []) > 10000) throw new InvalidArgumentException('模型列表格式错误或数量过多');
    foreach (($p['models'] ?? []) as $m) {
        if (!is_array($m)) {
            continue;
        }
        $id = trim((string)($m['id'] ?? ''));
        if ($id === '' || strlen($id) > 512 || preg_match('/[\r\n\x00]/', $id)) throw new InvalidArgumentException('模型 ID 无效');
        if (isset($modelIds[$id])) throw new InvalidArgumentException('同一供应商的模型 ID 不能重复');
        $modelIds[$id] = true;
        $model = [
            'id' => $id,
            'displayName' => (string)($m['displayName'] ?? ''),
            'capabilities' => [],
        ];
        foreach (['contextWindow', 'maxOutput', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice'] as $field) {
            if (!isset($m[$field]) || $m[$field] === '') continue;
            if (!is_numeric($m[$field]) || !is_finite((float)$m[$field]) || (float)$m[$field] < 0) throw new InvalidArgumentException('模型价格和容量必须为非负数');
            $model[$field] = in_array($field, ['contextWindow', 'maxOutput'], true) ? (int)$m[$field] : (float)$m[$field];
        }
        foreach (['tools', 'vision', 'thinking'] as $cap) if (isset($m['capabilities'][$cap]) && is_bool($m['capabilities'][$cap])) $model['capabilities'][$cap] = $m['capabilities'][$cap];
        $models[] = $model;
    }
    return [
        'key' => (string)($p['key'] ?? ('p_' . substr(md5((string)($p['name'] ?? '') . microtime()), 0, 10))),
        'name' => trim((string)($p['name'] ?? '未命名')),
        'vendor' => (string)($p['vendor'] ?? ''),
        'format' => in_array($p['format'] ?? '', $formats, true) ? $p['format'] : 'openai-chat',
        'baseUrl' => $baseUrl,
        'customBaseUrl' => ($p['customBaseUrl'] ?? false) === true,
        'region' => in_array($p['region'] ?? '', $regions, true) ? $p['region'] : 'relay',
        'color' => (string)($p['color'] ?? '#6d8cff'),
        'icon' => (string)($p['icon'] ?? '◆'),
        'docs' => $docs,
        'note' => (string)($p['note'] ?? ''),
        'tags' => array_values(array_filter(array_map('strval', (array)($p['tags'] ?? [])))),
        'enabled' => (bool)($p['enabled'] ?? true),
        'official' => (bool)($p['official'] ?? false),
        'sort' => (int)($p['sort'] ?? 100),
        'models' => $models,
        'updatedAt' => now(),
    ];
}



/** 带文件锁的读-改-写：并发埋点不丢数据 */
function store_update(string $name, callable $fn, array $default = []): array
{
    // Lock a stable sibling file: replacing the data file must not change the lock's inode.
    $lock = @fopen(data_path($name . '.lock'), 'c');
    if (!$lock || !flock($lock, LOCK_EX)) {
        if ($lock) fclose($lock);
        throw new RuntimeException('统计存储暂不可用');
    }
    try {
        $data = $fn(store_read($name, $default));
        if (!is_array($data) || !store_write($name, $data)) throw new RuntimeException('统计保存失败');
        return $data;
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}

/* ------------------------------ 访问统计 ------------------------------ */

const ANALYTICS_RETENTION_DAYS = 90;
const ANALYTICS_MAX_IPS = 2000;

function client_ip(): string
{
    $fwd = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if ($fwd) {
        $first = trim(explode(',', $fwd)[0]);
        if ($first !== '') {
            return $first;
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

function short_ua(): string
{
    $ua = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');
    $ua = preg_replace('/\s+/', ' ', trim($ua));
    return mb_substr($ua === '' ? 'unknown' : $ua, 0, 120);
}

/**
 * 记录一次公开接口访问。
 * $kind: catalog | update | ping
 * $extra: ['version' => '0.2.3', 'platform' => 'win', 'arch' => 'x64']
 */
function track(string $kind, array $extra = []): void
{
    $today = date('Y-m-d');
    $ip = client_ip();
    $ua = short_ua();

    try { store_update('analytics.json', function (array $a) use ($kind, $extra, $today, $ip, $ua) {
        $a['days'] = $a['days'] ?? [];
        $d = $a['days'][$today] ?? ['catalog' => 0, 'update' => 0, 'ping' => 0, 'ips' => [], 'versions' => [], 'platforms' => []];
        $d[$kind] = (int)($d[$kind] ?? 0) + 1;
        $d['ips'] = $d['ips'] ?? [];
        $d['ips'][$ip] = (int)($d['ips'][$ip] ?? 0) + 1;
        if (isset($extra['version']) && $extra['version'] !== '') {
            $v = (string)$extra['version'];
            $d['versions'] = $d['versions'] ?? [];
            $d['versions'][$v] = (int)($d['versions'][$v] ?? 0) + 1;
        }
        if (isset($extra['platform'])) {
            $p = (string)$extra['platform'];
            $d['platforms'] = $d['platforms'] ?? [];
            $d['platforms'][$p] = (int)($d['platforms'][$p] ?? 0) + 1;
        }
        $a['days'][$today] = $d;

        // 客户端档案
        $a['clients'] = $a['clients'] ?? [];
        $c = $a['clients'][$ip] ?? ['first' => date('c'), 'last' => date('c'), 'count' => 0, 'ua' => $ua, 'version' => ''];
        $c['last'] = date('c');
        $c['count'] = (int)($c['count'] ?? 0) + 1;
        $c['ua'] = $ua ?: ($c['ua'] ?? '');
        if (!empty($extra['version'])) {
            $c['version'] = (string)$extra['version'];
        }
        if (!empty($extra['platform'])) {
            $c['platform'] = (string)$extra['platform'];
        }
        $a['clients'][$ip] = $c;

        // 控制体量：IP 表按最后活跃时间保留前 N 个
        if (count($a['clients']) > ANALYTICS_MAX_IPS) {
            uasort($a['clients'], fn($x, $y) => strcmp((string)($y['last'] ?? ''), (string)($x['last'] ?? '')));
            $a['clients'] = array_slice($a['clients'], 0, ANALYTICS_MAX_IPS, true);
        }
        // 只保留最近 N 天的日聚合
        $cut = date('Y-m-d', strtotime('-' . ANALYTICS_RETENTION_DAYS . ' days'));
        foreach (array_keys($a['days']) as $day) {
            if (strcmp((string)$day, $cut) < 0) {
                unset($a['days'][$day]);
            }
        }
        return $a;
    }, ['days' => [], 'clients' => []]); }
    catch (Throwable $error) { error_log('yunhui.me analytics write failed: ' . get_class($error)); }
}

/** 把按天的原始数据压成前端要的形状 */
function analytics_summary(array $a): array
{
    $days = $a['days'] ?? [];
    ksort($days);
    $series = [];
    $totals = ['catalog' => 0, 'update' => 0, 'ping' => 0];
    $versions = [];
    $platforms = [];
    $ipsToday = [];

    foreach ($days as $day => $d) {
        $series[] = [
            'day' => (string)$day,
            'catalog' => (int)($d['catalog'] ?? 0),
            'update' => (int)($d['update'] ?? 0),
            'ping' => (int)($d['ping'] ?? 0),
            'ips' => count((array)($d['ips'] ?? [])),
        ];
        foreach ($totals as $k => $_) {
            $totals[$k] += (int)($d[$k] ?? 0);
        }
        foreach ((array)($d['versions'] ?? []) as $v => $n) {
            $versions[$v] = ($versions[$v] ?? 0) + (int)$n;
        }
        foreach ((array)($d['platforms'] ?? []) as $p => $n) {
            $platforms[$p] = ($platforms[$p] ?? 0) + (int)$n;
        }
    }
    $todayKey = date('Y-m-d');
    $ipsToday = array_keys((array)($days[$todayKey]['ips'] ?? []));

    $clients = [];
    foreach ((array)($a['clients'] ?? []) as $ip => $c) {
        $clients[] = [
            'ip' => (string)$ip,
            'count' => (int)($c['count'] ?? 0),
            'first' => $c['first'] ?? '',
            'last' => $c['last'] ?? '',
            'ua' => $c['ua'] ?? '',
            'version' => $c['version'] ?? '',
            'platform' => $c['platform'] ?? '',
        ];
    }
    usort($clients, fn($x, $y) => strcmp((string)$y['last'], (string)$x['last']));

    arsort($versions);
    arsort($platforms);

    return [
        'totals' => $totals,
        'today' => [
            'catalog' => (int)($days[$todayKey]['catalog'] ?? 0),
            'update' => (int)($days[$todayKey]['update'] ?? 0),
            'ips' => count($ipsToday),
        ],
        'series' => array_slice($series, -30),
        'versions' => $versions,
        'platforms' => $platforms,
        'clients' => array_slice($clients, 0, 500),
        'ipTotal' => count((array)($a['clients'] ?? [])),
        'retentionDays' => ANALYTICS_RETENTION_DAYS,
    ];
}
