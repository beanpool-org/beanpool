/**
 * Choosing the part of a picture that shows, on the web (Marty, 25 Oct 2026, of the web banner: "dont get to choose the
 * strip of banner from the image like I do in the phone avatar selector … this should be the case for all image selection
 * where size restrictions apply on both phone and pwa"). What the member crops is exactly what is shown:
 *
 * - Every picture drawn in a fixed shape opens one crop dialog (components/PictureCropDialog.tsx) before it is kept: a
 *   member's avatar (Profile, the setup wizard, sign-up) and an enterprise's logo (Manage, Propose) a square in a circle,
 *   512 px; a shop's banner (Manage) 3:1, 800 × 267. Never the old silent middle square at 128 px.
 * - A known move and zoom from the keys give the rectangle drawn on the canvas, to the pixel; Cancel keeps nothing.
 * - The banner is drawn 3:1 on its page and in Manage's preview, so the part chosen is the part seen.
 *
 * jsdom decodes no pictures and draws on no canvas: a stand-in for both records what was asked of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { EnterpriseFace } from './EnterpriseManage';
import { ProfileSetup } from './ProfileSetup';
import { ShopfrontHeader } from './Shopfront';
import { ProfilePage } from '../pages/ProfilePage';
import { ProjectsPage } from '../pages/ProjectsPage';
import * as api from '../lib/api';

const CROPPED = 'data:image/jpeg;base64,Q1JPUA==';
const NATURAL = { width: 1600, height: 1200 };

let restore: Array<() => void> = [];
/** Every canvas draw: the canvas's size when drawn, and drawImage's arguments. */
let drawn: Array<{ width: number; height: number; args: unknown[] }> = [];
let encoded: Array<{ type: unknown; quality: unknown }> = [];

function stubPictures() {
    const originalImage = window.Image;
    class FakeImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        width = NATURAL.width;
        height = NATURAL.height;
        naturalWidth = NATURAL.width;
        naturalHeight = NATURAL.height;
        private value = '';
        get src() { return this.value; }
        set src(v: string) { this.value = v; setTimeout(() => this.onload?.(), 0); }
    }
    (window as any).Image = FakeImage;
    const originalGetContext = window.HTMLCanvasElement.prototype.getContext;
    const originalToDataUrl = window.HTMLCanvasElement.prototype.toDataURL;
    (window.HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement) {
        return { drawImage: (...args: unknown[]) => drawn.push({ width: this.width, height: this.height, args }) };
    };
    (window.HTMLCanvasElement.prototype as any).toDataURL = (type: unknown, quality: unknown) => {
        encoded.push({ type, quality });
        return CROPPED;
    };
    restore.push(() => {
        (window as any).Image = originalImage;
        (window.HTMLCanvasElement.prototype as any).getContext = originalGetContext;
        (window.HTMLCanvasElement.prototype as any).toDataURL = originalToDataUrl;
    });
}

const identity = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' } as any;
const ENTERPRISE = {
    publicKey: 't'.repeat(64), name: 'Tool Library', purpose: 'Share communal tools', about: 'Weekly lending', avatar: null,
    lifecycle: 'ongoing', status: 'active', isLeadOrSoleKeeperOrAdmin: true,
    keepers: [{ publicKey: identity.publicKey, callsign: 'Alice', role: 'lead' }],
    shop: { id: 'shop-1', category: 'tools', howToDeal: 'Pick up on weekends' },
} as any;

