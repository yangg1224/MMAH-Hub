"""Download the ungeneralized source boundaries used to build and audit the parent table.

Outputs (tools/source/, git-ignored, large):
  lio-lower-single.geojson   LIO MUNIC_BND_LOWER_AND_SINGLE_FT (MapServer 14)
  lio-upper-district.geojson LIO MUNIC_BND_UPPER_AND_DIST (MapServer 13)
  cmsm-dssab.geojson         MMAH CMSM/DSSAB FeatureServer 0 (the 1.5 km bend-simplified copy is
                             the only public version; see its layer description)
"""
from pathlib import Path
import json
import requests

OUT = Path(__file__).parent / 'source'
LIO = 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open03/MapServer'
CMSM = 'https://services1.arcgis.com/LwvKNS3IAgAsnCih/ArcGIS/rest/services/CMSM/FeatureServer/0'
LAYERS = {
    'lio-lower-single.geojson': f'{LIO}/14',
    'lio-upper-district.geojson': f'{LIO}/13',
    'cmsm-dssab.geojson': CMSM,
    'lio-indian-reserve.geojson': f'{LIO}/12',
}


def fetch(url, page=200):
    session = requests.Session()
    ids = session.get(f'{url}/query', params={'where': '1=1', 'returnIdsOnly': 'true', 'f': 'json'}, timeout=120).json()
    oids = sorted(ids['objectIds'])
    features = []
    def get(chunk):
        response = session.get(f'{url}/query', params={
            'objectIds': ','.join(map(str, chunk)), 'outFields': '*', 'outSR': 4326, 'f': 'geojson',
        }, timeout=600)
        try:
            return response.json()['features']
        except (ValueError, KeyError):
            if len(chunk) == 1:
                raise RuntimeError(f'{url} object {chunk[0]}: {response.text[:200]}')
            half = len(chunk) // 2  # server rejects oversized responses; split and retry
            return get(chunk[:half]) + get(chunk[half:])

    for start in range(0, len(oids), page):
        features += get(oids[start:start + page])
        print(f'  {len(features)}/{len(oids)}')
    return {'type': 'FeatureCollection', 'features': features}


if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    for name, url in LAYERS.items():
        if (OUT / name).exists():
            continue
        print(name)
        (OUT / name).write_text(json.dumps(fetch(url, page=25 if 'lio' in name else 50)))
