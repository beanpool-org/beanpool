/**
 * Leave statements: how an account's push alerts stop on a phone it leaves, even when the phone has no connection then.
 *
 * As an account leaves the phone (account-leaves-phone.ts), the phone signs, with the leaving key K while it still holds
 * it, one statement for each community it sent its push token T to: "K no longer wants T here", with a fresh push stamp
 * (push-registrations.ts `nextPushStamp`) and the community's host inside the signed bytes, so it counts only there
 * (@beanpool/core `pushLeaveText`). The statements are written down here before anything is sent, under a key the
 * account's wipe leaves, so they outlive the wipe and a restart. One goes when its community confirms the leave, by the
 * signed DELETE as K leaves or by the statement itself later: {@link presentLeaveStatements}, unsigned, each time the app
 * starts or comes back and every few minutes while it is open (app/_layout.tsx). None ever expires: a phone can be
 * offline for weeks.
 *
 * A statement only ever does what K asked. Whoever presents it, the community removes K's registration of T there, and
 * only one the phone made no later than the statement, so K signing back in on this phone (a later stamp) is never undone
 * by it (apps/server state-engine.ts `applyPushLeave`). It goes unsigned so that the account on the phone by then, if
 * any, is never linked to K. A community that says it will never act on one (`push_leave_refused`: a signature or a shape
 * it can't use) has it dropped; any other answer, or none, keeps it for the next time. The statement holds the token,
 * which every community it was sent to holds already, and nothing else about the phone.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { signPushLeaveStatement } from './member-statements';
import { communityAddress, nextPushStamp } from './push-registrations';
import { PUSH_LEAVE_STATEMENTS_STORE_KEY } from './storage-keys';

/** How long one presentation may wait for its community, as a registration does (push-registrations.ts). */
export const PRESENT_TIMEOUT_MS = 12000;

const LEAVE_PATH = '/api/push-tokens/leave';
/** The community's answer to a statement it will never act on (apps/server routes/community.ts). */
const REFUSED_FOR_GOOD = 'push_leave_refused';

export interface LeaveStatement {
    /** The community's address, as the phone sent the token to it. */
    community: string;
    /** The leaving key, lower-case hex. */
    publicKey: string;
    token: string;
    leftAt: number;
    /** Base64, over the format-2 bytes for `signedFor`. */
    signature: string;
    signedFor: string;
}

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

type LeavingAccount = { publicKey: string; privateKey: string };

const HEX_KEY = /^[0-9a-f]{64}$/;

function isStatement(s: unknown): s is LeaveStatement {
    if (!s || typeof s !== 'object') return false;
    const o = s as Record<string, unknown>;
    return communityAddress(o.community) === o.community && typeof o.publicKey === 'string' && HEX_KEY.test(o.publicKey)
        && typeof o.token === 'string' && !!o.token && typeof o.leftAt === 'number' && Number.isSafeInteger(o.leftAt)
        && typeof o.signature === 'string' && !!o.signature && typeof o.signedFor === 'string' && !!o.signedFor;
}

const sameLeave = (a: LeaveStatement, b: LeaveStatement) => a.community === b.community && a.publicKey === b.publicKey && a.token === b.token;
const sameStatement = (a: LeaveStatement, b: LeaveStatement) => sameLeave(a, b) && a.leftAt === b.leftAt;

/** The statements not yet confirmed, as written down. Throws when they can't be read, so they are never overwritten. */
async function readPending(storage: Storage): Promise<LeaveStatement[]> {
    const raw = await storage.getItem(PUSH_LEAVE_STATEMENTS_STORE_KEY);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw ?? '[]');
    } catch {
        return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isStatement) : [];
}

let writes: Promise<unknown> = Promise.resolve();

/** Change the written-down statements, one change at a time. None left, none kept. */
function updatePending(storage: Storage, change: (pending: LeaveStatement[]) => LeaveStatement[]): Promise<void> {
    const next = writes.then(async () => {
        const changed = change(await readPending(storage));
        if (changed.length === 0) await storage.removeItem(PUSH_LEAVE_STATEMENTS_STORE_KEY);
        else await storage.setItem(PUSH_LEAVE_STATEMENTS_STORE_KEY, JSON.stringify(changed));
    });
    writes = next.catch(() => {});
    return next;
}

