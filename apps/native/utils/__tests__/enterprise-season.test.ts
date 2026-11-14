import { describe, it, expect } from 'vitest';
import {
    seasonBanner, seasonControls, anySeasonControl, pauseConfirmText, windUpConfirmText, windUpDeficitText,
    cancelWindUpConfirmText, finaliseWindUpConfirmText, postingBlockedText, ledgerSince, ledgerLineLabels,
    formatPauseDate, heldCredit, signedBeans, plSummaryText,
} from '../enterprise-season';

const DAY = 24 * 60 * 60 * 1000;
// Local noon, so the day-of-month cannot shift with the test machine's timezone.
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();

const LEAD = { publicKey: 'lead', callsign: 'Rosa', role: 'lead', suspended: false };
const KEEPER = { publicKey: 'kee', callsign: 'Tomas', role: 'keeper', suspended: false };
const SUSPENDED = { publicKey: 'sus', callsign: 'Ivo', role: 'keeper', suspended: true };

function enterprise(over: any = {}) {
    return {
        // Every figure in whole hundredths of a Bean, as the node's detail sends them (balance_c, usableFloor_c, ...).
        name: 'Bread Co-op', status: 'active', paused: false, balance_c: 12050, usableFloor_c: -30000,
        keepers: [LEAD, KEEPER, SUSPENDED], isLeadOrSoleKeeperOrAdmin: false, ...over,
    };
}

describe('state banners every member sees', () => {
    it('none for an ordinary active enterprise', () => {
        expect(seasonBanner(enterprise(), NOW)).toBeNull();
    });

    it("paused: the web's sentence, with the server's floor snapshot and 90-day expiry", () => {
        const b = seasonBanner(enterprise({
            paused: true,
            pausedAt: new Date(NOW - 10 * DAY).toISOString(),
            pausedFloorSnapshot_c: -25000,
            pauseExpiresAt: new Date(2026, 11, 6, 12).toISOString(),
            pauseDaysRemaining: 80,
        }), NOW);
        expect(b?.kind).toBe('paused');
        expect(b?.headline).toBe('Paused for the season. Credit held at 250 beans until 6 December.');
        expect(b?.body).toBe('Listings are paused and cannot be bought right now.');
        expect(b?.kind === 'paused' && b.warning).toBeNull();
    });

    it('paused: falls back to pausedAt + 90 days when the node sends no expiry', () => {
        const pausedAt = new Date(2026, 8, 1, 12).toISOString();
        const b = seasonBanner(enterprise({ paused: true, pausedAt, pausedFloorSnapshot_c: -10000 }), NOW);
        expect(b?.headline).toBe('Paused for the season. Credit held at 100 beans until 30 November.');
    });

    it("paused: carries the server's expiry warning, or builds it inside 14 days", () => {
        const fromServer = seasonBanner(enterprise({ paused: true, pauseWarning: 'The credit line held for the pause ends in 3 days' }), NOW);
        expect(fromServer?.kind === 'paused' && fromServer.warning).toBe('The credit line held for the pause ends in 3 days');
        const built = seasonBanner(enterprise({ paused: true, pauseDaysRemaining: 1 }), NOW);
        expect(built?.kind === 'paused' && built.warning).toBe('The credit line held for the pause ends in 1 day');
        const expired = seasonBanner(enterprise({ paused: true, pauseDaysRemaining: 0 }), NOW);
        expect(expired?.kind === 'paused' && expired.warning).toBe('The credit line held for the pause has ended');
    });

    it('winding up: days left and who started it', () => {
        const b = seasonBanner(enterprise({
            status: 'winding_up',
            windUpInitiatedAt: new Date(NOW - 2 * DAY).toISOString(),
            windUpInitiatedBy: 'lead',
            windUpGraceEndsAt: new Date(NOW + 5 * DAY).toISOString(),
        }), NOW);
        expect(b?.kind).toBe('winding_up');
        expect(b?.headline).toBe('Winding up (5 days left · started by Rosa)');
        expect(b?.body).toBe('This enterprise is winding down. Listings are inactive and cannot be bought. Any keeper can stop this during the 7-day grace period.');
        expect(b?.kind === 'winding_up' && b.graceEndedNote).toBeNull();
    });

    it('winding up: one day left, a starter no longer in the keepers list, and the grace note once elapsed', () => {
        const one = seasonBanner(enterprise({ status: 'winding_up', windUpInitiatedBy: 'abcdef0123456789', windUpGraceEndsAt: new Date(NOW + 0.5 * DAY).toISOString() }), NOW);
        expect(one?.headline).toBe('Winding up (1 day left · started by abcdef01…)');
        const over = seasonBanner(enterprise({ status: 'winding_up', windUpInitiatedAt: new Date(NOW - 8 * DAY).toISOString(), windUpInitiatedBy: 'lead' }), NOW);
        expect(over?.headline).toBe('Winding up (0 days left · started by Rosa)');
        expect(over?.kind === 'winding_up' && over.graceEndedNote).toBe('The 7-day grace period has elapsed. Ready to be finalised.');
    });

    it('winding up: never more days left than the 7-day grace period', () => {
        const at = (ms: number) => seasonBanner(enterprise({ status: 'winding_up', windUpInitiatedBy: 'lead', windUpGraceEndsAt: new Date(NOW + ms).toISOString() }), NOW);
        // Just started, phone clock a few seconds behind the server: ceil would say 8.
        expect(at(7 * DAY + 5000)?.headline).toBe('Winding up (7 days left · started by Rosa)');
        expect(at(7 * DAY)?.headline).toBe('Winding up (7 days left · started by Rosa)');
        expect(at(7 * DAY - 1)?.headline).toBe('Winding up (7 days left · started by Rosa)');
        expect(at(6 * DAY)?.headline).toBe('Winding up (6 days left · started by Rosa)');
        // Derived from windUpInitiatedAt a moment in the phone's future.
        const fromStart = seasonBanner(enterprise({ status: 'winding_up', windUpInitiatedBy: 'lead', windUpInitiatedAt: new Date(NOW + 3000).toISOString() }), NOW);
        expect(fromStart?.headline).toBe('Winding up (7 days left · started by Rosa)');
    });

    it('completed wins over a stale paused flag', () => {
        const b = seasonBanner(enterprise({ status: 'completed', paused: true }), NOW);
        expect(b?.kind).toBe('completed');
        expect(b?.headline).toBe('Completed · Wound up');
    });
});

