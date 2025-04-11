import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WhatsAppService } from '../services/whatsapp.js';
import { log } from '../utils/logger.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function registerContactTools(
  server: McpServer,
  whatsappService: WhatsAppService,
): void {
  log.info('Registering contact tools...');

  server.tool(
    'search_contacts',
    'Search WhatsApp contacts by name or phone number.',
    {
      query: z.string().describe('Search term to match against contact names or phone numbers'),
    },
    async ({ query }): Promise<CallToolResult> => {
      try {
        const contacts = await whatsappService.searchContacts(query);
        // Map contacts to a simpler structure if needed, or return the full structure
        const simplifiedContacts = contacts.map(c => ({
            id: c.id,
            name: c.name,
            number: c.number,
            pushname: c.pushname,
            isMyContact: c.isMyContact,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(simplifiedContacts, null, 2) }],
        };
      } catch (error: any) {
        log.error('Error in search_contacts tool:', error);
        return {
          content: [{ type: 'text', text: `Error searching contacts: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_contact_by_id',
    'Get contact details by JID.',
     {
      jid: z.string().describe('The JID of the contact to retrieve (e.g., 123456789@c.us)'),
    },
    async ({ jid }): Promise<CallToolResult> => {
        try {
            const contact = await whatsappService.getContactById(jid);
            if (!contact) {
                 return {
                    content: [{ type: 'text', text: `Contact not found for JID: ${jid}` }],
                    isError: true, // Indicate not found as an error for the tool
                };
            }
            // Return relevant contact details
            const contactDetails = {
                id: contact.id,
                name: contact.name,
                number: contact.number,
                pushname: contact.pushname,
                isMyContact: contact.isMyContact,
                isWAContact: contact.isWAContact,
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(contactDetails, null, 2) }],
            };
        } catch (error: any) {
            log.error(`Error in get_contact_by_id tool for JID ${jid}:`, error);
            return {
                content: [{ type: 'text', text: `Error getting contact ${jid}: ${error.message}` }],
                isError: true,
            };
        }
    }
  );

  // Add other contact-related tools if needed (e.g., get_profile_pic)

  log.info('Contact tools registered.');
}
