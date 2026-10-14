/**
 * The `durable` subagent provider.
 *
 * One delegation becomes one pi-durable-subagents request, and the run handle's
 * result is the durable record's own verdict rather than a process exit code.
 *
 * Idempotency note: the provider boundary receives no tool call identity
 * (`ResolvedSubagentStartRequest` carries no `callId`), so it cannot mint the
 * replay-stable id that `converge` is designed around. The model-facing tool in
 * `./tool.ts` owns that identity and submits directly. This provider exists for
 * consumers that reach the run through `ctx.subagents` and choose its
 * idempotency mode through configuration.
 *
 * @module dsh-plugin-durable-subagent/provider
 */
import { randomUUID } from 'node:crypto';
import { converge, settle, summarize } from "./core.js";
import { requestIdForContent, scopedRequestId } from "./ids.js";
/** The diagnostic limit the seam sets for provider-authored failure text. */
const DIAGNOSTIC_LIMIT = 4096;
/** The capabilities this provider can honour. */
const CAPABILITIES = {
    // pi-durable-subagents validates a `report` against the schema it was given
    // before sealing, so a sealed `data` payload is already schema-valid.
    outputSchema: true,
    // pi-durable-subagents refuses nested subagents.
    depthLimit: false,
    // Tool scoping would have to be translated into the run spec's `tools` list.
    toolFilter: false,
    // A persona is an agent definition here, not a per-child prompt section.
    persona: false,
};
const textBlock = (text) => ({ type: 'text', text });
const clip = (text) => text.length > DIAGNOSTIC_LIMIT ? text.slice(0, DIAGNOSTIC_LIMIT) : text;
/**
 * The text of the prompt blocks a model wrote.
 * @param prompt - the child's user message content.
 * @returns the concatenated text blocks.
 */
export function promptText(prompt) {
    const parts = [];
    for (const block of prompt) {
        if (typeof block !== 'object' || block === null)
            continue;
        const record = block;
        if (record.type === 'text' && typeof record.text === 'string')
            parts.push(record.text);
    }
    return parts.join('\n\n');
}
/**
 * Map one durable snapshot onto the seam's terminal result.
 *
 * Success is read per call, not from the workflow's `status`: a workflow whose
 * calls all failed still reports `done`.
 *
 * @param snapshot - the sealed, rejected, or unreadable snapshot.
 * @returns the result the run handle resolves with.
 */
export function toResult(snapshot) {
    if (snapshot === undefined) {
        return { output: [], stopReason: 'error', diagnostic: 'no durable state was read for this request' };
    }
    if (snapshot.state === 'rejected' || snapshot.state === 'pruned') {
        const detail = snapshot.reason ?? snapshot.readError ?? `the request was ${snapshot.state}`;
        return { output: [], stopReason: 'error', diagnostic: clip(detail) };
    }
    const summary = summarize(snapshot);
    const output = summary.output.length > 0 ? [textBlock(summary.output)] : [];
    const stopped = snapshot.status === 'stopped' || snapshot.calls.some(call => call.status === 'stopped');
    const stopReason = !summary.ok ? 'error' : stopped ? 'aborted' : 'completed';
    return {
        output,
        ...snapshot.structured !== undefined ? { structured: snapshot.structured } : {},
        ...summary.diagnostic !== undefined ? { diagnostic: clip(summary.diagnostic) } : {},
        stopReason,
    };
}
/** The run spec pi-durable-subagents accepts for one delegation. */
function buildSpec(request, agent) {
    const task = promptText(request.prompt);
    return {
        agent,
        task,
        ...request.label !== undefined ? { name: request.label } : {},
        ...request.outputSchema !== undefined ? { schema: request.outputSchema } : {},
    };
}
/**
 * Build the provider that registers on `ctx.subagents`.
 * @param options - provider configuration.
 * @returns the provider.
 */
export function createDurableProvider(options) {
    return {
        name: options.providerName,
        capabilities: CAPABILITIES,
        inheritsParentContext: false,
        async start(request) {
            const sessionId = request.parent.session.id;
            const spec = buildSpec(request, options.agent);
            const requestId = options.idempotency === 'content'
                ? requestIdForContent({ sessionId, parts: [spec] })
                : scopedRequestId(sessionId, `run-${randomUUID()}`);
            if (request.signal.aborted)
                throw new Error('the delegation was cancelled before it started');
            const outcome = await converge(options.client, { requestId, spec }, {
                ...options.attempts !== undefined ? { attempts: options.attempts } : {},
            });
            if (outcome.kind === 'failed')
                throw new Error(`durable delegation failed to start: ${outcome.message}`);
            if (outcome.kind === 'rejected')
                throw new Error(`durable delegation was rejected: ${outcome.reason}`);
            if (request.signal.aborted) {
                await options.client.stop(scopedRequestId(sessionId, `cancel-${randomUUID()}`), requestId);
                throw new Error('the delegation was cancelled during submission');
            }
            const wid = outcome.wid ?? requestId;
            let settled = false;
            let disposed = false;
            const result = (async () => {
                try {
                    if (outcome.kind === 'sealed')
                        return toResult(outcome.snapshot);
                    const final = await settle(options.client, requestId, {
                        ...options.settleTimeoutMs !== undefined ? { timeoutMs: options.settleTimeoutMs } : {},
                        ...options.pollIntervalMs !== undefined ? { intervalMs: options.pollIntervalMs } : {},
                    });
                    if ('last' in final) {
                        return {
                            output: [],
                            stopReason: 'error',
                            diagnostic: `the durable call did not settle within the wait; its last state was ${final.last.state}`,
                        };
                    }
                    return toResult(final);
                }
                finally {
                    settled = true;
                }
            })();
            return {
                id: wid,
                localAgent: undefined,
                result,
                dispose: async () => {
                    if (disposed)
                        return;
                    disposed = true;
                    if (settled)
                        return;
                    await options.client.stop(scopedRequestId(sessionId, `stop-${randomUUID()}`), requestId);
                },
            };
        },
    };
}
//# sourceMappingURL=provider.js.map