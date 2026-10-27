Module Contract (JS Client Modules)
===================================

This app loads client modules dynamically. A module is a JS file that must export four functions on `globalThis` and follow the shapes below.

Required JS exports
-------------------
- `searchResults(query: string)` -> array of `{ href, image, title }`
- `extractDetails(urlOrId: string)` -> object (or single-element array) with at least `{ title, description }` (add any other fields you want)
- `extractEpisodes(seriesId: string)` -> array of `{ number, href, subAvailable?, dubAvailable? }`
- `extractStreamUrl(episodeHref: string)` -> either:
  - string URL, or
  - `{ streams: [label, url, ...], headers?: { ... } }` (labels should contain `sub`/`dub` when possible)
- optional quality metadata: `{ quality?: "1080p", defaultQuality?: "1080p", qualities?: [{ label, height?, url, headers? }] }`

Live streams and sports metadata
-------------------------------
Live TV and sports modules must mark the **stream response** from
`extractStreamUrl` as live. Do not infer this from the module name or a title:

```json
{
  "streams": ["Auto", "https://example.com/live/master.m3u8"],
  "streamType": "hls",
  "isLive": true,
  "headers": { "Referer": "https://example.com/" }
}
```

`live`, `is_live`, `liveStream`, and `playbackType: "live"` are accepted for
compatibility, but new modules should use `isLive: true`.

When `isLive` is true, the app uses live-safe playback: it does not resume an
old VOD position, cache the stream for offline use, run intro/outro skipping,
or expose VOD seek controls. Its recovery logic is bounded so a stale live
playlist cannot cause an endless reload loop.

Sports modules must explicitly declare
`config.capabilities.live_sports_v1: true` before the app considers optional
display-only match metadata. Ordinary live TV stays ordinary live TV. The app
does not fetch a stats provider directly; modules or a module-owned backend
must return current, licensed data with the stream response. Never return a
provider key, provider URL, logo, HTML, script, or arbitrary UI markup:

```json
{
  "isLive": true,
  "liveEvent": {
    "provider": "your-licensed-adapter",
    "eventId": "provider-event-123",
    "sport": "football",
    "competition": "Example League",
    "home": { "name": "Home FC", "score": 1 },
    "away": { "name": "Away FC", "score": 0 },
    "clock": "67'",
    "status": "LIVE",
    "updatedAt": "2026-07-19T12:34:56Z",
    "panels": ["scoreboard", "stats", "lineups", "plays"],
    "stats": [{ "label": "Possession", "home": "54%", "away": "46%" }]
  }
}
```

Supported `sport` values are `football`, `nfl`, `nba`, and `mlb`. `provider`,
`eventId`, both team names, and an ISO `updatedAt` timestamp are required.
The app bounds list sizes and rejects unknown sports, unsafe strings, links,
HTML, scripts, unsupported panels, and malformed payloads. The player shows a
dismissible native panel only when that validation succeeds. Omit `liveEvent`
for ordinary live TV channels.

For a live updating panel, a module may additionally export
`extractLiveEvent(episodeHref)`. It returns the same `liveEvent` object (or an
object containing it). The player polls this optional handler only while the
user has the match panel open, at most once every 30 seconds. It never uses
this handler to replace the active stream URL.

Optional V4 discovery exports — Discovery V1 (contractVersion 4)
-----------------------------------------------------------------
Modules may additionally implement the Discovery V1 API to power a sectioned, Netflix-style home screen. Discovery is **additive and optional**: all required V3 handlers above stay required and unchanged, and modules without discovery keep today's home behavior.

Manifest gating:
- Set `contractVersion: 4` **and** `config.capabilities.discovery_v1: true`.
- The capability flag is what enables discovery — `contractVersion: 4` alone does NOT. A cv4 module without the flag never receives discovery calls.
- The app predicate is `config.capabilities.discovery_v1 === true AND contractVersion >= 3` (the flag on a cv3 module is tolerated for forward compatibility; new modules should declare cv4).
- No new required manifest fields for cv4 beyond the existing V3 identity block.

JS exports (both optional; declare as functions or assign to `globalThis`):

```js
// Called once per home load.
async function discoveryHome() -> DiscoveryHomeResult

// Called for View All + endless scroll. page is 1-based.
async function discoveryFeed(feedId, page) -> DiscoveryFeedResult
```

`DiscoveryHomeResult` (object or JSON string; tolerant unwrap conventions apply):

```json
{
  "sections": [
    {
      "id": "trending",
      "title": "Trending Now",
      "style": "hero",
      "items": [ { "href": "https://example.com/series/1", "title": "Example Series", "image": "https://example.com/poster.jpg" } ],
      "viewAll": { "mode": "feed", "feedId": "trending" }
    }
  ]
}
```

- `id`: required, unique within the result, `[a-z0-9_-]{1,64}`.
- `title`: required, non-empty, ≤80 chars.
- `style`: one of `hero | top10 | poster | landscape`; unknown values coerce to `poster`.
- `items`: **exact V3 search-result card shape** (`href`/`title`/`image` plus optional extras) — decoded by the same mapper as `searchResults`. No new item model.
- `viewAll` optional. `mode: "feed"` requires `feedId`; `mode: "search"` requires `query` (routed to the existing search results screen).

`DiscoveryFeedResult`:

```json
{ "items": [ /* same card shape as searchResults */ ], "page": 2, "hasMore": true }
```

