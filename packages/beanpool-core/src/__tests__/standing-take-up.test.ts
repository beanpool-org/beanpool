/**
 * Standing deals, the shared half both apps draw from (DESIGN-standing-deals-fable.md §6; DESIGN-standing-deals-upfront-fable.md
 * §3): the signed authorisation the payer's app sends (signStandingAuthorisation: 0xFF ‖ the text, as every member statement
 * is signed, verified here with Node's own ed25519), the take-up screen's lines, and the panel each side sees per phase.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    STANDING_PICK_DAYS,
    parseStandingAuthorisation,
    signStandingAuthorisation,
    standingFieldsFor,
    standingGraceEndsAt,
    standingPanel,
    standingStartAt,
    standingStopConfirm,
    standingTakeUpLines,
    standingUnitForListing,
    type StandingDealRow,
} from '../standing-deal.js';
import { BOUND_SIGNATURE_MARKER, ed25519Signer } from '../request-signing.js';
import { dealStep, listingDealLines } from '../deal-step.js';

const PAYER = 'a'.repeat(64);
const PAYEE = 'b'.repeat(64);
const NOW = Date.parse('2026-11-09T08:00:00.000Z');
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fixedRand = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);

function keyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    return { publicKey, pubHex: Buffer.from(pub).toString('hex'), seed: new Uint8Array(seed) };
}

describe('standingFieldsFor: what both apps put in the text', () => {
    it('a v4 UUID, a 32-hex nonce, the start as toISOString writes it, Beans to the cent', () => {
        const f = standingFieldsFor({ listingId: 'post-1', payee: PAYEE, beansPerPeriod: 50.004, unit: 'month', maxPeriods: null, startsAt: NOW }, fixedRand);
        expect(f.standingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(f.nonce).toMatch(/^[0-9a-f]{32}$/);
        expect(f.startsAt).toBe('2026-11-09T08:00:00.000Z');
        expect(f.beansPerPeriod).toBe(50);
    });
    it('two take-ups never share an id or a nonce', () => {
        const a = standingFieldsFor({ listingId: 'p', payee: PAYEE, beansPerPeriod: 5, unit: 'week', maxPeriods: 3, startsAt: NOW });
        const b = standingFieldsFor({ listingId: 'p', payee: PAYEE, beansPerPeriod: 5, unit: 'week', maxPeriods: 3, startsAt: NOW });
        expect(a.standingId).not.toBe(b.standingId);
        expect(a.nonce).not.toBe(b.nonce);
    });
});

describe('signStandingAuthorisation: the signed text an accept or approval carries', () => {
    const fields = standingFieldsFor({ listingId: 'post-1', payee: PAYEE, beansPerPeriod: 50, unit: 'month', maxPeriods: 6, startsAt: NOW }, fixedRand);

    it('signs 0xFF then the text in UTF-8, for the host the URL names, and the node can read the text back', async () => {
        const k = keyPair();
        const body = await signStandingAuthorisation('https://Mullum.BeanPool.org:8443/x', fields, ed25519Signer(k.seed));
        const a = parseStandingAuthorisation(body.authorisation.payload);
        expect(a).not.toBeNull();
        expect(a!.host).toBe('mullum.beanpool.org');
        expect(a!.maxPeriods).toBe(6);
        expect(body.periods).toBe(6);
        expect(body.untilStopped).toBeUndefined();
        expect(body.startsAt).toBe(fields.startsAt);
        const sig = Buffer.from(body.authorisation.signature, 'base64');
        const marked = Buffer.concat([Buffer.from([BOUND_SIGNATURE_MARKER]), Buffer.from(body.authorisation.payload, 'utf-8')]);
        expect(crypto.verify(null, marked, k.publicKey, sig)).toBe(true);
        // Never the bare text: nothing an older app can be made to sign (plain UTF-8) is a standing authorisation.
        expect(crypto.verify(null, Buffer.from(body.authorisation.payload, 'utf-8'), k.publicKey, sig)).toBe(false);
    });

    it('until stopped says so; a hall laptop signs for the name its requests are signed for', async () => {
        const k = keyPair();
        const open = { ...fields, maxPeriods: null };
        const body = await signStandingAuthorisation('http://192.168.1.20', open, ed25519Signer(k.seed), 'mullum.beanpool.org');
        expect(body.untilStopped).toBe(true);
        expect(body.periods).toBeUndefined();
        expect(parseStandingAuthorisation(body.authorisation.payload)!.host).toBe('mullum.beanpool.org');
    });

    it('signs nothing for an address with no host or a field the text cannot carry', async () => {
        let signed = 0;
        const sign = (b: Uint8Array) => { signed++; return b; };
        await expect(signStandingAuthorisation('not a url', fields, sign)).rejects.toThrow();
        await expect(signStandingAuthorisation('https://a.org', { ...fields, payee: 'nope' }, sign)).rejects.toThrow();
        expect(signed).toBe(0);
    });
});

describe('standingStartAt: Today, or 1 to 30 days ahead, never past the node\'s window', () => {
    it('clamps', () => {
        expect(standingStartAt(NOW, 0)).toBe(NOW);
        expect(standingStartAt(NOW, 3)).toBe(NOW + 3 * 86_400_000);
        expect(standingStartAt(NOW, 99)).toBe(NOW + STANDING_PICK_DAYS * 86_400_000);
        expect(standingStartAt(NOW, -4)).toBe(NOW);
    });
});

describe('standingTakeUpLines: the take-up screen (design §3)', () => {
    it('a month from today: paid now for the first month, its dates, the agree button', () => {
        const l = standingTakeUpLines({ unit: 'month', beans: 50, title: 'Vehicle Storage', payeeName: 'Rob', startsAt: NOW, periods: 6 }, day);
        expect(l.title).toBe('Take this up?');
        expect(l.summary).toBe('Vehicle Storage · 50 Beans a month · from Rob');
        expect(l.paidNow).toBe('50 Beans go to Rob now for the first month (9 Nov – 9 Dec), then 50 at the start of each month, until one of you stops it.');
        expect(l.forPeriods).toBe('For 6 months');
        expect(l.agree).toBe('Agree and pay 50 Beans');
        expect(l.howItRuns).toBe('You can stop it any time. A month already paid stays paid.');
        expect(Object.values(l).join(' ')).not.toMatch(/held|hold/i);
    });
    it('a week, one period, starting later', () => {
        const l = standingTakeUpLines({ unit: 'week', beans: 12.5, title: 'Eggs', payeeName: 'Ann', startsAt: NOW + 2 * 86_400_000, periods: 1 }, day);
        expect(l.forPeriods).toBe('For 1 week');
        expect(l.startOn).toBe('On 11 Nov');
        expect(l.paidNow).toBe('12.5 Beans go to Ann now for the first week (11 Nov – 18 Nov), then 12.5 at the start of each week, until one of you stops it.');
        expect(l.shortAhead).toBe("If you're short when a week is due, you'll be told the day before.");
    });
});

const row = (o: Partial<StandingDealRow> = {}): StandingDealRow => ({
    id: 'tx-3', postTitle: 'Vehicle Storage', status: 'completed', createdAt: '2026-11-09T08:00:00.000Z', completedAt: '2026-11-09T08:00:00.000Z',
    buyerPublicKey: PAYER, buyerCallsign: 'Marty', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    standingId: 'sd-1', periodNo: 2, standingPhase: 'paid', standingBeans: 50, standingUnit: 'month', standingMaxPeriods: 6,
    standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: null, standingStopped: false,
    ...o,
});

describe('standingPanel: what each side sees, per phase', () => {
    it('paid: the Home rule badges nobody; month 2 of 6', () => {
        const p = standingPanel(row(), PAYER, day, NOW)!;
        expect(p.title).toBe('🔁 Standing deal since 9 Oct · 50 Beans a month');
        expect(p.periodOf).toBe('Month 2 of 6');
        expect(dealStep(row(), PAYER, NOW).needsMe).toBe(false);
        expect(dealStep(row(), PAYEE, NOW).needsMe).toBe(false);
    });
    it('short: the grace is half the month that is due (month 3, 9 Dec – 9 Jan: 15½ days), from the day it was due', () => {
        const r = row({ standingPhase: 'short', standingShortSince: '2026-12-09T08:00:00.000Z', standingNextDueAt: '2026-12-09T09:00:00.000Z' });
        const p = standingPanel(r, PAYER, day, NOW)!;
        expect(p.graceEndsAt).toBe(standingGraceEndsAt('2026-10-09T08:00:00.000Z', 'month', 3));
        expect(p.graceEndsAt).toBe('2026-12-24T20:00:00.000Z');
        expect(dealStep(r, PAYER, NOW).needsMe).toBe(true);
        expect(dealStep(r, PAYEE, NOW).needsMe).toBe(false);
    });
    it('the last of its count says so; until stopped has no "of"', () => {
        expect(standingPanel(row({ periodNo: 6 }), PAYER, day, NOW)!.lastLine).toBe('Vehicle Storage: the last month of this standing deal is paid. It ends on 9 Dec.');
        expect(standingPanel(row({ standingMaxPeriods: null }), PAYER, day, NOW)!.periodOf).toBeNull();
    });
    it('weekly words', () => {
        const p = standingPanel(row({ standingUnit: 'week', standingMaxPeriods: null }), PAYER, day, NOW)!;
        expect(p.status).toBe("This week's 50 went to Rob on 9 Nov · the next 50 go on 9 Dec");
    });
    it('ended, a one-off deal, or a stranger: no panel', () => {
        expect(standingPanel(row({ standingPhase: 'ended' }), PAYER, day, NOW)).toBeNull();
        expect(standingPanel(row({ standingId: null, standingPhase: null }), PAYER, day, NOW)).toBeNull();
        expect(standingPanel(row(), 'c'.repeat(64), day, NOW)).toBeNull();
    });
});

// Round 2 of #3000 (deciding review on e07a97d3).
describe('standingUnitForListing: only a PRICED weekly or monthly listing makes a standing deal (finding 1)', () => {
    it('a free one (0 Beans a week or a month) stays a one-off deal of 0 Beans, as before S2: there is nothing to hold each period', () => {
        expect(standingUnitForListing('monthly', 0)).toBeNull();
        expect(standingUnitForListing('weekly', 0)).toBeNull();
        expect(standingUnitForListing('monthly', '0')).toBeNull();
        expect(standingUnitForListing('monthly', null)).toBeNull();
        expect(standingUnitForListing('monthly', undefined)).toBeNull();
        expect(standingUnitForListing('monthly', Number.NaN)).toBeNull();
        expect(standingUnitForListing('monthly', -5)).toBeNull();
    });
    it('a priced one is a standing deal by the week or the month; hourly, daily and fixed never are', () => {
        expect(standingUnitForListing('monthly', 50)).toBe('month');
        expect(standingUnitForListing('weekly', 12.5)).toBe('week');
        expect(standingUnitForListing('weekly', '12.5')).toBe('week');
        expect(standingUnitForListing('fixed', 50)).toBeNull();
        expect(standingUnitForListing('hourly', 50)).toBeNull();
        expect(standingUnitForListing('daily', 50)).toBeNull();
    });
    it('whatever it calls standing, core can sign: 0.01 Beans a month signs; 0 is the case that threw before signing', async () => {
        const signed: Uint8Array[] = [];
        const sign = async (b: Uint8Array) => { signed.push(b); return new Uint8Array(64); };
        const unit = standingUnitForListing('monthly', 0.01)!;
        const fields = standingFieldsFor({ listingId: 'post-1', payee: PAYEE, beansPerPeriod: 0.01, unit, maxPeriods: null, startsAt: NOW }, fixedRand);
        await signStandingAuthorisation('https://mullum.example', fields, sign);
        expect(signed).toHaveLength(1);
        // The defect: a free monthly listing went to the take-up and Agree threw here, before anything was signed.
        await expect(signStandingAuthorisation('https://mullum.example', { ...fields, beansPerPeriod: 0 }, sign)).rejects.toThrow();
        expect(signed).toHaveLength(1);
    });
});

describe('standingStopConfirm: in the grace it ends NOW, for either side (amendment §1)', () => {
    it('short: "Stop it now?", for the payer and the payee alike, by the week or the month', () => {
        for (const unit of ['month', 'week'] as const) {
            const r = row({ standingUnit: unit, standingPhase: 'short', standingShortSince: '2026-12-09T08:00:00.000Z' });
            expect(standingStopConfirm(r, PAYER, day).title).toBe('Stop it now?');
            expect(standingStopConfirm(r, PAYEE, day).title).toBe('Stop it now?');
        }
    });
    it('paid: after the period already paid', () => {
        expect(standingStopConfirm(row(), PAYER, day).title).toBe('Stop after this month?');
        expect(standingStopConfirm(row({ standingUnit: 'week' }), PAYEE, day).title).toBe('Stop after this week?');
    });
});

describe("listingDealLines.finished: a standing deal still running is never 'done' (finding 3)", () => {
    const shortRow = { status: 'completed', standingId: 'sd-1', standingPhase: 'short' as const };
    it("a running deal's row is the period last paid (completed), but the deal runs on: no line", () => {
        expect(listingDealLines.finished(shortRow)).toBeNull();
        expect(listingDealLines.finished({ ...shortRow, standingPhase: 'paid' })).toBeNull();
    });
    it('one that has ended, or an older period (no phase), is a finished deal like any other', () => {
        expect(listingDealLines.finished({ ...shortRow, standingPhase: 'ended' })).toBe('That deal is done.');
        expect(listingDealLines.finished({ status: 'completed', standingId: 'sd-1', standingPhase: null })).toBe('That deal is done.');
        expect(listingDealLines.finished({ status: 'cancelled' })).toBe('That deal was cancelled.');
        expect(listingDealLines.finished('completed')).toBe('That deal is done.');
    });
});
