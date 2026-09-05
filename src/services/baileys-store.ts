import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BufferJSON,
  initAuthCreds,
  jidNormalizedUser,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type Chat,
  type Contact,
  type SignalDataTypeMap,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys';

interface JsonRow { data: string }
interface OwnerRow { pid: number; host: string; token: string }
interface MessageRow extends JsonRow {
  chat_id: string;
  message_id: string;
  from_me: number;
  participant: string;
  timestamp: number;
}

export interface StoredAuthState {
  state: AuthenticationState;
  saveCreds(update?: Partial<AuthenticationCreds>): Promise<void>;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize<T>(value: string): T {
  return JSON.parse(value, BufferJSON.reviver) as T;
}

function restoreMessage(data: string): WAMessage {
  const raw = deserialize<WAMessage>(data);
  const restored = proto.WebMessageInfo.fromObject(raw);
  // Baileys extends the protobuf key with LID/PN alternates and addressing metadata.
  return { ...raw, ...restored, key: { ...raw.key, ...restored.key } };
}

function serializeMessage(message: WAMessage): string {
  // Protobuf toJSON() discards Baileys' extensions on the envelope and key.
  return serialize({ ...message, key: { ...message.key } });
}

function timestamp(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') return Number(value) || 0;
  if (value && typeof value === 'object') {
    if ('toNumber' in value && typeof value.toNumber === 'function') return value.toNumber();
    if ('low' in value && 'high' in value) {
      return (Number(value.low) >>> 0) + Number(value.high) * 0x100000000;
    }
  }
  return 0;
}

function boundedLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(10_000, Math.trunc(value))) : 50;
}

function definedFields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** Durable auth and synchronized history. One live process owns a session database. */
export class BaileysStore {
  readonly databasePath: string;
  private readonly db: Database.Database;
  private readonly ownerToken = randomUUID();
  private closed = false;
  private authGeneration = 0;
  private auth?: StoredAuthState;

