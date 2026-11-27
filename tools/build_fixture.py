"""Pick ~20 hard click points from the geometry the app actually draws and record expected stacks.

Each point gets:
  contains  ids whose dist/ polygon contains the point (shapely, exact) -- "what is under the cursor"
  visible   ids within STROKE_PX screen pixels at the test zoom -- "what the user could have meant",
            since a 2-3 px stroke covers hundreds of metres at provincial zooms
  expected  the stack the app should show: `visible` for border cases, `contains` otherwise,
            ordered service manager -> upper tier -> lower/single
Output: tests/fixtures/points.json
"""
import json
import math
from pathlib import Path

import shapely
import shapely.ops
from shapely.geometry import Point, shape
from build_parents import DIST, project, ROOT

STROKE_PX = 3
ORDER = {'CMSM': 0, 'DSSAB': 0, 'upper': 1, 'lower': 2, 'single': 2}


def load():
    feats = {}
    for name in ['service-managers.geojson', 'municipalities.geojson']:
        for f in json.loads((DIST / name).read_text(encoding='utf-8'))['features']:
            geom = shapely.make_valid(shape(f['geometry']))
            if geom.geom_type == 'GeometryCollection':
                geom = shapely.union_all([g for g in geom.geoms if g.area > 0])
            feats[f['id']] = (f['properties'], geom)
    return feats


FEATS = load()
_PROJ = {}


def projected(fid):
    if fid not in _PROJ:
        _PROJ[fid] = project(FEATS[fid][1])
    return _PROJ[fid]
TREE_IDS = list(FEATS)
TREE = shapely.STRtree([FEATS[k][1] for k in TREE_IDS])


def by_name(tier, name):
    return next(k for k, (p, _) in FEATS.items() if p['tier'] in tier and p['shortName'] == name)


def metres_per_px(lat, zoom):
    return 156543.03392 * math.cos(math.radians(lat)) / 2 ** zoom


def ordered(ids):
    return sorted(ids, key=lambda k: (ORDER[FEATS[k][0]['tier']], FEATS[k][0]['shortName']))


def stacks(lng, lat, zoom):
    pt = Point(lng, lat)
    contains = [TREE_IDS[i] for i in TREE.query(pt, predicate='intersects')]
    radius = STROKE_PX * metres_per_px(lat, zoom)
    ppt = project(pt)
    near = [TREE_IDS[i] for i in TREE.query(pt.buffer(radius / 50000))  # deg prefilter, generous
            if projected(TREE_IDS[i]).distance(ppt) <= radius]
    return ordered(contains), ordered(near)


def interior(fid):
    return FEATS[fid][1].point_on_surface()


def shared_edge_point(a, b, side=None):
    """Midpoint of the longest shared boundary piece between a and b (optionally nudged into `side`)."""
    line = FEATS[a][1].boundary.intersection(FEATS[b][1].boundary)
    parts = [g for g in getattr(line, 'geoms', [line]) if g.length > 0]
    if not parts:  # boundaries don't coincide exactly (generalized independently): nearest points
        pa, pb = shapely.ops.nearest_points(FEATS[a][1].boundary, FEATS[b][1].boundary)
        return Point((pa.x + pb.x) / 2, (pa.y + pb.y) / 2)
    seg = max(parts, key=lambda g: g.length)
    return seg.interpolate(0.5, normalized=True)


def junction(ids):
    """Point where every boundary in ids meets (within ~10 m; layers share LIO vertices)."""
    zone = None
    for fid in ids:
        ring = FEATS[fid][1].boundary.buffer(1e-4)
        zone = ring if zone is None else zone.intersection(ring)
    if zone.is_empty:
        raise ValueError(f'no junction for {ids}')
    return zone.centroid


def piece_outside(fid, manager_id):
    """A point inside municipality fid that the (generalized) layer assigns to manager_id."""
    piece = FEATS[fid][1].intersection(FEATS[manager_id][1])
    piece = max(getattr(piece, 'geoms', [piece]), key=lambda g: g.area)
    return piece.point_on_surface()


def hole_point(fid):
    """Centre of the largest interior ring (hole) in fid."""
    geom = FEATS[fid][1]
    rings = [r for poly in getattr(geom, 'geoms', [geom]) for r in poly.interiors]
    ring = max(rings, key=lambda r: shapely.Polygon(r).area)
    return shapely.Polygon(ring).point_on_surface()


