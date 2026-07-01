/**
 * HTTP Server — Redirect to HTTPS (Port 8080)
 *
 * Public nodes (Let's Encrypt): 301 redirect all traffic to HTTPS /welcome
 * LAN nodes (self-signed): Shows QR trust bootstrap + CA cert download
 *
 * Endpoints:
 *   GET /         — Redirect to HTTPS landing page (public) or trust bootstrap (LAN)
 *   GET /trust    — Downloads the Root CA certificate (.pem)  [LAN only]
 */

import Koa from 'koa';
import Router from '@koa/router';
import { getCaCertPem, isUsingLetsEncrypt } from './tls.js';
import QRCode from 'qrcode';

export async function startHttpServer(port: number): Promise<void> {
    const app = new Koa();
    const router = new Router();

    router.get('/(.*)', async (ctx, next) => {
        const publicDomain = process.env.CF_RECORD_NAME;

        if (publicDomain) {
            // Public node — 301 redirect everything to HTTPS /welcome
            ctx.status = 301;
            ctx.redirect(`https://${publicDomain}/`);
            return;
        }

        // LAN node — fall through to trust bootstrap below
        await next();
    });

    // LAN-only: Trust bootstrap page
    router.get('/', async (ctx) => {
        const trustUrl = `http://${ctx.host}/trust`;
        const pwaUrl = `https://beanpool.local:8443`;

        const trustQr = await QRCode.toDataURL(trustUrl, { width: 256, margin: 1 });
        const pwaQr = await QRCode.toDataURL(pwaUrl, { width: 256, margin: 1 });

        ctx.type = 'html';
        ctx.body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BeanPool — Join BeanPool</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 480px; text-align: center; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #fff; }
    .subtitle { color: #888; margin-bottom: 2rem; }
    .step {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1rem;
    }
    .step-number {
      display: inline-block;
      width: 28px; height: 28px;
      background: #2563eb;
      border-radius: 50%;
      line-height: 28px;
      font-weight: bold;
      font-size: 0.85rem;
      margin-bottom: 0.75rem;
    }
    .step h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
    .step p { font-size: 0.9rem; color: #aaa; margin-bottom: 1rem; }
    .qr { border-radius: 8px; }
    a.btn {
      display: inline-block;
      background: #2563eb;
      color: white;
      text-decoration: none;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-weight: 600;
      margin-top: 0.5rem;
    }
    a.btn:hover { background: #1d4ed8; }
    .footer { margin-top: 2rem; font-size: 0.8rem; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🫘 BeanPool</h1>
    <p class="subtitle">Welcome to BeanPool. Two steps to join.</p>

    <div class="step">
      <div class="step-number">1</div>
      <h2>Trust the Network</h2>
      <p>Scan this QR code or tap below to install the community certificate.</p>
      <img src="${trustQr}" alt="Trust QR" class="qr" width="200" height="200" />
      <br/>
      <a href="/trust" class="btn">Download Certificate</a>
    </div>

    <div class="step">
      <div class="step-number">2</div>
      <h2>Open BeanPool</h2>
      <p>After trusting the certificate, scan this to open the PWA.</p>
      <img src="${pwaQr}" alt="PWA QR" class="qr" width="200" height="200" />
      <br/>
      <a href="${pwaUrl}" class="btn">Open BeanPool PWA</a>
    </div>

    <p class="footer">Independent infrastructure for local communities.</p>
  </div>
</body>
</html>`;
    });

    // Trust endpoint — CA cert download (only useful for LAN/self-signed mode)
    router.get('/trust', async (ctx) => {
        if (isUsingLetsEncrypt()) {
            const hostname = process.env.CF_RECORD_NAME ?? ctx.hostname;
            ctx.redirect(`https://${hostname}/`);
            return;
        }
        ctx.type = 'application/x-pem-file';
        ctx.set('Content-Disposition', 'attachment; filename="beanpool-ca.pem"');
        ctx.body = getCaCertPem();
    });

    app.use(router.routes());
    app.use(router.allowedMethods());

    return new Promise((resolve) => {
        app.listen(port, () => {
            console.log(`🔓 HTTP → HTTPS redirect listening on http://0.0.0.0:${port}`);
            resolve();
        });
    });
}
