import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BaileysService, type BaileysSocket } from '../src/services/baileys.js';
import { registerAuthTools } from '../src/tools/auth.js';
import { registerChatTools } from '../src/tools/chats.js';
import { registerContactTools } from '../src/tools/contacts.js';
import { registerMessageTools } from '../src/tools/messages.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function socket() {
  return {
    ev: new EventEmitter(), user: { id: '15550000001@s.whatsapp.net' },
    end: vi.fn(), logout: vi.fn(async () => {}),
    requestPairingCode: vi.fn(async () => 'CODE1234'),
    sendMessage: vi.fn(async (jid: string, content: { text: string }) => ({
      key: { id: 'outbound', remoteJid: jid, fromMe: true },
      message: { conversation: content.text }, messageTimestamp: 1700000020,
    })),
    groupMetadata: vi.fn(async (jid: string) => ({ id: jid, subject: 'Group', participants: [] })),
    fetchMessageHistory: vi.fn(async () => 'request'),
    updateMediaMessage: vi.fn(),
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'whatsapp-mcp-baileys-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sockets: ReturnType<typeof socket>[] = [];
  const service = new BaileysService({ sessionDir: directory, socketFactory: () => {
    const next = socket(); sockets.push(next); return next as unknown as BaileysSocket;
  } });
  cleanups.push(() => service.destroy());
  await service.initialize();
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  sockets[0].ev.emit('messaging-history.set', {
    chats: [{ id: '15550000002@s.whatsapp.net', name: 'Alice' }],
    contacts: [{ id: '15550000002@s.whatsapp.net', name: 'Alice' }],
    messages: [{ key: { id: 'incoming', remoteJid: '15550000002@s.whatsapp.net', fromMe: false },
      message: { conversation: 'Stored history' }, messageTimestamp: 1700000010 }],
    progress: 100,
  });

  const server = new McpServer({ name: 'integration', version: '1' });
  registerAuthTools(server, service);
  registerChatTools(server, service);
  registerContactTools(server, service);
  registerMessageTools(server, service);
  const client = new Client({ name: 'integration-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args }) as CallToolResult;
    if (response.isError) throw new Error(JSON.stringify(response.content));
    const first = response.content[0];
    return first?.type === 'text' ? first.text : '';
  };
  return { service, sockets, call };
}

describe('MCP tools with the real Baileys adapter and SQLite (offline)', () => {
  it('round-trips incoming/outgoing IDs and restores history across restart', async () => {
    const { service, sockets, call } = await fixture();
    const contacts = JSON.parse(await call('search_contacts', { query: 'Alice' }));
    const chatId = contacts[0].id;
    const incoming = JSON.parse(await call('list_messages', { chat_id: chatId, limit: 1 }))[0];
    expect(incoming.body).toBe('Stored history');
    expect(JSON.parse(await call('get_message_by_id', { message_id: incoming.id }))).toEqual(incoming);
    const sent = JSON.parse(await call('send_message', { recipient_jid: '15550000002@c.us', message: 'Reply' }));
    expect(sockets[0].sendMessage).toHaveBeenCalledWith(chatId, { text: 'Reply' });
    expect(JSON.parse(await call('get_message_by_id', { message_id: sent.messageId })).body).toBe('Reply');

    await service.destroy();
    await service.initialize();
    sockets[1].ev.emit('connection.update', { connection: 'open' });
    expect(JSON.parse(await call('list_messages', { chat_id: chatId, limit: 2 })).map((entry: { body: string }) => entry.body))
      .toEqual(['Stored history', 'Reply']);
    expect(JSON.parse(await call('get_backend_status'))).toMatchObject({ backend: 'baileys', authenticated: true, history: { messageCount: 2 } });
  });

  it('explicit MCP logout clears a disconnected account before pairing again', async () => {
    const { service, sockets, call } = await fixture();
    await service.destroy();
    expect(await call('logout')).toMatch(/Successfully logged out/);
    expect(service.getStatus()).toMatchObject({ authenticated: false, history: { messageCount: 0, contactCount: 0, chatCount: 0 } });
    sockets.at(-1)!.ev.emit('connection.update', { qr: 'fresh-qr' });
    expect(service.getLatestQrCode()).toBe('fresh-qr');
  });
});
