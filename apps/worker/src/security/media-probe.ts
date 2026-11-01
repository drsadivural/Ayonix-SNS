// Media validation by content, not by the declared type or extension.
// Images: PNG, JPEG, GIF, WebP with real pixel dimensions. Video: MP4/MOV
// (ISO BMFF) with duration from mvhd and dimensions from the first video tkhd.

export interface ProbeResult {
  mime: string;
  kind: 'image' | 'video';
  width: number | null;
  height: number | null;
  duration_ms: number | null;
}

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16384;

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) + b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! + (b[o + 1]! << 8);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function png(b: Uint8Array): ProbeResult | null {
  if (b.length < 24 || u32(b, 0) !== 0x89504e47 || u32(b, 4) !== 0x0d0a1a0a || ascii(b, 12, 4) !== 'IHDR') return null;
  return { mime: 'image/png', kind: 'image', width: u32(b, 16), height: u32(b, 20), duration_ms: null };
}

function gif(b: Uint8Array): ProbeResult | null {
  if (b.length < 10 || !/^GIF8[79]a$/.test(ascii(b, 0, 6))) return null;
  return { mime: 'image/gif', kind: 'image', width: u16le(b, 6), height: u16le(b, 8), duration_ms: null };
}

function jpeg(b: Uint8Array): ProbeResult | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xd9 || marker === 0xda) break;
    const len = u16(b, o + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { mime: 'image/jpeg', kind: 'image', height: u16(b, o + 5), width: u16(b, o + 7), duration_ms: null };
    }
    o += 2 + len;
  }
  return { mime: 'image/jpeg', kind: 'image', width: null, height: null, duration_ms: null };
}

function webp(b: Uint8Array): ProbeResult | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  let width: number | null = null;
  let height: number | null = null;
  if (chunk === 'VP8X') {
    width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
  } else if (chunk === 'VP8 ') {
    width = u16le(b, 26) & 0x3fff;
    height = u16le(b, 28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  }
  return { mime: 'image/webp', kind: 'image', width, height, duration_ms: null };
}

/** Walk ISO BMFF boxes within [start,end). */
function* boxes(b: Uint8Array, start: number, end: number): Generator<{ type: string; start: number; size: number; header: number }> {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = ascii(b, o + 4, 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      const hi = u32(b, o + 8);
      const lo = u32(b, o + 12);
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header) return;
    yield { type, start: o, size, header };
    o += size;
  }
}

function mp4(b: Uint8Array): ProbeResult | null {
  if (b.length < 12 || ascii(b, 4, 4) !== 'ftyp') return null;
  const brand = ascii(b, 8, 4);
  const mime = brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  let duration_ms: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  for (const top of boxes(b, 0, b.length)) {
    if (top.type !== 'moov') continue;
    const moovEnd = Math.min(b.length, top.start + top.size);
    for (const child of boxes(b, top.start + top.header, moovEnd)) {
      const p = child.start + child.header;
      if (child.type === 'mvhd' && p + 32 <= b.length) {
        const version = b[p]!;
        if (version === 1) {
          const timescale = u32(b, p + 20);
          const dur = u32(b, p + 24) * 2 ** 32 + u32(b, p + 28);
          if (timescale) duration_ms = Math.round((dur / timescale) * 1000);
        } else {
          const timescale = u32(b, p + 12);
          const dur = u32(b, p + 16);
          if (timescale) duration_ms = Math.round((dur / timescale) * 1000);
        }
      }
      if (child.type === 'trak' && width === null) {
        for (const t of boxes(b, p, Math.min(b.length, child.start + child.size))) {
          if (t.type !== 'tkhd') continue;
          const tp = t.start + t.header;
          const version = b[tp]!;
          const off = tp + (version === 1 ? 88 : 76);
          if (off + 8 <= b.length) {
            const w = u32(b, off) / 65536;
            const h = u32(b, off + 4) / 65536;
            if (w > 0 && h > 0) {
              width = Math.round(w);
              height = Math.round(h);
            }
          }
        }
      }
    }
  }
  return { mime, kind: 'video', width, height, duration_ms };
}

export class MediaRejected extends Error {}

/**
 * Probe the first bytes of a file (and for MP4 the moov box, which may be at
 * the end; callers pass head and tail slices concatenated with `tail`).
 */
export function probeMedia(head: Uint8Array, tail?: Uint8Array): ProbeResult {
  const r = png(head) ?? gif(head) ?? jpeg(head) ?? webp(head);
  if (r) {
    if (r.width !== null && (r.width < 1 || r.width > MAX_IMAGE_PIXELS || (r.height ?? 0) < 1 || (r.height ?? 0) > MAX_IMAGE_PIXELS)) {
      throw new MediaRejected('Image dimensions are outside the supported range');
    }
    if (r.width === null) throw new MediaRejected('Image dimensions could not be read');
    return r;
  }
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') {
    let v = mp4(head);
    if (v && v.duration_ms === null && tail) {
      // moov at the end ("non-faststart"): scan the tail for a moov box.
      const idx = findMoov(tail);
      if (idx >= 0) {
        const fake = new Uint8Array(12 + tail.length - idx);
        fake.set(head.subarray(0, 12), 0);
        fake.set(tail.subarray(idx), 12);
        // Rewrite the ftyp size so the box walk lands on the moov header at offset 12.
        new DataView(fake.buffer).setUint32(0, 12);
        const t = mp4(fake);
        if (t) v = { ...v, duration_ms: t.duration_ms, width: t.width ?? v.width, height: t.height ?? v.height };
      }
    }
    if (!v) throw new MediaRejected('Unsupported video container');
    if (v.duration_ms === null) throw new MediaRejected('Video duration could not be read');
    if (v.duration_ms <= 0) throw new MediaRejected('Video has no duration');
    return v;
  }
  throw new MediaRejected('Unsupported file type. Upload PNG, JPEG, GIF, WebP, MP4 or MOV.');
}

function findMoov(b: Uint8Array): number {
  for (let i = 4; i + 4 <= b.length; i++) {
    if (b[i] === 0x6d && b[i + 1] === 0x6f && b[i + 2] === 0x6f && b[i + 3] === 0x76) return i - 4;
  }
  return -1;
}
