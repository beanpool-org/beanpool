/**
 * The two names-list rows on the web's invite screen (DESIGN-invites-and-names-list-amend3-fable.md §1, §4, slice A3; Marty,
 * 8 Nov, Q2: phone first; 9 Nov: "I get a circle with a line through it when I try and add a friend in PWA … maybe we can say
 * — needs to be done in app? a message?"). An owner or admin on a node that offers the names list sees "Add them to the names
 * list" and "Make them a voucher" under the vouch presets, switched off: they never tick. Tapping either one (or its box, or
 * Space or Enter on it) says at once, beside that row, where it is done: in the BeanPool app on the phone. On a phone's
 * browser the sentence has an "Open in the BeanPool app" link beside it; on a computer, none. A member sees nothing new; the
 * presets and what an invite sends are as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async () => ({
            success: true,
            invite: { code: 'INV-ABCD-EFGH', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null },
        })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: [] })),
        getInviteTree: vi.fn(async () => []),
        getVouchersBlock: vi.fn(async () => null),
        myNodeRoleOnce: vi.fn(async () => 'owner'),
        getMyVouching: vi.fn(async () => ({
            voucher: true,
            budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
            presets: [25, 50, 75, 100],
            vouchMax: 100,
            budgetMax: 2000,
            vouchedBy: [],
        })),
    };
});

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { invites: true, beans: true },
    })),
}));

vi.mock('qrcode.react', () => ({ QRCodeSVG: vi.fn(() => null) }));

import { InvitePage } from './InvitePage';
import { generateInvite, getMyVouching, myNodeRoleOnce } from '../lib/api';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { ANDROID_PACKAGE, APP_STORE_URL, PLAY_URL } from '../lib/peek';
import { PHONE_BROWSER_QUERY } from '../lib/global-entry';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };

const SENTENCE = 'Adding someone to the names list, and making them a voucher, is done in the BeanPool app on your phone.';
const OLD_SENTENCE = 'On the phone for now: the names list’s keys live on the admins’ phones.';

const ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** Renders the page and lets the node's answers (its info, the signer's role, the vouch budget) all land. */
async function renderPage(props: { preview?: boolean } = {}) {
    render(<InvitePage identity={IDENTITY} onNavigate={() => {}} {...props} />);
    if (!props.preview) {
        await waitFor(() => expect(myNodeRoleOnce).toHaveBeenCalled());
        await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
        await waitFor(() => expect(getMyVouching).toHaveBeenCalled());
    }
    await screen.findByText(/Invite Someone/);
    // One more turn so the answers above are set into the page before anything is asserted absent.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

let agentSpy: { mockRestore: () => void } | undefined;

/** This browser, as a phone's (a touch screen narrower than the sidebar) or a computer's, with the user agent it reports. */
function browserIs(kind: 'phone' | 'computer', userAgent?: string) {
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: vi.fn((query: string) => ({
            matches: kind === 'phone' && query === PHONE_BROWSER_QUERY,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    });
    if (userAgent) agentSpy = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

describe('InvitePage: the names-list rows, switched off on the web, and what a tap says (A3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        vi.mocked(myNodeRoleOnce).mockResolvedValue('owner');
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { invites: true, beans: true },
        } as never);
    });

    afterEach(() => {
        agentSpy?.mockRestore();
        agentSpy = undefined;
        // jsdom has no matchMedia of its own; put it back as it was found.
        delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    });

    it('an owner sees both rows switched off (aria-disabled, never ticked), and not the old line', async () => {
        await renderPage();

        const names = await screen.findByTestId('invite-adds-names');
        const voucher = screen.getByTestId('invite-adds-voucher');
        expect(screen.getByText('Add them to the names list')).toBeInTheDocument();
        expect(screen.getByText('Make them a voucher')).toBeInTheDocument();
        for (const box of [names, voucher]) {
            expect(box).toHaveAttribute('type', 'checkbox');
            expect(box).toHaveAttribute('aria-disabled', 'true');
            expect(box).not.toBeChecked();
            // Switched off but not a dead end: not the `disabled` attribute, which swallows the tap and shows the ⊘ cursor.
            expect(box).not.toBeDisabled();
        }
        expect(screen.queryByText(OLD_SENTENCE)).not.toBeInTheDocument();
        expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
        expect(screen.queryByTestId('invite-adds-note')).not.toBeInTheDocument();
    });

    it('the rows do not show the not-allowed cursor (the ⊘ Marty met)', async () => {
        await renderPage();
        const row = (await screen.findByTestId('invite-adds-names')).closest('label')!;
        expect(row.className).not.toMatch(/cursor-not-allowed/);
    });

    it('tapping the words of a row says where it is done, at once, beside that row, in a polite live region', async () => {
        await renderPage();
        const user = userEvent.setup();

        await user.click(screen.getByText('Add them to the names list'));

        const note = screen.getByTestId('invite-adds-note');
        expect(note).toHaveTextContent(SENTENCE);
        expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
        // Beside the row that was tapped: inside its own block, after the row, in a live region that was on the page before.
        const block = screen.getByTestId('invite-adds-names').closest('[data-testid="invite-adds-row-names"]') as HTMLElement;
        expect(block).not.toBeNull();
        expect(block.contains(note)).toBe(true);
        const live = note.closest('[aria-live]');
        expect(live).toHaveAttribute('aria-live', 'polite');
        expect(block.querySelector('label')!.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The box is described by it, for a screen reader, and is still unticked.
        expect(screen.getByTestId('invite-adds-names')).toHaveAttribute('aria-describedby', note.id);
        expect(screen.getByTestId('invite-adds-names')).not.toBeChecked();
        expect(screen.queryByText(OLD_SENTENCE)).not.toBeInTheDocument();
    });

    it('tapping the box itself, on either row, says it too; the sentence is on the page once and follows the last tap', async () => {
        await renderPage();
        const user = userEvent.setup();

        await user.click(screen.getByTestId('invite-adds-voucher'));
        expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
        const voucherBlock = screen.getByTestId('invite-adds-row-voucher');
        expect(within(voucherBlock).getByText(SENTENCE)).toBeInTheDocument();

        await user.click(screen.getByTestId('invite-adds-names'));
        expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
        expect(within(screen.getByTestId('invite-adds-row-names')).getByText(SENTENCE)).toBeInTheDocument();
        expect(within(voucherBlock).queryByText(SENTENCE)).not.toBeInTheDocument();
        for (const id of ['invite-adds-names', 'invite-adds-voucher']) expect(screen.getByTestId(id)).not.toBeChecked();
    });

    it('a keyboard does it too: Tab reaches each row, Space or Enter says where it is done', async () => {
        await renderPage();
        const user = userEvent.setup();
        const names = screen.getByTestId('invite-adds-names');
        const voucher = screen.getByTestId('invite-adds-voucher');

        // Focusable: the walk with Tab stops on both rows (they are no longer out of the tab order).
        const stops = new Set<Element | null>();
        for (let i = 0; i < 60; i++) {
            await user.tab();
            stops.add(document.activeElement);
        }
        expect(stops.has(names)).toBe(true);
        expect(stops.has(voucher)).toBe(true);

        names.focus();
        expect(screen.queryByTestId('invite-adds-note')).not.toBeInTheDocument();
        await user.keyboard(' ');
        expect(screen.getByTestId('invite-adds-note')).toHaveTextContent(SENTENCE);
        expect(names).not.toBeChecked();

        voucher.focus();
        await user.keyboard('{Enter}');
        expect(within(screen.getByTestId('invite-adds-row-voucher')).getByText(SENTENCE)).toBeInTheDocument();
        expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
        expect(voucher).not.toBeChecked();
    });

    it('an admin sees them too, even one who is not a voucher (no presets)', async () => {
        vi.mocked(myNodeRoleOnce).mockResolvedValue('admin');
        vi.mocked(getMyVouching).mockResolvedValueOnce({
            voucher: false, presets: [25, 50, 75, 100], vouchMax: 100, budgetMax: 2000, vouchedBy: [],
        });
        await renderPage();

        expect(await screen.findByTestId('invite-adds-names')).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByTestId('invite-adds-voucher')).toHaveAttribute('aria-disabled', 'true');
        expect(screen.queryByTestId('invite-vouch')).not.toBeInTheDocument();
    });

    it.each([
        ['a member (the node says no role)', null],
        ['a moderator', 'moderator'],
        ['a signer whose role the node has not said yet', undefined],
    ])('%s sees nothing new', async (_who, role) => {
        vi.mocked(myNodeRoleOnce).mockResolvedValue(role as string | null | undefined);
        await renderPage();

        expect(screen.getByTestId('invite-vouch')).toBeInTheDocument();
        expect(screen.queryByTestId('invite-adds')).not.toBeInTheDocument();
        expect(screen.queryByText('Add them to the names list')).not.toBeInTheDocument();
        expect(screen.queryByText('Make them a voucher')).not.toBeInTheDocument();
        expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('an owner on a node that keeps no names list (the global profile) sees nothing new', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { invites: true, beans: true },
        } as never);
        await renderPage();

        expect(screen.queryByTestId('invite-adds')).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('an owner on a node that has not said what it is (its info never came) sees nothing new', async () => {
        vi.mocked(communityInfoOnce).mockRejectedValue(new Error('offline'));
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await waitFor(() => expect(myNodeRoleOnce).toHaveBeenCalled());
        await screen.findByTestId('invite-vouch');
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        expect(screen.queryByTestId('invite-adds')).not.toBeInTheDocument();
    });

    it('the preview (invites on the global node) never asks the role and shows no boxes', async () => {
        await renderPage({ preview: true });

        expect(myNodeRoleOnce).not.toHaveBeenCalled();
        expect(screen.queryByTestId('invite-adds')).not.toBeInTheDocument();
    });

    it('the vouch presets are as before, and the boxes sit under them and above the Generate button', async () => {
        await renderPage();

        const presets = screen.getByTestId('invite-vouch');
        const boxes = await screen.findByTestId('invite-adds');
        const generate = screen.getByRole('button', { name: /Generate/ });
        for (const id of ['none', '25', '50', '75', '100']) {
            expect(screen.getByTestId(`invite-vouch-${id}`)).not.toBeDisabled();
        }
        expect(presets.compareDocumentPosition(boxes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(boxes.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('the rows cannot be ticked, and an invite is made exactly as before (the picked vouch, nothing else)', async () => {
        await renderPage();

        const names = await screen.findByTestId('invite-adds-names');
        const voucher = screen.getByTestId('invite-adds-voucher');
        const user = userEvent.setup();
        await user.click(screen.getByText('Add them to the names list'));
        await user.click(screen.getByText('Make them a voucher'));
        await user.click(names);
        await user.click(voucher);
        expect(names).not.toBeChecked();
        expect(voucher).not.toBeChecked();

        fireEvent.click(screen.getByTestId('invite-vouch-50'));
        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(generateInvite).toHaveBeenCalledTimes(1));
        expect(generateInvite).toHaveBeenCalledWith(IDENTITY.publicKey, undefined, 50);
        // No extra argument: the web sends no names-list entry and no voucher level.
        expect(vi.mocked(generateInvite).mock.calls[0]).toHaveLength(3);
    });

    it('an invite with no vouch picked is made with the two arguments it always had', async () => {
        await renderPage();
        await screen.findByTestId('invite-adds');

        fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
        await waitFor(() => expect(generateInvite).toHaveBeenCalledTimes(1));
        expect(vi.mocked(generateInvite).mock.calls[0]).toEqual([IDENTITY.publicKey, undefined]);
    });

    describe('the app link beside the sentence', () => {
        it('on a computer: the sentence only, no link to the app', async () => {
            browserIs('computer');
            await renderPage();
            await userEvent.setup().click(screen.getByText('Make them a voucher'));

            expect(screen.getByTestId('invite-adds-note')).toHaveTextContent(SENTENCE);
            expect(screen.queryByTestId('invite-adds-open-app')).not.toBeInTheDocument();
            expect(screen.queryByTestId('invite-adds-get-app')).not.toBeInTheDocument();
            expect(screen.queryByText('Open in the BeanPool app')).not.toBeInTheDocument();
        });

        it('a browser that cannot say what it is gets the computer’s page', async () => {
            await renderPage(); // no matchMedia at all
            await userEvent.setup().click(screen.getByText('Make them a voucher'));

            expect(screen.getByTestId('invite-adds-note')).toBeInTheDocument();
            expect(screen.queryByTestId('invite-adds-open-app')).not.toBeInTheDocument();
        });

        it('on an Android phone: "Open in the BeanPool app", an intent that falls back to Google Play by itself', async () => {
            browserIs('phone', ANDROID);
            await renderPage();
            // Not before a tap: the link comes with the sentence.
            expect(screen.queryByTestId('invite-adds-open-app')).not.toBeInTheDocument();
            await userEvent.setup().click(screen.getByText('Add them to the names list'));

            const note = screen.getByTestId('invite-adds-note');
            const link = screen.getByTestId('invite-adds-open-app');
            expect(link).toHaveTextContent('Open in the BeanPool app');
            expect(link.getAttribute('href')).toBe(
                `intent://foreground#Intent;scheme=beanpool;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_URL)};end`,
            );
            // Beside the sentence, in the same live block.
            expect(note.closest('[aria-live]')!.contains(link)).toBe(true);
            // An intent has its own fallback, so no second "Get the app".
            expect(screen.queryByTestId('invite-adds-get-app')).not.toBeInTheDocument();
        });

        it('on an iPhone: "Open in the BeanPool app" by the scheme, and Get the app under it (a scheme link to no app opens nothing)', async () => {
            browserIs('phone', IPHONE);
            await renderPage();
            await userEvent.setup().click(screen.getByText('Make them a voucher'));

            expect(screen.getByTestId('invite-adds-open-app')).toHaveAttribute('href', 'beanpool://foreground');
            expect(screen.getByTestId('invite-adds-open-app')).toHaveTextContent('Open in the BeanPool app');
            const store = screen.getByTestId('invite-adds-get-app');
            expect(store).toHaveAttribute('href', APP_STORE_URL);
            expect(store).toHaveTextContent('Get the app');
        });

        it('a narrow window on a computer (not a phone browser) gets no link either', async () => {
            browserIs('computer', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15');
            await renderPage();
            await userEvent.setup().click(screen.getByText('Make them a voucher'));

            expect(screen.queryByTestId('invite-adds-open-app')).not.toBeInTheDocument();
        });

        it('the link is one the keyboard reaches, and following it changes nothing on the page', async () => {
            browserIs('phone', ANDROID);
            await renderPage();
            const user = userEvent.setup();
            await user.click(screen.getByText('Add them to the names list'));

            const link = screen.getByTestId('invite-adds-open-app');
            expect(link.tagName).toBe('A');
            expect(link).not.toHaveAttribute('tabindex', '-1');
            expect(screen.getByTestId('invite-adds-names')).not.toBeChecked();
        });
    });
});
