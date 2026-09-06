import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function wireSmoke(entry, backend, modern) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wa-wire-'));
  const child = spawn(process.execPath, [path.resolve(entry), '--no-connect'], { cwd: directory,
    env: { ...process.env, WHATSAPP_BACKEND: backend, MCP_AUTO_CONNECT: 'false', MCP_HTTP_PORT: '0',
      TRANSPORT: 'stdio', WHATSAPP_SESSION_DIR: path.join(directory, 'webjs'),
      BAILEYS_SESSION_DIR: path.join(directory, 'baileys'), LOG_LEVEL: 'error' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '', stderr = '';
  const responses = new Map();
  const invalid = [];
  let stopped = false;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { stopped = true; resolve({ code, signal }); }));
  child.stdout.on('data', chunk => {
    out += chunk.toString();
    while (out.includes('\n')) {
      const end = out.indexOf('\n'), line = out.slice(0, end).trim(); out = out.slice(end + 1);
      if (!line) continue;
      try { const message = JSON.parse(line); if (message.id !== undefined) responses.set(message.id, message); }
      catch { invalid.push(line); }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32000); });
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'package-wire', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {} };
  let id = 0;
  async function rpc(method, params = {}) {
    const key = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params: { ...params, ...(modern ? { _meta: meta } : {}) } }) + '\n');
    const deadline = Date.now() + 20000;
    while (!responses.has(key)) {
      if (stopped || Date.now() > deadline) throw new Error('No wire response for ' + method + ': ' + stderr);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const message = responses.get(key);
    assert.equal(message.error, undefined, JSON.stringify(message));
    return message.result;
  }
  try {
    if (modern) {
      const discovered = await rpc('server/discover');
      assert.equal(discovered._meta['io.modelcontextprotocol/serverInfo'].name, 'mcp-whatsapp-web');
      assert.equal(discovered.capabilities.logging, undefined);
    } else {
      const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-package-wire', version: '1' } });
      assert.equal(initialized.serverInfo.name, 'mcp-whatsapp-web');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    }
    const tools = (await rpc('tools/list')).tools;
    assert.ok(tools.some(tool => tool.name === 'send_media'));
    assert.equal(tools.find(tool => tool.name === 'send_message').annotations.readOnlyHint, false);
    const pong = await rpc('tools/call', { name: 'ping', arguments: {} });
    if (modern) assert.equal(pong.resultType, 'complete');
    assert.equal(pong.content[0].text, 'pong');
    const status = await rpc('tools/call', { name: 'get_backend_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).backend, backend);
    assert.equal(JSON.parse(status.content[0].text).authenticated, false);
    child.stdin.end();
    const end = await Promise.race([exit, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('stdin EOF did not stop process: ' + stderr)), 12000);
      exit.then(() => clearTimeout(timer));
    })]);
    assert.equal(end.code, 0);
    assert.deepEqual(invalid, [], 'stdout must contain JSON-RPC only');
    assert.equal(out.trim(), '');
    console.log('wire passed: ' + backend + ', ' + (modern ? '2026-07-28' : 'legacy') + ', no-connect, EOF');
  } finally {
    if (!stopped) { child.kill(); await exit; }
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const backend of ['webjs', 'baileys']) for (const modern of [true, false]) await wireSmoke('dist/index.js', backend, modern);
}
