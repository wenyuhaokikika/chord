/*!
 * drumsui.js —— 鼓机子页签：节奏选择、摇摆、音量、步进格子
 *
 * 播放由 Band / Transport 统一控制（见 band.js、bandui.js），这里只负责：
 *   - 节奏与格子的编辑（改动直接改引擎正在读的那份节奏对象，下一小节生效）
 *   - 播放位置的高亮（由 bandui 每帧把「已发声」的格子转过来）
 */
(function (global) {
  'use strict';

  var P = global.Patterns, D = global.Drums, esc = global.Render.esc, S = global.Store;

  var state = {
    patternId: 'rock',
    edits: {},            /* 每个节奏一份可编辑副本，切来切去不丢改动 */
    swing: 0.5,
    volume: 0.8
  };
  var nowStep = -1;
  var hooks = {};
  var SWINGS = [
    { v: 0.5, t: '直' },
    { v: 0.583, t: '轻摇' },
    { v: 0.667, t: '摇摆' },
    { v: 0.75, t: '重摇' }
  ];

  function $(id) { return document.getElementById(id); }

  function pattern(id) {
    var pid = id || state.patternId;
    if (!state.edits[pid]) {
      /* 优先用本地库里存的改动（用户点过格子），否则用内置预设 */
      var saved = S ? S.getItem('drums', pid) : null;
      state.edits[pid] = saved || P.clone(P.byId(pid));
    }
    return state.edits[pid];
  }

  /* 格子改动写回本地库（点一下存一次，量很小） */
  function persist(p) {
    if (S) S.putItem('drums', state.patternId, { id: p.id, hits: p.hits, accents: p.accents });
  }

  /* 把当前节奏交给引擎 */
  function pushToEngine() {
    D.configure(pattern(), { swing: state.swing, volume: state.volume });
  }

  /* ---------------- 渲染 ---------------- */
  function renderHeader() {
    var p = pattern();
    if (global.Band && global.Band.state.mix) state.volume = global.Band.state.mix.drums;
    $('drumName').textContent = p.zh + (p.en ? '　' + p.en : '');
    $('drumMeta').textContent = p.sig + ' · ' + p.tip;
    $('drumVol').value = Math.round(state.volume * 100);
    $('drumVolValue').textContent = Math.round(state.volume * 100) + '%';
    $('drumGridInfo').textContent = '每格 = ' + (p.steps === p.beats * 4 ? '十六分音符' : '八分音符') +
      '；点一下打点、再点一下加重音、第三下取消';
  }

  function renderSwing() {
    var box = $('swingChips');
    while (box.firstChild) box.removeChild(box.firstChild);
    for (var i = 0; i < SWINGS.length; i++) {
      (function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip sm' + (Math.abs(state.swing - s.v) < 0.001 ? ' on' : '');
        b.textContent = s.t;
        b.addEventListener('click', function () { setSwing(s.v); });
        box.appendChild(b);
      })(SWINGS[i]);
    }
  }

  function renderGrid() {
    var p = pattern();
    var html = [];
    var perBeat = p.steps / p.beats;
    html.push('<div class="step-beats" style="grid-template-columns: 58px repeat(' + p.steps + ', minmax(20px, 1fr))">');
    html.push('<span></span>');
    for (var b = 0; b < p.beats; b++) {
      html.push('<span class="step-beat' + (b === 0 ? ' strong' : '') + '" style="grid-column: span ' + perBeat + '">' + (b + 1) + '</span>');
    }
    html.push('</div>');

    for (var k = 0; k < P.INSTRUMENTS.length; k++) {
      var inst = P.INSTRUMENTS[k];
      var list = p.hits[inst.id] || [];
      var label = inst.zh + (list.length ? ' ' + list.length : '');
      html.push('<div class="step-row" style="grid-template-columns: 58px repeat(' + p.steps + ', minmax(20px, 1fr))">');
      html.push('<span class="step-label' + (list.length ? ' on' : '') + '">' + esc(label) + '</span>');
      for (var s = 0; s < p.steps; s++) {
        var on = list.indexOf(s) >= 0;
        var acc = P.isAccent(p, inst.id, s);
        var cls = 'step-cell' + (on ? ' on' : '') + (acc ? ' accent' : '') +
          (s % perBeat === 0 && s > 0 ? ' beat' : '') + (on && s === nowStep ? ' now' : '');
        html.push('<button type="button" class="' + cls + '" data-inst="' + inst.id + '" data-step="' + s + '"></button>');
      }
      html.push('</div>');
    }
    $('stepGrid').innerHTML = html.join('');
  }

  /* 节奏表：搜索 + 分页（节奏会越来越多） */
  function renderPatterns() {
    if (!global.Pager) return;
    global.Pager.mount('drums.patterns', {
      hostId: 'patternTable',
      placeholder: '搜索节奏（名字 / 拍号 / 说明）…',
      pageSize: 5,
      items: function () { return P.LIST; },
      keywords: function (p) { return p.zh + ' ' + p.en + ' ' + p.sig + ' ' + p.tip + ' ' + p.id; },
      render: function (list, slice) {
        for (var i = 0; i < slice.length; i++) {
          (function (p) {
            var row = document.createElement('div');
            row.className = 'pattern-row' + (p.id === state.patternId ? ' on' : '');
            row.setAttribute('data-pattern', p.id);
            row.appendChild(makeSpan('pattern-name', p.zh));
            row.appendChild(makeSpan('pattern-sig', p.sig));
            row.appendChild(makeSpan('pattern-tip', p.tip));
            row.addEventListener('click', function () { selectPattern(p.id); });
            list.appendChild(row);
          })(slice[i]);
        }
      }
    });
  }

  function makeSpan(cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function render() {
    renderHeader();
    renderSwing();
    renderGrid();
    renderPatterns();
  }

  /* ---------------- 交互 ---------------- */
  function selectPattern(id) {
    state.patternId = id;
    if (S) S.setSetting('sel.drums', id);
    if (global.Pager) global.Pager.showItem('drums.patterns', function (p) { return p.id === id; });
    state.swing = P.byId(id).swing;
    pushToEngine();
    render();
    if (hooks.onChange) hooks.onChange();
    if (global.console && global.console.log) global.console.log('[drums] 节奏 ' + id);
  }

  function setSwing(v) {
    state.swing = v;
    renderSwing();
    pushToEngine();
  }

  function setVolume(v) {
    state.volume = v;
    if (global.Band && global.Band.setMix) {
      global.Band.setMix('drums', v);
    } else {
      D.setVolume(v);
      if (S) S.setSetting('mix.drums', String(v));
    }
    if ($('drumVolValue')) $('drumVolValue').textContent = Math.round(v * 100) + '%';
  }

  /* 点格子三态：关 -> 开 -> 重音 -> 关 */
  function toggleCell(inst, step) {
    var p = pattern();
    var list = p.hits[inst] || (p.hits[inst] = []);
    var acc = p.accents && p.accents[inst] ? p.accents[inst] : (p.accents[inst] = []);
    var i = list.indexOf(step), j = acc.indexOf(step);
    if (i < 0) list.push(step);
    else if (j < 0) acc.push(step);
    else { list.splice(i, 1); acc.splice(j, 1); }
    persist(p);
    renderGrid();
    renderHeader();
  }

  function resetPattern() {
    if (state.edits[state.patternId]) {
      delete state.edits[state.patternId];
      if (S) S.removeItem('drums', state.patternId);
      state.swing = P.byId(state.patternId).swing;
      pushToEngine();
      render();
    }
  }

  function clearPattern() {
    var p = pattern();
    p.hits = {};
    p.accents = {};
    persist(p);
    renderGrid();
    renderHeader();
  }

  /* 播放位置高亮（bandui 每帧调用） */
  function highlightStep(step) {
    if (step === nowStep) return;
    var grid = $('stepGrid');
    if (!grid) return;
    var cells = grid.querySelectorAll('.step-cell');
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('now', Number(cells[i].getAttribute('data-step')) === step);
    }
    var box = $('stepScroll');
    if (box) {
      var target = 58 + step * 24 - box.clientWidth / 2;
      if (target < 0) target = 0;
      box.scrollLeft = target;
    }
    nowStep = step;
  }

  /* 停止后把最后那一格的绿框清掉 */
  function clearHighlight() {
    nowStep = -1;
    var grid = $('stepGrid');
    if (!grid) return;
    var cells = grid.querySelectorAll('.step-cell.now');
    for (var i = 0; i < cells.length; i++) cells[i].classList.remove('now');
  }

  function init(h) {
    hooks = h || {};
    if (S) {
      var savedPattern = S.getSetting('sel.drums', null);
      if (savedPattern) state.patternId = savedPattern;
      var mv = Number(S.getSetting('mix.drums', '0.8'));
      if (isFinite(mv) && mv >= 0 && mv <= 1.2) state.volume = mv;
    }
    $('drumVol').addEventListener('input', function () { setVolume(Number(this.value) / 100); });
    $('btnDrumReset').addEventListener('click', resetPattern);
    $('btnDrumClear').addEventListener('click', clearPattern);
    $('stepGrid').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || !t.getAttribute('data-inst')) return;
      toggleCell(t.getAttribute('data-inst'), Number(t.getAttribute('data-step')));
    });
    pushToEngine();
    render();
  }

  global.DrumsUI = {
    init: init,
    render: render,
    highlightStep: highlightStep,
    clearHighlight: clearHighlight,
    state: state,
    currentPattern: pattern,
    selectPattern: selectPattern,
    setSwing: setSwing,
    setVolume: setVolume,
    toggleCell: toggleCell,
    pushToEngine: pushToEngine
  };
})(window);
