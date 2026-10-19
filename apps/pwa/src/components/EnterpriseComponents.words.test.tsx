/**
 * The enterprise's components in the member's language (words S3, web sweep W2): the Decisions block on an enterprise,
 * a project and a chat group (its cards open, passed, failed and too few voted, Yes / No, a vote already cast, the
 * small-roll line, the errors) and both propose forms; an enterprise's card on the Commons in each state; and the
 * keepers' map pin picker with its warnings and errors. Every sentence through t(), the phone's keys (S3h) where the
 * phone says the same. What members wrote (an enterprise's name, purpose and handle, a vote's title and why, names)
 * is shown as written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { splitBold } from '@beanpool/core';
import type { Treasury } from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-w2.test-support';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getEnterpriseDecisions: vi.fn(),
    proposeEnterpriseDecision: vi.fn(async () => ({ success: true })),
    voteEnterpriseDecision: vi.fn(async () => ({ success: true })),
    getGroupDecisions: vi.fn(),
    proposeGroupDecision: vi.fn(async () => ({ success: true })),
    voteGroupDecision: vi.fn(async () => ({ success: true })),
    setEnterpriseLocation: vi.fn(),
    clearEnterpriseLocation: vi.fn(),
}));

import * as api from '../lib/api';
import { EnterpriseDecisions, GroupDecisions } from './EnterpriseDecisions';
import { EnterpriseCard } from './EnterpriseCard';
import { EnterpriseLocationPicker } from './EnterpriseLocationPicker';

const ME = 'b'.repeat(64);
const keepers = [
    { publicKey: 'a'.repeat(64), callsign: 'Ann', role: 'lead' },
    { publicKey: ME, callsign: 'Bob', role: 'keeper' },
    { publicKey: 'c'.repeat(64), callsign: 'Cat', role: 'keeper' },
];
const card = (over: Record<string, unknown> = {}) => ({
    id: 'd1', authorPubkey: 'a'.repeat(64), title: 'Pay Cat for the oven', description: 'Cat fixed the oven door.', effect: 'pay_out',
    subject: 'c'.repeat(64), params: { amount: 40 }, status: 'open', opensAt: new Date().toISOString(),
    closesAt: new Date(Date.now() + 3 * 86400_000 + 60_000).toISOString(), tally: { voted: 1, roll: 3, quorumRequired: 2, thresholdRequired: 0.6 },
    myVote: null, ...over,
});
const closedTally = { voted: 3, roll: 3, quorumRequired: 2, thresholdRequired: 0.6, yes: 2, no: 1 };
/** What the keepers wrote and are called. */
const KEEPERS_WORDS = ['Pay Cat for the oven', 'Cat fixed the oven door.', 'Remove Ann', 'Ann is away for a year.', 'A new oven', 'Ann', 'Bob', 'Cat'];

const people = [
    { pubkey: 'lou', name: 'Lou', role: 'lead' }, { pubkey: 'cyd', name: 'Cyd', role: 'convenor' },
    { pubkey: 'ada', name: 'Ada', role: 'member' }, { pubkey: 'bo', name: 'Bo', role: 'member' }, { pubkey: 'obi', name: 'Obi', role: 'observer' },
];
const groupCard = (over: Record<string, unknown> = {}) => ({
    id: 'g1', authorPubkey: 'bo', title: 'Cyd leads', description: 'Lou has stepped back from the guild.', effect: 'replace_lead_convenor',
    subject: 'cyd', params: null, status: 'open', opensAt: new Date().toISOString(), scopeKind: 'group', scopeId: 'grp',
    closesAt: new Date(Date.now() + 6 * 86400_000 + 60_000).toISOString(), tally: { voted: 2, roll: 4, quorumRequired: 3, thresholdRequired: 0.5 },
    myVote: null, ...over,
});
const GROUP_WORDS = ['Cyd leads', 'Lou has stepped back from the guild.', 'Gone quiet', 'Nobody posts any more.', 'Lou', 'Cyd', 'Ada', 'Bo', 'Obi'];

const said = () => [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent ?? '');

