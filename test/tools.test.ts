import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAuthTools } from '../src/tools/auth.js';
import { registerChatTools } from '../src/tools/chats.js';
import { registerContactTools } from '../src/tools/contacts.js';
import { registerMessageTools } from '../src/tools/messages.js';
import type { WhatsAppService } from '../src/services/whatsapp.js';

/** Duck-typed WhatsAppService covering everything the tool layer calls. */
function makeFakeService() {
  return {
    isAuthenticated: vi.fn(() => true),
    waitForAuthOutcome: vi.fn(async () => {}),
    getLatestQrCode: vi.fn((): string | null => null),
    getLatestPairingCode: vi.fn((): string | null => null),
    requestPairingCode: vi.fn(async () => 'ABCD1234'),
    logout: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
    searchContacts: vi.fn(async () => []),
    getContactById: vi.fn(async () => null),
    listChats: vi.fn(async () => []),
    getChatById: vi.fn(async () => null),
    getMessages: vi.fn(async () => []),
    getMessageById: vi.fn(async () => null),
    sendMessage: vi.fn(async () => ({ id: { _serialized: 'sent-1' } })),
    getClient: vi.fn(),
  };
}
type FakeService = ReturnType<typeof makeFakeService>;

let fakeService: FakeService;
let client: Client;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  fakeService = makeFakeService();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const serviceAsReal = fakeService as unknown as WhatsAppService;
  registerAuthTools(server, serviceAsReal);
  registerChatTools(server, serviceAsReal);
  registerContactTools(server, serviceAsReal);
  registerMessageTools(server, serviceAsReal);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await cleanup();
});

const text = (result: unknown): string =>
  (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? '';

describe('tool registration', () => {
  it('exposes the expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      'get_qr_code', 'request_pairing_code', 'check_auth_status', 'logout',
      'search_contacts', 'list_chats', 'list_messages', 'get_last_interaction', 'send_message',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('documents the any-event-type trap in the description (feedback from live use)', async () => {
    const { tools } = await client.listTools();
    const lastInteraction = tools.find((t) => t.name === 'get_last_interaction');
    expect(lastInteraction?.description).toMatch(/ANY type/);
    expect(lastInteraction?.description).toMatch(/list_messages/);
  });
});

describe('check_auth_status', () => {
  it('reports authenticated', async () => {
    const result = await client.callTool({ name: 'check_auth_status', arguments: {} });
    expect(fakeService.waitForAuthOutcome).toHaveBeenCalled();
    expect(text(result)).toMatch(/currently authenticated/i);
  });

  it('reports a pending pairing code when unauthenticated', async () => {
    fakeService.isAuthenticated.mockReturnValue(false);
    fakeService.getLatestPairingCode.mockReturnValue('WXYZ9876');
    const result = await client.callTool({ name: 'check_auth_status', arguments: {} });
    expect(text(result)).toContain('WXYZ9876');
  });

  it('points to get_qr_code when unauthenticated with no pairing code', async () => {
    fakeService.isAuthenticated.mockReturnValue(false);
    const result = await client.callTool({ name: 'check_auth_status', arguments: {} });
    expect(text(result)).toMatch(/get_qr_code/);
  });
});

describe('get_qr_code', () => {
  it('returns an image when a QR is pending', async () => {
    fakeService.isAuthenticated.mockReturnValue(false);
    fakeService.getLatestQrCode.mockReturnValue('1@abcdef,ghijkl,2');
    const result = await client.callTool({ name: 'get_qr_code', arguments: {} });
    const content = (result as { content: Array<{ type: string; mimeType?: string }> }).content[0];
    expect(content.type).toBe('image');
    expect(content.mimeType).toBe('image/png');
  });

  it('says so when already authenticated', async () => {
    const result = await client.callTool({ name: 'get_qr_code', arguments: {} });
    expect(text(result)).toMatch(/already authenticated/i);
  });

  it('asks for patience when no QR is available yet', async () => {
    fakeService.isAuthenticated.mockReturnValue(false);
    const result = await client.callTool({ name: 'get_qr_code', arguments: {} });
    expect(text(result)).toMatch(/try again/i);
  });
});

describe('request_pairing_code', () => {
  it('returns the code with usage instructions', async () => {
    fakeService.isAuthenticated.mockReturnValue(false);
    const result = await client.callTool({
      name: 'request_pairing_code',
      arguments: { phone_number: '4915112345678' },
    });
    expect(text(result)).toContain('ABCD1234');
    expect(text(result)).toMatch(/Linked Devices/);
  });

  it('propagates validation errors as isError results', async () => {
    fakeService.isAuthenticated.mockReturnValue(false);
    fakeService.requestPairingCode.mockRejectedValue(new Error('Invalid phone number'));
    const result = await client.callTool({
      name: 'request_pairing_code',
      arguments: { phone_number: 'abc' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toMatch(/Invalid phone number/);
  });
});

describe('data tools', () => {
  it('list_chats returns the service data as JSON', async () => {
    fakeService.listChats.mockResolvedValue([
      { id: '1@c.us', name: 'Alice', isGroup: false, unreadCount: 0, timestamp: 1 },
    ] as never);
    const result = await client.callTool({ name: 'list_chats', arguments: { limit: 5 } });
    const parsed = JSON.parse(text(result));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Alice');
    expect(fakeService.listChats).toHaveBeenCalledWith(5, true);
  });

  it('service errors surface as isError results, not protocol crashes', async () => {
    fakeService.listChats.mockRejectedValue(new Error('WhatsApp client not ready'));
    const result = await client.callTool({ name: 'list_chats', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toMatch(/not ready/);
  });

  it('logout logs out and reinitializes for a fresh QR', async () => {
    const result = await client.callTool({ name: 'logout', arguments: {} });
    expect(fakeService.logout).toHaveBeenCalled();
    expect(fakeService.initialize).toHaveBeenCalled();
    expect(text(result)).toMatch(/logged out/i);
  });
});
