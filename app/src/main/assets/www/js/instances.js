/*!
 * instances.js —— 伴奏实例：鼓机 + 和弦走向 + 节奏型 + 调式/速度 的快照
 *
 * 为什么单独抽：
 *   伴奏页的“当前选择”是活的（换走向、改格子会立刻生效），
 *   而即兴页需要一份固定不变的素材，才能反复生成/对比 solo。
 *   实例就是保存那一刻的完整快照，存进 SQLite（kind = instance）。
 */
(function (global) {
  'use strict';

  var S = global.Store, B = global.Backing;

  function now() { return (new Date()).getTime(); }
  function clone(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
  }

  function list() {
    if (!S) return [];
    var out = S.listItems('instance');
    out.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return out;
  }

  function get(id) {
    if (!S) return null;
    return S.getItem('instance', id);
  }

  function save(inst) {
    if (!S || !inst || !inst.id) return null;
    S.putItem('instance', inst.id, inst);
    return inst;
  }

  function remove(id) {
    if (S) S.removeItem('instance', id);
  }

  function defaultName() {
    return '伴奏实例 ' + (list().length + 1);
  }

  /* 把伴奏页当前状态（鼓机格子/走向/节奏型/调式/BPM）冻结成实例 */
  function captureCurrent(name) {
    if (!global.BackingUI || !global.DrumsUI || !global.CHORD_STATE) return null;
    var st = global.CHORD_STATE;
    var prog = global.BackingUI.currentProgression();
    var rhythm = global.BackingUI.currentRhythm();
    var drum = global.DrumsUI.currentPattern();
    if (!prog || !rhythm || !drum) return null;
    return {
      id: 'inst' + now() + '-' + Math.floor(Math.random() * 1000),
      name: name || defaultName(),
      createdAt: now(),
      keyPc: st.keyPc,
      scaleId: st.scaleId,
      bpm: (global.Band && global.Band.state.bpm) || 100,
      progression: B.cloneProgression(prog),
      rhythm: B.cloneRhythm(rhythm),
      drum: clone(drum),
      swing: (global.DrumsUI.state && global.DrumsUI.state.swing) || 0.5,
      register: (global.ImprovUI && global.ImprovUI.state.register) || 'low'
    };
  }

  function captureAndSave(name) {
    var inst = captureCurrent(name);
    return inst ? save(inst) : null;
  }

  global.Instances = {
    clone: clone,
    list: list,
    get: get,
    save: save,
    remove: remove,
    count: function () { return list().length; },
    defaultName: defaultName,
    captureCurrent: captureCurrent,
    captureAndSave: captureAndSave
  };
})(window);
