"""Real local PHP login/form tests; isolated storage and a trusted fake upstream only."""
import argparse
from contextlib import closing
import hashlib
import html
from html.parser import HTMLParser
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import build_opener, HTTPCookieProcessor, HTTPRedirectHandler, ProxyHandler, Request


ROOT = Path(__file__).resolve().parents[1]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PolicyForm(HTMLParser):
    def __init__(self, document):
        super().__init__(convert_charrefs=True)
        self.fields = {}
        self.active = False
        self.textarea = False
        self.feed(document)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.active = attrs.get("id") == "gift-policy-form"
        if not self.active:
            return
        if tag == "input" and attrs.get("name"):
            if attrs.get("type") != "checkbox" or "checked" in attrs:
                self.fields[attrs["name"]] = attrs.get("value", "")
        if tag == "textarea" and attrs.get("name") == "message":
            self.textarea = True
            self.fields["message"] = ""

    def handle_endtag(self, tag):
        if tag == "form":
            self.active = False
        if tag == "textarea":
            self.textarea = False

    def handle_data(self, data):
        if self.active and self.textarea:
            self.fields["message"] += data


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise AssertionError("Fixture isolation anchor changed: " + old)
    return source.replace(old, new)


def php_string(value):
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--php", default=os.environ.get("PHP_BINARY") or shutil.which("php"))
    parser.add_argument("--php-extension-dir", type=Path)
    parser.add_argument("--browser", action="store_true", help="Also check the live form with Playwright at desktop and mobile sizes")
    args = parser.parse_args()
    if not args.php:
        parser.error("PHP 8.1+ is required on PATH, or set PHP_BINARY / --php")
    # Hosting CLI builds can inherit a web ini that disables putenv(). This private
    # HTTP fixture changes its own environment; never modify the host's PHP.ini.
    command = [args.php, "-d", "disable_functions="]
    if args.php_extension_dir:
        command += ["-d", "extension_dir=" + str(args.php_extension_dir.resolve())]
        for extension in ("pdo_sqlite", "openssl"):
            command += ["-d", "extension=" + extension]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    check = subprocess.run(command + ["-r", "exit(PHP_VERSION_ID>=80100 && extension_loaded('pdo_sqlite') && extension_loaded('openssl') ? 0 : 1);"],
                           capture_output=True, text=True, timeout=20, creationflags=flags)
    if check.returncode:
        raise RuntimeError("PHP 8.1+, pdo_sqlite and openssl are required: " + check.stderr)

    checks = []

    def passed(label):
        checks.append(label)
        print("PASS " + label)

    with tempfile.TemporaryDirectory(prefix="yunhui-admin-policy-") as temporary:
        private = Path(temporary)
        os.chmod(private, 0o700)
        webroot, data, ledger = private / "web", private / "admin", private / "ledger"
        for directory in (webroot, data, ledger):
            directory.mkdir(mode=0o700)
        for name in ("lib.php", "api.php", "member_admin.php", "member_service.php", "member.php"):
            source = (ROOT / "server" / name).read_text(encoding="utf-8")
            if name == "lib.php":
                source = replace_once(source, "const AURORA_DATA_DIR = '/www/aurora-data';",
                                      "const AURORA_DATA_DIR = " + php_string(data.as_posix()) + ";")
            if name == "member_service.php":
                source = replace_once(source, "$file = '/www/aurora-data/member-secrets.json';",
                                      "$file = " + php_string((private / "no-real-secrets.json").as_posix()) + ";")
            if name == "member_admin.php":
                # The sole behavior override is the supported, trusted transport argument.
                source = replace_once(source, "new MemberService(MemberService::environment());",
                                      "new MemberService(MemberService::environment(), require __DIR__ . '/../fixture-transport.php');")
            (webroot / name).write_text(source, encoding="utf-8")
        (webroot / "fixture-unconfigured.php").write_text(
            "<?php putenv('AURORA_MEMBERS_ENABLED=0'); putenv(" +
            php_string("AURORA_MEMBER_DATA_DIR=" + str(private / "unconfigured-ledger")) +
            "); require __DIR__ . '/member_admin.php';", encoding="utf-8")

        (private / "fixture-transport.php").write_text(r"""<?php
return static function (string $method, string $path, array $headers, ?array $body): array {
    $file = __DIR__ . '/upstream.json';
    $codes = is_file($file) ? json_decode(file_get_contents($file), true, 32, JSON_THROW_ON_ERROR) : [];
    $ok = static fn(array $data): array => ['status'=>200,'body'=>['code'=>0,'data'=>$data]];
    if (str_starts_with($path, '/admin/redeem-codes?') && $method === 'GET') {
        parse_str((string)parse_url($path, PHP_URL_QUERY), $query);
        $receipt = $codes[$query['search']] ?? null;
        return $ok(['items'=>$receipt ? [$receipt] : [], 'total'=>$receipt ? 1 : 0]);
    }
    if ($path === '/admin/redeem-codes/create-and-redeem' && $method === 'POST') {
        if ($body['user_id'] !== 13 || $body['value'] !== 7.5 || $body['type'] !== 'balance') {
            throw new RuntimeException('Fixture original reservation changed');
        }
        $receipt = ['id'=>113,'code'=>$body['code'],'type'=>'balance','value'=>$body['value'],'used_by'=>13,'status'=>'used'];
        $codes[$body['code']] = $receipt;
        file_put_contents($file, json_encode($codes, JSON_THROW_ON_ERROR));
        file_put_contents(__DIR__ . '/redeem.log', json_encode($body, JSON_THROW_ON_ERROR) . "\n", FILE_APPEND);
        return $ok(['redeem_code'=>$receipt]);
    }
    throw new RuntimeException('Unexpected fixture upstream request');
};
""", encoding="utf-8")
        env = {key: value for key, value in os.environ.items() if not key.startswith("AURORA_")}
        password = secrets.token_hex(24)
        fake_key = "fixture-admin-" + secrets.token_hex(16)
        fake_secret = secrets.token_hex(32)
        env.update({"AURORA_ADMIN_PASSWORD": password, "AURORA_MEMBERS_ENABLED": "1",
                    "AURORA_SUB2API_URL": "https://members.example.test", "AURORA_SUB2API_ADMIN_KEY": fake_key,
                    "AURORA_MEMBER_SECRET": fake_secret, "AURORA_MEMBER_DATA_DIR": str(ledger)})
        with socket.socket() as socket_probe:
            socket_probe.bind(("127.0.0.1", 0))
            port = socket_probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        cookies = http.cookiejar.CookieJar()
        authenticated = build_opener(ProxyHandler({}), HTTPCookieProcessor(cookies), NoRedirect())
        anonymous = build_opener(ProxyHandler({}), NoRedirect())

        def request(path="/member_admin.php", fields=None, client=authenticated, json_body=None):
            headers, payload = {}, None
            if fields is not None:
                payload = urlencode(fields).encode()
                headers["Content-Type"] = "application/x-www-form-urlencoded"
            if json_body is not None:
                payload = json.dumps(json_body).encode()
                headers["Content-Type"] = "application/json"
            try:
                response = client.open(Request(origin + path, data=payload, headers=headers), timeout=10)
            except HTTPError as error:
                response = error
            with response:
                text = response.read().decode("utf-8")
                for secret in (password, fake_key, fake_secret):
                    assert secret not in text, "Fixture secret leaked into HTTP response"
                return response.status, text, response.headers

        def policy():
            with closing(sqlite3.connect(ledger / "members.sqlite")) as connection:
                return json.loads(connection.execute("SELECT value FROM member_meta WHERE key='welcome_gift_policy'").fetchone()[0])

        server_log = private / "php.log"
        with server_log.open("wb") as log:
            process = subprocess.Popen(command + ["-d", "display_errors=0", "-d", "log_errors=1", "-S", f"127.0.0.1:{port}", "-t", str(webroot)],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, creationflags=flags)
            try:
                deadline = time.monotonic() + 15
                while True:
                    try:
                        status, _, _ = request("/api.php?a=whoami", client=anonymous)
                        assert status == 200
                        break
                    except (URLError, ConnectionError):
                        if process.poll() is not None or time.monotonic() >= deadline:
                            raise RuntimeError("Local PHP server did not start")
                        time.sleep(0.05)

                status, text, _ = request(client=anonymous)
                assert status == 302 and "gift-policy-form" not in text
                status, _, _ = request(fields={"action": "save-policy", "amountUsd": "99.00"}, client=anonymous)
                assert status == 302 and not (ledger / "members.sqlite").exists()
                passed("unauthenticated GET/POST cannot view or mutate gift policy")

                status, body, _ = request("/api.php?a=login", json_body={"password": password})
                assert status == 200 and json.loads(body)["ok"]
                status, body, headers = request()
                form = PolicyForm(body).fields
                assert status == 200 and "no-store" in headers["Cache-Control"]
                assert form["_csrf"] == json.loads(request("/api.php?a=whoami")[1])["csrf"]
                assert form["amountUsd"] == "10.00" and form["enabled"] == "1" and form["revision"] == "1"
                passed("real password login exposes a CSRF-protected default policy form")

                status, body, _ = request("/fixture-unconfigured.php")
                assert status == 200 and "会员服务尚未启用" in body and "gift-policy-form" not in body, (status, body[:500])
                assert not (private / "unconfigured-ledger").exists()
                assert request("/fixture-unconfigured.php", fields=form)[0] == 503
                assert not (private / "unconfigured-ledger").exists()
                passed("unconfigured administrator view and attempted save never initialize a ledger")

                if args.browser:
                    from playwright.sync_api import sync_playwright
                    with sync_playwright() as playwright:
                        try:
                            browser = playwright.chromium.launch(headless=True)
                        except Exception:
                            browser = playwright.chromium.launch(headless=True, channel="msedge")
                        try:
                            context = browser.new_context(locale="zh-CN")
                            assert context.request.post(origin + "/api.php?a=login", data={"password": password}).ok
                            page = context.new_page()
                            browser_errors = []
                            page.on("pageerror", lambda error: browser_errors.append(str(error)))
                            for width, height in ((1440, 1000), (390, 844)):
                                page.set_viewport_size({"width": width, "height": height})
                                assert page.goto(origin + "/member_admin.php").status == 200
                                assert page.locator('[name="amountUsd"]').input_value() == "10.00"
                                assert page.get_by_label("开启新申请赠金").is_checked()
                                assert page.get_by_role("button", name="保存赠金设置").is_visible()
                                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Page overflows viewport"
                            assert not browser_errors, browser_errors
                        finally:
                            browser.close()
                    passed("live authenticated form works at desktop/mobile sizes without page errors or viewport overflow")

                saved_form = {**form, "amountUsd": "12.50", "message": "新会员活动说明 <script>测试</script> &"}
                assert "userId" not in saved_form
                status, body, _ = request(fields=saved_form)
                assert status == 200 and "赠金设置已保存" in body
                assert html.escape(saved_form["message"], quote=True) in body
                assert "<script>测试</script>" not in body
                fresh = PolicyForm(request()[1]).fields
                assert fresh["amountUsd"] == "12.50" and fresh["message"] == saved_form["message"] and fresh["revision"] == "2"
                assert policy() == {"enabled": True, "amountCents": 1250, "message": saved_form["message"], "revision": 2}
                config = json.loads(request("/member.php?a=config", client=anonymous)[1])
                assert config["giftEnabled"] is True and config["giftUsd"] == 12.5 and config["giftMessage"] == saved_form["message"]
                passed("save without userId persists decimal amount and escaped hint; public config updates immediately")

                before = policy()
                status, body, _ = request(fields=saved_form)
                assert status == 409 and "其他管理员" in body and policy() == before
                assert PolicyForm(body).fields["revision"] == "2"
                passed("stale administrator form gets HTTP 409 and reloads the current revision")

                for csrf in (None, "incorrect"):
                    invalid = {**fresh, "amountUsd": "25.00"}
                    if csrf is None:
                        invalid.pop("_csrf")
                    else:
                        invalid["_csrf"] = csrf
                    assert request(fields=invalid)[0] == 419 and policy() == before
                passed("missing and incorrect CSRF tokens never change the saved policy")

                invalid_cases = [{"amountUsd": value} for value in ("0", "-1", "10000.01", "1.001", "1e2", "NaN", "")]
                invalid_cases += [{"message": "字" * 201}, {"enabled": "false"}, {"revision": "0"},
                                  {"revision": "x"}, {"amountUsd": None, "amountUsd[]": "15.00"},
                                  {"enabled": None, "enabled[]": "1"}, {"action": "unknown"}]
                for overrides in invalid_cases:
                    invalid = dict(fresh)
                    for key, value in overrides.items():
                        if value is None:
                            invalid.pop(key, None)
                        else:
                            invalid[key] = value
                    assert request(fields=invalid)[0] == 400, overrides
                    assert policy() == before, overrides
                passed("14 invalid monetary, hint, revision, checkbox and action submissions cannot mutate policy")

                now = int(time.time())
                with closing(sqlite3.connect(ledger / "members.sqlite")) as connection:
                    for user, state, cents in ((11, "claimed", 1000), (12, "claimed", 1250), (13, "pending", 750), (14, "review", 2222)):
                        installation = hashlib.sha256(f"fixture-installation-{user}".encode()).hexdigest()
                        connection.execute("INSERT INTO installations VALUES(?,?,?)", (installation, "fixture-proof", now))
                        connection.execute("INSERT INTO welcome_grants(user_id,installation_hash,code,status,amount_cents,created_at,claimed_at,upstream_id,last_error) VALUES(?,?,?,?,?,?,?,?,?)",
                                           (user, installation, f"YQW-FIXTURE-{user}", state, cents, now, now if state == "claimed" else None,
                                            user if state == "claimed" else None, "fixture-review" if state == "review" else None))
                    connection.commit()
                body = request()[1]
                assert "累计赠送额度<strong>$22.50</strong>" in body and "金额（USD）" in body
                assert all(f"<td>${amount}</td>" in body for amount in ("10.00", "12.50", "7.50", "22.22"))
                passed("mixed historical grant amounts render correctly and total sums only claimed reservations")

                disabled = {**fresh, "amountUsd": "25.00", "message": "活动暂停"}
                disabled.pop("enabled")
                status, body, _ = request(fields=disabled)
                assert status == 200 and "赠金活动已暂停" in body and "enabled" not in PolicyForm(body).fields
                assert "重试原申请" in body and policy()["enabled"] is False
                config = json.loads(request("/member.php?a=config")[1])
                assert config["enabled"] is True and config["giftEnabled"] is False and config["giftUsd"] == 25
                passed("activity toggle pauses new gifts while service and pending controls remain available")

                status, body, _ = request(fields={"_csrf": fresh["_csrf"], "action": "retry", "userId": "13"})
                assert status == 200 and "账户 #13 的 $7.50 赠金" in body
                redeemed = [json.loads(line) for line in (private / "redeem.log").read_text().splitlines()]
                assert len(redeemed) == 1 and redeemed[0]["value"] == 7.5 and redeemed[0]["code"] == "YQW-FIXTURE-13"
                assert "累计赠送额度<strong>$30.00</strong>" in body
                passed("retry while disabled redeems the original $7.50 reservation, never the new $25 amount")

                status, body, _ = request(fields={"_csrf": fresh["_csrf"], "action": "reconcile", "userId": "13"})
                assert status == 200 and "账户 #13 的 $7.50 赠金" in body
                assert len((private / "redeem.log").read_text().splitlines()) == 1
                passed("reconcile reports the original amount and does not credit an existing grant twice")

                current = PolicyForm(request()[1]).fields
                status, body, _ = request(fields={**current, "enabled": "1", "amountUsd": "0.01", "message": ""})
                assert status == 200 and policy()["amountCents"] == 1 and policy()["enabled"] is True
                assert "累计赠送额度<strong>$30.00</strong>" in body
                passed("reopening at a one-cent amount preserves previous grants and the claimed total")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        log_text = server_log.read_text(encoding="utf-8", errors="replace")
        assert not any(error in log_text for error in ("PHP Warning", "PHP Fatal", "PHP Parse", "PHP Deprecated")), log_text
        passed("PHP HTTP execution is free of warnings and fatal errors; isolated server stops cleanly")
    print(f"All {len(checks)} member administrator policy checks passed.")


if __name__ == "__main__":
    main()
