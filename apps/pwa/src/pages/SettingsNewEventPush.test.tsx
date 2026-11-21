/**
 * Settings → Notification Preferences → "When someone posts a new event" (notifications NEb,
 * scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §12.3 row 15): the `event.new` notice's own switch.
 * On until the member turns it off, saved as `notify_new_events`, and shown only where the community says `newEventPush`
 * (core newEventPushOn): never on the global community, never on a node from before NEa. A node from before it refuses
 * the key, and the web saves every switch at once, so the key is never sent there. The phone's row is the same switch
 * (apps/native app/(tabs)/settings.tsx, testID settings-notify-new-events).
 *
 * Drawn at 320 px with text at 130 %, in light and in dark: jsdom lays nothing out, so the row is checked for what keeps it
 * whole there (the words' column may shrink and wrap, nothing truncates or holds a line) and for a dark colour beside
 * every light one, from the same palette as the rows around it.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NEW_EVENT_PUSH_WORDS } from '@beanpool/core';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import * as features from '../lib/features';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        updateNotificationPreferences: vi.fn(async () => ({ success: true })),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
    };
});
vi.mock('../lib/features', async () => {
    const actual = await vi.importActual<typeof import('../lib/features')>('../lib/features');
    return { ...actual, useCommunityInfo: vi.fn() };
});

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };
const SWITCH = 'When someone posts a new event';
const LINE = 'At most once a day, and only for events open to everyone here';

/** What the node keeps, as the server serves it back: every saved value as a string ('true' / 'false'). */
let kept: Record<string, string> = {};

/** How the community describes itself: a local one that sends the notice, one that says it doesn't, or one that says nothing. */
type Node = 'says-on' | 'says-off' | 'older';
function featuresOf(node: Node) {
    const base = { beans: true };
    if (node === 'says-on') return { ...base, newEventPush: true };
    if (node === 'says-off') return { ...base, newEventPush: false };
    return base;
}

async function openNotifications(node: Node) {
    vi.mocked(features.useCommunityInfo).mockReturnValue({ profile: 'local', features: featuresOf(node) } as any);
    render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
    fireEvent.click(screen.getByText('Notification Preferences'));
    await screen.findByText('Event reminders');
}

/** 320 px wide, text at 130 %, light or dark. */
function drawAt320(theme: 'light' | 'dark') {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true, writable: true });
    document.documentElement.style.fontSize = '130%';
    document.documentElement.classList.toggle('dark', theme === 'dark');
}

beforeEach(() => {
    kept = {};
    vi.mocked(api.getNotificationPreferences).mockReset().mockImplementation(async () => ({ ...kept }) as any);
    vi.mocked(api.updateNotificationPreferences).mockReset().mockImplementation(async (_pk: string, prefs: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(prefs)) kept[k] = String(v);
        return { success: true } as any;
    });
});
afterEach(() => {
    document.documentElement.style.fontSize = '';
    document.documentElement.classList.remove('dark');
});

