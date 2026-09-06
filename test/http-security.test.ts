import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WhatsAppMcpServer } from '../src/server.js';
import type { WhatsAppBackend } from '../src/services/backend.js';
import { canonicalOrigin, publicOrigin } from '../src/auth/http-security.js';

const OWNER = 'test-owner-secret-kept-only-in-memory-12345';
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {} };
let directory: string;
let base: string;
let server: WhatsAppMcpServer;
let invalidate: () => void;
let backend: WhatsAppBackend;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'wa-http-security-'));
  vi.stubEnv('MCP_HTTP_HOST', '127.0.0.1');
  vi.stubEnv('MCP_HTTP_PORT', '0');
  vi.stubEnv('MCP_OPERATOR_TOKEN', OWNER);
  vi.stubEnv('BAILEYS_SESSION_DIR', directory);
  vi.stubEnv('MCP_OAUTH', 'true');
  vi.stubEnv('MCP_AUTO_CONNECT', 'false');
  vi.stubEnv('MCP_PUBLIC_URL', '');
  vi.stubEnv('MCP_ALLOWED_ORIGINS', '');
  backend = {
    backend: 'baileys', initialize: vi.fn(async () => {}), destroy: vi.fn(async () => {}),
    isAuthenticated: () => true, getLatestQrCode: () => null, getLatestPairingCode: () => null,
    requestPairingCode: vi.fn(async () => '12345678'),
    getStatus: () => ({ backend: 'baileys', authenticated: true, history: { state: 'available', note: 'Offline fixture' } }),
    onSessionInvalidated: (callback: () => void) => { invalidate = callback; },
  } as unknown as WhatsAppBackend;
  server = new WhatsAppMcpServer(backend);
  await server.start('http');
  const listener = (server as unknown as { httpServer: Server }).httpServer;
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  base = 'http://127.0.0.1:' + address.port;
});
afterEach(async () => {
  await server?.shutdown();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const json = (token?: string) => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) });
