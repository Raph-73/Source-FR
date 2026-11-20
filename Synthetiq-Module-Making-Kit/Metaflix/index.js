/* ============================================================================
 * METAFLIX — Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * Catalogue: metaflix.fr's public JSON API (/api/home, /api/search,
 * /api/catalog, /api/title/<type>/<id>, /api/title/tv/<id>/season/<n>) in
 * fr-FR. Posters come from the TMDB image host the site uses.
 *
 * Playback: three sources, chosen like the site's own player:
 *   - zen (site label "Lecteur MetaFlix · VF"): the API hands out a zen-cdn
 *     MP4. The first request only redirects when it carries the site Referer,
 *     and the proxy hop then signs the file with ?ff=. The module follows the
 *     chain with a one-byte Range and hands the player the signed URL. Its
 *     quality label comes from the title's zen_quality entry for the season.
 *   - direct (/api/v/<token>.m3u8, same label): an HLS master with French and
 *     English audio renditions. Variants and segments live on a plain CDN
 *     (finepulfe) that serves any user agent but answers 403 to a foreign
 *     Referer, so this reader's headers never carry one. Subtitles are VTT
 *     files on the same CDN, listed by <token>/subtitles.
 *   - moviez (site label "Lecteur partenaire · VF et VO"): an embed resolved
 *     through the partner's own API, only tried when nothing else answered.
 *
 * Default selection: the site keeps the MP4 first and switches to the HLS
 * when the title is flagged heavy, mixed-audio or low quality for that
 * season; the module applies the same rule. The MP4 is a progressive file
 * (multi-GB on films), the HLS is segmented and adaptive, so both are offered
 * with their exact host headers in `qualities` and `servers`.
 * ==========================================================================*/

