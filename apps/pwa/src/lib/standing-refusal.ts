/**
 * Standing refusals: answers from the node that are about standing (the key is not a member, or its account was closed),
 * not about connectivity (DESIGN-global-entry-fable.md §1.3, slice W2).
 *
 * In a private preview the node answers 403 `private_preview` to any non-member read. When an account was closed (pruned or
 * deleted by its owner), every signed request is answered with 403 `account_closed`; when an owner retired it as an empty
 * duplicate (server engine/retire-duplicate.ts), with 403 `account_retired`.
 *
 * The web app reads all three as "not a member" and shows a sentence (for private_preview, the 403 body's `error` text;
 * for account_closed, "Your account in this community was closed." through t(); for account_retired, core's
 * ACCOUNT_RETIRED_LINE through t(), the phone's words too), NEVER "Offline" or "Having trouble connecting".
 * "Offline" is kept strictly for when there was no answer from the node at all.
 */
import { ACCOUNT_RETIRED_CODE, ACCOUNT_RETIRED_LINE, isBusyStatus, t } from '@beanpool/core';
import type { SyncMode } from '../components/SyncChip';

export const PRIVATE_PREVIEW = 'private_preview';
export const ACCOUNT_CLOSED = 'account_closed';
export const ACCOUNT_RETIRED = ACCOUNT_RETIRED_CODE;

export const DEFAULT_PRIVATE_PREVIEW_MESSAGE = 'This community is in a private preview. Ask its owner for an invite.';

export type StandingCode = typeof PRIVATE_PREVIEW | typeof ACCOUNT_CLOSED | typeof ACCOUNT_RETIRED;

export interface StandingRefusal {
    code: StandingCode;
    standing: 'not_member';
    isMember: false;
    /** The sentence to display in place of "Offline" or "Couldn't reach your community". */
    sentence: string;
    /** Alias for sentence */
    message: string;
}

/**
 * Pure reader that identifies standing refusals (403 `private_preview`, `account_closed` or `account_retired`).
 * Returns a StandingRefusal with the appropriate sentence, or null if the error is a network failure,
 * a 403 with another code, or any other response.
 */
export function standingFromRefusal(e: unknown): StandingRefusal | null {
    if (!e || typeof e !== 'object') return null;

    const err = e as {
        status?: unknown;
        statusCode?: unknown;
        code?: unknown;
        message?: unknown;
        error?: unknown;
        body?: { code?: unknown; error?: unknown; message?: unknown };
        response?: { status?: unknown };
    };

    const status = err.status ?? err.statusCode ?? err.response?.status;
    // 403 status is required for standing refusals. If status is undefined, we check if code is explicitly one of the three.
    if (status !== undefined && status !== 403) return null;

    const code = (err.code ?? err.body?.code) as unknown;
    if (code !== PRIVATE_PREVIEW && code !== ACCOUNT_CLOSED && code !== ACCOUNT_RETIRED) return null;

    if (code === PRIVATE_PREVIEW) {
        // The node sends its sentence as `error` (lib/api's request makes that the thrown Error's message).
        const text = [err.body?.error, err.error, err.body?.message, err.message].find((s) => typeof s === 'string' && s.trim());
        const sentence = typeof text === 'string' && text.trim() ? text.trim() : DEFAULT_PRIVATE_PREVIEW_MESSAGE;
        return {
            code: PRIVATE_PREVIEW,
            standing: 'not_member',
            isMember: false,
            sentence,
            message: sentence,
        };
    }

    // ACCOUNT_RETIRED: an owner retired this account as an empty duplicate. Core's line through t(), the phone's words
    // too, never the node's own error text (that is the server's catalog; this is what the member's app says).
    if (code === ACCOUNT_RETIRED) {
        const sentence = t(ACCOUNT_RETIRED_LINE);
        return {
            code: ACCOUNT_RETIRED,
            standing: 'not_member',
            isMember: false,
            sentence,
            message: sentence,
        };
    }

    // ACCOUNT_CLOSED: always routed through t("Your account in this community was closed.")
    const sentence = t('Your account in this community was closed.');
    return {
        code: ACCOUNT_CLOSED,
        standing: 'not_member',
        isMember: false,
        sentence,
        message: sentence,
    };
}

export interface SyncStatusState {
    isHttpOnline: boolean | null;
    isMember: boolean | null;
    mode: SyncMode;
    sentence?: string | null;
    /** Whether the live socket was connected at its last change: proof the node is answering when a probe is refused 5xx. */
    wsConnected?: boolean;
}

export const INITIAL_SYNC_STATUS_STATE: SyncStatusState = {
    isHttpOnline: null,
    isMember: null,
    mode: 'offline',
    sentence: null,
};

export type SyncStatusAction =
    | { type: 'probe_success'; isMember: boolean }
    | { type: 'probe_error'; error: unknown }
    | { type: 'ws_change'; connected: boolean };

/**
 * Pure reducer for sync status:
 * - Each standing refusal code (`private_preview`, `account_closed`, `account_retired`) → "not a member" (guest) with its sentence
 * - A network error → offline
 * - A 403 with another code → unchanged behaviour (offline)
 * - A 429 (the network in front of the node is busy) → the chip keeps what it showed; a 5xx does too while the live socket is up
 */
export function statusReducer(state: SyncStatusState, action: SyncStatusAction): SyncStatusState {
    // A probe's answer says nothing about the live socket, so every probe keeps what the socket last said: a later 5xx with
    // the socket still up must find it (the socket's own change fires again only on its next message).
    const socket = state.wsConnected === undefined ? {} : { wsConnected: state.wsConnected };
    switch (action.type) {
        case 'probe_success':
            return {
                isHttpOnline: true,
                isMember: action.isMember,
                mode: action.isMember ? 'online' : 'guest',
                sentence: null,
                ...socket,
            };
        case 'probe_error': {
            const standing = standingFromRefusal(action.error);
            if (standing) return { isHttpOnline: true, isMember: false, mode: 'guest', sentence: standing.sentence, ...socket };
            // The network in front of the node is busy (429), or the node answered a 5xx while its live socket is up:
            // something answered, so the chip keeps what it showed and the next probe judges again. "Offline" is for when
            // nothing answered, or a 5xx with the socket down too (a tunnel with no node behind it, 530).
            const status = (action.error as { status?: unknown } | null)?.status;
            if (isBusyStatus(status)) return state;
            if (typeof status === 'number' && status >= 500 && status <= 599 && state.wsConnected === true) return state;
            return { isHttpOnline: false, isMember: state.isMember, mode: 'offline', sentence: null, ...socket };
        }
        case 'ws_change': {
            const mode: SyncMode = action.connected
                ? (state.isMember === false ? 'guest' : 'online')
                : (state.isHttpOnline && state.isMember === true)
                ? 'online'
                : (state.isHttpOnline && state.isMember === false)
                ? 'guest'
                : 'offline';
            return { ...state, mode, wsConnected: action.connected };
        }
    }
}
