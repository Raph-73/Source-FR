/* ============================================================================
 * Mugiwara — Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * Catalogue: the site's public JSON endpoint (POST /api/catalogue-filters)
 * powers search and the discovery rows. Title and season pages are Next.js
 * App Router pages whose data lives in the RSC flight payload, so details and
 * episode lists are read from the embedded "anime"/"animeServer" objects.
 * Playback: each season page lists, per language, host rows of per-episode
 * embed URLs. The embed (ansembed/voembed) publishes a signed HLS master whose
 * variants are validated here before being handed to the player.
 * ==========================================================================*/

(function () {
  'use strict';

  var SITE = 'https://www.mugiwara-no-streaming.com';
  var IMG = 'https://static.mugiwara-no-streaming.com';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  var HTML_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    'Referer': SITE + '/'
  };
  var JSON_HEADERS = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    'Content-Type': 'application/json',
    'Referer': SITE + '/catalogue',
    'Origin': SITE
  };
  var STREAM_HEADERS = {
    'User-Agent': UA,
    'Referer': SITE + '/',
    'Accept': '*/*'
  };

  /* --------------------------------------------------------------- helpers */
  function now() { return Date.now(); }
  function left(deadline, cap) { return Math.max(700, Math.min(deadline - now(), cap || 10000)); }
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

  function resolveUrl(base, rel) {
    var v = String(rel == null ? '' : rel).trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    var origin = String(base || '').match(/^https?:\/\/[^\/?#]+/i);
    var root = origin ? origin[0] : SITE;
    if (v.charAt(0) === '/') return root + v;
    var dir = String(base || '').replace(/[?#][\s\S]*$/, '').replace(/\/[^\/]*$/, '/');
    return dir + v;
  }

  function siteUrl(slug) { return SITE + '/catalogue/' + enc(slug); }
  function episodeUrl(slug, season, episode) {
    return siteUrl(slug) + '/episodes/saison' + enc(season) + '#ep-' + enc(episode);
  }

  /* Artwork: <static>/w{300|600|1280|1920}/Animes/<slug>/<path>[.webp] is the
   * site's own variant scheme. Season images are portrait posters; the
   * "affiche" key art is landscape and is the only one used for wide slots. */
  function assetUrl(slug, path, width) {
    var p = String(path == null ? '' : path).trim();
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    p = p.replace(/^\/+/, '');
    if (/^Animes\//i.test(p)) p = p.replace(/^Animes\/[^\/]+\//i, '');
    var w = width >= 1920 ? 1920 : width >= 1280 ? 1280 : width >= 600 ? 600 : 300;
    var suffix = /\.webp$/i.test(p) ? '' : '.webp';
    return IMG + '/w' + w + '/Animes/' + enc(slug) + '/' + encodeURI(p) + suffix;
  }

  /* ------------------------------------------------------------ identities */
  /* Accepted: a site title URL, an episode URL (…#ep-N), a bare slug, or
   * mugiwara:<slug>[:s<season>:e<episode>]. */
  function parseRef(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return null;

    var se = raw.match(/#ep-(\d+)/i) || raw.match(/[?&]episode=(\d+)/i);

    var m = raw.match(/\/catalogue\/([a-z0-9][a-z0-9._-]*)(?:\/episodes\/saison([a-z0-9]+))?/i);
    if (m) {
      var ref = { slug: m[1].toLowerCase() };
      if (m[2]) {
        ref.season = m[2].toLowerCase();
        ref.episode = se ? Number(se[1]) : 1;
      }
      return ref;
    }
    m = raw.match(/^mugiwara:([a-z0-9][a-z0-9._-]*)(?::s?([a-z0-9]+)[:e](\d+))?$/i);
    if (m) {
      var alt = { slug: m[1].toLowerCase() };
      if (m[2]) { alt.season = m[2].toLowerCase(); alt.episode = Number(m[3]) || 1; }
      return alt;
    }
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(raw)) return { slug: raw.toLowerCase() };
    return null;
  }

  /* -------------------------------------------------------------- transport */
  async function fetchText(url, headers, timeoutMs) {
    var res = await fetchv2(url, headers || {}, 'GET', null, { timeoutMs: timeoutMs });
    var status = num(res && (res.status || res.statusCode));
    var text = '';
    if (res && typeof res.text === 'function') text = await res.text();
    else if (res && typeof res.body === 'string') text = res.body;
    return { status: status, text: String(text == null ? '' : text), headers: (res && res.headers) || {} };
  }

  async function fetchJson(url, headers, method, body, timeoutMs) {
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

  function baseBody(orderBy, categories, input) {
    return {
      orderBy: orderBy || 'alpha',
      filteredTypes: [],
      filteredCategories: categories || [],
      filteredThemes: [],
      filteredLang: [],
      filteredAvailability: [],
      filteredStudios: [],
      filteredOrigines: [],
      onlyFavourite: false,
      onlyToWatchLater: false,
      input: input || '',
      status: '',
      favourites: [],
      toWatchLater: []
    };
  }

  function catalogue(body, deadline, cap) {
    return fetchJson(SITE + '/api/catalogue-filters', JSON_HEADERS, 'POST', JSON.stringify(body), left(deadline, cap || 9000));
  }

  /* ------------------------------------------------------------ RSC reading */
  function flightText(html) {
    var out = '';
    var re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      try { out += JSON.parse(m[1]); } catch (_) { /* one malformed chunk */ }
    }
    return out;
  }

  function jsonAfter(text, marker) {
    var i = text.indexOf(marker);
    if (i < 0) return null;
    var start = text.indexOf('{', i + marker.length);
    if (start < 0) return null;
    var depth = 0, inStr = false, esc = false;
    for (var k = start; k < text.length; k++) {
      var c = text.charAt(k);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return text.slice(start, k + 1); }
    }
    return null;
  }

  function animeOfDetail(html) {
    var raw = jsonAfter(flightText(html), '"anime":');
    if (!raw) return null;
    try {
      var obj = JSON.parse(raw);
      return obj && obj.slug && obj.options ? obj : null;
    } catch (_) { return null; }
  }

  function animeOfSeason(html) {
    var raw = jsonAfter(flightText(html), '"animeServer":');
    if (!raw) return null;
    try {
      var obj = JSON.parse(raw);
      return obj && obj.slug && obj.options ? obj : null;
    } catch (_) { return null; }
  }

  /* ----------------------------------------------------------------- cards */
  function cardsFrom(items, limit, hero) {
    var out = [], seen = {}, i;
    for (i = 0; i < (items || []).length && out.length < limit; i++) {
      var it = items[i] || {};
      var slug = String(it.slug || '').trim();
      if (!slug || seen[slug]) continue;
      seen[slug] = true;
      var title = clean(it.anime || '');
      if (!title) continue;
      var href = siteUrl(slug);
      var poster = assetUrl(slug, it.wallpaper, 600);
      var card = { id: href, href: href, type: 'video', title: title, image: poster, poster: poster };
      if (hero) {
        var wide = assetUrl(slug, it.affiche, 1280);
        if (wide) { card.image = wide; card.backdrop = wide; }
      }
      if (!card.image) continue;
      out.push(card);
    }
    return out;
  }

  function resultCards(result, limit, hero) {
    if (!result || result.status !== 200 || !result.data || !Array.isArray(result.data.animes)) return [];
    return cardsFrom(result.data.animes, limit, hero);
  }

  /* ----------------------------------------------------------------- search */
  async function searchResults(query) {
    var deadline = now() + 16000;
    var term = clean(query);
    var r = await catalogue(baseBody(term ? 'alpha' : 'note', [], term), deadline, 11000);
    if (r.status === 429) throw new Error('Mugiwara : trop de requetes, reessayez dans un instant.');
    if (r.status !== 200) throw new Error('Mugiwara : catalogue indisponible (HTTP ' + r.status + ').');
    return resultCards(r, 24);
  }

  /* ---------------------------------------------------------------- details */
  async function extractDetails(urlOrId) {
    var ref = parseRef(urlOrId);
    if (!ref) throw new Error('Mugiwara : identifiant invalide.');
    var page = await fetchText(siteUrl(ref.slug), HTML_HEADERS, 15000);
    if (page.status === 404) throw new Error('Mugiwara : cette fiche n\'existe pas.');
    var anime = page.status === 200 ? animeOfDetail(page.text) : null;
    if (!anime) throw new Error('Mugiwara : fiche illisible.');

    var options = anime.options || {};
    var seasons = Array.isArray(options.saisons) ? options.saisons : [];
    var firstImage = '', i;
    for (i = 0; i < seasons.length; i++) {
      if (seasons[i] && seasons[i].image) { firstImage = seasons[i].image; break; }
    }

    var poster = assetUrl(ref.slug, firstImage, 600) || assetUrl(ref.slug, options.affiche, 600);
    var banner = assetUrl(ref.slug, options.affiche, 1280);
    var genres = [], themes = [];
    var cats = Array.isArray(anime.category) ? anime.category : [];
    for (i = 0; i < cats.length; i++) {
      var g = clean(cats[i]);
      if (g && genres.indexOf(g) === -1) genres.push(g);
    }
    var rawThemes = Array.isArray(anime.themes) ? anime.themes : [];
    for (i = 0; i < rawThemes.length; i++) {
      var t = clean(rawThemes[i]);
      if (t && themes.indexOf(t) === -1) themes.push(t);
    }

    var out = {
      id: siteUrl(ref.slug), href: siteUrl(ref.slug), url: SITE, type: 'video',
      title: clean(anime.anime || ''),
      description: clean(anime.synopsis || ''),
      image: poster || banner,
      poster: poster || banner,
      genres: genres,
      themes: themes,
      status: anime.airing ? 'En cours' : 'Termine',
      seasons: seasons.length
    };
    if (anime.type) out.demographic = clean(anime.type);
    if (banner) { out.banner = banner; out.backdrop = banner; }

    var total = 0;
    for (i = 0; i < seasons.length; i++) {
      var count = num(seasons[i] && seasons[i].episodesCount);
      if (!count && seasons[i] && Array.isArray(seasons[i].episodesName)) count = seasons[i].episodesName.length;
      total += count;
    }
    if (total) out.episodes = total;
    return out;
  }

  /* --------------------------------------------------------------- episodes */
  function nameFromList(list, episode) {
    if (!Array.isArray(list) || !list.length) return '';
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (entry && num(entry.index) === episode && entry.name) return clean(entry.name);
    }
    var byOrder = list[episode - 1];
    return byOrder && byOrder.name ? clean(byOrder.name) : '';
  }

  async function extractEpisodes(seriesId) {
    var ref = parseRef(seriesId);
    if (!ref) throw new Error('Mugiwara : identifiant invalide.');
    var page = await fetchText(siteUrl(ref.slug), HTML_HEADERS, 15000);
    if (page.status === 404) throw new Error('Mugiwara : cette fiche n\'existe pas.');
    var anime = page.status === 200 ? animeOfDetail(page.text) : null;
    if (!anime) throw new Error('Mugiwara : fiche illisible.');

    var options = anime.options || {};
    var seasons = Array.isArray(options.saisons) ? options.saisons : [];
    var globalNames = (options.EPISODES_OPTIONS && Array.isArray(options.EPISODES_OPTIONS.names))
      ? options.EPISODES_OPTIONS.names : [];

    var out = [], offset = 0, s, e;
    for (s = 0; s < seasons.length; s++) {
      var season = seasons[s] || {};
      var id = String(season.id == null ? '' : season.id);
      if (!/^\d+$/.test(id)) continue; /* side content ("1hs", "oav") stays out */
      var count = num(season.episodesCount);
      var ownNames = Array.isArray(season.episodesName) ? season.episodesName : [];
      if (!count && ownNames.length) count = ownNames.length;
      if (!count) continue;

      var image = assetUrl(ref.slug, season.image, 300);
      for (e = 1; e <= count; e++) {
        var title = ownNames.length ? nameFromList(ownNames, e) : '';
        if (!title) {
          var global = globalNames[offset + e - 1];
          if (global && global.name) title = clean(global.name);
        }
        var entry = {
          number: e,
          href: episodeUrl(ref.slug, id, e),
          title: title || ('Episode ' + e),
          season: Number(id)
        };
        if (image) entry.image = image;
        out.push(entry);
      }
      if (!ownNames.length) offset += count;
    }
    if (!out.length) throw new Error('Mugiwara : aucun episode liste pour ce titre.');
    return out;
  }

  /* -------------------------------------------------------------- streaming */
  function headerOf(headers, name) {
    if (!headers) return '';
    var direct = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
    return direct == null ? '' : String(direct);
  }

  function hostRank(url) {
    var host = String(url || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    if (/^(?:[a-z0-9-]+\.)?(?:ansembed|voembed)\./.test(host)) return 0;
    if (/uqload|yourupload|youpload|voe\.sx|streamtape|megankid/.test(host)) return 3;
    return 1;
  }

  function laneTag(lang) {
    var l = String(lang == null ? '' : lang).toLowerCase();
    return (l === 'dub' || l === 'vf' || l === 'va') ? 'dub' : 'sub';
  }

  function laneName(tag) { return tag === 'dub' ? 'VF' : 'VOSTFR'; }

  /* Audio keys are not uniform: one season may expose "vf", another
   * "vf1"/"vf2" or "VF Crun.". "vostfr" is the only sub prefix; "va"/"vkr"
   * are other audio languages and are never served as French VF. */
  function languageKeys(season, tag) {
    var re = tag === 'dub' ? /^vf/i : /^vostfr/i;
    var keys = [], k;
    for (k in season.lang) {
      if (Object.prototype.hasOwnProperty.call(season.lang, k) && re.test(k)) keys.push(k);
    }
    function rank(key) {
      var l = key.toLowerCase();
      if (l === (tag === 'dub' ? 'vf' : 'vostfr')) return 0;
      return /^(?:vf|vostfr)\d+$/.test(l) ? 1 : 2;
    }
    keys.sort(function (a, b) { return rank(a) - rank(b); });
    return keys;
  }

  function embedCandidates(season, key, episode) {
    var rows = season && season.lang ? season.lang[key] : null;
    if (!Array.isArray(rows)) return [];
    var urls = [], seen = {}, i;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!Array.isArray(row) || !row[episode - 1]) continue;
      var url = String(row[episode - 1]).trim();
      if (!/^https?:\/\//i.test(url) || seen[url]) continue;
      seen[url] = true;
      urls.push(url);
    }
    urls.sort(function (a, b) { return hostRank(a) - hostRank(b); });
    return urls;
  }

  function masterFromHtml(html, base) {
    var text = String(html == null ? '' : html)
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&');
    var re = /(?:file|src|url)\s*[:=]\s*['"]([^'"]+)['"]/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      var candidate = resolveUrl(base, m[1]);
      if (/\.m3u8(?:[?#]|$)/i.test(candidate)) return candidate;
    }
    m = text.match(/https?:\/\/[^\s'"<>]+\.m3u8[^\s'"<>]*/i);
    return m ? resolveUrl(base, m[0]) : '';
  }

  function packLane(tag, masterUrl, playlist) {
    var lines = String(playlist || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    var variants = [], seen = {}, i;
    for (i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
      var res = String(lines[i]).match(/RESOLUTION=(\d+)x(\d+)/i);
      var uri = '';
      for (var j = i + 1; j < lines.length; j++) {
        var line = lines[j].replace(/^\s+|\s+$/g, '');
        if (!line) continue;
        if (line.charAt(0) !== '#') { uri = line; break; }
      }
      if (!uri) continue;
      var url = resolveUrl(masterUrl, uri);
      if (seen[url]) continue;
      seen[url] = true;
      variants.push({ url: url, height: res ? Number(res[2]) : 0 });
    }
    variants.sort(function (a, b) { return b.height - a.height; });

    var name = laneName(tag);
    var streams = [], qualities = [];
    if (!variants.length) {
      var autoLabel = tag + ' Auto (' + name + ')';
      streams.push(autoLabel, masterUrl);
      qualities.push({ label: autoLabel, url: masterUrl, headers: STREAM_HEADERS });
      return {
        lang: tag, url: masterUrl,
        quality: 'Mugiwara \u00b7 Auto (' + name + ')',
        defaultQuality: 'Mugiwara \u00b7 Auto (' + name + ')',
        streams: streams, qualities: qualities,
        server: { name: 'Mugiwara ' + name, label: 'Auto', url: masterUrl, headers: STREAM_HEADERS, streamType: 'hls', lang: tag }
      };
    }

    var best = variants[0];
    for (i = 0; i < variants.length; i++) {
      var q = variants[i].height ? (variants[i].height + 'p') : 'Auto';
      var label = tag + ' ' + q + ' (' + name + ')';
      streams.push(label, variants[i].url);
      qualities.push({ label: label, height: variants[i].height || undefined, url: variants[i].url, headers: STREAM_HEADERS });
    }
    var quality = 'Mugiwara \u00b7 ' + (best.height ? (best.height + 'p') : 'Auto') + ' (' + name + ')';
    return {
      lang: tag, url: best.url, quality: quality, defaultQuality: quality,
      streams: streams, qualities: qualities,
      server: {
        name: 'Mugiwara ' + name, label: best.height ? (best.height + 'p') : 'Auto',
        url: best.url, headers: STREAM_HEADERS, streamType: 'hls', lang: tag
      }
    };
  }

  function firstOk(promises) {
    return new Promise(function (resolve) {
      var pending = promises.length;
      if (!pending) return resolve(null);
      for (var i = 0; i < promises.length; i++) {
        Promise.resolve(promises[i]).then(function (value) {
          if (value) resolve(value);
          else if (--pending === 0) resolve(null);
        }, function () {
          if (--pending === 0) resolve(null);
        });
      }
    });
  }

  async function resolveLane(season, key, tag, episode, deadline) {
    var urls = embedCandidates(season, key, episode);
    if (!urls.length) return null;
    var picks = urls.slice(0, 3);

    /* The first row is often uqload (domain-restricted) while the working
     * ansembed/voembed row sits behind it, so the known-good hosts are ranked
     * first and the three best rows are probed together. */
    var pending = picks.map(async function (embedUrl) {
      try {
        var embed = await fetchText(embedUrl, HTML_HEADERS, left(deadline, 7000));
        if (embed.status !== 200) return null;
        var masterUrl = masterFromHtml(embed.text, embedUrl);
        if (!masterUrl) return null;
        var playlist = await fetchText(masterUrl, STREAM_HEADERS, left(deadline, 8000));
        var text = String(playlist.text == null ? '' : playlist.text).replace(/^\uFEFF/, '').replace(/^\s+/, '');
        if (playlist.status !== 200 || text.indexOf('#EXTM3U') !== 0) return null;
        return packLane(tag, masterUrl, text);
      } catch (_) {
        return null;
      }
    });
    return firstOk(pending);
  }

  function streamFail(message, tag) {
    return { streams: [], subtitles: [], lang: tag === 'dub' ? 'dub' : 'sub', provider: 'Mugiwara', error: { message: message } };
  }

  async function extractStreamUrl(episodeHref, lang) {
    var ref = parseRef(episodeHref);
    if (!ref) return streamFail('Mugiwara : identifiant invalide.');
    var tag = laneTag(lang);
    var name = laneName(tag);
    var seasonId = ref.season || '1';
    var episode = Number(ref.episode) > 0 ? Number(ref.episode) : 1;
    var deadline = now() + 22000;

    var page = await fetchText(siteUrl(ref.slug) + '/episodes/saison' + enc(seasonId), HTML_HEADERS, left(deadline, 13000));
    if (page.status === 404) return streamFail('Mugiwara : cette saison n\'existe pas.', tag);
    if (page.status !== 200) return streamFail('Mugiwara : la page de la saison n\'a pas repondu (HTTP ' + page.status + ').', tag);
    var anime = animeOfSeason(page.text);
    if (!anime) return streamFail('Mugiwara : les lecteurs de cette saison sont illisibles.', tag);

    var seasons = Array.isArray(anime.options.saisons) ? anime.options.saisons : [];
    var season = null, i;
    for (i = 0; i < seasons.length; i++) {
      if (seasons[i] && String(seasons[i].id) === String(seasonId)) { season = seasons[i]; break; }
    }
    if (!season || !season.lang) return streamFail('Mugiwara : aucun lecteur pour cette saison.', tag);

    /* Serve the language that was asked for; never silently substitute the
     * other audio track (a VF request must not come back as VOSTFR). */
    var keys = languageKeys(season, tag);
    if (!keys.length) return streamFail('Mugiwara : cette saison n\'a pas de ' + name + '.', tag);

    var primary = await firstOk(keys.map(function (k) {
      return resolveLane(season, k, tag, episode, deadline).catch(function () { return null; });
    }));
    if (!primary) return streamFail('Mugiwara : aucun lecteur ' + name + ' n\'a fourni de flux pour cet episode.', tag);

    return {
      url: primary.url,
      headers: STREAM_HEADERS,
      streamType: 'hls',
      quality: primary.quality,
      defaultQuality: primary.defaultQuality,
      streams: primary.streams,
      qualities: primary.qualities,
      servers: [primary.server],
      subtitles: [],
      lang: primary.lang,
      provider: 'Mugiwara'
    };
  }

  /* -------------------------------------------------------------- discovery */
  var FEEDS = {
    top: { order: 'note', categories: [] },
    catalogue: { order: 'alpha', categories: [] },
    action: { order: 'note', categories: ['Action'] }
  };

  function titleFromSlug(slug) {
    return String(slug || '').split('-').filter(Boolean).map(function (part) {
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join(' ');
  }

  function firstSeasonImage(anime) {
    var seasons = anime && anime.options && Array.isArray(anime.options.saisons) ? anime.options.saisons : [];
    for (var i = 0; i < seasons.length; i++) {
      if (seasons[i] && seasons[i].image) return seasons[i].image;
    }
    return '';
  }

  function heroCardFrom(slug, item, anime) {
    var options = (anime && anime.options) || {};
    /* Same artwork the selector scored, so the header never swaps a checked
     * 1920 px season poster for a smaller one from the detail page. */
    var portrait = (item && item.wallpaper) || firstSeasonImage(anime) || options.affiche || '';
    var image = assetUrl(slug, portrait, 1920) || assetUrl(slug, options.affiche, 1920);
    if (!image) return null;
    var poster = assetUrl(slug, portrait, 600) || image;
    var href = siteUrl(slug);
    var card = {
      id: href, href: href, type: 'video',
      title: clean((anime && anime.anime) || (item && item.anime) || titleFromSlug(slug)),
      image: image, poster: poster
    };

    if (anime) {
      if (anime.synopsis) card.description = clean(anime.synopsis);
      var genres = [], themes = [], i;
      var cats = Array.isArray(anime.category) ? anime.category : [];
      for (i = 0; i < cats.length; i++) {
        var g = clean(cats[i]);
        if (g && genres.indexOf(g) === -1) genres.push(g);
      }
      var rawThemes = Array.isArray(anime.themes) ? anime.themes : [];
      for (i = 0; i < rawThemes.length; i++) {
        var t = clean(rawThemes[i]);
        if (t && themes.indexOf(t) === -1) themes.push(t);
      }
      if (genres.length) card.genres = genres;
      if (themes.length) card.themes = themes;
      card.status = anime.airing ? 'En cours' : 'Termine';
      if (anime.type) card.demographic = clean(anime.type);
      var seasons = Array.isArray(options.saisons) ? options.saisons : [];
      if (seasons.length) card.seasons = seasons.length;
      var total = 0;
      for (i = 0; i < seasons.length; i++) {
        var count = num(seasons[i] && seasons[i].episodesCount);
        if (!count && seasons[i] && Array.isArray(seasons[i].episodesName)) count = seasons[i].episodesName.length;
        total += count;
      }
      if (total) card.episodes = total;
    }
    return card;
  }

  /* The home header is a tall portrait frame. A 16:9 key art crop-filled into
   * that frame keeps only a narrow centre slice and looks soft, so the hero
   * uses the portrait season artwork at its largest variant and never sends
   * `backdrop`. The site's own slide is static (it stayed on JoJo for days),
   * so the hero rotates through the best-rated catalogue instead. */
  var HERO_SIZE = 6;
  var HERO_POOL = 16;
  var HERO_MIN_BYTES = 160000;
  var HERO_SKIP = { 'jojos-bizarre-adventure': true };

  async function headSize(url, timeoutMs) {
    try {
      var res = await fetchv2(url, { 'User-Agent': UA, 'Accept': 'image/webp,image/*,*/*' }, 'HEAD', null, { timeoutMs: timeoutMs });
      var headers = (res && res.headers) || {};
      var len = Number(headers['content-length'] || headers['Content-Length'] || 0);
      return isFinite(len) && len > 0 ? len : 0;
    } catch (_) { return 0; }
  }

  async function heroItemsFrom(items, deadline) {
    var pool = [], seen = {}, i;
    for (i = 0; i < (items || []).length && pool.length < HERO_POOL; i++) {
      var it = items[i] || {};
      var slug = String(it.slug || '').trim().toLowerCase();
      if (!slug || seen[slug] || HERO_SKIP[slug]) continue;
      if (!clean(it.anime || '') || (!it.wallpaper && !it.affiche)) continue;
      seen[slug] = true;
      it.slug = slug;
      pool.push(it);
    }
    if (!pool.length) return [];

    /* Source posters range from 300x400 to 1920x2880 and the catalogue exposes
     * no dimensions. The 1920 variant's byte size separates 500 px posters
     * (40 KB) from 1200-1920 px ones (165-460 KB), so low-resolution titles are
     * skipped. Chunks of six respect the request cap and stop as soon as six
     * good posters are found. */
    var chosen = [], fallback = [];
    for (i = 0; i < pool.length && chosen.length < HERO_SIZE; i += 6) {
      var chunk = pool.slice(i, i + 6);
      var sizes = await Promise.all(chunk.map(function (cand) {
        var url = assetUrl(cand.slug, cand.wallpaper || cand.affiche, 1920);
        return url ? headSize(url, left(deadline, 2500)) : Promise.resolve(0);
      }));
      for (var j = 0; j < chunk.length; j++) {
        if (sizes[j] >= HERO_MIN_BYTES) chosen.push(chunk[j]);
        else fallback.push(chunk[j]);
      }
    }
    chosen = chosen.slice(0, HERO_SIZE);
    if (chosen.length < HERO_SIZE) chosen = chosen.concat(fallback).slice(0, HERO_SIZE);

    var cards = await Promise.all(chosen.map(async function (it) {
      var slug = String(it.slug || '').trim().toLowerCase();
      var anime = null;
      try {
        var page = await fetchText(siteUrl(slug), HTML_HEADERS, left(deadline, 4500));
        if (page.status === 200) anime = animeOfDetail(page.text);
      } catch (_) { anime = null; }
      return heroCardFrom(slug, it, anime);
    }));

    var out = [];
    for (i = 0; i < cards.length; i++) if (cards[i]) out.push(cards[i]);
    return out;
  }

  async function heroCard(deadline) {
    var home = await fetchText(SITE + '/', HTML_HEADERS, left(deadline, 3000));
    if (home.status !== 200) return null;
    var raw = jsonAfter(flightText(home.text), '"premiereDiapositive":');
    if (!raw) return null;
    var spot;
    try { spot = JSON.parse(raw); } catch (_) { return null; }
    if (!spot || !spot.slug) return null;

    var anime = null;
    try {
      var detail = await fetchText(siteUrl(spot.slug), HTML_HEADERS, left(deadline, 3000));
      if (detail.status === 200) anime = animeOfDetail(detail.text);
    } catch (_) { anime = null; }
    return heroCardFrom(spot.slug, spot, anime);
  }

  async function discoveryHome() {
    var deadline = now() + 8200;
    var results = await Promise.all([
      catalogue(baseBody('note'), deadline, 6200).catch(function () { return null; }),
      catalogue(baseBody('alpha'), deadline, 6200).catch(function () { return null; }),
      catalogue(baseBody('note', ['Action']), deadline, 6200).catch(function () { return null; })
    ]);
    var sections = [];

    var heroItems = [];
    if (results[0] && results[0].status === 200 && results[0].data && Array.isArray(results[0].data.animes)) {
      heroItems = await heroItemsFrom(results[0].data.animes, deadline).catch(function () { return []; });
    }
    if (!heroItems.length) {
      var fallback = await heroCard(deadline).catch(function () { return null; });
      if (fallback) heroItems = [fallback];
    }
    if (heroItems.length) sections.push({ id: 'hero', title: 'A la une', style: 'hero', items: heroItems });

    var top = resultCards(results[0], 24);
    if (top.length) sections.push({
      id: 'top', title: 'Les mieux notes', style: 'poster', items: top,
      viewAll: { mode: 'feed', feedId: 'top' }
    });

    var action = resultCards(results[2], 24);
    if (action.length) sections.push({
      id: 'action', title: 'Action les mieux notes', style: 'poster', items: action,
      viewAll: { mode: 'feed', feedId: 'action' }
    });

    var all = resultCards(results[1], 24);
    if (all.length) sections.push({
      id: 'catalogue', title: 'Catalogue A-Z', style: 'poster', items: all,
      viewAll: { mode: 'feed', feedId: 'catalogue' }
    });

    return { sections: sections };
  }

  async function discoveryFeed(feedId, page) {
    var pageNum = Math.max(1, Number(page) || 1);
    var feed = FEEDS[String(feedId == null ? '' : feedId)];
    if (!feed) return { items: [], page: pageNum, hasMore: false };

    var body = baseBody(feed.order, feed.categories);
    body.page = pageNum;
    var r = await catalogue(body, now() + 12000, 11000).catch(function () { return null; });
    if (!r || r.status !== 200 || !r.data) return { items: [], page: pageNum, hasMore: false };

    var pag = r.data.pagination || {};
    var current = num(pag.currentPage) || pageNum;
    var pages = num(pag.totalPages) || 1;
    return {
      items: resultCards(r, 50),
      page: pageNum,
      hasMore: current < Math.min(pages, 200)
    };
  }

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
