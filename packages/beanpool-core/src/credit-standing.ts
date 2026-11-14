/**
 * The member's own credit card on the Ledger (scratch/fable-design/DESIGN-credit-bar-fable.md, amended by
 * DESIGN-credit-bar-amend-fable.md; Marty, 14 Nov 2026: "yes please implement", S1, the strip under the rainbow): what a
 * member reads about their own Beans and credit line, worked out here, pure, so the phone and the web draw the same card
 * and neither composes a figure or a sentence.
 *
 * - {@link creditStanding}: the state and every figure (owed, held, the line, the part live Offers open, what they can
 *   spend, the next step), built on credit-sight's {@link position}, so the member's card and the givers' row agree.
 * - {@link creditStandingCard}: the headline, the sentence under it, the note, and the spoken sentence of the one button.
 * - {@link creditLineParts}: what the line is made of, in the strip's order, adding up to the line.
 * - {@link creditBarPicture}: where the dot, the stripes and each block of the strip sit on the rainbow.
 * - {@link earningProgress}: earned by trading so far, and what the next 100 Beans traded add, with the engine's own sum.
 * - {@link offerLadder}: what each count of live Offers opens; one copy for both apps, the vouched part in it.
 * - {@link CREDIT_RAINBOW} and {@link CREDIT_METER_ROLES}: the rainbow's own colours (a picture, the same in every look) and
 *   every other colour the card draws, each a library role (brand-colours.ts).
 *
 * Every figure is whole hundredths of a Bean (`*_c`), as the ledger holds it. No server change: every input is in the
 * member's own balance answer (GET /api/ledger/balance), and `vouchedBy` beside it.
 */
import { formatCount, t, tn, word } from './words.js';
import { formatHundredths, beans, MINUS_SIGN, type Hundredths } from './hundredths.js';
import { position, ALMOST_ALL_TENTHS, type CreditPosition } from './credit-sight.js';
import { OFFER_BANDS, earnedCreditFromValue } from './protocol.js';
import { CIRCULATION_FREE_BEANS, monthlyCirculation } from './circulation.js';
import { BRAND_COLOURS, brandCssVariableName, colourIn, type BrandSet, type Themed } from './brand-colours.js';

const whole = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0);
const atLeast0 = (n: unknown): number => Math.max(0, whole(n));
/** A figure as the card writes it: to the hundredth where there is one, no sign. */
const B = (c: number) => formatHundredths(Math.abs(c));

// ── The offer ladder ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What each count of live Offers opens of a line (core usableAllowance, one copy for both apps). `openedByOne` is the part
 * one live Offer opens whole: the confirmed member's part and the credit line people gave them (a vouch, a member's gift:
 * `knownGrant_c + roomHeld_c`). The rest (earned, from before) keeps OFFER_BANDS. `rungs` are the depths a further Offer
 * opens, strictly inside the line: none for a line one Offer opens whole (the stray "200" tick of F3 was one).
 */
export function offerLadder(line_c: number, openedByOne_c = 0): { openAt: (offers: number) => Hundredths; offersForFull: number; rungs: Hundredths[] } {
    const line = atLeast0(Math.abs(whole(line_c)));
    const one = Math.min(line, atLeast0(openedByOne_c));
    const other = line - one;
    const openAt = (offers: number) => {
        const i = Math.max(0, Math.min(OFFER_BANDS.length - 1, Math.floor(Number.isFinite(offers) ? offers : 0)));
        return Math.min(line, (i >= 1 ? one : 0) + Math.min(other, OFFER_BANDS[i]!));
    };
    let offersForFull = OFFER_BANDS.length - 1;
    for (let n = 0; n < OFFER_BANDS.length; n++) if (openAt(n) >= line) { offersForFull = n; break; }
    const rungs = [...new Set(OFFER_BANDS.map((_, n) => openAt(n)))].filter((b) => b > 0 && b < line);
    return { openAt, offersForFull, rungs };
}

// ── The answer the card reads ────────────────────────────────────────────────────────────────────────────────────

/** One voucher's vouch, as `vouchedBy` carries it (oldest first). */
export interface VouchRow {
    callsign: string;
    amount_c: number;
}

