'use strict';

const $ = (selector) => document.querySelector(selector);
const colours = { CMSM: '#9b8cff', DSSAB: '#5eb0d4', upper: '#e0b15a', lower: '#9cbf62', single: '#5ec4ae' };
const tierNames = { CMSM: 'CMSM', DSSAB: 'DSSAB', upper: 'Upper tier', lower: 'Lower tier', single: 'Single tier' };
const map = L.map('map', { zoomControl: false, preferCanvas: true, scrollWheelZoom: false })
  .setView([49.1, -85], 5);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
map.attributionControl.addAttribution('<a href="https://data.ontario.ca/dataset/municipal-boundaries">Land Information Ontario</a>');

// A georeferenced Esri overview keeps the opening satellite view available while tiles load.
map.createPane('regionalImagery').style.zIndex = 190;
const regionalImagery = L.imageOverlay('caledon-region.jpg', [[43.37985993018361, -80.99999999999996], [44.280137973118165, -78.83999999999997]], {
  pane: 'regionalImagery', interactive: false
}).addTo(map);
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Imagery © Esri and contributors', maxZoom: 16
}).addTo(map);
const boundaries = L.featureGroup().addTo(map);
const level = $('#level');
const datasets = new Map();
let entries = new Map();
let levelVersion = 0;
function areaPlural() {
  if (level.value === 'both') return 'boundaries';
  return level.value === 'service' ? 'service areas' : 'municipalities';
}
let activeTier = 'all';
let selected;
let mapLabel;
let provinceBounds;
const search = $('#search');
const searchSubmit = $('#search-submit');
const clearSearch = $('#clear-search');
const tierButtons = [...document.querySelectorAll('[data-tier]')];
let matches = [];
const status = $('#status');
const list = $('#list');
const selection = $('#selection');

function normalize(text) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
}

function style(tier, highlighted) {
  if (level.value === 'both') {
    const manager = tier === 'CMSM' || tier === 'DSSAB';
    const color = manager ? '#f0c36a' : '#f4f1e8';
    return {
      color, fillColor: color, opacity: highlighted ? 1 : 0.88,
      weight: manager ? 3.5 : highlighted ? 3 : 1.4,
      dashArray: manager ? '8 6' : null,
      fill: !manager || highlighted, fillOpacity: highlighted ? 0.2 : 0.04
    };
  }
  return {
    color: highlighted ? '#ffffff' : colours[tier],
    fillColor: highlighted ? '#ffffff' : colours[tier],
    weight: highlighted ? 3 : tier === 'upper' ? 1.65 : 1,
    opacity: highlighted ? 1 : 0.55,
    dashArray: !highlighted && tier === 'upper' ? '5 4' : null,
    fillOpacity: highlighted ? 0.34 : tier === 'upper' && activeTier === 'all' ? 0 : 0.06
  };
}

function select(entry, zoom) {
  if (selected) {
    selected.layer.setStyle(style(selected.tier, false));
    selected.button.removeAttribute('aria-current');
  }
  if (mapLabel) mapLabel.remove();
  selected = entry;
  selection.replaceChildren();
  selection.hidden = !entry;
  if (!entry) return;
  const title = document.createElement('strong');
  title.textContent = entry.shortName;
  const tierLabel = document.createElement('small');
  tierLabel.textContent = tierNames[entry.tier];
  const center = entry.layer.getBounds().getCenter();
  const labelText = document.createElement('span');
  labelText.textContent = entry.shortName;
  mapLabel = L.tooltip({ permanent: true, direction: 'center', className: 'map-name' })
    .setLatLng(center).setContent(labelText).addTo(map);
  const detail = document.createElement('div');
  detail.textContent = center.lat.toFixed(3) + '° N · ' + Math.abs(center.lng).toFixed(3) + '° W';
  const clear = document.createElement('button');
  clear.textContent = '×';
  clear.setAttribute('aria-label', 'Clear selection');
  clear.onclick = () => select(undefined, false);
  selection.append(tierLabel, title, detail, clear);
  entry.layer.setStyle(style(entry.tier, true));
  if (level.value !== 'both') entry.layer.bringToFront();
  entry.button.setAttribute('aria-current', 'true');
  if (zoom) {
    const bounds = entry.layer.getBounds();
    const center = bounds.getCenter();
    const targetZoom = Math.min(12, map.getBoundsZoom(bounds, false, [56, 145]));
    map.flyTo(center, targetZoom, {
      animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      duration: 0.65
    });
  }
}

