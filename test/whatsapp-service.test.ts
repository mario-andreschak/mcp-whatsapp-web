import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { makeService } from './helpers/fake-client.js';

const { MessageMedia } = createRequire(import.meta.url)('whatsapp-web.js');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.HEALTH_CHECK_INTERVAL_MS;
});

describe('browser configuration', () => {
  it('retains the LocalAuth profile and native browser identity with the sandbox enabled', () => {
    vi.stubEnv('WHATSAPP_SESSION_DIR', '');
    vi.stubEnv('WHATSAPP_HEADLESS', '');
    vi.stubEnv('WHATSAPP_NO_SANDBOX', '');
    const { fake } = makeService();
    const options = fake().options;
    expect(options.authStrategy).toMatchObject({ dataPath: path.join(process.cwd(), 'whatsapp-sessions') });
    expect(options.userAgent).toBe(false);
    expect(options.puppeteer?.headless).toBe(true);
    expect(options.puppeteer?.ignoreDefaultArgs).toEqual(['--enable-automation']);
    expect(options.puppeteer?.args).not.toContain('--no-sandbox');
    expect(options.puppeteer?.args).not.toContain('--disable-setuid-sandbox');
    expect(options.puppeteer?.args).not.toContain('--disable-gpu');
    expect(options.puppeteer?.args).not.toContain('--disable-accelerated-2d-canvas');
    expect(options.puppeteer?.args).not.toContain('--no-zygote');
  });

  it('keeps profile overrides on reconnect and honors explicit headed and container options', async () => {
    vi.useFakeTimers();
    vi.stubEnv('WHATSAPP_SESSION_DIR', 'test-session-profile');
    vi.stubEnv('WHATSAPP_HEADLESS', 'false');
    vi.stubEnv('WHATSAPP_NO_SANDBOX', 'true');
    const { service, fake, fakes } = makeService();
    fake().emit('disconnected', 'NAVIGATION');
    await vi.advanceTimersByTimeAsync(5100);
    expect(fakes).toHaveLength(2);
    for (const client of fakes) {
      expect(client.options.authStrategy).toMatchObject({ dataPath: path.resolve('test-session-profile') });
      expect(client.options.puppeteer?.headless).toBe(false);
      expect(client.options.puppeteer?.args).toContain('--no-sandbox');
      expect(client.options.puppeteer?.args).toContain('--disable-setuid-sandbox');
    }
    await service.destroy();
  });
});

