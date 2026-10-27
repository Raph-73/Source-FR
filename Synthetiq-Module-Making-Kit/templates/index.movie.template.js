/* ============================================================================
 * Movie module template — Synthetiq Player (contract v4)
 * ----------------------------------------------------------------------------
 * HOW TO USE
 *   1. Read docs/01-how-modules-work.md and docs/03-movies-playbook.md.
 *   2. Replace every TODO with the real endpoint/selector you found in recon.
 *   3. Test with:  node tools/run_checks.cjs <this folder> --query "matrix"
 *   4. Package with: node templates/package.cjs --dir <this folder> --version 1.0.0
 *
 * This file is intentionally dependency-free ES5-flavoured JS. It runs inside a
 * sealed sandbox that has NO timers, NO typed arrays, NO atob/btoa, NO Node APIs.
 * Only fetchv2, console, JSON, Math, Date, Promise and friends are available.
 * ==========================================================================*/

(function () {
  'use strict';

  // ---------------------------------------------------------------- settings
  var SITE = 'https://example-movies.test';           // TODO: the site root
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  var HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };

  var now = function () { return Date.now(); };
  var left = function (deadline, cap) { return Math.max(600, Math.min(deadline - now(), cap || 12000)); };

  // ---------------------------------------------------------------- helpers
  function absolute(href, base) {
    var v = String(href == null ? '' : href).trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    if (/^\//.test(v)) return SITE + v;
    return (base || SITE) + '/' + v.replace(/^\.?\//, '');
  }

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ').trim();
  }

  // Two request helpers: text for HTML, json for APIs (JSON bodies arrive EMPTY as text!).
  async function requestText(url, headers, timeoutMs) {
    var res = await fetchv2(url, Object.assign({}, HEADERS, headers || {}), 'GET', null, { timeoutMs: timeoutMs });
    var status = Number(res && (res.status || res.statusCode)) || 0;
    var text = '';
    if (res && typeof res.text === 'function') text = await res.text();
    else if (res && typeof res.body === 'string') text = res.body;
    return { status: status, text: String(text || ''), headers: (res && res.headers) || {} };
  }

  async function requestJson(url, headers, timeoutMs) {
    var res = await fetchv2(url, Object.assign({}, HEADERS, headers || {}), 'GET', null, { timeoutMs: timeoutMs });
    var status = Number(res && (res.status || res.statusCode)) || 0;
    var data = null;
    if (res && typeof res.json === 'function') { try { data = await res.json(); } catch (_) {} }
    else if (res && res.json != null) data = res.json;
    if (data == null && res && typeof res.body === 'string' && res.body) { try { data = JSON.parse(res.body); } catch (_) {} }
    if (data == null && res && typeof res.text === 'function') {
      var t = await res.text(); if (t) { try { data = JSON.parse(t); } catch (_) {} }
    }
    return { status: status, data: data };
  }

  /* ================================================================ SEARCH
   * Return [{ title, href, image }]. href = YOUR id for the movie (URL/slug).
   * ===================================================================== */
  async function searchResults(query) {
    var deadline = now() + 15000;
    var term = String(query == null ? '' : query).trim();

    // TODO: replace with the site's real search. Two common shapes:
    //  A) HTML:  var res = await requestText(SITE + '/?s=' + encodeURIComponent(term), { Referer: SITE + '/' }, left(deadline));
    //            then parse cards with a regex over res.text
    //  B) JSON:  var api = await requestJson(SITE + '/api/search?q=' + encodeURIComponent(term), {}, left(deadline));
    var out = [];
    return out;
  }

  /* =============================================================== DETAILS
   * Return { title, description, image, ... }. Never throw for a valid id.
   * ===================================================================== */
  async function extractDetails(urlOrId) {
    var url = absolute(urlOrId);
    if (!url) throw new Error('details: missing id');
    var deadline = now() + 15000;

    var res = await requestText(url, { Referer: SITE + '/' }, left(deadline));
    var html = res.text;

    return {
      id: url, href: url, url: url, type: 'video',
      title: clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || ''),
      description: clean((html.match(/name="description" content="([^"]+)"/i) || [])[1] || ''),
      image: absolute((html.match(/property="og:image" content="([^"]+)"/i) || [])[1] || ''),
    };
  }

  /* =============================================================== EPISODES
   * A movie is ONE episode. Keep the movie id in href so the stream stage can
   * find it later.  ->  [{ number: 1, href: '<movie id>', title: '<movie name>' }]
   * ===================================================================== */
  async function extractEpisodes(seriesId) {
    var url = absolute(seriesId);
    return [{ number: 1, href: url, title: 'Movie', season: null }];
  }

  /* ============================================================= STREAM URL
   * Resolve PER PLAY (never cache). Verify before returning.
   * Shapes:  { url, headers, streamType: 'mp4' | 'hls' }  or  { streams: [] }
   * ===================================================================== */
  async function extractStreamUrl(episodeHref, lang) {
    var deadline = now() + 16000;
    var url = absolute(episodeHref);
    if (!url) return { streams: [] };

    // TODO: find the media URL(s) for this title:
    //   - direct: regex the player page for an .mp4 / .m3u8 / player.src(...)
    //   - embed:  fetch the iframe URL with the site's Referer, extract its route
    var candidates = [];   // [{ url, headers, type }]

    for (var i = 0; i < candidates.length; i++) {
      if (now() >= deadline) break;
      var c = candidates[i];
      try {
        var probe = await fetchv2(c.url, Object.assign({ 'User-Agent': UA, Range: 'bytes=0-65535' }, c.headers || {}), 'GET', null, { timeoutMs: left(deadline, 6000) });
        var status = Number(probe && probe.status) || 0;
        var type = String((probe && probe.headers && (probe.headers['content-type'] || '')) || '');
        // Replace this fail-closed guard with source-specific validation backed
        // by real media probes. HTTP success and MIME alone are insufficient.
        var verifiedMedia = false; // TODO: implement and test validation
        if ((status === 200 || status === 206) && verifiedMedia) {
          return { url: c.url, headers: Object.assign({ 'User-Agent': UA }, c.headers || {}), streamType: c.type || 'mp4' };
        }
      } catch (_) { /* try next candidate */ }
    }
    return { streams: [] };
  }

  /* =============================================================== exports */
  globalThis.searchResults = searchResults;
  globalThis.extractDetails = extractDetails;
  globalThis.extractEpisodes = extractEpisodes;
  globalThis.extractStreamUrl = extractStreamUrl;
})();
