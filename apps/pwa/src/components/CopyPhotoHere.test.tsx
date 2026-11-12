/**
 * Copy on request, on the web (Profile S4, scratch/fable-design/DESIGN-per-community-profile-fable.md §4).
 *
 * A browser talks to one community, so the only copy it can make goes INTO that community, from the one photo it kept from
 * another (lib/last-photo.ts); the phone, which holds every community it has joined, copies out to a chosen one
 * (apps/native). Showing the card changes nothing; the tap sends the photo and nothing else, to this community's address and
 * no other. The real api layer runs here, over a recorded fetch and a real stored identity.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import resolveConfig from 'tailwindcss/resolveConfig';
import { CopyPhotoHere } from './CopyPhotoHere';
import { generateIdentity, importIdentity, type BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { rememberLastPhoto, readLastPhoto } from '../lib/last-photo';
import { hearNodeVersionForTests, resetNodeVersionGateForTests } from '../lib/node-version-gate';

const HERE = 'https://second.example.test';
const FIRST = 'https://first.example.test';
const LAST_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

let saved: BeanPoolIdentity;
let requests: Array<{ url: string; method: string; body: any }>;
let answer: () => { ok: boolean; status: number; body: unknown };

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('bp_node_url', HERE);
    // This community runs 1.4.0 (lib/node-version-gate.ts): the requests recorded are the card's own.
    resetNodeVersionGateForTests();
    hearNodeVersionForTests(HERE);
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    saved = await generateIdentity('Rowan');
    await importIdentity(saved);
    rememberLastPhoto(LAST_PHOTO, FIRST);
    requests = [];
    answer = () => ({ ok: true, status: 200, body: { success: true, profile: {} } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
        const a = answer();
        return { ok: a.ok, status: a.status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => a.body, text: async () => JSON.stringify(a.body) };
    }));
});
afterEach(() => {
    vi.unstubAllGlobals();
});

const card = () => screen.queryByTestId('copy-photo-here');
const goButton = () => screen.getByRole('button', { name: 'Use this photo here' });

describe('the web copies the kept photo into this community, only when asked', () => {
    it('shows the photo from the other community, naming it, and sends nothing by being shown', async () => {
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        expect(card()).not.toBeNull();
        expect(screen.getByText('Use the photo from first.example.test here?')).toBeInTheDocument();
        expect(screen.getByText('Only the photo is copied. Your name and the rest of your profile here stay as they are.')).toBeInTheDocument();
        expect(requests).toEqual([]);
    });

    it('says so plainly when it does not know where the photo came from', () => {
        localStorage.setItem('bp_last_photo', JSON.stringify({ avatar: LAST_PHOTO }));
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        expect(screen.getByText('Use the photo you chose last here?')).toBeInTheDocument();
    });

    it('the tap sends the photo and nothing else, to this community and no other', async () => {
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        fireEvent.click(goButton());
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Done. This is now your photo here.'));

        const sent = requests.filter(r => r.method === 'POST');
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe(`${HERE}/api/profile/update`);
        // The member's key and the one photo: no name, no bio, no contact.
        expect(sent[0].body).toEqual({ publicKey: saved.publicKey, avatar: LAST_PHOTO });
        // The community the photo came from is never contacted: a browser has no way to reach it, or to copy out to it.
        expect(requests.every(r => new URL(r.url).origin === HERE)).toBe(true);
        expect(requests.some(r => r.url.includes(FIRST))).toBe(false);
    });

    it('the photo is now this community\'s: the card goes quiet and the offer to copy it again is gone', async () => {
        const { unmount } = render(<CopyPhotoHere publicKey={saved.publicKey} />);
        fireEvent.click(goButton());
        await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: 'Use this photo here' })).toBeNull();
        expect(readLastPhoto()).toEqual({ avatar: LAST_PHOTO, from: HERE });
        unmount();
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        expect(card()).toBeNull();
    });

    it('works when this community already holds a photo: the member asked, so it is theirs to replace', async () => {
        // The card takes no row: it is the member's own request, not the offer on joining (which waits for a community with none).
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        expect(card()).not.toBeNull();
        fireEvent.click(goButton());
        await waitFor(() => expect(requests.filter(r => r.method === 'POST')).toHaveLength(1));
    });

    it('offline, it sends nothing and says so; a refusal says so and can be tried again', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        fireEvent.click(goButton());
        expect(await screen.findByRole('alert')).toHaveTextContent('You need to be online to save your profile.');
        expect(requests).toEqual([]);
        vi.mocked(navigator.onLine as any);
        vi.restoreAllMocks();

        answer = () => ({ ok: false, status: 503, body: { error: 'busy', message: 'Busy, try again.' } });
        fireEvent.click(goButton());
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        expect(screen.queryByRole('status')).toBeNull();
        answer = () => ({ ok: true, status: 200, body: { success: true, profile: {} } });
        fireEvent.click(goButton());
        await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    });

    it('shows nothing when no photo was kept, it cannot travel, or it was set in this very community', () => {
        localStorage.removeItem('bp_last_photo');
        const { unmount } = render(<CopyPhotoHere publicKey={saved.publicKey} />);
        expect(card()).toBeNull();
        unmount();

        // A community's own picture URL names a place, not a picture.
        localStorage.setItem('bp_last_photo', JSON.stringify({ avatar: '/api/avatar/abc?size=thumb&v=1', from: FIRST }));
        const second = render(<CopyPhotoHere publicKey={saved.publicKey} />);
        expect(card()).toBeNull();
        second.unmount();

        rememberLastPhoto(LAST_PHOTO, `${HERE}/`);
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        expect(card()).toBeNull();
    });
});

describe('the card at 320 px wide with the text at 130 %, in light and in dark', () => {
    // The classes are what jsdom can read; the palette is the app's own (tailwind.config.js). Chromium measures the same
    // class strings in e2e/dark-class-check.mjs (test-all's pwa_dark_classes).
    // tailwind.config.js names each `nature` step by its channel variable (rgb(var(--bp-n-900) / <alpha-value>)) and each look
    // writes those channels (webSetVariableMap), so a step is read through the set it is drawn in: a plain class in Light, a
    // dark: class in Classic (`dark`) and in Dark (`night`).
    const natureShades = async (set: 'light' | 'dark' | 'night') => {
        const { default: config, webSetVariableMap } = await import(/* @vite-ignore */ pathToFileURL(path.resolve(__dirname, '../../tailwind.config.js')).href);
        const vars = webSetVariableMap(set) as Record<string, string>;
        const steps = (resolveConfig(config).theme.colors as any).nature as Record<string, string>;
        return Object.fromEntries(Object.entries(steps).map(([step, value]) => {
            const ref = /^rgb\(var\((--bp-n-\d+)\) \/ <alpha-value>\)$/.exec(value);
            const ch = ref ? vars[ref[1]]?.split(' ').map(Number) : undefined;
            if (!ch || ch.length !== 3 || ch.some(c => !Number.isInteger(c))) throw new Error(`nature-${step} in ${set} is not a ramp channel: ${value}`);
            return [step, `#${ch.map(c => c.toString(16).padStart(2, '0')).join('')}`];
        })) as Record<string, string>;
    };
    const DARK_SETS = ['dark', 'night'] as const;
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

    it('the words take the room left and wrap, the picture and the button keep their size, and each colour has its dark partner', async () => {
        // The longest host a community has: it must wrap inside the card, not push it wider.
        localStorage.setItem('bp_last_photo', JSON.stringify({ avatar: LAST_PHOTO, from: 'https://the-mullumbimby-neighbours-bean-exchange.example.test' }));
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        const section = card()!;
        expect(classes(section)).toEqual(expect.arrayContaining(['w-full', 'p-4', 'bg-white', 'dark:bg-nature-900', 'text-nature-900', 'dark:text-white', 'border-nature-200', 'dark:border-nature-800']));

        const heading = screen.getByText(/^Use the photo from the-mullumbimby/);
        expect(classes(heading)).toEqual(expect.arrayContaining(['break-words']));
        expect(classes(heading.parentElement!)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0']));
        const hint = screen.getByText(/^Only the photo is copied/);
        expect(classes(hint)).toEqual(expect.arrayContaining(['text-nature-600', 'dark:text-nature-300', 'break-words']));
        const thumb = Array.from(section.querySelectorAll('span')).find(s => s.getAttribute('aria-hidden') === 'true')!;
        expect(classes(thumb)).toEqual(expect.arrayContaining(['w-12', 'h-12', 'shrink-0']));

        const button = goButton();
        expect(classes(button)).toEqual(expect.arrayContaining(['w-full', 'min-h-[44px]', 'bg-nature-900', 'dark:bg-white', 'text-white', 'dark:text-nature-900']));

        // The words read in both (4.5:1), from the palette the classes name: on the card (white / nature-900) and on the button
        // (nature-900 with white words in light; white with nature-900 words in dark).
        const light = await natureShades('light');
        const white = '#ffffff';
        expect(ratio(light['900'], white)).toBeGreaterThanOrEqual(4.5);  // the heading in light
        expect(ratio(light['600'], white)).toBeGreaterThanOrEqual(4.5);  // the hint in light (nature-500 was 3.3:1)
        expect(ratio(white, light['900'])).toBeGreaterThanOrEqual(4.5);  // the button's words in light
        expect(ratio(light['800'], white)).toBeGreaterThanOrEqual(4.5);  // the line after the tap in light
        for (const set of DARK_SETS) {
            const dark = await natureShades(set);
            expect(ratio(white, dark['900']), `the heading in ${set}`).toBeGreaterThanOrEqual(4.5);
            expect(ratio(dark['300'], dark['900']), `the hint in ${set}`).toBeGreaterThanOrEqual(4.5);
            expect(ratio(dark['900'], white), `the button's words in ${set}`).toBeGreaterThanOrEqual(4.5);
            expect(ratio(dark['100'], dark['900']), `the line after the tap in ${set}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('the line after the tap and a refusal keep their dark partners and read on the card', async () => {
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        fireEvent.click(goButton());
        const done = await screen.findByRole('status');
        expect(classes(done)).toEqual(expect.arrayContaining(['text-nature-800', 'dark:text-nature-100', 'break-words']));

        // red-700 on white and red-300 on nature-900, from the palette tailwind resolves.
        const { default: config } = await import(/* @vite-ignore */ pathToFileURL(path.resolve(__dirname, '../../tailwind.config.js')).href);
        const colors = resolveConfig(config).theme.colors as any;
        expect(ratio(colors.red['700'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
        for (const set of DARK_SETS) {
            expect(ratio(colors.red['300'], (await natureShades(set))['900']), `red-300 on the card in ${set}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('a refusal is drawn in those colours', async () => {
        answer = () => ({ ok: false, status: 503, body: { error: 'busy', message: 'Busy, try again.' } });
        render(<CopyPhotoHere publicKey={saved.publicKey} />);
        fireEvent.click(goButton());
        const alert = await screen.findByRole('alert');
        expect(classes(alert)).toEqual(expect.arrayContaining(['text-red-700', 'dark:text-red-300', 'break-words']));
    });
});
