var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// node_modules/viem/_esm/utils/data/isHex.js
function isHex(value, { strict = true } = {}) {
  if (!value)
    return false;
  if (typeof value !== "string")
    return false;
  return strict ? /^0x[0-9a-fA-F]*$/.test(value) : value.startsWith("0x");
}
var init_isHex = __esm({
  "node_modules/viem/_esm/utils/data/isHex.js"() {
  }
});

// node_modules/viem/_esm/utils/data/size.js
function size(value) {
  if (isHex(value, { strict: false }))
    return Math.ceil((value.length - 2) / 2);
  return value.length;
}
var init_size = __esm({
  "node_modules/viem/_esm/utils/data/size.js"() {
    init_isHex();
  }
});

// node_modules/viem/_esm/errors/version.js
var version;
var init_version = __esm({
  "node_modules/viem/_esm/errors/version.js"() {
    version = "2.52.2";
  }
});

// node_modules/viem/_esm/errors/base.js
function walk(err, fn) {
  if (fn?.(err))
    return err;
  if (err && typeof err === "object" && "cause" in err && err.cause !== void 0)
    return walk(err.cause, fn);
  return fn ? null : err;
}
var errorConfig, BaseError;
var init_base = __esm({
  "node_modules/viem/_esm/errors/base.js"() {
    init_version();
    errorConfig = {
      getDocsUrl: ({ docsBaseUrl, docsPath = "", docsSlug }) => docsPath ? `${docsBaseUrl ?? "https://viem.sh"}${docsPath}${docsSlug ? `#${docsSlug}` : ""}` : void 0,
      version: `viem@${version}`
    };
    BaseError = class _BaseError extends Error {
      constructor(shortMessage, args = {}) {
        const details = (() => {
          if (args.cause instanceof _BaseError)
            return args.cause.details;
          if (args.cause?.message)
            return args.cause.message;
          return args.details;
        })();
        const docsPath = (() => {
          if (args.cause instanceof _BaseError)
            return args.cause.docsPath || args.docsPath;
          return args.docsPath;
        })();
        const docsUrl = errorConfig.getDocsUrl?.({ ...args, docsPath });
        const message = [
          shortMessage || "An error occurred.",
          "",
          ...args.metaMessages ? [...args.metaMessages, ""] : [],
          ...docsUrl ? [`Docs: ${docsUrl}`] : [],
          ...details ? [`Details: ${details}`] : [],
          ...errorConfig.version ? [`Version: ${errorConfig.version}`] : []
        ].join("\n");
        super(message, args.cause ? { cause: args.cause } : void 0);
        Object.defineProperty(this, "details", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "docsPath", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "metaMessages", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "shortMessage", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "version", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        Object.defineProperty(this, "name", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: "BaseError"
        });
        this.details = details;
        this.docsPath = docsPath;
        this.metaMessages = args.metaMessages;
        this.name = args.name ?? this.name;
        this.shortMessage = shortMessage;
        this.version = version;
      }
      walk(fn) {
        return walk(this, fn);
      }
    };
  }
});

// node_modules/viem/_esm/errors/data.js
var SizeExceedsPaddingSizeError;
var init_data = __esm({
  "node_modules/viem/_esm/errors/data.js"() {
    init_base();
    SizeExceedsPaddingSizeError = class extends BaseError {
      constructor({ size: size2, targetSize, type }) {
        super(`${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()} size (${size2}) exceeds padding size (${targetSize}).`, { name: "SizeExceedsPaddingSizeError" });
      }
    };
  }
});

// node_modules/viem/_esm/utils/data/pad.js
function pad(hexOrBytes, { dir, size: size2 = 32 } = {}) {
  if (typeof hexOrBytes === "string")
    return padHex(hexOrBytes, { dir, size: size2 });
  return padBytes(hexOrBytes, { dir, size: size2 });
}
function padHex(hex_, { dir, size: size2 = 32 } = {}) {
  if (size2 === null)
    return hex_;
  const hex = hex_.replace("0x", "");
  if (hex.length > size2 * 2)
    throw new SizeExceedsPaddingSizeError({
      size: Math.ceil(hex.length / 2),
      targetSize: size2,
      type: "hex"
    });
  return `0x${hex[dir === "right" ? "padEnd" : "padStart"](size2 * 2, "0")}`;
}
function padBytes(bytes, { dir, size: size2 = 32 } = {}) {
  if (size2 === null)
    return bytes;
  if (bytes.length > size2)
    throw new SizeExceedsPaddingSizeError({
      size: bytes.length,
      targetSize: size2,
      type: "bytes"
    });
  const paddedBytes = new Uint8Array(size2);
  for (let i = 0; i < size2; i++) {
    const padEnd = dir === "right";
    paddedBytes[padEnd ? i : size2 - i - 1] = bytes[padEnd ? i : bytes.length - i - 1];
  }
  return paddedBytes;
}
var init_pad = __esm({
  "node_modules/viem/_esm/utils/data/pad.js"() {
    init_data();
  }
});

// node_modules/viem/_esm/errors/encoding.js
var IntegerOutOfRangeError, SizeOverflowError;
var init_encoding = __esm({
  "node_modules/viem/_esm/errors/encoding.js"() {
    init_base();
    IntegerOutOfRangeError = class extends BaseError {
      constructor({ max, min, signed, size: size2, value }) {
        super(`Number "${value}" is not in safe ${size2 ? `${size2 * 8}-bit ${signed ? "signed" : "unsigned"} ` : ""}integer range ${max ? `(${min} to ${max})` : `(above ${min})`}`, { name: "IntegerOutOfRangeError" });
      }
    };
    SizeOverflowError = class extends BaseError {
      constructor({ givenSize, maxSize }) {
        super(`Size cannot exceed ${maxSize} bytes. Given size: ${givenSize} bytes.`, { name: "SizeOverflowError" });
      }
    };
  }
});

// node_modules/viem/_esm/utils/encoding/fromHex.js
function assertSize(hexOrBytes, { size: size2 }) {
  if (size(hexOrBytes) > size2)
    throw new SizeOverflowError({
      givenSize: size(hexOrBytes),
      maxSize: size2
    });
}
var init_fromHex = __esm({
  "node_modules/viem/_esm/utils/encoding/fromHex.js"() {
    init_encoding();
    init_size();
  }
});

