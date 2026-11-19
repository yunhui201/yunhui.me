<?php
/** Installation-bound member sessions and one-time sub2api welcome credit. */
declare(strict_types=1);

final class MemberError extends RuntimeException
{
    public int $httpStatus;
    public string $errorCode;
    public function __construct(string $errorCode, string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->httpStatus = $status;
        $this->errorCode = $errorCode;
    }
}

final class MemberService
{
    private const GIFT_POLICY_KEY = 'welcome_gift_policy';
    private const GIFT_AMOUNT_CHECK = "CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 1000000)";
    private const CAMPAIGN = 'aurora-first-member-v1';
    private const SESSION_LIFETIME = 30 * 86400;
    private const REFRESH_MARGIN = 60;
    private array $config;
    private ?PDO $db = null;
    private $transport;

    public static function environment(): array
    {
        $file = '/www/aurora-data/member-secrets.json';
        $stored = [];
        if (is_file($file)) {
            if (is_link($file) || (fileperms($file) & 0077) !== 0) throw new RuntimeException('Member secrets permissions must be 0600');
            $stored = json_decode((string)file_get_contents($file), true, 16, JSON_THROW_ON_ERROR);
            if (!is_array($stored)) throw new RuntimeException('Invalid member secrets');
        }
        $setting = static function (string $environment, string $field, $fallback) use ($stored) {
            $value = getenv($environment);
            return $value !== false ? $value : ($stored[$field] ?? $fallback);
        };
        return [
            'enabled' => in_array($setting('AURORA_MEMBERS_ENABLED', 'enabled', false), [true, '1'], true),
            'origin' => rtrim((string)$setting('AURORA_SUB2API_URL', 'origin', 'https://api.yunhui.me'), '/'),
            'adminKey' => (string)$setting('AURORA_SUB2API_ADMIN_KEY', 'adminKey', ''),
            'secret' => (string)$setting('AURORA_MEMBER_SECRET', 'secret', ''),
            'dataDir' => (string)$setting('AURORA_MEMBER_DATA_DIR', 'dataDir', '/www/aurora-data/members'),
        ];
    }

    /** A transport can only be injected by trusted PHP code, never an HTTP parameter. */
    public function __construct(array $config, ?callable $transport = null)
    {
        $this->config = $config;
        $this->transport = $transport;
    }

    public function publicConfig(): array
    {
        $policy = $this->configured() ? $this->adminGiftPolicy() : $this->defaultGiftPolicy();
        return ['ok' => true, 'enabled' => $this->configured(), 'giftEnabled' => $this->configured() && $policy['enabled'],
            'giftUsd' => $policy['amountUsd'], 'giftMessage' => $policy['message'], 'giftPolicyRevision' => $policy['revision'],
            'currency' => 'USD', 'accountUrl' => $this->validOrigin() ? $this->config['origin'] : 'https://api.yunhui.me',
            'campaign' => self::CAMPAIGN];
    }

    private function defaultGiftPolicy(): array
    {
        return ['enabled' => true, 'amountCents' => 1000, 'amountUsd' => 10, 'message' => '', 'revision' => 1];
    }

    private function dollars(int $cents): int|float
    {
        return $cents % 100 === 0 ? intdiv($cents, 100) : $cents / 100;
    }

    /** Parse decimal text without floating-point rounding or exponent coercion. */
    private function decimalCents($value): ?int
    {
        if (is_int($value)) $value = (string)$value;
        if (!is_string($value) || !preg_match('/^(0|[1-9][0-9]{0,4})(?:\.([0-9]{1,2}))?$/D', $value, $match)) return null;
        $cents = (int)$match[1] * 100 + (int)str_pad($match[2] ?? '', 2, '0');
        return $cents >= 1 && $cents <= 1000000 ? $cents : null;
    }

    private function receiptCents($value): ?int
    {
        // JSON upstream amounts may be numbers; stringify the exact decoded value,
        // never round a mismatched fraction into a valid receipt.
        if (is_float($value)) {
            if (!is_finite($value)) return null;
            $value = json_encode($value, JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR);
        }
        return $this->decimalCents($value);
    }

    /** These administrator methods must remain behind the web session and CSRF gate. */
    public function adminGiftPolicy(): array
    {
        if (!$this->configured()) throw new MemberError('MEMBERS_DISABLED', '会员服务尚未启用', 503);
        $raw = $this->execute('SELECT value FROM member_meta WHERE key=?', [self::GIFT_POLICY_KEY])->fetchColumn();
        try { $policy = $raw === false ? null : json_decode($raw, true, 16, JSON_THROW_ON_ERROR); }
        catch (Throwable $error) { $policy = null; }
        if (!is_array($policy) || !is_bool($policy['enabled'] ?? null) || !is_int($policy['amountCents'] ?? null)
            || $policy['amountCents'] < 1 || $policy['amountCents'] > 1000000 || !is_string($policy['message'] ?? null)
            || !is_int($policy['revision'] ?? null) || $policy['revision'] < 1 || !$this->validGiftMessage($policy['message'])) {
            throw new MemberError('STORAGE_UNAVAILABLE', '赠金设置记录异常，请联系管理员恢复备份', 503);
        }
        return ['enabled' => $policy['enabled'], 'amountCents' => $policy['amountCents'],
            'amountUsd' => $this->dollars($policy['amountCents']), 'message' => $policy['message'], 'revision' => $policy['revision']];
    }

    private function validGiftMessage(string $message): bool
    {
        return strlen($message) <= 800 && preg_match('//u', $message) === 1
            && !preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/', $message)
            && preg_match_all('/./us', $message) <= 200;
    }

    public function adminSaveGiftPolicy(array $input): array
    {
        if (!$this->configured()) throw new MemberError('MEMBERS_DISABLED', '会员服务尚未启用', 503);
        if (array_diff(array_keys($input), ['enabled', 'amountUsd', 'message', 'revision'])
            || !is_bool($input['enabled'] ?? null) || !is_string($input['amountUsd'] ?? null)
            || ($cents = $this->decimalCents($input['amountUsd'])) === null
            || (array_key_exists('message', $input) && !is_string($input['message'])) || !$this->validGiftMessage($input['message'] ?? '')
            || !is_int($input['revision'] ?? null) || $input['revision'] < 1 || $input['revision'] >= PHP_INT_MAX) {
            throw new MemberError('INVALID_GIFT_POLICY', '请输入有效开关、0.01 至 10000 美元的金额（最多两位小数）和不超过 200 字的说明');
        }
        return $this->transaction(function () use ($input, $cents): array {
            $current = $this->adminGiftPolicy();
            if ($current['revision'] !== $input['revision']) throw new MemberError('GIFT_POLICY_CONFLICT', '赠金设置已被其他管理员更新，请刷新后重试', 409);
            $next = ['enabled' => $input['enabled'], 'amountCents' => $cents, 'message' => $input['message'] ?? '', 'revision' => $current['revision'] + 1];
            $this->execute('UPDATE member_meta SET value=? WHERE key=?', [json_encode($next, JSON_THROW_ON_ERROR), self::GIFT_POLICY_KEY]);
            return $this->adminGiftPolicy();
        });
    }

    private function validOrigin(): bool
    {
        $url = parse_url((string)($this->config['origin'] ?? ''));
        return is_array($url) && ($url['scheme'] ?? '') === 'https' && !empty($url['host'])
            && !isset($url['user']) && !isset($url['pass'])
            && !isset($url['query']) && !isset($url['fragment']) && empty($url['path'])
            && (!isset($url['port']) || $url['port'] === 443);
    }

    private function configured(): bool
    {
        return ($this->config['enabled'] ?? false) === true && $this->validOrigin()
            && strlen((string)($this->config['adminKey'] ?? '')) >= 12
            && strlen((string)($this->config['secret'] ?? '')) >= 32;
    }

