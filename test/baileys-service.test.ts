import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DisconnectReason, type UserFacingSocketConfig, type WAMessage, type WAMessageKey, type WAVersion } from '@whiskeysockets/baileys';
import {
  BaileysService, backupSignIn, decodeMessageId, describeDisconnect, encodeMessageId, linkedDeviceBrowser, parseWaVersion,
  reconnectDelay, type BaileysSocket,
} from '../src/services/baileys.js';
import { BaileysStore } from '../src/services/baileys-store.js';

vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const services: BaileysService[] = [];
const directories: string[] = [];
const user = '12025550101@s.whatsapp.net';
const peer = '12025550102@s.whatsapp.net';
const group = '12025550102-123@g.us';
const oldMessage = (key: Partial<WAMessageKey> = {}, body = 'hello', time = 1700000000): WAMessage => ({
  key: { id: 'message-id', remoteJid: peer, fromMe: false, ...key },
  message: { conversation: body }, messageTimestamp: time,
});

function fixture(options: {
  directory?: string; requestTimeout?: number; resolveVersion?: () => Promise<WAVersion | undefined>; slowReconnectDelayMs?: number;
} = {}) {
  const directory = options.directory ?? mkdtempSync(path.join(os.tmpdir(), 'wa-baileys-service-'));
  if (!options.directory) directories.push(directory);
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const configs: UserFacingSocketConfig[] = [];
  const socketFactory = vi.fn((config: UserFacingSocketConfig) => {
    configs.push(config);
    const fake = fakeSocket();
    sockets.push(fake);
    return fake as unknown as BaileysSocket;
  });
  const downloadMedia = vi.fn(async () => Readable.from([Buffer.from('downloaded')]));
  const service = new BaileysService({ sessionDir: directory, socketFactory,
    downloadMedia: downloadMedia as never, reconnectDelayMs: 1, historyRequestTimeoutMs: options.requestTimeout ?? 25,
    ...(options.resolveVersion ? { resolveVersion: options.resolveVersion } : {}),
    ...(options.slowReconnectDelayMs ? { slowReconnectDelayMs: options.slowReconnectDelayMs } : {}) });
  services.push(service);
  return { service, sockets, configs, socketFactory, directory, downloadMedia };
}

function fakeSocket() {
  return {
    ev: new EventEmitter(),
    user: { id: user },
    end: vi.fn(),
    logout: vi.fn(async () => {}),
    requestPairingCode: vi.fn(async () => 'ABCD1234'),
    sendMessage: vi.fn(async (jid: string, content: { text?: string }) => oldMessage({ remoteJid: jid, fromMe: true }, content.text ?? 'attachment')),
    fetchMessageHistory: vi.fn(async () => 'request-id'),
    updateMediaMessage: vi.fn(async (message: WAMessage) => message),
    groupMetadata: vi.fn(async (jid: string) => ({ id: jid, subject: 'Test group', participants: [] })),
  };
}

async function connected(options: Parameters<typeof fixture>[0] = {}) {
  const fixtureResult = fixture(options);
  await fixtureResult.service.initialize();
  fixtureResult.sockets[0].ev.emit('connection.update', { connection: 'open' });
  return { ...fixtureResult, socket: fixtureResult.sockets[0] };
}

function sync(socket: ReturnType<typeof fakeSocket>, messages: WAMessage[] = []) {
  socket.ev.emit('messaging-history.set', { chats: [], contacts: [], messages, isLatest: true, progress: 100 });
}

