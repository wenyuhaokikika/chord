/*!
 * backingui.js —— 「伴奏」子页签：调式、和弦走向、节奏型，以及它们的新建/编辑
 *
 * 两个编辑器都遵循同一套模式：点「新建」→ 在面板里填 → 「保存并启用」。
 * 保存下来的自定义内容只放在内存里（演示用），但内核结构跟内置预设完全一样。
 */
(function (global) {
  'use strict';

  var M = global.Music, B = global.Backing, C = global.Chord, S = global.Store;

  var state = {
    progId: 'pop4',
    rhythmId: 'arp5321',
    customProgs: [],       /* 用户新建的走向（会写进本地库） */
    customRhythms: [],     /* 用户新建的节奏型（会写进本地库） */
    editing: null          /* {kind:'prog'|'rhythm', draft:...} */
  };

  /* 从本地库读回自建内容；并恢复上次选中的走向/节奏型 */
  function loadFromStore() {
    if (!S) return;
    state.customProgs = S.listItems('progression');
    state.customRhythms = S.listItems('rhythm');
    var savedProg = S.getSetting('sel.progression', null);
    if (savedProg) {
      var ok = false, i;
      for (i = 0; i < state.customProgs.length; i++) if (state.customProgs[i].id === savedProg) ok = true;
      for (i = 0; i < B.PROGRESSIONS.length; i++) if (B.PROGRESSIONS[i].id === savedProg) ok = true;
      if (ok) state.progId = savedProg;
    }
    var savedRhythm = S.getSetting('sel.rhythm', null);
    if (savedRhythm) {
      var ok2 = false;
      for (i = 0; i < state.customRhythms.length; i++) if (state.customRhythms[i].id === savedRhythm) ok2 = true;
      for (i = 0; i < B.RHYTHMS.length; i++) if (B.RHYTHMS[i].id === savedRhythm) ok2 = true;
      if (ok2) state.rhythmId = savedRhythm;
    }
    if (global.console && global.console.log) {
      global.console.log('[store] ' + S.backend() + ' ' + S.info() +
        ' 自建走向=' + state.customProgs.length + ' 自建节奏型=' + state.customRhythms.length);
    }
  }
  var hooks = {};

  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function chipRow(box, items, isOn, onPick, cls) {
    clear(box);
    for (var i = 0; i < items.length; i++) {
      (function (it) {
        var b = make('button', 'chip sm' + (cls ? ' ' + cls : '') + (isOn(it) ? ' on' : ''), it.label);
        b.type = 'button';
        b.addEventListener('click', function () { onPick(it); });
        box.appendChild(b);
      })(items[i]);
    }
  }

  /* ---------- 供其它模块读写的接口 ---------- */
  function allProgressions() {
    return B.PROGRESSIONS.concat(state.customProgs);
  }
  function allRhythms() {
    return B.RHYTHMS.concat(state.customRhythms);
  }
  function progressionById(id) {
    var list = allProgressions();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }
  function rhythmById(id) {
    var list = allRhythms();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }
  function currentProgression() { return progressionById(state.progId); }
  function currentRhythm() { return rhythmById(state.rhythmId); }

  /* 把当前走向 + 节奏型交给引擎（调式由和弦页的 state 提供） */
  function pushToEngine() {
    var keyPc = (global.CHORD_STATE && global.CHORD_STATE.keyPc) || 0;
    var scaleId = (global.CHORD_STATE && global.CHORD_STATE.scaleId) || 'major';
    B.configure(currentProgression(), currentRhythm(), keyPc, scaleId);
  }

  /* ---------- 调式行 ---------- */
  function renderKeyLine() {
    var keyPc = (global.CHORD_STATE && global.CHORD_STATE.keyPc) || 0;
    var scaleId = (global.CHORD_STATE && global.CHORD_STATE.scaleId) || 'major';
    var info = M.scaleInfo(scaleId);
    var preferFlat = global.CHORD_STATE ? global.CHORD_STATE.preferFlat : false;
    $('backingKeyLine').textContent = M.keyName(keyPc, preferFlat) + ' ' + info.label +
      '（' + info.en + '）· 走向里的级数按这个调式取音';
  }

  /* ---------- 和弦走向列表 ---------- */
  /* 一条走向的卡片（列表和分页器共用） */
  function buildProgRow(p) {
    var keyPc = (global.CHORD_STATE && global.CHORD_STATE.keyPc) || 0;
    var scaleId = (global.CHORD_STATE && global.CHORD_STATE.scaleId) || 'major';
    var preferFlat = global.CHORD_STATE ? global.CHORD_STATE.preferFlat : false;
    var row = make('div', 'prog-row' + (p.id === state.progId ? ' on' : ''));
    row.setAttribute('data-prog', p.id);
    var head = make('div', 'prog-head');
    head.appendChild(make('span', 'prog-name', p.zh));
    if (p.custom) head.appendChild(make('span', 'prog-tag', '自建'));
    else if (p.tag) head.appendChild(make('span', 'prog-tag', p.tag));
    head.appendChild(make('span', 'prog-sig', p.items.length + ' 个和弦 · ' + totalBeats(p) + ' 拍'));
    row.appendChild(head);
    var chords = make('div', 'prog-chords');
    for (var k = 0; k < p.items.length; k++) {
      var ch = B.chordAt(keyPc, scaleId, p.items[k].degree, p.items[k].acc, p.items[k].quality);
      chords.appendChild(make('span', 'prog-chord', B.chordName(ch, preferFlat) + ' ' + p.items[k].beats + '拍'));
    }
    row.appendChild(chords);
    row.appendChild(make('div', 'prog-tip', p.tip || ''));
    var btnWrap = make('div', 'row-btns2');
    var editBtn = make('button', 'mini-toggle edit-btn', '编辑');
    editBtn.type = 'button';
    editBtn.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      editProgression(p.id);
    });
    btnWrap.appendChild(editBtn);
    if (p.custom) {
      var delBtn = make('button', 'mini-toggle del-btn', '删除');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function (e) {
        if (e.stopPropagation) e.stopPropagation();
        deleteProgression(p.id);
      });
      btnWrap.appendChild(delBtn);
    }
    row.appendChild(btnWrap);
    row.addEventListener('click', function () { selectProgression(p.id); });
    return row;
  }

  function renderProgressions() {
    if (!global.Pager) return;
    global.Pager.mount('backing.progs', {
      hostId: 'progTable',
      placeholder: '搜索和弦走向（名字 / 说明 / 和弦）…',
      pageSize: 5,
      items: allProgressions,
      keywords: function (p) {
        var keyPc = (global.CHORD_STATE && global.CHORD_STATE.keyPc) || 0;
        var scaleId = (global.CHORD_STATE && global.CHORD_STATE.scaleId) || 'major';
        var preferFlat = global.CHORD_STATE ? global.CHORD_STATE.preferFlat : false;
        var names = [];
        for (var i = 0; i < p.items.length; i++) {
          names.push(B.chordName(B.chordAt(keyPc, scaleId, p.items[i].degree,
            p.items[i].acc, p.items[i].quality), preferFlat));
        }
        return p.zh + ' ' + (p.tip || '') + ' ' + (p.tag || '') + ' ' +
          names.join(' ') + ' ' + p.id;
      },
      render: function (list, slice) {
        for (var i = 0; i < slice.length; i++) list.appendChild(buildProgRow(slice[i]));
      }
    });
  }
  function totalBeats(p) {
    var n = 0;
    for (var i = 0; i < p.items.length; i++) n += p.items[i].beats;
    return n;
  }

  /* 删掉一条自建走向/节奏型（内置的不能删） */
  function deleteProgression(id) {
    if (S) S.removeItem('progression', id);
    var out = [];
    for (var i = 0; i < state.customProgs.length; i++) if (state.customProgs[i].id !== id) out.push(state.customProgs[i]);
    state.customProgs = out;
    if (state.progId === id) selectProgression('pop4');
    renderProgressions();
    renderPreview();
  }
  function deleteRhythm(id) {
    if (S) S.removeItem('rhythm', id);
    var out = [];
    for (var i = 0; i < state.customRhythms.length; i++) if (state.customRhythms[i].id !== id) out.push(state.customRhythms[i]);
    state.customRhythms = out;
    if (state.rhythmId === id) selectRhythm('arp5321');
    renderRhythms();
    renderPreview();
  }

  /* 编辑某条走向：自建的原地改；内置的复制一份出来改（不污染预设） */
  function editProgression(id) {
    var p = progressionById(id);
    if (p.custom) {
      openProgEditor(B.cloneProgression(p));
    } else {
      var d = B.cloneProgression(p);
      d.id = 'custom' + (new Date()).getTime();
      d.zh = p.zh + '（改）';
      d.custom = true;
      d.tip = '在「' + p.zh + '」基础上改出来的';
      openProgEditor(d);
    }
  }

  /* 编辑某条节奏型：规则同上 */
  function editRhythm(id) {
    var r = rhythmById(id);
    if (r.custom) {
      openRhythmEditor(B.cloneRhythm(r));
    } else {
      var d = B.cloneRhythm(r);
      d.id = 'myr' + (new Date()).getTime();
      d.zh = r.zh + '（改）';
      d.custom = true;
      d.tip = '在「' + r.zh + '」基础上改出来的';
      openRhythmEditor(d);
    }
  }

  function selectProgression(id) {
    state.progId = id;
    if (S) S.setSetting('sel.progression', id);
    if (global.Pager) global.Pager.showItem('backing.progs', function (p) { return p.id === id; });
    pushToEngine();
    renderProgressions();
    renderPreview();
    if (global.BandUI) global.BandUI.renderStatus();
    if (global.console) global.console.log('[backing] 走向 ' + id);
  }

  /* ---------- 和弦走向编辑器 ---------- */
  var QUALITY_PICKS = ['maj', 'min', '7', 'maj7', 'm7', 'sus4', 'dim', 'm7b5', 'add9', '5'];
  var BEAT_PICKS = [1, 2, 3, 4, 6, 8];

  function newProgressionDraft() {
    return { id: 'custom' + (new Date()).getTime(), zh: '我的走向', custom: true, tip: '自建走向',
             items: [{ degree: 1, acc: 0, quality: null, beats: 4 },
                     { degree: 5, acc: 0, quality: null, beats: 4 }] };
  }

  function openProgEditor(draft) {
    state.editing = { kind: 'prog', draft: draft || B.cloneProgression(currentProgression()) };
    if (!draft) {
      /* 从现有走向克隆过来改，id 换成自建 */
      state.editing.draft.id = 'custom' + (new Date()).getTime();
      state.editing.draft.zh = currentProgression().zh + '（改）';
      state.editing.draft.custom = true;
      state.editing.draft.tip = '在原有走向上改出来的';
    }
    $('progEditor').hidden = false;
    $('progEditorTitle').textContent = '编辑和弦走向（每行一个和弦）';
    renderProgRows();
    scrollTo2($('progEditor'));
  }

  function renderProgRows() {
    var box = $('progRows');
    clear(box);
    var d = state.editing && state.editing.draft;
    if (!d) return;
    var keyPc = (global.CHORD_STATE && global.CHORD_STATE.keyPc) || 0;
    var scaleId = (global.CHORD_STATE && global.CHORD_STATE.scaleId) || 'major';
    var preferFlat = global.CHORD_STATE ? global.CHORD_STATE.preferFlat : false;

    for (var i = 0; i < d.items.length; i++) {
      (function (item, idx) {
        var card = make('div', 'edit-card');
        var ch = B.chordAt(keyPc, scaleId, item.degree, item.acc, item.quality);
        var head = make('div', 'edit-card-head');
        head.appendChild(make('strong', null, (idx + 1) + '. ' + B.chordName(ch, preferFlat)));
        var del = make('button', 'mini-toggle', '删除');
        del.type = 'button';
        del.addEventListener('click', function () {
          if (d.items.length <= 1) return;
          d.items.splice(idx, 1);
          renderProgRows();
        });
        head.appendChild(del);
        card.appendChild(head);

        card.appendChild(make('div', 'edit-label', '级数（相对主调音阶的第几级）'));
        var degBox = make('div', 'chip-row small');
        var degItems = [];
        for (var k = 1; k <= 7; k++) {
          degItems.push({ v: k, label: M.romanNumeral(k, 0, 'maj').replace(/\u266d|\u266f/g, '') + ' ' + k });
        }
        chipRow(degBox, degItems, function (it) { return it.v === item.degree; },
          function (it) { item.degree = it.v; renderProgRows(); });
        card.appendChild(degBox);

        card.appendChild(make('div', 'edit-label', '变音'));
        var accBox = make('div', 'chip-row small');
        chipRow(accBox, [{ v: -1, label: '♭ 降' }, { v: 0, label: '♮ 本音' }, { v: 1, label: '♯ 升' }],
          function (it) { return it.v === item.acc; },
          function (it) { item.acc = it.v; renderProgRows(); });
        card.appendChild(accBox);

        card.appendChild(make('div', 'edit-label', '和弦属性（“自然”= 该调式在这一级的本调和弦）'));
        var qBox = make('div', 'chip-row small');
        var qItems = [{ v: null, label: '自然' }];
        for (k = 0; k < QUALITY_PICKS.length; k++) {
          var q = C.qualityById(QUALITY_PICKS[k]);
          qItems.push({ v: QUALITY_PICKS[k], label: q.symbol || 'M' });
        }
        chipRow(qBox, qItems, function (it) { return it.v === item.quality; },
          function (it) { item.quality = it.v; renderProgRows(); });
        card.appendChild(qBox);

        card.appendChild(make('div', 'edit-label', '走几拍'));
        var bBox = make('div', 'chip-row small');
        chipRow(bBox, BEAT_PICKS.map(function (v) { return { v: v, label: v + ' 拍' }; }),
          function (it) { return it.v === item.beats; },
          function (it) { item.beats = it.v; renderProgRows(); });
        card.appendChild(bBox);

        box.appendChild(card);
      })(d.items[i], i);
    }
  }

  function saveProg() {
    var d = state.editing && state.editing.draft;
    if (!d) return;
    var errs = B.validateProgression(d);
    if (errs.length) {
      $('progEditorTitle').textContent = '还有问题：' + errs.join('；');
      return;
    }
    /* 同一个 id 就替换，否则新增 */
    var replaced = false;
    for (var i = 0; i < state.customProgs.length; i++) {
      if (state.customProgs[i].id === d.id) { state.customProgs[i] = d; replaced = true; }
    }
    if (!replaced) state.customProgs.push(d);
    if (S) { S.putItem('progression', d.id, d); S.setSetting('sel.progression', d.id); }
    state.progId = d.id;
    state.editing = null;
    $('progEditor').hidden = true;
    pushToEngine();
    renderProgressions();
    if (global.Pager) global.Pager.showItem('backing.progs', function (x) { return x.id === d.id; });
    renderPreview();
    if (global.BandUI) global.BandUI.renderStatus();
  }

  /* ---------- 节奏型列表 ---------- */
  function buildRhythmRow(p) {
    var row = make('div', 'rhythm-row' + (p.id === state.rhythmId ? ' on' : ''));
    row.setAttribute('data-rhythm', p.id);
    var head = make('div', 'rhythm-head');
    head.appendChild(make('span', 'rhythm-name', p.zh));
    head.appendChild(make('span', 'rhythm-tag', p.type === 'arp' ? '分解' : '扫弦'));
    if (p.custom) head.appendChild(make('span', 'prog-tag', '自建'));
    head.appendChild(make('span', 'rhythm-sig', p.beats + ' 拍 × 每拍 ' + p.perBeat + ' 格'));
    row.appendChild(head);
    var seq = make('div', 'rhythm-seq');
    for (var k = 0; k < p.seq.length; k++) {
      var v = p.seq[k];
      var label = (p.type === 'arp') ? (v === 'R' ? '根' : v) : (B.SLOT_ZH[v] || v);
      seq.appendChild(make('span', 'rhythm-slot' + (v === '-' ? ' rest' : ''), label));
    }
    row.appendChild(seq);
    row.appendChild(make('div', 'prog-tip', p.tip || ''));
    var btnWrap2 = make('div', 'row-btns2');
    var editBtn2 = make('button', 'mini-toggle edit-btn', '编辑');
    editBtn2.type = 'button';
    editBtn2.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      editRhythm(p.id);
    });
    btnWrap2.appendChild(editBtn2);
    if (p.custom) {
      var delBtn2 = make('button', 'mini-toggle del-btn', '删除');
      delBtn2.type = 'button';
      delBtn2.addEventListener('click', function (e) {
        if (e.stopPropagation) e.stopPropagation();
        deleteRhythm(p.id);
      });
      btnWrap2.appendChild(delBtn2);
    }
    row.appendChild(btnWrap2);
    row.addEventListener('click', function () { selectRhythm(p.id); });
    return row;
  }

  function renderRhythms() {
    if (!global.Pager) return;
    global.Pager.mount('backing.rhythms', {
      hostId: 'rhythmTable',
      placeholder: '搜索节奏型（名字 / 分解 / 扫弦 / 说明）…',
      pageSize: 6,
      items: allRhythms,
      keywords: function (p) {
        return p.zh + ' ' + (p.tip || '') + ' ' + (p.type === 'arp' ? '分解 arp 指弹' : '扫弦 strum') + ' ' +
          p.beats + '拍 ' + p.id;
      },
      render: function (list, slice) {
        for (var i = 0; i < slice.length; i++) list.appendChild(buildRhythmRow(slice[i]));
      }
    });
  }

  function selectRhythm(id) {
    state.rhythmId = id;
    if (S) S.setSetting('sel.rhythm', id);
    if (global.Pager) global.Pager.showItem('backing.rhythms', function (p) { return p.id === id; });
    pushToEngine();
    renderRhythms();
    renderPreview();
    if (global.BandUI) global.BandUI.renderStatus();
    if (global.console) global.console.log('[backing] 节奏型 ' + id);
  }

  /* ---------- 节奏型编辑器 ---------- */
  function newRhythmDraft(type) {
    var t = type || 'arp';
    return { id: 'myr' + (new Date()).getTime(), zh: t === 'arp' ? '我的分解' : '我的扫弦',
             type: t, beats: 4, perBeat: 2, custom: true, tip: '自建节奏型',
             seq: (t === 'arp' ? ['R', '3', '2', '3', '1', '3', '2', '3']
                               : ['D', '-', 'D', 'U', '-', 'U', 'D', 'U']) };
  }

  function openRhythmEditor(draft) {
    state.editing = { kind: 'rhythm', draft: draft || B.cloneRhythm(currentRhythm()) };
    if (!draft) {
      state.editing.draft.id = 'myr' + (new Date()).getTime();
      state.editing.draft.zh = currentRhythm().zh + '（改）';
      state.editing.draft.custom = true;
    }
    $('rhythmEditor').hidden = false;
    renderRhythmEditor();
    scrollTo2($('rhythmEditor'));
  }

  /* 打开编辑器后滚到可见位置：编辑器在列表之前，但页面可能还停在别处 */
  function scrollTo2(el) {
    if (!el) return;
    if (el.scrollIntoView) {
      try { el.scrollIntoView({ block: 'center' }); } catch (e) { el.scrollIntoView(); }
    }
  }

  /* 改变拍数/格子数时，按新长度重建序列（保留已有内容） */
  function resizeSeq(d) {
    var want = d.beats * d.perBeat;
    var fill = (d.type === 'arp') ? '-' : '-';
    while (d.seq.length < want) d.seq.push(fill);
    d.seq = d.seq.slice(0, want);
  }

  function renderRhythmEditor() {
    var d = state.editing && state.editing.draft;
    if (!d) return;
    $('rhythmEditorTitle').textContent = '编辑节奏型：' + d.zh;
    $('btnRhythmType').textContent = d.type === 'arp' ? '分解' : '扫弦';
    $('reSeqLabel').textContent = d.type === 'arp'
      ? '每个格子弹什么（点一下循环：根音 → 1~6 弦 → 休止）'
      : '每个格子弹什么（点一下循环：下扫 → 上扫 → 切音 → 休止）';

    chipRow($('reBeats'), [2, 3, 4, 6].map(function (v) { return { v: v, label: v + ' 拍' }; }),
      function (it) { return it.v === d.beats; },
      function (it) { d.beats = it.v; resizeSeq(d); renderRhythmEditor(); });

    chipRow($('rePerBeat'), [1, 2, 4].map(function (v) { return { v: v, label: v + ' 格/拍' }; }),
      function (it) { return it.v === d.perBeat; },
      function (it) { d.perBeat = it.v; resizeSeq(d); renderRhythmEditor(); });

    var box = $('reSeq');
    clear(box);
    var slots = B.slots(d);
    for (var i = 0; i < d.seq.length; i++) {
      (function (idx) {
        var v = d.seq[idx];
        var label = (d.type === 'arp') ? (v === 'R' ? '根' : v) : (B.SLOT_ZH[v] || v);
        var b = make('button', 'seq-cell' + (v === '-' ? ' rest' : '') + (v === 'R' ? ' root' : '') +
          (idx % d.perBeat === 0 && idx > 0 ? ' beat' : ''), label);
        b.type = 'button';
        b.addEventListener('click', function () {
          var cur = slots.indexOf(d.seq[idx]);
          d.seq[idx] = slots[(cur + 1) % slots.length];
          renderRhythmEditor();
        });
        box.appendChild(b);
      })(i);
    }
  }

  function saveRhythm() {
    var d = state.editing && state.editing.draft;
    if (!d) return;
    var errs = B.validateRhythm(d);
    if (errs.length) {
      $('rhythmEditorTitle').textContent = '还有问题：' + errs.join('；');
      return;
    }
    var replaced = false;
    for (var i = 0; i < state.customRhythms.length; i++) {
      if (state.customRhythms[i].id === d.id) { state.customRhythms[i] = d; replaced = true; }
    }
    if (!replaced) state.customRhythms.push(d);
    if (S) { S.putItem('rhythm', d.id, d); S.setSetting('sel.rhythm', d.id); }
    state.rhythmId = d.id;
    state.editing = null;
    $('rhythmEditor').hidden = true;
    pushToEngine();
    renderRhythms();
    if (global.Pager) global.Pager.showItem('backing.rhythms', function (x) { return x.id === d.id; });
    renderPreview();
    if (global.BandUI) global.BandUI.renderStatus();
  }

  /* ---------- 走向预览 + 播放高亮 ---------- */
  function renderPreview() {
    var box = $('progPreview');
    clear(box);
    var p = currentProgression();
    var r = currentRhythm();
    var keyPc = (global.CHORD_STATE && global.CHORD_STATE.keyPc) || 0;
    var scaleId = (global.CHORD_STATE && global.CHORD_STATE.scaleId) || 'major';
    var preferFlat = global.CHORD_STATE ? global.CHORD_STATE.preferFlat : false;
    for (var i = 0; i < p.items.length; i++) {
      var ch = B.chordAt(keyPc, scaleId, p.items[i].degree, p.items[i].acc, p.items[i].quality);
      var cell = make('div', 'preview-chord');
      cell.setAttribute('data-chord-idx', String(i));
      cell.appendChild(make('div', 'pc-name', B.chordName(ch, preferFlat)));
      cell.appendChild(make('div', 'pc-beats', p.items[i].beats + ' 拍'));
      box.appendChild(cell);
    }
    var seqBox = make('div', 'preview-seq');
    seqBox.setAttribute('id', 'previewSeq');
    for (i = 0; i < r.seq.length; i++) {
      var v = r.seq[i];
      var label = (r.type === 'arp') ? (v === 'R' ? '根' : v) : (B.SLOT_ZH[v] || v);
      var s = make('span', 'rhythm-slot' + (v === '-' ? ' rest' : ''), label);
      s.setAttribute('data-slot', String(i));
      seqBox.appendChild(s);
    }
    box.appendChild(seqBox);
    $('progHint').textContent = '共 ' + totalBeats(p) + ' 拍（' + r.zh + '：' + r.beats + ' 拍 × 每拍 ' + r.perBeat + ' 格）';
  }

  /* 播放到某个事件时点亮对应和弦与格子 */
  function highlight(ev) {
    var chords = document.querySelectorAll('#progPreview .preview-chord');
    for (var i = 0; i < chords.length; i++) {
      chords[i].classList.toggle('now', Number(chords[i].getAttribute('data-chord-idx')) === ev.chordIdx);
    }
    var slots = document.querySelectorAll('#progPreview .rhythm-slot');
    for (i = 0; i < slots.length; i++) {
      slots[i].classList.toggle('now', Number(slots[i].getAttribute('data-slot')) === ev.slot);
    }
  }

  /* 停止后把和弦与格子的高亮清掉 */
  function clearHighlight() {
    var chords = document.querySelectorAll('#progPreview .preview-chord.now');
    var i;
    for (i = 0; i < chords.length; i++) chords[i].classList.remove('now');
    var slots = document.querySelectorAll('#progPreview .rhythm-slot.now');
    for (i = 0; i < slots.length; i++) slots[i].classList.remove('now');
  }

  /* ---------- 渲染入口 ---------- */
  function render() {
    renderKeyLine();
    renderProgressions();
    renderRhythms();
    renderPreview();
  }

  function init(h) {
    hooks = h || {};
    $('btnBackingKey').addEventListener('click', function () {
      if (hooks.onPickKey) hooks.onPickKey();
    });
    $('btnNewProg').addEventListener('click', function () { openProgEditor(newProgressionDraft()); });
    $('btnAddChord').addEventListener('click', function () {
      var d = state.editing && state.editing.draft;
      if (!d) return;
      d.items.push({ degree: 1, acc: 0, quality: null, beats: 4 });
      renderProgRows();
    });
    $('btnProgSave').addEventListener('click', saveProg);
    $('btnProgCancel').addEventListener('click', function () {
      state.editing = null;
      $('progEditor').hidden = true;
    });
    $('btnNewRhythm').addEventListener('click', function () { openRhythmEditor(newRhythmDraft('arp')); });
    $('btnRhythmType').addEventListener('click', function () {
      var d = state.editing && state.editing.draft;
      if (!d) return;
      d.type = (d.type === 'arp') ? 'strum' : 'arp';
      d.seq = (d.type === 'arp') ? ['R', '3', '2', '3', '1', '3', '2', '3'] : ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'];
      d.beats = 4; d.perBeat = 2;
      renderRhythmEditor();
    });
    $('btnRhythmSave').addEventListener('click', saveRhythm);
    $('btnRhythmCancel').addEventListener('click', function () {
      state.editing = null;
      $('rhythmEditor').hidden = true;
    });
    loadFromStore();
    pushToEngine();
    render();
  }

  global.BackingUI = {
    init: init,
    render: render,
    highlight: highlight,
    clearHighlight: clearHighlight,
    state: state,
    currentProgression: currentProgression,
    currentRhythm: currentRhythm,
    selectProgression: selectProgression,
    selectRhythm: selectRhythm,
    openProgEditor: openProgEditor,
    openRhythmEditor: openRhythmEditor,
    editProgression: editProgression,
    editRhythm: editRhythm,
    deleteProgression: deleteProgression,
    deleteRhythm: deleteRhythm,
    loadFromStore: loadFromStore,
    newProgressionDraft: newProgressionDraft,
    newRhythmDraft: newRhythmDraft,
    saveProg: saveProg,
    saveRhythm: saveRhythm,
    pushToEngine: pushToEngine,
    renderPreview: renderPreview
  };
})(window);
