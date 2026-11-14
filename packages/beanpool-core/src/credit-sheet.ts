/**
 * What a tap on the member's own credit card opens: the sheet "Your Beans and your credit line"
 * (scratch/fable-design/DESIGN-credit-bar-amend-fable.md §6, slice R2; Marty decided the amendment on 14 Nov 2026). One sheet,
 * the same on the phone and the web, in six short parts, every figure the member's own:
 *
 * 1. Reading the bar: each mark with its one line (§2), and what each side of 0 means.
 * 2. Your credit line: what it is made of, part by part, the total, what live Offers open and the member's own state.
 * 3. Earn your own: the plain rules of earning (§4) and the member's own progress, with the engine's own sum.
 * 4. What can change it: a vouch is for good, what admins can do, more vouchers, leaving owing, the community's most.
 * 5. The two fees: the market fee and the monthly fee above 200, from the protocol's own figures.
 * 6. Who can see this: the credit list's one sentence, and the two ways on.
 *
 * Built on credit-standing.ts (the same answer the card reads), so the card and its sheet cannot disagree. Pure: neither app
 * composes a figure or a sentence. Every figure is whole hundredths of a Bean (`*_c`).
 */
import { formatCount, formatNumber, t, tn, word } from './words.js';
import { MINUS_SIGN, beans, formatHundredths, FEE_NUM, FEE_DEN } from './hundredths.js';
import { OFFER_BANDS, PROTOCOL_CONSTANTS, PER_COUNTERPARTY_VOLUME_CAP, earnedCreditFromValue } from './protocol.js';
import { CIRCULATION_BRACKETS, CIRCULATION_FREE_BEANS } from './circulation.js';
import { CREDIT_SIGHT_WORDS } from './credit-sight.js';
import { PERSON_VOUCH_MAX, PERSON_VOUCH_MAX_WITH_OWNER, VOUCHES_PER_PERSON } from './vouch-presets.js';
import {
    creditBarPicture,
    creditLineParts,
    creditStanding,
    creditStandingCard,
    earningProgress,
    type CreditPartKind,
    type CreditStandingAnswer,
} from './credit-standing.js';

const B = (c: number) => formatHundredths(Math.abs(c));
/** A figure in whole Beans, for "about": the rules' rough guide and the next step, cut down as the engine cuts (design §0.6). */
const about = (c: number) => formatCount(Math.floor(Math.max(0, c) / 100));

/** The sheet's title, and its six parts' titles, in their order. */
export const CREDIT_SHEET_WORDS = {
    title: word('Your Beans and your credit line'),
    reading: word('Reading the bar'),
    lineNone: word('Your credit line'),
    earn: word('Earn your own'),
    change: word('What can change it'),
    fees: word('The two fees'),
    who: word('Who can see this'),
    /** The two ways on from part 6 (the app draws the › after each). */
    guide: word('More in the guide'),
};

/** The six parts, in their order, the same on both apps. */
export const CREDIT_SHEET_PARTS = ['reading', 'line', 'earn', 'change', 'fees', 'who'] as const;
export type CreditSheetPartId = (typeof CREDIT_SHEET_PARTS)[number];

/**
 * What the app draws small beside a row (never colour alone: each is a shape). `dot`, `zero`, `limit` and `fee` are the bar's
 * marks (with their `figure`); `strip` a solid and an outlined block; `stripes` the closed part; `colours` the rainbow; `left`
 * and `right` the halves; `solid` and `outlined` a part of the line; `total` the line; `open` all of it open (✓), `closed`
 * part or all of it closed (🔒); `progress` the member's own earning.
 */
export type CreditSheetMark =
    | 'dot' | 'zero' | 'limit' | 'fee' | 'strip' | 'stripes' | 'colours' | 'left' | 'right'
    | 'solid' | 'outlined' | 'total' | 'open' | 'closed' | 'progress';

