"""Dump a .brdb world database with Python's own sqlite3, as JSON, for cross-checking the
TypeScript reader and writer (tests/unit/brdb*.test.ts). Opens the file read-only.

    python scripts/check_brdb.py WORLD.brdb [--rows] [--at REVISION ...]

Output: SQLite pragmas, the schema (sqlite_master), revisions, files written / deleted per
revision, and the live tree (path -> size and SHA-256 of the uncompressed bytes). --rows adds
every folder, file and blob row; --at adds the tree as of a revision. Needs Python 3.14+ for
compression.zstd when blobs are compressed.
"""
import hashlib
import json
import sqlite3
import sys


def main():
    args = sys.argv[1:]
    path = args[0]
    rows = '--rows' in args
    at = [int(args[i + 1]) for i, a in enumerate(args) if a == '--at']
    uri = 'file:' + path.replace('?', '%3f').replace('#', '%23') + '?mode=ro&immutable=1'
    c = sqlite3.connect(uri, uri=True)
    q = lambda s, *p: c.execute(s, p).fetchall()
    out = {
        'pragmas': {k: q(f'PRAGMA {k}')[0][0] for k in ('page_size', 'user_version', 'encoding', 'application_id')},
        'master': [list(r) for r in q('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid')],
        'revisions': [list(r) for r in q('SELECT revision_id, description, created_at FROM revisions ORDER BY revision_id')],
    }
    folders = {fid: (par, name) for fid, par, name in q('SELECT folder_id, parent_id, name FROM folders')}

    def folder_path(f):
        parts = []
        while f is not None:
            par, name = folders[f]
            parts.append(name)
            f = par
        return '/'.join(reversed(parts))

    blobs = {}

    def content(bid):
        if bid not in blobs:
            comp, data = q('SELECT compression, content FROM blobs WHERE blob_id = ?', bid)[0]
            if comp == 1:
                from compression import zstd
                data = zstd.decompress(data)
            blobs[bid] = (len(data), hashlib.sha256(data).hexdigest())
        return blobs[bid]

    files = q('SELECT file_id, parent_id, name, content_id, created_at, deleted_at FROM files ORDER BY file_id')
    full = lambda par, name: (folder_path(par) + '/' + name) if par is not None else name
    written, deleted = {}, {}
    for _, _, _, _, ca, da in files:
        written[ca] = written.get(ca, 0) + 1
        if da is not None:
            deleted[da] = deleted.get(da, 0) + 1
    out['stats'] = [[rid, written.get(t, 0), deleted.get(t, 0)] for rid, _, t in out['revisions']]

    def tree(alive):
        t = {}
        for fid, par, name, cid, ca, da in files:
            if alive(ca, da):
                t[full(par, name)] = list(content(cid))
        return t

    out['live'] = tree(lambda ca, da: da is None)
    times = {rid: t for rid, _, t in out['revisions']}
    out['at'] = {str(r): tree(lambda ca, da, t=times[r]: ca <= t and (da is None or da > t)) for r in at}
    if rows:
        out['folders'] = [list(r) for r in q('SELECT folder_id, parent_id, name, created_at, deleted_at FROM folders ORDER BY folder_id')]
        out['files'] = [list(r) for r in files]
        out['blobs'] = [[bid, comp, us, cs, delta, h.hex() if h else None, *content(bid)]
                        for bid, comp, us, cs, delta, h in q('SELECT blob_id, compression, size_uncompressed, size_compressed, delta_base_id, hash FROM blobs ORDER BY blob_id')]
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