describe('Settings → Notifications → When someone posts a new event (notifications NEb), on the web', () => {
    it("the words are core's, the same on the phone", () => {
        expect(NEW_EVENT_PUSH_WORDS.switchName).toBe(SWITCH);
        expect(NEW_EVENT_PUSH_WORDS.switchLine).toBe(LINE);
    });

    // One row per state: what the node says, what the member chose, and what the row shows. Each is red without its line
    // in SettingsPage.tsx (the gate, the read, the toggle or the save's guard).
    const rows: Array<{ name: string; node: Node; kept: Record<string, string>; shown: boolean; checked?: 'true' | 'false'; readFails?: boolean }> = [
        { name: 'the node says newEventPush, the member never chose: shown, on', node: 'says-on', kept: {}, shown: true, checked: 'true' },
        { name: "the node says newEventPush, the preferences read fails: shown, on (the node's own default)", node: 'says-on', kept: {}, shown: true, checked: 'true', readFails: true },
        { name: "the node says newEventPush, the member left it on ('true'): shown, on", node: 'says-on', kept: { notify_new_events: 'true' }, shown: true, checked: 'true' },
        { name: "the node says newEventPush, the member turned it off ('false'): shown, off", node: 'says-on', kept: { notify_new_events: 'false' }, shown: true, checked: 'false' },
        { name: 'the node says newEventPush is off (the global community): no switch', node: 'says-off', kept: {}, shown: false },
        { name: 'an older node, without the field: no switch', node: 'older', kept: {}, shown: false },
    ];
    for (const theme of ['light', 'dark'] as const) {
        for (const r of rows) {
            it(`${theme}, 320 px at 130 %: ${r.name}`, async () => {
                drawAt320(theme);
                kept = { ...r.kept };
                if (r.readFails) vi.mocked(api.getNotificationPreferences).mockRejectedValue(new Error('503'));
                await openNotifications(r.node);
                const row = screen.queryByTestId('settings-notify-new-events');
                if (!r.shown) {
                    expect(row).toBeNull();
                    expect(screen.queryByText(SWITCH)).toBeNull();
                    expect(screen.queryByText(LINE)).toBeNull();
                    return;
                }
                expect(row).not.toBeNull();
                expect(row!.textContent).toContain(SWITCH);
                expect(row!.textContent).toContain(LINE);
                await waitFor(() => expect(screen.getByLabelText(SWITCH)).toHaveAttribute('aria-checked', r.checked));
                // Whole at 320 px and 130 %: the words' column may shrink and wrap; nothing cuts or holds a line.
                const words = screen.getByText(SWITCH).parentElement!;
                expect(words.className.split(/\s+/)).toContain('min-w-0');
                for (const el of [row!, words, screen.getByText(SWITCH), screen.getByText(LINE)]) {
                    expect(el.className).not.toMatch(/\b(truncate|whitespace-nowrap|line-clamp-\d)\b/);
                }
                // Light and dark: a dark colour beside every light one, the palette the rows around it use.
                expect(row!.className.split(/\s+/)).toEqual(expect.arrayContaining(['border-nature-200', 'dark:border-nature-800']));
                expect(screen.getByText(SWITCH).className.split(/\s+/)).toEqual(expect.arrayContaining(['text-nature-900', 'dark:text-white']));
                expect(screen.getByText(LINE).className.split(/\s+/)).toEqual(expect.arrayContaining(['text-nature-500', 'dark:text-nature-400']));
            });
        }
    }

    it('a tap saves notify_new_events off with the rest; a reload reads it back off; a second tap turns it on and a reload reads that', async () => {
        await openNotifications('says-on');
        fireEvent.click(screen.getByLabelText(SWITCH));
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalledWith('me-pk', expect.objectContaining({ notify_new_events: false })));
        expect(screen.getByLabelText(SWITCH)).toHaveAttribute('aria-checked', 'false');
        expect(kept.notify_new_events).toBe('false');

        cleanup();
        await openNotifications('says-on');
        await waitFor(() => expect(screen.getByLabelText(SWITCH)).toHaveAttribute('aria-checked', 'false'));

        fireEvent.click(screen.getByLabelText(SWITCH));
        await waitFor(() => expect(kept.notify_new_events).toBe('true'));
        cleanup();
        await openNotifications('says-on');
        await waitFor(() => expect(screen.getByLabelText(SWITCH)).toHaveAttribute('aria-checked', 'true'));
    });

    it("another switch's save keeps this one as the member set it", async () => {
        kept = { notify_new_events: 'false' };
        await openNotifications('says-on');
        await waitFor(() => expect(screen.getByLabelText(SWITCH)).toHaveAttribute('aria-checked', 'false'));
        fireEvent.click(screen.getByLabelText('Direct messages notifications'));
        await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalled());
        expect(vi.mocked(api.updateNotificationPreferences).mock.calls[0][1]).toEqual(expect.objectContaining({ notify_new_events: false }));
    });

    for (const node of ['says-off', 'older'] as const) {
        it(`${node === 'older' ? 'an older node' : 'a node that says it is off'}: another switch saves without the key, which that node would refuse`, async () => {
            await openNotifications(node);
            fireEvent.click(screen.getByLabelText('Direct messages notifications'));
            await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalled());
            expect(vi.mocked(api.updateNotificationPreferences).mock.calls[0][1]).not.toHaveProperty('notify_new_events');
        });
    }
});
