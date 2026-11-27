"""Second pass: area shares over LAND only (LIO extent Mainland + Islands, Water dropped).

The CMSM/DSSAB layer is land-only, while LIO municipalities include their Great Lakes water
extents, so the first pass under-counts coverage. Writes tools/source/land-cache.json.
"""
import json
from collections import defaultdict
import shapely
from build_parents import SRC, ROOT, repaired, shares, load

def land_key(feature):
    p = feature['properties']
    if p['MUNICIPAL_AREA_EXTENT_TYPE'] == 'Water':
        return None
    tier = {'Lower Tier Municipality': 'lower', 'Single Tier Municipality': 'single',
            'Upper Tier Municipality': 'upper'}.get(p['MUNICIPAL_TYPE'])
    return tier and f"{tier}-{int(p['MUNID'])}"

if __name__ == '__main__':
    cache = json.loads((SRC / 'overlay-cache.json').read_text())
    mgr_by_name = {p['shortName'].upper(): mid for mid, p in cache['mgrProps'].items()}
    land = {}
    for name in ['lio-lower-single.geojson', 'lio-upper-district.geojson']:
        geoms, _ = load(SRC / name, land_key)
        land.update(geoms)
        print('loaded', name, flush=True)
    raw, _ = load(SRC / 'cmsm-dssab.geojson', lambda f: f['properties']['NAME'])
    mgrs = {mgr_by_name[k]: g for k, g in raw.items()}
    out = shares({k: v for k, v in land.items() if k in cache['distProps']}, mgrs)
    (SRC / 'land-cache.json').write_text(json.dumps(out))
    print('done', len(out), flush=True)
