// atsu.moe manga module v3.0.1
// Content: manga/comics image reading
// API: Hono RPC at /api, Typesense search proxy at /collections/manga/documents/search

const BASE_URL = 'https://atsu.moe';
const CDN_URL = 'https://cdn.atsu.moe'; // static assets; the origin 301s there
const SEARCH_URL = BASE_URL + '/collections/manga/documents/search';
const API_URL = BASE_URL + '/api';
const UNSAFE_TERMS = [
  'hentai', 'adult', '18+', '18 plus', 'nsfw', 'explicit', 'mature',
  'smut', 'erotica', 'porn', 'xxx', 'doujinshi', 'ecchi', 'sexual',
  'incest', 'rape', 'rape-like', 'yaoi smut', 'yuri smut'
];
const UNSAFE_EXACT_TITLES = new Set([
  'jinx',
  'painter of the night',
  'killing stalking',
]);

// ─── helpers ────────────────────────────────────────────────────────────────

function _staticUrl(raw) {
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  const path = raw.startsWith('/') ? raw : ('/static/' + raw);
  return (path.startsWith('/static/') ? CDN_URL : BASE_URL) + path;
}

function _webpVariant(raw) {
  return String(raw || '').replace(/\.avif(\?|#|$)/i, '.webp$1');
}

function _posterFields(item) {
  const p = item && typeof item.poster === 'object' && item.poster ? item.poster : {};
  return {
    small: item.posterSmall || item.smallImage || p.smallImage || '',
    medium: item.posterMedium || item.mediumImage || p.mediumImage || '',
    flat: (typeof item.poster === 'string' ? item.poster : (p.largeImage || p.image || '')) || item.image || '',
  };
}

// Prefer app-decodable, smaller variants: small/medium WebP first, then the flat
// .jpg poster. AVIF stays only as a last resort — newer app engines decode it,
// older/desktop engines cannot always.
function _bestPoster(item, preferLarge) {
  const f = _posterFields(item || {});
  const chain = preferLarge ? [f.medium, f.small, f.flat] : [f.small, f.medium, f.flat];
  for (const raw of chain) {
    if (raw) return _staticUrl(_webpVariant(raw));
  }
  return '';
}

function _toReaderCard(item) {
  if (!item || !item.id || !item.title || _isUnsafeItem(item)) return null;
  return {
    title: item.englishTitle || item.title,
    href: BASE_URL + '/manga/' + item.id,
    image: _bestPoster(item, false),
    type: (item.type || 'MANGA').toUpperCase(),
  };
}

function _buildHeaders() {
  return {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Referer': BASE_URL + '/',
  };
}

function _text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(_text).join(' ');
  if (typeof value === 'object') {
    return Object.values(value).map(_text).join(' ');
  }
  return String(value);
}

function _isUnsafeText(value) {
  const normalized = _text(value)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  return UNSAFE_TERMS.some(term => normalized.includes(term));
}

function _isUnsafeItem(item) {
  if (!item) return true;
  const title = String(item.englishTitle || item.title || '').trim().toLowerCase();
  if (UNSAFE_EXACT_TITLES.has(title)) return true;
  // Keep the safety gate limited to user-facing names and an explicit scalar
  // audience rating. Nested metadata can include plot tags such as "sexual
  // violence" on otherwise ordinary titles, which must not suppress reading.
  const fields = [
    item.title,
    item.englishTitle,
    item.otherNames,
    typeof item.contentRating === 'string' ? item.contentRating : '',
    typeof item.rating === 'string' ? item.rating : '',
  ];
  return fields.some(_isUnsafeText);
}

async function _fetch(url) {
  const res = await fetchv2(url, _buildHeaders(), 'GET', null);
  if (!res) throw new Error('No response from ' + url);
  if (res.error) throw new Error('Fetch error: ' + res.error);
  // On-device Dart pre-parses JSON → res.body is '' but res.json() works.
  // On Node tester → res.body has the raw string.
  if (typeof res.json === 'function') {
    return await res.json();
  }
  const raw = res.body;
  if (!raw) throw new Error('Empty response from ' + url);
  return JSON.parse(raw);
}

async function _fetchHtml(url) {
  const res = await fetchv2(url, {
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Referer': BASE_URL + '/',
  }, 'GET', null);
  if (!res) throw new Error('No response from ' + url);
  if (res.error) throw new Error('Fetch error: ' + res.error);
  const body = res.body || '';
  if (!body) throw new Error('Empty HTML response from ' + url);
  return body;
}

// ─── searchResults ───────────────────────────────────────────────────────────

globalThis.searchResults = async function(query, page) {
  const results = [];
  const pageNumber = Math.max(1, Number(page) || 1);

  if (!query || query.trim() === '') {
    // Home feed: popular manga
    const data = await _fetch(API_URL + '/search/popular');
    const items = data.items || data || [];
    for (const item of items) {
      const card = _toReaderCard(item);
      if (card) results.push(card);
    }
    return results;
  }

  // Typesense search
  const qs = 'q=' + encodeURIComponent(query.trim())
    + '&query_by=title,englishTitle,otherNames,authors'
    + '&include_fields=id,title,englishTitle,poster,posterSmall,posterMedium,type'
    + '&page=' + pageNumber + '&per_page=24';
  const data = await _fetch(SEARCH_URL + '?' + qs);
  const hits = (data.hits || []);
  for (const hit of hits) {
    const doc = hit.document || hit;
    const card = _toReaderCard(doc);
    if (card) results.push(card);
  }
  return results;
};

// ─── extractDetails ──────────────────────────────────────────────────────────

globalThis.extractDetails = async function(href) {
  // href is like https://atsu.moe/manga/{id}
  const html = await _fetchHtml(href);

  // Parse window.mangaPage = {"mangaPage":{...}};
  const match = html.match(/window\.mangaPage\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|window\.|var |const |let )/);
  if (!match) throw new Error('Could not find mangaPage data in HTML');

  let pageData;
  try {
    pageData = JSON.parse(match[1]);
  } catch (e) {
    throw new Error('Failed to parse mangaPage JSON: ' + e.message);
  }

  const manga = pageData.mangaPage || pageData.manga || pageData;
  if (_isUnsafeItem(manga)) {
    throw new Error('This title is not available in Synthetiq.');
  }
  const title = manga.englishTitle || manga.title || '';
  const description = manga.synopsis || manga.description || manga.summary || manga.overview || manga.about || '';
  const poster = _bestPoster(manga, true);
  const genres = (manga.genres || []).map(g => g.name || g).filter(Boolean);
  const status = manga.status || '';
  const rating = manga.avgRating ? String(Math.round(manga.avgRating * 10) / 10) : '';

  return {
    title,
    description,
    image: poster,
    genres,
    status,
    rating,
    href,
  };
};

