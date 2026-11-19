"""Mirror a verified release to the official website without changing update metadata."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import secrets
import shlex

from remote_ssh import connect, execute

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = '/www/wwwroot/yunhui.me/releases'


def file_record(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return {'file': path.name, 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}


def prepare_files(release_dir, package_file=ROOT / 'package.json'):
    version = json.loads(package_file.read_text(encoding='utf-8'))['version']
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Only a stable package version may be uploaded')
    manifest_file = release_dir / 'BUILD-MANIFEST.json'
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    if manifest.get('version') != version:
        raise ValueError('Build manifest version does not match package.json')
    entries = manifest.get('files')
    if not isinstance(entries, list) or not entries:
        raise ValueError('Build manifest files must be a nonempty list')
    records = []
    names = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError('Invalid build manifest record')
        name, size, digest = entry.get('file'), entry.get('bytes'), entry.get('sha256')
        if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9._-]+', name)
                or not name.startswith(f'YunHuiAI-{version}-') or name in names):
            raise ValueError('Invalid, duplicate, or wrong-version package filename')
        if type(size) is not int or size <= 0 or not isinstance(digest, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', digest):
            raise ValueError('Invalid package size or SHA256: ' + name)
        path = release_dir / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Package must be a regular file: ' + name)
        actual = file_record(path)
        if actual['bytes'] != size or actual['sha256'] != digest.lower():
            raise ValueError('Local package size/SHA256 mismatch: ' + name)
        names.add(name)
        records.append(actual)
    required = {f'YunHuiAI-{version}-{suffix}' for suffix in ('win-x64-setup.exe', 'mac-arm64.dmg', 'mac-x64.dmg')}
    if not required.issubset(names):
        raise ValueError('Build manifest must include the Windows installer and both macOS installers')
    checksums = {}
    sums_file = release_dir / 'SHA256SUMS.txt'
    for line in sums_file.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'([a-fA-F0-9]{64}) [ *]([A-Za-z0-9._-]+)', line)
        if not match or match[2] in checksums:
            raise ValueError('Invalid or duplicate SHA256SUMS entry')
        checksums[match[2]] = match[1].lower()
    if checksums != {item['file']: item['sha256'] for item in records}:
        raise ValueError('SHA256SUMS does not match the complete build manifest')
    records.extend(file_record(path) for path in (manifest_file, sums_file))
    return version, records


def remote_record(client, path):
    program = """
import hashlib,json,os,stat
path=%r
if not os.path.lexists(path):
    print('null')
else:
    if not stat.S_ISREG(os.lstat(path).st_mode):
        raise RuntimeError('Destination must be a regular file')
    digest=hashlib.sha256()
    with open(path,'rb') as source:
        for block in iter(lambda: source.read(1048576), b''):
            digest.update(block)
    print(json.dumps({'bytes':os.path.getsize(path),'sha256':digest.hexdigest()}))
""" % path
    return json.loads(execute(client, 'python3 -c ' + shlex.quote(program)))


def same_file(observed, expected):
    return observed is not None and all(observed[key] == expected[key] for key in ('bytes', 'sha256'))


def upload_files(client, release_dir, records, replace_existing=False):
    # Preflight every destination before uploading anything, including shared metadata files.
    observations = {}
    for record in records:
        target = DESTINATION + '/' + record['file']
        observed = remote_record(client, target)
        observations[record['file']] = observed
        if observed is not None and not same_file(observed, record) and not replace_existing:
            raise RuntimeError('Different file already exists; use --replace-existing to retain a private backup: ' + record['file'])
    pending = [item for item in records if not same_file(observations[item['file']], item)]
    for item in records:
        if item not in pending:
            print('Already verified: ' + item['file'], flush=True)
    if not pending:
        return None
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = '/www/aurora-backups/' + stamp + '-' + secrets.token_hex(4) + '-release-upload'
    execute(client, 'test -d ' + shlex.quote(DESTINATION))
    execute(client, 'install -d -m 700 -- ' + ' '.join(shlex.quote(path) for path in (backup, backup + '/incoming', backup + '/previous')))
    print('Private staging/backup: ' + backup, flush=True)
    with client.open_sftp() as sftp:
        for record in pending:
            name = record['file']
            staged = backup + '/incoming/' + name
            target = DESTINATION + '/' + name
            print('Uploading: ' + name, flush=True)
            sftp.put(str(release_dir / name), staged, confirm=True)
            sftp.chmod(staged, 0o600)
            if not same_file(remote_record(client, staged), record):
                raise RuntimeError('Uploaded package size/SHA256 mismatch: ' + name)
            # Recheck before replacing. Another publisher must not silently lose its work.
            observed = remote_record(client, target)
            if observed != observations[name]:
                raise RuntimeError('Destination changed during upload; staged file retained: ' + name)
            if observed is not None:
                previous = backup + '/previous/' + name
                execute(client, 'cp -p -- ' + shlex.quote(target) + ' ' + shlex.quote(previous))
                if not same_file(remote_record(client, previous), observed):
                    raise RuntimeError('Previous package backup verification failed: ' + name)
                sftp.chmod(previous, 0o600)
            sftp.chmod(staged, 0o644)
            sftp.posix_rename(staged, target)
            print('Published verified file: ' + name, flush=True)
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', required=True, type=Path, help='Verified delivery directory containing BUILD-MANIFEST.json and SHA256SUMS.txt')
    parser.add_argument('--apply', action='store_true', help='Upload verified files; update metadata remains unchanged')
    parser.add_argument('--replace-existing', action='store_true', help='Back up and replace different same-name files, including shared manifest/checksum files')
    args = parser.parse_args()
    release_dir = args.release_dir.resolve()
    version, records = prepare_files(release_dir)
    print(json.dumps({'version': version, 'files': records}, indent=2), flush=True)
    if not args.apply:
        print('Dry run: local artifacts verified; website unchanged. Use --apply to upload.')
        return
    with connect() as client:
        upload_files(client, release_dir, records, args.replace_existing)
    print('Upload complete. Update metadata is unchanged. Next run:')
    print('python scripts/publish_update.py --release-dir "' + str(release_dir) + '" --apply')


if __name__ == '__main__':
    main()
