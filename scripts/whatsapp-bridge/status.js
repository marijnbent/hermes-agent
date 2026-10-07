import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_TEXT_LENGTH = 4096;
const JID = /^\d{5,20}@s\.whatsapp\.net$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_RECORDS = 1024;
const ROTATION_PREFIX = 'molletje-status-rotation-';
const ROTATION_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const uncertainMessage = 'Provider outcome is uncertain; use a new idempotency key only for an intentional override';

export function validateStatusRequest(body = {}) {
  if (typeof body.text !== 'string' || body.text.length === 0 || body.text.length > MAX_TEXT_LENGTH) throw new Error(`text must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);
  if (!Array.isArray(body.audience) || body.audience.length === 0 || body.audience.length > 256) throw new Error('audience must be a non-empty explicit JID array');
  const audience = [...new Set(body.audience)];
  if (audience.length !== body.audience.length || audience.some((jid) => typeof jid !== 'string' || !JID.test(jid))) throw new Error('audience contains an invalid or duplicate WhatsApp contact JID');
  if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.trim().length < 1 || body.idempotencyKey.length > 200) throw new Error('idempotencyKey is required');
  const style = body.style === undefined ? {} : body.style;
  if (!style || typeof style !== 'object' || Array.isArray(style)) throw new Error('style must be an object');
  const normalizedStyle = {};
  if (style.backgroundColor !== undefined) { if (typeof style.backgroundColor !== 'string' || !HEX.test(style.backgroundColor)) throw new Error('backgroundColor must be a #RRGGBB color'); normalizedStyle.backgroundColor = style.backgroundColor; }
  if (style.font !== undefined) { if (!Number.isInteger(style.font) || style.font < 0 || style.font > 5) throw new Error('font must be an integer from 0 to 5'); normalizedStyle.font = style.font; }
  return { text: body.text, audience, style: normalizedStyle, idempotencyKey: body.idempotencyKey };
}

function digest(request) { return createHash('sha256').update(JSON.stringify({ text: request.text, audience: request.audience, style: request.style })).digest('hex'); }
function atomicAppend(file, record) { appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 }); }

export function createStatusRouter({ isEnabled = () => false, isConnected, sendStatus, journalPath, clock = Date.now } = {}) {
  const records = new Map();
  const inFlight = new Map();
  if (journalPath) {
    mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    if (existsSync(journalPath)) {
      for (const line of readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)) {
        const record = JSON.parse(line);
        if (record?.key) records.set(record.key, record);
      }
    }
    for (const record of records.values()) {
      if (record.outcome === 'pending') {
        record.outcome = 'uncertain';
        record.error = uncertainMessage;
      }
    }
  }
  const compactExpiredRotationRecords = () => {
    const cutoff = clock() - ROTATION_RETENTION_DAYS * DAY_MS;
    let pruned = false;
    for (const [key, record] of records) {
      if (key.startsWith(ROTATION_PREFIX) && record.outcome === 'published' && Number.isFinite(record.publishedAt) && record.publishedAt < cutoff) {
        records.delete(key);
        pruned = true;
      }
    }
    if (pruned && journalPath) {
      const tmp = `${journalPath}.tmp`;
      writeFileSync(tmp, `${[...records.values()].map((item) => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 });
      renameSync(tmp, journalPath);
    }
    return pruned;
  };
  compactExpiredRotationRecords();
  if (records.size > MAX_RECORDS) throw new Error('Status journal exceeds safe capacity');
  const persist = (record) => {
    if (!journalPath) return;
    atomicAppend(journalPath, record);
    if (records.size === MAX_RECORDS) {
      const tmp = `${journalPath}.tmp`;
      writeFileSync(tmp, `${[...records.values()].map((item) => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 });
      renameSync(tmp, journalPath);
    }
  };
  async function handle(body) {
    let request;
    try { request = validateStatusRequest(body); } catch (error) { return { status: 400, body: { error: error.message } }; }
    if (!isEnabled()) return { status: 404, body: { error: 'Status publishing is disabled for this bridge' } };
    const key = request.idempotencyKey;
    const dg = digest(request);
    const prior = records.get(key);
    if (prior && prior.digest !== dg) return { status: 409, body: { error: 'idempotencyKey is already bound to a different payload' } };
    if (inFlight.has(key)) return inFlight.get(key);
    if (prior?.outcome === 'pending') {
      prior.outcome = 'uncertain';
      prior.error = uncertainMessage;
      return { status: 504, body: prior };
    }
    if (prior && ['published', 'failed', 'uncertain'].includes(prior.outcome)) return { status: prior.outcome === 'published' ? 200 : (prior.outcome === 'uncertain' ? 504 : 502), body: { ...prior, deduplicated: true } };
    if (records.size >= MAX_RECORDS && (!compactExpiredRotationRecords() || records.size >= MAX_RECORDS)) return { status: 507, body: { error: 'Status journal is full; explicit maintenance required, no keys evicted' } };
    if (!isConnected()) return { status: 503, body: { error: 'Not connected to WhatsApp' } };
    const pending = { key, digest: dg, outcome: 'pending', createdAt: clock() };
    records.set(key, pending);
    persist(pending);
    const work = (async () => {
      try {
        const sent = await sendStatus('status@broadcast', { text: request.text }, { statusJidList: request.audience, ...request.style });
        const messageId = sent?.key?.id;
        if (!messageId) throw new Error('Provider returned no status message id');
        const record = { key, digest: dg, outcome: 'published', messageId, audience: request.audience, textLength: request.text.length, publishedAt: clock() };
        records.set(key, record); persist(record); return { status: 200, body: record };
      } catch (error) {
        const uncertain = /timed out|timeout|network|disconnect|socket|no status message id/i.test(String(error?.message));
        const record = { key, digest: dg, outcome: uncertain ? 'uncertain' : 'failed', ...(uncertain ? { error: uncertainMessage } : { error: String(error.message) }) };
        records.set(key, record); persist(record); return { status: uncertain ? 504 : 502, body: record };
      }
    })();
    inFlight.set(key, work);
    try { return await work; } finally { inFlight.delete(key); }
  }
  const router = express.Router();
  router.post('/', async (req, res) => {
    try {
      const result = await handle(req.body);
      res.status(result.status).json(result.body);
    } catch {
      res.status(503).json({ outcome: 'uncertain', error: 'Status journal failure; do not retry with a new key until inspected' });
    }
  });
  router.get('/:key', (req, res) => {
    if (!isEnabled()) return res.status(404).json({ error: 'Status publishing is disabled for this bridge' });
    const record = records.get(req.params.key);
    return record ? res.json(record) : res.status(404).json({ error: 'Unknown idempotency key' });
  });
  router.publish = handle;
  router.records = records;
  router.getStatus = (key) => isEnabled() && records.has(key) ? { status: 200, body: records.get(key) } : { status: 404 };
  router.rotationRetentionDays = ROTATION_RETENTION_DAYS;
  return router;
}
