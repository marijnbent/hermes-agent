import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function seconds(value) {
  if (value && typeof value.toNumber === 'function') return value.toNumber();
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function anchor(message) {
  const id = message?.key?.id;
  const chatId = message?.key?.remoteJid;
  return id && chatId ? {
    chatId, id, timestamp: seconds(message.messageTimestamp),
    ...(message.key.fromMe === true ? { fromMe: true } : {}),
    ...(message.key.participant ? { participant: message.key.participant } : {}),
  } : null;
}

export class ChatInventory {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.coverage = { history: false, live: false, complete: false };
    this.chats = new Map();
    this.contacts = new Map();
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.filePath, 'utf8'));
      this.coverage = { ...this.coverage, ...(saved.coverage || {}) };
      for (const chat of saved.chats || []) this.chats.set(chat.id, chat);
      for (const contact of saved.contacts || []) this.contacts.set(contact.id, contact);
    } catch { /* retain empty inventory after a partial/corrupt write */ }
  }

  save() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ coverage: this.coverage, chats: [...this.chats.values()], contacts: [...this.contacts.values()] }) + '\n', { mode: 0o600 });
  }

  upsertChat(chat) {
    if (!chat?.id) return;
    const prior = this.chats.get(chat.id) || { id: chat.id };
    const next = { ...prior, ...chat };
    if (!Object.hasOwn(chat, 'archived') && Object.hasOwn(prior, 'archived')) next.archived = prior.archived;
    this.chats.set(chat.id, next);
    this.save();
  }

  updateChats(chats) { for (const chat of chats || []) this.upsertChat(chat); }

  deleteChats(chats) {
    for (const chat of chats || []) if (chat?.id) this.chats.delete(chat.id);
    this.save();
  }

  updateContacts(contacts) {
    for (const contact of contacts || []) if (contact?.id) this.contacts.set(contact.id, { ...this.contacts.get(contact.id), ...contact });
    this.save();
  }

  applyHistory({ chats = [], contacts = [], messages = [] }) {
    this.updateChats(chats);
    this.updateContacts(contacts);
    for (const message of messages) this.applyMessage(message, false);
    this.coverage.history = true;
    this.save();
  }

  // Journal records are message anchors only; they do not imply existence,
  // completeness, or archived state.
  seedJournal(records = []) {
    for (const record of records) {
      if (!record?.chatId || !record?.messageId) continue;
      const item = {
        chatId: record.chatId, id: record.messageId,
        timestamp: seconds(record.timestamp),
        ...(record.direction === 'outgoing' ? { fromMe: true } : {}),
        ...(record.senderId ? { participant: record.senderId } : {}),
      };
      const prior = this.chats.get(item.chatId) || { id: item.chatId };
      if (!prior.latestMessage || item.timestamp >= prior.latestMessage.timestamp) {
        this.chats.set(item.chatId, { ...prior, latestMessage: item });
      }
    }
    this.coverage.journalAnchors = true;
    this.save();
  }

  applyLiveMessage(message) { this.applyMessage(message, true); }

  applyMessage(message, live) {
    const item = anchor(message);
    if (!item) return;
    const prior = this.chats.get(item.chatId) || { id: item.chatId };
    const old = prior.latestMessage;
    if (!old || item.timestamp >= old.timestamp) {
      const { chatId, ...latestMessage } = item;
      this.chats.set(item.chatId, { ...prior, latestMessage });
    }
    if (live) this.coverage.live = true;
    this.save();
  }

  get(id) { return this.chats.get(id) || null; }
  list() { return { chats: [...this.chats.values()], coverage: { ...this.coverage } }; }

  canArchive(id, expectedLatest) {
    const chat = this.get(id);
    if (!chat || !expectedLatest || !chat.latestMessage) return false;
    return chat.latestMessage.id === expectedLatest.id && chat.latestMessage.timestamp === Number(expectedLatest.timestamp);
  }
}

export function waitForChatUpdate(events, id, archived, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      for (const batch of events) for (const chat of batch || []) if (chat?.id === id && chat.archived === archived) return resolve(chat);
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for authoritative chat update'));
      setTimeout(check, 10);
    };
    check();
  });
}
