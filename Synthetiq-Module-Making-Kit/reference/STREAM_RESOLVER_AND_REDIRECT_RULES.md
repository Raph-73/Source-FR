# Stream Resolvers, 302 Redirects, and Downloader Integrity

> **CRITICAL KNOWLEDGE FOR MODULE DEVELOPERS AND AI AGENTS**
> This document details the exact redirect behavior of video hosts (such as Sibnet, DoodStream, StreamWish, MP4Upload) and how they interact with the Flutter Dart runtime and Dio download manager.

---

## 1. The Core Architecture Problem

Many video hosts use a two-tier architecture:
1. **Tier 1 (Routing / Embed endpoint)**: e.g. `https://video.sibnet.ru/v/{hash}/{videoid}.mp4`
2. **Tier 2 (Physical Storage CDN cluster)**: e.g. `https://dv97.sibnet.ru/43/39/81/4339810.mp4?st=...&e=...`

When a client hits Tier 1, the server returns an `HTTP 302 Found` with a `Location: //storage-cdn...` header pointing to Tier 2.

### Why Unresolved 302 Links Fail in Synthetiq Player:
1. **Dio Probing & Range Requests:** The app's download manager (`downloads_state.dart`) sends preflight probe requests and range requests. Tier 1 routing servers often reject probes with **`HTTP 400 Bad Request`**.
2. **Referer Dropping on Cross-Domain Redirects:** When Flutter's `Dio` follows an HTTP 302 redirect from `video.sibnet.ru` to `dv97.sibnet.ru`, it strips custom headers like `Referer` across different domains by default. The Tier 2 storage CDN then rejects the request with **`403 Forbidden`**.
3. **Download Stalls & Token Loss:** The downloader loops on retries until timing out, displaying *"Cache failed"* and refunding tokens.

---

## 2. The Dart `fetchv2` Parity Pitfall

### The Pitfall
In standard Node.js `fetch()`, when a redirect is followed, `res.url` automatically updates to the destination URL.
**However, in Flutter's `flutter_js` Dart bridge (`js_service.dart`):**
* Default requests (`followRedirects: true`) use Dart's `package:http`.
* In `package:http`, `streamed.request.url` is **immutable** and **never updates** upon redirect. It still points to the initial Tier 1 URL.
* Furthermore, because the 302 was already resolved server-side, the final 200 response headers delivered to JS **do not contain the `Location` header**.
* As a result, JS receives the original unresolved Tier 1 URL.

### The Correct Solution: `followRedirects: false`
To capture the 302 destination in `flutter_js`, the JS module **must** pass `{ followRedirects: false }` as the 5th argument to `fetchv2`:

```javascript
// Native Dart bridge triggers sendNativeHttpNoRedirect when followRedirects === false
const probeRes = await fetchv2(
  rawVideoUrl,
  {
    'User-Agent': USER_AGENT,
    Referer: embedUrl,
    Range: 'bytes=0-1',
  },
  'GET',
  null,
  { followRedirects: false }
);

const loc = (probeRes.headers && (probeRes.headers.location || probeRes.headers.Location)) || '';
if (loc) {
  finalVideoUrl = loc.startsWith('//') ? 'https:' + loc : new URL(loc, rawVideoUrl).href;
}
```

---

## 3. The `HEAD` vs `GET Range: 0-1` Trap

* **Never use `HEAD` to probe redirects on video hosting hosts.**
  Many hosts (including Sibnet, Vidmoly, etc.) explicitly reject `HEAD` requests with `400 Bad Request` or `405 Method Not Allowed`.
* **Always use `GET` with `Range: 'bytes=0-1'`.**
  `GET` with a small byte range is universally accepted, returns `206 Partial Content` (or `302 Found`), and exposes the destination `Location` header.

---

## 4. Summary Checklist for Stream Extractors

1. **Pre-resolve all 302 redirects in JavaScript** before returning stream URLs to Flutter.
2. **Pass `{ followRedirects: false }` to `fetchv2`** to intercept 302 `Location` headers.
3. **Use `GET` with `Range: bytes=0-1`**, never `HEAD`.
4. **Attach the exact authorized `Referer` and `Origin` headers** matching the embed page.
5. **Verify that the returned stream URL points directly to the physical storage CDN domain**, not the initial routing domain.
