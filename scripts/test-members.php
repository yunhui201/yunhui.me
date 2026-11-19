<?php
/** Offline integration tests. PHP 8.1+, pdo_sqlite, openssl; no real accounts or credits. */
declare(strict_types=1);
require __DIR__ . '/../server/member_service.php';

function fixture(string $directory, string $mode = '', ?callable $intercept = null): MemberService
{
    $config = ['enabled' => true, 'origin' => 'https://members.example.test', 'adminKey' => 'test-administrator-key-only',
        'secret' => str_repeat('fixture-secret-', 4), 'dataDir' => $directory . '/ledger'];
    $upstream = new PDO('sqlite:' . $directory . '/upstream.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $upstream->exec('PRAGMA busy_timeout=10000');
    $upstream->exec('PRAGMA journal_mode=WAL');
    $upstream->exec('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, user_id INTEGER NOT NULL, cents INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, group_id INTEGER NOT NULL);');
    $transport = static function (string $method, string $path, array $headers, ?array $body) use ($upstream, $mode, $intercept): array {
        $okay = static fn(array $data): array => ['status' => 200, 'body' => ['code' => 0, 'data' => $data]];
        if ($intercept) { $override = $intercept($method, $path, $headers, $body); if ($override !== null) return $override; }
        $userId = 0;
        foreach ($headers as $header) if (preg_match('/^Authorization: Bearer user-([0-9]+)$/', $header, $m)) $userId = (int)$m[1];
        if ($path === '/auth/login') {
            if (($body['password'] ?? '') === '2fa') return $okay(['requires_2fa' => true, 'temp_token' => 'temporary-proof', 'user_email_masked' => 'u***@example.test']);
            if (($body['password'] ?? '') !== 'correct') return ['status' => 401, 'body' => []];
            return $okay(['access_token' => 'user-1', 'expires_in' => 3600]);
        }
        if ($path === '/auth/login/2fa') return ($body['totp_code'] ?? '') === '123456' ? $okay(['access_token' => 'user-1']) : ['status' => 401, 'body' => []];
        if ($path === '/auth/me') {
            if (!$userId) return ['status' => 401, 'body' => []];
            $q = $upstream->prepare('SELECT COALESCE(SUM(cents),0) FROM codes WHERE user_id=?'); $q->execute([$userId]);
            $profile = ['id' => $mode === 'different-user' ? $userId + 1 : $userId, 'email' => 'user' . $userId . '@example.test',
                'username' => '测试用户', 'balance' => (int)$q->fetchColumn() / 100, 'status' => $mode === 'inactive' ? 'inactive' : 'active'];
            if ($mode === 'missing-balance') unset($profile['balance']);
            if ($mode === 'invalid-balance') $profile['balance'] = 'unavailable';
            return $okay($profile);
        }
        if ($path === '/groups/available') return $okay([['id' => 7, 'name' => 'OpenAI', 'platform' => 'openai', 'status' => 'active', 'rate_multiplier' => 1], ['id' => 8, 'name' => 'Claude', 'platform' => 'anthropic', 'status' => 'active']]);
        if (str_starts_with($path, '/keys?')) {
            if (!$userId) throw new RuntimeException('Keys must use user auth');
            $q = $upstream->prepare('SELECT * FROM keys WHERE user_id=?'); $q->execute([$userId]);
            return $okay(['items' => array_map(static fn(array $row): array => ['id' => 1, 'key' => $row['key'], 'group_id' => (int)$row['group_id'], 'user_id' => (int)$row['user_id'], 'status' => 'active'], $q->fetchAll(PDO::FETCH_ASSOC))]);
        }
        if ($path === '/keys') {
            if (!$userId || array_filter($headers, static fn(string $h): bool => str_starts_with($h, 'x-api-key:'))) throw new RuntimeException('Wrong key authorization');
            if ($body['name'] !== 'yunhui.me 客户端') throw new RuntimeException('Wrong key name');
            $q = $upstream->prepare('INSERT OR IGNORE INTO keys(key,user_id,group_id) VALUES(?,?,?)'); $q->execute([$body['custom_key'], $userId, $body['group_id']]);
            return $okay(['id' => 1, 'key' => $body['custom_key'], 'user_id' => $userId, 'group_id' => $body['group_id'], 'status' => 'active']);
        }
        if (!in_array('x-api-key: test-administrator-key-only', $headers, true)) throw new RuntimeException('Admin header missing');
        $receipt = static fn(array $row): array => ['id' => 10, 'code' => $row['code'], 'type' => 'balance', 'value' => (int)$row['cents'] / 100, 'used_by' => (int)$row['user_id'], 'status' => 'used'];
        if (str_starts_with($path, '/admin/redeem-codes?')) {
            parse_str((string)parse_url($path, PHP_URL_QUERY), $query);
            $q = $upstream->prepare('SELECT * FROM codes WHERE code=?'); $q->execute([$query['search']]);
            $row = $q->fetch(PDO::FETCH_ASSOC);
            return $okay(['items' => $row ? [$receipt($row)] : [], 'total' => $row ? 1 : 0]);
        }
        if ($path !== '/admin/redeem-codes/create-and-redeem') throw new RuntimeException('Unexpected endpoint');
        if ($body['value'] !== 10 || $body['type'] !== 'balance' || !in_array('Idempotency-Key: ' . $body['code'], $headers, true)) throw new RuntimeException('Unsafe grant request');
        // The HTTP validator accepts 128 characters, but the actual redeem-code entity/database accepts only 32.
        if (strlen($body['code']) > 32) return ['status' => 500, 'body' => ['code' => 500, 'reason' => 'INTERNAL_ERROR', 'message' => 'fixture schema: redeem code exceeds 32 characters']];
        $upstream->exec('BEGIN IMMEDIATE');
        try {
            $upstream->exec("INSERT INTO counters(key,value) VALUES('fulfill',1) ON CONFLICT(key) DO UPDATE SET value=value+1");
            $q = $upstream->prepare('INSERT OR IGNORE INTO codes(code,user_id,cents) VALUES(?,?,1000)'); $q->execute([$body['code'], $body['user_id']]);
            $q = $upstream->prepare('SELECT * FROM codes WHERE code=?'); $q->execute([$body['code']]);
            $row = $q->fetch(PDO::FETCH_ASSOC);
            $upstream->exec('COMMIT');
        } catch (Throwable $e) { $upstream->exec('ROLLBACK'); throw $e; }
        if ($mode === 'timeout-after-credit') throw new MemberError('UPSTREAM_UNAVAILABLE', 'simulated lost response', 503);
        $result = $receipt($row);
        if ($mode === 'wrong-receipt') $result['value'] = 20;
        return $okay(['redeem_code' => $result]);
    };
    return new MemberService($config, $transport);
}

function identity(int $id): array
{
    return ['installationId' => 'installation-test-' . $id, 'installationProof' => hash('sha256', 'proof-' . $id)];
}
function signedIn(MemberService $service, int $userId, int $installId): array
{
    $credentials = identity($installId);
    $login = $service->handle('bind', ['accessToken' => 'user-' . $userId], $credentials, 'ip-' . $userId . '-' . $installId);
    return $credentials + ['sessionToken' => $login['sessionToken']];
}
function check(bool $condition, string $label): void
{
    if (!$condition) throw new RuntimeException('FAILED: ' . $label);
}
function expectCode(callable $run, string $code): void
{
    try { $run(); } catch (MemberError $e) { check($e->errorCode === $code, 'expected ' . $code . ', got ' . $e->errorCode); return; }
    throw new RuntimeException('Expected error: ' . $code);
}
function db(string $directory): PDO { return new PDO('sqlite:' . $directory . '/ledger/members.sqlite'); }
function upstreamDb(string $directory): PDO { return new PDO('sqlite:' . $directory . '/upstream.sqlite'); }
function seedLegacyGrant(string $directory, int $userId = 1, string $status = 'pending'): string
{
    $database = db($directory);
    $installation = $database->query('SELECT installation_hash FROM member_sessions WHERE user_id=' . $userId)->fetchColumn();
    $code = 'YQ-WELCOME-' . strtoupper(hash_hmac('sha256', 'aurora-first-member-v1:https://members.example.test:' . $userId, str_repeat('fixture-secret-', 4)));
    $q = $database->prepare('INSERT INTO welcome_grants(user_id,installation_hash,code,status,amount_cents,created_at,claimed_at) VALUES(?,?,?,?,1000,?,?)');
    $q->execute([$userId, $installation, $code, $status, time() - 3600, $status === 'claimed' ? time() - 1800 : null]);
    return $code;
}
function runClaimWorkers(string $directory, array $credentials): void
{
    $credentialsPath = $directory . '/worker.json'; file_put_contents($credentialsPath, json_encode($credentials));
    $workers = [];
    for ($i = 0; $i < 8; $i++) {
        $command = [PHP_BINARY];
        if (PHP_OS_FAMILY === 'Windows') array_push($command, '-d', 'extension_dir=' . ini_get('extension_dir'), '-d', 'extension=pdo_sqlite', '-d', 'extension=openssl');
        array_push($command, __FILE__, '--worker', $directory, $credentialsPath);
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        check(is_resource($process), 'worker launch'); fclose($pipes[0]); $workers[] = [$process, $pipes];
    }
    foreach ($workers as [$process, $pipes]) {
        $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
        check(proc_close($process) === 0, 'worker success ' . $err);
        check((json_decode($out, true)['gift']['status'] ?? '') === 'claimed', 'worker result');
    }
}

if (($argv[1] ?? '') === '--worker') {
    $directory = $argv[2];
    $credentials = json_decode((string)file_get_contents($argv[3]), true, 32, JSON_THROW_ON_ERROR);
    try { echo json_encode(fixture($directory)->handle('claim', [], $credentials), JSON_THROW_ON_ERROR); }
    catch (Throwable $e) { fwrite(STDERR, get_class($e) . ': ' . $e->getMessage()); exit(1); }
    exit;
}
if (($argv[1] ?? '') === '--init-worker') {
    try { echo json_encode(signedIn(fixture($argv[2]), (int)$argv[3], (int)$argv[3]), JSON_THROW_ON_ERROR); }
    catch (Throwable $e) { fwrite(STDERR, get_class($e) . ': ' . $e->getMessage()); exit(1); }
    exit;
}

$root = sys_get_temp_dir() . '/aurora-members-test-' . bin2hex(random_bytes(6));
mkdir($root, 0700, true);
$tests = 0;
$test = static function (string $name, callable $run) use (&$tests, $root): void {
    $directory = $root . '/' . (++$tests); mkdir($directory, 0700, true); $run($directory); echo 'PASS ' . $name . PHP_EOL;
};

$test('fixed ten-dollar grant, repeated claim and private response', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    $first = $service->handle('claim', [], $credentials); $second = $service->handle('claim', [], $credentials);
    check($first['gift']['status'] === 'claimed' && $first['gift']['amountUsd'] === 10 && $first['member']['balance'] === 10.0, 'credit confirmed');
    check($first['gift']['code'] === $second['gift']['code'], 'stable code');
    check(strlen($first['gift']['code']) === 32 && str_starts_with($first['gift']['code'], 'YQW-'), 'redeem code respects actual storage limit');
    check((int)upstreamDb($dir)->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 1000, 'exact credit');
    $output = json_encode([$first, $service->publicConfig(), $service->adminOverview()]);
    check(!str_contains($output, 'test-administrator-key') && !str_contains($output, 'user-1'), 'secrets not exposed');
});
$test('unknown account balances are never presented as measured zero', static function ($dir): void {
    foreach (['missing-balance', 'invalid-balance'] as $mode) {
        $service = fixture($dir, $mode); $credentials = signedIn($service, 1, 1);
        check($service->handle('status', [], $credentials)['member']['balance'] === null, 'unknown balance remains unknown');
        check($service->handle('claim', [], $credentials)['member']['balance'] === null, 'confirmed gift does not invent a new account balance');
    }
    $service = fixture($dir); $credentials = signedIn($service, 2, 2);
    check($service->handle('status', [], $credentials)['member']['balance'] === 0.0, 'reported zero balance remains zero');
});
$test('same account on another installation cannot receive twice', static function ($dir): void {
    $service = fixture($dir); $service->handle('claim', [], signedIn($service, 1, 1));
    $result = $service->handle('claim', [], signedIn($service, 1, 2));
    check($result['gift']['status'] === 'claimed' && (int)upstreamDb($dir)->query('SELECT COUNT(*) FROM codes')->fetchColumn() === 1, 'account unique');
});
$test('another account on same installation is ineligible', static function ($dir): void {
    $service = fixture($dir); $service->handle('claim', [], signedIn($service, 1, 1));
    $other = signedIn($service, 2, 1);
    check($service->handle('status', [], $other)['gift']['status'] === 'ineligible', 'installation status');
    expectCode(fn() => $service->handle('claim', [], $other), 'INSTALLATION_ALREADY_CLAIMED');
});
$test('self-reported identity and amount rejected', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    foreach (['userId' => 2, 'user_id' => 2, 'amount' => 100, 'value' => 20, 'code' => 'forged'] as $key => $value) expectCode(fn() => $service->handle('claim', [$key => $value], $credentials), 'INVALID_FIELDS');
    check((int)db($dir)->query('SELECT COUNT(*) FROM welcome_grants')->fetchColumn() === 0, 'no reservation');
});
$test('installation and bearer authentication enforced', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    $bad = $credentials; $bad['installationProof'] = str_repeat('0', 64);
    expectCode(fn() => $service->handle('claim', [], $bad), 'INSTALLATION_MISMATCH');
    $other = signedIn($service, 2, 2); $other['sessionToken'] = $credentials['sessionToken'];
    expectCode(fn() => $service->handle('claim', [], $other), 'SESSION_EXPIRED');
    expectCode(fn() => $service->handle('bind', ['accessToken' => 'forged'], identity(3)), 'AUTH_REJECTED');
});
$test('timeout after upstream credit recovers by code lookup', static function ($dir): void {
    $service = fixture($dir, 'timeout-after-credit'); $credentials = signedIn($service, 1, 1);
    expectCode(fn() => $service->handle('claim', [], $credentials), 'UPSTREAM_UNAVAILABLE');
    check(db($dir)->query('SELECT status FROM welcome_grants')->fetchColumn() === 'pending', 'pending durable');
    $result = fixture($dir)->handle('claim', [], $credentials);
    check($result['gift']['status'] === 'claimed' && (int)upstreamDb($dir)->query("SELECT value FROM counters WHERE key='fulfill'")->fetchColumn() === 1, 'read-only reconciliation');
});
$test('legacy pending code migrates only after a complete empty lookup', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1); $oldCode = seedLegacyGrant($dir);
    $before = db($dir)->query('SELECT * FROM welcome_grants')->fetch(PDO::FETCH_ASSOC);
    expectCode(fn() => $service->adminReconcile(1, false), 'GRANT_PENDING');
    check(db($dir)->query('SELECT code FROM welcome_grants')->fetchColumn() === $oldCode, 'read-only reconciliation does not migrate');
    $result = $service->handle('claim', [], $credentials);
    $after = db($dir)->query('SELECT * FROM welcome_grants')->fetch(PDO::FETCH_ASSOC);
    check($result['gift']['status'] === 'claimed' && strlen($after['code']) === 32 && $after['code'] !== $oldCode, 'legacy code replaced and fulfilled');
    foreach (['user_id', 'installation_hash', 'amount_cents', 'created_at'] as $field) check($before[$field] === $after[$field], 'migration preserves entitlement ' . $field);
    check((int)upstreamDb($dir)->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 1000, 'exactly one new credit');
});
$test('legacy used receipt reconciles without replacing the code or crediting again', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1); $oldCode = seedLegacyGrant($dir);
    $q = upstreamDb($dir)->prepare('INSERT INTO codes(code,user_id,cents) VALUES(?,1,1000)'); $q->execute([$oldCode]);
    $result = $service->handle('claim', [], $credentials);
    check($result['gift']['status'] === 'claimed' && $result['gift']['code'] === $oldCode, 'original used receipt retained');
    check((int)upstreamDb($dir)->query('SELECT COUNT(*) FROM counters')->fetchColumn() === 0, 'no fulfillment request');
    $other = signedIn($service, 2, 2); $mismatched = seedLegacyGrant($dir, 2);
    $q = upstreamDb($dir)->prepare('INSERT INTO codes(code,user_id,cents) VALUES(?,3,1000)'); $q->execute([$mismatched]);
    expectCode(fn() => $service->handle('claim', [], $other), 'GRANT_REVIEW_REQUIRED');
    check(db($dir)->query('SELECT code FROM welcome_grants WHERE user_id=2')->fetchColumn() === $mismatched, 'mismatched used receipt never replaced');
});
$test('legacy unused receipt stays reserved for review and is never replaced', static function ($dir): void {
    $base = fixture($dir); $credentials = signedIn($base, 1, 1); $oldCode = seedLegacyGrant($dir); $posts = 0;
    $service = fixture($dir, '', static function ($method, $path) use ($oldCode, &$posts) {
        if ($method === 'POST') $posts++;
        if (str_starts_with($path, '/admin/redeem-codes?')) return ['status' => 200, 'body' => ['code' => 0, 'data' => ['total' => 1, 'items' => [['id' => 10, 'code' => $oldCode, 'type' => 'balance', 'value' => 10, 'status' => 'unused']]]]];
        return null;
    });
    expectCode(fn() => $service->handle('claim', [], $credentials), 'GRANT_REVIEW_REQUIRED');
    check(db($dir)->query('SELECT code FROM welcome_grants')->fetchColumn() === $oldCode && db($dir)->query('SELECT status FROM welcome_grants')->fetchColumn() === 'review', 'unused reservation retained');
    check($posts === 0, 'no new code or redemption request');
});
$test('claimed, review and unrecognized long codes cannot enter automatic migration', static function ($dir): void {
    $service = fixture($dir);
    foreach (['claimed', 'review', 'pending'] as $index => $status) {
        $userId = $index + 1; $credentials = signedIn($service, $userId, $userId); $oldCode = seedLegacyGrant($dir, $userId, $status);
        if ($status === 'pending') { $oldCode = 'YQ-WELCOME-' . str_repeat('0', 64); $q = db($dir)->prepare('UPDATE welcome_grants SET code=? WHERE user_id=?'); $q->execute([$oldCode, $userId]); }
        if ($status === 'claimed') check($service->handle('claim', [], $credentials)['gift']['status'] === 'claimed', 'claimed stays claimed');
        else expectCode(fn() => $service->handle('claim', [], $credentials), 'GRANT_REVIEW_REQUIRED');
        check(db($dir)->query('SELECT code FROM welcome_grants WHERE user_id=' . $userId)->fetchColumn() === $oldCode, 'original code remains reserved');
    }
    check((int)upstreamDb($dir)->query('SELECT COUNT(*) FROM codes')->fetchColumn() === 0, 'no new credits');
});
$test('incomplete legacy searches never establish absence', static function ($dir): void {
    $base = fixture($dir); $credentials = signedIn($base, 1, 1); $oldCode = seedLegacyGrant($dir);
    foreach ([['total' => 1, 'items' => []], ['items' => []], ['total' => '0', 'items' => []]] as $found) {
        $service = fixture($dir, '', static function ($method, $path) use ($found) {
            if (str_starts_with($path, '/admin/redeem-codes?')) return ['status' => 200, 'body' => ['code' => 0, 'data' => $found]];
            return null;
        });
        expectCode(fn() => $service->handle('claim', [], $credentials), 'GRANT_LOOKUP_INCOMPLETE');
        check(db($dir)->query('SELECT code FROM welcome_grants')->fetchColumn() === $oldCode && db($dir)->query('SELECT status FROM welcome_grants')->fetchColumn() === 'pending', 'reservation unchanged');
    }
});
$test('a delayed legacy lookup reloads a concurrently migrated and claimed grant', static function ($dir): void {
    $base = fixture($dir); $credentials = signedIn($base, 1, 1); $oldCode = seedLegacyGrant($dir); $delayed = false;
    $service = fixture($dir, '', static function ($method, $path) use ($dir, $credentials, $oldCode, &$delayed) {
        if (!$delayed && str_contains($path, rawurlencode($oldCode))) {
            $delayed = true; fixture($dir)->handle('claim', [], $credentials);
            return ['status' => 200, 'body' => ['code' => 0, 'data' => ['total' => 0, 'items' => []]]];
        }
        return null;
    });
    check($service->handle('claim', [], $credentials)['gift']['status'] === 'claimed', 'latest result returned');
    check((int)upstreamDb($dir)->query("SELECT value FROM counters WHERE key='fulfill'")->fetchColumn() === 1, 'late worker never fulfills stale code');
});
$test('concurrent legacy migrations preserve one grant and credit exactly once', static function ($dir): void {
    $credentials = signedIn(fixture($dir), 1, 1); seedLegacyGrant($dir); runClaimWorkers($dir, $credentials);
    check((int)upstreamDb($dir)->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 1000, 'one upstream migrated grant');
    check((int)db($dir)->query('SELECT COUNT(*) FROM welcome_grants')->fetchColumn() === 1 && strlen(db($dir)->query('SELECT code FROM welcome_grants')->fetchColumn()) === 32, 'one migrated entitlement');
});
$test('mismatched receipt requires review, admin read-only reconcile', static function ($dir): void {
    $service = fixture($dir, 'wrong-receipt'); $credentials = signedIn($service, 1, 1);
    expectCode(fn() => $service->handle('claim', [], $credentials), 'GRANT_REVIEW_REQUIRED');
    check(db($dir)->query('SELECT status FROM welcome_grants')->fetchColumn() === 'review', 'fail closed');
    expectCode(fn() => fixture($dir)->handle('claim', [], $credentials), 'GRANT_REVIEW_REQUIRED');
    check(fixture($dir)->adminReconcile(1, false)['gift']['status'] === 'claimed', 'admin confirms actual upstream receipt');
});
$test('upstream identity and active status revalidated before credit', static function ($dir): void {
    $credentials = signedIn(fixture($dir), 1, 1);
    expectCode(fn() => fixture($dir, 'different-user')->handle('claim', [], $credentials), 'AUTH_REJECTED');
    expectCode(fn() => fixture($dir)->handle('status', [], $credentials), 'SESSION_EXPIRED');
    $credentials = signedIn(fixture($dir), 1, 1);
    expectCode(fn() => fixture($dir, 'inactive')->handle('claim', [], $credentials), 'ACCOUNT_INACTIVE');
});
$test('session token is hashed, upstream JWT encrypted, logout revokes', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    $session = db($dir)->query('SELECT * FROM member_sessions')->fetch(PDO::FETCH_ASSOC);
    check($session['token_hash'] !== $credentials['sessionToken'] && !str_contains($session['upstream_token'], 'user-1'), 'encrypted at rest');
    $service->handle('logout', [], $credentials);
    expectCode(fn() => $service->handle('claim', [], $credentials), 'SESSION_EXPIRED');
});
$test('login and two-factor flow', static function ($dir): void {
    $service = fixture($dir);
    expectCode(fn() => $service->handle('login', ['email' => 'u@example.test', 'password' => 'bad'], identity(1)), 'AUTH_REJECTED');
    $challenge = $service->handle('login', ['email' => 'u@example.test', 'password' => '2fa'], identity(1));
    check($challenge['requires2fa'] && $challenge['tempToken'] === 'temporary-proof', 'challenge');
    $login = $service->handle('login2fa', ['tempToken' => $challenge['tempToken'], 'totpCode' => '123456'], identity(1));
    check($login['member']['id'] === 1, '2fa verified');
});
$test('disabled service and per-IP login throttling', static function ($dir): void {
    $disabled = new MemberService(['enabled' => false]);
    check(!$disabled->publicConfig()['enabled'], 'disabled config');
    expectCode(fn() => $disabled->handle('claim', [], []), 'MEMBERS_DISABLED');
    $service = fixture($dir);
    for ($i = 0; $i < 12; $i++) expectCode(fn() => $service->handle('bind', ['accessToken' => 'bad'], identity(1), 'same-ip'), 'AUTH_REJECTED');
    expectCode(fn() => $service->handle('bind', ['accessToken' => 'bad'], identity(1), 'same-ip'), 'RATE_LIMITED');
});
$test('user-scoped API key, allowed group and stable retries', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    expectCode(fn() => $service->handle('create-client-key', ['groupId' => 999], $credentials), 'GROUP_REQUIRED');
    $first = $service->handle('create-client-key', ['groupId' => 7], $credentials);
    $again = $service->handle('create-client-key', ['groupId' => 7], $credentials);
    check($first['apiKey'] === $again['apiKey'] && $first['format'] === 'openai-responses', 'stable key');
    check((int)upstreamDb($dir)->query('SELECT COUNT(*) FROM keys')->fetchColumn() === 1, 'one user key');
    check(!str_contains(json_encode($service->handle('status', [], $credentials)), 'sk-yunhui-'), 'status does not reveal key');
});
$test('key creation business denials do not masquerade as an expired member login', static function ($dir): void {
    $credentials = signedIn(fixture($dir), 1, 1);
    foreach ([[403, 'GROUP_NOT_ALLOWED', 'GROUP_NOT_ALLOWED'], [403, 'API_KEY_COUNT_EXCEEDED', 'KEY_LIMIT_REACHED'], [429, 'API_KEY_CREATE_RATE_LIMITED', 'KEY_CREATE_RATE_LIMITED'], [409, 'API_KEY_EXISTS', 'KEY_REVIEW_REQUIRED'], [401, 'INVALID_TOKEN', 'AUTH_REJECTED']] as [$status, $reason, $expected]) {
        $service = fixture($dir, '', static function ($method, $path) use ($status, $reason) {
            if ($method === 'POST' && $path === '/keys') return ['status' => $status, 'body' => ['code' => $status, 'reason' => $reason, 'message' => 'fixture-private-upstream-details', 'metadata' => ['token' => 'fixture-private-token']]];
            return null;
        });
        try { $service->handle('create-client-key', ['groupId' => 7], $credentials); throw new RuntimeException('expected key failure'); }
        catch (MemberError $error) { check($error->errorCode === $expected, 'precise key error'); check(!str_contains($error->getMessage(), 'fixture-private'), 'key error redacted'); }
        check($service->handle('status', [], $credentials)['member']['id'] === 1, 'local session remains available');
    }
});
$test('gift diagnostics distinguish admin credentials, route support and upstream fulfillment failure', static function ($dir): void {
    $credentials = signedIn(fixture($dir), 1, 1);
    foreach ([
        ['GET', 401, 'INVALID_ADMIN_KEY', 'UPSTREAM_ADMIN_AUTH_REJECTED', '平台管理凭据'],
        ['GET', 403, 'FORBIDDEN', 'UPSTREAM_ADMIN_AUTH_REJECTED', '平台管理凭据'],
        ['GET', 423, 'ADMIN_COMPLIANCE_ACK_REQUIRED', 'UPSTREAM_ADMIN_ACTION_REQUIRED', '管理员确认'],
        ['POST', 404, 'NOT_FOUND', 'UPSTREAM_API_UNSUPPORTED', '发放赠金'],
        ['POST', 500, 'INTERNAL_ERROR', 'UPSTREAM_UNAVAILABLE', '发放赠金未获会员站点确认（HTTP 500）'],
    ] as [$failureMethod, $status, $reason, $expected, $message]) {
        $service = fixture($dir, '', static function ($method, $path) use ($failureMethod, $status, $reason) {
            if ($method === $failureMethod && str_starts_with($path, '/admin/redeem-codes')) return ['status' => $status, 'body' => ['code' => $method === 'GET' ? $reason : $status, 'reason' => $reason, 'message' => 'fixture-private-admin-key', 'metadata' => ['request' => 'fixture-private-body']]];
            return null;
        });
        try { $service->handle('claim', [], $credentials); throw new RuntimeException('expected gift failure'); }
        catch (MemberError $error) { check($error->errorCode === $expected && str_contains($error->getMessage(), $message), 'precise gift stage'); check(!str_contains($error->getMessage(), 'fixture-private'), 'gift error redacted'); }
        check(db($dir)->query('SELECT status FROM welcome_grants')->fetchColumn() === 'pending', 'unconfirmed grant remains pending');
        check(db($dir)->query('SELECT last_error FROM welcome_grants')->fetchColumn() === $expected, 'safe diagnostic code retained');
    }
    check((int)upstreamDb($dir)->query('SELECT COUNT(*) FROM codes')->fetchColumn() === 0, 'diagnostics never imply credit');
});
$test('malformed successful upstream replies identify their operation without exposing content', static function ($dir): void {
    $credentials = signedIn(fixture($dir), 1, 1);
    $service = fixture($dir, '', static function ($method, $path) {
        if ($method === 'POST' && $path === '/keys') return ['status' => 200, 'body' => ['code' => 0, 'data' => 'fixture-private-content']];
        return null;
    });
    try { $service->handle('create-client-key', ['groupId' => 7], $credentials); throw new RuntimeException('expected incompatible response'); }
    catch (MemberError $error) { check($error->errorCode === 'UPSTREAM_RESPONSE_INVALID' && str_contains($error->getMessage(), '创建客户端密钥'), 'incompatible key response identified'); check(!str_contains($error->getMessage(), 'fixture-private'), 'response content redacted'); }
});
$test('concurrent PHP processes credit exactly once', static function ($dir): void {
    $credentials = signedIn(fixture($dir), 1, 1);
    runClaimWorkers($dir, $credentials);
    check((int)upstreamDb($dir)->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 1000, 'one upstream grant');
    check((int)db($dir)->query('SELECT COUNT(*) FROM welcome_grants')->fetchColumn() === 1, 'one local grant');
});
$test('corrupt monetary ledger is not silently reset', static function ($dir): void {
    mkdir($dir . '/ledger'); file_put_contents($dir . '/ledger/members.sqlite', 'not a sqlite database');
    $failed = false; try { signedIn(fixture($dir), 1, 1); } catch (PDOException $e) { $failed = true; }
    check($failed && file_get_contents($dir . '/ledger/members.sqlite') === 'not a sqlite database', 'corruption preserved');
});

