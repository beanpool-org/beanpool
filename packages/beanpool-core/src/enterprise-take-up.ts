/**
 * "Buy for {enterprise}": a keeper takes up a member's Offer priced for each one for the enterprise they keep, in one tap
 * (scratch/fable-design/DESIGN-stall-consignment-fable.md §5.6, §6 slice 2; Marty, 26 Nov 2026). A market stall that sold
 * a member's goods for cash has bought them with Beans: the node's door is POST /api/treasury/:treasury/take-up (slice 1),
 * which holds and releases in one request. One copy, read by the phone's item page and the web's: who sees the button, the
 * confirm sheet's sentence and its figures, the retry id a tap carries, and the words for every refusal the door answers.
 *
 * BeanPool moves Beans only: no cash figure, rate or tick anywhere here, and every amount is written "Beans", never a sign.
 *
 * Pure: no I/O, no Node built-ins (the barrel is bundled for the phone).
 */
import { t, word } from './words.js';
import { feeOf, formatHundredths, isHundredths, type Hundredths } from './hundredths.js';
import { EACH, ITEM_TAKE_UP_REFUSALS, sellerReceives } from './per-item.js';
import { itemTakeUpRefusalIn, type ItemTakeUpSend } from './per-item-deal.js';
import { billAnswerLost, billNewId } from './bills.js';
import { isBusyError } from './busy-answer.js';
import { MONEY_RESEND_HOURS, moneyResendable } from './money-retry.js';

export const TAKE_UP_WORDS = {
    /** The button, one for each enterprise the reader keeps. */
    button: word('Buy for {enterprise}'),
    /** The confirm sheet (design §5.6), word for word. {n} is the total the enterprise pays; {net} what the seller gets. */
    sheet: word('{stall} pays {seller} {n} Beans for {count} of “{title}”. {seller} gets {net} Beans; {fee} Beans go to the Commons. BeanPool moves Beans only. Any cash is between you and the buyer.'),
    // The door's refusals that carry a code and whose words the node says for a member's own take-up, not a keeper's.
    eachOnly: word('An enterprise can take up only an Offer priced for each one.'),
    cancelled: word('That sale was cancelled, so nothing more was paid.'),
    gone: word('This Offer is no longer on the board, so nothing was paid.'),
    dealOpen: word('The enterprise already has a deal under way on this Offer. A keeper can release it from the enterprise’s deals.'),
    twoPeople: word('A keeper can’t buy their own Offer for the enterprise. Another keeper can.'),
    tapReused: word('That tap was already used for a different sale, so nothing was paid. Close this and try again.'),
    copy: word('This is a copy of a listing from another community, so it can’t be bought here.'),
    lent: word('This Offer is lent, not sold, so an enterprise can’t buy it.'),
    /** Anything the node refused without words of its own (the node's fallback, the same sentence). */
    fallback: word('Could not take up this Offer for the enterprise.'),
    /**
     * No answer came to a Confirm (takeUpOutcomeOf 'lost'): the stall may have paid already, so never "nothing was paid".
     * Confirm sends the same sale again with the same id, and the node answers that with the first sale if it went through.
     */
    lost: word('Your community’s server didn’t answer, so {stall} may have paid {seller} already. Press Confirm again to find out: it is never paid twice.'),
    /**
     * A sale whose answer never came, past TAKE_UP_RESEND_HOURS (takeUpUnansweredBook `aged`): it is never sent again, so
     * Confirm is a new sale, and the stall may still have paid for the old one: its deals say (never "nothing was paid").
     */
    aged: word('An earlier sale from here got no answer, so {stall} may have paid {seller} for it already: the enterprise’s deals show whether it did. Confirm makes a new sale.'),
} as const;

const W = TAKE_UP_WORDS;

// ── Who sees the button ──────────────────────────────────────────────────────────────────────────────────────────

/** Whether the node says it has the door (config/node-profile.ts `enterpriseTakeUp`): an older node, or any switch off, says nothing. */
export function enterpriseTakeUpOffered(features: { enterpriseTakeUp?: unknown } | null | undefined): boolean {
    return features?.enterpriseTakeUp === true;
}

/** An enterprise as either app reads it: its key, its name, and whether it can act now. */
export interface TakeUpEnterprise {
    publicKey: string;
    name: string;
    paused?: boolean | null;
    status?: string | null;
}

/** One "Buy for {enterprise}" button. */
export interface TakeUpButton {
    enterprise: string;
    name: string;
    label: string;
}

