/*!
 * tuner.js —— 调音的音频输入层
 *
 * 只负责三件事：拿到麦克风流 -> 定周期取一帧时域数据 -> 交给 Pitch.detectPitch 算基频。
 * 界面怎么显示由 app.js 决定，所以这一层可以脱离 UI 单独测试。
 *
 * 采集时刻意关掉 AGC / 降噪 / 回声消除：这些“语音优化”会改动波形，
 * 让基频检测在低音弦上偏差几十音分。
 */
(function (global) {
  'use strict';

  var audioCtx = null;
  var stream = null;
  var source = null;
  var analyser = null;
  var buf = null;
  var rafId = null;
  var running = false;
  var lastError = null;

  /* 平滑：取最近 N 次有效读数的中位数，避免数字乱跳（吉他扫弦时尤其明显） */
  var HISTORY = 5;
  var history = [];
  var holdFrames = 0;
  var HOLD_MAX = 12;      /* 约 0.2 秒内测不到就清空读数 */

  function isSupported() {
    return !!(global.navigator && global.navigator.mediaDevices &&
              global.navigator.mediaDevices.getUserMedia && global.AudioContext);
  }

  function describeError(e) {
    var name = (e && (e.name || e.code)) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return '麦克风权限被拒绝。请在系统设置里允许本应用使用麦克风（Android：设置 → 应用 → 和弦助手 → 权限 → 麦克风）。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '没有找到可用的麦克风设备。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '麦克风被其它应用占用了，先关掉录音/会议类应用再试。';
    }
    if (name === 'OverconstrainedError') {
      return '麦克风不支持所需的参数，已尝试放宽限制但仍失败。';
    }
    if (!global.navigator.mediaDevices) {
      return '当前环境不允许录音：需要 https 或本地文件（file://）打开页面。';
    }
    return '打开麦克风失败：' + (e && e.message ? e.message : String(e));
  }

  /**
   * @param {object} handlers { onResult(freqInfo|null), onError(msg), onStart(), onStop() }
   * @param {object} opts { fftSize, minHz, maxHz, rmsThreshold, clarity }
   */
  function start(handlers, opts) {
    handlers = handlers || {};
    opts = opts || {};
    if (running) return;
    lastError = null;

    if (!isSupported()) {
      if (handlers.onError) handlers.onError(describeError(null));
      return;
    }

    var constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      },
      video: false
    };

    global.navigator.mediaDevices.getUserMedia(constraints).then(function (s) {
      stream = s;
      var AC = global.AudioContext || global.webkitAudioContext;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
      var src = audioCtx.createMediaStreamSource(stream);
      attachSource(src, handlers, opts);
    })['catch'](function (e) {
      lastError = describeError(e);
      if (handlers.onError) handlers.onError(lastError);
      stop(handlers);
    });
  }

  /**
   * 直接把任意音频节点接到分析器上 —— getUserMedia 成功的分支也走这里。
   * 单独暴露出来是为了让自动化测试注入一个已知频率的振荡器，
   * 从而在不依赖真实麦克风的情况下验证「音频 -> 基频 -> 界面」整条链路。
   */
  function attachSource(node, handlers, opts) {
    handlers = handlers || {};
    opts = opts || {};
    var AC = global.AudioContext || global.webkitAudioContext;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();

    source = node;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = opts.fftSize || 8192;      /* 低音弦需要足够长的窗口 */
    analyser.smoothingTimeConstant = 0;
    buf = new Float32Array(analyser.fftSize);
    source.connect(analyser);

    history = [];
    holdFrames = 0;
    running = true;
    if (handlers.onStart) handlers.onStart();
    loop(handlers, opts);
  }

  function audioContext() {
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!audioCtx && AC) audioCtx = new AC();
    return audioCtx;
  }

  function loop(handlers, opts) {
    if (!running) return;
    rafId = global.requestAnimationFrame(function () { loop(handlers, opts); });

    var samples = null;
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(buf);
      samples = buf;
    } else if (analyser.getByteTimeDomainData) {
      /* 老 WebView 没有浮点接口，退回 8 位 */
      var bytes = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(bytes);
      if (!buf || buf.length !== bytes.length) buf = new Float32Array(bytes.length);
      for (var i = 0; i < bytes.length; i++) buf[i] = (bytes[i] - 128) / 128;
      samples = buf;
    } else {
      return;
    }

    var res = global.Pitch.detectPitch(samples, audioCtx.sampleRate, {
      minHz: opts.minHz, maxHz: opts.maxHz,
      rmsThreshold: opts.rmsThreshold, clarity: opts.clarity
    });

    if (res) {
      history.push(res.freq);
      if (history.length > HISTORY) history.shift();
      holdFrames = 0;
      var sorted = history.slice().sort(function (a, b) { return a - b; });
      var median = sorted[Math.floor(sorted.length / 2)];
      if (handlers.onResult) handlers.onResult({ freq: median, rms: res.rms, clarity: res.clarity });
    } else {
      holdFrames++;
      if (holdFrames >= HOLD_MAX && history.length) {
        history = [];
        if (handlers.onResult) handlers.onResult(null);
      }
    }
  }

  function stop(handlers) {
    handlers = handlers || {};
    running = false;
    if (rafId) { global.cancelAnimationFrame(rafId); rafId = null; }
    if (source && source.disconnect) { try { source.disconnect(); } catch (e) {} }
    if (stream) {
      var tracks = stream.getTracks ? stream.getTracks() : [];
      for (var i = 0; i < tracks.length; i++) { try { tracks[i].stop(); } catch (e) {} }
    }
    if (audioCtx && audioCtx.close && audioCtx.state !== 'closed') {
      /* 关掉上下文，避免手机上一直占用麦克风 */
      try { audioCtx.close(); } catch (e) {}
      audioCtx = null;
    }
    source = null; analyser = null; stream = null; buf = null; history = [];
    if (handlers.onStop) handlers.onStop();
  }

  global.Tuner = {
    start: start,
    stop: stop,
    attachSource: attachSource,
    audioContext: audioContext,
    isRunning: function () { return running; },
    isSupported: isSupported,
    lastError: function () { return lastError; },
    describeError: describeError
  };
})(window);
