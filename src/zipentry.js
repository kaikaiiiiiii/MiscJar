// 单条目 zip 的构造与解析 (标准 zip 格式)
// 内容 = [local file header][name][deflate data][central directory][name][EOCD]
// 这是"一个完整的、只含一个文件的 zip 压缩包"的字节流, 可以原样存进 BLOB。
const zlib = require('zlib');

const LOCAL_SIG = 0x04034b50;
const CDIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_SIG_BUF = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// DOS 时间/日期: 固定为 1980-01-01, 避免引入非确定性
const DOS_TIME = 0;
const DOS_DATE = 0x21;

// 构造一个只含单个条目的 zip
function pack(name, data) {
    const nameBuf = Buffer.isBuffer(name) ? name : Buffer.from(String(name), 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const nameLen = nameBuf.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);          // version needed to extract
    local.writeUInt16LE(0x0800, 6);      // general purpose flag: UTF-8 名字
    local.writeUInt16LE(8, 8);           // compression method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameLen, 26);
    local.writeUInt16LE(0, 28);          // extra field length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CDIR_SIG, 0);
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameLen, 28);
    central.writeUInt16LE(0, 30);         // extra field length
    central.writeUInt16LE(0, 32);         // comment length
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE(0, 38);         // external attributes
    central.writeUInt32LE(0, 42);         // relative offset of local header

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);             // this disk number
    eocd.writeUInt16LE(0, 6);             // disk with central directory
    eocd.writeUInt16LE(1, 8);             // entries on this disk
    eocd.writeUInt16LE(1, 10);            // total entries
    eocd.writeUInt32LE(central.length + nameLen, 12);
    eocd.writeUInt32LE(30 + nameLen + compressed.length, 16);
    eocd.writeUInt16LE(0, 20);            // comment length

    return Buffer.concat([local, nameBuf, compressed, central, nameBuf, eocd]);
}

// 从一个 zip 条目字节流里取出条目名和原始内容
function unpack(buf) {
    const l = buf.indexOf(LOCAL_SIG_BUF);
    if (l < 0) throw new Error('zipentry: 不是合法的 zip 条目 (缺少 PK\\x03\\x04)');
    const nameLen = buf.readUInt16LE(l + 26);
    const extraLen = buf.readUInt16LE(l + 28);
    const compSize = buf.readUInt32LE(l + 18);
    const name = buf.subarray(l + 30, l + 30 + nameLen).toString('utf8');
    const start = l + 30 + nameLen + extraLen;
    const data = zlib.inflateRawSync(buf.subarray(start, start + compSize));
    return { name, data };
}

module.exports = { pack, unpack };
