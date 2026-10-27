# 03 · Movies playbook (video modules)

How to go from "here's a movie website" to a working module. Anime works the same way — the only
difference is usually episode count and sub/dub variants.

## Step 1 — Recon the site like an engineer, not a user

Open the site with devtools (Network tab) and answer:

1. **Search** — is there a search URL you can hit directly (`/?s=…`, `/search?q=…`), or a JSON API?
   Copy the exact request the site makes (URL, headers, method).
2. **Detail page** — what's the canonical URL for a title, and where do title/description/poster
   come from? (Meta tags, a JSON blob in the page, a public API like TMDB.)
3. **Episodes / movie entry** — how are episodes listed (JSON, markup, API)? A movie is simply one
   episode — use the movie's own id.
4. **Playback** — press play with devtools open and watch what the player requests. You'll see one of:
   - a direct media URL (`.mp4` / `.m3u8`) — great;
   - an embed page (`player.example/embed/…`) — you'll need to resolve it (see Step 3);
   - a private API call returning a URL/token — reproduce that call.
5. **Headers** — does the media/CDN care about `Referer`/`Origin`/`User-Agent`? Test with curl:
   `curl -s -o /dev/null -w '%{http_code}' -H 'Referer: https://site/' <media-url>`

Write these findings down as the map your module will follow.

## Step 2 — Three common archetypes

**A. TMDB catalogue + player API** (e.g. the `video-movie` example in this kit)

- Catalogue/search/details from TMDB (`api.themoviedb.org/3`) — **register your own free TMDB key and let
  the user supply it** rather than shipping a shared one.
- Playback comes from a player service the site calls (often a small API that issues a signed URL or a
  token for an embed). Recreate that request: you may need the same headers and sometimes a tiny
  obfuscation step (e.g. an array of char codes used as a key) — read it off the site's own JS.
- Multi-endpoint providers: keep an ordered list and try until one yields a verified stream.

**B. WordPress movie sites** — `/?s=query` search returns cards; detail pages are `/pelicula/<slug>/`
or similar; the player is an `<iframe>` to an embed host. Scrape the iframe, then resolve it (Step 3).

**C. Direct CDN sites** — pages embed `player.src({src: 'https://cdn…/file.mp4'})` or an `.m3u8`.
Extract with a tight regex/JSON walk and verify the bytes. Watch for *preview/sample files*: a "movie"
that's 2–15 MB is a trailer — compare against expected runtime.

## Step 3 — Resolving embeds and protected players

- Fetch the embed page with the **same headers a browser would send** (UA + Referer of the site, and
  `Origin` when required). Most "403" mysteries are a missing Referer.
- The embed's own JS will fetch the real route — find it (a fetch/XHR in its bundle, a token in a
  `<script>`, a `player.src` assignment in the HTML). Reproduce it server-side in your module.
- **Expiring and single-use URLs**: signatures (`exp=`, `st=`, `token=`) usually die within hours and
  some die on first fetch. Always resolve at play time; never cache a URL across calls; never
  pre-fetch the same URL you return (that can burn it).
- Token math may involve simple transforms (base64 variants, char shifts, XOR/ChaCha-style ciphers).
  If a full proprietary cipher is unavoidable, stop and report — don't fake it.

## Step 4 — Verify before you return (non-negotiable)

- **MP4/file**: `GET` with `Range: bytes=0-65535` → expect `200/206` and `video/*` or
  `application/octet-stream` with real payload. HEAD often gets `400/403` on media hosts — if you must,
  use a 1-byte range instead.
- **HLS**: fetch the playlist; reject if it references images, or is a "stub" playlist that lists the
  same placeholder over and over (a common off-air/dead-source trick).
- **Subtitles**: only include real files (`.vtt`/`.srt`), verified to download.
- Respect single-use rules: probe once, then hand the URL to the player with the same headers you probed
  with.

## Step 5 — Module behaviour checklist

- `extractStreamUrl` self-deadline ≈ 16 s; try routes in order; first verified wins;
  `{ streams: [] }` when nothing verifies — never return the dead URL.
- Sort quality variants **highest first**, and label sub/dub when both exist.
- `extractEpisodes` for a movie: a single entry (`number: 1`) — but keep the movie's own id in `href`.
- Accept ids AND full URLs in every function (normalise with your own `absolute()` helper).
- Cache nothing across calls except cheap catalogue data you can re-fetch; assume a cold start.

## Step 6 — Field notes (things that bit us)

- **JSON via `res.json()`** — text body is empty for JSON responses (see doc 01).
- **No timers** — deadline checks between awaits, never sleeping.
- **Node ≠ app**: Node's fetch silently drops `Referer`; the app's `fetchv2` sends it. Test referer-gated
  media through the app-side harness in `tools/`, or curl.
- **Cloudflare/JS walls**: if the site refuses non-browser clients at the catalogue level, stop and
  report — don't build a CAPTCHA bypass.
- **Geo/paywall/login gates**: out of scope by policy. If the site serves only trailers to guests, say
  so (that's a "not buildable" verdict, which is a perfectly good result).
- **Region-locked catalogues** differ per user; don't hardcode what you see locally as universal.
- **Rate limits**: if you see 429/403 after a burst, back off (bounded retries, spread calls).
- **Report honestly**: "sampled media bytes verified; actual playback untested" is accurate;
  "should work" is not.
