import { searchOpenAlex, placeInstitutions, applyInstitutionPlaces, searchGitHub, searchHN, githubOwnerLocation, geocode } from './sources.js';
import { findConvergences, caption, distinctPlaces } from './cluster.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => innerWidth <= 760;

const state = {
  countries: {}, instCache: {}, ownerCache: {}, discoveries: null, topics: [],
  quiet: true, quietQueue: [], quietIdx: 0, quietTimer: null,
  current: null,  // { title, kicker, convergences, loose, status }
  active: -1, arcs: [], interacting: false, lastInteract: 0, searchSeq: 0,
};
window.__notTheOnlyOne = state; // for debugging in the console

// ---------- map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    projection: { type: 'globe' },
    sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.85, 4, 0.3, 7, 0] },
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#070c17' } }],
  },
  center: [20, 22], zoom: isMobile() ? 0.35 : 1.15, attributionControl: false, maxPitch: 0, renderWorldCopies: false,
});
state.map = map;
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Natural Earth · OpenAlex · GitHub · Hacker News · arXiv · Photon/OSM' }), 'bottom-right');
map.dragRotate.disable(); map.touchZoomRotate.disableRotation();
['mousedown', 'touchstart', 'wheel'].forEach(ev => map.getCanvasContainer().addEventListener(ev, () => { state.lastInteract = performance.now(); }, { passive: true }));

const empty = () => ({ type: 'FeatureCollection', features: [] });

