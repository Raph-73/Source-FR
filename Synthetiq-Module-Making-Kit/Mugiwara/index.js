/* ============================================================================
 * Mugiwara — Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * Catalogue: the site's public JSON endpoint (POST /api/catalogue-filters)
 * powers search and the discovery rows. Title and season pages are Next.js
 * App Router pages whose data lives in the RSC flight payload, so details and
 * episode lists are read from the embedded "anime"/"animeServer" objects.
 * Playback: each season page lists, per language, host rows of per-episode
 * embed URLs. Airing seasons (Netflix/Crunchyroll simulcasts) publish those
 * rows through the site's public episodes-script feed instead. Films use the
 * FILM_OPTIONS rows exposed by /catalogue/<slug>/films/<film-slug>. The embed
 * (ansembed/voembed) publishes a signed HLS master whose variants are
 * validated here before being handed to the player.
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
  function filmUrl(slug, film) {
    return siteUrl(slug) + '/films/' + enc(film);
  }

  /* The site builds film routes from the film name: apostrophes are dropped,
   * accents folded, everything else non-alphanumeric becomes a dash
   * ("L'Aventure de l'Île de l'Horloge" -> "laventure-de-lile-de-lhorloge"). */
  function filmSlug(name) {
    return String(name == null ? '' : name)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/['\u2019\u02bc]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
  /* Accepted: a site title URL, a season URL (…#ep-N), a film URL, a bare
   * slug, or mugiwara:<slug>[:s<season>:e<episode>]. */
  function parseRef(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return null;

    var se = raw.match(/#ep-(\d+)/i) || raw.match(/[?&]episode=(\d+)/i);
    var fi = raw.match(/#film-(\d+)/i);

    var m = raw.match(/\/catalogue\/([a-z0-9][a-z0-9._-]*)\/films\/([^\/?#]+)/i);
    if (m) {
      var film = { slug: m[1].toLowerCase(), film: decodeURIComponent(m[2]).toLowerCase() };
      if (fi) film.filmIndex = Number(fi[1]);
      return film;
    }
    m = raw.match(/\/catalogue\/([a-z0-9][a-z0-9._-]*)(?:\/episodes\/saison([a-z0-9]+))?/i);
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

  function filmOptionsOf(options) {
    var fo = options && options.FILM_OPTIONS;
    return fo && Array.isArray(fo.names) && fo.names.length ? fo : null;
  }

  /* Film cards link to /catalogue/<slug>/films/<film-slug>; the links keep
   * the FILM_OPTIONS.names order, which is the index the player expects. */
  function filmLinksFrom(html, slug) {
    var out = [], seen = {}, re = /<a\b[^>]*href="\/catalogue\/([^"\/]+)\/films\/([^"\/?#]+)"/gi, m;
    while ((m = re.exec(String(html || ''))) !== null) {
      if (String(m[1]).toLowerCase() !== String(slug).toLowerCase()) continue;
      var key = decodeURIComponent(m[2]).toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(key);
    }
    return out;
  }

  /* Portrait posters: season images first, then film posters for one-shots
   * such as 5 Centimeters per Second that have no seasons at all. */
  function artworkPaths(options) {
    var paths = [], i;
    var seasons = options && Array.isArray(options.saisons) ? options.saisons : [];
    for (i = 0; i < seasons.length; i++) {
      var img = seasons[i] && seasons[i].image;
      if (img && paths.indexOf(img) === -1) paths.push(img);
    }
    if (!paths.length) {
      var fo = filmOptionsOf(options);
      if (fo) {
        for (i = 0; i < fo.names.length; i++) {
          var fim = fo.names[i] && fo.names[i].image;
          if (fim && paths.indexOf(fim) === -1) paths.push(fim);
        }
      }
    }
    return paths;
  }

  /* "2-4" is the fourth cour of season 2 and comes after "2"; side rows
   * ("1hs", "oav") carry no rank. */
  function seasonRank(id) {
    var m = String(id == null ? '' : id).match(/^(\d+)(?:-(\d+))?$/);
    return m ? [Number(m[1]), Number(m[2] || 0)] : null;
  }

  /* The site's catalogue wallpaper is the current season's poster, so the fiche
   * does the same: newest season first, older ones only as fallback. */
  function artworkCandidates(options) {
    var seasons = options && Array.isArray(options.saisons) ? options.saisons : [];
    var ranked = [], i;
    for (i = 0; i < seasons.length; i++) {
      var img = seasons[i] && seasons[i].image;
      var rank = seasonRank(seasons[i] && seasons[i].id);
      if (!img || !rank) continue;
      ranked.push({ image: img, rank: rank, order: ranked.length });
    }
    ranked.sort(function (a, b) {
      if (a.rank[0] !== b.rank[0]) return b.rank[0] - a.rank[0];
      if (a.rank[1] !== b.rank[1]) return b.rank[1] - a.rank[1];
      return a.order - b.order;
    });
    var out = [], seen = {};
    for (i = 0; i < ranked.length; i++) {
      if (seen[ranked[i].image]) continue;
      seen[ranked[i].image] = true;
      out.push(ranked[i].image);
    }
    if (!out.length) return artworkPaths(options);
    return out;
  }

  function latestSeasonImage(options) {
    var list = artworkCandidates(options);
    return list.length ? list[0] : '';
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
    var deadline = now() + 20000;
    var page = await fetchText(siteUrl(ref.slug), HTML_HEADERS, 15000);
    if (page.status === 404) throw new Error('Mugiwara : cette fiche n\'existe pas.');
    var anime = page.status === 200 ? animeOfDetail(page.text) : null;
    if (!anime) throw new Error('Mugiwara : fiche illisible.');

    var options = anime.options || {};
    var seasons = Array.isArray(options.saisons) ? options.saisons : [];
    var films = filmOptionsOf(options);
    var paths = artworkPaths(options);
    var i;

    /* Season posters range from 300x400 to 1920x2880 without exposed
     * dimensions. The current season's poster is preferred; a low-resolution
     * variant falls back to the newest one that clears the size threshold. */
    var artPath = await bestArtPath(ref.slug, options, deadline) || paths[0] || '';

    var poster = assetUrl(ref.slug, artPath, 1920) || assetUrl(ref.slug, options.affiche, 1920);
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
    /* The home header paints `backdrop` full-screen and crop-fills it, so a
     * 16:9 key art loses its sides and looks zoomed. Only the portrait season
     * poster is exposed; the wide affiche stays in `banner`. */
    if (banner) out.banner = banner;

    var total = 0, unknown = [], u;
    for (i = 0; i < seasons.length; i++) {
      /* The grid only lists numeric seasons, so side content ("1hs", "oav")
       * must not inflate the advertised total. */
      if (!/^\d+$/.test(String(seasons[i] && seasons[i].id))) continue;
      var count = seasonEpisodeCount(seasons[i]);
      total += count;
      if (!count) unknown.push(seasons[i]);
    }
    /* Airing seasons declare no episode count, so the fiche would advertise
     * 48 episodes while the grid lists 54. The public player feed is the same
     * source the episode list uses, so the total stays truthful. */
    if (unknown.length) {
      var lecture = options.EPISODES_OPTIONS ? options.EPISODES_OPTIONS.lecture : '';
      var extra = lecture ? await mapLimit(unknown, 3, function (season) {
        var until = now() + 6000;
        return seasonScriptRows(lecture, String(season.id), 'vostfr', until)
          .then(function (rows) { return maxRowLength(rows); })
          .catch(function () { return 0; });
      }) : [];
      for (u = 0; u < extra.length; u++) total += extra[u];
    }
    if (films) {
      out.films = films.names.length;
      total += films.names.length;
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

  function seasonEpisodeCount(season) {
    var count = num(season && season.episodesCount);
    if (!count && season && Array.isArray(season.episodesName)) count = season.episodesName.length;
    return count;
  }

  function maxRowLength(rows) {
    var max = 0, i, key;
    if (!rows) return 0;
    if (Array.isArray(rows)) {
      for (i = 0; i < rows.length; i++) {
        if (Array.isArray(rows[i])) max = Math.max(max, rows[i].length);
      }
      return max;
    }
    for (key in rows) if (Object.prototype.hasOwnProperty.call(rows, key)) max = Math.max(max, maxRowLength(rows[key]));
    return max;
  }

  function parseScriptRows(text) {
    var rows = [], re = /var\s+eps\d+\s*=\s*(\[[^\]]*\])/g, m;
    while ((m = re.exec(String(text == null ? '' : text))) !== null) {
      try {
        var arr = JSON.parse(m[1]);
        if (Array.isArray(arr)) rows.push(arr.map(function (u) { return String(u == null ? '' : u); }));
      } catch (_) { /* one malformed host row */ }
    }
    return rows;
  }

  var API_HEADERS = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    'Referer': SITE + '/'
  };

  /* Airing seasons (Netflix/Crunchyroll simulcasts) have no host rows in the
   * flight payload. Their released episodes are published by the site's own
   * public player feed: /api/episodes-script/version gives the file version,
   * then /api/episodes-script returns `var epsN = [...]` where N is a host and
   * each entry is the URL for one episode. */
  async function seasonScriptRows(lecture, seasonId, lang, deadline) {
    if (!lecture) return [];
    var prefix = 't=' + enc(lecture) + '&saison=' + enc(seasonId) + '&lang=' + enc(lang);
    var ver = await fetchJson(SITE + '/api/episodes-script/version?' + prefix, API_HEADERS, 'GET', null, left(deadline, 6000));
    var filever = ver && ver.data && ver.data.filever ? String(ver.data.filever) : '';
    if (!filever) return [];
    var js = await fetchText(SITE + '/api/episodes-script?' + prefix + '&filever=' + enc(filever), API_HEADERS, left(deadline, 8000));
    if (js.status !== 200) return [];
    return parseScriptRows(js.text);
  }

  async function releasedCount(slug, season, deadline) {
    var page = await fetchText(siteUrl(slug) + '/episodes/saison' + enc(season.id), HTML_HEADERS, left(deadline, 8000));
    if (page.status !== 200) return 0;
    var anime = animeOfSeason(page.text);
    if (!anime) return 0;

    var list = Array.isArray(anime.options.saisons) ? anime.options.saisons : [];
    var self = null, i;
    for (i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === String(season.id)) { self = list[i]; break; }
    }
    var count = self ? maxRowLength(self.lang) : 0;
    if (count) return count;

    var lecture = anime.options.EPISODES_OPTIONS ? anime.options.EPISODES_OPTIONS.lecture : '';
    var rows = await seasonScriptRows(lecture, String(season.id), 'vostfr', deadline);
    return maxRowLength(rows);
  }

  async function mapLimit(items, limit, fn) {
    var out = new Array(items.length), next = 0;
    async function worker() {
      while (next < items.length) {
        var idx = next++;
        out[idx] = await fn(items[idx], idx);
      }
    }
    var workers = [], w;
    for (w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
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
    var deadline = now() + 25000;

    var counts = [], missing = [], s;
    for (s = 0; s < seasons.length; s++) {
      var handled = /^\d+$/.test(String(seasons[s] && seasons[s].id));
      counts.push(handled ? seasonEpisodeCount(seasons[s]) : 0);
      if (handled && !counts[s]) missing.push(s);
    }
    if (missing.length) {
      var derived = await mapLimit(missing, 5, function (idx) {
        return releasedCount(ref.slug, seasons[idx], deadline).catch(function () { return 0; });
      });
      for (s = 0; s < missing.length; s++) counts[missing[s]] = derived[s];
    }

    var out = [], offset = 0;
    for (s = 0; s < seasons.length; s++) {
      var season = seasons[s] || {};
      var id = String(season.id == null ? '' : season.id);
      if (!/^\d+$/.test(id)) continue; /* side content ("1hs", "oav") stays out */
      var count = counts[s];
      if (!count) continue;
      var ownNames = Array.isArray(season.episodesName) ? season.episodesName : [];

      var image = assetUrl(ref.slug, season.image, 300);
      for (var e = 1; e <= count; e++) {
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

    /* Films live in FILM_OPTIONS.names and have no seasons at all, so they are
     * appended as season-less entries ("5 Centimeters per Second" was empty). */
    var films = filmOptionsOf(options);
    if (films) {
      var links = filmLinksFrom(page.text, ref.slug);
      for (s = 0; s < films.names.length; s++) {
        var filmName = clean(films.names[s] && films.names[s].name);
        if (!filmName) continue;
        var film = links[s] || filmSlug(filmName);
        if (!film) continue;
        out.push({
          number: s + 1,
          href: filmUrl(ref.slug, film) + '#film-' + s,
          title: filmName,
          season: null
        });
      }
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
  function languageKeysIn(lang, tag) {
    if (!lang) return [];
    var re = tag === 'dub' ? /^vf/i : /^vostfr/i;
    var keys = [], k;
    for (k in lang) {
      if (Object.prototype.hasOwnProperty.call(lang, k) && re.test(k)) keys.push(k);
    }
    function rank(key) {
      var l = key.toLowerCase();
      if (l === (tag === 'dub' ? 'vf' : 'vostfr')) return 0;
      return /^(?:vf|vostfr)\d+$/.test(l) ? 1 : 2;
    }
    keys.sort(function (a, b) { return rank(a) - rank(b); });
    return keys;
  }

  function languageKeys(season, tag) {
    return languageKeysIn(season && season.lang, tag);
  }

  function embedAt(rows, index) {
    var urls = [], seen = {}, i;
    if (!Array.isArray(rows) || index < 1) return urls;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!Array.isArray(row) || !row[index - 1]) continue;
      var url = String(row[index - 1]).trim();
      if (!/^https?:\/\//i.test(url) || seen[url]) continue;
      seen[url] = true;
      urls.push(url);
    }
    urls.sort(function (a, b) { return hostRank(a) - hostRank(b); });
    return urls;
  }

  function embedCandidates(season, key, episode) {
    var rows = season && season.lang ? season.lang[key] : null;
    return Array.isArray(rows) ? embedAt(rows, episode) : [];
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

  function filmIndexOf(names, ref) {
    if (typeof ref.filmIndex === 'number' && ref.filmIndex >= 0 && ref.filmIndex < names.length) return ref.filmIndex;
    var want = String(ref.film || '').toLowerCase();
    for (var i = 0; i < names.length; i++) {
      if (filmSlug(names[i] && names[i].name) === want) return i;
    }
    return -1;
  }

  /* Film pages carry FILM_OPTIONS.lang with one row per host; each row is the
   * per-film URL list, so the film index picks the URL inside every row. */
  async function extractFilmStream(ref, tag, deadline) {
    var name = laneName(tag);
    var page = await fetchText(filmUrl(ref.slug, ref.film), HTML_HEADERS, left(deadline, 13000));
    if (page.status === 404) return streamFail('Mugiwara : ce film n\'existe pas.', tag);
    if (page.status !== 200) return streamFail('Mugiwara : la page du film n\'a pas repondu (HTTP ' + page.status + ').', tag);
    var anime = animeOfSeason(page.text);
    var films = anime && filmOptionsOf(anime.options);
    if (!films) return streamFail('Mugiwara : les lecteurs de ce film sont illisibles.', tag);

    var index = filmIndexOf(films.names, ref);
    if (index < 0) return streamFail('Mugiwara : ce film est introuvable dans la fiche.', tag);

    var keys = languageKeysIn(films.lang, tag);
    if (!keys.length) return streamFail('Mugiwara : ce film n\'a pas de ' + name + '.', tag);

    var primary = await firstOk(keys.map(function (key) {
      return probeEmbeds(embedAt(films.lang[key], index + 1), tag, deadline).catch(function () { return null; });
    }));
    if (!primary) return streamFail('Mugiwara : aucun lecteur ' + name + ' n\'a fourni de flux pour ce film.', tag);

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

  async function resolveLane(season, key, tag, episode, deadline) {
    var urls = embedCandidates(season, key, episode);
    if (!urls.length) return null;
    return probeEmbeds(urls, tag, deadline);
  }

  async function probeEmbeds(urls, tag, deadline) {
    var picks = (urls || []).slice(0, 3);
    if (!picks.length) return null;

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
    var deadline = now() + 22000;
    if (ref.film) return extractFilmStream(ref, tag, deadline);

    var seasonId = ref.season || '1';
    var episode = Number(ref.episode) > 0 ? Number(ref.episode) : 1;

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
    if (!season) return streamFail('Mugiwara : aucun lecteur pour cette saison.', tag);

    /* Serve the language that was asked for; never silently substitute the
     * other audio track (a VF request must not come back as VOSTFR). */
    var keys = languageKeys(season, tag);
    var primary = keys.length ? await firstOk(keys.map(function (k) {
      return resolveLane(season, k, tag, episode, deadline).catch(function () { return null; });
    })) : null;

    /* Airing seasons carry no lang rows in the flight payload; their released
     * episodes come from the public episodes-script feed instead. */
    var feedRows = [];
    if (!primary) {
      var lecture = anime.options.EPISODES_OPTIONS ? anime.options.EPISODES_OPTIONS.lecture : '';
      feedRows = lecture
        ? await seasonScriptRows(lecture, String(seasonId), tag === 'dub' ? 'vf' : 'vostfr', deadline).catch(function () { return []; })
        : [];
      primary = await probeEmbeds(embedAt(feedRows, episode), tag, deadline);
    }

    if (!primary) {
      /* A dubbed simulcast lags the subtitled one, so an episode listed for the
       * season may not exist in the requested language yet. */
      if (feedRows.length && !embedAt(feedRows, episode).length) {
        return streamFail('Mugiwara : cet episode n\'est pas encore disponible en ' + name + '.', tag);
      }
      if (!keys.length) return streamFail('Mugiwara : cette saison n\'a pas de ' + name + '.', tag);
      return streamFail('Mugiwara : aucun lecteur ' + name + ' n\'a fourni de flux pour cet episode.', tag);
    }

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
    var paths = anime && anime.options ? artworkPaths(anime.options) : [];
    return paths.length ? paths[0] : '';
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
      var filmList = filmOptionsOf(options);
      if (filmList) total += filmList.names.length;
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
  var ART_MIN_BYTES = 160000;
  var HERO_SKIP = {
    'jojos-bizarre-adventure': true,
    'bocchi-the-rock': true,
    'journal-with-witch': true
  };
  /* The best-rated feed is only 20 titles and does not contain every requested
   * header pick, so these are resolved by slug and placed first. */
  var HERO_PICKS = ['bleach', 'the-ramparts-of-ice'];

  async function heroPickItems(deadline) {
    var cards = await Promise.all(HERO_PICKS.map(async function (slug) {
      try {
        var page = await fetchText(siteUrl(slug), HTML_HEADERS, left(deadline, 4000));
        if (page.status !== 200) return null;
        var anime = animeOfDetail(page.text);
        if (!anime) return null;
        var art = await bestArtPath(slug, anime.options, deadline);
        if (!art) return null;
        return {
          slug: slug, anime: clean(anime.anime || '') || titleFromSlug(slug),
          wallpaper: art, _anime: anime
        };
      } catch (_) { return null; }
    }));
    var out = [], i;
    for (i = 0; i < cards.length; i++) if (cards[i]) out.push(cards[i]);
    return out;
  }

  async function headSize(url, timeoutMs) {
    try {
      var res = await fetchv2(url, { 'User-Agent': UA, 'Accept': 'image/webp,image/*,*/*' }, 'HEAD', null, { timeoutMs: timeoutMs });
      var headers = (res && res.headers) || {};
      var len = Number(headers['content-length'] || headers['Content-Length'] || 0);
      return isFinite(len) && len > 0 ? len : 0;
    } catch (_) { return 0; }
  }

  /* Newest season poster that clears the size gate; the heaviest probed one
   * otherwise. One candidate needs no probe, so single-season titles stay fast. */
  async function bestArtPath(slug, options, deadline) {
    var cands = artworkCandidates(options);
    if (!cands.length) return '';
    if (cands.length === 1) return cands[0];
    var probe = cands.slice(0, 6);
    var sizes = await Promise.all(probe.map(function (p) {
      var u = assetUrl(slug, p, 1920);
      return u ? headSize(u, left(deadline, 2200)) : Promise.resolve(0);
    }));
    var fallback = -1, fallbackSize = 0, i;
    for (i = 0; i < sizes.length; i++) {
      if (sizes[i] >= ART_MIN_BYTES) return probe[i];
      if (sizes[i] > fallbackSize) { fallbackSize = sizes[i]; fallback = i; }
    }
    return fallback >= 0 ? probe[fallback] : cands[0];
  }

  async function heroItemsFrom(items, deadline) {
    var picks = await heroPickItems(deadline);
    var pool = [], seen = {}, i;
    for (i = 0; i < picks.length; i++) seen[picks[i].slug] = true;
    for (i = 0; i < (items || []).length && pool.length < HERO_POOL; i++) {
      var it = items[i] || {};
      var slug = String(it.slug || '').trim().toLowerCase();
      if (!slug || seen[slug] || HERO_SKIP[slug]) continue;
      if (!clean(it.anime || '') || (!it.wallpaper && !it.affiche)) continue;
      seen[slug] = true;
      it.slug = slug;
      pool.push(it);
    }
    if (!pool.length && !picks.length) return [];

    /* Source posters range from 300x400 to 1920x2880 and the catalogue exposes
     * no dimensions. The 1920 variant's byte size separates 500 px posters
     * (40 KB) from 1200-1920 px ones (165-460 KB), so low-resolution titles are
     * skipped. Chunks of six respect the request cap and stop as soon as six
     * good posters are found. */
    var chosen = picks.slice(0, HERO_SIZE), fallback = [];
    for (i = 0; i < pool.length && chosen.length < HERO_SIZE; i += 6) {
      var chunk = pool.slice(i, i + 6);
      var sizes = await Promise.all(chunk.map(function (cand) {
        var url = assetUrl(cand.slug, cand.wallpaper || cand.affiche, 1920);
        return url ? headSize(url, left(deadline, 2500)) : Promise.resolve(0);
      }));
      for (var j = 0; j < chunk.length; j++) {
        if (sizes[j] >= ART_MIN_BYTES) chosen.push(chunk[j]);
        else fallback.push(chunk[j]);
      }
    }
    chosen = chosen.slice(0, HERO_SIZE);
    if (chosen.length < HERO_SIZE) chosen = chosen.concat(fallback).slice(0, HERO_SIZE);

    var cards = await Promise.all(chosen.map(async function (it) {
      var slug = String(it.slug || '').trim().toLowerCase();
      var anime = it._anime || null;
      if (!anime) {
        try {
          var page = await fetchText(siteUrl(slug), HTML_HEADERS, left(deadline, 4500));
          if (page.status === 200) anime = animeOfDetail(page.text);
        } catch (_) { anime = null; }
      }
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
