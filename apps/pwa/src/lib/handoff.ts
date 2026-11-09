/**
 * The account handoff (DESIGN-global-yes-join-fable.md §2.1, slice Y1): a member's yes from another community, used on the
 * web in one tap. The page that holds the account (global's Home, or any community's whose member asked another) opens the
 * community's page in this browser and hands the account to that window over the browser's own window-to-window channel.
 * Nothing of the key is ever in an address, a request, a cookie or a server.
 *
 * The holder (global's Home, components/YesJoin.tsx):
 *   1. inside the tap, `window.open(<community>/app?door=handoff&n=<nonce>&from=<holder origin>)`; null: the fallback card;
 *   2. waits for the community page's `ready`: from that window (`event.source`), from the knock's own origin
 *      (`event.origin`), carrying the nonce; nothing in 20 s: the fallback card;
 *   3. posts the account to that window with `targetOrigin` = the knock's origin, never '*': the browser delivers it only
 *      to a document at exactly that address;
 *   4. reads the answer the same way: `joined`, or a refusal (the fallback card).
 *
 * The receiver (the community's page, components/HandoffReceiver.tsx): `ready` goes to `window.opener` at `from` only; it
 * takes one message, from `window.opener`, at `from`, with its nonce, of the account's shape, whose private key makes its
 * public key and whose 12 words make the same key; anything else is dropped, and after that message or 60 s it listens no
 * more. The rest (a yes here for that key, no account here, the person's own Join) is the receiver's.
 */

import { toEd25519Seed } from '@beanpool/core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getMemberProfile, getNodeApiUrl } from './api';
import { identityFromMnemonic, type BeanPoolIdentity } from './identity';
import { knockAvatar } from './knock';
import { validateMnemonic } from './mnemonic';

/** `/app?door=handoff`: the welcome root's branch beside `door=ask` (App.tsx). */
export const HANDOFF_DOOR = 'handoff';
/** The holder: no `ready` from the opened page in this long, and it shows the fallback card. */
export const HANDOFF_READY_MS = 20_000;
/** The receiver: how long it listens for the account after it said `ready`. */
export const HANDOFF_LISTEN_MS = 60_000;
/** The holder, once the account is sent: how long it waits for the answer (the person reads and taps Join meanwhile). */
export const HANDOFF_ANSWER_MS = 15 * 60_000;
const TAG = 'beanpool-handoff';
const VERSION = 1;

/** What the receiver answers. `declined`: the person tapped Not mine. `no-storage`: this browser keeps no account there. */
export type HandoffAnswer = 'joined' | 'held' | 'refused' | 'declined' | 'no-storage';
const ANSWERS: ReadonlySet<string> = new Set<HandoffAnswer>(['joined', 'held', 'refused', 'declined', 'no-storage']);

/** The account as it is handed over: the key, its 12 words when it has them, and the name to join with. */
export interface HandedAccount {
    publicKey: string;
    privateKey: string;
    mnemonic?: string[];
    callsign: string;
}

/** A fresh nonce for one handoff: 128 random bits, hex. */
export function newHandoffNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}

export function isHandoffNonce(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/**
 * The holder's origin as the receiver reads it from `from`: https, a host name with a dot or a public-looking IPv4, an
 * optional port, and nothing else (no path, no credentials). Global's own address included: it is the usual holder.
 */
export function handoffOrigin(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > 300) return null;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.origin !== raw.replace(/\/$/, '').toLowerCase().replace(/:443$/, '')) return null;
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    if (!/^[\d.]+$/.test(url.hostname) && !new RegExp(`^${label}(?:\\.${label})+$`).test(url.hostname)) return null;
    return url.origin;
}

/** The address the holder opens: the community's page, its handoff door, this handoff's nonce and who is asking. */
export function handoffUrl(communityOrigin: string, nonce: string, holderOrigin: string): string {
    return `${communityOrigin}/app?door=${HANDOFF_DOOR}&n=${nonce}&from=${encodeURIComponent(holderOrigin)}`;
}

/** What the receiver reads from its own address at load: a well-formed handoff from another origin, or nothing. */
export function handoffAtLoad(search: string, ownOrigin: string): { nonce: string; from: string } | null {
    const q = new URLSearchParams(search);
    if (q.get('door') !== HANDOFF_DOOR) return null;
    const nonce = q.get('n');
    const from = handoffOrigin(q.get('from'));
    if (!isHandoffNonce(nonce) || !from || from === ownOrigin) return null;
    return { nonce, from };
}

