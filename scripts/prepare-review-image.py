"""Copy a bounded review PNG without text/EXIF metadata, retaining exact pixel chunks."""
import argparse
import hashlib
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.input.suffix.lower() != '.png' or args.output.suffix.lower() != '.png':
        raise ValueError('Use PNG input and output paths.')
    with args.input.open('rb') as source:
        data = source.read(4 * 1024 * 1024 + 1)
    spec = importlib.util.spec_from_file_location('arcane_vault_images', Path(__file__).with_name('sync-obsidian-vault.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    prepared = module.prepare_review_png(data)
    # Never replace the source or any existing destination.
    with args.output.open('xb') as target:
        target.write(prepared)
    print('Prepared review PNG SHA-256: ' + hashlib.sha256(prepared).hexdigest())


if __name__ == '__main__':
    main()
