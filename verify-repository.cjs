#!/usr/bin/env node
/* Verify this repository's Synthetiq index before pushing.
 *
 * Usage: node verify-repository.cjs
 *
 * Checks, with no dependencies:
 *  - repository.json / catalogue.json parse and use the working schema;
 *  - no unsigned defaultModules block (the app rejects it);
 *  - module ids, identities and identity numbers are unique;
 *  - every packageUrl/packagePath pair is consistent;
 *  - local ZIPs exist and match their declared SHA-256;
 *  - module ZIPs are flat (module.json + index.js) and their manifest
 *    matches the index (id, version, identity, number, contentType);
 *  - the bundle contains exactly the module ZIPs listed in the index.
 *
 * It does not test playback, network routes or the Flutter runtime.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = __dirname;
let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log('PASS ' + message);
  } else {
    failures += 1;
    console.error('FAIL ' + message);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function localPathFrom(packagePath) {
  // "/owner/repo/branch/path/to/file" -> "path/to/file"
  const parts = String(packagePath).split('/').filter(Boolean);
  if (parts.length < 5) throw new Error('packagePath is too short: ' + packagePath);
  return parts.slice(3).join('/');
}

function zipEntries(buffer) {
  let eocd = -1;
  const stop = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= stop; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad ZIP central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipRead(buffer, entry) {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('bad ZIP local header');
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error('unsupported ZIP compression method ' + entry.method);
}

const index = readJson('repository.json');
const catalogue = readJson('catalogue.json');

check(index.schemaVersion === 1, 'schemaVersion is 1');
check(typeof index.repositoryId === 'string' && index.repositoryId.length > 0, 'repositoryId is set');
check(typeof index.name === 'string' && index.name.length > 0, 'name is set');
check(typeof index.enabled === 'boolean', 'enabled is a boolean');
check(Number.isFinite(index.publishedAtMs), 'publishedAtMs is a number');
check(Array.isArray(index.modules) && index.modules.length > 0, 'modules is a non-empty array');
check(typeof index.signature === 'string', 'index signature is a string (empty is allowed)');
check(!Object.prototype.hasOwnProperty.call(index, 'defaultModules'),
  'no defaultModules block (unsigned defaults are rejected by the app)');
check(!Object.prototype.hasOwnProperty.call(index, 'defaultModulesSignature'),
  'no defaultModulesSignature block');

check(index.bundle && typeof index.bundle === 'object', 'bundle block exists');
if (index.bundle) {
  check(Number.isInteger(index.bundle.version), 'bundle.version is an integer');
  check(typeof index.bundle.minAppVersion === 'string', 'bundle.minAppVersion is set');
  check(/^https:\/\//.test(index.bundle.packageUrl), 'bundle.packageUrl is HTTPS');
  check(typeof index.bundle.packagePath === 'string' && index.bundle.packagePath.startsWith('/'),
    'bundle.packagePath is absolute');
  check(/^[0-9a-f]{64}$/.test(index.bundle.sha256), 'bundle.sha256 is a lowercase SHA-256');
  check(typeof index.bundle.signature === 'string', 'bundle.signature is a string');
}

const ids = new Set();
const identities = new Set();
const numbers = new Set();
const expectedBundleEntries = new Set();

for (const module of index.modules) {
  const label = module.moduleId || '(missing moduleId)';
  check(typeof module.moduleId === 'string' && module.moduleId.length > 0, label + ': moduleId is set');
  check(!ids.has(module.moduleId), label + ': moduleId is unique');
  ids.add(module.moduleId);

  check(typeof module.moduleFamilyId === 'string' && module.moduleFamilyId.length > 0,
    label + ': moduleFamilyId is set');
  check(typeof module.moduleIdentity === 'string' && module.moduleIdentity.length > 0,
    label + ': moduleIdentity is set');
  check(!identities.has(module.moduleIdentity), label + ': moduleIdentity is unique');
  identities.add(module.moduleIdentity);

  check(Number.isInteger(module.moduleIdentityNumber) && module.moduleIdentityNumber > 0,
    label + ': moduleIdentityNumber is a positive integer');
  const numberKey = module.contentType + ':' + module.moduleIdentityNumber;
  check(!numbers.has(numberKey), label + ': identity number is unique for its contentType');
  numbers.add(numberKey);

  check(['video', 'image', 'text', 'music'].includes(module.contentType),
    label + ': contentType is valid');
  check(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(module.version), label + ': version is semver');
  check(module.minAppVersion === index.bundle?.minAppVersion,
    label + ': minAppVersion matches the bundle');
  check(typeof module.signature === 'string', label + ': signature is a string (empty is allowed)');

  const packageName = module.packagePath.split('/').pop();
  check(module.packageUrl.endsWith('/' + packageName), label + ': packageUrl and packagePath agree');
  check(packageName === path.basename(packageName), label + ': package file name is plain');

  let local;
  try {
    local = localPathFrom(module.packagePath);
  } catch (error) {
    check(false, label + ': ' + error.message);
    continue;
  }
  const absolute = path.join(root, local);
  check(fs.existsSync(absolute), label + ': local package exists at ' + local);
  if (!fs.existsSync(absolute)) continue;
  check(sha256(absolute) === module.sha256, label + ': SHA-256 matches ' + local);

  const buffer = fs.readFileSync(absolute);
  let entries;
  try {
    entries = zipEntries(buffer);
  } catch (error) {
    check(false, label + ': readable ZIP (' + error.message + ')');
    continue;
  }
  const names = [...entries.keys()];
  check(names.length === 2 && names.includes('module.json') && names.includes('index.js'),
    label + ': ZIP is flat (module.json + index.js), got [' + names.join(', ') + ']');
  if (!entries.has('module.json')) continue;
  const manifest = JSON.parse(zipRead(buffer, entries.get('module.json')).toString('utf8'));
  check(manifest.id === module.moduleId, label + ': manifest id matches the index');
  check(manifest.moduleVersion === module.version, label + ': manifest version matches the index');
  check(manifest.moduleIdentity === module.moduleIdentity, label + ': manifest identity matches the index');
  check(Number(manifest.moduleIdentityNumber) === module.moduleIdentityNumber,
    label + ': manifest identity number matches the index');
  check(manifest.contentType === module.contentType, label + ': manifest contentType matches the index');

  expectedBundleEntries.add(packageName);
}

if (index.bundle) {
  let bundleLocal;
  try {
    bundleLocal = localPathFrom(index.bundle.packagePath);
  } catch (error) {
    check(false, 'bundle: ' + error.message);
  }
  if (bundleLocal) {
    const absolute = path.join(root, bundleLocal);
    check(fs.existsSync(absolute), 'bundle: local file exists at ' + bundleLocal);
    if (fs.existsSync(absolute)) {
      check(sha256(absolute) === index.bundle.sha256, 'bundle: SHA-256 matches ' + bundleLocal);
      const entries = zipEntries(fs.readFileSync(absolute));
      const names = new Set(entries.keys());
      check(names.size === expectedBundleEntries.size,
        'bundle: entry count matches the module list (' + names.size + ')');
      for (const expected of expectedBundleEntries) {
        check(names.has(expected), 'bundle: contains ' + expected);
      }
    }
  }
}

check(Array.isArray(catalogue.modules) && catalogue.modules.length === index.modules.length,
  'catalogue: module count matches the index');
check(!Object.prototype.hasOwnProperty.call(catalogue, 'defaultModules'),
  'catalogue: no defaultModules block');

if (failures > 0) {
  console.error('\n' + failures + ' check(s) failed. Do not push until they are fixed.');
  process.exit(1);
}
console.log('\nAll index checks passed. Playback is still unverified.');
