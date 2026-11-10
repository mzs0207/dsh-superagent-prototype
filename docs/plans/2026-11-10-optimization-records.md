# Optimization Records Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan task-by-task in single-flow mode.

**Goal:** Record privacy-safe runtime facts and verified lessons so future project improvements start with evidence.

**Architecture:** A passive OptimizationLedger owns two tables in the existing SQLite database. Existing domain events, effect attempts and worker retries supply bounded structured observations; loopback management routes and the existing control script expose records, aggregate reports and lessons. Verified lessons share the current durable Hindsight export queue with an isolated project scope.

**Tech Stack:** TypeScript, node:sqlite, Zod, existing Effects/Hindsight, Python standard-library control script, Vitest.

---

### Task 1: Runtime evidence

Files: create `src/app/optimization.ts` and `tests/optimization.spec.ts`; modify `src/core/ports.ts`, `src/core/assignments.ts`, `src/app/runtime.ts`, `src/app/effects.ts`, `src/executor/dsh.ts`, `tsdown.config.ts`.

1. Add behavioral tests using the real Runtime/SQLite for blocked→manual retry→ready, duplicate start events, rollback, and restart. Add a real Effects test that a Later is not a failed attempt and recovery remains recorded after the queue row is gone.
2. Run `pnpm exec vitest run tests/optimization.spec.ts`; confirm missing-record failures before production edits.
3. Add report-state domain events without report text. Observe existing assignment-ended retried events for manual intervention. Create append-only, idempotently keyed records containing only enum codes, hashes, timestamps, durations, build/model/config fingerprints and verification booleans. Isolate observation writes in nested atomic savepoints; report write failure via optimization health, never fail the task.
4. Instrument only actual effect completions/failures and scheduled worker retries; ignore Later holds. Keep queue retry/authorization behavior unchanged.

### Task 2: Query and lesson loop

Files: modify `src/app/optimization.ts`, `src/app/api.ts`, `src/app/http.ts`, `src/app/runtime.ts`, `src/app/memory.ts`, `scripts/dsh-superagent`; extend `tests/optimization.spec.ts` and `tests/memory.spec.ts`.

1. Add tests rejecting verified lessons without validation/evidence, preserving hypotheses locally, filtering/paginating records and exporting verified lessons under separate tags without raw runtime data.
2. Add bounded GET `optimization` report, GET `optimization/records`, GET `optimization/lessons`, POST `optimization/lessons` routes. Query by explicit time bounds; return coverage/caveats and grouped counts rather than guessed diagnoses. Lesson IDs are stable content hashes; repeated submissions do not duplicate successful exports.
3. Use `memory-retain` payload discrimination to pin optimization exports separately from business-repair exports; use the existing connection, queue and receipt store. On startup replay locally verified lessons not yet successfully exported.
4. Add `scripts/dsh-superagent optimization --view summary|records|lessons`, pagination/time arguments and `--lesson-file`. Use the existing same-origin header, no new dependencies, no new service.

### Task 3: Consumer instructions and verification

Files: update `README.md`, `docs/006-deployment.md`, `docs/007-architecture.md`, `docs/plans/task.md`.

Document privacy/coverage, 90-day retention, exact API/CLI usage, hypothesis vs verified, and the optimize→verify→record loop. Add source/test inventory entries and preserve all existing gates. Run `pnpm check` once after implementation; exercise the actual CLI against a disposable local HTTP endpoint backed by the actual management routes and SQLite. Transfer only this feature files back to the original workspace, preserving existing local edits; no push, real external test messages or production deployment.
