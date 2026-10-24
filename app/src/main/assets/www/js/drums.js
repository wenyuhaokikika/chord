/*!
 * drums.js —— 鼓机：合成音色 + 精确调度
 *
 * 音色全部现场合成（不需要任何音频文件）：
 *   底鼓 kick   正弦波 + 频率包络（150Hz 快速滑到 45Hz）+ 短噪声瞬态
 *   军鼓 snare  噪声（带通 ~1.8kHz）+ 185Hz 三角波鼓身
 *   闭镲 hat    噪声高通 ~7kHz，50ms 衰减
 *   开镲 open   同上但 300ms 衰减
 *   吊镲 crash  噪声高通 ~5kHz，1.2s 长衰减
 *   节拍器 click 1kHz/1.5kHz 短方波（重音用高音）
 *
 * 调度用「前瞻式」写法（A Tale of Two Clocks）：定时器只负责把未来 120ms 内的
 * 步提前排进 WebAudio 的时间轴，真正的发声时刻由音频时钟决定——所以不会因为
 * 主线程卡顿而抖拍。界面高亮则从队列里取「已经真的发声」的步，做到音画同步。
 *
 * 合成函数都接受 ctx 参数，所以既能跑实时 AudioContext，也能跑离线 OfflineAudioContext
 * ——自动化测试就是靠后者渲染一段音频再检查敲击时刻（见 tools/selftest.html）。
 */
