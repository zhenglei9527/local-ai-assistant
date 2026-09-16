/**
 * 生成测试用 PNG —— 内置 tEXt chunk 写入器
 *
 * 纯 Node 实现，不依赖任何第三方库（本模块的解析器同样零依赖，
 * 这里刻意用独立的实现来生成测试样本，避免「用同一份 bug 的代码
 * 自证正确」）。
 *
 * PNG 结构（RFC 2083）：
 *   签名(8B) + [IHDR] + [tEXt]* + [IDAT] + [IEND]
 * 这里生成的是**结构合法但像素为空**的 PNG：够用于解析器测试，
 * 因为解析器只读 tEXt，不关心 IDAT 内容。
 */

import { deflateSync } from 'node:zlib';

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff));
}

/** 构造一个 PNG chunk：length + type + data + crc(type+data) */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = ascii(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 4 + body.length);
  return out;
}

/** tEXt chunk 的 data = keyword + 0x00 + text（均为 Latin-1） */
function textChunk(keyword: string, text: string): Uint8Array {
  const k = ascii(keyword);
  const t = ascii(text);
  const data = new Uint8Array(k.length + 1 + t.length);
  data.set(k, 0);
  data[k.length] = 0;
  data.set(t, k.length + 1);
  return chunk('tEXt', data);
}

export interface MakePngOptions {
  /** keyword -> 原始文本（调用方决定是否 base64） */
  texts?: Array<{ keyword: string; text: string }>;
  width?: number;
  height?: number;
}

/**
 * 生成一张最小 PNG。
 *
 * 注意：这里生成的 IDAT 是「合法的 zlib 流 + 正确的扫描线长度」，
 * 但**不保证像素内容有意义**（全 0 即全黑）。这对解析测试足够。
 */
export function makePng(opts: MakePngOptions = {}): Uint8Array {
  const width = opts.width ?? 2;
  const height = opts.height ?? 2;

  const parts: Uint8Array[] = [];
  // 签名
  parts.push(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // IHDR: width(4) height(4) bitDepth(1) colorType(1) compression(1) filter(1) interlace(1)
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  parts.push(chunk('IHDR', ihdr));

  // tEXt chunk(s) —— 必须在 IHDR 之后、IEND 之前
  for (const t of opts.texts ?? []) {
    parts.push(textChunk(t.keyword, t.text));
  }

  // IDAT: 每条扫描线前有 1 字节 filter type，RGBA 为 4 字节/像素
  const raw = new Uint8Array(height * (1 + width * 4));
  parts.push(chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))));

  parts.push(chunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 把 UTF-8 字符串编码为 base64（Node 环境） */
export function toBase64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
