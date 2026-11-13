import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ThreatReviewModal, type ThreatItem, type MemberItem } from './ThreatReviewModal';

/**
 * The flag window says WHO, WHAT and the ONE sensible action in plain words (Marty, 4 Nov: "if im going to the trouble of
 * getting a warning and then logging into the backend I dont want my time to be wasted"). Each test below is red on the old
 * window: it showed the raw rule type, a random "Threat ID", words scraped from the description instead of the flag's own
 * list of members, and a `|| 1` count.
 */

const KEY_A = 'aa11bb22cc33dd44ee55ff6677889900aa11bb22';
const KEY_B = 'bb22cc33dd44ee55ff6677889900aa11bb22cc33';
const KEY_C = 'cc33dd44ee55ff6677889900aa11bb22cc33dd44';

const roster: MemberItem[] = [
    { publicKey: KEY_A, callsign: 'Alder' },
    { publicKey: KEY_B, callsign: 'Birch' },
    { publicKey: KEY_C, callsign: 'Cedar' },
];

// A flag whose description names nobody: the members are only in its own list.
const pair: ThreatItem = {
    type: 'isolated_branch',
    severity: 'warning',
    description: 'A branch of 2 invited members who only trade with each other',
    members: [KEY_A, KEY_B],
};

function open(threat: ThreatItem, extra: Partial<React.ComponentProps<typeof ThreatReviewModal>> = {}) {
    return render(<ThreatReviewModal threat={threat} members={roster} onClose={vi.fn()} onFreezePubkeys={vi.fn().mockResolvedValue(undefined)} {...extra} />);
}

// Every type the node's HealthFlag lists (apps/server/src/state-engine.ts), with the heading it reads as and whether Freeze is offered.
const TYPES: Array<{ type: string; heading: string; freeze: boolean; members: string[]; severity: string }> = [
    { type: 'wash_trading', heading: 'Two members trading Beans back and forth', freeze: true, members: [KEY_A, KEY_B], severity: 'alert' },
    { type: 'sybil_ring', heading: 'A tight ring of mostly new accounts', freeze: true, members: [KEY_A, KEY_B, KEY_C], severity: 'critical' },
    { type: 'sybil_funnel', heading: 'Invited accounts sending Beans back to the member who invited them', freeze: true, members: [KEY_A, KEY_B], severity: 'alert' },
    { type: 'isolated_branch', heading: 'A branch of invited members who only trade with each other', freeze: false, members: [KEY_A], severity: 'warning' },
    { type: 'invite_spam', heading: 'A member inviting far more people than usual', freeze: false, members: [KEY_A], severity: 'warning' },
    { type: 'aggregate_spike', heading: 'Beans owed grew fast in one day', freeze: false, members: [], severity: 'alert' },
    { type: 'cohort_velocity', heading: 'New members reached a large credit allowance within two weeks', freeze: false, members: [KEY_A], severity: 'warning' },
    { type: 'delinquency', heading: 'Members who owe Beans have gone quiet', freeze: false, members: [], severity: 'warning' },
    { type: 'watchdog_recovery', heading: 'The server restarted itself after freezing', freeze: false, members: [], severity: 'critical' },
    { type: 'watchdog_down', heading: "The server's watchdog has gone quiet", freeze: false, members: [], severity: 'alert' },
    { type: 'unhandled_rejections', heading: 'Some background jobs on the server failed', freeze: false, members: [], severity: 'warning' },
];