/** The member's own balance answer, as either app holds it. Every field may be absent from an older node. */
export interface CreditStandingAnswer {
    balance_c?: number;
    /** The limit: 0 or below. */
    floor_c?: number;
    /** How deep live Offers open now: between the limit and 0. */
    usableFloor_c?: number;
    knownGrant_c?: number;
    roomHeld_c?: number;
    earnedCredit_c?: number;
    liveOffers?: number;
    /** An admin froze the whole line (the manager's Freeze). */
    creditFrozen?: boolean;
    vouchedBy?: readonly VouchRow[] | null;
}

export type CreditStandingState =
    | 'frozen'
    | 'no_line'
    | 'paused_over'
    | 'paused_offers'
    | 'at_limit'
    | 'nearly'
    | 'owing'
    | 'zero'
    | 'holding';

export interface CreditStanding {
    state: CreditStandingState;
    position: CreditPosition;
    balance_c: Hundredths;
    owed_c: Hundredths;
    held_c: Hundredths;
    /** The whole credit line. */
    line_c: Hundredths;
    /** The part live Offers open now (never more than the line). */
    open_c: Hundredths;
    /** The part closed until another Offer is posted. */
    closed_c: Hundredths;
    /** What they can spend now: Home's `room_c` (balance less the usable floor, never below 0). */
    canSpend_c: Hundredths;
    /** What is left of the open line before the limit: open less owed, never below 0. */
    left_c: Hundredths;
    liveOffers: number;
    /** What one more live Offer opens, where it opens more than now; null otherwise. */
    nextOpen_c: Hundredths | null;
    offersForFull: number;
    /** Nine tenths or more of the line used: the givers' own "almost all" (credit-sight ALMOST_ALL_TENTHS). */
    near: boolean;
    /** Beans held above the monthly fee's start, and about what this month's fee on them is. */
    aboveFee_c: Hundredths;
    monthFee_c: Hundredths;
    /** No live Offer, so the whole line is asleep. */
    asleep: boolean;
}

/** The state and every figure of the card. First match wins: frozen, no line, paused, at the limit, nearly, by balance. */
export function creditStanding(a: CreditStandingAnswer): CreditStanding {
    const line = a.creditFrozen ? 0 : Math.abs(Math.min(0, whole(a.floor_c)));
    const usableFloor = a.usableFloor_c === undefined ? -line : Math.min(0, whole(a.usableFloor_c));
    const open = Math.min(line, Math.abs(usableFloor));
    const p = position(whole(a.balance_c), line, open);
    const liveOffers = atLeast0(a.liveOffers);
    const ladder = offerLadder(line, atLeast0(a.knownGrant_c) + atLeast0(a.roomHeld_c));
    const next = ladder.openAt(liveOffers + 1);
    const held = p.balance_c > 0 ? p.balance_c : 0;
    const near = line > 0 && p.owed_c > 0 && p.owed_c * 10 >= line * ALMOST_ALL_TENTHS;
    const state: CreditStandingState = a.creditFrozen ? 'frozen'
        : p.over_c > 0 ? 'paused_over'
        : p.paused ? 'paused_offers'
        : line === 0 ? 'no_line'
        : p.owed_c > 0 && p.owed_c >= line ? 'at_limit'
        : near && open >= line ? 'nearly'
        : p.sign === 'minus' ? 'owing'
        : p.sign === 'zero' ? 'zero'
        : 'holding';
    return {
        state,
        position: p,
        balance_c: p.balance_c,
        owed_c: p.owed_c,
        held_c: held,
        line_c: line,
        open_c: open,
        closed_c: line - open,
        canSpend_c: Math.max(0, p.balance_c + open),
        left_c: Math.max(0, open - p.owed_c),
        liveOffers,
        nextOpen_c: next > open ? next : null,
        offersForFull: ladder.offersForFull,
        near,
        aboveFee_c: Math.max(0, held - CIRCULATION_FREE_BEANS),
        monthFee_c: monthlyCirculation(held),
        asleep: line > 0 && open === 0,
    };
}

