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
 * within its step-up). A standby changes nothing (409 `standby`). No fresh proof: that is only for turning the private
 * preview off (Q13), which is not a setting here yet (slice S7).
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
 *   listed      refused on the global kind (`profile`); on refused while DIRECTORY_UNLISTED holds every push back.
 *   dmRequests, decisions, probation, autoHide, autoMute, shareLocation, shareMemberCount, shareEmail, sharePhone,
 *   shareHealth: no lock.
 *   recoveryCopies  'vault' | 'server' | 'none' (config/recovery-copies.ts, vault rethink VR2): no lock. Only where new
 *               copies go; every copy a member already has stays theirs, and the members' sentence says so.
 * The other locks only say why a value is what it is (held back, an auth hatch, members on demand, a standby's Listed):
 * nothing here changes them, and they refuse nothing.
 *
 * Members are told of a change they live by, never of one that changes nothing they see: the 12-words door set on behind
 * a shut open door, or Beans set on where a moved ledger already runs them (the owners' line and alert still say what
 * was set). The open door, the private preview, visitors
 * and connections are the server's: 400.
 */
import { word, wordsFor, type WordKey } from '@beanpool/core';
import { db } from '../db/db.js';
import { getNodeConfig, updateNodeConfig, noticeToEveryMember, type NodeConfig } from '../state-engine.js';
import { getNodeRole } from './node-role.js';
import { getConfiguredSwitches, setSwitchOverride, type ProfileSwitch } from './node-profile.js';
import { setDoor, doorSettingRefusal, type CommunityDoor } from './door.js';
import { isRecoveryCopies, setRecoveryCopies, type RecoveryCopies } from './recovery-copies.js';
import { NOTICE_LIMITS } from '../engine/kept-notices.js';
import { checkKnownFloorSettings, writeKnownFloorSettings, KnownFloorError, type KnownFloorPlan } from './known-floor.js';
import { readShape, configuredJoinOf, LOCKS_AFTER_A_CHANGE, type JoinState, type Shape, type ShapeLock } from './community-shape.js';
import { directoryUnlistedByEnv, initDirectoryPublisher, listedSwitchedOff } from '../services/directory-publisher.js';
import { noteSecurityEvent, OWNER_ALERT_WORDS } from '../services/security-signal.js';

const { t: tr } = wordsFor('en');

/** The longest note an owner may add to the members' notice, in characters (design §6.1). */
export const SHAPE_NOTE_MAX = 200;

export const SHAPE_OWNER_ONLY = 'Only an owner of this community can change how it works';
export const SHAPE_STANDBY = 'This server is a standby copy of the community, not its main server. Change how it works on the main server.';

/** A refusal: the status, a code the page reads, and the sentence it shows (a lock's own why, for a 409). */
export class ShapeChangeError extends Error {
    constructor(readonly status: 400 | 409, readonly code: string, message: string, readonly setting?: string, readonly unlock?: string) {
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
    knocks: 'knocks', beans: 'beans', dmRequests: 'dmRequests', decisions: 'decisions', listed: 'publishToDirectory',
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
    'join', 'wordsDoor', 'knocks', 'beans', 'knownFloor', 'dmRequests', 'decisions', 'listed',
    'shareLocation', 'shareMemberCount', 'shareEmail', 'sharePhone', 'shareHealth', 'probation', 'autoHide', 'autoMute',
    'recoveryCopies',
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
const SETTING_NAMES: Record<ShapeSettingName, string> = {
    join: 'Who can join', wordsDoor: '12 words at the open door', knocks: 'Requests to join', beans: 'Beans',
    knownFloor: 'Known floor for confirmed members', dmRequests: 'First message from someone new',
    decisions: 'Community votes (Decisions)', listed: 'Listed in the BeanPool directory',
    shareLocation: 'Share location & radius', shareMemberCount: 'Share member count', shareEmail: 'Share email',
    sharePhone: 'Share phone', shareHealth: 'Share health', probation: 'Limits on new accounts',
    autoHide: 'Reported posts hidden automatically', autoMute: 'Repeat offenders muted automatically',
    recoveryCopies: "Where members' copies go",
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
    dmOn: word("Your community's owners changed how it works: a first message from someone new now waits until you accept it."),
    dmOff: word("Your community's owners changed how it works: every message now arrives straight away."),
    decisionsOn: word("Your community's owners changed how it works: community votes are on."),
    decisionsOff: word("Your community's owners changed how it works: community votes are off; the moderators look after things."),
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
    note: word('From the owners: “{note}”'),
} satisfies Record<string, WordKey>;

const beansAmount = (n: number) => n.toLocaleString('en');

/** The fixed sentence a member reads for one change, or null where members are not told (the directory switches). */
function memberSentence(change: PlannedChange): string | null {
    const on = change.to === 'on';
    switch (change.setting) {
        case 'join': return change.to === 'admins' ? tr(NOTICE.joinAdmins) : change.to === 'paused' ? tr(NOTICE.joinPaused) : tr(NOTICE.joinMembers);
        case 'wordsDoor': return on ? tr(NOTICE.wordsOn) : tr(NOTICE.wordsOff);
        case 'knocks': return on ? tr(NOTICE.knocksOn) : tr(NOTICE.knocksOff);
        case 'beans': return on ? tr(NOTICE.beansOn) : tr(NOTICE.beansOff);
        case 'dmRequests': return on ? tr(NOTICE.dmOn) : tr(NOTICE.dmOff);
        case 'decisions': return on ? tr(NOTICE.decisionsOn) : tr(NOTICE.decisionsOff);
        case 'probation': return on ? tr(NOTICE.probationOn) : tr(NOTICE.probationOff);
        case 'autoHide': return on ? tr(NOTICE.autoHideOn) : tr(NOTICE.autoHideOff);
        case 'autoMute': return on ? tr(NOTICE.autoMuteOn) : tr(NOTICE.autoMuteOff);
        case 'recoveryCopies': return change.to === 'none' ? tr(NOTICE.copiesNone) : change.to === 'server' ? tr(NOTICE.copiesServer) : tr(NOTICE.copiesVault);
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
    if (dialAfter && plan.floor !== plan.before.knownFloor) return tr(NOTICE.floorNow, { floor: beansAmount(plan.floor) });
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

/**
 * The owner's change to how this community works, all or nothing: checked whole against the shape as it is, then written,
 * logged, told to the owners and, for members' rules, to every member. Throws ShapeChangeError (400, 409) with nothing
 * written. `body`: `{ changes: { <setting>: <value>, … }, note? }`.
 */
export function applyShapeChanges(by: ShapeActor, body: unknown): { shape: Shape; told: 'members' | 'nobody'; changed: string[] } {
    if (getNodeRole() !== 'primary') throw new ShapeChangeError(409, 'standby', SHAPE_STANDBY);
    const { changes, note: rawNote } = (body && typeof body === 'object' ? body : {}) as { changes?: unknown; note?: unknown };
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
        bad(undefined, 'Send changes: at least one setting and its new value.', 'no_changes');
    }
    const asked = changes as Record<string, unknown>;
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
            || Object.keys(kf).some((k) => k !== 'on' && k !== 'floor' && k !== 'cap')) {
            bad('knownFloor', 'knownFloor is { on, floor, cap }, each optional: the dial, the known floor and the cap.');
        }
        const { on, floor, cap } = kf as { on?: unknown; floor?: unknown; cap?: unknown };
        let plan: KnownFloorPlan;
        try {
            // Beans are this route's to check, after the request: the amounts are the known floor's.
            plan = checkKnownFloorSettings({ confirmation: on, knownFloor: floor, creditCap: cap }, true);
        } catch (e) {
            if (!(e instanceof KnownFloorError)) throw e;
            throw new ShapeChangeError(400, e.code, e.message, 'knownFloor');
        }
        // The dial the owner set, not the off Beans-off reads it as: Beans on and the dial off in one request writes the off.
        const lines: PlannedChange[] = [];
        if (plan.confirmation !== undefined && plan.confirmation !== plan.before.confirmationSet) {
            lines.push({ setting: 'knownFloor.on', from: onOff(plan.before.confirmationSet), to: onOff(plan.confirmation) });
        }
        if (plan.floor !== plan.before.knownFloor) lines.push({ setting: 'knownFloor.floor', from: String(plan.before.knownFloor), to: String(plan.floor) });
        if (plan.cap !== plan.before.creditCap) lines.push({ setting: 'knownFloor.cap', from: String(plan.before.creditCap), to: String(plan.cap) });
        // The dial asked on reads off all the same without Beans: refused, as any change is, never a 200 that leaves it off.
        if ((lines.length > 0 || plan.confirmation === true) && !beansAfter) refuse('knownFloor', LOCKS_AFTER_A_CHANGE.beansOff());
        if (lines.length > 0) {
            planned.push(...lines);
            floorPlan = plan;
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

    if (planned.length === 0) return { shape: before, told: 'nobody', changed: [] };

    // ── Written, all of it or none ──
    const at = new Date().toISOString();
    const insertLine = db.prepare(`INSERT INTO community_settings_log (actor_pubkey, actor_role, setting, old_value, new_value, note, at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
        for (const [name, on] of switches) setSwitchOverride(name, on);
        if (door) setDoor(door);
        if (floorPlan) writeKnownFloorSettings(by.actor, floorPlan, at);
        if (Object.keys(share).length > 0) updateNodeConfig(share);
        if (copies) setRecoveryCopies(copies);
        for (const line of planned) insertLine.run(by.actor, 'owner', line.setting, line.from, line.to, note, at);
    })();

    // ── Then the node, the owners and the members ──
    const changedSettings = [...new Set(planned.map((c) => c.setting.split('.')[0] as ShapeSettingName))];
    if (changedSettings.includes('listed')) initDirectoryPublisher();
    // Listed switched off: the community's row leaves the public directory now, not when it goes stale in 7 days (front
    // doors S13). One signed withdraw, only if this server has pushed; not awaited (services/directory-publisher.ts).
    if (switches.some(([name, on]) => name === 'publishToDirectory' && on === false)) listedSwitchedOff();
    const shape = readShape();
    console.log(`🧭 How this community works: ${planned.map((c) => `${c.setting} ${c.from} → ${c.to}`).join(', ')}, set by ${by.actor}.`);
    noteSecurityEvent({
        key: 'sec.settings',
        detail: OWNER_ALERT_WORDS.shapeChanged(changedSettings.map((s) => SETTING_NAMES[s]).join(', ')),
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
