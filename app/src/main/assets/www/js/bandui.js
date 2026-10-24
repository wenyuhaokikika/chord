/*!
 * bandui.js —— 「伴奏」页签的总控界面：速度、启用开关、开始/停止、子页签、迷你播放条
 *
 * 播放位置的高亮在这里统一分发：Transport 每帧吐出「已经真的到点」的事件，
 * 带 source 标记，转给对应子面板去点亮（鼓机的格子 / 伴奏的和弦与格子）。
 */
(function (global) {
  'use strict';

  var Band = global.Band, T = global.Transport, D = global.Drums, B = global.Backing;

  function $(id) { return document.getElementById(id); }
  var rafId = null, lastBpmShown = -1;
  var nowChord = null;      /* 当前正在响的和弦（跟着实际发声的事件走） */

  /* ---------------- 启用开关 ---------------- */
  function renderEnables() {
    var box = $('enableChips');
    if (!box) return;
    var items = [
      { id: 'drums', label: '鼓机', on: Band.state.drumsOn },
      { id: 'backing', label: '伴奏', on: Band.state.backingOn }
    ];
    while (box.firstChild) box.removeChild(box.firstChild);
    for (var i = 0; i < items.length; i++) {
      (function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip sm' + (it.on ? ' on' : '');
        b.setAttribute('data-enable', it.id);
        b.textContent = (it.on ? '✓ ' : '') + it.label + (it.on ? ' 已启用' : ' 未启用');
        b.addEventListener('click', function () {
          Band.setEnabled(it.id, !Band.state[it.id + 'On']);
        });
        box.appendChild(b);
      })(items[i]);
    }
  }

  /* ---------------- 总控状态 ---------------- */
  function renderStatus() {
    $('bandStatus').textContent = Band.isPlaying()
      ? '正在播放：' + Band.statusText()
      : '已停止 · ' + Band.statusText();
    $('btnBandPlay').textContent = Band.isPlaying() ? '停止' : '开始';
    $('btnBandPlay').classList.toggle('accent', !Band.isPlaying());
    $('bpmValue').textContent = Band.state.bpm;
    if (lastBpmShown !== Band.state.bpm) {
      $('bpmRange').value = Band.state.bpm;
      lastBpmShown = Band.state.bpm;
    }
    /* 停止后清掉播放位置的高亮，免得停在最后一格 */
    if (!Band.isPlaying()) {
      if (global.DrumsUI && global.DrumsUI.clearHighlight) global.DrumsUI.clearHighlight();
      if (global.BackingUI && global.BackingUI.clearHighlight) global.BackingUI.clearHighlight();
      if (global.ImprovUI && global.ImprovUI.clearHighlight) global.ImprovUI.clearHighlight();
      if (global.CraftUI && global.CraftUI.clearHighlight) global.CraftUI.clearHighlight();
      nowChord = null;
      renderNowChord(false);
    }
    if (global.ImprovUI && global.ImprovUI.syncPlayState) global.ImprovUI.syncPlayState();
    if (global.refreshBandHeader) global.refreshBandHeader();
    var mini = $('miniPlayer');
    mini.hidden = !Band.isPlaying();
    document.body.classList.toggle('drums-playing', Band.isPlaying());
    $('mpText').textContent = Band.statusText() + ' · ' + Band.state.bpm + ' BPM';
  }

  /* ---------------- 播放位置分发 ---------------- */
  /* 把队列里已经到点的事件取出来分发（单独抽出来，方便测试直接驱动） */
  function tick() {
    var events = T.drainAll ? T.drainAll() : [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.source === 'drums' && global.DrumsUI) global.DrumsUI.highlightStep(e.step);
      else if (e.source === 'backing') {
        if (global.BackingUI) global.BackingUI.highlight(e);
        setNowChord(e);
      } else if (e.source === 'improv' && global.ImprovUI) {
        global.ImprovUI.highlight(e);
      }
      if (global.CraftUI && global.CraftUI.highlight) global.CraftUI.highlight(e);
    }
  }

  function loop() {
    rafId = global.requestAnimationFrame(loop);
    tick();
  }

  /* 记录并显示「当前和弦」：页头大字 + 迷你条大字 */
  function setNowChord(e) {
    if (!e || !e.chord) return;
    var same = nowChord && nowChord.chordIdx === e.chordIdx &&
      nowChord.chord && nowChord.chord.rootPc === e.chord.rootPc;
    nowChord = e;
    renderNowChord(same);
  }

  function chordText() {
    if (!nowChord || !nowChord.chord) return null;
    var preferFlat = global.CHORD_STATE ? global.CHORD_STATE.preferFlat : false;
    return B.chordName(nowChord.chord, preferFlat);
  }

  /* 播放时页头大字显示当前和弦；不播（或只有鼓机）时显示「伴奏」 */
  function renderNowChord(sameChord) {
    var name = Band.isPlaying() ? chordText() : null;
    var mini = $('mpChord');
    if (mini) {
      mini.textContent = name || (Band.isPlaying() ? '♪' : '--');
      mini.classList.toggle('dim', !name);
    }
    if (!Band.isPlaying() || (global.CHORD_STATE && global.CHORD_STATE.tab !== 'band')) return;
    if (sameChord && $('chordName').textContent === name) return;
    if (!name) return;
    var preferFlat = global.CHORD_STATE ? global.CHORD_STATE.preferFlat : false;
    var st = global.BackingUI ? global.BackingUI.state : null;
    var prog = (st && global.BackingUI.currentProgression) ? global.BackingUI.currentProgression() : null;
    var item = (prog && prog.items[nowChord.chordIdx]) ? prog.items[nowChord.chordIdx] : null;

    $('chordName').textContent = name;
    if (item) {
      var roman = global.Music.romanNumeral(item.degree, item.acc, 'maj', '');
      $('chordRoman').textContent = '第 ' + (nowChord.chordIdx + 1) + ' 个和弦 · ' + roman + ' 级';
    } else {
      $('chordRoman').textContent = '第 ' + (nowChord.chordIdx + 1) + ' 个和弦';
    }
    var tones = global.Chord.chordToneNames(nowChord.chord.rootPc,
      global.Chord.qualityById(nowChord.chord.qualityId), preferFlat);
    var parts = [];
    for (var i = 0; i < tones.length; i++) parts.push(tones[i].name + '(' + tones[i].degree + ')');
    $('chordNotes').textContent = parts.join('  ');
  }

  /* ---------------- 子页签 ---------------- */
  function subTabName() {
    var tabs = document.querySelectorAll('#bandTabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].classList.contains('on')) return tabs[i].getAttribute('data-sub');
    }
    return 'drums';
  }

  function subTab(name) {
    var tabs = document.querySelectorAll('#bandTabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-sub') === name);
    }
    $('subDrums').hidden = (name !== 'drums');
    $('subBacking').hidden = (name !== 'backing');
    if (name === 'backing' && global.BackingUI) global.BackingUI.render();
  }

  function init() {
    Band.init({ onChange: renderStatus });
    renderEnables();
    renderStatus();
    if (!rafId) loop();

    $('btnBandPlay').addEventListener('click', function () {
      if (Band.isPlaying()) {
        Band.stop();
        renderStatus();
        return;
      }
      Band.start();
      renderStatus();
    });
    $('mpStop').addEventListener('click', function () { Band.stop(); renderStatus(); });
    $('mpOpen').addEventListener('click', function () { if (global.openBandTab) global.openBandTab(); });

    $('bpmRange').addEventListener('input', function () {
      Band.setBpm(Number(this.value));
      renderStatus();
    });
    $('bpmMinus').addEventListener('click', function () { Band.setBpm(Band.state.bpm - 1); renderStatus(); });
    $('bpmPlus').addEventListener('click', function () { Band.setBpm(Band.state.bpm + 1); renderStatus(); });
    $('btnTap').addEventListener('click', function () {
      Band.tap();
      renderStatus();
      var self = this;
      self.classList.add('on');
      global.setTimeout(function () { self.classList.remove('on'); }, 150);
    });

    $('enableChips').addEventListener('click', function () { renderEnables(); renderStatus(); });

    $('bandTabs').addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== document.body) {
        if (t.getAttribute && t.getAttribute('data-sub')) break;
        t = t.parentNode;
      }
      if (!t || t === document.body) return;
      subTab(t.getAttribute('data-sub'));
    });
  }

  global.BandUI = {
    init: init,
    tick: tick,
    setNowChord: setNowChord,
    nowChord: function () { return nowChord; },
    render: function () { renderEnables(); renderStatus(); },
    subTab: subTab,
    renderStatus: renderStatus
  };
})(window);
