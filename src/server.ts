import { guardedBackend } from './tools/register.js';
import { McpServer, createMcpHandler, type Implementation } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from '@modelcontextprotocol/server-legacy/auth';
import { operatorGuard, publicOrigin, httpBoundary } from './auth/http-security.js';
import express, { type RequestHandler } from 'express';
import path from 'path';
import { WhatsAppOAuthProvider } from './auth/oauth-provider.js';
import { createLinkRouter } from './auth/link-page.js';
import type { WhatsAppBackend } from './services/backend.js';
import { createWhatsAppBackend } from './services/backend-factory.js';
import { log } from './utils/logger.js';
import { BrowserProcessManager } from './utils/browser-process-manager.js';
// Import tool registration functions
import { registerContactTools } from './tools/contacts.js';
import { registerChatTools } from './tools/chats.js';
import { registerMessageTools } from './tools/messages.js';
import { registerMediaTools } from './tools/media.js';
import { registerAuthTools } from './tools/auth.js';

const SERVER_INFO: Implementation = {
  name: 'mcp-whatsapp-web',
  version: '1.2.0', // Keep in sync with package.json
};

export type TransportType = 'stdio' | 'http';

export class WhatsAppMcpServer {
  private whatsapp!: WhatsAppBackend;
  private browserProcessManager?: BrowserProcessManager;
  private stdio?: Awaited<ReturnType<typeof serveStdio>>;
  private httpHandler?: ReturnType<typeof createMcpHandler>;
  private httpServer: ReturnType<express.Express['listen']> | null = null;
  private stopping = false;
  private shutdownPromise?: Promise<void>;

  constructor(whatsapp?: WhatsAppBackend) {
    if (whatsapp) this.whatsapp = whatsapp;
  }

  /**
   * Build an McpServer with all tools registered. Stdio uses a single
   * instance; Streamable HTTP creates one per session (an McpServer can only
   * be bound to one transport at a time).
   */
  private createServer(): McpServer {
    const server = new McpServer(SERVER_INFO, {
      instructions: 'This server provides tools to interact with WhatsApp.',
    });

    const backend = guardedBackend(this.whatsapp);
    registerAuthTools(server, backend);
    registerContactTools(server, backend);
    registerChatTools(server, backend);
    registerMessageTools(server, backend);
    registerMediaTools(server, backend);

    server.registerTool('ping', { description: 'Check server availability without contacting WhatsApp.', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));

    return server;
  }

