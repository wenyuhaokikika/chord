package com.chord.helper;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 和弦助手：整个 UI 由 assets/www 下的 HTML/CSS/JS 提供，
 * 原生这一层只负责承载 WebView 并把系统栏配色跟页面统一。
 * 之所以这么设计：调音/指板这类 2D 绘制用 SVG 表达最直接，
 * 改一行代码就能看到效果，也方便在桌面浏览器里调试。
 */
public class MainActivity extends Activity {

    private static final String TAG = "ChordHelper";
    private static final String PAGE = "file:///android_asset/www/index.html";
    private static final int BG_DARK = 0xFF0F1115;
    private static final int BG_LIGHT = 0xFFF4F5F8;

    private WebView webView;
    private StoreDb store;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        boolean night = isNightMode();
        int bg = night ? BG_DARK : BG_LIGHT;
        applyThemeColors();

        /* 自建内容（和弦走向、节奏型、鼓机格子改动）存在本地 SQLite 里 */
        store = new StoreDb(this);
        Log.i(TAG, "存储后端 " + store.info());

        try {
            webView = new WebView(this);
        } catch (Throwable t) {
            /* 极少数设备没有可用的 WebView 内核 */
            showFallback();
            return;
        }

        webView.setBackgroundColor(bg);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setLongClickable(false);
        webView.setHapticFeedbackEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }

        /* 页面内部不做跳转，所有链接都在本 WebView 内保持 */
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Log.i(TAG, "onPageStarted: " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "onPageFinished: " + url);
                probeDom(view);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                Log.e(TAG, "onReceivedError: " + request.getUrl() + " -> " + error.getDescription());
            }
        });

        /* 调音要用麦克风：网页里调 getUserMedia 时会走到这里，
           原生这层负责先拿到系统的 RECORD_AUDIO 权限，再把资源授权给 WebView。 */
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                Log.i(TAG, "onPermissionRequest: " + java.util.Arrays.toString(request.getResources()));
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() { grantWebPermission(request); }
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                Log.i(TAG, "onPermissionRequestCanceled");
                pendingRequest = null;
            }

            /** 把网页里的 console 输出转发到 logcat：真机上排查问题很方便
             *  adb logcat -s ChordHelper  */
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                Log.i(TAG + "/console", cm.message() + "  @" + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }

            /** 「即兴」里上传简谱图片：网页的 <input type="file"> 会走到这里，
             *  由系统文件选择器挑一张图，再把 Uri 交回给 WebView。 */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE);
                    return true;
                } catch (Exception e) {
                    Log.w(TAG, "文件选择器启动失败: " + e.getMessage());
                    filePathCallback = null;
                    return false;
                }
            }
        });

        /* 暴露给网页：window.NativeStore（方法在 JavaBridge 线程执行，可直接访问数据库） */
        webView.addJavascriptInterface(new StoreDb.Bridge(store), "NativeStore");
        /* 暴露给网页：window.NativeHttp（异步 POST，绕开 file:// 的跨域限制，见 HttpBridge） */
        webView.addJavascriptInterface(new HttpBridge(webView), "NativeHttp");

        setContentView(webView);
        /* 支持从命令行/其它应用直达某个状态，方便测试与分享：
           adb shell am start -n com.chord.helper/.MainActivity --es hash "tab=tuner&mode=dorian"
           （对应网页里的 #tab=tuner&mode=dorian） */
        String hash = getIntent() != null ? getIntent().getStringExtra("hash") : null;
        String url = (hash == null || hash.length() == 0) ? PAGE : (PAGE + "#" + hash);
        webView.loadUrl(url);
        Log.i(TAG, "loadUrl " + url + " (night=" + night + ", sdk=" + Build.VERSION.SDK_INT + ")");
    }

    /* ------------------------------------------------------------------
     * 麦克风权限：先系统权限，再 WebView 授权。API 21/22 是安装即授权，
     * API 23+ 需要运行时申请，所以这里分两条路走。
     * ------------------------------------------------------------------ */
    private PermissionRequest pendingRequest;

    private void grantWebPermission(PermissionRequest request) {
        boolean wantsAudio = false;
        String[] res = request.getResources();
        for (int i = 0; res != null && i < res.length; i++) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res[i])) wantsAudio = true;
        }
        if (!wantsAudio) {
            /* 只处理录音，其它资源一律拒绝 */
            request.deny();
            return;
        }
        if (hasAudioPermission()) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            Log.i(TAG, "granted RECORD_AUDIO to WebView");
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingRequest = request;
            requestPermissions(new String[]{"android.permission.RECORD_AUDIO"}, REQ_AUDIO);
        } else {
            request.deny();
        }
    }

    private boolean hasAudioPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return checkSelfPermission("android.permission.RECORD_AUDIO") == PackageManager.PERMISSION_GRANTED;
    }

    private static final int REQ_AUDIO = 1001;
    private static final int REQ_FILE = 1002;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_AUDIO || pendingRequest == null) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        Log.i(TAG, "onRequestPermissionsResult RECORD_AUDIO granted=" + granted);
        if (granted) {
            pendingRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingRequest.deny();
            Toast.makeText(this, R.string.mic_denied, Toast.LENGTH_LONG).show();
        }
        pendingRequest = null;
    }

    /** 加载完成后回读一次 DOM 关键状态，方便在真机日志里定位“白屏”这类问题 */
    private void probeDom(WebView view) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) return;
        final String js = "(function(){try{return JSON.stringify({" +
                "title:document.title," +
                "children:document.body?document.body.children.length:-1," +
                "cards:document.querySelectorAll('.card').length," +
                "chord:(document.getElementById('chordName')||{}).textContent," +
                "tab:(window.CHORD_STATE||{}).tab," +
                "mode:(window.CHORD_STATE||{}).scaleId," +
                "tones:document.querySelectorAll('.tone-chip').length," +
                "modes:document.querySelectorAll('.mode-row').length," +
                "scaleDots:document.querySelectorAll('#scaleBox .nk-scale-dot, #scaleBox .nk-scale-root').length," +
                "patterns:document.querySelectorAll('.pattern-row').length," +
                "drumCells:document.querySelectorAll('.step-cell').length," +
                "drumPlaying:(window.DrumsUI&&window.DrumsUI.isPlaying)?window.DrumsUI.isPlaying():null," +
                "drumBpm:(window.DrumsUI&&window.DrumsUI.state)?window.DrumsUI.state.bpm:null," +
                "improvOn:(window.Band&&window.Band.state)?window.Band.state.improvOn:null," +
                "improvBars:document.querySelectorAll('.jp-bar').length," +
                "improvCells:document.querySelectorAll('.jp-cell').length," +
                "scoreCount:(window.Improv&&window.Improv.listScores)?window.Improv.listScores().length:null," +
                "tabCount:(window.Improv&&window.Improv.listTabs)?window.Improv.listTabs().length:null," +
                "queueCount:(window.AgentQueue&&window.AgentQueue.tasks)?window.AgentQueue.tasks().length:null," +
                "queueRunning:(window.AgentQueue&&window.AgentQueue.isRunning)?window.AgentQueue.isRunning():null," +
                "instances:(window.Instances&&window.Instances.count)?window.Instances.count():null," +
                "melodyDots:(function(){var e=document.getElementById('melodyNeck');return e?e.querySelectorAll('.mn-dot-used,.mn-dot-current').length:0;})()" + "," +
                "rhythmDots:(function(){var e=document.getElementById('rhythmNeck');return e?e.querySelectorAll('.mn-dot-chord').length:0;})()" + "," +
                "streamChars:(function(){var e=document.getElementById('queueStream');return e?e.textContent.length:0;})()" + "," +
                "bg:document.body?getComputedStyle(document.body).backgroundColor:null," +
                "h:document.body?document.body.scrollHeight:-1," +
                "err:window.__err||null});}catch(e){return 'probe-failed: '+e.message;}})()";
        view.evaluateJavascript(js, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                Log.i(TAG, "dom=" + value);
            }
        });
    }

    private boolean isNightMode() {
        int mask = getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        return mask == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * manifest 里声明了 configChanges="uiMode"，切深浅色时 Activity 不会重建，
     * 所以系统栏颜色和 WebView 底色要在这里自己重新应用一遍。
     */
    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyThemeColors();
    }

    private void applyThemeColors() {
        boolean night = isNightMode();
        int bg = night ? BG_DARK : BG_LIGHT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(bg);
            getWindow().setNavigationBarColor(bg);
            /* SYSTEM_UI_FLAG_LIGHT_STATUS_BAR 是 API 23 才有的，API 21/22 上无效，
               那两版就把状态栏压深一格，保证白色图标看得见 */
            boolean canDoLightBar = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M;
            if (night) {
                getWindow().getDecorView().setSystemUiVisibility(0);
            } else if (canDoLightBar) {
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            } else {
                getWindow().setStatusBarColor(BG_DARK);
                getWindow().getDecorView().setSystemUiVisibility(0);
            }
        }
        if (webView != null) webView.setBackgroundColor(bg);
    }

    private void showFallback() {
        TextView tv = new TextView(this);
        tv.setText(R.string.webview_missing);
        tv.setPadding(40, 120, 40, 40);
        tv.setTextColor(Color.GRAY);
        setContentView(tv);
        Toast.makeText(this, R.string.webview_missing, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (store != null) { store.close(); store = null; }
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
