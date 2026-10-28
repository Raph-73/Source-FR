/* ============================================================================
 * Franime (franime.fr) — French anime module for Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * Chain (observed live 2026-09-18, catalogue + resolver + embeds):
 *   search    : public Kitsu index GET https://kitsu.io/api/edge/anime
 *                 ?filter[text]=<query> -> ids, verified one by one against
 *                 franime anime-by-id (only existing, non-nsfw entries with
 *                 >= 1 episode are returned). The franime catalogue itself
 *                 (~10.7 MB) exceeds app response caps and is never fetched.
 *   details   : GET https://api.franime.fr/api/anime-by-id/:id -> same object.
 *   lecteur   : GET https://api.franime.fr/api/anime/:id/:saison/:ep/:lang/:idx
 *                 (0-based indices, lang vo|vf) -> plain-text watch2 URL.
 *                 REQUIRES browser-like headers (UA + Accept + Content-Type
 *                 application/json + Origin/Referer + Sec-Fetch-*); minimal
 *                 headers get Cloudflare HTTP 403 on this route only.
 *   watch2    : https://franime.fr/watch2/?a=...&b=... -> each param is
 *                 base64(hex-bytes XOR single-byte key); brute-force 0..255,
 *                 keep values starting with http(s):// on a known provider.
 *   providers : sibnet (shell.php -> /v/<token>/<id>.mp4 -> 302 CDN mp4),
 *                 vidmoly (embed html jwplayer file: ...m3u8 + variant ladder),
 *                 uqload (Dean-Edwards-packed setup -> HLS master + ladder),
 *                 dailymotion (player metadata -> HLS manifest + ladder),
 *                 vk video_ext (embedded HLS URL + ladder),
 *                 sendvid (embed html <source src> or file: ...mp4/m3u8).
 *                 filemoon mirrors (e.g. bysedikamoum.com) need a browser PoW
 *                 and are SKIPPED, as are lpayer/SPA embeds, youtube,
 *                 "TELECHARGEMENT ..." and "INDISPONIBLE" lecteurs.
 *   episodes  : enriched with real French titles + thumbnails from
 *                 /api/anime-seasons/:id/:N, applied only when the meta count
 *                 exactly matches the catalogue count (never mislabelled).
 *   identity  : anime id is the numeric catalogue id (stringified).
 *                 episode href: "franime://<id>/<saisonIdx>/<episodeIdx>"
 *                 (0-based indices into saisons[]/episodes[]).
 *   audio     : vo = VOSTFR (original audio, French subs) -> lang "sub".
 *                 vf = Version Francaise (French dub)      -> lang "dub".
 *                 No soft-subtitle URLs are exposed by the source; VOSTFR
 *                 captions are part of the video itself. subtitles: [] always.
 *
 * No Node or DOM dependencies. Only fetchv2 + standard JS. No atob/btoa,
 * no typed arrays (own base64/hex codec on plain arrays/strings).
 * ==========================================================================*/
