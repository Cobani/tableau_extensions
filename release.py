#!/usr/bin/env python3
"""One command for everything that must be true before a commit.

    python3 release.py                 run every check, stamp ?v= hashes, sync the top-level .trex copies
    python3 release.py --check         the same checks, but change nothing (what CI runs)
    python3 release.py versions        list every extension's version
    python3 release.py bump <slug> <patch|minor|major> "What changed, in plain words"
                                       raise the .trex extension-version and add the CHANGELOG.md entry
                                       (repeat the last argument for several lines)
    python3 release.py note <slug> "What changed"
                                       add a line under the current version in CHANGELOG.md (no bump)

Checks, in order: JavaScript syntax (node --check), manifests (xmllint, or Python's XML parser when
xmllint is missing), cache-busting stamps (stamp-versions.py), lint (eslint, when installed with
`npm install`), tests (`npm test`). Exit code 0 = safe to commit.

The .trex copies in the folder above this repo (Forum loads extensions from there) are refreshed
when that folder exists; it does not exist in CI, which is fine.
"""
import datetime
import pathlib
import re
import shutil
import subprocess
import sys
import xml.dom.minidom

ROOT = pathlib.Path(__file__).resolve().parent
TOP = ROOT.parent
VERSION = re.compile(r'(extension-version=")(\d+)\.(\d+)\.(\d+)(")')


def extensions():
    return sorted(p for p in ROOT.iterdir() if p.is_dir() and not p.name.startswith('.') and any(p.glob('*.trex')))


def trex_of(ext):
    return sorted(ext.glob('*.trex'))[0]


def version_of(ext):
    m = VERSION.search(trex_of(ext).read_text(encoding='utf-8'))
    return '%s.%s.%s' % (m.group(2), m.group(3), m.group(4)) if m else None


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, **kw)


def step(name, ok, detail=''):
    print(('ok    ' if ok else 'FAIL  ') + name + (('\n' + detail.rstrip()) if detail and not ok else ''))
    return ok


def check_js():
    bad = []
    files = [f for pat in ('*/*.js', '*/dev/*.js', 'shared/*.js', 'tests/*.js') for f in sorted(ROOT.glob(pat))
             if 'node_modules' not in f.parts]
    for f in files:
        r = run(['node', '--check', str(f)])
        if r.returncode:
            bad.append(r.stderr)
    return step('JavaScript syntax (%d files)' % len(files), not bad, '\n'.join(bad))


def check_trex():
    bad = []
    for ext in extensions():
        t = trex_of(ext)
        if shutil.which('xmllint'):
            r = run(['xmllint', '--noout', str(t)])
            if r.returncode:
                bad.append(r.stderr)
        else:
            try:
                xml.dom.minidom.parse(str(t))
            except Exception as e:  # noqa: BLE001
                bad.append('%s: %s' % (t.name, e))
        if 'localhost' in t.read_text(encoding='utf-8'):
            bad.append('%s points at localhost' % t.name)
    return step('Manifests (.trex)', not bad, '\n'.join(bad))


def stamp(check_only):
    if check_only:
        before = {p: p.read_bytes() for p in ROOT.glob('*/*.html')}
        r = run([sys.executable, 'stamp-versions.py'])
        changed = [str(p.relative_to(ROOT)) for p, b in before.items() if p.read_bytes() != b]
        for p, b in before.items():
            p.write_bytes(b)
        return step('Cache-busting stamps', r.returncode == 0 and not changed,
                    r.stderr + ('out of date: ' + ', '.join(changed) + '\nrun: python3 release.py' if changed else ''))
    r = run([sys.executable, 'stamp-versions.py'])
    return step('Cache-busting stamps (' + r.stdout.strip() + ')', r.returncode == 0, r.stderr)


