# 009 Mobile task viewer

Android 10+ application for **read-only task viewing on a trusted LAN**. It shows task lists, status filters, details, progress reports, results and blocking reasons. No task creation, retry, stop, settings, agent chat, notifications or remote tunnels.

The Android shell uses the system WebView, following the small-shell approach of [dsh-mobile](https://github.com/saya-ch/dsh-mobile/tree/main/apps/mobile), without importing its remote-control or pairing systems.

## Start the computer-side viewer

Keep the existing [DSH profile](006-deployment.md) running. From this repository:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm mobile setup --host 192.168.1.50
# Enter an 8–256-character access password at the hidden prompt.
pnpm mobile start
```

Replace `192.168.1.50` with an IPv4 address **assigned to the machine running this command and reachable from the phone**. Default viewer port: `3083`; default upstream: `http://127.0.0.1:3082`. Override these at setup with `--port` and `--upstream`. Only a numeric `127.0.0.1` HTTP upstream is accepted.

`setup` saves configuration under `~/.dsh/state/superagent-mobile/connection.json` (private directory and mode `0600` file), but does not open a port or change the DSH profile. `start` runs in the foreground; Ctrl+C stops it. Every command accepts `--state-dir <directory>`.

The password is stored as a salted scrypt hash, not plaintext. Change it with:

```sh
pnpm mobile password
```

Then stop and restart the viewer. Existing logins are invalid after any viewer restart. Re-running setup refuses to overwrite an existing configuration. To change the address, stop the viewer and edit its private configuration, or archive its private state directory and run setup again.

## Build and install Android

Install JDK 17+, Android SDK platform 36 and build-tools 36.0.0. Set `ANDROID_HOME` or put the SDK location in ignored `apps/android/local.properties`.

```sh
cd apps/android
./gradlew :app:testDebugUnitTest :app:assembleDebug
# Windows: gradlew.bat :app:testDebugUnitTest :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The Gradle wrapper pins Gradle 8.13 and its SHA-256. The app has no third-party runtime libraries and needs only the `INTERNET` permission. The debug APK is suitable for direct internal installation; an Android debug key is not a production distribution identity. Keep the same signing key for in-place upgrades; do not commit signing keys.

## Use

1. Open **Superagent 任务**, enter the printed HTTP address and tap **连接**.
2. Enter the computer-side access password. There is no username or account registration.
3. Choose a task state; tap a task for its details. Lists show 20 items per page.
4. The page refreshes every five seconds while visible. **刷新** refreshes immediately; Android suspends WebView timers in the background.
5. **更换地址** returns to address entry; changing the server clears the old web login. **重试** reloads the current server entry.

The app remembers one server address. Passwords are not stored by the native app; an HttpOnly, host-only, SameSite session cookie remembers a successful login for up to 30 days, until the viewer restarts. No Android backup is permitted. Password-manager behavior is controlled by the device.

On a network/upstream failure, already loaded content stays visible with an explicit stale-data warning and the last refresh time. Changing the task or filter clears the previous content before loading. A missing task is distinct from a temporarily unavailable service. An expired login returns to password entry.

## Network and privacy boundary

**HTTP deliberately does not encrypt passwords, cookies or task content.** Use this only on a trusted private network. Do not expose the viewer through a public port, public reverse proxy or public tunnel. There is no claim of protection against someone who can observe or modify that network.

- Only private or loopback IPv4 addresses are accepted by the gateway and app. The phone must be able to route to the chosen address; discovery and network configuration are not included.
- The viewer listens separately from DSH. It accepts only its configured Host and same-origin browser requests.
- Task access is limited to `GET /api/tickets` and `GET /api/tickets/:id`; the only POST is `/login`, which changes no tasks.
- The upstream is fixed to loopback. No caller-selected URLs, redirects, management routes or credentials are forwarded.
- Output uses explicit fields: no settings, environment-variable collection, execution directory, session controls or action permissions. Free-form task descriptions/reports remain task content and can themselves contain sensitive information; they are not a secret-redaction system.
- Task text is rendered as text, never HTML. The WebView blocks requests and navigation outside its configured origin, has no native JavaScript bridge and cannot read local files/content providers.

If the phone cannot connect, check the address, Wi-Fi/client isolation, the foreground process and the firewall for **the viewer port only**. Do not change the existing DSH listener to `0.0.0.0`.

**WSL:** Windows `localhost` forwarding does not make a WSL listener reachable from another phone. Use a network arrangement in which the selected WSL address is reachable from the phone (for example correctly configured mirrored networking). This project does not change Windows firewall, WSL networking or port forwarding. Loopback is only for local/emulator verification, not a physical phone on another machine.
