/**
 * "Show my community on the worldwide forum", the apps' part (slice F10 apps; DESIGN-forums-fable.md §12, §18; the server
 * and the note are #3199: apps/server routes/membership-note.ts, core membership-note.ts). One file for both apps.
 *
 * - **The one name line.** {@link forumWriterLine} is the only way either app writes a forum writer's name: the members'
 *   forum and the visitors' (topic lists, a topic, replies, quotes, search hits, first looks, the Home card), on the phone
 *   and the web. A writer the forum proved reads "Marty · Riverside", one who chose it "Asha · waiting to join", anyone else
 *   their name alone. core's forum-writer-line.test.ts lists every call site and fails on a name drawn any other way.
 * - **The switch** (Settings → Privacy, only where the forum is public: the worldwide community's): Don't show · a
 *   community you are in · I'm waiting to join one. {@link chooseForumLabel} asks the member's community for its signed
 *   note (GET /api/membership/note at that community's address, signed by the member's key), then hands it to the forum
 *   (POST /api/forum/label). "Don't show" and "waiting" send no note; nothing checks "waiting".
 * - **Renewing.** A note lasts 30 days. While the member keeps opening the forum, the app asks for a fresh one in the last
 *   week ({@link renewForumLabel}), at the address the app knows for that community's key; none known, and Settings says
 *   the note ran out ({@link forumLabelWhyLine}) until the member picks it again.
 *
 * Pure and universal (bundled for the phone): the device's own requests come in through {@link ForumLabelDeps}.
 */
import { FORUM_LABEL_SHOWS, forumWriterNameLine, readMembershipNote, type ForumLabelShow, type ForumWriterLabel, type MembershipNote } from './membership-note.js';
import { nameLine } from './name-line.js';
import { t, word } from './words.js';

/** The two routes: the note on the member's own community, the switch on the worldwide forum. */
export const FORUM_LABEL_PATHS = {
    note: '/api/membership/note',
    label: '/api/forum/label',
} as const;

/** A forum writer as any forum answer names them: the members' (`label`) or the visitors' public JSON (`community`). */
export interface ForumWriterNamed {
    name?: string | null;
    label?: ForumWriterLabel | null;
    community?: ForumWriterLabel | null;
}

/**
 * THE forum writer's line, for every place either app draws one (see the header): the name (`fallback` where the answer
 * has none) and the label the forum proved, in the reader's language (core nameLine).
 */
export function forumWriterLine(writer: ForumWriterNamed | null | undefined, fallback: string): string {
    const name = (typeof writer?.name === 'string' ? writer.name.trim() : '') || fallback;
    return nameLine(forumWriterNameLine({ name, label: writer?.label ?? writer?.community ?? null }));
}

/** What the forum says of a member's choice (GET and POST /api/forum/label; the server's engine/membership-note.ts). */
export interface ForumLabelState {
    show: ForumLabelShow;
    /** The community chosen: its directory key, and its name as the directory shows it now (null while it isn't listed). */
    community: { key: string; name: string | null } | null;
    /** When the community's note lapses. */
    lapsesAt: string | null;
    /** What the forum draws beside their name now; null: their name alone. */
    label: ForumWriterLabel | null;
    /** Why a community chosen is not drawn: its note ran out, or it isn't listed now. */
    why: 'expired' | 'not_listed' | null;
}

function readLabel(raw: unknown): ForumWriterLabel | null {
    const l = raw as { kind?: unknown; community?: unknown } | null;
    if (l?.kind === 'waiting') return { kind: 'waiting' };
    if (l?.kind === 'community' && typeof l.community === 'string' && l.community.trim()) return { kind: 'community', community: l.community };
    return null;
}

/** The forum's answer, read; null for anything that isn't one. */
export function readForumLabelState(raw: unknown): ForumLabelState | null {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || !(FORUM_LABEL_SHOWS as readonly unknown[]).includes(r.show)) return null;
    const c = r.community as { key?: unknown; name?: unknown } | null;
    return {
        show: r.show as ForumLabelShow,
        community: c && typeof c === 'object' && typeof c.key === 'string' && c.key
            ? { key: c.key, name: typeof c.name === 'string' && c.name.trim() ? c.name : null }
            : null,
        lapsesAt: typeof r.lapsesAt === 'string' ? r.lapsesAt : null,
        label: readLabel(r.label),
        why: r.why === 'expired' || r.why === 'not_listed' ? r.why : null,
    };
}