describe('keeper controls follow the server', () => {
    const active = enterprise();

    it('a member who is not a keeper sees none', () => {
        expect(anySeasonControl(seasonControls(active, 'stranger', NOW))).toBe(false);
        expect(anySeasonControl(seasonControls(active, null, NOW))).toBe(false);
    });

    it('an active keeper can pause, but cannot start wind-up', () => {
        expect(seasonControls(active, 'kee', NOW)).toEqual({ pause: true, resume: false, startWindUp: false, cancelWindUp: false, finaliseWindUp: false });
    });

    it('the lead keeper can pause and start wind-up', () => {
        expect(seasonControls({ ...active, isLeadOrSoleKeeperOrAdmin: true }, 'lead', NOW)).toEqual({ pause: true, resume: false, startWindUp: true, cancelWindUp: false, finaliseWindUp: false });
    });

    it('an admin who keeps nothing gets what the server allows an admin', () => {
        expect(seasonControls({ ...active, isLeadOrSoleKeeperOrAdmin: true }, 'admin-pub', NOW)).toEqual({ pause: true, resume: false, startWindUp: true, cancelWindUp: false, finaliseWindUp: false });
    });

    it('a suspended keeper sees none, even if the server still flags lead level', () => {
        expect(anySeasonControl(seasonControls(active, 'sus', NOW))).toBe(false);
        expect(anySeasonControl(seasonControls({ ...active, isLeadOrSoleKeeperOrAdmin: true }, 'sus', NOW))).toBe(false);
    });

    it('paused: resume instead of pause', () => {
        expect(seasonControls({ ...active, paused: true }, 'kee', NOW)).toMatchObject({ pause: false, resume: true });
    });

    it('winding up: any active keeper can cancel; only lead level can finalise, and only after the grace period', () => {
        const winding = { ...active, status: 'winding_up', windUpGraceEndsAt: new Date(NOW + DAY).toISOString() };
        expect(seasonControls(winding, 'kee', NOW)).toEqual({ pause: false, resume: false, startWindUp: false, cancelWindUp: true, finaliseWindUp: false });
        expect(seasonControls({ ...winding, isLeadOrSoleKeeperOrAdmin: true }, 'lead', NOW).finaliseWindUp).toBe(false);

        const graceOver = { ...winding, windUpGraceEndsAt: new Date(NOW - DAY).toISOString() };
        expect(seasonControls(graceOver, 'kee', NOW).finaliseWindUp).toBe(false);
        expect(seasonControls({ ...graceOver, isLeadOrSoleKeeperOrAdmin: true }, 'lead', NOW)).toEqual({ pause: false, resume: false, startWindUp: false, cancelWindUp: true, finaliseWindUp: true });
    });

    it('a closed enterprise offers nothing to anyone', () => {
        for (const status of ['completed', 'disabled', 'suspended', 'pruned']) {
            expect(anySeasonControl(seasonControls({ ...active, status, isLeadOrSoleKeeperOrAdmin: true }, 'lead', NOW))).toBe(false);
        }
    });
});

