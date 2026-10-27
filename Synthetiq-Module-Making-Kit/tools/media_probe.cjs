// Structural sampling only: this does not prove decode, language or playback.
const LIMIT = 256 * 1024;
async function readPrefix(url, headers = {}, fetchImpl = fetch, depth = 0) {
  if (depth > 5) throw new Error('Too many redirects');
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only HTTP(S) media supported');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let reader;
  try {
    const res = await fetchImpl(url, { headers: { ...headers, Range: `bytes=0-${LIMIT - 1}` }, redirect: 'manual', signal: ac.signal });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('Redirect without location');
      const next = new URL(loc, url), h = { ...headers };
      if (next.origin !== u.origin) for (const k of Object.keys(h)) if (/^(cookie|authorization|proxy-authorization)$/i.test(k)) delete h[k];
      await res.body?.cancel();
      return await readPrefix(next.href, h, fetchImpl, depth + 1);
    }
    if (![200, 206].includes(res.status)) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('Empty body');
    reader = res.body.getReader();
    const chunks = []; let size = 0;
    while (size < LIMIT) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = Buffer.from(value).subarray(0, LIMIT - size);
      chunks.push(part); size += part.length;
    }
    return { bytes: Buffer.concat(chunks), url };
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    clearTimeout(timer); ac.abort();
  }
}
function kind(b) {
  if (b.length >= 12 && ['ftyp', 'styp', 'moof'].includes(b.toString('ascii', 4, 8))) return 'iso-media';
  if (b.length >= 377 && b[0] === 71 && b[188] === 71 && b[376] === 71) return 'mpeg-ts';
  if (b.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm-or-matroska';
  if (b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image';
  if (/^GIF8[79]a/.test(b.toString('ascii', 0, 6))) return 'image';
  return 'unknown';
}
async function probe(url, headers = {}, type = 'video', fetchImpl = fetch, depth = 0) {
  if (depth > 3) throw new Error('HLS nesting limit reached');
  const r = await readPrefix(url, headers, fetchImpl);
  const text = r.bytes.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (type === 'image') {
    if (kind(r.bytes) !== 'image') throw new Error('Image signature missing');
    return `image signature, ${r.bytes.length} sampled bytes`;
  }
  if (text.startsWith('#EXTM3U')) {
    if (r.bytes.length === LIMIT) throw new Error('Playlist exceeds bounded check');
    if (/#EXT-X-KEY:.*METHOD=(?!NONE)/.test(text)) throw new Error('Encrypted HLS needs separate authorized decode testing');
    if (/#EXT-X-BYTERANGE|#EXT-X-MAP:/.test(text)) throw new Error('HLS ranges/init maps need full app or S2 testing');
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    let child;
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^#EXT-X-STREAM-INF:|^#EXTINF:/.test(lines[i])) { child = lines.slice(i + 1).find(s => !s.startsWith('#')); if (child) break; }
    }
    if (!child) throw new Error('Playlist has no media or variant URI');
    return 'HLS sampled one route: ' + await probe(new URL(child, r.url).href, headers, 'video', fetchImpl, depth + 1);
  }
  const format = kind(r.bytes);
  if (!['iso-media', 'mpeg-ts', 'webm-or-matroska'].includes(format)) throw new Error('Video container signature missing; MIME alone is insufficient');
  return `${format} signature, ${r.bytes.length} sampled bytes; decode unverified`;
}
function candidates(result) {
  if (typeof result === 'string') return [{ url: result, headers: {} }];
  if (!result || typeof result !== 'object') return [];
  const out = [];
  const add = c => { if (typeof c?.url === 'string') out.push({ url: c.url, headers: { ...(result.headers || {}), ...(c.headers || {}) } }); };
  add(result);
  const streams = result.streams || [];
  if (streams.every(s => typeof s === 'string')) {
    if (streams.length % 2) throw new Error('streams must be label/URL pairs');
    for (let i = 1; i < streams.length; i += 2) add({ url: streams[i] });
  } else for (const c of streams) add(c);
  return out.filter((c, i) => out.findIndex(x => x.url === c.url && JSON.stringify(x.headers) === JSON.stringify(c.headers)) === i);
}
module.exports = { readPrefix, kind, probe, candidates, LIMIT };
