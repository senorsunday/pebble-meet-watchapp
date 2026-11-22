/**
 * PebbleMeet Cloudflare Worker — Durable Object WebSocket Bridge & Optional OAuth Helper
 *
 * 1. Phone <-> Chrome Bridge (zero secrets required, free tier):
 *    - GET  /bridge/ws?room=<CODE>&role=chrome|pebble   (Hibernatable WebSocket via Durable Object)
 *    - GET  /bridge/status?room=<CODE>                  (Peer presence status)
 *
 * 2. Optional Patched Google OAuth Helper (for self-hosters with a verified custom domain):
 *    - GET  /oauth/start?return_to=... [&room=<CODE>&mode=browser]
 *    - GET  /oauth/callback
 *    - POST /oauth/exchange  (redeems single-use 90s ticket -> tokens + session_proof)
 *    - POST /oauth/refresh   (rate-limited, verifies session_proof)
 *    - POST /oauth/revoke    (rate-limited, verifies session_proof)
 *
 * Security improvements over initial OAuth draft:
 *  - Drops unnecessary `meetings.space.created` and default `calendar.events.readonly` scopes.
 *  - Never places raw access_token or refresh_token in URL fragments or `pebblejs://close#`.
 *  - Supports real-browser sign-in (`mode=browser&room=<CODE>`) to avoid Google's embedded
 *    WebView `403: disallowed_useragent` block in Pebble/Rebble apps.
 *  - Binds `/oauth/refresh` and `/oauth/revoke` to an HMAC-signed `session_proof` + rate limiting.
 */

import { DurableObject } from 'cloudflare:workers';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// Minimal default scopes for optional self-hosted OAuth.
// `meetings.space.created` is NOT needed (Chrome opens https://meet.google.com/new directly).
// `calendar.events.readonly` is omitted by default (Option A); set OAUTH_EXTRA_SCOPES on a
// verified custom-domain deployment if you want to opt back in.
const DEFAULT_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'openid',
  'email',
];

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TICKET_TTL_MS = 90 * 1000; // 90 seconds single-use exchange window
const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DEFAULT_CONFIG_PAGE_URL = 'https://senorsunday.github.io/pebble-meet-watchapp/config/';
const DEFAULT_ALLOWED_ORIGIN = 'https://senorsunday.github.io';
const TICKET_DO_NAME = '__oauth_tickets__';

// Simple per-isolate rate limiter (best-effort protection against refresh/revoke proxy abuse)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQ = 30;
const ipHits = new Map();

function checkRateLimit(request) {
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown';
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    ipHits.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_REQ) {
    return false;
  }
  entry.count += 1;
  return true;
}

function normalizeRoomCode(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length < 6 || cleaned.length > 16) return '';
  return cleaned;
}

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
  if (
    origin &&
    (allowed.includes(origin) ||
      origin.startsWith('chrome-extension://') ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
  ) {
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

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    // Support Pebble SDK emulator `pebble emu-app-config` local return_to URLs
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
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

async function createTokenProof(token, secret) {
  const enc = new TextEncoder();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(token)));
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, digest));
  return toBase64Url(sig);
}

async function verifyTokenProof(token, proof, secret) {
  if (!token || !proof || typeof proof !== 'string') return false;
  try {
    const expected = await createTokenProof(token, secret);
    return constantTimeEqual(fromBase64Url(expected), fromBase64Url(proof));
  } catch {
    return false;
  }
}

function getOAuthScopes(env) {
  const scopes = DEFAULT_OAUTH_SCOPES.slice();
  if (env.OAUTH_EXTRA_SCOPES && typeof env.OAUTH_EXTRA_SCOPES === 'string') {
    env.OAUTH_EXTRA_SCOPES.split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => {
        if (!scopes.includes(s)) scopes.push(s);
      });
  }
  return scopes.join(' ');
}

function buildConfigRedirect(configPageUrl, fragmentParams) {
  const target = new URL(configPageUrl);
  target.hash = new URLSearchParams(fragmentParams).toString();
  return Response.redirect(target.toString(), 302);
}