describe('backend-neutral operations', () => {
  const outgoing = {
    id: { _serialized: 'true_123@c.us_SENT' },
    body: 'hello',
    from: 'me@c.us',
    to: '123@c.us',
    timestamp: 1_700_000_000,
    fromMe: true,
    hasMedia: false,
    type: 'chat',
  };

  it('exposes backend and history availability across authentication', () => {
    const { service, fake } = makeService();
    expect(service.backend).toBe('webjs');
    expect(service.getStatus()).toMatchObject({ backend: 'webjs', authenticated: false, history: { state: 'unavailable' } });
    fake().emit('authenticated');
    expect(service.getStatus().history.state).toBe('syncing');
    fake().emit('ready');
    expect(service.getStatus()).toMatchObject({ authenticated: true, history: { state: 'available' } });
  });

  it('returns opaque string IDs and timestamps for text and media sends', async () => {
    const { service, fake } = makeService();
    fake().emit('ready');
    fake().sendMessage.mockImplementation(async () => outgoing);
    const expected = { id: outgoing.id._serialized, timestamp: outgoing.timestamp };
    await expect(service.sendMessage('123@c.us', 'hello')).resolves.toEqual(expected);
    expect(fake().sendMessage).toHaveBeenLastCalledWith('123@c.us', 'hello');

    await expect(service.sendMediaFromBase64('123@c.us', 'aGVsbG8=', 'text/plain', 'hello.txt', 'caption')).resolves.toEqual(expected);
    expect(fake().sendMessage).toHaveBeenLastCalledWith('123@c.us', expect.objectContaining({
      data: 'aGVsbG8=', mimetype: 'text/plain', filename: 'hello.txt',
    }), { caption: 'caption' });

    const media = new MessageMedia('image/png', 'aGVsbG8=', 'picture.png');
    vi.spyOn(MessageMedia, 'fromFilePath').mockReturnValue(media);
    vi.spyOn(MessageMedia, 'fromUrl').mockResolvedValue(media);
    await expect(service.sendMedia('123@c.us', 'picture.png', 'photo')).resolves.toEqual(expected);
    await expect(service.sendMedia('123@c.us', 'https://example.com/picture.png', 'photo')).resolves.toEqual(expected);
    expect(MessageMedia.fromUrl).toHaveBeenCalledWith('https://example.com/picture.png', { unsafeMime: true });
    expect(fake().sendMessage).toHaveBeenLastCalledWith('123@c.us', media, { caption: 'photo' });
  });

  it('waits for readiness before reading or sending a voice note', async () => {
    vi.useFakeTimers();
    const { service, fake } = makeService();
    const media = new MessageMedia('audio/ogg', 'aGVsbG8=', 'note.ogg');
    const readMedia = vi.spyOn(MessageMedia, 'fromFilePath').mockReturnValue(media);
    fake().sendMessage.mockImplementation(async () => outgoing);
    const pending = service.sendVoiceNote('123@c.us', 'note.ogg');
    expect(readMedia).not.toHaveBeenCalled();
    expect(fake().sendMessage).not.toHaveBeenCalled();
    fake().emit('ready');
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toEqual({ id: outgoing.id._serialized, timestamp: outgoing.timestamp });
    expect(readMedia).toHaveBeenCalledWith('note.ogg');
    expect(fake().sendMessage).toHaveBeenCalledWith('123@c.us', media, { sendAudioAsVoice: true });
  });

  it('preserves chat identity for incoming and outgoing message context', async () => {
    const { service, fake } = makeService();
    fake().emit('ready');
    fake().getMessageById.mockResolvedValue(outgoing);
    expect(await service.getMessageById(outgoing.id._serialized)).toMatchObject({ chatId: '123@c.us' });
    fake().getMessageById.mockResolvedValue({ ...outgoing, fromMe: false, from: 'group@g.us', to: 'me@c.us' });
    expect(await service.getMessageById('incoming')).toMatchObject({ chatId: 'group@g.us' });
  });

  it('includes the last message when fetching a chat and respects list omission', async () => {
    const { service, fake } = makeService();
    fake().emit('ready');
    const chat = {
      id: { _serialized: '123@c.us' }, name: 'Alice', isGroup: false,
      timestamp: outgoing.timestamp, unreadCount: 0, lastMessage: outgoing,
    };
    fake().getChatById.mockResolvedValue(chat);
    fake().getChats.mockResolvedValue([chat]);
    expect(await service.getChatById('123@c.us')).toMatchObject({
      lastMessage: { id: outgoing.id._serialized, chatId: '123@c.us', timestamp: outgoing.timestamp },
    });
    expect((await service.listChats(20))[0].lastMessage).toMatchObject({ id: outgoing.id._serialized, chatId: '123@c.us' });
    expect((await service.listChats(20, false))[0].lastMessage).toBeUndefined();
  });
});

describe('authentication state machine', () => {
  it('starts unauthenticated with no QR or pairing code', () => {
    const { service } = makeService();
    expect(service.isAuthenticated()).toBe(false);
    expect(service.getLatestQrCode()).toBeNull();
    expect(service.getLatestPairingCode()).toBeNull();
  });

  it('tracks qr -> authenticated -> ready transitions', () => {
    const { service, fake } = makeService();
    fake().emit('qr', 'qr-data');
    expect(service.getLatestQrCode()).toBe('qr-data');
    expect(service.isAuthenticated()).toBe(false);

    fake().emit('authenticated');
    expect(service.getLatestQrCode()).toBeNull();
    expect(service.isAuthenticated()).toBe(false); // authenticated but not ready yet

    fake().emit('ready');
    expect(service.isAuthenticated()).toBe(true);
  });

  it('stores and clears pairing codes', () => {
    const { service, fake } = makeService();
    fake().emit('code', 'WXYZ9876');
    expect(service.getLatestPairingCode()).toBe('WXYZ9876');
    fake().emit('authenticated');
    expect(service.getLatestPairingCode()).toBeNull();
  });

  it('clears state on disconnect', () => {
    const { service, fake } = makeService();
    fake().emit('ready');
    fake().emit('disconnected', 'NAVIGATION');
    expect(service.isAuthenticated()).toBe(false);
    expect(service.getLatestQrCode()).toBeNull();
  });
});

