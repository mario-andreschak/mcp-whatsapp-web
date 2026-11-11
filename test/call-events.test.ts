import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { WhatsAppBackend } from '../src/services/backend.js';
import { BaileysStore } from '../src/services/baileys-store.js';
import { BaileysService, type BaileysSocket } from '../src/services/baileys.js';
import {
  CALL_ENDED, CALL_RECEIVED, MESSAGE_RECEIVED, MessageEvents, environmentEventNames, signWebhook,
  type CallDetails, type MessageEventDeps,
} from '../src/services/events.js';
import { registerEventHandlers } from '../src/tools/events.js';
import { registerCallTools } from '../src/tools/calls.js';

vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }) } }));

const SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
const URL_OK = 'http://127.0.0.1:9/hook';
const CALLER = '4915550001@s.whatsapp.net';
const STRANGER = '4915550002@s.whatsapp.net';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function directory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsapp-calls-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Delivery { headers: Record<string, string>; body: string; parsed: { eventId: string; name: string; timestamp: string; cursor: string; data: Record<string, unknown> } }

function receiver(respond: (attempt: number) => number = () => 200) {
  const deliveries: Delivery[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    deliveries.push({ headers: init!.headers as Record<string, string>, body: init!.body as string, parsed: JSON.parse(init!.body as string) });
    return new Response(null, { status: respond(deliveries.length) });
  });
  return { deliveries, fetcher: fetcher as unknown as typeof fetch };
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 3000, interval: 5 });
const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

const contact = { id: CALLER, name: 'Alice Saved', pushname: 'Ali', number: '4915550001', isMyContact: true };
const details = (overrides: Partial<CallDetails> = {}): CallDetails => ({
  callId: 'CALL1', chatId: CALLER, from: CALLER, isVideo: false, isGroup: false, contact, ...overrides,
});

