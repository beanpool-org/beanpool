/**
 * The person check at the 12-words door on a busy day, the phone's half (the node's is apps/server services/door-check.ts).
 * The node names a page on another origin (apps/door-check); the phone opens it in an embedded browser at the tap that
 * needs it (components/DoorCheckSheet.tsx), hears the token from the page, and hands it to the door's work route, where
 * the node judges it. No Cloudflare SDK and nothing of Cloudflare's on the phone. Stays off the words layer, as the rest
 * of the door's code does: the sentences are global-join.ts's and door-work.ts's.
 */

/** Where the node's person check is, as it says (`turnstile` in its `check_required` answer). */
export interface DoorCheck {
    siteKey: string;
    page: string;
}

/** How a check ended: the token, the member closed it, or it wouldn't load or wouldn't pass. */
export type DoorCheckResult = { kind: 'token'; token: string } | { kind: 'closed' } | { kind: 'failed' };

/** Opens the check for this key, and answers when it is over. Never rejects. */
export type AskDoorCheck = (check: DoorCheck, publicKey: string) => Promise<DoorCheckResult>;

/** The check in a `check_required` answer, or null when it names none this phone can open. */
export function readDoorCheck(body: unknown): DoorCheck | null {
    const { siteKey, page } = (body as { turnstile?: { siteKey?: unknown; page?: unknown } | null } | null)?.turnstile ?? {};
    return typeof siteKey === 'string' && siteKey && typeof page === 'string' && page.startsWith('https://') ? { siteKey, page } : null;
}

/** The page, for this key: everything in the fragment, so none of it is in a request line. */
export function doorCheckUrl(check: DoorCheck, publicKey: string, theme: 'light' | 'dark'): string {
    return `${check.page}#sitekey=${encodeURIComponent(check.siteKey)}&cdata=${publicKey.slice(0, 32)}&theme=${theme}`;
}

function originOf(url: string): string | null {
    const m = /^(https:\/\/[^/?#]+)/.exec(url);
    return m ? m[1].toLowerCase() : null;
}

/** The embedded browser stays on the check's page: the widget's frames may load, and nothing else takes the top frame. */
export function checkPageMayLoad(url: string, topFrame: boolean | undefined, page: string): boolean {
    return topFrame === false || (originOf(url) !== null && originOf(url) === originOf(page));
}

/** What the page said, when it was the check's page that said it. */
export type CheckPageMessage = { ready: true } | { token: string } | { error: string };

export function readCheckMessage(data: string, url: string, page: string): CheckPageMessage | null {
    if (originOf(url) === null || originOf(url) !== originOf(page)) return null;
    let said: unknown;
    try { said = JSON.parse(data); } catch { return null; }
    const m = said as { ready?: unknown; token?: unknown; error?: unknown } | null;
    if (typeof m?.token === 'string' && m.token) return { token: m.token };
    if (typeof m?.error === 'string') return { error: m.error };
    return m?.ready === true ? { ready: true } : null;
}