export interface CreditSheetRow {
    text: string;
    /** A line under the row's words (a part's own line in part 2). */
    line?: string;
    mark?: CreditSheetMark;
    /** The mark's figure ("−500", "0", "+200"), where it has one. */
    figure?: string;
    /** In part 2: which part of the line this row is. */
    kind?: CreditPartKind;
}

export interface CreditSheetPart {
    id: CreditSheetPartId;
    title: string;
    rows: CreditSheetRow[];
}

export interface CreditSheet {
    title: string;
    parts: CreditSheetPart[];
    /** Part 6's two ways on: the member's own "What people who give credit see", and the guide's credit-line page. */
    links: { givers: string; guide: string; guideSlug: 'credit-line' };
}

/** What the node sends beside the balance about earning (`qualifiedValue` in hundredths), for the member's own progress. */
export interface CreditSheetEarning {
    qualifiedValue?: number;
    avgRating?: number;
    reviewCount?: number;
}

/** Each part of the line's own line, in part 2 (amendment §6). */
function partLine(kind: CreditPartKind, callsign: string | null): string {
    switch (kind) {
        case 'earned': return t('Yours, from your own completed trades. It grows as you trade.');
        case 'before': return t('Credit your community gave you before. It counts in your line.');
        case 'confirmed': return t('Your community’s admins know you and confirmed you.');
        case 'given': return t('Members gave you part of the credit line someone gave them.');
        case 'vouch': return t('@{name} stands behind this part for you.', { name: callsign ?? '' });
    }
}

/** Part 1: each mark drawn small beside its line, then the two sides of 0. */
function readingPart(a: CreditStandingAnswer): CreditSheetPart {
    const pic = creditBarPicture(a);
    const { limit, zero, fee } = pic.marks;
    return {
        id: 'reading',
        title: t(CREDIT_SHEET_WORDS.reading),
        rows: [
            { mark: 'dot', text: t('Where your balance is now.') },
            { mark: 'zero', figure: zero.figure, text: zero.line },
            { mark: 'limit', figure: limit.figure, text: limit.line },
            { mark: 'fee', figure: fee.figure, text: fee.line },
            { mark: 'strip', text: t('What your credit line is made of. A solid block is credit you earned by trading. An outlined block is credit someone stands behind for you.') },
            { mark: 'stripes', text: t('Closed for now. Your live Offers open it.') },
            { mark: 'colours', text: t('Green: near zero. Orange, then red, on the left: closer to your limit. Orange on the right: Beans above {free}.', { free: B(CIRCULATION_FREE_BEANS) }) },
            { mark: 'left', text: t('Left of 0: you owe Beans. Owing costs nothing: there is no interest. It is a promise to help others later.') },
            { mark: 'right', text: t('Right of 0: Beans you hold.') },
        ],
    };
}

/** What each count of live Offers opens, in words, from OFFER_BANDS. */
function offersRule(): string {
    const b = OFFER_BANDS.map((x) => B(x));
    return t('Your live Offers open it. One live Offer opens everything people stand behind for you, and the first {one} you earned. Two open {two} of what you earned, three {three}, four {four}, five {five}.',
        { one: b[1]!, two: b[2]!, three: b[3]!, four: b[4]!, five: b[5]! });
}

