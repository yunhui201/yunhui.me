<?php
/** Offline monetary-policy integration tests. Temporary SQLite only; no accounts, network or real credit. */
declare(strict_types=1);
if (($argv[1] ?? '') === '--initialization-crash-worker') {
    // Inject an exit immediately after the real first schema COMMIT in a child.
    // This exercises process-restart recovery without adding production test hooks.
    $source = (string)file_get_contents(__DIR__ . '/../server/member_service.php');
    $commit = "\$db->exec('COMMIT');";
    $position = strpos($source, $commit);
    if ($position === false) exit(74);
    $source = substr_replace($source, $commit . ' exit(73);', $position, strlen($commit));
    eval(substr($source, 5));
    $config = json_decode((string)file_get_contents($argv[2]), true, 32, JSON_THROW_ON_ERROR);
    (new MemberService($config))->adminGiftPolicy();
    exit(75);
}
require __DIR__ . '/../server/member_service.php';

function verifyGift(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function giftError(callable $run, string $code): void
{
    try { $run(); } catch (MemberError $error) { verifyGift($error->errorCode === $code, 'Expected ' . $code . ', got ' . $error->errorCode); return; }
    throw new RuntimeException('Expected ' . $code);
}
function giftDb(string $path): PDO
{
    $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $db->exec('PRAGMA busy_timeout=10000');
    return $db;
}
function giftLedger(string $dir): PDO { return giftDb($dir . '/ledger/members.sqlite'); }
function giftConfig(string $dir): array
{
    return ['enabled' => true, 'origin' => 'https://members.example.test', 'adminKey' => 'fixture-policy-admin-key',
        'secret' => str_repeat('gift-policy-fixture-secret-', 3), 'dataDir' => $dir . '/ledger'];
}
function giftService(string $dir, string $mode = '', ?callable $intercept = null): MemberService
{
    $upstream = giftDb($dir . '/upstream.sqlite');
    $upstream->exec('CREATE TABLE IF NOT EXISTS codes(code TEXT PRIMARY KEY,user_id INTEGER UNIQUE,cents INTEGER NOT NULL)');
    return new MemberService(giftConfig($dir), static function (string $method, string $path, array $headers, ?array $body) use ($upstream, $mode, $intercept): array {
        $ok = static fn(array $value): array => ['status' => 200, 'body' => ['code' => 0, 'data' => $value]];
        if ($intercept) { $result = $intercept($method, $path, $headers, $body); if ($result !== null) return $result; }
        $user = 0;
        foreach ($headers as $header) if (preg_match('/^Authorization: Bearer fixture-user-([0-9]+)$/D', $header, $match)) $user = (int)$match[1];
        if ($path === '/auth/login') return $ok(['access_token' => 'fixture-user-1', 'expires_in' => 3600]);
        if ($path === '/auth/me') {
            verifyGift($user > 0, 'Only fixture identity accepted');
            $q = $upstream->prepare('SELECT COALESCE(SUM(cents),0) FROM codes WHERE user_id=?'); $q->execute([$user]);
            return $ok(['id' => $user, 'status' => 'active', 'email' => 'fixture@example.test', 'balance' => (int)$q->fetchColumn() / 100]);
        }
        if ($path === '/groups/available') return $ok([['id' => 7, 'platform' => 'openai', 'status' => 'active', 'name' => 'Fixture']]);
        if (str_starts_with($path, '/keys?')) return $ok(['items' => []]);
        if ($path === '/keys') return $ok(['id' => 7, 'user_id' => $user, 'group_id' => $body['group_id'], 'key' => $body['custom_key'], 'status' => 'active']);
        verifyGift(in_array('x-api-key: fixture-policy-admin-key', $headers, true), 'Admin operations keep trusted authorization');
        $receipt = static fn(array $row): array => ['id' => (int)$row['user_id'], 'code' => $row['code'], 'type' => 'balance',
            'value' => (int)$row['cents'] / 100, 'used_by' => (int)$row['user_id'], 'status' => 'used'];
        if (str_starts_with($path, '/admin/redeem-codes?')) {
            parse_str((string)parse_url($path, PHP_URL_QUERY), $query);
            $q = $upstream->prepare('SELECT * FROM codes WHERE code=?'); $q->execute([$query['search']]); $row = $q->fetch(PDO::FETCH_ASSOC);
            return $ok(['items' => $row ? [$receipt($row)] : [], 'total' => $row ? 1 : 0]);
        }
        verifyGift($path === '/admin/redeem-codes/create-and-redeem' && $method === 'POST', 'No unexpected upstream operation');
        verifyGift($body['type'] === 'balance' && in_array('Idempotency-Key: ' . $body['code'], $headers, true), 'Stable upstream grant identity');
        if ($mode === 'before-credit') throw new MemberError('UPSTREAM_UNAVAILABLE', 'fixture before credit', 503);
        $decimal = (string)$body['value'];
        verifyGift(preg_match('/^(\d+)(?:\.(\d{1,2}))?$/D', $decimal, $match) === 1, 'Exact cent request');
        $cents = (int)$match[1] * 100 + (int)str_pad($match[2] ?? '', 2, '0');
        $q = $upstream->prepare('INSERT OR IGNORE INTO codes VALUES(?,?,?)'); $q->execute([$body['code'], $body['user_id'], $cents]);
        $q = $upstream->prepare('SELECT * FROM codes WHERE code=?'); $q->execute([$body['code']]);
        if ($mode === 'after-credit') throw new MemberError('UPSTREAM_UNAVAILABLE', 'fixture after credit', 503);
        $result = $receipt($q->fetch(PDO::FETCH_ASSOC));
        if ($mode === 'mismatch') $result['value'] += 0.001;
        return $ok(['redeem_code' => $result]);
    });
}
function giftDevice(int $device): array { return ['installationId' => 'gift-policy-fixture-' . $device, 'installationProof' => hash('sha256', 'gift-device-' . $device)]; }
function giftLogin(MemberService $service, int $user = 1, ?int $device = null): array
{
    $credentials = giftDevice($device ?? $user);
    $login = $service->handle('bind', ['accessToken' => 'fixture-user-' . $user], $credentials, 'fixture-ip-' . $user);
    return $credentials + ['sessionToken' => $login['sessionToken']];
}
function setGift(MemberService $service, string $amount, bool $enabled = true, string $message = ''): array
{
    return $service->adminSaveGiftPolicy(['enabled' => $enabled, 'amountUsd' => $amount, 'message' => $message, 'revision' => $service->adminGiftPolicy()['revision']]);
}
function giftSnapshot(PDO $db, bool $omitPolicy = false): array
{
    $result = [];
    foreach ($db->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN) as $table) {
        $name = '"' . str_replace('"', '""', $table) . '"';
        $rows = $db->query('SELECT * FROM ' . $name . ($omitPolicy && $table === 'member_meta' ? " WHERE key NOT IN ('welcome_gift_policy','gift_policy_version')" : ''))->fetchAll(PDO::FETCH_NUM);
        $rows = array_map('serialize', $rows); sort($rows, SORT_STRING); $result[$table] = $rows;
    }
    return $result;
}
function makeLegacyGiftLedger(string $dir): array
{
    $service = giftService($dir);
    $first = giftLogin($service, 1); $service->handle('claim', [], $first);
    $second = giftLogin($service, 2);
    giftError(fn() => giftService($dir, 'before-credit')->handle('claim', [], $second), 'UPSTREAM_UNAVAILABLE');
    $third = giftLogin($service, 3);
    giftError(fn() => giftService($dir, 'mismatch')->handle('claim', [], $third), 'GRANT_REVIEW_REQUIRED');
    unset($service);
    $db = giftLedger($dir);
    $db->exec('PRAGMA foreign_keys=OFF');
    $db->exec("CREATE TABLE old_grants (user_id INTEGER PRIMARY KEY, installation_hash TEXT NOT NULL UNIQUE REFERENCES installations(id_hash), code TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','claimed','review')), amount_cents INTEGER NOT NULL CHECK(amount_cents=1000), created_at INTEGER NOT NULL, claimed_at INTEGER, upstream_id INTEGER, last_error TEXT, fixture_blob BLOB CHECK(length(fixture_blob)>0));
        INSERT INTO old_grants SELECT *, X'00FF4142' FROM welcome_grants;
        DROP TABLE welcome_grants;
        ALTER TABLE old_grants RENAME TO welcome_grants;
        DELETE FROM member_meta WHERE key IN ('welcome_gift_policy','gift_policy_version');
        CREATE INDEX fixture_grant_status ON welcome_grants(status,created_at);
        CREATE TABLE fixture_audit (payload BLOB);
        INSERT INTO fixture_audit VALUES(X'00FF'),(X'00FF');
        CREATE TRIGGER fixture_grant_update AFTER UPDATE ON welcome_grants BEGIN INSERT INTO fixture_audit VALUES(NEW.code); END;
        CREATE TABLE fixture_children (grant_id INTEGER REFERENCES welcome_grants(user_id) ON DELETE CASCADE,payload TEXT);
        INSERT INTO fixture_children VALUES(1,'child remains');
        CREATE VIEW fixture_grant_view AS SELECT user_id,status FROM welcome_grants;
        PRAGMA user_version=33;");
    return [$first, $second, $third];
}
function giftWorkerCommand(array $arguments): array
{
    $command = [PHP_BINARY];
    if (PHP_OS_FAMILY === 'Windows') array_push($command, '-d', 'extension_dir=' . ini_get('extension_dir'), '-d', 'extension=pdo_sqlite', '-d', 'extension=openssl');
    return array_merge($command, [__FILE__, '--worker'], $arguments);
}
if (($argv[1] ?? '') === '--worker') {
    try {
        $dir = $argv[2]; $kind = $argv[3];
        $input = json_decode((string)file_get_contents($argv[4]), true, 32, JSON_THROW_ON_ERROR);
        while (!is_file($dir . '/go')) usleep(10000);
        $service = giftService($dir);
        $result = $kind === 'save' ? $service->adminSaveGiftPolicy($input) : $service->handle('claim', [], $input);
        echo json_encode(['ok' => true, 'result' => $result], JSON_THROW_ON_ERROR);
    } catch (MemberError $error) { echo json_encode(['ok' => false, 'code' => $error->errorCode]); }
    catch (Throwable $error) { fwrite(STDERR, get_class($error) . ': ' . $error->getMessage()); exit(1); }
    exit;
}
function runGiftWorkers(string $dir, array $tasks): array
{
    @unlink($dir . '/go'); $workers = [];
    foreach ($tasks as $index => [$kind, $input]) {
        $file = $dir . '/worker-' . $index . '.json'; file_put_contents($file, json_encode($input, JSON_THROW_ON_ERROR));
        $process = proc_open(giftWorkerCommand([$dir, $kind, $file]), [0 => ['pipe','r'],1 => ['pipe','w'],2 => ['pipe','w']], $pipes);
        verifyGift(is_resource($process), 'Worker launched'); fclose($pipes[0]); $workers[] = [$process, $pipes];
    }
    file_put_contents($dir . '/go', 'go'); $results = [];
    foreach ($workers as [$process, $pipes]) {
        $stdout = stream_get_contents($pipes[1]); $stderr = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
        verifyGift(proc_close($process) === 0, 'Worker succeeded: ' . $stderr); $results[] = json_decode($stdout, true, 32, JSON_THROW_ON_ERROR);
    }
    return $results;
}

$root = sys_get_temp_dir() . '/yunhui-gift-policy-' . bin2hex(random_bytes(6)); mkdir($root, 0700, true); $tests = 0;
$test = static function (string $name, callable $run) use ($root, &$tests): void {
    $dir = $root . '/' . (++$tests); mkdir($dir, 0700); $run($dir); echo 'PASS ' . $name . PHP_EOL;
};

$test('default policy preserves ten-dollar campaign and public configuration without leaking authority', static function ($dir): void {
    $service = giftService($dir); $policy = $service->adminGiftPolicy();
    verifyGift($policy === ['enabled' => true, 'amountCents' => 1000, 'amountUsd' => 10, 'message' => '', 'revision' => 1], 'Compatible default');
    $config = $service->publicConfig();
    verifyGift($config['enabled'] && $config['giftEnabled'] && $config['giftUsd'] === 10 && $config['giftPolicyRevision'] === 1 && $config['currency'] === 'USD', 'Public policy');
    verifyGift(!str_contains(json_encode($config), 'fixture-policy-admin-key'), 'No authority exposed');
    $off = new MemberService(['enabled' => false, 'origin' => 'https://members.example.test']);
    verifyGift(!$off->publicConfig()['enabled'] && !$off->publicConfig()['giftEnabled'], 'Unconfigured public route needs no filesystem or database');
    foreach ([['enabled' => false], ['adminKey' => ''], ['secret' => ''], ['origin' => 'http://invalid.example.test']] as $change) {
        $config = array_merge(giftConfig($dir), ['dataDir' => $dir . '/unconfigured'], $change);
        $unconfigured = new MemberService($config);
        verifyGift(!$unconfigured->publicConfig()['enabled'], 'Invalid or disabled service is publicly unavailable');
        giftError(fn() => $unconfigured->adminGiftPolicy(), 'MEMBERS_DISABLED');
        giftError(fn() => $unconfigured->adminSaveGiftPolicy(['enabled'=>true,'amountUsd'=>'1','revision'=>1]), 'MEMBERS_DISABLED');
        verifyGift(!file_exists($config['dataDir']), 'Unconfigured administration never creates or binds a ledger');
    }
});
$test('process exit immediately after first schema commit preserves complete policy and allows normal restart', static function ($dir): void {
    $config = $dir . '/crash-config.json'; file_put_contents($config, json_encode(giftConfig($dir), JSON_THROW_ON_ERROR));
    $command = [PHP_BINARY];
    if (PHP_OS_FAMILY === 'Windows') array_push($command, '-d', 'extension_dir=' . ini_get('extension_dir'), '-d', 'extension=pdo_sqlite', '-d', 'extension=openssl');
    array_push($command, __FILE__, '--initialization-crash-worker', $config);
    $process = proc_open($command, [0 => ['pipe','r'],1 => ['pipe','w'],2 => ['pipe','w']], $pipes);
    verifyGift(is_resource($process), 'Crash worker started'); fclose($pipes[0]);
    $stdout=stream_get_contents($pipes[1]); $stderr=stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
    verifyGift(proc_close($process)===73, 'Exited at first committed initialization: '.$stderr.$stdout);
    $db=giftLedger($dir);
    verifyGift($db->query("SELECT value FROM member_meta WHERE key='gift_policy_version'")->fetchColumn()==='1','Policy version already durable at first commit');
    $policy=json_decode($db->query("SELECT value FROM member_meta WHERE key='welcome_gift_policy'")->fetchColumn(),true,16,JSON_THROW_ON_ERROR);
    verifyGift($policy['enabled'] && $policy['amountCents']===1000 && $policy['revision']===1,'Default policy committed with monetary tables');
    verifyGift($db->query("SELECT value FROM member_meta WHERE key='session_refresh_version'")->fetchColumn()===false,'Exit occurred before later session migration');
    $service=giftService($dir); verifyGift($service->adminGiftPolicy()['amountUsd']===10,'Restart opens complete initial ledger');
    verifyGift($service->handle('status',[],giftLogin($service))['gift']['status']==='eligible','Membership resumes normally');
    verifyGift(!is_dir($dir.'/ledger/backups'),'Fresh modern ledger does not enter legacy monetary migration');
});
$test('strict decimal validation accepts cent boundaries and rejects coercion and invalid fields without a write', static function ($dir): void {
    $service = giftService($dir);
    foreach (['0.01' => 1, '1.1' => 110, '10.29' => 1029, '10000.00' => 1000000] as $amount => $cents) verifyGift(setGift($service, (string)$amount)['amountCents'] === $cents, 'Exact cents');
    $before = $service->adminGiftPolicy();
    foreach (['0', '-1', '+1', '1e2', '1E1', '01', ' 1', '1 ', '.1', '1.', '1.001', '10000.01', '999999999999', '', true, null, 1, 1.5, [], INF, NAN] as $amount) {
        giftError(fn() => $service->adminSaveGiftPolicy(['enabled' => true, 'amountUsd' => $amount, 'revision' => $before['revision']]), 'INVALID_GIFT_POLICY');
    }
    foreach ([['enabled' => 1], ['revision' => '5'], ['message' => str_repeat('中',201)], ['message' => "\xff"], ['message' => "bad\0text"], ['message' => null], ['amountCents' => 1000]] as $change) {
        giftError(fn() => $service->adminSaveGiftPolicy(array_merge(['enabled' => true, 'amountUsd' => '5', 'revision' => $before['revision']], $change)), 'INVALID_GIFT_POLICY');
    }
    verifyGift($service->adminGiftPolicy() === $before, 'No malformed write');
    verifyGift(setGift($service, '5', true, str_repeat('中',200))['message'] === str_repeat('中',200), 'Unicode character limit');
});
$test('new grants use saved amounts and receipts and admin totals sum actual cents', static function ($dir): void {
    $service = giftService($dir); $campaign = $service->publicConfig()['campaign'];
    foreach (['12.34', '0.01', '10000.00'] as $index => $amount) {
        setGift($service, $amount, true, '后台说明'); $credentials = giftLogin($service, $index + 1);
        $result = $service->handle('claim', [], $credentials);
        verifyGift($result['gift']['amountUsd'] === $service->adminGiftPolicy()['amountUsd'], 'Stored amount returned');
        verifyGift($result['gift']['campaign'] === $campaign, 'Policy never changes campaign');
    }
    $overview = $service->adminOverview();
    verifyGift($overview['totals']['claimed'] === 3 && $overview['totals']['amountUsd'] === 10012.35, 'Actual total');
    verifyGift(array_sum(array_column($overview['grants'], 'amountCents')) === 1001235, 'Actual grant cents');
    foreach ($overview['grants'] as $grant) verifyGift($grant['amountUsd'] == $grant['amountCents'] / 100, 'Per-row actual amount');
});
$test('disabled gift policy leaves login groups and client key available and creates no new reservation', static function ($dir): void {
    $service = giftService($dir); setGift($service, '7.99', false, '赠金暂未开放');
    $device = giftDevice(1); $login = $service->handle('login', ['email' => 'fixture@example.test', 'password' => 'fixture'], $device);
    $credentials = $device + ['sessionToken' => $login['sessionToken']];
    verifyGift($login['gift']['status'] === 'disabled' && $login['gift']['amountUsd'] === 7.99 && $login['gift']['message'] === '赠金暂未开放', 'Disabled gift only');
    verifyGift($service->publicConfig()['enabled'] && !$service->publicConfig()['giftEnabled'], 'Membership remains active');
    verifyGift(count($service->handle('groups', [], $credentials)['groups']) === 1, 'Groups available');
    verifyGift($service->handle('create-client-key', ['groupId' => 7], $credentials)['ok'], 'Client key available');
    giftError(fn() => $service->handle('claim', [], $credentials), 'GIFT_DISABLED');
    verifyGift((int)giftLedger($dir)->query('SELECT COUNT(*) FROM welcome_grants')->fetchColumn() === 0, 'No reservation');
});
$test('pending recovery uses original amount after policy change and disable before or after upstream credit', static function ($dir): void {
    foreach (['before-credit','after-credit'] as $index => $mode) {
        $sub = $dir . '/' . $mode; mkdir($sub); $service = giftService($sub, $mode); setGift($service, '6.37'); $credentials = giftLogin($service);
        giftError(fn() => $service->handle('claim', [], $credentials), 'UPSTREAM_UNAVAILABLE');
        $row = giftLedger($sub)->query('SELECT * FROM welcome_grants')->fetch(PDO::FETCH_ASSOC);
        setGift($service, '99.99', false);
        verifyGift($service->handle('status', [], $credentials)['gift']['amountUsd'] === 6.37, 'Pending amount stays original');
        $result = giftService($sub)->handle('claim', [], $credentials);
        verifyGift($result['gift']['status'] === 'claimed' && $result['gift']['amountUsd'] === 6.37 && $result['gift']['code'] === $row['code'], 'Recovered original reservation');
        verifyGift((int)giftDb($sub . '/upstream.sqlite')->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 637, 'No replacement credit');
    }
});
$test('review and claimed records retain original amount while disabled and exact receipt mismatch is never rounded', static function ($dir): void {
    $service = giftService($dir, 'mismatch'); setGift($service, '4.21'); $credentials = giftLogin($service);
    giftError(fn() => $service->handle('claim', [], $credentials), 'GRANT_REVIEW_REQUIRED'); setGift($service, '20', false);
    $status = $service->handle('status', [], $credentials)['gift']; verifyGift($status['status'] === 'review' && $status['amountUsd'] === 4.21, 'Review preserves grant');
    giftError(fn() => $service->handle('claim', [], $credentials), 'GRANT_REVIEW_REQUIRED');
    $result = giftService($dir)->adminReconcile(1, false);
    verifyGift($result['gift']['status'] === 'claimed' && $result['gift']['amountUsd'] === 4.21, 'Read-only reconciliation of actual receipt');
    verifyGift($service->handle('status', [], $credentials)['gift']['amountUsd'] === 4.21, 'Claimed unaffected');
});
$test('client supplied policy and money cannot change a grant', static function ($dir): void {
    $service = giftService($dir); setGift($service, '2.13'); $credentials = giftLogin($service);
    foreach (['amountUsd' => '90', 'amount' => 9000, 'value' => 10, 'userId' => 90, 'giftEnabled' => true, 'amountCents' => 1, 'giftUsd' => 1, 'giftPolicyRevision' => 2, 'campaign' => 'new'] as $key => $value) giftError(fn() => $service->handle('claim', [$key => $value], $credentials), 'INVALID_FIELDS');
    verifyGift($service->handle('claim', [], $credentials)['gift']['amountUsd'] === 2.13, 'Untrusted fields have no authority');
});
$test('optimistic policy revisions reject stale saves and simultaneous writers commit only one', static function ($dir): void {
    $service = giftService($dir); $revision = $service->adminGiftPolicy()['revision'];
    $tasks = [];
    foreach (['3.01','4.02','5.03','6.04'] as $amount) $tasks[] = ['save',['enabled' => true, 'amountUsd' => $amount, 'message' => 'concurrent', 'revision' => $revision]];
    $results = runGiftWorkers($dir, $tasks);
    verifyGift(count(array_filter($results, static fn($row) => $row['ok'])) === 1, 'Only one CAS winner');
    foreach ($results as $row) if (!$row['ok']) verifyGift($row['code'] === 'GIFT_POLICY_CONFLICT', 'Only stale revision errors');
    verifyGift($service->adminGiftPolicy()['revision'] === $revision + 1, 'One revision increment');
});
$test('simultaneous disabling and claims serialize policy with one durable account installation reservation', static function ($dir): void {
    $service = giftService($dir); setGift($service, '8.73'); $credentials = giftLogin($service);
    $tasks = [['save',['enabled' => false, 'amountUsd' => '99.99', 'revision' => $service->adminGiftPolicy()['revision']]]];
    for ($i=0; $i<6; $i++) $tasks[] = ['claim',$credentials];
    $results = runGiftWorkers($dir, $tasks); verifyGift($results[0]['ok'], 'Disable save succeeds');
    $grants = giftLedger($dir)->query('SELECT * FROM welcome_grants')->fetchAll(PDO::FETCH_ASSOC);
    verifyGift(count($grants) <= 1, 'At most one reservation');
    foreach (array_slice($results,1) as $row) {
        if ($row['ok']) verifyGift($row['result']['gift']['status'] === 'claimed' && $row['result']['gift']['amountUsd'] === 8.73, 'Committed original policy');
        else verifyGift($row['code'] === 'GIFT_DISABLED', 'Only pre-reservation disabled result');
    }
    if ($grants) verifyGift((int)$grants[0]['amount_cents'] === 873 && (int)giftDb($dir . '/upstream.sqlite')->query('SELECT SUM(cents) FROM codes')->fetchColumn() === 873, 'Exactly original amount once');
    else verifyGift((int)giftDb($dir . '/upstream.sqlite')->query('SELECT COUNT(*) FROM codes')->fetchColumn() === 0, 'No grant after disable');
});
$test('policy changes and re-enabling never reset once-per-account or once-per-install eligibility', static function ($dir): void {
    $service = giftService($dir); setGift($service,'1.23'); $service->handle('claim', [], giftLogin($service,1,1));
    setGift($service,'90',false); setGift($service,'2.34',true);
    verifyGift($service->handle('claim', [], giftLogin($service,1,2))['gift']['amountUsd'] === 1.23, 'Account never receives twice');
    $other = giftLogin($service,2,1); verifyGift($service->handle('status', [], $other)['gift']['status'] === 'ineligible', 'Install stays used');
    giftError(fn() => $service->handle('claim', [], $other), 'INSTALLATION_ALREADY_CLAIMED');
    verifyGift((int)giftDb($dir . '/upstream.sqlite')->query('SELECT COUNT(*) FROM codes')->fetchColumn() === 1, 'One actual credit');
});
$test('policy changed during authentication uses the amount at reservation and later changes cannot alter fulfillment', static function ($dir): void {
    $admin = giftService($dir); setGift($admin,'3.21'); $credentials = giftLogin($admin); $changed = false;
    $service = giftService($dir, '', static function ($method,$path) use ($admin,&$changed) {
        if ($path === '/auth/me' && !$changed) { $changed=true; setGift($admin,'5.67'); }
        if (str_starts_with($path,'/admin/redeem-codes?')) setGift($admin,'99',false);
        return null;
    });
    $result = $service->handle('claim', [], $credentials);
    verifyGift($result['gift']['amountUsd'] === 5.67 && !$admin->adminGiftPolicy()['enabled'], 'Atomic reservation pins current policy');
    verifyGift((int)giftDb($dir.'/upstream.sqlite')->query('SELECT SUM(cents) FROM codes')->fetchColumn()===567,'Fulfillment uses reserved cents');
});
$test('changing an enabled policy races safely with repeated claims without a second amount or credit', static function ($dir): void {
    $service=giftService($dir); setGift($service,'2.46'); $credentials=giftLogin($service);
    $tasks=[['save',['enabled'=>true,'amountUsd'=>'7.89','revision'=>$service->adminGiftPolicy()['revision']]]];
    for($i=0;$i<5;$i++) $tasks[]=['claim',$credentials];
    $results=runGiftWorkers($dir,$tasks); verifyGift($results[0]['ok'],'Policy save committed');
    $grant=giftLedger($dir)->query('SELECT * FROM welcome_grants')->fetch(PDO::FETCH_ASSOC);
    verifyGift(in_array((int)$grant['amount_cents'],[246,789],true),'One coherent old or new amount');
    foreach(array_slice($results,1) as $result) verifyGift($result['ok'] && $result['result']['gift']['amountUsd']==(int)$grant['amount_cents']/100,'Every retry uses one reserved amount');
    $upstream=giftDb($dir.'/upstream.sqlite'); verifyGift((int)$upstream->query('SELECT COUNT(*) FROM codes')->fetchColumn()===1 && (int)$upstream->query('SELECT SUM(cents) FROM codes')->fetchColumn()===(int)$grant['amount_cents'],'Exactly one credit');
});
$test('legacy CHECK migration preserves every row byte value and all other tables indexes triggers foreign keys and views with private backup', static function ($dir): void {
    makeLegacyGiftLedger($dir); $db = giftLedger($dir); $before = giftSnapshot($db);
    $schema = $db->query("SELECT type,name,sql FROM sqlite_master WHERE name!='welcome_grants' ORDER BY type,name")->fetchAll(PDO::FETCH_ASSOC);
    $service = giftService($dir); verifyGift($service->adminGiftPolicy()['amountCents'] === 1000, 'Legacy default');
    verifyGift(giftSnapshot($db,true) === $before, 'All ciphertext, BLOBs, nulls and duplicate rows preserved');
    verifyGift($db->query("SELECT type,name,sql FROM sqlite_master WHERE name!='welcome_grants' ORDER BY type,name")->fetchAll(PDO::FETCH_ASSOC) === $schema, 'Other schema unchanged');
    verifyGift((int)$db->query('PRAGMA user_version')->fetchColumn() === 33 && !$db->query('PRAGMA foreign_key_check')->fetch(), 'Database metadata and foreign keys');
    $backups = glob($dir . '/ledger/backups/members-before-gift-policy-*.sqlite'); verifyGift(count($backups) === 1, 'One explicit private backup');
    $backup = giftDb($backups[0]); verifyGift(giftSnapshot($backup) === $before, 'Backup contains exact pre-migration values');
    verifyGift(str_contains($backup->query("SELECT sql FROM sqlite_master WHERE name='welcome_grants'")->fetchColumn(), 'CHECK(amount_cents=1000)'), 'Backup retains legacy schema');
    if (PHP_OS_FAMILY !== 'Windows') verifyGift((fileperms($backups[0]) & 0077) === 0, 'Backup permissions private');
    setGift($service,'1.11'); $new = giftLogin($service,4); verifyGift($service->handle('claim', [], $new)['gift']['amountUsd'] === 1.11, 'Migrated new grant supports variable amount');
    verifyGift((int)$db->query('SELECT COUNT(*) FROM fixture_children')->fetchColumn() === 1, 'No FK cascade');
    verifyGift((int)$db->query('SELECT COUNT(*) FROM fixture_audit')->fetchColumn() > 2, 'Original trigger remains active');
    foreach (["UPDATE welcome_grants SET amount_cents=0", "UPDATE welcome_grants SET amount_cents=1.5", "UPDATE welcome_grants SET status='invalid'", "UPDATE welcome_grants SET fixture_blob=X''", "UPDATE welcome_grants SET code='duplicate'"] as $sql) {
        try { $db->exec($sql); throw new RuntimeException('Missing original constraint'); } catch (PDOException $expected) { }
    }
    unset($service); verifyGift(giftService($dir)->adminGiftPolicy()['amountCents'] === 111 && count(glob($dir . '/ledger/backups/*.sqlite')) === 1, 'Version marker prevents repeat migration');
});
$test('backup failure leaves the legacy monetary ledger and policy untouched', static function ($dir): void {
    makeLegacyGiftLedger($dir); $db = giftLedger($dir); $before = giftSnapshot($db); $schema = $db->query("SELECT sql FROM sqlite_master WHERE name='welcome_grants'")->fetchColumn();
    file_put_contents($dir . '/ledger/backups','occupied');
    giftError(fn() => giftService($dir)->adminGiftPolicy(), 'STORAGE_UNAVAILABLE');
    verifyGift(giftSnapshot($db) === $before && $db->query("SELECT sql FROM sqlite_master WHERE name='welcome_grants'")->fetchColumn() === $schema, 'Backup failure cannot change ledger');
});
$test('migration failure rolls back every ledger change and keeps the validated recovery backup', static function ($dir): void {
    makeLegacyGiftLedger($dir); $db = giftLedger($dir); $db->exec('CREATE TABLE welcome_grants_gift_migration (fixture TEXT)'); $before = giftSnapshot($db);
    giftError(fn() => giftService($dir)->adminGiftPolicy(), 'STORAGE_UNAVAILABLE');
    verifyGift(giftSnapshot($db) === $before && str_contains($db->query("SELECT sql FROM sqlite_master WHERE name='welcome_grants'")->fetchColumn(),'CHECK(amount_cents=1000)'), 'Failed migration rolls back');
    $backups = glob($dir . '/ledger/backups/*.sqlite'); verifyGift(count($backups) === 1 && giftSnapshot(giftDb($backups[0])) === $before, 'Recovery backup retained');
});
$test('damaged or missing policy never falls back to an enabled promotion or resets the ledger', static function ($dir): void {
    $service = giftService($dir); $credentials = giftLogin($service); setGift($service,'7',false); $db = giftLedger($dir);
    $original = $db->query("SELECT value FROM member_meta WHERE key='welcome_gift_policy'")->fetchColumn();
    foreach (['not-json','{}','{"enabled":true,"amountCents":0,"message":"","revision":2}'] as $broken) {
        $q = $db->prepare("UPDATE member_meta SET value=? WHERE key='welcome_gift_policy'"); $q->execute([$broken]);
        giftError(fn() => $service->publicConfig(),'STORAGE_UNAVAILABLE'); giftError(fn() => $service->handle('claim', [], $credentials),'STORAGE_UNAVAILABLE');
        verifyGift($db->query("SELECT value FROM member_meta WHERE key='welcome_gift_policy'")->fetchColumn() === $broken, 'Corrupt data never overwritten');
    }
    $db->exec("DELETE FROM member_meta WHERE key='welcome_gift_policy'"); giftError(fn() => giftService($dir)->publicConfig(),'STORAGE_UNAVAILABLE');
    verifyGift((int)$db->query('SELECT COUNT(*) FROM welcome_grants')->fetchColumn() === 0, 'No grants from invalid policy');
    $q = $db->prepare("INSERT INTO member_meta VALUES('welcome_gift_policy',?)"); $q->execute([$original]);
    $db->exec("DELETE FROM member_meta WHERE key IN ('welcome_gift_policy','gift_policy_version')");
    giftError(fn() => giftService($dir)->publicConfig(),'STORAGE_UNAVAILABLE');
    verifyGift($db->query("SELECT value FROM member_meta WHERE key='welcome_gift_policy'")->fetchColumn() === false,'Missing modern policy never silently reset');
});
$test('missing or incomplete monetary ledger cannot be recreated during policy management', static function ($dir): void {
    $service=giftService($dir); $service->adminGiftPolicy(); $db=giftLedger($dir); $db->exec('DROP TABLE welcome_grants');
    giftError(fn()=>giftService($dir)->adminGiftPolicy(),'STORAGE_UNAVAILABLE');
    verifyGift($db->query("SELECT name FROM sqlite_master WHERE name='welcome_grants'")->fetchColumn()===false,'No empty replacement ledger');
});

echo 'All ' . $tests . ' member gift policy integration tests passed. Fixtures: ' . $root . PHP_EOL;