map.on('load', async () => {
  const [countriesGeo] = await Promise.all([fetch('data/countries.geojson').then(r => r.json())]);
  for (const f of countriesGeo.features) state.countries[f.properties.a2] = f.properties;
  map.setSky?.({ 'sky-color': '#060a14', 'horizon-color': '#1b2a4a', 'fog-color': '#04060b', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.8, 'fog-ground-blend': 0.9, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.35, 8, 0] });
  map.addSource('countries', { type: 'geojson', data: countriesGeo });
  map.addLayer({ id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': '#111b30', 'fill-opacity': 1 } });
  map.addLayer({ id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': '#24324f', 'line-width': 0.6 } });
  map.addSource('field', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'field', type: 'circle', source: 'field', paint: { 'circle-radius': 1.8, 'circle-color': '#8d93a3', 'circle-opacity': 0.35, 'circle-pitch-alignment': 'map' } });
  map.addSource('threads', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'threads-glow', type: 'line', source: 'threads', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffd9a0', 'line-width': 6, 'line-blur': 6, 'line-opacity': ['*', 0.16, ['get', 'w']] } });
  map.addLayer({ id: 'threads', type: 'line', source: 'threads', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffe6c2', 'line-width': 1.1, 'line-opacity': ['*', 0.6, ['get', 'w']] } });
  map.addSource('sparks', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'sparks', type: 'circle', source: 'sparks', paint: { 'circle-radius': 3, 'circle-blur': 0.9, 'circle-color': '#fff2dc', 'circle-opacity': ['get', 'o'], 'circle-pitch-alignment': 'map' } });
  map.addSource('efforts', { type: 'geojson', data: empty() });
  const kindColor = ['match', ['get', 'kind'], 'paper', '#ffd9a0', 'preprint', '#c7b6ff', 'repo', '#8fe3d4', 'discussion', '#ff9e8a', '#e9e4da'];
  map.addLayer({ id: 'efforts-halo', type: 'circle', source: 'efforts', paint: { 'circle-radius': ['case', ['get', 'on'], 16, 7], 'circle-blur': 1, 'circle-color': kindColor, 'circle-opacity': ['case', ['get', 'on'], 0.35, 0.08], 'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'efforts', type: 'circle', source: 'efforts', paint: { 'circle-radius': ['case', ['get', 'on'], 4.2, 2.4], 'circle-color': kindColor, 'circle-opacity': ['case', ['get', 'on'], 1, 0.4], 'circle-stroke-color': '#04060b', 'circle-stroke-width': ['case', ['get', 'on'], 1, 0], 'circle-pitch-alignment': 'map' } });

  map.on('mousemove', 'efforts', (e) => {
    const f = e.features[0]; if (!f) return;
    map.getCanvas().style.cursor = 'pointer';
    const p = f.properties; const tip = $('tip');
    tip.innerHTML = `<div>${esc(p.title)}</div><div class="m">${esc(p.sourceLabel)} · ${esc(p.dateLabel)} ${esc(fmtDate(p.date))}<br>${esc(p.where)}</div>`;
    tip.hidden = false;
    const x = Math.min(e.originalEvent.clientX + 14, innerWidth - 320);
    tip.style.left = x + 'px'; tip.style.top = (e.originalEvent.clientY + 14) + 'px';
  });
  map.on('mouseleave', 'efforts', () => { map.getCanvas().style.cursor = ''; $('tip').hidden = true; });
  map.on('click', 'efforts', (e) => {
    const p = e.features[0]?.properties; if (!p) return;
    if (p.conv >= 0 && p.conv !== state.active) { stopQuiet(); focusConvergence(p.conv); }
    else if (p.url) window.open(p.url, '_blank', 'noopener');
  });

  requestAnimationFrame(tick);
  await boot();
});

// ---------- geometry ----------
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function toVec(lon, lat) { const a = rad(lat), b = rad(lon); return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]; }
function toLonLat(v) { const n = Math.hypot(...v); return [deg(Math.atan2(v[1], v[0])), deg(Math.asin(v[2] / n))]; }
function angle(a, b) { const va = toVec(...a), vb = toVec(...b); return Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]))); }
function arc(a, b, steps = 96) {
  const va = toVec(...a), vb = toVec(...b), om = angle(a, b);
  if (om < 1e-4) return null;
  const pts = []; let prevLon = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, s1 = Math.sin((1 - t) * om) / Math.sin(om), s2 = Math.sin(t * om) / Math.sin(om);
    let [lon, lat] = toLonLat([s1 * va[0] + s2 * vb[0], s1 * va[1] + s2 * vb[1], s1 * va[2] + s2 * vb[2]]);
    if (prevLon != null) { while (lon - prevLon > 180) lon -= 360; while (lon - prevLon < -180) lon += 360; }
    prevLon = lon; pts.push([lon, lat]);
  }
  // MapLibre cannot draw beyond ~85° latitude, so split arcs that pass near a pole into pieces around it
  const segs = []; let cur = [];
  for (const p of pts) {
    if (Math.abs(p[1]) > 84.8) { if (cur.length > 1) segs.push(cur); cur = []; continue; }
    if (!cur.length && segs.length) { let lon = p[0]; const ref = segs[segs.length - 1].at(-1)[0]; while (lon - ref > 180) lon -= 360; while (lon - ref < -180) lon += 360; p[0] = lon; }
    cur.push(p);
  }
  if (cur.length > 1) segs.push(cur);
  return segs.length ? segs : null;
}
function viewFor(points) {
  if (!points.length) return { center: [20, 20], zoom: 1 };
  const s = [0, 0, 0]; for (const p of points) { const v = toVec(p[0], p[1]); s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; }
  const c = Math.hypot(...s) < 1e-6 ? points[0] : toLonLat(s);
  let spread = 0; for (const p of points) spread = Math.max(spread, deg(angle(c, p)));
  const z = spread > 100 ? 0.55 : spread > 70 ? 0.85 : spread > 45 ? 1.4 : spread > 25 ? 1.95 : spread > 12 ? 2.5 : spread > 5 ? 3.1 : 3.6;
  // MapLibre's globe keeps Mercator zoom semantics, so the globe looks larger at high latitudes; compensate.
  const latFix = Math.log2(Math.cos(rad(Math.min(Math.abs(c[1]), 80))));
  const zz = z + latFix;
  return { center: c, zoom: Math.max(isMobile() ? -1.2 : -0.6, isMobile() ? zz - 1.1 : zz) };
}

// ---------- animation ----------
let lastSpark = 0;
function tick(t) {
  requestAnimationFrame(tick);
  if (!map.isStyleLoaded()) return;
  if (!reduceMotion && t - lastSpark > 40) {
    lastSpark = t;
    const feats = [];
    state.arcs.forEach((a, i) => {
      const period = 5200 + (i % 4) * 900;
      const ph = ((t + i * 1700) % period) / period;
      const idx = Math.floor(ph * (a.length - 1));
      const o = Math.sin(ph * Math.PI) * 0.95;
      feats.push({ type: 'Feature', properties: { o }, geometry: { type: 'Point', coordinates: a[idx] } });
    });
    map.getSource('sparks')?.setData({ type: 'FeatureCollection', features: feats });
    // a slow drift of the globe while nobody is touching it
    if (!map.isMoving() && t - state.lastInteract > 9000 && !state.flying) {
      const c = map.getCenter(); map.setCenter([c.lng + 0.012, c.lat]);
    }
  }
}

// ---------- rendering ----------
function placeText(m) {
  const p = m.place;
  if (!p) return m.source === 'github' ? 'Location not public on their profile' : m.source === 'hn' ? 'Hacker News does not list a place' : 'Institution location not listed';
  if (p.precision === 'country') return `${p.label && p.label !== p.countryName ? p.label + ', ' : ''}${p.countryName} (country only)`;
  if (p.precision === 'profile') return `${p.city || p.label}${p.countryName ? ', ' + p.countryName : ''} (from public profile)`;
  return `${p.label ? p.label + ', ' : ''}${p.city || ''}${p.countryName && p.city ? ', ' : ''}${p.city ? p.countryName || '' : p.countryName || ''}`;
}

function setEfforts() {
  const cur = state.current; if (!cur) return;
  const feats = [];
  cur.convergences.forEach((c, ci) => c.members.forEach(m => {
    if (!m.place) return;
    feats.push({ type: 'Feature', properties: { kind: m.kind, title: m.title, url: m.url, date: m.date, dateLabel: m.dateLabel, sourceLabel: m.sourceLabel, where: placeText(m), conv: ci, on: ci === state.active }, geometry: { type: 'Point', coordinates: [m.place.lon, m.place.lat] } });
  }));
  map.getSource('efforts')?.setData({ type: 'FeatureCollection', features: feats });
  const field = (cur.field || []).map(p => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
  map.getSource('field')?.setData({ type: 'FeatureCollection', features: field });
}

let labelMarkers = [];
function setThreads(ci) {
  const c = state.current?.convergences[ci];
  labelMarkers.forEach(m => m.remove()); labelMarkers = [];
  state.arcs = [];
  const feats = [];
  if (c) {
    const pts = [];
    for (const m of c.members) if (m.place && !pts.some(p => Math.abs(p[0] - m.place.lon) < 0.05 && Math.abs(p[1] - m.place.lat) < 0.05)) pts.push([m.place.lon, m.place.lat]);
    const pairs = [];
    if (pts.length <= 4) { for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) pairs.push([pts[i], pts[j]]); }
    else for (let i = 0; i + 1 < pts.length; i++) pairs.push([pts[i], pts[i + 1]]);
    for (const [a, b] of pairs) { const g = arc(a, b); if (g) { state.arcs.push(g.flat()); feats.push({ type: 'Feature', properties: { w: 1 }, geometry: { type: 'MultiLineString', coordinates: g } }); } }
    const named = new Set();
    for (const m of c.members) {
      if (!m.place) continue;
      const label = m.place.city || m.place.countryName; if (!label || named.has(label)) continue; named.add(label);
      const el = document.createElement('div'); el.className = 'place-label'; el.textContent = label;
      labelMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([m.place.lon, m.place.lat]).addTo(map));
      setTimeout(() => el.classList.add('on'), 900);
    }
    const v = viewFor(pts.length ? pts : [[20, 20]]);
    state.flying = true;
    map.flyTo({ center: v.center, zoom: v.zoom, duration: reduceMotion ? 0 : 4200, curve: 1.2, essential: true, padding: padding() });
    map.once('moveend', () => { state.flying = false; });
  }
  map.getSource('threads')?.setData({ type: 'FeatureCollection', features: feats });
}
function padding() {
  if (isMobile()) return { top: 250, bottom: ($('panel').classList.contains('collapsed') ? 80 : innerHeight * 0.42) + 150, left: 30, right: 30 };
  return { top: 60, bottom: 200, left: 60, right: 440 };
}

