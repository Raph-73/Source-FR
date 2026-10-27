#!/usr/bin/env node
/* local_runtime.cjs — a partial Node test harness for trusted Synthetiq modules
 * without the app. It mimics the behaviours that actually matter:
 *
 *   • fetchv2(url, headers, method, body, options) with status/headers/text()/json()
 *   • JSON responses arrive with an EMPTY text body and real data through json()
 *   • a per-module cookie jar (session/nonce flows work)
 *   • Referer/User-Agent you pass ARE sent (raw http/https transport, not fetch)
 *   • manual redirect following, so options.followRedirects:false behaves
 *   • NO setTimeout in the sandbox (the app has none — modules that need it must
 *     fail here, loudly)
 *
 * Usage:
 *   const { loadModule, call } = require('./local_runtime.cjs');
 *   const ctx = loadModule('/path/to/index.js');
 *   const results = await call(ctx, 'searchResults', ['matrix']);
 */
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const https = require('https');

function looksLikeJson(contentType, body) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json') || ct.includes('+json')) return true;
  const t = String(body || '').trim();
  if (!t) return false;
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function rawRequest(url, opts, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, opts.headers);
    if (opts.body != null) {
      const hasLen = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
      if (!hasLen) headers['Content-Length'] = Buffer.byteLength(opts.body);
    }
    const req = lib.request(u, { method: opts.method, headers }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('error', reject);
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > 5 * 1024 * 1024) {
          res.destroy(new Error('response exceeds local 5 MiB limit'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (opts.followRedirects !== false && status >= 300 && status < 400 && loc && redirectsLeft > 0) {
          let next;
          try { next = new URL(loc, url).toString(); } catch (e) { next = null; }
          if (next) {
            const nextHeaders = Object.assign({}, opts.headers);
            if (new URL(next).origin !== u.origin) {
              for (const key of Object.keys(nextHeaders)) {
                if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) delete nextHeaders[key];
              }
            }
            return resolve(rawRequest(next, { ...opts, headers: nextHeaders }, redirectsLeft - 1));
          }
        }
        resolve({ status, headers: res.headers, buf: Buffer.concat(chunks), finalUrl: url });
      });
    });
    req.on('error', reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('timeout after ' + opts.timeoutMs + 'ms')));
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function makeCookieJar() {
  const jar = new Map(); // host -> Map(name -> value)
  return {
    header(host) {
      const m = jar.get(host);
      if (!m || !m.size) return '';
      const out = [];
      m.forEach((v, k) => out.push(k + '=' + v));
      return out.join('; ');
    },
    absorb(host, setCookie) {
      if (!setCookie) return;
      const list = Array.isArray(setCookie) ? setCookie : [setCookie];
      let m = jar.get(host);
      if (!m) { m = new Map(); jar.set(host, m); }
      for (const raw of list) {
        const first = String(raw).split(';')[0];
        const eq = first.indexOf('=');
        if (eq > 0) m.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
      }
    },
  };
}

function makeFetchv2(cookieJar) {
  return async function fetchv2(url, headersIn = {}, method = 'GET', body = null, options = {}) {
    const u = new URL(url);
    const headers = {};
    Object.keys(headersIn || {}).forEach((k) => { headers[k] = String(headersIn[k]); });
    const cookie = cookieJar.header(u.hostname);
    if (cookie && !headers.Cookie && !headers.cookie) headers.Cookie = cookie;

    const res = await rawRequest(url, {
      method: method || 'GET',
      headers,
      body: body == null ? null : body,
      followRedirects: !(options && options.followRedirects === false),
      timeoutMs: (options && options.timeoutMs) || 30000,
    }, 5);

    cookieJar.absorb(new URL(res.finalUrl).hostname, res.headers['set-cookie']);
    const text = res.buf.toString('utf8');
    const headersOut = {};
    Object.keys(res.headers).forEach((k) => { headersOut[k.toLowerCase()] = res.headers[k]; });
    const contentType = headersOut['content-type'] || '';

    if (looksLikeJson(contentType, text)) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) {}
      // app behaviour, exactly: only VALID JSON takes the empty-body path;
      // anything else (e.g. XSSI-framed `)]}'` responses) stays readable as text
      if (parsed != null) {
        return { ok: res.status >= 200 && res.status < 300, status: res.status, headers: headersOut, body: '', text: async () => '', json: async () => parsed };
      }
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: headersOut,
      body: text,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
}

function loadModule(jsPathOrCode, opts = {}) {
  const code = fs.existsSync(jsPathOrCode) ? fs.readFileSync(jsPathOrCode, 'utf8') : String(jsPathOrCode);
  const jar = makeCookieJar();
  const sandbox = {
    console: {
      log: (...a) => opts.verbose !== false && console.error('[module]', ...a),
      warn: (...a) => opts.verbose !== false && console.error('[module:warn]', ...a),
      error: (...a) => console.error('[module:err]', ...a),
    },
    globalThis: {},
  };
  sandbox.globalThis.fetchv2 = makeFetchv2(jar);
  const ctx = vm.createContext(sandbox);
  vm.runInContext('var fetchv2 = globalThis.fetchv2;', ctx);
  vm.runInContext(code, ctx, { filename: 'module.js', timeout: 5000 });
  return ctx;
}

/* Run a module function and get a plain, host-realm copy of its result. */
async function call(ctx, fnName, args = [], timeoutMs = 90000) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fnName)) throw new Error('Invalid handler name');
  const expr = `(async () => {
    try {
      if (typeof globalThis.${fnName} !== 'function') return JSON.stringify({ __error: 'not exported' });
      const out = await globalThis.${fnName}.apply(null, ${JSON.stringify(args)});
      return JSON.stringify({ __ok: out === undefined ? null : out });
    } catch (e) {
      return JSON.stringify({ __error: String(e && e.message ? e.message : e) });
    }
  })()`;
  let timer;
  let raw;
  try {
    raw = await Promise.race([
      vm.runInContext(expr, ctx, { timeout: timeoutMs }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('host timeout after ' + timeoutMs + 'ms')), timeoutMs + 500); }),
    ]);
  } finally { clearTimeout(timer); }
  const parsed = JSON.parse(raw);
  if (parsed && parsed.__error) throw new Error(parsed.__error);
  return parsed.__ok;
}

module.exports = { loadModule, call, makeFetchv2, makeCookieJar };
