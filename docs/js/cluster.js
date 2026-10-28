// Clustering of near-duplicate efforts. Plain TF-IDF + cosine + average-linkage.
// Shared by the browser app and the nightly build script. No AI, no external calls.

const STOP = new Set(`a about above across after again against all almost along also although always am among an and another any are around as at be
because been before being below between both but by can could did do does doing done down during each either else enough etc even ever every few
for from further had has have having he her here hers him his how however i if in into is it its itself just least less like made make makes making
many may me might more most much must my near nearly neither no nor not now of off often on once one only onto or other others our out over own
per perhaps put rather really same see seen several shall she should since so some such than that the their them then there these they this those
though through thus to too toward towards under until up upon us use used uses using very via was we well were what when where whether which while
who whom whose why will with within without would yet you your
study studies approach approaches method methods methodology result results paper propose proposed proposes present presents novel new analysis
analyses based research review case effect effects application applications evaluation evaluating evaluate investigation investigating role
toward framework system systems performance improved improving improve towards challenge challenges insight insights perspective perspectives
first two three high low large small different various potential significant significantly important however findings finding work works
model models data dataset datasets compared comparison including include includes show shows shown demonstrate demonstrated provide provides
github repo repository project implementation simple tool tools awesome official code library hn ask show tell hacker news http https www com
org html pdf preprint article journal future direction directions recent advance advances current help helps era comprehensive overview systematic emerging prospect prospects trend trends state art vol issue doi et al abstract introduction conclusion background objective objectives aim aims purpose`.split(/\s+/));

