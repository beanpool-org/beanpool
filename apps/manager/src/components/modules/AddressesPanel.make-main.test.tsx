/**
 * Settings → Addresses, several addresses S6 (design scratch/fable-design/DESIGN-several-addresses-fable.md §2.1, §7, §8):
 * Make main on every row the server can make main, of any kind, through the one route that moves the main
 * (POST /api/local/admin/app-addresses/main), after the design's question, with the owner's fresh proof; the question
 * before adding an address; the way-back line under an own-domain main; the line that says what members' phones follow.
 *
 * The table: row kind × current main × the owner's fresh proof (present, stale, missing) → allowed / asks / refused.
 * The server's own word on each row (`mainRefusal`, apps/server routes/app-addresses.ts) decides whether the row offers
 * Make main at all: a press that can only be refused is not offered.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AddressesPanel, offersMakeMain } from './AddressesPanel';
import type { AppAddress, AppAddressesReport } from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';

const node: NodeProfile = { id: 'riverside-node', name: 'Riverside', url: 'http://localhost:8080', automationToken: 'test-token' };

const NUMBER_BESIDE_NAME = '203.0.113.5 is a number, and this community has a name. A number stops working when the server changes, so a name stays the main address.';

type Kind = 'beanpool' | 'domain' | 'number' | 'hand-set';
const ROW: Record<Kind, AppAddress> = {
    beanpool: { address: 'riverside.beanpool.org', source: 'registrar', today: 3, busiestDay: 5 },
    domain: { address: 'coop.example.org', source: 'owner', today: 1, busiestDay: 2 },
    number: { address: '203.0.113.5', source: 'owner', today: 0, busiestDay: 1 },
    // Set by hand on the server (BEANPOOL_ADDRESSES): the design lets a hand-set name be main too.
    'hand-set': { address: 'set.example.net', source: 'env', today: 0, busiestDay: 0 },
};
const MAIN: Record<'a name' | 'own domain' | 'a number', AppAddress> = {
    'a name': { address: 'hill.beanpool.org', source: 'public-address', today: 9, busiestDay: 12 },
    'own domain': { address: 'main.example.org', source: 'owner', today: 9, busiestDay: 12 },
    'a number': { address: '198.51.100.7', source: 'owner', today: 9, busiestDay: 12 },
};
type Proof = 'present' | 'stale' | 'missing';

/** What the server says of a candidate beside `main`: a number is never main while the community has a name. */
function serverRow(kind: Kind, main: keyof typeof MAIN): AppAddress {
    const row = { ...ROW[kind] };
    if (kind === 'number' && main !== 'a number') row.mainRefusal = NUMBER_BESIDE_NAME;
    return row;
}

function reportOf(main: keyof typeof MAIN, rows: AppAddress[]): AppAddressesReport {
    const all = [MAIN[main], ...rows];
    return {
        primaryAddress: MAIN[main].address,
        named: true,
        addresses: all,
        unconfirmed: [],
        heldBack: [],
        unboundSignaturesUntil: null,
        unboundSignaturesAccepted: false,
        list: { main: MAIN[main].address, addresses: all.map((a) => a.address).sort() },
    };
}

/** The route a request names, whatever proxy prefix the manager puts before it (resolveNodeApiUrl). */
const routeOf = (u: string) => { const p = new URL(u, 'http://x').pathname; return p.slice(p.indexOf('/api/')); };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const STALE = { error: 'Press Manage on your phone again, then make this change within 90 seconds.', code: 'step_up_required' };
const MISSING = { error: 'Do this from your phone: open BeanPool, press Manage, then make this change there.', code: 'phone_required', phoneRequired: true };

/** A node: the report, the /main route answering as the proof says, anything else empty. Every POST is recorded. */
function stubNode(report: AppAddressesReport, mainAnswer: () => [number, unknown]) {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
        const u = String(url);
        if (opts?.method === 'POST') {
            const body = JSON.parse(String(opts.body || '{}'));
            const path = routeOf(u);
            posts.push({ path, body });
            if (path === '/api/local/admin/app-addresses/main') return json(...mainAnswer());
            return json(404, { error: 'not here' });
        }
        if (u.includes('/app-addresses')) return json(200, report);
        return json(200, { logs: [], names: [], notices: [] });
    });
    return { posts };
}

/** The design's question (§8), as the dialog's title and body. */
const QUESTION_TITLE = (address: string) => `Make ${address} the main address?`;
const QUESTION_BODY = "New members, invites, the directory and search engines are sent there. Members' phones follow by themselves, usually within a day. Every other address keeps working. People on the web stay where they are and are shown the new address.";