// node_modules/viem/_esm/utils/encoding/toHex.js
function toHex(value, opts = {}) {
  if (typeof value === "number" || typeof value === "bigint")
    return numberToHex(value, opts);
  if (typeof value === "string") {
    return stringToHex(value, opts);
  }
  if (typeof value === "boolean")
    return boolToHex(value, opts);
  return bytesToHex(value, opts);
}
function boolToHex(value, opts = {}) {
  const hex = `0x${Number(value)}`;
  if (typeof opts.size === "number") {
    assertSize(hex, { size: opts.size });
    return pad(hex, { size: opts.size });
  }
  return hex;
}
function bytesToHex(value, opts = {}) {
  let string = "";
  for (let i = 0; i < value.length; i++) {
    string += hexes[value[i]];
  }
  const hex = `0x${string}`;
  if (typeof opts.size === "number") {
    assertSize(hex, { size: opts.size });
    return pad(hex, { dir: "right", size: opts.size });
  }
  return hex;
}
function numberToHex(value_, opts = {}) {
  const { signed, size: size2 } = opts;
  const value = BigInt(value_);
  let maxValue;
  if (size2) {
    if (signed)
      maxValue = (1n << BigInt(size2) * 8n - 1n) - 1n;
    else
      maxValue = 2n ** (BigInt(size2) * 8n) - 1n;
  } else if (typeof value_ === "number") {
    maxValue = BigInt(Number.MAX_SAFE_INTEGER);
  }
  const minValue = typeof maxValue === "bigint" && signed ? -maxValue - 1n : 0;
  if (maxValue && value > maxValue || value < minValue) {
    const suffix = typeof value_ === "bigint" ? "n" : "";
    throw new IntegerOutOfRangeError({
      max: maxValue ? `${maxValue}${suffix}` : void 0,
      min: `${minValue}${suffix}`,
      signed,
      size: size2,
      value: `${value_}${suffix}`
    });
  }
  const hex = `0x${(signed && value < 0 ? (1n << BigInt(size2 * 8)) + BigInt(value) : value).toString(16)}`;
  if (size2)
    return pad(hex, { size: size2 });
  return hex;
}
function stringToHex(value_, opts = {}) {
  const value = encoder.encode(value_);
  return bytesToHex(value, opts);
}
var hexes, encoder;
var init_toHex = __esm({
  "node_modules/viem/_esm/utils/encoding/toHex.js"() {
    init_encoding();
    init_pad();
    init_fromHex();
    hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_v, i) => i.toString(16).padStart(2, "0"));
    encoder = /* @__PURE__ */ new TextEncoder();
  }
});

// node_modules/viem/_esm/utils/encoding/toBytes.js
function toBytes(value, opts = {}) {
  if (typeof value === "number" || typeof value === "bigint")
    return numberToBytes(value, opts);
  if (typeof value === "boolean")
    return boolToBytes(value, opts);
  if (isHex(value))
    return hexToBytes(value, opts);
  return stringToBytes(value, opts);
}
function boolToBytes(value, opts = {}) {
  const bytes = new Uint8Array(1);
  bytes[0] = Number(value);
  if (typeof opts.size === "number") {
    assertSize(bytes, { size: opts.size });
    return pad(bytes, { size: opts.size });
  }
  return bytes;
}
function charCodeToBase16(char) {
  if (char >= charCodeMap.zero && char <= charCodeMap.nine)
    return char - charCodeMap.zero;
  if (char >= charCodeMap.A && char <= charCodeMap.F)
    return char - (charCodeMap.A - 10);
  if (char >= charCodeMap.a && char <= charCodeMap.f)
    return char - (charCodeMap.a - 10);
  return void 0;
}
function hexToBytes(hex_, opts = {}) {
  let hex = hex_;
  if (opts.size) {
    assertSize(hex, { size: opts.size });
    hex = pad(hex, { dir: "right", size: opts.size });
  }
  let hexString = hex.slice(2);
  if (hexString.length % 2)
    hexString = `0${hexString}`;
  const length = hexString.length / 2;
  const bytes = new Uint8Array(length);
  for (let index = 0, j = 0; index < length; index++) {
    const nibbleLeft = charCodeToBase16(hexString.charCodeAt(j++));
    const nibbleRight = charCodeToBase16(hexString.charCodeAt(j++));
    if (nibbleLeft === void 0 || nibbleRight === void 0) {
      throw new BaseError(`Invalid byte sequence ("${hexString[j - 2]}${hexString[j - 1]}" in "${hexString}").`);
    }
    bytes[index] = nibbleLeft * 16 + nibbleRight;
  }
  return bytes;
}
function numberToBytes(value, opts) {
  const hex = numberToHex(value, opts);
  return hexToBytes(hex);
}
function stringToBytes(value, opts = {}) {
  const bytes = encoder2.encode(value);
  if (typeof opts.size === "number") {
    assertSize(bytes, { size: opts.size });
    return pad(bytes, { dir: "right", size: opts.size });
  }
  return bytes;
}
var encoder2, charCodeMap;
var init_toBytes = __esm({
  "node_modules/viem/_esm/utils/encoding/toBytes.js"() {
    init_base();
    init_isHex();
    init_pad();
    init_fromHex();
    init_toHex();
    encoder2 = /* @__PURE__ */ new TextEncoder();
    charCodeMap = {
      zero: 48,
      nine: 57,
      A: 65,
      F: 70,
      a: 97,
      f: 102
    };
  }
});

// node_modules/@noble/hashes/esm/_u64.js
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var U32_MASK64, _32n, rotlSH, rotlSL, rotlBH, rotlBL;
var init_u64 = __esm({
  "node_modules/@noble/hashes/esm/_u64.js"() {
    U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
    _32n = /* @__PURE__ */ BigInt(32);
    rotlSH = (h, l, s) => h << s | l >>> 32 - s;
    rotlSL = (h, l, s) => l << s | h >>> 32 - s;
    rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
    rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
  }
});

// node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes2(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes2(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
var isLE, swap32IfBE, Hash;
var init_utils = __esm({
  "node_modules/@noble/hashes/esm/utils.js"() {
    isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
    swap32IfBE = isLE ? (u) => u : byteSwap32;
    Hash = class {
    };
  }
});

// node_modules/@noble/hashes/esm/sha3.js
function keccakP(s, rounds = 24) {
  const B = new Uint32Array(5 * 2);
  for (let round = 24 - rounds; round < 24; round++) {
    for (let x = 0; x < 10; x++)
      B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0; y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0; t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 10; x++)
        B[x] = s[y + x];
      for (let x = 0; x < 10; x++)
        s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
  clean(B);
}
var _0n, _1n, _2n, _7n, _256n, _0x71n, SHA3_PI, SHA3_ROTL, _SHA3_IOTA, IOTAS, SHA3_IOTA_H, SHA3_IOTA_L, rotlH, rotlL, Keccak, gen, keccak_256;
var init_sha3 = __esm({
  "node_modules/@noble/hashes/esm/sha3.js"() {
    init_u64();
    init_utils();
    _0n = BigInt(0);
    _1n = BigInt(1);
    _2n = BigInt(2);
    _7n = BigInt(7);
    _256n = BigInt(256);
    _0x71n = BigInt(113);
    SHA3_PI = [];
    SHA3_ROTL = [];
    _SHA3_IOTA = [];
    for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      SHA3_PI.push(2 * (5 * y + x));
      SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
      let t = _0n;
      for (let j = 0; j < 7; j++) {
        R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
        if (R & _2n)
          t ^= _1n << (_1n << /* @__PURE__ */ BigInt(j)) - _1n;
      }
      _SHA3_IOTA.push(t);
    }
    IOTAS = split(_SHA3_IOTA, true);
    SHA3_IOTA_H = IOTAS[0];
    SHA3_IOTA_L = IOTAS[1];
    rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s);
    rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s);
    Keccak = class _Keccak extends Hash {
      // NOTE: we accept arguments in bytes instead of bits here.
      constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
        super();
        this.pos = 0;
        this.posOut = 0;
        this.finished = false;
        this.destroyed = false;
        this.enableXOF = false;
        this.blockLen = blockLen;
        this.suffix = suffix;
        this.outputLen = outputLen;
        this.enableXOF = enableXOF;
        this.rounds = rounds;
        anumber(outputLen);
        if (!(0 < blockLen && blockLen < 200))
          throw new Error("only keccak-f1600 function is supported");
        this.state = new Uint8Array(200);
        this.state32 = u32(this.state);
      }
      clone() {
        return this._cloneInto();
      }
      keccak() {
        swap32IfBE(this.state32);
        keccakP(this.state32, this.rounds);
        swap32IfBE(this.state32);
        this.posOut = 0;
        this.pos = 0;
      }
      update(data) {
        aexists(this);
        data = toBytes2(data);
        abytes(data);
        const { blockLen, state } = this;
        const len = data.length;
        for (let pos = 0; pos < len; ) {
          const take = Math.min(blockLen - this.pos, len - pos);
          for (let i = 0; i < take; i++)
            state[this.pos++] ^= data[pos++];
          if (this.pos === blockLen)
            this.keccak();
        }
        return this;
      }
      finish() {
        if (this.finished)
          return;
        this.finished = true;
        const { state, suffix, pos, blockLen } = this;
        state[pos] ^= suffix;
        if ((suffix & 128) !== 0 && pos === blockLen - 1)
          this.keccak();
        state[blockLen - 1] ^= 128;
        this.keccak();
      }
      writeInto(out) {
        aexists(this, false);
        abytes(out);
        this.finish();
        const bufferOut = this.state;
        const { blockLen } = this;
        for (let pos = 0, len = out.length; pos < len; ) {
          if (this.posOut >= blockLen)
            this.keccak();
          const take = Math.min(blockLen - this.posOut, len - pos);
          out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
          this.posOut += take;
          pos += take;
        }
        return out;
      }
      xofInto(out) {
        if (!this.enableXOF)
          throw new Error("XOF is not possible for this instance");
        return this.writeInto(out);
      }
      xof(bytes) {
        anumber(bytes);
        return this.xofInto(new Uint8Array(bytes));
      }
      digestInto(out) {
        aoutput(out, this);
        if (this.finished)
          throw new Error("digest() was already called");
        this.writeInto(out);
        this.destroy();
        return out;
      }
      digest() {
        return this.digestInto(new Uint8Array(this.outputLen));
      }
      destroy() {
        this.destroyed = true;
        clean(this.state);
      }
      _cloneInto(to) {
        const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
        to || (to = new _Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
        to.state32.set(this.state32);
        to.pos = this.pos;
        to.posOut = this.posOut;
        to.finished = this.finished;
        to.rounds = rounds;
        to.suffix = suffix;
        to.outputLen = outputLen;
        to.enableXOF = enableXOF;
        to.destroyed = this.destroyed;
        return to;
      }
    };
    gen = (suffix, blockLen, outputLen) => createHasher(() => new Keccak(blockLen, suffix, outputLen));
    keccak_256 = /* @__PURE__ */ (() => gen(1, 136, 256 / 8))();
  }
});

