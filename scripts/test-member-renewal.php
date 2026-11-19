<?php
/** Isolated PHP integration tests for rotating membership sessions. No network/accounts/credits. */
declare(strict_types=1);
require __DIR__ . '/../server/member_service.php';

function verify(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function failure(callable $call, string $code): void
{
    try { $call(); } catch (MemberError $error) { verify($error->errorCode === $code, 'Expected ' . $code . ', got ' . $error->errorCode); return; }
    throw new RuntimeException('Expected failure ' . $code);
}
function device(int $id = 1): array { return ['installationId' => 'renewal-fixture-device-' . $id, 'installationProof' => hash('sha256', 'fixture-proof-' . $id)]; }
function ledger(string $dir): PDO { $db = new PDO('sqlite:' . $dir . '/ledger/members.sqlite'); $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION); $db->exec('PRAGMA busy_timeout=10000'); return $db; }
function upstream(string $dir): PDO { $db = new PDO('sqlite:' . $dir . '/upstream.sqlite'); $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION); $db->exec('PRAGMA busy_timeout=10000'); return $db; }
function counter(string $dir, string $name): int { $q = upstream($dir)->prepare('SELECT value FROM counters WHERE name=?'); $q->execute([$name]); return (int)$q->fetchColumn(); }
function credentials(MemberService $service, int $id = 1, int $user = 1): array
{
    $login = $service->handle('login', ['email' => 'user' . $user . '@example.test', 'password' => 'fixture-password'], device($id));
    return array_merge(device($id), ['sessionToken' => $login['sessionToken']]);
}
function row(string $dir, array $credentials): array
{
    $q = ledger($dir)->prepare('SELECT * FROM member_sessions WHERE token_hash=?'); $q->execute([hash('sha256', $credentials['sessionToken'])]); return $q->fetch(PDO::FETCH_ASSOC) ?: [];
}
function due(string $dir, array $credentials): void
{
    $q = ledger($dir)->prepare('UPDATE member_sessions SET access_expires_at=? WHERE token_hash=?'); $q->execute([time() - 10, hash('sha256', $credentials['sessionToken'])]);
}
function jwt(int $user, int $expiry): string
{
    $encode = static fn(array $value): string => rtrim(strtr(base64_encode(json_encode($value)), '+/', '-_'), '=');
    return $encode(['alg' => 'fixture-only']) . '.' . $encode(['sub' => $user, 'exp' => $expiry]) . '.fixture-signature';
}