/** Part 2: the line, part by part, the total, what Offers open and the member's own state. */
function linePart(a: CreditStandingAnswer): CreditSheetPart {
    const s = creditStanding(a);
    const parts = creditLineParts(a);
    if (s.state === 'frozen') {
        return { id: 'line', title: t(CREDIT_SHEET_WORDS.lineNone), rows: [{ text: creditStandingCard(a).sentence }] };
    }
    if (s.line_c === 0) {
        return {
            id: 'line',
            title: t(CREDIT_SHEET_WORDS.lineNone),
            rows: [
                { mark: 'stripes', text: t('You have no credit line yet.') },
                { text: t('Your credit line opens with your first completed trade, or when someone who gives credit here vouches for you.') },
            ],
        };
    }
    const rows: CreditSheetRow[] = [
        { text: t('Your balance can go down to {limit}. It is made of:', { limit: `${MINUS_SIGN}${B(s.line_c)}` }) },
        ...parts.items.map((p): CreditSheetRow => ({
            mark: p.solid ? 'solid' : 'outlined',
            kind: p.kind,
            text: p.text,
            line: partLine(p.kind, p.name ?? null),
        })),
        ...(parts.passedOn_c > 0 ? [{ text: t('You gave {amount} of it to another member.', { amount: B(parts.passedOn_c) }) }] : []),
        ...(parts.capped ? [{ text: t('Together the parts come to more than this community’s most, so your line stops at {amount}.', { amount: B(s.line_c) }) }] : []),
        { mark: 'total', text: t('Your whole credit line: {amount}', { amount: B(s.line_c) }) },
        { text: offersRule() },
    ];
    const own: CreditSheetRow = s.open_c >= s.line_c
        ? {
            mark: 'open',
            text: s.liveOffers > 0
                ? tn(s.liveOffers, 'You have {n} live Offer: all {line} is open.', 'You have {n} live Offers: all {line} is open.', { n: formatCount(s.liveOffers), line: B(s.line_c) })
                : t('All of your {line} credit line is open.', { line: B(s.line_c) }),
        }
        : s.liveOffers === 0
            ? { mark: 'closed', text: t('You have no live Offer, so your {line} credit line is asleep. Post one Offer to open it.', { line: B(s.line_c) }) }
            : {
                mark: 'closed',
                text: tn(s.liveOffers, 'You have {n} live Offer: {open} of your {line} is open.', 'You have {n} live Offers: {open} of your {line} is open.',
                    { n: formatCount(s.liveOffers), open: B(s.open_c), line: B(s.line_c) }),
            };
    rows.push(own);
    return { id: 'line', title: t('Your credit line: {amount}', { amount: B(s.line_c) }), rows };
}

/** Part 3: the rules of earning, and the member's own progress where the node sent it. */
function earnPart(a: CreditStandingAnswer, e: CreditSheetEarning | undefined): CreditSheetPart {
    const at = (v: number) => earnedCreditFromValue(beans(v));
    const rows: CreditSheetRow[] = [
        { text: t('Every completed trade in the market counts, for the buyer and the seller alike. A gift of Beans counts for nothing.') },
        { text: t('Trade with one person counts up to {cap} Beans. So trading with more people builds it faster.', { cap: B(PER_COUNTERPARTY_VOLUME_CAP) }) },
        {
            text: t('The first {v1} Beans traded add about {e1}. {v2} traded make {e2}. {v3} make {e3}. It slows as it grows and can never pass {max}.', {
                v1: formatCount(100), e1: about(at(100)), v2: formatCount(500), e2: about(at(500)), v3: formatCount(1000), e3: about(at(1000)),
                max: B(PROTOCOL_CONSTANTS.CREDIT_MAX_EARNED),
            }),
        },
        { text: t('Stars can only lower it: an average of 5 keeps it all, 4 keeps nine tenths, 3 keeps four fifths. No reviews yet: all of it.') },
        { text: t('Trades that only go round a small group count for nothing.') },
        { text: t('It does not fade with time.') },
        { text: t('Your badge reads this part only. A vouch or a confirmation never moves a badge.') },
    ];
    if (e && typeof e.qualifiedValue === 'number') {
        const p = earningProgress(e);
        const earned = typeof a.earnedCredit_c === 'number' && Number.isFinite(a.earnedCredit_c) ? Math.max(0, Math.trunc(a.earnedCredit_c)) : p.earned_c;
        rows.push({
            mark: 'progress',
            text: p.traded_c > 0
                ? t('So far: {traded} Beans traded in the market, {earned} earned. Your next {hundred} Beans traded add about {next}.',
                    { traded: B(p.traded_c), earned: B(earned), hundred: formatCount(100), next: about(p.nextHundred_c) })
                : t('Nothing traded in the market yet. Your first {hundred} Beans traded add about {next}.', { hundred: formatCount(100), next: about(p.nextHundred_c) }),
        });
    }
    return { id: 'earn', title: t(CREDIT_SHEET_WORDS.earn), rows };
}

