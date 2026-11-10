/**
 * How this community works: the one place its owners change it (scratch/fable-design/DESIGN-community-shape-settings-fable.md
 * §2.4, §2.5, §3.4, §6.1, §8.2; slice S2). POST /api/local/admin/community-shape (routes/settings.ts) calls
 * applyShapeChanges; config/community-shape.ts reads what it wrote.
 *
 * All or nothing: the whole request is checked against the shape as it is before anything is written (types and amounts
 * 400, every lock 409 with the lock's own sentence), then every change is written in one transaction through the setter
 * the node already has (setSwitchOverride, setDoor, the known floor's, updateNodeConfig), so a change travels to a
 * standby and the take-over bundle as it always has. A value equal to what is set is no change: nothing is written or
 * logged for it.
 *
 * Every change: one line per setting in community_settings_log (a known-floor change also keeps its line in
 * known_floor_log, stamped alike, which the shape reads as one); an owner alert (`sec.settings`), the owner's own change
 * included, so one made with a stolen session is seen; and, for a rule members live by, a notice to every member in the
 * fixed words below with the owner's note quoted (state-engine.ts noticeToEveryMember). No opt-out (design Q6). The
 * directory switches tell no member: they change what strangers see, not members' rules.
 *
 * Who: an owner (design Q5; the route's requireAdminRole: an admin 403, an automation token 403, the phone's hand-off
 * within its step-up). A standby changes nothing (409 `standby`).
 *
 * ## Core settings (config/core-settings.ts; DESIGN-core-settings-fable.md §8.3, slice C1)
 * `lock: true` is Confirm and lock: the request's changes (Core settings only, or none) and the `core_settings_lock` row
 * in one transaction, a line per change and then a `core.lock` line, one owner alert; members are told only of what
 * changed. Refused once locked (409 `core_locked`), and on a local community with no place set (409 `place_needed`). No
 * fresh proof: nothing is undone.
 * Once locked, a change to a Core setting is made only with the owner's fresh proof (the route asks requireFreshProof
 * and says so in `freshProof`; without it, 403 `core_proof_needed` and nothing written), each Core setting's lines
 * after a `core.unlock` line stamped alike, and one owner alert naming each change. Everyday settings ask nothing, locked
 * or not. While locked (or confirming), a request changes one kind: Core settings, or everyday ones (400
 * `one_kind_per_request`), so the proof is asked for exactly the request that needs it.
 *
 * ## What takes a change, and which locks refuse it
 *   join        'members' | 'admins' | 'paused': the door row and the `invites` override (design §3.1; un-pausing keeps
 *               the door as it was). Refused under the private preview, and where the open door is set (kind or the
 *               operator's rows: no door to choose, `profile`; shut by the ledger, `ledger_moved`). Paused also refused
 *               wherever the open door is set beside invites: invites off there read as the open door, still taking
 *               everyone (`profile`), or shut by the ledger and so a pause only whoever runs the server could lift
 *               (`ledger_moved`) (#2415 review r4360864333). Members ↔ admins there is still the owner's.
 *   wordsDoor   the 12-words door, only where the open door is set; refused where its own lock is (set on and kept shut
 *               with the open door: the preview, a moved ledger), as the shape reads it (#2415 review r4360594615). Set
 *               off behind a shut door, it may be set on: the words door still takes nobody, so no member is told.
 *   knocks      refused under the private preview, and wherever invites are off once this request is written.
 *   beans       off refused once the ledger has moved (`ledger_moved`); on refused while the open door is set (`profile`).
 *               A local community may switch Beans off before anything moved (Q1).
 *   knownFloor  { on, floor, cap }, the known floor's own checks (400); refused wherever Beans are off once this request
 *               is written (`beans_off`).
 *   memberGift  0 (off) to 100, whole Beans: the most one member's credit-line gift may be (slice G1); refused wherever
 *               Beans are off once this request is written (`beans_off`). Its line is kept in the known floor's log too
 *               (`gift_setting`), stamped alike. A Core setting: changed only here (the names list's settings route
 *               refuses it, 400 `moved_to_community_shape`).
 *   listed      refused on the global kind (`profile`); on refused while DIRECTORY_UNLISTED holds every push back.
 *   shareOutside refused on while the private preview is on (it shows visitors nothing). Set off, every link a member
 *               shared outside stops at once (engine/peek-tickets.ts stopAllPeekTickets), in the same transaction: set on
 *               again, none of them opens anything.
 *   doorCheck   only where the open door is set (400 otherwise); no lock.
 *   dmRequests, decisions, probation, autoHide, autoMute, shareLocation, shareMemberCount, shareEmail, sharePhone,
 *   shareHealth: no lock.
 *   recoveryCopies  'vault' | 'server' | 'none' (config/recovery-copies.ts, vault rethink VR2): no lock. Only where new
 *               copies go; every copy a member already has stays theirs, and the members' sentence says so.
 *   removalDecider  'automatic' | 'everyone' | 'jury' (config/removal-decider.ts, DESIGN-removal-jury-fable.md §6): a jury
 *               refused while fewer than JURY_MIN_POOL members could serve on one (`pool_too_small`). A vote already open
 *               keeps the decider it opened with (params.decider).
 * The other locks only say why a value is what it is (held back, an auth hatch, members on demand, a standby's Listed):
 * nothing here changes them, and they refuse nothing.
 *
 * Members are told of a change they live by, never of one that changes nothing they see: the 12-words door set on behind
 * a shut open door, or Beans set on where a moved ledger already runs them (the owners' line and alert still say what
 * was set). The open door, the private preview, visitors
 * and connections are the server's: 400.
 */