/**
 * The "Buy for {enterprise}" buttons on a listing, one for each enterprise the reader keeps, in the order the node lists
 * them (the balance read's `keeperOf`: active keepers only). None unless every one of these holds:
 *  - the node says it has the door (`enterpriseTakeUp`);
 *  - the listing is an Offer priced for each one, active, not lent (the door takes no other kind: §6 wiring point 8);
 *  - it is a listing here, not another community's pulled copy (`originNode`, the phone's `origin_node`, the web's
 *    `_remoteNode`): the door takes up a listing here only (acceptPost's assertTradableHere refuses a copy, with no code);
 *  - it is not the reader's own Offer (the engine's two-person rule refuses a keeper buying their own);
 *  - per enterprise: the node lists it by name, it is active and not paused, and the listing is not its own.
 * The listing may be the web's (`priceType`, `authorPublicKey`) or the phone's row (`price_type`, `author_pubkey`).
 */
export function takeUpButtons(args: {
    features: { enterpriseTakeUp?: unknown } | null | undefined;
    listing: unknown;
    me: string | null | undefined;
    keeperOf: readonly string[] | null | undefined;
    enterprises: readonly TakeUpEnterprise[] | null | undefined;
}): TakeUpButton[] {
    if (!enterpriseTakeUpOffered(args.features)) return [];
    const r = args.listing as Record<string, unknown> | null | undefined;
    if (!r || typeof r !== 'object' || !args.me) return [];
    const author = r.authorPublicKey ?? r.author_pubkey;
    const status = r.status ?? 'active';
    if (r.type !== 'offer' || (r.priceType ?? r.price_type) !== EACH || status !== 'active' || Boolean(r.lendable)) return [];
    if (r.originNode || r.origin_node || r._remoteNode) return [];
    if (typeof author !== 'string' || author === '' || author === args.me) return [];
    const known = new Map((args.enterprises ?? []).map((e) => [e.publicKey, e]));
    const out: TakeUpButton[] = [];
    for (const key of new Set(args.keeperOf ?? [])) {
        const e = known.get(key);
        if (!e || key === author || e.paused || (e.status != null && e.status !== 'active')) continue;
        const name = e.name.trim();
        if (!name) continue;
        out.push({ enterprise: key, name, label: t(W.button, { enterprise: name }) });
    }
    return out;
}

// ── The confirm sheet (§5.6) ─────────────────────────────────────────────────────────────────────────────────────

/** The sheet's figures, all whole hundredths: the total the enterprise pays, the fee, and what the seller gets. */
export interface TakeUpSheet {
    sentence: string;
    total_c: Hundredths;
    fee_c: Hundredths;
    net_c: Hundredths;
}

/**
 * The confirm sheet for what the count picker will send (core itemTakeUpBox's `send`): "{stall} pays {seller} {n} Beans for
 * {count} of “{title}”. {seller} gets {net} Beans; {fee} Beans go to the Commons. BeanPool moves Beans only. Any cash is
 * between you and the buyer." The total is the box's own `expect_c` (what the node is told the screen showed); the fee is
 * core's feeOf on it, once, and the seller's share is sellerReceives, the two functions the node's release pays with. Null
 * while the box has nothing to send.
 */
export function takeUpSheet(send: ItemTakeUpSend | null | undefined, names: { stall: string; seller: string; title: string }): TakeUpSheet | null {
    if (!send || !isHundredths(send.expect_c) || send.expect_c < 0) return null;
    const total_c = send.expect_c;
    const fee_c = feeOf(total_c);
    const net_c = sellerReceives(total_c);
    const sentence = t(W.sheet, {
        stall: names.stall, seller: names.seller, title: names.title, count: send.hours,
        n: formatHundredths(total_c), net: formatHundredths(net_c), fee: formatHundredths(fee_c),
    });
    return { sentence, total_c, fee_c, net_c };
}

// ── The retry id ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A take-up's retry id, for one exact sale: this enterprise, this listing, this count, this way, this total. */
export interface TakeUpRequest {
    key: string;
    requestId: string;
}

/**
 * The id a Confirm goes with: the same one again only for exactly the same sale (a retry after the node's own refusal, which
 * recorded nothing), a new one the moment anything in it changes, so a changed count is never refused as the first one's
 * retry. Both apps forget it when the sheet closes; a sale whose answer never came is kept apart, whole, in the book of
 * unanswered sales (takeUpUnansweredBook), which outlives the sheet and the page; once that sale has aged, its id is never
 * used again (takeUpConfirm).
 */
