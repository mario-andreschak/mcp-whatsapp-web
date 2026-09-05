import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BufferJSON, proto, type SignalDataSet, type WAMessage } from '@whiskeysockets/baileys';
import { BaileysStore } from '../src/services/baileys-store.js';

const stores: BaileysStore[] = [];
const directories: string[] = [];
const peer = '15551234567@s.whatsapp.net';

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'baileys-store-test-'));
  directories.push(path);
  return path;
}

function open(path = directory()): BaileysStore {
  const store = new BaileysStore(path);
  stores.push(store);
  return store;
}

function message(id: string, time: number, remoteJid = peer, participant?: string): WAMessage {
  return {
    key: { remoteJid, id, fromMe: false, ...(participant ? { participant } : {}) },
    message: { conversation: `Message ${id}` },
    messageTimestamp: time,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  const tempRoot = resolve(tmpdir()) + sep;
  for (const path of directories.splice(0)) {
    const target = resolve(path);
    if (!target.startsWith(tempRoot) || !target.slice(tempRoot.length).startsWith('baileys-store-test-')) {
      throw new Error(`Refusing to remove unexpected test path: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
});

describe('BaileysStore auth persistence', () => {
  it('uses a durable WAL database and restores credentials, byte arrays and protobuf app-state keys after reopen', async () => {
    const path = directory();
    const store = open(path);
    const { state, saveCreds } = await store.createAuthState();
    const privateKey = Buffer.from(state.creds.noiseKey.private);
    await saveCreds({
      registered: true, nextPreKeyId: 42, routingInfo: Buffer.from([10, 20, 30]),
      account: proto.ADVSignedDeviceIdentity.fromObject({ details: Buffer.from([15, 16]), accountSignatureKey: Buffer.from([17, 18]) }),
    });
    await state.keys.set({
      session: { remote: Buffer.from([1, 2, 3]) },
      'pre-key': { '7': { public: new Uint8Array([4, 5]), private: Buffer.from([6, 7]) } },
      'app-state-sync-key': { app: proto.Message.AppStateSyncKeyData.fromObject({
        keyData: Buffer.from([8, 9]), timestamp: '1750000000123', fingerprint: { rawId: 123, currentIndex: 2 },
      }) },
      'app-state-sync-version': { regular: { version: 1, hash: Buffer.from([12]), indexValueMap: { index: { valueMac: Buffer.from([13]) } } } },
      'lid-mapping': { '15551234567': '987654', '987654_reverse': '15551234567' },
    });
    const reader = new Database(store.databasePath, { readonly: true });
    try {
      expect(reader.pragma('journal_mode', { simple: true })).toBe('wal');
      const saved = reader.prepare('SELECT data FROM credentials').get() as { data: string };
      expect(JSON.parse(saved.data).nextPreKeyId).toBe(42);
    } finally { reader.close(); }
    store.close();

    const reopened = open(path);
    const auth = await reopened.createAuthState();
    expect(Buffer.from(auth.state.creds.noiseKey.private)).toEqual(privateKey);
    expect(auth.state.creds.registered).toBe(true);
    expect(auth.state.creds.routingInfo).toEqual(Buffer.from([10, 20, 30]));
    expect(auth.state.creds.account).toBeInstanceOf(proto.ADVSignedDeviceIdentity);
    expect(auth.state.creds.account?.details).toEqual(Buffer.from([15, 16]));
    expect(auth.state.creds.account?.accountSignatureKey).toEqual(Buffer.from([17, 18]));
    const sessions = await auth.state.keys.get('session', ['remote', 'missing']);
    expect(Buffer.isBuffer(sessions.remote)).toBe(true);
    expect(sessions.remote).toEqual(Buffer.from([1, 2, 3]));
    expect(sessions.missing).toBeUndefined();
    expect((await auth.state.keys.get('pre-key', ['7']))['7'].public).toEqual(Buffer.from([4, 5]));
    const appKey = (await auth.state.keys.get('app-state-sync-key', ['app'])).app;
    expect(appKey).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(appKey.keyData).toEqual(Buffer.from([8, 9]));
    expect(appKey.timestamp?.toString()).toBe('1750000000123');
    expect((await auth.state.keys.get('app-state-sync-version', ['regular'])).regular.indexValueMap.index.valueMac)
      .toEqual(Buffer.from([13]));
    expect(reopened.resolveJid('987654@lid')).toBe(peer);
    await auth.state.keys.set({ session: { remote: null } });
    expect(await auth.state.keys.get('session', ['remote'])).toEqual({});
  });

  it('rolls back every Signal key in a failed batch and does not partially persist credential counters', async () => {
    const store = open();
    const { state, saveCreds } = await store.createAuthState();
    await saveCreds({ nextPreKeyId: 11 });
    await state.keys.set({ session: { existing: Buffer.from([1]) } });
    state.creds.nextPreKeyId = 12;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(state.keys.set({ session: { existing: Buffer.from([2]), invalid: circular } } as unknown as SignalDataSet))
      .rejects.toThrow(/circular/i);
    expect((await state.keys.get('session', ['existing'])).existing).toEqual(Buffer.from([1]));
    const reader = new Database(store.databasePath, { readonly: true });
    try {
      const saved = reader.prepare('SELECT data FROM credentials').get() as { data: string };
      expect(JSON.parse(saved.data).nextPreKeyId).toBe(11);
    } finally { reader.close(); }
  });

  it('clears the old account completely, invalidates old auth callbacks, and retains exclusive ownership', async () => {
    const path = directory();
    const store = open(path);
    const old = await store.createAuthState();
    const oldPrivateKey = Buffer.from(old.state.creds.noiseKey.private);
    await old.saveCreds({ registered: true, me: { id: peer, name: 'Previous account' } });
    await old.state.keys.set({ session: { remote: Buffer.from([1]) } });
    store.upsertContacts([{ id: peer, name: 'Private contact' }]);
    store.upsertMessages([message('private', 100)]);
    store.setLidMapping('987654@lid', peer);
    store.setMeta('history_sync_complete', true);
    store.clear();

    expect(store.getCounts()).toEqual({ messageCount: 0, chatCount: 0, contactCount: 0 });
    expect(store.resolveJid('987654@lid')).toBe('987654@lid');
    expect(store.getMeta('history_sync_complete')).toBeUndefined();
    await expect(old.saveCreds()).rejects.toThrow(/invalidated/);
    await expect(old.state.keys.set({ session: { late: Buffer.from([2]) } })).rejects.toThrow(/invalidated/);
    expect(() => open(path)).toThrow(/already in use/);
    const next = await store.createAuthState();
    expect(next.state.creds.registered).toBe(false);
    expect(next.state.creds.me).toBeUndefined();
    expect(Buffer.from(next.state.creds.noiseKey.private)).not.toEqual(oldPrivateKey);
    expect(await next.state.keys.get('session', ['remote'])).toEqual({});
  });

  it('reloads a fresh auth snapshot on socket replacement and rejects the previous socket\'s late key writes', async () => {
    const store = open();
    const old = await store.createAuthState();
    await old.saveCreds({ registered: true, nextPreKeyId: 11 });
    await old.state.keys.set({ session: { remote: Buffer.from([1]) } });
    store.upsertMessages([message('persist', 100)]);
    store.invalidateAuthState();
    const next = await store.createAuthState();
    expect(next.state.creds).not.toBe(old.state.creds);
    expect(next.state.creds.registered).toBe(true);
    old.state.creds.nextPreKeyId = 999;
    expect(next.state.creds.nextPreKeyId).toBe(11);
    await expect(old.state.keys.set({ session: { remote: Buffer.from([2]) } })).rejects.toThrow(/invalidated/);
    await expect(old.saveCreds()).rejects.toThrow(/invalidated/);
    expect((await next.state.keys.get('session', ['remote'])).remote).toEqual(Buffer.from([1]));
    expect(store.getMessages(peer)).toHaveLength(1);
  });
});

describe('BaileysStore synchronized history', () => {
  it('keeps the newest history window in chronological order and restores raw media and extended keys', () => {
    const path = directory();
    const store = open(path);
    const media = proto.WebMessageInfo.fromObject({
      ...message('b', 200),
      message: { imageMessage: { mimetype: 'image/png', mediaKey: Buffer.from([1, 3, 5]), fileLength: 1234 } },
    }) as WAMessage;
    media.key.remoteJidAlt = '999@lid';
    media.key.addressingMode = 'pn';
    media.retryCount = 2;
    store.upsertMessages([message('c', 300), message('a', 100), media, message('d', 300)]);
    store.close();
    const reopened = open(path);
    expect(reopened.getMessages(peer, 3).map(item => item.key.id)).toEqual(['b', 'c', 'd']);
    expect(reopened.getMessages(peer, 0)).toEqual([]);
    expect(reopened.getMessages(peer, -1)).toEqual([]);
    expect(reopened.getChat(peer)?.conversationTimestamp).toBe(300);
    const raw = reopened.getRawMessage({ remoteJid: peer, id: 'b' });
    expect(raw?.message?.imageMessage?.mediaKey).toEqual(Buffer.from([1, 3, 5]));
    expect(raw?.messageTimestamp?.toString()).toBe('200');
    expect(raw?.key.remoteJidAlt).toBe('999@lid');
    expect(raw?.key.addressingMode).toBe('pn');
    expect(raw?.retryCount).toBe(2);
  });

  it('merges partial contacts/chats and updates, revokes and deletes messages without crossing chat or participant identities', () => {
    const store = open();
    const group = '123@g.us';
    const one = '111@s.whatsapp.net';
    const two = '222@s.whatsapp.net';
    store.upsertContacts([{ id: peer, name: 'Alice', notify: 'A' }]);
    store.upsertContacts([{ id: peer, notify: 'Updated', name: undefined, lid: undefined, phoneNumber: undefined }]);
    expect(store.getContact(peer)).toMatchObject({ name: 'Alice', notify: 'Updated' });
    store.upsertChats([{ id: peer, name: 'Alice', unreadCount: 4 }]);
    store.upsertChats([{ id: peer, unreadCount: 0, name: undefined }]);
    expect(store.getChat(peer)).toMatchObject({ name: 'Alice', unreadCount: 0 });
    store.upsertMessages([message('same', 100), message('same', 101, group, one), message('same', 102, group, two)]);
    expect(store.getRawMessage({ remoteJid: group, id: 'same' })).toBeUndefined();
    store.updateMessages([{ key: { remoteJid: group, id: 'same', participant: one }, update: { status: proto.WebMessageInfo.Status.READ } }]);
    expect(store.getRawMessage({ remoteJid: group, id: 'same', participant: one })?.status).toBe(proto.WebMessageInfo.Status.READ);
    expect(store.getRawMessage({ remoteJid: group, id: 'same', participant: two })?.status).toBeUndefined();
    store.updateMessages([{
      key: { remoteJid: peer, id: 'same' },
      update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE, key: { remoteJid: peer, id: 'revoke-notification' } },
    }]);
    expect(store.getRawMessage({ remoteJid: peer, id: 'same' })?.message).toBeNull();
    expect(store.getRawMessage({ remoteJid: peer, id: 'revoke-notification' })).toBeUndefined();
    store.deleteMessages({ keys: [{ remoteJid: group, id: 'same' }] });
    expect(store.getMessages(group)).toHaveLength(2);
    store.deleteMessages({ keys: [{ remoteJid: group, id: 'same', participant: one }] });
    expect(store.getMessages(group)).toHaveLength(1);
    expect(store.getMessages(peer)).toHaveLength(1);
    store.deleteMessages({ all: true, jid: peer });
    expect(store.getMessages(peer)).toHaveLength(0);
    expect(() => store.deleteMessages({ all: true })).toThrow(/requires a chat/);
    store.deleteChats([group]);
    expect(store.getChat(group)).toBeUndefined();
    expect(store.getMessages(group)).toHaveLength(0);
  });

  it('merges LID/phone aliases, deduplicates overlapping history and resolves device JIDs after reopen', () => {
    const path = directory();
    const store = open(path);
    const lid = '777@lid';
    const group = '123@g.us';
    store.upsertContacts([{ id: lid, notify: 'Alice' }, { id: peer, name: 'Saved name' }]);
    store.upsertChats([{ id: lid, name: 'Chat name' }]);
    store.upsertMessages([
      message('overlap', 10, lid), message('overlap', 10, peer),
      message('lid-only', 20, lid), message('phone-only', 30, peer), message('group-message', 40, group, lid),
    ]);
    store.setLidMapping(lid, peer);
    expect(store.getContacts()).toHaveLength(1);
    expect(store.getContact(lid)).toMatchObject({ id: peer, notify: 'Alice', name: 'Saved name' });
    expect(store.getChats(10)).toHaveLength(2);
    expect(store.getMessages(lid).map(item => item.key.id)).toEqual(['overlap', 'lid-only', 'phone-only']);
    expect(store.getRawMessage({ remoteJid: group, id: 'group-message', participant: peer })?.key.participant).toBe(lid);
    store.close();
    const reopened = open(path);
    expect(reopened.resolveJid('777:4@lid')).toBe(peer);
    expect(reopened.resolveJid('15551234567:2@s.whatsapp.net')).toBe(peer);
    expect(reopened.resolveJid('15551234567@c.us')).toBe(peer);
    expect(reopened.getMessages(lid)).toHaveLength(3);
    expect(reopened.getRawMessage({ remoteJid: lid, id: 'phone-only' })?.key.id).toBe('phone-only');
    reopened.deleteMessages({ keys: [{ remoteJid: lid, id: 'lid-only' }] });
    expect(reopened.getMessages(peer)).toHaveLength(2);
  });

  it('keeps revoked bodies erased when delayed history arrives after a reopen', () => {
    const path = directory();
    const store = open(path);
    const original = message('revoked', 100);
    store.upsertMessages([original]);
    store.updateMessages([{
      key: original.key,
      update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE, key: { ...original.key, id: 'revoke-notification' } },
    }]);
    store.close();
    const reopened = open(path);
    reopened.upsertMessages([original]);
    expect(reopened.getRawMessage(original.key)).toMatchObject({ message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE });
    expect(reopened.getRawMessage({ ...original.key, id: 'revoke-notification' })).toBeUndefined();
    // Local deletions keep their existing behavior; only protocol revocations persist tombstones.
    reopened.deleteMessages({ keys: [original.key] });
    expect(reopened.getRawMessage(original.key)).toBeUndefined();
  });

  it('records revocations before original history arrives without creating tombstones for unrelated updates', () => {
    const store = open();
    const original = message('revoked-before-sync', 100, '123@g.us', peer);
    store.updateMessages([{
      key: original.key,
      update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE, key: { ...original.key, id: 'revoke-notification' } },
    }]);
    expect(store.getRawMessage(original.key)?.message).toBeNull();
    store.upsertMessages([original]);
    expect(store.getRawMessage(original.key)).toMatchObject({ message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE });
    expect(store.getRawMessage(original.key)?.messageTimestamp?.toString()).toBe('100');
    expect(store.getMessages('123@g.us')).toHaveLength(1);
    store.updateMessages([{ key: { ...original.key, id: 'unknown-status' }, update: { status: proto.WebMessageInfo.Status.READ } }]);
    expect(store.getRawMessage({ ...original.key, id: 'unknown-status' })).toBeUndefined();
  });

  it('retains a revocation when overlapping LID and phone histories are later merged', () => {
    const store = open();
    const lid = '777@lid';
    const original = message('revoked', 100, lid);
    store.upsertMessages([original, message('revoked', 100, peer)]);
    store.updateMessages([{
      key: original.key,
      update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
    }]);
    store.setLidMapping(lid, peer);
    expect(store.getMessages(peer)).toHaveLength(1);
    expect(store.getRawMessage(original.key)).toMatchObject({ message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE });
  });

  it('rolls back a whole history event and nested writes when any operation fails', () => {
    const store = open();
    expect(() => store.transaction(() => {
      store.setMeta('sync', 1);
      store.upsertContacts([{ id: peer, name: 'Alice' }]);
      store.upsertMessages([message('one', 100)]);
      throw new Error('sync failed');
    })).toThrow('sync failed');
    expect(store.getMeta('sync')).toBeUndefined();
    expect(store.getCounts()).toEqual({ messageCount: 0, chatCount: 0, contactCount: 0 });
    expect(() => store.transaction(() => Promise.resolve('async is not atomic'))).toThrow(/synchronous/);
  });

  it('keeps newer LID chat timestamps and stable message identities when merging with older phone history', () => {
    const store = open();
    const lid = '777@lid';
    const otherPhone = '15557654321@s.whatsapp.net';
    store.upsertMessages([message('new-lid', 30, lid), message('old-phone', 10, peer)]);
    store.upsertChats([{ id: lid, lastMessageRecvTimestamp: 35 }]);
    store.upsertChats([{ id: peer, lastMessageRecvTimestamp: 15 }]);
    store.setLidMapping(lid, peer);
    expect(store.getChat(peer)).toMatchObject({ conversationTimestamp: 30, lastMessageRecvTimestamp: 35 });
    const raw = store.getMessages(peer).find(item => item.key.id === 'new-lid')!;
    expect(store.getRawMessage(raw.key)?.key.id).toBe('new-lid');
    expect(() => store.setLidMapping(lid, otherPhone)).toThrow(/Conflicting Baileys identity mapping/);
    expect(store.resolveJid(lid)).toBe(peer);
    expect(store.getRawMessage(raw.key)?.key.id).toBe('new-lid');
    expect(store.getMessages(otherPhone)).toHaveLength(0);

    const reader = new Database(store.databasePath, { readonly: true });
    try {
      const saved = reader.prepare('SELECT timestamp, data FROM chats WHERE id = ?').get(peer) as { timestamp: number; data: string };
      expect(saved.timestamp).toBe(35);
      expect(JSON.parse(saved.data).conversationTimestamp).toBe(30);
      const plan = reader.prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE chat_id = ? OR participant = ?').all(lid, lid) as { detail: string }[];
      expect(plan.some(item => item.detail.includes('MULTI-INDEX OR'))).toBe(true);
      expect(plan.some(item => item.detail.includes('messages_by_participant'))).toBe(true);
      expect(plan.some(item => item.detail.includes('SCAN messages'))).toBe(false);
    } finally { reader.close(); }
  });
});

describe('BaileysStore session ownership', () => {
  it('rejects a second live owner and safely permits reopening after normal close', () => {
    const path = directory();
    const owner = open(path);
    owner.upsertMessages([message('persist', 1)]);
    expect(() => new BaileysStore(path)).toThrow(/already in use/);
    expect(() => new BaileysStore(path)).toThrow(/already in use/);
    expect(owner.getMessages(peer)).toHaveLength(1);
    owner.close();
    owner.close();
    expect(open(path).getMessages(peer)).toHaveLength(1);
  });

  it('recovers only a demonstrably dead PID on this host and preserves its session data', () => {
    const path = directory();
    const store = open(path);
    store.upsertMessages([message('persist', 1)]);
    const databasePath = store.databasePath;
    store.close();
    expect(() => process.kill(2147483647, 0)).toThrow();
    const db = new Database(databasePath);
    db.prepare('INSERT INTO session_owner (singleton, pid, host, token) VALUES (1, ?, ?, ?)')
      .run(2147483647, hostname(), 'crashed-owner');
    db.close();
    expect(open(path).getMessages(peer)).toHaveLength(1);
  });

  it('does not steal a lock belonging to an unknown host', () => {
    const path = directory();
    const store = open(path);
    const databasePath = store.databasePath;
    store.close();
    const db = new Database(databasePath);
    try {
      db.prepare('INSERT INTO session_owner (singleton, pid, host, token) VALUES (1, ?, ?, ?)')
        .run(2147483647, 'another-machine', 'unknown-owner');
      expect(() => new BaileysStore(path)).toThrow(/another-machine/);
      const row = db.prepare('SELECT token FROM session_owner').get() as { token: string };
      expect(row.token).toBe('unknown-owner');
      // Leave a clean test database for cleanup.
      db.prepare('DELETE FROM session_owner').run();
    } finally { db.close(); }
  });

  it('preserves auth across ordinary close and rejects callbacks into a closed store', async () => {
    const path = directory();
    const store = open(path);
    const auth = await store.createAuthState();
    await auth.saveCreds({ registered: true, me: { id: peer } });
    const serialized = JSON.stringify(auth.state.creds, BufferJSON.replacer);
    store.close();
    await expect(auth.saveCreds()).rejects.toThrow(/closed/);
    const reopened = await open(path).createAuthState();
    expect(JSON.stringify(reopened.state.creds, BufferJSON.replacer)).toBe(serialized);
  });
});