$test('initialized empty or incomplete ledgers never rebuild grant history', static function ($dir): void {
    $service = fixture($dir); $credentials = signedIn($service, 1, 1);
    $service->handle('claim', [], $credentials); unset($service);
    $database = db($dir); $database->exec('PRAGMA wal_checkpoint(TRUNCATE)'); unset($database);
    file_put_contents($dir . '/ledger/members.sqlite', '');
    expectCode(fn() => signedIn(fixture($dir), 1, 2), 'STORAGE_UNAVAILABLE');
    check(filesize($dir . '/ledger/members.sqlite') === 0, 'empty ledger preserved');
    unlink($dir . '/ledger/members.sqlite');
    $database = db($dir); $database->exec('CREATE TABLE unrelated (id INTEGER)'); unset($database);
    $original = hash_file('sha256', $dir . '/ledger/members.sqlite');
    expectCode(fn() => signedIn(fixture($dir), 1, 2), 'STORAGE_UNAVAILABLE');
    check(hash_file('sha256', $dir . '/ledger/members.sqlite') === $original, 'incomplete ledger preserved');
    check((int)upstreamDb($dir)->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 1000, 'no extra credit after ledger loss');
});

$test('failed origin verification never leaves a usable cached database', static function ($dir): void {
    signedIn(fixture($dir), 1, 1);
    $service = new MemberService(['enabled' => true, 'origin' => 'https://changed.example.test',
        'adminKey' => 'test-administrator-key-only', 'secret' => str_repeat('fixture-secret-', 4), 'dataDir' => $dir . '/ledger']);
    expectCode(fn() => $service->adminOverview(), 'UPSTREAM_CHANGED');
    expectCode(fn() => $service->adminOverview(), 'UPSTREAM_CHANGED');
});

