import path from 'node:path';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

import { getMessageContent } from './bridge_helpers.js';

export function inboxSocketConfig(enabled) {
  return {
    browser: ['Hermes Agent', 'Chrome', '120.0'],
    syncFullHistory: Boolean(enabled),
    shouldSyncHistoryMessage: () => Boolean(enabled),
  };
}

export function pairOnlyExitDelayMs(captureEnabled) {
  return captureEnabled ? 180_000 : 2_000;
}

export function writePairingQr(sessionDir, payload) {
  const qrPath = path.join(sessionDir, 'pairing-qr.txt');
  writeFileSync(qrPath, String(payload), { encoding: 'utf8', mode: 0o600 });
  chmodSync(qrPath, 0o600);
  return qrPath;
}

export function removePairingQr(sessionDir) {
  const qrPath = path.join(sessionDir, 'pairing-qr.txt');
  if (existsSync(qrPath)) unlinkSync(qrPath);
}

function timestampSeconds(value) {
  if (value && typeof value.toNumber === 'function') return value.toNumber();
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
}

function extensionForMime(mime, fallback = '.bin') {
  const normalized = String(mime || '').split(';', 1)[0].toLowerCase();
  return {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }[normalized] || fallback;
}

function extractLinks(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
  return Array.from(new Set(matches.map(url => url.replace(/[),.;!?]+$/g, ''))));
}

function describeContent(content) {
  if (content.conversation) {
    return { body: content.conversation, mediaType: '', mime: '', mediaItem: null };
  }
  if (content.extendedTextMessage?.text) {
    return { body: content.extendedTextMessage.text, mediaType: '', mime: '', mediaItem: null };
  }
  if (content.imageMessage) {
    const item = content.imageMessage;
    return { body: item.caption || '', mediaType: 'image', mime: item.mimetype || 'image/jpeg', mediaItem: item };
  }
  if (content.stickerMessage) {
    const item = content.stickerMessage;
    return { body: '[Sticker]', mediaType: 'sticker', mime: item.mimetype || 'image/webp', mediaItem: item };
  }
  if (content.videoMessage) {
    const item = content.videoMessage;
    return { body: item.caption || '', mediaType: item.gifPlayback ? 'gif' : 'video', mime: item.mimetype || 'video/mp4', mediaItem: null };
  }
  if (content.audioMessage || content.pttMessage) {
    const item = content.pttMessage || content.audioMessage;
    return { body: '', mediaType: item.ptt || content.pttMessage ? 'ptt' : 'audio', mime: item.mimetype || 'audio/ogg', mediaItem: null };
  }
  if (content.documentMessage) {
    const item = content.documentMessage;
    return { body: item.caption || '', mediaType: 'document', mime: item.mimetype || 'application/octet-stream', mediaItem: null };
  }
  return { body: '', mediaType: '', mime: '', mediaItem: null };
}

function loadSeen(indexPath) {
  const seen = new Set();
  if (!existsSync(indexPath)) return seen;
  for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.archiveKey) seen.add(record.archiveKey);
    } catch {
      // A crash can leave one partial tail line. Preserve prior durable rows.
    }
  }
  return seen;
}

function repairInterruptedWrites(indexPath) {
  if (!existsSync(indexPath)) return;
  const valid = [];
  const corrupt = [];
  for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      valid.push(line);
    } catch {
      corrupt.push(line);
    }
  }
  if (!corrupt.length) return;

  const corruptPath = path.join(path.dirname(indexPath), 'messages.corrupt.jsonl');
  appendFileSync(corruptPath, `${corrupt.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(corruptPath, 0o600);
  const repairedPath = `${indexPath}.repair`;
  writeFileSync(repairedPath, valid.length ? `${valid.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
  renameSync(repairedPath, indexPath);
  chmodSync(indexPath, 0o600);
}

export function createInboxArchive({ rootDir, since }) {
  const archiveRoot = path.resolve(rootDir);
  const mediaDir = path.join(archiveRoot, 'media');
  const indexPath = path.join(archiveRoot, 'messages.jsonl');
  const sinceSeconds = Math.floor(new Date(since).getTime() / 1000);
  if (!Number.isFinite(sinceSeconds)) throw new Error(`Invalid WhatsApp inbox start date: ${since}`);

  mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  chmodSync(archiveRoot, 0o700);
  chmodSync(mediaDir, 0o700);
  repairInterruptedWrites(indexPath);
  const seen = loadSeen(indexPath);

  async function capture(msg, {
    source = 'live',
    chatName,
    senderName,
    downloadMedia,
  } = {}) {
    const timestamp = timestampSeconds(msg?.messageTimestamp);
    if (timestamp < sinceSeconds) return { status: 'before_since' };

    const messageId = String(msg?.key?.id || '');
    const chatId = String(msg?.key?.remoteJid || '');
    if (!messageId || !chatId || !msg?.message) return { status: 'invalid' };
    if (chatId.includes('status@broadcast')) return { status: 'status_ignored' };

    const archiveKey = `${chatId}:${messageId}`;
    if (seen.has(archiveKey)) return { status: 'duplicate' };

    const content = getMessageContent(msg);
    const described = describeContent(content);
    const mediaPaths = [];
    if (
      (described.mediaType === 'image' || described.mediaType === 'sticker')
      && described.mediaItem
      && typeof downloadMedia === 'function'
    ) {
      try {
        const bytes = await downloadMedia(msg);
        const ext = extensionForMime(described.mime, described.mediaType === 'sticker' ? '.webp' : '.jpg');
        const mediaPath = path.join(mediaDir, `${safePart(chatId)}_${safePart(messageId)}${ext}`);
        if (!existsSync(mediaPath)) {
          writeFileSync(mediaPath, bytes, { mode: 0o600 });
        }
        mediaPaths.push(mediaPath);
      } catch {
        // Keep the message record even when old/expired media cannot be fetched.
      }
    }

    const senderId = String(msg.key.participant || (msg.key.fromMe ? '' : chatId));
    const record = {
      archiveKey,
      messageId,
      chatId,
      chatName: chatName || msg.pushName || chatId,
      senderId,
      senderName: senderName || msg.pushName || senderId,
      timestamp,
      timestampIso: new Date(timestamp * 1000).toISOString(),
      direction: msg.key.fromMe ? 'outgoing' : 'incoming',
      isGroup: chatId.endsWith('@g.us'),
      source,
      body: described.body,
      links: extractLinks(described.body),
      mediaType: described.mediaType,
      mime: described.mime,
      mediaPaths,
    };

    appendFileSync(indexPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(indexPath, 0o600);
    seen.add(archiveKey);
    return { status: 'stored', record };
  }

  return { capture, indexPath, mediaDir };
}

export async function captureInboxBatch(archive, messages, {
  source = 'live',
  chatNames = new Map(),
  contactNames = new Map(),
  downloadMedia,
} = {}) {
  const results = [];
  for (const msg of messages || []) {
    const chatId = String(msg?.key?.remoteJid || '');
    const senderId = String(msg?.key?.participant || (msg?.key?.fromMe ? '' : chatId));
    results.push(await archive.capture(msg, {
      source,
      chatName: chatNames.get(chatId),
      senderName: contactNames.get(senderId),
      downloadMedia,
    }));
  }
  return results;
}
