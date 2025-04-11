import { pino } from 'pino'; // Use named import

// Basic logger configuration
// In a real application, you might want more sophisticated configuration
// based on environment variables (e.g., log level, pretty print)
export const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

// Example usage:
// log.info('This is an info message');
// log.warn('This is a warning');
// log.error(new Error('Something went wrong'), 'Error details');
// log.debug({ data: { key: 'value' } }, 'Debugging data');
// log.verbose('Verbose message', JSON.stringify({ complex: { nested: true } }));
