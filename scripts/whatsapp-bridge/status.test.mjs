import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStatusRouter, validateStatusRequest } from './status.js';

test('validates explicit audience and preserves exact text/style', () => {
  const input = { text: 'literal * text\n', audience: ['31612345678@s.whatsapp.net'], style: { backgroundColor: '#112233', font: 2 }, idempotencyKey: 'k1' };
  assert.deepEqual(validateStatusRequest(input), { ...input });
});

test('rejects missing, unsafe, or invalid status inputs', () => {
  for (const input of [{ text: 'x' }, { text: '', audience: ['1@s.whatsapp.net'] }, { text: 'x', audience: [] }, { text: 'x', audience: ['all'] }, { text: 'x', audience: ['1@s.whatsapp.net'], style: { font: 9 } }]) {
    assert.throws(() => validateStatusRequest(input), /status|audience|font|text/i);
  }
});

test('publishes once per idempotency key and returns provider id', async () => {
  const calls = [];
  const router = createStatusRouter({
    isEnabled: () => true,
    isConnected: () => true,
    sendStatus: async (...args) => { calls.push(args); return { key: { id: 'status-1' } }; },
  });
  const response = await router.publish({ text: 'exact', audience: ['31612345678@s.whatsapp.net'], idempotencyKey: 'same' });
  const repeated = await router.publish({ text: 'exact', audience: ['31612345678@s.whatsapp.net'], idempotencyKey: 'same' });
  assert.equal(response.status, 200);
  assert.equal(response.body.messageId, 'status-1');
  assert.equal(repeated.body.deduplicated, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['status@broadcast', { text: 'exact' }, { statusJidList: ['31612345678@s.whatsapp.net'] }]);
});

test('marks timeout outcome uncertain and never retries the same key', async () => {
  let calls = 0;
  const router = createStatusRouter({ isEnabled: () => true, isConnected: () => true, sendStatus: async () => { calls += 1; throw new Error('sendMessage timed out after 1s'); } });
  const request = { text: 'x', audience: ['31612345678@s.whatsapp.net'], idempotencyKey: 'timeout' };
  const response = await router.publish(request);
  const repeated = await router.publish(request);
  assert.equal(response.status, 504);
  assert.equal(response.body.outcome, 'uncertain');
  assert.equal(repeated.status, 504);
  assert.equal(repeated.body.deduplicated, true);
  assert.equal(calls, 1);
});

test('offline Baileys serialization accepts status payload', async () => {
  const { generateWAMessage } = await import('@whiskeysockets/baileys');
  const msg = await generateWAMessage('status@broadcast', { text: 'exact' }, { backgroundColor: '#112233', font: 2, userJid: '31612345678@s.whatsapp.net' });
  assert.equal(msg.key.remoteJid, 'status@broadcast');
  assert.equal(msg.message.extendedTextMessage.text, 'exact');
});

test('archive bridge fails closed when status publishing is disabled', async () => {
  const router = createStatusRouter({ isConnected: () => true, sendStatus: async () => ({ key: { id: 'must-not-send' } }) });
  const response = await router.publish({ text: 'no publish', audience: ['31612345678@s.whatsapp.net'], idempotencyKey: 'archive-disabled' });
  assert.equal(response.status, 404);
  assert.match(response.body.error, /disabled/i);
});

test('does not resend a pending record recovered after a crash', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'status-'));
  const journalPath = path.join(dir, 'journal.jsonl');
  const digest = createHash('sha256').update(JSON.stringify({ text: 'x', audience: ['31612345678@s.whatsapp.net'], style: {} })).digest('hex');
  writeFileSync(journalPath, JSON.stringify({ key: 'crashed', digest, outcome: 'pending' }) + '\n');
  let calls = 0;
  const router = createStatusRouter({ journalPath, isEnabled: () => true, isConnected: () => true, sendStatus: async () => { calls += 1; return { key: { id: 'bad' } }; } });
  const response = await router.publish({ text: 'x', audience: ['31612345678@s.whatsapp.net'], idempotencyKey: 'crashed' });
  assert.equal(response.status, 504);
  assert.equal(response.body.outcome, 'uncertain');
  assert.equal(calls, 0);
});

test('rejects a payload conflict even while the original key is in flight', async () => {
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  const router = createStatusRouter({ isEnabled: () => true, isConnected: () => true, sendStatus: async () => { await started; return { key: { id: 'one' } }; } });
  const first = router.publish({ text: 'one', audience: ['31612345678@s.whatsapp.net'], idempotencyKey: 'same' });
  await new Promise((resolve) => setImmediate(resolve));
  const conflict = await router.publish({ text: 'two', audience: ['31612345678@s.whatsapp.net'], idempotencyKey: 'same' });
  assert.equal(conflict.status, 409);
  release();
  await first;
});

test('bounds in-memory records without allowing a recent status to resend', async () => {
  let calls = 0;
  const router = createStatusRouter({ isEnabled: () => true, isConnected: () => true, sendStatus: async () => ({ key: { id: `m-${++calls}` } }) });
  for (let i = 0; i < 1025; i += 1) await router.publish({ text: String(i), audience: ['31612345678@s.whatsapp.net'], idempotencyKey: `k-${i}` });
  const repeated = await router.publish({ text: '0', audience: ['31612345678@s.whatsapp.net'], idempotencyKey: 'k-0' });
  assert.equal(repeated.body.deduplicated, true);
  assert.equal(calls, 1024);
  const full = await router.publish({ text: 'extra', audience: ['31612345678@s.whatsapp.net'], idempotencyKey: 'extra' });
  assert.equal(full.status, 507);
  assert.ok(router.records.size <= 1024);
});

test('GET is disabled when status publishing is disabled', async () => {
  const router = createStatusRouter({ isEnabled: () => false });
  router.records.set('secret', { key: 'secret', outcome: 'published' });
  const response = router.getStatus('secret');
  assert.equal(response.status, 404);
});

test('fails closed when the status journal contains corrupt JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'status-'));
  const journalPath = path.join(dir, 'journal.jsonl');
  writeFileSync(journalPath, '{corrupt\\n');
  assert.throws(() => createStatusRouter({ journalPath }), SyntaxError);
});
