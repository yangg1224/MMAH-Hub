"""Combine the two Ontario GeoHub GeoJSON query exports into municipal features."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

TIERS = {
    'Upper Tier Municipality': 'upper',
    'Lower Tier Municipality': 'lower',
    'Single Tier Municipality': 'single',
}
EXPECTED = {'upper': 30, 'lower': 241, 'single': 173}


def combine(paths):
    municipalities = {}
    polygons = defaultdict(list)
    for path in paths:
        for feature in json.loads(path.read_text())['features']:
            props = feature['properties']
            tier = TIERS.get(props['MUNICIPAL_TYPE'])
            if tier is None:
                continue
            key = f"{tier}-{props['MUNID']}"
            municipalities[key] = {
                'name': props['MUNICIPAL_NAME'].title(),
                'shortName': props['MUNICIPAL_NAME_SHORTFORM'].title(),
                'tier': tier,
                'id': props['MUNID'],
            }
            geometry = feature['geometry']
            if geometry:
                if geometry['type'] == 'Polygon':
                    polygons[key].append(geometry['coordinates'])
                elif geometry['type'] == 'MultiPolygon':
                    polygons[key].extend(geometry['coordinates'])
                else:
                    raise ValueError(geometry['type'])
    counts = Counter(props['tier'] for props in municipalities.values())
    if counts != EXPECTED or any(not polygons[key] for key in municipalities):
        raise ValueError(f'Unexpected municipality coverage: {counts}')
    return {
        'type': 'FeatureCollection',
        'features': [
            {
                'type': 'Feature',
                'id': key,
                'properties': props,
                'geometry': {'type': 'MultiPolygon', 'coordinates': polygons[key]},
            }
            for key, props in sorted(municipalities.items(), key=lambda pair: pair[1]['shortName'])
        ],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('exports', type=Path, nargs=2)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = combine(args.exports)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    print(Counter(f['properties']['tier'] for f in data['features']))
