/*!
 * llm.js —— 大模型客户端（OpenAI 兼容协议）
 *
 * 两套通道，同一套接口：
 *   1. 安卓壳：window.NativeHttp（原生异步 POST，绕开 file:// 的跨域限制）；
 *   2. 桌面浏览器：fetch（服务端允许跨域时可用，否则会给出明确提示）。
 *
 * 配置（厂商 / Base URL / 模型 / API Key）存在本地：安卓 SQLite、浏览器 localStorage。
 * 关键点：API Key 只存在本机，不会发到除你自己配置的服务端以外的任何地方。
 */
(function (global) {
  'use strict';

  var S = global.Store;

  var VENDORS = [
    { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-chat' },
    { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'custom', label: '自定义（OpenAI 兼容）', base: '', model: '' }
  ];

  var state = {
    vendor: 'deepseek',
    base: '',
    model: '',
    key: '',
    temperature: 0.8,
    maxTokens: 1200
  };

  var pending = {};        /* 原生非流式回调表：id -> resolve */
  var pendingStreams = {}; /* 原生流式回调表：id -> {onLines, done} */
  var seq = 0;

  /* 原生桥回调入口（HttpBridge 会调用它） */
  global.__httpDone = function (id, res) {
    var sp = pendingStreams[id];
    if (sp) {
      delete pendingStreams[id];
      sp.done(res);
      return;
    }
    var fn = pending[id];
    if (fn) {
      delete pending[id];
      fn(res);
    }
  };

  /* 原生流式桥：每一行 SSE 调用一次 */
  global.__httpChunk = function (id, line) {
    var sp = pendingStreams[id];
    if (sp && sp.onLines) sp.onLines(line);
  };

  function vendorById(id) {
    for (var i = 0; i < VENDORS.length; i++) if (VENDORS[i].id === id) return VENDORS[i];
    return VENDORS[0];
  }

  function load() {
    if (!S) return;
    state.vendor = S.getSetting('llm.vendor', 'deepseek');
    state.base = S.getSetting('llm.base', '');
    state.model = S.getSetting('llm.model', '');
    state.key = S.getSetting('llm.key', '');
    var t = Number(S.getSetting('llm.temperature', '0.8'));
    if (!isNaN(t)) state.temperature = t;
  }

  function save(cfg) {
    if (cfg) {
      if (cfg.vendor !== undefined) state.vendor = cfg.vendor;
      if (cfg.base !== undefined) state.base = cfg.base;
      if (cfg.model !== undefined) state.model = cfg.model;
      if (cfg.key !== undefined) state.key = cfg.key;
      if (cfg.temperature !== undefined) state.temperature = cfg.temperature;
    }
    if (!S) return;
    S.setSetting('llm.vendor', state.vendor);
    S.setSetting('llm.base', state.base);
    S.setSetting('llm.model', state.model);
    S.setSetting('llm.key', state.key);
    S.setSetting('llm.temperature', String(state.temperature));
  }

  /* 实际使用的地址/模型：自定义时用填入的，预设时用厂商默认 */
  function effective() {
    var v = vendorById(state.vendor);
    var base = (state.vendor === 'custom' ? state.base : (state.base || v.base)) || '';
    var model = state.model || v.model || '';
    base = base.replace(/\/+$/, '');
    return { base: base, model: model, key: state.key, vendor: v };
  }

  function endpoint() {
    var e = effective();
    if (!e.base) return '';
    /* 有的厂商 base 已经带 /v1，有的不带；这里统一补成 …/chat/completions */
    return e.base + '/chat/completions';
  }

  function ready() {
    var e = effective();
    return !!(e.base && e.model && e.key);
  }

  /* ---------- HTTP ---------- */
  function nativePost(url, headers, body) {
    return new Promise(function (resolve) {
      try {
        var id = global.NativeHttp.post(url, JSON.stringify(headers || {}), body);
        pending[id] = resolve;
      } catch (e) {
        resolve({ ok: false, status: 0, error: '原生请求失败：' + e.message });
      }
    });
  }

  function fetchPost(url, headers, body) {
    return fetch(url, { method: 'POST', headers: headers, body: body })
      .then(function (r) {
        return r.text().then(function (text) {
          return { ok: r.ok, status: r.status, body: text };
        });
      })['catch'](function (e) {
        return { ok: false, status: 0, error: '网络请求被拦截或不可达（' + e.message + '）。桌面浏览器里是跨域限制，请在手机上试。' };
      });
  }

  function postJson(url, headers, body) {
    if (global.NativeHttp) return nativePost(url, headers, body);
    if (typeof fetch === 'function') return fetchPost(url, headers, body);
    return Promise.resolve({ ok: false, status: 0, error: '当前环境既不支持原生请求也不支持 fetch' });
  }

  /**
   * 发一次对话请求
   * @returns {Promise<{ok:boolean, content?:string, error?:string, status?:number, ms?:number}>}
   */
  function chat(messages, opts) {
    opts = opts || {};
    var e = effective();
    if (!e.base) return Promise.resolve({ ok: false, error: '还没有填写 API 地址' });
    if (!e.model) return Promise.resolve({ ok: false, error: '还没有填写模型名称' });
    if (!e.key) return Promise.resolve({ ok: false, error: '还没有填写 API Key' });

    var body = {
      model: e.model,
      messages: messages,
      temperature: (opts.temperature === undefined) ? state.temperature : opts.temperature,
      max_tokens: opts.maxTokens || state.maxTokens,
      stream: false
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    var url = endpoint();
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + e.key };
    var t0 = (new Date()).getTime();

    return postJson(url, headers, JSON.stringify(body)).then(function (res) {
      var ms = (new Date()).getTime() - t0;
      if (res.error) return { ok: false, error: res.error, ms: ms };
      var status = res.status || 0;
      var text = res.body || '';
      if (!res.ok) {
        var brief = text.slice(0, 200);
        var hint = '';
        if (status === 401) hint = '（API Key 不对或已失效）';
        else if (status === 403) hint = '（没有权限 / 余额不足）';
        else if (status === 404) hint = '（地址或模型名不对）';
        else if (status === 429) hint = '（请求太频繁或额度用尽）';
        return { ok: false, status: status, error: 'HTTP ' + status + hint + '：' + brief, ms: ms };
      }
      var data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        return { ok: false, status: status, error: '返回的不是 JSON：' + text.slice(0, 200), ms: ms };
      }
      var content = '';
      try {
        content = data.choices[0].message.content || '';
      } catch (err) {
        return { ok: false, status: status, error: '返回结构里没有 choices[0].message.content', ms: ms };
      }
      return {
        ok: true,
        content: content,
        ms: ms,
        status: status,
        model: data.model || e.model,
        usage: data.usage || null
      };
    });
  }

  /* ---------- 流式（SSE） ---------- */
  function statusHint(status) {
    if (status === 401) return '（API Key 不对或已失效）';
    if (status === 403) return '（没有权限 / 余额不足）';
    if (status === 404) return '（地址或模型名不对）';
    if (status === 429) return '（请求太频繁或额度用尽）';
    return '';
  }

  function sseLine(line, acc, onEvent) {
    var s = String(line || '').replace(/^\s+|\s+$/g, '');
    if (!s || s.charAt(0) === ':') return;
    if (s.indexOf('data:') === 0) s = s.slice(5).replace(/^\s+/, '');
    if (s === '[DONE]') { acc.done = true; return; }
    var obj;
    try { obj = JSON.parse(s); } catch (e) { return; }
    if (obj.model) acc.model = obj.model;
    if (obj.usage) acc.usage = obj.usage;
    var choice = obj.choices && obj.choices[0];
    var d = choice && (choice.delta || choice.message);
    if (!d) return;
    var reasoning = d.reasoning_content || d.reasoning;
    if (reasoning) {
      acc.reasoning += reasoning;
      if (onEvent) { try { onEvent({ type: 'reasoning', text: reasoning }); } catch (e) {} }
    }
    if (d.content) {
      acc.content += d.content;
      if (onEvent) { try { onEvent({ type: 'content', text: d.content }); } catch (e) {} }
    }
  }

  function nativeStream(url, headers, body, onEvent, e, t0) {
    return new Promise(function (resolve) {
      var id;
      try {
        id = global.NativeHttp.streamPost(url, JSON.stringify(headers || {}), JSON.stringify(body));
      } catch (err) {
        resolve({ ok: false, status: 0, error: '原生流式请求失败：' + err.message, ms: 0 });
        return;
      }
      var acc = { content: '', reasoning: '', usage: null, model: '', done: false };
      var finished = false;
      var timer = setTimeout(function () {
        if (finished) return;
        finished = true;
        try { global.NativeHttp.cancel(id); } catch (err) {}
        delete pendingStreams[id];
        resolve({ ok: false, status: 0, error: '流式请求超时（125 秒）', ms: (new Date()).getTime() - t0 });
      }, 125000);

      function finish(res) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        delete pendingStreams[id];
        resolve(res);
      }

      pendingStreams[id] = {
        onLines: function (batch) {
          var lines = String(batch || '').split('\n');
          for (var i = 0; i < lines.length; i++) sseLine(lines[i], acc, onEvent);
        },
        done: function (res) {
          var ms = (new Date()).getTime() - t0;
          var status = res && res.status ? res.status : 0;
          if (!res || !res.ok) {
            var text = (res && res.body) || (res && res.error) || '';
            finish({
              ok: false, status: status, ms: ms,
              error: status ? ('HTTP ' + status + statusHint(status) + '：' + String(text).slice(0, 240))
                            : (String(text) || '流式请求失败')
            });
            return;
          }
          if (!acc.content) {
            finish({ ok: false, status: status, ms: ms, error: '模型流式返回为空（可能是服务端不支持 stream）' });
            return;
          }
          finish({
            ok: true, status: status, ms: ms,
            content: acc.content, reasoning: acc.reasoning,
            usage: acc.usage, model: acc.model || e.model
          });
        }
      };
    });
  }

  function fetchStream(url, headers, body, onEvent, e, t0) {
    return fetch(url, {
      method: 'POST', headers: headers, body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (text) {
          return {
            ok: false, status: r.status, ms: (new Date()).getTime() - t0,
            error: 'HTTP ' + r.status + statusHint(r.status) + '：' + text.slice(0, 240)
          };
        });
      }
      if (!r.body || !r.body.getReader || !global.TextDecoder) return null;
      var reader = r.body.getReader();
      var decoder = new global.TextDecoder('utf-8');
      var acc = { content: '', reasoning: '', usage: null, model: '', done: false };
      var buf = '';
      function pump() {
        return reader.read().then(function (rd) {
          if (rd.done) {
            if (buf) sseLine(buf, acc, onEvent);
            if (!acc.content) {
              return { ok: false, status: r.status, ms: (new Date()).getTime() - t0,
                error: '模型流式返回为空（可能是服务端不支持 stream）' };
            }
            return {
              ok: true, status: r.status, ms: (new Date()).getTime() - t0,
              content: acc.content, reasoning: acc.reasoning,
              usage: acc.usage, model: acc.model || e.model
            };
          }
          buf += decoder.decode(rd.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            sseLine(buf.slice(0, idx), acc, onEvent);
            buf = buf.slice(idx + 1);
          }
          return pump();
        });
      }
      return pump();
    }, function (err) {
      return {
        ok: false, status: 0, ms: (new Date()).getTime() - t0,
        error: '网络请求被拦截或不可达（' + err.message + '）。桌面 file:// 预览请用真机或本地服务。'
      };
    });
  }

  /**
   * 流式对话：边收边把 reasoning/content 片段交给 onEvent
   * @param {function} onEvent ({type:'reasoning'|'content', text})
   * @returns {Promise<{ok,content,reasoning,error,usage,model,ms}>}
   */
  function streamChat(messages, opts, onEvent) {
    opts = opts || {};
    var e = effective();
    if (!e.base) return Promise.resolve({ ok: false, error: '还没有填写 API 地址' });
    if (!e.model) return Promise.resolve({ ok: false, error: '还没有填写模型名称' });
    if (!e.key) return Promise.resolve({ ok: false, error: '还没有填写 API Key' });

    var body = {
      model: e.model,
      messages: messages,
      temperature: (opts.temperature === undefined) ? state.temperature : opts.temperature,
      max_tokens: opts.maxTokens || state.maxTokens,
      stream: true
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    var url = endpoint();
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + e.key };
    var t0 = (new Date()).getTime();

    function fallback(reason) {
      if (onEvent) { try { onEvent({ type: 'info', text: '流式不可用，已回退整段返回：' + reason }); } catch (err) {} }
      return chat(messages, opts).then(function (r) {
        if (r.ok && onEvent && r.content) {
          try { onEvent({ type: 'content', text: r.content }); } catch (err) {}
        }
        return r;
      });
    }

    if (global.NativeHttp && global.NativeHttp.streamPost) {
      return nativeStream(url, headers, body, onEvent, e, t0);
    }
    if (typeof fetch === 'function') {
      return fetchStream(url, headers, body, onEvent, e, t0).then(function (r) {
        return r === null ? fallback('浏览器不支持 ReadableStream') : r;
      });
    }
    return fallback('当前环境不支持流式');
  }

  /* 连接测试：一条极小请求，确认地址 / Key / 模型都对 */
  function test() {
    return chat([
      { role: 'system', content: '你是一个连接测试助手，只回答 JSON。' },
      { role: 'user', content: '只输出这个 JSON，不要多余文字：{"ok":true,"note":"连接成功"}' }
    ], { temperature: 0, maxTokens: 60, json: true }).then(function (r) {
      if (!r.ok) return r;
      var said = (r.content || '').trim();
      return {
        ok: true,
        ms: r.ms,
        model: r.model,
        usage: r.usage,
        content: said.slice(0, 120)
      };
    });
  }

  load();

  global.LLM = {
    VENDORS: VENDORS,
    vendorById: vendorById,
    state: state,
    load: load,
    save: save,
    effective: effective,
    endpoint: endpoint,
    ready: ready,
    chat: chat,
    streamChat: streamChat,
    test: test,
    hasNative: function () { return !!global.NativeHttp; }
  };
})(window);