// GeoJSON polygon rings use longitude, latitude. Interior rings are holes.
function containsPoint(geometry, point) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  function inRing(ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x, y] = ring[i];
      const [previousX, previousY] = ring[j];
      if ((y > point.lat) !== (previousY > point.lat) &&
          point.lng < (previousX - x) * (point.lat - y) / (previousY - y) + x) inside = !inside;
    }
    return inside;
  }
  return polygons.some(([outer, ...holes]) => inRing(outer) && !holes.some(inRing));
}

function inspectOverlap(point) {
  const hits = [...entries.values()].filter(entry =>
    entry.layer.getBounds().contains(point) && containsPoint(entry.feature.geometry, point));
  if (!hits.length) return;
  select(undefined, false);
  selection.hidden = false;
  const heading = document.createElement('small');
  heading.textContent = 'Boundaries at this point';
  const names = document.createElement('div');
  for (const hit of hits) {
    const line = document.createElement('p');
    line.textContent = hit.shortName + ' · ' + tierNames[hit.tier];
    names.append(line);
  }
  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close boundary details');
  close.onclick = () => select(undefined, false);
  selection.append(heading, names, close);
}

function renderResults() {
  const query = normalize(search.value);
  const terms = query.split(' ');
  matches = [...entries.values()].filter((entry) =>
    (query || activeTier === 'all' || entry.tier === activeTier) &&
    terms.every((term) => entry.searchText.includes(term)));

  if (query) {
    const rank = (entry) => {
      if (entry.searchNames.includes(query)) return 0;
      if (entry.searchNames.some((name) => name.startsWith(query))) return 1;
      return 2;
    };
    matches.sort((a, b) => rank(a) - rank(b));
  }

  list.replaceChildren(...matches.map((entry) => entry.item));
  list.scrollTop = 0;
  clearSearch.hidden = search.value.length === 0;
  searchSubmit.disabled = !query || !matches.length;
  status.textContent = matches.length
    ? query
      ? matches.length + (matches.length === 1 ? ' match. ' : ' matches. ') + 'Select a result to zoom.'
      : 'Showing ' + matches.length + ' of ' + entries.size + ' ' + areaPlural()
    : 'No ' + areaPlural() + ' found. Try another name.';
}

function renderMap() {
  const visible = [...entries.values()].filter((entry) => activeTier === 'all' || entry.tier === activeTier);
  if (selected && !visible.includes(selected)) select(undefined, false);
  boundaries.clearLayers();
  // Upper-tier boundaries sit underneath local municipalities so both tiers remain discoverable.
  const drawingOrder = [...visible].sort((a, b) => Number(b.tier === 'upper') - Number(a.tier === 'upper'));
  for (const entry of drawingOrder) {
    entry.layer.setStyle(style(entry.tier, selected === entry));
    boundaries.addLayer(entry.layer);
  }
  if (selected && level.value !== 'both') selected.layer.bringToFront();
}

function setTier(tier) {
  activeTier = tier;
  for (const button of tierButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.tier === tier));
  }
  renderMap();
  renderResults();
}

function zoomTo(entry) {
  if (activeTier !== 'all' && activeTier !== entry.tier) setTier('all');
  select(entry, true);
  if (window.matchMedia('(max-width: 760px)').matches) {
    $('.map-panel').scrollIntoView({ block: 'start' });
  }
}

function fitOntario() {
  if (provinceBounds) map.fitBounds(provinceBounds, { padding: [18, 18] });
}