export function takeUpRequestFor(prev: TakeUpRequest | null | undefined, enterprise: string, postId: string, send: ItemTakeUpSend,
    make: () => string = () => billNewId()): TakeUpRequest {
    const key = JSON.stringify([enterprise, postId, send.hours, send.itemOption, send.expect_c]);
    return prev && prev.key === key ? prev : { key, requestId: make() };
}

/** What Confirm sends to POST /api/treasury/:treasury/take-up: the member's own accept body, no key in it (slice 1). */
export interface TakeUpBody extends ItemTakeUpSend {
    postId: string;
    requestId: string;
}

export function takeUpBody(postId: string, send: ItemTakeUpSend, request: TakeUpRequest): TakeUpBody {
    return { postId, hours: send.hours, itemOption: send.itemOption, expect_c: send.expect_c, requestId: request.requestId };
}

// ── A sale whose answer never came ───────────────────────────────────────────────────────────────────────────────

/**
 * How long a sale whose answer never came is sent again, counted from its FIRST sending: a day. The node keeps a take-up's
 * request id for REQUEST_ID_KEPT_DAYS (7: apps/server/src/engine/money-requests.ts, pruned daily) from the moment it made
 * the sale, which is never before the first sending; after that it no longer knows the id, so the same sale sent again
 * would be a second sale, paid twice. A day is plenty for "the answer was lost just now" and leaves days to spare for a
 * device clock that is out. The node's suite (apps/server/src/test-enterprise-take-up.ts) reads both and pins this inside.
 * It is core money-retry.ts's one rule for every money retry store (MONEY_RESEND_HOURS, moneyResendable), which Pay the
 * Commons keeps too.
 */
export const TAKE_UP_RESEND_HOURS = MONEY_RESEND_HOURS;

/** A sale sent whose answer hasn't come back: exactly what was sent (its id with it), the sheet's sentence, and when. */
export interface TakeUpUnanswered {
    enterprise: string;
    postId: string;
    body: TakeUpBody;
    sentence: string;
    /**
     * When it was FIRST sent (ms, the book's clock). Sending it again keeps this stamp, as the node's record of the sale
     * keeps its first time: the age that matters is how long the node may have known the id.
     */
    sentAt: number;
}

/**
 * Every sale sent whose answer hasn't come back, one per enterprise and listing, for as long as the app runs (each app's
 * components/EnterpriseTakeUp.tsx holds one for the whole app). A sale is kept from the moment it is sent, so a sheet
 * closed, or a page left and opened again, while it is on its way or after its answer was lost still finds it; it is
 * forgotten when the node itself answers (takeUpSettle). For TAKE_UP_RESEND_HOURS from its first sending, Confirm on that
 * enterprise and listing sends it again exactly (`get`, takeUpConfirm): the node answers a retry of a sale it made with that
 * sale, before it reads the listing, so it is never paid twice, even once the listing has sold out or its count moved.
 * After that it is `aged`: never sent again (the node may have forgotten its id), never in the way of a new sale, and the
 * sheet says the stall may have paid for it (takeUpAgedLine).
 */
export interface TakeUpUnansweredBook {
    /** The kept sale Confirm sends again: first sent less than TAKE_UP_RESEND_HOURS ago. */
    get(enterprise: string, postId: string): TakeUpUnanswered | null;
    /** A kept sale past that age, or of an age the clock can no longer tell: never sent again. */
    aged(enterprise: string, postId: string): TakeUpUnanswered | null;
    keep(sale: TakeUpUnanswered): void;
    forget(enterprise: string, postId: string): void;
    /** The book's clock (ms): a new sale is stamped with it. */
    now(): number;
}

/** `now` is the device's clock unless a test hands one in (read at each call, so a test's fake clock is the one read). */
export function takeUpUnansweredBook(now: () => number = () => Date.now()): TakeUpUnansweredBook {
    const sales = new Map<string, TakeUpUnanswered>();
    const at = (enterprise: string, postId: string) => JSON.stringify([enterprise, postId]);
    // Sent again for a day from its first sending, never after, a clock set back past the slack read as aged (money-retry.ts).
    const sendable = (sale: TakeUpUnanswered) => moneyResendable(sale.sentAt, now());
    return {
        get: (enterprise, postId) => {
            const sale = sales.get(at(enterprise, postId));
            return sale && sendable(sale) ? sale : null;
        },
        aged: (enterprise, postId) => {
            const sale = sales.get(at(enterprise, postId));
            return sale && !sendable(sale) ? sale : null;
        },
        keep: (sale) => { sales.set(at(sale.enterprise, sale.postId), sale); },
        forget: (enterprise, postId) => { sales.delete(at(enterprise, postId)); },
        now,
    };
}