function close(socket: ReturnType<typeof fakeSocket>, statusCode = 408) {
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.WHATSAPP_PAIRING_PHONE_NUMBER;
  for (const service of services.splice(0)) await service.destroy();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Baileys lifecycle and authentication (offline)', () => {
  it('shares initialization, uses persistent auth and never constructs a browser', async () => {
    const { service, configs, socketFactory } = fixture();
    await Promise.all([service.initialize(), service.initialize(), service.initialize()]);
    expect(socketFactory).toHaveBeenCalledTimes(1);
    expect(configs[0].auth.keys).toBeDefined();
    expect(configs[0].syncFullHistory).toBe(true);
    expect(configs[0].markOnlineOnConnect).toBe(false);
    expect(service.isAuthenticated()).toBe(false);
  });

  it('links as a Chrome device by default, since WhatsApp ends new Desktop links', async () => {
    const { service, configs } = fixture();
    await service.initialize();
    expect(configs[0].browser?.[1]).toBe('Chrome');
    vi.stubEnv('BAILEYS_BROWSER', 'Desktop');
    try { expect(linkedDeviceBrowser()[1]).toBe('Desktop'); } finally { vi.unstubAllEnvs(); }
  });

  it('reports the current WhatsApp Web version, honours a pin and survives a failed lookup', async () => {
    expect(parseWaVersion('2.3000.1053895232')).toEqual([2, 3000, 1053895232]);
    for (const bad of [undefined, '', '2.3000', '2.x.1', '2.3000.1.4', '-1.2.3']) expect(parseWaVersion(bad)).toBeUndefined();

    const resolveVersion = vi.fn(async (): Promise<WAVersion> => [2, 3000, 42]);
    const looked = fixture({ resolveVersion });
    await looked.service.initialize();
    expect(looked.configs[0].version).toEqual([2, 3000, 42]);

    vi.stubEnv('WA_WEB_VERSION', '2.3000.7');
    try {
      const pinned = fixture({ resolveVersion });
      await pinned.service.initialize();
      expect(pinned.configs[0].version).toEqual([2, 3000, 7]);
    } finally { vi.unstubAllEnvs(); }
    expect(resolveVersion).toHaveBeenCalledTimes(1);

    const failing = fixture({ resolveVersion: async () => { throw new Error('offline'); } });
    await failing.service.initialize();
    expect(failing.configs[0].version).toBeUndefined();
  });

  it('reports initialization ownership failures promptly and preserves their useful error', async () => {
    const first = await connected();
    const second = fixture({ directory: first.directory });
    await expect(second.service.initialize()).rejects.toThrow('already in use');
    await expect(second.service.ensureReady()).rejects.toThrow('already in use');
    expect(second.service.getStatus().history.note).toContain('already in use');
  });

  it('tracks QR and pairing codes and persists credential updates across restart', async () => {
    const { service, sockets, directory } = fixture();
    await service.initialize();
    sockets[0].ev.emit('connection.update', { qr: 'QR-DATA' });
    expect(service.getLatestQrCode()).toBe('QR-DATA');
    await expect(service.ensureReady()).rejects.toThrow('not authenticated');
    expect(await service.requestPairingCode('+1 202 555 0101')).toBe('ABCD1234');
    expect(sockets[0].requestPairingCode).toHaveBeenCalledWith('12025550101');
    expect(service.getLatestPairingCode()).toBe('ABCD1234');
    sockets[0].ev.emit('creds.update', { registered: true, me: { id: user } });
    sockets[0].ev.emit('connection.update', { connection: 'open' });
    expect(service.getLatestQrCode()).toBeNull();
    expect(service.getLatestPairingCode()).toBeNull();
    await service.destroy();
    const restored = fixture({ directory });
    await restored.service.initialize();
    expect(restored.configs[0].auth.creds.registered).toBe(true);
    expect(restored.configs[0].auth.creds.me?.id).toBe(user);
  });

  it('requests environment pairing only after a QR arrives and catches request failures', async () => {
    process.env.WHATSAPP_PAIRING_PHONE_NUMBER = '+1 202 555 0101';
    const { service, sockets } = fixture();
    await service.initialize();
    expect(sockets[0].requestPairingCode).not.toHaveBeenCalled();
    sockets[0].requestPairingCode.mockRejectedValueOnce(new Error('offline'));
    sockets[0].ev.emit('connection.update', { qr: 'qr' });
    await vi.waitFor(() => expect(sockets[0].requestPairingCode).toHaveBeenCalledOnce());
    expect(service.getLatestPairingCode()).toBeNull();
  });

  it('sets a removed device\'s sign-in aside as a dated backup, clears it and offers a fresh link', async () => {
    vi.useFakeTimers();
    const { service, socket, configs, sockets, directory } = await connected();
    const invalidated = vi.fn();
    service.onSessionInvalidated(invalidated);
    socket.ev.emit('creds.update', { registered: true, me: { id: user } });
    sync(socket, [oldMessage()]);
    close(socket, DisconnectReason.loggedOut);
    expect(service.isAuthenticated()).toBe(false);
    expect(invalidated).toHaveBeenCalledOnce();
    expect(service.getStatus().history.messageCount).toBe(0);

    const backups = readdirSync(path.join(directory, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^session-\d{4}-\d{2}-\d{2}T.+\.sqlite$/);
    const copy = new Database(path.join(directory, 'backups', backups[0]), { readonly: true });
    try {
      expect((copy.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
      expect((copy.prepare('SELECT COUNT(*) AS n FROM credentials').get() as { n: number }).n).toBe(1);
    } finally { copy.close(); }

    expect(service.getStatus().connection?.state).toBe('waiting_for_link');
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(2);
    expect(configs[1].auth.creds.registered).toBe(false);
    expect(configs[1].auth.creds.me).toBeUndefined();
    sockets[1].ev.emit('connection.update', { qr: 'fresh-qr' });
    expect(service.getLatestQrCode()).toBe('fresh-qr');
  });

  it('also treats a device_removed conflict as a real sign-out, whatever its code', () => {
    expect(describeDisconnect({ output: { statusCode: 440 }, data: { tag: 'conflict', attrs: { type: 'device_removed' } } }).deviceRemoved).toBe(true);
    expect(describeDisconnect({ output: { statusCode: 440 }, data: { tag: 'conflict', attrs: { type: 'replaced' } } }).deviceRemoved).toBe(false);
    expect(describeDisconnect({ output: { statusCode: 401 } })).toMatchObject({ code: 401, deviceRemoved: true });
    for (const code of [403, 408, 428, 500, 503, 515, 999]) {
      expect(describeDisconnect({ output: { statusCode: code } }).deviceRemoved).toBe(false);
    }
    expect(describeDisconnect(undefined)).toEqual({ reason: 'The connection dropped.', deviceRemoved: false });
    expect(describeDisconnect({ message: 'QR refs attempts ended', output: { statusCode: 408 } }).reason).toContain('QR code expired');
  });

  it('keeps the sign-in through repeated bad-session errors and a refused account', async () => {
    vi.useFakeTimers();
    const { service, socket, sockets, directory } = await connected();
    const invalidated = vi.fn();
    service.onSessionInvalidated(invalidated);
    socket.ev.emit('creds.update', { registered: true, me: { id: user } });
    sync(socket, [oldMessage()]);
    for (let round = 0; round < 6; round++) {
      close(sockets[sockets.length - 1], round === 5 ? DisconnectReason.forbidden : DisconnectReason.badSession);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(invalidated).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(7);
    expect(service.getStatus().history.messageCount).toBe(1);
    expect(() => readdirSync(path.join(directory, 'backups'))).toThrow();
    expect(service.getStatus().connection).toMatchObject({ state: 'reconnecting', lastReason: expect.stringContaining('refused') });
  });

  it('keeps only the newest few sign-in backups', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'wa-baileys-backups-'));
    directories.push(directory);
    const store = new BaileysStore(directory);
    try {
      const auth = await store.createAuthState();
      await auth.saveCreds({ me: { id: user } } as never);
      const names: string[] = [];
      for (let index = 0; index < 5; index++) {
        names.push(path.basename(backupSignIn(store, directory, 3, new Date(Date.UTC(2026, 10, 11, 0, 0, index)))!));
      }
      expect(readdirSync(path.join(directory, 'backups')).sort()).toEqual(names.slice(2));
    } finally { store.close(); }
  });

  it('does not make a backup when there is nothing to keep', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'wa-baileys-backups-'));
    directories.push(directory);
    const store = new BaileysStore(directory);
    try {
      expect(backupSignIn(store, directory)).toBeUndefined();
    } finally { store.close(); }
  });

  it('leaves the sign-in untouched when it cannot be backed up', async () => {
    vi.useFakeTimers();
    const { service, socket, sockets } = await connected();
    socket.ev.emit('creds.update', { registered: true, me: { id: user } });
    sync(socket, [oldMessage()]);
    vi.spyOn(BaileysStore.prototype, 'backupTo').mockImplementation(() => { throw new Error('disk full'); });
    close(socket, DisconnectReason.loggedOut);
    expect(service.getStatus().history.messageCount).toBe(1);
    await expect(service.ensureReady(0)).rejects.toThrow('could not be backed up');
    expect(service.getStatus().connection?.state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sockets).toHaveLength(1);
  });

  it('clears local credentials and invalidates access even when remote logout fails', async () => {
    const { service, socket, directory } = await connected();
    const invalidated = vi.fn();
    service.onSessionInvalidated(invalidated);
    socket.logout.mockRejectedValueOnce(new Error('offline'));
    socket.ev.emit('creds.update', { registered: true });
    await expect(service.logout()).rejects.toThrow('Local Baileys credentials were cleared');
    expect(invalidated).toHaveBeenCalledOnce();
    const restored = fixture({ directory });
    await restored.service.initialize();
    expect(restored.configs[0].auth.creds.registered).toBe(false);
  });

  it('suppresses stale socket callbacks after a reconnect', async () => {
    vi.useFakeTimers();
    const { service, sockets } = await connected();
    const stale = sockets[0].ev.listeners('connection.update')[0];
    close(sockets[0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    stale({ connection: 'open' });
    expect(service.isAuthenticated()).toBe(false);
  });

  it('spaces reconnect attempts quickly at first, then at a slow capped pace, forever', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(attempt => reconnectDelay(attempt))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    for (const attempt of [8, 9, 50, 10_000]) expect(reconnectDelay(attempt)).toBe(300_000);
    expect(reconnectDelay(9, 1_000, 120_000)).toBe(120_000);
  });

  it('never gives up reconnecting and recovers by itself when the network comes back', async () => {
    vi.useFakeTimers();
    const { service, socket, sockets } = await connected();
    socket.ev.emit('creds.update', { registered: true, me: { id: user } });
    const downAt = Date.now();
    for (let attempt = 1; attempt <= 8; attempt++) {
      close(sockets[sockets.length - 1], DisconnectReason.connectionClosed);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(sockets).toHaveLength(9);

    // After the quick attempts it waits five minutes between tries, without ever stopping.
    for (let slow = 1; slow <= 12; slow++) {
      close(sockets[sockets.length - 1], DisconnectReason.connectionClosed);
      await vi.advanceTimersByTimeAsync(299_000);
      expect(sockets).toHaveLength(9 + slow - 1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(9 + slow);
    }

    const status = service.getStatus().connection!;
    expect(status.state).toBe('reconnecting');
    expect(status.since).toBe(new Date(downAt).toISOString());
    expect(status.attempts).toBe(20);
    expect(status.summary).toContain('reconnecting by itself');
    expect(status.summary).toContain('nothing needs to be scanned');
    expect(status.lastReason).toContain('network interruption');
    await expect(service.ensureReady(0)).rejects.toThrow('reconnecting by itself');

    sockets[sockets.length - 1].ev.emit('connection.update', { connection: 'open' });
    expect(service.isAuthenticated()).toBe(true);
    expect(service.getStatus().connection).toMatchObject({ state: 'linked', summary: 'Linked and connected to WhatsApp.' });

    // A working connection resets the pace: the next drop is retried quickly again.
    const before = sockets.length;
    close(sockets[sockets.length - 1], DisconnectReason.connectionClosed);
    await vi.advanceTimersByTimeAsync(5);
    expect(sockets).toHaveLength(before + 1);
  });

  it('tries at once instead of waiting for the slow pace when someone asks for WhatsApp', async () => {
    vi.useFakeTimers();
    const { service, socket, sockets } = await connected();
    socket.ev.emit('creds.update', { registered: true, me: { id: user } });
    for (let attempt = 1; attempt <= 9; attempt++) {
      close(sockets[sockets.length - 1], DisconnectReason.timedOut);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(sockets).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(31_000);
    await service.waitForAuthOutcome(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(10);
    // But not over and over: attempts stay at least half a minute apart.
    close(sockets[sockets.length - 1], DisconnectReason.timedOut);
    await service.waitForAuthOutcome(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(10);
  });

  it('keeps offering new QR codes while nobody has linked it yet, instead of giving up', async () => {
    vi.useFakeTimers();
    const { service, sockets } = fixture();
    await service.initialize();
    for (let round = 0; round < 12; round++) {
      const current = sockets[sockets.length - 1];
      current.ev.emit('connection.update', { qr: `qr-${round}` });
      expect(service.getStatus().connection?.state).toBe('waiting_for_link');
      current.ev.emit('connection.update', {
        connection: 'close', lastDisconnect: { error: { message: 'QR refs attempts ended', output: { statusCode: 408 } } },
      });
      await vi.advanceTimersByTimeAsync(300_000);
    }
    expect(sockets).toHaveLength(13);
    expect(service.getStatus().connection).toMatchObject({ state: 'waiting_for_link', lastReason: expect.stringContaining('QR code expired') });
    await expect(service.ensureReady(0)).rejects.toThrow('not authenticated');
  });

  it('stops without fighting when another copy of the sign-in connects elsewhere', async () => {
    vi.useFakeTimers();
    const { service, socket, sockets } = await connected();
    close(socket, DisconnectReason.connectionReplaced);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sockets).toHaveLength(1);
    const status = service.getStatus().connection!;
    expect(status.state).toBe('stopped');
    expect(status.summary).toContain('its own sign-in folder');
    expect(status.summary).toContain('The sign-in was kept');
  });

  it('takes over the sign-in by itself once the other program closes', async () => {
    const first = await connected();
    const second = fixture({ directory: first.directory, slowReconnectDelayMs: 50 });
    await expect(second.service.initialize()).rejects.toThrow('already in use');
    const waiting = second.service.getStatus().connection!;
    expect(waiting.state).toBe('waiting_for_other_program');
    expect(waiting.summary).toContain('its own folder');
    expect(waiting.summary).toContain('own device');
    expect(waiting.summary).toContain('takes over when the other program closes');
    await first.service.destroy();
    await vi.waitFor(() => expect(second.sockets).toHaveLength(1), { timeout: 5_000 });
    second.sockets[0].ev.emit('connection.update', { connection: 'open' });
    expect(second.service.getStatus().connection?.state).toBe('linked');
    expect(second.service.getStatus().history.note).not.toContain('already in use');
  });

  it('rejects stale Signal-key writes after reconnect without poisoning the new authentication state', async () => {
    vi.useFakeTimers();
    const { service, sockets, configs } = await connected();
    close(sockets[0]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(configs[0].auth.keys.set({ session: { stale: Buffer.from('old') } })).rejects.toThrow('no longer active');
    expect(await configs[1].auth.keys.get('session', ['stale'])).toEqual({});
    sockets[1].ev.emit('connection.update', { connection: 'open' });
    expect(service.isAuthenticated()).toBe(true);
  });

  it('cancels pending reconnects and serializes destruction racing initialization', async () => {
    vi.useFakeTimers();
    const { service, sockets } = fixture();
    await Promise.all([service.initialize(), service.destroy()]);
    expect(sockets).toHaveLength(0);
    await service.initialize();
    close(sockets[0]);
    await service.destroy();
    await vi.advanceTimersByTimeAsync(100000);
    expect(sockets).toHaveLength(1);
  });

  it('honors an explicit initialize queued after a racing destroy', async () => {
    const { service, sockets } = fixture();
    await Promise.all([service.initialize(), service.destroy(), service.initialize()]);
    expect(sockets).toHaveLength(1);
    sockets[0].ev.emit('connection.update', { qr: 'fresh-qr' });
    expect(service.getLatestQrCode()).toBe('fresh-qr');
  });

  it('clears persisted credentials when logout is requested after destroy', async () => {
    const { service, socket, directory } = await connected();
    socket.ev.emit('creds.update', { registered: true });
    await service.destroy();
    await service.logout();
    const next = fixture({ directory });
    await next.service.initialize();
    expect(next.configs[0].auth.creds.registered).toBe(false);
  });

  it('drops the connection on a rejected credential save and tries again later, keeping the sign-in', async () => {
    const original = BaileysStore.prototype.createAuthState;
    vi.spyOn(BaileysStore.prototype, 'createAuthState').mockImplementation(async function (this: BaileysStore) {
      const auth = await original.call(this);
      return { ...auth, saveCreds: async () => { throw new Error('disk full'); } };
    });
    const { service, socket, sockets } = await connected();
    socket.ev.emit('creds.update', { registered: true });
    await vi.waitFor(() => expect(service.isAuthenticated()).toBe(false));
    expect(socket.end).toHaveBeenCalledOnce();
    expect(service.getStatus().connection).toMatchObject({ state: 'reconnecting', lastReason: expect.stringContaining('could not save') });
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
  });
});

describe('Baileys persisted history and opaque IDs', () => {
  it('reports unsynchronized history explicitly instead of returning empty results', async () => {
    const { service, socket } = await connected();
    expect(service.getStatus().history.state).toBe('syncing');
    await expect(service.listChats()).rejects.toThrow('history has not arrived');
    sync(socket);
    expect(service.getStatus().history.state).toBe('available');
    expect(await service.listChats()).toEqual([]);
  });

  it('allows querying live records before phone history arrives and labels them partial', async () => {
    const { service, socket } = await connected();
    socket.ev.emit('messages.upsert', { messages: [oldMessage()], type: 'notify' });
    expect(await service.getMessages(peer, 1)).toHaveLength(1);
    expect(await service.listChats()).toHaveLength(1);
    expect(service.getStatus().history.state).toBe('syncing');
    expect(service.getStatus().history.note).toContain('only locally observed records');
  });

  it('does not mistake the first history notification for completed synchronization', async () => {
    const { service, socket } = await connected();
    socket.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [], isLatest: true, progress: 10, syncType: 2 });
    expect(service.getStatus().history.state).toBe('syncing');
    socket.ev.emit('messaging-history.status', { syncType: 2, status: 'complete', explicit: true });
    expect(service.getStatus().history.state).toBe('available');
  });

  it('normalizes c.us aliases, preserves group participant identities and round-trips message IDs', async () => {
    const { service, socket, configs } = await connected();
    const first = oldMessage({ remoteJid: group, participant: peer }, 'first');
    const second = oldMessage({ remoteJid: group, participant: '12025550103@s.whatsapp.net' }, 'second');
    sync(socket, [first, second, oldMessage()]);
    const messages = await service.getMessages(group, 2);
    expect(messages.map(message => message.id)[0]).not.toBe(messages[1].id);
    expect(messages.every(message => message.chatId === group && message.to === group)).toBe(true);
    for (const message of messages) expect(await service.getMessageById(message.id)).toEqual(message);
    expect((await service.getMessages('12025550102@c.us', 1))[0].chatId).toBe(peer);
    expect(await configs[0].getMessage!(first.key)).toEqual({ conversation: 'first' });
    expect(decodeMessageId(encodeMessageId(first.key))).toEqual(first.key);
    await expect(service.getMessageById('false_whatsapp-web-message')).rejects.toThrow('Invalid Baileys message ID');
  });

  it('reports the sender of synced group messages that carry it outside the key', async () => {
    const { service, socket } = await connected();
    const synced: WAMessage = { ...oldMessage({ remoteJid: group, id: 'synced' }, 'from history'), participant: peer };
    sync(socket, [synced]);
    const [message] = await service.getMessages(group, 1);
    expect(message.from).toBe(peer);
    expect(message.to).toBe(group);
  });

  it('keeps voice-note transcripts beside the message and drops them with it', async () => {
    const { service, socket } = await connected();
    const note: WAMessage = { ...oldMessage({ remoteJid: group, id: 'voice' }), participant: peer,
      message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } } };
    sync(socket, [note, oldMessage({ remoteJid: group, id: 'other' }, 'text')]);
    const [voice] = (await service.getMessages(group, 5)).filter(message => message.type === 'ptt');
    expect(service.getVoiceTranscript(voice.id)).toBeUndefined();
    service.saveVoiceTranscript(voice.id, 'Hallo zusammen');
    socket.ev.emit('messages.update', [{ key: note.key, update: { status: 4 } }]);
    expect(service.getVoiceTranscript(voice.id)).toBe('Hallo zusammen');
    socket.ev.emit('messages.delete', { keys: [note.key] });
    expect(service.getVoiceTranscript(voice.id)).toBeUndefined();
    expect(service.getVoiceTranscript('not-an-id')).toBeUndefined();
  });

  it('persists LID aliases and retains previously returned IDs after account restart', async () => {
    const { service, socket, directory } = await connected();
    const lid = '999888777@lid';
    sync(socket, [oldMessage({ remoteJid: lid })]);
    const id = (await service.getMessages(lid, 1))[0].id;
    socket.ev.emit('lid-mapping.update', { lid, pn: peer });
    expect((await service.getMessageById(id))?.chatId).toBe(peer);
    await service.destroy();
    const restored = await connected({ directory });
    expect((await restored.service.getMessages('12025550102@c.us', 1))[0].id).toBe(id);
  });

  it('applies incremental contact, chat, message update and delete events', async () => {
    const { service, socket } = await connected();
    sync(socket, [oldMessage()]);
    socket.ev.emit('contacts.upsert', [{ id: peer, name: 'Pat' }]);
    socket.ev.emit('contacts.update', [{ id: peer, notify: 'Patrick' }]);
    expect((await service.searchContacts('pat'))[0]).toMatchObject({ name: 'Pat', pushname: 'Patrick' });
    socket.ev.emit('chats.update', [{ id: peer, unreadCount: 3 }]);
    expect((await service.getChatById(peer))?.unreadCount).toBe(3);
    socket.ev.emit('chats.update', [{ id: peer, unreadCount: 1 }]);
    expect((await service.getChatById(peer))?.unreadCount).toBe(4);
    socket.ev.emit('chats.update', [{ id: peer, unreadCount: -1 }]);
    expect((await service.getChatById(peer))?.unreadCount).toBe(0);
    const id = encodeMessageId(oldMessage().key);
    socket.ev.emit('messages.update', [{ key: oldMessage().key, update: { message: { conversation: 'edited' } } }]);
    expect((await service.getMessageById(id))?.body).toBe('edited');
    socket.ev.emit('messages.delete', { keys: [oldMessage().key] });
    expect(await service.getMessageById(id)).toBeNull();
    socket.ev.emit('chats.delete', [peer]);
    expect(await service.getChatById(peer)).toBeNull();
  });

  it('bounds on-demand history requests and reuses the persisted window when the phone does not respond', async () => {
    vi.useFakeTimers();
    const { service, socket } = await connected({ requestTimeout: 10 });
    sync(socket, [oldMessage()]);
    const pending = service.getMessages(peer, 500);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toHaveLength(1);
    expect(socket.fetchMessageHistory).toHaveBeenCalledWith(100, oldMessage().key, 1700000000000);
    expect(await service.getMessages(peer, 500)).toHaveLength(1);
    expect(socket.fetchMessageHistory).toHaveBeenCalledOnce();
    expect(service.getStatus().history.note).toContain('incomplete');
  });
});

