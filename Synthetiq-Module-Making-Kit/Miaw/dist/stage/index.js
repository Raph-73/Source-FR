/* ============================================================================
 * MIAW — Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * Catalogue: miaw.tv's public JSON API (/api/search, /api/series/<id>/seasons)
 * in fr-FR; posters and stills come from the same TMDB image host the site uses.
 * Playback: the watch API lists the site's own players. "lecteur miaw" (blink)
 * hands out a signed MP4 HD on zen-cdn, reached through two redirects;
 * "lecteur miaw 2" (miaw2) and "lecteur vidzy" answer HLS masters with French
 * and English audio plus a VOSTFR variant; "lecteur moviez" answers an HLS
 * master. The readers run in parallel and every checked rendition is offered
 * with the site's player name and its quality. Each rendition carries the exact
 * headers its host expects.
 *
 * Player order is a compatibility choice, not a speed one: blink's MP4 plays
 * under any client fingerprint, miaw2's HLS is served to a plain request, and
 * Vidzy's CDN hard-blocks player user agents (ExoPlayer, okhttp, VLC) unless the
 * player applies the Firefox headers attached to it. So blink stays first, and
 * miaw2 is the fallback default when blink is late; Vidzy is only ever a
 * deliberate choice.
 * Metadata: the fiche's JSON-LD block carries title, overview, genres, year,
 * poster and season/episode counts.
 * Discovery: the catalogue pages (/movies, /series with sort=rating|recent)
 * are read through the same flight payload the site renders.
 * ==========================================================================*/

