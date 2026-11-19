<?php
/** Read-only sub2api discovery. Curated recommendations remain an explicit administrator choice. */
declare(strict_types=1);
require_once __DIR__ . '/member_service.php';

final class CatalogSyncService
{
    private array $config;
    private string $directory;
    private $transport;

    public function __construct(array $config, string $directory = '/www/aurora-data', ?callable $transport = null)
    {
        $this->config = $config;
        $this->directory = $directory;
        $this->transport = $transport;
    }

    private function read(string $name, array $default = []): array
    {
        $file = $this->directory . '/' . $name;
        if (!is_file($file)) return $default;
        $value = json_decode((string)file_get_contents($file), true, 128, JSON_THROW_ON_ERROR);
        if (!is_array($value)) throw new RuntimeException('Invalid catalog data');
        return $value;
    }

    private function write(string $name, array $data): void
    {
        $target = $this->directory . '/' . $name;
        $temporary = $target . '.' . bin2hex(random_bytes(8)) . '.tmp';
        $handle = fopen($temporary, 'xb');
        if (!$handle) throw new RuntimeException('Cannot stage catalog data');
        try {
            $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
            if (fwrite($handle, $json) !== strlen($json) || !fflush($handle)) throw new RuntimeException('Cannot persist catalog data');
            if (function_exists('fsync')) fsync($handle);
        } finally { fclose($handle); }
        @chmod($temporary, 0600);
        if (!rename($temporary, $target)) { @unlink($temporary); throw new RuntimeException('Cannot publish catalog data'); }
    }

    private function lock(string $name, bool $nonBlocking = false)
    {
        umask(0077);
        if (!is_dir($this->directory) && !mkdir($this->directory, 0700, true)) throw new RuntimeException('Catalog storage unavailable');
        $handle = fopen($this->directory . '/' . $name, 'c');
        if (!$handle || !flock($handle, LOCK_EX | ($nonBlocking ? LOCK_NB : 0))) {
            if ($handle) fclose($handle);
            throw new MemberError('SYNC_BUSY', '模型目录正在同步，请稍后刷新', 409);
        }
        return $handle;
    }

