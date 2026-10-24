/*!
 * pager.js —— 列表的「搜索 + 分页」小部件
 *
 * 节奏型、和弦走向、鼓机节奏、调式表这几类内容会越积越多（尤其自建的那些），
 * 一屏塞不下也不该一直往下滚。所以统一给它们套一个搜索框 + 分页条：
 *
 *   Pager.mount('rhythms', {
 *     hostId: 'rhythmTable',        // 挂到哪个容器里（挂一次，之后只刷新列表）
 *     placeholder: '搜索节奏型…',
 *     pageSize: 6,
 *     items: function () { ... },              // 取当前数据
 *     keywords: function (item) { ... },       // 参与搜索的文本
 *     render: function (listEl, slice) { ... } // 渲染一页
 *   });
 *   Pager.refresh('rhythms');       // 数据变了就刷一下
 *
 * 关键点：搜索框只创建一次，刷新只重画「列表 + 分页条」——
 * 否则每敲一个字都重建 input，输入框会丢焦点。
 */
(function (global) {
  'use strict';

  var pagers = {};

  function $(id) { return document.getElementById(id); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function filtered(p) {
    var all = p.cfg.items() || [];
    var q = p.st.q;
    if (!q) return all;
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var text = (p.cfg.keywords ? p.cfg.keywords(all[i]) : '') + '';
      if (text.toLowerCase().indexOf(q) >= 0) out.push(all[i]);
    }
    return out;
  }

  function render(id) {
    var p = pagers[id];
    if (!p) return;
    var arr = filtered(p);
    var size = p.cfg.pageSize || 6;
    var pages = Math.max(1, Math.ceil(arr.length / size));
    if (p.st.page >= pages) p.st.page = pages - 1;
    if (p.st.page < 0) p.st.page = 0;
    var start = p.st.page * size;
    var slice = arr.slice(start, start + size);

    clear(p.list);
    if (!slice.length) {
      var empty = document.createElement('div');
      empty.className = 'pager-empty';
      empty.textContent = p.st.q ? ('没有匹配「' + p.st.q + '」的内容') : '还没有内容';
      p.list.appendChild(empty);
    } else {
      p.cfg.render(p.list, slice, start);
    }

    /* 分页条：一页装得下就不显示 */
    clear(p.bar);
    if (pages > 1) {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'mini-toggle';
      prev.textContent = '◀';
      prev.setAttribute('data-page', String(p.st.page - 1));
      prev.disabled = (p.st.page === 0);
      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'mini-toggle';
      next.textContent = '▶';
      next.setAttribute('data-page', String(p.st.page + 1));
      next.disabled = (p.st.page >= pages - 1);
      var info = document.createElement('span');
      info.className = 'pager-info';
      info.textContent = '第 ' + (p.st.page + 1) + ' / ' + pages + ' 页 · 共 ' + arr.length + ' 条';
      p.bar.appendChild(prev);
      p.bar.appendChild(info);
      p.bar.appendChild(next);
    } else if (arr.length) {
      var only = document.createElement('span');
      only.className = 'pager-info';
      only.textContent = '共 ' + arr.length + ' 条';
      p.bar.appendChild(only);
    }
  }

  /**
   * 挂载（只挂一次）。重复调用只会更新配置，不会重建搜索框。
   */
  function mount(id, cfg) {
    if (pagers[id]) {
      pagers[id].cfg = cfg;
      render(id);
      return;
    }
    var host = $(cfg.hostId);
    if (!host) return;

    clear(host);
    var wrap = document.createElement('div');
    wrap.className = 'pager';

    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'pager-search';
    search.placeholder = cfg.placeholder || '搜索…';
    search.setAttribute('aria-label', cfg.placeholder || '搜索');

    var list = document.createElement('div');
    list.className = 'pager-list';

    var bar = document.createElement('div');
    bar.className = 'pager-bar';

    wrap.appendChild(search);
    wrap.appendChild(list);
    wrap.appendChild(bar);
    host.appendChild(wrap);

    var state = { q: '', page: 0 };
    pagers[id] = { cfg: cfg, st: state, list: list, bar: bar, search: search, host: host };

    search.addEventListener('input', function () {
      state.q = this.value.trim();
      state.page = 0;
      render(id);
    });
    bar.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute('data-page') === null) return;
      var page = Number(t.getAttribute('data-page'));
      var arr = filtered(pagers[id]);
      var size = cfg.pageSize || 6;
      var pages = Math.max(1, Math.ceil(arr.length / size));
      if (page < 0 || page >= pages) return;
      state.page = page;
      render(id);
      /* 翻页后把列表区域滚到可见处 */
      if (pagers[id].host && pagers[id].host.scrollIntoView) {
        try { pagers[id].host.scrollIntoView({ block: 'nearest' }); } catch (err) {}
      }
    });

    render(id);
  }

  /* 数据变了（新增/删除/改了名字）：保持搜索词与页码重新渲染 */
  function refresh(id) {
    if (!pagers[id]) return;
    render(id);
  }

  /* 让某一条内容出现在当前页（比如刚保存的自建项），并把搜索清空 */
  function showItem(id, match) {
    var p = pagers[id];
    if (!p) return;
    var all = p.cfg.items() || [];
    var idx = -1;
    for (var i = 0; i < all.length; i++) {
      if (match(all[i])) { idx = i; break; }
    }
    if (idx < 0) return;
    p.st.q = '';
    p.search.value = '';
    p.st.page = Math.floor(idx / (p.cfg.pageSize || 6));
    render(id);
  }

  function state(id) {
    return pagers[id] ? { q: pagers[id].st.q, page: pagers[id].st.page } : null;
  }

  global.Pager = {
    mount: mount,
    refresh: refresh,
    showItem: showItem,
    state: state
  };
})(window);
