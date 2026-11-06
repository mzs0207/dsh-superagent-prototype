package dev.dsh.superagent.viewer;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/** One remembered LAN address and a confined WebView; password entry belongs to the server page. */
public final class MainActivity extends Activity {
    private WebView web;
    private String origin = "";
    private TextView error;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::back);
        }
        String saved = getPreferences(MODE_PRIVATE).getString("origin", "");
        if (saved.isEmpty()) showAddress();
        else {
            try { open(ServerAddress.parse(saved)); }
            catch (IllegalArgumentException ignored) { showAddress(); }
        }
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout root() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.rgb(244, 246, 249));
        layout.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets edges = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(edges.left, edges.top, edges.right, edges.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(layout);
        layout.requestApplyInsets();
        return layout;
    }
    private TextView text(String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size);
        view.setTextColor(Color.rgb(32, 44, 58));
        return view;
    }
    private Button button(String label, View.OnClickListener action) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setOnClickListener(action);
        return button;
    }
    private void destroyWeb() {
        if (web != null) {
            WebView previous = web; web = null; previous.stopLoading();
            if (previous.getParent() instanceof ViewGroup) ((ViewGroup) previous.getParent()).removeView(previous);
            previous.destroy();
        }
    }
    private void showAddress() {
        destroyWeb();
        LinearLayout layout = root(), form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL); form.setPadding(dp(24), dp(40), dp(24), dp(24));
        layout.addView(form);
        form.addView(text("Superagent 任务", 28));
        TextView hint = text("只读任务展示\n填写电脑上的 HTTP 只读服务地址，连接后输入访问密码。", 16);
        hint.setPadding(0, dp(20), 0, dp(24)); form.addView(hint);
        EditText address = new EditText(this);
        address.setSingleLine(true); address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("http://192.168.1.50:3083"); address.setContentDescription("服务器地址");
        address.setText(getPreferences(MODE_PRIVATE).getString("origin", ""));
        form.addView(address, new LinearLayout.LayoutParams(-1, -2));
        form.addView(button("连接", view -> {
            try {
                String selected = ServerAddress.parse(address.getText().toString());
                String previous = getPreferences(MODE_PRIVATE).getString("origin", "");
                getPreferences(MODE_PRIVATE).edit().putString("origin", selected).apply();
                if (!selected.equals(previous)) CookieManager.getInstance().removeAllCookies(removed -> open(selected));
                else open(selected);
            } catch (IllegalArgumentException failure) { address.setError(failure.getMessage()); }
        }));
        TextView warning = text("仅用于可信内网。HTTP 不加密密码和任务内容。", 13);
        warning.setPadding(0, dp(24), 0, 0); form.addView(warning);
    }
    @SuppressWarnings("SetJavaScriptEnabled")
    private void open(String selected) {
        destroyWeb(); origin = selected;
        LinearLayout layout = root(), toolbar = new LinearLayout(this);
        toolbar.setPadding(dp(8), dp(4), dp(8), 0);
        toolbar.addView(button("更换地址", view -> showAddress()));
        toolbar.addView(button("重试", view -> {
            if (web != null) { error.setVisibility(View.GONE); web.setVisibility(View.VISIBLE); web.loadUrl(origin + "/"); }
        }));
        layout.addView(toolbar);
        error = text("", 15); error.setPadding(dp(20), dp(20), dp(20), dp(20)); error.setVisibility(View.GONE); layout.addView(error);
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setDomStorageEnabled(false); settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        final String allowed = selected;
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !ServerAddress.contains(allowed, request.getUrl().toString());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                boolean methodAllowed = "GET".equals(request.getMethod())
                        || ("POST".equals(request.getMethod()) && "/login".equals(url.getPath()) && url.getQuery() == null);
                if (ServerAddress.contains(allowed, url.toString()) && methodAllowed) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(),
                        new ByteArrayInputStream("只允许访问当前任务服务".getBytes(StandardCharsets.UTF_8)));
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError failure) {
                if (view == web && request.isForMainFrame()) showError("无法连接电脑，请检查地址、网络和只读服务，然后点击重试。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (view == web && request.isForMainFrame()) showError("服务返回 HTTP " + response.getStatusCode() + "，请检查地址或重试。");
            }
            @Override public void onPageFinished(WebView view, String url) { CookieManager.getInstance().flush(); }
        });
        layout.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        web.loadUrl(origin + "/");
    }
    private void showError(String message) {
        error.setText(message); error.setVisibility(View.VISIBLE);
        if (web != null) web.setVisibility(View.GONE);
    }
    private void back() {
        if (web != null && web.canGoBack()) web.goBack(); else finish();
    }
    @Override public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (Build.VERSION.SDK_INT < 33 && keyCode == KeyEvent.KEYCODE_BACK && event.isTracking() && !event.isCanceled()) {
            back(); return true;
        }
        return super.onKeyUp(keyCode, event);
    }
    @Override protected void onPause() {
        if (web != null) { web.onPause(); web.pauseTimers(); }
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        if (web != null) { web.resumeTimers(); web.onResume(); }
    }
    @Override protected void onDestroy() { destroyWeb(); super.onDestroy(); }
}
