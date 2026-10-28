/**
 * "Ask to join" a local community from the web app (DESIGN-global-lounge-fable.md §6 L1).
 *
 * Persists remembered knocks in `localStorage` under `beanpool_knocks` (matching native's KNOCKS_STORE_KEY),
 * signs requests to the community origin using noble ed25519 request signing via @beanpool/core,
 * and handles reading status and cancelling requests.
 */

import {
    buildBoundRequestHeaders, ed25519Signer, isPublicIpv4, knockStillAnswerable, t, word,
} from '@beanpool/core';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { BeanPoolIdentity } from './identity';

export const KNOCK_PATH = '/api/join/knock';
export const KNOCK_STATUS_PATH = '/api/join/knock/status';
export const KNOCK_CANCEL_PATH = '/api/join/knock/cancel';
export const KNOCK_CANCEL_BLOCK_HOURS = 24;
export const KNOCK_ANSWERABLE_DAYS = 61;
const TIMEOUT_MS = 20_000;
const STORE_KEY = 'beanpool_knocks';

export const KNOCK_MESSAGES = {
    noAddress: word("This community hasn't published an address, so it can't be asked from here yet."),
    unreachable: word("Couldn't reach this community. Check your connection and try again."),
    unreadable: word("This community sent an answer the app couldn't read. Please try again later."),
    waiting: word('You asked to join. No answer yet: communities usually answer within a few days.'),
    none: word('No answer came. You can ask again.'),
    cancelled: word('You cancelled your request. You can ask again after 24 hours.'),
    invited: word('A member invited you. Join now to become a member.'),
} as const;

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

export async function readKnockStatus(communityUrl: string | null, identity: BeanPoolIdentity): Promise<KnockStatusResult> {
    const origin = communityOrigin(communityUrl);
    if (!origin) return { ok: false, kind: 'no_address', message: t(KNOCK_MESSAGES.noAddress) };
    const target = `${origin}${KNOCK_STATUS_PATH}`;
    let res: Response;
    try {
        const sign = ed25519Signer(hexToBytes(identity.privateKey));
        const headers = await buildBoundRequestHeaders({
            method: 'GET',
            url: target,
            body: '',
            publicKeyHex: identity.publicKey,
            sign,
        });
        res = await withTimeout(fetch(target, { method: 'GET', headers, cache: 'no-cache' }));
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
): Promise<{ ok: true } | { ok: false; message: string }> {
    const origin = communityOrigin(communityUrl);
    if (!origin) return { ok: false, message: t(KNOCK_MESSAGES.noAddress) };
    const target = `${origin}${KNOCK_CANCEL_PATH}`;
    let res: Response;
    try {
        const sign = ed25519Signer(hexToBytes(identity.privateKey));
        const bodyString = '{}';
        const headers = await buildBoundRequestHeaders({
            method: 'POST',
            url: target,
            body: bodyString,
            publicKeyHex: identity.publicKey,
            sign,
        });
        res = await withTimeout(fetch(target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: bodyString,
        }));
    } catch {
        return { ok: false, message: t(KNOCK_MESSAGES.unreachable) };
    }
    if (!res.ok) {
        const { message } = await readError(res);
        return { ok: false, message: message ?? t(KNOCK_MESSAGES.unreadable) };
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
