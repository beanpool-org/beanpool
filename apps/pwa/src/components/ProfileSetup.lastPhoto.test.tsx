/**
 * Joining offers the last photo, and never applies it (Profile S3, scratch/fable-design/DESIGN-per-community-profile-fable.md §4),
 * on the web: the Re-run Setup wizard (components/ProfileSetup.tsx), on a community that holds no photo for the member while this
 * browser keeps a photo they used in ANOTHER community (lib/last-photo.ts). The tickbox starts off; with it off nothing of that
 * photo is shown or sent; ticked, it is the member's pick and goes like any pick. The phone does the same (profile-setup.tsx).
 *
 * The stored identity is real (an in-memory IndexedDB); the node's routes are mocked at lib/api.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import resolveConfig from 'tailwindcss/resolveConfig';
import { ProfileSetup } from './ProfileSetup';
import * as api from '../lib/api';
import { generateIdentity, importIdentity, type BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resolveAvatarUrl } from '../lib/avatar';
import { rememberLastPhoto } from '../lib/last-photo';
import tailwindConfig from '../../tailwind.config.js';

vi.mock('./OnboardingGuide', () => ({ OnboardingGuide: () => null }));
const HERE = 'https://second.example.test';
const FIRST = 'https://first.example.test';
vi.mock('../lib/api', () => ({
    updateMemberProfile: vi.fn(async () => ({ success: true, profile: {} })),
    getMemberProfile: vi.fn(async () => ({ avatar: null, bio: '', contact: null })),
    registerMember: vi.fn(),
    nodeAddress: vi.fn(() => 'https://second.example.test'),
}));

const LAST_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
let saved: BeanPoolIdentity;

beforeEach(async () => {
    vi.clearAllMocks();
    // Set again each time: a test that changed what the community holds must not leak into the next.
    vi.mocked(api.getMemberProfile).mockReset().mockResolvedValue({ avatar: null, bio: '', contact: null } as any);
    vi.mocked(api.updateMemberProfile).mockReset().mockResolvedValue({ success: true, profile: {} } as any);
    vi.mocked(api.nodeAddress).mockReset().mockReturnValue(HERE);
    localStorage.clear();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    saved = await generateIdentity('Rowan');
    await importIdentity(saved);
    rememberLastPhoto(LAST_PHOTO, FIRST);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

/** The wizard, open on the photo step (the name is already there). */
async function openPhotoStep() {
    const view = render(<ProfileSetup identity={saved} onDone={vi.fn()} onIdentityUpdated={vi.fn()} />);
    expect(await screen.findByText('📸 Choose your look')).toBeInTheDocument();
    return view;
}
const offer = () => screen.queryByTestId('last-photo-offer') as HTMLInputElement | null;
const preview = (container: HTMLElement) => (container.querySelector('.w-24.h-24') as HTMLElement).style.background;
async function finish() {
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Done ✓' }));
    await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(1));
    return vi.mocked(api.updateMemberProfile).mock.calls[0][1];
}

