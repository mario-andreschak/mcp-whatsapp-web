import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  type AnyMessageContent,
  type BaileysEventMap,
  type Chat,
  type Contact,
  type GroupMetadata,
  type UserFacingSocketConfig,
  type WACallEvent,
  type WACallUpdateType,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type WAVersion,
} from '@whiskeysockets/baileys';
import { readdirSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { BaileysStore, SessionInUseError } from './baileys-store.js';
import {
  CALL_FRESH_MS, MessageEvents, type CallContact, type CallDetails, type CallEndReason, type MessageEventDeps,
} from './events.js';
import { transcriberFor } from './transcriber.js';
import type {
  BackendStatus, ConnectionState, ConnectionStatus, MediaData, SentMessage, SimpleChat, SimpleContact, SimpleMessage, WhatsAppBackend,
} from './backend.js';
import { log } from '../utils/logger.js';
import { baileysFolderHoldsSignIn, chooseSignInFolder } from '../utils/data-paths.js';

export type BaileysSocket = Pick<WASocket,
  'ev' | 'end' | 'logout' | 'requestPairingCode' | 'sendMessage' |
  'fetchMessageHistory' | 'updateMediaMessage' | 'groupMetadata' | 'user' | 'rejectCall'>;

/** Socket injection keeps tests offline; no browser or live connection is needed. */
export interface BaileysServiceDeps {
  sessionDir?: string;
  socketFactory?: (config: UserFacingSocketConfig) => BaileysSocket;
  downloadMedia?: typeof downloadMediaMessage;
  /** First reconnect delay; it doubles with each quick attempt. */
  reconnectDelayMs?: number;
  /** Pace of the endless slow attempts after the quick ones. */
  slowReconnectDelayMs?: number;
  /** How many dated backups of discarded sign-ins to keep. */
  keepBackups?: number;
  events?: MessageEventDeps;
  historyRequestTimeoutMs?: number;
  /** Current WhatsApp Web version; defaults to a lookup unless a socket factory is injected. */
  resolveVersion?: () => Promise<WAVersion | undefined>;
}

/** Parses "2.3000.1053895232" into a Baileys version tuple. */
export function parseWaVersion(value: string | undefined): WAVersion | undefined {
  const parts = value?.trim().split('.').map(Number);
  if (!parts || parts.length !== 3 || !parts.every(part => Number.isInteger(part) && part >= 0)) return undefined;
  return parts as WAVersion;
}

/**
 * How this server appears under Linked devices. WhatsApp currently ends new links that
 * claim to be the "Desktop" app (status 428), so the default is "Chrome", which links but
 * receives recent history only. BAILEYS_BROWSER=Desktop asks for the full history again.
 */
export function linkedDeviceBrowser(app = process.env.BAILEYS_BROWSER?.trim() || 'Chrome'): [string, string, string] {
  return process.platform === 'darwin' ? Browsers.macOS(app) : Browsers.windows(app);
}

async function fetchCurrentWaWebVersion(): Promise<WAVersion | undefined> {
  const { version, isLatest } = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10_000) });
  return isLatest ? version : undefined;
}

/** How a call stopped ringing, by the status WhatsApp reports. */
const CALL_END_REASONS: Partial<Record<WACallUpdateType, CallEndReason>> = {
  timeout: 'missed', reject: 'rejected', accept: 'answered_elsewhere', terminate: 'ended',
};
/** Forget a ringing call that never reported an end, e.g. across a lost connection. */
const CALL_RING_LIMIT_MS = 3 * 60_000;

interface RingingCall {
  details: CallDetails;
  /** The caller id exactly as WhatsApp sent it; a rejection must be addressed to it. */
  creator: string;
  timer: ReturnType<typeof setTimeout>;
}

function phoneNumberJid(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes('@')) {
    const jid = jidNormalizedUser(value);
    return jid?.endsWith('@s.whatsapp.net') ? jid : undefined;
  }
  const digits = value.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : undefined;
}

function numberOf(jid: string | undefined): string {
  return jid?.endsWith('@s.whatsapp.net') ? jid.split('@')[0]! : '';
}

/** Quick attempts (1s, 2s, 4s ... up to a minute apart) before settling into a slow, steady pace. */
const QUICK_RECONNECT_ATTEMPTS = 8;
const QUICK_RECONNECT_MAX_DELAY_MS = 60_000;
/** After the quick attempts, keep trying this often for as long as the server runs. */
const SLOW_RECONNECT_DELAY_MS = 5 * 60_000;
/** Someone waiting for the link may pull a slow attempt forward, but not more often than this. */
const MIN_ATTEMPT_SPACING_MS = 30_000;
const SIGN_IN_BACKUPS_KEPT = 3;

/** Delay before reconnect attempt number `attempt` (counting from 0). Never gives up. */
export function reconnectDelay(attempt: number, firstDelayMs = 1_000, slowDelayMs = SLOW_RECONNECT_DELAY_MS): number {
  const quick = Math.min(firstDelayMs * 2 ** Math.min(Math.max(attempt, 0), 30), QUICK_RECONNECT_MAX_DELAY_MS);
  return attempt < QUICK_RECONNECT_ATTEMPTS ? quick : Math.max(quick, slowDelayMs);
}

export interface DisconnectDescription {
  code?: number;
  /** Why the connection ended, in plain words. */
  reason: string;
  /** WhatsApp clearly said this linked device was removed; the sign-in can no longer work. */
  deviceRemoved: boolean;
}

/**
 * Only a clear "this device was removed" from WhatsApp counts as signed out: status 401
 * (logged out / unlinked on the phone) or a conflict of type device_removed. Everything
 * else, including stray stream errors that Baileys reports as a bad session (500) and a
 * refused account (403), keeps the sign-in.
 */
