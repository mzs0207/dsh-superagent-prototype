package dev.dsh.superagent.viewer;

import java.net.URI;

/** Validates one private HTTP origin and confines every WebView request to that origin. */
final class ServerAddress {
    private static final java.util.regex.Pattern CONVERSATION_WRITE = java.util.regex.Pattern.compile(
            "/api/conversations(?:/[A-Za-z0-9_-]{1,160}/(?:messages|stop))?");
    private ServerAddress() { }

    static String parse(String value) {
        try {
            URI uri = new URI(value.trim());
            String host = uri.getHost();
            if (!"http".equals(uri.getScheme()) || host == null || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))) throw new IllegalArgumentException();
            String[] parts = host.split("\\.", -1);
            if (parts.length != 4) throw new IllegalArgumentException();
            int[] ip = new int[4];
            for (int i = 0; i < parts.length; i++) {
                if (!parts[i].matches("0|[1-9][0-9]{0,2}")) throw new IllegalArgumentException();
                ip[i] = Integer.parseInt(parts[i]);
                if (ip[i] > 255) throw new IllegalArgumentException();
            }
            if (!(ip[0] == 10 || ip[0] == 127 || (ip[0] == 192 && ip[1] == 168)
                    || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31))) throw new IllegalArgumentException();
            int port = uri.getPort();
            if (port == 0 || port > 65535) throw new IllegalArgumentException();
            String authority = host + (port == -1 ? "" : ":" + port);
            if (!authority.equals(uri.getRawAuthority())) throw new IllegalArgumentException();
            return "http://" + host + (port == -1 || port == 80 ? "" : ":" + port);
        } catch (Exception error) {
            throw new IllegalArgumentException("请输入内网 HTTP 地址，例如 http://192.168.1.50:3083");
        }
    }

    static boolean contains(String origin, String address) { return allows(origin, address, "GET"); }

    static boolean allows(String origin, String address, String method) {
        try {
            URI expected = new URI(origin), actual = new URI(address);
            if (!"http".equals(actual.getScheme()) || actual.getRawUserInfo() != null
                    || !expected.getHost().equals(actual.getHost()) || port(expected) != port(actual)) return false;
            return "GET".equals(method) || ("POST".equals(method) && actual.getRawQuery() == null
                    && actual.getRawFragment() == null && CONVERSATION_WRITE.matcher(actual.getRawPath()).matches());
        } catch (Exception error) { return false; }
    }

    private static int port(URI uri) { return uri.getPort() == -1 ? 80 : uri.getPort(); }
}
