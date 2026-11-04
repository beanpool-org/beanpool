import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ThreatReviewModal, type ThreatItem, type MemberItem } from './ThreatReviewModal';

/**
 * The flag window says WHO, WHAT and the ONE sensible action in plain words (Marty, 4 Nov: "if im going to the trouble of
 * getting a warning and then logging into the backend I dont want my time to be wasted"). Each test below is red on the old
 * window: it showed the raw rule type, a random "Threat ID", words scraped from the description instead of the flag's own
 * list of members, a `|| 1` count, and a red Freeze for someone who had simply not traded for 30 days.
 */

const KEY_A = 'aa11bb22cc33dd44ee55ff6677889900aa11bb22';
const KEY_B = 'bb22cc33dd44ee55ff6677889900aa11bb22cc33';
const KEY_C = 'cc33dd44ee55ff6677889900aa11bb22cc33dd44';

const roster: MemberItem[] = [
    { publicKey: KEY_A, callsign: 'Alder' },
    { publicKey: KEY_B, callsign: 'Birch' },
    { publicKey: KEY_C, callsign: 'Cedar' },
];

const inactive: ThreatItem = {
    type: 'inactive_member',
    severity: 'info',
    days: 30,
    description: '2 members have not traded Beans for 30+ days',
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
    { type: 'inactive_member', heading: 'Members with no trades for 30 days', freeze: false, members: [KEY_A], severity: 'info' },
    { type: 'isolated_branch', heading: 'A branch of invited members who only trade with each other', freeze: false, members: [KEY_A], severity: 'warning' },
    { type: 'invite_spam', heading: 'A member inviting far more people than usual', freeze: false, members: [KEY_A], severity: 'warning' },
    { type: 'aggregate_spike', heading: 'Beans owed grew fast in one day', freeze: false, members: [], severity: 'alert' },
    { type: 'cohort_velocity', heading: 'New accounts went deep into credit within two weeks', freeze: false, members: [], severity: 'warning' },
    { type: 'delinquency', heading: 'Members who owe Beans have gone quiet', freeze: false, members: [], severity: 'warning' },
    { type: 'watchdog_recovery', heading: 'The server restarted itself after freezing', freeze: false, members: [], severity: 'critical' },
    { type: 'watchdog_down', heading: "The server's watchdog has gone quiet", freeze: false, members: [], severity: 'alert' },
    { type: 'unhandled_rejections', heading: 'Some background jobs on the server failed', freeze: false, members: [], severity: 'warning' },
];

describe('ThreatReviewModal: a flag says who, what, and the one action', () => {
    it.each(TYPES)('$type has a plain heading, never the raw type, and a "What to do" sentence', ({ type, heading, members, severity }) => {
        open({ type, severity, days: 30, description: 'The node\'s own note.', members });
        expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(heading);
        expect(screen.queryByText(type)).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain(type);
        expect(screen.getByText('What to do')).toBeInTheDocument();
    });

    it.each(TYPES)('$type offers Freeze only where the flag shows real harm (freeze: $freeze)', ({ type, freeze, members, severity }) => {
        open({ type, severity, days: 30, description: 'The node\'s own note.', members });
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
            open(inactive);
            expect(screen.queryByText(/Threat ID/i)).not.toBeInTheDocument();
            expect(document.body.textContent).not.toMatch(/#\d{4}/);
            expect(random).not.toHaveBeenCalled();
        } finally {
            random.mockRestore();
        }
    });

    it('takes the members from the flag\'s own list and shows them by name, never as keys', () => {
        // The description names nobody: scraping it, as the old window did, finds no one.
        open(inactive);
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
        open({ ...inactive, members: [stranger] });
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

    it('uses plain labels, not the old jargon', () => {
        open({ type: 'wash_trading', severity: 'alert', description: 'Wash trading detected', members: [KEY_A, KEY_B] });
        expect(screen.getByText('What happened')).toBeInTheDocument();
        expect(screen.queryByText(/Inspection Evidence Summary/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Targeted Member Accounts/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Security Telemetry/i)).not.toBeInTheDocument();
    });
});

describe('ThreatReviewModal: members with no trades are information, not a warning', () => {
    it('offers Dismiss and nothing else: no Freeze, no Export Evidence', () => {
        open(inactive);
        expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Members with no trades for 30 days');
        expect(screen.getByRole('button', { name: 'Dismiss Flag' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Freeze/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Export Evidence/ })).not.toBeInTheDocument();
        expect(screen.queryByText(/Freeze/)).not.toBeInTheDocument();
    });

    it('says "For your information", not a severity, and uses no red', () => {
        const { container } = open(inactive);
        expect(screen.getByText('For your information')).toBeInTheDocument();
        expect(screen.queryByText(/^(critical|alert|warning)$/i)).not.toBeInTheDocument();
        const html = container.innerHTML + document.body.innerHTML;
        expect(html).not.toMatch(/bp-danger|red-9|red-8|red-4|red-3/);
    });

    it('an older node that still sends it as a warning is information too', () => {
        open({ ...inactive, severity: 'warning' });
        expect(screen.getByText('For your information')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Freeze/ })).not.toBeInTheDocument();
    });

    it('says in words that posts and chat are not counted, so nobody freezes over it', () => {
        open(inactive);
        expect(screen.getByText(/Only trades of Beans are counted here/)).toBeInTheDocument();
    });

    it('Dismiss dismisses it', async () => {
        vi.useFakeTimers();
        const handleDismiss = vi.fn();
        try {
            open(inactive, { onDismiss: handleDismiss });
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss Flag' })); });
            act(() => { vi.advanceTimersByTime(1200); });
            expect(handleDismiss).toHaveBeenCalledWith(inactive);
        } finally {
            vi.useRealTimers();
        }
    });
});
