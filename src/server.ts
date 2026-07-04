import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Implementation, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { randomUUID } from 'node:crypto';
import express, { Request, Response, RequestHandler } from 'express';
import path from 'path';
import { WhatsAppOAuthProvider } from './auth/oauth-provider.js';
import { createLinkRouter } from './auth/link-page.js';
import { WhatsAppService } from './services/whatsapp.js';
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
  version: '1.1.0', // Keep in sync with package.json
};

export type TransportType = 'stdio' | 'http';

export class WhatsAppMcpServer {
  private readonly whatsapp: WhatsAppService;
  private browserProcessManager: BrowserProcessManager;
  // One transport (each with its own McpServer facade) per Streamable HTTP session.
  // They all share the single WhatsAppService instance and thus the same WhatsApp session.
  private httpTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
  private httpServer: ReturnType<express.Express['listen']> | null = null;

  constructor() {
    this.browserProcessManager = new BrowserProcessManager();
    this.whatsapp = new WhatsAppService();
  }

  /**
   * Build an McpServer with all tools registered. Stdio uses a single
   * instance; Streamable HTTP creates one per session (an McpServer can only
   * be bound to one transport at a time).
   */
  private createServer(): McpServer {
    const server = new McpServer(SERVER_INFO, {
      capabilities: {
        logging: {},
      },
      instructions: 'This server provides tools to interact with WhatsApp.',
    });

    registerAuthTools(server, this.whatsapp);
    registerContactTools(server, this.whatsapp);
    registerChatTools(server, this.whatsapp);
    registerMessageTools(server, this.whatsapp);
    registerMediaTools(server, this.whatsapp);

    server.tool('ping', async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));

    return server;
  }

  async start(transportType: TransportType = 'stdio') {
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

    log.info('Initializing WhatsApp client in the background...');
    void (async () => {
      try {
        // Clean up any orphaned browser processes before starting
        await this.browserProcessManager.cleanupOrphanedProcesses();

        // Initialize the WhatsApp client
        await this.whatsapp.initialize();
        log.info('WhatsApp client initialized successfully.');
      } catch (error) {
        log.error(
          'Failed to initialize WhatsApp client. The MCP server stays up; ' +
            'check_auth_status and get_qr_code can be used once the issue is resolved.',
          error,
        );
      }
    })();
  }

  private async startStdioTransport() {
    log.info('Starting MCP server with stdio transport...');
    const stdioTransport = new StdioServerTransport();
    stdioTransport.onerror = (error) => {
      log.error('StdioTransport Error:', error);
    };
    await this.createServer().connect(stdioTransport);
    log.info('MCP server connected via stdio.');
  }

  /**
   * Streamable HTTP transport (MCP spec 2025-03-26). Clients POST JSON-RPC to
   * /mcp; the first initialize request opens a session identified by the
   * mcp-session-id header. GET /mcp opens the optional server-to-client SSE
   * stream, DELETE /mcp terminates the session.
   */
  private async startHttpTransport(port: number) {
    log.info(`Starting MCP server with Streamable HTTP transport on port ${port}...`);
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    // Bind to localhost only by default: the endpoint exposes a personal
    // WhatsApp session. Enable MCP_OAUTH=true to require OAuth bearer tokens.
    const host = process.env.MCP_HTTP_HOST || '127.0.0.1';

    // Optional OAuth layer: the server acts as its own authorization server,
    // and the "consent screen" is the WhatsApp QR / pairing-code page.
    const guards: RequestHandler[] = [];
    if (process.env.MCP_OAUTH === 'true') {
      const issuerUrl = new URL(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
      const mcpUrl = new URL('/mcp', issuerUrl);
      const provider = new WhatsAppOAuthProvider(
        this.whatsapp,
        path.join(process.cwd(), '.oauth-store.json'),
      );
      // Unlinking WhatsApp (logout / auth failure) revokes all tokens, so
      // clients get a 401 and automatically re-run the browser flow.
      this.whatsapp.onSessionInvalidated(() => provider.revokeAllTokens());

      app.use(
        mcpAuthRouter({
          provider,
          issuerUrl,
          resourceServerUrl: mcpUrl,
          resourceName: 'WhatsApp MCP Server',
        }),
      );
      app.use('/oauth/link', createLinkRouter(provider, this.whatsapp));
      guards.push(
        requireBearerAuth({
          verifier: provider,
          resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
        }),
      );
      log.info('OAuth authorization enabled: /mcp requires a bearer token.');
    }

    app.post('/mcp', ...guards, async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      try {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && this.httpTransports[sessionId]) {
          transport = this.httpTransports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              log.info(`Streamable HTTP session initialized: ${sid}`);
              this.httpTransports[sid] = transport;
            },
          });
          transport.onclose = () => {
            if (transport.sessionId && this.httpTransports[transport.sessionId]) {
              log.info(`Streamable HTTP session closed: ${transport.sessionId}`);
              delete this.httpTransports[transport.sessionId];
            }
          };
          await this.createServer().connect(transport);
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: no valid session ID provided' },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        log.error('Error handling MCP HTTP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });

    // GET (SSE notification stream) and DELETE (session termination) share the same lookup
    const handleSessionRequest = async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId ? this.httpTransports[sessionId] : undefined;
      if (!transport) {
        res.status(400).send('Invalid or missing mcp-session-id header');
        return;
      }
      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        log.error(`Error handling ${req.method} /mcp for session ${sessionId}:`, error);
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      }
    };
    app.get('/mcp', ...guards, handleSessionRequest);
    app.delete('/mcp', ...guards, handleSessionRequest);

    return new Promise<void>((resolve, reject) => {
      this.httpServer = app.listen(port, host, () => {
        log.info(`Streamable HTTP endpoint listening on http://${host}:${port}/mcp`);
        resolve();
      });
      this.httpServer.on('error', (error: Error) => {
        log.error('HTTP server failed to start:', error);
        reject(error);
      });
    });
  }

  /**
   * Gracefully shutdown the server and clean up resources
   * @returns A promise that resolves when shutdown is complete
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down WhatsApp MCP Server...');

    try {
      // First destroy the WhatsApp client to properly close the Puppeteer browser
      // This will also unregister the browser PID
      log.info('Destroying WhatsApp client...');
      await this.whatsapp.destroy();
      log.info('WhatsApp client destroyed successfully');

      // Close all active Streamable HTTP sessions
      const sessionIds = Object.keys(this.httpTransports);
      if (sessionIds.length > 0) {
        log.info(`Closing ${sessionIds.length} active HTTP sessions...`);
        for (const sessionId of sessionIds) {
          try {
            await this.httpTransports[sessionId]?.close();
          } catch (error) {
            log.warn(`Error closing HTTP session ${sessionId}:`, error);
          }
          delete this.httpTransports[sessionId];
        }
      }
      if (this.httpServer) {
        this.httpServer.close();
        this.httpServer = null;
      }

      // Final check for any orphaned processes that might have been missed
      try {
        await this.browserProcessManager.cleanupOrphanedProcesses();
      } catch (cleanupError) {
        log.warn('Error during final browser process cleanup:', cleanupError);
        // Continue with shutdown even if cleanup fails
      }

      log.info('Server shutdown completed successfully');
    } catch (error) {
      log.error('Error during server shutdown:', error);
      throw error;
    }
  }
}
