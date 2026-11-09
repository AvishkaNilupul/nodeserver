#!/usr/bin/env python3
"""Build the small Android screen reader with the installed JDK and SDK build tools."""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile


def build(destination, sdk):
    compilers = sorted((sdk / 'build-tools').glob('*/d8'))
    if not compilers or not shutil.which('javac'):
        raise SystemExit('Install a JDK and Android SDK build tools before building the screen reader.')
    source = Path(__file__).with_name('UiSnapshot.java')
    with tempfile.TemporaryDirectory(prefix='tiktok-ui-build-') as directory:
        root = Path(directory)
        subprocess.run(['javac', '--release', '8', '-d', str(root), str(source)], check=True)
        subprocess.run([str(compilers[-1]), '--min-api', '26', '--output', str(root),
                        str(root / 'UiSnapshot.class')], check=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix('.new')
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(root / 'classes.dex', 'classes.dex')
        temporary.chmod(0o600)
        temporary.replace(destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sdk', type=Path, default=Path.home() / 'Library/Android/sdk')
    options = parser.parse_args()
    build(options.output, options.sdk)
