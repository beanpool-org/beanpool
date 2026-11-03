import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReadyForTheHallCard } from './ReadyForTheHallCard';
import * as nodeClient from '../../lib/node-client';
import { readHallNotes, writeHallNote } from '../../lib/hall-ready';
import type { DiagnosticsResponse, OwnerWordsCheck, StandbyHealthBanner, TakeoverStatus } from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return { ...actual, fetchTakeoverStatus: vi.fn(), getOwnerWordsChecks: vi.fn(), getTfaSessionToken: vi.fn(() => undefined) };
});

const manualApi = { openManual: vi.fn() };
let manualPresent = true;
vi.mock('../manual/Manual', () => ({ useManual: () => (manualPresent ? manualApi : null) }));

const node: NodeProfile = { id: 'n1', name: 'Test', url: 'https://test.beanpool.org', adminPassword: 'pw' };
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 3600_000;

const baseDiag = (standbyHealth: StandbyHealthBanner | null | undefined, apk?: DiagnosticsResponse['apk']): DiagnosticsResponse => ({
    status: 'healthy', uptimeSeconds: 1, cpuLoadPercent: 1, memoryUsageMb: 1, totalMemoryMb: 1, dbSizeBytes: 1, walSizeBytes: 1,
    activeWsConnections: 0, p2pActivePeers: 0, communityName: 'Test', callsign: null, standbyHealth, ...(apk !== undefined ? { apk } : {}),
});
const goodHealth: StandbyHealthBanner = {
    incident: null,
    standbys: [{ id: 's1', label: 'The standby at 203.0.113.9', lastPullAt: NOW - MIN, lastCopyAt: NOW - 2 * MIN, lastExactAt: NOW - 2 * MIN, healthy: true, paired: 'this' }],
};
const status = (over: Partial<TakeoverStatus> = {}): TakeoverStatus => ({
    state: 'sealed', message: 'ok', envelopeId: 'e1', sealedAt: null, sealReason: null,
    recipients: { owners: [], codes: [] }, skippedOwners: [], recoveryCode: { codeId: 3, createdAt: '2026-10-02T09:00:00.000Z' }, ...over,
});
const owner = (callsign: string, checked: number | null): OwnerWordsCheck => ({ pubkey: callsign, callsign, wordsCheckedAt: checked });
const twoOwners = [owner('anna', NOW - DAY), owner('ben', NOW - 10 * DAY)];

function renderCardNow(props: { diag?: DiagnosticsResponse | null; viewer?: RolesViewer; isStandby?: boolean } = {}) {
    return render(
        <div style={{ width: 320 }}>
            <ReadyForTheHallCard activeNode={node} diag={props.diag === undefined ? baseDiag(goodHealth) : props.diag} viewer={props.viewer} isStandby={props.isStandby} />
        </div>,
    );
}
/** Rendered, and waited for until this node has answered both of its own routes, so no update lands after the test. */
async function renderCard(props: { diag?: DiagnosticsResponse | null; viewer?: RolesViewer; isStandby?: boolean } = {}) {
    const r = renderCardNow(props);
    if (screen.queryByTestId('ready-for-the-hall')) {
        await waitFor(() => {
            expect(textOf('code')).not.toBe('Reading from this server…');
            expect(textOf('owners')).not.toBe('Reading from this server…');
        });
    }
    return r;
}
const line = (id: string) => screen.getByTestId(`hall-line-${id}`);
const textOf = (id: string) => screen.getByTestId(`hall-text-${id}`).textContent;

