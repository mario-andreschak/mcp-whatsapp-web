import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function operatorGuard(token = process.env.MCP_OPERATOR_TOKEN): RequestHandler {
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('HTTP requires MCP_OPERATOR_TOKEN: 32–256 random URL-safe characters.');
  }
  const expected = createHash('sha256').update(token).digest();
  return (req, res, next) => {
    const value = req.get('authorization');
    const supplied = value?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
    if (!supplied || !timingSafeEqual(expected, createHash('sha256').update(supplied).digest())) {
      res.set('WWW-Authenticate', 'Bearer realm="WhatsApp owner"').status(401).json({ error: 'Owner authentication required.' });
      return;
    }
    next();
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.origin === 'null') {
    throw new Error('Expected an absolute HTTP(S) origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

export function publicOrigin(host: string, port: number): string {
  if (process.env.MCP_PUBLIC_URL) {
    const origin = canonicalOrigin(process.env.MCP_PUBLIC_URL);
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname)) {
      throw new Error('MCP_PUBLIC_URL must use HTTPS outside loopback.');
    }
    return origin;
  }
  const hostname = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
  if (!LOOPBACK.has(hostname)) throw new Error('Non-loopback HTTP binding requires MCP_PUBLIC_URL with HTTPS.');
  return new URL('http://' + hostname + ':' + port).origin;
}

export function httpBoundary(origin: string): RequestHandler {
  const url = new URL(origin);
  const hosts = new Set([url.host]);
  // Equivalent default-port Host spellings, with exact port checks.
  if (!url.port) hosts.add(url.hostname + (url.protocol === 'https:' ? ':443' : ':80'));
  const origins = new Set([origin]);
  for (const value of (process.env.MCP_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)) {
    origins.add(canonicalOrigin(value.trim()));
  }
  const headers = new Set(['authorization', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'last-event-id']);
  return (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    if (!hosts.has(req.get('host') ?? '')) { res.status(403).json({ error: 'Untrusted Host.' }); return; }
    const supplied = req.get('origin');
    if (supplied !== undefined && !origins.has(supplied)) {
      res.status(403).json({ error: 'Untrusted Origin.' }); return;
    }
    if (supplied) {
      res.set('Access-Control-Allow-Origin', supplied).vary('Origin');
      res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {
      const requested = (req.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (!supplied || requested.some(h => !headers.has(h)) ||
          !['GET', 'POST', 'DELETE'].includes(req.get('access-control-request-method') ?? '')) {
        res.status(403).end(); return;
      }
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', [...headers].join(', '));
      res.status(204).end(); return;
    }
    next();
  };
}
