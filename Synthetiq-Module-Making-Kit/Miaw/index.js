/* ============================================================================
 * MIAW — Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * Catalogue: miaw.tv's public JSON API (/api/search, /api/series/<id>/seasons)
 * in fr-FR; posters and stills come from the same TMDB image host the site uses.
 * Playback: the watch API lists the site's own players. "blink" hands out a
 * signed MP4 on zen-cdn, reached through two redirects; moviez answers an HLS
 * master (1080p/720p/360p) and vidzy an HLS master with a VOSTFR variant. The
 * readers run in parallel and every checked rendition is offered with its
 * player name and quality; measured heights rank highest first and blink, the
 * player the site opens by default, keeps the top slot. Each rendition carries
 * the exact headers its host expects, and the response-level headers are the
 * one set all of them accept.
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
  /* One set for every rendition returned by the picker: the zen-cdn MP4 rejects
   * a foreign Referer and Vidzy rejects a non-Firefox User-Agent, so the common
   * denominator is the Firefox fingerprint with no Referer at all. */
  var STREAM_HEADERS = { 'User-Agent': VIDZY_UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' };
  /* The blink token endpoint answers a Telegram promo instead of the file when
   * the site Referer is missing, so the redirect chain keeps it. */
  var BLINK_HEADERS = { 'User-Agent': UA, 'Referer': SITE + '/' };
  var MOVIEZ_STREAM_HEADERS = { 'User-Agent': UA, 'Referer': MOVIEZ + '/' };
  var VIDZY_STREAM_HEADERS = merge(STREAM_HEADERS, { 'Referer': VIDZY + '/', 'Origin': 'https://vidzy.cc' });

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
    var res = await fetchv2(url, headers || {}, method || 'GET', body == null ? null : body, { timeoutMs: timeoutMs });
    var status = num(res && (res.status || res.statusCode));
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
    var res = await fetchv2(url, headers || {}, 'GET', null, { timeoutMs: timeoutMs });
    var status = num(res && (res.status || res.statusCode));
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
    var deadline = now() + 12000;
    var r = await searchApi(term, deadline);
    var titles = r.data && r.data.data && r.data.data.titles;
    if (r.status !== 200 || !Array.isArray(titles)) {
      throw new Error('MIAW search failed (HTTP ' + r.status + ')');
    }
    return cardsFrom(titles, 24);
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

  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref || !ref.slug) throw new Error('MIAW : identifiant invalide.');
    var deadline = now() + 15000;
    var pageUrl = SITE + (ref.type === 'tv' ? '/series/' : '/film/') + encodeURIComponent(ref.slug);
    var page = await fetchText(pageUrl, JSON_HEADERS, left(deadline, 10000));
    if (page.status === 404) throw new Error('MIAW : cette fiche n\'existe pas.');
    if (page.status !== 200 || !page.text) throw new Error('MIAW details failed (HTTP ' + page.status + ')');

    var ld = ldTitle(page.text, ref.type) || {};
    var title = clean(ld.name || ld.alternateName || '');
    if (!title) {
      var og = page.text.match(/<meta property="og:title" content="([^"]*)"/i);
      title = clean(og ? og[1].replace(/^miaw\.tv\s*-\s*/i, '') : '');
    }
    var poster = img(ld.image, 'w780');
    if (!poster) return null;

    var out = {
      id: hrefOf(ref, ref.slug), href: hrefOf(ref, ref.slug), url: SITE,
      type: 'video',
      title: title,
      description: clean(ld.description || ''),
      image: poster,
      poster: poster,
      genres: genresOf(ld)
    };
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
   * once the season is exhausted, so a page that adds nothing new ends the walk. */
  async function seasonEpisodes(seriesId, season, deadline) {
    var out = [], seen = {}, page;
    for (page = 0; page <= 23; page++) {
      if (now() >= deadline) break;
      var r = await fetchJson(SITE + '/api/series/' + encodeURIComponent(seriesId) +
        '/seasons/' + season + '?page=' + page,
        merge(JSON_HEADERS, { 'Referer': SITE + '/' }), left(deadline, 9000));
      var list = r.data && r.data.data && r.data.data.episodes;
      if (r.status !== 200 || !Array.isArray(list)) break;
      var added = 0;
      for (var i = 0; i < list.length; i++) {
        var e = list[i] || {};
        var number = num(e.episode), sn = num(e.season) || season;
        if (!number || e.available === false) continue;
        var key = sn + ':' + number;
        if (seen[key]) continue;
        seen[key] = true;
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
    return out;
  }

  async function mapLimit(list, limit, fn) {
    var out = new Array(list.length), next = 0;
    async function worker() {
      while (next < list.length) {
        var i = next++;
        out[i] = await fn(list[i], i).catch(function () { return []; });
      }
    }
    var workers = [], n = Math.min(limit, list.length);
    for (var i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  async function extractEpisodes(seriesId) {
    var ref = parseRef(seriesId);
    if (!ref) throw new Error('MIAW : identifiant invalide.');
    if (ref.type === 'movie') {
      return [{ number: 1, href: 'movie-' + ref.id, title: 'Film', season: null }];
    }
    if (!ref.slug) throw new Error('MIAW : identifiant de serie incomplet.');

    var deadline = now() + 26000;
    var page = await fetchText(SITE + '/series/' + encodeURIComponent(ref.slug), JSON_HEADERS, left(deadline, 9000));
    if (page.status !== 200 || !page.text) throw new Error('MIAW episodes failed (HTTP ' + page.status + ')');

    var seasons = seasonsOf(page.text);
    if (!seasons.length) seasons = seasonsFromLd(page.text, 'tv');
    if (!seasons.length) throw new Error('MIAW : aucune saison listee pour cette serie.');

    var lists = await mapLimit(seasons, 3, function (s) {
      return seasonEpisodes(ref.id, s.number, deadline);
    });

    var out = [], seen = {};
    for (var i = 0; i < lists.length; i++) {
      var list = lists[i] || [];
      for (var j = 0; j < list.length; j++) {
        var key = list[j].season + ':' + list[j].number;
        if (seen[key]) continue;
        seen[key] = true;
        out.push(list[j]);
      }
    }
    out.sort(function (a, b) { return (a.season - b.season) || (a.number - b.number); });
    if (!out.length) throw new Error('MIAW : aucun episode disponible.');
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
    var r = await fetchJson(url, merge(JSON_HEADERS, { 'Referer': SITE + '/' }), left(deadline, 10000));
    var players = r.data && r.data.data && r.data.data.players;
    if (r.status !== 200 || !Array.isArray(players)) return null;
    return players;
  }

  async function resolveBlink(src, deadline) {
    if (!/^https?:\/\//i.test(src)) src = SITE + src;
    /* The signed file is reached through the CDN and its proxy, and the link
     * handed to the player is the final `?ff=` URL. Every hop carries a
     * one-byte Range so the file itself is never downloaded here; the last hop
     * answers 206 with 2 bytes. */
    var cur = src, i;
    for (i = 0; i < 6 && now() < deadline; i++) {
      var res = await fetchv2(cur, merge(BLINK_HEADERS, { 'Range': 'bytes=0-1' }), 'GET', null,
        { timeoutMs: left(deadline, 4000), followRedirects: false });
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
      return {
        player: 'Miaw', type: 'mp4', height: 0, primary: true,
        packed: packMp4(cur, STREAM_HEADERS, 'HD', 'dub')
      };
    }
    return null;
  }

  function parseP2(html) {
    var m = String(html == null ? '' : html).match(/window\.P2\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (_) { return null; }
  }

  async function resolveMoviez(src, deadline) {
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
    return { player: 'Moviez', type: 'hls', height: (variants[0] && variants[0].height) || 0, packed: packed };
  }

  function vidzySourceOf(html) {
    var m = String(html == null ? '' : html).match(/sources:\s*\[\{\s*src:\s*"([^"]+)"/i);
    if (!m) return '';
    var host = String(m[1]).match(/^https:\/\/([^\/?#]+)/i);
    if (!host || !/(^|\.)vidzy\.(?:cc|org|live)$/i.test(host[1])) return '';
    return m[1];
  }

  async function resolveVidzy(src, deadline) {
    var pageUrl = /^https?:\/\//i.test(src) ? src : VIDZY + src;
    var isSub = /\/vostfr(?:[?#]|$)/i.test(pageUrl);
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
    return { player: 'Vidzy', type: 'hls', height: (variants[0] && variants[0].height) || 0, packed: packed };
  }

  function readerLabel(reader) {
    return reader.player + (reader.lang === 'sub' || reader.packed.lang === 'sub' ? ' VOSTFR' : '');
  }

  function composeReaders(readers) {
    var order = readers.filter(function (r) { return !!(r && r.packed && r.packed.url); });
    if (!order.length) return null;

    /* Every checked rendition from every reader is offered. Measured heights
     * rank highest first, but the site's own player (blink) is the one its page
     * starts automatically and its MP4 declares no resolution, so it keeps the
     * top slot instead of being sorted below an HLS rendition. */
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
          url: q.url,
          headers: q.headers || reader.packed.headers,
          height: q.height || 0,
          primary: reader.primary ? 1 : 0,
          type: q.height ? (reader.packed.streamType || 'hls') : (reader.type || reader.packed.streamType),
          lang: q.lang || reader.packed.lang || 'dub',
          provider: reader.player,
          seq: candidates.length
        });
      }
    }
    if (!candidates.length) return null;

    candidates.sort(function (a, b) {
      return (b.primary - a.primary) || (b.height - a.height) || (a.seq - b.seq);
    });

    var entries = [], streams = [];
    for (i = 0; i < candidates.length; i++) {
      entries.push({ label: candidates[i].label, url: candidates[i].url, headers: candidates[i].headers });
      streams.push(candidates[i].label, candidates[i].url);
    }

    var top = candidates[0];
    return {
      url: top.url,
      /* The default headers are the common set every listed rendition accepts;
       * each quality still carries the exact headers its host expects. */
      headers: STREAM_HEADERS,
      streamType: top.type || 'hls',
      quality: top.label,
      defaultQuality: top.label,
      streams: streams,
      qualities: entries,
      subtitles: [],
      lang: top.lang,
      provider: top.provider,
      servers: order.map(function (rd) {
        return {
          name: rd.player,
          label: readerLabel(rd),
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

    var deadline = now() + 22000;
    var players = await watchPlayers(ref, deadline);
    if (!players || !players.length) {
      return streamFail('MIAW : aucun lecteur disponible pour ce titre. Reessayez plus tard ou choisissez un autre titre.');
    }

    var wantSub = String(lang || '').toLowerCase() === 'sub';
    var blinkSrc = '', moviezSrc = '', vidzySrc = '', vidzySubSrc = '';
    for (var i = 0; i < players.length; i++) {
      var p = players[i] || {};
      var src = String(p.src || '');
      if (!src) continue;
      if (p.entryId === 'blink:vf' || /\/api\/blink\/v\//i.test(src)) blinkSrc = src;
      else if (p.type === 'moviez' || /^https:\/\/api\.moviez\.ac\//i.test(src)) moviezSrc = src;
      else if (p.type === 'vidzy' || /^https:\/\/vidzy\./i.test(src)) {
        if (/\/vostfr(?:[?]|$)/i.test(src)) { if (!vidzySubSrc) vidzySubSrc = src; }
        else if (!vidzySrc) vidzySrc = src;
      }
    }
    if (wantSub && vidzySubSrc) vidzySrc = vidzySubSrc;
    else if (!vidzySrc) vidzySrc = vidzySubSrc;

    var settled = await Promise.all([
      blinkSrc ? resolveBlink(blinkSrc, now() + 10000).catch(function () { return null; }) : null,
      moviezSrc ? resolveMoviez(moviezSrc, now() + 12000).catch(function () { return null; }) : null,
      vidzySrc ? resolveVidzy(vidzySrc, now() + 11000).catch(function () { return null; }) : null
    ]);

    var readers = [];
    for (var j = 0; j < settled.length; j++) if (settled[j]) readers.push(settled[j]);
    /* Only Vidzy carries VOSTFR here, so a subtitle request promotes it above
     * the VF MP4 that is otherwise opened by default. */
    if (wantSub) {
      var hasSub = false, k;
      for (k = 0; k < readers.length; k++) if (readers[k].packed.lang === 'sub') hasSub = true;
      if (hasSub) for (k = 0; k < readers.length; k++) readers[k].primary = readers[k].packed.lang === 'sub';
    }
    var composed = composeReaders(readers);
    if (composed) return composed;
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

  async function pageItems(path, deadline) {
    var r = await fetchText(SITE + path, HTML_HEADERS, left(deadline, 7000));
    if (r.status !== 200 || !r.text) return [];
    return itemsOf(r.text);
  }

  async function discoveryHome() {
    var deadline = now() + 7500;
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
      for (var f = 0; f < fallback.length; f++) {
        if (fallback[f].kind === 'movie') movieNew.push(fallback[f]);
        else seriesNew.push(fallback[f]);
      }
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