    private function database(): PDO
    {
        if ($this->db) return $this->db;
        umask(0077);
        $dir = (string)($this->config['dataDir'] ?? '');
        if ($dir === '' || (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir))) {
            throw new MemberError('STORAGE_UNAVAILABLE', '会员存储暂不可用', 503);
        }
        // Serialize first initialization before testing existence. A concurrent process must not
        // mistake the first process's newly created empty SQLite file for a damaged ledger.
        $lock = @fopen($dir . '/members-init.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX)) {
            if ($lock) fclose($lock);
            throw new MemberError('STORAGE_UNAVAILABLE', '会员存储暂不可用', 503);
        }
        try {
            $path = $dir . '/members.sqlite';
            $marker = $dir . '/members.initialized';
            clearstatcache(true, $path);
            clearstatcache(true, $marker);
            if (is_file($marker) && !is_file($path)) throw new MemberError('STORAGE_UNAVAILABLE', '会员账本缺失，请联系管理员恢复备份', 503);
            if (is_link($path) || is_link($marker) || (file_exists($path) && (!is_file($path) || filesize($path) === 0))) {
                throw new MemberError('STORAGE_UNAVAILABLE', '会员账本异常，请联系管理员恢复备份', 503);
            }
            $existing = is_file($path);
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $db->exec('PRAGMA busy_timeout=10000');
            if ($existing) {
                // Never repair missing monetary tables with CREATE IF NOT EXISTS: doing so would
                // erase the evidence that an account or installation already received its gift.
                $schema = [
                    'member_meta' => ['key', 'value'],
                    'installations' => ['id_hash', 'proof_hash', 'created_at'],
                    'member_sessions' => ['token_hash', 'installation_hash', 'user_id', 'profile', 'upstream_token', 'expires_at'],
                    'welcome_grants' => ['user_id', 'installation_hash', 'code', 'status', 'amount_cents', 'created_at', 'claimed_at', 'upstream_id', 'last_error'],
                    'member_rate_limits' => ['key', 'window_start', 'attempts'],
                ];
                foreach ($schema as $table => $columns) {
                    $actual = array_column($db->query('PRAGMA table_info(' . $table . ')')->fetchAll(PDO::FETCH_ASSOC), 'name');
                    if (array_diff($columns, $actual)) throw new MemberError('STORAGE_UNAVAILABLE', '会员账本结构不完整，请联系管理员恢复备份', 503);
                }
                $origin = $db->query("SELECT value FROM member_meta WHERE key='upstream_origin'")->fetchColumn();
                if ($origin === false) throw new MemberError('STORAGE_UNAVAILABLE', '会员账本来源记录缺失，请联系管理员恢复备份', 503);
                if (!hash_equals((string)$origin, $this->config['origin'])) throw new MemberError('UPSTREAM_CHANGED', '会员站点变更需要管理员迁移账本', 503);
            }
            $db->exec('PRAGMA journal_mode=WAL');
            $db->exec('PRAGMA synchronous=FULL');
            $db->exec('PRAGMA foreign_keys=ON');
            if (!$existing) {
                $db->exec('BEGIN IMMEDIATE');
                try {
                    $db->exec('CREATE TABLE IF NOT EXISTS member_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS installations (id_hash TEXT PRIMARY KEY, proof_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS member_sessions (token_hash TEXT PRIMARY KEY, installation_hash TEXT NOT NULL REFERENCES installations(id_hash), user_id INTEGER NOT NULL, profile TEXT NOT NULL, upstream_token TEXT NOT NULL, expires_at INTEGER NOT NULL);
                    CREATE INDEX IF NOT EXISTS member_sessions_expiry ON member_sessions(expires_at);
                    CREATE TABLE IF NOT EXISTS welcome_grants (user_id INTEGER PRIMARY KEY, installation_hash TEXT NOT NULL UNIQUE REFERENCES installations(id_hash), code TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN (\'pending\',\'claimed\',\'review\')), amount_cents INTEGER NOT NULL ' . self::GIFT_AMOUNT_CHECK . ', created_at INTEGER NOT NULL, claimed_at INTEGER, upstream_id INTEGER, last_error TEXT);
                    CREATE TABLE IF NOT EXISTS member_rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);');
                    $statement = $db->prepare("INSERT INTO member_meta(key,value) VALUES('upstream_origin',?)");
                    $statement->execute([$this->config['origin']]);
                    // A fresh ledger must never commit the modern amount constraint without
                    // its policy: a process exit here must leave a usable complete first state.
                    $policy = $this->defaultGiftPolicy();
                    unset($policy['amountUsd']);
                    $statement = $db->prepare('INSERT INTO member_meta(key,value) VALUES(?,?)');
                    $statement->execute([self::GIFT_POLICY_KEY, json_encode($policy, JSON_THROW_ON_ERROR)]);
                    $db->exec("INSERT INTO member_meta(key,value) VALUES('gift_policy_version','1')");
                    $db->exec('COMMIT');
                } catch (Throwable $error) { $db->exec('ROLLBACK'); throw $error; }
            }
            $this->initializeGiftPolicy($db, $dir);
            // Migrate authentication metadata only after verifying the complete monetary ledger.
            // Old sessions have no recoverable refresh token and retain their original expiry.
            $columns = array_column($db->query('PRAGMA table_info(member_sessions)')->fetchAll(PDO::FETCH_ASSOC), 'name');
            $sessionSchema = $db->query("SELECT value FROM member_meta WHERE key='session_refresh_version'")->fetchColumn();
            if ($sessionSchema !== false) {
                if ($sessionSchema !== '1' || array_diff(['upstream_refresh', 'access_expires_at'], $columns)) {
                    throw new MemberError('STORAGE_UNAVAILABLE', '会员登录存储结构不完整，请联系管理员恢复备份', 503);
                }
            } else {
                $db->exec('BEGIN IMMEDIATE');
                try {
                    if (!in_array('upstream_refresh', $columns, true)) $db->exec("ALTER TABLE member_sessions ADD COLUMN upstream_refresh TEXT NOT NULL DEFAULT ''");
                    if (!in_array('access_expires_at', $columns, true)) $db->exec('ALTER TABLE member_sessions ADD COLUMN access_expires_at INTEGER NOT NULL DEFAULT 0');
                    $db->exec('UPDATE member_sessions SET access_expires_at=expires_at WHERE access_expires_at=0');
                    $db->exec("INSERT INTO member_meta(key,value) VALUES('session_refresh_version','1')");
                    $db->exec('COMMIT');
                } catch (Throwable $error) { $db->exec('ROLLBACK'); throw $error; }
            }
            @chmod($path, 0600);
            $markerContents = "aurora-members-v1\n";
            if (!is_file($marker) && @file_put_contents($marker, $markerContents, LOCK_EX) !== strlen($markerContents)) {
                throw new MemberError('STORAGE_UNAVAILABLE', '无法确认会员账本状态', 503);
            }
            // Cache only a fully verified and durably initialized connection.
            return $this->db = $db;
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /** Called only with members-init.lock held and after the complete ledger was verified. */
    private function initializeGiftPolicy(PDO $db, string $dir): void
    {
        $version = $db->query("SELECT value FROM member_meta WHERE key='gift_policy_version'")->fetchColumn();
        $schema = (string)$db->query("SELECT sql FROM sqlite_master WHERE type='table' AND name='welcome_grants'")->fetchColumn();
        $hasPolicy = $db->query("SELECT value FROM member_meta WHERE key='" . self::GIFT_POLICY_KEY . "'")->fetchColumn() !== false;
        if ($version !== false) {
            if ($version !== '1' || !str_contains($schema, self::GIFT_AMOUNT_CHECK) || !$hasPolicy) {
                throw new MemberError('STORAGE_UNAVAILABLE', '赠金账本结构异常，请联系管理员恢复备份', 503);
            }
            return;
        }
        if ($hasPolicy) throw new MemberError('STORAGE_UNAVAILABLE', '赠金设置版本记录缺失，请联系管理员恢复备份', 503);
        $replacement = preg_replace('/CHECK\s*\(\s*amount_cents\s*=\s*1000\s*\)/i', self::GIFT_AMOUNT_CHECK, $schema, -1, $count);
        if ($count === 0) {
            throw new MemberError('STORAGE_UNAVAILABLE', '赠金账本金额约束异常，请联系管理员恢复备份', 503);
        }
        if ($count > 1) throw new MemberError('STORAGE_UNAVAILABLE', '赠金账本金额约束异常，请联系管理员恢复备份', 503);
        $backupAttached = false;
        $begun = false;
        $foreignKeys = (int)$db->query('PRAGMA foreign_keys')->fetchColumn();
        $legacyAlter = (int)$db->query('PRAGMA legacy_alter_table')->fetchColumn();
        try {
            if ($count === 1) {
                if ($db->query('PRAGMA quick_check')->fetchColumn() !== 'ok' || $db->query('PRAGMA foreign_key_check')->fetch()) {
                    throw new RuntimeException('Ledger integrity failure');
                }
                $backupDir = $dir . '/backups';
                if (is_link($backupDir) || (file_exists($backupDir) && !is_dir($backupDir))
                    || (!is_dir($backupDir) && !@mkdir($backupDir, 0700)) || !@chmod($backupDir, 0700)) {
                    throw new RuntimeException('Private backup directory unavailable');
                }
                $backup = $backupDir . '/members-before-gift-policy-' . gmdate('Ymd-His') . '-' . bin2hex(random_bytes(8)) . '.sqlite';
                // VACUUM INTO includes committed WAL pages in one coherent SQLite snapshot.
                // It never opens/truncates an existing backup and must succeed before mutation.
                $db->exec('VACUUM INTO ' . $db->quote($backup));
                if (!is_file($backup) || is_link($backup) || !@chmod($backup, 0600)
                    || (PHP_OS_FAMILY !== 'Windows' && (fileperms($backup) & 0077) !== 0)) {
                    throw new RuntimeException('Private SQLite backup unavailable');
                }
                $backupHandle = @fopen($backup, 'r+b');
                if (!$backupHandle) throw new RuntimeException('Backup verification unavailable');
                try { if (!fsync($backupHandle)) throw new RuntimeException('Backup persistence failed'); }
                finally { fclose($backupHandle); }
                $db->exec('ATTACH DATABASE ' . $db->quote($backup) . ' AS gift_backup');
                $backupAttached = true;
                if ($db->query('PRAGMA gift_backup.quick_check')->fetchColumn() !== 'ok') throw new RuntimeException('Backup integrity failure');
                // Foreign keys are checked again before commit. Disabling enforcement prevents
                // DROP TABLE from cascading into other ledger tables during the schema swap.
                $db->exec('PRAGMA foreign_keys=OFF');
                $db->exec('PRAGMA legacy_alter_table=ON');
            }
            $db->exec('BEGIN IMMEDIATE');
            $begun = true;
            if ($count === 1) {
                $beforeSchema = $db->query('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name')->fetchAll(PDO::FETCH_ASSOC);
                $backupSchema = $db->query('SELECT type,name,tbl_name,sql FROM gift_backup.sqlite_master ORDER BY type,name')->fetchAll(PDO::FETCH_ASSOC);
                if ($beforeSchema !== $backupSchema) throw new RuntimeException('Ledger changed since backup');
                // Existing workers can still use an already-open PDO. A post-backup write must
                // make us retry, never migrate newer data using an out-of-date recovery copy.
                $tables = $db->query("SELECT name FROM main.sqlite_master WHERE type='table'")->fetchAll(PDO::FETCH_COLUMN);
                foreach ($tables as $table) if ($this->tableDigest($db, 'main', $table) !== $this->tableDigest($db, 'gift_backup', $table)) throw new RuntimeException('Ledger changed since backup');
                $objects = $db->query("SELECT sql FROM sqlite_master WHERE tbl_name='welcome_grants' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")->fetchAll(PDO::FETCH_COLUMN);
                $columns = $db->query('PRAGMA table_xinfo(welcome_grants)')->fetchAll(PDO::FETCH_ASSOC);
                $writeColumns = array_map(static fn(array $column): string => '"' . str_replace('"', '""', $column['name']) . '"',
                    array_values(array_filter($columns, static fn(array $column): bool => (int)$column['hidden'] === 0)));
                $temporary = 'welcome_grants_gift_migration';
                if ($db->query("SELECT 1 FROM sqlite_master WHERE name='" . $temporary . "'")->fetchColumn()) throw new RuntimeException('Migration table conflict');
                $create = preg_replace('/^CREATE\s+TABLE\s+(?:"welcome_grants"|`welcome_grants`|\[welcome_grants\]|welcome_grants)(?=\s*\()/i', 'CREATE TABLE ' . $temporary, $replacement, 1, $renamed);
                if ($renamed !== 1) throw new RuntimeException('Unsupported grant schema');
                $db->exec($create);
                $columnList = implode(',', $writeColumns);
                $db->exec('INSERT INTO ' . $temporary . '(' . $columnList . ') SELECT ' . $columnList . ' FROM welcome_grants');
                $db->exec('DROP TABLE welcome_grants');
                $db->exec('ALTER TABLE ' . $temporary . ' RENAME TO welcome_grants');
                foreach ($objects as $sql) $db->exec($sql);
                foreach ($tables as $table) if ($this->tableDigest($db, 'main', $table) !== $this->tableDigest($db, 'gift_backup', $table)) throw new RuntimeException('Migrated ledger data differs');
                $otherSchema = static fn(array $rows): array => array_values(array_filter($rows, static fn(array $row): bool => !($row['type'] === 'table' && $row['name'] === 'welcome_grants')));
                if ($otherSchema($beforeSchema) !== $otherSchema($db->query('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name')->fetchAll(PDO::FETCH_ASSOC))) {
                    throw new RuntimeException('Unrelated ledger schema changed');
                }
                if ($db->query('PRAGMA foreign_key_check')->fetch() || $db->query('PRAGMA quick_check')->fetchColumn() !== 'ok') {
                    throw new RuntimeException('Migrated ledger verification failed');
                }
            }
            $policy = $this->defaultGiftPolicy();
            unset($policy['amountUsd']);
            $statement = $db->prepare('INSERT INTO member_meta(key,value) VALUES(?,?)');
            $statement->execute([self::GIFT_POLICY_KEY, json_encode($policy, JSON_THROW_ON_ERROR)]);
            $db->exec("INSERT INTO member_meta(key,value) VALUES('gift_policy_version','1')");
            $db->exec('COMMIT');
            $begun = false;
        } catch (Throwable $error) {
            if ($begun) $db->exec('ROLLBACK');
            throw new MemberError('STORAGE_UNAVAILABLE', '赠金账本升级未完成，原账本已保留，请联系管理员检查备份后重试', 503);
        } finally {
            if ($backupAttached) $db->exec('DETACH DATABASE gift_backup');
            $db->exec('PRAGMA foreign_keys=' . $foreignKeys);
            $db->exec('PRAGMA legacy_alter_table=' . $legacyAlter);
        }
    }

    /** Order-independent, duplicate-sensitive snapshot of exact SQLite cell values. */
    private function tableDigest(PDO $db, string $schema, string $table): string
    {
        $rows = [];
        $statement = $db->query('SELECT * FROM ' . $schema . '."' . str_replace('"', '""', $table) . '"');
        while ($row = $statement->fetch(PDO::FETCH_NUM)) $rows[] = hash('sha256', serialize($row));
        $statement->closeCursor();
        sort($rows, SORT_STRING);
        return hash('sha256', implode('', $rows));
    }

    private function execute(string $sql, array $parameters = []): PDOStatement
    {
        $q = $this->database()->prepare($sql);
        $q->execute($parameters);
        return $q;
    }

    private function transaction(callable $run)
    {
        $db = $this->database();
        $db->exec('BEGIN IMMEDIATE');
        try {
            $result = $run();
            $db->exec('COMMIT');
            return $result;
        } catch (Throwable $error) {
            $db->exec('ROLLBACK');
            throw $error;
        }
    }

    private function rateLimit(string $kind, string $identity, int $limit, int $window): void
    {
        $key = hash_hmac('sha256', $kind . ':' . $identity, $this->config['secret']);
        $this->transaction(function () use ($key, $limit, $window): void {
            $row = $this->execute('SELECT * FROM member_rate_limits WHERE key=?', [$key])->fetch(PDO::FETCH_ASSOC);
            $now = time();
            if ($row && $row['window_start'] > $now - $window && $row['attempts'] >= $limit) {
                throw new MemberError('RATE_LIMITED', '请求过于频繁，请稍后再试', 429);
            }
            $fresh = !$row || $row['window_start'] <= $now - $window;
            $this->execute('INSERT OR REPLACE INTO member_rate_limits(key,window_start,attempts) VALUES(?,?,?)',
                [$key, $fresh ? $now : $row['window_start'], $fresh ? 1 : $row['attempts'] + 1]);
            $this->execute('DELETE FROM member_rate_limits WHERE window_start<?', [$now - 86400]);
        });
    }

    private function installation(array $credentials, bool $create): string
    {
        $id = (string)($credentials['installationId'] ?? '');
        $proof = (string)($credentials['installationProof'] ?? '');
        if (!preg_match('/^[a-zA-Z0-9_-]{16,80}$/D', $id) || !preg_match('/^[a-f0-9]{64}$/D', $proof)) {
            throw new MemberError('INSTALLATION_REQUIRED', '客户端安装凭据无效', 401);
        }
        $idHash = hash('sha256', $id);
        $proofHash = hash('sha256', $proof);
        $this->transaction(function () use ($idHash, $proofHash, $create): void {
            $row = $this->execute('SELECT proof_hash FROM installations WHERE id_hash=?', [$idHash])->fetch(PDO::FETCH_ASSOC);
            if (!$row && $create) {
                $this->execute('INSERT INTO installations(id_hash,proof_hash,created_at) VALUES(?,?,?)', [$idHash, $proofHash, time()]);
            } elseif (!$row || !hash_equals($row['proof_hash'], $proofHash)) {
                throw new MemberError('INSTALLATION_MISMATCH', '客户端安装凭据不匹配', 401);
            }
        });
        return $idHash;
    }

    private function seal(string $token): string
    {
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt($token, 'aes-256-gcm', hash('sha256', $this->config['secret'], true), OPENSSL_RAW_DATA, $iv, $tag, self::CAMPAIGN);
        if ($cipher === false) throw new RuntimeException('Token encryption failed');
        return base64_encode($iv . $tag . $cipher);
    }

    private function unseal(string $value): string
    {
        $bytes = base64_decode($value, true);
        $token = $bytes !== false && strlen($bytes) > 28
            ? openssl_decrypt(substr($bytes, 28), 'aes-256-gcm', hash('sha256', $this->config['secret'], true), OPENSSL_RAW_DATA, substr($bytes, 0, 12), substr($bytes, 12, 16), self::CAMPAIGN) : false;
        if ($token === false) throw new MemberError('SESSION_EXPIRED', '会员登录已失效，请重新登录', 401);
        return $token;
    }

    private function requestStage(string $method, string $path): string
    {
        if ($path === '/admin/redeem-codes/create-and-redeem') return '发放赠金';
        if (str_starts_with($path, '/admin/redeem-codes?')) return '核对赠金凭据';
        if ($path === '/keys' && $method === 'POST') return '创建客户端密钥';
        if (str_starts_with($path, '/keys?')) return '核对客户端密钥';
        if ($path === '/groups/available') return '读取会员分组';
        if ($path === '/auth/me') return '验证会员身份';
        if ($path === '/auth/refresh') return '续期会员登录';
        if ($path === '/auth/logout') return '退出会员登录';
        return '会员登录';
    }

    private function request(string $method, string $path, array $headers, ?array $body = null): array
    {
        $stage = $this->requestStage($method, $path);
        if ($this->transport) {
            $response = ($this->transport)($method, $path, $headers, $body);
        } else {
            if (!function_exists('curl_init')) throw new MemberError('UPSTREAM_UNAVAILABLE', '会员服务暂不可用', 503);
            $curl = curl_init($this->config['origin'] . '/api/v1' . $path);
            $buffer = '';
            curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_HTTPHEADER => array_merge(['Accept: application/json', 'Content-Type: application/json'], $headers),
                CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 25, CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_RETURNTRANSFER => false,
                CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$buffer): int {
                    if (strlen($buffer) + strlen($chunk) > 1048576) return 0;
                    $buffer .= $chunk;
                    return strlen($chunk);
                }]);
            if ($body !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($body, JSON_THROW_ON_ERROR));
            $success = curl_exec($curl);
            $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            curl_close($curl);
            if ($success === false) throw new MemberError('UPSTREAM_UNAVAILABLE', $stage . '时连接中断，可稍后安全重试', 503);
            $response = ['status' => $status, 'body' => json_decode($buffer, true)];
        }
        $status = (int)($response['status'] ?? 0);
        $payload = $response['body'] ?? null;
        if ($status < 200 || $status >= 300 || !is_array($payload) || ($payload['code'] ?? null) !== 0 || !is_array($payload['data'] ?? null)) {
            // Only known reason constants affect classification; upstream text, URLs and metadata never leave the server.
            $reason = is_array($payload) ? ($payload['reason'] ?? $payload['code'] ?? null) : null;
            $admin = str_starts_with($path, '/admin/');
            if ($admin && in_array($status, [401, 403], true)) throw new MemberError('UPSTREAM_ADMIN_AUTH_REJECTED', $stage . '失败：平台管理凭据无效或权限不足，请联系平台管理员', 503);
            if ($admin && $status === 423 && $reason === 'ADMIN_COMPLIANCE_ACK_REQUIRED') throw new MemberError('UPSTREAM_ADMIN_ACTION_REQUIRED', '平台管理功能尚待管理员确认，赠金暂未处理，请联系平台管理员', 503);
            if ($path === '/keys' && $method === 'POST' && $status >= 400 && $status < 500) {
                if ($reason === 'GROUP_NOT_ALLOWED') throw new MemberError('GROUP_NOT_ALLOWED', '当前会员已无权使用此分组，请刷新分组后重新选择', 403);
                if ($reason === 'API_KEY_COUNT_EXCEEDED') throw new MemberError('KEY_LIMIT_REACHED', '会员账户的 API Key 数量已达上限，请在会员网站删除不用的密钥后重试', 409);
                if (in_array($reason, ['API_KEY_RATE_LIMITED', 'API_KEY_CREATE_RATE_LIMITED'], true)) throw new MemberError('KEY_CREATE_RATE_LIMITED', '会员站点暂时限制创建密钥，请稍后再试', 429);
                if ($reason === 'API_KEY_EXISTS') throw new MemberError('KEY_REVIEW_REQUIRED', '客户端密钥已存在但未能核对，请刷新后重试或到会员网站核对', 409);
            }
            if (!$admin && ($status === 401 || ($status === 403 && str_starts_with($path, '/auth/')))) {
                throw new MemberError('AUTH_REJECTED', '会员身份验证失败，请检查登录信息或重新登录', 401);
            }
            if ($status === 429) throw new MemberError('UPSTREAM_RATE_LIMITED', '会员站点请求频繁，请稍后再试', 429);
            if ($status === 403) throw new MemberError('UPSTREAM_PERMISSION_DENIED', $stage . '被会员站点拒绝，请检查账户权限', 403);
            if (in_array($status, [404, 405], true)) throw new MemberError('UPSTREAM_API_UNSUPPORTED', '会员站点暂不支持' . $stage . '接口，请联系平台管理员核对版本', 503);
            if ($path === '/auth/login' || $path === '/auth/login/2fa') {
                throw new MemberError('LOGIN_REJECTED', '登录失败；如站点要求验证码，请在会员网站完成登录后绑定访问令牌', 400);
            }
            if ($status >= 200 && $status < 300) throw new MemberError('UPSTREAM_RESPONSE_INVALID', $stage . '返回格式不兼容，未确认操作结果，请联系平台管理员', 503);
            throw new MemberError('UPSTREAM_UNAVAILABLE', $stage . '未获会员站点确认' . ($status > 0 ? '（HTTP ' . $status . '）' : '') . '，请稍后重试', 503);
        }
        return $payload['data'];
    }