/** Takes the handoff out of the address once read, so a reload or a later door never reads it again. */
export function takeHandoffParams(): void {
    try {
        const url = new URL(window.location.href);
        for (const p of ['door', 'n', 'from']) url.searchParams.delete(p);
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* the address keeps it; nothing reads it but the load */ }
}

// ── The messages ─────────────────────────────────────────────────────────────────────────────────────────────

interface Message {
    tag: typeof TAG;
    v: typeof VERSION;
    type: string;
    nonce: string;
    account?: unknown;
    photo?: unknown;
}

function message(type: string, nonce: string, extra: Partial<Message> = {}): Message {
    return { tag: TAG, v: VERSION, type, nonce, ...extra };
}

function asMessage(data: unknown, nonce: string): Message | null {
    if (!data || typeof data !== 'object') return null;
    const m = data as Partial<Message>;
    return m.tag === TAG && m.v === VERSION && typeof m.type === 'string' && m.nonce === nonce ? m as Message : null;
}

export const readyMessage = (nonce: string) => message('ready', nonce);
export const answerMessage = (nonce: string, answer: HandoffAnswer) => message(answer, nonce);
export const accountMessage = (nonce: string, account: HandedAccount, photo: string | null) =>
    message('account', nonce, { account: { ...account }, ...(photo ? { photo } : {}) });

/** The holder: whether `event` is the opened page's `ready`, from that window, at the knock's origin, for this nonce. */
export function isReadyFrom(event: MessageEvent, win: Window, origin: string, nonce: string): boolean {
    return event.source === win && event.origin === origin && asMessage(event.data, nonce)?.type === 'ready';
}

/** The holder: the opened page's answer, from that window, at the knock's origin, for this nonce; or null. */
export function answerFrom(event: MessageEvent, win: Window, origin: string, nonce: string): HandoffAnswer | null {
    if (event.source !== win || event.origin !== origin) return null;
    const type = asMessage(event.data, nonce)?.type;
    return type && ANSWERS.has(type) ? type as HandoffAnswer : null;
}

/** The public key a stored private key (raw seed or PKCS8, as identity.ts keeps it) makes, or null if it is no key. */
function publicKeyOf(privateKeyHex: string): string | null {
    try {
        return bytesToHex(ed25519.getPublicKey(toEd25519Seed(hexToBytes(privateKeyHex))));
    } catch {
        return null;
    }
}

/**
 * The receiver: the account `event` carries, checked, or null. Only from `opener`, at `from`, with `nonce`, of the
 * account's shape; the private key must make the public key, and the 12 words (when there are any) the same key, so
 * what is kept here is one account, whole. A photo that isn't one a profile takes is left behind, never refused.
 */
export async function accountFrom(
    event: MessageEvent, opener: Window | null, from: string, nonce: string,
): Promise<{ account: BeanPoolIdentity; photo: string | null } | null> {
    if (!opener || event.source !== opener || event.origin !== from) return null;
    const m = asMessage(event.data, nonce);
    if (m?.type !== 'account' || !m.account || typeof m.account !== 'object') return null;
    const a = m.account as Record<string, unknown>;
    const publicKey = typeof a.publicKey === 'string' ? a.publicKey : '';
    const privateKey = typeof a.privateKey === 'string' ? a.privateKey : '';
    if (!/^[0-9a-f]{64}$/.test(publicKey) || !/^[0-9a-f]{64,200}$/.test(privateKey)) return null;
    if (publicKeyOf(privateKey) !== publicKey) return null;
    const callsign = typeof a.callsign === 'string' ? a.callsign.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    let mnemonic: string[] | undefined;
    if (a.mnemonic !== undefined) {
        const words = a.mnemonic;
        if (!Array.isArray(words) || words.length !== 12 || !words.every(w => typeof w === 'string')) return null;
        if (!validateMnemonic(words as string[])) return null;
        const made = await identityFromMnemonic(words as string[], '').catch(() => null);
        if (made?.publicKey !== publicKey) return null;
        mnemonic = [...(words as string[])];
    }
    const photo = knockAvatar(typeof m.photo === 'string' ? m.photo : null) ?? null;
    return {
        account: { publicKey, privateKey, callsign, createdAt: new Date().toISOString(), ...(mnemonic ? { mnemonic } : {}) },
        photo,
    };
}

// ── The holder ───────────────────────────────────────────────────────────────────────────────────────────────

export type HandoffEnd = HandoffAnswer | 'timeout' | 'closed';

export interface HandoffRun {
    /** Stop listening, with no answer said. */
    cancel(): void;
}

