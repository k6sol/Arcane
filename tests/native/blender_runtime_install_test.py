"""Real tiny-archive and stream refusal tests; no Blender/network execution."""
from pathlib import Path
import hashlib
import importlib.util
import io
import os
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SOURCE = Path(__file__).resolve().parents[2] / "scripts" / "blender-test-runtime.py"
SPEC = importlib.util.spec_from_file_location("arcane_blender_test_runtime", SOURCE)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class RuntimeArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="arcane-runtime-install-test-")
        self.root = Path(self.temp.name).resolve(strict=True)
        self.parent = self.root.parent

    def tearDown(self):
        actual = Path(self.temp.name).resolve(strict=True)
        self.assertEqual(actual, self.root)
        self.assertEqual(actual.parent, self.parent)
        self.assertTrue(actual.name.startswith("arcane-runtime-install-test-"))
        self.temp.cleanup()

    def output(self):
        result = self.root / "output"
        result.mkdir()
        return result

    def test_real_zip_materializes_only_ordinary_files_and_empty_directories(self):
        archive, output = self.root / "runtime.zip", self.output()
        with zipfile.ZipFile(archive, "w") as writer:
            writer.writestr("runtime/empty/", b"")
            writer.writestr("runtime/bin/tool", b"actual fixture bytes")
        result = runtime.extract_archive(archive, output, "runtime", "zip")
        self.assertEqual((output / "runtime/bin/tool").read_bytes(), b"actual fixture bytes")
        self.assertTrue((output / "runtime/empty").is_dir())
        self.assertFalse((output / "runtime/bin/tool").is_symlink())
        self.assertEqual(result, {"files": 1, "bytes": 20})

    def test_real_tar_internal_aliases_become_ordinary_copies(self):
        archive, output = self.root / "runtime.tar.xz", self.output()
        with tarfile.open(archive, "w:xz") as writer:
            regular = tarfile.TarInfo("runtime/lib/value.so.1")
            regular.size, regular.mode = 4, 0o755
            writer.addfile(regular, io.BytesIO(b"data"))
            link = tarfile.TarInfo("runtime/lib/value.so")
            link.type, link.linkname = tarfile.SYMTYPE, "value.so.1"
            writer.addfile(link)
            hard = tarfile.TarInfo("runtime/value-copy")
            hard.type, hard.linkname = tarfile.LNKTYPE, "runtime/lib/value.so.1"
            writer.addfile(hard)
        result = runtime.extract_archive(archive, output, "runtime", "tar")
        self.assertEqual(result, {"files": 3, "bytes": 12})
        for name in ["runtime/lib/value.so.1", "runtime/lib/value.so", "runtime/value-copy"]:
            file = output / name
            self.assertEqual(file.read_bytes(), b"data")
            self.assertFalse(file.is_symlink())
            self.assertEqual(file.stat().st_nlink, 1)

    def test_real_zip_traversal_is_rejected_before_any_file_is_written(self):
        archive, output = self.root / "runtime.zip", self.output()
        with zipfile.ZipFile(archive, "w") as writer:
            writer.writestr("runtime/good", b"good")
            writer.writestr("runtime/../../escape", b"bad")
        with self.assertRaises(ValueError):
            runtime.extract_archive(archive, output, "runtime", "zip")
        self.assertEqual(list(output.iterdir()), [])
        self.assertFalse((self.parent / "escape").exists())

    def test_real_zip_link_is_rejected_before_extraction(self):
        archive, output = self.root / "runtime.zip", self.output()
        with zipfile.ZipFile(archive, "w") as writer:
            item = zipfile.ZipInfo("runtime/link")
            item.create_system = 3
            item.external_attr = (stat.S_IFLNK | 0o777) << 16
            writer.writestr(item, b"../../outside")
        with self.assertRaises(ValueError):
            runtime.extract_archive(archive, output, "runtime", "zip")
        self.assertEqual(list(output.iterdir()), [])

    def test_path_and_case_collisions_are_rejected(self):
        for name in ["/runtime/x", "runtime/../x", "runtime//x", "runtime/x\\y", "other/x", "runtime/NUL", "runtime/x.", "runtime/x:y"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                runtime.member_name(name, "runtime")
        rows = [{"name": "runtime/A", "kind": "file", "size": 1}, {"name": "runtime/a", "kind": "file", "size": 1}]
        with self.assertRaises(ValueError):
            runtime.inventory(rows, "runtime")

    def test_external_cyclic_and_directory_aliases_are_rejected(self):
        cases = [
            [{"name": "runtime/a", "kind": "symlink", "target": "../../outside", "size": 0}],
            [{"name": "runtime/a", "kind": "symlink", "target": "/outside", "size": 0}],
            [{"name": "runtime/a", "kind": "symlink", "target": "b", "size": 0}, {"name": "runtime/b", "kind": "symlink", "target": "a", "size": 0}],
            [{"name": "runtime/a", "kind": "symlink", "target": "dir", "size": 0}, {"name": "runtime/dir", "kind": "directory", "size": 0}],
            [{"name": "runtime/a", "kind": "file", "size": 1}, {"name": "runtime/a/child", "kind": "file", "size": 1}],
        ]
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                runtime.inventory(rows, "runtime")

    def test_alias_copies_count_toward_the_expanded_budget(self):
        rows = [{"name": "runtime/a", "kind": "file", "size": 4}, {"name": "runtime/b", "kind": "symlink", "target": "a", "size": 0}]
        with patch.object(runtime, "MAX_TOTAL_BYTES", 7), self.assertRaises(ValueError):
            runtime.inventory(rows, "runtime")

    def test_fixed_members_are_size_and_count_bounded(self):
        with patch.object(runtime, "MAX_MEMBER_BYTES", 2), self.assertRaises(ValueError):
            runtime.inventory([{"name": "runtime/a", "kind": "file", "size": 3}], "runtime")
        with patch.object(runtime, "MAX_MEMBERS", 1), self.assertRaises(ValueError):
            runtime.inventory([{"name": "runtime/a", "kind": "file", "size": 1}, {"name": "runtime/b", "kind": "file", "size": 1}], "runtime")

    def test_nonempty_output_is_never_overwritten(self):
        output = self.output()
        (output / "keep").write_bytes(b"kept")
        with self.assertRaises(ValueError):
            runtime.extract_archive(self.root / "missing.zip", output, "runtime", "zip")
        self.assertEqual((output / "keep").read_bytes(), b"kept")

    def test_redirects_are_rejected(self):
        with self.assertRaises(ValueError):
            runtime.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://example.invalid/runtime.zip")

    def test_stream_hash_and_byte_limits_are_checked_before_archive_use(self):
        class Response(io.BytesIO):
            status = 200
            headers = {"Content-Length": "4"}
            def geturl(self):
                return "https://download.blender.org/release/Blender5.2/fixture.zip"
        class Opener:
            def open(self, request, timeout):
                return Response(b"data")
        with patch.object(runtime.urllib.request, "build_opener", return_value=Opener()):
            evidence = runtime.download(self.root / "good.zip", "fixture.zip", 4, hashlib.sha256(b"data").hexdigest())
            self.assertEqual(evidence["bytes"], 4)
            with self.assertRaises(ValueError):
                runtime.download(self.root / "wrong-hash.zip", "fixture.zip", 4, "0" * 64)
            with self.assertRaises(ValueError):
                runtime.download(self.root / "wrong-size.zip", "fixture.zip", 3, hashlib.sha256(b"data").hexdigest())

    def test_environment_append_writes_fixed_lines_and_refuses_newlines(self):
        target = self.root / "github-env"
        target.write_bytes(b"")
        runtime.append_environment(target, {"ARCANE_TEST_BLENDER_VERSION": "5.2.3"})
        self.assertEqual(target.read_bytes(), b"ARCANE_TEST_BLENDER_VERSION=5.2.3\n")
        with self.assertRaises(ValueError):
            runtime.append_environment(target, {"ARCANE_TEST_BLENDER_VERSION": "5.2.3\nINJECTED=value"})

    def test_main_refuses_non_hosted_execution_before_creating_a_runtime(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false", "CI": "false"}), patch.object(runtime.sys, "argv", ["script", "--github-env"]), self.assertRaises(ValueError):
            runtime.main()


if __name__ == "__main__":
    unittest.main()
