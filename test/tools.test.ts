import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
// The v1 in-memory fixture transport checks backward compatibility; it is dev-only.
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAuthTools } from '../src/tools/auth.js';
import { registerChatTools } from '../src/tools/chats.js';
import { registerContactTools } from '../src/tools/contacts.js';
import { registerMessageTools } from '../src/tools/messages.js';
import type { WhatsAppBackend } from '../src/services/backend.js';
import { registerMediaTools } from '../src/tools/media.js';
import { AudioUtils } from '../src/utils/audio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Driver-neutral fake: deliberately has no browser client or web.js objects. */
function makeFakeService() {
  return {
    backend: 'baileys' as const,
    ensureReady: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ backend: 'baileys', authenticated: true, history: { state: 'syncing', note: 'History sync is in progress.' } })),
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
    sendMessage: vi.fn(async () => ({ id: 'sent-1', timestamp: 123 })),
    sendMedia: vi.fn(async () => ({ id: 'media-1', timestamp: 124 })),
    sendMediaFromBase64: vi.fn(async () => ({ id: 'media-2', timestamp: 125 })),
    sendVoiceNote: vi.fn(async () => ({ id: 'voice-1', timestamp: 126 })),
    downloadMedia: vi.fn(async () => ({ mimetype: 'image/png', data: 'aGVsbG8=', filename: 'image.png' })),
  };
}
type FakeService = ReturnType<typeof makeFakeService>;

let fakeService: FakeService;
let client: Client;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  fakeService = makeFakeService();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const serviceAsReal = fakeService as unknown as WhatsAppBackend;
  registerAuthTools(server, serviceAsReal);
  registerChatTools(server, serviceAsReal);
  registerContactTools(server, serviceAsReal);
  registerMessageTools(server, serviceAsReal);
  registerMediaTools(server, serviceAsReal);

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
  vi.restoreAllMocks();
});

const text = (result: unknown): string =>
  (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? '';

describe('tool registration', () => {
  it('exposes the expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      'get_qr_code', 'request_pairing_code', 'check_auth_status', 'get_backend_status', 'logout',
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
  it('reports history coverage independently of authentication', async () => {
    const result = await client.callTool({ name: 'get_backend_status', arguments: {} });
    expect(JSON.parse(text(result))).toMatchObject({ backend: 'baileys', history: { state: 'syncing' } });
  });

  it('keeps send_message output compatible with normalized provider results', async () => {
    const result = await client.callTool({ name: 'send_message', arguments: { recipient_jid: '123@lid', message: 'Hello' } });
    expect(JSON.parse(text(result))).toMatchObject({ success: true, messageId: 'sent-1', timestamp: 123 });
    expect(fakeService.sendMessage).toHaveBeenCalledWith('123@lid', 'Hello');
  });

  it('uses the actual incoming group chat for message context', async () => {
    fakeService.getMessageById.mockResolvedValue({ id: 'incoming', chatId: 'group@g.us', from: 'sender@lid', to: 'me@s.whatsapp.net', fromMe: false } as never);
    await client.callTool({ name: 'get_message_context', arguments: { message_id: 'incoming', limit: 7 } });
    expect(fakeService.getMessages).toHaveBeenCalledWith('group@g.us', 7);
  });

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

  it('explicit logout clears a disconnected Baileys session too', async () => {
    fakeService.isAuthenticated.mockReturnValue(false);
    const result = await client.callTool({ name: 'logout', arguments: {} });
    expect(fakeService.logout).toHaveBeenCalled();
    expect(fakeService.initialize).toHaveBeenCalled();
    expect(result.isError).toBe(false);
  });
});

describe('backend-neutral media tools', () => {
  it('sends base64 through the provider without constructing web.js media', async () => {
    const result = await client.callTool({ name: 'send_media', arguments: {
      recipient_jid: '123@lid', media_content: 'aGVsbG8=', mime_type: 'text/plain', filename: 'hello.txt',
    } });
    expect(JSON.parse(text(result))).toMatchObject({ success: true, messageId: 'media-2' });
    expect(fakeService.sendMediaFromBase64).toHaveBeenCalledWith('123@lid', 'aGVsbG8=', 'text/plain', 'hello.txt', undefined);
  });

  it('does not send ambiguous media inputs', async () => {
    const result = await client.callTool({ name: 'send_media', arguments: {
      recipient_jid: '123@lid', media_path: '/audio.ogg', media_content: 'aGVsbG8=', mime_type: 'audio/ogg',
    } });
    expect(result.isError).toBe(true);
    expect(fakeService.sendMedia).not.toHaveBeenCalled();
    expect(fakeService.sendMediaFromBase64).not.toHaveBeenCalled();
  });

  it('preserves download image content and metadata across providers', async () => {
    const result = await client.callTool({ name: 'download_media', arguments: { message_id: 'opaque-id', include_full_data: true } });
    expect(JSON.parse(text(result))).toMatchObject({ filename: 'image.png', filesize: 5 });
    expect(result.content).toContainEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  });

  it('cleans converted voice audio after failed sending and keeps the original file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-media-test-'));
    const original = path.join(directory, 'original.ogg');
    const converted = path.join(directory, 'converted.ogg');
    await fs.writeFile(original, 'original');
    await fs.writeFile(converted, 'converted');
    vi.spyOn(AudioUtils, 'convertToOpusOggTemp').mockResolvedValue(converted);
    fakeService.sendVoiceNote.mockRejectedValue(new Error('Socket closed'));
    try {
      const result = await client.callTool({ name: 'send_media', arguments: {
        recipient_jid: '123@lid', media_path: original, as_audio_message: true,
      } });
      expect(result.isError).toBe(true);
      expect(fakeService.sendVoiceNote).toHaveBeenCalledWith('123@lid', converted);
      expect(await fs.readFile(original, 'utf8')).toBe('original');
      await expect(fs.access(converted)).rejects.toThrow();
      expect(fakeService.sendMedia).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('bounded input compatibility', () => {
  it('keeps an empty contact search valid while rejecting oversized query and list limits', async () => {
    const result = await client.callTool({ name: 'search_contacts', arguments: { query: '' } });
    expect(result.isError).not.toBe(true);
    expect(fakeService.searchContacts).toHaveBeenCalledWith('');
    const oversized = await client.callTool({ name: 'search_contacts', arguments: { query: 'x'.repeat(4097) } });
    expect(oversized.isError).toBe(true);
    const tooMany = await client.callTool({ name: 'list_messages', arguments: { chat_id: 'fixture-chat', limit: 1001 } });
    expect(tooMany.isError).toBe(true);
  });
});
