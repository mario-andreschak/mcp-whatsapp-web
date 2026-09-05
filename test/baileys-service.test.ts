import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DisconnectReason, type UserFacingSocketConfig, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';
import { BaileysService, decodeMessageId, encodeMessageId, type BaileysSocket } from '../src/services/baileys.js';
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

function fixture(options: { directory?: string; requestTimeout?: number } = {}) {
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
    downloadMedia: downloadMedia as never, reconnectDelayMs: 1, historyRequestTimeoutMs: options.requestTimeout ?? 25 });
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

  it('invalidates credentials and listeners on remote logout without reconnecting', async () => {
    vi.useFakeTimers();
    const { service, socket, configs, sockets } = await connected();
    const invalidated = vi.fn();
    service.onSessionInvalidated(invalidated);
    socket.ev.emit('creds.update', { registered: true });
    sync(socket, [oldMessage()]);
    close(socket, DisconnectReason.loggedOut);
    expect(service.isAuthenticated()).toBe(false);
    expect(invalidated).toHaveBeenCalledOnce();
    expect(service.getStatus().history.messageCount).toBe(0);
    await vi.advanceTimersByTimeAsync(100000);
    expect(sockets).toHaveLength(1);
    await service.initialize();
    expect(configs[1].auth.creds.registered).toBe(false);
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

  it('limits repeated reconnects and suppresses stale socket callbacks', async () => {
    vi.useFakeTimers();
    const { service, sockets } = await connected();
    const stale = sockets[0].ev.listeners('connection.update')[0];
    close(sockets[0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    stale({ connection: 'open' });
    expect(service.isAuthenticated()).toBe(false);
    for (let attempt = 1; attempt <= 8; attempt++) {
      close(sockets[sockets.length - 1]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(sockets).toHaveLength(9);
    await expect(service.ensureReady(0)).rejects.toThrow('reconnect attempts exhausted');
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

  it('stops on a rejected credential save without an unhandled promise rejection', async () => {
    const original = BaileysStore.prototype.createAuthState;
    vi.spyOn(BaileysStore.prototype, 'createAuthState').mockImplementation(async function (this: BaileysStore) {
      const auth = await original.call(this);
      return { ...auth, saveCreds: async () => { throw new Error('disk full'); } };
    });
    const { service, socket } = await connected();
    socket.ev.emit('creds.update', { registered: true });
    await vi.waitFor(() => expect(service.isAuthenticated()).toBe(false));
    await expect(service.ensureReady(0)).rejects.toThrow('could not persist');
    expect(socket.end).toHaveBeenCalledOnce();
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
