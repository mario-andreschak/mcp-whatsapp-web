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
import { findBrowserExecutable } from '../utils/browser-finder.js';

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

/** Injectable dependencies, used by tests to substitute fakes. */
export interface WhatsAppServiceDeps {
  /** Factory producing a (fake) whatsapp-web.js Client. Defaults to `new Client(options)`. */
  clientFactory?: (options: WAWebJS.ClientOptions) => WAWebJS.Client;
  browserProcessManager?: BrowserProcessManager;
}

export class WhatsAppService {
  private client: WAWebJS.Client;
  private readonly clientFactory?: (options: WAWebJS.ClientOptions) => WAWebJS.Client;
  private isInitialized = false;
  private latestQrCode: string | null = null; // Added to store QR code
  private latestPairingCode: string | null = null; // Set when phone number pairing is active
  // True during the window between a QR scan / pairing approval and 'ready'
  // (session validation + chat loading, typically 5-15s). Status checks and
  // tool calls in this window should WAIT, not report "not authenticated".
  private isAuthenticating = false;
  private browserProcessManager: BrowserProcessManager;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private suppressReconnect = false; // Set during intentional shutdown/logout
  // In-flight initialize()/destroy(), so concurrent callers share one attempt
  // instead of racing puppeteer (destroy-during-init is what produced the
  // "Protocol error ... Target closed" storms under FLUJO's restart loop).
  private initPromise: Promise<void> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private registeredBrowserPid: number | null = null;
  // LocalAuth profile location. Overridable so multiple instances (or e2e
  // tests) can run against isolated session directories.
  private readonly sessionDataPath = process.env.WHATSAPP_SESSION_DIR
    ? path.resolve(process.env.WHATSAPP_SESSION_DIR)
    : path.join(process.cwd(), 'whatsapp-sessions');
  // Notified when the WhatsApp session itself becomes invalid (logout or
  // authentication failure) - used e.g. to revoke OAuth tokens.
  private sessionInvalidatedListeners: Array<() => void> = [];

  constructor(deps?: WhatsAppServiceDeps) {
    this.clientFactory = deps?.clientFactory;
    this.browserProcessManager = deps?.browserProcessManager ?? new BrowserProcessManager();
    this.client = this.createClient();
  }

