"""Build the municipality -> CMSM/DSSAB parent table and audit it against the regulations.

Inputs
  tools/source/lio-lower-single.geojson    ungeneralized LIO lower/single tier (fetch_sources.py)
  tools/source/lio-upper-district.geojson  ungeneralized LIO upper tier / district
  tools/source/cmsm-dssab.geojson          MMAH CMSM/DSSAB layer (1.5 km bend-simplified at source)
  tools/source/mmah-municipalities.csv     MMAH list of Ontario municipalities (tier, geographic area)
  dist/municipalities.geojson, dist/service-managers.geojson  what the app draws

Official membership is O. Reg. 136/98 Sched. 1 (CMSMs) and O. Reg. 278/98 (DSSAB districts),
encoded below as rules over the MMAH list's "Geographic area" column.

Outputs
  dist/parents.json            {municipality id: service manager id}, loaded by the app
  tools/parents-report.json    full per-municipality overlay shares and mismatch causes
"""
import csv
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'tools' / 'source'
DIST = ROOT / 'dist'
CONTAINED = 0.98  # share of a municipality's area that must fall in one parent
SPLIT = 0.02      # second parent share that counts as a real split rather than edge noise

# Ontario MNR Lambert (equal-area enough for shares; metres)
TO_LAMBERT = Transformer.from_crs(4326, 3161, always_xy=True)


def project(geom):
    return shapely.transform(geom, lambda c: np.column_stack(TO_LAMBERT.transform(c[:, 0], c[:, 1])))


def repaired(geometry):
    geom = shapely.make_valid(project(shape(geometry)))
    if geom.geom_type == 'GeometryCollection':
        geom = shapely.union_all([g for g in geom.geoms if g.geom_type in ('Polygon', 'MultiPolygon')])
    return shapely.set_precision(geom, 1.0)


def norm(text):
    try:
        text = text.encode('latin-1').decode('utf-8')  # the MMAH CSV double-encodes accents
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    text = unicodedata.normalize('NFD', text).encode('ascii', 'ignore').decode().lower()
    text = re.sub(r'\b(county|united counties|regional municipality|district municipality)\b', '', text)
    return re.sub(r'[^a-z0-9]+', '', text.replace('&', 'and'))


# O. Reg. 136/98 Schedule 1: upper tier / geographic area -> CMSM (service-managers.geojson shortName)
AREA_TO_CMSM = {
    'Bruce': 'Bruce', 'Dufferin': 'Dufferin', 'Durham': 'Durham', 'Elgin': 'St. Thomas', 'Essex': 'Windsor',
    'Frontenac': 'Kingston', 'Grey': 'Grey', 'Haliburton': 'Kawartha Lakes', 'Halton': 'Halton',
    'Hastings': 'Hastings', 'Huron': 'Huron', 'Lambton': 'Lambton', 'Lanark': 'Lanark',
    'Leeds and Grenville': 'Leeds And Grenville', 'Lennox and Addington': 'Lennox And Addington',
    'Middlesex': 'London', 'Muskoka': 'Muskoka', 'Niagara': 'Niagara', 'Northumberland': 'Northumberland',
    'Oxford': 'Oxford', 'Peel': 'Peel', 'Perth': 'Stratford', 'Peterborough': 'Peterborough',
    'Prescott and Russell': 'Prescott And Russell', 'Renfrew': 'Renfrew', 'Simcoe': 'Simcoe',
    'Stormont, Dundas and Glengarry': 'Cornwall', 'Waterloo': 'Waterloo', 'Wellington': 'Wellington',
    'York': 'York', 'Brant': 'Brantford', 'Haldimand': 'Norfolk County', 'Norfolk': 'Norfolk County',
    'Chatham-Kent': 'Chatham-Kent', 'Hamilton': 'Hamilton', 'Kawartha Lakes': 'Kawartha Lakes',
    'Ottawa': 'Ottawa', 'Toronto': 'Toronto', 'Prince Edward': 'Lennox And Addington',
    # O. Reg. 278/98 DSSAB districts (territorial districts)
    'Algoma': 'Algoma', 'Cochrane': 'Cochrane', 'Kenora': 'Kenora', 'Manitoulin': 'Manitoulin-Sudbury',
    'Sudbury': 'Manitoulin-Sudbury', 'Nipissing': 'Nipissing', 'Parry Sound': 'Parry Sound',
    'Rainy River': 'Rainy River', 'Thunder Bay': 'Thunder Bay', 'Timiskaming': 'Temiskaming',
}
# Named exceptions in the regulations
BY_NAME = {
    ('single', 'saultstemarie'): ('Sault Ste. Marie', 'O. Reg. 278/98 Sched. 5.1'),
    ('single', 'prince'): ('Sault Ste. Marie', 'O. Reg. 278/98 Sched. 5.1'),
    ('single', 'greatersudbury'): ('Greater Sudbury', 'O. Reg. 136/98 Sched. 1 item 2'),
    ('single', 'westnipissing'): ('Nipissing', 'O. Reg. 278/98 Sched. 3'),
    ('single', 'killarney'): ('Manitoulin-Sudbury', 'O. Reg. 278/98 Sched. 4 excludes Killarney'),
}


