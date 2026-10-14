/*!
 * music.js —— 乐理基础层：音名、音高、音阶、级数
 * 纯 ES5 写法（var / function），保证在低版本 Android WebView 上也能运行。
 */
(function (global) {
  'use strict';

  /* ---------- 音名 ---------- */
  var SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  /* 12 个主调：pc = 0..11，同时给出升号 / 降号两种拼写 */
  var KEYS = [
    { pc: 0, sharp: 'C', flat: 'C' },
    { pc: 1, sharp: 'C#', flat: 'Db' },
    { pc: 2, sharp: 'D', flat: 'D' },
    { pc: 3, sharp: 'D#', flat: 'Eb' },
    { pc: 4, sharp: 'E', flat: 'E' },
    { pc: 5, sharp: 'F', flat: 'F' },
    { pc: 6, sharp: 'F#', flat: 'Gb' },
    { pc: 7, sharp: 'G', flat: 'G' },
    { pc: 8, sharp: 'G#', flat: 'Ab' },
    { pc: 9, sharp: 'A', flat: 'A' },
    { pc: 10, sharp: 'A#', flat: 'Bb' },
    { pc: 11, sharp: 'B', flat: 'B' }
  ];

  /* 习惯上用降号书写的调（选择该调时默认按降号拼写和弦名） */
  var FLAT_KEYS = { 1: 1, 3: 1, 5: 1, 6: 1, 8: 1, 10: 1 };

  /* ---------- 音阶 ---------- */
  var SCALES = [
    { id: 'major', label: '大调', steps: [0, 2, 4, 5, 7, 9, 11] },
    { id: 'minor', label: '自然小调', steps: [0, 2, 3, 5, 7, 8, 10] },
    { id: 'harmonic', label: '和声小调', steps: [0, 2, 3, 5, 7, 8, 11] }
  ];

  var ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

  /* ---------- 工具函数 ---------- */
  function mod12(n) {
    n = n % 12;
    return n < 0 ? n + 12 : n;
  }

  function noteName(pc, preferFlat) {
    pc = mod12(pc);
    return preferFlat ? FLAT_NAMES[pc] : SHARP_NAMES[pc];
  }

  function keyByPc(pc) {
    for (var i = 0; i < KEYS.length; i++) {
      if (KEYS[i].pc === mod12(pc)) return KEYS[i];
    }
    return KEYS[0];
  }

  function keyName(pc, preferFlat) {
    var k = keyByPc(pc);
    return preferFlat ? k.flat : k.sharp;
  }

  function scaleById(id) {
    for (var i = 0; i < SCALES.length; i++) {
      if (SCALES[i].id === id) return SCALES[i];
    }
    return SCALES[0];
  }

  /* 主调 + 级数(1..7) + 变音(-1/0/+1) => 和弦根音 pitch class */
  function degreeToPc(keyPc, scaleId, degree, accidental) {
    var scale = scaleById(scaleId);
    var d = Math.max(1, Math.min(7, degree)) - 1;
    return mod12(keyPc + scale.steps[d] + (accidental || 0));
  }

  /* 级数的罗马数字写法：大调音阶第 n 级 + 变音 + 和弦性质
   * figure 是七和弦标记（如 '7' / 'maj7' / '7\u266d5'），三和弦传空 */
  function romanNumeral(degree, accidental, triad, figure) {
    var base = ROMAN[Math.max(1, Math.min(7, degree)) - 1];
    var prefix = accidental < 0 ? '\u266d' : (accidental > 0 ? '\u266f' : '');
    var s;
    if (triad === 'dim') {
      s = base.toLowerCase() + '\u00b0';                 /* vii° */
    } else if (triad === 'halfdim') {
      s = base.toLowerCase() + '\u00f8';                 /* viiø */
    } else if (triad === 'aug') {
      s = base + '+';
    } else if (triad === 'min') {
      s = base.toLowerCase();
    } else {
      s = base;
    }
    if (figure) s += figure;
    return prefix + s;
  }

  /* 七和弦的罗马数字标记：只有大七必须写 maj7，避免 I7 被误读成属七；
   * 其余和弦的记号已经由 ° ø + 和小写罗马数字表达清楚了 */
  var SEVENTH_FIGURE = {
    '7': '7',
    'maj7': 'maj7',
    'm7': '7',            /* ii7 = 小七 */
    'mmaj7': 'maj7',      /* imaj7 = 小大七 */
    'dim7': '7',          /* vii°7 */
    'm7b5': '7',          /* viiø7 */
    'aug7': '7'           /* III+7 */
  };

  function seventhFigure(qualityId) {
    return SEVENTH_FIGURE[qualityId] || '';
  }

  /* 判断一个音阶在某级上自然形成的三和弦/七和弦性质 */
  function scaleChordQuality(keyPc, scaleId, degree, withSeventh) {
    var scale = scaleById(scaleId);
    var steps = scale.steps;
    var root = mod12(keyPc + steps[degree - 1]);
    var third = mod12(keyPc + steps[(degree - 1 + 2) % 7]);
    var fifth = mod12(keyPc + steps[(degree - 1 + 4) % 7]);
    var t = mod12(third - root);
    var f = mod12(fifth - root);
    var triad;
    if (t === 3 && f === 6) triad = 'dim';
    else if (t === 3 && f === 7) triad = 'min';
    else if (t === 4 && f === 8) triad = 'aug';
    else if (t === 4 && f === 7) triad = 'maj';
    else triad = 'maj';

    var result = { rootPc: root, triad: triad, qualityId: triad === 'maj' ? 'maj' : (triad === 'min' ? 'min' : triad) };

    if (withSeventh) {
      var seventh = mod12(keyPc + steps[(degree - 1 + 6) % 7] - root);
      var q;
      if (triad === 'maj') q = (seventh === 11) ? 'maj7' : '7';
      else if (triad === 'min') q = (seventh === 10) ? 'm7' : 'mmaj7';
      else if (triad === 'dim') q = (seventh === 9) ? 'dim7' : 'm7b5';
      else q = 'aug7';
      result.qualityId = q;
      result.seventh = seventh;
      /* 半减七要用 ø 记号，不能写成 vii°7（那是减七） */
      if (q === 'm7b5') result.triad = 'halfdim';
    }
    return result;
  }

  /* 音高类：MIDI -> 频率 */
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  global.Music = {
    SHARP_NAMES: SHARP_NAMES,
    FLAT_NAMES: FLAT_NAMES,
    KEYS: KEYS,
    FLAT_KEYS: FLAT_KEYS,
    SCALES: SCALES,
    mod12: mod12,
    noteName: noteName,
    keyByPc: keyByPc,
    keyName: keyName,
    scaleById: scaleById,
    degreeToPc: degreeToPc,
    romanNumeral: romanNumeral,
    seventhFigure: seventhFigure,
    scaleChordQuality: scaleChordQuality,
    midiToFreq: midiToFreq
  };
})(window);