// ── The words ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The words under the rainbow's marks, and the card's own. */
export const CREDIT_STANDING_WORDS = {
    limit: word('your limit'),
    balanced: word('balanced'),
    feeStarts: word('monthly fee starts'),
    noLineYet: word('no credit line yet'),
    opens: word('Opens how this works.'),
    /** Each mark's one line, under it from 640 px wide (amendment §2); on a narrow screen the sheet carries them. */
    limitLine: word('The lowest your balance can go.'),
    balancedLine: word('You have given as much as you have received.'),
    noLineLine: word('This side opens with your first completed trade.'),
    /**
     * The card when the member's balance couldn't be read: said so, with a way to try again. Never a figure, a state or a
     * note from an answer that isn't there (an empty answer reads as "no credit line yet", which is untrue for most).
     */
    unread: word('Your credit line couldn’t be read just now.'),
};

/** A note under the sentence: its tone (a library chip), its sign (never colour alone) and its words. */
export interface CreditNote {
    tone: 'warn' | 'danger' | 'quiet' | 'ok';
    icon: '!' | '🔒' | '🌱';
    text: string;
}

export interface CreditStandingCard {
    headline: string;
    sentence: string;
    note: CreditNote | null;
    /** The parts line under the bar ("Credit line 500: □ @Damo vouched 500"); null with no line. */
    parts: string | null;
    /** The one button's label: the sentences in order, the limit as "minus", the parts, and what a tap opens. */
    spoken: string;
}

/** "You owe 50 Beans" / "You hold 120 Beans" / "You are at zero". */
function headlineOf(s: CreditStanding): string {
    if (s.owed_c > 0) return t('You owe {amount} Beans', { amount: B(s.owed_c) });
    if (s.held_c > 0) return t('You hold {amount} Beans', { amount: B(s.held_c) });
    return t('You are at zero');
}

/** The note for a line part of which live Offers hold back (closed > 0, some open). */
function closedNote(s: CreditStanding): CreditNote | null {
    if (s.closed_c <= 0 || s.nextOpen_c === null) return null;
    const text = s.nextOpen_c >= s.line_c
        ? t('{closed} is closed for now. One more live Offer opens all of it.', { closed: B(s.closed_c) })
        : tn(s.offersForFull,
            '{closed} is closed for now. One more live Offer opens {next} of your {line}, and {n} live Offer opens all of it.',
            '{closed} is closed for now. One more live Offer opens {next} of your {line}, and {n} live Offers open all of it.',
            { closed: B(s.closed_c), next: B(s.nextOpen_c), line: B(s.line_c), n: formatCount(s.offersForFull) });
    return { tone: 'quiet', icon: '🔒', text };
}

/** The asleep note: no live Offer, so none of the line is open. */
function asleepNote(s: CreditStanding): CreditNote {
    const first = offerLadderOpenAtOne(s);
    const text = first >= s.line_c
        ? t('Your {line} credit line is asleep. Post one Offer and all of it opens.', { line: B(s.line_c) })
        : t('Your {line} credit line is asleep. Post one Offer and {open} of it opens.', { line: B(s.line_c), open: B(first) });
    return { tone: 'quiet', icon: '🔒', text };
}
/** What one live Offer would open, from the state's own figures: the next step from none. */
const offerLadderOpenAtOne = (s: CreditStanding): number => (s.liveOffers === 0 && s.nextOpen_c !== null ? s.nextOpen_c : s.open_c);

const NO_LINE_NOTE = (): CreditNote => ({
    tone: 'ok',
    icon: '🌱',
    text: t('Your credit line opens with your first completed trade, or when someone who gives credit here vouches for you.'),
});

