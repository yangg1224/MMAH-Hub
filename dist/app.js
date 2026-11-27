'use strict';

const $ = (selector) => document.querySelector(selector);
const colours = { CMSM: '#9b8cff', DSSAB: '#5eb0d4', upper: '#e0b15a', lower: '#9cbf62', single: '#5ec4ae' };
const tierNames = { CMSM: 'CMSM', DSSAB: 'DSSAB', upper: 'Upper tier', lower: 'Lower tier', single: 'Single tier' };
const stackOrder = { CMSM: 0, DSSAB: 0, upper: 1, lower: 2, single: 2 };
const STROKE_PX = 3;
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

map.createPane('lift').style.zIndex = 450;
map.getPane('lift').style.pointerEvents = 'none';
const liftRenderer = L.svg({ pane: 'lift' });
const liftGroup = L.layerGroup().addTo(map);

const level = $('#level');
const datasets = new Map();
let entries = new Map();
let parents = {};
let levelVersion = 0;
function areaPlural() {
  if (level.value === 'both') return 'boundaries';
  return level.value === 'service' ? 'service areas' : 'municipalities';
}
let activeTier = 'all';
let selected;
let featureStates = new Map();
let stackHits = [];
let stackIndex = 0;
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
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function normalize(text) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
}

function style(tier, state) {
  const manager = tier === 'CMSM' || tier === 'DSSAB';
  if (level.value === 'both') {
    const color = manager ? '#f0c36a' : '#f4f1e8';
    if (state === 'selected') {
      return { color: '#ffffff', fillColor: '#ffffff', opacity: 1, weight: manager ? 4 : 3.2, dashArray: manager ? '8 6' : null, fill: true, fillOpacity: 0.22 };
    }
    if (state === 'parent') {
      return { color: '#ffd78a', fillColor: '#ffd78a', opacity: 1, weight: 3.2, dashArray: '8 6', fill: true, fillOpacity: 0.12 };
    }
    if (state === 'candidate') {
      return { color: '#ffffff', fillColor: color, opacity: 1, weight: manager ? 3.6 : 2.6, dashArray: manager ? '8 6' : null, fill: true, fillOpacity: 0.14 };
    }
    return {
      color, fillColor: color, opacity: 0.88,
      weight: manager ? 3.5 : 1.4,
      dashArray: manager ? '8 6' : null,
      fill: !manager, fillOpacity: 0.04
    };
  }
  const highlighted = state === 'selected' || state === 'candidate' || state === true;
  return {
    color: highlighted ? '#ffffff' : colours[tier],
    fillColor: highlighted ? '#ffffff' : colours[tier],
    weight: highlighted ? 3 : tier === 'upper' ? 1.65 : 1,
    opacity: highlighted ? 1 : 0.55,
    dashArray: !highlighted && tier === 'upper' ? '5 4' : null,
    fillOpacity: highlighted ? 0.34 : tier === 'upper' && activeTier === 'all' ? 0 : 0.06
  };
}

function liftStyle(role, tier) {
  const manager = tier === 'CMSM' || tier === 'DSSAB';
  if (role === 'selected') {
    return {
      color: '#ffffff', fillColor: '#fff7e8', weight: manager ? 5.5 : 4.5,
      opacity: 1, fillOpacity: 0.62, dashArray: manager ? '8 6' : null,
      className: reducedMotion() ? 'lift-static lift-selected' : 'lift-selected'
    };
  }
  return {
    color: '#c4841d', fillColor: '#f0c36a', weight: 3,
    opacity: 1, fillOpacity: 0.28, dashArray: '8 6',
    className: reducedMotion() ? 'lift-static lift-parent' : 'lift-parent'
  };
}

function applyFeatureStyles() {
  for (const entry of entries.values()) {
    entry.layer.setStyle(style(entry.tier, featureStates.get(entry.id) || false));
  }
}

function clearLift() {
  liftGroup.clearLayers();
}

function raiseOnMap(entry, role) {
  if (!entry) return;
  const layer = L.geoJSON(entry.feature, {
    renderer: liftRenderer,
    style: liftStyle(role, entry.tier),
    interactive: false
  });
  liftGroup.addLayer(layer);
}

function setFeatureState(id, state) {
  if (!id) return;
  if (state) featureStates.set(id, state);
  else featureStates.delete(id);
}

