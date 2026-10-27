# 02 · The module contract

Everything here is what the app validates and consumes. The authoritative full specs live in
`reference/` (`MODULE_CONTRACT.md`, `MODULE_CREATION_GUIDE_V2.md`); this page is the working summary.

## module.json — the manifest

```json
{
  "id": "example-movies-v1",
  "name": "Example Movies",
  "contentType": "video",
  "contractVersion": 4,
  "moduleVersion": "1.0.0-beta.1",
  "description": "One line describing the source and what it offers.",
  "moduleFamilyId": "example_movies_v1",
  "moduleIdentity": "PENDING-OWNER-ALLOCATION",
  "moduleIdentityNumber": 0,
  "releaseTrack": "beta",
  "moduleStatus": "trial",
  "presentation": {
    "category": "Movies",
    "purpose": "English Movies",
    "recommended": false,
    "language": "English",
    "languages": ["sub"],
    "iconUrl": "https://example.com/icon.png"
  },
  "config": {
    "capabilities": {},
    "runtime": { "entry": "index.js", "mode": "local" },
    "caps": {
      "homeMaxResults": 40,
      "maxResponseBytes": 5242880,
      "timeoutMs": 30000,
      "maxConcurrentRequests": 4
    },
    "baseUrl": "https://example.com",
    "streamHeaders": {
      "User-Agent": "Mozilla/5.0 …",
      "Referer": "https://example.com/"
    }
  }
}
```

Field notes:

| field | rules |
|---|---|
| `id` | lowercase, hyphens, ends `-v1` by convention; unique forever |
| `contentType` | `video` or `image` (text modules exist but are out of scope) |
| `contractVersion` | `4` — modern modules. Missing/`>=2` changes how the app validates. |
| `moduleVersion` | semver; bump on every shipped change (`1.0.0-beta.1`, `1.2.3`, …) |
| `moduleFamilyId` | stable family id (`alpha_movies`) — never changes across updates |
| `moduleIdentity` / `moduleIdentityNumber` | **allocated by the catalogue owner** once, immutable after. Development builds may carry `PENDING-OWNER-ALLOCATION` / `0` |
| `releaseTrack` | `stable` \| `beta` \| `nightly` (lowercase) — currently `beta`/`nightly` for non-production |
| `moduleStatus` | `active` \| `trial` (testing candidates use `trial`) |
| `presentation.iconUrl` | a real public HTTPS **image** (PNG/JPEG/WebP). Never SVG, never a page URL. A 404 icon is a real defect — verify it returns `200 image/*` |
| `caps.homeMaxResults` | **1–120** — an out-of-range value gets the package **rejected by the app's inspector** |
| `config.capabilities` | `discovery_v1` for `discoveryHome`/`discoveryFeed`; `live_discovery_v1` for Live modules (out of scope here) |
| `config.baseUrl` | the site's root — informational, and a good place for your default Referer |

## Return shapes — video

```js
// searchResults(query)
[{ title, href, image, id? }]            // href/title/image are the essential fields

// extractDetails(urlOrId)
{ title, description, image?, poster?, genres?, status?, year?, url?, id? }
// at minimum title + description; must not throw for a valid id

// extractEpisodes(seriesId)
[{ number, href, title?, season? }]      // number is a positive integer; a movie = a single entry

// extractStreamUrl(episodeHref, lang)  — one of:
"https://cdn.example/master.m3u8"                                  // plain string URL
{ url: "https://cdn.example/file.mp4",
  headers: { "User-Agent": "…", "Referer": "…" },
  streamType: "mp4" }                                              // ← typical
{ streams: ["720p", "https://…m3u8", "1080p", "https://…m3u8"],   // labelled alternates
  headers: { … }, streamType: "hls" }
{ streams: [] }                                                    // nothing verified — say so
```

- `streamType`: `"mp4"` (a file — also used by the cache/download feature) or `"hls"`. Declare it:
  the app uses it to route playback and to allow downloads.
- For HLS, the playlist must contain **real media segments**, never `.jpg/.png/.webp` entries.
- Subtitles (optional): `subtitles: [{ url, label, language? }]` only when real files exist.
- Intro/outro skip (optional): `intro: { start, end }` / `outro: { start, end }` in seconds — only
  when the source actually provides them.

## Return shapes — image (manga)

```js
// searchResults(keyword, page = 0)   → [{ title, href, image }]
// extractDetails(urlOrId)            → { title, description, image?, author?, status?, genres? }
// extractChapters(url)               → [{ number, href, title? }]     // ascending
// extractImages(chapterId)           → ["https://…/01.jpg", "https://…/02.jpg", …]
```

- `extractImages` must return **direct image URLs in reading order** — the reader fetches each one.
  No HTML pages, no proxies.
- If the site separates volumes/seasons, flatten with `season` on chapters or encode it in `href`.

## Optional: discovery (home experience)

Only when `config.capabilities.discovery_v1` is `true`, and only if you can build it from sources the
site really provides:

```js
discoveryHome()        → { sections: [{ id, title, style, items, viewAll? }] }
// style: "hero" | "top10" | "poster" | "landscape"
// items = the exact searchResult card shape. hero ≤ 8, sections ≤ 30 items.
discoveryFeed(feedId, page) → { items, page, hasMore }   // ≤ 50/page, page is 1-based
// viewAll: { mode: "feed", feedId } or { mode: "search", query }
```

Caps enforced by the house tester: **hero ≤ 8 items** (a 10-item hero FAILS validation), poster rows
≤ 30, feeds ≤ 50/page. Slice at the source.

## Versioning & packaging rules

- Flat ZIP: exactly one JSON manifest + at least one JS file, both at the archive root. No folders, no
  extra junk. `zip -X -q -r MyModule-1.0.0.zip module.json index.js`
- `runtime.mode` must be `local`; no remote `scriptUrl`.
- Every shipped change: bump `moduleVersion`, keep identity fields identical.
- Verify the ZIP by unzipping a copy and re-reading the manifest; record its SHA-256.
- Keep your working copy in a `Synthetiq-Module-Making-Kit`-style dev folder with a `tests/` next to
  it — you'll re-run the same checks on every change.
