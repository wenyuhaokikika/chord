package com.chord.helper;

import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 原生 HTTP 桥：window.NativeHttp.post(url, headersJson, body) -> 回调 id
 *
 * 为什么不让网页直接 fetch：
 *   页面跑在 file:///android_asset 下，调用 https 接口属于跨域，会先撞 CORS；
 *   而且 file:// 的 Origin 是 null，绝大多数服务端不会放行。走原生发请求就没有这个问题。
 *
 * 为什么是异步的：addJavascriptInterface 的方法跑在 JavaBridge 线程，但 JS 调用它是同步等待的，
 * 一次 5 秒的模型请求会把整个 JS 线程（也就是界面）卡住。所以这里立刻返回一个 id，
 * 请求完成后用 evaluateJavascript 回调 window.__httpDone(id, result)。
 *
 * 注意：只在用户自己配置了模型 API 之后才会用到它；本地功能（和弦/调音/鼓机/伴奏）完全离线。
 */
public class HttpBridge {

    private static final String TAG = "ChordHelper";
    private static final int CONNECT_TIMEOUT = 15000;
    private static final int READ_TIMEOUT = 90000;      /* 大模型偶尔会慢，给足时间 */
    private static final int MAX_BYTES = 2 * 1024 * 1024;

    private final WebView webView;
    private final ExecutorService pool = Executors.newFixedThreadPool(2);
    private final AtomicInteger seq = new AtomicInteger(0);
    /* 流式请求用：记录活动连接，取消时能直接 disconnect */
    private final Map<String, HttpURLConnection> active = new ConcurrentHashMap<String, HttpURLConnection>();
    private final Set<String> cancelled = Collections.synchronizedSet(new HashSet<String>());

    public HttpBridge(WebView webView) {
        this.webView = webView;
    }

    /** @return 回调 id（JS 侧拿它等结果） */
    @JavascriptInterface
    public String post(final String url, final String headersJson, final String body) {
        final String id = "c" + seq.incrementAndGet();
        Log.i(TAG, "http post " + url + " (" + (body == null ? 0 : body.length()) + " bytes) id=" + id);
        pool.execute(new Runnable() {
            @Override
            public void run() {
                String result = doPost(url, headersJson, body);
                deliver(id, result);
            }
        });
        return id;
    }

    /**
     * 流式 POST（SSE）：请求发出后逐行回调 window.__httpChunk(id, line)，
     * 结束时再回调 window.__httpDone(id, {ok,status,body})。
     * 这样前端可以边收边显示 agent 的思考/输出，而不是等整段 JSON 回来。
     *
     * @return 回调 id
     */
    @JavascriptInterface
    public String streamPost(final String url, final String headersJson, final String body) {
        final String id = "s" + seq.incrementAndGet();
        Log.i(TAG, "http stream " + url + " (" + (body == null ? 0 : body.length()) + " bytes) id=" + id);
        pool.execute(new Runnable() {
            @Override
            public void run() {
                doStream(id, url, headersJson, body);
            }
        });
        return id;
    }

