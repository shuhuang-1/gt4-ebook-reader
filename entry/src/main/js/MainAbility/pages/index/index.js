import storage from '@system.storage';
import app from '@system.app';
import brightness from '@system.brightness';
import battery from '@system.battery';
import BOOKS from './books.js';
import file from '@system.file';

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
    var s = [];
    for (var i = 0; i < BOOKS.length; i++) {
      s.push({ n: cut(BOOKS[i].name, MAX_NAME), p: '0.00%  共 ' + BOOKS[i].chapters.length + ' 章' });
    }
    this.shelf = s;
    this.loadProgress();
  },

  loadProgress: function () {
    var that = this;
    for (var k = 0; k < BOOKS.length; k++) {
      (function (bi) {
        var idx = buildIndexFor(bi);
        try {
          storage.get({
            key: 'bk_seg_' + bi,
            success: function (d) {
              var v = parseInt(d, 10);
              if (isNaN(v) || v < 0 || v >= idx.total) { return; }
              var c = findChapterIn(idx, v);
              var arr = [];
              for (var j = 0; j < that.shelf.length; j++) {
                if (j === bi) {
                  arr.push({
                    n: cut(BOOKS[bi].name, MAX_NAME),
                    p: pct(v, idx.total) + '%  看到 ' + (c + 1) + '/' + BOOKS[bi].chapters.length + ' 章'
                  });
                } else { arr.push(that.shelf[j]); }
              }
              that.shelf = arr;
            },
            fail: function () { }, complete: function () { }
          });
        } catch (e) { }
      })(k);
    }
  },

  saveLast: function (bi) {
    try {
      storage.set({ key: 'bk_last', value: '' + bi, success: function () { }, fail: function () { }, complete: function () { } });
    } catch (e) { }
  },

  autoResume: function () {
    var that = this;
    try {
      storage.get({
        key: 'bk_last',
        success: function (d) {
          var bi = parseInt(d, 10);
          if (isNaN(bi) || bi < 0 || bi >= BOOKS.length) { return; }
          setTimeout(function () { if (that.showList) { that.openBook(bi); } }, RESUME_MS);
        },
        fail: function () { }, complete: function () { }
      });
    } catch (e) { }
  },

  openBook: function (idx) {
    var that = this;
    gBook = idx;
    gChapters = BOOKS[idx].chapters;
    this.tocTitle = BOOKS[idx].name;
    buildIndex();
    this.saveLast(idx);
    var done = false;
    function go(v) {
      if (done) { return; }
      done = true;
      gSeg = v;
      that.enterRead(false);
    }
    try {
      storage.get({
        key: 'bk_seg_' + idx,
        success: function (d) {
          var v = parseInt(d, 10);
          if (isNaN(v) || v < 0 || v >= gTotal) { v = 0; }
          go(v);
        },
        fail: function () { go(0); }, complete: function () { }
      });
    } catch (e) { go(0); }
    setTimeout(function () { go(0); }, 300);
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
    try {
      storage.set({ key: 'bk_seg_' + gBook, value: '' + gSeg, success: function () { }, fail: function () { }, complete: function () { } });
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

  // ─────────── 导入（占位 + 通道自检） ───────────
  openImport: function () {
    this.showImport = true;
    this.showList = false;
    this.impMsg = '等待手机推送书籍…\n点「检测通道」看当前系统能否写入';
  },

  backFromImport: function () {
    this.showImport = false;
    this.showList = true;
  },

  // ★ 未来接真实导入时，只改这个函数
  // ★ 数据契约（安卓端照此生成即可无缝接入）：
  //   { name: "书名", chapters: [ { title: "第1章", text: "正文\n换行" } ] }
  probeImport: function () {
    var that = this;
    this.impMsg = '检测中…';
    try {
      file.writeText({
        uri: 'internal://files/_probe.txt',
        text: 'ok',
        success: function () {
          that.impMsg = '通道可用：可写入内部存储\n→ 可接入手机导入';
        },
        fail: function (d, c) {
          that.impMsg = '通道不可用（错误 ' + c + '）\n→ 需改用安卓方案';
        },
        complete: function () { }
      });
    } catch (e) {
      this.impMsg = '无文件接口（异常）\n→ 需改用安卓方案';
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