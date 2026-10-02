/**
 * Whether this page may still write the account's state to this browser (PR #1479's review: a second tab still on Home
 * put the member's Home back on disk after Sign Out in another tab, from a Hide there, a read in flight, or its next read).
 *
 * Every routine that clears the account's storage ends the epoch first ({@link endAccountEpoch}):
 *   - 'signed-out': the account leaves this browser. Sign Out (Device Only) and the delete at the last community
 *     (lib/device-prefs.ts `clearAccountStorage`). A page that started before it writes nothing more for that account,
 *     ever: its pages drop what they hold and stop reading as it, until the page is loaded again.
 *   - 'cleared': the account stays, what was kept of it goes. Leaving a community the web app was pointed at, and Force
 *     Clear & Re-Sync (lib/home-cache.ts `clearHomeCache`). A read or a save started before it ({@link accountEpoch}) is
 *     dropped when it lands, and Home reads afresh.
 *
 * The end is kept in localStorage, which every tab of this web address shares, and said on a BroadcastChannel. Each page
 * hears it at once (the `storage` event, the channel: {@link onAccountEpochEnd}), and checks again before every write
 * ({@link accountEpochHolds}), so a page that missed both still finds it. The clear routines keep the value across their
 * own wipe of localStorage.
 *
 * Kept as `<count>.<sign-out token>.<clear token>`: a sign-out gives both tokens anew, a clear only the second. A page
 * compares the sign-out token with the one it started under, so it tells a sign-out from a clear whatever came after; the
 * count lets it ignore a value older than one it has already taken in (one tab's view of storage can lag the channel).
 */

export const ACCOUNT_EPOCH_KEY = 'beanpool_account_epoch';
export const ACCOUNT_EPOCH_CHANNEL = 'beanpool-account-epoch';

export type AccountEpochEnd = 'signed-out' | 'cleared';

interface Epoch { n: number; signOut: string; clear: string }
const START: Epoch = { n: 0, signOut: '0', clear: '0' };

function parse(raw: unknown): Epoch | null {
    if (typeof raw !== 'string' || raw.length > 100) return null;
    const [n, signOut, clear] = raw.split('.');
    const count = Number(n);
    return Number.isSafeInteger(count) && count >= 0 && signOut && clear ? { n: count, signOut, clear } : null;
}

function stored(): string | null {
    try { return localStorage.getItem(ACCOUNT_EPOCH_KEY); } catch { return null; }
}

const token = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** The epoch this page holds: the one it started under, then each end it has taken in. */
let held: Epoch = parse(stored()) ?? START;
/** This page's account left the browser: nothing more is written for it. */
let signedOut = false;
/** Moves on with every end this page takes in: what was read or started before it is stale. */
let generation = 0;
const listeners = new Set<(end: AccountEpochEnd) => void>();
let channel: BroadcastChannel | null | undefined;

/** Take in an end said by `raw` (kept in storage, or said on the channel), once; an older or unreadable value is no news. */
function notice(raw: unknown = stored()): void {
    const now = parse(raw);
    if (!now || now.n < held.n || (now.signOut === held.signOut && now.clear === held.clear)) return;
    const end: AccountEpochEnd = now.signOut !== held.signOut ? 'signed-out' : 'cleared';
    held = now;
    generation += 1;
    if (end === 'signed-out') signedOut = true;
    for (const listener of [...listeners]) {
        try { listener(end); } catch { /* one page's trouble never keeps the news from the rest */ }
    }
}

function openChannel(): BroadcastChannel | null {
    if (channel !== undefined) return channel;
    channel = null;
    try {
        if (typeof BroadcastChannel === 'function') {
            const ch = new BroadcastChannel(ACCOUNT_EPOCH_CHANNEL);
            ch.onmessage = (e: MessageEvent) => notice(e.data);
            // Node's own (tests): never what keeps a process alive.
            (ch as unknown as { unref?: () => void }).unref?.();
            channel = ch;
        }
    } catch { /* no channel: the storage event still tells the other tabs */ }
    return channel;
}

if (typeof window !== 'undefined') {
    try {
        window.addEventListener('storage', (e: StorageEvent) => {
            if (e.key === ACCOUNT_EPOCH_KEY) notice(e.newValue);
            else if (e.key === null) notice();
        });
    } catch { /* no window events: every write still checks first */ }
    openChannel();
}

/**
 * Where this page stands now: taken before a read or a save is sent, and given to {@link accountEpochHolds} when it
 * lands, so an answer from before a clear is never kept.
 */
export function accountEpoch(): number {
    notice();
    return generation;
}

/**
 * Whether this page may write the account's state: no sign-out since it started, and, given an `epoch` from
 * {@link accountEpoch}, no clear since then either.
 */
export function accountEpochHolds(epoch?: number): boolean {
    notice();
    return !signedOut && (epoch === undefined || epoch === generation);
}

/**
 * The first step of every routine that clears the account's storage: every page of this web address (this one too)
 * stops writing what it holds. Returns the value kept, which the routine keeps across its own wipe of localStorage.
 */
export function endAccountEpoch(end: AccountEpochEnd): string {
    const kept = parse(stored());
    const base = kept && kept.n >= held.n ? kept : held;
    const raw = `${base.n + 1}.${end === 'signed-out' ? token() : base.signOut}.${token()}`;
    try { localStorage.setItem(ACCOUNT_EPOCH_KEY, raw); } catch { /* the channel, and this page, still hear it */ }
    try { openChannel()?.postMessage(raw); } catch { /* the storage event tells the other tabs */ }
    notice(raw);
    return raw;
}

/** Told of every end this page takes in, its own included. Returns the unsubscribe. */
export function onAccountEpochEnd(listener: (end: AccountEpochEnd) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Tests only: this page starts again under what storage holds now, as a page loaded now does. */
export function resetAccountEpochForTest(): void {
    held = parse(stored()) ?? START;
    signedOut = false;
}
