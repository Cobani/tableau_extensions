#!/usr/bin/env python3
"""Cache-busting for GitHub Pages (whole tableau_extensions repo).

Adds ?v=<content hash> to every local .js/.css reference in each extension's
HTML pages (<slug>/*.html: src, href and boot.js's data-lib / data-mock), including
the shared files in shared/ ("../shared/..."), and writes the .trex extension-version
into boot.js's data-ext-version (shown in the error details),
so a browser or CDN can never mix an old file with a new page after a deploy.
The hash only changes when that file's content changes.

Run before every commit/push:   python3 stamp-versions.py            (all extensions)
                                python3 stamp-versions.py bar-chart  (just one)
Running it twice is safe; it only updates hashes that are out of date.
Exit code 1 if a referenced file is missing.
"""
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SKIP = {'shared', '.git'}
REF = re.compile(r'((?:src|href|data-lib|data-mock)=")(\.{1,2}/[^"?#]+\.(?:js|css))(?:\?v=[0-9a-f]*)?(")')

EXT_VERSION = re.compile(r'(data-ext-version=")[^"]*(")')
TREX_VERSION = re.compile(r'extension-version="([^"]+)"')


def extension_dirs(names):
    if names:
        return [ROOT / n.strip('/') for n in names]
    return sorted(p for p in ROOT.iterdir()
                  if p.is_dir() and p.name not in SKIP and not p.name.startswith('.')
                  and any(p.glob('*.trex')))


def file_hash(base, rel):
    path = (base / rel).resolve()
    if not path.is_file():
        return None
    return hashlib.sha1(path.read_bytes()).hexdigest()[:10]


def main():
    changed, missing = [], set()
    for ext in extension_dirs(sys.argv[1:]):
        if not ext.is_dir():
            print('error: no extension folder %s' % ext.name, file=sys.stderr)
            sys.exit(1)
        version = ''
        for trex in sorted(ext.glob('*.trex')):
            found = TREX_VERSION.search(trex.read_text(encoding='utf-8'))
            if found:
                version = found.group(1)
        for page in sorted(ext.glob('*.html')):
            text = page.read_text(encoding='utf-8')

            def stamp(m):
                h = file_hash(page.parent, m.group(2))
                if h is None:
                    missing.add('%s/%s -> %s' % (ext.name, page.name, m.group(2)))
                    return m.group(0)
                return '%s%s?v=%s%s' % (m.group(1), m.group(2), h, m.group(3))

            new = REF.sub(stamp, text)
            if version:
                new = EXT_VERSION.sub(lambda m: m.group(1) + version + m.group(2), new)
            if new != text:
                page.write_text(new, encoding='utf-8')
                changed.append('%s/%s' % (ext.name, page.name))
    for rel in sorted(missing):
        print('warning: %s not found, left unstamped' % rel, file=sys.stderr)
    print('updated: ' + ', '.join(changed) if changed else 'all versions up to date')
    if missing:
        sys.exit(1)


if __name__ == '__main__':
    main()
