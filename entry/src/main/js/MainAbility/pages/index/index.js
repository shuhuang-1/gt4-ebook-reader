import storage from '@system.storage';
import app from '@system.app';
import brightness from '@system.brightness';
import battery from '@system.battery';
import BOOKS from './books.js';

// ══════════ 可调参数 ══════════
var SEG_LEN    = 17;   // 阅读页每行几个字
var PAGE_SEG   = 40;   // 滑到底一次追加多少行
var PREV_LINES = 20;   // 进页面预带多少行上文
var MAX_LINES  = 160;  // 累积上限，防卡死
var TOC_PAGE   = 20;   // 目录每次加载几章
var NAME_FS    = 26;   // 书名字号（需与 CSS .bname 一致）
var NAME_W     = 348;  // 书名可用宽度
var RESUME_MS  = 400;  // 启动后多久自动跳上次阅读
var CHAP_TOTAL_MAX = 8;  // 章节名整行最多字符数（前缀"第N章 "也计入）
var LIGHT_TICK = 3000;  // 常亮维持间隔（毫秒）
var TOAST_MS   = 1000;  // 提示条显示多久

// ══════════ 图标字符 ══════════
var ICON_BACK  = '←';
var ICON_MORE  = '⋯';
var ICON_L_OFF = '☀';
var ICON_L_ON  = '✳';
var ICON_MARK  = '⚑';
// ══════════════════════════════

var MAX_NAME = Math.floor(NAME_W / NAME_FS) - 1;

var gIdx = {};
var gBook = 0;
var gChapters = [];
var gStart = [];
var gTotal = 0;
var gSeg = 0;
var gTocShown = 0;
var gScrollY = 0;
var gShelf = [];

var gLightOn = false;
var gLightTimer = null;
var gToastTimer = null;

function cut(s, max) {
  if (!s) { return ''; }
  if (s.length <= max) { return s; }
  return s.substring(0, max) + '…';
}

function pct(a, b) {
  if (!b) { return '0.00'; }
  var v = a * 100 / b;
  if (v > 100) { v = 100; }
  if (v < 0) { v = 0; }
  return v.toFixed(2);
}

function segCount(ch) {
  var t = (ch && ch.text) ? ch.text : '';
  var ps = t.split('\n');
  var n = 0;
  for (var i = 0; i < ps.length; i++) { n += Math.ceil(ps[i].length / SEG_LEN); }
  if (n === 0) { n = 1; }
  return n + 1;
}

function buildIndexFor(bi) {
  if (gIdx[bi]) { return gIdx[bi]; }
  var chs = BOOKS[bi].chapters;
  var start = [];
  var acc = 0;
  for (var i = 0; i < chs.length; i++) { start.push(acc); acc += segCount(chs[i]); }
  gIdx[bi] = { start: start, total: acc };
  return gIdx[bi];
}

function findChapterIn(idx, seg) {
  var s = idx.start;
  for (var i = s.length - 1; i >= 0; i--) { if (seg >= s[i]) { return i; } }
  return 0;
}

function buildIndex() {
  // 注意：gBook 现在是「书架下标」，不能直接当 BOOKS 下标用（导入书会越界）
  // 统一按当前 gChapters 重新算，内置书和导入书都适用
  if (gChapters && gChapters.length) {
    var start = [];
    var acc = 0;
    for (var i = 0; i < gChapters.length; i++) { start.push(acc); acc += segCount(gChapters[i]); }
    gStart = start;
    gTotal = acc;
    return;
  }
  var r = buildIndexFor(gBook);
  gStart = r.start;
  gTotal = r.total;
}

function findChapter(seg) {
  for (var i = gStart.length - 1; i >= 0; i--) { if (seg >= gStart[i]) { return i; } }
  return 0;
}

function pushLines(arr, text, isTitle) {
  if (text === undefined || text === null) { return; }
  if (text.length === 0) { arr.push({ text: '', isTitle: isTitle, isBody: !isTitle }); return; }
  var i = 0;
  while (i < text.length) {
    arr.push({ text: text.substring(i, i + SEG_LEN), isTitle: isTitle, isBody: !isTitle });
    i += SEG_LEN;
  }
}

function chapterLines(c) {
  var arr = [];
  var ch = gChapters[c];
  if (!ch) { return arr; }
  pushLines(arr, ch.title, true);
  var ps = (ch.text || '').split('\n');
  for (var i = 0; i < ps.length; i++) { pushLines(arr, ps[i], false); }
  if (arr.length === 0) { arr.push({ text: '（本章无内容）', isTitle: false, isBody: true }); }
  return arr;
}

