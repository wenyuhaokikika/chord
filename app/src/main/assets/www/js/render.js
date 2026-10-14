/*!
 * render.js —— 渲染层：和弦图（小节图）与全指板图，输出内联 SVG 字符串。
 * 颜色一律交给 CSS 类（内联 SVG 可以吃到文档样式），方便深/浅色主题切换。
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function num(n) {
    return Math.round(n * 100) / 100;
  }

  /* ======================================================================
   * 和弦图：竖排 6 弦 × 5 品的小图（和弦谱里最常见的形式）
   * ==================================================================== */
  function chordBox(v, opts) {
    opts = opts || {};
    var labelMode = opts.labelMode || 'finger';       /* finger | note | none */
    var preferFlat = !!opts.preferFlat;
    var rootPc = (opts.rootPc === undefined) ? null : opts.rootPc;

    var gap = 20, fretGap = 24, left = 24, top = 34, rows = 5;
    var width = left * 2 + gap * 5;                   /* 148 */
    var height = top + fretGap * rows + 20;            /* 174 */

    function xs(s) { return left + s * gap; }
    function yc(ff) { return top + (ff - start + 0.5) * fretGap; }

    /* 计算显示起始品：能放下就从头显示 */
    var minF = 0, maxF = 0, i, s;
    for (i = 0; i < 6; i++) {
      var fr = v.frets[i];
      if (fr > 0) {
        if (minF === 0 || fr < minF) minF = fr;
        if (fr > maxF) maxF = fr;
      }
    }
    if (minF === 0) minF = 1;
    var start = 1;
    if (maxF > rows) {
      start = minF;
      if (maxF > start + rows - 1) start = maxF - rows + 1;
    }

    var out = [];
    out.push('<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" role="img">');

    /* 品丝：第一行在起始品为 1 时画成琴枕（较粗） */
    for (i = 0; i <= rows; i++) {
      var y = top + i * fretGap;
      var cls = (i === 0 && start === 1) ? 'cb-nut' : 'cb-fret';
      out.push('<line class="' + cls + '" x1="' + xs(0) + '" y1="' + num(y) + '" x2="' + xs(5) + '" y2="' + num(y) + '"/>');
    }
    /* 弦 */
    for (s = 0; s < 6; s++) {
      out.push('<line class="cb-string" x1="' + xs(s) + '" y1="' + top + '" x2="' + xs(s) + '" y2="' + (top + fretGap * rows) + '"/>');
    }
    /* 起始品数字标注 */
    if (start > 1) {
      out.push('<text class="cb-frlabel" x="' + (left - 8) + '" y="' + num(top + fretGap * 0.62) + '" text-anchor="end">' + start + 'fr</text>');
    }

    /* 空弦 ○ / 闷弦 × */
    for (s = 0; s < 6; s++) {
      var f = v.frets[s];
      if (f < 0) {
        out.push('<text class="cb-mute" x="' + xs(s) + '" y="' + (top - 8) + '" text-anchor="middle">\u00d7</text>');
      } else if (f === 0) {
        out.push('<circle class="cb-open" cx="' + xs(s) + '" cy="' + (top - 10) + '" r="4.4"/>');
      }
    }

    /* 横按 */
    if (v.barre) {
      var bx1 = xs(v.barre.from), bx2 = xs(v.barre.to), by = yc(v.barre.fret);
      out.push('<rect class="cb-barre" x="' + num(bx1) + '" y="' + num(by - 9) + '" width="' + num(bx2 - bx1) + '" height="18" rx="9"/>');
    }

    /* 按弦点 */
    for (s = 0; s < 6; s++) {
      var f2 = v.frets[s];
      if (f2 <= 0) continue;
      var cx = xs(s), cy = yc(f2);
      var label = '';
      if (labelMode === 'finger') {
        label = (v.fingers[s] > 0) ? String(v.fingers[s]) : '';
      } else if (labelMode === 'note') {
        label = global.Music.noteName(global.Chord.pcAt(s, f2), preferFlat);
      }
      out.push('<circle class="cb-dot" cx="' + cx + '" cy="' + num(cy) + '" r="9"/>');
      if (label) {
        var fs = label.length > 1 ? 8.5 : 10.5;
        out.push('<text class="cb-dot-text" x="' + cx + '" y="' + num(cy + 3.4) + '" text-anchor="middle" font-size="' + fs + '">' + esc(label) + '</text>');
      }
    }

    /* 弦名（便于对照） */
    var names = ['E', 'A', 'D', 'G', 'B', 'e'];
    for (s = 0; s < 6; s++) {
      out.push('<text class="cb-stringname" x="' + xs(s) + '" y="' + (top + fretGap * rows + 14) + '" text-anchor="middle">' + names[s] + '</text>');
    }

    out.push('</svg>');
    return out.join('');
  }

  /* ======================================================================
   * 全指板图：横放整条琴颈 0..maxFret 品，弦在水平方向，品在垂直方向
   * ==================================================================== */
  var SINGLE_MARKERS = [3, 5, 7, 9, 15, 17, 19, 21];

  /* 指板几何参数（app.js 计算滚动位置时也要用，统一从这里取） */
  var NECK_METRICS = { fretW: 42, rowH: 30, smallRowH: 24, leftPad: 46, topPad: 26, botPad: 20 };

  function neck(opts) {
    opts = opts || {};
    var maxFret = opts.maxFret || 24;
    var fretW = NECK_METRICS.fretW;
    /* 小屏（矮屏）收紧弦距，保证指板在条件面板打开时也能完整露出 */
    var rowH = opts.rowH || (global.innerHeight && global.innerHeight < 700
      ? NECK_METRICS.smallRowH : NECK_METRICS.rowH);
    var leftPad = NECK_METRICS.leftPad, topPad = NECK_METRICS.topPad, botPad = NECK_METRICS.botPad;
    var height = topPad + 6 * rowH + botPad;
    var width = leftPad + maxFret * fretW + fretW * 0.55 + 10;

    var v = opts.frets || null;                 /* 当前高亮的指法（数组，-1 表示闷弦） */
    var preferFlat = !!opts.preferFlat;
    var rootPc = opts.rootPc;
    var quality = opts.quality;
    var showAll = !!opts.showAllTones;

    function yy(s) { return topPad + (5 - s) * rowH; }     /* s=0 是最粗的 6 弦，画在最下方 */
    function xx(f) { return leftPad + f * fretW; }          /* 品丝横坐标 */
    function cx(f) { return leftPad + (f - 0.5) * fretW; }  /* 品格中心（按弦点） */
    var xOpen = leftPad - 17;                               /* 空弦 / 闷弦标记位置 */

    var out = [];
    out.push('<svg width="' + num(width) + '" height="' + height + '" viewBox="0 0 ' + num(width) + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" role="img">');

    /* 琴颈底色 */
    out.push('<rect class="nk-wood" x="' + leftPad + '" y="' + (topPad - 8) + '" width="' + num(width - leftPad - 8) + '" height="' + (6 * rowH + 16) + '" rx="5"/>');

    /* 高亮位置窗口 */
    if (v) {
      var press = [];
      for (var q = 0; q < 6; q++) if (v[q] > 0) press.push(v[q]);
      if (press.length) {
        var lo = Math.min.apply(null, press), hi = Math.max.apply(null, press);
        out.push('<rect class="nk-window" x="' + num(xx(lo - 1)) + '" y="' + (topPad - 8) + '" width="' + num((hi - lo + 1) * fretW) + '" height="' + (6 * rowH + 16) + '" rx="8"/>');
      }
    }

    /* 品记：画在 G 弦(索引3) 与 D 弦(索引2) 之间，也就是琴颈正中，和真实指板一致 */
    var MARK_Y = topPad + 2.5 * rowH;
    var i;
    for (i = 0; i < SINGLE_MARKERS.length; i++) {
      var mf = SINGLE_MARKERS[i];
      if (mf > maxFret) break;
      out.push('<circle class="nk-marker" cx="' + num(cx(mf)) + '" cy="' + num(MARK_Y) + '" r="3.6"/>');
    }
    if (maxFret >= 12) {
      out.push('<circle class="nk-marker" cx="' + num(cx(12)) + '" cy="' + num(MARK_Y - 10) + '" r="3.6"/>');
      out.push('<circle class="nk-marker" cx="' + num(cx(12)) + '" cy="' + num(MARK_Y + 10) + '" r="3.6"/>');
    }
    if (maxFret >= 24) {
      out.push('<circle class="nk-marker" cx="' + num(cx(24)) + '" cy="' + num(MARK_Y - 10) + '" r="3.6"/>');
      out.push('<circle class="nk-marker" cx="' + num(cx(24)) + '" cy="' + num(MARK_Y + 10) + '" r="3.6"/>');
    }

    /* 全部和弦音（淡色底图，可选） */
    if (showAll && quality) {
      var allowed = {};
      var k;
      for (k = 0; k < quality.intervals.length; k++) {
        allowed[global.Music.mod12(rootPc + quality.intervals[k])] = true;
      }
      var rootMod = global.Music.mod12(rootPc);
      for (var s2 = 0; s2 < 6; s2++) {
        for (var f2 = 0; f2 <= maxFret; f2++) {
          var pc = global.Chord.pcAt(s2, f2);
          if (!allowed[pc]) continue;
          var isRoot = (pc === rootMod);
          var cls2 = isRoot ? 'nk-faint-root' : 'nk-faint';
          out.push('<circle class="' + cls2 + '" cx="' + num(f2 === 0 ? xOpen : cx(f2)) + '" cy="' + num(yy(s2)) + '" r="' + (isRoot ? 5.4 : 4.6) + '"/>');
        }
      }
    }

    /* 品丝 */
    for (i = 1; i <= maxFret; i++) {
      out.push('<line class="nk-fret" x1="' + num(xx(i)) + '" y1="' + (topPad - 4) + '" x2="' + num(xx(i)) + '" y2="' + (topPad + 6 * rowH + 4) + '"/>');
    }
    out.push('<line class="nk-nut" x1="' + leftPad + '" y1="' + (topPad - 6) + '" x2="' + leftPad + '" y2="' + (topPad + 6 * rowH + 6) + '"/>');

    /* 弦（低音弦更粗） */
    for (i = 0; i < 6; i++) {
      var w = 2.9 - i * 0.34;
      out.push('<line class="nk-string" stroke-width="' + num(w) + '" x1="' + (leftPad - 4) + '" y1="' + num(yy(i)) + '" x2="' + num(width - 6) + '" y2="' + num(yy(i)) + '"/>');
    }

    /* 品号 */
    for (i = 1; i <= maxFret; i++) {
      out.push('<text class="nk-fretnum" x="' + num(cx(i)) + '" y="' + (topPad - 13) + '" text-anchor="middle">' + i + '</text>');
    }

    /* 弦名 */
    var names = ['E', 'A', 'D', 'G', 'B', 'e'];
    for (i = 0; i < 6; i++) {
      out.push('<text class="nk-stringname" x="8" y="' + num(yy(i) + 3.5) + '">' + names[i] + '</text>');
    }

    /* 当前指法高亮 */
    if (v) {
      var barre = opts.barre || null;
      for (i = 0; i < 6; i++) {
        var fr = v[i];
        if (fr < 0) {
          out.push('<text class="nk-mute" x="' + xOpen + '" y="' + num(yy(i) + 4.5) + '" text-anchor="middle">\u00d7</text>');
        } else if (fr === 0) {
          out.push('<circle class="nk-open" cx="' + xOpen + '" cy="' + num(yy(i)) + '" r="7.5"/>');
          out.push('<text class="nk-open-text" x="' + xOpen + '" y="' + num(yy(i) + 3.5) + '" text-anchor="middle">' + esc(global.Music.noteName(global.Chord.pcAt(i, 0), preferFlat)) + '</text>');
        } else {
          out.push('<circle class="nk-dot" cx="' + num(cx(fr)) + '" cy="' + num(yy(i)) + '" r="10"/>');
          var nm = global.Music.noteName(global.Chord.pcAt(i, fr), preferFlat);
          out.push('<text class="nk-dot-text" x="' + num(cx(fr)) + '" y="' + num(yy(i) + 3.6) + '" text-anchor="middle" font-size="' + (nm.length > 1 ? 8.6 : 10) + '">' + esc(nm) + '</text>');
        }
      }
      /* 横按条 */
      if (barre && v[barre.from] === barre.fret) {
        var p = [];
        for (i = 0; i < 6; i++) if (v[i] === barre.fret) p.push(i);
        if (p.length >= 2) {
          var a = p[0], b = p[p.length - 1];
          out.push('<rect class="nk-barre" x="' + num(cx(barre.fret) - 10) + '" y="' + num(yy(b) - 10) + '" width="20" height="' + num(yy(a) - yy(b) + 20) + '" rx="10"/>');
          for (i = a; i <= b; i++) {
            if (v[i] !== barre.fret) continue;
            var nm2 = global.Music.noteName(global.Chord.pcAt(i, barre.fret), preferFlat);
            out.push('<text class="nk-dot-text" x="' + num(cx(barre.fret)) + '" y="' + num(yy(i) + 3.6) + '" text-anchor="middle" font-size="' + (nm2.length > 1 ? 8.6 : 10) + '">' + esc(nm2) + '</text>');
          }
        }
      }
    }

    out.push('</svg>');
    return out.join('');
  }

  global.Render = {
    chordBox: chordBox,
    neck: neck,
    neckMetrics: NECK_METRICS,
    esc: esc
  };
})(window);
