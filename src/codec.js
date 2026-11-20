// 归档内容编解码。
//
// 格式约定 (v1):
//   files 表的 content  = zstd 流   (载荷)
//   notice 表的 content = gzip 流   (提示文件, 供"按扩展名误当压缩包"的工具扫描到)
//
// 两种格式都是单向流 + 固定魔数开头, 所以扫描器总是命中"偏移最低"的那一个。
// 把提示文件放进最先创建的 notice 表 -> 它独占 page 2, 偏移必然低于所有载荷 (page 3+),
// 从而保证"解压出来的就是提示文件"。
//
// 读取时按魔数自动识别, 兼容历史格式 (gzip / zip 条目)。
const zlib = require('zlib');
const zipentry = require('./zipentry');

// 带内嵌文件名的 gzip (RFC 1952 FNAME 字段): 扫描型工具解压时以该名字命名输出文件。
// zlib.gzipSync 不支持嵌入名字 (解出名只能随宿主文件名推算), 故手工组帧;
// MTIME 固定 0 保持确定性, 除 FLG/FNAME 外与 gzipSync 输出一致。
function gzipNamed(data, name) {
    const deflated = zlib.deflateRawSync(data);
    const nameBuf = Buffer.concat([Buffer.from(String(name), 'utf8'), Buffer.from([0])]);
    const header = Buffer.alloc(10);
    header[0] = 0x1f;
    header[1] = 0x8b;
    header[2] = 0x08;                       // CM: deflate
    header[3] = 0x08;                       // FLG: FNAME
    header.writeUInt32LE(0, 4);             // MTIME: 0 (确定性)
    header[8] = 0;                          // XFL
    header[9] = 3;                          // OS: Unix
    const trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(zlib.crc32(data) >>> 0, 0);
    trailer.writeUInt32LE(data.length >>> 0, 4);
    return Buffer.concat([header, nameBuf, deflated, trailer]);
}

const FORMATS = {
    gzip: {
        magic: Buffer.from([0x1f, 0x8b, 0x08]),
        encode: (data, name) => (name ? gzipNamed(data, name) : zlib.gzipSync(data)),
        decode: (buf) => zlib.gunzipSync(buf),
    },
    zstd: {
        magic: Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
        encode: (data) => zlib.zstdCompressSync(data),
        decode: (buf) => zlib.zstdDecompressSync(buf),
    },
    zip: {
        magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        encode: (data, name) => zipentry.pack(Buffer.from(String(name), 'utf8'), data),
        decode: (buf) => zipentry.unpack(buf).data,
    },
};

// 按魔数识别内容格式
function detect(buf) {
    for (const name of Object.keys(FORMATS)) {
        const f = FORMATS[name];
        if (buf.length >= f.magic.length && buf.subarray(0, f.magic.length).equals(f.magic)) {
            return name;
        }
    }
    return null;
}

// 解压任意已知格式的内容
function decode(buf) {
    const name = detect(buf);
    if (!name) throw new Error('codec: 无法识别的内容格式 (既不是 gzip / zstd / zip)');
    return FORMATS[name].decode(buf);
}

module.exports = { FORMATS, detect, decode };