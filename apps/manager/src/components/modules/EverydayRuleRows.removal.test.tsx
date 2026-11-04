/**
 * Who decides a removal, in Triage & Moderation's rules (removal jury J3; EverydayRuleRows, lib/community-shape.ts), and an
 * open jury vote's numbers in the admins' Decisions list (adminTallyLine). The node is stubbed with the shape it serves
 * (apps/server config/community-shape.ts removalDeciderShape): `lock` pool_too_small refuses only A jury.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EverydayRuleRows } from './EverydayRuleRows';
import { adminTallyLine } from '../../lib/node-client';
import type { Shape } from '../../lib/community-shape';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

const NODE: NodeProfile = { id: 'n1', name: 'Mullum', url: 'https://mullum.test', adminPassword: 'pw' };
const OWNER: RolesViewer = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
const ADMIN: RolesViewer = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };
const on = (v: boolean) => ({ value: v, configured: v, source: 'default', lock: null });

function shapeOf(removalDecider: unknown): Shape {
    return {
        kind: 'local', standby: false, version: 1, kindOnly: [], log: [],
        settings: {
            join: { value: 'members', configured: 'members', source: 'default', lock: null, door: 'members' },
            openDoor: on(false), knocks: on(true), preview: on(false), beans: on(true),
            knownFloor: { value: { on: false, floor: 0, cap: 2000, capMax: 5000 }, configured: {}, source: 'default', lock: null },
            dmRequests: on(false), decisions: on(true), listed: on(true),
            shareLocation: on(true), shareMemberCount: on(true), shareEmail: on(false), sharePhone: on(false), shareHealth: on(true),
            visitors: { value: 'nothing', configured: 'nothing', source: 'default', lock: null },
            probation: on(false), autoHide: on(false), autoMute: on(false), connections: on(false),
            ...(removalDecider === undefined ? {} : { removalDecider }),
        } as any,
    } as Shape;
}

function mockApi(shape: Shape) {
    const sent: any[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            sent.push(JSON.parse(String(init.body)));
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ shape, told: 'members' }), clone() { return this; } });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(shape) });
    }));
    return sent;
}

const POOL_TOO_SMALL = {
    code: 'pool_too_small',
    why: 'A jury needs at least 36 members who could serve on it (members for 30 days, not paused or closed), three juries\' worth; 20 could today. Until then everyone decides a removal here.',
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('Who decides a removal, in the rules the server applies', () => {
    it('shows the rule and how many could serve; an owner picks Everyone and is told what the next removal does', async () => {
        const sent = mockApi(shapeOf({ value: 'automatic', configured: 'automatic', source: 'default', lock: null, poolSize: 140 }));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="rules" title="Rules the server applies" />);
        expect(await screen.findByTestId('shape-val-removalDecider')).toHaveTextContent('Automatic');
        expect(screen.getByTestId('shape-row-removalDecider')).toHaveTextContent('140 members could serve on a jury today.');
        fireEvent.click(screen.getByTestId('shape-expand-removalDecider'));
        const radios = screen.getAllByRole('radio');
        expect(radios.map(r => (r as HTMLInputElement).value)).toEqual(['automatic', 'everyone', 'jury']);
        expect(radios.every(r => !(r as HTMLInputElement).disabled)).toBe(true);
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        fireEvent.click(screen.getByRole('radio', { name: /Everyone/ }));
        expect(screen.getByTestId('shape-consequence')).toHaveTextContent('The next removal is decided this way; a vote already open keeps its rule. Every member is told. Today everyone who can vote would decide one (140 could serve on a jury).');
        fireEvent.click(screen.getByRole('radio', { name: /^A jury/ }));
        expect(screen.getByTestId('shape-consequence')).toHaveTextContent('Today a jury of 12 would decide one (140 could serve on a jury).');
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].changes).toEqual({ removalDecider: 'jury' });
    });

    it('from 1,000 who could serve, the consequence names the jury of 18 the draw would seat (core juryRuleFor), never 12', async () => {
        mockApi(shapeOf({ value: 'everyone', configured: 'everyone', source: 'owner', lock: null, poolSize: 1200 }));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="rules" title="Rules the server applies" />);
        expect(await screen.findByTestId('shape-row-removalDecider')).toHaveTextContent('1,200 members could serve on a jury today.');
        fireEvent.click(screen.getByTestId('shape-expand-removalDecider'));
        for (const choice of [/^Automatic/, /^A jury/]) {
            fireEvent.click(screen.getByRole('radio', { name: choice }));
            expect(screen.getByTestId('shape-consequence')).toHaveTextContent('Today a jury of 18 would decide one (1,200 could serve on a jury).');
            expect(screen.getByTestId('shape-consequence')).not.toHaveTextContent(/jury of 12/);
        }
    });

    it("the rules card's Changes lines name the rule as the row does, never the raw value", async () => {
        const shape = shapeOf({ value: 'jury', configured: 'jury', source: 'owner', lock: null, poolSize: 140 });
        shape.log = [{
            id: '1', kept: 'community_settings_log', at: '2026-11-03T09:00:00Z', actor: OWNER.memberPubkey, actorCallsign: 'Ada', actorRole: 'owner',
            setting: 'removalDecider', from: 'automatic', to: 'jury', note: null,
        }];
        mockApi(shape);
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="rules" title="Rules the server applies" />);
        const log = await screen.findByTestId('shape-audit-log');
        expect(log).toHaveTextContent('Who decides a removal: Automatic → A jury');
        expect(log).not.toHaveTextContent(/automatic → jury/);
    });

    it('while fewer than 36 could serve, the row still opens and only A jury is held back, with the lock\'s words', async () => {
        const sent = mockApi(shapeOf({ value: 'automatic', configured: 'automatic', source: 'default', lock: POOL_TOO_SMALL, poolSize: 20 }));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="rules" title="Rules the server applies" />);
        expect(await screen.findByTestId('shape-lock-removalDecider')).toHaveTextContent(/A jury needs at least 36 members who could serve on it/);
        fireEvent.click(screen.getByTestId('shape-expand-removalDecider'));
        expect(screen.getByRole('radio', { name: /^A jury/ })).toBeDisabled();
        expect(screen.getByRole('radio', { name: /Everyone/ })).toBeEnabled();
        fireEvent.click(screen.getByRole('radio', { name: /Everyone/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].changes).toEqual({ removalDecider: 'everyone' });
    });

    it('an admin reads it and cannot open it; a node from before the jury shows no row', async () => {
        mockApi(shapeOf({ value: 'everyone', configured: 'everyone', source: 'owner', lock: null, poolSize: 140 }));
        const { unmount } = render(<EverydayRuleRows activeNode={NODE} viewer={ADMIN} group="rules" title="Rules the server applies" />);
        expect(await screen.findByTestId('shape-val-removalDecider')).toHaveTextContent('Everyone');
        fireEvent.click(screen.getByTestId('shape-expand-removalDecider'));
        expect(screen.queryAllByRole('radio')).toHaveLength(0);
        unmount();
        mockApi(shapeOf(undefined));
        render(<EverydayRuleRows activeNode={NODE} viewer={OWNER} group="rules" title="Rules the server applies" />);
        expect(await screen.findByTestId('shape-row-autoMute')).toBeInTheDocument();
        expect(screen.queryByTestId('shape-row-removalDecider')).toBeNull();
    });
});

describe("the admins' Decisions list", () => {
    it('counts an open jury\'s jurors, never an undefined split', () => {
        const open = { totalVoters: 7, electorate: 12, quorumRequired: 9, quorumMet: false, thresholdRequired: 2 / 3, decider: 'jury', turnout: { voted: 7, size: 12, mustVote: 9 } } as any;
        expect(adminTallyLine(open, 'open')).toBe('7 of 12 jurors have voted · 9 must vote · how they voted stays hidden until it closes');
        expect(adminTallyLine(open, 'open')).not.toMatch(/undefined|NaN/);
        const plain = { totalVoters: 4, electorate: 20, quorumRequired: 6, quorumMet: false, yesWeight: 3, noWeight: 1, supportRatio: 0.75, thresholdRequired: 0.66 };
        expect(adminTallyLine(plain, 'open')).toBe('4 of 6 votes needed · Yes 3 · No 1');
        expect(adminTallyLine({ ...open, yesWeight: 9, noWeight: 1, supportRatio: 0.9 }, 'execution_pending_grace')).toBe('7 of 9 votes needed · Yes 9 · No 1');
    });
});
