/*!
 * improvui.js —— 独立「即兴」页的界面
 *
 * 页面职责：
 *   1. 选择伴奏实例（鼓 + 走向 + 节奏型 + 调式/速度）
 *   2. 风格 / 长度（1–3 loop）/ 音色 / Bias / 三路音量 / 节奏把位
 *   3. 任务队列、流式思考、生成完毕才显示简谱
 *   4. 双吉他指板：左边旋律（Mi/La 指型优先），右边节奏和弦（高/中/低把位）
 *   5. API 配置放在 dialog 里，不占页面
 *
 * 乐理、agent、指型规划都在 improv.js；这里只做显示与转发。
 */
(function (global) {
  'use strict';

  var Imp = global.Improv, LLM = global.LLM, S = global.Store;
  var M = global.Music, B = global.Backing, A = global.Audio_, C = global.Chord;
  var AQ = global.AgentQueue;

  var state = {
    styleId: 'penta',
    bias: 40,
    rangeBias: 0.5,
    tone: 'electric',
    volume: 1.2,
    loops: 1,
    register: 'low',
    shapeId: 'auto',
    instance: null,
    prompt: '',
    recommendation: null,
    recDraft: null,
    recPrompt: '',
    recSeq: 0,
    chosenBpm: 0,
    pendingCraft: null,
    currentCraft: null,
    fingering: null,
    curBar: 0,
    curSlot: 0,
    lib: 'craft',
    busy: false,
    suggestion: null,
    lastBar: -1,
    renderedScore: null
  };

  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function on(el, type, fn) { if (el) el.addEventListener(type, fn); }
  function keyPc() { return state.instance ? state.instance.keyPc : (global.CHORD_STATE ? global.CHORD_STATE.keyPc : 0); }
  function scaleId() { return state.instance ? state.instance.scaleId : (global.CHORD_STATE ? global.CHORD_STATE.scaleId : 'major'); }
  function preferFlat() {
    if (state.instance) return !!M.FLAT_KEYS[M.mod12(state.instance.keyPc)];
    return global.CHORD_STATE ? !!global.CHORD_STATE.preferFlat : false;
  }
  function bpm() { return state.instance ? state.instance.bpm : (global.Band ? global.Band.state.bpm : 100); }

  function msg(text, isError) {
    var el = $('improvMsg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
    el.classList.toggle('on', !!text && !isError);
  }

  /* ============================ AI 接口（dialog） ============================ */
  function renderVendorSelect() {
    var sel = $('llmVendor');
    if (!sel) return;
    clear(sel);
    for (var i = 0; i < LLM.VENDORS.length; i++) {
      var opt = document.createElement('option');
      opt.value = LLM.VENDORS[i].id;
      opt.textContent = LLM.VENDORS[i].label;
      if (LLM.VENDORS[i].id === LLM.state.vendor) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  /* 兼容旧函数名：现在厂商是 select，不再是 chip */
  function renderVendorChips() { renderVendorSelect(); }

  function fillConfigInputs() {
    if (!$('llmBase')) return;
    var v = LLM.vendorById(LLM.state.vendor);
    renderVendorSelect();
    if ($('llmVendor')) $('llmVendor').value = LLM.state.vendor;
    $('llmBase').value = LLM.state.base || '';
    $('llmBase').placeholder = v.base || 'https://…/v1';
    $('llmModel').value = LLM.state.model || '';
    $('llmModel').placeholder = v.model || '模型名';
    $('llmKey').value = LLM.state.key || '';
    renderApiState();
    renderThemeSetting();
    updateContextHint();
    updateModeBanner();
  }

  function renderThemeSetting() {
    if (!$('themeSelect')) return;
    var theme = S ? S.getSetting('ui.theme', 'auto') : 'auto';
    if (theme !== 'light' && theme !== 'dark') theme = 'auto';
    $('themeSelect').value = theme;
  }

  function openApiDialog() {
    var d = $('apiDialog');
    if (!d) return;
    d.hidden = false;
    fillConfigInputs();
    var k = $('llmKey');
    if (k && k.focus) {
      try { k.focus(); } catch (e) {}
    }
  }

  function closeApiDialog() {
    var d = $('apiDialog');
    if (d) d.hidden = true;
  }

  /* 显眼地告诉用户：现在生成的是 LLM solo 还是本地规则 solo */
  function updateModeBanner() {
    var el = $('modeBanner');
    if (!el) return;
    if (LLM.ready()) {
      el.className = 'mode-banner ai';
      el.textContent = '当前：LLM solo · ' + LLM.effective().model +
        '（生成会走 4 个 agent）';
    } else {
      el.className = 'mode-banner local';
      el.textContent = '当前：本地 solo（未配置 API）。点右上角「设置」填厂商 / 模型 / Key 后，才是 LLM solo。';
    }
  }

  function readConfig() {
    if (!$('llmBase')) return;
    var vendor = $('llmVendor') ? $('llmVendor').value : LLM.state.vendor;
    LLM.save({
      vendor: vendor,
      base: $('llmBase').value.replace(/^\s+|\s+$/g, ''),
      model: $('llmModel').value.replace(/^\s+|\s+$/g, ''),
      key: $('llmKey').value.replace(/^\s+|\s+$/g, '')
    });
    renderApiState();
    updateContextHint();
    updateModeBanner();
  }

  function renderApiState() {
    var el = $('apiState');
    if (!el) return;
    if (!LLM.ready()) {
      el.textContent = '未配置';
      el.classList.remove('ok');
      return;
    }
    var e = LLM.effective();
    el.textContent = '已配置 · ' + e.model;
    el.classList.add('ok');
    el.title = e.base;
  }

  function testConnection() {
    readConfig();
    if (!LLM.ready()) {
      msg('先填写厂商 / 模型 / API Key，再测试连接', true);
      openApiDialog();
      return;
    }
    var btn = $('btnLlmTest');
    btn.disabled = true;
    btn.textContent = '测试中…';
    $('apiState').textContent = '连接中…';
    LLM.test().then(function (r) {
      btn.disabled = false;
      btn.textContent = '测试连接';
      if (r.ok) {
        $('apiState').textContent = '连接成功 · ' + r.model + ' · ' + r.ms + ' ms';
        $('apiState').classList.add('ok');
        msg('连接成功：' + (r.content || 'JSON 正常') + '（' + r.ms + ' ms' +
          (r.usage && r.usage.total_tokens ? '，' + r.usage.total_tokens + ' tokens' : '') + '）');
        updateContextHint();
        updateModeBanner();
        if (global.console && global.console.log) {
          global.console.log('[improv] LLM 测试通过 ' + r.model + ' ' + r.ms + 'ms');
        }
      } else {
        $('apiState').textContent = '连接失败';
        $('apiState').classList.remove('ok');
        msg(r.error || '连接失败', true);
      }
    }, function (e) {
      btn.disabled = false;
      btn.textContent = '测试连接';
      $('apiState').textContent = '连接失败';
      msg('连接失败：' + (e.message || e), true);
    });
  }

  /* ============================ 设置 ============================ */
  function fillSelect(sel, items, value) {
    if (!sel) return;
    clear(sel);
    for (var i = 0; i < items.length; i++) {
      var opt = document.createElement('option');
      opt.value = items[i].v;
      opt.textContent = items[i].t;
      if (String(items[i].v) === String(value)) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function renderStyleChips() {
    var items = [];
    for (var i = 0; i < Imp.STYLES.length; i++) {
      items.push({ v: Imp.STYLES[i].id, t: Imp.STYLES[i].zh });
    }
    fillSelect($('styleSelect'), items, state.styleId);
  }

  function renderToneChips() {
    if (!A) return;
    var list = A.toneNames(), items = [];
    for (var i = 0; i < list.length; i++) items.push({ v: list[i].id, t: list[i].zh });
    fillSelect($('toneSelect'), items, state.tone);
  }

  function renderShapeSelect() {
    var sc = Imp.state.score;
    var key = sc ? sc.keyPc : keyPc();
    var scale = sc ? sc.scaleId : scaleId();
    var options = Imp.shapeOptions ? Imp.shapeOptions(key, scale) : [];
    var items = [], valid = false;
    for (var i = 0; i < options.length; i++) {
      items.push({ v: options[i].id, t: options[i].label });
      if (options[i].id === state.shapeId) valid = true;
    }
    if (!valid) state.shapeId = 'auto';
    fillSelect($('shapeSelect'), items, state.shapeId);
  }

  function renderLengthSelect() {
    var inst = state.instance;
    var loopBars = 4;
    if (inst) {
      var grid = Imp.progressionGrid(inst.progression, inst.keyPc, inst.scaleId);
      loopBars = grid.bars;
    }
    var items = [];
    for (var i = 1; i <= 3; i++) {
      items.push({ v: i, t: i + ' loop · ' + (loopBars * i) + ' 小节' });
    }
    fillSelect($('lengthSelect'), items, state.loops);
  }

  function renderBias() {
    if ($('biasRange')) $('biasRange').value = state.bias;
    if ($('biasValue')) $('biasValue').textContent = state.bias;
    updateContextHint();
  }

  function renderRangeBias() {
    if ($('rangeBiasRange')) $('rangeBiasRange').value = state.rangeBias;
    if ($('rangeBiasValue')) $('rangeBiasValue').textContent = Number(state.rangeBias).toFixed(2);
  }

  function renderMix() {
    var mix = (global.Band && global.Band.state.mix) || { drums: 0.8, backing: 1, solo: 1.2 };
    state.volume = mix.solo;
    if ($('mixDrums')) $('mixDrums').value = Math.round(mix.drums * 100);
    if ($('mixBacking')) $('mixBacking').value = Math.round(mix.backing * 100);
    if ($('mixSolo')) $('mixSolo').value = Math.round(mix.solo * 100);
    if ($('mixDrumsValue')) $('mixDrumsValue').textContent = Math.round(mix.drums * 100) + '%';
    if ($('mixBackingValue')) $('mixBackingValue').textContent = Math.round(mix.backing * 100) + '%';
    if ($('mixSoloValue')) $('mixSoloValue').textContent = Math.round(mix.solo * 100) + '%';
  }

  /* 旧名字保留，避免其它地方调用 */
  function renderSoloVolume() { renderMix(); }

  function updateContextHint() {
    var el = $('improvHint');
    if (!el) return;
    var inst = state.instance;
    if (!inst) {
      el.textContent = '还没有选择伴奏实例；先在「伴奏」页保存一个，或点“用当前伴奏新建”。';
      return;
    }
    var loopGrid = Imp.progressionGrid(inst.progression, inst.keyPc, inst.scaleId);
    var st = Imp.STYLES[0];
    for (var i = 0; i < Imp.STYLES.length; i++) if (Imp.STYLES[i].id === state.styleId) st = Imp.STYLES[i];
    var mode = LLM.ready()
      ? ('LLM：' + LLM.effective().model)
      : '本地（未配置 API）';
    el.textContent = inst.name + ' · ' + M.keyName(inst.keyPc, preferFlat()) + ' ' +
      M.scaleInfo(inst.scaleId).label + ' · ' + loopGrid.bars + ' 小节/loop × ' + state.loops +
      ' · ' + inst.bpm + ' BPM · ' + st.zh + ' · 音域 ' + Number(state.rangeBias).toFixed(2) +
      ' · ' + mode;
  }

  function renderRhythmSelect() { /* 节奏型现在来自实例，不再单独选择 */ }

  /* ============================ 伴奏实例 ============================ */
  function instanceItems() {
    if (!global.Instances) return [];
    return global.Instances.list();
  }

  function findInstance(id) {
    var list = instanceItems();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function instanceMatches(inst, q) {
    if (!q) return true;
    var text = [
      inst.name || '',
      M.keyName(inst.keyPc, !!M.FLAT_KEYS[mod12(inst.keyPc)]),
      M.scaleInfo(inst.scaleId).label, inst.scaleId || '',
      inst.bpm ? String(inst.bpm) + ' bpm' : '',
      (inst.progression && inst.progression.zh) || '',
      (inst.rhythm && inst.rhythm.zh) || '',
      (inst.drum && inst.drum.zh) || ''
    ].join(' ').toLowerCase();
    return text.indexOf(q) >= 0;
  }

  function renderInstanceSelects() {
    var list = instanceItems();
    var currentId = state.instance ? state.instance.id : '';
    var q = $('instanceSearch') ? String($('instanceSearch').value || '').replace(/^\s+|\s+$/g, '').toLowerCase() : '';
    var filtered = [];
    for (var i = 0; i < list.length; i++) {
      if (instanceMatches(list[i], q)) filtered.push(list[i]);
    }
    var currentVisible = false;
    for (i = 0; i < filtered.length; i++) if (filtered[i].id === currentId) currentVisible = true;

    var opts = [];
    if (!filtered.length) {
      opts.push({ v: '', t: q ? '没有匹配的实例' : '还没有伴奏实例' });
    } else {
      if (q && !currentVisible) opts.push({ v: '', t: '— 选择一个匹配的实例 —' });
      for (i = 0; i < filtered.length; i++) {
        opts.push({ v: filtered[i].id, t: filtered[i].name });
      }
    }
    fillSelect($('instanceSelect'), opts, currentVisible ? currentId : '');

    /* 伴奏页的下拉不跟着即兴页的搜索词走，始终列全部 */
    var allOpts = [];
    if (!list.length) allOpts.push({ v: '', t: '还没有伴奏实例' });
    for (i = 0; i < list.length; i++) allOpts.push({ v: list[i].id, t: list[i].name });
    fillSelect($('bandInstanceSelect'), allOpts, currentId);

    if ($('instCount')) {
      $('instCount').textContent = list.length + ' 个已保存' +
        (q ? ' · 匹配 ' + filtered.length + ' 个' : '');
    }
  }

  function renderInstanceInfo() {
    var el = $('instanceInfo');
    var inst = state.instance;
    var hasPrompt = !!($('improvPrompt') && $('improvPrompt').value.replace(/\s+/g, ''));
    renderLengthSelect();
    if (!inst) {
      if (el) el.textContent = hasPrompt
        ? '没有现成实例也可以：先点「生成」拿推荐，改好鼓/节奏型/走向、选速度，再点「用这些选择生成」。'
        : '还没有实例：先在「伴奏」页配置好鼓机/走向/节奏型，再保存为实例；或填写提示词让推荐 agent 创建。';
      if ($('btnImprovGen')) $('btnImprovGen').disabled = !hasPrompt || !!state.busyRec;
      if ($('btnImprovLocal')) $('btnImprovLocal').disabled = true;
      if ($('btnImprovPlay')) $('btnImprovPlay').disabled = true;
      updateContextHint();
      return;
    }
    var loopGrid = Imp.progressionGrid(inst.progression, inst.keyPc, inst.scaleId);
    if (el) {
      el.textContent = M.keyName(inst.keyPc, preferFlat()) + ' ' +
        M.scaleInfo(inst.scaleId).label + ' · ' + loopGrid.bars + ' 小节/loop · ' +
        inst.bpm + ' BPM · 鼓「' + ((inst.drum && inst.drum.zh) || inst.drum.id) + '」 · 走向「' +
        inst.progression.zh + '」 · 节奏「' + inst.rhythm.zh + '」';
    }
    if ($('btnImprovGen')) $('btnImprovGen').disabled = !!state.busyRec;
    if ($('btnImprovLocal')) $('btnImprovLocal').disabled = false;
    if ($('registerSelect')) $('registerSelect').value = state.register;
    updateContextHint();
    renderPlayButtons();
  }

  function selectInstance(id, keepScore) {
    var inst = findInstance(id);
    if (!inst) {
      state.instance = null;
      renderInstanceSelects();
      renderInstanceInfo();
      renderShapeSelect();
      if (!keepScore) clearScoreView();
      if (global.Band && global.Band.isPlaying()) global.Band.stop();
      return;
    }
    var changed = !state.instance || state.instance.id !== inst.id;
    state.instance = inst;
    state.register = inst.register || state.register || 'low';
    if (S) {
      S.setSetting('improv.instance', inst.id);
      S.setSetting('improv.register', state.register);
    }
    renderInstanceSelects();
    renderInstanceInfo();
    renderShapeSelect();
    if (changed && !keepScore) clearScoreView();
    if (global.Band && global.Band.isPlaying()) global.Band.stop();
    renderHeaderSafe();
  }

  function refreshInstances(preferredId) {
    var list = instanceItems();
    if (!list.length) {
      state.instance = null;
    } else if (preferredId && findInstance(preferredId)) {
      state.instance = findInstance(preferredId);
    } else if (!state.instance || !findInstance(state.instance.id)) {
      state.instance = list[0];
    }
    if (state.instance) state.register = state.instance.register || state.register || 'low';
    renderInstanceSelects();
    renderInstanceInfo();
    renderShapeSelect();
  }

  function clearScoreView() {
    Imp.setScore(null);
    state.fingering = null;
    state.renderedScore = null;
    state.currentCraft = null;
    renderShapeSelect();
    renderScore(false);
    renderGuitars(0, 0);
    renderPlayButtons();
  }

  function renderHeaderSafe() {
    if (global.CHORD_STATE && global.CHORD_STATE.tab === 'improv' && global.refreshBandHeader) {
      global.refreshBandHeader();
    }
  }

  /* 名称 dialog：伴奏页保存实例 / 即兴页“用当前伴奏新建”共用 */
  function openInstDialog() {
    var d = $('instDialog');
    if (!d) return;
    $('instName').value = (global.Instances && global.Instances.defaultName()) || '伴奏实例';
    d.hidden = false;
    try { $('instName').focus(); } catch (e) {}
  }

  function closeInstDialog() {
    var d = $('instDialog');
    if (d) d.hidden = true;
  }

  function saveInstFromDialog() {
    if (!global.Instances) return;
    var name = ($('instName').value || '').replace(/^\s+|\s+$/g, '') ||
      global.Instances.defaultName();
    var inst = global.Instances.captureAndSave(name);
    closeInstDialog();
    if (!inst) {
      msg('保存失败：当前没有可用的鼓机/走向/节奏型', true);
      return;
    }
    state.instance = inst;
    if (S) S.setSetting('improv.instance', inst.id);
    refreshInstances(inst.id);
    clearScoreView();
    msg('已保存伴奏实例「' + inst.name + '」，可以在即兴页使用');
  }

  function deleteInstance(id) {
    if (!global.Instances || !id) return;
    global.Instances.remove(id);
    if (state.instance && state.instance.id === id) state.instance = null;
    refreshInstances();
    clearScoreView();
    if ($('bandInstanceSelect')) {
      var v = $('bandInstanceSelect').value;
      if (v) state.instance = findInstance(v);
    }
    msg('已删除伴奏实例');
  }

  /* ============================ agent 日志 ============================ */
  function startLog() {
    var box = $('agentLog');
    if (!box) return;
    clear(box);
    box.hidden = false;
  }

  function stepNode(step) {
    var box = $('agentLog');
    if (!box) return null;
    var node = box.querySelector('[data-step="' + step.index + '"]');
    if (!node) {
      node = make('div', 'agent-step');
      node.setAttribute('data-step', String(step.index));
      node.appendChild(make('span', 'as-dot'));
      node.appendChild(make('span', 'as-name'));
      node.appendChild(make('span', 'as-detail'));
      node.appendChild(make('span', 'as-ms'));
      box.appendChild(node);
    }
    var status = step.status || 'running';
    node.className = 'agent-step ' + status;
    node.querySelector('.as-name').textContent = (step.index + 1) + '. ' + step.name;
    node.querySelector('.as-detail').textContent = status === 'running'
      ? '请求模型…'
      : (step.detail || (status === 'ok' ? '完成' : ''));
    node.querySelector('.as-ms').textContent = step.ms
      ? (step.ms / 1000).toFixed(1) + 's' : (status === 'running' ? '' : '本地');
    return node;
  }

  function appendSummary(text, isError) {
    var box = $('agentLog');
    if (!box) return;
    var el = make('div', 'agent-summary' + (isError ? ' error' : ''), text);
    box.appendChild(el);
  }

  /* ============================ 生成 ============================ */
  function buildOpts() {
    var inst = state.instance;
    if (!inst) return null;
    var grid = Imp.progressionGrid(inst.progression, inst.keyPc, inst.scaleId);
    var bars = grid.bars * state.loops;
    return {
      grid: grid,
      progression: B.cloneProgression(inst.progression),
      keyPc: inst.keyPc,
      scaleId: inst.scaleId,
      bars: bars,
      bpm: inst.bpm,
      styleId: state.styleId,
      bias: state.bias,
      rangeBias: state.rangeBias,
      preferFlat: !!M.FLAT_KEYS[mod12(inst.keyPc)],
      progressText: inst.name + ' · 走向「' + inst.progression.zh + '」· ' + state.loops + ' loop',
      progressionName: inst.progression.zh,
      instanceName: inst.name,
      instanceId: inst.id,
      prompt: state.prompt || '',
      scene: state.prompt || ''
    };
  }
  function mod12(n) { return M.mod12(n); }

  function styleName() {
    for (var i = 0; i < Imp.STYLES.length; i++) {
      if (Imp.STYLES[i].id === state.styleId) return Imp.STYLES[i].zh;
    }
    return '即兴';
  }

  function taskTitle(opts) {
    return '即兴 · ' + (state.instance ? state.instance.name + ' · ' : '') +
      (opts.progressionName ? '走向「' + opts.progressionName + '」· ' : '') +
      M.keyName(opts.keyPc, opts.preferFlat) + ' ' +
      M.scaleInfo(opts.scaleId).label + ' · ' + styleName() + ' · ' +
      opts.bars + ' 小节（' + state.loops + ' loop）';
  }

  /* 把生成请求交给队列，而不是在点击事件里直接跑 4 次模型 */
  function enqueueTask(mode, autoPlay) {
    if (!AQ) {
      msg('任务队列没有加载，无法生成', true);
      return null;
    }
    var opts = buildOpts();
    if (!opts) {
      msg('先选择一个伴奏实例（或在「伴奏」页保存一个）', true);
      return null;
    }
    opts.stream = true;
    var t = AQ.enqueue({
      kind: 'improv', mode: mode, autoPlay: autoPlay === true,
      opts: opts, title: taskTitle(opts)
    });
    renderQueue();
    return t;
  }

  function recDrumList() {
    return (global.Patterns && global.Patterns.LIST) ? global.Patterns.LIST.slice() : [];
  }

  function recRhythmList() {
    var list = B.RHYTHMS ? B.RHYTHMS.slice() : [];
    if (global.BackingUI && global.BackingUI.state && global.BackingUI.state.customRhythms) {
      list = list.concat(global.BackingUI.state.customRhythms);
    }
    return list;
  }

  function recProgressionList() {
    var list = B.PROGRESSIONS ? B.PROGRESSIONS.slice() : [];
    if (global.BackingUI && global.BackingUI.state && global.BackingUI.state.customProgs) {
      list = list.concat(global.BackingUI.state.customProgs);
    }
    return list;
  }

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function fillRecSelect(id, list, selectedId) {
    var el = $(id);
    if (!el) return;
    clear(el);
    for (var i = 0; i < list.length; i++) {
      var o = document.createElement('option');
      o.value = list[i].id;
      o.textContent = (list[i].zh || list[i].name || list[i].id) + '（' + list[i].id + '）';
      el.appendChild(o);
    }
    if (selectedId && findById(list, selectedId)) el.value = selectedId;
  }

  function recDraftFromUi() {
    if (!state.recDraft) return null;
    if ($('recDrumSelect') && $('recDrumSelect').value) state.recDraft.drumId = $('recDrumSelect').value;
    if ($('recRhythmSelect') && $('recRhythmSelect').value) state.recDraft.rhythmId = $('recRhythmSelect').value;
    if ($('recProgressionSelect') && $('recProgressionSelect').value) {
      state.recDraft.progressionId = $('recProgressionSelect').value;
    }
    syncRecActions();
    return state.recDraft;
  }

  function syncRecActions() {
    if ($('recBpmInput') && state.recDraft) {
      var raw = $('recBpmInput').value;
      var typed = raw === '' ? 0 : Number(raw);
      state.recDraft.bpm = (isFinite(typed) && typed >= 40 && typed <= 240) ? Math.round(typed) : 0;
    }
    var ready = !!(state.recDraft && state.recDraft.bpm);
    if ($('btnRecGenerate')) $('btnRecGenerate').disabled = !ready;
    if ($('recBpmRow')) {
      var chips = $('recBpmRow').getElementsByTagName('button');
      for (var i = 0; i < chips.length; i++) {
        var bpm = Number(chips[i].getAttribute('data-bpm'));
        chips[i].classList.toggle('on', ready && bpm === Number(state.recDraft.bpm));
      }
    }
  }

  function generate(autoPlay) {
    var prompt = $('improvPrompt') ? $('improvPrompt').value.replace(/^\s+|\s+$/g, '') : '';
    if (prompt) {
      /* 推荐已就绪：用户再点一次「生成」确认选择，而不是点速度就自动生成。 */
      if (state.recommendation && state.recDraft && state.recPrompt === prompt) {
        confirmRecommendation(autoPlay !== false);
        return;
      }
      requestRecommendation(prompt);
      return;
    }
    if (!state.instance) { msg('先选择一个伴奏实例', true); return; }
    state.prompt = '';
    state.recommendation = null;
    state.recDraft = null;
    state.recPrompt = '';
    state.chosenBpm = 0;
    state.pendingCraft = null;
    state.currentCraft = null;
    if ($('recPanel')) $('recPanel').hidden = true;
    enqueueTask(LLM.ready() ? 'ai' : 'local', autoPlay !== false);
  }

  function requestRecommendation(prompt) {
    if (!global.Crafts) { msg('推荐模块没有加载', true); return; }
    state.prompt = prompt;
    state.pendingCraft = null;
    state.currentCraft = null;
    state.recDraft = null;
    var opts = {
      keyPc: keyPc(), scaleId: scaleId(), preferFlat: preferFlat(),
      register: state.register || 'low'
    };
    /* 没有 API 时本地推荐是同步的，页面可以马上显示 Top5，不用等 Promise。 */
    if (!LLM.ready()) {
      state.recommendation = global.Crafts.localRecommend(prompt, opts);
      state.recPrompt = prompt;
      state.recDraft = {
        drumId: state.recommendation.drumId,
        rhythmId: state.recommendation.rhythmId,
        progressionId: state.recommendation.progressionId,
        bpm: 0
      };
      renderRecommendation({ source: 'local' });
      msg('本地推荐完成：改好鼓/节奏型/走向，选一个速度，再点「生成」。');
      return;
    }
    if (state.busyRec) {
      /* 同一提示词已经在推荐中；换提示词则让旧请求作废，重新发。 */
      if (state.recPrompt === prompt) return;
    }
    var seq = ++state.recSeq;
    state.busyRec = true;
    state.recPrompt = prompt;
    var btn = $('btnImprovGen');
    if (btn) { btn.disabled = true; btn.textContent = '推荐中…'; }
    msg('正在根据提示词推荐鼓、节奏型、走向和速度…');
    global.Crafts.recommend(prompt, opts).then(function (r) {
      if (seq !== state.recSeq) return;
      state.busyRec = false;
      if (btn) { btn.disabled = false; btn.textContent = '生成'; }
      if (state.prompt !== prompt) return;
      if (!r || !r.ok) {
        msg('推荐失败：' + (r && r.error ? r.error : '未知错误'), true);
        return;
      }
      state.recommendation = r.data;
      state.recPrompt = prompt;
      state.recDraft = {
        drumId: r.data.drumId,
        rhythmId: r.data.rhythmId,
        progressionId: r.data.progressionId,
        bpm: 0
      };
      renderRecommendation(r);
      if (r.error) msg('LLM 推荐失败，已改用本地推荐：' + r.error, true);
      else msg(r.source === 'ai' ? 'LLM 推荐完成：改好配置、选速度，再点「生成」。' : '本地推荐完成：改好配置、选速度，再点「生成」。');
    }, function (e) {
      if (seq !== state.recSeq) return;
      state.busyRec = false;
      if (btn) { btn.disabled = false; btn.textContent = '生成'; }
      msg('推荐失败：' + (e.message || e), true);
    });
  }

  function renderRecommendation(result) {
    var rec = state.recommendation;
    var panel = $('recPanel');
    if (!rec || !panel) return;
    panel.hidden = false;
    if ($('recSource')) {
      $('recSource').textContent = rec.source === 'ai' ? 'LLM 推荐 agent' : '本地推荐';
    }
    if ($('recSummary')) {
      clear($('recSummary'));
      var items = [
        ['推荐鼓机', rec.drumName + '（' + rec.drumId + '）'],
        ['推荐节奏型', rec.rhythmName + '（' + rec.rhythmId + '）'],
        ['推荐走向', rec.progressionName + '（' + rec.progressionId + '）'],
        ['推荐速度', (rec.bpm || '--') + ' BPM'],
        ['备选 Top5', (rec.bpmTop5 || []).join(' / ') + ' BPM']
      ];
      for (var i = 0; i < items.length; i++) {
        var box = make('div', 'rec-item');
        box.appendChild(make('b', null, items[i][0]));
        box.appendChild(make('span', null, items[i][1]));
        $('recSummary').appendChild(box);
      }
    }
    if (state.recDraft) {
      fillRecSelect('recDrumSelect', recDrumList(), state.recDraft.drumId);
      fillRecSelect('recRhythmSelect', recRhythmList(), state.recDraft.rhythmId);
      fillRecSelect('recProgressionSelect', recProgressionList(), state.recDraft.progressionId);
      state.recDraft.drumId = $('recDrumSelect') ? $('recDrumSelect').value : state.recDraft.drumId;
      state.recDraft.rhythmId = $('recRhythmSelect') ? $('recRhythmSelect').value : state.recDraft.rhythmId;
      state.recDraft.progressionId = $('recProgressionSelect') ? $('recProgressionSelect').value : state.recDraft.progressionId;
    }
    if ($('recBpmBest')) $('recBpmBest').textContent = rec.bpm || '--';
    if ($('recBpmInput')) {
      $('recBpmInput').value = (state.recDraft && state.recDraft.bpm) ? String(state.recDraft.bpm) : '';
    }
    if ($('recReason')) $('recReason').textContent = rec.reason || '';
    var row = $('recBpmRow');
    if (row) {
      clear(row);
      var top = rec.bpmTop5 || [];
      for (var k = 0; k < top.length; k++) {
        (function (bpm) {
          var b = make('button', 'chip', bpm + ' BPM');
          b.type = 'button';
          b.setAttribute('data-bpm', String(bpm));
          b.addEventListener('click', function () { chooseRecommendedBpm(bpm); });
          row.appendChild(b);
        })(top[k]);
      }
    }
    syncRecActions();
    /* 面板在提示词下面，手机上生成后往往还在屏幕外；等布局完成再滚过去。 */
    setTimeout(function () {
      if (!panel.hidden && panel.scrollIntoView) {
        try { panel.scrollIntoView({ block: 'center' }); } catch (e) {}
      }
    }, 60);
  }

  /* 点速度只记录选择与高亮，不生成；等用户点「用这些选择生成」或主「生成」。 */
  function chooseRecommendedBpm(bpm) {
    if (!state.recommendation) return;
    if (!state.recDraft) {
      state.recDraft = {
        drumId: state.recommendation.drumId,
        rhythmId: state.recommendation.rhythmId,
        progressionId: state.recommendation.progressionId,
        bpm: 0
      };
    }
    state.recDraft.bpm = Math.max(40, Math.min(240, Math.round(Number(bpm) || 0)));
    if ($('recBpmInput')) $('recBpmInput').value = String(state.recDraft.bpm);
    syncRecActions();
    msg('已选择 ' + state.recDraft.bpm + ' BPM；改完鼓/节奏型/走向后，点「用这些选择生成」。');
  }

  function confirmRecommendation(autoPlay) {
    var rec = state.recommendation;
    var draft = recDraftFromUi();
    if (!rec || !draft) { msg('推荐结果还没准备好', true); return; }
    if (!draft.bpm) {
      msg('先输入或选择一个 40–240 的速度，再点生成', true);
      if ($('recBpmRow') && $('recBpmRow').scrollIntoView) {
        try { $('recBpmRow').scrollIntoView({ block: 'center' }); } catch (e) {}
      }
      return;
    }
    if (!global.Crafts) { msg('推荐模块没有加载', true); return; }
    var selected = {
      title: rec.title,
      drumId: draft.drumId,
      rhythmId: draft.rhythmId,
      progressionId: draft.progressionId
    };
    var drums = recDrumList(), rhythms = recRhythmList(), progs = recProgressionList();
    var drum = findById(drums, draft.drumId);
    var rhythm = findById(rhythms, draft.rhythmId);
    var prog = findById(progs, draft.progressionId);
    if (!drum || !rhythm || !prog) {
      msg('选择的鼓机 / 节奏型 / 走向不存在，请重新选择', true);
      return;
    }
    var inst = global.Crafts.buildInstance(selected, draft.bpm, {
      keyPc: keyPc(), scaleId: scaleId(), preferFlat: preferFlat(),
      register: state.register || 'low'
    });
    inst.name = rec.title || inst.name;
    inst.progression.zh = prog.zh || inst.progression.zh;
    inst.rhythm.zh = rhythm.zh || inst.rhythm.zh;
    inst.drum.zh = drum.zh || inst.drum.zh;
    state.instance = inst;
    state.chosenBpm = inst.bpm;
    state.pendingCraft = {
      title: rec.title,
      prompt: state.prompt,
      recommendation: rec,
      chosen: {
        bpm: inst.bpm,
        drumId: drum.id, drumName: drum.zh,
        rhythmId: rhythm.id, rhythmName: rhythm.zh,
        progressionId: prog.id, progressionName: prog.zh
      },
      instance: global.Instances ? global.Instances.clone(inst) : inst,
      tone: state.tone,
      styleId: state.styleId,
      messages: [
        { role: 'user', text: state.prompt, at: (new Date()).getTime() },
        { role: 'assistant', text: '推荐鼓机/节奏型/走向：' + rec.drumName + ' / ' +
          rec.rhythmName + ' / ' + rec.progressionName + '。你的选择：' +
          drum.zh + ' / ' + rhythm.zh + ' / ' + prog.zh + '，' + inst.bpm +
          ' BPM。现在开始生成作品。', at: (new Date()).getTime() }
      ]
    };
    state.currentCraft = null;
    state.recommendation = null;
    state.recDraft = null;
    state.recPrompt = '';
    if ($('recPanel')) $('recPanel').hidden = true;
    renderInstanceInfo();
    renderShapeSelect();
    msg('已确认 ' + inst.bpm + ' BPM，开始生成作品…');
    enqueueTask(LLM.ready() ? 'ai' : 'local', autoPlay !== false);
  }

  function generateLocal(autoPlay) {
    if (!state.instance) { msg('先选择一个伴奏实例', true); return null; }
    return enqueueTask('local', autoPlay !== false);
  }

  function playInstance(note) {
    if (!global.Band || !global.Instances) return false;
    if (!state.instance) { msg('先选择一个伴奏实例', true); return false; }
    if (!Imp.hasScore()) { msg('先生成一段简谱，或从谱库载入', true); return false; }
    var inst = global.Instances.clone(state.instance);
    inst.register = state.register || 'low';
    var ok = global.Band.startInstance(inst, Imp.state.score, { tone: state.tone });
    if (global.BandUI) global.BandUI.render();
    renderPlayButtons();
    if (ok) {
      msg(note || ((Imp.sourceLabel(Imp.state.score) || '即兴') +
        ' 已加入播放：鼓机 + 伴奏 + solo 同步'));
    } else {
      msg('播放没有启动：先确认实例里有鼓机/和弦/节奏型', true);
    }
    return ok;
  }

  function playCurrent(note) { return playInstance(note); }

  function onStartRequested() {
    if (Imp.hasScore()) { playInstance(); return; }
    var pending = AQ && AQ.pendingTask('improv');
    if (pending) {
      AQ.setAutoPlay(pending.id, true);
      msg('已有生成任务在队列里；完成后会自动开始播放');
      return;
    }
    generate(true);
  }

  function startPlaybackAfterScore(note) {
    playInstance(note);
  }

  /* ============================ 任务队列 UI ============================ */
  function statusZh(s) {
    if (s === 'queued') return '排队';
    if (s === 'running') return '运行中';
    if (s === 'done') return '完成';
    if (s === 'failed') return '失败';
    if (s === 'cancelled') return '已取消';
    return s;
  }

  function modeZh(m) { return m === 'ai' ? 'LLM' : '本地'; }

  function taskSummary(task) {
    if (task.status === 'running') return '正在运行…';
    if (task.status === 'queued') return '等待前面的任务…';
    if (task.status === 'done') {
      var r = task.result || {};
      var txt = '完成';
      if (r.fallback) txt = 'AI 失败，本地兜底';
      if (r.calls) txt += ' · ' + r.calls + ' 次请求';
      if (r.usage) txt += ' · ' + r.usage + ' tokens';
      if (r.score) txt += ' · ' + Imp.statsText(r.score);
      return txt;
    }
    if (task.status === 'failed') return '失败：' + (task.error || '未知错误');
    if (task.status === 'cancelled') return '已取消';
    return '';
  }

  function makeQueueRow(task) {
    var row = make('div', 'queue-row ' + task.status);
    row.setAttribute('data-task', task.id);
    row.appendChild(make('span', 'queue-dot'));
    var main = make('div', 'queue-main');
    main.appendChild(make('div', 'queue-title', task.title));
    main.appendChild(make('div', 'queue-sub',
      modeZh(task.mode) + ' · ' + (task.opts && task.opts.bars ? task.opts.bars + ' 小节' : '') +
      ' · ' + statusZh(task.status) + (task.status === 'running' ? ' · ' + taskSummary(task) : '')));
    row.appendChild(main);
    var acts = make('div', 'queue-actions');
    var logBtn = make('button', 'mini-toggle', '日志');
    logBtn.type = 'button';
    logBtn.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      showTaskLog(task);
    });
    acts.appendChild(logBtn);
    if (task.status === 'queued' || task.status === 'running') {
      var cancelBtn = make('button', 'mini-toggle del-btn', '取消');
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', function (e) {
        if (e.stopPropagation) e.stopPropagation();
        AQ.cancel(task.id);
        renderQueue();
      });
      acts.appendChild(cancelBtn);
    } else if (task.status === 'failed') {
      var retryBtn = make('button', 'mini-toggle', '重试');
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', function (e) {
        if (e.stopPropagation) e.stopPropagation();
        AQ.retry(task.id);
        renderQueue();
      });
      acts.appendChild(retryBtn);
    } else if (task.status === 'done' && task.result && task.result.score) {
      var loadBtn = make('button', 'mini-toggle', '载入');
      loadBtn.type = 'button';
      loadBtn.addEventListener('click', function (e) {
        if (e.stopPropagation) e.stopPropagation();
        onScoreReady(task.result.score, '已载入队列里的「' + task.title + '」');
      });
      acts.appendChild(loadBtn);
    }
    row.appendChild(acts);
    row.addEventListener('click', function () { showTaskLog(task); });
    return row;
  }

  function renderQueue() {
    if (!AQ) return;
    var box = $('queueList');
    if (!box) return;
    clear(box);
    var list = AQ.tasks();
    if (!list.length) {
      box.appendChild(make('div', 'queue-empty',
        '还没有任务。点「生成」会创建一个任务；多个任务会排队依次跑。'));
    } else {
      var show = list.slice(-12);
      for (var i = 0; i < show.length; i++) box.appendChild(makeQueueRow(show[i]));
    }
    if ($('queueInfo')) $('queueInfo').textContent = AQ.statusText();
    state.busy = AQ.isRunning();
  }

  var THOUGHT_KEYS = {
    thinking: '思路', structure: '结构', motif: '动机', density: '密度',
    contour: '走向', review: '润色', reason: '理由', idea: '落点'
  };

  function unescapeJsonText(s) {
    try { return JSON.parse('"' + s + '"'); } catch (e) {
      return String(s).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }

  /* 流式内容是各 agent 的 JSON。直接把 JSON 铺给用户太粗糙，
     这里把 thinking / structure / motif / review / reason / idea 抽成可读段落。 */
  function prettyStream(raw) {
    if (!raw) return '';
    var parts = String(raw).split(/【([^】]+)】/);
    var out = [], seen = {}, label = '', i, k;

    function extract(chunk) {
      var re = /"(thinking|structure|motif|density|contour|review|reason|idea)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      var rows = [], m;
      while ((m = re.exec(chunk))) {
        var val = unescapeJsonText(m[2]).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        if (!val || seen[val]) continue;
        seen[val] = 1;
        rows.push({ key: m[1], text: val });
      }
      return rows;
    }

    for (i = 0; i < parts.length; i++) {
      if (i % 2 === 1) { label = parts[i]; continue; }
      var chunk = parts[i];
      if (!chunk || !chunk.replace(/\s+/g, '')) continue;
      var rows = extract(chunk);
      if (rows.length) {
        if (label) { out.push('【' + label + '】'); label = ''; }
        for (k = 0; k < rows.length; k++) {
          out.push((THOUGHT_KEYS[rows[k].key] || rows[k].key) + '：' + rows[k].text.slice(0, 320));
        }
      } else if (chunk.indexOf('本地') >= 0 || chunk.indexOf('AI 失败') >= 0 ||
                 chunk.indexOf('流式失败') >= 0 || chunk.indexOf('回退') >= 0 ||
                 chunk.indexOf('· ') === 0) {
        out.push(chunk.replace(/^\s+|\s+$/g, '').slice(0, 500));
      } else if (/\{/.test(chunk) && !out.length) {
        /* 还没收到完整字段时，先显示一小段原始输出，避免面板空着 */
        out.push('（正在接收模型输出…）');
      }
    }
    return out.length ? out.join('\n') : raw.slice(-1500);
  }

  function renderStream(task) {
    var pre = $('queueStream');
    if (!pre) return;
    pre.textContent = prettyStream(task.stream);
    pre.scrollTop = pre.scrollHeight;
    if ($('queueStreamHint')) {
      $('queueStreamHint').textContent = task.stream
        ? ('已整理 · ' + task.stream.length + ' 字符')
        : '等待模型输出…';
    }
  }

  function showTaskLog(task) {
    if (!task) return;
    var live = $('queueLive');
    if (live) live.hidden = false;
    if ($('queueLiveTitle')) $('queueLiveTitle').textContent = task.title;
    if ($('queueLiveStatus')) {
      $('queueLiveStatus').textContent = statusZh(task.status) +
        (task.status === 'running' ? ' · ' + taskSummary(task) : '');
    }
    renderStream(task);
    startLog();
    for (var i = 0; i < task.steps.length; i++) {
      if (task.steps[i]) stepNode(task.steps[i]);
    }
    if (task.status !== 'running' && task.status !== 'queued') {
      appendSummary(taskSummary(task), task.status === 'failed' || task.status === 'cancelled');
    }
    if ($('scoreWaiting')) $('scoreWaiting').hidden = task.status !== 'running';
  }

  var streamTimer = null;

  function scheduleStream(task) {
    if (!task || (AQ && AQ.running() !== task)) return;
    if (streamTimer) return;
    streamTimer = setTimeout(function () {
      streamTimer = null;
      renderStream(task);
    }, 80);
  }

  function onQueueChange(type, task) {
    if (type === 'stream') {
      scheduleStream(task);
      return;
    }
    if (type === 'step') {
      if (task && AQ.running() === task) {
        for (var i = 0; i < task.steps.length; i++) {
          if (task.steps[i]) stepNode(task.steps[i]);
        }
      }
      return;
    }
    if (type === 'start') {
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
      showTaskLog(task);
      if ($('queueLiveStatus')) $('queueLiveStatus').textContent = '运行中';
      if ($('scoreWaiting')) $('scoreWaiting').hidden = false;
      msg('任务开始：' + task.title + '（' + modeZh(task.mode) + '）');
      if ($('queuePanel') && $('queuePanel').scrollIntoView) {
        try { $('queuePanel').scrollIntoView({ block: 'start' }); } catch (e) {}
      }
    } else if (type === 'done' || type === 'failed' || type === 'cancelled') {
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
      renderStream(task);
      if ($('queueLiveStatus')) $('queueLiveStatus').textContent = statusZh(task.status);
      if ($('scoreWaiting')) $('scoreWaiting').hidden = true;
      if (AQ.running() !== task) {
        appendSummary(taskSummary(task), task.status === 'failed' || task.status === 'cancelled');
      }
      if (task.status === 'done') {
        /* 本地无 API 的提示 / AI 兜底提示已经由 runner 写过了，不要覆盖掉 */
        var keep = (task.mode === 'local' && !LLM.ready()) ||
          (task.result && task.result.fallback);
        if (!keep) msg('任务完成：' + taskSummary(task));
      } else if (task.status === 'failed') msg('任务失败：' + (task.error || '未知错误'), true);
      else msg('任务已取消');
    }
    renderQueue();
  }

  /* ---------- 队列 runner ---------- */
  function runLocalTask(task, ctx) {
    ctx.stream({ agent: '本地规则', type: 'info',
      text: '本地 solo：不调用模型，直接按走向/调式/风格规则作曲。' });
    try {
      var score = Imp.composeLocal(task.opts);
      ctx.step({ index: 0, name: '本地规则作曲（不联网）', status: 'ok',
        detail: Imp.statsText(score), ms: 0 });
      onScoreReady(score, task.autoPlay ? '本地 solo 完成，正在开始播放' : '本地 solo 完成');
      if (task.autoPlay) {
        startPlaybackAfterScore(LLM.ready()
          ? '本地 solo 已加入播放；简谱在下面'
          : '未配置 API：本次是本地 solo，不是 LLM solo。填写 API 后点「生成」即可换成 LLM');
      }
      return { ok: true, score: score, calls: 0, usage: 0 };
    } catch (e) {
      return { ok: false, error: '本地作曲失败：' + (e.message || e) };
    }
  }

  function runAiTask(task, ctx) {
    function localFallback(reason, calls, usage) {
      try {
        var local = Imp.composeLocal(task.opts);
        ctx.stream({ agent: '本地兜底', type: 'info',
          text: 'AI 失败：' + reason + '；改用本地规则生成并播放' });
        ctx.step({ index: 5, name: '本地兜底（AI 失败）', status: 'warn',
          detail: Imp.statsText(local), ms: 0 });
        onScoreReady(local, 'AI 请求失败，已用本地 solo 兜底');
        startPlaybackAfterScore('AI 请求失败，已用本地 solo 兜底播放');
        return {
          ok: true, score: local, fallback: true, error: reason,
          calls: calls || 0, usage: usage || 0
        };
      } catch (e) {
        return { ok: false, error: reason + '；本地兜底也失败：' + (e.message || e) };
      }
    }

    return Imp.runAgents(task.opts,
      function (step) { ctx.step(step); },
      function (ev) { ctx.stream(ev); }
    ).then(function (res) {
      if (ctx.isCancelled()) return { ok: false, error: '已取消' };
      if (res.ok) {
        onScoreReady(res.score, task.autoPlay ? 'LLM 生成完成，正在开始播放' : 'LLM 生成完成');
        if (task.autoPlay) startPlaybackAfterScore('LLM solo 已加入播放；简谱在下面');
        return {
          ok: true, score: res.score, calls: res.calls, usage: res.usage,
          steps: res.steps
        };
      }
      if (task.autoPlay) return localFallback(res.error, res.calls, res.usage);
      return { ok: false, error: res.error, calls: res.calls, usage: res.usage, steps: res.steps };
    }, function (e) {
      if (ctx.isCancelled()) return { ok: false, error: '已取消' };
      if (task.autoPlay) return localFallback(e.message || String(e), 0, 0);
      return { ok: false, error: (e.message || String(e)) };
    });
  }

  function improvRunner(task, ctx) {
    if (task.mode === 'local') return runLocalTask(task, ctx);
    return runAiTask(task, ctx);
  }

  /* 新谱面准备好的统一入口 */
  function onScoreReady(score, note) {
    if (state.instance && !score.instanceId) score.instanceId = state.instance.id;
    if (state.instance && !score.instanceName) score.instanceName = state.instance.name;
    if (!score.progressionName && score.progression && score.progression.zh) {
      score.progressionName = score.progression.zh;
    }
    Imp.setScore(score);
    applyScoreToUi(score);
    renderShapeSelect();
    state.fingering = Imp.fingeringPlan ? Imp.fingeringPlan(score, { shapeId: state.shapeId }) : null;
    renderScore(true);
    renderGuitars(0, 0);
    renderLibrary();
    renderPlayButtons();
    renderHeaderSafe();
    if (state.pendingCraft && global.Crafts) {
      var craft = global.Crafts.saveFromScore(state.pendingCraft, score);
      if (craft) {
        state.currentCraft = craft;
        state.pendingCraft = null;
        renderLibrary();
        if (global.Pager) global.Pager.refresh('improv.crafts');
        note = (note ? note + ' · ' : '') + '已保存为作品';
      }
    }
    msg(note || '谱面已就绪');
    if ($('scorePanel') && $('scorePanel').scrollIntoView) {
      try { $('scorePanel').scrollIntoView({ block: 'start' }); } catch (e) {}
    }
  }

  function applyScoreToUi(score) {
    state.styleId = score.styleId;
    state.bias = score.bias;
    if (score.rangeBias !== undefined && isFinite(score.rangeBias)) {
      state.rangeBias = Math.max(0, Math.min(1, score.rangeBias));
    }
    Imp.setStyle(score.styleId);
    Imp.setBias(score.bias);
    renderStyleChips();
    renderBias();
    renderRangeBias();
    renderScore(false);
  }

  /* ============================ 谱面 ============================ */
  function renderScore(resetScroll) {
    var score = Imp.state.score;
    var view = $('scoreView');
    if (!view) return;
    if (!score) {
      view.innerHTML = '<div class="score-empty">还没有谱面。点「生成」；' +
        '也可以从谱库载入。</div>';
      if ($('scoreMeta')) $('scoreMeta').textContent = '还没有内容';
      resetNowNote();
      renderPlayButtons();
      return;
    }
    resetNowNote();
    var sl = $('scoreScroll') ? $('scoreScroll').scrollLeft : 0;
    view.innerHTML = Imp.renderScoreHtml(score);
    if ($('scoreScroll')) $('scoreScroll').scrollLeft = resetScroll ? 0 : sl;
    if ($('scoreMeta')) $('scoreMeta').textContent = Imp.detailText(score);
    state.renderedScore = score;
    state.lastBar = -1;
    renderPlayButtons();
  }

  function renderPlayButtons() {
    var has = Imp.hasScore();
    var ids = ['btnSaveScore', 'btnSuggestChords', 'btnScoreToTab'];
    for (var i = 0; i < ids.length; i++) {
      if ($(ids[i])) $(ids[i]).disabled = !has;
    }
    syncPlayState();
  }

  function syncPlayState() {
    var playing = !!(global.Band && global.Band.isPlaying());
    var mine = playing && !!global.Band.state.instanceMode && Imp.hasScore();
    if (!playing || !mine) {
      if ($('mpSolo')) $('mpSolo').hidden = true;
    }
    if (!playing) clearHighlight();
  }

  function play(withBacking) { return playInstance(); }

  function stopPlay() {
    if (global.Band) global.Band.stop();
    if (global.BandUI) global.BandUI.render();
    renderPlayButtons();
    msg('已停止');
  }

  /* ============================ 双吉他指板 ============================ */
  function registerZh(id) {
    return id === 'high' ? '高把位' : (id === 'mid' ? '中把位' : '低把位');
  }

  /* 画一个 5 品窗口的横向指板。string 0 = 低音 E（画在下方）。 */
  function fretWindowSvg(opts) {
    var base = opts.base || 0;
    var size = opts.size || 5;
    var W = 300, H = 148, left = 30, right = 8, top = 22, bottom = 16;
    var fw = (W - left - right) / size;
    var rh = (H - top - bottom) / 5;
    var out = [];
    var s, f, i;
    out.push('<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      (opts.aria || '吉他指板') + '">');
    out.push('<rect class="mn-board" x="' + left + '" y="' + top + '" width="' +
      (W - left - right) + '" height="' + (H - top - bottom) + '" rx="4"/>');
    for (i = 0; i <= size; i++) {
      var x = left + i * fw;
      out.push('<line class="mn-fret' + (base === 0 && i === 0 ? ' mn-nut' : '') +
        '" x1="' + x + '" y1="' + top + '" x2="' + x + '" y2="' + (H - bottom) + '"/>');
    }
    for (s = 0; s < 6; s++) {
      var y = top + (5 - s) * rh;
      out.push('<line class="mn-string" x1="' + left + '" y1="' + y + '" x2="' +
        (W - right) + '" y2="' + y + '"/>');
    }
    var labels = ['E', 'A', 'D', 'G', 'B', 'e'];
    for (s = 0; s < 6; s++) {
      var ly = top + (5 - s) * rh + 3;
      out.push('<text class="mn-stringname" x="6" y="' + ly + '">' + labels[s] + '</text>');
    }
    for (i = 0; i < size; i++) {
      out.push('<text class="mn-fretnum" x="' + (left + (i + 0.5) * fw) +
        '" y="14" text-anchor="middle">' + (base + i) + '</text>');
    }
    /* 指型音阶的淡点 */
    if (opts.scalePcs) {
      for (s = 0; s < 6; s++) {
        for (f = base; f < base + size; f++) {
          if (f < 0) continue;
          if (opts.scalePcs.indexOf(M.mod12(global.Chord.TUNING[s] + f)) < 0) continue;
          var sx = left + (f - base + 0.5) * fw;
          var sy = top + (5 - s) * rh;
          out.push('<circle class="mn-scale-dot" cx="' + sx + '" cy="' + sy + '" r="2.4"/>');
        }
      }
    }
    /* 旋律用到的音：空心圈 */
    var markers = opts.markers || [];
    for (i = 0; i < markers.length; i++) {
      var m = markers[i];
      if (m.kind === 'used') {
        var ux = left + (m.f - base + 0.5) * fw;
        var uy = top + (5 - m.s) * rh;
        out.push('<circle class="mn-dot-used' + (m.shift ? ' mn-dot-shift' : '') +
          '" cx="' + ux + '" cy="' + uy + '" r="5.2"/>');
        if (m.label) {
          out.push('<text class="mn-used-label' + (m.shift ? ' mn-used-shift' : '') +
            '" x="' + ux + '" y="' + (uy + 2.4) +
            '" text-anchor="middle">' + m.label + '</text>');
        }
      } else if (m.kind === 'current') {
        var cx = left + (m.f - base + 0.5) * fw;
        var cy = top + (5 - m.s) * rh;
        if (m.outside) {
          cx = Math.max(left + 8, Math.min(W - right - 8, cx));
        }
        out.push('<circle class="mn-dot-current' + (m.outside ? ' outside' : '') +
          '" cx="' + cx + '" cy="' + cy + '" r="7.5"/>');
        out.push('<text class="mn-current-label" x="' + cx + '" y="' + (cy - 10) +
          '" text-anchor="middle">' + (m.label || '') + '</text>');
      } else if (m.kind === 'chord') {
        var ox = left + (m.f - base + 0.5) * fw;
        var oy = top + (5 - m.s) * rh;
        out.push('<circle class="mn-dot-chord" cx="' + ox + '" cy="' + oy + '" r="6"/>');
        if (m.label) {
          out.push('<text class="mn-dot-text" x="' + ox + '" y="' + (oy + 3) +
            '" text-anchor="middle">' + m.label + '</text>');
        }
      }
    }
    /* 空弦 / 闷弦（节奏和弦） */
    if (opts.openMute) {
      for (s = 0; s < 6; s++) {
        var om = opts.openMute[s];
        var oy2 = top + (5 - s) * rh;
        if (om === -1) out.push('<text class="mn-mute" x="' + (left - 9) +
          '" y="' + (oy2 + 4) + '" text-anchor="middle">×</text>');
        else if (om === 0) out.push('<circle class="mn-open" cx="' + (left - 9) +
          '" cy="' + oy2 + '" r="4"/>');
      }
    }
    out.push('</svg>');
    return out.join('');
  }

  function currentChordFor(score, bar, slot) {
    var prog = score && score.progression;
    if (!prog) return null;
    var grid = Imp.progressionGrid(prog, score.keyPc, score.scaleId);
    return Imp.chordAtSlot(grid, bar, slot);
  }

  function renderGuitars(bar, slot, ev) {
    var score = Imp.state.score;
    var melody = $('melodyNeck'), rhythm = $('rhythmNeck');
    if (!melody || !rhythm) return;
    bar = bar || 0; slot = slot || 0;
    state.curBar = bar; state.curSlot = slot;

    if (!score) {
      melody.innerHTML = '<div class="neck-empty">生成/载入简谱后显示</div>';
      rhythm.innerHTML = '<div class="neck-empty">选择实例后显示和弦</div>';
      if ($('melodyShape')) $('melodyShape').textContent = '--';
      if ($('melodyUsed')) $('melodyUsed').textContent = '用到的音：--';
      if ($('rhythmChord')) $('rhythmChord').textContent = '--';
      /* 没有谱时，右板仍可显示实例的第一个和弦 */
      if (state.instance) {
        var ig = Imp.progressionGrid(state.instance.progression, state.instance.keyPc, state.instance.scaleId);
        var c0 = Imp.chordAtSlot(ig, 0, 0);
        if (c0) renderRhythmChord(c0, 0, 0);
      }
      return;
    }
    var plan = state.fingering;
    if (!plan && Imp.fingeringPlan) {
      plan = Imp.fingeringPlan(score, { shapeId: state.shapeId });
      state.fingering = plan;
    }
    var phrase = plan && Imp.phraseForBar ? Imp.phraseForBar(plan, bar) : null;
    var scalePcs = [];
    var tones = M.scaleTones(score.keyPc, score.scaleId, score.preferFlat);
    for (var t = 0; t < tones.length; t++) scalePcs.push(tones[t].pc);

    var markers = [], mapKey = bar + ':' + slot, cur = null;
    if (phrase) {
      var displayBase = phrase.base, displayEnd = phrase.endFret;
      for (var k in phrase.map) {
        if (!phrase.map.hasOwnProperty(k)) continue;
        var m = phrase.map[k];
        /* 超出主指型的音不再藏起来：用最近的可弹位置换把，并纳入显示窗口。 */
        if (m.fret < displayBase) displayBase = m.fret;
        if (m.fret > displayEnd) displayEnd = m.fret;
        markers.push({ kind: 'used', s: m.string, f: m.fret, shift: !!m.outside,
          label: M.noteName(M.mod12(m.midi), preferFlat()) });
        if (k === mapKey) cur = m;
      }
      if (!cur && ev && ev.midi !== undefined) {
        var ps = Imp.positionsInWindow ? Imp.positionsInWindow(ev.midi, displayBase,
          displayEnd - displayBase + 1) : [];
        if (ps.length) cur = { string: ps[0].s, fret: ps[0].f, midi: ev.midi, outside: false };
      }
      if (cur) {
        markers.push({
          kind: 'current', s: cur.string, f: cur.fret,
          outside: false, label: Imp.midiName(ev && ev.midi !== undefined ? ev.midi : cur.midi, preferFlat())
        });
      }
      var totalNotes = 0, outside = 0;
      for (k in phrase.map) if (phrase.map.hasOwnProperty(k)) { totalNotes++; if (phrase.map[k].outside) outside++; }
      var displaySize = Math.max(phrase.size, displayEnd - displayBase + 1);
      if ($('melodyShape')) {
        $('melodyShape').textContent = phrase.shape + ' 指型 · ' + phrase.base + '–' +
          phrase.endFret + ' 品' + (outside
            ? ' · 换把 ' + outside + ' 音（显示 ' + displayBase + '–' + displayEnd + '）'
            : ' · 整段固定');
      }
      var warnings = (plan && plan.warnings) || [];
      if ($('shapeWarn')) {
        if (warnings.length) {
          var w = warnings[0];
          var wt = '↕ ' + warnings.length + ' 个音超出「' + phrase.shape + '」指型，已换把位显示';
          if (w.suggestions && w.suggestions.length) {
            wt += '（如 ' + w.name + '；也可换 ' + w.suggestions.slice(0, 2).join(' / ') + '）';
          } else {
            wt += '（如 ' + w.name + '）';
          }
          $('shapeWarn').textContent = wt;
          $('shapeWarn').hidden = false;
        } else {
          $('shapeWarn').textContent = '';
          $('shapeWarn').hidden = true;
        }
      }
      melody.innerHTML = fretWindowSvg({
        base: displayBase, size: displaySize, scalePcs: scalePcs, markers: markers,
        aria: '旋律吉他指板'
      });
    } else {
      melody.innerHTML = '<div class="neck-empty">没有旋律指型</div>';
      if ($('melodyShape')) $('melodyShape').textContent = '--';
      if ($('shapeWarn')) { $('shapeWarn').hidden = true; $('shapeWarn').textContent = ''; }
    }
    if ($('melodyUsed')) $('melodyUsed').textContent = '用到的音：' + (plan && plan.used.length ? plan.used.join(' ') : '--');

    var chord = currentChordFor(score, bar, slot);
    renderRhythmChord(chord, bar, slot);
  }

  function renderRhythmChord(chord, bar, slot) {
    var rhythm = $('rhythmNeck');
    if (!rhythm) return;
    if (!chord) {
      rhythm.innerHTML = '<div class="neck-empty">没有和弦数据</div>';
      if ($('rhythmChord')) $('rhythmChord').textContent = '--';
      return;
    }
    var v = B.voicingFor(chord, state.register);
    if (!v) {
      rhythm.innerHTML = '<div class="neck-empty">找不到这个把位的和弦</div>';
      return;
    }
    var base = 0;
    var maxF = 0, minP = 99;
    for (var s = 0; s < 6; s++) {
      var f = v.frets[s];
      if (f > 0) { minP = Math.min(minP, f); maxF = Math.max(maxF, f); }
    }
    if (minP !== 99 && maxF > 4) base = Math.max(0, minP);
    var size = (minP !== 99 && maxF - minP >= 5) ? 6 : 5;
    var markers = [];
    for (s = 0; s < 6; s++) {
      var fret = v.frets[s];
      if (fret > 0) {
        markers.push({ kind: 'chord', s: s, f: fret,
          label: fret > 0 ? M.noteName(C.pcAt(s, fret), preferFlat()) : '' });
      }
    }
    rhythm.innerHTML = fretWindowSvg({
      base: base, size: size, markers: markers, openMute: v.frets,
      aria: '节奏吉他指板和弦'
    });
    if ($('rhythmChord')) {
      $('rhythmChord').textContent = B.chordName(chord, preferFlat()) + ' · ' + registerZh(state.register);
    }
  }

  function resetNowNote() {
    var el = $('nowNote');
    if (el) {
      el.className = 'now-note';
      el.textContent = '停止 · 播放时这里会显示当前音与小节';
    }
  }

  function highlight(ev) {
    var view = $('scoreView');
    if (!view || !ev) return;
    var solo = $('mpSolo');
    if (solo && ev.midi !== undefined && ev.midi !== null) {
      solo.hidden = false;
      solo.textContent = 'SOLO ' + Imp.midiName(ev.midi, preferFlat());
    }
    var score = Imp.state.score;
    var token = '';
    if (score && score.bars[ev.bar]) token = score.bars[ev.bar].slots[ev.slot] || '';
    var noteText = (ev.midi !== undefined && ev.midi !== null) ? Imp.midiName(ev.midi, preferFlat()) : '--';
    var nn = $('nowNote');
    if (nn) {
      nn.className = 'now-note on';
      nn.textContent = '正在演奏：第 ' + (ev.bar + 1) + ' 小节 · 第 ' + (ev.slot + 1) +
        ' 格 · ' + noteText + ' · 级数 ' + token +
        (ev.tech ? ' · ' + (Imp.TECH_ZH[ev.tech] || ev.tech) : '');
    }
    var bars = view.querySelectorAll('.jp-bar');
    for (var b = 0; b < bars.length; b++) {
      bars[b].classList.toggle('playing', Number(bars[b].getAttribute('data-bar')) === ev.bar);
    }
    var cells = view.querySelectorAll('.jp-cell');
    for (var i = 0; i < cells.length; i++) {
      var on2 = Number(cells[i].getAttribute('data-bar')) === ev.bar &&
        Number(cells[i].getAttribute('data-slot')) === ev.slot;
      cells[i].classList.toggle('now', on2);
    }
    if (ev.bar !== state.lastBar) {
      state.lastBar = ev.bar;
      var bar = view.querySelector('.jp-bar[data-bar="' + ev.bar + '"]');
      var sc = $('scoreScroll');
      if (bar && sc) {
        var left = bar.offsetLeft - (sc.clientWidth - bar.offsetWidth) / 2;
        sc.scrollLeft = Math.max(0, left);
      }
    }
    renderGuitars(ev.bar, ev.slot, ev);
  }

  function clearHighlight() {
    if ($('mpSolo')) {
      $('mpSolo').hidden = true;
      $('mpSolo').textContent = 'SOLO';
    }
    resetNowNote();
    if (!state.renderedScore) return;
    var view = $('scoreView');
    if (!view) return;
    var cells = view.querySelectorAll('.jp-cell.now');
    for (var i = 0; i < cells.length; i++) cells[i].classList.remove('now');
    var bars = view.querySelectorAll('.jp-bar.playing');
    for (i = 0; i < bars.length; i++) bars[i].classList.remove('playing');
    state.lastBar = -1;
    if (Imp.state.score) renderGuitars(state.curBar || 0, state.curSlot || 0, null);
  }

  /* ============================ 保存 / 谱库 ============================ */
  function saveCurrentScore() {
    var score = Imp.state.score;
    if (!score) { msg('还没有谱面可保存', true); return; }
    var r = Imp.saveScore(score);
    if (!r) { msg('当前环境没有存储后端，保存失败', true); return; }
    renderLibrary();
    if (global.Pager) global.Pager.showItem('improv.scores', function (x) { return x.id === r.score.id; });
    setLib('jianpu');
    msg('已保存到简谱库，并自动生成六线谱（' + r.score.title + '）');
  }

  function saveCurrentCraft() {
    var score = Imp.state.score;
    if (!score) { msg('还没有谱面可保存', true); return; }
    if (!global.Crafts) { msg('作品存储没有加载', true); return; }
    var prompt = $('improvPrompt') ? $('improvPrompt').value.replace(/^\s+|\s+$/g, '') : state.prompt;
    var meta;
    if (state.currentCraft) {
      meta = state.currentCraft;
      var oldBars = meta.score && meta.score.bars ? JSON.stringify(meta.score.bars) : '';
      var newBars = score.bars ? JSON.stringify(score.bars) : '';
      meta.tone = state.tone;
      meta.styleId = state.styleId;
      if (oldBars && oldBars !== newBars) {
        global.Crafts.addVersion(meta, score, { label: '手动保存', source: score.source || 'local' });
      } else {
        meta.score = JSON.parse(JSON.stringify(score));
        meta.updatedAt = (new Date()).getTime();
        global.Crafts.save(meta);
      }
    } else {
      meta = {
        title: (state.recommendation && state.recommendation.title) ||
          (score.title || '即兴作品'),
        prompt: prompt || '',
        recommendation: state.recommendation || null,
        chosen: state.chosenBpm ? {
          bpm: state.chosenBpm,
          drumId: state.recommendation && state.recommendation.drumId,
          rhythmId: state.recommendation && state.recommendation.rhythmId,
          progressionId: state.recommendation && state.recommendation.progressionId
        } : (state.instance ? {
          bpm: state.instance.bpm,
          drumId: state.instance.drum && state.instance.drum.id,
          rhythmId: state.instance.rhythm && state.instance.rhythm.id,
          progressionId: state.instance.progression && state.instance.progression.id
        } : null),
        instance: state.instance ? global.Instances.clone(state.instance) : null,
        tone: state.tone,
        styleId: state.styleId,
        messages: []
      };
      meta = global.Crafts.saveFromScore(meta, score);
    }
    if (!meta) { msg('保存失败：存储不可用', true); return; }
    state.currentCraft = meta;
    state.pendingCraft = null;
    renderLibrary();
    if (global.Pager) global.Pager.refresh('improv.crafts');
    msg('已保存为作品「' + (meta.title || '未命名') + '」');
  }

  function setLib(which) {
    state.lib = which === 'tablature' ? 'tablature' : (which === 'jianpu' ? 'jianpu' : 'craft');
    if ($('craftLib')) $('craftLib').hidden = state.lib !== 'craft';
    if ($('jianpuLib')) $('jianpuLib').hidden = state.lib !== 'jianpu';
    if ($('tabLib')) $('tabLib').hidden = state.lib !== 'tablature';
    var tabs = document.querySelectorAll('#libTabs [data-lib]');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-lib') === state.lib);
    }
    if (global.Pager) global.Pager.refresh(state.lib === 'jianpu' ? 'improv.scores' :
      (state.lib === 'tablature' ? 'improv.tabs' : 'improv.crafts'));
  }

  function buildScoreRow(s) {
    var row = make('div', 'lib-row');
    row.setAttribute('data-score', s.id);
    var main = make('div', 'lib-main');
    main.appendChild(make('div', 'lib-title', s.title || '未命名'));
    main.appendChild(make('div', 'lib-source',
      '走向：' + Imp.progressionLabel(s) +
      (s.instanceName ? ' · 实例：' + s.instanceName : '')));
    var style = Imp.STYLES[0];
    for (var i = 0; i < Imp.STYLES.length; i++) if (Imp.STYLES[i].id === s.styleId) style = Imp.STYLES[i];
    main.appendChild(make('div', 'lib-meta',
      s.bars.length + ' 小节 · ' + M.keyName(s.keyPc, s.preferFlat) + ' ' +
      M.scaleInfo(s.scaleId).label + ' · ' + style.zh + ' · Bias ' + s.bias + ' · ' +
      Imp.statsText(s)));
    row.appendChild(main);
    var btns = make('div', 'row-btns2');
    var play = make('button', 'mini-toggle on play-btn', '播放');
    play.type = 'button';
    play.title = '载入并播放：有关联实例时带鼓机/伴奏，否则只播旋律';
    play.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      loadScore(s.id, true);
    });
    btns.appendChild(play);
    var load = make('button', 'mini-toggle', '载入');
    load.type = 'button';
    load.className += ' load-btn';
    load.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      loadScore(s.id);
    });
    btns.appendChild(load);
    var del = make('button', 'mini-toggle del-btn', '删除');
    del.type = 'button';
    del.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      Imp.deleteScore(s.id);
      if (state.suggestion) state.suggestion = null;
      renderLibrary();
      renderScore(false);
      renderPlayButtons();
      if (global.BandUI) global.BandUI.renderStatus();
      msg('已删除「' + s.title + '」');
    });
    btns.appendChild(del);
    row.appendChild(btns);
    row.addEventListener('click', function () { loadScore(s.id); });
    return row;
  }

  function loadScore(id, autoPlay) {
    var score = Imp.loadScore(id);
    if (!score) { msg('载入失败：这条简谱可能已经被删了', true); return; }
    state.currentCraft = null;
    var inst = score.instanceId ? findInstance(score.instanceId) : null;
    if (inst) {
      selectInstance(score.instanceId, true);
    }
    applyScoreToUi(score);
    renderShapeSelect();
    state.fingering = Imp.fingeringPlan ? Imp.fingeringPlan(score, { shapeId: state.shapeId }) : null;
    renderScore(true);
    renderGuitars(0, 0);
    renderLibrary();
    renderPlayButtons();
    renderHeaderSafe();
    if (autoPlay === true) {
      if (inst) {
        playInstance('已载入「' + score.title + '」：鼓机 + 伴奏 + solo');
      } else {
        var ok = global.Band && global.Band.startSolo
          ? global.Band.startSolo(score, { tone: state.tone, name: score.title })
          : false;
        if (global.BandUI) global.BandUI.render();
        renderPlayButtons();
        msg(ok
          ? '这条谱没有关联实例（或实例已删），正在只播旋律：' + score.title
          : '播放没有启动：当前环境不支持音频', !ok);
      }
    } else {
      msg('已载入「' + score.title + '」');
    }
    if ($('scorePanel') && $('scorePanel').scrollIntoView) {
      try { $('scorePanel').scrollIntoView({ block: 'start' }); } catch (e) {}
    }
  }

  function buildTabRow(t) {
    var row = make('div', 'lib-row');
    var main = make('div', 'lib-main');
    main.appendChild(make('div', 'lib-title', t.zh || '六线谱'));
    main.appendChild(make('div', 'lib-meta',
      (t.text || '').split('\n').length + ' 行 · ' + (t.text || '').length + ' 字符'));
    row.appendChild(main);
    var btns = make('div', 'row-btns2');
    var viewBtn = make('button', 'mini-toggle', '查看');
    viewBtn.type = 'button';
    viewBtn.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      showTab(t.text || '');
    });
    btns.appendChild(viewBtn);
    var del = make('button', 'mini-toggle del-btn', '删除');
    del.type = 'button';
    del.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      Imp.deleteTab(t.id);
      if ($('tabPreview')) $('tabPreview').hidden = true;
      renderLibrary();
      msg('已删除一条六线谱');
    });
    btns.appendChild(del);
    row.appendChild(btns);
    row.addEventListener('click', function () { showTab(t.text || ''); });
    return row;
  }

  function buildCraftRow(c) {
    var row = make('div', 'lib-row craft-row');
    row.setAttribute('data-craft', c.id);
    var main = make('div', 'lib-main');
    main.appendChild(make('div', 'lib-title', c.title || '未命名作品'));
    var prompt = (c.prompt || '').replace(/\s+/g, ' ').slice(0, 46);
    main.appendChild(make('div', 'lib-source', '提示词：' + (prompt || '未填写（按伴奏实例生成）')));
    var inst = c.instance || {};
    var chosen = c.chosen || {};
    var meta = [
      (chosen.bpm || inst.bpm) ? (chosen.bpm || inst.bpm) + ' BPM' : '',
      inst.progression && inst.progression.zh ? '走向「' + inst.progression.zh + '」' : '',
      inst.drum && inst.drum.zh ? '鼓「' + inst.drum.zh + '」' : '',
      inst.rhythm && inst.rhythm.zh ? '节奏「' + inst.rhythm.zh + '」' : ''
    ].filter(function (x) { return !!x; }).join(' · ');
    main.appendChild(make('div', 'lib-meta', meta));
    row.appendChild(main);
    var btns = make('div', 'row-btns2');
    var open = make('button', 'mini-toggle on', '打开');
    open.type = 'button';
    open.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      if (global.showCraftPage) global.showCraftPage(c.id);
    });
    btns.appendChild(open);
    var del = make('button', 'mini-toggle del-btn', '删除');
    del.type = 'button';
    del.addEventListener('click', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      global.Crafts.remove(c.id);
      if (state.currentCraft && state.currentCraft.id === c.id) state.currentCraft = null;
      renderLibrary();
      msg('已删除作品「' + c.title + '」');
    });
    btns.appendChild(del);
    row.appendChild(btns);
    row.addEventListener('click', function () {
      if (global.showCraftPage) global.showCraftPage(c.id);
    });
    return row;
  }

  function renderLibrary() {
    if (!global.Pager) return;
    global.Pager.mount('improv.crafts', {
      hostId: 'craftLib',
      placeholder: '搜索作品（提示词 / 标题 / 走向 / 鼓 / 节奏）…',
      pageSize: 5,
      items: function () { return global.Crafts ? global.Crafts.list() : []; },
      keywords: function (c) {
        var inst = c.instance || {};
        return (c.title || '') + ' ' + (c.prompt || '') + ' ' +
          (inst.progression && inst.progression.zh || '') + ' ' +
          (inst.drum && inst.drum.zh || '') + ' ' +
          (inst.rhythm && inst.rhythm.zh || '') + ' ' +
          (c.chosen && c.chosen.bpm ? c.chosen.bpm + 'bpm' : '') + ' ' + c.id;
      },
      render: function (list, slice) {
        for (var i = 0; i < slice.length; i++) list.appendChild(buildCraftRow(slice[i]));
      }
    });
    global.Pager.mount('improv.scores', {
      hostId: 'jianpuLib',
      placeholder: '搜索简谱（标题 / 走向 / 调 / 风格 / 调式）…',
      pageSize: 5,
      items: function () { return Imp.listScores(); },
      keywords: function (s) {
        return (s.title || '') + ' ' + M.keyName(s.keyPc, s.preferFlat) + ' ' +
          M.scaleInfo(s.scaleId).label + ' ' + s.scaleId + ' ' + s.styleId + ' ' +
          (s.progressionName || '') + ' ' + (s.instanceName || '') + ' ' +
          (s.progressText || '') + ' ' + Imp.progressionLabel(s) + ' ' +
          'bias' + s.bias + ' ' + s.id;
      },
      render: function (list, slice) {
        for (var i = 0; i < slice.length; i++) list.appendChild(buildScoreRow(slice[i]));
      }
    });
    global.Pager.mount('improv.tabs', {
      hostId: 'tabLib',
      placeholder: '搜索六线谱（标题 / 内容）…',
      pageSize: 5,
      items: function () { return Imp.listTabs(); },
      keywords: function (t) { return (t.zh || '') + ' ' + (t.text || '').slice(0, 200); },
      render: function (list, slice) {
        for (var i = 0; i < slice.length; i++) list.appendChild(buildTabRow(slice[i]));
      }
    });
    var n0 = global.Crafts ? global.Crafts.list().length : 0;
    var n1 = Imp.listScores().length, n2 = Imp.listTabs().length;
    if ($('libCount')) $('libCount').textContent = '作品 ' + n0 + ' · 简谱 ' + n1 + ' · 六线谱 ' + n2;
    setLib(state.lib);
  }

  /* ============================ 工具 ============================ */
  function renderSuggestion(res) {
    var box = $('chordSuggest');
    if (!box) return;
    clear(box);
    box.hidden = false;
    var head = make('div', 'label-row');
    head.appendChild(make('label', null, '建议和弦（按小节）'));
    var apply = make('button', 'mini-toggle on', '应用为当前走向');
    apply.type = 'button';
    apply.addEventListener('click', function () {
      var p = Imp.useProgression(res.progression);
      if (!p) { msg('应用失败：和弦走向数据不完整', true); return; }
      var score = Imp.state.score;
      if (score) {
        score.progression = B.cloneProgression(p);
        score.progressionName = p.zh;
        score.barChords = null;
        Imp.setScore(score);
        renderScore(false);
      }
      msg('已把配好的 ' + p.items.length + ' 个和弦设为当前走向；回「伴奏」子页签就能听到');
    });
    head.appendChild(apply);
    box.appendChild(head);

    var list = make('div', 'cs-list');
    for (var i = 0; i < res.bars.length; i++) {
      var b = res.bars[i];
      var row = make('div', 'cs-row');
      row.appendChild(make('span', 'cs-no', String(b.bar)));
      row.appendChild(make('span', 'cs-name', b.name));
      row.appendChild(make('span', 'cs-roman', b.roman));
      row.appendChild(make('span', 'cs-notes', b.notes));
      list.appendChild(row);
    }
    box.appendChild(list);
    box.appendChild(make('div', 'prog-tip',
      '打分规则：强拍与首尾音权重更高，和弦音加分、非和弦音扣分，并偏好上一小节的延续与下行五度。'));
  }

  function suggest() {
    var score = Imp.state.score;
    if (!score) { msg('先有一段简谱才能配和弦', true); return; }
    try {
      var res = Imp.suggestChords(score);
      state.suggestion = res;
      renderSuggestion(res);
      msg('已按简谱给出 ' + res.bars.length + ' 个小节的和弦建议；可以一键设为当前走向');
    } catch (e) {
      msg('配和弦失败：' + (e.message || e), true);
    }
  }

  function scoreToTab() {
    var score = Imp.state.score;
    if (!score) { msg('先有一段简谱才能生成六线谱', true); return; }
    var text = Imp.scoreToTab(score);
    var pre = $('tabPreview');
    if (pre) { pre.hidden = false; pre.textContent = text; }
    var saved = Imp.saveTab(score, text);
    renderLibrary();
    msg(saved ? '六线谱已生成并写入六线谱库' : '六线谱已生成（当前环境无法入库）');
    if (pre && pre.scrollIntoView) {
      try { pre.scrollIntoView({ block: 'center' }); } catch (e) {}
    }
  }

  function importText() {
    var ta = $('scoreText');
    if (!ta || !ta.value.replace(/\s+/g, '')) { msg('先粘贴简谱文本', true); return; }
    /* 导入的谱保持原样：不挂当前走向，也不按 Bias 改音；配和弦是单独的按钮 */
    var score = Imp.parseTextScore(ta.value, {
      keyPc: keyPc(), scaleId: scaleId(), bpm: bpm(),
      preferFlat: preferFlat(), styleId: state.styleId, bias: state.bias
    });
    startLog();
    stepNode({ index: 0, name: '文本导入', status: 'ok',
      detail: score.bars.length + ' 小节 · ' + Imp.statsText(score), ms: 0 });
    appendSummary('已导入文本简谱（没有调用大模型）');
    onScoreReady(score, '文本导入完成');
    msg('已导入 ' + score.bars.length + ' 小节；可以播放、配和弦或生成六线谱');
  }

  function pickImage() {
    if (!LLM.ready()) {
      msg('图片识别需要先配置 AI 接口（多模态模型）', true);
      openApiDialog();
      return;
    }
    if (LLM.state.vendor === 'deepseek') {
      msg('DeepSeek 的聊天模型不支持图片输入。请在「厂商」里选 OpenAI，或选「自定义」并填一个多模态模型的地址；也可以先用文本导入。', true);
      return;
    }
    var input = $('scoreImage');
    if (input) input.click();
  }

  function onImageChosen() {
    var input = $('scoreImage');
    if (!input || !input.files || !input.files.length) return;
    var file = input.files[0];
    input.value = '';
    if (file.size > 4 * 1024 * 1024) {
      msg('图片太大（' + Math.round(file.size / 1024) + ' KB），请压到 4 MB 以内再试', true);
      return;
    }
    var btn = $('btnPickImage');
    if (btn) { btn.disabled = true; btn.textContent = '识别中…'; }
    msg('正在上传并识别图片…');
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      startLog();
      var t0 = (new Date()).getTime();
      var step = { index: 0, name: '图片识别（多模态模型）', status: 'running', detail: '', ms: 0 };
      stepNode(step);
      Imp.recognizeImage(dataUrl, {
        keyPc: keyPc(), scaleId: scaleId(), bpm: bpm(), preferFlat: preferFlat()
      }).then(function (r) {
        stepNode({ index: 0, name: '图片识别（多模态模型）', status: 'ok',
          detail: r.score.bars.length + ' 小节 · ' + Imp.statsText(r.score),
          ms: (new Date()).getTime() - t0 });
        appendSummary('识别完成 · ' + Imp.statsText(r.score) +
          (r.usage && r.usage.total_tokens ? ' · ' + r.usage.total_tokens + ' tokens' : ''));
        onScoreReady(r.score, '图片识别完成');
        /* 需求是“识别出来并写到数据库”：识别成功就直接入简谱库 / 六线谱库 */
        var recSaved = Imp.saveScore(Imp.state.score);
        renderLibrary();
        if (recSaved && global.Pager) {
          global.Pager.showItem('improv.scores', function (x) { return x.id === recSaved.score.id; });
        }
        renderScore(false);
        msg(recSaved
          ? '图片识别完成：已写入简谱库，并自动生成六线谱'
          : '图片识别完成（当前环境没有存储后端，未能入库）');
        if (btn) { btn.disabled = false; btn.textContent = '上传简谱图片识别'; }
      }, function (e) {
        stepNode({ index: 0, name: '图片识别（多模态模型）', status: 'fail',
          detail: e.message || String(e), ms: (new Date()).getTime() - t0 });
        appendSummary('识别失败：' + (e.message || e), true);
        msg('识别失败：' + (e.message || e) +
          '。DeepSeek 不支持图片，请换多模态模型，或先用文本导入。', true);
        if (btn) { btn.disabled = false; btn.textContent = '上传简谱图片识别'; }
      });
    };
    reader.onerror = function () {
      if (btn) { btn.disabled = false; btn.textContent = '上传简谱图片识别'; }
      msg('读取图片失败', true);
    };
    reader.readAsDataURL(file);
  }

  function showTab(text) {
    var pre = $('tabPreview');
    if (!pre) return;
    pre.hidden = false;
    pre.textContent = text;
    if (pre.scrollIntoView) {
      try { pre.scrollIntoView({ block: 'center' }); } catch (e) {}
    }
  }

  /* ============================ 初始化 ============================ */
  /* 生成/本地写的谱是「级数」谱：用户改主调/调式时，旋律与伴奏一起移调。
     导入的谱（text/image）保留它自己的调性，不自动改。 */
  function syncScoreKey() {
    var score = Imp.state.score;
    if (!score) return;
    if (score.source !== 'ai' && score.source !== 'local') return;
    var k = keyPc(), s = scaleId();
    if (score.keyPc === k && score.scaleId === s) return;
    var grid = score.progression
      ? Imp.progressionGrid(score.progression, k, s) : null;
    score.keyPc = k;
    score.scaleId = s;
    score.barChords = null;
    var r = Imp.repairScore(score, { grid: grid, bars: score.bars.length });
    Imp.setScore(r.score);
    if (global.console && global.console.log) {
      global.console.log('[improv] 谱面随主调移调到 ' + M.keyName(k, preferFlat()) + ' ' +
        M.scaleInfo(s).label);
    }
  }

  function render() {
    refreshInstances(state.instance ? state.instance.id : null);
    renderStyleChips();
    renderToneChips();
    renderBias();
    renderMix();
    renderLibrary();
    renderScore(false);
    renderApiState();
    renderQueue();
    renderGuitars(state.curBar || 0, state.curSlot || 0, null);
    var r = AQ && AQ.running();
    if (r && r.kind === 'improv') {
      showTaskLog(r);
      if ($('scoreWaiting')) $('scoreWaiting').hidden = false;
    }
    syncPlayState();
  }

  function init() {
    if (!Imp) return;
    if (AQ) {
      AQ.init({ onChange: onQueueChange });
      AQ.register('improv', improvRunner);
    }
    /* 设置从本地恢复 */
    if (S) {
      var st = S.getSetting('improv.style', 'penta');
      for (var i = 0; i < Imp.STYLES.length; i++) if (Imp.STYLES[i].id === st) state.styleId = st;
      var b = Number(S.getSetting('improv.bias', '40'));
      if (isFinite(b)) state.bias = Math.max(0, Math.min(100, b));
      var rb = Number(S.getSetting('improv.rangeBias', '0.5'));
      if (isFinite(rb)) state.rangeBias = Math.max(0, Math.min(1, rb));
      var tn = S.getSetting('improv.tone', 'electric');
      var tones = A ? A.toneNames() : [];
      for (i = 0; i < tones.length; i++) if (tones[i].id === tn) state.tone = tn;
      var lp = Number(S.getSetting('improv.loops', '1'));
      if (lp === 2 || lp === 3) state.loops = lp;
      var rg = S.getSetting('improv.register', 'low');
      if (rg === 'mid' || rg === 'high') state.register = rg;
      var sh = S.getSetting('improv.shape', 'auto');
      if (sh === 'auto') state.shapeId = 'auto';
      else {
        for (i = 0; i < Imp.SHAPES.length; i++) if (Imp.SHAPES[i].id === sh) state.shapeId = sh;
      }
      var vol = Number(S.getSetting('mix.solo', '1.2'));
      if (isFinite(vol) && vol >= 0 && vol <= 2.2) state.volume = vol;
    }
    Imp.setStyle(state.styleId);
    Imp.setBias(state.bias);
    Imp.setTone(state.tone);
    Imp.setVolume(state.volume);

    renderStyleChips();
    renderToneChips();
    renderShapeSelect();
    renderBias();
    renderRangeBias();
    renderMix();
    renderVendorChips();
    fillConfigInputs();
    updateModeBanner();
    refreshInstances(S ? S.getSetting('improv.instance', '') : '');
    renderLibrary();
    renderScore(false);
    renderApiState();
    renderQueue();
    renderGuitars(0, 0);

    /* 上次保存/载入的谱面：重启后直接接着看 */
    if (S) {
      var last = S.getSetting('improv.lastScore', '');
      if (last) {
        var sc = Imp.loadScore(last);
        if (sc) {
          if (sc.instanceId && findInstance(sc.instanceId)) {
            selectInstance(sc.instanceId, true);
          }
          applyScoreToUi(sc);
          renderShapeSelect();
          state.fingering = Imp.fingeringPlan ? Imp.fingeringPlan(sc, { shapeId: state.shapeId }) : null;
          renderScore(true);
          renderGuitars(0, 0);
          msg('已恢复上次的谱面「' + sc.title + '」');
        }
      }
    }

    on($('biasRange'), 'input', function () {
      state.bias = Number(this.value);
      Imp.setBias(state.bias);
      if (S) S.setSetting('improv.bias', String(state.bias));
      renderBias();
    });
    on($('rangeBiasRange'), 'input', function () {
      state.rangeBias = Number(this.value);
      if (S) S.setSetting('improv.rangeBias', String(state.rangeBias));
      renderRangeBias();
    });
    on($('styleSelect'), 'change', function () {
      state.styleId = this.value;
      Imp.setStyle(this.value);
      if (S) S.setSetting('improv.style', this.value);
      updateContextHint();
    });
    on($('toneSelect'), 'change', function () {
      state.tone = this.value;
      Imp.setTone(this.value);
      if (S) S.setSetting('improv.tone', this.value);
    });
    on($('shapeSelect'), 'change', function () {
      state.shapeId = this.value || 'auto';
      if (S) S.setSetting('improv.shape', state.shapeId);
      if (Imp.hasScore()) {
        state.fingering = Imp.fingeringPlan(Imp.state.score, { shapeId: state.shapeId });
        renderGuitars(state.curBar || 0, state.curSlot || 0, null);
      }
    });
    on($('btnTonePreview'), 'click', function () {
      if (!A || !A.previewTone) { msg('当前环境不支持音频试听', true); return; }
      var ok = A.previewTone(state.tone);
      var label = state.tone;
      var list = A.toneNames ? A.toneNames() : [];
      for (var ti = 0; ti < list.length; ti++) if (list[ti].id === state.tone) label = list[ti].zh;
      msg(ok ? '正在试听音色：' + label : '当前环境不支持音频试听', !ok);
    });
    on($('lengthSelect'), 'change', function () {
      state.loops = Number(this.value) || 1;
      if (S) S.setSetting('improv.loops', String(state.loops));
      updateContextHint();
      if (Imp.hasScore()) msg('长度改为 ' + state.loops + ' 个 loop；重新生成后生效');
    });
    on($('registerSelect'), 'change', function () {
      state.register = this.value;
      if (S) S.setSetting('improv.register', this.value);
      if (state.instance) {
        state.instance.register = this.value;
        if (global.Instances) global.Instances.save(state.instance);
      }
      if (global.Band && global.Band.isPlaying()) B.setRegister(this.value);
      renderGuitars(state.curBar || 0, state.curSlot || 0, null);
    });
    on($('mixDrums'), 'input', function () {
      if (global.Band) global.Band.setMix('drums', Number(this.value) / 100);
      renderMix();
    });
    on($('mixBacking'), 'input', function () {
      if (global.Band) global.Band.setMix('backing', Number(this.value) / 100);
      renderMix();
    });
    on($('mixSolo'), 'input', function () {
      if (global.Band) global.Band.setMix('solo', Number(this.value) / 100);
      renderMix();
    });

    on($('instanceSelect'), 'change', function () {
      if (this.value) selectInstance(this.value);
    });
    on($('instanceSearch'), 'input', function () {
      renderInstanceSelects();
    });
    on($('btnInstNew'), 'click', openInstDialog);
    on($('btnSaveInstance'), 'click', openInstDialog);
    on($('btnInstDelete'), 'click', function () {
      if (state.instance) deleteInstance(state.instance.id);
    });
    on($('btnDeleteInstance'), 'click', function () {
      var sel = $('bandInstanceSelect');
      if (sel && sel.value) deleteInstance(sel.value);
    });
    on($('instDialogClose'), 'click', closeInstDialog);
    on($('btnInstCancel'), 'click', closeInstDialog);
    on($('btnInstSave'), 'click', saveInstFromDialog);
    on($('instDialog'), 'click', function (e) {
      if (e.target === this) closeInstDialog();
    });

    /* 注意要包一层：直接把 generate 当监听器会把 click 事件当成 autoPlay 参数 */
    on($('btnImprovGen'), 'click', function () { generate(true); });
    on($('btnSaveScore'), 'click', saveCurrentCraft);
    on($('btnRecGenerate'), 'click', function () { confirmRecommendation(true); });
    on($('recBpmInput'), 'input', syncRecActions);
    on($('btnUseRecBpm'), 'click', function () {
      if (state.recommendation && state.recommendation.bpm) chooseRecommendedBpm(state.recommendation.bpm);
    });
    on($('recDrumSelect'), 'change', recDraftFromUi);
    on($('recRhythmSelect'), 'change', recDraftFromUi);
    on($('recProgressionSelect'), 'change', recDraftFromUi);
    on($('improvPrompt'), 'input', function () {
      state.prompt = this.value.replace(/^\s+|\s+$/g, '');
      state.recSeq++;
      state.busyRec = false;
      if (state.recommendation && $('recPanel') && !$('recPanel').hidden) {
        state.recommendation = null;
        state.recDraft = null;
        state.recPrompt = '';
        $('recPanel').hidden = true;
      }
      renderInstanceInfo();
    });
    on($('btnQueueClear'), 'click', function () {
      if (AQ) AQ.clearDone();
      renderQueue();
    });

    on($('btnSuggestChords'), 'click', suggest);
    on($('btnScoreToTab'), 'click', scoreToTab);
    on($('btnPickImage'), 'click', pickImage);
    on($('scoreImage'), 'change', onImageChosen);
    on($('btnTextImport'), 'click', importText);

    on($('btnApiOpen'), 'click', openApiDialog);
    on($('btnAppSettings'), 'click', openApiDialog);
    on($('themeSelect'), 'change', function () {
      var mode = this.value || 'auto';
      if (S) S.setSetting('ui.theme', mode);
      if (global.applyTheme) global.applyTheme(mode);
    });
    on($('apiDialogClose'), 'click', closeApiDialog);
    on($('apiDialog'), 'click', function (e) {
      if (e.target === this) closeApiDialog();
    });
    on($('llmVendor'), 'change', function () {
      var v = this.value;
      LLM.save({
        vendor: v,
        base: (v === 'custom') ? LLM.state.base : '',
        model: (v === 'custom') ? LLM.state.model : ''
      });
      fillConfigInputs();
      renderApiState();
    });
    on($('btnLlmTest'), 'click', testConnection);
    on($('btnLlmSave'), 'click', function () {
      readConfig();
      closeApiDialog();
      if (LLM.ready()) msg('接口配置已保存到本机（' + LLM.effective().model + '）');
      else msg('还缺字段：地址 / 模型 / API Key', true);
    });
    on($('llmBase'), 'change', readConfig);
    on($('llmModel'), 'change', readConfig);
    on($('llmKey'), 'change', readConfig);

    var libTabs = $('libTabs');
    on(libTabs, 'click', function (e) {
      var t = e.target;
      while (t && t !== libTabs) {
        if (t.getAttribute && t.getAttribute('data-lib')) break;
        t = t.parentNode;
      }
      if (!t || !t.getAttribute) return;
      setLib(t.getAttribute('data-lib'));
    });

    renderPlayButtons();
    syncPlayState();
  }

  global.ImprovUI = {
    init: init,
    render: render,
    highlight: highlight,
    clearHighlight: clearHighlight,
    syncPlayState: syncPlayState,
    state: state,
    setLib: setLib,
    generate: generate,
    confirmRecommendation: confirmRecommendation,
    generateLocal: generateLocal,
    onStartRequested: onStartRequested,
    saveCurrentScore: saveCurrentScore,
    saveCurrentCraft: saveCurrentCraft,
    renderLibrary: renderLibrary,
    openApiDialog: openApiDialog,
    fretWindowSvg: fretWindowSvg,
    chooseRecommendedBpm: chooseRecommendedBpm,
    suggest: suggest,
    scoreToTab: scoreToTab,
    importText: importText,
    testConnection: testConnection,
    buildOpts: buildOpts
  };
})(window);
