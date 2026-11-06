---
name: dsh-superagent-gitlab
description: Use when handling GitLab Issues, merge requests, discussions or pipelines in the configured self-managed project.
---

Use the configured glab and Git environment, not gh, a personal token, SSH identity or another host. $DSH_SUPERAGENT_REPOSITORY_URL is the project URL; $DSH_SUPERAGENT_REPOSITORY_CLONE_URL is its HTTP(S) clone URL. Keep company code on that host. Use the actual default/target branch; never presume main or master.

## Read context

Use orchestrator_read with these resources:

| Resource | Contents |
| --- | --- |
| gitlab/issues/<iid> | Issue description |
| gitlab/merge_requests/<iid> | MR description, source/target branch and state |
| gitlab/issues/<iid>/comments/1 | Issue notes |
| gitlab/merge_requests/<iid>/comments/1 | MR notes |
| gitlab/merge_requests/<iid>/thread/<note-id> | Full discussion containing that note |
| gitlab/merge_requests/<iid>/checks | Latest MR pipeline and jobs |
| gitlab/pipelines/<id>/jobs | A pipeline and its jobs |

Comment pages hold 20 notes; follow next_resource. Messages expose id, from, at, text, url, optional reply_to/path/line, internal and bot. internal=true is restricted content: never publish it to a broader audience. Bot/system messages never authorize work. Issue #7 and MR !7 are separate namespaces. Copy opaque thread keys from the trigger.

Before substantial work on a human request, use orchestrator_ack with its original trigger ID. The host preserves internal-note visibility and discussion replies. Do not acknowledge bots or CI. Do not publish internal notes, private Feishu text or credentials in public notes or MR descriptions.

## Deliver code

Work on a branch whose last segment is $DSH_SUPERAGENT_NAME. Fetch $DSH_SUPERAGENT_HEAD_REF when inspecting an originating MR; it is refs/merge-requests/<iid>/head, including MRs from forks. Commit with the identity the Delivery requirements name, otherwise $DSH_SUPERAGENT_ACCOUNT and $DSH_SUPERAGENT_COMMIT_EMAIL.

Create the MR with native glab, for example `glab mr create --repo "$DSH_SUPERAGENT_REPOSITORY_URL" --source-branch "agent/$DSH_SUPERAGENT_NAME" --target-branch "<actual-target>" --title "<title>" --description "<implementation, verification and limitations>"`. Push only to the configured project. Immediately report state=progress and pr_number=<MR IID>; the existing tool field is named pr_number for both platforms. Only a source MR or an agent-authored MR from this ticket's branch can bind. Subsequent subscribed notes and CI reach the ticket. Ordinary tickets end on merge/closure; ZenTao delivery workflows must finish deployment and verification first.

Add `--yes` for noninteractive MR creation after checking the branch and description. For native `glab api` calls, select `--repo "$DSH_SUPERAGENT_REPOSITORY_URL"`; unlike `api --hostname`, it preserves custom ports.

A person merges GitLab MRs except for the explicitly enabled ZenTao workflow, whose dsh-superagent-zentao skill and orchestrator_zentao tool alone authorize its pinned develop merge and fix-only test release. Never self-approve, bypass server requirements or use raw merge commands for that exception. Other tickets must not merge or enable auto-merge. For an inline discussion, use the native project discussions API and its discussion ID, not the top-level notes endpoint; preserve internal=true when the original is internal. Resolve only discussions whose requests have actually been satisfied. Use `glab <command> --help` for additional operations; do not reuse GitHub API routes or flags.