beforeEach(() => {
    vi.mocked(api.getEnterpriseDecisions).mockReset();
    vi.mocked(api.getGroupDecisions).mockReset();
    vi.mocked(api.voteEnterpriseDecision).mockReset().mockResolvedValue({ success: true } as never);
    vi.mocked(api.proposeEnterpriseDecision).mockReset().mockResolvedValue({ success: true } as never);
    vi.mocked(api.proposeGroupDecision).mockReset().mockResolvedValue({ success: true } as never);
    vi.mocked(api.setEnterpriseLocation).mockReset();
    vi.mocked(api.clearEnterpriseLocation).mockReset();
});
afterEach(() => { cleanup(); backToEnglish(); });

describe("an enterprise's Decisions in the pseudo-locale", () => {
    it('the cards (open, passed, failed, too few voted, mine), Yes / No, the small-roll line and a vote that failed to count', async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({
            decisions: [
                card({ canVote: true }),
                card({ id: 'd2', title: 'Remove Ann', description: 'Ann is away for a year.', effect: 'remove_keeper', subject: 'a'.repeat(64), status: 'executed', params: null, tally: closedTally }),
                card({ id: 'd3', title: 'A new oven', description: null, status: 'failed', tally: closedTally, myVote: { support: true } }),
                card({ id: 'd4', title: 'A new oven', description: null, effect: 'replace_lead', subject: 'f'.repeat(64), status: 'unresolved', executionReason: 'Quorum not met (1/3)', tally: closedTally, myVote: { support: 0 } }),
            ] as never,
            canPropose: true, rollSize: 3,
        });
        vi.mocked(api.voteEnterpriseDecision).mockRejectedValue(new Error(''));
        await showIn('xx');
        render(<EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers} balance={120} lifecycle="ongoing" />);
        const block = await screen.findByTestId('enterprise-decisions');
        expect(within(block).getByRole('heading', { level: 3 }).textContent).toBe(xx('DECISIONS'));
        expect(within(block).getByText(xx("Votes among this enterprise's keepers. More than half must vote. 7 days, or sooner once the answer can't change."))).toBeInTheDocument();
        expect(within(block).getByText(xx('You voted Yes.'))).toBeInTheDocument();
        expect(within(block).getByText(xx('You voted No.'))).toBeInTheDocument();
        // A keeper who is no longer on the list: plain words, not a key.
        expect(within(block).getByText(xx('Make {name} the lead keeper').replace('{name}', xx('a member')))).toBeInTheDocument();
        expect(within(block).getByText(xx('Nobody sees who voted how. In a very small group, though, the result and who has voted can show it.'))).toBeInTheDocument();
        expect(within(block).getByRole('button', { name: xx('Vote No on {title}').replace('{title}', 'Pay Cat for the oven') })).toBeInTheDocument();
        fireEvent.click(within(block).getByRole('button', { name: xx('Vote Yes on {title}').replace('{title}', 'Pay Cat for the oven') }));
        expect(await within(block).findByText(xx('Your vote was not counted. Try again in a moment.'))).toBeInTheDocument();
        expect(within(block).getByRole('button', { name: xx('Propose a vote') })).toBeInTheDocument();
        expect(bracketed(block)).toBeGreaterThan(15);
        expect(bypassing(document.body, { others: KEEPERS_WORDS, said: said() })).toEqual([]);
    });

    it("a project's block names its leader and collaborators", async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({ decisions: [card({ effect: 'remove_keeper' })] as never, canPropose: false, rollSize: 6 });
        await showIn('xx');
        render(<EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers} balance={120} lifecycle="bounded" />);
        expect(await screen.findByText(xx("Votes among this project's leader and collaborators. More than half must vote. 7 days, or sooner once the answer can't change."))).toBeInTheDocument();
        expect(bypassing(document.body, { others: KEEPERS_WORDS })).toEqual([]);
    });

    it('the propose form: each effect, the people, the amount and its fee, the wage line, and a vote that was not opened', async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({ decisions: [], canPropose: true, rollSize: 3 });
        vi.mocked(api.proposeEnterpriseDecision).mockRejectedValue(new Error(''));
        await showIn('xx');
        render(<EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers} balance={120} earnedSurplus={100} lifecycle="ongoing" />);
        fireEvent.click(await screen.findByRole('button', { name: xx('Propose a vote') }));
        const form = screen.getByTestId('propose-scoped-decision');
        expect(within(form).getByRole('heading', { level: 4 }).textContent).toBe(xx('Propose a vote'));
        expect(within(form).getByText(xx('Pay whom?'))).toBeInTheDocument();
        expect(within(form).getByText(xx('It holds {n} Beans now.').replace('{n}', '120'))).toBeInTheDocument();
        fireEvent.click(within(form).getByRole('radio', { name: 'Cat' }));
        fireEvent.change(within(form).getByLabelText(xx('How many Beans?')), { target: { value: '121' } });
        expect(bypassing(form, { others: KEEPERS_WORDS })).toEqual([]);
        fireEvent.change(within(form).getByLabelText(xx('How many Beans?')), { target: { value: '40' } });
        expect(within(form).getByTestId('scoped-fee').textContent).toMatch(/^\[Cat /);
        expect(within(form).getByPlaceholderText(xx('Pay Ali for the stall repairs'))).toBeInTheDocument();
        expect(within(form).getByPlaceholderText(xx('Say why, in a sentence or two.'))).toBeInTheDocument();
        fireEvent.change(within(form).getByLabelText(xx('Title')), { target: { value: 'Pay Cat for the oven' } });
        fireEvent.change(within(form).getByLabelText(xx('Why?')), { target: { value: 'Cat fixed the oven door last week.' } });
        await act(async () => { fireEvent.click(within(form).getByRole('button', { name: xx('Open the vote') })); });
        expect(await within(form).findByText(xx('The vote was not opened. Try again in a moment.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: KEEPERS_WORDS, said: said() })).toEqual([]);

        for (const radio of within(form).getAllByRole('radio').filter(r => r.textContent?.startsWith('['))) {
            fireEvent.click(radio);
            expect(bypassing(form, { others: KEEPERS_WORDS })).toEqual([]);
        }
    });

    it('nobody to choose: the line that says so', async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({ decisions: [], canPropose: true, rollSize: 2 });
        await showIn('xx');
        render(<EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers.slice(1, 2)} balance={0} lifecycle="ongoing" />);
        fireEvent.click(await screen.findByRole('button', { name: xx('Propose a vote') }));
        expect(screen.getByText(xx('Nobody on the roll can be chosen for this.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: KEEPERS_WORDS })).toEqual([]);
    });
});

describe("a chat group's Decisions in the pseudo-locale", () => {
    it('the block, an observer\'s line, a name nobody knows, and the propose form with every choice', async () => {
        vi.mocked(api.getGroupDecisions).mockResolvedValue({
            decisions: [groupCard({ canVote: false }), groupCard({ id: 'g2', title: 'Gone quiet', description: 'Nobody posts any more.', effect: 'remove_group_member', subject: 'gone', status: 'passed', tally: closedTally })] as never,
            canPropose: true, rollSize: 4, onRoll: true, watching: true, closedAt: null,
        });
        await showIn('xx');
        render(<GroupDecisions groupId="grp" myPubkey="ada" people={people} joinPolicy="open" />);
        const block = await screen.findByTestId('group-decisions');
        expect(within(block).getByText(xx("Votes among the group's members and convenors; observers watch. More than half must vote. 7 days, or sooner once the answer can't change."))).toBeInTheDocument();
        expect(within(block).getByText(xx("You watch this group, so you see its votes but don't vote."))).toBeInTheDocument();
        expect(within(block).getByText(xx('Remove {name} from the group').replace('{name}', xx('someone in the group')))).toBeInTheDocument();
        expect(bypassing(block, { others: GROUP_WORDS })).toEqual([]);

        fireEvent.click(within(block).getByRole('button', { name: xx('Propose a vote') }));
        const form = screen.getByTestId('propose-group-decision');
        expect(within(form).getByText(xx("The group's members and convenors vote. It runs 7 days, or ends sooner once the answer can't change."))).toBeInTheDocument();
        expect(within(form).getByPlaceholderText(xx('Ada leads the guild'))).toBeInTheDocument();
        const choices = within(form).getAllByRole('radiogroup')[0];
        const labels = within(choices).getAllByRole('radio').map(r => r.textContent ?? '');
        expect(labels.length).toBeGreaterThan(3);
        for (const label of labels) {
            fireEvent.click(within(choices).getByRole('radio', { name: label }));
            expect(bypassing(form, { others: GROUP_WORDS })).toEqual([]);
        }
        expect(within(form).getByText(xx('If it passes, the group takes no new messages, posts or members, and its other open votes end. Its chat stays to read.'))).toBeInTheDocument();
        fireEvent.click(within(choices).getByRole('radio', { name: xx('Change who can join') }));
        expect(within(form).getByText(xx('Who should be able to join?'))).toBeInTheDocument();
        expect(bypassing(form, { others: GROUP_WORDS })).toEqual([]);
    });
});

const treasury = (over: Partial<Treasury> = {}): Treasury => ({
    publicKey: 'ent-1', name: 'Bindarrabi Bakery', callsign: 'bakery', balance: 120, creditLine: 0, liveOffers: 1,
    purpose: 'Bread for the valley, baked at dawn.', keepers: [{ publicKey: 'a', callsign: 'Ann' }, { publicKey: 'b', callsign: 'Bob' }],
    lifecycle: 'ongoing', status: 'active', ...over,
} as Treasury);
const CARD_WORDS = ['Bindarrabi Bakery', 'Bread for the valley, baked at dawn.', '@bakery', 'Seed library'];
/** A deadline the card counts as `d` days left (it rounds a part day up). */
const inDays = (d: number) => new Date(Date.now() + d * 86400_000 - 3600_000).toISOString();

describe("an enterprise's card in the pseudo-locale", () => {
    it('every state: an enterprise, owed and owing, a project raising, funded, paused, winding up, closed, out of time', async () => {
        await showIn('xx');
        render(
            <div>
                <EnterpriseCard treasury={treasury({ earnedSurplus: 30 })} />
                <EnterpriseCard treasury={treasury({ publicKey: 'e2', balance: -1, liveOffers: 3, keepers: [], callsign: undefined, purpose: null })} />
                <EnterpriseCard treasury={treasury({ publicKey: 'e3', name: 'Seed library', lifecycle: 'bounded', goalAmount: 500, currentAmount: 120, deadlineAt: inDays(5) })} />
                <EnterpriseCard treasury={treasury({ publicKey: 'e4', name: 'Seed library', lifecycle: 'bounded', goalAmount: 500, currentAmount: 500, status: 'funded' })} />
                <EnterpriseCard treasury={treasury({ publicKey: 'e5', paused: true, balance: 0 })} />
                <EnterpriseCard treasury={treasury({ publicKey: 'e6', status: 'winding_up' })} />
                <EnterpriseCard treasury={treasury({ publicKey: 'e7', status: 'completed' })} />
                <EnterpriseCard treasury={treasury({ publicKey: 'e8', name: 'Seed library', goalAmount: 500, currentAmount: 20, deadlineAt: new Date(Date.now() - 3 * 86400_000).toISOString() })} />
                <EnterpriseCard treasury={treasury({ publicKey: 'e9', name: 'Seed library', goalAmount: 500, currentAmount: 20, deadlineAt: new Date(Date.now() - 3600_000).toISOString() })} />
            </div>,
        );
        // The line under the name: the handle as its keepers wrote it, then two facts, each a whole sentence.
        expect(screen.getAllByText(`@bakery · ${xx('{n} live offer').replace('{n}', '1')} · ${xx('{n} keepers').replace('{n}', '2')}`).length).toBeGreaterThan(0);
        expect(screen.getByText(xx('{n} live offers').replace('{n}', '3'))).toBeInTheDocument();
        expect(screen.getByText(xx('Community enterprise'))).toBeInTheDocument();
        expect(screen.getByText(xx('They owe us {n} bean of work').replace('{n}', '1'))).toBeInTheDocument();
        expect(screen.getByText(xx('Square — nothing owed either way'))).toBeInTheDocument();
        expect(screen.getByText(xx('in deficit (keepers eat last)'))).toBeInTheDocument();
        expect(screen.getByText(xx('Expired'), { exact: false })).toBeInTheDocument();
        expect(screen.getByText(xx('Ends today'), { exact: false })).toBeInTheDocument();
        expect(screen.getByText(xx('{n} days left').replace('{n}', '5'), { exact: false })).toBeInTheDocument();
        expect(screen.getAllByText(xx('Pledge Beans')).length).toBeGreaterThan(0);
        expect(screen.getByText(xx('Closed'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(30);
        expect(bypassing(document.body, { others: CARD_WORDS })).toEqual([]);
    });
});

const PRIVACY_LINE = 'The flock, shed, or garden is often at someone’s house. Use **Approximate** to round the location to roughly 100 m.';
/**
 * Beside what members wrote: the map's own credits (Leaflet and the OpenStreetMap tiles, names of other projects), and
 * the bold word of the privacy line, whose bracket is its sentence's, around it (BoldWords draws it in a <strong>).
 */
const MAP_OTHERS = ['Leaflet', 'A JavaScript library for interactive maps', '© OpenStreetMap', 'OpenStreetMap', ...splitBold(xx(PRIVACY_LINE)).filter(s => s.bold).map(s => s.text)];

describe("the keepers' map pin picker in the pseudo-locale", () => {
    it('no pin yet, a pin, approximate, out of range, saving, and the node refusing to save or clear', async () => {
        await showIn('xx');
        const onSaved = vi.fn();
        render(<EnterpriseLocationPicker treasury={{ publicKey: 'ent-1', lat: null, lng: null }} onLocationSaved={onSaved} onClose={vi.fn()} />);
        expect(screen.getByText(xx('Enterprise Map Location'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Close location picker') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Zoom in') })).toBeInTheDocument();
        expect(screen.getByText(xx('Lat: {value}').replace('{value}', '—'))).toBeInTheDocument();
        // The privacy line is one sentence, its bold word inside it.
        const privacy = screen.getByTestId('enterprise-location-visibility').querySelectorAll('p')[1];
        expect(privacy.textContent).toBe(splitBold(xx(PRIVACY_LINE)).map(s => s.text).join(''));
        expect(privacy.querySelector('strong')).not.toBeNull();
        expect(screen.getByRole('button', { name: xx('Save Location') })).toBeDisabled();
        expect(bracketed()).toBeGreaterThan(8);
        expect(bypassing(document.body, { others: MAP_OTHERS })).toEqual([]);

        fireEvent.change(screen.getByLabelText(xx('Latitude')), { target: { value: '95' } });
        fireEvent.change(screen.getByLabelText(xx('Longitude')), { target: { value: '153.5' } });
        fireEvent.click(screen.getByRole('button', { name: xx('Save Location') }));
        expect(screen.getByRole('alert').textContent).toBe(xx('Latitude must be between -90 and 90, longitude between -180 and 180'));
        expect(bypassing(document.body, { others: MAP_OTHERS, said: said() })).toEqual([]);

        fireEvent.change(screen.getByLabelText(xx('Latitude')), { target: { value: '-28.54937' } });
        fireEvent.click(screen.getByRole('button', { name: xx('Approximate (~100m)') }));
        expect(screen.getByText(xx('~100m'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Clear Location') })).toBeInTheDocument();
        vi.mocked(api.setEnterpriseLocation).mockReturnValueOnce(new Promise(() => {}));
        fireEvent.click(screen.getByRole('button', { name: xx('Save Location') }));
        expect(await screen.findByRole('button', { name: xx('Saving...') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: MAP_OTHERS })).toEqual([]);
        cleanup();

        vi.mocked(api.setEnterpriseLocation).mockRejectedValueOnce(new Error(''));
        render(<EnterpriseLocationPicker treasury={{ publicKey: 'ent-1', lat: -28.549, lng: 153.501 }} onLocationSaved={onSaved} onClose={vi.fn()} />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('Save Location') })); });
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(xx('Failed to save location')));
        vi.mocked(api.clearEnterpriseLocation).mockRejectedValueOnce(new Error(''));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('Clear Location') })); });
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(xx('Failed to clear location')));
        expect(bypassing(document.body, { others: MAP_OTHERS, said: said() })).toEqual([]);
        expect(onSaved).not.toHaveBeenCalled();
    });
});

