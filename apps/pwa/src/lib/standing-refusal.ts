/**
 * Standing refusals: answers from the node that are about standing (the key is not a member, or its account was closed),
 * not about connectivity (DESIGN-global-entry-fable.md §1.3, slice W2).
 *
 * In a private preview the node answers 403 `private_preview` to any non-member read. When an account was closed (pruned or
 * deleted by its owner), every signed request is answered with 403 `account_closed`.
 *
 * The web app reads both as "not a member" and shows the node's sentence (for private_preview, the 403 body's `error` text;
 * for account_closed, "Your account in this community was closed." through t()), NEVER "Offline" or "Having trouble connecting".
 * "Offline" is kept strictly for when there was no answer from the node at all.
 */
import { t } from '@beanpool/core';
import type { SyncMode } from '../components/SyncChip';

export const PRIVATE_PREVIEW = 'private_preview';
export const ACCOUNT_CLOSED = 'account_closed';

export const DEFAULT_PRIVATE_PREVIEW_MESSAGE = 'This community is in a private preview. Ask its owner for an invite.';

export type StandingCode = typeof PRIVATE_PREVIEW | typeof ACCOUNT_CLOSED;

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
 * Pure reader that identifies standing refusals (403 `private_preview` or `account_closed`).
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
    // 403 status is required for standing refusals. If status is undefined, we check if code is explicitly one of the two.
    if (status !== undefined && status !== 403) return null;

    const code = (err.code ?? err.body?.code) as unknown;
    if (code !== PRIVATE_PREVIEW && code !== ACCOUNT_CLOSED) return null;

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
 * - Each standing refusal code (`private_preview`, `account_closed`) → "not a member" (guest) with its sentence
 * - A network error → offline
 * - A 403 with another code → unchanged behaviour (offline)
 */
export function statusReducer(state: SyncStatusState, action: SyncStatusAction): SyncStatusState {
    switch (action.type) {
        case 'probe_success':
            return {
                isHttpOnline: true,
                isMember: action.isMember,
                mode: action.isMember ? 'online' : 'guest',
                sentence: null,
            };
        case 'probe_error': {
            const standing = standingFromRefusal(action.error);
            return standing
                ? { isHttpOnline: true, isMember: false, mode: 'guest', sentence: standing.sentence }
                : { isHttpOnline: false, isMember: state.isMember, mode: 'offline', sentence: null };
        }
        case 'ws_change': {
            const mode: SyncMode = action.connected
                ? (state.isMember === false ? 'guest' : 'online')
                : (state.isHttpOnline && state.isMember === true)
                ? 'online'
                : (state.isHttpOnline && state.isMember === false)
                ? 'guest'
                : 'offline';
            return { ...state, mode };
        }
    }
}
