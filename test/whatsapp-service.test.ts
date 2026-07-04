import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeService } from './helpers/fake-client.js';

afterEach(() => {
  vi.useRealTimers();
  delete process.env.HEALTH_CHECK_INTERVAL_MS;
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
