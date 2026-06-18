var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params2) => {
  const { data, path, errorMaps, issueData } = params2;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage2 = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage2 = map(fullIssue, { data, defaultError: errorMessage2 }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage2
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params2) {
  if (!params2)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params2;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params2;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params2) {
    const result = this.safeParse(data, params2);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params2) {
    const ctx = {
      common: {
        issues: [],
        async: params2?.async ?? false,
        contextualErrorMap: params2?.errorMap
      },
      path: params2?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params2) {
    const result = await this.safeParseAsync(data, params2);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params2) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params2?.errorMap,
        async: true
      },
      path: params2?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params2) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params2?.coerce ?? false,
    ...processCreateParams(params2)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params2) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params2?.coerce || false,
    ...processCreateParams(params2)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params2) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params2?.coerce ?? false,
    ...processCreateParams(params2)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params2) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params2?.coerce || false,
    ...processCreateParams(params2)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params2) => {
  return new ZodDate({
    checks: [],
    coerce: params2?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params2)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params2) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params2)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params2) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params2)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params2) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params2)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params2) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params2)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params2) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params2)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params2) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params2)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params2) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params2)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params2) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params2)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params2) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params2)
  });
};
ZodObject.strictCreate = (shape, params2) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params2)
  });
};
ZodObject.lazycreate = (shape, params2) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params2)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params2) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params2)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params2) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params2)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params2) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params2)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params2) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params2)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params2) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params2)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size2, message) {
    return this.min(size2, message).max(size2, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params2) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params2)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params2 = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params2).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params2).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params2);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params2);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params2) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params2)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params2) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params2)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params2) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params2)
  });
};
function createZodEnum(values, params2) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params2)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params2) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params2)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params2) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params2)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params2) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params2)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params2) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params2)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params2) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params2)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params2) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params2)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params2) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params2.default === "function" ? params2.default : () => params2.default,
    ...processCreateParams(params2)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params2) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params2.catch === "function" ? params2.catch : () => params2.catch,
    ...processCreateParams(params2)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params2) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params2)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params2) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params2)
  });
};
function cleanParams(params2, data) {
  const p = typeof params2 === "function" ? params2(data) : typeof params2 === "string" ? { message: params2 } : params2;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params2 = cleanParams(_params, data);
            const _fatal = params2.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params2, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params2 = cleanParams(_params, data);
        const _fatal = params2.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params2, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params2 = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params2);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// node_modules/@x402/core/dist/esm/chunk-FPXAE3OS.mjs
var NonEmptyString = external_exports.string().min(1);
var Any = external_exports.record(external_exports.unknown());
var OptionalAny = external_exports.record(external_exports.unknown()).optional().nullable();
var NetworkSchemaV1 = NonEmptyString;
var NetworkSchemaV2 = external_exports.string().min(3).refine((val) => val.includes(":"), {
  message: "Network must be in CAIP-2 format (e.g., 'eip155:84532')"
});
var NetworkSchema = external_exports.union([NetworkSchemaV1, NetworkSchemaV2]);
var PRINTABLE_ASCII_REGEX = /^[\x20-\x7e]+$/;
var ResourceInfoSchema = external_exports.object({
  url: NonEmptyString,
  description: external_exports.string().optional(),
  mimeType: external_exports.string().optional(),
  serviceName: external_exports.string().min(1).max(32).regex(PRINTABLE_ASCII_REGEX).optional(),
  tags: external_exports.array(external_exports.string().min(1).max(32).regex(PRINTABLE_ASCII_REGEX)).max(5).optional(),
  iconUrl: external_exports.string().max(2048).optional()
});
var PaymentRequirementsV1Schema = external_exports.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV1,
  maxAmountRequired: NonEmptyString,
  resource: NonEmptyString,
  // URL string in V1
  description: external_exports.string(),
  mimeType: external_exports.string().optional(),
  outputSchema: Any.optional().nullable(),
  payTo: NonEmptyString,
  maxTimeoutSeconds: external_exports.number().positive(),
  asset: NonEmptyString,
  extra: OptionalAny
});
var PaymentRequiredV1Schema = external_exports.object({
  x402Version: external_exports.literal(1),
  error: external_exports.string().optional(),
  accepts: external_exports.array(PaymentRequirementsV1Schema).min(1)
});
var PaymentPayloadV1Schema = external_exports.object({
  x402Version: external_exports.literal(1),
  scheme: NonEmptyString,
  network: NetworkSchemaV1,
  payload: Any
});
var PaymentRequirementsV2Schema = external_exports.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV2,
  amount: NonEmptyString,
  asset: NonEmptyString,
  payTo: NonEmptyString,
  maxTimeoutSeconds: external_exports.number().positive(),
  extra: OptionalAny
});
var PaymentRequiredV2Schema = external_exports.object({
  x402Version: external_exports.literal(2),
  error: external_exports.string().optional(),
  resource: ResourceInfoSchema,
  accepts: external_exports.array(PaymentRequirementsV2Schema).min(1),
  extensions: OptionalAny
});
var PaymentPayloadV2Schema = external_exports.object({
  x402Version: external_exports.literal(2),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsV2Schema,
  payload: Any,
  extensions: OptionalAny
});
var PaymentRequirementsSchema = external_exports.union([
  PaymentRequirementsV1Schema,
  PaymentRequirementsV2Schema
]);
var PaymentRequiredSchema = external_exports.discriminatedUnion("x402Version", [
  PaymentRequiredV1Schema,
  PaymentRequiredV2Schema
]);
var PaymentPayloadSchema = external_exports.discriminatedUnion("x402Version", [
  PaymentPayloadV1Schema,
  PaymentPayloadV2Schema
]);

// node_modules/@x402/core/dist/esm/chunk-VE37GDG2.mjs
var x402Version = 2;

