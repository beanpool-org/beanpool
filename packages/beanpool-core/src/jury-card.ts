/**
 * A removal jury on a Decision card, the same in both apps (slice J3: scratch/fable-design/DESIGN-removal-jury-fable.md §3,
 * §8, §9; DESIGN-removal-jury-j2-calls-fable.md, row "J3 Apps"). What the card says to each reader, and Check the draw.
 *
 * The node serves the jury at GET /api/commons/decisions/:id/jury (server decisions-engine.ts juryForReader): the pool the
 * draw was made from, the draw's facts, the reader's own seat in neutral words (`you`: seated, not_seated or null), and
 * once the vote closes two lists, `voted` and `didNotServe`, never why. While it is open the tally carries `turnout`
 * (voted, size, mustVote) and never the split, so the card counts jurors and shows no Yes or No until it closes.
 *
 * Nothing here names a juror to anyone but themselves: the reader learns only their own seat while the vote is open, and
 * the two lists after it closes are the community's, as the design has them.
 */
import { checkJuryDraw, JURY_LATE_SEAT_HOURS, JURY_LINE, JURY_MIN_POOL, type JuryCheckProblem } from './jury-draw.js';
import { formatDate, t, tn } from './words.js';

/** One member as the jury route names them: the key now, the name now, and (after close) the key it was drawn as. */
export interface JuryEntry {
    publicKey: string;
    callsign: string | null;
    drawnAs?: string;
}

/** GET /api/commons/decisions/:id/jury's `jury`. */
export interface ServedJury {
    decisionId: string;
    /** The key the draw was made for, as it was when the vote opened; null on a branch's vote, which has `root` instead. */
    subject: string | null;
    root?: string;
    branch?: JuryEntry[];
    snapshotDate: string;
    rosterHash: string;
    poolSize: number;
    size: number;
    mustVote: number;
    minYes: number;
    pool: JuryEntry[];
    you: 'seated' | 'not_seated' | null;
    /** A seated reader's: when their answer, Serve or Step aside, is due; null once they answered Serve. */
    answerBy?: string | null;
    /** After close only. */
    voted?: JuryEntry[];
    didNotServe?: JuryEntry[];
}

/** A jury's turnout as the tally serves it (J2a): how many jurors voted, how many sit, how many must vote. */
export interface JuryTurnout {
    voted: number;
    size: number;
    mustVote: number;
}

/** A vote a jury decides: its card says so (`params.decider`, J1), or its tally does (J2a). */
export function isJuryVote(decision: { params?: { decider?: unknown } | null; tally?: { decider?: unknown } | null }): boolean {
    return decision.params?.decider === 'jury' || decision.tally?.decider === 'jury';
}

/** The jury's turnout from the tally, or null when it has none (a node from before J2a, or a vote no jury decides). */
export function juryTurnoutOf(tally: { turnout?: Partial<JuryTurnout> | null } | null | undefined): JuryTurnout | null {
    const t0 = tally?.turnout;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    return t0 && ok(t0.voted) && ok(t0.size) && ok(t0.mustVote) ? { voted: t0.voted, size: t0.size, mustVote: t0.mustVote } : null;
}

export type JuryCheck = { ok: true; closed: boolean } | { ok: false; problem: JuryCheckProblem };

/**
 * Check the draw (§3) over what the node served: the pool's hash against the one the vote recorded, seeded with the key
 * it was drawn for (`subject`, or a branch's `root`); once it closes, `voted` and `didNotServe` together, each as drawn
 * (`drawnAs`, so a juror who moved to a new key still checks out), must be the head of the draw (core checkJuryDraw).
 */
export function checkServedJury(jury: ServedJury): JuryCheck {
    const closed = Array.isArray(jury.voted) || Array.isArray(jury.didNotServe);
    const roll = closed ? [...(jury.voted ?? []), ...(jury.didNotServe ?? [])].map(e => e.drawnAs ?? e.publicKey) : undefined;
    const checked = checkJuryDraw({
        pool: jury.pool.map(e => e.publicKey),
        subject: jury.subject ?? jury.root ?? '',
        snapshotDate: jury.snapshotDate,
        rosterHash: jury.rosterHash,
        roll,
    });
    return checked.ok ? { ok: true, closed } : checked;
}

