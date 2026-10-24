/*!
 * audio.js —— 吉他音色：拨弦合成（支持多种音色与演奏技巧）
 *
 * 三种用法：
 *   pluck(ctx, out, when, midi, dur, amp)                 基础拨弦（和弦试听、伴奏都走它）
 *   pluck(ctx, out, when, midi, dur, amp, {tone, tech})    指定音色与技巧（即兴旋律用）
 *   playVoicing(v, opts)                                  和弦试听：按 6→1 弦扫下来
 *
 * 音色不是只换波形：每种音色有自己的泛音配比、衰减速度、琴体共振、拨片噪声和效果链。
 *   acoustic      民谣钢弦：明亮泛音 + 较快的高次衰减 + 木质琴体
 *   classical     古典尼龙：基音厚、泛音少、拨片声轻、衰减快
 *   electric      电吉他清音：长延音、轻微合唱失谐、拾音器式中频
 *   drive         电吉他过载：软削波 + 箱体低通，有颗粒但还能听清音高
 *   distortion    电吉他失真：更深的削波、更长的延音、更窄的箱体
 *   jazz          爵士空心：基音和二次谐波为主，暗而圆
 *
 * 技巧（tech，用于即兴旋律的衔接）：
 *   slide   滑音：从低 2 个半音滑上来
 *   bend    推弦：从低 2 个半音更快地推上来
 *   hammer / pull 击弦 / 勾弦：前面加一个很快的低 2 半音装饰音
 *   vib     揉弦：延迟起振的频率颤音
 */