  async start(transportType: TransportType = 'stdio') {
    if (this.stopping) return;
    const backend = this.whatsapp ?? await createWhatsAppBackend();
    if (this.stopping) {
      await backend.destroy();
      return;
    }
    this.whatsapp = backend;
    if (this.whatsapp.backend === 'webjs') {
      this.browserProcessManager = new BrowserProcessManager();
    }
    log.info(`Using WhatsApp backend: ${this.whatsapp.backend}`);
    // Connect the MCP transport first so the server is responsive immediately.
    // The WhatsApp client (browser launch, QR/session restore) initializes in
    // the background; tools report a clear error until it is ready, and
    // get_qr_code becomes usable as soon as a QR code is emitted.
    if (transportType === 'stdio') {
      await this.startStdioTransport();
      // Optionally expose the Streamable HTTP endpoint alongside stdio
      const extraHttpPort = Number(process.env.MCP_HTTP_PORT || 0);
      if (extraHttpPort > 0) {
        await this.startHttpTransport(extraHttpPort);
      }
    } else {
      await this.startHttpTransport(Number(process.env.MCP_HTTP_PORT || 3001));
    }

    if (this.stopping) {
      await this.closeTransports();
      return;
    }

    if (process.env.MCP_AUTO_CONNECT === 'false' || process.argv.includes('--no-connect')) return;

    log.info('Initializing WhatsApp client in the background...');
    void (async () => {
      try {
        // Clean up any orphaned browser processes before starting
        await this.browserProcessManager?.cleanupOrphanedProcesses();
        if (this.stopping) return;

        // Initialize the WhatsApp client
        await this.whatsapp.initialize();
        log.info('WhatsApp client initialized successfully.');
      } catch (error) {
        // initialize() already logged the full error; one line is enough here
        log.error(
          'Failed to initialize WhatsApp client. The MCP server stays up; ' +
            'check_auth_status and get_qr_code can be used once the issue is resolved. ' +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    })();
  }

  private async startStdioTransport() {
    log.info('Starting MCP server with stdio transport...');
    this.stdio = await serveStdio(() => this.createServer(), { legacy: 'serve', onerror: error => log.error('Stdio transport error:', error) });
    // When the MCP client disconnects (stdin closed), nothing can ever reach
    // this process over stdio again - shut down cleanly so the browser is
    // released and no zombie process keeps the WhatsApp session dir locked.
    // (The SDK's stdio transport only listens for 'data'/'error', so it never
    // notices stdin ending; watch it ourselves. This intentionally also ends
    // dual-mode stdio+HTTP processes: the spawning client owns the lifecycle.)
    const shutdownOnStdinClose = (event: string) => () => {
      log.warn(`stdin ${event}: MCP client disconnected, shutting down.`);
      process.emit('SIGTERM' as 'disconnect');
    };
    process.stdin.once('end', shutdownOnStdinClose('end'));
    process.stdin.once('close', shutdownOnStdinClose('close'));
    log.info('MCP server connected via stdio.');
  }

  /** Each authenticated HTTP request has an isolated MCP facade over this account. */
  private async startHttpTransport(port: number) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MCP_HTTP_PORT.');
    const ownerGuard = operatorGuard();
    const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
    // Validate remote configuration before opening the listener (port 0 is useful for tests).
    publicOrigin(host, port);
    const app = express();
    app.disable('x-powered-by');
    await new Promise<void>((resolve, reject) => {
      this.httpServer = app.listen(port, host, () => resolve());
      this.httpServer.once('error', reject);
    });
    const address = this.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener has no TCP address.');
    const issuerUrl = new URL(publicOrigin(host, address.port));
    const mcpUrl = new URL('/mcp', issuerUrl);
    app.use(httpBoundary(issuerUrl.origin));
    app.use(express.json({ limit: '10mb' }));
    app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
    const guards: RequestHandler[] = [];
    if (process.env.MCP_OAUTH === 'true') {
      const sessionDir = path.resolve(this.whatsapp.backend === 'baileys'
        ? process.env.BAILEYS_SESSION_DIR || 'baileys-sessions'
        : process.env.WHATSAPP_SESSION_DIR || 'whatsapp-sessions');
      const provider = new WhatsAppOAuthProvider(this.whatsapp,
        path.join(sessionDir, 'oauth-store.json'),
        { issuer: issuerUrl.href, resource: mcpUrl.href, accountNamespace: sessionDir });
      this.whatsapp.onSessionInvalidated(() => provider.revokeAllTokens());
      app.use(mcpAuthRouter({ provider, issuerUrl, resourceServerUrl: mcpUrl, resourceName: 'WhatsApp MCP Server' }));
      app.use('/oauth/link', createLinkRouter(provider, this.whatsapp, ownerGuard));
      guards.push(requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }));
    } else {
      guards.push(ownerGuard);
    }
    this.httpHandler = createMcpHandler(() => this.createServer(), {
      legacy: 'stateless', onerror: error => log.error('HTTP transport error:', error),
    });
    const handle = toNodeHandler(this.httpHandler);
    app.all('/mcp', ...guards, async (req, res) => { await handle(req, res, req.body); });
    log.info('Authenticated HTTP endpoint listening at ' + mcpUrl.href);
  }

  /**
   * Gracefully shutdown the server and clean up resources
   * @returns A promise that resolves when shutdown is complete
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.shutdownPromise ??= this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    log.info('Shutting down WhatsApp MCP Server...');
    try {
      // Close the active driver and flush its persistent session state.
      await this.whatsapp?.destroy();
    } finally {
      await this.closeTransports();
      // Final check for any orphaned processes that might have been missed
      try {
        await this.browserProcessManager?.cleanupOrphanedProcesses();
      } catch (cleanupError) {
        log.warn('Error during final browser process cleanup:', cleanupError);
        // Continue with shutdown even if cleanup fails
      }

    }
    log.info('Server shutdown completed successfully');
  }

  private async closeTransports(): Promise<void> {
    await this.stdio?.close();
    this.stdio = undefined;
    await this.httpHandler?.close();
    this.httpHandler = undefined;
    const httpServer = this.httpServer;
    this.httpServer = null;
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    }
  }
}
