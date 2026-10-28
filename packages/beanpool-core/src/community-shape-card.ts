/**
 * The members' read-only community shape card and sheet (design §4, slice S5).
 * Generates the member-facing facts from `features` (+ `door`), the Home summary line,
 * and handles an old node that says nothing (produces no line).
 */
import { formatNumber, t, word } from './words.js';

export interface CommunityShapeFeatures {
    beans?: boolean;
    knocks?: boolean;
    decisions?: boolean;
    invites?: boolean;
    door?: 'open' | 'members' | 'admins';
    wordsDoor?: boolean;
    openJoin?: boolean;
    privatePreview?: boolean;
    probation?: boolean;
    autoHideReports?: boolean;
    autoMute?: boolean;
    dmRequests?: boolean;
    knownFloor?: number;
    showcase?: boolean;
}

/**
 * Word keys for community shape member strings.
 * Exposed so tests and catalogs can refer to them.
 */
export const COMMUNITY_SHAPE_CARD_WORDS = {
    // Summary line parts
    anyMemberInvites: word('any member invites'),
    onlyAdminsInvite: word('only admins invite'),
    paused: word('paused'),
    anyoneJoins: word('anyone joins'),
    beansOn: word('Beans on'),
    beansOff: word('Beans off'),
    votesOn: word('votes on'),
    votesOff: word('votes off'),
    knocksOn: word('requests to join on'),
    knocksOff: word('requests to join off'),
    summary: word('How it works: {join} · {beans} · {votes} · {knocks}'),

    // Table 4.2 lines
    joinMembersKnocksOn: word('**Joining:** any member can invite someone; people can ask to join'),
    joinMembersKnocksOff: word('**Joining:** any member can invite someone; nobody can ask to join'),
    joinAdminsKnocksOn: word('**Joining:** only the admins invite people; people can ask to join'),
    joinAdminsKnocksOff: word('**Joining:** only the admins invite people'),
    joinPaused: word('**Joining:** paused — no new members for now'),
    joinOpenWords: word('**Joining:** anyone, with 12 words or a sign-in'),
    joinOpenSso: word('**Joining:** anyone, with a sign-in'),
    preview: word('**Private preview:** only people the owner or an admin invites get in; visitors see nothing'),
    beansOnLine: word('**Beans:** on — trades, credit and the Commons'),
    beansOffLine: word('**Beans:** off — no prices, no credit here'),
    knownFloorLine: word('**Confirmed members** can owe up to {amount} Beans (the known floor)'),
    dmRequestsOnLine: word('**Messages:** a first message from someone new waits until you accept it'),
    dmRequestsOffLine: word('**Messages:** arrive straight away'),
    decisionsOnLine: word('**Decisions:** members vote; anyone who has completed a trade, and the admins, can propose'),
    decisionsOffLine: word('**Decisions:** off — the moderators look after this community'),
    probationLine: word('**New accounts:** limits for their first days'),
    autoHideLine: word('**Reported posts** are hidden until a moderator looks'),
    autoMuteLine: word('**Repeat offenders** are muted automatically'),

    // Modal / Sheet header and footer
    title: word('How this community works'),
    readMoreInGuide: word('Read more in the guide'),
    settingsRowSubtitle: word('Who can join, Beans, decisions and safety rules for this community'),
};

/**
 * Whether the features object is from an old node that says nothing about its shape (design §4, S5).
 * An old node that says nothing produces no line on Home and no lines on the sheet.
 */
export function isOldNodeWithoutShape(features: CommunityShapeFeatures | null | undefined): boolean {
    if (!features || typeof features !== 'object') return true;
    return features.beans === undefined
        && features.knocks === undefined
        && features.decisions === undefined
        && features.invites === undefined
        && features.door === undefined
        && features.openJoin === undefined
        && features.privatePreview === undefined;
}

/**
 * The full list of member-facing community facts (design §4.2 Table 4.2).
 * One line per fact; only facts that are true are drawn; nothing is drawn as locked.
 * An old node that says nothing returns an empty array.
 */