/** Both apps' words for the Settings row. */
export const FORUM_LABEL_WORDS = {
    title: word('Beside my name on the worldwide forum'),
    hint: word('Your community signs a short note saying you are a member, and the forum checks it. Only the name you choose is shown.'),
    none: word('Don’t show'),
    waiting: word('I’m waiting to join one'),
    /** The web's third choice before a community is picked: the directory search opens. */
    pick: word('My community…'),
    /** The web's search box over the directory. */
    find: word('Your community’s name'),
    noMatch: word('No listed community has that name.'),
    /** The phone's list holds the other communities on the phone; none: */
    noOther: word('No other community on this phone. Join one, and its name can be shown here.'),
    /** What others read beside the member's name now. */
    shown: word('Others see: {line}'),
    asking: word('Asking your community…'),
    expired: word('Your community’s note has run out, so its name isn’t shown. Choose it again to renew it.'),
    notListed: word('Your community isn’t listed publicly, so its name can’t be shown.'),
    unreachable: word('Couldn’t reach your community. Please try again.'),
    notSaved: word('Couldn’t save what you show beside your name.'),
} as const;

/** Why the community chosen isn't shown, in the design's words; null while it is (or none is chosen). */
export function forumLabelWhyLine(state: ForumLabelState | null): string | null {
    if (state?.show !== 'community') return null;
    if (state.why === 'not_listed') return t(FORUM_LABEL_WORDS.notListed);
    if (state.why === 'expired') return t(FORUM_LABEL_WORDS.expired);
    return null;
}

/** A request's answer as the device read it: its status and its JSON (null when it had none). */
export interface ForumLabelAnswer { status: number; body: unknown }

/** What each app gives: its own signed requests. */
export interface ForumLabelDeps {
    /** GET {@link FORUM_LABEL_PATHS}.note at a community's address, signed by the member's key. */
    askNote(address: string): Promise<ForumLabelAnswer>;
    /** POST {@link FORUM_LABEL_PATHS}.label on the worldwide forum, signed. */
    postLabel(body: { show: ForumLabelShow; note?: MembershipNote }): Promise<ForumLabelAnswer>;
}

export type ForumLabelChoice = { show: 'none' | 'waiting' } | { show: 'community'; address: string };
export type ForumLabelResult = { ok: true; state: ForumLabelState } | { ok: false; error: string };

/** The refusal's own words (the server's, in the member's language), else `fallback`. */
function refusalOf(body: unknown, fallback: string): string {
    const e = (body as { error?: unknown } | null)?.error;
    return typeof e === 'string' && e.trim() ? e : fallback;
}

/**
 * The member's choice, made: for a community, its note first (a refusal there, "not listed" or "not a member", is said in
 * that community's words and nothing is posted), then the forum's check. A refused choice changes nothing kept.
 */
export async function chooseForumLabel(deps: ForumLabelDeps, choice: ForumLabelChoice): Promise<ForumLabelResult> {
    let note: MembershipNote | undefined;
    if (choice.show === 'community') {
        let asked: ForumLabelAnswer;
        try {
            asked = await deps.askNote(choice.address);
        } catch {
            return { ok: false, error: t(FORUM_LABEL_WORDS.unreachable) };
        }
        note = (asked.status === 200 && readMembershipNote((asked.body as { note?: unknown } | null)?.note)) || undefined;
        if (!note) return { ok: false, error: refusalOf(asked.body, t(FORUM_LABEL_WORDS.unreachable)) };
    }
    try {
        const posted = await deps.postLabel(note ? { show: 'community', note } : { show: choice.show });
        const state = posted.status === 200 ? readForumLabelState(posted.body) : null;
        return state ? { ok: true, state } : { ok: false, error: refusalOf(posted.body, t(FORUM_LABEL_WORDS.notSaved)) };
    } catch {
        return { ok: false, error: t(FORUM_LABEL_WORDS.notSaved) };
    }
}

/** A fresh note is asked for once the one kept has less than this left (it lasts 30 days). */
export const FORUM_LABEL_RENEW_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether the member's community note wants renewing at `now`: chosen, still listed, and lapsed or in its last week. */
export function forumLabelRenewDue(state: ForumLabelState | null, now: number): boolean {
    if (state?.show !== 'community' || !state.community || state.why === 'not_listed') return false;
    const lapses = state.lapsesAt ? Date.parse(state.lapsesAt) : NaN;
    return !Number.isFinite(lapses) || lapses - now < FORUM_LABEL_RENEW_MS;
}

/**
 * Renews the community note when it is due (see the header): `addressOf` names the address this device knows for the
 * community's directory key, or null (then nothing is asked). The new state, or null when nothing was due or it failed.
 */
export async function renewForumLabel(
    deps: ForumLabelDeps,
    state: ForumLabelState | null,
    addressOf: (communityKey: string) => string | null | Promise<string | null>,
    now: number = Date.now(),
): Promise<ForumLabelState | null> {
    if (!forumLabelRenewDue(state, now) || !state?.community) return null;
    const address = await Promise.resolve(addressOf(state.community.key)).catch(() => null);
    if (!address) return null;
    const done = await chooseForumLabel(deps, { show: 'community', address });
    return done.ok ? done.state : null;
}
