// Bridge page of the web proxy: a tiny self-contained page that Telegram's hidden
// WebView opens at "/?bridge=<capability>". It joins Telegram's TelegramWebProxy
// boundary to the WebSocket relay (see relay.js).
'use strict';

const crypto = require('crypto');
const { PATH, WS_SUBPROTOCOL } = require('../config');
const { MAC_LENGTH, TOKEN_SCOPE, bridgeCap, issueToken, safeEqual } = require('../tokens');
const { HTML_TYPE, HTML_START, BASE_HEADERS } = require('./pages');

const TOKEN_SECONDS = 120; // relay token lifetime
const FRAME_HEADER = 8;

// True for exactly one query parameter, "bridge", holding the capability derived from the hostname and secret.
function isBridge(req) {
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  const keys = Array.from(params.keys());
  const value = params.get('bridge') || '';
  if (keys.length !== 1 || keys[0] !== 'bridge' || value.length !== MAC_LENGTH) return false;
  return safeEqual(value, bridgeCap(req.hostname));
}

function sendBridge(req, res) {
  const nonce = crypto.randomBytes(9).toString('base64url');
  const token = issueToken(TOKEN_SCOPE.ws, TOKEN_SECONDS);
  const args = [token, PATH.ws, WS_SUBPROTOCOL, FRAME_HEADER].map((v) => JSON.stringify(v)).join(',');
  const html =
    HTML_START +
    '<title>Notes</title></head><body>' +
    '<script nonce="' + nonce + '">(' + bridgeMain.toString() + ')(' + args + ');</script></body></html>';
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "child-src 'none'",
    "connect-src 'self' wss://" + req.hostname,
    "font-src 'none'",
    "form-action 'none'",
    'frame-ancestors http://127.0.0.1:*',
    "frame-src 'none'",
    "img-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "script-src 'nonce-" + nonce + "'",
    "style-src 'none'",
    "worker-src 'none'",
    'sandbox allow-same-origin allow-scripts',
  ].join('; ');
  res
    .set({ ...BASE_HEADERS, 'Content-Type': HTML_TYPE, 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': csp })
    .send(html);
}

// Bridge page script (runs inside Telegram's hidden WebView, serialized by sendBridge).
// Joins the app's TelegramWebProxy boundary to the WebSocket relay. It must stay self-contained
// and written in ES5 for old WebViews.
function bridgeMain(token, wsPath, subprotocol, frameHeader) {
  var HELLO = 0x10,
    WELCOME = 0x11;
  var port = window.TelegramWebProxy;
  var match = /^#android=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (!port || !match) return;
  try {
    history.replaceState(null, "", location.pathname);
  } catch (e) {
    /* ignored */
  }
  var ws = null,
    ready = false,
    dead = false,
    queue = [];

  function toApp(value) {
    try {
      port.postMessage(value);
    } catch (e) {
      /* ignored */
    }
  }
  function fail() {
    if (dead) return;
    dead = true;
    try {
      if (ws) ws.close();
    } catch (e) {
      /* ignored */
    }
    toApp(JSON.stringify({ t: "close" }));
  }
  // Accepts an ArrayBuffer, a typed array, or an event-like object that carries one.
  function asBytes(value) {
    if (
      value &&
      value.data !== undefined &&
      !(value instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(value)
    )
      value = value.data;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value))
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }
  // Calls handle(frame) for every complete shared frame in bytes; returns false on a malformed batch.
  function eachFrame(bytes, handle) {
    for (var o = 0; o < bytes.length; ) {
      if (o + frameHeader > bytes.length) return false;
      var len =
        ((bytes[o + 4] << 24) |
          (bytes[o + 5] << 16) |
          (bytes[o + 6] << 8) |
          bytes[o + 7]) >>>
        0;
      if (o + frameHeader + len > bytes.length) return false;
      handle(bytes.slice(o, o + frameHeader + len));
      o += frameHeader + len;
    }
    return true;
  }

  function openSocket() {
    if (ws) return;
    ws = new WebSocket("wss://" + location.host + wsPath, [
      subprotocol + token,
    ]);
    ws.binaryType = "arraybuffer";
    ws.onopen = function () {
      ready = true;
      queue.forEach(function (frame) {
        ws.send(frame);
      });
      queue = [];
      // The server has no session endpoint, so the bridge answers HELLO itself.
      var welcome = new Uint8Array(frameHeader);
      welcome[0] = WELCOME;
      toApp(welcome.buffer);
    };
    ws.onmessage = function (event) {
      var bytes = typeof event.data === "string" ? null : asBytes(event.data);
      if (
        !bytes ||
        !eachFrame(bytes, function (frame) {
          toApp(frame.buffer);
        })
      )
        fail();
    };
    ws.onclose = fail;
    ws.onerror = fail;
  }

  port.onmessage = function (value) {
    var bytes = asBytes(value);
    if (!bytes || dead) return; // control values from the app need no handling
    var ok = eachFrame(bytes, function (frame) {
      if (frame[0] === HELLO) openSocket();
      else if (ready) ws.send(frame);
      else queue.push(frame);
    });
    if (!ok) fail();
  };
  toApp(JSON.stringify({ t: "tproxy-android-init", v: 1, nonce: match[1] }));
}

module.exports = { isBridge, sendBridge };