/** The statements this phone has not had confirmed yet. Reads only; never throws. */
export async function pendingLeaveStatements(storage: Storage = AsyncStorage): Promise<LeaveStatement[]> {
    try {
        return await readPending(storage);
    } catch {
        return [];
    }
}

/**
 * `account` is leaving this phone: sign its statements for `token` at each of `communities` with one fresh stamp, and
 * write them down before anything is sent. A newer statement replaces an older one for the same key, token and
 * community (it removes all the older one did). Returns them: the caller sends the leave now, and confirms each one that
 * lands ({@link confirmLeave}). A community whose address can't be signed for gets none, and is logged. Never throws:
 * statements that can't be written down are still returned, for the leave sent now.
 */
export async function recordLeave(
    account: LeavingAccount, token: string, communities: readonly string[], storage: Storage = AsyncStorage,
): Promise<LeaveStatement[]> {
    if (communities.length === 0) return [];
    const publicKey = account.publicKey.toLowerCase();
    const leftAt = await nextPushStamp(storage);
    const statements: LeaveStatement[] = [];
    for (const raw of communities) {
        const community = communityAddress(raw);
        if (!community) continue;
        try {
            const signed = await signPushLeaveStatement(community, publicKey, token, leftAt, account.privateKey);
            statements.push({ community, publicKey, token, leftAt, ...signed });
        } catch (e) {
            console.warn(`[Push] Could not sign a leave statement for ${community}`, e instanceof Error ? e.message : e);
        }
    }
    if (statements.length === 0) return statements;
    try {
        await updatePending(storage, (pending) => [...pending.filter((p) => !statements.some((s) => sameLeave(p, s))), ...statements]);
    } catch (e) {
        console.warn('[Push] Could not write the leave statements down; the leave is still sent now', e);
    }
    return statements;
}

/** The leave `statement` stands for was confirmed by its community (or refused there for good): it goes. Never throws. */
export async function confirmLeave(statement: LeaveStatement, storage: Storage = AsyncStorage): Promise<void> {
    try {
        await updatePending(storage, (pending) => pending.filter((p) => !sameStatement(p, statement)));
    } catch (e) {
        console.warn('[Push] Could not cross off a confirmed leave statement', e);
    }
}

type Presented = 'confirmed' | 'refused' | 'kept';

/** One statement, unsigned, to its own community. Never throws; gives up at `timeoutMs`. */
async function presentOne(s: LeaveStatement, timeoutMs: number): Promise<Presented> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const body = JSON.stringify({ token: s.token, leftAt: s.leftAt, signature: s.signature, signedFor: s.signedFor });
        const res = await fetch(`${s.community}${LEAVE_PATH}/${s.publicKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal,
        });
        if (res.ok) return 'confirmed';
        let code: unknown;
        try {
            code = (await res.json())?.code;
        } catch {
            code = undefined;
        }
        if (code === REFUSED_FOR_GOOD) {
            console.warn(`[Push] ${s.community} will never take this leave statement (${res.status}); dropped`);
            return 'refused';
        }
        console.warn(`[Push] ${s.community} did not take a leave statement yet (${res.status}); kept`);
    } catch (e) {
        console.warn(`[Push] Could not reach ${s.community} with a leave statement; kept`, e instanceof Error ? e.message : e);
    } finally {
        clearTimeout(timer);
    }
    return 'kept';
}

let presenting: Promise<void> | null = null;

/**
 * Present every statement not yet confirmed, each to its own community, all together, and cross off each one confirmed
 * or refused for good. One run at a time: a call while one runs waits for it. Never throws.
 */
export function presentLeaveStatements(storage: Storage = AsyncStorage, timeoutMs: number = PRESENT_TIMEOUT_MS): Promise<void> {
    if (presenting) return presenting;
    presenting = (async () => {
        try {
            const pending = await pendingLeaveStatements(storage);
            await Promise.all(pending.map(async (s) => {
                if (await presentOne(s, timeoutMs) !== 'kept') await confirmLeave(s, storage);
            }));
        } catch (e) {
            console.warn('[Push] Presenting the leave statements failed', e);
        } finally {
            presenting = null;
        }
    })();
    return presenting;
}
