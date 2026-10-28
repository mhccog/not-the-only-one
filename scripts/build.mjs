// Nightly/weekly build of "quiet discovery" convergences from real public sources.
// Run: node scripts/build.mjs   (optional env GITHUB_TOKEN, provided automatically inside GitHub Actions)
import fs from 'node:fs';
import { searchOpenAlex, placeInstitutions, applyInstitutionPlaces, searchGitHub, searchHN, githubOwnerLocation, geocode } from '../docs/js/sources.js';
import { findConvergences, caption } from '../docs/js/cluster.js';

const ROOT = new URL('../docs/data/', import.meta.url);
const token = process.env.GITHUB_TOKEN || null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const topics = JSON.parse(fs.readFileSync(new URL('topics.json', ROOT)));
const countries = {};
for (const f of JSON.parse(fs.readFileSync(new URL('countries.geojson', ROOT))).features) countries[f.properties.a2] = f.properties;
const cachePath = new URL('places-cache.json', ROOT);
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath)) : { inst: {}, owners: {} };
const prevPath = new URL('discoveries.json', ROOT);
const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath)) : null;
const only = process.argv[2] ? topics.filter(t => t.q === process.argv[2]) : topics;

async function searchArxiv(query, days = 365) {
  const words = query.split(/\s+/).filter(w => w.length > 2).map(w => `all:${w}`).join('+AND+');
  const url = `https://export.arxiv.org/api/query?search_query=${words}&sortBy=submittedDate&sortOrder=descending&max_results=40`;
  let xml = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
    xml = await (await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'not-the-only-one (github.com/mhccog/not-the-only-one)' } })).text();
    clearTimeout(t);
    if (xml.includes('<entry>')) break; // arXiv sometimes answers an empty feed when busy
    await sleep(6000);
  }
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const m of xml.split('<entry>').slice(1)) {
    const get = (tag) => (m.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]?.trim() || '';
    const id = get('id'); const title = get('title').replace(/\s+/g, ' '); const date = get('published').slice(0, 10);
    if (!title || date < since) continue;
    const authors = [...m.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(x => x[1].trim());
    out.push({
      id: 'ax:' + id.split('/abs/')[1], source: 'arxiv', sourceLabel: 'arXiv', kind: 'preprint', title,
      text: title + ' ' + title + ' ' + get('summary').split(/\s+/).slice(0, 90).join(' '),
      url: id.replace('http://', 'https://'), date, dateLabel: 'submitted',
      team: authors.map(a => 'name:' + a.toLowerCase()), nAuthors: authors.length, by: 'arXiv', place: null,
    });
  }
  return { efforts: out, total: out.length };
}

const slim = (e) => {
  const o = {}; for (const k of ['id', 'source', 'sourceLabel', 'kind', 'title', 'url', 'date', 'dateLabel', 'by', 'place', 'venue', 'description', 'stars', 'points', 'nAuthors', 'language', 'link']) if (e[k] != null && e[k] !== '') o[k] = e[k];
  return o;
};

const results = [];
for (const t of only) {
  const status = {};
  const all = [];
  const run = async (name, fn) => {
    try { const r = await fn(); status[name] = { ok: true, n: r.efforts.length, total: r.total }; all.push(...r.efforts); }
    catch (e) { status[name] = { ok: false, error: String(e.message || e) }; console.warn(t.q, name, e.message); }
  };
  const rawFile = process.env.RAW_CACHE ? `${process.env.RAW_CACHE}/${t.q.replace(/\W+/g, '-')}.json` : null;
  let fromRaw = false;
  if (rawFile && fs.existsSync(rawFile)) { const r = JSON.parse(fs.readFileSync(rawFile)); all.push(...r.all); Object.assign(status, r.status); fromRaw = true; }
  else {
    await run('openalex', () => searchOpenAlex(t.q));
    await run('github', () => searchGitHub(t.gh || t.q, { token }));
    await run('hn', () => searchHN(t.hn || t.q));
    await run('arxiv', () => searchArxiv(t.q));
    if (rawFile) { fs.mkdirSync(process.env.RAW_CACHE, { recursive: true }); fs.writeFileSync(rawFile, JSON.stringify({ all, status })); }
  }
  // de-duplicate arXiv entries already seen through OpenAlex (same title)
  const seen = new Set(); const efforts = [];
  for (const e of all) { const k = e.title.toLowerCase().replace(/[^a-z0-9]/g, ''); if (seen.has(k)) continue; seen.add(k); efforts.push(e); }
  await placeInstitutions(efforts, cache.inst);
  applyInstitutionPlaces(efforts, cache.inst, countries);
  let conv = findConvergences(efforts, { query: t.q + " " + (t.gh || "") }).slice(0, 6);
  // locate GitHub owners that appear in convergences (public profile location, geocoded to a city)
  for (const c of conv) for (const m of c.members) {
    if (m.source !== 'github' || !m.owner) continue;
    if (!(m.owner in cache.owners)) {
      try {
        const loc = await githubOwnerLocation(m.owner, { token });
        let place = null;
        if (loc) { await sleep(1100); place = await geocode(loc); }
        cache.owners[m.owner] = place ? { ...place, label: loc } : null;
      } catch (e) { console.warn('owner', m.owner, e.message); }
    }
    const p = cache.owners[m.owner];
    if (p) m.place = { lat: p.lat, lon: p.lon, city: p.city, country: p.country, countryName: p.countryName, label: p.label, precision: 'profile' };
  }
  const out = conv.slice(0, 4).map(c => ({ caption: caption(c), terms: c.terms, spanDays: c.spanDays, cohesion: c.cohesion, score: c.score, members: c.members.map(slim) }));
  console.log(`${t.q}: ${efforts.length} efforts, ${out.length} convergences`, JSON.stringify(status));
  for (const c of out) console.log('   ', c.caption, '|', c.terms.join(' · '));
  const prevTopic = prev?.topics?.find(p => p.query === t.q);
  if (prevTopic && (!status.openalex?.ok || (out.length === 0 && prevTopic.convergences.length))) {
    console.log('   keeping last good sweep for', t.q, '(a source was unavailable)');
    results.push({ ...prevTopic, keptFrom: prevTopic.keptFrom || prev.generatedAt });
  } else results.push({ topic: t.label, query: t.q, status, efforts: efforts.length, convergences: out, sweptAt: new Date().toISOString() });
  if (!fromRaw) await sleep(token ? 2500 : 7000); // GitHub search allows 10/min without a token
}

let merged = results;
if (prev && only !== topics) merged = prev.topics.filter(p => !results.some(r => r.query === p.query)).concat(results);
fs.writeFileSync(prevPath, JSON.stringify({ generatedAt: new Date().toISOString(), topics: merged }, null, 0));
fs.writeFileSync(cachePath, JSON.stringify(cache));
console.log('wrote', merged.length, 'topics');