describe('Addresses S6: Make main, the table (row kind × current main × fresh proof)', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    const cases: Array<{ kind: Kind; main: keyof typeof MAIN; proof: Proof; want: 'allowed' | 'asks' | 'refused' }> = [];
    for (const kind of ['beanpool', 'domain', 'number', 'hand-set'] as Kind[]) {
        for (const main of ['a name', 'own domain', 'a number'] as Array<keyof typeof MAIN>) {
            for (const proof of ['present', 'stale', 'missing'] as Proof[]) {
                const serverRefuses = !!serverRow(kind, main).mainRefusal;
                cases.push({ kind, main, proof, want: serverRefuses || proof === 'missing' ? 'refused' : proof === 'stale' ? 'asks' : 'allowed' });
            }
        }
    }

    it.each(cases)('$kind row, main is $main, proof $proof → $want', async ({ kind, main, proof, want }) => {
        const row = serverRow(kind, main);
        const before = reportOf(main, [row]);
        const after = { ...reportOf(main, [row]), primaryAddress: row.address };
        let answered = false;
        const { posts } = stubNode(before, () => {
            answered = true;
            if (proof === 'stale') return [403, STALE];
            if (proof === 'missing') return [403, MISSING];
            return [200, after];
        });
        render(<AddressesPanel activeNode={node} />);
        await screen.findByTestId(`address-row-${row.address}`);

        if (row.mainRefusal) {
            // The server says it can't be main: no button, nothing sent.
            expect(screen.queryByTestId(`make-main-btn-${row.address}`)).not.toBeInTheDocument();
            expect(posts).toHaveLength(0);
            expect(want).toBe('refused');
            return;
        }

        fireEvent.click(screen.getByTestId(`make-main-btn-${row.address}`));
        const dialog = await screen.findByRole('alertdialog');
        expect(within(dialog).getByText(QUESTION_TITLE(row.address))).toBeInTheDocument();
        expect(within(dialog).getByText(QUESTION_BODY)).toBeInTheDocument();
        expect(posts).toHaveLength(0);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Make main' }));

        await waitFor(() => expect(answered).toBe(true));
        // One route moves the main, whatever the kind: never a claim, never the own-address route.
        expect(posts).toEqual([{ path: '/api/local/admin/app-addresses/main', body: { address: row.address } }]);

        if (want === 'allowed') {
            expect(await screen.findByTestId('addresses-action-message')).toHaveTextContent(`${row.address} is now the main address.`);
            expect(screen.queryByTestId(/^address-proof-/)).not.toBeInTheDocument();
        } else if (want === 'asks') {
            expect(await screen.findByTestId('address-proof-step-up')).toHaveTextContent('Press Manage on your phone again, then make this change within 90 seconds.');
            expect(screen.queryByText(`${row.address} is now the main address.`)).not.toBeInTheDocument();
        } else {
            expect(await screen.findByTestId('address-proof-phone')).toHaveTextContent('Do this from your phone: open BeanPool, press Manage, then make this change there.');
            expect(screen.queryByText(`${row.address} is now the main address.`)).not.toBeInTheDocument();
        }
    });
});

