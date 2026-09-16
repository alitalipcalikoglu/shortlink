import { deflateSync } from 'node:zlib';

/**
 * QR code encoder (byte mode, error correction level M, versions 1–10, up to 213 bytes of text)
 * implementing ISO/IEC 18004: data codewords, Reed–Solomon blocks, interleaving, module
 * placement, mask selection by penalty, format information. No dependencies; the same
 * encoder was verified against an independent implementation module by module.
 */
export class QrCode {
  /** Byte capacity of the largest supported version at level M. */
  static MAX_BYTES = 213;

  /** Total codewords and (EC codewords per block, blocks in group 1, data codewords per block g1, blocks g2, data g2) for level M. */
  static VERSIONS = [
    null,
    { total: 26, ec: 10, g1: 1, d1: 16, g2: 0, d2: 0 },
    { total: 44, ec: 16, g1: 1, d1: 28, g2: 0, d2: 0 },
    { total: 70, ec: 26, g1: 1, d1: 44, g2: 0, d2: 0 },
    { total: 100, ec: 18, g1: 2, d1: 32, g2: 0, d2: 0 },
    { total: 134, ec: 24, g1: 2, d1: 43, g2: 0, d2: 0 },
    { total: 172, ec: 16, g1: 4, d1: 27, g2: 0, d2: 0 },
    { total: 196, ec: 18, g1: 4, d1: 31, g2: 0, d2: 0 },
    { total: 242, ec: 22, g1: 2, d1: 38, g2: 2, d2: 39 },
    { total: 292, ec: 22, g1: 3, d1: 36, g2: 2, d2: 37 },
    { total: 346, ec: 26, g1: 4, d1: 43, g2: 1, d2: 44 },
  ];
  static ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  /** @type {number[]} */ static EXP = [];
  /** @type {number[]} */ static LOG = [];
  static {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      QrCode.EXP[i] = x;
      QrCode.LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) QrCode.EXP[i] = QrCode.EXP[i - 255];
  }

  /** @param {string} text */
  constructor(text) {
    this.data = new TextEncoder().encode(text);
    this.version = QrCode.#pickVersion(this.data.length);
    this.size = this.version * 4 + 17;
    /** @type {(0|1)[][]} */
    this.modules = Array.from({ length: this.size }, () => Array(this.size).fill(0));
    /** @type {boolean[][]} */
    this.reserved = Array.from({ length: this.size }, () => Array(this.size).fill(false));
    this.#placeFunctionPatterns();
    this.#placeData(this.#codewords());
    this.mask = this.#applyBestMask();
    this.#placeFormat(this.mask);
  }

  /** @param {number} len */
  static #pickVersion(len) {
    for (let v = 1; v <= 10; v++) {
      const spec = /** @type {NonNullable<typeof QrCode.VERSIONS[number]>} */ (QrCode.VERSIONS[v]);
      const dataCw = spec.total - spec.ec * (spec.g1 + spec.g2);
      const headerBits = 4 + (v <= 9 ? 8 : 16);
      if (Math.ceil((headerBits + len * 8) / 8) <= dataCw) return v;
    }
    throw new QrTooLongError(len);
  }

  #codewords() {
    const spec = /** @type {NonNullable<typeof QrCode.VERSIONS[number]>} */ (QrCode.VERSIONS[this.version]);
    const dataCw = spec.total - spec.ec * (spec.g1 + spec.g2);
    /** @type {number[]} */
    const bits = [];
    const push = (/** @type {number} */ val, /** @type {number} */ n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4);
    push(this.data.length, this.version <= 9 ? 8 : 16);
    for (const b of this.data) push(b, 8);
    push(0, Math.min(4, dataCw * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; bytes.length < dataCw; pad ^= 0xec ^ 0x11) bytes.push(pad);

    /** @type {number[][]} */ const blocks = [];
    /** @type {number[][]} */ const ecBlocks = [];
    let offset = 0;
    for (let g = 0; g < 2; g++) {
      const count = g === 0 ? spec.g1 : spec.g2;
      const len = g === 0 ? spec.d1 : spec.d2;
      for (let b = 0; b < count; b++) {
        const block = bytes.slice(offset, offset + len);
        offset += len;
        blocks.push(block);
        ecBlocks.push(QrCode.#reedSolomon(block, spec.ec));
      }
    }
    const out = [];
    const maxLen = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < spec.ec; i++) for (const b of ecBlocks) out.push(b[i]);
    return out;
  }

  /**
   * @param {number[]} data
   * @param {number} ecLen
   */
  static #reedSolomon(data, ecLen) {
    let gen = [1];
    for (let i = 0; i < ecLen; i++) {
      const next = Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= QrCode.#mul(gen[j], QrCode.EXP[i]);
      }
      gen = next;
    }
    const rem = [...data, ...Array(ecLen).fill(0)];
    for (let i = 0; i < data.length; i++) {
      const coef = rem[i];
      if (coef === 0) continue;
      for (let j = 1; j < gen.length; j++) rem[i + j] ^= QrCode.#mul(gen[j], coef);
    }
    return rem.slice(data.length);
  }

  /** @param {number} a @param {number} b */
  static #mul(a, b) {
    return a === 0 || b === 0 ? 0 : QrCode.EXP[QrCode.LOG[a] + QrCode.LOG[b]];
  }

  /** @param {number} r @param {number} c @param {0|1} v */
  #set(r, c, v) {
    this.modules[r][c] = v;
    this.reserved[r][c] = true;
  }

  #placeFunctionPatterns() {
    const n = this.size;
    const finder = (/** @type {number} */ r0, /** @type {number} */ c0) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = r0 + r; const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        this.#set(rr, cc, on ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) { this.#set(6, i, i % 2 === 0 ? 1 : 0); this.#set(i, 6, i % 2 === 0 ? 1 : 0); }
    const centres = /** @type {number[]} */ (QrCode.ALIGN[this.version]);
    for (const r of centres) for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) this.#set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
    }
    // format information areas (filled later) and the dark module
    for (let i = 0; i < 8; i++) { this.reserved[8][i] = true; this.reserved[i][8] = true; this.reserved[8][n - 1 - i] = true; this.reserved[n - 1 - i][8] = true; }
    this.reserved[8][8] = true;
    this.#set(n - 8, 8, 1);
    // version information (versions 7+): two 6×3 blocks next to the top-right and bottom-left finders
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = /** @type {0|1} */ ((bits >>> i) & 1);
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.#set(a, b, bit);
        this.#set(b, a, bit);
      }
    }
  }

  /** @param {number[]} codewords */
  #placeData(codewords) {
    const n = this.size;
    let bitIndex = 0;
    const total = codewords.length * 8;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? n - 1 - vert : vert;
          if (this.reserved[r][c]) continue;
          const bit = bitIndex < total ? (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1 : 0;
          this.modules[r][c] = /** @type {0|1} */ (bit);
          bitIndex++;
        }
      }
    }
  }

  /** @param {number} mask @param {number} r @param {number} c */
  static #maskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }

  /** @param {number} mask */
  #toggleMask(mask) {
    for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) {
      if (!this.reserved[r][c] && QrCode.#maskBit(mask, r, c)) this.modules[r][c] = /** @type {0|1} */ (this.modules[r][c] ^ 1);
    }
  }

  #applyBestMask() {
    let best = 0;
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      this.#toggleMask(m);
      this.#placeFormat(m);
      const score = this.#penalty();
      if (score < bestScore) { bestScore = score; best = m; }
      this.#toggleMask(m);
    }
    this.#toggleMask(best);
    return best;
  }

  #penalty() {
    const n = this.size;
    const g = this.modules;
    let score = 0;
    const runPenalty = (/** @type {(i: number) => number} */ at) => {
      let run = 1;
      for (let i = 1; i < n; i++) {
        if (at(i) === at(i - 1)) { run++; if (i === n - 1 && run >= 5) score += run - 2; }
        else { if (run >= 5) score += run - 2; run = 1; }
      }
    };
    for (let r = 0; r < n; r++) runPenalty((i) => g[r][i]);
    for (let c = 0; c < n; c++) runPenalty((i) => g[i][c]);
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
      const v = g[r][c];
      if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) score += 3;
    }
    const pattern = [1, 0, 1, 1, 1, 0, 1];
    const check = (/** @type {(i: number) => number|undefined} */ at) => {
      for (let i = 0; i <= n - 7; i++) {
        let hit = true;
        for (let k = 0; k < 7; k++) if (at(i + k) !== pattern[k]) { hit = false; break; }
        if (!hit) continue;
        const before = [at(i - 4), at(i - 3), at(i - 2), at(i - 1)].every((x) => x === 0 || x === undefined);
        const after = [at(i + 7), at(i + 8), at(i + 9), at(i + 10)].every((x) => x === 0 || x === undefined);
        if (before || after) score += 40;
      }
    };
    for (let r = 0; r < n; r++) check((i) => (i >= 0 && i < n ? g[r][i] : undefined));
    for (let c = 0; c < n; c++) check((i) => (i >= 0 && i < n ? g[i][c] : undefined));
    let dark = 0;
    for (const row of g) for (const v of row) dark += v;
    const pct = (dark * 100) / (n * n);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  /** @param {number} mask */
  #placeFormat(mask) {
    const n = this.size;
    let data = (0b00 << 3) | mask; // level M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i < 15; i++) {
      const bit = /** @type {0|1} */ ((bits >>> i) & 1);
      // first copy: column 8 (rows 0-5, 7, 8) then row 8 (columns 7, 5-0)
      if (i < 6) this.modules[i][8] = bit;
      else if (i < 8) this.modules[i + 1][8] = bit;
      else if (i === 8) this.modules[8][7] = bit;
      else this.modules[8][14 - i] = bit;
      // second copy: row 8 right side (bits 0-7), column 8 bottom (bits 8-14)
      if (i < 8) this.modules[8][n - 1 - i] = bit;
      else this.modules[n - 15 + i][8] = bit;
    }
    this.modules[n - 8][8] = 1; // dark module, always set
  }

  /**
   * @param {{ margin?: number, dark?: string, light?: string }} [o]
   * @returns {string}
   */
  toSvg({ margin = 4, dark = '#000', light = '#fff' } = {}) {
    const n = this.size + margin * 2;
    let path = '';
    for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) if (this.modules[r][c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
  }

  /**
   * Grayscale PNG, `scale` pixels per module.
   * @param {{ margin?: number, scale?: number }} [o]
   * @returns {Buffer}
   */
  toPng({ margin = 4, scale = 8 } = {}) {
    const n = (this.size + margin * 2) * scale;
    const px = new Uint8Array(n * n).fill(255);
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (!this.modules[r][c]) continue;
        const y0 = (r + margin) * scale;
        const x0 = (c + margin) * scale;
        for (let y = 0; y < scale; y++) px.fill(0, (y0 + y) * n + x0, (y0 + y) * n + x0 + scale);
      }
    }
    return PngEncoder.grayscale(n, px);
  }
}

