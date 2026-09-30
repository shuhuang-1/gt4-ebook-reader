// checkhap.js v2 —— 逐层剥开 HAP（外层 zip 里还有 entry-default-signed.bin）
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var HAP = path.join(__dirname, 'entry', 'build', 'default',
    'outputs', 'default', 'entry-default-signed.hap');

function kb(n) { return Math.round(n / 1024 * 10) / 10; }
function mb(n) { return Math.round(n / 1048576 * 100) / 100; }
function pad(s) { s = String(s); while (s.length < 9) { s = ' ' + s; } return s; }
function n64(lo, hi) { return lo + hi * 4294967296; }
function num64(buf, off) { return n64(buf.readUInt32LE(off), buf.readUInt32LE(off + 4)); }

function findEOCD(buf) {
    var min = Math.max(0, buf.length - 66000);
    for (var i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
}

function parseZip(buf) {
    var eocd = findEOCD(buf);
    if (eocd < 0) return null;
    var cdSize = buf.readUInt32LE(eocd + 12);
    var cdOff = buf.readUInt32LE(eocd + 16);
    var loc = -1;
    for (var j = eocd - 20; j >= Math.max(0, eocd - 100); j--) {
        if (buf.readUInt32LE(j) === 0x07064b50) { loc = j; break; }
    }
    if (loc >= 0) {
        var z = Number(num64(buf, loc + 8));
        if (z > 0 && z + 56 <= buf.length && buf.readUInt32LE(z) === 0x06064b50) {
            cdSize = Number(num64(buf, z + 40));
            cdOff = Number(num64(buf, z + 48));
        }
    }
    var entries = [];
    var p = cdOff;
    var end = cdOff + cdSize;
    while (p + 46 <= end && p + 46 <= buf.length) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break;
        var method = buf.readUInt16LE(p + 10);
        var csize = buf.readUInt32LE(p + 20);
        var usize = buf.readUInt32LE(p + 24);
        var nlen = buf.readUInt16LE(p + 28);
        var elen = buf.readUInt16LE(p + 30);
        var clen = buf.readUInt16LE(p + 32);
        var lho = buf.readUInt32LE(p + 42);
        var q = p + 46 + nlen, e = q + elen;
        while (q + 4 <= e) {
            var hid = buf.readUInt16LE(q), hsz = buf.readUInt16LE(q + 2);
            if (hid === 0x0001) {
                var o = q + 4;
                if (usize === 0xFFFFFFFF && o + 8 <= e) { usize = Number(num64(buf, o)); o += 8; }
                if (csize === 0xFFFFFFFF && o + 8 <= e) { csize = Number(num64(buf, o)); o += 8; }
                if (lho === 0xFFFFFFFF && o + 8 <= e) { lho = Number(num64(buf, o)); }
                break;
            }
            q += 4 + hsz;
        }
        entries.push({
            name: buf.toString('utf8', p + 46, p + 46 + nlen),
            usize: usize, csize: csize, lho: lho, method: method
        });
        p += 46 + nlen + elen + clen;
    }
    return entries;
}

function readEntry(buf, e) {
    var p = e.lho;
    if (p + 30 > buf.length) return null;
    if (buf.readUInt32LE(p) !== 0x04034b50) return null;
    var nlen = buf.readUInt16LE(p + 26), elen = buf.readUInt16LE(p + 28);
    var start = p + 30 + nlen + elen;
    var raw = buf.slice(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) {
        try { return zlib.inflateRawSync(raw); } catch (err) { return null; }
    }
    return null;
}

if (!fs.existsSync(HAP)) {
    console.log('找不到 hap，先在 DevEco 里 Build Hap(s)');
    process.exit(1);
}

var buf = fs.readFileSync(HAP);
console.log('HAP 文件: ' + kb(buf.length) + ' KB');
console.log('');

// ---- 逐层剥开 ----
var cur = buf;
var level = 0;
var last = null;
while (level < 4) {
    var ents = parseZip(cur);
    if (!ents || ents.length === 0) break;
    last = ents;
    console.log('[第 ' + level + ' 层] 条目 ' + ents.length + ' 个');
    var next = null, nextName = '';
    for (var i = 0; i < ents.length; i++) {
        var d = readEntry(cur, ents[i]);
        if (d && d.length > 4 && d[0] === 0x50 && d[1] === 0x4B) {
            if (!next || d.length > next.length) { next = d; nextName = ents[i].name; }
        }
    }
    if (!next) break;
    console.log('   含嵌套包: ' + nextName + '  ' + kb(next.length) + ' KB  → 继续深入');
    cur = next;
    level++;
}

if (!last) { console.log('读不到任何内容'); process.exit(1); }

console.log('');
var total = 0;
for (var t = 0; t < last.length; t++) { total += last[t].usize; }

console.log('=== 最内层：最大的 20 个条目 ===');
last.slice().sort(function (a, b) { return b.usize - a.usize; }).slice(0, 20)
    .forEach(function (e) { console.log(pad(kb(e.usize)) + ' KB  ' + e.name); });

console.log('');
console.log('=== JS 文件（红线 48KB）===');
var js = last.filter(function (e) { return /\.js$/i.test(e.name); });
if (js.length === 0) { console.log('(最内层没有 js 文件!)'); }
js.sort(function (a, b) { return b.usize - a.usize; }).forEach(function (e) {
    console.log(pad(kb(e.usize)) + ' KB  ' + e.name + (e.usize > 48 * 1024 ? '   <<< 超限!' : ''));
});

console.log('');
console.log('=== icon 相关 ===');
var ic = last.filter(function (e) { return /icon/i.test(e.name); });
if (ic.length === 0) { console.log('(没有 icon! 这就是错误 40 的原因)'); }
ic.forEach(function (e) { console.log(pad(kb(e.usize)) + ' KB  ' + e.name); });

console.log('');
console.log('=== 汇总（最内层）===');
console.log('条目数: ' + last.length);
console.log('解压后合计: ' + mb(total) + ' MB  (手表安装时实际承受的量)');

var big = js.filter(function (e) { return e.usize > 48 * 1024; });
console.log('');
if (big.length > 0) { console.log('>>> ' + big.length + ' 个 js 超 48KB = 错误 34 的原因'); }
else { console.log('>>> js 体积正常，错误 34 不是体积引起'); }
if (ic.length === 0) { console.log('>>> 缺 icon = 错误 40 的原因'); }
else { console.log('>>> icon 存在，错误 40 另有原因'); }