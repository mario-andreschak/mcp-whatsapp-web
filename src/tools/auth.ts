import { WhatsAppService } from '../services/whatsapp.js';
import qrcode from 'qrcode';
import { log } from '../utils/logger.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Register authentication-related tools with the MCP server
 * @param server The MCP server instance
 * @param whatsappService The WhatsApp service instance
 */
export function registerAuthTools(
  server: McpServer,
  whatsappService: WhatsAppService,
): void {
  log.info('Registering authentication tools...');

  server.tool(
    'get_qr_code',
    'Get the latest WhatsApp QR code as an image for authentication',
    {},
    async (): Promise<CallToolResult> => {
      return await getQrCodeImage(whatsappService);
    }
  );

  log.info('Authentication tools registered.');
}

/**
 * Tool to get the latest WhatsApp QR code as an image
 * @param whatsappService The WhatsApp service instance
 * @returns A promise that resolves to the tool result containing the QR code image
 */
async function getQrCodeImage(
  whatsappService: WhatsAppService
): Promise<CallToolResult> {
  try {
    const qrString = whatsappService.getLatestQrCode();
    
    if (!qrString) {
      log.info('No QR code available yet');
      return {
        content: [
          {
            type: 'text',
            text: 'No QR code is currently available. Please initialize the WhatsApp client first.'
          }
        ],
        isError: false
      };
    }
    
    // Generate QR code as data URL
    const qrDataUrl = await qrcode.toDataURL(qrString);
    
    // Extract the base64 data from the data URL
    // Data URL format: data:image/png;base64,BASE64_DATA
    const base64Data = qrDataUrl.split(',')[1];
    
    log.info('QR code image generated successfully');
    
    return {
      content: [
        {
          type: 'image',
          data: base64Data,
          mimeType: 'image/png'
        }
      ],
      isError: false
    };
  } catch (error) {
    log.error('Error generating QR code image:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error generating QR code: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    };
  }
}
