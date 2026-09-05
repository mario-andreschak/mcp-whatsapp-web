import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  type AnyMessageContent,
  type BaileysEventMap,
  type Chat,
  type Contact,
  type GroupMetadata,
  type UserFacingSocketConfig,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { BaileysStore } from './baileys-store.js';
import type {
  BackendStatus, MediaData, SentMessage, SimpleChat, SimpleContact, SimpleMessage, WhatsAppBackend,
} from './backend.js';
import { log } from '../utils/logger.js';

export type BaileysSocket = Pick<WASocket,
  'ev' | 'end' | 'logout' | 'requestPairingCode' | 'sendMessage' |
  'fetchMessageHistory' | 'updateMediaMessage' | 'groupMetadata' | 'user'>;

/** Socket injection keeps tests offline; no browser or live connection is needed. */
export interface BaileysServiceDeps {
  sessionDir?: string;
  socketFactory?: (config: UserFacingSocketConfig) => BaileysSocket;
  downloadMedia?: typeof downloadMediaMessage;
  reconnectDelayMs?: number;
  historyRequestTimeoutMs?: number;
}

const MAX_RECONNECT_ATTEMPTS = 8;
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
  private readonly sessionDir: string;
  private store?: BaileysStore;
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
  private terminalError?: Error;
  private historySyncing = false;
  private readonly historySyncTypes = new Set<number>();
  private readonly groupCache = new Map<string, { value: GroupMetadata; expiresAt: number }>();
  private readonly listeners = new Set<() => void>();
  private readonly detachListeners: Array<() => void> = [];
  private readonly historyRequests = new Map<string, number>();
  private readonly historyInflight = new Map<string, Promise<void>>();

  constructor(deps: BaileysServiceDeps = {}) {
    this.deps = deps;
    this.sessionDir = path.resolve(deps.sessionDir ?? process.env.BAILEYS_SESSION_DIR ?? path.join(process.cwd(), 'baileys-sessions'));
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
    this.reconnectAttempts = 0;
    const pending = this.enqueue(async () => {
      if (this.intent !== intent || this.stopped) return;
      this.closeSocket();
      try {
        this.store ??= new BaileysStore(this.sessionDir);
        await this.openSocket(intent);
      } catch (error) {
        this.closeSocket();
        this.store?.close();
        this.store = undefined;
        this.stopped = true;
        this.terminalError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    });
    this.initPromise = pending;
    void pending.finally(() => { if (this.initPromise === pending) this.initPromise = undefined; }).catch(() => {});
    return pending;
  }

  private async openSocket(intent: number): Promise<void> {
    const store = this.requireStore();
    const { state, saveCreds } = await store.createAuthState();
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
      logger: log,
      browser: process.platform === 'win32' ? Browsers.windows('Desktop') : Browsers.macOS('Desktop'),
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
        this.reconnectAttempts = 0;
        this.terminalError = undefined;
        this.historySyncing = !store.getMeta<number>('history_synced_at');
      }
      if (update.connection === 'close') {
        this.ready = false;
        this.latestQr = null;
        this.latestPairing = null;
        const error = update.lastDisconnect?.error;
        const code = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession || code === DisconnectReason.forbidden) {
          this.invalidateSession(`WhatsApp session was invalidated (${code}). Pair this backend again.`);
        } else if (code === DisconnectReason.connectionReplaced || code === DisconnectReason.multideviceMismatch) {
          this.stopped = true;
          this.terminalError = new Error(`WhatsApp connection stopped (${code}). Resolve the linked-device conflict, then restart the server.`);
          this.cancelReconnect();
          this.closeSocket();
        } else {
          this.closeSocket();
          this.scheduleReconnect(intent, code === DisconnectReason.restartRequired);
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
    on('messages.upsert', data => store.upsertMessages(data.messages));
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
  }

  private eventFailure(error: unknown, generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    log.error('Baileys event persistence failed; stopping the connection:', error);
    this.terminalError = new Error('Baileys could not persist session or history data. Check the session directory and restart the server.');
    this.stopped = true;
    this.cancelReconnect();
    this.closeSocket();
  }

  private invalidateSession(reason: string): void {
    this.stopped = true;
    this.terminalError = new Error(reason);
    this.cancelReconnect();
    this.closeSocket();
    try { this.store?.clear(); }
    catch (error) {
      log.error('Could not clear invalid Baileys credentials:', error);
      this.terminalError = new Error(`${reason} Local credentials could not be cleared; check the session directory before restarting.`);
    } finally {
      this.historyRequests.clear();
      this.historyInflight.clear();
      this.notifySessionInvalidated();
    }
  }

  private scheduleReconnect(intent: number, restartRequired: boolean): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.stopped = true;
      this.terminalError = new Error('Baileys reconnect attempts exhausted. Check connectivity and restart the server.');
      this.closeSocket();
      return;
    }
    const delay = restartRequired ? 100 : Math.min((this.deps.reconnectDelayMs ?? 1_000) * 2 ** this.reconnectAttempts, 60_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.enqueue(async () => {
        if (this.stopped || this.intent !== intent) return;
        this.closeSocket();
        await this.openSocket(intent);
      }).catch(error => {
        if (this.stopped || this.intent !== intent) return;
        log.warn('Baileys reconnect failed:', error);
        this.scheduleReconnect(intent, false);
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
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
    this.cancelReconnect();
    return this.enqueue(async () => {
      this.closeSocket();
      this.store?.close();
      this.store = undefined;
    });
  }

  logout(): Promise<void> {
    ++this.intent;
    ++this.generation;
    this.stopped = true;
    this.ready = false;
    this.cancelReconnect();
    return this.enqueue(async () => {
      let logoutError: unknown;
      try {
        if (this.socket) await timeout(this.socket.logout(), 5_000, 'WhatsApp logout');
      } catch (error) { logoutError = error; }
      finally {
        this.closeSocket();
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
    const deadline = Date.now() + timeoutMs;
    while (!this.ready && !this.latestQr && !this.latestPairing && !this.stopped && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
  }

  async ensureReady(timeoutMs = Number(process.env.TOOL_READY_TIMEOUT_MS || 45_000)): Promise<void> {
    await this.waitForAuthOutcome(timeoutMs);
    if (this.ready) return;
    if (this.terminalError) throw this.terminalError;
    if (this.latestQr || this.latestPairing) throw new Error('WhatsApp is not authenticated: use get_qr_code or request_pairing_code to link this backend.');
    throw new Error('WhatsApp is not connected. Start the server or wait for reconnection and try again.');
  }

  getStatus(): BackendStatus {
    const lastSyncAt = this.store?.getMeta<number>('history_synced_at');
    const counts = this.store?.getCounts();
    const hasData = !!counts && counts.messageCount + counts.chatCount + counts.contactCount > 0;
    return {
      backend: this.backend,
      authenticated: this.ready,
      history: {
        state: this.historySyncing && this.ready ? 'syncing' : lastSyncAt || hasData ? 'available' : 'unavailable',
        ...counts,
        ...(lastSyncAt ? { lastSyncAt } : {}),
        note: (this.terminalError ? `${this.terminalError.message} ` : '')
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
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_MEDIA_BYTES) throw new Error('Media exceeds the 64 MiB transfer limit.');
        chunks.push(chunk);
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
    return {
      id: encodeMessageId(raw.key), chatId, body,
      from: fromMe ? self : this.normalizeJid(raw.key.participant || chatId),
      to: fromMe || chatId.endsWith('@g.us') ? chatId : self,
      timestamp: timestamp(raw.messageTimestamp), fromMe, hasMedia: !!media,
      ...(media?.mediaKey ? { mediaKey: Buffer.from(media.mediaKey).toString('base64') } : {}),
      type: type === 'conversation' || type === 'extendedTextMessage' ? 'chat'
        : type === 'audioMessage' && content?.audioMessage?.ptt ? 'ptt' : type?.replace(/Message$/, '') ?? 'unknown',
    };
  }
}
