'use strict';

const $ = (selector) => document.querySelector(selector);
const colours = { CMSM: '#b6b0ff', DSSAB: '#81c8fa', upper: '#f3cb79', lower: '#c6f582', single: '#75dfce' };
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
const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 19
});
const boundaries = L.featureGroup().addTo(map);
const level = $('#level');
const datasets = new Map();
let entries = new Map();
let levelVersion = 0;
function areaPlural() {
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
const download = $('#download');

function normalize(text) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
}

function style(tier, highlighted) {
  return {
    color: highlighted ? '#e0ff99' : colours[tier],
    fillColor: highlighted ? '#c4ee73' : colours[tier],
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
  entry.layer.setStyle(style(entry.tier, true)).bringToFront();
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
  if (selected) selected.layer.bringToFront();
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
$('#basemap').onclick = (event) => {
  const wasSatellite = map.hasLayer(satellite);
  if (wasSatellite) regionalImagery.remove();
  else regionalImagery.addTo(map);
  map.removeLayer(wasSatellite ? satellite : dark);
  map.addLayer(wasSatellite ? dark : satellite);
  event.currentTarget.textContent = wasSatellite ? 'Dark map' : 'Satellite';
  event.currentTarget.setAttribute('aria-pressed', String(!wasSatellite));
};
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
    const entry = { ...props, item, button, layer, searchNames, searchText: searchNames.join(' ') };
    button.onclick = () => zoomTo(entry);
    layer.on('click', () => {
      select(entry, false);
      button.scrollIntoView({ block: 'nearest', container: 'nearest' });
    });
    records.set(feature.id, entry);
  }
  return { records, bounds };
}

const files = { municipal: 'municipalities.geojson', service: 'service-managers.geojson' };

async function showLevel(initialView = false) {
  const version = ++levelVersion;
  const key = level.value;
  const service = key === 'service';
  map.stop();
  select(undefined, false);
  entries = new Map();
  provinceBounds = undefined;
  boundaries.clearLayers();
  search.value = '';
  search.disabled = download.disabled = searchSubmit.disabled = true;
  clearSearch.hidden = true;
  list.replaceChildren();
  search.setAttribute('aria-label', service ? 'Search service manager by name' : 'Search municipality by name');
  list.setAttribute('aria-label', service ? 'Service managers' : 'Municipalities');
  $('.stats').hidden = service;
  $('#source-note').hidden = service;
  $('#manager-source').hidden = !service;
  status.textContent = 'Loading boundaries…';
  level.disabled = false;
  let dataset = datasets.get(key);
  try {
    if (!dataset) {
      dataset = await readLayer(files[key]);
      datasets.set(key, dataset);
    }
  } catch (error) {
    if (version === levelVersion) status.textContent = 'Boundaries could not be loaded. Switch layers or refresh to retry.';
    console.error(error);
    return;
  }
  if (version !== levelVersion) return;
  entries = dataset.records;
  provinceBounds = dataset.bounds;
  search.disabled = download.disabled = false;
  setTier('all');
  const initial = entries.get('lower-21024');
  if (initialView && initial) {
    map.fitBounds(initial.layer.getBounds(), { padding: [42, 62], maxZoom: 11, animate: false });
    select(initial, false);
  } else fitOntario();
}

level.onchange = () => showLevel();
download.onclick = () => {
  const link = document.createElement('a');
  link.href = files[level.value];
  link.download = 'ontario-' + files[level.value];
  link.click();
};
showLevel(true);
