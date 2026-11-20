/**
 * The two client-side halves of "count this onboarding step ONCE PER PERSON".
 *
 * Steps 3 and 4 of the join flow happen entirely on the device, so the node can only count
 * them if a client reports them. Until now a client reported every time the screen was
 * drawn: 20 people who joined produced 56 `protection_shown` rows, and the operator's
 * dashboard showed 350% of them reaching step 3. The fix has to live on the device — the
 * node cannot deduplicate what it deliberately refuses to remember, because M2
 * (docs/ONBOARDING.md) gives `onboarding_funnel` no column that could identify a person.
 *
 * So the device remembers instead, and it remembers one bit: "I have reported this step for
 * this identity on this node". That bit never leaves the device.
 *
 * These helpers live in @beanpool/core because FOUR packages have to agree on them — the
 * phone and the PWA write the key and send the variant, the server bounds the variant, and
 * the manager decides which stored rows are the new per-person kind. Two copies of a rule
 * this small drift; one cannot.
 */

/**
 * Marks a stored counter row as "one per person", as opposed to the old one-per-showing
 * rows sitting beside it under the same event.
 *
 * Old counts cannot be corrected — the node kept no way to tell which of those 56 showings
 * were the same person twice — so they are not deleted and not adjusted. They are simply
 * made distinguishable, and the screen adds up only the new kind and says which day it
 * started from. `(day, event, variant, count)` is the whole schema and this needs no more
 * than the variant column it already has: no migration, no second table, and a node running
 * an older build keeps writing rows that are still perfectly readable, just not counted.
 */
export const ONCE_PER_PERSON = 'once';

/**
 * The variant a per-person report carries: `once`, or `once:<sub-type>` where the step has
 * one (`protection_choice` still distinguishes words from skip).
 *
 * Stays inside the server's 16-character variant bound, which exists because the variant is
 * part of a primary key: `once:` is five, and the longest sub-types in use, `words` and `later`, are five more.
 */
export function oncePerPersonVariant(sub = ''): string {
    const trimmed = (sub || '').trim();
    return trimmed ? `${ONCE_PER_PERSON}:${trimmed}` : ONCE_PER_PERSON;
}

/** Is this stored row one of the new per-person counts? Old rows carry '', 'A', 'words', … */
export function isOncePerPersonVariant(variant: string | null | undefined): boolean {
    if (typeof variant !== 'string') return false;
    return variant === ONCE_PER_PERSON || variant.startsWith(`${ONCE_PER_PERSON}:`);
}

/** The sub-type inside a per-person variant, or '' when it has none. */
export function oncePerPersonSubType(variant: string): string {
    return variant.startsWith(`${ONCE_PER_PERSON}:`) ? variant.slice(ONCE_PER_PERSON.length + 1) : '';
}

/**
 * The local key under which a client records that it has already reported one step.
 *
 * Keyed by NODE and by IDENTITY, not by event alone. A member who joins a second community
 * onboards there too and must be counted there; and a phone re-keyed or handed on carries a
 * different public key through a join that really is a new person's. Getting either wrong
 * turns a dedupe into a silent under-count, which is the failure mode that is hardest to
 * notice — the number simply looks plausible and is low.
 *
 * The node URL is normalised (trimmed, lower-cased, trailing slashes dropped) so that the
 * same node reached as `https://Node.example.org/` and `https://node.example.org` is one
 * node rather than two.
 */
export function onboardingEventKey(nodeUrl: string, publicKey: string, event: string): string {
    const node = (nodeUrl || '').trim().toLowerCase().replace(/\/+$/, '');
    return `bp_funnel_once:${node}:${publicKey}:${event}`;
}

/**
 * The join's notifications screen: its last screen, on a phone that has to ask
 * (DESIGN-notify-and-backup-asks-fable-amend2.md §4.4, slice N1c). Two steps a member's app reports, each once per
 * person per community as the steps above are, through the same `recordOnboardingEvent`:
 *
 *   `notify_shown`    the screen was drawn                  recordOnboardingEvent(NOTIFY_SHOWN)
 *   `notify_choice`   the screen was answered               recordOnboardingEvent(NOTIFY_CHOICE, choice)
 *
 * and the answer is one of three sub-types:
 *
 *   on      tapped "Turn on notifications", and the phone said yes
 *   later   tapped "Later": not a no, the phone's own question is still unspent
 *   no      tapped "Turn on notifications", and the phone said no
 *
 * The owner's Onboarding panel shows four numbers from these (shown, on, later, no): counts, never who (M2).
 */
export const NOTIFY_SHOWN = 'notify_shown';
export const NOTIFY_CHOICE = 'notify_choice';
export const NOTIFY_CHOICES = ['on', 'later', 'no'] as const;
export type NotifyChoice = (typeof NOTIFY_CHOICES)[number];

/**
 * Every onboarding step a member's app may report, and the only ones the server takes (POST /api/funnel-event). The
 * invite outcomes are not here on purpose: the server counts those itself from what happened, and taking them from a
 * client would let a member rewrite the node's rejection rate.
 */
export const CLIENT_FUNNEL_EVENTS = ['protection_shown', 'protection_choice', 'guide_complete', NOTIFY_SHOWN, NOTIFY_CHOICE] as const;
export type ClientFunnelEvent = (typeof CLIENT_FUNNEL_EVENTS)[number];

/** The longest variant the server stores: it is part of the counter table's primary key, so it is bounded. */
export const FUNNEL_VARIANT_MAX = 16;

/** The variants each notifications step may carry: the per-person form, and for the answer one of its three. */
const NOTIFY_VARIANTS: Readonly<Record<string, readonly string[]>> = {
    [NOTIFY_SHOWN]: [oncePerPersonVariant()],
    [NOTIFY_CHOICE]: NOTIFY_CHOICES.map(choice => oncePerPersonVariant(choice)),
};

/**
 * What the server counts for one report from a member's app, or null when it refuses the report.
 *
 * - A step not in CLIENT_FUNNEL_EVENTS: refused.
 * - The notifications steps: only in the per-person form, `once` for the screen drawn and `once:on`, `once:later` or
 *   `once:no` for the answer. No app ever sent them any other way, so there is no older form to keep, and a row with any
 *   other variant would be one the owner's screen cannot name.
 * - The three older steps: the variant as sent, cut to FUNNEL_VARIANT_MAX, and '' when it is not a string. Older apps
 *   still send '', 'A', 'words' and so on; those rows are stored, and the owner's screen leaves them out and says so.
 *
 * Pure: the server applies it and stores what it returns; a refusal is a 400, which the apps swallow.
 */
export function clientFunnelReport(event: unknown, variant: unknown): { event: ClientFunnelEvent; variant: string } | null {
    if (typeof event !== 'string' || !(CLIENT_FUNNEL_EVENTS as readonly string[]).includes(event)) return null;
    const step = event as ClientFunnelEvent;
    const allowed = Object.prototype.hasOwnProperty.call(NOTIFY_VARIANTS, step) ? NOTIFY_VARIANTS[step] : null;
    if (allowed) return typeof variant === 'string' && allowed.includes(variant) ? { event: step, variant } : null;
    return { event: step, variant: typeof variant === 'string' ? variant.slice(0, FUNNEL_VARIANT_MAX) : '' };
}