def official_table():
    rows = {}
    with open(SRC / 'mmah-municipalities.csv', encoding='utf-8-sig') as handle:
        for row in csv.DictReader(handle):
            row = {k.strip(): v.strip() for k, v in row.items()}
            label = re.sub(r'<[^>]+>', '', row['Municipality'])
            name = label.rsplit(', ', 1)[0] if ', ' in label else label
            name = re.sub(r' Municipality$', '', name)  # "The Nation Municipality" -> LIO "The Nation"
            tier = row['Municipal status'].split()[0].lower()
            area = row['Geographic area']
            key = (tier, norm(name))
            if key in BY_NAME:
                manager, rule = BY_NAME[key]
            else:
                manager = AREA_TO_CMSM[area]
                rule = ('O. Reg. 278/98' if area in {'Algoma', 'Cochrane', 'Kenora', 'Manitoulin', 'Sudbury', 'Nipissing',
                                                     'Parry Sound', 'Rainy River', 'Thunder Bay', 'Timiskaming'}
                        else 'O. Reg. 136/98 Sched. 1') + f' via geographic area "{area}"'
            rows[key] = {'label': label, 'area': area, 'manager': manager, 'rule': rule}
    return rows


def load(path, key):
    groups = defaultdict(list)
    props = {}
    for feature in json.loads(path.read_text(encoding='utf-8'))['features']:
        k = key(feature)
        if k is None:
            continue
        groups[k].append(repaired(feature['geometry']))
        props.setdefault(k, feature['properties'])
    return {k: shapely.union_all(v, grid_size=1.0) for k, v in groups.items()}, props


def lio_key(feature):
    p = feature['properties']
    tier = {'Lower Tier Municipality': 'lower', 'Single Tier Municipality': 'single',
            'Upper Tier Municipality': 'upper'}.get(p['MUNICIPAL_TYPE'])
    return tier and f"{tier}-{int(p['MUNID'])}"


def shares(munis, managers):
    tree_ids = list(managers)
    tree = shapely.STRtree([managers[i] for i in tree_ids])
    out = {}
    for mid, geom in munis.items():
        area = geom.area
        hits = {}
        for index in tree.query(geom, predicate='intersects'):
            overlap = geom.intersection(managers[tree_ids[index]]).area / area
            if overlap > 1e-6:
                hits[tree_ids[index]] = overlap
        out[mid] = dict(sorted(hits.items(), key=lambda kv: -kv[1]))
    return out


def classify(hit):
    ranked = list(hit.values())
    top = ranked[0] if ranked else 0
    second = ranked[1] if len(ranked) > 1 else 0
    if not ranked:
        return 'no-parent'
    if top >= CONTAINED:
        return 'contained'
    if second >= SPLIT:
        return 'split'
    return 'partial-coverage'  # remainder is outside every service manager (water, reserves, shoreline)


def overlays():
    """Area shares for both data sets; cached because repairing 500 MB of LIO geometry is slow."""
    cache = ROOT / 'tools' / 'source' / 'overlay-cache.json'
    if cache.exists():
        return json.loads(cache.read_text())
    print('loading dist')
    dist_munis, dist_props = load(DIST / 'municipalities.geojson', lambda f: f['id'])
    dist_mgrs, mgr_props = load(DIST / 'service-managers.geojson', lambda f: f['id'])
    mgr_by_name = {p['shortName'].upper(): mid for mid, p in mgr_props.items()}
    print('loading ungeneralized LIO + source CMSM (slow)')
    lio = {}
    for name in ['lio-lower-single.geojson', 'lio-upper-district.geojson']:
        geoms, _ = load(SRC / name, lio_key)
        lio.update(geoms)
    src_mgrs_raw, _ = load(SRC / 'cmsm-dssab.geojson', lambda f: f['properties']['NAME'])
    src_mgrs = {mgr_by_name[k]: g for k, g in src_mgrs_raw.items()}
    print('overlaying')
    result = {
        'distProps': dist_props, 'mgrProps': mgr_props,
        'full': shares({k: lio[k] for k in dist_munis if k in lio}, src_mgrs),
        'gen': shares(dist_munis, dist_mgrs),
    }
    cache.write_text(json.dumps(result))
    return result


