package dev.dsh.superagent.viewer;

import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

/** Discovery never expands outside private /24s or loses manually saved custom ports. */
public class DiscoveryTargetsTest {
    @Test public void prioritizesSavedOriginsAndDeduplicatesSubnets() {
        List<String> targets = DiscoveryTargets.build(List.of("http://10.3.4.8:4083", "http://10.3.4.9:3083"),
                List.of("10.3.4.2", "10.3.4.3"));
        assertEquals("http://10.3.4.8:4083", targets.get(0));
        assertEquals("http://10.3.4.9:3083", targets.get(1));
        assertEquals(255, targets.size());
        assertTrue(targets.contains("http://10.3.4.254:3083"));
        assertFalse(targets.contains("http://10.3.5.1:3083"));
        assertFalse(targets.contains("http://10.3.4.0:3083"));
        assertFalse(targets.contains("http://10.3.4.255:3083"));
    }
    @Test public void excludesPublicLoopbackAndIpv6NetworksButAllowsExplicitLoopback() {
        List<String> targets = DiscoveryTargets.build(List.of("http://127.0.0.1:4083", "http://8.8.8.8", "broken"),
                List.of("127.0.0.1", "8.8.8.8", "100.64.1.1", "fe80::1", "172.32.1.1"));
        assertEquals(List.of("http://127.0.0.1:4083"), targets);
    }
    @Test public void coversWifiAndVpnWithoutScanningTheirEntireAddressSpaces() {
        List<String> targets = DiscoveryTargets.build(List.of(), List.of("192.168.7.2", "10.4.5.2", "172.16.8.1"));
        assertEquals(762, targets.size());
        assertTrue(targets.contains("http://192.168.7.1:3083"));
        assertTrue(targets.contains("http://10.4.5.1:3083"));
        assertTrue(targets.contains("http://172.16.8.254:3083"));
    }
}
