// Import the CommonJS module
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { 
  Client,
  LocalAuth,
  MessageMedia,
  // Message, Contact, Chat, ClientOptions - Not directly used, accessed via WAWebJS namespace
  // GroupChat // Import if needed later
} = require('whatsapp-web.js');

// Import types from the module
import type WAWebJS from 'whatsapp-web.js';

import { log } from '../utils/logger.js';
import path from 'path';
import { BrowserProcessManager } from '../utils/browser-process-manager.js';

// Define custom types or interfaces if needed, mapping from whatsapp-web.js types
// For now, we'll use whatsapp-web.js types directly where possible,
// but map them to simpler structures for MCP tools if necessary.

export interface SimpleContact {
  id: string; // JID
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
  id: string; // JID
  name: string;
  isGroup: boolean;
  lastMessage?: SimpleMessage; // Optional: Include last message details
  unreadCount: number;
  timestamp: number;
}

export interface SimpleMessage {
  id: string;
  body: string;
  from: string; // Sender JID
  to: string; // Receiver JID (chat JID)
  timestamp: number;
  fromMe: boolean;
  hasMedia: boolean;
  mediaKey?: string;
  type: string; // e.g., 'chat', 'image', 'video', 'ptt'
  // Add more fields as needed
}

export class WhatsAppService {
  private client: WAWebJS.Client;
  private isInitialized = false;
  private latestQrCode: string | null = null; // Added to store QR code
  private browserProcessManager: BrowserProcessManager;
  // private dbService?: any; // Placeholder for optional DB service - Commented out

  constructor(/* dbService?: any */ /* Replace 'any' with actual DB service type */) {
    // this.dbService = dbService; // Commented out
    this.browserProcessManager = new BrowserProcessManager();

    const clientOptions: WAWebJS.ClientOptions = {
      authStrategy: new LocalAuth({
        dataPath: path.join(process.cwd(), 'whatsapp-sessions'), // Store sessions in project root
      }),
      puppeteer: {
        headless: true, // Run headless
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          // '--single-process', // Might be needed on some systems
          '--disable-gpu',
        ],
        // Use Chrome executable path from environment variable if available
        // This is needed for video/gif sending as Chromium (default) doesn't support H.264/AAC codecs
        ...(process.env.CHROME_EXECUTABLE_PATH && {
          executablePath: process.env.CHROME_EXECUTABLE_PATH
        })
       },
       // qrTimeout option removed as it's not valid in whatsapp-web.js v1.23+
     };

     this.client = new Client(clientOptions);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('qr', (qr: string) => {
      log.info('QR code received.');
      this.latestQrCode = qr; // Store the QR code
      // qrcodeTerminal.generate(qr, { small: true }); // Removed console logging
    });

    this.client.on('authenticated', () => { // No type needed for msg here
      log.info('WhatsApp client authenticated.');
      this.latestQrCode = null; // Clear QR code once authenticated
    });

    this.client.on('auth_failure', (msg: string) => { // Add type string
      log.error('WhatsApp authentication failure:', msg);
      // Potentially exit or attempt re-authentication
    });

    this.client.on('ready', () => {
      log.info('WhatsApp client is ready.');
      this.isInitialized = true;
      // Perform actions after client is ready, e.g., fetch initial chats/contacts
    });

    this.client.on('message', async (message: WAWebJS.Message) => {
      log.debug('Received message:', JSON.stringify(message));
      // Handle incoming messages - potentially store in DB if dbService is configured
      // if (this.dbService) {
      //   await this.dbService.storeMessage(this.mapMessageToSimpleMessage(message));
      // }
    });

    this.client.on('message_create', async (message: WAWebJS.Message) => {
      // Fired on all message creations, including your own
      if (message.fromMe) {
        log.debug('Sent message:', JSON.stringify(message));
        // Handle outgoing messages - potentially store in DB
        // if (this.dbService) {
        //   await this.dbService.storeMessage(this.mapMessageToSimpleMessage(message));
        // }
      }
    });

    this.client.on('disconnected', (reason: any) => { // Use any for reason for now
      log.warn('WhatsApp client disconnected:', reason);
      this.isInitialized = false;
      // Handle disconnection, maybe attempt to reconnect
      // this.initialize().catch(err => log.error('Reconnection failed:', err));
      this.latestQrCode = null; // Clear QR on disconnect
    });