describe('Addresses S6: Make main, around the table', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('offersMakeMain: any kind the server can make main, never the main itself, a former or lost name, or a row the server refuses', () => {
        const at = (over: Partial<AppAddress>) => ({ address: 'riverside.beanpool.org', source: 'registrar' as const, today: 0, busiestDay: 0, ...over });
        expect(offersMakeMain(at({}), 'hill.beanpool.org')).toBe(true);
        expect(offersMakeMain(at({ address: 'coop.example.org', source: 'owner' }), 'hill.beanpool.org')).toBe(true);
        expect(offersMakeMain(at({ address: 'set.example.net', source: 'env' }), 'hill.beanpool.org')).toBe(true);
        expect(offersMakeMain(at({ source: 'public-address', hardCoded: true }), 'coop.example.org')).toBe(true);
        expect(offersMakeMain(at({ address: '198.51.100.9', source: 'owner' }), '198.51.100.7')).toBe(true);
        expect(offersMakeMain(at({}), 'riverside.beanpool.org')).toBe(false);
        expect(offersMakeMain(at({ former: true }), 'hill.beanpool.org')).toBe(false);
        expect(offersMakeMain(at({ former: true, lost: true }), 'hill.beanpool.org')).toBe(false);
        expect(offersMakeMain(at({ mainRefusal: 'riverside.beanpool.org has no route yet (waiting for approval, or paused). It can be made main once it is live.' }), 'hill.beanpool.org')).toBe(false);
    });

    it('Cancel on the question sends nothing', async () => {
        const report = reportOf('a name', [ROW.domain]);
        const { posts } = stubNode(report, () => [200, report]);
        render(<AddressesPanel activeNode={node} />);
        fireEvent.click(await screen.findByTestId('make-main-btn-coop.example.org'));
        fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
        await new Promise((r) => setTimeout(r, 10));
        expect(posts).toHaveLength(0);
    });

    it('a refusal at the press (the server changed its mind) says the server\'s words, never success', async () => {
        const report = reportOf('a name', [ROW.domain]);
        stubNode(report, () => [409, { code: 'not_main_able', error: 'coop.example.org has no route yet (waiting for approval, or paused). It can be made main once it is live.' }]);
        render(<AddressesPanel activeNode={node} />);
        fireEvent.click(await screen.findByTestId('make-main-btn-coop.example.org'));
        fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Make main' }));
        const message = await screen.findByTestId('addresses-action-message');
        expect(message).toHaveTextContent('coop.example.org has no route yet');
        expect(message).not.toHaveTextContent('is now the main address');
    });

    it('an admin sees no Make main on any row: changing the main is an owner\'s', async () => {
        const report = reportOf('a name', [ROW.domain, ROW.beanpool]);
        stubNode(report, () => [200, report]);
        render(<AddressesPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'ab'.repeat(32), role: 'admin' }} />);
        await screen.findByTestId('address-row-coop.example.org');
        expect(screen.queryByTestId(/^make-main-btn-/)).not.toBeInTheDocument();
    });

    it('under an own-domain main, a BeanPool name on the list is the way back if the domain lapses', async () => {
        stubNode(reportOf('own domain', [ROW.beanpool]), () => [200, {}]);
        render(<AddressesPanel activeNode={node} />);
        expect(await screen.findByTestId('addresses-way-back')).toHaveTextContent('Keep riverside.beanpool.org as well: it is the way back if the domain ever lapses.');
    });

    it('a BeanPool name with no route yet is no way back: the line names one that works, or none', async () => {
        const waiting = { ...ROW.beanpool, address: 'waiting.beanpool.org', mainRefusal: 'waiting.beanpool.org has no route yet (waiting for approval, or paused). It can be made main once it is live.' };
        stubNode(reportOf('own domain', [waiting, ROW.beanpool]), () => [200, {}]);
        const { unmount } = render(<AddressesPanel activeNode={node} />);
        expect(await screen.findByTestId('addresses-way-back')).toHaveTextContent('Keep riverside.beanpool.org as well');
        unmount();
        vi.restoreAllMocks();
        stubNode(reportOf('own domain', [waiting]), () => [200, {}]);
        render(<AddressesPanel activeNode={node} />);
        await screen.findByTestId('address-row-waiting.beanpool.org');
        expect(screen.queryByTestId('addresses-way-back')).not.toBeInTheDocument();
    });

    // S6 round 2 (#3240's deciding review): the server refuses Make main on a name the address service says another community
    // holds, while the record still says live (apps/server engine/own-addresses.ts mainAddressRefusal; test-address-list 6b,
    // test-rename-main-name section 9). These are its words, as the report and /main both give them; the manager adds none.
    const HELD_ELSEWHERE = (a: string) => `The address service says another community holds ${a}, so it can't be the main address: new members and invites sent there could reach that community instead.`;

    it('a BeanPool name another community holds (the server\'s word on the row) offers no Make main and is no way back', async () => {
        const heldElsewhere: AppAddress = {
            ...ROW.beanpool,
            standing: { state: 'at-risk', registrarSays: 'other', releasedOn: null, acceptedUntil: null, leadsHere: false, lostSince: null, why: null, checkedAt: '2026-11-16T06:00:00.000Z' },
            mainRefusal: HELD_ELSEWHERE(ROW.beanpool.address),
        };
        expect(offersMakeMain(heldElsewhere, MAIN['own domain'].address)).toBe(false);
        stubNode(reportOf('own domain', [heldElsewhere, ROW.domain]), () => [200, {}]);
        render(<AddressesPanel activeNode={node} />);
        await screen.findByTestId('address-row-riverside.beanpool.org');
        expect(screen.queryByTestId('make-main-btn-riverside.beanpool.org')).not.toBeInTheDocument();
        expect(screen.getByTestId('make-main-btn-coop.example.org')).toBeInTheDocument();
        expect(screen.queryByTestId('addresses-way-back')).not.toBeInTheDocument();
    });

    it('the address service turned while the screen was open: the press shows the server\'s sentence as it is, never success', async () => {
        const report = reportOf('own domain', [ROW.beanpool]);
        const sentence = HELD_ELSEWHERE(ROW.beanpool.address);
        const { posts } = stubNode(report, () => [409, { code: 'not_main_able', error: sentence }]);
        render(<AddressesPanel activeNode={node} />);
        fireEvent.click(await screen.findByTestId('make-main-btn-riverside.beanpool.org'));
        fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Make main' }));
        const message = await screen.findByTestId('addresses-action-message');
        expect(message).toHaveTextContent(sentence);
        expect(message).not.toHaveTextContent('is now the main address');
        expect(posts).toEqual([{ path: '/api/local/admin/app-addresses/main', body: { address: 'riverside.beanpool.org' } }]);
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('no way-back line under a BeanPool name main, or with no BeanPool name listed', async () => {
        stubNode(reportOf('a name', [ROW.beanpool]), () => [200, {}]);
        const { unmount } = render(<AddressesPanel activeNode={node} />);
        await screen.findByTestId('address-row-riverside.beanpool.org');
        expect(screen.queryByTestId('addresses-way-back')).not.toBeInTheDocument();
        unmount();
        vi.restoreAllMocks();
        stubNode(reportOf('own domain', [ROW.domain]), () => [200, {}]);
        render(<AddressesPanel activeNode={node} />);
        await screen.findByTestId('address-row-coop.example.org');
        expect(screen.queryByTestId('addresses-way-back')).not.toBeInTheDocument();
    });

    it('one line says what members\' phones follow: the signed list\'s count and main', async () => {
        stubNode(reportOf('a name', [ROW.domain, ROW.beanpool]), () => [200, {}]);
        render(<AddressesPanel activeNode={node} />);
        expect(await screen.findByTestId('addresses-follow-line')).toHaveTextContent("Members' phones follow this list: 3 addresses, main hill.beanpool.org.");
    });
});

