// worker.js — hashes Blobs off the main thread (classic worker, no imports, no network).
// Files are read in slices through the File API so even multi-gigabyte files never sit in memory at once.
// MD5, SHA-1, SHA-256, SHA-384 and SHA-512 are small incremental implementations written for this tool.
// Inputs up to NATIVE_LIMIT use WebCrypto's native digest for the SHA family (faster); MD5 is always ours.
'use strict';

const TWO32 = 4294967296;
const NATIVE_LIMIT = 64 * 1024 * 1024;
const subtle = self.crypto && self.crypto.subtle;

// ---------- Constants, derived from first principles instead of typed-in tables ----------
// SHA-2 constants are the fractional bits of square / cube roots of the first primes (FIPS 180-4).
function bitLength(n) { return n.toString(2).length; }
function isqrt(n) {
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 2) + 1);
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
}
function icbrt(n) {
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 3) + 1);
  for (;;) { const y = (2n * x + n / (x * x)) / 3n; if (y >= x) return x; x = y; }
}
const PRIMES = [];
for (let n = 2; PRIMES.length < 80; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const MASK64 = (1n << 64n) - 1n;
function pairs(values) {
  const out = new Int32Array(values.length * 2);
  values.forEach((v, i) => { out[i * 2] = Number(v >> 32n); out[i * 2 + 1] = Number(v & 0xffffffffn); });
  return out;
}
const K512 = pairs(PRIMES.map((p) => icbrt(BigInt(p) << 192n) & MASK64));
const IV512 = pairs(PRIMES.slice(0, 8).map((p) => isqrt(BigInt(p) << 128n) & MASK64));
const IV384 = pairs(PRIMES.slice(8, 16).map((p) => isqrt(BigInt(p) << 128n) & MASK64));
const K256 = Int32Array.from({ length: 64 }, (_, i) => K512[i * 2]);
const IV256 = Int32Array.from({ length: 8 }, (_, i) => IV512[i * 2]);
const MD5K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * TWO32));
const MD5S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

// ---------- Shared block buffering and padding ----------
class BlockHash {
  constructor(size) {
    this.size = size;
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
    this.len = 0;
  }
  update(data) {
    const size = this.size, n = data.length;
    let i = 0;
    this.len += n;
    if (this.pos) {
      i = Math.min(size - this.pos, n);
      this.buf.set(data.subarray(0, i), this.pos);
      this.pos += i;
      if (this.pos === size) { this.block(this.view, 0); this.pos = 0; }
    }
    if (n - i >= size) {
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (; i + size <= n; i += size) this.block(v, i);
    }
    if (i < n) { this.buf.set(data.subarray(i), 0); this.pos = n - i; }
    return this;
  }
  pad(littleEndian) {
    const lenBytes = this.size === 128 ? 16 : 8;
    const tail = new Uint8Array((this.pos + 1 + lenBytes <= this.size ? this.size : 2 * this.size) - this.pos);
    tail[0] = 0x80;
    const bits = this.len * 8, v = new DataView(tail.buffer);
    const hi = Math.floor(bits / TWO32), lo = bits >>> 0;
    if (littleEndian) { v.setUint32(tail.length - 8, lo, true); v.setUint32(tail.length - 4, hi, true); }
    else { v.setUint32(tail.length - 8, hi); v.setUint32(tail.length - 4, lo); }
    this.update(tail);
  }
  words(count, littleEndian) {
    const out = new Uint8Array(count * 4), v = new DataView(out.buffer);
    for (let i = 0; i < count; i++) v.setInt32(i * 4, this.H[i], littleEndian);
    return out;
  }
}

class MD5 extends BlockHash {
  constructor() { super(64); this.H = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476); this.M = new Int32Array(16); }
  block(v, o) {
    const M = this.M, H = this.H;
    for (let i = 0; i < 16; i++) M[i] = v.getInt32(o + i * 4, true);
    let a = H[0], b = H[1], c = H[2], d = H[3];
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const s = MD5S[(i >> 4) * 4 + (i & 3)];
      const t = (a + f + MD5K[i] + M[g]) | 0;
      a = d; d = c; c = b;
      b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  }
  digest() { this.pad(true); return this.words(4, true); }
}

class SHA1 extends BlockHash {
  constructor() { super(64); this.H = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0); this.W = new Int32Array(80); }
  block(v, o) {
    const W = this.W, H = this.H;
    for (let i = 0; i < 16; i++) W[i] = v.getInt32(o + i * 4);
    for (let i = 16; i < 80; i++) { const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16]; W[i] = (x << 1) | (x >>> 31); }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc | 0; }
      else { f = b ^ c ^ d; k = 0xca62c1d6 | 0; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + W[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
  }
  digest() { this.pad(false); return this.words(5, false); }
}

