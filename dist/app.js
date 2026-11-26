'use strict';

const $ = (selector) => document.querySelector(selector);
const colours = { upper: '#f3cb79', lower: '#c6f582', single: '#75dfce' };
const tierNames = { upper: 'Upper tier', lower: 'Lower tier', single: 'Single tier' };
const map = L.map('map', { zoomControl: false, preferCanvas: true, scrollWheelZoom: false })
  .setView([49.1, -85], 5);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
map.attributionControl.addAttribution('<a href="https://data.ontario.ca/dataset/municipal-boundaries">Land Information Ontario</a>');

const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Imagery © Esri and contributors', maxZoom: 16
}).addTo(map);
const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 19
});
const boundaries = L.featureGroup().addTo(map);
const entries = new Map();
let activeTier = 'all';
let selected;
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
    color: highlighted ? '#fff3bc' : colours[tier],
    fillColor: colours[tier],
    weight: highlighted ? 3 : tier === 'upper' ? 1.65 : 1,
    opacity: 0.92,
    dashArray: !highlighted && tier === 'upper' ? '5 4' : null,
    fillOpacity: highlighted ? 0.34 : tier === 'upper' && activeTier === 'all' ? 0 : 0.17
  };
}

function select(entry, zoom) {
  if (selected) {
    selected.layer.setStyle(style(selected.tier, false));
    selected.button.removeAttribute('aria-current');
  }
  selected = entry;
  selection.replaceChildren();
  selection.hidden = !entry;
  if (!entry) return;
  const title = document.createElement('strong');
  title.textContent = entry.name;
  const detail = document.createElement('div');
  detail.textContent = tierNames[entry.tier] + ' · Municipal ID ' + entry.id;
  const clear = document.createElement('button');
  clear.textContent = 'Clear selection';
  clear.onclick = () => select(undefined, false);
  selection.append(title, detail, clear);
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
      : 'Showing ' + matches.length + ' of ' + entries.size + ' municipalities'
    : 'No municipalities found. Try another name.';
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

$('#reset').onclick = fitOntario;
$('#basemap').onclick = (event) => {
  const wasSatellite = map.hasLayer(satellite);
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

async function load() {
  const response = await fetch('municipalities.geojson');
  if (!response.ok) throw new Error('Boundary download returned ' + response.status);
  const data = await response.json();
  provinceBounds = L.latLngBounds([]);
  for (const feature of data.features) {
    const props = feature.properties;
    const layer = L.geoJSON(feature, { style: style(props.tier, false) });
    provinceBounds.extend(layer.getBounds());
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
    entries.set(feature.id, entry);
  }
  download.disabled = false;
  download.onclick = () => {
    const link = document.createElement('a');
    link.href = 'municipalities.geojson';
    link.download = 'ontario-municipal-boundaries.geojson';
    link.click();
  };
  search.disabled = false;
  renderResults();
  renderMap();
  fitOntario();
}

load().catch((error) => {
  console.error(error);
  status.textContent = 'Boundaries could not be loaded. Refresh to try again.';
});