/** Part 4: what can change the line, said plainly (amendment §4, §6). */
function changePart(a: CreditStandingAnswer): CreditSheetPart {
    const parts = creditLineParts(a);
    return {
        id: 'change',
        title: t(CREDIT_SHEET_WORDS.change),
        rows: [
            { text: t('A vouch is yours for good. It stays if the person who vouched for you stops vouching or leaves. They can’t take it back.') },
            { text: t('Your community’s admins can freeze a credit line. If your line becomes smaller than what you owe, spending pauses until you sell or receive Beans. Nothing is taken from you.') },
            {
                text: t('More people can vouch for you: up to {count}, {all} Beans in all ({owner} when an owner is one of them). They can only vouch while you are at zero or above.',
                    { count: formatCount(VOUCHES_PER_PERSON), all: B(PERSON_VOUCH_MAX), owner: B(PERSON_VOUCH_MAX_WITH_OWNER) }),
            },
            { text: t('If you ever left owing Beans, it would count against the people who vouched for you.') },
            {
                text: parts.capped
                    ? t('All parts together can’t pass this community’s most: {amount}.', { amount: B(parts.line_c) })
                    : t('All parts together can’t pass this community’s most.'),
            },
        ],
    };
}

/** Part 5: the market fee and the monthly fee, from the protocol's own figures (first design §2). */
function feesPart(): CreditSheetPart {
    const pct = (rate: number) => `${formatNumber(rate * 100, rate * 100 % 1 === 0 ? 0 : 1)}%`;
    const [, b1, b2, b3, b4] = CIRCULATION_BRACKETS;
    const edge1 = CIRCULATION_FREE_BEANS + b1!.maxInBracket;
    const edge2 = edge1 + b2!.maxInBracket;
    const edge3 = edge2 + b3!.maxInBracket;
    return {
        id: 'fees',
        title: t(CREDIT_SHEET_WORDS.fees),
        rows: [
            {
                text: t('Market fee, {rate}: on every completed market payment. It comes out of what the seller receives and goes to the Commons. The buyer pays the price and no more. Gifts pay nothing.',
                    { rate: pct(FEE_NUM / FEE_DEN) }),
            },
            {
                text: t('Monthly fee: only on Beans you hold above {free}, each part at its own rate: {r1} up to {e1}, {r2} up to {e2}, {r3} up to {e3}, {r4} above. It goes to the Commons. Owing costs nothing: there is no interest.', {
                    free: B(CIRCULATION_FREE_BEANS),
                    r1: pct(b1!.rate), e1: B(edge1), r2: pct(b2!.rate), e2: B(edge2), r3: pct(b3!.rate), e3: B(edge3), r4: pct(b4!.rate),
                }),
            },
        ],
    };
}

/** The sheet a tap on the card opens: six parts in their order, every figure from the member's own answer. */
export function creditSheet(a: CreditStandingAnswer, earning?: CreditSheetEarning): CreditSheet {
    return {
        title: t(CREDIT_SHEET_WORDS.title),
        parts: [
            readingPart(a),
            linePart(a),
            earnPart(a, earning),
            changePart(a),
            feesPart(),
            { id: 'who', title: t(CREDIT_SHEET_WORDS.who), rows: [{ text: t(CREDIT_SIGHT_WORDS.told) }] },
        ],
        links: { givers: t(CREDIT_SIGHT_WORDS.meTitle), guide: t(CREDIT_SHEET_WORDS.guide), guideSlug: 'credit-line' },
    };
}
