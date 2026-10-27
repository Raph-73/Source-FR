/* Goyabu (goyabu.io) — Portuguese (Brazil) anime catalogue for Synthetiq Player.
 *
 * Chain proven live 2026-09-16:
 *   search  : /?s=<query>                      -> <article class="boxAN"> cards
 *   details : /anime/<slug>/                    -> h1, og:*, .sinopse, #year, .status
 *   episodes: /anime/<slug>/                    -> const allEpisodes = [ {id, episodio, link, audio, ...} ]
 *   stream  : /<episode-id>                     -> var playersData = [ {select:"blogger", url:"https://www.blogger.com/video.g?token=..."} ]
 *             blogger token -> batchexecute WcwnYd -> googlevideo.com MP4 (itag 22/18)
 *
 * Returns direct googlevideo MP4 URLs (verified with a 2-byte range probe before returning).
 */
(function () {
  'use strict';

  const SITE = 'https://goyabu.io';
  const BLOGGER_PLAYER = 'https://www.blogger.com/video.g?token=';
  const BATCHEXECUTE = 'https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const HTML_HEADERS = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.6',
  };
  const ITAG_PRIORITY = { 22: 720, 18: 360, 59: 480, 78: 480 };

  const episodesCache = {};

  const now = () => Date.now();
  const remaining = (deadline, cap) => Math.max(800, Math.min(deadline - now(), cap));

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
      .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&atilde;/gi, 'ã')
      .replace(/&otilde;/gi, 'õ').replace(/&ccedil;/gi, 'ç').replace(/&ecirc;/gi, 'ê')
      .replace(/&ocirc;/gi, 'ô').replace(/&acirc;/gi, 'â')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function absolute(href, base) {
    const value = String(href == null ? '' : href).trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (/^\/\//.test(value)) return 'https:' + value;
    if (/^\//.test(value)) return SITE + value;
    return (base || SITE) + '/' + value.replace(/^\.?\//, '');
  }

  async function requestText(url, headers, timeoutMs, method, body) {
    const opts = timeoutMs ? { timeoutMs } : undefined;
    let res;
    if (typeof fetchv2 === 'function') {
      res = await fetchv2(url, Object.assign({}, headers), method || 'GET', body || null, opts);
    } else if (typeof fetch === 'function') {
      res = await fetch(url, { method: method || 'GET', headers: headers || {}, body: body || undefined });
    } else {
      throw new Error('No HTTP transport available');
    }
    const status = Number(res && (res.status || res.statusCode)) || 0;
    let text = '';
    if (res && typeof res.text === 'function') {
      text = await res.text();
    } else if (res && typeof res.body === 'string') {
      text = res.body;
    } else if (res && res.body != null) {
      text = String(res.body);
    }
    if (!text && res && typeof res.json === 'function') {
      try {
        const parsed = await res.json();
        if (parsed != null) text = JSON.stringify(parsed);
      } catch (_) { /* keep empty */ }
    }
    return { status, text, headers: (res && res.headers) || {} };
  }

  /* ───────────── HTML parsing helpers ───────────── */

  function parseCards(html) {
    const cards = [];
    const re = /<article class="boxAN">([\s\S]*?)<\/article>/gi;
    let m;
    while ((m = re.exec(html))) {
      const block = m[1];
      const href = (block.match(/href="([^"]+)"/) || [])[1] || '';
      if (!href || href.indexOf('/anime/') < 0) continue;
      const title = cleanText((block.match(/title="([^"]+)"/) || [])[1] || (block.match(/class="title[^"]*"[^>]*>([^<]+)</) || [])[1] || '');
      const image = absolute((block.match(/<img[^>]+src="([^"]+)"/) || [])[1] || '');
      const audio = cleanText((block.match(/class="audio-box[^"]*"[^>]*>([^<]+)</) || [])[1] || '');
      if (!title) continue;
      cards.push({ href: absolute(href), title, image, audio });
    }
    return cards;
  }

  function parseEpisodeArray(html) {
    const i = html.indexOf('allEpisodes');
    if (i < 0) return [];
    const j = html.indexOf('[', i);
    if (j < 0) return [];
    let depth = 0;
    for (let k = j; k < html.length; k += 1) {
      const ch = html.charAt(k);
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          try {
            const arr = JSON.parse(html.slice(j, k + 1));
            return Array.isArray(arr) ? arr : [];
          } catch (_) {
            return [];
          }
        }
      }
    }
    return [];
  }

  function parsePlayers(html) {
    const i = html.indexOf('playersData');
    if (i < 0) return [];
    const j = html.indexOf('[', i);
    if (j < 0) return [];
    let depth = 0;
    for (let k = j; k < html.length; k += 1) {
      const ch = html.charAt(k);
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          try {
            const arr = JSON.parse(html.slice(j, k + 1));
            return Array.isArray(arr) ? arr : [];
          } catch (_) {
            return [];
          }
        }
      }
    }
    return [];
  }

  /* ───────────── Blogger (googlevideo) resolver ───────────── */

  function itagFromUrl(url) {
    const m = String(url || '').match(/[?&]itag=(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  async function resolveBloggerStreams(token, deadline) {
    const referer = BLOGGER_PLAYER + token;
    const page = await requestText(referer, { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }, remaining(deadline, 8000));
    if (page.status !== 200) throw new Error('blogger page HTTP ' + page.status);
    const fsid = (page.text.match(/"FdrFJe"\s*:\s*"(-?\d+)"/) || [])[1];
    const bl = (page.text.match(/"cfb2h"\s*:\s*"([^"]+)"/) || [])[1];
    if (!fsid || !bl) throw new Error('blogger session params missing');

    const fReq = JSON.stringify([[['WcwnYd', JSON.stringify([token, null, 0]), null, 'generic']]]);
    const query = 'rpcids=WcwnYd&source-path=%2Fvideo.g&f.sid=' + fsid + '&bl=' + encodeURIComponent(bl) + '&hl=pt-BR&_reqid=1&rt=c';
    const res = await requestText(
      BATCHEXECUTE + '?' + query,
      {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1',
        Referer: referer,
      },
      remaining(deadline, 8000),
      'POST',
      'f.req=' + encodeURIComponent(fReq)
    );
    if (res.status !== 200) throw new Error('batchexecute HTTP ' + res.status);

    let jsonLine = null;
    const lines = String(res.text || '').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line.indexOf('[[') === 0) { jsonLine = line; break; }
    }
    if (!jsonLine) throw new Error('batchexecute payload missing');
    const outer = JSON.parse(jsonLine);
    if (!outer || !outer[0] || typeof outer[0][2] !== 'string') throw new Error('batchexecute outer shape unexpected');
    const inner = JSON.parse(outer[0][2]);
    const streams = (inner && inner[2]) || [];
    const ranked = [];
    for (let i = 0; i < streams.length; i += 1) {
      const entry = streams[i];
      if (!entry || typeof entry[0] !== 'string') continue;
      if (entry[0].indexOf('googlevideo.com') < 0) continue;
      const itag = (entry[1] && entry[1][0]) || itagFromUrl(entry[0]);
      ranked.push({ url: entry[0], score: ITAG_PRIORITY[itag] || itag || 0 });
    }
    ranked.sort((a, b) => b.score - a.score);
    const seen = {};
    const urls = [];
    for (let i = 0; i < ranked.length; i += 1) {
      if (seen[ranked[i].url]) continue;
      seen[ranked[i].url] = true;
      urls.push(ranked[i].url);
    }
    if (!urls.length) throw new Error('no googlevideo URLs');
    return urls;
  }

  /* ───────────── 18+ exclusion & audio labels ───────────── */

  // The site keeps its adult catalogue in the "+18" genre (/generos/18). One API call lists it in full
  // (29 items, single page). The hrefs are cached and used to keep those titles out of search and discovery.
  const ADULT_SEED_TITLE_RE = /\boverflow\b/i;   // seeded explicitly; also covered by the harvested list
  const adultState = { at: 0, hrefs: {}, titles: [] };

  function audioLabel(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (!v) return 'Legendado';                       // the site marks dubs with a badge; no badge = legendado
    if (v === 'ptbr' || v.indexOf('dublado') >= 0 || v === 'dub') return 'Dublado';
    if (v === 'jap' || v.indexOf('legendado') >= 0 || v === 'sub') return 'Legendado';
    return cleanText(value);
  }

  function isAdultItem(href, title) {
    if (ADULT_SEED_TITLE_RE.test(String(title || ''))) return true;
    const key = String(href || '').replace(/\/$/, '').toLowerCase();
    if (key && adultState.hrefs[key]) return true;
    const t = String(title || '').trim().toLowerCase();
    return !!t && adultState.titles.indexOf(t) >= 0;
  }

  async function harvestAdultList(deadline) {
    if (now() - adultState.at < 6 * 3600 * 1000 && (adultState.titles.length || adultState.at)) return;
    try {
      const page = await fetchFilterPage(1, { genero: '18', per_page: 50 }, deadline, true);
      const hrefs = {};
      const titles = [];
      for (let i = 0; i < page.items.length; i += 1) {
        const it = page.items[i];
        if (it.href) hrefs[it.href.replace(/\/$/, '').toLowerCase()] = 1;
        if (it.title) titles.push(it.title.trim().toLowerCase());
      }
      if (titles.length) {
        adultState.at = now();
        adultState.hrefs = hrefs;
        adultState.titles = titles;
      }
    } catch (_) { /* keep the previous list; the seed title still applies */ }
  }

  /* ───────────── WordPress session + filter API ───────────── */

  const apiSession = { nonce: '', at: 0 };

  async function wpNonce(deadline) {
    if (apiSession.nonce && now() - apiSession.at < 6 * 3600 * 1000) return apiSession.nonce;
    const res = await requestText(SITE + '/?s=', Object.assign({}, HTML_HEADERS, { Referer: SITE + '/' }), remaining(deadline, 10000));
    if (res.status !== 200) throw new Error('Goyabu session HTTP ' + res.status);
    const m = res.text.match(/"nonce":"([a-f0-9]+)"/);
    if (!m) throw new Error('Goyabu session nonce missing');
    apiSession.nonce = m[1];
    apiSession.at = now();
    return apiSession.nonce;
  }

  function filterItem(it) {
    const audio = audioLabel(it.audio);
    return {
      id: it.url, href: it.url, title: cleanText(it.title), image: absolute(it.image), poster: absolute(it.image),
      type: 'video', description: audio,
      ...(it.year ? { year: String(it.year) } : {}),
    };
  }

  async function fetchFilterPage(pageNum, params, deadline, skipAdultHarvest) {
    let nonce = await wpNonce(deadline);
    const call = async (nonceValue) => {
      const q = ['page=' + pageNum, 'per_page=' + ((params && params.per_page) || 50)];
      if (params && params.genero) q.push('genero=' + encodeURIComponent(params.genero));
      q.push('nonce=' + nonceValue);
      return requestText(
        SITE + '/wp-json/cronos/v1/animes/filter?' + q.join('&'),
        Object.assign({}, HTML_HEADERS, { Accept: 'application/json, text/plain, */*', Referer: SITE + '/?s=' }),
        remaining(deadline, 10000)
      );
    };
    let res = await call(nonce);
    if (res.status === 403) {              // stale nonce -> refresh once
      apiSession.nonce = ''; apiSession.at = 0;
      nonce = await wpNonce(deadline);
      res = await call(nonce);
    }
    if (res.status !== 200) throw new Error('Goyabu filter HTTP ' + res.status);
    const data = JSON.parse(res.text || '{}');
    const raw = Array.isArray(data.animes) ? data.animes : [];
    const items = [];
    for (let i = 0; i < raw.length; i += 1) {
      const it = raw[i];
      if (!it || !it.url) continue;
      if (isAdultItem(it.url, it.title)) continue;
      items.push(filterItem(it));
    }
    return {
      items,
      totalPages: Number(data.total_pages) || 0,
      currentPage: Number(data.current_page) || pageNum,
      rawCount: raw.length,
    };
  }

  /* ───────────── Search ───────────── */

  function htmlCard(c) {
    const audio = audioLabel(c.audio);
    return {
      id: c.href, href: c.href, title: c.title, image: c.image, poster: c.image,
      type: 'video', description: audio,
    };
  }

  async function searchResults(query) {
    const deadline = now() + 15000;
    const term = String(query == null ? '' : query).trim();
    const res = await requestText(
      SITE + '/?s=' + encodeURIComponent(term),
      Object.assign({}, HTML_HEADERS, { Referer: SITE + '/' }),
      remaining(deadline, 12000)
    );
    if (res.status !== 200) throw new Error('Goyabu search HTTP ' + res.status);
    await harvestAdultList(deadline);
    return parseCards(res.text)
      .filter((c) => !isAdultItem(c.href, c.title))
      .map(htmlCard);
  }

  /* ───────────── Details ───────────── */

  async function extractDetails(urlOrId) {
    const deadline = now() + 15000;
    const url = absolute(urlOrId);
    if (url.indexOf('/anime/') < 0) throw new Error('Goyabu details: not an anime URL');
    const res = await requestText(url, Object.assign({}, HTML_HEADERS, { Referer: SITE + '/' }), remaining(deadline, 12000));
    if (res.status !== 200) throw new Error('Goyabu details HTTP ' + res.status);
    const html = res.text;

    const title = cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
    let description = cleanText((html.match(/class="sinopse-short"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '');
    if (!description) description = cleanText((html.match(/property="og:description" content="([^"]+)"/i) || [])[1] || '');
    const image = absolute((html.match(/property="og:image" content="([^"]+)"/i) || [])[1] || '');
    const year = cleanText((html.match(/id="year"[^>]*>([\s\S]*?)<\/li>/i) || [])[1] || '');
    const status = cleanText((html.match(/class="status[^"]*"[^>]*>([\s\S]*?)<\/li>/i) || [])[1] || '');
    const genres = [];
    const genreRe = /href="https:\/\/goyabu\.io\/genero\/([^/"]+)\/?"/gi;
    let gm;
    while ((gm = genreRe.exec(html))) {
      const label = cleanText(decodeURIComponent(gm[1]).replace(/-/g, ' '));
      if (label && genres.indexOf(label) < 0) genres.push(label);
    }

    return {
      id: url,
      href: url,
      url,
      title,
      description,
      image,
      poster: image,
      author: '',
      status,
      genres,
      ...(year ? { year } : {}),
      type: 'video',
    };
  }

  /* ───────────── Episodes ───────────── */

  async function extractEpisodes(seriesId) {
    const deadline = now() + 15000;
    const url = absolute(seriesId);
    if (url.indexOf('/anime/') < 0) return [];
    if (episodesCache[url] && now() - episodesCache[url].at < 180000) return episodesCache[url].items;
    const res = await requestText(url, Object.assign({}, HTML_HEADERS, { Referer: SITE + '/' }), remaining(deadline, 12000));
    if (res.status !== 200) throw new Error('Goyabu episodes HTTP ' + res.status);
    const raw = parseEpisodeArray(res.text);
    const items = [];
    for (let i = 0; i < raw.length; i += 1) {
      const ep = raw[i] || {};
      const link = absolute(ep.link);
      if (!link) continue;
      const num = Number(ep.episodio);
      const audio = String(ep.audio || '').toLowerCase();
      const isDub = /ptbr|pt-br|dublado|dub/.test(audio);
      items.push({
        number: Number.isFinite(num) && num > 0 ? num : i + 1,
        href: link,
        title: cleanText(ep.episode_name) || ('Episódio ' + (Number.isFinite(num) && num > 0 ? num : i + 1)),
        season: null,
        subAvailable: !isDub,
        dubAvailable: isDub,
      });
    }
    items.sort((a, b) => a.number - b.number);
    if (items.length) episodesCache[url] = { at: now(), items };
    return items;
  }

  /* ───────────── Stream ───────────── */

  async function probeMedia(url, deadline) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await requestText(url, { 'User-Agent': UA, Range: 'bytes=0-1' }, remaining(deadline, 6000));
        const status = res.status;
        const type = String((res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '');
        if ((status === 200 || status === 206) && (/video\/|application\/octet-stream|audio\/mp4/i.test(type) || !type)) return true;
        return false;                          // definite rejection: no second try
      } catch (_) {
        if (now() >= deadline) return false;   // transient failure: one retry below
      }
    }
    return false;
  }

  async function streamFromPlayers(html, deadline) {
    const players = parsePlayers(html);
    const bloggerPlayers = [];
    for (let i = 0; i < players.length; i += 1) {
      const purl = String((players[i] || {}).url || '');
      if (purl.indexOf('blogger.com/video.g?token=') >= 0) bloggerPlayers.push(purl);
    }
    if (!bloggerPlayers.length) {
      for (let i = 0; i < players.length; i += 1) {
        const purl = String((players[i] || {}).url || '');
        if (purl.indexOf('token=') >= 0) bloggerPlayers.push(purl);
      }
    }
    for (let i = 0; i < bloggerPlayers.length; i += 1) {
      if (now() >= deadline) break;
      const token = (bloggerPlayers[i].match(/[?&]token=([^&]+)/) || [])[1];
      if (!token) continue;
      try {
        const urls = await resolveBloggerStreams(token, deadline);
        for (let j = 0; j < urls.length; j += 1) {
          if (now() >= deadline) break;
          if (await probeMedia(urls[j], deadline)) {
            return { url: urls[j], headers: { 'User-Agent': UA }, streamType: 'mp4' };
          }
        }
      } catch (_) { /* try next player */ }
    }
    return null;
  }

  async function extractStreamUrl(episodeHref, lang) {
    const deadline = now() + 16000;   // stay under the 20s tester cap and the app's 30s budget
    const url = absolute(episodeHref);
    if (!url) return { streams: [] };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (now() >= deadline) break;
      try {
        const res = await requestText(url, Object.assign({}, HTML_HEADERS, { Referer: SITE + '/' }), remaining(deadline, 12000));
        if (res.status !== 200) throw new Error('Goyabu episode HTTP ' + res.status);
        const stream = await streamFromPlayers(res.text, deadline);
        if (stream) return stream;
      } catch (_) { /* one fresh retry follows */ }
    }
    return { streams: [] };
  }

  /* ───────────── Discovery ───────────── */

  function hasAdultGenre(it) {
    const gs = it && it.genres;
    if (!Array.isArray(gs)) return false;
    for (let i = 0; i < gs.length; i += 1) {
      const g = gs[i] || {};
      const label = String(g.label || '').trim();
      const url = String(g.url || '');
      if (/^\+?18$|adulto|hentai/i.test(label) || /\/generos\/18\b/.test(url)) return true;
    }
    return false;
  }

  async function rankingBuckets(deadline) {
    const res = await requestText(
      SITE + '/wp-json/cronos/v1/views/ranking-all?limit=30&type=anime',
      Object.assign({}, HTML_HEADERS, { Accept: 'application/json, text/plain, */*', Referer: SITE + '/' }),
      remaining(deadline, 12000)
    );
    if (res.status !== 200) throw new Error('Goyabu ranking HTTP ' + res.status);
    const data = JSON.parse(res.text);
    const rankings = (data && data.rankings) || {};
    const map = (list) => (Array.isArray(list) ? list : [])
      .filter((it) => it && it.permalink && !hasAdultGenre(it) && !isAdultItem(it.permalink, it.title))
      .map((it) => ({
        id: it.permalink, href: it.permalink, title: cleanText(it.title),
        image: absolute(it.poster || ''), poster: absolute(it.poster || ''), type: 'video',
        description: audioLabel(it.audio) + (it.rating ? ' \u00b7 \u2605 ' + it.rating : ''),
      }));
    return { week: map(rankings.week), day: map(rankings.day), month: map(rankings.month) };
  }

  async function discoveryHome() {
    const deadline = now() + 18000;
    const sections = [];
    let buckets = { week: [], day: [], month: [] };
    try { buckets = await rankingBuckets(deadline); } catch (_) { /* catalogue-only fallback */ }
    if (buckets.week.length) sections.push({ id: 'semana', title: 'Populares da Semana', style: 'hero', items: buckets.week.slice(0, 8) });
    if (buckets.day.length) sections.push({ id: 'hoje', title: 'Mais Assistidos Hoje', style: 'poster', items: buckets.day.slice(0, 20) });
    try {
      await harvestAdultList(deadline);
      const page = await fetchFilterPage(1, {}, deadline);
      if (page.items.length) {
        sections.push({ id: 'novidades', title: 'Novidades', style: 'poster', items: page.items.slice(0, 30), viewAll: { mode: 'feed', feedId: 'catalogo' } });
        const dub = page.items.filter((it) => it.description === 'Dublado');
        if (dub.length >= 4) sections.push({ id: 'dublado', title: 'Em Portugu\u00eas (Dublado)', style: 'poster', items: dub.slice(0, 20) });
      } else {
        const res = await requestText(SITE + '/?s=', Object.assign({}, HTML_HEADERS, { Referer: SITE + '/' }), remaining(deadline, 12000));
        if (res.status === 200) {
          const items = parseCards(res.text).filter((c) => !isAdultItem(c.href, c.title)).slice(0, 30).map(htmlCard);
          if (items.length) sections.push({ id: 'catalogo', title: 'Cat\u00e1logo (Dublado & Legendado)', style: 'poster', items, viewAll: { mode: 'feed', feedId: 'catalogo' } });
        }
      }
    } catch (_) { /* ranking-only fallback */ }
    return { sections };
  }

  async function discoveryFeed(feedId, page) {
    const deadline = now() + 18000;
    const pageNum = Math.max(1, Number(page) || 1);
    const feed = String(feedId || 'catalogo');
    if (feed === 'populares') {
      if (pageNum > 1) return { items: [], page: pageNum, hasMore: false };
      const buckets = await rankingBuckets(deadline);
      return { items: (buckets.month.length ? buckets.month : buckets.week).slice(0, 50), page: 1, hasMore: false };
    }
    if (feed.indexOf('genero:') === 0) {
      const slug = feed.slice('genero:'.length).replace(/[^a-z0-9-]/gi, '');
      if (!slug || slug === '18') return { items: [], page: pageNum, hasMore: false };
      await harvestAdultList(deadline);
      const pageData = await fetchFilterPage(pageNum, { genero: slug }, deadline);
      return { items: pageData.items, page: pageNum, hasMore: pageData.totalPages ? pageData.currentPage < pageData.totalPages : pageData.items.length >= 40 };
    }
    // default: full catalogue, paginated
    await harvestAdultList(deadline);
    try {
      const pageData = await fetchFilterPage(pageNum, {}, deadline);
      const hasMore = pageData.totalPages ? pageData.currentPage < pageData.totalPages : pageData.items.length >= 40;
      return { items: pageData.items, page: pageNum, hasMore };
    } catch (_) {
      const res = await requestText(SITE + '/?s=&paged=' + pageNum, Object.assign({}, HTML_HEADERS, { Referer: SITE + '/' }), remaining(deadline, 12000));
      if (res.status !== 200) throw new Error('Goyabu feed HTTP ' + res.status);
      const items = parseCards(res.text).filter((c) => !isAdultItem(c.href, c.title)).map(htmlCard);
      return { items, page: pageNum, hasMore: items.length >= 45 };
    }
  }

  /* ───────────── Exports ───────────── */

  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
  globalThis.discoveryHome = discoveryHome;
  globalThis.discoveryFeed = discoveryFeed;
})();
