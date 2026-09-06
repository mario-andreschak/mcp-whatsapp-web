import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WhatsAppBackend } from '../services/backend.js';

const WRITES = new Set(['send_message', 'send_media', 'request_pairing_code', 'logout']);
const requestSignal = new AsyncLocalStorage<AbortSignal>();
let running = 0;
const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Prevent a cancelled tool from starting another backend operation after an await. */
export function guardedBackend(backend: WhatsAppBackend): WhatsAppBackend {
  return new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        requestSignal.getStore()?.throwIfAborted();
        return value.apply(target, args);
      };
    },
  });
}

export function registerTool<S extends z.ZodRawShape>(
  server: McpServer, name: string, description: string, shape: S,
  callback: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  const readOnly = !WRITES.has(name);
  server.registerTool(name, {
    description, inputSchema: z.object(shape),
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
  }, async (args, context) => {
    if (context.mcpReq.signal.aborted) return failure('Request cancelled before execution.');
    if (running >= 32) return failure('Server is busy with 32 pending operations. Wait before retrying.');
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Request cancelled. A provider operation already in progress may still complete; check the chat before retrying a send.'));
    context.mcpReq.signal.addEventListener('abort', cancel, { once: true });
    const timeout = Number(process.env.MCP_TOOL_TIMEOUT_MS ?? 60_000);
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 300_000) {
      context.mcpReq.signal.removeEventListener('abort', cancel);
      return failure('MCP_TOOL_TIMEOUT_MS must be an integer from 100 to 300000.');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    running++;
    // Keep the slot until the provider actually settles, even after a timeout.
    const work = requestSignal.run(controller.signal, () => Promise.resolve().then(() => callback(args as z.infer<z.ZodObject<S>>)))
      .finally(() => { running--; });
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      timer = setTimeout(() => controller.abort(new Error('Operation timed out. An in-flight provider operation may still complete; check the chat before retrying a send.')), timeout);
    });
    try { return await Promise.race([work, interrupted]); }
    catch (error) { return failure(error instanceof Error ? error.message : 'Operation failed.'); }
    finally { clearTimeout(timer); context.mcpReq.signal.removeEventListener('abort', cancel); }
  });
}
