"""Attribute every non-contained municipality to a cause and fold it into parents-report.json.

For a municipality M (ungeneralized land) with official parent P, take the pieces of M that
P does not cover (uncovered land, or land another manager covers). Each connected piece is:
  reserve exclusion   within RESERVE_M of an LIO Indian Reserve (the CMSM layer omits reserves)
  edge drift          thinner than TOLERANCE_M everywhere (erodes to nothing): a shoreline/edge
                      sliver from the source layer's 1.5 km bend simplification
  genuine split       survives erosion: a real block of land assigned elsewhere or nowhere
Only the small pieces are buffered, never whole shorelines, so this runs in seconds.
Repaired geometries are cached as WKB in tools/source/gap-cache.wkb.json.
"""
import json
import shapely
from build_parents import SRC, ROOT, load, repaired
from land_shares import land_key

TOLERANCE_M = 1500
RESERVE_M = 1500
CACHE = SRC / 'gap-cache.wkb.json'


def geometries(cases):
    if CACHE.exists():
        raw = json.loads(CACHE.read_text())
        return {k: {i: shapely.from_wkb(bytes.fromhex(v)) for i, v in g.items()} for k, g in raw.items()}
    cache = json.loads((SRC / 'overlay-cache.json').read_text())
    mgr_by_name = {p['shortName'].upper(): mid for mid, p in cache['mgrProps'].items()}
    land = {}
    for name in ['lio-lower-single.geojson', 'lio-upper-district.geojson']:
        geoms, _ = load(SRC / name, lambda f: (k := land_key(f)) in cases and k or None)
        land.update(geoms)
    mgrs_raw, _ = load(SRC / 'cmsm-dssab.geojson', lambda f: f['properties']['NAME'])
    reserves = {str(i): repaired(f['geometry']) for i, f in
                enumerate(json.loads((SRC / 'lio-indian-reserve.geojson').read_text())['features'])}
    out = {'land': land, 'mgrs': {mgr_by_name[k]: g for k, g in mgrs_raw.items()}, 'reserves': reserves}
    CACHE.write_text(json.dumps({k: {i: shapely.to_wkb(g, hex=True) for i, g in v.items()} for k, v in out.items()}))
    return out


def main():
    path = ROOT / 'tools' / 'parents-report.json'
    report = json.loads(path.read_text())
    cases = {k: r for k, r in report['municipalities'].items() if r['fullClass'] != 'contained'}
    g = geometries(cases)
    mgrs, reserves = g['mgrs'], list(g['reserves'].values())
    reserve_tree = shapely.STRtree(reserves)

    for mid, r in cases.items():
        m = g['land'][mid]
        uncovered = m.difference(mgrs[r['official']])  # everything the official parent misses
        parts = [p for p in getattr(uncovered, 'geoms', [uncovered]) if p.area >= 1]
        totals = {'reserve exclusion': 0.0, 'edge drift from generalization': 0.0, 'genuine split': 0.0}
        elsewhere = {}
        for part in parts:
            if len(reserve_tree.query(part, predicate='dwithin', distance=RESERVE_M)):
                cause = 'reserve exclusion'
            elif part.buffer(-TOLERANCE_M / 2).is_empty:
                cause = 'edge drift from generalization'
            else:
                cause = 'genuine split'
            totals[cause] += part.area
            for k in r['full']:
                if k != r['official']:
                    share = part.intersection(mgrs[k]).area
                    if share:
                        elsewhere[k] = elsewhere.get(k, 0) + share
        cause = max(totals, key=totals.get)
        r['gapAttribution'] = {
            'uncoveredKm2': round(uncovered.area / 1e6, 3), 'share': round(uncovered.area / m.area, 4),
            'byCauseKm2': {k: round(v / 1e6, 3) for k, v in totals.items()},
            'coveredByOtherKm2': {k: round(v / 1e6, 3) for k, v in elsewhere.items()},
        }
        r['mismatchCause'] = cause
        print(f"{mid:13} {r['name'][:26]:26} {r['fullClass']:16} {cause:31} "
              f"{r['gapAttribution']['byCauseKm2']} other={r['gapAttribution']['coveredByOtherKm2']}", flush=True)
    report['attribution'] = {'toleranceM': TOLERANCE_M, 'reserveM': RESERVE_M, 'method': __doc__.strip()}
    path.write_text(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