function setCaption(topic, main, terms) {
  const el = $('caption');
  el.classList.add('fade');
  setTimeout(() => {
    $('captionTopic').textContent = topic || '';
    $('captionMain').textContent = main || '';
    $('captionTerms').textContent = terms || '';
    el.classList.remove('fade');
  }, reduceMotion ? 0 : 700);
}

function memberHTML(m) {
  const extra = m.kind === 'repo' ? [m.language, m.stars != null ? `★ ${m.stars}` : ''].filter(Boolean).join(' · ')
    : m.kind === 'discussion' ? (m.points != null ? `${m.points} points` : '')
    : [m.venue, m.nAuthors ? `${m.nAuthors} author${m.nAuthors > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
  const approx = m.place && m.place.precision !== 'institution' ? ' approx' : '';
  return `<div class="member"><span class="k ${m.kind}"></span><div>
    <a class="t" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>
    ${m.description ? `<div class="m">${esc(m.description.slice(0, 160))}</div>` : ''}
    <div class="m">${esc(m.sourceLabel)} · ${esc(m.dateLabel)} ${esc(fmtDate(m.date))}${extra ? ' · ' + esc(extra) : ''}</div>
    <div class="m${approx}">${esc(placeText(m))}</div></div></div>`;
}

function renderPanel() {
  const cur = state.current; if (!cur) return;
  $('panelKicker').textContent = cur.kicker;
  $('panelTitle').textContent = cur.title;
  $('sources').innerHTML = (cur.status || []).map(s => `<span class="src ${s.cls}" title="${esc(s.title || '')}"><i></i>${esc(s.label)}</span>`).join('');
  let html = '';
  if (cur.message) html += `<p class="note">${cur.message}</p>`;
  cur.convergences.forEach((c, i) => {
    html += `<div class="conv${i === state.active ? ' active' : ''}" data-i="${i}">
      <h3>${esc(c.caption)}</h3>
      ${c.terms?.length ? `<p class="terms">Shared ground: ${esc(c.terms.join(' · '))}</p>` : ''}
      ${c.members.map(memberHTML).join('')}
      <p class="consent">No shared authors or owners between these. Introductions: coming later, only with everyone's consent.${cur.query ? ` <a href="?seen=${encodeURIComponent(cur.query)}&i=${i}">Link to this</a>` : ''}</p>
    </div>`;
  });
  if (cur.loose?.length) {
    html += `<p class="sec">Also working on this, no close match yet</p>`;
    html += cur.loose.slice(0, 12).map(m => `<div class="loose"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a><div class="m" style="color:var(--faint);font-size:11px;margin-top:2px">${esc(m.sourceLabel)} · ${esc(fmtDate(m.date))}${m.place ? ' · ' + esc(m.place.city || m.place.countryName || '') : ''}</div></div>`).join('');
  }
  $('panelBody').innerHTML = html;
  $('panelBody').querySelectorAll('.conv').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    stopQuiet(); focusConvergence(+el.dataset.i);
  }));
}

function focusConvergence(i, { scroll = true } = {}) {
  state.active = i;
  const c = state.current.convergences[i];
  setEfforts(); setThreads(i);
  if (c) setCaption(state.current.captionTopic || state.current.title, c.caption, c.terms?.length ? 'Shared ground: ' + c.terms.join(' · ') : '');
  $('panelBody').querySelectorAll('.conv').forEach(el => el.classList.toggle('active', +el.dataset.i === i));
  if (scroll) $('panelBody').querySelector(`.conv[data-i="${i}"]`)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
}

// ---------- quiet discovery ----------
function buildQuietQueue() {
  const q = [];
  for (const t of state.discoveries?.topics || []) t.convergences.forEach((c, i) => { if (distinctPlaces(c.members.map(m => m.place).filter(Boolean)).length >= 2) q.push({ t, i }); });
  // interleave topics so it never dwells on one subject
  const byTopic = new Map(); for (const x of q) { const k = x.t.query; if (!byTopic.has(k)) byTopic.set(k, []); byTopic.get(k).push(x); }
  const lists = [...byTopic.values()];
  const day = Math.floor(Date.now() / 86400000); const rot = lists.length ? day % lists.length : 0;
  const ordered = lists.slice(rot).concat(lists.slice(0, rot));
  const out = []; for (let r = 0; r < 4; r++) for (const l of ordered) if (l[r]) out.push(l[r]);
  state.quietQueue = out;
}
function showDiscoveryTopic(t, i) {
  const st = state.discoveries;
  state.current = {
    kicker: state.quiet ? 'Quiet discovery' : 'From the weekly sweep',
    title: t.topic, captionTopic: t.topic, query: t.query,
    convergences: t.convergences,
    status: statusFromSaved(t.status, st.generatedAt),
    message: `Found in a sweep of public sources on ${esc(new Date(st.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}. <a href="?q=${encodeURIComponent(t.query)}" data-live="${esc(t.query)}">Search this live</a>.`,
    loose: [],
  };
  state.active = i;
  renderPanel();
  $('panelBody').querySelector('[data-live]')?.addEventListener('click', (e) => { e.preventDefault(); runSearch(t.query); });
  focusConvergence(i);
}
function statusFromSaved(s, at) {
  const names = { openalex: 'OpenAlex', github: 'GitHub', hn: 'Hacker News', arxiv: 'arXiv' };
  return Object.entries(s || {}).map(([k, v]) => ({ label: v.ok ? `${names[k]} ${v.n}` : `${names[k]} unavailable`, cls: v.ok ? 'ok' : 'bad', title: v.ok ? `${v.n} of ${v.total} recent records read` : v.error }));
}
function quietStep() {
  if (!state.quiet || !state.quietQueue.length) return;
  const x = state.quietQueue[state.quietIdx % state.quietQueue.length];
  state.quietIdx++;
  showDiscoveryTopic(x.t, x.i);
  clearTimeout(state.quietTimer);
  state.quietTimer = setTimeout(quietStep, reduceMotion ? 20000 : 15000);
}
function startQuiet() {
  state.quiet = true; $('quietBtn').setAttribute('aria-pressed', 'true'); $('quietLabel').textContent = 'Quiet discovery is playing';
  history.replaceState(null, '', location.pathname);
  quietStep();
}
function stopQuiet() {
  if (!state.quiet) return;
  state.quiet = false; clearTimeout(state.quietTimer);
  $('quietBtn').setAttribute('aria-pressed', 'false'); $('quietLabel').textContent = 'Play quiet discovery';
  if (state.current) $('panelKicker').textContent = state.current.kicker === 'Quiet discovery' ? 'From the weekly sweep' : state.current.kicker;
}

// ---------- live search ----------
async function runSearch(query) {
  query = query.trim().slice(0, 120); if (!query) return;
  stopQuiet();
  const seq = ++state.searchSeq;
  $('askInput').value = query;
  history.replaceState(null, '', '?q=' + encodeURIComponent(query));
  const btn = document.querySelector('.ask button'); btn.disabled = true; btn.textContent = 'Listening…';
  const status = { openalex: { label: 'OpenAlex', cls: 'wait' }, github: { label: 'GitHub', cls: 'wait' }, hn: { label: 'Hacker News', cls: 'wait' } };
  state.current = { kicker: 'Live search · last 12 months', title: `“${query}”`, captionTopic: query, convergences: [], loose: [], status: Object.values(status), message: 'Asking public sources who else is working on this…' };
  state.active = -1; renderPanel(); setThreads(-1); setEfforts();
  setCaption(query, 'Listening for others working on this…', '');
  const all = [];
  const notes = [];
  const run = async (key, fn, fail) => {
    try {
      const r = await fn();
      all.push(...r.efforts);
      status[key] = { label: `${status[key].label} ${r.efforts.length}`, cls: 'ok', title: `${r.efforts.length} of ${r.total} recent records read` };
    } catch (e) {
      status[key] = { label: `${status[key].label} unavailable`, cls: 'bad', title: String(e.message) };
      notes.push(fail(e));
    }
    if (seq === state.searchSeq) { state.current.status = Object.values(status); renderPanel(); }
  };
  await Promise.all([
    run('openalex', () => searchOpenAlex(query), (e) => e.status === 429 ? 'OpenAlex has used up its free daily allowance for your network, so papers are missing for now.' : 'OpenAlex did not answer, so papers are missing for now.'),
    run('github', () => searchGitHub(query), (e) => (e.status === 403 || e.status === 429) ? 'GitHub allows ten searches a minute without signing in, so repositories are resting. Try again in a minute.' : 'GitHub did not answer, so repositories are missing for now.'),
    run('hn', () => searchHN(query), () => 'Hacker News search did not answer.'),
  ]);
  if (seq !== state.searchSeq) return;
  const seen = new Set(); const efforts = [];
  for (const e of all) { const k = e.title.toLowerCase().replace(/[^a-z0-9]/g, ''); if (seen.has(k)) continue; seen.add(k); efforts.push(e); }
  try { await placeInstitutions(efforts, state.instCache); saveCache(); } catch (e) {}
  applyInstitutionPlaces(efforts, state.instCache, state.countries);
  let conv = findConvergences(efforts, { query }).slice(0, 8);
  await locateOwners(conv);
  if (seq !== state.searchSeq) return;
  conv = conv.map(c => ({ ...c, caption: caption(c) }));
  const inConv = new Set(conv.flatMap(c => c.members.map(m => m.id)));
  const loose = efforts.filter(e => !inConv.has(e.id)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  let message = notes.length ? esc(notes.join(' ')) + ' ' : '';
  if (!efforts.length) message += 'Nothing recent came back for these words. Try plainer words, the way someone would put them in a paper or repository title.';
  else if (!conv.length) message += `Read <strong>${efforts.length}</strong> recent efforts but none were close enough to each other to call a convergence. Try a more specific problem.`;
  else message += `Read <strong>${efforts.length}</strong> recent efforts and found <strong>${conv.length}</strong> group${conv.length > 1 ? 's' : ''} of independent people working on nearly the same thing.`;
  state.current = { ...state.current, convergences: conv, loose, message, field: efforts.filter(e => e.place && !inConv.has(e.id)).map(e => [e.place.lon, e.place.lat]) };
  btn.disabled = false; btn.textContent = 'Find the others';
  renderPanel();
  if (conv.length) { const k = conv.findIndex(c => distinctPlaces(c.members.map(m => m.place).filter(Boolean)).length >= 2); focusConvergence(Math.max(0, k)); }
  else { setEfforts(); setCaption(query, efforts.length ? 'No clear convergence yet. Everyone here is on their own path, for now.' : 'Nothing recent found for these words.', ''); }
}

async function locateOwners(conv) {
  let lookups = 0;
  for (const c of conv.slice(0, 5)) for (const m of c.members) {
    if (m.source !== 'github' || !m.owner) continue;
    if (!(m.owner in state.ownerCache) && lookups < 6) {
      lookups++;
      try {
        const loc = await githubOwnerLocation(m.owner);
        const p = loc ? await geocode(loc) : null;
        state.ownerCache[m.owner] = p ? { ...p, label: loc } : null;
      } catch (e) { /* rate-limited or unavailable: leave unplaced */ }
    }
    const p = state.ownerCache[m.owner];
    if (p) m.place = { lat: p.lat, lon: p.lon, city: p.city, country: p.country, countryName: p.countryName, label: p.label, precision: 'profile' };
  }
  saveCache();
}

function saveCache() {
  try { localStorage.setItem('ntoo-cache', JSON.stringify({ inst: state.instCache, owners: state.ownerCache, at: Date.now() })); } catch (e) {}
}

// ---------- boot ----------
function setPanelCollapsed(on) {
  const p = $('panel'); p.classList.toggle('collapsed', on);
  $('caption').classList.toggle('collapsed-panel', on);
  $('panelToggle').textContent = on ? '+' : '–';
  $('panelToggle').setAttribute('aria-label', on ? 'Show details' : 'Collapse panel');
}
async function boot() {
  if (isMobile()) setPanelCollapsed(true);
  try {
    const local = JSON.parse(localStorage.getItem('ntoo-cache') || 'null');
    if (local && Date.now() - local.at < 30 * 86400000) { Object.assign(state.instCache, local.inst); Object.assign(state.ownerCache, local.owners); }
  } catch (e) {}
  const [disc, cache, topics] = await Promise.all([
    fetch('data/discoveries.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('data/places-cache.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('data/topics.json').then(r => r.json()).catch(() => []),
  ]);
  if (cache) { for (const [k, v] of Object.entries(cache.inst || {})) if (!(k in state.instCache)) state.instCache[k] = v; for (const [k, v] of Object.entries(cache.owners || {})) if (!(k in state.ownerCache)) state.ownerCache[k] = v; }
  state.discoveries = disc; state.topics = topics;
  $('chips').innerHTML = topics.map(t => `<button type="button" data-q="${esc(t.q)}">${esc(t.label)}</button>`).join('');
  $('chips').querySelectorAll('button').forEach(b => b.addEventListener('click', () => runSearch(b.dataset.q)));
  buildQuietQueue();
  const params = new URLSearchParams(location.search);
  const q = params.get('q'), seen = params.get('seen');
  const seenTopic = seen && disc?.topics.find(t => t.query === seen);
  if (q) runSearch(q);
  else if (seenTopic) { state.quiet = false; $('quietBtn').setAttribute('aria-pressed', 'false'); $('quietLabel').textContent = 'Play quiet discovery'; showDiscoveryTopic(seenTopic, Math.min(+params.get('i') || 0, seenTopic.convergences.length - 1)); }
  else if (state.quietQueue.length) startQuiet();
  else {
    state.current = { kicker: 'Quiet discovery', title: 'Resting', convergences: [], status: [], message: 'The weekly sweep of public sources is not available right now, so there is nothing to play. You can still search live below.' };
    renderPanel(); setCaption('', 'Type a problem below to find the others.', '');
  }
}

$('askForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('askInput').value); });
$('quietBtn').addEventListener('click', () => state.quiet ? stopQuiet() : startQuiet());
$('aboutBtn').addEventListener('click', () => $('about').showModal());
$('panelToggle').addEventListener('click', () => setPanelCollapsed(!$('panel').classList.contains('collapsed')));
$('panel').querySelector('.panel-head').addEventListener('click', (e) => { if (isMobile() && !e.target.closest('button') && $('panel').classList.contains('collapsed')) setPanelCollapsed(false); });
