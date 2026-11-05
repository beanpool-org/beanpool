import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The place search is the shared Nominatim lookup; the tests answer it themselves.
vi.mock('@beanpool/core', async (orig) => {
    const real = await orig<typeof import('@beanpool/core')>();
    return {
        ...real,
        createAddressLookup: (opts: { onState: (s: unknown) => void }) => ({
            input: () => opts.onState({ status: 'done', results: [{ displayName: 'Mullumbimby NSW, Australia', lat: -28.55, lng: 153.5 }] }),
            dispose: () => {},
        }),
    };
});

import { CommunityShapeSection } from './CommunityShapeSection';
import { CORE_SETTINGS, typedWordFor, type Shape, type ShapeSettings } from '../../lib/community-shape';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

const NODE: NodeProfile = { id: 'n1', name: 'Mullum', url: 'https://mullum.test', adminPassword: 'pw' };
const OWNER_KEY: RolesViewer = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
const ADMIN_KEY: RolesViewer = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };

const LOCK = { at: '2026-11-03T10:00:00.000Z', by: 'o'.repeat(64), byCallsign: 'ada' };

function shapeWith(over: { core?: Shape['core'] | null; settings?: Partial<ShapeSettings>; kind?: 'local' | 'global' } = {}): Shape {
    const settings = {
        join: { value: 'members', configured: 'members', source: 'default', lock: null, door: 'members' },
        openDoor: { value: false, configured: false, source: 'default', lock: null },
        knocks: { value: true, configured: true, source: 'default', lock: null },
        preview: { value: false, configured: false, source: 'server', lock: null },
        beans: { value: true, configured: true, source: 'default', lock: null, includes: { escrow: true, enterprises: true, treasuries: true, crowdfund: true } },
        knownFloor: { value: { on: true, floor: 1000, cap: 2000, capMax: 5000 }, configured: { on: true, floor: 1000, cap: 2000, capMax: 5000 }, source: 'default', lock: null },
        decisions: { value: true, configured: true, source: 'default', lock: null },
        shareOutside: { value: true, configured: true, source: 'default', lock: null },
        recoveryCopies: { value: 'vault', configured: 'vault', source: 'default', lock: null },
        listed: { value: true, configured: true, source: 'default', lock: null },
        shareLocation: { value: true, configured: true, source: 'default', lock: null },
        shareMemberCount: { value: true, configured: true, source: 'default', lock: null },
        shareEmail: { value: false, configured: false, source: 'default', lock: null },
        sharePhone: { value: false, configured: false, source: 'default', lock: null },
        shareHealth: { value: true, configured: true, source: 'default', lock: null },
        visitors: { value: 'nothing', configured: 'nothing', source: 'default', lock: null },
        probation: { value: false, configured: false, source: 'default', lock: null },
        autoHide: { value: false, configured: false, source: 'default', lock: null },
        autoMute: { value: false, configured: false, source: 'default', lock: null },
        connections: { value: false, configured: false, source: 'server', lock: null },
        ...over.settings,
    } as unknown as ShapeSettings;
    return {
        kind: over.kind ?? 'local',
        standby: false,
        version: 1,
        settings,
        kindOnly: [],
        log: [],
        ...(over.core === null ? {} : { core: over.core ?? { settings: [...CORE_SETTINGS], lock: null, place: { needed: true, set: true } } }),
    };
}

type Reply = { ok: boolean; status: number; body: unknown };
/** GET answers the shape; each POST answers the next reply in the list (the last repeats), and every body is kept. */
function mockApi(shape: Shape, posts: Reply[] = []) {
    const sent: { url: string; body: any }[] = [];
    let n = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            sent.push({ url, body: JSON.parse(String(init.body)) });
            const r = posts[Math.min(n++, posts.length - 1)] ?? { ok: true, status: 200, body: { shape, told: 'nobody' } };
            return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body), clone() { return this; } });
        }
        if (url.includes('/api/local/admin/community-shape')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(shape) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, sent };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('Core settings — the lib holds the server list', () => {
    it('the page lists the settings the server calls Core', () => {
        expect([...CORE_SETTINGS]).toEqual(['join', 'wordsDoor', 'beans', 'knownFloor', 'memberGift', 'decisions', 'shareOutside', 'recoveryCopies']);
    });
    it('the three one-way changes have their typed words, and nothing else has one', () => {
        expect(typedWordFor('beans', false)).toBe('off');
        expect(typedWordFor('shareOutside', false)).toBe('stop');
        expect(typedWordFor('recoveryCopies', 'none')).toBe('nowhere');
        expect(typedWordFor('beans', true)).toBeNull();
        expect(typedWordFor('shareOutside', true)).toBeNull();
        expect(typedWordFor('recoveryCopies', 'server')).toBeNull();
        expect(typedWordFor('decisions', false)).toBeNull();
        expect(typedWordFor('join', 'admins')).toBeNull();
    });
});

