// Load environment variables from .env file
import 'dotenv/config';
import util from 'util';

// With the stdio transport, stdout carries the MCP JSON-RPC stream, so nothing
// else may ever write to it. Redirect all console output (including from
// third-party libraries) to stderr, which MCP clients surface as server logs.
// This is done unconditionally: it is equally correct for the HTTP transport.
{
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(util.format(...args) + '\n');
  };
  console.log = console.info = console.debug = console.warn = console.error = toStderr;
}

import { WhatsAppMcpServer } from './server.js';
import { log } from './utils/logger.js';
import { BrowserProcessManager } from './utils/browser-process-manager.js';

// Global reference to the server instance
let serverInstance: WhatsAppMcpServer | null = null;
// Flag to track if shutdown is in progress to prevent multiple shutdown attempts
let isShuttingDown = false;
// Global reference to the browser process manager for cleanup on exit
const browserProcessManager = new BrowserProcessManager();

/**
 * Gracefully shutdown the server and clean up resources
 */
async function gracefulShutdown(signal: string): Promise<void> {
  // Prevent multiple shutdown attempts
  if (isShuttingDown) {
    log.info('Shutdown already in progress, ignoring additional signal');
    return;
  }
  
  isShuttingDown = true;
  log.info(`Received ${signal}. Shutting down gracefully...`);
  
  try {
    if (serverInstance) {
      // Use the server's shutdown method to clean up resources
      await serverInstance.shutdown();
      // Set to null to prevent multiple shutdown attempts
      serverInstance = null;
    } else {
      // If server instance doesn't exist, we still need to clean up any browser processes
      log.info('No server instance found, checking for orphaned browser processes...');
      await browserProcessManager.cleanupOrphanedProcesses();
    }
    
    log.info('Shutdown completed successfully');
    
    // Use a timeout to allow logs to be flushed before exiting
    setTimeout(() => {
      process.exit(0);
    }, 500);
  } catch (error) {
    log.error('Error during graceful shutdown:', error);
    
    // Try one last time to clean up browser processes
    try {
      await browserProcessManager.cleanupOrphanedProcesses();
    } catch (cleanupError) {
      log.error('Error during emergency browser process cleanup:', cleanupError);
    }
    
    // Use a timeout to allow error logs to be flushed before exiting
    setTimeout(() => {
      process.exit(1);
    }, 500);
  }
}

// Handle process termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled Promise Rejection:', reason);
  gracefulShutdown('unhandledRejection');
});

async function main() {
  log.info('Starting WhatsApp MCP Server...');
  
  // Clean up any orphaned browser processes before starting
  try {
    log.info('Checking for orphaned browser processes...');
    await browserProcessManager.cleanupOrphanedProcesses();
  } catch (error) {
    log.warn('Error cleaning up orphaned processes during startup:', error);
    // Continue with startup even if cleanup fails
  }

  serverInstance = new WhatsAppMcpServer();

  // Determine transport from command line arguments or environment variables.
  // Default: stdio. '--http' (or TRANSPORT=http) serves Streamable HTTP.
  // '--sse' / TRANSPORT=sse are accepted as deprecated aliases for http.
  const wantsHttp =
    process.argv.includes('--http') ||
    process.argv.includes('--sse') ||
    process.env.TRANSPORT === 'http' ||
    process.env.TRANSPORT === 'sse';
  if (process.argv.includes('--sse') || process.env.TRANSPORT === 'sse') {
    log.warn(
      "The SSE transport has been replaced by Streamable HTTP; '--sse' now starts the Streamable HTTP transport (endpoint: /mcp).",
    );
  }
  const transportType = wantsHttp ? ('http' as const) : ('stdio' as const);

  try {
    await serverInstance.start(transportType);
    log.info(`WhatsApp MCP Server started with ${transportType} transport.`);
  } catch (error) {
    log.error('Failed to start server:', error);
    await gracefulShutdown('startup failure');
  }
}

main();
