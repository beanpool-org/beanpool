/**
 * The QR picture Share sends with an invite (lib/invite-picture.ts): what it is made of, and what Share does with it.
 * jsdom has no canvas, so the drawing surface is a recorder; what a browser draws is looked at by eye (the PR).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    PICTURE_HEIGHT, PICTURE_WIDTH, QR_PX, composeInvitePicture, forgetInvitePictures, invitePictureFor, invitePictureSettled,
    rememberInvitePicture, saveInvitePicture, shareInvite, type PictureEnv,
} from './invite-picture';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const file = (name = 'beanpool-invite-INV-TEST1234.png') => new File([PNG], name, { type: 'image/png' });

/** A canvas that writes down what is drawn on it and hands back a PNG's bytes. */
function recorder(over: { context?: boolean; blob?: boolean } = {}) {
    const draws: Array<[string, ...unknown[]]> = [];
    const sizes: Array<[number, number]> = [];
    const ctx = {
        fillStyle: '' as unknown, font: '', textAlign: '' as CanvasTextAlign, textBaseline: '' as CanvasTextBaseline,
        fillRect: (...a: number[]) => { draws.push(['fillRect', ctx.fillStyle, ...a]); },
        drawImage: (_i: unknown, ...a: number[]) => { draws.push(['drawImage', ...a]); },
        fillText: (...a: unknown[]) => { draws.push(['fillText', ctx.fillStyle, ctx.font, ...a]); },
    };
    const env: PictureEnv = {
        loadImage: vi.fn(async () => ({}) as CanvasImageSource),
        canvas: (w, h) => {
            sizes.push([w, h]);
            return {
                getContext: () => (over.context === false ? null : (ctx as never)),
                toBlob: (done, type) => done(over.blob === false ? null : new Blob([PNG], { type })),
            };
        },
    };
    return { env, draws, sizes };
}

