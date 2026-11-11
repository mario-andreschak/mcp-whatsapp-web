import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { WhatsAppBackend } from '../services/backend.js';
import { log } from '../utils/logger.js';

export function registerCallTools(server: McpServer, backend: WhatsAppBackend): void {
  server.tool(
    'reject_call',
    'Decline an incoming WhatsApp call that is ringing right now. Takes the callId from a call.received event. Fails if the call already stopped ringing. Baileys backend only.',
    {
      call_id: z.string().min(1).max(200).describe('The callId of the ringing call, from the call.received event'),
    },
    async ({ call_id }): Promise<CallToolResult> => {
      if (typeof backend.rejectCall !== 'function') {
        return {
          content: [{ type: 'text', text: 'Declining calls needs the Baileys backend (WHATSAPP_BACKEND=baileys).' }],
          isError: true,
        };
      }
      try {
        await backend.rejectCall(call_id);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, callId: call_id, message: 'Call declined.' }, null, 2) }] };
      } catch (error) {
        log.error(`Error in reject_call tool for call ${call_id}:`, error);
        return {
          content: [{ type: 'text', text: `Could not decline call ${call_id}: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
