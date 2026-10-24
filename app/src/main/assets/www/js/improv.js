/*!
 * improv.js —— 「即兴」：用大模型多 agent 协作写一段简谱，并配和弦 / 六线谱 / 播放
 *
 * 设计分成两层：
 *   1. 纯函数（可脱离网络与音频单测）
 *      - 简谱模型：每小节 8 个八分音符格；0 = 休止，- = 延音，
 *        音符 = [b|#]?[1-7] + 可选的 '（高八度）或 ,（低八度）
 *      - 校验器：按 Bias 与风格限制可用音，修掉越界音、孤儿延音、空小节
 *      - 本地作曲：没有 API 也能写出一段（也是 AI 失败时的兜底）
 *      - 简谱 → 和弦、简谱 → 六线谱
 *   2. 多 agent 流水线（手写，不用 LangGraph）
 *      主控 Agent（结构） → 填音 Agent（逐格） → 衔接 Agent（小节间技巧）
 *      → 本地校验器（确定性，不发请求）
 *
 * 这些 agent 之间只通过 JSON 交接，任何一步失败都能降级：
 *   - 衔接 Agent 失败 → 本地技巧启发式补上；
 *   - 全部失败 → 用户仍可「本地试写」。
 */
(function (global) {
  'use strict';

  var M = global.Music, C = global.Chord, B = global.Backing, A = global.Audio_, T = global.Transport;

  var BAR_BEATS = 4;
  var SLOTS = 8;
  var SLOT_BEATS = 0.5;

  var TECHS = ['slide', 'bend', 'hammer', 'pull', 'vib'];
  var TECH_ZH = { slide: '滑音', bend: '推弦', hammer: '击弦', pull: '勾弦', vib: '揉弦' };

  var STYLES = [
    { id: 'penta', zh: '五声音阶', en: 'Minor pentatonic',
      offsets: [0, 3, 5, 7, 10],
      feel: '摇滚 / 流行 solo 最稳，怎么弹都不容易错' },
    { id: 'blues', zh: '布鲁斯', en: 'Blues scale',
      offsets: [0, 3, 5, 6, 7, 10],
      feel: '多一个 ♭5 蓝调音，推弦与滑音的味道' },
    { id: 'blue', zh: '蓝调', en: 'Jazz blues',
      offsets: [0, 2, 3, 4, 5, 6, 7, 9, 10],
      feel: '大小三度混用、加六度，更爵士更花' },
    { id: 'major', zh: '大调', en: 'Major',
      offsets: [0, 2, 4, 5, 7, 9, 11],
      feel: '直接、明亮，流行 / 民谣旋律' },
    { id: 'minor', zh: '自然小调', en: 'Aeolian',
      offsets: [0, 2, 3, 5, 7, 8, 10],
      feel: '忧郁、深沉，抒情与摇滚叙事' },
    { id: 'dorian', zh: '多利亚', en: 'Dorian',
      offsets: [0, 2, 3, 5, 7, 9, 10],
      feel: '小调带亮色，爵士 / 放克 / 摇滚' },
    { id: 'mixolydian', zh: '混合利底亚', en: 'Mixolydian',
      offsets: [0, 2, 4, 5, 7, 9, 10],
      feel: '大调带 ♭7，布鲁斯 / 南方摇滚' }
  ];

  var ALL_PCS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  var state = {
    styleId: 'penta',
    bias: 40,
    tone: 'electric',
    volume: 1.2,
    score: null,
    busy: false
  };

  var live = {
    enabled: false,
    score: null,
    tone: 'electric',
    /* 旋律是单音，伴奏是整串和弦；这个音量再经过下面的 solo 总线抬高 */
    volume: 1.2,
    cursor: 0
  };

  /* 给 solo 单独一条总线：中高频抬一点、整体再推一点，避免被扫弦盖住。
     按上下文缓存，离线渲染/实时播放各用各的。 */
  function soloBusFor(ctx, out, mixVol) {
    if (ctx.__improvSoloBus) {
      if (mixVol !== undefined && ctx.__improvSoloMix) {
        try { ctx.__improvSoloMix.gain.value = mixVol; } catch (e) {}
      }
      return ctx.__improvSoloBus;
    }
    var eq = ctx.createBiquadFilter();
    eq.type = 'peaking';
    eq.frequency.value = 1800;
    eq.Q.value = 0.85;
    eq.gain.value = 4.5;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -11;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    var gain = ctx.createGain();
    gain.gain.value = 1.5;
    var mix = ctx.createGain();
    mix.gain.value = (mixVol === undefined) ? 1 : mixVol;
    eq.connect(comp);
    comp.connect(gain);
    gain.connect(mix);
    mix.connect(out);
    ctx.__improvSoloBus = eq;
    ctx.__improvSoloMix = mix;
    return eq;
  }

  /* ============================ 小工具 ============================ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function mod12(n) { return M.mod12(n); }
  function repeat(ch, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += ch;
    return s;
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function nowMs() { return (new Date()).getTime(); }
  function randId(prefix) { return prefix + nowMs() + Math.floor(Math.random() * 1000); }

  function styleById(id) {
    for (var i = 0; i < STYLES.length; i++) if (STYLES[i].id === id) return STYLES[i];
    return STYLES[0];
  }

  function techById(id) {
    for (var i = 0; i < TECHS.length; i++) if (TECHS[i] === id) return id;
    return null;
  }

  /* ============================ 简谱记号 ============================ */
  /**
   * 解析一个格子
   * @returns {{type:'rest'|'hold'|'note', degree?:number, acc?:number, oct?:number}}
   */
  function parseToken(raw) {
    if (raw === undefined || raw === null) return { type: 'rest' };
    var t = String(raw)
      .replace(/\s+/g, '')
      .replace(/\u266d/g, 'b').replace(/\u266f/g, '#')
      .replace(/\u2013|\u2014|\u2015|\u2212/g, '-');
    if (t === '' || t === '0' || t === 'x' || t === 'X') return { type: 'rest' };
    if (t === '-' || t === '~' || t === '_') return { type: 'hold' };
    var m = /^([#b]{0,2})([1-7])([',+\-]{0,2})$/.exec(t);
    if (!m) return { type: 'rest', invalid: true };
    var acc = 0, i;
    for (i = 0; i < m[1].length; i++) acc += (m[1].charAt(i) === '#') ? 1 : -1;
    var oct = 0;
    for (i = 0; i < m[3].length; i++) {
      var ch = m[3].charAt(i);
      oct += (ch === "'" || ch === '+') ? 1 : -1;
    }
    return { type: 'note', degree: Number(m[2]), acc: clamp(acc, -2, 2), oct: clamp(oct, -2, 2) };
  }

  function tokenOf(degree, acc, oct) {
    acc = clamp(acc || 0, -2, 2);
    oct = clamp(oct || 0, -2, 2);
    var s = '';
    if (acc < 0) s += repeat('b', -acc);
    else if (acc > 0) s += repeat('#', acc);
    s += String(clamp(degree || 1, 1, 7));
    if (oct > 0) s += repeat("'", oct);
    else if (oct < 0) s += repeat(',', -oct);
    return s;
  }

  function normalizeToken(raw) {
    var t = parseToken(raw);
    if (t.type === 'note') return tokenOf(t.degree, t.acc, t.oct);
    if (t.type === 'hold') return '-';
    return '0';
  }

  function midiOfToken(t, keyPc, scaleId) {
    if (!t || t.type !== 'note') return null;
    var pc = M.degreeToPc(keyPc, scaleId, t.degree, t.acc);
    return 60 + pc + 12 * (t.oct || 0);
  }

  /* 把一个 MIDI 音高写成当前调式里的简谱记号 */
  function tokenFromMidi(midi, keyPc, scaleId) {
    var pc = mod12(midi);
    var d = M.scaleDegreeOf(pc, keyPc, scaleId);
    var oct = Math.round((midi - 60 - pc) / 12);
    return tokenOf(d.degree, d.acc, oct);
  }

  /* ============================ 调 / 调式 / 和弦 ============================ */
  function parseKeyName(name) {
    if (name === undefined || name === null) return -1;
    var s = String(name).replace(/\s+/g, '')
      .replace(/\u266d/g, 'b').replace(/\u266f/g, '#')
      .replace(/^降/, 'b').replace(/^升/, '#');
    /* 允许降E / bE / Eb / #F 这几种写法 */
    var m = /^([#b]*)([A-Ga-g])([#b]*)$/.exec(s);
    if (!m) return -1;
    var letters = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    var pc = letters[m[2].toUpperCase()];
    if (pc === undefined) return -1;
    var i;
    for (i = 0; i < m[1].length; i++) pc += (m[1].charAt(i) === '#') ? 1 : -1;
    for (i = 0; i < m[3].length; i++) pc += (m[3].charAt(i) === '#') ? 1 : -1;
    return mod12(pc);
  }

  function scaleIdFromName(name) {
    if (!name) return null;
    var s = String(name).toLowerCase().replace(/\s+/g, '');
    var map = {
      major: 'major', ionian: 'ionian', minor: 'minor', aeolian: 'aeolian',
      dorian: 'dorian', phrygian: 'phrygian', lydian: 'lydian',
      mixolydian: 'mixolydian', locrian: 'locrian', harmonic: 'harmonic',
      '大调': 'major', '自然小调': 'minor', '和声小调': 'harmonic',
      '伊奥尼亚': 'ionian', '多利亚': 'dorian', '弗里几亚': 'phrygian',
      '利底亚': 'lydian', '混合利底亚': 'mixolydian', '爱奥利亚': 'aeolian',
      '洛克里亚': 'locrian'
    };
    if (map[s]) return map[s];
    for (var i = 0; i < M.SCALES.length; i++) {
      if (M.SCALES[i].id === s || M.SCALES[i].label === name ||
          (M.SCALES[i].en || '').toLowerCase() === s) return M.SCALES[i].id;
    }
    return null;
  }

  function chordPcs(chord) {
    if (!chord) return [];
    var q = C.qualityById(chord.qualityId);
    var out = [];
    for (var i = 0; i < q.intervals.length; i++) out.push(mod12(chord.rootPc + q.intervals[i]));
    return out;
  }

  /**
   * 把和弦走向摊成时间轴：totalBeats / bars / 每个和弦的起始拍
   * 走向会循环使用；谱面小节数按总拍数向上取整。
   */
  function progressionGrid(prog, keyPc, scaleId) {
    var items = [], beat = 0, i;
    if (prog && prog.items) {
      for (i = 0; i < prog.items.length; i++) {
        var it = prog.items[i];
        var chord = B.chordAt(keyPc, scaleId, it.degree, it.acc, it.quality);
        items.push({
          start: beat, beats: it.beats, chord: chord,
          degree: it.degree, acc: it.acc || 0, quality: it.quality || null
        });
        beat += it.beats;
      }
    }
    return {
      items: items,
      totalBeats: Math.max(1, beat),
      bars: Math.max(1, Math.ceil(Math.max(1, beat) / BAR_BEATS)),
      keyPc: keyPc,
      scaleId: scaleId,
      prog: prog
    };
  }

  function gridItemAtBeat(grid, beat) {
    if (!grid || !grid.items.length) return null;
    var total = grid.totalBeats || 1;
    beat = ((beat % total) + total) % total;
    for (var i = 0; i < grid.items.length; i++) {
      var it = grid.items[i];
      if (beat < it.start + it.beats) return it;
    }
    return grid.items[grid.items.length - 1];
  }

  function chordAtSlot(grid, bar, slot) {
    var it = gridItemAtBeat(grid, bar * BAR_BEATS + slot * SLOT_BEATS);
    return it ? it.chord : null;
  }

  /* 一小节里出现过的和弦（按时间顺序去重） */
  function barChordNames(score, bar, grid) {
    var out = [];
    var i;
    if (score && score.barChords && score.barChords[bar]) {
      var raw = score.barChords[bar];
      if (typeof raw === 'string') {
        var parts = raw.split(/[,\/|、]/);
        for (i = 0; i < parts.length; i++) {
          var t = parts[i].replace(/^\s+|\s+$/g, '');
          if (t) out.push(t);
        }
      } else if (raw.length) {
        for (i = 0; i < raw.length; i++) out.push(String(raw[i]));
      }
    }
    if (!out.length && grid) {
      var preferFlat = !!score.preferFlat;
      for (i = 0; i < SLOTS; i += 2) {
        var ch = chordAtSlot(grid, bar, i);
        if (!ch) continue;
        var name = B.chordName(ch, preferFlat);
        if (out.indexOf(name) < 0) out.push(name);
      }
    }
    return out;
  }

  function stylePcs(keyPc, styleId) {
    var st = styleById(styleId);
    var out = [];
    for (var i = 0; i < st.offsets.length; i++) out.push(mod12(keyPc + st.offsets[i]));
    return out;
  }

  function mergePcs(a, b) {
    var out = [], i;
    for (i = 0; i < a.length; i++) if (out.indexOf(a[i]) < 0) out.push(a[i]);
    for (i = 0; i < b.length; i++) if (out.indexOf(b[i]) < 0) out.push(b[i]);
    return out;
  }

  /**
   * 某一格允许的音（Bias 的三档规则）
   *   ≤20   只用和弦音
   *   ≤65   强拍和弦音，弱拍 和弦音 ∪ 风格音阶
   *   >65   不限制（半音都可以）
   */
  function allowedPcs(chord, keyPc, styleId, bias, strong) {
    var b = clamp(bias === undefined ? 40 : bias, 0, 100) / 100;
    if (b > 0.65) return null;
    var cp = chordPcs(chord);
    var palette = stylePcs(keyPc, styleId);
    if (b <= 0.2) return cp.length ? cp : palette;
    if (strong && cp.length) return cp;
    return cp.length ? mergePcs(cp, palette) : palette;
  }

  function nearestPc(pc, list, preferUp) {
    var best = pc, bestD = 13, bestDelta = 0;
    for (var i = 0; i < list.length; i++) {
      var d = list[i] - pc;
      if (d > 6) d -= 12;
      if (d < -6) d += 12;
      var ad = Math.abs(d);
      if (ad < bestD || (ad === bestD && ((preferUp && d > 0) || (!preferUp && d < 0)))) {
        best = list[i]; bestD = ad; bestDelta = d;
      }
    }
    return { pc: mod12(best), delta: bestDelta };
  }

  /* ============================ 校验 / 修补 ============================ */
  function normalizeTech(raw) {
    var out = {};
    if (!raw) return out;
    var i;
    if (raw.length !== undefined && typeof raw !== 'string') {
      for (i = 0; i < raw.length; i++) {
        var it = raw[i];
        if (!it) continue;
        var slot = Number(it.slot !== undefined ? it.slot : it.index);
        var tech = techById(it.tech || it.type);
        if (tech && slot >= 0 && slot < SLOTS) out[slot] = tech;
      }
      return out;
    }
    for (var k in raw) {
      if (!raw.hasOwnProperty(k)) continue;
      var s = Number(k);
      var t = techById(raw[k]);
      if (t && s >= 0 && s < SLOTS) out[s] = t;
    }
    return out;
  }

  function normalizeBar(raw, rawSlots) {
    var slots = rawSlots;
    if (slots === undefined && raw) {
      slots = raw.slots !== undefined ? raw.slots : raw;
    }
    if (typeof slots === 'string') slots = slots.split(/[\s,|]+/);
    if (!slots || !slots.length) slots = [];
    var i, out = [];
    for (i = 0; i < slots.length; i++) out.push(normalizeToken(slots[i]));
    /* 模型常给 4 个四分音符；展开成 8 个八分格（音 + 延音） */
    if (out.length === 4) {
      var ex = [];
      for (i = 0; i < 4; i++) { ex.push(out[i]); ex.push('-'); }
      out = ex;
    }
    while (out.length < SLOTS) out.push('0');
    if (out.length > SLOTS) out = out.slice(0, SLOTS);
    if (parseToken(out[0]).type === 'hold') out[0] = '0';
    return {
      slots: out,
      tech: normalizeTech(raw && raw.tech)
    };
  }

  /**
   * 规范成统一的 score 结构；不修改原对象
   */
  function normalizeScore(input, opts) {
    opts = opts || {};
    var raw = input || {};
    var srcBars = raw.bars || [];
    var wantBars = opts.bars || srcBars.length || 1;
    var bars = [], i;
    for (i = 0; i < srcBars.length; i++) bars.push(normalizeBar(srcBars[i]));
    if (!bars.length) bars.push(normalizeBar(null, ['0', '0', '0', '0', '0', '0', '0', '0']));
    while (bars.length < wantBars) bars.push(normalizeBar(null, ['0', '0', '0', '0', '0', '0', '0', '0']));
    if (bars.length > wantBars) bars = bars.slice(0, wantBars);

    var keyPc = (raw.keyPc === undefined || raw.keyPc === null) ? (opts.keyPc || 0) : Number(raw.keyPc);
    if (isNaN(keyPc)) keyPc = 0;
    keyPc = mod12(keyPc);
    var scaleId = raw.scaleId || opts.scaleId || 'major';
    if (M.scaleById(scaleId).id !== scaleId) scaleId = 'major';
    var styleId = raw.styleId || opts.styleId || 'penta';
    if (styleById(styleId).id !== styleId) styleId = 'penta';
    var bpm = Number(raw.bpm || opts.bpm || 100);
    if (!isFinite(bpm) || bpm < 40) bpm = 100;
    bpm = clamp(Math.round(bpm), 40, 240);
    var bias = Number(raw.bias === undefined ? (opts.bias === undefined ? 40 : opts.bias) : raw.bias);
    if (!isFinite(bias)) bias = 40;
    bias = clamp(Math.round(bias), 0, 100);
    var rangeBias = Number(raw.rangeBias === undefined
      ? (opts.rangeBias === undefined ? 0.5 : opts.rangeBias) : raw.rangeBias);
    if (!isFinite(rangeBias)) rangeBias = 0.5;
    rangeBias = clamp(rangeBias, 0, 1);

    var score = {
      id: raw.id || null,
      title: raw.title || opts.title || '即兴简谱',
      keyPc: keyPc,
      scaleId: scaleId,
      styleId: styleId,
      bias: bias,
      rangeBias: rangeBias,
      bpm: bpm,
      preferFlat: raw.preferFlat === undefined ? !!opts.preferFlat : !!raw.preferFlat,
      bars: bars,
      barChords: raw.barChords ? raw.barChords.slice(0) : null,
      progression: raw.progression || opts.progression || null,
      progressionName: raw.progressionName || opts.progressionName ||
        (raw.progression && raw.progression.zh) || (opts.progression && opts.progression.zh) || '',
      instanceId: raw.instanceId || opts.instanceId || null,
      instanceName: raw.instanceName || opts.instanceName || '',
      progressText: raw.progressText || opts.progressText || '',
      createdAt: raw.createdAt || nowMs(),
      source: raw.source || 'local',
      fixes: raw.fixes || 0
    };
    return score;
  }

  /**
   * 修补：按 Bias / 风格把越界音挪到最近允许音；清掉孤儿延音；补空小节
   * @returns {{score:object, fixes:number, stats:object}}
   */
  function repairScore(input, opts) {
    opts = opts || {};
    var score = normalizeScore(input, opts);
    var grid = opts.grid || (score.progression
      ? progressionGrid(score.progression, score.keyPc, score.scaleId) : null);
    /* 只有“即兴生成”的谱才按 Bias 修音；图片/文本导入要尽量保留原谱，
       不能拿风格音阶去改人家的旋律。 */
    var doPitch = !!grid && score.source !== 'text' && score.source !== 'image';
    var fixes = 0;
    var bar, slot, i;

    for (bar = 0; bar < score.bars.length; bar++) {
      var b = score.bars[bar];
      var prevNoteMidi = null;
      var repeatRun = 0;
      for (slot = 0; slot < SLOTS; slot++) {
        var t = parseToken(b.slots[slot]);
        if (t.type === 'rest' && b.slots[slot] !== '0') { b.slots[slot] = '0'; fixes++; }
        if (t.type !== 'note') {
          prevNoteMidi = null;
          repeatRun = 0;
          continue;
        }
        if (!doPitch) continue;
        var midi = midiOfToken(t, score.keyPc, score.scaleId);
        var finalMidi = midi;
        var pc = mod12(midi);
        var strong = (slot % 2 === 0);
        var allow = allowedPcs(chordAtSlot(grid, bar, slot), score.keyPc, score.styleId, score.bias, strong);
        if (allow && allow.indexOf(pc) < 0) {
          var move = nearestPc(pc, allow, strong);
          var newMidi = midi + move.delta;
          var d = M.scaleDegreeOf(mod12(newMidi), score.keyPc, score.scaleId);
          var acc = d.acc;
          var degLabel = (acc === 0 ? '' : (acc < 0 ? '\u266d' : '\u266f')) + d.degree;
          b.slots[slot] = tokenFromMidi(newMidi, score.keyPc, score.scaleId);
          finalMidi = newMidi;
          fixes++;
          if (global.console && global.console.log) {
            global.console.log('[improv] 校验：第 ' + (bar + 1) + ' 小节第 ' + (slot + 1) +
              ' 格 ' + tokenOf(t.degree, t.acc, t.oct) + ' → ' + b.slots[slot] +
              '（' + M.noteName(mod12(newMidi), score.preferFlat) + '，' + degLabel + ' 级）');
          }
        }
        /* 同音连续 3 次很像练习曲：在允许音里换一个最近的，保持节奏不动 */
        if (finalMidi === prevNoteMidi) repeatRun++;
        else repeatRun = 1;
        if (repeatRun >= 3 && allow && allow.length > 1) {
          var alt = [];
          for (var ai = 0; ai < allow.length; ai++) {
            if (mod12(allow[ai]) !== mod12(finalMidi)) alt.push(allow[ai]);
          }
          if (alt.length) {
            var am = nearestPc(mod12(finalMidi), alt, true);
            var altMidi = finalMidi + am.delta;
            b.slots[slot] = tokenFromMidi(altMidi, score.keyPc, score.scaleId);
            finalMidi = altMidi;
            repeatRun = 1;
            fixes++;
          }
        }
        prevNoteMidi = finalMidi;
      }
      /* 每一小节至少得有一个音，否则空着不好听也不好看 */
      var hasNote = false;
      for (slot = 0; slot < SLOTS; slot++) {
        if (parseToken(b.slots[slot]).type === 'note') { hasNote = true; break; }
      }
      if (!hasNote) {
        var ch = chordAtSlot(grid, bar, 0);
        if (ch) {
          b.slots[0] = tokenFromMidi(60 + ch.rootPc, score.keyPc, score.scaleId);
        } else {
          b.slots[0] = tokenOf(1, 0, 0);
        }
        fixes++;
      }
    }

    /* 技巧只能落在有音的位置；延音/休止上的技巧没有意义 */
    for (bar = 0; bar < score.bars.length; bar++) {
      var tech = score.bars[bar].tech || {};
      for (var k in tech) {
        if (!tech.hasOwnProperty(k)) continue;
        var s = Number(k);
        if (s < 0 || s >= SLOTS || !techById(tech[k]) || parseToken(score.bars[bar].slots[s]).type !== 'note') {
          delete tech[k];
          fixes++;
        }
      }
      score.bars[bar].tech = tech;
    }

    score.fixes = fixes;
    return { score: score, fixes: fixes, stats: scoreStats(score) };
  }

  function scoreStats(score) {
    var notes = 0, rests = 0, holds = 0, techs = 0;
    var minMidi = 999, maxMidi = -1;
    for (var b = 0; b < score.bars.length; b++) {
      var bar = score.bars[b];
      for (var s = 0; s < SLOTS; s++) {
        var t = parseToken(bar.slots[s]);
        if (t.type === 'note') {
          notes++;
          var midi = midiOfToken(t, score.keyPc, score.scaleId);
          if (midi < minMidi) minMidi = midi;
          if (midi > maxMidi) maxMidi = midi;
        } else if (t.type === 'hold') holds++;
        else rests++;
      }
      for (var k in (bar.tech || {})) if (bar.tech.hasOwnProperty(k)) techs++;
    }
    return {
      bars: score.bars.length,
      notes: notes,
      rests: rests,
      holds: holds,
      techs: techs,
      minMidi: maxMidi < 0 ? null : minMidi,
      maxMidi: maxMidi < 0 ? null : maxMidi
    };
  }

  function midiName(midi, preferFlat) {
    if (midi === null || midi === undefined) return '-';
    return M.noteName(mod12(midi), preferFlat) + (Math.floor(midi / 12) - 1);
  }

  function statsText(score) {
    var st = scoreStats(score);
    return st.bars + ' 小节 · ' + st.notes + ' 个音 · 休止 ' + st.rests + ' · 延音 ' + st.holds +
      ' · 技巧 ' + st.techs + ' · 音域 ' + midiName(st.minMidi, score.preferFlat) +
      '–' + midiName(st.maxMidi, score.preferFlat);
  }

  function validateScore(score) {
    var errs = [];
    if (!score || !score.bars || !score.bars.length) return ['谱面是空的'];
    if (M.scaleById(score.scaleId).id !== score.scaleId) errs.push('调式非法：' + score.scaleId);
    if (score.keyPc < 0 || score.keyPc > 11) errs.push('主调越界：' + score.keyPc);
    if (score.bpm < 40 || score.bpm > 240) errs.push('BPM 越界：' + score.bpm);
    if (score.bias < 0 || score.bias > 100) errs.push('Bias 越界：' + score.bias);
    for (var b = 0; b < score.bars.length; b++) {
      var bar = score.bars[b];
      if (!bar.slots || bar.slots.length !== SLOTS) errs.push('第 ' + (b + 1) + ' 小节不是 8 格');
      for (var s = 0; s < SLOTS; s++) {
        if (bar.slots[s] !== normalizeToken(bar.slots[s])) {
          errs.push('第 ' + (b + 1) + ' 小节第 ' + (s + 1) + ' 格记号不规范：' + bar.slots[s]);
        }
      }
      for (var k in (bar.tech || {})) {
        if (!bar.tech.hasOwnProperty(k)) continue;
        if (!techById(bar.tech[k])) errs.push('第 ' + (b + 1) + ' 小节技巧未知：' + bar.tech[k]);
        if (parseToken(bar.slots[Number(k)]).type !== 'note') {
          errs.push('第 ' + (b + 1) + ' 小节第 ' + (Number(k) + 1) + ' 格技巧落在非音符上');
        }
      }
    }
    return errs;
  }

  /* ============================ 本地作曲 ============================ */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var PATTERNS = [
    'n0n0n0n0', 'n-n0n0n0', 'n0n-n0n0', 'n0nn0n0n',
    'n-n-n0n0', 'n0n0n-n-', 'n0nn0n-n', 'nnnnnnnn', 'n0n0n0n-',
    'n0nn0nnn', 'n-nn0nnn', 'n0n0nnnn', 'nn0nn0n-', 'nn0n-n0n', 'n0nn0n0-'
  ];

  function noteCount(pattern) {
    var n = 0;
    for (var i = 0; i < pattern.length; i++) if (pattern.charAt(i) === 'n') n++;
    return n;
  }

  /**
   * 音域 Bias（0–1）：0 约一个八度，1 约两个八度。
   * 返回的是吉他实际可弹的 MIDI 范围，供本地作曲和 AI 提示词共同使用。
   */
  function noteRange(keyPc, rangeBias) {
    var r = clamp(rangeBias === undefined ? 0.5 : Number(rangeBias), 0, 1);
    if (!isFinite(r)) r = 0.5;
    var tonic = 60 + mod12(keyPc);
    var low = tonic - Math.round(4 + 10 * r);
    var high = tonic + Math.round(8 + 8 * r);
    low = Math.max(40, low);
    high = Math.min(86, high);
    if (high - low < 12) high = Math.min(86, low + 12);
    return { low: low, high: high, span: high - low, r: r };
  }

  /* 音域只作为提示词/本地作曲的约束；不再事后强行移八度改写模型输出的旋律。 */

  function pickPitch(prevMidi, allowed, chordPcs, strong, bias, rnd, range, target) {
    if (!allowed || !allowed.length) allowed = ALL_PCS;
    if (prevMidi === null || prevMidi === undefined) prevMidi = target || 64;
    var low = range ? range.low : 55;
    var high = range ? range.high : 79;
    var r = range ? range.r : 0.5;
    var best = null, bestScore = -1e9;
    for (var i = 0; i < allowed.length; i++) {
      var pc = allowed[i];
      for (var oct = -2; oct <= 2; oct++) {
        var midi = 60 + pc + 12 * oct;
        if (midi < low || midi > high) continue;
        var sc = -Math.abs(midi - prevMidi) * (1.1 - r * 0.58);
        if (chordPcs.indexOf(pc) >= 0) sc += 3;
        if (strong) sc += 1.4;
        if (midi >= 60 && midi <= 76) sc += 0.8;
        /* 同一个音连续出现会很像练习曲，重罚；换一个和弦音通常更好听 */
        if (midi === prevMidi) sc -= 3.2;
        if (bias > 65 && chordPcs.indexOf(pc) < 0) sc -= 0.9;
        if (target !== undefined && target !== null) {
          sc -= Math.abs(midi - target) * (0.18 + r * 0.20);
        }
        sc += rnd() * (1.8 + r * 1.2);
        if (sc > bestScore) { bestScore = sc; best = midi; }
      }
    }
    if (best === null) best = Math.max(low, Math.min(high, prevMidi));
    return best;
  }

  function addAutoTechs(bars, keyPc, scaleId, rnd) {
    for (var b = 1; b < bars.length; b++) {
      var prevBar = bars[b - 1], bar = bars[b];
      /* 只在真正的小节交界做衔接：上一小节最后一格必须是实际拨响的音符，
         不能是延音（-）或休止（0）；目标也必须是下一小节第 1 格。
         上一小节结尾如果是延音，手指还在原音上，下小节开头直接滑音并不自然。 */
      if (parseToken(prevBar.slots[SLOTS - 1]).type !== 'note') continue;
      if (parseToken(bar.slots[0]).type !== 'note') continue;
      var lastSlot = SLOTS - 1, firstSlot = 0;
      if (bar.tech && bar.tech[firstSlot]) continue;
      var a = midiOfToken(parseToken(prevBar.slots[lastSlot]), keyPc, scaleId);
      var c = midiOfToken(parseToken(bar.slots[firstSlot]), keyPc, scaleId);
      var delta = c - a;
      var tech = null, chance = 0.42;
      if (delta <= -2) { tech = 'slide'; chance = 0.8; }
      else if (delta >= 2) { tech = 'bend'; chance = 0.8; }
      else if (delta === 0) { tech = 'vib'; chance = 0.45; }
      else if (delta === 1) { tech = 'hammer'; chance = 0.5; }
      else if (delta === -1) { tech = 'pull'; chance = 0.5; }
      if (tech && rnd() < chance) {
        if (!bar.tech) bar.tech = {};
        bar.tech[firstSlot] = tech;
      }
    }
    /* 小节内部也补一些连奏：相邻两格都是实际音符时，
       上行用击弦、下行用勾弦，跨度大一点用滑音；每小节最多 1 个。 */
    for (b = 0; b < bars.length; b++) {
      var bar2 = bars[b];
      if (bar2.tech && Object.keys(bar2.tech).length) continue;
      for (var s2 = 1; s2 < SLOTS; s2++) {
        if (parseToken(bar2.slots[s2 - 1]).type !== 'note' ||
            parseToken(bar2.slots[s2]).type !== 'note') continue;
        var a2 = midiOfToken(parseToken(bar2.slots[s2 - 1]), keyPc, scaleId);
        var c2 = midiOfToken(parseToken(bar2.slots[s2]), keyPc, scaleId);
        var d2 = c2 - a2;
        var t2 = null;
        if (d2 === 1 || d2 === 2) t2 = 'hammer';
        else if (d2 === -1 || d2 === -2) t2 = 'pull';
        else if (Math.abs(d2) >= 3 && Math.abs(d2) <= 7) t2 = 'slide';
        if (t2 && rnd() < 0.28) {
          bar2.tech = bar2.tech || {};
          bar2.tech[s2] = t2;
          break;
        }
      }
    }
    /* 长音偶尔揉弦 */
    for (b = 0; b < bars.length; b++) {
      for (var s = 0; s < SLOTS - 2; s++) {
        if (parseToken(bars[b].slots[s]).type === 'note' &&
            parseToken(bars[b].slots[s + 1]).type === 'hold' &&
            parseToken(bars[b].slots[s + 2]).type === 'hold' &&
            rnd() < 0.25) {
          if (!bars[b].tech) bars[b].tech = {};
          if (!bars[b].tech[s]) bars[b].tech[s] = 'vib';
        }
      }
    }
    /* 连音改写后可能一个相邻音都不剩；至少给一个长音加揉弦，别整段干巴巴。 */
    var techTotal = 0;
    for (b = 0; b < bars.length; b++) {
      techTotal += bars[b].tech ? Object.keys(bars[b].tech).length : 0;
    }
    if (!techTotal) {
      for (b = 0; b < bars.length; b++) {
        for (s = 0; s < SLOTS - 1; s++) {
          if (parseToken(bars[b].slots[s]).type === 'note' &&
              parseToken(bars[b].slots[s + 1]).type === 'hold') {
            bars[b].tech = bars[b].tech || {};
            bars[b].tech[s] = 'vib';
            return bars;
          }
        }
      }
    }
    return bars;
  }

  /**
   * 连音/延音润色：把一部分相邻音合并成延音，并把句尾的空格延长成连音。
   * 简谱里 `-` 就是“上一个音继续响”，每多一个 -，这个音就多连一个八分格。
   * 目标不是越少音越好，而是让长音跨过拍点，句子有呼吸和情绪。
   */
  function addLegato(bars, opts) {
    opts = opts || {};
    var rnd = opts.rnd || Math.random;
    var minAttack = opts.minAttack || 5;
    for (var b = 0; b < bars.length; b++) {
      var bar = bars[b];
      var slots = bar.slots;
      var s, notes = 0, holds = 0;
      for (s = 0; s < SLOTS; s++) {
        var t0 = parseToken(slots[s]);
        if (t0.type === 'note') notes++;
        else if (t0.type === 'hold') holds++;
      }
      /* 句尾/长音后的空拍改成延音：不减少起音，只把一个音拉长。 */
      for (s = 4; s < SLOTS; s++) {
        if (slots[s] !== '0') continue;
        var prev = parseToken(slots[s - 1]);
        if ((prev.type === 'note' || prev.type === 'hold') && rnd() < 0.42) {
          slots[s] = '-';
          holds++;
        }
      }
      /* 还不到目标时，把反拍上的相邻音并进前一个音；保留至少 minAttack 个起音。 */
      var target = Math.min(2, Math.max(0, notes - minAttack));
      if (holds < target) {
        var candidates = [];
        for (s = 1; s < SLOTS; s++) {
          if (parseToken(slots[s]).type !== 'note') continue;
          var pt = parseToken(slots[s - 1]);
          if (pt.type !== 'note' && pt.type !== 'hold') continue;
          var score = (s % 2 === 1 ? 2 : 0) + (s >= 4 ? 1 : 0) +
            (s >= 6 ? 0.8 : 0) + rnd() * 0.6;
          if (bar.tech && bar.tech[s]) score -= 1.5;
          candidates.push({ s: s, score: score });
        }
        candidates.sort(function (a, c) { return c.score - a.score; });
        for (var ci = 0; ci < candidates.length && holds < target && notes > minAttack; ci++) {
          s = candidates[ci].s;
          if (parseToken(slots[s]).type !== 'note') continue;
          slots[s] = '-';
          if (bar.tech && bar.tech[s]) delete bar.tech[s];
          holds++;
          notes--;
        }
      }
      /* 每小节至少留一个连音：优先把音后的空拍延长，实在没有空拍才合并一个反拍音。 */
      if (!holds) {
        for (s = SLOTS - 1; s >= 1; s--) {
          if (slots[s] !== '0') continue;
          var p0 = parseToken(slots[s - 1]);
          if (p0.type === 'note' || p0.type === 'hold') {
            slots[s] = '-';
            holds++;
            break;
          }
        }
        if (!holds) {
          for (s = SLOTS - 1; s >= 1; s--) {
            if (parseToken(slots[s]).type !== 'note') continue;
            if (s % 2 === 0) continue;
            var p1 = parseToken(slots[s - 1]);
            if (p1.type !== 'note' && p1.type !== 'hold') continue;
            slots[s] = '-';
            if (bar.tech && bar.tech[s]) delete bar.tech[s];
            holds++;
            break;
          }
        }
      }
      /* 有足够起音时，目标提高到 2 个连音；优先用空拍延长，不牺牲起音。 */
      if (holds < 2 && notes >= 5) {
        for (s = SLOTS - 1; s >= 1; s--) {
          if (slots[s] !== '0') continue;
          var p2 = parseToken(slots[s - 1]);
          if (p2.type === 'note' || p2.type === 'hold') {
            slots[s] = '-';
            holds++;
            break;
          }
        }
      }
      if (holds < 2 && notes >= 5 && notes > minAttack) {
        for (s = SLOTS - 1; s >= 1; s--) {
          if (parseToken(slots[s]).type !== 'note') continue;
          if (s % 2 === 0) continue;
          var p3 = parseToken(slots[s - 1]);
          if (p3.type !== 'note' && p3.type !== 'hold') continue;
          slots[s] = '-';
          if (bar.tech && bar.tech[s]) delete bar.tech[s];
          holds++;
          break;
        }
      }
    }
    return bars;
  }

  /**
   * 本地规则作曲（不联网）：用作「本地试写」与 AI 失败兜底
   * @param {object} opts {grid, keyPc, scaleId, bars, styleId, bias, bpm, seed, preferFlat}
   */
  function composeLocal(opts) {
    opts = opts || {};
    var grid = opts.grid || null;
    var barsCount = opts.bars || (grid ? grid.bars : 4);
    var keyPc = opts.keyPc === undefined ? 0 : mod12(opts.keyPc);
    var scaleId = opts.scaleId || 'major';
    var style = styleById(opts.styleId || 'penta');
    var bias = clamp(opts.bias === undefined ? 40 : opts.bias, 0, 100);
    var range = noteRange(keyPc, opts.rangeBias === undefined ? 0.5 : opts.rangeBias);
    var rnd = rng(opts.seed === undefined ? (nowMs() & 0x7fffffff) : opts.seed);
    var bars = [], b, s;
    var phrasePattern = null;

    for (b = 0; b < barsCount; b++) {
      var chord = chordAtSlot(grid, b, 0);
      var cp = chordPcs(chord);
      var palette = stylePcs(keyPc, style.id);
      var strongAllow = cp.length ? cp : palette;
      var anyAllow = bias > 65 ? ALL_PCS : (cp.length ? mergePcs(cp, palette) : palette);
      /* 前两小节偏中低音区，后两小节抬到中高音区；音域 Bias 越大，
         这个“低—高呼应”的落差越明显，旋律才不会全挤在一个八度。 */
      var target = range.low + range.span * (b % 4 < 2 ? 0.20 : 0.80);

      var wantNotes = bias <= 20 ? 4 : (bias <= 65 ? 6 : 7);
      /* 每两小节共用同一个节奏动机，听起来更像“句子”，而不是每小节重新掷骰子 */
      if (b % 2 === 0 || !phrasePattern) {
        var pool = [];
        for (var pi = 0; pi < PATTERNS.length; pi++) {
          if (noteCount(PATTERNS[pi]) >= wantNotes) pool.push(PATTERNS[pi]);
        }
        if (!pool.length) pool = ['n0n0n0n0'];
        phrasePattern = pool[Math.floor(rnd() * pool.length)];
      }
      var pattern = phrasePattern;

      var slots = [], prev = null;
      for (s = 0; s < SLOTS; s++) {
        var ch = pattern.charAt(s);
        if (ch !== 'n') { slots.push(ch === '-' ? '-' : '0'); continue; }
        var strong = (s % 2 === 0);
        var allow = strong ? strongAllow : anyAllow;
        /* 高 Bias 时偶尔用半音经过音（不在风格音阶里的音） */
        if (bias > 65 && !strong && rnd() < 0.35) allow = ALL_PCS;
        var midi = pickPitch(prev, allow, cp, strong, bias, rnd, range, target);
        /* 乐句尾落在和弦音上 */
        if ((s >= 6 || s === SLOTS - 1) && cp.length && bias <= 65) {
          midi = pickPitch(prev, cp, cp, true, bias, rnd, range, target);
        }
        slots.push(tokenFromMidi(midi, keyPc, scaleId));
        prev = midi;
      }
      /* 孤儿延音：前面不是音的 “-” 换成休止 */
      for (s = 0; s < SLOTS; s++) {
        if (slots[s] === '-' && (s === 0 || parseToken(slots[s - 1]).type !== 'note')) slots[s] = '0';
      }
      var hasNote = false;
      for (s = 0; s < SLOTS; s++) if (parseToken(slots[s]).type === 'note') hasNote = true;
      if (!hasNote) {
        slots[0] = tokenFromMidi(Math.max(range.low, Math.min(range.high,
          60 + (cp.length ? cp[0] : 0))), keyPc, scaleId);
      }
      bars.push({ slots: slots, tech: {} });
    }

    addLegato(bars, { rnd: rnd, minAttack: 5 });
    addAutoTechs(bars, keyPc, scaleId, rnd);

    var score = normalizeScore({
      title: (M.keyName(keyPc, opts.preferFlat) + ' ' + M.scaleInfo(scaleId).label + ' · ' + style.zh + ' 即兴'),
      keyPc: keyPc,
      scaleId: scaleId,
      styleId: style.id,
      bias: bias,
      rangeBias: range.r,
      bpm: opts.bpm || 100,
      preferFlat: opts.preferFlat,
      bars: bars,
      progression: opts.progression || (grid ? grid.prog : null),
      progressionName: opts.progressionName || '',
      instanceName: opts.instanceName || '',
      progressText: opts.progressText || '',
      createdAt: nowMs(),
      source: 'local'
    }, { bars: barsCount });
    var repaired = repairScore(score, { grid: grid, bars: barsCount });
    return repaired.score;
  }

  /* ============================ 播放（Transport 引擎） ============================ */
  function barNotes(score, barIdx) {
    var out = [];
    var bar = score.bars[barIdx];
    if (!bar) return out;
    for (var s = 0; s < SLOTS; s++) {
      var t = parseToken(bar.slots[s]);
      if (t.type !== 'note') continue;
      var len = 1;
      while (s + len < SLOTS && parseToken(bar.slots[s + len]).type === 'hold') len++;
      out.push({
        slot: s,
        midi: midiOfToken(t, score.keyPc, score.scaleId),
        len: len,
        tech: (bar.tech && bar.tech[s]) || null,
        token: bar.slots[s]
      });
    }
    return out;
  }

  function scheduleBarNotes(ctx, out, score, barIdx, startTime, secPerBeat, tone, volume, busMix) {
    var notes = barNotes(score, barIdx);
    var bus = soloBusFor(ctx, out, busMix);
    var step = SLOT_BEATS * secPerBeat;
    var swing = (score.styleId === 'blues' || score.styleId === 'blue') ? 0.58 : 0.5;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var when = startTime + n.slot * step;
      /* 布鲁斯/蓝调把反拍往后推一点；再给极小的时值/力度抖动，
         避免每一格都像节拍器一样整齐 */
      if (n.slot % 2 === 1) when += Math.max(0, (2 * swing - 1) * step * 0.5);
      var seed = (barIdx * 131 + n.slot * 17 + n.midi * 7) % 97;
      when += ((seed / 97) - 0.5) * 0.012;
      var maxDur = (SLOTS - n.slot) * step * 0.95;
      var dur = Math.min(maxDur, Math.max(0.38, n.len * step * 1.5));
      var amp = volume * (n.slot % 4 === 0 ? 1.08 : 0.94) * (0.96 + (seed % 7) * 0.012);
      A.pluck(ctx, bus, when, n.midi, dur, amp, { tone: tone, tech: n.tech || 'none' });
      if (T && T.push && (!T.isRunning || T.isRunning())) {
        T.push({
          source: 'improv', time: when, bar: barIdx, slot: n.slot,
          midi: n.midi, token: n.token, tech: n.tech
        });
      }
    }
  }

  var engine = {
    nextTime: null,
    enabled: function () {
      if (!live.enabled || !live.score) return false;
      if (global.Band && global.Band.state.improvOn === false) return false;
      return true;
    },
    barSeconds: function (bpm) { return BAR_BEATS * 60 / bpm; },
    scheduleBar: function (ctx, out, startTime, bpm) {
      var score = live.score;
      if (!score || !score.bars.length) return;
      var barIdx = live.cursor % score.bars.length;
      scheduleBarNotes(ctx, out, score, barIdx, startTime, 60 / bpm, live.tone, 1, live.volume);
      live.cursor = (barIdx + 1) % score.bars.length;
    }
  };
  if (T) T.register(engine);

  function setScore(score) {
    state.score = score;
    live.score = score;
    live.cursor = 0;
  }

  function setTone(id) {
    state.tone = id || 'electric';
    live.tone = state.tone;
  }

  function setVolume(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 1.2;
    state.volume = clamp(n, 0, 2.2);
    live.volume = state.volume;
    var c = T && T.context ? T.context() : null;
    var mix = c && c.__improvSoloMix;
    if (mix) {
      try { mix.gain.value = live.volume; } catch (e) {}
    }
  }

  function setStyle(id) { state.styleId = styleById(id).id; }

  function setBias(v) { state.bias = clamp(Math.round(v), 0, 100); }

  function setEnabled(on) {
    live.enabled = !!on && !!live.score;
    engine.nextTime = null;
  }

  function play(withBacking) {
    if (!live.score) return false;
    live.cursor = 0;
    live.enabled = true;
    engine.nextTime = null;
    if (!global.Band) return false;
    if (!global.Band.state.improvOn) global.Band.setEnabled('improv', true);
    if (withBacking && !global.Band.state.backingOn) global.Band.setEnabled('backing', true);
    return global.Band.start();
  }

  function stop() {
    if (global.Band) global.Band.stop();
    else if (T) T.stop();
  }

  /**
   * 离线渲染（测试 / 试听导出用）
   * @returns {Promise<Float32Array>|null}
   */
  function renderOffline(score, opts, seconds) {
    opts = opts || {};
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) return null;
    var sr = opts.sampleRate || 22050;
    var bpm = opts.bpm || score.bpm || 100;
    var secPerBeat = 60 / bpm;
    var ctx = new OAC(1, Math.max(1, Math.floor(sr * seconds)), sr);
    var out = A.masterChain ? A.masterChain(ctx, 0.55) : ctx.createGain();
    if (!A.masterChain) out.connect(ctx.destination);
    var barLen = BAR_BEATS * secPerBeat;
    var loops = Math.ceil(seconds / barLen);
    for (var k = 0; k < loops; k++) {
      var barIdx = k % score.bars.length;
      scheduleBarNotes(ctx, out, score, barIdx, k * barLen, secPerBeat,
        opts.tone || 'acoustic', opts.volume === undefined ? 0.85 : opts.volume, 1);
    }
    return ctx.startRendering().then(function (buf) { return buf.getChannelData(0); });
  }

  /* ============================ 简谱 → 和弦 ============================ */
  function barNotePcs(score, barIdx) {
    var out = [], notePcs = {};
    var bar = score.bars[barIdx];
    for (var s = 0; s < SLOTS; s++) {
      var t = parseToken(bar.slots[s]);
      if (t.type !== 'note') continue;
      var pc = mod12(midiOfToken(t, score.keyPc, score.scaleId));
      var w = (s % 2 === 0) ? 1.6 : 1;
      if (s === 0 || s === 7) w += 1;
      out.push({ pc: pc, weight: w, slot: s });
      notePcs[pc] = true;
    }
    return { notes: out, pcs: notePcs, empty: out.length === 0 };
  }

  function candidateChords(score) {
    var out = [], seen = {}, d;
    var blues = score.styleId === 'blues' || score.styleId === 'blue';
    for (d = 1; d <= 7; d++) {
      var info = M.scaleChordQuality(score.keyPc, score.scaleId, d, false);
      var id = info.qualityId;
      var key = info.rootPc + ':' + id;
      if (!seen[key]) {
        seen[key] = true;
        out.push({ degree: d, quality: id, rootPc: info.rootPc });
      }
      if (blues && (d === 1 || d === 4 || d === 5)) {
        key = info.rootPc + ':7';
        if (!seen[key]) {
          seen[key] = true;
          out.push({ degree: d, quality: '7', rootPc: info.rootPc });
        }
      }
    }
    return out;
  }

  function suggestChords(score) {
    score = normalizeScore(score);
    var bars = [], items = [], prev = null;
    var cands = candidateChords(score);
    var preferFlat = score.preferFlat;

    for (var b = 0; b < score.bars.length; b++) {
      var np = barNotePcs(score, b);
      var best = null, bestScore = -1e9;
      for (var i = 0; i < cands.length; i++) {
        var cand = cands[i];
        var chord = B.chordAt(score.keyPc, score.scaleId, cand.degree, 0, cand.quality);
        var cp = chordPcs(chord);
        var sc = 0;
        for (var k = 0; k < np.notes.length; k++) {
          var n = np.notes[k];
          if (cp.indexOf(n.pc) >= 0) {
            sc += n.weight * (n.pc === chord.rootPc ? 1.25 : 1);
          } else {
            sc -= n.weight * 0.85;
          }
        }
        if (!np.pcs[chord.rootPc]) sc -= 1.3;
        if (prev) {
          if (prev.rootPc === chord.rootPc && prev.qualityId === cand.quality) sc += 1.5;
          if (mod12(prev.rootPc - chord.rootPc) === 5) sc += 0.5;  /* 下行五度 */
        }
        if (b === 0 && cand.degree === 1) sc += 0.4;
        if (b === score.bars.length - 1 && cand.degree === 1) sc += 0.9;
        if (cand.quality === 'dim') sc -= 0.9;
        if (np.empty) sc -= 2;
        if (sc > bestScore) { bestScore = sc; best = { cand: cand, chord: chord, score: sc, pcs: cp }; }
      }
      if (!best) {
        var fallback = B.chordAt(score.keyPc, score.scaleId, 1, 0, null);
        best = { cand: { degree: 1, quality: null, rootPc: fallback.rootPc }, chord: fallback, score: 0, pcs: chordPcs(fallback) };
      }
      var q = C.qualityById(best.cand.quality);
      var roman = M.romanNumeral(best.cand.degree, 0, q.triad, M.seventhFigure(q.id));
      var barNames = [];
      for (var z = 0; z < best.pcs.length; z++) barNames.push(M.noteName(best.pcs[z], preferFlat));
      bars.push({
        bar: b + 1,
        name: B.chordName(best.chord, preferFlat),
        roman: roman,
        notes: barNames.join(' '),
        degree: best.cand.degree,
        quality: best.cand.quality,
        score: Math.round(best.score * 10) / 10
      });
      items.push({ degree: best.cand.degree, acc: 0, quality: best.cand.quality, beats: 4 });
      prev = { rootPc: best.chord.rootPc, qualityId: best.cand.quality };
    }

    return {
      bars: bars,
      progression: {
        id: '',
        zh: '简谱配和弦',
        custom: true,
        tip: '根据简谱旋律的强拍与首尾音自动配的和弦',
        items: items
      }
    };
  }

  /* 把建议写成“当前走向”：存库 + 让伴奏引擎与界面立即用上 */
  function useProgression(prog) {
    if (!prog || !prog.items || !prog.items.length) return null;
    var p = B.cloneProgression(prog);
    p.id = randId('hprog');
    p.custom = true;
    p.zh = p.zh || '简谱配和弦';
    p.tip = p.tip || '由「根据简谱配和弦」生成';
    if (global.Store) global.Store.putItem('progression', p.id, p);
    if (global.BackingUI) {
      global.BackingUI.state.customProgs.push(p);
      global.BackingUI.selectProgression(p.id);
    }
    return p;
  }

  /* ============================ 旋律指型（整段固定） ============================ */
  /* 五种常用音阶指型按“低音 E 弦上的起始音”命名：
     Mi=E（C 调 3 级）、La=A（6 级）、Si=B（7 级）、Re=D（2 级）、Sol=G（5 级）。
     以前的实现每 2 小节重新选一次把位，旋律会在 1 级突然跳到 6 品；现在默认整段只用一个
     指型，用户也可以在页面上明确指定。 */
  var SHAPES = [
    { id: 'mi', zh: 'Mi', degree: 3, priority: 0 },
    { id: 'la', zh: 'La', degree: 6, priority: 0 },
    { id: 'si', zh: 'Si', degree: 7, priority: 2 },
    { id: 're', zh: 'Re', degree: 2, priority: 2 },
    { id: 'sol', zh: 'Sol', degree: 5, priority: 2 }
  ];

  function shapeWindow(keyPc, scaleId, shape) {
    var pc = M.degreeToPc(keyPc, scaleId, shape.degree, 0);
    var base = mod12(pc - C.TUNING[0]);
    /* Mi 的开放把位覆盖 0–6 品；其余指型保持 4 品宽，正好落在用户熟悉的
       “La 5–8 品 / Sol 3–6 品”这类窗口里。 */
    var size = shape.id === 'mi' ? (base === 0 ? 7 : 5) : 4;
    return { base: base, size: size, endFret: base + size - 1 };
  }

  function shapeOptions(keyPc, scaleId) {
    var out = [{ id: 'auto', zh: '自动', label: '自动（整段一个指型）',
                 base: null, size: null, endFret: null }];
    for (var i = 0; i < SHAPES.length; i++) {
      var w = shapeWindow(keyPc, scaleId, SHAPES[i]);
      out.push({
        id: SHAPES[i].id, zh: SHAPES[i].zh,
        label: SHAPES[i].zh + ' 型（' + w.base + '–' + w.endFret + ' 品）',
        base: w.base, size: w.size, endFret: w.endFret
      });
    }
    return out;
  }

  function positionsInWindow(midi, base, size) {
    var out = [];
    for (var s = 0; s < 6; s++) {
      var f = midi - C.TUNING[s];
      if (f >= 0 && f >= base && f < base + size) out.push({ s: s, f: f });
    }
    return out;
  }

  function nearestPosition(midi, base, size) {
    var best = null, bestD = 1e9;
    for (var s = 0; s < 6; s++) {
      var f = midi - C.TUNING[s];
      if (f < 0 || f > 15) continue;
      var d = f < base ? (base - f) : (f >= base + size ? f - (base + size - 1) : 0);
      if (d < bestD) { bestD = d; best = { s: s, f: f, outside: d > 0 }; }
    }
    return best;
  }

  function windowMidiBounds(base, size) {
    var min = 1e9, max = -1;
    for (var s = 0; s < 6; s++) {
      min = Math.min(min, C.TUNING[s] + base);
      max = Math.max(max, C.TUNING[s] + base + size - 1);
    }
    return { min: min, max: max };
  }

  function phraseNotes(score, start, end) {
    var out = [];
    for (var b = start; b < end && b < score.bars.length; b++) {
      for (var s = 0; s < SLOTS; s++) {
        var t = parseToken(score.bars[b].slots[s]);
        if (t.type !== 'note') continue;
        out.push({ bar: b, slot: s, midi: midiOfToken(t, score.keyPc, score.scaleId) });
      }
    }
    return out;
  }

  function chooseShapeForAll(notes, keyPc, scaleId, shapeId) {
    var options = shapeOptions(keyPc, scaleId), i, k;
    if (shapeId && shapeId !== 'auto') {
      for (i = 0; i < options.length; i++) {
        if (options[i].id === shapeId) return options[i];
      }
    }
    var best = null;
    for (i = 1; i < options.length; i++) {
      var opt = options[i], covered = 0, outside = 0, penalty = 0;
      for (k = 0; k < notes.length; k++) {
        var pos = positionsInWindow(notes[k].midi, opt.base, opt.size);
        if (pos.length) {
          covered++;
          var minF = 99;
          for (var p = 0; p < pos.length; p++) minF = Math.min(minF, pos[p].f);
          penalty += Math.abs(minF - (opt.base + opt.size / 2)) * 0.12;
        } else {
          outside++;
          penalty += 80;
        }
      }
      var shape = SHAPES[i - 1];
      var val = covered * 100 - penalty + (shape.priority === 0 ? 30 : 0) - opt.base * 0.08;
      if (!best || val > best.val) {
        best = { option: opt, val: val, covered: covered, outside: outside };
      }
    }
    return best ? best.option : options[1];
  }

  function shapeSuggestions(midi, keyPc, scaleId, currentId) {
    var options = shapeOptions(keyPc, scaleId), out = [];
    for (var i = 1; i < options.length; i++) {
      var opt = options[i];
      if (opt.id === currentId) continue;
      if (positionsInWindow(midi, opt.base, opt.size).length) {
        out.push(opt.zh + ' 型（' + opt.base + '–' + opt.endFret + ' 品）');
      }
    }
    return out;
  }

  /**
   * 把简谱安排到吉他指板上：整段固定一个指型（默认自动选覆盖最多的），
   * 音符在窗口里找弦和品；放不下的音会记录 warning，提示用户换指型，
   * 不再自动跳到别的把位。
   */
  function fingeringPlan(input, opts) {
    opts = opts || {};
    var score = normalizeScore(input);
    var shapeId = opts.shapeId || 'auto';
    var total = score.bars.length;
    var notes = phraseNotes(score, 0, total);
    var chosen = chooseShapeForAll(notes, score.keyPc, score.scaleId, shapeId);
    var map = {}, prev = null, outside = 0, warnings = [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      var cands = positionsInWindow(n.midi, chosen.base, chosen.size);
      var pick = null;
      if (cands.length) {
        var bestScore = 1e9;
        for (var c = 0; c < cands.length; c++) {
          var p = cands[c];
          var prevF = prev ? prev.f : (chosen.base + Math.floor(chosen.size / 2));
          var sc = Math.abs(p.f - prevF) + (prev && prev.s === p.s ? 0 : 1.2) +
            Math.abs(p.f - (chosen.base + chosen.size / 2)) * 0.2 + p.s * 0.25;
          if (sc < bestScore) { bestScore = sc; pick = p; }
        }
      } else {
        pick = nearestPosition(n.midi, chosen.base, chosen.size);
        outside++;
        var bounds = windowMidiBounds(chosen.base, chosen.size);
        var noteName = M.noteName(mod12(n.midi), score.preferFlat) +
          (Math.floor(n.midi / 12) - 1);
        warnings.push({
          bar: n.bar, slot: n.slot, midi: n.midi, name: noteName,
          tooLow: n.midi < bounds.min,
          suggestions: shapeSuggestions(n.midi, score.keyPc, score.scaleId, chosen.id)
        });
      }
      if (!pick) continue;
      map[n.bar + ':' + n.slot] = {
        string: pick.s, fret: pick.f, midi: n.midi,
        outside: !!pick.outside, bar: n.bar, slot: n.slot
      };
      prev = pick;
    }
    var plan = {
      score: score, shapeId: chosen.id, shape: chosen.zh,
      base: chosen.base, size: chosen.size, endFret: chosen.endFret,
      warnings: warnings, used: [], usedPcs: {}, phrases: []
    };
    plan.phrases.push({
      start: 0, end: total,
      shapeId: chosen.id, shape: chosen.zh,
      base: chosen.base, size: chosen.size, endFret: chosen.endFret,
      map: map, outside: outside, warnings: warnings
    });
    /* 用到的音（按首次出现排序），用于指板下方的图例 */
    for (var b = 0; b < total; b++) {
      for (var s = 0; s < SLOTS; s++) {
        var t = parseToken(score.bars[b].slots[s]);
        if (t.type !== 'note') continue;
        var pc = mod12(midiOfToken(t, score.keyPc, score.scaleId));
        if (!plan.usedPcs[pc]) {
          plan.usedPcs[pc] = true;
          plan.used.push(M.noteName(pc, score.preferFlat));
        }
      }
    }
    return plan;
  }

  function phraseForBar(plan, bar) {
    if (!plan || !plan.phrases.length) return null;
    for (var i = 0; i < plan.phrases.length; i++) {
      if (bar >= plan.phrases[i].start && bar < plan.phrases[i].end) return plan.phrases[i];
    }
    return plan.phrases[plan.phrases.length - 1];
  }

  /* ============================ 简谱 → 六线谱 ============================ */
  function tabCell(fret) {
    var s = String(fret);
    if (s.length >= 3) return s.slice(0, 3);
    var left = Math.floor((3 - s.length) / 2);
    var right = 3 - s.length - left;
    return repeat('-', left) + s + repeat('-', right);
  }

  function scoreToTab(score) {
    score = normalizeScore(score);
    var labels = ['e', 'B', 'G', 'D', 'A', 'E'];
    var lines = ['', '', '', '', '', ''];
    var prev = null;
    var title = score.title + '（' + M.keyName(score.keyPc, score.preferFlat) + ' ' +
      M.scaleInfo(score.scaleId).label + '）';

    for (var b = 0; b < score.bars.length; b++) {
      var bar = score.bars[b];
      for (var s = 0; s < SLOTS; s++) {
        var t = parseToken(bar.slots[s]);
        /* 延音格在六线谱上留空，不重复按弦 */
        var fret = null, stringIdx = -1;
        if (t.type === 'note') {
          var midi = midiOfToken(t, score.keyPc, score.scaleId);
          var bestScore = 1e9;
          var prevFret = (prev && prev.fret !== null && prev.fret !== undefined) ? prev.fret : 5;
          for (var si = 0; si < 6; si++) {
            var f = midi - C.TUNING[si];
            if (f < 0 || f > 15) continue;
            var sc = Math.abs(f - prevFret) + (prev && prev.stringIdx === si ? 0 : 0.8) + f * 0.05;
            if (sc < bestScore) { bestScore = sc; fret = f; stringIdx = si; }
          }
          if (fret === null) {
            /* 超出 15 品：尽量放到 1 弦高把位（六线谱里允许写 16+） */
            for (si = 0; si < 6; si++) {
              f = midi - C.TUNING[si];
              if (f >= 0 && f <= 24) { fret = f; stringIdx = si; break; }
            }
          }
          prev = { fret: fret, stringIdx: stringIdx };
        }
        for (var line = 0; line < 6; line++) {
          if (line === stringIdx) lines[line] += tabCell(fret);
          else lines[line] += '---';
        }
      }
      for (line = 0; line < 6; line++) lines[line] += '|';
    }

    var out = [title];
    for (var i = 0; i < 6; i++) out.push(labels[i] + '|' + lines[i]);
    out.push('（简谱→六线谱：按最近把位分配弦与品；延音格留空）');
    return out.join('\n');
  }

  /* ============================ 文本导入 / 识别结果转换 ============================ */
  function isChordLabel(seg) {
    if (!seg) return false;
    if (parseToken(seg).type === 'note') return false;
    if (seg === '0' || seg === '-') return false;
    /* C / Am / G7 / F#m7 / Bb 这种短记号 */
    return /^[A-Ga-g][#b]?(m|maj|min|dim|aug|sus|add|°|ø|\d|\/)*$/.test(seg);
  }

  function parseTextScore(text, opts) {
    opts = opts || {};
    var title = '文本导入的简谱';
    var keyPc = opts.keyPc === undefined ? 0 : opts.keyPc;
    var scaleId = opts.scaleId || 'major';
    var bpm = opts.bpm || 100;
    var bars = [], barChords = [];
    var lines = String(text || '').split(/\r?\n/);

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (!line) continue;
      var m;
      if ((m = /^title\s*[=:]\s*(.+)$/i.exec(line))) { title = m[1].replace(/^\s+|\s+$/g, ''); continue; }
      if ((m = /^key\s*[=:]\s*(.+)$/i.exec(line))) {
        var kp = parseKeyName(m[1]);
        if (kp >= 0) keyPc = kp;
        continue;
      }
      if ((m = /^mode\s*[=:]\s*(.+)$/i.exec(line))) {
        var sc = scaleIdFromName(m[1]);
        if (sc) scaleId = sc;
        continue;
      }
      if ((m = /^bpm\s*[=:]\s*(.+)$/i.exec(line))) {
        var bp = Number(m[1]);
        if (isFinite(bp)) bpm = bp;
        continue;
      }
      if (line.charAt(0) === '#') { title = line.replace(/^#+\s*/, ''); continue; }

      var chordLabel = '';
      var tokenPart = line;
      if (line.indexOf('|') >= 0) {
        var segs = line.split('|');
        var clean = [];
        for (var q = 0; q < segs.length; q++) {
          var seg = segs[q].replace(/^\s+|\s+$/g, '');
          if (seg) clean.push(seg);
        }
        if (clean.length >= 2 && isChordLabel(clean[0])) {
          chordLabel = clean[0];
          clean.shift();
        }
        tokenPart = clean.join(' ');
      }
      var tokens = tokenPart.split(/[\s,]+/);
      var out = [];
      for (var t = 0; t < tokens.length; t++) {
        if (tokens[t]) out.push(normalizeToken(tokens[t]));
      }
      if (!out.length) continue;
      bars.push({ slots: out, tech: {} });
      barChords.push(chordLabel);
    }

    var score = normalizeScore({
      title: title,
      keyPc: keyPc,
      scaleId: scaleId,
      styleId: opts.styleId || 'penta',
      bias: opts.bias === undefined ? 40 : opts.bias,
      bpm: bpm,
      preferFlat: opts.preferFlat,
      bars: bars,
      barChords: barChords.length ? barChords : null,
      progression: opts.progression || null,
      source: 'text'
    }, { bars: Math.max(1, bars.length) });
    return repairScore(score, { grid: opts.grid || null, bars: score.bars.length }).score;
  }

  function scoreFromRecognition(data, opts) {
    opts = opts || {};
    var keyPc = parseKeyName(data && data.key);
    if (keyPc < 0) keyPc = opts.keyPc === undefined ? 0 : opts.keyPc;
    var scaleId = scaleIdFromName(data && (data.mode || data.scale)) || opts.scaleId || 'major';
    var bars = [], barChords = [];
    var rawBars = (data && (data.bars || data.measures)) || [];
    for (var i = 0; i < rawBars.length; i++) {
      var rb = rawBars[i] || {};
      var slots = rb.slots || rb.notes || rb.tokens || [];
      if (typeof slots === 'string') slots = slots.split(/[\s,|]+/);
      var chordRaw = rb.chord || rb.chords;
      if (chordRaw && chordRaw.length) {
        barChords.push((chordRaw.length !== undefined && typeof chordRaw !== 'string')
          ? chordRaw.join(' / ') : String(chordRaw));
      } else {
        barChords.push('');
      }
      bars.push({ slots: slots, tech: rb.tech || {} });
    }
    var score = normalizeScore({
      title: (data && data.title) || '图片识别的简谱',
      keyPc: keyPc,
      scaleId: scaleId,
      styleId: opts.styleId || 'penta',
      bias: opts.bias === undefined ? 40 : opts.bias,
      bpm: (data && data.bpm) || opts.bpm || 100,
      preferFlat: opts.preferFlat,
      bars: bars,
      barChords: barChords.length ? barChords : null,
      progression: opts.progression || null,
      source: 'image'
    }, { bars: Math.max(1, bars.length) });
    return repairScore(score, { grid: opts.grid || null, bars: score.bars.length }).score;
  }

  /* ============================ 大模型 agent 流水线 ============================ */
  function extractJson(text) {
    if (!text) return null;
    var s = String(text).replace(/^\uFEFF/, '').replace(/^\s+|\s+$/g, '');
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
    var first = s.indexOf('{'), last = s.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    var body = s.slice(first, last + 1);
    try { return JSON.parse(body); } catch (e) {}
    /* 有些模型会在 JSON 里写尾随逗号或中文引号 */
    var fixed = body.replace(/[\u201c\u201d]/g, '"').replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(fixed); } catch (e2) { return null; }
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error(label + ' 超时（' + Math.round(ms / 1000) + ' 秒）'));
      }, ms);
      promise.then(function (v) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  function callJson(messages, maxTokens) {
    if (!global.LLM) return Promise.reject(new Error('缺少 llm.js'));
    if (!global.LLM.ready()) return Promise.reject(new Error('还没有配置 AI 接口（厂商 / 地址 / 模型 / Key）'));
    var p = global.LLM.chat(messages, { json: true, temperature: 0.75, maxTokens: maxTokens || 1600 })
      .then(function (r) {
        if (!r.ok) {
          var e = new Error(r.error || '请求失败');
          e.http = true;
          throw e;
        }
        var data = extractJson(r.content);
        if (!data) {
          var ep = new Error('模型没有返回可解析的 JSON');
          ep.parse = true;
          ep.raw = String(r.content || '').slice(0, 160);
          throw ep;
        }
        return { data: data, usage: r.usage || null, ms: r.ms || 0, model: r.model || '' };
      });
    return withTimeout(p, 125000, '模型请求');
  }

  function callAgent(messages, maxTokens) {
    return callJson(messages, maxTokens).catch(function (e) {
      if (!e.parse) throw e;
      var retry = messages.concat([
        { role: 'user', content: '你上一次的输出无法解析为 JSON（' + e.message + '）。请重新输出，只给一个合法的 JSON 对象，不要 markdown。' }
      ]);
      return callJson(retry, maxTokens);
    });
  }

  function callJsonStream(messages, maxTokens, onEvent) {
    if (!global.LLM || !global.LLM.streamChat) {
      return Promise.reject(new Error('当前环境不支持流式'));
    }
    if (!global.LLM.ready()) return Promise.reject(new Error('还没有配置 AI 接口（厂商 / 地址 / 模型 / Key）'));
    return global.LLM.streamChat(
      messages,
      { json: true, temperature: 0.75, maxTokens: maxTokens || 1600 },
      onEvent
    ).then(function (r) {
      if (!r.ok) {
        var e = new Error(r.error || '请求失败');
        e.http = true;
        throw e;
      }
      var data = extractJson(r.content);
      if (!data) {
        var ep = new Error('模型没有返回可解析的 JSON');
        ep.parse = true;
        ep.raw = String(r.content || '').slice(0, 160);
        throw ep;
      }
      return {
        data: data, usage: r.usage || null, ms: r.ms || 0,
        model: r.model || '', reasoning: r.reasoning || ''
      };
    });
  }

  function callAgentStream(messages, maxTokens, onEvent) {
    return callJsonStream(messages, maxTokens, onEvent).catch(function (e) {
      if (!e.parse) throw e;
      var retry = messages.concat([
        { role: 'user', content: '你上一次的输出无法解析为 JSON（' + e.message + '）。请重新输出，只给一个合法的 JSON 对象，不要 markdown。' }
      ]);
      return callJsonStream(retry, maxTokens, onEvent);
    });
  }

  var SYSTEM_PROMPT = [
    '你是资深的吉他手与编曲，擅长把和弦走向写成有动机、有呼吸、可以真的弹出来的即兴 solo。',
    '你只输出一个 JSON 对象，不要输出 markdown 代码块、不要解释、不要注释。',
    '简谱格子记号：0=休止，-=延音（延长前一个音），音符=b3 / #4 / 5 这种“变音+级数”，',
    "高八度在数字后加 '，低八度在数字后加 ,；每小节固定 8 个八分音符格。",
    '旋律要适合吉他演奏：音域按上下文给出的范围；不要从头到尾都在同一个八度，' +
    '用低八度/高八度做呼应；多用级进，少用大跳；强拍落在和弦音上。',
    '不要写成连续音阶练习：要有 2 小节的动机、重复与变化、句尾呼吸，以及至少 1/4 的休止或延音。'
  ].join('\n');

  function barChordInfoText(opts) {
    var out = [];
    var grid = opts.grid;
    for (var b = 0; b < opts.bars; b++) {
      var names = [];
      for (var s = 0; s < SLOTS; s += 2) {
        var ch = chordAtSlot(grid, b, s);
        if (!ch) continue;
        var nm = B.chordName(ch, opts.preferFlat);
        if (names.indexOf(nm) < 0) names.push(nm);
        if (names.length >= 2) break;
      }
      var ch0 = chordAtSlot(grid, b, 0);
      var pcs = chordPcs(ch0);
      var pcNames = [];
      for (var i = 0; i < pcs.length; i++) pcNames.push(M.noteName(pcs[i], opts.preferFlat));
      out.push('第 ' + (b + 1) + ' 小节：' + (names.length ? names.join(' / ') : '（无和弦）') +
        '；和弦音 ' + (pcNames.length ? pcNames.join(' ') : '自由'));
      if (out.length >= 24) break;
    }
    return out.join('\n');
  }

  function contextText(opts) {
    var keyName = M.keyName(opts.keyPc, opts.preferFlat);
    var info = M.scaleInfo(opts.scaleId);
    var style = styleById(opts.styleId);
    var scaleDegs = [];
    for (var i = 0; i < info.steps.length; i++) {
      var acc = info.steps[i] - M.MAJOR_STEPS[i];
      scaleDegs.push((acc === 0 ? '' : (acc < 0 ? 'b' : '#')) + (i + 1));
    }
    var lines = [];
    lines.push('主调：' + keyName + ' ' + info.label + '（' + (info.en || '') + '），音阶级数：' + scaleDegs.join(' '));
    lines.push('速度：' + opts.bpm + ' BPM，4/4 拍；共 ' + opts.bars + ' 小节，每小节 8 个八分音符格。');
    lines.push('风格：' + style.zh + '（' + style.en + '），' + style.feel + '；Bias=' + opts.bias + '/100。');
    lines.push('Bias 规则：≤20 只用和弦音；21–65 强拍和弦音、弱拍可加风格音阶；>65 可用半音经过音。');
    var rg = noteRange(opts.keyPc, opts.rangeBias === undefined ? 0.5 : opts.rangeBias);
    lines.push('音域：' + midiName(rg.low, opts.preferFlat) + '–' +
      midiName(rg.high, opts.preferFlat) + '（音域 Bias ' + rg.r.toFixed(2) +
      '：0 约一个八度，1 约两个八度；请在低/高两个音区做呼应，不要整段只用一个八度）。');
    lines.push('和弦走向（按小节）：');
    lines.push(barChordInfoText(opts));
    if (opts.progressText) lines.push('走向说明：' + opts.progressText);
    if (opts.prompt) lines.push('用户场景/情绪提示（优先遵循）：' + opts.prompt);
    return lines.join('\n');
  }

  function plannerMessages(opts) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: '先做一次即兴规划（不写具体音符）。\n' + contextText(opts) +
          '\n\n要求：前 2 小节建立一个短动机（3–5 个音），后面用重复/模进/变化来发展；' +
          '至少安排两个“呼吸点”（休止），句尾落在和弦音；并规划一次低八度或高八度的呼应，' +
          '不要让整段都停在同一个八度。' +
          '\n\n请输出 JSON：' +
          '{"structure":"整段怎么起承转合","motif":"2 小节动机（节奏 + 音区 + 轮廓）",' +
          '"phrases":[{"bars":"1-2","role":"call"},{"bars":"3-4","role":"response"}],' +
          '"density":"每小节大约几个音","contour":"旋律走向",' +
          '"barTargets":[{"bar":1,"idea":"这一小节落在哪个和弦音 / 怎么发展"}]}'
      }
    ];
  }

  function fillerMessages(opts, plan) {
    var demoSlots = [
      ['5', '0', '3', '-', '5', '3', '0', '5'],
      ['5', '-', '3', '0', '2', '3', '5', '0'],
      ['6', '0', '5', '3', '-', '5', '3', '0'],
      ['4', '-', '3', '2', '0', '1', '-', '0']
    ];
    var exampleBars = [];
    var maxExample = Math.min(opts.bars, 4);
    for (var i = 0; i < maxExample; i++) {
      exampleBars.push('{"slots":[' + (function () {
        var arr = [];
        for (var k = 0; k < 8; k++) arr.push('"' + demoSlots[i % 4][k] + '"');
        return arr.join(',');
      })() + ']}');
    }
    var planText = '';
    try { planText = JSON.stringify(plan).slice(0, 1200); } catch (e) { planText = ''; }
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: contextText(opts) +
          (planText ? '\n\n主控 agent 的结构规划（参考，不必逐字照做）：\n' + planText : '') +
          '\n\n现在逐格写出完整简谱。要求：' +
          '\n1. 必须正好 ' + opts.bars + ' 个小节，每小节正好 8 个字符串；' +
          '\n2. 每个格子只能是 0、- 或一个音符；' +
          '\n3. 第 1、5 格（每小节第 1、3 拍）必须落在当前和弦的和弦音上；' +
          '\n4. 前 2 小节先建立一个 3–5 个音的动机；第 3 小节起要重复它、模进它，或做“回应”，' +
          '不要每小节都换一个新想法；至少一个回应句比动机高八度或低八度，形成音区呼应；' +
          '\n5. 每小节 5–6 个音（Bias 高也不要超过 7 个），但**至少要有 2 个延音 `-`**：' +
          '让长音跨过拍点，一个音可以连续占 2–3 格；可以用三四个连续八分音符，' +
          '但不要每拍都换音，也不要连续 6 个以上的级进跑句；不要连续 3 个相同的音；' +
          '\n6. 句尾落在和弦音，整段最后落在主音或三音；不要写技巧标记（下一个 agent 负责）。' +
          '\n\n示例只学“动机 + 呼吸 + 和弦落点”，不要照抄音高（示例每小节 8 格）：\n' +
          demoSlots.slice(0, maxExample).map(function (x) { return x.join(' '); }).join('\n') +
          '\n\n严格按这个结构输出 JSON（示例只展示前几小节，实际要写 ' + opts.bars + ' 小节）：' +
          '{"thinking":"先用一两句话说明这几小节怎么发展（会实时显示给用户）",' +
          '"bars":[' + exampleBars.join(',') + ']}'
      }
    ];
  }

  function transitionMessages(opts, score) {
    var compact = [];
    for (var b = 0; b < score.bars.length; b++) {
      var names = barChordNames(score, b, opts.grid);
      compact.push('第 ' + (b + 1) + ' 小节 [' + (names.join('/') || '自由') + ']：' +
        score.bars[b].slots.join(' '));
    }
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: '下面是一段已经写好的即兴简谱。请只在“小节之间”设计吉他衔接技巧，' +
          '让下一小节的开头更顺。\n\n' + compact.join('\n') +
          '\n\n可用技巧：slide（滑音）、bend（推弦）、hammer（击弦）、pull（勾弦）、vib（揉弦）。' +
          '\n规则：优先标在下一小节第 1 格；也可以标在小节内相邻音之间（目标前一格必须是实际音符）。' +
          '**上一小节最后一格必须是实际音符（不是 0 或 -）**，否则不要提滑音/推弦/击弦/勾弦；' +
          '滑音/推弦/击勾弦都可以用来做连奏；每小节最多 2 个；不要每个音都加，宁缺毋滥。' +
          '\n\n输出 JSON（bar 和 slot 都从 1 开始计数）：' +
          '{"transitions":[{"bar":2,"slot":1,"tech":"slide","reason":"上一小节末音接下一小节首音"}]}'
      }
    ];
  }

  function polishMessages(opts, score) {
    var compact = [];
    for (var b = 0; b < score.bars.length; b++) {
      var names = barChordNames(score, b, opts.grid);
      var techs = [];
      var tech = score.bars[b].tech || {};
      for (var k in tech) {
        if (tech.hasOwnProperty(k)) techs.push((TECH_ZH[tech[k]] || tech[k]) + '@' + (Number(k) + 1));
      }
      compact.push('第 ' + (b + 1) + ' 小节 [' + (names.join('/') || '自由') + ']：' +
        score.bars[b].slots.join(' ') + (techs.length ? '  技巧：' + techs.join(' ') : ''));
    }
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: contextText(opts) +
          '\n\n这是填音 agent 的初稿：\n' + compact.join('\n') +
          '\n\n你是评审兼润色。不要整段推翻，只做必要的修改，让这段 solo 更像人弹的：' +
          '\n1. 正好 ' + opts.bars + ' 小节、每小节 8 个字符串；' +
          '\n2. 保留/强化前 2 小节的动机：后面用重复、模进或“回应”，不要每小节都是新句子；' +
          '\n3. 每小节 5–6 个音，**至少 2 个延音 `-`**，让一个音跨过拍点持续 2–3 格；' +
          '句尾要呼吸，但不要每格都换音；可以保留三四个连续八分音符/短连音；' +
          '不要连续 3 个相同音，不要连续 6 个以上的级进跑句，少用超过 5 度的大跳；如果全曲都挤在一个八度里，' +
          '把其中一个回应句整体移高或移低八度，形成音区呼应；' +
          '\n4. 第 1、5 格必须是当前和弦音；句尾优先落在和弦音/主音；' +
          '\n5. 保持同样的风格与 Bias，不要改调、不要增加新的半音（Bias≤65 时）；' +
          '\n6. 技巧标在小节交界或小节内相邻音上，最多 2 个/小节，宁缺毋滥。' +
          '\n\n输出 JSON：' +
          '{"thinking":"先说明你检查了哪些问题（会实时显示给用户）",' +
          '"review":"一句话说明改了什么",' +
          '"bars":[{"slots":["5","0","3","-","5","3","0","5"]}],' +
          '"transitions":[{"bar":2,"slot":1,"tech":"slide"}]}'
      }
    ];
  }

  /* 滑音/推弦/击勾弦都需要前一个音真的被拨响；如果前一格是延音或休止，
     手指并没有一个新的起音，强行标技巧会变成“滑不到”的假动作。 */
  function hasPreviousAttack(score, bar, slot) {
    if (slot > 0) return parseToken(score.bars[bar].slots[slot - 1]).type === 'note';
    if (bar > 0) return parseToken(score.bars[bar - 1].slots[SLOTS - 1]).type === 'note';
    return false;
  }

  function needsPreviousAttack(tech) {
    return tech === 'slide' || tech === 'bend' || tech === 'hammer' || tech === 'pull';
  }

  function applyTransitions(score, data) {
    var list = (data && (data.transitions || data.techs)) || [];
    if (!list.length) return [];
    var zeroBased = false;
    var i;
    for (i = 0; i < list.length; i++) if (Number(list[i].bar) === 0) zeroBased = true;
    var perBar = {}, applied = [];
    for (i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var bar = Number(it.bar) - (zeroBased ? 0 : 1);
      var slot = Number(it.slot !== undefined ? it.slot : it.index) - (zeroBased ? 0 : 1);
      var tech = techById(it.tech || it.type);
      if (bar < 0 || bar >= score.bars.length || slot < 0 || slot >= SLOTS) continue;
      if (!tech) continue;
      if (parseToken(score.bars[bar].slots[slot]).type !== 'note') continue;
      if (perBar[bar] === undefined) perBar[bar] = 0;
      if (perBar[bar] >= 2) continue;
      if (needsPreviousAttack(tech) && !hasPreviousAttack(score, bar, slot)) continue;
      if (!score.bars[bar].tech) score.bars[bar].tech = {};
      score.bars[bar].tech[slot] = tech;
      perBar[bar]++;
      applied.push({ bar: bar + 1, slot: slot + 1, tech: tech });
      if (applied.length >= 6) break;
    }
    return applied;
  }

  /**
   * 运行多 agent 流水线
   * @param {object} opts {grid, keyPc, scaleId, bars, bpm, styleId, bias, preferFlat, progression, progressText, title}
   * @param {function} onStep ({index, name, status, detail, ms}) => void
   * @returns {Promise<{ok:boolean, score:object, steps:Array, calls:number, error?:string}>}
   */
  function runAgents(opts, onStep, onStream) {
    var steps = [];
    var totalCalls = 0;
    var hook = onStep || function () {};
    var streamHook = onStream || opts.onStream || null;
    opts._usage = 0;

    function emit(i, name, status, detail, ms) {
      var step = { index: i, name: name, status: status, detail: detail || '', ms: ms || 0 };
      steps[i] = step;
      hook(step);
    }
    function runStep(i, name, fn) {
      emit(i, name, 'running', '');
      var t0 = nowMs();
      /* 这一步可能是同步的（本地校验器），统一包成 Promise */
      return Promise.resolve().then(fn).then(function (r) {
        emit(i, name, 'ok', (r && r.detail) || '', nowMs() - t0);
        return r;
      }, function (e) {
        emit(i, name, 'fail', e.message || String(e), nowMs() - t0);
        throw e;
      });
    }

    if (!global.LLM || !global.LLM.ready()) {
      emit(0, '主控 Agent', 'fail', '还没有配置 AI 接口', 0);
      return Promise.reject(new Error('还没有配置 AI 接口（先在下面填写厂商 / 模型 / API Key）'));
    }

    var plan = null;
    var score = null;
    var useStream = opts.stream === true && !!global.LLM.streamChat;

    function streamEvent(agent, ev) {
      if (!streamHook || !ev) return;
      try {
        streamHook({ agent: agent, type: ev.type || 'content', text: ev.text || '' });
      } catch (e) {}
    }

    function agentCall(messages, maxTokens, label) {
      if (!useStream) return callAgent(messages, maxTokens);
      return callAgentStream(messages, maxTokens, function (ev) {
        streamEvent(label, ev);
      }).catch(function (e) {
        streamEvent(label, { type: 'info', text: '流式失败，回退整段请求：' + (e.message || e) });
        return callAgent(messages, maxTokens);
      });
    }

    /* 主控 Agent 失败不致命：没有结构规划也能直接填音 */
    emit(0, '主控 Agent · 结构规划', 'running', '');
    var t0 = nowMs();
    var step0 = agentCall(plannerMessages(opts), 900, '主控').then(function (r) {
      plan = r.data;
      totalCalls++;
      opts._usage = (opts._usage || 0) + ((r.usage && r.usage.total_tokens) || 0);
      var structure = plan && (plan.structure || plan.contour || '已完成结构规划');
      emit(0, '主控 Agent · 结构规划', 'ok', String(structure).slice(0, 90), nowMs() - t0);
    }, function (e) {
      plan = { structure: '（结构规划失败，直接按和弦与动机写）' };
      emit(0, '主控 Agent · 结构规划', 'warn',
        '规划失败，继续填音：' + (e.message || e), nowMs() - t0);
    });

    return step0.then(function () {
      return runStep(1, '填音 Agent · 每格 休止/音符/延音', function () {
        return agentCall(fillerMessages(opts, plan), 2600, '填音').then(function (r) {
          totalCalls++;
          opts._usage = (opts._usage || 0) + ((r.usage && r.usage.total_tokens) || 0);
          var raw = r.data && (r.data.bars || r.data.measures);
          if (!raw || !raw.length) throw new Error('模型返回的 bars 是空的');
          score = normalizeScore({
            title: opts.title || (M.keyName(opts.keyPc, opts.preferFlat) + ' ' +
              M.scaleInfo(opts.scaleId).label + ' · ' + styleById(opts.styleId).zh + ' 即兴'),
            keyPc: opts.keyPc,
            scaleId: opts.scaleId,
            styleId: opts.styleId,
            bias: opts.bias,
            rangeBias: opts.rangeBias,
            bpm: opts.bpm,
            preferFlat: opts.preferFlat,
            bars: raw,
            progression: opts.progression,
            progressionName: opts.progressionName || '',
            instanceName: opts.instanceName || '',
            progressText: opts.progressText || '',
            source: 'ai',
            createdAt: nowMs()
          }, { bars: opts.bars });
          return { detail: raw.length + ' 小节，共 ' + scoreStats(score).notes + ' 个音' };
        });
      });
    }).then(function () {
      /* 衔接 Agent：失败不算致命，本地启发式补技巧 */
      emit(2, '衔接 Agent · 小节之间的技巧', 'running', '');
      var ts = nowMs();
      return agentCall(transitionMessages(opts, score), 900, '衔接').then(function (r) {
        totalCalls++;
        opts._usage = (opts._usage || 0) + ((r.usage && r.usage.total_tokens) || 0);
        var applied = applyTransitions(score, r.data);
        /* 模型只给了交界技巧时，再补一点小节内的连奏；已标过的位置不会被覆盖。 */
        addAutoTechs(score.bars, score.keyPc, score.scaleId, rng(nowMs() & 0x7fffffff));
        var detail;
        if (!applied.length) {
          detail = '模型没有给出可用位置，已用本地启发式补 ' + scoreStats(score).techs + ' 个';
        } else {
          var picks = [];
          for (var i = 0; i < applied.length && picks.length < 3; i++) {
            picks.push('第' + applied[i].bar + '小节 ' + (TECH_ZH[applied[i].tech] || applied[i].tech));
          }
          detail = applied.length + ' 处（' + picks.join('、') + '）';
        }
        emit(2, '衔接 Agent · 小节之间的技巧', 'ok', detail, nowMs() - ts);
      }, function (e) {
        addAutoTechs(score.bars, score.keyPc, score.scaleId, rng(nowMs() & 0x7fffffff));
        emit(2, '衔接 Agent · 小节之间的技巧', 'warn',
          '失败，已用本地技巧兜底：' + (e.message || e), nowMs() - ts);
      });
    }).then(function () {
      /* 润色 Agent：让模型自己按“动机/呼吸/句尾”再审一遍；失败就保留初稿 */
      emit(3, '润色 Agent · 评审并重写', 'running', '');
      var tp = nowMs();
      return agentCall(polishMessages(opts, score), 2600, '润色').then(function (r) {
        totalCalls++;
        opts._usage = (opts._usage || 0) + ((r.usage && r.usage.total_tokens) || 0);
        var raw = r.data && r.data.bars;
        if (!raw || !raw.length) throw new Error('润色结果没有 bars');
        var polished = normalizeScore({
          title: score.title,
          keyPc: score.keyPc,
          scaleId: score.scaleId,
          styleId: score.styleId,
          bias: score.bias,
          rangeBias: score.rangeBias,
          bpm: score.bpm,
          preferFlat: score.preferFlat,
          bars: raw,
          barChords: score.barChords,
          progression: score.progression,
          progressionName: score.progressionName,
          instanceName: score.instanceName,
          progressText: score.progressText,
          source: 'ai',
          createdAt: score.createdAt
        }, { bars: opts.bars });
        if (scoreStats(polished).notes < Math.max(4, opts.bars * 2)) {
          throw new Error('润色结果音符太少，保留初稿');
        }
        var applied = applyTransitions(polished, { transitions: r.data.transitions || [] });
        /* 无论模型是否给了衔接，都补一轮小节内连奏（不会覆盖已有技巧）。 */
        addAutoTechs(polished.bars, polished.keyPc, polished.scaleId, rng(nowMs() & 0x7fffffff));
        score = polished;
        var review = String(r.data.review || '已按动机与呼吸润色').slice(0, 70);
        emit(3, '润色 Agent · 评审并重写', 'ok',
          review + ' · ' + scoreStats(score).notes + ' 个音', nowMs() - tp);
      }, function (e) {
        emit(3, '润色 Agent · 评审并重写', 'warn',
          '润色失败，保留初稿：' + (e.message || e), nowMs() - tp);
      });
    }).then(function () {
      return runStep(4, '本地校验器 · Bias / 和弦音 / 格式', function () {
        /* 模型经常把每拍都写成新音；生成后统一补一轮延音/连音，
           让长音跨过拍点。导入/识别的谱不走这里。 */
        addLegato(score.bars, { rnd: rng(nowMs() & 0x7fffffff) });
        var repaired = repairScore(score, { grid: opts.grid, bars: opts.bars });
        score = repaired.score;
        /* 衔接 agent 一个技巧都没给时补一点，避免整段干巴巴 */
        if (scoreStats(score).techs === 0) {
          addAutoTechs(score.bars, score.keyPc, score.scaleId, rng(nowMs() & 0x7fffffff));
          repaired = repairScore(score, { grid: opts.grid, bars: opts.bars });
          score = repaired.score;
        }
        var errs = validateScore(score);
        if (errs.length) throw new Error(errs.join('；'));
        return { detail: '修正 ' + repaired.fixes + ' 处 · ' + statsText(score) };
      });
    }).then(function () {
      return { ok: true, score: score, steps: steps, calls: totalCalls, usage: opts._usage || 0 };
    }).then(null, function (e) {
      return {
        ok: false, score: score, steps: steps, calls: totalCalls,
        usage: opts._usage || 0, error: e.message || String(e)
      };
    });
  }

  /* ============================ 图片识别 ============================ */
  function recognizeImage(dataUrl, opts) {
    opts = opts || {};
    if (!global.LLM || !global.LLM.ready()) {
      return Promise.reject(new Error('还没有配置 AI 接口，无法识别图片'));
    }
    var prompt = [
      '这是一张简谱/数字谱图片。请识别成结构化简谱，并只输出 JSON：',
      '{"title":"曲名（没有就写 未命名）","key":"C","mode":"major","bpm":100,',
      '"bars":[{"chord":"C","slots":["5","-","3","0","5","0","b7","3"]}]}',
      '要求：',
      '1. key 用 C / Db / D / Eb / E / F / F# / G / Ab / A / Bb / B；',
      '2. mode 用 major / minor / dorian / phrygian / lydian / mixolydian / aeolian / locrian；',
      '3. 每个小节 8 个八分音符格；看不清的格子写 "0"（休止）；',
      '4. 音符用 b3 / #4 / 5；高八度加 \'，低八度加 ,；',
      '5. 如果谱面上写了和弦，放在 chord 字段；没有就留空字符串。'
    ].join('\n');
    var messages = [
      { role: 'system', content: '你是简谱 OCR 与乐谱结构化助手。只输出一个合法 JSON 对象，不要 markdown。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ];
    return callJson(messages, 2600).then(function (r) {
      var score = scoreFromRecognition(r.data, opts);
      /* 识别结果没有走向，按当前调式给一遍自然和弦做参考显示 */
      return { score: score, raw: r.data, usage: r.usage || null };
    });
  }

  /* ============================ 存储 ============================ */
  function saveScore(score) {
    if (!global.Store) return null;
    score = normalizeScore(score);
    if (!score.id) score.id = randId('jp');
    score.savedAt = nowMs();
    global.Store.putItem('jianpu', score.id, score);
    global.Store.setSetting('improv.lastScore', score.id);
    var tabText = scoreToTab(score);
    global.Store.putItem('tablature', 'tab-' + score.id, {
      id: 'tab-' + score.id,
      scoreId: score.id,
      zh: score.title + ' · 六线谱',
      text: tabText,
      createdAt: score.savedAt
    });
    state.score = score;
    live.score = score;
    return { score: score, tabText: tabText };
  }

  function listScores() {
    if (!global.Store) return [];
    var list = global.Store.listItems('jianpu');
    list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return list;
  }

  function loadScore(id) {
    if (!global.Store) return null;
    var s = global.Store.getItem('jianpu', id);
    if (!s) return null;
    var score = normalizeScore(s);
    setScore(score);
    global.Store.setSetting('improv.lastScore', id);
    return score;
  }

  function deleteScore(id) {
    if (!global.Store) return;
    global.Store.removeItem('jianpu', id);
    global.Store.removeItem('tablature', 'tab-' + id);
    if (global.Store.getSetting('improv.lastScore', '') === id) {
      global.Store.setSetting('improv.lastScore', '');
    }
    if (state.score && state.score.id === id) {
      state.score = null;
      live.score = null;
      live.enabled = false;
      if (global.Band && global.Band.applyMix) global.Band.applyMix();
    }
  }

  function listTabs() {
    if (!global.Store) return [];
    var list = global.Store.listItems('tablature');
    list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return list;
  }

  function saveTab(score, text) {
    if (!global.Store) return null;
    if (!score.id) score.id = randId('jp');
    var id = 'tab-' + score.id;
    var obj = {
      id: id,
      scoreId: score.id || null,
      zh: (score.title || '简谱') + ' · 六线谱',
      text: text || scoreToTab(score),
      createdAt: nowMs()
    };
    global.Store.putItem('tablature', id, obj);
    return obj;
  }

  function deleteTab(id) {
    if (global.Store) global.Store.removeItem('tablature', id);
  }

  /* ============================ 渲染 ============================ */
  function accText(acc) {
    if (acc < 0) return repeat('\u266d', -acc);
    if (acc > 0) return repeat('\u266f', acc);
    return '';
  }

  function cellHtml(score, barIdx, slot) {
    var bar = score.bars[barIdx];
    var tech = (bar.tech && bar.tech[slot]) || null;
    var t = parseToken(bar.slots[slot]);
    var cls = 'jp-cell';
    var inner = '';
    var label = '';
    if (t.type === 'note') {
      cls += ' note';
      if (slot % 2 === 0) cls += ' strong';
      var octCls = '';
      if (t.oct > 0) octCls = ' up';
      else if (t.oct < 0) octCls = ' low';
      var midi = midiOfToken(t, score.keyPc, score.scaleId);
      var pname = midiName(midi, score.preferFlat);
      inner += '<span class="jp-acc">' + accText(t.acc) + '</span>';
      inner += '<span class="jp-num">' + t.degree + '</span>';
      if (t.oct !== 0) inner += '<span class="jp-oct' + octCls + '">' + repeat('\u2022', Math.abs(t.oct)) + '</span>';
      inner += '<span class="jp-pname">' + esc(pname) + '</span>';
      if (tech) {
        cls += ' tech';
        inner += '<span class="jp-tech">' + (TECH_ZH[tech] || tech) + '</span>';
      }
      label = pname + ' ' + (TECH_ZH[tech] || '');
    } else if (t.type === 'hold') {
      cls += ' hold';
      inner = '<span class="jp-hold">\u2014</span>';
      label = '延音';
    } else {
      cls += ' rest';
      inner = '<span class="jp-rest">0</span>';
      label = '休止';
    }
    return '<div class="' + cls + '" data-bar="' + barIdx + '" data-slot="' + slot +
      '" title="' + esc(label) + '">' + inner + '</div>';
  }

  function renderScoreHtml(score) {
    score = normalizeScore(score);
    var grid = score.progression
      ? progressionGrid(score.progression, score.keyPc, score.scaleId) : null;
    var html = '<div class="jp-bars">';
    for (var b = 0; b < score.bars.length; b++) {
      var names = barChordNames(score, b, grid);
      var st = scoreStats({
        bars: [score.bars[b]], keyPc: score.keyPc, scaleId: score.scaleId
      });
      html += '<div class="jp-bar" data-bar="' + b + '">';
      html += '<div class="jp-head"><span class="jp-no">' + (b + 1) + '</span>' +
        '<span class="jp-chords">' + esc(names.join(' \u00b7 ') || '\u2014') + '</span>' +
        '<span class="jp-count">' + st.notes + ' 音</span></div>';
      html += '<div class="jp-grid">';
      for (var s = 0; s < SLOTS; s += 2) {
        html += '<div class="jp-beat' + (s % 4 === 0 ? ' beat-a' : ' beat-b') +
          '" data-beat="' + (s / 2 + 1) + '">' +
          cellHtml(score, b, s) + cellHtml(score, b, s + 1) + '</div>';
      }
      html += '</div></div>';
    }
    html += '</div>';
    return html;
  }

  function sourceLabel(score) {
    if (!score) return '';
    if (score.source === 'ai') return 'LLM solo';
    if (score.source === 'local') return '本地 solo';
    if (score.source === 'image') return '图片识别';
    if (score.source === 'text') return '文本导入';
    return '未知来源';
  }

  /* 生成这条谱时用的是哪条和弦走向；旧谱没有名字就退回快照里的 zh */
  function progressionLabel(score) {
    if (!score) return '';
    if (score.progressionName) return score.progressionName;
    if (score.progression && score.progression.zh) return score.progression.zh;
    if (score.barChords && score.barChords.length) return '简谱配和弦';
    return '无走向（导入 / 旧谱）';
  }

  function detailText(score) {
    if (!score) return '还没有内容';
    var style = styleById(score.styleId);
    var src = '走向：' + progressionLabel(score) +
      (score.instanceName ? '（实例：' + score.instanceName + '）' : '');
    return sourceLabel(score) + ' · ' + style.zh + ' · Bias ' + score.bias +
      ' · 音域 ' + (score.rangeBias === undefined ? 0.5 : score.rangeBias).toFixed(2) +
      ' · ' + score.bpm + ' BPM · ' + M.keyName(score.keyPc, score.preferFlat) + ' ' +
      M.scaleInfo(score.scaleId).label + ' · ' + src + ' · ' + statsText(score);
  }

  /* ============================ 对外接口 ============================ */
  global.Improv = {
    BAR_BEATS: BAR_BEATS,
    SLOTS: SLOTS,
    SLOT_BEATS: SLOT_BEATS,
    STYLES: STYLES,
    TECHS: TECHS,
    TECH_ZH: TECH_ZH,
    state: state,
    live: live,

    parseToken: parseToken,
    tokenOf: tokenOf,
    normalizeToken: normalizeToken,
    midiOfToken: midiOfToken,
    tokenFromMidi: tokenFromMidi,
    parseKeyName: parseKeyName,
    scaleIdFromName: scaleIdFromName,

    progressionGrid: progressionGrid,
    chordAtSlot: chordAtSlot,
    barChordNames: barChordNames,
    stylePcs: stylePcs,
    allowedPcs: allowedPcs,

    normalizeScore: normalizeScore,
    repairScore: repairScore,
    validateScore: validateScore,
    scoreStats: scoreStats,
    statsText: statsText,
    midiName: midiName,
    sourceLabel: sourceLabel,
    progressionLabel: progressionLabel,

    composeLocal: composeLocal,
    barNotes: barNotes,
    renderOffline: renderOffline,

    suggestChords: suggestChords,
    useProgression: useProgression,
    scoreToTab: scoreToTab,
    SHAPES: SHAPES,
    shapeOptions: shapeOptions,
    fingeringPlan: fingeringPlan,
    phraseForBar: phraseForBar,
    positionsInWindow: positionsInWindow,
    noteRange: noteRange,
    applyTransitions: applyTransitions,
    addLegato: addLegato,

    parseTextScore: parseTextScore,
    scoreFromRecognition: scoreFromRecognition,
    extractJson: extractJson,

    runAgents: runAgents,
    recognizeImage: recognizeImage,

    saveScore: saveScore,
    listScores: listScores,
    loadScore: loadScore,
    deleteScore: deleteScore,
    listTabs: listTabs,
    saveTab: saveTab,
    deleteTab: deleteTab,

    renderScoreHtml: renderScoreHtml,
    detailText: detailText,

    setScore: setScore,
    setTone: setTone,
    setVolume: setVolume,
    setStyle: setStyle,
    setBias: setBias,
    setEnabled: setEnabled,
    play: play,
    stop: stop,
    hasScore: function () { return !!live.score; },
    engine: engine
  };
})(window);
