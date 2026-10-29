/* ============================================================================
 * CineRegal — Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * Catalogue + metadata: the site's own TMDB proxy (/api/tmdb) in fr-FR.
 * Playback: the site's public HD reader (fluxora.sbs) — the embed resolves a
 * signed HLS gateway through two public endpoints; the gateway link is read
 * from the embed page and validated (real media playlist, no encryption).
 * Nothing gated is forged: when the reader has no source, we fail closed.
 * ==========================================================================*/

(function () {
  'use strict';

  var SITE = 'https://cineregal.onl';
  var API = SITE + '/api/tmdb';
  var FLUX = 'https://fluxora.sbs';
  var IMG = 'https://image.tmdb.org/t/p';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  var MOVIEZ = 'https://api.moviez.ac';
  var JSON_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'fr-FR,fr;q=0.9' };
  var HTML_HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'fr-FR,fr;q=0.9' };
  var STREAM_HEADERS = { 'User-Agent': UA, 'Referer': FLUX + '/' };
  var MOVIEZ_STREAM_HEADERS = { 'User-Agent': UA, 'Referer': MOVIEZ + '/' };

  var FEEDS = {
    trending: { path: '/trending/all/week', kind: 'mixed' },
    movies_popular: { path: '/movie/popular', kind: 'movie' },
    movies_top: { path: '/movie/top_rated', kind: 'movie' },
    tv_popular: { path: '/tv/popular', kind: 'tv' },
    tv_top: { path: '/tv/top_rated', kind: 'tv' }
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
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function img(path, size) {
    var p = String(path == null ? '' : path).trim();
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    return IMG + '/' + size + (p.charAt(0) === '/' ? '' : '/') + p;
  }

  function yearOf(j) {
    var m = String((j && (j.release_date || j.first_air_date)) || '').match(/^(\d{4})/);
    return m ? Number(m[1]) : undefined;
  }

  /* ------------------------------------------------------------ identities */
  /* Accepted: movie-603, tv-1396, tv-1396-s1e1, "603", a site URL. */
  function parseRef(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return null;
    var m = raw.match(/(?:^|[^a-z])movie[-_](\d+)(?:[-_]s(\d+)[-_]?e(\d+))?/i);
    if (m) {
      var movie = { type: 'movie', id: m[1] };
      return movie;
    }
    m = raw.match(/(?:^|[^a-z])tv[-_](\d+)(?:[-_]s(\d+)[-_]?e(\d+))?/i);
    if (m) {
      var tv = { type: 'tv', id: m[1] };
      if (m[2]) { tv.season = Number(m[2]) || 1; tv.episode = Number(m[3]) || 1; }
      return tv;
    }
    if (/^https?:\/\//i.test(raw)) {
      var type = /\/serie|\/series|\/tv\b/i.test(raw) ? 'tv' : 'movie';
      var ids = raw.match(/\d{2,}/g);
      if (ids && ids.length) {
        var ref = { type: type, id: ids[ids.length - 1] };
        var se = raw.match(/[sS](\d{1,2})[eE](\d{1,3})/);
        if (se && type === 'tv') { ref.season = Number(se[1]) || 1; ref.episode = Number(se[2]) || 1; }
        return ref;
      }
    }
    if (/^\d+$/.test(raw)) return { type: 'movie', id: raw };
    return null;
  }
  function hrefOf(ref) {
    if (!ref) return '';
    if (ref.type === 'tv') {
      return ref.season ? ('tv-' + ref.id + '-s' + ref.season + 'e' + (ref.episode || 1)) : ('tv-' + ref.id);
    }
    return 'movie-' + ref.id;
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
    if (data == null && res && typeof res.text === 'function') {
      try {
        var t = await res.text();
        if (t) data = JSON.parse(t);
      } catch (_) { data = null; }
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

  /* ------------------------------------------------------------------ TMDB */
  async function tmdb(path, params, deadline, cap) {
    var query = 'language=fr-FR', k;
    if (params) {
      for (k in params) {
        if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
        if (params[k] == null || params[k] === '') continue;
        query += '&' + k + '=' + encodeURIComponent(params[k]);
      }
    }
    var url = API + path + '?' + query;
    return fetchJson(url, merge(JSON_HEADERS, { 'Referer': SITE + '/' }), left(deadline, cap || 8000));
  }

  async function fetchList(path, page, deadline) {
    var r = await tmdb(path, { page: page || 1 }, deadline, 9000);
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.results)) return null;
    return {
      items: r.data.results,
      totalPages: num(r.data.total_pages) || 1,
      page: num(r.data.page) || (page || 1)
    };
  }

  /* ----------------------------------------------------------------- cards */
  function cardOf(item, type, opts) {
    var id = String(item && item.id);
    if (!id || id === 'undefined') return null;
    var href = (type === 'tv' ? 'tv-' : 'movie-') + id;
    var poster = img(item.poster_path, 'w500');
    var backdrop = img(item.backdrop_path, 'w1280');
    var card = {
      id: href, href: href, type: 'video',
      title: clean(item.title || item.name || item.original_title || item.original_name || ''),
      image: poster || backdrop,
      poster: poster || backdrop,
      description: clean(item.overview || ''),
      year: yearOf(item)
    };
    if (num(item.vote_average) > 0) card.rating = Math.round(num(item.vote_average) * 10) / 10;
    if (backdrop) card.banner = backdrop;
    if (opts && opts.hero) {
      /* Hero slots are full-bleed landscape: the portrait poster is useless there. */
      card.image = backdrop || poster;
      card.backdrop = backdrop || poster;
    }
    return card;
  }

  function cardsFrom(items, kind, limit, hero) {
    var out = [], seen = {}, i;
    for (i = 0; i < items.length && out.length < limit; i++) {
      var it = items[i] || {};
      var type = kind === 'mixed' ? String(it.media_type || '') : kind;
      if (type !== 'movie' && type !== 'tv') continue;
      if (it.adult === true) continue;
      var key = type + ':' + it.id;
      if (seen[key]) continue;
      seen[key] = true;
      var card = cardOf(it, type, { hero: !!hero });
      if (!card || !card.title || !card.image) continue;
      out.push(card);
    }
    return out;
  }

  /* ----------------------------------------------------------------- search */
  async function searchResults(query) {
    var deadline = now() + 12000;
    var term = String(query == null ? '' : query).trim();

    if (!term) {
      var top = await fetchList('/trending/all/week', 1, deadline);
      return top ? cardsFrom(top.items, 'mixed', 12) : [];
    }

    var r = await tmdb('/search/multi', { query: term, page: 1, include_adult: 'false' }, deadline, 9000);
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.results)) {
      throw new Error('CineRegal search failed (HTTP ' + r.status + ')');
    }
    return cardsFrom(r.data.results, 'mixed', 20);
  }

  /* ---------------------------------------------------------------- details */
  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref) throw new Error('CineRegal: invalid id');
    var deadline = now() + 15000;
    var r = await tmdb('/' + ref.type + '/' + encodeURIComponent(ref.id), null, deadline, 10000);
    if (r.status !== 200 || !r.data) throw new Error('CineRegal details failed (HTTP ' + r.status + ')');
    var j = r.data;

    var poster = img(j.poster_path, 'w500');
    var banner = img(j.backdrop_path, 'original');
    var genres = [];
    if (Array.isArray(j.genres)) {
      for (var i = 0; i < j.genres.length; i++) {
        var name = clean(j.genres[i] && j.genres[i].name);
        if (name) genres.push(name);
      }
    }
    var out = {
      id: hrefOf(ref), href: hrefOf(ref), url: SITE,
      type: 'video',
      title: clean(j.title || j.name || j.original_title || j.original_name || ''),
      description: clean(j.overview || ''),
      image: poster || banner,
      poster: poster || banner,
      year: yearOf(j),
      genres: genres,
      status: clean(j.status || '')
    };
    if (banner) { out.banner = banner; out.backdrop = banner; }
    if (num(j.vote_average) > 0) out.rating = Math.round(num(j.vote_average) * 10) / 10;
    if (ref.type === 'tv') {
      if (num(j.number_of_seasons)) out.seasons = num(j.number_of_seasons);
      if (num(j.number_of_episodes)) out.episodes = num(j.number_of_episodes);
    } else if (num(j.runtime)) {
      out.duration = num(j.runtime);
    }
    return out;
  }

  /* --------------------------------------------------------------- episodes */
  async function extractEpisodes(seriesId) {
    var ref = parseRef(seriesId);
    if (!ref) throw new Error('CineRegal: invalid id');
    if (ref.type === 'movie') {
      return [{ number: 1, href: 'movie-' + ref.id, title: 'Film', season: null }];
    }

    var deadline = now() + 22000;
    var show = await tmdb('/tv/' + encodeURIComponent(ref.id), null, deadline, 9000);
    if (show.status !== 200 || !show.data) throw new Error('CineRegal episodes failed (HTTP ' + show.status + ')');

    var seasons = Array.isArray(show.data.seasons) ? show.data.seasons : [];
    var nums = [], i;
    for (i = 0; i < seasons.length; i++) {
      var n = num(seasons[i] && seasons[i].season_number);
      if (n >= 1) nums.push(n);
    }
    nums.sort(function (a, b) { return a - b; });
    if (!nums.length) nums = [1];

    var episodes = [], failures = 0;
    for (i = 0; i < nums.length; i += 4) {
      if (now() >= deadline - 1200) break;
      var batch = nums.slice(i, i + 4);
      var results = await Promise.all(batch.map(async function (seasonNumber) {
        try {
          var sr = await tmdb('/tv/' + encodeURIComponent(ref.id) + '/season/' + seasonNumber, null, deadline, 7000);
          if (sr.status !== 200 || !sr.data || !Array.isArray(sr.data.episodes)) return null;
          return { season: seasonNumber, list: sr.data.episodes };
        } catch (_) {
          return null;
        }
      }));
      for (var b = 0; b < results.length; b++) {
        if (!results[b]) { failures++; continue; }
        var list = results[b].list, sn = results[b].season;
        for (var e = 0; e < list.length; e++) {
          var ep = list[e] || {};
          var number = num(ep.episode_number);
          if (!(number > 0)) continue;
          var entry = {
            number: number,
            href: 'tv-' + ref.id + '-s' + sn + 'e' + number,
            title: clean(ep.name || ('Episode ' + number)),
            season: sn
          };
          var still = img(ep.still_path, 'w300');
          if (still) entry.image = still;
          episodes.push(entry);
        }
      }
    }
    if (!episodes.length) throw new Error('CineRegal: no episode listing (' + failures + ' season(s) unavailable)');
    return episodes;
  }

  /* ----------------------------------------------------------- base64/URLs */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  function b64ToAscii(s) {
    var src = String(s == null ? '' : s).replace(/\s+/g, '');
    var out = '';
    for (var i = 0; i < src.length; i += 4) {
      var c1 = B64.indexOf(src.charAt(i));
      var c2 = B64.indexOf(src.charAt(i + 1));
      var c3 = B64.indexOf(src.charAt(i + 2));
      var c4 = B64.indexOf(src.charAt(i + 3));
      if (c1 < 0 || c2 < 0) return '';
      if (c3 < 0) c3 = 64;
      if (c4 < 0) c4 = 64;
      out += String.fromCharCode((c1 << 2) | (c2 >> 4));
      if (c3 !== 64) out += String.fromCharCode(((c2 & 15) << 4) | (c3 >> 2));
      if (c4 !== 64) out += String.fromCharCode(((c3 & 3) << 6) | c4);
    }
    return out;
  }

  function resolveUrl(base, rel) {
    var v = String(rel == null ? '' : rel).trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    var origin = String(base || '').match(/^https?:\/\/[^\/?#]+/i);
    var root = origin ? origin[0] : '';
    if (/^\/\//.test(v)) return 'https:' + v;
    if (v.charAt(0) === '/') return root + v;
    var dir = String(base || '').replace(/[?#][\s\S]*$/, '').replace(/\/[^\/]*$/, '/');
    return dir + v;
  }

  function parseAttrs(s) {
    var out = {}, m;
    var re = /([A-Z0-9-]+)\s*=\s*("[^"]*"|[^,]*)/g;
    while ((m = re.exec(String(s == null ? '' : s)))) {
      out[m[1]] = String(m[2] || '').replace(/^"|"$/g, '');
    }
    return out;
  }

  function normalizePlaylist(text) {
    return String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/^\s+/, '');
  }

  function isMediaPlaylist(text) {
    var t = normalizePlaylist(text);
    if (t.indexOf('#EXTM3U') !== 0) return false;
    if (/#EXT-X-KEY\s*:[^\n]*METHOD\s*=\s*(?!NONE)/i.test(t)) return false;
    var lines = t.split(/\r?\n/), expect = false, found = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (!line) continue;
      if (/^#EXTINF:/i.test(line)) { expect = true; continue; }
      if (line.charAt(0) === '#') continue;
      if (!expect) continue;
      if (/\.(?:jpe?g|png|webp|gif|avif)(?:\?|#|$)/i.test(line)) return false;
      found++;
      expect = false;
    }
    return found >= 1;
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
      return (b.height - a.height) || (b.bandwidth - a.bandwidth) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
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
      var v = uniq[i];
      var label = tierLabel(v.height);
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
      streams: streams,
      url: top.url,
      headers: headers,
      streamType: 'hls',
      quality: quality,
      defaultQuality: quality,
      qualities: qualities,
      subtitles: [],
      lang: lang
    };
  }

  function streamFail(message) {
    return { streams: [], subtitles: [], lang: 'dub', error: { message: message } };
  }

  /* ------------------------------------------------------- fluxora HD reader */
  function parseInitialPlay(html) {
    var m = String(html == null ? '' : html).match(/INITIAL_PLAY\s*=\s*(\{[\s\S]*?\}|null)\s*;/);
    if (!m) return null;
    if (m[1] === 'null') return null;
    try { return JSON.parse(m[1]); } catch (_) { return null; }
  }

  function parseSourceChoices(html) {
    var src = String(html == null ? '' : html);
    var m = src.match(/INITIAL_SOURCE_CHOICES\s*=\s*(\[[\s\S]*?\])\s*;/);
    if (!m) return [];
    var list;
    try { list = JSON.parse(m[1]); } catch (_) { return []; }
    if (!Array.isArray(list)) return [];
    var rank = { available: 0, unknown: 1 };
    var out = [], i;
    for (i = 0; i < list.length; i++) {
      var c = list[i] || {};
      var id = String(c.id || '');
      if (!id) continue;
      var state = String(c.status || 'unknown');
      if (state !== 'available' && state !== 'unknown') continue;
      if (c.selectable === false && state !== 'available') continue;
      out.push({ id: id, rank: rank[state] });
    }
    out.sort(function (a, b) { return a.rank - b.rank; });
    return out.map(function (c) { return c.id; });
  }

  function sidFromHtml(html, play) {
    var src = String(html == null ? '' : html);
    var m = src.match(/SID\s*=\s*["']([A-Za-z0-9]+)["']/) ||
      src.match(/[?&]embed_sid=([A-Za-z0-9]+)/);
    if (m) return m[1];
    if (play && play.stream_url) {
      var s = String(play.stream_url).match(/[?&]embed_sid=([A-Za-z0-9]+)/);
      if (s) return s[1];
    }
    return '';
  }

  function decodeEncSource(html) {
    var src = String(html == null ? '' : html);
    var m = src.match(/id="encrypted-source"[^>]*value="([^"]+)"/) ||
      src.match(/value="([^"]+)"[^>]*id="encrypted-source"/);
    if (!m) return '';
    var decoded = b64ToAscii(m[1]);
    return /^https:\/\//i.test(decoded) ? decoded.trim() : '';
  }

  function isFluxoraUrl(url) {
    var m = String(url == null ? '' : url).match(/^https:\/\/([^\/?#]+)/i);
    if (!m) return false;
    return /(^|\.)fluxora\.sbs$/i.test(m[1]);
  }

  /* The sandbox has no setTimeout: a bounded synchronous spin is the only wait. */
  function pause(ms) {
    var until = now() + Math.max(0, ms || 0);
    while (now() < until) { /* spin */ }
  }

  async function postPlay(sid, lane, deadline) {
    if (!sid) return null;
    var body = JSON.stringify({ sid: sid, lang: 'vf', embed_mobile: 0, source: lane });
    var waits = [0, 250, 500];
    for (var attempt = 0; attempt < waits.length; attempt++) {
      if (attempt > 0) pause(waits[attempt]);
      if (now() >= deadline - 1500) return null;
      var r = null;
      try {
        r = await fetchJson(
          FLUX + '/api/embed-player/play?reader_source=' + encodeURIComponent(lane),
          merge(JSON_HEADERS, { 'Content-Type': 'application/json', 'Referer': FLUX + '/embed/zenix' }),
          left(deadline, 9000), 'POST', body
        );
      } catch (_) {
        return null;
      }
      var data = (r && r.data) || null;
      if (data && data.ok && data.stream_url) return data;
      var err = data ? String(data.error || '') : '';
      if (r && r.status === 202 && err === 'warming') continue;
      return null;
    }
    return null;
  }

  async function packFromPlaylist(hlsUrl, deadline, headers, lang) {
    if (!/^https:\/\//i.test(String(hlsUrl))) return null;
    var hdrs = headers || STREAM_HEADERS;
    var r = await fetchText(hlsUrl, hdrs, left(deadline, 9000));
    var text = normalizePlaylist(r.text);
    if (r.status !== 200 || text.indexOf('#EXTM3U') !== 0) return null;
    if (/#EXT-X-KEY\s*:[^\n]*METHOD\s*=\s*(?!NONE)/i.test(text)) return null;

    var variants = parseMaster(text, hlsUrl);
    if (variants.length) {
      var valid = [];
      for (var i = 0; i < variants.length; i += 4) {
        var batch = variants.slice(i, i + 4);
        var results = await Promise.all(batch.map(async function (v) {
          try {
            var vr = await fetchText(v.url, hdrs, left(deadline, 6000));
            if (vr.status !== 200 || !isMediaPlaylist(vr.text)) return null;
            return { url: v.url, height: v.height, bandwidth: v.bandwidth };
          } catch (_) {
            return null;
          }
        }));
        for (var j = 0; j < results.length; j++) if (results[j]) valid.push(results[j]);
      }
      /* A master without any readable rendition is not playable. */
      return valid.length ? packHls(valid, hlsUrl, { headers: hdrs, lang: lang }) : null;
    }

    if (isMediaPlaylist(text)) return packHls([{ url: hlsUrl, height: 0, bandwidth: 0 }], null, { headers: hdrs, lang: lang });
    return null;
  }

  async function probeWrapper(streamUrl, embed, deadline, opts) {
    var streamPage = await fetchText(streamUrl, merge(HTML_HEADERS, { 'Referer': embed }), left(deadline, 8000));
    if (streamPage.status !== 200 || !streamPage.text) return null;
    var hls = decodeEncSource(streamPage.text);
    if (!hls || !isFluxoraUrl(hls)) return null;
    return packFromPlaylist(hls, deadline, (opts && opts.headers) || STREAM_HEADERS, (opts && opts.lang) || 'dub');
  }

  async function tryFluxoraOnce(ref, deadline) {
    var type = ref.type === 'tv' ? 'tv' : 'movie';
    var embed = FLUX + '/embed/zenix?tmdb=' + encodeURIComponent(ref.id) + '&type=' + type + '&lang=vf';
    if (type === 'tv') embed += '&season=' + (ref.season || 1) + '&episode=' + (ref.episode || 1);

    var page = await fetchText(embed, merge(HTML_HEADERS, { 'Referer': SITE + '/' }), left(deadline, 9000));
    if (page.status !== 200 || !page.text) return null;
    var play = parseInitialPlay(page.text);
    if (play && play.ok === false) play = null;

    var sid = sidFromHtml(page.text, play);

    if (play && play.stream_url) {
      var direct = await probeWrapper(String(play.stream_url), embed, deadline);
      if (direct) return direct;
    }

    var lanes = parseSourceChoices(page.text);
    if (!lanes.length) {
      if (play && play.provider) lanes.push(String(play.provider));
      if (play && Array.isArray(play.sources)) {
        for (var i = 0; i < play.sources.length; i++) {
          var laneId = String((play.sources[i] && play.sources[i].id) || '');
          if (!laneId || play.sources[i].available === false) continue;
          if (lanes.indexOf(laneId) === -1) lanes.push(laneId);
        }
      }
    }
    if (!lanes.length) lanes.push('s1');

    var tried = {}, count = 0;
    for (var l = 0; l < lanes.length && count < 4; l++) {
      if (now() >= deadline - 2500) break;
      if (tried[lanes[l]]) continue;
      tried[lanes[l]] = true;
      count++;
      var played = await postPlay(sid, lanes[l], deadline);
      if (!played) continue;
      var packed = await probeWrapper(String(played.stream_url || ''), embed, deadline);
      if (packed) return packed;
    }
    return null;
  }

  /* The reader intermittently answers "source unavailable" for an otherwise
   * healthy title; a single retry on the whole chain recovers most of those. */
  async function resolveFluxora(ref, deadline) {
    for (var attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && now() >= deadline - 6000) break;
      try {
        var packed = await tryFluxoraOnce(ref, deadline);
        if (packed) return packed;
      } catch (_) { /* retry once */ }
    }
    return null;
  }

  /* -------------------------------------------------------- moviez fallback */
  function moviezPageUrl(ref, lang) {
    var q = '?lang=' + (lang === 'vostfr' ? 'vostfr' : 'vf');
    if (ref.type === 'tv') {
      return MOVIEZ + '/serie/' + encodeURIComponent(ref.id) + '/' + (ref.season || 1) + '/' + (ref.episode || 1) + q;
    }
    return MOVIEZ + '/' + encodeURIComponent(ref.id) + q;
  }

  function parseP2(html) {
    var m = String(html == null ? '' : html).match(/window\.P2\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (_) { return null; }
  }

  async function resolveMoviez(ref, deadline) {
    var pageUrl = moviezPageUrl(ref, 'vf');
    var page = await fetchText(pageUrl, merge(HTML_HEADERS, { 'Referer': SITE + '/' }), left(deadline, 9000));
    if (page.status !== 200 || !page.text) return null;
    var cfg = parseP2(page.text);
    if (!cfg || !cfg.t) return null;

    var r = await fetchJson(MOVIEZ + '/api/v2/stream', merge(JSON_HEADERS, {
      'Content-Type': 'application/json',
      'Referer': pageUrl,
      'Origin': MOVIEZ
    }), left(deadline, 9000), 'POST', JSON.stringify({ t: cfg.t }));
    if (r.status !== 200 || !r.data || !r.data.hls) return null;

    var lang = String(cfg.lang || 'vf') === 'vostfr' ? 'sub' : 'dub';
    return packFromPlaylist(String(r.data.hls), deadline, MOVIEZ_STREAM_HEADERS, lang);
  }

  /* -------------------------------------------------------------- streaming */
  async function extractStreamUrl(episodeHref, lang) {
    var deadline = now() + 26000;
    var ref = parseRef(episodeHref);
    if (!ref) return streamFail('CineRegal : identifiant invalide.');
    if (ref.type === 'tv' && (!ref.season || !ref.episode)) { ref.season = ref.season || 1; ref.episode = ref.episode || 1; }

    /* Reader #1: the site's HD reader (fluxora). Reader #2: its moviez source. */
    try {
      var packed = await resolveFluxora(ref, now() + 13000);
      if (packed) return packed;
    } catch (_) { /* fall through */ }

    try {
      packed = await resolveMoviez(ref, deadline);
      if (packed) return packed;
    } catch (_) { /* reported below */ }

    return streamFail('CineRegal : le lecteur HD n\'a pas fourni de flux lisible pour ce titre. Reessayez plus tard ou choisissez un autre titre.');
  }

  /* -------------------------------------------------------------- discovery */
  async function discoveryHome() {
    var deadline = now() + 20000;
    var sections = [];

    var lists = await Promise.all([
      fetchList('/trending/all/week', 1, deadline).catch(function () { return null; }),
      fetchList('/movie/popular', 1, deadline).catch(function () { return null; }),
      fetchList('/tv/popular', 1, deadline).catch(function () { return null; }),
      fetchList('/movie/top_rated', 1, deadline).catch(function () { return null; }),
      fetchList('/tv/top_rated', 1, deadline).catch(function () { return null; })
    ]);
    var trending = lists[0], moviesPop = lists[1], tvPop = lists[2], moviesTop = lists[3], tvTop = lists[4];

    if (trending) {
      var hero = cardsFrom(trending.items, 'mixed', 8, true);
      if (hero.length) {
        sections.push({ id: 'trending-hero', title: 'Tendances de la semaine', style: 'hero', items: hero });
      }
    }
    if (moviesPop) {
      var films = cardsFrom(moviesPop.items, 'movie', 24);
      if (films.length) sections.push({ id: 'movies-popular', title: 'Films populaires', style: 'poster', items: films, viewAll: { mode: 'feed', feedId: 'movies_popular' } });
    }
    if (tvPop) {
      var series = cardsFrom(tvPop.items, 'tv', 24);
      if (series.length) sections.push({ id: 'tv-popular', title: 'Series populaires', style: 'poster', items: series, viewAll: { mode: 'feed', feedId: 'tv_popular' } });
    }
    if (trending) {
      var row = cardsFrom(trending.items, 'mixed', 24, true);
      if (row.length) sections.push({ id: 'trending', title: 'Tendances', style: 'landscape', items: row, viewAll: { mode: 'feed', feedId: 'trending' } });
    }
    if (moviesTop) {
      var bestFilms = cardsFrom(moviesTop.items, 'movie', 24);
      if (bestFilms.length) sections.push({ id: 'movies-top', title: 'Films les mieux notes', style: 'poster', items: bestFilms, viewAll: { mode: 'feed', feedId: 'movies_top' } });
    }
    if (tvTop) {
      var bestSeries = cardsFrom(tvTop.items, 'tv', 24);
      if (bestSeries.length) sections.push({ id: 'tv-top', title: 'Series les mieux notees', style: 'poster', items: bestSeries, viewAll: { mode: 'feed', feedId: 'tv_top' } });
    }
    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    var pageNum = Math.max(1, Number(page) || 1);
    var feed = FEEDS[String(feedId == null ? '' : feedId)];
    if (!feed) return { items: [], page: pageNum, hasMore: false };

    var r = await fetchList(feed.path, pageNum, now() + 18000);
    if (!r) return { items: [], page: pageNum, hasMore: false };
    return {
      items: cardsFrom(r.items, feed.kind, 50),
      page: pageNum,
      hasMore: pageNum < Math.min(r.totalPages, 20)
    };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
