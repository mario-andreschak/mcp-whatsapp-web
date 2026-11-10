import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import '../utils/audio.js'; // resolves the bundled ffmpeg binary
import type { SimpleMessage, WhatsAppBackend } from './backend.js';
import { log } from '../utils/logger.js';

/**
 * Voice notes to text through a speech-to-text command the operator chooses.
 *
 * The server stays engine-neutral: WHATSAPP_TRANSCRIBE_COMMAND is run once per batch with the
 * paths of 16 kHz mono WAV files appended. It prints one JSON object per line,
 * {"file": "<path>", "text": "..."}; a single file may also be answered with plain text.
 * Whatever the command does with the audio is the operator's decision; a local engine keeps
 * voice notes on the machine. Transcripts are kept beside the chat history when the backend
 * stores one (Baileys), otherwise for the life of the process.
 */

export const VOICE_TYPES = new Set(['ptt', 'audio']);
export const NOT_CONFIGURED = 'Voice-note transcription is not configured. Set WHATSAPP_TRANSCRIBE_COMMAND to a local '
  + 'speech-to-text command (see README, "Voice notes").';

export interface TranscriptResult {
  message_id: string;
  text?: string;
  error?: string;
  cached?: boolean;
}

export type RunCommand = (command: string, files: string[]) => Promise<Map<string, string>>;
export type ConvertAudio = (input: string, output: string) => Promise<void>;

export function transcriptionCommand(): string | undefined {
  return process.env.WHATSAPP_TRANSCRIBE_COMMAND?.trim() || undefined;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class VoiceTranscriber {
  private readonly memory = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: WhatsAppBackend,
    private readonly runCommand: RunCommand = runTranscribeCommand,
    private readonly convert: ConvertAudio = toWav,
  ) {}

  get configured(): boolean {
    return !!transcriptionCommand();
  }

  stored(id: string): string | undefined {
    try {
      return this.backend.getVoiceTranscript?.(id) ?? this.memory.get(id);
    } catch {
      return this.memory.get(id);
    }
  }

  /** One engine run at a time: speech models are heavy and usually share one GPU. */
  transcribe(ids: string[]): Promise<TranscriptResult[]> {
    const run = this.queue.then(() => this.transcribeNow(ids));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Adds stored transcripts to voice notes; with `transcribeMissing`, transcribes the rest first. */
  async annotate(messages: SimpleMessage[], transcribeMissing: boolean): Promise<SimpleMessage[]> {
    const voice = messages.filter(message => VOICE_TYPES.has(message.type));
    if (!voice.length) return messages;
    const errors = new Map<string, string>();
    if (transcribeMissing) {
      if (!this.configured) throw new Error(NOT_CONFIGURED);
      const missing = voice.filter(message => this.stored(message.id) === undefined).map(message => message.id);
      if (missing.length) {
        try {
          for (const result of await this.transcribe(missing)) if (result.error) errors.set(result.message_id, result.error);
        } catch (error) {
          // The messages are still worth returning when the speech engine fails.
          log.error('Voice-note transcription failed:', error);
          for (const id of missing) errors.set(id, errorText(error));
        }
      }
    }
    return messages.map(message => {
      if (!VOICE_TYPES.has(message.type)) return message;
      const text = this.stored(message.id);
      if (text !== undefined) return { ...message, transcript: text };
      const error = errors.get(message.id);
      return error ? { ...message, transcriptError: error } : message;
    });
  }

  private async transcribeNow(ids: string[]): Promise<TranscriptResult[]> {
    const command = transcriptionCommand();
    if (!command) throw new Error(NOT_CONFIGURED);
    const unique = [...new Set(ids)];
    const results = new Map<string, TranscriptResult>();
    const pending: { id: string; wav: string }[] = [];
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-voice-'));
    try {
      for (const [index, id] of unique.entries()) {
        const stored = this.stored(id);
        if (stored !== undefined) {
          results.set(id, { message_id: id, text: stored, cached: true });
          continue;
        }
        try {
          const media = await this.backend.downloadMedia(id);
          if (!media) throw new Error('Voice note not found or no longer downloadable');
          if (!media.mimetype.startsWith('audio/')) throw new Error(`Not a voice note (${media.mimetype})`);
          const source = path.join(directory, `${index}.audio`);
          const wav = path.join(directory, `${index}.wav`);
          await fs.writeFile(source, Buffer.from(media.data, 'base64'));
          await this.convert(source, wav);
          pending.push({ id, wav });
        } catch (error) {
          results.set(id, { message_id: id, error: errorText(error) });
        }
      }
      if (pending.length) {
        const texts = await this.runCommand(command, pending.map(item => item.wav));
        for (const { id, wav } of pending) {
          const text = texts.get(path.resolve(wav));
          if (text === undefined) {
            results.set(id, { message_id: id, error: 'The transcription command returned no text for this voice note' });
            continue;
          }
          this.memory.set(id, text);
          try { this.backend.saveVoiceTranscript?.(id, text); } catch (error) { log.warn('Could not store a transcript:', error); }
          results.set(id, { message_id: id, text });
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(error => log.warn('Could not remove temporary voice notes:', error));
    }
    return unique.map(id => results.get(id)!);
  }
}

/** One transcriber per backend, so every MCP session shares the queue and the cache. */
const transcribers = new WeakMap<WhatsAppBackend, VoiceTranscriber>();
export function transcriberFor(backend: WhatsAppBackend): VoiceTranscriber {
  let transcriber = transcribers.get(backend);
  if (!transcriber) transcribers.set(backend, (transcriber = new VoiceTranscriber(backend)));
  return transcriber;
}

/** Reads `{"file","text"}` lines; plain output counts as the text of a single file. */
export function parseTranscripts(stdout: string, files: string[]): Map<string, string> {
  const wanted = new Map(files.map(file => [path.resolve(file).toLowerCase(), path.resolve(file)]));
  const texts = new Map<string, string>();
  let structured = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const entry = JSON.parse(line) as { file?: unknown; text?: unknown };
      if (typeof entry.file !== 'string' || typeof entry.text !== 'string') continue;
      structured = true;
      const file = wanted.get(path.resolve(entry.file).toLowerCase());
      if (file) texts.set(file, entry.text.trim());
    } catch { /* not a result line */ }
  }
  if (!structured && files.length === 1 && stdout.trim()) texts.set(path.resolve(files[0]), stdout.trim());
  return texts;
}

export function runTranscribeCommand(command: string, files: string[]): Promise<Map<string, string>> {
  const timeoutMs = Number(process.env.WHATSAPP_TRANSCRIBE_TIMEOUT_MS || 15 * 60_000);
  return new Promise((resolve, reject) => {
    const child = spawn(`${command} ${files.map(file => `"${file}"`).join(' ')}`, { shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Transcription took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Transcription command failed (exit ${code}): ${stderr.trim().split(/\r?\n/).slice(-3).join(' ')}`));
        return;
      }
      if (stderr.trim()) log.debug('Transcription command stderr:', stderr.trim());
      resolve(parseTranscripts(stdout, files));
    });
  });
}

function toWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .format('wav')
      .output(output)
      .on('end', () => resolve())
      .on('error', (error: Error) => reject(new Error(`Could not convert the voice note: ${error.message}`)))
      .run();
  });
}