describe('plain words before the tap', () => {
    it('start wind-up says what it returns, who it releases and that it is for good', () => {
        expect(windUpConfirmText(enterprise(), 'Bread Co-op')).toBe(
            'Winding up returns 120.50 beans to the Commons, releases 3 keepers, and closes Bread Co-op for good. Any keeper can stop this for the next 7 days.'
        );
        // Nothing to return reads "0", as every whole figure is written (formatHundredths: no decimals when whole).
        expect(windUpConfirmText(enterprise({ keepers: [LEAD], balance_c: 0 }), 'Bread Co-op')).toBe(
            'Winding up returns 0 beans to the Commons, releases 1 keeper, and closes Bread Co-op for good. Any keeper can stop this for the next 7 days.'
        );
    });

    it('a deficit is named, since the server refuses it', () => {
        expect(windUpDeficitText(enterprise())).toBeNull();
        // A figure below zero is written with the true minus (formatHundredths), never a hyphen.
        expect(windUpDeficitText(enterprise({ balance_c: -4000 }))).toBe('Cannot wind up an enterprise in deficit (−40 🫘). Debt must be resolved or written off first.');
        expect(windUpDeficitText(enterprise({ balance_c: -982 }))).toBe('Cannot wind up an enterprise in deficit (−9.82 🫘). Debt must be resolved or written off first.');
        expect(windUpConfirmText(enterprise({ balance_c: -4000 }), 'X')).toContain('returns 0 beans');
    });

    it('pause names the floor it holds', () => {
        expect(pauseConfirmText(enterprise())).toBe(
            'Pausing for the season holds your credit line at 300 beans for up to 90 days and pauses active listings so members cannot buy. Any keeper can resume at any time.'
        );
    });

    it('cancel and finalise', () => {
        expect(cancelWindUpConfirmText('Bread Co-op')).toBe('Cancelling wind-up restores Bread Co-op to active status immediately. Keepers remain appointed and listings can resume.');
        expect(finaliseWindUpConfirmText(enterprise(), 'Bread Co-op')).toBe('The 7-day grace period has elapsed. Finalising sweeps 120.50 beans to the Commons, releases all keepers, and closes Bread Co-op for good.');
    });

    it('posting is closed while paused, winding up or completed', () => {
        expect(postingBlockedText(enterprise())).toBeNull();
        expect(postingBlockedText(enterprise({ paused: true }))).toBe('Paused for the season — posting new listings is disabled.');
        expect(postingBlockedText(enterprise({ status: 'winding_up', paused: true }))).toBe('Winding up — posting new listings is disabled.');
        expect(postingBlockedText(enterprise({ status: 'completed' }))).toBe('Enterprise closed permanently.');
    });
});

