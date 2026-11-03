/**
 * A member's ask that an admin invite someone (apps/server routes/invite-asks.ts), signed by the member's own key: the
 * phone's utils/invite-asks.ts. The reading of the node's answers is core's, the same on both apps.
 */
import { readInviteAsksMine, readInviteAsksToAnswer, type InviteAskToAnswer, type VouchLevel } from '@beanpool/core';
import { signedFetch } from './api';

const ASKS = '/api/invite/asks';
const one = (id: string, verb: string) => `${ASKS}/${encodeURIComponent(id)}/${verb}`;

/** `message`: the node's own words, or null when it couldn't be reached. */
export type InviteAskResult = { ok: true } | { ok: false; message: string | null };

async function post(path: string, body: Record<string, unknown>): Promise<InviteAskResult> {
    try {
        const res = await signedFetch('POST', path, body);
        if (res.ok) return { ok: true };
        const said = await res.json().catch(() => null) as { error?: unknown } | null;
        return { ok: false, message: typeof said?.error === 'string' && said.error.trim() ? said.error : null };
    } catch {
        return { ok: false, message: null };
    }
}

export const askAnAdmin = (firstName: string, howKnown: string) => post(ASKS, { firstName: firstName.trim(), howKnown: howKnown.trim() });
export const takeBackAsk = (id: string) => post(one(id, 'withdraw'), {});
/** "Send invite". No level: None, the default. */
export const sendInviteForAsk = (id: string, vouchLevel: VouchLevel | null) => post(one(id, 'send'), vouchLevel === null ? {} : { vouchLevel });
export const sayNoToAsk = (id: string, reason: string) => post(one(id, 'no'), reason.trim() ? { reason: reason.trim() } : {});

async function read<T>(path: string, parse: (raw: unknown) => T | null): Promise<T | null> {
    try {
        const res = await signedFetch('GET', path);
        return res.ok ? parse(await res.json()) : null;
    } catch {
        return null;
    }
}

export const readMyAsks = () => read(`${ASKS}/mine`, readInviteAsksMine);

/** The asks to answer. Null: this key doesn't answer them here, or the node couldn't be reached: no section either way. */
export const readAsksToAnswer = (): Promise<InviteAskToAnswer[] | null> => read(ASKS, readInviteAsksToAnswer);