    private function profile(string $accessToken): array
    {
        if ($accessToken === '' || strlen($accessToken) > 16384 || preg_match('/[\r\n]/', $accessToken)) {
            throw new MemberError('AUTH_REJECTED', '会员访问令牌无效', 401);
        }
        $user = $this->request('GET', '/auth/me', ['Authorization: Bearer ' . $accessToken]);
        if (!is_int($user['id'] ?? null) || $user['id'] <= 0 || ($user['status'] ?? '') !== 'active') {
            throw new MemberError('ACCOUNT_INACTIVE', '会员账户不可用', 403);
        }
        $balance = $user['balance'] ?? null;
        return ['id' => $user['id'], 'email' => (string)($user['email'] ?? ''),
            'username' => (string)($user['username'] ?? ''),
            'balance' => is_numeric($balance) && is_finite((float)$balance) ? (float)$balance : null];
    }

    private function accessExpiry(string $token, ?int $expiresIn): int
    {
        $now = time();
        $expiry = $now + max(1, min(self::SESSION_LIFETIME, $expiresIn ?? 3600));
        // This is only a scheduling hint, never proof of identity. /auth/me authenticates
        // the token. A JWT exp can shorten a declared TTL, or describe a manual binding.
        $parts = explode('.', $token);
        if (count($parts) === 3) {
            $claims = json_decode((string)base64_decode(strtr($parts[1], '-_', '+/'), true), true);
            if (is_array($claims) && is_int($claims['exp'] ?? null)) {
                $expiry = $expiresIn === null ? min($now + self::SESSION_LIFETIME, $claims['exp']) : min($expiry, $claims['exp']);
            }
        }
        if ($expiry <= $now) throw new MemberError('AUTH_REJECTED', '会员访问令牌已过期，请重新登录', 401);
        return $expiry;
    }

