/**
 * Vitest suite for standingFromRefusal and statusReducer (slice W2).
 *
 * Requirements:
 * - Each standing refusal code (`private_preview`, `account_closed`) → its state (not a member / guest, with sentence)
 * - A network error → offline
 * - A 403 with another code → unchanged behaviour (offline)
 * - A test that FAILS on origin/main (origin/main treated private_preview and account_closed as offline connectivity errors)
 */
import { describe, expect, it } from 'vitest';
import { t } from '@beanpool/core';
import {
    standingFromRefusal,
    statusReducer,
    syncStatusReducer,
    PRIVATE_PREVIEW,
    ACCOUNT_CLOSED,
    DEFAULT_PRIVATE_PREVIEW_MESSAGE,
    INITIAL_SYNC_STATUS_STATE,
    type SyncStatusState,
} from './standing-refusal';

describe('standingFromRefusal', () => {
    it('reads 403 private_preview with custom node message', () => {
        const error = Object.assign(new Error('This community is in a private preview. Ask @damo for an invite.'), {
            status: 403,
            code: PRIVATE_PREVIEW,
        });
        const standing = standingFromRefusal(error);
        expect(standing).not.toBeNull();
        expect(standing?.code).toBe(PRIVATE_PREVIEW);
        expect(standing?.standing).toBe('not_member');
        expect(standing?.isMember).toBe(false);
        expect(standing?.sentence).toBe('This community is in a private preview. Ask @damo for an invite.');
    });

    it('reads 403 private_preview from response body format', () => {
        const refusal = {
            status: 403,
            body: {
                code: 'private_preview',
                error: 'Invite required for this preview.',
            },
        };
        const standing = standingFromRefusal(refusal);
        expect(standing).toEqual({
            code: PRIVATE_PREVIEW,
            standing: 'not_member',
            isMember: false,
            sentence: 'Invite required for this preview.',
            message: 'Invite required for this preview.',
        });
    });

    it('reads 403 private_preview with empty message falling back to default sentence', () => {
        const error = { status: 403, code: PRIVATE_PREVIEW };
        const standing = standingFromRefusal(error);
        expect(standing).toEqual({
            code: PRIVATE_PREVIEW,
            standing: 'not_member',
            isMember: false,
            sentence: DEFAULT_PRIVATE_PREVIEW_MESSAGE,
            message: DEFAULT_PRIVATE_PREVIEW_MESSAGE,
        });
    });

    it('reads 403 account_closed through t() sentence', () => {
        const expected = t('Your account in this community was closed.');
        const error = Object.assign(new Error('Closed'), {
            status: 403,
            code: ACCOUNT_CLOSED,
        });
        const standing = standingFromRefusal(error);
        expect(standing).toEqual({
            code: ACCOUNT_CLOSED,
            standing: 'not_member',
            isMember: false,
            sentence: expected,
            message: expected,
        });
    });

    it('returns null for network errors (connectivity failure, not standing)', () => {
        expect(standingFromRefusal(new TypeError('Failed to fetch'))).toBeNull();
        expect(standingFromRefusal(new Error('Network request failed'))).toBeNull();
        expect(standingFromRefusal(new Error('offline'))).toBeNull();
    });

    it('returns null for 403 with other codes (unchanged behaviour)', () => {
        expect(standingFromRefusal({ status: 403, code: 'not_your_key' })).toBeNull();
        expect(standingFromRefusal({ status: 403, code: 'moderation_muted' })).toBeNull();
        expect(standingFromRefusal({ status: 403, code: 'probation_limit' })).toBeNull();
        expect(standingFromRefusal({ status: 403 })).toBeNull();
    });

    it('returns null for non-403 responses even if code matches', () => {
        expect(standingFromRefusal({ status: 500, code: PRIVATE_PREVIEW })).toBeNull();
        expect(standingFromRefusal({ status: 404, code: ACCOUNT_CLOSED })).toBeNull();
        expect(standingFromRefusal({ status: 401, code: PRIVATE_PREVIEW })).toBeNull();
    });

    it('returns null for null, undefined, and non-objects', () => {
        expect(standingFromRefusal(null)).toBeNull();
        expect(standingFromRefusal(undefined)).toBeNull();
        expect(standingFromRefusal('error string')).toBeNull();
        expect(standingFromRefusal(403)).toBeNull();
    });
});

