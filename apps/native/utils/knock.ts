/**
 * "Ask to join" a local community, from the phone (design §3.3; the server is apps/server/src/routes/knocks.ts
 * and engine/knocks.ts, G6).
 *
 * ## Where a knock goes, and with which key
 *
 * To the community itself, at the address the directory gives for it (`communityOrigin`: https, a host name,
 * never the global node), signed with the member's OWN key, the same key on every node (one identity per
 * device). Nothing goes through the global node, which records no knocks. The signer is the only applicant a
 * community sees: the body names no key, and it says where the app came from as `fromNode`, never `from` (the
 * node's signature check reads a `from` field as the sender's key and refuses any other).
 *
 *   POST <community>/api/join/knock          { message, callsign, avatar?, fromNode }  → 201 { knock: { status: 'pending' } }
 *   GET  <community>/api/join/knock/status   → { status: 'none' | 'pending' } | { status: 'approved', invite, expiresAt }
 *
 * ## What the member is told
 *
 * A community's refusal (429 too many today, 404 it takes no requests, 403 this key can't ask) is shown in the
 * community's own words, exactly as it sent them, so a change to that wording needs no app update. A decline is
 * never shown: the community answers a declined knock exactly as a waiting one ("people are kinder when a no isn't
 * a message"), and so does this file, even if a node ever did say `declined`. A knock nobody answered in 30 days
 * reads `none` again, and the member may ask again.
 *
 * ## What the phone remembers
 *
 * Which communities this key has asked (AsyncStorage), so the card and People can read those knocks' status. The
 * phone reads the status only from communities it asked: a signed read shows a community this key, and one it
 * never asked has no reason to see it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { signedGet, signedPost } from './node-post';
import { communityOrigin } from './community-directory';
import { GLOBAL_NODE_URL } from './node-profile';
import type { BeanPoolIdentity } from './identity';

export const KNOCK_PATH = '/api/join/knock';
export const KNOCK_STATUS_PATH = '/api/join/knock/status';
/** The node's limits (engine/knocks.ts KNOCK_RULES): what the form holds the member to before sending. */
export const KNOCK_MESSAGE_CHARS = 280;
export const KNOCK_CALLSIGN_CHARS = 20;
const KNOCK_AVATAR_CHARS = 150_000;
const TIMEOUT_MS = 20_000;
const STORE_KEY = 'beanpool_knocks';

