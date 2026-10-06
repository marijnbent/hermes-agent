#!/usr/bin/env node
/** Publish a text Status through Molletje's explicitly enabled local bridge. */
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }
function fail(message) { console.error(message); process.exit(2); }
const bridge = arg('bridge') || 'http://127.0.0.1:3001';
let url; try { url = new URL('/status', bridge); } catch { fail('bridge must be a valid URL'); }
if (url.origin !== 'http://127.0.0.1:3001' || url.username || url.password) fail('bridge must target Molletje at http://127.0.0.1:3001');
const audience = arg('audience'); const text = arg('text'); const idempotencyKey = arg('key');
if (!audience || text === undefined || !idempotencyKey) fail('usage: --audience JID[,JID] --text TEXT --key UNIQUE_KEY [--bridge http://127.0.0.1:3001] [--background #RRGGBB] [--font 0..5]');
const audiences = audience.split(',').map((item) => item.trim());
if (!audiences.length || audiences.some((jid) => !/^\d{5,20}@s\.whatsapp\.net$/.test(jid))) fail('audience must contain contact JIDs only (number@s.whatsapp.net)');
if (text.length < 1 || text.length > 4096) fail('text must be between 1 and 4096 characters');
if (idempotencyKey.length < 1 || idempotencyKey.length > 200) fail('key must be between 1 and 200 characters');
const style = {}; const background = arg('background'); const font = arg('font');
if (background !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(background)) fail('background must be #RRGGBB'); style.backgroundColor = background; }
if (font !== undefined) { if (!/^\d+$/.test(font) || Number(font) > 5) fail('font must be an integer from 0 to 5'); style.font = Number(font); }
try {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, audience: audiences, idempotencyKey, style }) });
  const body = await response.json(); console.log(JSON.stringify(body)); process.exit(response.ok ? 0 : 1);
} catch (error) { console.error(`bridge request failed: ${error.message}`); process.exit(1); }
