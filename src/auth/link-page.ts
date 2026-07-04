import { Router, Request, Response } from 'express';
import qrcode from 'qrcode';
import { WhatsAppOAuthProvider } from './oauth-provider.js';
import { WhatsAppService } from '../services/whatsapp.js';
import { log } from '../utils/logger.js';

const TXN_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

/**
 * Browser-facing part of the OAuth flow: the page a user lands on during
 * authorization. It shows the live WhatsApp QR code (and optionally a
 * pairing-code form) and polls until the WhatsApp client is authenticated,
 * then forwards the browser to /oauth/link/complete which redirects back to
 * the MCP client with the authorization code.
 */
export function createLinkRouter(
  provider: WhatsAppOAuthProvider,
  whatsapp: WhatsAppService,
): Router {
  const router = Router();

  const validTxn = (req: Request, res: Response): string | null => {
    const txn = String(req.query.txn ?? req.body?.txn ?? '');
    if (!TXN_PATTERN.test(txn) || !provider.getTransaction(txn)) {
      res.status(400).send('Unknown or expired authorization request. Please retry from your MCP client.');
      return null;
    }
    return txn;
  };

  router.get('/', (req: Request, res: Response) => {
    if (!validTxn(req, res)) return;
    res.type('html').send(LINK_PAGE_HTML);
  });

  router.get('/status', async (req: Request, res: Response) => {
    const txn = validTxn(req, res);
    if (!txn) return;

    const authenticated = whatsapp.isAuthenticated();
    const qrString = whatsapp.getLatestQrCode();
    res.json({
      authenticated,
      qrDataUrl: !authenticated && qrString ? await qrcode.toDataURL(qrString) : null,
      pairingCode: !authenticated ? whatsapp.getLatestPairingCode() : null,
    });
  });

  router.post('/pair', async (req: Request, res: Response) => {
    const txn = validTxn(req, res);
    if (!txn) return;

    try {
      const code = await whatsapp.requestPairingCode(String(req.body?.phone_number ?? ''));
      res.json({ pairingCode: code });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/complete', (req: Request, res: Response) => {
    const txn = validTxn(req, res);
    if (!txn) return;

    try {
      res.redirect(302, provider.completeTransaction(txn));
    } catch (error) {
      log.warn('Failed to complete OAuth transaction:', error);
      res.status(409).send(error instanceof Error ? error.message : String(error));
    }
  });

  return router;
}

const LINK_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link WhatsApp</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, sans-serif; margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: #f5f5f5; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) { body { background: #191919; color: #eee; } }
  .card {
    background: #fff; border-radius: 12px; padding: 2rem; max-width: 24rem;
    box-shadow: 0 2px 12px rgba(0,0,0,.12); text-align: center;
  }
  @media (prefers-color-scheme: dark) { .card { background: #262626; } }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  p { font-size: .9rem; opacity: .8; }
  #qr img { width: 240px; height: 240px; border-radius: 8px; background: #fff; }
  #pairing-code { font-size: 1.6rem; font-weight: 700; letter-spacing: .2em; margin: .5rem 0; }
  form { margin-top: 1rem; display: flex; gap: .5rem; justify-content: center; }
  input {
    padding: .5rem .7rem; border-radius: 6px; border: 1px solid #8884;
    background: transparent; color: inherit; width: 12rem;
  }
  button {
    padding: .5rem .9rem; border-radius: 6px; border: none; cursor: pointer;
    background: #25d366; color: #fff; font-weight: 600;
  }
  .error { color: #d33; font-size: .85rem; }
  .ok { color: #25d366; font-weight: 600; }
  details { margin-top: 1.2rem; font-size: .85rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Link your WhatsApp account</h1>
  <div id="content"><p>Waiting for QR code&hellip;</p></div>
  <details>
    <summary>Use a pairing code instead</summary>
    <p>Enter your WhatsApp phone number in international format (e.g. 4915112345678):</p>
    <form id="pair-form">
      <input id="phone" type="tel" placeholder="4915112345678" required>
      <button type="submit">Get code</button>
    </form>
    <p id="pair-result"></p>
  </details>
</div>
<script>
  const txn = new URLSearchParams(location.search).get('txn');
  const content = document.getElementById('content');
  let pairingActive = false;

  async function poll() {
    try {
      const res = await fetch('/oauth/link/status?txn=' + encodeURIComponent(txn));
      if (!res.ok) { content.innerHTML = '<p class="error">This authorization request expired. Retry from your MCP client.</p>'; return; }
      const s = await res.json();
      if (s.authenticated) {
        content.innerHTML = '<p class="ok">WhatsApp linked! Redirecting&hellip;</p>';
        location.href = '/oauth/link/complete?txn=' + encodeURIComponent(txn);
        return;
      }
      if (s.pairingCode) {
        content.innerHTML = '<p>Enter this code on your phone (Settings &gt; Linked Devices &gt; Link a device &gt; &quot;Link with phone number instead&quot;):</p>'
          + '<div id="pairing-code">' + s.pairingCode + '</div>';
      } else if (s.qrDataUrl && !pairingActive) {
        content.innerHTML = '<p>Scan with WhatsApp on your phone (Settings &gt; Linked Devices &gt; Link a device):</p>'
          + '<div id="qr"><img alt="WhatsApp QR code" src="' + s.qrDataUrl + '"></div>';
      }
    } catch (e) { /* transient network error; keep polling */ }
    setTimeout(poll, 2000);
  }
  poll();

  document.getElementById('pair-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = document.getElementById('pair-result');
    out.textContent = 'Requesting code…';
    try {
      const res = await fetch('/oauth/link/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txn, phone_number: document.getElementById('phone').value }),
      });
      const data = await res.json();
      if (res.ok) { pairingActive = true; out.textContent = ''; }
      else { out.textContent = data.error || 'Failed to request pairing code.'; out.className = 'error'; }
    } catch (e) { out.textContent = 'Failed to request pairing code.'; out.className = 'error'; }
  });
</script>
</body>
</html>`;