/** What Check the draw says. */
export function juryCheckLine(check: JuryCheck): string {
    if (check.ok) {
        return check.closed
            ? t('The draw checks out: everyone listed was drawn in order from the pool this vote recorded.')
            : t('The draw checks out: the pool is the one this vote recorded. Once it closes, you can check who was drawn.');
    }
    return check.problem === 'hash'
        ? t("The list the node served doesn't match its own hash.")
        : t("The names the node served aren't the first ones the draw picks.");
}

/** "Drawn from 140 members who could serve on 3 Nov." Under Check the draw. */
export function juryPoolLine(jury: Pick<ServedJury, 'poolSize' | 'snapshotDate'>): string {
    const at = Date.parse(`${jury.snapshotDate}T00:00:00.000Z`);
    return Number.isFinite(at)
        ? tn(jury.poolSize, 'Drawn from {n} member who could serve on {date}.', 'Drawn from {n} members who could serve on {date}.', { date: formatDate(new Date(at), 'day-month', { utc: true }) })
        : tn(jury.poolSize, 'Drawn from {n} member who could serve.', 'Drawn from {n} members who could serve.');
}

/** "A jury of 12 members, drawn at random, decides by 5 Nov." Everyone reads it on the card while the vote is open. */
export function juryDecidesLine(size: number, closesAt: string | null | undefined): string {
    const at = closesAt ? Date.parse(closesAt) : NaN;
    return Number.isFinite(at)
        ? tn(size, 'A jury of {n} member, drawn at random, decides by {date}.', 'A jury of {n} members, drawn at random, decides by {date}.', { date: formatDate(new Date(at), 'day-month') })
        : tn(size, 'A jury of {n} member, drawn at random, decides.', 'A jury of {n} members, drawn at random, decides.');
}

/** "7 of 12 jurors have voted": the count, never the split (§8). Shown as "Turnout: …". */
export function juryTurnoutLine(turnout: JuryTurnout): string {
    return tn(turnout.voted, '{n} of {size} jurors has voted', '{n} of {size} jurors have voted', { size: turnout.size });
}

/** What the jury must do to decide: how many must vote, and the Yes it takes (§5). */
export function juryRuleLine(turnout: JuryTurnout, minYes: number | null | undefined, name: string): string {
    return typeof minYes === 'number' && minYes > 0
        ? t('{must} of the jury must vote. Removing {name} takes two-thirds of the votes cast, and at least {yes} Yes.', { must: turnout.mustVote, name, yes: minYes })
        : t('{must} of the jury must vote. Removing {name} takes two-thirds of the votes cast.', { must: turnout.mustVote, name });
}

/** Why the card shows no Yes and No while it is open. */
export function juryCountHiddenLine(): string {
    return t('How the jury votes stays hidden until the vote closes.');
}

/** Where the reader stands, for the card: from the vote and the node's `you`. */
export type JurySeatView = 'subject' | 'ask' | 'serving' | 'voted' | 'not_seated' | 'not_on_it';

/**
 * `ask`: seated, and their answer (Serve or Step aside) is still due. `serving`: seated and answered Serve, not voted yet,
 * so they may still step aside. `voted`: seated with a vote in (a vote is an answer; stepping aside is closed then).
 * `not_seated`: they were seated and the seat went to the next member drawn. `not_on_it`: everyone else, a member passed
 * over at the draw and one who stepped aside among them, in the same words as a member not drawn (call 2 point 4).
 */
export function jurySeatView(jury: Pick<ServedJury, 'you' | 'answerBy'>, opts: { isSubject: boolean; hasVoted: boolean }): JurySeatView {
    if (opts.isSubject) return 'subject';
    if (jury.you === 'seated') return opts.hasVoted ? 'voted' : jury.answerBy ? 'ask' : 'serving';
    if (jury.you === 'not_seated') return 'not_seated';
    return 'not_on_it';
}

/** Only a seated juror is offered the vote. */
export function juryOffersVote(view: JurySeatView): boolean {
    return view === 'ask' || view === 'serving' || view === 'voted';
}

