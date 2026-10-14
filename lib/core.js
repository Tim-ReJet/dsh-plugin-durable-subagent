/**
 * The convergence state machine.
 *
 * DSH's session checkpoint policy durably records execution intent and tells
 * side-effecting tools to forward `exec.callId` as an idempotency key; it does
 * not promise exactly-once effects. pi-durable-subagents decides one request id
 * once. {@link converge} joins the two: read the durable state first, submit
 * only when the id is undecided, and never re-submit an id the CLI has already
 * decided.
 *
 * The read-before-write order is what makes a crash converge. A process that
 * died between deciding a submission and reporting it leaves a durable decision
 * behind; the next attempt reads it instead of executing again.
 *
 * @module dsh-plugin-durable-subagent/core
 */
const defaultSleep = async (ms) => {
    await new Promise(resolve => { setTimeout(resolve, ms); });
};
const describe2string = (snapshot) => snapshot.readError ?? snapshot.reason ?? snapshot.error ?? snapshot.status ?? snapshot.state;
function terminal(snapshot) {
    switch (snapshot.state) {
        case 'sealed':
            return { kind: 'sealed', ...snapshot.wid !== undefined ? { wid: snapshot.wid } : {}, snapshot };
        case 'rejected':
            return { kind: 'rejected', reason: `the request was rejected: ${describe2string(snapshot)}` };
        case 'pruned':
            return { kind: 'rejected', reason: `the request was pruned: ${describe2string(snapshot)}` };
        default:
            return undefined;
    }
}
function observation(snapshot, fallbackWid) {
    const wid = snapshot.wid ?? fallbackWid;
    const withWid = wid !== undefined ? { wid } : {};
    switch (snapshot.state) {
        case 'asking':
            return { kind: 'asking', ...withWid, questions: snapshot.questions, snapshot };
        case 'running':
            return { kind: 'running', ...withWid, snapshot };
        case 'pending':
            return { kind: 'pending', ...withWid, snapshot };
        default:
            // A read the CLI could not answer does not un-apply a submission.
            return { kind: 'running', ...withWid, snapshot };
    }
}
/**
 * Submit one delegation at most once, and report what the durable record says.
 *
 * Terminal states are returned from the read alone, so a retry after a crash
 * never reaches the CLI's `run`.
 *
 * @param client - the CLI client.
 * @param request - the delegation.
 * @param options - retry tuning.
 * @returns the outcome, never throwing for a rejected or undecided request.
 */
export async function converge(client, request, options = {}) {
    const attempts = Math.max(1, options.attempts ?? 3);
    const delayMs = options.delayMs ?? 250;
    const sleep = options.sleep ?? defaultSleep;
    let snapshot = await client.describe(request.requestId);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        options.onAttempt?.(attempt, snapshot);
        const decided = terminal(snapshot);
        if (decided !== undefined)
            return decided;
        // Already underway or waiting on a question: submitting again would be a
        // no-op at best and must not be mistaken for a new execution.
        if (snapshot.state === 'running' || snapshot.state === 'asking')
            return observation(snapshot);
        const submitted = await client.submit(request.requestId, request.spec);
        switch (submitted.kind) {
            case 'applied': {
                const after = await client.describe(request.requestId);
                return terminal(after) ?? observation(after, submitted.wid);
            }
            case 'rejected':
                return { kind: 'rejected', reason: `the request was rejected: ${submitted.reason ?? 'no reason given'}` };
            case 'conflict':
                return {
                    kind: 'failed',
                    message: `request id ${request.requestId} already names other content, so nothing was sent`
                        + (submitted.reason !== undefined ? `: ${submitted.reason}` : ''),
                };
            case 'failed':
                if (!submitted.retryable)
                    return { kind: 'failed', message: submitted.message };
                break;
            case 'pending':
                break;
        }
        if (attempt < attempts) {
            await sleep(delayMs);
            snapshot = await client.describe(request.requestId);
        }
    }
    return {
        kind: 'failed',
        message: `the submission stayed undecided after ${attempts} attempts (last read: ${describe2string(snapshot)})`,
    };
}
/**
 * Read a workflow's real outcome.
 *
 * A workflow's own `status` is `done` even when every call inside it failed, and
 * `output` and `error` live on the calls rather than at the top level. Verified
 * against `pi-durable-subagents` 1.0.39: a run whose only call was `lost ×5`
 * reports `{"state":"sealed","status":"done","calls":[{"status":"failed","ok":false,"error":"lost ×5"}]}`.
 *
 * @param snapshot - one durable state read.
 * @returns the outcome a consumer should present.
 */
export function summarize(snapshot) {
    const failed = snapshot.calls.filter(call => call.ok === false || call.status === 'failed');
    const callOutput = snapshot.calls
        .map(call => call.output ?? '')
        .filter(text => text.length > 0);
    const output = snapshot.output !== undefined && snapshot.output.length > 0
        ? snapshot.output
        : callOutput.join('\n');
    const detail = failed.find(call => call.error !== undefined && call.error.length > 0)?.error
        ?? snapshot.error
        ?? snapshot.readError
        ?? snapshot.calls.find(call => call.error !== undefined && call.error.length > 0)?.error
        ?? attentionText(snapshot.raw);
    return {
        ok: failed.length === 0,
        output,
        ...detail !== undefined && detail.length > 0 ? { diagnostic: detail } : {},
    };
}
/**
 * The first attention line a snapshot carries, when it has one.
 * @param raw - the parsed reply.
 * @returns the attention text, or undefined.
 */
function attentionText(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const attention = raw.attention;
    if (!Array.isArray(attention))
        return undefined;
    for (const entry of attention) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const text = entry.text;
        if (typeof text === 'string' && text.length > 0)
            return text;
    }
    return undefined;
}
/**
 * Poll one request until it settles.
 *
 * @param client - the CLI client.
 * @param requestId - the durable request identity.
 * @param options - poll tuning.
 * @returns the terminal snapshot, or the last read with state `timeout`.
 */
export async function settle(client, requestId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const intervalMs = options.intervalMs ?? 1000;
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const deadline = now() + timeoutMs;
    let snapshot = await client.describe(requestId);
    for (;;) {
        if (snapshot.state === 'sealed' || snapshot.state === 'rejected' || snapshot.state === 'pruned')
            return snapshot;
        if (now() >= deadline)
            return { state: 'timeout', last: snapshot };
        await sleep(intervalMs);
        snapshot = await client.describe(requestId);
    }
}
//# sourceMappingURL=core.js.map