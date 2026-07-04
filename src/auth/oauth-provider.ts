import { Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'fs';
import { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidGrantError,
  InvalidTokenError,
  UnsupportedGrantTypeError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { WhatsAppService } from '../services/whatsapp.js';
import { log } from '../utils/logger.js';

const AUTH_CODE_TTL_MS = 60 * 1000; // Authorization codes are single-use and short-lived
const TXN_TTL_MS = 15 * 60 * 1000; // Pending browser authorizations expire after 15 minutes
const TOKEN_TTL_S = 30 * 24 * 60 * 60; // Access tokens live 30 days (revoked early on logout)

interface PendingTransaction {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

interface IssuedCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

interface StoredToken {
  clientId: string;
  issuedAt: number;
  expiresAt: number; // seconds since epoch
}

interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  // Keyed by SHA-256 hash of the token, so the store file never contains usable secrets
  tokens: Record<string, StoredToken>;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * OAuth 2.1 authorization server whose "consent screen" is the WhatsApp QR /
 * pairing-code page: an authorization succeeds exactly when the WhatsApp
 * client reaches the authenticated state. Tokens gate the Streamable HTTP
 * /mcp endpoint and are revoked when the WhatsApp session is invalidated,
 * which makes standards-compliant MCP clients re-run the browser flow.
 */
export class WhatsAppOAuthProvider implements OAuthServerProvider {
  private clients: Record<string, OAuthClientInformationFull> = {};
  private tokens: Record<string, StoredToken> = {};
  private pendingTxns = new Map<string, PendingTransaction>();
  private codes = new Map<string, IssuedCode>();

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly storePath: string,
  ) {
    this.load();
  }

  // --- persistence -----------------------------------------------------

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as PersistedState;
        this.clients = data.clients ?? {};
        this.tokens = data.tokens ?? {};
        const now = Math.floor(Date.now() / 1000);
        for (const [hash, token] of Object.entries(this.tokens)) {
          if (token.expiresAt <= now) delete this.tokens[hash];
        }
      }
    } catch (error) {
      log.warn(`Could not read OAuth store at ${this.storePath}; starting empty.`, error);
      this.clients = {};
      this.tokens = {};
    }
  }

  private persist(): void {
    try {
      const state: PersistedState = { clients: this.clients, tokens: this.tokens };
      fs.writeFileSync(this.storePath, JSON.stringify(state, null, 2));
    } catch (error) {
      log.error(`Could not write OAuth store at ${this.storePath}:`, error);
    }
  }

  // --- client registry (dynamic client registration) --------------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.clients[clientId],
      registerClient: (client: OAuthClientInformationFull) => {
        this.clients[client.client_id] = client;
        this.persist();
        log.info(`Registered OAuth client ${client.client_id} (${client.client_name ?? 'unnamed'})`);
        return client;
      },
    };
  }

  // --- authorization ----------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.sweepExpired();

    // WhatsApp session already linked: nothing for the user to do, approve directly.
    if (this.whatsapp.isAuthenticated()) {
      res.redirect(302, this.issueCodeRedirect(client, params));
      return;
    }

    const txn = randomUUID();
    this.pendingTxns.set(txn, { client, params, createdAt: Date.now() });
    res.redirect(302, `/oauth/link?txn=${txn}`);
  }

  /** Look up a pending browser authorization. Used by the QR link page. */
  getTransaction(txn: string): PendingTransaction | undefined {
    this.sweepExpired();
    return this.pendingTxns.get(txn);
  }

  /**
   * Complete a pending authorization after WhatsApp reached the authenticated
   * state. Consumes the transaction and returns the redirect URL (carrying the
   * authorization code) to send the browser to.
   */
  completeTransaction(txn: string): string {
    const pending = this.getTransaction(txn);
    if (!pending) {
      throw new Error('Unknown or expired authorization transaction.');
    }
    if (!this.whatsapp.isAuthenticated()) {
      throw new Error('WhatsApp is not authenticated yet.');
    }
    this.pendingTxns.delete(txn);
    return this.issueCodeRedirect(pending.client, pending.params);
  }

  private issueCodeRedirect(client: OAuthClientInformationFull, params: AuthorizationParams): string {
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', code);
    if (params.state !== undefined) {
      redirect.searchParams.set('state', params.state);
    }
    log.info(`Issued authorization code for client ${client.client_id}`);
    return redirect.toString();
  }

  // --- token endpoint ----------------------------------------------------

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code.');
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE is validated by the SDK token handler
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code.');
    }
    if (redirectUri && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    }
    this.codes.delete(authorizationCode); // single-use

    const accessToken = randomBytes(32).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    this.tokens[sha256(accessToken)] = {
      clientId: client.client_id,
      issuedAt: now,
      expiresAt: now + TOKEN_TTL_S,
    };
    this.persist();
    log.info(`Issued access token for client ${client.client_id}`);

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_TTL_S,
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new UnsupportedGrantTypeError(
      'Refresh tokens are not supported; re-run the authorization flow.',
    );
  }

  // --- verification / revocation -----------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const hash = sha256(token);
    const entry = this.tokens[hash];
    const now = Math.floor(Date.now() / 1000);
    if (!entry || entry.expiresAt <= now) {
      if (entry) {
        delete this.tokens[hash];
        this.persist();
      }
      throw new InvalidTokenError('Invalid or expired access token.');
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: [],
      expiresAt: entry.expiresAt,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const hash = sha256(request.token);
    const entry = this.tokens[hash];
    if (entry && entry.clientId === client.client_id) {
      delete this.tokens[hash];
      this.persist();
      log.info(`Revoked access token for client ${client.client_id}`);
    }
  }

  /**
   * Drop every issued token, e.g. after the WhatsApp session was unlinked.
   * Clients then receive 401 on their next request and re-run the flow.
   */
  revokeAllTokens(): void {
    const count = Object.keys(this.tokens).length;
    if (count === 0) return;
    this.tokens = {};
    this.persist();
    log.warn(`WhatsApp session invalidated: revoked ${count} OAuth access token(s).`);
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [txn, pending] of this.pendingTxns) {
      if (pending.createdAt + TXN_TTL_MS < now) this.pendingTxns.delete(txn);
    }
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt < now) this.codes.delete(code);
    }
  }
}
