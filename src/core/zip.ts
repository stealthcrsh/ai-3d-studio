/** Minimal ZIP writer. Files are stored uncompressed, since GLB and JPEG data are already compact. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const headers = files.map((f) => ({ ...f, nameBytes: enc.encode(f.name), crc: crc32(f.data) }));
  const localSize = headers.reduce((s, f) => s + 30 + f.nameBytes.length + f.data.length, 0);
  const centralSize = headers.reduce((s, f) => s + 46 + f.nameBytes.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const dv = new DataView(out.buffer);
  let p = 0;
  const offsets: number[] = [];
  for (const f of headers) {
    offsets.push(p);
    dv.setUint32(p, 0x04034b50, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 0x0800, true);
    dv.setUint16(p + 8, 0, true);
    dv.setUint32(p + 14, f.crc, true);
    dv.setUint32(p + 18, f.data.length, true);
    dv.setUint32(p + 22, f.data.length, true);
    dv.setUint16(p + 26, f.nameBytes.length, true);
    out.set(f.nameBytes, p + 30);
    out.set(f.data, p + 30 + f.nameBytes.length);
    p += 30 + f.nameBytes.length + f.data.length;
  }
  const centralStart = p;
  headers.forEach((f, i) => {
    dv.setUint32(p, 0x02014b50, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 20, true);
    dv.setUint16(p + 8, 0x0800, true);
    dv.setUint32(p + 16, f.crc, true);
    dv.setUint32(p + 20, f.data.length, true);
    dv.setUint32(p + 24, f.data.length, true);
    dv.setUint16(p + 28, f.nameBytes.length, true);
    dv.setUint32(p + 42, offsets[i], true);
    out.set(f.nameBytes, p + 46);
    p += 46 + f.nameBytes.length;
  });
  dv.setUint32(p, 0x06054b50, true);
  dv.setUint16(p + 8, headers.length, true);
  dv.setUint16(p + 10, headers.length, true);
  dv.setUint32(p + 12, centralSize, true);
  dv.setUint32(p + 16, centralStart, true);
  return out;
}
