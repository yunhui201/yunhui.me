"""Upload reviewed PHP sources atomically, retaining previous files outside the webroot."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import posixpath
import shlex
from remote_ssh import connect, execute

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true', help='Perform the displayed deployment plan')
parser.add_argument('--php-bin', default='/www/server/php/82/bin/php', help='Remote PHP 8.1+ CLI path, matching the website FPM version')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
webroot = '/www/wwwroot/yunhui.me'
files = ['lib.php', 'api.php', 'pub.php', 'index.php', 'member_service.php', 'member.php', 'member_admin.php', 'catalog_sync.php', 'catalog_sync_admin.php']
print('PHP deployment:', ', '.join(files), '->', webroot)
print('Remote PHP syntax checks:', args.php_bin)
print('Existing catalog, administrator settings and release metadata are preserved.')
if not args.apply:
    raise SystemExit('Review the files, then run with --apply to deploy.')
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = '/www/aurora-backups/' + stamp
stage = backup + '/staged'
with connect() as client:
    execute(client, f'mkdir -p {shlex.quote(stage)} && chmod 700 /www/aurora-backups {shlex.quote(backup)} {shlex.quote(stage)}')
    with client.open_sftp() as sftp:
        for name in files:
            sftp.put(str(root / 'server' / name), posixpath.join(stage, name))
            execute(client, shlex.quote(args.php_bin) + ' -l ' + shlex.quote(posixpath.join(stage, name)))
        # All files pass syntax checks before replacing any live file.
        for name in files:
            target = posixpath.join(webroot, name)
            execute(client, f'if [ -f {shlex.quote(target)} ]; then cp -p {shlex.quote(target)} {shlex.quote(posixpath.join(backup, name))}; fi')
            sftp.chmod(posixpath.join(stage, name), 0o644)
            sftp.posix_rename(posixpath.join(stage, name), target)
            print('Deployed', name)
print('Previous files retained at', backup)
