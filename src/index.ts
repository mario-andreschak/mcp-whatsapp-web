import { WhatsAppMcpServer } from './server.js';
import { log } from './utils/logger.js';

async function main() {
  log.info('Starting WhatsApp MCP Server...');

  const server = new WhatsAppMcpServer();

  // Determine transport from command line arguments or environment variables
  // For now, defaulting to stdio
  const transportType = process.argv.includes('--sse') ? 'sse' : 'stdio';

  try {
    await server.start(transportType);
    log.info(`WhatsApp MCP Server started with ${transportType} transport.`);
  } catch (error) {
    log.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