/** What one Confirm sends, and whether it is a sale sent before (`resent`), whose answer never came. */
export interface TakeUpConfirm {
    sale: TakeUpUnanswered;
    resent: boolean;
    /** The retry id the sheet keeps for the sale its box shows (unchanged when a kept sale is sent again). */
    request: TakeUpRequest | null;
}

/**
 * What Confirm sends: a sale kept in the book for this enterprise and listing, again exactly as it went (the same id, count,
 * way, total and first sending, whatever the box or the listing reads now); else the sale the box shows, with its retry id
 * (takeUpRequestFor), the sheet's sentence and the book's time. A sale `aged` in the book is never sent again, under the
 * sheet's own id either: the same count at the same price once it has aged is a new sale with a new id, so the node's
 * answer to it is never the old sale replayed and read as this one paid. Null when there is nothing to send.
 */
export function takeUpConfirm(args: {
    book: TakeUpUnansweredBook;
    request: TakeUpRequest | null | undefined;
    enterprise: string;
    postId: string;
    send: ItemTakeUpSend | null | undefined;
    sentence: string | null | undefined;
    make?: () => string;
}): TakeUpConfirm | null {
    const kept = args.book.get(args.enterprise, args.postId);
    if (kept) return { sale: kept, resent: true, request: args.request ?? null };
    if (!args.send || !args.sentence) return null;
    const aged = args.book.aged(args.enterprise, args.postId);
    const prev = aged && args.request?.requestId === aged.body.requestId ? null : args.request;
    const request = takeUpRequestFor(prev, args.enterprise, args.postId, args.send, args.make);
    const body = takeUpBody(args.postId, args.send, request);
    return { sale: { enterprise: args.enterprise, postId: args.postId, body, sentence: args.sentence, sentAt: args.book.now() }, resent: false, request };
}

/**
 * What came of a Confirm that threw (either app's request error):
 *  - 'lost': no answer (no status: an abort, a dropped signal, "Failed to fetch"), status 0, or a gateway's or server's 5xx
 *    (core billAnswerLost's rule). The node may have held and released the Beans: the sale stays kept and the sheet says so.
 *  - 'unsent': the network in front of the node answered and the node never saw it: its busy answer (core isBusyError), or a
 *    refusal that is not the node's own words (a proxy's page: the phone's `nodeAnswered: false`, the web's `unsaid`).
 *  - 'refused': the node's own refusal. Nothing was paid on this id, and the node recorded none.
 */
export type TakeUpOutcome = 'lost' | 'unsent' | 'refused';

export function takeUpOutcomeOf(e: unknown): TakeUpOutcome {
    if (billAnswerLost(e)) return 'lost';
    const r = e as { nodeAnswered?: unknown; unsaid?: unknown };
    if (isBusyError(e) || r.nodeAnswered === false || r.unsaid === true) return 'unsent';
    return 'refused';
}

/**
 * The book once a Confirm's sale has its outcome ('answered': the node's 200, a sale held or released). The node's answer or
 * its own refusal forgets the sale; a lost answer keeps it; the network's answer ('unsent') leaves a sale kept from before as
 * it was (`resent`: its first sending may still have gone through) and keeps none sent for the first time, which never got
 * there. Both apps keep a sale in the book (book.keep) the moment they send it, then call this with what came back.
 */
export function takeUpSettle(book: TakeUpUnansweredBook, go: Pick<TakeUpConfirm, 'sale' | 'resent'>, outcome: TakeUpOutcome | 'answered'): void {
    const { enterprise, postId } = go.sale;
    if (outcome === 'lost') book.keep(go.sale);
    else if (outcome === 'unsent' && go.resent) book.keep(go.sale);
    else book.forget(enterprise, postId);
}

/** The sheet's line while a sale is kept unanswered: the stall may have paid already, and Confirm finds out (never "failed"). */
export function takeUpLostLine(names: { stall: string; seller: string }): string {
    return t(W.lost, { stall: names.stall, seller: names.seller });
}

/** The sheet's line over the count picker once a kept sale has aged: the stall may have paid for it, and Confirm is a new sale. */
export function takeUpAgedLine(names: { stall: string; seller: string }): string {
    return t(W.aged, { stall: names.stall, seller: names.seller });
}

// ── The answer, and every refusal ────────────────────────────────────────────────────────────────────────────────

