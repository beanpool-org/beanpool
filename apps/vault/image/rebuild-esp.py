#!/usr/bin/env python3
"""Makes the install image's ESP again, the same bytes on any machine (build.sh).

systemd-repart fills the ESP's FAT in the order the build machine's file system lists directories, so the same files
land in different clusters on another machine and the install image differs, though nothing in it that boots does.
This takes the ESP's files out, makes a new FAT of the same size, serial number, label and cluster size
(mkfs.vfat --invariant), adds directories and then files in sorted order with every time set to SOURCE_DATE_EPOCH,
and writes it back over the old one.

    rebuild-esp.py <disk image>
"""
import json
import os
import subprocess
import sys
import tempfile

ESP_TYPE = 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B'


def run(*args, **kw):
    return subprocess.run(args, check=True, capture_output=True, **kw)


def main():
    raw = sys.argv[1]
    epoch = int(os.environ['SOURCE_DATE_EPOCH'])
    table = json.loads(run('sfdisk', '-J', raw).stdout)['partitiontable']
    esp = [p for p in table['partitions'] if p['type'].upper() == ESP_TYPE][0]
    offset, size = esp['start'] * 512, esp['size'] * 512
    with tempfile.TemporaryDirectory() as tmp:
        old, new, files = f'{tmp}/old.img', f'{tmp}/new.img', f'{tmp}/files'
        with open(raw, 'rb') as f, open(old, 'wb') as o:
            f.seek(offset)
            o.write(f.read(size))
        with open(old, 'rb') as o:
            boot = o.read(512)
        sectors_per_cluster = boot[13]
        serial = boot[0x43:0x47][::-1].hex().upper()
        label = boot[0x47:0x52].decode('ascii').strip()
        os.mkdir(files)
        run('mcopy', '-s', '-n', '-i', old, '::/', files)
        with open(new, 'wb') as n:
            n.truncate(size)
        env = {**os.environ, 'SOURCE_DATE_EPOCH': str(epoch)}
        run('mkfs.vfat', '--invariant', '-F', '32', '-S', '512', '-s', str(sectors_per_cluster), '-i', serial, '-n', label, new, env=env)
        dirs, regular = [], []
        for root, dnames, fnames in os.walk(files):
            rel = os.path.relpath(root, files)
            dirs += [os.path.normpath(os.path.join(rel, d)) for d in dnames]
            regular += [os.path.normpath(os.path.join(rel, f)) for f in fnames]
        for d in sorted(dirs):
            run('mmd', '-i', new, f'::/{d}', env=env)
        for f in sorted(regular):
            os.utime(os.path.join(files, f), (epoch, epoch))
            run('mcopy', '-m', '-i', new, os.path.join(files, f), f'::/{f}', env=env)
        with open(new, 'rb') as n, open(raw, 'r+b') as f:
            f.seek(offset)
            f.write(n.read())
        for f in sorted(regular):
            print(f)


main()