  private buildClientOptions(): WAWebJS.ClientOptions {
    return {
      authStrategy: new LocalAuth({
        dataPath: this.sessionDataPath, // Project root by default; WHATSAPP_SESSION_DIR overrides
      }),
      puppeteer: {
        // WHATSAPP_HEADLESS=false shows the browser window (debugging aid)
        headless: process.env.WHATSAPP_HEADLESS !== 'false',
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
        // Chrome/Edge is needed for video/gif sending, as the Chromium bundled
        // with puppeteer doesn't support H.264/AAC codecs.
        ...(() => {
          const executablePath = findBrowserExecutable();
          return executablePath ? { executablePath } : {};
        })(),
      },
      // Opt-in phone number pairing: when set, the client requests a pairing
      // code instead of relying on the QR code. The code is surfaced via the
      // 'code' event (logged to stderr) and regenerated automatically every
      // ~3 minutes until pairing succeeds.
      ...(process.env.WHATSAPP_PAIRING_PHONE_NUMBER && {
        pairWithPhoneNumber: {
          phoneNumber: process.env.WHATSAPP_PAIRING_PHONE_NUMBER.replace(/\D/g, ''),
          showNotification: true,
        },
      }),
      // Optionally pin the WhatsApp Web version to protect against
      // breaking changes rolled out by WhatsApp (e.g. WA_WEB_VERSION=2.3000.1015010992)
      ...(process.env.WA_WEB_VERSION && {
        webVersionCache: {
          type: 'remote' as const,
          remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${process.env.WA_WEB_VERSION}.html`,
        },
      }),
    };
  }

  private createClient(): WAWebJS.Client {
    const options = this.buildClientOptions();
    const client = this.clientFactory ? this.clientFactory(options) : new Client(options);
    this.setupEventHandlers(client);
    this.registeredBrowserPid = null; // A new client means a new browser
    return client;
  }

  private setupEventHandlers(client: WAWebJS.Client): void {
    client.on('qr', (qr: string) => {
      log.info('QR code received.');
      this.latestQrCode = qr; // Store the QR code
      this.isAuthenticating = false; // A (new) QR means we are waiting for the user
    });

    // Fired when WHATSAPP_PAIRING_PHONE_NUMBER is configured. Written directly
    // to stderr, bypassing the logger and its level configuration: the pairing
    // code must always surface in the MCP client's server logs (FLUJO, Claude,
    // Cline, ...) so the user can complete authentication. stderr never
    // interferes with the MCP protocol, which uses stdout only.
    client.on('code', (code: string) => {
      this.latestPairingCode = code;
      process.stderr.write(
        '\n' +
          '========================================================\n' +
          `  WhatsApp pairing code: ${code}\n` +
          `  On the phone with number ${process.env.WHATSAPP_PAIRING_PHONE_NUMBER}:\n` +
          '  Settings > Linked Devices > Link a device\n' +
          '  > "Link with phone number instead" - enter the code.\n' +
          '  A fresh code is generated every ~3 minutes.\n' +
          '========================================================\n\n',
      );
      log.info(`WhatsApp pairing code received: ${code}`);
    });

    client.on('authenticated', () => {
      log.info('WhatsApp client authenticated.');
      this.latestQrCode = null; // Clear QR code once authenticated
      this.latestPairingCode = null;
      this.isAuthenticating = true; // Not ready yet; chats are still loading
    });

    client.on('auth_failure', (msg: string) => {
      log.error('WhatsApp authentication failure:', msg);
      this.isInitialized = false;
      this.latestQrCode = null;
      this.isAuthenticating = false;
      this.notifySessionInvalidated();
      // Restart the client so a fresh QR code is emitted and
      // get_qr_code works again without a server restart.
      this.scheduleReconnect(`authentication failure: ${msg}`);
    });

    client.on('ready', () => {
      log.info('WhatsApp client is ready.');
      this.isInitialized = true;
      this.isAuthenticating = false;
      this.reconnectAttempts = 0;
      this.startHealthCheck();
    });

    client.on('message', async (message: WAWebJS.Message) => {
      log.debug('Received message:', JSON.stringify(message));
    });

    client.on('message_create', async (message: WAWebJS.Message) => {
      // Fired on all message creations, including your own
      if (message.fromMe) {
        log.debug('Sent message:', JSON.stringify(message));
      }
    });

    client.on('disconnected', (reason: any) => {
      log.warn('WhatsApp client disconnected:', reason);
      this.isInitialized = false;
      this.latestQrCode = null; // Clear QR on disconnect
      this.latestPairingCode = null;
      this.isAuthenticating = false;
      this.scheduleReconnect(`disconnected: ${reason}`);
    });

    client.on('loading_screen', (percent: number, message: string) => {
      log.info(`WhatsApp loading: ${percent}% - ${message}`);
      // A loading screen while a QR/pairing code is pending means the user
      // just scanned/approved - flip to "authenticating" immediately so
      // status checks during this window wait instead of saying "not authenticated".
      if (this.latestQrCode || this.latestPairingCode) {
        this.isAuthenticating = true;
      }
    });
  }

  /**
   * Schedule a reconnect attempt with exponential backoff (5s, 10s, 20s, ...
   * capped at 5 minutes). No-op if a reconnect is already pending or the
   * disconnect was intentional (shutdown/logout).
   */
  private scheduleReconnect(reason: string): void {
    if (this.suppressReconnect || this.reconnectTimer) {
      return;
    }
    const delayMs = Math.min(5000 * 2 ** this.reconnectAttempts, 5 * 60 * 1000);
    this.reconnectAttempts++;
    log.warn(
      `WhatsApp connection lost (${reason}). Reconnect attempt ${this.reconnectAttempts} scheduled in ${Math.round(delayMs / 1000)}s.`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delayMs);
    // Don't let a pending reconnect keep the process alive during shutdown
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.suppressReconnect) {
      return;
    }
    log.info('Attempting to reconnect WhatsApp client...');
    this.stopHealthCheck();
    try {
      await this.client.destroy();
    } catch (error) {
      log.warn('Error destroying client during reconnect (continuing):', error);
    }
    this.isInitialized = false;
    try {
      // Recreate the client: re-initializing a destroyed client instance is unreliable
      this.client = this.createClient();
      await this.initialize();
      log.info('WhatsApp client reconnected successfully.');
    } catch (error) {
      log.error('Reconnect attempt failed:', error);
      this.scheduleReconnect('previous reconnect attempt failed');
    }
  }

  /**
   * Periodically verify the client is still connected. Some failure modes
   * (e.g. the phone going offline for a long time, browser tab dying) do not
   * reliably emit a 'disconnected' event.
   */
  private startHealthCheck(): void {
    this.stopHealthCheck();
    const intervalMs = Number(process.env.HEALTH_CHECK_INTERVAL_MS || 60_000);
    if (intervalMs <= 0) {
      log.info('Health check disabled (HEALTH_CHECK_INTERVAL_MS <= 0).');
      return;
    }
    this.healthCheckTimer = setInterval(async () => {
      try {
        const state = await this.client.getState();
        if (state !== 'CONNECTED') {
          log.warn(`Health check: client state is '${state ?? 'unknown'}', triggering reconnect.`);
          this.isInitialized = false;
          this.stopHealthCheck();
          this.scheduleReconnect(`health check state: ${state}`);
        }
      } catch (error) {
        log.warn('Health check: failed to get client state, triggering reconnect.', error);
        this.isInitialized = false;
        this.stopHealthCheck();
        this.scheduleReconnect('health check error');
      }
    }, intervalMs);
    // Don't keep the process alive just for health checks
    this.healthCheckTimer.unref?.();
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private cancelPendingReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      log.warn('WhatsApp client already initialized.');
      return;
    }
    // Share one in-flight attempt between concurrent callers
    if (this.initPromise) {
      return this.initPromise;
    }
    const attempt = (async () => {
      try {
        await this.doInitialize();
      } finally {
        this.initPromise = null;
      }
    })();
    this.initPromise = attempt;
    return attempt;
  }

  private async doInitialize(): Promise<void> {
    // Re-enable auto-reconnect (it is suppressed during logout/shutdown)
    this.suppressReconnect = false;

    // Clean up any orphaned browser processes before starting: both the ones
    // we know from the PID file and any unregistered leftover that still holds
    // the profile lock (e.g. the server was force-killed mid-initialize).
    await this.browserProcessManager.cleanupOrphanedProcesses();
    await this.browserProcessManager.killBrowsersUsingProfile(this.sessionDataPath);

    log.info('Initializing WhatsApp client...');
    const client = this.client;
    try {
      const initInFlight = client.initialize();
      // Register the browser PID as soon as puppeteer has launched, NOT after
      // the full 15-20s initialization: if the process is killed mid-init, the
      // PID file is the only way the next instance can find the leftover browser.
      void this.registerBrowserPidEarly(client, initInFlight);
      await initInFlight;

      const pid = this.tryGetBrowserPid(client);
      if (pid) {
        this.registerBrowserPid(pid);
      } else {
        log.warn('Could not determine browser PID after initialization');
      }
    } catch (error) {
      if (this.suppressReconnect) {
        // Shutdown/destroy raced the initialization - expected, not an error
        log.info('WhatsApp client initialization aborted by shutdown.');
        throw error;
      }
      log.error('Error initializing WhatsApp client:', error);
      const message = error instanceof Error ? error.message : String(error);
      if (/already running/i.test(message)) {
        // A leftover browser (ours or a zombie predecessor's) holds the profile
        // lock. Kill it and retry instead of staying broken until a restart.
        log.warn('Browser profile is locked; killing the lock holder and scheduling a retry.');
        try {
          await this.browserProcessManager.killBrowsersUsingProfile(this.sessionDataPath, {
            includeOwnedByCurrentProcess: true,
          });
        } catch (cleanupError) {
          log.warn('Failed to clear the locked browser profile:', cleanupError);
        }
        this.scheduleReconnect('browser profile was locked by a leftover process');
      }
      throw error;
    }
  }

  /**
   * Poll for the puppeteer browser PID while initialize() is still running and
   * register it the moment it exists. Stops as soon as the PID is registered
   * or the initialization settles (doInitialize then does a final attempt).
   */
  private async registerBrowserPidEarly(
    client: WAWebJS.Client,
    initInFlight: Promise<unknown>,
  ): Promise<void> {
    let settled = false;
    initInFlight.then(
      () => (settled = true),
      () => (settled = true),
    );
    const POLL_INTERVAL_MS = 250;
    const MAX_POLLS = 240; // Give up after 60s; init has failed long before that
    for (let i = 0; i < MAX_POLLS && !settled; i++) {
      const pid = this.tryGetBrowserPid(client);
      if (pid) {
        this.registerBrowserPid(pid);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private registerBrowserPid(pid: number): void {
    if (this.registeredBrowserPid === pid) {
      return; // Already registered (early poller and post-init both call this)
    }
    this.registeredBrowserPid = pid;
    this.browserProcessManager.registerProcess(pid);
    log.info(`Registered browser process with PID: ${pid}`);
  }

  async destroy(): Promise<void> {
    // Share one in-flight teardown between concurrent callers (shutdown signal
    // + stdin close + reconnect can all arrive within milliseconds)
    if (this.destroyPromise) {
      return this.destroyPromise;
    }
    const attempt = (async () => {
      try {
        await this.doDestroy();
      } finally {
        this.destroyPromise = null;
      }
    })();
    this.destroyPromise = attempt;
    return attempt;
  }

  /**
   * Best-effort teardown that NEVER hangs and never throws: a stdio server
   * that cannot finish its shutdown becomes a zombie whose browser keeps the
   * session directory locked for every future instance.
   */
  private async doDestroy(): Promise<void> {
    log.info('Destroying WhatsApp client...');
    this.suppressReconnect = true;
    this.cancelPendingReconnect();
    this.stopHealthCheck();
    const client = this.client;

    // Give an in-flight initialize() a moment to settle: destroying the
    // browser mid script-injection is what produced the TargetCloseError
    // storms. Keep it short - MCP clients on the stock SDK TerminateProcess
    // us ~2s after closing stdin, so every ms spent waiting here comes out
    // of the budget for the actual teardown below.
    if (this.initPromise) {
      await Promise.race([
        this.initPromise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }

    const pid = this.tryGetBrowserPid(client) ?? this.registeredBrowserPid;
    try {
      if (this.isInitialized) {
        await withTimeout(client.destroy(), 5_000, 'client.destroy()');
        log.info('WhatsApp client destroyed successfully');
      } else {
        // The client never became ready: client.destroy()'s page-evaluate
        // cleanup is the slow (and hang-prone) part and there is no session
        // state to flush beyond the browser profile itself. Closing the
        // browser directly is what actually flushes the profile to disk.
        const browser = (client as { pupBrowser?: { close(): Promise<void> } }).pupBrowser;
        if (browser) {
          await withTimeout(browser.close(), 1_500, 'browser.close()');
          log.info('Browser closed directly (client was not ready).');
        } else {
          log.info('No browser launched yet; nothing to close.');
        }
      }
    } catch (error) {
      log.warn('client.destroy() failed or timed out; force-killing the browser.', error);
      try {
        if (pid) {
          await this.browserProcessManager.killProcessTree(pid);
        } else {
          // Browser never got registered (killed mid-launch): find it by its profile path
          await this.browserProcessManager.killBrowsersUsingProfile(this.sessionDataPath, {
            includeOwnedByCurrentProcess: true,
          });
        }
      } catch (killError) {
        log.warn('Force-kill of the browser failed:', killError);
      }
    }

    this.isInitialized = false;
    this.latestQrCode = null;

    if (pid) {
      this.browserProcessManager.unregisterProcess(pid);
      log.info(`Unregistered browser process with PID: ${pid}`);
    }
    this.registeredBrowserPid = null;
  }

  async logout(): Promise<void> {
    log.info('Logging out of WhatsApp...');
    this.suppressReconnect = true; // The logout will emit 'disconnected'; don't auto-reconnect
    this.cancelPendingReconnect();
    this.stopHealthCheck();
    try {
      // Get the PID before logging out
      const pid = this.tryGetBrowserPid();

      // Logout from WhatsApp
      await this.client.logout();
      this.isInitialized = false;
      this.latestQrCode = null;
      log.info('Successfully logged out of WhatsApp');
      this.notifySessionInvalidated();

      // Unregister the browser process
      if (pid) {
        this.browserProcessManager.unregisterProcess(pid);
        log.info(`Unregistered browser process with PID: ${pid}`);
      }

      // Tear down and recreate the client so the next initialize() starts
      // from a clean state and emits a fresh QR code.
      try {
        await this.client.destroy();
      } catch (destroyError) {
        log.warn('Error destroying client after logout (continuing):', destroyError);
      }
      this.client = this.createClient();
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

  /** Latest pairing code emitted while phone number pairing is active, if any. */
  getLatestPairingCode(): string | null {
    return this.latestPairingCode;
  }

  /**
   * Wait for the client to become ready instead of failing immediately.
   *
   * MCP clients (e.g. FLUJO workflows) often call tools within seconds of
   * spawning this server, while WhatsApp Web needs ~15-20s to restore a
   * session. Failing fast produced spurious "client not ready" errors; instead
   * we block the tool call until ready, or fail fast once it is clear that
   * user interaction is required (a QR code / pairing code is pending).
   */
  async ensureReady(timeoutMs = Number(process.env.TOOL_READY_TIMEOUT_MS || 45_000)): Promise<void> {
    if (this.isInitialized) return;
    const start = Date.now();
    log.info(`Tool call received while client is not ready; waiting up to ${Math.round(timeoutMs / 1000)}s...`);
    const QR_GRACE_MS = 3_000; // Tolerate the just-scanned race before 'loading_screen' fires
    const deadline = start + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isInitialized) {
        log.info(`Client became ready after ${((Date.now() - start) / 1000).toFixed(1)}s; continuing tool call.`);
        return;
      }
      const codePending = !!(this.latestQrCode || this.latestPairingCode);
      if (codePending && !this.isAuthenticating && Date.now() - start >= QR_GRACE_MS) {
        throw new Error(
          'WhatsApp is not authenticated: a QR code / pairing code is waiting to be used. ' +
            'Authenticate via get_qr_code or request_pairing_code first.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `WhatsApp client did not become ready within ${Math.round(timeoutMs / 1000)}s. ` +
        'It may still be starting up, or another server instance may hold the session - try again shortly.',
    );
  }

  /**
   * Wait until the initial connection attempt has a definitive outcome:
   * ready, or waiting for user authentication (QR/pairing code emitted).
   * Used by check_auth_status so a freshly started server reports the truth
   * instead of a premature "not authenticated".
   */
  async waitForAuthOutcome(timeoutMs = 25_000): Promise<void> {
    const start = Date.now();
    const QR_GRACE_MS = 3_000; // Tolerate the just-scanned race before 'loading_screen' fires
    while (Date.now() - start < timeoutMs) {
      if (this.isInitialized) return;
      const codePending = !!(this.latestQrCode || this.latestPairingCode);
      // A pending code is a definitive outcome ("waiting for the user to
      // scan") - but NOT while a scan is being processed (isAuthenticating),
      // and only after a short grace period, so a status check made right
      // after scanning waits for 'ready' instead of reporting a stale state.
      if (codePending && !this.isAuthenticating && Date.now() - start >= QR_GRACE_MS) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Register a listener fired when the WhatsApp session is unlinked or fails to authenticate. */
  onSessionInvalidated(listener: () => void): void {
    this.sessionInvalidatedListeners.push(listener);
  }

  private notifySessionInvalidated(): void {
    for (const listener of this.sessionInvalidatedListeners) {
      try {
        listener();
      } catch (error) {
        log.warn('Session-invalidated listener failed:', error);
      }
    }
  }

  /**
   * Request a pairing code as an alternative to scanning the QR code.
   * The user enters the returned 8-character code on their phone under
   * Settings > Linked Devices > Link a device > "Link with phone number instead".
   *
   * Only valid while the client is unauthenticated and waiting at the QR stage.
   *
   * @param phoneNumber Phone number in international, symbol-free format
   *                    (e.g. 4915112345678 for Germany, 12025550108 for US).
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (this.isAuthenticated()) {
      throw new Error('Client is already authenticated; no pairing code needed.');
    }
    const sanitized = phoneNumber.replace(/\D/g, '');
    if (sanitized.length < 6) {
      throw new Error(
        `Invalid phone number '${phoneNumber}'. Provide it in international, symbol-free format (e.g. 4915112345678).`,
      );
    }
    if (!this.latestQrCode) {
      throw new Error(
        'The client is not at the pairing stage yet (no QR code has been emitted). Try again in a few seconds.',
      );
    }
    log.info(`Requesting pairing code for phone number ${sanitized}...`);
    return this.client.requestPairingCode(sanitized, true);
  }

  isAuthenticated(): boolean {
    // Check if the client is authenticated and connected
    // isInitialized means the client is ready and authenticated
    return this.isInitialized;
  }

  // --- Wrapper Methods for WhatsApp Functionality ---

  // Note: WWebContact and WWebChat aliases are removed from imports, use Contact and Chat directly

  async searchContacts(query: string): Promise<SimpleContact[]> {
    await this.ensureReady();
    const contacts = await this.client.getContacts();
    const lowerQuery = query.toLowerCase();

    return contacts
      .filter(
        (contact) =>
          (contact.name?.toLowerCase().includes(lowerQuery) ||
           contact.number?.includes(query) || // number can be null for some contacts
           contact.pushname?.toLowerCase().includes(lowerQuery)) &&
          contact.isUser // Filter out groups/broadcasts if needed
      )
      .map(this.mapContactToSimpleContact);
  }

  async listChats(limit = 20, includeLastMessage = true): Promise<SimpleChat[]> {
     await this.ensureReady();
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
    await this.ensureReady();
    try {
      const chat = await this.client.getChatById(chatId);
      return this.mapChatToSimpleChat(chat);
    } catch (error: any) { // Add type any
      log.warn(`Chat not found: ${chatId}`, error);
      return null;
    }
  }

   async getContactById(contactId: string): Promise<SimpleContact | null> {
    await this.ensureReady();
    try {
      const contact = await this.client.getContactById(contactId);
      return this.mapContactToSimpleContact(contact);
    } catch (error: any) { // Add type any
      log.warn(`Contact not found: ${contactId}`, error);
      return null;
    }
  }

  async getMessages(chatId: string, limit = 50): Promise<SimpleMessage[]> {
    await this.ensureReady();
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
     await this.ensureReady();
     try {
         const message = await this.client.getMessageById(messageId);
      return message ? this.mapMessageToSimpleMessage(message) : null;
     } catch (error: any) { // Add type any
         log.warn(`Failed to get message by ID ${messageId}:`, error);
         return null;
     }
  }

  async sendMessage(to: string, content: string): Promise<WAWebJS.Message> {
    await this.ensureReady();
    log.info(`Sending message to ${to}`);
    return this.client.sendMessage(to, content);
  }

  async sendMedia(to: string, mediaPathOrUrl: string, caption?: string): Promise<WAWebJS.Message> {
    await this.ensureReady();
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
    await this.ensureReady();
    log.info(`Sending media from base64 to ${to}`);
    const media = new MessageMedia(mimeType, base64Data, filename);
    return this.client.sendMessage(to, media, { caption });
  }

  async downloadMedia(messageId: string): Promise<WAWebJS.MessageMedia | null> {
    await this.ensureReady();
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
   * Get the process ID of the Chrome browser used by the given (or current)
   * client, or null if the browser has not launched (yet). Quiet by design:
   * it is polled repeatedly while the browser is still starting.
   */
  tryGetBrowserPid(client: WAWebJS.Client = this.client): number | null {
    try {
      if (!client) {
        return null;
      }

      // Access the internal puppeteer browser
      // This is a bit hacky but necessary to get the browser PID
      const internal = client as any;

      // Try different ways to access the browser
      let browser = null;

      // Method 1: Try to access through pupBrowser property (if available)
      if (internal.pupBrowser) {
        browser = internal.pupBrowser;
      }
      // Method 2: Try to access through _page property
      else if (internal._page && internal._page.browser) {
        browser = internal._page.browser();
      }
      // Method 3: Try to access through puppeteer property
      else if (internal.puppeteer && internal.puppeteer.browser) {
        browser = internal.puppeteer.browser;
      }

      if (browser) {
        const browserProcess = browser.process();
        if (browserProcess) {
          return browserProcess.pid ?? null;
        }
      }

      return null;
    } catch (error) {
      log.error('Error getting browser PID:', error);
      return null;
    }
  }

  /** @deprecated Use tryGetBrowserPid(); kept for backwards compatibility. */
  async getBrowserPid(): Promise<number | null> {
    return this.tryGetBrowserPid();
  }
}

/**
 * Resolve with the promise, or reject once the timeout elapses - whichever
 * comes first. The underlying operation is not cancelled; callers use this to
 * stop WAITING on puppeteer teardown that may never finish.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