function clearOverlapState() {
  featureStates.clear();
  stackHits = [];
  stackIndex = 0;
  clearLift();
  applyFeatureStyles();
}

function select(entry, zoom) {
  clearOverlapState();
  if (selected) {
    selected.layer.setStyle(style(selected.tier, false));
    selected.button.removeAttribute('aria-current');
  }
  if (mapLabel) mapLabel.remove();
  selected = entry;
  selection.classList.remove('stack-panel');
  selection.replaceChildren();
  selection.hidden = !entry;
  selection.style.left = '';
  selection.style.bottom = '';
  selection.style.top = '';
  selection.style.right = '';
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
  entry.layer.setStyle(style(entry.tier, 'selected'));
  if (level.value !== 'both') entry.layer.bringToFront();
  entry.button.setAttribute('aria-current', 'true');
  if (zoom) {
    const bounds = entry.layer.getBounds();
    const targetZoom = Math.min(12, map.getBoundsZoom(bounds, false, [56, 145]));
    map.flyTo(bounds.getCenter(), targetZoom, {
      animate: !reducedMotion(),
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

function metresPerPixel(lat) {
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, map.getZoom());
}

function distanceToRing(ring, point) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0], ay = ring[j][1], bx = ring[i][0], by = ring[i][1];
    const dx = bx - ax, dy = by - ay;
    const length2 = dx * dx + dy * dy || 1;
    let t = ((point.lng - ax) * dx + (point.lat - ay) * dy) / length2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const midLat = (point.lat + py) / 2;
    const metres = Math.hypot((point.lng - px) * 111320 * Math.cos(midLat * Math.PI / 180), (point.lat - py) * 111320);
    if (metres < best) best = metres;
  }
  return best;
}

function distanceToGeometry(geometry, point) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best = Infinity;
  for (const rings of polygons) {
    for (const ring of rings) best = Math.min(best, distanceToRing(ring, point));
  }
  return best;
}

function hitsAt(point) {
  const radius = STROKE_PX * metresPerPixel(point.lat);
  const found = [];
  for (const entry of entries.values()) {
    if (!entry.layer.getBounds().pad(0.02).contains(point)) continue;
    if (containsPoint(entry.feature.geometry, point) || distanceToGeometry(entry.feature.geometry, point) <= radius) {
      found.push(entry);
    }
  }
  return found.sort((a, b) => stackOrder[a.tier] - stackOrder[b.tier] || a.shortName.localeCompare(b.shortName));
}

function placeStackNear(point) {
  const panel = $('.map-panel');
  const pixel = map.latLngToContainerPoint(point);
  const width = Math.min(360, panel.clientWidth - 24);
  const height = selection.offsetHeight || 180;
  let left = pixel.x + 14;
  let top = pixel.y - height / 2;
  if (left + width > panel.clientWidth - 12) left = pixel.x - width - 14;
  if (left < 12) left = 12;
  if (top < 12) top = 12;
  if (top + height > panel.clientHeight - 12) top = panel.clientHeight - height - 12;
  selection.style.left = left + 'px';
  selection.style.top = top + 'px';
  selection.style.bottom = 'auto';
  selection.style.right = 'auto';
}

function brushCandidate(entry) {
  for (const [id, state] of [...featureStates]) {
    if (state === 'candidate') featureStates.delete(id);
  }
  if (entry && featureStates.get(entry.id) !== 'selected' && featureStates.get(entry.id) !== 'parent') {
    featureStates.set(entry.id, 'candidate');
  }
  applyFeatureStyles();
  // Keep selected/parent drawn above candidates on the lift pane.
  const selectedId = [...featureStates].find(([, state]) => state === 'selected')?.[0];
  const parentId = [...featureStates].find(([, state]) => state === 'parent')?.[0];
  clearLift();
  if (parentId) raiseOnMap(entries.get(parentId), 'parent');
  if (selectedId) raiseOnMap(entries.get(selectedId), 'selected');
}

