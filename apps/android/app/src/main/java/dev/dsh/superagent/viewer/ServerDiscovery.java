package dev.dsh.superagent.viewer;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/** Foreground-only bounded probing; discovery never reads or submits a password. */
final class ServerDiscovery implements AutoCloseable {
    interface Listener {
        void found(GatewayClient.Identity server);
        void finished(int checked);
    }
    private final ExecutorService workers = Executors.newFixedThreadPool(12);
    private volatile boolean stopped;

    @SuppressWarnings("deprecation") // One snapshot per explicit scan, not continuous polling.
    static List<String> addresses(Context context) {
        List<String> result = new ArrayList<>();
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        if (manager != null) {
            for (Network network : manager.getAllNetworks()) {
                LinkProperties properties = manager.getLinkProperties(network);
                if (properties != null) properties.getLinkAddresses().forEach(address -> result.add(address.getAddress().getHostAddress()));
            }
        }
        // Include VPN /32 interfaces even when not surfaced as the default Android network.
        try {
            java.util.Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces != null) for (NetworkInterface network : Collections.list(interfaces)) {
                if (network.isUp()) Collections.list(network.getInetAddresses()).forEach(address -> result.add(address.getHostAddress()));
            }
        } catch (SocketException ignored) { /* ConnectivityManager addresses remain usable. */ }
        return result;
    }
    void start(Context context, List<String> saved, Listener listener) {
        workers.execute(() -> {
            List<String> targets = DiscoveryTargets.build(saved, addresses(context));
            AtomicInteger next = new AtomicInteger(), checked = new AtomicInteger(), active = new AtomicInteger(12);
            if (stopped) return;
            // Each worker consumes the ordered list; there is no per-host thread or unbounded job queue.
            for (int i = 0; i < 12; i++) {
                if (stopped) return;
                try {
                    workers.execute(() -> {
                        int index;
                        while (!stopped && (index = next.getAndIncrement()) < targets.size()) {
                            try {
                                GatewayClient.Identity server = GatewayClient.discover(targets.get(index));
                                if (!stopped) listener.found(server);
                            } catch (java.io.IOException ignored) { /* Closed ports and non-viewer services are not discoveries. */ }
                            checked.incrementAndGet();
                        }
                        if (active.decrementAndGet() == 0 && !stopped) listener.finished(checked.get());
                    });
                } catch (java.util.concurrent.RejectedExecutionException ignored) { return; }
            }
        });
    }
    @Override public void close() { stopped = true; workers.shutdownNow(); }
}
