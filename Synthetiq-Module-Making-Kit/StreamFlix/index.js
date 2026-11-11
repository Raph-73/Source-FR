/* ============================================================================
 * StreamFlix — Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * Catalogue: the site's public JSON API (/api/home/catalog, /api/catalog/...).
 * Search tries the site index first, then a TMDB multi-search + catalogue
 * lookup so an unaccented query still finds "L'Odyssee". Metadata comes from
 * the site's French TMDB proxy (/api/tmdb), with catalogue fields as fallback.
 * Playback: /api/(movies|series)/.../video-url returns the CDN file; that URL
 * answers two 302 hops (proxy, then a signed ?ff= CDN link). The hops are
 * resolved here so the player and the downloader receive the signed file
 * directly, already checked with a small Range request.
 * ==========================================================================*/

(function () {
  'use strict';

  var SITE = 'https://stream-flix.lol';
  var API = SITE + '/api';
  var IMG = 'https://image.tmdb.org/t/p';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  var JSON_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'fr-FR,fr;q=0.9' };
  var STREAM_HEADERS = {
    'User-Agent': UA,
    'Referer': SITE + '/',
    'Accept': '*/*',
    'Accept-Encoding': 'identity'
  };

  var FEEDS = {
    movies_recent: { type: 'movie', sort: 'recent' },
    series_recent: { type: 'tv', sort: 'recent' },
    movies_rating: { type: 'movie', sort: 'rating' },
    series_rating: { type: 'tv', sort: 'rating' }
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
  function enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }

  function normalizePath(p) {
    var v = String(p == null ? '' : p).trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    return v.charAt(0) === '/' ? v : '/' + v;
  }

  function img(path, size) {
    var p = normalizePath(path);
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    return IMG + '/' + size + p;
  }

  function yearOf(j) {
    var m = String((j && (j.release_date || j.first_air_date)) || '').match(/^(\d{4})/);
    return m ? Number(m[1]) : undefined;
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

  /* ------------------------------------------------------------ identities */
  /* Accepted: movie-1368337, tv-100757, tv-100757-s1e1, a site URL, a number. */
  function parseRef(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return null;
    var m = raw.match(/(?:^|[^a-z])movie[-_](\d+)/i);
    if (m) return { type: 'movie', id: m[1] };
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
  async function fetchJson(url, headers, timeoutMs) {
    var res = await fetchv2(url, headers || {}, 'GET', null, { timeoutMs: timeoutMs });
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

  function api(path, deadline, cap) {
    return fetchJson(API + path, merge(JSON_HEADERS, { 'Referer': SITE + '/' }), left(deadline, cap || 10000));
  }

  function tmdb(path, params, deadline, cap) {
    var query = 'language=fr-FR', k;
    if (params) {
      for (k in params) {
        if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
        if (params[k] == null || params[k] === '') continue;
        query += '&' + k + '=' + enc(params[k]);
      }
    }
    return api('/tmdb' + path + '?' + query, deadline, cap || 9000);
  }

  /* ----------------------------------------------------------------- cards */
  function cardOf(item, type, opts) {
    var id = String(item && (item.tmdb_id != null ? item.tmdb_id : item.id));
    if (!id || id === 'undefined' || id === 'null') return null;
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
      /* A hero slot is full-bleed landscape, so the backdrop replaces the poster. */
      card.image = backdrop || poster;
      card.backdrop = backdrop || poster;
    }
    return card;
  }

  function cardsFrom(items, type, limit, hero) {
    var out = [], seen = {}, i;
    for (i = 0; i < (items || []).length && out.length < limit; i++) {
      var it = items[i] || {};
      if (it.is_active === false || it.adult === true) continue;
      var key = String(it.tmdb_id != null ? it.tmdb_id : it.id);
      if (seen[key]) continue;
      seen[key] = true;
      var card = cardOf(it, type, { hero: !!hero });
      if (!card || !card.title || !card.image) continue;
      out.push(card);
    }
    return out;
  }

  function mixCards(movieItems, tvItems, limit, hero) {
    var out = [], i = 0;
    while (out.length < limit && (i < movieItems.length || i < tvItems.length)) {
      if (i < movieItems.length) {
        var m = cardsFrom([movieItems[i]], 'movie', 1, hero);
        if (m.length) out.push(m[0]);
      }
      if (out.length >= limit) break;
      if (i < tvItems.length) {
        var t = cardsFrom([tvItems[i]], 'tv', 1, hero);
        if (t.length) out.push(t[0]);
      }
      i++;
    }
    return out;
  }

  /* ----------------------------------------------------------------- search */
  async function searchResults(query) {
    var deadline = now() + 16000;
    var term = String(query == null ? '' : query).trim();

    if (!term) {
      var home = await api('/home/catalog', deadline, 10000);
      if (home.status !== 200 || !home.data) return [];
      return mixCards(home.data.latestMovies || [], home.data.latestSeries || [], 24);
    }

    var r = await api('/home/search?q=' + enc(term) + '&limit=24', deadline, 9000);
    var movies = [], series = [];
    if (r.status === 200 && r.data) {
      movies = Array.isArray(r.data.movies) ? r.data.movies : [];
      series = Array.isArray(r.data.series) ? r.data.series : [];
    }
    var direct = mixCards(movies, series, 24);
    if (direct.length) return direct;

    /* The site's search is accent-sensitive ("odyssee" finds nothing while
     * "L'Odyssee" does). TMDB is accent-insensitive, and the catalogue lookup
     * keeps only the titles the site can actually play. */
    var found = await tmdb('/search/multi', { query: term, page: 1, include_adult: 'false' }, deadline, 10000);
    if (found.status !== 200 || !found.data || !Array.isArray(found.data.results)) {
      throw new Error('StreamFlix search failed (HTTP ' + (r.status || found.status) + ')');
    }
    var movieIds = [], tvIds = [], i;
    for (i = 0; i < found.data.results.length && i < 20; i++) {
      var hit = found.data.results[i] || {};
      if (hit.media_type === 'movie' && movieIds.indexOf(String(hit.id)) === -1) movieIds.push(String(hit.id));
      if (hit.media_type === 'tv' && tvIds.indexOf(String(hit.id)) === -1) tvIds.push(String(hit.id));
    }
    if (!movieIds.length && !tvIds.length) return [];

    var look = await api('/catalog/browse/lookup?movie=' + movieIds.join(',') + '&tv=' + tvIds.join(','), deadline, 10000);
    if (look.status !== 200 || !look.data) return [];
    return mixCards(look.data.movies || [], look.data.series || [], 24);
  }

  /* ---------------------------------------------------------------- details */
  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref) throw new Error('StreamFlix: invalid id');
    var deadline = now() + 18000;

    /* Catalogue fields are already French and only exist for playable titles;
     * TMDB fills the gaps the catalogue does not store (genres, seasons). */
    var settled = await Promise.all([
      api('/catalog/by-tmdb/' + (ref.type === 'tv' ? 'tv' : 'movie') + '/' + enc(ref.id), deadline, 11000).catch(function () { return null; }),
      tmdb('/' + ref.type + '/' + enc(ref.id), null, deadline, 12000).catch(function () { return null; })
    ]);
    var cat = settled[0], tr = settled[1];
    var cj = cat && cat.status === 200 && cat.data ? cat.data : null;
    var tj = tr && tr.status === 200 && tr.data ? tr.data : null;
    if (!cj && !tj) throw new Error('StreamFlix details failed (HTTP ' + (tr ? tr.status : cat.status) + ')');

    var poster = img((cj && cj.poster_path) || (tj && tj.poster_path), 'w500');
    var banner = img((cj && cj.backdrop_path) || (tj && tj.backdrop_path), 'original');
    var genres = [], i;
    var rawGenres = (tj && Array.isArray(tj.genres)) ? tj.genres : ((cj && Array.isArray(cj.genres)) ? cj.genres : []);
    for (i = 0; i < rawGenres.length; i++) {
      var g = typeof rawGenres[i] === 'string' ? rawGenres[i] : (rawGenres[i] && rawGenres[i].name);
      var name = clean(g);
      if (name && genres.indexOf(name) === -1) genres.push(name);
    }

    var out = {
      id: hrefOf(ref), href: hrefOf(ref), url: SITE, type: 'video',
      title: clean((cj && (cj.title || cj.name)) || (tj && (tj.title || tj.name)) || ''),
      description: clean((cj && cj.overview) || (tj && tj.overview) || ''),
      image: poster || banner,
      poster: poster || banner,
      year: yearOf(cj) || yearOf(tj),
      genres: genres,
      status: clean((tj && tj.status) || (cj && cj.status) || '')
    };
    if (banner) { out.banner = banner; out.backdrop = banner; }

    var vote = num(cj && cj.vote_average) || num(tj && tj.vote_average);
    if (vote > 0) out.rating = Math.round(vote * 10) / 10;

    if (ref.type === 'tv') {
      var seasons = num((tj && tj.number_of_seasons) || (cj && cj.number_of_seasons));
      var episodes = num((tj && tj.number_of_episodes) || (cj && cj.number_of_episodes));
      if (seasons) out.seasons = seasons;
      if (episodes) out.episodes = episodes;
    } else {
      var runtime = num((tj && tj.runtime) || (cj && cj.runtime));
      if (runtime) out.duration = runtime;
    }
    return out;
  }

  /* --------------------------------------------------------------- episodes */
  async function seasonNames(seriesId, seasons, deadline) {
    var names = {}, i;
    for (i = 0; i < seasons.length; i += 4) {
      if (now() >= deadline - 1500) break;
      var batch = seasons.slice(i, i + 4);
      var results = await Promise.all(batch.map(async function (sn) {
        try {
          var r = await tmdb('/tv/' + enc(seriesId) + '/season/' + sn, null, deadline, 7000);
          if (r.status !== 200 || !r.data || !Array.isArray(r.data.episodes)) return null;
          return { sn: sn, list: r.data.episodes };
        } catch (_) {
          return null;
        }
      }));
      for (var b = 0; b < results.length; b++) {
        if (!results[b]) continue;
        var list = results[b].list, sn = results[b].sn;
        for (var e = 0; e < list.length; e++) {
          var ep = list[e] || {};
          names[sn + ':' + num(ep.episode_number)] = {
            title: clean(ep.name || ''),
            image: img(ep.still_path, 'w300')
          };
        }
      }
    }
    return names;
  }

  async function extractEpisodes(seriesId) {
    var ref = parseRef(seriesId);
    if (!ref) throw new Error('StreamFlix: invalid id');
    if (ref.type === 'movie') {
      return [{ number: 1, href: 'movie-' + ref.id, title: 'Film', season: null }];
    }

    var deadline = now() + 28000;
    var by = await api('/catalog/by-tmdb/tv/' + enc(ref.id), deadline, 11000);
    var dbId = by.status === 200 && by.data ? String(by.data.id || '') : '';
    if (!dbId) throw new Error('StreamFlix: this series is not in the catalogue');

    var eps = await api('/series/' + enc(dbId) + '/episode-videos', deadline, 12000);
    var available = Array.isArray(eps.data) ? eps.data.filter(function (e) {
      return e && e.has_video !== false && num(e.season_number) > 0 && num(e.episode_number) > 0;
    }) : [];

    var seasons = [];
    if (available.length) {
      for (var i = 0; i < available.length; i++) {
        var sn = num(available[i].season_number);
        if (seasons.indexOf(sn) === -1) seasons.push(sn);
      }
      seasons.sort(function (a, b) { return a - b; });
    } else {
      /* No per-episode index: fall back to TMDB's season list. Playback still
       * goes through the same video-url endpoint, which reports missing files. */
      var show = await tmdb('/tv/' + enc(ref.id), null, deadline, 9000);
      if (show.status !== 200 || !show.data) throw new Error('StreamFlix episodes failed (HTTP ' + show.status + ')');
      var list = Array.isArray(show.data.seasons) ? show.data.seasons : [];
      for (var s = 0; s < list.length; s++) {
        var n = num(list[s] && list[s].season_number);
        if (n >= 1) seasons.push(n);
      }
      seasons.sort(function (a, b) { return a - b; });
      if (!seasons.length) throw new Error('StreamFlix: no episode listing');
    }

    var names = await seasonNames(ref.id, seasons, deadline);
    var out = [];
    if (available.length) {
      for (var a = 0; a < available.length; a++) {
        var item = available[a];
        var season = num(item.season_number), number = num(item.episode_number);
        var meta = names[season + ':' + number] || {};
        var entry = {
          number: number,
          href: 'tv-' + ref.id + '-s' + season + 'e' + number,
          title: meta.title || ('Episode ' + number),
          season: season
        };
        if (meta.image) entry.image = meta.image;
        out.push(entry);
      }
      out.sort(function (x, y) { return (x.season - y.season) || (x.number - y.number); });
      return out;
    }

    for (var s2 = 0; s2 < seasons.length; s2++) {
      var cur = seasons[s2];
      for (var k in names) {
        if (!Object.prototype.hasOwnProperty.call(names, k)) continue;
        var parts = k.split(':');
        if (num(parts[0]) !== cur) continue;
        var epNum = num(parts[1]);
        var name = names[k];
        out.push({
          number: epNum,
          href: 'tv-' + ref.id + '-s' + cur + 'e' + epNum,
          title: name.title || ('Episode ' + epNum),
          season: cur
        });
      }
    }
    out.sort(function (x, y) { return (x.season - y.season) || (x.number - y.number); });
    if (!out.length) throw new Error('StreamFlix: no episode listing');
    return out;
  }

  /* -------------------------------------------------------------- streaming */
  function headerOf(headers, name) {
    if (!headers) return '';
    var direct = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
    return direct == null ? '' : String(direct);
  }

  function isVideoResponse(r) {
    if (!r || (r.status !== 200 && r.status !== 206)) return false;
    var ct = headerOf(r.headers, 'content-type').toLowerCase();
    if (ct.indexOf('video/') === 0 || ct.indexOf('application/octet-stream') >= 0) return true;
    return r.text.indexOf('ftyp') >= 0;
  }

  /* Redirects must be read, not followed: the CDN only serves the file when
   * the signed hop is requested with the module's own headers. Following the
   * chain automatically lands on an HTML challenge instead of the MP4. */
  async function hop(url, headers, deadline) {
    var res = await fetchv2(url, headers, 'GET', null, {
      followRedirects: false,
      timeoutMs: left(deadline, 10000)
    });
    var status = num(res && (res.status || res.statusCode));
    var headersOut = (res && res.headers) || {};
    var text = '';
    if (status >= 200 && status < 300 && res && typeof res.text === 'function') {
      try { text = await res.text(); } catch (_) { text = ''; }
    }
    return { status: status, headers: headersOut, text: String(text == null ? '' : text) };
  }

  /* The CDN answers 302 -> proxy -> signed ?ff= file. Resolve both hops with
   * Range probes (never HEAD) so the player and the downloader get the signed
   * file directly instead of a routing URL that drops headers on redirect. */
  async function resolveSigned(originUrl, deadline) {
    var base = merge(STREAM_HEADERS, { 'Range': 'bytes=0-1' });
    var first;
    try {
      first = await hop(originUrl, base, deadline);
    } catch (_) {
      return originUrl;
    }
    if (!(first.status >= 300 && first.status < 400)) {
      return isVideoResponse(first) ? originUrl : originUrl;
    }

    var proxy = resolveUrl(originUrl, headerOf(first.headers, 'location'));
    if (!proxy) return originUrl;

    var second;
    try {
      second = await hop(proxy, base, deadline);
    } catch (_) {
      return proxy;
    }
    if (second.status >= 300 && second.status < 400) {
      var signed = resolveUrl(proxy, headerOf(second.headers, 'location'));
      if (!signed) return proxy;
      try {
        var check = await hop(signed, base, deadline);
        if (isVideoResponse(check)) return signed;
        if (check.status >= 300 && check.status < 400) {
          var next = resolveUrl(signed, headerOf(check.headers, 'location'));
          if (next) return next;
        }
      } catch (_) { /* player may still fetch it directly */ }
      return signed;
    }
    if (second.status === 200 || second.status === 206) return proxy;
    return originUrl;
  }

  function qualityLabel(data) {
    var q = clean(data && (data.video_quality || data.quality || data.videoQuality));
    if (!q) q = 'HD';
    if (/^(4k|uhd)$/i.test(q)) q = '4K';
    else if (/^(full[\s-]?hd|fhd)$/i.test(q)) q = 'FHD';
    return 'StreamFlix \u00b7 ' + q + ' (VF)';
  }

  function packProgressive(url, data) {
    var label = qualityLabel(data);
    return {
      url: url,
      headers: STREAM_HEADERS,
      streamType: 'mp4',
      quality: label,
      defaultQuality: label,
      streams: [label, url],
      qualities: [{ label: label, url: url, headers: STREAM_HEADERS }],
      servers: [{
        name: 'StreamFlix', label: label, url: url, headers: STREAM_HEADERS,
        streamType: 'mp4', lang: 'dub'
      }],
      subtitles: [],
      lang: 'dub',
      provider: 'StreamFlix'
    };
  }

  /* HLS is only used if the catalogue ever returns a playlist instead of a
   * file; the current catalogue is progressive MP4. */
  async function packHls(hlsUrl, deadline) {
    var r = await fetchText(hlsUrl, STREAM_HEADERS, left(deadline, 11000));
    var text = String(r.text == null ? '' : r.text).replace(/^\uFEFF/, '').replace(/^\s+/, '');
    if (r.status !== 200 || text.indexOf('#EXTM3U') !== 0) return packProgressive(hlsUrl, {});
    if (text.indexOf('#EXT-X-STREAM-INF') === -1) {
      var auto = 'StreamFlix \u00b7 Auto (VF)';
      return {
        url: hlsUrl, headers: STREAM_HEADERS, streamType: 'hls',
        quality: auto, defaultQuality: auto,
        streams: [auto, hlsUrl],
        qualities: [{ label: auto, url: hlsUrl, headers: STREAM_HEADERS }],
        subtitles: [], lang: 'dub', provider: 'StreamFlix'
      };
    }
    var lines = text.split(/\r?\n/), variants = [];
    for (var i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
      var res = String(lines[i]).match(/RESOLUTION=(\d+)x(\d+)/i);
      var uri = '';
      for (var j = i + 1; j < lines.length; j++) {
        var line = lines[j].replace(/^\s+|\s+$/g, '');
        if (!line) continue;
        if (line.charAt(0) !== '#') { uri = line; break; }
      }
      if (!uri) continue;
      variants.push({ url: resolveUrl(hlsUrl, uri), height: res ? Number(res[2]) : 0 });
    }
    variants.sort(function (a, b) { return b.height - a.height; });
    if (!variants.length) return packProgressive(hlsUrl, {});
    var label = variants[0].height ? ('StreamFlix \u00b7 ' + variants[0].height + 'p (VF)') : 'StreamFlix \u00b7 HD (VF)';
    var streams = [], qualities = [], seen = {};
    for (var v = 0; v < variants.length; v++) {
      var q = (variants[v].height || 0) ? (variants[v].height + 'p') : 'Auto';
      if (seen[q]) continue;
      seen[q] = true;
      streams.push(q, variants[v].url);
      qualities.push({ label: q, url: variants[v].url, headers: STREAM_HEADERS });
    }
    return {
      url: variants[0].url, headers: STREAM_HEADERS, streamType: 'hls',
      quality: label, defaultQuality: label,
      streams: streams, qualities: qualities,
      subtitles: [], lang: 'dub', provider: 'StreamFlix'
    };
  }

  function streamFail(message) {
    return { streams: [], subtitles: [], lang: 'dub', error: { message: message } };
  }

  /* -------------------------------------------------------- intro / outro */
  /* The site's player asks its own IntroDB proxy for skip markers. Only TV
   * episodes have them; movies and episodes IntroDB does not cover must go
   * without the fields, so every failure here is silent. */
  var IMDB_TTL = 7 * 24 * 60 * 60 * 1000;
  var SEGMENT_TTL = 30 * 60 * 1000;
  var imdbCache = {};
  var segmentCache = {};

  function markerOf(seg) {
    if (!seg || typeof seg !== 'object') return null;
    var start = num(seg.start_sec), end = num(seg.end_sec);
    if (!(end > start)) { start = num(seg.start_ms) / 1000; end = num(seg.end_ms) / 1000; }
    if (!(end > start) || start < 0) return null;
    return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
  }

  async function imdbIdOf(tmdbId, deadline) {
    var key = String(tmdbId);
    var hit = imdbCache[key];
    if (hit && now() - hit.at < IMDB_TTL) return hit.id;
    try {
      var r = await api('/tmdb/tv/' + enc(key) + '/external_ids?language=fr-FR', deadline, 7000);
      var id = r.status === 200 && r.data ? String(r.data.imdb_id || '') : '';
      if (/^tt\d+$/.test(id)) {
        imdbCache[key] = { id: id, at: now() };
        return id;
      }
    } catch (_) { /* markers stay optional */ }
    return '';
  }

  async function markersFor(tmdbId, season, episode, deadline) {
    var key = String(tmdbId) + ':' + season + ':' + episode;
    var hit = segmentCache[key];
    if (hit && now() - hit.at < SEGMENT_TTL) return hit.markers;
    var imdb = await imdbIdOf(tmdbId, deadline);
    if (!imdb) return null;
    try {
      var r = await api('/introdb/segments?imdb_id=' + enc(imdb) +
        '&season=' + enc(season) + '&episode=' + enc(episode), deadline, 7000);
      if (r.status !== 200 || !r.data) return null;
      var markers = { intro: markerOf(r.data.intro), outro: markerOf(r.data.outro) };
      segmentCache[key] = { markers: markers, at: now() };
      return markers;
    } catch (_) {
      return null;
    }
  }

  function withMarkers(packed, markers) {
    if (!packed || !markers) return packed;
    if (markers.intro) packed.intro = markers.intro;
    if (markers.outro) packed.outro = markers.outro;
    return packed;
  }

  async function extractStreamUrl(episodeHref, lang) {
    var ref = parseRef(episodeHref);
    if (!ref) return streamFail('StreamFlix : identifiant invalide.');
    if (ref.type === 'tv' && (!ref.season || !ref.episode)) { ref.season = ref.season || 1; ref.episode = ref.episode || 1; }

    var deadline = now() + 22000;

    /* Skip markers are independent of the video file, so they are requested in
     * parallel; withMarkers() drops whatever did not arrive. */
    var markers = ref.type === 'tv'
      ? markersFor(ref.id, ref.season || 1, ref.episode || 1, deadline).catch(function () { return null; })
      : null;

    var by = await api('/catalog/by-tmdb/' + (ref.type === 'tv' ? 'tv' : 'movie') + '/' + enc(ref.id), deadline, 11000);
    if (by.status !== 200 || !by.data || !by.data.id) {
      return streamFail('StreamFlix : ce titre n\'est pas dans le catalogue du site.');
    }
    var dbId = String(by.data.id);

    var path = ref.type === 'tv'
      ? '/series/' + enc(dbId) + '/season/' + (ref.season || 1) + '/episode/' + (ref.episode || 1) + '/video-url'
      : '/movies/' + enc(dbId) + '/video-url';
    var r = await api(path, deadline, 14000);
    var data = r.data || {};
    if (r.status === 404 || data.notYetAired || data.notYetReleased || data._airDateBlock || data.missing) {
      return streamFail('StreamFlix : cet episode n\'est pas encore disponible.');
    }
    if (r.status !== 200) {
      return streamFail('StreamFlix : le serveur n\'a pas fourni de flux (HTTP ' + r.status + ').');
    }

    var raw = String(data.url || data.video_url || data.playerUrl || data.directUrl || '').trim();
    if (!raw) return streamFail('StreamFlix : aucune source video pour ce titre.');

    var hls = data.isHls === true || /\.m3u8(?:\?|$|&)/i.test(raw);
    if (hls) {
      try {
        var playlist = await packHls(resolveUrl(SITE + '/', raw), deadline);
        return withMarkers(playlist, await markers);
      } catch (_) {
        return streamFail('StreamFlix : la playlist n\'a pas pu etre lue.');
      }
    }

    var target = await resolveSigned(resolveUrl(SITE + '/', raw), deadline);
    return withMarkers(packProgressive(target, data), await markers);
  }

  /* -------------------------------------------------------------- discovery */
  function catalogCards(items, type, limit, hero) {
    return cardsFrom(items, type, limit, hero);
  }

  async function browseList(type, sort, page, limit, deadline) {
    var path = '/catalog/browse?type=' + (type === 'tv' ? 'tv' : 'movie') +
      '&sort=' + enc(sort || 'recent') + '&page=' + page + '&limit=' + limit;
    var r = await api(path, deadline, 13000);
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.items)) return null;
    return {
      items: r.data.items,
      page: num(r.data.page) || page,
      totalPages: Math.max(1, num(r.data.totalPages) || 1)
    };
  }

  async function discoveryHome() {
    var deadline = now() + 24000;
    var results = await Promise.all([
      api('/home/catalog', deadline, 11000).catch(function () { return null; }),
      browseList('movie', 'rating', 1, 24, deadline).catch(function () { return null; }),
      browseList('tv', 'rating', 1, 24, deadline).catch(function () { return null; })
    ]);
    var home = results[0], bestMovies = results[1], bestSeries = results[2];
    var sections = [];

    var heroMovies = home && home.data ? (home.data.heroMovies || []) : [];
    var heroSeries = home && home.data ? (home.data.heroSeries || []) : [];
    var hero = mixCards(heroMovies, heroSeries, 8, true);
    if (hero.length) sections.push({ id: 'hero', title: 'A la une', style: 'hero', items: hero });

    var latestMovies = home && home.data ? (home.data.latestMovies || []) : [];
    var latestSeries = home && home.data ? (home.data.latestSeries || []) : [];

    var movies = catalogCards(latestMovies, 'movie', 24);
    if (movies.length) sections.push({ id: 'movies-recent', title: 'Derniers films ajoutes', style: 'poster', items: movies, viewAll: { mode: 'feed', feedId: 'movies_recent' } });

    var series = catalogCards(latestSeries, 'tv', 24);
    if (series.length) sections.push({ id: 'series-recent', title: 'Dernieres series ajoutees', style: 'poster', items: series, viewAll: { mode: 'feed', feedId: 'series_recent' } });

    if (bestMovies) {
      var topMovies = catalogCards(bestMovies.items, 'movie', 24);
      if (topMovies.length) sections.push({ id: 'movies-rating', title: 'Films les mieux notes', style: 'poster', items: topMovies, viewAll: { mode: 'feed', feedId: 'movies_rating' } });
    }
    if (bestSeries) {
      var topSeries = catalogCards(bestSeries.items, 'tv', 24);
      if (topSeries.length) sections.push({ id: 'series-rating', title: 'Series les mieux notees', style: 'poster', items: topSeries, viewAll: { mode: 'feed', feedId: 'series_rating' } });
    }
    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    var pageNum = Math.max(1, Number(page) || 1);
    var feed = FEEDS[String(feedId == null ? '' : feedId)];
    if (!feed) return { items: [], page: pageNum, hasMore: false };

    var r = await browseList(feed.type, feed.sort, pageNum, 50, now() + 20000);
    if (!r) return { items: [], page: pageNum, hasMore: false };
    return {
      items: catalogCards(r.items, feed.type, 50),
      page: pageNum,
      hasMore: pageNum < Math.min(r.totalPages, 200)
    };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
