import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { WhatsAppBackend } from '../src/services/backend.js';

const mocks = vi.hoisted(() => ({
  createBackend: vi.fn(),
  cleanupBrowsers: vi.fn(async () => {}),
  browserManager: vi.fn(),
}));

vi.mock('../src/services/backend-factory.js', () => ({ createWhatsAppBackend: mocks.createBackend }));
vi.mock('../src/utils/browser-process-manager.js', () => ({ BrowserProcessManager: mocks.browserManager }));

import { WhatsAppMcpServer } from '../src/server.js';

function makeBackend(backend: WhatsAppBackend['backend'] = 'baileys') {
  return {
    backend,
    initialize: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    isAuthenticated: vi.fn(() => true),
    getStatus: vi.fn(() => ({ backend, authenticated: true, history: { state: 'available' as const, note: 'Test history' } })),
    getLatestQrCode: vi.fn(() => null),
    getLatestPairingCode: vi.fn(() => null),
    requestPairingCode: vi.fn(async () => 'ABCD1234'),
    ensureReady: vi.fn(async () => {}),
    waitForAuthOutcome: vi.fn(async () => {}),
    onSessionInvalidated: vi.fn(),
    searchContacts: vi.fn(async () => []),
    getContactById: vi.fn(async () => null),
    listChats: vi.fn(async () => []),
    getChatById: vi.fn(async () => null),
    getMessages: vi.fn(async () => []),
    getMessageById: vi.fn(async () => null),
    sendMessage: vi.fn(async () => ({ id: 'sent-1', timestamp: 1 })),
    sendMedia: vi.fn(async () => ({ id: 'sent-1', timestamp: 1 })),
    sendMediaFromBase64: vi.fn(async () => ({ id: 'sent-1', timestamp: 1 })),
    sendVoiceNote: vi.fn(async () => ({ id: 'sent-1', timestamp: 1 })),
    downloadMedia: vi.fn(async () => null),
  } satisfies WhatsAppBackend;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// An ephemeral listener has no public address accessor. Inspect its bound port
// and active transports so assertions cover real HTTP resource cleanup.
function internals(server: WhatsAppMcpServer) {
  return server as unknown as {
    httpServer: HttpServer | null;
    httpTransports: Record<string, StreamableHTTPServerTransport>;
  };
}

const servers: WhatsAppMcpServer[] = [];
const clients: Client[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cleanupBrowsers.mockResolvedValue(undefined);
  mocks.browserManager.mockImplementation(function () {
    return { cleanupOrphanedProcesses: mocks.cleanupBrowsers };
  });
  vi.stubEnv('MCP_HTTP_PORT', '0');
  vi.stubEnv('MCP_HTTP_HOST', '127.0.0.1');
  vi.stubEnv('MCP_OAUTH', 'false');
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) {
    // Force-close connections if an assertion failed before shutdown completed.
    const listener = internals(server).httpServer;
    listener?.closeAllConnections();
    listener?.close();
    await server.shutdown().catch(() => {});
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('server lifecycle with selectable backends', () => {
  it('destroys a backend resolved after shutdown without starting it or creating a browser', async () => {
    const loading = deferred<WhatsAppBackend>();
    mocks.createBackend.mockReturnValue(loading.promise);
    const server = new WhatsAppMcpServer();
    servers.push(server);
    const starting = server.start('http');
    expect(mocks.createBackend).toHaveBeenCalledOnce();
    await server.shutdown();

    const backend = makeBackend('webjs');
    loading.resolve(backend);
    await starting;
    expect(backend.destroy).toHaveBeenCalledOnce();
    expect(backend.initialize).not.toHaveBeenCalled();
    expect(mocks.browserManager).not.toHaveBeenCalled();
    expect(internals(server).httpServer).toBeNull();
  });

  it('closes HTTP sessions and the listener even when backend teardown fails', async () => {
    const backend = makeBackend();
    const server = new WhatsAppMcpServer(backend);
    servers.push(server);
    await server.start('http');
    const listener = internals(server).httpServer!;
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP listener');

    const client = new Client({ name: 'lifecycle-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
    const activeTransports = Object.values(internals(server).httpTransports);
    expect(activeTransports).toHaveLength(1);
    const closeSession = vi.spyOn(activeTransports[0], 'close');
    const closeListener = vi.spyOn(listener, 'close');
    const destroyError = new Error('Session persistence failed');
    backend.destroy.mockRejectedValue(destroyError);

    await expect(server.shutdown()).rejects.toBe(destroyError);
    expect(closeSession).toHaveBeenCalledOnce();
    expect(closeListener).toHaveBeenCalled();
    expect(internals(server).httpTransports).toEqual({});
    expect(internals(server).httpServer).toBeNull();
    expect(listener.listening).toBe(false);
    expect(mocks.browserManager).not.toHaveBeenCalled();
  });

  it('does not initialize a browser backend if shutdown happens during pre-initialization cleanup', async () => {
    const cleanup = deferred<void>();
    mocks.cleanupBrowsers.mockReturnValueOnce(cleanup.promise);
    const backend = makeBackend('webjs');
    const server = new WhatsAppMcpServer(backend);
    servers.push(server);
    await server.start('http');
    expect(mocks.cleanupBrowsers).toHaveBeenCalledOnce();
    expect(backend.initialize).not.toHaveBeenCalled();
    await server.shutdown();
    cleanup.resolve();
    await cleanup.promise;
    await Promise.resolve();
    expect(backend.initialize).not.toHaveBeenCalled();
    expect(backend.destroy).toHaveBeenCalledOnce();
    expect(internals(server).httpServer).toBeNull();
  });
});