describe('the web wizard offers the last photo as a tickbox that starts off', () => {
    it('shows the offer on the photo step, off, naming the community the photo came from, and previews nothing of it', async () => {
        const { container } = await openPhotoStep();
        const box = offer()!;
        expect(box).not.toBeNull();
        expect(box.type).toBe('checkbox');
        expect(box.checked).toBe(false);
        expect(screen.getByRole('checkbox', { name: 'Use the photo from first.example.test?' })).toBe(box);
        // The preview is this community's: the ready-made picture the key picks, not the offered photo.
        expect(preview(container)).toContain(resolveAvatarUrl(null, saved.publicKey)!);
        expect(preview(container)).not.toContain('base64');
        // Choosing a photo stays optional, as the wizard always was (§4.5): the offer did not block Next.
        expect(screen.getByRole('button', { name: 'Next →' })).not.toBeDisabled();
    });

    it('says so plainly when it does not know where the photo came from', async () => {
        localStorage.setItem('bp_last_photo', JSON.stringify({ avatar: LAST_PHOTO }));
        await openPhotoStep();
        expect(screen.getByRole('checkbox', { name: 'Use the photo you chose last?' })).toBeInTheDocument();
    });

    it('with the box OFF, Done sends no photo, and nothing of the last one', async () => {
        await openPhotoStep();
        const sent = await finish();
        expect(sent.avatar ?? null).toBeNull();
        expect(JSON.stringify(vi.mocked(api.updateMemberProfile).mock.calls)).not.toContain(LAST_PHOTO);
    });

    it('ticked, the offered photo is the member\'s pick: previewed, and sent by Done like any pick', async () => {
        const { container } = await openPhotoStep();
        fireEvent.click(offer()!);
        expect(offer()!.checked).toBe(true);
        expect(preview(container)).toContain('base64');
        const sent = await finish();
        expect(sent.avatar).toBe(LAST_PHOTO);
        expect(vi.mocked(api.updateMemberProfile).mock.calls[0][0]).toBe(saved.publicKey);
    });

    it('ticked and then un-ticked, nothing of it is left to send', async () => {
        const { container } = await openPhotoStep();
        fireEvent.click(offer()!);
        fireEvent.click(offer()!);
        expect(offer()!.checked).toBe(false);
        expect(preview(container)).not.toContain('base64');
        const sent = await finish();
        expect(sent.avatar ?? null).toBeNull();
    });

    it('ticked and then a ready-made picture chosen, the box un-ticks and that picture is what goes', async () => {
        await openPhotoStep();
        fireEvent.click(offer()!);
        fireEvent.click(screen.getAllByRole('button', { name: /Select .* avatar/ })[0]);
        expect(offer()!.checked).toBe(false);
        const sent = await finish();
        expect(sent.avatar).toMatch(/^bundled:\/\//);
        expect(JSON.stringify(vi.mocked(api.updateMemberProfile).mock.calls)).not.toContain(LAST_PHOTO);
    });

    it('offers nothing when this community already holds a photo for the member', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValue({ avatar: '/api/avatar/abc?size=thumb&v=1&k=2', bio: '', contact: null } as any);
        render(<ProfileSetup identity={saved} onDone={vi.fn()} onIdentityUpdated={vi.fn()} />);
        await screen.findByLabelText('Your name');
        expect(offer()).toBeNull();
    });

    it('offers nothing when the photo was set in this very community, or no photo was ever used', async () => {
        rememberLastPhoto(LAST_PHOTO, `${HERE}/`);
        await openPhotoStep();
        expect(offer()).toBeNull();
    });

    it('offers nothing when no photo was ever used', async () => {
        localStorage.clear();
        await openPhotoStep();
        expect(offer()).toBeNull();
    });

    it('offers nothing when the community could not be asked what it holds', async () => {
        vi.mocked(api.getMemberProfile).mockRejectedValue(new Error('offline'));
        render(<ProfileSetup identity={saved} onDone={vi.fn()} onIdentityUpdated={vi.fn()} />);
        await screen.findByLabelText('Your name');
        expect(offer()).toBeNull();
    });
});

describe('the tickbox at 320 px wide with the text at 130 %, in light and in dark', () => {
    // The classes are what jsdom can read; the palette is the app's own (tailwind.config.js). Chromium measures the same
    // class strings in e2e/dark-class-check.mjs (test-all's pwa_dark_classes).
    const nature = (resolveConfig(tailwindConfig as any).theme.colors as any).nature as Record<string, string>;
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

    it('the words take the room left and wrap, the box and the picture keep their size, and each colour has its dark partner', async () => {
        await openPhotoStep();
        const row = offer()!.closest('label')!;
        const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

        // The words: flex-1 + min-w-0 + break-words is how a flex child wraps inside a narrow card instead of pushing it wider.
        const words = Array.from(row.querySelectorAll('span')).find(s => s.textContent?.startsWith('Use the photo'))!;
        expect(classes(words)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0', 'break-words']));
        // The box (20 px) and the picture (40 px) do not shrink, and the row is padded.
        expect(classes(offer()!)).toEqual(expect.arrayContaining(['w-5', 'h-5', 'shrink-0']));
        const thumb = Array.from(row.querySelectorAll('span')).find(s => s.getAttribute('aria-hidden') === 'true')!;
        expect(classes(thumb)).toEqual(expect.arrayContaining(['w-10', 'h-10', 'shrink-0']));
        expect(classes(row)).toEqual(expect.arrayContaining(['flex', 'items-center', 'gap-3', 'p-3']));

        // Every light colour has a dark one beside it.
        expect(classes(row)).toEqual(expect.arrayContaining(['bg-nature-50', 'dark:bg-nature-800', 'border-nature-300', 'dark:border-nature-600']));
        expect(classes(words)).toEqual(expect.arrayContaining(['text-nature-800', 'dark:text-nature-100']));
        expect(classes(offer()!)).toEqual(expect.arrayContaining(['accent-nature-900', 'dark:accent-white']));

        // The words read in both (4.5:1): from the palette the classes name.
        expect(ratio(nature['800'], nature['50'])).toBeGreaterThanOrEqual(4.5);
        expect(ratio(nature['100'], nature['800'])).toBeGreaterThanOrEqual(4.5);
    });
});
