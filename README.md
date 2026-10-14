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

Two prerequisites. `pi-durable-subagents` must be on `PATH` (`npm i -g pi-durable-subagents`), or named by the `command` option. Without it every start fails with a message saying so rather than retrying.

The plugin is not on npm yet, so install it from the repository:

```sh
npm i -g pi-durable-subagents
dsh plugin --profile web add github:Tim-ReJet/dsh-plugin-durable-subagent
```

The install runs `prepare`, which builds `lib/` from TypeScript. Once the package is published the shorter form works:

```sh
dsh plugin --profile web add dsh-plugin-durable-subagent
```

The bundle patch inserts one row, `durable-subagent`.

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

- **A linked plugin resolves its imports from its own repository.** `dsh plugin add <path>` records a `link:`, and Node follows the symlink to the plugin's real path, so `@deepseek-ai/*` is resolved from the plugin directory and never from the profile. The local install must therefore carry a complete closure: `npm install` resolves this package's harness peers, while `npm install --legacy-peer-deps` leaves `@deepseek-ai/dsh-tools` without the nine packages it declares as peers, and the profile then fails to boot with `failed to import loader entry durable-subagent (dsh-plugin-durable-subagent): Cannot find package '@deepseek-ai/dsh-scope'`. A published install from npm does not have this problem.
- **`cwd` is part of the submission digest.** A retry from a different working directory is a `request-conflict` rather than the first outcome. The default is stable for the life of the harness process; a per-session `cwd` is not yet wired.
- **The provider cannot be replay-stable.** `ResolvedSubagentStartRequest` carries no call identity, so only the tool path gets one execution per call. Making the provider path exact needs a durable run identity on the request; that is a harness change.
- **`dispose()` stops a run but does not await quiescence.** The orchestrator is a separate process and owns its own teardown, so the run handle cannot observe the child's exit.
- **No continuable children and no Agent Teams membership.** `prepareContinuable` is deliberately not implemented: `spawn_teammate` and cold resume need a durable child session this provider does not create.
- **No tool filtering, persona, or delegation depth.** The provider reports `outputSchema` only; a request needing another capability is rejected loudly by the subagent service rather than silently ignored.
- **`outputSchema` validation is delegated.** `pi-durable-subagents` validates a `report` against the schema it was handed before sealing, so a sealed `data` payload is schema-valid; the plugin does not re-validate it.
- **The orchestrator is not supervised.** The plugin neither starts nor restarts `pi-durable-subagents`; it relies on the orchestrator's own lazy start, lock, and idle exit. Running it under `ctx.subprocess` would make harness disposal kill it.
- **A failure is per call.** A workflow reports `status: "done"` even when every call inside it failed, and `output`/`error` live on the calls. `summarize()` reads them there; the read-only `status` view alone would call a failed delegation completed.

## Verification

Phase 0 exercised the real `pi-durable-subagents` 1.0.39 CLI against a real orchestrator, and mounted the bundle into a real DeepSeek Harness profile.

| Check | Result |
| --- | --- |
| `npm run typecheck` against published `@deepseek-ai/dsh-subagent`/`dsh-tools` 0.1.1-rc.2, `cordis` 4.x, `schemastery` 3.x | clean |
| `node --test` keyless suite (fixture CLI, no harness and no pi) | 32 passed |
| `dsh-plugin-doctor` | 10 passed, 0 errors; remaining items are a new repository's age and remote |
| `npm run build` + `npm pack --dry-run` | emits `lib/*.js` + `lib/types/*.d.ts`; 22 files |
| `describe --key <id> --json` reply shapes | confirmed against the real CLI; payloads pinned in `test/fixtures/real-replies.json` |
| `converge()` against the real CLI, after a "crashed" caller left a durable decision | one read, **zero** submissions; the retry returned the first `wid` |
| Identical resubmission under one id | exit 0 with the same `wid` and `created: false` |
| Same id, different content | exit 3 `request-conflict`, `state` echoed |
| Bundle installed with `dsh plugin --profile web add`, composed tree | row `durable-subagent` present with its config |
| Headless boot with the plugin mounted | loader entries activate; the run stops at `MISSING_CREDENTIAL`, not at the plugin |
| A model-driven `durable_subagent` call in a live session | verified end to end: `run` → `status` ×2 → `sealed`, addressed by `request` |
| The same call driven by the wid instead of the request id | returns `absent`; the render now leads with `request=` for this reason |
| A real `pi` 1.0.2 child completing a model call | **not verified**: the throwaway `pi` had no hydrated model catalog and reported `Unknown provider: unknown` |
| An orchestrator crash between decision and execution | **not verified**; the crash window tested is the caller's |

### Phase 0 evidence

Submitting one id twice against the real CLI:

```text
$ pi-durable-subagents run --request spike-1 --spec spec.json --json
{"request":"spike-1","wid":"01M4THR3CMT54R65BASRA9QX3V","created":true,"spec_digest":"3a8fdf42…"}
$ pi-durable-subagents run --request spike-1 --spec spec.json --json
{"request":"spike-1","wid":"01M4THR3CMT54R65BASRA9QX3V","created":false,"spec_digest":"3a8fdf42…"}
```

Driving this plugin's own `converge()` at the real CLI through a shim that logs every invocation, where the first caller submitted and then "died" without reading its reply:

```text
CLI invocations: run -> describe -> describe -> run -> describe -> describe -> run
converge after the crash: running (wid 01M4THR3CMT54R65BASRA9QX3V)
```

The three `run` calls are the crashed caller, one fresh-id convergence, and a deliberate conflicting probe. `converge` issued none of them for the already-decided id.

A workflow whose only call failed reports `status: "done"`:

```text
$ pi-durable-subagents describe --key spike-1 --json
{"state":"sealed","status":"done","calls":[{"status":"failed","ok":false,"error":"lost ×5","output":""}]}
```

This is why `summarize()` reads success per call. The run cost nothing: `usage` was `0` in and `0` out.

### Phase 0b evidence

A real DeepSeek Harness headless session, with the bundle mounted and a real `pi-durable-subagents` 1.0.39 CLI on `PATH`, was asked to delegate one task. Its own report:

```text
- Request id: df9631829b6-call-00-xnXLGCeOhmS8M4PETs0m0219-e847ef97bab53919
- Final state: sealed
- Succeeded: No — the delegation failed.
- Output / error (verbatim):
  sealed: request=df9631829b6-…-e847ef97bab53919 (wid 01M4TJKGB6Q3ZX7XNCKW5DX2PG) —
  failed: lost ×5; last error: Unknown provider: unknown
```

Three things came out of this run. The handle is addressable: the model read `request=` from the render and every `status` call resolved, where the first attempt (which rendered only the wid) got `absent` four times. The call-level failure mapping works in production: a workflow whose only call died is reported as failed with the child's own error, not as a completed delegation with empty output. And the request id is now on-grammar — the tool call id was `call_00_zkMrBAcVpchoWOd2TzA93108`, whose underscores are outside `[A-Za-z0-9][A-Za-z0-9._:-]*`.

The child itself never reached a model: the throwaway `pi` 1.0.2 installation had no hydrated model catalog, so it started as `unknown/unknown`. `pi auth check --provider deepseek` reported `invalid_state` both before and after `DEEPSEEK_API_KEY` was supplied from the harness credential store, which is a property of that fresh installation rather than of this plugin.

## License

MIT. `pi-durable-subagents` is MIT, © purboo, and adapts parts of [`pi-subagents`](https://github.com/nicobailon/pi-subagents) (MIT, © Nico Bailon), which this plugin neither vendors nor redistributes. DeepSeek Harness is MIT.
