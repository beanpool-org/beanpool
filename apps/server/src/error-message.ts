/**
 * Read a human-readable message off a caught value, whatever that value turns out to be.
 *
 * WHY THIS EXISTS. `catch (e: any)` types the caught value as `any`, so `e.message` compiles — but JavaScript
 * lets anything be thrown, and a rejected promise can carry `undefined`, a bare string, or a plain object. On
 * those, `e.message` throws a TypeError from inside the error handler. #1033 stopped that crashing the node by
 * wrapping the handshake round in an outer try, but a throw inside a PER-PEER handler still escapes that
 * peer's catch and abandons the rest of the round: one peer failing oddly starves every peer after it.
 *
 * Behaviour is unchanged for a normal Error — `errorMessage(new Error('boom'))` is `'boom'` — so call sites
 * keep their existing status text and log lines. The fallback only applies when there is no usable message.
 */
export function errorMessage(e: unknown, fallback = 'Unknown error'): string {
    let raw: unknown;
    try {
        raw = (e as { message?: unknown } | null | undefined)?.message ?? e;
    } catch {
        // A getter on `message` can itself throw. Nothing this function does may throw, or it reintroduces
        // exactly the failure it exists to prevent.
        return fallback;
    }
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw === 'string') return raw === '' ? fallback : raw;
    let text: string;
    try {
        // A `toString`/`Symbol.toPrimitive` on a thrown object can throw, and an object with a null prototype
        // has no `toString` at all.
        text = String(raw);
    } catch {
        return fallback;
    }
    return text === '' ? fallback : text;
}
