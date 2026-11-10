# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub or self-managed GitLab repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to the selected hosting Source and, optionally, Feishu. When someone allowed asks for work, it opens a work item, works in its own agent session and directory, and answers in the original conversation with a PR or MR. A web panel shows what needs a person. GitLab uses native `glab` and project polling, including intranet HTTP(S), nested namespaces and custom ports; no GitHub mirror or public webhook is required. See [deployment](docs/006-deployment.md#self-managed-gitlab).

Repository hosting defaults to **Automatic**: configure GitHub **or** GitLab, not both. When exactly one host has its repository and agent CLI configured (plus GitLab's host URL), setup uses it. If both are configured, choose one explicitly under **Settings → Execution**. Authentication failure never silently changes the target repository.

Optional [ZenTao intake](docs/006-deployment.md#zentao-assigned-bugs-optional) handles assigned bugs through reproduction, verified repair, a `develop` MR merge, fix-only cherry-pick to `test`, Jenkins deployment and live verification. Blocked or nonexistent bugs receive an evidence note and remain paused until an operator retries. Other Sources retain their existing merge policy.

Optional [Android tasks and conversations](docs/009-mobile.md): a small WebView app with task lists, progress/results and shared DSH conversations on a trusted private network. A separate password-protected HTTP gateway exposes task reads and allowlisted conversation operations; ordinary, main and task-worker sessions support text input and stopping. No separate accounts, push notifications or tunnels.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Mobile tasks and conversations](docs/009-mobile.md): Android APK, private HTTP gateway and password setup

## Development

`pnpm check` runs the typecheck, the tests and the build.

Before optimizing this project, read `scripts/dsh-superagent optimization` and `scripts/dsh-superagent optimization --view lessons`. Start with recurring observed problems, verify against current code, compare the same scenario before/after the smallest change, then record the measured result. Unverified ideas stay hypotheses. See [project optimization records](docs/006-deployment.md#project-optimization-records); no automatic self-modification is enabled.

## License

[MIT](LICENSE)
