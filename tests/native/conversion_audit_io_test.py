"""Controlled real-file custody/refusal tests; no Blender or subprocess runs."""
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
import importlib.util
import io
import json
import os
import runpy
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch


REPOSITORY = Path(__file__).resolve().parents[2]
SOURCE = REPOSITORY / "workers" / "blender" / "conversion_audit.py"
WORKER = REPOSITORY / "workers" / "blender" / "convert_glb.py"
SPEC = importlib.util.spec_from_file_location("arcane_conversion_audit_io", SOURCE)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def changed(info, **overrides):
    fields = ("st_mode", "st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_nlink", "st_file_attributes")
    values = {name: getattr(info, name, 0) for name in fields}
    return SimpleNamespace(**dict(values, **overrides))


class ConversionAuditIoTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="arcane-conversion-custody-")
        self.root = Path(self.temporary.name).resolve(strict=True)
        self.parent = self.root.parent
        self.path = self.root / "source.glb"
        self.payload = b"binary\x00\r\n\x1a\xff" + bytes(range(256)) * 257 + b"tail"
        self.path.write_bytes(self.payload)

    def tearDown(self):
        actual = Path(self.temporary.name).resolve(strict=True)
        self.assertEqual(actual, self.root)
        self.assertEqual(actual.parent, self.parent)
        self.assertTrue(actual.name.startswith("arcane-conversion-custody-"))
        self.temporary.cleanup()

    def refused(self, reason, operation):
        with self.assertRaises(audit.ConversionFailure) as caught:
            operation()
        self.assertEqual(caught.exception.reason, reason)
        self.assertEqual(str(caught.exception), reason)

    def test_real_binary_read_preserves_all_bytes_across_chunk_boundary(self):
        self.assertEqual(audit.read_owned(self.path, len(self.payload)), self.payload)
        self.assertEqual(self.path.read_bytes(), self.payload)
        self.assertGreater(len(self.payload), 64 * 1024)
        self.assertEqual(audit.no_links(self.root, directory=True).st_mode, self.root.stat().st_mode)

    def test_real_exclusive_write_then_read_preserves_binary_and_refuses_overwrite(self):
        target = self.root / "new.glb"
        audit.write_new(target, self.payload)
        self.assertEqual(audit.read_owned(target, len(self.payload)), self.payload)
        with self.assertRaises(FileExistsError):
            audit.write_new(target, b"replacement")
        self.assertEqual(target.read_bytes(), self.payload)

    def test_relative_path_refuses_before_any_lstat(self):
        with patch.object(Path, "lstat") as inspected:
            self.refused("IO_PATH", lambda: audit.no_links(Path("relative.glb")))
        inspected.assert_not_called()

    def test_file_cannot_be_used_as_directory(self):
        self.refused("IO_TYPE", lambda: audit.no_links(self.path, directory=True))

    def test_directory_cannot_be_used_as_file(self):
        self.refused("IO_TYPE", lambda: audit.no_links(self.root))

    def test_actual_hardlink_refuses_without_reading_or_changing_either_file(self):
        alias = self.root / "alias.glb"
        os.link(self.path, alias)
        self.assertGreater(self.path.stat().st_nlink, 1)
        with patch.object(audit.os, "open") as opened:
            self.refused("IO_LINK", lambda: audit.read_owned(self.path, len(self.payload)))
        opened.assert_not_called()
        self.assertEqual(alias.read_bytes(), self.payload)
        self.assertEqual(self.path.read_bytes(), self.payload)

    def test_symlink_mode_refuses_without_privileged_link_creation(self):
        original = Path.lstat

        def inspect(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            return changed(info, st_mode=stat.S_IFLNK | 0o777) if path == self.path else info

        with patch.object(Path, "lstat", inspect):
            self.refused("IO_LINK", lambda: audit.no_links(self.path))

    def test_ancestor_reparse_flag_refuses_even_for_an_ordinary_leaf(self):
        original = Path.lstat

        def inspect(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            return changed(info, st_file_attributes=0x400) if path == self.root else info

        with patch.object(Path, "lstat", inspect):
            self.refused("IO_LINK", lambda: audit.no_links(self.path))

    def test_empty_oversize_and_below_minimum_refuse_before_open(self):
        empty = self.root / "empty.glb"
        empty.write_bytes(b"")
        for path, maximum, minimum in [(empty, 1, 1), (self.path, len(self.payload) - 1, 1), (self.path, len(self.payload) + 1, len(self.payload) + 1)]:
            with self.subTest(kind="empty" if path == empty else "bounded"), patch.object(audit.os, "open") as opened:
                self.refused("IO_SIZE", lambda: audit.read_owned(path, maximum, minimum))
            opened.assert_not_called()

    def test_opened_handle_identity_mismatches_refuse_and_close_exact_handle(self):
        original_fstat, original_close = os.fstat, os.close
        for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_nlink"):
            with self.subTest(field=field):
                def inspect(handle):
                    info = original_fstat(handle)
                    return changed(info, **{field: getattr(info, field) + 1})

                with patch.object(audit.os, "fstat", inspect), patch.object(audit.os, "close", wraps=original_close) as closed:
                    self.refused("IO_IDENTITY", lambda: audit.read_owned(self.path, len(self.payload)))
                closed.assert_called_once()
        self.assertEqual(self.path.read_bytes(), self.payload)

    def test_opened_nonregular_handle_refuses_as_type_not_identity(self):
        original_fstat, original_close = os.fstat, os.close

        def inspect(handle):
            return changed(original_fstat(handle), st_mode=stat.S_IFDIR | 0o700)

        with patch.object(audit.os, "fstat", inspect), patch.object(audit.os, "close", wraps=original_close) as closed:
            self.refused("IO_TYPE", lambda: audit.read_owned(self.path, len(self.payload)))
        closed.assert_called_once()

    def test_premature_eof_refuses_and_closes(self):
        original_close = os.close
        with patch.object(audit.os, "read", side_effect=[b"prefix", b""]), patch.object(audit.os, "close", wraps=original_close) as closed:
            self.refused("IO_READ", lambda: audit.read_owned(self.path, len(self.payload)))
        closed.assert_called_once()

    def test_trailing_bytes_refuse_before_postread_metadata(self):
        original_fstat, original_close = os.fstat, os.close
        with patch.object(audit.os, "read", side_effect=[self.payload[:65536], self.payload[65536:], b"!"]), patch.object(audit.os, "fstat", wraps=original_fstat) as inspected, patch.object(audit.os, "close", wraps=original_close) as closed:
            self.refused("IO_READ", lambda: audit.read_owned(self.path, len(self.payload)))
        self.assertEqual(inspected.call_count, 1)
        closed.assert_called_once()

    def test_postread_handle_metadata_change_is_distinct_from_open_identity(self):
        original_fstat, original_close = os.fstat, os.close
        calls = 0

        def inspect(handle):
            nonlocal calls
            calls += 1
            info = original_fstat(handle)
            return changed(info, st_ctime_ns=info.st_ctime_ns + 1) if calls == 2 else info

        with patch.object(audit.os, "fstat", inspect), patch.object(audit.os, "close", wraps=original_close) as closed:
            self.refused("IO_CHANGED", lambda: audit.read_owned(self.path, len(self.payload)))
        self.assertEqual(calls, 2)
        closed.assert_called_once()

    def test_postread_named_identity_change_is_refused(self):
        original, original_close = audit.no_links, os.close
        calls = 0

        def inspect(path, directory=False):
            nonlocal calls
            info = original(path, directory=directory)
            calls += 1
            return changed(info, st_ino=info.st_ino + 1) if calls == 2 else info

        with patch.object(audit, "no_links", inspect), patch.object(audit.os, "close", wraps=original_close) as closed:
            self.refused("IO_CHANGED", lambda: audit.read_owned(self.path, len(self.payload)))
        self.assertEqual(calls, 2)
        closed.assert_called_once()

    def test_missing_file_remains_oserror_in_helper(self):
        with self.assertRaises(FileNotFoundError):
            audit.read_owned(self.root / "absent.glb", 1024)

    def test_permission_failure_remains_oserror_in_helper(self):
        with patch.object(audit.os, "open", side_effect=PermissionError("private fixture detail")):
            with self.assertRaises(PermissionError):
                audit.read_owned(self.path, len(self.payload))

    def test_existing_export_refuses_before_native_access_or_overwrite(self):
        target = self.root / "asset.glb"
        target.write_bytes(self.payload)
        with patch.dict(sys.modules, {"conversion_audit": audit, "bpy": None}), patch.object(sys, "path", list(sys.path)), patch.object(sys, "dont_write_bytecode", True):
            worker = runpy.run_path(str(WORKER), run_name="arcane_conversion_worker_io_fixture")
            self.refused("IO_EXISTS", lambda: worker["export_model"](None, self.root, "asset.glb", [], "EXPORT"))
        self.assertEqual(target.read_bytes(), self.payload)

    def worker_access_refusal(self, permission=False):
        output, errors = io.StringIO(), io.StringIO()
        argv = [str(WORKER), "--", "--directory", str(self.root / "absent-directory"), "--request-sha256", "a" * 64]
        # Exercise the actual worker's fixed top-level exception projection. It
        # fails at the first directory admission, before any bpy import or job
        # worker invocation; no runner, native result or authority is fabricated.
        with patch.dict(sys.modules, {"conversion_audit": audit, "bpy": None}), patch.object(sys, "argv", argv), patch.object(sys, "path", list(sys.path)), patch.object(sys, "dont_write_bytecode", True), redirect_stdout(output), redirect_stderr(errors):
            if permission:
                with patch.object(audit, "no_links", side_effect=PermissionError("private fixture detail")):
                    with self.assertRaises(SystemExit) as stopped:
                        runpy.run_path(str(WORKER), run_name="__main__")
            else:
                with self.assertRaises(SystemExit) as stopped:
                    runpy.run_path(str(WORKER), run_name="__main__")
        self.assertEqual(stopped.exception.code, 1)
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("ARCANE_FAILURE "))
        self.assertEqual(json.loads(lines[0][len("ARCANE_FAILURE "):]), {"stage": "input", "reason": "IO_ACCESS", "type": "conversion-refused"})
        self.assertEqual(errors.getvalue(), "")
        self.assertNotIn("private fixture detail", output.getvalue())
        self.assertNotIn(str(self.root), output.getvalue())

    def test_actual_worker_classifies_missing_path_as_fixed_access_reason(self):
        self.worker_access_refusal()

    def test_actual_worker_classifies_permission_error_without_path_or_message(self):
        self.worker_access_refusal(permission=True)


if __name__ == "__main__":
    unittest.main()
