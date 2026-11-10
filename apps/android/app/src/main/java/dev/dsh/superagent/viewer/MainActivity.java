package dev.dsh.superagent.viewer;

import android.app.Activity;
import android.app.AlertDialog;
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
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Discovers private services and isolates each login inside an origin-confined task and conversation WebView. */
public final class MainActivity extends Activity {
    private WebView web;
    private String origin = "";
    private TextView error;
    private ServerStore servers;
    private ServerDiscovery discovery;
    private final ExecutorService network = Executors.newFixedThreadPool(2);
    private Future<?> request;
    private int generation;
    private boolean choosing, foreground;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::back);
        }
        servers = new ServerStore(getPreferences(MODE_PRIVATE));
        if (servers.last().isEmpty()) showAddress();
        else {
            try { connect(ServerAddress.parse(servers.last()), true); }
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
    private void cancelWork() {
        generation++;
        if (discovery != null) { discovery.close(); discovery = null; }
        if (request != null) { request.cancel(true); request = null; }
    }
    private boolean current(int turn) { return turn == generation && !isFinishing() && !isDestroyed(); }
    private LinearLayout form() {
        LinearLayout layout = root(), form = new LinearLayout(this);
        ScrollView scroll = new ScrollView(this); layout.addView(scroll);
        form.setOrientation(LinearLayout.VERTICAL); form.setPadding(dp(20), dp(20), dp(20), dp(24));
        scroll.addView(form);
        return form;
    }
    private void showAddress() {
        cancelWork(); destroyWeb(); choosing = true;
        final int turn = generation;
        LinearLayout form = form();
        form.addView(text("选择 Superagent 服务", 26));
        form.addView(text("自动查找当前私网 /24 的 3083 端口。\n先连接 EasyTier；其他网段或端口可手动添加。", 14));
        TextView status = text("正在发现服务…", 15); form.addView(status);
        form.addView(button("重新发现", view -> showAddress()));
        LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); form.addView(list);
        Map<String, Button> rows = new LinkedHashMap<>();
        for (String saved : servers.origins()) addServer(list, rows, saved, servers.name(saved), "已保存 · 待检测");
        EditText address = new EditText(this);
        address.setSingleLine(true); address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("http://192.168.1.50:3083"); address.setContentDescription("服务器地址");
        address.setText(servers.last()); form.addView(address, new LinearLayout.LayoutParams(-1, -2));
        form.addView(button("手动连接", view -> {
            try { connect(ServerAddress.parse(address.getText().toString()), true); }
            catch (IllegalArgumentException failure) { address.setError(failure.getMessage()); }
        }));
        form.addView(text("仅用于可信内网。HTTP 不加密密码、任务和会话内容。", 13));
        discovery = new ServerDiscovery();
        discovery.start(getApplicationContext(), servers.origins(), new ServerDiscovery.Listener() {
            private int found;
            @Override public void found(GatewayClient.Identity server) {
                runOnUiThread(() -> {
                    if (!current(turn)) return;
                    found++;
                    addServer(list, rows, server.origin, server.name, "在线");
                    status.setText("正在发现服务… 已找到 " + found + " 台");
                });
            }
            @Override public void finished(int checked) {
                runOnUiThread(() -> {
                    if (!current(turn)) return;
                    for (Button row : rows.values()) row.setText(row.getText().toString().replace("待检测", "未发现在线"));
                    status.setText("发现完成：" + found + " 台在线（检查 " + checked + " 个地址）。\n未找到？检查服务、防火墙，或手动添加地址。");
                });
            }
        });
    }
    private void addServer(LinearLayout list, Map<String, Button> rows, String address, String name, String state) {
        Button row = rows.get(address);
        if (row == null) {
            LinearLayout line = new LinearLayout(this); line.setOrientation(LinearLayout.VERTICAL);
            row = button("", view -> connect(address, true)); rows.put(address, row); line.addView(row);
            if (servers.origins().contains(address)) {
                line.addView(button("忘记此服务", view -> new AlertDialog.Builder(this).setTitle("忘记服务？")
                        .setMessage(address + "\n将删除此服务的地址和已保存密码。")
                        .setNegativeButton("取消", null).setPositiveButton("忘记", (dialog, which) -> {
                            servers.forget(address); showAddress();
                        }).show()));
            }
            list.addView(line);
        }
        row.setText(name + "\n" + address + "\n" + state + (servers.hasPassword(address) ? " · 已记住密码" : "")
                + (address.equals(servers.last()) ? " · 上次使用" : ""));
    }
    private void connect(String selected, boolean automatic) {
        cancelWork(); destroyWeb(); choosing = false;
        final int turn = generation;
        LinearLayout form = form();
        form.addView(text("连接 Superagent 服务", 26)); form.addView(text(selected, 16));
        TextView status = text("正在识别服务…", 16); form.addView(status);
        form.addView(button("切换服务", view -> showAddress()));
        Button retry = button("重试", view -> connect(selected, automatic)); retry.setVisibility(View.GONE); form.addView(retry);
        request = network.submit(() -> {
            try {
                GatewayClient.Identity server = GatewayClient.discover(selected);
                runOnUiThread(() -> {
                    if (!current(turn)) return;
                    boolean changed = !servers.id(selected).isEmpty() && !servers.id(selected).equals(server.id);
                    servers.select(server);
                    String password = "", message = changed ? "服务标识已变化，请重新输入密码。" : "";
                    try { password = servers.password(server); }
                    catch (Exception failure) {
                        servers.clearPassword(selected); message = "无法读取已保存密码，请重新输入。";
                    }
                    showLogin(server, password, message, automatic && !changed && !password.isEmpty());
                });
            } catch (java.io.IOException failure) {
                runOnUiThread(() -> {
                    if (current(turn)) { status.setText("无法连接任务服务。请检查网络、地址和电脑端服务。\n" + failure.getMessage()); retry.setVisibility(View.VISIBLE); }
                });
            }
        });
    }
    private void showLogin(GatewayClient.Identity server, String saved, String message, boolean automatic) {
        cancelWork(); destroyWeb(); choosing = false;
        final int turn = generation;
        LinearLayout form = form();
        form.addView(text(server.name, 26)); form.addView(text(server.origin, 16));
        EditText password = new EditText(this); password.setSingleLine(true);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setHint("访问密码"); password.setContentDescription("访问密码");
        password.setSaveEnabled(false); password.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        password.setText(saved); form.addView(password);
        CheckBox remember = new CheckBox(this); remember.setText("记住此服务的密码（仅此设备）"); remember.setChecked(true); form.addView(remember);
        TextView status = text(message, 15); form.addView(status);
        Button login = button("登录", view -> {}); form.addView(login);
        login.setOnClickListener(view -> {
            String value = password.getText().toString();
            if (value.isEmpty() || value.length() > 256) { password.setError("请输入 1–256 字符的访问密码"); return; }
            boolean persist = remember.isChecked();
            if (!persist) servers.clearPassword(server.origin);
            login.setEnabled(false); password.setEnabled(false); remember.setEnabled(false); status.setText("正在登录…");
            request = network.submit(() -> {
                try {
                    String cookie = GatewayClient.login(server, value);
                    runOnUiThread(() -> {
                        if (!current(turn)) return;
                        if (persist) {
                            try { servers.savePassword(server, value); }
                            catch (Exception failure) {
                                servers.clearPassword(server.origin);
                                Toast.makeText(this, "登录成功，但密码加密保存失败；下次需重新输入。", Toast.LENGTH_LONG).show();
                            }
                        }
                        password.setText("");
                        CookieManager cookies = CookieManager.getInstance();
                        // Cookies are host-scoped, not port-scoped: replace them before every server switch.
                        cookies.removeAllCookies(removed -> {
                            if (!current(turn)) return;
                            cookies.setCookie(server.origin, cookie, accepted -> {
                                if (!current(turn)) return;
                                if (accepted) { cookies.flush(); open(server.origin); }
                                else showLogin(server, "", "无法建立登录会话，请重试。", false);
                            });
                        });
                    });
                } catch (java.io.IOException failure) {
                    runOnUiThread(() -> {
                        if (!current(turn)) return;
                        if (failure instanceof GatewayClient.LoginFailure) {
                            int code = ((GatewayClient.LoginFailure) failure).status;
                            if (code == 401 || code == 409) servers.clearPassword(server.origin);
                            if (code == 409) { connect(server.origin, false); return; }
                        }
                        password.setText(""); password.setEnabled(true); remember.setEnabled(true); login.setEnabled(true);
                        status.setText(failure.getMessage() + "\n请检查后重新登录。");
                    });
                }
            });
        });
        form.addView(button("清除已保存密码", view -> {
            servers.clearPassword(server.origin); showLogin(server, "", "已清除此服务的密码。", false);
        }));
        form.addView(button("切换服务", view -> showAddress()));
        form.addView(text("HTTP 不加密传输；只在可信内网输入密码。", 13));
        if (automatic) login.performClick();
    }
    @SuppressWarnings("SetJavaScriptEnabled")
    private void open(String selected) {
        cancelWork(); destroyWeb(); choosing = false; origin = selected;
        LinearLayout layout = root(), toolbar = new LinearLayout(this);
        toolbar.setPadding(dp(8), dp(4), dp(8), 0);
        toolbar.addView(button("切换服务", view -> showAddress()));
        toolbar.addView(button("重试", view -> connect(selected, true)));
        toolbar.addView(button("清除密码", view -> new AlertDialog.Builder(this).setTitle("清除此服务的密码？")
                .setMessage("将退出当前登录；其他服务的密码不受影响。").setNegativeButton("取消", null)
                .setPositiveButton("清除", (dialog, which) -> {
                    servers.clearPassword(selected);
                    final int turn = ++generation;
                    CookieManager.getInstance().removeAllCookies(removed -> { if (current(turn)) connect(selected, false); });
                }).show()));
        layout.addView(toolbar);
        TextView serverLabel = text(servers.name(selected) + " · " + selected, 13);
        serverLabel.setPadding(dp(12), 0, dp(12), dp(4)); layout.addView(serverLabel);
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
                if (ServerAddress.contains(allowed, url.toString()) && "/login.js".equals(url.getPath())) {
                    runOnUiThread(() -> { if (view == web) connect(allowed, true); });
                    return new WebResourceResponse("text/javascript", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
                if (ServerAddress.allows(allowed, url.toString(), request.getMethod())) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(),
                        new ByteArrayInputStream("只允许访问当前 Superagent 服务".getBytes(StandardCharsets.UTF_8)));
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError failure) {
                if (view == web && request.isForMainFrame()) showError("无法连接电脑，请检查地址、网络和服务，然后点击重试。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (view == web && request.isForMainFrame()) showError("服务返回 HTTP " + response.getStatusCode() + "，请检查地址或重试。");
            }
            @Override public void onPageFinished(WebView view, String url) { if (view == web) CookieManager.getInstance().flush(); }
        });
        layout.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        if (foreground) { web.resumeTimers(); web.onResume(); }
        else { web.onPause(); web.pauseTimers(); }
        web.loadUrl(origin + "/");
    }
    private void showError(String message) {
        error.setText(message); error.setVisibility(View.VISIBLE);
        if (web != null) web.setVisibility(View.GONE);
    }
    private void back() {
        if (web != null && web.canGoBack()) web.goBack();
        else if (!choosing) showAddress();
        else finish();
    }
    @Override public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (Build.VERSION.SDK_INT < 33 && keyCode == KeyEvent.KEYCODE_BACK && event.isTracking() && !event.isCanceled()) {
            back(); return true;
        }
        return super.onKeyUp(keyCode, event);
    }
    @Override protected void onPause() {
        foreground = false;
        if (discovery != null) { discovery.close(); discovery = null; generation++; }
        if (web != null) { web.onPause(); web.pauseTimers(); }
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        if (choosing && discovery == null) showAddress();
        if (web != null) { web.resumeTimers(); web.onResume(); }
    }
    @Override protected void onDestroy() { cancelWork(); network.shutdownNow(); destroyWeb(); super.onDestroy(); }
}
