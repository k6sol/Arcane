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
import struct
import tempfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = '.arcane-sync.json'
LIMIT = 64 * 1024 * 1024


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, timeout=60)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_content(relative, data):
    """Permit bounded PNG review images; preserve the text-only skill boundary."""
    if relative.startswith('Assets/Reviews/') and relative.endswith('.png'):
        if not data.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('Invalid review PNG: ' + relative)
        offset, header, image, ended, compressed = 8, False, False, False, []
        while offset < len(data):
            if ended or offset + 12 > len(data):
                raise ValueError('Incomplete or trailing review PNG data: ' + relative)
            size = struct.unpack_from('>I', data, offset)[0]
            kind = data[offset + 4:offset + 8]
            end = offset + 12 + size
            if not all(65 <= c <= 90 or 97 <= c <= 122 for c in kind) or kind[2] & 32 or end > len(data) or zlib.crc32(data[offset + 4:end - 4]) != struct.unpack_from('>I', data, end - 4)[0]:
                raise ValueError('Invalid review PNG chunk: ' + relative)
            if not header:
                if kind != b'IHDR' or size != 13:
                    raise ValueError('Missing review PNG header: ' + relative)
                width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', data[offset + 8:end - 4])
                if not (1 <= width <= 2048 and 1 <= height <= 2048 and depth == 8 and color in (2, 6) and compression == filtering == interlace == 0):
                    raise ValueError('Unsupported review PNG dimensions or encoding: ' + relative)
                header = True
            elif kind == b'IHDR':
                raise ValueError('Duplicate review PNG header: ' + relative)
            elif kind == b'IDAT':
                image = True
                compressed.append(data[offset + 8:end - 4])
            elif kind == b'IEND':
                if size or not image:
                    raise ValueError('Incomplete review PNG image: ' + relative)
                ended = True
            elif not kind or kind[0] & 32 == 0 and kind != b'PLTE':
                raise ValueError('Unsupported critical review PNG chunk: ' + relative)
            offset = end
        if not ended:
            raise ValueError('Missing review PNG end: ' + relative)
        row_bytes = width * (4 if color == 6 else 3) + 1
        expected = row_bytes * height
        decoder = zlib.decompressobj()
        pixels = decoder.decompress(b''.join(compressed), expected + 1)
        if len(pixels) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or any(pixels[i] > 4 for i in range(0, expected, row_bytes)):
            raise ValueError('Invalid or oversized review PNG pixels: ' + relative)
    elif b'\0' in data:
        raise ValueError('Binary content is outside the knowledge projection: ' + relative)


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
        validate_content(relative, data)
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