    /** 取消一个流式请求（排队任务被用户取消时用） */
    @JavascriptInterface
    public void cancel(final String id) {
        cancelled.add(id);
        HttpURLConnection conn = active.get(id);
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Exception ignore) {
            }
        }
    }

    private void doStream(final String id, String urlStr, String headersJson, String body) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            if (!"https".equalsIgnoreCase(url.getProtocol()) && !"http".equalsIgnoreCase(url.getProtocol())) {
                deliver(id, result(false, 0, "只支持 http/https 地址"));
                return;
            }
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(CONNECT_TIMEOUT);
            conn.setReadTimeout(120000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "text/event-stream");

            if (headersJson != null && headersJson.length() > 0) {
                JSONObject h = new JSONObject(headersJson);
                Iterator<String> it = h.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    try {
                        conn.setRequestProperty(k, h.optString(k, ""));
                    } catch (Exception ignore) {
                    }
                }
            }

            byte[] data = (body == null ? "" : body).getBytes("UTF-8");
            OutputStream os = conn.getOutputStream();
            os.write(data);
            os.flush();
            os.close();

            active.put(id, conn);
            if (cancelled.contains(id)) {
                deliver(id, result(false, 0, "已取消"));
                return;
            }

            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                String text = readAll(conn.getErrorStream());
                deliver(id, result(false, status, text));
                return;
            }

            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
            String line;
            int total = 0;
            while ((line = br.readLine()) != null) {
                if (cancelled.contains(id)) break;
                total += line.length() + 1;
                if (total > MAX_BYTES) break;
                deliverChunk(id, line);
            }
            if (cancelled.contains(id)) deliver(id, result(false, 0, "已取消"));
            else deliver(id, result(true, status, ""));

        } catch (Exception e) {
            Log.w(TAG, "http stream 失败: " + e.getClass().getSimpleName() + " " + e.getMessage());
            deliver(id, result(false, 0, e.getClass().getSimpleName() + ": " + e.getMessage()));
        } finally {
            active.remove(id);
            cancelled.remove(id);
            if (conn != null) conn.disconnect();
        }
    }

    private void deliverChunk(final String id, final String line) {
        if (webView == null || cancelled.contains(id)) return;
        final String js = "(function(){try{if(window.__httpChunk)window.__httpChunk(" +
            JSONObject.quote(id) + "," + JSONObject.quote(line) + ");}catch(e){}})()";
        webView.post(new Runnable() {
            @Override
            public void run() {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                    webView.evaluateJavascript(js, null);
                } else {
                    webView.loadUrl("javascript:" + js);
                }
            }
        });
    }

    private static String result(boolean ok, int status, String text) {
        try {
            JSONObject out = new JSONObject();
            out.put("ok", ok);
            out.put("status", status);
            out.put("body", text == null ? "" : text);
            return out.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"status\":0,\"body\":\"unknown\"}";
        }
    }

    private void deliver(final String id, final String json) {
        if (webView == null) return;
        final String js = "(function(){try{if(window.__httpDone)window.__httpDone(" + JSONObject.quote(id) + "," + json + ");}catch(e){}})()";
        webView.post(new Runnable() {
            @Override
            public void run() {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                    webView.evaluateJavascript(js, null);
                } else {
                    webView.loadUrl("javascript:" + js);
                }
            }
        });
    }

    private String doPost(String urlStr, String headersJson, String body) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            if (!"https".equalsIgnoreCase(url.getProtocol()) && !"http".equalsIgnoreCase(url.getProtocol())) {
                return fail("只支持 http/https 地址");
            }
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(CONNECT_TIMEOUT);
            conn.setReadTimeout(READ_TIMEOUT);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");

            if (headersJson != null && headersJson.length() > 0) {
                JSONObject h = new JSONObject(headersJson);
                Iterator<String> it = h.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    String v = h.optString(k, "");
                    try {
                        conn.setRequestProperty(k, v);
                    } catch (Exception ignore) {
                        Log.w(TAG, "忽略非法 header: " + k);
                    }
                }
            }

            byte[] data = (body == null ? "" : body).getBytes("UTF-8");
            OutputStream os = conn.getOutputStream();
            os.write(data);
            os.flush();
            os.close();

            int status = conn.getResponseCode();
            InputStream is = (status >= 200 && status < 300) ? conn.getInputStream() : conn.getErrorStream();
            String text = readAll(is);

            JSONObject out = new JSONObject();
            out.put("ok", status >= 200 && status < 300);
            out.put("status", status);
            out.put("body", text);
            return out.toString();

        } catch (Exception e) {
            Log.w(TAG, "http 请求失败: " + e.getClass().getSimpleName() + " " + e.getMessage());
            return fail(e.getClass().getSimpleName() + ": " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n, total = 0;
        while ((n = is.read(buf)) > 0) {
            total += n;
            if (total > MAX_BYTES) break;
            bos.write(buf, 0, n);
        }
        is.close();
        return new String(bos.toByteArray(), "UTF-8");
    }

    private static String fail(String msg) {
        try {
            JSONObject out = new JSONObject();
            out.put("ok", false);
            out.put("status", 0);
            out.put("error", msg == null ? "unknown" : msg);
            return out.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"status\":0,\"error\":\"unknown\"}";
        }
    }
}
