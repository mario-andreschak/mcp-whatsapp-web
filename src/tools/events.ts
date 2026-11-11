import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { WhatsAppBackend } from '../services/backend.js';
import { EventRequestError, eventArgumentsSchema, type MessageEvents } from '../services/events.js';

const listRequest = z.object({ method: z.literal('events/list'), params: z.object({}).passthrough().optional() });
const subscribeRequest = z.object({
  method: z.literal('events/subscribe'),
  params: z.object({
    name: z.string(),
    arguments: eventArgumentsSchema.optional(),
    delivery: z.object({ mode: z.literal('webhook'), url: z.string(), secret: z.string() }),
    cursor: z.string().nullable().optional(),
    maxAgeMs: z.number().optional(),
    ttlMs: z.number().positive().nullable().optional(),
  }).passthrough(),
});
const unsubscribeRequest = z.object({
  method: z.literal('events/unsubscribe'),
  params: z.object({
    name: z.string(),
    arguments: eventArgumentsSchema.optional(),
    delivery: z.object({ url: z.string() }).passthrough(),
  }).passthrough(),
});

/** Whether this backend can offer events, and so whether to declare the capability. */
export function supportsEvents(backend: WhatsAppBackend): boolean {
  return typeof backend.messageEvents === 'function';
}

/**
 * Registered as protocol methods rather than tools, so no model can create a subscription.
 * See services/events.ts.
 */
export function registerEventHandlers(server: McpServer, backend: WhatsAppBackend): void {
  if (!supportsEvents(backend)) return;
  const run = async <T>(operation: (events: MessageEvents) => T): Promise<T> => {
    try {
      return operation(await backend.messageEvents!());
    } catch (error) {
      if (error instanceof EventRequestError) throw new McpError(error.code, error.message);
      throw error;
    }
  };
  server.server.setRequestHandler(listRequest, () => run(events => events.list()));
  server.server.setRequestHandler(subscribeRequest, request => run(events => events.subscribe(request.params)));
  server.server.setRequestHandler(unsubscribeRequest, request => run(events => events.unsubscribe(request.params)));
}
