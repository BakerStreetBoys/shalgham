// Builds a QR code (byte mode, error correction M, versions 1-10) and returns it as an SVG string.
// Standalone, no dependencies. Ported unchanged from CF Proxy.
function qrSvg(text) {
  var data = Array.prototype.slice.call(new TextEncoder().encode(text));
  var ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // ECC codewords per block, level M
  var BLK = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]; // number of blocks, level M
  var i, j, k;

  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) {
      var n = Math.floor(v / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (v >= 7) r -= 36;
    }
    return r;
  }

  // Pick the smallest version that fits.
  var ver, cap;
  for (ver = 1; ver <= 10; ver++) {
    cap = Math.floor(rawModules(ver) / 8) - ECC[ver] * BLK[ver];
    if (Math.ceil((4 + (ver < 10 ? 8 : 16) + data.length * 8) / 8) <= cap)
      break;
  }
  if (ver > 10) throw new Error("Text too long for QR code");

  // Data bits: mode, length, payload, terminator, padding.
  var bits = [];
  function put(val, len) {
    for (var b = len - 1; b >= 0; b--) bits.push((val >>> b) & 1);
  }
  put(4, 4);
  put(data.length, ver < 10 ? 8 : 16);
  data.forEach(function (byte) {
    put(byte, 8);
  });
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  for (var pad = 0xec; bits.length < cap * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  var words = [];
  for (i = 0; i < bits.length; i += 8) {
    var w = 0;
    for (j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
    words.push(w);
  }

  // Reed-Solomon error correction over GF(256).
  function mul(x, y) {
    var z = 0;
    for (var b = 7; b >= 0; b--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> b) & 1) * x;
    }
    return z;
  }
  function divisor(deg) {
    var r = [],
      root = 1,
      a,
      b;
    for (a = 0; a < deg; a++) r.push(0);
    r[deg - 1] = 1;
    for (a = 0; a < deg; a++) {
      for (b = 0; b < deg; b++) {
        r[b] = mul(r[b], root);
        if (b + 1 < deg) r[b] ^= r[b + 1];
      }
      root = mul(root, 2);
    }
    return r;
  }
  function remainder(block, div) {
    var r = div.map(function () {
      return 0;
    });
    block.forEach(function (byte) {
      var f = byte ^ r.shift();
      r.push(0);
      div.forEach(function (c, n) {
        r[n] ^= mul(c, f);
      });
    });
    return r;
  }

  // Split into blocks, add ECC, interleave.
  var nBlocks = BLK[ver],
    eccLen = ECC[ver];
  var rawWords = Math.floor(rawModules(ver) / 8);
  var shortCount = nBlocks - (rawWords % nBlocks),
    shortLen = Math.floor(rawWords / nBlocks);
  var blocks = [],
    div = divisor(eccLen),
    pos = 0;
  for (i = 0; i < nBlocks; i++) {
    var dat = words.slice(
      pos,
      pos + shortLen - eccLen + (i < shortCount ? 0 : 1),
    );
    pos += dat.length;
    var ecc = remainder(dat, div);
    if (i < shortCount) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  var codewords = [];
  for (i = 0; i < blocks[0].length; i++) {
    blocks.forEach(function (blk, n) {
      if (i !== shortLen - eccLen || n >= shortCount) codewords.push(blk[i]);
    });
  }

  // Module matrix with function patterns.
  var size = ver * 4 + 17,
    mod = [],
    fn = [];
  for (i = 0; i < size; i++) {
    mod.push(new Array(size).fill(false));
    fn.push(new Array(size).fill(false));
  }
  function setFn(x, y, dark) {
    mod[y][x] = dark;
    fn[y][x] = true;
  }
  for (i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  function finder(cx, cy) {
    for (var dy = -4; dy <= 4; dy++)
      for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)),
          x = cx + dx,
          y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size)
          setFn(x, y, d !== 2 && d !== 4);
      }
  }
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  if (ver > 1) {
    var na = Math.floor(ver / 7) + 2,
      step = Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2,
      ap = [6];
    for (var p = size - 7; ap.length < na; p -= step) ap.splice(1, 0, p);
    ap.forEach(function (cy, a) {
      ap.forEach(function (cx, b) {
        if (
          (a === 0 && b === 0) ||
          (a === 0 && b === na - 1) ||
          (a === na - 1 && b === 0)
        )
          return;
        for (var dy = -2; dy <= 2; dy++)
          for (var dx = -2; dx <= 2; dx++) {
            setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
      });
    });
  }
  function drawFormat(mask) {
    var r = mask;
    for (var n = 0; n < 10; n++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    var f = ((mask << 10) | r) ^ 0x5412;
    function g(n2) {
      return ((f >>> n2) & 1) !== 0;
    }
    for (var a = 0; a <= 5; a++) setFn(8, a, g(a));
    setFn(8, 7, g(6));
    setFn(8, 8, g(7));
    setFn(7, 8, g(8));
    for (var b = 9; b < 15; b++) setFn(14 - b, 8, g(b));
    for (var c = 0; c < 8; c++) setFn(size - 1 - c, 8, g(c));
    for (var d = 8; d < 15; d++) setFn(8, size - 15 + d, g(d));
    setFn(8, size - 8, true);
  }
  drawFormat(0);
  if (ver >= 7) {
    var vr = ver;
    for (i = 0; i < 12; i++) vr = (vr << 1) ^ ((vr >>> 11) * 0x1f25);
    var vbits = (ver << 12) | vr;
    for (i = 0; i < 18; i++) {
      var vc = ((vbits >>> i) & 1) !== 0,
        va = size - 11 + (i % 3),
        vb = Math.floor(i / 3);
      setFn(va, vb, vc);
      setFn(vb, va, vc);
    }
  }

  // Place data bits in the zigzag order.
  var bit = 0;
  for (var right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (var vert = 0; vert < size; vert++) {
      for (j = 0; j < 2; j++) {
        var x = right - j,
          y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x] && bit < codewords.length * 8) {
          mod[y][x] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) !== 0;
          bit++;
        }
      }
    }
  }

  function applyMask(m) {
    for (var y = 0; y < size; y++)
      for (var x = 0; x < size; x++) {
        if (fn[y][x]) continue;
        var inv;
        switch (m) {
          case 0:
            inv = (x + y) % 2 === 0;
            break;
          case 1:
            inv = y % 2 === 0;
            break;
          case 2:
            inv = x % 3 === 0;
            break;
          case 3:
            inv = (x + y) % 3 === 0;
            break;
          case 4:
            inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            inv = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (inv) mod[y][x] = !mod[y][x];
      }
  }
  // Penalty for runs of 5 or more equal modules along every line; at(line, pos) reads one module.
  function runScore(at) {
    var s = 0,
      line,
      pos,
      run;
    for (line = 0; line < size; line++) {
      run = 1;
      for (pos = 1; pos < size; pos++) {
        if (at(line, pos) === at(line, pos - 1)) {
          run++;
          if (run === 5) s += 3;
          else if (run > 5) s++;
        } else run = 1;
      }
    }
    return s;
  }
  // Simplified penalty score: runs (rows, then columns), 2x2 blocks, dark/light balance.
  function penalty() {
    var s =
      runScore(function (y, x) {
        return mod[y][x];
      }) +
      runScore(function (x, y) {
        return mod[y][x];
      });
    var dark = 0,
      x,
      y;
    for (y = 0; y < size - 1; y++)
      for (x = 0; x < size - 1; x++) {
        var c = mod[y][x];
        if (
          c === mod[y][x + 1] &&
          c === mod[y + 1][x] &&
          c === mod[y + 1][x + 1]
        )
          s += 3;
      }
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mod[y][x]) dark++;
    return (
      s +
      (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) *
        10
    );
  }
  var best = 0,
    bestScore = Infinity;
  for (k = 0; k < 8; k++) {
    applyMask(k);
    drawFormat(k);
    var score = penalty();
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
    applyMask(k);
  }
  applyMask(best);
  drawFormat(best);

  // Render as SVG with a 4-module quiet zone.
  var q = 4,
    d = "",
    total = size + q * 2;
  for (var yy = 0; yy < size; yy++)
    for (var xx = 0; xx < size; xx++) {
      if (mod[yy][xx]) d += "M" + (xx + q) + " " + (yy + q) + "h1v1h-1z";
    }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    total +
    " " +
    total +
    '" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/>' +
    '<path d="' +
    d +
    '" fill="#000"/></svg>'
  );
}
