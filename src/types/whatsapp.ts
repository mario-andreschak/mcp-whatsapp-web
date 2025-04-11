// Re-exporting simplified types defined in WhatsAppService for clarity
// Or define more complex/specific types here if needed.

export type {
  SimpleChat,
  SimpleContact,
  SimpleMessage,
} from '../services/whatsapp.js';

// You could add more specific types here, for example:
export interface MediaDownloadResult {
  success: boolean;
  message: string;
  mimeType?: string;
  base64Data?: string;
  filename?: string;
  tempPath?: string; // If saving to temp file instead of returning base64
}

export interface SendMediaResult {
    success: boolean;
    message: string;
    messageId?: string;
    timestamp?: number;
    filePathUsed?: string | undefined; // Path if local file was sent
}

// Add any other WhatsApp-specific types required by your tools or services.