function service(string $dir, string $mode = '', ?callable $afterRotation = null): MemberService
{
    $db = upstream($dir);
    $db->exec('CREATE TABLE IF NOT EXISTS tokens (refresh TEXT PRIMARY KEY, access TEXT NOT NULL, user_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    $transport = static function (string $method, string $path, array $headers, ?array $body) use ($db, $mode, $afterRotation): array {
        $ok = static fn(array $data): array => ['status' => 200, 'body' => ['code' => 0, 'data' => $data]];
        $count = static function (string $name) use ($db): void { $q = $db->prepare('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1'); $q->execute([$name]); };
        $issue = static function (int $user) use ($db): array {
            $nonce = bin2hex(random_bytes(12)); $refresh = 'rt_fixture_' . $nonce; $access = 'fixture-access-' . $user . '-' . $nonce;
            $q = $db->prepare('INSERT INTO tokens VALUES(?,?,?)'); $q->execute([$refresh, $access, $user]);
            return ['access_token' => $access, 'refresh_token' => $refresh, 'expires_in' => 86400, 'token_type' => 'Bearer'];
        };
        if ($path === '/auth/login' || $path === '/auth/login/2fa') {
            if (($body['password'] ?? '') === '2fa') return $ok(['requires_2fa' => true, 'temp_token' => 'fixture-2fa']);
            $user = str_starts_with($body['email'] ?? '', 'user2@') ? 2 : 1;
            return $ok($issue($user));
        }
        if ($path === '/auth/refresh') {
            verify($method === 'POST' && array_keys($body) === ['refresh_token'] && $headers === [], 'Refresh must use the upstream protocol without client authority fields');
            $count('refresh');
            if ($mode === 'offline-refresh') return ['status' => 503, 'body' => []];
            if ($mode === 'revoked') return ['status' => 401, 'body' => ['reason' => 'REFRESH_TOKEN_INVALID', 'message' => 'private-upstream-detail']];
            $db->exec('BEGIN IMMEDIATE');
            try {
                $q = $db->prepare('SELECT * FROM tokens WHERE refresh=?'); $q->execute([$body['refresh_token']]); $old = $q->fetch(PDO::FETCH_ASSOC);
                if (!$old) { $db->exec('ROLLBACK'); return ['status' => 401, 'body' => ['reason' => 'REFRESH_TOKEN_INVALID']]; }
                $q = $db->prepare('DELETE FROM tokens WHERE refresh=?'); $q->execute([$body['refresh_token']]);
                $pair = $issue($mode === 'wrong-user' ? 2 : (int)$old['user_id']);
                $db->exec('COMMIT');
            } catch (Throwable $error) { if ($db->inTransaction()) $db->exec('ROLLBACK'); throw $error; }
            if ($afterRotation) $afterRotation();
            if ($mode === 'malformed') unset($pair['refresh_token']);
            if ($mode === 'malformed-access') $pair['access_token'] = "invalid\r\nheader";
            if ($mode === 'malformed-ttl') $pair['expires_in'] = 0;
            return $ok($pair);
        }
        if ($path === '/auth/logout') {
            verify($method === 'POST' && $headers === [], 'Logout only revokes its refresh credential');
            $count('logout');
            $q = $db->prepare('DELETE FROM tokens WHERE refresh=?'); $q->execute([$body['refresh_token']]);
            return $ok(['message' => 'logged out']);
        }
        $access = '';
        foreach ($headers as $header) if (str_starts_with($header, 'Authorization: Bearer ')) $access = substr($header, 22);
        if ($path === '/auth/me') {
            $count('me');
            if ($mode === 'profile-offline-after-refresh' && (int)$db->query("SELECT value FROM counters WHERE name='refresh'")->fetchColumn() > 0) return ['status' => 503, 'body' => []];
            $q = $db->prepare('SELECT user_id FROM tokens WHERE access=?'); $q->execute([$access]); $user = (int)$q->fetchColumn();
            if (!$user && str_contains($access, '.')) { $parts = explode('.', $access); $claims = json_decode((string)base64_decode(strtr($parts[1], '-_', '+/')), true); $user = (int)($claims['sub'] ?? 0); }
            if (!$user) return ['status' => 401, 'body' => []];
            return $ok(['id' => $user, 'email' => 'user' . $user . '@example.test', 'username' => 'Fixture', 'balance' => 0, 'status' => 'active']);
        }
        if ($path === '/groups/available') { $count('groups'); return $ok([]); }
        throw new RuntimeException('Unexpected upstream operation: ' . $method . ' ' . $path);
    };
    return new MemberService(['enabled' => true, 'origin' => 'https://members.example.test', 'adminKey' => 'fixture-admin-key',
        'secret' => str_repeat('renewal-fixture-secret', 3), 'dataDir' => $dir . '/ledger'], $transport);
}

if (($argv[1] ?? '') === '--worker') {
    try { $auth = json_decode(file_get_contents($argv[3]), true, 32, JSON_THROW_ON_ERROR); echo json_encode(service($argv[2])->handle('status', [], $auth), JSON_THROW_ON_ERROR); }
    catch (Throwable $error) { fwrite(STDERR, get_class($error) . ': ' . $error->getMessage()); exit(1); }
    exit;
}

$root = sys_get_temp_dir() . '/yunhui-member-renewal-' . bin2hex(random_bytes(6)); mkdir($root, 0700, true);
$count = 0;
$test = static function (string $name, callable $run) use ($root, &$count): void {
    $dir = $root . '/' . (++$count); mkdir($dir, 0700, true); $run($dir); echo 'PASS ' . $name . PHP_EOL;
};

