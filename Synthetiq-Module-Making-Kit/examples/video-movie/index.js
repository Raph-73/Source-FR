/**
 * Movie Direct 0.2.0 — TMDB identity + independent VideoEasy lookup.
 * Runtime hosts: api.themoviedb.org, api.speedracelight.com, VideoEasy CDNs.
 * Does not scrape StreamingUnity or YFlix. Does not label unknown/Italian as English.
 */
(function () {
  'use strict';

  var MODULE = 'Movie Direct';
  var TMDB = 'https://api.themoviedb.org/3';
  var TMDB_KEY = 'PASTE_YOUR_OWN_TMDB_KEY_HERE';   // register free at themoviedb.org — do NOT redistribute a shared key
  var VIDEASY_API = 'https://api.speedracelight.com';
  var VIDEASY_PLAYER = 'https://player.videasy.to';
  var VIDEASY_MAGIC = [109, 118, 109, 49];
  var UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  var FAKE = /tiktokcdn|ibyteimg|ad-site-i18n|\/obj\/ad-site|\.png(?:\?|$)/i;
  var LANGS = [
    { code: 'hi', re: /\bhindi\b/i },
    { code: 'es', re: /\b(spanish|espanol|español|latino|castellano)\b/i },
    { code: 'de', re: /\b(german|deutsch)\b/i },
    { code: 'pt', re: /\b(portuguese|portugues|português)\b/i },
    { code: 'fr', re: /\b(french|francais|français)\b/i },
    { code: 'ar', re: /\barabic\b/i },
    { code: 'it', re: /\bitalian\b/i },
    { code: 'ja', re: /\bjapanese\b/i },
    { code: 'ko', re: /\bkorean\b/i },
    { code: 'en', re: /\b(english|eng)\b/i },
  ];
  var ENGLISH_ENDPOINTS = [
    { path: '/cdn/sources-with-title', name: 'Videasy CDN' },
    { path: '/m4uhd/sources-with-title', name: 'M4UHD' },
    { path: '/vsrc/sources-with-title', name: 'VSrc' },
  ];

  function log(msg) {
    try { console.log('[' + MODULE + '] ' + String(msg || '')); } catch (_) {}
  }

  function clean(value) {
    return String(value == null ? '' : value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function headers(extra) {
    var out = { 'User-Agent': UA, Accept: '*/*' };
    var src = extra || {};
    Object.keys(src).forEach(function (k) { out[k] = src[k]; });
    return out;
  }

  function videasyHeaders() {
    return {
      'User-Agent': UA,
      Accept: 'application/json,text/plain,*/*',
      Origin: VIDEASY_PLAYER,
      Referer: VIDEASY_PLAYER + '/',
    };
  }

  function videasyStreamHeaders() {
    return {
      'User-Agent': UA,
      Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*',
      Origin: VIDEASY_PLAYER,
      Referer: VIDEASY_PLAYER + '/',
    };
  }

  async function readBody(response) {
    if (!response) return '';
    if (typeof response.body === 'string' && response.body) return response.body;
    if (response.json && typeof response.json !== 'function') {
      try { return JSON.stringify(response.json); } catch (_) {}
    }
    if (typeof response.text === 'function') {
      try {
        var text = await response.text();
        if (typeof text === 'string') return text;
      } catch (_) {}
    }
    if (typeof response.json === 'function') {
      try {
        var json = await response.json();
        if (json != null) return typeof json === 'string' ? json : JSON.stringify(json);
      } catch (_) {}
    }
    return '';
  }

  async function request(url, extraHeaders, method, body) {
    try {
      var host = new URL(url).hostname;
      if (globalThis.__mdHosts && typeof globalThis.__mdHosts.push === 'function') {
        globalThis.__mdHosts.push(host);
      }
    } catch (_) {}
    var hdrs = headers(extraHeaders);
    var response = null;
    try {
      if (typeof fetchv2 === 'function') {
        response = await fetchv2(url, hdrs, method || 'GET', body || null);
      } else if (typeof fetch === 'function') {
        response = await fetch(url, { method: method || 'GET', headers: hdrs, body: body || undefined });
      }
    } catch (error) {
      return { ok: false, status: 0, text: '', json: null, error: String(error && error.message ? error.message : error) };
    }
    var status = Number(response && response.status) || 0;
    var text = await readBody(response);
    if ((!text || status === 0 || status >= 500) && typeof fetch === 'function') {
      try {
        var native = await fetch(url, { method: method || 'GET', headers: hdrs, body: body || undefined });
        status = Number(native.status) || 0;
        text = await native.text();
        response = native;
      } catch (_) {}
    }
    var parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: status >= 200 && status < 400, status: status, text: text || '', json: parsed };
  }

  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise(function (resolve) { setTimeout(function () { resolve(fallback); }, ms); }),
    ]);
  }

  async function tmdb(path) {
    var url = TMDB + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(TMDB_KEY) + '&language=en-US';
    var res = await request(url, { Accept: 'application/json' });
    if (!res.ok || !res.json) throw new Error('tmdb_failed');
    return res.json;
  }

  function href(type, id, season, episode) {
    var base = 'https://www.themoviedb.org/' + type + '/' + id;
    if (type === 'tv' && season && episode) return base + '?season=' + season + '&episode=' + episode;
    return base;
  }

  function parseHref(value) {
    var raw = String(value || '').trim();
    var match = raw.match(/themoviedb\.org\/(movie|tv)\/(\d+)(?:\?[^#]*season=(\d+)&episode=(\d+))?/i);
    if (!match) match = raw.match(/^(movie|tv):(\d+)(?::(\d+):(\d+))?$/i);
    if (!match) return null;
    return {
      type: match[1].toLowerCase(),
      id: String(match[2]),
      season: match[3] ? Number(match[3]) : null,
      episode: match[4] ? Number(match[4]) : null,
    };
  }

  function mapItem(row, forcedType) {
    if (!row) return null;
    var type = String(forcedType || row.media_type || '').toLowerCase();
    if (type !== 'movie' && type !== 'tv') return null;
    if (row.adult === true) return null;
    var id = Number(row.id);
    var title = clean(row.title || row.name || row.original_title || row.original_name);
    if (!id || !title) return null;
    var year = String(row.release_date || row.first_air_date || '').slice(0, 4);
    var image = row.poster_path ? 'https://image.tmdb.org/t/p/w500' + row.poster_path : '';
    return {
      id: href(type, id),
      href: href(type, id),
      title: title + (year ? ' (' + year + ')' : ''),
      image: image,
      poster: image,
      type: type,
      mediaType: type,
      year: year || undefined,
      tmdbId: id,
    };
  }

  function videasyImul(a, b) {
    if (typeof Math.imul === 'function') return Math.imul(a, b) >>> 0;
    a = a >>> 0;
    b = b >>> 0;
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bl + (((ah * bl + al * bh) << 16) >>> 0)) >>> 0) >>> 0;
  }

  function videasyU32(x) { return x >>> 0; }

  function videasyMix(e) {
    e = videasyU32(e);
    e ^= e >>> 16;
    e = videasyImul(e, 2246822507);
    e ^= e >>> 13;
    e = videasyImul(e, 3266489909);
    e ^= e >>> 16;
    return videasyU32(e);
  }

  function videasyRotl(e, t) {
    e = videasyU32(e);
    t = t & 31;
    if (!t) return e;
    return videasyU32((e << t) | (e >>> (32 - t)));
  }

  function videasyB64Decode(input) {
    var s = String(input || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    var pad = s.length % 4 === 0 ? s : s + '===='.slice(s.length % 4);
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = [];
    var buf = 0;
    var bits = 0;
    var i;
    for (i = 0; i < pad.length; i += 1) {
      var ch = pad.charAt(i);
      if (ch === '=') break;
      var v = alphabet.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >>> bits) & 0xff);
      }
    }
    return out;
  }

  function videasyUtf8Decode(bytes) {
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var c = bytes[i];
      i += 1;
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xe0) {
        var c2 = bytes[i];
        i += 1;
        out += String.fromCharCode(((c & 0x1f) << 6) | (c2 & 0x3f));
      } else if (c < 0xf0) {
        var c2b = bytes[i];
        var c3 = bytes[i + 1];
        i += 2;
        out += String.fromCharCode(((c & 0x0f) << 12) | ((c2b & 0x3f) << 6) | (c3 & 0x3f));
      } else {
        var c2c = bytes[i];
        var c3b = bytes[i + 1];
        var c4 = bytes[i + 2];
        i += 3;
        var cp = ((c & 7) << 18) | ((c2c & 0x3f) << 12) | ((c3b & 0x3f) << 6) | (c4 & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }

  function videasyKeystate(seed, mediaId) {
    var tNum = Number(mediaId) || 0;
    var S = Object.create(null);
    var fnv = 2166136261;
    var seedStr = String(seed || '');
    var i;
    for (i = 0; i < seedStr.length; i += 1) {
      fnv = videasyImul(fnv ^ seedStr.charCodeAt(i), 16777619);
    }
    var a = videasyMix(videasyMix(fnv) ^ videasyMix(videasyU32(tNum) ^ 2654435769));
    var e;
    for (e = 0; e < 8; e += 1) {
      var tSlot = a % 61;
      a = videasyRotl(videasyU32(a + 2654435769), 7 + (7 & e));
      S[tSlot] = videasyU32(a ^ videasyMix(a));
      a = videasyMix(videasyU32(a + tSlot));
    }
    return { S: S, acc: videasyMix(videasyU32(2779096485 ^ a)) };
  }

  function videasyNextWord(state, tCounter) {
    var r = state.S;
    var o = state.acc;
    var n = o % 61;
    var present = Object.prototype.hasOwnProperty.call(r, n);
    var iMask = present ? 0xffffffff : 0;
    var l = present ? videasyU32(r[n]) : 0;
    var aVal = videasyU32(l ^ videasyImul(2654435769, tCounter + 1));
    var s = o;
    var d = videasyU32(videasyU32(s ^ aVal) | videasyU32(s & aVal & iMask));
    d = videasyU32(videasyRotl(videasyU32(d + o), 31 & n) ^ videasyRotl(o, 31 & videasyImul(n, 7)));
    o = videasyMix(videasyU32(d + 2654435769));
    r[n] = o;
    state.acc = o;
    return o;
  }

  function videasyKeystream(seed, mediaId, length) {
    var state = videasyKeystate(seed, mediaId);
    var out = new Array(length);
    var o = 0;
    var e = 0;
    while (e < length) {
      var t = videasyNextWord(state, o);
      o += 1;
      out[e] = t & 255;
      e += 1;
      if (e < length) { out[e] = (t >>> 8) & 255; e += 1; }
      if (e < length) { out[e] = (t >>> 16) & 255; e += 1; }
      if (e < length) { out[e] = (t >>> 24) & 255; e += 1; }
    }
    return out;
  }

  function videasyDecrypt(payload, seed, mediaId) {
    var raw = videasyB64Decode(String(payload || '').trim().replace(/^"|"$/g, ''));
    if (!raw.length) throw new Error('videasy empty payload');
    var ks = videasyKeystream(seed, mediaId, raw.length);
    var plain = new Array(raw.length);
    var i;
    for (i = 0; i < raw.length; i += 1) plain[i] = raw[i] ^ ks[i];
    for (i = 0; i < VIDEASY_MAGIC.length; i += 1) {
      if (plain[i] !== VIDEASY_MAGIC[i]) throw new Error('videasy decrypt magic mismatch');
    }
    return videasyUtf8Decode(plain.slice(4));
  }

  function detectLanguage(blob) {
    var text = String(blob || '');
    var i;
    for (i = 0; i < LANGS.length; i += 1) {
      if (LANGS[i].re.test(text)) return LANGS[i].code;
    }
    return '';
  }

  function heightFromQuality(value) {
    var text = String(value || '');
    if (/4k|2160|uhd/i.test(text)) return 2160;
    if (/1080/i.test(text)) return 1080;
    if (/720/i.test(text)) return 720;
    if (/480/i.test(text)) return 480;
    return 0;
  }

  function joinUrl(base, rel) {
    if (!rel) return '';
    if (/^https?:\/\//i.test(rel)) return rel;
    try { return new URL(rel, base).toString(); } catch (_) { return rel; }
  }

  function firstMedia(master, base) {
    var lines = String(master || '').split(/\r?\n/);
    var i;
    for (i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
        var j;
        for (j = i + 1; j < lines.length; j += 1) {
          var next = lines[j].trim();
          if (!next || next.charAt(0) === '#') continue;
          return joinUrl(base, next);
        }
      }
    }
    for (i = 0; i < lines.length; i += 1) {
      var media = lines[i].trim();
      if (!media || media.charAt(0) === '#') continue;
      return joinUrl(base, media);
    }
    return '';
  }

  function parseAudioLang(master) {
    var found = [];
    String(master || '').split(/\r?\n/).forEach(function (line) {
      if (line.indexOf('#EXT-X-MEDIA:') !== 0 || !/TYPE=AUDIO/i.test(line)) return;
      var m = line.match(/LANGUAGE="([^"]+)"/i);
      if (m) found.push(m[1].toLowerCase());
    });
    return found;
  }

  function mapCaptions(rawList) {
    var out = [];
    var seen = {};
    (Array.isArray(rawList) ? rawList : []).forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      var file = String(row.url || row.file || row.src || '').trim();
      if (!/^https?:\/\//i.test(file) || seen[file]) return;
      if (/thumb|sprite/i.test(file)) return;
      seen[file] = true;
      var rawLang = clean(row.lang || row.language || row.label || '').toLowerCase();
      var lang = detectLanguage(rawLang) || (/^[a-z]{2,3}/.test(rawLang) ? rawLang.slice(0, 2) : 'und');
      out.push({
        id: file,
        url: file,
        file: file,
        label: clean(row.label || row.language || row.lang || 'Subtitle'),
        language: lang,
        lang: lang,
        kind: 'subtitle',
        headers: videasyStreamHeaders(),
      });
    });
    return out;
  }

  async function probeHls(url, hdrs) {
    if (!url || FAKE.test(url)) return { ok: false, reason: 'fake_url' };
    var playlist = await request(url, Object.assign({ Range: 'bytes=0-8191' }, hdrs));
    if (!playlist.ok || playlist.text.indexOf('#EXTM3U') < 0) {
      return { ok: false, reason: 'not_hls', status: playlist.status };
    }
    if (FAKE.test(playlist.text)) return { ok: false, reason: 'fake_hls' };
    var child = firstMedia(playlist.text, url);
    if (!child || FAKE.test(child)) return { ok: false, reason: 'no_media' };
    var body = playlist.text;
    var mediaUrl = child;
    if (/\.m3u8(?:$|\?)/i.test(child) && child !== url) {
      var variant = await request(child, Object.assign({ Range: 'bytes=0-8191' }, hdrs));
      if (!variant.ok || variant.text.indexOf('#EXTM3U') < 0) return { ok: false, reason: 'variant_fail' };
      body = variant.text;
      mediaUrl = child;
    }
    var seg = firstMedia(body, mediaUrl);
    if (!seg || FAKE.test(seg)) return { ok: false, reason: 'fake_seg' };
    var segment = await request(seg, Object.assign({ Range: 'bytes=0-4095' }, hdrs));
    if (!segment.ok) return { ok: false, reason: 'seg_' + segment.status };
    var sample = segment.text || '';
    if (/^\s*<(?:!doctype|html)/i.test(sample)) return { ok: false, reason: 'seg_html' };
    if (/PNG|JFIF|GIF8|WEBP/i.test(sample.slice(0, 64))) return { ok: false, reason: 'seg_image' };
    var langs = parseAudioLang(playlist.text);
    return { ok: true, master: playlist.text, audioLangs: langs };
  }

  async function resolveVideasy(ref) {
    var path = '/' + ref.type + '/' + ref.id + '?append_to_response=external_ids';
    var meta = await withTimeout(tmdb(path), 8000, null);
    if (!meta) return [];
    var title = clean(meta.title || meta.name || ref.id);
    var year = String(meta.release_date || meta.first_air_date || '').slice(0, 4);
    var imdbId = clean((meta.external_ids && meta.external_ids.imdb_id) || meta.imdb_id);
    var seed = '';
    var seedAttempt;
    for (seedAttempt = 0; seedAttempt < 3 && !seed; seedAttempt += 1) {
      var seedRes = await withTimeout(
        request(VIDEASY_API + '/seed?mediaId=' + encodeURIComponent(ref.id), videasyHeaders()),
        8000,
        null,
      );
      seed = seedRes && seedRes.json && seedRes.json.seed ? String(seedRes.json.seed) : '';
    }
    if (!seed) return [];
    var params = {
      title: title,
      mediaType: ref.type,
      year: year,
      tmdbId: ref.id,
      imdbId: imdbId,
      enc: '2',
      seed: seed,
    };
    if (ref.type === 'tv') {
      params.seasonId = Number(ref.season || 1);
      params.episodeId = Number(ref.episode || 1);
    }
    var hdrs = videasyStreamHeaders();
    var servers = [];
    var seen = {};
    var e;
    for (e = 0; e < ENGLISH_ENDPOINTS.length && servers.length < 3; e += 1) {
      var endpoint = ENGLISH_ENDPOINTS[e];
      var q = Object.keys(params).filter(function (k) {
        return params[k] != null && params[k] !== '';
      }).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]));
      }).join('&');
      var res = await withTimeout(
        request(VIDEASY_API + endpoint.path + '?' + q, videasyHeaders()),
        10000,
        null,
      );
      if (!res || !res.text) continue;
      var data = null;
      try { data = JSON.parse(videasyDecrypt(res.text, seed, ref.id)); } catch (_) { continue; }
      var sources = (data && data.sources) || [];
      var captions = mapCaptions(data.subtitles || data.subs || data.tracks);
      var s;
      for (s = 0; s < sources.length && servers.length < 3; s += 1) {
        var src = sources[s];
        var url = String(src && src.url || '');
        if (!/^https?:\/\//i.test(url) || seen[url] || /\.mpd(\?|$)/i.test(url)) continue;
        var blob = [src.lang, src.audio, src.quality, src.title, src.label].filter(Boolean).join(' ');
        var labeled = detectLanguage(blob);
        if (labeled && labeled !== 'en') continue;
        var audioLanguage = labeled === 'en' ? 'en' : 'und';
        var probe = await withTimeout(probeHls(url, hdrs), 8000, null);
        if (!probe || !probe.ok) continue;
        var masterLangs = probe.audioLangs || [];
        if (masterLangs.length) {
          if (masterLangs.indexOf('en') < 0 && masterLangs.indexOf('eng') < 0) continue;
          audioLanguage = 'en';
        }
        seen[url] = true;
        var height = heightFromQuality(src.quality || src.label);
        var existing = servers.filter(function (row) { return row.name === endpoint.name; })[0];
        var quality = height ? { label: height + 'p', height: height, url: url, headers: hdrs } : null;
        if (existing) {
          if (quality) existing.qualities.push(quality);
          if (height > (existing.height || 0) && height <= 1080) {
            existing.url = url;
            existing.height = height;
          }
          continue;
        }
        servers.push({
          name: endpoint.name,
          url: url,
          height: height,
          headers: hdrs,
          streamType: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
          lang: 'sub',
          audioLanguage: audioLanguage,
          subtitles: captions,
          qualities: quality ? [quality] : [],
        });
      }
    }
    return servers;
  }

  function pack(servers, lang) {
    var primary = servers && servers[0];
    if (!primary || !primary.url) {
      return {
        streams: [],
        subtitles: [],
        lang: lang,
        error: { message: 'Movie Direct has no playable English stream for this title yet.' },
      };
    }
    return {
      url: primary.url,
      streams: [primary],
      headers: primary.headers,
      streamType: primary.streamType || 'hls',
      lang: lang,
      audioLanguage: primary.audioLanguage || 'und',
      quality: 'Auto',
      defaultQuality: 'Auto',
      qualities: [{ label: 'Auto', url: primary.url, headers: primary.headers }].concat(primary.qualities || []),
      subtitles: primary.subtitles || [],
      servers: servers.map(function (row) {
        return {
          name: row.name,
          label: row.name,
          url: row.url,
          headers: row.headers,
          streamType: row.streamType || 'hls',
          lang: lang,
          audioLanguage: row.audioLanguage,
          subtitles: row.subtitles || [],
        };
      }),
      provider: 'videasy',
    };
  }

  async function searchResults(query) {
    var q = clean(query);
    try {
      var path = q
        ? '/search/multi?query=' + encodeURIComponent(q) + '&include_adult=false&page=1'
        : '/trending/all/week?page=1';
      var data = await withTimeout(tmdb(path), 8000, null);
      return ((data && data.results) || []).map(function (row) { return mapItem(row); }).filter(Boolean).slice(0, 40);
    } catch (error) {
      log('search failed');
      return [];
    }
  }

  async function extractDetails(urlOrId) {
    var ref = parseHref(urlOrId);
    if (!ref) {
      var found = await searchResults(urlOrId);
      return found[0] || { title: 'Unavailable', description: '' };
    }
    try {
      var meta = await tmdb('/' + ref.type + '/' + ref.id);
      var item = mapItem(meta, ref.type);
      if (!item) return { title: 'Unavailable', description: '', href: urlOrId };
      item.description = clean(meta.overview);
      item.synopsis = item.description;
      item.genres = (meta.genres || []).map(function (g) { return g && g.name; }).filter(Boolean);
      item.tmdbId = Number(ref.id);
      return item;
    } catch (_) {
      return { title: 'Unavailable', description: '', href: urlOrId };
    }
  }

  async function extractEpisodes(seriesId) {
    var ref = parseHref(seriesId);
    if (!ref) return [];
    if (ref.type === 'movie') {
      return [{
        id: href('movie', ref.id),
        href: href('movie', ref.id),
        number: 1,
        episodeNumber: 1,
        title: 'Movie',
      }];
    }
    try {
      var meta = await tmdb('/tv/' + ref.id);
      var seasons = Array.isArray(meta.seasons) ? meta.seasons : [];
      var out = [];
      var s;
      for (s = 0; s < seasons.length && out.length < 400; s += 1) {
        var season = seasons[s];
        var num = Number(season && season.season_number);
        if (!isFinite(num) || num < 1) continue;
        var packSeason = await withTimeout(tmdb('/tv/' + ref.id + '/season/' + num), 8000, null);
        var episodes = (packSeason && Array.isArray(packSeason.episodes)) ? packSeason.episodes : [];
        episodes.forEach(function (ep) {
          var n = Number(ep && ep.episode_number);
          if (!n) return;
          out.push({
            id: href('tv', ref.id, num, n),
            href: href('tv', ref.id, num, n),
            season: num,
            number: n,
            episodeNumber: n,
            title: clean(ep.name) || ('S' + num + 'E' + n),
          });
        });
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  async function extractStreamUrl(episodeHref, lang) {
    var want = String(lang || 'sub').toLowerCase();
    if (want === 'dub' || want === 'vf') {
      return {
        streams: [],
        subtitles: [],
        lang: want,
        error: { message: 'Movie Direct does not advertise English Dub. Non-English audio is not Dub.' },
      };
    }
    var ref = parseHref(episodeHref);
    if (!ref) {
      return { streams: [], subtitles: [], error: { message: 'Invalid Movie Direct identity.' } };
    }
    if (ref.type === 'tv' && (!ref.season || !ref.episode)) {
      return { streams: [], subtitles: [], error: { message: 'TV identity is missing season/episode.' } };
    }
    try {
      var servers = await withTimeout(resolveVideasy(ref), 20000, null);
      return pack(servers, 'sub');
    } catch (error) {
      log('resolve failed ' + (error && error.message ? error.message : error));
      return pack(null, 'sub');
    }
  }

  async function discoveryHome() {
    try {
      var trending = await tmdb('/trending/all/week?page=1');
      var movies = await tmdb('/movie/popular?page=1');
      var tv = await tmdb('/tv/popular?page=1');
      return {
        sections: [
          { id: 'md-trending', title: 'Trending', style: 'hero', items: (trending.results || []).map(function (r) { return mapItem(r); }).filter(Boolean).slice(0, 8) },
          { id: 'md-movies', title: 'Popular movies', style: 'poster', items: (movies.results || []).map(function (r) { return mapItem(r, 'movie'); }).filter(Boolean) },
          { id: 'md-tv', title: 'Popular TV', style: 'poster', items: (tv.results || []).map(function (r) { return mapItem(r, 'tv'); }).filter(Boolean) },
        ],
      };
    } catch (_) {
      return { sections: [] };
    }
  }

  async function discoveryFeed(feedId, page) {
    var pageNumber = Math.max(1, Number(page) || 1);
    var path = '/trending/all/week?page=' + pageNumber;
    if (String(feedId || '').indexOf('movie') >= 0) path = '/movie/popular?page=' + pageNumber;
    if (String(feedId || '').indexOf('tv') >= 0) path = '/tv/popular?page=' + pageNumber;
    try {
      var data = await tmdb(path);
      var type = path.indexOf('/tv/') === 0 ? 'tv' : (path.indexOf('/movie/') === 0 ? 'movie' : '');
      var items = (data.results || []).map(function (row) { return mapItem(row, type || undefined); }).filter(Boolean);
      return { feedId: feedId || 'trending', page: pageNumber, items: items, hasMore: items.length >= 20 };
    } catch (_) {
      return { feedId: feedId || 'trending', page: pageNumber, items: [], hasMore: false };
    }
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