(function () {
  'use strict';

  var SITE = 'https://franime.fr';
  var API = 'https://api.franime.fr';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  var API_HEADERS = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Origin': SITE,
    'Referer': SITE + '/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
  };
  var HTML_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Referer': SITE + '/'
  };
  var STREAM_HEADERS = { 'User-Agent': UA, 'Referer': SITE + '/', 'Origin': SITE };

  var PROVIDER_SUBSTRINGS = ['sibnet.ru', 'vidmoly', 'sendvid', 'filemoon', 'bysedikamoum', 'streamtape', 'doodstream', 'dood', 'uqload', 'dailymotion', 'dai.ly', 'vk.com', 'vk.ru', 'vkontakte', 'okcdn.ru'];
  var UNSUPPORTED_LECTEURS = ['filemoon', 'telechargement', 'indisponible', 'youtube'];
  var SUPPORTED_EMBEDS = ['sibnet.ru', 'vidmoly', 'sendvid', 'uqload', 'dailymotion', 'dai.ly', 'vk.com', 'vk.ru'];

  var detailsCache = {};

  function now() { return Date.now(); }
  function timeLeft(deadline, cap) {
    var left = deadline - now();
    if (left < 600) return 600;
    if (cap && left > cap) return cap;
    return left;
  }

  function clean(value) {
    return String(value == null ? '' : value)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
      .replace(/&eacute;|&#xe9;/gi, 'e').replace(/&egrave;|&#xe8;/gi, 'e')
      .replace(/&ecirc;|&#xea;/gi, 'e').replace(/&agrave;|&#xe0;/gi, 'a')
      .replace(/&ccedil;|&#xe7;/gi, 'c').replace(/&ocirc;|&#xf4;/gi, 'o')
      .replace(/&icirc;|&#xee;/gi, 'i').replace(/&ucirc;|&#xfb;/gi, 'u')
      .replace(/\s+/g, ' ').trim();
  }

  function mergeHeaders(extra) {
    var out = {}, k;
    for (k in API_HEADERS) out[k] = API_HEADERS[k];
    if (extra) for (k in extra) out[k] = extra[k];
    return out;
  }
  function mergeHtmlHeaders(extra) {
    var out = {}, k;
    for (k in HTML_HEADERS) out[k] = HTML_HEADERS[k];
    if (extra) for (k in extra) out[k] = extra[k];
    return out;
  }

  /* ---------------- transport helpers (fetchv2 with JSON-shape tolerance) -- */
  async function requestText(url, headers, timeoutMs, options) {
    var opts = { timeoutMs: timeoutMs };
    if (options) for (var k in options) opts[k] = options[k];
    var res = await fetchv2(url, headers || {}, 'GET', null, opts);
    var status = Number(res && (res.status || res.statusCode)) || 0;
    var text = '';
    if (res && typeof res.text === 'function') {
      try { text = await res.text(); } catch (_) { text = ''; }
    } else if (res && typeof res.body === 'string') {
      text = res.body;
    } else if (res && res.body != null) {
      text = String(res.body);
    }
    if (!text && res && typeof res.json === 'function') {
      try {
        var parsed = await res.json();
        if (parsed != null) text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      } catch (_) { /* keep empty */ }
    } else if (!text && res && res.json != null && typeof res.json !== 'function') {
      try { text = typeof res.json === 'string' ? res.json : JSON.stringify(res.json); } catch (_) {}
    }
    return { status: status, text: String(text || ''), headers: (res && res.headers) || {} };
  }

  async function requestJson(url, headers, timeoutMs, method, body) {
    var res = await fetchv2(url, headers || {}, method || 'GET', body == null ? null : body, { timeoutMs: timeoutMs });
    var status = Number(res && (res.status || res.statusCode)) || 0;
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

  /* ---------------- base64 / hex / xor (no atob, no Buffer) ---------------- */
  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  function b64ToBytes(s) {
    var cleanS = String(s || '').replace(/\s+/g, '');
    var out = [], i, c1, c2, c3, c4, b1, b2, b3;
    for (i = 0; i < cleanS.length; i += 4) {
      c1 = B64_ALPHABET.indexOf(cleanS.charAt(i));
      c2 = B64_ALPHABET.indexOf(cleanS.charAt(i + 1));
      c3 = B64_ALPHABET.indexOf(cleanS.charAt(i + 2));
      c4 = B64_ALPHABET.indexOf(cleanS.charAt(i + 3));
      if (c1 < 0 || c2 < 0) return null;
      if (c3 < 0) c3 = 64; if (c4 < 0) c4 = 64;
      b1 = (c1 << 2) | (c2 >> 4);
      b2 = ((c2 & 15) << 4) | (c3 >> 2);
      b3 = ((c3 & 3) << 6) | c4;
      out.push(b1);
      if (c3 !== 64) out.push(b2);
      if (c4 !== 64) out.push(b3);
    }
    return out;
  }
  function bytesToAscii(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
    return s;
  }
  function isHexString(s) {
    if (!s || s.length % 2 !== 0) return false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
      if (!ok) return false;
    }
    return true;
  }
  function hexToBytes(hex) {
    var out = [];
    for (var i = 0; i < hex.length; i += 2) {
      out.push(parseInt(hex.substr(i, 2), 16));
    }
    return out;
  }
  function isKnownProviderUrl(s) {
    var low = String(s).toLowerCase();
    for (var i = 0; i < PROVIDER_SUBSTRINGS.length; i++) {
      if (low.indexOf(PROVIDER_SUBSTRINGS[i]) >= 0) return true;
    }
    return false;
  }
  function splitQueryParams(url) {
    var out = [];
    var q = String(url || '').indexOf('?');
    if (q < 0) return out;
    var parts = String(url).slice(q + 1).split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq < 0) continue;
      var v = parts[i].slice(eq + 1);
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (_) {}
      out.push(v);
    }
    return out;
  }
  function decryptWatch2(watch2Url) {
    var params = splitQueryParams(watch2Url);
    for (var p = 0; p < params.length; p++) {
      var bytes = b64ToBytes(params[p]);
      if (!bytes || !bytes.length) continue;
      var hex = bytesToAscii(bytes);
      if (!isHexString(hex)) continue;
      var enc = hexToBytes(hex);
      for (var key = 0; key < 256; key++) {
        var dec = '';
        for (var i = 0; i < enc.length; i++) dec += String.fromCharCode(enc[i] ^ key);
        if (dec.indexOf('http://') === 0 || dec.indexOf('https://') === 0) {
          if (isKnownProviderUrl(dec)) return dec;
        }
      }
    }
    return null;
  }

  /* ---------------- search (Kitsu index + franime verification) ------------
   * The franime catalogue (~10.7 MB) exceeds app response caps, so text
   * matching runs on the public Kitsu index (the same source franime.fr
   * itself queries) and each hit is verified against franime anime-by-id.
   * Only entries that exist on franime with >= 1 episode and not flagged
   * nsfw are returned. All responses stay well under 1 MB. */
  var KITSU = 'https://kitsu.io/api/edge';
  var ANILIST = 'https://graphql.anilist.co';
  function kitsuHeaders() {
    return { 'User-Agent': UA, 'Accept': 'application/vnd.api+json' };
  }
  async function kitsuSearch(text, deadline) {
    var url = KITSU + '/anime?filter[text]=' + encodeURIComponent(text) + '&page[limit]=10';
    var last = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      if (now() >= deadline - 900) break;
      try {
        var res = await requestJson(url, kitsuHeaders(), timeLeft(deadline, 4000));
        if (res.status === 200 && res.data && Array.isArray(res.data.data)) return res.data.data;
        last = new Error('Kitsu search HTTP ' + res.status);
        if (res.status === 404) break;
      } catch (e) { last = e; }
    }
    throw last || new Error('Kitsu search failed');
  }
  /* Kitsu only indexes English/romaji titles, so a French query ("l'attaque
   * des titans") returns nothing. AniList matches synonyms (which carry the
   * French titles) and exposes the MyAnimeList id, which Kitsu maps back to
   * the Kitsu id franime itself indexes. */
  async function anilistMalIds(text, deadline) {
    var query = 'query($s:String){Page(perPage:10){media(search:$s,type:ANIME,sort:SEARCH_MATCH){idMal}}}';
    try {
      var res = await requestJson(
        ANILIST,
        { 'User-Agent': UA, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        timeLeft(deadline, 3000),
        'POST',
        JSON.stringify({ query: query, variables: { s: text } })
      );
      var media = res.data && res.data.data && res.data.data.Page && res.data.data.Page.media;
      if (res.status !== 200 || !Array.isArray(media)) return [];
      var out = [], seen = {};
      for (var i = 0; i < media.length; i++) {
        var mal = media[i] && media[i].idMal;
        if (mal && !seen[mal]) { seen[mal] = true; out.push(String(mal)); }
      }
      return out;
    } catch (_) { return []; }
  }
  async function kitsuHitsFromMal(malIds, deadline) {
    if (!malIds.length) return [];
    var url = KITSU + '/mappings?filter[externalSite]=myanimelist%2Fanime&filter[externalId]=' +
      malIds.slice(0, 10).join(',') +
      '&include=item&fields[anime]=titles,canonicalTitle,posterImage,startDate,synopsis,subtype,status&page[limit]=20';
    var res = await requestJson(url, kitsuHeaders(), timeLeft(deadline, 3000));
    if (res.status !== 200 || !res.data) return [];
    var included = {}, inc = res.data.included || [], i;
    for (i = 0; i < inc.length; i++) {
      if (inc[i] && inc[i].type === 'anime') included[String(inc[i].id)] = inc[i];
    }
    var byMal = {}, list = res.data.data || [];
    for (i = 0; i < list.length; i++) {
      var rel = list[i] && list[i].relationships && list[i].relationships.item && list[i].relationships.item.data;
      var aid = rel && rel.id != null ? String(rel.id) : '';
      var a = included[aid];
      if (!aid || !a) continue;
      var mal = String((list[i].attributes || {}).externalId || '');
      byMal[mal] = { id: aid, attributes: a.attributes || {} };
    }
    var hits = [];
    for (i = 0; i < malIds.length; i++) if (byMal[malIds[i]]) hits.push(byMal[malIds[i]]);
    return hits;
  }
  /* Card built straight from a Kitsu hit. Used as a resilience fallback when
   * franime verification is temporarily blocked (Cloudflare/rate limit) so a
   * search never hard-fails. Kitsu ids are the ids franime itself indexes. */
  function kitsuCardOf(hit) {
    var at = (hit && hit.attributes) || {};
    var id = hit && hit.id != null ? String(hit.id) : '';
    if (!id) return null;
    var p = at.posterImage || {};
    var img = String(p.large || p.original || p.medium || p.small || '').trim();
    var title = clean((at.titles && at.titles.fr) ||
      at.canonicalTitle ||
      (at.titles && (at.titles.en || at.titles.en_jp || at.titles.ja_jp)) || '');
    if (!title) return null;
    var ym = String(at.startDate || '').match(/(\d{4})/);
    return {
      id: id, href: id, title: title, image: img, poster: img,
      type: 'video', description: clean(at.synopsis || ''),
      year: ym ? ym[1] : '', format: String(at.subtype || '').toUpperCase(),
      status: String(at.status || '').toUpperCase()
    };
  }
  function countEpisodes(a) {
    var n = 0, ss = (a && a.saisons) || [];
    for (var i = 0; i < ss.length; i++) n += ((((ss[i] || {}).episodes) || []).length);
    return n;
  }
  function titleOf(a) {
    if (!a) return '';
    var t = a.title || (a.titles && (a.titles.en || a.titles.en_us || a.titles.en_jp)) || a.titleO || '';
    return clean(t);
  }
  function imageOf(a) {
    if (!a) return '';
    /* `affiche` is the original Kitsu poster (e.g. 600x856) while
     * `affiche_small` is a 284x402 thumbnail that looks blurry on TV and
     * tablet grids. Prefer the original and only fall back to the thumb. */
    var img = a.affiche || a.affiche_small || '';
    return String(img || '').trim();
  }
  function bannerOf(a) {
    if (!a) return '';
    return String(a.banner || '').trim();
  }
  function yearOf(a) {
    var d = String((a && (a.startDate || a.year)) || '');
    var m = d.match(/(\d{4})/);
    return m ? m[1] : '';
  }
  function cardOf(a) {
    var id = String(a.id);
    var card = {
      id: id, href: id, title: titleOf(a), image: imageOf(a), poster: imageOf(a),
      type: 'video', description: clean(a.description || ''),
      year: yearOf(a), format: String(a.format || ''), status: String(a.status || '')
    };
    var banner = bannerOf(a);
    if (banner) card.banner = banner;
    return card;
  }
  /* Hero slots are full-bleed and landscape: the 460x651 poster is far too
   * small there, while the Kitsu cover image is 1981-2048 px wide. */
  function heroCardOf(a) {
    var card = cardOf(a);
    var banner = bannerOf(a);
    if (banner) { card.image = banner; card.backdrop = banner; }
    return card;
  }

  async function fetchAnimeById(id, deadline, cap) {
    var key = String(id);
    var hit = detailsCache[key];
    if (hit && now() - hit.at < 5 * 60 * 1000) return hit.data;
    var res = await requestJson(API + '/api/anime-by-id/' + encodeURIComponent(id), mergeHeaders(), timeLeft(deadline, cap || 12000));
    if (res.status === 200 && res.data && (res.data.id != null)) {
      detailsCache[key] = { at: now(), data: res.data };
      return res.data;
    }
    var err = new Error('Franime details HTTP ' + res.status);
    err.status = res.status;
    /* 404/410 = this Kitsu entry is genuinely absent from franime.
     * Anything else (403 Cloudflare, 429, 5xx, HTML challenge) is transient. */
    err.kind = (res.status === 404 || res.status === 410) ? 'notfound' : 'blocked';
    throw err;
  }

  /* Season metadata (Kitsu titles/thumbnails). Applied only when the meta
   * episode count exactly matches the catalogue count for that saison;
   * otherwise generic titles are kept (never mislabel episodes). */
  async function fetchSeasonMeta(animeId, seasonNum, deadline) {
    try {
      var res = await requestJson(API + '/api/anime-seasons/' + encodeURIComponent(animeId) + '/' + seasonNum, mergeHeaders(), timeLeft(deadline, 5000));
      if (res.status === 200 && res.data && Array.isArray(res.data.episodes) && res.data.episodes.length) return res.data.episodes;
    } catch (_) { /* best effort */ }
    return null;
  }
  function seasonNumber(title) {
    var m = String(title || '').match(/(\d+)/);
    return m ? m[1] : '';
  }

  function parseAnimeId(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return '';
    var m = s.match(/anime-by-id\/(\d+)/) || s.match(/\/(\d{2,})\/?$/);
    if (m) return m[1];
    if (/^\d+$/.test(s)) return s;
    var bar = s.match(/^franime:\/\/(\d+)\//);
    if (bar) return bar[1];
    return '';
  }
  function parseEpisodeHref(value) {
    var s = String(value == null ? '' : value).trim();
    var m = s.match(/^franime:\/\/(\d+)\/(\d+)\/(\d+)$/);
    if (!m) return null;
    return { animeId: m[1], saison: Number(m[2]), episode: Number(m[3]) };
  }
  function episodeHref(animeId, s, e) { return 'franime://' + animeId + '/' + s + '/' + e; }

  function normLang(lang) {
    var v = String(lang == null ? '' : lang).trim().toLowerCase();
    if (v === 'dub' || v === 'vf' || v === 'fr' || v === 'french' || v === 'vff') return 'vf';
    return 'vo';
  }
  function isSkippedLecteur(name) {
    var v = String(name || '').toLowerCase();
    for (var i = 0; i < UNSUPPORTED_LECTEURS.length; i++) {
      if (v.indexOf(UNSUPPORTED_LECTEURS[i]) >= 0) return true;
    }
    return false;
  }

  /* ---------------- search / details / episodes ---------------- */
  async function searchResults(query) {
    /* The app budget is ~15 s: stop well before it so a slow franime/Cloudflare
     * response can never surface as an app-level timeout. */
    var deadline = now() + 8500;
    var term = String(query == null ? '' : query).trim();
    if (!term) {
      try {
        var top = await fetchTop(deadline);
        var empty = [];
        for (var i = 0; i < top.length && empty.length < 30; i++) {
          if (top[i].nsfw || !titleOf(top[i])) continue;
          empty.push(cardOf(top[i]));
        }
        return empty;
      } catch (_) {
        return [];
      }
    }

    /* French and English matching run in parallel. AniList resolves the query
     * (including French synonyms) to MAL ids and Kitsu maps those back to the
     * ids franime indexes; the plain Kitsu text search still covers romaji and
     * English titles without the extra round trip. */
    var mappedPromise = anilistMalIds(term, deadline)
      .then(function (ids) { return kitsuHitsFromMal(ids, deadline); })
      .catch(function () { return []; });
    var kitsuPromise = kitsuSearch(term, deadline).catch(function () { return []; });

    var mapped = await mappedPromise;
    var direct = await kitsuPromise;

    var hits = [], seenId = {};
    function collect(list) {
      for (var n = 0; n < list.length; n++) {
        var h = list[n], hid = h && h.id != null ? String(h.id) : '';
        if (!hid || seenId[hid]) continue;
        seenId[hid] = true;
        hits.push(h);
      }
    }
    collect(mapped);
    collect(direct);
    hits = hits.slice(0, 16);

    var out = [], seen = {}, fallback = [];
    /* Verify candidates six at a time, keeping relevance order. franime needs
     * one request per id, so the batch size is the only lever on latency. */
    for (var h = 0; h < hits.length && out.length < 10 && now() < deadline - 400; h += 6) {
      var batch = hits.slice(h, h + 6);
      var results = await Promise.all(batch.map(async function (hit) {
        var kid = hit && hit.id != null ? String(hit.id) : '';
        if (!kid) return null;
        try {
          return { ok: true, anime: await fetchAnimeById(kid, deadline, 1800) };
        } catch (e) {
          return { ok: false, transient: !e || e.kind !== 'notfound', hit: hit };
        }
      }));
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        if (!r) continue;
        if (!r.ok) {
          if (r.transient) {
            var fc = kitsuCardOf(r.hit);
            if (fc && !seen['k:' + fc.id]) {
              seen['k:' + fc.id] = true;
              fallback.push(fc);
            }
          }
          continue;
        }
        var a = r.anime;
        var fid = String(a.id);
        if (seen['f:' + fid]) continue;
        seen['f:' + fid] = true;
        if (a.nsfw || !titleOf(a) || countEpisodes(a) < 1) continue;
        out.push(cardOf(a));
        if (out.length >= 10) break;
      }
    }
    /* franime verification was blocked and nothing could be confirmed: return
     * the Kitsu cards (same ids/source franime indexes) rather than failing. */
    if (!out.length && fallback.length) return fallback.slice(0, 10);
    return out;
  }

  async function extractDetails(urlOrId) {
    var deadline = now() + 20000;
    var id = parseAnimeId(urlOrId);
    if (!id) throw new Error('Franime details: invalid id');
    var a = await fetchAnimeById(id, deadline);
    var card = cardOf(a);
    var genres = Array.isArray(a.themes) ? a.themes.map(function (g) { return clean(g); }).filter(Boolean) : [];
    return {
      id: String(a.id), href: String(a.id), url: SITE + '/anime/' + String(a.id),
      title: card.title, originalTitle: clean(a.titleO || ''),
      description: clean(a.description || ''), synopsis: clean(a.description || ''),
      image: card.image, poster: card.image, banner: String(a.banner || ''),
      year: yearOf(a), format: String(a.format || ''), status: String(a.status || ''),
      genres: genres, rating: a.note != null ? String(a.note) : '',
      type: 'video'
    };
  }

  async function extractEpisodes(seriesId) {
    var deadline = now() + 25000;
    var id = parseAnimeId(seriesId);
    if (!id) return [];
    var a = await fetchAnimeById(id, deadline);
    var saisons = Array.isArray(a.saisons) ? a.saisons : [];
    var out = [];
    var metaFetches = 0;
    for (var s = 0; s < saisons.length; s++) {
      var eps = Array.isArray(saisons[s].episodes) ? saisons[s].episodes : [];
      var seasonTitle = clean(saisons[s].title || ('Saison ' + (s + 1)));
      var base = [];
      for (var e = 0; e < eps.length; e++) {
        var ep = eps[e] || {};
        var vo = (ep.lang && ep.lang.vo && ep.lang.vo.lecteurs) || [];
        var vf = (ep.lang && ep.lang.vf && ep.lang.vf.lecteurs) || [];
        base.push({
          id: episodeHref(String(a.id), s, e),
          href: episodeHref(String(a.id), s, e),
          number: e + 1, episodeNumber: e + 1, season: s + 1,
          seasonTitle: seasonTitle,
          title: clean(ep.title) || ('Episode ' + (e + 1)),
          subAvailable: Array.isArray(vo) && vo.length > 0,
          dubAvailable: Array.isArray(vf) && vf.length > 0
        });
      }
      /* Enrich with real episode titles/thumbnails when counts match exactly. */
      var num = seasonNumber(saisons[s].title);
      if (num && metaFetches < 8 && now() < deadline) {
        metaFetches++;
        var meta = await fetchSeasonMeta(String(a.id), num, deadline);
        if (meta && meta.length === base.length) {
          for (var k = 0; k < base.length; k++) {
            var t = clean(meta[k] && meta[k].title);
            if (t) base[k].title = t;
            var thumb = String((meta[k] && meta[k].thumbnail) || '').trim();
            if (thumb && /^https?:\/\//i.test(thumb)) base[k].image = thumb;
          }
        }
      }
      for (var q = 0; q < base.length; q++) out.push(base[q]);
    }
    return out;
  }

  /* ---------------- providers ---------------- */
  function headerOf(ct) { return String(ct || '').toLowerCase(); }

  async function verifyMp4(url, referer, deadline) {
    try {
      var res = await requestText(url, { 'User-Agent': UA, 'Referer': referer || (SITE + '/'), 'Range': 'bytes=0-1023' }, timeLeft(deadline, 6000));
      var ct = headerOf(res.headers && (res.headers['content-type'] || res.headers['Content-Type']));
      if ((res.status === 200 || res.status === 206) && /video\/|application\/octet-stream/i.test(ct)) return true;
      if (res.status === 200 || res.status === 206) {
        var body = String(res.text || '');
        if (body && body.length > 64 && body.indexOf('<html') < 0 && body.indexOf('<!DOCTYPE') < 0) return true;
      }
      return false;
    } catch (_) { return false; }
  }
  async function verifyHls(url, referer, deadline) {
    return (await fetchHlsText(url, referer, deadline)) !== null;
  }
  async function fetchHlsText(url, referer, deadline) {
    try {
      var res = await requestText(url, { 'User-Agent': UA, 'Referer': referer || (SITE + '/') }, timeLeft(deadline, 8000));
      if (res.status !== 200 && res.status !== 206) return null;
      var ct = headerOf(res.headers && (res.headers['content-type'] || res.headers['Content-Type']));
      if (/text\/html/i.test(ct)) return null;
      var text = String(res.text || '');
      if (text.indexOf('#EXTM3U') < 0) return null;
      return text;
    } catch (_) { return null; }
  }
  function resolveUrl(base, ref) {
    var r = String(ref || '').trim();
    if (!r) return '';
    if (/^https?:\/\//i.test(r)) return r;
    if (/^\/\//.test(r)) return 'https:' + r;
    var b = String(base || '');
    var origin = (b.match(/^https?:\/\/[^/]+/i) || [])[0] || '';
    if (/^\//.test(r)) return origin + r;
    var dir = b.slice(0, b.lastIndexOf('/') + 1);
    return dir + r;
  }
  /* Parse an HLS master playlist into [{height, url}]. Media playlists
   * (no EXT-X-STREAM-INF) yield []. Never throws; failure = Auto only. */
  function parseLadder(masterText, masterUrl) {
    var out = [], seen = {};
    try {
      var lines = String(masterText || '').split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var line = String(lines[i] || '').trim();
        if (line.indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
        var hm = line.match(/RESOLUTION=\d+x(\d+)/i);
        var bw = line.match(/BANDWIDTH=(\d+)/i);
        var uri = '';
        for (var j = i + 1; j < lines.length; j++) {
          var cand = String(lines[j] || '').trim();
          if (!cand) continue;
          if (cand.charAt(0) === '#') continue;
          uri = cand;
          break;
        }
        if (!uri) continue;
        var abs = resolveUrl(masterUrl, uri);
        if (!abs || seen[abs]) continue;
        seen[abs] = true;
        var height = hm ? parseInt(hm[1], 10) : 0;
        out.push({ height: height || 0, bandwidth: bw ? parseInt(bw[1], 10) : 0, url: abs });
      }
    } catch (_) { /* Auto only */ }
    out.sort(function (x, y) { return (y.height || 0) - (x.height || 0) || (y.bandwidth || 0) - (x.bandwidth || 0); });
    return out;
  }
  function qualitiesFor(hlsUrl, headers, masterText) {
    var list = [{ label: 'Auto', url: hlsUrl, headers: headers }];
    var ladder = parseLadder(masterText, hlsUrl);
    for (var i = 0; i < ladder.length; i++) {
      var h = ladder[i].height;
      list.push({ label: h > 0 ? (h + 'p') : 'Auto', height: h > 0 ? h : undefined, url: ladder[i].url, headers: headers });
    }
    return list;
  }
  /* Dean Edwards packer (uqload): pure string unpack, no code execution. */
  function unpackPacker(html) {
    try {
      var m = String(html || '').match(/\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)\)/);
      if (!m) return null;
      var p = m[1], radix = parseInt(m[2], 10), count = parseInt(m[3], 10), table = m[4].split('|');
      if (!(radix >= 2 && radix <= 36) || !(count > 0) || !table.length) return null;
      for (var idx = count - 1; idx >= 0; idx--) {
        if (table[idx]) {
          var re = new RegExp('\\b' + idx.toString(radix) + '\\b', 'g');
          var word = table[idx];
          p = p.replace(re, function () { return word; });
        }
      }
      return p;
    } catch (_) { return null; }
  }

  async function resolveSibnet(embedUrl, deadline) {
    var page = await requestText(embedUrl, mergeHtmlHeaders({ 'Referer': SITE + '/' }), timeLeft(deadline, 8000));
    if (page.status !== 200) throw new Error('sibnet embed HTTP ' + page.status);
    var m = page.text.match(/src:\s*["'](\/v\/[a-fA-F0-9]+\/\d+\.mp4)["']/);
    if (!m) throw new Error('sibnet token path missing');
    var vUrl = 'https://video.sibnet.ru' + m[1];
    var direct = await requestText(vUrl, mergeHtmlHeaders({ 'Referer': embedUrl }), timeLeft(deadline, 6000), { followRedirects: false });
    var loc = direct.headers && (direct.headers.location || direct.headers.Location);
    var cdn = '';
    if (loc) cdn = String(loc).indexOf('//') === 0 ? 'https:' + String(loc) : String(loc);
    var candidate = cdn || vUrl;
    if (await verifyMp4(candidate, embedUrl, deadline)) {
      return { url: candidate, headers: { 'User-Agent': UA, 'Referer': embedUrl }, streamType: 'mp4' };
    }
    throw new Error('sibnet media probe rejected');
  }

  async function resolveVidmoly(embedUrl, deadline) {
    var page = await requestText(embedUrl, mergeHtmlHeaders({ 'Referer': SITE + '/' }), timeLeft(deadline, 8000));
    if (page.status !== 200) throw new Error('vidmoly embed HTTP ' + page.status);
    var m = page.text.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/);
    if (!m) throw new Error('vidmoly m3u8 missing');
    var hls = m[1];
    var master = await fetchHlsText(hls, embedUrl, deadline);
    if (!master) throw new Error('vidmoly playlist probe rejected');
    var headers = { 'User-Agent': UA, 'Referer': embedUrl };
    return { url: hls, headers: headers, streamType: 'hls', qualities: qualitiesFor(hls, headers, master) };
  }

  async function resolveUqload(embedUrl, deadline) {
    var page = await requestText(embedUrl, mergeHtmlHeaders({ 'Referer': SITE + '/' }), timeLeft(deadline, 8000));
    if (page.status !== 200) throw new Error('uqload embed HTTP ' + page.status);
    var hls = null;
    var direct = page.text.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/);
    if (direct) {
      hls = direct[0];
    } else {
      var unpacked = unpackPacker(page.text);
      if (!unpacked) throw new Error('uqload player payload missing');
      var mu = unpacked.match(/sources:\s*\[\s*\{\s*file:\s*"([^"]+\.m3u8[^"]*)"/) ||
               unpacked.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/);
      if (!mu) throw new Error('uqload m3u8 missing');
      hls = mu[1] || mu[0];
    }
    var master = await fetchHlsText(hls, embedUrl, deadline);
    if (!master) throw new Error('uqload playlist probe rejected');
    var headers = { 'User-Agent': UA, 'Referer': embedUrl };
    return { url: hls, headers: headers, streamType: 'hls', qualities: qualitiesFor(hls, headers, master) };
  }

  async function resolveDailymotion(embedUrl, deadline) {
    var idm = String(embedUrl || '').match(/\/video\/([A-Za-z0-9]+)/);
    if (!idm) throw new Error('dailymotion id missing');
    var meta = await requestText(
      'https://www.dailymotion.com/player/metadata/video/' + idm[1],
      { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': SITE + '/' },
      timeLeft(deadline, 8000));
    if (meta.status !== 200) throw new Error('dailymotion metadata HTTP ' + meta.status);
    var data = null;
    try { data = JSON.parse(meta.text); } catch (_) { throw new Error('dailymotion metadata parse failed'); }
    var qualities = data && data.qualities ? data.qualities : {};
    var hlsUrl = '', mp4Url = '';
    for (var qn in qualities) {
      var tracks = qualities[qn] || [];
      for (var t = 0; t < tracks.length; t++) {
        var u = String((tracks[t] && tracks[t].url) || '');
        var ty = String((tracks[t] && tracks[t].type) || '');
        if (!u) continue;
        if (/mpegURL/i.test(ty) && !hlsUrl) hlsUrl = u;
        if (/mp4/i.test(ty) && !mp4Url) mp4Url = u;
      }
    }
    var headers = { 'User-Agent': UA, 'Referer': embedUrl };
    if (hlsUrl) {
      var master = await fetchHlsText(hlsUrl, embedUrl, deadline);
      if (!master) throw new Error('dailymotion playlist probe rejected');
      return { url: hlsUrl, headers: headers, streamType: 'hls', qualities: qualitiesFor(hlsUrl, headers, master) };
    }
    if (mp4Url) {
      if (await verifyMp4(mp4Url, embedUrl, deadline)) {
        return { url: mp4Url, headers: headers, streamType: 'mp4' };
      }
      throw new Error('dailymotion media probe rejected');
    }
    throw new Error('dailymotion streams missing');
  }

  async function resolveVk(embedUrl, deadline) {
    var page = await requestText(embedUrl, mergeHtmlHeaders({ 'Referer': SITE + '/' }), timeLeft(deadline, 8000));
    if (page.status !== 200) throw new Error('vk embed HTTP ' + page.status);
    var m = page.text.match(/"hls"\s*:\s*"(https:[^"]+)"/);
    if (!m) throw new Error('vk hls missing');
    var hls = m[1].replace(/\\\//g, '/');
    var master = await fetchHlsText(hls, embedUrl, deadline);
    if (!master) throw new Error('vk playlist probe rejected');
    var headers = { 'User-Agent': UA, 'Referer': embedUrl };
    return { url: hls, headers: headers, streamType: 'hls', qualities: qualitiesFor(hls, headers, master) };
  }

  async function resolveSendvid(embedUrl, deadline) {
    var page = await requestText(embedUrl, mergeHtmlHeaders({ 'Referer': SITE + '/' }), timeLeft(deadline, 8000));
    if (page.status !== 200) throw new Error('sendvid embed HTTP ' + page.status);
    var m = page.text.match(/<source[^>]+src="([^"]+\.(?:m3u8|mp4)[^"]*)"/i) ||
            page.text.match(/file:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/);
    if (!m) throw new Error('sendvid source missing');
    var media = m[1] || m[2];
    if (/\.m3u8(\?|$)/i.test(media)) {
      if (await verifyHls(media, embedUrl, deadline)) {
        return { url: media, headers: { 'User-Agent': UA, 'Referer': embedUrl }, streamType: 'hls' };
      }
    } else {
      if (await verifyMp4(media, embedUrl, deadline)) {
        return { url: media, headers: { 'User-Agent': UA, 'Referer': embedUrl }, streamType: 'mp4' };
      }
    }
    throw new Error('sendvid media probe rejected');
  }

  /* ---------------- stream ---------------- */
  async function extractStreamUrl(episodeHref, lang) {
    var deadline = now() + 24000;
    var ref = parseEpisodeHref(episodeHref);
    if (!ref) return { streams: [], subtitles: [], lang: normLang(lang) === 'vf' ? 'dub' : 'sub', error: { message: 'Franime: invalid episode identity.' } };
    var wantApi = normLang(lang);
    var wantOut = wantApi === 'vf' ? 'dub' : 'sub';
    var anime;
    try {
      anime = await fetchAnimeById(ref.animeId, deadline);
    } catch (e) {
      return { streams: [], subtitles: [], lang: wantOut, error: { message: 'Franime details failed: ' + String((e && e.message) || e) } };
    }
    var saisons = Array.isArray(anime.saisons) ? anime.saisons : [];
    if (!saisons[ref.saison] || !Array.isArray(saisons[ref.saison].episodes) || !saisons[ref.saison].episodes[ref.episode]) {
      return { streams: [], subtitles: [], lang: wantOut, error: { message: 'Franime: episode out of range (no substitution applied).' } };
    }
    var ep = saisons[ref.saison].episodes[ref.episode];
    var lecteurs = ((ep.lang && ep.lang[wantApi] && ep.lang[wantApi].lecteurs) || []).slice();
    if (!lecteurs.length) {
      return { streams: [], subtitles: [], lang: wantOut, error: { message: wantApi === 'vf' ? 'Franime: no VF (dub) lecteur for this episode.' : 'Franime: no VO (sub) lecteur for this episode.' } };
    }
    var servers = [], seen = {}, skipped = [], failed = [];
    for (var i = 0; i < lecteurs.length; i++) {
      if (now() >= deadline) break;
      var name = String(lecteurs[i] || '');
      if (!name || isSkippedLecteur(name)) { skipped.push(name || ('index ' + i)); continue; }
      var watch2 = '';
      try {
        var lr = await requestText(
          API + '/api/anime/' + encodeURIComponent(ref.animeId) + '/' + ref.saison + '/' + ref.episode + '/' + wantApi + '/' + i,
          mergeHeaders(), timeLeft(deadline, 8000));
        if (lr.status !== 200 || !lr.text || lr.text.indexOf('https://') !== 0) { failed.push(name + ' (resolver HTTP ' + lr.status + ')'); continue; }
        watch2 = lr.text.trim();
      } catch (err) { failed.push(name + ' (resolver error)'); continue; }
      var embed = null;
      try { embed = decryptWatch2(watch2); } catch (_) { embed = null; }
      if (!embed) { failed.push(name + ' (watch2 undecryptable)'); continue; }
      var low = embed.toLowerCase();
      try {
        var supported = false;
        for (var d = 0; d < SUPPORTED_EMBEDS.length; d++) {
          if (low.indexOf(SUPPORTED_EMBEDS[d]) >= 0) { supported = true; break; }
        }
        if (!supported) { skipped.push(name); continue; }
        var resolved = null;
        if (low.indexOf('sibnet.ru') >= 0) resolved = await resolveSibnet(embed, deadline);
        else if (low.indexOf('vidmoly') >= 0) resolved = await resolveVidmoly(embed, deadline);
        else if (low.indexOf('uqload') >= 0) resolved = await resolveUqload(embed, deadline);
        else if (low.indexOf('dailymotion') >= 0 || low.indexOf('dai.ly') >= 0) resolved = await resolveDailymotion(embed, deadline);
        else if (low.indexOf('vk.') >= 0 || low.indexOf('vkontakte') >= 0) resolved = await resolveVk(embed, deadline);
        else if (low.indexOf('sendvid') >= 0) resolved = await resolveSendvid(embed, deadline);
        else { skipped.push(name); continue; }
        if (!resolved || !resolved.url || seen[resolved.url]) continue;
        seen[resolved.url] = true;
        servers.push({
          name: name + ' ' + wantApi,
          label: (wantOut === 'dub' ? 'dub ' : 'sub ') + name,
          url: resolved.url, headers: resolved.headers,
          streamType: resolved.streamType, lang: wantOut,
          qualities: resolved.qualities || []
        });
        if (servers.length >= 4) break;
      } catch (err) { failed.push(name + ' (' + String((err && err.message) || err).slice(0, 80) + ')'); }
    }
    if (!servers.length) {
      var why = [];
      if (skipped.length) why.push('unsupported: ' + skipped.join(', '));
      if (failed.length) why.push('unverified: ' + failed.join(', '));
      return { streams: [], subtitles: [], lang: wantOut, error: { message: 'Franime: no verified ' + wantApi.toUpperCase() + ' stream' + (why.length ? ' (' + why.join('; ') + ')' : '') + '.' } };
    }
    var primary = servers[0];
    var flat = [];
    for (var f = 0; f < servers.length; f++) {
      flat.push((wantOut === 'dub' ? 'dub ' : 'sub ') + servers[f].name.split(' ')[0]);
      flat.push(servers[f].url);
    }
    var primaryQualities = (primary.qualities && primary.qualities.length)
      ? primary.qualities
      : [{ label: 'Auto', url: primary.url, headers: primary.headers }];
    return {
      url: primary.url, headers: primary.headers, streamType: primary.streamType, lang: wantOut,
      streams: flat,
      quality: 'Auto', defaultQuality: 'Auto',
      qualities: primaryQualities,
      subtitles: [],
      servers: servers.map(function (s) {
        var entry = { name: s.name, label: s.label, url: s.url, headers: s.headers, streamType: s.streamType, lang: s.lang, subtitles: [] };
        if (s.qualities && s.qualities.length) entry.qualities = s.qualities;
        return entry;
      }),
      provider: 'franime'
    };
  }

  /* ---------------- discovery (lightweight endpoints, no catalogue fetch) -- */
  async function fetchTop(deadline) {
    var res = await requestJson(API + '/api/discord/voted/render-top-15-of-bestanimes', mergeHeaders(), timeLeft(deadline, 12000));
    if (res.status !== 200 || !Array.isArray(res.data)) throw new Error('Franime top HTTP ' + res.status);
    return res.data;
  }
  async function fetchCalendar(deadline) {
    var res = await requestJson(API + '/api/calendrier_data', mergeHeaders(), timeLeft(deadline, 12000));
    if (res.status !== 200 || !res.data || !Array.isArray(res.data.data)) throw new Error('Franime calendar HTTP ' + res.status);
    return res.data.data;
  }
  function calendarCard(c) {
    var id = String(c.id_anime);
    var img = String(c.affiche || '');
    return {
      id: id, href: id, title: clean(c.title_anime), image: img, poster: img,
      type: 'video', description: clean((c.jour ? ('Sortie : ' + c.jour) : '') + (c.saison ? (' - Saison ' + c.saison) : ''))
    };
  }
  function toCard(a) { return cardOf(a); }
  async function discoveryHome() {
    var deadline = now() + 20000;
    var sections = [];
    var seen = {};
    function dedupe(items) {
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var key = String(items[i] && items[i].href || '').trim();
        if (!key || seen[key]) continue;
        seen[key] = true;
        out.push(items[i]);
      }
      return out;
    }
    try {
      var top = await fetchTop(deadline);
      var items = [];
      for (var i = 0; i < top.length && items.length < 8; i++) {
        if (top[i].nsfw || !titleOf(top[i])) continue;
        items.push(heroCardOf(top[i]));
      }
      items = dedupe(items);
      if (items.length) sections.push({ id: 'top', title: 'Top animes', style: 'hero', items: items });
    } catch (_) { /* calendar-only fallback */ }
    try {
      var cal = await fetchCalendar(deadline);
      var cards = [], localSeen = {};
      for (var j = 0; j < cal.length && cards.length < 30; j++) {
        var id = String(cal[j].id_anime);
        if (!id || localSeen[id] || !cal[j].title_anime) continue;
        localSeen[id] = true;
        cards.push(calendarCard(cal[j]));
      }
      cards = dedupe(cards);
      if (cards.length) sections.push({ id: 'calendrier', title: 'Calendrier des sorties', style: 'poster', items: cards, viewAll: { mode: 'feed', feedId: 'calendrier' } });
    } catch (_) { /* top-only fallback */ }
    return { sections: sections };
  }
  async function discoveryFeed(feedId, page) {
    var deadline = now() + 20000;
    var pageNum = Math.max(1, Number(page) || 1);
    var feed = String(feedId || 'top15');
    if (feed === 'top15' || feed === 'top') {
      if (pageNum > 1) return { items: [], page: pageNum, hasMore: false };
      var top = await fetchTop(deadline);
      var items = [];
      for (var i = 0; i < top.length && items.length < 50; i++) {
        if (top[i].nsfw || !titleOf(top[i])) continue;
        items.push(toCard(top[i]));
      }
      return { items: items, page: 1, hasMore: false };
    }
    if (feed === 'calendrier') {
      if (pageNum > 1) return { items: [], page: pageNum, hasMore: false };
      var cal = await fetchCalendar(deadline);
      var seen = {}, cards = [];
      for (var j = 0; j < cal.length && cards.length < 50; j++) {
        var id = String(cal[j].id_anime);
        if (!id || seen[id] || !cal[j].title_anime) continue;
        seen[id] = true;
        cards.push(calendarCard(cal[j]));
      }
      return { items: cards, page: 1, hasMore: false };
    }
    /* Full-catalogue browsing is intentionally unavailable: the catalogue
     * (~10.7 MB) exceeds app response caps. Use search instead. */
    return { items: [], page: pageNum, hasMore: false };
  }

  /* ---------------- exports ---------------- */
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
