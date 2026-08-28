import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureInboxBatch,
  createInboxArchive,
  inboxSocketConfig,
  pairOnlyExitDelayMs,
  removePairingQr,
  writePairingQr,
} from './inbox_archive.js';

function message({ id, timestamp, chatId = '123@s.whatsapp.net', fromMe = false, message, pushName = 'Dinant' }) {
  return {
    key: { id, remoteJid: chatId, fromMe },
    messageTimestamp: timestamp,
    pushName,
    message,
  };
}

test('archives all-chat text, links, and images from the configured start date', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'wa-inbox-'));
  const archive = createInboxArchive({
    rootDir,
    since: '2026-01-01T00:00:00Z',
  });

  const old = await archive.capture(message({
    id: 'old',
    timestamp: 1767225599,
    message: { conversation: 'too old' },
  }));
  const text = await archive.capture(message({
    id: 'text',
    timestamp: 1767225600,
    fromMe: true,
    message: { extendedTextMessage: { text: 'See https://example.com/a?b=1' } },
  }));
  const image = await archive.capture(message({
    id: 'image',
    timestamp: 1767225601,
    chatId: 'group@g.us',
    message: { imageMessage: { caption: 'photo', mimetype: 'image/jpeg' } },
  }), {
    downloadMedia: async () => Buffer.from('jpeg-bytes'),
    chatName: 'Friends',
  });

  assert.equal(old.status, 'before_since');
  assert.equal(text.status, 'stored');
  assert.equal(image.status, 'stored');

  const records = readFileSync(path.join(rootDir, 'messages.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].links, ['https://example.com/a?b=1']);
  assert.equal(records[0].direction, 'outgoing');
  assert.equal(records[1].chatName, 'Friends');
  assert.equal(records[1].mediaType, 'image');
  assert.equal(records[1].mediaPaths.length, 1);
  assert.equal(readFileSync(records[1].mediaPaths[0], 'utf8'), 'jpeg-bytes');
});

test('records captions but never downloads video or audio and never deletes or duplicates', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'wa-inbox-'));
  const archive = createInboxArchive({ rootDir, since: '2026-01-01T00:00:00Z' });
  let downloads = 0;
  const downloadMedia = async () => {
    downloads += 1;
    return Buffer.from('forbidden');
  };

  const video = message({
    id: 'video', timestamp: 1767225602,
    message: { videoMessage: { caption: 'video caption', mimetype: 'video/mp4' } },
  });
  const voice = message({
    id: 'voice', timestamp: 1767225603,
    message: { audioMessage: { ptt: true, mimetype: 'audio/ogg' } },
  });

  assert.equal((await archive.capture(video, { downloadMedia })).status, 'stored');
  assert.equal((await archive.capture(voice, { downloadMedia })).status, 'stored');
  assert.equal((await archive.capture(video, { downloadMedia })).status, 'duplicate');
  assert.equal(downloads, 0);

  const records = readFileSync(path.join(rootDir, 'messages.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].body, 'video caption');
  assert.deepEqual(records[0].mediaPaths, []);
  assert.equal(records[1].mediaType, 'ptt');
  assert.deepEqual(records[1].mediaPaths, []);
});

test('captures history batches independently of bot and self-chat filtering', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'wa-inbox-'));
  const archive = createInboxArchive({ rootDir, since: '2026-01-01T00:00:00Z' });
  const messages = [
    message({ id: 'incoming-dm', timestamp: 1767225604, message: { conversation: 'hello' } }),
    message({
      id: 'outgoing-group', timestamp: 1767225605, chatId: 'family@g.us', fromMe: true,
      message: { conversation: 'group reply' },
    }),
  ];

  const results = await captureInboxBatch(archive, messages, {
    source: 'history',
    chatNames: new Map([['family@g.us', 'Family']]),
  });

  assert.deepEqual(results.map(result => result.status), ['stored', 'stored']);
  const records = readFileSync(path.join(rootDir, 'messages.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].source, 'history');
  assert.equal(records[1].chatName, 'Family');
  assert.equal(records[1].direction, 'outgoing');
});

test('history capture preserves the paired Hermes browser identity', () => {
  const enabled = inboxSocketConfig(true);
  const disabled = inboxSocketConfig(false);

  assert.deepEqual(enabled.browser, ['Hermes Agent', 'Chrome', '120.0']);
  assert.equal(enabled.syncFullHistory, true);
  assert.equal(enabled.shouldSyncHistoryMessage(), true);
  assert.deepEqual(disabled.browser, ['Hermes Agent', 'Chrome', '120.0']);
  assert.equal(disabled.syncFullHistory, false);
});

test('pair-only waits for initial history when inbox capture is enabled', () => {
  assert.equal(pairOnlyExitDelayMs(false), 2_000);
  assert.equal(pairOnlyExitDelayMs(true), 180_000);
});

test('pairing QR handoff is private and removed after use', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'wa-qr-'));
  const qrPath = writePairingQr(rootDir, 'qr-payload');
  assert.equal(readFileSync(qrPath, 'utf8'), 'qr-payload');
  removePairingQr(rootDir);
  assert.equal(existsSync(qrPath), false);
});

test('archive startup quarantines interrupted JSONL writes without losing valid records', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'wa-repair-'));
  const indexPath = path.join(rootDir, 'messages.jsonl');
  writeFileSync(indexPath, '{"messageId":"one","chatId":"a"}\n{"messageId":"broken"\n{"messageId":"two","chatId":"b"}\n');

  createInboxArchive({ rootDir, since: '2026-01-01T00:00:00Z' });

  const repaired = readFileSync(indexPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(repaired.map(row => row.messageId), ['one', 'two']);
  assert.match(readFileSync(path.join(rootDir, 'messages.corrupt.jsonl'), 'utf8'), /broken/);
});
