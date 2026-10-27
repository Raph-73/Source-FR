// Minimal ZIP STORE writer for small, explicitly selected workshop files.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const parts = [], entries = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Flat safe filenames required');
    const n = Buffer.from(name), b = Buffer.from(data), crc = crc32(b);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4);
    h.writeUInt16LE(33, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(b.length, 18); h.writeUInt32LE(b.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(33, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(h, n, b); entries.push(c, n); offset += h.length + n.length + b.length;
  }
  const central = Buffer.concat(entries), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}
module.exports = { zip, crc32 };