/** The host a knock says it came from: shown to the community's members, not checked. */
export const KNOCK_FROM_NODE = GLOBAL_NODE_URL.replace(/^https:\/\//, '');

export const KNOCK_MESSAGES = {
    noAddress: "This community hasn't published an address, so it can't be asked from here yet.",
    unreachable: "Couldn't reach this community. Check your connection and try again.",
    unreadable: "This community sent an answer the app couldn't read. Please try again later.",
    waiting: 'You asked to join. No answer yet: communities usually answer within a few days.',
    none: 'No answer came. You can ask again.',
    invited: 'A member invited you. Join now to become a member.',
} as const;

export type KnockSendResult =
    /** Sent, or already open there: now waiting for an answer. */
    | { kind: 'waiting'; message: string }
    /** A member has already said yes: read the status for the invite. */
    | { kind: 'invited' }
    /** This key is a member there already. */
    | { kind: 'member'; message: string }
    /** The community said no to the request itself, in its own words. */
    | { kind: 'refused'; status: number; code: string | null; message: string }
    | { kind: 'no_address'; message: string }
    | { kind: 'unreachable'; message: string };

export type KnockStatus =
    | { status: 'none' }
    | { status: 'pending' }
    | { status: 'approved'; invite: string; expiresAt: string | null };

export type KnockStatusResult =
    | { ok: true; value: KnockStatus }
    | { ok: false; kind: 'refused'; status: number; code: string | null; message: string }
    | { ok: false; kind: 'no_address' | 'unreachable'; message: string };

export interface KnockRequest {
    message: string;
    callsign: string;
    /** A photo as a data URL, or a shipped `bundled://` picture. Left out when it isn't one of those. */
    avatar?: string | null;
}

// ── The form ────────────────────────────────────────────────────────────────────────────────────────────────

const chars = (s: string) => Array.from(s).length;

/** What is wrong with the form, in the node's own terms, or null when it can be sent. */
export function knockFormProblem(req: KnockRequest): string | null {
    const name = req.callsign.replace(/\s+/g, ' ').trim();
    if (chars(name) < 2) return 'Please give a name of at least 2 characters.';
    if (chars(name) > KNOCK_CALLSIGN_CHARS) return `Please keep your name to ${KNOCK_CALLSIGN_CHARS} characters.`;
    const message = req.message.trim();
    if (!message) return 'Please say a few words about yourself.';
    if (chars(message) > KNOCK_MESSAGE_CHARS) return `Please keep your message to ${KNOCK_MESSAGE_CHARS} characters.`;
    return null;
}

/** The avatar the node will take (engine/knocks.ts parseAvatar), or nothing. */
export function knockAvatar(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    const v = value.trim();
    if (/^bundled:\/\/[A-Za-z0-9_-]{1,64}$/.test(v)) return v;
    if (v.length <= KNOCK_AVATAR_CHARS && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(v)) return v;
    return undefined;
}

/**
 * The body a knock sends: no key in it, and `fromNode`, never `from`. `toNode` names the community it is for, inside
 * what is signed. The signature covers the method, path, time, nonce and body but not the host, so without it a
 * community that received a knock could send the same signed request on to another community within the node's
 * five-minute window. No node checks `toNode` yet (G6 ignores fields it doesn't read); sending it now means a node
 * that starts refusing a knock addressed elsewhere needs no app update.
 */
export function knockBody(req: KnockRequest, toNode?: string): { message: string; callsign: string; fromNode: string; toNode?: string; avatar?: string } {
    const avatar = knockAvatar(req.avatar);
    return {
        message: req.message.trim(),
        callsign: req.callsign.replace(/\s+/g, ' ').trim(),
        fromNode: KNOCK_FROM_NODE,
        ...(toNode ? { toNode } : {}),
        ...(avatar ? { avatar } : {}),
    };
}

// ── Talking to the community ────────────────────────────────────────────────────────────────────────────────

async function readError(res: Response): Promise<{ message: string | null; code: string | null }> {
    try {
        const body = await res.json();
        return {
            message: typeof body?.error === 'string' && body.error.trim() ? body.error : null,
            code: typeof body?.code === 'string' ? body.code : null,
        };
    } catch {
        return { message: null, code: null };
    }
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
        p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
}

/** Ask `communityUrl` to let this key in. The address must be one `communityOrigin` accepts. */
export async function sendKnock(communityUrl: string | null, identity: BeanPoolIdentity, req: KnockRequest): Promise<KnockSendResult> {
    const origin = communityOrigin(communityUrl);
    if (!origin) return { kind: 'no_address', message: KNOCK_MESSAGES.noAddress };
    let res: Response;
    try {
        res = await withTimeout(signedPost(origin, KNOCK_PATH, knockBody(req, origin.replace(/^https:\/\//, '')), identity));
    } catch {
        return { kind: 'unreachable', message: KNOCK_MESSAGES.unreachable };
    }
    if (res.status === 201 || res.status === 200) return { kind: 'waiting', message: KNOCK_MESSAGES.waiting };
    const { message, code } = await readError(res);
    if (res.status === 409 && code === 'knock_open') return { kind: 'waiting', message: message ?? KNOCK_MESSAGES.waiting };
    if (res.status === 409 && code === 'knock_approved') return { kind: 'invited' };
    if (res.status === 409 && code === 'already_member') return { kind: 'member', message: message ?? 'You are already a member of this community.' };
    return { kind: 'refused', status: res.status, code, message: message ?? KNOCK_MESSAGES.unreadable };
}

/** Read the answer to this key's knock on `communityUrl`. */
export async function readKnockStatus(communityUrl: string | null, identity: BeanPoolIdentity): Promise<KnockStatusResult> {
    const origin = communityOrigin(communityUrl);
    if (!origin) return { ok: false, kind: 'no_address', message: KNOCK_MESSAGES.noAddress };
    let res: Response;
    try {
        res = await withTimeout(signedGet(origin, KNOCK_STATUS_PATH, identity));
    } catch {
        return { ok: false, kind: 'unreachable', message: KNOCK_MESSAGES.unreachable };
    }
    if (!res.ok) {
        const { message, code } = await readError(res);
        return { ok: false, kind: 'refused', status: res.status, code, message: message ?? KNOCK_MESSAGES.unreadable };
    }
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    const status = readStatus(body);
    return status ? { ok: true, value: status } : { ok: false, kind: 'unreachable', message: KNOCK_MESSAGES.unreadable };
}

/**
 * The status as the member will meet it. `approved` needs an invite to be one. Anything else a node might say
 * that isn't `none` (a `declined`, say) is shown as waiting: a no is never a message.
 */
export function readStatus(body: unknown): KnockStatus | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if (typeof b.status !== 'string') return null;
    if (b.status === 'none') return { status: 'none' };
    if (b.status === 'approved' && typeof b.invite === 'string' && b.invite.trim()) {
        return { status: 'approved', invite: b.invite.trim(), expiresAt: typeof b.expiresAt === 'string' ? b.expiresAt : null };
    }
    return { status: 'pending' };
}

// ── What the phone remembers ────────────────────────────────────────────────────────────────────────────────

export interface RememberedKnock {
    /** The community's origin, as the knock was sent to it. */
    url: string;
    name: string | null;
    /** The directory's key for it, when known. */
    key: string | null;
    sentAt: string;
}

interface Store { pubkey: string; knocks: RememberedKnock[] }

async function readStore(pubkey: string): Promise<RememberedKnock[]> {
    try {
        const raw = await AsyncStorage.getItem(STORE_KEY);
        const parsed = raw ? JSON.parse(raw) as Store : null;
        // Another key's list (a wiped and restored phone) is none of this key's business.
        if (!parsed || parsed.pubkey !== pubkey || !Array.isArray(parsed.knocks)) return [];
        return parsed.knocks.filter(k => k && typeof k.url === 'string' && communityOrigin(k.url) === k.url);
    } catch {
        return [];
    }
}

async function writeStore(pubkey: string, knocks: RememberedKnock[]): Promise<void> {
    try {
        await AsyncStorage.setItem(STORE_KEY, JSON.stringify({ pubkey, knocks } satisfies Store));
    } catch {
        // Unsaved, the card simply won't show this knock's status; the community still has it.
    }
}

/** The communities this key has asked, newest first. */
export async function rememberedKnocks(pubkey: string): Promise<RememberedKnock[]> {
    const knocks = await readStore(pubkey);
    return [...knocks].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

export async function rememberKnock(pubkey: string, community: { url: string | null; name: string | null; key?: string | null }, now: Date = new Date()): Promise<void> {
    const url = communityOrigin(community.url);
    if (!url) return;
    const knocks = (await readStore(pubkey)).filter(k => k.url !== url);
    knocks.push({ url, name: community.name, key: community.key ?? null, sentAt: now.toISOString() });
    await writeStore(pubkey, knocks);
}

export async function forgetKnock(pubkey: string, url: string): Promise<void> {
    const origin = communityOrigin(url) ?? url;
    const knocks = await readStore(pubkey);
    const next = knocks.filter(k => k.url !== origin);
    if (next.length !== knocks.length) await writeStore(pubkey, next);
}

// ── What a community's card says ────────────────────────────────────────────────────────────────────────────

export type KnockCardState =
    /** Nothing asked (or asked long ago and unanswered): offer "Ask to join". */
    | { kind: 'ask'; note: string | null }
    | { kind: 'checking' }
    | { kind: 'waiting'; note: string }
    | { kind: 'invited'; invite: string; note: string }
    | { kind: 'member'; note: string }
    /** The community refused, in its own words. `canAsk`: whether asking again could work. */
    | { kind: 'refused'; note: string; canAsk: boolean }
    /** No answer from the community: check again later. */
    | { kind: 'unreachable'; note: string }
    | { kind: 'no_address'; note: string };

/**
 * What a community's card shows, from whether this key asked it and what it said. `asked` is from the phone's
 * memory; `status` is the community's answer (null or undefined until it has been read).
 * `memberNote` is set once the community has said this key is a member there already.
 */
export function knockCardState(
    hasAddress: boolean, asked: boolean, status: KnockStatusResult | null | undefined, memberNote?: string | null,
): KnockCardState {
    if (!hasAddress) return { kind: 'no_address', note: KNOCK_MESSAGES.noAddress };
    if (memberNote) return { kind: 'member', note: memberNote };
    if (!asked) return { kind: 'ask', note: null };
    // Asked, and the answer not read yet (or being read).
    if (status === null || status === undefined) return { kind: 'checking' };
    if (!status.ok) {
        if (status.kind === 'refused') {
            // A community that takes no requests (404) or refuses this key (403) won't take another ask either.
            return { kind: 'refused', note: status.message, canAsk: status.status === 429 || status.status >= 500 };
        }
        if (status.kind === 'unreachable') return { kind: 'unreachable', note: status.message };
        return { kind: 'no_address', note: status.message };
    }
    switch (status.value.status) {
        case 'pending': return { kind: 'waiting', note: KNOCK_MESSAGES.waiting };
        case 'approved': return { kind: 'invited', invite: status.value.invite, note: KNOCK_MESSAGES.invited };
        default: return { kind: 'ask', note: KNOCK_MESSAGES.none };
    }
}

/**
 * The landing card's lines about this phone's knocks (design §3.3: "Waiting for <community>, usually a few days"):
 * one per community still waiting or that said yes. A community that hasn't answered or can't be reached gets
 * no line on the card; its own card in Find a community says so.
 */
export function cardKnockLines(
    asked: readonly RememberedKnock[], statuses: Readonly<Record<string, KnockStatusResult | null | undefined>>,
): Array<{ url: string; text: string; invited: boolean }> {
    const lines: Array<{ url: string; text: string; invited: boolean }> = [];
    for (const k of asked) {
        const s = statuses[k.url];
        if (!s || !s.ok) continue;
        const name = k.name ?? k.url.replace(/^https:\/\//, '');
        if (s.value.status === 'approved') lines.push({ url: k.url, text: `${name} said yes. Join now.`, invited: true });
        else if (s.value.status === 'pending') lines.push({ url: k.url, text: `Waiting for ${name}: usually a few days.`, invited: false });
    }
    return lines;
}
