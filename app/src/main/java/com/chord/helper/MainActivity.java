package com.chord.helper;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        boolean night = isNightMode();
        int bg = night ? BG_DARK : BG_LIGHT;
        applyThemeColors();

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

        setContentView(webView);
        webView.loadUrl(PAGE);
        Log.i(TAG, "loadUrl " + PAGE + " (night=" + night + ", sdk=" + Build.VERSION.SDK_INT + ")");
    }

    /** 加载完成后回读一次 DOM 关键状态，方便在真机日志里定位“白屏”这类问题 */
    private void probeDom(WebView view) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) return;
        final String js = "(function(){try{return JSON.stringify({" +
                "title:document.title," +
                "children:document.body?document.body.children.length:-1," +
                "cards:document.querySelectorAll('.card').length," +
                "chord:(document.getElementById('chordName')||{}).textContent," +
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
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
