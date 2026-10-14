/*!
 * app.js —— 交互层：串起状态、算法（chord.js）与渲染（render.js）。
 */
(function (global) {
  'use strict';

  var M = global.Music, C = global.Chord, R = global.Render, S = global.Audio_;

  /* ----------------------------- 全局状态 ----------------------------- */
  var state = {
    keyPc: 0,               /* 主调 */
    scaleId: 'major',       /* 音阶（决定级数对应的音） */
    degree: 1,              /* 级数 1..7 */
    accidental: 0,          /* 变音 -1 / 0 / +1 */
    qualityId: 'maj',       /* 和弦属性 */
    maxFret: 24,            /* 指板最大品 */
    span: 4,                /* 单个指法最大跨度 */
    minSounding: 4,         /* 最少发声弦数 */
    bassIsRoot: true,       /* 低音必须是根音 */
    allowInnerMute: false,  /* 允许发声弦中间夹闷弦 */
    showAllTones: false,    /* 指板上显示全部和弦音 */
    compact: false,         /* true = 每个把位只留最佳指法 */
    labelMode: 'finger',    /* 和弦图标注：finger / note / none */
    rangeFilter: 'all',     /* 品域过滤 */
    diatonic7: false,       /* 调内和弦显示七和弦 */
    preferFlat: false,      /* 是否用降号拼写 */
    openSheet: false,       /* 启动时是否直接展开条件面板（直达链接用） */
    selected: 0,            /* 当前高亮指法的下标（state.voicings 内） */
    voicings: [],
    filtered: []            /* [{v, index}] 过滤后的可见指法 */
  };

  /* ----------------------------- DOM 小工具 ----------------------------- */
  function $(id) { return document.getElementById(id); }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* 重建容器内容，同时保留横向滚动位置（避免点选后跳回开头） */
  function rebuild(container, build) {
    var sl = container.scrollLeft;
    clear(container);
    build(container);
    container.scrollLeft = sl;
  }

  /* 生成一个 chip 按钮 */
  function chip(group, value, label, tag, on) {
    var b = make('button', 'chip' + (on ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('data-group', group);
    b.setAttribute('data-value', String(value));
    b.appendChild(make('span', null, label));
    if (tag) b.appendChild(make('span', 'tag', tag));
    return b;
  }

  function syncChips(group, value) {
    var list = document.querySelectorAll('[data-group="' + group + '"]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-value') === String(value)) list[i].classList.add('on');
      else list[i].classList.remove('on');
    }
  }

  /* ----------------------------- 和弦推导 ----------------------------- */
  function currentRootPc() {
    return M.degreeToPc(state.keyPc, state.scaleId, state.degree, state.accidental);
  }
  function currentQuality() {
    return C.qualityById(state.qualityId);
  }
  function shortZh(q) {
    return q.zh.replace('和弦', '');
  }
  function voicingLabel(v) {
    if (!v) return '';
    if (v.position === 0) return '开放把位';
    return '第 ' + v.position + ' 把位' + (v.hasOpen ? ' · 含空弦' : '');
  }

  /* ----------------------------- 控件构建 ----------------------------- */
  function buildKeys() {
    rebuild($('keyChips'), function (box) {
      for (var i = 0; i < M.KEYS.length; i++) {
        var k = M.KEYS[i];
        var b = chip('key', k.pc, M.keyName(k.pc, state.preferFlat), null, k.pc === state.keyPc);
        box.appendChild(b);
      }
    });
  }

  function buildScales() {
    rebuild($('scaleChips'), function (box) {
      for (var i = 0; i < M.SCALES.length; i++) {
        var sc = M.SCALES[i];
        var b = chip('scale', sc.id, sc.label, null, sc.id === state.scaleId);
        b.classList.add('sm');
        b.classList.add('alt');
        box.appendChild(b);
      }
    });
  }

  function buildDegrees() {
    rebuild($('degreeChips'), function (box) {
      for (var d = 1; d <= 7; d++) {
        var rootPc = M.degreeToPc(state.keyPc, state.scaleId, d, state.accidental);
        var b = chip('degree', d, String(d), M.noteName(rootPc, state.preferFlat), d === state.degree);
        box.appendChild(b);
      }
    });
  }

  function buildAcc() {
    var btns = $('accChips').getElementsByTagName('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', Number(btns[i].getAttribute('data-acc')) === state.accidental);
    }
  }

  /* 调内和弦一排：按音阶自然形成的和弦 */
  function buildDiatonic() {
    var majorSteps = [0, 2, 4, 5, 7, 9, 11];
    var scale = M.scaleById(state.scaleId);
    rebuild($('diatonicRow'), function (box) {
      for (var d = 1; d <= 7; d++) {
        var info = M.scaleChordQuality(state.keyPc, state.scaleId, d, state.diatonic7);
        var acc = scale.steps[d - 1] - majorSteps[d - 1];
        var figure = state.diatonic7 ? M.seventhFigure(info.qualityId) : '';
        var roman = M.romanNumeral(d, acc, info.triad, figure);
        var q = C.qualityById(info.qualityId);
        var sym = M.noteName(info.rootPc, state.preferFlat) + q.symbol;
        var b = chip('diatonic', d, roman, sym, false);
        b.classList.add('sm');
        box.appendChild(b);
      }
    });
  }

  function buildQualities() {
    rebuild($('qualityGroups'), function (box) {
      var rootPc = currentRootPc();
      var families = [];
      var i, j;
      for (i = 0; i < C.QUALITY_LIST.length; i++) {
        if (families.indexOf(C.QUALITY_LIST[i].family) < 0) families.push(C.QUALITY_LIST[i].family);
      }
      for (i = 0; i < families.length; i++) {
        var group = make('div', 'qgroup');
        group.appendChild(make('div', 'qname', families[i]));
        var row = make('div', 'chip-row');
        for (j = 0; j < C.QUALITY_LIST.length; j++) {
          var q = C.QUALITY_LIST[j];
          if (q.family !== families[i]) continue;
          var label = M.noteName(rootPc, state.preferFlat) + q.symbol;
          var b = chip('quality', q.id, label, shortZh(q), q.id === state.qualityId);
          b.classList.add('sm');
          row.appendChild(b);
        }
        group.appendChild(row);
        box.appendChild(group);
      }
    });
  }

  /* 数值型设置项 */
  var SETTINGS = [
    { group: 'maxFret', node: 'maxFretChips', items: [12, 15, 17, 19, 21, 22, 24], tag: function (v) { return v + ' 品'; } },
    { group: 'span', node: 'spanChips', items: [3, 4, 5], tag: null },
    { group: 'minSounding', node: 'minSoundChips', items: [3, 4, 5, 6], tag: function (v) { return v + ' 弦'; } },
    {
      group: 'compact', node: 'modeChips', items: [{ v: false, t: '全部指法' }, { v: true, t: '精简（每把位 1 个）' }],
      isOn: function (val) { return !!state.compact === !!val; }
    },
    {
      group: 'labelMode', node: 'labelChips',
      items: [{ v: 'finger', t: '指法' }, { v: 'note', t: '音名' }, { v: 'none', t: '无' }],
      isOn: function (val) { return state.labelMode === val; }
    }
  ];

  function buildSettings() {
    for (var i = 0; i < SETTINGS.length; i++) {
      (function (cfg) {
        rebuild($(cfg.node), function (box) {
          for (var j = 0; j < cfg.items.length; j++) {
            var it = cfg.items[j];
            var isObj = (typeof it === 'object');
            var val = isObj ? it.v : it;
            var text = isObj ? it.t : String(it);
            var tag = (!isObj && cfg.tag) ? cfg.tag(val) : null;
            var on = cfg.isOn ? cfg.isOn(val) : (state[cfg.group] === val);
            var b = chip(cfg.group, String(val), text, tag, on);
            b.classList.add('sm');
            box.appendChild(b);
          }
        });
      })(SETTINGS[i]);
    }
  }

  function buildRanges() {
    var items = [
      { v: 'all', t: '全部' },
      { v: '0-4', t: '0-4 品' },
      { v: '5-9', t: '5-9 品' },
      { v: '10-16', t: '10-16 品' },
      { v: '17-24', t: '17-24 品' }
    ];
    rebuild($('rangeChips'), function (box) {
      for (var i = 0; i < items.length; i++) {
        var b = chip('range', items[i].v, items[i].t, null, items[i].v === state.rangeFilter);
        b.classList.add('sm');
        box.appendChild(b);
      }
    });
  }

  /* ----------------------------- 顶部信息 ----------------------------- */
  function renderHeader() {
    var rootPc = currentRootPc();
    var q = currentQuality();
    var roman = M.romanNumeral(state.degree, state.accidental, q.triad, M.seventhFigure(q.id));
    var keyName = M.keyName(state.keyPc, state.preferFlat);

    $('chordName').textContent = C.chordSymbol(rootPc, q, state.preferFlat);
    $('chordRoman').textContent = roman + ' 级 · ' + shortZh(q);
    var tones = C.chordToneNames(rootPc, q, state.preferFlat);
    var parts = [];
    for (var i = 0; i < tones.length; i++) parts.push(tones[i].name + '(' + tones[i].degree + ')');
    $('chordNotes').textContent = parts.join('  ');
    $('subTitle').textContent = keyName + ' ' + M.scaleById(state.scaleId).label + ' · ' + roman + ' 级 · ' +
      q.zh + ' · ' + state.voicings.length + ' 个指法';
    $('btnSpell').innerHTML = state.preferFlat ? '&#9837;' : '&#9839;';
  }

  /* ----------------------------- 指板图 ----------------------------- */
  function renderNeck(centerOnSelection) {
    var v = state.voicings[state.selected];
    var rootPc = currentRootPc();
    var q = currentQuality();
    var html = R.neck({
      maxFret: state.maxFret,
      rootPc: rootPc,
      quality: q,
      frets: v ? v.frets : null,
      barre: v ? v.barre : null,
      preferFlat: state.preferFlat,
      showAllTones: state.showAllTones
    });
    $('neckBox').innerHTML = html;

    if (v) {
      $('voicingLabel').textContent = voicingLabel(v);
      var degs = [];
      for (var i = 0; i < v.notes.length; i++) {
        degs.push(C.intervalDegreeName(M.mod12(v.notes[i].pc - rootPc)));
      }
      /* 谱记法与各音在和弦中的级数：放在指板下方的整行，窄屏也不会被挤压 */
      $('neckInfo').textContent = v.sounding + ' 弦 · ' + C.tabString(v) + ' · ' + degs.join(' ');
    } else {
      $('voicingLabel').textContent = '没有可用指法';
      $('neckInfo').textContent = '';
    }

    /* 让所选把位滚动到视野中央 */
    if (centerOnSelection && v && v.position > 0) {
      var m = R.neckMetrics;
      var cx = m.leftPad + (v.position - 0.5) * m.fretW;
      var box = $('neckScroll');
      var target = cx - box.clientWidth / 2;
      if (target < 0) target = 0;
      box.scrollLeft = target;
    } else if (centerOnSelection) {
      $('neckScroll').scrollLeft = 0;
    }
  }

  /* ----------------------------- 结果列表 ----------------------------- */
  function inRange(pos) {
    if (state.rangeFilter === 'all') return true;
    var parts = state.rangeFilter.split('-');
    return pos >= Number(parts[0]) && pos <= Number(parts[1]);
  }

  /* 生成一个指法卡片 */
  function makeCard(item) {
    var v = item.v;
    var rootPc = currentRootPc();
    var card = make('div', 'card' + (item.index === state.selected ? ' on' : ''));
    card.setAttribute('data-index', String(item.index));
    card.innerHTML = R.chordBox(v, {
      labelMode: state.labelMode,
      preferFlat: state.preferFlat,
      rootPc: rootPc
    });
    card.appendChild(make('div', 'tab', C.tabString(v)));
    var uniq = [];
    for (var k = 0; k < v.notes.length; k++) {
      var dn = C.intervalDegreeName(M.mod12(v.notes[k].pc - rootPc));
      if (uniq.indexOf(dn) < 0) uniq.push(dn);
    }
    card.appendChild(make('div', 'badge', uniq.join(' · ')));
    card.addEventListener('click', function () {
      selectVoicing(item.index, true);
    });
    return card;
  }

  /* 填充某个把位的卡片（懒加载时按需调用） */
  function fillCards(node, items) {
    if (node.getAttribute('data-filled')) return;
    node.setAttribute('data-filled', '1');
    node.classList.remove('lazy');
    for (var j = 0; j < items.length; j++) node.appendChild(makeCard(items[j]));
  }

  var groupObserver = null;

  function renderResults() {
    var box = $('results');

    /* 过滤 + 分组 */
    var visible = [];
    for (var i = 0; i < state.voicings.length; i++) {
      if (inRange(state.voicings[i].position)) visible.push({ v: state.voicings[i], index: i });
    }
    if (state.compact) {
      var byPos = {};
      var compacted = [];
      for (i = 0; i < visible.length; i++) {
        var p = visible[i].v.position;
        if (byPos[p]) continue;
        byPos[p] = true;
        compacted.push(visible[i]);
      }
      visible = compacted;
    }
    state.filtered = visible;

    $('resultCount').textContent = visible.length + ' 个 / 共 ' + state.voicings.length + ' 个';

    if (groupObserver) { groupObserver.disconnect(); groupObserver = null; }
    clear(box);

    if (!visible.length) {
      var empty = make('div', 'empty');
      empty.innerHTML = '没有找到符合条件的指法。<br>可以试试：放宽“最大跨度”、关闭“低音必须是根音”、<br>把“最少发声弦数”降到 3，或调大“指板最大品”。';
      box.appendChild(empty);
      return;
    }

    /* 按把位分组 */
    var groups = [];
    var indexByPos = {};
    for (i = 0; i < visible.length; i++) {
      var pos = visible[i].v.position;
      if (indexByPos[pos] === undefined) {
        indexByPos[pos] = groups.length;
        groups.push({ position: pos, hasOpen: false, items: [] });
      }
      var g = groups[indexByPos[pos]];
      g.items.push(visible[i]);
      if (visible[i].v.hasOpen) g.hasOpen = true;
    }

    var canLazy = !!global.IntersectionObserver;
    var lazyQueue = [];

    for (i = 0; i < groups.length; i++) {
      (function (g, gi) {
        var wrap = make('div', 'pos-group');
        var head = make('div', 'pos-head');
        head.appendChild(make('strong', null, g.position === 0 ? '开放把位' : ('第 ' + g.position + ' 把位') + (g.hasOpen ? ' · 含空弦' : '')));
        head.appendChild(make('span', null, g.items.length + ' 个指法'));
        wrap.appendChild(head);

        var cards = make('div', 'cards');
        cards.setAttribute('data-g', String(gi));
        if (canLazy) {
          cards.className = 'cards lazy';   /* 先占位，进入视野再渲染 */
          lazyQueue.push(cards);
        } else {
          fillCards(cards, g.items);
        }
        wrap.appendChild(cards);
        box.appendChild(wrap);
      })(groups[i], i);
    }

    if (canLazy && lazyQueue.length) {
      groupObserver = new global.IntersectionObserver(function (entries) {
        for (var e = 0; e < entries.length; e++) {
          if (!entries[e].isIntersecting) continue;
          var node = entries[e].target;
          var gi = Number(node.getAttribute('data-g'));
          fillCards(node, groups[gi].items);
          groupObserver.unobserve(node);
        }
      }, { root: null, rootMargin: '700px 0px', threshold: 0 });
      for (i = 0; i < lazyQueue.length; i++) groupObserver.observe(lazyQueue[i]);
      /* 首屏可见的把位立即渲染，避免依赖回调时序 */
      for (i = 0; i < Math.min(2, lazyQueue.length); i++) fillCards(lazyQueue[i], groups[i].items);
    }
  }

  /* ----------------------------- 选中某个指法 ----------------------------- */
  function selectVoicing(index, scroll) {
    state.selected = index;
    var cards = document.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('on', Number(cards[i].getAttribute('data-index')) === index);
    }
    renderNeck(scroll);
  }

  function stepSelection(delta) {
    if (!state.filtered.length) return;
    var pos = -1;
    for (var i = 0; i < state.filtered.length; i++) {
      if (state.filtered[i].index === state.selected) { pos = i; break; }
    }
    if (pos < 0) pos = 0;
    pos = pos + delta;
    if (pos < 0) pos = state.filtered.length - 1;
    if (pos >= state.filtered.length) pos = 0;
    selectVoicing(state.filtered[pos].index, true);
    /* 让对应卡片滚入视野 */
    var card = document.querySelector('.card[data-index="' + state.selected + '"]');
    if (card && card.scrollIntoView) {
      card.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  }

  /* ----------------------------- 主刷新流程 ----------------------------- */
  function refresh(keepSelection) {
    var rootPc = currentRootPc();
    var q = currentQuality();
    state.voicings = C.searchVoicings(rootPc, q, {
      maxFret: state.maxFret,
      span: state.span,
      minSounding: state.minSounding,
      bassIsRoot: state.bassIsRoot,
      allowInnerMute: state.allowInnerMute,
      maxResults: 800
    });
    if (!keepSelection) state.selected = 0;
    if (state.selected >= state.voicings.length) state.selected = state.voicings.length - 1;
    if (state.selected < 0) state.selected = 0;

    buildKeys();
    buildScales();
    buildDegrees();
    buildAcc();
    buildDiatonic();
    buildQualities();
    buildSettings();
    buildRanges();
    renderHeader();
    renderResults();
    renderNeck(false);
  }

  /* ----------------------------- 条件面板（底部抽屉） ----------------------------- */
  function openSheet() {
    $('sheet').classList.add('open');
    $('backdrop').classList.add('open');
    document.body.classList.add('sheet-open');
    /* 回到顶部，让页头和指板都露在抽屉上方，边选边看 */
    if (global.scrollTo) global.scrollTo(0, 0);
  }
  function closeSheet() {
    $('sheet').classList.remove('open');
    $('backdrop').classList.remove('open');
    document.body.classList.remove('sheet-open');
  }

  /* ----------------------------- 事件绑定 ----------------------------- */
  function onChipClick(e) {
    var node = e.target;
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute('data-group')) break;
      node = node.parentNode;
    }
    if (!node || node === document.body) return;
    var group = node.getAttribute('data-group');
    var value = node.getAttribute('data-value');
    var keepSelection = false;

    if (group === 'key') {
      state.keyPc = Number(value);
      state.preferFlat = !!M.FLAT_KEYS[Number(value)];
    } else if (group === 'scale') {
      state.scaleId = value;
    } else if (group === 'degree') {
      state.degree = Number(value);
    } else if (group === 'quality') {
      state.qualityId = value;
    } else if (group === 'diatonic') {
      var d = Number(value);
      var info = M.scaleChordQuality(state.keyPc, state.scaleId, d, state.diatonic7);
      var majorSteps = [0, 2, 4, 5, 7, 9, 11];
      var acc = M.scaleById(state.scaleId).steps[d - 1] - majorSteps[d - 1];
      state.degree = d;
      state.accidental = acc;
      state.qualityId = info.qualityId;
      keepSelection = false;
      refresh(keepSelection);
      closeSheet();          /* 从调内和弦一键选定后收起面板，直接看指板 */
      return;
    } else if (group === 'maxFret' || group === 'span' || group === 'minSounding') {
      state[group] = Number(value);
    } else if (group === 'compact') {
      state.compact = (value === 'true');
    } else if (group === 'labelMode') {
      state.labelMode = value;
    } else if (group === 'range') {
      state.rangeFilter = value;
      syncChips('range', value);   /* 只重绘结果，但筛选 chip 的高亮要跟着走 */
      renderResults();
      return;
    }
    refresh(keepSelection);
  }

  function bind() {
    document.body.addEventListener('click', onChipClick);

    /* 条件面板开关 */
    $('btnSettings').addEventListener('click', openSheet);
    $('sheetDone').addEventListener('click', closeSheet);
    $('backdrop').addEventListener('click', closeSheet);

    $('accChips').addEventListener('click', function (e) {
      var t = e.target;
      if (!t.getAttribute || !t.getAttribute('data-acc')) return;
      state.accidental = Number(t.getAttribute('data-acc'));
      refresh(false);
    });

    $('btnSpell').addEventListener('click', function () {
      state.preferFlat = !state.preferFlat;
      refresh(true);
    });

    $('btnDiatonic7').addEventListener('click', function () {
      state.diatonic7 = !state.diatonic7;
      this.classList.toggle('on', state.diatonic7);
      refresh(true);
    });

    $('btnPrev').addEventListener('click', function () { stepSelection(-1); });
    $('btnNext').addEventListener('click', function () { stepSelection(1); });
    $('btnPlay').addEventListener('click', function () {
      var v = state.voicings[state.selected];
      if (v) S.playVoicing(v);
    });

    $('chkBassRoot').addEventListener('change', function () {
      state.bassIsRoot = this.checked; refresh(true);
    });
    $('chkInnerMute').addEventListener('change', function () {
      state.allowInnerMute = this.checked; refresh(true);
    });
    $('chkAllTones').addEventListener('change', function () {
      state.showAllTones = this.checked; renderNeck(false);
    });

    /* 屏幕旋转 / 尺寸变化时重新居中 */
    global.addEventListener('resize', function () { renderNeck(true); });

    /* 键盘左右键切换（桌面浏览器预览时方便） */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') stepSelection(-1);
      else if (e.key === 'ArrowRight') stepSelection(1);
    });
  }

  /* ----------------------------- 启动 ----------------------------- */
  /* 老版本系统 WebView（Android 5.x 自带的 Chrome 37~48）不支持 CSS 变量，
     样式会降级成简化版。这里提示用户更新一下 WebView 就能恢复完整界面。 */
  function checkLegacyWebView() {
    /* CSS.supports 本身是 Chrome 28+ 就有的；连它都没有说明更老，同样要提示 */
    var supported = !!(global.CSS && global.CSS.supports &&
      (global.CSS.supports('--chord-probe', '0') ||
       global.CSS.supports('color', 'var(--chord-probe)')));
    if (supported) return;
    try {
      var tip = document.createElement('div');
      tip.className = 'legacy-tip';
      tip.textContent = '当前系统 WebView 版本过旧（不支持 CSS 变量），界面已降级为简化样式。'
        + '请到应用商店更新「Android System WebView」后重新打开。';
      var header = document.querySelector('.app-header');
      if (header && header.parentNode) header.parentNode.insertBefore(tip, header.nextSibling);
    } catch (e) { /* 提示失败不影响使用 */ }
  }
  /* 支持 #key=2&scale=minor&degree=6&q=m7&maxFret=15 形式的直达参数 */
  function applyHash() {
    var hash = (global.location && global.location.hash) ? global.location.hash.replace(/^#/, '') : '';
    if (!hash) return;

    function num(v, def, lo, hi) {
      var n = Number(v);
      if (isNaN(n) || !isFinite(n)) return def;
      if (lo !== undefined && n < lo) n = lo;
      if (hi !== undefined && n > hi) n = hi;
      return n;
    }

    var parts = hash.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv.length !== 2) continue;
      var k = decodeURIComponent(kv[0]);
      var v = decodeURIComponent(kv[1]);
      if (k === 'key') { state.keyPc = num(v, 0, 0, 11); state.preferFlat = !!M.FLAT_KEYS[state.keyPc]; }
      else if (k === 'scale') { if (M.scaleById(v).id === v) state.scaleId = v; }
      else if (k === 'degree') { state.degree = num(v, 1, 1, 7); }
      else if (k === 'acc') { state.accidental = num(v, 0, -1, 1); }
      else if (k === 'q') { state.qualityId = C.qualityById(v).id; }
      else if (k === 'maxFret') { state.maxFret = num(v, 24, 5, 24); }
      else if (k === 'span') { state.span = num(v, 4, 2, 6); }
      else if (k === 'minSounding') { state.minSounding = num(v, 4, 2, 6); }
      else if (k === 'bass' && v === 'any') { state.bassIsRoot = false; }
      else if (k === 'flat') { state.preferFlat = (v === '1'); }
      else if (k === 'sheet') { state.openSheet = (v === '1'); }
    }
    $('chkBassRoot').checked = state.bassIsRoot;
  }

  function init() {
    /* 起始状态：C 大调 I 级大三和弦 */
    state.keyPc = 0;
    state.preferFlat = false;
    applyHash();
    bind();
    $('btnDiatonic7').classList.toggle('on', state.diatonic7);
    refresh(false);
    checkLegacyWebView();
    if (state.openSheet) openSheet();
    global.CHORD_STATE = state;   /* 方便调试 / 自动化测试 */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
