# 009 Mobile tasks and conversations

Android 10+ application for **tasks and DSH conversations on a trusted private network**. The task tab shows lists, filters, details, progress and results. The conversation tab shares the computer's existing ordinary, main-orchestrator and task-worker sessions, with history, creation, text input, streamed replies and stopping. No separate chat database, account system, push notifications or remote tunnels.

The Android shell uses the system WebView, following the small-shell approach of [dsh-mobile](https://github.com/saya-ch/dsh-mobile/tree/main/apps/mobile), without importing its remote-control or pairing systems.

## Start the computer-side gateway

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

Then stop and restart the viewer. Existing sessions are invalid after any viewer restart; the Android app can log in again using that service's saved password. Changing the password changes the service fingerprint and requires fresh password entry. Re-running setup refuses to overwrite an existing configuration. To change the address, stop the viewer and edit its private configuration, or archive its private state directory and run setup again.

## Build and install Android

Install JDK 17+, Android SDK platform 36 and build-tools 36.0.0. Set `ANDROID_HOME` or put the SDK location in ignored `apps/android/local.properties`.

```sh
cd apps/android
./gradlew :app:testDebugUnitTest :app:assembleDebug
# Windows: gradlew.bat :app:testDebugUnitTest :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The Gradle wrapper pins Gradle 8.13 and its SHA-256. The app has no third-party runtime libraries. It uses `INTERNET` for HTTP and `ACCESS_NETWORK_STATE` to discover local/VPN interface addresses; no location permission is requested. The debug APK is suitable for direct internal installation; an Android debug key is not a production distribution identity. Keep the same signing key for in-place upgrades; do not commit signing keys.

## Use

1. Install APK **0.3.0** or newer. Run `pnpm build` on each computer, restart its DSH profile to load the conversation routes, then restart `pnpm mobile start`. Keep the existing mobile configuration/password. Updating only the APK or gateway does not update the DSH plugin.
2. Connect the phone to the trusted LAN or EasyTier network. Open **Superagent**: the app restores the last selected service, or shows **选择 Superagent 服务** on first use.
3. **切换服务** opens the discovered/saved service list. Tap a computer to connect; discovery never switches computers or submits passwords on its own. **重新发现** refreshes the list. For other subnets or ports, enter the full address and tap **手动连接**; it is remembered thereafter.
4. Enter that computer's access password. **记住此服务的密码（仅此设备）** is checked by default; uncheck it to use only the current login. There is no username or account registration.
5. Choose a task state; tap a task for its details. Lists show 20 items per page. The page refreshes every five seconds while visible; **刷新** refreshes immediately and WebView timers pause in the background.

   Task details include the same **交付验收** evidence card as the desktop: root cause/change scope, reproduction and tests, verified and published revisions, MR/build links, deployment verification and the pending human decision. Missing evidence stays unknown; pushing test is not deployment. The mobile response excludes local receipt/worktree paths and only offers credential-free HTTP(S) artifact links. This card is read-only and adds no task mutation endpoint. Upgrade/build and restart both the DSH profile and mobile gateway; no new APK is required for this gateway-served WebView page.
   The existing APK keeps its same-origin WebView navigation restriction: external MR/build pages do not open inside it. Full artifact URLs are displayed for long-press copying into the system browser; the same links open normally when using the mobile page in a browser.

6. **重试** reconnects the current service. **清除密码** removes only its saved password and exits its current login. **忘记此服务** in the list removes that saved address and password; an online service can still be rediscovered.

Passwords are encrypted with AES-GCM using an app-private [Android Keystore](https://developer.android.com/privacy-and-security/keystore) key, bound to the exact address **including port** and service fingerprint. They are never stored in plaintext, URLs, logs, JavaScript or WebView storage. Only successful logins are saved. No Android backup is permitted; uninstalling the app loses the saved passwords. Clearing a password for one computer does not clear other computers' passwords.

Selecting a saved service or restarting the app reuses its password after checking its fingerprint. A changed fingerprint, unreadable encrypted password or rejected password requires input again; rejected passwords are not retried automatically. The fingerprint is a public identifier, **not cryptographic server authentication**. HTTP still requires a trusted network. Cookies are replaced when switching because HTTP cookies are host-scoped, not port-scoped.

On a network/upstream failure, already loaded content stays visible with an explicit stale-data warning and the last refresh time. Changing the task or filter clears the previous content before loading. A missing task is distinct from a temporarily unavailable service. An expired login is renewed using the saved password, or returns to native password entry.

### Conversations

- **会话** lists 20 sessions per page from the selected computer; **新建会话** uses that computer's default DSH agent preset, workspace and model. Existing desktop conversations appear in the same list. Child subagent controls are not exposed.
- Open a conversation to read its latest 50 messages and **加载更早消息** for older history. Context/task inputs and tool results are folded; user/assistant text and interrupted partial replies remain visible. Raw request headers, model reasoning and arbitrary projection fields are not forwarded. Content is text, not executable HTML.
- Enter up to 32,000 characters and tap **发送**. Messages to a running agent are delivered at its next step through DSH's existing steering path. Task-worker messages use the same human-intervention handling as desktop input; they do not create a separate task or silently restore a withdrawn mandate.
- Replies stream while visible. Backgrounding disconnects the read, not the agent. Returning reconnects to the latest history and pending inbox. Drafts survive task/conversation navigation in the current page, but not a page reload, re-login, service switch or app process death.
- An unconfirmed send remains visible with **重试发送**. Retries reuse the original message ID; creation retries likewise reuse the requested session ID. No automatic message resend occurs. Acknowledged messages waiting for the agent are marked separately from completed replies.
- **停止生成** cancels the current ordinary/main session turn; pending messages remain. New events can wake the main orchestrator again, so this is not a global pause. For an open task-worker session, the button is **停止任务**: confirmation ends the ticket, withdraws its mandate and stops its background work through the existing task engine.
- Model/preset settings, file uploads, approvals and other desktop controls remain on the computer. A blocked conversation reports that it needs desktop attention.

**The access password now grants conversation control, not merely viewing.** Anyone holding it can instruct agents within their existing desktop permissions, including the main orchestrator and task workers. Give it only to trusted operators.

The gateway allowlists `GET /api/conversations`, `POST /api/conversations`, `GET /api/conversations/:id/history`, `GET /api/conversations/:id/events`, `POST /api/conversations/:id/messages` and `POST /api/conversations/:id/stop`. Writes require the login cookie, JSON and `X-Superagent-Request: 1`; body sizes, IDs and query fields are bounded. The stream is a projected SSE journal, not an arbitrary proxy to DSH.

### Discovery scope

Discovery checks saved addresses first, then hosts `1`–`254` in the `/24` containing each currently visible private IPv4 interface address, on port `3083`. Wi-Fi and VPN interface addresses are included, even VPN `/32` addresses. It uses up to 12 HTTP probes at once, short timeouts and bounded responses; leaving the list or backgrounding the app cancels the scan.

It does **not** scan all of `10/8`, inspect EasyTier peers, use multicast/mDNS, or contact a public discovery service. Routing through EasyTier must already work. Larger/routed subnets, non-default ports, or VPN interfaces hidden by the device require manual entry once. An unreachable saved service stays in the list and remains selectable.

The credential-free `GET /.well-known/superagent` endpoint returns only protocol version, computer hostname and a stable fingerprint derived from the password salt. It retains Host/origin checks, exposes no task data, and does not contact the upstream. Restarts keep the fingerprint; password replacement changes it. Discovered names/identifiers do not authorize access or cause credentials to move to another address.

## Network and privacy boundary

**HTTP deliberately does not encrypt passwords, cookies, tasks or conversations.** Use this only on a trusted private network. Do not expose the gateway through a public port, public reverse proxy or public tunnel. There is no claim of protection against someone who can observe or modify that network.

- Only private or loopback IPv4 addresses are accepted by the gateway and app. The phone must be able to route to the chosen address; discovery does not configure routes, EasyTier or firewalls.
- The viewer listens separately from DSH. It accepts only its configured Host and same-origin browser requests.
- The task tab remains read-only through `GET /api/tickets` and `GET /api/tickets/:id`. Conversation operations are separately allowlisted above; stopping an open task-worker session intentionally stops its ticket.
- The upstream is fixed to loopback. No caller-selected URLs, redirects, arbitrary management routes or caller credentials are forwarded.
- Output uses explicit task/conversation fields, not settings or environment collections. Free-form messages, context, tool results and reports can themselves contain sensitive information, including paths; this is not a secret-redaction system.
- Text is rendered as text, never HTML. The WebView permits same-origin GET and only the listed conversation POST paths, has no native JavaScript bridge and cannot read local files/content providers. Android submits passwords natively only to the selected origin's `/login`; redirects are rejected.

If the phone cannot connect, check the address, Wi-Fi/client isolation, the foreground process and the firewall for **the viewer port only**. Do not change the existing DSH listener to `0.0.0.0`.

**WSL:** Windows `localhost` forwarding does not make a WSL listener reachable from another phone. Use a network arrangement in which the selected WSL address is reachable from the phone (for example correctly configured mirrored networking). This project does not change Windows firewall, WSL networking or port forwarding. Loopback is only for local/emulator verification, not a physical phone on another machine.