beforeEach(() => {
    drawn = [];
    encoded = [];
    stubPictures();
    vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
    vi.spyOn(api, 'getGroups').mockResolvedValue([]);
    vi.spyOn(api, 'getDecisions').mockResolvedValue({ decisions: [], myPoolVoting: null });
    vi.spyOn(api, 'createEnterprise').mockResolvedValue({ success: true, project: { id: 'p1' } } as any);
    vi.spyOn(api, 'changeEnterpriseFace').mockResolvedValue({ success: true } as any);
    vi.spyOn(api, 'changeEnterpriseShop').mockResolvedValue({ success: true } as any);
    vi.spyOn(api, 'getMemberProfile').mockResolvedValue({
        publicKey: identity.publicKey, callsign: 'Alice', avatar: null, bio: 'Gardener', contact: null, role: 'member', joinedAt: '2026-01-01T00:00:00.000Z',
    } as any);
    vi.spyOn(api, 'updateMemberProfile').mockResolvedValue({ success: true, profile: {} as any });
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 10, floor: -50, earnedCredit: 50, canVouch: true, tier: { name: 'Green Bean', emoji: '🌱' }, trustStats: { tradeCount: 1 } } as any);
    vi.spyOn(api, 'getMemberPreferences').mockResolvedValue({} as any);
});
afterEach(() => {
    cleanup();
    restore.forEach((r) => r());
    restore = [];
    vi.restoreAllMocks();
});

const photo = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'IMG_0001.jpg', { type: 'image/jpeg' });

/** The crop dialog, once the picked file is read. */
async function cropDialog() {
    return screen.findByRole('dialog', { name: 'Choose the part that shows' });
}

/** The frame drawn over the picture: its shape on screen. */
function frameOf(dialog: HTMLElement) {
    const frame = within(dialog).getByTestId('picture-crop-frame');
    return { ratio: parseFloat(frame.style.width) / parseFloat(frame.style.height), radius: frame.style.borderRadius };
}

/** The last picture drawn: drawImage's source rectangle and the canvas it went on. */
function lastDraw() {
    const d = drawn.at(-1)!;
    return { from: d.args.slice(1, 5), to: d.args.slice(5), canvas: { width: d.width, height: d.height } };
}

/** Zoom in once and move the picture left twice: the keys' steps, a quarter in and a tenth of the frame each. */
function zoomInAndMoveLeft(dialog: HTMLElement) {
    fireEvent.keyDown(dialog, { key: '+' });
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
}

