#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const KIT = path.resolve(__dirname, '..', '..');
const MODULE = path.resolve(__dirname, '..');
const { loadModule } = require(path.join(KIT, 'tools', 'local_runtime.cjs'));

let src = fs.readFileSync(path.join(MODULE, 'index.js'), 'utf8');
const needle = '  globalThis.discoveryFeed = discoveryFeed;\n})();';
if (!src.includes(needle)) throw new Error('export block not found');
src = src.replace(needle, `  globalThis.discoveryFeed = discoveryFeed;
  globalThis.__novaTest = {
    parseMaster: parseMaster, packHls: packHls,
    validateMediaPlaylist: validateMediaPlaylist,
    verifySourceTitle: verifySourceTitle, titleMatches: titleMatches,
    sourceYear: sourceYear, episodeMarker: episodeMarker,
    isPremium: isPremium, uqloadIdFromUrl: uqloadIdFromUrl,
    packHlsResult: packHls, titleFromHtml: titleFromHtml
  };
})();`);
const ctx = loadModule(src, { verbose: false });
const t = ctx.globalThis.__novaTest;
const results = [];
function ok(name, fn) {
  try { fn(); results.push({name, status:'PASS'}); console.log('PASS ' + name); }
  catch (e) { results.push({name, status:'FAIL', detail:e.message}); console.log('FAIL ' + name + ' :: ' + e.message); }
}
function eq(a,b,msg){ if (a!==b) throw new Error((msg||'') + ' expected=' + b + ' got=' + a); }
function throwsNot(fn,msg){ if (fn()) throw new Error(msg||'expected rejection'); }

ok('uqload-id-html', () => eq(t.uqloadIdFromUrl('https://uqload.vc/99h5okf8a17a.html'), '99h5okf8a17a'));
ok('uqload-id-signed', () => eq(t.uqloadIdFromUrl('https://strm14.uqload.vc/hls2/01/06044/bvccd1h15sa3_n/index-v1-a1.m3u8?t=x'), 'bvccd1h15sa3'));
ok('uqload-id-rejects-host', () => eq(t.uqloadIdFromUrl('https://vidzy.org/embed-7mpbajnl8w4i.html'), ''));

ok('master-parses-and-resolves', () => {
  const m = ['#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
    'v/720.m3u8?x=1',
    '#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1920x1040',
    'https://strm1.uqload.vc/a/v/1040.m3u8'].join('\n');
  const v = t.parseMaster(m, 'https://strm1.uqload.vc/a/master.m3u8');
  eq(v.length, 2);
  eq(v[0].height, 720); eq(v[0].url, 'https://strm1.uqload.vc/a/v/720.m3u8?x=1');
  eq(v[1].height, 1040); eq(v[1].bandwidth, 2200000);
});
ok('quality-pack-sorts-highest-first', () => {
  const p = t.packHls([
    {url:'https://strm1.uqload.vc/360.m3u8',height:360,bandwidth:400000},
    {url:'https://strm1.uqload.vc/720.m3u8',height:720,bandwidth:800000},
    {url:'https://strm1.uqload.vc/1040.m3u8',height:1040,bandwidth:2200000}
  ]);
  eq(p.quality, '1040p'); eq(p.defaultQuality, '1040p');
  eq(p.qualities.length, 3); eq(p.qualities[0].label, 'dub 1040p');
  eq(p.qualities[2].label, 'dub 360p');
  eq(p.streams[0], 'dub 1040p'); eq(p.streams[1], 'https://strm1.uqload.vc/1040.m3u8');
  eq(p.streamType, 'hls'); eq(p.lang, 'dub');
});
ok('media-playlist-valid', () => {
  eq(t.validateMediaPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n'), true);
  eq(t.validateMediaPlaylist('#EXTM3U\n#EXTINF:6.0,\nseg1.ts\n'), true);
});
ok('media-playlist-rejects-encryption', () =>
  eq(t.validateMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\ns.ts\n'), false));
ok('media-playlist-rejects-map', () =>
  eq(t.validateMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:6,\ns.m4s\n'), false));
ok('media-playlist-rejects-byterange', () =>
  eq(t.validateMediaPlaylist('#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:100@0\ns.ts\n'), false));
ok('media-playlist-rejects-image', () =>
  eq(t.validateMediaPlaylist('#EXTM3U\n#EXTINF:6,\nplaceholder.jpg\n'), false));

ok('source-title-strips-prefix', () => eq(t.titleFromHtml('<title>Watch Boite Noire 2021 FRENCH 1080p</title>'), 'Boite Noire 2021 FRENCH 1080p'));
ok('source-year-reliable-tag', () => eq(t.sourceYear('Boite Noire 2021 FRENCH 1080p'), 2021));
ok('source-year-unreliable-trailing', () => eq(t.sourceYear('Buddy 2024'), 0));
ok('episode-marker', () => { const m=t.episodeMarker('Vikings S01E06'); eq(m.season,1); eq(m.episode,6); });

const kingdom = { title: 'La Planète des singes : Le Nouveau Royaume', originalTitle: 'Kingdom of the Planet of the Apes', year: '2024' };
const buddy = { title: 'Buddy', originalTitle: 'Buddy', year: '2026' };
const truc = { title: "Un p'tit truc en plus", originalTitle: "Un p'tit truc en plus", year: '2024' };
const figures = { title: "Les Figures de l'ombre", originalTitle: 'Hidden Figures', year: '2016' };
const correspondent = { title: 'The Correspondent', originalTitle: 'The Correspondent', year: '2025' };
ok('title-match-kingdom', () => eq(t.verifySourceTitle(kingdom, 'Kingdom The The Apes 2024', null).ok, true));
ok('title-match-buddy-2y', () => eq(t.verifySourceTitle(buddy, 'Buddy 2024 VFF 1080p', null).ok, true));
ok('title-match-truc', () => eq(t.verifySourceTitle(truc, 'P tit Truc En Plus 2024 FRENCH', null).ok, true));
ok('title-block-episode-source', () => eq(t.verifySourceTitle(figures, 'Vikings S01E06', null).reason, 'episode-source-for-film'));
ok('title-block-mismatch', () => eq(t.verifySourceTitle(correspondent, 'Course Sprint Pays Bas 2026', null).reason, 'title-mismatch'));
ok('title-block-vostfr', () => eq(t.verifySourceTitle(kingdom, 'Kingdom The The Apes 2024 VOSTFR', null).reason, 'vostfr'));
ok('episode-match', () => eq(t.verifySourceTitle({title:'Vikings', originalTitle:'Vikings', year:'2013'}, 'Vikings S01E01 1080p', {season:1,episode:1}).ok, true));
ok('episode-block', () => eq(t.verifySourceTitle({title:'Vikings', originalTitle:'Vikings', year:'2013'}, 'Vikings S01E02 1080p', {season:1,episode:1}).reason, 'episode-mismatch'));

ok('premium-future', () => eq(t.isPremium({premiumUntil:'2099-01-01T00:00:00Z'}), true));
ok('premium-expired', () => eq(t.isPremium({premiumUntil:'2020-01-01T00:00:00Z'}), false));
ok('premium-flag', () => eq(t.isPremium({premium:true}), true));
ok('premium-past-flag-false', () => eq(t.isPremium({premium:false,premiumUntil:'2020-01-01 00:00:00'}), false));

const pass = results.filter(x=>x.status==='PASS').length;
const fail = results.filter(x=>x.status==='FAIL').length;
console.log(`SUMMARY attempted=${results.length} pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