$('#reset').onclick = () => { select(undefined, false); fitOntario(); };
search.addEventListener('input', renderResults);
$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!searchSubmit.disabled) zoomTo(matches[0]);
});
clearSearch.onclick = () => {
  search.value = '';
  renderResults();
  select(undefined, false);
  fitOntario();
  search.focus();
};
for (const button of tierButtons) {
  button.onclick = () => { if (entries.size) setTier(button.dataset.tier); };
}

async function readLayer(filename) {
  const response = await fetch(filename);
  if (!response.ok) throw new Error('Boundary download returned ' + response.status);
  const data = await response.json();
  const records = new Map();
  const bounds = L.latLngBounds([]);
  for (const feature of data.features) {
    const props = feature.properties;
    const layer = L.geoJSON(feature, { style: style(props.tier, false) });
    bounds.extend(layer.getBounds());
    const item = document.createElement('li');
    const button = document.createElement('button');
    const label = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = props.tier;
    label.append(dot, props.shortName);
    const tier = document.createElement('small');
    tier.textContent = tierNames[props.tier];
    button.append(label, tier);
    item.append(button);
    const searchNames = [props.shortName, props.name].map(normalize);
    const entry = { feature, ...props, item, button, layer, searchNames, searchText: searchNames.join(' ') };
    button.onclick = () => zoomTo(entry);
    layer.on('click', (event) => {
      if (level.value === 'both') {
        inspectOverlap(event.latlng);
        return;
      }
      select(entry, false);
      button.scrollIntoView({ block: 'nearest', container: 'nearest' });
    });
    records.set(feature.id, entry);
  }
  return { records, bounds };
}

const files = { municipal: 'municipalities.geojson', service: 'service-managers.geojson' };

async function getDataset(key) {
  if (!datasets.has(key)) {
    datasets.set(key, readLayer(files[key]).catch(error => {
      datasets.delete(key);
      throw error;
    }));
  }
  return datasets.get(key);
}

async function showLevel(initialView = false) {
  const version = ++levelVersion;
  const key = level.value;
  const service = key === 'service';
  const both = key === 'both';
  const keys = both ? ['municipal', 'service'] : [key];
  map.stop();
  select(undefined, false);
  entries = new Map();
  provinceBounds = undefined;
  boundaries.clearLayers();
  search.value = '';
  search.disabled = searchSubmit.disabled = true;
  clearSearch.hidden = true;
  list.replaceChildren();
  search.setAttribute('aria-label', both ? 'Search municipalities and service managers' : service ? 'Search service manager by name' : 'Search municipality by name');
  list.setAttribute('aria-label', both ? 'Municipalities and service managers' : service ? 'Service managers' : 'Municipalities');
  $('.stats').hidden = service || both;
  $('#source-note').hidden = service;
  $('#manager-source').hidden = key === 'municipal';
  $('#overlap-legend').hidden = !both;
  status.textContent = 'Loading boundaries…';
  level.disabled = false;
  let loaded;
  try {
    loaded = await Promise.all(keys.map(getDataset));
  } catch (error) {
    if (version === levelVersion) status.textContent = 'Boundaries could not be loaded. Switch layers or refresh to retry.';
    console.error(error);
    return;
  }
  if (version !== levelVersion) return;
  provinceBounds = L.latLngBounds([]);
  for (const dataset of loaded) {
    provinceBounds.extend(dataset.bounds);
    for (const [id, record] of dataset.records) entries.set(id, record);
  }
  search.disabled = false;
  setTier('all');
  const initial = entries.get('lower-21024');
  if (initialView && initial) {
    const openingArea = [...entries.values()].find(entry => entry.tier === 'CMSM' && entry.shortName === 'Peel') || initial;
    map.fitBounds(openingArea.layer.getBounds(), { padding: [42, 62], maxZoom: 11, animate: false });
    select(initial, false);
  } else if (initialView) fitOntario();
}

level.onchange = () => showLevel();
showLevel(true);