describe("an enterprise's logo and banner (Manage)", () => {
    const renderFace = () => render(<EnterpriseFace treasury="t-key" detail={ENTERPRISE} shopEditable onSaved={vi.fn()} />);

    it('a logo photo opens the crop dialog, a square in a circle; the part chosen is drawn at 512 px and sent', async () => {
        renderFace();
        fireEvent.change(screen.getByTestId('manage-face-logo-input'), { target: { files: [photo()] } });
        const dialog = await cropDialog();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('data-aspect', '1');
        expect(dialog).toHaveAttribute('data-round', 'true');
        expect(frameOf(dialog).ratio).toBeCloseTo(1, 5);
        expect(frameOf(dialog).radius).toBe('50%');
        zoomInAndMoveLeft(dialog);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(lastDraw()).toEqual({ from: [512, 120, 960, 960], to: [0, 0, 512, 512], canvas: { width: 512, height: 512 } });
        expect(encoded.at(-1)).toEqual({ type: 'image/jpeg', quality: 0.7 });
        expect(screen.getByTestId('manage-face-logo-image')).toHaveAttribute('src', CROPPED);
        fireEvent.click(screen.getByTestId('manage-face-save'));
        await waitFor(() => expect(api.changeEnterpriseFace).toHaveBeenCalledWith('t-key', { avatar: CROPPED }));
    });

    it('a banner photo opens the crop dialog at 3:1, not round; the strip chosen is drawn at 800 × 267 and sent', async () => {
        renderFace();
        fireEvent.change(screen.getByTestId('manage-face-banner-input'), { target: { files: [photo()] } });
        const dialog = await cropDialog();
        expect(dialog).toHaveAttribute('data-aspect', '3');
        expect(dialog).toHaveAttribute('data-round', 'false');
        expect(frameOf(dialog).ratio).toBeCloseTo(3, 5);
        expect(frameOf(dialog).radius).not.toBe('50%');
        fireEvent.keyDown(dialog, { key: 'ArrowUp' });
        fireEvent.keyDown(dialog, { key: 'ArrowUp' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(lastDraw()).toEqual({ from: [0, 440, 1600, 533], to: [0, 0, 800, 267], canvas: { width: 800, height: 267 } });
        expect(screen.getByTestId('manage-face-banner-image')).toHaveAttribute('src', CROPPED);
        fireEvent.click(screen.getByTestId('manage-face-save'));
        await waitFor(() => expect(api.changeEnterpriseShop).toHaveBeenCalledWith('t-key', { photo: CROPPED }));
    });

    it('the zoom buttons and slider are labelled and do what the keys do; Escape is Cancel', async () => {
        renderFace();
        fireEvent.change(screen.getByTestId('manage-face-logo-input'), { target: { files: [photo()] } });
        let dialog = await cropDialog();
        const slider = within(dialog).getByRole('slider', { name: 'Zoom' });
        expect(slider).toHaveValue('1');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
        expect(Number((slider as HTMLInputElement).value)).toBeCloseTo(1.25, 5);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom out' }));
        expect(Number((slider as HTMLInputElement).value)).toBeCloseTo(1, 5);
        expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(drawn).toEqual([]);
        // And a move by dragging, with a mouse or a finger: the picture follows the pointer.
        fireEvent.change(screen.getByTestId('manage-face-logo-input'), { target: { files: [photo()] } });
        dialog = await cropDialog();
        const frameWidth = parseFloat(within(dialog).getByTestId('picture-crop-frame').style.width);
        const stage = within(dialog).getByTestId('picture-crop-stage');
        fireEvent.keyDown(dialog, { key: '+' });
        fireEvent.pointerDown(stage, { pointerId: 1, clientX: 200, clientY: 200 });
        fireEvent.pointerMove(stage, { pointerId: 1, clientX: 200 - frameWidth * 0.2, clientY: 200 });
        fireEvent.pointerUp(stage, { pointerId: 1, clientX: 200 - frameWidth * 0.2, clientY: 200 });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(lastDraw().from).toEqual([512, 120, 960, 960]);
    });

    it('Escape and Tab reach the dialog wherever focus is, and a page\'s own Escape never sees them (deciding review 1)', async () => {
        // TreasuryDetailPage leaves Manage on a window Escape; a click on the heading (or Safari after a button) leaves focus on <body>.
        const pageEscape = vi.fn();
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') pageEscape(); };
        window.addEventListener('keydown', onKey);
        restore.push(() => window.removeEventListener('keydown', onKey));
        renderFace();
        fireEvent.change(screen.getByTestId('manage-face-logo-input'), { target: { files: [photo()] } });
        const dialog = await cropDialog();
        (document.activeElement as HTMLElement | null)?.blur();
        expect(document.activeElement).toBe(document.body);
        fireEvent.keyDown(document.body, { key: 'Tab' });
        expect(dialog.contains(document.activeElement)).toBe(true);
        (document.activeElement as HTMLElement).blur();
        fireEvent.keyDown(document.body, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(pageEscape).not.toHaveBeenCalled();
        expect(drawn).toEqual([]);
    });

    it('a ready-made logo leaves a banner photo still being read alone, and a banner photo leaves a logo photo alone (deciding review 2)', async () => {
        renderFace();
        fireEvent.change(screen.getByTestId('manage-face-banner-input'), { target: { files: [photo()] } });
        fireEvent.click(screen.getByRole('button', { name: 'Select Leaf avatar' }));
        const dialog = await cropDialog();
        expect(dialog).toHaveAttribute('data-aspect', '3');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        // Both photos chosen at once: each gets its own crop, one after the other.
        fireEvent.change(screen.getByTestId('manage-face-logo-input'), { target: { files: [photo()] } });
        fireEvent.change(screen.getByTestId('manage-face-banner-input'), { target: { files: [photo()] } });
        await waitFor(() => expect(screen.getAllByRole('dialog', { name: 'Choose the part that shows' }).length).toBeGreaterThanOrEqual(1));
        const aspects = () => screen.queryAllByRole('dialog', { name: 'Choose the part that shows' }).map((d) => d.getAttribute('data-aspect'));
        await waitFor(() => expect(aspects().sort()).toEqual(['1', '3']));
    });

    it('is a labelled modal dialog axe finds nothing wrong with; focus starts on the picture, stays in, and goes back on close', async () => {
        renderFace();
        const input = screen.getByTestId('manage-face-banner-input');
        input.focus();
        fireEvent.change(input, { target: { files: [photo()] } });
        const dialog = await cropDialog();
        expect(dialog).toHaveAccessibleDescription(/arrow keys move it/);
        const stage = within(dialog).getByTestId('picture-crop-stage');
        expect(stage).toHaveAccessibleName('The part of the picture that shows');
        expect(document.activeElement).toBe(stage);
        const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
        expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
        // Tab from the last control comes round to the first; Shift+Tab from the first to the last.
        const done = within(dialog).getByRole('button', { name: 'Done' });
        done.focus();
        fireEvent.keyDown(done, { key: 'Tab' });
        expect(document.activeElement).toBe(stage);
        fireEvent.keyDown(stage, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(done);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.activeElement).toBe(input);
    });

    it('Cancel keeps nothing: no picture drawn, nothing to save', async () => {
        renderFace();
        fireEvent.change(screen.getByTestId('manage-face-banner-input'), { target: { files: [photo()] } });
        const dialog = await cropDialog();
        fireEvent.keyDown(dialog, { key: '+' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(drawn).toEqual([]);
        expect(screen.queryByTestId('manage-face-banner-image')).toBeNull();
        expect(screen.getByTestId('manage-face-save')).toBeDisabled();
    });

    it("Manage's banner preview is drawn 3:1, as the page draws it", async () => {
        renderFace();
        fireEvent.change(screen.getByTestId('manage-face-banner-input'), { target: { files: [photo()] } });
        fireEvent.click(within(await cropDialog()).getByRole('button', { name: 'Done' }));
        const preview = await screen.findByTestId('manage-face-banner-image');
        expect(preview.className).toContain('aspect-[3/1]');
        expect(preview.className).not.toMatch(/\bh-24\b/);
    });
});

describe('the shopfront draws its banner 3:1', () => {
    it('full width of its column, height a third of it, never a fixed height', () => {
        render(<ShopfrontHeader name="Tool Library" logoUrl={null} bannerUrl={CROPPED} category={null} fallbackEmoji="🏛️" lines={[]} />);
        const banner = screen.getByTestId('shopfront-banner');
        expect(banner.className).toContain('aspect-[3/1]');
        expect(banner.className).toContain('w-full');
        expect(banner.className).not.toMatch(/\bh-32\b/);
        // Never taller than ~240 px: its width stops at 720.
        expect(banner.className).toContain('max-w-[720px]');
    });
});

describe("a member's own avatar: a square in a circle, 512 px (the web's old 128 px middle square is gone)", () => {
    it('Profile: the gallery and the camera both open the crop dialog; the part chosen is saved', async () => {
        render(<ProfilePage identity={identity} onBack={vi.fn()} />);
        await screen.findByText('Your Profile');
        const inputs = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
        expect(inputs).toHaveLength(2);
        for (const input of inputs) {
            fireEvent.change(input, { target: { files: [photo()] } });
            const dialog = await cropDialog();
            expect(dialog).toHaveAttribute('data-aspect', '1');
            expect(dialog).toHaveAttribute('data-round', 'true');
            zoomInAndMoveLeft(dialog);
            fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(lastDraw()).toEqual({ from: [512, 120, 960, 960], to: [0, 0, 512, 512], canvas: { width: 512, height: 512 } });
        }
        fireEvent.click(screen.getByRole('button', { name: /Save Profile/i }));
        await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledWith(identity.publicKey, expect.objectContaining({ avatar: CROPPED })));
    });

    it('Profile: Cancel keeps the avatar it had', async () => {
        render(<ProfilePage identity={identity} onBack={vi.fn()} />);
        await screen.findByText('Your Profile');
        fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [photo()] } });
        fireEvent.click(within(await cropDialog()).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(drawn).toEqual([]);
    });

    it('the setup wizard: the photo goes through the crop dialog and is saved at 512 px', async () => {
        render(<ProfileSetup identity={identity} onDone={vi.fn()} />);
        await screen.findByText(/Choose your look/i);
        fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [photo()] } });
        const dialog = await cropDialog();
        expect(dialog).toHaveAttribute('data-round', 'true');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(lastDraw()).toEqual({ from: [200, 0, 1200, 1200], to: [0, 0, 512, 512], canvas: { width: 512, height: 512 } });
        fireEvent.click(screen.getByRole('button', { name: /Next/i }));
        fireEvent.click(screen.getByRole('button', { name: /Done/i }));
        await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledWith(identity.publicKey, expect.objectContaining({ avatar: CROPPED })));
    });
});

