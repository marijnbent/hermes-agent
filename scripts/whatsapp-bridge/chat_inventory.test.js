import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatInventory, waitForChatUpdate } from './chat_inventory.js';

test('persists chat metadata and message anchors from history/live events', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-inventory-'));
  const inventory = new ChatInventory({ filePath: path.join(dir, 'chats.json') });
  inventory.applyHistory({
    chats: [{ id: 'a@s.whatsapp.net', name: 'Alice', archived: true }],
    contacts: [{ id: 'a@s.whatsapp.net', name: 'Alice' }],
    messages: [{ key: { remoteJid: 'a@s.whatsapp.net', id: 'm1' }, messageTimestamp: 10 }],
  });
  inventory.applyLiveMessage({ key: { remoteJid: 'a@s.whatsapp.net', id: 'm2' }, messageTimestamp: 20 });
  const chat = inventory.get('a@s.whatsapp.net');
  assert.equal(chat.name, 'Alice');
  assert.equal(chat.archived, true);
  assert.deepEqual(chat.latestMessage, { id: 'm2', timestamp: 20 });
  assert.equal(inventory.coverage.history, true);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'chats.json'), 'utf8')).chats.length, 1);
});

test('unknown archive state stays unknown and stale guard rejects changed latest message', () => {
  const inventory = new ChatInventory({ filePath: path.join(mkdtempSync(path.join(tmpdir(), 'wa-inventory-')), 'chats.json') });
  inventory.upsertChat({ id: 'b@g.us', subject: 'Group' });
  assert.equal(inventory.get('b@g.us').archived, undefined);
  assert.equal(inventory.canArchive('b@g.us', null), false);
  assert.equal(inventory.canArchive('b@g.us', { id: 'missing', timestamp: 1 }), false);
  inventory.applyLiveMessage({ key: { remoteJid: 'b@g.us', id: 'm1' }, messageTimestamp: 2 });
  assert.equal(inventory.canArchive('b@g.us', { id: 'missing', timestamp: 1 }), false);
  assert.equal(inventory.canArchive('b@g.us', { id: 'm1', timestamp: 2 }), true);
});

test('journal seeding keeps anchors and sender provenance without inventing chat state', () => {
  const inventory = new ChatInventory({ filePath: path.join(mkdtempSync(path.join(tmpdir(), 'wa-inventory-')), 'chats.json') });
  inventory.seedJournal([
    { chatId: 'c@g.us', messageId: 'm1', timestamp: 4, direction: 'incoming', senderId: 'p@lid' },
    { chatId: 'c@g.us', messageId: 'm2', timestamp: 5, direction: 'outgoing' },
  ]);
  assert.equal(inventory.get('c@g.us').archived, undefined);
  assert.deepEqual(inventory.get('c@g.us').latestMessage, { chatId: 'c@g.us', id: 'm2', timestamp: 5, fromMe: true });
  assert.equal(inventory.coverage.journalAnchors, true);
});

test('live anchors preserve outgoing and group sender provenance', () => {
  const inventory = new ChatInventory({ filePath: path.join(mkdtempSync(path.join(tmpdir(), 'wa-inventory-')), 'chats.json') });
  inventory.applyLiveMessage({ key: { remoteJid: 'group@g.us', id: 'live1', fromMe: true, participant: 'self@lid' }, messageTimestamp: 50 });
  assert.equal(inventory.get('group@g.us').latestMessage.fromMe, true);
  assert.equal(inventory.get('group@g.us').latestMessage.participant, 'self@lid');
});

test('waits for authoritative chat update instead of reporting optimistic success', async () => {
  const events = [];
  const promise = waitForChatUpdate(events, 'a@s.whatsapp.net', true, 100);
  events.push([{ id: 'a@s.whatsapp.net', archived: false }]);
  events.push([{ id: 'a@s.whatsapp.net', archived: true }]);
  assert.deepEqual(await promise, { id: 'a@s.whatsapp.net', archived: true });
});
