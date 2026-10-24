/*!
 * backing.js —— 伴奏：和弦走向 + 节奏型，用吉他音色弹出来
 *
 * 三块内容：
 *   1. 节奏型库：分解（arp）与扫弦（strum）两类。分解的每个位置是
 *      「根音 R / 第 1~6 弦 / 休止 -」——R 是关键：C 和弦的根音在 5 弦、G 在 6 弦、
 *      D 在 4 弦，写死弦号就会串味，所以由引擎按当前和弦指法去找「最低的根音弦」。
 *   2. 和弦走向库：用「级数 + 变音 + 和弦属性 + 走几拍」表示，所以换个主调/调式
 *      走向会整体平移（同一个 I–V–vi–IV 在 C 大调是 C G Am F，在 G 大调就是 G D Em C）。
 *   3. 演奏引擎：把走向与节奏型展开成「第几拍、哪个和弦、弹什么」的事件列表
 *      （buildPlan 是纯函数，所以能脱离音频单测），再交给共享 Transport 排进时间轴。
 */
(function (global) {
  'use strict';

  var M = global.Music, C = global.Chord, A = global.Audio_, T = global.Transport;

  /* ============================ 节奏型 ============================ */
  /* 分解：R = 当前和弦的根音弦，'1'~'6' = 第几弦（按该和弦指法的品位），'-' = 休止 */
  /* 扫弦：D = 下扫，U = 上扫，X = 切音（闷音），'-' = 休止 */

  var RHYTHMS = [
    { id: 'arp5321', zh: '53231323', type: 'arp', beats: 4, perBeat: 2,
      seq: ['R', '3', '2', '3', '1', '3', '2', '3'],
      tip: '最经典的民谣分解，第一个音弹根音（C 和弦落在 5 弦、G 和弦落在 6 弦）' },
    { id: 'arp_quart', zh: '四分分解', type: 'arp', beats: 4, perBeat: 1,
      seq: ['R', '3', '2', '1'],
      tip: '一拍一个音，慢歌与新手的起步节奏' },
    { id: 'arp_alt', zh: '根音交替', type: 'arp', beats: 4, perBeat: 2,
      seq: ['R', '3', '2', '3', 'R', '4', '3', '4'],
      tip: '根音出现两次，弹出来更稳、更有低音支撑' },
    { id: 'arp_waltz', zh: '三拍分解', type: 'arp', beats: 3, perBeat: 2,
      seq: ['R', '3', '2', '1', '2', '3'],
      tip: '3/4 拍（圆舞曲）的分解，配三拍子鼓机' },
    { id: 'arp_68', zh: '六八拍分解', type: 'arp', beats: 6, perBeat: 1,
      seq: ['R', '3', '2', '1', '2', '3'],
      tip: '6/8 的摇摆分解（BPM 按八分算），慢速民谣常用' },
    { id: 'arp_16', zh: '十六分分解', type: 'arp', beats: 4, perBeat: 4,
      seq: ['R', '3', '2', '3', '1', '3', '2', '3', 'R', '3', '2', '3', '1', '3', '2', '3'],
      tip: '把 53231323 走成十六分，适合慢速下的铺底' },

    { id: 'strum_folk', zh: '民谣八分扫弦', type: 'strum', beats: 4, perBeat: 2,
      seq: ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'],
      tip: '「下 下上 空上 下上」——最常用的弹唱扫弦' },
    { id: 'strum_quart', zh: '四分扫弦', type: 'strum', beats: 4, perBeat: 1,
      seq: ['D', 'D', 'D', 'D'],
      tip: '每拍一下，稳定好跟，适合练和弦转换' },
    { id: 'strum_8', zh: '八分扫弦', type: 'strum', beats: 4, perBeat: 2,
      seq: ['D', 'U', 'D', 'U', 'D', 'U', 'D', 'U'],
      tip: '一上一下均速循环，练右手稳定' },
    { id: 'strum_16', zh: '十六分扫弦', type: 'strum', beats: 4, perBeat: 4,
      seq: ['D', 'U', 'D', 'U', 'D', 'U', 'D', 'U', 'D', 'U', 'D', 'U', 'D', 'U', 'D', 'U'],
      tip: '十六分均速，快歌与情绪推进用' },
    { id: 'strum_mute', zh: '带切音扫弦', type: 'strum', beats: 4, perBeat: 2,
      seq: ['D', 'X', 'D', 'U', 'X', 'U', 'D', 'X'],
      tip: 'X 是切音（闷住），流行与放克里常用' },
    { id: 'strum_ballad', zh: '慢歌扫弦', type: 'strum', beats: 4, perBeat: 2,
      seq: ['D', '-', '-', 'U', '-', '-', 'D', 'U'],
      tip: '留白多、起伏大，抒情歌的铺底' },
    { id: 'strum_waltz', zh: '三拍扫弦', type: 'strum', beats: 3, perBeat: 2,
      seq: ['D', '-', 'D', 'U', 'D', 'U'],
      tip: '「强 弱 弱」的三拍子扫弦' },
    { id: 'strum_reggae', zh: '反拍扫弦', type: 'strum', beats: 4, perBeat: 2,
      seq: ['-', 'U', '-', 'U', '-', 'U', '-', 'U'],
      tip: '只弹反拍，雷鬼与放克的味道' }
  ];

  /* ============================ 和弦走向 ============================ */
  /* 每项：degree 级数 1~7，acc 变音 -1/0/1，quality 和弦属性（留空 = 该调式的自然和弦），beats 走几拍 */
  function it(degree, beats, quality, acc) {
    return { degree: degree, acc: acc || 0, quality: quality || null, beats: beats };
  }

  /* 歌曲走向的紧凑写法：
     "6 4 1 5 3" 表示 vi–IV–I–V–iii，默认每个和弦 4 拍。
     后缀可覆盖属性：3maj = 大三、5:7 = 属七、4maj7 = 大七。
     这些走向仍按当前主调整体移调；tip 里保留图片上的原调和弦名。 */
  var SONG_QUALITY = { m: 'min', 7: '7', m7: 'm7', maj: 'maj', maj7: 'maj7',
                       dim: 'dim', sus4: 'sus4', add9: 'add9' };
  function songProg(id, zh, pattern, origin, tag) {
    var tokens = pattern.split(/\s+/), items = [];
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i], q = null;
      var colon = token.indexOf(':');
      if (colon >= 0) {
        q = SONG_QUALITY[token.slice(colon + 1)] || null;
        token = token.slice(0, colon);
      }
      var m = /^([b#]?)([1-7])([a-z0-9]*)$/.exec(token);
      if (!m) continue;
      if (m[3]) q = SONG_QUALITY[m[3]] || q;
      var acc = m[1] === 'b' ? -1 : (m[1] === '#' ? 1 : 0);
      items.push(it(Number(m[2]), 4, q, acc));
    }
    return { id: id, zh: zh, tag: tag || '歌曲',
             tip: '原调 ' + origin + '；按当前主调整体移调', items: items };
  }

  var PROGRESSIONS = [
    { id: 'pop4', zh: '万能和弦 I–V–vi–IV', tip: '华语流行最常用的一串，能套无数首歌',
      items: [it(1, 4), it(5, 4), it(6, 4), it(4, 4)] },
    { id: 'canon', zh: '卡农 I–V–vi–iii–IV–I–IV–V', tip: '帕赫贝尔卡农走向，每和弦 2 拍',
      items: [it(1, 2), it(5, 2), it(6, 2), it(3, 2), it(4, 2), it(1, 2), it(4, 2), it(5, 2)] },
    { id: 'old50', zh: '五十年代 I–vi–IV–V', tip: '老歌与民谣的经典四句',
      items: [it(1, 4), it(6, 4), it(4, 4), it(5, 4)] },
    { id: 'sad', zh: '伤感流行 vi–IV–I–V', tip: '从六级起，情绪偏抒情',
      items: [it(6, 4), it(4, 4), it(1, 4), it(5, 4)] },
    { id: 'folk3', zh: '民谣 I–IV–V', tip: '三个和弦走天下',
      items: [it(1, 4), it(4, 4), it(5, 4), it(5, 4)] },
    { id: 'jazz251', zh: '爵士 ii–V–I', tip: '最常见的爵士终止式（小七 → 属七 → 大七）',
      items: [it(2, 4, 'm7'), it(5, 4, '7'), it(1, 4, 'maj7'), it(1, 4, 'maj7')] },
    { id: 'minor_pop', zh: '小调流行 i–♭VI–♭III–♭VII', tip: '小调里最顺耳的一串（调式选自然小调）',
      items: [it(1, 4), it(6, 4), it(3, 4), it(7, 4)] },
    { id: 'blues12', zh: '十二小节布鲁斯', tip: '蓝调/摇滚的根，配「蓝调摇摆」鼓机正好',
      items: [it(1, 4, '7'), it(1, 4, '7'), it(1, 4, '7'), it(1, 4, '7'),
              it(4, 4, '7'), it(4, 4, '7'), it(1, 4, '7'), it(1, 4, '7'),
              it(5, 4, '7'), it(4, 4, '7'), it(1, 4, '7'), it(5, 4, '7')] },
    { id: 'pop_1625', zh: '老流行 I–vi–ii–V', tip: '更“绕”的一条，适合副歌',
      items: [it(1, 4), it(6, 4), it(2, 4), it(5, 4)] },

    /* ---------- 歌曲 / 情绪走向（整理自常用华语流行走向图） ---------- */
    songProg('song_clean', '清新干净', '6 4 1 5 3', 'C：Am–F–C–G–Em'),
    songProg('song_flow', '旋律流畅', '4 1 5 6 1', 'C：F–C–G–Am–C'),
    songProg('song_retro', '复古浪漫', '6 4 1 5 2', 'D：Bm–G–D–A–Em'),
    songProg('song_rise', '情绪递进', '6 4 1 5 3', 'G：Em–C–G–D–Bm'),
    songProg('song_dream', '追梦挣扎', '6 4 1 5 2 3maj', 'C：Am–F–C–G–Dm–E'),
    songProg('song_bright', '明快有力', '4 1 5 6 5 4', 'C：F–C–G–Am–G–F'),
    songProg('song_wild', '狂野奔放', '6 4 1 5 2maj 6', 'D：Bm–G–D–A–E–Bm'),
    songProg('song_energy', '元气满满', '1 4 5 6 2', 'C：C–F–G–Am–Dm'),
    songProg('song_hope', '沉稳带希望', '1 4 5 6 1', 'G：G–C–D–Em–G'),
    songProg('song_tender', '温柔忧伤', '6 5 4 1 2', 'C：Am–G–F–C–Dm'),
    songProg('song_easy', '轻松惬意', '4 5 1 6 5:7', 'C：F–G–C–Am–G7'),
    songProg('song_pure', '心动，纯粹', '1 6 4 5 1', 'C：C–Am–F–G–C'),
    songProg('song_blood', '热血激昂', '1 5 6 4 1', 'D：D–A–Bm–G–D'),
    songProg('song_oldlove', '老情歌', '1 4 5:7 6 2', 'C：C–F–G7–Am–Dm'),
    songProg('song_record', '老唱片', '1 5 6 4 5:7', 'G：G–D–Em–C–G7'),
    songProg('song_wistful', '温柔怅然', '6 2 5 1 4', 'C：Am–Dm–G–C–F'),
    songProg('song_classic', '经典悠扬', '4 1 2 5:7 1', 'C：F–C–Dm–G7–C'),
    songProg('song_retro_blood', '热血复古', '1 5 6 4 2:7', 'D：D–A–Bm–G–E7'),
    songProg('song_confess', '老派告白', '6 4 1 5 3', 'D：Bm–G–D–A–F#m'),
    songProg('song_campus', '校园民谣', '6 4 1 5 2', 'G：Em–C–G–D–Am'),
    songProg('song_lullaby', '摇篮曲', '1 5 6 4 2', 'C：C–G–Am–F–Dm'),
    songProg('song_jazzbar', '爵士酒吧', '6 5 4 1 3', 'B♭：Gm–F–E♭–B♭–Dm'),
    songProg('song_90s', '90 年代', '4 5 1 6 2', 'C：F–G–C–Am–Dm'),

    songProg('song_lazy', '慵懒迷人', '6 5 4 1 2', 'B♭：Gm–F–E♭–B♭–Cm'),
    songProg('song_seabreeze', '海边微风', '1 5 2maj 6 5', 'B♭：B♭–F–C–Gm–F'),
    songProg('song_relax', '舒缓放松', '1 3 6 4 5', 'C：C–Em–Am–F–G'),
    songProg('song_yearning', '深沉思念', '1 6 4 5 6', 'G：G–Em–C–D–Em'),
    songProg('song_clear', '清澈忧伤', '6 1 4 5 3', 'C：Am–C–F–G–Em'),
    songProg('song_secure', '踏实安心', '4 1 6 5 1', 'C：F–C–Am–G–C'),
    songProg('song_heart', '诉说心事', '2 6 4 1 5', 'C：Dm–Am–F–C–G'),
    songProg('song_out', '走出阴霾', '6 2 4 1 5', 'D：Bm–Em–G–D–A'),
    songProg('song_serene', '宁静悠远', '6 1 4 5 6', 'G：Em–G–C–D–Em'),
    songProg('song_romantic', '浪漫唯美', '1 5 3 6 4', 'C：C–G–Em–Am–F'),
    songProg('song_story', '娓娓道来', '1 4 6 5 1', 'G：G–C–Em–D–G'),
    songProg('song_sweet', '忧伤带感', '6 4 1 3 5', 'C：Am–F–C–Em–G'),
    songProg('song_heal', '慵懒治愈', '4 5 6 1 2', 'C：F–G–Am–C–Dm'),
    songProg('song_crush', '热恋告白', '1 6 4 5 2', 'D：D–Bm–G–A–Em'),
    songProg('song_vibe', '氛围拉满', '1 6 5 4 2', 'B♭：B♭–Gm–F–E♭–Cm'),
    songProg('song_fine', '细腻动人', '6 4 1 5 3', 'E♭：Cm–A♭–E♭–B♭–Gm'),
    songProg('song_mountain', '跨越山海', '6 4 1 5 2', 'A：F#m–D–A–E–Bm'),
    songProg('song_grand', '大气磅礴', '1 5 6 4 5 1', 'G：G–D–Em–C–D–G'),
    songProg('song_boil', '热血沸腾', '1 5 6 4 1 5', 'D：D–A–Bm–G–D–A'),
    songProg('song_sunny', '阳光', '1 5 6 4 5', 'C：C–G–Am–F–G'),
    songProg('song_open', '开阔的感觉', '1 5 6 4 5 1', 'G：G–D–Em–C–D–G'),
    songProg('song_soft', '温柔细腻', '6 4 1 5 2', 'F：Dm–B♭–F–C–Gm'),
    songProg('song_burst', '爆发力强', '1 5 6 4 5 1', 'C：C–G–Am–F–G–C'),

    /* ---------- 额外常用走向 ---------- */
    songProg('song_4536251', '华语万能 4536251', '4 5 3 6 2 5 1', 'C：F–G–Em–Am–Dm–G–C', '扩展'),
    songProg('song_4536', '日系王道 4536', '4 5 3 6', 'C：F–G–Em–Am', '扩展'),
    songProg('song_15634145', '流行八和弦 15634145', '1 5 6 3 4 1 4 5', 'C：C–G–Am–Em–F–C–F–G', '扩展'),
    songProg('song_2516', 'R&B 2516', '2m7 5:7 1maj7 6m7', 'C：Dm7–G7–Cmaj7–Am7', '扩展'),
    songProg('song_jazz4536', '爵士 4536251', '4maj7 5:7 3m7 6m7 2m7 5:7 1maj7',
      'C：Fmaj7–G7–Em7–Am7–Dm7–G7–Cmaj7', '扩展'),
    songProg('song_andalusian', '安达卢西亚终止', '6 5 4 3maj', 'C：Am–G–F–E', '扩展'),
    songProg('song_rock', '摇滚 I–♭VII–IV', '1 b7maj 4', 'C：C–B♭–F', '扩展'),
    songProg('song_minor_epic', '小调史诗 i–VI–III–VII', '6 4 1 5 3', 'C：Am–F–C–G–Em', '扩展')
  ];

  var ARP_SLOTS = ['R', '1', '2', '3', '4', '5', '6', '-'];
  var STRUM_SLOTS = ['D', 'U', 'X', '-'];
  var SLOT_ZH = { R: '根音', D: '下', U: '上', X: '切音', '-': '休止' };

  /* ============================ 校验与工具 ============================ */
  function rhythmById(id) {
    for (var i = 0; i < RHYTHMS.length; i++) if (RHYTHMS[i].id === id) return RHYTHMS[i];
    return RHYTHMS[0];
  }
  function progressionById(id) {
    for (var i = 0; i < PROGRESSIONS.length; i++) if (PROGRESSIONS[i].id === id) return PROGRESSIONS[i];
    return PROGRESSIONS[0];
  }
  function cloneRhythm(p) {
    return { id: p.id, zh: p.zh, type: p.type, beats: p.beats, perBeat: p.perBeat,
             seq: p.seq.slice(0), tip: p.tip };
  }
  function cloneProgression(p) {
    var items = [];
    for (var i = 0; i < p.items.length; i++) {
      items.push({ degree: p.items[i].degree, acc: p.items[i].acc,
                   quality: p.items[i].quality, beats: p.items[i].beats });
    }
    return { id: p.id, zh: p.zh, tip: p.tip, items: items };
  }
  function slots(rhythm) { return rhythm.type === 'arp' ? ARP_SLOTS : STRUM_SLOTS; }

  function validateRhythm(p) {
    var errs = [];
    var want = p.beats * p.perBeat;
    if (p.seq.length !== want) errs.push('格子数 ' + p.seq.length + ' 应等于 拍数×每拍格数 = ' + want);
    var allowed = slots(p);
    for (var i = 0; i < p.seq.length; i++) {
      if (allowed.indexOf(p.seq[i]) < 0) errs.push('第 ' + i + ' 格取值非法：' + p.seq[i]);
    }
    if (p.type !== 'arp' && p.type !== 'strum') errs.push('类型只能是 arp 或 strum');
    return errs;
  }
  function validateProgression(p) {
    var errs = [];
    if (!p.items.length) errs.push('走向至少要有一个和弦');
    for (var i = 0; i < p.items.length; i++) {
      var x = p.items[i];
      if (x.degree < 1 || x.degree > 7) errs.push('第 ' + (i + 1) + ' 个和弦级数越界：' + x.degree);
      if (x.acc < -1 || x.acc > 1) errs.push('第 ' + (i + 1) + ' 个和弦变音越界：' + x.acc);
      if (x.beats < 1 || x.beats > 16) errs.push('第 ' + (i + 1) + ' 个和弦拍数越界：' + x.beats);
      if (x.quality && !C.qualityById(x.quality)) errs.push('第 ' + (i + 1) + ' 个和弦属性未知');
    }
    return errs;
  }

  /* 某个级数在给定调式里的实际和弦 */
  function chordAt(keyPc, scaleId, degree, acc, qualityId) {
    var rootPc = M.degreeToPc(keyPc, scaleId, degree, acc || 0);
    var q = qualityId || M.scaleChordQuality(keyPc, scaleId, degree, false).qualityId;
    return { rootPc: rootPc, qualityId: q };
  }
  function chordName(chord, preferFlat) {
    return M.noteName(chord.rootPc, preferFlat) + C.qualityById(chord.qualityId).symbol;
  }

  /* ============================ 演奏计划（纯函数） ============================ */
  /**
   * 把走向与节奏型展开成事件列表：第几拍、哪个和弦、弹什么
   * @returns {{events:Array, totalBeats:number}}
   */
  function buildPlan(prog, rhythm, keyPc, scaleId) {
    var events = [], beat = 0;
    for (var ci = 0; ci < prog.items.length; ci++) {
      var item = prog.items[ci];
      var chord = chordAt(keyPc, scaleId, item.degree, item.acc, item.quality);
      for (var rep = 0; rep * rhythm.beats < item.beats; rep++) {
        var base = rep * rhythm.beats;
        for (var i = 0; i < rhythm.seq.length; i++) {
          var t = base + i / rhythm.perBeat;
          if (t >= item.beats) continue;
          events.push({
            beat: beat + t,
            chordIdx: ci,
            chord: chord,
            ev: rhythm.seq[i],
            slot: i
          });
        }
      }
      beat += item.beats;
    }
    return { events: events, totalBeats: beat };
  }

  /* ============================ 和弦指法 ============================ */
  var voicingCache = {};

  /* 挑一个「最像人手按的」指法。
     注意不能只挑发声弦最多的：那样会选中 5-0-2-2-1-0 这种（六弦五品的 A 音当低音）
     不常规的按法，而我们要的是 x02210 / xx0232 / x32010 这类常规开弦按法。
     所以按「开弦多、品位低、跨度小、发声弦够多」打个分，取最高分。 */
  function voicingScore(v) {
    var open = 0, fretSum = 0, sounding = 0;
    for (var s = 0; s < 6; s++) {
      if (v.frets[s] < 0) continue;
      sounding++;
      if (v.frets[s] === 0) open++;
      else fretSum += v.frets[s];
    }
    return sounding * 2 - fretSum * 0.6 - v.spanUsed * 0.8 + open * 1.2;
  }

  function pickVoicing(rootPc, qualityId, register) {
    var q = C.qualityById(qualityId);
    var minSounding = Math.min(4, q.intervals.length + 1);
    var lowList = C.searchVoicings(rootPc, q, { maxFret: 5, span: 4,
      minSounding: minSounding, bassIsRoot: true, maxResults: 120 });
    if (!lowList.length) {
      lowList = C.searchVoicings(rootPc, q, { maxFret: 12, span: 4,
        minSounding: minSounding, bassIsRoot: true, maxResults: 120 });
    }
    if (!lowList.length) {
      lowList = C.searchVoicings(rootPc, q, { maxFret: 24, span: 5,
        minSounding: 3, bassIsRoot: false, maxResults: 120 });
    }
    var best = null, bestScore = -1e9, i;
    if (!register || register === 'low') {
      for (i = 0; i < lowList.length; i++) {
        var sc = voicingScore(lowList[i]);
        if (sc > bestScore) { bestScore = sc; best = lowList[i]; }
      }
      return best;
    }
    /* 中/高把位：在 5 品跨度内找离目标把位最近的常规指法 */
    var target = (register === 'high') ? 10 : 6;
    var list = C.searchVoicings(rootPc, q, {
      maxFret: register === 'high' ? 18 : 14, span: 5,
      minSounding: Math.min(4, q.intervals.length + 1),
      bassIsRoot: false, maxResults: 3000
    });
    if (!list.length) list = lowList;
    /* 先把“中/高”真正限制在对应把位区间，避免又选回开放把位 */
    var wantMin = (register === 'high') ? 8 : 4;
    var wantMax = (register === 'high') ? 14 : 10;
    var inRange = [];
    for (i = 0; i < list.length; i++) {
      if (list[i].position >= wantMin && list[i].position <= wantMax) inRange.push(list[i]);
    }
    if (inRange.length) list = inRange;
    /* 中/高把位优先不含空弦的封闭指法，和“把位”的直觉一致 */
    var closed = [];
    for (i = 0; i < list.length; i++) if (!list[i].hasOpen) closed.push(list[i]);
    if (closed.length) list = closed;
    for (i = 0; i < list.length; i++) {
      var s2 = voicingScore(list[i]) - Math.abs(list[i].position - target) * 2.2;
      if (s2 > bestScore) { bestScore = s2; best = list[i]; }
    }
    return best;
  }

  function voicingFor(chord, register) {
    var reg = register || live.register || 'low';
    var key = chord.rootPc + ':' + chord.qualityId + ':' + reg;
    if (voicingCache[key] === undefined) {
      voicingCache[key] = pickVoicing(chord.rootPc, chord.qualityId, reg);
    }
    return voicingCache[key];
  }

  /* 根音在第几弦：取「发声的最低那根弦里音高等于根音」的一根 */
  function rootString(v, rootPc) {
    for (var s = 0; s < 6; s++) {
      if (v.frets[s] < 0) continue;
      if (C.pcAt(s, v.frets[s]) === M.mod12(rootPc)) return s;
    }
    return -1;
  }

  /* ============================ 发声 ============================ */
  function playEvent(ctx, out, when, ev, voicing, amp, opts) {
    opts = opts || {};
    if (!voicing || ev.ev === '-') return;
    var i, s, midi;
    if (ev.ev === 'X') {                       /* 切音：短促闷音 */
      A.mute(ctx, out, when, amp);
      return;
    }
    if (ev.ev === 'D' || ev.ev === 'U') {      /* 扫弦：从低到高 / 从高到低 */
      var order = [];
      for (i = 0; i < 6; i++) if (voicing.frets[i] >= 0) order.push(i);
      if (ev.ev === 'U') order.reverse();
      for (i = 0; i < order.length; i++) {
        s = order[i];
        midi = C.midiAt(s, voicing.frets[s]);
        A.pluck(ctx, out, when + i * 0.011, midi, 1.5,
          amp * (ev.ev === 'U' ? 0.70 : 0.95), opts);
      }
      return;
    }
    /* 分解：R 找根音弦，数字是弦号（1 = 最细的弦） */
    s = (ev.ev === 'R') ? rootString(voicing, ev.chord.rootPc) : (6 - Number(ev.ev));
    if (s === undefined || s < 0 || s > 5) return;
    if (voicing.frets[s] < 0) return;          /* 这根弦在这个和弦里是闷的，跳过 */
    midi = C.midiAt(s, voicing.frets[s]);
    A.pluck(ctx, out, when, midi, 1.8, amp * 0.78, opts);
  }

  /* ============================ 引擎 ============================ */
  var live = {
    prog: null,
    rhythm: null,
    keyPc: 0,
    scaleId: 'major',
    register: 'low',
    volume: 1,
    enabled: false,
    plan: null,
    scheduledBars: 0,
    gain: null,
    chordCursor: 0,
    beatCursor: 0,
    chordSeconds: 0
  };

  function resetBackingCursor() {
    live.chordCursor = 0;
    live.beatCursor = 0;
    live.chordSeconds = 0;
  }

  function progressionBeats(prog) {
    var total = 0;
    for (var i = 0; i < prog.items.length; i++) {
      total += Math.max(1, Number(prog.items[i].beats) || 4);
    }
    return total;
  }

  /* 当前绝对拍落在走向的哪个和弦、和弦内第几拍。 */
  function chordAtBeat(prog, beat) {
    var acc = 0;
    for (var i = 0; i < prog.items.length; i++) {
      var beats = Math.max(1, Number(prog.items[i].beats) || 4);
      if (beat < acc + beats) {
        return { idx: i, item: prog.items[i], offset: beat - acc, beats: beats };
      }
      acc += beats;
    }
    return null;
  }

  var CHUNK_BEATS = 1;

  var engine = {
    nextTime: null,
    enabled: function () { return live.enabled && !!live.prog && !!live.rhythm; },
    barSeconds: function (bpm) {
      if (live.chordSeconds > 0) return live.chordSeconds;
      return 4 * 60 / bpm;
    },
    scheduleBar: function (ctx, out, startTime, bpm) {
      if (!live.prog || !live.rhythm) return;
      /* 不再一次排完整和弦：4 拍扫弦 = 8 次 × 6 弦 × 多个泛音，
         手机上会瞬间创建几百个振荡器，表现为哑音/丢音。一次只排 1 拍，
         音符数量降一个数量级，伴奏也更清楚。 */
      if (!live.gain || live.gain.context !== ctx) {
        live.gain = ctx.createGain();
        live.gain.gain.value = live.volume;
        live.gain.connect(out);
      }
      if (!live.plan) live.plan = buildPlan(live.prog, live.rhythm, live.keyPc, live.scaleId);
      var total = progressionBeats(live.prog);
      if (!total) return;
      var beat = live.beatCursor % total;
      var pos = chordAtBeat(live.prog, beat);
      if (!pos) return;
      var chunk = Math.min(CHUNK_BEATS, pos.beats - pos.offset);
      if (chunk < 0.25) chunk = 0.25;
      var endBeat = beat + chunk;
      var secPerBeat = 60 / bpm;
      live.scheduledBars++;
      for (var i = 0; i < live.plan.events.length; i++) {
        var ev = live.plan.events[i];
        if (ev.chordIdx !== pos.idx) continue;
        if (ev.beat < beat - 1e-6 || ev.beat >= endBeat - 1e-6) continue;
        var when = startTime + (ev.beat - beat) * secPerBeat;
        var v = voicingFor(ev.chord);
        playEvent(ctx, live.gain, when, ev, v, 1, { lite: true });
        T.push({ source: 'backing', time: when, beat: ev.beat, chordIdx: ev.chordIdx,
                 ev: ev.ev, slot: ev.slot, chord: ev.chord });
      }
      live.chordSeconds = chunk * secPerBeat;
      live.chordCursor = pos.idx;
      live.beatCursor = (beat + chunk) % total;
    }
  };
  if (T) T.register(engine);

  function configure(prog, rhythm, keyPc, scaleId, register) {
    live.prog = prog;
    live.rhythm = rhythm;
    live.keyPc = keyPc;
    live.scaleId = scaleId;
    live.register = register || 'low';
    live.plan = buildPlan(prog, rhythm, keyPc, scaleId);
    resetBackingCursor();
  }
  function setEnabled(on) {
    live.enabled = !!on;
    engine.nextTime = null;
    if (on) resetBackingCursor();
  }
  function setVolume(v) {
    live.volume = Math.max(0, Math.min(1.2, Number(v) || 0));
    if (live.gain) {
      try { live.gain.gain.value = live.volume; } catch (e) {}
    }
  }
  function setRegister(reg) { live.register = reg || 'low'; engine.nextTime = null; }

  /* 离线渲染：给测试用（把一整个走向渲染成音频） */
  function renderOffline(prog, rhythm, keyPc, scaleId, opts, seconds) {
    opts = opts || {};
    var sampleRate = opts.sampleRate || 22050;
    var bpm = opts.bpm || 100;
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) return null;
    var ctx = new OAC(1, Math.max(1, Math.floor(sampleRate * seconds)), sampleRate);
    var out = A.masterChain ? A.masterChain(ctx, 0.35) : ctx.createGain();
    if (!A.masterChain) out.connect(ctx.destination);
    var plan = buildPlan(prog, rhythm, keyPc, scaleId);
    var secPerBeat = 60 / bpm;
    for (var i = 0; i < plan.events.length; i++) {
      var ev = plan.events[i];
      playEvent(ctx, out, ev.beat * secPerBeat, ev,
        voicingFor(ev.chord, opts.register), (opts.volume === undefined ? 0.9 : opts.volume));
    }
    return ctx.startRendering().then(function (buf) { return buf.getChannelData(0); });
  }

  global.Backing = {
    RHYTHMS: RHYTHMS,
    PROGRESSIONS: PROGRESSIONS,
    ARP_SLOTS: ARP_SLOTS,
    STRUM_SLOTS: STRUM_SLOTS,
    SLOT_ZH: SLOT_ZH,
    rhythmById: rhythmById,
    progressionById: progressionById,
    cloneRhythm: cloneRhythm,
    cloneProgression: cloneProgression,
    slots: slots,
    validateRhythm: validateRhythm,
    validateProgression: validateProgression,
    chordAt: chordAt,
    chordName: chordName,
    buildPlan: buildPlan,
    voicingFor: voicingFor,
    rootString: rootString,
    configure: configure,
    setEnabled: setEnabled,
    setVolume: setVolume,
    setRegister: setRegister,
    register: function () { return live.register; },
    isEnabled: function () { return live.enabled; },
    volume: function () { return live.volume; },
    state: live,
    renderOffline: renderOffline,
    plan: function () { return live.plan; },
    _engine: engine
  };
})(window);
