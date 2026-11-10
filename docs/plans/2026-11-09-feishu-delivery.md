# Feishu follow-up and delivery card Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Execute this plan in single-flow mode.

**Goal:** Reply to a ZenTao notification topic to supply context and explicitly resume authorized work; expose evidence-backed delivery cards on desktop and mobile.

**Architecture:** Intercept only persisted ZenTao notification roots before ordinary intake. Reuse current sender policy, ticket mandate, note/retry operations and durable outbox; normal replies never resume paused work. Project existing workflow checkpoints into a shared delivery view; retain additional verified deployment/live-evidence facts only where they are actually confirmed. No new workflow engine, mobile control surface, or database.

**Tech Stack:** TypeScript, SQLite KV, React, existing mobile JavaScript, Vitest.

## 1. Feishu topic follow-up
- Modify `src/app/runtime.ts`; add `src/app/zentao-followup.ts`; reuse `src/app/outbox.ts`, `src/kv.ts` and `src/core/engine.ts` contracts.
- Resolve a root against its persisted Bug/bot/recipient scope. Require human sender, private chat, configured recipient, allowed sender, enabled sources and valid ticket mandate. Reject stale/ambiguous/no-live-ticket roots without spawning new work.
- Store message deduplication, context, optional retry and reply receipt atomically. Exact trimmed `继续` is the sole resume command. Ordinary text is context, never implicit authorization.
- Regression cases: unauthorized/wrong-recipient/bot/group; source/policy changes; plain context remains blocked; continue preserves session and workspace; duplicate/restart replay; unrelated topics remain normal intake; completed/ambiguous tasks do not restart.
- Run focused Vitest cases before and after implementation, then exercise inbound events through Runtime with temporary local transports.

## 2. Evidence-backed delivery card
- Modify `src/app/tools/zentao.ts`, `src/app/views/tickets.ts`, `src/client/ticket.tsx`, client translations, `src/mobile/gateway.ts`, `src/mobile/view.js` and existing tests.
- Show cause/scope when explicitly recorded, reproduction, verified HEAD, MR, develop/test SHAs, actual confirmed build SHAs/links, live verification and outstanding human action. Missing or legacy evidence stays unknown; published is not deployed.
- Preserve confirmation facts before remote resolution so a resolution failure does not erase successful deployment verification. Never expose receipt filesystem paths or credentials to the mobile projection.
- Regression cases: missing evidence, publish-only state, verified success, blocked after deployment, mismatched builds, hostile URLs/text. Browser smoke covers desktop and mobile delivery cards.

## 3. Hindsight integration (authorized)
- Add `src/app/memory.ts` using native fetch and a private `<stateDir>/hindsight.json` connection file. Bind one canonical repository URL to an explicit project tag in the existing bank; do not copy secrets into settings, prompts, environment variables or public documents.
- Recall scoped historical references before a worker's first assignment. Filter with a nonempty project tag and `all_strict`; treat results as untrusted historical context, never authority. A timeout/failure must not block the task.
- On successful ticket completion, export only a compact summary from complete ZenTao verification checkpoints: cause/change summary and structured revision/build evidence. Never export transcripts, original bug bodies or raw reproduction/test logs. Other tasks may recall but a bare `ready` report is not proof for automatic retention.
- Reuse Effects for durable asynchronous delivery of synchronous Hindsight retain calls. Use stable document IDs; keep failed exports queued and isolate pending records from connection/scope changes.
- Verify tag isolation, unavailable/redirecting backend, credential exclusion, incomplete evidence refusal, duplicate export and restart recovery. Live smoke uses a uniquely tagged synthetic document and deletes exactly that document afterward.

## Verification and delivery
- Run `pnpm check` after implementation; use disposable runtime/browser smoke without external Bug writes, deployment or unsolicited messages.
- Update existing operational docs and the table-only task tracker with sanitized evidence.
- Integrate only this task's differences into the original dirty worktree after checking original files still match the captured baseline. Do not commit, push or restart the user's running service without a separate need/authorization.
