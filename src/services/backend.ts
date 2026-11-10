/** Backend-neutral values exposed by the MCP tools. IDs are opaque to callers. */
export interface SimpleContact {
  id: string;
  name: string | null;
  pushname: string;
  isMe: boolean;
  isUser: boolean;
  isGroup: boolean;
  isWAContact: boolean;
  isMyContact: boolean;
  number: string;
}

export interface SimpleChat {
  id: string;
  name: string;
  isGroup: boolean;
  lastMessage?: SimpleMessage;
  unreadCount: number;
  timestamp: number;
}

export interface SimpleMessage {
  id: string;
  chatId?: string;
  body: string;
  from: string;
  to: string;
  timestamp: number;
  fromMe: boolean;
  hasMedia: boolean;
  mediaKey?: string;
  type: string;
  /** Accounts mentioned in this message, when the backend reports them. */
  mentionedIds?: string[];
  /** The message this one replies to, when the backend reports it. */
  quotedMessageId?: string;
  /** Text of a voice note, when transcription is configured and it has been transcribed. */
  transcript?: string;
  /** Why a requested transcription failed. */
  transcriptError?: string;
}

export interface SentMessage {
  id: string;
  timestamp: number;
}

export interface MediaData {
  mimetype: string;
  data: string;
  filename?: string | null;
  filesize?: number | null;
}

export interface BackendStatus {
  backend: 'webjs' | 'baileys';
  authenticated: boolean;
  history: {
    state: 'unavailable' | 'syncing' | 'available';
    messageCount?: number;
    chatCount?: number;
    contactCount?: number;
    lastSyncAt?: number;
    note: string;
  };
}

export interface WhatsAppBackend {
  readonly backend: 'webjs' | 'baileys';
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout(): Promise<void>;
  isAuthenticated(): boolean;
  getLatestQrCode(): string | null;
  getLatestPairingCode(): string | null;
  requestPairingCode(phoneNumber: string): Promise<string>;
  waitForAuthOutcome(timeoutMs?: number): Promise<void>;
  ensureReady(timeoutMs?: number): Promise<void>;
  onSessionInvalidated(listener: () => void): void;
  /** New messages as they arrive; history sync does not trigger this. Baileys only for now. */
  onMessage?(listener: (message: SimpleMessage) => void): void;
  /** This account's identifiers, to recognise mentions of it. */
  getSelfIds?(): string[];
  /** Stored transcript of a voice note, for backends that persist them beside the history. */
  getVoiceTranscript?(messageId: string): string | undefined;
  saveVoiceTranscript?(messageId: string, text: string): void;
  /** React to a message; an empty emoji removes the reaction. */
  sendReaction?(messageId: string, emoji: string): Promise<void>;
  getStatus(): BackendStatus;
  searchContacts(query: string): Promise<SimpleContact[]>;
  getContactById(contactId: string): Promise<SimpleContact | null>;
  listChats(limit?: number, includeLastMessage?: boolean): Promise<SimpleChat[]>;
  getChatById(chatId: string): Promise<SimpleChat | null>;
  getMessages(chatId: string, limit?: number): Promise<SimpleMessage[]>;
  getMessageById(messageId: string): Promise<SimpleMessage | null>;
  sendMessage(to: string, content: string): Promise<SentMessage>;
  sendMedia(to: string, mediaPathOrUrl: string, caption?: string): Promise<SentMessage>;
  sendMediaFromBase64(to: string, data: string, mimeType: string, filename?: string, caption?: string): Promise<SentMessage>;
  sendVoiceNote(to: string, audioPath: string): Promise<SentMessage>;
  downloadMedia(messageId: string): Promise<MediaData | null>;
}
