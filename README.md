# You're not the only one

**Live:** https://mhccog.github.io/not-the-only-one/

Somewhere, someone is working on the same problem as you, right now. This is a calm globe that finds real, recent, *independent* efforts on the same problem and draws soft threads between them, before they each spend a year duplicating the other.

It is the first of five ideas in a foundation about connecting people to people, and solutions to problems.

## How it works

- **Ask:** type a problem. The browser asks keyless public sources about the last 12 months:
  - [OpenAlex](https://openalex.org) works (papers and preprints, including arXiv), with author institutions and their coordinates
  - [GitHub](https://docs.github.com/en/rest/search) repository search (repositories created in the last year)
  - [Hacker News](https://hn.algolia.com/api) via Algolia
- **Group:** efforts that describe nearly the same thing are grouped with plain TF-IDF word overlap and average-linkage clustering, in the browser (`docs/js/cluster.js`). No AI service.
- **Keep only independent ones:** members of a group share no authors (OpenAlex author IDs) and no owner, and sit within ~4 months of each other.
- **Place:** papers sit at the first listed institution (OpenAlex geo). Repositories sit at the owner's public profile location, geocoded with [Photon](https://photon.komoot.io) (OpenStreetMap). If only a country is known, the dot sits at the country's centre and says "country only". Unknown places are listed but not drawn.
- **Quiet discovery:** a weekly GitHub Actions sweep (`scripts/build.mjs`, `.github/workflows/refresh.yml`) runs the same logic over a rotating set of topics, also reading [arXiv](https://arxiv.org/help/api) directly, and saves the results to `docs/data/discoveries.json`. The page plays them slowly.

## Honesty rules

- Every dot is a real public record and links to it. Nothing is invented.
- Dates are publication, creation or posting dates, not when work began.
- If a source is down or rate-limited, the page says so.
- No logins, no contacting anyone, no personal data beyond what the public source shows. Introductions are "coming later, with consent".

## Run locally

```
cd docs && python3 -m http.server 8000
node scripts/build.mjs            # refresh quiet discovery (optional GITHUB_TOKEN env raises GitHub limits)
```

Basemap: Natural Earth (public domain). Map: MapLibre GL JS (BSD-3).