describe('Core settings — locked: Unlock to change', () => {
    const locked = () => shapeWith({ core: { settings: [...CORE_SETTINGS], lock: LOCK, place: { needed: true, set: true } } });

    it('an owner sees the lock line, no chevron and one Unlock button on every Core row', async () => {
        mockApi(locked());
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByText('🧭');
        for (const id of ['join', 'beans', 'knownFloor', 'decisions', 'shareOutside', 'recoveryCopies']) {
            const row = screen.getByTestId(`shape-row-${id}`);
            expect(within(row).getAllByRole('button')).toHaveLength(1);
            expect(within(row).getByRole('button', { name: 'Unlock to change' })).toBeInTheDocument();
            expect(screen.getByTestId(`shape-core-lock-${id}`)).toHaveTextContent('Locked since 3 Nov 2026 by @ada. Unlock to change: it asks for your proof, and every owner is told.');
            // The header is not a button: no chevron, nothing opens by tapping the row.
            expect(within(row).queryByText('›')).toBeNull();
        }
        expect(screen.queryByTestId('core-unconfirmed-banner')).toBeNull();
    });

    it('an admin reads the lock line and has no Unlock button', async () => {
        mockApi(locked());
        render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
        await screen.findByText('🧭');
        expect(screen.getByTestId('shape-core-lock-beans')).toHaveTextContent('Locked since 3 Nov 2026 by @ada. Only an owner unlocks it; you can advise them below.');
        expect(screen.queryByRole('button', { name: 'Unlock to change' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    it('a row a server lock holds shows the server\'s line and no Unlock button', async () => {
        const shape = locked();
        shape.settings.beans.lock = { code: 'ledger_moved', why: "Can't be turned off: Beans have moved here (12 completed trades)." };
        mockApi(shape);
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByText('🧭');
        expect(screen.getByTestId('shape-lock-beans')).toHaveTextContent('Beans have moved here');
        expect(within(screen.getByTestId('shape-row-beans')).queryByRole('button', { name: 'Unlock to change' })).toBeNull();
        expect(within(screen.getByTestId('shape-row-decisions')).getByRole('button', { name: 'Unlock to change' })).toBeInTheDocument();
    });

    it('Unlock opens the row; a password owner is asked a code, and the save carries it', async () => {
        const after = locked();
        const { sent } = mockApi(locked(), [
            { ok: false, status: 401, body: { error: 'This change asks for a current code.', totpRequired: true } },
            { ok: true, status: 200, body: { shape: after, told: 'members' } },
        ]);
        render(<CommunityShapeSection activeNode={NODE} viewer={{ kind: 'password' }} />);
        await screen.findByText('🧭');
        fireEvent.click(within(screen.getByTestId('shape-row-decisions')).getByRole('button', { name: 'Unlock to change' }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Community votes active/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        // The first save carries no code; the server asks, and the box opens.
        const input = await screen.findByTestId('fresh-proof-input');
        expect(sent[0].body.code).toBeUndefined();
        expect(sent[0].body.changes).toEqual({ decisions: false });
        fireEvent.change(input, { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('fresh-proof-confirm'));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved, and every member is told.'));
        expect(sent).toHaveLength(2);
        expect(sent[1].body.changes).toEqual({ decisions: false });
        expect(sent[1].body.code).toBe('123456');
        // The group is locked again at once: the next row still says Unlock to change.
        expect(screen.queryByTestId('fresh-proof-input')).toBeNull();
        expect(within(screen.getByTestId('shape-row-beans')).getByRole('button', { name: 'Unlock to change' })).toBeInTheDocument();
    });

    it('a phone hand-off past its 90 seconds is told to press Manage again, and nothing is saved', async () => {
        const { sent } = mockApi(locked(), [
            { ok: false, status: 403, body: { error: 'Press Manage again.', code: 'step_up_required' } },
        ]);
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByText('🧭');
        fireEvent.click(within(screen.getByTestId('shape-row-decisions')).getByRole('button', { name: 'Unlock to change' }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Community votes active/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByTestId('fresh-proof-step-up')).toHaveTextContent('Press Manage on your phone again, then make this change within 90 seconds.');
        expect(sent).toHaveLength(1);
    });

    it('the three one-way changes wait for their typed word before Save works', async () => {
        const cases: Array<[string, () => void, string]> = [
            ['beans', () => fireEvent.click(screen.getByRole('checkbox', { name: /Beans active/ })), 'off'],
            ['shareOutside', () => fireEvent.click(screen.getByRole('checkbox', { name: /Let members share a post outside/ })), 'stop'],
            ['recoveryCopies', () => fireEvent.click(screen.getByRole('radio', { name: /Nowhere/ })), 'nowhere'],
        ];
        for (const [id, change, word] of cases) {
            const { sent } = mockApi(locked(), [{ ok: true, status: 200, body: { shape: locked(), told: 'members' } }]);
            const { unmount } = render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
            await screen.findByText('🧭');
            fireEvent.click(within(screen.getByTestId(`shape-row-${id}`)).getByRole('button', { name: 'Unlock to change' }));
            // No word asked until the one-way choice is made.
            expect(screen.queryByTestId('shape-typed-word')).toBeNull();
            change();
            expect(screen.getByLabelText(new RegExp(`Type ${word} to confirm`))).toBeInTheDocument();
            const save = screen.getByRole('button', { name: 'Save' });
            expect(save).toBeDisabled();
            fireEvent.change(screen.getByTestId('shape-typed-word'), { target: { value: 'wrong' } });
            expect(save).toBeDisabled();
            fireEvent.change(screen.getByTestId('shape-typed-word'), { target: { value: word } });
            expect(save).not.toBeDisabled();
            fireEvent.click(save);
            await waitFor(() => expect(sent).toHaveLength(1));
            unmount();
            vi.unstubAllGlobals();
        }
    });

    it('a change that is not one-way asks no typed word', async () => {
        mockApi(locked());
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByText('🧭');
        fireEvent.click(within(screen.getByTestId('shape-row-decisions')).getByRole('button', { name: 'Unlock to change' }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Community votes active/ }));
        expect(screen.queryByTestId('shape-typed-word')).toBeNull();
        expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    });

    it('the log draws the lock and the unlock in words', async () => {
        const shape = locked();
        shape.log = [
            { id: '3', kept: 'community_settings_log', at: '2026-11-03T11:00:00.000Z', actor: 'o'.repeat(64), actorCallsign: 'ada', actorRole: 'owner', setting: 'beans', from: 'on', to: 'off', note: null },
            { id: '2', kept: 'community_settings_log', at: '2026-11-03T11:00:00.000Z', actor: 'o'.repeat(64), actorCallsign: 'ada', actorRole: 'owner', setting: 'core.unlock', from: null, to: 'beans', note: null },
            { id: '1', kept: 'community_settings_log', at: '2026-11-03T10:00:00.000Z', actor: 'o'.repeat(64), actorCallsign: 'ada', actorRole: 'owner', setting: 'core.lock', from: null, to: 'locked', note: null },
        ];
        mockApi(shape);
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        const log = await screen.findByTestId('shape-audit-log');
        expect(log).toHaveTextContent('🔒 Core settings confirmed and locked');
        expect(log).toHaveTextContent('🔓 Unlocked Beans');
        expect(log).toHaveTextContent('Beans: On → Off');
    });

    it('the log names the members\' credit-line gift in words, as its row does, never its key (G1, round 2)', async () => {
        const shape = locked();
        const by = { kept: 'community_settings_log' as const, at: '2026-11-05T11:00:00.000Z', actor: 'o'.repeat(64), actorCallsign: 'ada', actorRole: 'owner', note: null };
        shape.log = [
            { ...by, id: '3', setting: 'memberGift', from: '100', to: '0' },
            { ...by, id: '2', setting: 'core.unlock', from: null, to: 'memberGift' },
            { ...by, id: '1', setting: 'advice.memberGift', from: null, to: null, actorRole: 'admin', note: 'Keep it on' },
        ];
        mockApi(shape);
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        const log = await screen.findByTestId('shape-audit-log');
        expect(log).toHaveTextContent('Members giving part of their credit line: On · up to 100 Beans → Off');
        expect(log).toHaveTextContent('🔓 Unlocked Members giving part of their credit line');
        expect(log).toHaveTextContent('💬 Advised the owners about Members giving part of their credit line');
        expect(log.textContent).not.toContain('memberGift');
    });
});

describe('Core settings — not confirmed yet: offered, never forced', () => {
    it('an owner sees the banner, and the rows still open and save as before (no proof, no lock)', async () => {
        const { sent } = mockApi(shapeWith());
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByText('🧭');
        expect(screen.getByTestId('core-unconfirmed-banner')).toHaveTextContent('Not confirmed yet.');
        expect(screen.queryByRole('button', { name: 'Unlock to change' })).toBeNull();
        fireEvent.click(screen.getByTestId('shape-expand-decisions'));
        fireEvent.click(screen.getByRole('checkbox', { name: /Community votes active/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].body.code).toBeUndefined();
    });

    it('an admin sees a grey line and no button', async () => {
        mockApi(shapeWith());
        render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
        await screen.findByText('🧭');
        expect(screen.getByTestId('core-unconfirmed-admin')).toHaveTextContent("The owners haven't confirmed the core settings yet. You can read them and advise.");
        expect(screen.queryByTestId('core-walk-start')).toBeNull();
    });

    it('a server from before core settings shows no banner and no walkthrough', async () => {
        mockApi(shapeWith({ core: null }));
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} openWalkthrough="walk" />);
        await screen.findByText('🧭');
        expect(screen.queryByTestId('core-unconfirmed-banner')).toBeNull();
        expect(screen.queryByTestId('core-walkthrough')).toBeNull();
    });
});

describe('Core settings — the walkthrough', () => {
    const walk = async (shape: Shape = shapeWith(), start: 'walk' | 'review' = 'walk') => {
        const api = mockApi(shape, [{ ok: true, status: 200, body: { shape: { ...shape, core: { ...shape.core!, lock: LOCK } }, told: 'nobody' } }]);
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} openWalkthrough={start} />);
        await screen.findByTestId('core-walkthrough');
        return api;
    };
    const next = () => fireEvent.click(screen.getByTestId('walk-next'));

    it('walks the steps one setting each, with the community\'s choices pre-chosen, and Confirm and lock sends only lock: true', async () => {
        const { sent } = await walk();
        const seen: string[] = [];
        for (let i = 0; i < 9; i++) {
            const w = screen.getByTestId('core-walkthrough');
            seen.push(w.getAttribute('data-step')!);
            if (w.getAttribute('data-step') === 'review') break;
            // The default is chosen on each card that has a choice.
            if (w.getAttribute('data-step') === 'join') expect(screen.getByRole('radio', { name: /Invite: any member invites/ })).toBeChecked();
            if (w.getAttribute('data-step') === 'beans') expect(screen.getAllByRole('radio', { name: /^On/ })[0]).toBeChecked();
            if (w.getAttribute('data-step') === 'recoveryCopies') expect(screen.getAllByRole('radio')[0]).toBeChecked(); // the key vault, first of the three
            next();
        }
        expect(seen).toEqual(['intro', 'join', 'beans', 'knownFloor', 'decisions', 'shareOutside', 'recoveryCopies', 'review']);
        expect(sent).toHaveLength(0); // nothing is written until the last step
        fireEvent.click(screen.getByTestId('walk-confirm'));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Locked. From now on each change asks you to unlock it first, and every owner is told.'));
        expect(sent).toHaveLength(1);
        expect(sent[0].body.lock).toBe(true);
        expect(sent[0].body.changes).toEqual({});
        // The page now shows its locked state.
        expect(within(screen.getByTestId('shape-row-beans')).getByRole('button', { name: 'Unlock to change' })).toBeInTheDocument();
    });

    it('Leave for now writes nothing and keeps the offer up', async () => {
        const { sent } = await walk();
        next();
        fireEvent.click(screen.getByRole('radio', { name: /Known: only admins invite/ }));
        fireEvent.click(screen.getByTestId('walk-leave'));
        expect(screen.queryByTestId('core-walkthrough')).toBeNull();
        expect(screen.getByTestId('core-unconfirmed-banner')).toBeInTheDocument();
        expect(sent).toHaveLength(0);
    });

    it('sends only what the owner changed, and skips the known floor when Beans go off', async () => {
        const { sent } = await walk();
        next(); // join
        fireEvent.click(screen.getByRole('radio', { name: /Known: only admins invite/ }));
        expect(screen.getByTestId('walk-consequence')).toHaveTextContent(/Members will stop being able to make invites/);
        next(); // beans
        const off = screen.getAllByRole('radio').find((r) => r.closest('label')?.textContent?.startsWith('Off'))!;
        fireEvent.click(off);
        expect(screen.getByText("Off now, you can turn Beans on later. On, you can't turn them off once anyone has traded.")).toBeInTheDocument();
        next(); // decisions: the known floor step is gone
        expect(screen.getByTestId('core-walkthrough').getAttribute('data-step')).toBe('decisions');
        for (let i = 0; i < 4; i++) { if (screen.getByTestId('core-walkthrough').getAttribute('data-step') !== 'review') next(); }
        fireEvent.click(screen.getByTestId('walk-confirm'));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].body).toMatchObject({ lock: true, changes: { join: 'admins', beans: false } });
        expect(Object.keys(sent[0].body.changes).sort()).toEqual(['beans', 'join']);
    });

    it('Beans off now, On chosen: the known floor is the owner\'s to choose, not held by today\'s beans_off lock', async () => {
        const beansOff = shapeWith({ settings: {
            beans: { value: false, configured: false, source: 'default', lock: null, includes: { escrow: true, enterprises: true, treasuries: true, crowdfund: true } } as any,
            knownFloor: { value: { on: false, floor: 1000, cap: 2000, capMax: 5000 }, configured: { on: false, floor: 1000, cap: 2000, capMax: 5000 }, source: 'default', lock: { code: 'beans_off', why: 'Beans are off, so there is no floor.' } } as any,
        } });
        const { sent } = await walk(beansOff);
        next(); next(); // intro → join → beans
        expect(screen.getByTestId('core-walkthrough').getAttribute('data-step')).toBe('beans');
        const on = screen.getAllByRole('radio').find((r) => r.closest('label')?.textContent?.startsWith('On'))!;
        fireEvent.click(on);
        next(); // the known floor step is there now
        expect(screen.getByTestId('core-walkthrough').getAttribute('data-step')).toBe('knownFloor');
        expect(screen.queryByTestId('walk-held-knownFloor')).toBeNull();
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.change(screen.getByLabelText(/Known floor \(Beans\)/), { target: { value: '500' } });
        for (let i = 0; i < 5; i++) { if (screen.getByTestId('core-walkthrough').getAttribute('data-step') !== 'review') next(); }
        expect(screen.getByTestId('walk-review-knownFloor')).not.toHaveTextContent('Set by this server');
        fireEvent.click(screen.getByTestId('walk-confirm'));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].body.lock).toBe(true);
        expect(sent[0].body.changes).toEqual({ beans: true, knownFloor: { on: true, floor: 500, cap: 2000 } });
    });

    it('Beans off and left off: no known floor step, and the review does not list one', async () => {
        const beansOff = shapeWith({ settings: {
            beans: { value: false, configured: false, source: 'default', lock: null, includes: { escrow: true, enterprises: true, treasuries: true, crowdfund: true } } as any,
            knownFloor: { value: { on: false, floor: 1000, cap: 2000, capMax: 5000 }, configured: { on: false, floor: 1000, cap: 2000, capMax: 5000 }, source: 'default', lock: { code: 'beans_off', why: 'Beans are off, so there is no floor.' } } as any,
        } });
        await walk(beansOff, 'review');
        expect(screen.queryByTestId('walk-review-knownFloor')).toBeNull();
    });

    it('the known floor step checks its limits before Next', async () => {
        await walk();
        next(); next(); next(); // intro → join → beans → known floor
        expect(screen.getByTestId('core-walkthrough').getAttribute('data-step')).toBe('knownFloor');
        expect(screen.getByTestId('walk-floor-hours')).toHaveTextContent('1,000 Beans is about 25 hours');
        fireEvent.change(screen.getByLabelText(/Known floor \(Beans\)/), { target: { value: '4000' } });
        expect(screen.getByRole('alert')).toHaveTextContent("The known floor can't be more than the cap.");
        expect(screen.getByTestId('walk-next')).toBeDisabled();
    });

    it('the review shows the members\' credit-line gift as it stands, so Confirm and lock never locks it unseen (G1)', async () => {
        const gift = (configured: number) => shapeWith({ settings: { memberGift: { value: configured, configured, source: 'owner', lock: null } } as never });
        const { sent } = await walk(gift(40), 'review');
        expect(screen.getByTestId('walk-review-memberGift')).toHaveTextContent('On · up to 40 Beans');
        fireEvent.click(screen.getByTestId('walk-confirm'));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].body.changes).toEqual({});
        cleanup();
        await walk(gift(0), 'review');
        expect(screen.getByTestId('walk-review-memberGift')).toHaveTextContent('Off');
    });

    it('a community with members opens at the review, with today\'s values, and confirms without a change', async () => {
        const { sent } = await walk(shapeWith(), 'review');
        expect(screen.getByTestId('core-walkthrough').getAttribute('data-step')).toBe('review');
        expect(screen.getByTestId('walk-review-join')).toHaveTextContent('Invite: any member invites');
        expect(screen.getByTestId('walk-review-beans')).toHaveTextContent('On');
        expect(screen.getByTestId('walk-through-them')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('walk-confirm'));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].body.changes).toEqual({});
        expect(sent[0].body.lock).toBe(true);
    });

    it('a setting a server lock holds is listed as set by this server, with no choice and no change sent', async () => {
        const shape = shapeWith({ kind: 'global', settings: { join: { value: 'open', configured: 'open', source: 'server', door: 'members', lock: { code: 'profile', why: 'The global community has an open door.' } } as any } });
        const { sent } = await walk(shape, 'review');
        expect(screen.getByTestId('walk-review-join')).toHaveTextContent('Set by this server');
        fireEvent.click(screen.getByTestId('walk-confirm'));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].body.changes).toEqual({});
    });

    it('the node\'s place is mandatory on a local community: no Confirm until it is set, and it is saved first', async () => {
        const shape = shapeWith({ core: { settings: [...CORE_SETTINGS], lock: null, place: { needed: true, set: false } } });
        const { sent } = await walk(shape);
        next(); // → place
        expect(screen.getByTestId('core-walkthrough').getAttribute('data-step')).toBe('place');
        expect(screen.getByTestId('walk-next')).toBeDisabled();
        fireEvent.change(screen.getByTestId('walk-place-search'), { target: { value: 'Mullum' } });
        fireEvent.click(await screen.findByTestId('walk-place-result'));
        expect(screen.getByTestId('walk-place-chosen')).toHaveTextContent('Mullumbimby NSW, Australia');
        for (let i = 0; i < 9 && screen.getByTestId('core-walkthrough').getAttribute('data-step') !== 'review'; i++) next();
        fireEvent.click(screen.getByTestId('walk-confirm'));
        await waitFor(() => expect(sent).toHaveLength(2));
        expect(sent[0].url).toContain('/api/local/admin/node/config');
        expect(sent[0].body.serviceRadius).toEqual({ lat: -28.55, lng: 153.5, radiusKm: 0 });
        expect(sent[1].body.lock).toBe(true);
    });

    it('with no place the review cannot confirm (open at the review), and says why', async () => {
        const shape = shapeWith({ core: { settings: [...CORE_SETTINGS], lock: null, place: { needed: true, set: false } } });
        const { sent } = await walk(shape, 'review');
        expect(screen.getByTestId('walk-confirm')).toBeDisabled();
        expect(screen.getByTestId('walk-place-needed')).toHaveTextContent('Set where your community is first');
        expect(sent).toHaveLength(0);
    });

    it('the global kind needs no place', async () => {
        const shape = shapeWith({ kind: 'global', core: { settings: [...CORE_SETTINGS], lock: null, place: { needed: false, set: false } } });
        await walk(shape, 'review');
        expect(screen.getByTestId('walk-confirm')).not.toBeDisabled();
    });

    it('a refusal from the server is shown and nothing is claimed locked', async () => {
        mockApi(shapeWith(), [{ ok: false, status: 409, body: { error: 'The core settings are already confirmed and locked.', code: 'core_locked' } }]);
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} openWalkthrough="review" />);
        await screen.findByTestId('core-walkthrough');
        fireEvent.click(screen.getByTestId('walk-confirm'));
        expect(await screen.findByTestId('walk-error')).toHaveTextContent('already confirmed and locked');
        expect(screen.queryByRole('status')).toBeNull();
    });
});

