#!/usr/bin/env node
/* Live behavioral checks for NOVA. Read-only public catalogue/embeds. */
const path = require('node:path');
const KIT = path.resolve(__dirname, '..', '..');
const MODULE = path.resolve(__dirname, '..');
const { loadModule, call } = require(path.join(KIT, 'tools', 'local_runtime.cjs'));
const { candidates, probe } = require(path.join(KIT, 'tools', 'media_probe.cjs'));

const modulePath = path.join(MODULE, 'index.js');
const ctx = loadModule(modulePath, { verbose: false });
const results = [];
function rec(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`${status} ${name}${detail ? ' :: ' + detail : ''}`);
}
async function check(name, fn) {
  try { await fn(); } catch (e) { rec(name, 'FAIL', String(e && e.message || e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function stream(id, lang = 'dub') {
  return call(ctx, 'extractStreamUrl', [id, lang], 30000);
}
async function probeStream(res, label, all = false) {
  assert(res && Array.isArray(res.streams) && res.streams.length > 0, 'no streams');
  const routes = candidates(res);
  assert(routes.length > 0, 'no candidate route');
  const sample = all ? routes : routes.slice(0, 2);
  const out = [];
  for (const route of sample) out.push(await probe(route.url, route.headers));
  return `${out.join(' | ')} [${sample.length}/${routes.length} routes]`;
}

(async () => {
  await check('search-empty', async () => {
    const r = await call(ctx, 'searchResults', ['', 0], 20000);
    assert(Array.isArray(r) && r.length === 0, 'expected [] for empty query');
    rec('search-empty', 'PASS', '[]');
  });
  await check('search-unknown', async () => {
    const r = await call(ctx, 'searchResults', ['zzzzzznotarealtitle', 0], 20000);
    assert(Array.isArray(r) && r.length === 0, 'expected []');
    rec('search-unknown', 'PASS', '[]');
  });
  await check('search-premium-excluded', async () => {
    const r = await call(ctx, 'searchResults', ['Anna et les Enfants', 0], 20000);
    assert(Array.isArray(r), 'not array');
    assert(!r.some(x => x.href === 'movie-1483325'), 'premium title leaked');
    rec('search-premium-excluded', 'PASS', `${r.length} cards, premium absent`);
  });
  await check('search-unsupported-host-excluded', async () => {
    const r = await call(ctx, 'searchResults', ['Uncharted', 0], 20000);
    assert(Array.isArray(r), 'not array');
    assert(!r.some(x => x.href === 'movie-335787'), 'Heiwa title leaked');
    rec('search-unsupported-host-excluded', 'PASS', `${r.length} cards, Heiwa absent`);
  });
  await check('search-two-samples-stable', async () => {
    const a = await call(ctx, 'searchResults', ['Vikings', 0], 20000);
    const b = await call(ctx, 'searchResults', ['Vikings', 0], 20000);
    assert(JSON.stringify(a) === JSON.stringify(b), 'non-stable results');
    assert(a.length > 0 && a[0].title === 'Vikings', 'Vikings not first');
    rec('search-two-samples-stable', 'PASS', `${a.length} cards, identical twice`);
  });
  await check('details-film', async () => {
    const d = await call(ctx, 'extractDetails', ['movie-663260'], 20000);
    assert(d && d.title === 'Boîte noire', 'wrong title');
    assert(d.type === 'video' && d.available === true, 'film not available');
    rec('details-film', 'PASS', `${d.title} / available=${d.available}`);
  });
  await check('details-premium', async () => {
    const d = await call(ctx, 'extractDetails', ['movie-1483325'], 20000);
    assert(d && d.premium === true && d.available === false, 'premium not marked unavailable');
    rec('details-premium', 'PASS', d.notice);
  });
  await check('details-heiwa', async () => {
    const d = await call(ctx, 'extractDetails', ['movie-335787'], 20000);
    assert(d && d.available === false, 'Heiwa marked available');
    rec('details-heiwa', 'PASS', d.notice);
  });
  await check('episodes-film', async () => {
    const e = await call(ctx, 'extractEpisodes', ['movie-663260'], 20000);
    assert(Array.isArray(e) && e.length === 1 && e[0].number === 1, 'film episode list wrong');
    rec('episodes-film', 'PASS', JSON.stringify(e[0]));
  });
  await check('episodes-premium-film', async () => {
    const e = await call(ctx, 'extractEpisodes', ['movie-1483325'], 20000);
    assert(Array.isArray(e) && e.length === 0, 'premium film episodes leaked');
    rec('episodes-premium-film', 'PASS', '[]');
  });
  await check('episodes-heiwa', async () => {
    const e = await call(ctx, 'extractEpisodes', ['movie-335787'], 20000);
    assert(Array.isArray(e) && e.length === 0, 'Heiwa film episodes leaked');
    rec('episodes-heiwa', 'PASS', '[]');
  });
  let vikings = null;
  await check('episodes-vikings', async () => {
    vikings = await call(ctx, 'extractEpisodes', ['tv-44217'], 20000);
    assert(Array.isArray(vikings) && vikings.length > 0, 'no free episodes');
    assert(vikings.every(x => /^tv-44217-s\d+e\d+$/.test(x.href)), 'bad ids');
    for (let i = 1; i < vikings.length; i++) {
      const a = vikings[i - 1], b = vikings[i];
      assert((a.season < b.season) || (a.season === b.season && a.episode < b.episode), 'not ascending');
    }
    rec('episodes-vikings', 'PASS', `${vikings.length} free episodes, ${vikings[0].href}..${vikings[vikings.length - 1].href}`);
  });
  await check('episodes-sterling-premium', async () => {
    const e = await call(ctx, 'extractEpisodes', ['tv-283297'], 20000);
    assert(Array.isArray(e) && e.length === 0, 'premium episodes leaked');
    rec('episodes-sterling-premium', 'PASS', '[]');
  });

  await check('stream-vostfr-rejected', async () => {
    const r = await stream('movie-663260', 'vostfr');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'not rejected');
    rec('stream-vostfr-rejected', 'PASS', r.error.message);
  });
  await check('stream-premium-rejected', async () => {
    const r = await stream('movie-1483325');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'not rejected');
    rec('stream-premium-rejected', 'PASS', r.error.message);
  });
  await check('stream-heiwa-rejected', async () => {
    const r = await stream('movie-335787');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'not rejected');
    assert(/HeiwaStream/i.test(r.error.message), 'wrong error');
    rec('stream-heiwa-rejected', 'PASS', r.error.message);
  });
  await check('stream-vidzy-rejected', async () => {
    const r = await stream('movie-1504358');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'not rejected');
    assert(/uqload/i.test(r.error.message), 'wrong error');
    rec('stream-vidzy-rejected', 'PASS', r.error.message);
  });
  await check('stream-premium-episode-rejected', async () => {
    const r = await stream('tv-283297-s1e1');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'not rejected');
    assert(/Premium/i.test(r.error.message), 'wrong error');
    rec('stream-premium-episode-rejected', 'PASS', r.error.message);
  });
  await check('stream-film-episode-source-blocked', async () => {
    const r = await stream('movie-381284');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'episode source accepted for film');
    rec('stream-film-episode-source-blocked', 'PASS', r.error.message);
  });
  await check('stream-wrong-year-blocked', async () => {
    const r = await stream('movie-4327');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'wrong-year source accepted');
    rec('stream-wrong-year-blocked', 'PASS', r.error.message);
  });
  await check('stream-wrong-title-blocked', async () => {
    const r = await stream('movie-1243078');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'wrong-title source accepted');
    rec('stream-wrong-title-blocked', 'PASS', r.error.message);
  });
  await check('stream-wrong-title-year-blocked', async () => {
    const r = await stream('movie-33740');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'wrong source accepted');
    rec('stream-wrong-title-year-blocked', 'PASS', r.error.message);
  });
  await check('stream-source-vostfr-blocked', async () => {
    const r = await stream('movie-1744462');
    assert(r && r.streams && r.streams.length === 0 && r.error, 'VOSTFR source accepted');
    assert(/VOSTFR/i.test(r.error.message), 'wrong error');
    rec('stream-source-vostfr-blocked', 'PASS', r.error.message);
  });

  let validFilm = null;
  await check('stream-valid-film-1', async () => {
    const r = await stream('movie-1152014');
    const detail = await probeStream(r, 'movie-1152014');
    assert(r.qualities && r.qualities.length > 0, 'no qualities');
    assert(r.headers && /uqload\.vc/.test(r.headers.Referer || ''), 'missing stream headers');
    validFilm = r;
    rec('stream-valid-film-1', 'PASS', `${r.quality}; ${detail}`);
  });
  await check('stream-valid-film-2', async () => {
    const r = await stream('movie-745608');
    const detail = await probeStream(r, 'movie-745608');
    assert(r.qualities && r.qualities.length > 0, 'no qualities');
    rec('stream-valid-film-2', 'PASS', `${r.quality}; ${detail}`);
  });
  await check('stream-valid-episode', async () => {
    assert(vikings && vikings.length > 0, 'Vikings list missing');
    const r = await stream(vikings[0].href);
    const detail = await probeStream(r, vikings[0].href);
    rec('stream-valid-episode', 'PASS', `${vikings[0].href}; ${r.quality}; ${detail}`);
  });
  await check('stream-valid-episode-2', async () => {
    const list = await call(ctx, 'extractEpisodes', ['tv-5920'], 20000);
    assert(list.length > 0, 'Mentalist list missing');
    const r = await stream(list[0].href);
    const detail = await probeStream(r, list[0].href);
    rec('stream-valid-episode-2', 'PASS', `${list[0].href}; ${r.quality}; ${detail}`);
  });
  await check('full-url-inputs', async () => {
    const d = await call(ctx, 'extractDetails', ['https://watchnova.win/title/movie-663260'], 20000);
    assert(d && d.title === 'Boîte noire', 'details URL failed');
    const e = await call(ctx, 'extractEpisodes', ['https://watchnova.win/title/tv-44217'], 20000);
    assert(Array.isArray(e) && e.length > 0, 'episodes URL failed');
    const r = await call(ctx, 'extractStreamUrl', ['https://watchnova.win/title/movie-745608', 'dub'], 30000);
    assert(r && !r.error && r.streams.length > 0, 'stream URL failed');
    rec('full-url-inputs', 'PASS', `${d.title}; ${e.length} episodes; ${r.quality}`);
  });

  await check('discovery-home', async () => {
    const h = await call(ctx, 'discoveryHome', [], 15000);
    assert(h && Array.isArray(h.sections) && h.sections.length > 0 && h.sections.length <= 12, 'bad home');
    const ids = new Set(), hrefs = new Set();
    let count = 0;
    for (const s of h.sections) {
      assert(/^[a-z0-9_-]{1,64}$/.test(s.id) && s.title && Array.isArray(s.items), 'bad section');
      assert(!ids.has(s.id), 'duplicate section id');
      ids.add(s.id);
      assert(s.items.length <= 30, 'section over cap');
      for (const it of s.items) {
        assert(it.href && it.title && it.image, 'bad card');
        assert(!hrefs.has(it.href), 'duplicate href across home');
        hrefs.add(it.href); count++;
      }
      assert(!s.items.some(it => it.href === 'movie-1483325'), 'premium item in home');
      assert(!s.items.some(it => it.href === 'movie-335787'), 'Heiwa item in home');
    }
    rec('discovery-home', 'PASS', `${h.sections.length} sections, ${count} unique cards: ${h.sections.map(s => s.id).join(',')}`);
  });
  await check('discovery-feed-pagination', async () => {
    const p1 = await call(ctx, 'discoveryFeed', ['films', 1], 15000);
    const p2 = await call(ctx, 'discoveryFeed', ['films', 2], 15000);
    assert(p1 && Array.isArray(p1.items) && p1.items.length > 0, 'no page 1');
    assert(p2 && Array.isArray(p2.items), 'no page 2');
    assert(p1.items.length <= 50 && p2.items.length <= 50, 'page over cap');
    const a = new Set(p1.items.map(x => x.href));
    assert(!p2.items.some(x => a.has(x.href)), 'pages overlap');
    assert(![...p1.items, ...p2.items].some(x => x.href === 'movie-1483325'), 'premium in feed');
    assert([...p1.items, ...p2.items].every(x => x.title && x.image), 'blank card in feed');
    rec('discovery-feed-pagination', 'PASS', `page1=${p1.items.length} hasMore=${p1.hasMore}; page2=${p2.items.length} hasMore=${p2.hasMore}`);
  });
  await check('discovery-invalid-feed', async () => {
    const f = await call(ctx, 'discoveryFeed', ['not-a-feed', 1], 15000);
    assert(f && Array.isArray(f.items) && f.items.length === 0 && f.hasMore === false, 'bad invalid feed');
    rec('discovery-invalid-feed', 'PASS', 'empty feed');
  });

  const pass = results.filter(x => x.status === 'PASS').length;
  const fail = results.filter(x => x.status === 'FAIL').length;
  console.log(`SUMMARY attempted=${results.length} pass=${pass} fail=${fail}`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error('HARNESS FAIL', e); process.exitCode = 2; });
