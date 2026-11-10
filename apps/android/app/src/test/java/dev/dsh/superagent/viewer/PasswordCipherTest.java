package dev.dsh.superagent.viewer;

import java.security.GeneralSecurityException;
import java.util.Base64;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Test;
import static org.junit.Assert.*;

/** Stored secrets must not be reusable at another origin, instance, or with altered ciphertext. */
public class PasswordCipherTest {
    private final SecretKey key;
    public PasswordCipherTest() throws Exception { KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256); key = generator.generateKey(); }
    @Test public void restoresUnicodePasswordWithRandomizedEncryption() throws Exception {
        String password = "example-密码+&=123", origin = "http://10.0.0.2:3083";
        String first = PasswordCipher.encrypt(key, origin, "one", password);
        String second = PasswordCipher.encrypt(key, origin, "one", password);
        assertNotEquals(first, second);
        assertEquals(password, PasswordCipher.decrypt(key, origin, "one", first));
        assertEquals(password, PasswordCipher.decrypt(key, origin, "one", second));
    }
    @Test public void rejectsAnotherOriginOrServerIdentity() throws Exception {
        String stored = PasswordCipher.encrypt(key, "http://10.0.0.2:3083", "one", "example-password");
        assertThrows(GeneralSecurityException.class, () -> PasswordCipher.decrypt(key, "http://10.0.0.2:4083", "one", stored));
        assertThrows(GeneralSecurityException.class, () -> PasswordCipher.decrypt(key, "http://10.0.0.2:3083", "two", stored));
    }
    @Test public void rejectsTamperingAndTruncation() throws Exception {
        String stored = PasswordCipher.encrypt(key, "http://10.0.0.2:3083", "one", "example-password");
        byte[] bytes = Base64.getDecoder().decode(stored); bytes[bytes.length - 1] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> PasswordCipher.decrypt(key, "http://10.0.0.2:3083", "one", Base64.getEncoder().encodeToString(bytes)));
        assertThrows(GeneralSecurityException.class, () -> PasswordCipher.decrypt(key, "http://10.0.0.2:3083", "one", "AAAA"));
    }
}