describe('Core settings — the menu\'s "!" is told only what it means', () => {
    const calls = (shape: Shape, viewer: RolesViewer) => {
        mockApi(shape);
        const seen: boolean[] = [];
        render(<CommunityShapeSection activeNode={NODE} viewer={viewer} onUnconfirmedChange={(u) => seen.push(u)} />);
        return seen;
    };

    it('an owner whose core settings are not confirmed yet: true', async () => {
        const seen = calls(shapeWith(), OWNER_KEY);
        await screen.findByText('🧭');
        expect(seen).toEqual([true]);
    });

    it('an owner whose core settings are locked: false', async () => {
        const seen = calls(shapeWith({ core: { settings: [...CORE_SETTINGS], lock: LOCK, place: { needed: true, set: true } } }), OWNER_KEY);
        await screen.findByText('🧭');
        expect(seen).toEqual([false]);
    });

    it('an admin never has the badge, however unconfirmed', async () => {
        const seen = calls(shapeWith(), ADMIN_KEY);
        await screen.findByText('🧭');
        expect(seen).toEqual([false]);
    });

    it('an owner on a standby, or on a server from before core settings, never has it', async () => {
        const standby = calls({ ...shapeWith(), standby: true }, OWNER_KEY);
        await screen.findByText('🧭');
        expect(standby).toEqual([false]);
        cleanup();
        const old = calls(shapeWith({ core: null }), OWNER_KEY);
        await screen.findByText('🧭');
        expect(old).toEqual([false]);
    });

    it('locking in the walkthrough clears it', async () => {
        const shape = shapeWith();
        mockApi(shape, [{ ok: true, status: 200, body: { shape: { ...shape, core: { ...shape.core!, lock: LOCK } }, told: 'nobody' } }]);
        const seen: boolean[] = [];
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} openWalkthrough="review" onUnconfirmedChange={(u) => seen.push(u)} />);
        await screen.findByTestId('core-walkthrough');
        fireEvent.click(screen.getByTestId('walk-confirm'));
        await waitFor(() => expect(seen.at(-1)).toBe(false));
        expect(seen[0]).toBe(true);
    });
});

