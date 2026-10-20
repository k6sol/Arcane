"""Shared import rule for the Python worker tests: the repository layout of a staged job.

A job copies every workers/blender module flat beside asset_worker.py: the top-level files, each
module of a subpackage directory (uv/, grammar/, materials/, ...) and a package directory holding
an __init__.py (variation/) as <directory>.py. Here the same names resolve by putting
workers/blender and every non-package subdirectory on sys.path, so a new worker subpackage needs
no test edit. ``MODULES`` is the flat job module set, for import allowlists.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "workers" / "blender"
SUBDIRECTORIES = sorted(d for d in WORKER.iterdir() if d.is_dir() and not d.name.startswith((".", "_")))
MODULES = frozenset({p.stem for p in WORKER.glob("*.py")}
                    | {d.name if (d / "__init__.py").exists() else p.stem for d in SUBDIRECTORIES for p in d.glob("*.py")})


def install():
    for path in [WORKER, *(d for d in SUBDIRECTORIES if not (d / "__init__.py").exists())]:
        if str(path) not in sys.path:
            sys.path.append(str(path))


install()
