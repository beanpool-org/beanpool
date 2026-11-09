/**
 * Share on People → Invites sends the QR picture with the invite message (utils/invite-picture-share.ts). None of the phone's
 * modules load outside a phone, so each is a stand-in that records what it was given. What each phone's dialog really shows
 * is looked at on the emulator (the PR); the modules' limits are written in the file's header.
 */
import { describe, expect, it, vi } from 'vitest';
import { nameInvitePicture, shareInviteWithPicture, type InviteShareDeps, type PictureFiles } from '../invite-picture-share';

const MESSAGE = 'Join my BeanPool community, Mullum:\nhttps://mullum.example/?invite=INV-TEST1234';
const PICTURE = 'file:///cache/beanpool-invite-INV-TEST1234.png';

function deps(platform: 'ios' | 'android', over: { available?: boolean; clipboard?: () => Promise<void>; shareAsync?: () => Promise<void>; share?: () => Promise<void> } = {}) {
    const order: string[] = [];
    const d = {
        platform,
        Share: { share: vi.fn(async (_c: { message: string; url?: string }) => { order.push('Share'); if (over.share) await over.share(); }) },
        sharing: vi.fn(async () => ({
            isAvailableAsync: vi.fn(async () => over.available ?? true),
            shareAsync: vi.fn(async (_uri: string, _o?: unknown) => { order.push('shareAsync'); if (over.shareAsync) await over.shareAsync(); }),
        })),
        Clipboard: { setStringAsync: vi.fn(async (_s: string) => { order.push('clipboard'); if (over.clipboard) await over.clipboard(); }) },
        toast: vi.fn((_s: string) => { order.push('toast'); }),
    };
    return { d: d as InviteShareDeps & typeof d, order };
}

describe('on iOS', () => {
    it('hands the message and the picture to one share sheet: message, and url for the file', async () => {
        const { d } = deps('ios');
        expect(await shareInviteWithPicture(MESSAGE, PICTURE, d)).toBe('picture');
        expect(d.Share.share).toHaveBeenCalledTimes(1);
        expect(d.Share.share).toHaveBeenCalledWith({ message: MESSAGE, url: PICTURE });
        expect(d.sharing).not.toHaveBeenCalled();
        expect(d.Clipboard.setStringAsync).not.toHaveBeenCalled();
        expect(d.toast).not.toHaveBeenCalled();
    });

    it('shares the message alone when the picture could not be made', async () => {
        const { d } = deps('ios');
        expect(await shareInviteWithPicture(MESSAGE, null, d)).toBe('text');
        expect(d.Share.share).toHaveBeenCalledWith({ message: MESSAGE });
    });

    it('falls back to the message alone when the sheet will not take the picture', async () => {
        let first = true;
        const { d } = deps('ios', { share: async () => { if (first) { first = false; throw new Error('bad file'); } } });
        expect(await shareInviteWithPicture(MESSAGE, PICTURE, d)).toBe('text');
        expect(d.Share.share).toHaveBeenCalledTimes(2);
        expect(d.Share.share).toHaveBeenLastCalledWith({ message: MESSAGE });
    });
});

