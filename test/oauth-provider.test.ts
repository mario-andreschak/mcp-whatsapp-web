import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Response } from 'express';
import { WhatsAppOAuthProvider } from '../src/auth/oauth-provider.js';
import type { WhatsAppService } from '../src/services/whatsapp.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const REDIRECT_URI = 'http://localhost:4200/api/oauth/callback';

let storePath: string;
let whatsappAuthenticated: boolean;
let provider: WhatsAppOAuthProvider;

const fakeWhatsApp = { isAuthenticated: () => whatsappAuthenticated } as unknown as WhatsAppService;

const makeClient = (id = 'client-1'): OAuthClientInformationFull => ({
  client_id: id,
  client_id_issued_at: Math.floor(Date.now() / 1000),
  redirect_uris: [REDIRECT_URI],
  client_name: 'test',
});

const pkcePair = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** Run provider.authorize and capture the redirect URL it issues. */
async function authorize(client: OAuthClientInformationFull, codeChallenge: string, state?: string) {
  let redirectUrl = '';
  const res = { redirect: (_status: number, url: string) => { redirectUrl = url; } } as unknown as Response;
  await provider.authorize(client, { codeChallenge, redirectUri: REDIRECT_URI, state }, res);
  return redirectUrl;
}

beforeEach(async () => {
  storePath = path.join(os.tmpdir(), `oauth-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  whatsappAuthenticated = true;
  provider = new WhatsAppOAuthProvider(fakeWhatsApp, storePath);
  await provider.clientsStore.registerClient!(makeClient());
});

afterEach(() => {
  vi.useRealTimers();
  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
});

describe('authorization', () => {
  it('auto-approves with a code when WhatsApp is already linked', async () => {
    const { challenge } = pkcePair();
    const url = new URL(await authorize(makeClient(), challenge, 'my-state'));
    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('my-state');
    expect(url.searchParams.get('code')).toBeTruthy();
  });

  it('redirects to the QR link page when WhatsApp is not linked', async () => {
    whatsappAuthenticated = false;
    const { challenge } = pkcePair();
    const url = await authorize(makeClient(), challenge);
    expect(url).toMatch(/^\/oauth\/link\?txn=/);
    const txn = new URL(url, 'http://x').searchParams.get('txn')!;
    expect(provider.getTransaction(txn)).toBeDefined();
  });

  it('completeTransaction rejects while unauthenticated and consumes the txn once authenticated', async () => {
    whatsappAuthenticated = false;
    const { challenge } = pkcePair();
    const txn = new URL(await authorize(makeClient(), challenge), 'http://x').searchParams.get('txn')!;

    expect(() => provider.completeTransaction(txn)).toThrow(/not authenticated/i);

    whatsappAuthenticated = true;
    const redirect = new URL(provider.completeTransaction(txn));
    expect(redirect.searchParams.get('code')).toBeTruthy();
    expect(provider.getTransaction(txn)).toBeUndefined(); // consumed
    expect(() => provider.completeTransaction(txn)).toThrow(/unknown or expired/i);
  });
});

describe('token exchange', () => {
  it('runs the full PKCE happy path and rejects code reuse', async () => {
    const client = makeClient();
    const { verifier, challenge } = pkcePair();
    const code = new URL(await authorize(client, challenge)).searchParams.get('code')!;

    expect(await provider.challengeForAuthorizationCode(client, code)).toBe(challenge);

    const tokens = await provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT_URI);
    expect(tokens.token_type).toBe('bearer');
    expect(tokens.access_token.length).toBeGreaterThan(20);

    // single use
    await expect(provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT_URI)).rejects.toThrow();

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
  });

  it('rejects codes from a different client', async () => {
    const client = makeClient();
    const { challenge } = pkcePair();
    const code = new URL(await authorize(client, challenge)).searchParams.get('code')!;
    const otherClient = await provider.clientsStore.registerClient!(makeClient('client-2'));
    await expect(provider.exchangeAuthorizationCode(otherClient, code)).rejects.toThrow();
  });

  it('rejects a mismatched redirect_uri', async () => {
    const client = makeClient();
    const { challenge } = pkcePair();
    const code = new URL(await authorize(client, challenge)).searchParams.get('code')!;
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, 'http://evil.example/cb'),
    ).rejects.toThrow(/redirect_uri/);
  });

  it('rejects expired authorization codes', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { challenge } = pkcePair();
    const code = new URL(await authorize(client, challenge)).searchParams.get('code')!;
    vi.advanceTimersByTime(61_000); // codes live 60s
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow();
  });

  it('does not support refresh tokens', async () => {
    await expect(provider.exchangeRefreshToken()).rejects.toThrow(/not supported/i);
  });
});

describe('tokens', () => {
  async function issueToken() {
    const client = makeClient();
    const { verifier, challenge } = pkcePair();
    const code = new URL(await authorize(client, challenge)).searchParams.get('code')!;
    return provider.exchangeAuthorizationCode(client, code, verifier, REDIRECT_URI);
  }

  it('rejects unknown tokens', async () => {
    await expect(provider.verifyAccessToken('garbage')).rejects.toThrow();
  });

  it('persists tokens hashed, and across provider restarts', async () => {
    const tokens = await issueToken();
    expect(fs.readFileSync(storePath, 'utf8')).not.toContain(tokens.access_token);

    const provider2 = new WhatsAppOAuthProvider(fakeWhatsApp, storePath);
    const info = await provider2.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe('client-1');
  });

  it('revokeAllTokens invalidates everything (WhatsApp unlink)', async () => {
    const tokens = await issueToken();
    provider.revokeAllTokens();
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it('revokeToken only revokes for the owning client', async () => {
    const tokens = await issueToken();
    const otherClient = await provider.clientsStore.registerClient!(makeClient('client-2'));
    await provider.revokeToken(otherClient, { token: tokens.access_token });
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeDefined();
    await provider.revokeToken(makeClient(), { token: tokens.access_token });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
});

describe('store resilience', () => {
  it('starts empty when the store file is corrupt', () => {
    fs.writeFileSync(storePath, 'not json at all {');
    const fresh = new WhatsAppOAuthProvider(fakeWhatsApp, storePath);
    expect(fresh.clientsStore.getClient('client-1')).toBeUndefined();
  });

  it('drops expired tokens on load', async () => {
    const raw = 'expired-token-value';
    fs.writeFileSync(storePath, JSON.stringify({
      clients: {},
      tokens: {
        [createHash('sha256').update(raw).digest('hex')]: {
          clientId: 'x', issuedAt: 0, expiresAt: Math.floor(Date.now() / 1000) - 10,
        },
      },
    }));
    const fresh = new WhatsAppOAuthProvider(fakeWhatsApp, storePath);
    await expect(fresh.verifyAccessToken(raw)).rejects.toThrow();
  });
});
