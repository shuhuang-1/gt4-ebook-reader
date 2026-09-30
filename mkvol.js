// mkvol.js —— GT4 电子书分卷打包工具（支持选书）
//
// 流程：mkvol.bat 先列出 gt4out 里的书 → 你输编号 → 生成对应卷文件
// 只写 bookN_volM.js 和 books.js，绝不碰 index.js / index.css / index.hml
// 每次运行会自动清空 rawfile（残留文件会把包撑爆，导致安装错误 34）

var fs = require('fs');
var path = require('path');

// ============ 可调参数 ============
var VOL_CHARS = 10000;     // 每卷多少字（8000 ≈ 21KB 源码，编译后远低于 48KB 红线）
var TOTAL_LIMIT = 35000;  // 每本书最多取多少字，改成 0 = 整本全上
// ==================================

var PAGE = path.join(__dirname, 'entry', 'src', 'main', 'js',
  'MainAbility', 'pages', 'index');
var RAW = path.join(__dirname, 'entry', 'src', 'main', 'resources', 'rawfile');

// 书源目录：优先 gt4out，没有则用 novels
var SRC = path.join(__dirname, 'gt4out');
if (!fs.existsSync(SRC)) { SRC = path.join(__dirname, 'novels'); }

var RE = new RegExp(
  '^[\\s\\u3000]*(' +
    '\\u7b2c[\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e57\\u5341\\u767e\\u5343\\u96f60-9]{1,12}' +
    '[\\u7ae0\\u8282\\u56de\\u5377\\u7bc7\\u96c6]' +
    '|\\u5e8f[\\u7ae0\\u8a00]|\\u756a\\u5916|\\u540e\\u8bb0' +
    ')(?![\\u4e00-\\u9fffa-zA-Z0-9])[\\s\\u3000:\\uFF1A.\\u3001\\-]*'
);

// 换行符保留成 \n 转义（不能删，否则段落全连成一坨）
function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\r/g, '').replace(/\n/g, '\\n');
}
function kb(n) { return Math.round(n / 1024 * 10) / 10; }

function splitChapters(text) {
  var lines = text.split(/\r?\n/);
  var out = [];
  var cur = null;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var m = RE.exec(ln);
    if (m) {
      if (cur) { out.push(cur); }
      var t = ln.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
      cur = { title: t, text: '' };
    } else if (cur) {
      cur.text = cur.text + ln + '\n';
    }
  }
  if (cur) { out.push(cur); }
  if (out.length === 0) { out.push({ title: '第一章', text: text }); }
  return out;
}

if (!fs.existsSync(PAGE)) {
  console.log('ERROR 找不到页面目录：' + PAGE);
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.log('ERROR 找不到 gt4out 目录（也没有 novels）');
  process.exit(1);
}

var all = fs.readdirSync(SRC).filter(function (f) {
  return /\.txt$/i.test(f);
}).sort();

var args = process.argv.slice(2);

// ---- 列表模式：只打印可选书目 ----
if (args.length > 0 && args[0] === '--list') {
  if (all.length === 0) {
    console.log('（目录里没有 txt）');
  } else {
    console.log('扫描目录：' + SRC);
    for (var i = 0; i < all.length; i++) {
      console.log('  [' + (i + 1) + '] ' + all[i].replace(/\.txt$/i, ''));
    }
  }
  process.exit(0);
}

if (all.length === 0) {
  console.log('ERROR 目录里没有 txt：' + SRC);
  process.exit(1);
}

// ---- 解析编号：支持多选，按输入顺序排 ----
var picked = [];
for (var a = 0; a < args.length; a++) {
  if (/^\d+$/.test(args[a])) {
    var n = parseInt(args[a], 10);
    if (n >= 1 && n <= all.length && picked.indexOf(n - 1) < 0) {
      picked.push(n - 1);
    }
  }
}
var files = picked.length > 0 ? picked.map(function (i) { return all[i]; }) : all;
console.log('[选中] ' + files.length + ' 本');

// ---- 0. 清理残留：rawfile + 上一轮卷文件 ----
var nRaw = 0;
if (fs.existsSync(RAW)) {
  var rf = fs.readdirSync(RAW);
  for (var r = 0; r < rf.length; r++) {
    fs.unlinkSync(path.join(RAW, rf[r]));
    nRaw++;
  }
} else {
  fs.mkdirSync(RAW, { recursive: true });
}
if (nRaw > 0) {
  console.log('[clean] 清空 rawfile 残留 ' + nRaw + ' 个文件');
}

var olds = fs.readdirSync(PAGE).filter(function (f) {
  return /^vol\d+\.js$/i.test(f) || /^book\d+_vol\d+\.js$/i.test(f);
});
olds.forEach(function (f) { fs.unlinkSync(path.join(PAGE, f)); });
if (olds.length > 0) {
  console.log('[clean] 删除上一轮残留 ' + olds.length + ' 个卷文件');
}

