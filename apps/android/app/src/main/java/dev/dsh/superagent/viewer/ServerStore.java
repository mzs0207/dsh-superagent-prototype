package dev.dsh.superagent.viewer;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** Private per-origin metadata and Keystore-encrypted passwords; no plaintext fallback or backup. */
final class ServerStore {
    private static final String KEY = "superagent-viewer-passwords";
    private final SharedPreferences preferences;
    ServerStore(SharedPreferences preferences) { this.preferences = preferences; }

    String last() { return preferences.getString("origin", ""); }
    List<String> origins() {
        Set<String> origins = new LinkedHashSet<>();
        if (!last().isEmpty()) origins.add(last()); // Also migrates the original single-address preference.
        List<String> saved = new ArrayList<>(preferences.getStringSet("servers", Collections.emptySet()));
        Collections.sort(saved); origins.addAll(saved);
        origins.removeIf(value -> { try { ServerAddress.parse(value); return false; } catch (IllegalArgumentException ignored) { return true; } });
        return new ArrayList<>(origins);
    }
    String name(String origin) { return preferences.getString("name:" + origin, origin); }
    String id(String origin) { return preferences.getString("id:" + origin, ""); }
    boolean hasPassword(String origin) { return preferences.contains("password:" + origin); }
    void select(GatewayClient.Identity server) {
        Set<String> origins = new LinkedHashSet<>(origins()); origins.add(server.origin);
        SharedPreferences.Editor edit = preferences.edit().putStringSet("servers", origins).putString("origin", server.origin)
                .putString("name:" + server.origin, server.name).putString("id:" + server.origin, server.id);
        if (!server.id.equals(id(server.origin))) edit.remove("password:" + server.origin);
        edit.apply();
    }
    String password(GatewayClient.Identity server) throws GeneralSecurityException, IOException {
        if (!server.id.equals(id(server.origin))) return "";
        String stored = preferences.getString("password:" + server.origin, "");
        return stored.isEmpty() ? "" : PasswordCipher.decrypt(key(), server.origin, server.id, stored);
    }
    void savePassword(GatewayClient.Identity server, String password) throws GeneralSecurityException, IOException {
        String stored = PasswordCipher.encrypt(key(), server.origin, server.id, password);
        preferences.edit().putString("password:" + server.origin, stored).apply();
    }
    void clearPassword(String origin) { preferences.edit().remove("password:" + origin).apply(); }
    void forget(String origin) {
        Set<String> origins = new LinkedHashSet<>(origins()); origins.remove(origin);
        SharedPreferences.Editor edit = preferences.edit().putStringSet("servers", origins)
                .remove("name:" + origin).remove("id:" + origin).remove("password:" + origin);
        if (origin.equals(last())) edit.remove("origin");
        edit.apply();
    }
    private SecretKey key() throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
}
