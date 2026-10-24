/*!
 * transport.js —— 鼓机与伴奏共用的传输层（时钟 + 总线）
 *
 * 为什么单独抽一层：需求是「鼓机和伴奏可以同时响，而且拍子必须一样」。
 * 如果两个引擎各用一套定时器，任何抖动都会让它们越走越远。这里让它们
 *   - 共用同一个 AudioContext 与总输出（音量、压缩器一处搞定）；
 *   - 共用同一个 25ms 前瞻定时器，每个引擎只是「被这个定时器驱动的调度函数」；
 *   - 启动时把每个引擎的下一次排期时间对齐到同一个 startTime，之后各自
 *     按自己的小节长度推进。因为都是 60/BPM 的整数倍，拍点永远重合。
 *
 * 引擎需要实现：
 *   enabled()            是否参与播放
 *   barSeconds(bpm)      自己一小节多少秒
 *   scheduleBar(ctx, out, startTime, bpm)   把这一小节的所有事件排进时间轴
 *   nextTime             由 transport 读写（下一次排期时刻）
 */
(function (global) {
  'use strict';

  var ctx = null, master = null, comp = null;
  var timer = null, running = false, bpm = 100;
  var engines = [];
  var LOOKAHEAD = 0.15;      /* 秒：提前排多久 */
  var TICK = 25;             /* ms：定时器间隔 */
  var queue = [];            /* 已排期事件（给界面做音画同步用） */
  var startTime = 0;
  var volume = 0.85;        /* 主输出音量（stop 淡出后要恢复它） */

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return ctx;
    }
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.85;
    comp = ctx.createDynamicsCompressor();
    /* 阈值别压得太低：整串扫弦 + solo 同时进来时，-10dB/4:1 会把伴奏压扁、发闷。
       -7dB/3:1 留出更多瞬态和清晰度，峰值交给后面的软削波兜底。 */
    comp.threshold.value = -7;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.18;
    /* 末端软削波：多音同时起音时峰值可能超过 1，保住扬声器，但不额外加
       第二级压缩器的起音延迟。 */
    var clip = ctx.createWaveShaper();
    var n = 2048, curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = Math.tanh(x * 1.2) / Math.tanh(1.2);
    }
    clip.curve = curve;
    clip.oversample = 'none';
    master.connect(comp);
    comp.connect(clip);
    clip.connect(ctx.destination);
    return ctx;
  }

  function register(engine) {
    engines.push(engine);
    engine.nextTime = null;
    return engine;
  }

  function tick() {
    if (!running || !ctx) return;
    var now = ctx.currentTime;
    var horizon = now + LOOKAHEAD;
    for (var i = 0; i < engines.length; i++) {
      var e = engines[i];
      if (!e.enabled()) { e.nextTime = null; continue; }
      if (e.nextTime === null) e.nextTime = startTime > now ? startTime : now + 0.02;
      var guard = 0;
      while (e.nextTime < horizon && guard++ < 32) {
        e.scheduleBar(ctx, master, e.nextTime, bpm);
        var len = e.barSeconds(bpm);
        if (!len || len < 0.05) break;
        e.nextTime += len;
      }
    }
    queue.sort(function (a, b) { return a.time - b.time; });
  }

  /**
   * 开始播放（把所有启用的引擎对齐到同一时刻）
   * @returns {boolean} 环境不支持 WebAudio 时返回 false
   */
  function start(bpmValue) {
    var c = ensure();
    if (!c) return false;
    if (bpmValue) bpm = bpmValue;
    queue = [];
    /* 恢复主输出音量（停止时被淡到 0 过） */
    if (master) {
      try {
        master.gain.cancelScheduledValues(c.currentTime);
        master.gain.setValueAtTime(master.gain.value, c.currentTime);
        master.gain.linearRampToValueAtTime(volume, c.currentTime + 0.02);
      } catch (e) {
        master.gain.value = volume;
      }
    }
    startTime = c.currentTime + 0.1;
    for (var i = 0; i < engines.length; i++) engines[i].nextTime = startTime;
    running = true;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, TICK);
    tick();
    return true;
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    queue = [];
    for (var i = 0; i < engines.length; i++) engines[i].nextTime = null;
    /* 关键：把已经排进时间轴的音源也掐掉。
       否则「停止」只是不再排新的，之前排好的会照响完（鼓机一小节、伴奏一整个走向，最长的能响十几秒）。 */
    var killed = 0;
    if (global.Voices) { killed = global.Voices.count(); global.Voices.killAll(); }
    if (global.console && global.console.log) {
      global.console.log('[transport] 停止：掐掉 ' + killed + ' 个已排期音源，清空 ' + queue.length + ' 个待播放事件');
    }
    if (master && ctx) {
      var now = ctx.currentTime;
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(0.0001, now + 0.02);   /* 20ms 淡出，避免咔哒声 */
      } catch (e) {}
    }
  }

  /* 界面取「已经真的到点」的事件（音画同步） */
  function drain() {
    if (!ctx) return null;
    var t = ctx.currentTime;
    var last = null;
    while (queue.length && queue[0].time <= t + 0.02) last = queue.shift();
    return last;
  }

  /* 一次取走所有已到点的事件（界面用来同时驱动鼓机格子与伴奏高亮） */
  function drainAll() {
    if (!ctx) return [];
    var t = ctx.currentTime, out = [];
    while (queue.length && queue[0].time <= t + 0.02) out.push(queue.shift());
    return out;
  }

  /* 按时间插入到正确位置：drainAll 依赖队列有序，直接 push 到末尾会让
     排在后面的新事件被前面的未到点事件挡住（测试里注入事件时就踩过这个）。 */
  function push(event) {
    var i = queue.length;
    while (i > 0 && queue[i - 1].time > event.time) i--;
    queue.splice(i, 0, event);
  }
  function setBpm(v) { bpm = v; }
  function setVolume(v) {
    volume = v;
    if (master && running) master.gain.value = v;
  }

  global.Transport = {
    ensure: ensure,
    register: register,
    start: start,
    stop: stop,
    drain: drain,
    drainAll: drainAll,
    push: push,
    setBpm: setBpm,
    setVolume: setVolume,
    context: function () { return ctx; },
    master: function () { return master; },
    isRunning: function () { return running; },
    bpm: function () { return bpm; },
    pendingEvents: function () { return queue.length; }
  };
})(window);