(function (global) {
  'use strict';

  var P = global.Patterns;

  /* ---------------- 音色合成（ctx 无关） ---------------- */
  var LEVEL = { kick: 1.0, snare: 0.62, hat: 0.3, open: 0.28, crash: 0.4, click: 0.34 };

  function envGain(ctx, when, peak, decay) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    return g;
  }

  function noiseSource(ctx, dur) {
    var len = Math.max(1, Math.floor((ctx.sampleRate || 44100) * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate || 44100);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  function synthKick(ctx, when, out, amp) {
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.09);
    var g = envGain(ctx, when, amp * LEVEL.kick, 0.42);
    osc.connect(g);
    g.connect(out);
    if (global.Voices) global.Voices.track(osc, ctx);
    osc.start(when);
    osc.stop(when + 0.5);

    /* 一点“打点”噪声，让底鼓更结实 */
    var n = noiseSource(ctx, 0.012);
    var hp = ctx.createBiquadFilter();
    hp.type = 'lowpass';
    hp.frequency.value = 900;
    var ng = envGain(ctx, when, amp * LEVEL.kick * 0.25, 0.03);
    n.connect(hp); hp.connect(ng); ng.connect(out);
    if (global.Voices) global.Voices.track(n, ctx);
    n.start(when);
    n.stop(when + 0.05);
  }

  function synthSnare(ctx, when, out, amp) {
    var n = noiseSource(ctx, 0.2);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    var ng = envGain(ctx, when, amp * LEVEL.snare, 0.2);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    if (global.Voices) global.Voices.track(n, ctx);
    n.start(when);
    n.stop(when + 0.25);

    /* 鼓身：185Hz 三角波 */
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200, when);
    osc.frequency.exponentialRampToValueAtTime(150, when + 0.1);
    var og = envGain(ctx, when, amp * LEVEL.snare * 0.55, 0.13);
    osc.connect(og); og.connect(out);
    if (global.Voices) global.Voices.track(osc, ctx);
    osc.start(when);
    osc.stop(when + 0.2);
  }

  function synthHat(ctx, when, out, amp, open) {
    var dur = open ? 0.3 : 0.05;
    var n = noiseSource(ctx, dur + 0.05);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = open ? 6500 : 7500;
    var ng = envGain(ctx, when, amp * (open ? LEVEL.open : LEVEL.hat), dur);
    n.connect(hp); hp.connect(ng); ng.connect(out);
    if (global.Voices) global.Voices.track(n, ctx);
    n.start(when);
    n.stop(when + dur + 0.05);
  }

  function synthCrash(ctx, when, out, amp) {
    var n = noiseSource(ctx, 1.3);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    var bp = ctx.createBiquadFilter();
    bp.type = 'peaking';
    bp.frequency.value = 9000;
    bp.gain.value = 4;
    var ng = envGain(ctx, when, amp * LEVEL.crash, 1.2);
    n.connect(hp); hp.connect(bp); bp.connect(ng); ng.connect(out);
    if (global.Voices) global.Voices.track(n, ctx);
    n.start(when);
    n.stop(when + 1.3);
  }

  function synthClick(ctx, when, out, amp, accent) {
    var osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? 1600 : 1100;
    var g = envGain(ctx, when, amp * LEVEL.click * (accent ? 1 : 0.8), 0.04);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    osc.connect(lp); lp.connect(g); g.connect(out);
    if (global.Voices) global.Voices.track(osc, ctx);
    osc.start(when);
    osc.stop(when + 0.06);
  }

  var SYNTH = {
    kick: function (ctx, when, out, amp) { synthKick(ctx, when, out, amp); },
    snare: function (ctx, when, out, amp) { synthSnare(ctx, when, out, amp); },
    hat: function (ctx, when, out, amp) { synthHat(ctx, when, out, amp, false); },
    open: function (ctx, when, out, amp) { synthHat(ctx, when, out, amp, true); },
    crash: function (ctx, when, out, amp) { synthCrash(ctx, when, out, amp); },
    click: function (ctx, when, out, amp, accent) { synthClick(ctx, when, out, amp, accent); }
  };

  /* ---------------- 时间计算 ---------------- */
  /* 一格的时间：一小节 = beats 拍，每拍 60/bpm 秒 */
  function stepSeconds(pattern, bpm) {
    return (60 / bpm) * pattern.beats / pattern.steps;
  }

  /* 摇摆：把「反拍八分」往后推。swing=0.5 是直的，0.667 是三连音摇摆。
     16 格网格里，反拍八分是 (step % 4 === 2) 的那几格。 */
  function swingOffsetSteps(pattern, step, swing) {
    var s = (swing === undefined || swing === null) ? pattern.swing : swing;
    if (!s || s <= 0.5) return 0;
    if (step % 4 !== 2) return 0;
    return (2 * s - 1);      /* 单位：格 */
  }

  /* 把一小节的所有敲击排进 ctx 的时间轴 */
  function scheduleBar(ctx, pattern, out, startTime, bpm, swing, amp) {
    var stepDur = stepSeconds(pattern, bpm);
    for (var inst in pattern.hits) {
      if (!pattern.hits.hasOwnProperty(inst)) continue;
      var fn = SYNTH[inst];
      if (!fn) continue;
      var list = pattern.hits[inst];
      for (var i = 0; i < list.length; i++) {
        var step = list[i];
        var when = startTime + (step + swingOffsetSteps(pattern, step, swing)) * stepDur;
        fn(ctx, when, out, P.isAccent(pattern, inst, step) ? amp * 1.4 : amp);
      }
    }
  }

  function barSeconds(pattern, bpm) {
    return (60 / bpm) * pattern.beats;
  }

  /* ---------------- 离线渲染（测试 / 预览用） ---------------- */
  /**
   * 渲染 seconds 秒的音频，返回 Promise<Float32Array>（单声道混音）
   */
  function renderOffline(pattern, opts, seconds) {
    opts = opts || {};
    var sampleRate = opts.sampleRate || 44100;
    var bpm = opts.bpm || pattern.bpm;
    var swing = (opts.swing === undefined) ? pattern.swing : opts.swing;
    var amp = (opts.volume === undefined) ? 0.9 : opts.volume;
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!OAC) return null;
    var ctx = new OAC(1, Math.max(1, Math.floor(sampleRate * seconds)), sampleRate);
    var out = ctx.createGain();
    out.gain.value = 1;
    var comp = ctx.createDynamicsCompressor();
    out.connect(comp);
    comp.connect(ctx.destination);

    var bar = barSeconds(pattern, bpm);
    for (var t = 0; t < seconds; t += bar) {
      scheduleBar(ctx, pattern, out, t, bpm, swing, amp);
    }
    return ctx.startRendering().then(function (buf) {
      return buf.getChannelData(0);
    });
  }

  /* ---------------- 实时播放：注册到共享 Transport ---------------- */
  var livePattern = null;
  var liveCfg = { swing: 0.5, volume: 1 };
  var liveGain = null;
  var liveEnabled = false;

  function syncLiveGain(ctx, out) {
    if (!liveGain || liveGain.context !== ctx) {
      liveGain = ctx.createGain();
      liveGain.gain.value = liveCfg.volume;
      liveGain.connect(out);
    }
    return liveGain;
  }

  function applyLiveVolume() {
    if (!liveGain) return;
    try { liveGain.gain.value = liveCfg.volume; } catch (e) {}
  }

  var engine = {
    nextTime: null,
    enabled: function () { return liveEnabled && !!livePattern; },
    barSeconds: function (bpm) { return barSeconds(livePattern, bpm); },
    scheduleBar: function (ctx, out, startTime, bpm) {
      var outGain = syncLiveGain(ctx, out);
      var stepDur = stepSeconds(livePattern, bpm);
      for (var inst in livePattern.hits) {
        if (!livePattern.hits.hasOwnProperty(inst)) continue;
        var fn = SYNTH[inst];
        if (!fn) continue;
        var list = livePattern.hits[inst];
        for (var i = 0; i < list.length; i++) {
          var step = list[i];
          var delay = (step + swingOffsetSteps(livePattern, step, liveCfg.swing)) * stepDur;
          fn(ctx, startTime + delay, outGain,
             P.isAccent(livePattern, inst, step) ? 1.4 : 1);
          global.Transport.push({ source: 'drums', step: step, time: startTime + delay });
        }
      }
    }
  };
  if (global.Transport) global.Transport.register(engine);

  /* 配置（不负责播放：播放由 Band 统一控制） */
  function configure(patternObj, options) {
    livePattern = patternObj;
    if (options && options.swing !== undefined) liveCfg.swing = options.swing;
    if (options && options.volume !== undefined) liveCfg.volume = options.volume;
    applyLiveVolume();
  }

  function setEnabled(on) { liveEnabled = !!on; if (global.Transport) engine.nextTime = null; }
  function isEnabled() { return liveEnabled; }
  function setSwing(s) { liveCfg.swing = s; }
  function setVolume(v) {
    liveCfg.volume = Math.max(0, Math.min(1.2, Number(v) || 0));
    applyLiveVolume();
  }
  function currentPattern() { return livePattern; }

  /* 兼容旧调用：configure + 启用 + 启动 transport（鼓机单独试听时用） */
  function play(patternObj, options) {
    configure(patternObj, options);
    setEnabled(true);
    if (!global.Transport) return false;
    if (options && options.bpm) global.Transport.setBpm(options.bpm);
    return global.Transport.start(options && options.bpm);
  }

  global.Drums = {
    play: play,
    configure: configure,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    currentPattern: currentPattern,
    stop: function () { if (global.Transport) global.Transport.stop(); },
    isRunning: function () { return !!(global.Transport && global.Transport.isRunning()); },
    drain: function () { return global.Transport ? global.Transport.drain() : null; },
    setBpm: function (bpm) { if (global.Transport) global.Transport.setBpm(bpm); },
    setSwing: setSwing,
    setVolume: setVolume,
    volume: function () { return liveCfg.volume; },
    renderOffline: renderOffline,
    stepSeconds: stepSeconds,
    barSeconds: barSeconds,
    swingOffsetSteps: swingOffsetSteps,
    audioContext: function () { return global.Transport ? global.Transport.ensure() : null; },
    LEVEL: LEVEL
  };
})(window);