export function communityShapeLines(features: CommunityShapeFeatures | null | undefined): string[] {
    if (isOldNodeWithoutShape(features)) return [];

    const lines: string[] = [];

    // 1. Joining / Door
    if (features?.openJoin === true || features?.door === 'open') {
        if (features?.wordsDoor === false) {
            lines.push(t('**Joining:** anyone, with a sign-in'));
        } else {
            lines.push(t('**Joining:** anyone, with 12 words or a sign-in'));
        }
    } else if (features?.invites === false) {
        lines.push(t('**Joining:** paused — no new members for now'));
    } else if (features?.door === 'admins') {
        if (features?.knocks === true) {
            lines.push(t('**Joining:** only the admins invite people; people can ask to join'));
        } else {
            lines.push(t('**Joining:** only the admins invite people'));
        }
    } else {
        // door === 'members' or default
        if (features?.knocks === false) {
            lines.push(t('**Joining:** any member can invite someone; nobody can ask to join'));
        } else {
            lines.push(t('**Joining:** any member can invite someone; people can ask to join'));
        }
    }

    // 2. Private preview (only drawn when on)
    if (features?.privatePreview === true) {
        lines.push(t('**Private preview:** only people the owner or an admin invites get in; visitors see nothing'));
    }

    // 3. Beans
    if (features?.beans === false) {
        lines.push(t('**Beans:** off — no prices, no credit here'));
    } else if (features?.beans === true || features?.beans === undefined) {
        lines.push(t('**Beans:** on — trades, credit and the Commons'));
    }

    // 4. Known floor (only drawn when present, i.e. dial and beans are on)
    if (typeof features?.knownFloor === 'number') {
        lines.push(t('**Confirmed members** can owe up to {amount} Beans (the known floor)', { amount: formatNumber(features.knownFloor) }));
    }

    // 5. Messages / dmRequests
    if (features?.dmRequests === true) {
        lines.push(t('**Messages:** a first message from someone new waits until you accept it'));
    } else if (features?.dmRequests === false) {
        lines.push(t('**Messages:** arrive straight away'));
    }

    // 6. Decisions
    if (features?.decisions === true || (features?.decisions === undefined && !features?.openJoin)) {
        lines.push(t('**Decisions:** members vote; anyone who has completed a trade, and the admins, can propose'));
    } else if (features?.decisions === false) {
        lines.push(t('**Decisions:** off — the moderators look after this community'));
    }

    // 7. Probation (only drawn when on)
    if (features?.probation === true) {
        lines.push(t('**New accounts:** limits for their first days'));
    }

    // 8. Auto-hide reports (only drawn when on)
    if (features?.autoHideReports === true) {
        lines.push(t('**Reported posts** are hidden until a moderator looks'));
    }

    // 9. Auto-mute (only drawn when on)
    if (features?.autoMute === true) {
        lines.push(t('**Repeat offenders** are muted automatically'));
    }

    return lines;
}

/**
 * The one-line summary for Home's community card (design §4.1).
 * "How it works: any member invites · Beans on · votes on · requests to join on"
 * Returns null if the node says nothing about its shape.
 */
export function communityShapeSummary(features: CommunityShapeFeatures | null | undefined): string | null {
    if (isOldNodeWithoutShape(features)) return null;

    let joinText: string;
    if (features?.openJoin === true || features?.door === 'open') {
        joinText = t('anyone joins');
    } else if (features?.invites === false) {
        joinText = t('paused');
    } else if (features?.door === 'admins') {
        joinText = t('only admins invite');
    } else {
        joinText = t('any member invites');
    }

    const beansText = features?.beans === false ? t('Beans off') : t('Beans on');
    const votesText = features?.decisions === false ? t('votes off') : t('votes on');
    const knocksText = features?.knocks === false ? t('requests to join off') : t('requests to join on');

    return t('How it works: {join} · {beans} · {votes} · {knocks}', {
        join: joinText,
        beans: beansText,
        votes: votesText,
        knocks: knocksText,
    });
}