describe('P&L helpers', () => {
    it('period to since', () => {
        expect(ledgerSince('all', NOW)).toBeUndefined();
        expect(ledgerSince('30d', NOW)).toBe(new Date(NOW - 30 * DAY).toISOString());
        expect(ledgerSince('365d', NOW)).toBe(new Date(NOW - 365 * DAY).toISOString());
    });

    it('came in / went out, with the counterparty name', () => {
        expect(ledgerLineLabels({ direction: 'income', counterpartyName: 'Alice', memo: 'Bread x2' })).toEqual({ flow: 'Came in', with: 'Alice', what: 'Bread x2' });
        expect(ledgerLineLabels({ direction: 'spend', counterpartyName: '', memo: '' })).toEqual({ flow: 'Went out', with: 'Member', what: 'Transfer' });
        // The line's amount_c, whole hundredths: written as every figure is, a spend with the true minus.
        expect(signedBeans(1200, 'income')).toBe('+12 🫘');
        expect(signedBeans(350, 'spend')).toBe('−3.50 🫘');
        expect(signedBeans(1, 'income')).toBe('+0.01 🫘');
        expect(signedBeans(4925, 'spend')).toBe('−49.25 🫘');
        expect(signedBeans(50000, 'income')).toBe('+500 🫘');
        // Not whole hundredths: no figure, never a number made up.
        expect(signedBeans(3.5, 'spend')).toBe('— 🫘');
    });

    // The summary's totals are whole hundredths of a Bean (the node keeps their names: M1's listed deviations).
    it('P&L totals: an empty period and zero spend read 0, never −0', () => {
        const empty = plSummaryText({ totalIncome: 0, totalSpend: 0, netChange: 0 });
        expect(empty).toEqual({ cameIn: '0 🫘', wentOut: '0 🫘', net: '0 🫘', netIsPositive: true, feeNote: null });
        expect(plSummaryText(null)).toEqual(empty);
        expect(plSummaryText(undefined).wentOut).toBe('0 🫘');
        // A total that isn't whole hundredths is no figure: it counts as nothing, never as a signed dust.
        expect(plSummaryText({ totalIncome: 0, totalSpend: 0.001, netChange: -0.001 }).net).toBe('0 🫘');
        const spent = plSummaryText({ totalIncome: 0, totalSpend: 350, netChange: -350 });
        expect(spent.wentOut).toBe('−3.50 🫘');
        expect(spent.net).toBe('−3.50 🫘');
        expect(spent.netIsPositive).toBe(false);
    });

    it('P&L fee note: shown only when income − spend − net > 0, with the fee amount', () => {
        // The Community Eggs screen: 36 came in, nothing went out, balance moved 35.82.
        const eggs = plSummaryText({ totalIncome: 3600, totalSpend: 0, netChange: 3582 });
        expect(eggs.cameIn).toBe('+36 🫘');
        expect(eggs.wentOut).toBe('0 🫘');
        expect(eggs.net).toBe('+35.82 🫘');
        expect(eggs.feeNote).toBe('Came in is before fees: 0.18 🫘 in fees came off it.');
        expect(plSummaryText({ totalIncome: 3600, totalSpend: 1000, netChange: 2600 }).feeNote).toBeNull();
        expect(plSummaryText({ totalIncome: 3600, totalSpend: 1000, netChange: 2650 }).feeNote).toBeNull();
        // In whole hundredths the sum is exact: 0.30 in, 0.10 out, 0.20 moved is no fee, and no "0 in fees" note.
        expect(plSummaryText({ totalIncome: 30, totalSpend: 10, netChange: 20 }).feeNote).toBeNull();
        // One hundredth of fees is a note.
        expect(plSummaryText({ totalIncome: 100, totalSpend: 0, netChange: 99 }).feeNote).toBe('Came in is before fees: 0.01 🫘 in fees came off it.');
    });

    it('formatting edge cases', () => {
        expect(formatPauseDate(null)).toBe('');
        expect(formatPauseDate('not a date')).toBe('');
        // Whole hundredths: the floor's size as the node sent it.
        expect(heldCredit({ usableFloor_c: -3333 })).toBe(3333);
        // A floor that isn't whole hundredths is no figure: the next of the detail's figures, else nothing.
        expect(heldCredit({ usableFloor_c: -33.33333, floor_c: -2000 })).toBe(2000);
        expect(heldCredit({ usableFloor_c: -33.33333 })).toBe(0);
        expect(heldCredit({})).toBe(0);
    });
});

describe('a project says leader and collaborators, never keeper (group decisions pick 8)', () => {
    const project = (over: any = {}) => enterprise({ lifecycle: 'bounded', ...over });
    it('every confirmation and banner for a project', () => {
        const texts = [
            pauseConfirmText(project()),
            windUpConfirmText(project(), 'Hall Roof'),
            windUpDeficitText(project({ balance_c: -500 })) ?? '',
            cancelWindUpConfirmText('Hall Roof', 'bounded'),
            finaliseWindUpConfirmText(project(), 'Hall Roof'),
            postingBlockedText(project({ status: 'completed' })) ?? '',
            seasonBanner(project({ status: 'completed' }))?.body ?? '',
            seasonBanner(project({ status: 'winding_up', windUpEndsAt: new Date(NOW + 3 * DAY).toISOString() }), NOW)?.body ?? '',
        ];
        for (const t of texts) expect(t).not.toMatch(/keeper|enterprise/i);
        expect(windUpConfirmText(project(), 'Hall Roof')).toContain('releases 3 collaborators');
        expect(cancelWindUpConfirmText('Hall Roof', 'bounded')).toContain('Collaborators remain appointed');
    });
    it('an enterprise keeps its keepers', () => {
        expect(windUpConfirmText(enterprise(), 'Bread Co-op')).toContain('Any keeper can stop this');
        expect(cancelWindUpConfirmText('Bread Co-op')).toContain('Keepers remain appointed');
    });
});
