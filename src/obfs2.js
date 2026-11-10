// Obfuscated2 handshake shared by the web relay and the MTProto proxy.
// The client sends a 64-byte header whose keys are derived with the proxy
// secret; this module reads it and builds the header for the Telegram DC.
// Header layout: 8 random | 32 key | 16 IV | 4 transport tag | 2 DC id | 2 random.
'use strict';

const crypto = require('crypto');
const { TG_DC } = require('./config');

// MTProto transport tags: abridged, intermediate, padded intermediate.
const TAG_ABRIDGED = 0xef;
const TRANSPORT_TAGS = [0xef, 0xee, 0xdd];
// First words (little-endian) Telegram reserves for other protocols: HEAD, POST, "GET ", OPTI, and the repeated tags.
const RESERVED_WORDS = [0x44414548, 0x54534f50, 0x20544547, 0x4954504f, 0xeeeeeeee, 0xdddddddd];
const INIT_SIZE = 64;
const INIT_KEY = 8;
const INIT_TAG = 56;
const INIT_DC = 60;
const KEY_SIZE = 32;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest();
// AES-256-CTR keeps its position between update() calls, so a stream can be processed chunk by chunk.
const ctr = (key, iv) => crypto.createCipheriv('aes-256-ctr', key, iv);

// Random 64-byte header that avoids the byte patterns Telegram reserves for other transports.
function freshInit() {
  for (;;) {
    const init = crypto.randomBytes(INIT_SIZE);
    if (
      init[0] !== TAG_ABRIDGED &&
      !RESERVED_WORDS.includes(init.readUInt32LE(0)) &&
      init.readUInt32LE(4) !== 0
    ) {
      return init;
    }
  }
}

// Reads the client's 64-byte header (keys derived with `secret`) and prepares the DC side.
// Returns { host, first, toDc }:
//   host  - Telegram DC address to connect to
//   first - the 64 bytes to send to the DC before anything else
//   toDc  - function that turns client bytes into DC bytes (call in stream order)
// Data coming back from the DC needs no re-encryption (see the shortcut below).
// Throws on an unknown transport or DC.
function openObfs2(head, secret) {
  const material = head.subarray(INIT_KEY, INIT_TAG); // key + IV
  const cIn = ctr(sha256(Buffer.concat([material.subarray(0, KEY_SIZE), secret])), material.subarray(KEY_SIZE));
  const plain = cIn.update(head);
  const tag = plain[INIT_TAG];
  if (!TRANSPORT_TAGS.includes(tag) || !plain.subarray(INIT_TAG, INIT_DC).every((b) => b === tag)) {
    throw new Error('bad transport');
  }
  const host = TG_DC[Math.abs(plain.readInt16LE(INIT_DC))];
  if (!host) throw new Error('bad dc');

  // Downstream shortcut: the DC encrypts with the reversed key + IV of its own header. Writing the reversed
  // client downstream key + IV there makes the DC keystream equal the one the client expects.
  const reversed = Buffer.from(material).reverse();
  const toClientKey = sha256(Buffer.concat([reversed.subarray(0, KEY_SIZE), secret]));
  const toClientIv = reversed.subarray(KEY_SIZE);
  const init = freshInit();
  Buffer.concat([toClientKey, toClientIv]).reverse().copy(init, INIT_KEY);
  plain.copy(init, INIT_TAG, INIT_TAG, INIT_DC + 2); // same transport tag and DC id the client asked for

  const dOut = ctr(init.subarray(INIT_KEY, INIT_KEY + KEY_SIZE), init.subarray(INIT_KEY + KEY_SIZE, INIT_TAG));
  const sealed = dOut.update(init);
  const first = Buffer.from(init);
  sealed.copy(first, INIT_TAG, INIT_TAG); // bytes 56..63 are sent encrypted, the rest as is
  return { host, first, toDc: (data) => dOut.update(cIn.update(data)) };
}

module.exports = { INIT_SIZE, openObfs2 };