def main():
    official = official_table()
    data = overlays()
    dist_props, mgr_props, gen = data['distProps'], data['mgrProps'], data['gen']
    # Prefer land-only shares (land_shares.py): LIO municipalities include Great Lakes water, the
    # CMSM/DSSAB layer is land-only, so whole-extent shares read as "partial" for every lakeshore town.
    land_cache = SRC / 'land-cache.json'
    full = json.loads(land_cache.read_text()) if land_cache.exists() else data['full']
    mgr_by_name = {p['shortName']: mid for mid, p in mgr_props.items()}

    report, table, unmatched = {}, {}, []
    for mid, props in dist_props.items():
        key = (props['tier'], norm(props['shortName']))
        rule = official.get(key)
        if rule is None:
            unmatched.append(mid)
        expected = rule and mgr_by_name[rule['manager']]
        f_hit, g_hit = full.get(mid, {}), gen[mid]
        f_top = next(iter(f_hit), None)
        g_top = next(iter(g_hit), None)
        cause = None
        if expected and g_top != expected:
            if f_top == expected:
                cause = 'edge drift from generalization (ungeneralized overlay agrees with regulation)'
            elif expected not in f_hit:
                cause = 'service-manager layer does not cover the municipality (reserve exclusion / layer gap)'
            else:
                cause = 'genuine split in source geometry (regulation assigns whole municipality)'
        report[mid] = {
            'name': props['shortName'], 'tier': props['tier'],
            'official': expected, 'officialName': rule and rule['manager'], 'rule': rule and rule['rule'],
            'full': {k: round(v, 4) for k, v in f_hit.items()}, 'fullClass': classify(f_hit) if f_hit else 'no-parent',
            'dist': {k: round(v, 4) for k, v in g_hit.items()}, 'distClass': classify(g_hit),
            'distTopMatchesOfficial': g_top == expected, 'fullTopMatchesOfficial': f_top == expected,
            'mismatchCause': cause,
        }
        # The table the app loads is the regulation, not geometry: geometry only audits it.
        if expected:
            table[mid] = expected

    (DIST / 'parents.json').write_text(json.dumps(table, separators=(',', ':')))
    (ROOT / 'tools' / 'parents-report.json').write_text(json.dumps({
        'sources': {
            'municipal': 'LIO MUNIC_BND_LOWER_AND_SINGLE_FT + MUNIC_BND_UPPER_AND_DIST (ungeneralized, '
                         'Mainland + Islands extents; Water extents dropped)',
            'serviceManagers': 'MMAH CMSM/DSSAB FeatureServer 0 (bend-simplified 1.5 km at source; no finer public copy)',
            'official': 'O. Reg. 136/98 Sched. 1; O. Reg. 278/98 Scheds. 1-7; MMAH municipal list CSV 2022-10-05',
        },
        'thresholds': {'contained': CONTAINED, 'split': SPLIT},
        'unmatched': unmatched,
        'municipalities': report,
    }, indent=1))

    for label, cls in [('ungeneralized', 'fullClass'), ('dist', 'distClass')]:
        print(label, Counter(r[cls] for r in report.values()))
        print(' by tier', Counter((r['tier'], r[cls]) for r in report.values()))
    print('unmatched to official list:', unmatched)
    print('dist argmax != regulation:', sum(not r['distTopMatchesOfficial'] for r in report.values()))
    print('full argmax != regulation:', sum(not r['fullTopMatchesOfficial'] for r in report.values()))
    for mid, r in report.items():
        if r['mismatchCause'] or r['fullClass'] != 'contained' or r['distClass'] != 'contained':
            print(f"{mid:14} {r['name'][:28]:28} off={r['officialName']!s:20} full={r['fullClass']:16} "
                  f"{list(r['full'].items())[:3]} dist={r['distClass']:16} {list(r['dist'].items())[:3]} :: {r['mismatchCause']}")


if __name__ == '__main__':
    main()
