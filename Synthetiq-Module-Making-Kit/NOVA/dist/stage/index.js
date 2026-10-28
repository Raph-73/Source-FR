/* ============================================================================
 * Nova Stream (watchnova.win) — Synthetiq Player video module (contract v4)
 * ----------------------------------------------------------------------------
 * Public guest catalogue: films and series, search, details, episodes and
 * discovery. Playback is VF only, through public uqload pages.
 *
 * Catalogue routes used:
 *   GET /api/catalog                 -> { items: [...] }
 *   GET /api/titles/{id}/episodes    -> { episodes: [...] }
 *
 * Playback route:
 *   The catalogue links are signed and go stale. A fresh uqload public page is
 *   resolved at play time: https://uqload.vc/<file-id>.html
 *   That page carries the source filename (used to reject mislabelled sources)
 *   and a JW Player configuration with a freshly signed HLS master URL.
 *
 * Scope and fail-closed rules:
 *   - NOVA Premium titles and episodes are never played.
 *   - HeiwaStream (closed beta) and every non-uqload host are rejected.
 *   - A source whose filename does not match the requested title/year/episode
 *     is rejected. This is necessary: the public catalogue contains entries
 *     pointing at a different film or episode.
 *   - VOSTFR sources are rejected; this module advertises VF (dub) only.
 *   - Encrypted HLS, init-map/byterange playlists and image/HTML placeholders
 *     are rejected. Only verified HLS is returned; an MP4 source fails closed
 *     because its bytes cannot be checked through the text-only bridge.
 *     No DRM, login, paywall or CAPTCHA bypass is attempted.
 *   - Discovery omits catalogue entries that have no artwork, so the home
 *     screen never emits an empty poster card.
 *
 * No Node/browser DOM APIs, no timers, no typed arrays, no eval. Uses only
 * fetchv2(url, headers, method, body, options) available in the app sandbox.
 * ==========================================================================*/