    private function validRefresh(string $token): bool
    {
        return $token !== '' && strlen($token) <= 16384 && !preg_match('/[\x00-\x20\x7f]/', $token);
    }

    private function sessionInfo(array $session): array
    {
        return ['expiresAt' => gmdate('c', (int)$session['expires_at']),
            'accessExpiresAt' => gmdate('c', (int)$session['access_expires_at']),
            'canRefresh' => $session['upstream_refresh'] !== ''];
    }

    private function createSession(string $accessToken, array $credentials, ?int $expiresIn = null, string $refreshToken = ''): array
    {
        // The upstream authenticated identity is the only source of user_id.
        $profile = $this->profile($accessToken);
        $installation = $this->installation($credentials, true);
        $token = bin2hex(random_bytes(32));
        if ($refreshToken !== '' && !$this->validRefresh($refreshToken)) throw new MemberError('UPSTREAM_RESPONSE_INVALID', '会员站点返回的续期凭据无效', 503);
        $accessExpiresAt = $this->accessExpiry($accessToken, $expiresIn);
        $expiresAt = $refreshToken !== '' ? time() + self::SESSION_LIFETIME : $accessExpiresAt;
        $this->transaction(function () use ($token, $installation, $profile, $accessToken, $refreshToken, $expiresAt, $accessExpiresAt): void {
            $this->execute('DELETE FROM member_sessions WHERE expires_at<? OR installation_hash=?', [time(), $installation]);
            $this->execute('INSERT INTO member_sessions(token_hash,installation_hash,user_id,profile,upstream_token,expires_at,upstream_refresh,access_expires_at) VALUES(?,?,?,?,?,?,?,?)',
                [hash('sha256', $token), $installation, $profile['id'], json_encode($profile, JSON_THROW_ON_ERROR), $this->seal($accessToken), $expiresAt,
                    $refreshToken === '' ? '' : $this->seal($refreshToken), $accessExpiresAt]);
        });
        return ['ok' => true, 'sessionToken' => $token, 'expiresAt' => gmdate('c', $expiresAt),
            'accessExpiresAt' => gmdate('c', $accessExpiresAt), 'canRefresh' => $refreshToken !== '',
            'member' => $profile, 'gift' => $this->gift($profile['id'], $installation)];
    }

