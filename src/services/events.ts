import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type { SimpleMessage } from './backend.js';
import type { BaileysStore, StoredEvent, StoredEventSubscription } from './baileys-store.js';
import { log } from '../utils/logger.js';

/**
 * Message events over signed webhooks.
 *
 * Follows the webhook part of the MCP events draft (`events/list`, `events/subscribe`,
 * `events/unsubscribe`) and Standard Webhooks signing. One durable log serves both kinds of
 * recovery: a receiver that was away gets everything after its cursor, and messages that
 * arrived while this server was offline enter the same log when WhatsApp hands them over.
 *
 * These are protocol methods on purpose, not tools. A model can call a tool, and a message
 * could talk it into subscribing somewhere else; it cannot call `events/subscribe`.
 */
export const MESSAGE_RECEIVED = 'message.received';

const DELIVERABLE_TYPES = new Set(['chat', 'ptt', 'audio', 'image', 'video', 'document', 'sticker', 'location', 'contact']);
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];
const NOT_READY_DELAY_MS = 5_000;
const MAX_RETRY_AFTER_MS = 300_000;
const WHATSAPP_WAIT_MS = 30_000;
const WHATSAPP_RETRY_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MS = 7 * 86_400_000;
const MIN_TTL_MS = 3_600_000;
const MAX_TTL_MS = 30 * 86_400_000;
const RETENTION_MS = 14 * 86_400_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ENV_SUBSCRIPTION_ID = 'sub_env';

export class EventRequestError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
const INVALID_PARAMS = -32602;
const NOT_FOUND = -32023;

export const eventArgumentsSchema = z.object({
  chat_ids: z.array(z.string().min(1)).min(1).max(200).optional(),
  include_own: z.boolean().optional(),
}).strict();
export type MessageEventArguments = z.infer<typeof eventArgumentsSchema>;

export interface MessageEventHost {
  normalizeChatId(id: string): string;
  getMessage(id: string): Promise<SimpleMessage | null>;
  ensureReady(timeoutMs?: number): Promise<void>;
  /** Adds the voice-note transcript where one can be produced. Must not throw for a failed transcription. */
  annotate(message: SimpleMessage): Promise<SimpleMessage>;
}

export interface MessageEventDeps {
  fetch?: typeof fetch;
  now?: () => number;
  retryDelaysMs?: number[];
  notReadyDelayMs?: number;
}

export interface SubscribeRequest {
  name: string;
  arguments?: MessageEventArguments;
  delivery: { mode: 'webhook'; url: string; secret: string };
  cursor?: string | null;
  ttlMs?: number | null;
}

type Outcome =
  | { kind: 'done' }
  | { kind: 'suspend'; reason: string }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'fail'; reason: string };

interface DeliveryState {
  running: boolean;
  again: boolean;
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Standard Webhooks signature over `id.timestamp.body`. */
export function signWebhook(secret: string, id: string, timestampSeconds: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestampSeconds}.${body}`).digest('base64')}`;
}

function validateSecret(secret: string): void {
  const bytes = /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) ? Buffer.from(secret.slice(6), 'base64').length : 0;
  if (bytes < 24 || bytes > 64) throw new EventRequestError(INVALID_PARAMS, 'delivery.secret must be whsec_ plus the base64 of 24 to 64 random bytes.');
}

/** Message content must not leave this machine unless the operator says so. */
function validateUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new EventRequestError(INVALID_PARAMS, 'delivery.url is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EventRequestError(INVALID_PARAMS, 'delivery.url must use http or https.');
  if (LOOPBACK_HOSTS.has(url.hostname)) return;
  if (process.env.WHATSAPP_EVENTS_ALLOW_REMOTE !== '1') {
    throw new EventRequestError(INVALID_PARAMS, 'delivery.url must be on this machine. Set WHATSAPP_EVENTS_ALLOW_REMOTE=1 to allow other hosts.');
  }
  if (url.protocol !== 'https:') throw new EventRequestError(INVALID_PARAMS, 'A delivery.url on another host must use https.');
}