describe("Propose an enterprise: its logo", () => {
    it('a logo photo opens the crop dialog, a square in a circle; the part chosen is the one sent', async () => {
        render(<ProjectsPage identity={identity} />);
        // Commons S2: ＋ Start something → Enterprise opens the start form on the enterprise kind.
        fireEvent.click(await screen.findByRole('button', { name: /Start something/i }));
        fireEvent.click(within(screen.getByRole('dialog', { name: /Start something/i })).getByRole('button', { name: /^Enterprise/i }));
        const form = screen.getByRole('dialog', { name: /Start an enterprise/i });
        fireEvent.click(within(form).getByRole('button', { name: /^🏛️ Enterprise/ }));
        fireEvent.change(within(form).getByPlaceholderText(/Community Tool Shed/i), { target: { value: 'Tool Shed' } });
        fireEvent.change(within(form).getByPlaceholderText(/State clearly what this enterprise exists to do/i), { target: { value: 'Tool sharing' } });
        fireEvent.change(form.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [photo()] } });
        const dialog = await cropDialog();
        expect(dialog).toHaveAttribute('data-aspect', '1');
        expect(dialog).toHaveAttribute('data-round', 'true');
        // While the part is being chosen, the form waits for it.
        expect(within(form).getByRole('button', { name: /Preparing photo/i })).toBeDisabled();
        zoomInAndMoveLeft(dialog);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
        await within(form).findByAltText('Preview');
        expect(lastDraw()).toEqual({ from: [512, 120, 960, 960], to: [0, 0, 512, 512], canvas: { width: 512, height: 512 } });
        fireEvent.click(within(form).getByRole('button', { name: /Start the enterprise/i }));
        await waitFor(() => expect(api.createEnterprise).toHaveBeenCalledTimes(1));
        expect(vi.mocked(api.createEnterprise).mock.calls[0][0].avatar).toBe(CROPPED);
    });

    it('a crop cancelled leaves the form as it was, and it can be sent without a logo', async () => {
        render(<ProjectsPage identity={identity} />);
        // Commons S2: ＋ Start something → Enterprise opens the start form on the enterprise kind.
        fireEvent.click(await screen.findByRole('button', { name: /Start something/i }));
        fireEvent.click(within(screen.getByRole('dialog', { name: /Start something/i })).getByRole('button', { name: /^Enterprise/i }));
        const form = screen.getByRole('dialog', { name: /Start an enterprise/i });
        fireEvent.change(form.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [photo()] } });
        fireEvent.click(within(await cropDialog()).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose the part that shows' })).toBeNull());
        expect(within(form).queryByAltText('Preview')).toBeNull();
        expect(within(form).getByRole('button', { name: /Start the enterprise/i })).toBeEnabled();
        await act(async () => {});
    });
});