describe('the same components in English', () => {
    it('nothing bracketed, and the words as they were', async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({
            decisions: [card({ canVote: true }), card({ id: 'd3', title: 'A new oven', status: 'failed', tally: closedTally, myVote: { support: true } })] as never,
            canPropose: true, rollSize: 3,
        });
        render(
            <div>
                <EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers} balance={120} lifecycle="ongoing" />
                <EnterpriseCard treasury={treasury({ lifecycle: 'bounded', goalAmount: 500, currentAmount: 120, deadlineAt: inDays(2), balance: 2.5 })} />
                <EnterpriseLocationPicker treasury={{ publicKey: 'ent-1', lat: -28.549, lng: 153.501 }} onLocationSaved={vi.fn()} onClose={vi.fn()} />
            </div>,
        );
        const block = await screen.findByTestId('enterprise-decisions');
        expect(bracketed()).toBe(0);
        expect(within(block).getByText("Votes among this enterprise's keepers. More than half must vote. 7 days, or sooner once the answer can't change.")).toBeInTheDocument();
        expect(within(block).getByText('You voted Yes.')).toBeInTheDocument();
        expect(within(block).getAllByText(/^Proposed by Ann · /)[0].textContent).toBe('Proposed by Ann · closes in 3 days');
        expect(within(block).getByRole('button', { name: 'Vote Yes on Pay Cat for the oven' }).textContent).toBe('Yes');
        fireEvent.click(within(block).getByRole('button', { name: 'Propose a vote' }));
        expect(screen.getByText('It holds 120 Beans now.')).toBeInTheDocument();
        expect(screen.getByText('@bakery · 1 live offer · 2 keepers')).toBeInTheDocument();
        expect(screen.getByText('We owe them 2.5 beans of work')).toBeInTheDocument();
        expect(screen.getByText('2 days left', { exact: false }).textContent).toBe('⏳ 2 days left');
        expect(screen.getByText('raised of 500 🫘', { exact: false }).textContent).toBe('120 🫘 raised of 500 🫘');
        expect(screen.getByText('🌱 Project')).toBeInTheDocument();
        expect(screen.getByText('Lat: -28.54900')).toBeInTheDocument();
        expect(screen.getByTestId('enterprise-location-visibility').textContent).toContain('The flock, shed, or garden is often at someone’s house. Use Approximate to round the location to roughly 100 m.');
        expect(within(screen.getByTestId('enterprise-location-visibility')).getByText('Approximate', { selector: 'strong' })).toBeInTheDocument();
    });

    it('one bean, and the person who is you', async () => {
        vi.mocked(api.getGroupDecisions).mockResolvedValue({ decisions: [], canPropose: true, rollSize: 4, onRoll: true, closedAt: null });
        render(
            <div>
                <EnterpriseCard treasury={treasury({ balance: 1 })} />
                <GroupDecisions groupId="grp" myPubkey="ada" people={people} joinPolicy="open" />
            </div>,
        );
        expect(screen.getByText('We owe them 1 bean of work')).toBeInTheDocument();
        fireEvent.click(await screen.findByRole('button', { name: 'Propose a vote' }));
        const form = screen.getByTestId('propose-group-decision');
        // A member may name themself as the new lead: shown with "(you)" after the name, as before.
        fireEvent.click(within(form).getByRole('radio', { name: 'Choose a new lead convenor' }));
        expect(within(form).getByRole('radio', { name: 'Ada (you)' })).toBeInTheDocument();
        expect(within(form).getByRole('radio', { name: 'Cyd' })).toBeInTheDocument();
    });
});
