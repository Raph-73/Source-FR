# 01 · How Synthetiq modules actually work

This is the mental model. Read this first; everything else in the kit builds on it.

## The shape of a module

A module is a **ZIP with exactly two files at the top level**:

```
MyModule-1.0.0.zip
├── module.json      ← manifest: who the module is, what it declares
└── index.js         ← all the logic, one file
```

The user installs the ZIP (Settings → Media & Sources → import / repository), and the app stores and
runs it. There is no server side: everything happens on-device.

## What the app does with it

The app is a Flutter application. Inside it, an isolated **JavaScript runtime** executes your `index.js`
when the user browses or plays. The flow, for each content type:

**Video (movies / shows / anime):**

```
search query ──► searchResults()          ──► grid of cards (title + image + your id)
tap a card   ──► extractDetails(id)       ──► synopsis page
open it      ──► extractEpisodes(id)      ──► episode list (a movie = 1 episode)
tap play     ──► extractStreamUrl(ep, lang) ──► player gets a URL (+ headers) and plays it
```

**Manga / image:**

```
search query ──► searchResults(keyword)   ──► grid of cards
tap a card   ──► extractDetails(id)       ──► synopsis page
open it      ──► extractChapters(id)      ──► chapter list
open chapter ──► extractImages(chapterId) ──► ordered image URLs → the reader displays them
```

**Everything the app needs comes from your functions.** If you return an id, the app will hand that
exact id back to you later — so ids can be whatever is most convenient (URLs, slugs, JSON you encoded
yourself), as long as they're stable and non-empty.

## How network calls work (`fetchv2`)

Your module never gets a browser `fetch`. The runtime exposes one helper:

```js
const res = await fetchv2(url, headers, method, body, options);
// res.status        → number (200, 403, …)
// res.headers       → object, lowercase keys ('content-type', 'location', …)
// res.text()        → Promise<string>   — HTML, text
// res.json()        → Promise<object>   — JSON endpoints
```

Key behaviours, learned in production:

- **JSON endpoints deliver an EMPTY string body and real data through `res.json()`.**
  A helper that only reads `res.text()`/`res.body` silently loses whole APIs. Always:
  `const data = await res.json()` for JSON.
- The call goes through the app's Dart HTTP layer — that means:
  - Default browser-ish `User-Agent` unless you pass your own; **`Referer` you pass will be sent**
    (unlike Node's fetch, which silently drops it).
  - **Cookies persist per module runtime** — if a site sets cookies on page 1, later requests carry
    them. This is how session/nonce flows work.
  - `options` accepts `{ followRedirects: false, timeoutMs }` where supported; a 302 can otherwise be
    followed transparently.
- Return `response.headers` keys lowercase; `location` shows up on redirects when you disable following.

## What the sandbox does NOT have (important!)

Measured against the real app runtime — plan around these:

| Missing | Do instead |
|---|---|
| `setTimeout` / `setInterval` | check `Date.now()` between awaits; no sleeping |
| typed arrays (`Uint8Array`…) | plain arrays of numbers, strings |
| `atob` / `btoa` | write your own tiny base64 helpers (pure JS) |
| Node APIs (`require`, `Buffer`, `process`) | nothing — it's a sealed sandbox |
| `fetch` (browser) | use `fetchv2` |

Text is the native currency: HTML, JSON, and even binary blobs arrive as (possibly lossy) strings.
That's fine for every plan in this kit — but if you ever must handle raw bytes, be aware a byte-exact
path may not exist.

## Timeouts, caps and expectations

- The app calls each function with its own deadline. The practical budget is **~15 s** for
  search/details/lists and **~20 s for stream resolution** (self-deadline at ~16 s to be safe).
- The manifest declares `caps` (`homeMaxResults` 1–120, `maxResponseBytes` ≤ 5 MiB, `timeoutMs` ≤ 30 s,
  `maxConcurrentRequests` ≤ 8). Stay well inside them.
- The app caches some results briefly (seconds to a minute); design for being called again at any time,
  with no guaranteed warm state.
- **Fetch only what you need.** Extra fetches per call = slower screens and unhappy providers.

## Patterns that keep modules alive

1. **Absolute URLs everywhere.** Normalise every `href` you emit (`new URL`-like string joining) so
   the app never receives something it can't use.
2. **Defensive parsing.** Sites change markup. Prefer regex/JSON that fails to `[]`/`''` over throws;
   one missing field must never kill a whole list.
3. **Deadlines, not hope.** Every loop that fetches should check `Date.now() < deadline` and bail with
   whatever it has.
4. **Resolve media per play.** Signed/temporary URLs are resolved freshly each time and never stored.
5. **Verify before returning a stream.** A 2-byte range probe that checks `video/*` (or a real first
   segment for HLS) prevents dead routes from reaching the player.
6. **No secrets.** Don't hardcode your own accounts/keys; if a site needs a public key
   (e.g. a TMDB key), let the user fill it in and document that.

## Where modules come from and how they ship

- Users install from a **repository** (a JSON index listing ZIPs) or by importing a ZIP directly.
- The official catalogue and the community testing catalogue each have their own index; publishing is
  an owner action (see `docs/05-testing-and-evidence.md` → Publishing).
- A module's **identity** (`SP-VID-082-…` style) and number are allocated once and never change for
  that module family; every update keeps the same identity with a bumped `moduleVersion`.

Next: `02-the-module-contract.md` for the exact manifest fields and return shapes.
