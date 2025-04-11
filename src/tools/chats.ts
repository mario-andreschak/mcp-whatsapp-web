import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WhatsAppService } from '../services/whatsapp.js';
import { log } from '../utils/logger.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function registerChatTools(
  server: McpServer,
  whatsappService: WhatsAppService,
): void {
  log.info('Registering chat tools...');

  server.tool(
    'list_chats',
    'Get WhatsApp chats, optionally filtered and sorted.',
    {
      limit: z.number().int().positive().optional().default(20).describe('Maximum number of chats to return'),
      // Note: whatsapp-web.js doesn't directly support query filtering or pagination for getChats()
      // We fetch all and filter/paginate locally, or implement more complex logic if needed.
      // For simplicity, we'll just use limit here.
      include_last_message: z.boolean().optional().default(true).describe('Whether to include the last message details'),
      // Sorting is handled by whatsapp-web.js based on timestamp by default
    },
    async ({ limit, include_last_message }): Promise<CallToolResult> => {
      try {
        // whatsapp-web.js getChats() returns chats sorted by timestamp
        const chats = await whatsappService.listChats(limit, include_last_message);
        // Return the simplified chat structure
        return {
          content: [{ type: 'text', text: JSON.stringify(chats, null, 2) }],
        };
      } catch (error: any) {
        log.error('Error in list_chats tool:', error);
        return {
          content: [{ type: 'text', text: `Error listing chats: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_chat_by_id',
    'Get WhatsApp chat metadata by JID.',
    {
      jid: z.string().describe('The JID of the chat to retrieve (e.g., 123456789@c.us or 123456789-12345678@g.us)'),
      // include_last_message: z.boolean().optional().default(true) // whatsapp-web.js getChatById includes last message info
    },
    async ({ jid }): Promise<CallToolResult> => {
      try {
        const chat = await whatsappService.getChatById(jid);
        if (!chat) {
          return {
            content: [{ type: 'text', text: `Chat not found for JID: ${jid}` }],
            isError: true,
          };
        }
        // Return the simplified chat structure
        return {
          content: [{ type: 'text', text: JSON.stringify(chat, null, 2) }],
        };
      } catch (error: any) {
        log.error(`Error in get_chat_by_id tool for JID ${jid}:`, error);
        return {
          content: [{ type: 'text', text: `Error getting chat ${jid}: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // Note: get_direct_chat_by_contact and get_contact_chats might require iterating
  // through all chats or contacts, which can be inefficient with whatsapp-web.js.
  // Implementing simplified versions or indicating potential performance issues.

  server.tool(
    'get_direct_chat_by_contact_number',
    'Get direct WhatsApp chat JID by contact phone number (less reliable, use get_chat_by_id if JID is known).',
    {
      phone_number: z.string().describe('The phone number of the contact (e.g., 1234567890)'),
    },
    async ({ phone_number }): Promise<CallToolResult> => {
      try {
        // Construct potential JID
        const jid = `${phone_number}@c.us`;
        const chat = await whatsappService.getChatById(jid);
         if (!chat || chat.isGroup) { // Ensure it's a direct chat
          return {
            content: [{ type: 'text', text: `Direct chat not found for number: ${phone_number}` }],
            isError: true,
          };
        }
        return {
          // Return only the JID or the full chat object? Let's return the object.
          content: [{ type: 'text', text: JSON.stringify(chat, null, 2) }],
        };
      } catch (error: any) {
        log.error(`Error in get_direct_chat_by_contact_number tool for number ${phone_number}:`, error);
        // Don't expose detailed errors, just indicate not found
         return {
            content: [{ type: 'text', text: `Could not find direct chat for number: ${phone_number}` }],
            isError: true,
          };
      }
    },
  );

  // get_contact_chats is harder as whatsapp-web.js doesn't directly link chats to contacts easily.
  // A possible implementation would list all chats and filter by participants, but this is very inefficient.
  // We might omit this or provide a limited version based on known chats.
  // For now, let's omit it and potentially add later if feasible.

  log.info('Chat tools registered.');
}
