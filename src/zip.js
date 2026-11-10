import zlib from 'node:zlib';

// Minimal ZIP (PKWARE APPNOTE 6.3) writer and reader for .video packages: deflate or store, UTF-8 names,
// no ZIP64 (entries and archive under 4 GiB), no encryption. Standard library only.
const UTF8 = 0x0800;
const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;
const LIMIT = 0xffffffff;

function dosTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    const year = Math.max(1980, d.getFullYear());
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

/**
 * entries: [{ name, data: Buffer, mtime?: Date, mode?: number }]; directories are implied by the names.
 * Small or already-compressed data is stored when deflate would not make it smaller.
 */
export function writeZip(entries) {
    const locals = [], centrals = [];
    let offset = 0;
    const seen = new Set();
    for (const entry of entries) {
        const name = entry.name.replaceAll('\\', '/');
        if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`zip: 不安全的文件名 ${entry.name}`);
        if (seen.has(name)) throw new Error(`zip: 重复的文件名 ${name}`);
        seen.add(name);
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
        if (data.length >= LIMIT) throw new Error(`zip: ${name} 超过 4 GiB`);
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        const method = deflated.length < data.length ? 8 : 0;
        const body = method ? deflated : data;
        const crc = zlib.crc32(data) >>> 0;
        const { time, date } = dosTime(entry.mtime ?? new Date(0));
        const nameBuf = Buffer.from(name, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(UTF8, 6); local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(CENTRAL, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(UTF8, 8);
        central.writeUInt16LE(method, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE((((entry.mode ?? 0o644) & 0xffff) | 0o100000) << 16 >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, body);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + body.length;
        if (offset >= LIMIT) throw new Error('zip: 压缩包超过 4 GiB');
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0); end.writeUInt16LE(seen.size, 8); end.writeUInt16LE(seen.size, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    if (seen.size > 0xffff) throw new Error('zip: 文件超过 65535 个');
    return Buffer.concat([...locals, ...centrals, end]);
}

/** Read a bounded plain store/deflate ZIP. Validate all metadata before allocating inflated content. */
export function readZip(buffer, {
    maxEntries = 10000,
    maxUncompressedBytes = 512 * 1024 * 1024,
    maxEntryBytes = 128 * 1024 * 1024,
} = {}) {
    const fail = (message) => { throw new Error(`zip: ${message}`); };
    if (!Buffer.isBuffer(buffer)) fail('输入必须是压缩包字节');
    for (const limit of [maxEntries, maxUncompressedBytes, maxEntryBytes]) {
        if (!Number.isSafeInteger(limit) || limit < 0) fail('解压限制必须是非负整数');
    }
    const bounds = (start, length, end = buffer.length) => {
        if (start < 0 || length < 0 || start + length > end) fail('文件被截断或目录边界损坏');
    };
    const extras = (start, length) => {
        const end = start + length;
        while (start < end) {
            bounds(start, 4, end);
            const id = buffer.readUInt16LE(start), size = buffer.readUInt16LE(start + 2);
            if (id === 1) fail('不支持 ZIP64');
            bounds(start + 4, size, end);
            start += 4 + size;
        }
    };
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
        if (buffer.readUInt32LE(i) === END && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break; }
    }
    if (eocd < 0) fail('找不到目录结尾，文件不是 zip 或已损坏');
    const count = buffer.readUInt16LE(eocd + 10);
    const centralSize = buffer.readUInt32LE(eocd + 12), centralStart = buffer.readUInt32LE(eocd + 16);
    if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) || buffer.readUInt16LE(eocd + 8) !== count) fail('不支持多卷压缩包');
    if (count === 0xffff || centralSize === LIMIT || centralStart === LIMIT) fail('不支持 ZIP64');
    if (count > maxEntries) fail('文件数量超过解压限制');
    if (centralStart + centralSize !== eocd) fail('目录边界损坏或使用了不支持的 ZIP64');
    bounds(centralStart, centralSize, eocd);
    const records = [], names = new Map(), ranges = [];
    let p = centralStart, total = 0;
    for (let k = 0; k < count; k++) {
        bounds(p, 46, eocd);
        if (buffer.readUInt32LE(p) !== CENTRAL) fail('目录损坏');
        const flags = buffer.readUInt16LE(p + 8), method = buffer.readUInt16LE(p + 10), crc = buffer.readUInt32LE(p + 16);
        const size = buffer.readUInt32LE(p + 20), unpacked = buffer.readUInt32LE(p + 24), nameLen = buffer.readUInt16LE(p + 28);
        const extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32);
        const mode = buffer.readUInt32LE(p + 38) >>> 16, local = buffer.readUInt32LE(p + 42);
        if (size === LIMIT || unpacked === LIMIT || local === LIMIT) fail('不支持 ZIP64');
        if (buffer.readUInt16LE(p + 34)) fail('不支持多卷压缩包');
        if (flags & (1 | 64 | 8192)) fail('不支持加密压缩包');
        if (method !== 0 && method !== 8) fail(`不支持压缩方式 ${method}`);
        if (method === 0 && size !== unpacked) fail('未压缩条目的大小不一致');
        bounds(p + 46, nameLen + extraLen + commentLen, eocd);
        const nameBytes = buffer.subarray(p + 46, p + 46 + nameLen);
        let name;
        try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
        catch { fail('文件名不是有效的 UTF-8'); }
        const isDirectory = name.endsWith('/');
        const parts = (isDirectory ? name.slice(0, -1) : name).split('/');
        if (!name || /[\\:\x00-\x1f\x7f]/.test(name) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) fail(`不安全的文件名 ${name}`);
        const key = parts.join('/').normalize('NFC').toLowerCase();
        if (names.has(key)) fail(`重复或大小写冲突的文件名 ${name}`);
        names.set(key, isDirectory);
        const type = mode & 0o170000;
        if (type && type !== 0o100000 && type !== 0o040000) fail(`不允许符号链接或特殊文件 ${name}`);
        if ((type === 0o040000 && !isDirectory) || (type === 0o100000 && isDirectory)) fail(`文件类型与路径不一致 ${name}`);
        if (isDirectory && unpacked !== 0) fail(`目录包含文件数据 ${name}`);
        total += unpacked;
        if (unpacked > maxEntryBytes || total > maxUncompressedBytes) fail('解压大小超过限制');
        extras(p + 46 + nameLen, extraLen);
        p += 46 + nameLen + extraLen + commentLen;
        bounds(local, 30, centralStart);
        if (buffer.readUInt32LE(local) !== LOCAL) fail(`${name} 的本地头损坏`);
        const localFlags = buffer.readUInt16LE(local + 6), localMethod = buffer.readUInt16LE(local + 8);
        if (localFlags !== flags || localMethod !== method) fail(`${name} 的本地头与目录不一致`);
        const localNameLen = buffer.readUInt16LE(local + 26), localExtraLen = buffer.readUInt16LE(local + 28);
        bounds(local + 30, localNameLen + localExtraLen, centralStart);
        if (!nameBytes.equals(buffer.subarray(local + 30, local + 30 + localNameLen))) fail(`${name} 的本地文件名与目录不一致`);
        extras(local + 30 + localNameLen, localExtraLen);
        if (!(flags & 8) && (buffer.readUInt32LE(local + 14) !== crc || buffer.readUInt32LE(local + 18) !== size || buffer.readUInt32LE(local + 22) !== unpacked)) fail(`${name} 的本地大小或校验值与目录不一致`);
        const start = local + 30 + localNameLen + localExtraLen;
        bounds(start, size, centralStart);
        ranges.push([local, start + size]);
        records.push({ name, mode: mode & 0o7777, isDirectory, method, crc, size, unpacked, start });
    }
    if (p !== eocd) fail('目录长度与文件数量不一致');
    for (const key of names.keys()) {
        const parts = key.split('/');
        for (let i = 1; i < parts.length; i++) {
            if (names.get(parts.slice(0, i).join('/')) === false) fail('文件与目录路径冲突');
        }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('压缩数据区域重叠');
    return records.map(({ name, mode, isDirectory, method, crc, size, unpacked, start }) => {
        const body = buffer.subarray(start, start + size);
        let data;
        try { data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, unpacked) }) : Buffer.from(body); }
        catch { fail(`${name} 解压失败或超过声明大小`); }
        if (data.length !== unpacked || (zlib.crc32(data) >>> 0) !== crc) fail(`${name} 大小或校验失败`);
        return { name, data, mode, isDirectory };
    });
}