afterEach(() => { forgetInvitePictures(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('composeInvitePicture', () => {
    it('is a PNG file named for the code, at least 512 px, the QR on white with the code printed under it', async () => {
        const { env, draws, sizes } = recorder();
        const made = await composeInvitePicture('<svg/>', 'inv-test1234', env);

        expect(made).toBeInstanceOf(File);
        expect(made!.name).toBe('beanpool-invite-inv-test1234.png');
        expect(made!.type).toBe('image/png');
        expect(sizes).toEqual([[PICTURE_WIDTH, PICTURE_HEIGHT]]);
        expect(QR_PX).toBeGreaterThanOrEqual(512);
        expect(PICTURE_WIDTH).toBeGreaterThanOrEqual(512);

        // White first, then the QR inside it with room round it, then the code (capitals, as the card prints it) under the QR.
        const [ground, qr, code] = draws;
        expect(ground).toEqual(['fillRect', '#ffffff', 0, 0, PICTURE_WIDTH, PICTURE_HEIGHT]);
        expect(qr[0]).toBe('drawImage');
        const [x, y, w, h] = qr.slice(1) as number[];
        expect(x).toBeGreaterThan(0);
        expect(y).toBeGreaterThan(0);
        expect(w).toBe(QR_PX);
        expect(h).toBe(QR_PX);
        expect(x + w).toBeLessThan(PICTURE_WIDTH);
        expect(code[0]).toBe('fillText');
        expect(code[3]).toBe('INV-TEST1234');
        expect(code[5] as number).toBeGreaterThan(y + h);
        expect(code[5] as number).toBeLessThan(PICTURE_HEIGHT);
        expect(code[1]).toBe('#0f1a14');
    });

    it('cuts a long paper ticket after 16 characters, as the card does, and still names the file with a short name', async () => {
        const { env, draws } = recorder();
        const ticket = `BP-${'abcdefghij'.repeat(30)}`;
        const made = await composeInvitePicture('<svg/>', ticket, env);
        expect(made!.name.length).toBeLessThan(60);
        expect(draws.find((d) => d[0] === 'fillText')![3]).toBe(`${ticket.substring(0, 16)}...`);
    });

    it('is null, and does not throw, where the QR cannot be decoded, the canvas has no 2d drawing, or the PNG cannot be made', async () => {
        const broken = recorder();
        (broken.env.loadImage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no svg'));
        expect(await composeInvitePicture('<svg/>', 'INV-A', broken.env)).toBeNull();
        expect(await composeInvitePicture('<svg/>', 'INV-A', recorder({ context: false }).env)).toBeNull();
        expect(await composeInvitePicture('<svg/>', 'INV-A', recorder({ blob: false }).env)).toBeNull();
    });
});

describe('the pictures made so far', () => {
    it('are looked up by code; a failure is settled too, so it is not tried again', () => {
        expect(invitePictureFor('INV-A')).toBeNull();
        expect(invitePictureSettled('INV-A')).toBe(false);
        const f = file();
        rememberInvitePicture('INV-A', f);
        rememberInvitePicture('INV-B', null);
        expect(invitePictureFor('INV-A')).toBe(f);
        expect(invitePictureFor('INV-B')).toBeNull();
        expect(invitePictureSettled('INV-A')).toBe(true);
        expect(invitePictureSettled('INV-B')).toBe(true);
        expect(invitePictureSettled('INV-C')).toBe(false);
    });
});

describe('shareInvite', () => {
    const data = { title: 'Join me on BeanPool', text: 'Join my BeanPool community, Mullum:\nhttps://x/?invite=INV-TEST1234' };

    it('sends the picture and the message together where the browser can take a file', async () => {
        const f = file();
        const nav = { canShare: vi.fn(() => true), share: vi.fn(async () => {}) };
        expect(await shareInvite(nav, data, f)).toBe('shared');
        expect(nav.canShare).toHaveBeenCalledWith({ files: [f] });
        expect(nav.share).toHaveBeenCalledTimes(1);
        expect(nav.share).toHaveBeenCalledWith({ ...data, files: [f] });
    });

    it('starts the share before anything is awaited (Safari refuses one that waits first)', () => {
        const nav = { canShare: () => true, share: vi.fn(async () => {}) };
        void shareInvite(nav, data, file());
        expect(nav.share).toHaveBeenCalledTimes(1);
    });

    it('sends the message alone where the browser cannot take a file, or the picture is not ready', async () => {
        const noFiles = { canShare: vi.fn(() => false), share: vi.fn(async () => {}) };
        expect(await shareInvite(noFiles, data, file())).toBe('shared');
        expect(noFiles.share).toHaveBeenCalledWith(data);

        const noCanShare = { share: vi.fn(async () => {}) };
        expect(await shareInvite(noCanShare, data, file())).toBe('shared');
        expect(noCanShare.share).toHaveBeenCalledWith(data);

        const notReady = { canShare: vi.fn(() => true), share: vi.fn(async () => {}) };
        expect(await shareInvite(notReady, data, null)).toBe('shared');
        expect(notReady.canShare).not.toHaveBeenCalled();
        expect(notReady.share).toHaveBeenCalledWith(data);
    });

    it('is a copy for the page to answer where the browser has no share at all', async () => {
        expect(await shareInvite({}, data, file())).toBe('copy');
    });

    it('is cancelled, and tries nothing more, when the person closes the share', async () => {
        const abort = Object.assign(new Error('closed'), { name: 'AbortError' });
        const nav = { canShare: () => true, share: vi.fn(async () => { throw abort; }) };
        expect(await shareInvite(nav, data, file())).toBe('cancelled');
        expect(nav.share).toHaveBeenCalledTimes(1);
    });

    it('tries the message alone when the browser takes the share but not the picture', async () => {
        const f = file();
        const share = vi.fn(async (d: ShareData) => { if (d.files) throw Object.assign(new Error('files'), { name: 'NotAllowedError' }); });
        expect(await shareInvite({ canShare: () => true, share }, data, f)).toBe('shared');
        expect(share).toHaveBeenCalledTimes(2);
        expect(share).toHaveBeenLastCalledWith(data);
    });

    it('is a copy when the share is refused outright, never a share that failed without a word', async () => {
        const nav = { canShare: () => true, share: vi.fn(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); }) };
        expect(await shareInvite(nav, data, file())).toBe('copy');
        expect(await shareInvite({ share: nav.share }, data, null)).toBe('copy');
    });
});

describe('saveInvitePicture', () => {
    it('downloads the file under its own name, then lets the address go', () => {
        vi.useFakeTimers();
        const create = vi.fn(() => 'blob:picture');
        const revoke = vi.fn();
        const had = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
        URL.createObjectURL = create;
        URL.revokeObjectURL = revoke;
        let clicked: { download: string; href: string; inPage: boolean } | null = null;
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            clicked = { download: this.download, href: this.href, inPage: document.body.contains(this) };
        });
        try {
            const f = file();
            saveInvitePicture(f);
            expect(create).toHaveBeenCalledWith(f);
            expect(clicked).not.toBeNull();
            expect(clicked!.download).toBe('beanpool-invite-INV-TEST1234.png');
            expect(clicked!.href).toContain('blob:picture');
            expect(clicked!.inPage).toBe(true);
            expect(document.querySelector('a[download]')).toBeNull();
            expect(revoke).not.toHaveBeenCalled();
            vi.advanceTimersByTime(10_000);
            expect(revoke).toHaveBeenCalledWith('blob:picture');
        } finally {
            URL.createObjectURL = had.create;
            URL.revokeObjectURL = had.revoke;
            vi.useRealTimers();
        }
    });
});