function buildRange(startSeg, count) {
  var arr = [];
  if (!gChapters || gChapters.length === 0) { return arr; }
  if (gStart.length === 0) { buildIndex(); }
  if (typeof startSeg !== 'number' || isNaN(startSeg) || startSeg < 0) { startSeg = 0; }
  if (startSeg >= gTotal) { startSeg = 0; }
  var c = findChapter(startSeg);
  var off = startSeg - gStart[c];
  if (isNaN(off) || off < 0) { off = 0; }
  var need = count;
  var guard = 0;
  while (need > 0 && c < gChapters.length && guard < 500) {
    guard++;
    var lines = chapterLines(c);
    while (off < lines.length && need > 0) { arr.push(lines[off]); off++; need--; }
    off = 0;
    c++;
  }
  return arr;
}

function nowHM() {
  var d = new Date();
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}


// ══════════ 手机发送钩子 ══════════
// 接入 Wear Engine 后，把这里换成真实发送即可：
//   WE_SEND = function (s) { wearEngine.send(s); };
var WE_SEND = null;

function txSend(s) {
  try {
    if (typeof WE_SEND === 'function') { WE_SEND(s); return; }
  } catch (e) { }
  try { console.info('[GT4R] 待发送: ' + s); } catch (e2) { }
}

// ══════════ 统一书架（内置书 + 手机导入书）══════════
//   kind: 'b' 内置（读 books.js） / 's' 导入（读 storage）
function buildShelf() {
  gShelf = [];
  for (var i = 0; i < BOOKS.length; i++) {
    gShelf.push({
      kind: 'b', bi: i, id: null,
      name: BOOKS[i].name,
      n: BOOKS[i].chapters.length,
      sub: '0.00%  共 ' + BOOKS[i].chapters.length + ' 章'
    });
  }
}

function loadStoreBooks(cb) {
  buildShelf();                 // 先重置为「只有内置书」，避免重复追加
  rxList(function (arr) {
    for (var i = 0; i < arr.length; i++) {
      gShelf.push({
        kind: 's', bi: -1, id: arr[i].id,
        name: arr[i].name, n: arr[i].n,
        sub: '共 ' + arr[i].n + ' 章（待读）'
      });
    }
    if (cb) { cb(); }
  });
}

function shelfView() {
  var out = [];
  for (var i = 0; i < gShelf.length; i++) {
    out.push({ n: cut(gShelf[i].name, MAX_NAME), p: gShelf[i].sub });
  }
  return out;
}

function progKey(it) {
  return (it.kind === 's') ? ('bk_seg_i_' + it.id) : ('bk_seg_' + it.bi);
}
function chapKey(it) { return 'bk_ci_i_' + it.id; }
function keyOf(it)   { return (it.kind === 's') ? ('s' + it.id) : ('b' + it.bi); }

function idxOfKey(k) {
  for (var i = 0; i < gShelf.length; i++) { if (keyOf(gShelf[i]) === k) { return i; } }
  return -1;
}


// ══════════════════════════════════════════════════
//  以下为「手机 → 手表」接收模块（协议 v1），勿改
// ══════════════════════════════════════════════════

// ============================================================
//  手机 → 手表 接收模块（协议 v1）
//  依赖：@system.storage（index.js 顶部已 import，这里不再重复）
//  用法：
//    rxInit({ send: fn, onDone: fn, onErr: fn, onProgress: fn });
//    // Wear Engine 收到消息时：
//    rxOnMsg(text);
// ============================================================

// ===== 可调参数 =====
var RX_MAXKEY = 4000;   // 单个 storage key 的字节上限（保守值，别调大）
var RX_FLUSH  = 16;     // 攒够多少章落盘一次（太小=频繁写，太大=断线丢得多）

var RX_IDX = 'bk_idx';  // 书架索引

var rxSess = null;      // 当前接收会话
var rxCb   = {};        // 回调集合

function rxInit(opt) { rxCb = opt || {}; }

// ---------- 工具 ----------

