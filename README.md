# dsh-plugin-durable-subagent

Durable subagent execution for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It registers a `durable` provider on `ctx.subagents` and a model-facing `durable_subagent` tool, both driving [`pi-durable-subagents`](https://github.com/purboo/pi-durable-subagents).

The point of the pairing is one guarantee: **a delegation the harness accepted before a crash is read back, not run again.**

## Where the guarantee comes from

DeepSeek Harness durably records execution intent and does not promise exactly-once effects. Its session checkpoint policy states the convention this plugin implements:

> "The policy durably records execution intent, not generic exactly-once effects. Side-effecting tools should forward `exec.callId` as an idempotency key when their provider supports one."
> — `@deepseek-ai/dsh-session-checkpoint-policy`

`pi-durable-subagents` accepts exactly that key as `--request <id>`: the first submission under an id is decided once, and every later retry carrying the same content gets that first outcome. So the harness supplies durable intent plus the key, and the durable orchestrator supplies the single decision.

The join is a read-before-write state machine. Every attempt reads `describe --key <id>` first and only submits when the id is undecided, so a process that died between deciding a submission and reporting it leaves a durable decision that the next attempt reads instead of executing. The keyless test suite pins that path; the traced CLI invocation sequence is `describe → run → describe` with one execution recorded.

## Install

```sh
dsh plugin --profile web add dsh-plugin-durable-subagent
```

The bundle patch inserts one row, `durable-subagent`. It requires `pi-durable-subagents` on `PATH` (`npm i -g pi-durable-subagents`), or a `command` that names it; without one, every start fails with a message saying so rather than retrying.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | `durable` | Registry name on `ctx.subagents`. |
| `command` | `pi-durable-subagents` | Executable, argv[0] only. |
| `commandArgs` | `[]` | Arguments before the subcommand, for a launcher rather than a bare executable. |
| `home` | — | `DSA_HOME` for every invocation. |
| `agent` | `worker` | The pi agent definition a delegation runs as unless the call names another. |
| `cwd` | the harness process's working directory | Working directory of every invocation. A run's cwd is part of the content the CLI hashes. |
| `idempotency` | `unique` | How the **provider** mints request ids: `unique` (one per start) or `content` (one per identical delegation). The tool always uses the call identity. |
| `attempts` | `3` | Submission attempts before a start fails. |
| `settleTimeoutMs` | `600000` | How long a run handle waits for the durable verdict. |
| `pollIntervalMs` | `1000` | Poll interval while waiting. |
| `timeoutMs` | `120000` | Per-invocation deadline for the CLI. |
| `enableTool` | `true` | Register the model-facing tool. |
| `tool` | `durable_subagent` | Model-facing tool name. |

## How a call becomes a durable request

1. The harness checks the call's intent durably, then runs the tool body with `exec.callId`.
2. The tool derives a request id from the calling session id and `exec.callId`, so a replay of the same call re-derives the same id.
3. The plugin reads the id's durable state. Only `absent` and `pending` proceed to `run`; `running` and `asking` return as they are, and `sealed`, `rejected`, and `pruned` are terminal.
4. `run --request <id> --spec - --cwd <cwd> --json` either decides the request, returns the first outcome, or reports `75` (not decided yet), in which case the next attempt reads the durable state again before resubmitting.

The provider path reaches `ctx.subagents` instead, where no call identity is available (`ResolvedSubagentStartRequest` carries none). It therefore mints ids from configuration: `unique` never conflicts but is not replay-stable, `content` is replay-stable but two identical delegations from one session collide as `request-conflict`. Pick `content` only when the delegations are content-distinct.

## Model Experience

### The tool

`durable_subagent` takes `action` (`run`, `status`, `answer`, `steer`, `notify`, `stop`), plus `task`, `agent`, `to`, `message`, `qid`, and `rev` as each action needs.

`run` returns as soon as the delegation is decided, not when its work finishes, and reports `sealed`, `running`, `pending`, or `asking` with the `request` address. `status` reads that address again; an `asking` state carries the question id and revision that `answer` needs. Nothing is polled on the model's behalf, so a long delegation costs no tokens while it runs.

### Token effect

A `run` reply is one short line. Reading a finished delegation returns its output; reading a running one returns a state name. No child transcript enters the parent's history.

### KV cache effect

Tool calls append after the reusable history prefix. Nothing here rewrites earlier messages.

## Known Limitations and Deferred Work

- **The `describe --json` field mapping is unverified against a live CLI.** The parser reads a `state` field and otherwise infers the state from the fields the documented vocabulary pairs with it; `test/describe.test.ts` pins both. Confirm against a real `pi-durable-subagents describe --key <id> --json` before relying on the inference path.
- **`cwd` is part of the submission digest.** A retry from a different working directory is a `request-conflict` rather than the first outcome. The default is stable for the life of the harness process; a per-session `cwd` is not yet wired.
- **The provider cannot be replay-stable.** `ResolvedSubagentStartRequest` carries no call identity, so only the tool path gets one execution per call. Making the provider path exact needs a durable run identity on the request; that is a harness change.
- **`dispose()` stops a run but does not await quiescence.** The orchestrator is a separate process and owns its own teardown, so the run handle cannot observe the child's exit.
- **No continuable children and no Agent Teams membership.** `prepareContinuable` is deliberately not implemented: `spawn_teammate` and cold resume need a durable child session this provider does not create.
- **No tool filtering, persona, or delegation depth.** The provider reports `outputSchema` only; a request needing another capability is rejected loudly by the subagent service rather than silently ignored.
- **`outputSchema` validation is delegated.** `pi-durable-subagents` validates a `report` against the schema it was handed before sealing, so a sealed `data` payload is schema-valid; the plugin does not re-validate it.
- **The orchestrator is not supervised.** The plugin neither starts nor restarts `pi-durable-subagents`; it relies on the orchestrator's own lazy start, lock, and idle exit. Running it under `ctx.subprocess` would make harness disposal kill it.

## Verification

| Check | Result |
| --- | --- |
| `tsc --noEmit` against published `@deepseek-ai/dsh-subagent`/`dsh-tools` 0.1.1-rc.2, `cordis` 4.x, `schemastery` 3.x | clean |
| `node --test` keyless suite (fixture CLI, no harness and no pi) | 25 passed |
| `dsh-plugin-doctor` | 10 passed, 0 errors, 1 warning (no origin remote), 2 skipped (repo age, topic) |
| A live `pi-durable-subagents` binary, a real harness boot, and a real crash | **not verified** |

## License

MIT. `pi-durable-subagents` is MIT, © purboo, and adapts parts of [`pi-subagents`](https://github.com/nicobailon/pi-subagents) (MIT, © Nico Bailon), which this plugin neither vendors nor redistributes. DeepSeek Harness is MIT.
