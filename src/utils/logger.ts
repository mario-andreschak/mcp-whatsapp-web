import { pino } from 'pino';
import fs from 'fs';
import path from 'path';

// Determine if we're in a browser environment
const isBrowser = typeof globalThis !== 'undefined' && 
                 typeof (globalThis as any).window !== 'undefined' && 
                 typeof (globalThis as any).window.localStorage !== 'undefined';

// Determine if we're using stdio transport for MCP
const usingStdioTransport = process.argv.includes('--stdio') || 
  (!process.argv.includes('--sse') && process.env.TRANSPORT !== 'sse');

// Create log directory if it doesn't exist
const logDir = path.join(process.cwd(), 'logs');
if (!isBrowser && !fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    // Silent fail if directory creation fails
  }
}

// Define log file path
const logFilePath = path.join(logDir, 'mcp-whatsapp.log');

// Custom destination that writes to file or localStorage
const customDestination = {
  write: (msg: string) => {
    if (isBrowser) {
      // In browser, use localStorage with rotation to prevent overflow
      try {
        const storage = (globalThis as any).window.localStorage;
        const key = 'mcp_whatsapp_log';
        const existingLog = storage.getItem(key) || '';
        // Keep only last 100KB to prevent localStorage overflow
        const maxSize = 100 * 1024; 
        const newLog = existingLog.length > maxSize 
          ? existingLog.substring(existingLog.length - maxSize / 2) + msg
          : existingLog + msg;
        storage.setItem(key, newLog);
      } catch (e) {
        // Silent fail if localStorage is not available
      }
    } else {
      // In Node.js, write to file
      try {
        fs.appendFileSync(logFilePath, msg);
      } catch (e) {
        // Silent fail if file write fails
      }
    }
    return true;
  }
};

// Configure pino logger
export const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Use different transport based on environment
  ...(usingStdioTransport
    ? {
        // When using stdio transport for MCP, use custom destination to avoid stdout
        destination: customDestination
      }
    : {
        // Otherwise use pino-pretty for console output plus file transport
        transport: {
          targets: [
            // Pretty console output when not using stdio transport
            {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
              },
              level: 'info'
            },
            // Always write to file regardless of transport
            {
              target: 'pino/file',
              options: { destination: logFilePath },
              level: 'debug'
            }
          ]
        }
      })
});

// Add a method to retrieve logs (useful for debugging)
export const getLogs = (): string => {
  if (isBrowser) {
    return (globalThis as any).window.localStorage.getItem('mcp_whatsapp_log') || '';
  } else {
    try {
      return fs.existsSync(logFilePath) 
        ? fs.readFileSync(logFilePath, 'utf8')
        : '';
    } catch (e) {
      return '';
    }
  }
};

// Example usage:
// log.info('This is an info message');
// log.warn('This is a warning');
// log.error(new Error('Something went wrong'), 'Error details');
// log.debug({ data: { key: 'value' } }, 'Debugging data');
// log.verbose('Verbose message', JSON.stringify({ complex: { nested: true } }));
