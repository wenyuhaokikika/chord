/*!
 * chord.js —— 和弦定义 + 指板按把位穷举（核心算法）
 *
 * 思路：
 *   1. 和弦 = 根音 + 一组音程（半音数），并声明“必须出现”的特征音；
 *   2. 标准调弦下，枚举每根弦上所有合法的品位（含空弦、含闷弦）；
 *   3. 以“最低按弦品”为归一化把位，深度优先枚举全部指法组合；
 *   4. 过滤：音数下限、特征音齐全、跨度（自动由候选品范围保证）、低音、
 *      发声弦必须连续（默认）；再按“实际发声音高”去重；
 *   5. 按把位分组，输出可直接渲染的和弦图数据。
 */
(function (global) {
  'use strict';

  /* 标准调弦 E A D G B E（MIDI 音高：E2=40 ... E4=64） */
  var TUNING = [40, 45, 50, 55, 59, 64];
  var STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];
  var OPEN_PCS = [4, 9, 2, 7, 11, 4]; /* 空弦音名（= TUNING % 12） */

  /* ---------- 和弦属性表 ----------
   * intervals : 组成音（相对根音的半音数）
   * required  : 必须出现的特征音（缺了就不算这个和弦）
   * triad     : 用于罗马数字大小写 / 记号
   * seventh   : 是否属于七和弦族（用于级数标注 7）
   */
  var QUALITY_LIST = [
    /* 基本三和弦 */
    { id: 'maj', zh: '大三和弦', symbol: '', family: '基本三和弦', intervals: [0, 4, 7], required: [0, 4], triad: 'maj' },
    { id: 'min', zh: '小三和弦', symbol: 'm', family: '基本三和弦', intervals: [0, 3, 7], required: [0, 3], triad: 'min' },
    { id: 'dim', zh: '减三和弦', symbol: 'dim', family: '基本三和弦', intervals: [0, 3, 6], required: [0, 3, 6], triad: 'dim' },
    { id: 'aug', zh: '增三和弦', symbol: 'aug', family: '基本三和弦', intervals: [0, 4, 8], required: [0, 4, 8], triad: 'aug' },
    { id: '5', zh: '强力和弦', symbol: '5', family: '基本三和弦', intervals: [0, 7], required: [0, 7], triad: 'maj' },
    /* 挂留 */
    { id: 'sus2', zh: '挂二和弦', symbol: 'sus2', family: '挂留和弦', intervals: [0, 2, 7], required: [0, 2], triad: 'maj' },
    { id: 'sus4', zh: '挂四和弦', symbol: 'sus4', family: '挂留和弦', intervals: [0, 5, 7], required: [0, 5], triad: 'maj' },
    { id: '7sus4', zh: '属七挂四', symbol: '7sus4', family: '挂留和弦', intervals: [0, 5, 7, 10], required: [0, 5, 10], triad: 'maj', seventh: true },
    /* 六和弦 / 加音 */
    { id: '6', zh: '大六和弦', symbol: '6', family: '六和弦 · 加音', intervals: [0, 4, 7, 9], required: [0, 4, 9], triad: 'maj' },
    { id: 'm6', zh: '小六和弦', symbol: 'm6', family: '六和弦 · 加音', intervals: [0, 3, 7, 9], required: [0, 3, 9], triad: 'min' },
    { id: '69', zh: '六九和弦', symbol: '6/9', family: '六和弦 · 加音', intervals: [0, 4, 7, 9, 14], required: [0, 4, 9, 14], triad: 'maj', seventh: true },
    { id: 'add9', zh: '加九和弦', symbol: 'add9', family: '六和弦 · 加音', intervals: [0, 4, 7, 14], required: [0, 4, 14], triad: 'maj' },
    { id: 'madd9', zh: '小加九和弦', symbol: 'm(add9)', family: '六和弦 · 加音', intervals: [0, 3, 7, 14], required: [0, 3, 14], triad: 'min' },
    /* 七和弦 */
    { id: '7', zh: '属七和弦', symbol: '7', family: '七和弦', intervals: [0, 4, 7, 10], required: [0, 4, 10], triad: 'maj', seventh: true },
    { id: 'maj7', zh: '大七和弦', symbol: 'maj7', family: '七和弦', intervals: [0, 4, 7, 11], required: [0, 4, 11], triad: 'maj', seventh: true },
    { id: 'm7', zh: '小七和弦', symbol: 'm7', family: '七和弦', intervals: [0, 3, 7, 10], required: [0, 3, 10], triad: 'min', seventh: true },
    { id: 'mmaj7', zh: '小大七和弦', symbol: 'mMaj7', family: '七和弦', intervals: [0, 3, 7, 11], required: [0, 3, 11], triad: 'min', seventh: true },
    { id: 'm7b5', zh: '半减七和弦', symbol: 'm7\u266d5', family: '七和弦', intervals: [0, 3, 6, 10], required: [0, 3, 6, 10], triad: 'halfdim', seventh: true },
    { id: 'dim7', zh: '减七和弦', symbol: 'dim7', family: '七和弦', intervals: [0, 3, 6, 9], required: [0, 3, 6, 9], triad: 'dim', seventh: true },
    { id: 'aug7', zh: '增七和弦', symbol: '7\u266f5', family: '七和弦', intervals: [0, 4, 8, 10], required: [0, 4, 10], triad: 'aug', seventh: true },
    /* 延伸和弦 */
    { id: '9', zh: '属九和弦', symbol: '9', family: '延伸和弦', intervals: [0, 4, 7, 10, 14], required: [0, 4, 10, 14], triad: 'maj', seventh: true },
    { id: 'maj9', zh: '大九和弦', symbol: 'maj9', family: '延伸和弦', intervals: [0, 4, 7, 11, 14], required: [0, 4, 11, 14], triad: 'maj', seventh: true },
    { id: 'm9', zh: '小九和弦', symbol: 'm9', family: '延伸和弦', intervals: [0, 3, 7, 10, 14], required: [0, 3, 10, 14], triad: 'min', seventh: true },
    { id: '11', zh: '属十一和弦', symbol: '11', family: '延伸和弦', intervals: [0, 4, 7, 10, 14, 17], required: [0, 10, 17], triad: 'maj', seventh: true },
    { id: 'm11', zh: '小十一和弦', symbol: 'm11', family: '延伸和弦', intervals: [0, 3, 7, 10, 14, 17], required: [0, 3, 10, 17], triad: 'min', seventh: true },
    { id: '13', zh: '属十三和弦', symbol: '13', family: '延伸和弦', intervals: [0, 4, 7, 10, 14, 17, 21], required: [0, 4, 10, 21], triad: 'maj', seventh: true },
    { id: 'm13', zh: '小十三和弦', symbol: 'm13', family: '延伸和弦', intervals: [0, 3, 7, 10, 14, 17, 21], required: [0, 3, 10, 21], triad: 'min', seventh: true },
    /* 变化和弦 */
    { id: '7b9', zh: '属七降九', symbol: '7\u266d9', family: '变化和弦', intervals: [0, 4, 7, 10, 13], required: [0, 4, 10, 13], triad: 'maj', seventh: true },
    { id: '7s9', zh: '属七升九', symbol: '7\u266f9', family: '变化和弦', intervals: [0, 4, 7, 10, 15], required: [0, 4, 10, 15], triad: 'maj', seventh: true },
    { id: '7s11', zh: '属七升十一', symbol: '7\u266f11', family: '变化和弦', intervals: [0, 4, 7, 10, 18], required: [0, 4, 10, 18], triad: 'maj', seventh: true }
  ];

  function qualityById(id) {
    for (var i = 0; i < QUALITY_LIST.length; i++) {
      if (QUALITY_LIST[i].id === id) return QUALITY_LIST[i];
    }
    return QUALITY_LIST[0];
  }

  /* 32 位掩码中 1 的个数（音名集合计数） */
  function popcount(mask) {
    var c = 0;
    while (mask) {
      c += mask & 1;
      mask >>= 1;
    }
    return c;
  }

  /* ---------- 指板基础 ---------- */
  function pcAt(stringIndex, fret) {
    return global.Music.mod12(TUNING[stringIndex] + fret);
  }

  function midiAt(stringIndex, fret) {
    return TUNING[stringIndex] + fret;
  }

  /* ---------- 核心：穷举所有把位的指法 ---------- */
  /**
   * @param {number} rootPc   根音 pitch class 0..11
   * @param {object} quality  QUALITY_LIST 中的一项
   * @param {object} options  { maxFret, span, minSounding, bassIsRoot, allowInnerMute, maxResults }
   * @returns {Array} 指法数组，已按把位、发声弦数排序
   */
  function searchVoicings(rootPc, quality, options) {
    var opts = options || {};
    var maxFret = (opts.maxFret === undefined) ? 24 : opts.maxFret;
    var span = (opts.span === undefined) ? 4 : opts.span;
    var bassIsRoot = (opts.bassIsRoot === undefined) ? true : !!opts.bassIsRoot;
    var allowInnerMute = !!opts.allowInnerMute;
    var maxResults = opts.maxResults || 800;
    /* 最少发声弦数：用户可以要求 2..6 根弦同时发声。
     * 三和弦只有 3 个和弦音，但吉他完全可以靠重复音（同音异弦/八度）弹满 6 弦，
     * 所以这里不做“按和弦音数钳制”的处理。 */
    var minSounding = (opts.minSounding === undefined) ? 4 : opts.minSounding;
    if (minSounding < 2) minSounding = 2;
    if (minSounding > 6) minSounding = 6;

    var allowed = {};
    var i, k;
    for (i = 0; i < quality.intervals.length; i++) {
      allowed[global.Music.mod12(rootPc + quality.intervals[i])] = true;
    }
    var requiredMask = 0;
    for (i = 0; i < quality.required.length; i++) {
      requiredMask |= (1 << global.Music.mod12(rootPc + quality.required[i]));
    }
    var requiredCount = popcount(requiredMask);

    var out = [];
    var seenFingering = {};
    var seenSound = {};
    var frets = [-1, -1, -1, -1, -1, -1];

    /* 按把位枚举：base = 最低“按弦”品位，保证每个指法只被枚举一次 */
    for (var base = 0; base <= maxFret; base++) {
      /* 各弦候选品位：-1 闷弦；0 空弦；base..base+span 按弦 */
      var cands = [];
      for (var s = 0; s < 6; s++) {
        var list = [-1];
        if (base === 0) {
          if (allowed[pcAt(s, 0)]) list.push(0);
        } else {
          if (allowed[pcAt(s, 0)]) list.push(0);
          var hi = Math.min(maxFret, base + span);
          for (var f = base; f <= hi; f++) {
            if (allowed[pcAt(s, f)]) list.push(f);
          }
        }
        cands.push(list);
      }

      (function (base, cands) {
        /* phase: 0 = 还在发声块之前（前导闷弦）
         *        1 = 正在发声块中
         *        2 = 发声块已结束（后续只能闷弦，除非允许“中间隔弦”）
         * innerMute: 发声块被打断后重新发声的次数
         */
        var maxInner = allowInnerMute ? 1 : 0;

        function dfs(si, sounding, mask, minPressed, phase, innerMute) {
          if (out.length >= maxResults) return;
          /* 剩余弦数不足以凑够最少发声弦数 */
          if (sounding + (6 - si) < minSounding) return;
          /* 剩余弦数不足以补齐必需音 */
          if (requiredCount - popcount(mask & requiredMask) > (6 - si)) return;
          if (si === 6) {
            var fretted = 0;
            for (var q = 0; q < 6; q++) if (frets[q] > 0) fretted++;
            /* 归一化：base 必须等于最低按弦品（无按弦则 base=0） */
            if ((fretted === 0 && base !== 0) || (fretted > 0 && minPressed !== base)) return;
            if ((mask & requiredMask) !== requiredMask) return;
            record();
            return;
          }
          var list = cands[si];
          for (var idx = 0; idx < list.length; idx++) {
            var f = list[idx];
            if (f < 0) {
              /* 闷弦：正在发声的块被截断 */
              frets[si] = -1;
              dfs(si + 1, sounding, mask, minPressed, phase === 1 ? 2 : phase, innerMute);
            } else {
              if (f > 0 && f < base) continue;
              var nPhase = phase, nInner = innerMute;
              if (phase === 2) {
                nInner = innerMute + 1;
                if (nInner > maxInner) continue;
                nPhase = 1;
              } else {
                nPhase = 1;
              }
              var mp = minPressed;
              if (f > 0 && (mp === 0 || f < mp)) mp = f;
              frets[si] = f;
              dfs(si + 1, sounding + 1, mask | (1 << pcAt(si, f)), mp, nPhase, nInner);
            }
          }
          frets[si] = -1;
        }

        function record() {
          var key = frets.join(',');
          if (seenFingering[key]) return;
          seenFingering[key] = true;

          var notes = [];
          var midiNotes = [];
          var sounding = 0;
          var openCount = 0;
          var bassPc = -1;
          for (var s = 0; s < 6; s++) {
            if (frets[s] >= 0) {
              if (sounding === 0) bassPc = pcAt(s, frets[s]);
              notes.push({ string: s, fret: frets[s], pc: pcAt(s, frets[s]), midi: midiAt(s, frets[s]) });
              midiNotes.push(midiAt(s, frets[s]));
              sounding++;
              if (frets[s] === 0) openCount++;
            }
          }
          /* 低音音高去重：同样的实际音高只保留一种按法 */
          var soundKey = midiNotes.join('-');
          if (seenSound[soundKey]) return;
          if (bassIsRoot && bassPc !== global.Music.mod12(rootPc)) return;
          seenSound[soundKey] = true;

          var fingering = frets.slice(0);
          out.push({
            frets: fingering,
            sounding: sounding,
            openCount: openCount,
            bassPc: bassPc,
            midiNotes: midiNotes,
            notes: notes,
            position: minPressedOf(fingering),
            hasOpen: openCount > 0
          });
        }

        dfs(0, 0, 0, 0, false, 0);
      })(base, cands);
    }

    /* 指法细节：横按、手指编号、跨度 */
    for (i = 0; i < out.length; i++) {
      analyseFingering(out[i], quality, rootPc);
    }

    /* 排序：把位升序 -> 发声弦数降序 -> 跨度升序 -> 品位和升序 */
    out.sort(function (a, b) {
      if (a.position !== b.position) return a.position - b.position;
      if (a.sounding !== b.sounding) return b.sounding - a.sounding;
      if (a.spanUsed !== b.spanUsed) return a.spanUsed - b.spanUsed;
      return a.fretSum - b.fretSum;
    });
    return out;
  }

  function minPressedOf(frets) {
    var min = 0;
    for (var i = 0; i < frets.length; i++) {
      if (frets[i] > 0 && (min === 0 || frets[i] < min)) min = frets[i];
    }
    return min;
  }

  /* 横按识别 + 手指编号：吉他手的常规按法（1=食指 ... 4=小指） */
  function analyseFingering(v, quality, rootPc) {
    var frets = v.frets;
    var min = 0, max = 0, sum = 0, i;
    for (i = 0; i < 6; i++) {
      if (frets[i] > 0) {
        if (min === 0 || frets[i] < min) min = frets[i];
        if (frets[i] > max) max = frets[i];
        sum += frets[i];
      }
    }
    v.spanUsed = (min === 0) ? 0 : (max - min);
    v.fretSum = sum;

    /* 横按：最低按弦品上有 >=2 根弦，且横跨范围内每根弦都不低于该品。
     * 注意必须排除“中间夹空弦”的情况（如 x10231）：一根手指横按过去时，
     * 被它压住的空弦不可能还响，所以那种按法不是横按。 */
    var same = [];
    for (i = 0; i < 6; i++) if (frets[i] === min && min > 0) same.push(i);
    var barre = null;
    if (same.length >= 2) {
      var from = same[0], to = same[same.length - 1], ok = true;
      for (i = from; i <= to; i++) {
        if (frets[i] < min) ok = false;      /* < min 即闷弦(-1)或空弦(0) */
      }
      if (ok) barre = { fret: min, from: from, to: to };
    }
    v.barre = barre;

    /* 手指编号：横按品 -> 1，其余按品从小到大 -> 2,3,4 */
    var fingers = [-1, -1, -1, -1, -1, -1];
    var distinct = [];
    for (i = 0; i < 6; i++) {
      if (frets[i] > 0 && distinct.indexOf(frets[i]) < 0) distinct.push(frets[i]);
    }
    distinct.sort(function (a, b) { return a - b; });
    var map = {};
    var next = 1;
    if (barre) {
      map[barre.fret] = 1;
      next = 2;
    }
    for (i = 0; i < distinct.length; i++) {
      var f = distinct[i];
      if (map[f] !== undefined) continue;
      if (next > 4) { map[f] = 0; continue; }
      map[f] = next++;
    }
    for (i = 0; i < 6; i++) {
      if (frets[i] > 0 && map[frets[i]]) fingers[i] = map[frets[i]];
    }
    v.fingers = fingers;

    /* 和弦音名称（相对根音的音程名） */
    var intervals = [];
    for (i = 0; i < v.notes.length; i++) {
      intervals.push(intervalDegreeName(global.Music.mod12(v.notes[i].pc - rootPc)));
    }
    v.degreeNames = intervals;
    v.degreeMask = degreeMaskOf(v.notes, rootPc, quality);
  }

  function degreeMaskOf(notes, rootPc, quality) {
    var mask = 0, i;
    for (i = 0; i < notes.length; i++) mask |= (1 << global.Music.mod12(notes[i].pc - rootPc));
    return mask;
  }

  var INTERVAL_NAMES = {
    0: '1', 1: '\u266d9', 2: '9', 3: '\u266d3', 4: '3', 5: '11', 6: '\u266d5',
    7: '5', 8: '\u266f5', 9: '13', 10: '\u266d7', 11: '7'
  };

  function intervalDegreeName(semitones) {
    return INTERVAL_NAMES[global.Music.mod12(semitones)] || String(semitones);
  }

  /* 把指法列表按把位分组 */
  function groupByPosition(voicings) {
    var groups = [];
    var index = {};
    for (var i = 0; i < voicings.length; i++) {
      var v = voicings[i];
      var key = String(v.position);
      if (!index[key]) {
        index[key] = { position: v.position, hasOpen: false, items: [] };
        groups.push(index[key]);
      }
      index[key].items.push(v);
      if (v.hasOpen) index[key].hasOpen = true;
    }
    return groups;
  }

  function positionLabel(group) {
    if (group.position === 0) return '开放把位';
    return '第 ' + group.position + ' 把位' + (group.hasOpen ? ' · 含空弦' : '');
  }

  /* 指法的文本记法，如 x 3 2 0 1 0 */
  function tabString(v) {
    var parts = [];
    for (var i = 0; i < 6; i++) {
      parts.push(v.frets[i] < 0 ? 'x' : String(v.frets[i]));
    }
    return parts.join(' ');
  }


  /* ======================================================================
   * CAGED：把现有合法指法归到 C / A / G / E / D 五个根音区域
   *
   * CAGED 不是五套互斥指法，而是五个可记忆的形状锚点：
   *   C/A 型根音在 5 弦，G/E 型根音在 6 弦，D 型根音在 4 弦。
   * 这里不硬编码 30 种属性的指法，而是从当前搜索出的合法指法里，
   * 为每个区域挑一个代表，既保持可弹性，也避免用户面对上百张卡片。
   * ==================================================================== */
  function rootFretOnString(rootPc, stringIndex, maxFret) {
    var pc = global.Music.mod12(rootPc);
    for (var f = 0; f <= maxFret; f++) {
      if (pcAt(stringIndex, f) === pc) return f;
    }
    return 0;
  }

  function bassStringOf(v) {
    if (!v || !v.notes || !v.notes.length) return -1;
    return v.notes[0].string;   /* notes 按 6→1 弦加入，第一条就是最低发声音 */
  }

  function cagedVoicings(voicings, rootPc, opts) {
    opts = opts || {};
    var maxFret = opts.maxFret === undefined ? 24 : opts.maxFret;
    /* 弦编号与 TUNING 一致：0=低音 E，1=A，2=D，3=G，4=B，5=高音 e */
    var r5 = rootFretOnString(rootPc, 1, maxFret);
    var r4 = rootFretOnString(rootPc, 2, maxFret);
    var r6 = rootFretOnString(rootPc, 0, maxFret);
    /* G 型要往根音低 3 品伸展；根音在 0–2 品时用高八度位置。 */
    var gRoot = (r6 < 3 && r6 + 12 <= maxFret) ? r6 + 12 : r6;
    var used = {};
    var list = voicings || [];

    function pick(predicate, score) {
      var best = null, bestScore = -1e9;
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (used[v.frets.join(',')]) continue;
        if (!predicate(v)) continue;
        var sc = score(v);
        if (sc > bestScore) { bestScore = sc; best = v; }
      }
      if (best) used[best.frets.join(',')] = true;
      return best;
    }

    function openScore(v, openAllowed) {
      return openAllowed ? (v.hasOpen ? 20 : 0) : (v.hasOpen ? -100 : 0);
    }
    var C = pick(function (v) {
      return bassStringOf(v) === 1 && (v.hasOpen || v.position < r5);
    }, function (v) {
      /* 开放的 C 型最好记；其它把位优先靠近根音下方 3 品的形状。 */
      var target = Math.max(0, r5 - 3);
      return v.hasOpen * 100 + v.sounding * 2 - Math.abs(v.position - target) * 2;
    });
    var A = pick(function (v) { return bassStringOf(v) === 1; }, function (v) {
      return openScore(v, r5 === 0) + v.sounding * 2 - Math.abs(v.position - r5) * 2;
    });
    var G = pick(function (v) {
      return bassStringOf(v) === 0 && v.position < gRoot;
    }, function (v) {
      /* G 型是根音低 3 品起的大跨度形状；没有根音在 0–2 品时用高八度。 */
      return openScore(v, gRoot === 3) + v.sounding * 2 -
        Math.abs(v.position - Math.max(0, gRoot - 3)) * 2;
    });
    var E = pick(function (v) {
      return bassStringOf(v) === 0 && v.position >= r6;
    }, function (v) {
      return openScore(v, r6 === 0) + v.sounding * 2 - Math.abs(v.position - r6) * 2;
    });
    var D = pick(function (v) {
      return bassStringOf(v) === 2 && v.position >= r4;
    }, function (v) {
      return openScore(v, r4 === 0) + v.sounding * 2 - Math.abs(v.position - r4) * 2;
    });
    /* 极少数严格筛选下某个区域没有代表指法，保留空位，UI 会提示。 */
    function shape(id, rootString, rootFret, v) {
      return {
        id: id,
        zh: id + ' 型',
        rootString: rootString,
        rootFret: rootFret,
        position: v ? v.position : null,
        hasOpen: !!(v && v.hasOpen),
        voicing: v || null,
        frets: v ? v.frets : null
      };
    }
    return [
      shape('C', 1, r5, C),
      shape('A', 1, r5, A),
      shape('G', 0, gRoot, G),
      shape('E', 0, r6, E),
      shape('D', 2, r4, D)
    ];
  }

  /* 和弦完整名称 */
  function chordSymbol(rootPc, quality, preferFlat) {
    return global.Music.noteName(rootPc, preferFlat) + quality.symbol;
  }

  /* 组成音名称列表 */
  function chordToneNames(rootPc, quality, preferFlat) {
    var names = [];
    for (var i = 0; i < quality.intervals.length; i++) {
      var pc = global.Music.mod12(rootPc + quality.intervals[i]);
      names.push({ pc: pc, name: global.Music.noteName(pc, preferFlat), degree: intervalDegreeName(quality.intervals[i]) });
    }
    return names;
  }

  global.Chord = {
    TUNING: TUNING,
    STRING_NAMES: STRING_NAMES,
    QUALITY_LIST: QUALITY_LIST,
    qualityById: qualityById,
    pcAt: pcAt,
    midiAt: midiAt,
    searchVoicings: searchVoicings,
    groupByPosition: groupByPosition,
    positionLabel: positionLabel,
    tabString: tabString,
    chordSymbol: chordSymbol,
    chordToneNames: chordToneNames,
    intervalDegreeName: intervalDegreeName,
    minPressedOf: minPressedOf,
    cagedVoicings: cagedVoicings
  };
})(window);
