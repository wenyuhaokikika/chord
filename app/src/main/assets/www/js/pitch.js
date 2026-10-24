/*!
 * pitch.js —— 调音用的基频检测
 *
 * 算法：自相关（autocorrelation）+ 抛物线插值。为了能在手机上实时跑，做了三层优化：
 *   1. 降采样：吉他基频最高约 1.3kHz，把 48kHz 降到 ~16kHz 再算，
 *      相关运算量降到 1/9（降采样前先做两抽头平均，抑制高频混叠）；
 *   2. 固定相关窗口 W = len - maxLag：每个 lag 的运算量一致，归一化才有可比性；
 *   3. 粗到细两遍搜索：先用步长 2 扫一遍全部 lag，再在峰值附近 ±2 用步长 1 细算。
 *
 * 判定基频用「第一个达到最大值 90% 的峰」而不是直接取最大值，
 * 这样不会把 2 倍周期（低八度）当成基频——吉他上这是最常见的误判。
 * 最后用峰值两侧做抛物线插值，把精度推到远小于一个采样点，音分误差可压到 ±1。
 *
 * detectPitch() 是纯函数（只依赖入参数组），所以能用合成波形做断言测试，
 * 不需要真的录音——见 tools/selftest.html 里的“基频检测”一组断言。
 */
