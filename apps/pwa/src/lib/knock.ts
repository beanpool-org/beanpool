/**
 * "Ask to join" a local community from the web app (DESIGN-global-lounge-fable.md §6 L1; the knock itself is front doors
 * S2: the phone's apps/native/utils/knock.ts, on the web).
 *
 * Sends a knock to the community's own address, persists remembered knocks in `localStorage` under `beanpool_knocks`
 * (matching native's KNOCKS_STORE_KEY), and reads status and cancels requests at the community origin. The signing is
 * lib/api.ts's (signedFetchAt): the member key becomes a signer in that one file only (lib/signing-source-rule.test.ts).
 */

import { isPublicIpv4, knockStillAnswerable, t, tn, word } from '@beanpool/core';
import { getNodeApiUrl, signedFetchAt } from './api';
import type { BeanPoolIdentity } from './identity';

export const KNOCK_PATH = '/api/join/knock';
export const KNOCK_STATUS_PATH = '/api/join/knock/status';
export const KNOCK_CANCEL_PATH = '/api/join/knock/cancel';
export const KNOCK_CANCEL_BLOCK_HOURS = 24;
/** The node's limits (engine/knocks.ts KNOCK_RULES): what the form holds the member to before sending, as the phone's. */
export const KNOCK_MESSAGE_CHARS = 280;
export const KNOCK_CALLSIGN_CHARS = 20;
const KNOCK_AVATAR_CHARS = 150_000;
const TIMEOUT_MS = 20_000;
const STORE_KEY = 'beanpool_knocks';

