/**
 * Settings → Your area (design DESIGN-global-sync-by-area §3.5, slice S4): a row only on a community whose info says
 * `features.nearbyListings`, showing the node's value (GET /api/community/me) as "About 10 km around <town or lat, lng>"
 * or "Not set", with Clear (both null) and below it the signup's step (rounded before the request), whose Skip is
 * "← Back to Settings".
 */
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        request: vi.fn(),
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
    };
});
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn() }));

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const BY_AREA = { profile: 'global', features: { openJoin: true, nearbyListings: { radiusKm: 250, max: 500 } } };
let stored: { lat: number; lng: number } | null = null;
let writes: unknown[] = [];

beforeEach(() => {
    stored = null;
    writes = [];
    localStorage.clear();
    vi.mocked(communityInfoOnce).mockReset().mockResolvedValue(BY_AREA as any);
    vi.mocked(api.request).mockReset().mockImplementation((async (method: string, path: string, body?: any) => {
        if (method === 'GET' && path === '/api/community/me') return { publicKey: 'me-pk', area: stored };
        if (method === 'POST' && path === '/api/community/me/area') {
            writes.push(body);
            stored = body.lat === null ? null : { lat: body.lat, lng: body.lng };
            return { success: true, area: stored };
        }
        return {};
    }) as any);
    Object.defineProperty(navigator, 'geolocation', {
        value: { getCurrentPosition: vi.fn((ok: PositionCallback) => ok({ coords: { latitude: 51.507351, longitude: -0.127758 } } as GeolocationPosition)) },
        configurable: true,
    });
});
afterEach(() => cleanup());

const open = () => render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);

describe('Settings → Your area (S4)', () => {
    it('no row on a community that does not sync by area', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({ profile: 'local', features: {} } as any);
        open();
        await screen.findByText('Notification Preferences');
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('settings-your-area')).toBeNull();
        expect(api.request).not.toHaveBeenCalledWith('GET', '/api/community/me');
    });

    it("Not set, then Use my location: rounded before the request, and the row says the area", async () => {
        open();
        const row = await screen.findByTestId('settings-your-area');
        await waitFor(() => expect(row).toHaveTextContent('Not set'));
        fireEvent.click(row);
        expect(screen.getByTestId('settings-area-current')).toHaveTextContent('Not set');
        expect(screen.queryByTestId('settings-area-clear')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Use my location/ }));
        await waitFor(() => expect(screen.getByTestId('settings-your-area')).toHaveTextContent('About 10 km around 51.5, -0.1'));
        expect(writes).toEqual([{ lat: 51.5, lng: -0.1 }]);
        expect(JSON.stringify(writes)).not.toMatch(/507351|127758/);
    });

    it('a stored area with the town typed here; Clear sends both null and forgets the town', async () => {
        stored = { lat: -28.6, lng: 153.6 };
        localStorage.setItem('beanpool_area_place', 'Byron Bay');
        open();
        const row = await screen.findByTestId('settings-your-area');
        await waitFor(() => expect(row).toHaveTextContent('About 10 km around Byron Bay'));
        fireEvent.click(row);
        fireEvent.click(screen.getByTestId('settings-area-clear'));
        await waitFor(() => expect(screen.getByTestId('settings-area-current')).toHaveTextContent('Not set'));
        expect(writes).toEqual([{ lat: null, lng: null }]);
        expect(localStorage.getItem('beanpool_area_place')).toBeNull();
        // Back writes nothing more.
        fireEvent.click(screen.getByRole('button', { name: '← Back to Settings' }));
        expect(writes).toHaveLength(1);
    });

    it('← Back to Settings works while a save waits; the late answer changes nothing (review B2)', async () => {
        let release!: (v: unknown) => void;
        let signal: AbortSignal | undefined;
        const base = vi.mocked(api.request).getMockImplementation()!;
        vi.mocked(api.request).mockImplementation((async (method: string, path: string, body?: any, sig?: AbortSignal) => {
            if (method === 'POST' && path === '/api/community/me/area') {
                writes.push(body);
                signal = sig;
                return new Promise((r) => { release = r; });
            }
            return base(method, path, body);
        }) as any);
        open();
        const row = await screen.findByTestId('settings-your-area');
        await waitFor(() => expect(row).toHaveTextContent('Not set'));
        fireEvent.click(row);
        fireEvent.click(screen.getByRole('button', { name: /Use my location/ }));
        await waitFor(() => expect(writes).toHaveLength(1));
        const back = screen.getByRole('button', { name: '← Back to Settings' }) as HTMLButtonElement;
        expect(back.disabled).toBe(false);
        fireEvent.click(back);
        await waitFor(() => expect(screen.getByTestId('settings-your-area')).toHaveTextContent('Not set'));
        expect(signal?.aborted).toBe(true);
        release({ success: true, area: { lat: 51.5, lng: -0.1 } });
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.getByTestId('settings-your-area')).toHaveTextContent('Not set');
        expect(screen.queryByTestId('settings-area')).toBeNull();
    });

    it('one heading, and a Clear that holds 4.5:1 in dark mode (review N6)', async () => {
        stored = { lat: -28.6, lng: 153.6 };
        open();
        const row = await screen.findByTestId('settings-your-area');
        await waitFor(() => expect(row).toHaveTextContent('About 10 km around -28.6, 153.6'));
        fireEvent.click(row);
        const panel = screen.getByTestId('settings-area');
        expect(Array.from(panel.querySelectorAll('h1, h2, h3, h4')).map((h) => h.textContent)).toEqual(['📍 Your area']);
        // red-400 on nature-900 is 3.88:1; red-300 is 5.65:1 (#fca5a5 on #384038). Light stays red-600 on white, 4.83:1.
        const clear = screen.getByTestId('settings-area-clear').className.split(' ');
        expect(clear).toContain('dark:text-red-300');
        expect(clear).not.toContain('dark:text-red-400');
        expect(clear).toContain('text-red-600');
    });

    it("a node that can't be asked: says so, never 'Not set'", async () => {
        vi.mocked(api.request).mockImplementation((async () => { throw new Error('offline'); }) as any);
        open();
        const row = await screen.findByTestId('settings-your-area');
        await waitFor(() => expect(row).toHaveTextContent("Couldn't check right now"));
    });
});
