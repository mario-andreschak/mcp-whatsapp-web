// Real OAuth/HTTP/Chromium coverage is in test/http-security.test.ts with an injected offline account.
// This release smoke starts the actual compiled process with --no-connect and an isolated session directory.
import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

it('compiled HTTP refuses to start without owner credentials before any account connection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wa-http-entry-'));
  const entry = path.resolve('dist/index.js');
  try {
    const child = spawn(process.execPath, [entry, '--http', '--no-connect'], { cwd: directory,
      env: { ...process.env, MCP_OPERATOR_TOKEN: '', MCP_HTTP_PORT: '0', MCP_AUTO_CONNECT: 'false', WHATSAPP_BACKEND: 'webjs' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const [code] = await once(child, 'exit');
    expect(code).toBe(1);
    expect(stderr).toContain('MCP_OPERATOR_TOKEN');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
