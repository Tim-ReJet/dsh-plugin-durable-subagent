/**
 * Request-id derivation for the pi-durable-subagents `--request` contract.
 *
 * The CLI treats `--request <id>` as the identity of a submission: the first
 * submission under an id is decided once, and every later retry carrying the
 * same content gets that first outcome. That makes the id the place where a
 * harness-side idempotency key has to be spelled.
 *
 * A harness call identity (`exec.callId`) is only unique inside one session, and
 * the CLI requires ids to be unique per `DSA_HOME` across `run`, `send`, and
 * `stop`. {@link scopedRequestId} therefore mixes the durable session identity
 * into every id it mints.
 *
 * @module dsh-plugin-durable-subagent/ids
 */
/** Maximum `--request` id length the CLI accepts. */
export declare const REQUEST_ID_MAX_LENGTH = 124;
/**
 * A hexadecimal prefix of the SHA-256 of `value`.
 * @param value - the text to hash.
 * @param length - number of hexadecimal characters to keep.
 * @returns the lowercase hexadecimal prefix.
 */
export declare function shortHash(value: string, length?: number): string;
/**
 * Build a request id that is stable for one `(scope, local)` pair and distinct
 * across scopes and locals.
 *
 * The readable part is sanitized for operators reading `status`; the trailing
 * hash is taken over the raw inputs, so two locals that sanitize to the same
 * text still mint different ids.
 *
 * @param scope - durable identity the local id is unique within, typically a session id.
 * @param local - the local identity, typically a tool call id.
 * @returns a request id the CLI accepts.
 */
export declare function scopedRequestId(scope: string, local: string): string;
/**
 * The request id for one model-facing tool call.
 *
 * Stable across a crash and replay of the same call, because both inputs are
 * durable session facts.
 *
 * @param input - the calling agent's session id and the execution's call id.
 * @returns a request id the CLI accepts.
 */
export declare function requestIdForToolCall(input: {
    readonly sessionId: string;
    readonly callId: string;
}): string;
/**
 * The request id for a delegation identified only by its content.
 *
 * Used where no call identity reaches the provider. Deterministic, so a retry of
 * an identical delegation converges on the first outcome; two legitimately
 * identical delegations from one session collide, which the CLI reports as
 * `request-conflict`. Callers that need one execution per call must pass a call
 * identity instead.
 *
 * @param input - the calling agent's session id and the values that identify the delegation.
 * @returns a request id the CLI accepts.
 */
export declare function requestIdForContent(input: {
    readonly sessionId: string;
    readonly parts: readonly unknown[];
}): string;
/**
 * Whether the CLI accepts `value` as a `--request` id.
 * @param value - the candidate id.
 * @returns true when the id satisfies the grammar and length bound.
 */
export declare function isRequestId(value: string): boolean;
