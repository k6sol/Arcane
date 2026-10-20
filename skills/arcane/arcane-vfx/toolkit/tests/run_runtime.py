"""Run the real runtime against focused engine fakes using a supplied Luau VM."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--luau", default=os.environ.get("LUAU_EXECUTABLE") or shutil.which("luau"))
args = parser.parse_args()
if not args.luau:
    parser.error("Pass --luau PATH to an installed Luau VM; this runner never downloads one.")
runtime = (root / "skills/arcane-vfx/assets/Runtime.luau").read_text(encoding="utf8")
test = (root / "tests/runtime.test.luau").read_text(encoding="utf8")
marker = "local Runtime = nil :: any -- RUNTIME_UNDER_TEST"
if test.count(marker) != 1:
    raise RuntimeError("Runtime test wrapper marker changed")
owner = root / ".test-output"
owner.mkdir(exist_ok=True)
directory = Path(tempfile.mkdtemp(prefix="runtime-", dir=owner)).resolve()
if directory.parent != owner.resolve():
    raise RuntimeError("Runtime test output escaped its owner")
bundle = directory / "runtime.test.bundle.luau"
bundle.write_text(test.replace(marker, "local Runtime = (function()\n" + runtime + "\nend)()"), encoding="utf8", newline="\n")
print("Runtime source SHA256 " + hashlib.sha256(runtime.encode()).hexdigest(), flush=True)
print("Retained test bundle: " + str(bundle), flush=True)
try:
    result = subprocess.run([args.luau, "-O0", str(bundle)], cwd=root, timeout=10, check=False)
except (OSError, subprocess.TimeoutExpired) as error:
    print("Runtime fixture failed: " + str(error), file=sys.stderr)
    sys.exit(1)
sys.exit(result.returncode)
