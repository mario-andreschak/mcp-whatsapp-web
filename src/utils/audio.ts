import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const bundled = require('ffmpeg-static') as string | null;
const executable = process.env.FFMPEG_PATH || (bundled && fs.existsSync(bundled) ? bundled : 'ffmpeg');
// web.js uses this variable for its own video/sticker conversion too.
if (executable !== 'ffmpeg') process.env.FFMPEG_PATH = executable;

export class AudioUtils {
  static async convertToOpusOgg(inputPath: string, outputPath?: string, bitrate = '32k', sampleRate = 24000): Promise<string> {
    if (!fs.existsSync(inputPath)) throw new Error('Input file not found: ' + inputPath);
    const stat = fs.statSync(inputPath);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Audio input must be a regular file of at most 64 MiB.');
    if (!/^[1-9][0-9]{0,2}k$/.test(bitrate) || ![8000, 12000, 16000, 24000, 48000].includes(sampleRate)) {
      throw new Error('Invalid Opus bitrate or sample rate.');
    }
    const output = outputPath ?? path.join(path.dirname(inputPath), path.parse(inputPath).name + '.ogg');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = path.join(path.dirname(output), '.wa-audio-' + randomUUID() + '.ogg');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
          '-i', path.resolve(inputPath), '-vn', '-c:a', 'libopus', '-b:a', bitrate,
          '-ar', String(sampleRate), '-ac', '1', '-application', 'voip', '-vbr', 'on',
          '-compression_level', '10', '-frame_duration', '60', '-avoid_negative_ts', 'make_zero', temporary],
          { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let errorText = '';
        let timedOut = false;
        child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-4096); });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => {
          clearTimeout(timer);
          if (timedOut) reject(new Error('Audio conversion timed out after 60 seconds.'));
          else if (code !== 0) reject(new Error('ffmpeg conversion failed: ' + errorText));
          else resolve();
        });
      });
      fs.renameSync(temporary, output);
      return output;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  static async convertToOpusOggTemp(inputPath: string, bitrate = '32k', sampleRate = 24000): Promise<string> {
    return this.convertToOpusOgg(inputPath, path.join(os.tmpdir(), 'whatsapp_audio_converted_' + randomUUID() + '.ogg'), bitrate, sampleRate);
  }
}