describe('call events in the event log', () => {
  function fixture(respond?: (attempt: number) => number, deps: Partial<MessageEventDeps> = {}) {
    const store = new BaileysStore(directory());
    const { deliveries, fetcher } = receiver(respond);
    const events = new MessageEvents(store, {
      normalizeChatId: id => id, getMessage: async () => null, ensureReady: async () => {}, annotate: async value => value,
    }, { fetch: fetcher, retryDelaysMs: [5], notReadyDelayMs: 5, ...deps });
    cleanups.push(() => { events.stop(); store.close(); });
    events.start();
    return { store, events, deliveries };
  }
  const subscribe = (events: MessageEvents, name: string, args?: { chat_ids?: string[]; include_own?: boolean }) =>
    events.subscribe({ name, ...(args ? { arguments: args } : {}), delivery: { mode: 'webhook', url: URL_OK, secret: SECRET } });

  it('delivers a ringing call with the agreed payload, signed like messages', async () => {
    const { events, deliveries } = fixture();
    subscribe(events, CALL_RECEIVED);
    const at = Date.now();
    expect(events.recordCallReceived(details(), at)).toBe(true);
    await until(() => deliveries.length === 1);
    const { headers, body, parsed } = deliveries[0];
    expect(parsed).toEqual({
      eventId: expect.stringMatching(/^evt_[0-9a-f]{32}$/), name: CALL_RECEIVED, timestamp: new Date(at).toISOString(), cursor: '1',
      data: { callId: 'CALL1', chatId: CALLER, from: CALLER, isVideo: false, isGroup: false, status: 'ringing', contact },
    });
    expect(Object.keys(parsed.data)).toEqual(['callId', 'chatId', 'from', 'isVideo', 'isGroup', 'status', 'contact']);
    expect(headers['webhook-id']).toBe(parsed.eventId);
    expect(headers['webhook-signature']).toBe(signWebhook(SECRET, parsed.eventId, Number(headers['webhook-timestamp']), body));
  });

  it('delivers call.ended with the reason and never repeats an event', async () => {
    const { events, deliveries } = fixture();
    subscribe(events, CALL_ENDED);
    events.recordCallReceived(details(), Date.now()); // not subscribed: not logged
    expect(events.recordCallEnded(details(), 'missed', Date.now())).toBe(true);
    expect(events.recordCallEnded(details(), 'missed', Date.now())).toBe(false);
    await until(() => deliveries.length === 1);
    await settle();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].parsed.name).toBe(CALL_ENDED);
    expect(deliveries[0].parsed.data).toEqual({ callId: 'CALL1', chatId: CALLER, from: CALLER, isVideo: false, isGroup: false, reason: 'missed', contact });
  });

  it('ignores an offer that is already older than a minute', async () => {
    const { events, deliveries, store } = fixture();
    subscribe(events, CALL_RECEIVED);
    expect(events.recordCallReceived(details(), Date.now() - 61_000)).toBe(false);
    await settle();
    expect(deliveries).toHaveLength(0);
    expect(store.latestEventSeq()).toBe(0);
  });

  it('drops a ringing call it could not deliver within a minute, but still reports how it ended', async () => {
    let time = Date.now();
    const { events, deliveries } = fixture(attempt => (attempt === 1 ? 500 : 200), { now: () => time, retryDelaysMs: [300] });
    subscribe(events, CALL_RECEIVED);
    subscribe(events, CALL_ENDED);
    events.recordCallReceived(details(), time);
    await until(() => deliveries.length === 1);
    time += 61_000;
    events.recordCallEnded(details(), 'missed', time);
    await until(() => deliveries.some(item => item.parsed.name === CALL_ENDED));
    await settle(400);
    expect(deliveries.map(item => item.parsed.name)).toEqual([CALL_RECEIVED, CALL_ENDED]);
  });

  it('filters calls by chat or caller', async () => {
    const { events, deliveries } = fixture();
    subscribe(events, CALL_RECEIVED, { chat_ids: [CALLER] });
    events.recordCallReceived(details({ callId: 'other', chatId: STRANGER, from: STRANGER }), Date.now());
    events.recordCallReceived(details({ callId: 'group', chatId: '120363000000000000@g.us', isGroup: true }), Date.now());
    await until(() => deliveries.length === 1);
    await settle();
    expect(deliveries.map(item => item.parsed.data.callId)).toEqual(['group']);
  });

  it('lists, subscribes and unsubscribes the call events, without include_own', async () => {
    const { events, deliveries } = fixture();
    expect((events.list().events as Array<{ name: string }>).map(event => event.name)).toEqual([MESSAGE_RECEIVED, CALL_RECEIVED, CALL_ENDED]);
    expect(() => subscribe(events, CALL_RECEIVED, { include_own: true })).toThrow(/include_own/);
    const received = subscribe(events, CALL_RECEIVED);
    const ended = subscribe(events, CALL_ENDED);
    expect(received.id).not.toBe(ended.id);
    expect(events.hasSubscriptions(CALL_RECEIVED)).toBe(true);
    expect(events.hasSubscriptions(MESSAGE_RECEIVED)).toBe(false);
    events.unsubscribe({ name: CALL_RECEIVED, delivery: { url: URL_OK } });
    events.unsubscribe({ name: CALL_ENDED, delivery: { url: URL_OK } });
    expect(events.hasSubscriptions()).toBe(false);
    expect(events.recordCallReceived(details(), Date.now())).toBe(false);
    await settle();
    expect(deliveries).toHaveLength(0);
    expect(() => events.unsubscribe({ name: CALL_ENDED, delivery: { url: URL_OK } })).toThrow(/No matching/);
  });

  it('keeps the configured webhook on messages only unless WHATSAPP_WEBHOOK_EVENTS asks for calls', async () => {
    vi.stubEnv('WHATSAPP_WEBHOOK_URL', URL_OK);
    vi.stubEnv('WHATSAPP_WEBHOOK_SECRET', SECRET);
    const plain = fixture();
    expect(plain.store.getEventSubscription('sub_env')?.names).toEqual([MESSAGE_RECEIVED]);
    expect(plain.events.recordCallReceived(details(), Date.now())).toBe(false);

    vi.stubEnv('WHATSAPP_WEBHOOK_EVENTS', 'message.received, call.received,call.ended,nonsense');
    const opted = fixture();
    expect(opted.store.getEventSubscription('sub_env')?.names).toEqual([MESSAGE_RECEIVED, CALL_RECEIVED, CALL_ENDED]);
    opted.events.recordCallReceived(details(), Date.now());
    opted.events.recordCallEnded(details(), 'rejected', Date.now());
    await until(() => opted.deliveries.length === 2);
    expect(opted.deliveries.map(item => item.parsed.name)).toEqual([CALL_RECEIVED, CALL_ENDED]);
    expect(opted.deliveries[0].headers['x-mcp-subscription-id']).toBe('sub_env');
    await settle();
    expect(plain.deliveries).toHaveLength(0);
  });

  it('reads WHATSAPP_WEBHOOK_EVENTS forgivingly', () => {
    expect(environmentEventNames(undefined)).toEqual([MESSAGE_RECEIVED]);
    expect(environmentEventNames(' ')).toEqual([MESSAGE_RECEIVED]);
    expect(environmentEventNames('call.received')).toEqual([CALL_RECEIVED]);
    expect(environmentEventNames('typo')).toEqual([MESSAGE_RECEIVED]);
    expect(environmentEventNames('call.ended,call.ended')).toEqual([CALL_ENDED]);
  });

  it('upgrades a session database from before call events without losing anything', () => {
    const dir = directory();
    const db = new Database(path.join(dir, 'session.sqlite'));
    db.exec(`CREATE TABLE event_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL, from_me INTEGER NOT NULL, occurred_at INTEGER NOT NULL);
    CREATE TABLE event_subscriptions (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, chat_ids TEXT, include_own INTEGER NOT NULL,
      cursor INTEGER NOT NULL, expires_at INTEGER, active INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO event_log (event_id, chat_id, message_id, from_me, occurred_at) VALUES ('evt_old', 'c@g.us', 'm1', 0, 1);
    INSERT INTO event_subscriptions VALUES ('sub_old', '${URL_OK}', '${SECRET}', NULL, 0, 0, NULL, 1, 1);`);
    db.close();
    const store = new BaileysStore(dir);
    cleanups.push(() => store.close());
    expect(store.getEventSubscription('sub_old')?.names).toEqual([MESSAGE_RECEIVED]);
    expect(store.nextEvent(0)).toMatchObject({ eventId: 'evt_old', name: MESSAGE_RECEIVED, messageId: 'm1', data: null });
  });
});