export function describeDisconnect(error: unknown): DisconnectDescription {
  const value = error as { message?: unknown; output?: { statusCode?: unknown }; data?: unknown } | undefined;
  const code = typeof value?.output?.statusCode === 'number' ? value.output.statusCode : undefined;
  const data = value?.data as { tag?: unknown; attrs?: { type?: unknown } } | undefined;
  const message = typeof value?.message === 'string' ? value.message : '';
  const deviceRemoved = code === DisconnectReason.loggedOut || (data?.tag === 'conflict' && data.attrs?.type === 'device_removed');
  const suffix = code !== undefined ? ` (code ${code})` : '';
  let reason: string;
  if (deviceRemoved) reason = 'WhatsApp removed this linked device: it was unlinked on the phone, or WhatsApp ended the link.';
  else if (/QR refs attempts ended/i.test(message)) reason = 'The QR code expired before anyone scanned it.';
  else if (code === DisconnectReason.restartRequired) reason = 'WhatsApp asked for a routine restart of the connection.';
  else if (code === DisconnectReason.connectionClosed) reason = 'The connection was closed, often by a short network interruption.';
  else if (code === DisconnectReason.timedOut) reason = 'The connection timed out: the network or WhatsApp did not answer in time.';
  else if (code === DisconnectReason.connectionReplaced) reason = 'Another copy of this sign-in connected from somewhere else.';
  else if (code === DisconnectReason.badSession) reason = 'WhatsApp sent an unexpected error message. The sign-in is kept.';
  else if (code === DisconnectReason.unavailableService) reason = 'WhatsApp\'s service was temporarily unavailable.';
  else if (code === DisconnectReason.forbidden) reason = 'WhatsApp refused the connection for this account. The sign-in is kept.';
  else if (code === DisconnectReason.multideviceMismatch) reason = 'WhatsApp reported a linked-device mismatch.';
  else reason = 'The connection dropped.';
  return { ...(code !== undefined ? { code } : {}), reason: reason + suffix, deviceRemoved };
}

/**
 * Sets a discarded sign-in aside as a dated copy in `<folder>/backups` instead of deleting it,
 * keeping only the newest few. Returns the copy's path, or undefined when there was nothing to keep.
 */
export function backupSignIn(store: BaileysStore, sessionDir: string, keep = SIGN_IN_BACKUPS_KEPT, now = new Date()): string | undefined {
  const counts = store.getCounts();
  if (!store.hasLinkedAccount() && counts.messageCount + counts.chatCount + counts.contactCount === 0) return undefined;
  const folder = path.join(sessionDir, 'backups');
  const file = path.join(folder, `session-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`);
  store.backupTo(file);
  pruneBackups(folder, keep);
  return file;
}

function pruneBackups(folder: string, keep: number): void {
  const backups = readdirSync(folder).filter(name => /^session-.+\.sqlite$/.test(name)).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - Math.max(1, keep)))) {
    try { rmSync(path.join(folder, name), { force: true }); }
    catch (error) { log.warn(`Could not remove the old sign-in backup ${name}:`, error); }
  }
}

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000));
  return value === 1 ? '1 minute' : `${value} minutes`;
}

const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const HISTORY_NOTE = 'Only history delivered to this linked device and persisted locally is searchable; '
  + 'WhatsApp may supply an incomplete history. A chat query can request up to 100 older messages once per minute.';

/** The entire key is required: WhatsApp message IDs alone are not globally unique. */
export function encodeMessageId(key: WAMessageKey): string {
  if (!key.id || !key.remoteJid) throw new Error('WhatsApp returned an incomplete message key.');
  return `b1:${Buffer.from(JSON.stringify({
    remoteJid: key.remoteJid,
    id: key.id,
    fromMe: !!key.fromMe,
    ...(key.participant ? { participant: key.participant } : {}),
  })).toString('base64url')}`;
}

export function decodeMessageId(id: string): WAMessageKey {
  try {
    if (!id.startsWith('b1:') || id.length > 4096) throw new Error('format');
    const key: unknown = JSON.parse(Buffer.from(id.slice(3), 'base64url').toString('utf8'));
    if (!key || typeof key !== 'object') throw new Error('key');
    const value = key as Record<string, unknown>;
    if (typeof value.remoteJid !== 'string' || !value.remoteJid.includes('@')
      || typeof value.id !== 'string' || !value.id || typeof value.fromMe !== 'boolean'
      || (value.participant !== undefined && typeof value.participant !== 'string')) throw new Error('key');
    return {
      remoteJid: value.remoteJid, id: value.id, fromMe: value.fromMe,
      ...(value.participant ? { participant: value.participant as string } : {}),
    };
  } catch {
    throw new Error('Invalid Baileys message ID. Use the opaque ID returned by this backend.');
  }
}

