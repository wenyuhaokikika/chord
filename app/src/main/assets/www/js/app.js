/*!
 * app.js —— 交互层：串起状态、算法（chord.js）与渲染（render.js）。
 */
(function (global) {
  'use strict';

  var M = global.Music, C = global.Chord, R = global.Render, S = global.Audio_, P = global.Pitch, T = global.Tuner;

  /* ----------------------------- 全局状态 ----------------------------- */
  var state = {
    tab: 'chord',           /* chord | band | improv | works | tuner(dialog) | craft */
    keyPc: 0,               /* 主调 */
    scaleId: 'major',       /* 音阶 / 调式（决定级数对应的音） */
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
    cagedShape: null,       /* 当前从 CAGED 卡片选中的形状 id */
    voicings: [],
    filtered: [],           /* [{v, index}] 过滤后的可见指法 */
    /* 调音相关 */
    a4: 440,                /* 基准音 */
    scaleLabel: 'both',     /* 音阶指板标注：both | degree | name */
    scanPc: null,           /* 麦克风当前测到的音（pitch class），用于指板高亮 */
    micOn: false,
    patternId: null,        /* 鼓机直达链接参数 */
    subTab: null,           /* 伴奏页签的直达子页签：drums | backing | improv */
    mkprog: false,          /* 调试：造一条自建走向 */
    mkrhythm: false,        /* 调试：造一条自建节奏型 */
    progId: null,           /* 伴奏走向直达参数 */
    rhythmId: null,         /* 伴奏节奏型直达参数 */
    bpm: 0,
    debug: false          /* #debug=1 时把关键元素坐标打进 logcat */
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
      var lastGroup = null;
      for (var i = 0; i < M.SCALES.length; i++) {
        var sc = M.SCALES[i];
        if (sc.group && sc.group !== lastGroup) {
          lastGroup = sc.group;
          var g = make('span', 'group-label', sc.group);
          box.appendChild(g);
        }
        var b = chip('scale', sc.id, sc.label, sc.en || null, sc.id === state.scaleId);
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
    },
    {
      group: 'a4', node: 'a4Chips', items: [432, 435, 438, 440, 442, 444], tag: function (v) { return 'Hz'; },
      isOn: function (val) { return Number(state.a4) === Number(val); }
    }
  ];

  /* 音阶指板标注：级数+音名 / 只看级数 / 只看音名 */
  var SCALE_LABELS = [
    { v: 'both', t: '级数+音名' },
    { v: 'degree', t: '只级数' },
    { v: 'name', t: '只音名' }
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
    var keyName = M.keyName(state.keyPc, state.preferFlat);

    if (state.tab === 'craft' && global.CraftUI) {
      var craft = global.CraftUI.current();
      $('chordName').textContent = craft ? (craft.title || '作品') : '作品';
      $('chordRoman').textContent = craft ? (craft.chosen && craft.chosen.bpm ? craft.chosen.bpm + ' BPM' : '作品') : '';
      $('chordNotes').textContent = craft && craft.instance
        ? (M.keyName(craft.instance.keyPc, state.preferFlat) + ' ' +
           M.scaleInfo(craft.instance.scaleId).label + ' · ' +
           (craft.instance.progression && craft.instance.progression.zh || '') +
           ' · ' + (craft.instance.rhythm && craft.instance.rhythm.zh || ''))
        : '作品详情';
      $('subTitle').textContent = '作品详情 · 提示词 / 推荐 / 简谱 / 会话';
      $('btnSpell').innerHTML = state.preferFlat ? '&#9837;' : '&#9839;';
      return;
    }

    /* 即兴页的页头显示当前实例与播放状态 */
    if (state.tab === 'improv' && global.ImprovUI) {
      var iu = global.ImprovUI.state;
      var inst = iu && iu.instance;
      $('chordName').textContent = '即兴';
      $('chordRoman').textContent = inst ? inst.name : '未选择实例';
      $('chordNotes').textContent = inst
        ? (M.keyName(inst.keyPc, state.preferFlat) + ' ' + M.scaleInfo(inst.scaleId).label +
           ' · ' + inst.bpm + ' BPM · ' +
           (inst.progression && inst.progression.items ? inst.progression.items.length : 0) + ' 个和弦')
        : '先到「伴奏」页保存一个伴奏实例';
      $('subTitle').textContent = inst
        ? (global.Band && global.Band.isPlaying() ? global.Band.statusText() : '按实例写 solo · 选风格/长度后生成')
        : '选择一个伴奏实例';
      $('btnSpell').innerHTML = state.preferFlat ? '&#9837;' : '&#9839;';
      return;
    }

    /* 作品库是独立页签 */
    if (state.tab === 'works') {
      var wc = global.Crafts ? global.Crafts.list().length : 0;
      $('chordName').textContent = '作品';
      $('chordRoman').textContent = wc + ' 个作品';
      $('chordNotes').textContent = '提示词 · 和弦图 · 版本记录 · 会话改谱';
      $('subTitle').textContent = wc ? '点开作品查看推荐、双吉他和版本' : '还没有作品：去「即兴」生成一段';
      $('btnSpell').innerHTML = state.preferFlat ? '&#9837;' : '&#9839;';
      return;
    }

    /* 鼓机板块的页头显示当前节奏与速度 */
    if (state.tab === 'band' && global.Band) {      var bs = global.Band.state;
      var dp = global.DrumsUI ? global.DrumsUI.currentPattern() : null;
      var bp = global.BackingUI ? global.BackingUI.currentProgression() : null;
      $('chordName').textContent = '伴奏';
      $('chordRoman').textContent = bs.bpm + ' BPM';
      $('chordNotes').textContent = (bs.drumsOn && dp ? '鼓机 ' + dp.zh : '鼓机 关') +
        ' · ' + (bs.backingOn && bp ? '伴奏 ' + bp.zh : '伴奏 关');
      $('subTitle').textContent = (bs.playing ? '正在播放 · ' : '已停止 · ') + global.Band.statusText();
      $('btnSpell').innerHTML = state.preferFlat ? '&#9837;' : '&#9839;';
      return;
    }

    /* 调音板块的页头显示当前调式，和弦板块显示当前和弦 */
    if (state.tab === 'tuner') {
      var info = M.scaleInfo(state.scaleId);
      var tones = M.scaleTones(state.keyPc, state.scaleId, state.preferFlat);
      var names = [];
      for (var t = 0; t < tones.length; t++) names.push(tones[t].name);
      var chars = M.scaleCharacter(state.scaleId);
      $('chordName').textContent = keyName + ' ' + info.label;
      $('chordRoman').textContent = info.en || info.label;
      $('chordNotes').textContent = names.join(' ');
      $('subTitle').textContent = '调音 · 音阶 · 特征音 ' + (chars.length ? chars.join(' ') : '无') +
        ' · ' + (info.feel || '') ;
      $('btnSpell').innerHTML = state.preferFlat ? '&#9837;' : '&#9839;';
      return;
    }

    var rootPc = currentRootPc();
    var q = currentQuality();
    var roman = M.romanNumeral(state.degree, state.accidental, q.triad, M.seventhFigure(q.id));

    $('chordName').textContent = C.chordSymbol(rootPc, q, state.preferFlat);
    $('chordRoman').textContent = roman + ' 级 · ' + shortZh(q);
    var toneList = C.chordToneNames(rootPc, q, state.preferFlat);
    var parts = [];
    for (var i = 0; i < toneList.length; i++) parts.push(toneList[i].name + '(' + toneList[i].degree + ')');
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
      $('voicingLabel').textContent = (state.cagedShape ? state.cagedShape + ' 型 · ' : '') + voicingLabel(v);
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
    updateCagedActive();
  }


  /* ----------------------------- CAGED 五种指型 ----------------------------- */
  function cagedRootText(shape) {
    if (!shape.voicing) return '这个筛选下没有代表指法';
    var str = shape.rootString === 0 ? '6 弦' : (shape.rootString === 1 ? '5 弦' : '4 弦');
    var pos = shape.hasOpen ? '含空弦' : (shape.position === 0 ? '开放把位' : '第 ' + shape.position + ' 把位');
    return '根音 ' + str + ' ' + shape.rootFret + ' 品 · ' + pos;
  }

  function renderCaged() {
    var row = $('cagedRow');
    if (!row) return;
    var rootPc = currentRootPc();
    var q = currentQuality();
    var shapes = C.cagedVoicings ? C.cagedVoicings(state.voicings, rootPc, {
      maxFret: state.maxFret
    }) : [];
    clear(row);
    var found = 0;
    for (var i = 0; i < shapes.length; i++) {
      (function (shape, si) {
        if (!shape.voicing) {
          row.appendChild(make('div', 'caged-empty', shape.zh + '：当前条件下没有代表指法'));
          return;
        }
        found++;
        var idx = state.voicings.indexOf(shape.voicing);
        var card = make('div', 'caged-card' + (idx === state.selected ? ' on' : ''));
        card.setAttribute('data-caged', shape.id);
        card.setAttribute('data-index', String(idx));
        card.setAttribute('title', 'CAGED ' + shape.zh + '：' + C.tabString(shape.voicing));
        var head = make('div', 'caged-card-head');
        head.appendChild(make('span', 'caged-shape', shape.id));
        head.appendChild(make('span', 'caged-fret', shape.hasOpen ? '开放' : (shape.position === 0 ? '开放' : shape.position + ' 品')));
        card.appendChild(head);
        var box = make('div', 'caged-svg');
        box.innerHTML = R.chordBox(shape.voicing, {
          labelMode: state.labelMode,
          preferFlat: state.preferFlat,
          rootPc: rootPc
        });
        card.appendChild(box);
        card.appendChild(make('div', 'caged-root', cagedRootText(shape)));
        card.addEventListener('click', function () {
          if (idx < 0) return;
          selectVoicing(idx, true, shape.id);
          if ($('neckSection') && $('neckSection').scrollIntoView) {
            try { $('neckSection').scrollIntoView({ block: 'start' }); } catch (e) {}
          }
        });
        row.appendChild(card);
      })(shapes[i], i);
    }
    if ($('cagedCount')) $('cagedCount').textContent = found + ' / 5 个形状';
    if ($('cagedHint')) {
      $('cagedHint').textContent = '先记 5 个形状，再记每个形状的根音位置 · ' +
        C.chordSymbol(rootPc, q, state.preferFlat);
    }
    updateCagedActive();
  }

  function updateCagedActive() {
    var cards = document.querySelectorAll('#cagedRow .caged-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('on', Number(cards[i].getAttribute('data-index')) === state.selected);
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
  function selectVoicing(index, scroll, cagedId) {
    state.selected = index;
    state.cagedShape = cagedId || null;
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
    if (!keepSelection) { state.selected = 0; state.cagedShape = null; }
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
    if (global.BackingUI) global.BackingUI.pushToEngine();
    renderHeader();
    if (state.tab === 'chord') renderCaged();
    if (state.tab === 'tuner') {
      renderTuner();
    } else if (state.tab === 'band') {
      global.BackingUI.render();
      global.BandUI.render();
    } else if (state.tab === 'improv') {
      if (global.ImprovUI) global.ImprovUI.render();
    } else if (state.tab === 'works') {
      if (global.ImprovUI) global.ImprovUI.renderLibrary();
    } else {
      renderResults();
      renderNeck(false);
    }
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
    } else if (group === 'a4') {
      state.a4 = Number(value);
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

    /* 页签 */
    $('tabs').addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== document.body) {
        if (node.getAttribute && node.getAttribute('data-tab')) break;
        node = node.parentNode;
      }
      if (!node || node === document.body) return;
      var name = node.getAttribute('data-tab');
      if (name !== state.tab) applyTab(name);
    });

    /* 调音 */
    $('btnMic').addEventListener('click', toggleMic);
    if ($('btnTunerOpen')) $('btnTunerOpen').addEventListener('click', function () { applyTab('tuner'); });
    if ($('btnTunerClose')) $('btnTunerClose').addEventListener('click', closeTunerDialog);
    $('btnTunerSettings').addEventListener('click', openSheet);
    $('btnScaleLabel').addEventListener('click', function () {
      var order = ['both', 'degree', 'name'];
      var idx = order.indexOf(state.scaleLabel);
      state.scaleLabel = order[(idx + 1) % order.length];
      renderTuner();
    });

    /* 伴奏页签：总控（bandui）+ 鼓机（drumsui）+ 和弦伴奏（backingui） */
    global.DrumsUI.init({ onChange: function () { syncBandHeader(); } });
    global.BackingUI.init({
      onPickKey: function () { openSheet(); },
      onChange: function () { syncBandHeader(); }
    });
    global.BandUI.init();
    if (global.ImprovUI) global.ImprovUI.init();
    if (global.CraftUI) global.CraftUI.init();
    if (state.subTab) global.BandUI.subTab(state.subTab);
    global.openBandTab = function () { applyTab('band'); };

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

  /* ----------------------------- 调音 · 音阶板块 ----------------------------- */
  function buildTonesRow() {
    var tones = M.scaleTones(state.keyPc, state.scaleId, state.preferFlat);
    rebuild($('tonesRow'), function (box) {
      for (var i = 0; i < tones.length; i++) {
        var t = tones[i];
        var b = make('button', 'tone-chip' + (t.isRoot ? ' root' : ''));
        b.type = 'button';
        b.appendChild(make('span', 'tone-deg', t.degreeLabel));
        b.appendChild(make('span', 'tone-name', t.name));
        b.appendChild(make('span', 'tone-st', '+' + t.semitone));
        box.appendChild(b);
      }
    });
  }

  /* 调式表：调式 / 起点 / 特征音 / 听感（点一下切换）。
     调式以后会越来越多，所以套了搜索 + 分页。 */
  function buildModeTable() {
    var modes = [];
    var i;
    for (i = 0; i < M.SCALES.length; i++) modes.push(M.SCALES[i]);
    if (!global.Pager) return;
    global.Pager.mount('tuner.modes', {
      hostId: 'modeTable',
      placeholder: '搜索调式（中文 / 英文 / 特征音）…',
      pageSize: 6,
      items: function () { return modes; },
      keywords: function (m) {
        return m.label + ' ' + (m.en || '') + ' ' + (m.char || '') + ' ' + (m.feel || '') + ' ' +
          (m.group || '') + ' ' + m.id;
      },
      render: function (list, slice) {
        for (var k = 0; k < slice.length; k++) {
          (function (m) {
            var idx = -1;
            for (var z = 0; z < modes.length; z++) if (modes[z].id === m.id) idx = z;
            var charNames = M.scaleCharacter(m.id);
            var row = make('div', 'mode-row' + (m.id === state.scaleId ? ' on' : ''));
            row.setAttribute('data-group', 'scale');       /* 复用 chip 的点击逻辑 */
            row.setAttribute('data-value', m.id);
            row.appendChild(make('span', 'mode-name', m.label));
            row.appendChild(make('span', 'mode-start', (m.group || '') + ' · 第 ' + (idx + 1) + ' 个'));
            row.appendChild(make('span', 'mode-char', charNames.length ? charNames.join(' ') : '无'));
            row.appendChild(make('span', 'mode-feel', m.feel || ''));
            list.appendChild(row);
          })(slice[k]);
        }
      }
    });
  }

  function renderTuner() {
    if (global.Pager) global.Pager.showItem('tuner.modes', function (m) { return m.id === state.scaleId; });
    var keyName = M.keyName(state.keyPc, state.preferFlat);
    var info = M.scaleInfo(state.scaleId);
    var chars = M.scaleCharacter(state.scaleId);

    $('scaleTitle').textContent = keyName + ' ' + info.label + (info.en ? '（' + info.en + '）' : '');
    $('scaleInfo').textContent = '特征音 ' + (chars.length ? chars.join(' ') : '无') +
      ' · 主音 ' + keyName + ' · 基准 A4 = ' + state.a4 + ' Hz · 指板 0-' + state.maxFret + ' 品';
    $('btnScaleLabel').textContent = state.scaleLabel === 'both' ? '级数+音名'
      : (state.scaleLabel === 'degree' ? '只级数' : '只音名');

    $('scaleBox').innerHTML = R.scaleNeck({
      maxFret: state.maxFret,
      tones: M.scaleTones(state.keyPc, state.scaleId, state.preferFlat),
      scanPc: state.scanPc,
      labelMode: state.scaleLabel
    });

    $('modeDesc').innerHTML = '<div class="mode-title">' + R.esc(keyName + ' ' + info.label) +
      '<span class="mode-en">' + R.esc(info.en || '') + '</span></div>' +
      '<div class="mode-line"><b>特征音</b>' + R.esc(chars.length ? chars.join('、') : '无（等于自然大调）') + '</div>' +
      '<div class="mode-line"><b>听感</b>' + R.esc(info.feel || '-') + '</div>';

    buildTonesRow();
    buildModeTable();
  }

  /* 麦克风读数 -> 界面 */
  function updateReadout(res) {
    if (!res) {
      $('tuneNote').textContent = '--';
      $('tuneNote').className = 'note-big';
      $('tuneFreq').textContent = '-- Hz';
      $('tuneDegree').textContent = '--';
      $('tuneString').textContent = '--';
      $('tuneCents').textContent = '-- 音分';
      $('centsNeedle').style.left = '50%';
      if (state.scanPc !== null) {
        state.scanPc = null;
        renderTuner();
      }
      return;
    }

    var nt = P.freqToNote(res.freq, state.a4);
    var ann = M.annotateNote(nt.pc, state.keyPc, state.scaleId, state.preferFlat);
    var str = P.nearestString(nt.midi);
    var cents = nt.cents;

    $('tuneNote').textContent = ann.name;
    $('tuneNote').className = 'note-big' + (Math.abs(cents) <= 5 ? ' in-tune' : '')
      + (ann.inScale ? '' : ' out-scale');
    $('tuneFreq').textContent = res.freq.toFixed(1) + ' Hz · ' + ann.name + nt.octave;
    $('tuneDegree').textContent = ann.degreeLabel + ' 级' + (ann.inScale ? '' : '（调外音）');
    $('tuneString').textContent = '≈ ' + str.label;
    $('tuneCents').textContent = (cents > 0 ? '+' : '') + cents + ' 音分' +
      (Math.abs(cents) <= 5 ? ' · 准' : (cents < 0 ? ' · 偏低' : ' · 偏高'));
    var pos = 50 + Math.max(-50, Math.min(50, cents));
    $('centsNeedle').style.left = pos + '%';

    if (ann.pc !== state.scanPc) {
      /* 只有音名变了才重画指板（否则每秒 60 次重绘会卡） */
      state.scanPc = ann.pc;
      $('scaleBox').innerHTML = R.scaleNeck({
        maxFret: state.maxFret,
        tones: M.scaleTones(state.keyPc, state.scaleId, state.preferFlat),
        scanPc: state.scanPc,
        labelMode: state.scaleLabel
      });
    }
  }

  function setMicState(on, message) {
    state.micOn = on;
    /* 真机上排查麦克风问题看 logcat 就够了（adb logcat | grep ChordHelper） */
    if (global.console && global.console.log) {
      global.console.log('[tuner] mic=' + (on ? 'on' : 'off') + ' msg=' + (message || '-'));
    }
    $('btnMic').textContent = on ? '停止收音' : '开始收音';
    $('btnMic').classList.toggle('accent', !on);
    var tip = $('tunerTip');
    tip.classList.toggle('error', !on && !!message);
    if (message) tip.textContent = message;
    else if (on) {
      tip.textContent = '正在收音…对着吉他拨一根弦，或哼一个音。数字跳动说明还在稳定，看“音分”最直观。';
    } else {
      tip.textContent = '已停止。点“开始收音”可继续。';
    }
  }

  function toggleMic() {
    if (state.micOn) {
      T.stop({ onStop: function () { setMicState(false, '已停止。点“开始收音”可继续。'); updateReadout(null); } });
      return;
    }
    if (!T.isSupported()) {
      setMicState(false, T.describeError(null));
      return;
    }
    $('btnMic').textContent = '正在启动…';
    if (global.console && global.console.log) global.console.log('[tuner] 请求麦克风权限…');
    var handlers = {
      onStart: function () { setMicState(true, null); if (global.warnBandVsMic) global.warnBandVsMic(); },
      onResult: function (res) { updateReadout(res); },
      onError: function (msg) { setMicState(false, msg); },
      onStop: function () { if (state.micOn) setMicState(false, null); }
    };
    var opts = { minHz: 55, maxHz: 1400 };
    /* 测试用插口：自动化测试通过 __TUNER_TEST_SOURCE 注入一个已知频率的振荡器，
       这样不依赖真实麦克风也能跑通「音频 -> 基频 -> 界面」整条链路。 */
    if (global.__TUNER_TEST_SOURCE) {
      T.attachSource(global.__TUNER_TEST_SOURCE, handlers, opts);
      return;
    }
    T.start(handlers, opts);
  }

  function closeTunerDialog() {
    if (state.micOn) {
      T.stop({
        onStop: function () {
          setMicState(false, '已停止。点“开始收音”可继续。');
          updateReadout(null);
        }
      });
    }
    var back = state.tunerReturnTab || 'chord';
    var craftId = state.tunerReturnCraftId;
    state.tunerReturnCraftId = null;
    if (craftId && global.showCraftPage && global.showCraftPage(craftId)) return;
    applyTab(back);
  }

  /* ----------------------------- 页签切换 ----------------------------- */
  /* ----------------------------- 页签切换 ----------------------------- */
  /* 伴奏页签下，任何改动都要刷新页头（换节奏/走向/速度都会调到这里） */
  function syncBandHeader() {
    if (state.tab === 'band') renderHeader();
    if (state.tab === 'band' && global.BandUI) global.BandUI.render();
  }
  /* 只刷页头、不回头刷总控：BandUI 的状态变化（如自动启用即兴）用它，
     避免 syncBandHeader → BandUI.render → renderStatus → syncBandHeader 的环。 */
  global.refreshBandHeader = function () {
    if (state.tab === 'band' || state.tab === 'improv') renderHeader();
  };

  /* 伴奏在响的时候调音会被鼓声/琴声干扰，提醒一句 */
  function warnBandVsMic() {
    if (state.micOn && global.Band && global.Band.isPlaying()) {
      var tip = $('tunerTip');
      if (tip) {
        tip.classList.add('error');
        tip.textContent = '伴奏正在播放，麦克风会把鼓声/琴声一起收进去，建议先停掉伴奏再调音（或戴耳机）。';
      }
    }
  }
  global.warnBandVsMic = warnBandVsMic;

  /* ----------------------------- 外观主题 ----------------------------- */
  function applyTheme(mode) {
    var m = (mode === 'light' || mode === 'dark') ? mode : '';
    try {
      if (m) document.documentElement.setAttribute('data-theme', m);
      else document.documentElement.removeAttribute('data-theme');
    } catch (e) {}
    state.theme = m || 'auto';
  }
  global.applyTheme = applyTheme;

  /* 打开作品详情：独立的一屏，不占顶部页签 */
  global.showCraftPage = function (id) {
    if (!global.CraftUI || !global.CraftUI.open(id)) return false;
    state.tab = 'craft';
    $('viewChord').hidden = true;
    $('viewTuner').hidden = true;
    $('viewBand').hidden = true;
    $('viewImprov').hidden = true;
    if ($('viewWorks')) $('viewWorks').hidden = true;
    if ($('viewCraft')) $('viewCraft').hidden = false;
    document.body.classList.add('craft-view');
    document.body.classList.remove('tuner-dialog');
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('on');
    document.body.classList.remove('tab-tuner');
    renderHeader();
    global.scrollTo(0, 0);
    return true;
  };
  global.applyTab = applyTab;

  function applyTab(name, skipRender) {
    var prevTab = state.tab;
    if (name === 'tuner' && prevTab !== 'tuner') {
      state.tunerReturnTab = (prevTab === 'craft') ? 'works' : (prevTab || 'chord');
      state.tunerReturnCraftId = (prevTab === 'craft' && global.CraftUI && global.CraftUI.current())
        ? global.CraftUI.current().id : null;
    }
    if (name === 'tuner' && !state.tunerReturnTab) state.tunerReturnTab = 'chord';
    state.tab = name;
    /* 只看主动页签：#tabs 里那些；子页签（#bandTabs）有自己的选中状态，别一起清掉 */
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === name);
    }
    $('viewChord').hidden = (name !== 'chord');
    $('viewTuner').hidden = (name !== 'tuner');
    $('viewBand').hidden = (name !== 'band');
    $('viewImprov').hidden = (name !== 'improv');
    if ($('viewWorks')) $('viewWorks').hidden = (name !== 'works');
    if ($('viewCraft')) $('viewCraft').hidden = true;
    document.body.classList.remove('craft-view');
    document.body.classList.toggle('tab-tuner', name === 'tuner');
    document.body.classList.toggle('tuner-dialog', name === 'tuner');
    if (name !== 'tuner') {
      state.tunerReturnTab = null;
      state.tunerReturnCraftId = null;
    }

    /* 条件面板里只跟和弦有关的几项，切到调音/鼓机时隐藏 */
    var chordOnly = ['degreeField', 'diatonicField', 'qualityField'];
    for (i = 0; i < chordOnly.length; i++) {
      var el = $(chordOnly[i]);
      if (el) el.style.display = (name === 'chord') ? '' : 'none';
    }
    $('sheetTitle').textContent = (name === 'chord') ? '查询条件' : '主调与调式';

    if (!skipRender) {
      renderHeader();
      if (name === 'tuner') renderTuner();
      else if (name === 'band') {
        /* 从即兴实例回来时，把伴奏页当前的鼓/走向/节奏型重新装回引擎 */
        if (global.DrumsUI && global.DrumsUI.pushToEngine) global.DrumsUI.pushToEngine();
        global.DrumsUI.render();
        global.BackingUI.pushToEngine();
        global.BackingUI.render();
        global.BandUI.render();
        /* 正在播放的话，页头大字要立刻显示回当前和弦 */
        if (global.BandUI.nowChord()) global.BandUI.setNowChord(global.BandUI.nowChord());
      }
      else if (name === 'improv') {
        if (global.ImprovUI) global.ImprovUI.render();
      }
      else if (name === 'works') {
        if (global.ImprovUI) global.ImprovUI.renderLibrary();
      }
      else { renderCaged(); renderResults(); renderNeck(false); }
    }
    global.scrollTo(0, 0);
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
      else if (k === 'tab') {
        state.tab = (v === 'tuner') ? 'tuner' :
          ((v === 'band' || v === 'drums') ? 'band' :
            (v === 'improv' ? 'improv' : (v === 'works' ? 'works' : 'chord')));
      }
      else if (k === 'prog') { state.progId = v; }
      else if (k === 'rhythm') { state.rhythmId = v; }
      else if (k === 'sub') {
        state.subTab = (v === 'backing' || v === 'drums') ? v : null;
      }
      else if (k === 'mode') { if (M.scaleById(v).id === v) state.scaleId = v; }
      else if (k === 'pattern') { state.patternId = v; }
      else if (k === 'bpm') { state.bpm = num(v, 100, 40, 240); }
      else if (k === 'a4') { state.a4 = num(v, 440, 400, 480); }
      else if (k === 'debug') { state.debug = (v === '1'); }
      /* 调试用：mkprog=1 会按正常保存路径造一条自建走向，用来在真机上验证“自建内容落库/重启恢复” */
      else if (k === 'mkprog') { state.mkprog = (v === '1'); }
      else if (k === 'mkrhythm') { state.mkrhythm = (v === '1'); }
    }
    $('chkBassRoot').checked = state.bassIsRoot;
  }

  /* 真机上排查布局/点击问题时：#tab=tuner&debug=1 会把关键元素的坐标打进 logcat */
  function dumpRects() {
    if (!state.debug || !global.console) return;
    /* 调试模式顺带验证一次存储的读写闭环（原生 SQLite 桥） */
    if (global.Store) {
      var stamp = String((new Date()).getTime());
      global.Store.setSetting('debug.lastOpen', stamp);
      var back = global.Store.getSetting('debug.lastOpen', '(读不到)');
      global.console.log('[store] 后端=' + global.Store.backend() + ' ' + global.Store.info() +
        ' 读回=' + (back === stamp ? '一致' : ('不一致 ' + back)) +
        ' bpm=' + global.Store.getSetting('bpm', '-') +
        ' 自建走向=' + global.Store.listItems('progression').length);
    }
    var ids = ['tabs', 'btnMic', 'tuneNote', 'tunerTip', 'scaleBox', 'chordName', 'stepGrid',
      'miniPlayer', 'btnBandPlay', 'bandTabs', 'btnNewProg', 'scoreView', 'btnImprovLocal', 'tabLib'];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (!el) continue;
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var hit = document.elementFromPoint ? document.elementFromPoint(cx, cy) : null;
      global.console.log('[debug] ' + ids[i] + ' rect=' + Math.round(r.left) + ',' + Math.round(r.top) +
        ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
        ' dpr=' + (global.devicePixelRatio || 1) + ' vw=' + global.innerWidth + 'x' + global.innerHeight +
        ' hit=' + (hit ? (hit.tagName + (hit.id ? '#' + hit.id : '') +
          (hit.className ? '.' + String(hit.className).split(' ').join('.') : '')) : 'null'));
    }
  }

  function init() {
    /* 起始状态：C 大调 I 级大三和弦 */
    state.keyPc = 0;
    state.preferFlat = false;
    if (global.Store) applyTheme(global.Store.getSetting('ui.theme', 'auto'));
    applyHash();
    /* 后面的 UI 初始化（伴奏引擎、即兴）要读当前调式，先挂上 */
    global.CHORD_STATE = state;
    /* 直达链接里的鼓机参数要在面板初始化之前落到它的状态里 */
    if (global.DrumsUI) {
      if (state.patternId) global.DrumsUI.state.patternId = state.patternId;
    }
    if (global.BackingUI) {
      if (state.progId) global.BackingUI.state.progId = state.progId;
      if (state.rhythmId) global.BackingUI.state.rhythmId = state.rhythmId;
    }
    if (global.Band && state.bpm) global.Band.state.bpm = state.bpm;
    applyTab(state.tab, true);
    bind();
    $('btnDiatonic7').classList.toggle('on', state.diatonic7);
    refresh(false);
    checkLegacyWebView();
    if (state.mkprog && global.BackingUI) {
      var d = global.BackingUI.newProgressionDraft();
      d.id = 'custom-debug';
      d.zh = '调试用走向';
      d.tip = '由 mkprog=1 生成，用于验证持久化';
      BackingUI.openProgEditor(d);
      BackingUI.saveProg();
    }
    if (state.mkrhythm && global.BackingUI) {
      var d2 = global.BackingUI.newRhythmDraft('strum');
      d2.id = 'myr-debug';
      d2.zh = '调试用节奏型';
      BackingUI.openRhythmEditor(d2);
      BackingUI.saveRhythm();
    }
    dumpRects();
    if (state.openSheet) openSheet();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