describe('Addresses S6: the question before adding an address', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it.each([
        { kind: 'a free BeanPool name', type: (v: string) => fireEvent.change(screen.getByPlaceholderText('e.g. cairns'), { target: { value: v } }), typed: 'riverside', address: 'riverside.beanpool.org', path: '/api/local/admin/public-address/claim' },
        { kind: "this server's number", type: (v: string) => fireEvent.change(screen.getByPlaceholderText('e.g. 203.0.113.5'), { target: { value: v } }), typed: '203.0.113.5', address: '203.0.113.5', path: '/api/local/admin/public-address/own' },
        { kind: 'your own domain', type: (v: string) => fireEvent.change(screen.getByPlaceholderText('e.g. beans.example.org'), { target: { value: v } }), typed: 'coop.example.org', address: 'coop.example.org', path: '/api/local/admin/public-address/own' },
    ])('$kind: asks first, sends nothing on Cancel, then sends once on yes', async ({ kind, type, typed, address, path }) => {
        const report = reportOf('a name', []);
        const posts: string[] = [];
        vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
            const u = String(url);
            if (opts?.method === 'POST') {
                posts.push(routeOf(u));
                return json(200, { success: true, status: 'live', address, communityAddress: false });
            }
            if (u.includes('/app-addresses')) return json(200, report);
            return json(200, { logs: [], names: [], notices: [] });
        });
        render(<AddressesPanel activeNode={node} />);
        fireEvent.click(await screen.findByTestId('addresses-add-address-btn'));
        fireEvent.click(screen.getByRole('button', { name: kind }));
        type(typed);
        fireEvent.submit(screen.getByTestId('claim-form'));
        const ask = await screen.findByRole('alertdialog');
        expect(ask).toHaveTextContent(`Members' phones will trust ${address} as this community once it answers with this server's key, and people can sign in on the web there. Only add an address you control.`);
        fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
        await new Promise((r) => setTimeout(r, 10));
        expect(posts).toHaveLength(0);

        fireEvent.submit(screen.getByTestId('claim-form'));
        fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Add it' }));
        await waitFor(() => expect(posts).toEqual([path]));
    });
});
