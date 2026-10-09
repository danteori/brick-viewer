"""Test helper: entities and grid chunk indices of a save, decoded by the Python survey tool
(survey_brz.py, in the folder given as the first argument), as JSON. The TypeScript decoder is
compared against it. Read-only.

    python tests/py/survey_entities.py TOOLS_DIR SAVE
"""
import json
import sys


def main():
    tools, path = sys.argv[1], sys.argv[2]
    sys.path.insert(0, tools)
    import survey_brz as sb
    A = sb.load(path)
    F = A['files']
    ents = {}
    for k in F:
        if not k.startswith('World/0/Entities/Chunks/'):
            continue
        e = sb.decode(F[k], sb.schema_for(A, 'World/0/Entities/ChunksShared.schema', k), gd=sb.globaldata_for(A, k))
        for i, pi in enumerate(e['PersistentIndices']):
            L, R = e['Locations'][i], e['Rotations'][i]
            ents[pi] = {'type': e['_data'][i]['_type'], 'location': [L['X'], L['Y'], L['Z']], 'rotation': [R['X'], R['Y'], R['Z'], R['W']]}
    grids = {}
    for k in F:
        parts = k.split('/')
        if len(parts) == 6 and parts[3] == 'Grids' and parts[5] == 'ChunkIndex.mps':
            ci = sb.decode(F[k], sb.schema_for(A, 'World/0/Bricks/ChunkIndexShared.schema', k))
            grids[parts[4]] = {'chunks': [[c['X'], c['Y'], c['Z']] for c in ci['Chunk3DIndices']], 'bricks': ci['NumBricks']}
    json.dump({'entities': ents, 'grids': grids}, sys.stdout)


if __name__ == '__main__':
    main()