describe('ReadyForTheHallCard (Settings → Backups & Restore)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        localStorage.clear();
        manualPresent = true;
        vi.mocked(nodeClient.fetchTakeoverStatus).mockResolvedValue(status());
        vi.mocked(nodeClient.getOwnerWordsChecks).mockResolvedValue({ owners: twoOwners });
    });
    afterEach(() => vi.useRealTimers());

    it('shows each checklist line with its date and its state, and counts only the ready ones', async () => {
        await renderCard();
        await waitFor(() => expect(line('code').getAttribute('data-state')).toBe('ok'));
        await waitFor(() => expect(line('owners').getAttribute('data-state')).toBe('ok'));
        // Nothing the owner has not noted, and nothing the node does not carry yet, is ticked.
        expect(['image', 'copy', 'code', 'owners', 'download', 'apk', 'drill'].map((id) => line(id).getAttribute('data-state')))
            .toEqual(['amber', 'ok', 'ok', 'ok', 'amber', 'amber', 'amber']);
        expect(textOf('copy')).toBe('Last copy 2 minutes ago.');
        expect(textOf('code')).toMatch(/^Recovery code #3, made /);
        expect(textOf('owners')).toMatch(/^2 of 2 owners checked their 12 words in the last year\. The oldest check: .+\.$/);
        expect(textOf('apk')).toBe('The APK is not on this node yet.');
        expect(screen.getByTestId('hall-summary').textContent).toBe('3 of 7 ready.');
    });

    it('reads a standby\'s last copy from the node\'s standby watch, and goes amber when it is a day old', async () => {
        const old: StandbyHealthBanner = { incident: null, standbys: [{ ...goodHealth.standbys[0], lastCopyAt: NOW - 30 * 3600_000 }] };
        await renderCard({ diag: baseDiag(old) });
        await waitFor(() => expect(line('copy').getAttribute('data-state')).toBe('amber'));
        expect(textOf('copy')).toMatch(/^Last copy 30 hours ago \(.+\)\.$/);
    });

    it('with no standby yet, the copy line is amber and the pairing steps are open', async () => {
        await renderCard({ diag: baseDiag({ incident: null, standbys: [] }) });
        await waitFor(() => expect(line('copy').getAttribute('data-state')).toBe('amber'));
        expect(textOf('copy')).toBe('No standby has copied this server yet.');
        const steps = screen.getByTestId('hall-pair-steps');
        expect(steps.textContent).toMatch(/NODE_ROLE=backup/);
        expect(steps.textContent).toMatch(/docker compose exec beanpool-node beanpool pair/);
        expect(steps.textContent).toMatch(/Replication Access/);
        expect(steps.textContent).toMatch(/Never type the code on the command line/);
    });

    it('the pairing steps stay closed while the standby is fine, and open and close on the button', async () => {
        await renderCard();
        const toggle = screen.getByRole('button', { name: /Pair this laptop as the standby/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByTestId('hall-pair-steps')).toBeNull();
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('hall-pair-steps')).toBeTruthy();
        fireEvent.click(toggle);
        expect(screen.queryByTestId('hall-pair-steps')).toBeNull();
    });

    it('the open steps lead to the manual\'s "A standby server" page, which exists today', async () => {
        await renderCard({ diag: baseDiag({ incident: null, standbys: [] }) });
        fireEvent.click(screen.getByRole('button', { name: /More in the manual: A standby server/ }));
        expect(manualApi.openManual).toHaveBeenCalledWith('backups-and-replicas');
        const { OPERATOR_MANUAL } = await import('../../lib/manual');
        expect(OPERATOR_MANUAL.guides.some((g) => g.slug === 'backups-and-replicas')).toBe(true);
    });

    it('"Go to Replication Access" brings that card into view', async () => {
        const target = document.createElement('div');
        target.id = 'replication-access-panel';
        const scroll = vi.fn();
        target.scrollIntoView = scroll;
        document.body.appendChild(target);
        try {
            await renderCard({ diag: baseDiag({ incident: null, standbys: [] }) });
            fireEvent.click(screen.getByRole('button', { name: 'Go to Replication Access' }));
            expect(scroll).toHaveBeenCalledTimes(1);
        } finally {
            target.remove();
        }
    });

    it('says the APK is on this node once the node says so, and not before', async () => {
        const a = await renderCard({ diag: baseDiag(goodHealth, { version: '1.2.96', versionCode: 318, size: 168_000_000 }) });
        await waitFor(() => expect(line('apk').getAttribute('data-state')).toBe('ok'));
        expect(textOf('apk')).toMatch(/Version 1\.2\.96 is on this node/);
        a.unmount();
        await renderCard({ diag: baseDiag(goodHealth, null) });
        expect(line('apk').getAttribute('data-state')).toBe('amber');
    });

    it('a line waiting on the node says it is reading: not amber, not ready', () => {
        vi.mocked(nodeClient.fetchTakeoverStatus).mockReturnValue(new Promise(() => {}));
        vi.mocked(nodeClient.getOwnerWordsChecks).mockReturnValue(new Promise(() => {}));
        renderCardNow({ diag: null });
        for (const id of ['copy', 'code', 'owners', 'apk']) {
            expect(line(id).getAttribute('data-state')).toBe('unknown');
            expect(textOf(id)).toBe('Reading from this server…');
        }
    });

    it('a node that cannot be read for the code or the owners says "cannot tell", never ready', async () => {
        vi.mocked(nodeClient.fetchTakeoverStatus).mockRejectedValue(new Error('HTTP 404'));
        vi.mocked(nodeClient.getOwnerWordsChecks).mockRejectedValue(new Error('Failed to fetch'));
        await renderCard();
        await waitFor(() => expect(textOf('code')).toBe('Could not read this from the server.'));
        await waitFor(() => expect(textOf('owners')).toBe('Could not read this from the server.'));
        expect(line('code').getAttribute('data-state')).toBe('unknown');
        expect(line('owners').getAttribute('data-state')).toBe('unknown');
    });

    describe('the owner\'s notes', () => {
        it('"I pulled it today" and "I tried it today" make a dated note in this browser, and a note can be cleared', async () => {
            await renderCard();
            fireEvent.click(within(line('image')).getByRole('button', { name: 'I pulled it today' }));
            expect(line('image').getAttribute('data-state')).toBe('ok');
            expect(textOf('image')).toMatch(/Pulled on the laptop .* \(just now\), as you noted in this browser\./);
            expect(readHallNotes('n1', NOW).imagePulledAt).toBe(NOW);

            fireEvent.click(within(line('drill')).getByRole('button', { name: 'I tried it today' }));
            expect(line('drill').getAttribute('data-state')).toBe('ok');
            expect(readHallNotes('n1', NOW).drillAt).toBe(NOW);

            fireEvent.click(within(line('image')).getByRole('button', { name: 'Clear my note' }));
            expect(line('image').getAttribute('data-state')).toBe('amber');
            expect(readHallNotes('n1', NOW).imagePulledAt).toBeUndefined();
            expect(readHallNotes('n1', NOW).drillAt).toBe(NOW);
        });

        it('the last-download line follows a download made by the page, without a reload', async () => {
            await renderCard();
            expect(line('download').getAttribute('data-state')).toBe('amber');
            act(() => { writeHallNote('n1', 'downloadedAt', NOW - 2 * MIN, NOW); });
            expect(line('download').getAttribute('data-state')).toBe('ok');
            expect(textOf('download')).toMatch(/^Last locked file downloaded in this browser .* \(2 minutes ago\)\.$/);
        });

        it('starts from the notes this browser already holds for this node, and not another node\'s', async () => {
            writeHallNote('n1', 'drillAt', NOW - 3 * DAY, NOW);
            writeHallNote('other', 'imagePulledAt', NOW - DAY, NOW);
            await renderCard();
            expect(line('drill').getAttribute('data-state')).toBe('ok');
            expect(line('image').getAttribute('data-state')).toBe('amber');
        });
    });

    describe('who sees it', () => {
        const key = (role: 'owner' | 'admin' | 'moderator'): RolesViewer => ({ kind: 'key', memberPubkey: 'pk', role });

        it('an owner, and the admin password (owner level), see it', async () => {
            const a = await renderCard({ viewer: key('owner') });
            expect(screen.getByTestId('ready-for-the-hall')).toBeTruthy();
            a.unmount();
            await renderCard({ viewer: { kind: 'password' } });
            expect(screen.getByTestId('ready-for-the-hall')).toBeTruthy();
        });

        it('an admin sees it, but the node tells only owners about the standby, so that line says so and is not ready', async () => {
            await renderCard({ viewer: key('admin'), diag: baseDiag(null) });
            expect(screen.getByTestId('ready-for-the-hall')).toBeTruthy();
            expect(line('copy').getAttribute('data-state')).toBe('unknown');
            expect(textOf('copy')).toBe('Only an owner sees the standby\'s copies.');
            await waitFor(() => expect(line('code').getAttribute('data-state')).toBe('ok'));
        });

        it('a moderator\'s session gets nothing, and the node is not asked anything', async () => {
            const { container } = await renderCard({ viewer: key('moderator') });
            expect(container.querySelector('[data-testid="ready-for-the-hall"]')).toBeNull();
            expect(nodeClient.fetchTakeoverStatus).not.toHaveBeenCalled();
            expect(nodeClient.getOwnerWordsChecks).not.toHaveBeenCalled();
        });

        it('a standby\'s Settings does not show it (it is the main server\'s card), and asks nothing', async () => {
            const { container } = await renderCard({ isStandby: true });
            expect(container.querySelector('[data-testid="ready-for-the-hall"]')).toBeNull();
            expect(nodeClient.fetchTakeoverStatus).not.toHaveBeenCalled();
        });
    });

    describe('the kit page', () => {
        it('opens the operator manual at the planned page, "Before the lights go out"', async () => {
            await renderCard();
            fireEvent.click(screen.getByRole('button', { name: /Open the kit page/ }));
            expect(manualApi.openManual).toHaveBeenCalledWith('before-the-lights-go-out');
        });

        it('draws no link where there is no manual to open', async () => {
            manualPresent = false;
            await renderCard();
            expect(screen.queryByRole('button', { name: /Open the kit page/ })).toBeNull();
        });
    });

    describe('small screens and both themes', () => {
        it('holds at 320 wide: text wraps, nothing is fixed-width, and the buttons are 44 high', async () => {
            vi.mocked(nodeClient.getOwnerWordsChecks).mockResolvedValue({ owners: [owner('a'.repeat(60), null), owner('b', null)] });
            await renderCard({ diag: baseDiag({ incident: null, standbys: [{ ...goodHealth.standbys[0], label: 'The standby at ' + 'x'.repeat(50) }, { ...goodHealth.standbys[0], id: 's2' }] }) });
            const card = screen.getByTestId('ready-for-the-hall');
            expect(card.innerHTML).not.toMatch(/whitespace-nowrap|\bw-\[\d|\bmin-w-\[\d/);
            for (const p of card.querySelectorAll('li p')) expect(p.className).toMatch(/break-words/);
            for (const b of card.querySelectorAll('button')) expect(b.className).toMatch(/min-h-\[44px\]/);
        });

        it('takes its colours from the central tokens, never a Tailwind shade', async () => {
            await renderCard();
            const html = screen.getByTestId('ready-for-the-hall').innerHTML;
            expect(html).not.toMatch(/(?:emerald|amber|red|green|yellow|orange|terra)-\d{2,3}/);
            expect(html).toMatch(/bp-chip-ok-tint/);
            expect(html).toMatch(/bp-chip-warn-tint/);
        });

        it('says each state in words as well as colour: Ready, Needs you, Cannot tell', async () => {
            await renderCard({ viewer: { kind: 'key', memberPubkey: 'pk', role: 'admin' }, diag: baseDiag(null) });
            await waitFor(() => expect(line('code').getAttribute('data-state')).toBe('ok'));
            expect(within(line('code')).getByText('Ready')).toBeTruthy();
            expect(within(line('drill')).getByText('Needs you')).toBeTruthy();
            expect(within(line('copy')).getByText('Cannot tell')).toBeTruthy();
        });
    });
});