$test('simultaneous first requests initialize one complete ledger', static function ($dir): void {
    // Prepare only the mock upstream. The member ledger does not exist when workers start.
    fixture($dir);
    $workers = [];
    for ($i = 1; $i <= 8; $i++) {
        $command = [PHP_BINARY];
        if (PHP_OS_FAMILY === 'Windows') array_push($command, '-d', 'extension_dir=' . ini_get('extension_dir'), '-d', 'extension=pdo_sqlite', '-d', 'extension=openssl');
        array_push($command, __FILE__, '--init-worker', $dir, (string)$i);
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        check(is_resource($process), 'initialization worker launch'); fclose($pipes[0]); $workers[] = [$process, $pipes];
    }
    foreach ($workers as [$process, $pipes]) {
        $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
        check(proc_close($process) === 0, 'initialization worker success ' . $err);
        check(isset(json_decode($out, true)['sessionToken']), 'initialization worker session');
    }
    check((int)db($dir)->query('SELECT COUNT(*) FROM installations')->fetchColumn() === 8, 'all independent installations retained');
    check(is_file($dir . '/ledger/members.initialized'), 'initialized marker persisted');
});

$test('missing origin and failed initialization marker remain closed on retries', static function ($dir): void {
    $service = fixture($dir); signedIn($service, 1, 1); unset($service);
    $database = db($dir); $database->exec("DELETE FROM member_meta WHERE key='upstream_origin'"); unset($database);
    $service = fixture($dir);
    expectCode(fn() => $service->adminOverview(), 'STORAGE_UNAVAILABLE');
    expectCode(fn() => $service->adminOverview(), 'STORAGE_UNAVAILABLE');
    check((int)db($dir)->query("SELECT COUNT(*) FROM member_meta WHERE key='upstream_origin'")->fetchColumn() === 0, 'missing origin never inferred from new configuration');
    $database = db($dir); $database->exec("INSERT INTO member_meta VALUES('upstream_origin','https://members.example.test')"); unset($database);
    unlink($dir . '/ledger/members.initialized'); mkdir($dir . '/ledger/members.initialized');
    $service = fixture($dir);
    expectCode(fn() => $service->adminOverview(), 'STORAGE_UNAVAILABLE');
    expectCode(fn() => $service->adminOverview(), 'STORAGE_UNAVAILABLE');
});

echo 'All ' . $tests . ' membership integration tests passed. Fixtures: ' . $root . PHP_EOL;
