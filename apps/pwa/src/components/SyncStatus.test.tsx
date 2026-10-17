/**
 * Component tests for SyncStatus (slice W2).
 *
 * Verifies that:
 * - A 403 with code `private_preview` or `account_closed` is treated as "not a member" (Guest), showing the sentence.
 * - Never "Offline" for private_preview or account_closed.
 * - "Offline" is shown only when there is a connectivity error / no answer or a 403 with other codes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SyncStatus } from './SyncStatus';
import * as api from '../lib/api';
import * as identityLib from '../lib/identity';
import * as syncLib from '../lib/sync';
import { t } from '@beanpool/core';

const MOCK_IDENTITY = {
    publicKey: 'pk-test-1234',
    privateKey: 'sk-test-1234',
    callsign: 'TestUser',
    createdAt: '2026-10-01T00:00:00.000Z',
};

describe('SyncStatus', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(identityLib, 'loadIdentity').mockResolvedValue(MOCK_IDENTITY);
        vi.spyOn(syncLib, 'onSyncChange').mockImplementation((cb) => {
            cb({ connected: false, lastSyncTime: null, merkleRoot: null, accountCount: 0 });
            return () => {};
        });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('treats 403 private_preview probe rejection as Guest with sentence, never Offline', async () => {
        const previewRefusal = Object.assign(new Error('This community is in a private preview. Ask its owner for an invite.'), {
            status: 403,
            code: 'private_preview',
        });
        vi.spyOn(api, 'checkMembership').mockRejectedValue(previewRefusal);

        render(<SyncStatus />);

        // Should display Guest, NOT Offline
        await waitFor(() => {
            expect(screen.getByText('Guest')).toBeInTheDocument();
        });
        expect(screen.queryByText('Offline')).toBeNull();

        // Seen on a touch screen (no hover): the sentence is on the page by the chip, and in the chip's name.
        const sentence = 'This community is in a private preview. Ask its owner for an invite.';
        expect(screen.getByTestId('sync-note')).toHaveTextContent(sentence);
        const chip = screen.getByTestId('sync-chip');
        expect(chip.getAttribute('aria-label')).toBe(`Network status: Guest. ${sentence}`);
        expect(chip.getAttribute('title')).toBe(sentence);
    });

    it('a tap on the chip folds the sentence away and brings it back; its name keeps it either way', async () => {
        vi.spyOn(api, 'checkMembership').mockRejectedValue(Object.assign(new Error('This community is in a private preview. Ask its owner for an invite.'), {
            status: 403,
            code: 'private_preview',
        }));

        render(<SyncStatus stacked />);

        const note = await screen.findByTestId('sync-note');
        const toggle = screen.getByRole('button', { expanded: true });
        expect(toggle.getAttribute('aria-controls')).toBe(note.id);

        fireEvent.click(toggle);
        expect(screen.queryByTestId('sync-note')).toBeNull();
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('sync-chip').getAttribute('aria-label')).toContain('Ask its owner for an invite.');

        fireEvent.click(toggle);
        fireEvent.click(screen.getByTestId('sync-note'));
        expect(screen.queryByTestId('sync-note')).toBeNull();
    });

    it('treats 403 account_closed probe rejection as Guest with closed account sentence, never Offline', async () => {
        const closedRefusal = Object.assign(new Error('Closed'), {
            status: 403,
            code: 'account_closed',
        });
        vi.spyOn(api, 'checkMembership').mockRejectedValue(closedRefusal);

        render(<SyncStatus />);

        await waitFor(() => {
            expect(screen.getByText('Guest')).toBeInTheDocument();
        });
        expect(screen.queryByText('Offline')).toBeNull();

        const sentence = t('Your account in this community was closed.');
        expect(screen.getByTestId('sync-note')).toHaveTextContent(sentence);
        expect(screen.getByTestId('sync-chip').getAttribute('aria-label')).toBe(`Network status: Guest. ${sentence}`);
    });

    // jsdom lays nothing out, so the chip's place and the sentence's width are given as a 320 px screen measures them.
    // Before the fix the sentence was always `left: 0` under the chip: a chip at x 223 put a 289 px sentence over 223..512.
    it.each([
        { side: 'left', chipLeft: 12 },
        { side: 'right', chipLeft: 223 },
    ])('the sentence stays on a 320 px screen with the chip on the $side', async ({ chipLeft }) => {
        const SENTENCE_WIDTH = 289;
        vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(320);
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            const isNote = this.getAttribute('data-testid') === 'sync-note';
            const left = isNote ? chipLeft + (parseFloat((this as HTMLElement).style.left) || 0) : chipLeft;
            const width = isNote ? SENTENCE_WIDTH : 60;
            return { left, right: left + width, width, x: left, top: 0, bottom: 20, height: 20, y: 0, toJSON: () => ({}) } as DOMRect;
        });
        vi.spyOn(api, 'checkMembership').mockRejectedValue(Object.assign(new Error('This community is in a private preview. Ask its owner for an invite.'), {
            status: 403,
            code: 'private_preview',
        }));

        render(<SyncStatus stacked />);

        const box = (await screen.findByTestId('sync-note')).getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(320);
        // On the left it hangs from the chip's edge, as it always did.
        if (chipLeft === 12) expect(box.left).toBe(12);
    });

    it('shows Offline on network failure (connectivity failure, no answer)', async () => {
        vi.spyOn(api, 'checkMembership').mockRejectedValue(new TypeError('Failed to fetch'));

        render(<SyncStatus />);

        await waitFor(() => {
            expect(screen.getByText('Offline')).toBeInTheDocument();
        });
        expect(screen.queryByText('Guest')).toBeNull();
        // No sentence, no note and nothing to tap: the chip as it always was.
        expect(screen.queryByTestId('sync-note')).toBeNull();
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.getByTestId('sync-chip').getAttribute('aria-label')).toBe('Network status: Offline');
    });

    it('shows Offline on 403 with other codes (e.g. not_your_key)', async () => {
        const otherRefusal = Object.assign(new Error('Forbidden key'), {
            status: 403,
            code: 'not_your_key',
        });
        vi.spyOn(api, 'checkMembership').mockRejectedValue(otherRefusal);

        render(<SyncStatus />);

        await waitFor(() => {
            expect(screen.getByText('Offline')).toBeInTheDocument();
        });
        expect(screen.queryByText('Guest')).toBeNull();
    });

    it('shows Online when membership probe succeeds for a member', async () => {
        vi.spyOn(api, 'checkMembership').mockResolvedValue({ isMember: true, callsign: 'TestUser' });

        render(<SyncStatus />);

        await waitFor(() => {
            expect(screen.getByText('Online')).toBeInTheDocument();
        });
    });

    it('shows Guest when membership probe succeeds for a non-member', async () => {
        vi.spyOn(api, 'checkMembership').mockResolvedValue({ isMember: false, callsign: null });

        render(<SyncStatus />);

        await waitFor(() => {
            expect(screen.getByText('Guest')).toBeInTheDocument();
        });
    });
});