describe('ThreatReviewModal: a flag says who, what, and the one action', () => {
    it.each(TYPES)('$type has a plain heading, never the raw type, and a "What to do" sentence', ({ type, heading, members, severity }) => {
        open({ type, severity, description: 'The node\'s own note.', members });
        expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(heading);
        expect(screen.queryByText(type)).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain(type);
        expect(screen.getByText('What to do')).toBeInTheDocument();
    });

    it.each(TYPES)('$type offers Freeze only where the flag shows real harm (freeze: $freeze)', ({ type, freeze, members, severity }) => {
        open({ type, severity, description: 'The node\'s own note.', members });
        const button = screen.queryByRole('button', { name: /Freeze Accounts/ });
        if (freeze) expect(button).toBeInTheDocument();
        else expect(button).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Dismiss Flag' })).toBeInTheDocument();
    });

    it('a type this manager does not know gets a general heading, never the raw type, and no Freeze', () => {
        open({ type: 'something_new_2027', severity: 'alert', description: 'A note.', members: [KEY_A] });
        expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Something on this server needs a look');
        expect(document.body.textContent).not.toContain('something_new_2027');
        expect(screen.queryByRole('button', { name: /Freeze Accounts/ })).not.toBeInTheDocument();
    });

    it('shows no made-up "Threat ID"', () => {
        const random = vi.spyOn(Math, 'random');
        try {
            open(pair);
            expect(screen.queryByText(/Threat ID/i)).not.toBeInTheDocument();
            expect(document.body.textContent).not.toMatch(/#\d{4}/);
            expect(random).not.toHaveBeenCalled();
        } finally {
            random.mockRestore();
        }
    });

    it('takes the members from the flag\'s own list and shows them by name, never as keys', () => {
        // The description names nobody: scraping it, as the old window did, finds no one.
        open(pair);
        expect(screen.getByText('Members involved (2)')).toBeInTheDocument();
        expect(screen.getByText('Alder')).toBeInTheDocument();
        expect(screen.getByText('Birch')).toBeInTheDocument();
        expect(screen.queryByText('Cedar')).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain(KEY_A);
        expect(document.body.textContent).not.toContain(KEY_B);
        expect(screen.queryByText(/No specific public keys/)).not.toBeInTheDocument();
    });

    it('a member the roster does not know is still shown by a name, not the key', () => {
        const stranger = 'dd44ee55ff6677889900aa11bb22cc33dd44ee55';
        open({ ...pair, members: [stranger] });
        expect(screen.getByText('Members involved (1)')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain(stranger);
    });

    it('the flag\'s list wins over keys scraped from the description', async () => {
        const handleFreeze = vi.fn().mockResolvedValue(undefined);
        open(
            { type: 'wash_trading', severity: 'alert', description: `Pair ${KEY_C} and a decoy`, members: [KEY_A, KEY_B] },
            { onFreezePubkeys: handleFreeze },
        );
        expect(screen.getByText('Members involved (2)')).toBeInTheDocument();
        expect(screen.queryByText('Cedar')).not.toBeInTheDocument();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Freeze Accounts/ })); });
        expect(handleFreeze).toHaveBeenCalledWith([KEY_A, KEY_B]);
    });

    it('a flag with no list still falls back to the keys in its description', () => {
        open({ type: 'wash_trading', severity: 'alert', description: `Wash trading: ${KEY_C}` });
        expect(screen.getByText('Members involved (1)')).toBeInTheDocument();
        expect(screen.getByText('Cedar')).toBeInTheDocument();
    });

    it('counts the members really named: none is none, not one', () => {
        open({ type: 'aggregate_spike', severity: 'alert', description: 'Aggregate credit spike: +12.0B in 24h', members: [] });
        expect(screen.getByText('Members involved (0)')).toBeInTheDocument();
        expect(screen.getByText('This flag names no member.')).toBeInTheDocument();
    });

    // The node's own descriptions for the flags that name nobody (state-engine.ts, as it words them): three carry an ISO time, and the
    // old fallback read that date as a member ("2026 Member") because it ran on an EMPTY list, not only on a missing one.
    it.each([
        ['watchdog_recovery', 'critical', 'Node auto-recovered from 2 event-loop freezes (last: 2026-11-04T10:12:33.000Z) — a hang recurred and the host watchdog restarted the node'],
        ['watchdog_down', 'alert', 'Host watchdog heartbeat is stale (last seen 2026-11-04T09:58:01.000Z) — this node is currently running without freeze auto-recovery'],
        ['unhandled_rejections', 'warning', '3 background tasks failed without being handled since this node last started (last: 2026-11-04T10:12:33.000Z) — the node kept serving'],
    ])('%s names nobody even though its description holds a date: no member is made up from it', (type, severity, description) => {
        const onInspect = vi.fn();
        open({ type, severity, description, members: [] }, { onInspectMember: onInspect });
        expect(screen.getByText('Members involved (0)')).toBeInTheDocument();
        expect(screen.getByText('This flag names no member.')).toBeInTheDocument();
        expect(screen.queryByText(/2026 Member/)).not.toBeInTheDocument();
        expect(onInspect).not.toHaveBeenCalled();
    });

    it('uses plain labels, not the old jargon', () => {
        open({ type: 'wash_trading', severity: 'alert', description: 'Wash trading detected', members: [KEY_A, KEY_B] });
        expect(screen.getByText('What happened')).toBeInTheDocument();
        expect(screen.queryByText(/Inspection Evidence Summary/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Targeted Member Accounts/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Security Telemetry/i)).not.toBeInTheDocument();
    });
});