describe('Core settings — an admin advises the owners (C4)', () => {
    const locked = () => shapeWith({ core: { settings: [...CORE_SETTINGS], lock: LOCK, place: { needed: true, set: true } } });
    const CORE_ROWS = ['join', 'beans', 'knownFloor', 'decisions', 'shareOutside', 'recoveryCopies'];
    const adviceLine = (note: string, id = '9') => ({
        id, kept: 'community_settings_log' as const, at: '2026-11-04T01:00:00.000Z', actor: 'a'.repeat(64), actorCallsign: 'ada', actorRole: 'admin',
        setting: 'advice.beans', from: null, to: null, note,
    });

    it('an admin has one Advise the owners button on every Core row, locked or not, and never an Unlock or a Save', async () => {
        for (const shape of [locked(), shapeWith()]) {
            mockApi(shape);
            render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
            await screen.findByText('🧭');
            for (const id of CORE_ROWS) {
                const row = screen.getByTestId(`shape-row-${id}`);
                expect(within(row).getAllByRole('button')).toHaveLength(1);
                expect(within(row).getByRole('button', { name: 'Advise the owners' })).toBeInTheDocument();
            }
            expect(screen.queryByRole('button', { name: 'Unlock to change' })).toBeNull();
            expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
            cleanup();
        }
    });

    it('an owner never sees it (they have Unlock to change), and nor does an admin on a standby', async () => {
        mockApi(locked());
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByText('🧭');
        expect(screen.queryByRole('button', { name: 'Advise the owners' })).toBeNull();
        cleanup();
        mockApi({ ...locked(), standby: true });
        render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
        await screen.findByText('🧭');
        expect(screen.queryByRole('button', { name: 'Advise the owners' })).toBeNull();
        // The lock line does not promise advice a standby can't take.
        expect(screen.getByTestId('shape-core-lock-beans')).toHaveTextContent('Locked since 3 Nov 2026 by @ada. Only an owner unlocks it.');
        expect(screen.getByTestId('shape-core-lock-beans')).not.toHaveTextContent('advise');
    });

    it('opens a box for 200 characters, Send waits for words, and Cancel sends nothing', async () => {
        const { sent } = mockApi(locked());
        render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
        await screen.findByText('🧭');
        fireEvent.click(within(screen.getByTestId('shape-row-beans')).getByRole('button', { name: 'Advise the owners' }));
        const box = screen.getByLabelText('Your advice about Beans');
        expect(box).toHaveAttribute('maxlength', '200');
        expect(screen.getByTestId('shape-advise-count-beans')).toHaveTextContent('0 of 200');
        expect(screen.getByTestId('shape-advise-send-beans')).toBeDisabled();
        fireEvent.change(box, { target: { value: '   ' } });
        expect(screen.getByTestId('shape-advise-send-beans')).toBeDisabled();
        fireEvent.change(box, { target: { value: 'Keep Beans on' } });
        expect(screen.getByTestId('shape-advise-count-beans')).toHaveTextContent('13 of 200');
        expect(screen.getByTestId('shape-advise-send-beans')).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByTestId('shape-advise-form-beans')).toBeNull();
        expect(within(screen.getByTestId('shape-row-beans')).getByRole('button', { name: 'Advise the owners' })).toBeInTheDocument();
        expect(sent).toHaveLength(0);
    });

    it('Send posts the setting and the advice, shows the line in Changes, and says every owner is told', async () => {
        const shape = locked();
        const reply = { ...shape, log: [adviceLine('Keep Beans on: the market needs them.')] };
        const { sent } = mockApi(shape, [{ ok: true, status: 200, body: { shape: reply, told: 'owners' } }]);
        render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
        await screen.findByText('🧭');
        expect(screen.getByText('No changes recorded yet.')).toBeInTheDocument();
        fireEvent.click(within(screen.getByTestId('shape-row-beans')).getByRole('button', { name: 'Advise the owners' }));
        fireEvent.change(screen.getByLabelText('Your advice about Beans'), { target: { value: '  Keep Beans on: the market needs them.  ' } });
        fireEvent.click(screen.getByTestId('shape-advise-send-beans'));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].url).toContain('/api/local/admin/community-shape/advice');
        expect(sent[0].body).toMatchObject({ setting: 'beans', advice: 'Keep Beans on: the market needs them.' });
        expect(Object.keys(sent[0].body).sort()).toEqual(['advice', 'password', 'setting']);
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sent. Every owner is told, and your words are under Changes below.'));
        const log = screen.getByTestId('shape-audit-log');
        expect(log).toHaveTextContent('@ada (admin) · 💬 Advised the owners about Beans · “Keep Beans on: the market needs them.”');
        expect(screen.queryByTestId('shape-advise-form-beans')).toBeNull();
    });

    it('the log line names the setting as the page does, for each Core setting, for an owner too', async () => {
        const shape = locked();
        shape.log = ['join', 'knownFloor', 'shareOutside', 'recoveryCopies'].map((s, i) => ({ ...adviceLine(`about ${s}`, String(i + 1)), setting: `advice.${s}` }));
        mockApi(shape);
        render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByText('🧭');
        const log = screen.getByTestId('shape-audit-log');
        expect(log).toHaveTextContent('💬 Advised the owners about Who can join · “about join”');
        expect(log).toHaveTextContent('💬 Advised the owners about Known floor for confirmed members · “about knownFloor”');
        expect(log).toHaveTextContent('💬 Advised the owners about Members may share listings outside the community · “about shareOutside”');
        expect(log).toHaveTextContent("💬 Advised the owners about Where members' copies go · “about recoveryCopies”");
    });

    it('the advice is drawn as text only: markup in it is never markup, and nothing in it is acted on', async () => {
        const shape = locked();
        const hostile = '<img src=x onerror="document.title=\'pwned\'"> <script>document.title=\'pwned\'</script> <b>bold</b> &amp; {{x}}';
        shape.log = [adviceLine(hostile)];
        mockApi(shape);
        const { container } = render(<CommunityShapeSection activeNode={NODE} viewer={OWNER_KEY} />);
        await screen.findByText('🧭');
        const log = screen.getByTestId('shape-audit-log');
        expect(log.textContent).toContain(hostile);
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('script')).toBeNull();
        expect(container.querySelector('b')).toBeNull();
        expect(document.title).not.toBe('pwned');
        // And what an admin types into the box goes out as text and comes back drawn as text.
        cleanup();
        const empty = locked();
        const { sent } = mockApi(empty, [{ ok: true, status: 200, body: { shape: { ...empty, log: [adviceLine(hostile)] }, told: 'owners' } }]);
        const second = render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
        await screen.findByText('🧭');
        fireEvent.click(within(screen.getByTestId('shape-row-beans')).getByRole('button', { name: 'Advise the owners' }));
        fireEvent.change(screen.getByLabelText('Your advice about Beans'), { target: { value: hostile } });
        fireEvent.click(screen.getByTestId('shape-advise-send-beans'));
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].body.advice).toBe(hostile);
        await waitFor(() => expect(screen.getByTestId('shape-audit-log').textContent).toContain(hostile));
        expect(second.container.querySelector('img')).toBeNull();
        expect(second.container.querySelector('script')).toBeNull();
    });

    it("a refusal shows the server's sentence, keeps what was typed and writes no line", async () => {
        const shape = locked();
        const { sent } = mockApi(shape, [{ ok: false, status: 429, body: { error: 'That is 10 pieces of advice in a day. Send the next one tomorrow, or tell the owners another way. Nothing was saved.', code: 'advice_limit', setting: 'beans' } }]);
        render(<CommunityShapeSection activeNode={NODE} viewer={ADMIN_KEY} />);
        await screen.findByText('🧭');
        fireEvent.click(within(screen.getByTestId('shape-row-beans')).getByRole('button', { name: 'Advise the owners' }));
        fireEvent.change(screen.getByLabelText('Your advice about Beans'), { target: { value: 'One more' } });
        fireEvent.click(screen.getByTestId('shape-advise-send-beans'));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Send the next one tomorrow'));
        expect(sent).toHaveLength(1);
        expect(screen.getByLabelText('Your advice about Beans')).toHaveValue('One more');
        expect(screen.getByText('No changes recorded yet.')).toBeInTheDocument();
        expect(screen.queryByRole('status')).toBeNull();
    });
});