async function begin(clientName = 'Offline test client') {
  const registration = await fetch(base + '/register', { method: 'POST', headers: json(),
    body: JSON.stringify({ client_name: clientName, redirect_uris: ['http://localhost:43210/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) });
  expect(registration.status).toBe(201);
  const client = await registration.json();
  const verifier = 'a-valid-pkce-verifier-with-at-least-forty-three-characters';
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0],
    response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state: 'opaque-state', resource: base + '/mcp' });
  const response = await fetch(base + '/authorize?' + query, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!, base);
  expect(location.pathname).toBe('/oauth/link');
  expect(location.searchParams.has('code')).toBe(false);
  return { client, verifier, txn: location.searchParams.get('txn')!, page: location.href };
}
async function approve() {
  const request = await begin();
  const approved = await fetch(base + '/oauth/link/complete', { method: 'POST', headers: json(OWNER),
    body: JSON.stringify({ txn: request.txn }) });
  expect(approved.status).toBe(200);
  const callback = new URL((await approved.json()).redirect);
  expect(callback.searchParams.get('iss')).toBe(base + '/');
  expect(callback.searchParams.get('state')).toBe('opaque-state');
  return { ...request, code: callback.searchParams.get('code')! };
}
async function exchange(request: Awaited<ReturnType<typeof approve>>, verifier = request.verifier, resource = base + '/mcp') {
  return fetch(base + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: request.client.client_id,
      code: request.code, code_verifier: verifier, redirect_uri: request.client.redirect_uris[0], resource }) });
}
async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  return fetch(base + '/mcp', { method: 'POST', headers: { ...json(token), Accept: 'application/json, text/event-stream',
    'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }) });
}

describe('real HTTP authorization boundary with an offline account fixture', () => {
  it('requires authentication and never treats an already linked account as client consent', async () => {
    const request = await begin();
    expect((await fetch(request.page)).status).toBe(200);
    const status = base + '/oauth/link/status?txn=' + request.txn;
    expect((await fetch(status)).status).toBe(401);
    expect((await fetch(status, { headers: json(OWNER) })).status).toBe(200);
    expect((await fetch(base + '/oauth/link/complete', { method: 'POST', headers: json(), body: JSON.stringify({ txn: request.txn }) })).status).toBe(401);
    expect((await fetch(base + '/oauth/link/complete?txn=' + request.txn, { headers: json(OWNER) })).status).toBe(404);
    expect((await rpc(OWNER, 'server/discover')).status).toBe(401); // OAuth grants are distinct from owner approval.
    expect(backend.initialize).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example', 'null', 'http://127.0.0.1:1', 'https://127.0.0.1'])('rejects Origin %s even with the owner token', async origin => {
    const request = await begin();
    const response = await fetch(base + '/oauth/link/status?txn=' + request.txn, { headers: { ...json(OWNER), Origin: origin } });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects Host rebinding and exposes only generic health with no-store/no-referrer', async () => {
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(base + '/health', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    expect(hostileHostStatus).toBe(403);
    const response = await fetch(base + '/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('enforces S256, resource binding, explicit consent, modern discovery and legacy handshake', async () => {
    const request = await approve();
    expect((await exchange(request, 'incorrect-verifier')).status).toBe(400);
    expect((await exchange(request, request.verifier, 'https://other.example/mcp')).status).toBe(400);
    const issued = await exchange(request);
    expect(issued.status).toBe(200);
    const token = (await issued.json()).access_token;
    expect((await exchange(request)).status).toBe(400);
    const response = await rpc(token, 'server/discover');
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const discovered = await response.json();
    expect(discovered.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('mcp-whatsapp-web');
    expect(discovered.result.capabilities).not.toHaveProperty('logging');
    const result = await (await rpc(token, 'tools/call', { name: 'ping', arguments: {} })).json();
    expect(result.result.resultType).toBe('complete');
    expect(result.result.content).toEqual([{ type: 'text', text: 'pong' }]);
    const client = new Client({ name: 'legacy-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
      expect((await client.listTools()).tools.some(tool => tool.name === 'send_message')).toBe(true);
      expect(await client.callTool({ name: 'ping' })).toMatchObject({ content: [{ text: 'pong' }] });
    } finally { await client.close(); }
    invalidate();
    expect((await rpc(token, 'server/discover')).status).toBe(401);
  });

  it('stops a timed-out multi-step tool before it starts the next provider operation', async () => {
    vi.stubEnv('MCP_TOOL_TIMEOUT_MS', '100');
    let finish!: (value: unknown) => void;
    backend.getMessageById = vi.fn(() => new Promise(resolve => { finish = resolve; })) as WhatsAppBackend['getMessageById'];
    backend.getMessages = vi.fn(async () => []);
    const approved = await approve();
    const token = (await (await exchange(approved)).json()).access_token;
    const response = await rpc(token, 'tools/call', { name: 'get_message_context', arguments: { message_id: 'fixture-id' } });
    const result = await response.json();
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/timed out/);
    finish({ id: 'fixture-id', from: 'offline-chat', fromMe: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(backend.getMessages).not.toHaveBeenCalled();
  });

  it.runIf(process.env.RUN_BROWSER_TESTS === 'true')('requires explicit owner consent in real Chromium without exposing the token to storage', async () => {
    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({ headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
    try {
      const request = await begin('<script>untrusted client name</script>');
      const page = await browser.newPage();
      let callback = '';
      await page.setRequestInterception(true);
      page.on('request', incoming => {
        if (incoming.url().startsWith('http://localhost:43210/callback')) {
          callback = incoming.url(); void incoming.respond({ status: 200, contentType: 'text/html', body: '<p>Approved offline fixture</p>' });
        } else if (incoming.url().startsWith(base + '/') || incoming.url().startsWith('data:')) void incoming.continue();
        else void incoming.abort();
      });
      await page.goto(request.page);
      expect(await page.$eval('#consent', element => element.hidden)).toBe(true);
      await page.type('#owner', OWNER);
      await page.click('#unlock button');
      await page.waitForFunction(() => !document.querySelector('#approve')?.hasAttribute('disabled'));
      expect(callback).toBe('');
      expect(await page.$eval('#client', element => element.textContent)).toBe('<script>untrusted client name</script>');
      expect(await page.$eval('#owner', element => element.value)).toBe('');
      expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
      expect(await page.cookies()).toEqual([]);
      await Promise.all([page.waitForNavigation(), page.click('#approve')]);
      expect(new URL(callback).searchParams.get('code')).toBeTruthy();
      expect(new URL(callback).searchParams.get('iss')).toBe(base + '/');
    } finally { await browser.close(); }
  }, 30_000);

  it('invalidates pending approvals and authorization codes when the account is unlinked', async () => {
    const approved = await approve();
    const pending = await begin('Second client');
    invalidate();
    expect((await exchange(approved)).status).toBe(400);
    expect((await fetch(base + '/oauth/link/complete', { method: 'POST', headers: json(OWNER), body: JSON.stringify({ txn: pending.txn }) })).status).toBe(400);
  });

  it('does not leak account data through invalid phone input or untrusted CORS preflight', async () => {
    const request = await begin();
    expect((await fetch(base + '/oauth/link/pair', { method: 'POST', headers: json(OWNER),
      body: JSON.stringify({ txn: request.txn, phone_number: 'invalid' }) })).status).toBe(400);
    expect(backend.requestPairingCode).not.toHaveBeenCalled();
    const preflight = await fetch(base + '/mcp', { method: 'OPTIONS', headers: {
      Origin: base, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,mcp-method,mcp-name' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(base);
  });

  it('requires an operator token even without OAuth, and serves authenticated modern requests', async () => {
    await server.shutdown();
    vi.stubEnv('MCP_OAUTH', 'false');
    server = new WhatsAppMcpServer(backend);
    await server.start('http');
    const address = (server as unknown as { httpServer: Server }).httpServer.address() as { port: number };
    base = 'http://127.0.0.1:' + address.port;
    expect((await rpc('bad', 'server/discover')).status).toBe(401);
    expect((await rpc(OWNER, 'server/discover')).status).toBe(200);
  });
});

describe('canonical configuration', () => {
  it('normalizes default ports but rejects credentials and path-bearing origins', () => {
    expect(canonicalOrigin('https://example.com:443/')).toBe('https://example.com');
    expect(canonicalOrigin('http://localhost:80')).toBe('http://localhost');
    expect(() => canonicalOrigin('https://user:secret@example.com')).toThrow();
    expect(() => canonicalOrigin('https://example.com/path')).toThrow();
    expect(() => canonicalOrigin('null')).toThrow();
    expect(() => publicOrigin('0.0.0.0', 3001)).toThrow(/MCP_PUBLIC_URL/);
  });
});