function promoteFromStack(entry) {
  for (const [id, state] of [...featureStates]) {
    if (state === 'selected' || state === 'parent' || state === 'candidate') featureStates.delete(id);
  }
  featureStates.set(entry.id, 'selected');
  const parentId = parents[entry.id];
  const parent = parentId && entries.get(parentId);
  if (parent && parent !== entry) featureStates.set(parent.id, 'parent');
  applyFeatureStyles();
  clearLift();
  if (!reducedMotion()) {
    if (parent && parent !== entry) raiseOnMap(parent, 'parent');
    raiseOnMap(entry, 'selected');
  }
  for (const option of selection.querySelectorAll('[role=option]')) {
    const current = option.dataset.id === entry.id;
    option.setAttribute('aria-selected', String(current));
    option.tabIndex = current ? 0 : -1;
  }
}

function focusStackOption(index) {
  if (!stackHits.length) return;
  stackIndex = (index + stackHits.length) % stackHits.length;
  const options = [...selection.querySelectorAll('[role=option]')];
  options.forEach((option, i) => { option.tabIndex = i === stackIndex ? 0 : -1; });
  options[stackIndex]?.focus();
  brushCandidate(stackHits[stackIndex]);
}

function closeStack() {
  clearOverlapState();
  selection.classList.remove('stack-panel');
  selection.replaceChildren();
  selection.hidden = true;
  selection.style.left = selection.style.top = selection.style.bottom = selection.style.right = '';
  map.getContainer().focus({ preventScroll: true });
}

function inspectOverlap(point) {
  const hits = hitsAt(point);
  if (!hits.length) return;
  if (selected) {
    selected.button.removeAttribute('aria-current');
    selected = undefined;
  }
  if (mapLabel) { mapLabel.remove(); mapLabel = undefined; }
  clearOverlapState();
  stackHits = hits;
  stackIndex = 0;
  selection.classList.add('stack-panel');
  selection.hidden = false;
  selection.replaceChildren();

  const heading = document.createElement('small');
  heading.id = 'stack-label';
  heading.textContent = 'Boundaries at this point';
  const listbox = document.createElement('div');
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-labelledby', 'stack-label');
  listbox.className = 'stack-list';

  hits.forEach((hit, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.dataset.id = hit.id;
    option.tabIndex = index === 0 ? 0 : -1;
    option.setAttribute('aria-selected', 'false');
    const name = document.createElement('strong');
    name.textContent = hit.shortName;
    const meta = document.createElement('span');
    const parentId = parents[hit.id];
    const parent = parentId && entries.get(parentId);
    const isManager = hit.tier === 'CMSM' || hit.tier === 'DSSAB';
    if (isManager) meta.textContent = tierNames[hit.tier];
    else if (parent) meta.textContent = tierNames[hit.tier] + ' · parent ' + parent.shortName;
    else meta.textContent = tierNames[hit.tier] + ' · no service manager parent';
    option.append(name, meta);
    option.addEventListener('mouseenter', () => { stackIndex = index; brushCandidate(hit); });
    option.addEventListener('focus', () => { stackIndex = index; brushCandidate(hit); });
    option.addEventListener('click', () => promoteFromStack(hit));
    listbox.append(option);
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close boundary stack');
  close.onclick = closeStack;

  selection.append(heading, listbox, close);
  placeStackNear(point);
  brushCandidate(hits[0]);
  listbox.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      focusStackOption(stackIndex + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusStackOption(stackIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusStackOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusStackOption(stackHits.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      promoteFromStack(stackHits[stackIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeStack();
    }
  });
  queueMicrotask(() => focusStackOption(0));
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
    entry.layer.setStyle(style(entry.tier, featureStates.get(entry.id) || (selected === entry && 'selected') || false));
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

map.getContainer().setAttribute('tabindex', '0');
map.on('click', (event) => {
  if (level.value !== 'both') return;
  // Layer clicks also fire map click; ignore when a path handled the pick.
  if (event.originalEvent?.target?.closest?.('.leaflet-interactive')) return;
  inspectOverlap(event.latlng);
});

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
    const entry = { feature, ...props, id: feature.id, item, button, layer, searchNames, searchText: searchNames.join(' ') };
    button.onclick = () => zoomTo(entry);
    layer.on('click', (event) => {
      L.DomEvent.stopPropagation(event);
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

async function loadParents() {
  try {
    const response = await fetch('parents.json');
    if (response.ok) parents = await response.json();
  } catch (error) {
    console.error(error);
  }
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
loadParents().then(() => showLevel(true));
