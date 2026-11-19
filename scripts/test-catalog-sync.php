<?php
declare(strict_types=1);
require __DIR__ . '/../server/catalog_sync.php';

function assert_sync(bool $okay, string $label): void { if (!$okay) throw new RuntimeException($label); }
function sync_error(callable $run, string $expected): void {
    try { $run(); } catch (MemberError $e) { assert_sync($e->errorCode === $expected, 'Expected ' . $expected . ', got ' . $e->errorCode); return; }
    throw new RuntimeException('Expected ' . $expected);
}
function sync_fixture(string $dir, string $mode = '', ?callable $duringRead = null): CatalogSyncService
{
    $config = ['origin' => 'https://api.yunhui.me', 'adminKey' => 'fixture-admin-secret'];
    return new CatalogSyncService($config, $dir, static function ($path) use ($mode, $duringRead): array {
        if ($duringRead) $duringRead($path);
        if ($mode === 'failed') return ['status' => 503, 'body' => []];
        if ($path === '/admin/groups/all') {
            $groups = [
                ['id' => 1, 'name' => 'OpenAI', 'platform' => 'openai', 'status' => 'active', 'model_allowlist' => ['enabled' => true, 'models' => ['gpt-6*']], 'internal_secret' => 'must-not-publish'],
                ['id' => 2, 'name' => 'DeepSeek', 'platform' => 'deepseek', 'status' => 'active'],
                ['id' => 3, 'name' => 'disabled', 'platform' => 'openai', 'status' => 'inactive']];
            if ($mode === 'too-many') $groups = array_fill(0, 33, $groups[0]);
            return ['status' => 200, 'body' => ['code' => 0, 'data' => $groups]];
        }
        if (!preg_match('~^/admin/groups/([12])/model-allowlist-candidates$~', $path, $match)) throw new RuntimeException('Unexpected upstream endpoint: ' . $path);
        $ids = $match[1] === '1' ? ['gpt-6', 'gpt-6.1-sol', 'gpt-4-old', '*', 'bad<script>', 'gpt-6'] : ['deepseek-flash'];
        if ($mode === 'empty') $ids = [];
        return ['status' => 200, 'body' => ['code' => 0, 'data' => ['models' => $ids, 'secret' => 'not-public']]];
    });
}
function initial_catalog(string $dir): array
{
    $catalog = ['version' => 5, 'providers' => [
        ['key' => 'yunhui', 'name' => '我的精选', 'enabled' => false, 'format' => 'openai-responses', 'baseUrl' => 'https://api.yunhui.me/v1', 'note' => '手工备注', 'models' => [['id' => 'gpt-6', 'inputPrice' => 7, 'displayName' => '自定义名称']]],
        ['key' => 'deepseek', 'name' => '国内官方', 'format' => 'openai-chat', 'baseUrl' => 'https://api.deepseek.com', 'models' => [['id' => 'deepseek-flash', 'contextWindow' => 128000]]]]];
    file_put_contents($dir . '/catalog.json', json_encode($catalog));
    return $catalog;
}
function read_catalog(string $dir): array { return json_decode((string)file_get_contents($dir . '/catalog.json'), true, 128, JSON_THROW_ON_ERROR); }

$root = sys_get_temp_dir() . '/aurora-catalog-sync-' . bin2hex(random_bytes(6)); mkdir($root);
$count = 0;
$test = static function (string $name, callable $run) use ($root, &$count): void { $dir = $root . '/' . ++$count; mkdir($dir); initial_catalog($dir); $run($dir); echo 'PASS ' . $name . PHP_EOL; };