  constructor(sessionDir: string) {
    const directory = resolve(sessionDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.databasePath = join(directory, 'session.sqlite');
    this.db = new Database(this.databasePath, { timeout: 10_000 });
    try {
      chmodSync(this.databasePath, 0o600);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('secure_delete = ON');
      this.db.exec(`CREATE TABLE IF NOT EXISTS session_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        pid INTEGER NOT NULL, host TEXT NOT NULL, token TEXT NOT NULL
      )`);
      this.claimOwnership();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS credentials (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS signal_keys (category TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (category, id));
        CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          chat_id TEXT NOT NULL, message_id TEXT NOT NULL, from_me INTEGER NOT NULL,
          participant TEXT NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY (chat_id, message_id, from_me, participant)
        );
        CREATE INDEX IF NOT EXISTS messages_by_chat_time ON messages (chat_id, timestamp DESC, message_id DESC);
        CREATE INDEX IF NOT EXISTS messages_by_participant ON messages (participant);
        CREATE TABLE IF NOT EXISTS jid_aliases (alias TEXT PRIMARY KEY, canonical TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      `);
    } catch (error) {
      // A rejected contender must never release the real owner's lease.
      try { this.db.prepare('DELETE FROM session_owner WHERE token = ?').run(this.ownerToken); } catch { /* schema/open failure */ }
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  private claimOwnership(): void {
    this.db.transaction(() => {
      const owner = this.db.prepare('SELECT pid, host, token FROM session_owner WHERE singleton = 1').get() as OwnerRow | undefined;
      if (owner) {
        let definitelyDead = false;
        if (owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (error) {
            definitelyDead = (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }
        if (!definitelyDead) {
          throw new Error(`Baileys session is already in use by process ${owner.pid} on ${owner.host}. Stop that server or select another BAILEYS_SESSION_DIR.`);
        }
      }
      this.db.prepare('INSERT OR REPLACE INTO session_owner (singleton, pid, host, token) VALUES (1, ?, ?, ?)')
        .run(process.pid, hostname(), this.ownerToken);
    }).immediate();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Baileys session store is closed.');
  }

  /** Nested calls use SQLite savepoints. The callback must be synchronous. */
  transaction<T>(operation: () => T): T {
    this.assertOpen();
    return this.db.transaction(() => {
      const result = operation();
      if (result && typeof result === 'object' && 'then' in result) {
        throw new Error('Baileys store transactions require a synchronous callback.');
      }
      return result;
    }).immediate();
  }

  async createAuthState(): Promise<StoredAuthState> {
    this.assertOpen();
    if (this.auth) return this.auth;
    const row = this.db.prepare('SELECT data FROM credentials WHERE singleton = 1').get() as JsonRow | undefined;
    const creds = row ? deserialize<AuthenticationCreds>(row.data) : initAuthCreds();
    if (creds.account) creds.account = proto.ADVSignedDeviceIdentity.fromObject(creds.account);
    const generation = this.authGeneration;
    const assertCurrent = () => {
      this.assertOpen();
      if (generation !== this.authGeneration) throw new Error('This Baileys authentication state has been invalidated.');
    };
    const writeCreds = () => {
      this.db.prepare('INSERT OR REPLACE INTO credentials (singleton, data) VALUES (1, ?)').run(serialize(creds));
    };
    const state: AuthenticationState = {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(category: T, ids: string[]) => {
          assertCurrent();
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          const select = this.db.prepare('SELECT data FROM signal_keys WHERE category = ? AND id = ?');
          for (const id of ids) {
            const keyRow = select.get(category, id) as JsonRow | undefined;
            if (!keyRow) continue;
            let value = deserialize<SignalDataTypeMap[T]>(keyRow.data);
            if (category === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T];
            }
            result[id] = value;
          }
          return result;
        },
        set: async (data) => {
          assertCurrent();
          this.transaction(() => {
            const insert = this.db.prepare('INSERT OR REPLACE INTO signal_keys (category, id, data) VALUES (?, ?, ?)');
            const remove = this.db.prepare('DELETE FROM signal_keys WHERE category = ? AND id = ?');
            for (const [category, values] of Object.entries(data)) {
              for (const [id, value] of Object.entries(values ?? {})) {
                if (value == null) remove.run(category, id);
                else insert.run(category, id, serialize(value));
                if (category === 'lid-mapping' && /^\d+$/.test(id) && typeof value === 'string' && /^\d+$/.test(value)) {
                  this.setLidMapping(`${value}@lid`, `${id}@s.whatsapp.net`);
                }
              }
            }
            // Credential counters and their corresponding Signal keys share one commit.
            writeCreds();
          });
        },
      },
    };
    this.auth = {
      state,
      saveCreds: async (update) => {
        assertCurrent();
        if (update) Object.assign(creds, update);
        this.transaction(writeCreds);
      },
    };
    if (!row) this.transaction(writeCreds);
    return this.auth;
  }

  resolveJid(jid: string): string {
    this.assertOpen();
    const normalized = jidNormalizedUser(jid);
    const row = this.db.prepare('SELECT canonical FROM jid_aliases WHERE alias = ?').get(normalized) as { canonical: string } | undefined;
    return row?.canonical ?? normalized;
  }

  /** Merge existing LID history into its phone-number identity atomically. */
  setLidMapping(lid: string, pn: string): void {
    this.assertOpen();
    const alias = jidNormalizedUser(lid);
    const canonical = jidNormalizedUser(pn);
    if (!alias.endsWith('@lid') || !canonical.endsWith('@s.whatsapp.net')) return;
    this.transaction(() => {
      const existing = this.db.prepare('SELECT canonical FROM jid_aliases WHERE alias = ?').get(alias) as { canonical: string } | undefined;
      if (existing?.canonical === canonical) return;
      if (existing) {
        throw new Error(`Conflicting Baileys identity mapping for ${alias}: already mapped to ${existing.canonical}, cannot remap to ${canonical}.`);
      }
      // Established mappings remain stable for the lifetime of this account's history.
      this.db.prepare('INSERT OR REPLACE INTO jid_aliases (alias, canonical) VALUES (?, ?)').run(alias, canonical);
      for (const table of ['contacts', 'chats'] as const) {
        const oldRow = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(alias) as JsonRow | undefined;
        const newRow = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(canonical) as JsonRow | undefined;
        if (oldRow) {
          const oldData = deserialize<Record<string, unknown>>(oldRow.data);
          const newData = newRow ? deserialize<Record<string, unknown>>(newRow.data) : {};
          const combined = { ...oldData, ...newData, id: canonical };
          if (table === 'contacts') this.upsertContacts([combined as Partial<Contact>]);
          else this.upsertChats([{
            ...combined,
            conversationTimestamp: Math.max(timestamp(oldData.conversationTimestamp), timestamp(newData.conversationTimestamp)),
            lastMessageRecvTimestamp: Math.max(timestamp(oldData.lastMessageRecvTimestamp), timestamp(newData.lastMessageRecvTimestamp)),
          } as Partial<Chat>]);
          this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(alias);
        }
      }
      const rows = this.db.prepare('SELECT * FROM messages WHERE chat_id = ? OR participant = ?').all(alias, alias) as MessageRow[];
      for (const row of rows) {
        const chatId = row.chat_id === alias ? canonical : row.chat_id;
        const participant = row.participant === alias ? canonical : row.participant;
        const duplicate = this.db.prepare('SELECT data FROM messages WHERE chat_id = ? AND message_id = ? AND from_me = ? AND participant = ?')
          .get(chatId, row.message_id, row.from_me, participant) as JsonRow | undefined;
        const oldMessage = deserialize<WAMessage>(row.data);
        const duplicateMessage = duplicate ? deserialize<WAMessage>(duplicate.data) : undefined;
        const message = { ...oldMessage, ...duplicateMessage };
        if (oldMessage.messageStubType === proto.WebMessageInfo.StubType.REVOKE || duplicateMessage?.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
          message.message = null;
          message.messageStubType = proto.WebMessageInfo.StubType.REVOKE;
        }
        this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND message_id = ? AND from_me = ? AND participant = ?')
          .run(row.chat_id, row.message_id, row.from_me, row.participant);
        this.db.prepare('INSERT OR REPLACE INTO messages (chat_id, message_id, from_me, participant, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)')
          .run(chatId, row.message_id, row.from_me, participant, timestamp(message.messageTimestamp), serializeMessage(message));
      }
      this.refreshChatTimestamp(canonical);
    });
  }

  upsertContacts(contacts: Partial<Contact>[]): void {
    this.transaction(() => {
      for (const input of contacts) {
        const contact = definedFields(input);
        if (!contact.id) continue;
        const hints = contact as Partial<Contact> & { lid?: string; phoneNumber?: string };
        if (hints.lid && hints.phoneNumber) this.setLidMapping(hints.lid, hints.phoneNumber);
        else if (contact.id.endsWith('@lid') && hints.phoneNumber) this.setLidMapping(contact.id, hints.phoneNumber);
        else if (contact.id.endsWith('@s.whatsapp.net') && hints.lid) this.setLidMapping(hints.lid, contact.id);
        const id = this.resolveJid(contact.id);
        const previous = this.getContact(id);
        this.db.prepare('INSERT OR REPLACE INTO contacts (id, data) VALUES (?, ?)')
          .run(id, serialize({ ...previous, ...contact, id }));
      }
    });
  }

  upsertChats(chats: Partial<Chat>[]): void {
    this.transaction(() => {
      for (const input of chats) {
        const chat = definedFields(input);
        if (!chat.id) continue;
        const id = this.resolveJid(chat.id);
        const previous = this.getChat(id);
        const merged = { ...previous, ...chat, id };
        if (previous?.conversationTimestamp != null || chat.conversationTimestamp != null) {
          merged.conversationTimestamp = Math.max(timestamp(previous?.conversationTimestamp), timestamp(chat.conversationTimestamp));
        }
        // History messages are stored once in the indexed messages table.
        delete merged.messages;
        const sortTime = Math.max(timestamp(merged.conversationTimestamp), timestamp(merged.lastMessageRecvTimestamp));
        this.db.prepare(`INSERT INTO chats (id, timestamp, data) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET timestamp = MAX(chats.timestamp, excluded.timestamp), data = excluded.data`)
          .run(id, sortTime, serialize(merged));
      }
    });
  }

  upsertMessages(messages: WAMessage[]): void {
    this.transaction(() => {
      for (const message of messages) {
        if (!message.key.remoteJid || !message.key.id) continue;
        const key = message.key as WAMessageKey & { remoteJidAlt?: string; participantAlt?: string };
        for (const [first, second] of [[key.remoteJid, key.remoteJidAlt], [key.participant, key.participantAlt]]) {
          if (!first || !second) continue;
          if (first.endsWith('@lid')) this.setLidMapping(first, second);
          else if (second.endsWith('@lid')) this.setLidMapping(second, first);
        }
        const chatId = this.resolveJid(message.key.remoteJid);
        const participant = message.key.participant ? this.resolveJid(message.key.participant) : '';
        const previous = this.db.prepare('SELECT data FROM messages WHERE chat_id = ? AND message_id = ? AND from_me = ? AND participant = ?')
          .get(chatId, message.key.id, message.key.fromMe ? 1 : 0, participant) as JsonRow | undefined;
        const priorMessage = previous ? deserialize<WAMessage>(previous.data) : undefined;
        const merged = { ...priorMessage, ...definedFields(message) };
        if (priorMessage?.messageStubType === proto.WebMessageInfo.StubType.REVOKE || message.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
          // Delayed history and retries must never restore a revoked body/media.
          merged.message = null;
          merged.messageStubType = proto.WebMessageInfo.StubType.REVOKE;
        }
        const time = timestamp(merged.messageTimestamp);
        this.db.prepare('INSERT OR REPLACE INTO messages (chat_id, message_id, from_me, participant, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)')
          .run(chatId, message.key.id, message.key.fromMe ? 1 : 0, participant, time, serializeMessage(merged));
        this.upsertChats([{ id: chatId, conversationTimestamp: time }]);
      }
    });
  }

  private findMessageRows(key: WAMessageKey): MessageRow[] {
    this.assertOpen();
    if (!key.remoteJid || !key.id) return [];
    let query = 'SELECT * FROM messages WHERE chat_id = ? AND message_id = ?';
    const params: (string | number)[] = [this.resolveJid(key.remoteJid), key.id];
    if (key.fromMe != null) { query += ' AND from_me = ?'; params.push(key.fromMe ? 1 : 0); }
    if (key.participant) { query += ' AND participant = ?'; params.push(this.resolveJid(key.participant)); }
    return this.db.prepare(query).all(...params) as MessageRow[];
  }

  getRawMessage(key: WAMessageKey): WAMessage | undefined {
    const rows = this.findMessageRows(key);
    return rows.length === 1 ? restoreMessage(rows[0].data) : undefined;
  }

  updateMessages(updates: { key: WAMessageKey; update: Partial<WAMessage> }[]): void {
    this.transaction(() => {
      for (const { key, update } of updates) {
        const matches = this.findMessageRows(key);
        const existing = matches.length === 1 ? restoreMessage(matches[0].data) : undefined;
        // A revoke update's embedded key identifies its notification, while the
        // event key identifies the message being revoked. Never change identity.
        if (existing) this.upsertMessages([{ ...existing, ...definedFields(update), key: existing.key }]);
        else if (matches.length === 0 && update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
          this.upsertMessages([{
            ...definedFields(update), key: { ...key }, message: null,
            messageStubType: proto.WebMessageInfo.StubType.REVOKE,
          }]);
        }
      }
    });
  }

  deleteMessages(deletion: { keys?: WAMessageKey[]; jid?: string; all?: boolean }): void {
    this.transaction(() => {
      if (deletion.all) {
        if (!deletion.jid) throw new Error('Deleting all messages requires a chat JID.');
        const id = this.resolveJid(deletion.jid);
        this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id);
        this.refreshChatTimestamp(id);
      } else {
        const changed = new Set<string>();
        for (const key of deletion.keys ?? []) {
          const rows = this.findMessageRows(key);
          if (rows.length !== 1) continue;
          const row = rows[0];
          this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND message_id = ? AND from_me = ? AND participant = ?')
            .run(row.chat_id, row.message_id, row.from_me, row.participant);
          changed.add(row.chat_id);
        }
        for (const id of changed) this.refreshChatTimestamp(id);
      }
    });
  }

  deleteChats(ids: string[]): void {
    this.transaction(() => {
      for (const rawId of ids) {
        const id = this.resolveJid(rawId);
        this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id);
        this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
      }
    });
  }

  private refreshChatTimestamp(id: string): void {
    const row = this.db.prepare('SELECT MAX(timestamp) AS timestamp FROM messages WHERE chat_id = ?').get(id) as { timestamp: number | null };
    if (row.timestamp != null) this.upsertChats([{ id, conversationTimestamp: row.timestamp }]);
  }

  getMessages(chatId: string, limit = 50): WAMessage[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT data FROM (
      SELECT data, timestamp, message_id, from_me, participant FROM messages WHERE chat_id = ?
      ORDER BY timestamp DESC, message_id DESC, from_me DESC, participant DESC LIMIT ?
    ) ORDER BY timestamp ASC, message_id ASC, from_me ASC, participant ASC`).all(this.resolveJid(chatId), boundedLimit(limit)) as JsonRow[];
    return rows.map(row => restoreMessage(row.data));
  }

  getChats(limit = 100): Partial<Chat>[] {
    this.assertOpen();
    return (this.db.prepare('SELECT data FROM chats ORDER BY timestamp DESC, id ASC LIMIT ?').all(boundedLimit(limit)) as JsonRow[])
      .map(row => deserialize<Partial<Chat>>(row.data));
  }

  getChat(id: string): Partial<Chat> | undefined {
    const row = this.db.prepare('SELECT data FROM chats WHERE id = ?').get(this.resolveJid(id)) as JsonRow | undefined;
    return row ? deserialize<Partial<Chat>>(row.data) : undefined;
  }

  getContacts(): Partial<Contact>[] {
    this.assertOpen();
    return (this.db.prepare('SELECT data FROM contacts ORDER BY id').all() as JsonRow[]).map(row => deserialize<Partial<Contact>>(row.data));
  }

  getContact(id: string): Partial<Contact> | undefined {
    const row = this.db.prepare('SELECT data FROM contacts WHERE id = ?').get(this.resolveJid(id)) as JsonRow | undefined;
    return row ? deserialize<Partial<Contact>>(row.data) : undefined;
  }

  getCounts(): { messageCount: number; chatCount: number; contactCount: number } {
    this.assertOpen();
    return this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM messages) AS messageCount,
      (SELECT COUNT(*) FROM chats) AS chatCount,
      (SELECT COUNT(*) FROM contacts) AS contactCount`).get() as { messageCount: number; chatCount: number; contactCount: number };
  }

  getMeta<T = unknown>(key: string): T | undefined {
    this.assertOpen();
    const row = this.db.prepare('SELECT data FROM metadata WHERE key = ?').get(key) as JsonRow | undefined;
    return row ? deserialize<T>(row.data) : undefined;
  }

  setMeta(key: string, value: unknown): void {
    this.assertOpen();
    if (value === undefined) this.db.prepare('DELETE FROM metadata WHERE key = ?').run(key);
    else this.db.prepare('INSERT OR REPLACE INTO metadata (key, data) VALUES (?, ?)').run(key, serialize(value));
  }

  /** A replacement socket must not share mutable credentials with its predecessor. */
  invalidateAuthState(): void {
    this.assertOpen();
    this.authGeneration++;
    this.auth = undefined;
  }

  /** Explicit logout erases credentials and all account history; reconnects must use close(). */
  clear(): void {
    this.transaction(() => {
      for (const table of ['credentials', 'signal_keys', 'messages', 'chats', 'contacts', 'jid_aliases', 'metadata']) {
        this.db.exec(`DELETE FROM ${table}`);
      }
    });
    this.invalidateAuthState();
    // Truncate the old WAL so cleared credentials/history are not retained there.
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    if (this.closed) return;
    try {
      this.db.prepare('DELETE FROM session_owner WHERE token = ?').run(this.ownerToken);
    } finally {
      this.closed = true;
      this.authGeneration++;
      this.db.close();
    }
  }
}
