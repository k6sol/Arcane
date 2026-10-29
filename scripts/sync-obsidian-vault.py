"""Project committed Arcane knowledge and skills into an existing Obsidian vault.

Check by default; --apply writes only additions and unchanged managed notes.
Personal notes, Obsidian settings and locally edited files are never overwritten.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = '.arcane-sync.json'
LIMIT = 64 * 1024 * 1024


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, timeout=60)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_target(vault, relative):
    parts = PurePosixPath(relative).parts
    if (not parts or PurePosixPath(relative).is_absolute()
            or any(p in ('.', '..', '.git', '.obsidian') or ':' in p or '\\' in p for p in parts)):
        raise ValueError('Unsafe vault path: ' + relative)
    target = vault.joinpath(*parts)
    for parent in [target, *target.parents]:
        if parent == vault:
            break
        if parent.is_symlink() or (parent.exists() and parent.resolve() != parent.absolute()):
            raise ValueError('Linked vault path refused: ' + relative)
    if not target.resolve().is_relative_to(vault):
        raise ValueError('Vault path escapes destination: ' + relative)
    return target


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.arcane-write-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault', required=True, type=Path)
    parser.add_argument('--revision', required=True, help='Exact committed revision or Git tree')
    parser.add_argument('--apply', action='store_true', help='Write after checking every destination for conflicts')
    args = parser.parse_args()
    vault = args.vault.resolve(strict=True)
    if not (vault / '.obsidian').is_dir() or vault == ROOT or ROOT.is_relative_to(vault) or vault.is_relative_to(ROOT):
        raise ValueError('Choose an existing separate Obsidian vault with its .obsidian directory.')
    revision = git('rev-parse', '--verify', args.revision + '^{tree}').decode().strip()
    entries = git('ls-tree', '-rlz', revision, '--', 'docs/vault', 'skills/arcane', 'skills/registry.json', '.agents/skills', 'LICENSE').split(b'\0')
    projected, sources = {}, []
    total = 0
    for entry in filter(None, entries):
        meta, raw_path = entry.split(b'\t', 1)
        mode, kind, blob, raw_size = meta.decode().split()
        source = raw_path.decode('utf-8')
        if mode != '100644' or kind != 'blob':
            raise ValueError('Only ordinary source files may enter the vault: ' + source)
        if source.startswith('docs/vault/'):
            relative = source[len('docs/vault/'):]
        elif source.startswith('skills/arcane/'):
            relative = 'Skill Library/Arcane/' + source[len('skills/arcane/'):]
        elif source == 'skills/registry.json':
            relative = 'Skill Library/registry.json'
        elif source == 'LICENSE':
            relative = 'Skill Library/LICENSE.txt'
        elif source.startswith('.agents/skills/arcane-') and source.endswith('/SKILL.md'):
            relative = 'Development Skills/' + source[len('.agents/skills/'):]
        elif source.startswith('.agents/skills/'):
            continue
        else:
            raise ValueError('Unrecognized knowledge source: ' + source)
        if relative == MANIFEST or relative.casefold() in {p[0].casefold() for p in sources}:
            raise ValueError('Duplicate or reserved destination: ' + relative)
        size = int(raw_size)
        total += size
        if size > 4 * 1024 * 1024 or total > LIMIT or len(sources) >= 4096:
            raise ValueError('Knowledge projection exceeds its bounded size.')
        sources.append((relative, blob, size))
    batch = subprocess.check_output(['git', 'cat-file', '--batch'], cwd=ROOT,
                                    input=('\n'.join(blob for _, blob, _ in sources) + '\n').encode(), timeout=60)
    offset = 0
    for relative, blob, size in sources:
        end = batch.index(b'\n', offset)
        if batch[offset:end].decode() != f'{blob} blob {size}':
            raise ValueError('Unexpected committed object response.')
        offset = end + 1
        data = batch[offset:offset + size]
        offset += size
        if len(data) != size or batch[offset:offset + 1] != b'\n':
            raise ValueError('Incomplete committed object response.')
        offset += 1
        if b'\0' in data:
            raise ValueError('Binary content is outside the knowledge projection: ' + relative)
        projected[relative] = data
    if offset != len(batch):
        raise ValueError('Unexpected trailing committed object data.')
    if 'Home.md' not in projected:
        raise ValueError('Revision has no Arcane vault Home.md; no files were changed.')
    manifest_path = vault / MANIFEST
    if manifest_path.is_symlink():
        raise ValueError('Linked sync manifest refused.')
    previous = {}
    if manifest_path.exists():
        if manifest_path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('Oversized sync manifest.')
        stored = json.loads(manifest_path.read_text(encoding='utf-8'))
        if stored.get('schemaVersion') != 1 or not isinstance(stored.get('files'), dict):
            raise ValueError('Unrecognized sync manifest; preserve the existing vault.')
        previous = stored['files']
    conflicts, changed = [], []
    for relative, data in projected.items():
        target = safe_target(vault, relative)
        if target.exists():
            if not target.is_file() or target.stat().st_size > LIMIT:
                conflicts.append(relative)
                continue
            current = digest(target.read_bytes())
            if current == digest(data):
                continue
            if previous.get(relative) != current:
                conflicts.append(relative)
                continue
        changed.append(relative)
    stale = sorted(set(previous) - set(projected))
    result = {'tree': revision, 'files': len(projected), 'bytes': total, 'changes': len(changed),
              'conflicts': conflicts, 'preservedRemovedFiles': stale, 'applied': False}
    if conflicts:
        print(json.dumps(result, indent=2))
        raise SystemExit('Local notes differ. Review and merge them into docs/vault before retrying; nothing was written.')
    if args.apply:
        for relative in changed:
            atomic_write(safe_target(vault, relative), projected[relative])
        # Removed source notes stay on disk and retain their last known hash.
        # They are never deleted or mistaken for untouched personal notes later.
        hashes = {**{p: previous[p] for p in stale}, **{p: digest(data) for p, data in projected.items()}}
        atomic_write(manifest_path, (json.dumps({'schemaVersion': 1, 'tree': revision, 'files': hashes}, indent=2) + '\n').encode())
        result['applied'] = True
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
