import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer, sleep, killOwnTestBrowsers, PROJECT_ROOT, ServerHandle } from './helpers.js';

const PORT = 3971;
const BASE = `http://127.0.0.1:${PORT}`;
const STORE = path.join(PROJECT_ROOT, '.oauth-store.json');
const SEEDED_TOKEN = 'e2e-seeded-token-for-bearer-check';

let server: ServerHandle;

beforeAll(async () => {
  // Pre-seed a valid token so the bearer guard can be tested without a QR scan
  fs.writeFileSync(STORE, JSON.stringify({
    clients: {},
    tokens: {
      [createHash('sha256').update(SEEDED_TOKEN).digest('hex')]: {
        clientId: 'seeded', issuedAt: 0, expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    },
  }));
  server = spawnServer(['--http'], { MCP_HTTP_PORT: String(PORT), MCP_OAUTH: 'true' });
  // Wait for the HTTP endpoint to accept connections
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/.well-known/oauth-authorization-server`);
      break;
    } catch {
      await sleep(300);
    }
  }
});

afterAll(async () => {
  server.stop();
  await sleep(1500);
  killOwnTestBrowsers();
  if (fs.existsSync(STORE)) fs.unlinkSync(STORE);
});

describe('Streamable HTTP with OAuth (real server)', () => {
  it('rejects unauthenticated /mcp requests with a spec-compliant 401', async () => {
    const response = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    const wwwAuth = response.headers.get('www-authenticate') ?? '';
    expect(wwwAuth).toMatch(/Bearer/);
    expect(wwwAuth).toMatch(/resource_metadata/);
  });

  it('serves authorization server metadata (RFC 8414)', async () => {
    const metadata = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(metadata.token_endpoint).toBe(`${BASE}/token`);
    expect(metadata.code_challenge_methods_supported).toContain('S256');
  });

  it('serves protected resource metadata (RFC 9728)', async () => {
    const response = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    expect((await response.json()).resource).toBe(`${BASE}/mcp`);
  });

  it('supports dynamic client registration and redirects authorize to the QR page', async () => {
    const registration = await (await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e',
        redirect_uris: ['http://localhost:4200/api/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })).json();
    expect(registration.client_id).toBeTruthy();

    const challenge = createHash('sha256').update('e2e-verifier').digest('base64url');
    const authorize = await fetch(
      `${BASE}/authorize?response_type=code&client_id=${registration.client_id}` +
        `&redirect_uri=${encodeURIComponent('http://localhost:4200/api/oauth/callback')}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=e2e-state`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const location = authorize.headers.get('location') ?? '';
    expect(location).toMatch(/^\/oauth\/link\?txn=/);

    // The QR link page and its status endpoint respond for this transaction
    const txn = new URL(location, BASE).searchParams.get('txn')!;
    const page = await fetch(`${BASE}/oauth/link?txn=${txn}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Link your WhatsApp account');

    const status = await (await fetch(`${BASE}/oauth/link/status?txn=${txn}`)).json();
    expect(status.authenticated).toBe(false);

    const unknownTxn = await fetch(`${BASE}/oauth/link/status?txn=unknown-txn-000000`);
    expect(unknownTxn.status).toBe(400);
  });

  it('rejects bogus authorization codes with an OAuth error', async () => {
    const response = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=bogus&code_verifier=x&client_id=nobody' +
        `&redirect_uri=${encodeURIComponent('http://localhost:4200/api/oauth/callback')}`,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('grants a full MCP session with a valid bearer token', async () => {
    const client = new Client({ name: 'e2e-http', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${SEEDED_TOKEN}` } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(17);
    const ping = await client.callTool({ name: 'ping', arguments: {} });
    expect((ping as { content: Array<{ text: string }> }).content[0].text).toBe('pong');
    await transport.terminateSession();
    await client.close();
  });
});
