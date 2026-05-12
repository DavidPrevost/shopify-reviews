// One-shot installer that performs Shopify's OAuth Grant flow against a single
// store and prints the resulting permanent Admin API access token. Run once per
// store; paste the token into the respective .env file as SHOPIFY_ADMIN_TOKEN.
//
// Usage:
//   npm run install-shopify:dev -- --shop teraclay-dev
//   npm run install-shopify:dev -- --shop brandname            # live store
//
// Requires SHOPIFY_CLIENT_ID and SHOPIFY_WEBHOOK_SECRET in .env (both are visible
// in the Reviews app's Settings page at dev.shopify.com; the "client secret" and
// the "webhook secret" are the same value).
//
// This script is deliberately self-contained: it does not import from the rest
// of the app, so it works even if the app itself isn't yet built or running.

import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';

const SCOPES = 'read_orders,read_customers,read_products';
const PORT = 3456;
const CALLBACK_PATH = '/auth/callback';

function parseArgs(argv: string[]): { shop: string } {
  const shopIdx = argv.indexOf('--shop');
  if (shopIdx === -1 || !argv[shopIdx + 1]) {
    console.error('Usage: npm run install-shopify:dev -- --shop <store-handle>');
    console.error('Example: npm run install-shopify:dev -- --shop teraclay-dev');
    process.exit(1);
  }
  return { shop: argv[shopIdx + 1]! };
}

function normalizeShop(shop: string): string {
  return shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
}

function verifyShopifyHmac(params: URLSearchParams, hmac: string, secret: string): boolean {
  const message = [...params.entries()]
    .filter(([key]) => key !== 'hmac')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hmac, 'hex'));
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  // On Windows, avoid `cmd /c start` — cmd parses `&` in the URL as a command
  // separator and truncates everything after the first one. `rundll32.exe
  // url.dll,FileProtocolHandler` bypasses cmd entirely and passes the URL as a
  // single argument to the default protocol handler.
  const [cmd, ...args] =
    process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url] :
    process.platform === 'darwin' ? ['open', url] :
    ['xdg-open', url];
  try {
    spawn(cmd!, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Best effort. The URL is also printed below so the user can open manually.
  }
}

const { shop } = parseArgs(process.argv.slice(2));
const shopDomain = normalizeShop(shop);
const shopHandle = shopDomain.replace(/\.myshopify\.com$/, '');

const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_WEBHOOK_SECRET ?? process.env.SHOPIFY_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Missing SHOPIFY_CLIENT_ID and/or SHOPIFY_WEBHOOK_SECRET in environment.');
  console.error('Both are visible in the Reviews app Settings page at dev.shopify.com.');
  console.error('Make sure your .env file has these set, and that the npm script loads .env.');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const redirectUri = `http://localhost:${PORT}${CALLBACK_PATH}`;

// Shopify consolidated admin URLs onto admin.shopify.com. Sending the browser
// to the legacy `<shop>.myshopify.com/admin/oauth/authorize` URL triggers a
// server-side redirect that strips every query parameter except client_id —
// which makes Shopify report "redirect_uri missing." Hitting the new URL
// directly avoids the redirect and preserves the full parameter set.
const authUrl = new URL(`https://admin.shopify.com/store/${shopHandle}/oauth/authorize`);
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('state', state);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const returnedShop = url.searchParams.get('shop');
  const hmac = url.searchParams.get('hmac');

  try {
    if (!code || !returnedState || !returnedShop || !hmac) {
      throw new Error('Callback is missing required parameters (code, state, shop, hmac).');
    }
    if (returnedState !== state) {
      throw new Error('State mismatch — possible CSRF. Aborting.');
    }
    if (returnedShop !== shopDomain) {
      throw new Error(`Shop mismatch: expected ${shopDomain}, got ${returnedShop}.`);
    }
    if (!verifyShopifyHmac(url.searchParams, hmac, clientSecret)) {
      throw new Error('HMAC verification failed — callback signature does not match.');
    }

    const tokenRes = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      scope?: string;
      expires_in?: number;
      associated_user_scope?: string;
      associated_user?: unknown;
    };
    if (!tokenData.access_token) {
      throw new Error(`Token response missing access_token: ${JSON.stringify(tokenData)}`);
    }

    // The dispatcher runs as a background process; if Shopify granted an online
    // (per-user) token instead of an offline one, it will expire and the
    // dispatcher will start failing. Detect this loudly here so we never deploy
    // an installation that's about to die.
    const isOnlineToken =
      tokenData.expires_in !== undefined || tokenData.associated_user !== undefined;
    if (isOnlineToken) {
      throw new Error(
        'Shopify returned an ONLINE (per-user) access token, which expires. ' +
        'The background dispatcher requires an OFFLINE access token. ' +
        'Token response: ' + JSON.stringify(tokenData),
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html><head><title>Install complete</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40em; margin: 4em auto; padding: 0 1em; line-height: 1.5;">
<h1 style="color: #0a8a3a;">Install complete</h1>
<p>The Reviews app is now installed on <code>${shopDomain}</code>.</p>
<p>Close this tab and return to your terminal — the access token has been printed there.</p>
</body></html>`);

    const prefix = tokenData.access_token.split('_')[0] ?? '?';
    console.log('');
    console.log('======================================================');
    console.log('  Install complete');
    console.log('  Shop:           ' + shopDomain);
    console.log('  Scopes:         ' + (tokenData.scope ?? '(unknown)'));
    console.log('  Token prefix:   ' + prefix + '_');
    console.log('  Token kind:     OFFLINE (no expires_in in response)');
    console.log('======================================================');
    console.log('');
    console.log('Paste this into the stack .env that points at this store:');
    console.log('');
    console.log('  SHOPIFY_ADMIN_TOKEN=' + tokenData.access_token);
    console.log('');

    server.close();
    setTimeout(() => process.exit(0), 100).unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Install failed: ${message}\n\nCheck your terminal for details.`);
    console.error('');
    console.error('Install failed:', message);
    server.close();
    setTimeout(() => process.exit(1), 100).unref();
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('Listening on http://localhost:' + PORT);
  console.log('');
  console.log('Opening the Shopify authorize page in your browser. If it does');
  console.log('not open automatically, copy and paste this URL:');
  console.log('');
  console.log('  ' + authUrl.toString());
  console.log('');
  openBrowser(authUrl.toString());
});

process.on('SIGINT', () => {
  console.log('\nAborted by user.');
  server.close();
  process.exit(130);
});
