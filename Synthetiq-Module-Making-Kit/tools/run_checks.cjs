#!/usr/bin/env node
// Reviewed code only. Node vm is not a security boundary.
const fs = require('node:fs'), path = require('node:path');
const { loadModule, call } = require('./local_runtime.cjs');
const { candidates, probe } = require('./media_probe.cjs');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
async function main() {
  if (!args[0] || args[0].startsWith('--')) throw new Error('Usage: node tools/run_checks.cjs MyModule --query Title [--result 1] [--ep 1] [--lang sub]');
  const dir = path.resolve(args[0]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'));
  if (!['video', 'image'].includes(m.contentType)) throw new Error('Checker supports video and image only');
  const ctx = loadModule(path.join(dir, 'index.js'), { verbose: false });
  const check = (condition, text) => { if (!condition) throw new Error(text); console.log('PASS ' + text); };
  const raw = await call(ctx, 'searchResults', [flag('query', ''), 0], 15000);
  const cards = Array.isArray(raw) ? raw : raw?.items;
  check(Array.isArray(cards) && cards.length > 0, 'search cards');
  const index = Number(flag('result', '1'));
  check(Number.isInteger(index) && index > 0 && index <= cards.length, 'requested search-result index exists');
  const card = cards[index - 1];
  check(card.title && (card.href || card.id), 'card title and identity');
  console.log('Selected title: ' + card.title + '. Confirm this is the intended title.');
  const id = card.href || card.id;
  const details = await call(ctx, 'extractDetails', [id], 15000);
  check(details?.title, 'details title');
  if (m.config?.capabilities?.discovery_v1) {
    const home = await call(ctx, 'discoveryHome', [], 8000);
    check(Array.isArray(home?.sections) && home.sections.length > 0 && home.sections.length <= 12, 'discovery sections');
    const section = home.sections.find(s => s.viewAll?.mode === 'feed');
    if (section) {
      const feed = await call(ctx, 'discoveryFeed', [section.viewAll.feedId, 1], 10000);
      check(Array.isArray(feed?.items) && feed.items.length <= 50 && typeof feed.hasMore === 'boolean', 'discovery feed page 1');
    }
  }
  const list = await call(ctx, m.contentType === 'image' ? 'extractChapters' : 'extractEpisodes', [id], 15000);
  check(Array.isArray(list) && list.length > 0, 'episode/chapter list');
  const ordinal = Number(flag('ep', '1'));
  check(Number.isInteger(ordinal) && ordinal > 0 && ordinal <= list.length, 'requested list position exists');
  const entry = list[ordinal - 1];
  check(entry.href, 'episode/chapter identity');
  console.log('Selected position ' + ordinal + ', number ' + entry.number + ', season ' + (entry.season ?? '?'));
  if (m.contentType === 'image') {
    const images = await call(ctx, 'extractImages', [entry.href], 20000);
    check(Array.isArray(images) && images.length > 0, 'image list');
    for (const url of [...new Set([images[0], images.at(-1)])]) console.log('PASS ' + await probe(url, m.config?.streamHeaders || {}, 'image'));
  } else {
    const routes = candidates(await call(ctx, 'extractStreamUrl', [entry.href, flag('lang', 'sub')], 20000));
    check(routes.length > 0, 'stream candidates');
    if (routes.length > 8) throw new Error('More than 8 routes: split into bounded tests');
    let failures = 0;
    for (let i = 0; i < routes.length; i++) {
      try { console.log(`PASS route ${i + 1}: ` + await probe(routes[i].url, routes[i].headers)); }
      catch (e) { failures++; console.error(`FAIL route ${i + 1}: ${e.message}`); }
    }
    check(failures === 0, `${routes.length - failures}/${routes.length} sampled routes passed`);
  }
  console.log('LOCAL CHECKS PASSED. Device playback, full content, language and downloads remain unverified.');
}
main().catch(e => {
  console.error('CHECK FAILED: ' + String(e.message).replace(/https?:\/\/\S+/g, '[address redacted]'));
  process.exitCode = 1;
});
