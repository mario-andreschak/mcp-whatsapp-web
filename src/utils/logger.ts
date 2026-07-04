import { pino } from 'pino';
import pretty from 'pino-pretty';
import fs from 'fs';
import path from 'path';
import util from 'util';

// stdio MCP servers must never write logs to stdout (it would corrupt the
// JSON-RPC stream), but stderr is safe and is surfaced by most MCP clients.
// We therefore log to two sinks:
//   - logs/mcp-whatsapp.log : everything at LOG_LEVEL (default: info)
//   - stderr                : LOG_STDERR_LEVEL and above (default: warn)

const VALID_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const levelOrDefault = (value: string | undefined, fallback: string): string =>
  value && VALID_LEVELS.includes(value) ? value : fallback;

const LOG_LEVEL = levelOrDefault(process.env.LOG_LEVEL, 'info');
const LOG_STDERR_LEVEL = levelOrDefault(process.env.LOG_STDERR_LEVEL, 'warn');

// Create log directory if it doesn't exist
const logDir = path.join(process.cwd(), 'logs');
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch {
  // Silent fail if directory creation fails; file stream below will also fail silently
}

const logFilePath = path.join(logDir, 'mcp-whatsapp.log');

const streams: pino.StreamEntry[] = [];

try {
  streams.push({
    level: LOG_LEVEL as pino.Level,
    stream: pino.destination({ dest: logFilePath, append: true, sync: false }),
  });
} catch {
  // File logging unavailable; stderr stream still works
}

streams.push({
  level: LOG_STDERR_LEVEL as pino.Level,
  stream: pretty({
    destination: 2, // stderr
    colorize: false,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
  }),
});

export const log = pino(
  {
    // The logger level must be the lowest of all stream levels,
    // otherwise streams with a lower threshold never receive anything.
    level: 'trace',
    hooks: {
      // The codebase logs console-style: log.error('Something failed:', error).
      // Vanilla pino would silently DROP every argument after the first, losing
      // the actual error message and stack. Merge all arguments into the log
      // line instead (util.format renders Error objects with their stack).
      logMethod(inputArgs, method) {
        if (inputArgs.length >= 2) {
          return method.call(this, util.format(...inputArgs));
        }
        return method.apply(this, inputArgs);
      },
    },
  },
  pino.multistream(streams),
);

// Add a method to retrieve logs (useful for debugging)
export const getLogs = (): string => {
  try {
    return fs.existsSync(logFilePath) ? fs.readFileSync(logFilePath, 'utf8') : '';
  } catch {
    return '';
  }
};
