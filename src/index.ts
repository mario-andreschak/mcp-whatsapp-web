// Load environment variables from .env file
import 'dotenv/config';

// At the very top of src/index.ts, before any imports
if (process.argv.includes('--stdio') || 
    (!process.argv.includes('--sse') && process.env.TRANSPORT !== 'sse')) {
  // Redirect stdout and stderr to prevent breaking MCP protocol
  
  // // Silently discard all stdout writes
  // process.stdout.write = function(): boolean {
  //   return true; // Pretend it succeeded but don't actually write
  // };
  
  // // Silently discard all stderr writes
  // process.stderr.write = function(): boolean {
  //   return true; // Pretend it succeeded but don't actually write
  // };
  
  // Also silence console methods
  const noop = () => {};
  console.log = console.info = console.debug = console.warn = console.error = noop;
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

  // Determine transport from command line arguments or environment variables
  // For now, defaulting to stdio
  const transportType = process.argv.includes('--sse') ? 'sse' : 'stdio';

  try {
    await serverInstance.start(transportType);
    log.info(`WhatsApp MCP Server started with ${transportType} transport.`);
  } catch (error) {
    log.error('Failed to start server:', error);
    await gracefulShutdown('startup failure');
  }
}

main();