export const KNOCK_MESSAGES = {
    noAddress: word("This community hasn't published an address, so it can't be asked from here yet."),
    unreachable: word("Couldn't reach this community. Check your connection and try again."),
    unreadable: word("This community sent an answer the app couldn't read. Please try again later."),
    waiting: word('You asked to join. No answer yet: communities usually answer within a few days.'),
    none: word('This request is no longer open. You can ask again.'),
    cancelled: word('You cancelled your request. You can ask again after 24 hours.'),
    invited: word('A member invited you. Join now to become a member.'),
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

export interface KnockRequest {
    message: string;
    callsign: string;
    /** A photo as a data URL, or a shipped `bundled://` picture. Left out when it isn't one of those. */
    avatar?: string | null;
}

export type KnockStatus =
    | { status: 'none' }
    | { status: 'pending' }
    | { status: 'approved'; invite: string; expiresAt: string | null };

export type KnockStatusResult =
    | { ok: true; value: KnockStatus }
    | { ok: false; kind: 'refused'; status: number; code: string | null; message: string }
    | { ok: false; kind: 'no_address' | 'unreachable'; message: string };

export interface RememberedKnock {
    url: string;
    name: string | null;
    key: string | null;
    sentAt: string;
    cancelledAt?: string;
}

interface Store {
    pubkey: string;
    knocks: RememberedKnock[];
}

function host(url: string): string | null {
    const m = /^https:\/\/([^/?#@\s]+)(?=[/?#]|$)/i.exec(url);
    return m ? m[1].toLowerCase().replace(/:443$/, '') : null;
}

/** A community's address: an https origin with a host name or a public IPv4 address, no credentials. */
export function communityOrigin(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!/^https:\/\//i.test(trimmed) || trimmed.length > 300) return null;
    const h = host(trimmed);
    if (!h) return null;
    const name = h.replace(/:\d{1,5}$/, '');
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    if (/^[\d.]+$/.test(name) ? !isPublicIpv4(name) : !new RegExp(`^${label}(?:\\.${label})+$`).test(name)) return null;
    if (h === 'global.beanpool.org') return null;
    return `https://${h}`;
}

// ── The form (the phone's knockFormProblem / knockBody) ──────────────────────────────────────────────────────

const chars = (s: string) => Array.from(s).length;

/** What is wrong with the form, in the member's language (the node's own terms, as the phone says them), or null. */
export function knockFormProblem(req: KnockRequest): string | null {
    const name = req.callsign.replace(/\s+/g, ' ').trim();
    if (chars(name) < 2) return t('Please give a name of at least 2 characters.');
    if (chars(name) > KNOCK_CALLSIGN_CHARS) return tn(KNOCK_CALLSIGN_CHARS, 'Please keep your name to {n} character.', 'Please keep your name to {n} characters.');
    const message = req.message.trim();
    if (!message) return t('Please say a few words about yourself.');
    if (chars(message) > KNOCK_MESSAGE_CHARS) return tn(KNOCK_MESSAGE_CHARS, 'Please keep your message to {n} character.', 'Please keep your message to {n} characters.');
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
 * The host a knock says it came from: the community this web app talks to (shown to the asked community's members, not
 * checked). Never a fixed name of ours: a web app any community serves says that community.
 */
export function knockFromNode(): string | undefined {
    const base = getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    const m = /^https?:\/\/([^/?#@\s]+)/i.exec(base);
    return m ? m[1].toLowerCase().replace(/:443$/, '') : undefined;
}

/**
 * The body a knock sends, as the phone's: no key in it, `fromNode`, never `from` (the node's signature check reads a
 * `from` field as the sender's key), and `toNode` naming the community it is for, inside what is signed.
 */
export function knockBody(req: KnockRequest, toNode?: string): { message: string; callsign: string; fromNode?: string; toNode?: string; avatar?: string } {
    const avatar = knockAvatar(req.avatar);
    const fromNode = knockFromNode();
    return {
        message: req.message.trim(),
        callsign: req.callsign.replace(/\s+/g, ' ').trim(),
        ...(fromNode ? { fromNode } : {}),
        ...(toNode ? { toNode } : {}),
        ...(avatar ? { avatar } : {}),
    };
}

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

function readStore(pubkey: string): RememberedKnock[] {
    try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(STORE_KEY);
        const parsed = raw ? JSON.parse(raw) as Store : null;
        if (!parsed || parsed.pubkey !== pubkey || !Array.isArray(parsed.knocks)) return [];
        return parsed.knocks.filter(k => k && typeof k.url === 'string' && communityOrigin(k.url) === k.url);
    } catch {
        return [];
    }
}

function writeStore(pubkey: string, knocks: RememberedKnock[]): void {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(STORE_KEY, JSON.stringify({ pubkey, knocks } satisfies Store));
    } catch {
        // storage disabled or full
    }
}

export async function rememberedKnocks(pubkey: string, now: number = Date.now()): Promise<RememberedKnock[]> {
    const stored = readStore(pubkey);
    const answerable = stored.filter(k => knockStillAnswerable(k, now));
    if (answerable.length !== stored.length) writeStore(pubkey, answerable);
    return answerable.filter(k => !k.cancelledAt).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

export async function cancelledKnocks(pubkey: string, now: number = Date.now()): Promise<Record<string, number>> {
    const knocks = readStore(pubkey);
    const recent: Record<string, number> = {};
    const kept = knocks.filter(k => {
        if (!k.cancelledAt) return true;
        const at = Date.parse(k.cancelledAt);
        if (!Number.isFinite(at) || now - at >= KNOCK_CANCEL_BLOCK_HOURS * 3_600_000) return false;
        recent[k.url] = at;
        return true;
    });
    if (kept.length !== knocks.length) writeStore(pubkey, kept);
    return recent;
}

export async function rememberKnock(
    pubkey: string,
    community: { url: string | null; name: string | null; key?: string | null },
    now: Date = new Date(),
): Promise<void> {
    const url = communityOrigin(community.url);
    if (!url) return;
    const knocks = readStore(pubkey).filter(k => k.url !== url);
    knocks.push({ url, name: community.name, key: community.key ?? null, sentAt: now.toISOString() });
    writeStore(pubkey, knocks);
}

export async function forgetKnock(pubkey: string, url: string): Promise<void> {
    const origin = communityOrigin(url) ?? url;
    const knocks = readStore(pubkey);
    const next = knocks.filter(k => k.url !== origin);
    if (next.length !== knocks.length) writeStore(pubkey, next);
}

/**
 * Ask `communityUrl` to let this key in, at the community's own address (never through the community this web app talks
 * to). A refusal is the community's own words, as it sent them; a decline is never shown (it reads as waiting).
 */
export async function sendKnock(communityUrl: string | null, identity: BeanPoolIdentity, req: KnockRequest): Promise<KnockSendResult> {
    const origin = communityOrigin(communityUrl);
    if (!origin) return { kind: 'no_address', message: t(KNOCK_MESSAGES.noAddress) };
    let res: Response;
    try {
        const body = JSON.stringify(knockBody(req, origin.replace(/^https:\/\//, '')));
        res = await withTimeout(signedFetchAt('POST', origin, KNOCK_PATH, body, identity));
    } catch {
        return { kind: 'unreachable', message: t(KNOCK_MESSAGES.unreachable) };
    }
    if (res.status === 201 || res.status === 200) return { kind: 'waiting', message: t(KNOCK_MESSAGES.waiting) };
    const { message, code } = await readError(res);
    if (res.status === 409 && code === 'knock_open') return { kind: 'waiting', message: message ?? t(KNOCK_MESSAGES.waiting) };
    if (res.status === 409 && code === 'knock_approved') return { kind: 'invited' };
    if (res.status === 409 && code === 'already_member') return { kind: 'member', message: message ?? t('You are already a member of this community.') };
    return { kind: 'refused', status: res.status, code, message: message ?? t(KNOCK_MESSAGES.unreadable) };
}

export async function readKnockStatus(communityUrl: string | null, identity: BeanPoolIdentity): Promise<KnockStatusResult> {
    const origin = communityOrigin(communityUrl);
    if (!origin) return { ok: false, kind: 'no_address', message: t(KNOCK_MESSAGES.noAddress) };
    let res: Response;
    try {
        res = await withTimeout(signedFetchAt('GET', origin, KNOCK_STATUS_PATH, '', identity));
    } catch {
        return { ok: false, kind: 'unreachable', message: t(KNOCK_MESSAGES.unreachable) };
    }
    if (!res.ok) {
        const { message, code } = await readError(res);
        return { ok: false, kind: 'refused', status: res.status, code, message: message ?? t(KNOCK_MESSAGES.unreadable) };
    }
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    const status = readStatus(body);
    return status ? { ok: true, value: status } : { ok: false, kind: 'unreachable', message: t(KNOCK_MESSAGES.unreadable) };
}

export async function cancelKnock(
    communityUrl: string | null,
    identity: BeanPoolIdentity,
    now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; message: string; status?: number; code?: string | null }> {
    const origin = communityOrigin(communityUrl);
    if (!origin) return { ok: false, message: t(KNOCK_MESSAGES.noAddress) };
    let res: Response;
    try {
        res = await withTimeout(signedFetchAt('POST', origin, KNOCK_CANCEL_PATH, '{}', identity));
    } catch {
        return { ok: false, message: t(KNOCK_MESSAGES.unreachable) };
    }
    if (!res.ok) {
        const { message, code } = await readError(res);
        return { ok: false, message: message ?? t(KNOCK_MESSAGES.unreadable), status: res.status, code };
    }
    const knocks = readStore(identity.publicKey);
    writeStore(identity.publicKey, knocks.map(k => (k.url === origin ? { ...k, cancelledAt: now.toISOString() } : k)));
    return { ok: true };
}

export function cardKnockLines(
    asked: readonly RememberedKnock[],
    statuses: Readonly<Record<string, KnockStatusResult | null | undefined>>,
): Array<{ url: string; text: string; invited: boolean }> {
    const lines: Array<{ url: string; text: string; invited: boolean }> = [];
    for (const k of asked) {
        const s = statuses[k.url];
        if (!s || !s.ok) continue;
        const name = k.name ?? k.url.replace(/^https:\/\//, '');
        if (s.value.status === 'approved') lines.push({ url: k.url, text: t('{name} said yes. Join now.', { name }), invited: true });
        else if (s.value.status === 'pending') lines.push({ url: k.url, text: t('Waiting for {name}: usually a few days.', { name }), invited: false });
    }
    return lines;
}
