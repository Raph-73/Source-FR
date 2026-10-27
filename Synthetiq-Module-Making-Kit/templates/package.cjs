#!/usr/bin/env node
/* Package a module folder into a flat, installable ZIP.
 *
 * Usage:
 *   node templates/package.cjs --dir /path/to/MyModule --version 1.0.0
 *        [--identity SP-VID-000-MYMODULE] [--number 0] [--icon https://…/icon.png]
 *        [--name MyModule]
 *
 * The folder must contain `module.json` (the manifest, with fields as you want
 * them) and `index.js`. If the manifest carries {{PLACEHOLDERS}} they are filled
 * from the CLI flags. Output: <dir>/dist/<Name>-<version>.zip + .sha256
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zip } = require('../tools/zip.cjs');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => { if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1]; });
const dir = path.resolve(args.dir || '.');
const version = args.version || '0.0.0-dev';
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) fail('version must be a semantic version');
const identity = args.identity || 'PENDING-OWNER-ALLOCATION';
const number = String(args.number || '0');
const icon = args.icon || '';

const manifestPath = path.join(dir, 'module.json');
const jsPath = path.join(dir, 'index.js');
if (!fs.existsSync(manifestPath)) fail('module.json not found in ' + dir);
if (!fs.existsSync(jsPath)) fail('index.js not found in ' + dir);

let manifest = fs.readFileSync(manifestPath, 'utf8');
manifest = manifest
  .replace(/\{\{VERSION\}\}/g, version)
  .replace(/\{\{IDENTITY\}\}/g, identity)
  .replace(/\{\{IDENTITY_NUMBER\}\}/g, number)
  .replace(/\{\{ICON_URL\}\}/g, icon)
  .replace(/\{\{NAME\}\}/g, args.name || '');
const obj = JSON.parse(manifest);
obj.moduleVersion = version;
if (args.identity) obj.moduleIdentity = args.identity;
if (args.number) obj.moduleIdentityNumber = Number(args.number);
if (obj.moduleIdentity === '{{IDENTITY}}' || !obj.moduleIdentity) obj.moduleIdentity = identity;
if (String(obj.moduleIdentityNumber) === '{{IDENTITY_NUMBER}}') obj.moduleIdentityNumber = Number(number);
if (icon && obj.presentation) obj.presentation.iconUrl = icon;
if (icon && obj.config && obj.config.presentation) obj.config.presentation.iconUrl = icon;
validate(obj);
const finalManifest = JSON.stringify(obj, null, 2) + '\n';

const stage = path.join(dir, 'dist', 'stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'module.json'), finalManifest);
fs.copyFileSync(jsPath, path.join(stage, 'index.js'));

const name = (obj.name || obj.id || 'Module').replace(/[^A-Za-z0-9._-]+/g, '');
const zipName = name + '-' + version + '.zip';
const zipPath = path.join(dir, 'dist', zipName);
fs.mkdirSync(path.dirname(zipPath), { recursive: true });
fs.rmSync(zipPath, { force: true });
fs.writeFileSync(zipPath, zip({ 'module.json': finalManifest, 'index.js': fs.readFileSync(jsPath) }));

const sha = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
fs.writeFileSync(zipPath + '.sha256', sha + '  ' + zipName + '\n');
console.log('ZIP:    ' + zipPath);
console.log('SHA256: ' + sha);
console.log('id=' + obj.id + '  version=' + version + '  identity=' + obj.moduleIdentity + '  type=' + obj.contentType);

function validate(m) {
  const problems = [];
  if (!m.id || !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) problems.push('id must be lowercase-hyphenated');
  if (m.contentType !== 'video' && m.contentType !== 'image') problems.push('contentType must be video or image');
  if (Number(m.contractVersion) !== 4) problems.push('contractVersion should be 4');
  if (!m.moduleVersion) problems.push('moduleVersion missing');
  const caps = (m.config && m.config.caps) || {};
  const hc = Number(caps.homeMaxResults);
  if (!(hc >= 1 && hc <= 120)) problems.push('config.caps.homeMaxResults must be 1-120 (got ' + caps.homeMaxResults + ')');
  const rt = String((m.config && m.config.runtime && m.config.runtime.mode) || '');
  if (rt !== 'local') problems.push('config.runtime.mode must be "local"');
  if (!m.moduleIdentity) problems.push('moduleIdentity missing');
  if (!m.moduleFamilyId) problems.push('moduleFamilyId missing');
  if (!Number.isInteger(m.moduleIdentityNumber) || m.moduleIdentityNumber < 0) problems.push('moduleIdentityNumber must be a nonnegative integer');
  if (!['stable', 'beta', 'nightly'].includes(m.releaseTrack)) problems.push('invalid releaseTrack');
  if (m.config?.runtime?.entry !== 'index.js' || m.config?.runtime?.scriptUrl) problems.push('this packager requires local index.js');
  if (JSON.stringify(m).includes('{{')) problems.push('unresolved placeholders');
  if (/\.test(?:\/|"|$)/.test(JSON.stringify(m))) problems.push('replace example .test domains before packaging');
  if (m.releaseTrack === 'stable' && (m.moduleIdentityNumber === 0 || m.moduleIdentity === 'PENDING-OWNER-ALLOCATION')) problems.push('stable release needs owner-allocated identity');
  if (m.moduleIdentityNumber === 0) console.warn('DEVELOPMENT IDENTITY: not approved for public release; app import compatibility still needs testing.');
  if (problems.length) fail('manifest problems:\n - ' + problems.join('\n - '));
}

function fail(msg) { console.error('package.cjs: ' + msg); process.exit(1); }
