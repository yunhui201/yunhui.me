"""Package reproducible mobile sources, never dependencies, local data or credentials."""
import pathlib
import json
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
destination = root / 'build' / f'YunHuiAI-{version}-iOS-source.zip'
destination.parent.mkdir(exist_ok=True)
files = [root / name for name in ['README.md', 'package.json', 'package-lock.json', 'capacitor.config.json', '.gitignore']]
for name in ['src', 'www', 'scripts', 'tests', 'assets', 'ios']:
    for file in (root / name).rglob('*'):
        if not file.is_file() or any(part in {'Pods', 'build', 'node_modules', '__pycache__', 'xcuserdata'} for part in file.relative_to(root).parts):
            continue
        files.append(file)
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for notice in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
        archive.write(root.parent / notice, notice)
    for file in sorted(files):
        archive.write(file, 'mobile/' + file.relative_to(root).as_posix())
print(f'iOS source package: {destination} ({len(files) + 2} files)')
