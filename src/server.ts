import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Implementation } from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express'; // Import Request and Response
// import { z } from 'zod'; // z is unused currently
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
  version: '1.0.0', // Consider reading from package.json
};

export class WhatsAppMcpServer {
  public readonly server: McpServer;
  private readonly whatsapp: WhatsAppService;
  private sseTransports: { [sessionId: string]: SSEServerTransport } = {};
  private browserProcessManager: BrowserProcessManager;

  constructor() {
    this.browserProcessManager = new BrowserProcessManager();
    this.whatsapp = new WhatsAppService();

    this.server = new McpServer(SERVER_INFO, {
      // Define initial capabilities if needed
      capabilities: {
        // Example: Enable logging capability
        logging: {},
      },
      instructions: 'This server provides tools to interact with WhatsApp.',
    });

    this.registerTools();
  }

  private registerTools() {
    log.info('Registering MCP tools...');
    // Call tool registration functions here
    registerAuthTools(this.server, this.whatsapp);
    registerContactTools(this.server, this.whatsapp);
    registerChatTools(this.server, this.whatsapp);
    registerMessageTools(this.server, this.whatsapp);
    registerMediaTools(this.server, this.whatsapp);

    // Remove example dummy tool if no longer needed, or keep for testing
    // this.server.tool('ping', async () => ({
    //   content: [{ type: 'text', text: 'pong' }],
    // }));
    // Let's keep ping for now for basic testing
    this.server.tool('ping', async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));

    log.info('MCP tools registered.');
  }

  async start(transportType: 'stdio' | 'sse' = 'stdio') {
    log.info(`Initializing WhatsApp client...`);
    try {
      // Clean up any orphaned browser processes before starting
      await this.browserProcessManager.cleanupOrphanedProcesses();
      
      // Initialize the WhatsApp client
      await this.whatsapp.initialize();
      log.info('WhatsApp client initialized successfully.');
    } catch (error) {
      log.error('Failed to initialize WhatsApp client:', error);
      throw error; // Rethrow to prevent server start
    }

    if (transportType === 'stdio') {
      await this.startStdioTransport();
    } else {
      await this.startSseTransport();
    }
  }

  private async startStdioTransport() {
    log.info('Starting MCP server with stdio transport...');
    const stdioTransport = new StdioServerTransport();
    // Handle transport errors
    stdioTransport.onerror = (error) => {
      log.error('StdioTransport Error:', error);
    };
    await this.server.connect(stdioTransport);
    log.info('MCP server connected via stdio.');
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
      
      // Close all SSE transports if any are active
      const sessionIds = Object.keys(this.sseTransports);
      if (sessionIds.length > 0) {
        log.info(`Closing ${sessionIds.length} active SSE transports...`);
        for (const sessionId of sessionIds) {
          try {
            // Clean up the transport
            delete this.sseTransports[sessionId];
          } catch (error) {
            log.warn(`Error closing SSE transport ${sessionId}:`, error);
          }
        }
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

  private async startSseTransport(port = 3001) {
    log.info(`Starting MCP server with SSE transport on port ${port}...`);
    const app = express();

    // Endpoint for establishing SSE connection
    app.get('/sse', async (_req: Request, res: Response) => { // Prefix req with _
      log.info('SSE connection requested');
      const transport = new SSEServerTransport('/messages', res);
      this.sseTransports[transport.sessionId] = transport;

      // Handle transport errors
      transport.onerror = (error) => {
        log.error(`SSE Transport Error (Session ${transport.sessionId}):`, error);
        // Clean up transport on error
        delete this.sseTransports[transport.sessionId];
      };

      res.on('close', () => {
        log.info(`SSE connection closed (Session ${transport.sessionId})`);
        delete this.sseTransports[transport.sessionId];
        // Optionally call transport.close() or server-side cleanup if needed
      });

      try {
        await this.server.connect(transport);
        log.info(`SSE transport connected (Session ${transport.sessionId})`);
      } catch (error) {
        log.error(`Failed to connect SSE transport (Session ${transport.sessionId}):`, error);
        delete this.sseTransports[transport.sessionId];
        if (!res.headersSent) {
          res.status(500).send('Failed to connect MCP server');
        }
      }
    });

    // Endpoint for receiving messages from the client via POST
    app.post('/messages', express.json({ limit: '10mb' }), async (req: Request, res: Response) => { // Add types
      const sessionId = req.query.sessionId as string;
      const transport = this.sseTransports[sessionId];

      if (transport) {
        log.debug(`Received POST message for session ${sessionId}`);
        try {
          // Pass raw body if needed, or parsed body
          await transport.handlePostMessage(req, res, req.body);
          // handlePostMessage sends the response (202 Accepted or error)
        } catch (error) {
          log.error(`Error handling POST message for session ${sessionId}:`, error);
          // Ensure response is sent if handlePostMessage failed before sending
          if (!res.headersSent) {
             res.status(500).send('Error processing message');
          }
        }
      } else {
        log.warn(`No active SSE transport found for sessionId: ${sessionId}`);
        res.status(400).send('No active SSE transport found for this session ID');
      }
    });

    return new Promise<void>((resolve, reject) => {
      const serverInstance = app.listen(port, () => {
        log.info(`SSE server listening on http://localhost:${port}`);
        resolve();
      });

      serverInstance.on('error', (error: Error) => { // Add type
        log.error('SSE server failed to start:', error);
        reject(error);
      });
    });
  }

  // Add methods for registering specific tool groups if needed
}