/**
 * Every code POST /api/treasury/:treasury/take-up answers with, and the line the apps show for it. `line`: these words, in
 * the member's language. `count`: core's per-item sentence (itemTakeUpRefusalIn), with how many are left. `node`: the
 * node's own sentence, which it already writes in the member's language (member-words.ts) and which says something only it
 * knows (when a daily limit lets up, which switch is off). A refusal with no code (not a keeper, no room, Rules 5 and 6, a
 * member away) is the node's own sentence too: it speaks of the enterprise only.
 */
export const TAKE_UP_REFUSALS: Readonly<Record<string, { line: (typeof W)[keyof typeof W] } | 'count' | 'node'>> = Object.freeze({
    // The door's own (routes/treasury.ts).
    take_up_each_only: { line: W.eachOnly },
    take_up_cancelled: { line: W.cancelled },
    post_gone: { line: W.gone },
    request_id_reused: { line: W.tapReused },
    // The engine's (engine/escrow.ts acceptPost, routes/deal-refusals.ts).
    deal_open: { line: W.dealOpen },
    TWO_PERSON_RULE: { line: W.twoPeople },
    listing_copy: { line: W.copy },
    lend_ask_first: { line: W.lent },
    ...Object.fromEntries(ITEM_TAKE_UP_REFUSALS.map((c) => [c, 'count' as const])),
    federation_settlement_disabled: 'node',
    COMMONS_POT_UNKNOWN: 'node',
    // The gates in front of the handler: a standby, a switch off, the daily money limits (routes/money-limits-gate.ts).
    standby: 'node',
    feature_off: 'node',
    money_payments_day: 'node',
    money_new_recipients_day: 'node',
    money_requests_day: 'node',
    money_enterprise_work_payments_day: 'node',
    money_enterprise_work_new_recipients_day: 'node',
    money_enterprise_work_requests_day: 'node',
});

/** The node's own sentence from either app's request error, its trade-gate prefix ("CONTRIBUTION_REQUIRED: ") taken off. */
function nodeWords(e: unknown): string | null {
    const m = (e as { message?: unknown } | null | undefined)?.message;
    if (typeof m !== 'string') return null;
    const s = m.replace(/^[A-Z_]+(:\d+)*:\s*/, '').trim();
    return s === '' ? null : s;
}

/**
 * What the sheet says when the door refused (either app's request error: its `code`, `unitsLeft` and `message`): the line
 * for its code (TAKE_UP_REFUSALS), else the node's own sentence, else the node's fallback. Nothing was paid on any of them.
 */
export function takeUpRefusalText(e: unknown): string {
    const code = (e as { code?: unknown } | null | undefined)?.code;
    const entry = typeof code === 'string' && Object.prototype.hasOwnProperty.call(TAKE_UP_REFUSALS, code) ? TAKE_UP_REFUSALS[code] : null;
    if (entry === 'count') {
        const r = itemTakeUpRefusalIn(e);
        if (r) return r.text;
    } else if (entry && entry !== 'node') {
        return t(entry.line);
    }
    return nodeWords(e) ?? t(W.fallback);
}

/** Whether the refusal means the listing moved on (a count, the price for all, a price, gone): the app reads it again. */
export function takeUpListingMoved(e: unknown): boolean {
    const code = (e as { code?: unknown } | null | undefined)?.code;
    return code === 'post_gone' || TAKE_UP_REFUSALS[code as string] === 'count';
}

/** The door's answer once Beans are held (always 200): whether the sale was released, and the node's words when it wasn't. */
export interface TakeUpAnswer {
    released: boolean;
    /** The node's sentence when the deal is held and not released: a keeper releases it from the enterprise's deals. */
    held: string | null;
}

/** The door's answer read: released only when the node says so; a held deal says why, in the node's words. Never a false success. */
export function takeUpAnswerOf(body: unknown): TakeUpAnswer {
    const b = body as { released?: unknown; error?: unknown } | null | undefined;
    if (b?.released === true) return { released: true, held: null };
    const said = typeof b?.error === 'string' && b.error.trim() !== '' ? b.error.trim() : null;
    return { released: false, held: said ?? t(W.fallback) };
}

/**
 * Whether a release in an enterprise's console asks how many hours (both consoles): only for a deal priced by the hour, day,
 * week or month. A deal on a listing priced for each one is for a number of items, not a time (a take-up the release of
 * which was left held, D5), and a fixed price has no quantity: neither asks, and both pay what is held.
 */
export function releaseAsksHours(priceType: string | null | undefined): boolean {
    return !!priceType && priceType !== 'fixed' && priceType !== EACH;
}
