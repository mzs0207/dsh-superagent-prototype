# Zentao Bug Automation Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan task-by-task in single-flow mode.

**Goal:** Add a working Zentao trigger source and the approved reproduce/fix/develop/cherry-pick-test/deploy/verify workflow, with comment-and-pause failure handling.

**Architecture:** Reuse existing SourceKind polling, persistent Trigger IDs, source settings, blocked/retry tickets and per-ticket worker sessions. Keep ZenTao API operations in a bounded client and expose ticket-scoped worker operations; use a bundled workflow skill for repository-specific verification and Jenkins deployment. Add an explicit completion barrier so merged MRs do not terminate deployment work.

**Tech Stack:** TypeScript, Node standard HTTP/filesystem/process APIs, Zod, Cordis/DSH, Vitest, Git, existing Jenkins Python CLI.

---

## 1. Source and client

Create `src/sources/zentao-client.ts`, `src/sources/zentao.ts`, `tests/zentao.spec.ts`. Extend `src/sources/kind.ts` and `registry.ts` to pass current config to channel sends. Register `zentao-watch` in `package.json`, `tsdown.config.ts`, `cordis.patch.yml`.

Write boundary tests first: unclosed pages filter active/assignee/product, string numeric IDs, duplicate event across rounds/restarts, no retrigger from comment edits, failures must not consume events. Run `pnpm exec vitest run tests/zentao.spec.ts` to observe missing behavior. Implement authenticated REST reading and session-based comment-only writes with readback. Use stable IDs scoped to instance and bug activation cycle. Build config UI from existing fields; do not add a second settings page.

## 2. Scoped worker workflow

Create `src/app/tools/zentao.ts` and wire it from `src/app/tools/executor.ts`. Add durable per-ticket workflow state via existing KV key families. Provide read/context, evidence-backed suspension and successful resolution operations bound to the current ticket origin, never arbitrary Bug IDs. Ensure blocked/failed reports from this source write notes and do not auto-resume. Add tests for note failure, duplicate note retries, stale assignment and false ready reports.

Persist a completion barrier for this workflow and make MR observation wait for successful deployment and final test verification rather than finishing on merge. Cover this in core/runtime regression tests; other sources retain current behavior.

## 3. Fix-only release

Add a bundled `skills/dsh-superagent-zentao/SKILL.md` plus a native Git helper for copying only the verified fix commits onto a separate test worktree. Pin MR head, develop target and tested revision; no force pushes, no whole-develop merge. Detect conflict/dependency/test failures and leave an actionable paused ticket. Test with temporary real Git repositories containing unrelated develop commits.

Use the existing `scripts/jenkins_build.py --branch test --service <affected> --deploy`, wait for SUCCESS, then reproduce the original scenario against test. Write result with MR, develop SHA, test SHA, build URL and verification evidence before marking fixed. Register the skill through `src/app/skill-files.ts`, `context.ts`, `prompts.ts`; preserve other sources' manual merge rules.

## 4. Deployment and verification

Run focused tests while implementing, then one final `pnpm check`. Use a throwaway local HTTP/Git smoke scenario to exercise source→ticket→pause and source→fix→release→resolution paths without modifying real company bugs. Verify real ZenTao login/list/detail and local panel fields. Configure the current installation with product/account/credentials and its scoped policy, preserving unrelated settings and existing tickets. Verify source health and restart deduplication. Update `docs/006-deployment.md`, README and the task tracker with actual results and any unavailable live-fix verification.