/** The sentence under the headline, and the note, for each state (DESIGN-credit-bar-fable.md §6, amended §3). */
function sentenceOf(s: CreditStanding): { sentence: string; note: CreditNote | null } {
    const line = B(s.line_c);
    switch (s.state) {
        case 'frozen':
            return { sentence: t('Your credit line is frozen by an admin. You can still sell and receive Beans.'), note: null };
        case 'paused_over':
            return {
                sentence: t('Spending paused: you owe {over} more than your credit line.', { over: B(s.position.over_c) }),
                note: { tone: 'danger', icon: '!', text: t('Selling or receiving Beans brings you back. Nothing is taken from you.') },
            };
        case 'paused_offers':
            return {
                sentence: s.liveOffers === 0
                    ? t('Spending paused: you have no live Offer, so your {line} credit line is asleep, and you owe {owed}.', { line, owed: B(s.owed_c) })
                    : tn(s.liveOffers,
                        'Spending paused: your live Offer opens {open} of your {line} credit line, and you owe {owed}.',
                        'Spending paused: your {n} live Offers open {open} of your {line} credit line, and you owe {owed}.',
                        { open: B(s.open_c), line, owed: B(s.owed_c), n: formatCount(s.liveOffers) }),
                note: { tone: 'danger', icon: '!', text: t('Post an Offer, or sell, to lift it. You can still sell and receive Beans.') },
            };
        case 'no_line':
            return {
                sentence: s.held_c > 0
                    ? t('You can spend the {held} Beans you hold.', { held: B(s.held_c) })
                    : t('No credit line yet, so there is nothing to spend and nothing to repay.'),
                note: NO_LINE_NOTE(),
            };
        case 'at_limit':
            return {
                sentence: t('You have used all of your {line} credit line.', { line }),
                note: { tone: 'danger', icon: '!', text: t('You can’t buy until you sell or receive Beans. Nothing is taken from you, and owing costs nothing.') },
            };
        case 'nearly':
            return {
                sentence: t('Only {left} left of your {line} credit line.', { left: B(s.left_c), line }),
                note: { tone: 'warn', icon: '!', text: t('Sell or receive Beans to make room. Owing costs nothing.') },
            };
        case 'owing':
            return {
                sentence: s.closed_c > 0
                    ? tn(s.liveOffers,
                        'You can spend {left} more: your live Offer opens {open} of your {line} credit line.',
                        'You can spend {left} more: your {n} live Offers open {open} of your {line} credit line.',
                        { left: B(s.left_c), open: B(s.open_c), line, n: formatCount(s.liveOffers) })
                    : t('You can spend {left} more of your {line} credit line.', { left: B(s.left_c), line }),
                note: closedNote(s),
            };
        case 'zero':
            if (s.asleep) return { sentence: t('You can’t spend below zero yet.'), note: asleepNote(s) };
            return {
                sentence: s.closed_c > 0
                    ? tn(s.liveOffers,
                        'You have given as much as you have received. Your live Offer opens {open} of your {line} credit line.',
                        'You have given as much as you have received. Your {n} live Offers open {open} of your {line} credit line.',
                        { open: B(s.open_c), line, n: formatCount(s.liveOffers) })
                    : t('You have given as much as you have received. You can spend {line} from your credit line.', { line }),
                note: closedNote(s),
            };
        case 'holding': {
            const fee: CreditNote | null = s.aboveFee_c > 0
                ? {
                    tone: 'warn',
                    icon: '!',
                    text: t('{above} of your Beans are above {free}. A small monthly fee on them goes to the Commons: about {fee} this month.',
                        { above: B(s.aboveFee_c), free: B(CIRCULATION_FREE_BEANS), fee: B(s.monthFee_c) }),
                }
                : null;
            // Asleep above 200: the note that names the action wins (director, 14 Nov): one Offer opens the line. The label
            // above the dot stays gold, and the +200 mark says where the fee starts.
            if (s.asleep) {
                return { sentence: t('You can spend the {held} Beans you hold. You can’t spend below zero yet.', { held: B(s.held_c) }), note: asleepNote(s) };
            }
            return {
                sentence: s.closed_c > 0
                    ? t('You can spend {spend}: your {held} Beans, then {open} of your {line} credit line.', { spend: B(s.canSpend_c), held: B(s.held_c), open: B(s.open_c), line })
                    : t('You can spend {spend}: your {held} Beans, then your {line} credit line.', { spend: B(s.canSpend_c), held: B(s.held_c), line }),
                note: fee ?? closedNote(s),
            };
        }
    }
}

