import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Share on People → Invites sends the QR picture with the invite message (Damo, 9 Nov: "it should share this picture but it
 * just copies the text"). The picture is made when the code appears, so the tap only has to share; where the browser can take
 * a file the picture and the message go together, where it cannot the message goes alone, and where there is no share at all
 * the message is copied, said so, and the picture offered to save. jsdom has no canvas, so the drawing is stood in for with a
 * PNG file named as the real one is (lib/invite-picture.test.ts holds what the drawing does).
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const picture = vi.hoisted(() => ({
    compose: vi.fn(),
    save: vi.fn(),
}));

vi.mock('../lib/invite-picture', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/invite-picture')>();
    return { ...actual, composeInvitePicture: picture.compose, saveInvitePicture: picture.save };
});

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async () => ({
            success: true,
            invite: { code: 'INV-TEST1234', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null },
        })),
        getMyInvites: vi.fn(async () => ({
            invites: [{ code: 'INV-ROWONE99', createdBy: 'me', createdAt: '2026-11-01T00:00:00.000Z', usedBy: null, usedAt: null }],
        })),
        getInviteTree: vi.fn(async () => []),
        getMyVouching: vi.fn(async () => ({ voucher: false, presets: [25, 50, 75, 100], vouchMax: 100, budgetMax: 2000, vouchedBy: [] })),
        getVouchersBlock: vi.fn(async () => null),
        getCommunityCard: vi.fn(async () => null),
    };
});

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { invites: true, beans: true },
    })),
}));

// The QR's markup is what the picture is made from; its drawing is not under test.
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} /> }));

import { InvitePage } from './InvitePage';
import { forgetInvitePictures, invitePictureFor } from '../lib/invite-picture';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };

const pngFor = (code: string) => new File([PNG], `beanpool-invite-${code}.png`, { type: 'image/png' });

function setNavigator(over: { share?: unknown; canShare?: unknown; writeText?: unknown }) {
    for (const [key, value] of Object.entries({ share: over.share, canShare: over.canShare, clipboard: over.writeText ? { writeText: over.writeText } : undefined })) {
        Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
    }
}

/** Generate an invite and wait for its picture; the QR card's Share is the first Share button on the page. */
async function newInviteWithPicture() {
    render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
    await screen.findByText('INV-TEST1234', { selector: 'p' });
    await waitFor(() => expect(invitePictureFor('INV-TEST1234')).not.toBeNull());
    return screen.getAllByRole('button', { name: 'Share invite link' })[0];
}

beforeEach(() => {
    localStorage.clear();
    forgetInvitePictures();
    picture.compose.mockReset();
    picture.compose.mockImplementation(async (_svg: string, code: string) => pngFor(code));
    picture.save.mockReset();
});
afterEach(() => {
    cleanup();
    for (const key of ['share', 'canShare', 'clipboard']) delete (navigator as unknown as Record<string, unknown>)[key];
});