function stem(w) {
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed') && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

export function tokens(text) {
  const raw = (text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/);
  const out = [];
  let prev = null;
  for (const r of raw) {
    if (!r || r.length < 3 || STOP.has(r) || /^\d+$/.test(r)) { prev = null; continue; }
    const s = stem(r);
    out.push(s);
    if (prev) out.push(prev + ' ' + s);
    prev = s;
  }
  return out;
}

// Pretty-print a stemmed term using the most common surface form seen.
function surfaceMap(efforts) {
  const m = new Map();
  for (const e of efforts) {
    const words = (e.text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/);
    for (const w of words) {
      if (w.length < 3) continue;
      const s = stem(w);
      const c = m.get(s) || new Map();
      c.set(w, (c.get(w) || 0) + 1);
      m.set(s, c);
    }
  }
  return (term) => term.split(' ').map(t => {
    const c = m.get(t); if (!c) return t;
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }).join(' ');
}

function vectorize(efforts) {
  const N = efforts.length;
  const tfs = efforts.map(e => {
    const tf = new Map();
    for (const t of tokens(e.text)) tf.set(t, (tf.get(t) || 0) + (t.includes(' ') ? 1.5 : 1));
    return tf;
  });
  const df = new Map();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const vecs = tfs.map(tf => {
    const v = new Map(); let norm = 0;
    for (const [t, c] of tf) {
      const d = df.get(t);
      if (d < 2 || d > Math.max(3, N * 0.35)) continue; // unique terms can't link; ubiquitous ones are the query itself
      const w = (1 + Math.log(c)) * Math.log((N + 1) / d);
      v.set(t, w); norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
  return vecs;
}

function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [t, w] of a) { const x = b.get(t); if (x) s += w * x; }
  return s;
}

const DAY = 86400000;
export function km(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
// Places that are genuinely different: >60 km apart, and a country-only dot does not count separately from a city in that country.
export function distinctPlaces(places) {
  const out = [];
  const sorted = [...places].sort((a, b) => (a.precision === 'country') - (b.precision === 'country'));
  for (const p of sorted) {
    if (out.some(o => km(o, p) < 60 || ((p.precision === 'country' || o.precision === 'country') && o.country && o.country === p.country))) continue;
    out.push(p);
  }
  return out;
}
function maxKm(ps) { let m = 0; for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) m = Math.max(m, km(ps[i], ps[j])); return m; }
export function daysBetween(a, b) { return Math.abs(new Date(a) - new Date(b)) / DAY; }

const prefix = (t) => (t || '').toLowerCase().split(/\s+/).slice(0, 6).join(' ');
function sharesTeam(a, b) {
  if (!a.team || !b.team) return false;
  for (const k of a.team) if (b.team.includes(k)) return true;
  return false;
}

// Main entry. efforts: [{id, source, title, text, date, team:[...], place:{lat,lon,city,country}|null}]
export function findConvergences(efforts, opts = {}) {
  const T = opts.threshold ?? 0.26;
  const maxSpanDays = opts.maxSpanDays ?? 120;
  if (opts.query) {
    const qt = [...new Set(tokens(opts.query).filter(t => !t.includes(' ')))];
    if (qt.length) {
      const has = efforts.map(e => { const ts = new Set(tokens(e.text)); return qt.filter(t => ts.has(t)); });
      const freq = qt.map(t => has.filter(h => h.includes(t)).length);
      const core = qt[freq.indexOf(Math.max(...freq))];
      const need = Math.ceil(qt.length / 2);
      efforts = efforts.filter((e, i) => has[i].includes(core) && has[i].length >= need);
    }
  }
  const n = efforts.length;
  if (n < 2) return [];
  const vecs = vectorize(efforts);
  const S = Array.from({ length: n }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let s = cosine(vecs[i], vecs[j]);
    if (sharesTeam(efforts[i], efforts[j])) s = s; // same team still clusters; deduped below
    S[i][j] = S[j][i] = s;
  }
  // average-linkage agglomeration (Lance-Williams)
  let clusters = efforts.map((_, i) => [i]);
  const C = S.map(r => Float32Array.from(r));
  const alive = new Array(n).fill(true);
  while (true) {
    let best = T, bi = -1, bj = -1;
    for (let i = 0; i < n; i++) if (alive[i]) for (let j = i + 1; j < n; j++) if (alive[j] && C[i][j] > best) { best = C[i][j]; bi = i; bj = j; }
    if (bi < 0) break;
    const a = clusters[bi].length, b = clusters[bj].length;
    if (a + b > 12) { C[bi][bj] = C[bj][bi] = -1; continue; }
    for (let k = 0; k < n; k++) if (alive[k] && k !== bi && k !== bj) {
      C[bi][k] = C[k][bi] = (a * C[bi][k] + b * C[bj][k]) / (a + b);
    }
    clusters[bi] = clusters[bi].concat(clusters[bj]);
    clusters[bj] = null; alive[bj] = false;
  }
  const pretty = surfaceMap(efforts);
  const out = [];
  for (let ci = 0; ci < n; ci++) {
    if (!alive[ci] || clusters[ci].length < 2) continue;
    // keep one effort per team (earliest), so every member is independent of the others
    let members = clusters[ci].map(i => ({ i, e: efforts[i] })).sort((x, y) => (x.e.date || '').localeCompare(y.e.date || ''));
    const kept = [];
    // "Same work" heuristics: same institution; a paper and a repo that describe each other (its own code);
    // or near-identical items in the same venue within a week (one coordinated series, not independent teams).
    const sameWork = (a, b) => sharesTeam(a.e, b.e)
      || (a.e.title || '').toLowerCase() === (b.e.title || '').toLowerCase()
      || (a.e.instId && a.e.instId === b.e.instId)
      || ((a.e.kind === 'repo') !== (b.e.kind === 'repo') && S[a.i][b.i] > 0.45)
      || (a.e.venue && a.e.venue === b.e.venue && daysBetween(a.e.date, b.e.date) <= 7 && S[a.i][b.i] > 0.5)
      || (a.e.date === b.e.date && !/-01-01$/.test(a.e.date || '') && S[a.i][b.i] > 0.5)
      || (daysBetween(a.e.date, b.e.date) <= 14 && prefix(a.e.title) === prefix(b.e.title));
    for (const m of members) if (!kept.some(k => sameWork(k, m))) kept.push(m);
    if (kept.length < 2) continue;
    // keep the tightest time window: trim outliers until span <= maxSpanDays
    let win = kept;
    while (win.length > 2 && daysBetween(win[0].e.date, win[win.length - 1].e.date) > maxSpanDays) {
      const dFirst = daysBetween(win[0].e.date, win[1].e.date);
      const dLast = daysBetween(win[win.length - 2].e.date, win[win.length - 1].e.date);
      win = dFirst > dLast ? win.slice(1) : win.slice(0, -1);
    }
    const span = daysBetween(win[0].e.date, win[win.length - 1].e.date);
    if (span > maxSpanDays) continue;
    let simSum = 0, pairs = 0;
    for (let x = 0; x < win.length; x++) for (let y = x + 1; y < win.length; y++) { simSum += S[win[x].i][win[y].i]; pairs++; }
    const cohesion = simSum / pairs;
    if (cohesion < T) continue;
    // shared terms: weight summed across members, must appear in >= 2 members
    const termW = new Map(), termC = new Map();
    for (const m of win) for (const [t, w] of vecs[m.i]) { termW.set(t, (termW.get(t) || 0) + w); termC.set(t, (termC.get(t) || 0) + 1); }
    let shared = [...termW.entries()].filter(([t]) => termC.get(t) >= 2).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const picked = [];
    for (const t of shared) {
      if (picked.length >= 4) break;
      if (picked.some(p => p.includes(t) || t.includes(p))) continue;
      picked.push(t);
    }
    if (picked.length < 2 && cohesion < 0.55) continue; // one generic shared word is not a convergence
    if (!picked.some(t => t.includes(' ')) && cohesion < 0.33) continue;
    const places = win.map(m => m.e.place).filter(Boolean);
    const distinct = distinctPlaces(places);
    const countries = new Set(places.map(p => p.country).filter(Boolean));
    const sources = new Set(win.map(m => m.e.source));
    // central member = highest average similarity to the rest
    let central = win[0], cbest = -1;
    for (const m of win) { let s = 0; for (const o of win) if (o !== m) s += S[m.i][o.i]; if (s > cbest) { cbest = s; central = m; } }
    const score = win.length * cohesion * (1 + 0.6 * Math.max(0, countries.size - 1)) * (1 + 0.3 * (sources.size - 1)) * (60 / (span + 60)) * (distinct.length >= 2 ? 1.6 : 0.8);
    out.push({
      members: win.map(m => m.e),
      central: central.e,
      cohesion: +cohesion.toFixed(3),
      spanDays: Math.round(span),
      imprecise: win.some(m => /-01-01$/.test(m.e.date || '')),
      terms: picked.map(pretty),
      countries: [...countries],
      distinctPlaces: distinct.length,
      maxKm: Math.round(maxKm(distinct)),
      score: +score.toFixed(4),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

const NUM = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
export function timingPhrase(days) {
  if (days <= 1) return 'on the same day';
  if (days <= 7) return 'within the same week';
  if (days <= 31) return 'within the same month';
  if (days <= 62) return `within ${Math.max(5, Math.round(days / 7))} weeks of each other`;
  return `within ${Math.round(days / 30.4)} months of each other`;
}
function listJoin(xs) {
  if (xs.length <= 1) return xs.join('');
  if (xs.length === 2) return xs[0] + ' and ' + xs[1];
  return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
}
export function caption(c) {
  const n = c.members.length;
  const kinds = new Set(c.members.map(m => m.kind));
  const research = [...kinds].every(k => k === 'paper' || k === 'preprint');
  const who = kinds.size === 1 && kinds.has('repo') ? 'independent projects' : research ? 'teams' : 'independent efforts';
  const verb = kinds.size === 1 && kinds.has('repo') ? 'started building this' : research ? 'published work on this' : 'took this on';
  const names = [];
  for (const p of distinctPlaces(c.members.map(m => m.place).filter(Boolean))) {
    const label = p.city || p.countryName || p.country;
    if (label && !names.includes(label)) names.push(label);
  }
  let where = '';
  const allPlaced = c.members.every(m => m.place);
  if (names.length) {
    const shown = names.slice(0, 3);
    if (names.length > 3) shown.push(`${names.length - 3} other place${names.length - 3 > 1 ? 's' : ''}`);
    where = allPlaced ? ' in ' + listJoin(shown) : `, including ${names.length === 1 && c.members.filter(m => m.place).length === 1 ? 'one' : 'some'} in ${listJoin(shown)},`;
  }
  const when = c.imprecise ? 'around the same time' : timingPhrase(c.spanDays);
  return `${NUM[n] || n} ${who}${where} ${verb} ${when}.`;
}
