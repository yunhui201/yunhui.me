<?php
/** Real PHP session storage across processes; disposable files and no real login. */
declare(strict_types=1);
if (($argv[1] ?? '') === '--session-worker') {
    $directory = $argv[2];
    ini_set('session.save_path', $directory . '/shared');
    ini_set('session.gc_maxlifetime', '1440');
    ini_set('session.gc_probability', '0');
    ini_set('session.gc_divisor', '1');
    require $directory . '/lib.php';
    if (!empty($argv[4])) session_id($argv[4]);
    boot_session();
    $action = $argv[3];
    if ($action === 'read') session_gc();
    if ($action === 'create' || $action === 'expired') {
        $_SESSION['aurora_admin'] = true;
        $_SESSION['loginAt'] = time() - ($action === 'expired' ? 43201 : 3600);
    }
    $result = ['id' => session_id(), 'loggedIn' => is_logged_in(), 'csrf' => csrf_token(),
        'path' => session_save_path(), 'gc' => (int)ini_get('session.gc_maxlifetime'),
        'strict' => ini_get('session.use_strict_mode'), 'probability' => ini_get('session.gc_probability'),
        'divisor' => ini_get('session.gc_divisor'), 'cookie' => session_get_cookie_params()];
    if ($action === 'logout') { $_SESSION = []; session_destroy(); }
    else session_write_close();
    echo json_encode($result, JSON_THROW_ON_ERROR);
    exit;
}

$directory = sys_get_temp_dir() . '/yunhui-admin-session-' . bin2hex(random_bytes(6));
mkdir($directory . '/shared', 0700, true);
$source = (string)file_get_contents(__DIR__ . '/../server/lib.php');
$source = str_replace("const AURORA_DATA_DIR = '/www/aurora-data';", 'const AURORA_DATA_DIR = ' . var_export($directory, true) . ';', $source, $replaced);
if ($replaced !== 1) throw new RuntimeException('Session test isolation failed');
file_put_contents($directory . '/lib.php', $source);
function worker(string $action, string $id = ''): array {
    global $directory;
    $process = proc_open([PHP_BINARY, __FILE__, '--session-worker', $directory, $action, $id],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($process)) throw new RuntimeException('Cannot launch session worker');
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); $error = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    if (proc_close($process) !== 0) throw new RuntimeException('Session worker failed: ' . $error);
    return json_decode($out, true, 32, JSON_THROW_ON_ERROR);
}
function check(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
    echo 'PASS ' . $message . PHP_EOL;
}
try {
    $created = worker('create');
    check($created['loggedIn'] && $created['path'] === $directory . '/admin-sessions' && $created['gc'] === 43200,
        'Admin sessions use private storage and the intended 12-hour lifetime');
    check($created['cookie']['lifetime'] === 43200 && $created['cookie']['httponly'] && $created['cookie']['samesite'] === 'Lax' && $created['strict'] === '1',
        'Cookie lifetime survives browser restart with strict session IDs and HttpOnly protection');
    $sessionFile = $created['path'] . '/sess_' . $created['id'];
    touch($sessionFile, time() - 3600);
    $unrelated = $directory . '/shared/sess_unrelated';
    file_put_contents($unrelated, 'unrelated'); touch($unrelated, time() - 3600);
    $expiredFile = $created['path'] . '/sess_expiredfixture';
    file_put_contents($expiredFile, 'expired'); touch($expiredFile, time() - 43201);
    $read = worker('read', $created['id']);
    check($read['loggedIn'] && $read['id'] === $created['id'] && $read['csrf'] === $created['csrf'] && is_file($unrelated),
        'Forced garbage collection retains an hour-old login and does not touch shared sessions');
    check($read['probability'] === '1' && $read['divisor'] === '100' && !is_file($expiredFile),
        'Private sessions enable their own garbage collection even when PHP defaults disable it');
    check(!worker('expired')['loggedIn'], 'Absolute 12-hour expiration remains enforced');
    worker('logout', $created['id']);
    $after = worker('read', $created['id']);
    check(!$after['loggedIn'] && $after['id'] !== $created['id'], 'Logout removes the session and a supplied stale ID cannot revive it');
    echo "Administrator session storage: 6 checks passed.\n";
} finally {
    // Every file is under the independently created fixture; never a system session path.
    foreach (['admin-sessions', 'shared'] as $folder) {
        foreach (glob($directory . '/' . $folder . '/*') ?: [] as $file) if (is_file($file)) unlink($file);
        if (is_dir($directory . '/' . $folder)) rmdir($directory . '/' . $folder);
    }
    unlink($directory . '/lib.php'); rmdir($directory);
}