(function (global) {
  'use strict';

  var ctx = null;

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

  /* 噪声缓冲按上下文缓存（缓冲区不能跨上下文混用） */
  function noise(c, dur) {
    var key = '__chordNoise';
    var buf = c[key];
    if (!buf || buf.duration < dur) {
      var len = Math.max(1, Math.floor(c.sampleRate * Math.max(dur, 0.06)));
      buf = c.createBuffer(1, len, c.sampleRate);
      var d = buf.getChannelData(0);
      /* 固定种子的伪随机噪声：每次构建音色/跑离线测试的结果一致，
         同时保留拨片噪声该有的无规律质感。 */
      var seed = 0x1a2b3c4d;
      for (var i = 0; i < len; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        d[i] = (seed / 2147483648 - 1) * (1 - i / len);
      }
      c[key] = buf;
    }
    var src = c.createBufferSource();
    src.buffer = buf;
    return src;
  }

  /* 软削波曲线（电吉他过载/失真）。加一点直流偏置，产生偶次谐波，
     听感比纯对称 tanh 更像电子管/音箱，而不是闷住的“du”。 */
  function driveCurve(amount) {
    var n = 2048, curve = new Float32Array(n);
    var bias = 0.16;
    var norm = Math.max(0.0001, (Math.tanh(amount + bias) - Math.tanh(-amount + bias)) / 2);
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = (Math.tanh(x * amount + bias) - Math.tanh(bias)) / norm;
    }
    return curve;
  }

  /* 总线末端的软限幅：多个音同时响时，峰值不能直接捅到扬声器。 */
  function softClipCurve() {
    var n = 2048, curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
    }
    return curve;
  }

  /* 试听/离线渲染用的输出总线：只做增益 + 软限幅，不引入压缩器延迟。
     实时伴奏/即兴另有 Transport 的母带压缩与限幅。 */
  function masterChain(c, gain) {
    var input = c.createGain();
    input.gain.value = (gain === undefined) ? 1 : gain;
    var clip = c.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = 'none';
    input.connect(clip);
    clip.connect(c.destination);
    return input;
  }

  /* 每种音色的“弦”参数：
     partials 是第 1~8 次谐波的相对音量；decayBase/Slope 决定高次泛音衰减得多快；
     body 是琴体共振峰；pick 是拨片噪声；chorus 是轻微失谐（音分）。 */
  var TONES = {
    acoustic: {
      partials: [1, 0.62, 0.40, 0.25, 0.15, 0.09, 0.05],
      attack: 0.0035, decayBase: 0.98, decaySlope: 0.11,
      hp: 65, body: 118, bodyQ: 0.9, bodyGain: 2.0, q: 0.75,
      lpBase: 2600, lpRatio: 6.8, lpEndRatio: 0.55,
      eq: [{ freq: 180, gain: 2.0, q: 1.0 }, { freq: 3400, gain: 2.5, q: 1.2 }],
      pick: 0.85, pickFreq: 2600, pickQ: 1.0, pickDecay: 0.06, thump: 0.42,
      chorus: 2.5, chorusPartials: 3, output: 0.52, inharmonicity: 0.00012
    },
    classical: {
      partials: [1, 0.50, 0.27, 0.14, 0.07, 0.035],
      attack: 0.006, decayBase: 0.84, decaySlope: 0.10,
      hp: 72, body: 105, bodyQ: 1.0, bodyGain: 3.4, q: 0.65,
      lpBase: 1500, lpRatio: 4.0, lpEndRatio: 0.50,
      eq: [{ freq: 240, gain: 1.8, q: 1.0 }],
      pick: 0.10, pickFreq: 1700, pickQ: 0.7, pickDecay: 0.04, thump: 0.26,
      chorus: 0, chorusPartials: 0, output: 0.58, inharmonicity: 0.00008
    },
    electric: {
      partials: [1, 0.58, 0.42, 0.30, 0.20, 0.13, 0.08, 0.05],
      attack: 0.0025, decayBase: 1.45, decaySlope: 0.10,
      hp: 95, body: 155, bodyQ: 0.8, bodyGain: 1.4, q: 0.85,
      lpBase: 1800, lpRatio: 5.0, lpEndRatio: 0.50,
      eq: [{ freq: 700, gain: -3.2, q: 0.8 }, { freq: 2500, gain: 2.2, q: 1.0 }],
      pick: 0.35, pickFreq: 3000, pickQ: 1.2, pickDecay: 0.03, thump: 0.38,
      chorus: 8, chorusPartials: 4, output: 0.55, inharmonicity: 0.00010
    },
    drive: {
      partials: [1, 0.65, 0.50, 0.38, 0.28, 0.20, 0.14, 0.10],
      attack: 0.0025, decayBase: 1.50, decaySlope: 0.08,
      hp: 110, body: 180, bodyQ: 0.8, bodyGain: 1.4, q: 1.0,
      lpBase: 2400, lpRatio: 5.8, lpEndRatio: 0.50, cabLP: 4200,
      presence: { freq: 2300, gain: 3.0, q: 1.0 },
      pick: 0.28, pickFreq: 2400, pickQ: 1.1, pickDecay: 0.03, thump: 0.48,
      drive: 4.0, preGain: 2.2, postGain: 0.45,
      chorus: 4, chorusPartials: 4, output: 0.54, inharmonicity: 0.00010
    },
    distortion: {
      partials: [1, 0.70, 0.55, 0.45, 0.36, 0.28, 0.20, 0.14],
      attack: 0.002, decayBase: 1.65, decaySlope: 0.07,
      hp: 120, body: 200, bodyQ: 0.7, bodyGain: 0.7, q: 0.9,
      lpBase: 2200, lpRatio: 6.2, lpEndRatio: 0.45, cabLP: 4500,
      presence: { freq: 2800, gain: 4.5, q: 1.0 },
      pick: 0.36, pickFreq: 2400, pickQ: 1.0, pickDecay: 0.028, thump: 0.58,
      drive: 12, preGain: 3.2, postGain: 0.38,
      chorus: 3, chorusPartials: 4, output: 0.55, inharmonicity: 0.00010
    },
    jazz: {
      partials: [1, 0.48, 0.26, 0.14, 0.07, 0.035],
      attack: 0.004, decayBase: 0.90, decaySlope: 0.11,
      hp: 80, body: 135, bodyQ: 1.1, bodyGain: 3.0, q: 0.7,
      lpBase: 1400, lpRatio: 4.0, lpEndRatio: 0.45,
      eq: [{ freq: 400, gain: 1.4, q: 1.0 }, { freq: 2000, gain: -1.5, q: 1.0 }],
      pick: 0.12, pickFreq: 1700, pickQ: 0.8, pickDecay: 0.04, thump: 0.30,
      chorus: 2, chorusPartials: 3, output: 0.56, inharmonicity: 0.00008
    }
  };

  function toneSpec(name) {
    return TONES[name] || TONES.acoustic;
  }

  /**
   * 拨一根弦（可带音色与技巧）
   * @param {AudioContext} c
   * @param {AudioNode} out
   * @param {number} when 起始时刻
   * @param {number} midi 音高
   * @param {number} dur 衰减时长（秒）
   * @param {number} amp 音量
   * @param {object} [opts] {tone, tech}
   */
  function pluck(c, out, when, midi, dur, amp, opts) {
    if (!c || !out) return;
    opts = opts || {};
    var tone = toneSpec(opts.tone);
    var tech = opts.tech || 'none';
    var freq = global.Music.midiToFreq(midi);
    var nyq = c.sampleRate / 2;
    var start = Math.max(0, when);

    /* 滑音 / 推弦：从低 2 个半音滑上来 */
    var glideFrom = 0;
    var glideTime = 0;
    if (tech === 'slide') {
      glideFrom = freq * Math.pow(2, -2 / 12);
      glideTime = 0.09;
      start = Math.max(0, when - 0.02);
    } else if (tech === 'bend') {
      glideFrom = freq * Math.pow(2, -2 / 12);
      glideTime = 0.06;
      start = Math.max(0, when - 0.01);
    }

    /* 单音总输出：所有泛音先求和，再经过这一级的音色/音量 */
    var voice = c.createGain();
    voice.gain.value = tone.output;
    voice.connect(out);

    var hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = Math.min(nyq - 100, tone.hp);
    hp.Q.value = 0.7;

    var body = c.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = tone.body;
    body.Q.value = tone.bodyQ;
    body.gain.value = tone.bodyGain;

    var lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = tone.q;
    var cutoff = Math.min(nyq - 500,
      Math.max(900, freq * tone.lpRatio + tone.lpBase));
    if (tone.cabLP) cutoff = Math.min(cutoff, tone.cabLP);
    lp.frequency.setValueAtTime(cutoff, start);
    lp.frequency.exponentialRampToValueAtTime(
      Math.max(600, cutoff * tone.lpEndRatio),
      start + Math.max(0.06, Math.min(dur, 1.6)));
    var eqTail = lp;
    if (tone.eq) {
      for (var ei = 0; ei < tone.eq.length; ei++) {
        var e = c.createBiquadFilter();
        e.type = 'peaking';
        e.frequency.value = tone.eq[ei].freq;
        e.Q.value = tone.eq[ei].q || 1;
        e.gain.value = tone.eq[ei].gain;
        eqTail.connect(e);
        eqTail = e;
      }
    }
    eqTail.connect(body);
    body.connect(hp);
    hp.connect(voice);

    /* 过载/失真：先推电平，再削波，再进箱体低通。 */
    var toneIn = lp;
    if (tone.drive) {
      var pre = c.createGain();
      pre.gain.value = tone.preGain;
      var shaper = c.createWaveShaper();
      shaper.curve = driveCurve(tone.drive);
      shaper.oversample = '2x';
      var post = c.createGain();
      post.gain.value = tone.postGain;
      pre.connect(shaper);
      shaper.connect(post);
      if (tone.presence) {
        var pr = c.createBiquadFilter();
        pr.type = 'peaking';
        pr.frequency.value = tone.presence.freq;
        pr.Q.value = tone.presence.q;
        pr.gain.value = tone.presence.gain;
        post.connect(pr);
        pr.connect(lp);
      } else {
        post.connect(lp);
      }
      toneIn = pre;
    }

    var oscs = [];
    var partialLimit = Math.min(tone.partials.length,
      opts.maxPartials || (opts.lite ? 5 : tone.partials.length));
    var sum = 0, j;
    for (j = 0; j < partialLimit; j++) sum += tone.partials[j];
    if (sum <= 0) sum = 1;

    /* 每个音按音高/时刻错开一个很短的起振相位：同一和弦连续扫弦时，
       如果每次都从相位 0 开始，前一下的余音会和这一下部分抵消，听起来像“没起音”。 */
    var jitterSeed = (Math.floor(when * 1000) * 131 + midi * 17) % 997;
    var phaseJitter = (jitterSeed / 997) * Math.min(0.0035, 1 / freq);
    var oscStart = Math.max(0, start - phaseJitter);

    /* 每个泛音有自己的包络：高次泛音衰减更快，听起来才像拨弦而不是电子音。 */
    for (j = 0; j < partialLimit; j++) {
      var n = j + 1;
      var f = freq * n * (1 + (tone.inharmonicity || 0) * n * n);
      if (f > nyq * 0.92) break;
      var peak = amp * (tone.partials[j] / sum);
      var decay = Math.max(0.09, Math.min(3.2,
        dur * (tone.decayBase - j * tone.decaySlope)));
      var attack = tone.attack * (1 + j * 0.18);

      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, start + decay);
      g.connect(toneIn);

      var o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(glideFrom ? glideFrom * n : f, start);
      if (glideFrom) o.frequency.exponentialRampToValueAtTime(f, start + glideTime);
      o.connect(g);
      oscs.push({ osc: o, start: oscStart, stop: start + decay + 0.05 });

      /* 清音/过载加一点失谐副音，产生合唱和弦的厚度；不是每个泛音都加，避免糊。
         伴奏的 lite 模式关掉 chorus：整串扫弦时它会成倍增加振荡器。 */
      if (tone.chorus && !opts.lite && j < tone.chorusPartials) {
        var og = c.createGain();
        var op = peak * 0.30;
        og.gain.setValueAtTime(0.0001, start);
        og.gain.exponentialRampToValueAtTime(Math.max(0.0002, op), start + attack);
        og.gain.exponentialRampToValueAtTime(0.0001, start + decay);
        og.connect(toneIn);
        var o2 = c.createOscillator();
        o2.type = 'sine';
        o2.detune.value = tone.chorus;
        o2.frequency.setValueAtTime(glideFrom ? glideFrom * n : f, start);
        if (glideFrom) o2.frequency.exponentialRampToValueAtTime(f, start + glideTime);
        o2.connect(og);
        oscs.push({ osc: o2, start: oscStart, stop: start + decay + 0.05 });
      }
    }

    /* 击弦 / 勾弦：45ms 的低二度装饰音。 */
    if (tech === 'hammer' || tech === 'pull') {
      var gnote = c.createOscillator();
      gnote.type = 'sine';
      gnote.frequency.setValueAtTime(freq * Math.pow(2, -2 / 12), start);
      gnote.frequency.exponentialRampToValueAtTime(freq, start + 0.045);
      var gng = c.createGain();
      gng.gain.setValueAtTime(0.0001, start);
      gng.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * 0.36), start + 0.004);
      gng.gain.exponentialRampToValueAtTime(0.0001, start + 0.07);
      gnote.connect(gng);
      gng.connect(toneIn);
      oscs.push({ osc: gnote, start: start, stop: start + 0.09 });
    }

    /* 揉弦：延迟 0.12s 后加 5.5Hz 的频率颤音。 */
    if (tech === 'vib') {
      var lfo = c.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 5.5;
      var lfoGain = c.createGain();
      lfoGain.gain.setValueAtTime(0, start);
      lfoGain.gain.linearRampToValueAtTime(freq * 0.012, start + 0.12);
      lfo.connect(lfoGain);
      for (var k = 0; k < oscs.length; k++) lfoGain.connect(oscs[k].osc.frequency);
      oscs.push({ osc: lfo, start: start, stop: start + dur + 0.05 });
    }

    /* 拨片噪声瞬态：钢弦最明显，尼龙和爵士轻一些。 */
    var src = noise(c, 0.06);
    var bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(nyq - 300, tone.pickFreq);
    bp.Q.value = tone.pickQ;
    var ng = c.createGain();
    ng.gain.setValueAtTime(Math.max(0.0002, tone.pick * amp), start);
    ng.gain.exponentialRampToValueAtTime(0.0001, start + tone.pickDecay);
    src.connect(bp);
    bp.connect(ng);
    /* 拨片噪声走干声，不再被琴体/箱体滤波吃掉；这是“起音”的关键。 */
    ng.connect(voice);

    /* 琴体“咚”的一下：低频短噪声，和相位无关，连续扫弦时也能听出起音。 */
    var thump = noise(c, 0.09);
    var tlp = c.createBiquadFilter();
    tlp.type = 'lowpass';
    tlp.frequency.value = 260;
    tlp.Q.value = 0.8;
    var tg = c.createGain();
    tg.gain.setValueAtTime(Math.max(0.0002, tone.thump * amp), start);
    tg.gain.exponentialRampToValueAtTime(0.0001, start + 0.055);
    thump.connect(tlp);
    tlp.connect(tg);
    tg.connect(voice);

    if (global.Voices) {
      for (var q = 0; q < oscs.length; q++) global.Voices.track(oscs[q].osc, c);
      global.Voices.track(src, c);
      global.Voices.track(thump, c);
    }
    for (q = 0; q < oscs.length; q++) {
      oscs[q].osc.start(oscs[q].start);
      oscs[q].osc.stop(oscs[q].stop);
    }
    src.start(start);
    thump.start(start);
  }

  /* 切音：把弦闷住的一声短促噪声 */
  function mute(c, out, when, amp) {
    if (!c || !out) return;
    var src = noise(c, 0.06);
    var lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    var g = c.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, amp * 0.5), when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
    src.connect(lp);
    lp.connect(g);
    g.connect(out);
    if (global.Voices) global.Voices.track(src, c);
    src.start(when);
  }

  /* 和弦试听：按 6→1 弦扫下来 */
  function playVoicing(v, options) {
    var c = getCtx();
    if (!c || !v) return;
    var opts = options || {};
    var out = masterChain(c, 0.65);
    var t0 = c.currentTime + (opts.delay === undefined ? 0.04 : opts.delay);
    var dur = opts.dur || 2.8;
    var strum = (opts.strum === undefined) ? 0.032 : opts.strum;
    var idx = 0;
    for (var s = 0; s < 6; s++) {
      var f = v.frets[s];
      if (f < 0) continue;
      var midi = global.Chord.midiAt(s, f);
      pluck(c, out, t0 + idx * strum, midi, dur, 0.30 + (5 - s) * 0.02,
        { tone: opts.tone || 'acoustic' });
      idx++;
    }
  }

  /* 音色试听：几个音就能听出钢弦/尼龙/清音/过载/失真/爵士的差别。 */
  function previewTone(id) {
    var c = getCtx();
    if (!c) return false;
    var out = masterChain(c, 0.72);
    var t0 = c.currentTime + 0.04;
    var notes = [60, 64, 67, 72];
    for (var i = 0; i < notes.length; i++) {
      pluck(c, out, t0 + i * 0.20, notes[i], 0.62, 0.52, { tone: id || 'electric' });
    }
    return true;
  }

  global.Audio_ = {
    pluck: pluck,
    mute: mute,
    playVoicing: playVoicing,
    previewTone: previewTone,
    masterChain: masterChain,
    getCtx: getCtx,
    TONES: TONES,
    toneNames: function () {
      return [
        { id: 'acoustic', zh: '民谣钢弦' },
        { id: 'classical', zh: '古典尼龙' },
        { id: 'electric', zh: '电吉他清音' },
        { id: 'drive', zh: '电吉他过载' },
        { id: 'distortion', zh: '电吉他失真' },
        { id: 'jazz', zh: '爵士空心' }
      ];
    },
    supported: function () { return !!(global.AudioContext || global.webkitAudioContext); }
  };
})(window);
