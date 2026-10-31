import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemberDetailModal } from './MemberDetailModal';
import { AlertsPanel } from './AlertsPanel';
import type { AlertsStatus } from '../../lib/node-client';

/**
 * Removal by vote S4 (scratch/fable-design/DESIGN-removal-by-vote-fable.md §3.4): the server refuses a pause the chain rules
 * don't allow (a second within 30 days of a vote, by anyone but an owner, or with the last reason; a third in 90 days, by
 * anyone; a sixth open pause by one admin, without an owner's fresh proof). Settings says the node's words where Suspend was
 * pressed, and keeps the reason so it can be changed; the tripwire's proof opens the same box an owner's proof does. The
 * owners' alert line about pauses reads in the Alerts card as the node wrote it.
 */
const NODE = 'https://riverbend.example.org';
const dave = 'd'.repeat(64);
const member = { publicKey: dave, callsign: 'dave', status: 'active' };
const NEEDS_OWNER = { error: 'The community decided on dave on 2026-10-30. Only an owner can pause them again before 2026-11-29.', code: 'repause_needs_owner' };
const SAME_REASON = { error: 'The last pause of dave gave this same reason. Pausing them again before 2026-11-29 needs a new one.', code: 'repause_same_reason' };
const THIRD = { error: 'dave has been paused twice in 90 days already. A third time needs the community: propose a Decision.', code: 'third_pause' };
const TRIP = { error: "You have 5 pauses whose votes are still open, so another needs an owner's fresh proof.", code: 'open_pauses_need_proof' };
const TRIP_CODE_ASK = {
    error: 'Enter a current code from your authenticator app (or a backup code) to pause someone while five of your pauses still wait on their votes',
    totpRequired: true,
};

type Sent = { body: Record<string, unknown> };

/** A fake node: the suspend route answers from `answers` in turn; anything else is a plain 200. */
function mockNode(answers: Array<[number, unknown]>) {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => json }) as Response;
        if (url.endsWith(`/users/${dave}/suspend`)) {
            sent.push({ body: init?.body ? JSON.parse(String(init.body)) : {} });
            const [status, json] = answers[Math.min(sent.length - 1, answers.length - 1)];
            return reply(status, json);
        }
        return reply(200, {});
    }));
    return sent;
}

function pressSuspend(reason: string, adminPassword?: string) {
    render(<MemberDetailModal member={member} isFrozen={false} onToggleFreeze={vi.fn()} onClose={vi.fn()} nodeUrl={NODE} adminPassword={adminPassword} />);
    fireEvent.click(screen.getByText('⏸️ Suspend'));
    fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend now' }));
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe('Suspend: the chain rules refuse in the node\'s words (removal S4)', () => {
    for (const [what, refusal, status] of [
        ['an admin, within 30 days of a vote that said No', NEEDS_OWNER, 403],
        ['an owner, with the last reason', SAME_REASON, 400],
        ['anyone, a third time in 90 days', THIRD, 403],
        ['an admin with five open, the sixth', TRIP, 403],
    ] as const) {
        it(`${what}: says so, keeps the reason to change, asks no code, says nothing of a suspension`, async () => {
            const sent = mockNode([[status, refusal]]);
            pressSuspend('Took deposits for repairs and never came back');
            expect(await screen.findByText(refusal.error)).toBeInTheDocument();
            expect(screen.getByLabelText('Reason (members will see this)')).toHaveValue('Took deposits for repairs and never came back');
            expect(screen.queryByTestId('suspend-proof-input')).toBeNull();
            expect(screen.queryByText(/Suspended\./)).toBeNull();
            expect(sent).toHaveLength(1);
        });
    }

    it('an owner with five open, signed in with the password: the code box, in the node\'s words; the code re-sent once', async () => {
        const sent = mockNode([[401, TRIP_CODE_ASK], [200, { success: true, decision: { id: 'd6', closesAt: '2026-11-06T00:00:00.000Z', effect: 'remove_member' } }]]);
        pressSuspend('A wave of spam from new accounts', 'pw');
        expect(await screen.findByText(TRIP_CODE_ASK.error)).toBeInTheDocument();
        fireEvent.change(await screen.findByTestId('suspend-proof-input'), { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('suspend-proof-confirm'));
        expect(await screen.findByText(/^Suspended\. Members now vote until .+ on removing them/)).toBeInTheDocument();
        await waitFor(() => expect(sent.map((s) => s.body.code)).toEqual([undefined, '123456']));
        expect(sent.every((s) => s.body.reason === 'A wave of spam from new accounts')).toBe(true);
    });
});

describe('Alerts: the owners\' line about pauses (removal S4)', () => {
    const status = (over: Partial<AlertsStatus>): AlertsStatus => ({
        channel: null, channelProblem: null, lastOkAt: null, lastTriedAt: null, failedInARow: 0, error: null, nextTryAt: null,
        waiting: 0, dropped: 0, sentLastHour: 0, hourlyCap: 20, active: [], history: [], ...over,
    });

    it('reads as the node wrote it, counted, and names nobody', async () => {
        const line = '3 members were paused in the last day, by an admin.';
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200, statusText: '',
            json: async () => status({
                recent: [{ key: 'sec.members', title: 'members removed, moved or paused', priority: 3, at: Date.UTC(2026, 9, 30, 1), detail: line }],
                history: [{ key: 'sec.members', title: 'members removed, moved or paused', kind: 'raised', at: Date.UTC(2026, 9, 30, 1), since: Date.UTC(2026, 9, 30, 1), priority: 3, detail: line }],
                acknowledge: true,
            }),
        })));
        render(<AlertsPanel activeNode={{ id: 'node-1', name: 'Node', url: NODE, adminPassword: 'pw' }} />);
        expect((await screen.findAllByText(new RegExp(line.replace(/\./g, '\\.')))).length).toBeGreaterThan(0);
        expect(screen.queryByText(/dave/i)).toBeNull();
    });
});
