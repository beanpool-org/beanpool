/**
 * Settings → "How this community works" on the web app: the floor and the rule, from what the node sends (review of #2746).
 * The rules page is one of the only two places the rule lives (Marty, 2 Nov: "Rules page only"), so this door must draw
 * what Home's does: the real page, its own read of GET /api/community/me, and the real modal.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
        getSignInRecovery: vi.fn(async () => []),
        getCommunityInfo: vi.fn(async () => { throw new Error('not asked'); }),
        getCommunityMe: vi.fn(async () => null),
    };
});

const RULE = "The admins can see a confirmed member's balance if they owe more than half their credit line, or stay in debit for 60 days without a sale. Each look is logged.";
/** What GET /api/community/me says to a member of a known community (apps/server config/features-for.ts). */
const WIRE = { beans: true, escrow: true, door: 'members', knownFloor: 1000, debtLinePct: 50, quietDays: 60 };
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me', mnemonic: [] };

/** GET /api/community/known-rule; anything else this page asks of fetch has no answer. */
function stubRule(rule: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => (String(url).includes('/api/community/known-rule') && rule
        ? new Response(JSON.stringify(rule), { status: 200 })
        : new Response('{}', { status: 404 }))));
}

async function openRulesPage(features: Record<string, unknown>) {
    vi.mocked(api.getCommunityMe).mockResolvedValue({ features } as Awaited<ReturnType<typeof api.getCommunityMe>>);
    render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
    await waitFor(() => expect(api.getCommunityMe).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('settings-how-this-community-works'));
    return screen.findByTestId('community-shape-modal');
}

beforeEach(() => {
    localStorage.clear();
    resetCommunityInfoOnce();
    stubRule(null);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('Settings → "How this community works" (review of #2746)', () => {
    it('draws the floor, then the rule', async () => {
        const modal = await openRulesPage(WIRE);
        await waitFor(() => expect(modal.textContent).toContain(`(the known floor)${RULE}`));
    });

    it('a line of its own, and a tightened line\'s date from the public route', async () => {
        stubRule({ known: true, knownFloor: 1000, debtLinePct: 30, quietDays: 90, ruleFrom: '2026-11-01T04:00:00.000Z', debtLineFrom: '2026-11-16T04:00:00.000Z', quietDaysFrom: null });
        const modal = await openRulesPage({ ...WIRE, debtLinePct: 30, quietDays: 90 });
        await waitFor(() => expect(modal.textContent).toContain('more than 30% of their credit line, or stay in debit for 90 days'));
        await waitFor(() => expect(modal.textContent).toContain('The line of 30% applies from 16 November.'));
    });

    it('a node older than the rule: the floor alone', async () => {
        const { debtLinePct: _p, quietDays: _q, ...older } = WIRE;
        const modal = await openRulesPage(older);
        await waitFor(() => expect(modal.textContent).toContain('(the known floor)'));
        expect(modal.textContent).not.toContain('admins can see');
    });
});
