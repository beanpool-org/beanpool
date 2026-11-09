/**
 * Standing deals S2, the shared half both apps draw from (scratch/fable-design/DESIGN-standing-deals-fable.md §2.2, §6):
 * the signed authorisation the payer's app sends (signStandingAuthorisation: 0xFF ‖ the text, as every member statement is
 * signed, verified here with Node's own ed25519), the take-up screen's lines, and the panel each side sees per phase.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    STANDING_GRACE_MS,
    STANDING_PICK_DAYS,
    parseStandingAuthorisation,
    signStandingAuthorisation,
    standingFieldsFor,
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

describe('standingTakeUpLines: the take-up screen (§2.2)', () => {
    it('a month from today: held now for the first month, its dates, the agree button', () => {
        const l = standingTakeUpLines({ unit: 'month', beans: 50, title: 'Vehicle Storage', payeeName: 'Rob', startsAt: NOW, periods: 6 }, day);
        expect(l.title).toBe('Take this up?');
        expect(l.summary).toBe('Vehicle Storage · 50 Beans a month · from Rob');
        expect(l.heldNow).toBe('50 Beans are held now for the first month (9 Nov – 9 Dec).');
        expect(l.forPeriods).toBe('For 6 months');
        expect(l.agree).toBe('Agree and hold 50 Beans');
        expect(l.howItRuns).toContain('they go to Rob');
    });
    it('a week, one period, starting later', () => {
        const l = standingTakeUpLines({ unit: 'week', beans: 12.5, title: 'Eggs', payeeName: 'Ann', startsAt: NOW + 2 * 86_400_000, periods: 1 }, day);
        expect(l.forPeriods).toBe('For 1 week');
        expect(l.startOn).toBe('On 11 Nov');
        expect(l.heldNow).toBe('12.5 Beans are held now for the first week (11 Nov – 18 Nov).');
        expect(l.shortAhead).toBe("If you're short when a week is due, you'll be told the day before.");
    });
});

const row = (o: Partial<StandingDealRow> = {}): StandingDealRow => ({
    id: 'tx-3', postTitle: 'Vehicle Storage', status: 'pending',
    buyerPublicKey: PAYER, buyerCallsign: 'Marty', sellerPublicKey: PAYEE, sellerCallsign: 'Rob',
    standingId: 'sd-1', periodNo: 3, standingPhase: 'held', standingBeans: 50, standingUnit: 'month', standingMaxPeriods: 6,
    standingNextDueAt: '2026-12-09T08:00:00.000Z', standingStartsAt: '2026-10-09T08:00:00.000Z', standingShortSince: null, standingStopped: false,
    ...o,
});

describe('standingPanel: what each side sees, per phase', () => {
    it('held, payer: when the Beans go, Hold back and Stop; the Home rule badges nobody', () => {
        const p = standingPanel(row(), PAYER, day, NOW)!;
        expect(p.title).toBe('🔁 Standing deal since 9 Oct · 50 Beans a month');
        expect(p.status).toBe("This month's 50 Beans are held · they go to Rob 9 Dec");
        expect(p.periodOf).toBe('Month 3 of 6');
        expect([p.holdBack, p.stop, p.warning]).toEqual([true, true, false]);
        expect(p.holdBackLabel).toBe('Hold back this month');
        expect(p.stopLabel).toBe('Stop…');
        expect(dealStep(row(), PAYER, NOW).needsMe).toBe(false);
        expect(dealStep(row(), PAYEE, NOW).needsMe).toBe(false);
    });
    it('held, payee: held for you, paid on the day; Stop, never Hold back', () => {
        const p = standingPanel(row(), PAYEE, day, NOW)!;
        expect(p.role).toBe('payee');
        expect(p.status).toBe("Marty's standing deal · 50 Beans a month · this month held for you · paid 9 Dec");
        expect([p.holdBack, p.stop]).toEqual([false, true]);
    });
    it('short, payer: the warning names the end of the week of grace; it needs the payer', () => {
        const shortSince = '2026-12-09T08:00:00.000Z';
        const r = row({ status: 'completed', standingPhase: 'short', standingShortSince: shortSince, standingNextDueAt: '2026-12-09T09:00:00.000Z' });
        const p = standingPanel(r, PAYER, day, NOW)!;
        expect(p.warning).toBe(true);
        expect(p.graceEndsAt).toBe(new Date(Date.parse(shortSince) + STANDING_GRACE_MS).toISOString());
        expect(p.status).toBe("⚠️ Next month isn't covered · 50 Beans needed by 16 Dec or this ends");
        expect([p.holdBack, p.stop]).toEqual([false, true]);
        expect(dealStep(r, PAYER, NOW).needsMe).toBe(true);
        expect(dealStep(r, PAYEE, NOW).needsMe).toBe(false);
    });
    it('short, payee: we keep trying until the day; Stop now', () => {
        const r = row({ status: 'completed', standingPhase: 'short', standingShortSince: '2026-12-09T08:00:00.000Z' });
        const p = standingPanel(r, PAYEE, day, NOW)!;
        expect(p.status).toBe("Next month isn't covered yet · we'll keep trying until 16 Dec");
        expect(p.stopLabel).toBe('Stop now');
    });
    it('held back: the schedule is paused, for both; no Hold back; it needs the payer only', () => {
        const r = row({ standingPhase: 'held_back' });
        for (const who of [PAYER, PAYEE]) {
            const p = standingPanel(r, who, day, NOW)!;
            expect(p.status).toBe('Held back · the schedule is paused');
            expect(p.holdBack).toBe(false);
        }
        expect(dealStep(r, PAYER, NOW).needsMe).toBe(true);
        expect(dealStep(r, PAYEE, NOW).needsMe).toBe(false);
    });
    it('stopped: no Stop again, and the last period says when it ends', () => {
        const p = standingPanel(row({ standingStopped: true }), PAYEE, day, NOW)!;
        expect(p.stop).toBe(false);
        expect(p.lastLine).toBe('Vehicle Storage: the last month of this standing deal is under way. It ends on 9 Dec.');
    });
    it('the last of its count says so too; until stopped has no "of"', () => {
        expect(standingPanel(row({ periodNo: 6 }), PAYER, day, NOW)!.lastLine).toContain('the last month');
        expect(standingPanel(row({ standingMaxPeriods: null }), PAYER, day, NOW)!.periodOf).toBeNull();
    });
    it('weekly words', () => {
        const p = standingPanel(row({ standingUnit: 'week', standingMaxPeriods: null }), PAYER, day, NOW)!;
        expect(p.status).toBe("This week's 50 Beans are held · they go to Rob 9 Dec");
        expect(p.holdBackLabel).toBe('Hold back this week');
    });
    it('ended, a one-off deal, or a stranger: no panel', () => {
        expect(standingPanel(row({ standingPhase: 'ended' }), PAYER, day, NOW)).toBeNull();
        expect(standingPanel(row({ standingId: null, standingPhase: null }), PAYER, day, NOW)).toBeNull();
        expect(standingPanel(row(), 'c'.repeat(64), day, NOW)).toBeNull();
    });
    it('the Stop confirm', () => {
        expect(standingStopConfirm('month')).toEqual({
            title: 'Stop after this month?', body: 'The month under way is still paid. Nothing more is held after it.', yes: 'Stop it', no: 'Keep it',
        });
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

describe('standingStopConfirm: a short deal stops NOW (non-blocking note)', () => {
    it('short, or between its periods (due): nothing is held, so Stop ends it at once, and the question says so', () => {
        for (const phase of ['short', 'due'] as const) {
            for (const unit of ['month', 'week'] as const) {
                expect(standingStopConfirm(unit, phase)).toEqual({
                    title: 'Stop it now?', body: 'It ends now. Nothing is held for it, and nothing more will be.', yes: 'Stop it', no: 'Keep it',
                });
            }
        }
    });
    it('held, or held back: the period under way is still paid, as before', () => {
        expect(standingStopConfirm('month', 'held').title).toBe('Stop after this month?');
        expect(standingStopConfirm('week', 'held_back').title).toBe('Stop after this week?');
    });
});

describe("listingDealLines.finished: a standing deal still running is never 'done' (finding 3)", () => {
    const shortRow = { status: 'completed', standingId: 'sd-1', standingPhase: 'short' as const };
    it("a short deal's row is the period last settled (completed), but the deal runs on: no line", () => {
        expect(listingDealLines.finished(shortRow)).toBeNull();
        expect(listingDealLines.finished({ ...shortRow, standingPhase: 'due' })).toBeNull();
    });
    it('one that has ended, or an older period (no phase), is a finished deal like any other', () => {
        expect(listingDealLines.finished({ ...shortRow, standingPhase: 'ended' })).toBe('That deal is done.');
        expect(listingDealLines.finished({ status: 'completed', standingId: 'sd-1', standingPhase: null })).toBe('That deal is done.');
        expect(listingDealLines.finished({ status: 'cancelled' })).toBe('That deal was cancelled.');
        expect(listingDealLines.finished('completed')).toBe('That deal is done.');
    });
});
