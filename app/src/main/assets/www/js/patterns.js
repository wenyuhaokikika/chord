/*!
 * patterns.js —— 鼓机节奏库
 *
 * 每个节奏就是一串「第几拍打什么」的数据：
 *   steps   一小节切成多少格（4/4 常用 16 格 = 十六分音符；3/4 用 12 格；6/8 用 12 格）
 *   beats   一小节算几拍（BPM 指的是这个拍）。4/4 -> 4；3/4 -> 3；6/8 -> 6（按八分算）
 *   hits    每个鼓件在第几格敲一下
 *   accents 需要加重音的那几格（1.4 倍音量，做出强弱拍）
 *   swing   摇摆比例：0.5 = 直，0.667 = 三连音摇摆（布鲁斯/爵士）；引擎只延后「反拍八分」
 *
 * 鼓件（与 drums.js 里的合成函数一一对应）：
 *   kick 底鼓 / snare 军鼓 / hat 闭镲 / open 开镲 / crash 吊镲 / click 节拍器音
 */
(function (global) {
  'use strict';

  var INSTRUMENTS = [
    { id: 'kick', zh: '底鼓', key: 'kick' },
    { id: 'snare', zh: '军鼓', key: 'snare' },
    { id: 'hat', zh: '闭镲', key: 'hat' },
    { id: 'open', zh: '开镲', key: 'open' },
    { id: 'crash', zh: '吊镲', key: 'crash' },
    { id: 'click', zh: '节拍器', key: 'click' }
  ];

  /* 4/4 的十六分格：0-3 是第一拍（1 e & a），4-7 第二拍…… */

  var LIST = [
    {
      id: 'click41', zh: '节拍器', en: 'Click 4/4', sig: '4/4', steps: 16, beats: 4, bpm: 90, swing: 0.5,
      hits: { click: [0, 4, 8, 12] },
      accents: { click: [0] },
      tip: '只要一个干净的拍点，适合练音阶、对节拍'
    },
    {
      id: 'rock', zh: '基础摇滚', en: 'Basic Rock', sig: '4/4', steps: 16, beats: 4, bpm: 100, swing: 0.5,
      hits: { kick: [0, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
      accents: { hat: [0, 4, 8, 12] },
      tip: '底鼓 1、3 拍，军鼓 2、4 拍——最通用的四四拍'
    },
    {
      id: 'rock8', zh: '八分摇滚', en: 'Eighth Rock', sig: '4/4', steps: 16, beats: 4, bpm: 120, swing: 0.5,
      hits: { kick: [0, 6, 8, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], open: [14] },
      accents: { hat: [0, 4, 8, 12] },
      tip: '连续八分闭镲、收尾开镲，扫弦练习的常用背景'
    },
    {
      id: 'pop', zh: '流行 · 民谣', en: 'Pop / Folk', sig: '4/4', steps: 16, beats: 4, bpm: 92, swing: 0.5,
      hits: { kick: [0, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
      accents: { hat: [0, 4, 8, 12] },
      tip: '底鼓加在第三拍后半，弹唱伴奏最常见的律动'
    },
    {
      id: 'ballad', zh: '抒情慢歌', en: 'Ballad', sig: '4/4', steps: 16, beats: 4, bpm: 70, swing: 0.5,
      hits: { kick: [0], snare: [8], hat: [0, 4, 8, 12] },
      accents: { hat: [0] },
      tip: '一半的密度：底鼓在 1、军鼓在 3，适合慢歌分解和弦'
    },
    {
      id: 'halftime', zh: '半拍摇滚', en: 'Half-time', sig: '4/4', steps: 16, beats: 4, bpm: 84, swing: 0.5,
      hits: { kick: [0, 10], snare: [8], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
      accents: { hat: [0, 4, 8, 12] },
      tip: '军鼓落在第 3 拍，听感比实际速度慢一半，适合氛围型歌曲'
    },
    {
      id: 'blues', zh: '蓝调摇摆', en: 'Blues Shuffle', sig: '4/4', steps: 16, beats: 4, bpm: 96, swing: 0.667,
      hits: { kick: [0, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
      accents: { hat: [0, 4, 8, 12] },
      tip: '三连音摇摆（shuffle），十二小节布鲁斯的标配'
    },
    {
      id: 'funk', zh: '放克十六分', en: 'Funk 16th', sig: '4/4', steps: 16, beats: 4, bpm: 96, swing: 0.5,
      hits: {
        kick: [0, 7, 10],
        snare: [4, 12, 6, 14],
        hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
      },
      accents: { snare: [4, 12], hat: [0, 3, 4, 7, 8, 11, 12, 15] },
      tip: '十六分闭镲 + 反拍军鼓（ghost note），练切分与闷音'
    },
    {
      id: 'reggae', zh: '雷鬼（One Drop）', en: 'Reggae', sig: '4/4', steps: 16, beats: 4, bpm: 76, swing: 0.5,
      hits: { kick: [8], snare: [8], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
      accents: { hat: [2, 6, 10, 14] },
      tip: '底鼓和军鼓同时落在第 3 拍，重音在反拍'
    },
    {
      id: 'bossa', zh: '波萨诺瓦', en: 'Bossa Nova', sig: '4/4', steps: 16, beats: 4, bpm: 130, swing: 0.5,
      hits: { kick: [0, 6, 8, 14], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
      accents: { hat: [2, 6, 10, 14] },
      tip: '轻快的拉丁律动，适合练右手分解'
    },
    {
      id: 'metal', zh: '金属 · 双踩', en: 'Metal', sig: '4/4', steps: 16, beats: 4, bpm: 140, swing: 0.5,
      hits: { kick: [0, 2, 4, 6, 8, 10, 12, 14], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], crash: [0] },
      accents: { snare: [4, 12] },
      tip: '八分连踩底鼓 + 每小节开头的吊镲，练强力和弦节奏'
    },
    {
      id: 'waltz', zh: '圆舞曲 3/4', en: 'Waltz', sig: '3/4', steps: 12, beats: 3, bpm: 120, swing: 0.5,
      hits: { kick: [0], snare: [4, 8], hat: [0, 2, 4, 6, 8, 10] },
      accents: { hat: [0, 4, 8] },
      tip: '「咚—恰恰」的三拍子，很多民谣与老歌用得到'
    },
    {
      id: 'blues68', zh: '六八拍蓝调', en: '6/8 Blues', sig: '6/8', steps: 12, beats: 6, bpm: 100, swing: 0.667,
      hits: { kick: [0, 6], snare: [2, 4, 8, 10], hat: [0, 2, 4, 6, 8, 10] },
      accents: { hat: [0, 6] },
      tip: '六八拍的摇摆律动（BPM 按八分算），慢速布鲁斯常用'
    }
  ];

  function byId(id) {
    for (var i = 0; i < LIST.length; i++) if (LIST[i].id === id) return LIST[i];
    return LIST[0];
  }

  /* 深拷贝一份，供用户点击格子后修改（内置预设保持原样） */
  function clone(p) {
    var out = { id: p.id, zh: p.zh, en: p.en, sig: p.sig, steps: p.steps, beats: p.beats,
                bpm: p.bpm, swing: p.swing, tip: p.tip, hits: {}, accents: {} };
    for (var k in p.hits) if (p.hits.hasOwnProperty(k)) out.hits[k] = p.hits[k].slice(0);
    if (p.accents) for (var a in p.accents) if (p.accents.hasOwnProperty(a)) out.accents[a] = p.accents[a].slice(0);
    return out;
  }

  function hitAt(pattern, instId, step) {
    var list = pattern.hits[instId];
    return !!list && list.indexOf(step) >= 0;
  }

  function isAccent(pattern, instId, step) {
    var list = pattern.accents && pattern.accents[instId];
    return !!list && list.indexOf(step) >= 0;
  }

  /* 校验：所有格子索引必须在范围内，且不应该重复（测试与调试用） */
  function validate(p) {
    var errs = [];
    for (var inst in p.hits) {
      if (!p.hits.hasOwnProperty(inst)) continue;
      var list = p.hits[inst], seen = {};
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (typeof s !== 'number' || s < 0 || s >= p.steps) errs.push(p.id + '.' + inst + ' 格子越界：' + s);
        else if (seen[s]) errs.push(p.id + '.' + inst + ' 重复：' + s);
        else seen[s] = 1;
      }
    }
    return errs;
  }

  global.Patterns = {
    INSTRUMENTS: INSTRUMENTS,
    LIST: LIST,
    byId: byId,
    clone: clone,
    hitAt: hitAt,
    isAccent: isAccent,
    validate: validate
  };
})(window);