// node_modules/viem/_esm/utils/hash/keccak256.js
function keccak256(value, to_) {
  const to = to_ || "hex";
  const bytes = keccak_256(isHex(value, { strict: false }) ? toBytes(value) : value);
  if (to === "bytes")
    return bytes;
  return toHex(bytes);
}
var init_keccak256 = __esm({
  "node_modules/viem/_esm/utils/hash/keccak256.js"() {
    init_sha3();
    init_isHex();
    init_toBytes();
    init_toHex();
  }
});

// node_modules/viem/_esm/errors/address.js
var InvalidAddressError;
var init_address = __esm({
  "node_modules/viem/_esm/errors/address.js"() {
    init_base();
    InvalidAddressError = class extends BaseError {
      constructor({ address }) {
        super(`Address "${address}" is invalid.`, {
          metaMessages: [
            "- Address must be a hex value of 20 bytes (40 hex characters).",
            "- Address must match its checksum counterpart."
          ],
          name: "InvalidAddressError"
        });
      }
    };
  }
});

// node_modules/viem/_esm/utils/lru.js
var LruMap;
var init_lru = __esm({
  "node_modules/viem/_esm/utils/lru.js"() {
    LruMap = class extends Map {
      constructor(size2) {
        super();
        Object.defineProperty(this, "maxSize", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: void 0
        });
        this.maxSize = size2;
      }
      get(key) {
        const value = super.get(key);
        if (super.has(key)) {
          super.delete(key);
          super.set(key, value);
        }
        return value;
      }
      set(key, value) {
        if (super.has(key))
          super.delete(key);
        super.set(key, value);
        if (this.maxSize && this.size > this.maxSize) {
          const firstKey = super.keys().next().value;
          if (firstKey !== void 0)
            super.delete(firstKey);
        }
        return this;
      }
    };
  }
});

// node_modules/viem/_esm/utils/address/getAddress.js
function checksumAddress(address_, chainId) {
  if (checksumAddressCache.has(`${address_}.${chainId}`))
    return checksumAddressCache.get(`${address_}.${chainId}`);
  const hexAddress = chainId ? `${chainId}${address_.toLowerCase()}` : address_.substring(2).toLowerCase();
  const hash = keccak256(stringToBytes(hexAddress), "bytes");
  const address = (chainId ? hexAddress.substring(`${chainId}0x`.length) : hexAddress).split("");
  for (let i = 0; i < 40; i += 2) {
    if (hash[i >> 1] >> 4 >= 8 && address[i]) {
      address[i] = address[i].toUpperCase();
    }
    if ((hash[i >> 1] & 15) >= 8 && address[i + 1]) {
      address[i + 1] = address[i + 1].toUpperCase();
    }
  }
  const result = `0x${address.join("")}`;
  checksumAddressCache.set(`${address_}.${chainId}`, result);
  return result;
}
function getAddress(address, chainId) {
  if (!isAddress(address, { strict: false }))
    throw new InvalidAddressError({ address });
  return checksumAddress(address, chainId);
}
var checksumAddressCache;
var init_getAddress = __esm({
  "node_modules/viem/_esm/utils/address/getAddress.js"() {
    init_address();
    init_toBytes();
    init_keccak256();
    init_lru();
    init_isAddress();
    checksumAddressCache = /* @__PURE__ */ new LruMap(8192);
  }
});

// node_modules/viem/_esm/utils/address/isAddress.js
function isAddress(address, options) {
  const { strict = true } = options ?? {};
  const cacheKey = `${address}.${strict}`;
  if (isAddressCache.has(cacheKey))
    return isAddressCache.get(cacheKey);
  const result = (() => {
    if (!addressRegex.test(address))
      return false;
    if (address.toLowerCase() === address)
      return true;
    if (strict)
      return checksumAddress(address) === address;
    return true;
  })();
  isAddressCache.set(cacheKey, result);
  return result;
}
var addressRegex, isAddressCache;
var init_isAddress = __esm({
  "node_modules/viem/_esm/utils/address/isAddress.js"() {
    init_lru();
    init_getAddress();
    addressRegex = /^0x[a-fA-F0-9]{40}$/;
    isAddressCache = /* @__PURE__ */ new LruMap(8192);
  }
});

// node_modules/viem/_esm/index.js
init_getAddress();

