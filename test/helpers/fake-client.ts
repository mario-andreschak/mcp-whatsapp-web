import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type WAWebJS from 'whatsapp-web.js';
import { WhatsAppService } from '../../src/services/whatsapp.js';
import type { BrowserProcessManager } from '../../src/utils/browser-process-manager.js';

/**
 * In-memory stand-in for a whatsapp-web.js Client. Tests drive the service's
 * state machine by emitting the same events the real client would emit
 * ('qr', 'loading_screen', 'authenticated', 'ready', 'disconnected', ...).
 */
export class FakeClient extends EventEmitter {
  options: WAWebJS.ClientOptions;
  initialize = vi.fn(async () => {});
  destroy = vi.fn(async () => {});
  logout = vi.fn(async () => {});
  getState = vi.fn(async (): Promise<string> => 'CONNECTED');
  requestPairingCode = vi.fn(async () => 'ABCD1234');
  getContacts = vi.fn(async (): Promise<unknown[]> => []);
  getChats = vi.fn(async (): Promise<unknown[]> => []);
  getChatById = vi.fn(async (): Promise<unknown> => null);
  getContactById = vi.fn(async (): Promise<unknown> => null);
  getMessageById = vi.fn(async (): Promise<unknown> => null);
  sendMessage = vi.fn(async () => ({ id: { _serialized: 'sent-1' } }));

  constructor(options: WAWebJS.ClientOptions) {
    super();
    this.options = options;
  }
}

export function makeStubProcessManager(): BrowserProcessManager {
  return {
    cleanupOrphanedProcesses: vi.fn(async () => {}),
    registerProcess: vi.fn(),
    unregisterProcess: vi.fn(),
    killProcessTree: vi.fn(async () => true),
    findBrowsersUsingProfile: vi.fn(async () => []),
    killBrowsersUsingProfile: vi.fn(async () => 0),
  } as unknown as BrowserProcessManager;
}

/**
 * Build a WhatsAppService wired to FakeClients. `fakes` collects every client
 * the service creates (reconnects/logouts create new ones); `fake()` returns
 * the most recent.
 */
export function makeService() {
  const fakes: FakeClient[] = [];
  const service = new WhatsAppService({
    clientFactory: (options) => {
      const client = new FakeClient(options);
      fakes.push(client);
      return client as unknown as WAWebJS.Client;
    },
    browserProcessManager: makeStubProcessManager(),
  });
  return { service, fakes, fake: () => fakes[fakes.length - 1] };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