// node_modules/@x402/core/dist/esm/chunk-ABS7D6VX.mjs
var escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var networkPatternToRegExp = (pattern) => {
  const source = escapeRegExp(pattern).replace(/\\\*/g, ".*");
  return new RegExp(`^${source}$`);
};
var networkMatchesPattern = (pattern, network) => {
  return networkPatternToRegExp(pattern).test(network);
};
var findSchemesByNetwork = (map, network) => {
  let implementationsByScheme = map.get(network);
  if (!implementationsByScheme) {
    for (const [registeredNetworkPattern, implementations] of map.entries()) {
      if (networkMatchesPattern(registeredNetworkPattern, network)) {
        implementationsByScheme = implementations;
        break;
      }
    }
  }
  return implementationsByScheme;
};
var findByNetworkAndScheme = (map, scheme, network) => {
  return findSchemesByNetwork(map, network)?.get(scheme);
};
var Base64EncodedRegex = /^[A-Za-z0-9+/]*={0,2}$/;
function safeBase64Encode(data) {
  if (typeof globalThis !== "undefined" && typeof globalThis.btoa === "function") {
    const bytes = new TextEncoder().encode(data);
    const binaryString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    return globalThis.btoa(binaryString);
  }
  return Buffer.from(data, "utf8").toString("base64");
}
function safeBase64Decode(data) {
  if (typeof globalThis !== "undefined" && typeof globalThis.atob === "function") {
    const binaryString = globalThis.atob(data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(bytes);
  }
  return Buffer.from(data, "base64").toString("utf-8");
}

// node_modules/@x402/core/dist/esm/chunk-YSNRPV3S.mjs
var verifyResponseSchema = external_exports.object({
  isValid: external_exports.boolean(),
  invalidReason: external_exports.string().nullish().transform((v) => v ?? void 0),
  invalidMessage: external_exports.string().nullish().transform((v) => v ?? void 0),
  payer: external_exports.string().nullish().transform((v) => v ?? void 0),
  extensions: external_exports.record(external_exports.string(), external_exports.unknown()).nullish().transform((v) => v ?? void 0),
  extra: external_exports.record(external_exports.string(), external_exports.unknown()).nullish().transform((v) => v ?? void 0)
});
var settleResponseSchema = external_exports.object({
  success: external_exports.boolean(),
  errorReason: external_exports.string().nullish().transform((v) => v ?? void 0),
  errorMessage: external_exports.string().nullish().transform((v) => v ?? void 0),
  payer: external_exports.string().nullish().transform((v) => v ?? void 0),
  transaction: external_exports.string(),
  network: external_exports.custom((value) => typeof value === "string"),
  amount: external_exports.string().nullish().transform((v) => v ?? void 0),
  extensions: external_exports.record(external_exports.string(), external_exports.unknown()).nullish().transform((v) => v ?? void 0),
  extra: external_exports.record(external_exports.string(), external_exports.unknown()).nullish().transform((v) => v ?? void 0)
});
var supportedKindSchema = external_exports.object({
  x402Version: external_exports.number(),
  scheme: external_exports.string(),
  network: external_exports.custom(
    (value) => typeof value === "string"
  ),
  extra: external_exports.record(external_exports.string(), external_exports.unknown()).nullish().transform((v) => v ?? void 0)
});
var supportedResponseSchema = external_exports.object({
  kinds: external_exports.array(supportedKindSchema),
  extensions: external_exports.array(external_exports.string()).default([]),
  signers: external_exports.record(external_exports.string(), external_exports.array(external_exports.string())).default({})
});
var x402HTTPClient = class {
  /**
   * Creates a new x402HTTPClient instance.
   *
   * @param client - The underlying x402Client for payment logic
   */
  constructor(client) {
    this.client = client;
    this.paymentRequiredHooks = [];
  }
  /**
   * Register a hook to handle 402 responses before payment.
   * Hooks run in order; first to return headers wins.
   *
   * @param hook - The hook function to register
   * @returns This instance for chaining
   */
  onPaymentRequired(hook) {
    this.paymentRequiredHooks.push(hook);
    return this;
  }
  /**
   * Run hooks and return headers if any hook provides them.
   *
   * @param paymentRequired - The payment required response from the server
   * @returns Headers to use for retry, or null to proceed to payment
   */
  async handlePaymentRequired(paymentRequired) {
    for (const hook of this.getPaymentRequiredHooks(paymentRequired)) {
      const result = await hook({ paymentRequired });
      if (result?.headers) {
        return result.headers;
      }
    }
    return null;
  }
  /**
   * Encodes a payment payload into appropriate HTTP headers based on version.
   *
   * @param paymentPayload - The payment payload to encode
   * @returns HTTP headers containing the encoded payment signature
   */
  encodePaymentSignatureHeader(paymentPayload) {
    switch (paymentPayload.x402Version) {
      case 2:
        return {
          "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload)
        };
      case 1:
        return {
          "X-PAYMENT": encodePaymentSignatureHeader(paymentPayload)
        };
      default:
        throw new Error(
          `Unsupported x402 version: ${paymentPayload.x402Version}`
        );
    }
  }
  /**
   * Extracts payment required information from HTTP response.
   *
   * @param getHeader - Function to retrieve header value by name (case-insensitive)
   * @param body - Optional response body for v1 compatibility
   * @returns The payment required object
   */
  getPaymentRequiredResponse(getHeader, body) {
    const paymentRequired = getHeader("PAYMENT-REQUIRED");
    if (paymentRequired) {
      return decodePaymentRequiredHeader(paymentRequired);
    }
    if (body && body instanceof Object && "x402Version" in body && body.x402Version === 1) {
      return body;
    }
    throw new Error("Invalid payment required response");
  }
  /**
   * Extracts payment settlement response from HTTP headers.
   *
   * @param getHeader - Function to retrieve header value by name (case-insensitive)
   * @returns The settlement response object
   */
  getPaymentSettleResponse(getHeader) {
    const paymentResponse = getHeader("PAYMENT-RESPONSE");
    if (paymentResponse) {
      return decodePaymentResponseHeader(paymentResponse);
    }
    const xPaymentResponse = getHeader("X-PAYMENT-RESPONSE");
    if (xPaymentResponse) {
      return decodePaymentResponseHeader(xPaymentResponse);
    }
    throw new Error("Payment response header not found");
  }
  /**
   * Creates a payment payload for the given payment requirements.
   * Delegates to the underlying x402Client.
   *
   * @param paymentRequired - The payment required response from the server
   * @returns Promise resolving to the payment payload
   */
  async createPaymentPayload(paymentRequired) {
    return this.client.createPaymentPayload(paymentRequired);
  }
  /**
   * Parses response headers into protocol types, fires payment response hooks (v2 only),
   * and returns whether a hook signaled recovery.
   *
   * Called by transport wrappers (fetch, axios) after the paid request completes.
   *
   * @param paymentPayload - The payload that was sent with the request
   * @param getHeader - Function to retrieve a response header by name
   * @param status - The HTTP status code of the response
   * @returns Whether a hook recovered and the parsed settle response (if any)
   */
  async processPaymentResult(paymentPayload, getHeader, status) {
    let settleResponse;
    try {
      settleResponse = this.getPaymentSettleResponse(getHeader);
    } catch {
    }
    if (paymentPayload.x402Version === 1) {
      return { recovered: false, settleResponse };
    }
    let paymentRequired;
    if (!settleResponse && status === 402) {
      try {
        paymentRequired = this.getPaymentRequiredResponse(getHeader);
      } catch {
      }
    }
    const requirements = paymentPayload.accepted;
    if (!requirements) {
      throw new Error("Invalid x402 v2 payment payload: missing `accepted`");
    }
    const ctx = {
      paymentPayload,
      requirements,
      ...settleResponse ? { settleResponse } : {},
      ...paymentRequired ? { paymentRequired } : {}
    };
    const result = await this.client.handlePaymentResponse(ctx);
    return { recovered: result?.recovered === true, settleResponse };
  }
  /**
   * Parses HTTP status, headers, and body into an `HTTPResourceResponse`.
   *
   * Decodes the x402 payment header into `header`: the `PAYMENT-RESPONSE`
   * settlement if present, otherwise the `PAYMENT-REQUIRED` declaration on
   * 402 responses (whose `error` field carries the server's failure reason).
   *
   * @param args - Normalized response inputs from any HTTP transport
   * @param args.status - HTTP response status code
   * @param args.getHeader - Callback to read response headers by name
   * @param args.body - Response body payload
   * @returns The parsed status, body, and decoded payment header
   */
  parsePaymentResult(args) {
    const { status, getHeader, body } = args;
    let header;
    try {
      header = this.getPaymentSettleResponse(getHeader);
    } catch {
      if (status === 402) {
        try {
          header = this.getPaymentRequiredResponse(getHeader, body);
        } catch {
        }
      }
    }
    let paymentStatus = "none";
    if (header && !("success" in header)) {
      paymentStatus = "payment_required";
    }
    if (header && "success" in header) {
      paymentStatus = header.success ? "settled" : "settle_failed";
    }
    return { status, paymentStatus, body, header };
  }
  /**
   * Parses a fetch Response into an `HTTPResourceResponse` for app-level convenience.
   *
   * @param response - The fetch Response to process
   * @returns The parsed status, body, and decoded payment header
   */
  async processResponse(response) {
    const getHeader = (name) => response.headers.get(name);
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    return this.parsePaymentResult({ status: response.status, getHeader, body });
  }
  /**
   * Manual HTTP hooks run before extension hooks scoped to the 402 response.
   *
   * @param paymentRequired - The payment required response from the server
   * @returns Hooks in invocation order
   */
  getPaymentRequiredHooks(paymentRequired) {
    const hooks = [...this.paymentRequiredHooks];
    const declaredExtensions = paymentRequired.extensions;
    if (!declaredExtensions) return hooks;
    for (const extension of this.client.getExtensions()) {
      const httpExtension = extension;
      const hook = httpExtension.transportHooks?.http?.onPaymentRequired;
      if (!hook || !(extension.key in declaredExtensions)) continue;
      hooks.push((context) => hook(declaredExtensions[extension.key], context));
    }
    return hooks;
  }
};
function encodePaymentSignatureHeader(paymentPayload) {
  return safeBase64Encode(JSON.stringify(paymentPayload));
}
function decodePaymentRequiredHeader(paymentRequiredHeader) {
  if (!Base64EncodedRegex.test(paymentRequiredHeader)) {
    throw new Error("Invalid payment required header");
  }
  return JSON.parse(safeBase64Decode(paymentRequiredHeader));
}
function decodePaymentResponseHeader(paymentResponseHeader) {
  if (!Base64EncodedRegex.test(paymentResponseHeader)) {
    throw new Error("Invalid payment response header");
  }
  return JSON.parse(safeBase64Decode(paymentResponseHeader));
}

// node_modules/@x402/core/dist/esm/client/index.mjs
var x402Client = class _x402Client {
  /**
   * Creates a new x402Client instance.
   *
   * @param paymentRequirementsSelector - Function to select payment requirements from available options
   */
  constructor(paymentRequirementsSelector) {
    this.registeredClientSchemes = /* @__PURE__ */ new Map();
    this.schemeClientHookAdapters = /* @__PURE__ */ new Map();
    this.policies = [];
    this.registeredExtensions = /* @__PURE__ */ new Map();
    this.beforePaymentCreationHooks = [];
    this.afterPaymentCreationHooks = [];
    this.onPaymentCreationFailureHooks = [];
    this.paymentResponseHooks = [];
    this.paymentRequirementsSelector = paymentRequirementsSelector || ((x402Version2, accepts) => accepts[0]);
  }
  /**
   * Creates a new x402Client instance from a configuration object.
   *
   * @param config - The client configuration including schemes, policies, and payment requirements selector
   * @returns A configured x402Client instance
   */
  static fromConfig(config) {
    const client = new _x402Client(config.paymentRequirementsSelector);
    config.schemes.forEach((scheme) => {
      if (scheme.x402Version === 1) {
        client.registerV1(scheme.network, scheme.client);
      } else {
        client.register(scheme.network, scheme.client);
      }
    });
    config.policies?.forEach((policy) => {
      client.registerPolicy(policy);
    });
    return client;
  }
  /**
   * Registers a scheme client for the current x402 version.
   *
   * @param network - The network to register the client for
   * @param client - The scheme network client to register
   * @returns The x402Client instance for chaining
   */
  register(network, client) {
    return this._registerScheme(x402Version, network, client);
  }
  /**
   * Registers a scheme client for x402 version 1.
   *
   * @param network - The v1 network identifier (e.g., 'base-sepolia', 'solana-devnet')
   * @param client - The scheme network client to register
   * @returns The x402Client instance for chaining
   */
  registerV1(network, client) {
    return this._registerScheme(1, network, client);
  }
  /**
   * Registers a policy to filter or transform payment requirements.
   *
   * Policies are applied in order after filtering by registered schemes
   * and before the selector chooses the final payment requirement.
   *
   * @param policy - Function to filter/transform payment requirements
   * @returns The x402Client instance for chaining
   *
   * @example
   * ```typescript
   * // Prefer cheaper options
   * client.registerPolicy((version, reqs) =>
   *   reqs.filter(r => BigInt(r.value) < BigInt('1000000'))
   * );
   *
   * // Prefer specific networks
   * client.registerPolicy((version, reqs) =>
   *   reqs.filter(r => r.network.startsWith('eip155:'))
   * );
   * ```
   */
  registerPolicy(policy) {
    this.policies.push(policy);
    return this;
  }
  /**
   * Registers a client extension that can enrich payment payloads.
   *
   * Extensions are invoked after the scheme creates the base payload and the
   * payload is wrapped with extensions/resource/accepted data. If the extension's
   * key is present in `paymentRequired.extensions`, the extension's
   * `enrichPaymentPayload` hook is called to modify the payload.
   *
   * @param extension - The client extension to register
   * @returns The x402Client instance for chaining
   */
  registerExtension(extension) {
    this.registeredExtensions.set(extension.key, extension);
    return this;
  }
  /**
   * Get all registered client extensions.
   *
   * @returns Array of registered extensions
   */
  getExtensions() {
    return Array.from(this.registeredExtensions.values());
  }
  /**
   * Register a hook to execute before payment payload creation.
   * Can abort creation by returning { abort: true, reason: string }
   *
   * @param hook - The hook function to register
   * @returns The x402Client instance for chaining
   */
  onBeforePaymentCreation(hook) {
    this.beforePaymentCreationHooks.push(hook);
    return this;
  }
  /**
   * Register a hook to execute after successful payment payload creation.
   *
   * @param hook - The hook function to register
   * @returns The x402Client instance for chaining
   */
  onAfterPaymentCreation(hook) {
    this.afterPaymentCreationHooks.push(hook);
    return this;
  }
  /**
   * Register a hook to execute when payment payload creation fails.
   * Can recover from failure by returning { recovered: true, payload: PaymentPayload }
   *
   * @param hook - The hook function to register
   * @returns The x402Client instance for chaining
   */
  onPaymentCreationFailure(hook) {
    this.onPaymentCreationFailureHooks.push(hook);
    return this;
  }
  /**
   * Register a hook to execute after a paid request completes.
   * Can signal recovery by returning { recovered: true }, causing the transport to retry.
   *
   * @param hook - The hook function to register
   * @returns The x402Client instance for chaining
   */
  onPaymentResponse(hook) {
    this.paymentResponseHooks.push(hook);
    return this;
  }
  /**
   * Fires all registered payment response hooks in order.
   * Returns `{ recovered: true }` if any hook signals recovery (first wins).
   *
   * @param ctx - The payment response context
   * @returns Recovery signal or undefined
   */
  async handlePaymentResponse(ctx) {
    for (const hook of this.getLabeledHooks(
      "onPaymentResponse",
      ctx.paymentPayload.x402Version,
      ctx.requirements,
      ctx.paymentRequired?.extensions ?? ctx.paymentPayload.extensions
    )) {
      const result = await hook(ctx);
      if (result && "recovered" in result && result.recovered) {
        return { recovered: true };
      }
    }
    return void 0;
  }
  /**
   * Creates a payment payload based on a PaymentRequired response.
   *
   * Automatically extracts x402Version, resource, and extensions from the PaymentRequired
   * response and constructs a complete PaymentPayload with the accepted requirements.
   *
   * @param paymentRequired - The PaymentRequired response from the server
   * @returns Promise resolving to the complete payment payload
   */
  async createPaymentPayload(paymentRequired) {
    const clientSchemesByNetwork = this.registeredClientSchemes.get(paymentRequired.x402Version);
    if (!clientSchemesByNetwork) {
      throw new Error(`No client registered for x402 version: ${paymentRequired.x402Version}`);
    }
    const requirements = this.selectPaymentRequirements(paymentRequired.x402Version, paymentRequired.accepts);
    const context = {
      paymentRequired,
      selectedRequirements: requirements
    };
    for (const hook of this.getLabeledHooks(
      "beforePaymentCreation",
      paymentRequired.x402Version,
      requirements,
      paymentRequired.extensions
    )) {
      const result = await hook(context);
      if (result && "abort" in result && result.abort) {
        throw new Error(`Payment creation aborted: ${result.reason}`);
      }
    }
    try {
      const schemeNetworkClient = findByNetworkAndScheme(clientSchemesByNetwork, requirements.scheme, requirements.network);
      if (!schemeNetworkClient) {
        throw new Error(`No client registered for scheme: ${requirements.scheme} and network: ${requirements.network}`);
      }
      const partialPayload = await schemeNetworkClient.createPaymentPayload(
        paymentRequired.x402Version,
        requirements,
        { extensions: paymentRequired.extensions }
      );
      let paymentPayload;
      if (partialPayload.x402Version == 1) {
        paymentPayload = partialPayload;
      } else {
        const mergedExtensions = this.mergeExtensions(
          paymentRequired.extensions,
          partialPayload.extensions
        );
        paymentPayload = {
          x402Version: partialPayload.x402Version,
          payload: partialPayload.payload,
          extensions: mergedExtensions,
          resource: paymentRequired.resource,
          accepted: requirements
        };
      }
      paymentPayload = await this.enrichPaymentPayloadWithExtensions(paymentPayload, paymentRequired);
      const createdContext = {
        ...context,
        paymentPayload
      };
      for (const hook of this.getLabeledHooks(
        "afterPaymentCreation",
        paymentRequired.x402Version,
        requirements,
        paymentRequired.extensions
      )) {
        await hook(createdContext);
      }
      return paymentPayload;
    } catch (error) {
      const failureContext = {
        ...context,
        error
      };
      for (const hook of this.getLabeledHooks(
        "onPaymentCreationFailure",
        paymentRequired.x402Version,
        requirements,
        paymentRequired.extensions
      )) {
        const result = await hook(failureContext);
        if (result && "recovered" in result && result.recovered) {
          return result.payload;
        }
      }
      throw error;
    }
  }
  /**
   * Merges server-declared extensions with client extension echoes.
   * Client extension data may add fields, but server-declared fields remain intact.
   *
   * @param serverExtensions - Extensions declared by the server in the 402 response
   * @param clientExtensions - Extensions provided by the client or scheme
   * @returns The merged extensions object, or undefined if both inputs are undefined
   */
  mergeExtensions(serverExtensions, clientExtensions) {
    if (!clientExtensions) return serverExtensions;
    if (!serverExtensions) return clientExtensions;
    const merged = { ...serverExtensions };
    for (const [key, clientValue] of Object.entries(clientExtensions)) {
      const serverValue = merged[key];
      if (serverValue === null || typeof serverValue !== "object" || Array.isArray(serverValue) || clientValue === null || typeof clientValue !== "object" || Array.isArray(clientValue)) {
        merged[key] = clientValue;
        continue;
      }
      const serverRecord = serverValue;
      const clientRecord = clientValue;
      const extensionValue = { ...serverRecord };
      const pending = [{ target: extensionValue, source: clientRecord }];
      for (const item of pending) {
        for (const [fieldKey, clientFieldValue] of Object.entries(item.source)) {
          const serverFieldValue = item.target[fieldKey];
          if (serverFieldValue !== null && typeof serverFieldValue === "object" && !Array.isArray(serverFieldValue) && clientFieldValue !== null && typeof clientFieldValue === "object" && !Array.isArray(clientFieldValue)) {
            const nestedValue = { ...serverFieldValue };
            item.target[fieldKey] = nestedValue;
            pending.push({
              target: nestedValue,
              source: clientFieldValue
            });
            continue;
          }
          if (!Object.prototype.hasOwnProperty.call(item.target, fieldKey)) {
            item.target[fieldKey] = clientFieldValue;
          }
        }
      }
      merged[key] = extensionValue;
    }
    return merged;
  }
  /**
   * Enriches a payment payload by calling registered extension hooks.
   * For each extension key present in the PaymentRequired response,
   * invokes the corresponding extension's enrichPaymentPayload callback.
   *
   * @param paymentPayload - The payment payload to enrich with extension data
   * @param paymentRequired - The PaymentRequired response containing extension declarations
   * @returns The enriched payment payload with extension data applied
   */
  async enrichPaymentPayloadWithExtensions(paymentPayload, paymentRequired) {
    if (!paymentRequired.extensions || this.registeredExtensions.size === 0) {
      return paymentPayload;
    }
    let enriched = paymentPayload;
    for (const [key, extension] of this.registeredExtensions) {
      if (key in paymentRequired.extensions && extension.enrichPaymentPayload) {
        enriched = await extension.enrichPaymentPayload(enriched, paymentRequired);
      }
    }
    return {
      ...enriched,
      extensions: this.mergeExtensions(paymentRequired.extensions, enriched.extensions)
    };
  }
  /**
   * Selects appropriate payment requirements based on registered clients and policies.
   *
   * Selection process:
   * 1. Filter by registered schemes (network + scheme support)
   * 2. Apply all registered policies in order
   * 3. Use selector to choose final requirement
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - Array of available payment requirements
   * @returns The selected payment requirements
   */
  selectPaymentRequirements(x402Version2, paymentRequirements) {
    const clientSchemesByNetwork = this.registeredClientSchemes.get(x402Version2);
    if (!clientSchemesByNetwork) {
      throw new Error(`No client registered for x402 version: ${x402Version2}`);
    }
    const supportedPaymentRequirements = paymentRequirements.filter((requirement) => {
      let clientSchemes = findSchemesByNetwork(clientSchemesByNetwork, requirement.network);
      if (!clientSchemes) {
        return false;
      }
      return clientSchemes.has(requirement.scheme);
    });
    if (supportedPaymentRequirements.length === 0) {
      throw new Error(`No network/scheme registered for x402 version: ${x402Version2} which comply with the payment requirements. ${JSON.stringify({
        x402Version: x402Version2,
        paymentRequirements,
        x402Versions: Array.from(this.registeredClientSchemes.keys()),
        networks: Array.from(clientSchemesByNetwork.keys()),
        schemes: Array.from(clientSchemesByNetwork.values()).map((schemes) => Array.from(schemes.keys())).flat()
      })}`);
    }
    let filteredRequirements = supportedPaymentRequirements;
    for (const policy of this.policies) {
      filteredRequirements = policy(x402Version2, filteredRequirements);
      if (filteredRequirements.length === 0) {
        throw new Error(`All payment requirements were filtered out by policies for x402 version: ${x402Version2}`);
      }
    }
    return this.paymentRequirementsSelector(x402Version2, filteredRequirements);
  }
  /**
   * Internal method to register a scheme client.
   *
   * @param x402Version - The x402 protocol version
   * @param network - The network to register the client for
   * @param client - The scheme network client to register
   * @returns The x402Client instance for chaining
   */
  _registerScheme(x402Version2, network, client) {
    if (!this.registeredClientSchemes.has(x402Version2)) {
      this.registeredClientSchemes.set(x402Version2, /* @__PURE__ */ new Map());
    }
    const clientSchemesByNetwork = this.registeredClientSchemes.get(x402Version2);
    if (!clientSchemesByNetwork.has(network)) {
      clientSchemesByNetwork.set(network, /* @__PURE__ */ new Map());
    }
    const clientByScheme = clientSchemesByNetwork.get(network);
    clientByScheme.set(client.scheme, client);
    if (!this.schemeClientHookAdapters.has(x402Version2)) {
      this.schemeClientHookAdapters.set(x402Version2, /* @__PURE__ */ new Map());
    }
    const adaptersByNetwork = this.schemeClientHookAdapters.get(x402Version2);
    if (!adaptersByNetwork.has(network)) {
      adaptersByNetwork.set(network, /* @__PURE__ */ new Map());
    }
    const adaptersByScheme = adaptersByNetwork.get(network);
    const hooks = client.schemeHooks;
    if (!hooks) {
      adaptersByScheme.delete(client.scheme);
      return this;
    }
    const handles = {};
    if (hooks.onBeforePaymentCreation) {
      handles.beforePaymentCreation = hooks.onBeforePaymentCreation;
    }
    if (hooks.onAfterPaymentCreation) {
      handles.afterPaymentCreation = hooks.onAfterPaymentCreation;
    }
    if (hooks.onPaymentCreationFailure) {
      handles.onPaymentCreationFailure = hooks.onPaymentCreationFailure;
    }
    if (hooks.onPaymentResponse) {
      handles.onPaymentResponse = hooks.onPaymentResponse;
    }
    if (Object.keys(handles).length > 0) {
      adaptersByScheme.set(client.scheme, handles);
    } else {
      adaptersByScheme.delete(client.scheme);
    }
    return this;
  }
  /**
   * Returns manual hooks followed by the selected scheme hook and declared extension hooks.
   *
   * @param phase - Hook slot to collect
   * @param x402Version - Protocol version for the selected requirement
   * @param requirements - Selected payment requirement
   * @param declaredExtensions - Extension declarations that scope extension hooks
   * @returns Hooks in invocation order
   */
  getLabeledHooks(phase, x402Version2, requirements, declaredExtensions) {
    let manual;
    switch (phase) {
      case "beforePaymentCreation":
        manual = this.beforePaymentCreationHooks;
        break;
      case "afterPaymentCreation":
        manual = this.afterPaymentCreationHooks;
        break;
      case "onPaymentCreationFailure":
        manual = this.onPaymentCreationFailureHooks;
        break;
      case "onPaymentResponse":
        manual = this.paymentResponseHooks;
        break;
    }
    const out = [...manual];
    const adaptersByNetwork = this.schemeClientHookAdapters.get(x402Version2);
    const schemeAdapter = adaptersByNetwork ? findByNetworkAndScheme(adaptersByNetwork, requirements.scheme, requirements.network) : void 0;
    const hook = schemeAdapter?.[phase];
    if (hook !== void 0) {
      out.push(hook);
    }
    if (!declaredExtensions) {
      return out;
    }
    const extensionHookKey = this.getClientExtensionHookKey(phase);
    for (const [extensionKey, extension] of this.registeredExtensions) {
      if (!(extensionKey in declaredExtensions)) continue;
      const extensionHook = extension.hooks?.[extensionHookKey];
      if (!extensionHook) continue;
      out.push((async (ctx) => {
        return extensionHook(declaredExtensions[extensionKey], ctx);
      }));
    }
    return out;
  }
  /**
   * Maps internal hook phases to extension hook names.
   *
   * @param phase - Internal hook phase
   * @returns Extension hook key for the phase
   */
  getClientExtensionHookKey(phase) {
    switch (phase) {
      case "beforePaymentCreation":
        return "onBeforePaymentCreation";
      case "afterPaymentCreation":
        return "onAfterPaymentCreation";
      case "onPaymentCreationFailure":
        return "onPaymentCreationFailure";
      case "onPaymentResponse":
        return "onPaymentResponse";
    }
  }
};

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
    async payRaceFee(session, input) {
      const body = {
        slot: input.slot,
        wallet: session.address,
        displayName: input.displayName ?? walletDisplayName(session)
      };
      const url = `/race/round/${encodeURIComponent(input.roundId)}/join`;
      const first = await postJsonResponse(url, body);
      if (first.res.ok) return first.json;
      if (first.res.status !== 402) {
        throw new Error(errorMessage(first.json) || `race fee request failed ${first.res.status}`);
      }
      const httpClient = createX402HttpClient(session, signTypedData);
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => first.res.headers.get(name),
        first.json
      );
      const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
      const paid = await postJsonResponse(url, body, httpClient.encodePaymentSignatureHeader(paymentPayload));
      if (!paid.res.ok || errorMessage(paid.json)) {
        throw new Error(errorMessage(paid.json) || `paid race fee request failed ${paid.res.status}`);
      }
      let settlement;
      try {
        settlement = httpClient.getPaymentSettleResponse((name) => paid.res.headers.get(name));
      } catch {
        settlement = void 0;
      }
      return settlement ? { ...paid.json, settlement } : paid.json;
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
  const { res, json } = await postJsonResponse(url, body);
  if (!res.ok || errorMessage(json)) {
    throw new Error(errorMessage(json) || `request failed ${res.status}`);
  }
  return json;
}
async function postJsonResponse(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}
function createX402HttpClient(session, signTypedData) {
  const signer = {
    address: getAddress(session.address),
    signTypedData: async (params2) => signTypedData(session, {
      domain: params2.domain,
      types: params2.types,
      primaryType: params2.primaryType,
      message: params2.message
    })
  };
  const client = new x402Client((_version, requirements) => {
    const gatewayOption = requirements.find(isCircleBatchingRequirement);
    return gatewayOption ?? requirements[0];
  });
  client.register("eip155:*", new BrowserBatchEvmScheme(signer));
  return new x402HTTPClient(client);
}
var BrowserBatchEvmScheme = class {
  constructor(signer) {
    this.signer = signer;
  }
  signer;
  scheme = "exact";
  async createPaymentPayload(x402Version2, paymentRequirements) {
    if (!isCircleBatchingRequirement(paymentRequirements)) {
      throw new Error("x402 race fees require Circle Gateway batching payment requirements");
    }
    const verifyingContract = stringValue(paymentRequirements.extra?.verifyingContract);
    if (!verifyingContract) throw new Error("x402 payment requirements missing Gateway verifying contract");
    const now = Math.floor(Date.now() / 1e3);
    const validWindowSecs = Math.max(paymentRequirements.maxTimeoutSeconds, 7 * 24 * 60 * 60 + 100);
    const authorization = {
      from: this.signer.address,
      to: getAddress(paymentRequirements.payTo),
      value: paymentRequirements.amount,
      validAfter: String(now - 600),
      validBefore: String(now + validWindowSecs),
      nonce: randomHex32()
    };
    const signature = await this.signer.signTypedData({
      domain: {
        name: "GatewayWalletBatched",
        version: "1",
        chainId: chainIdFromNetwork(paymentRequirements.network),
        verifyingContract: getAddress(verifyingContract)
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" }
        ]
      },
      primaryType: "TransferWithAuthorization",
      message: authorization
    });
    return { x402Version: x402Version2, payload: { authorization, signature } };
  }
};
function shortenAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}
function errorMessage(value) {
  return typeof value === "object" && value && "error" in value ? stringValue(value.error) : void 0;
}
function isCircleBatchingRequirement(value) {
  return value.scheme === "exact" && value.network.startsWith("eip155:") && value.extra?.name === "GatewayWalletBatched" && value.extra?.version === "1";
}
function chainIdFromNetwork(network) {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`unsupported x402 network ${network}`);
  return Number(match[1]);
}
function randomHex32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
var manualMode = params.get("mode") === "manual";
var roundId = manualMode ? null : params.get("round");
var x402OnlyEntry = params.get("entry") === "x402" || params.get("show") === "1";
var driverSlot = parseDriverSlot(params.get("slot")) || "challenger";
var requestedSpeedMode = parseSpeedMode(params.get("speed"));
var speedMode = manualMode ? requestedSpeedMode === "high" ? "high" : "medium" : requestedSpeedMode || "medium";
document.documentElement.dataset.mode = manualMode ? "manual" : "race";
var driveWs = null;
var cameraWs = null;
var telemetryWs = null;
var token = "";
var connected = false;
var telemetryConnected = false;
var started = false;
var pilotStarting = false;
var hasConnected = false;
var sendInterval;
var cameraSendInterval;
var reconnectTimer;
var cameraReconnectTimer;
var cameraReconnectUrl = "";
var lastDrive = { left: 0, right: 0 };
var lastCamera = { pan: 0, tilt: 0 };
var lastTelemetryAt = 0;
var localStream = null;
var raceEntryComplete = false;
var controlUrls = {};
var stageCalibration = null;
var stageCalibrationLoaded = false;
var videoState = "idle";
var roundState = null;
var currentStreamUrl = "";
var pendingStreamUrl = "";
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
  driveZone: byId("driveZone"),
  cameraZone: byId("cameraZone"),
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
function deriveCameraWs(url) {
  return url.replace(/\/ws\/drive/, "/ws/camera");
}
function setConn(state, text) {
  els.conn.className = `conn ${state === "connecting" ? "" : state}`;
  els.connText.textContent = text;
}
function setModalStatus(text, tone = "dim") {
  els.modalStatus.textContent = text;
  els.modalStatus.className = `modal-status ${tone === "dim" ? "" : tone}`;
}
async function beginPilot() {
  if (started || pilotStarting) return;
  pilotStarting = true;
  els.startButton.disabled = true;
  els.startButton.textContent = roundId && !raceEntryComplete ? "CHECKING" : "CONNECTING";
  setModalStatus("Opening pilot session...");
  try {
    await completeRaceEntryIfNeeded();
    started = true;
    setModalStatus("Connecting controls...");
    connect();
  } catch (err) {
    pilotStarting = false;
    started = false;
    els.startButton.disabled = false;
    els.startButton.textContent = "TRY AGAIN";
    setModalStatus(err instanceof Error ? err.message : "race entry failed", "bad");
  }
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
      cameraWs: `${wsFromHttp(robotUrl)}/ws/camera`,
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
      telemetryWs: body2.telemetryWs || (body2.driveWs ? deriveTelemetryWs(body2.driveWs) : void 0),
      cameraWs: body2.cameraWs || (body2.driveWs ? deriveCameraWs(body2.driveWs) : void 0)
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
    telemetryWs: body.telemetryWs || (body.driveWs ? deriveTelemetryWs(body.driveWs) : void 0),
    cameraWs: body.cameraWs || (body.driveWs ? deriveCameraWs(body.driveWs) : void 0)
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
    if (manualMode) {
      stopCameraSending(false);
    } else {
      openCameraSocket(auth.cameraWs || deriveCameraWs(auth.driveWs));
    }
    if (auth.telemetryWs) openTelemetrySocket(auth.telemetryWs);
    els.startModal.classList.add("hidden");
    pilotStarting = false;
  } catch (err) {
    pilotStarting = false;
    const message = err instanceof Error ? err.message : "connection failed";
    setConn("down", message);
    if (roundId && isRaceWaitError(message)) {
      setConn("connecting", "waiting for race start");
      setModalStatus(message.includes("round must be locked") ? "Waiting for second driver..." : "Waiting for countdown...");
      reconnectTimer = window.setTimeout(connect, 1200);
      return;
    }
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
  setModalStatus("Paying race fee...");
  try {
    await signer.payRaceFee(session, {
      roundId,
      slot: driverSlot,
      displayName: walletDisplayName(session)
    });
  } catch (err) {
    if (!x402OnlyEntry) throw err;
    setModalStatus("Recording Arc entry...");
    await postJson2(`/race/round/${roundId}/show-enter`, {
      slot: driverSlot,
      wallet: session.address,
      displayName: walletDisplayName(session),
      reason: err instanceof Error ? err.message : "x402 pending"
    });
    raceEntryComplete = true;
    setModalStatus("Entry confirmed. Waiting for countdown...", "ok");
    return;
  }
  if (x402OnlyEntry) {
    setModalStatus("Confirming race entry...");
    await postJson2(`/race/round/${roundId}/stake-authorize`, {
      slot: driverSlot,
      authorization: {
        adapter: "manual",
        status: "verified",
        source: "show-x402-entry",
        amountUsdc: "0"
      }
    });
    raceEntryComplete = true;
    setModalStatus("Entry confirmed. Waiting for countdown...", "ok");
    return;
  }
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
function isRaceWaitError(message) {
  return message.includes("round must be locked before pilot delegation") || message.includes("countdown has not been scheduled") || message.includes("round has not started");
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
  if (manualMode) return true;
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
function openCameraSocket(url) {
  clearCameraReconnect();
  cameraReconnectUrl = url;
  cameraWs?.close();
  const socket = new WebSocket(url);
  cameraWs = socket;
  socket.onopen = () => {
    startCameraSending();
  };
  socket.onmessage = (event) => {
    try {
      const body = JSON.parse(event.data);
      if (body?.error) els.cameraDetail.textContent = body.error;
    } catch {
    }
  };
  socket.onclose = () => {
    if (cameraWs !== socket) return;
    stopCameraSending(false);
    if (started && connected) {
      cameraReconnectTimer = window.setTimeout(() => openCameraSocket(cameraReconnectUrl), 900);
    }
  };
}
function clearCameraReconnect() {
  if (cameraReconnectTimer) window.clearTimeout(cameraReconnectTimer);
  cameraReconnectTimer = void 0;
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
  const base = httpBaseFromDriveUrl(driveUrl);
  const nextStreamUrl = streamUrl || `${base}/stream`;
  if (forceLocalCamera) {
    clearStreamReconnect();
    clearStreamWatchdog();
    currentStreamUrl = nextStreamUrl;
    pendingStreamUrl = "";
    startLocalCamera();
    return;
  }
  if (currentStreamUrl === nextStreamUrl && els.video.src && (videoState === "streaming" || videoState === "reconnecting")) {
    pendingStreamUrl = "";
    return;
  }
  if (hasVisibleRemoteFrame()) {
    pendingStreamUrl = nextStreamUrl;
    return;
  }
  clearStreamReconnect();
  clearStreamWatchdog();
  currentStreamUrl = nextStreamUrl;
  pendingStreamUrl = "";
  streamReconnectAttempts = 0;
  connectRemoteStream();
}
function connectRemoteStream(forceRefresh = false) {
  if (!currentStreamUrl) return;
  const hadFrame = hasVisibleRemoteFrame();
  videoState = streamReconnectAttempts > 0 ? "reconnecting" : "idle";
  if (!hadFrame) {
    els.videoFallback.textContent = streamReconnectAttempts > 0 ? "camera reconnecting" : "connecting camera";
    els.videoFallback.style.display = "grid";
    els.video.classList.add("off");
  }
  els.video.style.display = "block";
  els.video.src = forceRefresh ? cacheBustUrl(currentStreamUrl) : currentStreamUrl;
  els.video.onload = () => {
    videoState = "streaming";
    streamReconnectAttempts = 0;
    clearStreamWatchdog();
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
  const hadFrame = hasVisibleRemoteFrame();
  videoState = "reconnecting";
  clearStreamWatchdog();
  if (!hadFrame) {
    els.video.classList.add("off");
    els.videoFallback.textContent = "camera reconnecting";
    els.videoFallback.style.display = "grid";
  }
  if (pendingStreamUrl && pendingStreamUrl !== currentStreamUrl) {
    currentStreamUrl = pendingStreamUrl;
    pendingStreamUrl = "";
    streamReconnectAttempts = 0;
  }
  scheduleStreamReconnect();
}
function hasVisibleRemoteFrame() {
  return Boolean(
    els.video.src && !els.video.classList.contains("off") && (videoState === "streaming" || videoState === "reconnecting")
  );
}
function scheduleStreamReconnect() {
  clearStreamReconnect();
  streamReconnectAttempts += 1;
  const delayMs = Math.min(5e3, 700 + streamReconnectAttempts * 800);
  streamReconnectTimer = window.setTimeout(() => connectRemoteStream(true), delayMs);
}
function clearStreamReconnect() {
  if (streamReconnectTimer) window.clearTimeout(streamReconnectTimer);
  streamReconnectTimer = void 0;
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
function sendCamera(pan, tilt) {
  if (!started) return;
  if (!cameraWs || cameraWs.readyState !== WebSocket.OPEN) return;
  cameraWs.send(JSON.stringify({ pan, tilt, token, speed_mode: speedMode }));
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
  clearSendInterval();
  send(lastDrive.left, lastDrive.right);
  sendInterval = window.setInterval(() => send(lastDrive.left, lastDrive.right), 33);
}
function startCameraSending() {
  clearCameraSendInterval();
  cameraSendInterval = window.setInterval(() => sendCamera(lastCamera.pan, lastCamera.tilt), 33);
}
function clearSendInterval() {
  if (sendInterval) window.clearInterval(sendInterval);
  sendInterval = void 0;
}
function clearCameraSendInterval() {
  if (cameraSendInterval) window.clearInterval(cameraSendInterval);
  cameraSendInterval = void 0;
}
function stopSending() {
  clearSendInterval();
  stopCameraSending();
  lastDrive = { left: 0, right: 0 };
  setStickKnob(els.driveZone, 0, 0);
  send(0, 0);
}
function stopCameraSending(sendZero = true) {
  clearCameraSendInterval();
  lastCamera = { pan: 0, tilt: 0 };
  if (sendZero) sendCamera(0, 0);
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
  els.lidar.className = "";
  if (frame.estop) {
    els.direction.textContent = "Emergency stop";
  } else if (frame.soft_odometry_limited) {
    els.direction.textContent = "Stage limit";
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
  const panTilt = camera?.pan !== void 0 || camera?.tilt !== void 0 ? `p${(camera.pan ?? 0).toFixed(1)} t${(camera.tilt ?? 0).toFixed(1)}` : void 0;
  const parts = [
    camera?.fps !== void 0 ? `${camera.fps.toFixed(0)}fps` : void 0,
    age !== void 0 ? `${age.toFixed(0)}ms` : void 0,
    panTilt,
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
  if (distance === void 0) return "--";
  return `${distance.toFixed(2)}m`;
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
  setupPointerStick(els.driveZone, {
    onMove: ({ fwd, turn, x, y }) => {
      setStickKnob(els.driveZone, x, y);
      lastDrive = {
        left: Math.max(-1, Math.min(1, fwd + turn * 0.6)),
        right: Math.max(-1, Math.min(1, fwd - turn * 0.6))
      };
      if (manualMode && sendInterval) send(lastDrive.left, lastDrive.right);
    },
    onStart: startSending,
    onEnd: () => {
      if (!sendInterval) startSending();
    }
  });
  if (manualMode) return;
  setupPointerStick(els.cameraZone, {
    onMove: ({ fwd, turn, x, y }) => {
      setStickKnob(els.cameraZone, x, y);
      lastCamera = {
        pan: Math.max(-1, Math.min(1, turn)),
        tilt: Math.max(-1, Math.min(1, fwd))
      };
    },
    onStart: startCameraSending,
    onEnd: () => {
      lastCamera = { pan: 0, tilt: 0 };
      setStickKnob(els.cameraZone, 0, 0);
      sendCamera(0, 0);
    }
  });
}
function setupPointerStick(zone, opts) {
  let activeInput = null;
  let lastTouchAt = 0;
  const begin = (id, clientX, clientY) => {
    if (!started) return;
    activeInput = id;
    opts.onStart();
    opts.onMove(pointAxes(zone, clientX, clientY));
  };
  const move = (id, clientX, clientY) => {
    if (activeInput !== id) return;
    opts.onMove(pointAxes(zone, clientX, clientY));
  };
  const end = (id) => {
    if (activeInput !== id) return;
    activeInput = null;
    opts.onEnd();
  };
  zone.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    zone.setPointerCapture?.(event.pointerId);
    begin(`p${event.pointerId}`, event.clientX, event.clientY);
  });
  zone.addEventListener("pointermove", (event) => {
    event.preventDefault();
    move(`p${event.pointerId}`, event.clientX, event.clientY);
  });
  zone.addEventListener("pointerup", (event) => {
    event.preventDefault();
    zone.releasePointerCapture?.(event.pointerId);
    end(`p${event.pointerId}`);
  });
  zone.addEventListener("pointercancel", (event) => {
    event.preventDefault();
    zone.releasePointerCapture?.(event.pointerId);
    end(`p${event.pointerId}`);
  });
  zone.addEventListener("touchstart", (event) => {
    event.preventDefault();
    lastTouchAt = Date.now();
    const touch = event.changedTouches[0];
    if (!touch) return;
    begin(`t${touch.identifier}`, touch.clientX, touch.clientY);
  }, { passive: false });
  zone.addEventListener("touchmove", (event) => {
    event.preventDefault();
    for (const touch of Array.from(event.changedTouches)) {
      move(`t${touch.identifier}`, touch.clientX, touch.clientY);
    }
  }, { passive: false });
  const touchEnd = (event) => {
    event.preventDefault();
    lastTouchAt = Date.now();
    for (const touch of Array.from(event.changedTouches)) {
      end(`t${touch.identifier}`);
    }
  };
  zone.addEventListener("touchend", touchEnd, { passive: false });
  zone.addEventListener("touchcancel", touchEnd, { passive: false });
  zone.addEventListener("mousedown", (event) => {
    if (Date.now() - lastTouchAt < 700) return;
    event.preventDefault();
    begin("m0", event.clientX, event.clientY);
  });
  window.addEventListener("mousemove", (event) => {
    if (activeInput !== "m0") return;
    event.preventDefault();
    move("m0", event.clientX, event.clientY);
  });
  window.addEventListener("mouseup", (event) => {
    if (activeInput !== "m0") return;
    event.preventDefault();
    end("m0");
  });
}
function pointAxes(zone, clientX, clientY) {
  const rect = zone.getBoundingClientRect();
  const radius = Math.max(1, Math.min(rect.width, rect.height) * 0.42);
  const rawX = clientX - (rect.left + rect.width / 2);
  const rawY = clientY - (rect.top + rect.height / 2);
  const distance = Math.hypot(rawX, rawY);
  const scale = distance > radius ? radius / distance : 1;
  const x = rawX * scale;
  const y = rawY * scale;
  return {
    fwd: Math.max(-1, Math.min(1, -y / radius)),
    turn: Math.max(-1, Math.min(1, x / radius)),
    x,
    y
  };
}
function setStickKnob(zone, x, y) {
  const knob = zone.querySelector(".stick-knob");
  if (!knob) return;
  knob.style.setProperty("--x", `${x.toFixed(1)}px`);
  knob.style.setProperty("--y", `${y.toFixed(1)}px`);
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
  const startFromEvent = (event) => {
    event.preventDefault();
    void beginPilot();
  };
  els.startButton.addEventListener("click", startFromEvent);
  els.startButton.addEventListener("pointerup", startFromEvent);
  els.startButton.addEventListener("touchend", startFromEvent, { passive: false });
  els.throttle.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const next = parseSpeedMode(button.dataset.speed || "");
      if (next) setSpeedMode(next);
    });
  });
  renderSpeedMode(speedMode);
  window.addEventListener("pagehide", stopSending);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopSending();
  });
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
if (manualMode) {
  els.modalTitle.textContent = "Start Manual Drive";
  els.modalCopy.textContent = "Connect to the Clanker500 camera and unlock direct low-speed control.";
  setModalStatus("Manual mode bypasses race timing");
  els.direction.textContent = "Tap start";
  els.raceTimer.textContent = "manual";
} else if (roundId) {
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
window.__pilotReady = true;
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
