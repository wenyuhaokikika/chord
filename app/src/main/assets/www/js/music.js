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

  /* ---------- 音阶 / 调式 ----------
   * steps 是相对主音的半音数；group 用于界面分组。
   * 教会调式（中古调式）7 种就是同一条大调音阶从不同级起算，
   * 所以「C 多利亚」= 降 B 大调音阶从 C 起（等价说法），下面的 steps 直接给出更直白。
   */
  var SCALES = [
    { id: 'major', label: '大调', group: '常用',
      steps: [0, 2, 4, 5, 7, 9, 11],
      en: 'Ionian', char: '无（等于自然大调）', feel: '明亮、稳定' },
    { id: 'minor', label: '自然小调', group: '常用',
      steps: [0, 2, 3, 5, 7, 8, 10],
      en: 'Aeolian', char: '\u266d3、\u266d6、\u266d7', feel: '忧郁、小调' },
    { id: 'harmonic', label: '和声小调', group: '常用',
      steps: [0, 2, 3, 5, 7, 8, 11],
      en: 'Harmonic minor', char: '\u266d3、\u266d6（第 7 级还原）', feel: '异域、古典小调' },
    { id: 'ionian', label: '伊奥尼亚', group: '教会调式',
      steps: [0, 2, 4, 5, 7, 9, 11],
      en: 'Ionian', char: '无（等于自然大调）', feel: '明亮、稳定' },
    { id: 'dorian', label: '多利亚', group: '教会调式',
      steps: [0, 2, 3, 5, 7, 9, 10],
      en: 'Dorian', char: '\u266d3、\u266d7', feel: '小调但带亮色，爵士 / 放克' },
    { id: 'phrygian', label: '弗里几亚', group: '教会调式',
      steps: [0, 1, 3, 5, 7, 8, 10],
      en: 'Phrygian', char: '\u266d2、\u266d3、\u266d6、\u266d7', feel: '西班牙 / 弗拉门戈、阴暗' },
    { id: 'lydian', label: '利底亚', group: '教会调式',
      steps: [0, 2, 4, 6, 7, 9, 11],
      en: 'Lydian', char: '\u266f4', feel: '梦幻、漂浮、电影感' },
    { id: 'mixolydian', label: '混合利底亚', group: '教会调式',
      steps: [0, 2, 4, 5, 7, 9, 10],
      en: 'Mixolydian', char: '\u266d7', feel: '布鲁斯、摇滚、民谣' },
    { id: 'aeolian', label: '爱奥利亚', group: '教会调式',
      steps: [0, 2, 3, 5, 7, 8, 10],
      en: 'Aeolian', char: '\u266d3、\u266d6、\u266d7（=自然小调）', feel: '忧郁、小调' },
    { id: 'locrian', label: '洛克里亚', group: '教会调式',
      steps: [0, 1, 3, 5, 6, 8, 10],
      en: 'Locrian', char: '\u266d2、\u266d3、\u266d5、\u266d6、\u266d7', feel: '极不协和，少用' }
  ];

  /* 音名首字母 -> 自然音高：C D E F G A B */
  var LETTER_PCS = [0, 2, 4, 5, 7, 9, 11];
  var LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

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

  /* 频率 -> 最接近的 MIDI 音高（可带小数，用于算音分） */
  function freqToMidi(freq, a4) {
    return 69 + 12 * Math.log(freq / (a4 || 440)) / Math.LN2;
  }

  /* ---------- 级数与音名的正确拼写 ---------- */
  /* 主调音名首字母（决定后面各级用什么字母：如降 E 调的第 3 级是 G 开头） */
  function keyLetterIndex(keyPc, preferFlat) {
    var name = (preferFlat && FLAT_KEYS[mod12(keyPc)]) ? FLAT_NAMES[mod12(keyPc)] : SHARP_NAMES[mod12(keyPc)];
    return LETTERS.indexOf(name.charAt(0));
  }

  /**
   * 把一个音（pitch class）映射到某个调式里的级数 + 变音。
   * @returns {degree:1..7, acc:-1|0|1, inScale:boolean}
   * 规则：取最近的音阶音；三全音这种等距情况按「♭2 ♭3 ♯4 ♭6 ♭7」的习惯命名。
   */
  function scaleDegreeOf(pc, keyPc, scaleId) {
    var scale = scaleById(scaleId);
    var n = scale.steps.length;
    var rel = mod12(pc - keyPc);
    var best = null, i, d;
    for (i = 0; i < n; i++) {
      d = rel - scale.steps[i];
      if (d > 6) d -= 12;
      if (d < -6) d += 12;
      if (d === 0) return { degree: i + 1, acc: 0, inScale: true };
      if (best === null || Math.abs(d) < Math.abs(best.d)) best = { degree: i + 1, acc: d, d: d };
      else if (Math.abs(d) === Math.abs(best.d)) {
        /* 等距（变化音落在两级正中间）：按惯例选更好用的写法。
           看这一对里「较低的那一级」：
             3、4、7 级取升号 -> ♯3 ♯4 ♯7（如 C 多利亚里的 B 自然音是导音 ♯7）
             1、2、5、6 级取上一级的降号 -> ♭2 ♭3 ♭6 ♭7
           注意 7 与 1 是首尾相接的一对，此时「较低级」是 7。 */
        var a = i + 1, b = best.degree;
        var lower = (Math.max(a, b) === 7 && Math.min(a, b) === 1) ? 7 : Math.min(a, b);
        var sharpBelow = (lower === 3 || lower === 4 || lower === 7);
        if (sharpBelow) { if (d > 0) best = { degree: i + 1, acc: d, d: d }; }
        else { if (d < 0) best = { degree: i + 1, acc: d, d: d }; }
      }
    }
    return { degree: best.degree, acc: best.acc, inScale: false };
  }

  /**
   * 按字母规则拼写音名：级数决定用哪个字母，变音只加升降号。
   * 例：降 B 大调第 3 级 -> G 开头；若实际音是 Ab 就写成 A♭。
   * 级数标记（♭3 / ♯4 这种）取「与同主音大调相比的改动量」：
   * 调式自身的改动 + 这个音相对该级再走的半音数。
   * @returns {name:'B\u266d', degreeLabel:'\u266d7'}
   */
  function spellNote(keyPc, scaleId, degree, acc, preferFlat) {
    var scale = scaleById(scaleId);
    var li = keyLetterIndex(keyPc, preferFlat);
    var letter = (li + (degree - 1)) % 7;
    var target = mod12(keyPc + scale.steps[degree - 1] + acc);
    var diff = target - LETTER_PCS[letter];
    if (diff > 6) diff -= 12;
    if (diff < -6) diff += 12;
    var mark = '';
    if (diff === 1) mark = '\u266f';
    else if (diff === 2) mark = '\u266f\u266f';
    else if (diff === -1) mark = '\u266d';
    else if (diff === -2) mark = '\u266d\u266d';
    var degAcc = (scale.steps[degree - 1] - MAJOR_STEPS[degree - 1]) + (acc || 0);
    var degreeMark = degAcc < 0 ? '\u266d' : (degAcc > 0 ? '\u266f' : '');
    if (degAcc <= -2) degreeMark = '\u266d\u266d';
    if (degAcc >= 2) degreeMark = '\u266f\u266f';
    return {
      name: LETTERS[letter] + mark,
      degreeLabel: degreeMark + String(degree)
    };
  }

  /* 直接给出某个音在「主调 + 调式」里的标注：级数 + 音名 */
  function annotateNote(pc, keyPc, scaleId, preferFlat) {
    var d = scaleDegreeOf(pc, keyPc, scaleId);
    var spelled = spellNote(keyPc, scaleId, d.degree, d.acc, preferFlat);
    return {
      pc: mod12(pc),
      degree: d.degree,
      acc: d.acc,
      inScale: d.inScale,
      degreeLabel: spelled.degreeLabel,
      name: spelled.name
    };
  }

  /* 音阶的全部音：用于在指板上标注
   * 级数标记按「与同主音大调相比改了哪些音」来算——这正是乐手说的特征音，
   * 例如 C 多利亚 = 1 2 ♭3 4 5 6 ♭7；音名则按字母规则拼写（E♭ 而不是 D♯）。 */
  var MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

  function scaleTones(keyPc, scaleId, preferFlat) {
    var scale = scaleById(scaleId);
    var out = [];
    for (var i = 0; i < scale.steps.length; i++) {
      var acc = scale.steps[i] - MAJOR_STEPS[i];
      var spelled = spellNote(keyPc, scaleId, i + 1, 0, preferFlat);
      out.push({
        pc: mod12(keyPc + scale.steps[i]),
        degree: i + 1,
        degreeLabel: (acc === 0 ? '' : (acc < 0 ? '\u266d' : '\u266f')) + (i + 1),
        semitone: scale.steps[i],
        name: spelled.name,
        isRoot: i === 0
      });
    }
    return out;
  }

  /* 调式的特征音（相对同主音大调改动过的级数），如多利亚 -> ['♭3','♭7'] */
  function scaleCharacter(scaleId) {
    var scale = scaleById(scaleId);
    var out = [];
    for (var i = 0; i < scale.steps.length; i++) {
      var acc = scale.steps[i] - MAJOR_STEPS[i];
      if (acc !== 0) out.push((acc < 0 ? '\u266d' : '\u266f') + (i + 1));
    }
    return out;
  }

  function scaleById2(id) { return scaleById(id); }

  /* 调式说明（调音板块用来显示特征音与听感） */
  function scaleInfo(id) {
    var s = scaleById(id);
    return {
      id: s.id, label: s.label, en: s.en || '', char: s.char || '', feel: s.feel || '',
      group: s.group || '常用', steps: s.steps
    };
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
    scaleInfo: scaleInfo,
    scaleCharacter: scaleCharacter,
    MAJOR_STEPS: MAJOR_STEPS,
    /* 调音 / 音阶板块用 */
    freqToMidi: freqToMidi,
    scaleDegreeOf: scaleDegreeOf,
    spellNote: spellNote,
    annotateNote: annotateNote,
    scaleTones: scaleTones,
    keyLetterIndex: keyLetterIndex,
    LETTERS: LETTERS,
    LETTER_PCS: LETTER_PCS,
    midiToFreq: midiToFreq
  };
})(window);
