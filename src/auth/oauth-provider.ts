import type { Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type OAuthServerProvider, type AuthorizationParams, type OAuthRegisteredClientsStore,
  type AuthInfo, InvalidGrantError, InvalidTokenError, InvalidTargetError,
  TooManyRequestsError, UnsupportedGrantTypeError,
} from '@modelcontextprotocol/server-legacy/auth';
import { OAuthClientInformationFullSchema, OAuthTokenRevocationRequestSchema, OAuthTokensSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';
type OAuthClientInformationFull = z.infer<typeof OAuthClientInformationFullSchema>;
type OAuthTokenRevocationRequest = z.infer<typeof OAuthTokenRevocationRequestSchema>;
type OAuthTokens = z.infer<typeof OAuthTokensSchema>;
import type { WhatsAppBackend } from '../services/backend.js';
import { log } from '../utils/logger.js';

const CODE_TTL = 60_000;
const TXN_TTL = 15 * 60_000;
const TOKEN_TTL = 30 * 24 * 60 * 60;
const MAX_ENTRIES = 256;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface Binding { issuer: string; resource: string; accountNamespace: string }
interface Pending { client: OAuthClientInformationFull; params: AuthorizationParams; createdAt: number }
interface Code { clientId: string; codeChallenge: string; redirectUri: string; expiresAt: number }
interface Token { clientId: string; expiresAt: number }
interface State { binding: string; clients: Record<string, OAuthClientInformationFull>; tokens: Record<string, Token> }

/** One account per process. Each client needs explicit authenticated owner consent. */
export class WhatsAppOAuthProvider implements OAuthServerProvider {
  private clients: Record<string, OAuthClientInformationFull> = Object.create(null);
  private tokens: Record<string, Token> = Object.create(null);
  private pendingTxns = new Map<string, Pending>();
  private codes = new Map<string, Code>();
  private readonly binding: string;

  constructor(private readonly whatsapp: WhatsAppBackend, private readonly storePath: string,
    private readonly config: Binding) {
    this.binding = hash(JSON.stringify(config));
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.storePath)) return;
      const stat = fs.lstatSync(this.storePath);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid OAuth store file.');
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as State;
      // Old unbound tokens and files copied from another account/issuer fail closed.
      if (data.binding !== this.binding) return;
      this.clients = Object.assign(Object.create(null), data.clients ?? {});
      this.tokens = Object.assign(Object.create(null), data.tokens ?? {});
      this.sweepExpired();
    } catch (error) {
      this.clients = Object.create(null); this.tokens = Object.create(null);
      log.warn('Could not load OAuth store; starting without grants.', error);
    }
  }

  private persist(): void {
    const state: State = { binding: this.binding, clients: this.clients, tokens: this.tokens };
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
    // Client credentials are secrets too. Replace atomically with a private file.
    const temporary = this.storePath + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.storePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: clientId => this.clients[clientId],
      registerClient: client => {
        if (Object.keys(this.clients).length >= MAX_ENTRIES) throw new TooManyRequestsError('Client registration capacity reached.');
        // The SDK supplies generated fields. Generate them for direct callers too.
        const fields = client as Partial<OAuthClientInformationFull>;
        const full = { ...client, client_id: fields.client_id ?? randomUUID(),
          client_id_issued_at: fields.client_id_issued_at ?? Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
        this.clients[full.client_id] = full;
        this.persist();
        return full;
      },
    };
  }

  private validateResource(resource?: URL): void {
    if (resource && resource.href !== this.config.resource) throw new InvalidTargetError('Unknown resource.');
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweepExpired();
    this.validateResource(params.resource);
    if (this.pendingTxns.size >= MAX_ENTRIES) throw new TooManyRequestsError('Too many pending authorizations.');
    const txn = randomUUID();
    // Being linked is not consent: never issue a code on this request.
    this.pendingTxns.set(txn, { client, params, createdAt: Date.now() });
    res.redirect(302, '/oauth/link?txn=' + txn);
  }

  getTransaction(txn: string): Pending | undefined {
    this.sweepExpired();
    return this.pendingTxns.get(txn);
  }

  /** Only the owner-authenticated POST /oauth/link/complete invokes this. */
  completeTransaction(txn: string): string {
    const pending = this.getTransaction(txn);
    if (!pending) throw new InvalidGrantError('Unknown or expired authorization transaction.');
    if (!this.whatsapp.isAuthenticated()) throw new InvalidGrantError('WhatsApp is not authenticated yet.');
    if (this.codes.size >= MAX_ENTRIES) throw new TooManyRequestsError('Authorization code capacity reached.');
    this.pendingTxns.delete(txn);
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { clientId: pending.client.client_id, codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri, expiresAt: Date.now() + CODE_TTL });
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('iss', this.config.issuer);
    if (pending.params.state !== undefined) redirect.searchParams.set('state', pending.params.state);
    return redirect.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const entry = this.codes.get(code);
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt <= Date.now()) throw new InvalidGrantError('Invalid or expired authorization code.');
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string,
    redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    this.validateResource(resource);
    await this.challengeForAuthorizationCode(client, code);
    const entry = this.codes.get(code)!;
    if (redirectUri !== entry.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    this.sweepExpired();
    if (Object.keys(this.tokens).length >= MAX_ENTRIES) throw new TooManyRequestsError('Token capacity reached.');
    this.codes.delete(code); // SDK validates S256 PKCE before calling this method.
    const token = randomBytes(32).toString('base64url');
    this.tokens[hash(token)] = { clientId: client.client_id, expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL };
    this.persist();
    return { access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new UnsupportedGrantTypeError('Refresh tokens are not supported; re-run the authorization flow.');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.tokens[hash(token)];
    if (!entry || entry.expiresAt <= Math.floor(Date.now() / 1000)) throw new InvalidTokenError('Invalid or expired access token.');
    return { token, clientId: entry.clientId, scopes: [], expiresAt: entry.expiresAt, resource: new URL(this.config.resource) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    if (this.tokens[hash(request.token)]?.clientId === client.client_id) {
      delete this.tokens[hash(request.token)]; this.persist();
    }
  }

  revokeAllTokens(): void {
    this.tokens = Object.create(null);
    this.codes.clear(); this.pendingTxns.clear();
    this.persist();
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [txn, entry] of this.pendingTxns) if (entry.createdAt + TXN_TTL <= now) this.pendingTxns.delete(txn);
    for (const [code, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(code);
    for (const [key, entry] of Object.entries(this.tokens)) if (entry.expiresAt <= now / 1000) delete this.tokens[key];
  }
}