(function () {
  'use strict';

  var SITE = 'https://metaflix.fr';
  var IMG = 'https://image.tmdb.org/t/p';
  var MOVIEZ = 'https://api.moviez.ac';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  var JSON_HEADERS = {
    'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'fr-FR,fr;q=0.9'
  };
  var HTML_HEADERS = {
    'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'fr-FR,fr;q=0.9'
  };
  /* zen-cdn redirects a bare request to a Telegram promo: the proxy hop needs
   * this Referer to sign the file. The module also sends it while following the
   * chain so every hop is treated like the site's player. */
  var MP4_HEADERS = {
    'User-Agent': UA, 'Referer': SITE + '/',
    'Accept': '*/*', 'Accept-Encoding': 'identity'
  };
  /* /api/v/ playlists are answered to a plain fingerprint; the CDN behind them
   * returns 403 when a foreign Referer is attached. */
  var HLS_HEADERS = {
    'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity'
  };
  var MOVIEZ_PAGE_HEADERS = {
    'User-Agent': UA, 'Referer': SITE + '/',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'fr-FR,fr;q=0.9'
  };
  var MOVIEZ_STREAM_HEADERS = { 'User-Agent': UA, 'Referer': MOVIEZ + '/' };

  var LIMITED_MESSAGE = 'MetaFlix : le site limite les requetes (HTTP 429). Reessayez dans une minute.';

  /* --------------------------------------------------------------- helpers */
  function now() { return Date.now(); }
  function left(deadline, cap) { return Math.max(600, Math.min(deadline - now(), cap || 12000)); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function merge(a, b) {
    var out = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
    return out;
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

  function yearOf(v) {
    var m = String(v == null ? '' : v).match(/^(\d{4})/);
    return m ? Number(m[1]) : 0;
  }

  /* ------------------------------------------------- rate limit and caching */
  /* The site answers HTTP 429 under bursts and asks the browser for a Turnstile
   * token, which a module cannot and must not produce. Requests are therefore
   * spaced out and a 429 becomes an explicit retry message. The site also
   * caches its own responses; the module keeps lists for a few minutes so a
   * second screen does not re-request the same page. */
  var SITE_GAP = 220;
  var siteGap = SITE_GAP;
  var siteGate = Promise.resolve();
  var siteLastAt = 0;
  var siteLimitedUntil = 0;

  /* No setTimeout in the app runtime: a short wait is a microtask spin. Used
   * only between requests, never while a request is in flight. */
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

  function pace() {
    var slot = siteGate.then(async function () {
      var wait = siteLastAt + siteGap - now();
      if (wait > 0) await pause(Math.min(wait, 400));
      siteLastAt = now();
    });
    siteGate = slot.catch(function () { });
    return slot;
  }

  function isLimited() { return now() < siteLimitedUntil; }
  function markLimited() {
    siteLimitedUntil = now() + 45000;
    siteGap = Math.min(1200, Math.round(siteGap * 2));
  }
  function limitedError() {
    var err = new Error(LIMITED_MESSAGE);
    err.limited = true;
    return err;
  }

  var CACHE = {};
  function cacheGet(key) {
    var hit = CACHE[key];
    if (hit && hit.exp > now()) return hit.value;
    return null;
  }
  function cacheSet(key, value, ttl) { CACHE[key] = { value: value, exp: now() + ttl }; }

  /* -------------------------------------------------------------- transport */
  async function fetchJson(url, headers, timeoutMs, method, body) {
    await pace();
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
    await pace();
    var res = await fetchv2(url, headers || {}, 'GET', null, { timeoutMs: timeoutMs });
    var status = num(res && (res.status || res.statusCode));
    if (status === 429) markLimited();
    var text = '';
    if (res && typeof res.text === 'function') text = await res.text();
    else if (res && typeof res.body === 'string') text = res.body;
    return { status: status, text: String(text == null ? '' : text) };
  }

  /* ------------------------------------------------------------ identities */
  /* hrefs: movie-299534, tv-60059 (series), tv-60059-s1e2 (episode). Watch
   * URLs are accepted as a fallback so a pasted link still resolves. */
  function parseRef(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return null;
    var m = raw.match(/^movie[-_](\d+)/i);
    if (m) return { type: 'movie', id: m[1] };
    m = raw.match(/^tv[-_](\d+)(?:[-_]s(\d+)(?:[-_]?e(\d+))?)?/i);
    if (m) {
      var tv = { type: 'tv', id: m[1] };
      if (m[2]) { tv.season = Number(m[2]) || 1; tv.episode = Number(m[3]) || 1; }
      return tv;
    }
    m = raw.match(/^series[-_](\d+)(?:[-_]s(\d+)[-_]?e(\d+))?/i);
    if (m) {
      var se = { type: 'tv', id: m[1] };
      if (m[2]) { se.season = Number(m[2]) || 1; se.episode = Number(m[3]) || 1; }
      return se;
    }
    if (/^https?:\/\//i.test(raw)) {
      var u = raw.match(/\/watch\/(movie|tv)\/(\d+)(?:[^]*?[?&]season=(\d+))?(?:[^]*?[?&]episode=(\d+))?/i) ||
              raw.match(/\/(movie|tv)\/(\d+)(?:\/|$|[?#])/i);
      if (u) {
        var ref = { type: u[1].toLowerCase(), id: u[2] };
        if (u[3]) { ref.season = Number(u[3]) || 1; ref.episode = Number(u[4]) || 1; }
        return ref;
      }
    }
    return null;
  }

  function hrefOf(ref) {
    if (!ref) return '';
    if (ref.type === 'movie') return 'movie-' + ref.id;
    return ref.season
      ? 'tv-' + ref.id + '-s' + ref.season + 'e' + (ref.episode || 1)
      : 'tv-' + ref.id;
  }

  /* ------------------------------------------------------------------ cards */
  function cardOf(item, size) {
    if (!item) return null;
    var kind = item.type === 'tv' ? 'tv' : 'movie';
    var id = String(item.id || '');
    var title = clean(item.title || item.name || '');
    if (!id || !title) return null;
    var image = img(item.poster_path, size || 'w500');
    var href = kind === 'movie' ? 'movie-' + id : 'tv-' + id;
    var card = { id: href, href: href, type: 'video', title: title };
    if (image) { card.image = image; card.poster = image; }
    var year = yearOf(item.release_date || item.first_air_date);
    if (year) card.year = year;
    var rating = num(item.vote_average);
    if (rating > 0) card.rating = Math.round(rating * 10) / 10;
    return card;
  }

  function cardsFrom(items, limit, size) {
    var out = [], seen = {}, i;
    for (i = 0; i < items.length && out.length < limit; i++) {
      var card = cardOf(items[i], size);
      if (!card) continue;
      if (seen[card.href]) continue;
      seen[card.href] = true;
      out.push(card);
    }
    return out;
  }

  /* ---------------------------------------------------------------- search */
  async function searchResults(query) {
    var term = String(query == null ? '' : query).trim();
    if (!term) return [];
    var key = 'search:' + term.toLowerCase();
    var cached = cacheGet(key);
    if (cached) return cached;
    if (isLimited()) throw limitedError();
    var r = await fetchJson(SITE + '/api/search?q=' + encodeURIComponent(term),
      JSON_HEADERS, 9000);
    if (r.status === 429) throw limitedError();
    var items = r.data && Array.isArray(r.data.items) ? r.data.items : [];
    if (r.status !== 200) throw new Error('MetaFlix : recherche indisponible (HTTP ' + r.status + ').');
    var cards = cardsFrom(items, 24, 'w500');
    cacheSet(key, cards, 180000);
    return cards;
  }

  /* --------------------------------------------------------------- details */
  async function titleOf(ref, deadline) {
    var key = 'title:' + ref.type + ':' + ref.id;
    var hit = cacheGet(key);
    if (hit) return hit;
    if (isLimited()) throw limitedError();
    var r = await fetchJson(SITE + '/api/title/' + ref.type + '/' + encodeURIComponent(ref.id),
      JSON_HEADERS, left(deadline, 8000));
    if (r.status === 429) throw limitedError();
    if (r.status !== 200 || !r.data || (!r.data.title && !r.data.name)) return null;
    cacheSet(key, r.data, 180000);
    return r.data;
  }

  function genresOf(t) {
    var out = [], list = t && Array.isArray(t.genres) ? t.genres : [];
    for (var i = 0; i < list.length; i++) {
      var name = clean(list[i] && list[i].name);
      if (name) out.push(name);
    }
    return out;
  }

  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref) throw new Error('MetaFlix : identifiant invalide.');
    var key = 'details:' + ref.type + ':' + ref.id;
    var cached = cacheGet(key);
    if (cached) return cached;

    var deadline = now() + 15000;
    var t = await titleOf(ref, deadline);
    if (!t) throw new Error('MetaFlix : cette fiche est introuvable.');

    var href = hrefOf(ref);
    var title = clean(t.title || t.name || '');
    var poster = img(t.poster_path, 'w780');
    var out = {
      id: href, href: href, url: SITE + '/watch/' + ref.type + '/' + ref.id,
      type: 'video',
      title: title,
      description: clean(t.overview || ''),
      genres: genresOf(t)
    };
    if (poster) { out.image = poster; out.poster = poster; }
    var year = yearOf(t.release_date || t.first_air_date);
    if (year) out.year = year;
    var rating = num(t.vote_average);
    if (rating > 0) out.rating = Math.round(rating * 10) / 10;
    if (t.tagline) out.tagline = clean(t.tagline);

    if (ref.type === 'movie') {
      var minutes = num(t.runtime);
      if (minutes) out.duration = minutes;
    } else {
      var seasons = num(t.number_of_seasons), episodes = num(t.number_of_episodes);
      if (seasons) out.seasons = seasons;
      if (episodes) out.episodes = episodes;
      var run = Array.isArray(t.episode_run_time) && t.episode_run_time.length ? num(t.episode_run_time[0]) : 0;
      if (run) out.duration = run;
    }
    cacheSet(key, out, 180000);
    return out;
  }

  /* -------------------------------------------------------------- episodes */
  async function seasonList(seriesId, season, deadline) {
    var key = 'season:' + seriesId + ':' + season;
    var cached = cacheGet(key);
    if (cached) return cached;
    if (isLimited()) throw limitedError();
    var r = await fetchJson(SITE + '/api/title/tv/' + encodeURIComponent(seriesId) +
      '/season/' + season + '?v=2', JSON_HEADERS, left(deadline, 9000));
    if (r.status === 429) throw limitedError();
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.episodes)) return null;

    var out = [], seen = {};
    for (var i = 0; i < r.data.episodes.length; i++) {
      var e = r.data.episodes[i] || {};
      var number = num(e.episode_number);
      if (!number || seen[number]) continue;
      seen[number] = true;
      var entry = {
        number: number,
        href: 'tv-' + seriesId + '-s' + season + 'e' + number,
        title: clean(e.name) || ('Episode ' + number),
        season: season
      };
      var still = img(e.still_path, 'w300');
      if (still) entry.image = still;
      var minutes = num(e.runtime);
      if (minutes) entry.runtime = minutes;
      if (e.air_date) entry.date = String(e.air_date);
      if (String(e.availability || '') === 'upcoming') entry.available = false;
      out.push(entry);
    }
    out.sort(function (a, b) { return a.number - b.number; });
    if (out.length) cacheSet(key, out, 300000);
    return out;
  }

  async function mapLimit(list, limit, fn) {
    var out = new Array(list.length), cursor = 0;
    async function worker() {
      while (cursor < list.length) {
        var at = cursor++;
        out[at] = await fn(list[at], at);
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, list.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  async function extractEpisodes(seriesId) {
    var ref = parseRef(seriesId);
    if (!ref) throw new Error('MetaFlix : identifiant invalide.');
    if (ref.type === 'movie') {
      return [{ number: 1, href: 'movie-' + ref.id, title: 'Film', season: null }];
    }
    var key = 'episodes:' + ref.id;
    var cached = cacheGet(key);
    if (cached) return cached;
    if (isLimited()) throw limitedError();

    var deadline = now() + 24000;
    var t = await titleOf(ref, deadline);
    if (!t) throw new Error('MetaFlix : cette serie est introuvable.');

    var numbers = [];
    if (Array.isArray(t.seasons)) {
      for (var i = 0; i < t.seasons.length; i++) {
        var sn = num(t.seasons[i] && t.seasons[i].season_number);
        if (sn > 0) numbers.push(sn);
      }
    }
    if (!numbers.length) {
      var total = num(t.number_of_seasons);
      for (var n = 1; n <= total; n++) numbers.push(n);
    }
    numbers.sort(function (a, b) { return a - b; });
    if (!numbers.length) throw new Error('MetaFlix : aucune saison listee pour cette serie.');

    var lists = await mapLimit(numbers, 2, async function (season) {
      if (now() >= deadline - 1000) return { season: season, list: null };
      try {
        return { season: season, list: await seasonList(ref.id, season, deadline) };
      } catch (e) {
        if (e && e.limited) throw e;
        return { season: season, list: null };
      }
    });

    var out = [], seen = {}, failed = 0;
    for (var s = 0; s < lists.length; s++) {
      if (!lists[s] || !lists[s].list) { failed++; continue; }
      for (var j = 0; j < lists[s].list.length; j++) {
        var ep = lists[s].list[j];
        var epKey = ep.season + ':' + ep.number;
        if (seen[epKey]) continue;
        seen[epKey] = true;
        out.push(ep);
      }
    }
    if (!out.length) {
      throw new Error('MetaFlix : la liste des episodes n\'a pas pu etre chargee. Reessayez.');
    }
    /* A missing season is reported to the caller only when nothing else could be
     * read; completed seasons stay cached so a retry re-reads just the gap. */
    if (failed === lists.length) throw new Error('MetaFlix : aucune saison disponible.');
    out.sort(function (a, b) { return (a.season - b.season) || (a.number - b.number); });
    cacheSet(key, out, 300000);
    return out;
  }

  /* ------------------------------------------------------------- streaming */
  function streamFail(message) {
    return { streams: [], subtitles: [], lang: 'dub', provider: 'MetaFlix', error: { message: message } };
  }

  function parseAttrs(text) {
    var out = {}, re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi, m;
    while ((m = re.exec(String(text == null ? '' : text)))) {
      out[m[1].toUpperCase()] = String(m[2] || '').replace(/^"|"$/g, '');
    }
    return out;
  }

  function resolveUrl(base, rel) {
    var r = String(rel == null ? '' : rel);
    if (/^https?:\/\//i.test(r)) return r;
    var b = String(base == null ? '' : base);
    if (r.charAt(0) === '/') {
      var m = b.match(/^(https?:\/\/[^\/]+)/i);
      return m ? m[1] + r : r;
    }
    if (!b) return r;
    var cut = b.replace(/[?#].*$/, '');
    return cut.slice(0, cut.lastIndexOf('/') + 1) + r;
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
      if (!/^https?:\/\//i.test(url)) continue;
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

  function heightOfLabel(label) {
    var m = String(label == null ? '' : label).match(/(\d{3,4})p/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  function packHls(list, masterUrl, opts) {
    var headers = (opts && opts.headers) || HLS_HEADERS;
    var lang = (opts && opts.lang) || 'dub';
    list = list.slice().sort(function (a, b) {
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

  function zenQualityOf(t, season) {
    var list = t && Array.isArray(t.zen_quality) ? t.zen_quality : [];
    var fallback = null;
    for (var i = 0; i < list.length; i++) {
      var row = list[i] || {};
      if (Number(row.season) === season) return row;
      if (!fallback) fallback = row;
    }
    return fallback;
  }

  /* The API names the zen-cdn file; every later hop is followed here with a
   * one-byte Range so the file itself is never downloaded. The proxy hop takes
   * 2-3 s on a cold title, hence the six-second budget. */
  async function resolveZen(src, deadline, quality) {
    var label = clean(quality && quality.label) || 'HD';
    var height = heightOfLabel(label);
    function readerAt(url) {
      /* The CDN names an MP4 in every case seen so far. If a hop ever lands on
       * a playlist, the file is still playable but its ladder is unknown, so it
       * is offered as Auto/HLS rather than mislabelled with the MP4 tier. */
      var isHls = /\.m3u8(?:$|[?#])/i.test(url);
      return {
        player: 'MetaFlix', provider: 'zen',
        type: isHls ? 'hls' : 'mp4',
        height: isHls ? 0 : height, primary: false, safe: true, pref: 3,
        packed: isHls
          ? packHls([{ url: url, height: 0 }], null, { headers: MP4_HEADERS, lang: 'dub' })
          : packMp4(url, MP4_HEADERS, label, 'dub')
      };
    }
    var cur = src, i;
    for (i = 0; i < 8 && now() < deadline; i++) {
      var res;
      try {
        res = await fetchv2(cur, merge(MP4_HEADERS, { 'Range': 'bytes=0-1' }), 'GET', null,
          { timeoutMs: left(deadline, 3500), followRedirects: false });
      } catch (err) {
        /* The signed file normally honours the Range; when the CDN sends the
         * whole file the sandbox aborts at its 5 MiB cap. That body can only be
         * the media file, so the signed URL is valid. A timeout is not. */
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
      if (status !== 200 && status !== 206) return null;
      if (/\.m3u8(?:$|[?#])/i.test(cur)) return readerAt(cur);
      if (!/\.mp4(?:$|[?#])/i.test(cur)) return null;
      var ct = String(headers['content-type'] || '');
      if (ct && !/video|octet-stream/i.test(ct)) return null;
      return readerAt(cur);
    }
    return null;
  }

  function subtitleLang(raw) {
    var v = String(raw == null ? '' : raw).toLowerCase();
    if (/^fr/.test(v) || v === 'fre' || v === 'fra') return 'fr';
    if (/^en/.test(v) || v === 'eng') return 'en';
    return v.slice(0, 2) || 'und';
  }

  /* Subtitles live on the same plain CDN as the segments and are listed by the
   * direct token. The token expires, so this runs right after the token is
   * fetched; a stale token answers 404 and simply leaves the list empty. */
  async function subtitlesOf(token, deadline) {
    var base = String(token == null ? '' : token).replace(/\.m3u8(?:[?#].*)?$/i, '');
    if (!/^https?:\/\//i.test(base)) base = SITE + (base.charAt(0) === '/' ? '' : '/') + base;
    if (!base) return [];
    var r = await fetchJson(base + '/subtitles', HLS_HEADERS, left(deadline, 2500));
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.tracks)) return [];
    var out = [], seen = {};
    for (var i = 0; i < r.data.tracks.length && out.length < 10; i++) {
      var track = r.data.tracks[i] || {};
      var lang = subtitleLang(track.lang);
      var label = clean(track.name) || lang;
      var files = Array.isArray(track.files) ? track.files : [];
      for (var f = 0; f < files.length && out.length < 10; f++) {
        var url = String(files[f] == null ? '' : files[f]);
        if (!/^https?:\/\//i.test(url) || seen[url]) continue;
        seen[url] = true;
        out.push({
          id: url, url: url, file: url, label: label,
          language: lang, lang: lang, kind: 'subtitle',
          headers: { 'User-Agent': UA }
        });
      }
    }
    return out;
  }

  async function resolveDirect(token, deadline) {
    var masterUrl = /^https?:\/\//i.test(token) ? token : SITE + token;
    var master = await fetchText(masterUrl, HLS_HEADERS, left(deadline, 3500));
    if (master.status !== 200 || !master.text) return null;
    var variants = parseMaster(master.text, masterUrl);
    var packed = variants.length
      ? packHls(variants, null, { headers: HLS_HEADERS, lang: 'dub' })
      : packHls([{ url: masterUrl, height: 0 }], null, { headers: HLS_HEADERS, lang: 'dub' });
    if (!packed) return null;
    packed.streamType = 'hls';
    packed.subtitles = await subtitlesOf(token, deadline).catch(function () { return []; });
    var top = variants[0] || {};
    return {
      player: 'MetaFlix HLS', provider: 'direct', type: 'hls',
      height: top.height || 0, primary: false, safe: true, pref: 2,
      packed: packed
    };
  }

  function parseP2(html) {
    var m = String(html == null ? '' : html).match(/window\.P2\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (_) { return null; }
  }

  /* Partner reader, copied in spirit from the proven miaw resolver: the embed
   * page carries a window.P2 config whose token buys an HLS master. Only used
   * when neither site reader answered. */
  async function resolveMoviez(embed, deadline) {
    var pageUrl = /^https?:\/\//i.test(embed) ? embed : MOVIEZ + embed;
    var page = await fetchText(pageUrl, MOVIEZ_PAGE_HEADERS, left(deadline, 8000));
    if (page.status !== 200 || !page.text) return null;
    var cfg = parseP2(page.text);
    if (!cfg || !cfg.t) return null;

    var r = await fetchJson(MOVIEZ + '/api/v2/stream', merge(JSON_HEADERS, {
      'Content-Type': 'application/json',
      'Referer': pageUrl,
      'Origin': MOVIEZ
    }), left(deadline, 8000), 'POST', JSON.stringify({ t: cfg.t }));
    if (r.status !== 200 || !r.data || !r.data.hls) return null;

    var masterUrl = String(r.data.hls);
    var master = await fetchText(masterUrl, merge(MOVIEZ_STREAM_HEADERS, { 'Accept': '*/*' }), left(deadline, 6000));
    var variants = master.status === 200 ? parseMaster(master.text, masterUrl) : [];
    var lang = String(cfg.lang || 'vf') === 'vostfr' ? 'sub' : 'dub';
    var packed = variants.length
      ? packHls(variants, masterUrl, { headers: MOVIEZ_STREAM_HEADERS, lang: lang })
      : packMp4(masterUrl, MOVIEZ_STREAM_HEADERS, 'Auto', lang);
    if (!packed) return null;
    packed.streamType = 'hls';
    return {
      player: 'MetaFlix partenaire', provider: 'moviez', type: 'hls',
      height: (variants[0] && variants[0].height) || 0,
      primary: false, safe: true, pref: 1, packed: packed
    };
  }

  async function markersFor(ref, deadline) {
    if (ref.type !== 'tv') return null;
    var r = await fetchJson(SITE + '/api/skips/tv/' + encodeURIComponent(ref.id) +
      '?season=' + (ref.season || 1) + '&episode=' + (ref.episode || 1),
      JSON_HEADERS, left(deadline, 2500));
    var list = r.status === 200 && r.data && Array.isArray(r.data.intro) ? r.data.intro : [];
    for (var i = 0; i < list.length; i++) {
      var seg = list[i] || {};
      var start = num(seg.start), end = num(seg.end);
      if (end > start && start >= 0) {
        return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
      }
    }
    return null;
  }

  function composeReaders(readers, subtitles, intro) {
    var order = readers.filter(function (r) { return !!(r && r.packed && r.packed.url); });
    if (!order.length) return null;

    var candidates = [], labels = {}, r, i;
    for (r = 0; r < order.length; r++) {
      var reader = order[r];
      var list = (reader.packed.qualities || []).slice(0, 4);
      for (i = 0; i < list.length; i++) {
        var q = list[i];
        if (!q || !q.url) continue;
        var label = reader.player + ' \u00b7 ' + q.label;
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

    /* `streams` is the flat list older clients read with the response-level
     * headers applied to every pair, so it only carries the default reader's
     * renditions. Everything is in `qualities` with its own host headers. */
    var top = candidates[0];
    var entries = [], streams = [];
    for (i = 0; i < candidates.length; i++) {
      entries.push({ label: candidates[i].label, url: candidates[i].url, headers: candidates[i].headers });
      if (candidates[i].reader === top.reader) {
        streams.push((candidates[i].lang === 'sub' ? 'sub ' : 'dub ') + candidates[i].label, candidates[i].url);
      }
    }
    var subs = Array.isArray(subtitles) ? subtitles : [];
    var out = {
      url: top.url,
      headers: top.headers,
      streamType: top.type || 'mp4',
      quality: top.tier,
      defaultQuality: top.tier,
      streams: streams,
      qualities: entries,
      subtitles: subs,
      lang: 'dub',
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
          subtitles: rd.packed.subtitles || [],
          qualities: rd.packed.qualities || []
        };
      })
    };
    if (intro) out.intro = intro;
    return out;
  }

  async function extractStreamUrl(episodeHref, lang) {
    var ref = parseRef(episodeHref);
    if (!ref) return streamFail('MetaFlix : identifiant invalide.');
    if (ref.type === 'tv') { ref.season = ref.season || 1; ref.episode = ref.episode || 1; }

    var cacheKey = 'stream:' + hrefOf(ref);
    var cached = cacheGet(cacheKey);
    if (cached) return cached;
    if (isLimited()) return streamFail(LIMITED_MESSAGE);

    var deadline = now() + 20000;
    var title = null;
    try { title = await titleOf(ref, deadline); } catch (e) { if (e && e.limited) return streamFail(LIMITED_MESSAGE); }

    var quality = title ? zenQualityOf(title, ref.season) : null;
    /* Same rule as the site's player: the MP4 is the default unless the title
     * is marked heavy, mixed-audio, or low quality for this season. */
    var zenPreferred = !(title && (title.zen_heavy || title.zen_mixed_audio || (quality && quality.low)));

    var params = ref.type === 'tv'
      ? ('?season=' + ref.season + '&episode=' + ref.episode)
      : '';
    var zenPath = SITE + '/api/stream/' + ref.type + '/' + encodeURIComponent(ref.id) + params;
    var directPath = SITE + '/api/stream/' + ref.type + '/' + encodeURIComponent(ref.id) + '/direct' + params;
    var moviezPath = SITE + '/api/stream/' + ref.type + '/' + encodeURIComponent(ref.id) + '/moviez' + params;

    var zenNote = '';
    var zenTask = (async function () {
      var r = await fetchJson(zenPath, JSON_HEADERS, left(deadline, 6000));
      if (r.status === 429) throw limitedError();
      var src = r.data && r.data.url ? String(r.data.url) : '';
      if (!src) {
        if (r.data && r.data.error) zenNote = String(r.data.error);
        return null;
      }
      return await resolveZen(/^https?:\/\//i.test(src) ? src : SITE + (src.charAt(0) === '/' ? '' : '/') + src,
        deadline, quality);
    })().catch(function () { return null; });

    var directTask = (async function () {
      var r = await fetchJson(directPath, JSON_HEADERS, left(deadline, 5000));
      if (r.status === 429) throw limitedError();
      var token = r.data && (r.data.url || r.data.backup);
      if (!token) return null;
      return await resolveDirect(String(token), deadline);
    })().catch(function () { return null; });

    var markerTask = markersFor(ref, deadline).catch(function () { return null; });

    var settled = await Promise.all([zenTask, directTask, markerTask]);
    var zen = settled[0], hls = settled[1], intro = settled[2];

    if (zen && hls) {
      zen.primary = zenPreferred;
      hls.primary = !zenPreferred;
    } else if (zen) {
      zen.primary = true;
    } else if (hls) {
      hls.primary = true;
    }

    var readers = [];
    if (zen) readers.push(zen);
    if (hls) readers.push(hls);

    /* The site says the episode is not published yet: neither reader has a
     * file, and the partner would not either. Report that instead of a generic
     * failure. */
    if (!readers.length && /disponible/i.test(zenNote)) {
      return streamFail('MetaFlix : cet episode n\'est pas encore disponible.');
    }

    var subtitles = hls ? (hls.packed.subtitles || []) : [];
    var composed = composeReaders(readers, subtitles, intro);
    if (!composed) {
      /* Partner only when the site's own readers gave nothing: its page and
       * stream service needs several seconds and must not delay playback. */
      var embed = '';
      try {
        var mz = await fetchJson(moviezPath, JSON_HEADERS, left(deadline, 3500));
        embed = mz.status === 200 && mz.data && mz.data.url ? String(mz.data.url) : '';
      } catch (_) { embed = ''; }
      if (embed) {
        var partner = await resolveMoviez(embed, now() + 5000).catch(function () { return null; });
        if (partner) { partner.primary = true; composed = composeReaders([partner], [], intro); }
      }
    }
    if (composed) {
      cacheSet(cacheKey, composed, 60000);
      return composed;
    }
    return streamFail('MetaFlix : les lecteurs du site n\'ont pas fourni de flux verifie pour ce titre.');
  }

  /* -------------------------------------------------------------- discovery */
  var FEEDS = {
    'trending': { kinds: ['tv', 'movie'], sort: 'trending' },
    'trending-day': { kinds: ['tv', 'movie'], sort: 'trending-day' },
    'recent': { kinds: ['tv', 'movie'], sort: 'recent' },
    'top-rated': { kinds: ['tv', 'movie'], sort: 'top-rated' },
    'popular-movies': { kinds: ['movie'], sort: 'popular' },
    'popular-tv': { kinds: ['tv'], sort: 'popular' },
    'action-movie': { kinds: ['movie'], sort: 'popular', genre: 'action' },
    'horreur-movie': { kinds: ['movie'], sort: 'popular', genre: 'horreur' },
    'animation-movie': { kinds: ['movie'], sort: 'popular', genre: 'animation' },
    'thriller-movie': { kinds: ['movie'], sort: 'popular', genre: 'thriller' }
  };

  function homeSections() {
    return fetchJson(SITE + '/api/home', JSON_HEADERS, 9000);
  }

  async function discoveryHome() {
    var cached = cacheGet('home');
    if (cached) return cached;
    if (isLimited()) return { sections: [] };
    var r;
    try { r = await homeSections(); } catch (_) { return { sections: [] }; }
    if (r.status === 429 || r.status !== 200 || !Array.isArray(r.data)) return { sections: [] };

    var sections = [];
    for (var i = 0; i < r.data.length && sections.length < 12; i++) {
      var raw = r.data[i] || {};
      var id = String(raw.key || '');
      if (!/^[a-z0-9_-]{1,64}$/.test(id)) continue;
      var isHero = raw.layout === 'spotlight' || id === 'hero';
      var isTop = raw.layout === 'top' || id === 'trending';
      var items = cardsFrom(Array.isArray(raw.items) ? raw.items : [],
        isHero ? 8 : (isTop ? 10 : 24),
        isHero ? 'w780' : 'w500');
      if (!items.length) continue;
      var section = {
        id: id,
        title: clean(raw.title) || id,
        style: isHero ? 'hero' : (isTop ? 'top10' : 'poster'),
        items: items
      };
      if (FEEDS[id]) section.viewAll = { mode: 'feed', feedId: id };
      sections.push(section);
    }
    if (sections.length) cacheSet('home', { sections: sections }, 300000);
    return { sections: sections };
  }

  async function catalogPage(kind, feed, page) {
    var url = SITE + '/api/catalog?kind=' + kind + '&page=' + page +
      '&sort=' + encodeURIComponent(feed.sort) + '&limit=25' +
      (feed.genre ? '&genre=' + encodeURIComponent(feed.genre) : '');
    var r = await fetchJson(url, JSON_HEADERS, 9000);
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.items)) {
      return { items: [], totalPages: 0 };
    }
    return { items: r.data.items, totalPages: num(r.data.totalPages) };
  }

  async function discoveryFeed(feedId, page) {
    var pageNum = Math.max(1, Number(page) || 1);
    var feed = FEEDS[String(feedId == null ? '' : feedId)];
    if (!feed) return { items: [], page: pageNum, hasMore: false };
    if (isLimited()) return { items: [], page: pageNum, hasMore: false };

    var pages = await Promise.all(feed.kinds.map(function (kind) {
      return catalogPage(kind, feed, pageNum).catch(function () { return { items: [], totalPages: 0 }; });
    }));

    var merged = [], cursor = 0, more = false;
    for (var k = 0; k < pages.length; k++) if (pageNum < pages[k].totalPages) more = true;
    while (merged.length < 50) {
      var added = false;
      for (var p = 0; p < pages.length && merged.length < 50; p++) {
        if (cursor < pages[p].items.length) { merged.push(pages[p].items[cursor]); added = true; }
      }
      if (!added) break;
      cursor++;
    }
    var cards = cardsFrom(merged, 50, 'w500');
    return { items: cards, page: pageNum, hasMore: more && cards.length > 0 };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
