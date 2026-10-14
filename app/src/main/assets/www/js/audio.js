/*!
 * audio.js —— 试听：用 WebAudio 现场合成“拨弦”音色，无需任何音频素材。
 * 单音模型：三角波基频 + 二次谐波（锯齿）+ 拨片噪声瞬态，经低通 + 指数衰减包络。
 */
(function (global) {
  'use strict';

  var ctx = null;
  var noiseBuffer = null;

  function getCtx() {
    if (ctx) {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return ctx;
    }
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch (e) {
      return null;
    }
    return ctx;
  }

  function getNoise(c) {
    if (noiseBuffer) return noiseBuffer;
    var len = Math.floor(c.sampleRate * 0.05);
    noiseBuffer = c.createBuffer(1, len, c.sampleRate);
    var data = noiseBuffer.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    return noiseBuffer;
  }

  /* 拨一根弦 */
  function pluck(when, midi, dur, amp) {
    var c = getCtx();
    if (!c) return;
    var freq = global.Music.midiToFreq(midi);

    var out = c.createGain();
    out.gain.value = amp;
    out.connect(c.destination);

    var env = c.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(1, when + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    env.connect(out);

    var lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(c.sampleRate / 2 - 500, freq * 9), when);
    lp.frequency.exponentialRampToValueAtTime(Math.max(220, freq * 2.2), when + dur * 0.9);
    lp.Q.value = 0.6;
    lp.connect(env);

    var o1 = c.createOscillator();
    o1.type = 'triangle';
    o1.frequency.value = freq;
    var g1 = c.createGain();
    g1.gain.value = 1.0;
    o1.connect(g1);
    g1.connect(lp);

    var o2 = c.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.value = freq * 2.0;
    var g2 = c.createGain();
    g2.gain.value = 0.16;
    o2.connect(g2);
    g2.connect(lp);

    /* 拨片噪声瞬态 */
    var src = c.createBufferSource();
    src.buffer = getNoise(c);
    var hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = Math.min(c.sampleRate / 2 - 500, freq * 3);
    var ng = c.createGain();
    ng.gain.setValueAtTime(0.35 * amp, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    src.connect(hp);
    hp.connect(ng);
    ng.connect(c.destination);

    o1.start(when); o2.start(when); src.start(when);
    o1.stop(when + dur + 0.05); o2.stop(when + dur + 0.05);
  }

  /* 扫弦播放一个指法：低音弦 -> 高音弦，依次延迟一点，模拟下拨 */
  function playVoicing(v, options) {
    var opts = options || {};
    var c = getCtx();
    if (!c || !v) return;
    var t0 = c.currentTime + (opts.delay === undefined ? 0.04 : opts.delay);
    var dur = opts.dur || 2.8;
    var strum = (opts.strum === undefined) ? 0.032 : opts.strum;

    var idx = 0;
    for (var s = 0; s < 6; s++) {
      var f = v.frets[s];
      if (f < 0) continue;
      var midi = global.Chord.midiAt(s, f);
      /* 低音弦（s 小）稍微响一点，音量差别不超过 3dB，避免整体不平衡 */
      var amp = 0.30 + (5 - s) * 0.02;
      pluck(t0 + idx * strum, midi, dur, amp);
      idx++;
    }
  }

  global.Audio_ = {
    playVoicing: playVoicing,
    supported: function () { return !!(global.AudioContext || global.webkitAudioContext); }
  };
})(window);
