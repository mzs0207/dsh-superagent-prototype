package dev.dsh.superagent.viewer;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServerAddressTest {
    @Test public void acceptsCanonicalPrivateOrigins() {
        assertEquals("http://192.168.1.50:3083", ServerAddress.parse("http://192.168.1.50:3083/"));
        assertEquals("http://10.0.2.2:3450", ServerAddress.parse(" http://10.0.2.2:3450 "));
        assertEquals("http://172.16.0.1", ServerAddress.parse("http://172.16.0.1"));
        assertEquals("http://127.0.0.1:3450", ServerAddress.parse("http://127.0.0.1:3450"));
    }
    @Test public void rejectsPublicAmbiguousOrCredentialedAddresses() {
        for (String address : new String[]{"https://192.168.1.1", "http://8.8.8.8", "http://172.32.0.1",
                "http://192.168.1.1.evil.test", "http://user:pass@192.168.1.1", "http://192.168.1.1/path",
                "http://192.168.1.1?password=test", "http://192.168.1.1#test", "http://192.168.01.1",
                "http://3232235777", "http://192.168.1.1:0", "http://192.168.1.1:65536", "javascript:alert(1)", "http://[::1]"}) {
            try { ServerAddress.parse(address); fail("Accepted " + address); }
            catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void comparesOriginRatherThanStringPrefix() {
        String origin = ServerAddress.parse("http://192.168.1.50:3083");
        assertTrue(ServerAddress.contains(origin, "http://192.168.1.50:3083/api/tickets?state=open"));
        assertTrue(ServerAddress.contains(origin, "http://192.168.1.50:3083/#ticket=t1"));
        assertFalse(ServerAddress.contains(origin, "http://192.168.1.50:30830/"));
        assertFalse(ServerAddress.contains(origin, "http://192.168.1.50:3083@evil.test/"));
        assertFalse(ServerAddress.contains(origin, "file:///etc/passwd"));
        assertFalse(ServerAddress.contains(origin, "http://192.168.1.50/"));
    }
}