    private function get(string $path): array
    {
        if (($this->config['origin'] ?? '') !== 'https://api.yunhui.me' || strlen((string)($this->config['adminKey'] ?? '')) < 12) {
            throw new MemberError('SYNC_NOT_CONFIGURED', '请先配置云汇服务端管理密钥', 503);
        }
        if ($this->transport) $response = ($this->transport)($path);
        else {
            $curl = curl_init('https://api.yunhui.me/api/v1' . $path);
            $buffer = '';
            curl_setopt_array($curl, [CURLOPT_HTTPHEADER => ['Accept: application/json', 'x-api-key: ' . $this->config['adminKey']],
                CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 12, CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$buffer): int {
                    if (strlen($buffer) + strlen($chunk) > 4194304) return 0;
                    $buffer .= $chunk; return strlen($chunk);
                }]);
            $okay = curl_exec($curl);
            $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            curl_close($curl);
            if ($okay === false) throw new MemberError('SYNC_UPSTREAM_UNAVAILABLE', '上游模型目录连接失败，已保留上次成功结果', 503);
            $response = ['status' => $status, 'body' => json_decode($buffer, true)];
        }
        if (($response['status'] ?? 0) !== 200 || ($response['body']['code'] ?? null) !== 0 || !is_array($response['body']['data'] ?? null)) {
            throw new MemberError('SYNC_UPSTREAM_UNAVAILABLE', '上游模型目录接口不可用，已保留上次成功结果', 503);
        }
        return $response['body']['data'];
    }

    private static function validModel($id): bool
    {
        return is_string($id) && strlen($id) <= 200 && preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._:\/+-]*$/D', $id) === 1;
    }

    private static function allowed(string $id, array $allowlist): bool
    {
        if (($allowlist['enabled'] ?? false) !== true) return true;
        foreach (($allowlist['models'] ?? []) as $pattern) {
            if (!is_string($pattern) || strlen($pattern) > 200) continue;
            $expression = '/^' . str_replace('\\*', '.*', preg_quote($pattern, '/')) . '$/iD';
            if (preg_match($expression, $id) === 1 || preg_match($expression, preg_replace('/^models\//', '', $id)) === 1) return true;
        }
        return false;
    }

    public function status(): array
    {
        $bundle = $this->read('catalog-sync-state.json');
        return ['ok' => true, 'status' => $bundle['status'] ?? [],
            'catalog' => $bundle['catalog'] ?? ['groups' => [], 'models' => []]];
    }

    public function sync(string $trigger = 'cron'): array
    {
        $lock = $this->lock('catalog-sync.lock', true);
        $started = microtime(true);
        $stamp = gmdate('c');
        try {
            $groups = $this->get('/admin/groups/all');
            if (!array_is_list($groups)) throw new MemberError('SYNC_SCHEMA_CHANGED', '上游分组格式发生变化，未更新目录', 503);
            $groups = array_values(array_filter($groups, static fn($g): bool => is_array($g) && ($g['status'] ?? '') === 'active' && is_int($g['id'] ?? null) && $g['id'] > 0));
            if (!$groups || count($groups) > 32) throw new MemberError('SYNC_GROUP_LIMIT', '上游有效分组为空或超过32组，需管理员核对后同步', 503);
            $records = [];
            $publicGroups = [];
            foreach ($groups as $group) {
                if (microtime(true) - $started > 100) throw new MemberError('SYNC_TIMEOUT', '模型同步超时，已保留上次成功结果', 503);
                $platform = (string)($group['platform'] ?? '');
                $candidates = $this->get('/admin/groups/' . $group['id'] . '/model-allowlist-candidates');
                if (!is_array($candidates['models'] ?? null) || count($candidates['models']) > 2000) throw new MemberError('SYNC_SCHEMA_CHANGED', '上游模型数量或格式异常，未更新目录', 503);
                $ids = [];
                foreach ($candidates['models'] as $id) {
                    // Wildcard patterns are never published as literal model IDs.
                    if (!self::validModel($id) || !self::allowed($id, (array)($group['model_allowlist'] ?? []))) continue;
                    $ids[$id] = true;
                    $key = $platform . ':' . $id;
                    if (!isset($records[$key])) $records[$key] = ['id' => $id, 'platform' => $platform, 'groups' => []];
                    $records[$key]['groups'][] = $group['id'];
                }
                $publicGroups[] = ['id' => $group['id'], 'name' => (string)($group['name'] ?? ''), 'platform' => $platform, 'modelCount' => count($ids)];
            }
            if (!$records || count($records) > 5000) throw new MemberError('SYNC_EMPTY', '未获取有效模型ID，已保留上次成功结果', 503);
            ksort($records, SORT_STRING);
            $discovery = ['updatedAt' => $stamp, 'source' => 'sub2api-group-candidates', 'availability' => 'candidate', 'groups' => $publicGroups, 'models' => array_values($records)];
            $writeLock = $this->lock('catalog-write.lock');
            try {
                $current = $this->read('catalog.json', ['providers' => []]);
                $previous = $this->read('catalog-sync-state.json')['status'] ?? [];
                $suppressed = (array)($previous['suppressed'] ?? []);
                $managed = (array)($previous['managed'] ?? []);
                foreach ($managed as $providerKey => $ids) {
                    $provider = null;
                    foreach ($current['providers'] as $candidate) if (($candidate['key'] ?? '') === $providerKey) $provider = $candidate;
                    $existingIds = $provider ? array_column($provider['models'] ?? [], 'id') : [];
                    foreach ($ids as $id) if (!in_array($id, $existingIds, true)) $suppressed[$providerKey][$id] = true;
                }
                $status = ['lastAttemptAt' => $stamp, 'lastSuccessAt' => $stamp, 'lastResult' => 'success', 'trigger' => $trigger,
                    'groups' => count($publicGroups), 'models' => count($records), 'durationMs' => (int)((microtime(true) - $started) * 1000),
                    'managed' => $managed, 'suppressed' => $suppressed,
                    'audit' => array_slice(array_merge([['at' => $stamp, 'result' => 'success', 'trigger' => $trigger, 'models' => count($records)]], (array)($previous['audit'] ?? [])), 0, 50)];
                // Cache and success metadata share one atomic rename; a failed write keeps both old.
                $this->write('catalog-sync-state.json', ['status' => $status, 'catalog' => $discovery]);
            } finally { flock($writeLock, LOCK_UN); fclose($writeLock); }
            return ['ok' => true, 'models' => count($records), 'groups' => count($publicGroups), 'updatedAt' => $stamp,
                'message' => '完整候选目录已同步；精选推荐和手工字段保持原有选择。'];
        } catch (Throwable $error) {
            $writeLock = $this->lock('catalog-write.lock');
            try {
                $bundle = $this->read('catalog-sync-state.json');
                $previous = $bundle['status'] ?? [];
                $code = $error instanceof MemberError ? $error->errorCode : 'SYNC_STORAGE_ERROR';
                $previous['lastAttemptAt'] = $stamp; $previous['lastResult'] = 'failed'; $previous['lastError'] = $code;
                $previous['audit'] = array_slice(array_merge([['at' => $stamp, 'result' => 'failed', 'trigger' => $trigger, 'error' => $code]], (array)($previous['audit'] ?? [])), 0, 50);
                $bundle['status'] = $previous;
                $this->write('catalog-sync-state.json', $bundle);
            } finally { flock($writeLock, LOCK_UN); fclose($writeLock); }
            throw $error;
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /** Explicit curated selection; never invoked by cron. No prices/capabilities are guessed. */
    public function addSelected(string $providerKey, array $ids): array
    {
        if (!$ids || count($ids) > 100) throw new MemberError('INVALID_SELECTION', '每次请选择1至100个模型');
        $lock = $this->lock('catalog-write.lock');
        try {
            $catalog = $this->read('catalog.json');
            $bundle = $this->read('catalog-sync-state.json');
            $discovery = $bundle['catalog'] ?? [];
            $state = $bundle['status'] ?? [];
            $index = null;
            foreach (($catalog['providers'] ?? []) as $i => $provider) if (($provider['key'] ?? '') === $providerKey) $index = $i;
            if ($index === null) throw new MemberError('PROVIDER_NOT_FOUND', '请先在供应商目录建立云汇供应商');
            $provider = $catalog['providers'][$index];
            if (parse_url((string)($provider['baseUrl'] ?? ''), PHP_URL_HOST) !== 'api.yunhui.me') throw new MemberError('WRONG_PROVIDER', '只能为云汇供应商添加候选模型');
            $platforms = ['openai-responses' => ['openai'], 'openai-chat' => ['openai', 'deepseek', 'grok'], 'anthropic' => ['anthropic'], 'gemini' => ['gemini']][$provider['format'] ?? ''] ?? [];
            $allowed = [];
            foreach (($discovery['models'] ?? []) as $model) if (in_array($model['platform'] ?? '', $platforms, true)) $allowed[$model['id']] = true;
            foreach ($ids as $id) if (!self::validModel($id) || !isset($allowed[$id])) throw new MemberError('INVALID_SELECTION', '所选模型不在该协议的当前候选目录中');
            $existing = array_column($provider['models'] ?? [], 'id');
            $added = 0;
            foreach (array_values(array_unique($ids)) as $id) {
                if (!in_array($id, $existing, true)) { $catalog['providers'][$index]['models'][] = ['id' => $id]; $added++; }
                $state['managed'][$providerKey] = array_values(array_unique(array_merge((array)($state['managed'][$providerKey] ?? []), [$id])));
                unset($state['suppressed'][$providerKey][$id]);
            }
            if ($added) {
                $catalog['version'] = (int)($catalog['version'] ?? 0) + 1; $catalog['updatedAt'] = gmdate('c');
                $catalog['providers'][$index]['updatedAt'] = $catalog['updatedAt'];
                $this->write('catalog.json', $catalog);
            }
            $state['audit'] = array_slice(array_merge([['at' => gmdate('c'), 'result' => 'selection', 'provider' => $providerKey, 'added' => $added]], (array)($state['audit'] ?? [])), 0, 50);
            $bundle['status'] = $state;
            try { $this->write('catalog-sync-state.json', $bundle); }
            catch (Throwable $error) {
                // The public catalog is already committed (or the selected models already
                // existed). Report that outcome accurately; a retry only repairs metadata.
                error_log('yunhui.me curated catalog committed; audit write failed: ' . get_class($error));
                return ['ok' => true, 'added' => $added, 'version' => $catalog['version'] ?? 0, 'auditSaved' => false,
                    'warning' => '精选目录已生效，但同步审计未保存。请检查数据目录写入权限或磁盘空间，再选择相同模型重试补记；不会重复添加模型。'];
            }
            return ['ok' => true, 'added' => $added, 'version' => $catalog['version'] ?? 0, 'auditSaved' => true];
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        $service = new CatalogSyncService(MemberService::environment());
        echo json_encode($service->sync('cron'), JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . PHP_EOL;
    } catch (Throwable $error) {
        fwrite(STDERR, ($error instanceof MemberError ? $error->getMessage() : '模型同步失败，请检查服务配置和日志') . PHP_EOL);
        exit(1);
    }
}