import { formatHundredths, word, wordsFor, isMemberGiftSetting, isBudgetLevel, type WordKey } from '@beanpool/core';
import { db } from '../db/db.js';
import { VOUCHER_WORDS, writeMemberGiftSetting, saveVoucherBudgetSetting } from '../engine/vouchers.js';
import { getNodeConfig, updateNodeConfig, noticeToEveryMember, type NodeConfig } from '../state-engine.js';
import { getNodeRole } from './node-role.js';
import { getConfiguredSwitches, setSwitchOverride, type ProfileSwitch } from './node-profile.js';
import { setDoor, doorSettingRefusal, type CommunityDoor } from './door.js';
import { isRecoveryCopies, setRecoveryCopies, type RecoveryCopies } from './recovery-copies.js';
import { isRemovalDecider, setRemovalDecider, type RemovalDecider } from './removal-decider.js';
import { NOTICE_LIMITS } from '../engine/kept-notices.js';
import { checkKnownFloorSettings, writeKnownFloorSettings, KnownFloorError, type KnownFloorPlan } from './known-floor.js';
import { readShape, configuredJoinOf, LOCKS_AFTER_A_CHANGE, type JoinState, type Shape, type ShapeLock } from './community-shape.js';
import { directoryUnlistedByEnv, initDirectoryPublisher, listedSwitchedOff } from '../services/directory-publisher.js';
import { noteSecurityEvent, OWNER_ALERT_WORDS } from '../services/security-signal.js';
import { closeCopyDoors } from '../engine/event-copy.js';
import { stopAllPeekTickets } from '../engine/peek-tickets.js';
import { CORE_SETTINGS_LOCK_KEY, coreLockRow, isCoreChange } from './core-settings.js';

const { t: tr } = wordsFor('en');

/** The longest note an owner may add to the members' notice, in characters (design §6.1). */
export const SHAPE_NOTE_MAX = 200;

export const SHAPE_OWNER_ONLY = 'Only an owner of this community can change how it works';
export const SHAPE_STANDBY = 'This server is a standby copy of the community, not its main server. Change how it works on the main server.';

/** A refusal: the status, a code the page reads, and the sentence it shows (a lock's own why, for a 409). */
export class ShapeChangeError extends Error {
    constructor(readonly status: 400 | 403 | 409 | 429, readonly code: string, message: string, readonly setting?: string, readonly unlock?: string) {
        super(message);
        this.name = 'ShapeChangeError';
    }
}

const refuse = (setting: string, l: ShapeLock): never => {
    throw new ShapeChangeError(409, l.code, l.why, setting, l.unlock);
};
const bad = (setting: string | undefined, message: string, code = 'bad_setting'): never => {
    throw new ShapeChangeError(400, code, message, setting);
};

// ── The settings this route takes ──────────────────────────────────────────────────────────────

/** Each a profile switch's override, in the shape's name. The 12-words door is `ssoRequiredForJoin` the other way up. */
const SWITCH_OF = {
    doorCheck: 'doorCheck', knocks: 'knocks', beans: 'beans', dmRequests: 'dmRequests', decisions: 'decisions', shareOutside: 'shareOutside', listed: 'publishToDirectory',
    probation: 'probation', autoHide: 'autoHideReports', autoMute: 'autoMute',
} as const satisfies Record<string, ProfileSwitch>;
type SwitchSetting = keyof typeof SWITCH_OF;

/** Each a switch in the node_config object (what the directory is sent). */
const SHARE_FIELD_OF = {
    shareLocation: 'publishLocation', shareMemberCount: 'publishMembers', shareEmail: 'publishContactEmail',
    sharePhone: 'publishContactPhone', shareHealth: 'publishHealth',
} as const satisfies Record<string, keyof NodeConfig>;
type ShareSetting = keyof typeof SHARE_FIELD_OF;

/** Checked and written in this order, so a request with two refusals is always refused for the same one. */
const SETTINGS_IN_ORDER = [
    'join', 'wordsDoor', 'doorCheck', 'knocks', 'beans', 'knownFloor', 'voucherBudget', 'memberGift', 'dmRequests', 'decisions', 'shareOutside', 'listed',
    'shareLocation', 'shareMemberCount', 'shareEmail', 'sharePhone', 'shareHealth', 'probation', 'autoHide', 'autoMute',
    'recoveryCopies', 'removalDecider',
] as const;
export type ShapeSettingName = (typeof SETTINGS_IN_ORDER)[number];

/** What the shape reads but no owner sets here, and why. */
const NOT_CHANGED_HERE: Record<string, string> = {
    openDoor: "The open door is set by this server's kind. Whoever runs the server changes it.",
    preview: 'The private preview is set on the server (PRIVATE_PREVIEW). Ask whoever runs the server.',
    visitors: "What visitors see is set by this server's kind. Whoever runs the server changes it.",
    connections: 'Connections to other communities are set on the server (ENABLE_PEER_CONNECTORS). Ask whoever runs the server.',
};

/** The settings' names, for the owners' alert and the server's log (design §8.1). */
export const SETTING_NAMES: Record<ShapeSettingName, string> = {
    join: 'Who can join', wordsDoor: '12 words at the open door',
    doorCheck: 'A person check on busy days', knocks: 'Requests to join', beans: 'Beans',
    knownFloor: 'Known floor for confirmed members', voucherBudget: 'Budget per voucher', memberGift: 'Members giving part of their credit line',
    dmRequests: 'First message from someone new',
    decisions: 'Community votes (Decisions)', shareOutside: 'Members may share listings outside the community',
    listed: 'Listed in the BeanPool directory',
    shareLocation: 'Share location & radius', shareMemberCount: 'Share member count', shareEmail: 'Share email',
    sharePhone: 'Share phone', shareHealth: 'Share health', probation: 'Limits on new accounts',
    autoHide: 'Reported posts hidden and message requests cleared automatically', autoMute: 'Repeat offenders muted automatically',
    recoveryCopies: "Where members' copies go",
    removalDecider: 'Who decides a removal',
};

