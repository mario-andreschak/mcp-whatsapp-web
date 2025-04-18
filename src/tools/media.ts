import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WhatsAppService } from '../services/whatsapp.js';
import { log } from '../utils/logger.js';
import { CallToolResult, ImageContent, AudioContent, TextContent } from '@modelcontextprotocol/sdk/types.js';

// Import the CommonJS module
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { MessageMedia } = require('whatsapp-web.js');

// Import types
import type WAWebJS from 'whatsapp-web.js';
// Using WAWebJS.Message directly instead of alias
import { AudioUtils } from '../utils/audio.js'; // To be created
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileTypeFromBuffer } from 'file-type'; // Need to install file-type

export function registerMediaTools(
  server: McpServer,
  whatsappService: WhatsAppService,
): void {
  log.info('Registering media tools...');

  // Combined tool for sending various media types
  server.tool(
    'send_media',
    'Send media (image, video, document, audio) via WhatsApp.',
    {
      recipient_jid: z.string().describe('The recipient JID (e.g., 123456789@c.us or 123456789-12345678@g.us)'),
      media_path: z.string().optional().describe('Absolute path to the local media file'),
      media_url: z.string().url().optional().describe('URL of the media file'),
      media_content: z.string().optional().describe('Base64 encoded media content'),
      mime_type: z.string().optional().describe('MIME type of the media_content (required if using media_content)'),
      filename: z.string().optional().describe('Filename for the media (recommended if using media_content)'),
      caption: z.string().optional().describe('Optional caption for the media'),
      as_audio_message: z.boolean().optional().default(false).describe('Send audio specifically as a voice note (requires ffmpeg for conversion if not opus/ogg)'),
      include_full_data: z.boolean().optional().default(false).describe('Whether to include the full base64 data in the response')
    },
    async ({
      recipient_jid,
      media_path,
      media_url,
      media_content,
      mime_type,
      filename,
      caption,
      as_audio_message,
      include_full_data = false,
    }): Promise<CallToolResult> => {
      let mediaInput: string | null = null;
      let inputType: 'path' | 'url' | 'base64' | null = null;

      if (media_path) {
        mediaInput = media_path;
        inputType = 'path';
      } else if (media_url) {
        mediaInput = media_url;
        inputType = 'url';
      } else if (media_content) {
        if (!mime_type) {
          return { content: [{ type: 'text', text: 'mime_type is required when using media_content' }], isError: true };
        }
        mediaInput = media_content;
        inputType = 'base64';
      }

      if (!mediaInput || !inputType) {
        return { content: [{ type: 'text', text: 'One of media_path, media_url, or media_content must be provided' }], isError: true };
      }

      try {
        let sentMessage: WAWebJS.Message;
        let finalMediaPath = media_path; // Keep track of the path used, especially for temp files

        if (as_audio_message) {
          // Handle sending as audio message (voice note)
          log.info(`Attempting to send audio message to ${recipient_jid}`);
          let audioPath = '';
          let tempFilePath: string | null = null;
          let needsCleanup = false;

          if (inputType === 'path') {
            audioPath = mediaInput;
          } else if (inputType === 'url') {
             return { content: [{ type: 'text', text: 'Sending audio message directly from URL is not yet supported. Download first.' }], isError: true };
             // TODO: Implement download from URL first if needed
          } else { // base64
            const buffer = Buffer.from(mediaInput, 'base64');
            const detectedType = await fileTypeFromBuffer(buffer);
            const ext = detectedType?.ext || 'bin'; // Fallback extension
            tempFilePath = path.join(os.tmpdir(), `whatsapp_audio_${Date.now()}.${ext}`);
            fs.writeFileSync(tempFilePath, buffer);
            audioPath = tempFilePath;
            needsCleanup = true;
            mime_type = detectedType?.mime || mime_type || 'application/octet-stream'; // Use detected type if available
            filename = filename || `audio.${ext}`;
          }

          if (!audioPath.endsWith('.ogg')) {
            log.info(`Audio file ${audioPath} is not ogg, attempting conversion...`);
            try {
              const convertedPath = await AudioUtils.convertToOpusOggTemp(audioPath);
              log.info(`Audio converted to ${convertedPath}`);
              // If original was temp, clean it up now
              if (needsCleanup && tempFilePath && fs.existsSync(tempFilePath)) {
                 fs.unlinkSync(tempFilePath);
              }
              tempFilePath = convertedPath; // Now the converted file is the temp file
              needsCleanup = true; // Mark the converted file for cleanup
              audioPath = convertedPath;
              finalMediaPath = audioPath; // Update final path
            } catch (conversionError: any) {
              log.warn(`Audio conversion failed: ${conversionError.message}. Sending as regular document/audio file.`);
              // Fallback: Send as regular media without 'ptt' flag
              const media = inputType === 'base64'
                ? new MessageMedia(mime_type!, mediaInput, filename)
                : (inputType === 'path' ? MessageMedia.fromFilePath(mediaInput) : await MessageMedia.fromUrl(mediaInput, { unsafeMime: true })); // Corrected logic: check path or assume URL
              sentMessage = await whatsappService.getClient().sendMessage(recipient_jid, media, { caption });
              // Cleanup temp file if created from base64
              if (needsCleanup && tempFilePath && fs.existsSync(tempFilePath)) {
                 fs.unlinkSync(tempFilePath);
              }
              // Return result for regular media sending
              const result = { success: true, message: 'Audio sent as regular file (conversion failed).', messageId: sentMessage.id._serialized };
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
          }

          // Send the (potentially converted) ogg file as a voice note
          const media = MessageMedia.fromFilePath(audioPath);
          sentMessage = await whatsappService.getClient().sendMessage(recipient_jid, media, { sendAudioAsVoice: true }); // Key option!

          // Cleanup temp file if created
          if (needsCleanup && tempFilePath && fs.existsSync(tempFilePath)) {
             fs.unlinkSync(tempFilePath);
          }

        } else {
          // Handle sending regular media (image, video, document)
          log.info(`Sending regular media to ${recipient_jid}`);
          // Determine finalMediaPath based on inputType
          if (inputType === 'path') {
            finalMediaPath = mediaInput;
          } else {
            finalMediaPath = undefined; // URL or base64 doesn't have a local path
          }
          // The sendMedia method in WhatsAppService handles the different input types (path/url)
          // For base64, we need to call a different service method
          if (inputType === 'base64') {
             sentMessage = await whatsappService.sendMediaFromBase64(recipient_jid, mediaInput, mime_type!, filename, caption);
          } else {
             sentMessage = await whatsappService.sendMedia(recipient_jid, mediaInput, caption);
          }
        }

        // Create result object with basic info
        const result: any = {
          success: true,
          message: `Media (${as_audio_message ? 'audio message' : 'file'}) sent successfully.`,
          messageId: sentMessage.id._serialized,
          timestamp: sentMessage.timestamp,
          filePathUsed: finalMediaPath // Include the path if a local file was ultimately sent
        };
        
        // If include_full_data is true, include the media content in the result
        if (include_full_data && mediaInput) {
          // For base64 input, we already have the data
          if (inputType === 'base64') {
            result.mediaData = media_content;
            result.mimeType = mime_type;
          } 
          // For path or URL, we need to get the data
          else if (inputType === 'path' && fs.existsSync(mediaInput)) {
            try {
              const buffer = fs.readFileSync(mediaInput);
              result.mediaData = buffer.toString('base64');
              
              // Try to determine mime type
              const detectedType = await fileTypeFromBuffer(buffer);
              result.mimeType = detectedType?.mime || 'application/octet-stream';
            } catch (err) {
              log.warn(`Could not read file for include_full_data: ${err}`);
            }
          }
          // For URL, we don't re-download it to include in the response
        }
        
        log.debug('Send media result', JSON.stringify(result));
        
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: any) {
        log.error(`Error in send_media tool to ${recipient_jid}:`, error);
        return {
          content: [{ type: 'text', text: `Error sending media to ${recipient_jid}: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'download_media',
    'Download media from a WhatsApp message and return its content.',
    {
      message_id: z.string().describe('The serialized ID of the message containing the media'),
      include_full_data: z.boolean().optional().default(false).describe('Whether to include the full base64 data in the response')
    },
    async ({ message_id, include_full_data = false }): Promise<CallToolResult> => {
      try {
        const media = await whatsappService.downloadMedia(message_id);
        if (!media) {
          return {
            content: [{ type: 'text', text: `Media not found or failed to download for message: ${message_id}` }],
            isError: true,
          };
        }

        // Extract metadata
        const metadata = {
          filename: media.filename || 'unknown',
          mimetype: media.mimetype,
          filesize: media.filesize || 'unknown'
        };
        
        log.debug('Media metadata', JSON.stringify(metadata));

        // Create a TextContent with metadata as the first item in the content array
        const metadataContent: TextContent = {
          type: 'text',
          text: JSON.stringify(metadata, null, 2)
        };
        
        // Prepare the array for the response content
        const contentArray: Array<TextContent | ImageContent | AudioContent> = [metadataContent];
        
        // If include_full_data is true, add a second content object with the actual media data
        if (include_full_data) {
          if (media.mimetype.startsWith('image/')) {
            // For images, add an ImageContent
            contentArray.push({
              type: 'image',
              data: media.data,
              mimeType: media.mimetype,
            } as unknown as TextContent); // Type assertion to satisfy TypeScript
          } else if (media.mimetype.startsWith('audio/')) {
            // For audio, add an AudioContent
            contentArray.push({
              type: 'audio',
              data: media.data,
              mimeType: media.mimetype,
            } as unknown as TextContent); // Type assertion to satisfy TypeScript
          } else {
            // For videos, documents, etc., add as TextContent
            contentArray.push({
              type: 'text',
              text: `Base64 Data: ${media.data}`
            });
          }
        }

        log.debug('Download media result', JSON.stringify({
          metadata,
          hasFullData: include_full_data,
          mediaType: media.mimetype
        }));

        return {
          content: contentArray,
        };
      } catch (error: any) {
        log.error(`Error in download_media tool for message ${message_id}:`, error);
        return {
          content: [{ type: 'text', text: `Error downloading media for message ${message_id}: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  log.info('Media tools registered.');
}
