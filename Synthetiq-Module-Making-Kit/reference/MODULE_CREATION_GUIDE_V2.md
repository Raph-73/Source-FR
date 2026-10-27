# V2.1 Module Contract Guide

This guide defines the safe module format for all new modules.

## Compatibility

- `contractVersion` missing -> legacy module path (unchanged behavior).
- `contractVersion >= 2` -> strict V2 validation + V2 runtime path.
- `moduleVersion: 2.1.x` -> recommended manifest convention for current modules.
- Legacy modules are never normalized by V2 validators.

## Required V2 manifest fields

Top-level:

- `id` (string)
- `name` (string)
- `contentType` (`video` or `image` or `text`)
- `contractVersion` (number >= 2)

Inside `config`:

- `runtime.entry` (JS filename inside ZIP)
- `runtime.mode` (`local`)
- `caps.homeMaxResults`
- `caps.maxResponseBytes`
- `caps.timeoutMs`
- `caps.maxConcurrentRequests`

## Recommended V2.1 identity fields (future modules)

Top-level:

- `moduleVersion` (string, example: `2.1.0`)
- `moduleFamilyId` (string, stable family key)
- `moduleIdentity` (string, unique catalog code)
- `moduleIdentityNumber` (integer, unique module number)
- `releaseTrack` (optional string: `stable`, `beta`, etc.)

Identity policy:

- Every new V2.1 module should include identity fields.
- Keep `moduleIdentity` and `moduleIdentityNumber` stable across updates.
- Change `moduleVersion` for each module update.

## Required JS handlers

Module JS must expose:

- `searchResults(query)`
- `extractDetails(idOrUrl)`
- `extractEpisodes(idOrUrl)`
- `extractStreamUrl(episodeId[, lang])`

Handlers can be declared as functions or assigned to `globalThis`.

## V4 optional discovery handlers (Discovery V1)

When to add them: only if your source site exposes a real home page (trending, latest, curated rows) worth surfacing as distinct home sections. Discovery is additive — all required V3 handlers above stay mandatory, and search-driven behavior must keep working without discovery.

Manifest changes:

- `contractVersion: 4`
- `config.capabilities.discovery_v1: true` (this flag is what enables discovery; `contractVersion: 4` alone does not)

Minimal example (fictional site):

```js
async function discoveryHome() {
  const html = await fetchv2('https://example.com/home');
  return {
    sections: [
      {
        id: 'trending',
        title: 'Trending Now',
        style: 'hero',
        items: parseCards(html), // same { href, title, image } cards as searchResults
        viewAll: { mode: 'feed', feedId: 'trending' },
      },
      {
        id: 'latest',
        title: 'Latest Episodes',
        style: 'poster',
        items: parseLatest(html),
      },
    ],
  };
}

async function discoveryFeed(feedId, page) {
  const html = await fetchv2(`https://example.com/filter?feed=${feedId}&page=${page}`);
  const items = parseCards(html);
  return { items, page, hasMore: items.length > 0 };
}

globalThis.discoveryHome = discoveryHome;
globalThis.discoveryFeed = discoveryFeed;
```

Rules of thumb:

- `items` use the exact same card shape as `searchResults` output — no new item model.
- Section `id` must be unique, `[a-z0-9_-]{1,64}`; `title` non-empty, ≤80 chars; `style` is `hero | top10 | poster | landscape` (unknown coerces to `poster`).
- The app caps output (12 sections, 30 items/section, hero 8, top10 10, 50 items/feed page), dedupes by `href` (first occurrence wins), and times out at 8s (`discoveryHome`) / 10s (`discoveryFeed`).
- If `discoveryHome` fails or returns nothing usable, the app silently falls back to the legacy home — so a broken discovery handler degrades gracefully, but still ship it working.

Rollout rule: existing V2/V3 modules are unaffected and need no changes. Discovery is opt-in per module via the manifest flag; modules without it keep today's home behavior exactly.

Testing discovery:

```bash
node MODULE_TESTER/test_module.js path/to/example_v4_module.zip --search "example"
```

The tester only checks `discoveryHome` and `discoveryFeed` when `config.capabilities.discovery_v1` is `true`. V2/V3 modules without that flag still run through the normal module checks only.

## ZIP rules

- Must contain exactly 1 JSON file and at least 1 JS file.
- V2 must be self-contained (no `scriptUrl`).
- Runtime mode/source must stay local.

## Rollout rules

1. Keep legacy and V2 dual support.
2. Validate only V2 strictly.
3. Run regression gates before release:
   - Legacy HiAnime sub/dub/subtitles.
   - Legacy 1Movies episodes + stream.
   - V2 sample import/load/play.
   - Backup/restore with both legacy and V2 installed.