export class MessageEvents {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly retryDelays: number[];
  private readonly notReadyDelay: number;
  private readonly states = new Map<string, DeliveryState>();
  private stopped = true;

  constructor(private readonly store: BaileysStore, private readonly host: MessageEventHost, deps: MessageEventDeps = {}) {
    this.fetcher = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.notReadyDelay = deps.notReadyDelayMs ?? NOT_READY_DELAY_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.applyEnvironmentSubscription();
    this.store.pruneEvents(this.now() - RETENTION_MS, this.now());
    this.wakeAll();
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.states.clear();
  }

  list(): { events: unknown[] } {
    return {
      events: [{
        name: MESSAGE_RECEIVED,
        description: 'A WhatsApp message arrived. Delivered once it is stored, including messages that arrived while this server was offline. Voice notes carry a transcript when transcription is configured.',
        delivery: ['webhook'],
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chat_ids: { type: 'array', items: { type: 'string' }, description: 'Only these chats. Omit for all chats.' },
            include_own: { type: 'boolean', default: false, description: "Also deliver this account's own messages." },
          },
        },
      }],
    };
  }

  private subscriptionId(url: string, name: string, chatIds: string[] | null, includeOwn: boolean): string {
    const key = JSON.stringify([url, name, chatIds, includeOwn]);
    return `sub_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  }

  private resolveFilter(args: MessageEventArguments | undefined): { chatIds: string[] | null; includeOwn: boolean } {
    let chatIds: string[] | null = null;
    if (args?.chat_ids) {
      try { chatIds = [...new Set(args.chat_ids.map(id => this.host.normalizeChatId(id)))].sort(); }
      catch (error) { throw new EventRequestError(INVALID_PARAMS, error instanceof Error ? error.message : 'Invalid chat id.'); }
    }
    return { chatIds, includeOwn: args?.include_own === true };
  }

  private assertKnownEvent(name: string): void {
    if (name !== MESSAGE_RECEIVED) throw new EventRequestError(NOT_FOUND, `Unknown event '${name}'.`);
  }

  subscribe(request: SubscribeRequest): { id: string; refreshBefore: string; cursor: string; truncated: boolean } {
    this.assertKnownEvent(request.name);
    validateUrl(request.delivery.url);
    validateSecret(request.delivery.secret);
    const { chatIds, includeOwn } = this.resolveFilter(request.arguments);
    const id = this.subscriptionId(request.delivery.url, request.name, chatIds, includeOwn);
    const now = this.now();
    const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, request.ttlMs ?? DEFAULT_TTL_MS));
    const existing = this.store.getEventSubscription(id);
    this.store.saveEventSubscription({
      id, url: request.delivery.url, secret: request.delivery.secret, chatIds, includeOwn,
      cursor: existing?.cursor ?? this.store.latestEventSeq(), expiresAt: now + ttl, active: true,
      createdAt: existing?.createdAt ?? now,
    });
    // A refresh is the receiver saying it is back: drop any backoff and deliver right away.
    this.resetBackoff(id);
    this.wake(id);
    const saved = this.store.getEventSubscription(id)!;
    return {
      id, refreshBefore: new Date(now + ttl).toISOString(), cursor: String(saved.cursor),
      truncated: !existing && request.cursor != null,
    };
  }

  unsubscribe(request: { name: string; arguments?: MessageEventArguments; delivery: { url: string } }): Record<string, never> {
    this.assertKnownEvent(request.name);
    const { chatIds, includeOwn } = this.resolveFilter(request.arguments);
    const id = this.subscriptionId(request.delivery.url, request.name, chatIds, includeOwn);
    if (!this.store.getEventSubscription(id)) throw new EventRequestError(NOT_FOUND, 'No matching subscription.');
    this.store.deleteEventSubscription(id);
    this.forget(id);
    this.store.pruneEvents(this.now() - RETENTION_MS, this.now());
    return {};
  }

  /** Operator-configured receiver for anything that is not an MCP client. */
  private applyEnvironmentSubscription(): void {
    const url = process.env.WHATSAPP_WEBHOOK_URL?.trim();
    const secret = process.env.WHATSAPP_WEBHOOK_SECRET?.trim();
    if (!url) {
      if (this.store.getEventSubscription(ENV_SUBSCRIPTION_ID)) this.store.deleteEventSubscription(ENV_SUBSCRIPTION_ID);
      return;
    }
    try {
      if (!secret) throw new EventRequestError(INVALID_PARAMS, 'WHATSAPP_WEBHOOK_SECRET is required with WHATSAPP_WEBHOOK_URL.');
      validateSecret(secret);
      const ids = process.env.WHATSAPP_WEBHOOK_CHAT_IDS?.split(',').map(id => id.trim()).filter(Boolean);
      const { chatIds, includeOwn } = this.resolveFilter({
        ...(ids?.length ? { chat_ids: ids } : {}), include_own: process.env.WHATSAPP_WEBHOOK_INCLUDE_OWN === '1',
      });
      const existing = this.store.getEventSubscription(ENV_SUBSCRIPTION_ID);
      this.store.saveEventSubscription({
        id: ENV_SUBSCRIPTION_ID, url, secret, chatIds, includeOwn,
        cursor: existing?.cursor ?? this.store.latestEventSeq(), expiresAt: null, active: true,
        createdAt: existing?.createdAt ?? this.now(),
      });
    } catch (error) {
      log.error('The configured WhatsApp webhook is not usable:', error instanceof Error ? error.message : String(error));
    }
  }

  hasSubscriptions(): boolean {
    return this.store.getEventSubscriptions().some(sub => sub.active);
  }

  private matches(sub: StoredEventSubscription, chatId: string, fromMe: boolean): boolean {
    return (sub.includeOwn || !fromMe) && (sub.chatIds === null || sub.chatIds.includes(chatId));
  }

  /**
   * Adds messages to the log. `live` messages are new by definition; anything else
   * (offline catch-up, history) only counts if it is younger than a subscription.
   */
  record(messages: SimpleMessage[], live: boolean): void {
    const subscriptions = this.store.getEventSubscriptions().filter(sub => sub.active);
    if (!subscriptions.length) return;
    let added = false;
    for (const message of [...messages].sort((a, b) => a.timestamp - b.timestamp)) {
      const { chatId } = message;
      if (!chatId || chatId === 'status@broadcast' || !DELIVERABLE_TYPES.has(message.type)) continue;
      const wanted = subscriptions.some(sub => this.matches(sub, chatId, message.fromMe)
        && (live || message.timestamp * 1000 >= sub.createdAt));
      if (!wanted) continue;
      const eventId = `evt_${createHash('sha256').update(message.id).digest('hex').slice(0, 32)}`;
      if (this.store.appendEvent({ eventId, chatId, messageId: message.id, fromMe: message.fromMe, occurredAt: message.timestamp * 1000 })) added = true;
    }
    if (added) this.wakeAll();
  }

  private state(id: string): DeliveryState {
    let state = this.states.get(id);
    if (!state) this.states.set(id, (state = { running: false, again: false, attempts: 0 }));
    return state;
  }

  private resetBackoff(id: string): void {
    const state = this.state(id);
    state.attempts = 0;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
  }

  private forget(id: string): void {
    const state = this.states.get(id);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(id);
  }

  private wakeAll(): void {
    for (const sub of this.store.getEventSubscriptions()) if (sub.active) this.wake(sub.id);
  }

  private wake(id: string): void {
    if (this.stopped) return;
    const state = this.state(id);
    if (state.timer) return; // waiting out a backoff; a refresh clears it first
    if (state.running) { state.again = true; return; }
    void this.drain(id, state).catch(error => log.error('Webhook delivery stopped unexpectedly:', error));
  }

  private schedule(id: string, state: DeliveryState, delayMs: number): void {
    if (this.stopped || state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.wake(id);
    }, delayMs);
    state.timer.unref?.();
  }

  private async drain(id: string, state: DeliveryState): Promise<void> {
    state.running = true;
    try {
      for (;;) {
        if (this.stopped || this.states.get(id) !== state) return;
        const sub = this.store.getEventSubscription(id);
        if (!sub?.active) return;
        if (sub.expiresAt !== null && sub.expiresAt <= this.now()) {
          log.info(`Webhook subscription ${id} expired without a refresh.`);
          this.store.deleteEventSubscription(id);
          this.forget(id);
          return;
        }
        const event = this.store.nextEvent(sub.cursor);
        if (!event) {
          this.store.pruneEvents(this.now() - RETENTION_MS, this.now());
          return;
        }
        const outcome = await this.deliver(sub, event);
        if (this.stopped || this.states.get(id) !== state) return;
        if (outcome.kind === 'done') {
          this.store.setEventCursor(id, event.seq);
          state.attempts = 0;
          continue;
        }
        if (outcome.kind === 'suspend') {
          log.warn(`Webhook subscription ${id} suspended: ${outcome.reason}`);
          this.store.setEventSubscriptionActive(id, false);
          return;
        }
        if (outcome.kind === 'wait') {
          this.schedule(id, state, outcome.delayMs);
          return;
        }
        const delay = this.retryDelays[Math.min(state.attempts, this.retryDelays.length - 1)];
        state.attempts++;
        log.warn(`Webhook delivery failed (${outcome.reason}); retrying in ${Math.round(delay / 1000)}s.`);
        this.schedule(id, state, delay);
        return;
      }
    } finally {
      state.running = false;
      if (state.again) {
        state.again = false;
        this.wake(id);
      }
    }
  }

  private async deliver(sub: StoredEventSubscription, event: StoredEvent): Promise<Outcome> {
    if (!this.matches(sub, event.chatId, event.fromMe) || event.occurredAt < sub.createdAt - 60_000) return { kind: 'done' };
    let message: SimpleMessage | null;
    try {
      await this.host.ensureReady(WHATSAPP_WAIT_MS);
      message = await this.host.getMessage(event.messageId);
      if (message) message = await this.host.annotate(message);
    } catch (error) {
      log.debug('WhatsApp is not ready for webhook delivery:', error instanceof Error ? error.message : String(error));
      return { kind: 'wait', delayMs: WHATSAPP_RETRY_MS };
    }
    if (!message) return { kind: 'done' }; // deleted since it arrived
    const { mediaKey: _mediaKey, ...data } = message;
    const body = JSON.stringify({
      eventId: event.eventId, name: MESSAGE_RECEIVED,
      timestamp: new Date(event.occurredAt).toISOString(), data, cursor: String(event.seq),
    });
    const timestampSeconds = Math.floor(this.now() / 1000);
    let response: Response;
    try {
      response = await this.fetcher(sub.url, {
        method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'webhook-id': event.eventId,
          'webhook-timestamp': String(timestampSeconds),
          'webhook-signature': signWebhook(sub.secret, event.eventId, timestampSeconds, body),
          'x-mcp-subscription-id': sub.id,
        },
      });
    } catch (error) {
      return { kind: 'fail', reason: error instanceof Error ? error.name : 'network error' };
    }
    void response.body?.cancel().catch(() => {});
    const status = response.status;
    if (status >= 200 && status < 300) return { kind: 'done' };
    if (status === 410) return { kind: 'suspend', reason: 'the receiver answered 410 Gone' };
    if (status === 413) {
      log.warn(`Webhook receiver refused event ${event.eventId} as too large; skipping it.`);
      return { kind: 'done' };
    }
    if (status === 425 || status === 429 || status === 503) {
      const seconds = Number(response.headers.get('retry-after'));
      return { kind: 'wait', delayMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : this.notReadyDelay };
    }
    return { kind: 'fail', reason: `status ${status}` };
  }
}