function timestamp(value: unknown): number {
  if (value && typeof value === 'object' && 'low' in value && 'high' in value) {
    return (Number(value.low) >>> 0) + Number(value.high) * 0x100000000;
  }
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Limit must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export class BaileysService implements WhatsAppBackend {
  readonly backend = 'baileys' as const;
  private readonly deps: BaileysServiceDeps;
  readonly sessionDir: string;
  private store?: BaileysStore;
  private events?: MessageEvents;
  private socket?: BaileysSocket;
  private ready = false;
  private stopped = true;
  private generation = 0;
  private intent = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private initPromise?: Promise<void>;
  private latestQr: string | null = null;
  private latestPairing: string | null = null;
  private pairingPromise?: Promise<string>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private pendingReconnect?: () => void;
  private nextAttemptAt?: number;
  private lastAttemptAt = 0;
  private terminalError?: Error;
  /** Set while another program holds this sign-in; cleared once this server owns it. */
  private lockError?: SessionInUseError;
  private connectionState: ConnectionState = 'connecting';
  private stateSince = Date.now();
  private lastReason?: string;
  private historySyncing = false;
  private readonly historySyncTypes = new Set<number>();
  private readonly groupCache = new Map<string, { value: GroupMetadata; expiresAt: number }>();
  private readonly listeners = new Set<() => void>();
  private readonly detachListeners: Array<() => void> = [];
  private readonly messageListeners: Array<(message: SimpleMessage) => void> = [];
  private waVersion?: WAVersion;
  private readonly historyRequests = new Map<string, number>();
  private readonly historyInflight = new Map<string, Promise<void>>();
  private readonly ringingCalls = new Map<string, RingingCall>();

  constructor(deps: BaileysServiceDeps = {}) {
    this.deps = deps;
    const folder = chooseSignInFolder({
      configured: deps.sessionDir ?? process.env.BAILEYS_SESSION_DIR,
      settingName: 'BAILEYS_SESSION_DIR',
      folderName: 'baileys-sessions',
      holdsSignIn: baileysFolderHoldsSignIn,
    });
    this.sessionDir = folder.dir;
    log.info(folder.explanation);
  }

  private setState(state: ConnectionState): void {
    if (state === this.connectionState) return;
    this.connectionState = state;
    this.stateSince = Date.now();
  }

  /** Opens the sign-in folder (once) and says in the log whether it holds a sign-in. */
  private openStore(): BaileysStore {
    if (this.store) return this.store;
    const store = new BaileysStore(this.sessionDir);
    this.store = store;
    this.lockError = undefined;
    log.info(store.hasLinkedAccount()
      ? 'The sign-in folder holds a saved sign-in, so no QR code should be needed.'
      : 'The sign-in folder holds no sign-in yet. Link this server with get_qr_code or request_pairing_code.');
    return store;
  }

  /** Another program holds the sign-in: keep checking, and take over once it closes. */
  private waitForOtherProgram(error: SessionInUseError, intent: number): void {
    const first = !this.lockError;
    this.lockError = error;
    this.lastReason = 'Another program is using this sign-in.';
    this.setState('waiting_for_other_program');
    if (first) log.warn(`${error.message} This server keeps checking and takes over when the other program closes.`);
    this.scheduleReconnect(intent, false);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  initialize(): Promise<void> {
    if (this.initPromise && !this.stopped) return this.initPromise;
    if (this.socket && !this.stopped) return Promise.resolve();
    this.cancelReconnect();
    const intent = ++this.intent;
    this.stopped = false;
    this.terminalError = undefined;
    this.lockError = undefined;
    this.lastReason = undefined;
    this.reconnectAttempts = 0;
    this.setState('connecting');
    this.stateSince = Date.now();
    const pending = this.enqueue(async () => {
      if (this.intent !== intent || this.stopped) return;
      this.closeSocket();
      try {
        const store = this.openStore();
        this.startEvents(store);
        await this.openSocket(intent);
      } catch (error) {
        this.closeSocket();
        this.stopEvents();
        if (error instanceof SessionInUseError && this.intent === intent && !this.stopped) {
          this.waitForOtherProgram(error, intent);
          throw error;
        }
        this.store?.close();
        this.store = undefined;
        this.stopped = true;
        this.terminalError = error instanceof Error ? error : new Error(String(error));
        this.setState('stopped');
        throw error;
      }
    });
    this.initPromise = pending;
    void pending.finally(() => { if (this.initPromise === pending) this.initPromise = undefined; }).catch(() => {});
    return pending;
  }

  /**
   * WhatsApp refuses new links from clients that report an outdated web version, so the
   * version Baileys ships with stops working a few weeks after each release. Look up the
   * current one once per process; WA_WEB_VERSION pins it, and a failed lookup falls back
   * to the Baileys default instead of blocking the connection.
   */
  private async clientVersion(): Promise<WAVersion | undefined> {
    if (this.waVersion) return this.waVersion;
    const pinned = parseWaVersion(process.env.WA_WEB_VERSION);
    if (pinned) return (this.waVersion = pinned);
    if (process.env.WA_WEB_VERSION?.trim()) log.warn(`Ignoring WA_WEB_VERSION '${process.env.WA_WEB_VERSION}': expected a form like 2.3000.1053895232.`);
    const resolve = this.deps.resolveVersion ?? (this.deps.socketFactory ? undefined : fetchCurrentWaWebVersion);
    if (!resolve) return undefined;
    try {
      const found = await resolve();
      if (found) this.waVersion = found;
      return found;
    } catch (error) {
      log.warn('Could not look up the current WhatsApp Web version; using the Baileys default.', error);
      return undefined;
    }
  }

  private async openSocket(intent: number): Promise<void> {
    const store = this.requireStore();
    const { state, saveCreds } = await store.createAuthState();
    const version = await this.clientVersion();
    if (intent !== this.intent || this.stopped) return;
    const generation = ++this.generation;
    const withCurrentAuth = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      if (generation !== this.generation || this.stopped) throw new Error('This Baileys socket authentication state is no longer active.');
      try { return await operation(); }
      catch (error) { this.eventFailure(error, generation); throw error; }
    };
    const config: UserFacingSocketConfig = {
      auth: {
        creds: state.creds,
        keys: {
          ...state.keys,
          get: (category, ids) => withCurrentAuth(() => state.keys.get(category, ids)),
          set: data => withCurrentAuth(() => state.keys.set(data)),
        },
      },
      ...(version ? { version } : {}),
      logger: log,
      browser: linkedDeviceBrowser(),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 15_000,
      getMessage: async key => generation === this.generation ? store.getRawMessage(key)?.message ?? undefined : undefined,
      cachedGroupMetadata: async jid => {
        if (generation !== this.generation || this.stopped || !this.socket) return undefined;
        const cached = this.groupCache.get(jid);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
        const metadata = await this.socket.groupMetadata(jid);
        if (generation !== this.generation || this.stopped) return undefined;
        if (this.groupCache.size >= 1000) this.groupCache.delete(this.groupCache.keys().next().value!);
        this.groupCache.set(jid, { value: metadata, expiresAt: Date.now() + 5 * 60_000 });
        return metadata;
      },
    };
    const socket = (this.deps.socketFactory ?? makeWASocket)(config);
    this.socket = socket;
    const on = <E extends keyof BaileysEventMap>(event: E, handler: (value: BaileysEventMap[E]) => void | Promise<void>) => {
      const listener = (value: BaileysEventMap[E]) => {
        if (generation !== this.generation || this.stopped) return;
        try {
          void Promise.resolve(handler(value)).catch(error => this.eventFailure(error, generation));
        } catch (error) {
          this.eventFailure(error, generation);
        }
      };
      socket.ev.on(event, listener);
      this.detachListeners.push(() => socket.ev.off(event, listener));
    };
    on('creds.update', update => saveCreds(update));
    on('connection.update', update => {
      if (update.qr) {
        this.latestQr = update.qr;
        this.latestPairing = null;
        this.setState('waiting_for_link');
        if (process.env.WHATSAPP_PAIRING_PHONE_NUMBER && !state.creds.registered) {
          void this.requestPairingCode(process.env.WHATSAPP_PAIRING_PHONE_NUMBER).then(code => {
            if (generation === this.generation && !this.stopped) {
              process.stderr.write(`\nWhatsApp pairing code: ${code}\nEnter it under Linked devices > Link with phone number instead.\n`);
            }
          }).catch(error => {
            if (generation === this.generation) log.warn('Could not request WhatsApp pairing code:', error);
          });
        }
      }
      if (update.isNewLogin) {
        this.latestQr = null;
        this.latestPairing = null;
      }
      if (update.connection === 'open') {
        this.ready = true;
        this.latestQr = null;
        this.latestPairing = null;
        if (this.connectionState === 'reconnecting') {
          log.info(`Connected to WhatsApp again after ${minutes(Date.now() - this.stateSince)} away. The sign-in was kept.`);
        } else {
          log.info('Connected to WhatsApp.');
        }
        this.reconnectAttempts = 0;
        this.terminalError = undefined;
        this.setState('linked');
        this.historySyncing = !store.getMeta<number>('history_synced_at');
      }
      if (update.connection === 'close') {
        this.ready = false;
        this.latestQr = null;
        this.latestPairing = null;
        const closed = describeDisconnect(update.lastDisconnect?.error);
        this.lastReason = closed.reason;
        if (closed.deviceRemoved) {
          this.discardSignIn(intent, closed.reason);
        } else if (closed.code === DisconnectReason.connectionReplaced || closed.code === DisconnectReason.multideviceMismatch) {
          // Reconnecting would push the other copy off, which would push this one off again.
          this.stopped = true;
          this.terminalError = new Error(closed.code === DisconnectReason.connectionReplaced
            ? 'Another copy of this sign-in connected from somewhere else, so this server stopped to keep the two from '
              + 'pushing each other off. Give each program its own sign-in folder and link it as its own device '
              + '(WhatsApp allows several linked devices), then restart this server. The sign-in was kept.'
            : `${closed.reason} Restart the server; the sign-in was kept.`);
          log.warn(this.terminalError.message);
          this.setState('stopped');
          this.cancelReconnect();
          this.closeSocket();
        } else {
          const restart = closed.code === DisconnectReason.restartRequired;
          if (!restart) {
            const linked = !!state.creds.me?.id;
            if (linked) log.warn(`WhatsApp connection dropped: ${closed.reason} Reconnecting by itself; the sign-in is kept.`);
            else log.info(`${closed.reason} A new QR code follows with the next attempt.`);
            this.setState(linked ? 'reconnecting' : 'waiting_for_link');
          }
          this.closeSocket();
          this.scheduleReconnect(intent, restart);
        }
      }
    });
    on('messaging-history.set', data => {
      store.transaction(() => {
        for (const mapping of data.lidPnMappings ?? []) store.setLidMapping(mapping.lid, mapping.pn);
        store.upsertContacts(data.contacts);
        store.upsertChats(data.chats);
        store.upsertMessages(data.messages);
        store.setMeta('history_synced_at', Date.now());
      });
      this.recordEvents(data.messages, false);
      // isLatest identifies the first history notification; it does not mean sync is complete.
      if (data.syncType != null) {
        if (data.progress === 100) this.historySyncTypes.delete(data.syncType);
        else this.historySyncTypes.add(data.syncType);
      }
      this.historySyncing = this.historySyncTypes.size > 0 || data.progress !== 100;
    });
    on('messaging-history.status', data => {
      this.historySyncTypes.delete(data.syncType);
      this.historySyncing = this.historySyncTypes.size > 0;
    });
    on('contacts.upsert', contacts => store.upsertContacts(contacts));
    on('contacts.update', contacts => store.upsertContacts(contacts));
    on('chats.upsert', chats => store.upsertChats(chats));
    on('chats.update', chats => store.upsertChats(chats.map(chat => ({
      ...chat,
      // Baileys emits positive unread deltas; null/negative values reset the count.
      ...(chat.unreadCount !== undefined ? {
        unreadCount: typeof chat.unreadCount === 'number' && chat.unreadCount >= 0
          ? Math.max(0, store.getChat(chat.id!)?.unreadCount ?? 0) + chat.unreadCount : 0,
      } : {}),
    }))));
    on('chats.delete', chats => store.deleteChats(chats));
    on('messages.upsert', data => {
      store.upsertMessages(data.messages);
      this.recordEvents(data.messages, data.type === 'notify');
      // Only live messages wake listeners; `append` carries history and offline catch-up.
      if (data.type === 'notify') for (const raw of data.messages) this.notifyMessage(raw);
    });
    on('messages.update', updates => store.updateMessages(updates));
    on('messages.delete', data => store.deleteMessages(data));
    on('lid-mapping.update', mapping => store.setLidMapping(mapping.lid, mapping.pn));
    const updateGroups = (groups: Partial<GroupMetadata>[]) => {
      for (const group of groups) {
        if (!group.id) continue;
        this.groupCache.delete(group.id);
        if (group.subject !== undefined) store.upsertChats([{ id: group.id, name: group.subject }]);
      }
    };
    on('groups.upsert', updateGroups);
    on('groups.update', updateGroups);
    on('group-participants.update', update => { this.groupCache.delete(update.id); });
    on('call', calls => this.handleCalls(calls));
  }

  /** Never throws: a failing call event must not stop the connection. */
  private handleCalls(calls: WACallEvent[]): void {
    for (const call of calls ?? []) {
      try { this.handleCall(call); } catch (error) { log.error('Could not handle a WhatsApp call event:', error); }
    }
  }

  private handleCall(call: WACallEvent): void {
    if (!call?.id) return;
    const time = call.date instanceof Date ? call.date.getTime() : Number.NaN;
    const at = Number.isFinite(time) ? time : Date.now();
    if (call.status === 'offer') {
      // Only a call that is ringing right now: never one replayed after being offline.
      if (call.offline || Date.now() - at > CALL_FRESH_MS || this.ringingCalls.has(call.id)) return;
      const details = this.callDetails(call);
      if (this.getSelfIds().includes(details.from)) return; // a call this account placed elsewhere
      const timer = setTimeout(() => this.endCall(call.id, 'ended', Date.now()), CALL_RING_LIMIT_MS);
      timer.unref?.();
      this.ringingCalls.set(call.id, { details, creator: call.from || call.chatId, timer });
      try { this.events?.recordCallReceived(details, at); } catch (error) { log.error('Could not record a call event:', error); }
      return;
    }
    const reason = CALL_END_REASONS[call.status];
    if (reason) this.endCall(call.id, reason, at);
  }

  private endCall(callId: string, reason: CallEndReason, at: number): void {
    const ringing = this.ringingCalls.get(callId);
    if (!ringing) return;
    clearTimeout(ringing.timer);
    this.ringingCalls.delete(callId);
    try { this.events?.recordCallEnded(ringing.details, reason, at); } catch (error) { log.error('Could not record a call event:', error); }
  }

  private clearRingingCalls(): void {
    for (const ringing of this.ringingCalls.values()) clearTimeout(ringing.timer);
    this.ringingCalls.clear();
  }

  private safeJid(jid: string): string {
    try { return this.normalizeJid(jid); } catch { return jidNormalizedUser(jid) || jid; }
  }

  private callDetails(call: WACallEvent): CallDetails {
    const pn = phoneNumberJid(call.callerPn);
    if (pn) {
      // A caller known only by its private id (@lid) comes with its number; remember the pair.
      for (const id of new Set([call.from, call.chatId])) {
        if (!id?.endsWith('@lid')) continue;
        try { this.requireStore().setLidMapping(id, pn); }
        catch (error) { log.debug('Could not store the caller number mapping:', error); }
      }
    }
    const from = this.safeJid(call.from || call.chatId);
    const chatId = call.isGroup && call.groupJid ? this.safeJid(call.groupJid) : this.safeJid(call.chatId || call.from);
    return { callId: call.id, chatId, from, isVideo: !!call.isVideo, isGroup: !!call.isGroup, contact: this.callContact(from, pn) };
  }

  /** The stored contact, as get_contact returns it; without one, what the ids alone tell. */
  private callContact(id: string, pn: string | undefined): CallContact {
    const number = numberOf(id) || numberOf(pn);
    try {
      const stored = this.requireStore().getContact(id);
      if (stored) {
        const contact = this.mapContact(stored);
        return { id: contact.id, name: contact.name, pushname: contact.pushname, number: contact.number || number, isMyContact: contact.isMyContact };
      }
    } catch (error) {
      log.warn('Could not look up the caller; announcing the call without a saved name:', error);
    }
    return { id, name: null, pushname: '', number, isMyContact: false };
  }

  /** Declines a call that is ringing on this account right now. */
  async rejectCall(callId: string): Promise<void> {
    const ringing = this.ringingCalls.get(callId);
    if (!ringing) throw new Error(`Call ${callId} is not ringing (it already ended, or this server never saw it).`);
    await this.ensureReady(5_000);
    const socket = this.socket;
    if (!socket || typeof socket.rejectCall !== 'function') throw new Error('This WhatsApp connection cannot decline calls.');
    await socket.rejectCall(callId, ringing.creator);
    this.endCall(callId, 'rejected', Date.now());
  }

  private startEvents(store: BaileysStore): void {
    this.events ??= new MessageEvents(store, {
      normalizeChatId: id => this.normalizeJid(id),
      getMessage: id => this.getMessageById(id),
      ensureReady: timeoutMs => this.ensureReady(timeoutMs),
      annotate: async message => {
        const transcriber = transcriberFor(this);
        const [annotated] = await transcriber.annotate([message], transcriber.configured);
        return annotated;
      },
    }, this.deps.events);
    this.events.start();
  }

  /** The store opens during initialize(), which can still be pending when a client subscribes. */
  async messageEvents(): Promise<MessageEvents> {
    const deadline = Date.now() + 30_000;
    while (!this.events) {
      if (this.terminalError) throw this.terminalError;
      if (Date.now() >= deadline) throw new Error('WhatsApp storage is not available yet. Try again shortly.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return this.events;
  }

  private stopEvents(): void {
    this.clearRingingCalls();
    this.events?.stop();
    this.events = undefined;
  }

  /** A failure here must not stop persistence or live listeners. */
  private recordEvents(raws: WAMessage[], live: boolean): void {
    if (!this.events?.hasSubscriptions()) return;
    try {
      const messages = raws.filter(raw => raw.key?.remoteJid && raw.message).map(raw => this.mapMessage(raw));
      this.events.record(messages, live);
    } catch (error) {
      log.error('Could not record message events:', error);
    }
  }

  onMessage(listener: (message: SimpleMessage) => void): void {
    this.messageListeners.push(listener);
  }

  /** A listener failure must not stop persistence or other listeners. */
  private notifyMessage(raw: WAMessage): void {
    if (!this.messageListeners.length || !raw.key?.remoteJid || !raw.message) return;
    let message: SimpleMessage;
    try { message = this.mapMessage(raw); } catch (error) { log.error('Could not map an incoming message:', error); return; }
    for (const listener of this.messageListeners) {
      try { listener(message); } catch (error) { log.error('A message listener failed:', error); }
    }
  }

  getSelfIds(): string[] {
    const user = this.socket?.user;
    return [user?.id, (user as { lid?: string } | undefined)?.lid]
      .filter((id): id is string => !!id).map(id => this.normalizeJid(id));
  }

  async sendReaction(messageId: string, emoji: string): Promise<void> {
    await this.ensureReady();
    await this.socket!.sendMessage(this.normalizeJid(decodeMessageId(messageId).remoteJid!), {
      react: { text: emoji, key: decodeMessageId(messageId) },
    });
  }

  /** Saving to the sign-in folder failed (for example a full disk): drop the connection and try again later. */
  private eventFailure(error: unknown, generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    log.error('Could not save WhatsApp data to the sign-in folder; reconnecting later:', error);
    this.lastReason = 'This server could not save WhatsApp data to the sign-in folder (is the disk full or the folder read-only?). '
      + 'The sign-in is kept.';
    this.setState('reconnecting');
    this.closeSocket();
    this.scheduleReconnect(this.intent, false);
  }

  /**
   * WhatsApp clearly said this device was removed. Set the old sign-in aside as a dated backup
   * (so a wrong decision can be undone), clear it, and offer a fresh link without a restart.
   */
  private discardSignIn(intent: number, reason: string): void {
    this.cancelReconnect();
    this.closeSocket();
    this.stopEvents();
    this.historyRequests.clear();
    this.historyInflight.clear();
    let backup: string | undefined;
    try {
      if (this.store) {
        backup = backupSignIn(this.store, this.sessionDir, this.deps.keepBackups ?? SIGN_IN_BACKUPS_KEPT);
        this.store.clear();
      }
    } catch (error) {
      log.error('Could not set the old sign-in aside safely, so it was left untouched:', error);
      this.stopped = true;
      this.terminalError = new Error(`${reason} The old sign-in could not be backed up, so it was left in place. `
        + 'Free some disk space and restart the server, or use the logout tool to start over.');
      this.setState('stopped');
      this.notifySessionInvalidated();
      return;
    }
    log.warn(`${reason} ${backup ? `The old sign-in was set aside as ${backup}.` : 'There was no saved sign-in to keep.'} `
      + 'Link this server again with get_qr_code or request_pairing_code.');
    this.notifySessionInvalidated();
    this.reconnectAttempts = 0;
    this.setState('waiting_for_link');
    this.scheduleReconnect(intent, false);
  }

  private scheduleReconnect(intent: number, restartRequired: boolean): void {
    if (this.stopped || this.reconnectTimer) return;
    const slow = this.deps.slowReconnectDelayMs ?? SLOW_RECONNECT_DELAY_MS;
    const delay = restartRequired ? 100 : reconnectDelay(this.reconnectAttempts, this.deps.reconnectDelayMs ?? 1_000, slow);
    if (!restartRequired) {
      if (this.reconnectAttempts === QUICK_RECONNECT_ATTEMPTS && this.connectionState !== 'waiting_for_link') {
        log.warn(`Still not connected after ${QUICK_RECONNECT_ATTEMPTS} quick attempts. `
          + `This server keeps trying every ${minutes(slow)} for as long as it runs.`);
      }
      this.reconnectAttempts++;
    }
    const run = () => {
      this.cancelReconnect();
      this.lastAttemptAt = Date.now();
      void this.enqueue(async () => {
        if (this.stopped || this.intent !== intent) return;
        this.closeSocket();
        const store = this.openStore();
        this.startEvents(store);
        await this.openSocket(intent);
      }).catch(error => {
        if (this.stopped || this.intent !== intent) return;
        this.closeSocket();
        if (error instanceof SessionInUseError) {
          this.waitForOtherProgram(error, intent);
          return;
        }
        this.lastReason = `The last reconnect attempt failed: ${error instanceof Error ? error.message : String(error)}`;
        log.warn('WhatsApp reconnect attempt failed; trying again later:', error);
        this.scheduleReconnect(intent, false);
      });
    };
    this.pendingReconnect = run;
    this.nextAttemptAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(run, delay);
    this.reconnectTimer.unref?.();
  }

  /** Someone is waiting for WhatsApp: try now instead of at the next slow-paced attempt. */
  private retrySoon(): void {
    const run = this.pendingReconnect;
    if (!run || !this.reconnectTimer || this.stopped || this.nextAttemptAt === undefined) return;
    const now = Date.now();
    if (this.nextAttemptAt - now <= 1_000 || now - this.lastAttemptAt < MIN_ATTEMPT_SPACING_MS) return;
    run();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.pendingReconnect = undefined;
    this.nextAttemptAt = undefined;
  }

  private closeSocket(): void {
    ++this.generation;
    this.ready = false;
    this.latestQr = null;
    this.latestPairing = null;
    this.pairingPromise = undefined;
    this.groupCache.clear();
    this.historySyncTypes.clear();
    this.historySyncing = false;
    for (const detach of this.detachListeners.splice(0)) detach();
    this.store?.invalidateAuthState();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try { socket.end(undefined); } catch (error) { log.warn('Baileys socket shutdown failed:', error); }
    }
  }

  destroy(): Promise<void> {
    ++this.intent;
    ++this.generation;
    this.stopped = true;
    this.ready = false;
    this.lastReason = 'The server is shutting down.';
    this.setState('stopped');
    this.cancelReconnect();
    return this.enqueue(async () => {
      this.closeSocket();
      this.stopEvents();
      this.store?.close();
      this.store = undefined;
    });
  }

  logout(): Promise<void> {
    ++this.intent;
    ++this.generation;
    this.stopped = true;
    this.ready = false;
    this.lastReason = 'This server was logged out on request.';
    this.setState('stopped');
    this.cancelReconnect();
    return this.enqueue(async () => {
      let logoutError: unknown;
      try {
        if (this.socket) await timeout(this.socket.logout(), 5_000, 'WhatsApp logout');
      } catch (error) { logoutError = error; }
      finally {
        this.closeSocket();
        this.stopEvents();
        try {
          this.store ??= new BaileysStore(this.sessionDir);
          this.store.clear();
          this.historyRequests.clear();
          this.historyInflight.clear();
        } finally {
          this.notifySessionInvalidated();
          this.store?.close();
          this.store = undefined;
        }
      }
      if (logoutError) throw new Error('Local Baileys credentials were cleared, but remote logout failed. Unlink the device on your phone.', { cause: logoutError });
    });
  }

  isAuthenticated(): boolean { return this.ready; }
  getLatestQrCode(): string | null { return this.latestQr; }
  getLatestPairingCode(): string | null { return this.latestPairing; }
  onSessionInvalidated(listener: () => void): void { this.listeners.add(listener); }

  private notifySessionInvalidated(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { log.warn('Session invalidation listener failed:', error); }
    }
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    const number = phoneNumber.replace(/\D/g, '');
    if (!/^\d{6,15}$/.test(number)) throw new Error('Provide a phone number with 6–15 digits including the country code.');
    if (this.ready) throw new Error('Client is already authenticated; no pairing code needed.');
    if (!this.socket || !this.latestQr || this.stopped) throw new Error('WhatsApp is not at the pairing stage yet. Wait for a QR code and try again.');
    if (this.pairingPromise) return this.pairingPromise;
    const generation = this.generation;
    const pending = timeout(this.socket.requestPairingCode(number), 15_000, 'Pairing code request').then(code => {
      if (generation !== this.generation || this.stopped) throw new Error('The connection changed during pairing. Try again.');
      this.latestPairing = code;
      return code;
    });
    this.pairingPromise = pending;
    try { return await pending; } finally { if (this.pairingPromise === pending) this.pairingPromise = undefined; }
  }

  async waitForAuthOutcome(timeoutMs = 25_000): Promise<void> {
    this.retrySoon();
    const deadline = Date.now() + timeoutMs;
    while (!this.ready && !this.latestQr && !this.latestPairing && !this.stopped && !this.lockError && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
  }

  async ensureReady(timeoutMs = Number(process.env.TOOL_READY_TIMEOUT_MS || 45_000)): Promise<void> {
    await this.waitForAuthOutcome(timeoutMs);
    if (this.ready) return;
    if (this.terminalError) throw this.terminalError;
    if (this.lockError) throw this.lockError;
    if (this.latestQr || this.latestPairing || this.connectionState === 'waiting_for_link') {
      throw new Error('WhatsApp is not authenticated: use get_qr_code or request_pairing_code to link this backend.');
    }
    if (this.connectionState === 'reconnecting') throw new Error(this.connectionStatus().summary);
    throw new Error('WhatsApp is not connected. Start the server or wait for reconnection and try again.');
  }

  /** What the link is doing right now, in plain words. */
  private connectionStatus(): ConnectionStatus {
    const since = new Date(this.stateSince).toISOString();
    const next = this.nextAttemptAt !== undefined ? new Date(this.nextAttemptAt).toISOString() : undefined;
    const retrying = this.connectionState === 'reconnecting' || this.connectionState === 'waiting_for_other_program';
    let summary: string;
    switch (this.connectionState) {
      case 'linked':
        summary = 'Linked and connected to WhatsApp.';
        break;
      case 'connecting':
        summary = 'Connecting to WhatsApp.';
        break;
      case 'waiting_for_link':
        summary = 'Not linked to a phone yet. Use get_qr_code (or request_pairing_code) and link it on the phone under '
          + 'Settings > Linked devices.';
        break;
      case 'reconnecting':
        summary = `The connection to WhatsApp has been down since ${since}. This server is reconnecting by itself `
          + `(attempt ${this.reconnectAttempts}${next ? `, next try at ${next}` : ', trying now'}). `
          + 'The sign-in is kept, so nothing needs to be scanned.'
          + (this.lastReason ? ` Last reason: ${this.lastReason}` : '');
        break;
      case 'waiting_for_other_program':
        summary = `${this.lockError?.message ?? 'Another program is using this sign-in.'} `
          + 'This server keeps checking and takes over when the other program closes.';
        break;
      default:
        summary = this.terminalError?.message ?? this.lastReason ?? 'The connection is stopped.';
    }
    return {
      state: this.connectionState,
      summary,
      since,
      ...(this.lastReason ? { lastReason: this.lastReason } : {}),
      ...(retrying ? { attempts: this.reconnectAttempts } : {}),
      ...(retrying && next ? { nextAttemptAt: next } : {}),
      signInFolder: this.sessionDir,
    };
  }

  getStatus(): BackendStatus {
    const lastSyncAt = this.store?.getMeta<number>('history_synced_at');
    const counts = this.store?.getCounts();
    const hasData = !!counts && counts.messageCount + counts.chatCount + counts.contactCount > 0;
    const problem = this.terminalError ?? this.lockError;
    return {
      backend: this.backend,
      authenticated: this.ready,
      connection: this.connectionStatus(),
      history: {
        state: this.historySyncing && this.ready ? 'syncing' : lastSyncAt || hasData ? 'available' : 'unavailable',
        ...counts,
        ...(lastSyncAt ? { lastSyncAt } : {}),
        note: (problem ? `${problem.message} ` : '')
          + (!lastSyncAt && hasData ? 'Phone history has not arrived; only locally observed records are currently available. ' : '') + HISTORY_NOTE,
      },
    };
  }

  private requireStore(): BaileysStore {
    if (!this.store) throw new Error('Baileys storage is not initialized.');
    return this.store;
  }

  private async historyStore(): Promise<BaileysStore> {
    await this.ensureReady();
    const store = this.requireStore();
    const counts = store.getCounts();
    if (!store.getMeta<number>('history_synced_at') && counts.messageCount + counts.chatCount + counts.contactCount === 0) {
      throw new Error('Baileys history has not arrived from the phone yet. Wait for history synchronization and check get_backend_status.');
    }
    return store;
  }

  private normalizeJid(jid: string): string {
    const normalized = jidNormalizedUser(jid.trim().replace(/@c\.us$/, '@s.whatsapp.net'));
    if (!/^[^@\s]+@(s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)$/.test(normalized)) {
      throw new Error('Invalid WhatsApp JID. Use a returned contact/chat ID, or an international phone number followed by @c.us.');
    }
    return this.requireStore().resolveJid(normalized);
  }

  async searchContacts(query: string): Promise<SimpleContact[]> {
    const store = await this.historyStore();
    const lower = query.toLowerCase();
    return store.getContacts().map(contact => this.mapContact(contact))
      .filter(contact => contact.isUser && [contact.name, contact.pushname, contact.number, contact.id].some(value => value?.toLowerCase().includes(lower)));
  }

  async getContactById(id: string): Promise<SimpleContact | null> {
    const store = await this.historyStore();
    const contact = store.getContact(this.normalizeJid(id));
    return contact ? this.mapContact(contact) : null;
  }

  async listChats(limit = 20, includeLastMessage = true): Promise<SimpleChat[]> {
    const store = await this.historyStore();
    return store.getChats(boundedLimit(limit, 1000)).map(chat => this.mapChat(chat, includeLastMessage));
  }

  async getChatById(id: string): Promise<SimpleChat | null> {
    const store = await this.historyStore();
    const chat = store.getChat(this.normalizeJid(id));
    return chat ? this.mapChat(chat, true) : null;
  }

  async getMessages(id: string, limit = 50): Promise<SimpleMessage[]> {
    const store = await this.historyStore();
    boundedLimit(limit, 1000);
    const jid = this.normalizeJid(id);
    let messages = store.getMessages(jid, limit);
    if (messages.length > 0 && messages.length < limit) {
      const active = this.historyInflight.get(jid);
      if (active) await active;
      else if (!this.historyRequests.has(jid) || Date.now() - this.historyRequests.get(jid)! >= 60_000) {
        this.historyRequests.set(jid, Date.now());
        const generation = this.generation;
        const oldest = messages[0]!;
        const request = (async () => {
          try {
            await timeout((async () => {
              await this.socket!.fetchMessageHistory(Math.min(100, limit - messages.length), oldest.key, timestamp(oldest.messageTimestamp) * 1000);
              const deadline = Date.now() + 2000;
              while (generation === this.generation && !this.stopped && Date.now() < deadline) {
                if (store.getMessages(jid, limit).length > messages.length) break;
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            })(), this.deps.historyRequestTimeoutMs ?? 3000, 'History request');
          } catch (error) { log.debug('Additional history was unavailable; returning the stored window:', error); }
        })();
        this.historyInflight.set(jid, request);
        try { await request; } finally { if (this.historyInflight.get(jid) === request) this.historyInflight.delete(jid); }
      }
      if (store !== this.store || this.stopped) throw new Error('WhatsApp disconnected while reading history. Try again after reconnection.');
      messages = store.getMessages(jid, limit);
    }
    return messages.map(message => this.mapMessage(message));
  }

  async getMessageById(id: string): Promise<SimpleMessage | null> {
    await this.ensureReady();
    const message = this.requireStore().getRawMessage(decodeMessageId(id));
    return message ? this.mapMessage(message) : null;
  }

  getVoiceTranscript(id: string): string | undefined {
    if (!this.store) return undefined;
    try { return this.store.getTranscript(decodeMessageId(id)); } catch { return undefined; }
  }

  saveVoiceTranscript(id: string, text: string): void {
    this.store?.setTranscript(decodeMessageId(id), text);
  }

  async sendMessage(to: string, content: string): Promise<SentMessage> {
    return this.sendContent(to, { text: content });
  }

  private async sendContent(to: string, content: AnyMessageContent, preparedGeneration?: number): Promise<SentMessage> {
    const intent = this.intent;
    await this.ensureReady();
    if (intent !== this.intent || (preparedGeneration !== undefined && preparedGeneration !== this.generation)) {
      throw new Error('The WhatsApp connection changed while preparing the message. Nothing was sent; try again.');
    }
    const store = this.requireStore();
    const generation = this.generation;
    // Deliberately do not retry sends: an ambiguous failure may already have delivered the message.
    const message = await this.socket!.sendMessage(this.normalizeJid(to), content);
    if (!message) throw new Error('WhatsApp did not return a message receipt. Check the chat before sending again.');
    if (store !== this.store || generation !== this.generation) throw new Error('The connection changed while sending. Check the chat before sending again.');
    store.upsertMessages([message]);
    return { id: encodeMessageId(message.key), timestamp: timestamp(message.messageTimestamp) };
  }

  async sendMedia(to: string, source: string, caption?: string): Promise<SentMessage> {
    await this.ensureReady();
    const generation = this.generation;
    let buffer: Buffer;
    let filename: string;
    let mime: string | undefined;
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Media download failed: HTTP ${response.status}.`);
      if (Number(response.headers.get('content-length')) > MAX_MEDIA_BYTES) throw new Error('Media exceeds the 64 MiB transfer limit.');
      mime = response.headers.get('content-type')?.split(';')[0];
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (!response.body) throw new Error('The media URL returned no data.');
      // Read with a reader instead of `for await`: whether a web stream can be looped over
      // depends on which type definitions happen to be installed around this project.
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_MEDIA_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error('Media exceeds the 64 MiB transfer limit.');
        }
        chunks.push(value);
      }
      buffer = Buffer.concat(chunks);
      filename = path.basename(decodeURIComponent(new URL(source).pathname)) || 'attachment';
    } else {
      if ((await stat(source)).size > MAX_MEDIA_BYTES) throw new Error('Media exceeds the 64 MiB transfer limit.');
      buffer = await readFile(source);
      filename = path.basename(source);
    }
    mime = (await fileTypeFromBuffer(buffer))?.mime ?? mime ?? this.extensionMime(filename);
    return this.sendContent(to, this.mediaContent(buffer, mime, filename, caption), generation);
  }

  async sendMediaFromBase64(to: string, data: string, mimeType: string, filename?: string, caption?: string): Promise<SentMessage> {
    if (data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) throw new Error('Media exceeds the 64 MiB transfer limit.');
    return this.sendContent(to, this.mediaContent(Buffer.from(data, 'base64'), mimeType, filename, caption));
  }

  async sendVoiceNote(to: string, audioPath: string): Promise<SentMessage> {
    return this.sendContent(to, { audio: { url: audioPath }, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  }

  private mediaContent(data: Buffer, mimetype: string, fileName?: string, caption?: string): AnyMessageContent {
    if (mimetype.startsWith('image/') && mimetype !== 'image/svg+xml') return { image: data, mimetype, caption };
    if (mimetype.startsWith('video/')) return { video: data, mimetype, caption };
    if (mimetype.startsWith('audio/')) return { audio: data, mimetype, ptt: false };
    return { document: data, mimetype, fileName: fileName ?? 'attachment', caption };
  }

  private extensionMime(filename: string): string {
    return ({ '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf' } as Record<string, string>)[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
  }

  async downloadMedia(id: string): Promise<MediaData | null> {
    await this.ensureReady();
    const raw = this.requireStore().getRawMessage(decodeMessageId(id));
    if (!raw) return null;
    const content = normalizeMessageContent(raw.message);
    const media = content?.imageMessage ?? content?.videoMessage ?? content?.audioMessage ?? content?.documentMessage ?? content?.stickerMessage;
    if (!media) return null;
    if (timestamp(media.fileLength) > MAX_MEDIA_BYTES) throw new Error('Media exceeds the 64 MiB transfer limit.');
    const generation = this.generation;
    const socket = this.socket!;
    const stream = await (this.deps.downloadMedia ?? downloadMediaMessage)(raw, 'stream', {}, {
      logger: log, reuploadRequest: message => {
        if (generation !== this.generation || this.stopped) throw new Error('WhatsApp disconnected during media download.');
        return socket.updateMediaMessage(message);
      },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      if (generation !== this.generation || this.stopped) throw new Error('WhatsApp disconnected during media download.');
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_MEDIA_BYTES) throw new Error('Media exceeds the 64 MiB transfer limit.');
      chunks.push(buffer);
    }
    return { data: Buffer.concat(chunks).toString('base64'), mimetype: media.mimetype ?? 'application/octet-stream',
      filename: content?.documentMessage?.fileName ?? undefined };
  }

  private mapContact(contact: Partial<Contact>): SimpleContact {
    const id = this.normalizeJid(contact.id!);
    const self = this.socket?.user?.id ? this.normalizeJid(this.socket.user.id) : '';
    return {
      id, name: contact.name ?? contact.verifiedName ?? null, pushname: contact.notify ?? '',
      isMe: id === self, isUser: id.endsWith('@s.whatsapp.net') || id.endsWith('@lid'),
      isGroup: id.endsWith('@g.us'), isWAContact: true, isMyContact: !!contact.name,
      number: id.endsWith('@s.whatsapp.net') ? id.split('@')[0]! : '',
    };
  }

  private mapChat(chat: Partial<Chat>, includeLastMessage: boolean): SimpleChat {
    const id = this.normalizeJid(chat.id!);
    const raw = includeLastMessage ? this.requireStore().getMessages(id, 1)[0] : undefined;
    const contact = this.requireStore().getContact(id);
    return {
      id, name: chat.name ?? contact?.name ?? contact?.notify ?? id,
      isGroup: id.endsWith('@g.us'), unreadCount: chat.unreadCount ?? 0,
      timestamp: timestamp(chat.conversationTimestamp),
      ...(raw ? { lastMessage: this.mapMessage(raw) } : {}),
    };
  }

  private mapMessage(raw: WAMessage): SimpleMessage {
    const content = normalizeMessageContent(raw.message);
    const type = content ? getContentType(content) : undefined;
    const chatId = this.normalizeJid(raw.key.remoteJid!);
    const fromMe = !!raw.key.fromMe;
    const self = this.socket?.user?.id ? this.normalizeJid(this.socket.user.id) : '';
    const media = content?.imageMessage ?? content?.videoMessage ?? content?.audioMessage ?? content?.documentMessage ?? content?.stickerMessage;
    const body = content?.conversation ?? content?.extendedTextMessage?.text
      ?? content?.imageMessage?.caption ?? content?.videoMessage?.caption ?? content?.documentMessage?.caption
      ?? content?.contactMessage?.displayName ?? content?.locationMessage?.name ?? '';
    const context = (content as { extendedTextMessage?: { contextInfo?: { mentionedJid?: string[] | null; stanzaId?: string | null } } } | null | undefined)?.extendedTextMessage?.contextInfo
      ?? media?.contextInfo;
    const mentioned = context?.mentionedJid?.map(id => this.normalizeJid(id));
    return {
      id: encodeMessageId(raw.key), chatId, body,
      ...(mentioned?.length ? { mentionedIds: mentioned } : {}),
      ...(context?.stanzaId ? { quotedMessageId: context.stanzaId } : {}),
      // History sync puts a group sender in `participant` beside the key, live messages in the key.
      from: fromMe ? self : this.normalizeJid(raw.key.participant || raw.participant || chatId),
      to: fromMe || chatId.endsWith('@g.us') ? chatId : self,
      timestamp: timestamp(raw.messageTimestamp), fromMe, hasMedia: !!media,
      ...(media?.mediaKey ? { mediaKey: Buffer.from(media.mediaKey).toString('base64') } : {}),
      type: type === 'conversation' || type === 'extendedTextMessage' ? 'chat'
        : type === 'audioMessage' && content?.audioMessage?.ptt ? 'ptt' : type?.replace(/Message$/, '') ?? 'unknown',
    };
  }
}
