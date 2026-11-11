import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { SimpleMessage } from '../src/services/backend.js';
import { BaileysStore } from '../src/services/baileys-store.js';
import { BaileysService, type BaileysSocket } from '../src/services/baileys.js';
import { MESSAGE_RECEIVED, MessageEvents, signWebhook, type MessageEventHost } from '../src/services/events.js';
import { registerEventHandlers } from '../src/tools/events.js';
import { registerMessageTools } from '../src/tools/messages.js';

vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }) } }));

const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const URL_OK = 'http://127.0.0.1:9/hook';
const GROUP = '120363000000000000@g.us';
const OTHER = '120363000000000001@g.us';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

function directory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsapp-events-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const message = (id: string, overrides: Partial<SimpleMessage> = {}): SimpleMessage => ({
  id, body: `text ${id}`, chatId: GROUP, from: 'a@s.whatsapp.net', to: GROUP,
  timestamp: Math.floor(Date.now() / 1000) + 5, fromMe: false, hasMedia: false, type: 'chat', ...overrides,
});

interface Delivery { url: string; headers: Record<string, string>; body: string; parsed: { eventId: string; name: string; data: SimpleMessage; cursor: string } }

function receiver(respond: (attempt: number, delivery: Delivery) => number | Response) {
  const deliveries: Delivery[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const delivery: Delivery = {
      url: String(url), headers: init!.headers as Record<string, string>, body: init!.body as string,
      parsed: JSON.parse(init!.body as string),
    };
    deliveries.push(delivery);
    const result = respond(deliveries.length, delivery);
    return result instanceof Response ? result : new Response(null, { status: result });
  });
  return { deliveries, fetcher: fetcher as unknown as typeof fetch };
}

function fixture(respond: Parameters<typeof receiver>[0] = () => 200, dir = directory(), stored: SimpleMessage[] = []) {
  const store = new BaileysStore(dir);
  const known = new Map<string, SimpleMessage>(stored.map(item => [item.id, item]));
  const host: MessageEventHost = {
    normalizeChatId: id => id,
    getMessage: async id => known.get(id) ?? null,
    ensureReady: async () => {},
    annotate: async value => value,
  };
  const { deliveries, fetcher } = receiver(respond);
  const events = new MessageEvents(store, host, { fetch: fetcher, retryDelaysMs: [5], notReadyDelayMs: 5 });
  let closed = false;
  const close = () => { if (closed) return; closed = true; events.stop(); store.close(); };
  cleanups.push(close);
  events.start();
  const add = (...items: SimpleMessage[]) => { for (const item of items) known.set(item.id, item); return items; };
  return { store, events, deliveries, add, close, dir };
}

const subscribe = (events: MessageEvents, args?: { chat_ids?: string[]; include_own?: boolean }, url = URL_OK) =>
  events.subscribe({ name: MESSAGE_RECEIVED, ...(args ? { arguments: args } : {}), delivery: { mode: 'webhook', url, secret: SECRET } });

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 3000, interval: 5 });
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

