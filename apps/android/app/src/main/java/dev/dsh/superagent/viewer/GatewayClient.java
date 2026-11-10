package dev.dsh.superagent.viewer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/** Credential-free discovery and explicit login; no redirects, proxies or arbitrary response URLs. */
final class GatewayClient {
    static final class Identity {
        final String origin, id, name;
        Identity(String origin, String id, String name) { this.origin = origin; this.id = id; this.name = name; }
    }
    static final class LoginFailure extends IOException {
        final int status;
        LoginFailure(int status, String message) { super(message); this.status = status; }
    }
    private GatewayClient() { }

    private static HttpURLConnection connection(String origin, String path, int timeout) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(ServerAddress.parse(origin) + path).openConnection(Proxy.NO_PROXY);
        connection.setConnectTimeout(timeout); connection.setReadTimeout(timeout);
        connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        return connection;
    }
    private static JSONObject json(HttpURLConnection connection) throws IOException {
        try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(3);
            byte[] buffer = new byte[1024]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted() || System.nanoTime() > deadline) throw new IOException("请求已取消或响应超时");
                if (output.size() + count > 4096) throw new IOException("服务响应过大");
                output.write(buffer, 0, count);
            }
            return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        } catch (JSONException failure) { throw new IOException("不是有效的任务服务", failure); }
    }
    static Identity discover(String origin) throws IOException {
        String canonical = ServerAddress.parse(origin);
        HttpURLConnection connection = connection(canonical, "/.well-known/superagent", 1000);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("未识别到任务服务，请检查地址并更新电脑端服务");
            JSONObject result = json(connection);
            String id = result.optString("id"), name = result.optString("name");
            if (!"superagent-viewer".equals(result.optString("service")) || result.optInt("version") != 1
                    || !id.matches("[a-f0-9]{64}") || name.length() > 80) throw new IOException("不是兼容的任务服务");
            return new Identity(canonical, id, name.isEmpty() ? canonical : name);
        } finally { connection.disconnect(); }
    }
    static String login(Identity server, String password) throws IOException {
        if (!server.id.equals(discover(server.origin).id)) throw new LoginFailure(409, "服务标识已变化，请重新选择服务并输入密码");
        if (Thread.currentThread().isInterrupted()) throw new IOException("登录已取消");
        HttpURLConnection connection = connection(server.origin, "/login", 15000);
        try {
            connection.setRequestMethod("POST"); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            byte[] body = ("password=" + URLEncoder.encode(password, StandardCharsets.UTF_8.name())).getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            if (status != 200) throw new LoginFailure(status, status == 401 ? "密码错误，请重新输入" : "登录失败（HTTP " + status + "），请重试");
            String cookie = connection.getHeaderField("Set-Cookie");
            if (!json(connection).optBoolean("authenticated") || cookie == null
                    || !cookie.startsWith("superagent-view=") || !cookie.split(";", 2)[0].matches("superagent-view=[A-Za-z0-9_-]{43}")) {
                throw new IOException("服务未返回有效的登录会话");
            }
            // Never accept a server-supplied Domain or Path that would widen the session scope.
            return cookie.split(";", 2)[0] + "; Path=/; HttpOnly; SameSite=Strict";
        } finally { connection.disconnect(); }
    }
}
