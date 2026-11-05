/**
 * A member's ask that an admin invite someone (apps/server routes/invite-asks.ts), signed by the member's own key. What a
 * screen does with an answer is components/InviteAsks.tsx; the reading of the node's answers is core's, the same on the web.
 */
import { readInviteAsksMine, readInviteAsksToAnswer, type InviteAskToAnswer } from '@beanpool/core';
import { signedGet, signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';

const ASKS = '/api/invite/asks';
const one = (id: string, verb: string) => `${ASKS}/${encodeURIComponent(id)}/${verb}`;

/** `message`: the node's own words, or null when it couldn't be reached. */
export type InviteAskResult = { ok: true } | { ok: false; message: string | null };

async function post(anchorUrl: string, identity: BeanPoolIdentity, path: string, body: Record<string, unknown>): Promise<InviteAskResult> {
    try {
        const res = await signedPost(anchorUrl, path, body, identity);
        if (res.ok) return { ok: true };
        const said = await res.json().catch(() => null) as { error?: unknown } | null;
        return { ok: false, message: typeof said?.error === 'string' && said.error.trim() ? said.error : null };
    } catch {
        return { ok: false, message: null };
    }
}

export const askAnAdmin = (anchorUrl: string, identity: BeanPoolIdentity, firstName: string, howKnown: string) =>
    post(anchorUrl, identity, ASKS, { firstName: firstName.trim(), howKnown: howKnown.trim() });

export const takeBackAsk = (anchorUrl: string, identity: BeanPoolIdentity, id: string) => post(anchorUrl, identity, one(id, 'withdraw'), {});

/** "Send invite". */
export const sendInviteForAsk = (anchorUrl: string, identity: BeanPoolIdentity, id: string) =>
    post(anchorUrl, identity, one(id, 'send'), {});

export const sayNoToAsk = (anchorUrl: string, identity: BeanPoolIdentity, id: string, reason: string) =>
    post(anchorUrl, identity, one(id, 'no'), reason.trim() ? { reason: reason.trim() } : {});

async function read<T>(anchorUrl: string, identity: BeanPoolIdentity, path: string, parse: (raw: unknown) => T | null): Promise<T | null> {
    try {
        const res = await signedGet(anchorUrl, path, identity);
        return res.ok ? parse(await res.json()) : null;
    } catch {
        return null;
    }
}

export const readMyAsks = (anchorUrl: string, identity: BeanPoolIdentity) => read(anchorUrl, identity, `${ASKS}/mine`, readInviteAsksMine);

/** The asks to answer. Null: this key doesn't answer them here, or the node couldn't be reached: no section either way. */
export const readAsksToAnswer = (anchorUrl: string, identity: BeanPoolIdentity): Promise<InviteAskToAnswer[] | null> =>
    read(anchorUrl, identity, ASKS, readInviteAsksToAnswer);
