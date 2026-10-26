"""Install the checksum-pinned official runtime for isolated hosted tests only.

No executable is launched here. Archive aliases are materialized as ordinary
files after bounded internal-target validation; no archive link is extracted.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import re
import stat
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile

VERSION = "5.2.3"
PINS = {
    "linux": ("blender-5.2.3-linux-x64.tar.xz", 385331224,
              "78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec", "blender"),
    "win32": ("blender-5.2.3-windows-x64.zip", 405839452,
              "723f08a4401502561eb763cdeacf8745b31e5f3f154d287d3830d97cf75dc2fb", "blender.exe"),
}
MAX_MEMBERS = 100000
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def no_links(path, directory=False):
    path = Path(path)
    require(path.is_absolute(), "absolute path required")
    for at in [path, *path.parents]:
        info = at.lstat()
        require(not stat.S_ISLNK(info.st_mode) and not getattr(info, "st_file_attributes", 0) & 0x400,
                "linked path refused")
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
            "ordinary owned path required")
    return info


def member_name(name, root):
    require(type(name) is str and 0 < len(name) <= 1024 and "\\" not in name and
            not re.search(r'[\x00-\x1f\x7f<>:"|?*]', name), "invalid archive path")
    value = name.rstrip("/")
    parts = value.split("/")
    require(parts[0] == root and all(part and part not in (".", "..") and not part.endswith((".", " ")) and
            not re.match(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", part, re.I) for part in parts),
            "archive member outside fixed root")
    return value


def inventory(rows, root):
    require(0 < len(rows) <= MAX_MEMBERS, "archive member count exceeded")
    found, folded = {}, set()
    for row in rows:
        name = member_name(row["name"], root)
        require(name.casefold() not in folded and row["kind"] in ("file", "directory", "symlink", "hardlink"),
                "duplicate or unsupported archive member")
        require(type(row["size"]) is int and 0 <= row["size"] <= MAX_MEMBER_BYTES, "archive member size exceeded")
        found[name] = dict(row, name=name)
        folded.add(name.casefold())

    def resolve(name, chain=()):
        require(name in found and name not in chain and len(chain) < 16, "invalid archive alias")
        row = found[name]
        if row["kind"] == "file":
            return row
        require(row["kind"] in ("symlink", "hardlink"), "archive alias must target a file")
        target = row["target"]
        require(type(target) is str and len(target) <= 1024 and "\\" not in target and
                not PurePosixPath(target).is_absolute() and not re.search(r'[\x00-\x1f\x7f<>:"|?*]', target),
                "external archive alias refused")
        joined = posixpath.normpath(posixpath.join(posixpath.dirname(name), target) if row["kind"] == "symlink" else target)
        member_name(joined, root)
        return resolve(joined, (*chain, name))

    files, total = [], 0
    for row in found.values():
        parent = posixpath.dirname(row["name"])
        while parent:
            if parent in found:
                require(found[parent]["kind"] == "directory", "archive file used as ancestor")
            parent = posixpath.dirname(parent)
        if row["kind"] == "directory":
            require(row["size"] == 0, "directory contains data")
            continue
        actual = resolve(row["name"])
        total += actual["size"]
        require(total <= MAX_TOTAL_BYTES, "archive expanded byte limit exceeded")
        files.append((row["name"], actual))
    require(files, "empty runtime archive")
    return files


def extract_archive(source, destination, root, kind):
    destination = Path(destination)
    no_links(destination, directory=True)
    require(not any(destination.iterdir()), "extraction directory must be empty")
    archive = zipfile.ZipFile(source) if kind == "zip" else tarfile.open(source, "r:xz")
    with archive:
        rows = []
        for item in archive.infolist() if kind == "zip" else archive:
            require(len(rows) < MAX_MEMBERS, "archive member count exceeded")
            if kind == "zip":
                mode = item.external_attr >> 16
                require(not stat.S_ISLNK(mode) and not (item.external_attr & 0x400), "ZIP links refused")
                require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), "ZIP special files refused")
                require(not item.flag_bits & 1, "encrypted archive refused")
                row = {"name": item.filename, "kind": "directory" if item.is_dir() else "file",
                       "size": item.file_size, "mode": mode, "item": item}
            else:
                typ = "file" if item.isfile() else "directory" if item.isdir() else "symlink" if item.issym() else "hardlink" if item.islnk() else "unsupported"
                row = {"name": item.name, "kind": typ, "size": item.size, "target": item.linkname, "mode": item.mode, "item": item}
            rows.append(row)
        files = inventory(rows, root)
        for row in rows:
            if row["kind"] == "directory":
                directory = destination.joinpath(*member_name(row["name"], root).split("/"))
                directory.mkdir(parents=True, exist_ok=True)
                no_links(directory, directory=True)
        total = 0
        for name, row in files:
            path = destination.joinpath(*name.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            no_links(path.parent, directory=True)
            reader = archive.open(row["item"]) if kind == "zip" else archive.extractfile(row["item"])
            require(reader is not None, "archive file cannot be read")
            count = 0
            with reader, path.open("xb") as output:
                while True:
                    chunk = reader.read(64 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    require(count <= row["size"], "archive file grew during extraction")
                    output.write(chunk)
            require(count == row["size"], "archive file length changed")
            path.chmod(0o755 if row["mode"] & 0o111 else 0o644)
            no_links(path)
            total += count
    return {"files": len(files), "bytes": total}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("runtime download redirect refused")


def download(path, name, expected_bytes, expected_sha):
    url = "https://download.blender.org/release/Blender5.2/" + name
    started = time.monotonic()
    request = urllib.request.Request(url, headers={"User-Agent": "Arcane-native-verification/1", "Accept-Encoding": "identity"})
    digest, count = hashlib.sha256(), 0
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(request, timeout=20) as response, Path(path).open("xb") as output:
        require(response.status == 200 and response.geturl() == url and response.headers.get("Content-Encoding", "identity") == "identity",
                "unexpected runtime response")
        declared = response.headers.get("Content-Length")
        require(declared is None or declared == str(expected_bytes), "runtime response length mismatch")
        while True:
            require(time.monotonic() - started <= 180, "runtime download deadline exceeded")
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            count += len(chunk)
            require(count <= expected_bytes, "runtime download byte limit exceeded")
            output.write(chunk)
            digest.update(chunk)
    require(count == expected_bytes and digest.hexdigest() == expected_sha, "runtime archive integrity mismatch")
    no_links(Path(path))
    return {"url": url, "bytes": count, "sha256": digest.hexdigest()}


def append_environment(filename, values):
    path = Path(filename)
    no_links(path)
    require(all(not re.search(r"[\r\n]", value) for value in values.values()), "invalid environment value")
    flags = os.O_WRONLY | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags)
    try:
        opened, named = os.fstat(descriptor), no_links(path)
        require(opened.st_ino == named.st_ino and opened.st_dev == named.st_dev and opened.st_nlink == 1, "environment file identity changed")
        raw = "".join(name + "=" + value + "\n" for name, value in values.items()).encode("utf-8")
        require(os.write(descriptor, raw) == len(raw), "environment append incomplete")
    finally:
        os.close(descriptor)


def main():
    require(sys.argv[1:] == ["--github-env"] and os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("CI") == "true",
            "runtime installer requires its isolated hosted verification job")
    require(sys.platform in PINS and platform.machine().lower() in ("x86_64", "amd64"), "unsupported native test platform")
    temp = Path(os.environ["RUNNER_TEMP"])
    no_links(temp, directory=True)
    owned = Path(tempfile.mkdtemp(prefix="arcane-blender-verification-", dir=temp))
    no_links(owned, directory=True)
    name, size, checksum, executable_name = PINS[sys.platform]
    archive = owned / name
    archive_evidence = download(archive, name, size, checksum)
    extracted = owned / "runtime"
    extracted.mkdir()
    root = "blender-5.2.3-windows-x64" if sys.platform == "win32" else "blender-5.2.3-linux-x64"
    expanded = extract_archive(archive, extracted, root, "zip" if sys.platform == "win32" else "tar")
    executable = extracted / root / executable_name
    info = no_links(executable)
    require(0 < info.st_size <= MAX_MEMBER_BYTES, "runtime executable size invalid")
    digest = hashlib.sha256()
    with executable.open("rb") as stream:
        for chunk in iter(lambda: stream.read(64 * 1024), b""):
            digest.update(chunk)
    receipt = {"schemaVersion": 1, "kind": "arcane-blender-test-runtime", "version": VERSION,
               "platform": sys.platform, "archive": archive_evidence, "extracted": expanded,
               "executableBytes": info.st_size, "executableSha256": digest.hexdigest(), "executableRun": False}
    receipt_path = owned / "runtime-evidence.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    append_environment(os.environ["GITHUB_ENV"], {"ARCANE_TEST_BLENDER_EXECUTABLE": str(executable),
        "ARCANE_TEST_BLENDER_VERSION": VERSION, "ARCANE_TEST_BLENDER_RUNTIME_RECEIPT": str(receipt_path)})
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
