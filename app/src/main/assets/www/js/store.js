/*!
 * store.js —— 自建内容的持久化
 *
 * 两套后端，同一套接口：
 *   1. 安卓壳里：注入的 window.NativeStore（原生 SQLite，见 StoreDb.java）；
 *   2. 桌面浏览器预览/自动化测试：localStorage。
 * 所以「在电脑上改、在手机上也留着」这件事各管各的，但网页代码只写一遍。
 *
 * 存储内容（key 叫 kind）：
 *   progression  自建和弦走向        {id: {...}}
 *   rhythm       自建节奏型          {id: {...}}
 *   drums        鼓机格子的改动       {patternId: {hits, accents}}
 * 加上一批 settings（当前选中的走向/节奏型/鼓机节奏、BPM、音量…）。
 */
(function (global) {
  'use strict';

  var NATIVE = global.NativeStore || null;
  var LS_KEY = 'chord.store.v1';
  var cache = null;          /* 内存镜像：启动读一次，之后写穿 */

  function readAllLocal() {
    try {
      return JSON.parse(global.localStorage.getItem(LS_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function writeAllLocal(all) {
    try {
      global.localStorage.setItem(LS_KEY, JSON.stringify(all));
      return true;
    } catch (e) {
      return false;   /* 隐私模式/被禁用时静默降级：功能照用，只是不落盘 */
    }
  }

  function all() {
    if (cache) return cache;
    if (NATIVE) {
      try {
        cache = JSON.parse(NATIVE.loadAll() || '{}') || {};
      } catch (e) {
        cache = {};
      }
    } else {
      cache = readAllLocal();
    }
    return cache;
  }

  function bucket(kind) {
    var a = all();
    if (!a[kind]) a[kind] = {};
    return a[kind];
  }

  /* ---------- 自建内容 ---------- */
  function listItems(kind) {
    var b = bucket(kind), out = [];
    for (var id in b) if (b.hasOwnProperty(id)) out.push(b[id]);
    return out;
  }

  function putItem(kind, id, obj) {
    bucket(kind)[id] = obj;
    if (NATIVE) {
      try { NATIVE.putItem(kind, id, JSON.stringify(obj)); } catch (e) {}
    } else {
      writeAllLocal(all());
    }
    return obj;
  }

  function getItem(kind, id) {
    var b = bucket(kind);
    return b[id] === undefined ? null : b[id];
  }

  function removeItem(kind, id) {
    delete bucket(kind)[id];
    if (NATIVE) {
      try { NATIVE.removeItem(kind, id); } catch (e) {}
    } else {
      writeAllLocal(all());
    }
  }

  /* ---------- 偏好设置 ---------- */
  var settingsCache = null;

  function getSetting(k, def) {
    if (NATIVE) {
      try {
        var v = NATIVE.getSetting(k, null);
        return (v === null || v === undefined || v === '') ? def : v;
      } catch (e) {
        return def;
      }
    }
    if (!settingsCache) settingsCache = all().__settings || {};
    return (settingsCache[k] === undefined) ? def : settingsCache[k];
  }

  function setSetting(k, v) {
    if (NATIVE) {
      try { NATIVE.setSetting(k, String(v)); } catch (e) {}
    } else {
      var a = all();
      if (!a.__settings) a.__settings = {};
      a.__settings[k] = String(v);
      settingsCache = a.__settings;   /* 让读缓存和被写入的对象始终是同一个 */
      writeAllLocal(a);
    }
  }

  /* 强制重新读一次（测试用：模拟“重启应用”） */
  function reload() {
    cache = null;
    settingsCache = null;
  }

  function backend() {
    return NATIVE ? 'sqlite' : 'localStorage';
  }

  /* 给日志用：SQLite 后端会返回每个 kind 的条数 */
  function info() {
    if (NATIVE && NATIVE.info) {
      try { return NATIVE.info(); } catch (e) {}
    }
    var counts = [];
    var a = all();
    for (var k in a) if (a.hasOwnProperty(k) && k !== '__settings') {
      var n = 0;
      for (var id in a[k]) if (a[k].hasOwnProperty(id)) n++;
      counts.push(k + '=' + n);
    }
    return 'localStorage{' + (counts.length ? counts.join(', ') : '空') + '}';
  }

  global.Store = {
    backend: backend,
    listItems: listItems,
    getItem: getItem,
    putItem: putItem,
    removeItem: removeItem,
    getSetting: getSetting,
    setSetting: setSetting,
    reload: reload,
    info: info,
    available: function () { return !!NATIVE || (function () {
      try { global.localStorage.setItem('__t', '1'); global.localStorage.removeItem('__t'); return true; }
      catch (e) { return false; }
    })(); }
  };
})(window);