/** The card's words: headline, sentence, note, the parts line and the spoken sentence of the one button. */
export function creditStandingCard(a: CreditStandingAnswer): CreditStandingCard {
    const s = creditStanding(a);
    const { sentence, note } = sentenceOf(s);
    const parts = creditLineParts(a);
    const headline = headlineOf(s);
    const spokenParts = [
        `${headline}.`,
        sentence,
        ...(note ? [note.text] : []),
        ...(s.line_c > 0 ? [t('Your limit is minus {line}.', { line: B(s.line_c) })] : []),
        // Every piece the parts line shows, in its order (F16): the passed-on part and the community's most too.
        ...(parts.said.length > 0 ? [t('Your credit line: {parts}.', { parts: parts.said.join(', ') })] : []),
        t(CREDIT_STANDING_WORDS.opens),
    ];
    return { headline, sentence, note, parts: parts.line, spoken: spokenParts.join(' ') };
}

// ── The parts of the line ────────────────────────────────────────────────────────────────────────────────────────

export type CreditPartKind = 'earned' | 'before' | 'confirmed' | 'given' | 'vouch';

export interface CreditPart {
    kind: CreditPartKind;
    /** Solid: earned by their own trading. Outlined: someone stands behind it for them. */
    solid: boolean;
    /** The part's own figure, as the parts line names it. */
    amount_c: Hundredths;
    /** What of it counts in the line now: the community's most may cut it, and passing room on lowers the vouches. */
    inLine_c: Hundredths;
    /** "Earned by trading 200", "@Jane vouched 200", … */
    text: string;
}

export interface CreditLineParts {
    /** In the strip's order, left (the limit) to right (0): earned, from before, confirmed, given, then the vouches latest first. */
    items: CreditPart[];
    line_c: Hundredths;
    /** The community's most cut the parts: the line is it. */
    capped: boolean;
    /** Credit line they passed on to another member out of what was vouched for them. */
    passedOn_c: Hundredths;
    /** Each piece of the parts line in its order, without the ■ □ signs: what the spoken sentence reads. Empty with no line. */
    said: string[];
    /** "Credit line 700: ■ Earned by trading 200 · □ @Jane vouched 200"; null with no line. */
    line: string | null;
}

/**
 * What the line is made of (amendment §4): earned + from before + confirmed + given + vouched, never more than the
 * community's most, the `inLine_c` of the items adding up to the line exactly. Every part is read from the balance answer:
 * `roomHeld_c` is what people gave less what was passed on; the vouches are `vouchedBy`; "from before" is what the line
 * holds beyond the parts named (the engine's older `grantedCredit`).
 */
