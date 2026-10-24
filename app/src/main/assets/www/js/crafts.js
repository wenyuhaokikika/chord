/*!
 * crafts.js —— 「作品（craft）」数据与推荐 agent
 *
 * 一个 craft 把一次完整创作冻结在一起：
 *   用户提示词 + 推荐 agent 的鼓/节奏型/走向/BPM + 用户实际选择
 *   + 伴奏实例 + 简谱 + 后续会话修改记录。
 * 全部作为一条 JSON 存在 SQLite 的 items(kind='craft') 里。
 */
(function (global) {
  'use strict';

  var Store = global.Store, LLM = global.LLM, B = global.Backing,
      Patterns = global.Patterns, M = global.Music;

  function now() { return (new Date()).getTime(); }
  function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }
  function trim(s) { return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, ''); }

  function all() {
    if (!Store) return [];
    var list = Store.listItems('craft');
    list.sort(function (a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); });
    return list;
  }
  function get(id) {
    if (!Store || !id) return null;
    return Store.getItem('craft', id);
  }
  function save(craft) {
    if (!Store || !craft) return null;
    if (!craft.id) craft.id = 'craft' + now() + '-' + Math.floor(Math.random() * 10000);
    craft.createdAt = craft.createdAt || now();
    craft.updatedAt = now();
    ensureVersions(craft);
    Store.putItem('craft', craft.id, craft);
    return craft;
  }
  function remove(id) {
    if (Store) Store.removeItem('craft', id);
  }

  /* 旧 craft 没有版本记录时，把当前谱面补成 v1；后续修改再追加 v2/v3。 */
  function ensureVersions(craft) {
    if (!craft) return null;
    if (!Array.isArray(craft.versions)) craft.versions = [];
    if (!craft.versions.length && craft.score) {
      craft.versions.push({
        id: 'v1',
        no: 1,
        label: '初版',
        note: craft.prompt || '初版生成',
        settings: settingsFrom(craft, craft.score),
        score: clone(craft.score),
        createdAt: craft.createdAt || now(),
        source: (craft.score && craft.score.source) || 'local'
      });
    }
    for (var i = 0; i < craft.versions.length; i++) {
      if (!craft.versions[i].settings) {
        craft.versions[i].settings = settingsFrom(craft, craft.versions[i].score || craft.score);
      }
    }
    if (!craft.finalVersionId && craft.versions.length) {
      craft.finalVersionId = craft.versions[craft.versions.length - 1].id;
    }
    return craft;
  }

  function settingsFrom(source, score) {
    var chosen = (source && source.chosen) || {};
    var inst = (source && source.instance) || {};
    return {
      bpm: Number(chosen.bpm || inst.bpm || (score && score.bpm) || 0),
      drumId: chosen.drumId || (inst.drum && inst.drum.id) || '',
      drumName: chosen.drumName || (inst.drum && inst.drum.zh) || '',
      rhythmId: chosen.rhythmId || (inst.rhythm && inst.rhythm.id) || '',
      rhythmName: chosen.rhythmName || (inst.rhythm && inst.rhythm.zh) || '',
      progressionId: chosen.progressionId || (inst.progression && inst.progression.id) || '',
      progressionName: chosen.progressionName || (inst.progression && inst.progression.zh) || '',
      keyPc: (inst.keyPc === undefined ? null : inst.keyPc),
      scaleId: inst.scaleId || '',
      register: inst.register || 'low'
    };
  }

  function addVersion(craft, score, opts) {
    if (!craft || !score) return null;
    ensureVersions(craft);
    opts = opts || {};
    var no = craft.versions.length + 1;
    var ver = {
      id: 'v' + no + '-' + Math.floor(Math.random() * 100000),
      no: no,
      label: opts.label || '修改',
      note: opts.note || '',
      settings: opts.settings || settingsFrom(craft, score),
      score: clone(score),
      createdAt: now(),
      source: opts.source || score.source || 'ai'
    };
    craft.versions.push(ver);
    craft.finalVersionId = ver.id;
    craft.score = clone(score);
    craft.updatedAt = now();
    save(craft);
    return ver;
  }

  function versionById(craft, id) {
    if (!craft) return null;
    ensureVersions(craft);
    for (var i = 0; i < craft.versions.length; i++) {
      if (craft.versions[i].id === id) return craft.versions[i];
    }
    return null;
  }

  function finalVersion(craft) {
    if (!craft) return null;
    ensureVersions(craft);
    for (var i = 0; i < craft.versions.length; i++) {
      if (craft.versions[i].id === craft.finalVersionId) return craft.versions[i];
    }
    return craft.versions.length ? craft.versions[craft.versions.length - 1] : null;
  }

  function drumById(id) {
    var list = Patterns.LIST;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function rhythmById(id) {
    var list = B.RHYTHMS;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    var custom = global.BackingUI && global.BackingUI.state && global.BackingUI.state.customRhythms;
    if (custom) {
      for (i = 0; i < custom.length; i++) if (custom[i].id === id) return custom[i];
    }
    return null;
  }
  function progressionById(id) {
    var list = B.PROGRESSIONS;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    var custom = global.BackingUI && global.BackingUI.state && global.BackingUI.state.customProgs;
    if (custom) {
      for (i = 0; i < custom.length; i++) if (custom[i].id === id) return custom[i];
    }
    return null;
  }

  function bpmTop5(base) {
    var b = Math.max(45, Math.min(200, Math.round(Number(base) || 80)));
    var out = [b - 8, b - 4, b, b + 4, b + 8];
    for (var i = 0; i < out.length; i++) out[i] = Math.max(40, Math.min(240, out[i]));
    return out;
  }

  function localRecommend(prompt, opts) {
    opts = opts || {};
    var p = trim(prompt).toLowerCase();
    var sad = /凄|悲|秋|落叶|老人|孤独|寂|夜|雨|思念|忧伤|slow|sad|lonely/.test(p);
    var calm = /安静|平静|舒缓|温柔|治愈|轻|soft|calm/.test(p);
    var rock = /摇滚|热血|燃|激烈|rock|metal|energy/.test(p);
    var funk = /放克|律动|funk|groove/.test(p);
    var jazz = /爵士|jazz|酒吧|慵懒|lazy/.test(p);
    var drumId = sad ? 'ballad' : (rock ? 'rock8' : (funk ? 'funk' : (jazz ? 'bossa' : 'pop')));
    if (calm && !sad) drumId = 'ballad';
    var rhythmId = sad || calm ? 'strum_ballad' : (funk ? 'strum_mute' : (jazz ? 'arp_quart' : 'arp5321'));
    var progId = sad ? 'song_tender' : (calm ? 'song_heal' : (rock ? 'pop4' : (jazz ? 'song_jazzbar' : 'pop4')));
    if (!progressionById(progId)) progId = 'pop4';
    var baseBpm = sad ? 66 : (calm ? 72 : (rock ? 112 : (jazz ? 88 : 96)));
    var drum = drumById(drumId) || Patterns.byId('pop');
    var prog = progressionById(progId) || B.progressionById('pop4');
    var rhythm = rhythmById(rhythmId) || B.rhythmById('arp5321');
    return {
      source: 'local',
      title: trim(prompt).slice(0, 24) || '即兴作品',
      drumId: drum.id, drumName: drum.zh,
      rhythmId: rhythm.id, rhythmName: rhythm.zh,
      progressionId: prog.id, progressionName: prog.zh,
      bpm: baseBpm,
      bpmTop5: bpmTop5(baseBpm),
      reason: sad
        ? '提示词偏凄凉/秋日，推荐慢速抒情鼓、扫弦垫底和温柔走向。'
        : '按提示词的情绪选了偏 ' + (rock ? '摇滚' : (jazz ? '爵士' : '流行')) + ' 的伴奏。'
    };
  }

  function candidateText() {
    var lines = [];
    lines.push('鼓机（drumId）：');
    for (var i = 0; i < Patterns.LIST.length; i++) lines.push('- ' + Patterns.LIST[i].id + ' = ' + Patterns.LIST[i].zh);
    lines.push('节奏型（rhythmId）：');
    for (i = 0; i < B.RHYTHMS.length; i++) lines.push('- ' + B.RHYTHMS[i].id + ' = ' + B.RHYTHMS[i].zh);
    lines.push('和弦走向（progressionId）：');
    for (i = 0; i < B.PROGRESSIONS.length; i++) lines.push('- ' + B.PROGRESSIONS[i].id + ' = ' + B.PROGRESSIONS[i].zh);
    return lines.join('\n');
  }

  function normalizeRec(raw, fallback, opts) {
    raw = raw || {};
    var base = fallback || localRecommend('', opts);
    var drum = drumById(raw.drumId) || drumById(base.drumId) || Patterns.byId('pop');
    var rhythm = rhythmById(raw.rhythmId) || rhythmById(base.rhythmId) || B.rhythmById('arp5321');
    var prog = progressionById(raw.progressionId) || progressionById(base.progressionId) || B.progressionById('pop4');
    var top = [];
    if (Array.isArray(raw.bpmTop5)) {
      for (var i = 0; i < raw.bpmTop5.length; i++) {
        var n = Math.round(Number(raw.bpmTop5[i]));
        if (isFinite(n) && n >= 40 && n <= 240 && top.indexOf(n) < 0) top.push(n);
      }
    }
    if (top.length < 5) {
      var extra = base.bpmTop5 || bpmTop5(90);
      for (i = 0; i < extra.length && top.length < 5; i++) if (top.indexOf(extra[i]) < 0) top.push(extra[i]);
      for (var b = 50; top.length < 5; b += 4) if (top.indexOf(b) < 0) top.push(b);
    }
    top = top.slice(0, 5).sort(function (a, b) { return a - b; });
    var best = Math.round(Number(raw.bpm));
    if (!isFinite(best) || best < 40 || best > 240) best = Number(base.bpm) || top[2] || 80;
    return {
      source: raw.source || base.source || 'local',
      title: trim(raw.title) || base.title || '即兴作品',
      drumId: drum.id, drumName: drum.zh,
      rhythmId: rhythm.id, rhythmName: rhythm.zh,
      progressionId: prog.id, progressionName: prog.zh,
      bpm: Math.max(40, Math.min(240, best)),
      bpmTop5: top,
      reason: trim(raw.reason || raw.thinking || base.reason || ''),
      raw: raw
    };
  }

  function recommend(prompt, opts) {
    opts = opts || {};
    var text = trim(prompt);
    var local = localRecommend(text, opts);
    if (!LLM || !LLM.ready()) {
      return Promise.resolve({ ok: true, source: 'local', data: normalizeRec(local, local, opts), error: '' });
    }
    var messages = [
      { role: 'system', content: '你是吉他编曲助手。只输出一个 JSON 对象，不要 markdown、不要解释。' },
      { role: 'user', content:
        '用户想生成一段吉他 solo，提示词：' + text +
        '\n当前调：' + M.keyName(opts.keyPc || 0, opts.preferFlat) + ' ' +
        M.scaleInfo(opts.scaleId || 'major').label +
        '\n请根据场景/情绪，从下面曲库里推荐鼓机、节奏型、和弦走向，给出 1 个推荐速度 bpm，' +
        '再给出 5 个备选速度（BPM，升序）。' +
        '\n只能使用列表里的 id；输出：' +
        '{"title":"作品名","drumId":"...","rhythmId":"...","progressionId":"...",' +
        '"bpm":66,"bpmTop5":[60,64,68,72,76],"reason":"推荐理由，会显示给用户"}' +
        '\n\n' + candidateText()
      }
    ];
    return LLM.chat(messages, { maxTokens: 1200, temperature: 0.4, json: true }).then(function (r) {
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : '推荐请求失败');
      var raw = global.Improv && global.Improv.extractJson ? global.Improv.extractJson(r.content) : null;
      if (!raw) throw new Error('推荐结果不是合法 JSON');
      var data = normalizeRec(raw, local, opts);
      data.source = 'ai';
      data.raw = raw;
      return { ok: true, source: 'ai', data: data, error: '' };
    }).then(null, function (e) {
      return { ok: true, source: 'local', data: normalizeRec(local, local, opts), error: e.message || String(e) };
    });
  }

  function buildInstance(rec, bpm, opts) {
    opts = opts || {};
    var drum = drumById(rec.drumId) || Patterns.byId('pop');
    var rhythm = rhythmById(rec.rhythmId) || B.rhythmById('arp5321');
    var prog = progressionById(rec.progressionId) || B.progressionById('pop4');
    return {
      id: 'craft_inst_' + now(),
      name: rec.title || '作品伴奏',
      createdAt: now(),
      keyPc: opts.keyPc || 0,
      scaleId: opts.scaleId || 'major',
      bpm: Math.max(40, Math.min(240, Math.round(Number(bpm) || 80))),
      progression: B.cloneProgression(prog),
      rhythm: B.cloneRhythm(rhythm),
      drum: Patterns.clone(drum),
      swing: drum.swing === undefined ? 0.5 : drum.swing,
      register: opts.register || 'low'
    };
  }

  function scoreSource(meta, score) {
    var ts = now();
    var copy = clone(score);
    var firstId = 'v1';
    return {
      id: 'craft' + ts + '-' + Math.floor(Math.random() * 10000),
      title: meta.title || (score && score.title) || '即兴作品',
      prompt: meta.prompt || '',
      recommendation: meta.recommendation || null,
      chosen: meta.chosen || null,
      instance: clone(meta.instance),
      tone: meta.tone || 'electric',
      styleId: meta.styleId || (score && score.styleId) || 'penta',
      score: copy,
      versions: [{
        id: firstId, no: 1, label: '初版',
        note: meta.prompt || '初版生成',
        settings: settingsFrom(meta, score),
        score: clone(score), createdAt: ts,
        source: (score && score.source) || 'local'
      }],
      finalVersionId: firstId,
      messages: meta.messages || [],
      createdAt: ts,
      updatedAt: ts
    };
  }

  function saveFromScore(meta, score) {
    if (!score) return null;
    return save(scoreSource(meta || {}, score));
  }

  function addMessage(craft, role, text, versionId) {
    if (!craft) return null;
    if (!craft.messages) craft.messages = [];
    var item = { role: role, text: text, at: now() };
    if (versionId) item.versionId = versionId;
    craft.messages.push(item);
    return save(craft);
  }

  function scoreText(score) {
    var lines = [];
    for (var b = 0; b < score.bars.length; b++) lines.push('第 ' + (b + 1) + ' 小节：' +
      score.bars[b].slots.join(' '));
    return lines.join('\n');
  }

  /**
   * 后续会话修改：只返回合法的新谱面，保留原调/速度/走向。
   */
  function editScore(craft, text) {
    if (!LLM || !LLM.ready()) {
      return Promise.reject(new Error('还没有配置 API；请到右上角「设置」填写模型和 Key'));
    }
    var score = clone(craft.score);
    var messages = [
      { role: 'system', content: '你是吉他编曲助手。只输出一个 JSON 对象，不要 markdown、不要解释。' },
      { role: 'user', content:
        '这是一段已经生成的吉他 solo，按用户要求修改。\n' +
        '调：' + M.keyName(score.keyPc, score.preferFlat) + ' ' + M.scaleInfo(score.scaleId).label + '，' +
        score.bpm + ' BPM，每小节 8 个八分格。\n' +
        '当前简谱：\n' + scoreText(score) +
        '\n用户要求：' + text +
        '\n保留原调、BPM、和弦走向和整体结构，只做用户要求的修改；' +
        '输出 {"reply":"给用户的简短说明","bars":[{"slots":["1","0",...]}]}，' +
        'bars 数量必须等于 ' + score.bars.length + '，每小节 8 格。'
      }
    ];
    return LLM.chat(messages, { maxTokens: 3000, temperature: 0.35, json: true }).then(function (r) {
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : '修改请求失败');
      var raw = global.Improv.extractJson(r.content);
      if (!raw || !raw.bars || !raw.bars.length) throw new Error('模型没有返回可用谱面');
      var next = global.Improv.normalizeScore({
        title: score.title, keyPc: score.keyPc, scaleId: score.scaleId,
        styleId: score.styleId, bias: score.bias, rangeBias: score.rangeBias,
        bpm: score.bpm, preferFlat: score.preferFlat, bars: raw.bars,
        progression: score.progression, progressionName: score.progressionName,
        instanceId: score.instanceId, instanceName: score.instanceName,
        source: 'ai', createdAt: now()
      }, { bars: score.bars.length });
      var grid = score.progression
        ? global.Improv.progressionGrid(score.progression, score.keyPc, score.scaleId) : null;
      var repaired = global.Improv.repairScore(next, { grid: grid, bars: score.bars.length });
      var errs = global.Improv.validateScore(repaired.score);
      if (errs.length) throw new Error(errs.join('；'));
      return { reply: trim(raw.reply) || '已按你的要求修改。', score: repaired.score };
    });
  }

  global.Crafts = {
    list: all,
    get: get,
    save: save,
    remove: remove,
    recommend: recommend,
    localRecommend: localRecommend,
    buildInstance: buildInstance,
    saveFromScore: saveFromScore,
    ensureVersions: ensureVersions,
    addVersion: addVersion,
    versionById: versionById,
    finalVersion: finalVersion,
    addMessage: addMessage,
    editScore: editScore,
    bpmTop5: bpmTop5
  };
})(window);
