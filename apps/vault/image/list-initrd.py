#!/usr/bin/env python3
"""Lists the initrd inside a UKI: every entry of each cpio archive in its .initrd section (decompressed with zstd),
with mode, owner, mtime, size and the SHA-256 of its content. build.sh writes it to <out>/initrd-files.txt so two
builds can be compared file by file; the section's own hash is in uki-sections.txt.

    list-initrd.py <uki>
"""
import hashlib
import subprocess
import sys

import pefile


def entries(data):
    """newc ("070701") cpio archives, one after another, padded to 4 bytes."""
    i = 0
    while i + 110 <= len(data):
        if data[i:i + 6] != b'070701':
            # Padding between archives.
            i += 1
            continue
        h = data[i:i + 110]
        field = lambda n: int(h[6 + 8 * n:14 + 8 * n], 16)
        mode, uid, gid, mtime, size, namesize = field(1), field(2), field(3), field(5), field(6), field(11)
        name_start = i + 110
        name = data[name_start:name_start + namesize - 1].decode('utf-8', 'replace')
        body = (name_start + namesize + 3) & ~3
        content = data[body:body + size]
        i = (body + size + 3) & ~3
        if name == 'TRAILER!!!':
            continue
        yield name, mode, uid, gid, mtime, size, hashlib.sha256(content).hexdigest()


def main():
    pe = pefile.PE(sys.argv[1])
    s = [s for s in pe.sections if s.Name.rstrip(b'\0') == b'.initrd'][0]
    section = s.get_data()[:s.Misc_VirtualSize]
    # The frames decode completely; zstd then refuses the section's zero padding, which is left out.
    r = subprocess.run(['zstd', '-dc'], input=section, capture_output=True)
    plain = r.stdout
    if not plain:
        sys.exit(f'zstd: {r.stderr.decode().strip()}')
    for name, mode, uid, gid, mtime, size, digest in sorted(entries(plain)):
        print(f'{oct(mode)} {uid}:{gid} {mtime} {size} {digest} {name}')


main()