$test('login and 2FA preserve encrypted rotating credentials without the old one-hour limit', static function ($dir): void {
    $api = service($dir); $auth = credentials($api); $saved = row($dir, $auth);
    verify((int)$saved['access_expires_at'] >= time() + 86390 && (int)$saved['expires_at'] >= time() + 29 * 86400, 'Access and persistent session deadlines must be independent');
    verify($saved['upstream_refresh'] !== '' && !str_contains($saved['upstream_refresh'], 'rt_fixture_') && !str_contains($saved['upstream_token'], 'fixture-access-'), 'Both upstream tokens must be encrypted');
    $status = $api->handle('status', [], $auth);
    verify($status['canRefresh'] === true && !str_contains(json_encode($status), 'fixture-access-') && !str_contains(json_encode($status), 'rt_fixture_'), 'Only public renewal metadata leaves the service');
    $challenge = $api->handle('login', ['email' => 'user1@example.test', 'password' => '2fa'], device(2));
    verify($challenge['requires2fa'] === true, '2FA remains required');
    $login = $api->handle('login2fa', ['tempToken' => $challenge['tempToken'], 'totpCode' => '123456'], device(2));
    verify($login['canRefresh'] === true, 'Verified 2FA login must also support renewal');
});
$test('manual access-token binding honors JWT expiry and cannot acquire caller-supplied refresh authority', static function ($dir): void {
    $api = service($dir); $expiry = time() + 7200;
    $login = $api->handle('bind', ['accessToken' => jwt(1, $expiry), 'refresh_token' => 'forged-refresh'], device());
    verify(!$login['canRefresh'] && strtotime($login['expiresAt']) === $expiry, 'Manual binding must be honest about its actual expiry');
    $auth = array_merge(device(), ['sessionToken' => $login['sessionToken']]);
    ledger($dir)->exec('UPDATE member_sessions SET expires_at=' . (time() - 1));
    failure(fn() => $api->handle('status', [], $auth), 'SESSION_EXPIRED');
    verify(counter($dir, 'refresh') === 0, 'Manual token must never be sent to refresh');
    failure(fn() => $api->handle('bind', ['accessToken' => jwt(1, time() - 1)], device(2)), 'AUTH_REJECTED');
});
$test('expired access renews automatically and rotates once while retaining the installation session', static function ($dir): void {
    $api = service($dir); $auth = credentials($api); $before = row($dir, $auth); due($dir, $auth);
    $status = $api->handle('status', [], $auth); $after = row($dir, $auth);
    verify($status['member']['id'] === 1 && $status['canRefresh'], 'Renewed identity must remain pinned');
    verify($before['token_hash'] === $after['token_hash'] && $before['upstream_refresh'] !== $after['upstream_refresh'] && $before['upstream_token'] !== $after['upstream_token'], 'Only upstream pair rotates');
    $api->handle('groups', [], $auth);
    verify(counter($dir, 'refresh') === 1 && counter($dir, 'groups') === 1, 'Subsequent reads reuse the rotated pair');
    verify(!str_contains(json_encode($status), 'rt_fixture_'), 'Refresh token never appears in status');
});
$test('an upstream 401 before its declared expiry refreshes identity once before any operation', static function ($dir): void {
    $api = service($dir); $auth = credentials($api);
    upstream($dir)->exec("UPDATE tokens SET access='expired-access-fixture'");
    verify($api->handle('groups', [], $auth)['ok'], 'Upstream expiry should recover');
    verify(counter($dir, 'refresh') === 1 && counter($dir, 'groups') === 1, 'Only identity verification retries');
});
$test('temporary refresh failure preserves login for retry; definitive revocation removes it', static function ($dir): void {
    $auth = credentials(service($dir)); due($dir, $auth); $before = row($dir, $auth);
    failure(fn() => service($dir, 'offline-refresh')->handle('status', [], $auth), 'UPSTREAM_UNAVAILABLE');
    verify(row($dir, $auth) === $before, 'Network failure must not log the user out');
    verify(service($dir)->handle('status', [], $auth)['member']['id'] === 1, 'A later request recovers');
    due($dir, $auth);
    failure(fn() => service($dir, 'revoked')->handle('status', [], $auth), 'AUTH_REJECTED');
    verify(row($dir, $auth) === [], 'Revoked refresh must invalidate the membership session');
});
$test('a profile outage after rotation does not discard the replacement refresh token', static function ($dir): void {
    $auth = credentials(service($dir)); due($dir, $auth); $old = row($dir, $auth);
    failure(fn() => service($dir, 'profile-offline-after-refresh')->handle('status', [], $auth), 'UPSTREAM_UNAVAILABLE');
    verify(row($dir, $auth)['upstream_refresh'] !== $old['upstream_refresh'], 'Consumed refresh must be replaced before another network call');
    verify(service($dir)->handle('status', [], $auth)['member']['id'] === 1 && counter($dir, 'refresh') === 1, 'Retry uses the durable replacement');
});
$test('malformed rotation replies never replace the saved pair or expose upstream values', static function ($dir): void {
    foreach (['malformed', 'malformed-access', 'malformed-ttl'] as $index => $mode) {
        $auth = credentials(service($dir), $index + 1); due($dir, $auth); $before = row($dir, $auth);
        failure(fn() => service($dir, $mode)->handle('status', [], $auth), 'UPSTREAM_RESPONSE_INVALID');
        verify(row($dir, $auth) === $before, 'An incomplete or unsafe token pair must not overwrite stored credentials');
    }
});
$test('a refreshed token for another member is rejected and revoked before groups or side effects', static function ($dir): void {
    $auth = credentials(service($dir)); due($dir, $auth);
    failure(fn() => service($dir, 'wrong-user')->handle('groups', [], $auth), 'AUTH_REJECTED');
    verify(row($dir, $auth) === [] && counter($dir, 'groups') === 0 && counter($dir, 'logout') === 1, 'Mismatched identity must never authorize an operation');
});
$test('logout during rotation cannot recreate a deleted session', static function ($dir): void {
    $auth = credentials(service($dir)); due($dir, $auth);
    $api = service($dir, '', static function () use ($dir, $auth): void { service($dir)->handle('logout', [], $auth); });
    failure(fn() => $api->handle('status', [], $auth), 'SESSION_EXPIRED');
    verify(row($dir, $auth) === [] && (int)upstream($dir)->query('SELECT COUNT(*) FROM tokens')->fetchColumn() === 0, 'Old and late replacement refresh tokens are revoked');
});
$test('account switching during rotation cannot overwrite or revoke the newer login', static function ($dir): void {
    $auth = credentials(service($dir)); due($dir, $auth); $new = [];
    $api = service($dir, '', static function () use ($dir, &$new): void { $new = credentials(service($dir), 1, 2); });
    failure(fn() => $api->handle('status', [], $auth), 'SESSION_EXPIRED');
    verify(row($dir, $auth) === [] && service($dir)->handle('status', [], $new)['member']['id'] === 2, 'New member remains signed in');
    verify((int)ledger($dir)->query('SELECT COUNT(*) FROM member_sessions')->fetchColumn() === 1, 'No old session resurrection');
});
$test('installation binding remains mandatory for renewal and expired sessions can still log out', static function ($dir): void {
    $api = service($dir); $auth = credentials($api); due($dir, $auth);
    $bad = $auth; $bad['installationProof'] = str_repeat('0', 64);
    failure(fn() => $api->handle('status', [], $bad), 'INSTALLATION_MISMATCH');
    verify(counter($dir, 'refresh') === 0, 'Wrong installation cannot trigger rotation');
    ledger($dir)->exec('UPDATE member_sessions SET expires_at=' . (time() - 1));
    failure(fn() => $api->handle('status', [], $auth), 'SESSION_EXPIRED');
    $api->handle('logout', [], $auth);
    verify(row($dir, $auth) === [] && counter($dir, 'refresh') === 0 && counter($dir, 'logout') === 1, 'Logout revokes without attempting renewal');
});
$test('concurrent PHP processes share one rotation and all receive the same member', static function ($dir): void {
    $auth = credentials(service($dir)); due($dir, $auth); $file = $dir . '/credentials.json'; file_put_contents($file, json_encode($auth));
    $workers = [];
    for ($i = 0; $i < 8; $i++) {
        $command = [PHP_BINARY];
        if (PHP_OS_FAMILY === 'Windows') array_push($command, '-d', 'extension_dir=' . ini_get('extension_dir'), '-d', 'extension=pdo_sqlite', '-d', 'extension=openssl');
        array_push($command, __FILE__, '--worker', $dir, $file);
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        verify(is_resource($process), 'Could not launch isolated renewal worker'); fclose($pipes[0]); $workers[] = [$process, $pipes];
    }
    foreach ($workers as [$process, $pipes]) {
        $output = stream_get_contents($pipes[1]); $error = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
        verify(proc_close($process) === 0, 'Renewal worker failed: ' . $error . $output);
        verify((json_decode($output, true)['member']['id'] ?? null) === 1, 'Concurrent worker returned the wrong member');
    }
    verify(counter($dir, 'refresh') === 1, 'The single-use refresh credential must be rotated exactly once');
});
$test('legacy session migration preserves expiry and the complete monetary ledger', static function ($dir): void {
    $api = service($dir); $auth = credentials($api); unset($api); $db = ledger($dir);
    $oldExpiry = time() + 900; $db->exec('UPDATE member_sessions SET expires_at=' . $oldExpiry);
    $installation = $db->query('SELECT installation_hash FROM member_sessions')->fetchColumn();
    $q = $db->prepare("INSERT INTO welcome_grants(user_id,installation_hash,code,status,amount_cents,created_at,claimed_at) VALUES(1,?,'fixture-receipt','claimed',1000,?,?)"); $q->execute([$installation, time() - 10, time() - 5]);
    $gift = $db->query('SELECT * FROM welcome_grants')->fetch(PDO::FETCH_ASSOC);
    $db->exec("ALTER TABLE member_sessions DROP COLUMN upstream_refresh; ALTER TABLE member_sessions DROP COLUMN access_expires_at; DELETE FROM member_meta WHERE key='session_refresh_version'"); unset($db);
    $status = service($dir)->handle('status', [], $auth);
    verify(!$status['canRefresh'] && strtotime($status['expiresAt']) === $oldExpiry, 'Legacy login must retain its original lifetime without inventing refresh authority');
    verify(ledger($dir)->query('SELECT * FROM welcome_grants')->fetch(PDO::FETCH_ASSOC) === $gift, 'Authentication migration cannot alter grant evidence');
});

echo 'All ' . $count . ' member renewal integration tests passed. Fixtures: ' . $root . PHP_EOL;
