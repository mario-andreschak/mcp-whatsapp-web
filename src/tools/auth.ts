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

  server.tool(
    'check_auth_status',
    'Check if the WhatsApp client is authenticated and connected',
    {},
    async (): Promise<CallToolResult> => {
      return await checkAuthStatus(whatsappService);
    }
  );

  server.tool(
    'logout',
    'Logout from WhatsApp and clear the current session',
    {},
    async (): Promise<CallToolResult> => {
      return await logoutFromWhatsApp(whatsappService);
    }
  );

  log.info('Authentication tools registered.');
}

/**
 * Tool to logout from WhatsApp
 * @param whatsappService The WhatsApp service instance
 * @returns A promise that resolves to the tool result containing the logout status
 */
async function logoutFromWhatsApp(
  whatsappService: WhatsAppService
): Promise<CallToolResult> {
  try {
    if (!whatsappService.isAuthenticated()) {
      log.info('Logout requested but client is not authenticated');
      return {
        content: [
          {
            type: 'text',
            text: 'You are not currently authenticated with WhatsApp, so there is no need to logout.'
          }
        ],
        isError: false
      };
    }

    await whatsappService.logout();
    
    // After logout, we need to reinitialize to get a new QR code
    await whatsappService.initialize();
    
    log.info('Successfully logged out and reinitialized WhatsApp client');
    
    return {
      content: [
        {
          type: 'text',
          text: 'Successfully logged out of WhatsApp. You can now use the get_qr_code tool to authenticate with a new session.'
        }
      ],
      isError: false
    };
  } catch (error) {
    log.error('Error logging out from WhatsApp:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error logging out: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    };
  }
}

/**
 * Tool to check the authentication status of the WhatsApp client
 * @param whatsappService The WhatsApp service instance
 * @returns A promise that resolves to the tool result containing the authentication status
 */
async function checkAuthStatus(
  whatsappService: WhatsAppService
): Promise<CallToolResult> {
  try {
    const isAuthenticated = whatsappService.isAuthenticated();
    
    log.info(`Authentication status checked: ${isAuthenticated ? 'authenticated' : 'not authenticated'}`);
    
    return {
      content: [
        {
          type: 'text',
          text: isAuthenticated 
            ? 'You are currently authenticated with WhatsApp and ready to use all features.' 
            : 'You are not currently authenticated with WhatsApp. Please use the get_qr_code tool to authenticate.'
        }
      ],
      isError: false
    };
  } catch (error) {
    log.error('Error checking authentication status:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error checking authentication status: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    };
  }
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
    
    // Check if the client is already authenticated
    if (whatsappService.isAuthenticated()) {
      log.info('Client is already authenticated, no QR code needed');
      return {
        content: [
          {
            type: 'text',
            text: 'You are already authenticated with WhatsApp. No QR code is needed.'
          }
        ],
        isError: false
      };
    } else if (!qrString) {
      log.info('No QR code available yet, client may be initializing');
      return {
        content: [
          {
            type: 'text',
            text: 'No QR code is currently available. The WhatsApp client may still be initializing. Please try again in a few seconds.'
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