var bookMeta = [];
var maxKB = 0;

for (var bi = 0; bi < files.length; bi++) {
  var raw = fs.readFileSync(path.join(SRC, files[bi]));
  var txt = raw.toString('utf8');
  if (txt.charCodeAt(0) === 0xFEFF) { txt = txt.substring(1); }

  var name = files[bi].replace(/\.txt$/i, '');
  var chs = splitChapters(txt);

  var total = 0, keep = [];
  for (var i = 0; i < chs.length; i++) {
    if (TOTAL_LIMIT > 0 && total >= TOTAL_LIMIT) { break; }
    keep.push(chs[i]);
    total += chs[i].title.length + chs[i].text.length;
  }

  var vols = [], curVol = [], curLen = 0;
  for (var j = 0; j < keep.length; j++) {
    var cl = keep[j].title.length + keep[j].text.length;
    if (curLen > 0 && curLen + cl > VOL_CHARS) {
      vols.push(curVol); curVol = []; curLen = 0;
    }
    curVol.push(keep[j]);
    curLen += cl;
  }
  if (curVol.length > 0) { vols.push(curVol); }

  console.log('');
  console.log('[book ' + (bi + 1) + '] ' + name);
  console.log('  章=' + keep.length + ' 字=' + total + ' 卷=' + vols.length);

  for (var v = 0; v < vols.length; v++) {
    var s = 'export default [\n';
    for (var k = 0; k < vols[v].length; k++) {
      s += '  { title: "' + esc(vols[v][k].title) +
        '", text: "' + esc(vols[v][k].text) + '" }';
      if (k < vols[v].length - 1) { s += ','; }
      s += '\n';
    }
    s += '];\n';
    var fn = 'book' + (bi + 1) + '_vol' + (v + 1) + '.js';
    var fp = path.join(PAGE, fn);
    fs.writeFileSync(fp, s, 'utf8');
    var sz = kb(fs.statSync(fp).size);
    if (sz > maxKB) { maxKB = sz; }
    console.log('    ' + fn + '  ' + sz + ' KB' + (sz > 48 ? '  <<< 超限!' : ''));
  }

  bookMeta.push({ name: name, vols: vols.length });
}

// ---- 生成 books.js 清单 ----
var m = '';
for (var b = 0; b < bookMeta.length; b++) {
  for (var q = 1; q <= bookMeta[b].vols; q++) {
    m += "import b" + (b + 1) + "v" + q +
      " from './book" + (b + 1) + "_vol" + q + ".js';\n";
  }
}
m += '\n';
for (var b2 = 0; b2 < bookMeta.length; b2++) {
  var expr = 'b' + (b2 + 1) + 'v1';
  for (var q2 = 2; q2 <= bookMeta[b2].vols; q2++) {
    expr += '.concat(b' + (b2 + 1) + 'v' + q2 + ')';
  }
  m += 'var c' + (b2 + 1) + ' = ' + expr + ';\n';
}
m += '\nexport default [\n';
for (var b3 = 0; b3 < bookMeta.length; b3++) {
  m += '  { name: "' + esc(bookMeta[b3].name) + '", chapters: c' + (b3 + 1) + ' }';
  if (b3 < bookMeta.length - 1) { m += ','; }
  m += '\n';
}
m += '];\n';

fs.writeFileSync(path.join(PAGE, 'books.js'), m, 'utf8');

console.log('');
console.log('OK 书=' + bookMeta.length + ' 最大单文件=' + maxKB + ' KB（红线 48）');
console.log('index.js / index.css 未被改动');
console.log('下一步：DevEco -> Build -> Clean Project -> Build Hap(s)');
// ---- 3. 体检：检查页面目录下所有源文件是否接近 48KB 红线 ----
var warn = [];
var pgFiles = fs.readdirSync(PAGE).filter(function (f) {
  return /\.js$/i.test(f);
});
for (var pf = 0; pf < pgFiles.length; pf++) {
  var fsz = kb(fs.statSync(path.join(PAGE, pgFiles[pf])).size);
  if (fsz > 30) {
    warn.push('    ' + pgFiles[pf] + '  ' + fsz + ' KB' + (fsz > 48 ? '  <<< 已超限!' : '  (接近红线)'));
  }
}
if (warn.length > 0) {
  console.log('');
  console.log('[warn] 以下文件接近或超过 48KB 红线（编译后还会变大）：');
  for (var w = 0; w < warn.length; w++) { console.log(warn[w]); }
  console.log('  建议：把 index.js 里的功能拆成独立模块再 import');
}