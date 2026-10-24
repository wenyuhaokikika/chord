/*!
 * agentqueue.js —— 即兴任务队列
 *
 * 为什么单独抽一层：
 *   一次「即兴」其实是 4 次模型请求 + 校验的长时间任务，不应该在点击事件里直接跑，
 *   也不应该因为用户连点两次就并发发请求。这里做成 FIFO：
 *     - 任务有 queued / running / done / failed / cancelled 状态；
 *     - 同时只跑一个，后面的排队；
 *     - 运行中把每一步、每一段流式输出写进 task，界面订阅后边跑边显示；
 *     - 完成后把结果（简谱）交给界面渲染，再继续下一个。
 *
 * 任务本身不直接碰 DOM/音频；具体 runner 由 improvui 注册。
 */
(function (global) {
  'use strict';

  var tasks = [];
  var running = null;
  var seq = 0;
  var runners = {};
  var listeners = [];
  var onChange = null;

  function now() { return (new Date()).getTime(); }
  function clone(o) {
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
  }

  function notify(type, task) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](type, task); } catch (e) {}
    }
    if (onChange) {
      try { onChange(type, task); } catch (e) {}
    }
  }

  function find(id) {
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return tasks[i];
    return null;
  }

  function enqueue(spec) {
    spec = spec || {};
    var t = {
      id: 'task' + now() + '-' + (++seq),
      kind: spec.kind || 'improv',
      title: spec.title || '即兴任务',
      mode: spec.mode || 'ai',
      autoPlay: spec.autoPlay === true,
      opts: spec.opts ? clone(spec.opts) : {},
      status: 'queued',
      createdAt: now(),
      startedAt: 0,
      finishedAt: 0,
      steps: [],
      stream: '',
      streamAgent: '',
      error: '',
      result: null,
      _abort: null
    };
    tasks.push(t);
    notify('enqueue', t);
    pump();
    return t;
  }

  function appendStream(t, ev) {
    if (!ev) return;
    var text = String(ev.text || '');
    if (!text) return;
    if (ev.agent && ev.agent !== t.streamAgent) {
      t.stream += (t.stream ? '\n\n' : '') + '【' + ev.agent + '】\n';
      t.streamAgent = ev.agent;
    }
    if (ev.type === 'info') {
      t.stream += '· ' + text + '\n';
    } else {
      t.stream += text;
    }
    if (t.stream.length > 24000) {
      t.stream = '…（前文省略）…\n' + t.stream.slice(-18000);
    }
  }

  function finish(t, ok, result, error) {
    if (t.status === 'cancelled') {
      t.finishedAt = now();
    } else if (ok) {
      t.status = 'done';
      t.result = result || null;
      t.finishedAt = now();
    } else {
      t.status = 'failed';
      t.error = error || '任务失败';
      t.result = result || null;
      t.finishedAt = now();
    }
    var evt = t.status === 'done' ? 'done' : (t.status === 'cancelled' ? 'cancelled' : 'failed');
    if (running === t) running = null;
    notify(evt, t);
    pump();
  }

  function pump() {
    if (running) return;
    var t = null;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].status === 'queued') { t = tasks[i]; break; }
    }
    if (!t) return;
    running = t;
    t.status = 'running';
    t.startedAt = now();
    t.steps = [];
    t.stream = '';
    t.streamAgent = '';
    notify('start', t);

    var ctx = {
      step: function (step) {
        if (!step) return;
        t.steps[step.index] = step;
        notify('step', t);
      },
      stream: function (ev) {
        appendStream(t, ev);
        notify('stream', t);
      },
      isCancelled: function () { return t.status === 'cancelled'; },
      setAbort: function (fn) { t._abort = fn; }
    };

    var fn = runners[t.kind];
    if (!fn) {
      finish(t, false, null, '没有注册任务类型：' + t.kind);
      return;
    }
    function handleResult(res) {
      if (t.status === 'cancelled') {
        finish(t, false, res, '已取消');
        return;
      }
      if (res && res.ok) finish(t, true, res, '');
      else finish(t, false, res, (res && res.error) || '任务失败');
    }

    var p;
    try {
      p = fn(t, ctx);
    } catch (e) {
      finish(t, false, null, (e && e.message) || String(e));
      return;
    }
    /* 本地规则作曲是同步的：直接完成；AI 任务返回 Promise，走异步路径 */
    if (p && typeof p.then === 'function') {
      p.then(handleResult, function (e) {
        finish(t, false, null, (e && e.message) || String(e));
      });
    } else {
      handleResult(p);
    }
  }

  function cancel(id) {
    var t = find(id);
    if (!t) return false;
    if (t.status === 'queued') {
      t.status = 'cancelled';
      t.error = '已取消';
      t.finishedAt = now();
      notify('cancelled', t);
      return true;
    }
    if (t.status === 'running') {
      t.status = 'cancelled';
      t.error = '已取消（当前请求返回后丢弃）';
      if (t._abort) { try { t._abort(); } catch (e) {} }
      notify('cancelled', t);
      return true;
    }
    return false;
  }

  function retry(id) {
    var t = find(id);
    if (!t) return null;
    return enqueue({
      kind: t.kind, title: t.title, mode: t.mode,
      autoPlay: t.autoPlay, opts: t.opts
    });
  }

  function clearDone() {
    var out = [];
    for (var i = 0; i < tasks.length; i++) {
      var s = tasks[i].status;
      if (s !== 'done' && s !== 'failed' && s !== 'cancelled') out.push(tasks[i]);
    }
    tasks = out;
    notify('clear', null);
  }

  function setAutoPlay(id, on) {
    var t = find(id);
    if (!t) return false;
    t.autoPlay = !!on;
    notify('update', t);
    return true;
  }

  function pendingTask(kind) {
    for (var i = 0; i < tasks.length; i++) {
      if ((!kind || tasks[i].kind === kind) &&
          (tasks[i].status === 'queued' || tasks[i].status === 'running')) return tasks[i];
    }
    return null;
  }

  function pendingCount(kind) {
    var n = 0;
    for (var i = 0; i < tasks.length; i++) {
      if ((!kind || tasks[i].kind === kind) &&
          (tasks[i].status === 'queued' || tasks[i].status === 'running')) n++;
    }
    return n;
  }

  global.AgentQueue = {
    init: function (cfg) {
      cfg = cfg || {};
      onChange = cfg.onChange || null;
    },
    register: function (kind, fn) { runners[kind] = fn; },
    subscribe: function (fn) { if (fn) listeners.push(fn); },
    enqueue: enqueue,
    cancel: cancel,
    retry: retry,
    clearDone: clearDone,
    setAutoPlay: setAutoPlay,
    pendingTask: pendingTask,
    pendingCount: pendingCount,
    find: find,
    tasks: function () { return tasks.slice(0); },
    running: function () { return running; },
    isRunning: function () { return !!running; },
    statusText: function () {
      if (running) return '运行中：' + running.title + '（排队 ' + Math.max(0, pendingCount() - 1) + '）';
      if (pendingCount()) return '排队 ' + pendingCount() + ' 个任务';
      return '空闲';
    }
  };
})(window);