export function creditLineParts(a: CreditStandingAnswer): CreditLineParts {
    const s = creditStanding(a);
    const line = s.line_c;
    if (line <= 0 || s.state === 'frozen') return { items: [], line_c: 0, capped: false, passedOn_c: 0, said: [], line: null };
    const earned = atLeast0(a.earnedCredit_c);
    const known = atLeast0(a.knownGrant_c);
    const room = atLeast0(a.roomHeld_c);
    const vouches = (a.vouchedBy ?? []).filter((v) => v && typeof v.callsign === 'string' && whole(v.amount_c) > 0);
    const vouchSum = vouches.reduce((sum, v) => sum + whole(v.amount_c), 0);
    const given = Math.max(0, room - vouchSum);
    const passedOn = Math.max(0, vouchSum - room);
    const named = earned + known + room;
    const before = Math.max(0, line - named);
    const capped = named > line;

    // In the strip's order: earned and from before (the offer bands meter them, so the closed part falls there), then the
    // parts one live Offer opens whole, the earliest vouch nearest zero (the node counts a departure against it first).
    const raw: Array<Omit<CreditPart, 'inLine_c'>> = [
        { kind: 'earned', solid: true, amount_c: earned, text: earned > 0 ? t('Earned by trading {amount}', { amount: B(earned) }) : t('Earned by trading {amount} so far', { amount: B(0) }) },
        ...(before > 0 ? [{ kind: 'before' as const, solid: false, amount_c: before, text: t('From before {amount}', { amount: B(before) }) }] : []),
        ...(known > 0 ? [{ kind: 'confirmed' as const, solid: false, amount_c: known, text: t('Confirmed member {amount}', { amount: B(known) }) }] : []),
        ...(given > 0 ? [{ kind: 'given' as const, solid: false, amount_c: given, text: t('Given by members {amount}', { amount: B(given) }) }] : []),
        ...vouches.slice().reverse().map((v) => ({ kind: 'vouch' as const, solid: false, amount_c: whole(v.amount_c), text: t('@{name} vouched {amount}', { name: v.callsign, amount: B(whole(v.amount_c)) }) })),
    ];
    // What counts now: the vouches less what was passed on (from the latest, farthest from zero), then the community's most
    // cuts from the left (the earned part, the one the offer bands meter).
    const inLine = raw.map((p) => p.amount_c);
    let pass = passedOn;
    for (let i = 0; i < raw.length && pass > 0; i++) {
        if (raw[i]!.kind !== 'vouch') continue;
        const c = Math.min(pass, inLine[i]!);
        inLine[i]! -= c;
        pass -= c;
    }
    let cut = inLine.reduce((x, y) => x + y, 0) - line;
    for (let i = 0; i < inLine.length && cut > 0; i++) {
        const c = Math.min(cut, inLine[i]!);
        inLine[i]! -= c;
        cut -= c;
    }
    const items = raw.map((p, i) => ({ ...p, inLine_c: inLine[i]! }));
    const shown = items.map((p) => `${p.solid ? '■' : '□'} ${p.text}`);
    const extras = [
        ...(passedOn > 0 ? [t('you gave {amount} to another member', { amount: B(passedOn) })] : []),
        ...(capped ? [t('this community’s most is {amount}', { amount: B(line) })] : []),
    ];
    const text = t('Credit line {amount}: {parts}', { amount: B(line), parts: [...shown, ...extras].join(' · ') });
    // The ear gets the same pieces as the eye, in the same order: one list, so neither can leave a piece out.
    return { items, line_c: line, capped, passedOn_c: passedOn, said: [...items.map((p) => p.text), ...extras], line: text };
}

// ── The picture ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Where the rainbow's left end (the limit), its zero and the +200 mark sit, in percent of the track. */
export const BAR_LIMIT_AT = 4;
export const BAR_ZERO_AT = 50;
/** The right half's scale, as today's: Beans held → percent. */
const RIGHT_SCALE: ReadonlyArray<readonly [number, number]> = [[0, 50], [beans(200), 68], [beans(500), 80], [beans(1000), 90], [beans(2000), 98]];
export const BAR_FEE_AT = 68;
const BAR_END = 98;

export interface CreditBarBlock {
    kind: CreditPartKind;
    solid: boolean;
    /** Left edge and width, in percent of the track. */
    from: number;
    width: number;
}

/** One mark under the track. `figure` is empty for the left end with no line yet ("no credit line yet"). */
export interface CreditBarMark {
    at: number;
    figure: string;
    words: string;
    line: string;
}

export interface CreditBarPicture {
    /** The dot's place, in percent of the track. */
    dot: number;
    /** The label above the dot ("−50 Beans") and its tone: calm (dark), near (red at nine tenths), fee (gold above 200). */
    label: string;
    tone: 'calm' | 'near' | 'fee';
    /** The closed part, striped, from the left end: null when nothing is closed. */
    stripes: { from: number; width: number } | null;
    /** The strip under the left half, one block per part, left to right, widths adding up to the left half. */
    blocks: CreditBarBlock[];
    /** The marks under the track: the figure at its place, a word or two under it, and its one line (wide screens). */
    marks: { limit: CreditBarMark; zero: CreditBarMark; fee: CreditBarMark };
    /** No credit line yet: the left half is striped and says so. */
    noLine: boolean;
}

/** A balance on the track: the left half straight from the limit to 0; the right half today's scale. Rises with the balance. */
export function barPlace(balance_c: number, line_c: number): number {
    const b = whole(balance_c);
    const line = atLeast0(line_c);
    if (b >= 0) {
        for (let i = 0; i < RIGHT_SCALE.length - 1; i++) {
            const [v0, p0] = RIGHT_SCALE[i]!;
            const [v1, p1] = RIGHT_SCALE[i + 1]!;
            if (b <= v1) return p0 + ((b - v0) / (v1 - v0)) * (p1 - p0);
        }
        return BAR_END;
    }
    if (line === 0) return BAR_LIMIT_AT;
    return Math.max(BAR_LIMIT_AT, BAR_ZERO_AT - ((BAR_ZERO_AT - BAR_LIMIT_AT) * Math.min(-b, line)) / line);
}

