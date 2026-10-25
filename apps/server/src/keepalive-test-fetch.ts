/**
 * fetch for a suite whose server runs in the suite's own process (startHttpsServer): the same call, with one turn of the
 * event loop first when the last call here settled more than 4 s ago.
 *
 * The server closes a connection idle for its 5 s keep-alive (server-limits.ts), but only when its event loop gets a
 * turn. After a long synchronous stretch in the suite (rows written by the thousand, an invite chain built, work solved:
 * all several times slower on CI's machine, 8-20x for some), that close is due and has not run: fetch reuses the pooled
 * socket just as the server closes it, and fails with `TypeError: fetch failed` (read ECONNRESET). CI's Node 22 does
 * this about half the time, this Mac's Node 26 never. CI run 36913140237: test-report-rings, its first call after a
 * 300-deep invite chain. The turn lets the close run first, and fetch opens a new socket.
 *
 * Measured with a plain https server in one process on Node 22.23 (6 s held between two calls): fetch reset on 30 of 90
 * tries, this on none of 90.
 */
let lastSettledAt = performance.now();

export async function localFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (performance.now() - lastSettledAt > 4_000) await new Promise((r) => setTimeout(r, 100));
    try {
        return await fetch(input, init);
    } finally {
        lastSettledAt = performance.now();
    }
}