/** Thrown when the text does not fit the largest supported QR version. */
export class QrTooLongError extends Error {
  /** @param {number} bytes */
  constructor(bytes) {
    super(`text is ${bytes} bytes, QR codes here hold at most ${QrCode.MAX_BYTES}`);
    this.name = 'QrTooLongError';
    this.bytes = bytes;
  }
}

/** Minimal PNG writer (grayscale, 8 bit), enough for QR codes. */
export class PngEncoder {
  /** @type {number[]} */
  static #table = PngEncoder.#crcTable();

  static #crcTable() {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t.push(c >>> 0);
    }
    return t;
  }

  /** @param {Buffer} buf */
  static crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = PngEncoder.#table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * @param {string} type
   * @param {Buffer} data
   */
  static chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(PngEncoder.crc32(td));
    return Buffer.concat([len, td, crc]);
  }

  /**
   * @param {number} size   Width and height in pixels.
   * @param {Uint8Array} gray  size*size bytes, 0 = black.
   */
  static grayscale(size, gray) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((size + 1) * size);
    for (let y = 0; y < size; y++) {
      raw[y * (size + 1)] = 0;
      raw.set(gray.subarray(y * size, (y + 1) * size), y * (size + 1) + 1);
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      PngEncoder.chunk('IHDR', ihdr), PngEncoder.chunk('IDAT', deflateSync(raw, { level: 9 })), PngEncoder.chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}
