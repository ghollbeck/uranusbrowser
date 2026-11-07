#!/usr/bin/env python3
"""Lays out a mounted disk image's window by writing its .DS_Store, as Finder would.

    dmg-layout.py <volume> --background <file in the volume> --window <w>x<h>
                  --icon-size <n> --icon <name>=<x>,<y> [--icon ...]

The window opens at the given size (in points) with no toolbar, sidebar, path or status
bar, shows the background picture, and puts each named item's icon centre at x,y. Only
Python's standard library and macOS: no Finder scripting, so no Automation prompt, and it
works without a logged-in Finder. package-release.sh runs it on the read-write image
before compressing it.

The .DS_Store format (a buddy-allocated file holding one B-tree of records) is undocumented;
this follows what Finder writes, as described by Mark Mentovai's and Wim Lewis's notes and
the ds_store/dmgbuild projects. The background is referred to by a bookmark (the 'pBBk'
record), which Finder has read since macOS 10.12, made with Foundation through osascript's
JavaScript bridge (which drives no app, so it needs no permission).
"""
import argparse
import os
import plistlib
import struct
import subprocess
import sys
import base64

PAGE_SIZE = 0x1000


def bookmark(path):
    script = (
        'ObjC.import("Foundation"); function run(argv) {'
        ' const url = $.NSURL.fileURLWithPath(argv[0]);'
        ' const data = url.bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(0, $(), $(), $());'
        ' return data.base64EncodedStringWithOptions(0).js; }'
    )
    out = subprocess.run(['osascript', '-l', 'JavaScript', '-e', script, path], check=True, capture_output=True, text=True)
    return base64.b64decode(out.stdout.strip())


