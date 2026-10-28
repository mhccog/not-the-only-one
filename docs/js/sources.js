// Keyless public sources. Every effort links back to its real record.
const OA = 'https://api.openalex.org';

export async function fetchJSON(url, { timeout = 20000, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers });
    if (!r.ok) { const err = new Error('HTTP ' + r.status); err.status = r.status; err.headers = r.headers; throw err; }
    return await r.json();
  } finally { clearTimeout(t); }
}

export function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function abstractFrom(inv, maxWords = 90) {
  if (!inv) return '';
  const pos = [];
  for (const [w, idx] of Object.entries(inv)) for (const i of idx) if (i < maxWords) pos[i] = w;
  return pos.filter(Boolean).join(' ');
}

const shortId = (u) => (u || '').replace('https://openalex.org/', '');

export async function searchOpenAlex(query, { days = 365, perPage = 100 } = {}) {
  const q = query.replace(/[,:|]/g, ' ').trim();
  const url = `${OA}/works?filter=title_and_abstract.search:${encodeURIComponent(q)},from_publication_date:${isoDaysAgo(days)},type:article|preprint&per-page=${perPage}` +
    `&select=id,title,publication_date,authorships,doi,primary_location,abstract_inverted_index,type`;
  const j = await fetchJSON(url);
  const out = [];
  for (const w of j.results || []) {
    if (!w.title || !w.publication_date) continue;
    const srcName = w.primary_location?.source?.display_name || '';
    const isArxiv = /arxiv/i.test(srcName) || /arxiv/i.test(w.primary_location?.landing_page_url || '');
    let inst = null;
    for (const a of w.authorships || []) { if (a.institutions?.length) { inst = a.institutions[0]; break; } }
    const insts = [];
    for (const a of w.authorships || []) for (const i of a.institutions || []) if (!insts.some(x => x.id === i.id)) insts.push(i);
    out.push({
      id: 'oa:' + shortId(w.id),
      source: isArxiv ? 'arxiv' : 'openalex',
      sourceLabel: isArxiv ? 'arXiv (via OpenAlex)' : 'OpenAlex',
      kind: (isArxiv || w.type === 'preprint') ? 'preprint' : 'paper',
      title: w.title.replace(/<[^>]+>/g, ''),
      text: w.title + ' ' + w.title + ' ' + abstractFrom(w.abstract_inverted_index),
      url: w.doi || w.primary_location?.landing_page_url || w.id,
      recordUrl: w.id,
      date: w.publication_date,
      dateLabel: 'published',
      venue: srcName,
      team: (w.authorships || []).map(a => shortId(a.author?.id)).filter(Boolean),
      nAuthors: (w.authorships || []).length,
      by: inst ? inst.display_name : (w.authorships?.[0]?.raw_affiliation_strings?.[0] || ''),
      instId: inst ? shortId(inst.id) : null,
      instCountry: inst?.country_code || (w.authorships || []).flatMap(a => a.countries || [])[0] || null,
      otherInsts: insts.slice(0, 6).map(i => i.display_name),
      place: null,
    });
  }
  return { efforts: out, total: j.meta?.count ?? out.length };
}

// Look up lat/lon for OpenAlex institutions, using a cache object {I123: {lat,lon,city,country}}
export async function placeInstitutions(efforts, cache) {
  const need = [...new Set(efforts.map(e => e.instId).filter(id => id && !(id in cache)))];
  for (let i = 0; i < need.length; i += 50) {
    const ids = need.slice(i, i + 50).join('|');
    try {
      const j = await fetchJSON(`${OA}/institutions?filter=id:${ids}&select=id,display_name,geo,country_code&per-page=50`);
      for (const r of j.results || []) {
        const g = r.geo || {};
        cache[shortId(r.id)] = g.latitude != null ? { lat: +g.latitude.toFixed(3), lon: +g.longitude.toFixed(3), city: g.city || null, country: g.country_code || r.country_code || null } : { lat: null, country: r.country_code || null };
      }
      for (const id of need.slice(i, i + 50)) if (!(id in cache)) cache[id] = { lat: null };
    } catch (e) { /* leave unplaced; reported as partial */ }
  }
  return cache;
}

