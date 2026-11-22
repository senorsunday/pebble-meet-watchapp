/**
 * PebbleMeet Google OAuth Relay — Cloudflare Worker
 *
 * Keeps GOOGLE_CLIENT_SECRET strictly on the server while enabling
 * one-tap "Sign in with Google" and automatic 1-hour token refresh for
 * Pebble / Rebble Appstore users.
 *
 * Required secrets (set via `wrangler secret put`):
 *   - GOOGLE_CLIENT_ID
 *   - GOOGLE_CLIENT_SECRET
 *   - STATE_SIGNING_SECRET  (32+ random bytes, e.g. `openssl rand -hex 32`)
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/meetings.space.created',
  'openid',
  'email',
].join(' ');

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_CONFIG_PAGE_URL = 'https://senorsunday.github.io/pebble-meet-watchapp/config/';
const DEFAULT_ALLOWED_ORIGIN = 'https://senorsunday.github.io';

function getAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGIN;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = getAllowedOrigins(env);
  const headers = {
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return headers;
}

function jsonResponse(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...getCorsHeaders(request, env),
    },
  });
}

function validateReturnTo(raw, configPageUrl) {
  if (!raw || typeof raw !== 'string') return 'pebblejs://close#';
  if (raw === 'pebblejs://close#' || raw.startsWith('pebblejs://close#')) {
    return 'pebblejs://close#';
  }
  try {
    const parsed = new URL(raw);
    const configOrigin = new URL(configPageUrl).origin;
    if (parsed.protocol === 'https:' && parsed.origin === configOrigin) {
      return parsed.toString();
    }
  } catch {
    // Fall through to safe Pebble default
  }
  return 'pebblejs://close#';
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function importHmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function signState(payload, secret) {
  const enc = new TextEncoder();
  const payloadBytes = enc.encode(JSON.stringify(payload));
  const payloadB64 = toBase64Url(payloadBytes);
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64)));
  return payloadB64 + '.' + toBase64Url(sig);
}

async function verifyState(stateToken, secret) {
  if (!stateToken || typeof stateToken !== 'string') return null;
  const parts = stateToken.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const enc = new TextEncoder();
    const key = await importHmacKey(secret);
    const expectedSig = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64))
    );
    const providedSig = fromBase64Url(sigB64);
    if (!constantTimeEqual(expectedSig, providedSig)) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
    if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function buildConfigRedirect(configPageUrl, fragmentParams) {
  const target = new URL(configPageUrl);
  target.hash = new URLSearchParams(fragmentParams).toString();
  return Response.redirect(target.toString(), 302);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const configPageUrl = env.CONFIG_PAGE_URL || DEFAULT_CONFIG_PAGE_URL;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse(
        { ok: true, service: 'pebble-meet-watchapp-oauth-relay', version: '0.2.0' },
        200,
        request,
        env
      );
    }

    if (url.pathname === '/oauth/start' && request.method === 'GET') {
      if (!env.GOOGLE_CLIENT_ID || !env.STATE_SIGNING_SECRET) {
        return jsonResponse(
          { error: 'OAuth relay is not configured yet (missing worker secrets).' },
          500,
          request,
          env
        );
      }

      const returnTo = validateReturnTo(url.searchParams.get('return_to'), configPageUrl);
      const nonceBytes = new Uint8Array(16);
      crypto.getRandomValues(nonceBytes);

      const state = await signState(
        {
          nonce: toBase64Url(nonceBytes),
          return_to: returnTo,
          exp: Date.now() + STATE_TTL_MS,
        },
        env.STATE_SIGNING_SECRET
      );

      const callbackUri = url.origin + '/oauth/callback';
      const authParams = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: callbackUri,
        response_type: 'code',
        scope: OAUTH_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });

      return Response.redirect(GOOGLE_AUTH_URL + '?' + authParams.toString(), 302);
    }

    if (url.pathname === '/oauth/callback' && request.method === 'GET') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.STATE_SIGNING_SECRET) {
        return buildConfigRedirect(configPageUrl, {
          oauth_status: 'error',
          oauth_error: 'OAuth worker secrets are not configured.',
        });
      }

      const oauthError = url.searchParams.get('error');
      const stateParam = url.searchParams.get('state');
      const verifiedState = await verifyState(stateParam, env.STATE_SIGNING_SECRET);

      if (!verifiedState) {
        return buildConfigRedirect(configPageUrl, {
          oauth_status: 'error',
          oauth_error: 'Invalid or expired sign-in session. Please try again.',
        });
      }

      const returnTo = validateReturnTo(verifiedState.return_to, configPageUrl);

      if (oauthError) {
        return buildConfigRedirect(configPageUrl, {
          oauth_status: 'error',
          oauth_error: oauthError,
          return_to: returnTo,
        });
      }

      const code = url.searchParams.get('code');
      if (!code) {
        return buildConfigRedirect(configPageUrl, {
          oauth_status: 'error',
          oauth_error: 'Missing authorization code from Google.',
          return_to: returnTo,
        });
      }

      const callbackUri = url.origin + '/oauth/callback';
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: callbackUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenRes.ok) {
        return buildConfigRedirect(configPageUrl, {
          oauth_status: 'error',
          oauth_error: 'Google token exchange failed (' + tokenRes.status + ').',
          return_to: returnTo,
        });
      }

      const tokenData = await tokenRes.json();
      let userEmail = '';
      if (tokenData.access_token) {
        try {
          const infoRes = await fetch(GOOGLE_USERINFO_URL, {
            headers: { Authorization: 'Bearer ' + tokenData.access_token },
          });
          if (infoRes.ok) {
            const info = await infoRes.json();
            if (typeof info.email === 'string') {
              userEmail = info.email;
            }
          }
        } catch {
          // Email display is optional
        }
      }

      const fragment = {
        oauth_status: 'ok',
        access_token: tokenData.access_token || '',
        expires_in: String(tokenData.expires_in || 3600),
        email: userEmail,
        return_to: returnTo,
      };
      if (tokenData.refresh_token) {
        fragment.refresh_token = tokenData.refresh_token;
      }

      return buildConfigRedirect(configPageUrl, fragment);
    }

    if (url.pathname === '/oauth/refresh' && request.method === 'POST') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        return jsonResponse({ error: 'OAuth worker secrets not configured.' }, 500, request, env);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON request body.' }, 400, request, env);
      }

      const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token.trim() : '';
      if (!refreshToken || refreshToken.length > 512) {
        return jsonResponse({ error: 'Valid refresh_token is required.' }, 400, request, env);
      }

      const refreshRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!refreshRes.ok) {
        const status = refreshRes.status === 400 ? 401 : refreshRes.status;
        return jsonResponse(
          { error: 'Refresh token rejected or expired. Please sign in again.' },
          status,
          request,
          env
        );
      }

      const refreshed = await refreshRes.json();
      return jsonResponse(
        {
          access_token: refreshed.access_token,
          expires_in: refreshed.expires_in || 3600,
          token_type: refreshed.token_type || 'Bearer',
        },
        200,
        request,
        env
      );
    }

    if (url.pathname === '/oauth/revoke' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON request body.' }, 400, request, env);
      }

      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!token || token.length > 2048) {
        return jsonResponse({ error: 'Valid token is required.' }, 400, request, env);
      }

      await fetch(GOOGLE_REVOKE_URL + '?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      return jsonResponse({ revoked: true }, 200, request, env);
    }

    return jsonResponse({ error: 'Not found' }, 404, request, env);
  },
};
