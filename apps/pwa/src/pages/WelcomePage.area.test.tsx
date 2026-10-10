/**
 * WelcomePage's Your Area step (design DESIGN-global-sync-by-area §3.1-3.2, slice S4): a fifth stepper column after Your
 * Photo on a node whose `/api/community/info` says `features.nearbyListings`, four columns elsewhere. Skip writes
 * nothing; a position is rounded to 0.1° before any request is built; on a by-area node the browser is not asked for
 * its position at the end of signup (the step asked), while a local community keeps today's one ask.
 *
 * The node is a stubbed fetch, entered through the open door as WelcomePage.door.test.tsx does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const BYRON = { displayName: 'Byron Bay, New South Wales, Australia', shortName: 'Byron Bay', lat: -28.647412, lng: 153.612031, type: 'town' };
vi.mock('../components/AddressSearch', () => ({
    AddressSearch: ({ onPick }: { onPick: (r: typeof BYRON) => void }) => (
        <button type="button" data-testid="pick-byron" onClick={() => onPick(BYRON)}>Byron Bay</button>
    ),
}));

import { WelcomePage } from './WelcomePage';
import { generateIdentity, savePendingJoin, PENDING_JOIN_TTL_MS, type BeanPoolIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

type Handler = (body: any, path: string) => Response;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubNode(info: unknown, handlers: Record<string, Handler> = {}) {
    const calls: Array<{ path: string; body: any; raw: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const raw = init.body ? String(init.body) : '';
        calls.push({ path, body: raw ? JSON.parse(raw) : undefined, raw });
        if (path === '/api/community/info') return json(200, info);
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        if (key) return handlers[key](raw ? JSON.parse(raw) : undefined, path);
        return json(200, {});
    }));
    return calls;
}

const GLOBAL_OPEN = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true } };
const GLOBAL_BY_AREA = { ...GLOBAL_OPEN, features: { openJoin: true, nearbyListings: { radiusKm: 250, max: 500 } } };

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let identity: BeanPoolIdentity;
let geo: { getCurrentPosition: ReturnType<typeof vi.fn> };
let position: { ok: true; lat: number; lng: number } | { ok: false; code: number } = { ok: true, lat: -28.647412, lng: 153.612031 };

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    identity = await generateIdentity('Alice');
    position = { ok: true, lat: -28.647412, lng: 153.612031 };
    geo = {
        getCurrentPosition: vi.fn((ok: PositionCallback, fail?: PositionErrorCallback | null) => {
            if (position.ok) ok({ coords: { latitude: position.lat, longitude: position.lng } } as GeolocationPosition);
            else fail?.({ code: position.code, message: 'no' } as GeolocationPositionError);
        }),
    };
    Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
    Object.defineProperty(navigator, 'storage', { value: { persist: vi.fn(async () => true), persisted: vi.fn(async () => false) }, configurable: true });
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
    localStorage.clear();
});

const AREA_SAVED = { success: true, area: { lat: -28.6, lng: 153.6, updatedAt: '2026-10-11T00:00:00.000Z' } };

/** Through the door with Google to the photo step, the photo picked. */
async function toThePhoto(info: unknown, areaAnswer: Handler = () => json(200, AREA_SAVED)) {
    await savePendingJoin({ identity, provider: 'google', nonce: 'n1', startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
    const token = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g1', nonce: 'n1' }))}.c2ln`;
    window.history.replaceState(null, '', `/app/auth/google#state=n1&id_token=${token}`);
    const calls = stubNode(info, {
        '/api/join': () => json(200, { success: true, member: { callsign: 'Alice' } }),
        '/api/community/me/area': areaAnswer,
    });
    const onComplete = vi.fn();
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(await screen.findByTitle('Green Bean'));
    return { calls, onComplete };
}
const columns = () => Array.from(screen.getByTestId('onboarding-stepper').children).map((c) => (c.textContent ?? '').replace('✓', ''));
const areaCalls = (calls: Array<{ path: string }>) => calls.filter((c) => c.path === '/api/community/me/area');

async function finishFromBackup(onComplete: ReturnType<typeof vi.fn>) {
    await screen.findByText(/Your Safety Backup/);
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    fireEvent.click(await screen.findByRole('button', { name: "Let's Begin! 🚀" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
}

describe('Your Area at signup (S4)', () => {
    it('five columns with the feature, Your Area after Your Photo; the step says the words of §3.2', async () => {
        await toThePhoto(GLOBAL_BY_AREA);
        expect(columns()).toEqual(['Sign in', 'Your Photo', 'Your Area', 'Safety Backup', 'How it Works']);
        expect(screen.getByTestId('onboarding-stepper').style.gridTemplateColumns).toBe('repeat(5, minmax(0, 1fr))');
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        expect(await screen.findByText(/Roughly where are you\?/)).toBeInTheDocument();
        const step = screen.getByTestId('area-step');
        expect(step).toHaveTextContent("The worldwide community shows you what's on offer near you: the nearest 500 listings within 250 km.");
        expect(step).toHaveTextContent('We keep your area to about 10 km, never your exact spot. Other members see only a distance in km.');
        expect(step).toHaveTextContent('You can change or clear this any time in Settings → Your area.');
        expect(step.textContent).not.toMatch(/Ʀ|Beans/);
        expect(screen.getByRole('button', { name: /Use my location/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Type a town or suburb/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    });

    it('four columns without the feature: the photo goes straight to the words, and the browser is asked once at the end, as today', async () => {
        const { calls, onComplete } = await toThePhoto(GLOBAL_OPEN);
        expect(columns()).toEqual(['Sign in', 'Your Photo', 'Safety Backup', 'How it Works']);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        await finishFromBackup(onComplete);
        expect(screen.queryByText(/Roughly where are you\?/)).toBeNull();
        expect(areaCalls(calls)).toEqual([]);
        expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    });

    it('Skip writes nothing and asks nothing: no request, no position, and none at the end either', async () => {
        const { calls, onComplete } = await toThePhoto(GLOBAL_BY_AREA);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        const before = calls.length;
        const stored = JSON.stringify({ ...localStorage });
        fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
        expect(calls.length).toBe(before);
        expect(JSON.stringify({ ...localStorage })).toBe(stored);
        await finishFromBackup(onComplete);
        expect(areaCalls(calls)).toEqual([]);
        expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    });

    it('Use my location rounds to 0.1° before the request: the precise position is never sent', async () => {
        const { calls, onComplete } = await toThePhoto(GLOBAL_BY_AREA);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        fireEvent.click(await screen.findByRole('button', { name: /Use my location/ }));
        await screen.findByText(/Your Safety Backup/);
        expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
        expect(geo.getCurrentPosition.mock.calls[0][2]).toMatchObject({ enableHighAccuracy: false });
        expect(areaCalls(calls).map((c) => (c as { raw: string }).raw)).toEqual(['{"lat":-28.6,"lng":153.6}']);
        expect(JSON.stringify(calls)).not.toMatch(/647412|612031/);
        await finishFromBackup(onComplete);
        expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1); // not asked again at the end
    });

    it('a typed town is rounded the same way; its name stays in this browser', async () => {
        const { calls } = await toThePhoto(GLOBAL_BY_AREA);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        fireEvent.click(await screen.findByRole('button', { name: /Type a town or suburb/ }));
        fireEvent.click(screen.getByTestId('pick-byron'));
        await screen.findByText(/Your Safety Backup/);
        expect(areaCalls(calls).map((c) => (c as { raw: string }).raw)).toEqual(['{"lat":-28.6,"lng":153.6}']);
        expect(JSON.stringify(areaCalls(calls))).not.toContain('Byron');
        expect(localStorage.getItem('beanpool_area_place')).toBe('Byron Bay');
    });

    it('location refused: one line, no request, still on the step; Skip still goes on', async () => {
        position = { ok: false, code: 1 };
        const { calls } = await toThePhoto(GLOBAL_BY_AREA);
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        fireEvent.click(await screen.findByRole('button', { name: /Use my location/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Location is off for this site. Type a town instead, or skip for now.');
        expect(areaCalls(calls)).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
        expect(await screen.findByText(/Your Safety Backup/)).toBeInTheDocument();
    });

    it('a refused save says so and never pretends; Back returns to the photo', async () => {
        await toThePhoto(GLOBAL_BY_AREA, () => json(403, { error: 'Only a member of this community can set an area here' }));
        fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
        fireEvent.click(await screen.findByRole('button', { name: /Use my location/ }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Only a member of this community can set an area here');
        expect(screen.queryByText(/Your Safety Backup/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '← Back' }));
        expect(await screen.findByText(/Choose your look/)).toBeInTheDocument();
    });
});
