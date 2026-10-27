# Example — Atsu (image / manga)

A compact manga module (identity SP-IMG-1031) — the smallest complete example of the image flow.
Study it with `docs/04-manga-playbook.md`.

What to look at:

- **Filtered search** — search results are filtered for junk before they reach the user; do the same
  wherever a site mixes ad entries into its search.
- **Chapter list** — `extractChapters` returns ascending, numbered entries; `extractEpisodes` simply
  delegates to it (some apps call the former, some the latter — exporting both is harmless).
- **Image delivery** — `extractImages` returns direct page URLs. Note the `module.json`
  `streamHeaders` block: the image CDN in this ecosystem requires the site's **Referer**, which is the
  #1 cause of 403s on image data (see docs/04).
- **Discovery from existing pieces** — `discoveryHome`/`discoveryFeed` reuse `searchResults` instead of
  inventing new endpoints: a cheap way to give users a home screen without extra site scraping.

Run it live with:

```
node ../tools/run_checks.cjs . --query "one piece" --type image
```
