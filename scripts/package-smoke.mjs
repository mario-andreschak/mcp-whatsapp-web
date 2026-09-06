import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { wireSmoke } from './wire-smoke.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'wa-package-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run via npm run test:package.');
function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
}
try {
  const pack = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory], process.cwd()))[0];
  assert.ok(pack.bundled.includes('whatsapp-web.js'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, name: 'wa-installed-smoke', version: '1.0.0' }));
  npm(['install', path.join(directory, pack.filename), '--omit=dev', '--no-fund', '--no-audit'], directory);
  const installed = path.join(directory, 'node_modules', 'mcp-whatsapp-web');
  const entry = path.join(installed, 'dist', 'index.js');
  const require = createRequire(entry);
  const webjsEntry = require.resolve('whatsapp-web.js');
  const browserRequire = createRequire(webjsEntry);
  const browserPackage = browserRequire('puppeteer/package.json');
  assert.ok(Number(browserPackage.version.split('.')[0]) >= 25, 'Installed web.js must use the patched bundled Puppeteer tree.');
  assert.throws(() => require.resolve('@modelcontextprotocol/sdk/server/mcp.js'), { code: 'MODULE_NOT_FOUND' });
  assert.equal(typeof browserRequire('whatsapp-web.js').Client, 'function');
  const bin = path.join(directory, 'node_modules', '.bin', process.platform === 'win32' ? 'mcp-whatsapp-web.cmd' : 'mcp-whatsapp-web');
  await readFile(bin);
  for (const backend of ['webjs', 'baileys']) for (const modern of [true, false]) await wireSmoke(entry, backend, modern);
  const { BaileysStore } = await import(pathToFileURL(path.join(installed, 'dist', 'services', 'baileys-store.js')).href);
  // Optional SQLite is a real installed native dependency, not just a mocked import.
  const store = new BaileysStore(path.join(directory, 'native-sqlite'));
  store.close();
  const { AudioUtils } = await import(pathToFileURL(path.join(installed, 'dist', 'utils', 'audio.js')).href);
  const wav = Buffer.alloc(44 + 3200);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(3200, 40);
  const input = path.join(directory, 'input.wav'); await writeFile(input, wav);
  const output = await AudioUtils.convertToOpusOgg(input, path.join(directory, 'output.ogg'));
  assert.equal((await readFile(output)).subarray(0, 4).toString(), 'OggS');
  if (process.env.RUN_BROWSER_TESTS === 'true') {
    const puppeteer = browserRequire('puppeteer');
    const browser = await puppeteer.launch({ headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
    try {
      const page = await browser.newPage();
      await page.setContent('<p id="probe">Installed browser driver</p>');
      assert.equal(await page.$eval('#probe', element => element.textContent), 'Installed browser driver');
    } finally { await browser.close(); }
  }
  const audit = JSON.parse(npm(['audit', '--omit=dev', '--json'], directory));
  assert.equal(audit.metadata.vulnerabilities.total, 0);
  console.log('production-only tarball passed; Puppeteer ' + browserPackage.version + '; audit 0; size ' + pack.size);
} finally {
  await rm(directory, { recursive: true, force: true });
}