/**
 * The holder's side, once the window is open: waits for its `ready`, posts the account to `origin` only, and says what
 * came back (`onEnd`, once). `timeout`: no `ready` in `readyMs`, or no answer in `answerMs`. `closed`: the window went
 * before it answered. `listenOn` is where messages arrive (this page's window).
 */
export function runHandoff(opts: {
    win: Window;
    origin: string;
    nonce: string;
    account: () => Promise<{ account: HandedAccount; photo: string | null }>;
    listenOn: Pick<Window, 'addEventListener' | 'removeEventListener'>;
    onSent?: () => void;
    onEnd: (end: HandoffEnd) => void;
    readyMs?: number;
    answerMs?: number;
    pollMs?: number;
}): HandoffRun {
    const { win, origin, nonce } = opts;
    let state: 'waiting' | 'sending' | 'sent' | 'done' = 'waiting';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = (how: HandoffEnd | null) => {
        if (state === 'done') return;
        state = 'done';
        opts.listenOn.removeEventListener('message', onMessage as EventListener);
        clearTimeout(timer);
        clearInterval(poll);
        if (how) opts.onEnd(how);
    };
    const onMessage = (event: MessageEvent) => {
        if (state === 'waiting' && isReadyFrom(event, win, origin, nonce)) {
            state = 'sending';
            clearTimeout(timer);
            void opts.account().then(({ account, photo }) => {
                if (state !== 'sending') return;
                // The one post with the key in it: to the knock's own origin, never '*'.
                win.postMessage(accountMessage(nonce, account, photo), origin);
                state = 'sent';
                timer = setTimeout(() => end('timeout'), opts.answerMs ?? HANDOFF_ANSWER_MS);
                opts.onSent?.();
            }, () => end('timeout'));
            return;
        }
        if (state === 'sent') {
            const answer = answerFrom(event, win, origin, nonce);
            if (answer) end(answer);
        }
    };
    opts.listenOn.addEventListener('message', onMessage as EventListener);
    timer = setTimeout(() => end('timeout'), opts.readyMs ?? HANDOFF_READY_MS);
    const poll = setInterval(() => {
        let closed = false;
        try { closed = win.closed; } catch { /* cut off from it: as closed */ closed = true; }
        if (closed) end(state === 'sent' ? 'closed' : 'timeout');
    }, opts.pollMs ?? 1000);
    return { cancel: () => end(null) };
}

/**
 * The photo the holder offers with the account (Marty, 9 Nov: a tickbox at the community, off by default): this
 * member's picture here as a profile takes it (a shipped picture, or a data URL under the knock's limit), read from this
 * node at the tap. None, or one that can't be read: null, and no tickbox is offered.
 */
export async function holderPhoto(publicKey: string): Promise<string | null> {
    try {
        const profile = await getMemberProfile(publicKey, publicKey);
        const value = typeof profile?.avatar === 'string' ? profile.avatar.trim() : '';
        if (!value) return null;
        const direct = knockAvatar(value);
        if (direct) return direct;
        // A picture the node serves (its own address, or a path on it): read here and carried as a data URL.
        const base = getNodeApiUrl() || window.location.origin;
        const url = new URL(value, base);
        if (url.origin !== new URL(base).origin) return null;
        const res = await fetch(url.toString());
        if (!res.ok) return null;
        const blob = await res.blob();
        if (!/^image\/(jpeg|png|webp|gif)$/.test(blob.type) || blob.size > 100_000) return null;
        const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
        return knockAvatar(data) ?? null;
    } catch {
        return null;
    }
}

// ── The receiver, after Join ─────────────────────────────────────────────────────────────────────────────────

let reply: { publicKey: string; opener: Window; from: string; nonce: string; photo: string | null } | null = null;

/** The receiver, at Join: who to tell once the yes has made this key a member (handoffJoined), and the photo ticked. */
export function awaitHandoffJoin(publicKey: string, opener: Window, from: string, nonce: string, photo: string | null): void {
    reply = { publicKey, opener, from, nonce, photo };
}

/**
 * The yes has made `publicKey` a member here (WelcomePage enterAsInvited): the page it came from hears `joined`, at its
 * own origin only, and the photo ticked at Join (or null) is returned for the photo step. Anything else: nothing.
 */
export function handoffJoined(publicKey: string): string | null {
    if (!reply || reply.publicKey !== publicKey) return null;
    const { opener, from, nonce, photo } = reply;
    reply = null;
    try { opener.postMessage(answerMessage(nonce, 'joined'), from); } catch { /* its tab has gone: its next status read says member */ }
    return photo;
}