(function () {
  'use strict';

  var SITE = 'https://watchnova.win';
  var UQLOAD = 'https://uqload.vc';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  var BASE_HEADERS = {
    'User-Agent': UA,
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5'
  };
  var STREAM_HEADERS = {
    'User-Agent': UA,
    'Referer': UQLOAD + '/',
    'Origin': UQLOAD
  };
  var CATALOG_TTL_MS = 5 * 60 * 1000;
  var EPISODES_TTL_MS = 60 * 1000;
  var PAGE_SIZE = 30;

  var catalogCache = { at: 0, items: null, promise: null };
  var episodesCache = {};

  /* --------------------------------------------------------------- helpers */

  function now() { return Date.now(); }

  function left(deadline, cap) {
    return Math.max(600, Math.min(deadline - now(), cap || 12000));
  }

  function merge(base, extra) {
    var out = {}, k;
    if (base) for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (extra) for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalize(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/\u0153/g, 'oe').replace(/\u00e6/g, 'ae').replace(/\u00df/g, 'ss')
      .replace(/[\u00e0\u00e1\u00e2\u00e4\u00e3\u00e5]/g, 'a')
      .replace(/[\u00e7]/g, 'c')
      .replace(/[\u00e8\u00e9\u00ea\u00eb]/g, 'e')
      .replace(/[\u00ec\u00ed\u00ee\u00ef]/g, 'i')
      .replace(/[\u00f1]/g, 'n')
      .replace(/[\u00f2\u00f3\u00f4\u00f6\u00f5]/g, 'o')
      .replace(/[\u00f9\u00fa\u00fb\u00fc]/g, 'u')
      .replace(/[\u00fd\u00ff]/g, 'y')
      .replace(/[\u2018\u2019\u0060\u00b4]/g, "'")
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var STOP = {};
  (function () {
    var words = ('le la les l de des du un une et the a an of to in on for with and or aux au ' +
      'ce cette ces que qui quoi dont ou se sa son ses leur leurs il elle ils elles nous vous ' +
      'je tu mon ma mes ton ta tes notre votre nos vos est sont was were is are at by from as ' +
      'its it this that these those').split(' ');
    for (var i = 0; i < words.length; i++) STOP[words[i]] = true;
  })();

  function titleTokens(s) {
    var words = normalize(s).split(' ');
    var out = [], i, w;
    for (i = 0; i < words.length; i++) {
      w = words[i];
      if (!w) continue;
      if (w.length < 2 && !/^\d+$/.test(w)) continue;
      if (STOP[w]) continue;
      out.push(w);
    }
    if (!out.length) {
      for (i = 0; i < words.length; i++) if (words[i]) out.push(words[i]);
    }
    return out;
  }

  function parseDateMs(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return 0;
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?/);
    if (m) {
      var ms = Date.UTC(
        parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
        parseInt(m[4] || '0', 10), parseInt(m[5] || '0', 10), parseInt(m[6] || '0', 10),
        parseInt((m[7] || '0') + '00', 10) || 0
      );
      return isFinite(ms) ? ms : 0;
    }
    var t = Date.parse(s);
    return isFinite(t) ? t : 0;
  }

  function isPremium(x) {
    if (!x) return false;
    var flag = x.premium;
    if (flag === true || flag === 1 || String(flag).toLowerCase() === 'true') return true;
    var until = parseDateMs(x.premiumUntil);
    return until > now();
  }

  function hostOf(url) {
    var m = String(url == null ? '' : url).match(/^https?:\/\/([^\/?#]+)/i);
    return m ? m[1].toLowerCase().replace(/:\d+$/, '') : '';
  }

  function originOf(url) {
    var m = String(url == null ? '' : url).match(/^(https?:\/\/[^\/?#]+)/i);
    return m ? m[1] : '';
  }

  function isUqloadHost(host) {
    return /(^|\.)uqload\.(vc|is|com|to|co)$/i.test(String(host || ''));
  }

  function resolveUrl(base, rel) {
    var r = String(rel == null ? '' : rel).trim();
    if (!r) return '';
    if (/^https?:\/\//i.test(r)) return r;
    if (/^\/\//.test(r)) return 'https:' + r;
    var origin = originOf(base);
    if (/^\//.test(r)) return origin + r;
    var path = String(base == null ? '' : base).replace(/[?#].*$/, '');
    var slash = path.lastIndexOf('/');
    return (slash >= 0 ? path.slice(0, slash + 1) : origin + '/') + r;
  }

  function uqloadIdFromUrl(raw) {
    var url = String(raw == null ? '' : raw).trim();
    if (!/^https?:\/\//i.test(url)) return '';
    if (!isUqloadHost(hostOf(url))) return '';
    var path = url.replace(/^https?:\/\/[^\/]+/i, '').replace(/[?#].*$/, '');
    var segs = path.split('/').filter(function (x) { return !!x; });
    if (!segs.length) return '';
    var last = segs[segs.length - 1];
    var m = last.match(/^embed-([a-z0-9]+)\.html$/i) ||
      last.match(/^([a-z0-9]+)\.html$/i) ||
      last.match(/^([a-z0-9]+)$/i);
    if (m) {
      var id = m[1];
      if (/^[a-z0-9]{6,20}$/i.test(id) && !/^(index|master|embed|video|watch|site)$/i.test(id)) return id;
    }
    m = path.match(/\/hls2\/[^/]+\/[^/]+\/([a-z0-9]{6,20}?)(?:_[a-z]|,)/i);
    if (m) return m[1];
    m = path.match(/\/([a-z0-9]{6,20})_[a-z]\//i);
    if (m) return m[1];
    return '';
  }

  function findItem(items, id) {
    var want = String(id == null ? '' : id).toLowerCase();
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].id).toLowerCase() === want) return items[i];
    }
    return null;
  }

  function findEpisode(episodes, id) {
    var want = String(id == null ? '' : id).toLowerCase();
    for (var i = 0; i < episodes.length; i++) {
      if (String(episodes[i].id).toLowerCase() === want) return episodes[i];
    }
    return null;
  }

  function extractId(input) {
    var v = String(input == null ? '' : input).trim();
    if (!v) return '';
    if (/^(?:movie|tv)-\d+(?:-s\d+e\d+)?$/i.test(v)) return v.toLowerCase();
    var m = v.match(/((?:movie|tv)-\d+(?:-s\d+e\d+)?)/i);
    if (m) return m[1].toLowerCase();
    m = v.match(/[?&]id=([^&#]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]).trim(); } catch (_) { return m[1].trim(); }
    }
    return v;
  }

  function parseEpisodeId(id) {
    var m = String(id == null ? '' : id).match(/^tv-(\d+)-s(\d+)e(\d+)$/i);
    if (!m) return null;
    return {
      id: String(id).toLowerCase(),
      titleId: 'tv-' + m[1],
      season: parseInt(m[2], 10),
      episode: parseInt(m[3], 10)
    };
  }

  /* ------------------------------------------------------- response helpers */

  function statusOf(res) {
    return Number(res && (res.status || res.statusCode)) || 0;
  }

  async function readJson(res) {
    if (!res) return null;
    var v = null;
    if (typeof res.json === 'function') {
      try { v = await res.json(); } catch (_) { v = null; }
    } else if (res.json != null) {
      v = res.json;
    }
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (_) {}
    }
    if (v != null) return v;
    if (typeof res.body === 'string' && res.body) {
      try { return JSON.parse(res.body); } catch (_) {}
    }
    if (typeof res.text === 'function') {
      try {
        var t = await res.text();
        if (t) return JSON.parse(t);
      } catch (_) {}
    }
    return null;
  }

  async function readText(res) {
    if (!res) return '';
    if (typeof res.text === 'function') {
      try {
        var t = await res.text();
        if (t) return String(t);
      } catch (_) {}
    }
    if (typeof res.body === 'string' && res.body) return res.body;
    return '';
  }

  async function fetchJson(url, headers, timeoutMs) {
    var res = await fetchv2(url, merge(BASE_HEADERS, headers || {}), 'GET', null, { timeoutMs: timeoutMs });
    return { status: statusOf(res), data: await readJson(res) };
  }

  async function fetchText(url, headers, timeoutMs) {
    var res = await fetchv2(url, merge(BASE_HEADERS, headers || {}), 'GET', null, { timeoutMs: timeoutMs });
    return { status: statusOf(res), text: await readText(res) };
  }

  async function fetchTextWithRetry(url, headers, deadline, cap) {
    var r = await fetchText(url, headers || {}, left(deadline, cap || 8000));
    if (r.status === 0 || r.status >= 500 || !r.text) {
      r = await fetchText(url, headers || {}, left(deadline, 5000));
    }
    return r;
  }

  /* --------------------------------------------------------------- catalogue */

  function catalogItems(data) {
    if (!data) return null;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.items)) return data.items;
    if (data.data && Array.isArray(data.data.items)) return data.data.items;
    return null;
  }

  async function getCatalog(deadline) {
    if (catalogCache.items && (now() - catalogCache.at) < CATALOG_TTL_MS) return catalogCache.items;
    if (catalogCache.promise) {
      try { return await catalogCache.promise; } catch (_) {
        if (catalogCache.items) return catalogCache.items;
        throw _;
      }
    }
    var url = SITE + '/api/catalog';
    var headers = { 'Referer': SITE + '/', 'Accept': 'application/json' };
    var p = (async function () {
      var r = await fetchJson(url, headers, left(deadline, 8000));
      var items = catalogItems(r.data);
      if (!items || !items.length) {
        r = await fetchJson(url, headers, left(deadline, 6000));
        items = catalogItems(r.data);
      }
      if (!items || !items.length) {
        if (catalogCache.items) return catalogCache.items;
        throw new Error('catalogue indisponible (' + r.status + ')');
      }
      var filtered = [];
      for (var i = 0; i < items.length; i++) {
        var x = items[i];
        if (x && x.id && x.title) filtered.push(x);
      }
      if (!filtered.length) {
        if (catalogCache.items) return catalogCache.items;
        throw new Error('catalogue vide');
      }
      catalogCache = { at: now(), items: filtered, promise: null };
      return filtered;
    })();
    catalogCache.promise = p;
    try { return await p; } catch (e) {
      if (catalogCache.items) return catalogCache.items;
      throw e;
    } finally {
      if (catalogCache.promise === p) catalogCache.promise = null;
    }
  }

  function episodesFrom(data) {
    if (!data) return null;
    if (Array.isArray(data.episodes)) return data.episodes;
    if (data.data && Array.isArray(data.data.episodes)) return data.data.episodes;
    if (Array.isArray(data)) return data;
    return null;
  }

  async function getEpisodes(titleId, deadline) {
    var key = String(titleId);
    var cached = episodesCache[key];
    if (cached && (now() - cached.at) < EPISODES_TTL_MS) return cached.data;
    var url = SITE + '/api/titles/' + encodeURIComponent(key) + '/episodes';
    var headers = { 'Referer': SITE + '/', 'Accept': 'application/json' };
    var r = await fetchJson(url, headers, left(deadline, 8000));
    var eps = episodesFrom(r.data);
    if (!eps) {
      r = await fetchJson(url, headers, left(deadline, 6000));
      eps = episodesFrom(r.data);
    }
    if (!eps) {
      if (cached) return cached.data;
      throw new Error('épisodes indisponibles (' + r.status + ')');
    }
    episodesCache[key] = { at: now(), data: eps };
    return eps;
  }

  function isPlayableFilm(item) {
    return item && item.type === 'film' && !isPremium(item) && !!uqloadIdFromUrl(item.watchUrl);
  }

  function isDiscoverable(item) {
    if (!item || !item.id || !item.title || isPremium(item)) return false;
    if (item.type === 'film') return !!uqloadIdFromUrl(item.watchUrl);
    if (item.type === 'serie') return Number(item.seasons || 0) > 0;
    return false;
  }

  function hasArtwork(item) {
    return !!(item && (item.poster || item.backdrop));
  }

  function cardOf(item) {
    return {
      title: clean(item.title),
      href: String(item.id),
      image: item.poster || item.backdrop || '',
      year: String(item.year || ''),
      type: item.type || ''
    };
  }

  /* ----------------------------------------------------------- source title */

  function cleanSourceTitle(s) {
    var t = clean(s);
    t = t.replace(/^\s*(?:watch|regarder)\s+/i, '');
    t = t.replace(/\s*[-|–—]\s*(?:uqload|watch online|streaming|gratuit)\b.*$/i, '');
    return t.replace(/\s+$/, '').trim();
  }

  function titleFromHtml(html) {
    var s = String(html == null ? '' : html);
    var m = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) {
      var t = cleanSourceTitle(m[1]);
      if (t) return t;
    }
    m = s.match(/<meta[^>]+(?:property|name)\s*=\s*["'](?:og:title|twitter:title)["'][^>]*content\s*=\s*["']([^"']*)["']/i);
    if (!m) {
      m = s.match(/<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+(?:property|name)\s*=\s*["'](?:og:title|twitter:title)["']/i);
    }
    return m ? cleanSourceTitle(m[1]) : '';
  }

  function sourceYear(raw) {
    var text = String(raw == null ? '' : raw);
    var years = [], m;
    var re = /\b(19\d{2}|20\d{2})\b/g;
    while ((m = re.exec(text))) {
      years.push({ value: parseInt(m[1], 10), end: re.lastIndex });
    }
    if (!years.length) return 0;
    var last = years[years.length - 1];
    var after = text.slice(last.end).replace(/^[\s._\-–—)\]\[\(]+/, '');
    var reliable = years.length >= 2 || /^(?:vf|vff|vostfr|french|truefrench|multi|web|webrip|webdl|hdtv|bluray|brrip|bdrip|dvdrip|hdrip|rip|1080p|720p|2160p|4k|uhd|x264|x265|h264|h265|hevc|aac|ac3|ddp|dts|remux|proper|repack|10bit|hdr|dv|atmos|mkv|mp4|avi|wawacity|nlx|fssup|subforced|sub|francais)\b/i.test(after);
    return reliable ? last.value : 0;
  }

  function episodeMarker(raw) {
    var text = String(raw == null ? '' : raw);
    var m = text.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i) || text.match(/\b(\d{1,2})x(\d{1,3})\b/i);
    if (!m) return null;
    return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  }

  function titleMatches(item, raw) {
    var sourceTokens = {};
    var st = titleTokens(raw);
    if (!st.length) return false;
    for (var i = 0; i < st.length; i++) sourceTokens[st[i]] = true;
    var candidates = [];
    if (item.title) candidates.push(item.title);
    if (item.originalTitle && item.originalTitle !== item.title) candidates.push(item.originalTitle);
    for (var c = 0; c < candidates.length; c++) {
      var ct = titleTokens(candidates[c]);
      if (!ct.length) continue;
      var missing = 0, matched = 0;
      for (var j = 0; j < ct.length; j++) {
        if (sourceTokens[ct[j]]) matched++;
        else missing++;
      }
      if (!missing) return true;
      var allowance = ct.length >= 5 ? 2 : ct.length >= 3 ? 1 : 0;
      var need = ct.length >= 5 ? 3 : ct.length >= 3 ? 2 : ct.length;
      if (missing <= allowance && matched >= need) return true;
    }
    return false;
  }

  function verifySourceTitle(item, sourceTitle, episodeInfo) {
    var raw = cleanSourceTitle(sourceTitle);
    if (!raw) return { ok: false, reason: 'missing-title' };

    if (/\b(vostfr|subfrench)\b/i.test(raw) && !/\b(vff|truefrench|vf)\b/i.test(raw)) {
      return { ok: false, reason: 'vostfr' };
    }

    if (episodeInfo) {
      var marker = episodeMarker(raw);
      if (marker) {
        if (marker.season !== episodeInfo.season || marker.episode !== episodeInfo.episode) {
          return { ok: false, reason: 'episode-mismatch' };
        }
      }
    } else {
      if (episodeMarker(raw)) return { ok: false, reason: 'episode-source-for-film' };
      var sy = sourceYear(raw);
      var cy = parseInt(item.year, 10) || 0;
      if (sy && cy && Math.abs(sy - cy) > 2) return { ok: false, reason: 'year-mismatch' };
    }

    if (!titleMatches(item, raw)) return { ok: false, reason: 'title-mismatch' };
    return { ok: true, raw: raw };
  }

  function titleError(reason) {
    if (reason === 'missing-title') return 'La page source ne fournit pas de titre vérifiable ; lecture bloquée.';
    if (reason === 'vostfr') return 'Cette source est en VOSTFR ; la VF n\'est pas disponible via cette source.';
    if (reason === 'episode-mismatch') return 'La source ne correspond pas à l\'épisode demandé ; lecture bloquée.';
    if (reason === 'episode-source-for-film') return 'La source correspond à un épisode, pas au film demandé ; lecture bloquée.';
    if (reason === 'year-mismatch') return 'L\'année de la source ne correspond pas au titre demandé ; lecture bloquée.';
    return 'Le titre de la source ne correspond pas au titre demandé ; lecture bloquée.';
  }

  /* --------------------------------------------------------------- embed/HLS */

  function unpackDeanEdwards(html) {
    try {
      var text = String(html == null ? '' : html);
      var m = text.match(/\}\('([\s\S]{200,}?)',(\d+),(\d+),'/);
      if (!m) return '';
      var start = text.indexOf(m[0]) + m[0].length;
      var tail = text.slice(start, start + 200000);
      var e = tail.match(/^([\s\S]{100,}?)'\.split\('\|'\)/);
      if (!e) return '';
      var enc = m[1];
      var radix = parseInt(m[2], 10);
      var count = parseInt(m[3], 10);
      var dict = e[1].split('|');
      if (!radix || radix < 2 || radix > 36) return '';
      if (!count || count > 2000 || dict.length < count || dict.length > 5000) return '';
      if (enc.length > 500000) return '';
      while (count-- > 0) {
        if (dict[count]) {
          var re = new RegExp('\\b' + count.toString(radix) + '\\b', 'g');
          enc = enc.replace(re, (function (v) { return function () { return v; }; })(dict[count]));
        }
        if (enc.length > 1000000) return '';
      }
      return enc;
    } catch (_) {
      return '';
    }
  }

  function firstMediaUrl(text) {
    var s = String(text == null ? '' : text)
      .replace(/\\\//g, '/')
      .replace(/&amp;/gi, '&');
    var candidates = [], m;
    var re = /(?:file|src|url)\s*:\s*["'](https?:\/\/[^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi;
    while ((m = re.exec(s))) candidates.push(m[1]);
    if (!candidates.length) {
      re = /["'](https?:\/\/[^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi;
      while ((m = re.exec(s))) candidates.push(m[1]);
    }
    if (!candidates.length) {
      re = /["'](\/\/?[^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi;
      while ((m = re.exec(s))) {
        var rel = m[1];
        candidates.push(/^\/\//.test(rel) ? 'https:' + rel : UQLOAD + rel);
      }
    }
    var i, u;
    for (i = 0; i < candidates.length; i++) {
      u = candidates[i];
      if (isUqloadHost(hostOf(u))) {
        return { url: u, type: /\.mp4(?:\?|$)/i.test(u) ? 'mp4' : 'hls' };
      }
    }
    return null;
  }

  function mediaFromHtml(html) {
    var decoded = unpackDeanEdwards(html);
    var media = decoded ? firstMediaUrl(decoded) : null;
    if (media) return media;
    return firstMediaUrl(html);
  }

  function parseAttrs(s) {
    var out = {}, m;
    var re = /([A-Z0-9-]+)\s*=\s*("[^"]*"|[^,]*)/g;
    while ((m = re.exec(String(s == null ? '' : s)))) {
      out[m[1]] = String(m[2] || '').replace(/^"|"$/g, '');
    }
    return out;
  }

  function parseMaster(text, baseUrl) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var out = [];
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
      var res = String(attrs.RESOLUTION || '').match(/(\d+)\s*x\s*(\d+)/i);
      var height = res ? parseInt(res[2], 10) : 0;
      var bw = parseInt(String(attrs.BANDWIDTH || '').replace(/[^\d]/g, ''), 10) || 0;
      var abs = resolveUrl(baseUrl, uri);
      if (/^https:\/\//i.test(abs) && isUqloadHost(hostOf(abs))) {
        out.push({ url: abs, height: height, bandwidth: bw });
      }
    }
    return out;
  }

  function validateMediaPlaylist(text) {
    var t = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/^\s+/, '');
    if (t.indexOf('#EXTM3U') !== 0) return false;
    if (/#EXT-X-KEY\s*:[^\n]*METHOD\s*=\s*(?!NONE)/i.test(t)) return false;
    if (/#EXT-X-MAP\s*:/i.test(t)) return false;
    if (/#EXT-X-BYTERANGE\s*:/i.test(t)) return false;
    var lines = t.split(/\r?\n/);
    var expect = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (!line) continue;
      if (/^#EXTINF:/i.test(line)) { expect = true; continue; }
      if (line.charAt(0) === '#') continue;
      if (expect) {
        if (/\.(?:jpe?g|png|webp|gif|avif)(?:\?|#|$)/i.test(line)) return false;
        return true;
      }
    }
    return false;
  }

  function packHls(valid) {
    valid.sort(function (a, b) {
      return (b.height - a.height) || (b.bandwidth - a.bandwidth) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
    });
    var seen = {}, list = [];
    for (var i = 0; i < valid.length; i++) {
      var key = valid[i].height ? String(valid[i].height) : 'auto';
      if (seen[key]) continue;
      seen[key] = true;
      list.push(valid[i]);
    }
    if (!list.length) return null;

    var streams = [], qualities = [];
    for (var j = 0; j < list.length; j++) {
      var v = list[j];
      var label = v.height ? ('dub ' + v.height + 'p') : 'dub Auto';
      var q = v.height ? (v.height + 'p') : 'Auto';
      streams.push(label, v.url);
      qualities.push({ label: label, height: v.height || undefined, url: v.url, headers: STREAM_HEADERS });
    }
    var top = list[0];
    var topQ = top.height ? (top.height + 'p') : 'Auto';
    return {
      streams: streams,
      url: top.url,
      headers: STREAM_HEADERS,
      streamType: 'hls',
      quality: topQ,
      defaultQuality: topQ,
      qualities: qualities,
      subtitles: [],
      lang: 'dub'
    };
  }

  function streamFail(message, lang) {
    return {
      streams: [],
      subtitles: [],
      lang: lang || 'dub',
      error: { message: message }
    };
  }

  async function resolveHls(masterUrl, deadline) {
    var r = await fetchText(masterUrl, STREAM_HEADERS, left(deadline, 7000));
    if (!r.text) {
      r = await fetchText(masterUrl, STREAM_HEADERS, left(deadline, 5000));
    }
    var text = String(r.text || '').replace(/^\uFEFF/, '').replace(/^\s+/, '');
    if (r.status !== 200 || text.indexOf('#EXTM3U') !== 0) {
      return { ok: false, error: 'Flux uqload indisponible (expiré ou inaccessible).' };
    }

    var variants = parseMaster(text, masterUrl);
    if (!variants.length) {
      if (validateMediaPlaylist(text)) {
        var single = [{ url: masterUrl, height: 0, bandwidth: 0 }];
        var packedSingle = packHls(single);
        return packedSingle ? { ok: true, result: packedSingle } : { ok: false, error: 'Aucune qualité HLS lisible.' };
      }
      return { ok: false, error: 'Aucune qualité HLS lisible.' };
    }

    var valid = [], batch, results, i, j;
    for (i = 0; i < variants.length; i += 4) {
      batch = variants.slice(i, i + 4);
      results = await Promise.all(batch.map(async function (v) {
        try {
          var vr = await fetchText(v.url, STREAM_HEADERS, left(deadline, 5000));
          if (vr.status !== 200) return null;
          if (!validateMediaPlaylist(vr.text)) return null;
          return { url: v.url, height: v.height, bandwidth: v.bandwidth };
        } catch (_) {
          return null;
        }
      }));
      for (j = 0; j < results.length; j++) if (results[j]) valid.push(results[j]);
    }
    if (!valid.length) return { ok: false, error: 'Aucune qualité HLS lisible.' };
    var packed = packHls(valid);
    return packed ? { ok: true, result: packed } : { ok: false, error: 'Aucune qualité HLS lisible.' };
  }

  async function resolveSource(item, watchUrl, episodeInfo, deadline) {
    var id = uqloadIdFromUrl(watchUrl);
    if (!id) {
      var host = hostOf(watchUrl);
      if (/heiwastream\.fr$/i.test(host)) {
        return streamFail('HeiwaStream est une bêta fermée non prise en charge.');
      }
      return streamFail('Source non prise en charge : ce module lit uniquement les embeds publics uqload.');
    }

    var landingUrl = UQLOAD + '/' + id + '.html';
    var landing = await fetchTextWithRetry(
      landingUrl,
      { 'Referer': SITE + '/', 'Accept': 'text/html,application/xhtml+xml' },
      deadline,
      8000
    );
    if (landing.status === 404 || landing.status === 410) {
      return streamFail('Source uqload expirée ou supprimée.');
    }
    if (landing.status < 200 || landing.status >= 300 || !landing.text) {
      return streamFail('Source uqload inaccessible.');
    }
    if (/file is no longer available|has expired|has been deleted/i.test(landing.text)) {
      return streamFail('Source uqload expirée ou supprimée.');
    }

    var sourceTitle = titleFromHtml(landing.text);
    if (!sourceTitle) return streamFail('La page source ne fournit pas de titre vérifiable ; lecture bloquée.');
    var check = verifySourceTitle(item, sourceTitle, episodeInfo);
    if (!check.ok) return streamFail(titleError(check.reason));

    var media = mediaFromHtml(landing.text);
    if (!media) {
      var embedUrl = UQLOAD + '/embed-' + id + '.html';
      var embed = await fetchTextWithRetry(
        embedUrl,
        { 'Referer': SITE + '/', 'Accept': 'text/html,application/xhtml+xml' },
        deadline,
        6000
      );
      if (embed.status >= 200 && embed.status < 300 && embed.text) media = mediaFromHtml(embed.text);
    }
    if (!media) return streamFail('Aucun flux uqload lisible trouvé.');
    if (media.type === 'mp4') {
      return streamFail('Flux MP4 uqload non pris en charge ; seule une HLS vérifiée est lue.');
    }

    var hls = await resolveHls(media.url, deadline);
    if (!hls.ok) return streamFail(hls.error);
    return hls.result;
  }

  /* ================================================================ SEARCH */

  async function searchResults(query) {
    var term = String(query == null ? '' : query).replace(/^\s+|\s+$/g, '');
    if (!term) return [];
    var q = normalize(term);
    if (!q) return [];
    var words = q.split(' ').filter(function (x) { return !!x; });
    var deadline = now() + 15000;
    var items = await getCatalog(deadline);
    var scored = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isDiscoverable(item)) continue;
      var title = normalize(item.title);
      var original = normalize(item.originalTitle || '');
      var year = String(item.year || '');
      var genres = normalize((item.genres || []).join(' '));
      var hay = title + ' ' + original + ' ' + year + ' ' + genres;
      var rank = -1;
      if (title === q || original === q) rank = 1000;
      else if (title.indexOf(q) === 0 || original.indexOf(q) === 0) rank = 850;
      else if (title.indexOf(q) >= 0 || original.indexOf(q) >= 0) rank = 700;
      else {
        var hits = 0;
        for (var w = 0; w < words.length; w++) {
          if (words[w].length > 1 && hay.indexOf(words[w]) >= 0) hits++;
        }
        if (hits >= Math.min(words.length, 2)) rank = 300 + hits * 40;
        else if (words.length === 1 && hay.indexOf(words[0]) >= 0) rank = 250;
      }
      if (rank >= 0) scored.push({ item: item, rank: rank });
    }

    scored.sort(function (a, b) {
      if (b.rank !== a.rank) return b.rank - a.rank;
      var av = Number(a.item.weeklyViews) || 0, bv = Number(b.item.weeklyViews) || 0;
      if (bv !== av) return bv - av;
      var ad = String(a.item.addedAt || ''), bd = String(b.item.addedAt || '');
      if (ad !== bd) return ad < bd ? 1 : -1;
      var at = String(a.item.title || ''), bt = String(b.item.title || '');
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

    return scored.slice(0, 30).map(function (s) { return cardOf(s.item); });
  }

  /* =============================================================== DETAILS */

  async function extractDetails(urlOrId) {
    var id = extractId(urlOrId);
    if (!id) throw new Error('details : identifiant manquant');
    var deadline = now() + 15000;
    var items = await getCatalog(deadline);
    var item = findItem(items, id);
    if (!item) throw new Error('details : titre introuvable');

    var premium = isPremium(item);
    var playableFilm = item.type === 'film' && !!uqloadIdFromUrl(item.watchUrl);
    var available = !premium && (item.type === 'serie' || playableFilm);
    var notice = '';
    if (premium) notice = 'NOVA Premium : lecture non disponible via ce module.';
    else if (item.type === 'film' && !playableFilm) notice = 'Source non prise en charge (uqload uniquement).';
    else if (item.type === 'serie') notice = 'Les épisodes premium ou non-uqload sont masqués.';
    else notice = 'La correspondance de la source est vérifiée à la lecture.';

    return {
      id: String(item.id),
      href: String(item.id),
      url: String(item.id),
      type: item.type === 'serie' ? 'series' : 'video',
      title: clean(item.title),
      description: clean(item.synopsis || ''),
      image: item.poster || item.backdrop || '',
      poster: item.poster || '',
      backdrop: item.backdrop || '',
      year: String(item.year || ''),
      genres: Array.isArray(item.genres) ? item.genres.slice(0, 8) : [],
      rating: item.voteAverage != null ? item.voteAverage : undefined,
      duration: item.duration || '',
      seasons: Number(item.seasons) || 0,
      trailerUrl: item.trailerUrl || '',
      premium: premium,
      available: available,
      notice: notice
    };
  }

  /* ============================================================== EPISODES */

  async function extractEpisodes(seriesId) {
    var id = extractId(seriesId);
    if (!id) return [];
    var deadline = now() + 15000;
    var items = await getCatalog(deadline);
    var item = findItem(items, id);
    if (!item) throw new Error('épisodes : titre introuvable');
    if (isPremium(item)) return [];

    if (item.type !== 'serie') {
      if (!uqloadIdFromUrl(item.watchUrl)) return [];
      return [{
        id: String(item.id),
        number: 1,
        href: String(item.id),
        title: clean(item.title) || 'Film',
        season: null,
        episode: null,
        dubAvailable: true,
        subAvailable: false
      }];
    }

    var episodes = await getEpisodes(String(item.id), deadline);
    var out = [];
    for (var i = 0; i < episodes.length; i++) {
      var e = episodes[i];
      if (!e || !e.id) continue;
      if (isPremium(e)) continue;
      if (!uqloadIdFromUrl(e.watchUrl)) continue;
      var season = Number(e.seasonNumber) || 0;
      var number = Number(e.episodeNumber) || 0;
      out.push({
        id: String(e.id),
        number: number || (out.length + 1),
        href: String(e.id),
        title: clean(e.name) || ('S' + season + 'E' + number),
        season: season || null,
        episode: number || null,
        dubAvailable: true,
        subAvailable: false
      });
    }
    out.sort(function (a, b) {
      return (Number(a.season) - Number(b.season)) ||
        (Number(a.episode) - Number(b.episode)) ||
        (String(a.href) < String(b.href) ? -1 : String(a.href) > String(b.href) ? 1 : 0);
    });
    return out;
  }

  /* ============================================================ STREAM URL */

  async function extractStreamUrl(episodeHref, lang) {
    var want = String(lang == null ? '' : lang).toLowerCase().replace(/^\s+|\s+$/g, '');
    if (want === 'sub' || want === 'vostfr') {
      return streamFail('VOSTFR non disponible via cette route ; ce module propose la VF (dub).', want);
    }
    if (want && !/^(dub|vf|fr|french)$/.test(want)) {
      return streamFail('Langue non prise en charge ; ce module propose la VF (dub).', want);
    }

    var ref = extractId(episodeHref);
    if (!ref) return streamFail('Identifiant de lecture manquant.');

    var deadline = now() + 16000;
    try {
      var episodeInfo = parseEpisodeId(ref);
      var item = null, episode = null, watchUrl = '';

      if (episodeInfo) {
        var items = await getCatalog(deadline);
        item = findItem(items, episodeInfo.titleId);
        if (!item) return streamFail('Série introuvable dans le catalogue.');
        if (item.type !== 'serie') return streamFail('Identifiant d\'épisode invalide.');
        if (isPremium(item)) return streamFail('Cette série est réservée à NOVA Premium ; lecture non disponible.');

        var episodes = await getEpisodes(episodeInfo.titleId, deadline);
        episode = findEpisode(episodes, episodeInfo.id);
        if (!episode) return streamFail('Épisode introuvable dans la liste de la série.');
        if (isPremium(episode)) return streamFail('Cet épisode est réservé à NOVA Premium ; lecture non disponible.');
        watchUrl = String(episode.watchUrl || '');
      } else if (/^movie-\d+$/i.test(ref)) {
        var films = await getCatalog(deadline);
        item = findItem(films, ref);
        if (!item) return streamFail('Titre introuvable dans le catalogue.');
        if (item.type !== 'film') return streamFail('Identifiant de film invalide.');
        if (isPremium(item)) return streamFail('Ce titre est réservé à NOVA Premium ; lecture non disponible.');
        watchUrl = String(item.watchUrl || '');
      } else {
        return streamFail('Identifiant de lecture non pris en charge.');
      }

      if (!watchUrl) return streamFail('Aucune source de lecture n\'est associée à ce titre.');
      return await resolveSource(item, watchUrl, episodeInfo, deadline);
    } catch (e) {
      return streamFail('Résolution indisponible : ' + String((e && e.message) || e));
    }
  }

  /* ============================================================= DISCOVERY */

  var GENRES = [
    { name: 'Drame', id: 'drame' },
    { name: 'Action', id: 'action' },
    { name: 'Aventure', id: 'aventure' },
    { name: 'Comédie', id: 'comedie' },
    { name: 'Thriller', id: 'thriller' },
    { name: 'Crime', id: 'crime' },
    { name: 'Science-Fiction', id: 'science-fiction' }
  ];

  function dedupeById(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (!x || !x.id || seen[String(x.id)]) continue;
      seen[String(x.id)] = true;
      out.push(x);
    }
    return out;
  }

  function cmpViews(a, b) {
    var av = Number(a.weeklyViews) || 0, bv = Number(b.weeklyViews) || 0;
    if (bv !== av) return bv - av;
    return cmpAdded(a, b);
  }

  function cmpAdded(a, b) {
    var ad = String(a.addedAt || ''), bd = String(b.addedAt || '');
    if (ad !== bd) return ad < bd ? 1 : -1;
    var at = String(a.title || ''), bt = String(b.title || '');
    return at < bt ? -1 : at > bt ? 1 : 0;
  }

  function buildFeeds(items) {
    var playable = [], i;
    for (i = 0; i < items.length; i++) {
      if (isDiscoverable(items[i]) && hasArtwork(items[i])) playable.push(items[i]);
    }

    var films = [], series = [];
    for (i = 0; i < playable.length; i++) {
      if (playable[i].type === 'film') films.push(playable[i]);
      else if (playable[i].type === 'serie') series.push(playable[i]);
    }
    films = dedupeById(films).sort(cmpViews);
    series = dedupeById(series).sort(cmpViews);

    var fresh = dedupeById(playable.slice()).sort(cmpAdded);
    var featured = [], seen = {};
    for (i = 0; i < playable.length; i++) {
      if (playable[i].featured && !seen[String(playable[i].id)]) {
        seen[String(playable[i].id)] = true;
        featured.push(playable[i]);
      }
    }
    for (i = 0; i < fresh.length && featured.length < 30; i++) {
      if (seen[String(fresh[i].id)]) continue;
      seen[String(fresh[i].id)] = true;
      featured.push(fresh[i]);
    }

    var topBase = [];
    for (i = 0; i < playable.length; i++) if (playable[i].trending) topBase.push(playable[i]);
    if (topBase.length < 10) {
      for (i = 0; i < fresh.length && topBase.length < 20; i++) topBase.push(fresh[i]);
    }
    var top10 = dedupeById(topBase).sort(cmpViews).slice(0, 10);

    var feeds = {
      featured: featured,
      top10: top10,
      'new': fresh,
      films: films,
      series: series
    };

    for (var g = 0; g < GENRES.length; g++) {
      var genre = GENRES[g];
      var list = [];
      for (i = 0; i < playable.length; i++) {
        var genres = playable[i].genres;
        if (Array.isArray(genres) && genres.indexOf(genre.name) >= 0) list.push(playable[i]);
      }
      feeds['genre-' + genre.id] = dedupeById(list).sort(cmpViews);
    }
    return feeds;
  }

  async function discoveryHome() {
    var deadline = now() + 7000;
    var items;
    try { items = await getCatalog(deadline); } catch (_) { return { sections: [] }; }
    var feeds = buildFeeds(items);
    var sections = [], seen = {};

    function addSection(id, title, style, list, limit) {
      var out = [], i;
      for (i = 0; i < list.length && out.length < limit; i++) {
        var card = cardOf(list[i]);
        if (!card.href || seen[card.href]) continue;
        seen[card.href] = true;
        out.push(card);
      }
      if (out.length) {
        sections.push({
          id: id,
          title: title,
          style: style,
          items: out,
          viewAll: { mode: 'feed', feedId: id }
        });
      }
    }

    addSection('featured', 'À la une', 'hero', feeds.featured, 6);
    addSection('top10', 'Top 10', 'top10', feeds.top10, 10);
    addSection('new', 'Nouveautés', 'poster', feeds['new'], 30);
    addSection('films', 'Films', 'landscape', feeds.films, 30);
    addSection('series', 'Séries', 'poster', feeds.series, 30);
    for (var g = 0; g < GENRES.length && sections.length < 12; g++) {
      var genre = GENRES[g];
      addSection('genre-' + genre.id, genre.name, 'poster', feeds['genre-' + genre.id], 30);
    }
    return { sections: sections.slice(0, 12) };
  }

  async function discoveryFeed(feedId, page) {
    var pageNumber = Math.max(1, Math.floor(Number(page) || 1));
    var feed = String(feedId == null ? '' : feedId).toLowerCase().replace(/^\s+|\s+$/g, '');
    var deadline = now() + 9000;
    var items;
    try { items = await getCatalog(deadline); } catch (_) {
      return { items: [], page: pageNumber, hasMore: false };
    }
    var feeds = buildFeeds(items);
    var list = feeds[feed];
    if (!list || !list.length) return { items: [], page: pageNumber, hasMore: false };
    var start = (pageNumber - 1) * PAGE_SIZE;
    var slice = list.slice(start, start + PAGE_SIZE);
    return {
      items: slice.map(cardOf),
      page: pageNumber,
      hasMore: start + slice.length < list.length,
      feedId: feed
    };
  }

  /* ================================================================ EXPORTS */

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