/** The juror's own lines (design §9; call 2 point 5's words), or the reader's, in neutral words. */
export function jurySeatLines(view: JurySeatView, opts: { name: string; answerBy?: string | null; closesAt?: string | null; now?: number }): string[] {
    const now = opts.now ?? Date.now();
    const closes = opts.closesAt ? Date.parse(opts.closesAt) : NaN;
    const late = Number.isFinite(closes) && closes - now < JURY_LATE_SEAT_HOURS * 3_600_000;
    const stepAside = t("Step aside if you know them too well to judge, or can't give it the time. Nobody is told why.");
    switch (view) {
        case 'subject':
            return [t('Your answer is shown to the jury.')];
        case 'ask': {
            const by = opts.answerBy ? Date.parse(opts.answerBy) : NaN;
            return [
                t("You were drawn for this jury. Read the case and {name}'s answer, then vote.", { name: opts.name }),
                Number.isFinite(by)
                    ? t("Answer by {date}: serve, or step aside. If you don't answer, your seat goes to the next member drawn.", { date: formatDate(new Date(by), 'weekday-day-month') })
                    : t("Answer soon: serve, or step aside. If you don't answer, your seat goes to the next member drawn."),
                ...(late ? [t('This vote closes in less than two days.')] : []),
                stepAside,
            ];
        }
        case 'serving':
            return [t("You're on this jury. Your vote counts."), ...(late ? [t('This vote closes in less than two days.')] : []), stepAside];
        case 'voted':
            return [t("You're on this jury. Your vote counts. You can change it until the vote closes.")];
        case 'not_seated':
            return [t("You're no longer on this jury. Your seat went to the next member drawn.")];
        default:
            return [t('Only the jury votes on this. Anyone can check how it was drawn.')];
    }
}

/** Asked before a juror steps aside. */
export function jurorStepAsideQuestion(): string {
    return t('Step aside from this jury? Your seat goes to the next member drawn, and nobody is told why.');
}

/** A closed jury's result (design §9), or null where the card's other lines say what happened (halted, blocked, void). */
export function juryOutcomeLine(
    decision: { status: string },
    tally: { quorumMet?: boolean; yesWeight?: number; totalVoters?: number } & { turnout?: Partial<JuryTurnout> | null },
    name: string,
): string | null {
    const turnout = juryTurnoutOf(tally);
    const size = turnout?.size ?? 0;
    if (decision.status === 'execution_pending_grace' || decision.status === 'executed' || decision.status === 'passed') {
        return tn(tally.yesWeight ?? 0, 'The jury voted to remove {name} ({n} of {size}).', 'The jury voted to remove {name} ({n} of {size}).', { name, size });
    }
    if (decision.status !== 'failed' && decision.status !== 'unresolved') return null;
    if (!tally.quorumMet) {
        return tn(turnout?.voted ?? tally.totalVoters ?? 0, '{n} of {size} jurors voted, too few to decide. {name} is back.', '{n} of {size} jurors voted, too few to decide. {name} is back.', { name, size });
    }
    return t('The jury kept {name}.', { name });
}

/** A juror as the closed lists name them: their name, or the start of their key where the node has no name. */
function entryName(e: JuryEntry): string {
    return e.callsign || e.publicKey.slice(0, 8);
}

/** The two closed lists (call 2 point 2): who voted, and who didn't serve, never why. Null while the vote is open. */
export function juryClosedLists(jury: Pick<ServedJury, 'voted' | 'didNotServe'>): { voted: string; didNotServe: string; note: string } | null {
    if (!Array.isArray(jury.voted) && !Array.isArray(jury.didNotServe)) return null;
    const names = (list: JuryEntry[] | undefined) => (list && list.length ? list.map(entryName).join(', ') : t('nobody', 'an empty list of names'));
    return {
        voted: t('Voted: {names}', { names: names(jury.voted) }),
        didNotServe: t("Didn't serve: {names}", { names: names(jury.didNotServe) }),
        note: t("The list never says why someone didn't serve: they stepped aside, didn't answer in time, left, or were passed over for a link to the member."),
    };
}

/**
 * Who decides a removal here, for "How this community works" on the phone and the web (the community's rule, never how
 * many could serve today): Automatic, Everyone, or A jury with what happens while too few could serve (`pool_too_small`).
 * Null from a node that doesn't say, or with Decisions off.
 */
export function removalDeciderLine(features: { decisions?: boolean; removalDecider?: unknown } | null | undefined): string | null {
    if (!features || features.decisions === false) return null;
    switch (features.removalDecider) {
        case 'everyone':
            return t('**Removals:** decided by everyone who can vote');
        case 'automatic':
            return t('**Removals:** decided by everyone who can vote until {n} members could serve on a jury, then by a jury drawn at random', { n: JURY_LINE });
        case 'jury':
            return t('**Removals:** decided by a jury drawn at random; while fewer than {n} members could serve on one, by everyone who can vote', { n: JURY_MIN_POOL });
        default:
            return null;
    }
}