def utf16(name):
    data = name.encode('utf-16-be')
    return struct.pack('>I', len(data) // 2) + data


def record(name, code, kind, value):
    """One record: the file it's about, a four-letter property code, a typed value."""
    out = utf16(name) + code.encode('ascii') + kind.encode('ascii')
    if kind == 'blob':
        out += struct.pack('>I', len(value)) + value
    elif kind == 'long':
        out += struct.pack('>I', value)
    elif kind == 'bool':
        out += struct.pack('>?', value)
    else:
        raise ValueError(kind)
    return out


def free_blocks(allocated, addr=0, k=31):
    """The buddy allocator's free list entries left around the allocated (address, log2 size) blocks."""
    if (addr, k) in allocated:
        return []
    end = addr + (1 << k)
    if not any(a < end and a + (1 << s) > addr for a, s in allocated):
        return [(addr, k)]
    half = 1 << (k - 1)
    return free_blocks(allocated, addr, k - 1) + free_blocks(allocated, addr + half, k - 1)


def ds_store(records):
    # Records sorted as Finder keeps them: by file name, case-insensitively, then by code.
    records = sorted(records, key=lambda r: (r[0].lower(), r[1]))
    leaf = struct.pack('>II', 0, len(records)) + b''.join(record(*r) for r in records)
    if len(leaf) > PAGE_SIZE:
        raise ValueError(f'too many records for one B-tree node: {len(leaf)} bytes; ' + ', '.join(f'{r[0]}:{r[1]}={len(record(*r))}' for r in records))

    # Where Finder puts things in a small store: the root block at 0x1000 (2 KiB), the
    # B-tree's superblock at 0x40 (32 bytes) and its one node at 0x2000 (4 KiB). The file's
    # header takes the first 32 bytes. Addresses count from byte 4 of the file.
    root_addr, dsdb_addr, node_addr = 0x1000, 0x40, 0x2000
    offsets = [root_addr | 11, dsdb_addr | 5, node_addr | 12]
    allocated = {(0, 5), (dsdb_addr, 5), (root_addr, 11), (node_addr, 12)}
    free = {k: [] for k in range(32)}
    for addr, k in free_blocks(allocated):
        free[k].append(addr)

    root = struct.pack('>II', len(offsets), 0)
    root += b''.join(struct.pack('>I', o) for o in offsets)
    root += b'\0' * 4 * (256 - len(offsets) % 256)
    root += struct.pack('>IB4sI', 1, 4, b'DSDB', 1)  # the table of contents: DSDB is block 1
    for k in range(32):
        root += struct.pack('>I', len(free[k])) + b''.join(struct.pack('>I', a) for a in sorted(free[k]))
    if len(root) > 2048:
        raise ValueError('root block overflow')

    # The B-tree: its root is block 2, a leaf (no levels above it), one node.
    dsdb = struct.pack('>IIIII', 2, 0, len(records), 1, PAGE_SIZE)

    data = bytearray(4 + node_addr + PAGE_SIZE)
    data[0:4] = struct.pack('>I', 1)
    data[4:36] = struct.pack('>4sIII16s', b'Bud1', root_addr, 0x800, root_addr,
                             bytes.fromhex('0000100c000000870000200b00000000'))
    for addr, block in ((root_addr, root), (dsdb_addr, dsdb), (node_addr, leaf)):
        data[4 + addr:4 + addr + len(block)] = block
    return bytes(data)


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('volume')
    p.add_argument('--background', required=True, help='a picture inside the volume')
    p.add_argument('--window', required=True, help='content size in points, e.g. 660x420')
    p.add_argument('--origin', default='400,360', help='window position: x, y of its bottom left corner')
    p.add_argument('--icon-size', type=int, default=128)
    p.add_argument('--text-size', type=float, default=13)
    p.add_argument('--icon', action='append', default=[], help='name=x,y (icon centre)')
    a = p.parse_args()

    width, height = (int(v) for v in a.window.split('x'))
    left, top = (int(v) for v in a.origin.split(','))
    background = os.path.join(a.volume, a.background)
    if not os.path.isfile(background):
        sys.exit(f'error: no {background}')

    # The window: Finder keeps its frame in screen points, from the bottom left of the
    # main screen, and with no toolbar the frame is the content area plus the title bar:
    # 32 points on macOS 26 (28 before, where the content comes out 4 points taller).
    title_bar = 32
    bwsp = {
        'ContainerShowSidebar': False,
        'PreviewPaneVisibility': False,
        'ShowPathbar': False,
        'ShowSidebar': False,
        'ShowStatusBar': False,
        'ShowTabView': False,
        'ShowToolbar': False,
        'SidebarWidth': 0,
        'WindowBounds': f'{{{{{left}, {top}}}, {{{width}, {height + title_bar}}}}}',
    }
    icvp = {
        'arrangeBy': 'none',
        'backgroundColorBlue': 1.0,
        'backgroundColorGreen': 1.0,
        'backgroundColorRed': 1.0,
        'backgroundType': 2,  # a picture
        'gridOffsetX': 0.0,
        'gridOffsetY': 0.0,
        'gridSpacing': 100.0,
        'iconSize': float(a.icon_size),
        'labelOnBottom': True,
        'scrollPositionX': 0.0,
        'scrollPositionY': 0.0,
        'showIconPreview': True,
        'showItemInfo': False,
        'textSize': float(a.text_size),
        'viewOptionsVersion': 1,
    }
    records = [
        ('.', 'bwsp', 'blob', plistlib.dumps(bwsp, fmt=plistlib.FMT_BINARY)),
        ('.', 'icvp', 'blob', plistlib.dumps(icvp, fmt=plistlib.FMT_BINARY)),
        ('.', 'pBBk', 'blob', bookmark(background)),
        ('.', 'vSrn', 'long', 1),
    ]
    for spec in a.icon:
        name, _, xy = spec.rpartition('=')
        x, y = (int(v) for v in xy.split(','))
        if not os.path.lexists(os.path.join(a.volume, name)):
            sys.exit(f'error: no {name} in {a.volume}')
        # An icon's position, then what Finder always writes after it.
        records.append((name, 'Iloc', 'blob', struct.pack('>IIII', x, y, 0xFFFFFFFF, 0xFFFF0000)))

    with open(os.path.join(a.volume, '.DS_Store'), 'wb') as f:
        f.write(ds_store(records))


if __name__ == '__main__':
    main()
