// Shared helpers of the SOCKS5 proxy: the Telegram-only
// destination allowlist, an exact-length reader, and a two-way relay.
'use strict';

const net = require('net');
const crypto = require('crypto');
const { TELEGRAM_CIDRS, TELEGRAM_PORTS } = require('../config');

const CONNECT_TIMEOUT_MS = 10 * 1000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// ----- Address allowlist -----

const v4ToGroups = (text) => {
  const [a, b, c, d] = text.split('.').map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
};

// Parses an IP address into { bits, value } (BigInt). IPv4-mapped IPv6 counts as IPv4.
function parseIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    return { bits: 32, value: ip.split('.').reduce((acc, octet) => (acc << 8n) + BigInt(octet), 0n) };
  }
  if (family !== 6) return null;
  const [left, right] = ip.split('::');
  const split = (s) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? v4ToGroups(g) : [g])) : []);
  const head = split(left);
  const tail = right === undefined ? [] : split(right);
  const fill = right === undefined ? 0 : 8 - head.length - tail.length;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  const value = groups.reduce((acc, g) => (acc << 16n) + BigInt('0x' + g), 0n);
  if (value >> 32n === 0xffffn) return { bits: 32, value: value & 0xffffffffn };
  return { bits: 128, value };
}

const RANGES = TELEGRAM_CIDRS.map((cidr) => {
  const [base, prefix] = cidr.split('/');
  const parsed = parseIp(base);
  return { bits: parsed.bits, value: parsed.value, shift: BigInt(parsed.bits - Number(prefix)) };
});

function isTelegramAddress(ip) {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return RANGES.some((r) => r.bits === parsed.bits && parsed.value >> r.shift === r.value >> r.shift);
}

const isTelegramPort = (port) => TELEGRAM_PORTS.includes(port);

// Constant-time string comparison; strings of different byte length are unequal.
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ----- Connections -----

// Connects to an allowed destination. Rejects with an Error carrying `.reason`
// ('denied' for a destination outside Telegram, 'failed' for a connect error).
function openTarget(host, port) {
  return new Promise((resolve, reject) => {
    if (!isTelegramAddress(host) || !isTelegramPort(port)) {
      console.log(`[proxy] destination denied: ${host}:${port}`);
      const err = new Error('destination not allowed');
      err.reason = 'denied';
      return reject(err);
    }
    const target = net.connect({ host, port });
    target.setNoDelay(true);
    const fail = (err) => {
      console.log(`[proxy] connect failed: ${host}:${port} (${err.code || err.message})`);
      target.destroy();
      err.reason = 'failed';
      reject(err);
    };
    target.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('connect timeout')));
    target.once('error', fail);
    target.once('connect', () => {
      target.setTimeout(0);
      target.removeListener('error', fail);
      resolve(target);
    });
  });
}

// Reads exact byte counts from a socket. release() hands back unread bytes and stops listening.
function createReader(socket) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  let closed = false;
  const settle = () => {
    if (!waiting) return;
    if (buf.length >= waiting.n) {
      const out = buf.subarray(0, waiting.n);
      buf = buf.subarray(waiting.n);
      const { resolve } = waiting;
      waiting = null;
      resolve(out);
    } else if (closed) {
      const { reject } = waiting;
      waiting = null;
      reject(new Error('closed'));
    }
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    settle();
  };
  const onClose = () => {
    closed = true;
    settle();
  };
  socket.on('data', onData);
  socket.on('close', onClose);
  return {
    read(n) {
      return new Promise((resolve, reject) => {
        waiting = { n, resolve, reject };
        settle();
      });
    },
    release() {
      socket.pause();
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      return buf;
    },
  };
}

// Pipes two sockets into each other, counting bytes, until either side closes.
function relay(client, target, meter) {
  client.on('data', (chunk) => meter.up(chunk.length));
  target.on('data', (chunk) => meter.down(chunk.length));
  const end = () => {
    client.destroy();
    target.destroy();
    meter.close();
  };
  client.on('close', end);
  target.on('close', end);
  client.on('error', () => {});
  target.on('error', () => {});
  client.setTimeout(IDLE_TIMEOUT_MS, end);
  client.pipe(target);
  target.pipe(client);
  client.resume();
}

module.exports = { isTelegramAddress, isTelegramPort, safeEqual, openTarget, createReader, relay, IDLE_TIMEOUT_MS };
