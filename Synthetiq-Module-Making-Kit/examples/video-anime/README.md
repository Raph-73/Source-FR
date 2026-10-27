# Example — Goyabu (video / anime, pt-BR)

A compact, modern module (identity SP-VID-082) that shows the HTML + JSON + token-resolver pattern
end-to-end. Study it with `docs/03-movies-playbook.md` and `docs/06-field-notes-and-traps.md`.

What to look at:

- **HTML search, JSON lists** — search parses `<article>` cards with a regex; the episode list is a
  `const allEpisodes=[…]` JSON blob extracted by **bracket-walking** to the matching `]` (a regex to the
  first `]` truncates nested arrays).
- **Session API in action** — `wpNonce()`/`fetchFilterPage()` fetch a page first (which sets cookies the
  runtime keeps), read the `nonce` out of its HTML, then call the site's JSON API with the same client.
  Stale nonce → 403 → refresh and retry once. This is the pattern for any WordPress-ish site.
- **Token resolution** — playback comes from a Blogger embed token; the resolver walks
  `video.g → batchexecute → googlevideo` (docs/03 "Resolving embeds"). Note the response is XSSI-framed
  (`)]}'…`) — a great example of why you keep raw text available.
- **Verification before returning** — a 2-byte range probe decides whether a route goes to the player.
- **Adult filtering + labels** — the module harvests the site's +18 genre and filters every surface; all
  cards carry honest Dublado/Legendado labels.

Run it live with:

```
node ../tools/run_checks.cjs . --query "naruto" --lang dub
```