/** The label on the dot: "−50 Beans", "+120 Beans", "0 Beans" (a real minus, the figure to the hundredth). */
function labelOf(balance_c: number): string {
    const sign = balance_c > 0 ? '+' : balance_c < 0 ? MINUS_SIGN : '';
    return t('{amount} Beans', { amount: `${sign}${B(balance_c)}` });
}

/** The picture's numbers: the dot, its label, the stripes, the strip's blocks and the marks. */
export function creditBarPicture(a: CreditStandingAnswer): CreditBarPicture {
    const s = creditStanding(a);
    const parts = creditLineParts(a);
    const half = BAR_ZERO_AT - BAR_LIMIT_AT;
    const share = (c: number) => (s.line_c > 0 ? (half * c) / s.line_c : 0);
    const blocks: CreditBarBlock[] = [];
    let at = BAR_LIMIT_AT;
    for (const p of parts.items) {
        if (p.inLine_c <= 0) continue;
        const width = share(p.inLine_c);
        blocks.push({ kind: p.kind, solid: p.solid, from: at, width });
        at += width;
    }
    const noLine = s.line_c === 0;
    const stripes = noLine ? { from: BAR_LIMIT_AT, width: half } : s.closed_c > 0 ? { from: BAR_LIMIT_AT, width: share(s.closed_c) } : null;
    const tone = s.near || s.position.over_c > 0 ? 'near' : s.held_c > CIRCULATION_FREE_BEANS ? 'fee' : 'calm';
    return {
        dot: barPlace(s.balance_c, s.line_c),
        label: labelOf(s.balance_c),
        tone,
        stripes,
        blocks,
        marks: {
            limit: noLine
                ? { at: BAR_LIMIT_AT, figure: '', words: t(CREDIT_STANDING_WORDS.noLineYet), line: t(CREDIT_STANDING_WORDS.noLineLine) }
                : { at: BAR_LIMIT_AT, figure: `${MINUS_SIGN}${B(s.line_c)}`, words: t(CREDIT_STANDING_WORDS.limit), line: t(CREDIT_STANDING_WORDS.limitLine) },
            zero: { at: BAR_ZERO_AT, figure: B(0), words: t(CREDIT_STANDING_WORDS.balanced), line: t(CREDIT_STANDING_WORDS.balancedLine) },
            fee: {
                at: BAR_FEE_AT,
                figure: `+${B(CIRCULATION_FREE_BEANS)}`,
                words: t(CREDIT_STANDING_WORDS.feeStarts),
                line: t('Hold more than {free} Beans and a small monthly fee starts on the part above.', { free: B(CIRCULATION_FREE_BEANS) }),
            },
        },
        noLine,
    };
}

// ── Earning ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The member's progress in earning their own line, with the engine's own sum (trust.ts earnedCreditOf). */
export function earningProgress(o: { qualifiedValue?: number; avgRating?: number; reviewCount?: number }): { traded_c: Hundredths; earned_c: Hundredths; nextHundred_c: Hundredths } {
    const value = atLeast0(o.qualifiedValue);
    const reviews = atLeast0(o.reviewCount);
    const rating = typeof o.avgRating === 'number' && Number.isFinite(o.avgRating) ? o.avgRating : 5;
    const multiplier = reviews > 0 ? 0.5 + 0.5 * (rating / 5) : 1;
    const earnedAt = (v: number) => Math.max(0, Math.floor(earnedCreditFromValue(v) * multiplier));
    const earned = earnedAt(value);
    return { traded_c: value, earned_c: earned, nextHundred_c: earnedAt(value + beans(100)) - earned };
}