def main():
    peel, york, toronto = by_name({'CMSM'}, 'Peel'), by_name({'CMSM'}, 'York'), by_name({'CMSM'}, 'Toronto')
    grey, bruce_m = by_name({'CMSM'}, 'Grey'), by_name({'CMSM'}, 'Bruce')
    six_nations_host = by_name({'single'}, 'Brant')
    cases = [
        ('nested-interior', 'Brampton: lower tier inside Peel upper inside Peel CMSM', interior(by_name({'lower'}, 'Brampton')), 9),
        ('single-interior', 'Downtown Toronto: single tier = CMSM', Point(-79.3832, 43.6532), 9),
        ('north-single', 'Timmins: single tier inside Cochrane DSSAB', interior(by_name({'single'}, 'Timmins')), 9),
        ('unorganized', 'Unorganized Kenora district: DSSAB only, no municipality', Point(-88.0, 52.0), 6),
        ('renamed-cmsm', 'Strathroy-Caradoc: Middlesex upper, served by London CMSM', interior(by_name({'lower'}, 'Strathroy-Caradoc')), 9),
        ('haliburton', 'Haliburton county lower tier, served by Kawartha Lakes CMSM', interior(by_name({'lower'}, 'Dysart Et Al')), 9),
        ('carve-out', 'Sault Ste. Marie: carved out of Algoma district into its own DSSAB', interior(by_name({'single'}, 'Sault Ste. Marie')), 9),
        ('cross-district', 'West Nipissing: Sudbury district, Nipissing DSSAB', interior(by_name({'single'}, 'West Nipissing')), 9),
        ('border-lower', 'Mississauga / Brampton shared border (same upper, same CMSM)',
         shared_edge_point(by_name({'lower'}, 'Mississauga'), by_name({'lower'}, 'Brampton')), 9),
        ('border-cmsm', 'Toronto / Vaughan border: municipal and CMSM borders coincide',
         shared_edge_point(by_name({'single'}, 'Toronto'), by_name({'lower'}, 'Vaughan')), 9),
        ('triple-junction', 'Toronto / Vaughan / Brampton junction',
         junction([by_name({'single'}, 'Toronto'), by_name({'lower'}, 'Vaughan'), by_name({'lower'}, 'Brampton')]), 9),
        ('enclave', 'Guelph: single tier enclave, Wellington upper must NOT appear', interior(by_name({'single'}, 'Guelph')), 9),
        ('enclave-edge', 'Orillia / Severn border: enclave edge inside Simcoe',
         shared_edge_point(by_name({'single'}, 'Orillia'), by_name({'lower'}, 'Severn')), 9),
        ('reserve-south', 'Ohsweken, Six Nations of the Grand River: hole in both layers', Point(-80.1155, 43.0680), 9),
        ('enclave-hole', 'Largest hole in Brant County is the City of Brantford enclave', hole_point(six_nations_host), 9),
        ('reserve-north', 'Wikwemikong (Manitoulin): reserve hole', Point(-81.75, 45.78), 9),
        ('lake-municipal', 'Lake Ontario off Toronto: municipal water extent, no CMSM land', Point(-79.38, 43.55), 9),
        ('open-water', 'Middle of Lake Superior: no boundary', Point(-87.5, 47.6), 6),
        ('outside-quebec', 'Montreal, Quebec: outside Ontario', Point(-73.57, 45.50), 6),
        ('outside-michigan', 'Detroit, Michigan: outside Ontario', Point(-83.05, 42.33), 9),
        ('geometry-split', 'Hanover sliver the CMSM layer puts in Bruce (regulation: Grey)',
         piece_outside(by_name({'lower'}, 'Hanover'), bruce_m), 12),
        ('island', 'Pelee Island: single tier island, Windsor CMSM', interior(by_name({'single'}, 'Pelee')), 9),
        ('island-drift', 'Wolfe Island (Frontenac Islands): generalization drops CMSM coverage', Point(-76.33, 44.18), 9),
    ]
    parents = json.loads((DIST / 'parents.json').read_text())
    out = []
    for cid, note, pt, zoom in cases:
        contains, visible = stacks(pt.x, pt.y, zoom)
        border = cid.startswith(('border', 'triple', 'enclave-edge'))
        expected = visible if border else contains
        out.append({
            'id': cid, 'note': note, 'lng': round(pt.x, 6), 'lat': round(pt.y, 6), 'zoom': zoom,
            'contains': contains, 'visible': visible, 'border': border,
            'expected': [{'id': k, 'name': FEATS[k][0]['shortName'], 'tier': FEATS[k][0]['tier'],
                          'parent': parents.get(k)} for k in expected],
        })
        print(f"{cid:17} z{zoom} contains={contains} visible-extra={[k for k in visible if k not in contains]}")
    path = ROOT / 'tests' / 'fixtures' / 'points.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'strokePx': STROKE_PX, 'points': out}, indent=1))


if __name__ == '__main__':
    main()