export function applyInstitutionPlaces(efforts, cache, countries) {
  for (const e of efforts) {
    if (!e.instId && !e.instCountry) continue;
    const c = e.instId ? cache[e.instId] : null;
    if (c && c.lat != null) {
      e.place = { lat: c.lat, lon: c.lon, city: c.city, country: c.country, countryName: countries[c.country]?.n || c.country, label: e.by, precision: 'institution' };
    } else {
      const cc = (c && c.country) || e.instCountry;
      const k = countries[cc];
      if (k) e.place = { lat: k.ly, lon: k.lx, city: null, country: cc, countryName: k.n, label: e.by || k.n, precision: 'country' };
    }
  }
}

export async function searchGitHub(query, { days = 365, perPage = 50, token = null } = {}) {
  const words = query.replace(/["':]/g, ' ').trim();
  const q = `${words} in:name,description,topics created:>=${isoDaysAgo(days)} fork:false`;
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const j = await fetchJSON(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${perPage}`, { headers });
  const out = [];
  for (const r of j.items || []) {
    if (!r.description && !(r.topics || []).length) continue; // nothing to compare
    out.push({
      id: 'gh:' + r.full_name,
      source: 'github', sourceLabel: 'GitHub', kind: 'repo',
      title: r.full_name,
      text: r.name.replace(/[-_.]/g, ' ') + ' ' + (r.description || '') + ' ' + (r.topics || []).join(' '),
      description: r.description || '',
      url: r.html_url,
      date: (r.created_at || '').slice(0, 10),
      dateLabel: 'created',
      pushed: (r.pushed_at || '').slice(0, 10),
      stars: r.stargazers_count,
      language: r.language,
      team: [r.owner?.login].filter(Boolean),
      owner: r.owner?.login,
      by: r.owner?.login ? 'github.com/' + r.owner.login : '',
      place: null,
    });
  }
  return { efforts: out, total: j.total_count ?? out.length };
}

export async function searchHN(query, { days = 365, hits = 50 } = {}) {
  const since = Math.floor((Date.now() - days * 86400000) / 1000);
  const j = await fetchJSON(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&numericFilters=${encodeURIComponent('created_at_i>' + since)}&hitsPerPage=${hits}`);
  const out = [];
  for (const h of j.hits || []) {
    if (!h.title) continue;
    const body = (h.story_text || '').replace(/<[^>]+>/g, ' ').split(/\s+/).slice(0, 60).join(' ');
    out.push({
      id: 'hn:' + h.objectID,
      source: 'hn', sourceLabel: 'Hacker News', kind: 'discussion',
      title: h.title,
      text: h.title + ' ' + h.title + ' ' + body,
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      link: h.url || null,
      date: (h.created_at || '').slice(0, 10),
      dateLabel: 'posted',
      points: h.points,
      team: [h.author].filter(Boolean),
      by: 'Hacker News',
      place: null,
    });
  }
  return { efforts: out, total: j.nbHits ?? out.length };
}

// GitHub owner location -> coordinates. Owner profile location is a free-text public field.
export async function githubOwnerLocation(login, { token = null } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const u = await fetchJSON(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers });
  return (u.location || '').trim() || null;
}

export async function geocode(text) {
  const j = await fetchJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=1&lang=en`);
  const f = j.features?.[0];
  if (!f) return null;
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const nm = (p.name || '').replace(/ (Municipal Corporation|Metropolitan Municipality|City Council)$/,'');
  return { lat: +lat.toFixed(3), lon: +lon.toFixed(3), city: p.city || (['city', 'town', 'village'].includes(p.osm_value) || p.type === 'city' ? nm : null) || (p.type === 'country' ? null : nm) || null, country: p.countrycode || null, countryName: p.country || null };
}
