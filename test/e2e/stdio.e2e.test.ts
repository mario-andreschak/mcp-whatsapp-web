import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnServer, initializeMcp, sleep, killOwnTestBrowsers, ServerHandle } from './helpers.js';

/**
 * Full-stack test over the stdio transport with a real (unauthenticated)
 * WhatsApp client and a real headless browser. Requires `npm run build`.
 */
let server: ServerHandle;

beforeAll(async () => {
  server = spawnServer();
  await initializeMcp(server);
});

afterAll(async () => {
  server.proc.stdin.end(); // triggers graceful shutdown
  await sleep(8000);
  if (server.proc.exitCode === null) server.stop();
  killOwnTestBrowsers();
});

describe('stdio transport (real server)', () => {
  it('lists all tools', async () => {
    const response = await server.rpc(2, 'tools/list');
    const tools = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toContain('get_qr_code');
    expect(tools).toContain('request_pairing_code');
    expect(tools).toContain('send_message');
    expect(tools.length).toBeGreaterThanOrEqual(17);
  });

  it('answers ping while WhatsApp is still initializing', async () => {
    const response = await server.rpc(3, 'tools/call', { name: 'ping', arguments: {} });
    const content = (response.result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toBe('pong');
  });

  it('check_auth_status waits for a definitive outcome and reports unauthenticated', async () => {
    const response = await server.rpc(4, 'tools/call', { name: 'check_auth_status', arguments: {} }, 90_000);
    const content = (response.result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toMatch(/not currently authenticated/i);
  });

  it('serves the QR code as a PNG image', async () => {
    const response = await server.rpc(5, 'tools/call', { name: 'get_qr_code', arguments: {} }, 90_000);
    const content = (response.result as { content: Array<{ type: string; mimeType?: string; data?: string }> }).content[0];
    expect(content.type).toBe('image');
    expect(content.mimeType).toBe('image/png');
    expect((content.data ?? '').length).toBeGreaterThan(1000);
  });

  it('data tools fail with an actionable auth error, not "not ready"', async () => {
    const response = await server.rpc(6, 'tools/call', { name: 'list_chats', arguments: {} }, 90_000);
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/QR code|pairing code/i);
    expect(result.content[0].text).not.toMatch(/client not ready/i);
  });

  it('keeps stdout protocol-clean (no stray output)', () => {
    expect(server.nonJsonStdout()).toEqual([]);
  });

  it('exits cleanly when the client closes stdin', async () => {
    server.proc.stdin.end();
    const deadline = Date.now() + 15_000;
    while (server.proc.exitCode === null && Date.now() < deadline) {
      await sleep(250);
    }
    expect(server.proc.exitCode).toBe(0);
  });
});