// ── Colours ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The rainbow: a picture, the same in every look, as the logo and the map pins keep theirs (amendment §8). Main's eight
 * stops and their places, the white zero line, the white dot with its dark ring, and the calm label (white words on the
 * ring's dark). One copy for both apps; each `CreditBar.tsx` had its own.
 */
export const CREDIT_RAINBOW = {
    stops: ['#bb4b32', '#cf6a3f', '#e0a35a', '#7ccb90', '#2f9e44', '#7ccb90', '#e0a35a', '#c07d2a'],
    at: [0.04, 0.17, 0.29, 0.4, 0.5, 0.6, 0.74, 0.96],
    zeroLine: '#ffffff',
    dot: '#ffffff',
    ring: '#16211b',
    tag: '#16211b',
    tagOn: '#ffffff',
} as const;

/**
 * Every other colour the card draws: a path into the library (brand-colours.ts), per look. Words reach 4.5:1 and marks
 * 3:1 on each app's card in every look (core test). The web reads them as CSS variables, the phone per set.
 */
export const CREDIT_METER_ROLES = {
    /** "−500" and "your limit". */
    limitInk: 'ink.danger',
    /** "0" and "balanced". */
    zeroInk: 'ink.success',
    /** "+200" and "monthly fee starts", and the stem under the track at 200. */
    feeInk: 'ink.warning',
    /** The label at nine tenths used, or past the line: white words on red. */
    nearFill: 'danger.fill',
    nearOn: 'danger.on',
    /** The label above 200: dark words on gold. */
    feeFill: 'gold.fill',
    feeOn: 'gold.on',
    /** The strip's blocks: solid and outlined. */
    strip: 'chip.quiet.ink',
    warnTint: 'chip.warn.tint',
    warnInk: 'chip.warn.ink',
    dangerTint: 'chip.danger.tint',
    dangerInk: 'chip.danger.ink',
    quietTint: 'chip.quiet.tint',
    quietInk: 'chip.quiet.ink',
    okTint: 'chip.ok.tint',
    okInk: 'chip.ok.ink',
} as const;
export type CreditMeterRole = keyof typeof CREDIT_METER_ROLES;

/** A library leaf by its path ("ink.danger"); throws on a path the library doesn't hold. */
export function libraryLeaf(path: string): Themed {
    let node: unknown = BRAND_COLOURS;
    for (const key of path.split('.')) node = (node as Record<string, unknown> | undefined)?.[key];
    const leaf = node as Themed | undefined;
    if (!leaf || typeof leaf.light !== 'string' || typeof leaf.dark !== 'string') throw new Error(`no library colour at ${path}`);
    return leaf;
}

/** The meter's colours in one look, as hex (the phone). */
export function creditMeterColours(set: BrandSet): Record<CreditMeterRole, string> {
    const out = {} as Record<CreditMeterRole, string>;
    for (const [role, path] of Object.entries(CREDIT_METER_ROLES) as Array<[CreditMeterRole, string]>) out[role] = colourIn(libraryLeaf(path), set);
    return out;
}

/** The meter's colours as the web's CSS variables (`var(--bp-ink-danger)`), which follow the look on their own. */
export function creditMeterCss(): Record<CreditMeterRole, string> {
    const out = {} as Record<CreditMeterRole, string>;
    for (const [role, path] of Object.entries(CREDIT_METER_ROLES) as Array<[CreditMeterRole, string]>) out[role] = `var(${brandCssVariableName(path)})`;
    return out;
}

/** The label's fill and words for a tone. */
export function creditLabelColours(tone: CreditBarPicture['tone'], meter: Record<CreditMeterRole, string>): { fill: string; on: string } {
    if (tone === 'near') return { fill: meter.nearFill, on: meter.nearOn };
    if (tone === 'fee') return { fill: meter.feeFill, on: meter.feeOn };
    return { fill: CREDIT_RAINBOW.tag, on: CREDIT_RAINBOW.tagOn };
}

/** A note's tint and words for its tone. */
export function creditNoteColours(tone: CreditNote['tone'], meter: Record<CreditMeterRole, string>): { tint: string; ink: string } {
    switch (tone) {
        case 'danger': return { tint: meter.dangerTint, ink: meter.dangerInk };
        case 'warn': return { tint: meter.warnTint, ink: meter.warnInk };
        case 'ok': return { tint: meter.okTint, ink: meter.okInk };
        default: return { tint: meter.quietTint, ink: meter.quietInk };
    }
}