    this.client.on('loading_screen', (percent: number, message: string) => { // Add types
        log.info(`WhatsApp loading: ${percent}% - ${message}`);
    });
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      log.warn('WhatsApp client already initialized.');
      return;
    }
    
    // Clean up any orphaned browser processes before starting
    await this.browserProcessManager.cleanupOrphanedProcesses();
    
    log.info('Initializing WhatsApp client...');
    try {
      await this.client.initialize();
      
      // Register the browser process
      const pid = await this.getBrowserPid();
      if (pid) {
        this.browserProcessManager.registerProcess(pid);
        log.info(`Registered browser process with PID: ${pid}`);
      } else {
        log.warn('Could not determine browser PID after initialization');
      }
    } catch (error) {
      log.error('Error initializing WhatsApp client:', error);
      throw error;
    }
  }

  async destroy(): Promise<void> {
    log.info('Destroying WhatsApp client...');
    try {
      // Get the PID before destroying the client
      const pid = await this.getBrowserPid();
      
      // Ensure the client is properly destroyed to clean up the Puppeteer browser
      await this.client.destroy();
      this.isInitialized = false;
      this.latestQrCode = null;
      log.info('WhatsApp client destroyed successfully');
      
      // Unregister the browser process
      if (pid) {
        this.browserProcessManager.unregisterProcess(pid);
        log.info(`Unregistered browser process with PID: ${pid}`);
      }
      
      // Force garbage collection if possible to ensure browser process is released
      if (global.gc) {
        log.debug('Forcing garbage collection...');
        global.gc();
      }
    } catch (error) {
      log.error('Error destroying WhatsApp client:', error);
      throw error;
    }
  }

  async logout(): Promise<void> {
    log.info('Logging out of WhatsApp...');
    try {
      // Get the PID before logging out
      const pid = await this.getBrowserPid();
      
      // Logout from WhatsApp
      await this.client.logout();
      this.isInitialized = false;
      this.latestQrCode = null;
      log.info('Successfully logged out of WhatsApp');
      
      // Unregister the browser process
      if (pid) {
        this.browserProcessManager.unregisterProcess(pid);
        log.info(`Unregistered browser process with PID: ${pid}`);
      }
    } catch (error) {
      log.error('Error logging out of WhatsApp:', error);
      throw error;
    }
  }

  getClient(): WAWebJS.Client {
    if (!this.isInitialized) {
      // It might be better to wait for initialization or throw a more specific error
      log.warn('Accessing WhatsApp client before it is fully initialized.');
    }
    return this.client;
  }

  getLatestQrCode(): string | null {
    return this.latestQrCode;
  }

  isAuthenticated(): boolean {
    // Check if the client is authenticated and connected
    // isInitialized means the client is ready and authenticated
    return this.isInitialized;
  }

  // --- Wrapper Methods for WhatsApp Functionality ---

  // Note: WWebContact and WWebChat aliases are removed from imports, use Contact and Chat directly

  async searchContacts(query: string): Promise<SimpleContact[]> {
    if (!this.isInitialized) throw new Error('WhatsApp client not ready');
    const contacts = await this.client.getContacts();
    const lowerQuery = query.toLowerCase();

    return contacts
      .filter(
        (contact) =>
          (contact.name?.toLowerCase().includes(lowerQuery) ||
           contact.number.includes(query) || // Phone numbers usually don't need lowercasing
           contact.pushname?.toLowerCase().includes(lowerQuery)) &&
          contact.isUser // Filter out groups/broadcasts if needed
      )
      .map(this.mapContactToSimpleContact);
  }

  async listChats(limit = 20, includeLastMessage = true): Promise<SimpleChat[]> {
     if (!this.isInitialized) throw new Error('WhatsApp client not ready');
     const chats = await this.client.getChats();
     // Sort by timestamp descending (most recent first)
     chats.sort((a, b) => b.timestamp - a.timestamp);

     const limitedChats = chats.slice(0, limit);

     const simpleChats: SimpleChat[] = [];
     for (const chat of limitedChats) {
         let lastMsg: SimpleMessage | undefined = undefined;
         if (includeLastMessage && chat.lastMessage) {
             // Fetch the full last message object if needed, or use the partial info
             // For simplicity, we might just use the available info or fetch it
             // const fullLastMessage = await this.client.getMessageById(chat.lastMessage.id._serialized);
             // if (fullLastMessage) {
             //     lastMsg = this.mapMessageToSimpleMessage(fullLastMessage);
             // }
             // Or map the partial info directly if sufficient
             lastMsg = {
                 id: chat.lastMessage.id._serialized,
                 body: chat.lastMessage.body,
                 from: chat.lastMessage.from,
                 to: chat.lastMessage.to,
                 timestamp: chat.lastMessage.timestamp,
                 fromMe: chat.lastMessage.fromMe,
                 hasMedia: chat.lastMessage.hasMedia,
                 type: chat.lastMessage.type,
             };
         }
         simpleChats.push(this.mapChatToSimpleChat(chat, lastMsg));
     }
     return simpleChats;
  }

  async getChatById(chatId: string): Promise<SimpleChat | null> {
    if (!this.isInitialized) throw new Error('WhatsApp client not ready');
    try {
      const chat = await this.client.getChatById(chatId);
      return this.mapChatToSimpleChat(chat);
    } catch (error: any) { // Add type any
      log.warn(`Chat not found: ${chatId}`, error);
      return null;
    }
  }

   async getContactById(contactId: string): Promise<SimpleContact | null> {
    if (!this.isInitialized) throw new Error('WhatsApp client not ready');
    try {
      const contact = await this.client.getContactById(contactId);
      return this.mapContactToSimpleContact(contact);
    } catch (error: any) { // Add type any
      log.warn(`Contact not found: ${contactId}`, error);
      return null;
    }
  }

  async getMessages(chatId: string, limit = 50): Promise<SimpleMessage[]> {
    if (!this.isInitialized) throw new Error('WhatsApp client not ready');
    try {
      const chat = await this.client.getChatById(chatId);
      if (!chat) throw new Error(`Chat not found: ${chatId}`);
      const messages = await chat.fetchMessages({ limit });
      return messages.map(this.mapMessageToSimpleMessage.bind(this));
    } catch (error: any) {
      log.error(`Failed to get messages for chat ${chatId}:`, error);
      throw error;
    }
  }

  async getMessageById(messageId: string): Promise<SimpleMessage | null> {
     if (!this.isInitialized) throw new Error('WhatsApp client not ready');
     try {
         const message = await this.client.getMessageById(messageId);
      return message ? this.mapMessageToSimpleMessage(message) : null;
     } catch (error: any) { // Add type any
         log.warn(`Failed to get message by ID ${messageId}:`, error);
         return null;
     }
  }

  async sendMessage(to: string, content: string): Promise<WAWebJS.Message> {
    if (!this.isInitialized) throw new Error('WhatsApp client not ready');
    log.info(`Sending message to ${to}`);
    return this.client.sendMessage(to, content);
  }

  async sendMedia(to: string, mediaPathOrUrl: string, caption?: string): Promise<WAWebJS.Message> {
    if (!this.isInitialized) throw new Error('WhatsApp client not ready');
    log.info(`Sending media from ${mediaPathOrUrl} to ${to}`);
    let media: WAWebJS.MessageMedia;
    if (mediaPathOrUrl.startsWith('http://') || mediaPathOrUrl.startsWith('https://')) {
      media = await MessageMedia.fromUrl(mediaPathOrUrl, { unsafeMime: true }); // unsafeMime might be needed for some URLs
    } else {
      media = MessageMedia.fromFilePath(mediaPathOrUrl);
    }
    return this.client.sendMessage(to, media, { caption });
  }

   async sendMediaFromBase64(to: string, base64Data: string, mimeType: string, filename?: string, caption?: string): Promise<WAWebJS.Message> {
    if (!this.isInitialized) throw new Error('WhatsApp client not ready');
    log.info(`Sending media from base64 to ${to}`);
    const media = new MessageMedia(mimeType, base64Data, filename);
    return this.client.sendMessage(to, media, { caption });
  }

  async downloadMedia(messageId: string): Promise<WAWebJS.MessageMedia | null> {
    if (!this.isInitialized) throw new Error('WhatsApp client not ready');
    try {
      const message = await this.client.getMessageById(messageId);
      if (message && message.hasMedia) {
        log.info(`Downloading media for message ${messageId}`);
        const media = await message.downloadMedia();
        return media;
      }
      log.warn(`Message ${messageId} not found or has no media.`);
      return null;
    } catch (error: any) { // Add type any
      log.error(`Failed to download media for message ${messageId}:`, error);
      return null;
    }
  }

  // --- Helper Mappers ---

  private mapContactToSimpleContact(contact: WAWebJS.Contact): SimpleContact {
    return {
      id: contact.id._serialized,
      name: contact.name || null,
      pushname: contact.pushname,
      isMe: contact.isMe,
      isUser: contact.isUser,
      isGroup: contact.isGroup,
      isWAContact: contact.isWAContact,
      isMyContact: contact.isMyContact,
      number: contact.number,
    };
  }

  private mapChatToSimpleChat(chat: WAWebJS.Chat, lastMessage?: SimpleMessage): SimpleChat {
    return {
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup,
      lastMessage: lastMessage,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
    };
  }

  private mapMessageToSimpleMessage(message: WAWebJS.Message): SimpleMessage {
    return {
      id: message.id._serialized,
      body: message.body,
      from: message.from,
      to: message.to,
      timestamp: message.timestamp,
      fromMe: message.fromMe,
      hasMedia: message.hasMedia,
      mediaKey: message.mediaKey,
      type: message.type,
      // Add more fields as needed, e.g., ack status, quoted message info
    };
  }
  
  /**
   * Get the process ID of the Chrome browser used by this WhatsApp client
   * @returns The browser PID or null if not available
   */
  async getBrowserPid(): Promise<number | null> {
    try {
      if (!this.client) {
        return null;
      }
      
      // Access the internal puppeteer browser
      // This is a bit hacky but necessary to get the browser PID
      const client = this.client as any;
      
      // Try different ways to access the browser
      let browser = null;
      
      // Method 1: Try to access through pupBrowser property (if available)
      if (client.pupBrowser) {
        browser = client.pupBrowser;
      } 
      // Method 2: Try to access through _page property
      else if (client._page && client._page.browser) {
        browser = client._page.browser();
      }
      // Method 3: Try to access through puppeteer property
      else if (client.puppeteer && client.puppeteer.browser) {
        browser = client.puppeteer.browser;
      }
      
      if (browser) {
        const process = browser.process();
        if (process) {
          return process.pid;
        }
      }
      
      log.warn('Could not access browser PID through any known method');
      return null;
    } catch (error) {
      log.error('Error getting browser PID:', error);
      return null;
    }
  }
}