describe('MessageEvents', () => {
  it('signs deliveries per Standard Webhooks and withholds the media key', async () => {
    const { events, deliveries, add } = fixture();
    subscribe(events);
    events.record(add(message('m1', { mediaKey: 'secret-key' })), true);
    await until(() => deliveries.length === 1);
    const { headers, body, parsed } = deliveries[0];
    expect(headers['webhook-id']).toBe(parsed.eventId);
    expect(headers['webhook-signature']).toBe(signWebhook(SECRET, parsed.eventId, Number(headers['webhook-timestamp']), body));
    expect(headers['x-mcp-subscription-id']).toMatch(/^sub_/);
    expect(parsed.name).toBe(MESSAGE_RECEIVED);
    expect(parsed.data.body).toBe('text m1');
    expect(parsed.data).not.toHaveProperty('mediaKey');
  });

  it('retries a failing receiver with the same id and keeps the order', async () => {
    const { events, deliveries, add } = fixture(attempt => (attempt <= 2 ? 500 : 200));
    subscribe(events);
    const now = Math.floor(Date.now() / 1000) + 5;
    events.record(add(message('m1', { timestamp: now }), message('m2', { timestamp: now + 1 })), true);
    await until(() => deliveries.length === 4);
    expect(deliveries.map(item => item.parsed.data.id)).toEqual(['m1', 'm1', 'm1', 'm2']);
    expect(new Set(deliveries.slice(0, 3).map(item => item.headers['webhook-id'])).size).toBe(1);
  });

  it('waits when the receiver is busy and does not lose the event', async () => {
    const { events, deliveries, add } = fixture(attempt => (attempt === 1 ? new Response(null, { status: 503 }) : 200));
    subscribe(events);
    events.record(add(message('m1')), true);
    await until(() => deliveries.length === 2);
    expect(deliveries[1].parsed.data.id).toBe('m1');
  });

  it('delivers the backlog as soon as the receiver refreshes its subscription', async () => {
    let down = true;
    const store = new BaileysStore(directory());
    cleanups.push(() => store.close());
    const known = new Map<string, SimpleMessage>();
    const { deliveries, fetcher } = receiver(() => (down ? 500 : 200));
    const events = new MessageEvents(store, {
      normalizeChatId: id => id, getMessage: async id => known.get(id) ?? null, ensureReady: async () => {}, annotate: async value => value,
    }, { fetch: fetcher, retryDelaysMs: [3_600_000] });
    cleanups.push(() => events.stop());
    events.start();
    subscribe(events);
    known.set('m1', message('m1'));
    events.record([known.get('m1')!], true);
    await until(() => deliveries.length === 1);
    await settle();
    expect(deliveries).toHaveLength(1); // waiting out an hour of backoff
    down = false;
    subscribe(events);
    await until(() => deliveries.length === 2);
  });

  it('stops on 410 and resumes when the subscription is refreshed', async () => {
    let gone = true;
    const { events, deliveries, add, store } = fixture(() => (gone ? 410 : 200));
    const { id } = subscribe(events);
    events.record(add(message('m1')), true);
    await until(() => store.getEventSubscription(id)?.active === false);
    expect(deliveries).toHaveLength(1);
    gone = false;
    subscribe(events);
    await until(() => deliveries.length === 2);
  });

  it('picks up messages from an offline period but no older history', async () => {
    const { events, deliveries, add } = fixture();
    subscribe(events);
    const now = Math.floor(Date.now() / 1000);
    events.record(add(message('old', { timestamp: now - 3600 }), message('offline', { timestamp: now + 2 })), false);
    await until(() => deliveries.length === 1);
    await settle();
    expect(deliveries.map(item => item.parsed.data.id)).toEqual(['offline']);
  });

  it('never delivers the same message twice', async () => {
    const { events, deliveries, add } = fixture();
    subscribe(events);
    const [first] = add(message('m1'));
    events.record([first], true);
    events.record([first], false);
    events.record([first], true);
    await until(() => deliveries.length === 1);
    await settle();
    expect(deliveries).toHaveLength(1);
  });

  it('only delivers the requested chats and skips own messages unless asked', async () => {
    const { events, deliveries, add } = fixture();
    subscribe(events, { chat_ids: [GROUP] });
    events.record(add(
      message('wanted'), message('other-chat', { chatId: OTHER }), message('mine', { fromMe: true }),
      message('reaction', { type: 'reaction' }), message('protocol', { type: 'protocol' }),
    ), true);
    await until(() => deliveries.length === 1);
    await settle();
    expect(deliveries.map(item => item.parsed.data.id)).toEqual(['wanted']);
  });

  it('resumes from its cursor after a restart', async () => {
    const dir = directory();
    let down = true;
    const first = fixture(() => (down ? 500 : 200), dir);
    subscribe(first.events);
    const [item] = first.add(message('m1'));
    first.events.record([item], true);
    await until(() => first.deliveries.length >= 1);
    first.close();
    down = false;
    const second = fixture(() => 200, dir, [item]);
    await until(() => second.deliveries.length === 1);
    expect(second.deliveries[0].parsed.data.id).toBe('m1');
  });

  it('refuses receivers on other machines, weak secrets and unknown events', () => {
    const { events } = fixture();
    expect(() => subscribe(events, undefined, 'https://example.com/hook')).toThrow(/this machine/);
    expect(() => events.subscribe({ name: MESSAGE_RECEIVED, delivery: { mode: 'webhook', url: URL_OK, secret: 'short' } })).toThrow(/whsec_/);
    expect(() => events.subscribe({ name: 'nope', delivery: { mode: 'webhook', url: URL_OK, secret: SECRET } })).toThrow(/Unknown event/);
    vi.stubEnv('WHATSAPP_EVENTS_ALLOW_REMOTE', '1');
    expect(() => subscribe(events, undefined, 'http://example.com/hook')).toThrow(/https/);
    expect(subscribe(events, undefined, 'https://example.com/hook').id).toMatch(/^sub_/);
  });

  it('drops a subscription that was never refreshed', async () => {
    const dir = directory();
    const store = new BaileysStore(dir);
    cleanups.push(() => store.close());
    let time = Date.now();
    const { deliveries, fetcher } = receiver(() => 200);
    const known = new Map<string, SimpleMessage>();
    const events = new MessageEvents(store, {
      normalizeChatId: id => id, getMessage: async id => known.get(id) ?? null, ensureReady: async () => {}, annotate: async value => value,
    }, { fetch: fetcher, now: () => time });
    cleanups.push(() => events.stop());
    events.start();
    const { id } = subscribe(events);
    time += 8 * 86_400_000;
    known.set('m1', message('m1', { timestamp: Math.floor(time / 1000) }));
    events.record([known.get('m1')!], true);
    await until(() => store.getEventSubscription(id) === undefined);
    expect(deliveries).toHaveLength(0);
  });

  it('lets unsubscribe stop delivery and clean the log', async () => {
    const { events, deliveries, add, store } = fixture();
    subscribe(events);
    events.unsubscribe({ name: MESSAGE_RECEIVED, delivery: { url: URL_OK } });
    expect(events.hasSubscriptions()).toBe(false);
    events.record(add(message('m1')), true);
    await settle();
    expect(deliveries).toHaveLength(0);
    expect(store.latestEventSeq()).toBe(0);
    expect(() => events.unsubscribe({ name: MESSAGE_RECEIVED, delivery: { url: URL_OK } })).toThrow(/No matching/);
  });

  it('holds delivery while WhatsApp is not connected', async () => {
    const store = new BaileysStore(directory());
    cleanups.push(() => store.close());
    let ready = false;
    const known = new Map([['m1', message('m1')]]);
    const { deliveries, fetcher } = receiver(() => 200);
    const events = new MessageEvents(store, {
      normalizeChatId: id => id, getMessage: async id => known.get(id) ?? null,
      ensureReady: async () => { if (!ready) throw new Error('not connected'); }, annotate: async value => value,
    }, { fetch: fetcher });
    cleanups.push(() => events.stop());
    events.start();
    subscribe(events);
    events.record([known.get('m1')!], true);
    await settle();
    expect(deliveries).toHaveLength(0);
    ready = true;
    subscribe(events); // a refresh clears the wait
    await until(() => deliveries.length === 1);
  });
});

