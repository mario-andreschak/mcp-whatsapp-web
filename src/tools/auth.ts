import { WhatsAppService } from '../services/whatsapp.js';
import qrcode from 'qrcode';
import { z } from 'zod';
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
    'request_pairing_code',
    'Request a pairing code as a text-based alternative to scanning the QR code. The user enters the returned 8-character code on their phone under Settings > Linked Devices > Link a device > "Link with phone number instead".',
    {
      phone_number: z
        .string()
        .describe(
          'The WhatsApp phone number to link, in international symbol-free format (e.g. 4915112345678 for Germany, 12025550108 for US)',
        ),
    },
    async ({ phone_number }): Promise<CallToolResult> => {
      return await requestPairingCode(whatsappService, phone_number);
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
 * Tool to request a pairing code for phone-number-based authentication
 * @param whatsappService The WhatsApp service instance
 * @param phoneNumber The phone number to link, international symbol-free format
 * @returns A promise that resolves to the tool result containing the pairing code
 */
async function requestPairingCode(
  whatsappService: WhatsAppService,
  phoneNumber: string
): Promise<CallToolResult> {
  try {
    if (whatsappService.isAuthenticated()) {
      return {
        content: [
          {
            type: 'text',
            text: 'You are already authenticated with WhatsApp. No pairing code is needed.'
          }
        ],
        isError: false
      };
    }

    const code = await whatsappService.requestPairingCode(phoneNumber);

    log.info('Pairing code generated successfully');

    return {
      content: [
        {
          type: 'text',
          text:
            `Pairing code: ${code}\n\n` +
            'Enter this code on the phone with the WhatsApp account:\n' +
            'Settings > Linked Devices > Link a device > "Link with phone number instead".\n' +
            'The code expires after a few minutes; request a new one if it does. ' +
            'Use check_auth_status to verify the connection afterwards.'
        }
      ],
      isError: false
    };
  } catch (error) {
    log.error('Error requesting pairing code:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error requesting pairing code: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    };
  }
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
    const pairingCode = whatsappService.getLatestPairingCode();

    log.info(`Authentication status checked: ${isAuthenticated ? 'authenticated' : 'not authenticated'}`);

    let text: string;
    if (isAuthenticated) {
      text = 'You are currently authenticated with WhatsApp and ready to use all features.';
    } else if (pairingCode) {
      text =
        `You are not currently authenticated with WhatsApp. An active pairing code is available: ${pairingCode}\n` +
        'Enter it on the phone under Settings > Linked Devices > Link a device > "Link with phone number instead". ' +
        'A fresh code is generated every ~3 minutes.';
    } else {
      text =
        'You are not currently authenticated with WhatsApp. Please use the get_qr_code tool (or request_pairing_code) to authenticate.';
    }

    return {
      content: [{ type: 'text', text }],
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