// ── What members are told (design §8.2): one whole sentence per change, the owner's note quoted after ─────────────

const NOTICE = {
    title: word('How this community works has changed'),
    joinMembers: word("Your community's owners changed how it works: any member can invite people again."),
    joinAdmins: word("Your community's owners changed how it works: only the admins invite people now."),
    joinPaused: word("Your community's owners changed how it works: no new members are being taken for now."),
    wordsOn: word("Your community's owners changed how it works: people can join with 12 secret words now, without a sign-in."),
    wordsOff: word("Your community's owners changed how it works: people join with a sign-in only now."),
    knocksOn: word("Your community's owners changed how it works: people who find this community can ask to join."),
    knocksOff: word("Your community's owners changed how it works: people can no longer ask to join."),
    beansOn: word("Your community's owners changed how it works: Beans are on."),
    beansOff: word("Your community's owners changed how it works: Beans are off, so there are no prices, sends or credit here."),
    floorOn: word("Your community's owners changed how it works: confirmed members can owe up to {floor} Beans now (the known floor)."),
    floorOff: word("Your community's owners changed how it works: confirmed members no longer have a known floor, and go back to the credit they have earned."),
    floorNow: word("Your community's owners changed how it works: confirmed members' known floor is now {floor} Beans."),
    voucherBudget: word("Your community's owners changed how it works: the budget for each voucher is now {budget} Beans."),
    giftOn: word("Your community's owners changed how it works: a member can give another up to {max} Beans of the credit line someone gave them, at once."),
    giftOff: word("Your community's owners changed how it works: members no longer give part of their credit line to each other."),
    dmOn: word("Your community's owners changed how it works: a first message from someone new now waits until you accept it."),
    dmOff: word("Your community's owners changed how it works: every message now arrives straight away."),
    decisionsOn: word("Your community's owners changed how it works: community votes are on."),
    decisionsOff: word("Your community's owners changed how it works: community votes are off; the moderators look after things."),
    shareOutsideOn: word("Your community's owners changed how it works: you can share a listing or an event outside the community for 7 days."),
    shareOutsideOff: word("Your community's owners changed how it works: posts are no longer shared outside the community, and every link shared outside has stopped."),
    probationOn: word("Your community's owners changed how it works: new accounts have limits for their first days."),
    probationOff: word("Your community's owners changed how it works: new accounts no longer have limits for their first days."),
    autoHideOn: word("Your community's owners changed how it works: reported posts are hidden until a moderator looks."),
    autoHideOff: word("Your community's owners changed how it works: reported posts stay up until a moderator looks."),
    autoMuteOn: word("Your community's owners changed how it works: repeat offenders are muted automatically."),
    autoMuteOff: word("Your community's owners changed how it works: repeat offenders are no longer muted automatically."),
    // Where members' copies go (config/recovery-copies.ts). Only new copies follow the rule: each says a member's own stay.
    copiesVault: word("Your community's owners changed how it works: BeanPool's key vault keeps members' sign-in copies now. Any copy you have stays where it is until you move or remove it."),
    copiesServer: word("Your community's owners changed how it works: this community's server keeps members' sign-in copies now. Any copy you have stays where it is until you move or remove it."),
    copiesNone: word("Your community's owners changed how it works: this community keeps no copies of members' accounts now, and doesn't use BeanPool's key vault. Any copy you have stays where it is until you remove it."),
    // Who decides a removal (config/removal-decider.ts, DESIGN-removal-jury-fable.md §6).
    deciderAutomatic: word("Your community's owners changed how it works: once it is large enough, a jury of members drawn at random decides whether someone is removed. Until then every member can vote on it."),
    deciderEveryone: word("Your community's owners changed how it works: every member can vote on whether someone is removed."),
    deciderJury: word("Your community's owners changed how it works: a jury of members drawn at random decides whether someone is removed."),
    note: word('From the owners: “{note}”'),
} satisfies Record<string, WordKey>;

/** A money setting (whole hundredths) in the notice's English words. */
const beansAmount = (c: number) => formatHundredths(c, 'en');

/** The fixed sentence a member reads for one change, or null where members are not told (the directory switches). */
function memberSentence(change: PlannedChange): string | null {
    const on = change.to === 'on';
    switch (change.setting) {
        case 'join': return change.to === 'admins' ? tr(NOTICE.joinAdmins) : change.to === 'paused' ? tr(NOTICE.joinPaused) : tr(NOTICE.joinMembers);
        case 'wordsDoor': return on ? tr(NOTICE.wordsOn) : tr(NOTICE.wordsOff);
        case 'knocks': return on ? tr(NOTICE.knocksOn) : tr(NOTICE.knocksOff);
        case 'beans': return on ? tr(NOTICE.beansOn) : tr(NOTICE.beansOff);
        case 'voucherBudget': return tr(NOTICE.voucherBudget, { budget: beansAmount(Number(change.to)) });
        case 'memberGift': return change.to === '0' ? tr(NOTICE.giftOff) : tr(NOTICE.giftOn, { max: beansAmount(Number(change.to)) });
        case 'dmRequests': return on ? tr(NOTICE.dmOn) : tr(NOTICE.dmOff);
        case 'decisions': return on ? tr(NOTICE.decisionsOn) : tr(NOTICE.decisionsOff);
        case 'shareOutside': return on ? tr(NOTICE.shareOutsideOn) : tr(NOTICE.shareOutsideOff);
        case 'probation': return on ? tr(NOTICE.probationOn) : tr(NOTICE.probationOff);
        case 'autoHide': return on ? tr(NOTICE.autoHideOn) : tr(NOTICE.autoHideOff);
        case 'autoMute': return on ? tr(NOTICE.autoMuteOn) : tr(NOTICE.autoMuteOff);
        case 'recoveryCopies': return change.to === 'none' ? tr(NOTICE.copiesNone) : change.to === 'server' ? tr(NOTICE.copiesServer) : tr(NOTICE.copiesVault);
        case 'removalDecider': return change.to === 'jury' ? tr(NOTICE.deciderJury) : change.to === 'everyone' ? tr(NOTICE.deciderEveryone) : tr(NOTICE.deciderAutomatic);
        default: return null;
    }
}