// UTF-8 字节数：中文 3 字节，String.length 完全不能用
function rxByte(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function rxSend(s) { if (rxCb.send) rxCb.send(s); }
function rxAck(id, got) { return JSON.stringify({ v: 1, t: 'ack', id: id, got: got }); }
function rxErr(id, msg) { return JSON.stringify({ v: 1, t: 'err', id: id, msg: msg }); }

// ---------- storage 封装（统一吞掉异常，手表端不能因为一个 key 崩掉）----------

function rxGet(k, cb) {
  try {
    storage.get({
      key: k,
      success: function (d) { cb(d); },
      fail: function () { cb(null); },
      complete: function () { }
    });
  } catch (e) { cb(null); }
}

function rxSet(k, v, cb) {
  try {
    storage.set({
      key: k, value: v,
      success: function () { if (cb) cb(true); },
      fail: function () { if (cb) cb(false); },
      complete: function () { }
    });
  } catch (e) { if (cb) cb(false); }
}

function rxDel(k, cb) {
  try {
    storage.delete({
      key: k,
      success: function () { if (cb) cb(true); },
      fail: function () { if (cb) cb(false); },
      complete: function () { }
    });
  } catch (e) { if (cb) cb(false); }
}

// ---------- 切片打包 ----------
// 把 chapters[from, to) 打成若干串，每串字节数 <= RX_MAXKEY
function rxPack(arr, from, to) {
  var out = [], buf = [], cur = 2;
  for (var i = from; i < to; i++) {
    var one = JSON.stringify(arr[i]);
    var add = rxByte(one) + (buf.length ? 1 : 0);
    if (buf.length && cur + add > RX_MAXKEY - 2) {
      out.push('[' + buf.join(',') + ']');
      buf = []; cur = 2;
    }
    buf.push(one); cur += add;
  }
  if (buf.length) out.push('[' + buf.join(',') + ']');
  return out;
}

// 落盘：chapters[0..kept-1] 进切片，最后一章（可能是续片半成品）单独存 _t
function rxFlush(cb) {
  var s = rxSess;
  if (!s || s.chapters.length === 0) { if (cb) cb(); return; }

  var endIdx = s.chapters.length - 1;   // 尾巴单独存，因为它可能还没收全
  var packs  = rxPack(s.chapters, s.kept, endIdx);
  var tail   = JSON.stringify(s.chapters[endIdx]);
  var base   = s.slice;
  var k = 0;

  function writeSlice() {
    if (k < packs.length) {
      rxSet('bk_' + s.id + '_s' + (base + k), packs[k], function () { k++; writeSlice(); });
      return;
    }
    s.slice = base + packs.length;
    s.kept  = endIdx;
    rxSet('bk_' + s.id + '_t', tail, function () { rxProg(cb); });
  }
  writeSlice();
}

// 进度：g=下一个期望的片号，k=已落盘章数，sl=已写切片数
function rxProg(cb) {
  var s = rxSess;
  if (!s) { if (cb) cb(); return; }
  rxSet('bk_' + s.id + '_p',
    JSON.stringify({ g: s.next, k: s.kept, sl: s.slice, n: s.n, name: s.name }), cb);
}

// ---------- 断点续传：从已落盘的数据恢复会话 ----------
function rxLoad(id, p, cb) {
  var chapters = [], i = 0;
  function next() {
    if (i < p.sl) {
      rxGet('bk_' + id + '_s' + i, function (d) {
        try { var a = JSON.parse(d); for (var j = 0; j < a.length; j++) chapters.push(a[j]); } catch (e) { }
        i++; next();
      });
      return;
    }
    rxGet('bk_' + id + '_t', function (d) {
      try { var t = JSON.parse(d); if (t) chapters.push(t); } catch (e) { }
      cb(chapters);
    });
  }
  next();
}

function rxQuery(id) {
  rxGet('bk_' + id + '_p', function (d) {
    var p = null;
    try { if (d) p = JSON.parse(d); } catch (e) { p = null; }
    if (!p) { rxSend(rxAck(id, -1)); return; }   // 没有记录 → 手机从头发
    rxLoad(id, p, function (chapters) {
      rxSess = { id: id, name: p.name, n: p.n, chapters: chapters,
        next: p.g, kept: p.k, slice: p.sl, total: 0 };
      rxSend(rxAck(id, p.g));                   // 从 p.g 续推
    });
  });
}

// ---------- 收完：写元信息 + 进书架 ----------
function rxFinish(n) {
  var s = rxSess;
  if (!s) return;
  rxFlush(function () {
    var meta = { id: s.id, name: s.name, n: s.chapters.length, sl: s.slice };
    if (n && s.chapters.length !== n) {
      rxSend(rxErr(s.id, '章节数不符 ' + s.chapters.length + '/' + n));
    }
    rxSet('bk_' + s.id, JSON.stringify(meta), function () {
      rxDel('bk_' + s.id + '_p', function () {
        rxAddIdx(meta, function () {
          var cnt = s.chapters.length;
          rxSess = null;
          if (rxCb.onDone) rxCb.onDone(s.name, cnt);
        });
      });
    });
  });
}

function rxAddIdx(meta, cb) {
  rxGet(RX_IDX, function (d) {
    var arr = [];
    try { if (d) arr = JSON.parse(d) || []; } catch (e) { arr = []; }
    var hit = false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === meta.id) { arr[i] = { id: meta.id, name: meta.name, n: meta.n }; hit = true; break; }
    }
    if (!hit) arr.push({ id: meta.id, name: meta.name, n: meta.n });
    rxSet(RX_IDX, JSON.stringify(arr), cb);
  });
}