describe('Share on a new invite', () => {
    it('sends the QR picture and the message together, from inside the tap', async () => {
        const share = vi.fn(async (_data: ShareData) => {});
        const canShare = vi.fn(() => true);
        setNavigator({ share, canShare });
        const button = await newInviteWithPicture();

        fireEvent.click(button);
        // Not after an await: Safari refuses a share that waited first.
        expect(share).toHaveBeenCalledTimes(1);

        const data = share.mock.calls[0][0] as ShareData;
        expect(data.title).toBe('Join me on BeanPool');
        expect(data.text).toContain(`${window.location.origin}/?invite=INV-TEST1234`);
        expect(data.text).toContain('INV-TEST1234');
        expect(data.files).toHaveLength(1);
        expect(data.files![0].name).toBe('beanpool-invite-INV-TEST1234.png');
        expect(data.files![0].type).toBe('image/png');
        expect(canShare).toHaveBeenCalledWith({ files: data.files });
        expect(screen.queryByTestId('invite-copied-note')).toBeNull();
    });

    it('draws the picture from the same QR the card shows', async () => {
        setNavigator({ share: vi.fn(async () => {}), canShare: () => true });
        await newInviteWithPicture();
        expect(picture.compose).toHaveBeenCalledWith(expect.stringContaining('<svg'), 'INV-TEST1234');
        const values = screen.queryAllByTestId('qr').map((el) => el.getAttribute('data-value'));
        expect(values).toContain(`${window.location.origin}/?invite=INV-TEST1234`);
    });

    it('sends the message alone where the browser cannot take a file', async () => {
        const share = vi.fn(async (_data: ShareData) => {});
        setNavigator({ share, canShare: () => false });
        fireEvent.click(await newInviteWithPicture());

        expect(share).toHaveBeenCalledTimes(1);
        const data = share.mock.calls[0][0] as ShareData;
        expect(data.files).toBeUndefined();
        expect(data.text).toContain('INV-TEST1234');
        expect(screen.queryByTestId('invite-copied-note')).toBeNull();
    });

    it('sends the message alone, and does not wait, when the picture could not be made', async () => {
        picture.compose.mockResolvedValue(null);
        const share = vi.fn(async (_data: ShareData) => {});
        setNavigator({ share, canShare: () => true });
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
        await screen.findByText('INV-TEST1234', { selector: 'p' });
        await waitFor(() => expect(picture.compose).toHaveBeenCalled());

        fireEvent.click(screen.getAllByRole('button', { name: 'Share invite link' })[0]);
        expect(share).toHaveBeenCalledTimes(1);
        expect((share.mock.calls[0][0] as ShareData).files).toBeUndefined();
    });

    it('copies the message, says so, and offers the picture to save, where the browser has no share', async () => {
        const writeText = vi.fn(async (_text: string) => {});
        setNavigator({ writeText });
        fireEvent.click(await newInviteWithPicture());

        const note = await screen.findByTestId('invite-copied-note');
        expect(within(note).getByText('Invite message copied')).toBeTruthy();
        expect(writeText).toHaveBeenCalledTimes(1);
        const copied = writeText.mock.calls[0][0] as string;
        expect(copied).toContain(`${window.location.origin}/?invite=INV-TEST1234`);
        expect(copied).toContain('Community address:');

        fireEvent.click(within(note).getByRole('button', { name: 'Save QR picture' }));
        expect(picture.save).toHaveBeenCalledTimes(1);
        expect((picture.save.mock.calls[0][0] as File).name).toBe('beanpool-invite-INV-TEST1234.png');
    });

    it('copies the message and says so when the browser refuses the share', async () => {
        const writeText = vi.fn(async (_text: string) => {});
        const share = vi.fn(async (_data: ShareData) => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); });
        setNavigator({ share, canShare: () => true, writeText });
        fireEvent.click(await newInviteWithPicture());

        expect(await screen.findByText('Invite message copied')).toBeTruthy();
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'Save QR picture' })).toBeTruthy();
    });

    it('does nothing more when the person closes the share', async () => {
        const writeText = vi.fn(async (_text: string) => {});
        const share = vi.fn(async (_data: ShareData) => { throw Object.assign(new Error('closed'), { name: 'AbortError' }); });
        setNavigator({ share, canShare: () => true, writeText });
        fireEvent.click(await newInviteWithPicture());

        await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        expect(writeText).not.toHaveBeenCalled();
        expect(screen.queryByTestId('invite-copied-note')).toBeNull();
    });

    it('says plainly when it could not copy either, and still offers the picture', async () => {
        // No share, no clipboard, and no way to copy by hand: nothing is claimed.
        setNavigator({});
        fireEvent.click(await newInviteWithPicture());

        const note = await screen.findByTestId('invite-copied-note');
        expect(within(note).getByText('Could not copy the invite message')).toBeTruthy();
        expect(within(note).queryByText('Invite message copied')).toBeNull();
        expect(within(note).getByRole('button', { name: 'Save QR picture' })).toBeTruthy();
    });
});

describe('Share on an invite already made', () => {
    it('sends that invite\'s own picture with its own message', async () => {
        const share = vi.fn(async (_data: ShareData) => {});
        setNavigator({ share, canShare: () => true });
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await screen.findByText('INV-ROWONE99');
        await waitFor(() => expect(invitePictureFor('INV-ROWONE99')).not.toBeNull());

        fireEvent.click(screen.getByRole('button', { name: 'Share invite link' }));
        expect(share).toHaveBeenCalledTimes(1);
        const data = share.mock.calls[0][0] as ShareData;
        expect(data.files![0].name).toBe('beanpool-invite-INV-ROWONE99.png');
        expect(data.text).toContain('?invite=INV-ROWONE99');
    });

    it('puts the copied note under that invite where the browser has no share', async () => {
        setNavigator({ writeText: vi.fn(async () => {}) });
        render(<InvitePage identity={IDENTITY} onNavigate={() => {}} />);
        await screen.findByText('INV-ROWONE99');
        await waitFor(() => expect(invitePictureFor('INV-ROWONE99')).not.toBeNull());

        fireEvent.click(screen.getByRole('button', { name: 'Share invite link' }));
        const note = await screen.findByTestId('invite-copied-note');
        expect(note.closest('div.rounded-xl')?.textContent).toContain('INV-ROWONE99');
    });
});