// web-src/signer.ts
function createWalletSigner(options = {}) {
  const provider = options.provider ?? selectEthereumProvider(options.preferredKind);
  if (!provider) throw new Error("EVM wallet required");
  const kind = detectWalletKind(provider, options.preferredKind);
  const label = walletLabel(provider, kind);
  const signTypedData = async (session, data) => {
    return provider.request({
      method: "eth_signTypedData_v4",
      params: [session.address, JSON.stringify(data)]
    });
  };
  const ensureChain = async (chain) => {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chain.chainIdHex }]
      });
    } catch (err) {
      const code = typeof err === "object" && err && "code" in err ? Number(err.code) : 0;
      if (code !== 4902) throw err;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chain.chainIdHex,
          chainName: chain.name,
          rpcUrls: [chain.rpcUrl],
          nativeCurrency: chain.nativeCurrency
        }]
      });
    }
  };
  return {
    id: kind,
    label,
    kind,
    async connect() {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const address = accounts[0] ?? provider.selectedAddress;
      if (!address) throw new Error("wallet account unavailable");
      return {
        address: getAddress(address),
        chainId: await currentChainId(provider),
        walletKind: kind,
        walletLabel: label
      };
    },
    ensureChain,
    signTypedData,
    async signRaceIntent(session, request) {
      await ensureChain(request.chain);
      const entrySignature = await signTypedData(session, request.entry);
      const permitSignature = await signTypedData(session, request.permit);
      return {
        entrySignature,
        permitSignature,
        entryDeadline: stringValue(request.entry.message?.deadline),
        permitDeadline: stringValue(request.permit.message?.deadline)
      };
    },
    async authorizeStake(session, input) {
      const adapter = input.adapter ?? "base-spend-permission";
      const prepared = await postJson(`/race/round/${encodeURIComponent(input.roundId)}/stake/prepare`, {
        adapter,
        slot: input.slot,
        wallet: session.address
      });
      const signature = await signTypedData(session, prepared.typedData);
      return postJson(`/race/round/${encodeURIComponent(input.roundId)}/stake/verify`, {
        adapter,
        slot: input.slot,
        wallet: session.address,
        typedData: prepared.typedData,
        permission: prepared.permission,
        signature
      });
    },
    async payRaceFee(_session, _input) {
      throw new Error(`${label} x402 fee payment requires a browser-safe payment adapter`);
    }
  };
}
function walletDisplayName(session) {
  return session.displayName ?? shortenAddress(session.address);
}
function selectEthereumProvider(preferredKind) {
  const injected = typeof window === "undefined" ? void 0 : window.ethereum;
  if (!injected) return void 0;
  const providers = injected.providers?.length ? injected.providers : [injected];
  if (preferredKind === "base-account") return providers.find(isBaseAccountProvider) ?? injected;
  if (preferredKind === "injected-eip1193") return providers.find((provider) => !isBaseAccountProvider(provider)) ?? injected;
  return providers.find(isBaseAccountProvider) ?? injected;
}
function detectWalletKind(provider, preferredKind) {
  if (preferredKind === "base-account") return "base-account";
  if (isBaseAccountProvider(provider)) return "base-account";
  return "injected-eip1193";
}
function isBaseAccountProvider(provider) {
  const name = provider.providerInfo?.name?.toLowerCase() ?? "";
  const rdns = provider.providerInfo?.rdns?.toLowerCase() ?? "";
  return Boolean(provider.isBaseAccount || name.includes("base") || rdns.includes("base"));
}
function walletLabel(provider, kind) {
  if (kind === "base-account") return "Base Account";
  return provider.providerInfo?.name || (provider.isCoinbaseWallet ? "Coinbase Wallet" : "Browser Wallet");
}
async function currentChainId(provider) {
  try {
    const chainId = await provider.request({ method: "eth_chainId" });
    if (typeof chainId !== "string") return void 0;
    return Number.parseInt(chainId, 16);
  } catch {
    return void 0;
  }
}
async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(json.error || `request failed ${res.status}`);
  }
  return json;
}
function shortenAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}