(function () {
  'use strict';

  var SITE = 'https://miaw.tv';
  var IMG = 'https://image.tmdb.org/t/p';
  var MOVIEZ = 'https://api.moviez.ac';
  var VIDZY = 'https://vidzy.org';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  /* Vidzy's CDN decoys Chrome/Edge fingerprints whose Accept-Encoding does not
   * advertise br+zstd, and hard-blocks player UAs. A Firefox UA is served the
   * real master for every Accept-Encoding value. */
  var VIDZY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0';

  var JSON_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'fr-FR,fr;q=0.9' };
  var HTML_HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'fr-FR,fr;q=0.9' };
  /* zen-cdn rejects a foreign Referer, uqload and Vidzy accept a plain
   * fingerprint, so the result-level set stays referer-free. Each quality still
   * carries the exact headers its own host expects. */
  var STREAM_HEADERS = { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' };
  /* The blink token endpoint answers a Telegram promo instead of the file when
   * the site Referer is missing, so the redirect chain keeps it. */
  var BLINK_HEADERS = { 'User-Agent': UA, 'Referer': SITE + '/' };
  /* /api/uqload/hd/<id>.m3u8 answers a 302 to the signed strm*.uqload.vc master,
   * which is served to a plain User-Agent (no Referer). */
  var UQLOAD_HEADERS = { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' };
  var MOVIEZ_STREAM_HEADERS = { 'User-Agent': UA, 'Referer': MOVIEZ + '/' };
  /* The real master is only served to the Firefox fingerprint: a Chrome UA gets
   * a decoy playlist whose single variant loops back to itself, and a br/zstd
   * request gets a gzip body. Every Vidzy CDN request uses this set. */
  var VIDZY_STREAM_HEADERS = {
    'User-Agent': VIDZY_UA, 'Accept': '*/*', 'Accept-Encoding': 'identity',
    'Referer': VIDZY + '/', 'Origin': 'https://vidzy.cc'
  };

  var FEEDS = {
    movies_rating: { path: '/movies?sort=rating&page=', kind: 'movie' },
    series_rating: { path: '/series?sort=rating&page=', kind: 'tv' },
    movies_recent: { path: '/movies?sort=recent&page=', kind: 'movie' },
    series_recent: { path: '/series?sort=recent&page=', kind: 'tv' }
  };

  /* --------------------------------------------------------------- helpers */
  function now() { return Date.now(); }
  function left(deadline, cap) { return Math.max(600, Math.min(deadline - now(), cap || 12000)); }
  function merge(a, b) {
    var out = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
    return out;
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /* ------------------------------------------------- rate limit and caching */
  /* The site answers `{"error":{"code":"rate_limited"}}` with HTTP 429 after a
   * burst (measured: ~200 requests in under a minute trip it; 70 requests at
   * ~6/s did not) and stays limited for tens of seconds. Requests to miaw.tv are
   * therefore spaced out, and a 429 both stops the current handler and widens
   * the gap so the following pages do not keep hammering a limited site. */
  var SITE_GAP_MIN = 400;
  var SITE_GAP_MAX = 1500;
  var siteGap = SITE_GAP_MIN;
  var siteGate = Promise.resolve();
  var siteLastAt = 0;
  var siteLimitedUntil = 0;

  function allowed(url) {
    return /^https?:\/\/(?:[a-z0-9-]+\.)?miaw\.tv(?:\/|$)/i.test(String(url || ''));
  }

  /* Measured against the real app runtime: no setTimeout, so a short wait is a
   * microtask spin. Used only between requests (nothing in flight) and behind a
   * 429, never in a hot loop. */
  function pause(ms) {
    var end = now() + ms;
    return new Promise(function (resolve) {
      function tick() {
        if (now() >= end) resolve();
        else Promise.resolve().then(tick);
      }
      tick();
    });
  }

  function pace(url) {
    if (!allowed(url)) return Promise.resolve();
    /* The gap is read after the previous slot finishes, so a 429 that widens
     * siteGap also slows the requests already queued behind it. */
    var slot = siteGate.then(async function () {
      var wait = siteLastAt + siteGap - now();
      if (wait > 0) await pause(Math.min(wait, 900));
      siteLastAt = now();
    });
    siteGate = slot.catch(function () { });
    return slot;
  }

  function isLimited() { return now() < siteLimitedUntil; }
  function markLimited() {
    siteLimitedUntil = now() + 45000;
    siteGap = Math.min(SITE_GAP_MAX, Math.round(siteGap * 1.8));
  }

  var CACHE = {};
  function cacheGet(key) {
    var hit = CACHE[key];
    if (hit && hit.exp > now()) return hit.value;
    return null;
  }
  function cacheSet(key, value, ttl) { CACHE[key] = { value: value, exp: now() + ttl }; }

  function limitedError() {
    var err = new Error('MIAW : le site limite les requêtes (HTTP 429). Réessayez dans une minute.');
    err.limited = true;
    return err;
  }

  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }
  function clean(s) {
    return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' '))
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function img(path, size) {
    var p = String(path == null ? '' : path).trim();
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    return IMG + '/' + size + (p.charAt(0) === '/' ? '' : '/') + p;
  }

  /* ------------------------------------------------------------ identities */
  /* Accepted: series-30984-bleach, tv-30984-s1e1, movie-1368337-lodyssee. */
  function parseRef(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return null;
    var m = raw.match(/^series[-_](\d+)(?:[-_]([a-z0-9][a-z0-9-]*))?/i);
    if (m) {
      var tv = { type: 'tv', id: m[1], slug: m[2] || '' };
      var se = raw.match(/(?:^|[-_])s(\d+)[-_]?e(\d+)/i);
      if (se) { tv.season = Number(se[1]) || 1; tv.episode = Number(se[2]) || 1; }
      return tv;
    }
    m = raw.match(/^tv[-_](\d+)(?:[-_]s(\d+)[-_]?e(\d+))?/i);
    if (m) {
      var ep = { type: 'tv', id: m[1] };
      if (m[2]) { ep.season = Number(m[2]) || 1; ep.episode = Number(m[3]) || 1; }
      return ep;
    }
    m = raw.match(/^movie[-_](\d+)(?:[-_]([a-z0-9][a-z0-9-]*))?/i);
    if (m) return { type: 'movie', id: m[1], slug: m[2] || '' };
    if (/^https?:\/\//i.test(raw)) {
      var s = raw.match(/\/series\/([^\/?#]+)/i);
      if (s) return { type: 'tv', slug: s[1] };
      var f = raw.match(/\/film\/([^\/?#]+)/i);
      if (f) return { type: 'movie', slug: f[1] };
    }
    return null;
  }

  function hrefOf(ref, slug) {
    if (!ref) return '';
    if (ref.type === 'tv') {
      return ref.season
        ? ('tv-' + ref.id + '-s' + ref.season + 'e' + (ref.episode || 1))
        : ('series-' + ref.id + (slug ? '-' + slug : ''));
    }
    return 'movie-' + ref.id + (slug ? '-' + slug : '');
  }

  /* -------------------------------------------------------------- transport */
  async function fetchJson(url, headers, timeoutMs, method, body) {
    await pace(url);
    var res = await fetchv2(url, headers || {}, method || 'GET', body == null ? null : body, { timeoutMs: timeoutMs });
    var status = num(res && (res.status || res.statusCode));
    if (status === 429) markLimited();
    var data = null;
    if (res && typeof res.json === 'function') {
      try { data = await res.json(); } catch (_) { data = null; }
    } else if (res && res.json != null) {
      data = res.json;
    }
    if (data == null && res && typeof res.body === 'string' && res.body) {
      try { data = JSON.parse(res.body); } catch (_) { data = null; }
    }
    return { status: status, data: data, headers: (res && res.headers) || {} };
  }

  async function fetchText(url, headers, timeoutMs) {
    await pace(url);
    var res = await fetchv2(url, headers || {}, 'GET', null, { timeoutMs: timeoutMs });
    var status = num(res && (res.status || res.statusCode));
    if (status === 429) markLimited();
    var text = '';
    if (res && typeof res.text === 'function') text = await res.text();
    else if (res && typeof res.body === 'string') text = res.body;
    return { status: status, text: String(text == null ? '' : text), headers: (res && res.headers) || {} };
  }

  /* ------------------------------------------------------------- the site */
  async function searchApi(term, deadline) {
    return fetchJson(SITE + '/api/search?q=' + encodeURIComponent(term),
      merge(JSON_HEADERS, { 'Referer': SITE + '/' }), left(deadline, 9000));
  }

  function cardOf(item) {
    var kind = item && item.kind;
    if (kind !== 'movie' && kind !== 'series') return null;
    var id = String(item.id || '');
    var slug = String(item.slug || '');
    if (!id) return null;
    var title = clean(item.title || item.originalTitle || '');
    var poster = img(item.posterPath, 'w500');
    if (!title || !poster) return null;
    var href = hrefOf({ type: kind === 'series' ? 'tv' : 'movie', id: id }, slug);
    var card = { id: href, href: href, type: 'video', title: title, image: poster, poster: poster };
    var year = num(item.year);
    if (year) card.year = year;
    var rating = num(item.voteAverage);
    if (rating > 0) card.rating = Math.round(rating * 10) / 10;
    return card;
  }

  function cardsFrom(items, limit) {
    var out = [], seen = {}, i;
    for (i = 0; i < items.length && out.length < limit; i++) {
      var card = cardOf(items[i]);
      if (!card) continue;
      var key = card.href;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(card);
    }
    return out;
  }

  /* ----------------------------------------------------------------- search */
  async function searchResults(query) {
    var term = String(query == null ? '' : query).trim();
    if (!term) return [];
    var key = 'search:' + term.toLowerCase();
    var cached = cacheGet(key);
    if (cached) return cached;
    if (isLimited()) throw limitedError();
    var deadline = now() + 12000;
    var r = await searchApi(term, deadline);
    var titles = r.data && r.data.data && r.data.data.titles;
    if (r.status === 429) throw limitedError();
    if (r.status !== 200 || !Array.isArray(titles)) {
      throw new Error('MIAW search failed (HTTP ' + r.status + ')');
    }
    var cards = cardsFrom(titles, 24);
    cacheSet(key, cards, 180000);
    return cards;
  }

  /* ---------------------------------------------------------------- details */
  function ldBlocks(html) {
    var src = String(html == null ? '' : html);
    var out = [], re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi, m;
    while ((m = re.exec(src))) {
      try {
        var v = JSON.parse(m[1]);
        if (Array.isArray(v)) out = out.concat(v);
        else if (v) out.push(v);
      } catch (_) { /* a broken block is not fatal */ }
    }
    return out;
  }

  function ldTitle(html, type) {
    var list = ldBlocks(html), i;
    for (i = 0; i < list.length; i++) {
      var t = String(list[i] && list[i]['@type'] || '');
      if (type === 'tv' ? /TVSeries|TVSeason/i.test(t) : /Movie/i.test(t)) return list[i];
    }
    return list.length ? list[0] : null;
  }

  function isoMinutes(v) {
    var m = String(v == null ? '' : v).match(/^PT(?:(\d+)H)?(?:(\d+)M)?/i);
    return m ? (Number(m[1] || 0) * 60 + Number(m[2] || 0)) : 0;
  }

  function yearOf(v) {
    var m = String(v == null ? '' : v).match(/^(\d{4})/);
    return m ? Number(m[1]) : undefined;
  }

  function genresOf(j) {
    var out = [], g = j && j.genre;
    if (typeof g === 'string') g = [g];
    if (!Array.isArray(g)) return out;
    for (var i = 0; i < g.length; i++) {
      var name = clean(g[i]);
      if (name) out.push(name);
    }
    return out;
  }

  /* Details and the episode list read the same fiche page, and the app opens
   * them back to back. One cache entry keeps that to a single request. */
  async function fichePage(ref, deadline) {
    var pageUrl = SITE + (ref.type === 'tv' ? '/series/' : '/film/') + encodeURIComponent(ref.slug);
    var key = 'fiche:' + pageUrl;
    var hit = cacheGet(key);
    if (hit) return hit;
    if (isLimited()) throw limitedError();
    var page = await fetchText(pageUrl, JSON_HEADERS, left(deadline, 10000));
    if (page.status === 429) {
      await pause(900);
      page = await fetchText(pageUrl, JSON_HEADERS, left(deadline, 8000));
      if (page.status === 429) throw limitedError();
    }
    if (page.status === 200 && page.text) cacheSet(key, page, 120000);
    return page;
  }

  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref || !ref.slug) throw new Error('MIAW : identifiant invalide.');
    var key = 'details:' + ref.type + ':' + ref.id + ':' + ref.slug;
    var cached = cacheGet(key);
    if (cached) return cached;

    var deadline = now() + 15000;
    var page = await fichePage(ref, deadline);
    if (page.status === 404) throw new Error('MIAW : cette fiche n\'existe pas.');
    if (page.status !== 200 || !page.text) throw new Error('MIAW details failed (HTTP ' + page.status + ')');

    var ld = ldTitle(page.text, ref.type) || {};
    var title = clean(ld.name || ld.alternateName || '');
    if (!title) {
      var og = page.text.match(/<meta property="og:title" content="([^"]*)"/i);
      title = clean(og ? og[1].replace(/^miaw\.tv\s*-\s*/i, '') : '');
    }
    var poster = img(ld.image, 'w780');
    if (!poster) {
      var ogImg = page.text.match(/<meta property="og:image" content="([^"]*)"/i);
      poster = img(ogImg ? ogImg[1] : '', 'w780');
    }

    var out = {
      id: hrefOf(ref, ref.slug), href: hrefOf(ref, ref.slug), url: SITE,
      type: 'video',
      title: title,
      description: clean(ld.description || ''),
      genres: genresOf(ld)
    };
    if (poster) { out.image = poster; out.poster = poster; }
    var year = yearOf(ld.datePublished || ld.startDate);
    if (year) out.year = year;

    if (ref.type === 'tv') {
      var seasons = num(ld.numberOfSeasons), episodes = num(ld.numberOfEpisodes);
      if (seasons) out.seasons = seasons;
      if (episodes) out.episodes = episodes;
      if (ld.endDate) out.status = 'Terminee';
    } else {
      var minutes = isoMinutes(ld.duration);
      if (minutes) out.duration = minutes;
    }
    cacheSet(key, out, 120000);
    return out;
  }

  /* --------------------------------------------------------------- episodes */
  function unescapeFlight(text) {
    return String(text == null ? '' : text).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  function balancedAt(text, start, open, close) {
    if (start < 0 || text.charAt(start) !== open) return '';
    var depth = 0, inStr = false, esc = false, i, ch;
    for (i = start; i < text.length; i++) {
      ch = text.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  function jsonArrayOf(text, key) {
    var at = text.indexOf('"' + key + '":[');
    while (at !== -1) {
      var start = text.indexOf('[', at);
      var raw = balancedAt(text, start, '[', ']');
      if (raw) {
        try {
          var v = JSON.parse(raw);
          if (Array.isArray(v)) return v;
        } catch (_) { /* try the next occurrence */ }
      }
      at = text.indexOf('"' + key + '":[', at + 1);
    }
    return [];
  }

  function seasonsOf(html) {
    var text = unescapeFlight(html);
    var list = jsonArrayOf(text, 'seasons'), out = [], i;
    for (i = 0; i < list.length; i++) {
      var s = list[i] || {}, n = num(s.number);
      if (!n) continue;
      out.push({ number: n, count: num(s.episodeCount) || num(s.count) || 0 });
    }
    out.sort(function (a, b) { return a.number - b.number; });
    return out;
  }

  function seasonsFromLd(html, type) {
    var ld = ldTitle(html, type) || {};
    var total = num(ld.numberOfSeasons), out = [], n;
    for (n = 1; n <= total; n++) out.push({ number: n, count: 0 });
    return out;
  }

  /* The API pages 25 episodes from page 0 and repeats the last page forever
   * once the season is exhausted, so a page that adds nothing new ends the walk.
   * Pages are read one at a time: bursted reads trip the site's rate limit and
   * a 429 is reported instead of being flattened into "no episodes". */
  async function seasonEpisodes(seriesId, season, deadline) {
    var key = 'season:' + seriesId + ':' + season;
    var cached = cacheGet(key);
    if (cached) return cached;
    if (isLimited()) throw limitedError();

    var out = [], seen = {}, page;
    for (page = 0; page <= 23; page++) {
      if (now() >= deadline) break;
      var r = await fetchJson(SITE + '/api/series/' + encodeURIComponent(seriesId) +
        '/seasons/' + season + '?page=' + page,
        merge(JSON_HEADERS, { 'Referer': SITE + '/' }), left(deadline, 9000));
      if (r.status === 429) { markLimited(); throw limitedError(); }
      var list = r.data && r.data.data && r.data.data.episodes;
      if (r.status !== 200 || !Array.isArray(list)) break;
      var added = 0;
      for (var i = 0; i < list.length; i++) {
        var e = list[i] || {};
        var number = num(e.episode), sn = num(e.season) || season;
        if (!number || e.available === false) continue;
        var dedupe = sn + ':' + number;
        if (seen[dedupe]) continue;
        seen[dedupe] = true;
        added++;
        var entry = {
          number: number,
          href: 'tv-' + seriesId + '-s' + sn + 'e' + number,
          title: clean(e.name || ('Episode ' + number)),
          season: sn
        };
        var still = img(e.stillPath, 'w300');
        if (still) entry.image = still;
        out.push(entry);
      }
      if (list.length < 25 || added === 0) break;
    }
    if (out.length) cacheSet(key, out, 300000);
    return out;
  }

  async function extractEpisodes(seriesId) {
    var ref = parseRef(seriesId);
    if (!ref) throw new Error('MIAW : identifiant invalide.');
    if (ref.type === 'movie') {
      return [{ number: 1, href: 'movie-' + ref.id, title: 'Film', season: null }];
    }
    if (!ref.slug) throw new Error('MIAW : identifiant de serie incomplet.');
    var key = 'episodes:' + ref.id;
    var cached = cacheGet(key);
    if (cached) return cached;
    if (isLimited()) throw limitedError();

    var deadline = now() + 30000;
    var page = await fichePage(ref, deadline);
    if (page.status !== 200 || !page.text) throw new Error('MIAW episodes failed (HTTP ' + page.status + ')');

    var seasons = seasonsOf(page.text);
    if (!seasons.length) seasons = seasonsFromLd(page.text, 'tv');
    if (!seasons.length) throw new Error('MIAW : aucune saison listee pour cette serie.');

    var out = [], seen = {}, failed = 0, i, j;
    for (i = 0; i < seasons.length; i++) {
      if (now() >= deadline - 1200) break;
      var list;
      try {
        list = await seasonEpisodes(ref.id, seasons[i].number, deadline);
      } catch (e) {
        /* A rate limit stops the walk: a truncated list would hide episodes, so
         * the caller is told to retry. Completed seasons stay cached, so the
         * retry only reads the seasons that were still missing. */
        if (e && e.limited) throw e;
        failed++;
        continue;
      }
      for (j = 0; j < (list || []).length; j++) {
        var epKey = list[j].season + ':' + list[j].number;
        if (seen[epKey]) continue;
        seen[epKey] = true;
        out.push(list[j]);
      }
    }

    out.sort(function (a, b) { return (a.season - b.season) || (a.number - b.number); });
    if (!out.length) throw new Error('MIAW : aucun episode disponible.');
    cacheSet(key, out, 300000);
    return out;
  }

  /* -------------------------------------------------------------- streaming */
  function streamFail(message) {
    return { streams: [], subtitles: [], lang: 'dub', error: { message: message } };
  }

  function parseAttrs(text) {
    var out = {}, re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi, m;
    while ((m = re.exec(String(text == null ? '' : text)))) {
      out[m[1].toUpperCase()] = String(m[2] || '').replace(/^"|"$/g, '');
    }
    return out;
  }

  function resolveUrl(base, rel) {
    if (/^https?:\/\//i.test(rel)) return rel;
    var b = String(base == null ? '' : base);
    if (rel.charAt(0) === '/') {
      var m = b.match(/^(https?:\/\/[^\/]+)/i);
      return m ? m[1] + rel : rel;
    }
    var cut = b.replace(/[?#].*$/, '');
    return cut.slice(0, cut.lastIndexOf('/') + 1) + rel;
  }

  function parseMaster(text, baseUrl) {
    var lines = String(text == null ? '' : text).split(/\r?\n/), out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
      var attrs = parseAttrs(line.slice(line.indexOf(':') + 1));
      var uri = '';
      for (var j = i + 1; j < lines.length; j++) {
        var candidate = lines[j].replace(/^\s+|\s+$/g, '');
        if (!candidate) continue;
        if (candidate.charAt(0) !== '#') { uri = candidate; break; }
      }
      if (!uri) continue;
      var url = resolveUrl(baseUrl, uri);
      if (!/^https:\/\//i.test(url)) continue;
      var res = String(attrs.RESOLUTION || '').match(/(\d+)\s*x\s*(\d+)/i);
      out.push({
        url: url,
        height: res ? parseInt(res[2], 10) : 0,
        bandwidth: parseInt(String(attrs.BANDWIDTH || '').replace(/[^\d]/g, ''), 10) || 0
      });
    }
    return out;
  }

  function tierLabel(height) {
    if (!height) return 'Auto';
    if (height >= 2000) return '2160p';
    if (height >= 1300) return '1440p';
    if (height >= 900) return '1080p';
    if (height >= 650) return '720p';
    if (height >= 420) return '480p';
    if (height >= 300) return '360p';
    if (height >= 200) return '240p';
    return height + 'p';
  }

  function packHls(list, masterUrl, opts) {
    var headers = (opts && opts.headers) || STREAM_HEADERS;
    var lang = (opts && opts.lang) || 'dub';
    list.sort(function (a, b) {
      return (b.height - a.height) || (b.bandwidth - a.bandwidth);
    });
    var seen = {}, uniq = [], i;
    for (i = 0; i < list.length; i++) {
      var key = list[i].height ? String(list[i].height) : 'auto';
      if (seen[key]) continue;
      seen[key] = true;
      uniq.push(list[i]);
    }
    if (!uniq.length) return null;

    var streams = [], qualities = [], labels = {};
    for (i = 0; i < uniq.length; i++) {
      var v = uniq[i], label = tierLabel(v.height);
      if (labels[label]) continue;
      labels[label] = true;
      streams.push(label, v.url);
      qualities.push({ label: label, height: v.height || undefined, url: v.url, headers: headers });
    }
    if (masterUrl && uniq.length > 1) {
      streams.push('Auto (adaptatif)', masterUrl);
      qualities.push({ label: 'Auto (adaptatif)', url: masterUrl, headers: headers });
    }
    var top = uniq[0];
    var quality = top.height ? tierLabel(top.height) : 'Auto';
    return {
      streams: streams, url: top.url, headers: headers, streamType: 'hls',
      quality: quality, defaultQuality: quality, qualities: qualities,
      subtitles: [], lang: lang
    };
  }

  function packMp4(url, headers, label, lang) {
    var q = { label: label, url: url, headers: headers };
    return {
      streams: [label, url], url: url, headers: headers, streamType: 'mp4',
      quality: label, defaultQuality: label, qualities: [q],
      subtitles: [], lang: lang || 'dub'
    };
  }

  async function watchPlayers(ref, deadline) {
    var url = ref.type === 'tv'
      ? SITE + '/api/watch/series/' + encodeURIComponent(ref.id) + '?season=' + (ref.season || 1) + '&episode=' + (ref.episode || 1)
      : SITE + '/api/watch/movie/' + encodeURIComponent(ref.id);
    var key = 'watch:' + url;
    var cached = cacheGet(key);
    if (cached) return cached;
    if (isLimited()) return null;
    var r = await fetchJson(url, merge(JSON_HEADERS, { 'Referer': SITE + '/' }), left(deadline, 8000));
    var players = r.data && r.data.data && r.data.data.players;
    if (r.status !== 200 || !Array.isArray(players)) return null;
    cacheSet(key, players, 90000);
    return players;
  }

  /*  /api/uqload/hd/<id>.m3u8 answers a 302 to the signed strm*.uqload.vc master
   *  (valid ~4 h). It is the site's own second player ("lecteur miaw 2"), keeps
   *  French and English audio tracks and, unlike blink, exists in a VOSTFR
   *  variant. The master is served to a plain request and to any user agent;
   *  only a foreign Referer makes it redirect to a promo. */
  async function resolveUqload(src, deadline, siteName, isSubLang) {
    var url = /^https?:\/\//i.test(src) ? src : SITE + src;
    var hop = await fetchv2(url, merge(UQLOAD_HEADERS, { 'Referer': SITE + '/' }), 'GET', null,
      { timeoutMs: left(deadline, 4000), followRedirects: false });
    var status = num(hop && (hop.status || hop.statusCode));
    var headers = (hop && hop.headers) || {};
    var loc = headers.location || headers.Location || '';
    var masterUrl = '';
    if (status >= 300 && status < 400 && loc) masterUrl = resolveUrl(url, String(loc));
    else if (status === 200) masterUrl = url;
    if (!/^https:\/\//i.test(masterUrl) || !/\.m3u8(?:$|[?#])/i.test(masterUrl)) return null;

    var master = await fetchText(masterUrl, UQLOAD_HEADERS, left(deadline, 3000));
    if (master.status !== 200 || !master.text) return null;
    var variants = parseMaster(master.text, masterUrl);
    if (!variants.length) return null;
    var isSub = !!isSubLang || /vostfr/i.test(String(src));
    var packed = packHls(variants, masterUrl, { headers: UQLOAD_HEADERS, lang: isSub ? 'sub' : 'dub' });
    if (!packed) return null;
    return {
      player: siteName || 'lecteur miaw 2', provider: 'miaw2', type: 'hls',
      height: (variants[0] && variants[0].height) || 0,
      primary: false, safe: true, pref: 3, packed: packed
    };
  }

  async function resolveBlink(src, deadline, siteName) {
    if (!/^https?:\/\//i.test(src)) src = SITE + src;
    /* The signed file is reached through the CDN and its proxy, and the link
     * handed to the player is the final `?ff=` URL. Every hop carries a
     * one-byte Range so the file itself is never downloaded here; the last hop
     * answers 206 with 2 bytes. The proxy hop regularly takes 2-3 s on a cold
     * title, so the caller gives this reader a wide budget. */
    function readerAt(url) {
      return {
        player: siteName || 'lecteur miaw', provider: 'blink', type: 'mp4',
        height: 0, primary: true, safe: true, pref: 4,
        packed: packMp4(url, STREAM_HEADERS, 'HD', 'dub')
      };
    }
    var cur = src, i;
    for (i = 0; i < 8 && now() < deadline; i++) {
      var res;
      try {
        res = await fetchv2(cur, merge(BLINK_HEADERS, { 'Range': 'bytes=0-1' }), 'GET', null,
          { timeoutMs: left(deadline, 3500), followRedirects: false });
      } catch (err) {
        /* The signed URL usually honours the Range (206, 2 bytes), but the CDN
         * sometimes answers the whole MP4: the sandbox then aborts at its 5 MiB
         * response cap. A body that size is the file itself, so the signed URL
         * is valid. Any other abort stays a failure. */
        var msg = String((err && err.message) || '');
        return /\.mp4\?ff=/i.test(cur) && /exceed|MiB/i.test(msg) ? readerAt(cur) : null;
      }
      var status = num(res && (res.status || res.statusCode));
      var headers = (res && res.headers) || {};
      var loc = headers.location || headers.Location || '';
      if (status >= 300 && status < 400 && loc) {
        cur = resolveUrl(cur, String(loc));
        continue;
      }
      if ((status !== 200 && status !== 206) || !/\.mp4(?:$|[?#])/i.test(cur)) return null;
      var ct = String(headers['content-type'] || '');
      if (ct && !/video|octet-stream/i.test(ct)) return null;
      return readerAt(cur);
    }
    return null;
  }

  function parseP2(html) {
    var m = String(html == null ? '' : html).match(/window\.P2\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (_) { return null; }
  }

  async function resolveMoviez(src, deadline, siteName) {
    var pageUrl = /^https?:\/\//i.test(src) ? src : MOVIEZ + src;
    var page = await fetchText(pageUrl, merge(HTML_HEADERS, { 'Referer': SITE + '/' }), left(deadline, 8000));
    if (page.status !== 200 || !page.text) return null;
    var cfg = parseP2(page.text);
    if (!cfg || !cfg.t) return null;

    var r = await fetchJson(MOVIEZ + '/api/v2/stream', merge(JSON_HEADERS, {
      'Content-Type': 'application/json',
      'Referer': pageUrl,
      'Origin': MOVIEZ
    }), left(deadline, 8000), 'POST', JSON.stringify({ t: cfg.t }));
    if (r.status !== 200 || !r.data || !r.data.hls) return null;

    var master = await fetchText(String(r.data.hls), merge(MOVIEZ_STREAM_HEADERS, { 'Accept': '*/*' }), left(deadline, 6000));
    var variants = master.status === 200 ? parseMaster(master.text, String(r.data.hls)) : [];
    var lang = String(cfg.lang || 'vf') === 'vostfr' ? 'sub' : 'dub';
    var packed = variants.length
      ? packHls(variants, String(r.data.hls), { headers: MOVIEZ_STREAM_HEADERS, lang: lang })
      : packMp4(String(r.data.hls), MOVIEZ_STREAM_HEADERS, 'Auto', lang);
    if (!packed) return null;
    packed.streamType = 'hls';
    return {
      player: siteName || 'lecteur moviez', provider: 'moviez', type: 'hls',
      height: (variants[0] && variants[0].height) || 0,
      safe: true, pref: 1, packed: packed
    };
  }

  function vidzySourceOf(html) {
    var m = String(html == null ? '' : html).match(/sources:\s*\[\{\s*src:\s*"([^"]+)"/i);
    if (!m) return '';
    var host = String(m[1]).match(/^https:\/\/([^\/?#]+)/i);
    if (!host || !/(^|\.)vidzy\.(?:cc|org|live)$/i.test(host[1])) return '';
    return m[1];
  }

  async function resolveVidzy(src, deadline, siteName, isSubLang) {
    var pageUrl = /^https?:\/\//i.test(src) ? src : VIDZY + src;
    var isSub = !!isSubLang || /\/vostfr(?:[?#]|$)/i.test(pageUrl);
    var page = await fetchText(pageUrl, merge(HTML_HEADERS, {
      'User-Agent': VIDZY_UA, 'Referer': SITE + '/', 'Accept-Encoding': 'identity'
    }), left(deadline, 6000));
    if (page.status !== 200 || !page.text) return null;
    var embed = (page.text.match(/(?:src|data-src)="(https:\/\/vidzy\.(?:cc|org|live)\/embed-[^"]+?\.html)"/i) || [])[1];
    if (!embed) return null;

    var emb = await fetchText(embed, merge(VIDZY_STREAM_HEADERS, { 'Referer': VIDZY + '/' }), left(deadline, 6000));
    if (emb.status !== 200 || !emb.text) return null;
    var srcUrl = vidzySourceOf(emb.text);
    if (!srcUrl) return null;

    var headers = merge(VIDZY_STREAM_HEADERS, { 'Referer': embed });
    var master = await fetchText(srcUrl, merge(headers, { 'Accept': 'application/vnd.apple.mpegurl,*/*' }), left(deadline, 5000));
    var variants = master.status === 200 ? parseMaster(master.text, srcUrl) : [];
    if (variants.length === 1 && /\/index\.m3u8(?:\?|$)/i.test(variants[0].url)) variants = [];
    var lang = isSub ? 'sub' : 'dub';
    var packed = variants.length
      ? packHls(variants, srcUrl, { headers: headers, lang: lang })
      : packMp4(srcUrl, headers, 'Auto', lang);
    if (!packed) return null;
    packed.streamType = 'hls';
    return {
      player: siteName || 'lecteur vidzy', provider: 'vidzy', type: 'hls',
      height: (variants[0] && variants[0].height) || 0,
      primary: false, safe: false, pref: 2, packed: packed
    };
  }

  function readerLabel(reader) {
    return reader.player + (reader.lang === 'sub' || reader.packed.lang === 'sub' ? ' VOSTFR' : '');
  }

  function composeReaders(readers) {
    var order = readers.filter(function (r) { return !!(r && r.packed && r.packed.url); });
    if (!order.length) return null;

    /* Every checked rendition from every reader is offered. Measured heights
     * rank highest first, but preference breaks ties between readers in a
     * deliberate order: blink's MP4 first, then miaw2, then Vidzy, then moviez.
     * See the header note on why Vidzy never becomes the default. */
    var candidates = [], labels = {}, r, i;
    for (r = 0; r < order.length; r++) {
      var reader = order[r];
      var prefix = readerLabel(reader);
      var list = reader.packed.qualities || [];
      var limit = r === 0 ? 4 : 3;
      for (i = 0; i < list.length && i < limit; i++) {
        var q = list[i];
        if (!q || !q.url) continue;
        var label = prefix + ' \u00b7 ' + q.label;
        if (labels[label]) continue;
        labels[label] = true;
        candidates.push({
          label: label,
          tier: q.label,
          url: q.url,
          headers: q.headers || reader.packed.headers,
          height: q.height || 0,
          primary: reader.primary ? 1 : 0,
          pref: reader.pref || 0,
          type: q.height ? (reader.packed.streamType || 'hls') : (reader.type || reader.packed.streamType),
          lang: q.lang || reader.packed.lang || 'dub',
          provider: reader.provider || reader.player,
          reader: r,
          seq: candidates.length
        });
      }
    }
    if (!candidates.length) return null;

    candidates.sort(function (a, b) {
      return (b.primary - a.primary) || (b.pref - a.pref) || (b.height - a.height) || (a.seq - b.seq);
    });

    /* `streams` is the flat label/URL list read by older clients, which apply
     * the response-level headers to every pair. It therefore carries only the
     * default reader's renditions: those are the ones whose headers it shares.
     * Every checked rendition, with its own host headers, is in `qualities`
     * and `servers`. */
    var top = candidates[0];
    var entries = [], streams = [];
    for (i = 0; i < candidates.length; i++) {
      entries.push({ label: candidates[i].label, url: candidates[i].url, headers: candidates[i].headers });
      if (candidates[i].reader === top.reader) {
        streams.push((candidates[i].lang === 'sub' ? 'sub ' : 'dub ') + candidates[i].label, candidates[i].url);
      }
    }
    return {
      url: top.url,
      /* The exact headers of the opened rendition, so a player that only reads
       * the result-level set still gets the right fingerprint. */
      headers: top.headers,
      streamType: top.type || 'hls',
      quality: top.tier,
      defaultQuality: top.tier,
      streams: streams,
      qualities: entries,
      subtitles: [],
      lang: top.lang,
      provider: top.provider,
      servers: order.map(function (rd) {
        var best = (rd.packed.qualities && rd.packed.qualities[0]) || {};
        return {
          name: rd.player,
          label: best.label || 'Auto',
          url: rd.packed.url,
          headers: rd.packed.headers,
          streamType: rd.packed.streamType || 'hls',
          lang: rd.packed.lang || 'dub',
          qualities: rd.packed.qualities || []
        };
      })
    };
  }

  async function extractStreamUrl(episodeHref, lang) {
    var ref = parseRef(episodeHref);
    if (!ref) return streamFail('MIAW : identifiant invalide.');
    if (ref.type === 'tv' && (!ref.season || !ref.episode)) {
      ref.season = ref.season || 1;
      ref.episode = ref.episode || 1;
    }
    var wantSub = String(lang || '').toLowerCase() === 'sub';
    var cacheKey = 'stream:' + (ref.type === 'tv'
      ? 'tv-' + ref.id + '-s' + ref.season + 'e' + ref.episode
      : 'movie-' + ref.id) + ':' + (wantSub ? 'sub' : 'dub');
    var cached = cacheGet(cacheKey);
    if (cached) return cached;
    if (isLimited()) return streamFail(limitedError().message);

    var deadline = now() + 20000;
    var players = await watchPlayers(ref, deadline);
    if (!players || !players.length) {
      return streamFail('MIAW : aucun lecteur disponible pour ce titre. Reessayez plus tard ou choisissez un autre titre.');
    }

    var blinkSrc = '', blinkName = '', uqSrc = '', uqName = '', uqSubSrc = '', uqSubName = '';
    var vidzySrc = '', vidzyName = '', vidzySubSrc = '', vidzySubName = '', moviezSrc = '', moviezName = '';
    for (var i = 0; i < players.length; i++) {
      var p = players[i] || {};
      var src = String(p.src || '');
      if (!src) continue;
      var siteName = String(p.name || '').replace(/\s*-\s*avec pub.*$/i, '').trim();
      var isSub = /vostfr/i.test(String(p.entryId || '')) || String(p.language || '') === 'vostfr';
      if (/\/api\/blink\/v\//i.test(src)) { if (!blinkSrc) { blinkSrc = src; blinkName = siteName; } }
      else if (/\/api\/uqload\/hd\/[^\/?#]+\.m3u8/i.test(src)) {
        if (isSub) { if (!uqSubSrc) { uqSubSrc = src; uqSubName = siteName; } }
        else if (!uqSrc) { uqSrc = src; uqName = siteName; }
      } else if (p.type === 'vidzy' || /^https:\/\/vidzy\./i.test(src)) {
        if (isSub) { if (!vidzySubSrc) { vidzySubSrc = src; vidzySubName = siteName; } }
        else if (!vidzySrc) { vidzySrc = src; vidzyName = siteName; }
      } else if (!moviezSrc && (p.type === 'moviez' || /^https:\/\/api\.moviez\.ac\//i.test(src))) {
        moviezSrc = src; moviezName = siteName;
      }
    }
    /* A subtitle request opens the VOSTFR rendition when the site publishes one. */
    var uqPick, uqPickName, uqPickSub, vidzyPick, vidzyPickName, vidzyPickSub;
    if (wantSub) {
      uqPick = uqSubSrc || uqSrc;
      uqPickName = uqSubSrc ? uqSubName : uqName;
      uqPickSub = !!uqSubSrc;
      vidzyPick = vidzySubSrc || vidzySrc;
      vidzyPickName = vidzySubSrc ? vidzySubName : vidzyName;
      vidzyPickSub = !!vidzySubSrc;
    } else {
      uqPick = uqSrc || uqSubSrc;
      uqPickName = uqSrc ? uqName : uqSubName;
      uqPickSub = !uqSrc && !!uqSubSrc;
      vidzyPick = vidzySrc || vidzySubSrc;
      vidzyPickName = vidzySrc ? vidzyName : vidzySubName;
      vidzyPickSub = !vidzySrc && !!vidzySubSrc;
    }

    /* The three readers are bounded and started together. blink's chain has a
     * proxy hop that regularly needs 2-3 s on a cold title (a 2.5 s cap dropped
     * the site's own HD player), so it gets the widest budget; the two HLS
     * backups answer in under a second when their token service is warm. */
    var settled = await Promise.all([
      blinkSrc ? resolveBlink(blinkSrc, now() + 6000, blinkName).catch(function () { return null; }) : null,
      uqPick ? resolveUqload(uqPick, now() + 3200, uqPickName, uqPickSub).catch(function () { return null; }) : null,
      vidzyPick ? resolveVidzy(vidzyPick, now() + 2800, vidzyPickName, vidzyPickSub).catch(function () { return null; }) : null
    ]);

    var readers = [];
    for (var j = 0; j < settled.length; j++) if (settled[j]) readers.push(settled[j]);
    /* Only the VOSTFR renditions carry subtitled audio here. A subtitle request
     * promotes one only when its host tolerates the player's own user agent
     * (miaw2); Vidzy blocks player fingerprints, so promoting it would swap a
     * working VF stream for one that answers 403 on the device. */
    if (wantSub) {
      var subReader = null, k;
      for (k = 0; k < readers.length; k++) {
        if (readers[k].packed.lang !== 'sub') continue;
        if (!subReader || (readers[k].safe && !subReader.safe)) subReader = readers[k];
      }
      if (subReader && subReader.safe) {
        for (k = 0; k < readers.length; k++) readers[k].primary = readers[k] === subReader;
      }
    }
    var composed = composeReaders(readers);
    if (!composed && moviezSrc) {
      /* Moviez only runs when nothing else answered: its page/stream service
       * regularly needs several seconds, so it never delays a working player. */
      var mz = await resolveMoviez(moviezSrc, now() + 4000, moviezName).catch(function () { return null; });
      if (mz) composed = composeReaders([mz]);
    }
    if (composed) {
      cacheSet(cacheKey, composed, 60000);
      return composed;
    }
    return streamFail('MIAW : les lecteurs du site n\'ont pas fourni de flux pour ce titre.');
  }

  /* -------------------------------------------------------------- discovery */
  function itemsOf(html) {
    var text = unescapeFlight(html);
    var out = [], at = text.indexOf('"item":');
    while (at !== -1) {
      var start = text.indexOf('{', at);
      var raw = balancedAt(text, start, '{', '}');
      if (raw) {
        try {
          var v = JSON.parse(raw);
          if (v && (v.kind === 'movie' || v.kind === 'series') && v.id) out.push(v);
        } catch (_) { /* skip a malformed item */ }
      }
      at = text.indexOf('"item":', at + 7);
    }
    return out;
  }

  /* Catalogue pages are cached: the app re-opens home/tabs often and every
   * saved request is one less chance of tripping the site's rate limit. */
  async function pageItems(path, deadline) {
    var key = 'page:' + path;
    var cached = cacheGet(key);
    if (cached) return cached;
    if (isLimited()) return [];
    var r = await fetchText(SITE + path, HTML_HEADERS, left(deadline, 7000));
    if (r.status !== 200 || !r.text) return [];
    var items = itemsOf(r.text);
    if (items.length) cacheSet(key, items, 180000);
    return items;
  }

  async function discoveryHome() {
    var cachedHome = cacheGet('home');
    if (cachedHome) return cachedHome;
    var deadline = now() + 9000;
    var lists = await Promise.all([
      pageItems('/movies?sort=rating&page=1', deadline),
      pageItems('/series?sort=rating&page=1', deadline),
      pageItems('/movies?sort=recent&page=1', deadline),
      pageItems('/series?sort=recent&page=1', deadline)
    ]);
    var movieTop = lists[0], seriesTop = lists[1], movieNew = lists[2], seriesNew = lists[3];

    /* The homepage rails are the fallback when a catalogue page is unavailable. */
    if (!movieTop.length && !seriesTop.length && !movieNew.length && !seriesNew.length) {
      var fallback = await pageItems('/', deadline);
      var movies = [], shows = [], f;
      for (f = 0; f < fallback.length; f++) {
        if (fallback[f].kind === 'movie') movies.push(fallback[f]);
        else shows.push(fallback[f]);
      }
      if (movies.length) movieNew = movieNew.concat(movies);
      if (shows.length) seriesNew = seriesNew.concat(shows);
    }

    var sections = [], seen = {}, i, j;

    /* Hero slots use the portrait poster as their image: the app paints it into
     * the tall header, where a landscape backdrop would be crop-filled. */
    var heroItems = [];
    var interleaved = [];
    for (i = 0; i < 8; i++) {
      if (movieTop[i]) interleaved.push(movieTop[i]);
      if (seriesTop[i]) interleaved.push(seriesTop[i]);
    }
    for (i = 0; i < interleaved.length && heroItems.length < 8; i++) {
      var heroKey = interleaved[i].kind + ':' + interleaved[i].id;
      if (seen[heroKey]) continue;
      seen[heroKey] = true;
      heroItems.push(interleaved[i]);
    }
    var hero = cardsFrom(heroItems, 8);
    if (hero.length) sections.push({ id: 'hero', title: 'A la une', style: 'hero', items: hero, viewAll: { mode: 'feed', feedId: 'movies_rating' } });

    var defs = [
      { id: 'movies-rating', title: 'Films les mieux notes', list: movieTop, feedId: 'movies_rating' },
      { id: 'series-rating', title: 'Series les mieux notees', list: seriesTop, feedId: 'series_rating' },
      { id: 'movies-recent', title: 'Films ajoutes recemment', list: movieNew, feedId: 'movies_recent' },
      { id: 'series-recent', title: 'Series ajoutees recemment', list: seriesNew, feedId: 'series_recent' }
    ];
    for (j = 0; j < defs.length; j++) {
      var cards = cardsFrom(defs[j].list, 24);
      if (!cards.length) continue;
      sections.push({
        id: defs[j].id, title: defs[j].title, style: 'poster', items: cards,
        viewAll: { mode: 'feed', feedId: defs[j].feedId }
      });
    }
    /* An empty result means the site refused the requests, not that the
     * catalogue is empty: caching it would freeze a failure in place. */
    if (sections.length) cacheSet('home', { sections: sections }, 240000);
    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    var pageNum = Math.max(1, Number(page) || 1);
    var feed = FEEDS[String(feedId == null ? '' : feedId)];
    if (!feed) return { items: [], page: pageNum, hasMore: false };

    var items = await pageItems(feed.path + pageNum, now() + 9000);
    var cards = cardsFrom(items, 50);
    return { items: cards, page: pageNum, hasMore: cards.length >= 20 };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