function randomId(numBytes = 24) {
  const bytes = new Uint8Array(numBytes);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Durable Object: BridgeRoom
 *
 * - Relays real-time WebSocket messages between paired `chrome` and `pebble` clients
 *   using Cloudflare's Hibernation WebSocket API (works on Workers Free plan).
 * - Also hosts short-lived (90s) single-use OAuth exchange tickets under room `__oauth_tickets__`.
 */
export class BridgeRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"PING"}', '{"type":"PONG"}')
    );
  }

  getPresence() {
    let chromeConnected = false;
    let pebbleConnected = false;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() || {};
      if (meta.role === 'chrome') chromeConnected = true;
      if (meta.role === 'pebble') pebbleConnected = true;
    }
    return { chromeConnected, pebbleConnected };
  }

  broadcastPresence() {
    const payload = JSON.stringify({
      type: 'BRIDGE_PRESENCE',
      ...this.getPresence(),
    });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Ignore stale sockets; close handler will clean up
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 1. WebSocket upgrade for Phone <-> Chrome Bridge
    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const role = url.searchParams.get('role');
      if (role !== 'chrome' && role !== 'pebble') {
        return new Response('Query parameter role must be chrome or pebble', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment({
        role,
        id: randomId(8),
        connectedAt: Date.now(),
      });

      this.broadcastPresence();

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Peer presence check
    if (url.pathname === '/status' && request.method === 'GET') {
      return new Response(JSON.stringify(this.getPresence()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Deliver a server-side message (e.g., browser-initiated OAuth ticket) to a role
    if (url.pathname === '/deliver' && request.method === 'POST') {
      const body = await request.json();
      const targetRole = body?.targetRole || 'pebble';
      const serialized = JSON.stringify(body?.payload || {});
      let delivered = 0;
      for (const ws of this.ctx.getWebSockets(targetRole)) {
        try {
          ws.send(serialized);
          delivered += 1;
        } catch {
          // Ignore broken sockets
        }
      }
      return new Response(JSON.stringify({ delivered }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. Store a single-use 90s OAuth ticket
    if (url.pathname === '/ticket' && request.method === 'POST') {
      const body = await request.json();
      const ticketId = randomId(24);
      await this.ctx.storage.put('ticket:' + ticketId, {
        ...body,
        exp: Date.now() + TICKET_TTL_MS,
      });
      return new Response(JSON.stringify({ ticket: ticketId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 5. Redeem & immediately delete a single-use OAuth ticket
    if (url.pathname === '/redeem' && request.method === 'POST') {
      const body = await request.json();
      const ticketId = typeof body?.ticket === 'string' ? body.ticket.trim() : '';
      if (!ticketId || ticketId.length > 128) {
        return new Response(JSON.stringify({ error: 'Invalid ticket' }), { status: 400 });
      }
      const key = 'ticket:' + ticketId;
      const record = await this.ctx.storage.get(key);
      await this.ctx.storage.delete(key);
      if (!record || typeof record.exp !== 'number' || Date.now() > record.exp) {
        return new Response(JSON.stringify({ error: 'Ticket expired or already used' }), {
          status: 410,
        });
      }
      return new Response(JSON.stringify(record), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_WS_MESSAGE_BYTES) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.type === 'PING') {
      try {
        ws.send('{"type":"PONG"}');
      } catch {}
      return;
    }

    const sender = ws.deserializeAttachment() || {};
    const targetRole = sender.role === 'chrome' ? 'pebble' : 'chrome';

    for (const peer of this.ctx.getWebSockets(targetRole)) {
      try {
        peer.send(message);
      } catch {
        // Ignore broken peer sockets
      }
    }
  }

  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
    this.broadcastPresence();
  }

  webSocketError(ws) {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {}
    this.broadcastPresence();
  }
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
        {
          ok: true,
          service: 'pebble-meet-bridge',
          version: '0.2.0',
          bridgeEnabled: Boolean(env.BRIDGE_ROOM),
          oauthConfigured: Boolean(
            env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.STATE_SIGNING_SECRET
          ),
        },
        200,
        request,
        env
      );
    }

    // -----------------------------------------------------------------------
    // Phone <-> Chrome WebSocket Relay via Durable Objects
    // -----------------------------------------------------------------------
    if (url.pathname === '/bridge/ws' && request.method === 'GET') {
      if (!env.BRIDGE_ROOM) {
        return jsonResponse({ error: 'BRIDGE_ROOM Durable Object binding missing.' }, 500, request, env);
      }
      const room = normalizeRoomCode(url.searchParams.get('room'));
      const role = url.searchParams.get('role');
      if (!room) {
        return jsonResponse(
          { error: 'Valid 6-16 character alphanumeric room pairing code is required.' },
          400,
          request,
          env
        );
      }
      if (role !== 'chrome' && role !== 'pebble') {
        return jsonResponse({ error: 'role must be chrome or pebble.' }, 400, request, env);
      }
      const stub = env.BRIDGE_ROOM.get(env.BRIDGE_ROOM.idFromName(room));
      const doUrl = new URL('https://bridge.internal/ws');
      doUrl.searchParams.set('role', role);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    if (url.pathname === '/bridge/status' && request.method === 'GET') {
      if (!env.BRIDGE_ROOM) {
        return jsonResponse({ error: 'BRIDGE_ROOM Durable Object binding missing.' }, 500, request, env);
      }
      const room = normalizeRoomCode(url.searchParams.get('room'));
      if (!room) {
        return jsonResponse({ error: 'Valid room code is required.' }, 400, request, env);
      }
      const stub = env.BRIDGE_ROOM.get(env.BRIDGE_ROOM.idFromName(room));
      const res = await stub.fetch('https://bridge.internal/status');
      const data = await res.json();
      return jsonResponse({ room, ...data }, 200, request, env);
    }

    // -----------------------------------------------------------------------
    // Optional Self-Hosted Google OAuth Endpoints (Patched)
    // -----------------------------------------------------------------------
    if (url.pathname === '/oauth/start' && request.method === 'GET') {
      if (!env.GOOGLE_CLIENT_ID || !env.STATE_SIGNING_SECRET) {
        return jsonResponse(
          {
            error:
              'Optional Google OAuth is not enabled on this relay. PebbleMeet works without OAuth using the Chrome Bridge + Favorites.',
          },
          501,
          request,
          env
        );
      }

      const returnTo = validateReturnTo(url.searchParams.get('return_to'), configPageUrl);
      const room = normalizeRoomCode(url.searchParams.get('room') || '');
      const mode = url.searchParams.get('mode') === 'browser' && room ? 'browser' : 'redirect';

      const state = await signState(
        {
          nonce: randomId(16),
          return_to: returnTo,
          room,
          mode,
          exp: Date.now() + STATE_TTL_MS,
        },
        env.STATE_SIGNING_SECRET
      );

      const callbackUri = url.origin + '/oauth/callback';
      const authParams = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: callbackUri,
        response_type: 'code',
        scope: getOAuthScopes(env),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });

      return Response.redirect(GOOGLE_AUTH_URL + '?' + authParams.toString(), 302);
    }

    if (url.pathname === '/oauth/callback' && request.method === 'GET') {
      if (
        !env.GOOGLE_CLIENT_ID ||
        !env.GOOGLE_CLIENT_SECRET ||
        !env.STATE_SIGNING_SECRET ||
        !env.BRIDGE_ROOM
      ) {
        return buildConfigRedirect(configPageUrl, {
          oauth_status: 'error',
          oauth_error: 'OAuth worker secrets or Durable Object binding are not configured.',
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
        if (verifiedState.mode === 'browser') {
          return htmlResponse(
            `<!doctype html><html><body style="font-family:sans-serif;padding:32px;max-width:520px;margin:auto">` +
              `<h2>Google Sign-In Cancelled</h2><p>${escapeHtml(oauthError)}</p></body></html>`,
            400
          );
        }
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

      const proofSource = tokenData.refresh_token || tokenData.access_token || '';
      const sessionProof = proofSource
        ? await createTokenProof(proofSource, env.STATE_SIGNING_SECRET)
        : '';

      // Store tokens in a 90s single-use Durable Object ticket instead of URL fragments
      const ticketStore = env.BRIDGE_ROOM.get(env.BRIDGE_ROOM.idFromName(TICKET_DO_NAME));
      const ticketRes = await ticketStore.fetch('https://bridge.internal/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: tokenData.access_token || '',
          refresh_token: tokenData.refresh_token || '',
          expires_in: tokenData.expires_in || 3600,
          email: userEmail,
          session_proof: sessionProof,
        }),
      });
      const { ticket } = await ticketRes.json();

      // Browser-initiated mode: push single-use ticket over the paired BridgeRoom WebSocket
      // so the user never has to sign into Google inside Pebble's embedded WebView!
      if (verifiedState.mode === 'browser' && verifiedState.room) {
        const roomStub = env.BRIDGE_ROOM.get(env.BRIDGE_ROOM.idFromName(verifiedState.room));
        const deliverRes = await roomStub.fetch('https://bridge.internal/deliver', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetRole: 'pebble',
            payload: {
              type: 'OAUTH_TICKET',
              ticket,
              email: userEmail,
            },
          }),
        });
        const { delivered } = await deliverRes.json();
        return htmlResponse(
          `<!doctype html><html><body style="font-family:-apple-system,sans-serif;padding:32px;max-width:520px;margin:auto;line-height:1.5">` +
            `<h2>Connected to PebbleMeet</h2>` +
            `<p>Signed in as <strong>${escapeHtml(userEmail || 'your Google account')}</strong>.</p>` +
            (delivered > 0
              ? `<p>Your Pebble app received the session automatically. You can close this tab.</p>`
              : `<p>Your watch wasn't actively connected to room <code>${escapeHtml(
                  verifiedState.room
                )}</code>. Open PebbleMeet on your watch and retry, or paste this 90-second code in Settings:</p>` +
                `<p><code style="font-size:14px;word-break:break-all">${escapeHtml(ticket)}</code></p>`) +
            `</body></html>`
        );
      }

      return buildConfigRedirect(configPageUrl, {
        oauth_status: 'ok',
        oauth_ticket: ticket,
        email: userEmail,
        return_to: returnTo,
      });
    }

    if (url.pathname === '/oauth/exchange' && request.method === 'POST') {
      if (!checkRateLimit(request)) {
        return jsonResponse({ error: 'Too many requests.' }, 429, request, env);
      }
      if (!env.BRIDGE_ROOM) {
        return jsonResponse({ error: 'Ticket store unavailable.' }, 500, request, env);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON request body.' }, 400, request, env);
      }
      const ticket = typeof body?.ticket === 'string' ? body.ticket.trim() : '';
      if (!ticket || ticket.length > 128) {
        return jsonResponse({ error: 'Valid ticket is required.' }, 400, request, env);
      }
      const ticketStore = env.BRIDGE_ROOM.get(env.BRIDGE_ROOM.idFromName(TICKET_DO_NAME));
      const redeemRes = await ticketStore.fetch('https://bridge.internal/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
      });
      if (!redeemRes.ok) {
        return jsonResponse({ error: 'Ticket expired or already redeemed.' }, 410, request, env);
      }
      const record = await redeemRes.json();
      return jsonResponse(
        {
          access_token: record.access_token || '',
          refresh_token: record.refresh_token || '',
          expires_in: record.expires_in || 3600,
          email: record.email || '',
          session_proof: record.session_proof || '',
        },
        200,
        request,
        env
      );
    }

    if (url.pathname === '/oauth/refresh' && request.method === 'POST') {
      if (!checkRateLimit(request)) {
        return jsonResponse({ error: 'Too many requests.' }, 429, request, env);
      }
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.STATE_SIGNING_SECRET) {
        return jsonResponse({ error: 'OAuth worker secrets not configured.' }, 500, request, env);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON request body.' }, 400, request, env);
      }

      const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token.trim() : '';
      const sessionProof = typeof body?.session_proof === 'string' ? body.session_proof.trim() : '';
      if (!refreshToken || refreshToken.length > 512) {
        return jsonResponse({ error: 'Valid refresh_token is required.' }, 400, request, env);
      }
      const validProof = await verifyTokenProof(
        refreshToken,
        sessionProof,
        env.STATE_SIGNING_SECRET
      );
      if (!validProof) {
        return jsonResponse({ error: 'Invalid session proof.' }, 403, request, env);
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
      if (!checkRateLimit(request)) {
        return jsonResponse({ error: 'Too many requests.' }, 429, request, env);
      }
      if (!env.STATE_SIGNING_SECRET) {
        return jsonResponse({ error: 'OAuth worker secrets not configured.' }, 500, request, env);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON request body.' }, 400, request, env);
      }

      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      const sessionProof = typeof body?.session_proof === 'string' ? body.session_proof.trim() : '';
      if (!token || token.length > 2048) {
        return jsonResponse({ error: 'Valid token is required.' }, 400, request, env);
      }
      const validProof = await verifyTokenProof(token, sessionProof, env.STATE_SIGNING_SECRET);
      if (!validProof) {
        return jsonResponse({ error: 'Invalid session proof.' }, 403, request, env);
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