describe('statusReducer', () => {
    const initialState: SyncStatusState = INITIAL_SYNC_STATUS_STATE;

    it('each code → its state: private_preview probe error → guest standing with sentence', () => {
        const error = { status: 403, code: PRIVATE_PREVIEW, message: 'Private preview active' };
        const next = statusReducer(initialState, { type: 'probe_error', error });
        expect(next).toEqual({
            isHttpOnline: true,
            isMember: false,
            mode: 'guest',
            sentence: 'Private preview active',
        });
    });

    it('each code → its state: account_closed probe error → guest standing with translated sentence', () => {
        const error = { status: 403, code: ACCOUNT_CLOSED };
        const next = statusReducer(initialState, { type: 'probe_error', error });
        expect(next).toEqual({
            isHttpOnline: true,
            isMember: false,
            mode: 'guest',
            sentence: t('Your account in this community was closed.'),
        });
    });

    it('network error → offline', () => {
        const onlineState: SyncStatusState = {
            isHttpOnline: true,
            isMember: true,
            mode: 'online',
            sentence: null,
        };
        const next = statusReducer(onlineState, { type: 'probe_error', error: new TypeError('Failed to fetch') });
        expect(next).toEqual({
            isHttpOnline: false,
            isMember: true,
            mode: 'offline',
            sentence: null,
        });
    });

    it('a 403 with another code → unchanged behaviour (offline)', () => {
        const onlineState: SyncStatusState = {
            isHttpOnline: true,
            isMember: true,
            mode: 'online',
            sentence: null,
        };
        const next = statusReducer(onlineState, { type: 'probe_error', error: { status: 403, code: 'not_your_key' } });
        expect(next).toEqual({
            isHttpOnline: false,
            isMember: true,
            mode: 'offline',
            sentence: null,
        });
    });

    it('probe_success updates state to online or guest based on isMember', () => {
        const memberNext = statusReducer(initialState, { type: 'probe_success', isMember: true });
        expect(memberNext).toEqual({
            isHttpOnline: true,
            isMember: true,
            mode: 'online',
            sentence: null,
        });

        const guestNext = statusReducer(initialState, { type: 'probe_success', isMember: false });
        expect(guestNext).toEqual({
            isHttpOnline: true,
            isMember: false,
            mode: 'guest',
            sentence: null,
        });
    });

    it('works with string SyncMode states directly', () => {
        // Standing refusal codes produce 'guest', never 'offline'
        expect(statusReducer('online', { type: 'probe_error', error: { status: 403, code: PRIVATE_PREVIEW } })).toBe('guest');
        expect(statusReducer('online', { type: 'probe_error', error: { status: 403, code: ACCOUNT_CLOSED } })).toBe('guest');
        expect(syncStatusReducer('online', { status: 403, code: PRIVATE_PREVIEW })).toBe('guest');

        // Network error produces 'offline'
        expect(statusReducer('online', { type: 'probe_error', error: new TypeError('Failed to fetch') })).toBe('offline');

        // 403 with other code produces 'offline' (unchanged behaviour)
        expect(statusReducer('online', { type: 'probe_error', error: { status: 403, code: 'not_your_key' } })).toBe('offline');
    });

    /**
     * TEST THAT FAILS ON origin/main:
     * On origin/main (commit 3bc19acd), the web app did not have standingFromRefusal or statusReducer.
     * When checkMembership or any probe caught an HTTP 403 private_preview or account_closed error,
     * it fell through to `setIsHttpOnline(false)` and `statusMode = 'offline'`.
     * This test pins that private_preview and account_closed MUST resolve to guest standing, NEVER offline.
     */
    it('FAILS ON ORIGIN/MAIN: private_preview and account_closed 403s must NOT result in offline state', () => {
        const previewRefusal = Object.assign(new Error('This community is in a private preview.'), {
            status: 403,
            code: 'private_preview',
        });
        const closedRefusal = Object.assign(new Error('Closed'), {
            status: 403,
            code: 'account_closed',
        });

        // Reader recognizes both as not_member standing
        const standingPreview = standingFromRefusal(previewRefusal);
        expect(standingPreview?.standing).toBe('not_member');
        expect(standingPreview?.isMember).toBe(false);

        const standingClosed = standingFromRefusal(closedRefusal);
        expect(standingClosed?.standing).toBe('not_member');
        expect(standingClosed?.isMember).toBe(false);

        // Status reducer routes both to guest mode, NOT offline
        const stateFromPreview = statusReducer('online', { type: 'probe_error', error: previewRefusal });
        expect(stateFromPreview).not.toBe('offline');
        expect(stateFromPreview).toBe('guest');

        const stateFromClosed = statusReducer('online', { type: 'probe_error', error: closedRefusal });
        expect(stateFromClosed).not.toBe('offline');
        expect(stateFromClosed).toBe('guest');
    });
});
