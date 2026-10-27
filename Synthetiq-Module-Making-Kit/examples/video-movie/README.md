# Example — Movie Direct (video / movies)

A production module (identity SP-VID-075) built from this playbook. Study it together with
`docs/03-movies-playbook.md`.

What to look at:

- **Catalogue via TMDB** — search/details come from `api.themoviedb.org/3`. Note how the module
  normalises TMDB ids into its own `m:<id>` style hrefs and reads them back later.
  *The TMDB key in this copy is a placeholder — register your own free key and never redistribute a
  shared one.*
- **Multi-endpoint provider resolution** — `ENGLISH_ENDPOINTS` lists several playback providers; the
  module walks them in order and returns the first verified route. Copy this shape for any site where
  playback comes from more than one place.
- **Obfuscation done right** — the player API needs a tiny char-code "magic" value; it's a plain array
  in the code. This is the kind of small transform you may have to port from the site's own JS (never
  a full cipher — that's a stop-and-report).
- **A movie is one episode** — see `extractEpisodes` returning a single entry.
- **Discovery rows** — `discoveryHome`/`discoveryFeed` show how to shape sections/feeds (hero ≤ 8).

Run it live against your site with:

```
node ../tools/run_checks.cjs . --query "matrix" --lang sub
```