describe('calls on the Baileys backend', () => {
  function socket() {
    return {
      ev: new EventEmitter(), user: { id: '15550000001@s.whatsapp.net' }, end: vi.fn(), logout: vi.fn(async () => {}),
      groupMetadata: vi.fn(), fetchMessageHistory: vi.fn(async () => 'request'), updateMediaMessage: vi.fn(),
      rejectCall: vi.fn(async () => {}),
    };
  }

  async function connected(names: string[] = [CALL_RECEIVED, CALL_ENDED]) {
    const sockets: ReturnType<typeof socket>[] = [];
    const { deliveries, fetcher } = receiver();
    const service = new BaileysService({
      sessionDir: directory(),
      socketFactory: () => { const next = socket(); sockets.push(next); return next as unknown as BaileysSocket; },
      events: { fetch: fetcher, retryDelaysMs: [5], notReadyDelayMs: 5 },
    });
    cleanups.push(() => service.destroy());
    await service.initialize();
    const ev = sockets[0].ev;
    ev.emit('connection.update', { connection: 'open' });
    ev.emit('contacts.upsert', [{ id: CALLER, name: 'Alice Saved', notify: 'Ali' }]);
    const events = await service.messageEvents();
    for (const name of names) events.subscribe({ name, delivery: { mode: 'webhook', url: URL_OK, secret: SECRET } });
    return { service, socket: sockets[0], ev, deliveries };
  }

  const now = () => new Date(Math.floor(Date.now() / 1000) * 1000);
  const offer = (overrides: Record<string, unknown> = {}) => ({
    id: 'CALL1', from: CALLER, chatId: CALLER, date: now(), status: 'offer', offline: false, isVideo: true, isGroup: false, ...overrides,
  });

  it('announces a live call with the saved contact and reports it missed', async () => {
    const { ev, deliveries } = await connected();
    const call = offer();
    ev.emit('call', [call]);
    await until(() => deliveries.length === 1);
    expect(deliveries[0].parsed).toEqual({
      eventId: expect.stringMatching(/^evt_/), name: CALL_RECEIVED, timestamp: call.date.toISOString(), cursor: expect.stringMatching(/^\d+$/),
      data: { callId: 'CALL1', chatId: CALLER, from: CALLER, isVideo: true, isGroup: false, status: 'ringing', contact },
    });
    ev.emit('call', [{ ...offer({ status: 'ringing' }) }]);
    ev.emit('call', [{ id: 'CALL1', from: CALLER, chatId: CALLER, date: now(), status: 'timeout', offline: false }]);
    await until(() => deliveries.length === 2);
    expect(deliveries[1].parsed.name).toBe(CALL_ENDED);
    expect(deliveries[1].parsed.data).toEqual({ callId: 'CALL1', chatId: CALLER, from: CALLER, isVideo: true, isGroup: false, reason: 'missed', contact });
  });

  it('tells the ways a call can end apart', async () => {
    const { ev, deliveries } = await connected([CALL_ENDED]);
    const cases = [['A', 'reject', 'rejected'], ['B', 'accept', 'answered_elsewhere'], ['C', 'terminate', 'ended'], ['D', 'timeout', 'missed']];
    for (const [id] of cases) ev.emit('call', [offer({ id })]);
    for (const [id, status] of cases) ev.emit('call', [{ id, from: CALLER, chatId: CALLER, date: now(), status, offline: false }]);
    ev.emit('call', [{ id: 'never-rang', from: CALLER, chatId: CALLER, date: now(), status: 'terminate', offline: false }]);
    await until(() => deliveries.length === 4);
    await settle();
    expect(deliveries.map(item => [item.parsed.data.callId, item.parsed.data.reason]))
      .toEqual(cases.map(([id, , reason]) => [id, reason]));
  });

  it('stays quiet about calls from an offline period or older than a minute', async () => {
    const { ev, deliveries } = await connected();
    ev.emit('call', [offer({ id: 'offline', offline: true })]);
    ev.emit('call', [offer({ id: 'old', date: new Date(Date.now() - 5 * 60_000) })]);
    for (const id of ['offline', 'old']) ev.emit('call', [{ id, from: CALLER, chatId: CALLER, date: now(), status: 'timeout', offline: false }]);
    await settle(150);
    expect(deliveries).toHaveLength(0);
  });

  it('still announces the call when the contact lookup fails', async () => {
    const { ev, deliveries } = await connected();
    vi.spyOn(BaileysStore.prototype, 'getContact').mockImplementation(() => { throw new Error('disk on fire'); });
    ev.emit('call', [offer({ id: 'X', from: STRANGER, chatId: STRANGER, isVideo: false })]);
    await until(() => deliveries.length === 1);
    expect(deliveries[0].parsed.data.contact).toEqual({ id: STRANGER, name: null, pushname: '', number: '4915550002', isMyContact: false });
  });

  it('names a caller who calls from a private id by the number WhatsApp sends along', async () => {
    const { ev, deliveries } = await connected();
    ev.emit('call', [offer({ id: 'L', from: '987654321:12@lid', chatId: '987654321@lid', callerPn: CALLER })]);
    await until(() => deliveries.length === 1);
    expect(deliveries[0].parsed.data).toMatchObject({ chatId: CALLER, from: CALLER, contact });
  });

  it('declines a ringing call through reject_call and reports it ended', async () => {
    const { service, socket: sock, ev, deliveries } = await connected();
    const server = new McpServer({ name: 'test', version: '1' }, { capabilities: { experimental: { events: {} } } });
    registerEventHandlers(server, service);
    registerCallTools(server, service);
    const client = new Client({ name: 'client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => { await client.close(); await server.close(); });

    const listed = await client.request({ method: 'events/list' }, z.object({ events: z.array(z.object({ name: z.string() })) }));
    expect(listed.events.map(event => event.name)).toEqual([MESSAGE_RECEIVED, CALL_RECEIVED, CALL_ENDED]);

    ev.emit('call', [offer({ from: '4915550001:3@s.whatsapp.net' })]);
    await until(() => deliveries.length === 1);
    const result = await client.callTool({ name: 'reject_call', arguments: { call_id: 'CALL1' } });
    expect(result.isError).toBeFalsy();
    expect(sock.rejectCall).toHaveBeenCalledWith('CALL1', '4915550001:3@s.whatsapp.net');
    await until(() => deliveries.length === 2);
    expect(deliveries[1].parsed.data.reason).toBe('rejected');

    const again = await client.callTool({ name: 'reject_call', arguments: { call_id: 'CALL1' } });
    expect(again.isError).toBe(true);
    expect(JSON.stringify(again.content)).toMatch(/not ringing/);
    expect(sock.rejectCall).toHaveBeenCalledTimes(1);
  });

  it('explains that reject_call needs the Baileys backend', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    registerCallTools(server, { backend: 'webjs' } as unknown as WhatsAppBackend);
    const client = new Client({ name: 'client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const result = await client.callTool({ name: 'reject_call', arguments: { call_id: 'CALL1' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Baileys/);
  });
});