$test('candidate allowlist, de-duplication and metadata allowlist', static function ($dir): void {
    $service = sync_fixture($dir); $r = $service->sync(); $result = $service->status();
    assert_sync($r['models'] === 3 && $r['groups'] === 2, 'exact candidate counts');
    $json = json_encode($result);
    foreach (['must-not-publish', 'not-public', 'fixture-admin-secret', 'gpt-4-old', 'bad<script>'] as $forbidden) assert_sync(!str_contains($json, $forbidden), 'No untrusted metadata');
    assert_sync($result['catalog']['availability'] === 'candidate', 'does not claim per-account availability');
});
$test('daily sync preserves recommendations, disabled state and other vendors', static function ($dir): void {
    $before = read_catalog($dir); sync_fixture($dir)->sync(); assert_sync(read_catalog($dir) === $before, 'manual catalog untouched');
});
$test('explicit curated selection retains manual metadata and increments version once', static function ($dir): void {
    $service = sync_fixture($dir); $service->sync(); $before = read_catalog($dir);
    $r = $service->addSelected('yunhui', ['gpt-6', 'gpt-6.1-sol']); $catalog = read_catalog($dir);
    assert_sync($r['added'] === 1 && $catalog['version'] === 6, 'one new curated model');
    assert_sync($catalog['providers'][0]['models'][0] === $before['providers'][0]['models'][0], 'manual price and name retained');
    assert_sync($catalog['providers'][0]['models'][1] === ['id' => 'gpt-6.1-sol'], 'unknown prices and capabilities omitted');
    assert_sync($catalog['providers'][1] === $before['providers'][1] && !$catalog['providers'][0]['enabled'], 'other vendor and disabled state retained');
    $service->addSelected('yunhui', ['gpt-6.1-sol']); assert_sync(read_catalog($dir)['version'] === 6, 'repeat selection idempotent');
});
$test('wrong platform, unknown ID and wrong vendor rejected', static function ($dir): void {
    $service = sync_fixture($dir); $service->sync();
    sync_error(fn() => $service->addSelected('yunhui', ['deepseek-flash']), 'INVALID_SELECTION');
    sync_error(fn() => $service->addSelected('yunhui', ['not-real']), 'INVALID_SELECTION');
    sync_error(fn() => $service->addSelected('deepseek', ['deepseek-flash']), 'WRONG_PROVIDER');
});
$test('manual removal is suppressed and never resurrected by cron', static function ($dir): void {
    $service = sync_fixture($dir); $service->sync(); $service->addSelected('yunhui', ['gpt-6.1-sol']);
    $catalog = read_catalog($dir); array_pop($catalog['providers'][0]['models']); file_put_contents($dir . '/catalog.json', json_encode($catalog));
    $service->sync(); assert_sync(read_catalog($dir) === $catalog, 'deleted model stays removed');
    assert_sync($service->status()['status']['suppressed']['yunhui']['gpt-6.1-sol'] === true, 'suppression audited');
});
$test('failed and empty upstream responses retain last successful cache', static function ($dir): void {
    $service = sync_fixture($dir); $service->sync(); $before = $service->status();
    sync_error(fn() => sync_fixture($dir, 'failed')->sync(), 'SYNC_UPSTREAM_UNAVAILABLE');
    $after = $service->status(); assert_sync($after['catalog'] === $before['catalog'] && $after['status']['lastSuccessAt'] === $before['status']['lastSuccessAt'], 'cache and success date retained');
    assert_sync($after['status']['lastResult'] === 'failed', 'failed attempt recorded');
    sync_error(fn() => sync_fixture($dir, 'empty')->sync(), 'SYNC_EMPTY');
    assert_sync($service->status()['catalog'] === $before['catalog'], 'empty response cannot erase cache');
});
$test('bounded discovery never enumerates accounts and blocks overlapping jobs', static function ($dir): void {
    sync_error(fn() => sync_fixture($dir, 'too-many')->sync(), 'SYNC_GROUP_LIMIT');
    $lock = fopen($dir . '/catalog-sync.lock', 'c'); flock($lock, LOCK_EX);
    sync_error(fn() => sync_fixture($dir)->sync(), 'SYNC_BUSY'); flock($lock, LOCK_UN); fclose($lock);
});
$test('administrator edits during upstream reads are preserved', static function ($dir): void {
    $edited = false;
    $service = sync_fixture($dir, '', static function ($path) use ($dir, &$edited): void {
        if ($edited) return; $edited = true;
        $lock = fopen($dir . '/catalog-write.lock', 'c'); flock($lock, LOCK_EX);
        $catalog = read_catalog($dir); $catalog['providers'][0]['note'] = '同步过程中编辑'; $catalog['version']++;
        file_put_contents($dir . '/catalog.json', json_encode($catalog)); flock($lock, LOCK_UN); fclose($lock);
    });
    $service->sync(); assert_sync(read_catalog($dir)['providers'][0]['note'] === '同步过程中编辑', 'fresh read under common lock');
});
echo 'All ' . $count . ' catalog synchronization tests passed.' . PHP_EOL;