App-enforced rules (what the app does with your output):
- **Caps**: max 12 sections per `discoveryHome`; max 30 items/section (hero max 8; top10 keeps first 10 exactly); max 50 items per feed page. Excess is silently truncated.
- **Empty sections** (0 items after dedupe) are dropped. If ALL sections drop, the app treats it as a discovery failure and falls back to the legacy home path.
- **Dedupe**: by trimmed `href`, across sections in document order, first occurrence wins. Feed pages dedupe against items already loaded in that feed AND the seed section's items.
- **Timeouts**: `discoveryHome` 8s, `discoveryFeed` 10s.
- **Failure semantics**: if `discoveryHome` throws, times out, or comes back empty, the whole discovery path fails and the app renders the legacy home instead (plus any cached snapshot). If a `discoveryFeed` page fails, the row keeps its existing items and shows an inline retry — never a blank screen, never a top-level error.

Tester behavior:
- `MODULE_TESTER/test_module.js` validates `discoveryHome` and one `discoveryFeed` page only when `config.capabilities.discovery_v1` is enabled.
- V2/V3 modules without the discovery flag are not required to export discovery handlers and keep the normal tester path.

Config fields (ModuleConfig.config)
-----------------------------------
- `baseUrl`: base site URL for referer/origin and URL joins.
- `scriptContent` | `scriptFile`: locally installed JavaScript. Remote executable script URLs are not supported.
- `streamHeaders` / `streamCookies`: key/value pairs merged into stream requests.
- Other custom fields are passed through to the JS module as-is.

V2.1 identity metadata (recommended for all new modules)
---------------------------------------------------------
For `contractVersion >= 2` modules, include these top-level fields to identify ownership and approval status cleanly:
- `moduleVersion`: semantic version for the module itself (example: `2.1.0`)
- `moduleFamilyId`: stable family key for related updates (example: `animeheaven_v2`)
- `moduleIdentity`: human-readable unique identity code (example: `SP-VID-003-ANIMEHEAVEN`)
- `moduleIdentityNumber`: integer identity number used by your module catalog (example: `3`)
- `releaseTrack`: optional release channel (`stable`, `beta`, etc.)

Notes:
- These fields do not change JS handler behavior.
- Runtime should tolerate unknown top-level fields for forward compatibility.
- Keep identity values stable between minor module revisions.

Return shape rules
------------------
- Always return JSON-compatible values. If you return a string, it must be valid JSON or a plain URL (for `extractStreamUrl`).
- Episodes: `href` is treated as the episode ID and is passed unchanged to `extractStreamUrl`.
- Streams: when returning `{streams: [...]}`, use pairs `[label, url]`. Provide at least one pair; add headers if the host needs referer/origin/cookies.
- Quality picker: if multiple playable qualities exist, return them highest first through either labelled `streams` pairs (`"dub 1080p"`, `"dub 720p"`, `"dub Auto"`) or a `qualities` array. The app chooses the highest numeric quality by default and keeps `Auto` available as a manual option.

Error handling
--------------
- Throw/`reject` with a clear message; the runtime surfaces it. Avoid printing HTML/whole pages.
- Keep calls under ~25–30s; slow hosts should be retried inside the module if needed.

Example module config (JSON)
----------------------------
```json
{
  "id": "example-v2-1",
  "name": "Example V2.1",
  "contentType": "video",
  "contractVersion": 2,
  "moduleVersion": "2.1.0",
  "moduleFamilyId": "example_v2",
  "moduleIdentity": "SP-VID-999-EXAMPLE",
  "moduleIdentityNumber": 999,
  "releaseTrack": "stable",
  "config": {
    "runtime": {
      "entry": "index.js",
      "mode": "local"
    },
    "caps": {
      "homeMaxResults": 30,
      "maxResponseBytes": 524288,
      "timeoutMs": 30000,
      "maxConcurrentRequests": 4
    },
    "baseUrl": "https://example.com",
    "streamHeaders": {
      "Referer": "https://example.com/",
      "Origin": "https://example.com",
      "User-Agent": "Mozilla/5.0 ..."
    }
  }
}
```

Example V4 discovery-enabled manifest (JSON)
--------------------------------------------
Same as above, with `contractVersion: 4` and the capabilities block enabling Discovery V1:

```json
{
  "id": "example-v4",
  "name": "Example V4",
  "contentType": "video",
  "contractVersion": 4,
  "moduleVersion": "4.0.0",
  "moduleFamilyId": "example_v2",
  "moduleIdentity": "SP-VID-999-EXAMPLE",
  "moduleIdentityNumber": 999,
  "releaseTrack": "stable",
  "config": {
    "runtime": {
      "entry": "index.js",
      "mode": "local"
    },
    "capabilities": {
      "discovery_v1": true
    },
    "caps": {
      "homeMaxResults": 30,
      "maxResponseBytes": 524288,
      "timeoutMs": 30000,
      "maxConcurrentRequests": 4
    },
    "baseUrl": "https://example.com",
    "streamHeaders": {
      "Referer": "https://example.com/",
      "Origin": "https://example.com",
      "User-Agent": "Mozilla/5.0 ..."
    }
  }
}
```

Smoke test
----------
- Run offline contract check: `flutter test test/module_contract_smoke_test.dart`
- Run online smoke (real network calls): `flutter test --dart-define=RUN_MODULE_SMOKE=true test/module_contract_smoke_test.dart`
- Failures will tell you which function/shape/header is missing so you can fix the module before shipping it.
