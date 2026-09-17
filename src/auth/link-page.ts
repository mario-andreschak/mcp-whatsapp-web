import { createHash } from 'node:crypto';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import qrcode from 'qrcode';
import { WhatsAppOAuthProvider } from './oauth-provider.js';
import type { WhatsAppBackend } from '../services/backend.js';

export function createLinkRouter(provider: WhatsAppOAuthProvider, whatsapp: WhatsAppBackend, ownerGuard: RequestHandler): Router {
  const router = Router();
  const validTxn = (req: Request, res: Response): string | undefined => {
    const txn = req.query.txn ?? req.body?.txn;
    if (typeof txn !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(txn) || !provider.getTransaction(txn)) {
      res.status(400).json({ error: 'Unknown or expired authorization request. Retry from your MCP client.' }); return;
    }
    return txn;
  };
  router.get('/', (req, res) => {
    if (!validTxn(req, res)) return;
    const digest = createHash('sha256').update(SCRIPT).digest('base64');
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'sha256-" + digest + "'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.type('html').send(PAGE);
  });
  router.use(ownerGuard);
  router.get('/status', async (req, res) => {
    const txn = validTxn(req, res); if (!txn) return;
    const pending = provider.getTransaction(txn)!;
    const authenticated = whatsapp.isAuthenticated();
    const qr = whatsapp.getLatestQrCode();
    res.json({ authenticated, clientName: pending.client.client_name ?? 'Unnamed client',
      redirectUri: pending.params.redirectUri,
      qrDataUrl: !authenticated && qr ? await qrcode.toDataURL(qr) : null,
      pairingCode: !authenticated ? whatsapp.getLatestPairingCode() : null });
  });
  router.post('/pair', async (req, res) => {
    if (!validTxn(req, res)) return;
    const phone = req.body?.phone_number;
    if (typeof phone !== 'string' || !/^\+?[1-9][0-9]{6,14}$/.test(phone)) {
      res.status(400).json({ error: 'Use an international phone number with 7–15 digits.' }); return;
    }
    try { res.json({ pairingCode: await whatsapp.requestPairingCode(phone) }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Pairing failed.' }); }
  });
  router.post('/complete', (req, res) => {
    const txn = validTxn(req, res); if (!txn) return;
    try { res.json({ redirect: provider.completeTransaction(txn) }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Approval failed.' }); }
  });
  return router;
}

const SCRIPT = `
const txn = new URLSearchParams(location.search).get('txn');
let token = '';
let timer;
const byId = id => document.getElementById(id);
async function request(route, body) {
  const res = await fetch('/oauth/link/' + route + (body ? '' : '?txn=' + encodeURIComponent(txn)), {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify({ txn, ...body }) : undefined, cache: 'no-store'
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
async function poll() {
  clearTimeout(timer);
  try {
    const data = await request('status');
    byId('consent').hidden = false;
    byId('client').textContent = data.clientName;
    byId('redirect').textContent = data.redirectUri;
    byId('status').textContent = data.authenticated ? 'WhatsApp is linked. Review this client before approving.' : 'Link WhatsApp using the QR code or pairing form.';
    byId('approve').disabled = !data.authenticated;
    byId('qr').hidden = !data.qrDataUrl;
    if (data.qrDataUrl) byId('qr').src = data.qrDataUrl;
    byId('code').textContent = data.pairingCode || '';
    timer = setTimeout(poll, 2000);
  } catch (error) { byId('status').textContent = error.message; }
}
byId('unlock').addEventListener('submit', ev => {
  ev.preventDefault(); token = byId('owner').value; byId('owner').value = ''; void poll();
});
byId('pair').addEventListener('submit', async ev => {
  ev.preventDefault();
  try { await request('pair', { phone_number: byId('phone').value }); await poll(); }
  catch (error) { byId('status').textContent = error.message; }
});
byId('approve').addEventListener('click', async () => {
  byId('approve').disabled = true; clearTimeout(timer);
  try { const data = await request('complete', {}); token = ''; location.assign(data.redirect); }
  catch (error) { byId('status').textContent = error.message; }
});
`;
const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize WhatsApp access</title><style>
body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:1rem;line-height:1.5}input,button{font:inherit;padding:.6rem;margin:.3rem}img{max-width:240px}#redirect{overflow-wrap:anywhere}
</style><h1>Authorize WhatsApp access</h1>
<p>Enter the owner token configured on this server. It remains in this page's memory until you leave.</p>
<form id="unlock"><label>Owner token <input id="owner" type="password" autocomplete="off" required></label><button>Unlock</button></form>
<p id="status">Owner authentication is required to view or link the account.</p>
<section id="consent" hidden><p><strong id="client"></strong> is requesting access to this WhatsApp account, including reading messages, sending messages and unlinking the account.</p>
<p>Callback: <span id="redirect"></span></p><img id="qr" hidden alt="WhatsApp pairing QR code"><p id="code"></p>
<form id="pair"><label>International phone number <input id="phone" type="tel" required></label><button>Get pairing code</button></form>
<button id="approve" disabled>Authorize this client</button><p>Close this page to decline.</p></section>
<script>${SCRIPT}</script></html>`;