describe('ensureReady', () => {
  it('resolves immediately when ready', async () => {
    const { service, fake } = makeService();
    fake().emit('ready');
    await expect(service.ensureReady(1000)).resolves.toBeUndefined();
  });

  it('waits for a late ready event instead of failing fast', async () => {
    const { service, fake } = makeService();
    const pending = service.ensureReady(5000);
    setTimeout(() => fake().emit('ready'), 400);
    await expect(pending).resolves.toBeUndefined();
  });

  it('fails with an actionable error once a QR code is stably pending', async () => {
    const { service, fake } = makeService();
    fake().emit('qr', 'qr-data');
    await expect(service.ensureReady(10_000)).rejects.toThrow(/not authenticated.*QR code/is);
  });

  it('keeps waiting during the post-scan window (loading_screen while QR pending)', async () => {
    const { service, fake } = makeService();
    fake().emit('qr', 'qr-data');
    fake().emit('loading_screen', 50, 'loading'); // user just scanned
    const pending = service.ensureReady(8000);
    setTimeout(() => {
      fake().emit('authenticated');
      fake().emit('ready');
    }, 3500); // past the 3s QR grace period - only isAuthenticating keeps it alive
    await expect(pending).resolves.toBeUndefined();
  });

  it('times out with a descriptive error when never ready', async () => {
    const { service } = makeService();
    await expect(service.ensureReady(600)).rejects.toThrow(/did not become ready/i);
  });
});

describe('waitForAuthOutcome', () => {
  it('returns immediately when ready', async () => {
    const { service, fake } = makeService();
    fake().emit('ready');
    const start = Date.now();
    await service.waitForAuthOutcome(5000);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('returns after the grace period when a QR is stably pending', async () => {
    const { service, fake } = makeService();
    fake().emit('qr', 'qr-data');
    const start = Date.now();
    await service.waitForAuthOutcome(10_000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(6000);
    expect(service.isAuthenticated()).toBe(false);
  });

  it('waits through the post-scan window and reports authenticated', async () => {
    const { service, fake } = makeService();
    fake().emit('qr', 'qr-data');
    fake().emit('loading_screen', 10, 'loading');
    const pending = service.waitForAuthOutcome(10_000);
    setTimeout(() => {
      fake().emit('authenticated');
      fake().emit('ready');
    }, 3500);
    await pending;
    expect(service.isAuthenticated()).toBe(true);
  });
});

describe('reconnection', () => {
  it('schedules a reconnect with a new client after disconnect', async () => {
    vi.useFakeTimers();
    const { service, fakes, fake } = makeService();
    fake().emit('ready');
    fake().emit('disconnected', 'NAVIGATION');
    expect(fakes.length).toBe(1);

    await vi.advanceTimersByTimeAsync(5100); // first backoff step is 5s
    expect(fakes.length).toBe(2);
    expect(fakes[1].initialize).toHaveBeenCalled();
    expect(service.isAuthenticated()).toBe(false);
  });

  it('uses exponential backoff for repeated failures', async () => {
    vi.useFakeTimers();
    const { fakes, fake } = makeService();
    fake().emit('disconnected', 'x');
    await vi.advanceTimersByTimeAsync(5100);
    expect(fakes.length).toBe(2);

    // The reconnected client disconnects again -> next delay is 10s
    fakes[1].emit('disconnected', 'x');
    await vi.advanceTimersByTimeAsync(5100);
    expect(fakes.length).toBe(2); // not yet - backoff doubled
    await vi.advanceTimersByTimeAsync(5100);
    expect(fakes.length).toBe(3);
  });

  it('resets the backoff counter once ready', async () => {
    vi.useFakeTimers();
    const { fakes, fake } = makeService();
    fake().emit('disconnected', 'x');
    await vi.advanceTimersByTimeAsync(5100);
    fakes[1].emit('ready'); // recovery resets reconnectAttempts
    fakes[1].emit('disconnected', 'x');
    await vi.advanceTimersByTimeAsync(5100); // back to the 5s step
    expect(fakes.length).toBe(3);
  });

  it('does not reconnect after an intentional destroy', async () => {
    vi.useFakeTimers();
    const { service, fakes, fake } = makeService();
    fake().emit('ready');
    await service.destroy();
    fake().emit('disconnected', 'LOGOUT');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakes.length).toBe(1);
  });

  it('reconnects (for a fresh QR) after an authentication failure and notifies listeners', async () => {
    vi.useFakeTimers();
    const { service, fakes, fake } = makeService();
    const invalidated = vi.fn();
    service.onSessionInvalidated(invalidated);
    fake().emit('auth_failure', 'nope');
    expect(invalidated).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5100);
    expect(fakes.length).toBe(2);
  });
});

describe('health check', () => {
  it('triggers a reconnect when the client state degrades silently', async () => {
    vi.useFakeTimers();
    process.env.HEALTH_CHECK_INTERVAL_MS = '1000';
    const { fakes, fake } = makeService();
    fake().emit('ready');
    fake().getState.mockResolvedValue('CONFLICT');

    await vi.advanceTimersByTimeAsync(1100); // health check fires
    await vi.advanceTimersByTimeAsync(5100); // reconnect backoff
    expect(fakes.length).toBe(2);
  });

  it('treats getState errors as a lost connection', async () => {
    vi.useFakeTimers();
    process.env.HEALTH_CHECK_INTERVAL_MS = '1000';
    const { fakes, fake } = makeService();
    fake().emit('ready');
    fake().getState.mockRejectedValue(new Error('page crashed'));

    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(5100);
    expect(fakes.length).toBe(2);
  });
});

describe('logout', () => {
  it('logs out, recreates the client, notifies listeners, and suppresses auto-reconnect', async () => {
    vi.useFakeTimers();
    const { service, fakes, fake } = makeService();
    const first = fake();
    first.emit('ready');
    const invalidated = vi.fn();
    service.onSessionInvalidated(invalidated);

    await service.logout();
    expect(first.logout).toHaveBeenCalled();
    expect(first.destroy).toHaveBeenCalled();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(fakes.length).toBe(2); // fresh client for the next initialize()

    first.emit('disconnected', 'LOGOUT'); // late event from the old client
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakes.length).toBe(2); // no reconnect scheduled
  });
});

