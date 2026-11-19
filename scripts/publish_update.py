"""Publish verified Windows/macOS update metadata, preserving a private undo snapshot.

Packages must already be mirrored to the official website. Without --apply this
only validates local artifacts and prints the proposed public metadata.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shlex
import urllib.request

from remote_ssh import connect, execute

ROOT = Path(__file__).resolve().parents[1]
RELEASE_URL = 'https://yunhui.me/releases/'
WEB_ROOT = '/www/wwwroot/yunhui.me'
TARGETS = {'win-x64': 'win-x64-setup.exe', 'mac-arm64': 'mac-arm64.dmg', 'mac-x64': 'mac-x64.dmg'}


def prepare_release(release_dir, notes=None, package_file=ROOT / 'package.json'):
    version = json.loads(package_file.read_text(encoding='utf-8'))['version']
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Only a stable package version may be published')
    manifest = json.loads((release_dir / 'BUILD-MANIFEST.json').read_text(encoding='utf-8'))
    if manifest.get('version') != version:
        raise ValueError('Build manifest version does not match package.json')
    records = manifest.get('files')
    if not isinstance(records, list) or any(not isinstance(item, dict) for item in records):
        raise ValueError('Build manifest files must be a list of records')
    names = [item.get('file') for item in records]
    if any(not isinstance(name, str) for name in names) or len(set(names)) != len(names):
        raise ValueError('Build manifest has invalid or duplicate filenames')
    manifest_files = {item['file']: item for item in records}
    payload = {'version': version, 'notes': notes if notes is not None else f'云汇 AI {version} 正式版，支持 Windows 和 macOS。',
               'mandatory': False, 'files': {}, 'sha256': {}}
    sizes = {}
    for target, suffix in TARGETS.items():
        filename = f'YunHuiAI-{version}-{suffix}'
        expected = manifest_files.get(filename)
        if expected is None:
            raise ValueError(f'Build manifest is missing {filename}')
        size, digest = expected.get('bytes'), expected.get('sha256')
        if type(size) is not int or size <= 0 or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', digest):
            raise ValueError(f'Invalid size or SHA256 in build manifest: {filename}')
        file = release_dir / filename
        if not file.is_file() or file.stat().st_size != size:
            raise ValueError(f'Local package is missing or has the wrong size: {filename}')
        hasher = hashlib.sha256()
        with file.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                hasher.update(chunk)
        if hasher.hexdigest() != digest.lower():
            raise ValueError(f'Local package SHA256 mismatch: {filename}')
        payload['files'][target] = RELEASE_URL + filename
        payload['sha256'][target] = digest.lower()
        sizes[target] = size
    return payload, sizes


def verify_public_files(payload, sizes):
    for target, url in payload['files'].items():
        request = urllib.request.Request(url, method='HEAD', headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=30) as response:
            if (response.status != 200 or response.geturl() != url
                    or int(response.headers.get('Content-Length', 0)) != sizes[target]):
                raise RuntimeError(f'Public package is absent, redirected, or has the wrong length: {target}')


def publication_program(payload, sizes):
    encoded = base64.b64encode(json.dumps({'update': payload, 'sizes': sizes}).encode('utf-8')).decode('ascii')
    return """
require '%s/lib.php';
if(!is_file(data_path('config.json')))throw new RuntimeException('Existing site configuration is required');
$input=json_decode(base64_decode('%s'),true,512,JSON_THROW_ON_ERROR);
$payload=$input['update'];
foreach($payload['files'] as $platform=>$url) {
  $file='%s/releases/'.basename(parse_url($url,PHP_URL_PATH));
  if(!is_file($file)||filesize($file)!==$input['sizes'][$platform]
     ||!hash_equals($payload['sha256'][$platform],hash_file('sha256',$file)))
    throw new RuntimeException('Uploaded package size/SHA256 mismatch: '.$platform);
}
$backup=null;
$result=config_update(function(array $cfg) use($payload,&$backup):array {
  $previous=(array)($cfg['update']??[]);
  if(version_compare($payload['version'],(string)($previous['version']??'0.0.0'),'<'))
    throw new RuntimeException('Refusing to downgrade the published version');
  $next=normalize_update($payload,$previous);
  $dir=data_path('release-backups');
  if(is_link($dir)||(!is_dir($dir)&&!mkdir($dir,0700,true))||!chmod($dir,0700))
    throw new RuntimeException('Cannot create private backup directory');
  $backup='release-backups/'.gmdate('Ymd').'T'.gmdate('His').'Z-'.bin2hex(random_bytes(4)).'.json';
  if(!store_write($backup,$cfg))throw new RuntimeException('Cannot create release metadata backup');
  $cfg['update']=$next;
  return $cfg;
});
echo json_encode(['ok'=>true,'version'=>$result['update']['version'],
  'files'=>$result['update']['files'],'sha256'=>$result['update']['sha256'],
  'publishedAt'=>$result['update']['publishedAt'],'backup'=>data_path($backup)],JSON_UNESCAPED_SLASHES);
""" % (WEB_ROOT, encoded, WEB_ROOT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', required=True, type=Path, help='Verified delivery directory containing BUILD-MANIFEST.json')
    parser.add_argument('--notes-file', type=Path, help='UTF-8 public release notes')
    parser.add_argument('--apply', action='store_true', help='Verify uploaded packages and publish website update metadata')
    args = parser.parse_args()
    notes = args.notes_file.read_text(encoding='utf-8') if args.notes_file else None
    payload, sizes = prepare_release(args.release_dir.resolve(), notes)
    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    if not args.apply:
        print('Dry run: local artifacts verified; website metadata unchanged. Use --apply after mirroring the packages.')
        return
    verify_public_files(payload, sizes)
    program = publication_program(payload, sizes)
    with connect() as client:
        print(execute(client, 'runuser -u www -- /www/server/php/82/bin/php -r ' + shlex.quote(program)))


if __name__ == '__main__':
    main()