// ============================================================
//  主入口：Wear Engine 收到一条消息就调它
// ============================================================
function rxOnMsg(text) {
  var m = null;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || m.v !== 1) return;

  var t = m.t;

  if (t === 'query') { rxQuery(m.id); return; }

  if (t === 'begin') {
    // 同一本书续传时保留已有会话（rxQuery 已把它装进来了）
    if (!rxSess || rxSess.id !== m.id) {
      rxSess = { id: m.id, name: m.name, n: m.n, chapters: [],
        next: 0, kept: 0, slice: 0, total: 0 };
    }
    rxSess.name = m.name;
    rxSess.n = m.n;
    rxProg(null);
    return;
  }

  if (t === 'chunk') {
    var s = rxSess;
    if (!s || s.id !== m.id) { rxSend(rxAck(m.id, -1)); return; }  // 没会话 → 请重开
    if (m.i > s.next)  { rxSend(rxAck(m.id, s.next)); return; }    // 丢片 → 请求补发
    if (m.i < s.next)  { return; }                                  // 重复片 → 丢弃

    var arr = m.chapters || [];
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      if (c.cont && s.chapters.length) {
        s.chapters[s.chapters.length - 1].text += c.text;   // 续片：拼接
      } else {
        s.chapters.push({ title: c.title, text: c.text });
      }
    }
    s.next = m.i + 1;
    s.total = m.total || s.total;
    if (s.chapters.length - s.kept >= RX_FLUSH) rxFlush(null);
    if (rxCb.onProgress) rxCb.onProgress(s.next, s.total);
    return;
  }

  if (t === 'end') {
    var e = rxSess;
    if (!e || e.id !== m.id) { rxSend(rxAck(m.id, -1)); return; }
    if (e.total && e.next < e.total) { rxSend(rxAck(m.id, e.next)); return; }  // 还没收全
    rxFinish(m.n);
    return;
  }
}

// ---------- 书架 ----------

function rxList(cb) {
  rxGet(RX_IDX, function (d) {
    var arr = [];
    try { if (d) arr = JSON.parse(d) || []; } catch (e) { arr = []; }
    cb(arr);
  });
}

function rxOpen(id, cb) {
  rxGet('bk_' + id, function (d) {
    var m = null;
    try { if (d) m = JSON.parse(d); } catch (e) { m = null; }
    if (!m) { cb(null); return; }
    var chapters = [], i = 0;
    function next() {
      if (i < m.sl) {
        rxGet('bk_' + id + '_s' + i, function (x) {
          try { var a = JSON.parse(x); for (var j = 0; j < a.length; j++) chapters.push(a[j]); } catch (e) { }
          i++; next();
        });
        return;
      }
      rxGet('bk_' + id + '_t', function (x) {
        try { var t = JSON.parse(x); if (t) chapters.push(t); } catch (e) { }
        cb({ name: m.name, chapters: chapters });
      });
    }
    next();
  });
}

// 删书
function rxRemove(id, cb) {
  rxGet('bk_' + id, function (d) {
    var m = null;
    try { if (d) m = JSON.parse(d); } catch (e) { m = null; }
    var sl = m ? m.sl : 0;
    var i = 0;
    function del() {
      if (i <= sl) {
        rxDel('bk_' + id + (i < sl ? '_s' + i : '_t'), function () { i++; del(); });
        return;
      }
      rxDel('bk_' + id, function () {
        rxDel('bk_' + id + '_p', function () {
          rxGet(RX_IDX, function (x) {
            var arr = [];
            try { if (x) arr = JSON.parse(x) || []; } catch (e) { arr = []; }
            var out = [];
            for (var j = 0; j < arr.length; j++) if (arr[j].id !== id) out.push(arr[j]);
            rxSet(RX_IDX, JSON.stringify(out), cb);
          });
        });
      });
    }
    del();
  });
}