// ─── extractEpisodes (chapters) ──────────────────────────────────────────────

globalThis.extractEpisodes = async function(href) {
  return globalThis.extractChapters(href);
};

globalThis.extractChapters = async function(href) {
  // Extract mangaId from href: https://atsu.moe/manga/{id}
  const idMatch = href.match(/\/manga\/([^/?#]+)/);
  if (!idMatch) throw new Error('Could not extract manga ID from href: ' + href);
  const mangaId = idMatch[1];

  const data = await _fetch(API_URL + '/manga/info?mangaId=' + encodeURIComponent(mangaId));
  const chapters = data.chapters || [];

  // Return in reading order (ascending by number/index)
  const sorted = chapters.slice().sort((a, b) => {
    const na = parseFloat(a.number || a.index || 0);
    const nb = parseFloat(b.number || b.index || 0);
    return na - nb;
  });

  return sorted.map(ch => {
    const num = ch.number != null ? ch.number : ch.index;
    const title = ch.title ? ('Ch. ' + num + ' - ' + ch.title) : ('Chapter ' + num);
    return {
      title,
      href: 'atsu|' + mangaId + '|' + ch.id,
      number: num,
    };
  });
};

// ─── extractImages ───────────────────────────────────────────────────────────

globalThis.extractImages = async function(href) {
  // href is like "atsu|{mangaId}|{chapterId}"
  if (!href.startsWith('atsu|')) throw new Error('Invalid atsu chapter href: ' + href);
  const parts = href.split('|');
  if (parts.length < 3) throw new Error('Malformed atsu chapter href: ' + href);
  const mangaId = parts[1];
  const chapterId = parts[2];

  const data = await _fetch(
    API_URL + '/read/chapter?mangaId=' + encodeURIComponent(mangaId) + '&chapterId=' + encodeURIComponent(chapterId)
  );

  const chapter = data.readChapter || data;
  const pages = chapter.pages || [];

  // Sort by page number
  const sorted = pages.slice().sort((a, b) => (a.number || 0) - (b.number || 0));

  return sorted.map(page => {
    return page.image ? _staticUrl(page.image) : '';
  }).filter(Boolean);
};

// ─── extractStreamUrl (stub — image modules don't stream video) ──────────────

globalThis.extractStreamUrl = async function(href) {
  return null;
};

function toDiscoveryCards(items, limit) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const href = String(item && (item.href || item.url || item.id) || '').trim();
    const title = String(item && (item.title || item.name) || '').trim();
    if (!href || !title || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, id: href, title, image: String(item.image || item.poster || '').trim() });
    if (out.length >= limit) break;
  }
  return out;
}

