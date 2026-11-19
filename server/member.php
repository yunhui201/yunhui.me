<?php
declare(strict_types=1);
require_once __DIR__ . '/member_service.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
// No cookie credentials. Bearer sessions also require the installation secret.
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Aurora-Installation, X-Aurora-Installation-Proof');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }

try {
    $action = (string)($_GET['a'] ?? ($_GET['action'] ?? 'config'));
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($action, ['config', 'status'], true) && $method !== 'POST') {
        header('Allow: POST');
        throw new MemberError('METHOD_NOT_ALLOWED', '会员写操作必须使用 POST', 405);
    }
    if (!in_array($method, ['GET', 'POST'], true)) throw new MemberError('METHOD_NOT_ALLOWED', '请求方式不支持', 405);
    $raw = file_get_contents('php://input', false, null, 0, 32769);
    if ($raw === false || strlen($raw) > 32768) throw new MemberError('BODY_TOO_LARGE', '请求内容过长', 413);
    $body = $raw === '' ? [] : json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($body) || ($body !== [] && array_is_list($body))) throw new MemberError('INVALID_JSON', '请求格式无效');
    $authorization = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    $credentials = [
        'installationId' => (string)($_SERVER['HTTP_X_AURORA_INSTALLATION'] ?? ''),
        'installationProof' => (string)($_SERVER['HTTP_X_AURORA_INSTALLATION_PROOF'] ?? ''),
        'sessionToken' => str_starts_with($authorization, 'Bearer ') ? substr($authorization, 7) : '',
    ];
    $service = new MemberService(MemberService::environment());
    $response = $service->handle($action, $body, $credentials, (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'));
    echo json_encode($response, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
} catch (MemberError $error) {
    http_response_code($error->httpStatus);
    echo json_encode(['ok' => false, 'code' => $error->errorCode, 'error' => $error->getMessage()], JSON_UNESCAPED_UNICODE);
} catch (JsonException $error) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'code' => 'INVALID_JSON', 'error' => '请求格式无效'], JSON_UNESCAPED_UNICODE);
} catch (Throwable $error) {
    // Never include raw upstream errors, request bodies, credentials or PDO paths in public output/logs.
    error_log('yunhui.me member service failure: ' . get_class($error));
    http_response_code(503);
    echo json_encode(['ok' => false, 'code' => 'SERVICE_UNAVAILABLE', 'error' => '会员服务暂不可用，请稍后重试'], JSON_UNESCAPED_UNICODE);
}
