import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { SimpleMessage, WhatsAppBackend } from '../src/services/backend.js';
import { NOT_CONFIGURED, VoiceTranscriber, parseTranscripts } from '../src/services/transcriber.js';

vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const voice = (id: string): SimpleMessage => ({ id, body: '', from: 'a', to: 'b', timestamp: 1, fromMe: false, hasMedia: true, type: 'ptt' });
const text = (id: string): SimpleMessage => ({ ...voice(id), hasMedia: false, type: 'chat', body: 'hi' });

function fakeBackend() {
  const stored = new Map<string, string>();
  const backend = {
    downloadMedia: vi.fn(async (id: string) => id.startsWith('img')
      ? { mimetype: 'image/jpeg', data: 'AA==' }
      : { mimetype: 'audio/ogg; codecs=opus', data: Buffer.from(`audio ${id}`).toString('base64') }),
    getVoiceTranscript: vi.fn((id: string) => stored.get(id)),
    saveVoiceTranscript: vi.fn((id: string, value: string) => { stored.set(id, value); }),
  };
  return { backend: backend as unknown as WhatsAppBackend, mocks: backend, stored };
}

const convert = vi.fn(async () => {});
const echo = vi.fn(async (_command: string, files: string[]) => new Map(files.map(file => [path.resolve(file), `text of ${path.basename(file)}`])));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('parseTranscripts', () => {
  it('reads JSON result lines and ignores other output', () => {
    const files = ['C:/tmp/0.wav', 'C:/tmp/1.wav'];
    const out = ['loading model…', JSON.stringify({ file: 'c:/TMP/0.wav', text: ' Hallo ' }), '{"file":"elsewhere.wav","text":"x"}',
      JSON.stringify({ file: 'C:/tmp/1.wav', text: 'Tschüss' })].join('\n');
    const texts = parseTranscripts(out, files);
    expect(texts.get(path.resolve(files[0]))).toBe('Hallo');
    expect(texts.get(path.resolve(files[1]))).toBe('Tschüss');
    expect(texts.size).toBe(2);
  });

  it('accepts plain text for a single file only', () => {
    expect(parseTranscripts('just words\n', ['a.wav']).get(path.resolve('a.wav'))).toBe('just words');
    expect(parseTranscripts('just words\n', ['a.wav', 'b.wav']).size).toBe(0);
  });
});

describe('VoiceTranscriber', () => {
  it('transcribes voice notes once, stores them and reports what is not audio', async () => {
    vi.stubEnv('WHATSAPP_TRANSCRIBE_COMMAND', 'stt');
    const { backend, mocks } = fakeBackend();
    const transcriber = new VoiceTranscriber(backend, echo, convert);
    const first = await transcriber.transcribe(['v1', 'img1', 'v2', 'v1']);
    expect(first.map(result => result.message_id)).toEqual(['v1', 'img1', 'v2']);
    expect(first[0].text).toBe('text of 0.wav');
    expect(first[1].error).toContain('Not a voice note');
    expect(echo).toHaveBeenCalledTimes(1);
    expect(mocks.saveVoiceTranscript).toHaveBeenCalledWith('v2', 'text of 2.wav');

    const again = await transcriber.transcribe(['v1']);
    expect(again[0]).toMatchObject({ text: 'text of 0.wav', cached: true });
    expect(echo).toHaveBeenCalledTimes(1);
  });

  it('adds stored transcripts to messages and keeps messages when the engine fails', async () => {
    vi.stubEnv('WHATSAPP_TRANSCRIBE_COMMAND', 'stt');
    const { backend, stored } = fakeBackend();
    stored.set('v1', 'already known');
    const failing = vi.fn(async () => { throw new Error('engine crashed'); });
    const transcriber = new VoiceTranscriber(backend, failing, convert);

    const plain = await transcriber.annotate([text('t1'), voice('v1'), voice('v2')], false);
    expect(plain.map(message => message.transcript)).toEqual([undefined, 'already known', undefined]);
    expect(failing).not.toHaveBeenCalled();

    const tried = await transcriber.annotate([voice('v1'), voice('v2')], true);
    expect(tried[0].transcript).toBe('already known');
    expect(tried[1].transcriptError).toBe('engine crashed');
  });

  it('explains how to configure transcription when no command is set', async () => {
    vi.stubEnv('WHATSAPP_TRANSCRIBE_COMMAND', '');
    const transcriber = new VoiceTranscriber(fakeBackend().backend, echo, convert);
    expect(transcriber.configured).toBe(false);
    await expect(transcriber.annotate([voice('v1')], true)).rejects.toThrow(NOT_CONFIGURED);
    expect(await transcriber.annotate([text('t1')], true)).toHaveLength(1);
  });
});
