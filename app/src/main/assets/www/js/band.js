/*!
 * band.js —— 伴奏页与即兴页共用的播放总控
 *
 * 两种播放模式：
 *   1. 普通伴奏：鼓机 + 和弦伴奏，使用伴奏页当前的走向/节奏型/鼓机格子；
 *   2. 即兴实例：从「伴奏实例」快照里把鼓机、走向、节奏型、调式、BPM
 *      一次性装进引擎，再加上即兴 solo。
 * 两种模式共用 Transport，所以鼓/伴奏/solo 的拍点天然对齐。
 */
(function (global) {
  'use strict';

  var T = global.Transport, D = global.Drums, B = global.Backing, S = global.Store;

  var state = {
    bpm: 100,
    drumsOn: true,
    backingOn: true,
    improvOn: false,
    playing: false,
    instanceMode: false,
    instanceName: '',
    mix: { drums: 0.8, backing: 1, solo: 1.2 }
  };
  var hooks = {};

  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /* 三路音量：鼓 / 伴奏 / solo。有 solo 时伴奏只轻微让到 75%，
     保留伴奏的鼓动感；solo 另有 1.6 倍总线和 presence。 */
  function applyMix() {
    var hasSolo = state.improvOn && global.Improv && global.Improv.hasScore();
    D.setVolume(state.mix.drums);
    B.setVolume(state.mix.backing * (hasSolo ? 0.75 : 1));
    if (global.Improv) global.Improv.setVolume(state.mix.solo);
  }

  function setMix(role, v) {
    if (role === 'drums') state.mix.drums = clamp(v, 0, 1.2);
    else if (role === 'backing') state.mix.backing = clamp(v, 0, 1.2);
    else if (role === 'solo') state.mix.solo = clamp(v, 0, 2.2);
    else return;
    if (S) S.setSetting('mix.' + role, String(state.mix[role]));
    applyMix();
    if (hooks.onChange) hooks.onChange();
  }

  function syncEnabled() {
    D.setEnabled(state.drumsOn);
    B.setEnabled(state.backingOn);
    if (global.Improv) global.Improv.setEnabled(state.improvOn);
    applyMix();
  }

  function clearInstance() {
    state.instanceMode = false;
    state.instanceName = '';
  }

  function start() {
    T.ensure();
    clearInstance();
    state.improvOn = false;
    if (global.Improv) global.Improv.setEnabled(false);
    if (!state.drumsOn && !state.backingOn) return false;
    syncEnabled();
    T.setBpm(state.bpm);
    var ok = T.start(state.bpm);
    state.playing = ok;
    if (hooks.onChange) hooks.onChange();
    return ok;
  }

  /**
   * 播放一个伴奏实例 + solo
   * @param {object} instance 实例快照
   * @param {object} score 即兴简谱
   * @param {object} opts {tone}
   */
  function startInstance(instance, score, opts) {
    opts = opts || {};
    if (!instance || !instance.progression || !instance.rhythm || !instance.drum) return false;
    if (!score) return false;
    if (state.playing) {
      T.stop();
      state.playing = false;
    }
    if (!T.ensure()) return false;

    state.instanceMode = true;
    state.instanceName = instance.name || '伴奏实例';
    state.bpm = clamp(instance.bpm || 100, 40, 240);
    T.setBpm(state.bpm);

    D.configure(JSON.parse(JSON.stringify(instance.drum)), {
      swing: (instance.swing === undefined ? 0.5 : instance.swing),
      volume: state.mix.drums
    });
    B.configure(B.cloneProgression(instance.progression), B.cloneRhythm(instance.rhythm),
      instance.keyPc, instance.scaleId, instance.register || 'low');
    if (global.Improv) {
      global.Improv.setScore(score);
      global.Improv.setTone(opts.tone || 'electric');
      global.Improv.setEnabled(true);
    }
    state.drumsOn = true;
    state.backingOn = true;
    state.improvOn = true;
    D.setEnabled(true);
    B.setEnabled(true);
    applyMix();

    var ok = T.start(state.bpm);
    state.playing = ok;
    if (hooks.onChange) hooks.onChange();
    return ok;
  }

  /**
   * 只播一条已有简谱（不启动鼓机/伴奏）。
   * 谱库里的老谱如果找不到关联实例，用这个入口也能试听旋律。
   */
  function startSolo(score, opts) {
    opts = opts || {};
    if (!score || !global.Improv) return false;
    if (state.playing) {
      T.stop();
      state.playing = false;
    }
    if (!T.ensure()) return false;

    state.instanceMode = true;
    state.instanceName = opts.name || score.title || '谱库试听';
    state.bpm = clamp(score.bpm || state.bpm, 40, 240);
    T.setBpm(state.bpm);
    D.setEnabled(false);
    B.setEnabled(false);
    global.Improv.setScore(score);
    global.Improv.setTone(opts.tone || 'electric');
    global.Improv.setEnabled(true);
    state.improvOn = true;
    applyMix();

    var ok = T.start(state.bpm);
    state.playing = ok;
    if (hooks.onChange) hooks.onChange();
    return ok;
  }

  function stop() {
    T.stop();
    state.playing = false;
    clearInstance();
    state.improvOn = false;
    if (global.Improv) global.Improv.setEnabled(false);
    applyMix();
    if (hooks.onChange) hooks.onChange();
  }

  function toggle() { return state.playing ? (stop(), false) : start(); }

  function setEnabled(which, on) {
    if (which === 'drums') state.drumsOn = !!on;
    else if (which === 'backing') state.backingOn = !!on;
    else if (which === 'improv') state.improvOn = !!on;
    syncEnabled();
    if (S) {
      S.setSetting('on.drums', state.drumsOn ? '1' : '0');
      S.setSetting('on.backing', state.backingOn ? '1' : '0');
    }
    if (state.playing && !state.drumsOn && !state.backingOn && !state.improvOn) stop();
    if (hooks.onChange) hooks.onChange();
  }

  function setBpm(v) {
    state.bpm = Math.max(40, Math.min(240, Math.round(v)));
    T.setBpm(state.bpm);
    if (S) S.setSetting('bpm', state.bpm);
    if (hooks.onChange) hooks.onChange();
  }

  /* TAP 点速：取最近几次点击间隔的平均；间隔超过 2.5 秒重新开始算 */
  var taps = [];
  function tap(nowMs) {
    var t = (nowMs === undefined || nowMs === null) ? (new Date()).getTime() : nowMs;
    if (taps.length && t - taps[taps.length - 1] > 2500) taps = [];
    taps.push(t);
    if (taps.length > 5) taps.shift();
    if (taps.length < 2) return null;
    var sum = 0;
    for (var i = 1; i < taps.length; i++) sum += (taps[i] - taps[i - 1]);
    var bpm = Math.round(60000 / (sum / (taps.length - 1)));
    if (bpm < 40) bpm = 40;
    if (bpm > 240) bpm = 240;
    setBpm(bpm);
    return bpm;
  }
  function tapReset() { taps = []; }

  function statusText() {
    if (state.instanceMode) {
      return '即兴实例 ' + state.instanceName +
        (state.improvOn ? ' · solo' : '');
    }
    var parts = [];
    if (state.drumsOn) {
      var dp = D.currentPattern();
      parts.push('鼓机 ' + (dp ? dp.zh : '未选'));
    }
    if (state.backingOn) {
      var bs = B.state;
      parts.push('伴奏 ' + (bs.prog ? bs.prog.zh : '未选'));
    }
    return parts.length ? parts.join(' · ') : '（没有启用任何伴奏）';
  }

  function init(h) {
    hooks = h || {};
    if (S) {
      var savedBpm = Number(S.getSetting('bpm', '0'));
      if (savedBpm >= 40 && savedBpm <= 240) state.bpm = savedBpm;
      state.drumsOn = S.getSetting('on.drums', '1') !== '0';
      state.backingOn = S.getSetting('on.backing', '1') !== '0';
      state.mix.drums = clamp(S.getSetting('mix.drums', '0.8'), 0, 1.2);
      state.mix.backing = clamp(S.getSetting('mix.backing', '1'), 0, 1.2);
      state.mix.solo = clamp(S.getSetting('mix.solo', '1.2'), 0, 2.2);
    }
    syncEnabled();
    D.setSwing(D.currentPattern() ? D.currentPattern().swing : 0.5);
  }

  global.Band = {
    state: state,
    init: init,
    start: start,
    startInstance: startInstance,
    startSolo: startSolo,
    stop: stop,
    toggle: toggle,
    setEnabled: setEnabled,
    applyMix: applyMix,
    setMix: setMix,
    setBpm: setBpm,
    tap: tap,
    tapReset: tapReset,
    statusText: statusText,
    isPlaying: function () { return state.playing; }
  };
})(window);