class SHA256 extends BlockHash {
  constructor() { super(64); this.H = IV256.slice(); this.W = new Int32Array(64); }
  block(v, o) {
    const W = this.W, H = this.H;
    for (let i = 0; i < 16; i++) W[i] = v.getInt32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  digest() { this.pad(false); return this.words(8, false); }
}

// SHA-512 works on 64-bit words, kept as (high, low) pairs of 32-bit ints. SHA-384 is the same with another IV.
class SHA512 extends BlockHash {
  constructor(is384) { super(128); this.out = is384 ? 12 : 16; this.H = (is384 ? IV384 : IV512).slice(); this.W = new Int32Array(160); }
  block(v, o) {
    const W = this.W, H = this.H;
    for (let i = 0; i < 32; i++) W[i] = v.getInt32(o + i * 4);
    for (let t = 16; t < 80; t++) {
      let h = W[(t - 15) * 2], l = W[(t - 15) * 2 + 1];
      const s0h = ((h >>> 1) | (l << 31)) ^ ((h >>> 8) | (l << 24)) ^ (h >>> 7);
      const s0l = ((l >>> 1) | (h << 31)) ^ ((l >>> 8) | (h << 24)) ^ ((l >>> 7) | (h << 25));
      h = W[(t - 2) * 2]; l = W[(t - 2) * 2 + 1];
      const s1h = ((h >>> 19) | (l << 13)) ^ ((l >>> 29) | (h << 3)) ^ (h >>> 6);
      const s1l = ((l >>> 19) | (h << 13)) ^ ((h >>> 29) | (l << 3)) ^ ((l >>> 6) | (h << 26));
      const lo = (s0l >>> 0) + (s1l >>> 0) + (W[(t - 7) * 2 + 1] >>> 0) + (W[(t - 16) * 2 + 1] >>> 0);
      W[t * 2] = s0h + s1h + W[(t - 7) * 2] + W[(t - 16) * 2] + ((lo / TWO32) | 0);
      W[t * 2 + 1] = lo;
    }
    let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
    let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (let t = 0; t < 80; t++) {
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chH = (eh & fh) ^ (~eh & gh), chL = (el & fl) ^ (~el & gl);
      let lo = (hl >>> 0) + (S1l >>> 0) + (chL >>> 0) + (K512[t * 2 + 1] >>> 0) + (W[t * 2 + 1] >>> 0);
      const t1h = (hh + S1h + chH + K512[t * 2] + W[t * 2] + ((lo / TWO32) | 0)) | 0, t1l = lo | 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const majH = (ah & bh) ^ (ah & ch) ^ (bh & ch), majL = (al & bl) ^ (al & cl) ^ (bl & cl);
      lo = (S0l >>> 0) + (majL >>> 0);
      const t2h = (S0h + majH + ((lo / TWO32) | 0)) | 0, t2l = lo | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      lo = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + ((lo / TWO32) | 0)) | 0; el = lo | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      lo = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + ((lo / TWO32) | 0)) | 0; al = lo | 0;
    }
    const regs = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
    for (let i = 0; i < 16; i += 2) {
      const lo = (H[i + 1] >>> 0) + (regs[i + 1] >>> 0);
      H[i] = H[i] + regs[i] + ((lo / TWO32) | 0);
      H[i + 1] = lo;
    }
  }
  digest() { this.pad(false); return this.words(this.out, false); }
}

const ALGOS = {
  md5: () => new MD5(),
  sha1: () => new SHA1(),
  sha256: () => new SHA256(),
  sha384: () => new SHA512(true),
  sha512: () => new SHA512(false),
};
const NATIVE = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function hashBlob({ id, blob, algos, slice, forceJs }) {
  const size = blob.size;
  const native = !forceJs && subtle && size <= NATIVE_LIMIT ? algos.filter((a) => NATIVE[a]) : [];
  const hashers = algos.filter((a) => !native.includes(a)).map((a) => [a, ALGOS[a]()]);
  const whole = native.length ? new Uint8Array(size) : null;
  let done = 0;
  while (done < size) {
    const chunk = new Uint8Array(await blob.slice(done, Math.min(size, done + slice)).arrayBuffer());
    if (!chunk.length) throw new DOMException('The file changed or shrank while it was being read.', 'NotReadableError');
    for (const [, h] of hashers) h.update(chunk);
    if (whole) whole.set(chunk, done);
    done += chunk.length;
    self.postMessage({ type: 'progress', id, done, total: size });
  }
  const digests = {};
  for (const [a, h] of hashers) digests[a] = h.digest();
  for (const a of native) digests[a] = new Uint8Array(await subtle.digest(NATIVE[a], whole));
  return { digests, engine: native.length ? 'native' : 'js' };
}

// Cross-check our code against the known "abc" vectors and against WebCrypto (also across block boundaries).
async function selfTest() {
  const failures = [];
  const known = {
    md5: '900150983cd24fb0d6963f7d28e17f72',
    sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  };
  const abc = new Uint8Array([97, 98, 99]);
  const long = Uint8Array.from({ length: 1000 }, (_, i) => (i * 31 + 7) & 255);
  for (const a of Object.keys(ALGOS)) {
    if (known[a] && hex(ALGOS[a]().update(abc).digest()) !== known[a]) failures.push(a);
    if (NATIVE[a] && subtle) {
      const split = ALGOS[a]().update(long.subarray(0, 1)).update(long.subarray(1, 130)).update(long.subarray(130)).digest();
      const ref = new Uint8Array(await subtle.digest(NATIVE[a], long));
      if (hex(split) !== hex(ref) && !failures.includes(a)) failures.push(a);
    }
  }
  self.postMessage({ type: 'selftest', ok: failures.length === 0, failures });
}

let queue = selfTest().catch((err) => self.postMessage({ type: 'selftest', ok: false, failures: [String(err)] }));
self.onmessage = (event) => {
  const job = event.data;
  if (!job || job.type !== 'hash') return;
  queue = queue.then(async () => {
    try {
      const { digests, engine } = await hashBlob(job);
      self.postMessage({ type: 'result', id: job.id, digests, engine });
    } catch (err) {
      self.postMessage({ type: 'error', id: job.id, name: err && err.name, message: err && err.message ? err.message : String(err) });
    }
  });
};
