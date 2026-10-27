# 04 · Manga playbook (image modules)

Manga modules look like movie ones from the outside — search, details, "episodes" — but the last stage
is **a list of page images** instead of a video URL, and the reader (not the player) consumes them.

## The four functions

```js
searchResults(keyword, page = 0)  → [{ title, href, image }]
extractDetails(urlOrId)           → { title, description, image?, author?, status?, genres? }
extractChapters(url)              → [{ number, href, title? }]         // ascending order
extractImages(chapterId)          → ["https://…/01.jpg", "https://…/02.jpg", …]
```

Notes that avoid 90% of bugs:

- **Chapter `href` is opaque** — encode anything you need later (series slug + chapter id, a full URL,
  or your own `series:chapter` string). The app hands it straight back to `extractImages`.
- Accept both ids and full URLs in every function; normalise with your `absolute()` helper.
- `extractImages` must return **direct image URLs in reading order**. Not a page that lists them, not a
  proxy — the URLs themselves.
- Filter junk: ad banners, spacer gifs, logos, tracking pixels — they're usually identifiable by host or
  path patterns (`.gif`, `/ads/`, `logo`, `banner`). Don't ship them to the reader.

## Recon checklist

1. **Search** — `?q=`/`?search=`/API. Note pagination (`?page=N`) if the site has it; wire it to the
   `page` argument.
2. **Detail page** — title, synopsis, cover, author, status, **the chapter list**. The list may be:
   - plain markup (`<a href="/chapter/…">`,
   - a JSON blob in the page (look for `window.__DATA__`, `application/json` script tags),
   - an API the site calls (`/api/manga/<slug>/chapters`).
3. **Reader page** — open a chapter with devtools and find how page images arrive:
   - `<img>` with `src` (easy) or `data-src`/`data-lazy`/`data-original` (lazy loading — decode these!),
   - a JSON/JS array of page URLs (common on modern readers),
   - an API returning `[{ img: "…", width, height }]`.
4. **Headers** — image CDNs are the #1 referer-naggers. Test:
   `curl -s -o /dev/null -w '%{http_code}' -H 'Referer: https://site/' <img-url>`
   If the no-referer request 403s, your module MUST pass the site's Referer (and sometimes `Origin`).
   Return collected headers with the module's `streamHeaders` / per-call headers.

## Patterns that work (all seen in production)

**Markup chapters + JSON pages**
The detail page lists chapters as anchors; the reader page embeds a JSON array of page URLs. Parse the
array (walk to the matching bracket and `JSON.parse` — regex-to-first-`]` truncates), then return the
URLs with the right host joined.

**API-driven sites**
If the site's reader calls a public JSON API, replicate it: `GET /api/chapter/<id>/pages` with the
reader's headers → map to URLs. Fewer regexes, fewer breakages.

**Lazy/encoded chapter lists**
Some sites render the list client-side from base64/escaped JSON in a `<script>`. Decode (plain base64
can be decoded with a tiny 20-line pure-JS decoder — remember, no `atob` in the sandbox), parse, map.

**Image URL shapes**
Typical: `https://cdn/<manga>/<chapter>/001.jpg`. Watch for width params (`?w=800`) — keep them if the
site requires them; they're part of the signed/path scheme. Some CDNs gate on a
`?token=` that expires — in that case resolve at `extractImages` time (which you do anyway) and don't
cache long.

## Verification before you ship

- Fetch **the first and the last image** of one chapter with the module's own headers — expect real image
  bytes (check magic numbers: `FF D8 FF` JPEG, `89 50 4E 47` PNG, `RIFF….WEBP`).
- Fetch a **second chapter** — confirm ordering and numbering are right (ascending, no duplicate
  numbers, no missing gap where the site has none).
- Check the **first page of a fresh series** end-to-end through your local harness (doc 05).
- Verify `searchResults` returns real covers for 2-3 common queries (a missing cover URL is acceptable,
  a broken one is not).

## Field notes

- **Referer-gated images are the norm on pt-BR/es sites** (see the kit's `manga` example — Atsu — whose
  `module.json` carries `streamHeaders` for exactly this reason). Always try with the site's Referer.
- **The reader prefetches**: keep image URLs stable and direct; don't make them short-lived where you can
  avoid it.
- **Cloudflare walls**: if the reader itself needs browser JS to get image URLs, and you cannot find the
  JSON it consumes, stop and report — don't build bypasses.
- **Adult content**: filter what the owner asks to filter (e.g. an 18+ genre list harvested from the
  site) rather than silently shipping everything.
- **Bump versions honestly**: `extractChapters`/`extractImages` fixes are real releases; users see the
  version.
