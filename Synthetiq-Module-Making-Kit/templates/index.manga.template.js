/* ============================================================================
 * Manga / image module template — Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * Same rules as the movie template: dependency-free, no timers, no typed
 * arrays, no atob/btoa. Read docs/04-manga-playbook.md first.
 * Test with:  node tools/run_checks.cjs <this folder> --query "one piece" --type image
 * ==========================================================================*/

(function () {
  'use strict';

  var SITE = 'https://example-manga.test';            // TODO: site root
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  var HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };

  var now = function () { return Date.now(); };
  var left = function (deadline, cap) { return Math.max(600, Math.min(deadline - now(), cap || 12000)); };

  function absolute(href, base) {
    var v = String(href == null ? '' : href).trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    if (/^\//.test(v)) return SITE + v;
    return (base || SITE) + '/' + v.replace(/^\.?\//, '');
  }

  function clean(s) {
    return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ').trim();
  }

  async function requestText(url, headers, timeoutMs) {
    var res = await fetchv2(url, Object.assign({}, HEADERS, headers || {}), 'GET', null, { timeoutMs: timeoutMs });
    var text = '';
    if (res && typeof res.text === 'function') text = await res.text();
    else if (res && typeof res.body === 'string') text = res.body;
    return { status: Number(res && (res.status || res.statusCode)) || 0, text: String(text || ''), headers: (res && res.headers) || {} };
  }

  async function requestJson(url, headers, timeoutMs) {
    var res = await fetchv2(url, Object.assign({}, HEADERS, headers || {}), 'GET', null, { timeoutMs: timeoutMs });
    var data = null;
    if (res && typeof res.json === 'function') { try { data = await res.json(); } catch (_) {} }
    else if (res && res.json != null) data = res.json;
    if (data == null && res && typeof res.body === 'string' && res.body) { try { data = JSON.parse(res.body); } catch (_) {} }
    if (data == null && res && typeof res.text === 'function') { try { data = JSON.parse(await res.text()); } catch (_) {} }
    return { status: Number(res && (res.status || res.statusCode)) || 0, data: data };
  }

  // Bracket-walk a JSON array/object embedded in a script tag. Regex-to-first-]
  // truncates nested arrays — always walk with a depth counter.
  function jsonAt(html, marker) {
    var i = html.indexOf(marker);
    if (i < 0) return null;
    var j = html.indexOf('[', i); if (j < 0) return null;
    var depth = 0, quoted = false, escaped = false;
    for (var k = j; k < html.length; k++) {
      var ch = html.charAt(k);
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(j, k + 1)); } catch (_) { return null; } } }
    }
    return null;
  }

  /* ================================================================ SEARCH
   * -> [{ title, href, image }]   (href = YOUR id for the series)
   * ===================================================================== */
  async function searchResults(keyword, page) {
    var deadline = now() + 15000;
    var term = String(keyword == null ? '' : keyword).trim();
    // TODO: real search endpoint; page = Number(page || 0) if the site paginates.
    var out = [];
    return out;
  }

  /* =============================================================== DETAILS */
  async function extractDetails(urlOrId) {
    var url = absolute(urlOrId);
    var deadline = now() + 15000;
    var res = await requestText(url, { Referer: SITE + '/' }, left(deadline));
    var html = res.text;
    return {
      id: url, href: url, url: url,
      title: clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || ''),
      description: clean((html.match(/name="description" content="([^"]+)"/i) || [])[1] || ''),
      image: absolute((html.match(/property="og:image" content="([^"]+)"/i) || [])[1] || ''),
    };
  }

  /* ============================================================== CHAPTERS
   * -> [{ number, href }] ascending.  href must round-trip to extractImages.
   * ===================================================================== */
  async function extractChapters(url) {
    var series = absolute(url);
    var deadline = now() + 15000;
    var out = [];
    // TODO examples:
    //  - anchors:   /<a href="\/chapter\/([^"]+)"[^>]*>([^<]+)<\/a>/g  -> number from label
    //  - JSON list: jsonAt(html, 'chapterList')  (bracket-walked)
    //  - API:       await requestJson(SITE + '/api/series/<slug>/chapters', ...)
    // Encode what extractImages needs, e.g.:  series + '::' + chapterId
    return out;
  }

  /* ================================================================ IMAGES
   * -> ["https://…/01.jpg", …]  direct URLs, reading order, no junk.
   * ===================================================================== */
  async function extractImages(chapterId) {
    var deadline = now() + 16000;
    var id = String(chapterId == null ? '' : chapterId);
    var out = [];
    // TODO: fetch the reader page / API with the site's Referer, decode the page
    // list (data-src attrs, a JSON blob, or an API), filter junk
    // (.gif logos, /ads/, spacer titles) and return the URLs.
    return out;
  }

  /* =============================================================== exports */
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractChapters = extractChapters;
  globalThis.extractImages = extractImages;
})();
