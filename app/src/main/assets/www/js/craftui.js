/*!
 * craftui.js —— 「作品」详情页：提示词、推荐、和弦/节奏预览、版本、简谱与会话修改
 */
(function (global) {
  'use strict';

  var C = global.Crafts, Imp = global.Improv, M = global.Music, B = global.Backing;
  var Ch = global.Chord;
  var current = null, busy = false, inited = false, previewVersionId = null;
  var versionPage = 1, VERSION_PAGE_SIZE = 5;
  var shapeId = 'auto', register = 'low';

  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function msg(text, isError) {
    var el = $('craftChatMsg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
    el.classList.toggle('on', !!text && !isError);
  }
  function whenText(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function recItem(label, value) {
    var box = make('div', 'rec-item');
    box.appendChild(make('b', null, label));
    box.appendChild(make('span', null, value || '—'));
    return box;
  }

  function versionText(v) {
    if (!v) return '';
    return 'v' + v.no + ' · ' + (v.label || '修改');
  }

  function finalVersion() {
    return current ? C.finalVersion(current) : null;
  }

  function displayVersion() {
    if (!current) return null;
    if (previewVersionId) {
      var v = C.versionById(current, previewVersionId);
      if (v) return v;
    }
    return finalVersion();
  }

  function displayScore() {
    var v = displayVersion();
    return v ? v.score : (current ? current.score : null);
  }

  function versionPageOf(id) {
    if (!current || !current.versions) return 1;
    for (var i = 0; i < current.versions.length; i++) {
      if (current.versions[i].id === id) return Math.floor(i / VERSION_PAGE_SIZE) + 1;
    }
    return 1;
  }

  function scrollToScore() {
    if ($('craftScore') && $('craftScore').scrollIntoView) {
      try { $('craftScore').scrollIntoView({ block: 'center' }); } catch (e) {}
    }
  }

  function renderRecommendation() {
    var box = $('craftRec');
    if (!box) return;
    clear(box);
    if ($('craftRecSource')) {
      $('craftRecSource').textContent = current.recommendation
        ? (current.recommendation.source === 'ai' ? 'LLM 推荐 agent' : '本地推荐') : '未使用推荐 agent';
    }
    if (!current.recommendation) {
      box.appendChild(recItem('伴奏', current.instance
        ? (current.instance.drum && current.instance.drum.zh || '') + ' / ' +
          (current.instance.rhythm && current.instance.rhythm.zh || '') : '—'));
      box.appendChild(recItem('走向', current.instance && current.instance.progression
        ? current.instance.progression.zh : '—'));
      box.appendChild(recItem('速度', current.chosen && current.chosen.bpm
        ? current.chosen.bpm + ' BPM' : (current.instance ? current.instance.bpm + ' BPM' : '—')));
      return;
    }
    var r = current.recommendation;
    box.appendChild(recItem('推荐鼓机', r.drumName + '（' + r.drumId + '）'));
    box.appendChild(recItem('推荐节奏型', r.rhythmName + '（' + r.rhythmId + '）'));
    box.appendChild(recItem('推荐走向', r.progressionName + '（' + r.progressionId + '）'));
    box.appendChild(recItem('推荐速度', (r.bpm || '—') + ' BPM'));
    box.appendChild(recItem('备选 Top5', (r.bpmTop5 || []).join(' / ') + ' BPM'));
    if (current.chosen) {
      box.appendChild(recItem('你的选择', '鼓 ' + (current.chosen.drumName || current.chosen.drumId || '—') +
        ' / 节奏 ' + (current.chosen.rhythmName || current.chosen.rhythmId || '—') +
        ' / 走向 ' + (current.chosen.progressionName || current.chosen.progressionId || '—') +
        ' / ' + (current.chosen.bpm || '—') + ' BPM'));
    }
    if ($('craftRecSource')) {
      $('craftRecSource').textContent =
        (r.source === 'ai' ? 'LLM 推荐 agent' : '本地推荐') +
        (current.chosen && current.chosen.bpm ? ' · 用户选了 ' + current.chosen.bpm + ' BPM' : '');
    }
  }

  /* 和伴奏页一样：和弦名/拍数 + 真实和弦图 + 节奏格子 */
  function renderBandPreview() {
    var box = $('craftBandPreview');
    if (!box) return;
    clear(box);
    var inst = current.instance;
    if (!inst || !inst.progression || !inst.rhythm) {
      box.appendChild(make('div', 'mini-hint', '这个作品没有保存伴奏实例。'));
      if ($('craftBandMeta')) $('craftBandMeta').textContent = '无伴奏';
      return;
    }
    var p = inst.progression;
    var r = inst.rhythm;
    var keyPc = inst.keyPc || 0;
    var scaleId = inst.scaleId || 'major';
    var preferFlat = !!M.FLAT_KEYS[M.mod12(keyPc)];
    var chordRow = make('div', 'craft-chord-row');
    for (var i = 0; i < p.items.length; i++) {
      var it = p.items[i];
      var chord = B.chordAt(keyPc, scaleId, it.degree, it.acc, it.quality);
      var card = make('div', 'craft-chord-card');
      card.setAttribute('data-chord-idx', String(i));
      card.appendChild(make('div', 'pc-name', B.chordName(chord, preferFlat)));
      card.appendChild(make('div', 'pc-beats', (it.beats || 4) + ' 拍'));
      var v = B.voicingFor(chord, inst.register || 'low');
      if (v && global.Render) {
        var svgBox = make('div', 'craft-chord-svg');
        svgBox.innerHTML = global.Render.chordBox(v, {
          labelMode: 'note', preferFlat: preferFlat, rootPc: chord.rootPc
        });
        card.appendChild(svgBox);
      } else {
        card.appendChild(make('div', 'mini-hint', '无指法'));
      }
      chordRow.appendChild(card);
    }
    box.appendChild(chordRow);

    var seqBox = make('div', 'preview-seq craft-rhythm');
    seqBox.setAttribute('id', 'craftRhythmSeq');
    for (var s = 0; s < r.seq.length; s++) {
      var val = r.seq[s];
      var label = (r.type === 'arp') ? (val === 'R' ? '根' : val) :
        (B.SLOT_ZH[val] || val);
      var slot = make('span', 'rhythm-slot' + (val === '-' ? ' rest' : ''), label);
      slot.setAttribute('data-slot', String(s));
      seqBox.appendChild(slot);
    }
    box.appendChild(seqBox);
    if ($('craftBandMeta')) {
      $('craftBandMeta').textContent = inst.bpm + ' BPM · ' + (r.zh || '节奏型') +
        ' · ' + (p.zh || '走向') + ' · ' + (inst.register || 'low') + '把位';
    }
  }

  function registerZh(id) {
    return id === 'high' ? '高把位' : (id === 'mid' ? '中把位' : '低把位');
  }

  function fillCraftSelect(id, items, selected) {
    var el = $(id);
    if (!el) return;
    clear(el);
    for (var i = 0; i < items.length; i++) {
      var o = document.createElement('option');
      o.value = items[i].id;
      o.textContent = items[i].label || items[i].zh || items[i].id;
      el.appendChild(o);
    }
    var found = false;
    for (i = 0; i < items.length; i++) if (items[i].id === selected) found = true;
    el.value = found ? selected : (items[0] ? items[0].id : '');
    if (el.disabled !== undefined) el.disabled = !items.length;
  }

  function renderCraftSelectors() {
    var score = displayScore();
    if (!score) {
      if ($('craftShapeSelect')) clear($('craftShapeSelect'));
      if ($('craftRegisterSelect')) $('craftRegisterSelect').value = register;
      return;
    }
    var opts = Imp.shapeOptions ? Imp.shapeOptions(score.keyPc, score.scaleId) : [];
    fillCraftSelect('craftShapeSelect', opts, shapeId);
    shapeId = $('craftShapeSelect') ? $('craftShapeSelect').value : 'auto';
    if ($('craftRegisterSelect')) $('craftRegisterSelect').value = register;
  }

  function renderCraftGuitars(bar, slot, currentMidi) {
    var score = displayScore();
    var inst = current && current.instance;
    var melody = $('craftMelodyNeck'), rhythm = $('craftRhythmNeck');
    if (!melody || !rhythm) return;
    bar = bar || 0;
    slot = slot || 0;
    if (!score || !inst || !global.ImprovUI || !global.ImprovUI.fretWindowSvg) {
      melody.innerHTML = '<div class="neck-empty">没有谱面</div>';
      rhythm.innerHTML = '<div class="neck-empty">没有伴奏</div>';
      return;
    }
    var preferFlat = !!M.FLAT_KEYS[M.mod12(inst.keyPc)];
    var plan = Imp.fingeringPlan(score, { shapeId: shapeId });
    var phrase = Imp.phraseForBar ? Imp.phraseForBar(plan, bar) : null;
    var scalePcs = [], tones = M.scaleTones(score.keyPc, score.scaleId, preferFlat);
    for (var t = 0; t < tones.length; t++) scalePcs.push(tones[t].pc);

    if (phrase) {
      var displayBase = phrase.base, displayEnd = phrase.endFret;
      var markers = [], seen = {};
      for (var k in phrase.map) {
        if (!phrase.map.hasOwnProperty(k)) continue;
        var m = phrase.map[k];
        if (m.fret < displayBase) displayBase = m.fret;
        if (m.fret > displayEnd) displayEnd = m.fret;
        var mk = m.string + ':' + m.fret;
        if (seen[mk]) continue;
        seen[mk] = true;
        markers.push({
          kind: 'used', s: m.string, f: m.fret, shift: !!m.outside,
          label: M.noteName(M.mod12(m.midi), preferFlat)
        });
      }
      var cur = phrase.map[bar + ':' + slot] || null;
      if (currentMidi !== undefined && currentMidi !== null) {
        var ps = Imp.positionsInWindow(currentMidi, displayBase, displayEnd - displayBase + 1);
        if (ps.length) cur = { string: ps[0].s, fret: ps[0].f, midi: currentMidi, outside: false };
      }
      if (cur) {
        markers.push({
          kind: 'current', s: cur.string, f: cur.fret, outside: false,
          label: Imp.midiName(currentMidi === undefined || currentMidi === null ? cur.midi : currentMidi, preferFlat)
        });
      }
      var displaySize = Math.max(phrase.size, displayEnd - displayBase + 1);
      melody.innerHTML = global.ImprovUI.fretWindowSvg({
        base: displayBase, size: displaySize, scalePcs: scalePcs, markers: markers,
        aria: '作品旋律吉他指板'
      });
      if ($('craftMelodyShape')) {
        $('craftMelodyShape').textContent = phrase.shape + ' 指型 · ' + phrase.base + '–' +
          phrase.endFret + ' 品';
      }
      if ($('craftMelodyUsed')) {
        $('craftMelodyUsed').textContent = '用到的音：' + (plan && plan.used.length ? plan.used.join(' ') : '--');
      }
      var warnings = plan && plan.warnings || [];
      if ($('craftShapeWarn')) {
        if (warnings.length) {
          $('craftShapeWarn').textContent = '↕ ' + warnings.length + ' 个音超出「' +
            phrase.shape + '」指型，已换把位显示';
          $('craftShapeWarn').hidden = false;
        } else {
          $('craftShapeWarn').hidden = true;
        }
      }
    } else {
      melody.innerHTML = '<div class="neck-empty">没有旋律指型</div>';
      if ($('craftMelodyShape')) $('craftMelodyShape').textContent = '--';
      if ($('craftShapeWarn')) $('craftShapeWarn').hidden = true;
    }

    var grid = Imp.progressionGrid(inst.progression, inst.keyPc, inst.scaleId);
    var chord = Imp.chordAtSlot(grid, bar, 0);
    if (!chord) {
      rhythm.innerHTML = '<div class="neck-empty">没有和弦</div>';
      if ($('craftRhythmChord')) $('craftRhythmChord').textContent = '--';
      return;
    }
    var v = B.voicingFor(chord, register);
    if (!v) {
      rhythm.innerHTML = '<div class="neck-empty">找不到这个把位的和弦</div>';
      return;
    }
    var base = 0, maxF = 0, minP = 99, s;
    for (s = 0; s < 6; s++) {
      var f = v.frets[s];
      if (f > 0) { minP = Math.min(minP, f); maxF = Math.max(maxF, f); }
    }
    if (minP !== 99 && maxF > 4) base = Math.max(0, minP);
    var size = (minP !== 99 && maxF - minP >= 5) ? 6 : 5;
    var cm = [];
    for (s = 0; s < 6; s++) {
      if (v.frets[s] > 0) {
        cm.push({ kind: 'chord', s: s, f: v.frets[s],
          label: M.noteName(Ch.pcAt(s, v.frets[s]), preferFlat) });
      }
    }
    rhythm.innerHTML = global.ImprovUI.fretWindowSvg({
      base: base, size: size, markers: cm, openMute: v.frets,
      aria: '作品节奏吉他指板'
    });
    if ($('craftRhythmChord')) {
      $('craftRhythmChord').textContent = B.chordName(chord, preferFlat) + ' · ' + registerZh(register);
    }
    if ($('craftGuitarHint')) {
      $('craftGuitarHint').textContent = '旋律推荐 ' + (phrase ? phrase.shape + ' 指型 · ' +
        phrase.base + '–' + phrase.endFret + ' 品' : '--') + ' · 节奏 ' + registerZh(register);
    }
  }


  function renderMix() {
    var mix = (global.Band && global.Band.state.mix) || { drums: 0.8, backing: 1, solo: 1.2 };
    if ($('craftMixDrums')) $('craftMixDrums').value = Math.round(mix.drums * 100);
    if ($('craftMixBacking')) $('craftMixBacking').value = Math.round(mix.backing * 100);
    if ($('craftMixSolo')) $('craftMixSolo').value = Math.round(mix.solo * 100);
    if ($('craftMixDrumsValue')) $('craftMixDrumsValue').textContent = Math.round(mix.drums * 100) + '%';
    if ($('craftMixBackingValue')) $('craftMixBackingValue').textContent = Math.round(mix.backing * 100) + '%';
    if ($('craftMixSoloValue')) $('craftMixSoloValue').textContent = Math.round(mix.solo * 100) + '%';
  }

  function renderVersions() {
    var box = $('craftVersions');
    if (!box) return;
    clear(box);
    C.ensureVersions(current);
    var versions = current.versions || [];
    var fv = finalVersion();
    var finalId = fv ? fv.id : current.finalVersionId;
    var shown = displayVersion();
    var hint = $('craftVersionHint');
    if (hint) {
      if (shown && finalId && shown.id !== finalId) {
        hint.textContent = '正在预览 ' + versionText(shown) + '；最终版本是 ' + versionText(fv) +
          ' · 表格可左右滑动';
      } else {
        hint.textContent = '共 ' + versions.length + ' 个版本 · 最终版本 ' + versionText(fv) +
          ' · 表格可左右滑动';
      }
    }
    if (shown && finalId && shown.id !== finalId) {
      var back = make('button', 'mini-toggle version-back', '回到最终版本');
      back.type = 'button';
      back.addEventListener('click', function () {
        previewVersionId = null;
        render();
        scrollToScore();
      });
      box.appendChild(back);
    }
    if (previewVersionId) {
      /* 预览由消息/表格按钮触发，那里已经切到对应页码；这里不强制翻页，以免无法浏览其它页。 */
    }
    var totalPages = Math.max(1, Math.ceil(versions.length / VERSION_PAGE_SIZE));
    if (versionPage < 1) versionPage = 1;
    if (versionPage > totalPages) versionPage = totalPages;
    var wrap = make('div', 'craft-version-table-wrap');
    var table = make('table', 'craft-version-table');
    var thead = make('thead');
    var htr = make('tr');
    var heads = ['版本', '速度', '鼓机', '节奏型', '和弦走向', '修改提示词', '时间', '操作'];
    for (var h = 0; h < heads.length; h++) htr.appendChild(make('th', null, heads[h]));
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = make('tbody');
    var start = (versionPage - 1) * VERSION_PAGE_SIZE;
    var end = Math.min(versions.length, start + VERSION_PAGE_SIZE);
    for (var i = start; i < end; i++) {
      (function (v) {
        var isFinal = v.id === finalId;
        var isPreview = !!previewVersionId && v.id === previewVersionId;
        var s = v.settings || {};
        var tr = make('tr', 'craft-version-row' +
          (isFinal ? ' final' : '') + (isPreview ? ' preview' : ''));
        tr.setAttribute('data-version', v.id);
        var verCell = make('td', 'ver-cell');
        var verHead = make('div', 'ver-head');
        verHead.appendChild(make('b', null, 'v' + v.no));
        verHead.appendChild(make('span', 'ver-label', v.label || '修改'));
        if (isFinal) verHead.appendChild(make('span', 'version-badge final-badge', '最终'));
        if (isPreview) verHead.appendChild(make('span', 'version-badge preview-badge', '预览中'));
        verCell.appendChild(verHead);
        tr.appendChild(verCell);
        tr.appendChild(make('td', 'num-cell', s.bpm ? s.bpm + ' BPM' : '—'));
        tr.appendChild(make('td', null, s.drumName || s.drumId || '—'));
        tr.appendChild(make('td', null, s.rhythmName || s.rhythmId || '—'));
        tr.appendChild(make('td', null, s.progressionName || s.progressionId || '—'));
        var note = v.note || (v.no === 1 ? '初版生成' : '手动保存');
        var noteTd = make('td', 'note-cell', note);
        noteTd.title = note;
        tr.appendChild(noteTd);
        tr.appendChild(make('td', 'time-cell', whenText(v.createdAt)));
        var op = make('td', 'op-cell');
        var label = isPreview ? '预览中' : (isFinal && !previewVersionId ? '当前显示' : '预览');
        var btn = make('button', 'mini-toggle', label);
        btn.type = 'button';
        btn.disabled = isPreview || (isFinal && !previewVersionId);
        btn.addEventListener('click', function () {
          previewVersionId = isFinal ? null : v.id;
          versionPage = Math.floor(i / VERSION_PAGE_SIZE) + 1;
          render();
          scrollToScore();
        });
        op.appendChild(btn);
        tr.appendChild(op);
        tbody.appendChild(tr);
      })(versions[i]);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
    if (totalPages > 1) {
      var pager = make('div', 'version-pager');
      var prev = make('button', 'mini-toggle', '上一页');
      prev.type = 'button';
      prev.disabled = versionPage <= 1;
      prev.addEventListener('click', function () {
        if (versionPage > 1) { versionPage--; render(); }
      });
      var info = make('span', 'mini-hint', '第 ' + versionPage + ' / ' + totalPages +
        ' 页 · 共 ' + versions.length + ' 个版本');
      var next = make('button', 'mini-toggle', '下一页');
      next.type = 'button';
      next.disabled = versionPage >= totalPages;
      next.addEventListener('click', function () {
        if (versionPage < totalPages) { versionPage++; render(); }
      });
      pager.appendChild(prev);
      pager.appendChild(info);
      pager.appendChild(next);
      box.appendChild(pager);
    }
  }

  function renderMessages() {
    var box = $('craftMessages');
    if (!box) return;
    clear(box);
    var list = current.messages || [];
    if (!list.length) {
      box.appendChild(make('div', 'mini-hint', '还没有修改记录。可以直接在下面描述想怎么改。'));
      return;
    }
    var fv = finalVersion();
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var b = make('div', 'craft-msg ' + (m.role === 'user' ? 'user' : 'assistant'));
      b.appendChild(make('div', 'craft-msg-text', m.text));
      if (m.versionId) {
        var v = C.versionById(current, m.versionId);
        var link = make('button', 'mini-toggle version-link',
          '预览 ' + (v ? versionText(v) : '版本'));
        link.type = 'button';
        link.addEventListener('click', function (vid) {
          return function () {
            previewVersionId = (finalVersion() && finalVersion().id === vid) ? null : vid;
            versionPage = versionPageOf(vid);
            render();
            scrollToScore();
          };
        }(m.versionId));
        b.appendChild(link);
        if (fv && m.versionId === fv.id) {
          b.appendChild(make('span', 'version-badge final-badge', '最终版本'));
        }
      }
      b.appendChild(make('span', 'msg-meta', (m.role === 'user' ? '你' : '编曲助手') +
        (m.at ? ' · ' + whenText(m.at) : '')));
      box.appendChild(b);
    }
    box.scrollTop = box.scrollHeight;
  }

  function render() {
    if (!current) return;
    C.ensureVersions(current);
    if (previewVersionId && !C.versionById(current, previewVersionId)) previewVersionId = null;
    if ($('craftTitle')) $('craftTitle').textContent = current.title || '作品';
    if ($('craftMeta')) {
      $('craftMeta').textContent = [
        current.instance ? current.instance.bpm + ' BPM' : '',
        current.instance ? M.keyName(current.instance.keyPc, false) + ' ' +
          M.scaleInfo(current.instance.scaleId).label : '',
        whenText(current.updatedAt || current.createdAt)
      ].filter(function (x) { return !!x; }).join(' · ');
    }
    if ($('craftPrompt')) {
      var prompt = current.prompt || '';
      $('craftPrompt').textContent = prompt || '未填写场景提示词（按当前伴奏实例生成）';
      $('craftPrompt').classList.toggle('empty', !prompt);
    }
    renderRecommendation();
    renderBandPreview();
    renderMix();
    renderVersions();
    var score = displayScore();
    var shown = displayVersion();
    if ($('craftScore')) {
      $('craftScore').innerHTML = score ? Imp.renderScoreHtml(score) :
        '<div class="score-empty">没有谱面</div>';
    }
    renderCraftSelectors();
    renderCraftGuitars(0, 0, null);
    if ($('craftScoreMeta')) {
      var meta = score ? Imp.detailText(score) : '';
      if (shown && finalVersion() && shown.id !== finalVersion().id) {
        meta = '预览 ' + versionText(shown) + '（最终 ' + versionText(finalVersion()) + '） · ' + meta;
      } else if (shown) {
        meta = versionText(shown) + ' · ' + meta;
      }
      $('craftScoreMeta').textContent = meta;
    }
    if ($('craftScoreLabel')) {
      $('craftScoreLabel').textContent = (shown && finalVersion() && shown.id !== finalVersion().id)
        ? '简谱 · 版本预览' : '简谱';
    }
    renderMessages();
    if ($('btnCraftPlay')) $('btnCraftPlay').disabled = !score || !current.instance;
    if ($('btnCraftStop')) $('btnCraftStop').disabled = !(global.Band && global.Band.isPlaying());
    if ($('btnCraftSend')) $('btnCraftSend').disabled = busy;
  }

  function open(id) {
    var c = C && C.get(id);
    if (!c) return false;
    C.ensureVersions(c);
    current = c;
    previewVersionId = null;
    versionPage = 1;
    shapeId = 'auto';
    register = (c.instance && c.instance.register) || 'low';
    render();
    return true;
  }

  function back() {
    if (global.applyTab) global.applyTab('works');
  }

  function play() {
    if (!current) return;
    var score = displayScore();
    var shown = displayVersion();
    if (!score || !current.instance) return;
    var inst = global.Instances.clone(current.instance);
    inst.register = register;
    var ok = global.Band.startInstance(inst, score,
      { tone: current.tone || 'electric' });
    if (global.BandUI) global.BandUI.render();
    msg(ok ? ('正在播放 ' + (shown ? versionText(shown) : '作品') + '：' + current.title) :
      '播放没有启动', !ok);
    render();
  }

  function stop() {
    if (global.Band) global.Band.stop();
    if (global.BandUI) global.BandUI.render();
    clearHighlight();
    msg('已停止');
    render();
  }

  function send() {
    if (!current || busy) return;
    var input = $('craftChatInput');
    var text = input ? input.value.replace(/^\s+|\s+$/g, '') : '';
    if (!text) { msg('先写一句想怎么改', true); return; }
    if (input) input.value = '';
    current = C.addMessage(current, 'user', text);
    busy = true;
    previewVersionId = null;
    render();
    msg('编曲助手正在修改…');
    C.editScore(current, text).then(function (r) {
      var ver = C.addVersion(current, r.score, {
        label: '对话修改', note: text, source: 'ai'
      });
      current = C.addMessage(current, 'assistant', r.reply, ver ? ver.id : '');
      busy = false;
      previewVersionId = null;
      versionPage = Math.ceil((current.versions ? current.versions.length : 1) / VERSION_PAGE_SIZE);
      render();
      msg('已生成 ' + (ver ? versionText(ver) : '新版本') + '，默认显示最终版本');
    }, function (e) {
      current = C.addMessage(current, 'assistant', '修改失败：' + (e.message || e));
      busy = false;
      render();
      msg('修改失败：' + (e.message || e), true);
    });
  }

  function highlight(ev) {
    if (!current || !ev) return;
    if ($('viewCraft') && $('viewCraft').hidden) return;
    if (ev.source === 'backing') {
      var chords = document.querySelectorAll('#craftBandPreview .craft-chord-card');
      for (var i = 0; i < chords.length; i++) {
        chords[i].classList.toggle('now', Number(chords[i].getAttribute('data-chord-idx')) === ev.chordIdx);
      }
      var slots = document.querySelectorAll('#craftRhythmSeq .rhythm-slot');
      for (i = 0; i < slots.length; i++) {
        slots[i].classList.toggle('now', Number(slots[i].getAttribute('data-slot')) === ev.slot);
      }
    } else if (ev.source === 'improv') {
      var cells = document.querySelectorAll('#craftScore .jp-cell');
      for (var c = 0; c < cells.length; c++) {
        var bar = Number(cells[c].getAttribute('data-bar'));
        var slot = Number(cells[c].getAttribute('data-slot'));
        cells[c].classList.toggle('now', bar === ev.bar && slot === ev.slot);
      }
      var bars = document.querySelectorAll('#craftScore .jp-bar');
      for (i = 0; i < bars.length; i++) {
        bars[i].classList.toggle('playing', Number(bars[i].getAttribute('data-bar')) === ev.bar);
      }
      renderCraftGuitars(ev.bar, ev.slot, ev.midi);
    }
  }

  function clearHighlight() {
    var nodes = document.querySelectorAll('#craftBandPreview .now, #craftRhythmSeq .now, ' +
      '#craftScore .jp-cell.now, #craftScore .jp-bar.playing');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.remove('now');
      nodes[i].classList.remove('playing');
    }
    if ($('viewCraft') && !$('viewCraft').hidden) renderCraftGuitars(0, 0, null);
  }

  function init() {
    if (inited) return;
    inited = true;
    var backBtn = $('btnCraftBack');
    if (backBtn) backBtn.addEventListener('click', back);
    var playBtn = $('btnCraftPlay');
    if (playBtn) playBtn.addEventListener('click', play);
    var stopBtn = $('btnCraftStop');
    if (stopBtn) stopBtn.addEventListener('click', stop);
    var sendBtn = $('btnCraftSend');
    if (sendBtn) sendBtn.addEventListener('click', send);
    var input = $('craftChatInput');
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    function bindMix(id, role) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', function () {
        if (global.Band) global.Band.setMix(role, Number(this.value) / 100);
        renderMix();
      });
    }
    bindMix('craftMixDrums', 'drums');
    bindMix('craftMixBacking', 'backing');
    bindMix('craftMixSolo', 'solo');
    if ($('craftShapeSelect')) {
      $('craftShapeSelect').addEventListener('change', function () {
        shapeId = this.value || 'auto';
        renderCraftGuitars(0, 0, null);
      });
    }
    if ($('craftRegisterSelect')) {
      $('craftRegisterSelect').addEventListener('change', function () {
        register = this.value || 'low';
        renderCraftGuitars(0, 0, null);
      });
    }
  }

  global.CraftUI = {
    init: init,
    open: open,
    current: function () { return current; },
    displayScore: function () { return displayScore(); },
    displayVersion: function () { return displayVersion(); },
    highlight: highlight,
    clearHighlight: clearHighlight,
    render: render
  };
})(window);
