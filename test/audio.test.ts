import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AudioUtils } from '../src/utils/audio.js';

/**
 * Real conversion test through the ffmpeg binary bundled by ffmpeg-static.
 * Synthesizes a tiny valid WAV (0.2s of a sine tone) and converts it.
 */
function makeWavFile(): string {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * 0.2);
  const dataSize = samples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 12000), 44 + i * 2);
  }
  const file = path.join(os.tmpdir(), `audio-test-${Date.now()}.wav`);
  fs.writeFileSync(file, buffer);
  return file;
}

const tempFiles: string[] = [];
afterAll(() => {
  for (const file of tempFiles) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
});

describe('AudioUtils', () => {
  it('converts a WAV file to Opus in an Ogg container', async () => {
    const wav = makeWavFile();
    tempFiles.push(wav);
    const converted = await AudioUtils.convertToOpusOggTemp(wav);
    tempFiles.push(converted);

    expect(fs.existsSync(converted)).toBe(true);
    const header = fs.readFileSync(converted).subarray(0, 4).toString('ascii');
    expect(header).toBe('OggS');
  }, 30_000);

  it('rejects when the input file does not exist', async () => {
    await expect(AudioUtils.convertToOpusOgg('C:\\does\\not\\exist.wav')).rejects.toThrow(/not found/i);
  });
});