describe('events over MCP against a real receiver', () => {
  function socket() {
    return {
      ev: new EventEmitter(), user: { id: '15550000001@s.whatsapp.net' }, end: vi.fn(), logout: vi.fn(async () => {}),
      groupMetadata: vi.fn(), fetchMessageHistory: vi.fn(async () => 'request'), updateMediaMessage: vi.fn(),
    };
  }

  async function listen(status: () => number) {
    const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { received.push({ headers: req.headers, body }); res.statusCode = status(); res.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` };
  }

  async function connected() {
    const dir = directory();
    const sockets: ReturnType<typeof socket>[] = [];
    const service = new BaileysService({
      sessionDir: dir,
      socketFactory: () => { const next = socket(); sockets.push(next); return next as unknown as BaileysSocket; },
      events: { retryDelaysMs: [5], notReadyDelayMs: 5 },
    });
    cleanups.push(() => service.destroy());
    await service.initialize();
    sockets[0].ev.emit('connection.update', { connection: 'open' });
    sockets[0].ev.emit('messaging-history.set', {
      chats: [{ id: GROUP, name: 'Team' }], contacts: [], progress: 100,
      messages: [{ key: { id: 'history', remoteJid: GROUP, fromMe: false, participant: 'a@s.whatsapp.net' }, message: { conversation: 'old' }, messageTimestamp: 1700000000 }],
    });
    const server = new McpServer({ name: 'test', version: '1' }, { capabilities: { experimental: { events: {} } } });
    registerEventHandlers(server, service);
    registerMessageTools(server, service);
    const client = new Client({ name: 'client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => { await client.close(); await server.close(); });
    return { client, service, sockets };
  }

  const anything = z.object({}).passthrough();
  const incoming = (id: string, timestamp = Math.floor(Date.now() / 1000) + 5) => ({
    key: { id, remoteJid: GROUP, fromMe: false, participant: 'a@s.whatsapp.net' }, message: { conversation: `body ${id}` }, messageTimestamp: timestamp,
  });

  it('subscribes through the protocol, never as a tool, and delivers live and offline messages', async () => {
    let status = 200;
    const { received, url } = await listen(() => status);
    const { client, sockets } = await connected();
    expect((await client.listTools()).tools.map(tool => tool.name).filter(name => name.includes('event') || name.includes('subscribe'))).toEqual([]);
    const listed = await client.request({ method: 'events/list' }, anything) as { events: Array<{ name: string }> };
    expect(listed.events[0].name).toBe(MESSAGE_RECEIVED);
    const subscribed = await client.request({
      method: 'events/subscribe',
      params: { name: MESSAGE_RECEIVED, arguments: { chat_ids: [GROUP] }, delivery: { mode: 'webhook', url, secret: SECRET } },
    }, anything) as { id: string; refreshBefore: string };
    expect(subscribed.id).toMatch(/^sub_/);
    expect(Date.parse(subscribed.refreshBefore)).toBeGreaterThan(Date.now());

    sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [incoming('live')] });
    await until(() => received.length === 1);
    expect(JSON.parse(received[0].body).data.body).toBe('body live');

    status = 500;
    sockets[0].ev.emit('messages.upsert', { type: 'append', messages: [incoming('offline')] });
    await until(() => received.length >= 3);
    status = 200;
    await until(() => received.some(item => JSON.parse(item.body).data.body === 'body offline') && received.length >= 4);
    const count = received.length;
    await settle();
    expect(received.length).toBe(count);
  });

  it('reports a bad subscription as an error and returns messages as a list too', async () => {
    const { client } = await connected();
    await expect(client.request({
      method: 'events/subscribe',
      params: { name: MESSAGE_RECEIVED, delivery: { mode: 'webhook', url: 'https://example.com/x', secret: SECRET } },
    }, anything)).rejects.toThrow(/this machine/);
    const result = await client.callTool({ name: 'list_messages', arguments: { chat_id: GROUP, limit: 1 } });
    expect((result.structuredContent as { messages: unknown[] }).messages).toHaveLength(1);
  });
});
