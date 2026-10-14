package com.chord.helper;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
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

    private static final String PAGE = "file:///android_asset/www/index.html";
    private static final int BG_DARK = 0xFF0F1115;
    private static final int BG_LIGHT = 0xFFF4F5F8;

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        boolean night = isNightMode();
        int bg = night ? BG_DARK : BG_LIGHT;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(bg);
            getWindow().setNavigationBarColor(bg);
        }

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
        webView.setWebViewClient(new WebViewClient());

        setContentView(webView);
        webView.loadUrl(PAGE);
    }

    private boolean isNightMode() {
        int mask = getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        return mask == android.content.res.Configuration.UI_MODE_NIGHT_YES;
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