(function (global) {
  'use strict';

  var DEFAULT_MIN_HZ = 55;      /* A1，低于吉他 6 弦的 E2(82.4) 留足余量 */
  var DEFAULT_MAX_HZ = 1400;    /* 约 F6，高于吉他 1 弦 24 品 (E6≈1318) */
  var TARGET_RATE = 16000;      /* 降采样后的目标采样率 */

  /**
   * @param {Float32Array|number[]} buf 时域采样（建议 2048~8192 个点）
   * @param {number} sampleRate 采样率，一般 44100 / 48000
   * @param {object} [opts] {minHz, maxHz, rmsThreshold, clarity}
   * @returns {{freq:number, rms:number, clarity:number}|null} 没测到就返回 null
   */
  function detectPitch(buf, sampleRate, opts) {
    opts = opts || {};
    var minHz = opts.minHz || DEFAULT_MIN_HZ;
    var maxHz = opts.maxHz || DEFAULT_MAX_HZ;
    var rmsThreshold = (opts.rmsThreshold === undefined) ? 0.004 : opts.rmsThreshold;
    var minClarity = (opts.clarity === undefined) ? 0.5 : opts.clarity;

    var n = buf.length;
    if (!n || !sampleRate) return null;

    /* 1) 整体音量，太安静直接放弃（避免在噪声里瞎猜） */
    var i, sum = 0;
    for (i = 0; i < n; i++) sum += buf[i] * buf[i];
    var rms = Math.sqrt(sum / n);
    if (rms < rmsThreshold) return null;

    /* 2) 掐掉首尾幅度不足的部分，减少边界对相关函数的影响 */
    var start = 0, end = n - 1;
    for (i = 0; i < n / 2; i++) { if (Math.abs(buf[i]) < 0.2) start = i; else break; }
    for (i = 1; i < n / 2; i++) { if (Math.abs(buf[n - i]) < 0.2) end = n - i; else break; }
    if (end - start < n * 0.5) { start = 0; end = n - 1; }

    /* 3) 降采样（两抽头平均当简易抗混叠） */
    var decim = 1;
    while (sampleRate / (decim * 2) > TARGET_RATE) decim *= 2;
    var len = Math.floor((end - start + 1) / decim);
    var sig;
    if (decim === 1) {
      sig = (start === 0 && end === n - 1) ? buf : slice(buf, start, end + 1);
    } else {
      sig = new Float32Array(len);
      var acc;
      for (i = 0; i < len; i++) {
        acc = 0;
        for (var d = 0; d < decim; d++) acc += buf[start + i * decim + d] || 0;
        sig[i] = acc / decim;
      }
    }
    var fs = sampleRate / decim;

    /* 4) 自相关：固定窗口 W，保证不同 lag 的归一化值可比 */
    var minLag = Math.max(2, Math.floor(fs / maxHz));
    var maxLag = Math.min(len - 2, Math.ceil(fs / minHz));
    if (maxLag <= minLag + 2) return null;
    var W = len - maxLag;

    function corr(lag) {
      var s = 0, e0 = 0, e1 = 0, v0, v1;
      for (var j = 0; j < W; j++) {
        v0 = sig[j]; v1 = sig[j + lag];
        s += v0 * v1;
        e0 += v0 * v0;
        e1 += v1 * v1;
      }
      var den = Math.sqrt(e0 * e1);
      return den > 0 ? s / den : 0;
    }

    /* 5) 粗扫（步长 2）-> 细算峰值附近 */
    var lag, v, bestLag = minLag, bestVal = -2;
    for (lag = minLag; lag <= maxLag; lag += 2) {
      v = corr(lag);
      if (v > bestVal) { bestVal = v; bestLag = lag; }
    }
    var lo = Math.max(minLag, bestLag - 2), hi = Math.min(maxLag, bestLag + 2);
    var vals = {};
    for (lag = lo; lag <= hi; lag++) {
      vals[lag] = corr(lag);
      if (vals[lag] > bestVal) { bestVal = vals[lag]; bestLag = lag; }
    }

    /* 6) 取「第一个达到峰值 90% 的峰」：避免把 2 倍周期（低八度）当基频 */
    var threshold = bestVal * 0.9;
    for (lag = minLag + 1; lag < maxLag; lag++) {
      v = (vals[lag] !== undefined) ? vals[lag] : corr(lag);
      if (v >= threshold) {
        var prev = (vals[lag - 1] !== undefined) ? vals[lag - 1] : corr(lag - 1);
        var next = (vals[lag + 1] !== undefined) ? vals[lag + 1] : corr(lag + 1);
        if (v >= prev && v >= next) { bestLag = lag; bestVal = v; break; }
      }
    }

    if (bestLag < minLag + 1 || bestVal < minClarity) return null;

    /* 7) 抛物线插值细化峰值位置 */
    var y1 = (vals[bestLag - 1] !== undefined) ? vals[bestLag - 1] : corr(bestLag - 1);
    var y2 = bestVal;
    var y3 = (vals[bestLag + 1] !== undefined) ? vals[bestLag + 1] : corr(bestLag + 1);
    var a = (y1 + y3 - 2 * y2) / 2;
    var b = (y3 - y1) / 2;
    var shift = (a !== 0) ? (-b / (2 * a)) : 0;
    if (shift > 0.5) shift = 0.5;
    if (shift < -0.5) shift = -0.5;
    var refinedLag = bestLag + shift;
    if (refinedLag <= 0) return null;

    return {
      freq: fs / refinedLag,
      rms: rms,
      clarity: bestVal,
      decim: decim
    };
  }

  function slice(buf, from, to) {
    if (buf.slice) return buf.slice(from, to);
    var out = new Float32Array(to - from);
    for (var i = from; i < to; i++) out[i - from] = buf[i];
    return out;
  }

  /**
   * 频率 -> 音名 / 音分偏差
   * @param {number} freq
   * @param {number} [a4] 基准音高，默认 440（可设 432 / 435 / 442 等）
   * @returns {{midi:number, exactMidi:number, cents:number, octave:number, pc:number}}
   */
  function freqToNote(freq, a4) {
    var base = a4 || 440;
    var exact = 69 + 12 * Math.log(freq / base) / Math.LN2;
    var midi = Math.round(exact);
    return {
      midi: midi,
      exactMidi: exact,
      cents: Math.round((exact - midi) * 100),
      octave: Math.floor(midi / 12) - 1,
      pc: ((midi % 12) + 12) % 12
    };
  }

  /* 标准调弦各弦的空弦音高（用于调音时指出“你在调第几弦”） */
  var STRING_TARGETS = [
    { string: 0, midi: 40, label: '6 弦 E2' },
    { string: 1, midi: 45, label: '5 弦 A2' },
    { string: 2, midi: 50, label: '4 弦 D3' },
    { string: 3, midi: 55, label: '3 弦 G3' },
    { string: 4, midi: 59, label: '2 弦 B3' },
    { string: 5, midi: 64, label: '1 弦 E4' }
  ];

  /* 最接近的标准弦（按音高差） */
  function nearestString(midi) {
    var best = null;
    for (var i = 0; i < STRING_TARGETS.length; i++) {
      var diff = midi - STRING_TARGETS[i].midi;
      if (best === null || Math.abs(diff) < Math.abs(best.diff)) {
        best = {
          string: STRING_TARGETS[i].string,
          label: STRING_TARGETS[i].label,
          target: global.Music.midiToFreq(STRING_TARGETS[i].midi),
          diff: diff
        };
      }
    }
    return best;
  }

  global.Pitch = {
    detectPitch: detectPitch,
    freqToNote: freqToNote,
    nearestString: nearestString,
    STRING_TARGETS: STRING_TARGETS,
    DEFAULT_MIN_HZ: DEFAULT_MIN_HZ,
    DEFAULT_MAX_HZ: DEFAULT_MAX_HZ
  };
})(window);
