/*!
 * voices.js —— 正在发声/已排期的音源登记表
 *
 * 为什么需要它：鼓机与伴奏都用「前瞻式调度」，一次会把未来一段时间（鼓机一小节、
 * 伴奏一整个和弦走向，可能十几秒）的音符提前排进 WebAudio 的时间轴。这样节奏是稳的，
 * 但"停止"如果只是不再排新的，已经排进去的音还是会照响完——点了停止还在响，就是这个原因。
 *
 * 所以每个合成函数在创建振荡器/噪声源时登记一下，停止时统一 stop(0) + disconnect()，
 * 声音立刻断掉。登记的条目按时间顺序排列，超过 MAX_AGE 秒的老条目在下次登记时丢弃，
 * 长时间播放也不会堆积。
 *
 * 只登记"实时音频上下文"里的音源：离线渲染（测试用）不登记，免得污染这张表。
 */
(function (global) {
  'use strict';

  var list = [];
  var MAX_AGE = 8;     /* 秒：比最长的衰减还长一点就安全了 */

  function liveContext() {
    return (global.Transport && global.Transport.context) ? global.Transport.context() : null;
  }

  /**
   * @param {AudioScheduledSourceNode} node 振荡器或噪声源
   * @param {AudioContext} ctx 它所属的上下文（离线渲染时传进来，就不会被登记）
   */
  function track(node, ctx) {
    if (!node) return node;
    var live = liveContext();
    if (!live || (ctx && ctx !== live)) return node;
    var now = live.currentTime;
    while (list.length && now - list[0].t > MAX_AGE) list.shift();
    list.push({ node: node, t: now });
    return node;
  }

  /* 立刻掐掉所有还在响或已排期的音源 */
  function killAll() {
    for (var i = 0; i < list.length; i++) {
      var n = list[i].node;
      try { if (n.stop) n.stop(0); } catch (e) {}
      try { if (n.disconnect) n.disconnect(); } catch (e) {}
    }
    list.length = 0;
  }

  function count() { return list.length; }

  global.Voices = {
    track: track,
    killAll: killAll,
    count: count
  };
})(window);
