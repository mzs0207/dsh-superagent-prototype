package dev.dsh.superagent.viewer;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Known origins first, then only the /24 containing each private local interface address. */
final class DiscoveryTargets {
    private DiscoveryTargets() { }

    static List<String> build(Collection<String> saved, Collection<String> localAddresses) {
        Set<String> targets = new LinkedHashSet<>(), subnets = new LinkedHashSet<>();
        for (String origin : saved) {
            try { targets.add(ServerAddress.parse(origin)); }
            catch (IllegalArgumentException ignored) { }
        }
        for (String address : localAddresses) {
            try { ServerAddress.parse("http://" + address); }
            catch (IllegalArgumentException ignored) { continue; }
            if (address.startsWith("127.")) continue;
            subnets.add(address.substring(0, address.lastIndexOf('.') + 1));
        }
        for (String subnet : subnets) {
            for (int host = 1; host < 255; host++) targets.add("http://" + subnet + host + ":3083");
        }
        return new ArrayList<>(targets);
    }
}