describe('Baileys sending and media', () => {
  it('caches group metadata and invalidates it when membership or group details change', async () => {
    const { socket, configs } = await connected();
    const getMetadata = configs[0].cachedGroupMetadata!;
    await getMetadata(group);
    await getMetadata(group);
    expect(socket.groupMetadata).toHaveBeenCalledOnce();
    socket.ev.emit('group-participants.update', { id: group });
    await getMetadata(group);
    expect(socket.groupMetadata).toHaveBeenCalledTimes(2);
    socket.ev.emit('groups.update', [{ id: group, subject: 'Renamed' }]);
    await getMetadata(group);
    expect(socket.groupMetadata).toHaveBeenCalledTimes(3);
  });

  it('sends once, persists the returned key and propagates ambiguous failures without retrying', async () => {
    const { service, socket } = await connected();
    const result = await service.sendMessage('12025550102@c.us', 'sent text');
    expect(socket.sendMessage).toHaveBeenCalledWith(peer, { text: 'sent text' });
    expect((await service.getMessageById(result.id))?.body).toBe('sent text');
    socket.sendMessage.mockRejectedValueOnce(new Error('unknown outcome'));
    await expect(service.sendMessage(peer, 'second')).rejects.toThrow('unknown outcome');
    expect(socket.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('selects image/document/audio payloads and marks voice notes as Opus PTT', async () => {
    const { service, socket } = await connected();
    await service.sendMediaFromBase64(peer, 'aGVsbG8=', 'image/png', 'photo.png', 'caption');
    expect(socket.sendMessage).toHaveBeenLastCalledWith(peer, { image: Buffer.from('hello'), mimetype: 'image/png', caption: 'caption' });
    await service.sendMediaFromBase64(peer, 'aGVsbG8=', 'application/pdf', 'file.pdf', 'document caption');
    expect(socket.sendMessage).toHaveBeenLastCalledWith(peer, expect.objectContaining({ document: Buffer.from('hello'), fileName: 'file.pdf', caption: 'document caption' }));
    await service.sendMediaFromBase64(peer, 'aGVsbG8=', 'audio/mpeg');
    expect(socket.sendMessage).toHaveBeenLastCalledWith(peer, expect.objectContaining({ audio: Buffer.from('hello'), ptt: false }));
    await service.sendVoiceNote(peer, 'C:/audio.ogg');
    expect(socket.sendMessage).toHaveBeenLastCalledWith(peer, { audio: { url: 'C:/audio.ogg' }, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  });

  it('downloads persisted wrapped media and preserves its MIME type and filename', async () => {
    const { service, socket, downloadMedia } = await connected();
    const raw: WAMessage = { ...oldMessage(), message: { ephemeralMessage: { message: { documentMessage: {
      mimetype: 'application/pdf', fileName: 'notes.pdf', mediaKey: Buffer.from([1, 2, 3]),
    } } } } };
    sync(socket, [raw]);
    const id = encodeMessageId(raw.key);
    expect((await service.getMessageById(id))?.hasMedia).toBe(true);
    expect(await service.downloadMedia(id)).toEqual({ mimetype: 'application/pdf', filename: 'notes.pdf', data: Buffer.from('downloaded').toString('base64') });
    expect(downloadMedia).toHaveBeenCalledOnce();
  });

  it('aborts a prepared media send if logout and pairing changed the connection', async () => {
    const { service, socket, sockets } = await connected();
    let provideResponse!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { provideResponse = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const send = service.sendMedia(peer, 'https://example.com/media.txt');
    const rejected = expect(send).rejects.toThrow('Nothing was sent');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await service.logout();
    await service.initialize();
    sockets[1].ev.emit('connection.update', { connection: 'open' });
    provideResponse(new Response('a text document', { headers: { 'content-type': 'text/plain' } }));
    await rejected;
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(sockets[1].sendMessage).not.toHaveBeenCalled();
  });

  it('caps downloaded media even when its size was not supplied in message metadata', async () => {
    const { service, socket, downloadMedia } = await connected();
    const raw: WAMessage = { ...oldMessage(), message: { documentMessage: { mimetype: 'application/pdf' } } };
    sync(socket, [raw]);
    const oneMiB = Buffer.alloc(1024 * 1024);
    const stream = Readable.from((function* () { for (let index = 0; index < 65; index++) yield oneMiB; })());
    downloadMedia.mockResolvedValueOnce(stream);
    await expect(service.downloadMedia(encodeMessageId(raw.key))).rejects.toThrow('64 MiB');
    expect(stream.destroyed).toBe(true);
  });
});

describe('BaileysService inbound messages', () => {
  it('reports live messages with their mentions, and never history', async () => {
    const { service, sockets } = await connected();
    const seen: Array<{ body: string; mentionedIds?: string[]; quotedMessageId?: string }> = [];
    service.onMessage(message => seen.push(message));
    sockets[0].ev.emit('messages.upsert', { type: 'append', messages: [oldMessage({ id: 'old' }, 'history')] });
    sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{
      key: { id: 'live', remoteJid: group, participant: peer, fromMe: false },
      message: { extendedTextMessage: { text: '@bot hello', contextInfo: { mentionedJid: [user], stanzaId: 'quoted-id' } } },
      messageTimestamp: 1700000001,
    }] });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].body).toBe('@bot hello');
    expect(seen[0].mentionedIds).toEqual([user]);
    expect(seen[0].quotedMessageId).toBe('quoted-id');
    expect(service.getSelfIds()).toContain(user);
  });

  it('keeps storing and telling other listeners when one listener fails', async () => {
    const { service, sockets } = await connected();
    const seen: string[] = [];
    service.onMessage(() => { throw new Error('listener failed'); });
    service.onMessage(message => seen.push(message.body));
    sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [oldMessage({ id: 'live-2' }, 'still here')] });
    await vi.waitFor(() => expect(seen).toEqual(['still here']));
    expect((await service.getMessages(peer, 10)).some(message => message.body === 'still here')).toBe(true);
  });

  it('sends a reaction to the exact message', async () => {
    const { service, sockets } = await connected();
    const key = { id: 'target', remoteJid: group, participant: peer, fromMe: false };
    await service.sendReaction(encodeMessageId(key), '💭');
    expect(sockets[0].sendMessage).toHaveBeenCalledWith(group, { react: { text: '💭', key } });
  });
});