describe('on Android', () => {
    it('shares the picture, with the message on the clipboard and a note saying so, put there before the dialog opens', async () => {
        const { d, order } = deps('android');
        expect(await shareInviteWithPicture(MESSAGE, PICTURE, d)).toBe('picture');

        const sharing = await d.sharing.mock.results[0].value;
        expect(sharing.shareAsync).toHaveBeenCalledWith(PICTURE, { mimeType: 'image/png', dialogTitle: 'Join me on BeanPool' });
        expect(d.Clipboard.setStringAsync).toHaveBeenCalledWith(MESSAGE);
        expect(d.toast).toHaveBeenCalledWith('Invite message copied. Paste it with the picture.');
        expect(order).toEqual(['clipboard', 'toast', 'shareAsync']);
        expect(d.Share.share).not.toHaveBeenCalled();
    });

    it('shares the message alone when the picture could not be made, and copies nothing', async () => {
        const { d } = deps('android');
        expect(await shareInviteWithPicture(MESSAGE, null, d)).toBe('text');
        expect(d.Share.share).toHaveBeenCalledWith({ message: MESSAGE });
        expect(d.Clipboard.setStringAsync).not.toHaveBeenCalled();
        expect(d.toast).not.toHaveBeenCalled();
    });

    it('shares the message alone when this phone cannot share a file', async () => {
        const { d } = deps('android', { available: false });
        expect(await shareInviteWithPicture(MESSAGE, PICTURE, d)).toBe('text');
        expect(d.Share.share).toHaveBeenCalledWith({ message: MESSAGE });
        expect(d.toast).not.toHaveBeenCalled();
    });

    it('never says it copied what it could not: a clipboard that fails sends the message alone, with no note', async () => {
        const { d, order } = deps('android', { clipboard: async () => { throw new Error('denied'); } });
        expect(await shareInviteWithPicture(MESSAGE, PICTURE, d)).toBe('text');
        expect(d.toast).not.toHaveBeenCalled();
        expect(order).toEqual(['clipboard', 'Share']);
        expect(d.Share.share).toHaveBeenCalledWith({ message: MESSAGE });
    });

    it('falls back to the message alone when the dialog will not take the picture, or expo-sharing is missing', async () => {
        const refused = deps('android', { shareAsync: async () => { throw new Error('no app'); } });
        expect(await shareInviteWithPicture(MESSAGE, PICTURE, refused.d)).toBe('text');
        expect(refused.d.Share.share).toHaveBeenCalledWith({ message: MESSAGE });

        const missing = deps('android');
        missing.d.sharing.mockRejectedValueOnce(new Error('module not found'));
        expect(await shareInviteWithPicture(MESSAGE, PICTURE, missing.d)).toBe('text');
        expect(missing.d.Share.share).toHaveBeenCalledWith({ message: MESSAGE });
        expect(missing.d.toast).not.toHaveBeenCalled();
    });
});

describe('nameInvitePicture', () => {
    const files = (over: Partial<PictureFiles> = {}) => {
        const calls: string[] = [];
        const f: PictureFiles = {
            cacheDirectory: 'file:///cache/',
            deleteAsync: vi.fn(async (uri: string) => { calls.push(`delete ${uri}`); }),
            moveAsync: vi.fn(async (o: { from: string; to: string }) => { calls.push(`move ${o.from} -> ${o.to}`); }),
            ...over,
        };
        return { f, calls };
    };

    it('moves the capture to beanpool-invite-<CODE>.png in the cache, clearing an older one first', async () => {
        const { f, calls } = files();
        expect(await nameInvitePicture('file:///tmp/ReactNative/abc123.png', 'INV-TEST1234', async () => f)).toBe(PICTURE);
        expect(calls).toEqual([`delete ${PICTURE}`, `move file:///tmp/ReactNative/abc123.png -> ${PICTURE}`]);
    });

    it('adds the slash a cache folder lacks', async () => {
        const { f } = files({ cacheDirectory: 'file:///cache' });
        expect(await nameInvitePicture('file:///tmp/x.png', 'INV-TEST1234', async () => f)).toBe(PICTURE);
    });

    it('shares the capture as it is where it cannot be renamed', async () => {
        const capture = 'file:///tmp/x.png';
        expect(await nameInvitePicture(capture, 'INV-A', async () => files({ cacheDirectory: null }).f)).toBe(capture);
        expect(await nameInvitePicture(capture, 'INV-A', async () => files({ moveAsync: async () => { throw new Error('no'); } }).f)).toBe(capture);
        expect(await nameInvitePicture(capture, 'INV-A', async () => { throw new Error('module not found'); })).toBe(capture);
    });
});