/**
 * The known floor's one sentence for members: the dial as members live by it (on, and Beans on) turned on or off by this
 * request, else the floor moved while it is on. The cap is not theirs to read (design Q7), and a floor moved with the dial
 * off changes nobody's limit: neither tells them.
 */
function floorSentence(plan: KnownFloorPlan, dialBefore: boolean, dialAfter: boolean): string | null {
    if (dialAfter !== dialBefore) return dialAfter ? tr(NOTICE.floorOn, { floor: beansAmount(plan.floor) }) : tr(NOTICE.floorOff);
    if (dialAfter && plan.floor !== plan.before.knownFloor_c) return tr(NOTICE.floorNow, { floor: beansAmount(plan.floor) });
    return null;
}

// ── Reading a request ──────────────────────────────────────────────────────────────────────────

/** Who is making the change (services/security-signal.ts actingAs): the key behind the session, or `owner:password`. */
export interface ShapeActor { actor: string; actorRole: string }

interface PlannedChange {
    setting: string;
    from: string | null;
    to: string;
}

const onOff = (v: boolean) => (v ? 'on' : 'off');

function boolOf(setting: string, v: unknown): boolean {
    if (typeof v !== 'boolean') bad(setting, `${setting} must be true or false.`);
    return v as boolean;
}

/** The owner's note, one line, or null: whitespace runs read as one space, and an empty note is none. */
function noteOf(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') bad(undefined, 'note must be a sentence, or left out.', 'bad_note');
    const note = (v as string).replace(/\s+/g, ' ').trim();
    if (note.length > SHAPE_NOTE_MAX) bad(undefined, `The note to members is at most ${SHAPE_NOTE_MAX} characters.`, 'bad_note');
    return note || null;
}

/** A request read and checked whole against the shape as it is, before anything is written (planShapeChanges). */
interface ShapePlan {
    before: Shape;
    note: string | null;
    /** Confirm and lock (`lock: true`). */
    lock: boolean;
    planned: PlannedChange[];
    /** The planned changes that are Core (config/core-settings.ts isCoreChange), in order. */
    core: PlannedChange[];
    switches: [ProfileSwitch, boolean][];
    share: Partial<NodeConfig>;
    door: CommunityDoor | null;
    floorPlan: KnownFloorPlan | null;
    /** The voucher budget to write (100 to 2,000 in 100s), or null for no change. */
    budget: number | null;
    /** The member's credit-line gift to write (0 to 100), or null for no change. */
    gift: number | null;
    copies: RecoveryCopies | null;
    decider: RemovalDecider | null;
    beansAfter: boolean;
}

/** Ends the fresh proof's sentence "… to <action>" (admin-auth.ts requireFreshProof). */
export const CORE_PROOF_ACTION = 'change a core setting';
export const CORE_LOCKED_ALREADY = 'The core settings are already confirmed and locked. Change one on its own, with Unlock to change: it asks for your proof each time.';
export const CORE_PLACE_NEEDED = 'Set where your community is first (Settings → Appliance & Data → Node Identity, the map pin): a community confirms its core settings with its place set.';
const coreProofNeeded = (names: string) => `The core settings are locked: changing ${names} asks for your proof each time (Unlock to change). Nothing was saved.`;
const oneKindWhileLocked = (core: string, everyday: string) =>
    `Change a core setting on its own: this request changes ${core}, which ${core.includes(', ') ? 'are core settings' : 'is a core setting'}, and ${everyday}, which ${everyday.includes(', ') ? 'are' : 'is'} not. Nothing was saved.`;
const oneKindToLock = (everyday: string) =>
    `Confirm and lock takes the core settings only: change ${everyday} on ${everyday.includes(', ') ? 'their' : 'its'} own. Nothing was saved.`;

/**
 * Whether this request is a change to a Core setting while the core settings are locked, so that the route asks the
 * owner's fresh proof before it is written (routes/settings.ts). Checked whole as applyShapeChanges checks it, so a request
 * refused anyway is refused here, in the same words, and never spends a code. Writes nothing.
 */
export function shapeChangeAsksFreshProof(body: unknown): boolean {
    const plan = planShapeChanges(body);
    return plan.before.core.lock !== null && plan.core.length > 0;
}

/**
 * The owner's change to how this community works, all or nothing: checked whole against the shape as it is, then written,
 * logged, told to the owners and, for members' rules, to every member. Throws ShapeChangeError (400, 403, 409) with nothing
 * written. `body`: `{ changes: { <setting>: <value>, … }, note?, lock? }`. `freshProof`: the route has the owner's fresh
 * proof for this request (requireFreshProof), which a change to a Core setting needs once they are locked.
 */