    private function session(array $credentials, bool $allowExpired = false): array
    {
        $installation = $this->installation($credentials, false);
        $token = (string)($credentials['sessionToken'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/D', $token)) throw new MemberError('SESSION_REQUIRED', '请先登录会员账户', 401);
        $row = $this->execute('SELECT * FROM member_sessions WHERE token_hash=?', [hash('sha256', $token)])->fetch(PDO::FETCH_ASSOC);
        if (!$row || (!$allowExpired && $row['expires_at'] <= time()) || !hash_equals($row['installation_hash'], $installation)) {
            throw new MemberError('SESSION_EXPIRED', '会员登录已失效，请重新登录', 401);
        }
        return $row;
    }

    private function currentSession(array $expected): array
    {
        $row = $this->execute('SELECT * FROM member_sessions WHERE token_hash=?', [$expected['token_hash']])->fetch(PDO::FETCH_ASSOC);
        if (!$row || $row['expires_at'] <= time() || $row['installation_hash'] !== $expected['installation_hash'] || (int)$row['user_id'] !== (int)$expected['user_id']) {
            throw new MemberError('SESSION_EXPIRED', '会员登录已失效，请重新登录', 401);
        }
        return $row;
    }

    private function revokeUpstream(string $refreshToken): void
    {
        if ($refreshToken === '') return;
        try { $this->request('POST', '/auth/logout', [], ['refresh_token' => $refreshToken]); }
        catch (MemberError $ignored) { /* The local session is already revoked, regardless of network availability. */ }
    }

    private function refreshSession(array $expected, bool $force = false): array
    {
        // Bounded lock files avoid an ever-growing file per login. Locks cover only
        // token rotation, never a database transaction or unrelated gift operation.
        $lockPath = $this->config['dataDir'] . '/refresh-' . substr($expected['token_hash'], 0, 2) . '.lock';
        if (is_link($lockPath)) throw new MemberError('STORAGE_UNAVAILABLE', '会员登录存储暂不可用', 503);
        $lock = @fopen($lockPath, 'c');
        if (!$lock) throw new MemberError('STORAGE_UNAVAILABLE', '会员登录存储暂不可用', 503);
        $locked = false;
        try {
            $deadline = microtime(true) + 12;
            do {
                $locked = flock($lock, LOCK_EX | LOCK_NB);
                if (!$locked) usleep(50000);
            } while (!$locked && microtime(true) < $deadline);
            if (!$locked) throw new MemberError('SESSION_BUSY', '会员登录正在续期，请稍后重试', 503);
            $session = $this->currentSession($expected);
            // A waiting request must reuse the pair another worker just rotated.
            if ($session['upstream_token'] !== $expected['upstream_token'] || (!$force && $session['access_expires_at'] > time() + self::REFRESH_MARGIN)) return $session;
            if ($session['upstream_refresh'] === '') throw new MemberError('SESSION_EXPIRED', '此登录无法自动续期，请重新登录会员账户', 401);
            $oldRefresh = $this->unseal($session['upstream_refresh']);
            try {
                $auth = $this->request('POST', '/auth/refresh', [], ['refresh_token' => $oldRefresh]);
            } catch (MemberError $error) {
                if ($error->errorCode === 'AUTH_REJECTED') {
                    $this->execute('DELETE FROM member_sessions WHERE token_hash=? AND upstream_refresh=?', [$session['token_hash'], $session['upstream_refresh']]);
                }
                throw $error;
            }
            $access = $auth['access_token'] ?? null;
            $refresh = $auth['refresh_token'] ?? null;
            if (!is_string($access) || !$this->validRefresh($access) || !is_string($refresh) || !$this->validRefresh($refresh)
                || !is_int($auth['expires_in'] ?? null) || $auth['expires_in'] <= 0) {
                throw new MemberError('UPSTREAM_RESPONSE_INVALID', '会员站点返回的续期信息不完整，请重新登录', 503);
            }
            $accessExpiresAt = $this->accessExpiry($access, $auth['expires_in']);
            // Persist the new pair before a further network read: if /auth/me is
            // temporarily unavailable, the already-consumed old refresh is not reused.
            $updated = $this->execute('UPDATE member_sessions SET upstream_token=?,upstream_refresh=?,access_expires_at=?,expires_at=? WHERE token_hash=? AND upstream_token=? AND upstream_refresh=? AND expires_at>?',
                [$this->seal($access), $this->seal($refresh), $accessExpiresAt, time() + self::SESSION_LIFETIME,
                    $session['token_hash'], $session['upstream_token'], $session['upstream_refresh'], time()]);
            if ($updated->rowCount() !== 1) {
                $this->revokeUpstream($refresh);
                throw new MemberError('SESSION_EXPIRED', '会员登录状态已变化，请重新登录', 401);
            }
            return $this->currentSession($session);
        } finally {
            if ($locked) flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function authenticatedSession(array $session): array
    {
        if ($session['upstream_refresh'] !== '' && $session['access_expires_at'] <= time() + self::REFRESH_MARGIN) $session = $this->refreshSession($session);
        try { $profile = $this->profile($this->unseal($session['upstream_token'])); }
        catch (MemberError $error) {
            if ($error->errorCode !== 'AUTH_REJECTED' || $session['upstream_refresh'] === '') throw $error;
            // Only retry identity verification, before any key or credit operation.
            $session = $this->refreshSession($session, true);
            $profile = $this->profile($this->unseal($session['upstream_token']));
        }
        if ($profile['id'] !== (int)$session['user_id']) {
            $this->execute('DELETE FROM member_sessions WHERE token_hash=?', [$session['token_hash']]);
            $this->revokeUpstream($session['upstream_refresh'] === '' ? '' : $this->unseal($session['upstream_refresh']));
            throw new MemberError('AUTH_REJECTED', '会员身份不匹配，请重新登录', 401);
        }
        // Concurrent logout/account replacement must not be undone by a late refresh/profile.
        $this->currentSession($session);
        $this->execute('UPDATE member_sessions SET profile=? WHERE token_hash=?', [json_encode($profile, JSON_THROW_ON_ERROR), $session['token_hash']]);
        $session['profile'] = json_encode($profile, JSON_THROW_ON_ERROR);
        $session['verified_profile'] = $profile;
        return $session;
    }

    private function gift(int $userId, string $installation): array
    {
        $grant = $this->execute('SELECT * FROM welcome_grants WHERE user_id=?', [$userId])->fetch(PDO::FETCH_ASSOC);
        if ($grant) {
            $result = ['status' => $grant['status'], 'amountUsd' => $this->dollars((int)$grant['amount_cents']), 'currency' => 'USD', 'campaign' => self::CAMPAIGN];
            if ($grant['status'] === 'claimed') {
                $result['code'] = $grant['code'];
                $result['claimedAt'] = gmdate('c', (int)$grant['claimed_at']);
            }
            if ($grant['status'] === 'review') $result['message'] = '赠金凭据需要管理员核对，请勿重复兑换';
            return $result;
        }
        $used = $this->execute('SELECT 1 FROM welcome_grants WHERE installation_hash=?', [$installation])->fetchColumn();
        $policy = $this->adminGiftPolicy();
        return ['status' => $used ? 'ineligible' : ($policy['enabled'] ? 'eligible' : 'disabled'), 'amountUsd' => $policy['amountUsd'],
            'currency' => 'USD', 'campaign' => self::CAMPAIGN,
            'message' => $used ? '此安装已为其他会员领取过首次使用赠金' : ($policy['message'] !== '' ? $policy['message']
                : ($policy['enabled'] ? '首次绑定会员可领取 $' . $policy['amountUsd'] . ' 体验额度' : '首次使用赠金暂未开放，会员登录和客户端配置仍可正常使用'))];
    }

    private function validateReceipt(array $grant, array $receipt): void
    {
        if (($receipt['code'] ?? '') !== $grant['code'] || ($receipt['type'] ?? '') !== 'balance'
            || $this->receiptCents($receipt['value'] ?? null) !== (int)$grant['amount_cents']
            || ($receipt['used_by'] ?? null) !== (int)$grant['user_id'] || ($receipt['status'] ?? '') !== 'used'
            || !is_int($receipt['id'] ?? null) || $receipt['id'] <= 0) {
            $this->execute("UPDATE welcome_grants SET status='review',last_error='RECEIPT_MISMATCH' WHERE user_id=? AND code=? AND status='pending'", [$grant['user_id'], $grant['code']]);
            throw new MemberError('GRANT_REVIEW_REQUIRED', '赠金凭据与账户不匹配，需要管理员核对', 409);
        }
    }

    private function welcomeCode(int $userId, bool $legacy = false): string
    {
        $digest = strtoupper(hash_hmac('sha256', self::CAMPAIGN . ':' . $this->config['origin'] . ':' . $userId, $this->config['secret']));
        // The upstream storage schema limits redeem codes to 32 characters.
        return $legacy ? 'YQ-WELCOME-' . $digest : 'YQW-' . substr($digest, 0, 28);
    }

    private function currentGrant(int $userId): array
    {
        $grant = $this->execute('SELECT * FROM welcome_grants WHERE user_id=?', [$userId])->fetch(PDO::FETCH_ASSOC);
        if (!$grant) throw new MemberError('GRANT_NOT_FOUND', '该账户没有客户端赠金申请', 404);
        return $grant;
    }

    private function fulfill(array $grant, bool $readOnly = false): void
    {
        $grant = $this->currentGrant((int)$grant['user_id']);
        if ($grant['status'] === 'claimed') return;
        if ($grant['status'] === 'review' && !$readOnly) throw new MemberError('GRANT_REVIEW_REQUIRED', '赠金凭据需要管理员核对', 409);
        $headers = ['x-api-key: ' . $this->config['adminKey']];
        // Recover a consumed code even after the upstream idempotency cache has expired.
        $found = $this->request('GET', '/admin/redeem-codes?search=' . rawurlencode($grant['code']) . '&page_size=100', $headers);
        if (!is_array($found['items'] ?? null)) throw new MemberError('UPSTREAM_UNAVAILABLE', '无法核对赠金凭据', 503);
        $receipt = null;
        foreach ($found['items'] as $item) {
            if (is_array($item) && ($item['code'] ?? '') === $grant['code']) { $receipt = $item; break; }
        }
        if (strlen($grant['code']) > 32 && ($receipt === null || ($receipt['status'] ?? '') !== 'used')) {
            $legacy = hash_equals($this->welcomeCode((int)$grant['user_id'], true), $grant['code']);
            if (!$legacy || $receipt !== null) {
                $this->execute("UPDATE welcome_grants SET status='review',last_error='LEGACY_CODE_REVIEW' WHERE user_id=? AND code=? AND status='pending'", [$grant['user_id'], $grant['code']]);
                throw new MemberError('GRANT_REVIEW_REQUIRED', '原赠金凭据需要管理员核对，未创建新的赠金申请', 409);
            }
            // An incomplete or malformed search cannot establish that no old receipt exists.
            if (!is_int($found['total'] ?? null) || $found['total'] !== 0 || count($found['items']) !== 0) {
                throw new MemberError('GRANT_LOOKUP_INCOMPLETE', '无法完整确认原赠金凭据，未创建新的赠金申请', 503);
            }
            if ($readOnly) throw new MemberError('GRANT_PENDING', '上游尚无已核销凭据，额度未被确认到账', 409);
            $current = $this->transaction(function () use ($grant): array {
                $latest = $this->currentGrant((int)$grant['user_id']);
                if ($latest['status'] === 'pending' && hash_equals($latest['code'], $grant['code'])) {
                    $this->execute("UPDATE welcome_grants SET code=?,last_error=NULL WHERE user_id=? AND code=? AND status='pending'",
                        [$this->welcomeCode((int)$grant['user_id']), $grant['user_id'], $grant['code']]);
                }
                return $this->currentGrant((int)$grant['user_id']);
            });
            $this->fulfill($current, $readOnly);
            return;
        }
        if ($receipt !== null && (($receipt['type'] ?? '') !== 'balance' || $this->receiptCents($receipt['value'] ?? null) !== (int)$grant['amount_cents'])) {
            $this->validateReceipt($grant, $receipt);
        }
        if ($receipt === null || ($receipt['status'] ?? '') !== 'used') {
            if ($readOnly) throw new MemberError('GRANT_PENDING', '上游尚无已核销凭据，额度未被确认到账', 409);
            $latest = $this->currentGrant((int)$grant['user_id']);
            if ($latest['code'] !== $grant['code'] || $latest['status'] !== $grant['status']) { $this->fulfill($latest); return; }
            $result = $this->request('POST', '/admin/redeem-codes/create-and-redeem',
                array_merge($headers, ['Idempotency-Key: ' . $grant['code']]),
                ['code' => $grant['code'], 'type' => 'balance', 'value' => $this->dollars((int)$grant['amount_cents']), 'user_id' => (int)$grant['user_id'], 'notes' => self::CAMPAIGN]);
            $receipt = is_array($result['redeem_code'] ?? null) ? $result['redeem_code'] : [];
        }
        $this->validateReceipt($grant, $receipt);
        $this->execute("UPDATE welcome_grants SET status='claimed',claimed_at=?,upstream_id=?,last_error=NULL WHERE user_id=? AND code=? AND status IN ('pending','review')", [time(), $receipt['id'], $grant['user_id'], $grant['code']]);
    }

    /** Only call behind the existing web administrator session and CSRF protection. */
    public function adminOverview(): array
    {
        $configuration = $this->publicConfig();
        if (!$this->configured()) return array_merge($configuration, ['grants' => [], 'totals' => ['claimed' => 0, 'pending' => 0, 'review' => 0, 'amountUsd' => 0]]);
        $totals = ['claimed' => 0, 'pending' => 0, 'review' => 0, 'amountUsd' => 0];
        foreach ($this->database()->query('SELECT status,COUNT(*) AS count FROM welcome_grants GROUP BY status')->fetchAll(PDO::FETCH_ASSOC) as $row) $totals[$row['status']] = (int)$row['count'];
        $totals['amountUsd'] = $this->dollars((int)$this->database()->query("SELECT COALESCE(SUM(amount_cents),0) FROM welcome_grants WHERE status='claimed'")->fetchColumn());
        $grants = $this->database()->query('SELECT user_id AS userId,status,amount_cents AS amountCents,created_at AS createdAt,claimed_at AS claimedAt,last_error AS lastError,upstream_id AS upstreamId FROM welcome_grants ORDER BY created_at DESC LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
        foreach ($grants as &$grant) $grant['amountUsd'] = $this->dollars((int)$grant['amountCents']);
        unset($grant);
        return array_merge($configuration, ['totals' => $totals, 'grants' => $grants]);
    }

    public function adminReconcile(int $userId, bool $retry): array
    {
        if (!$this->configured()) throw new MemberError('MEMBERS_DISABLED', '会员服务尚未启用', 503);
        $grant = $this->execute('SELECT * FROM welcome_grants WHERE user_id=?', [$userId])->fetch(PDO::FETCH_ASSOC);
        if (!$grant) throw new MemberError('GRANT_NOT_FOUND', '该账户没有客户端赠金申请', 404);
        $this->fulfill($grant, !$retry);
        return ['ok' => true, 'gift' => $this->gift($userId, $grant['installation_hash'])];
    }

    private function availableGroups(string $accessToken): array
    {
        $groups = $this->request('GET', '/groups/available', ['Authorization: Bearer ' . $accessToken]);
        $result = [];
        foreach ($groups as $group) {
            if (!is_array($group) || !is_int($group['id'] ?? null) || !is_string($group['platform'] ?? null) || ($group['status'] ?? '') !== 'active') continue;
            $result[] = ['id' => $group['id'], 'name' => (string)($group['name'] ?? ''), 'platform' => $group['platform'],
                'supported' => in_array($group['platform'], ['anthropic', 'openai', 'gemini', 'deepseek', 'grok'], true),
                'rateMultiplier' => (float)($group['rate_multiplier'] ?? 1)];
        }
        return $result;
    }

    private function createClientKey(array $session, array $body): array
    {
        $this->rateLimit('client-key', (string)$session['user_id'], 6, 60);
        $accessToken = $this->unseal($session['upstream_token']);
        $profile = $session['verified_profile'];
        $groups = $this->availableGroups($accessToken);
        $groupId = $body['groupId'] ?? (count($groups) === 1 ? $groups[0]['id'] : null);
        $selected = null;
        foreach ($groups as $group) if ($group['id'] === $groupId) $selected = $group;
        if (!$selected) throw new MemberError('GROUP_REQUIRED', '请选择当前会员可使用的模型分组');
        if (!$selected['supported']) throw new MemberError('PLATFORM_UNSUPPORTED', '该分组协议暂未支持一键接入，请到平台网站查看配置说明');
        // A stable custom key also prevents duplication after the upstream idempotency TTL expires.
        $key = 'sk-yunhui-' . hash_hmac('sha256', 'client-key-v1:' . $session['user_id'] . ':' . $session['installation_hash'] . ':' . $groupId, $this->config['secret']);
        $headers = ['Authorization: Bearer ' . $accessToken];
        $keys = $this->request('GET', '/keys?search=' . rawurlencode('yunhui.me 客户端') . '&page_size=100', $headers);
        if (!is_array($keys['items'] ?? null)) throw new MemberError('UPSTREAM_UNAVAILABLE', '无法核对客户端密钥', 503);
        $entry = null;
        foreach ($keys['items'] as $candidate) if (is_array($candidate) && ($candidate['key'] ?? '') === $key) { $entry = $candidate; break; }
        if (!$entry) {
            if (($keys['total'] ?? count($keys['items'])) > 100) throw new MemberError('KEY_REVIEW_REQUIRED', '客户端密钥过多，请到会员站点管理后重试', 409);
            $entry = $this->request('POST', '/keys', array_merge($headers, ['Idempotency-Key: YQ-CLIENT-' . hash('sha256', $key)]),
                ['name' => 'yunhui.me 客户端', 'group_id' => $groupId, 'custom_key' => $key]);
        }
        if (($entry['key'] ?? '') !== $key || ($entry['user_id'] ?? null) !== $profile['id'] || ($entry['group_id'] ?? null) !== $groupId || ($entry['status'] ?? '') !== 'active') {
            throw new MemberError('KEY_REVIEW_REQUIRED', '客户端密钥状态不符，请到会员站点核对', 409);
        }
        $format = ['openai' => 'openai-responses', 'anthropic' => 'anthropic', 'gemini' => 'gemini', 'deepseek' => 'openai-chat', 'grok' => 'openai-chat'][$selected['platform']];
        return ['ok' => true, 'apiKey' => $key, 'id' => $entry['id'], 'memberId' => $profile['id'], 'name' => '云汇会员', 'group' => $selected,
            'baseUrl' => $this->config['origin'] . ($format === 'gemini' ? '' : '/v1'), 'format' => $format];
    }

    public function handle(string $action, array $body, array $credentials, string $remoteAddress = 'unknown'): array
    {
        if ($action === 'config') return $this->publicConfig();
        if (!$this->configured()) throw new MemberError('MEMBERS_DISABLED', '会员服务尚未启用', 503);
        // Reject authoritative fields outright instead of accidentally accepting a future UI field.
        foreach (['userId', 'user_id', 'amount', 'amountUsd', 'amountCents', 'giftUsd', 'giftEnabled', 'giftMessage', 'giftPolicyRevision', 'campaign', 'value', 'code', 'adminKey', 'origin'] as $forbidden) {
            if (array_key_exists($forbidden, $body)) throw new MemberError('INVALID_FIELDS', '请求包含不允许的会员字段');
        }
        if (in_array($action, ['login', 'login2fa', 'bind'], true)) {
            $this->rateLimit('login', $remoteAddress, 12, 300);
            if ($action === 'bind') return $this->createSession((string)($body['accessToken'] ?? ''), $credentials);
            if ($action === 'login') {
                $email = (string)($body['email'] ?? '');
                $password = (string)($body['password'] ?? '');
                if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 1 || strlen($password) > 1024) {
                    throw new MemberError('INVALID_LOGIN', '请输入有效邮箱和密码');
                }
                $payload = ['email' => $email, 'password' => $password];
                foreach (['turnstile_token', 'tencent_captcha_ticket', 'tencent_captcha_randstr'] as $field) {
                    if (isset($body[$field]) && is_string($body[$field]) && strlen($body[$field]) <= 8192) $payload[$field] = $body[$field];
                }
                $auth = $this->request('POST', '/auth/login', [], $payload);
                if (($auth['requires_2fa'] ?? false) === true) {
                    return ['ok' => true, 'requires2fa' => true, 'tempToken' => (string)($auth['temp_token'] ?? ''),
                        'emailMasked' => (string)($auth['user_email_masked'] ?? '')];
                }
            } else {
                if (!preg_match('/^[0-9]{6}$/D', (string)($body['totpCode'] ?? '')) || strlen((string)($body['tempToken'] ?? '')) > 16384) {
                    throw new MemberError('INVALID_2FA', '请输入六位动态验证码');
                }
                $auth = $this->request('POST', '/auth/login/2fa', [], ['temp_token' => (string)($body['tempToken'] ?? ''), 'totp_code' => $body['totpCode']]);
            }
            if (!is_string($auth['access_token'] ?? null) || (isset($auth['refresh_token']) && !is_string($auth['refresh_token']))
                || (isset($auth['expires_in']) && (!is_int($auth['expires_in']) || $auth['expires_in'] <= 0))) {
                throw new MemberError('UPSTREAM_RESPONSE_INVALID', '会员站点返回的登录信息不完整', 503);
            }
            return $this->createSession($auth['access_token'], $credentials, $auth['expires_in'] ?? null, $auth['refresh_token'] ?? '');
        }
        $session = $this->session($credentials, $action === 'logout');
        $userId = (int)$session['user_id'];
        $installation = $session['installation_hash'];
        if ($action === 'logout') {
            $this->execute('DELETE FROM member_sessions WHERE token_hash=?', [$session['token_hash']]);
            $this->revokeUpstream($session['upstream_refresh'] === '' ? '' : $this->unseal($session['upstream_refresh']));
            return ['ok' => true];
        }
        if (!in_array($action, ['status', 'groups', 'create-client-key', 'claim'], true)) throw new MemberError('UNKNOWN_ACTION', '会员操作不存在', 404);
        $session = $this->authenticatedSession($session);
        $profile = $session['verified_profile'];
        if ($action === 'status') {
            return array_merge(['ok' => true, 'member' => $profile, 'gift' => $this->gift($userId, $installation)], $this->sessionInfo($session));
        }
        if ($action === 'groups') return ['ok' => true, 'groups' => $this->availableGroups($this->unseal($session['upstream_token']))];
        if ($action === 'create-client-key') return $this->createClientKey($session, $body);
        $this->rateLimit('claim', (string)$userId, 20, 60);
        $grant = $this->transaction(function () use ($userId, $installation): array {
            $existing = $this->execute('SELECT * FROM welcome_grants WHERE user_id=?', [$userId])->fetch(PDO::FETCH_ASSOC);
            if ($existing) return $existing;
            if ($this->execute('SELECT 1 FROM welcome_grants WHERE installation_hash=?', [$installation])->fetchColumn()) {
                throw new MemberError('INSTALLATION_ALREADY_CLAIMED', '此安装已领取过首次使用赠金', 409);
            }
            // Policy and once-per-account/install reservation share this write lock. A policy
            // update cannot change an already-reserved amount or cancel recovery of that grant.
            $policy = $this->adminGiftPolicy();
            if (!$policy['enabled']) throw new MemberError('GIFT_DISABLED', '首次使用赠金暂未开放，会员登录和客户端配置仍可正常使用', 409);
            // Stable across every retry and process crash; committed before any external side effect.
            $code = $this->welcomeCode($userId);
            $this->execute('INSERT INTO welcome_grants(user_id,installation_hash,code,status,amount_cents,created_at) VALUES(?,?,?,\'pending\',?,?)', [$userId, $installation, $code, $policy['amountCents'], time()]);
            return $this->execute('SELECT * FROM welcome_grants WHERE user_id=?', [$userId])->fetch(PDO::FETCH_ASSOC);
        });
        if ($grant['status'] !== 'claimed') {
            try {
                $this->fulfill($grant);
            } catch (MemberError $error) {
                $this->execute("UPDATE welcome_grants SET last_error=? WHERE user_id=? AND status='pending'", [$error->errorCode, $userId]);
                throw $error;
            }
        }
        // A receipt is authoritative; balance is refreshed separately, never inferred from a gift.
        try { $profile = $this->profile($this->unseal($session['upstream_token'])); } catch (MemberError $ignored) { }
        $this->execute('UPDATE member_sessions SET profile=? WHERE token_hash=?', [json_encode($profile, JSON_THROW_ON_ERROR), $session['token_hash']]);
        return ['ok' => true, 'member' => $profile, 'gift' => $this->gift($userId, $installation)];
    }
}
