# 05 · Testing, evidence and shipping

## The local harness (in `tools/`)

You can run preliminary checks without the app. `tools/local_runtime.cjs` is a partial
Node approximation, not the Flutter runtime or a security boundary. It models some
fetchv2 behavior. `tools/run_checks.cjs` walks one selected path through the handlers:

```bash
node tools/run_checks.cjs /path/to/MyModule --query "matrix" --lang sub
```

It checks sampled container signatures and simple HLS routes, or first/last image
signatures. It caps each probe at 256 KiB even if the server ignores Range. It does
not decode media. Check unsupported cases with S2 and the actual app, rather than
weakening a check just to obtain a pass. See docs/10-audit-and-limits.md.

Run this after EVERY change — sites drift, and a module that worked yesterday is worth re-proving today.

## The test matrix (what "works" means)

| stage | you must observe |
|---|---|
| search | ≥ 1 card for a common query; title + image sane; ids stable across two identical calls |
| details | real title + description; no crash for a valid id |
| episodes / chapters | full list (count it against the site); ascending; ids resolvable |
| stream / images | real bytes: `video/mp4` (range probe) for video; JPEG/PNG/WebP magic for manga |
| second sample | a *different* title/chapter also resolves — one lucky hit is not a module |
| latency | `extractStreamUrl` returns inside ~16 s; screens feel snappy |

These are preliminary checks. **HTTP 200 is not playback proof.** Confirm media
decoding and advancing playback with sound in the real app. Image-only playlists
are not video. An extension or MIME type alone does not identify the actual bytes.

## Evidence discipline (the part everyone skips)

When you report back, split your findings into three boxes:

1. **Verified** — "search returned 6 cards; episode 1 resolved to a googlevideo MP4; a 64 KB range
   download returned `video/mp4`". Include the actual commands/snippets.
2. **Flaky / conditional** — "one of five titles failed to resolve (dead upstream video); retried once,
   still dead".
3. **Unverified** — "audible playback on a physical device was not tested; screenshots from the app not
   captured".

Never dress box 2/3 up as box 1 — the owner will trust your next report more, not less.

## Packaging & publishing

- Package: flat ZIP (`module.json` + `index.js`), bump `moduleVersion`, keep identity identical,
  record SHA-256 (`shasum -a 256`).
- **Repositories**: users install either from a repository index (a JSON listing of ZIP URLs + hashes)
  or by importing the ZIP directly. There are usually an official catalogue and a community/testing
  catalogue; the testing one is where new modules prove themselves first.
- **Identity allocation**: the catalogue owner assigns the `moduleIdentity` + number. Until then use
  `PENDING-OWNER-ALLOCATION`; never invent a "probably free" identity for a public release.
- **Update = same identity, new version.** The old ZIP is **retired, not deleted** (a `retired-packages`
  list in the repo). Keep the naming consistent: `MyModule-1.2.0.zip`.
- After publishing, verify the published file byte-for-byte against your local build
  (`shasum -a 256` on both; they must match) and confirm the index shows the new version.

## Release checklist

- [ ] Live harness passes the full matrix (two samples per stage)
- [ ] Media bytes verified (video or images)
- [ ] Video S2 result recorded and real app playback advances with correct audio
- [ ] Pause, seek, subtitles, downloads and offline tested separately
- [ ] Manifest: caps in range, icon URL returns 200 `image/*`, `contractVersion` 4, `runtime.mode` local
- [ ] ZIP is flat and contains nothing else
- [ ] `moduleVersion` bumped; identity unchanged
- [ ] SHA-256 recorded; published copy verified identical
- [ ] Report written (verified / flaky / unverified)