async function discoverFor(query, limit) {
  try { return toDiscoveryCards(await globalThis.searchResults(query), limit); } catch (_) { return []; }
}

async function discoverCatalogPage(page, limit) {
  const pageNumber = Math.max(1, Number(page) || 1);
  const perPage = Math.max(1, Math.min(Number(limit) || 30, 30));
  const qs = 'q=*'
    + '&query_by=title,englishTitle,otherNames,authors'
    + '&include_fields=id,title,englishTitle,poster,posterSmall,posterMedium,type'
    + '&page=' + pageNumber
    + '&per_page=' + perPage;
  const data = await _fetch(SEARCH_URL + '?' + qs);
  const hits = Array.isArray(data.hits) ? data.hits : [];
  const items = [];
  for (const hit of hits) {
    const card = _toReaderCard(hit.document || hit);
    if (card) items.push(card);
  }
  return {
    items: toDiscoveryCards(items, perPage),
    hasMore: (pageNumber * perPage) < Number(data.found || 0),
  };
}

globalThis.discoveryHome = async function discoveryHome() {
  // Use real catalogue pages rather than a few static title searches. This
  // preserves source ordering and makes the home rows match the endless feed.
  const groups = await Promise.all([
    discoverCatalogPage(1, 24),
    discoverCatalogPage(2, 20),
    discoverCatalogPage(3, 20),
  ]);
  const sections = [];
  if (groups[0].items.length) sections.push({ id: 'popular', title: 'Popular', style: 'poster', items: groups[0].items, viewAll: { mode: 'feed', feedId: 'reader-all' } });
  if (groups[1].items.length) sections.push({ id: 'featured', title: 'Featured', style: 'landscape', items: groups[1].items, viewAll: { mode: 'feed', feedId: 'reader-all' } });
  if (groups[2].items.length) sections.push({ id: 'explore', title: 'Explore', style: 'poster', items: groups[2].items, viewAll: { mode: 'feed', feedId: 'reader-all' } });
  if (!sections.length) throw new Error('Atsu discovery returned no usable cards');
  return { sections };
};

globalThis.discoveryFeed = async function discoveryFeed(feedId, page) {
  const pageNumber = Math.max(1, Number(page) || 1);
  if (String(feedId || '').toLowerCase() !== 'reader-all') return { items: [], page: pageNumber, hasMore: false };
  const feed = await discoverCatalogPage(pageNumber, 30);
  return { items: feed.items, page: pageNumber, hasMore: feed.hasMore };
};
