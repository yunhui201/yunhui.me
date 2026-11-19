<?php
/** Deterministic filesystem-fault injection against an isolated copy of the production service. */
declare(strict_types=1);
$root = sys_get_temp_dir() . '/aurora-catalog-publish-' . bin2hex(random_bytes(6)); mkdir($root, 0700, true);
$source = (string)file_get_contents(__DIR__ . '/../server/catalog_sync.php');
$needle = "    private function write(string \$name, array \$data): void\n    {";
$source = str_replace("\r\n", "\n", $source);
$source = str_replace($needle, $needle . "\n        if ((\$GLOBALS['catalogPublishFailure'] ?? '') === \$name) throw new RuntimeException('Simulated filesystem failure');", $source, $injected);
if ($injected !== 1) throw new RuntimeException('Persistence fault injection failed');
file_put_contents($root . '/catalog_sync.php', $source);
copy(__DIR__ . '/../server/member_service.php', $root . '/member_service.php');
require $root . '/catalog_sync.php';
ini_set('error_log', $root . '/error.log');
$catalog = ['version' => 5, 'providers' => [['key' => 'fixture', 'format' => 'openai-responses',
    'baseUrl' => 'https://api.yunhui.me/v1', 'models' => [['id' => 'original']]]]];
file_put_contents($root . '/catalog.json', json_encode($catalog));
$bundle = ['status' => ['lastResult' => 'success'], 'catalog' => ['models' => [['id' => 'new-model', 'platform' => 'openai']]]];
file_put_contents($root . '/catalog-sync-state.json', json_encode($bundle));
$service = new CatalogSyncService(['origin' => 'https://api.yunhui.me', 'adminKey' => 'fixture-only-key'], $root);
$read = static fn(string $name): array => json_decode((string)file_get_contents($root . '/' . $name), true, 64, JSON_THROW_ON_ERROR);
$check = static function (bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); echo 'PASS ' . $message . PHP_EOL; };
$GLOBALS['catalogPublishFailure'] = 'catalog.json';
$failed = false;
try { $service->addSelected('fixture', ['new-model']); } catch (RuntimeException $error) { $failed = true; }
$check($failed && $read('catalog.json') === $catalog && $read('catalog-sync-state.json') === $bundle,
    'catalog write failure reports failure and preserves published data plus audit');
$GLOBALS['catalogPublishFailure'] = 'catalog-sync-state.json';
$result = $service->addSelected('fixture', ['new-model']);
$check($result['ok'] && $result['added'] === 1 && !$result['auditSaved'] && str_contains($result['warning'], '精选目录已生效'),
    'audit failure reports committed selection with an explicit warning');
$published = $read('catalog.json');
$check($published['version'] === 6 && array_column($published['providers'][0]['models'], 'id') === ['original', 'new-model']
    && $read('catalog-sync-state.json') === $bundle, 'audit failure retains the published catalog and last complete audit');
$GLOBALS['catalogPublishFailure'] = '';
$retry = $service->addSelected('fixture', ['new-model']);
$check($retry['ok'] && $retry['added'] === 0 && $retry['auditSaved'] && $read('catalog.json') === $published
    && $read('catalog-sync-state.json')['status']['managed']['fixture'] === ['new-model'], 'retry repairs audit without duplicating models or advancing public version');
echo "All 4 catalog publication failure checks passed.\n";