// src/stage-estimator.ts
var METERS_TO_FEET = 3.28084;
function estimateStagePosition(opts) {
  const { calibration, slot, frame } = opts;
  const assignment = calibration.robotAssignments[slot];
  const robot = opts.robot ?? frame?.robot ?? assignment?.robot ?? null;
  const lane = assignment?.lane ?? null;
  const runFt = Math.max(1, calibration.finishLineFt - calibration.startLineFt);
  const reasons = [];
  const sources = [];
  let confidence = 0;
  const odometry = odometryMeters(frame);
  const odometryFt = odometry === null ? null : odometry * METERS_TO_FEET;
  const progressFt = odometryFt === null ? null : clamp(odometryFt - calibration.startLineFt, 0, runFt);
  const progress = progressFt === null ? null : progressFt / runFt;
  if (progress !== null) {
    confidence += 0.42;
    sources.push("odometry");
  } else {
    reasons.push("odometry missing");
  }
  const laneIndex = lane === "left" ? 0 : lane === "right" ? 1 : null;
  if (laneIndex !== null) {
    confidence += 0.22;
    sources.push("stage-calibration");
  } else {
    reasons.push("lane assignment missing");
  }
  const offsets = robot ? calibration.sensorOffsets?.[robot] : void 0;
  const lateralFt = laneIndex === null ? null : (laneIndex === 0 ? -0.5 : 0.5) * calibration.laneWidthFt;
  const lanePositionPct = laneIndex === null ? null : laneIndex === 0 ? 25 : 75;
  const headingDeg = headingFromFrame(frame);
  if (headingDeg !== null) {
    confidence += 0.16;
    sources.push("imu-yaw");
  } else if (frame?.left_cmd !== void 0 || frame?.right_cmd !== void 0) {
    confidence += 0.05;
    sources.push("wheel-command");
    reasons.push("yaw missing");
  } else {
    reasons.push("heading missing");
  }
  const camera = frame?.camera ?? frame?.sensors?.camera;
  const cameraHealth2 = deriveCameraHealth(camera, frame?.sensors?.raw_frame?.age_ms);
  if (cameraHealth2 === "healthy") {
    confidence += 0.1;
    sources.push(offsets ? "camera-offset" : "camera");
  } else if (cameraHealth2 === "stale") {
    confidence += 0.03;
    sources.push("camera-stale");
    reasons.push("camera stale");
  } else if (cameraHealth2 === "degraded") {
    confidence += 0.05;
    sources.push("camera-degraded");
    reasons.push("camera degraded");
  } else {
    reasons.push("camera missing");
  }
  const lidar = frame?.lidar ?? frame?.sensors?.lidar;
  const lidarStatus = deriveLidarStatus(lidar);
  if (lidarStatus === "available") {
    confidence += 0.1;
    sources.push(offsets ? "lidar-offset" : "lidar");
  } else if (lidarStatus === "blocked") {
    confidence += 0.06;
    sources.push("lidar-blocked");
  } else if (lidarStatus === "stale") {
    confidence += 0.03;
    sources.push("lidar-stale");
    reasons.push("lidar stale");
  } else {
    reasons.push("lidar missing");
  }
  confidence = Number(clamp(confidence, 0, 1).toFixed(2));
  const hasPosition = progress !== null && laneIndex !== null;
  const state = hasPosition ? confidence >= 0.72 ? "ok" : "degraded" : "missing";
  return {
    state,
    confidence,
    lane,
    robot,
    progress: progress === null ? null : Number(progress.toFixed(4)),
    progressFt: progressFt === null ? null : Number(progressFt.toFixed(2)),
    lateralFt: lateralFt === null ? null : Number(lateralFt.toFixed(2)),
    lanePositionPct,
    headingDeg,
    runFt,
    laneWidthFt: calibration.laneWidthFt,
    sources: [...new Set(sources)],
    reasons: [...new Set(reasons)].slice(0, 5)
  };
}
function odometryMeters(frame) {
  if (!frame) return null;
  const left = numberField(frame.odometry_left);
  const right = numberField(frame.odometry_right);
  if (left === null && right === null) return null;
  if (left === null) return right;
  if (right === null) return left;
  return (left + right) / 2;
}
function headingFromFrame(frame) {
  const yaw = numberField(frame?.yaw);
  if (yaw === null) return null;
  return Number(normalizeDegrees(yaw).toFixed(1));
}
function deriveCameraHealth(camera, rawFrameAgeMs) {
  const health = camera?.health;
  if (health === "healthy" || health === "stale" || health === "degraded" || health === "missing") return health;
  const age = numberField(camera?.last_frame_age_ms ?? rawFrameAgeMs);
  if (age !== null && age > 1500) return "stale";
  const status = camera?.status;
  if (status === "simulated" || status === "proxy" || status === "e2e" || status === "harness") return "healthy";
  if (status === "configured") return "degraded";
  if (status === "unavailable" || status === "missing" || status === "error") return "missing";
  return "";
}
function deriveLidarStatus(lidar) {
  if (!lidar) return "";
  if (lidar.blocked) return "blocked";
  const status = lidar.status;
  if (status === "stale") return "stale";
  if (status === "unavailable" || status === "missing" || status === "error") return "missing";
  if (numberField(lidar.front_m) !== null || numberField(lidar.min_m) !== null || status === "available") return "available";
  return "";
}
function numberField(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function normalizeDegrees(value) {
  let degrees = value % 360;
  if (degrees > 180) degrees -= 360;
  if (degrees < -180) degrees += 360;
  return degrees;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// web-src/pilot-app.ts
var params = new URLSearchParams(location.search);
var robotName = params.get("robot") || "courier";
var robotUrl = normalizeBaseUrl(params.get("robotUrl"));
var providedToken = params.get("token");
var forceLocalCamera = params.get("camera") === "local";
var roundId = params.get("round");
var driverSlot = parseDriverSlot(params.get("slot")) || "challenger";
var speedMode = parseSpeedMode(params.get("speed")) || "medium";
var driveWs = null;
var telemetryWs = null;
var token = "";
var connected = false;
var telemetryConnected = false;
var started = false;
var hasConnected = false;
var sendInterval;
var reconnectTimer;
var lastDrive = { left: 0, right: 0 };
var lastTelemetryAt = 0;
var localStream = null;
var raceEntryComplete = false;
var controlUrls = {};
var stageCalibration = null;
var stageCalibrationLoaded = false;
var videoState = "idle";
var roundState = null;
var currentStreamUrl = "";
var streamReconnectTimer;
var streamWatchdogTimer;
var streamReconnectAttempts = 0;
var els = {
  robotName: byId("robotName"),
  conn: byId("conn"),
  connText: byId("conn").querySelector("span"),
  video: byId("video"),
  localVideo: byId("localVideo"),
  videoFallback: byId("videoFallback"),
  direction: byId("direction"),
  battery: byId("battery"),
  latency: byId("latency"),
  deadman: byId("deadman"),
  cap: byId("cap"),
  slotState: byId("slotState"),
  raceTimer: byId("raceTimer"),
  stakeState: byId("stakeState"),
  feeState: byId("feeState"),
  source: byId("source"),
  cameraState: byId("cameraState"),
  cameraDetail: byId("cameraDetail"),
  lidar: byId("lidar"),
  yaw: byId("yaw"),
  odo: byId("odo"),
  minimap: byId("minimap"),
  stageLabel: byId("stageLabel"),
  stageProgress: byId("stageProgress"),
  stageMarker: byId("stageMarker"),
  stageLane: byId("stageLane"),
  stageConfidence: byId("stageConfidence"),
  left: byId("left"),
  right: byId("right"),
  estop: byId("estop"),
  throttle: byId("throttle"),
  zone: byId("zone"),
  startModal: byId("startModal"),
  modalTitle: byId("modalTitle"),
  modalCopy: byId("modalCopy"),
  modalStatus: byId("modalStatus"),
  startButton: byId("startButton")
};
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
function normalizeBaseUrl(value) {
  if (!value) return null;
  return value.replace(/\/$/, "");
}
function parseSpeedMode(value) {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}
function parseDriverSlot(value) {
  return value === "challenger" || value === "opponent" ? value : null;
}
function wsFromHttp(url) {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}
function deriveTelemetryWs(url) {
  return url.replace(/\/ws\/drive(?:\?.*)?$/, "/ws/telemetry");
}
function setConn(state, text) {
  els.conn.className = `conn ${state === "connecting" ? "" : state}`;
  els.connText.textContent = text;
}
function setModalStatus(text, tone = "dim") {
  els.modalStatus.textContent = text;
  els.modalStatus.className = `modal-status ${tone === "dim" ? "" : tone}`;
}
async function authorize() {
  if (roundId && !stageCalibrationLoaded) await loadStageCalibration();
  if (robotUrl) {
    const nextToken = providedToken || `dev-${Date.now()}`;
    if (!providedToken) {
      const res2 = await fetch(`${robotUrl}/pilot/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: nextToken, ttl_secs: 300, speed_mode: speedMode })
      });
      const body2 = await res2.json();
      if (!res2.ok || body2.error) throw new Error(body2.error || `authorize failed ${res2.status}`);
    }
    return {
      token: nextToken,
      robot: robotName,
      driveWs: `${wsFromHttp(robotUrl)}/ws/drive`,
      telemetryWs: `${wsFromHttp(robotUrl)}/ws/telemetry`,
      streamUrl: `${robotUrl}/stream`,
      speedModeUrl: `${robotUrl}/pilot/speed-mode`,
      stopUrl: `${robotUrl}/stop`
    };
  }
  if (roundId) {
    const res2 = await fetch(`/race/round/${roundId}/pilot/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: driverSlot, speed_mode: speedMode })
    });
    const body2 = await res2.json();
    if (!res2.ok || body2.error) throw new Error(body2.error || `round pilot session failed ${res2.status}`);
    return {
      ...body2,
      telemetryWs: body2.telemetryWs || (body2.driveWs ? deriveTelemetryWs(body2.driveWs) : void 0)
    };
  }
  const res = await fetch("/pilot/dev-authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ robot: robotName, speed_mode: speedMode })
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error || `authorize failed ${res.status}`);
  return {
    ...body,
    telemetryWs: body.telemetryWs || (body.driveWs ? deriveTelemetryWs(body.driveWs) : void 0)
  };
}
async function loadStageCalibration() {
  if (!roundId) return;
  try {
    const res = await fetch(`/race/round/${encodeURIComponent(roundId)}/calibration`);
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || `calibration failed ${res.status}`);
    stageCalibration = body.stageCalibration ?? null;
    stageCalibrationLoaded = true;
    renderStageProgress();
  } catch {
    stageCalibrationLoaded = true;
    stageCalibration = null;
  }
}
async function connect() {
  clearTimeout(reconnectTimer);
  setConn("connecting", "connecting");
  try {
    const auth = await authorize();
    if (!auth.token || !auth.driveWs) throw new Error("authorization missing drive endpoint");
    token = auth.token;
    syncRoundState(auth.round);
    controlUrls = { speedMode: auth.speedModeUrl, stop: auth.stopUrl };
    els.robotName.textContent = auth.robot ? `/ ${auth.robot}` : `/ ${robotName}`;
    configureVideo(auth.driveWs, auth.streamUrl);
    openDriveSocket(auth.driveWs);
    if (auth.telemetryWs) openTelemetrySocket(auth.telemetryWs);
    els.startModal.classList.add("hidden");
  } catch (err) {
    setConn("down", err instanceof Error ? err.message : "connection failed");
    if (hasConnected) {
      reconnectTimer = window.setTimeout(connect, 1800);
    } else {
      started = false;
      els.startButton.disabled = false;
      els.startButton.textContent = "TRY AGAIN";
      els.startModal.classList.remove("hidden");
    }
  }
}
async function completeRaceEntryIfNeeded() {
  if (!roundId || raceEntryComplete) return;
  if (await useExistingRaceEntryIfReady()) return;
  const round = await getPilotRound();
  if (round.stakeAsset === "native-eth") {
    throw new Error("Stake from the Clanker500 join screen first");
  }
  const signer = createWalletSigner();
  setModalStatus(`Connecting ${signer.label}...`);
  const session = await signer.connect();
  setModalStatus("Claiming driver slot...");
  await postJson2(`/race/round/${roundId}/claim-slot`, {
    slot: driverSlot,
    wallet: session.address,
    displayName: walletDisplayName(session)
  });
  setModalStatus("Authorizing matched stake...");
  await signer.authorizeStake(session, {
    roundId,
    slot: driverSlot
  });
  setModalStatus("Opening race escrow...");
  await postJson2(`/race/round/${roundId}/chain/open`, {});
  setModalStatus("Preparing typed authorization...");
  const request = await postJson2(`/race/round/${roundId}/chain/authorization-request`, {
    slot: driverSlot,
    wallet: session.address
  });
  setModalStatus("Sign race entry and permit...");
  const signed = await signer.signRaceIntent(session, request);
  if (!signed.entryDeadline || !signed.permitDeadline) {
    throw new Error("race authorization deadlines missing");
  }
  setModalStatus("Submitting race entry...");
  await postJson2(`/race/round/${roundId}/chain/join`, {
    slot: driverSlot,
    entrySignature: signed.entrySignature,
    permitSignature: signed.permitSignature,
    entryDeadline: signed.entryDeadline,
    permitDeadline: signed.permitDeadline
  });
  raceEntryComplete = true;
  setModalStatus("Race entry confirmed", "ok");
}
async function useExistingRaceEntryIfReady() {
  if (!roundId) return false;
  const round = await getPilotRound();
  const driver = round.drivers?.[driverSlot];
  if (!driver) return false;
  const chainReady = !round.chainRaceId || driver.chainJoined === true;
  if (driver.feePaid === true && driver.stakeAuthorized === true && chainReady) {
    roundState = {
      id: round.id,
      status: round.status,
      chainRaceId: round.chainRaceId,
      stakeUsdc: round.stakeUsdc,
      stakeAsset: round.stakeAsset,
      stakeWei: round.stakeWei,
      stakeDisplay: round.stakeDisplay,
      chainNetwork: round.chainNetwork,
      feeUsdc: round.feeUsdc,
      durationSecs: round.durationSecs,
      countdownSecs: round.countdownSecs,
      roundStartsAt: round.roundStartsAt,
      startedAt: round.startedAt,
      driver: {
        slot: driverSlot,
        wallet: driver.wallet,
        displayName: driver.displayName,
        robot: driver.robot,
        lane: driver.lane,
        feePaid: driver.feePaid,
        stakeAuthorized: driver.stakeAuthorized,
        chainJoined: Boolean(driver.chainJoined)
      }
    };
    renderRoundState();
    raceEntryComplete = true;
    setModalStatus("Race entry already confirmed", "ok");
    return true;
  }
  return false;
}
async function getPilotRound() {
  const res = await fetch(`/race/round/${encodeURIComponent(roundId)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `round lookup failed ${res.status}`);
  return json;
}
async function postJson2(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(json.error || `request failed ${res.status}`);
  }
  return json;
}
function syncRoundState(next) {
  if (next) roundState = next;
  renderRoundState();
}
function renderRoundState() {
  const driver = roundState?.driver;
  const slotLabel = driver?.slot === "challenger" ? "chal" : driver?.slot === "opponent" ? "opp" : driverSlot;
  const robot = driver?.robot || robotName;
  const lane = driver?.lane ? `/${driver.lane}` : "";
  els.slotState.textContent = roundId ? `${slotLabel}/${robot}${lane}` : "dev";
  els.stakeState.textContent = roundState?.stakeAsset === "native-eth" ? roundState.stakeDisplay ?? "ETH" : roundState?.stakeUsdc ? `$${roundState.stakeUsdc}` : "--";
  els.feeState.textContent = roundState?.feeUsdc ? `$${roundState.feeUsdc}` : "--";
  updateRaceTimer();
}
function roundStartMs() {
  return roundState?.startedAt ?? roundState?.roundStartsAt ?? null;
}
function driveUnlocked() {
  if (!started) return false;
  if (!roundId) return true;
  const startMs = roundStartMs();
  return roundState?.status === "racing" || Boolean(startMs && Date.now() >= startMs);
}
function updateRaceTimer() {
  if (!roundId) {
    els.raceTimer.textContent = "--";
    return;
  }
  if (!roundState) {
    els.raceTimer.textContent = "entry";
    return;
  }
  const startMs = roundStartMs();
  const now = Date.now();
  if (startMs && now < startMs) {
    const left = Math.ceil((startMs - now) / 1e3);
    els.raceTimer.textContent = `-${left}s`;
    if (started) els.direction.textContent = `GO in ${left}`;
    return;
  }
  if (startMs) {
    const elapsed = Math.max(0, Math.floor((now - startMs) / 1e3));
    const remaining = Math.max(0, roundState.durationSecs - elapsed);
    els.raceTimer.textContent = remaining > 0 ? `${remaining}s` : "done";
    if (started && !connected) els.direction.textContent = "GO";
    return;
  }
  els.raceTimer.textContent = roundState.status || "wait";
}
function openDriveSocket(url) {
  driveWs?.close();
  driveWs = new WebSocket(url);
  driveWs.onopen = () => {
    connected = true;
    hasConnected = true;
    setConn("up", telemetryConnected ? "drive + telemetry" : "drive connected");
    updateRaceTimer();
  };
  driveWs.onmessage = (event) => {
    try {
      const body = JSON.parse(event.data);
      if (body?.error === "round has not started") {
        updateRaceTimer();
      } else if (body?.error) {
        els.direction.textContent = body.error;
      }
    } catch {
    }
  };
  driveWs.onclose = () => {
    connected = false;
    setConn("down", "drive disconnected");
    stopSending();
    reconnectTimer = window.setTimeout(connect, 1500);
  };
  driveWs.onerror = () => setConn("down", "drive error");
}
function openTelemetrySocket(url) {
  telemetryWs?.close();
  telemetryWs = new WebSocket(url);
  telemetryWs.onopen = () => {
    telemetryConnected = true;
    setConn(connected ? "up" : "connecting", connected ? "drive + telemetry" : "telemetry connected");
  };
  telemetryWs.onmessage = (event) => {
    try {
      renderTelemetry(JSON.parse(event.data));
    } catch {
    }
  };
  telemetryWs.onclose = () => {
    telemetryConnected = false;
    if (connected) setConn("up", "drive only");
  };
}
function configureVideo(driveUrl, streamUrl) {
  clearStreamReconnect();
  clearStreamWatchdog();
  const base = httpBaseFromDriveUrl(driveUrl);
  currentStreamUrl = streamUrl || `${base}/stream`;
  if (forceLocalCamera) {
    startLocalCamera();
    return;
  }
  connectRemoteStream();
}
function connectRemoteStream() {
  if (!currentStreamUrl) return;
  videoState = streamReconnectAttempts > 0 ? "reconnecting" : "idle";
  els.videoFallback.textContent = streamReconnectAttempts > 0 ? "camera reconnecting" : "connecting camera";
  els.videoFallback.style.display = "grid";
  els.video.classList.add("off");
  els.video.style.display = "block";
  els.video.src = cacheBustUrl(currentStreamUrl);
  els.video.onload = () => {
    videoState = "streaming";
    streamReconnectAttempts = 0;
    startStreamWatchdog();
    els.video.classList.remove("off");
    els.video.style.display = "block";
    els.localVideo.classList.add("off");
    els.localVideo.style.display = "none";
    els.videoFallback.style.display = "none";
  };
  els.video.onerror = () => {
    handleRemoteStreamFailure();
  };
}
function handleRemoteStreamFailure() {
  videoState = "reconnecting";
  clearStreamWatchdog();
  els.video.classList.add("off");
  els.videoFallback.textContent = "camera reconnecting";
  els.videoFallback.style.display = "grid";
  scheduleStreamReconnect();
}
function scheduleStreamReconnect() {
  clearStreamReconnect();
  streamReconnectAttempts += 1;
  const delayMs = Math.min(5e3, 700 + streamReconnectAttempts * 800);
  streamReconnectTimer = window.setTimeout(connectRemoteStream, delayMs);
}
function clearStreamReconnect() {
  if (streamReconnectTimer) window.clearTimeout(streamReconnectTimer);
  streamReconnectTimer = void 0;
}
function startStreamWatchdog() {
  clearStreamWatchdog();
  streamWatchdogTimer = window.setInterval(() => {
    if (!currentStreamUrl || forceLocalCamera || videoState === "local") return;
    els.video.src = cacheBustUrl(currentStreamUrl);
  }, 7e3);
}
function clearStreamWatchdog() {
  if (streamWatchdogTimer) window.clearInterval(streamWatchdogTimer);
  streamWatchdogTimer = void 0;
}
function cacheBustUrl(value) {
  const url = new URL(value, location.href);
  url.searchParams.set("stream_ts", String(Date.now()));
  return url.toString();
}
async function startLocalCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    fallbackToRemoteStream("camera unavailable");
    return;
  }
  try {
    localStream ??= await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    videoState = "local";
    els.localVideo.srcObject = localStream;
    els.localVideo.style.display = "block";
    els.localVideo.classList.remove("off");
    els.video.style.display = "none";
    els.videoFallback.style.display = "none";
  } catch {
    fallbackToRemoteStream("camera permission needed");
  }
}
function fallbackToRemoteStream(message) {
  if (currentStreamUrl) {
    videoState = "reconnecting";
    els.videoFallback.textContent = `${message}; trying robot camera`;
    els.videoFallback.style.display = "grid";
    connectRemoteStream();
    return;
  }
  videoState = "fallback";
  els.videoFallback.textContent = message;
  els.videoFallback.style.display = "grid";
}
function send(left, right) {
  if (!started) return;
  if (!driveUnlocked()) {
    updateRaceTimer();
    return;
  }
  if (!connected || !driveWs || driveWs.readyState !== WebSocket.OPEN) return;
  driveWs.send(JSON.stringify({ left, right, token, speed_mode: speedMode, t: Date.now() }));
  els.left.textContent = left.toFixed(2);
  els.right.textContent = right.toFixed(2);
  els.direction.textContent = drivePrompt(left, right);
}
function drivePrompt(left, right) {
  const avg = (left + right) / 2;
  const turn = left - right;
  if (Math.abs(avg) < 0.08 && Math.abs(turn) < 0.08) return "Hold position";
  if (Math.abs(turn) > Math.abs(avg) * 1.3) return turn > 0 ? "Turn right" : "Turn left";
  if (avg < -0.08) return "Reverse";
  return "Drive forward";
}
function startSending() {
  stopSending();
  sendInterval = window.setInterval(() => send(lastDrive.left, lastDrive.right), 80);
}
function stopSending() {
  if (sendInterval) window.clearInterval(sendInterval);
  sendInterval = void 0;
  lastDrive = { left: 0, right: 0 };
  send(0, 0);
}
async function setSpeedMode(mode) {
  speedMode = mode;
  renderSpeedMode(mode);
  if (!robotUrl && !token) return;
  const base = robotUrl || currentRobotHttpBase();
  const url = controlUrls.speedMode || (base ? `${base}/pilot/speed-mode` : "");
  if (!url || !token) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, speed_mode: mode })
    });
  } catch {
  }
}
function currentRobotHttpBase() {
  if (!driveWs?.url) return null;
  return httpBaseFromDriveUrl(driveWs.url);
}
function httpBaseFromDriveUrl(driveUrl) {
  const httpUrl = driveUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  try {
    const url = new URL(httpUrl, location.href);
    if (url.pathname === "/ws/drive") return url.origin;
    url.pathname = url.pathname.replace(/\/ws\/drive$/, "");
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return httpUrl.replace(/\/ws\/drive(?:\?.*)?$/, "");
  }
}
function renderSpeedMode(mode) {
  els.throttle.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.speed === mode);
  });
}
function renderTelemetry(frame) {
  lastTelemetryAt = Date.now();
  const left = frame.left_cmd ?? 0;
  const right = frame.right_cmd ?? 0;
  els.left.textContent = left.toFixed(2);
  els.right.textContent = right.toFixed(2);
  els.source.textContent = frame.source || "bridge";
  els.battery.textContent = frame.battery_v !== void 0 ? `${frame.battery_v.toFixed(2)}V` : "--";
  els.cap.textContent = frame.max_speed !== void 0 ? frame.max_speed.toFixed(2) : "--";
  const camera = cameraHealth(frame);
  els.cameraState.textContent = camera.label;
  els.cameraState.className = camera.tone;
  els.cameraDetail.textContent = camera.detail;
  els.cameraDetail.className = camera.tone;
  els.lidar.textContent = lidarLabel(frame);
  els.yaw.textContent = frame.yaw !== void 0 ? `${frame.yaw.toFixed(0)}deg` : "--";
  els.odo.textContent = odometryLabel(frame);
  renderStageProgress(frame);
  speedMode = frame.speed_mode || speedMode;
  renderSpeedMode(speedMode);
  const deadmanText = frame.estop ? "estop" : frame.stopped_by_deadman ? "stopped" : frame.deadman_ok ? "ready" : "stale";
  els.deadman.textContent = deadmanText;
  els.deadman.className = frame.estop || frame.stopped_by_deadman ? "bad" : frame.deadman_ok ? "ok" : "warn";
  const lag = frame.ts_ms ? Math.max(0, Date.now() - frame.ts_ms) : null;
  els.latency.textContent = lag === null ? "--" : `${lag}ms`;
  els.latency.className = lag !== null && lag > 500 ? "warn" : "";
  els.lidar.className = frame.lidar?.blocked ? "bad" : "";
  if (frame.estop) {
    els.direction.textContent = "Emergency stop";
  } else if (frame.soft_odometry_limited) {
    els.direction.textContent = "Stage limit";
  } else if (frame.lidar?.blocked) {
    els.direction.textContent = "Obstacle ahead";
  } else if (!started) {
    els.direction.textContent = "Tap start to drive";
  } else if (!driveUnlocked()) {
    updateRaceTimer();
  }
}
function cameraHealth(frame) {
  const camera = frame.camera ?? frame.sensors?.camera;
  const detail = cameraDetail(camera, frame);
  if (forceLocalCamera || videoState === "local") {
    return { label: camera?.status ? `local/${camera.status}` : "local", detail, tone: "ok" };
  }
  if (videoState === "reconnecting") return { label: "reconnect", detail, tone: "warn" };
  if (videoState === "fallback") return { label: "missing", detail, tone: "bad" };
  const age = camera?.last_frame_age_ms ?? frame.raw_frame_age_ms ?? frame.sensors?.raw_frame?.age_ms;
  const health = camera?.health ?? deriveCameraHealth2(camera?.status, age);
  if (age !== void 0 && age > 1500) return { label: "stale", detail, tone: "warn" };
  if (health === "healthy") {
    return { label: camera?.status || "ok", detail, tone: "ok" };
  }
  if (health === "degraded") return { label: camera?.reconnect_state || camera?.status || "degraded", detail, tone: "warn" };
  if (health === "missing") return { label: camera?.status || "missing", detail, tone: "bad" };
  return { label: camera?.status || "--", detail, tone: "" };
}
function deriveCameraHealth2(status, age) {
  if (age !== void 0 && age > 1500) return "stale";
  if (status === "simulated" || status === "proxy") return "healthy";
  if (status === "configured") return "degraded";
  if (status === "unavailable" || status === "missing" || status === "error") return "missing";
  return "";
}
function cameraDetail(camera, frame) {
  const age = camera?.last_frame_age_ms ?? frame.raw_frame_age_ms ?? frame.sensors?.raw_frame?.age_ms;
  const parts = [
    camera?.fps !== void 0 ? `${camera.fps.toFixed(0)}fps` : void 0,
    age !== void 0 ? `${age.toFixed(0)}ms` : void 0,
    camera?.resolution,
    camera?.brightness !== void 0 ? `b${camera.brightness.toFixed(0)}` : void 0,
    camera?.reconnect_state && camera.reconnect_state !== "stable" ? camera.reconnect_state : void 0
  ].filter(Boolean);
  return parts.length ? parts.slice(0, 3).join(" ") : "--";
}
function lidarLabel(frame) {
  const lidar = frame.lidar;
  if (!lidar) return "--";
  const distance = lidar.front_m ?? lidar.min_m;
  if (distance === void 0) return lidar.blocked ? "blocked" : "--";
  return `${lidar.blocked ? "!" : ""}${distance.toFixed(2)}m`;
}
function odometryLabel(frame) {
  const left = frame.odometry_left;
  const right = frame.odometry_right;
  if (left === void 0 && right === void 0) return "--";
  if (left !== void 0 && right !== void 0) return `${((left + right) / 2).toFixed(1)}m`;
  return `${(left ?? right ?? 0).toFixed(1)}m`;
}
function renderStageProgress(frame) {
  const calibration = stageCalibration;
  if (!calibration) {
    els.stageLabel.textContent = "stage";
    els.stageProgress.textContent = "--";
    els.stageLane.textContent = "--";
    els.stageConfidence.textContent = "--";
    els.minimap.className = "minimap missing";
    setStageMarker(0, 50, 0);
    return;
  }
  const slotAssignment = calibration.robotAssignments[driverSlot];
  const estimate = estimateStagePosition({
    calibration,
    slot: driverSlot,
    robot: frame?.robot ?? slotAssignment?.robot ?? robotName,
    frame
  });
  const x = estimate.progress === null ? 0 : estimate.progress * 100;
  const y = estimate.lanePositionPct ?? 50;
  const heading = estimate.headingDeg ?? 0;
  const lane = estimate.lane ?? slotAssignment?.lane;
  els.minimap.className = `minimap ${estimate.state}`;
  els.stageLabel.textContent = `${estimate.runFt.toFixed(0)}ft x ${estimate.laneWidthFt.toFixed(1)}ft`;
  els.stageProgress.textContent = estimate.progressFt === null ? "--" : `${estimate.progressFt.toFixed(1)}ft`;
  els.stageLane.textContent = `${lane ?? "lane"} ${estimate.headingDeg === null ? "no yaw" : `${estimate.headingDeg.toFixed(0)}deg`}`;
  els.stageConfidence.textContent = estimate.state === "missing" ? "missing" : `${Math.round(estimate.confidence * 100)}%`;
  setStageMarker(x, y, heading);
}
function setStageMarker(xPercent, yPercent, headingDeg) {
  const marker = els.stageMarker;
  marker.style.left = `${xPercent.toFixed(1)}%`;
  marker.style.top = `${yPercent.toFixed(1)}%`;
  marker.style.transform = `translate(-50%, -50%) rotate(${headingDeg.toFixed(1)}deg)`;
}
function setupJoystick() {
  if (!window.nipplejs) {
    els.direction.textContent = "Joystick failed to load";
    return;
  }
  const joy = window.nipplejs.create({
    zone: els.zone,
    mode: "static",
    position: { left: "50%", top: "58%" },
    color: "#59a6ff",
    size: 140
  });
  joy.on("move", (_event, data) => {
    const force = Math.min(data.force ?? 0, 1);
    const angle = data.angle?.radian ?? Math.PI / 2;
    const fwd = Math.sin(angle) * force;
    const turn = Math.cos(angle) * force;
    lastDrive = {
      left: Math.max(-1, Math.min(1, fwd + turn * 0.6)),
      right: Math.max(-1, Math.min(1, fwd - turn * 0.6))
    };
  });
  joy.on("start", startSending);
  joy.on("end", stopSending);
}
function setupControls() {
  els.estop.onclick = () => {
    stopSending();
    if (controlUrls.stop) {
      fetch(controlUrls.stop, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      }).catch(() => void 0);
      return;
    }
    const base = currentRobotHttpBase();
    if (base) {
      fetch(`${base}/stop`, { method: "POST" }).catch(() => void 0);
    } else {
      fetch(`/estop/${robotName}`, { method: "POST" }).catch(() => void 0);
    }
  };
  els.startButton.onclick = async () => {
    els.startButton.disabled = true;
    els.startButton.textContent = roundId && !raceEntryComplete ? "CHECKING" : "CONNECTING";
    try {
      await completeRaceEntryIfNeeded();
      started = true;
      els.startButton.textContent = "CONNECTING";
      connect();
    } catch (err) {
      started = false;
      els.startButton.disabled = false;
      els.startButton.textContent = "TRY AGAIN";
      setModalStatus(err instanceof Error ? err.message : "race entry failed", "bad");
    }
  };
  els.throttle.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const next = parseSpeedMode(button.dataset.speed || "");
      if (next) setSpeedMode(next);
    });
  });
  renderSpeedMode(speedMode);
}
setInterval(() => {
  updateRaceTimer();
  if (lastTelemetryAt && Date.now() - lastTelemetryAt > 1200) {
    els.latency.textContent = "stale";
    els.latency.className = "warn";
    els.source.textContent = "stale";
    els.cameraState.textContent = "stale";
    els.cameraState.className = "warn";
  }
}, 500);
els.robotName.textContent = `/ ${robotName}`;
renderRoundState();
if (roundId) {
  els.modalTitle.textContent = "Enter Race";
  els.modalCopy.textContent = `Sign entry for ${driverSlot}. Camera stays live once your entry is confirmed.`;
  setModalStatus("Wallet signature required");
  void loadStageCalibration();
}
if (robotUrl) {
  configureVideo(`${wsFromHttp(robotUrl)}/ws/drive`, `${robotUrl}/stream`);
} else {
  configureVideo(
    `${wsFromHttp(location.origin)}/ws/drive?robot=${encodeURIComponent(robotName)}`,
    `/robot/${encodeURIComponent(robotName)}/stream`
  );
}
setupControls();
setupJoystick();
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