describe('requestPairingCode', () => {
  it('rejects when already authenticated', async () => {
    const { service, fake } = makeService();
    fake().emit('ready');
    await expect(service.requestPairingCode('4915112345678')).rejects.toThrow(/already authenticated/i);
  });

  it('rejects invalid phone numbers', async () => {
    const { service, fake } = makeService();
    fake().emit('qr', 'qr-data');
    await expect(service.requestPairingCode('123')).rejects.toThrow(/invalid phone number/i);
  });

  it('rejects before the client reaches the pairing (QR) stage', async () => {
    const { service } = makeService();
    await expect(service.requestPairingCode('4915112345678')).rejects.toThrow(/not at the pairing stage/i);
  });

  it('sanitizes the number and returns the code', async () => {
    const { service, fake } = makeService();
    fake().emit('qr', 'qr-data');
    const code = await service.requestPairingCode('+49 151 1234-5678');
    expect(code).toBe('ABCD1234');
    expect(fake().requestPairingCode).toHaveBeenCalledWith('4915112345678', true);
  });
});

describe('searchContacts', () => {
  it('tolerates contacts with a null number (regression)', async () => {
    const { service, fake } = makeService();
    fake().emit('ready');
    fake().getContacts.mockResolvedValue([
      {
        id: { _serialized: '1@c.us' }, name: 'Tatiana', pushname: 'Tati', number: null,
        isMe: false, isUser: true, isGroup: false, isWAContact: true, isMyContact: true,
      },
      {
        id: { _serialized: '2@c.us' }, name: 'Bob', pushname: 'Bob', number: '4912345678',
        isMe: false, isUser: true, isGroup: false, isWAContact: true, isMyContact: true,
      },
    ]);
    const results = await service.searchContacts('tatiana');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Tatiana');
    expect(results[0].number).toBeNull();
  });

  it('matches by number and pushname too', async () => {
    const { service, fake } = makeService();
    fake().emit('ready');
    fake().getContacts.mockResolvedValue([
      {
        id: { _serialized: '2@c.us' }, name: undefined, pushname: 'Bobby', number: '4912345678',
        isMe: false, isUser: true, isGroup: false, isWAContact: true, isMyContact: true,
      },
    ]);
    expect(await service.searchContacts('491234')).toHaveLength(1);
    expect(await service.searchContacts('bobby')).toHaveLength(1);
    expect(await service.searchContacts('nomatch')).toHaveLength(0);
  });
});
