package dev.dsh.superagent.viewer;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AES-GCM binds each password to an exact HTTP origin and server fingerprint. */
final class PasswordCipher {
    private PasswordCipher() { }
    static String encrypt(SecretKey key, String origin, String id, String password) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD((origin + "\n" + id).getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8)), iv = cipher.getIV();
        if (iv.length != 12) throw new GeneralSecurityException("Unexpected GCM IV length");
        byte[] stored = Arrays.copyOf(iv, iv.length + encrypted.length);
        System.arraycopy(encrypted, 0, stored, iv.length, encrypted.length);
        return Base64.getEncoder().encodeToString(stored);
    }
    static String decrypt(SecretKey key, String origin, String id, String stored) throws GeneralSecurityException {
        final byte[] bytes;
        try { bytes = Base64.getDecoder().decode(stored); }
        catch (IllegalArgumentException failure) { throw new GeneralSecurityException("Invalid stored password", failure); }
        if (bytes.length < 28) throw new GeneralSecurityException("Truncated stored password");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, bytes, 0, 12));
        cipher.updateAAD((origin + "\n" + id).getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8);
    }
}