export function applyShapeChanges(by: ShapeActor, body: unknown, opts: { freshProof?: boolean } = {}): { shape: Shape; told: 'members' | 'nobody'; changed: string[] } {
    const plan = planShapeChanges(body);
    const { before, note, planned, core, switches, share, door, floorPlan, budget, gift, copies, decider, beansAfter } = plan;
    const S = before.settings;
    const locked = before.core.lock !== null;
    // Read here, with the write that follows, whatever the route found: a lock written meanwhile still asks the proof.
    if (locked && core.length > 0 && !opts.freshProof) {
        throw new ShapeChangeError(403, 'core_proof_needed', coreProofNeeded(namesOf(core)), core[0].setting.split('.')[0]);
    }

    if (planned.length === 0 && !plan.lock) {
        // Nothing changed that anyone reads. Only a default chosen as itself is kept, as its row.
        if (!decider) return { shape: before, told: 'nobody', changed: [] };
        setRemovalDecider(decider);
        return { shape: readShape(), told: 'nobody', changed: [] };
    }

    // ── Written, all of it or none ──
    const at = new Date().toISOString();
    const insertLine = db.prepare(`INSERT INTO community_settings_log (actor_pubkey, actor_role, setting, old_value, new_value, note, at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const unlocked = locked && core.length > 0;
    db.transaction(() => {
        for (const [name, on] of switches) setSwitchOverride(name, on);
        // Outside sharing turned off stops every link shared until now: turned on again later, none of them reopens.
        if (switches.some(([name, on]) => name === 'shareOutside' && on === false)) stopAllPeekTickets(at);
        // Requests off leaves nothing to hold a stranger's first line through a copy's door, so the doors close with them.
        if (switches.some(([name, on]) => name === 'dmRequests' && on === false)) closeCopyDoors(at);
        if (door) setDoor(door);
        if (floorPlan) writeKnownFloorSettings(by.actor, floorPlan, at);
        if (budget !== null) saveVoucherBudgetSetting(by.actor, S.voucherBudget.configured, budget, at);
        if (gift !== null) writeMemberGiftSetting(by.actor, S.memberGift.configured, gift, at);
        if (Object.keys(share).length > 0) updateNodeConfig(share);
        if (copies) setRecoveryCopies(copies);
        if (decider) setRemovalDecider(decider);
        // A Core setting changed while locked: its lines follow a `core.unlock` line naming it, stamped alike (§8.5).
        let lastUnlocked: string | null = null;
        for (const line of planned) {
            const base = line.setting.split('.')[0];
            if (unlocked && core.includes(line) && base !== lastUnlocked) {
                insertLine.run(by.actor, 'owner', 'core.unlock', null, base, null, at);
                lastUnlocked = base;
            }
            insertLine.run(by.actor, 'owner', line.setting, line.from, line.to, note, at);
        }
        // Confirm and lock: the row, then its line. A plain INSERT: a row written meanwhile fails the whole transaction.
        if (plan.lock) {
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(CORE_SETTINGS_LOCK_KEY, coreLockRow(at, by.actor));
            insertLine.run(by.actor, 'owner', 'core.lock', null, 'locked', null, at);
        }
    })();

    // ── Then the node, the owners and the members ──
    const changedSettings = [...new Set(planned.map((c) => c.setting.split('.')[0] as ShapeSettingName))];
    if (changedSettings.includes('listed')) initDirectoryPublisher();
    // Listed switched off: the community's row leaves the public directory now, not when it goes stale in 7 days (front
    // doors S13). One signed withdraw, only if this server has pushed; not awaited (services/directory-publisher.ts).
    if (switches.some(([name, on]) => name === 'publishToDirectory' && on === false)) listedSwitchedOff();
    const shape = readShape();
    if (planned.length > 0) console.log(`🧭 How this community works: ${planned.map((c) => `${c.setting} ${c.from} → ${c.to}`).join(', ')}, set by ${by.actor}.`);
    if (plan.lock) console.log(`🔒 Core settings confirmed and locked by ${by.actor}.`);
    noteSecurityEvent({
        key: 'sec.settings',
        detail: plan.lock ? OWNER_ALERT_WORDS.coreLocked(changedSettings.map((s) => SETTING_NAMES[s]).join(', '))
            : unlocked ? OWNER_ALERT_WORDS.coreUnlocked(core.map(lineWords).join('; '))
            : OWNER_ALERT_WORDS.shapeChanged(changedSettings.map((s) => SETTING_NAMES[s]).join(', ')),
        actor: by.actor,
        actorRole: by.actorRole,
    });
    // The 12-words door set on behind a shut open door takes nobody yet, and Beans set on where a moved ledger already runs
    // them were on all along: members are told only of a door, or Beans, that changed.
    const wordsDoorMoved = shape.settings.wordsDoor?.value !== S.wordsDoor?.value;
    const beansMoved = shape.settings.beans.value !== S.beans.value;
    const sentences = [
        ...planned.filter((c) => !c.setting.startsWith('knownFloor.') && (c.setting !== 'wordsDoor' || wordsDoorMoved)
            && (c.setting !== 'beans' || beansMoved)).map(memberSentence),
        floorPlan ? floorSentence(floorPlan, S.knownFloor.value.on, (floorPlan.confirmation ?? S.knownFloor.configured.on) && beansAfter) : null,
    ].filter((s): s is string => !!s);
    let told: 'members' | 'nobody' = 'nobody';
    if (sentences.length > 0) {
        for (const body of memberNoticeBodies(sentences, note)) {
            noticeToEveryMember(tr(NOTICE.title), body, { kind: 'community_shape', version: shape.version });
        }
        told = 'members';
    }
    return { shape, told, changed: planned.map((c) => c.setting) };
}

/**
 * The Core changes of a request made while the core settings are locked, or with Confirm and lock (`lock`), where a
 * request changes one kind only: refused 400 `one_kind_per_request` when it changes Core settings and everyday ones, and,
 * with the lock, when it changes any everyday one. Before the lock, a request mixes them as it always could.
 */
function oneKindOnly(planned: PlannedChange[], before: Shape, lock: boolean): PlannedChange[] {
    const core = planned.filter((c) => isCoreChange(c.setting, c.to, before.settings.join.door));
    const everyday = planned.filter((c) => !core.includes(c));
    if (everyday.length > 0 && (lock || core.length > 0)) {
        const first = everyday[0].setting.split('.')[0];
        throw new ShapeChangeError(400, 'one_kind_per_request', lock ? oneKindToLock(namesOf(everyday)) : oneKindWhileLocked(namesOf(core), namesOf(everyday)), first);
    }
    return core;
}

/** The settings' names, once each, for the sentences above. */
function namesOf(lines: readonly PlannedChange[]): string {
    return [...new Set(lines.map((c) => SETTING_NAMES[c.setting.split('.')[0] as ShapeSettingName]))].join(', ');
}

/** One Core change as the owners' alert says it: the setting, and from what to what (a known-floor line names its part). */
function lineWords(c: PlannedChange): string {
    const [base, part] = c.setting.split('.');
    const name = SETTING_NAMES[base as ShapeSettingName];
    const what = part === 'on' ? 'the dial' : part === 'floor' ? 'the floor' : part === 'cap' ? 'the cap' : null;
    return `${name}${what ? `, ${what}` : ''} (${c.from ?? 'not set'} → ${c.to})`;
}

/** The request read and checked whole, as applyShapeChanges writes it: every refusal thrown, nothing written. */
function planShapeChanges(body: unknown): ShapePlan {
    if (getNodeRole() !== 'primary') throw new ShapeChangeError(409, 'standby', SHAPE_STANDBY);
    const { changes, note: rawNote, lock: rawLock } = (body && typeof body === 'object' ? body : {}) as { changes?: unknown; note?: unknown; lock?: unknown };
    // Only `true`: the group is never unlocked (DESIGN-core-settings-fable.md Q2).
    if (rawLock !== undefined && rawLock !== true) bad(undefined, 'lock is true (Confirm and lock), or left out: core settings are never unlocked as a group.', 'bad_lock');
    const lockAsked = rawLock === true;
    // Confirm and lock may change nothing: it confirms the settings as they are.
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!(lockAsked && (changes === undefined || (isObj(changes) && Object.keys(changes).length === 0)))
        && (!isObj(changes) || Object.keys(changes).length === 0)) {
        bad(undefined, 'Send changes: at least one setting and its new value.', 'no_changes');
    }
    const asked = (changes ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(asked)) {
        if ((SETTINGS_IN_ORDER as readonly string[]).includes(key)) continue;
        // Its own keys only: `in` reads Object.prototype too, so `constructor` would answer a function's source (#2415 review r4360595004).
        if (Object.prototype.hasOwnProperty.call(NOT_CHANGED_HERE, key)) bad(key, NOT_CHANGED_HERE[key], 'not_changeable');
        bad(key, `${key} is not a setting of how this community works.`);
    }
    const note = noteOf(rawNote);

    const before = readShape();
    const S = before.settings;
    const cfg = getConfiguredSwitches();
    const planned: PlannedChange[] = [];
    const switches: [ProfileSwitch, boolean][] = [];
    const share: Partial<NodeConfig> = {};
    let door: CommunityDoor | null = null;
    let floorPlan: KnownFloorPlan | null = null;
    let copies: RecoveryCopies | null = null;
    let decider: RemovalDecider | null = null;

    // Who can join: the door row, and the `invites` override (paused).
    let join: JoinState | undefined;
    if (asked.join !== undefined) {
        // The open door is no choice an owner makes: refused in the words the door has always given (config/door.ts).
        if (asked.join === 'open') {
            const open = doorSettingRefusal('open')!;
            throw new ShapeChangeError(open.status as 409, open.code, open.error, 'join');
        }
        if (asked.join !== 'members' && asked.join !== 'admins' && asked.join !== 'paused') {
            bad('join', "join is 'members', 'admins' or 'paused'. The open door is set by this server's kind.");
        }
        join = asked.join as JoinState;
        if (join !== S.join.configured) {
            if (S.join.lock?.code === 'private_preview' || S.join.configured === 'open') {
                refuse('join', S.join.lock ?? { code: 'profile', why: NOT_CHANGED_HERE.openDoor });
            }
            // The join this request leaves set must read as asked, by the shape's own rule: paused is invites off, which
            // where the open door is set reads as that door (#2415 review r4360864333). With no preview (refused above), the
            // node then runs it as set too, so nobody new joins by any door while paused, and un-pausing is the owner's.
            if (configuredJoinOf({ openJoin: cfg.openJoin, invites: join !== 'paused' }, () => join as CommunityDoor) !== join) {
                refuse('join', LOCKS_AFTER_A_CHANGE.pausedBesideOpenDoor(before));
            }
            planned.push({ setting: 'join', from: S.join.configured, to: join });
            if (join === 'paused') switches.push(['invites', false]);
            else {
                door = join as CommunityDoor;
                if (!cfg.invites) switches.push(['invites', true]);
            }
        }
    }
    const invitesAfter = join !== undefined ? join !== 'paused' : cfg.invites;

    // The 12-words door, only where the open door is set; refused where the shape locks it.
    if (asked.wordsDoor !== undefined) {
        const v = boolOf('wordsDoor', asked.wordsDoor);
        if (!S.wordsDoor) bad('wordsDoor', '12 words at the door are only for a community whose door is open (the global kind).', 'not_changeable');
        if (v !== S.wordsDoor!.configured) {
            if (S.wordsDoor!.lock) refuse('wordsDoor', S.wordsDoor!.lock);
            planned.push({ setting: 'wordsDoor', from: onOff(S.wordsDoor!.configured), to: onOff(v) });
            switches.push(['ssoRequiredForJoin', !v]);
        }
    }

    // The person check on busy days: only where the open door is set; no lock, and members are not told (the sentence
    // they would read is on the door, for those who meet it).
    if (asked.doorCheck !== undefined) {
        const v = boolOf('doorCheck', asked.doorCheck);
        if (!S.doorCheck) bad('doorCheck', 'A person check is only for a community whose door is open (the global kind).', 'not_changeable');
        if (v !== S.doorCheck!.configured) {
            planned.push({ setting: 'doorCheck', from: onOff(S.doorCheck!.configured), to: onOff(v) });
            switches.push(['doorCheck', v]);
        }
    }

    // Requests to join: never under the preview, nor without invites once this request is written.
    if (asked.knocks !== undefined) {
        const v = boolOf('knocks', asked.knocks);
        if (v !== S.knocks.configured) {
            if (S.knocks.lock?.code === 'private_preview') refuse('knocks', S.knocks.lock);
            if (!invitesAfter) refuse('knocks', LOCKS_AFTER_A_CHANGE.invitesOff());
            planned.push({ setting: 'knocks', from: onOff(S.knocks.configured), to: onOff(v) });
            switches.push(['knocks', v]);
        }
    }

    // Beans: off only before anything moved; on never while the open door is set.
    let beansAfter = S.beans.value;
    if (asked.beans !== undefined) {
        const v = boolOf('beans', asked.beans);
        if (v !== S.beans.configured) {
            if (!v && S.beans.lock?.code === 'ledger_moved') refuse('beans', S.beans.lock);
            if (v && S.beans.lock?.code === 'profile') refuse('beans', S.beans.lock);
            planned.push({ setting: 'beans', from: onOff(S.beans.configured), to: onOff(v) });
            switches.push(['beans', v]);
            beansAfter = v;
        }
    }

    // The known floor: its own checks for the amounts, and none without Beans once this request is written.
    if (asked.knownFloor !== undefined) {
        const kf = asked.knownFloor;
        if (!kf || typeof kf !== 'object' || Array.isArray(kf) || Object.keys(kf).length === 0
            || Object.keys(kf).some((k) => k !== 'on' && k !== 'floor_c' && k !== 'cap_c')) {
            bad('knownFloor', 'knownFloor is { on, floor_c, cap_c }, each optional: the dial, the known floor and the cap (whole hundredths of a Bean).');
        }
        const { on, floor_c: floor, cap_c: cap } = kf as { on?: unknown; floor_c?: unknown; cap_c?: unknown };
        let plan: KnownFloorPlan;
        try {
            // Beans are this route's to check, after the request: the amounts are the known floor's.
            plan = checkKnownFloorSettings({ confirmation: on, knownFloor_c: floor, creditCap_c: cap }, true);
        } catch (e) {
            if (!(e instanceof KnownFloorError)) throw e;
            throw new ShapeChangeError(400, e.code, e.message, 'knownFloor');
        }
        // The dial the owner set, not the off Beans-off reads it as: Beans on and the dial off in one request writes the off.
        const lines: PlannedChange[] = [];
        if (plan.confirmation !== undefined && plan.confirmation !== plan.before.confirmationSet) {
            lines.push({ setting: 'knownFloor.on', from: onOff(plan.before.confirmationSet), to: onOff(plan.confirmation) });
        }
        if (plan.floor !== plan.before.knownFloor_c) lines.push({ setting: 'knownFloor.floor', from: String(plan.before.knownFloor_c), to: String(plan.floor) });
        if (plan.cap !== plan.before.creditCap_c) lines.push({ setting: 'knownFloor.cap', from: String(plan.before.creditCap_c), to: String(plan.cap) });
        // The dial asked on reads off all the same without Beans: refused, as any change is, never a 200 that leaves it off.
        if ((lines.length > 0 || plan.confirmation === true) && !beansAfter) refuse('knownFloor', LOCKS_AFTER_A_CHANGE.beansOff());
        if (lines.length > 0) {
            planned.push(...lines);
            floorPlan = plan;
        }
    }

    // The budget each voucher starts with (slice V5): 100 to 2,000 in 100s; none without Beans once this request is written.
    let budget: number | null = null;
    if (asked.voucherBudget !== undefined) {
        if (!isBudgetLevel(asked.voucherBudget)) bad('voucherBudget', VOUCHER_WORDS.badLevel);
        const v = asked.voucherBudget as number;
        if (v !== S.voucherBudget.configured) {
            if (!beansAfter) refuse('voucherBudget', LOCKS_AFTER_A_CHANGE.beansOffBudget());
            planned.push({ setting: 'voucherBudget', from: String(S.voucherBudget.configured), to: String(v) });
            budget = v;
        }
    }

    // A member's credit-line gift (slice G1): the most one gift may be, 0 (off) to 100; none without Beans once this
    // request is written.
    let gift: number | null = null;
    if (asked.memberGift !== undefined) {
        if (!isMemberGiftSetting(asked.memberGift)) bad('memberGift', VOUCHER_WORDS.badGift);
        const v = asked.memberGift as number;
        if (v !== S.memberGift.configured) {
            if (!beansAfter) refuse('memberGift', LOCKS_AFTER_A_CHANGE.beansOffGift());
            planned.push({ setting: 'memberGift', from: String(S.memberGift.configured), to: String(v) });
            gift = v;
        }
    }

    // Message requests: only on a build that has the switch.
    if (asked.dmRequests !== undefined) {
        const v = boolOf('dmRequests', asked.dmRequests);
        if (!S.dmRequests) bad('dmRequests', 'This server has no message requests yet.', 'not_changeable');
        if (v !== S.dmRequests!.configured) {
            planned.push({ setting: 'dmRequests', from: onOff(S.dmRequests!.configured), to: onOff(v) });
            switches.push(['dmRequests', v]);
        }
    }

    // Sharing outside: never set on while the private preview shows visitors nothing.
    if (asked.shareOutside !== undefined) {
        const v = boolOf('shareOutside', asked.shareOutside);
        if (v !== S.shareOutside.configured) {
            if (v && S.shareOutside.lock) refuse('shareOutside', S.shareOutside.lock);
            planned.push({ setting: 'shareOutside', from: onOff(S.shareOutside.configured), to: onOff(v) });
            switches.push(['shareOutside', v]);
        }
    }

    // Votes and the three safety switches: no lock.
    for (const setting of ['decisions', 'probation', 'autoHide', 'autoMute'] as const satisfies readonly SwitchSetting[]) {
        if (asked[setting] === undefined) continue;
        const v = boolOf(setting, asked[setting]);
        if (v === S[setting].configured) continue;
        planned.push({ setting, from: onOff(S[setting].configured), to: onOff(v) });
        switches.push([SWITCH_OF[setting], v]);
    }

    // Listed: the global kind's; never switched on where this server's env holds every push back.
    if (asked.listed !== undefined) {
        const v = boolOf('listed', asked.listed);
        if (v !== S.listed.configured) {
            if (S.listed.lock?.code === 'profile') refuse('listed', S.listed.lock);
            if (v && directoryUnlistedByEnv()) refuse('listed', LOCKS_AFTER_A_CHANGE.unlisted());
            planned.push({ setting: 'listed', from: onOff(S.listed.configured), to: onOff(v) });
            switches.push(['publishToDirectory', v]);
        }
    }

    // What the directory is sent: no lock.
    for (const setting of Object.keys(SHARE_FIELD_OF) as ShareSetting[]) {
        if (asked[setting] === undefined) continue;
        const v = boolOf(setting, asked[setting]);
        if (v === S[setting].configured) continue;
        planned.push({ setting, from: onOff(S[setting].configured), to: onOff(v) });
        (share as Record<string, boolean>)[SHARE_FIELD_OF[setting]] = v;
    }

    // Where members' copies go: no lock (config/recovery-copies.ts).
    if (asked.recoveryCopies !== undefined) {
        if (!isRecoveryCopies(asked.recoveryCopies)) {
            bad('recoveryCopies', "recoveryCopies is 'vault' (BeanPool's key vault), 'server' (this server) or 'none' (nowhere).");
        }
        const v = asked.recoveryCopies as RecoveryCopies;
        if (v !== S.recoveryCopies.configured) {
            planned.push({ setting: 'recoveryCopies', from: S.recoveryCopies.configured, to: v });
            copies = v;
        }
    }

    // Who decides a removal: a jury refused while the pool is too small for one (config/removal-decider.ts).
    if (asked.removalDecider !== undefined) {
        if (!isRemovalDecider(asked.removalDecider)) {
            bad('removalDecider', "removalDecider is 'automatic' (a jury from 100 members), 'everyone' or 'jury'.");
        }
        const v = asked.removalDecider as RemovalDecider;
        if (v === 'jury' && S.removalDecider.lock) refuse('removalDecider', S.removalDecider.lock);
        // Stored as a row whatever it is (setRemovalDecider), so a later change of default never overrides a choice: the
        // default chosen while it is still the default is written too, quietly (review of #2793), with no log line and nothing
        // told to anyone, since no rule changes today. When J3 moves the default, that community keeps Everyone.
        if (v !== S.removalDecider.configured) {
            planned.push({ setting: 'removalDecider', from: S.removalDecider.configured, to: v });
            decider = v;
        } else if (S.removalDecider.source === 'default') {
            decider = v;
        }
    }

    // Core settings (config/core-settings.ts): while locked, or confirming, one kind per request; confirmed only once, and
    // only with the community's place where its kind needs one.
    const core = lockAsked || before.core.lock !== null
        ? oneKindOnly(planned, before, lockAsked)
        : planned.filter((c) => isCoreChange(c.setting, c.to, S.join.door));
    if (lockAsked) {
        if (before.core.lock) throw new ShapeChangeError(409, 'core_locked', CORE_LOCKED_ALREADY);
        if (before.core.place.needed && !before.core.place.set) throw new ShapeChangeError(409, 'place_needed', CORE_PLACE_NEEDED);
    }
    return { before, note, lock: lockAsked, planned, core, switches, share, door, floorPlan, budget, gift, copies, decider, beansAfter };
}

/** The notice's title, as every member reads it. */
export const memberNoticeTitle = (): string => tr(NOTICE.title);

/** One notice's body: each change's sentence on its own line, then the owner's note, quoted. */
export function memberNoticeBody(sentences: readonly string[], note: string | null): string {
    return [sentences.join('\n'), ...(note ? [tr(NOTICE.note, { note })] : [])].join('\n\n');
}

/**
 * The notices for one request: as few as hold every sentence within a kept notice's body (engine/kept-notices.ts
 * NOTICE_LIMITS: a longer one is never kept, so a web member would miss it), the note with the last. A page's save is
 * one change, so one notice; only a request that changes many rules at once is ever split.
 */
export function memberNoticeBodies(sentences: readonly string[], note: string | null): string[] {
    const groups: string[][] = [];
    for (const s of sentences) {
        const last = groups[groups.length - 1];
        if (last && memberNoticeBody([...last, s], null).length <= NOTICE_LIMITS.body) last.push(s);
        else groups.push([s]);
    }
    const bodies = groups.map((g) => memberNoticeBody(g, null));
    if (note) {
        const withNote = memberNoticeBody(groups[groups.length - 1], note);
        if (withNote.length <= NOTICE_LIMITS.body) bodies[bodies.length - 1] = withNote;
        else bodies.push(tr(NOTICE.note, { note }));
    }
    return bodies;
}
