"""Real committed-tree projection checks; no customer vault or settings changes."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/sync-obsidian-vault.py'
spec = importlib.util.spec_from_file_location('arcane_vault_projection', SCRIPT)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def png(pixel=b'\x30\x60\x20\xff', width=1, height=1, compressed=None):
    header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    image = zlib.compress(b'\0' + pixel) if compressed is None else compressed
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', image) + chunk(b'IEND', b'')


class ReviewImages(unittest.TestCase):
    def test_text_and_bounded_real_png_are_accepted_without_rewriting(self):
        image = png()
        self.assertIsNone(sync.validate_content('Home.md', b'# Arcane\n'))
        self.assertIsNone(sync.validate_content('Assets/Reviews/Oak.png', image))
        self.assertEqual(image, png())

    def test_other_binary_destinations_and_disguised_review_files_are_refused(self):
        for name, data in [('Skill Library/asset.png', png()), ('Assets/Reviews/tree.blend', b'BLENDER\0'),
                           ('Assets/Reviews/vector.svg', b'<svg>\0'), ('Assets/Reviews/Oak.png', b'plain text')]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                sync.validate_content(name, data)

    def test_bad_crc_truncation_trailing_data_and_unknown_critical_chunks_are_refused(self):
        raw = png()
        faults = [raw[:-1], raw + b'extra', raw[:29] + bytes([raw[29] ^ 1]) + raw[30:],
                  raw[:-12] + chunk(b'FAIL', b'') + raw[-12:], raw[:33] + raw[:33][8:] + raw[33:]]
        for data in faults:
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                sync.validate_content('Assets/Reviews/Oak.png', data)

    def test_encoding_dimensions_and_pixel_expansion_are_bounded(self):
        for data in [png(width=2049), png(height=0), png(compressed=zlib.compress(b'\0' * 100000)),
                     png(compressed=zlib.compress(b'\0' * 5) + b'trailing'), png(compressed=b'broken'),
                     png(compressed=zlib.compress(b'\5' + b'\0' * 4))]:
            with self.subTest(length=len(data)), self.assertRaises((ValueError, zlib.error)):
                sync.validate_content('Assets/Reviews/Oak.png', data)

    def test_metadata_is_refused_and_explicit_preparation_preserves_pixel_chunks(self):
        clean = png()
        for kind in (b'tEXt', b'zTXt', b'iTXt', b'eXIf'):
            raw = clean[:-12] + chunk(kind, b'File\0private source location') + clean[-12:]
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(ValueError, 'metadata'):
                    sync.validate_content('Assets/Reviews/Oak.png', raw)
                self.assertEqual(sync.prepare_review_png(raw), clean)
        self.assertEqual(sync.prepare_review_png(clean), clean)
        with self.assertRaises(ValueError):
            sync.prepare_review_png(b'\0' * (4 * 1024 * 1024 + 1))

    def test_real_git_projection_preserves_exact_images_and_refuses_conflicts_before_any_write(self):
        with tempfile.TemporaryDirectory(prefix='arcane-vault-png-', dir=Path.cwd()) as temporary:
            base = Path(temporary).resolve()
            repo, vault = base / 'repo', base / 'vault'
            repo.mkdir(); vault.mkdir(); (vault / '.obsidian').mkdir()
            settings = vault / '.obsidian/appearance.json'; settings.write_bytes(b'{"personal":true}\n')
            personal = vault / 'Personal.md'; personal.write_bytes(b'Keep my notes\n')
            subprocess.run(['git', 'init', '--quiet', '--template=', str(repo)], check=True, capture_output=True)
            notes = repo / 'docs/vault'; (notes / 'Assets/Reviews').mkdir(parents=True)
            (notes / 'Home.md').write_bytes(b'# Arcane\n')
            image_path = notes / 'Assets/Reviews/Oak.png'; image_path.write_bytes(png())

            def tree():
                subprocess.run(['git', '-c', 'core.autocrlf=false', 'add', '--', 'docs/vault'], cwd=repo, check=True, capture_output=True)
                return subprocess.check_output(['git', 'write-tree'], cwd=repo).decode().strip()

            def project(revision, apply=False):
                args = ['sync', '--vault', str(vault), '--revision', revision] + (['--apply'] if apply else [])
                with patch.object(sync, 'ROOT', repo), patch.object(sys, 'argv', args), contextlib.redirect_stdout(io.StringIO()) as output:
                    sync.main()
                return json.loads(output.getvalue())

            revision = tree()
            checked = project(revision)
            self.assertEqual(checked['conflicts'], [])
            self.assertFalse((vault / 'Home.md').exists())
            self.assertTrue(project(revision, True)['applied'])
            projected = vault / 'Assets/Reviews/Oak.png'
            self.assertEqual(projected.read_bytes(), png())
            updated = png(b'\x20\x90\x40\xff')
            image_path.write_bytes(updated)
            self.assertTrue(project(tree(), True)['applied'])
            self.assertEqual(projected.read_bytes(), updated)
            original_home = (vault / 'Home.md').read_bytes()
            original_manifest = (vault / sync.MANIFEST).read_bytes()
            local = png(b'\xff\x30\x10\xff'); projected.write_bytes(local)
            image_path.write_bytes(png(b'\x10\x20\xff\xff'))
            (notes / 'Home.md').write_bytes(b'# New home\n')
            (notes / 'New.md').write_bytes(b'New shared note\n')
            with self.assertRaises(SystemExit):
                project(tree(), True)
            self.assertEqual(projected.read_bytes(), local)
            self.assertEqual((vault / 'Home.md').read_bytes(), original_home)

            self.assertEqual((vault / sync.MANIFEST).read_bytes(), original_manifest)
            self.assertFalse((vault / 'New.md').exists())
            self.assertEqual(settings.read_bytes(), b'{"personal":true}\n')
            self.assertEqual(personal.read_bytes(), b'Keep my notes\n')
            # A corrupt committed PNG fails before the first vault write as well.
            image_path.write_bytes(b'not a PNG')
            with self.assertRaises(ValueError):
                project(tree(), True)
            self.assertEqual((vault / 'Home.md').read_bytes(), original_home)
            image_path.write_bytes(png()[:-12] + chunk(b'tEXt', b'File\0private source location') + png()[-12:])
            with self.assertRaisesRegex(ValueError, 'metadata'):
                project(tree(), True)
            self.assertEqual((vault / 'Home.md').read_bytes(), original_home)
            self.assertEqual((vault / sync.MANIFEST).read_bytes(), original_manifest)

    def test_preparation_cli_preserves_the_original_and_never_overwrites_a_destination(self):
        with tempfile.TemporaryDirectory(prefix='arcane-review-cli-', dir=Path.cwd()) as temporary:
            folder = Path(temporary)
            source, target = folder / 'raw render.png', folder / 'prepared.png'
            clean = png()
            raw = clean[:-12] + chunk(b'tEXt', b'File\0private source location') + clean[-12:]
            source.write_bytes(raw)
            command = [sys.executable, str(SCRIPT.with_name('prepare-review-image.py')),
                       '--input', str(source), '--output', str(target)]
            result = subprocess.run(command, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.read_bytes(), clean)
            self.assertEqual(source.read_bytes(), raw)
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(target.read_bytes(), clean)
            self.assertEqual(source.read_bytes(), raw)



if __name__ == '__main__':
    unittest.main()