export default {
  data: {
    showList: true, showToc: false, showRead: false, showMenu: false, showImport: false,
    impMsg: '等待手机推送书籍…\n点「检测通道」看当前系统能否写入',
    title: '电子书', tocTitle: '目录',
    shelf: [], chapters: [], blocks: [],
    clock: '--:--', batt: '--', chapNo: 1, chapName: '', chapTotal: 0, chapText: '',
    iconBack: ICON_BACK, iconMore: ICON_MORE,
    iconLight: ICON_L_OFF, iconMark: ICON_MARK,
    toastText: ''
  },

  onInit: function () {
    var that = this;
    buildShelf();                 // 先放内置书
    this.shelf = shelfView();

    // 注册接收回调
    rxInit({
      send: txSend,
      onProgress: function (got, total) {
        if (that.showImport) {
          that.impMsg = '接收中… ' + got + '/' + (total || '?') + ' 片';
        }
      },
      onDone: function (name, cnt) {
        loadStoreBooks(function () {
          that.shelf = shelfView();
          that.loadProgress();
          that.impMsg = '《' + name + '》接收完成\n共 ' + cnt + ' 章，已进书架';
          that.showToast('《' + name + '》已入库');
        });
      }
    });

    // 载入已导入的书，再刷新进度
    loadStoreBooks(function () {
      that.shelf = shelfView();
      that.loadProgress();
    });
  },

  loadProgress: function () {
    var that = this;
    for (var i = 0; i < gShelf.length; i++) {
      (function (it) {
        try {
          storage.get({
            key: progKey(it),
            success: function (d) {
              var v = parseInt(d, 10);
              if (isNaN(v) || v < 0) { return; }
              if (it.kind === 'b') {
                var idx = buildIndexFor(it.bi);
                if (v >= idx.total) { return; }
                var c = findChapterIn(idx, v);
                it.sub = pct(v, idx.total) + '%  看到 ' + (c + 1) + '/' + it.n + ' 章';
                that.shelf = shelfView();
              } else {
                storage.get({
                  key: chapKey(it),
                  success: function (d2) {
                    var ci = parseInt(d2, 10);
                    it.sub = isNaN(ci)
                      ? ('读到第 ' + (v + 1) + ' 段')
                      : ('看到 ' + (ci + 1) + '/' + it.n + ' 章');
                    that.shelf = shelfView();
                  },
                  fail: function () { }, complete: function () { }
                });
              }
            },
            fail: function () { }, complete: function () { }
          });
        } catch (e) { }
      })(gShelf[i]);
    }
  },

  saveLast: function (idx) {
    var it = gShelf[idx];
    if (!it) { return; }
    try {
      storage.set({
        key: 'bk_last', value: keyOf(it),
        success: function () { }, fail: function () { }, complete: function () { }
      });
    } catch (e) { }
  },

  autoResume: function () {
    var that = this;
    try {
      storage.get({
        key: 'bk_last',
        success: function (d) {
          if (!d) { return; }
          var si = idxOfKey(d);
          if (si < 0) { return; }
          setTimeout(function () { if (that.showList) { that.openBook(si); } }, RESUME_MS);
        },
        fail: function () { }, complete: function () { }
      });
    } catch (e) { }
  },

  openBook: function (idx) {
    var that = this;
    var it = gShelf[idx];
    if (!it) { return; }
    gBook = idx;

    function resumeAt() {
      var done = false;
      function go(v) {
        if (done) { return; }
        done = true;
        gSeg = v;
        that.enterRead(false);
      }
      try {
        storage.get({
          key: progKey(it),
          success: function (d) {
            var v = parseInt(d, 10);
            if (isNaN(v) || v < 0 || v >= gTotal) { v = 0; }
            go(v);
          },
          fail: function () { go(0); }, complete: function () { }
        });
      } catch (e) { go(0); }
      setTimeout(function () { go(0); }, 300);
    }

    // 手机导入的书：章节要先从 storage 读出来
    if (it.kind === 's') {
      rxOpen(it.id, function (bk) {
        if (!bk || !bk.chapters || bk.chapters.length === 0) {
          that.showToast('这本书读不出来，请重新导入');
          return;
        }
        gChapters = bk.chapters;
        that.tocTitle = bk.name;
        buildIndex();
        that.saveLast(idx);
        resumeAt();
      });
      return;
    }

    // 内置书
    gChapters = BOOKS[it.bi].chapters;
    this.tocTitle = BOOKS[it.bi].name;
    buildIndex();
    this.saveLast(idx);
    resumeAt();
  },

  enterRead: function (append) {
    if (append) {
      var more = buildRange(gSeg + PAGE_SEG, PAGE_SEG);
      if (more.length === 0) { return; }
      this.blocks = this.blocks.concat(more);
      gSeg += PAGE_SEG;
      if (this.blocks.length > MAX_LINES) {
        this.blocks = this.blocks.slice(this.blocks.length - MAX_LINES);
      }
    } else {
      var from = gSeg - PREV_LINES;
      if (from < 0) { from = 0; }
      var pre = gSeg - from;
      this.blocks = buildRange(from, pre + PAGE_SEG);
      gScrollY = 0;
      var that = this;
      setTimeout(function () { that.scrollToIndex(pre); }, 60);
    }
    this.showList = false;
    this.showToc = false;
    this.showRead = true;
    this.showMenu = false;
    this.saveProgress();
  },

  scrollToIndex: function (n) {
    try {
      var el = this.$element('readlist');
      if (el && el.scrollTo) { el.scrollTo({ index: n, smooth: false }); }
    } catch (e) { }
  },

  onScroll: function (e) {
    if (!e) { return; }
    var y = -1;
    if (typeof e.scrollY === 'number') { y = e.scrollY; }
    else if (typeof e.scrollOffset === 'number') { y = e.scrollOffset; }
    if (y >= 0) { gScrollY = y; }
  },

  onReach: function () {
    if (gSeg + PAGE_SEG >= gTotal) { return; }
    this.enterRead(true);
  },

  saveProgress: function () {
    var it = gShelf[gBook];
    if (!it) { return; }
    try {
      storage.set({
        key: progKey(it), value: '' + gSeg,
        success: function () { }, fail: function () { }, complete: function () { }
      });
      // 导入书额外记章节号（书架上显示用，免得加载全书才能算百分比）
      if (it.kind === 's') {
        var ci = findChapter(gSeg);
        storage.set({
          key: chapKey(it), value: '' + ci,
          success: function () { }, fail: function () { }, complete: function () { }
        });
      }
    } catch (e) { }
  },

  // ─────────── 二级菜单 ───────────

  // 单击屏幕：弹出菜单，刷新时间/电量/章节
  openMenu: function () {
    if (this.showMenu) { return; }
    var c = findChapter(gSeg);
    var name = (gChapters[c] && gChapters[c].title) ? gChapters[c].title : '';
    this.chapNo = c + 1;
    this.chapTotal = gChapters.length;

    // 关键：把"第N章 "前缀也算进总长度，保证整行不换行
    var head = '第' + (c + 1) + '章 ';
    var room = CHAP_TOTAL_MAX - head.length;   // 留给章节名的字数
    if (!name || room < 2) {
      this.chapText = head;                                        // 放不下就只显示"第N章"
    } else if (name.length > room) {
      this.chapText = head + name.substring(0, room - 1) + '…';    // 留 1 位给省略号
    } else {
      this.chapText = head + name;
    }

    this.clock = nowHM();
    var that = this;
    try {
      battery.getStatus({
        success: function (d) {
          var lv = d.level;
          if (typeof lv === 'number') {
            // 有的机型返回 0~1 小数（0.73），有的返回 0~100，统一换算成百分数
            if (lv > 0 && lv <= 1) { lv = lv * 100; }
            that.batt = '' + Math.round(lv);
          } else { that.batt = '--'; }
        },
        fail: function () { that.batt = '--'; }, complete: function () { }
      });
    } catch (e) { this.batt = '--'; }
    this.showMenu = true;
  },

  closeMenu: function () { this.showMenu = false; },

  goBack: function () {
    this.showMenu = false;
    this.showRead = false;
    this.showToc = false;
    this.showList = true;
  },

  showToast: function (t) {
    var that = this;
    this.toastText = t;
    if (gToastTimer) { clearTimeout(gToastTimer); gToastTimer = null; }
    gToastTimer = setTimeout(function () { that.toastText = ''; gToastTimer = null; }, TOAST_MS);
  },

  toggleLight: function () {
    if (gLightOn) {
      gLightOn = false;
      if (gLightTimer) { clearInterval(gLightTimer); gLightTimer = null; }
      try { brightness.setKeepScreenOn({ keepScreenOn: false, success: function () { }, fail: function () { }, complete: function () { } }); } catch (e) { }
      this.iconLight = ICON_L_OFF;
      this.showToast('已关闭屏幕常亮');
    } else {
      gLightOn = true;
      try { brightness.setKeepScreenOn({ keepScreenOn: true, success: function () { }, fail: function () { }, complete: function () { } }); } catch (e) { }
      var that = this;
      gLightTimer = setInterval(function () {
        try { brightness.setKeepScreenOn({ keepScreenOn: true, success: function () { }, fail: function () { }, complete: function () { } }); } catch (e) { }
      }, LIGHT_TICK);
      this.iconLight = ICON_L_ON;
      this.showToast('已开启屏幕常亮');
    }
  },

  // ─────────── 导入（接收 + 通道自检） ───────────

  openImport: function () {
    var that = this;
    this.showImport = true;
    this.showList = false;
    this.impMsg = '等待手机推送书籍…\n点「检测通道」检查存储是否可写';
    loadStoreBooks(function () { that.shelf = shelfView(); });
  },

  backFromImport: function () {
    this.showImport = false;
    this.showList = true;
  },

  // ★ Wear Engine 收到手机消息时，调这个（一行接进去就行）
  //   真实接入示例：
  //     onMessage: function (data) { this.onWearMessage(data); }
  onWearMessage: function (text) {
    rxOnMsg(text);
  },

  // 删除一本导入的书（内置书删不掉）。
  // hml 里给书架项加长按即可调用：onlongpress="removeBook($idx)"
  removeBook: function (idx) {
    var that = this;
    var it = gShelf[idx];
    if (!it) { return; }
    if (it.kind !== 's') { this.showToast('内置书不能删'); return; }
    rxRemove(it.id, function () {
      loadStoreBooks(function () {
        that.shelf = shelfView();
        that.showToast('已删除《' + it.name + '》');
      });
    });
  },

  // 检测：现在改成测 storage 能否写入（协议 v1 落盘就靠它）
  probeImport: function () {
    var that = this;
    this.impMsg = '检测中…';
    try {
      storage.set({
        key: '_probe', value: 'ok',
        success: function () {
          storage.get({
            key: '_probe',
            success: function (d) {
              that.impMsg = (d === 'ok')
                ? '存储通道可用 ✓\n可从手机接收书籍'
                : '回读失败：' + d;
            },
            fail: function (d, c) { that.impMsg = '回读失败（错误 ' + c + '）'; },
            complete: function () { }
          });
        },
        fail: function (d, c) { that.impMsg = '写入失败（错误 ' + c + '）'; },
        complete: function () { }
      });
    } catch (e) {
      this.impMsg = '无 storage 接口（异常）';
    }
  },

  openToc: function () {
    var n = gChapters.length;
    gTocShown = (n > TOC_PAGE) ? TOC_PAGE : n;
    var t = [];
    for (var i = 0; i < gTocShown; i++) { t.push({ t: gChapters[i].title }); }
    this.chapters = t;
    this.showToc = true;
  },

  tocMore: function () {
    if (gTocShown >= gChapters.length) { return; }
    var b = gTocShown + TOC_PAGE;
    if (b > gChapters.length) { b = gChapters.length; }
    var add = [];
    for (var i = gTocShown; i < b; i++) { add.push({ t: gChapters[i].title }); }
    this.chapters = this.chapters.concat(add);
    gTocShown = b;
  },

  openChapter: function (i) {
    if (i >= gStart.length) { return; }
    gSeg = gStart[i];
    this.enterRead(false);
  },

  onSwipe: function (e) {
    if (!e || e.direction !== 'right') { return; }
    if (this.showMenu) { this.showMenu = false; return; }
    if (this.showImport) { this.showImport = false; this.showList = true; return; }
    if (this.showRead) { this.showRead = false; this.openToc(); }
    else if (this.showToc) { this.showToc = false; this.showList = true; }
    else { try { app.terminate(); } catch (err) { } }
  }
};