def sync_trex(check_only):
    if not (TOP / 'AGENTS.md').exists() and not (TOP / 'CLAUDE.md').exists():
        return True  # CI: no folder above the repo
    stale = []
    for ext in extensions():
        t = trex_of(ext)
        copy = TOP / t.name
        if not copy.exists() or copy.read_bytes() != t.read_bytes():
            stale.append(t.name)
            if not check_only:
                shutil.copyfile(t, copy)
    if check_only:
        return step('Top-level .trex copies', not stale, 'out of date: ' + ', '.join(stale))
    return step('Top-level .trex copies' + (' (updated ' + ', '.join(stale) + ')' if stale else ''), True)


def lint():
    if not (ROOT / 'node_modules' / '.bin' / 'eslint').exists():
        print('skip  Lint (run `npm install` once to enable)')
        return True
    r = run(['node_modules/.bin/eslint', '.', '--quiet'])
    return step('Lint (eslint)', r.returncode == 0, r.stdout[-3000:])


def tests():
    r = run(['node', '--test', 'tests/*.test.js'])
    out = r.stdout
    fails = re.findall(r'^not ok .*$', out, re.M)
    passed = re.search(r'^# pass (\d+)', out, re.M)
    return step('Tests (%s passed)' % (passed.group(1) if passed else '?'), r.returncode == 0,
                '\n'.join(fails) + '\nrun `npm test` for details')


def changelog_add(ext, version, lines, new_section):
    path = ext / 'CHANGELOG.md'
    text = path.read_text(encoding='utf-8') if path.exists() else '# Changelog — %s\n\nAll user-visible changes to this extension. Newest first.\n' % ext.name
    bullets = ''.join('- %s\n' % l.strip().rstrip('.').strip() + '' for l in lines)
    bullets = re.sub(r'\n', '.\n', bullets.replace('.\n', '\n'))
    head = '## %s — %s\n' % (version, datetime.date.today().isoformat())
    m = re.search(r'^## ', text, re.M)
    if new_section or not m:
        pos = m.start() if m else len(text)
        text = text[:pos] + head + bullets + '\n' + text[pos:]
    else:
        end = text.index('\n', m.start()) + 1
        text = text[:end] + bullets + text[end:]
    path.write_text(text, encoding='utf-8')


def cmd_bump(args):
    if len(args) < 3 or args[1] not in ('patch', 'minor', 'major'):
        sys.exit('usage: python3 release.py bump <slug> <patch|minor|major> "What changed" ["More"]')
    ext = ROOT / args[0].strip('/')
    if not ext.is_dir() or not any(ext.glob('*.trex')):
        sys.exit('no extension folder ' + args[0])
    t = trex_of(ext)
    text = t.read_text(encoding='utf-8')
    m = VERSION.search(text)
    a, b, c = int(m.group(2)), int(m.group(3)), int(m.group(4))
    a, b, c = {'patch': (a, b, c + 1), 'minor': (a, b + 1, 0), 'major': (a + 1, 0, 0)}[args[1]]
    new = '%d.%d.%d' % (a, b, c)
    t.write_text(VERSION.sub(lambda x: x.group(1) + new + x.group(5), text, count=1), encoding='utf-8')
    changelog_add(ext, new, args[2:], True)
    print('%s → %s (CHANGELOG.md updated). Now run: python3 release.py' % (ext.name, new))


def cmd_note(args):
    if len(args) < 2:
        sys.exit('usage: python3 release.py note <slug> "What changed"')
    ext = ROOT / args[0].strip('/')
    changelog_add(ext, version_of(ext), args[1:], False)
    print('%s: note added under %s' % (ext.name, version_of(ext)))


def main():
    args = sys.argv[1:]
    if args and args[0] == 'versions':
        for ext in extensions():
            print('%-18s %-10s %s' % (ext.name, version_of(ext), trex_of(ext).name))
        return
    if args and args[0] == 'bump':
        return cmd_bump(args[1:])
    if args and args[0] == 'note':
        return cmd_note(args[1:])
    check_only = '--check' in args
    ok = check_js()
    ok = check_trex() and ok
    ok = stamp(check_only) and ok
    ok = sync_trex(check_only) and ok
    ok = lint() and ok
    ok = tests() and ok
    print('\n' + ('All checks passed.' if ok else 'Fix the failures above before committing.'))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
