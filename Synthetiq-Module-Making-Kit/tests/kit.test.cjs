const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { kind, probe, readPrefix, candidates, LIMIT } = require('../tools/media_probe.cjs');
const { crc32, zip } = require('../tools/zip.cjs');
const { loadModule, call } = require('../tools/local_runtime.cjs');
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
const ts = Buffer.alloc(564); ts[0] = ts[188] = ts[376] = 71;
const fakeFetch = routes => async url => new Response(routes[new URL(url).pathname] ?? 'missing', { status: 200 });

test('MP4 signature, not MIME alone', () => {
  assert.equal(kind(mp4), 'iso-media'); assert.equal(kind(Buffer.from('<html>oops</html>')), 'unknown');
});
test('HLS relative variant and segment', async () => {
  const fetcher = fakeFetch({ '/master': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild/list\n', '/child/list': '#EXTM3U\n#EXTINF:4,\nseg\n', '/child/seg': ts });
  assert.match(await probe('https://test.invalid/master', {}, 'video', fetcher), /mpeg-ts/);
});
test('reject image-only HLS', async () => {
  const fetcher = fakeFetch({ '/list': '#EXTM3U\n#EXTINF:4,\nimage\n', '/image': Buffer.from('89504e470d0a1a0a', 'hex') });
  await assert.rejects(probe('https://test.invalid/list', {}, 'video', fetcher), /signature missing/);
});
test('reject HTML and octet-stream garbage', async () => {
  await assert.rejects(probe('https://test.invalid/file', {}, 'video', fakeFetch({ '/file': '<html>error</html>' })), /signature missing/);
});
test('cap server response even when Range is ignored', async () => {
  const result = await readPrefix('https://test.invalid/file', {}, fakeFetch({ '/file': Buffer.alloc(LIMIT * 2) }));
  assert.equal(result.bytes.length, LIMIT);
});
test('image signature accepted only in image path', async () => {
  assert.match(await probe('https://test.invalid/image', {}, 'image', fakeFetch({ '/image': Buffer.from('89504e470d0a1a0a', 'hex') })), /image signature/);
});
test('encrypted HLS explicitly unsupported', async () => {
  await assert.rejects(probe('https://test.invalid/a', {}, 'video', fakeFetch({ '/a': '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:4,\nx' })), /Encrypted HLS/);
});
test('cross-origin redirect strips secret headers', async () => {
  const seen = [];
  const fetcher = async (url, opts) => { seen.push(opts.headers); return seen.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://other.invalid/file' } }) : new Response(mp4); };
  await readPrefix('https://test.invalid/file', { Authorization: 'private', Cookie: 'private' }, fetcher);
  assert.equal(seen[1].Authorization, undefined); assert.equal(seen[1].Cookie, undefined);
});
test('normalizes stream shapes and keeps headers', () => {
  assert.equal(candidates('https://x.invalid/a').length, 1);
  assert.equal(candidates({ streams: ['720p', 'https://x.invalid/a'], headers: { Referer: 'test' } })[0].headers.Referer, 'test');
  assert.equal(candidates({ streams: [{ url: 'https://x.invalid/a', headers: { Referer: 'own' } }], headers: { Referer: 'base' } })[0].headers.Referer, 'own');
  assert.throws(() => candidates({ streams: ['broken'] }), /pairs/);
});
test('VM handler and safe name validation', async () => {
  const ctx = loadModule('globalThis.searchResults = async function(){return [{title:"Test",href:"1"}]};');
  assert.equal((await call(ctx, 'searchResults'))[0].title, 'Test');
  await assert.rejects(call(ctx, 'bad-name'), /Invalid handler/);
  await assert.rejects(call(ctx, 'missing'), /not exported/);
});
test('ZIP CRC and flat filenames', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(zip({ 'index.js': 'x' }).readUInt32LE(0), 0x04034b50);
  assert.throws(() => zip({ '../escape': 'x' }), /safe filenames/);
});
test('portable package and stable identity guard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-kit-'));
  try {
    const manifest = { id: 'workshop-demo', name: 'Workshop Demo', moduleFamilyId: 'workshop-demo', moduleIdentity: 'PENDING-OWNER-ALLOCATION', moduleIdentityNumber: 0, contentType: 'video', contractVersion: 4, releaseTrack: 'beta', config: { runtime: { mode: 'local', entry: 'index.js' }, caps: { homeMaxResults: 30 } } };
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.js'), '// fixture only');
    const cmd = path.resolve(__dirname, '../templates/package.cjs');
    assert.equal(spawnSync(process.execPath, [cmd, '--dir', dir, '--version', '1.0.0-beta.1']).status, 0);
    assert.ok(fs.existsSync(path.join(dir, 'dist/WorkshopDemo-1.0.0-beta.1.zip')));
    manifest.releaseTrack = 'stable'; fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest));
    assert.notEqual(spawnSync(process.execPath, [cmd, '--dir', dir, '--version', '1.0.0']).status, 0);
    assert.notEqual(spawnSync(process.execPath, [cmd, '--dir', dir, '--version', '../escape']).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('complete checker flow with local HTTP fixture', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/media') { res.end(mp4); return; }
    if (req.url === '/image') { res.end(Buffer.from('89504e470d0a1a0a', 'hex')); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{ title: 'Workshop fixture', href: 'fixture' }]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-flow-'));
  const script = path.resolve(__dirname, '../tools/run_checks.cjs');
  const run = extra => new Promise(resolve => {
    const child = spawn(process.execPath, [script, dir, '--query', 'Workshop fixture', ...extra]);
    let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
    child.on('close', code => resolve({ code, output }));
  });
  try {
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({ contentType: 'video', config: {} }));
    fs.writeFileSync(path.join(dir, 'index.js'), `
      globalThis.searchResults = async function() { return await (await fetchv2('${base}/catalogue')).json(); };
      globalThis.extractDetails = async function() { return { title: 'Workshop fixture' }; };
      globalThis.extractEpisodes = async function() { return [{number:1, href:'episode'}]; };
      globalThis.extractStreamUrl = async function() { return { streams: ['Auto', '${base}/media'] }; };
    `);
    await t.test('video stream-pair route passes structural checks', async () => {
      const r = await run([]); assert.equal(r.code, 0, r.output); assert.match(r.output, /decode unverified/);
    });
    await t.test('missing list position fails rather than choosing last episode', async () => {
      const r = await run(['--ep', '99']); assert.equal(r.code, 1); assert.match(r.output, /position exists/);
    });
    await t.test('missing search result fails', async () => assert.equal((await run(['--result', '99'])).code, 1));
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({ contentType: 'image', config: {} }));
    fs.appendFileSync(path.join(dir, 'index.js'), `
      globalThis.extractChapters = async function() { return [{number:1,href:'chapter'}]; };
      globalThis.extractImages = async function() { return ['${base}/image']; };
    `);
    await t.test('manga image flow passes structural checks', async () => {
      const r = await run([]); assert.equal(r.code, 0, r.output); assert.match(r.output, /image signature/);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
