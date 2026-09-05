import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WhatsAppBackend, SentMessage } from '../services/backend.js';
import { log } from '../utils/logger.js';
import type { CallToolResult, ImageContent, AudioContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { AudioUtils } from '../utils/audio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileTypeFromBuffer } from 'file-type';

const failure = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }], isError: true,
});

export function registerMediaTools(server: McpServer, whatsappService: WhatsAppBackend): void {
  server.tool(
    'send_media',
    'Send media (image, video, document, audio) via WhatsApp.',
    {
      recipient_jid: z.string().describe('Recipient JID returned by a contact/chat tool; legacy @c.us phone JIDs are also accepted'),
      media_path: z.string().optional().describe('Absolute path to the local media file'),
      media_url: z.string().url().optional().describe('URL of the media file'),
      media_content: z.string().optional().describe('Base64 encoded media content'),
      mime_type: z.string().optional().describe('MIME type (required with media_content)'),
      filename: z.string().optional().describe('Filename for base64 media'),
      caption: z.string().optional().describe('Optional caption for the media'),
      as_audio_message: z.boolean().optional().default(false).describe('Convert audio to Opus/Ogg and send a voice note; supports local files and base64'),
      include_full_data: z.boolean().optional().default(false).describe('Include the input base64 data in the response'),
    },
    async ({ recipient_jid, media_path, media_url, media_content, mime_type, filename, caption, as_audio_message, include_full_data }): Promise<CallToolResult> => {
      if ([media_path, media_url, media_content].filter(Boolean).length !== 1) {
        return failure('Provide exactly one of media_path, media_url, or media_content.');
      }
      if (media_content && !mime_type) return failure('mime_type is required when using media_content');
      if (as_audio_message && media_url) {
        return failure('Download the audio URL to a local file first, then use media_path to send a voice note.');
      }

      let tempDirectory: string | undefined;
      let convertedPath: string | undefined;
      try {
        await whatsappService.ensureReady();
        let sentMessage: SentMessage;
        if (as_audio_message) {
          let audioPath = media_path;
          if (!audioPath) {
            tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-audio-'));
            const buffer = Buffer.from(media_content!, 'base64');
            const detected = await fileTypeFromBuffer(buffer);
            audioPath = path.join(tempDirectory, `input.${detected?.ext || 'bin'}`);
            await fs.writeFile(audioPath, buffer);
          }
          // An .ogg extension alone does not guarantee the Opus codec.
          convertedPath = await AudioUtils.convertToOpusOggTemp(audioPath);
          sentMessage = await whatsappService.sendVoiceNote(recipient_jid, convertedPath);
        } else if (media_content) {
          sentMessage = await whatsappService.sendMediaFromBase64(recipient_jid, media_content, mime_type!, filename, caption);
        } else {
          sentMessage = await whatsappService.sendMedia(recipient_jid, (media_path || media_url)!, caption);
        }

        const result: Record<string, unknown> = {
          success: true,
          message: `Media (${as_audio_message ? 'audio message' : 'file'}) sent successfully.`,
          messageId: sentMessage.id,
          timestamp: sentMessage.timestamp,
          filePathUsed: media_path,
        };
        if (include_full_data) {
          if (media_content) {
            result.mediaData = media_content;
            result.mimeType = mime_type;
          } else if (media_path) {
            // Sending already succeeded; an optional read failure must not invite a duplicate send.
            try {
              const buffer = await fs.readFile(media_path);
              result.mediaData = buffer.toString('base64');
              result.mimeType = (await fileTypeFromBuffer(buffer))?.mime || 'application/octet-stream';
            } catch (error) {
              log.warn('Could not read media for include_full_data:', error);
            }
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        log.error('Error sending media:', error);
        return failure(`Error sending media: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // Only paths created by this invocation are removed; the input file stays intact.
        if (convertedPath) {
          await fs.unlink(convertedPath).catch((error: unknown) => log.warn('Could not remove converted audio:', error));
        }
        if (tempDirectory) {
          await fs.rm(tempDirectory, { recursive: true, force: true }).catch((error: unknown) => log.warn('Could not remove temporary audio:', error));
        }
      }
    },
  );

  server.tool(
    'download_media',
    'Download media from a WhatsApp message and return its content.',
    {
      message_id: z.string().describe('Opaque message ID returned by a message tool'),
      include_full_data: z.boolean().optional().default(false).describe('Include the full base64 data in the response'),
    },
    async ({ message_id, include_full_data }): Promise<CallToolResult> => {
      try {
        const media = await whatsappService.downloadMedia(message_id);
        if (!media) return failure(`Media not found or unavailable for message: ${message_id}`);
        const content: Array<TextContent | ImageContent | AudioContent> = [{
          type: 'text',
          text: JSON.stringify({
            filename: media.filename || 'unknown',
            mimetype: media.mimetype,
            filesize: media.filesize ?? Buffer.byteLength(media.data, 'base64'),
          }, null, 2),
        }];
        if (include_full_data) {
          if (media.mimetype.startsWith('image/')) {
            content.push({ type: 'image', data: media.data, mimeType: media.mimetype });
          } else if (media.mimetype.startsWith('audio/')) {
            content.push({ type: 'audio', data: media.data, mimeType: media.mimetype });
          } else {
            content.push({ type: 'text', text: `Base64 Data: ${media.data}` });
          }
        }
        return { content };
      } catch (error) {
        log.error('Error downloading media:', error);
        return failure(`Error downloading media: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
