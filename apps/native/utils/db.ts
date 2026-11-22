import * as SQLite from 'expo-sqlite';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadIdentity } from './identity';
import * as Crypto from 'expo-crypto';
import { encodeBase64, encodeUtf8, decodeBase64, decodeUtf8, buildSignedHeaders, signData, hexToBytes } from './crypto';
import { eventCacheColumns, rsvpSignedMessage, isSignableRsvp, UNSIGNABLE_RSVP_MESSAGE, type EventEditPatch, type EventRsvpStatus, type EventZone } from './events';
import { sortMyEvents, type MyEvent } from './event-extras';
import {
    sealDmLine, dmLineDisclosureFor, openDmLine, checkDmThread, dmAfterReference, dmLineMarkText, dmLineShownText, dmLineIsUnattributed, dmReplyToOf,
    dmLineKind, dmQuoteLabel, dmQuoteFrom, isEncryptedNonce, V2_NONCE_PREFIX, DM_LINE_NOT_ENCRYPTED_TEXT,
    dmLineIsOld,
    type DMKeyContext, type DmPart,
} from './e2e-crypto';
import { DmNotLockedError, DmKeyChangedError, isNodeReadableChatType, isKeyStoreUnread } from './dm-lock';
import {
    createDmPinBook, dmPinFor, dmSightFor, dmPinId, pinKeyOf, pinAtFirstSight, applyDmListings, applySightVerdict, applyResetVerdict, judgeFirstSight,
    settleFirstSight, isUnplacedSight, isHeldLostSight, markHeldLost, isDmPinStoreError, isDmPinsFullError, DmPinsFullError, isPinnableId,
    noRoomForFirstSight, rekeyDateOf, DM_PINS_WORDS, acceptOffer, restDmEntry, dmEntryRestless, dmEntryWaitsForMember, markableKey, settleMarkedPin, dmShownFormer,
    type DmPeerPins, type DmPeerPin, type DmPinEntry, type DmHeard, type SightVerdict, type DmPinsReset, type DmPeerOffer,
} from './dm-peer-pins';
import { createDmVerifiedBook, isVerifiedPin, showsVerifiedMark, DmVerifiedStoreError, type DmVerifiedKeys } from './dm-verified-keys';
import { dmPeerKeys, dmPeerName, isDmType } from './dm-blocked';
import type { BlockLists } from './blocklist';
import { dmLinesAtUpdateStoreKey, messageRequestsStoreKey } from './storage-keys';
import { LISTED_ADDRESS_FIELDS } from './listed-address-fields';
import { createDmSeenList, DmGuardUnreadError, isDmGuardUnreadError, readDmSeen } from './dm-guard-list';
import { REPORT_REASONS, CHILD_SAFETY_REASON, type ReportWordsLeftOut } from './reportReasons';
import { getDatabaseFilenameForNode, addSavedNode, clearGuestNode, getSavedNodes, isGuestCopy } from './nodes';
import { getCachedNodeProfile, membersByKey, noteMembersOnDemand } from './node-profile';
import { isMembersOnDemandRefusal } from './members-on-demand';
import { communityCachesRenamed } from './cache-file-migration';
import { createHeldCopies } from './held-copies';
import { isPlainNodeAddress, plainOriginOf, shouldBlockCleartextNodeUrl } from './node-url';
import { photoOnCommunity } from './photo-address';
import { TOOL_DOCS_TABLE } from '../tools/schema';
import { getCanonicalProfile, saveCanonicalProfile } from './canonical-profile';
import { isPortableAvatarValue, resolveProfilePublishAvatar } from './avatar-value';
import { clearPendingProfileChange, clearWaitingArchetype, clearWaitingRemoval, nameRefusedForGood, pendingNameRefused, pendingProfileChange, waitingArchetype, waitingRemoval } from './pending-profile-sync';
import { adoptNewerRowIntoDevice, archetypeToSend, carryRowToNode, finishRemoval, healGuestMark, removalToSend } from './working-style';
import { emitAppEvent, CONVERSATION_READ_LOCALLY_EVENT } from './app-events';
import { HIDDEN_AUTHOR, postsViewRefusal, viewOf } from './posts-view';
import { postsTheNodeNoLongerHas, type HeldListing } from './posts-replace';
import { nearbyPrune, nearbyReconcile, type NearbyHeld } from './posts-nearby';
import { readGroupInvitations, type BillView, type GroupInvitations } from '@beanpool/core';
import { archetypeIsAfter, archetypeIsNewer, eventCopyColumn, mayChooseLongPolls, POLL_BALLOT_SEALED, POLL_NEXT_START_PATH, pollNextStartMs, reportKind, t, requestAfterOwnLine, requestAfterRead, freeTagsOf, listingFreeTags, postTagsOf, storedFreeTags, COUNTS_AS_UNREAD_SQL, countsAsUnreadSql, NOTIFY_WAITING_DAYS, type PinDays } from '@beanpool/core';
import { dealAction } from './deal-rows';
import { busyError, isBusyAnswer, isBusyStatus, refusalTextOf, retryAfterMs, waitBeforeRetry } from '@beanpool/core';
import { hundredthsAsDecimalText, isHundredths, perItemOf } from '@beanpool/core';
import { DM_FROM_ADMINS_KEY, DM_NONCE_PREFIX } from '@beanpool/core';
import type { StandingAsk, StandingAuthorisationFields, StandingPeriodUnit, StandingPhase, StandingStartBody } from '@beanpool/core';
import { chatAboutOfLine, metadataWithAbout, sealChatAbout, type AboutPostLike, type ChatAboutChip } from '@beanpool/core';
// Old chat's photos and cards: conversion code, log row OLDCHAT, remove after 12 Dec 2026 (core, as the web opens them).
import { chatAboutOfOldLine, openDmOldLineWords, openDmOldPhoto } from '@beanpool/core';
import { standingJsonOf, standingOfRow } from './standing-row';
import { TIER_LEVELS, isServableAvatarValue, onboardingEventKey, oncePerPersonVariant, pushedPostIsStale, verifyKeySuccession, type FormerKey, type LivePostChange, type ScopedDecisionList, type ScopedEffect, type GroupEffect, type JuryTurnout, type ServedJury } from '@beanpool/core';
// expo-file-system 55.x defaults to the new File/Paths API; the classic cacheDirectory +
// writeAsStringAsync helpers we use live under the /legacy entrypoint.
import * as FileSystem from 'expo-file-system/legacy';
import type { OwnDecisionVote } from './decision-own-vote';
import type { GroupSuccessionData } from './group-succession';
import { mergeIncomingMessage, isRemovedPayload, accountDeletedAuthor, accountDeletedMetadata, stillHoldsWords, withoutSendState, type LocalMessageRow } from './chat-sync';
import { DELETED_BY_AUTHOR_TEXT } from './chat-actions';
import type { BeanPoolIdentity } from './identity';
import { groupKeyring, joinGroupWithEpoch, approveWithEpoch, removeWithEpoch, forgetGroupKeys, forgetLockedRings, followLockedRings, followedFrom, groupsLockedIn, noteAnsweredLocked, noteLockedInCopy, GroupChatKeyError, GroupKeysRequestError, GROUP_KEY_STORE_UNREAD_TEXT, type GroupKeyring, type GroupKeyStore, type NeverLocked } from './group-chat-keys';
import {
    unlockWithOldWords, newPhoneQrPayload, checkNewPhone, confirmNewPhone, handOversHeld, noteConfirmations, confirmedNotes,
    lockedHistoryCounts, noteLockedHistoryCount, type ConfirmedNote, type HistoryGroup, type NewPhoneCheck, type OldWordsResult,
} from './group-history-unlock';
import { accountStays, whileAccountLeaves } from './account-leaving';
import { oldKeySignedHere, rekeysToMe } from './key-succession';
import { isKeyReplacedAnswer, noteKeyAnswered, noteKeyReplaced, watchForReplacedKey } from './key-replaced';
import { sqliteGroupKeyStore, GROUP_KEY_TABLES_SQL } from './group-chat-store';
import {
    OUTSIDE_CHAT_DROP_SQL, OUTSIDE_CHAT_TABLES_SQL, OUTSIDE_CHATS_HELD_SQL, OUTSIDE_LAST_CHANGES_HELD_SQL, outsideChatStore, outsideChatsFromHeld,
    type OutsideChat, type OutsideChatStore,
} from './outside-chat-store';
import { FORUM_KEPT_TABLE_SQL, forumKeptStore, type ForumKeptStore } from './forum-kept';
import {
    sendSealedGroupLine, editSealedGroupLine, reportSealedGroupLine, chatIsLocked, getDecryptedGroupAttachment, GROUP_CHAT_LOCK_LOST_TEXT, GROUP_CHAT_NOT_MEMBER_TEXT,
    GROUP_CHAT_OLD_NODE_NOTICE, GROUP_KEYS_FOR_DM_TEXT, GROUP_EDIT_LINE_GONE_TEXT, getDecryptedGroupVoiceLine,
} from './group-chat-lines';
import { sealDmVoice, VoiceRefusedError, VOICE_MIME, type VoiceInput } from '@beanpool/core';
import { openDmVoiceWithFormer } from './dm-voice';
import { forgetRemovedVoices, forgetVoice, keepVoice, keptVoice, type KeptVoice } from './voice-cache';
import { groupPhotoCache, forgetGroupPhotos, forgetRemovedGroupPhotos } from './group-photo-cache';
import type { GroupLineView, ServedGroupLine } from './group-line-display';
import { sealLine, GROUP_NONCE_PREFIX } from './group-chat-crypto';
import { languageHeader } from './language-choice';
import { SHOP_COMPOSER_WAIT_MS, clearShopChoice, peekShopChoice, sayOutsideShop, shopChoiceFor } from './shop-choice';

// Decrypted chat images live here — in the filesystem, NOT SQLite — so they survive a
// DB wipe-and-fetch (which only drops tables) and are populated lazily (only images the
// user actually opens), never bulk-pulled on sync.
const CHAT_IMAGE_CACHE_DIR = `${FileSystem.cacheDirectory}chat-images/`;

/**
 * Take the decrypted copy of a chat photo off this phone.
 *
 * getDecryptedAttachment writes the plaintext JPEG to the cache so an image is decrypted once per device.
 * A "delete for everyone" has to take it with it — on the deleter's phone AND on the peer's, when the
 * tombstone arrives in a sync — or the picture outlives the message it belonged to and sits in the cache
 * until the OS decides to trim it. The bubble already hides the attachment; this removes the file.
 *
 * Never throws: the tombstone is what matters, and a cache file we could not remove must not fail a delete.
 */
async function forgetCachedChatImage(messageId: string): Promise<void> {
    try {
        await FileSystem.deleteAsync(`${CHAT_IMAGE_CACHE_DIR}${messageId}.jpg`, { idempotent: true });
    } catch { /* nothing to do: the message is gone either way */ }
    // A voice message's kept sound goes the same way (utils/voice-cache.ts; it never throws).
    await forgetVoice(messageId);
}

/**
 * The community's copy open now: set only once its copy is made (openCopy, _doInitDB), so getDb never hands out a copy
 * still being cleared or made. Every reader, writer, sync cycle and the socket reach the copy through getDb.
 */
let db: SQLite.SQLiteDatabase | null = null;
/** The community file each open handle is for: a group's key store reads only its own community's (groupKeyStore). */
const dbFileOf = new WeakMap<object, string>();

// Global JS mutex to prevent expo-sqlite "database is locked" crashes
// arising from concurrent loops across background Pillar polls and foreground Inbox rendering.
// Two-lane queue: `urgent` acquirers (user-initiated writes — accept, release, rate)
// are granted before any queued background sync, so a button press never waits behind
// a backlog of poll-driven write bursts (observed 8–175s queues on-device, 2026-07-17).
// FIFO within each lane. Callers MUST pair every acquire with releaseSyncLock() in a
// finally block, and MUST NOT re-acquire while holding the lock (it is not reentrant).
// Never hold it across network I/O — only around the local SQLite writes themselves.
let syncLockHeld = false;
const syncLockUrgentQueue: Array<() => void> = [];
const syncLockNormalQueue: Array<() => void> = [];

async function acquireSyncLock(opts?: { urgent?: boolean }) {
    if (!syncLockHeld) {
        syncLockHeld = true;
        return;
    }
    const waitStart = Date.now();
    await new Promise<void>(resolve => {
        (opts?.urgent ? syncLockUrgentQueue : syncLockNormalQueue).push(resolve);
    });
    const waited = Date.now() - waitStart;
    if (waited > 2000) console.warn(`[DB] acquireSyncLock waited ${waited}ms (urgent=${!!opts?.urgent}, queued: ${syncLockUrgentQueue.length}u/${syncLockNormalQueue.length}n) — writers are outpacing the queue`);
}
function releaseSyncLock() {
    // Hand off directly to the next waiter (urgent lane first) so the lock is never
    // observed free by a late acquirer while earlier waiters are still queued.
    const next = syncLockUrgentQueue.shift() ?? syncLockNormalQueue.shift();
    if (next) next();
    else syncLockHeld = false;
}

let currentDbName: string | null = null;
let getDbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
/**
 * A community's copy moving to another name (whileCopyMoves): getDb opens nothing until it is done. Set only while the
 * move holds the sync lock, so a writer holding the lock never finds it set.
 */
let copyMoving: Promise<void> | null = null;

/**
 * The screens holding a chat in place now, by its community's file (slice S2): the chat while it is in view, its key code
 * screen while it shows, and Contacts while it starts a chat there (enterChatInPlace ... leaveChatInPlace). The copy open
 * in place closes as the last of them lets go.
 */
const chatsInPlaceHeld = new Map<string, number>();
/**
 * The files whose chat in place was left and not entered again (#3305 review): from leaveChatInPlace to the next
 * enterChatInPlace no copy of them opens in place (copyInPlaceFor, and heldCopies' `placeRefused` after every await), so
 * nothing still on its way as the chat was left (a poll's follow-up, a read, a late mark read, from the screen or outside
 * it) opens that copy again or asks that community's server anything.
 */
const chatsInPlaceLeft = new Set<string>();

/**
 * Read-only handles on other communities' copies, beside the one in use (slice S1, utils/held-copies.ts): the one owner of
 * them all. Opened only for a file that is on the phone, never the community in use, one being opened (currentDbName) or
 * while a copy moves; closed wherever the copy in use is closed (closeOpenCopy), before the copy in use opens that file
 * (openAndMakeCopy), and around every move or delete of a copy (whileCopyMoves, closeDB's `heldClosedUntil`).
 */
const heldCopies = createHeldCopies<SQLite.SQLiteDatabase, HeldStatement>({
    renamed: () => communityCachesRenamed(),
    exists: async (file) => {
        const directory = typeof SQLite.defaultDatabaseDirectory === 'string'
            ? SQLite.defaultDatabaseDirectory.replace(/^file:\/\//, '').replace(/\/+$/, '')
            : '';
        if (!directory) return false;
        return (await FileSystem.getInfoAsync(encodeURI(`file://${directory}/${file}`))).exists;
    },
    inUse: async (file) => {
        if (copyMoving || currentDbName === file || (db && dbFileOf.get(db) === file)) return true;
        return getDatabaseFilenameForNode(await AsyncStorage.getItem('beanpool_anchor_url')) === file;
    },
    open: (file) => SQLite.openDatabaseAsync(file, { useNewConnection: true }),
    register: (handle, file) => { dbFileOf.set(handle, file); },
    get schema() { return COPY_SCHEMA; },
    // A getter, as `schema`: the statements are constants declared further down this file.
    get statements() { return HELD_STATEMENTS; },
    // A statement on a copy open in place once its close began (slice S2): the chat's own sentence, translated where shown.
    get closedText() { return SWITCHED_SINCE_CHAT_OPENED_TEXT; },
    // A chat left (leaveChatInPlace): its copy opens in place again only once a screen holds it again (enterChatInPlace).
    placeRefused: (file) => chatsInPlaceLeft.has(file),
});

/** The files a held handle is open, opening or closing on now: for tests. */
export function heldCopyFiles(): string[] {
    return heldCopies.openFiles();
}

/** For tests: the community file a handle is registered under (dbFileOf), as the DM pins and the DM guard read it. */
export function _fileOfHandleForTests(handle: object): string | undefined {
    return dbFileOf.get(handle);
}

/**
 * Close every read-only held handle once its reads have settled: Chat closes them as it is left (about 1 MB and 2 files
 * each). A copy open in place stays (slice S2): Chat is left for the very chat that reads it; it closes as that chat is left
 * (leaveChatInPlace), and with everything else at every close, switch, move and delete.
 */
export function closeHeldCopies(): Promise<void> {
    return heldCopies.closeReads();
}

/**
 * Resolves once this phone's community copies have the names that give every community its own file
 * (cache-file-migration.ts). Nothing opens a copy or reads its sync cursors before then.
 */
export { communityCachesRenamed };

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
    await communityCachesRenamed();
    // Nor while a copy moves to another name (whileCopyMoves): it opens once the copy and the address are where they go.
    // Asked again after the address is read, the last wait before an open is on its way (getDbPromise), which a move
    // lets finish before it starts.
    let url: string | null;
    do {
        while (copyMoving) await copyMoving;
        url = await AsyncStorage.getItem('beanpool_anchor_url');
    } while (copyMoving);
    const expectedDbName = getDatabaseFilenameForNode(url);

    // The copy open now, when it is this community's: made, since `db` is set only once it is. Matched by its own file,
    // never by the name an open on its way is for (currentDbName): the community left is never handed out under the new name.
    if (db && dbFileOf.get(db) === expectedDbName) {
        return db;
    }

    // Its open on its way, which hands it out once its copy is made.
    if (getDbPromise && currentDbName === expectedDbName) {
        return getDbPromise;
    }

    return openCopy(expectedDbName, url, null);
}

/** A clear's open (clearDB): the cache tables go whatever the copy's number, and `alsoDrop` with them (the account's own, as it leaves). */
interface CopyClear { alsoDrop: string }

/**
 * Open `file`'s copy and make it (_doInitDB) on a connection of its own, before anything else has it: published as the
 * copy open (`db`) and handed to the asks waiting on it (getDbPromise) only once it is made. So no reader, writer, sync
 * cycle or socket holds a statement on it while its tables are dropped: SQLite refuses a DROP TABLE while a statement of
 * the same connection is still open ("database table is locked", SQLITE_LOCKED), which a reader that had the copy while
 * a 1.3 copy was cleared hit on 1.4.0 (11 Nov). A copy not made is closed and not handed out: the next ask opens it again.
 * `clear` (clearDB): the cache tables go whatever the copy's number.
 *
 * Another community's copy open now (getDb's own swap: an address written with no closeDB) is left at once: handed to no
 * one from here, and closed under the sync lock on its own (leaveCopy), so a write in flight on it finishes first. The open
 * takes no lock and waits for no close: a writer holding the lock as it asks (applyDelta, the deal and review writers, the
 * ratings reads) waits on this open, and an open that waited for that lock would wait for good (review of #3053, db.ts:161).
 */
function openCopy(file: string, url: string | null, clear: CopyClear | null): Promise<SQLite.SQLiteDatabase> {
    if (db) {
        leaveCopy(db);
        db = null;
    }
    currentDbName = file;
    const seq = ++openSeq;
    // Cleared once it settles, unless another open has taken its place since, and before the asks waiting on it go on.
    const opening = openAndMakeCopy(file, url, clear, seq).finally(() => {
        if (getDbPromise === opening) getDbPromise = null;
    });
    getDbPromise = opening;
    return opening;
}

/** Each open's number (openCopy): only the latest is handed out. */
let openSeq = 0;

/** The copies a swap has left (openCopy) that are not closed yet: each waits for the sync lock (leaveCopy, closeOpenCopy). */
const copiesLeft = new Set<SQLite.SQLiteDatabase>();

/**
 * Close `copy`, left by a swap, once the sync lock is free: a writer that had it as it took the lock finishes on it first.
 * On its own: nothing waits for it, so no asker that holds the lock waits on its own lock. closeOpenCopy closes it sooner
 * when a closeDB, a clear or a move has the lock first.
 */
function leaveCopy(copy: SQLite.SQLiteDatabase): void {
    copiesLeft.add(copy);
    void (async () => {
        await acquireSyncLock({ urgent: true });
        try {
            await closeLeftCopy(copy);
        } finally {
            releaseSyncLock();
        }
    })();
}

/** Close `copy`, left by a swap, unless it is closed already. The caller holds the sync lock (leaveCopy, closeOpenCopy). */
async function closeLeftCopy(copy: SQLite.SQLiteDatabase): Promise<void> {
    if (!copiesLeft.delete(copy)) return;
    try {
        await copy.closeAsync();
    } catch (e) {
        console.warn('[DB] Reconnect close warning:', e);
    }
}

async function openAndMakeCopy(file: string, url: string | null, clear: CopyClear | null, seq: number): Promise<SQLite.SQLiteDatabase> {
    // Auto-track nodes we jump into correctly inside the UI Matrix. Never one that isn't plain host[:port]
    // (node-url.ts): addSavedNode refuses it, and that must not stop the database opening.
    if (url && isPlainNodeAddress(url)) await addSavedNode(url);

    // A held handle on this file (another community's copy until now) closes first, once its reads have settled: the copy
    // in use never shares its file with one, and none opens on it from here (heldCopies `inUse`: currentDbName). It takes
    // no lock, so this open still waits for none.
    await heldCopies.close(file);
    const handle = await SQLite.openDatabaseAsync(file, { useNewConnection: true });
    dbFileOf.set(handle, file);
    try {
        // Hardcode native concurrent locking parameters per-connection
        await handle.execAsync(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 30000;
        `);
        await _doInitDB(handle, clear);
    } catch (e) {
        await handle.closeAsync().catch(() => {});
        throw e;
    }
    if (seq !== openSeq) {
        // Another copy was asked for while this one was made (the address changed): never a second connection left open
        // beside the one in use. Its asks get the copy asked for now.
        await handle.closeAsync().catch(() => {});
        return getDb();
    }
    db = handle;
    return handle;
}

/**
 * `heldClosedUntil`: the caller deletes copies once this returns (community-cache.ts removeCommunityCaches): no held handle
 * (heldCopies) opens on any community's copy until it settles, so none reads a copy on its way off the phone.
 */
export async function closeDB(opts: { heldClosedUntil?: Promise<unknown> } = {}) {
    await acquireSyncLock({ urgent: true });
    try {
        if (opts.heldClosedUntil) {
            await heldCopies.pauseUntil(opts.heldClosedUntil);
            // And what this run holds in memory of their groups' keys, or a community joined again would go by keys its new
            // copy doesn't hold (review of #3358, F1).
            forgetGroupKeys();
        }
        // An open on its way finishes first, and its copy is closed with the rest (the copies a swap left too): none is left
        // open after this.
        await untilNoOpenOnItsWay();
        await closeOpenCopy();
    } finally {
        releaseSyncLock();
    }
}

/**
 * Called holding the sync lock, and back holding it: an open on its way (getDbPromise) finishes first (closeDB,
 * whileCopyMoves, clearDB). An open takes no lock; the lock is let go meanwhile all the same, so the writers queued for it
 * are not held up while a copy is made.
 */
async function untilNoOpenOnItsWay(): Promise<void> {
    while (getDbPromise) {
        const opening = getDbPromise;
        releaseSyncLock();
        await opening.catch(() => {});
        await acquireSyncLock({ urgent: true });
    }
}

/**
 * Close the copy open, if one is, and every copy a swap left that is still open (its own close waits for the lock this
 * caller holds). The caller holds the sync lock (closeDB, whileCopyMoves, clearDB). Every held handle on another
 * community's copy closes first, once its reads in flight have settled (utils/held-copies.ts): a close, a clear or a
 * move never leaves one open on a file about to change.
 */
async function closeOpenCopy() {
    await heldCopies.closeAll();
    if (db) {
        const oldDb = db;
        db = null;
        currentDbName = null;
        try {
            await oldDb.closeAsync();
        } catch (e) {
            console.warn('[DB] closeDB warning:', e);
        }
    }
    for (const copy of [...copiesLeft]) await closeLeftCopy(copy);
}

/**
 * Run `move` with no community copy open and none opened until it is done (getDb waits): a community's copy carried to
 * its new address `to` (utils/community-copy-carry.ts, through reconnect.ts switchPhoneTo, which writes the address inside
 * `move`). First the copy open is closed, every sync cycle in flight stores nothing more (a new copy generation), and every
 * DM pin and guard-list write already on its way lands, so nothing is written under the old name once `move` has read it.
 * Then what this run holds in memory of `to`'s file (its DM pins, the lines the update held there, the group keys opened)
 * is dropped, so the carried copy's own is read at the next ask. `move` must not open a copy through getDb, nor take the
 * sync lock.
 *
 * One lock order, the writers' own (applyDelta and every other writer take the sync lock, then getDb): the move takes the
 * lock first and publishes copyMoving only while holding it, and clears it before letting go. A writer that took the lock
 * first finishes, its getDb with it, before the move starts; one waiting for the lock gets it after the move, with
 * copyMoving clear. (Published before the lock was taken, each waited for the other for good: confirmation 2 of #2138.)
 * Moves wait for each other on the lock. An open already on its way finishes first (untilNoOpenOnItsWay), and a copy a
 * swap left is closed with the copy open (closeOpenCopy).
 *
 * With `from`, the address followed: which of its groups' chats this run saw locked goes with its copy, still under the lock
 * (max review of #3358, T3); then the marks its file had refused, or never got, are put in `to`'s, so a restart knows them too.
 * One that won't go in is owed still: the next answer or send puts it.
 */
export async function whileCopyMoves<T>(where: string | { from: string; to: string }, move: () => Promise<T>): Promise<T> {
    const { from, to } = typeof where === 'string' ? { from: null, to: where } : where;
    const toFile = getDatabaseFilenameForNode(to);
    const fromFile = from ? getDatabaseFilenameForNode(from) : null;
    let done: T;
    // Never while the copies still move to their own names (cache-file-migration.ts): that opens and renames them too.
    await communityCachesRenamed();
    await acquireSyncLock({ urgent: true });
    await untilNoOpenOnItsWay();
    let moved!: () => void;
    copyMoving = new Promise<void>((resolve) => { moved = resolve; });
    try {
        // No held handle on any copy while it moves, and none opened until it has (utils/held-copies.ts).
        done = await heldCopies.paused(async () => {
            await closeOpenCopy();
            newCopyGeneration();
            await Promise.all([dmPins.idle(), dmSeen.idle()]);
            const result = await move();
            if (fromFile) followLockedRings(fromFile, toFile, { nodeUrl: to, store: groupKeyStore(to) });
            return result;
        });
    } finally {
        dmPins.forgetFile(toFile);
        for (const key of [...dmLinesHeldAtUpdate.keys()]) if (key.endsWith(`\n${toFile}`)) dmLinesHeldAtUpdate.delete(key);
        forgetGroupKeys();
        copyMoving = null;
        moved();
        releaseSyncLock();
    }
    if (fromFile) await keepLockMarks(to);
    return done;
}

/** Put in its file the mark of each group's chat this run knows locked in `nodeUrl`'s community (whileCopyMoves). */
async function keepLockMarks(nodeUrl: string): Promise<void> {
    const identity = await loadIdentity().catch(() => null);
    if (!identity) return;
    const store = groupKeyStore(nodeUrl);
    await Promise.all(groupsLockedIn(getDatabaseFilenameForNode(nodeUrl), identity.publicKey)
        .map((groupId) => groupKeyring(nodeUrl, identity, groupId, store).locksSends().catch(() => {})));
}

/** The copy, made: getDb hands out none before its copy is made (openCopy). */
async function waitForInit(): Promise<SQLite.SQLiteDatabase> {
    return getDb();
}

/**
 * The community's copy open and made (getDb, openCopy): the schema below, and a copy below this build's number cleared
 * first. Rejects when it couldn't be made; the next ask tries again.
 */
export async function initDB() {
    await getDb();
}

/**
 * Any write to the cached listings forgets the stored tag of the last read by area (nearby_held k = 'tag'), in its own
 * transaction: the tag says "this phone holds the set as the node has it", and a write from anywhere else (a push, the
 * deal heal, the event page, the member's own edit or deal) makes what it holds something the tag doesn't describe. A
 * delta answered 304 over it would keep that until the set next changed (review of #1805, finding 2). The read by area
 * writes its rows first and stores its tag after (services/pillar-sync.ts), so its own rows never forget it.
 */
const NEARBY_TAG_FORGOTTEN_ON_POSTS_WRITE = `
        CREATE TRIGGER IF NOT EXISTS posts_ai_nearby_tag AFTER INSERT ON posts BEGIN DELETE FROM nearby_held WHERE k = 'tag'; END;
        CREATE TRIGGER IF NOT EXISTS posts_au_nearby_tag AFTER UPDATE ON posts BEGIN DELETE FROM nearby_held WHERE k = 'tag'; END;
        CREATE TRIGGER IF NOT EXISTS posts_ad_nearby_tag AFTER DELETE ON posts BEGIN DELETE FROM nearby_held WHERE k = 'tag'; END;`;

/**
 * THE COPY'S SCHEMA NUMBER (`PRAGMA user_version`). A community's copy below this build's number is a cache made for older
 * columns: its cache tables go (CACHE_TABLES, the ones a Force Resync's clearDB drops) and the sync reads it whole again.
 * Nothing in it is read or rewritten on the way: the node holds every row, and the phone reads them again. Identity, the
 * group keys with their verdicts and signers, and the tools' documents are not a copy of the node's and stay.
 *
 * The standing rule (the clean-slate cutover, DESIGN-clean-slate-cutover-fable.md §2 C1-C8): the schema in _doInitDB is
 * the whole shape of a copy at this number, and nothing adds to a copy on open. A change to a cache table's columns or
 * indexes raises the number, and every older copy is cleared and read again; never an ALTER TABLE on open, never a
 * one-off pass keyed on a flag. A change to one of the five tables that are not a copy (GROUP_KEY_TABLES_SQL, TOOL_DOCS_TABLE)
 * cannot be read again from the node: it is its own step, kept one build (a conversion-code row in the log), never this one.
 * 4 (1.4.0): money is whole hundredths of a Bean (DESIGN-atomic-beans-fable.md M2). Every money column is an INTEGER `*_c`,
 * as the node's are, so a copy that held Beans as REAL (`posts.credits`, `accounts.balance`, ...) is dropped, never converted.
 * 5 (Learn, slice K2): a new cache table, `knowledge_posts` (Local knowledge, DESIGN-local-knowledge-fable.md §4.3). A copy at 4
 * was read without the pages, and its cursor is past any page written before this build, so only a read from the start
 * brings them. It is cleared and read again, as the rule above says for a change to the cache's shape: nothing is rewritten.
 * 6 (per-item prices, slice P2, DESIGN-per-item-price-fable.md §3): three columns on `posts`, `units_left`, `lot_price_c` and `lot_units`,
 * NULL on every listing not priced for each one. A copy at 5 has none of them, so it is cleared and read again with them.
 * 7 (per-item prices, slice P3): `marketplace_transactions.item_option` ('each' or 'lot', the node's), NULL on every other deal,
 * so Your deals and the item page say "3 × Solar Panels". A copy at 6 has no such column: it is cleared and read again with it.
 * 8 (the forum on the phone, slice F3, DESIGN-forums-fable.md §18, §20): a new cache table, `forum_kept` (utils/forum-kept.ts),
 * the forum's front, lists and topics as the node answered them. A copy at 7 is cleared and read again with it, as the rule says.
 */
export const COPY_SCHEMA = 8;

/** The tables that are a copy of the node's: clearDB drops them, and so does an open of a copy below COPY_SCHEMA. */
const CACHE_TABLES = [
    'messages', 'conversation_participants', 'conversations', 'posts', 'marketplace_transactions', 'transactions', 'accounts', 'members',
    'projects', 'friends', 'ratings', 'member_reviews_read', 'poll_votes', 'event_rsvps', 'nearby_tied', 'nearby_held', 'knowledge_posts',
    'forum_kept',
] as const;
const DROP_CACHE_TABLES_SQL = CACHE_TABLES.map((table) => `DROP TABLE IF EXISTS ${table};`).join(' ');

/**
 * Make the copy `database` opens: the schema below, a copy below this build's number cleared first, and `clear`'s tables
 * dropped first (clearDB). Only ever on the connection openCopy has just opened, which nothing else has yet: a statement of
 * another reader open on it would refuse the drops. Throws when the copy couldn't be made, and leaves it as it was.
 */
async function _doInitDB(database: SQLite.SQLiteDatabase, clear: CopyClear | null = null) {
    // A copy below this build's schema number (COPY_SCHEMA): its cache tables go before the schema below makes them again
    // with today's columns, and the copy is read whole (every cursor forgotten, as for a Force Resync). A fresh copy has
    // nothing to drop and takes the number.
    const versionResult = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const copyBelowSchema = !versionResult || versionResult.user_version < COPY_SCHEMA;
    if (copyBelowSchema) {
        console.log(`[SQLite] Copy schema ${versionResult?.user_version ?? 0} is below ${COPY_SCHEMA}: clearing the cached tables to read them again.`);
        // A sync cycle already under way read its cursor before this open: a new copy generation makes it store nothing,
        // so it cannot write rows of the old shape or put back a cursor forgotten here (resetSyncFingerprints, as clearDB).
        try {
            const { resetSyncFingerprints } = require('../services/pillar-sync');
            resetSyncFingerprints();
        } catch (e) {
            newCopyGeneration();
        }
        // The cursors go before the tables: stopped between the two, the copy is still below the number and is cleared at
        // the next open, never left cleared with the cursors of what it held (its next sync would read only what changed).
        try {
            const file = dbFileOf.get(database);
            const { syncCursorKeysOf } = await import('../services/pillar-sync');
            if (file) await AsyncStorage.multiRemove(syncCursorKeysOf(file));
        } catch (e) {
            console.warn('[SQLite] Could not forget the sync cursors of a copy below the schema number:', e);
        }
    }
    const drops = (copyBelowSchema || clear ? DROP_CACHE_TABLES_SQL : '') + (clear?.alsoDrop ?? '');

    // We execute the same exact schema.sql payload to guarantee 1:1 API compatibility locally
    const schema = `
        -- 1. Members and Profiles
        CREATE TABLE IF NOT EXISTS members (
            public_key TEXT PRIMARY KEY,
            callsign TEXT NOT NULL,
            joined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            invited_by TEXT,
            invite_code TEXT,
            home_node_url TEXT,
            
            avatar_url TEXT,
            bio TEXT,
            contact_value TEXT,
            contact_visibility TEXT,
            status TEXT DEFAULT 'active',
            last_active_at DATETIME,
            profile_updated_at DATETIME,
            -- Whole hundredths of a Bean, as every money column here (COPY_SCHEMA 4): the node's earnedCredit.
            earned_credit_c INTEGER DEFAULT 0,
            archetype TEXT,
            -- When this phone last fetched the card by key (utils/members-on-demand.ts): the oldest are re-checked first, and
            -- past 1,000 cards the oldest that nothing references are dropped. Null for a card from the whole directory.
            card_fetched_at TEXT
        );

        -- 2. Ledger Accounts & Transactions
        CREATE TABLE IF NOT EXISTS accounts (
            public_key TEXT PRIMARY KEY,
            balance_c INTEGER DEFAULT 0,
            last_updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            last_demurrage_epoch INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            from_pubkey TEXT NOT NULL,
            to_pubkey TEXT NOT NULL,
            amount_c INTEGER NOT NULL CHECK (amount_c > 0),
            fee_c INTEGER DEFAULT 0,
            memo TEXT,
            timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_pubkey);
        CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_pubkey);
        CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp DESC);

        -- 3. Marketplace Posts
        CREATE TABLE IF NOT EXISTS posts (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            category TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            -- No figure (NULL) when the node's price isn't whole hundredths: shown "—", never as Free (0).
            price_c INTEGER DEFAULT 0,
            author_pubkey TEXT NOT NULL,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            active INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active' CHECK (status IN ('active', 'pending', 'paused', 'completed', 'cancelled')),
            price_type TEXT DEFAULT 'fixed',
            repeatable INTEGER DEFAULT 0,
            cash_also_needed INTEGER DEFAULT 0,
            lendable INTEGER DEFAULT 0,
            accepted_by TEXT,
            accepted_by_callsign TEXT,
            accepted_at DATETIME,
            pending_transaction_id TEXT,
            completed_at DATETIME,
            lat REAL,
            lng REAL,
            origin_node TEXT,
            photos TEXT,
            reach TEXT DEFAULT 'local',
            reach_peers TEXT,
            author_energy_cycled INTEGER DEFAULT 0,
            author_founding_needed INTEGER DEFAULT 1,
            poll_options TEXT,
            poll_closes_at DATETIME,
            poll_open_vote INTEGER DEFAULT 0,
            poll_new_or_words_votes INTEGER,
            audience_scope TEXT DEFAULT 'public',
            target_group_id TEXT,
            target_pubkey TEXT,
            assigned_to TEXT,
            target_archetypes TEXT,
            event_start_at DATETIME,
            event_end_at DATETIME,
            event_place_name TEXT,
            event_state TEXT,
            event_going_count INTEGER DEFAULT 0,
            event_interested_count INTEGER DEFAULT 0,
            event_start_local TEXT,
            event_end_local TEXT,
            event_tz TEXT,
            event_online INTEGER,
            event_repeat TEXT,
            event_repeat_until TEXT,
            event_repeat_skips TEXT,
            carried_callsign TEXT,
            carried_avatar TEXT,
            carried_banner TEXT,
            tags TEXT NOT NULL DEFAULT '',
            free_tags TEXT NOT NULL DEFAULT '',
            shown_from TEXT,
            pinned_until TEXT,
            pinned_at TEXT,
            -- A price for each one (core per-item.ts): how many can be taken now, and the price for all of them with the number it is for.
            units_left INTEGER,
            lot_price_c INTEGER,
            lot_units INTEGER
        );

        -- Groups & Working Groups (docs/the-commons.md §9, Item 10)
        -- A group is an audience scope and NOTHING else. Roles: convenor | member | observer.
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            description TEXT,
            avatar_url TEXT,
            category TEXT DEFAULT 'general',
            created_by TEXT NOT NULL,
            join_policy TEXT DEFAULT 'open',
            is_official INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL,
            member_pubkey TEXT NOT NULL,
            role TEXT DEFAULT 'member',
            status TEXT DEFAULT 'active',
            joined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            invited_by TEXT,
            updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY (group_id, member_pubkey)
        );
        CREATE INDEX IF NOT EXISTS idx_group_members_pubkey ON group_members(member_pubkey);

        CREATE TABLE IF NOT EXISTS poll_votes (
            post_id TEXT NOT NULL,
            voter_pubkey TEXT NOT NULL,
            option_id TEXT NOT NULL,
            signature TEXT,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY (post_id, voter_pubkey)
        );
        CREATE INDEX IF NOT EXISTS idx_poll_votes_voter_pubkey ON poll_votes(voter_pubkey);

        -- Events (docs/events-on-the-map.md): THIS phone's own RSVPs, as poll_votes holds its own votes. The
        -- sync pull is unsigned, so the server never sends "my status" there; it comes from the RSVP response
        -- and the signed detail fetch. Counts live on the posts row.
        CREATE TABLE IF NOT EXISTS event_rsvps (
            post_id TEXT NOT NULL,
            member_pubkey TEXT NOT NULL,
            status TEXT NOT NULL,
            updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY (post_id, member_pubkey)
        );

        -- On a community that syncs by area (utils/posts-nearby.ts): the ids its last set read named "tied", the member's
        -- own and tied listings as the node knows them, which the phone keeps past its cap (keepPostsNearby).
        CREATE TABLE IF NOT EXISTS nearby_tied (id TEXT PRIMARY KEY);
        -- And the set it last reconciled with, beside the node's hash of it (k = 'set', JSON ids; k = 'hash') and the tied ids
        -- the node hashed with it (k = 'tied', JSON ids), written together: the phone sends the hash back and is not sent the
        -- set again while it holds, or is sent what changed, which it applies and checks against the node's hash (readNearbyHeld). k = 'tag':
        -- the ETag of its last read that landed whole, sent with the next delta for a 304 (readNearbyTag).
        CREATE TABLE IF NOT EXISTS nearby_held (k TEXT PRIMARY KEY, v TEXT NOT NULL);
${NEARBY_TAG_FORGOTTEN_ON_POSTS_WRITE}

        CREATE INDEX IF NOT EXISTS idx_active_posts ON posts(created_at DESC) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);

        -- 3b. Local knowledge, read in Learn (DESIGN-local-knowledge-fable.md section 4.3). Its own table, so no query over
        -- posts (the Market, the map, the calendar) can ever meet a page: the sync's one writer puts a row whose type is
        -- 'knowledge' here and never in posts. post is the page as the node sent it (JSON); the rest is what Learn lists by.
        CREATE TABLE IF NOT EXISTS knowledge_posts (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            post TEXT NOT NULL,
            checked_at TEXT,
            updated_at TEXT,
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_posts_topic ON knowledge_posts(topic) WHERE active = 1;

        -- 4. Marketplace Transactions
        CREATE TABLE IF NOT EXISTS marketplace_transactions (
            id TEXT PRIMARY KEY,
            post_id TEXT NOT NULL,
            buyer_pubkey TEXT NOT NULL,
            seller_pubkey TEXT NOT NULL,
            amount_c INTEGER,
            hours REAL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            completed_at DATETIME,
            cover_image TEXT,
            post_title TEXT,
            rated_by_buyer INTEGER DEFAULT 0,
            rated_by_seller INTEGER DEFAULT 0,
            -- A period of a standing deal (DESIGN-standing-deals-fable §2.1): which one and its number, and on its current
            -- period's row the standing deal as the node's transactions read says it (phase, Beans, unit, dates; standingOfRow).
            standing_id TEXT,
            period_no INTEGER,
            standing TEXT,
            -- A deal on an Offer priced for each one (DESIGN-per-item-price-fable.md §3): 'each' (hours holds how many) or 'lot'.
            item_option TEXT
        );
        -- The keep rule (keepPostsNearby) asks, for every held listing on every by-area write, whether a deal or a chat names
        -- it: by index, not a scan of each table per listing (the review of #1778, finding 4: 79 ms at 3,000 deals).
        CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_post_id ON marketplace_transactions(post_id);

        -- 5. Messaging & Chat
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            post_id TEXT,
            name TEXT,
            created_by TEXT,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            post_title TEXT,
            post_status TEXT,
            post_photo TEXT,
            post_price_c INTEGER,
            request TEXT,
            -- 1 while the node's list names the chat among the member's conversations, which no request waiting for them is.
            listed INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_post_id ON conversations(post_id);

        CREATE TABLE IF NOT EXISTS conversation_participants (
            conversation_id TEXT,
            public_key TEXT,
            last_read_at DATETIME,
            PRIMARY KEY (conversation_id, public_key)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            author_pubkey TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            nonce TEXT NOT NULL,
            type TEXT DEFAULT 'text',
            system_type TEXT,
            metadata TEXT,
            timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            -- Edit-message window: when the line was last edited (null = never edited).
            edited_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, timestamp ASC);

        -- Group chat keys (slice 3, utils/group-chat-store.ts GROUP_KEY_TABLES_SQL).
${GROUP_KEY_TABLES_SQL}
        -- 6. Relations (Friends, Ratings, Abuse)
        CREATE TABLE IF NOT EXISTS ratings (
            id TEXT PRIMARY KEY,
            target_pubkey TEXT NOT NULL,
            rater_pubkey TEXT NOT NULL,
            role TEXT NOT NULL,
            stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
            comment TEXT,
            transaction_id TEXT,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            UNIQUE(rater_pubkey, transaction_id)
        );
        -- Another member's reviews as the node last answered this phone (getMemberRatings), one row per member, for their
        -- Reviews tab and their stars on a market card offline: since #1914 a review names no rater and no deal to anyone but
        -- its two parties, so these never go into ratings. The most recently read REVIEWS_READ_KEPT members are kept.
        CREATE TABLE IF NOT EXISTS member_reviews_read (target_pubkey TEXT PRIMARY KEY, answer TEXT NOT NULL, read_at TEXT NOT NULL);

        -- 6b. Friends
        CREATE TABLE IF NOT EXISTS friends (
            owner_pubkey TEXT NOT NULL,
            friend_pubkey TEXT NOT NULL,
            added_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            is_guardian INTEGER DEFAULT 0,
            PRIMARY KEY (owner_pubkey, friend_pubkey)
        );
        
        -- 7. Projects
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            creator_pubkey TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            photos TEXT,
            goal_amount_c INTEGER NOT NULL,
            current_amount_c INTEGER DEFAULT 0,
            deadline_at DATETIME,
            status TEXT DEFAULT 'ACTIVE',
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        -- 8. Tools: each tool's one document per owner, kept on this phone (tools/schema.ts; not a cache, so a re-sync's
        -- clearDB keeps it and only an account leaving the phone drops it).
${TOOL_DOCS_TABLE}

        -- 9. Chats with people in other communities, kept on this phone only (utils/outside-chat-store.ts; not a cache, so a
        -- re-sync's clearDB keeps them and only an account leaving the phone drops them).
${OUTSIDE_CHAT_TABLES_SQL}

        -- 10. The forum's kept copies (utils/forum-kept.ts): a copy of the node's, so a cache table (CACHE_TABLES).
${FORUM_KEPT_TABLE_SQL}
    `;

    // One step: the drops, today's schema and the copy's number land together or not at all. A clear that stops part way
    // (the app closed, a write refused) leaves the copy as it was, below the number with every table it had, and the next
    // open clears it again: never a copy without its tables, nor one at the number that was never made.
    await database.execAsync('BEGIN IMMEDIATE');
    try {
        if (drops) await database.execAsync(drops);
        await database.execAsync(schema);
        if (copyBelowSchema) await database.execAsync(`PRAGMA user_version = ${COPY_SCHEMA}`);
        await database.execAsync('COMMIT');
    } catch (e) {
        await database.execAsync('ROLLBACK').catch(() => {});
        console.error('[SQLite] Database init error:', e);
        throw e;
    }
    console.log('[SQLite] Local database initialized physically 1:1 with Server node.');

    // A copy cleared for being below the schema number (above): read it whole now rather than at the next timer. A cycle
    // that began before it was handed out may have read the cursors forgotten above, so it stores nothing (a new generation).
    if (copyBelowSchema) {
        newCopyGeneration();
        try {
            const { requestSync } = require('../services/pillar-sync');
            requestSync().catch(() => {});
        } catch (e) {}
    }
}

/**
 * The copies' generation: one more each time the copies the sync writes to are cleared or taken off the phone (clearDB,
 * and services/pillar-sync.ts resetSyncFingerprints, which removeCommunityCaches calls). A sync cycle takes it as it
 * starts and hands it to each of its writes (applyDelta's `generation`); once it has moved, the cycle writes nothing more
 * and stores no cursor, hold, epoch or cycle time, since what it read belongs to the copy that was cleared, and the next
 * cycle reads the fresh copy whole. Without it, a Force Resync tapped while a whole read paged in cleared the pages
 * already written, the running cycle wrote the rest into the fresh copy and stored its cursor, and every later cycle was
 * a delta: the newest listings never came back (review of PR #1719 fix round 1, B-1: R7). In memory: a cycle never
 * outlives the app.
 */
let copyGeneration = 0;
export function copyGenerationNow(): number {
    return copyGeneration;
}
/**
 * The copy a read outside the sync is made for, taken when the read starts: the anchor's file and the copy generation.
 * Handed back to applyDelta (`expectedDbName`, `generation`), the answer lands only in that copy: a community switch, or
 * a copy cleared, while the read was out writes nothing (review of #1859, NB3: a card fetched on global landed in mullum's).
 */
export async function copyForRead(): Promise<{ dbName: string | undefined; generation: number }> {
    const generation = copyGeneration;
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    return { dbName: anchorUrl ? getDatabaseFilenameForNode(anchorUrl) : undefined, generation };
}
/** A new copy generation: every sync cycle in flight writes and stores nothing more (copyGeneration). */
export function newCopyGeneration(): void {
    copyGeneration++;
}

/**
 * A read of the member's own list (their chats and requests, the groups they are in), taken as it is asked: the account it
 * is asked for (`asking`, its key; null with none) and the phone's copies as they are (copyGeneration) (#3309 review N2,
 * P3, P5). Every such read whose answer is written, kept or handed back after its network await goes through this one guard
 * (syncMessages, requestsInPlace, fetchGroups; utils/__tests__/requests-in-place-wrong-file.test.ts, its table of them):
 * `still()`, after the answer and before anything of it is written, kept or handed back: the account, read again, while it
 * is still the one that asked and no copy has been cleared or removed since (Sign Out, the next account, a wipe, a
 * community taken off the phone and set to again). Else null, and the answer goes nowhere: written into no copy, kept
 * under no key, shown on no card. Without it, an answer that landed after Sign Out was written into the file the next
 * account then held, and kept under its key (the next account read the old account's message request as its own: P5).
 * A write that follows still() goes through its copy's handle, which a clear or a switch closes, so nothing is written
 * after it changes either. Taken with no await, so nothing comes between it and the ask; after the copy the read writes
 * into is open, since opening a copy below this build's schema starts a generation of its own.
 * And no account may have been on its way off the phone as it was asked, nor begun to leave since (account-leaving.ts;
 * `stays()`, asked again with no await under the sync lock before a page of it is written): a read begun after Sign Out's
 * clear, while the key was still here, wrote its chats' lock marks into the copy just cleared (max review of #3358, U1).
 * Not in the class: refreshHeldDms (slice S2b) reads that list too, but writes, keeps and shows nothing of it; it only names
 * the chats whose own polls then run, each after the account is read again (its loop), each poll its own read.
 */
export interface OwnListRead {
    still(): Promise<{ identity: BeanPoolIdentity | null } | null>;
    stays(): boolean;
}
export function ownListRead(asking: string | null | undefined): OwnListRead {
    const generation = copyGeneration;
    const stays = accountStays();
    const copiesAsAsked = () => copyGeneration === generation && stays();
    return {
        still: async () => {
            if (!copiesAsAsked()) return null;
            const identity = await loadIdentity();
            if ((identity?.publicKey || null) !== (asking || null) || !copiesAsAsked()) return null;
            return { identity };
        },
        stays,
    };
}

/** Said when a chat action started as the phone was switching community: nothing was sent (chat-line-words.ts translates it). */
const SWITCHED_SINCE_CHAT_OPENED_TEXT = 'This phone has switched community since this chat was opened.';

/** Said when a deal's step began for another account than the one on the phone now (chat-line-words.ts translates it). */
const OTHER_ACCOUNT_SINCE_CHAT_OPENED_TEXT = 'The account on this phone has changed since this chat was opened. Nothing was sent.';

/**
 * The community a chat request is for (chatCopyForRequest): its address and its copy, taken at one moment.
 * - `anchorUrl`: where the request goes, passed to signedGet / _signedRequest or built into the fetch's URL. Null with no
 *   community set: the caller says it is off-grid, as it always did.
 * - `file` and `database`: that community's copy, open as the request starts.
 * - `handle()`: the only way a write that follows a network await reaches the copy. The copy open then when it is still
 *   `file`'s; null once the phone is on another community's, its address included (written with nothing swapped yet),
 *   and the answer is then dropped (nothing written, nothing thrown at the member: that community's next sync reads it
 *   again).
 * - `openNow()`: `database` while it is still the copy open (no switch, swap, move or close since), else null, read with
 *   no await. Only for the send's delivery (_deliverPendingMessage): its row is already in this copy, written before the
 *   POST, and the node's 200 only names its id and time; adopted in the tick the 200 arrives, as before the switch guard,
 *   no read of the chat comes between them and finds the line still sending under this phone's clock. Never another
 *   community's copy; while the address alone has moved, it is still the copy the line was written into.
 */
export interface ChatRequestCopy {
    anchorUrl: string | null;
    file: string;
    database: SQLite.SQLiteDatabase;
    openNow(): SQLite.SQLiteDatabase | null;
    handle(): Promise<SQLite.SQLiteDatabase | null>;
    /** Another community's copy, open in place (slice S2): `anchorUrl` is that community's, `file` its file. */
    inPlace?: true;
}

/**
 * The community a chat lives in when it is not the one in use (slice S2, scratch/fable-design/DESIGN-no-switch-messaging-fable.md
 * §3, §6): its address as the phone saved it. Left out (or null): the community in use, as before. Every chat function
 * that takes one reaches that community's copy and server only through chatCopyForRequest(community)
 * (utils/__tests__/chat-in-place-source.test.ts).
 */
export type ChatCommunity = string | null | undefined;

/**
 * The file this request is for: the community's address and its copy, read together before a chat request goes out, so
 * the answer is written only into the file it was asked for. Every chat write that follows a network await takes its handle
 * from here (utils/__tests__/chat-write-after-await-source.test.ts). Before this, syncMessages took getDb() after the
 * answer came back, and a switch while it was on its way wrote community A's conversation into B's file (the S1 probe,
 * measured on the API 26 emulator: scratch/walks/RESULT-s1-second-handle-probe.md (4), run 6). Throws
 * SWITCHED_SINCE_CHAT_OPENED_TEXT when the phone keeps switching while the copy opens (three tries).
 */
export async function chatCopyForRequest(community?: ChatCommunity): Promise<ChatRequestCopy> {
    for (let tries = 0; tries < 3; tries++) {
        // One read of the address decides both where the request goes and whose copy it takes (#3319 review F2): a switch
        // landing between two reads sent a request for the community in use to the one switched to.
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        const file = getDatabaseFilenameForNode(anchorUrl);
        // A chat of another community this phone holds: read and written in its own copy, open in place, and sent to its own
        // server (slice S2). The community in use, however spelled, goes on as before.
        if (community && file !== getDatabaseFilenameForNode(community)) return copyInPlaceFor(community);
        const database = await getDb();
        if (dbFileOf.get(database) === file) {
            // A copy keeps its file for its life (dbFileOf), and every switch, swap, move or close takes it out of `db`
            // the moment it starts (openCopy, closeOpenCopy): while it is `db`, it is still `file`'s copy open.
            return { anchorUrl, file, database, openNow: () => (db === database ? database : null), handle: () => copyStillFor(file) };
        }
    }
    throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
}

/**
 * `community`'s copy open in place, as a chat request's copy (slice S2): the request goes to that community's own address
 * (signed for its name, so one sent to the wrong place is refused there), and its answer is written into that community's
 * file only. How a write reaches it, and why it can't reach another:
 * - the copy is one writable connection on `community`'s file (utils/held-copies.ts inPlace), and a connection is one
 *   file's for its life: nothing written through it can land in another file;
 * - it is opened only for a community this phone saved and is not a guest of, whose copy is on the phone, at this build's
 *   schema number, and that is not the community in use (nor one being opened, moved or cleared); a switch onto that very
 *   community closes it first (openAndMakeCopy), as every close, clear, move and delete does (closeOpenCopy, heldCopies);
 * - every statement on it is counted, so a close waits for the one under way and refuses every one after it
 *   (SWITCHED_SINCE_CHAT_OPENED_TEXT): an action cut by a switch writes nothing more anywhere;
 * - `handle()`, for a write after a network await: the copy open in place while it is still open; once it closed, the copy
 *   in use only if the phone is now on that same file (copyStillFor), else null and the answer is dropped (that
 *   community's next read brings it).
 * - a chat left (leaveChatInPlace) and not entered again: refused, before anything is opened or asked (#3305 review),
 *   here and again after every await on the way to the open (heldCopies' `placeRefused`).
 * Throws SWITCHED_SINCE_CHAT_OPENED_TEXT when there is no such copy to open.
 */
async function copyInPlaceFor(community: string): Promise<ChatRequestCopy> {
    const file = getDatabaseFilenameForNode(community);
    if (chatsInPlaceLeft.has(file)) throw new NoCopyInPlaceError();
    // The community as this phone saved it and every guest mark, each by its file (#3305 review F2): a link's own spelling
    // (capitals, a trailing path) is never a way past either, and its requests go to the saved row's own address.
    const saved = (await getSavedNodes().catch(() => [])).find((n) => getDatabaseFilenameForNode(n.url) === file);
    if (!saved || await isGuestCopy(saved.url).catch(() => true)) throw new NoCopyInPlaceError();
    const place = await heldCopies.inPlace(file);
    if (!place) throw new NoCopyInPlaceError();
    const database = place.handle;
    return {
        anchorUrl: saved.url, file, database, inPlace: true,
        openNow: () => (place.open() ? database : null),
        handle: async () => (place.open() ? database : await copyStillFor(file)),
    };
}

/** True for the refusal of a chat in place whose community's copy can't be opened here (copyInPlaceFor): no request went. */
export function isNoCopyInPlace(e: unknown): boolean {
    return e instanceof NoCopyInPlaceError;
}

/** No copy of that community to open in place (copyInPlaceFor): nothing was asked or written. Its words: the switch sentence. */
class NoCopyInPlaceError extends Error {
    constructor() {
        super(SWITCHED_SINCE_CHAT_OPENED_TEXT);
        this.name = 'NoCopyInPlaceError';
    }
}

/**
 * The copy a chat read of `community` goes through (slice S2): its copy open in place for another community this phone
 * holds, else the copy in use. Reads only: a write after a network await takes its copy from chatCopyForRequest.
 */
async function chatDbFor(community: ChatCommunity): Promise<SQLite.SQLiteDatabase> {
    return (await chatReadFor(community)).database;
}

/**
 * A chat read's copy and where its server is (slice S2): `community`'s copy open in place and its address, else the copy in
 * use and no address of its own (its requests go to the community in use, as before).
 */
async function chatReadFor(community: ChatCommunity): Promise<{ database: SQLite.SQLiteDatabase; anchorUrl?: string; inPlace: boolean }> {
    if (!community) return { database: await waitForInit(), inPlace: false };
    const here = await chatCopyForRequest(community);
    return { database: here.database, anchorUrl: here.anchorUrl ?? undefined, inPlace: !!here.inPlace };
}

/**
 * A screen holds the chat of `community` in place (slice S2): the chat as its focus effect starts, its key code screen as
 * it shows, Contacts as it starts a chat there. Ends a leave's refusal (#3305 review): from here that community's copy
 * opens in place again, once a close of it still under way is done. One leaveChatInPlace for each, as that screen lets go.
 * No await: held before the screen's first read is asked. No community (the one in use): nothing.
 */
export function enterChatInPlace(community: ChatCommunity): void {
    if (!community) return;
    const file = getDatabaseFilenameForNode(community);
    chatsInPlaceHeld.set(file, (chatsInPlaceHeld.get(file) ?? 0) + 1);
    chatsInPlaceLeft.delete(file);
}

/**
 * A screen lets go of the chat of `community` in place (slice S2): the last to let go (the chat left, with no key code
 * screen over it) closes its copy open in place once the statement under way has settled (and its read-only one with it,
 * which Chat opens again), and from then no copy of it opens in place until a screen holds it again (enterChatInPlace):
 * a poll, a read or a mark read still on its way as the chat was left is refused, nothing opened, nothing asked of that
 * community's server (#3305 review). Marked and closing in the same turn as the call, with no await before. A send still
 * on its way keeps its line in that copy as sending, which that community's next read settles. No community: nothing.
 */
export async function leaveChatInPlace(community: ChatCommunity): Promise<void> {
    if (!community) return;
    const file = getDatabaseFilenameForNode(community);
    const holding = (chatsInPlaceHeld.get(file) ?? 0) - 1;
    if (holding > 0) {
        chatsInPlaceHeld.set(file, holding);
        return;
    }
    chatsInPlaceHeld.delete(file);
    chatsInPlaceLeft.add(file);
    await heldCopies.close(file);
}

/**
 * `fn` with the chat of `community` held in place until it settles (slice S6): a group's line, edit or report begun on screen
 * seals and writes its keys through that copy on its way, so one begun as the chat is left still finishes in its own
 * community, or says it didn't. Only for a member's own tap, never a poll. No community (the one in use): just `fn`.
 */
export async function whileChatInPlace<T>(community: ChatCommunity, fn: () => Promise<T>): Promise<T> {
    enterChatInPlace(community);
    try {
        return await fn();
    } finally {
        await leaveChatInPlace(community);
    }
}

/** For tests: a new phone (no chat held or left in place, no group or event listed by a community), as an app start has. */
export function _resetChatsInPlaceForTests(): void {
    chatsInPlaceHeld.clear();
    chatsInPlaceLeft.clear();
    groupsListedThere.clear();
    eventsListedThere.clear();
}

/**
 * What one community's own copy keeps about a conversation id that says whether it is a direct chat there (#3305 review
 * F1): its row's type (an untyped row reads as a DM, as everywhere here), and whether that copy's group key memory holds
 * keys of a group under the id (asked lower-cased, as groupKeyring keeps them). One plain SELECT (held-copies.ts
 * isOneRead), so a held, read-only handle runs it as well as the copy open in place.
 */
const DM_FACTS_SQL = `SELECT (SELECT IFNULL(type, 'dm') FROM conversations WHERE id = ?) AS type,
           (SELECT highest FROM group_chat_key_state WHERE group_id = ?) AS highest,
           EXISTS(SELECT 1 FROM group_chat_epochs WHERE group_id = ? AND wrap IS NOT NULL) AS wrapped`;
const dmFactsParams = (me: string, id: string): string[] => [id, `${me}/${id.toLowerCase()}`, `${me}/${id.toLowerCase()}`];

/**
 * Whether a community's copy holds `conversationId` as a direct chat, from what it keeps (#3305 review F1): never a group
 * whose keys that copy holds; else its row is a DM's, or that file's DM pins or DM guard list, as stored, keep the id. The
 * id's own spelling only. Nothing known, or nothing readable: not a DM, so nothing of it is read, written or asked there
 * in place (a link can name any id: an enterprise's discussion, whose id is its public key, or a group's or an event's).
 */
async function holdsAsDm(conversationId: string, facts: any, memory: () => Promise<{ pins: DmPeerPins | null; seen: string[] | null }>): Promise<boolean> {
    if (!facts || Number(facts.highest ?? 0) > 0 || Number(facts.wrapped ?? 0) > 0) return false;
    if (facts.type === 'dm') return true;
    // Read only when the row doesn't settle it (the poll asks every few seconds, and the list can be large).
    const { pins, seen } = await memory();
    // The pins keep an id folded (dmPinId): they vouch only for the id as they keep it, never for another spelling of it.
    if (pins && dmPinId(conversationId) === conversationId && dmSightFor(pins, conversationId)) return true;
    return !!seen?.includes(conversationId);
}

/** That file's DM pins and DM guard list as stored, read only (never seeded, never written): null for one not readable. */
async function dmMemoryOf(me: string, file: string): Promise<{ pins: DmPeerPins | null; seen: string[] | null }> {
    const [pins, seen] = await Promise.all([dmPins.peek(me, file), readDmSeen(AsyncStorage, me, file).catch(() => null)]);
    return { pins, seen };
}

/**
 * Whether the copy `database` reads (a copy open in place) holds `conversationId` as a direct chat ({@link holdsAsDm}):
 * the poll in place asks it before anything is asked of that community's server or written anywhere.
 */
async function heldAsDmThrough(database: SQLite.SQLiteDatabase, conversationId: string): Promise<boolean> {
    const me = (await loadIdentity())?.publicKey;
    const file = dbFileOf.get(database);
    if (!me || !file || !conversationId) return false;
    try {
        const facts = await database.getFirstAsync<any>(DM_FACTS_SQL, dmFactsParams(me, conversationId));
        return await holdsAsDm(conversationId, facts, () => dmMemoryOf(me, file));
    } catch {
        return false;
    }
}

/**
 * A chat request's copy, for an in-place write about `conversationId` (#3305 review F1): only a direct chat that
 * community's own copy already holds; anything else is refused (NoCopyInPlaceError) before anything is asked or written.
 * The community in use: as before, untouched.
 */
async function onlyDmInPlace(here: ChatRequestCopy, conversationId: string): Promise<ChatRequestCopy> {
    if (here.inPlace && !(await heldAsDmThrough(here.database, conversationId))) throw new NoCopyInPlaceError();
    return here;
}

/**
 * The copy whose pins a key-code tap in `community`'s chat reads or writes (the member's Mark as verified and Remove
 * verification read the pin there, Continue with the new key moves it): in place, only for the id of a direct chat that copy holds as it holds it
 * (#3305 review F1: the pins fold an id's case, and a link can carry any spelling), else null and nothing is written.
 */
async function pinsCopyFor(community: ChatCommunity, conversationId: string): Promise<SQLite.SQLiteDatabase | null> {
    const copy = await chatReadFor(community);
    if (copy.inPlace && !(await heldAsDmThrough(copy.database, conversationId))) return null;
    return copy.database;
}

/** Whether the copy `database` reads holds the line `messageId`, in a direct chat it holds ({@link heldAsDmThrough}). */
async function dmLineHeldThrough(database: SQLite.SQLiteDatabase, messageId: string): Promise<boolean> {
    const row = await database.getFirstAsync<{ conversation_id: string }>('SELECT conversation_id FROM messages WHERE id = ?', [messageId]).catch(() => null);
    return !!row?.conversation_id && await heldAsDmThrough(database, row.conversation_id);
}

/**
 * As {@link onlyDmInPlace}, for a write that names a line: in place, a line of a direct chat that copy holds, else refused.
 * `groupId` (slice S6): a line of that group's chat, which no copy keeps (the node serves it): the group must be one held
 * there, and the line none of a direct chat that copy holds.
 */
async function onlyLineInPlace(here: ChatRequestCopy, messageId: string, groupId?: string): Promise<ChatRequestCopy> {
    if (!here.inPlace) return here;
    const aDmLine = await dmLineHeldThrough(here.database, messageId);
    if (groupId ? aDmLine || !(await heldAsThreadThrough(here.database, groupId, ['group'])) : !aDmLine) throw new NoCopyInPlaceError();
    return here;
}

/**
 * A new DM that a community's server answered, started there in place: it fits that community's copy only when the copy
 * holds no group's keys under its id and has no row for it but a DM's (#3305 review F1). Unreadable: it doesn't fit.
 */
async function newDmFitsIn(database: SQLite.SQLiteDatabase, conversationId: string): Promise<boolean> {
    const me = (await loadIdentity())?.publicKey;
    if (!me || !conversationId) return false;
    const facts = await database.getFirstAsync<any>(DM_FACTS_SQL, dmFactsParams(me, conversationId)).catch(() => null);
    return !!facts && !(Number(facts.highest ?? 0) > 0) && !(Number(facts.wrapped ?? 0) > 0) && (facts.type == null || facts.type === 'dm');
}

/**
 * The groups each community's own list named for this account this run (GET /api/your-groups, {@link fetchHeldYourGroups}),
 * by account and file: a group joined on another device opens in place before that community's copy has a row for it.
 */
const groupsListedThere = new Map<string, Set<string>>();
/** The same for events: none its list also names as a group (an id of two kinds is neither's). */
const eventsListedThere = new Map<string, Set<string>>();
/** The chats of a community, direct ones aside, that open in place (slice S6): a group's, and an event's. */
type ThreadKind = 'group' | 'event';

/**
 * Whether a community's copy holds `conversationId` as a group's chat (slice S6), from what it keeps and what its own list
 * named for this account this run. The order is the route's own (chat-route.ts): a group whose keys that copy holds is its
 * group whatever its row says; else its row must be a group's (or, with no row, its own server's list names it), and that
 * file's DM pins and DM guard list, as stored, must not keep the id. The id as the node makes it (lower-case) only. Anything
 * not known is not a group, so nothing of it is read, written or asked there in place. What may be sealed or sent under the
 * id is asked again, strictly ({@link refuseGroupKeysForDm}).
 */
async function holdsAsGroup(conversationId: string, facts: any, listed: boolean, memory: () => Promise<{ pins: DmPeerPins | null; seen: string[] | null }>): Promise<boolean> {
    if (!facts || !conversationId || conversationId !== conversationId.toLowerCase()) return false;
    if (Number(facts.highest ?? 0) > 0 || Number(facts.wrapped ?? 0) > 0) return true;
    if (facts.type == null ? !listed : facts.type !== 'group_thread') return false;
    const { pins, seen } = await memory();
    return !(pins && dmSightFor(pins, conversationId)) && !seen?.some((id) => id.toLowerCase() === conversationId);
}

const listedAsGroup = (me: string, file: string, id: string): boolean => !!groupsListedThere.get(`${me}\n${file}`)?.has(id);

/**
 * As {@link holdsAsGroup}, for an event's chat (slice S6): its row there is an event's (or, with no row, its own server's list
 * names it as one), and neither that copy's group keys nor its DM memory knows the id. An event's chat is readable by its
 * server, by design: what may be said in it is asked again as each line leaves ({@link readableLineTo}).
 */
async function holdsAsEvent(conversationId: string, facts: any, listed: boolean, memory: () => Promise<{ pins: DmPeerPins | null; seen: string[] | null }>): Promise<boolean> {
    if (!facts || !conversationId || conversationId !== conversationId.toLowerCase()) return false;
    if (Number(facts.highest ?? 0) > 0 || Number(facts.wrapped ?? 0) > 0) return false;
    if (facts.type == null ? !listed : facts.type !== 'event_thread') return false;
    const { pins, seen } = await memory();
    return !(pins && dmSightFor(pins, conversationId)) && !seen?.some((id) => id.toLowerCase() === conversationId);
}

/** Whether a community's copy holds `conversationId` as a chat of one of `kinds`, from what it keeps and its list named. */
async function holdsAsThread(kinds: readonly ThreadKind[], me: string, file: string, conversationId: string, facts: any): Promise<boolean> {
    const memory = () => dmMemoryOf(me, file);
    if (kinds.includes('group') && await holdsAsGroup(conversationId, facts, listedAsGroup(me, file, conversationId), memory)) return true;
    return kinds.includes('event') && holdsAsEvent(conversationId, facts, !!eventsListedThere.get(`${me}\n${file}`)?.has(conversationId), memory);
}

/** Whether the copy `database` reads (a copy open in place) holds `conversationId` as a chat of one of `kinds` ({@link holdsAsThread}). */
async function heldAsThreadThrough(database: SQLite.SQLiteDatabase, conversationId: string, kinds: readonly ThreadKind[]): Promise<boolean> {
    const me = (await loadIdentity())?.publicKey;
    const file = dbFileOf.get(database);
    if (!me || !file || !conversationId) return false;
    try {
        return await holdsAsThread(kinds, me, file, conversationId, await database.getFirstAsync<any>(DM_FACTS_SQL, dmFactsParams(me, conversationId)));
    } catch {
        return false;
    }
}

/**
 * A chat request's copy, for an in-place read or write of a group's or an event's chat (slice S6): only one that community's
 * own copy or list holds as one of `kinds` ({@link holdsAsThread}); anything else is refused (NoCopyInPlaceError) before
 * anything is asked or written. The community in use: as before, untouched.
 */
async function onlyThreadInPlace(here: ChatRequestCopy, conversationId: string, kinds: readonly ThreadKind[]): Promise<ChatRequestCopy> {
    if (here.inPlace && !(await heldAsThreadThrough(here.database, conversationId, kinds))) throw new NoCopyInPlaceError();
    return here;
}

/** As {@link onlyDmInPlace} and {@link onlyThreadInPlace}, for what a direct chat, a group's and an event's take the same way (a mute). */
async function onlyChatInPlace(here: ChatRequestCopy, conversationId: string): Promise<ChatRequestCopy> {
    if (here.inPlace && !(await heldAsDmThrough(here.database, conversationId))) return onlyThreadInPlace(here, conversationId, ['group', 'event']);
    return here;
}

/**
 * Whether `community`'s copy or list holds `conversationId` as a group's chat ({@link holdsAsGroup}), asked by the chat's
 * route before the chat opens there in place, through a held, read-only handle, as {@link heldChatIsDm} is asked.
 */
export function heldChatIsGroup(myPubkey: string, community: string, conversationId: string): Promise<boolean> {
    return heldChatIsThread('group', myPubkey, community, conversationId);
}

/**
 * The same for an event's chat ({@link holdsAsEvent}). One that copy has seen locked never opens in the event's screen,
 * which posts readable words (chat-route.ts, rule 2b): the phone moves there, and the route there decides.
 */
export function heldChatIsEvent(myPubkey: string, community: string, conversationId: string): Promise<boolean> {
    return heldChatIsThread('event', myPubkey, community, conversationId);
}

async function heldChatIsThread(kind: ThreadKind, myPubkey: string, community: string, conversationId: string): Promise<boolean> {
    if (!myPubkey || !community || !conversationId) return false;
    const file = getDatabaseFilenameForNode(community);
    try {
        let rows = await heldCopies.all<any>(file, 'dmFacts', dmFactsParams(myPubkey, conversationId));
        if (!rows) {
            await heldCopies.readsSettled(file);
            rows = await heldCopies.all<any>(file, 'dmFacts', dmFactsParams(myPubkey, conversationId));
        }
        if (!rows?.length || (kind === 'event' && rows[0].highest != null)) return false;
        return await holdsAsThread([kind], myPubkey, file, conversationId, rows[0]);
    } catch {
        return false;
    }
}

/**
 * Whether `community`'s copy, another community this phone holds, holds `conversationId` as a direct chat ({@link
 * holdsAsDm}): asked by the chat's route before a chat opens there in place (#3305 review F1), through a held, read-only
 * handle (slice S1), so nothing is opened writable, seeded, remembered or asked. False for anything not known as one, the
 * community in use, a copy not on the phone, and anything that can't be read.
 */
export async function heldChatIsDm(myPubkey: string, community: string, conversationId: string): Promise<boolean> {
    if (!myPubkey || !community || !conversationId) return false;
    const file = getDatabaseFilenameForNode(community);
    try {
        let rows = await heldCopies.all<any>(file, 'dmFacts', dmFactsParams(myPubkey, conversationId));
        // A tap on Chat's held row leaves Chat, whose read-only handles close (held-chats.ts): a read answered null by that
        // close waits for it, then asks once more on a handle of its own.
        if (!rows) {
            await heldCopies.readsSettled(file);
            rows = await heldCopies.all<any>(file, 'dmFacts', dmFactsParams(myPubkey, conversationId));
        }
        if (!rows?.length) return false;
        return await holdsAsDm(conversationId, rows[0], () => dmMemoryOf(myPubkey, file));
    } catch {
        return false;
    }
}

/**
 * The copy open now when the phone is still on `file`'s community, else null: never another community's copy, and none is
 * opened for a community the phone has left. A chat write after a network await asks this (ChatRequestCopy.handle).
 */
export async function copyStillFor(file: string): Promise<SQLite.SQLiteDatabase | null> {
    if (getDatabaseFilenameForNode(await AsyncStorage.getItem('beanpool_anchor_url')) !== file) return null;
    const database = await getDb();
    return dbFileOf.get(database) === file ? database : null;
}

/**
 * Simple Drop util if the User needs to wipe memory.
 *
 * `identityLeaves`: the identity is going off this phone (Sign Out, the self-delete purge), so what this phone knows of
 * its groups' keys goes too (the four group key tables), as a new phone starts. Every other wipe (Force Resync, Wipe &
 * Join Fresh, Wipe & Restart) keeps the identity and keeps that memory, kept per identity: the sticky lock and the
 * highest verified epoch of each group, with the epochs and the cursor they go with. It is a security fact, not a copy
 * of the node's (director's decision on the confirmation of #1788, NB3). From this call nothing of them is written for the
 * identity leaving (account-leaving.ts; max review of #3358, N1).
 */
export async function clearDB(opts: { identityLeaves?: boolean } = {}) {
    await (opts.identityLeaves ? whileAccountLeaves(() => clearCopyInUse(opts)) : clearCopyInUse(opts));
}

async function clearCopyInUse(opts: { identityLeaves?: boolean }) {
    // First, before anything awaits: from here no sync cycle that began before stores a cursor for this copy.
    newCopyGeneration();
    // Every group key opened this session leaves memory with the copy; a kept store opens them again from its wraps.
    forgetGroupKeys();
    try {
        const { resetSyncFingerprints } = require('../services/pillar-sync');
        resetSyncFingerprints();
    } catch (e) {
        console.warn('[DB] Failed to reset sync fingerprints during clearDB', e);
    }
    // Never while the copies still move to their own names (cache-file-migration.ts), as getDb.
    await communityCachesRenamed();
    let cleared: Promise<SQLite.SQLiteDatabase> | undefined;
    // Under the sync lock: a write in flight (a sync's page, a member's action) commits before the tables go, never into
    // the middle of the drop; one waiting for the lock after it finds the copy cleared (applyDelta `generation`).
    await acquireSyncLock({ urgent: true });
    try {
        await untilNoOpenOnItsWay();
        // Again, under the lock: a sync that began while this waited took the generation above and read the old copy's
        // cursor and row count; it must store nothing either (#1719 confirmation 2, P1).
        newCopyGeneration();
        // The community's copy by its address, never opened first: one that can't be made is what this clear mends. Read
        // under the lock, so no copy moves to another name meanwhile (whileCopyMoves).
        const file = getDatabaseFilenameForNode(await AsyncStorage.getItem('beanpool_anchor_url'));
        // Closed, so no statement is open on it as its tables go ("database table is locked"); made again by openCopy.
        await closeOpenCopy();
        cleared = openCopy(file, null, {
            // The tools' documents are the account's own, not a copy of the node's: kept by a re-sync, gone as it leaves.
            alsoDrop: opts.identityLeaves ? ' DROP TABLE IF EXISTS group_chat_epochs; DROP TABLE IF EXISTS group_chat_key_state; DROP TABLE IF EXISTS group_line_verdicts; DROP TABLE IF EXISTS group_line_signers; DROP TABLE IF EXISTS tool_docs;' + OUTSIDE_CHAT_DROP_SQL : '',
        });
    } finally {
        releaseSyncLock();
    }
    await cleared;
    if (opts.identityLeaves) forgetLockedRings();
}

/**
 * PWA Fetch Equivalents executed cleanly across the Local Disk
 */
/**
 * `includeEvents`: events are opt-in here as they are on the server's list route. Only screens that know how
 * to draw an event ask for them; the map tab, the deals badge and Your deals read this cache too and would
 * otherwise show an event as a trade listing (the native map layer is its own, later slice).
 *
 * Audience: with no `audienceScope` or `targetGroupId` this reads public listings only, for the map (#823).
 * `includeGroupsOf` adds the listings of the groups that member is active in by the cached memberships, for the
 * Market's "All Groups & Public" feed (the node's feed for a signed member carries them too). It is bound to the
 * membership rather than to what the cache holds, because leaving a group takes away only the membership row: the
 * group's listings stay cached and must leave the feed with it. `allScopes` reads every listing the cache holds,
 * whatever its audience, for the deals counters, which must find a deal on a group listing too. Nothing in the cache
 * is beyond this member: it holds only what the node sent.
 */
export async function getPosts(filter?: { type?: string; category?: string; targetGroupId?: string; audienceScope?: string; includeEvents?: boolean; includeGroupsOf?: string; allScopes?: boolean }) {
    // The copy and its address taken together (chatCopyForRequest), in every listing read: a read cut across by a switch never puts
    // one community's photo, and its key, on the other's address.
    let { database, anchorUrl } = await chatCopyForRequest();
    // A held card is the author's face, even when it has none: a photo the author removed must not fall back to the
    // face the listing carried when the node last sent it (getMyPosts and getPost read it the same way).
    let query = `
        SELECT p.*, COALESCE(m.callsign, p.carried_callsign) as author_callsign, CASE WHEN m.public_key IS NOT NULL THEN m.avatar_url ELSE p.carried_avatar END as author_avatar, m.joined_at, g.name as target_group_name
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        LEFT JOIN groups g ON p.target_group_id = g.id
        WHERE p.status IN ('active', 'pending', 'completed')
    `;
    const params: any[] = [];
    
    if (filter?.type) {
        query += ' AND p.type = ?';
        params.push(filter.type);
    }
    if (!filter?.includeEvents && filter?.type !== 'event') {
        query += " AND p.type != 'event'";
    }
    if (filter?.category) {
        query += ' AND p.category = ?';
        params.push(filter.category);
    }
    if (filter?.targetGroupId) {
        query += ' AND p.target_group_id = ?';
        params.push(filter.targetGroupId);
    }
    if (filter?.audienceScope) {
        query += ' AND p.audience_scope = ?';
        params.push(filter.audienceScope);
    } else if (!filter?.targetGroupId && !filter?.allScopes) {
        if (filter?.includeGroupsOf) {
            query += ` AND (
                (p.audience_scope IS NULL OR p.audience_scope = 'public')
                OR (p.audience_scope = 'group' AND p.target_group_id IN (SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active'))
            )`;
            params.push(filter.includeGroupsOf);
        } else {
            query += " AND (p.audience_scope IS NULL OR p.audience_scope = 'public')";
        }
    }
    query += ' ORDER BY p.created_at DESC';
    
    let rows: any[] = [];
    try {
        if (params.length > 0) {
            rows = await database.getAllAsync(query, params);
        } else {
            rows = await database.getAllAsync(query);
        }
    } catch (err: any) {
        if (err?.message?.includes('closed') || String(err).includes('closed')) {
            console.warn('[DB] getPosts caught closed database connection, retrying with fresh connection...');
            ({ database, anchorUrl } = await chatCopyForRequest());
            if (params.length > 0) {
                rows = await database.getAllAsync(query, params);
            } else {
                rows = await database.getAllAsync(query);
            }
        } else {
            throw err;
        }
    }

    // Fetch local user votes for poll rows so userVotedOptionId is preserved across reloads
    const pollRows = rows.filter(r => r.type === 'poll');
    const localVotes = new Map<string, string>();
    if (pollRows.length > 0) {
        try {
            const identity = await loadIdentity();
            if (identity?.publicKey) {
                const voteRows = await database.getAllAsync(
                    `SELECT post_id, option_id FROM poll_votes WHERE voter_pubkey = ?`,
                    [identity.publicKey]
                ) as any[];
                for (const v of voteRows) {
                    localVotes.set(v.post_id, v.option_id);
                }
            }
        } catch { }
    }

    // This phone's own RSVPs, so the card shows my status across reloads (as poll votes above)
    const eventRows = rows.filter(r => r.type === 'event');
    const localRsvps = new Map<string, string>();
    if (eventRows.length > 0) {
        try {
            const identity = await loadIdentity();
            if (identity?.publicKey) {
                const rsvpRows = await database.getAllAsync(
                    `SELECT post_id, status FROM event_rsvps WHERE member_pubkey = ?`,
                    [identity.publicKey]
                ) as any[];
                for (const v of rsvpRows) localRsvps.set(v.post_id, v.status);
            }
        } catch { }
    }

    return rows.map(r => {
        r.authorFoundingNeeded = r.author_founding_needed === 1;
        r.author_energy_cycled = r.author_energy_cycled ?? 0;
        r.audienceScope = r.audience_scope || 'public';
        r.pinnedUntil = r.pinned_until || r.pinnedUntil || undefined;
        r.pinnedAt = r.pinned_at || r.pinnedAt || undefined;
        if (r.type === 'event') {
            r.goingCount = r.event_going_count ?? 0;
            r.interestedCount = r.event_interested_count ?? 0;
            r.myRsvp = localRsvps.get(r.id) ?? null;
        }
        r.targetGroupId = r.target_group_id || null;
        r.targetGroupName = r.target_group_name || null;
        r.targetPubkey = r.target_pubkey || null;
        r.assignedTo = r.assigned_to || null;

        if (r.type === 'poll') {
            if (typeof r.poll_options === 'string') {
                try { r.pollOptions = JSON.parse(r.poll_options); } catch { r.pollOptions = []; }
            } else if (Array.isArray(r.poll_options)) {
                r.pollOptions = r.poll_options;
            } else if (Array.isArray(r.pollOptions)) {
                // already array
            } else {
                r.pollOptions = [];
            }
            r.pollClosesAt = r.poll_closes_at || r.pollClosesAt;
            if (typeof r.poll_new_or_words_votes === 'number') r.pollNewOrWordsVotes = r.poll_new_or_words_votes;
            if (localVotes.has(r.id)) {
                r.userVotedOptionId = localVotes.get(r.id);
            }
        }

        if (typeof r.photos === 'string') {
            try {
                r.photos = JSON.parse(r.photos);
                if (Array.isArray(r.photos)) {
                    r.photos = r.photos.map((p: string) => photoOnCommunity(anchorUrl, p));
                }
            } catch (e) { r.photos = []; }
        }
        // Its enterprise's shop banner, on the node's address as its photos are: the card's picture when it has none of
        // its own (utils/market-card-picture.ts).
        const banner: string | null = r.carried_banner || null;
        r.authorBannerUrl = banner && photoOnCommunity(anchorUrl, banner);
        return r;
    });
}

/** The signed-in member's OWN posts, INCLUDING paused ones (which getPosts hides from the feed).
 *  Used by "My Posts" so a member can see and re-activate a paused Offer. */
export async function getMyPosts(pubkey: string) {
    const { database, anchorUrl } = await chatCopyForRequest();
    const rows = await database.getAllAsync(`
        SELECT p.*, COALESCE(m.callsign, p.carried_callsign) as author_callsign, CASE WHEN m.public_key IS NOT NULL THEN m.avatar_url ELSE p.carried_avatar END as author_avatar, m.joined_at
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        WHERE p.author_pubkey = ? AND p.status IN ('active', 'pending', 'completed', 'paused') AND p.type != 'event'
        ORDER BY p.created_at DESC
    `, [pubkey]) as any[];
    return rows.map((r: any) => {
        r.authorFoundingNeeded = r.author_founding_needed === 1;
        r.author_energy_cycled = r.author_energy_cycled ?? 0;
        r.pinnedUntil = r.pinned_until || r.pinnedUntil || undefined;
        r.pinnedAt = r.pinned_at || r.pinnedAt || undefined;
        if (typeof r.photos === 'string') {
            try {
                r.photos = JSON.parse(r.photos);
                if (Array.isArray(r.photos)) r.photos = r.photos.map((p: string) => photoOnCommunity(anchorUrl, p));
            } catch (e) { r.photos = []; }
        }
        return r;
    });
}

/**
 * The events this member hosts, as this phone keeps them (their own posts are always kept: NEARBY_KEPT_SQL), still on: not
 * cancelled or taken down, newest first, at most 50. The forum's Link picker lists them before the ones they RSVP'd to
 * (components/forum/ForumLinks.tsx; a host has no RSVP row, so /api/events/mine alone leaves them out), as the web's
 * linkablesOf reads its own posts of type event. getMyPosts above leaves events out.
 */
export async function getMyHostedEvents(pubkey: string): Promise<{ id: string; title: string }[]> {
    const database = await waitForInit();
    return await database.getAllAsync(`
        SELECT id, title FROM posts
        WHERE author_pubkey = ? AND type = 'event' AND status IN ('active', 'pending', 'paused') AND COALESCE(event_state, '') != 'cancelled'
        ORDER BY created_at DESC
        LIMIT 50
    `, [pubkey]) as { id: string; title: string }[];
}

/**
 * Reads one listing from the node again and writes it through the sync's own row writer. Tells the screens
 * (`sync_data_updated`) only when what they show changed: post screens reload on that event and call getPost, which
 * calls this, so an unconditional emit fetch-loops. The photos are part of it: a node that now keys its listings'
 * photos (or keys them with a new secret) hands out new URLs for a listing that did not otherwise change, and the
 * screen must reload to show them (the old ones answer 404). Resolves whether it told them.
 *
 * Writes only into `database` while it is still the open one and belongs to `anchorUrl`'s community: a community switch
 * between the caller reading the anchor and opening the database, or while the read is out, would otherwise put one
 * community's listing in another's cache (as applyDelta's `expectedDbName` guard does for the sync).
 */
async function refreshCachedPost(database: SQLite.SQLiteDatabase, anchorUrl: string, id: string): Promise<boolean> {
    const res = await fetch(`${anchorUrl}/api/marketplace/posts?id=${encodeURIComponent(id)}&sync=true`);
    // As in the sync: never the visitors' view over a member's row (utils/posts-view.ts).
    if (viewOf(res) === 'guest' && await postsViewRefusal(res, anchorUrl, (await loadIdentity())?.publicKey)) return false;
    const posts = await res.json();
    if (!Array.isArray(posts)) return false;
    if (posts.length === 0) {
        // The node answered that it holds no such listing (it deleted the row: a dropped federation peer's listings). Said
        // apart from a failed read, which says nothing: the listing page keeps what it shows over a read with no row
        // (utils/shown-post.ts), and only this lets it say "not found" (the confirmation review of #1778, finding 1). Never
        // deletes the phone's row: that stays applyDelta's job. Only for the community still open, as the write below.
        if (res.ok && db === database && currentDbName === getDatabaseFilenameForNode(anchorUrl)) {
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('post_not_on_node', id);
        }
        return false;
    }
    const p = posts[0];
    const before = await database.getFirstAsync<any>(
        'SELECT status, active, accepted_by, pending_transaction_id, completed_at, updated_at, photos, lendable, tags, free_tags, pinned_until, pinned_at FROM posts WHERE id = ?', [id]
    );
    await acquireSyncLock();
    try {
        // Checked under the lock: a switch closes the database under the same lock (closeDB, getDb), so none lands
        // between this check and the write.
        if (db !== database || currentDbName !== getDatabaseFilenameForNode(anchorUrl)) return false;
        // The sync's own row writer: a second copy of it here had already drifted, and put a group
        // listing back to 'public' every time someone opened it.
        await writeSyncedPost(database, { ...p, id: p.id ?? id });
    } finally {
        releaseSyncLock();
    }
    const changed = !before ||
        before.status !== (p.status || 'active') ||
        (before.active ? 1 : 0) !== (p.active !== undefined ? (p.active ? 1 : 0) : 1) ||
        (before.accepted_by || null) !== (p.accepted_by || p.acceptedBy || null) ||
        (before.pending_transaction_id || null) !== (p.pending_transaction_id || p.pendingTransactionId || null) ||
        (before.completed_at || null) !== (p.completed_at || p.completedAt || null) ||
        (before.updated_at || null) !== (p.updated_at || p.updatedAt || null) ||
        (before.lendable ? 1 : 0) !== (p.lendable ? 1 : 0) ||
        (before.photos ?? null) !== syncedPhotosColumn(p) ||
        (before.tags ?? '') !== syncedTagsColumn(p) ||
        (before.free_tags ?? '') !== syncedFreeTagsColumn(p) ||
        (before.pinned_until || null) !== (p.pinned_until || p.pinnedUntil || null) ||
        (before.pinned_at || null) !== (p.pinned_at || p.pinnedAt || null);
    if (changed) {
        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('sync_data_updated');
    }
    return changed;
}

/**
 * Reads one listing from the node again, as opening it does (refreshCachedPost), for a screen whose photo of it would
 * not load (utils/photo-refresh.ts bounds how often). Only for a listing of the community this phone is on now: the
 * photo's URL must be that node's. Resolves whether the screens were told to reload.
 */
export async function refreshPostForPhoto(id: string, photoUrl: string): Promise<boolean> {
    const { database, anchorUrl } = await chatCopyForRequest();
    if (!anchorUrl || !photoUrl.startsWith(photoOnCommunity(anchorUrl, '/'))) return false;
    return refreshCachedPost(database, anchorUrl, id);
}

/**
 * Reads one listing from the node again, as opening it does (refreshCachedPost), and resolves once it is written: after a
 * take-up the node refused because the listing moved on (a count, a price for all, a price changed: core itemTakeUpRefusalIn),
 * so the page shows it as it is now before the member chooses again. Resolves whether the screens were told to reload.
 */
export async function refreshPost(id: string): Promise<boolean> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || '';
    if (!anchorUrl) return false;
    const database = await waitForInit();
    return refreshCachedPost(database, anchorUrl, id);
}

/**
 * A listing's count and price for all of them as the node holds them now (DESIGN-per-item-price-fable.md §2.5): the edit form
 * sends the count it read here back as `unitsLeftWas`, and the node writes a changed count only if the row still holds it.
 * The phone's own copy of a post doesn't keep the two, and a copy would be as old as the last sync. Null when the node has
 * no such listing; throws when it can't be read (the form then isn't opened on a count it never saw).
 */
export async function getListingItems(id: string): Promise<{ unitsLeft: number | null; lot: { units: number; price_c: number } | null } | null> {
    const res = await signedGet(`/api/marketplace/posts?id=${encodeURIComponent(id)}&sync=true`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const posts = await res.json();
    const p = Array.isArray(posts) ? posts[0] : null;
    if (!p) return null;
    const lot = p.lot && Number.isInteger(p.lot.units) && Number.isInteger(p.lot.price_c) ? { units: p.lot.units as number, price_c: p.lot.price_c as number } : null;
    return { unitsLeft: Number.isInteger(p.unitsLeft) ? (p.unitsLeft as number) : null, lot };
}

export async function getPost(id: string) {
    const { database, anchorUrl } = await chatCopyForRequest();
    
    // Background fetch to ensure the local DB has the latest post status.
    // Upserts so a post we've never synced (e.g. opened via a chat's "View Post"
    // before the next Pillar sync) appears after one round-trip. A slow or empty
    // server response never deletes local rows — deletion is applyDelta's job
    // (the server tombstones deleted posts with active=0).
    if (anchorUrl) void refreshCachedPost(database, anchorUrl, id).catch(() => false);

    const row = await database.getFirstAsync<any>(`
        SELECT p.*, COALESCE(m.callsign, p.carried_callsign) as author_callsign, CASE WHEN m.public_key IS NOT NULL THEN m.avatar_url ELSE p.carried_avatar END as author_avatar, a.callsign as accepted_by_callsign, a.avatar_url as accepted_by_avatar, m.joined_at
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        LEFT JOIN members a ON p.accepted_by = a.public_key
        WHERE p.id = ?
    `, [id]);
    
    if (row) {
        row.authorFoundingNeeded = row.author_founding_needed === 1;
        row.author_energy_cycled = row.author_energy_cycled ?? 0;
        row.pinnedUntil = row.pinned_until || row.pinnedUntil || undefined;
        row.pinnedAt = row.pinned_at || row.pinnedAt || undefined;
        if (row.type === 'poll') {
            // This phone's own answer, as the Market's list reads it (getPosts), so the poll's page (app/post/[id].tsx, slice C1)
            // ticks the answer the compact row's mark names.
            try {
                const me = (await loadIdentity())?.publicKey;
                const vote = me ? await database.getFirstAsync<any>('SELECT option_id FROM poll_votes WHERE post_id = ? AND voter_pubkey = ?', [id, me]) : null;
                if (vote?.option_id) row.userVotedOptionId = vote.option_id;
            } catch { }
        }

        if (typeof row.photos === 'string') {
            try {
                row.photos = JSON.parse(row.photos);
                if (Array.isArray(row.photos)) {
                    row.photos = row.photos.map((p: string) => photoOnCommunity(anchorUrl, p));
                }
            } catch (e) { row.photos = []; }
        }
    }
    return row;
}

function formatSystemMessage(
    systemType: string | null,
    metadataStr: string | null,
    myPubkey: string | null,
    fallbackInfo: {
        postAuthor?: string | null;
        postType?: string | null;
        latestTxBuyer?: string | null;
        latestTxSeller?: string | null;
        defaultText?: string | null;
    }
): string {
    let meta: any = null;
    if (metadataStr) {
        try { meta = JSON.parse(metadataStr); } catch {}
    }
    // The node's escrow lines carry the figure as whole hundredths (TypedMessagePayload amount_c); anything else, no figure.
    // Plain ASCII ("49.25"): this English is matched by utils/chat-line-words.ts, which writes the figure in the member's language.
    const amount = isHundredths(meta?.amount_c) && meta.amount_c > 0 ? hundredthsAsDecimalText(meta.amount_c) : '';
    const beansStr = amount ? `${amount} Beans` : 'Beans';

    if (systemType === 'ESCROW_FUNDED') {
        return `${beansStr} held in trust.`;
    }
    if (systemType === 'ESCROW_RELEASED') {
        const sellerPubkey = meta?.sellerPubkey || fallbackInfo.latestTxSeller || (fallbackInfo.postType === 'offer' ? fallbackInfo.postAuthor : null);
        const isSeller = myPubkey && sellerPubkey && myPubkey === sellerPubkey;
        if (isSeller) {
            return `Payment of ${beansStr} released to you.`;
        } else {
            return `Payment of ${beansStr} released to the provider.`;
        }
    }
    if (systemType === 'ESCROW_CANCELLED') {
        return `Trust hold cancelled and funds refunded.`;
    }
    
    // Fallback: clean up Ʀ or R in the ciphertext
    let txt = fallbackInfo.defaultText || '';
    if (txt.includes('Ʀ')) {
        txt = txt.replace(/Ʀ(\d+)/g, '$1 Beans').replace(/Ʀ/g, 'Beans');
    }
    if (txt.includes('Payment of R')) {
        txt = txt.replace(/Payment of R(\d+) released to the provider\./g, (_: string, amt: string) => {
            const sellerPubkey = meta?.sellerPubkey || fallbackInfo.latestTxSeller || (fallbackInfo.postType === 'offer' ? fallbackInfo.postAuthor : null);
            const isSeller = myPubkey && sellerPubkey && myPubkey === sellerPubkey;
            return `Payment of ${amt} Beans released to ${isSeller ? 'you' : 'the provider'}.`;
        });
        txt = txt.replace(/R(\d+) has been placed in escrow\./g, '$1 Beans held in trust.');
    }
    return txt;
}

/** A message request (a row's `request`, as stored or parsed) for `me` that isn't accepted: waiting, ignored or lapsed. */
function isRequestFor(request: unknown, me: string): boolean {
    let r: any = request;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return false; } }
    return !!r && typeof r === 'object' && typeof r.from === 'string' && r.from !== me && r.state !== 'accepted';
}

/**
 * isRequestFor in SQL, over a conversations row's `request` column: true when the row is NOT a request for the member its
 * one `?` binds. A request's card preview writes its people and lines (syncSingleConversation), so joining
 * conversation_participants no longer leaves it out: every reader of the phone's chats that counts or names them (the Talk
 * badge, Needs you, Recents) applies this, as the node's own unread counts leave requests out. Unreadable JSON is no request.
 */
const NOT_A_REQUEST_FOR_ME = (column: string) => `(CASE WHEN json_valid(${column}) THEN (CASE WHEN json_type(${column}, '$.from') = 'text'
    AND json_extract(${column}, '$.from') != ? AND json_extract(${column}, '$.state') IS NOT 'accepted' THEN 0 ELSE 1 END) ELSE 1 END)`;

/**
 * One column of the other person in a conversation (`memb.<column>` from their card, or `cp.public_key`), for every
 * reader that names a chat by the person in it, each the same person. After a re-key the phone keeps the old key's
 * participant row beside the new one until a send (#1872 U7), and holds a card for either, both or neither until its
 * members delta or whole read brings them. So the read takes a participant whose card the phone holds, the newest card
 * first (the node stamps the card it moves on a re-key, member-wizards.ts completeRekey), then by key: never whichever
 * row the index gives first, which named the person by the conversation's id (walk of #3263, 16 Nov 2026). Its one `?`
 * is my key, as before.
 */
const otherParticipantSql = (column: 'callsign' | 'avatar_url' | 'profile_updated_at' | 'public_key', conversation = 'c.id') =>
    `(SELECT ${column === 'public_key' ? 'cp.public_key' : `memb.${column}`} FROM conversation_participants cp
         LEFT JOIN members memb ON memb.public_key = cp.public_key
         WHERE cp.conversation_id = ${conversation} AND cp.public_key != ?
         ORDER BY (memb.public_key IS NULL), memb.profile_updated_at DESC, cp.public_key LIMIT 1)`;

/**
 * Every other participant's key in a conversation, comma-joined (dm-blocked.ts dmPeerKeys reads it): a DM is blocked when
 * any key its other person is known by is on the block list, not only the one the name order picks. Its one `?` is my key.
 */
const otherKeysSql = (conversation = 'c.id') =>
    `(SELECT group_concat(cpk.public_key) FROM conversation_participants cpk WHERE cpk.conversation_id = ${conversation} AND cpk.public_key != ?)`;

export async function getConversations(myPubkey: string) {
    const { database, anchorUrl } = await chatCopyForRequest();
    const rows = await database.getAllAsync<any>(`
        SELECT c.id, c.name, c.post_id, c.type as convType, c.request as request, c.created_at as createdAt,
               COALESCE(p.title, c.post_title) as postTitle,
               COALESCE(
                   (SELECT mt2.status FROM marketplace_transactions mt2
                    WHERE mt2.post_id = c.post_id
                      AND mt2.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                      AND mt2.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                    ORDER BY mt2.created_at DESC LIMIT 1),
                   p.status,
                   c.post_status
               ) as postStatus,
               COALESCE(p.price_c, c.post_price_c) as postPrice_c,
               COALESCE(p.photos, c.post_photo) as postPhotos,
               m.ciphertext as lastMessage, m.nonce as lastNonce, m.type as lastMsgType, m.system_type as lastSysType, m.metadata as lastMetadata,
               m.id as lastId, m.author_pubkey as lastAuthor, MAX(m.timestamp) as timestamp,
               p.author_pubkey as postAuthor, p.type as postType,
               (SELECT mt3.buyer_pubkey FROM marketplace_transactions mt3 WHERE mt3.post_id = c.post_id ORDER BY mt3.created_at DESC LIMIT 1) as latestTxBuyer,
               (SELECT mt3.seller_pubkey FROM marketplace_transactions mt3 WHERE mt3.post_id = c.post_id ORDER BY mt3.created_at DESC LIMIT 1) as latestTxSeller,
        ${otherParticipantSql('callsign')} as otherCallsign,
        ${otherParticipantSql('avatar_url')} as otherAvatar,
        ${otherParticipantSql('profile_updated_at')} as otherProfileUpdatedAt,
        ${otherParticipantSql('public_key')} as otherPubkey,
        ${otherKeysSql()} as otherKeys,
        (SELECT COUNT(msg.id) FROM messages msg 
         WHERE msg.conversation_id = c.id 
         AND msg.author_pubkey != ?
         AND (msg.timestamp > IFNULL((SELECT last_read_at FROM conversation_participants WHERE conversation_id = c.id AND public_key = ?), '2000-01-01'))
         AND ${countsAsUnreadSql('msg')}
        ) as unreadCount,
        mt.id as pendingTxId,
        mt.amount_c as pendingAmount_c,
        mt.buyer_pubkey as txBuyerPubkey,
        mt.seller_pubkey as txSellerPubkey,
        -- Has the current user already left a review for this post's trade?
        -- Derived from the durable ratings table (additive, survives sync) rather than the
        -- marketplace_transactions rated_by_* flag, which applyDelta overwrites from the server
        -- on every sync. A sync already in flight at end-of-trade can land after the optimistic
        -- flag set and reset it to 0, making the Leave Review prompt reappear even though the
        -- user already reviewed. A ratings row, once written, persists.
        -- Matches the server's own EXISTS check and the in-chat rating-submitted indicator.
        (SELECT CASE WHEN EXISTS(
            SELECT 1 FROM marketplace_transactions mt
            WHERE mt.status = 'completed'
              AND mt.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
              AND mt.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
              AND NOT EXISTS (
                  SELECT 1 FROM ratings r 
                  WHERE r.transaction_id = mt.id 
                    AND r.rater_pubkey = ?
              )
         ) THEN 0 ELSE 1 END) as hasRated,
        -- Whether this (now per-person) thread has any trade between its participants — drives
        -- the Transactions/Direct inbox tabs now that conversations are no longer post-keyed.
        (SELECT COUNT(*) FROM marketplace_transactions dmt
           WHERE dmt.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
             AND dmt.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)) as dealCount
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        LEFT JOIN posts p ON c.post_id = p.id
        LEFT JOIN marketplace_transactions mt ON mt.post_id = p.id AND mt.status = 'pending'
        WHERE c.id IN (SELECT conversation_id FROM conversation_participants WHERE public_key = ?)
          AND (c.type IS NULL OR c.type != 'enterprise_thread')
        GROUP BY c.id
        ORDER BY timestamp DESC
    `, [myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey]);
    
    // Pre-load identity so encrypted DM previews can be decrypted below.
    const previewIdentity = await loadIdentity();
    // A DM's newest line opens under the key this phone pinned for it (utils/dm-peer-pins.ts), as its thread does: never
    // under a key the node listed in its place. Unreadable pins: nothing opens (fail closed).
    let previewPins: DmPeerPins | null = null;
    try { previewPins = previewIdentity?.publicKey ? await dmPins.read(previewIdentity.publicKey, database) : null; } catch { previewPins = null; }
    // The keys each DM's other person is known by (peerKeys, below) come from this member's pins, read once.
    let keyPins: DmPeerPins | null = previewPins;
    if (!keyPins) { try { keyPins = await dmPins.read(myPubkey, database); } catch { keyPins = null; } }
    // The member's verified keys, for the "key changed" tag (a verified person's change waits for them).
    const verified = await dmVerified.read(previewIdentity?.publicKey ?? myPubkey);

    // A request for this member they haven't accepted is no chat of theirs: the node lists it under Requests, or nowhere
    // once ignored or lapsed (sortRequestsOut). Its row is here for its card's preview and its own screen only.
    return rows.filter(row => !isRequestFor(row.request, myPubkey)).map(row => {
        let displayMsg = row.lastMessage ? '[Message]' : 'Started conversation';
        // Whether BeanPool wrote the preview: a stand-in for a line it can't show, a deleted line's fixed text, a system
        // line (a trade's, the node's own: nonce 00000, type system or author SYSTEM). Only then is it translated where
        // shown (chat-line-words.ts chatPreviewWords). Words someone wrote, a member's line or the admins' message, are
        // shown exactly as written, even when they match a sentence BeanPool writes.
        let fromApp = true;
        // A DM's newest line, judged as the thread judges it (e2e-crypto checkDmThread): an encrypted line opened bound to
        // the author and id the node stores it under, under this conversation's id or one its metadata names (folded
        // threads), its sender's signature verified. Only words that open are shown as words; a line that doesn't, a row in
        // a member's name that isn't an encrypted line and the admin page's message say what they are. The node's own
        // notices are formatted below. Tried under the pin's former keys too, as the thread tries them (getDmKeyContext
        // formerPeers): after a re-key, the member's own last line sealed to the key before reads here as it does there.
        const previewPin = previewPins ? dmPinFor(previewPins, row.id) : null;
        const lastView = row.lastId && !isNodeReadableChatType(row.convType)
            ? checkDmThread([{ id: row.lastId, authorPubkey: row.lastAuthor, ciphertext: row.lastMessage, nonce: row.lastNonce, type: row.lastMsgType, metadata: row.lastMetadata, timestamp: row.timestamp }],
                previewIdentity?.privateKey && previewPins && (previewPin?.peer ?? row.otherPubkey) ? { myEdPrivHex: previewIdentity.privateKey, peerEdPubHex: previewPin?.peer ?? row.otherPubkey } : null, row.id,
                dmShownFormer(previewPin)).get(row.lastId)
            : undefined;
        // The node's own notice in a DM: said to be one, never shown as the other person's line (formatted below).
        const lastIsDmNotice = !!row.lastId && !isNodeReadableChatType(row.convType)
            && dmLineKind({ authorPubkey: row.lastAuthor, nonce: row.lastNonce, type: row.lastMsgType }) === 'node-notice';
        if (lastView) {
            if (lastView.mark === 'not-verified') displayMsg = '🔒 Encrypted message';
            else if (lastView.mark === 'not-encrypted') displayMsg = DM_LINE_NOT_ENCRYPTED_TEXT;
            else if (lastView.mark === 'from-admins') {
                displayMsg = `From your community's admins: ${lastView.text}`;
                fromApp = false;
            } else {
                displayMsg = dmLineShownText(lastView);
                // Only a line that opened (format 4, signed by its author, or a line from before 1.4.0 opened as it was then)
                // holds their words; a deleted line's text is fixed. (The old line: conversion code, log row OLDCHAT, remove after 12 Dec 2026.)
                fromApp = lastView.format === null && !dmLineIsOld(lastView);
                // A voice message's words are empty: the list says what it is (slice V3), in the member's language.
                if (row.lastMsgType === 'voice' && lastView.format !== null) {
                    displayMsg = '🎤 Voice message';
                    fromApp = true;
                }
            }
        } else if (row.lastNonce && row.lastNonce.startsWith('plaintext')) {
            try {
                displayMsg = decodeUtf8(decodeBase64(row.lastMessage));
                fromApp = row.lastMsgType === 'system' || row.lastAuthor === 'SYSTEM';
            } catch {
                displayMsg = '[Unreadable message]';
            }
        } else if (isEncryptedNonce(row.lastNonce)) {
            displayMsg = '🔒 Encrypted message';
        } else if (row.lastNonce === '00000') {
            displayMsg = formatSystemMessage(row.lastSysType, row.lastMetadata, myPubkey, {
                postAuthor: row.postAuthor,
                postType: row.postType,
                latestTxBuyer: row.latestTxBuyer,
                latestTxSeller: row.latestTxSeller,
                defaultText: row.lastMessage
            });
        }
        if (lastIsDmNotice) displayMsg = `${dmQuoteLabel('notice')}: ${displayMsg}`;

        const isPayer = row.txBuyerPubkey === myPubkey;
        const isPayee = row.txSellerPubkey === myPubkey;

        let parsedRequest = undefined;
        if (row.request) {
            try { parsedRequest = typeof row.request === 'string' ? JSON.parse(row.request) : row.request; } catch {}
        }

        // Extract first photo from post photos JSON
        let postPhoto: string | null = null;
        if (row.postPhotos) {
            try {
                const arr = Array.isArray(row.postPhotos) ? row.postPhotos : JSON.parse(row.postPhotos);
                if (arr.length > 0) {
                    const firstPhoto = arr[0];
                    postPhoto = firstPhoto && photoOnCommunity(anchorUrl, firstPhoto);
                }
            } catch {}
        }

        return {
            id: row.id,
            postId: row.post_id,
            postTitle: row.postTitle,
            postStatus: row.postStatus,
            postPrice_c: isHundredths(row.postPrice_c) ? row.postPrice_c : null,
            postPhoto,
            type: row.convType || 'dm',
            // No card held for the other member (a community that says `membersOnDemand`, before the cycle that fetches
            // it by key): the key's first 8 characters, never the conversation's (DESIGN-global-members-by-area §2.4), by the
            // one rule the thread's header and Needs you name it by (dm-blocked.ts dmPeerName).
            peer: dmPeerName(row),
            peerAvatar: row.otherAvatar || null,
            peerUpdatedAt: row.otherProfileUpdatedAt || null,
            peerPubkey: row.otherPubkey || null,
            // Every key a DM's other person is known by here (its participants, its pin's key and former keys): Talk hides
            // the chat when any is blocked (dm-blocked.ts talkShowsChat), so a block holds across their re-key.
            peerKeys: isDmType(row.convType)
                ? dmPeerKeys(row.otherKeys, keyPins ? dmPinFor(keyPins, row.id) : null)
                : (row.otherPubkey ? [String(row.otherPubkey)] : []),
            // The "key changed" tag: only while the chat waits for the member (DESIGN-dm-key-signal-model §4): a verified
            // person's change, or no single key listed. An ordinary change shows none: the chat carries on with a notice in
            // the thread (from the same one read as the preview; unreadable pins, no tag: the chat itself says why).
            keyChanged: (row.convType || 'dm') === 'dm' && !!previewPins && dmEntryWaitsForMember(dmSightFor(previewPins, row.id), verified),
            lastMessage: displayMsg,
            lastMessageFromApp: fromApp,
            lastMsgType: row.lastMsgType,
            lastSysType: row.lastSysType,
            timestamp: row.timestamp ? new Date(row.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'New',
            rawTimestamp: row.timestamp || null,
            // When the chat was made: where it sits in Talk while it has no line (utils/talk-list-order.ts).
            createdAt: row.createdAt || null,
            unread: row.unreadCount || 0,
            // Escrow role metadata for "Action Required" section
            isPayer,
            isPayee,
            pendingAmount_c: isHundredths(row.pendingAmount_c) && row.pendingAmount_c > 0 ? row.pendingAmount_c : null,
            pendingTxId: row.pendingTxId || null,
            hasRated: row.hasRated > 0,
            dealCount: row.dealCount || 0,
            request: parsedRequest,
        };
    });
}

/**
 * A chat this member has in another community the phone holds (getHeldConversations), as its own copy last had it. No
 * preview of its lines (slice S2 opens them, with that file's pins): S1 lists the chat, and a tap moves there.
 */
export interface HeldConversation {
    id: string;
    type: string;
    postId: string | null;
    postTitle: string | null;
    /** The listing's first photo, on THAT community's server: never an address of the community in use. */
    postPhoto: string | null;
    peer: string;
    /** The other person's photo, on that community's server. */
    peerAvatar: string | null;
    peerUpdatedAt: string | null;
    peerPubkey: string | null;
    /** Every other key in the chat (dm-blocked.ts talkShowsChat hides it when any is blocked). */
    peerKeys: string[];
    /**
     * The "key changed" tag, as Chat's own rows have it (DESIGN-s7-blocks-verified-everywhere §3.3): the chat waits for the
     * member there (a verified person's change, or no single key listed), read from that community's pins as stored and
     * the member's one list of verified keys. False when its pins can't be read: the chat itself says why.
     */
    keyChanged: boolean;
    rawTimestamp: string | null;
    createdAt: string | null;
}

/**
 * The held copy's chat rows, one statement (utils/held-copies.ts takes no more): its Talk chats (a group's, an event's and an
 * enterprise's live under Groups), none that is a request for this member, each with its newest line's time and the other
 * person as getConversations names them. Binds my key seven times: five for the other person's columns, then the
 * participant row and the request.
 */
const HELD_CONVERSATIONS_SQL = `
    SELECT c.id, c.name, c.post_id, c.type as convType, c.created_at as createdAt,
           COALESCE(p.title, c.post_title) as postTitle, COALESCE(p.photos, c.post_photo) as postPhotos,
           (SELECT MAX(msg.timestamp) FROM messages msg WHERE msg.conversation_id = c.id) as timestamp,
           ${otherParticipantSql('callsign')} as otherCallsign,
           ${otherParticipantSql('avatar_url')} as otherAvatar,
           ${otherParticipantSql('profile_updated_at')} as otherProfileUpdatedAt,
           ${otherParticipantSql('public_key')} as otherPubkey,
           ${otherKeysSql()} as otherKeys
    FROM conversations c
    LEFT JOIN posts p ON c.post_id = p.id
    WHERE c.id IN (SELECT conversation_id FROM conversation_participants WHERE public_key = ?)
      AND (c.type IS NULL OR c.type NOT IN ('group_thread', 'event_thread', 'enterprise_thread'))
      AND ${NOT_A_REQUEST_FOR_ME('c.request')} = 1
    ORDER BY timestamp DESC
`;

/**
 * Each held chat's own unread count and the time of its newest line (slice S2b), as the held copy's own lines and its read
 * mark have them, counted as Talk's own list counts them (getConversations' unreadCount). The same chats as
 * HELD_CONVERSATIONS_SQL. Binds my key five times: the author, my read mark, the quiet rule, the participant row, the request.
 */
const HELD_LATEST_SQL = `
    SELECT c.id, c.type as convType,
           (SELECT MAX(msg.timestamp) FROM messages msg WHERE msg.conversation_id = c.id) as newest,
           (SELECT COUNT(msg.id) FROM messages msg
             WHERE msg.conversation_id = c.id AND msg.author_pubkey != ?
               AND msg.timestamp > IFNULL((SELECT last_read_at FROM conversation_participants WHERE conversation_id = c.id AND public_key = ?), '2000-01-01')
               AND ${countsAsUnreadSql('msg')}) as unread
    FROM conversations c
    WHERE c.id IN (SELECT conversation_id FROM conversation_participants WHERE public_key = ?)
      AND (c.type IS NULL OR c.type NOT IN ('group_thread', 'event_thread', 'enterprise_thread'))
      AND ${NOT_A_REQUEST_FOR_ME('c.request')} = 1
`;

/**
 * The newest line of each direct chat named (slice S2b): its one `?` is a JSON array of the ids, at most
 * HELD_PREVIEWS_MAX of them (getHeldPreviews), so the cost is bounded whatever the copy holds.
 */
const HELD_PREVIEWS_SQL = `
    SELECT c.id as conversationId, c.type as convType,
           m.id as lastId, m.author_pubkey as lastAuthor, m.ciphertext as lastMessage, m.nonce as lastNonce,
           m.type as lastMsgType, m.metadata as lastMetadata, m.timestamp as timestamp
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id AND m.id = (SELECT newest.id FROM messages newest WHERE newest.conversation_id = c.id
                                                             ORDER BY newest.timestamp DESC, newest.rowid DESC LIMIT 1)
    WHERE c.id IN (SELECT value FROM json_each(?))
      AND (c.type IS NULL OR c.type = 'dm')
`;

/**
 * A line in a direct chat that the member wrote themselves (#3319 review N1), as `m`, a messages row: its one `?` is my key.
 * Every line a member writes in a direct chat is sealed (format 4: the node refuses any other, engine/messaging.ts
 * refuseUnencryptedDm), from whichever of their devices; so a row in their name that isn't sealed is the node's, written
 * on their behalf (core dm-crypto dmLineKind: "in a DM only an encrypted line is ever a member's words"). That is a notice
 * from the node's inbox, which any admin or an owner's token sends under the first owner's key (state-engine.ts
 * adminSendMessage: readable, marked DM_FROM_ADMINS_KEY), or a system line. A line marked as the community admins' is
 * never the member's either, whatever its nonce: the mark says someone else wrote it.
 */
const MEMBERS_OWN_LINE_SQL = (m: string) => `${m}.author_pubkey = ? AND IFNULL(${m}.type, 'text') != 'system'
      AND substr(${m}.nonce, 1, ${DM_NONCE_PREFIX.length}) = '${DM_NONCE_PREFIX}'
      AND (CASE WHEN json_valid(${m}.metadata) THEN json_extract(${m}.metadata, '$.${DM_FROM_ADMINS_KEY}') IS NOT 1 ELSE 1 END)`;

/**
 * A chat `c` (a conversations row) the member took part in themselves (#3319 review at 1697ff89, R2-F1; Marty 21 Nov 2026:
 * "chatted with" counts only chats where the member wrote or accepted themselves): they wrote a line in it
 * ({@link MEMBERS_OWN_LINE_SQL}), or accepted its request by their own act, the node's `acceptedByYou` (engine/dm-requests.ts
 * RequestView), which this phone's row keeps from the node's answer to their Accept (decideMessageRequest, requestDecided).
 * Never a chat only the other person or the node wrote in: one opened by someone taking up the member's Offer (the trade
 * accepts it as nobody's act), a message that arrived straight away where requests are off and was never answered, a notice
 * from the node's inbox. Its one `?` is my key. Let in once's `dm` row ({@link LET_IN_SQL}) and "Add people I've chatted with
 * and my friends" (getChattedWithMembers) both read this one test, so that button never links someone the let-in would not.
 */
const MEMBERS_OWN_CHAT_SQL = (c: string) => `(EXISTS (SELECT 1 FROM messages own_line WHERE own_line.conversation_id = ${c}.id AND ${MEMBERS_OWN_LINE_SQL('own_line')})
           OR (CASE WHEN json_valid(${c}.request)
                    THEN json_extract(${c}.request, '$.state') = 'accepted' AND json_extract(${c}.request, '$.acceptedByYou') IS 1 ELSE 0 END))`;

/**
 * The people this member let in, as one copy holds them (slice S3b, DESIGN-no-switch-messaging-fable.md §3 "Let in once"):
 * derived at each read, never stored or sent. Only a step the member took lets anyone in (#3319 review F1, the director's
 * call of 21 Nov 2026 on the rule "one person's word doesn't count": a stranger must not skip the door by his own act), so
 * each row is one the member made:
 * - `dm`: a direct chat the member took part in themselves ({@link MEMBERS_OWN_CHAT_SQL}): they wrote a line in it
 *   ({@link MEMBERS_OWN_LINE_SQL}: a sealed line of theirs, from any of their devices; never a line the node wrote in their
 *   name, as a notice from the node's inbox is, #3319 review N1), or accepted its request themselves: the node's
 *   `acceptedByYou` (engine/dm-requests.ts RequestView), never a request that reads accepted by the other's act, a trade's
 *   (acceptOnTrade: someone taking up the member's Offer, even one they Ignored), the node's own line's (nodeLineInRequest)
 *   or a node from before the field. letInOfRows takes the chat's pinned key.
 * - `key`: a friend the member added (owner_pubkey is the signer); a deal (pending or completed: one only asked, declined
 *   or cancelled before that is one person's word) where the member took a step: as its buyer (on an Offer they took it up
 *   or asked for it; on their own Need they approved the other's offer: only the buyer's act makes either), or as the
 *   seller on the buyer's own Need (the member offered, the buyer approved: the listing as this copy holds it names the
 *   buyer its author). A deal on the member's own Offer never counts on its own: a 1-step take-up (escrow.ts acceptPost)
 *   puts it at 'pending' with nothing from the seller, and only the buyer completes; whether the member approved a request
 *   instead is not on the phone. And someone the member paid (from_pubkey is theirs). A payment received is not here:
 *   anyone can send a member a Bean.
 * Binds my key seven times: the chat's other people, the participant row, my line, friends, my buys, my sales, my payments.
 */
const LET_IN_SQL = `
    SELECT 'dm' AS kind, c.id AS id, ${otherKeysSql()} AS keys FROM conversations c
    WHERE (c.type IS NULL OR c.type = 'dm')
      AND c.id IN (SELECT conversation_id FROM conversation_participants WHERE public_key = ?)
      AND ${MEMBERS_OWN_CHAT_SQL('c')}
    UNION ALL SELECT 'key', NULL, friend_pubkey FROM friends WHERE owner_pubkey = ?
    UNION ALL SELECT 'key', NULL, seller_pubkey FROM marketplace_transactions WHERE buyer_pubkey = ? AND status IN ('pending', 'completed')
    UNION ALL SELECT 'key', NULL, t.buyer_pubkey FROM marketplace_transactions t WHERE t.seller_pubkey = ? AND t.status IN ('pending', 'completed')
      AND EXISTS (SELECT 1 FROM posts p WHERE p.id = t.post_id AND p.author_pubkey = t.buyer_pubkey)
    UNION ALL SELECT 'key', NULL, to_pubkey FROM transactions WHERE from_pubkey = ?
`;
const letInParams = (me: string): string[] => [me, me, me, me, me, me, me];

/**
 * The keys one copy's {@link LET_IN_SQL} rows let in. A direct chat lets in only the key it is sealed to: its pin's (never a
 * key pinned before it, nor one a listing offers), or with no pin its one other person; none when its rows name several.
 */
function letInOfRows(rows: readonly any[], pins: DmPeerPins | null, me: string): string[] {
    const out = new Set<string>();
    for (const row of rows) {
        if (row.kind === 'key') {
            if (typeof row.keys === 'string' && row.keys && row.keys !== me) out.add(row.keys);
            continue;
        }
        const pinned = pins ? dmPinFor(pins, String(row.id)) : null;
        const others = typeof row.keys === 'string' && row.keys ? row.keys.split(',') : [];
        const key = pinned?.peer ?? (others.length === 1 ? others[0] : null);
        if (key && key !== me) out.add(key);
    }
    return [...out];
}

/**
 * The keys one copy's DM pins say are not a person's key now (#3319 review F1): each pin's former keys and the keys its
 * listing names as the pinned key's former ones (a re-keyed person's old key may be a lost phone's), and, while a chat's
 * community lists another key in place of its pinned one (an offer naming a key, which waits for the member), both that
 * pinned key and the key on offer. Let in once lets none of these in, from any copy or source: a friend, deal, payment or
 * contact row keeps whatever key it was made with.
 */
function notCurrentOfPins(pins: DmPeerPins | null): string[] {
    const out = new Set<string>();
    for (const entry of Object.values(pins ?? {})) {
        for (const k of entry?.heard?.tryKeys ?? []) out.add(k);
        if (!entry || isUnplacedSight(entry)) continue;
        for (const k of entry.former ?? []) out.add(k);
        const offered = entry.offered?.peer;
        if (offered && offered !== entry.peer) out.add(entry.peer).add(offered);
    }
    return [...out];
}

/**
 * What one copy says for let in once (slice S3b): whom its rows let in (`letIn`), and the keys its DM pins say are not a
 * person's key now (`notCurrent`, {@link notCurrentOfPins}), which no copy's row lets in.
 */
export interface LetInRead {
    letIn: string[];
    notCurrent: string[];
}

/**
 * What `community`'s copy says for let in once (slice S3b), another community this phone holds: its rows read through a
 * held, read-only handle (never getDb() nor the address in use), its DM pins as stored for that file, never seeded. A copy
 * whose rows can't be read lets nobody in, and its pins still count. Null when its pins can't be read: what they know was
 * replaced is then unknown, so nobody is let in quietly (#3319 review F1).
 */
export async function getHeldLetIn(myPubkey: string, community: string): Promise<LetInRead | null> {
    let pins: DmPeerPins | null;
    try {
        pins = await dmPins.peekReadable(myPubkey, getDatabaseFilenameForNode(community));
    } catch (e) {
        console.warn('[LetIn] A held copy\'s DM pins could not be read', e);
        return null;
    }
    let rows: any[] | null = null;
    try {
        rows = await heldListRead<any>(community, 'letIn', letInParams(myPubkey));
    } catch (e) {
        console.warn('[LetIn] A held copy could not be read', e);
    }
    return { letIn: rows ? letInOfRows(rows, pins, myPubkey) : [], notCurrent: notCurrentOfPins(pins) };
}

/**
 * What the copy in use says for let in once (slice S3b), with its DM pins as stored, never seeded. Its rows let nobody in for
 * a guest's look (its copy holds no chat, friend or deal of the member's). Null when the copy or its pins can't be read:
 * nobody is let in quietly then (#3319 review F1).
 */
export async function getLetInHere(myPubkey: string): Promise<LetInRead | null> {
    try {
        const here = await chatCopyForRequest();
        const pins = await dmPins.peekReadable(myPubkey, here.file);
        const notCurrent = notCurrentOfPins(pins);
        if (!here.anchorUrl || await isGuestCopy(here.anchorUrl)) return { letIn: [], notCurrent };
        const rows = await here.database.getAllAsync<any>(LET_IN_SQL, letInParams(myPubkey));
        return { letIn: letInOfRows(rows, pins, myPubkey), notCurrent };
    } catch (e) {
        console.warn('[LetIn] The copy in use could not be read', e);
        return null;
    }
}

/**
 * The people of a held copy whose name holds what was typed (slice S5 part 2: New message searches every community the
 * phone holds), as New message reads the copy in use's: not me, not pruned, not a system key; 20 at most. Binds my key,
 * then what was typed (matched with instr, so a % or _ in it is a letter like any other).
 */
const HELD_MEMBERS_SQL = `
    SELECT public_key, callsign, avatar_url, joined_at FROM members
    WHERE public_key != ? AND (status IS NULL OR status != 'pruned')
      AND public_key NOT LIKE 'escrow_%' AND public_key NOT LIKE 'project_%' AND public_key != 'SYSTEM'
      AND instr(lower(IFNULL(callsign, '')), lower(?)) > 0
    ORDER BY callsign COLLATE NOCASE ASC LIMIT 20
`;

/** A person in a held community, as New message lists them: their photo on THAT community's server. */
export interface HeldMember {
    public_key: string;
    callsign: string | null;
    avatar_url: string | null;
    joined_at: string | null;
}

/**
 * The people of `community`, another community this phone holds, whose name holds `typed` (slice S5 part 2), read through a
 * held, read-only handle, never getDb() nor the address in use. Null when there is nothing to read (as getHeldOutsideChats).
 */
export async function getHeldMembers(myPubkey: string, community: string, typed: string): Promise<HeldMember[] | null> {
    try {
        const rows = await heldListRead<any>(community, 'members', [myPubkey, typed]);
        return rows ? rows.map((r) => ({ public_key: r.public_key, callsign: r.callsign ?? null, avatar_url: onCommunity(community, r.avatar_url), joined_at: r.joined_at ?? null })) : null;
    } catch (e) {
        console.warn(`[Held] Could not search the people held for ${getDatabaseFilenameForNode(community)}`, e);
        return null;
    }
}

/** A row of a held copy's directory by its key, a member's or a visitor's, not pruned (slice S5 part 2: community-homes.ts doubted). */
const HELD_MEMBER_SQL = `SELECT 1 AS here FROM members WHERE public_key = ? AND (status IS NULL OR status != 'pruned') LIMIT 1`;

/**
 * Whether the copy of `community`, another community this phone holds, has a row for `key`, read through a held, read-only
 * handle (as {@link getHeldMembers}). No when there is nothing to read; a read that fails throws.
 */
export async function isHeldMember(community: string, key: string): Promise<boolean> {
    return !!(await heldListRead<any>(community, 'member', [key]))?.length;
}

/** The names of the statements a held copy runs (utils/held-copies.ts takes no SQL from a caller, only one of these). */
type HeldStatement = 'conversations' | 'dmFacts' | 'latest' | 'previews' | 'outsideChats' | 'outsideLastChanges' | 'letIn' | 'members' | 'member';
/** Every statement a held copy runs: one plain SELECT each (held-copies.ts isOneRead), refused at its use otherwise. */
const HELD_STATEMENTS: Readonly<Record<HeldStatement, string>> = Object.freeze({
    conversations: HELD_CONVERSATIONS_SQL, dmFacts: DM_FACTS_SQL, latest: HELD_LATEST_SQL, previews: HELD_PREVIEWS_SQL,
    // Across chats (slice S4): utils/outside-chat-store.ts, read as its chats() reads them.
    outsideChats: OUTSIDE_CHATS_HELD_SQL, outsideLastChanges: OUTSIDE_LAST_CHANGES_HELD_SQL,
    // The people the member let in (slice S3b).
    letIn: LET_IN_SQL,
    // New message's search of every held community's people, and one of them by key (slice S5 part 2).
    members: HELD_MEMBERS_SQL, member: HELD_MEMBER_SQL,
});

/**
 * One of Chat's held list reads of `community`'s copy (slices S1 and S4): a read answered null by a close of its read-only
 * handle under way (a round of that community, or a chat open there in place, letting go of the copy as Chat lists it:
 * outside-chat-live.ts, leaveChatInPlace) waits for that close, then asks once more on a handle of its own, as heldChatIsDm
 * does; so the list never drops that community's chats for the moment a close runs (#3310 review, measured:
 * held-chats-close-paths.test.ts). A pause, a move, the copy in use: null still, as the second ask finds them. S2b's
 * getHeldLatest and getHeldPreviews ask the same way, written out where they read.
 */
async function heldListRead<T>(community: string, statement: HeldStatement, params: readonly unknown[]): Promise<T[] | null> {
    const file = getDatabaseFilenameForNode(community);
    const rows = await heldCopies.all<T>(file, statement, params);
    if (rows) return rows;
    await heldCopies.readsSettled(file);
    return heldCopies.all<T>(file, statement, params);
}

/**
 * This account's across chats kept in `community`'s file, another community this phone holds (slice S4,
 * scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Where an across chat lives": same file, same rule, visible
 * always), read through a held, read-only handle, never through getDb() nor the address in use, each with its newest line
 * as the chat shows it. No synced cursor is asked: these tables are the phone's own, never cleared by a Force Resync. Null
 * when there is nothing to read (no such copy, the community in use, another schema number, a move or a delete under way).
 */
export async function getHeldOutsideChats(myPubkey: string, community: string): Promise<OutsideChat[] | null> {
    const file = getDatabaseFilenameForNode(community);
    try {
        const rows = await heldListRead<any>(community, 'outsideChats', [myPubkey]);
        if (!rows) return null;
        if (!rows.length) return [];
        const changes = (await heldListRead<any>(community, 'outsideLastChanges', [myPubkey])) ?? [];
        return outsideChatsFromHeld(myPubkey, rows, changes);
    } catch (e) {
        console.warn(`[Held] Could not list the chats across held for ${file}`, e);
        return null;
    }
}

/** A photo's address on `community`'s server: a path its node stored ("/uploads/…") is that server's, never the one in use. */
function onCommunity(community: string, value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim() || value === 'null' || value === 'undefined') return null;
    return photoOnCommunity(community, value);
}

/**
 * The chats this member has in `community`, another community this phone holds (slice S1,
 * scratch/fable-design/DESIGN-no-switch-messaging-fable.md §6): read from that community's own copy through a held,
 * read-only handle (utils/held-copies.ts), never through getDb() nor the address in use. Null when there is nothing to
 * show: the copy isn't on the phone, it is the community in use, its copy hasn't synced since it was made or cleared
 * (its cursor gone: an emptied copy reads as no chats), it is at another schema number, or a move or a delete is under way.
 * Every photo is that community's (onCommunity). As fresh as the member's last visit there: nothing syncs a held copy.
 */
export async function getHeldConversations(myPubkey: string, community: string): Promise<HeldConversation[] | null> {
    const file = getDatabaseFilenameForNode(community);
    const { syncedCursorKeyOf } = await import('../services/pillar-sync');
    if (!(await AsyncStorage.getItem(syncedCursorKeyOf(file)))) return null;
    let rows: any[] | null;
    try {
        rows = await heldListRead<any>(community, 'conversations', [myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey]);
    } catch (e) {
        console.warn(`[Held] Could not list the chats held for ${file}`, e);
        return null;
    }
    if (!rows) return null;
    // The keys a DM's other person is known by in THAT file, as Talk's own list has them (getConversations): its rows' keys
    // and its pin's key, former keys and offered key, so a block holds across their re-key (dm-blocked.ts dmPeerKeys).
    // The pins as stored for that file, never seeded from here (no held handle reaches the pin book); none stored, or
    // unreadable: the rows' keys, as getConversations has them when its pins can't be read.
    const pins = await dmPins.peek(myPubkey, file);
    const verified = await dmVerified.read(myPubkey);
    return rows.map((row) => {
        let postPhoto: string | null = null;
        if (row.postPhotos) {
            try {
                const arr = Array.isArray(row.postPhotos) ? row.postPhotos : JSON.parse(row.postPhotos);
                postPhoto = Array.isArray(arr) ? onCommunity(community, arr[0]) : null;
            } catch { postPhoto = null; }
        }
        return {
            id: String(row.id),
            type: row.convType || 'dm',
            postId: row.post_id ?? null,
            postTitle: row.postTitle ?? null,
            postPhoto,
            peer: dmPeerName(row),
            peerAvatar: onCommunity(community, row.otherAvatar),
            peerUpdatedAt: row.otherProfileUpdatedAt || null,
            peerPubkey: row.otherPubkey || null,
            peerKeys: dmPeerKeys(typeof row.otherKeys === 'string' ? row.otherKeys : null, isDmType(row.convType) && pins ? dmPinFor(pins, String(row.id)) : null),
            keyChanged: (row.convType || 'dm') === 'dm' && !!pins && dmEntryWaitsForMember(dmSightFor(pins, String(row.id)), verified),
            rawTimestamp: row.timestamp || null,
            createdAt: row.createdAt || null,
        };
    });
}

/** A held chat's own unread count and newest line's time, as its community's copy has them (getHeldLatest, slice S2b). */
export interface HeldLatest {
    id: string;
    type: string;
    newest: string | null;
    unread: number;
}

/**
 * Each of `community`'s held chats' own unread count and newest line's time (slice S2b): read from that community's own
 * copy through a held, read-only handle, never through getDb() nor the address in use. Null when there is nothing to read
 * (as getHeldConversations). The app icon's badge doesn't add these: it is already the sum of every kept community's own
 * number (other-communities-unread.ts), a held one's included.
 */
export async function getHeldLatest(myPubkey: string, community: string): Promise<HeldLatest[] | null> {
    const file = getDatabaseFilenameForNode(community);
    let rows: any[] | null;
    try {
        const params = [myPubkey, myPubkey, myPubkey, myPubkey, myPubkey];
        rows = await heldCopies.all<any>(file, 'latest', params);
        // A close of this copy under way (a round, a chat in place letting go) waits, then asks once more, as heldListRead.
        if (!rows) { await heldCopies.readsSettled(file); rows = await heldCopies.all<any>(file, 'latest', params); }
    } catch (e) {
        console.warn(`[Held] Could not count the chats held for ${file}`, e);
        return null;
    }
    if (!rows) return null;
    return rows.map((row) => ({ id: String(row.id), type: row.convType || 'dm', newest: row.newest || null, unread: Math.max(0, Number(row.unread) || 0) }));
}

/** The most held direct chats whose newest line Chat opens for a preview (slice S2b): the cost stays ~20 lines at 500 chats. */
export const HELD_PREVIEWS_MAX = 20;

/** A held chat's preview: its newest line's words, or BeanPool's own sentence for it (`fromApp`, translated where shown). */
export interface HeldPreview {
    lastMessage: string;
    lastMessageFromApp: boolean;
}

/**
 * The preview of the newest line of each of `ids` (at most {@link HELD_PREVIEWS_MAX}), direct chats in `community`, another
 * community this phone holds (slice S2b): read through a held, read-only handle, and opened under that file's own pins
 * as stored, read only (dmPins.peek: never seeded, never written, as getHeldConversations reads them). A line the pins
 * can't place shows no preview (null): no pins stored or readable for that file, none for that chat, a line that doesn't
 * open under its pinned key or a former one (never the key on offer: dmShownFormer, S7c's R10 rule), one that isn't
 * encrypted, the admins' or the node's own. Never a wrong one.
 * Null when nothing could be read.
 */
export async function getHeldPreviews(myPubkey: string, community: string, ids: readonly string[]): Promise<Record<string, HeldPreview | null> | null> {
    const file = getDatabaseFilenameForNode(community);
    const asked = [...new Set(ids)].slice(0, HELD_PREVIEWS_MAX);
    if (asked.length === 0) return {};
    let rows: any[] | null;
    try {
        rows = await heldCopies.all<any>(file, 'previews', [JSON.stringify(asked)]);
        // As getHeldLatest: a close under way waits, then one more ask.
        if (!rows) { await heldCopies.readsSettled(file); rows = await heldCopies.all<any>(file, 'previews', [JSON.stringify(asked)]); }
    } catch (e) {
        console.warn(`[Held] Could not read the newest lines held for ${file}`, e);
        return null;
    }
    if (!rows) return null;
    const [identity, pins] = await Promise.all([loadIdentity().catch(() => null), dmPins.peek(myPubkey, file)]);
    // The account the list was read for, or nothing opens (it left the phone, or another signed in, meanwhile).
    const myPriv = identity?.publicKey === myPubkey ? identity.privateKey : null;
    const out: Record<string, HeldPreview | null> = {};
    for (const row of rows) out[String(row.conversationId)] = heldPreviewOf(row, myPriv, pins);
    return out;
}

/** One held DM's newest line as its preview (getHeldPreviews), or null when the pins can't place it. */
function heldPreviewOf(row: any, myPriv: string | null | undefined, pins: DmPeerPins | null): HeldPreview | null {
    const id = String(row.conversationId);
    if (!myPriv || !pins || !row.lastId || isNodeReadableChatType(row.convType)) return null;
    const pin = dmPinFor(pins, id);
    if (!pin?.peer) return null;
    const line = { id: String(row.lastId), authorPubkey: row.lastAuthor, ciphertext: row.lastMessage, nonce: row.lastNonce, type: row.lastMsgType, metadata: row.lastMetadata, timestamp: row.timestamp };
    // A deleted line's fixed text: BeanPool's own words.
    if (dmLineKind(line) === 'tombstone') return { lastMessage: dmLineShownText(checkDmThread([line], null, id).get(line.id)), lastMessageFromApp: true };
    // The former keys a line may open under as words: never the key on offer (dmShownFormer, the R10 rule, as Chat's own
    // list for the community in use: getConversations). A line under it shows no preview until the member continues there.
    const view = checkDmThread([line], { myEdPrivHex: myPriv, peerEdPubHex: pin.peer }, id, dmShownFormer(pin)).get(line.id);
    // Only a line that opened under the pinned key (or a former one) and was signed by its sender: format 4.
    if (!view || view.format !== 4 || view.mark === 'not-verified') return null;
    if (row.lastMsgType === 'voice') return { lastMessage: '🎤 Voice message', lastMessageFromApp: true };
    return { lastMessage: dmLineShownText(view), lastMessageFromApp: false };
}

/** The most held direct chats one refresh brings from their community (slice S2b): one list read, then a page each. */
export const HELD_REFRESH_MAX = 5;
/** How long a refresh waits for that community's list (exported for the test that lets it run out). */
export const HELD_REFRESH_LIST_MS = 10000;

/**
 * What one {@link refreshHeldDms} did: how many chats it brought, and whether it had its answer (`answered`): the
 * community's list answered, or there was nothing there to ask about (not saved, a guest's look, the community in use, no
 * direct chat held). False when Chat was left before the list read, or the list read failed, timed out or was refused:
 * whatever the refresh was for is still to be asked (utils/held-chats.ts notes a number only once answered).
 */
export interface HeldRefresh {
    brought: number;
    answered: boolean;
}

/**
 * Bring `community`'s newest lines into its own copy (slice S2b): the phone is set to another community, and something
 * may wait in that one (Chat: utils/held-chats.ts refreshHeldWhereRose). One signed read of the member's chat list there, at the
 * address the phone saved for it, then, for at most {@link HELD_REFRESH_MAX} direct chats its copy already holds whose
 * newest line there is newer than the copy's, newest first, that chat's poll in place (syncSingleConversation, slice S2's
 * one write path into another community's file, through its copy open in place, closed again here). One at a time, once:
 * no loop, no socket. It stops before the next chat once `still()` is false (Chat left) or another account is on the
 * phone. A switch, a removal or the account leaving mid-way: S2's path writes into that community's file or nowhere
 * (#3300's rule). Nothing for the community in use, one not saved, a guest's look, or an address that isn't plain.
 * The held, read-only handle it reads the copy's newest lines through is Chat's: Chat closes it as it is left, and the
 * refresh's caller closes it again as it ends once Chat was left (held-chats.ts refreshOnce, #3312 review F2).
 */
export async function refreshHeldDms(myPubkey: string, community: string, still: () => boolean = () => true): Promise<HeldRefresh> {
    const nothing = (answered: boolean): HeldRefresh => ({ brought: 0, answered });
    const file = getDatabaseFilenameForNode(community);
    const saved = (await getSavedNodes().catch(() => [])).find((n) => getDatabaseFilenameForNode(n.url) === file);
    if (!saved || !isPlainNodeAddress(saved.url) || await isGuestCopy(saved.url).catch(() => true)) return nothing(true);
    if (getDatabaseFilenameForNode(await AsyncStorage.getItem('beanpool_anchor_url')) === file) return nothing(true);
    const held = await getHeldLatest(myPubkey, saved.url);
    const newestHeld = new Map((held ?? []).filter((c) => c.type === 'dm').map((c) => [c.id, c.newest ?? ''] as const));
    if (!still()) return nothing(false);
    if (newestHeld.size === 0) return nothing(true);
    let listed: unknown[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HELD_REFRESH_LIST_MS);
    try {
        const res = await signedGet(`/api/messages/conversations/${myPubkey}`, { signal: controller.signal, anchorUrl: saved.url });
        if (!res.ok) return nothing(false);
        const body = await res.json();
        listed = Array.isArray(body?.conversations) ? body.conversations : [];
    } catch (e: any) {
        console.warn(`[Held] Could not read the chat list of ${file}: ${e?.message || e}`);
        return nothing(false);
    } finally {
        clearTimeout(timer);
    }
    const due = listed
        .filter((c: any): c is { id: string; lastMessageAt: string } => !!c && c.type === 'dm' && typeof c.id === 'string'
            && newestHeld.has(c.id) && typeof c.lastMessageAt === 'string' && c.lastMessageAt > (newestHeld.get(c.id) ?? ''))
        .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : a.lastMessageAt > b.lastMessageAt ? -1 : 0))
        .slice(0, HELD_REFRESH_MAX)
        .map((c) => c.id);
    if (due.length === 0) return nothing(true);
    let brought = 0;
    // Held in place while it runs, as a chat on screen holds it: the copy open in place closes as the last holder lets go.
    enterChatInPlace(saved.url);
    try {
        for (const id of due) {
            if (!still() || (await loadIdentity().catch(() => null))?.publicKey !== myPubkey) break;
            if (await syncSingleConversation(id, saved.url)) brought++;
        }
    } finally {
        await leaveChatInPlace(saved.url);
    }
    return { brought, answered: true };
}

/**
 * Per-deal action items for the inbox "Action Required" section, now that conversations are
 * consolidated per-person (so action lives at the deal level, not the thread level). Derives
 * from the locally-synced marketplace_transactions + ratings, and resolves each deal to the
 * single per-pair DM thread so the inbox can deep-link into it.
 */
export async function getActionableDeals(myPubkey: string): Promise<any[]> {
    const database = await getDb();
    // The listing joins in for who answers a request (its author) and what kind it is: core's dealStep needs both.
    const rows = await database.getAllAsync<any>(`
        SELECT mt.id as txId, mt.post_id as postId, mt.buyer_pubkey as buyerPubkey,
               mt.seller_pubkey as sellerPubkey, mt.amount_c as amount_c, mt.status as status,
               mt.post_title as postTitle, mt.created_at as createdAt,
               mt.standing_id as standing_id, mt.period_no as period_no, mt.standing as standing,
               p.author_pubkey as postAuthorPublicKey, p.type as postType, p.repeatable as postRepeatable, p.lendable as postLendable,
               (SELECT c.id FROM conversations c
                  WHERE c.type = 'dm' AND c.post_id IS NULL
                    AND EXISTS(SELECT 1 FROM conversation_participants cpa WHERE cpa.conversation_id = c.id AND cpa.public_key = mt.buyer_pubkey)
                    AND EXISTS(SELECT 1 FROM conversation_participants cpb WHERE cpb.conversation_id = c.id AND cpb.public_key = mt.seller_pubkey)
                  LIMIT 1) as conversationId,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = ?) as iRated,
               (CASE WHEN mt.buyer_pubkey = ? THEN mt.seller_pubkey ELSE mt.buyer_pubkey END) as peerPubkey,
               (SELECT memb.callsign FROM members memb WHERE memb.public_key = (CASE WHEN mt.buyer_pubkey = ? THEN mt.seller_pubkey ELSE mt.buyer_pubkey END)) as peerCallsign,
               (SELECT memb.avatar_url FROM members memb WHERE memb.public_key = (CASE WHEN mt.buyer_pubkey = ? THEN mt.seller_pubkey ELSE mt.buyer_pubkey END)) as peerAvatar
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON p.id = mt.post_id
        WHERE (mt.buyer_pubkey = ? OR mt.seller_pubkey = ?)
          AND mt.status IN ('requested', 'pending', 'completed')
        ORDER BY mt.created_at DESC
    `, [myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey]);

    return rows.map(r => {
        const iAmBuyer = r.buyerPubkey === myPubkey;
        // Whose step it is is core's rule, the web list's too (a deal waiting on the other side is no item here).
        return { ...r, iAmBuyer, action: dealAction(r, myPubkey) };
    }).filter(d => d.action && d.conversationId);
}

/**
 * All trades (any status) between me and one peer — powers the consolidated thread's pinned
 * "active deals" strip and lets the timeline label each escrow event by item.
 */
export async function getDealsBetween(myPubkey: string, peerPubkey: string, community?: ChatCommunity): Promise<any[]> {
    // `community`: a chat in place, whose deals are its own community's, read from that community's copy (slice S6c).
    const database = await chatDbFor(community);
    const rows = await database.getAllAsync<any>(`
        SELECT mt.id as txId, mt.post_id as postId, mt.post_title as postTitle, mt.amount_c as amount_c, mt.hours as hours, mt.item_option as item_option,
               mt.status as status, mt.buyer_pubkey as buyerPubkey, mt.seller_pubkey as sellerPubkey, mt.created_at as createdAt,
               mt.standing_id as standing_id, mt.period_no as period_no, mt.standing as standing,
               mt.rated_by_buyer as ratedByBuyer, mt.rated_by_seller as ratedBySeller,
               p.author_pubkey as postAuthorPublicKey, p.type as postType, p.repeatable as postRepeatable, p.lendable as postLendable,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = ?) as iRated
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON p.id = mt.post_id
        WHERE (mt.buyer_pubkey = ? AND mt.seller_pubkey = ?)
           OR (mt.buyer_pubkey = ? AND mt.seller_pubkey = ?)
        ORDER BY mt.created_at DESC
    `, [myPubkey, myPubkey, peerPubkey, peerPubkey, myPubkey]);
    return rows.map(({ ratedByBuyer, ratedBySeller, ...r }) => {
        const iAmBuyer = r.buyerPubkey === myPubkey;
        // In place the node's own flag counts too: that copy may not hold a rating made since the phone was last set there.
        return { ...r, iAmBuyer, iRated: !!r.iRated || (!!community && !!(iAmBuyer ? ratedByBuyer : ratedBySeller)) };
    });
}

// Throttle server-side read-cursor pushes: chat screens call markConversationRead on
// every poll tick; one POST per conversation per 10s is plenty for read receipts.
const _lastReadPushAt: Record<string, number> = {};

/**
 * When the oldest line still unread here arrived (someone else's, counted as the badge counts: core countsAsUnreadSql), read
 * before the chat marks itself read, for the fact line "This waited 2 days for you." (slice N3, core notifyWaitedDays). Null:
 * nothing unread. The same copy the read marker uses (in place: that community's). Never throws.
 */
export async function oldestUnreadAt(conversationId: string, myPubkey: string, community?: ChatCommunity): Promise<string | null> {
    try {
        const copy = await chatReadFor(community);
        if (copy.inPlace && !(await heldAsDmThrough(copy.database, conversationId))) return null;
        const row = await copy.database.getFirstAsync<{ at: string | null }>(
            `SELECT MIN(m.timestamp) AS at FROM messages m
             JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.public_key = ?
             WHERE m.conversation_id = ?
               AND m.author_pubkey != ?
               AND m.timestamp > IFNULL(cp.last_read_at, '2000-01-01')
               AND ${countsAsUnreadSql('m')}`,
            [myPubkey, conversationId, myPubkey, myPubkey],
        );
        return typeof row?.at === 'string' ? row.at : null;
    } catch {
        return null;
    }
}

/** The phone's own read marker (the Talk tab's badge counts from it); no request. */
export async function markConversationReadLocally(conversationId: string, myPubkey: string, community?: ChatCommunity) {
    const copy = await chatReadFor(community);
    // In place, only a direct chat that community's copy holds (#3305 review F1): nothing marked for any other id.
    if (copy.inPlace && !(await heldAsDmThrough(copy.database, conversationId))) return;
    const database = copy.database;
    const hasUnread = await database.getFirstAsync<{ id: string }>(
        `SELECT m.id FROM messages m
         JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.public_key = ?
         WHERE m.conversation_id = ?
           AND m.author_pubkey != ?
           AND m.timestamp > IFNULL(cp.last_read_at, '2000-01-01')
         LIMIT 1`,
        [myPubkey, conversationId, myPubkey]
    );
    if (!hasUnread) return;

    const now = new Date().toISOString();
    await database.runAsync(
        'UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ?',
        [now, conversationId, myPubkey]
    );
    emitAppEvent(CONVERSATION_READ_LOCALLY_EVENT, { conversationId, myPubkey });
}

export async function markConversationRead(conversationId: string, myPubkey: string, community?: ChatCommunity) {
    await markConversationReadLocally(conversationId, myPubkey, community);

    // Push the read cursor to the server so the PEER's device can render the
    // double-tick. Without this the receipt loop never leaves this phone. A chat open in place: to its own community.
    const lastPush = _lastReadPushAt[conversationId] || 0;
    if (Date.now() - lastPush > 10_000) {
        _lastReadPushAt[conversationId] = Date.now();
        chatCopyForRequest(community)
            .then((here) => onlyDmInPlace(here, conversationId))
            .then((here) => _signedRequest('/api/messages/mark-read', { pubkey: myPubkey, conversationId }, here.anchorUrl))
            .catch(() => { _lastReadPushAt[conversationId] = 0; /* offline — retry on next call */ });
    }
}

export async function getGlobalUnreadCount(myPubkey: string): Promise<number> {
    const database = await getDb();
    const result = await database.getFirstAsync<any>(`
        SELECT COUNT(m.id) as count
        FROM messages m
        JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE cp.public_key = ?
        AND (c.type IS NULL OR c.type != 'enterprise_thread')
        AND m.author_pubkey != ?
        AND (m.timestamp > IFNULL(cp.last_read_at, '2000-01-01'))
        AND ${NOT_A_REQUEST_FOR_ME('c.request')}
        AND ${COUNTS_AS_UNREAD_SQL}
    `, [myPubkey, myPubkey, myPubkey, myPubkey]);
    return result?.count || 0;
}

/**
 * Each of `peers`' read cursor in the one DM this phone holds with them, for a deal request that sits unseen (core
 * notSeenOfDeal, slice N4): a peer with a DM here maps to their cursor (null: never read); one with no DM is left out, as
 * there is no tick to go by. So is a chat that is still a message request, either way: the node withholds the other's
 * cursor until it is accepted (engine/dm-requests.ts), so a cursor there says nothing. The node keeps one DM per pair, so
 * the newest cursor is theirs. Only the cursor, the tick's own source: nothing else of theirs is read.
 */
export async function peerReadCursors(myPubkey: string, peers: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const wanted = [...new Set(peers.filter((p) => !!p && p !== myPubkey))];
    if (!myPubkey || wanted.length === 0) return out;
    const database = await getDb();
    const rows = await database.getAllAsync<{ public_key: string; read_at: string | null }>(`
        SELECT cp.public_key AS public_key, MAX(cp.last_read_at) AS read_at
        FROM conversation_participants cp
        JOIN conversations c ON c.id = cp.conversation_id
        WHERE (c.type IS NULL OR c.type = 'dm')
        AND (CASE WHEN json_valid(c.request) THEN (CASE WHEN json_type(c.request, '$.state') = 'text'
            AND json_extract(c.request, '$.state') != 'accepted' THEN 0 ELSE 1 END) ELSE 1 END) = 1
        AND cp.public_key IN (${wanted.map(() => '?').join(', ')})
        AND EXISTS (SELECT 1 FROM conversation_participants mine WHERE mine.conversation_id = c.id AND mine.public_key = ?)
        GROUP BY cp.public_key
    `, [...wanted, myPubkey]);
    for (const r of rows) out.set(r.public_key, r.read_at ?? null);
    return out;
}

/**
 * When the member's own line was sent, in each of their chats where it is the newest line (a system line doesn't count),
 * for Home's notifications card (slice N3, core `notifyLive` `waitingAt`: they wait on an answer). Only lines from the last
 * `NOTIFY_WAITING_DAYS`; read from this phone alone, nothing decrypted. Never throws: an empty list.
 */
export async function getMyLinesWaiting(myPubkey: string, now: number = Date.now()): Promise<string[]> {
    try {
        const database = await getDb();
        const since = new Date(now - NOTIFY_WAITING_DAYS * 86_400_000).toISOString();
        const rows = await database.getAllAsync<{ at: string | null }>(`
            SELECT m.timestamp AS at FROM messages m
            WHERE m.author_pubkey = ? AND COALESCE(m.type, '') != 'system' AND m.timestamp > ?
              AND m.conversation_id IN (SELECT conversation_id FROM conversation_participants WHERE public_key = ?)
              AND NOT EXISTS (
                  SELECT 1 FROM messages n
                  WHERE n.conversation_id = m.conversation_id AND COALESCE(n.type, '') != 'system' AND n.timestamp > m.timestamp
              )
        `, [myPubkey, since, myPubkey]);
        return rows.map(r => r.at).filter((at): at is string => typeof at === 'string');
    } catch {
        return [];
    }
}

/**
 * Unread lines per conversation, for the header's "needs you" icons: only conversations with something
 * unread, counted the way getGlobalUnreadCount counts them. Nothing is decrypted and no preview is built;
 * `peer` is the stored conversation name or the other participant's callsign, as the inbox shows it.
 */
export async function getUnreadByConversation(myPubkey: string): Promise<{ id: string; type: string; unread: number; peer: string }[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<any>(`
        SELECT c.id, c.type, c.name, COUNT(m.id) as unread,
               ${otherParticipantSql('callsign')} as otherCallsign,
               ${otherParticipantSql('public_key')} as otherPubkey
        FROM conversation_participants cp
        JOIN conversations c ON c.id = cp.conversation_id
        JOIN messages m ON m.conversation_id = c.id
        WHERE cp.public_key = ?
        AND (c.type IS NULL OR c.type != 'enterprise_thread')
        AND m.author_pubkey != ?
        AND (m.timestamp > IFNULL(cp.last_read_at, '2000-01-01'))
        AND ${NOT_A_REQUEST_FOR_ME('c.request')}
        AND ${COUNTS_AS_UNREAD_SQL}
        GROUP BY c.id
    `, [myPubkey, myPubkey, myPubkey, myPubkey, myPubkey, myPubkey]);
    return rows.map(r => ({
        id: r.id,
        type: r.type || 'dm',
        unread: r.unread || 0,
        // As Talk's list and the thread's header name it (dm-blocked.ts dmPeerName): never the conversation's id.
        peer: dmPeerName(r),
    }));
}

/** The node's own balance read (GET /api/ledger/balance), as it answered: what a standing take-up's room is read from. */
export type NodeBalanceRead = {
    // Whole hundredths of a Bean (@beanpool/core hundredths.ts), as the node sends them.
    balance_c?: number | null; floor_c?: number | null; usableFloor_c?: number | null;
    [field: string]: unknown;
};

/** A money field of the node's answer as this phone keeps it: whole hundredths, or null (shown "—", never a number). */
const hundredthsOrNull = (v: unknown): number | null => (isHundredths(v) ? v : null);

/** What a deal holds as this phone keeps it (marketplace_transactions.amount_c): the node's whole hundredths, or null. */
const dealAmountColumn = (tx: any): number | null => (isHundredths(tx?.amount_c) && tx.amount_c >= 0 ? tx.amount_c : null);

/** A per-item deal's way as this phone keeps it (marketplace_transactions.item_option): the node's 'each' or 'lot', else null. */
const itemOptionColumn = (tx: any): 'each' | 'lot' | null => {
    const v = tx?.itemOption ?? tx?.item_option;
    return v === 'each' || v === 'lot' ? v : null;
};

/**
 * One of the node's own deal rows (GET /api/marketplace/transactions) written into a copy of that community's: the sync's
 * (applyDelta) and a chat in place's read of its own community ({@link syncDealsBetween}) keep a deal by this one rule.
 */
async function writeNodeDeal(txn: SQLite.SQLiteDatabase, tx: any): Promise<void> {
    const incomingStatus = tx.status ?? 'pending';
    
    // Guard: Never downgrade a terminal status (completed/cancelled) back to pending/requested.
    // This prevents a stale sync payload from reverting a transaction the user just completed locally.
    const localRow = await txn.getFirstAsync<{ status: string }>('SELECT status FROM marketplace_transactions WHERE id = ?', [tx.id]);
    if (localRow) {
        const terminalStates = ['completed', 'cancelled'];
        const nonTerminalStates = ['pending', 'requested'];
        if (terminalStates.includes(localRow.status) && nonTerminalStates.includes(incomingStatus)) {
            console.log(`[DB] Skipping downgrade of tx ${tx.id}: local=${localRow.status}, incoming=${incomingStatus}`);
            return;
        }
    }

    await txn.runAsync(
        'INSERT OR REPLACE INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, hours, status, created_at, completed_at, cover_image, rated_by_buyer, rated_by_seller, post_title, standing_id, period_no, standing, item_option) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            tx.id ?? null,
            tx.postId ?? tx.post_id ?? null,
            tx.buyerPublicKey ?? tx.buyerPubkey ?? tx.buyer_pubkey ?? null,
            tx.sellerPublicKey ?? tx.sellerPubkey ?? tx.seller_pubkey ?? null,
            // What the deal holds, whole hundredths (the node's amount_c); anything else, no figure (shown "—").
            dealAmountColumn(tx),
            tx.hours ?? null,
            incomingStatus,
            tx.createdAt ?? tx.created_at ?? new Date().toISOString(),
            tx.completedAt ?? tx.completed_at ?? null,
            tx.coverImage ?? tx.cover_image ?? null,
            tx.ratedByBuyer ? 1 : 0,
            tx.ratedBySeller ? 1 : 0,
            tx.postTitle ?? tx.post_title ?? null,
            // The node's read carries the standing deal on its current period's row (S2): a short one's row is
            // the period last settled, so its phase is kept on that row, not on a pending one.
            tx.standingId ?? null,
            tx.periodNo ?? null,
            standingJsonOf(tx),
            itemOptionColumn(tx),
        ]
    );

    // Heal corresponding post status to match terminal transaction status
    const associatedPostId = tx.postId ?? tx.post_id;
    if (associatedPostId && (incomingStatus === 'completed' || incomingStatus === 'cancelled')) {
        const postRow = await txn.getFirstAsync<{ repeatable: number; price_type: string | null }>('SELECT repeatable, price_type FROM posts WHERE id = ?', [associatedPostId]);
        if (postRow && postRow.price_type === 'each') {
            // A listing priced for each one is never a one-off, and its status is the node's alone: one deal taking some
            // of the units leaves the rest on offer, and a deal that comes back (cancelled) changes nothing about it, so a
            // paused listing stays paused and a sold-out one stays sold out (settleItemDeal). The node closes it itself when
            // the count reaches 0 and moves updated_at whenever a count comes back, so the same delta brings the post with
            // its true count and status; writing a status here, from a deal list that holds every deal on it, would put a
            // sold-out or paused listing back on the Market, or close one with units left.
        } else if (incomingStatus === 'completed') {
            if (postRow && postRow.repeatable !== 1) {
                await txn.runAsync("UPDATE posts SET status = 'completed', active = 0 WHERE id = ?", [associatedPostId]);
            } else if (postRow && postRow.repeatable === 1) {
                await txn.runAsync("UPDATE posts SET status = 'active', accepted_by = NULL, pending_transaction_id = NULL WHERE id = ?", [associatedPostId]);
            }
        } else {
            await txn.runAsync("UPDATE posts SET status = 'active', accepted_by = NULL, pending_transaction_id = NULL WHERE id = ?", [associatedPostId]);
        }
    }
}

/**
 * Reads the member's balance from the node, keeps it on the phone, and answers the node's figures; null when the node
 * couldn't be read (no node, refused, offline), so a caller never takes the phone's cached copy for a fresh read. Every
 * figure is whole hundredths of a Bean (`*_c`); one that isn't is not kept.
 */
export async function refreshBalanceFromServer(pubkey: string): Promise<NodeBalanceRead | null> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) return null;
    try {
        const res = await fetch(`${anchorUrl}/api/ledger/balance/${pubkey}`);
        if (!res.ok) return null;
        const balData = await res.json();
        const database = await getDb();
        const commons = await database.getFirstAsync<any>("SELECT balance_c FROM accounts WHERE public_key = 'COMMONS' OR public_key = 'commons'");
        const row = await database.getFirstAsync<any>('SELECT balance_c, last_demurrage_epoch FROM accounts WHERE public_key = ?', [pubkey]);

        let changed = false;
        await acquireSyncLock();
        try {
            if (isHundredths(balData.balance_c)) {
                if (balData.balance_c !== (row?.balance_c ?? 0)) changed = true;
                await database.runAsync(
                    'INSERT OR REPLACE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, ?, ?)',
                    [pubkey, balData.balance_c, balData.last_demurrage_epoch || 0]
                );
            }
            if (isHundredths(balData.commonsBalance_c)) {
                if (balData.commonsBalance_c !== (commons?.balance_c ?? 0)) changed = true;
                await database.runAsync(
                    'INSERT OR REPLACE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, ?, ?)',
                    ['COMMONS', balData.commonsBalance_c, 0]
                );
            }
        } finally {
            releaseSyncLock();
        }

        if (balData.tier || balData.floor_c !== undefined) {
            const tier = { name: TIER_LEVELS[0].name, emoji: TIER_LEVELS[0].emoji };
            // No baked-in credit: a floor is only ever what the node reports (0 until it does). Every figure in hundredths;
            // `grantedCredit` and `qualifiedValue` keep their names on the node and carry hundredths (M1).
            const floor_c = isHundredths(balData.floor_c) ? balData.floor_c : 0;
            const newTierStr = JSON.stringify({
                tier: balData.tier || tier,
                floor_c,
                tierCredit_c: hundredthsOrNull(balData.tierCredit_c),
                earnedCredit_c: hundredthsOrNull(balData.earnedCredit_c) ?? 0,
                grantedCredit_c: hundredthsOrNull(balData.grantedCredit) ?? 0,
                qualifiedValue_c: hundredthsOrNull(balData.qualifiedValue) ?? 0,
                avgRating: balData.avgRating ?? 0,
                reviewCount: balData.reviewCount ?? 0,
                trustStats: balData.trustStats ?? null,
                isBlockedFromTrading: !!balData.isBlockedFromTrading,
                canOperate: !!balData.canOperate,
                keeperOf: Array.isArray(balData.keeperOf) ? balData.keeperOf : [],
                isTreasury: !!balData.isTreasury,
                activated: !!balData.activated,
                hasLiveOffer: !!balData.hasLiveOffer,
                usableFloor_c: hundredthsOrNull(balData.usableFloor_c) ?? floor_c,
                liveOffers: balData.liveOffers ?? 0,
                knownGrant_c: hundredthsOrNull(balData.knownGrant_c) ?? 0,
                roomHeld_c: hundredthsOrNull(balData.roomHeld_c) ?? 0,
                frozen: !!balData.frozen,
                knownFrozen: balData.knownFrozen === true,
                creditFrozen: balData.creditFrozen === true,
                vouchedBy: Array.isArray(balData.vouchedBy) ? balData.vouchedBy : [],
            });
            const prevTierStr = await AsyncStorage.getItem(`bp_tier_${pubkey}`);
            if (prevTierStr !== newTierStr) {
                await AsyncStorage.setItem(`bp_tier_${pubkey}`, newTierStr);
                changed = true;
            }
        }
        if (changed) {
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('sync_data_updated');
        }
        return balData && typeof balData === 'object' ? balData as NodeBalanceRead : null;
    } catch (e) {
        console.warn(`[refreshBalanceFromServer] Failed for ${pubkey}:`, e);
        return null;
    }
}

/**
 * The member's balance as this phone holds it, with what the node last said of their line (kept by
 * refreshBalanceFromServer). Every money figure is whole hundredths of a Bean (`*_c`); a cache from before them (its fields
 * named without `_c`) reads as nothing known, never as hundredths.
 */
export async function getBalance(pubkey: string) {
    const database = await getDb();
    const row = await database.getFirstAsync<any>('SELECT balance_c, last_demurrage_epoch FROM accounts WHERE public_key = ?', [pubkey]);
    const commons = await database.getFirstAsync<any>("SELECT balance_c FROM accounts WHERE public_key = 'COMMONS' OR public_key = 'commons'");

    // Store enriched data from server response
    let tier: { name: string; emoji: string } = { name: TIER_LEVELS[0].name, emoji: TIER_LEVELS[0].emoji };

    let floor_c = 0;     // no baked-in credit until the node reports one
    let tierCredit_c: number | null = null; // the credit the node read `tier` from; null from an older node (memberLevel)
    let earnedCredit_c = 0;
    let grantedCredit_c = 0;
    let qualifiedValue_c = 0;
    let avgRating = 0;
    let reviewCount = 0;
    let isBlockedFromTrading = false;
    let canOperate = false;    // this member keeps SOMETHING — shows the keeper layer at all
    let keeperOf: string[] = []; // #106: the specific enterprises they may drive — gate per-card on this
    let isTreasury = false;    // this account IS a community treasury, not a person
    let activated = false;     // has a credit line at all (earned/granted/known)
    let hasLiveOffer = false;  // has ≥1 live Offer posted (offer covenant)
    let usableFloor_c: number | undefined = undefined; // v3: offer-gated usable floor (≤ earned floor)
    let liveOffers = 0;        // v3: count of live Offers (drives the credit ladder)
    let knownGrant_c = 0;      // the known floor's part of the limit (one live offer unlocks it); 0 from an older node
    let roomHeld_c = 0;        // the credit line a vouch or a member's gift gave (one live offer unlocks it)
    let frozen = false;        // v3: debt below usable floor → spending paused
    let knownFrozen = false;   // the community's admins froze this member's known floor (utils/credit-line-card.ts)
    let creditFrozen = false;  // … or their whole line (the manager's Freeze)
    let vouchedBy: any[] = [];
    // The node's figures for the line are on this phone (refreshBalanceFromServer kept them). False on a first open: the
    // line is then not known yet, never "no credit line" (the Ledger's card waits for it, round 2 of #3134).
    let lineKnown = false;

    // Background fetch to ensure parity
    refreshBalanceFromServer(pubkey).catch(() => null);

    // Try to load cached tier data
    let trustStats: any = null;
    try {
        const cached = await AsyncStorage.getItem(`bp_tier_${pubkey}`);
        if (cached) {
            const parsed = JSON.parse(cached);
            tier = parsed.tier || tier;
            floor_c = hundredthsOrNull(parsed.floor_c) ?? floor_c;
            tierCredit_c = hundredthsOrNull(parsed.tierCredit_c);
            earnedCredit_c = hundredthsOrNull(parsed.earnedCredit_c) ?? 0;
            grantedCredit_c = hundredthsOrNull(parsed.grantedCredit_c) ?? 0;
            qualifiedValue_c = hundredthsOrNull(parsed.qualifiedValue_c) ?? 0;
            avgRating = parsed.avgRating ?? 0;
            reviewCount = parsed.reviewCount ?? 0;
            trustStats = parsed.trustStats ?? null;
            isBlockedFromTrading = !!parsed.isBlockedFromTrading;
            canOperate = !!parsed.canOperate;
            keeperOf = Array.isArray(parsed.keeperOf) ? parsed.keeperOf : [];
            isTreasury = !!parsed.isTreasury;
            activated = !!parsed.activated;
            hasLiveOffer = !!parsed.hasLiveOffer;
            usableFloor_c = hundredthsOrNull(parsed.usableFloor_c) ?? floor_c;
            liveOffers = parsed.liveOffers ?? 0;
            knownGrant_c = hundredthsOrNull(parsed.knownGrant_c) ?? 0;
            roomHeld_c = hundredthsOrNull(parsed.roomHeld_c) ?? 0;
            frozen = !!parsed.frozen;
            knownFrozen = parsed.knownFrozen === true;
            creditFrozen = parsed.creditFrozen === true;
            vouchedBy = Array.isArray(parsed.vouchedBy) ? parsed.vouchedBy : [];
            // A cache from before hundredths has no `floor_c`: the line is not known from it.
            lineKnown = hundredthsOrNull(parsed.floor_c) !== null;
        }
    } catch { /* ignore */ }

    return {
        balance_c: hundredthsOrNull(row?.balance_c) ?? 0,
        floor_c,
        tier,
        tierCredit_c,
        earnedCredit_c,
        grantedCredit_c,
        qualifiedValue_c,
        avgRating,
        reviewCount,
        trustStats,
        commons_c: hundredthsOrNull(commons?.balance_c) ?? 0,
        isBlockedFromTrading,
        canOperate,
        keeperOf,
        isTreasury,
        activated,
        hasLiveOffer,
        usableFloor_c: usableFloor_c ?? floor_c,
        liveOffers,
        knownGrant_c,
        roomHeld_c,
        frozen,
        knownFrozen,
        creditFrozen,
        vouchedBy,
        lineKnown,
    };
}

export async function getTransactions(pubkey: string) {
    const database = await getDb();
    
    // Background fetch to ensure quick sync of newly released Escrow credits
    const { DeviceEventEmitter } = require('react-native');
    AsyncStorage.getItem('beanpool_anchor_url').then(async (anchorUrl: string | null) => {
        if (!anchorUrl) return;
        try {
            const res = await fetch(`${anchorUrl}/api/ledger/transactions?publicKey=${pubkey}&limit=20`);
            if (res.ok) {
                const txns = await res.json();
                if (Array.isArray(txns) && txns.length > 0) {
                    let newInserted = false;
                    await acquireSyncLock();
                    try {
                        await database.withTransactionAsync(async () => {
                            for (const t of txns) {
                                // Whole hundredths above 0 (the node's amount_c), or the row isn't kept: never a guessed figure.
                                if (!isHundredths(t.amount_c) || t.amount_c <= 0) continue;
                                try {
                                    const result = await database.runAsync(
                                        'INSERT OR IGNORE INTO transactions (id, from_pubkey, to_pubkey, amount_c, fee_c, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
                                        [t.id, t.from_pubkey || t.from, t.to_pubkey || t.to, t.amount_c, isHundredths(t.fee_c) ? t.fee_c : 0, t.memo, t.timestamp]
                                    );
                                    if (result.changes > 0) newInserted = true;
                                } catch(e) {}
                            }
                        });
                    } finally {
                        releaseSyncLock();
                    }
                    if (newInserted) {
                        DeviceEventEmitter.emit('sync_data_updated');
                    }
                }
            }
        } catch(e) {}
    });

    const rows = await database.getAllAsync<any>(`
        SELECT t.*, 
               CASE WHEN t.from_pubkey = ? THEN t.to_pubkey ELSE t.from_pubkey END as peer_pubkey,
               CASE WHEN t.to_pubkey = ? THEN 'credit' ELSE 'debit' END as type,
               m_peer.callsign as peer_callsign,
               mt.post_title,
               mt.id as deal_id,
               mt.post_id as deal_post_id,
               mt.buyer_pubkey,
               mt.seller_pubkey,
               mb.callsign as buyer_callsign,
               ms.callsign as seller_callsign
        FROM transactions t
        LEFT JOIN members m_peer ON (
            CASE WHEN t.from_pubkey = ? THEN t.to_pubkey ELSE t.from_pubkey END = m_peer.public_key
        )
        LEFT JOIN marketplace_transactions mt ON (
            (t.to_pubkey LIKE 'escrow_%' AND mt.id = SUBSTR(t.to_pubkey, 8)) OR
            (t.from_pubkey LIKE 'escrow_%' AND mt.id = SUBSTR(t.from_pubkey, 8)) OR
            (t.to_pubkey LIKE 'escrow_%' AND mt.post_id = SUBSTR(t.to_pubkey, 8)) OR
            (t.from_pubkey LIKE 'escrow_%' AND mt.post_id = SUBSTR(t.from_pubkey, 8))
        )
        LEFT JOIN members mb ON mt.buyer_pubkey = mb.public_key
        LEFT JOIN members ms ON mt.seller_pubkey = ms.public_key
        WHERE t.from_pubkey = ? OR t.to_pubkey = ?
        ORDER BY t.timestamp DESC
        LIMIT 50
    `, [pubkey, pubkey, pubkey, pubkey, pubkey, pubkey, pubkey]);
    
    return rows.map(row => {
        let peerName = row.peer_pubkey.slice(0, 8).toUpperCase();
        // A hold's name as parts too: the Ledger tab writes it in the member's language from them (app/(tabs)/ledger.tsx
        // peerWords); `peer` stays the English.
        // `dealId` and `postId` are the deal this hold belongs to, when this phone has it: the Ledger row opens it.
        let held: { title: string | null; counterparty: string | null; toCounterparty: boolean; dealId?: string | null; postId?: string | null } | null = null;
        if (row.peer_pubkey.startsWith('escrow_')) {
            peerName = 'Held in Trust';
            held = { title: null, counterparty: null, toCounterparty: false };
            if (row.post_title) {
                const isBuyer = pubkey === row.buyer_pubkey;
                const counterparty = isBuyer ? row.seller_callsign : row.buyer_callsign;
                held = { title: row.post_title, counterparty: counterparty || null, toCounterparty: isBuyer, dealId: row.deal_id ?? null, postId: row.deal_post_id ?? null };
                if (counterparty) {
                    peerName = `Held in Trust: ${row.post_title} (${isBuyer ? 'to' : 'from'} ${counterparty})`;
                } else {
                    peerName = `Held in Trust: ${row.post_title}`;
                }
            }
        } else if (row.peer_pubkey.startsWith('project_')) {
            peerName = 'Project Wallet';
        } else if (row.peer_callsign) {
            peerName = row.peer_callsign;
        }
        
        let displayMemo = row.memo || '';
        displayMemo = displayMemo
            .replace(/escrow hold/gi, 'Held in trust')
            .replace(/escrow/gi, 'trust');

        return {
            id: row.id,
            type: row.type,
            // Whole hundredths of a Bean, as the node keeps them (amount_c left the payer; fee_c went to the Commons).
            amount_c: row.amount_c,
            fee_c: row.fee_c || 0,
            peer: peerName,
            // The other account's key: the Ledger tab shows Beans from someone blocked on this phone without their note
            // (utils/ledger-note.ts).
            peerPubkey: row.peer_pubkey,
            held,
            projectWallet: row.peer_pubkey.startsWith('project_'),
            timestamp: new Date(row.timestamp).toLocaleDateString(),
            // The node's time as it came, for the Ledger tab's date in the member's language (core's formatDate).
            at: row.timestamp,
            memo: displayMemo
        };
    });
}

export async function getMemberProfile(pubkey: string) {
    const database = await getDb();
    return await database.getFirstAsync<any>('SELECT * FROM members WHERE public_key = ?', [pubkey]);
}

/**
 * Ask a node for the callsign registered to a public key. The key IS the
 * identity; the callsign is just node-held profile data that travels with it, so
 * recovery pulls it down rather than asking the user to type it. Best-effort —
 * returns null when the node is unreachable or doesn't know the key (the full
 * profile, incl. avatar, then lands with the normal members-directory sync).
 * Uses the allowlisted pre-membership probe so it works before we're synced in, signed with
 * the key being restored (`privateKey`): a community names a key only to that key's own
 * signer (apps/server routes/community.ts), and the key is not saved on the phone yet, so
 * the phone's signing wrapper (node-request-signing.ts) cannot sign it.
 */
export async function fetchNodeCallsign(anchorUrl: string, pubkey: string, privateKey?: string): Promise<string | null> {
    try {
        if (!anchorUrl || anchorUrl === 'Detecting...' || !pubkey) return null;
        const cleanUrl = anchorUrl.replace(/\/+$/, '');
        if (shouldBlockCleartextNodeUrl(cleanUrl)) return null;

        const url = `${cleanUrl}/api/community/membership/${pubkey}`;
        let privKey = privateKey;
        if (!privKey) {
            const id = await (await import('./identity')).loadIdentity().catch(() => null);
            if (id?.publicKey && id.publicKey.toLowerCase() === pubkey.toLowerCase()) {
                privKey = id.privateKey;
            }
        }
        if (!privKey) return null;

        const signed = await buildSignedHeaders('GET', url, '', privKey, pubkey);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(url, {
                headers: { ...signed, Accept: 'application/json' },
                signal: controller.signal,
            });
            if (!res.ok) return null;
            const data = await res.json();
            const callsign = data?.callsign;
            return typeof callsign === 'string' && callsign.trim().length > 0 ? callsign.trim() : null;
        } finally {
            clearTimeout(timeout);
        }
    } catch {
        return null;
    }
}

/**
 * Viewer-aware Trust Profile for another member: tier, track record, completion
 * rate, mutual connections, "invited by", and a safety recommendation band.
 * Signed (the server uses the verified signer as the viewer for mutuals).
 * Returns null when off-grid or the member/endpoint is unavailable.
 */
export async function getTrustProfile(targetPubkey: string): Promise<any | null> {
    try {
        return await _signedRequest('/api/trust/profile', { targetPubkey });
    } catch (e) {
        return null;
    }
}

export async function getAllCommunityMembers(): Promise<{ publicKey: string; callsign: string }[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<any>("SELECT public_key, callsign FROM members WHERE status IS NULL OR status != 'pruned' ORDER BY callsign COLLATE NOCASE ASC");
    return rows.map(r => ({ publicKey: r.public_key, callsign: r.callsign }));
}

/**
 * A send of `amount_c` (whole hundredths of a Bean, above 0: the member's typed figure through core parseHundredths) to
 * `to`. The signed body carries the integer exactly (`{ from, to, amount_c, memo }`), as the node takes it (money-body.ts).
 */
export async function sendTransfer(from: string, to: string, amount_c: number, memo: string) {
    const res = await _signedRequest('/api/ledger/transfer', { from, to, amount_c, memo });

    // Write new transaction and refresh balances
    try {
        const database = await getDb();

        // 1. Insert transaction into local DB so it shows up instantly
        const t = res?.transaction;
        if (t && isHundredths(t.amount_c) && t.amount_c > 0) {
            const fromKey = t.from_pubkey || t.from || null;
            const toKey = t.to_pubkey || t.to || null;
            await database.runAsync(
                'INSERT OR REPLACE INTO transactions (id, from_pubkey, to_pubkey, amount_c, fee_c, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [t.id || null, fromKey, toKey, t.amount_c, isHundredths(t.fee_c) ? t.fee_c : 0, t.memo || null, t.timestamp || null]
            );
        }

        // 2. Refresh both parties' balances from server
        refreshBalanceFromServer(from).catch(() => null);
        refreshBalanceFromServer(to).catch(() => null);
        
        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('transaction_completed');
        DeviceEventEmitter.emit('sync_data_updated');
    } catch (e) {
        console.warn('[Transfer] Transaction save / balance refresh failed:', e);
    }
    
    return res;
}

export async function updateMemberProfile(pubkey: string, data: { callsign: string, avatar_url?: string | null, bio?: string, contact_value?: string, contact_visibility?: string, archetype?: string | null }) {
    const database = await getDb();
    
    // UPSERT basically because they might not exist locally yet if they haven't synced their own genesis block
    await database.runAsync(`
        INSERT INTO members (public_key, callsign, avatar_url, bio, contact_value, contact_visibility, archetype)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(public_key) DO UPDATE SET
            callsign = excluded.callsign,
            avatar_url = COALESCE(excluded.avatar_url, members.avatar_url),
            bio = COALESCE(excluded.bio, members.bio),
            contact_value = COALESCE(excluded.contact_value, members.contact_value),
            contact_visibility = COALESCE(excluded.contact_visibility, members.contact_visibility),
            archetype = COALESCE(excluded.archetype, members.archetype)
    `, [pubkey, data.callsign, data.avatar_url || null, data.bio || null, data.contact_value || null, data.contact_visibility || null, data.archetype !== undefined ? data.archetype : null]);

    // Mirror the user's OWN profile into the canonical (node-independent) store
    // so it can be re-published to any other node they join. Guarded to the
    // active identity so a sync writing another member's row can never clobber
    // it. Merge-save: only fields present in this update are touched.
    try {
        const self = await loadIdentity();
        if (self && self.publicKey === pubkey) {
            // NEVER mirror a non-portable value. The canonical store is the only copy of the
            // photo that is not tied to a node, so writing the node's own `/api/avatar/…` URL
            // into it — which callers do whenever they rebuild the profile row from a synced
            // local row, e.g. the archetype quiz — destroyed the picture device-wide and
            // handed the broken string to the next node the member joined. `undefined` leaves
            // the stored avatar alone, because saveCanonicalProfile merges on `!== undefined`.
            //
            // This also stops an explicit `avatar_url: null` from clearing canonical. That is
            // deliberate: no caller in the app clears an avatar on purpose (the picker always
            // sets one), and every null that reaches here today comes from a caller rebuilding
            // the row with `?? null` — which is how the quiz path wiped it. Refusing to destroy
            // the device's only portable copy is the safer reading of an ambiguous null.
            const portablePhoto = isPortableAvatarValue(data.avatar_url);
            // Where it was set, only to name that community when the photo is offered on joining another (Profile S3).
            let photoSetIn: string | undefined;
            if (portablePhoto) {
                try { photoSetIn = (await AsyncStorage.getItem('beanpool_anchor_url')) ?? undefined; } catch { /* a name for the offer, never needed */ }
            }
            await saveCanonicalProfile({
                avatar: portablePhoto ? data.avatar_url : undefined,
                // A new photo always writes its community, `null` when the phone has none: undefined would keep the OLD photo's
                // community beside the new photo (the merge-save keeps any key left undefined).
                avatarFrom: portablePhoto ? (photoSetIn ?? null) : undefined,
                bio: data.bio,
                contactValue: data.contact_value,
                contactVisibility: data.contact_visibility,
                // Not the working style: a row can be older than the device's result, and writing it here put a community's
                // old result over a retake (utils/working-style.ts). Only the quiz writes the device's copy.
            });
        }
    } catch { /* canonical mirror is best-effort */ }

    // GlobalHeader loaded the avatar once, keyed on identity.publicKey — which never changes
    // during a session — so a new profile picture only appeared after the header happened to
    // remount. Every LOCAL profile write funnels through here; a change that arrives by SYNC
    // is announced from applyDelta and the members-directory refresh instead.
    emitAppEvent('profile_updated', { pubkey });
}


/** #143 step 4 — which communities a listing can be aimed at (peers this node settles with).
 *  Returns empty on non-federated nodes, which hides the reach chooser in the composer. */
export async function getReachablePeers(): Promise<{ peerId: string; callsign: string | null }[]> {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return [];
        const cleanUrl = anchorUrl.trim().replace(/\/+$/, '');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${cleanUrl}/api/federation/reachable-peers`, {
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) return [];
        const json = await res.json();
        return Array.isArray(json?.peers)
            ? json.peers.filter((p: any) => typeof p?.peerId === 'string')
            : [];
    } catch {
        return [];
    }
}

/**
 * The shop an Offer from the map's composer goes in, when the List sheet said "Put this in your shop" for it (slice S4′,
 * utils/shop-choice.ts: map.tsx is read and never edited, so the choice rides beside its draft and knows its Offer by the
 * tool's title, words and photos): the member's own shop, opened first if they have none yet, as the sheet said.
 * Undefined on a node from before shops. Any other answer throws, so the choice's Offer is never posted outside the shop
 * the sheet promised; so does no answer within {@link SHOP_COMPOSER_WAIT_MS}.
 */
async function composerShopId(): Promise<string | undefined> {
    const unreadable = () => new Error(t("Your shop couldn't be read just now. Try again."));
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), SHOP_COMPOSER_WAIT_MS);
    try {
        const res = await signedGet('/api/shops/mine', { signal: stop.signal });
        if (res.status === 404) return undefined;
        const held = res.ok ? await res.json().catch(() => null) : null;
        if (typeof held?.shop?.id === 'string') return held.shop.id;
        if (held && held.shop === null) {
            const opened = await signedRequestWithMethod('PUT', '/api/shops/mine', {}, { withStatus: true, signal: stop.signal });
            if (typeof opened?.shop?.id === 'string') return opened.shop.id;
        }
    } catch (e) {
        if (stop.signal.aborted) throw unreadable();
        // The PUT answered without the node's words (a proxy's 502 page): never "Request failed: 502", in English, as
        // utils/shop.ts says it for the same answer.
        const err = e as { unsaid?: unknown; status?: unknown; code?: unknown } | null;
        if (err?.unsaid !== true) throw e;
        throw Object.assign(new Error(t("Your community couldn't be reached. Try again.")), { status: err.status, unsaid: true }, typeof err.code === 'string' ? { code: err.code } : {});
    } finally {
        clearTimeout(timer);
    }
    throw unreadable();
}

export async function createPost(post: any) {
    const database = await getDb();

    // 1. Enforce Online Connection & Broadcast First
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are currently offline. Please connect to a BeanPool Node to broadcast your post.');
    }

    const identity = await loadIdentity();
    if (!identity) {
        throw new Error('No identity found.');
    }
    const shopChoice = post.type === 'offer' ? shopChoiceFor(await peekShopChoice(), post, anchorUrl, Date.now()) : 'none';
    const shopId = shopChoice === 'shop' ? await composerShopId() : undefined;

    const body = {
        id: post.id,
        type: post.type,
        category: post.category,
        title: post.title,
        description: post.description,
        // Whole hundredths of a Bean (the composer's typed price through core parseHundredths), as the node takes it.
        price_c: post.price_c,
        priceType: post.price_type || 'fixed',
        // A listing priced for each one (DESIGN-per-item-price-fable.md §3): how many, and the price for all of them if set.
        ...(post.price_type === 'each' && typeof post.unitsLeft === 'number' ? { unitsLeft: post.unitsLeft, ...(post.lot ? { lot: post.lot } : {}) } : {}),
        authorPublicKey: post.author_pubkey,
        lat: post.lat,
        lng: post.lng,
        photos: post.photos ? JSON.parse(post.photos) : undefined,
        repeatable: post.repeatable === 1,
        cashAlsoNeeded: post.cash_also_needed === 1,
        // #143 step 4 — per-listing reach. Omitted fields default to 'local' on the server.
        ...(post.reach ? { reach: post.reach } : {}),
        ...(post.reach === 'peers' && post.reachPeers ? { reachPeers: post.reachPeers } : {}),
        // Flatten poll parameters to top-level request body
        ...(post.type === 'poll' ? {
            pollOptions: post.poll_options ? (typeof post.poll_options === 'string' ? JSON.parse(post.poll_options) : post.poll_options) : (post.pollOptions || []),
            durationDays: post.durationDays || 7,
            // Anonymous unless its creator chose an open vote (2026-09-28); only `true` opens one.
            pollOpenVote: post.pollOpenVote === true,
            // A typed Other, only when the maker asked and the node said it can (NewPollModal).
            ...(post.pollOther === true ? { pollOther: true } : {}),
        } : {}),
        // Events (docs/events-on-the-map.md §2.2): the server forces reach local and the other trade fields.
        ...(post.type === 'event' ? {
            eventStartAt: post.eventStartAt,
            eventEndAt: post.eventEndAt,
            eventPlaceName: post.eventPlaceName,
            ...(post.eventPrivateNote ? { eventPrivateNote: post.eventPrivateNote } : {}),
            // The host's clock and its zone, and online with its link (DESIGN-event-times §2, §9). A node from before
            // them ignores these and reads the instants above.
            ...(post.eventStartLocal ? { eventStartLocal: post.eventStartLocal } : {}),
            ...(post.eventEndLocal ? { eventEndLocal: post.eventEndLocal } : {}),
            ...(post.eventTz ? { eventTz: post.eventTz } : {}),
            ...(post.eventOnline === true ? { eventOnline: true } : {}),
            ...(post.eventLink ? { eventLink: post.eventLink } : {}),
            // The host's "Only people I let in" choice, always sent (utils/events.ts buildEventDraft): left out, the node applies its own default.
            ...(typeof post.eventHostLetsIn === 'boolean' ? { eventHostLetsIn: post.eventHostLetsIn } : {}),
        } : {}),
        ...(post.audienceScope || post.audience_scope ? { audienceScope: post.audienceScope || post.audience_scope } : {}),
        ...(post.targetGroupId || post.target_group_id ? { targetGroupId: post.targetGroupId || post.target_group_id } : {}),
        ...(post.targetPubkey || post.target_pubkey ? { targetPubkey: post.targetPubkey || post.target_pubkey } : {}),
        ...(post.assignedTo || post.assigned_to ? { assignedTo: post.assignedTo || post.assigned_to } : {}),
        ...(post.tags ? { tags: Array.isArray(post.tags) ? post.tags : postTagsOf(post.tags) } : {}),
        ...(listingFreeTags(post).length > 0 ? { freeTags: listingFreeTags(post) } : {}),
        ...(shopId ? { shopId } : {}),
    };
    // "Post as → an enterprise" on the event form (NewEventModal). An enterprise's event goes through the
    // enterprise's OWN route, with the enterprise in the PATH and never in the body: the node's signature
    // middleware refuses any body field ending in `publicKey` that is not the signer, so naming it as
    // `authorPublicKey` on /api/marketplace/posts is refused with "Signature validation failed" before the
    // route runs. The node reads the enterprise from the path, checks the signer is one of its keepers, and
    // records the event with the enterprise as author and the keeper as created_by.
    const enterpriseHost = post.type === 'event' && post.author_pubkey && post.author_pubkey !== identity.publicKey
        ? String(post.author_pubkey)
        : null;
    // Words for a group's or an enterprise's id: a known DM's id refuses first; a held group never waits (#1938 confirmation 8, GXF).
    for (const scope of [post.targetGroupId || post.target_group_id, enterpriseHost]) if (scope && !(await isHeldGroupChat(scope))) await refuseReadableIntoDm(scope);
    const { authorPublicKey: _authorInBody, ...bodyWithoutAuthor } = body;
    const path = enterpriseHost
        ? `/api/treasury/${encodeURIComponent(enterpriseHost)}/event`
        : '/api/marketplace/posts';
    const bodyString = JSON.stringify(enterpriseHost ? bodyWithoutAuthor : body);
    const postUrl = `${anchorUrl}${path}`;
    // The node's answer: for an event, `eventTimeAdjusted` says when a clock fell in a DST gap or overlap.
    let answer: any = null;
    const headers = await buildSignedHeaders('POST', postUrl, bodyString, identity.privateKey, identity.publicKey);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(postUrl, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) answer = await res.json().catch(() => null);
        if (!res.ok) {
            const txt = await res.text();
            let errMsg = 'Network request failed or server rejected the post.';
            try {
                const json = JSON.parse(txt);
                if (json.error) errMsg = json.error;
            } catch (e) {
                if (txt) errMsg = refusalTextOf(res.status, txt, errMsg);
            }
            // Auto-heal: server may not yet know about the user's avatar if the
            // onboarding publish failed. Push the profile and retry once.
            if (_isProfilePhotoError(errMsg)) {
                // As in `_signedRequest`: publishes only what this community holds for us (a pick that never reached it).
                const healed = await pushProfileToServer();
                if (healed) {
                    const retryHeaders = await buildSignedHeaders('POST', postUrl, bodyString, identity.privateKey, identity.publicKey);
                    const retryRes = await fetch(postUrl, {
                        method: 'POST',
                        headers: retryHeaders,
                        body: bodyString,
                    });
                    if (retryRes.ok) {
                        answer = await retryRes.json().catch(() => null);
                        // Fall through to local insert below
                    } else {
                        throw new Error(errMsg);
                    }
                } else {
                    throw new Error(errMsg);
                }
            } else {
                throw new Error(errMsg);
            }
        }
    } catch (e: any) {
        // If it fails (e.g., no internet or server error), bubble it up to the UI so we DON'T lose the drafted post!
        throw new Error(e.message || 'Network request failed. You must be connected to a node to post.');
    }
    // In the shop: the sheet's choice has had its Offer. Up outside it while the choice waited here: the member is told, now
    // that it is up, and the choice is forgotten (the composer's one draft has gone with this post).
    if (shopId) await clearShopChoice();
    else if (shopChoice === 'say') {
        await clearShopChoice();
        sayOutsideShop(String(post.title ?? ''));
    }

    // 2. Local Database Confirmation
    // Only save to SQLite AFTER the server has safely accepted it, preventing the background sync from wiping our un-synced draft
    const tagsStr = post.tags ? (Array.isArray(post.tags) ? post.tags.join(' ') : String(post.tags)) : '';
    await database.runAsync(
        `INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, created_at, lat, lng, price_type, repeatable, cash_also_needed, lendable, photos, reach, reach_peers, poll_options, poll_closes_at, poll_open_vote, audience_scope, target_group_id, tags, free_tags, event_start_at, event_end_at, event_place_name, event_state, event_going_count, event_interested_count, event_start_local, event_end_local, event_tz, event_online, event_repeat, event_repeat_until, event_repeat_skips)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [post.id, post.type, post.category, post.title, post.description, post.price_c,
         post.author_pubkey, post.created_at, post.lat || null, post.lng || null,
         post.price_type || 'fixed', post.repeatable || 0, post.cash_also_needed || 0,
         (post.lendable === true || post.lendable === 1) ? 1 : 0,
         post.photos || null,
         post.reach || 'local', post.reachPeers ? JSON.stringify(post.reachPeers) : null,
         post.poll_options ? (typeof post.poll_options === 'string' ? post.poll_options : JSON.stringify(post.poll_options)) : null,
         post.poll_closes_at || (post.durationDays ? new Date(Date.now() + post.durationDays * 86400000).toISOString() : null),
         post.type === 'poll' && post.pollOpenVote === true ? 1 : 0,
         post.audienceScope || post.audience_scope || 'public',
         post.targetGroupId || post.target_group_id || null,
         tagsStr,
         storedFreeTags(listingFreeTags(post)),
         ...eventCacheColumns(post)]
    );
    refreshBalanceFromServer(post.author_pubkey).catch(() => null);
    // No notifications ask here (slice N2a): a first listing's named line is on Your deals, where the post lands
    // (app/new-listing.tsx, components/NotifyLine.tsx).
    return { eventTimeAdjusted: answer?.eventTimeAdjusted ?? null, post: answer?.post ?? null };
}

export async function votePoll(postId: string, optionId: string, otherWords?: string) {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are currently offline.');
    }
    const identity = await loadIdentity();
    if (!identity) {
        throw new Error('No identity found.');
    }
    const body = {
        postId,
        optionId,
        voterPublicKey: identity.publicKey,
        ...(otherWords === undefined ? {} : { otherWords }),
    };
    const bodyString = JSON.stringify(body);
    const voteUrl = `${anchorUrl}/api/marketplace/posts/${encodeURIComponent(postId)}/vote`;
    const headers = await buildSignedHeaders('POST', voteUrl, bodyString, identity.privateKey, identity.publicKey);
    const res = await fetch(voteUrl, {
        method: 'POST',
        headers,
        body: bodyString
    });
    if (!res.ok) {
        const txt = await res.text();
        let errMsg = 'Failed to record vote';
        try {
            const j = JSON.parse(txt);
            if (j.error) errMsg = j.error;
        } catch {
            if (txt) errMsg = refusalTextOf(res.status, txt, errMsg);
        }
        throw new Error(errMsg);
    }
    const json = await res.json();
    if (json?.post) {
        try {
            const database = await waitForInit();
            await database.runAsync(
                `UPDATE posts SET poll_options = ?, poll_new_or_words_votes = ?, status = ?, updated_at = ? WHERE id = ?`,
                [
                    JSON.stringify(json.post.pollOptions || []),
                    pollNewOrWordsVotesColumn(json.post),
                    json.post.status,
                    json.post.updatedAt || new Date().toISOString(),
                    postId
                ]
            );
            await database.runAsync(
                `INSERT OR REPLACE INTO poll_votes (post_id, voter_pubkey, option_id, signature, created_at) VALUES (?, ?, ?, ?, ?)`,
                [postId, identity.publicKey, optionId, '', new Date().toISOString()]
            );
        } catch (dbErr) {
            console.warn('[SQLite] Failed to persist vote locally:', dbErr);
        }
    }
    return json;
}

/**
 * Reflect the node's reader view of an event into the local cache: counts, times and state on the posts row,
 * and "my status" in the phone's `event_rsvps`. The private note is deliberately not written anywhere.
 */
export async function persistEventView(post: any, memberPubkey: string) {
    if (!post || post.type !== 'event' || !post.id) return;
    try {
        const database = await waitForInit();
        const [, , , state, going, interested, startLocal, endLocal, tz, online, repeat, repeatUntil, repeatSkips] = eventCacheColumns(post);
        await database.runAsync(
            `UPDATE posts SET event_start_at = ?, event_end_at = ?, event_place_name = ?, event_state = ?, event_going_count = ?, event_interested_count = ?, event_start_local = ?, event_end_local = ?, event_tz = ?, event_online = ?, event_repeat = ?, event_repeat_until = ?, event_repeat_skips = ?, status = COALESCE(?, status), updated_at = COALESCE(?, updated_at) WHERE id = ?`,
            [post.eventStartAt ?? post.event_start_at ?? null, post.eventEndAt ?? post.event_end_at ?? null,
             post.eventPlaceName ?? post.event_place_name ?? null, state, going, interested, startLocal, endLocal, tz, online, repeat, repeatUntil, repeatSkips,
             post.status ?? null, post.updatedAt ?? post.updated_at ?? null, post.id]
        );
        if (post.myRsvp === 'going' || post.myRsvp === 'interested') {
            await database.runAsync(
                `INSERT OR REPLACE INTO event_rsvps (post_id, member_pubkey, status, updated_at) VALUES (?, ?, ?, ?)`,
                [post.id, memberPubkey, post.myRsvp, new Date().toISOString()]
            );
        } else if (post.myRsvp === null) {
            await database.runAsync(`DELETE FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?`, [post.id, memberPubkey]);
        }
    } catch (dbErr) {
        console.warn('[SQLite] Failed to persist event view locally:', dbErr);
    }
}

/**
 * Going / Interested / not going (null) for the signed-in member (docs/events-on-the-map.md §2.2). The body
 * carries a signature over `postId:status` that the server checks against the member's key. That text is plain
 * UTF-8 and the id is the node's, so an id that isn't a UUID, or a status outside the three, is refused before
 * anything is signed (events.ts isSignableRsvp).
 */
export async function rsvpEvent(postId: string, status: EventRsvpStatus | null) {
    if (!isSignableRsvp(postId, status)) throw new Error(UNSIGNABLE_RSVP_MESSAGE);
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are currently offline.');
    }
    const identity = await loadIdentity();
    if (!identity) {
        throw new Error('No identity found.');
    }
    const sig = await signData(encodeUtf8(rsvpSignedMessage(postId, status)), hexToBytes(identity.privateKey));
    const path = `/api/marketplace/posts/${encodeURIComponent(postId)}/rsvp`;
    const bodyString = JSON.stringify({ status, signature: encodeBase64(sig) });
    const headers = await buildSignedHeaders('POST', `${anchorUrl}${path}`, bodyString, identity.privateKey, identity.publicKey);
    const res = await fetch(`${anchorUrl}${path}`, { method: 'POST', headers, body: bodyString });
    if (!res.ok) {
        const txt = await res.text();
        let errMsg = 'Could not save your RSVP';
        try {
            const j = JSON.parse(txt);
            if (j.error) errMsg = j.error;
        } catch {
            if (txt) errMsg = refusalTextOf(res.status, txt, errMsg);
        }
        throw new Error(errMsg);
    }
    const json = await res.json();
    if (json?.post) await persistEventView(json.post, identity.publicKey);
    else if (json?.success && status === null) {
        // 'Not going' on a cancelled or ended event answers post:null: the phone's own copy forgets the member's place too.
        try {
            const database = await waitForInit();
            await database.runAsync(`DELETE FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?`, [postId, identity.publicKey]);
        } catch (dbErr) {
            console.warn('[SQLite] Failed to forget the RSVP locally:', dbErr);
        }
    }
    return json as { success: boolean; post: any };
}

/**
 * The event as THIS member may see it: counts, my RSVP, the private note (host and Going only) and, for a
 * host, who has RSVPd. Signed, because the server decides all of that from the requester. The note is kept
 * in memory by the screen, never written to the local cache.
 */
export async function fetchEventDetail(postId: string): Promise<any | null> {
    const res = await signedGet(`/api/marketplace/posts?id=${encodeURIComponent(postId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const post = Array.isArray(data) ? data[0] : null;
    if (!post || post.type !== 'event') return null;
    const identity = await loadIdentity();
    if (identity?.publicKey) await persistEventView(post, identity.publicKey);
    return post;
}

/**
 * The listing a chat message is about, as THIS member may read it (core chat-about.ts): the post once found; null when the
 * node holds none for them (gone, or hidden from them: the same answer, so a chat learns nothing about a listing it can't
 * see); undefined when the node could not be asked, so the card keeps what the sender wrote rather than saying "gone".
 * Signed, as the node decides what a member may see from who asks. Nothing is written to the local cache.
 */
export async function lookupAboutListing(postId: string): Promise<AboutPostLike | null | undefined> {
    try {
        const res = await signedGet(`/api/marketplace/posts?id=${encodeURIComponent(postId)}`);
        if (!res.ok) return undefined;
        const data = await res.json();
        if (!Array.isArray(data)) return undefined;
        const post = data.find((p: any) => p && p.id === postId);
        if (!post) return null;
        return { id: post.id, type: post.type, title: post.title, price_c: post.price_c, priceType: post.priceType ?? post.price_type, status: post.status };
    } catch {
        return undefined;
    }
}

/** What a node older than a route answers. Carried on the error so a screen can hide a feature quietly. */
export class RouteMissingError extends Error {
    readonly status = 404;
    constructor(path: string) {
        super(`This community's node does not have ${path} yet.`);
        this.name = 'RouteMissingError';
    }
}

/** True when a route does not exist on this node — an older node, not a failure worth showing anyone. */
export function isRouteMissing(e: unknown): boolean {
    return (e as { status?: number } | null)?.status === 404;
}

/**
 * The signer's own upcoming RSVPs, soonest first — what "Your events" shows (the shared contract).
 *
 * Signed, because the node decides whose list this is from the signature and never from a parameter. A node
 * without the route answers 404 and this throws RouteMissingError, which is the caller's cue to show
 * nothing at all rather than an error about a feature that community does not have.
 */
/**
 * GET /api/events/zone — the zone of an event's pin, with its words and offset now (DESIGN-event-times §2), for the form's
 * zone line. Null from a node before event times, offline, or for a point the lookup cannot place: the node then reads the
 * clock at the pin itself.
 */
export async function fetchEventZone(lat: number, lng: number): Promise<EventZone | null> {
    try {
        const res = await signedGet(`/api/events/zone?lat=${encodeURIComponent(String(lat))}&lng=${encodeURIComponent(String(lng))}`);
        if (!res.ok) return null;
        const z = await res.json();
        return z && typeof z.tz === 'string' && z.tz
            ? { tz: z.tz, label: typeof z.label === 'string' ? z.label : '', offsetMinutes: Number(z.offsetMinutes) }
            : null;
    } catch {
        return null;
    }
}

/** GET /api/events/zones — every zone the node accepts, for the form's picker (served, so the phone needs no zone list). */
export async function fetchEventZones(): Promise<EventZone[]> {
    const path = '/api/events/zones';
    const res = await signedGet(path);
    if (res.status === 404) throw new RouteMissingError(path);
    if (!res.ok) throw new Error(`Could not read the time zones (${res.status})`);
    const data = await res.json();
    const zones: any[] = Array.isArray(data?.zones) ? data.zones : [];
    return zones
        .filter(z => z && typeof z.tz === 'string' && typeof z.label === 'string' && Number.isFinite(Number(z.offsetMinutes)))
        .map(z => ({ tz: z.tz, label: z.label, offsetMinutes: Number(z.offsetMinutes) }));
}

export async function fetchMyEvents(): Promise<MyEvent[]> {
    const path = '/api/events/mine';
    const res = await signedGet(path);
    if (res.status === 404) throw new RouteMissingError(path);
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        let message = `Could not read your events (${res.status})`;
        try { message = JSON.parse(txt)?.error || message; } catch { if (txt) message = refusalTextOf(res.status, txt, message); }
        throw new Error(message);
    }
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data?.events ?? []);
    return sortMyEvents(rows as MyEvent[]);
}

/**
 * A member's preference bag (holiday_mode, notify_*, eventReminderOffsets). Values come back as the node
 * stored them, which for most of them is a string; each caller reads its own key.
 */
export async function fetchMemberPreferences(publicKey: string): Promise<Record<string, unknown>> {
    const res = await signedGet(`/api/members/preferences?publicKey=${encodeURIComponent(publicKey)}`);
    if (!res.ok) throw new Error(`Could not read your preferences (${res.status})`);
    return await res.json();
}

/**
 * This member's reminders for ONE event: the allowed offsets, or `null` to go back to their default.
 * Allowed only on an event they have an RSVP on — the node answers 403 otherwise.
 */
export async function setEventReminder(postId: string, offsets: number[] | null): Promise<{ success: boolean }> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are currently offline.');
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');

    const path = `/api/events/${encodeURIComponent(postId)}/reminder`;
    const bodyString = JSON.stringify({ offsets });
    const headers = await buildSignedHeaders('PUT', `${anchorUrl}${path}`, bodyString, identity.privateKey, identity.publicKey);
    const res = await fetch(`${anchorUrl}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
        body: bodyString,
    });
    if (res.status === 404) throw new RouteMissingError(path);
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        let message = 'Could not save your reminder';
        try { message = JSON.parse(txt)?.error || message; } catch { if (txt) message = refusalTextOf(res.status, txt, message); }
        throw new Error(message);
    }
    return await res.json();
}

/**
 * "Cancel this date" of a repeating event (`cancelled` true, POST), or "Bring it back" (false, DELETE): the host only,
 * signed (DESIGN-event-times §8). Cancelling the current date moves the event to its next date at once; the answer is the
 * event as the host reads it by id, with its next dates. A refusal throws the node's own sentence.
 */
export async function setEventDateCancelled(postId: string, date: string, cancelled: boolean): Promise<{ success: boolean; post: any; skips: string[] }> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are currently offline.');
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');
    const method = cancelled ? 'POST' : 'DELETE';
    const path = `/api/events/${encodeURIComponent(postId)}/skip`;
    const bodyString = JSON.stringify({ date });
    const headers = await buildSignedHeaders(method, `${anchorUrl}${path}`, bodyString, identity.privateKey, identity.publicKey);
    const res = await fetch(`${anchorUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
        body: bodyString,
    });
    if (res.status === 404) {
        const txt = await res.text().catch(() => '');
        let message = '';
        try { message = JSON.parse(txt)?.error || ''; } catch { /* not the node's JSON */ }
        if (!message) throw new RouteMissingError(path);
        throw new Error(message);
    }
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        let message = 'Could not change that date';
        try { message = JSON.parse(txt)?.error || message; } catch { if (txt) message = refusalTextOf(res.status, txt, message); }
        throw new Error(message);
    }
    const out = await res.json();
    if (out?.post) await persistEventView(out.post, identity.publicKey).catch(() => {});
    if (out?.post) repeatOnGlobalCopy((copy) => copy.repeatOnCopy(out.post, identity));
    return out;
}

/**
 * Save a host's edit to an event (events round 2, decision 29). Only the changed fields travel, signed with
 * the member's OWN key: the node checks it against the host set (author, keeper, convenor), so a keeper or a
 * convenor who did not post the event can edit it too. The node decides UPDATED and who is told.
 *
 * The cached row is refreshed from the node's answer so the feed shows the edit at once; the private note is
 * never written to the cache.
 */
export async function updateEvent(postId: string, patch: EventEditPatch, out?: { eventTimeAdjusted?: any }): Promise<any> {
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');
    await refuseReadableIntoDm(postId);
    const json = await _signedRequest('/api/marketplace/posts/update', { id: postId, authorPublicKey: identity.publicKey, ...patch });
    // A clock the host set that fell in a DST gap or overlap, next to the post (never on it).
    if (out) out.eventTimeAdjusted = json?.eventTimeAdjusted ?? null;
    const post = json?.post;
    if (post?.id) {
        try {
            const database = await waitForInit();
            const photos = Array.isArray(post.photos) ? JSON.stringify(post.photos.filter((u: string) => !u.startsWith('file://'))) : null;
            const tagsVal = patch.tags !== undefined
                ? (Array.isArray(patch.tags) ? patch.tags.join(' ') : '')
                : (post.tags != null ? (Array.isArray(post.tags) ? post.tags.join(' ') : String(post.tags)) : null);
            const freeTagsVal = patch.freeTags !== undefined
                ? storedFreeTags(patch.freeTags)
                : (post.freeTags != null ? storedFreeTags(listingFreeTags(post)) : null);
            const tagsSql = `${tagsVal !== null ? ', tags = ?' : ''}${freeTagsVal !== null ? ', free_tags = ?' : ''}`;
            const tagsArg = [...(tagsVal !== null ? [tagsVal] : []), ...(freeTagsVal !== null ? [freeTagsVal] : [])];
            await database.runAsync(
                `UPDATE posts SET title = ?, description = ?, lat = ?, lng = ?, photos = COALESCE(?, photos)${tagsSql} WHERE id = ?`,
                [post.title ?? null, post.description ?? '', post.lat ?? null, post.lng ?? null, photos, ...tagsArg, post.id]
            );
        } catch (dbErr) {
            console.warn('[SQLite] Failed to cache the edited event:', dbErr);
        }
        await persistEventView(post, identity.publicKey);
        repeatOnGlobalCopy((copy) => copy.repeatOnCopy(post, identity));
    }
    return post;
}

/** The member's copy on the global community follows, if there is one. Loaded when used; a miss is caught up later. */
function repeatOnGlobalCopy(run: (copy: typeof import('./show-on-global')) => Promise<unknown>): void {
    import('./show-on-global').then(run).catch(() => {});
}

/** A poll's typed answers as its maker or an owner reads them (apps/server engine/poll-other.ts). */
export interface PollOtherRead {
    state: 'held' | 'open';
    count: number;
    answers: Array<{ id: string; words: string; reported: boolean }>;
    removed: number;
    canRemove: boolean;
}

let roleHereRead: { anchor: string | null; role: Promise<string | null> } | null = null;

/** The signer's role on this community (GET /api/node-admin/me: owner, admin, moderator or none), asked once per community a run. It decides nothing: the node checks every read. */
async function roleHere(): Promise<string | null> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
    if (roleHereRead?.anchor === anchor) return roleHereRead.role;
    const role = signedGet('/api/node-admin/me')
        .then(res => (res.ok ? res.json() : null))
        .then((body: { role?: unknown } | null) => (typeof body?.role === 'string' ? body.role : null))
        .catch(() => { roleHereRead = null; return null; });
    roleHereRead = { anchor, role };
    return role;
}

/** Whether the signer is an owner on this community, asked only by a poll card with words to offer. It decides nothing: the node checks every read. */
export async function isOwnerHere(): Promise<boolean> {
    return (await roleHere()) === 'owner';
}

/**
 * Whether the signer is an owner or an admin on this community, asked when the poll form opens: they alone are offered a poll of 30 or
 * 90 days (@beanpool/core poll-length). It decides nothing: the node checks at Create, and a role it could not read offers the short lengths.
 */
export async function isOwnerOrAdminHere(): Promise<boolean> {
    return mayChooseLongPolls(await roleHere());
}

/**
 * When the node says this member's next poll can start (a member starts one a week, engine/poll-week.ts), asked before the poll
 * form opens: the time in ms, or null when they may start one now, when the node is one from before the rule, or when it cannot
 * be asked (offline). It gates nothing: the node checks again at Create.
 */
export async function getPollNextStart(): Promise<number | null> {
    try {
        const res = await signedGet(POLL_NEXT_START_PATH);
        if (!res.ok) return null;
        return pollNextStartMs(await res.json().catch(() => null));
    } catch {
        return null;
    }
}

export async function getPollOtherAnswers(postId: string): Promise<PollOtherRead> {
    const res = await signedGet(`/api/marketplace/posts/${encodeURIComponent(postId)}/other-answers`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || 'The typed answers could not be read.');
    return body as PollOtherRead;
}

export async function reportPollOtherAnswer(postId: string, answerId: string) {
    return _signedRequest(`/api/marketplace/posts/${encodeURIComponent(postId)}/other-answers/${encodeURIComponent(answerId)}/report`, {});
}

export async function removePollOtherAnswer(postId: string, answerId: string) {
    return _signedRequest(`/api/marketplace/posts/${encodeURIComponent(postId)}/other-answers/${encodeURIComponent(answerId)}/remove`, {});
}

export async function closePoll(postId: string) {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are currently offline.');
    }
    const identity = await loadIdentity();
    if (!identity) {
        throw new Error('No identity found.');
    }
    const body = {
        postId,
        authorPublicKey: identity.publicKey
    };
    const bodyString = JSON.stringify(body);
    const closeUrl = `${anchorUrl}/api/marketplace/posts/${encodeURIComponent(postId)}/close`;
    const headers = await buildSignedHeaders('POST', closeUrl, bodyString, identity.privateKey, identity.publicKey);
    const res = await fetch(closeUrl, {
        method: 'POST',
        headers,
        body: bodyString
    });
    if (!res.ok) {
        const txt = await res.text();
        let errMsg = 'Failed to close poll';
        try {
            const j = JSON.parse(txt);
            if (j.error) errMsg = j.error;
        } catch {
            if (txt) errMsg = refusalTextOf(res.status, txt, errMsg);
        }
        throw new Error(errMsg);
    }
    const json = await res.json();
    if (json?.post) {
        try {
            const database = await waitForInit();
            await database.runAsync(
                `UPDATE posts SET status = ?, updated_at = ? WHERE id = ?`,
                [json.post.status, json.post.updatedAt || new Date().toISOString(), postId]
            );
        } catch (dbErr) {
            console.warn('[SQLite] Failed to persist poll close locally:', dbErr);
        }
    }
    return json;
}

/**
 * Pins a post for 1, 3 or 7 days (DESIGN-pinning-fable.md §2).
 * Signed member route: role check happens on the node, refusal returns node's words.
 */
export async function pinPostOnNode(postId: string, days: PinDays): Promise<{ success: boolean; postId: string; pinnedUntil: string; pinnedAt: string }> {
    // The shared signed request: it signs, sends X-Language so a refusal comes back in the member's language, and throws
    // the node's own sentence (with `nodeAnswered` set) for the screen to show (utils/pins.ts pinFailureText).
    const json = await _signedRequest(`/api/marketplace/posts/${encodeURIComponent(postId)}/pin`, { days });
    try {
        const database = await waitForInit();
        await database.runAsync(
            `UPDATE posts SET pinned_until = ?, pinned_at = ?, updated_at = ? WHERE id = ?`,
            [json.pinnedUntil || null, json.pinnedAt || null, json.pinnedAt || new Date().toISOString(), postId]
        );
        emitAppEvent('sync_data_updated');
    } catch (e) {
        console.warn('[DB] Failed to update local post pin status:', e);
    }
    return json;
}

/**
 * Takes the pin off a post early (DESIGN-pinning-fable.md §0.2, §2.5).
 * Signed member route: owners, admins, or the post's author may unpin.
 */
export async function unpinPostOnNode(postId: string): Promise<{ success: boolean; postId: string }> {
    // `{}` as every other phone POST sends; the signed actor is the only input the node reads.
    const json = await _signedRequest(`/api/marketplace/posts/${encodeURIComponent(postId)}/unpin`, {});
    try {
        const database = await waitForInit();
        await database.runAsync(
            `UPDATE posts SET pinned_until = NULL, pinned_at = NULL WHERE id = ?`,
            [postId]
        );
        emitAppEvent('sync_data_updated');
    } catch (e) {
        console.warn('[DB] Failed to clear local post pin status:', e);
    }
    return json;
}

export async function createEnterpriseApi(data: {
    name: string;
    purpose?: string;
    description?: string;
    lifecycle?: 'ongoing' | 'bounded';
    /** A project's goal, whole hundredths of a Bean (the node refuses the old `goalAmount`). */
    goalAmount_c?: number | null;
    deadlineAt?: string | null;
    avatar?: string;
    photos?: string[];
}) {
    return _signedRequest('/api/enterprise', data);
}

export async function createProject(project: {
    title: string;
    description: string;
    /** Whole hundredths of a Bean. */
    goal_amount_c?: number;
    photos?: string[];
    deadline_at?: string | null;
    lifecycle?: 'ongoing' | 'bounded';
}) {
    return createEnterpriseApi({
        name: project.title,
        purpose: project.description,
        description: project.description,
        lifecycle: project.lifecycle || (project.goal_amount_c ? 'bounded' : 'ongoing'),
        goalAmount_c: project.goal_amount_c,
        deadlineAt: project.deadline_at,
        photos: project.photos,
        avatar: project.photos && project.photos.length > 0 ? project.photos[0] : undefined,
    });
}

export async function deleteCrowdfundProjectApi(projectId: string) {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        throw new Error('You are currently offline. Please connect to a BeanPool Node to cancel your initiative.');
    }

    const identity = await loadIdentity();
    if (!identity) {
        throw new Error('No identity found.');
    }

    const body = {
        id: projectId,
        creatorPubkey: identity.publicKey,
    };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', `${anchorUrl}/api/crowdfund/projects/delete`, bodyString, identity.privateKey, identity.publicKey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
        res = await fetch(`${anchorUrl}/api/crowdfund/projects/delete`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
    } catch (e: any) {
        throw new Error(e.message || 'Network request failed. You must be connected to a node to cancel initiatives.');
    } finally {
        clearTimeout(timeoutId);
    }

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to cancel initiative: ${errorText}`);
    }

    try {
        const database = await getDb();
        await database.runAsync(`DELETE FROM projects WHERE id = ?;`, [projectId]);
    } catch { }
}

// ===================== COMMUNITY TREASURIES =====================
export interface TreasurySummary {
    publicKey: string;
    name: string;
    callsign?: string;
    avatar?: string | null;
    avatarUrl?: string | null;
    // Every figure whole hundredths of a Bean, as the node sends them (`*_c`).
    balance_c: number;
    creditLine_c: number;
    liveOffers: number;
    earnedSurplus_c?: number;
    workingCapitalCeiling_c?: number | null;
    purpose?: string | null;
    goalAmount_c?: number | null;
    currentAmount_c?: number | null;
    deadlineAt?: string | null;
    lifecycle?: string;
    status?: string;
    paused?: boolean;
    keepers?: Array<{ pubkey: string; callsign: string; role: string }>;
    link?: any;
}

/** A pledge of `amount_c` (whole hundredths of a Bean, above 0) to an enterprise or project: signed over the integer. */
export async function treasuryPledge(treasury: string, amount_c: number, memo?: string) {
    if (memo) await refuseReadableIntoDm(treasury);
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/pledge`, { amount_c, memo });
}

export async function getTreasuries(): Promise<TreasurySummary[]> {
    const rawUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!rawUrl) return [];
    const anchorUrl = rawUrl.replace(/\/$/, '');
    try {
        const res = await fetch(`${anchorUrl}/api/treasuries`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.treasuries || [];
    } catch { return []; }
}

export async function getTreasuryDetail(publicKey: string): Promise<any | null> {
    try {
        const res = await signedGet(`/api/treasury/${encodeURIComponent(publicKey)}`);
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

// Operator actions — signed as the operator; the treasury id rides the URL path (dodges the
// requireSignature spoof-guard, which pins body *pubkey fields to the signer).
/** `photos`: JPEG data URLs, at most five (utils/post-photo.ts), checked by the node as a member's own listing's are. */
export async function treasuryPostOffer(treasury: string, body: { category: string; title: string; description?: string; price_c: number; priceType?: string; repeatable?: boolean; photos?: string[]; tags?: string[]; freeTags?: string[] }) {
    await refuseReadableIntoDm(treasury);
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/offer`, body);
}
export async function treasuryPostNeed(treasury: string, body: { category: string; title: string; description?: string; price_c: number; priceType?: string; repeatable?: boolean; photos?: string[]; tags?: string[]; freeTags?: string[] }) {
    await refuseReadableIntoDm(treasury);
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/need`, body);
}
export async function treasuryApprove(treasury: string, transactionId: string) {
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/approve`, { transactionId });
}
export async function treasuryComplete(treasury: string, transactionId: string, hours?: number) {
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/complete`, { transactionId, hours });
}
export async function treasuryReject(treasury: string, transactionId: string) {
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/reject`, { transactionId });
}
/**
 * An enterprise's open deals, held and asked, for its keeper reading one of its listings (deals S4): the node lets its
 * keepers read them (GET /api/marketplace/transactions), while the phone's sync reads only the member's own. Each status
 * read by itself: the node's page is the 50 newest, and a held deal behind 50 newer ones (a shop's brisk sales) would
 * have no row and no Release. Nothing of a status whose read can't be had.
 */
export async function getDealsFor(publicKey: string): Promise<MarketplaceTransaction[]> {
    const read = async (status: 'pending' | 'requested'): Promise<MarketplaceTransaction[]> => {
        try {
            const res = await signedGet(`/api/marketplace/transactions?publicKey=${encodeURIComponent(publicKey)}&status=${status}&limit=50`);
            if (!res.ok) return [];
            const rows = await res.json();
            return Array.isArray(rows) ? rows : [];
        } catch {
            return [];
        }
    };
    return (await Promise.all([read('pending'), read('requested')])).flat();
}
// Every figure in these bodies and answers is whole hundredths of a Bean (`*_c`), as the node takes and answers them.
export async function treasurySweep(treasury: string, amount_c: number): Promise<{ success: boolean; swept_c: number; balance_c: number } | null> {
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/sweep`, { amount_c });
}
export async function treasuryPledgeBacking(treasury: string, amount_c: number): Promise<{ success: boolean; pledge: any; floor_c: number; allowance_c: number; derivedAllowance_c: number; availableToBack_c: number } | null> {
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/backing`, { amount_c });
}
/** Release some of a backing (`amount_c`), or all of it (no amount: the body carries no money key). */
export async function treasuryRelease(treasury: string, amount_c?: number): Promise<{ success: boolean; releasedAmount_c: number; remainingPledge_c: number; floor_c: number; allowance_c: number; derivedAllowance_c: number; availableToBack_c: number } | null> {
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/release`, amount_c === undefined ? {} : { amount_c });
}
export async function getTreasuryPledges(treasury: string): Promise<{ pledges: any[]; floor_c: number; allowance_c: number; derivedAllowance_c: number; availableToBack_c: number | null } | null> {
    try {
        const res = await signedGet(`/api/treasury/${encodeURIComponent(treasury)}/pledges`);
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

// Enterprise Keepers & Succession API (docs/the-commons.md §2.3, §2.4 Rule 3, §2.6)
/** Ask to keep an enterprise, pledging `pledgedBacking_c` (whole hundredths of a Bean, 0 for none) of backing. */
export async function requestToJoinEnterprise(treasury: string, pledgedBacking_c: number) {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/keepers/request`, { pledgedBacking_c });
}

export async function getEnterpriseKeeperRequests(treasury: string, status = 'pending') {
    try {
        const res = await signedGet(`/api/enterprise/${encodeURIComponent(treasury)}/keepers/requests?status=${encodeURIComponent(status)}`);
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

export async function approveKeeperRequest(treasury: string, requestId: string) {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/keepers/requests/${encodeURIComponent(requestId)}/approve`, {});
}

export async function declineKeeperRequest(treasury: string, requestId: string) {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/keepers/requests/${encodeURIComponent(requestId)}/decline`, {});
}

export async function getEnterpriseSuccession(treasury: string) {
    try {
        const res = await signedGet(`/api/enterprise/${encodeURIComponent(treasury)}/succession`);
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

export async function proposeEnterpriseSuccession(treasury: string, candidatePubkey: string) {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/succession/propose`, { candidatePubkey });
}

export async function voteEnterpriseSuccession(treasury: string, proposalId: string, choice: 'yes' | 'no' = 'yes') {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/succession/${encodeURIComponent(proposalId)}/vote`, { choice });
}

/** The lead removes an ordinary keeper; the other keepers have 3 days to object. */
export async function removeEnterpriseKeeper(treasury: string, memberPubkey: string) {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/keepers/${encodeURIComponent(memberPubkey)}/remove`, {});
}

export async function objectToKeeperChange(treasury: string, changeId: string) {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/keepers/changes/${encodeURIComponent(changeId)}/object`, {});
}

/**
 * An enterprise's keepers' votes (DESIGN-group-decisions S2; routes/enterprise-decisions.ts). Only its keepers, and those on
 * a vote's roll, are answered; anyone else gets a 404, so null here means "nothing for you", never an error to show.
 */
export async function getEnterpriseDecisions(treasury: string): Promise<ScopedDecisionList | null> {
    try {
        const res = await signedGet(`/api/enterprise/${encodeURIComponent(treasury)}/decisions`);
        if (!res.ok) return null;
        const body = await res.json();
        return body && Array.isArray(body.decisions) ? body as ScopedDecisionList : null;
    } catch {
        return null;
    }
}

/**
 * A keeper proposes a vote. A pay-out names its recipient as params.to; the node checks everything again. The title, the why
 * and a pay-out's memo are words the node reads, so a known DM's id refuses first (#1938 confirmation 7, finding 2).
 */
export async function proposeEnterpriseDecision(treasury: string, body: {
    title: string; description: string; effect: ScopedEffect; subject?: string; params?: { to: string; amount_c: number; memo?: string };
}) {
    await refuseReadableIntoDm(treasury);
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/decisions`, body);
}

/** Yes or No on a keepers' vote. A vote can't be changed once cast. */
export async function voteEnterpriseDecision(treasury: string, decisionId: string, support: boolean) {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/decisions/${encodeURIComponent(decisionId)}/vote`, { support });
}

/**
 * A chat group's votes (DESIGN-group-decisions S3; routes/group-decisions.ts). Its members (any role) are answered, and those
 * on a vote's roll after they left; anyone else gets a 404, so null here means "nothing for you", never an error to show.
 */
export async function getGroupDecisions(groupId: string): Promise<ScopedDecisionList | null> {
    try {
        const res = await signedGet(`/api/groups/${encodeURIComponent(groupId)}/decisions`);
        if (!res.ok) return null;
        const body = await res.json();
        return body && Array.isArray(body.decisions) ? body as ScopedDecisionList : null;
    } catch {
        return null;
    }
}

/**
 * A member or convenor proposes a group vote: the group's own things only, never a recipient or an amount. The title and the
 * why are words the node reads, so a known DM's id refuses first; a group this phone holds keys of is never a DM, and its
 * votes never wait on the pins (#1938 confirmation 7, finding 2).
 */
export async function proposeGroupDecision(groupId: string, body: {
    title: string; description: string; effect: GroupEffect; subject?: string; params?: { role?: 'convenor' | 'member'; policy?: string };
}) {
    if (!(await isHeldGroupChat(groupId))) await refuseReadableIntoDm(groupId);
    return _signedRequest(`/api/groups/${encodeURIComponent(groupId)}/decisions`, body);
}

/** Yes or No on a group's vote. A vote can't be changed once cast. */
export async function voteGroupDecision(groupId: string, decisionId: string, support: boolean) {
    return _signedRequest(`/api/groups/${encodeURIComponent(groupId)}/decisions/${encodeURIComponent(decisionId)}/vote`, { support });
}

export async function stepDownAsKeeper(treasury: string) {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/keepers/step-down`, {});
}

export async function getEnterpriseThread(treasury: string, limit = 50, offset = 0): Promise<{ conversation: any; messages: any[]; readOnly: boolean } | null> {
    try {
        const res = await signedGet(`/api/treasury/${encodeURIComponent(treasury)}/thread?limit=${limit}&offset=${offset}`);
        if (!res.ok) return null;
        const body = await res.json();
        if (chatIsLocked(body)) noteAnsweredLocked(treasury);
        return body;
    } catch {
        return null;
    }
}

export async function postEnterpriseThreadMessage(treasury: string, text: string, clientId?: string): Promise<{ success: boolean; message: any } | null> {
    const to = await readableChatAddress(treasury);
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/thread/message`, { text, clientId }, to);
}

export async function removeEnterpriseThreadMessage(treasury: string, messageId: string): Promise<{ success: boolean; message: any } | null> {
    return _signedRequest(`/api/treasury/${encodeURIComponent(treasury)}/thread/remove`, { messageId });
}

// Event chat (docs/events-on-the-map.md §2.2). The chat's id IS the event's id. Every call is signed: the
// node serves it to the host and everyone marked Going and to nobody else, so nothing here is cached —
// the private note in particular never touches the phone's database.

/**
 * Throws the node's own message, which the screen shows, rather than a bare "failed". `community`: an event of another
 * community this phone holds as a member, read in place (slice S6): its own server decides who reads it (the host, and the
 * people Going it lets in), asked under its name, at its saved address. A chat its node answers locked is marked in that
 * community's own file before the answer is handed on, as a group's is ({@link noteGroupLocked}).
 */
export async function getEventChat(postId: string, limit = 50, offset = 0, community?: ChatCommunity): Promise<any> {
    const asked = await groupContextFor(postId, community, ['event']).catch((e) => { if (community) throw e; return null; });
    const res = await signedGet(`/api/marketplace/posts/${encodeURIComponent(postId)}/chat?limit=${limit}&offset=${offset}`, { anchorUrl: asked?.nodeUrl });
    const body = await res.json().catch(() => ({}));
    // The node's code rides on the error: `waiting_for_host` is someone Going whom the host hasn't let in (events.ts isWaitingForHost).
    if (!res.ok) throw Object.assign(new Error(body?.error || 'Could not open this event chat.'), { code: body?.code });
    if (chatIsLocked(body)) {
        if (asked) await noteGroupLocked(asked, postId, community);
        else noteAnsweredLocked(postId);
    }
    return body;
}

/**
 * The host lets a Going member in to the note and the chat, or takes it back, or lets everyone waiting in
 * (DESIGN-global-member-privacy-fable.md §2.2). Answers the event as the host sees it.
 */
export async function letInToEvent(postId: string, who: { memberPublicKey: string } | { everyone: true }, letIn = true): Promise<any> {
    return _signedRequest(`/api/marketplace/posts/${encodeURIComponent(postId)}/let-in`, { ...who, letIn });
}

export async function postEventChatMessage(postId: string, text: string, clientId?: string, community?: ChatCommunity): Promise<any> {
    const to = await readableChatAddress(postId, community);
    return _signedRequest(`/api/marketplace/posts/${encodeURIComponent(postId)}/chat/message`, { text, clientId }, to);
}

export async function removeEventChatMessage(postId: string, messageId: string, community?: ChatCommunity): Promise<any> {
    return _signedRequest(`/api/marketplace/posts/${encodeURIComponent(postId)}/chat/remove`, { messageId }, await groupAddressOf(postId, community, ['event']));
}

/**
 * Report an event from its chat, to its own community's moderators (slice S6: in place, that community's). About the event
 * and its host, whom the node reads from it, as the event page's Report is ({@link reportAbuse}); the words as any report's.
 */
export async function reportEvent(postId: string, reason: string, community?: ChatCommunity): Promise<any> {
    const { nodeUrl, identity, at } = await groupContextFor(postId, community, ['event']);
    const sending = await reportReasonFor(postId, reason, at);
    try {
        const res = await _signedRequest('/api/reports', { reporterPubkey: identity.publicKey, reason: sending.reason, targetPostId: postId }, nodeUrl);
        return sending.wordsLeftOut ? { ...res, wordsLeftOut: sending.wordsLeftOut } : res;
    } catch (e: any) {
        throw reportRefusal(e);
    }
}

/** The local conversation's kind, so /chat/:id can hand an event chat to its own screen. */
// ── A DM stays a DM ─────────────────────────────────────────────────────────────────────────────────────────────
// The node says what type a conversation is, and a group's, an event's and an enterprise's chats are node-readable by
// design: shown in their own views, their lines plaintext-v1, and this phone sends plaintext into them. So the node
// retyping a DM as one of those would show its unencrypted lines as members' words, and make this phone send the next
// line readable. A conversation this phone has ever seen as a DM, or that holds an encrypted line (no node-readable
// chat ever does: the node refuses one), stays a DM here whatever the node says: it opens only in the DM view, with
// the DM checks, and is locked when sent to. A type change from the node is ignored, and logged. The ids seen as DMs
// are kept in AsyncStorage, so a database wipe-and-fetch, or the node dropping the chat for a while, forgets none.
//
// The pins are asked first (§3.4 amendment 7 §3 iv): a conversation this community file's pins keep anything for (a pin,
// a rule-5 record, a heldLost mark) is a DM whatever the node now says, and is added to the list. The list is the second
// memory, one per (account, community file) and bounded (utils/dm-guard-list.ts). When it can't be read it is UNREADABLE,
// never empty: nothing is written over it, the sync writes no type of the node's where it would decide, and no line goes
// readable into a conversation whose group keys this phone never held (DmGuardUnreadError, its own sentence).

const dmSeen = createDmSeenList(AsyncStorage);

/** This account and the community file `database` reads, for the DM guard's list; null with no identity (nothing is sent). */
async function dmGuardOf(database?: SQLite.SQLiteDatabase): Promise<{ me: string; file: string; database: SQLite.SQLiteDatabase } | null> {
    const me = (await loadIdentity())?.publicKey;
    if (!me) return null;
    const db = database ?? await getDb();
    const file = dbFileOf.get(db);
    if (!file) throw new DmGuardUnreadError();
    return { me, file, database: db };
}

/** A file's own `dm` rows, held longest first: its guard list's seed, through the handle named. */
function dmRowsOf(database: SQLite.SQLiteDatabase): () => Promise<string[]> {
    return async () => (await database.getAllAsync<any>("SELECT id FROM conversations WHERE type = 'dm' ORDER BY rowid"))
        .map((r: any) => r?.id).filter((id: unknown): id is string => typeof id === 'string' && !!id);
}

/** The ids seen as DMs in this community. Throws (DmGuardUnreadError) when the list can't be read: never an empty set. */
async function dmConversationsSeen(database?: SQLite.SQLiteDatabase): Promise<Set<string>> {
    let here: Awaited<ReturnType<typeof dmGuardOf>>;
    try {
        here = await dmGuardOf(database);
    } catch {
        throw new DmGuardUnreadError();
    }
    if (!here) return new Set();
    return new Set(await dmSeen.read(here.me, here.file, dmRowsOf(here.database)));
}

/**
 * Remember conversations seen as DMs in this community (never forgotten; at the list's cap a new one is refused and logged).
 * Nothing is written when the list can't be read (§3.4 amendment 7 §3 iii).
 */
async function rememberDmConversations(ids: string[], database?: SQLite.SQLiteDatabase): Promise<void> {
    if (!ids.length) return;
    try {
        const here = await dmGuardOf(database);
        if (here) await dmSeen.remember(here.me, here.file, ids, dmRowsOf(here.database));
    } catch (e) {
        console.warn('[DM guard] Could not read which chats here are DMs, so none was remembered this time', e);
    }
}

/**
 * True when this community file's DM pins keep anything for the id (a pin, a rule-5 record, a heldLost mark): it is a DM
 * whatever the node now says (§3.4 amendment 7 §3 iv). False when they keep nothing, or can't be read (the list decides),
 * and for a group whose keys this phone has held: the held guard is asked before anything, so a node listing a held group
 * as a DM, which the pins hear at first sight, never makes it one here. A key memory that can't be read can't tell a held
 * group from the DM the pins keep, so it fails closed as the pins' own store does (Fable's security review of the trio,
 * finding 1): it throws the key store's sentence (GroupChatKeyError 'store'), "can't tell", which knownDmConversationId
 * passes on when nothing else knows the id. Taking it as held made it "not pinned", and a pruned DM relisted as an
 * event's, an enterprise's or an unlocked group's chat while the key memory couldn't be read sent its words readable (SEC1).
 * `pinsMustRead` (a send): pins that can't be read throw (DmPinStoreError), so nothing goes on the list's word alone.
 * `myPub`: this identity's key when the caller has it (a sync pass asks every row), so the identity isn't loaded per ask.
 */
async function keptInDmPins(conversationId: string, database: SQLite.SQLiteDatabase, pinsMustRead = false, myPub?: string | null): Promise<boolean> {
    let me: string | null | undefined;
    let pins: DmPeerPins;
    try {
        me = myPub ?? (await loadIdentity())?.publicKey;
        if (!me || !isPinnableId(conversationId)) return false;
        pins = await dmPins.read(me, database);
    } catch (e) {
        if (pinsMustRead && (isDmPinStoreError(e) || isDmPinsFullError(e))) throw e;
        return false;
    }
    if (!dmSightFor(pins, conversationId)) return false;
    let held: boolean;
    try {
        held = await heldInKeyMemory(conversationId, me, database);
    } catch {
        throw new GroupChatKeyError(GROUP_KEY_STORE_UNREAD_TEXT, 'store');
    }
    return !held;
}

/**
 * What a DM guard ask may name: pins that must read (a send), this account's key, and (`at`, slice S6) the copy asked: its
 * rows, its file's pins and its file's list. Left out: the copy in use.
 */
interface DmGuardAsk { pinsMustRead?: boolean; me?: string | null; at?: SQLite.SQLiteDatabase }

/**
 * The spelling of the id this phone knows a DM by, or null when it knows no DM by any spelling of `conversationId`: the
 * DM list's, the dm row's, or the id an encrypted line was kept under. The held check, the keyring and the group screens
 * fold an id's case (a link or a push can carry it in capitals), so this folds it too: otherwise one id in capitals
 * reaches a group's keys on a known DM's own id, and makes it a held group whose lines go to the roster the node shows
 * (#1841 review, finding 1). The two SQLite lookups ask the id as given, lower- and upper-case, so both keep their index:
 * a COLLATE NOCASE compare scanned the whole table for every row holdDmTypes asks about (#1841 confirmation 1, finding
 * 2); refuseGroupKeysForDm keeps the complete check (isKnownDmInAnySpelling). `seenByFold` is the DM list folded once,
 * for a pass over many rows (dmConversationsByFold); null when it couldn't be read.
 *
 * The pins are asked first (§3.4 amendment 7 §3 iv): an id this file's pins keep anything for is a known DM (under the
 * spelling asked for, unless the list, a row or a line knows it under another). With the list unreadable and nothing else
 * knowing the id this throws DmGuardUnreadError: "not a DM" is never answered from a list it couldn't read. `pinsMustRead`
 * (a send): pins that can't be read throw DmPinStoreError rather than leave the answer to the list. `me`: this identity's
 * key, when the caller already has it (holdDmTypes asks every non-DM row of a pass).
 */
export async function knownDmConversationId(conversationId: string, seenByFold?: Map<string, string[]> | null, opts: DmGuardAsk = {}): Promise<string | null> {
    if (!conversationId) return null;
    const folded = conversationId.toLowerCase();
    const db = opts.at ?? await getDb().catch(() => null);
    let pinned = false;
    let keyMemoryUnread: unknown = null;
    if (db) {
        try { pinned = await keptInDmPins(conversationId, db, opts.pinsMustRead, opts.me); } catch (e) { if (!isKeyStoreUnread(e)) throw e; keyMemoryUnread = e; }
    }
    let listed: string[] | null;
    if (seenByFold !== undefined) listed = seenByFold ? (seenByFold.get(folded) ?? []) : null;
    else listed = await dmConversationsSeen(opts.at).then((seen) => [...seen].filter((s) => s.toLowerCase() === folded), () => null);
    // The spelling asked for wins wherever this phone knows a DM under it, so a link to a conversation the phone holds
    // opens that conversation, never a twin under another spelling: a node can list one first, and SQLite visits an IN
    // list in BINARY order, upper case first (#1863 review). Another spelling answers only when this one is known nowhere.
    if (listed?.includes(conversationId)) return conversationId;
    let row: string | null = null;
    let line: string | null = null;
    try {
        const database = opts.at ?? await getDb();
        const ids = [...new Set([conversationId, folded, conversationId.toUpperCase()])];
        const marks = ids.map(() => '?').join(', ');
        const conv = await database.getFirstAsync<any>(`SELECT id FROM conversations WHERE id IN (${marks}) AND type = 'dm' ORDER BY id = ? DESC LIMIT 1`, [...ids, conversationId]);
        row = typeof conv?.id === 'string' ? conv.id : null;
        if (row === conversationId) return row;
        const msg = await database.getFirstAsync<any>(
            `SELECT conversation_id FROM messages WHERE conversation_id IN (${marks}) AND nonce LIKE ? ORDER BY conversation_id = ? DESC LIMIT 1`, [...ids, `${V2_NONCE_PREFIX}%`, conversationId]);
        line = typeof msg?.conversation_id === 'string' ? msg.conversation_id : null;
        if (line === conversationId) return line;
    } catch {}
    const known = listed?.[0] ?? row ?? line ?? (pinned ? conversationId : null);
    // The pins keep the id, but the key memory can't say whether it is a held group's: with nothing else knowing it, "not a
    // DM" is never answered (SEC1). Every caller fails closed on it: a send refuses, a pass writes nothing of the id, a route
    // and a screen take it as a DM.
    if (known === null && keyMemoryUnread) throw keyMemoryUnread;
    if (known === null && listed === null) throw new DmGuardUnreadError();
    return known;
}

/** The DM list folded once (each id lower-cased, to its spellings in the order seen), for a pass over many rows. */
async function dmConversationsByFold(database?: SQLite.SQLiteDatabase): Promise<Map<string, string[]>> {
    const byFold = new Map<string, string[]>();
    for (const s of await dmConversationsSeen(database)) { const f = s.toLowerCase(); const a = byFold.get(f); if (a) a.push(s); else byFold.set(f, [s]); }
    return byFold;
}

/**
 * A known DM in ANY spelling, the slow way (two COLLATE NOCASE scans): the key-making guard's own check, which runs when a
 * group's keys are about to be synced or made, never per row of a sync. A dm row or a sealed line kept under a mixed-case
 * spelling the DM list never got (written while the key memory couldn't be read) is caught here (#1863 review). With the
 * list unreadable and no spelling known anywhere else, DmGuardUnreadError: no group key is asked on a list it couldn't read.
 * `pinsMustRead` asks the pins strictly: pins that can't be read throw DmPinStoreError.
 */
async function isKnownDmInAnySpelling(conversationId: string, opts: DmGuardAsk = {}): Promise<boolean> {
    let listUnread = false;
    try {
        if (await isKnownDmConversation(conversationId, opts)) return true;
    } catch (e) {
        if (!isDmGuardUnreadError(e)) throw e;
        listUnread = true;
    }
    let found = false;
    try {
        const database = opts.at ?? await getDb();
        const dm = await database.getFirstAsync<any>("SELECT 1 AS y FROM conversations WHERE id = ? COLLATE NOCASE AND type = 'dm' LIMIT 1", [conversationId]);
        const spelt = dm ? [] : await database.getAllAsync<any>('SELECT id FROM conversations WHERE id = ? COLLATE NOCASE', [conversationId]);
        const ids = (spelt ?? []).map((r: any) => r?.id).filter((s: unknown): s is string => typeof s === 'string');
        const line = !dm && ids.length ? await database.getFirstAsync<any>(
            `SELECT 1 AS y FROM messages WHERE conversation_id IN (${ids.map(() => '?').join(', ')}) AND nonce LIKE ? LIMIT 1`, [...ids, `${V2_NONCE_PREFIX}%`]) : null;
        found = !!dm || !!line;
    } catch {
        found = false;
    }
    if (!found && listUnread) throw new DmGuardUnreadError();
    return found;
}

/** True for a conversation this phone has seen as a DM, or that holds an encrypted line, in any spelling of its id. */
export async function isKnownDmConversation(conversationId: string, opts: DmGuardAsk = {}): Promise<boolean> {
    return (await knownDmConversationId(conversationId, undefined, opts)) !== null;
}

/**
 * True if this identity has held keys of a group with this id, read straight from its key memory (the rows GroupKeyring
 * keeps, without opening one), so a sync can ask it of every conversation it writes. Throws when they can't be read.
 * Asked of the id lower-cased, as groupKeyring() keeps the rows: any spelling of a held group's id is held.
 */
async function heldInKeyMemory(conversationId: string, myPub?: string | null, at?: SQLite.SQLiteDatabase): Promise<boolean> {
    const pub = myPub ?? (await loadIdentity())?.publicKey;
    if (!pub || !conversationId) return false;
    const database = at ?? await getDb();
    const key = `${pub}/${conversationId.toLowerCase()}`;
    const st = await database.getFirstAsync<any>('SELECT highest FROM group_chat_key_state WHERE group_id = ?', [key]);
    if (Number(st?.highest ?? 0) > 0) return true;
    return !!(await database.getFirstAsync<any>('SELECT 1 AS y FROM group_chat_epochs WHERE group_id = ? AND wrap IS NOT NULL LIMIT 1', [key]));
}

/**
 * The type this phone keeps for a conversation the node calls `nodeType`. A group whose keys this phone has held stays
 * its group and is never remembered as a DM, whatever the node calls it: one answer typing it `dm` would otherwise move
 * it to the DM screen for good, every line DM-sealed to whoever the node lists (confirmation 2 of #1788, finding 2). A
 * known DM stays one (its pins asked first: §3.4 amendment 7 §3 iv). When the key memory can't be read, this answer
 * remembers nothing as a DM; the next sync asks again. DmGuardUnreadError when the node types it otherwise, nothing else
 * knows it as a DM and the DM list can't be read: the caller writes no row from the node's type (§3.4 amendment 7 §3 iii).
 * `listedLater`: the caller remembers every conversation the node lists as a DM itself, in one write (a sync pass).
 */
async function heldConversationType(conversationId: string, nodeType: string | null | undefined, myPub?: string | null, listedLater = false, database?: SQLite.SQLiteDatabase): Promise<string> {
    const t = nodeType || 'dm';
    let held: boolean | null;
    try { held = await heldInKeyMemory(conversationId, myPub); } catch { held = null; }
    if (held) {
        if (t !== 'group_thread') console.warn(`[group guard] the node calls held group ${String(conversationId).slice(0, 8)} a ${t}: ignored, it stays a group`);
        return 'group_thread';
    }
    if (t === 'dm') {
        if (held !== null && !listedLater) await rememberDmConversations([conversationId], database);
        return 'dm';
    }
    if (await isKnownDmConversation(conversationId, { me: myPub })) {
        console.warn(`[DM guard] the node calls DM ${String(conversationId).slice(0, 8)} a ${t}: ignored, it stays a DM`);
        await rememberDmConversations([conversationId], database);
        return 'dm';
    }
    return t;
}

/**
 * A conversation this phone holds or takes as a DM: the node lists it as one, its row here is one, or the DM guard knows
 * it as one (any doubt: a DM). While the pins can't be read nothing of the node's is written into these (§3.4 amendment 5).
 */
async function isDmHere(database: SQLite.SQLiteDatabase, conversationId: string, nodeType: string | null | undefined): Promise<boolean> {
    if ((nodeType || 'dm') === 'dm') return true;
    const row = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]).catch(() => undefined);
    if (row === undefined || (row && (row.type || 'dm') === 'dm')) return true;
    return await isKnownDmConversation(conversationId).catch(() => true);
}

/**
 * Any conversation this phone holds under another type that is a known DM goes back to being one (logged). With the DM
 * list unreadable the pins, the rows and the lines still decide; the list is never read as empty, and nothing is written to it.
 */
async function holdDmTypes(database?: SQLite.SQLiteDatabase): Promise<void> {
    try {
        const db = database ?? await getDb();
        const rows = await db.getAllAsync<any>("SELECT id, type FROM conversations WHERE IFNULL(type, 'dm') != 'dm'");
        if (!rows?.length) return;
        const byFold = await dmConversationsByFold(db).catch(() => null);
        const me = (await loadIdentity().catch(() => null))?.publicKey ?? null;
        for (const r of rows) {
            if (r?.id && (await knownDmConversationId(r.id, byFold, { me }).catch(() => null)) !== null) {
                console.warn(`[DM guard] DM ${String(r.id).slice(0, 8)} was held as a ${r.type}: back to a DM`);
                await db.runAsync("UPDATE conversations SET type = 'dm' WHERE id = ?", [r.id]);
                await rememberDmConversations([r.id], db);
            }
        }
    } catch {}
}

/**
 * The kind of conversation this phone keeps for an id. `askNode`: with no row yet (a push tap, a link before the sync),
 * ask the node once and keep its answer (the DM guard and the held guard applied), so a group's chat opens in its own
 * screen rather than the DM one (confirmation 2 of #1788, finding 3).
 */
export async function getConversationKind(conversationId: string, opts: { askNode?: boolean } = {}): Promise<string | null> {
    try {
        const database = await getDb();
        let row = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]);
        if (!row && opts.askNode) {
            await refreshConversationFromNode(conversationId);
            row = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]);
        }
        const type = row?.type ?? null;
        // A known DM is a DM, whatever type its row says, or with no row (the node dropped it): the DM guard above.
        if (type !== 'dm' && await isKnownDmConversation(conversationId)) return 'dm';
        return type;
    } catch {
        return null;
    }
}

// Enterprise Season & Wind-up (docs/the-commons.md §2.2). Same routes the web app calls. The server takes the
// actor from the signature only and decides who may act; these throw the server's own error message.
export async function pauseEnterprise(treasury: string): Promise<{ success: boolean; paused: boolean; pausedAt: string; pausedFloorSnapshot_c?: number; alreadyPaused?: boolean }> {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/pause`, {});
}

export async function resumeEnterprise(treasury: string): Promise<{ success: boolean; paused: boolean; alreadyActive?: boolean }> {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/resume`, {});
}

export async function initiateWindUp(treasury: string): Promise<{ success: boolean; status: string; initiatedAt: string; initiatedBy: string; graceEndsAt: string; alreadyInitiated?: boolean }> {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/wind-up/initiate`, {});
}

export async function cancelWindUp(treasury: string): Promise<{ success: boolean; status: string }> {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/wind-up/cancel`, {});
}

/** `sweptAmount`: what went to the Commons, whole hundredths of a Bean (the node keeps the name: a listed deviation of M1). */
export async function finaliseWindUp(treasury: string): Promise<{ success: boolean; status: string; finalisedAt: string; sweptAmount: number; alreadyCompleted?: boolean }> {
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/wind-up/finalise`, {});
}

/**
 * One line of an enterprise's income & spend. Every figure is whole hundredths of a Bean: `amount_c` and `fee_c` as the
 * node names them, and `netAmount` and `runningBalance`, which keep their names on the node (M1's listed deviations).
 */
export interface EnterpriseLedgerEntry {
    id: string;
    timestamp: string;
    direction: 'income' | 'spend';
    amount_c: number;
    fee_c: number;
    netAmount: number;
    counterparty: string;
    counterpartyName: string;
    memo: string;
    runningBalance: number;
    authSigner: string | null;
}

export interface EnterpriseLedgerResponse {
    enterprise: { publicKey: string; name: string; purpose: string | null; status: string; paused: boolean; balance_c: number };
    period: { since: string | null; until: string | null };
    /** The totals and balances, whole hundredths of a Bean (their names kept on the node). */
    summary: {
        totalIncome: number;
        totalSpend: number;
        netChange: number;
        startingBalance: number;
        endingBalance: number;
        transactionCount: number;
    };
    entries: EnterpriseLedgerEntry[];
}

/**
 * The enterprise's income & spend (P&L), public to every member. Throws rather than returning null so the
 * screen can say it could not load and offer a retry, instead of showing an empty ledger as if nothing happened.
 */
export async function getEnterpriseLedger(treasury: string, opts?: { since?: string; until?: string; limit?: number }): Promise<EnterpriseLedgerResponse> {
    const params = new URLSearchParams();
    if (opts?.since) params.set('since', opts.since);
    if (opts?.until) params.set('until', opts.until);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const res = await signedGet(`/api/enterprise/${encodeURIComponent(treasury)}/ledger${qs ? `?${qs}` : ''}`);
    if (!res.ok) {
        const errJson = await res.json().catch(() => ({} as any));
        throw new Error(errJson?.error || `Could not load enterprise ledger (${res.status})`);
    }
    return await res.json();
}

// ===================== COMMUNITY DECISIONS (§3.2–§3.8) =====================

export type DecisionTouch = 'member' | 'pool';
export type DecisionFranchise = '1m1v' | 'quadratic_trade';
export type DecisionStatus =
    | 'open'
    | 'passed'
    | 'failed'
    | 'unresolved'
    | 'passed_queued_for_funds'
    | 'execution_pending_grace'
    | 'execution_blocked'
    | 'execution_void'
    | 'executed'
    | 'admin_halted';

export type DecisionEffect =
    | 'suspend_member'
    | 'unsuspend_member'
    | 'freeze_credit'
    | 'unfreeze_credit'
    | 'remove_lead_keeper'
    | 'reinstate_member'
    /**
     * "Keep this suspension?": opened by the node when an admin suspended someone before removal by vote S2 (an admin's
     * pause now opens a remove_member vote, utils/decision-card.ts isPauseVote), and still the record of a pause where
     * formal Decisions are off. Never proposed by a member.
     */
    | 'keep_suspension'
    | 'remove_member'
    | 'grant_enterprise'
    | 'grant_hardship'
    | 'write_off_deficit'
    /** A departed member's open debt, by its record id (#1597): no Beans move; the record is marked forgiven. */
    | 'forgive_debt';

export interface Decision {
    id: string;
    authorPubkey: string;
    title: string;
    description: string;
    touches: DecisionTouch;
    effect: DecisionEffect;
    subject: string | null;
    params: any | null;
    franchise: DecisionFranchise;
    status: DecisionStatus;
    opensAt: string;
    closesAt: string;
    gracePeriodEndsAt: string | null;
    createdAt: string;
    executedAt: string | null;
    executionError: string | null;
    executionReason: string | null;
    adminHaltedAt: string | null;
    adminHaltReason: string | null;
    updatedAt: string;
    /** A vote on removing a member: the member's own reply to its case, and when they wrote it (null until they do). */
    subjectReply?: string | null;
    subjectRepliedAt?: string | null;
    /** A vote on removing a member whose case an admin hid as shown to be false: when, and their public reason. */
    caseHiddenAt?: string | null;
    caseHiddenReason?: string | null;
    /** A vote on removing a member whose reply an admin took down: when, and their public reason (the reply itself is gone). */
    replyHiddenAt?: string | null;
    replyHiddenReason?: string | null;
    /**
     * A pause's own vote too few members could vote on, which an owner decided (removal by vote S6): when, the owner's public
     * reason (null once an admin has hidden the case: it may repeat the accusation), and when the vote closed with it carried
     * out (null if enough members voted by then, and they decided).
     */
    ownerDecidedAt?: string | null;
    ownerDecidedReason?: string | null;
    ownerDecisionCarriedAt?: string | null;
    /** A vote on removing a member: who brought it, by name (absent from a node from before). */
    proposer?: RemovalProposer;
}

/**
 * Who brought a vote on removing a member, as the node names them (removal by vote, Amendment A point 3): an admin who
 * paused them, an owner who did with the server's password (no name), or a member who proposed it before proposing one
 * closed. `name` is null when the node can't know it.
 */
export interface RemovalProposer {
    kind: 'admin' | 'owner' | 'password' | 'member';
    name: string | null;
}

export interface DecisionTally {
    decisionId: string;
    status: DecisionStatus;
    totalVoters: number;
    /** Members who could vote on this Decision and were active in the last 30 days: the turnout base. */
    electorate: number;
    /** Share of the electorate that must vote: 0.30, or 0.25 to remove a member. */
    quorumRatio: number;
    quorumRequired: number;
    quorumMet: boolean;
    yesWeight: number;
    noWeight: number;
    totalWeight: number;
    supportRatio: number;
    thresholdRequired: number;
    passed: boolean;
    /** A vote on removing a member: the fewest Yes votes that remove them, whatever the share (3; absent from a node from before). */
    minYes?: number;
    /** A pause's own vote fewer than 3 members could vote on, so its quorum can't be met: an owner may decide it. */
    tooFewToVote?: boolean;
    /**
     * A vote a drawn jury decides (removal jury J1): while it is open the node sends `turnout` and none of the split
     * (yesWeight, noWeight, totalWeight, supportRatio, passed are absent then), so the card counts jurors (J2a, J3).
     */
    decider?: 'jury';
    turnout?: JuryTurnout;
}

export interface DecisionWithTally extends Decision {
    tally: DecisionTally;
    /** The signed caller's own vote on this Decision; null when they haven't voted. Never anyone else's. */
    myVote?: OwnDecisionVote | null;
}

/**
 * The signer's standing for votes on community money: voice credits = the number the node checks a vote's
 * cost against (qualified value of completed trades). A fresh allowance on each pool Decision.
 */
export interface MyPoolVoting {
    voiceCredits: number;
    hasCompletedTrade: boolean;
}

/**
 * canPropose: whether the signer may propose (a completed trade, or a node admin), per the node's own rule.
 * Null when the list loaded unsigned, so the caller falls back rather than blocking a member who may.
 */
export async function getDecisions(status?: string): Promise<{ decisions: DecisionWithTally[]; myPoolVoting: MyPoolVoting | null; canPropose: boolean | null }> {
    const rawUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!rawUrl) return { decisions: [], myPoolVoting: null, canPropose: null };
    try {
        const path = `/api/commons/decisions${status ? `?status=${encodeURIComponent(status)}` : ''}`;
        // The list is a public read. It is signed only so the node can return this member's own vote on each card
        // and their voice credits for money votes.
        let res = await signedGet(path);
        // A phone whose clock is off gets 401 for the signature; the list still loads unsigned, just without "you voted".
        const signed = res.status !== 401;
        if (!signed) res = await fetch(`${rawUrl}${path}`, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return { decisions: [], myPoolVoting: null, canPropose: null };
        const data = await res.json();
        return {
            decisions: data.decisions || [],
            myPoolVoting: data.myPoolVoting ?? null,
            canPropose: signed && typeof data.canPropose === 'boolean' ? data.canPropose : null,
        };
    } catch {
        return { decisions: [], myPoolVoting: null, canPropose: null };
    }
}

/** Totals and the signer's own vote only: ballots are secret, the node never says who voted how. */
export async function getDecision(id: string): Promise<{ decision: Decision; tally: DecisionTally; myVote?: OwnDecisionVote | null } | null> {
    const rawUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!rawUrl) return null;
    try {
        const res = await signedGet(`/api/commons/decisions/${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

export async function createDecision(payload: {
    authorPubkey: string;
    title: string;
    description: string;
    touches: DecisionTouch;
    effect: DecisionEffect;
    subject?: string | null;
    params?: any;
    closesAt?: string;
}): Promise<{ success: boolean; decision: Decision }> {
    // A decision's subject can be an enterprise's key, its thread's id: a known DM's id refuses first (#1938 confirmation 8).
    if (payload.subject) await refuseReadableIntoDm(payload.subject);
    return _signedRequest('/api/commons/decisions', payload);
}

export async function castDecisionVote(decisionId: string, payload: {
    voterPubkey: string;
    support: boolean;
    voteCount?: number;
    signature?: string;
}): Promise<{ success: boolean; creditsUsed: number }> {
    return _signedRequest(`/api/commons/decisions/${encodeURIComponent(decisionId)}/vote`, payload);
}

/**
 * The member a vote on removing them is about replies to its case (removal by vote, Amendment A point 2): their words,
 * shown beside the case to everyone who reads the vote. Signed; the node takes it from them alone, while the vote is open.
 */
export async function replyToRemovalCase(decisionId: string, reply: string): Promise<{ success: boolean }> {
    return _signedRequest(`/api/commons/decisions/${encodeURIComponent(decisionId)}/reply`, { reply });
}

/**
 * The member a vote on removing them is about reports its case as a false accusation (Amendment A point 4): a report about
 * whoever brought it, for the admins and owners. Signed; the node takes it from that member alone.
 */
export async function reportRemovalCase(decisionId: string): Promise<{ success: boolean; duplicate?: boolean }> {
    return _signedRequest(`/api/commons/decisions/${encodeURIComponent(decisionId)}/report`, {});
}

/**
 * The jury of a vote a jury decides (removal jury, GET …/jury): its pool, the draw's facts and the signer's own seat, and
 * after close who voted and who didn't serve. Signed: the node answers members only. Null for a vote no jury decides (and
 * from a node older than the route); throws when the node can't be reached, so the card can offer to try again.
 */
export async function getDecisionJury(decisionId: string): Promise<ServedJury | null> {
    const res = await signedGet(`/api/commons/decisions/${encodeURIComponent(decisionId)}/jury`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    const data = await res.json();
    return data?.jury ?? null;
}

/** A seated juror's answer to their seat (J2b): Serve, or Step aside (no reason asked). The node answers with their jury read. */
export async function answerJurySeat(decisionId: string, answer: 'serve' | 'step_aside'): Promise<{ success: boolean; jury: ServedJury | null }> {
    return _signedRequest(`/api/commons/decisions/${encodeURIComponent(decisionId)}/jury/answer`, { answer });
}

export async function updatePost(id: string, updates: any) {
    const identity = await loadIdentity();
    if (!identity) throw new Error('Not logged in. Identity required.');
    // A post's id is its event chat's id: a known DM's id refuses first, as updateEvent does (#1938 confirmation 8).
    await refuseReadableIntoDm(id);

    const photos = updates.photos !== undefined
        ? (Array.isArray(updates.photos) ? updates.photos : (typeof updates.photos === 'string' && updates.photos ? JSON.parse(updates.photos) : []))
        : undefined;

    const tags = updates.tags !== undefined
        ? (Array.isArray(updates.tags) ? updates.tags : postTagsOf(updates.tags))
        : undefined;

    // Named only when the member changed them: absent leaves them on the node and in the copy, [] clears them.
    const freeTags: string[] | undefined = updates.freeTags !== undefined ? freeTagsOf(updates.freeTags) : undefined;

    // 1. Broadcast UPDATE to remote network
    await _signedRequest('/api/marketplace/posts/update', { 
        id, 
        authorPublicKey: identity.publicKey, 
        type: updates.type,
        category: updates.category,
        title: updates.title,
        description: updates.description,
        // Whole hundredths of a Bean (the edit's typed price through core parseHundredths), as the node takes it.
        price_c: updates.price_c,
        priceType: updates.price_type || 'fixed',
        repeatable: updates.repeatable,
        photos,
        // A listing priced for each one (§4.6): the count, the count the screen read, and the price for all of them
        // (`{ price_c }` sets it, null clears it, absent keeps it).
        ...(updates.price_type === 'each' ? {
            unitsLeft: updates.unitsLeft,
            ...(updates.unitsLeftWas !== undefined ? { unitsLeftWas: updates.unitsLeftWas } : {}),
            ...(updates.lot !== undefined ? { lot: updates.lot } : {}),
        } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(freeTags !== undefined ? { freeTags } : {}),
        // The edit's "Put this in your shop" (slice S4′): the shop's id puts it in, null takes it out; unnamed, it stays.
        ...(updates.shopId !== undefined ? { shopId: updates.shopId } : {}),
    });
    repeatOnGlobalCopy((copy) => copy.tendCopies(identity));

    // 2. Erase from local SQLite Cache (or gracefully update it)
    const database = await getDb();
    const tagsSql = `${tags !== undefined ? ', tags = ?' : ''}${freeTags !== undefined ? ', free_tags = ?' : ''}`;
    const tagsArg = [...(tags !== undefined ? [tags.join(' ')] : []), ...(freeTags !== undefined ? [storedFreeTags(freeTags)] : [])];
    if (photos !== undefined) {
        const photosJson = photos && photos.length > 0 ? JSON.stringify(photos) : null;
        await database.runAsync(
            `UPDATE posts SET type = ?, category = ?, title = ?, description = ?, price_c = ?, price_type = ?, repeatable = ?, photos = ?${tagsSql} WHERE id = ?`,
            [updates.type, updates.category, updates.title, updates.description, updates.price_c, updates.price_type || 'fixed', updates.repeatable ? 1 : 0, photosJson, ...tagsArg, id]
        );
    } else {
        await database.runAsync(
            `UPDATE posts SET type = ?, category = ?, title = ?, description = ?, price_c = ?, price_type = ?, repeatable = ?${tagsSql} WHERE id = ?`,
            [updates.type, updates.category, updates.title, updates.description, updates.price_c, updates.price_type || 'fixed', updates.repeatable ? 1 : 0, ...tagsArg, id]
        );
    }
}

/** Pause an Offer (owner-only): drops it from the live feed and stops it counting toward the
 *  offer covenant / credit line (Trust Model v3). Reversible via resumePost. */
export async function pausePost(id: string) {
    const identity = await loadIdentity();
    if (!identity) throw new Error('Not logged in. Identity required.');
    await _signedRequest('/api/marketplace/posts/pause', { postId: id, authorPublicKey: identity.publicKey });
    repeatOnGlobalCopy((copy) => copy.tendCopies(identity));
    const database = await getDb();
    await database.runAsync(`UPDATE posts SET status = 'paused' WHERE id = ?`, [id]);
    refreshBalanceFromServer(identity.publicKey).catch(() => null);
}

/** Re-activate a paused Offer (owner-only): back in the feed and counting toward the credit line. */
export async function resumePost(id: string) {
    const identity = await loadIdentity();
    if (!identity) throw new Error('Not logged in. Identity required.');
    await _signedRequest('/api/marketplace/posts/resume', { postId: id, authorPublicKey: identity.publicKey });
    repeatOnGlobalCopy((copy) => copy.tendCopies(identity));
    const database = await getDb();
    await database.runAsync(`UPDATE posts SET status = 'active' WHERE id = ?`, [id]);
    refreshBalanceFromServer(identity.publicKey).catch(() => null);
}

export async function deletePost(id: string) {
    // 1. Enforce Online Connection & Broadcast First
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('Action requires internet connection.');

    const identity = await loadIdentity();
    if (!identity) throw new Error('Not logged in. Identity required.');
    // What the listing was, for its copy on global (utils/show-on-global.ts stopShowingGone): read before the row goes.
    const gone = await goneListingOf(id);

    const payload = JSON.stringify({ id, authorPublicKey: identity.publicKey });
    const headers = await buildSignedHeaders('POST', `${anchorUrl}/api/marketplace/posts/remove`, payload, identity.privateKey, identity.publicKey);

    // Only a send that never got an answer is "offline". The node's refusal is its own sentence, in the member's language (a listing
    // priced for each one can be deleted by a phone seller while buyers hold some of it; the node refuses, and says why): not wrapped.
    let res: Response;
    try {
        res = await fetch(`${anchorUrl}/api/marketplace/posts/remove`, {
            method: 'POST',
            headers,
            body: payload
        });
    } catch (e: any) {
        throw new Error(`Offline or anchor node unreachable: ${e.message}`);
    }
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to remove post on Node');
    }

    repeatOnGlobalCopy((copy) => (gone ? copy.stopShowingGone(gone, identity) : copy.stopShowing(id, identity)));

    // 2. Erase from local SQLite Cache
    const database = await getDb();
    await database.runAsync('DELETE FROM posts WHERE id = ?', [id]);
    refreshBalanceFromServer(identity.publicKey).catch(() => null);
}

/** A cached post as core's copy keeper weighs whether it could have had a copy on global (mayShowOnGlobal). Null if not cached. */
async function goneListingOf(id: string): Promise<import('@beanpool/core').ShowableListing & { id: string } | null> {
    try {
        const row: any = await (await getDb()).getFirstAsync('SELECT type, lat, lng, audience_scope, author_pubkey, origin_node, event_online FROM posts WHERE id = ?', [id]);
        if (!row) return null;
        return {
            id, type: row.type, lat: row.lat, lng: row.lng, audienceScope: row.audience_scope ?? 'public', authorPublicKey: row.author_pubkey,
            originNode: row.origin_node ?? null, eventOnline: row.event_online === 1,
        };
    } catch {
        return null;
    }
}

/**
 * Would writing this synced member row actually CHANGE the viewer's own profile?
 *
 * The header (and anything else that listens for `profile_updated`) only ever heard about
 * LOCAL edits, because `updateMemberProfile` was the single emitter. A photo or name changed
 * on the PWA or on another device arrives by sync instead, and nothing told the header — so
 * the old picture stayed in the pill until the app restarted.
 *
 * Called from inside the sync transaction, BEFORE the upsert, so it can compare against what
 * the row holds now. The emit itself waits until the transaction has committed: telling the UI
 * to re-read a row a rollback is about to undo would put the stale value straight back.
 *
 * "A real change" matches the upsert's own semantics. Both sync loops write
 * `callsign = excluded.callsign` unconditionally; a null avatar is a change only when the
 * upsert would actually act on it, which is what `avatarClears` says. In a PARTIAL member list
 * the avatar is COALESCEd and a null leaves the stored one alone, so it is not a change —
 * without that the event would fire on every poll and the header would re-read on every sync
 * tick for nothing. In the node's COMPLETE list a null CLEARS the row, so it is a change, and
 * the header must re-read or it would go on showing a photo the node no longer has.
 *
 * A new `profile_updated_at` is a change too (the upsert COALESCEs it, so only a value it names): a node from before
 * versioned face URLs keeps one address for every photo, and the header's avatar busts its image cache with that stamp
 * (MemberAvatar `updatedAt`). Without it a new photo there stayed the old one from the phone's disk cache for good.
 */
async function ownProfileRowWouldChange(
    txn: any,
    selfPubkey: string | null,
    pk: string,
    incomingCallsign: string,
    incomingAvatar: string | null,
    avatarClears = false,
    incomingUpdatedAt: string | null = null,
): Promise<boolean> {
    if (!selfPubkey || pk !== selfPubkey) return false;
    const before = await txn.getFirstAsync(
        'SELECT callsign, avatar_url FROM members WHERE public_key = ?',
        [pk]
    ) as { callsign: string | null; avatar_url: string | null } | null;
    if (!before) return Boolean(incomingCallsign || incomingAvatar);
    if (incomingCallsign !== (before.callsign ?? '')) return true;
    if (incomingAvatar !== null && incomingAvatar !== before.avatar_url) return true;
    if (incomingAvatar === null && avatarClears && before.avatar_url !== null) return true;
    if (incomingUpdatedAt !== null) {
        const held = await txn.getFirstAsync('SELECT profile_updated_at FROM members WHERE public_key = ?', [pk]) as { profile_updated_at: string | null } | null;
        if (incomingUpdatedAt !== (held?.profile_updated_at ?? null)) return true;
    }
    return false;
}

/** Fire `profile_updated` for a sync that really did change the viewer's own row. */
function emitOwnProfileUpdated(pubkey: string): void {
    emitAppEvent('profile_updated', { pubkey });
}

/**
 * The `poll_new_or_words_votes` column for a poll as the node sent it: how many of its votes came from new or 12-word
 * accounts (@beanpool/core poll-vote-origins), or NULL where the node says nothing (a local community, a group's poll).
 */
function pollNewOrWordsVotesColumn(p: any): number | null {
    const n = p?.pollNewOrWordsVotes ?? p?.poll_new_or_words_votes;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** The `photos` column writeSyncedPost stores for a listing from the node: its URLs, never a local file's. */
function syncedPhotosColumn(p: any): string | null {
    return p.photos ? JSON.stringify(p.photos.filter((url: string) => !url.startsWith('file://'))) : null;
}

/**
 * The node says this member has answered a sealed poll, perhaps on the web or before a reinstall, and that is all it can say
 * (@beanpool/core poll-other). Kept as this phone keeps its own votes, so the card says so with no answer ticked: no answer
 * has this id. An answer this phone gave stays as it is.
 */
async function noteSealedAnswer(txn: SQLite.SQLiteDatabase, p: any): Promise<void> {
    if (p?.pollAnswered !== true) return;
    const me = (await loadIdentity())?.publicKey;
    if (!me) return;
    await txn.runAsync('INSERT OR IGNORE INTO poll_votes (post_id, voter_pubkey, option_id, signature) VALUES (?, ?, ?, ?)', [p.id, me, POLL_BALLOT_SEALED, '']);
}

/**
 * One page of Local knowledge as the node sends it (the sync reads pages only because the phone names the type: utils/events.ts
 * SYNC_TYPES_QUERY). Kept whole as JSON in its own table, with what Learn lists by beside it. A page the node tombstones
 * (`active: 0`, or a status that isn't 'active') stays as an inactive row, so a page taken down leaves Learn at the next sync;
 * the Market reads `posts` alone and never meets one.
 */
async function writeKnowledgePost(txn: SQLite.SQLiteDatabase, p: any): Promise<void> {
    if (typeof p?.id !== 'string' || !p.id) return;
    const showing = p.active !== 0 && p.active !== false && (p.status === undefined || p.status === 'active');
    const checkedAt = typeof p.knowledge?.checkedAt === 'string' ? p.knowledge.checkedAt : (p.createdAt ?? p.created_at ?? null);
    await txn.runAsync(
        'INSERT OR REPLACE INTO knowledge_posts (id, topic, post, checked_at, updated_at, active) VALUES (?, ?, ?, ?, ?, ?)',
        [p.id, typeof p.category === 'string' ? p.category : '', JSON.stringify(p), checkedAt, p.updatedAt ?? p.updated_at ?? p.createdAt ?? null, showing ? 1 : 0]);
}

/**
 * A page as the copy holds it, its pictures' paths put on `community`, the community whose copy it is, as a listing's are (getPost):
 * the copy keeps a page as the node sent it, paths and all, so a page kept by an earlier build draws its pictures too (review of
 * #3355). Null when the row doesn't read: it is no page, and the next sync writes it again.
 */
function knowledgePageOf(post: string, community: string | null): any | null {
    try {
        const page = JSON.parse(post);
        if (!page || !Array.isArray(page.photos)) return page ?? null;
        return { ...page, photos: page.photos.map((p: unknown) => (typeof p === 'string' ? photoOnCommunity(community, p) : p)) };
    } catch {
        return null;
    }
}

/**
 * Every page of Local knowledge this phone holds that is showing, as the node sent it, its pictures on the community's own address
 * (knowledgePageOf). The copy and its address are taken together (chatCopyForRequest), so a page read as the phone switches community
 * is never drawn from the other one's address. Learn groups and orders them (utils/learn-copy.ts).
 */
export async function getKnowledgePosts(): Promise<any[]> {
    const { database, anchorUrl } = await chatCopyForRequest();
    const rows = await database.getAllAsync<{ post: string }>('SELECT post FROM knowledge_posts WHERE active = 1');
    return rows.map((r) => knowledgePageOf(r.post, anchorUrl)).filter((page) => page !== null);
}

/** One page this phone holds, showing, its pictures on its community's own address (as getKnowledgePosts), or null. */
export async function getKnowledgePost(id: string): Promise<any | null> {
    const { database, anchorUrl } = await chatCopyForRequest();
    const row = await database.getFirstAsync<{ post: string }>('SELECT post FROM knowledge_posts WHERE id = ? AND active = 1', [id]);
    return row ? knowledgePageOf(row.post, anchorUrl) : null;
}

/**
 * One listing as the node sends it, written to the cache. The only row writer the delta sync, a pushed change and
 * the by-id refresh in getPost use. It names every column the node sends: INSERT OR REPLACE does not keep a column
 * it leaves out, it puts it back to the table default, which is how every sync once cleared the 💸 marker and
 * turned a group or direct listing into a public one. `target_archetypes` is the one column left out; the node never
 * sends it and nothing reads it.
 */
async function writeSyncedPost(txn: SQLite.SQLiteDatabase, p: any): Promise<void> {
    // A page of Local knowledge goes to its own table and never into `posts` (writeKnowledgePost).
    if (p?.type === 'knowledge') return writeKnowledgePost(txn, p);
    await noteSealedAnswer(txn, p);
    const reach = p.reach || 'local';
    await txn.runAsync(
        'INSERT OR REPLACE INTO posts (id, type, category, title, description, price_c, author_pubkey, lat, lng, photos, price_type, repeatable, cash_also_needed, lendable, status, active, accepted_by, accepted_by_callsign, accepted_at, completed_at, pending_transaction_id, created_at, updated_at, origin_node, author_energy_cycled, author_founding_needed, reach, reach_peers, poll_options, poll_closes_at, poll_open_vote, poll_new_or_words_votes, audience_scope, target_group_id, target_pubkey, assigned_to, tags, free_tags, event_start_at, event_end_at, event_place_name, event_state, event_going_count, event_interested_count, event_start_local, event_end_local, event_tz, event_online, event_repeat, event_repeat_until, event_repeat_skips, shown_from, carried_callsign, carried_avatar, carried_banner, pinned_until, pinned_at, units_left, lot_price_c, lot_units) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT carried_callsign FROM posts WHERE id = ?)), CASE WHEN ? THEN ? ELSE (SELECT carried_avatar FROM posts WHERE id = ?) END, ?, ?, ?, ?, ?, ?)',
        [
            p.id ?? null,
            p.type ?? null,
            p.category ?? null,
            p.title ?? null,
            p.description ?? '',
            // Whole hundredths of a Bean (the node's price_c); anything else is no price (null, shown "—"), never Free.
            isHundredths(p.price_c) && p.price_c >= 0 ? p.price_c : null,
            p.author_pubkey || p.authorPubkey || p.authorPublicKey || null,
            p.lat ?? null,
            p.lng ?? null,
            syncedPhotosColumn(p),
            p.price_type || p.priceType || 'fixed',
            p.repeatable ? 1 : 0,
            (p.cashAlsoNeeded ?? p.cash_also_needed) ? 1 : 0,
            (p.lendable === true || p.lendable === 1) ? 1 : 0,
            p.status || 'active',
            p.active !== undefined ? (p.active ? 1 : 0) : 1, // Defaulting to 1 if active boolean isn't provided
            p.accepted_by || p.acceptedBy || null,
            p.accepted_by_callsign || p.acceptedByCallsign || null,
            p.accepted_at || p.acceptedAt || null,
            p.completed_at || p.completedAt || null,
            p.pending_transaction_id || p.pendingTransactionId || null,
            p.created_at || p.createdAt || null,
            p.updated_at || p.updatedAt || null,
            p.origin_node || p.originNode || null,
            p.author_energy_cycled ?? p.authorEnergyCycled ?? 0,
            p.author_founding_needed !== undefined ? (p.author_founding_needed ? 1 : 0) : (p.authorFoundingNeeded ? 1 : 0),
            reach,
            await syncedReachPeers(txn, p, reach),
            p.poll_options ? (typeof p.poll_options === 'string' ? p.poll_options : JSON.stringify(p.poll_options)) : (p.pollOptions ? JSON.stringify(p.pollOptions) : null),
            p.poll_closes_at || p.pollClosesAt || null,
            // Every column is written here (INSERT OR REPLACE), so the ballot too: an open vote only when the node says so.
            (p.pollOpenVote ?? p.poll_open_vote) === true || (p.pollOpenVote ?? p.poll_open_vote) === 1 ? 1 : 0,
            pollNewOrWordsVotesColumn(p),
            // The node sends 'public' for a row with no scope (rowToPost); the table's default says the same.
            p.audienceScope || p.audience_scope || 'public',
            p.targetGroupId || p.target_group_id || null,
            p.targetPubkey || p.target_pubkey || null,
            p.assignedTo || p.assigned_to || null,
            syncedTagsColumn(p),
            syncedFreeTagsColumn(p),
            ...eventCacheColumns(p),
            eventCopyColumn(p),
            // A copy without the name (an older node) keeps the one the row has.
            syncedAuthorCallsign(p),
            p.id ?? null,
            // Its face: a copy that names it (a node that has members on demand) is the node's word, and its null says the
            // author has no photo now, so it clears; a copy without the field (an older node) keeps the one the row has.
            carriesAuthorAvatar(p) ? 1 : 0,
            syncedAuthorAvatar(p),
            p.id ?? null,
            syncedAuthorBanner(p),
            p.pinnedUntil || p.pinned_until || null,
            p.pinnedAt || p.pinned_at || null,
            ...syncedItemColumns(p),
        ]
    );
}

/**
 * The three per-item columns of a listing from the node (core per-item.ts): its count and the price for all of them with the
 * number it is for, written only for a listing priced for each one that carries a whole count; NULL on every other listing, and
 * on one from an older node that sent none, which then reads as it always did.
 */
function syncedItemColumns(p: any): [number | null, number | null, number | null] {
    const each = perItemOf(p);
    if (!each) return [null, null, null];
    return [each.unitsLeft ?? null, each.lot?.price_c ?? null, each.lot?.units ?? null];
}

function syncedTagsColumn(p: any): string {
    const raw = p.tags;
    if (!raw) return '';
    if (Array.isArray(raw)) return raw.filter(Boolean).join(' ');
    if (typeof raw === 'string') return raw;
    return '';
}

/** The `free_tags` column for a listing from the node: named only where there are some, so a copy with none clears them. */
function syncedFreeTagsColumn(p: any): string {
    return storedFreeTags(listingFreeTags(p));
}

/** The author's face URL a listing carries (the node's `authorAvatarUrl` on a by-area read), or null for a copy without one. */
function syncedAuthorAvatar(p: any): string | null {
    const url = p.authorAvatarUrl ?? p.author_avatar_url;
    return typeof url === 'string' && url.trim() !== '' ? url : null;
}

/**
 * The enterprise's shop banner a listing carries (the node's `authorBannerUrl`, Pictures S6), or null. Unlike the face, a
 * copy without it clears the row's: the node names a banner only where the enterprise has one (engine rowToPost) and never
 * as null, so a copy without it says there is none now (a member's listing, a shop photo removed, a reader who is no
 * longer a member); an older node never names one, so there is nothing to keep.
 */
function syncedAuthorBanner(p: any): string | null {
    const url = p.authorBannerUrl ?? p.author_banner_url;
    return typeof url === 'string' && url.trim() !== '' ? url : null;
}

/** Whether a listing names its author's face at all (`authorAvatarUrl`, null included), as a by-area read does. */
function carriesAuthorAvatar(p: any): boolean {
    return p != null && (Object.prototype.hasOwnProperty.call(p, 'authorAvatarUrl') || Object.prototype.hasOwnProperty.call(p, 'author_avatar_url'));
}

/** The author's name a listing carries (the node's `authorCallsign`), or null for a copy without one. */
function syncedAuthorCallsign(p: any): string | null {
    // A read that names nobody says so: '' and not null, which keeps what the row holds. A copy whose member stopped taking
    // questions must not go on naming them here (@beanpool/core eventCopyOf).
    if ((p.authorPublicKey ?? p.author_pubkey) === HIDDEN_AUTHOR) return '';
    const name = p.authorCallsign ?? p.author_callsign;
    return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/**
 * The `reach_peers` to store with a listing. The node gives the list to the listing's author alone (getPosts) and
 * takes it off every broadcast (publicBroadcastPost), so a copy without it says nothing about the list and the row
 * keeps what it holds: for anyone but the author that is nothing, since only the author's own reads ever carry it.
 * The list means something only while reach is 'peers'; any other reach clears it.
 */
async function syncedReachPeers(txn: SQLite.SQLiteDatabase, p: any, reach: string): Promise<string | null> {
    if (reach !== 'peers') return null;
    const peers = p.reachPeers ?? p.reach_peers;
    if (Array.isArray(peers)) return JSON.stringify(peers);
    const held = await txn.getFirstAsync<{ reach_peers: string | null }>('SELECT reach_peers FROM posts WHERE id = ?', [p.id]);
    return held?.reach_peers ?? null;
}

/**
 * A community that refuses this phone its listings (a members_only answer, services/pillar-sync.ts): every listing this
 * phone cached of it goes, with its poll votes and RSVPs, but the phone's own posts and everything of its own member's
 * (messages, deals, Beans) stay. Only this community's database is written: applyDelta checks it is the one asked.
 * The next sync that may read the listings is a whole one (pillar-sync drops the cursor).
 */
async function dropListingsOfARefusedCommunity(txn: SQLite.SQLiteDatabase, selfPubkey: string | null): Promise<void> {
    // Without the phone's own key it can't tell its own posts from the others': drop nothing.
    if (!selfPubkey) return;
    const own = selfPubkey;
    const others = 'SELECT id FROM posts WHERE author_pubkey IS NOT ?';
    await txn.runAsync(`DELETE FROM poll_votes WHERE post_id IN (${others})`, [own]);
    await txn.runAsync(`DELETE FROM event_rsvps WHERE post_id IN (${others})`, [own]);
    const gone = await txn.runAsync('DELETE FROM posts WHERE author_pubkey IS NOT ?', [own]);
    if (gone.changes > 0) console.log(`[DB] applyDelta: ${gone.changes} listing(s) of a community that keeps its listings for its members left this phone`);
    // Its pages of Local knowledge are its members' too: a phone the community refused keeps none.
    await txn.runAsync('DELETE FROM knowledge_posts');
}

/**
 * After a take-over, the listings the whole pull `posts` shows the node no longer has go (utils/posts-replace.ts says
 * which: its rule, and why).
 */
async function dropPostsTheNodeNoLongerHas(txn: SQLite.SQLiteDatabase, posts: any[], sentOnly: unknown): Promise<void> {
    const held = await txn.getAllAsync<HeldListing>('SELECT id, COALESCE(updated_at, created_at) AS at, audience_scope AS scope FROM posts');
    const gone = postsTheNodeNoLongerHas(posts, held, new Set(Array.isArray(sentOnly) ? sentOnly.map(String) : []));
    for (let i = 0; i < gone.length; i += 500) {
        const batch = gone.slice(i, i + 500);
        await txn.runAsync(`DELETE FROM posts WHERE id IN (${batch.map(() => '?').join(',')})`, batch);
    }
    if (gone.length > 0) console.log(`[DB] applyDelta: ${gone.length} listing(s) the node no longer has left this phone`);
    // The same rule for the pages of Local knowledge, which the pull carries (utils/events.ts SYNC_TYPES_QUERY).
    const heldPages = await txn.getAllAsync<HeldListing>("SELECT id, updated_at AS at, 'public' AS scope FROM knowledge_posts");
    const gonePages = postsTheNodeNoLongerHas(posts, heldPages, new Set(Array.isArray(sentOnly) ? sentOnly.map(String) : []));
    for (let i = 0; i < gonePages.length; i += 500) {
        const batch = gonePages.slice(i, i + 500);
        await txn.runAsync(`DELETE FROM knowledge_posts WHERE id IN (${batch.map(() => '?').join(',')})`, batch);
    }
}

/**
 * The member's own listings and the ones tied to them on this phone (posts-nearby.ts "kept"): one they took, any deal on it, a
 * conversation about it, their own answer or vote, or an id the node named `tied`. Four `?` in order: the member's key, four times.
 * One rule for the copy's pruning (keepPostsNearby) and for the Market's circle (getNearbyKeptPostIds), so they cannot drift.
 */
const NEARBY_KEPT_SQL = `(p.author_pubkey = ? OR p.accepted_by = ?
                 OR EXISTS (SELECT 1 FROM marketplace_transactions t WHERE t.post_id = p.id)
                 OR EXISTS (SELECT 1 FROM conversations c WHERE c.post_id = p.id)
                 OR EXISTS (SELECT 1 FROM event_rsvps r WHERE r.post_id = p.id AND r.member_pubkey = ?)
                 OR EXISTS (SELECT 1 FROM poll_votes v WHERE v.post_id = p.id AND v.voter_pubkey = ?)
                 OR EXISTS (SELECT 1 FROM nearby_tied n WHERE n.id = p.id))`;

/** The ids of the listings this phone keeps whatever their distance (NEARBY_KEPT_SQL): the Market's circle never cuts them. */
export async function getNearbyKeptPostIds(selfPubkey: string | null | undefined): Promise<Set<string>> {
    if (!selfPubkey) return new Set();
    const database = await waitForInit();
    const rows = await database.getAllAsync<{ id: string }>(
        `SELECT p.id FROM posts p WHERE ${NEARBY_KEPT_SQL}`, [selfPubkey, selfPubkey, selfPubkey, selfPubkey]);
    return new Set(rows.map(r => r.id));
}

/**
 * On a community that syncs listings by area (utils/posts-nearby.ts says the rules): the held listings its member's set
 * no longer names go (`set`, when this write carries one), then all but the `max` others nearest `area` (or the newest,
 * without one), each with its poll votes and RSVPs. Never the member's own or one tied to them on this phone: one they
 * took, any deal on it, a conversation about it, their own vote or answer to it. Without the phone's own key it can't
 * tell which are theirs: nothing goes. `fresh`: listings written after the set was worked out (pushes replayed over this
 * cycle), which the set can't speak for. `tied`, when this write carries the set's: the ids the node names as the
 * member's own or tied, kept from now on (nearby_tied) until the next set read says otherwise, so a tie this phone holds
 * no row for (a deal made elsewhere, or older than the deals it reads) keeps its listing too. `setHash`, when this write
 * carries the node's set: the node's hash of it, stored with the set (nearby_held) in this same transaction, so the hash
 * the phone sends back always names the set it holds; null forgets both (the next read is named the set in full). `tag`:
 * the ETag of a read that has landed whole (every row of its set held), which the phone sends with its next delta and is
 * answered 304 while nothing in the set changed; null forgets it, as the first write of every read does. The `tied` the
 * node hashed is stored with the set and its hash (k = 'tied', as the node named it, not nearby_tied's `tied ∩ set`), so a
 * diff applied to the held set is checked against exactly what the node hashed; a set with no `tied` is stored with no
 * hash. `forget`: all of it goes (set, hash, tied, tag), as one write: a diff that didn't check out, so the next read
 * sends no hash and is named the set whole.
 */
async function keepPostsNearby(
    txn: SQLite.SQLiteDatabase,
    nearby: { set?: unknown; tied?: unknown; setHash?: unknown; tag?: unknown; forget?: unknown; area?: { lat: number; lng: number } | null; max?: unknown },
    selfPubkey: string | null,
    fresh: ReadonlySet<string>,
): Promise<void> {
    if (nearby.forget === true) await txn.runAsync('DELETE FROM nearby_held');
    if (!selfPubkey) return;
    if (nearby.tag !== undefined) {
        await txn.runAsync("DELETE FROM nearby_held WHERE k = 'tag'");
        if (typeof nearby.tag === 'string' && nearby.tag !== '') await txn.runAsync("INSERT INTO nearby_held (k, v) VALUES ('tag', ?)", [nearby.tag]);
    }
    const max = typeof nearby.max === 'number' && Number.isFinite(nearby.max) && nearby.max >= 0 ? nearby.max : null;
    const set = Array.isArray(nearby.set) ? nearby.set.filter((id): id is string => typeof id === 'string') : null;
    if (max === null && set === null) return;
    if (set !== null && nearby.setHash !== undefined) {
        await txn.runAsync("DELETE FROM nearby_held WHERE k IN ('set', 'hash', 'tied')");
        if (typeof nearby.setHash === 'string' && nearby.setHash !== '' && Array.isArray(nearby.tied)) {
            const tied = nearby.tied.filter((id): id is string => typeof id === 'string');
            await txn.runAsync("INSERT INTO nearby_held (k, v) VALUES ('set', ?), ('hash', ?), ('tied', ?)", [JSON.stringify(set), nearby.setHash, JSON.stringify(tied)]);
        }
    }
    if (set !== null && Array.isArray(nearby.tied)) {
        const inSet = new Set(set);
        const tied = [...new Set(nearby.tied.filter((id): id is string => typeof id === 'string' && inSet.has(id)))];
        await txn.runAsync('DELETE FROM nearby_tied');
        for (let i = 0; i < tied.length; i += 500) {
            const batch = tied.slice(i, i + 500);
            await txn.runAsync(`INSERT OR IGNORE INTO nearby_tied (id) VALUES ${batch.map(() => '(?)').join(',')}`, batch);
        }
    }
    const rows = await txn.getAllAsync<{ id: string; lat: number | null; lng: number | null; at: string | null; kept: number; off: number; online: number }>(
        `SELECT p.id, p.lat, p.lng, COALESCE(p.updated_at, p.created_at) AS at, (p.active = 0 OR p.status = 'cancelled') AS off,
                (p.type = 'event' AND COALESCE(p.event_online, 0) = 1) AS online,
                ${NEARBY_KEPT_SQL} AS kept
         FROM posts p`,
        [selfPubkey, selfPubkey, selfPubkey, selfPubkey]);
    const held: NearbyHeld[] = rows.map(r => ({ id: r.id, lat: r.lat, lng: r.lng, at: r.at, kept: !!r.kept, off: !!r.off, online: !!r.online }));
    const gone = new Set(set ? nearbyReconcile(held, set, fresh).drop : []);
    if (max !== null) for (const id of nearbyPrune(held.filter(h => !gone.has(h.id)), nearby.area ?? null, max)) gone.add(id);
    const ids = [...gone];
    for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500);
        const marks = batch.map(() => '?').join(',');
        await txn.runAsync(`DELETE FROM poll_votes WHERE post_id IN (${marks})`, batch);
        await txn.runAsync(`DELETE FROM event_rsvps WHERE post_id IN (${marks})`, batch);
        await txn.runAsync(`DELETE FROM posts WHERE id IN (${marks})`, batch);
    }
    if (ids.length > 0) console.log(`[DB] applyDelta: ${ids.length} listing(s) outside this member's area left this phone`);
}

/**
 * The set this phone last reconciled with on a community that syncs by area, the `tied` the node hashed with it, and the
 * node's hash of both, as keepPostsNearby stored them together; null without all three (never synced by area, a cleared
 * copy, a set with no hash, one stored by a build before `tied` was: its next read is named the set whole, once).
 */
export async function readNearbyHeld(): Promise<{ set: string[]; tied: string[]; hash: string } | null> {
    try {
        const rows = await (await getDb()).getAllAsync<{ k: string; v: string }>("SELECT k, v FROM nearby_held WHERE k IN ('set', 'hash', 'tied')");
        const hash = rows.find(r => r.k === 'hash')?.v;
        const set = JSON.parse(rows.find(r => r.k === 'set')?.v ?? 'null');
        const tied = JSON.parse(rows.find(r => r.k === 'tied')?.v ?? 'null');
        const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(id => typeof id === 'string');
        if (!hash || !ids(set) || !ids(tied)) return null;
        return { set, tied, hash };
    } catch {
        return null;
    }
}

/**
 * What a phone on a community that says `membersOnDemand` must hold, and what it holds (DESIGN-global-members-by-area
 * §2.2.1; the plan is utils/members-on-demand.ts): `referenced` = everyone in its conversations, both sides of its deals,
 * raters and rated, and its friends; `held` = every card with when it was last fetched by key.
 * Listing authors are not referenced: the by-area row carries their name and face. Null when the copy can't be read.
 */
export async function readMembersOnDemandWorld(ownKey: string): Promise<{ referenced: string[]; held: { key: string; fetchedAt: string | null }[] } | null> {
    try {
        const database = await getDb();
        const referenced = await database.getAllAsync<{ k: string }>(
            `SELECT public_key AS k FROM conversation_participants
             UNION SELECT buyer_pubkey FROM marketplace_transactions
             UNION SELECT seller_pubkey FROM marketplace_transactions
             UNION SELECT rater_pubkey FROM ratings WHERE target_pubkey = ?
             UNION SELECT target_pubkey FROM ratings WHERE rater_pubkey = ?
             UNION SELECT friend_pubkey FROM friends WHERE owner_pubkey = ?`,
            [ownKey, ownKey, ownKey]
        );
        const held = await database.getAllAsync<{ key: string; fetchedAt: string | null }>(
            'SELECT public_key AS key, card_fetched_at AS fetchedAt FROM members'
        );
        return { referenced: referenced.map(r => r.k).filter((k): k is string => typeof k === 'string'), held };
    } catch {
        return null;
    }
}

/** The ETag of this phone's last read by area that landed whole (keepPostsNearby `tag`), or null. */
export async function readNearbyTag(): Promise<string | null> {
    try {
        return (await (await getDb()).getFirstAsync<{ v: string }>("SELECT v FROM nearby_held WHERE k = 'tag'"))?.v || null;
    } catch {
        return null;
    }
}

/**
 * A pushed listing change, inside applyDelta's lock and transaction. An upsert goes through the same row writer as
 * the delta sync, unless the cached copy is strictly newer (a late push must not move a listing backwards). A
 * removal cancels the row exactly as the node's own removal does (status 'cancelled', active 0, and an event's
 * state 'cancelled'), and creates nothing when the phone never had the listing. `updated_at` is left alone: the
 * node's tombstone carries the real one, and the next catch-up sync writes it over this row as usual.
 * A removal names an id, not a type, so it is also a page of Local knowledge's (a take-down, or Settings' removal): that page
 * lives in `knowledge_posts` (writeKnowledgePost), and leaves Learn, the Market's 📖 line and an open page at once, as the
 * node's tombstone does at the next sync (DESIGN-local-knowledge-fable.md §7, "takedown at once").
 */
async function applyLivePostRow(txn: SQLite.SQLiteDatabase, change: LivePostChange): Promise<void> {
    if (change.kind === 'remove') {
        await txn.runAsync(
            `UPDATE posts SET status = 'cancelled', active = 0,
                              event_state = CASE WHEN type = 'event' THEN 'cancelled' ELSE event_state END
             WHERE id = ?`,
            [change.id]);
        await txn.runAsync('UPDATE knowledge_posts SET active = 0 WHERE id = ?', [change.id]);
        return;
    }
    const local = await txn.getFirstAsync<{ updated_at: string | null }>('SELECT updated_at FROM posts WHERE id = ?', [change.post.id]);
    if (local && pushedPostIsStale(local.updated_at, change.post.updatedAt)) return;
    await writeSyncedPost(txn, change.post);
}

/**
 * What this phone holds that ties a listing to its own member beyond the listing itself: who wrote the cached copy
 * and its type, an open deal on it, or a conversation about it (conversations cache the listing's title and status).
 * services/pillar-sync.ts sends a change with any of these through the full catch-up sync, as before.
 */
export async function localPostTies(postId: string): Promise<{ authorPubkey: string | null; type: string | null; openDeal: boolean; conversation: boolean }> {
    const database = await getDb();
    const post = await database.getFirstAsync<{ author_pubkey: string | null; type: string | null }>(
        'SELECT author_pubkey, type FROM posts WHERE id = ?', [postId]);
    const deal = await database.getFirstAsync(
        "SELECT 1 FROM marketplace_transactions WHERE post_id = ? AND status IN ('requested', 'pending') LIMIT 1", [postId]);
    const conversation = await database.getFirstAsync('SELECT 1 FROM conversations WHERE post_id = ? LIMIT 1', [postId]);
    return { authorPubkey: post?.author_pubkey ?? null, type: post?.type ?? null, openDeal: !!deal, conversation: !!conversation };
}

/**
 * Writes a sync's delta to this node's cache. True once it has committed; false when it wrote nothing because the
 * member switched community while the delta was on its way (the guard below): a caller that must know the write
 * landed (a take-over's replace, services/pillar-sync.ts) reads this, since that case does not throw.
 * `generation`: the copy generation (copyGeneration) the delta was read under; when the copy has been cleared since, it
 * writes nothing and answers false, as for a switch.
 */
export async function applyDelta(delta: any, expectedDbName?: string, generation?: number): Promise<boolean> {
    let anchorUrl: string | null = null;
    let selfPubkey: string | null = null;
    let ownRowChanged = false;
    let ownSyncedArchetype: string | null = null;
    let ownRowAheadOfNode: string | null = null;
    let selfMemberFound = false;

    await acquireSyncLock();
    try {
        const database = await getDb();
        // Cross-node contamination guard. This delta was fetched from ONE node,
        // but getDb() returns whichever node is active NOW. If the user switched
        // communities while the sync was in flight, writing here would leak the
        // other node's posts/members/ledger into this node's local cache — the
        // server stays clean, but the app shows the wrong community's listings.
        // Skip the write; the newly-active node syncs cleanly on its own cycle.
        if (expectedDbName && currentDbName !== expectedDbName) {
            console.warn(`[DB] applyDelta: skipping write — active DB '${currentDbName}' != fetch-time DB '${expectedDbName}' (node switched mid-sync)`);
            return false;
        }
        // Read for a copy that has been cleared since (a Force Resync, a wipe): written now, it would land in the fresh
        // copy as if that copy had read it. Checked under the lock, which clearDB takes to drop the tables.
        if (generation !== undefined && generation !== copyGeneration) {
            console.warn('[DB] applyDelta: skipping write — the copy it was read for was cleared');
            return false;
        }
        // Read the identity OUTSIDE the transaction: it is an AsyncStorage/SecureStore read,
        // and awaiting it between SQLite statements would hold the write transaction open on
        // unrelated I/O. `ownRowChanged` is declared out here so it survives to after the
        // commit, which is the only point at which it is safe to tell the UI to re-read.
        anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        selfPubkey = (await loadIdentity().catch(() => null))?.publicKey ?? null;
        await database.withTransactionAsync(async () => {
            const txn = database;
// Full-replace sync: server response is the source of truth
    if (delta.accounts && delta.accounts.length > 0) {
        const BATCH_SIZE = 100;
        for (let i = 0; i < delta.accounts.length; i += BATCH_SIZE) {
            const batch = delta.accounts.slice(i, i + BATCH_SIZE);
            const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
            const params: any[] = [];
            for (const acc of batch) {
                // Whole hundredths of a Bean (the node's balance_c); anything else is held as 0, never a guessed figure.
                params.push(acc.public_key ?? null, isHundredths(acc.balance_c) ? acc.balance_c : 0, acc.last_demurrage_epoch ?? 0);
            }
            await txn.runAsync(
                `INSERT OR REPLACE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES ${placeholders}`,
                params
            );
        }
    }
    
    if (delta.members && delta.members.length > 0) {
        // In the node's COMPLETE member list, a null avatar is the node SAYING it has no photo
        // for that member — including the "broken row" case, where the stored value is this
        // node's own `/api/avatar/…` URL and is now emitted as null (decision (c)). The old
        // unconditional COALESCE kept the phone's previously-synced URL in that case, so the
        // phone went on believing the node held a photo: `MemberAvatar` rendered a 404ing URL,
        // and `catchUpAvatar` read "the node has a photo, leave `avatar` out" and never
        // republished the canonical copy. Only the marketplace photo gate could heal it.
        //
        // A PARTIAL list (the incremental `?updatedAfter=` delta) is not evidence of absence —
        // it only carries members who changed — so it keeps COALESCE, exactly as the GC below
        // only runs for a complete list.
        //
        // A `keys=` answer (`membersByKey`, members on demand) is complete for every key it names:
        // its null is the node saying that member has no photo now, so it clears too. On a
        // community that says `membersOnDemand` no complete list ever comes, so without this a
        // removed photo stayed on every phone that had shown it (review of #1859, B2).
        const avatarNullClears = delta.membersComplete === true || delta.membersByKey === true;
        const serverMemberSet = new Set();
        for (const m of delta.members) {
            const pk = m.publicKey || m.public_key || '';
            // Skip synthetic wallet entries (escrow/project accounts are not real members)
            if (pk.startsWith('escrow_') || pk.startsWith('project_')) continue;
            serverMemberSet.add(pk);
            const cs = m.callsign || '';
            const av = m.avatarUrl || m.avatar_url || null;
            const joinedAt = m.joinedAt || m.joined_at || null;
            const profileUpdatedAt = m.profileUpdatedAt || m.profile_updated_at || null;
            // The node's earnedCredit keeps its name and carries whole hundredths (M1). A card the phone already holds
            // (asHeldRow, kept from a search result by keepCards) carries the copy's own earned_credit_c. Anything else is 0.
            const ec = isHundredths(m.earnedCredit) ? m.earnedCredit : isHundredths(m.earned_credit_c) ? m.earned_credit_c : 0;
            let arch = m.archetype || null;
            let finalArch = arch;
            // The node SAYING a member has no working style: the field is there, and null. A removal reaches other members'
            // phones this way (the node bumps profile_updated_at, so the next delta names the member with null), and the
            // COALESCE below would keep the cached result and go on typing them (Chemistry tips) while the web shows none.
            // A delta that leaves the field out (an older node, a trimmed row) says nothing, and keeps it, as a partial
            // list keeps an avatar. Not this member's own row: that has its own rule (a retake not yet sent stands, below).
            const archetypeNullClears = m.archetype === null && pk !== selfPubkey;
            if (pk === selfPubkey) {
                selfMemberFound = true;
                const localRow = await txn.getFirstAsync<{ archetype?: string | null }>(
                    'SELECT archetype FROM members WHERE public_key = ?',
                    [pk]
                );
                // Remove my working style: while this community is still to be told, the result it holds, and any the phone's
                // row still holds, are ones the member took off. Neither comes back through this sync (not into the row, the
                // device copy, the other communities, nor the node). One taken after the removal is a retake: it stands.
                const removal = anchorUrl ? await waitingRemoval(anchorUrl, pk) : null;
                if (removal) {
                    if (arch && !archetypeIsAfter(arch, removal.removedOn)) { arch = null; finalArch = null; }
                    if (localRow?.archetype && !archetypeIsAfter(localRow.archetype, removal.removedOn)) {
                        localRow.archetype = null;
                        await txn.runAsync('UPDATE members SET archetype = NULL WHERE public_key = ?', [pk]);
                    }
                }
                if (localRow?.archetype && !archetypeIsNewer(arch, localRow.archetype)) {
                    finalArch = localRow.archetype;
                    // Null is a removal's to send (S3): only a row the node really holds older.
                    if (arch && archetypeIsNewer(localRow.archetype, arch)) ownRowAheadOfNode = localRow.archetype;
                } else if (arch) {
                    ownSyncedArchetype = arch;
                    if (!localRow?.archetype || archetypeIsNewer(arch, localRow.archetype)) {
                        ownRowChanged = true;
                    }
                }
            }
            if (await ownProfileRowWouldChange(txn, selfPubkey, pk, cs, av, avatarNullClears, profileUpdatedAt)) ownRowChanged = true;
            await txn.runAsync(
                `INSERT INTO members (public_key, callsign, avatar_url, joined_at, profile_updated_at, earned_credit_c, archetype) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(public_key) DO UPDATE SET
                   callsign = excluded.callsign,
                   archetype = CASE WHEN ? THEN excluded.archetype
                                    ELSE COALESCE(excluded.archetype, members.archetype) END,
                   avatar_url = CASE WHEN ? THEN excluded.avatar_url
                                     ELSE COALESCE(excluded.avatar_url, members.avatar_url) END,
                   joined_at = COALESCE(excluded.joined_at, members.joined_at),
                   profile_updated_at = COALESCE(excluded.profile_updated_at, members.profile_updated_at),
                   earned_credit_c = excluded.earned_credit_c`,
                // The CASE placeholders are the 8th (archetype) and 9th (avatar, last) `?` in the statement text, so
                // they bind AFTER the seven VALUES parameters.
                [pk, cs, av, joinedAt, profileUpdatedAt, ec, finalArch, archetypeNullClears ? 1 : 0, avatarNullClears ? 1 : 0]
            );
        }

        // Garbage collect members no longer in the server's directory — but ONLY when the
        // caller marked this payload as the complete directory snapshot. Without this guard a
        // partial/paginated/transient member list would delete every local member absent from
        // it (including peers the user is mid-conversation with). Presence/absence drives
        // deletion here, so a non-authoritative list must never reach this loop.
        if (delta.membersComplete) {
            const localMembers = await txn.getAllAsync<{public_key:string}>('SELECT public_key FROM members');
            for (const lm of localMembers) {
                // Ensure we don't accidentally delete synthetic project accounts if any leaked in
                if (lm.public_key.startsWith('escrow_') || lm.public_key.startsWith('project_')) continue;

                if (!serverMemberSet.has(lm.public_key)) {
                    console.log(`[DB] applyDelta: deleting obsolete member ${lm.public_key} not present on server`);
                    await txn.runAsync('DELETE FROM members WHERE public_key = ?', [lm.public_key]);
                }
            }
        }
    }

    // Members on demand (utils/members-on-demand.ts): the cards this cycle fetched or re-checked by key, stamped with when,
    // and the cards past the 1,000 bound that nothing references. Only a phone on a community that says
    // `membersOnDemand` sends either.
    if (delta.membersFetched && Array.isArray(delta.membersFetched.keys) && delta.membersFetched.keys.length > 0) {
        const keys: string[] = delta.membersFetched.keys;
        for (let i = 0; i < keys.length; i += 500) {
            const chunk = keys.slice(i, i + 500);
            await txn.runAsync(
                `UPDATE members SET card_fetched_at = ? WHERE public_key IN (${chunk.map(() => '?').join(',')})`,
                [delta.membersFetched.at, ...chunk]
            );
        }
    }
    if (Array.isArray(delta.membersDrop) && delta.membersDrop.length > 0) {
        const keys: string[] = delta.membersDrop.filter((k: unknown) => typeof k === 'string' && k !== selfPubkey);
        for (let i = 0; i < keys.length; i += 500) {
            const chunk = keys.slice(i, i + 500);
            await txn.runAsync(`DELETE FROM members WHERE public_key IN (${chunk.map(() => '?').join(',')})`, chunk);
        }
    }
    
    if (delta.transactions) {
            for (const t of delta.transactions) {
                // Whole hundredths above 0 (the node's amount_c and fee_c), or the row isn't kept: never a guessed figure.
                if (!isHundredths(t.amount_c) || t.amount_c <= 0) continue;
                const fromKey = t.from_pubkey || t.from || null;
                const toKey = t.to_pubkey || t.to || null;
                await txn.runAsync(
                    'INSERT OR REPLACE INTO transactions (id, from_pubkey, to_pubkey, amount_c, fee_c, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [t.id ?? null, fromKey, toKey, t.amount_c, isHundredths(t.fee_c) ? t.fee_c : 0, t.memo ?? null, t.timestamp ?? null]
                );
            }
        }

        if (delta.posts !== undefined) {
            // Delta Sync: Server dataset only transmits modified rows.
            // Deleted posts are transmitted with active=0 and tombstoned here natively.
            for (const p of delta.posts) {
                await writeSyncedPost(txn, p);
            }
            // After a take-over, the whole pull replaces what the phone holds (services/pillar-sync.ts). Before the
            // pushed changes below: a push that landed during this cycle is newer than the pull, not left over.
            // `postsSentOnly`: the ids among them that the take-over's catch-up read carried, not the pull (posts-replace.ts).
            if (delta.postsReplace === true) await dropPostsTheNodeNoLongerHas(txn, delta.posts, delta.postsSentOnly);
        }

        // The community refused this phone its listings (a local community's are its members', utils/members-only-listings.ts):
        // what it kept of them from before goes, so no old listing or pin stays on show and the Market shows the
        // members-only card.
        if (delta.postsRefused === true) await dropListingsOfARefusedCommunity(txn, selfPubkey);

        // Listing changes the node pushed over /ws (services/pillar-sync.ts applyLivePostChange), in the order they
        // arrived. They come after `posts` so that a catch-up sync whose pull left the node BEFORE a push replays
        // the push over its own older copy instead of undoing it.
        if (Array.isArray(delta.liveChanges)) {
            for (const change of delta.liveChanges as LivePostChange[]) {
                await applyLivePostRow(txn, change);
            }
        }

        // A community that syncs listings by area (services/pillar-sync.ts): after every write of its listings, the phone
        // keeps its member's set and at most `max` others (utils/posts-nearby.ts). After the pushes above, which it
        // never drops for a set worked out before them.
        if (delta.postsNearby && typeof delta.postsNearby === 'object') {
            const fresh = new Set<string>(Array.isArray(delta.liveChanges)
                ? (delta.liveChanges as LivePostChange[]).flatMap(c => (c.kind === 'upsert' && c.post?.id ? [String(c.post.id)] : []))
                : []);
            // A push replayed in this write landed outside the read the tag describes (one outside the set is kept as fresh):
            // the tag isn't stored, and the next delta is answered whole (review of #1805, finding 2).
            const pushed = Array.isArray(delta.liveChanges) && delta.liveChanges.length > 0;
            const nearby = pushed && typeof delta.postsNearby.tag === 'string' ? { ...delta.postsNearby, tag: null } : delta.postsNearby;
            await keepPostsNearby(txn, nearby, selfPubkey, fresh);
        }

        if (delta.marketplaceTransactions !== undefined) {
            console.log(`[DB] applying ${delta.marketplaceTransactions.length} marketplace_transactions...`);
            for (const tx of delta.marketplaceTransactions) await writeNodeDeal(txn, tx);
        }

        if (delta.projects !== undefined) {
            for (const proj of delta.projects) {
                await txn.runAsync(
                    'INSERT OR REPLACE INTO projects (id, creator_pubkey, title, description, photos, goal_amount_c, current_amount_c, deadline_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        proj.id ?? null,
                        proj.creatorPubkey ?? proj.creator_pubkey ?? null,
                        proj.title ?? null,
                        proj.description ?? '',
                        proj.photos ? JSON.stringify((typeof proj.photos === 'string' ? JSON.parse(proj.photos) : proj.photos).filter((url: string) => !url.startsWith('file://'))) : null,
                        // Whole hundredths of a Bean (the node's project row: goal_amount_c, current_amount_c); anything else is 0.
                        isHundredths(proj.goal_amount_c) ? proj.goal_amount_c : 0,
                        isHundredths(proj.current_amount_c) ? proj.current_amount_c : 0,
                        proj.deadlineAt ?? proj.deadline_at ?? null,
                        proj.status ?? 'ACTIVE',
                        proj.createdAt ?? proj.created_at ?? new Date().toISOString()
                    ]
                );
            }
        }

        // Sync friends (compact diff from server)
        if (delta.friends && Array.isArray(delta.friends)) {
            const identity = await loadIdentity();
            if (identity?.publicKey) {
                // Get current local friend pubkeys
                const localFriends = await txn.getAllAsync<any>(
                    'SELECT friend_pubkey FROM friends WHERE owner_pubkey = ?',
                    [identity.publicKey]
                );
                const localSet = new Set(localFriends.map((f: any) => f.friend_pubkey));
                const serverSet = new Set(delta.friends.map((f: any) => f.publicKey || f.friend_pubkey));

                // Add new friends from server
                for (const f of delta.friends) {
                    const fpk = f.publicKey || f.friend_pubkey;
                    if (!localSet.has(fpk)) {
                        await txn.runAsync(
                            'INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey, added_at, is_guardian) VALUES (?, ?, ?, ?)',
                            [identity.publicKey, fpk, f.addedAt || f.added_at || new Date().toISOString(), 0]
                        );
                    }
                }

                // Note: We intentionally DO NOT delete local friends that are missing from the server payload.
                // Instead, we push them to the server to heal the state in case of offline additions.
                for (const local of localFriends) {
                    if (!serverSet.has(local.friend_pubkey)) {
                        _syncFriendToServer('add', identity.publicKey, local.friend_pubkey).catch(() => {});
                    }
                }
            }
        }

        // Sync ratings (compact diff from server)
        if (delta.ratings !== undefined && Array.isArray(delta.ratings)) {
            console.log(`[DB] applyDelta: applying ${delta.ratings.length} ratings...`);
            for (const r of delta.ratings) {
                const stars = r.stars ?? r.rating;
                if (!stars || stars < 1 || stars > 5) {
                    console.warn(`[DB] Skipping invalid rating from server:`, r);
                    continue;
                }
                const rId = r.id ?? null;
                const targetPubkey = r.targetPubkey ?? r.target_pubkey ?? null;
                const raterPubkey = r.raterPubkey ?? r.rater_pubkey ?? null;
                if (!rId || !targetPubkey || !raterPubkey) {
                    console.warn(`[DB] Skipping rating from server due to missing required keys:`, r);
                    continue;
                }
                await txn.runAsync(
                    'INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, stars, comment, role, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        rId,
                        targetPubkey,
                        raterPubkey,
                        stars,
                        r.comment ?? '',
                        r.role ?? 'provider',
                        r.transactionId ?? r.transaction_id ?? null,
                        r.createdAt ?? r.created_at ?? new Date().toISOString()
                    ]
                );
            }
        }

        console.log(`[DB] applyDelta: replaced posts table with ${delta.posts?.length || 0} posts from server`);
        });
        // AFTER the commit, and only on a real change — see ownProfileRowWouldChange.
        if (ownRowChanged && selfPubkey) emitOwnProfileUpdated(selfPubkey);
    } finally {
        releaseSyncLock();
    }
    if (selfMemberFound && anchorUrl && selfPubkey) {
        await healGuestMark(anchorUrl, selfPubkey).catch(e => console.warn('[DB] Failed to heal a guest mark:', e));
    }
    if (ownRowAheadOfNode && anchorUrl && selfPubkey) {
        await carryRowToNode(selfPubkey, ownRowAheadOfNode, anchorUrl).catch(e => console.warn('[DB] Failed to keep a row the node is behind:', e));
    }
    if (ownSyncedArchetype && selfPubkey) {
        try {
            const canonical = await getCanonicalProfile().catch(() => null);
            const deviceCopy = canonical?.archetype ?? null;
            if (archetypeIsNewer(ownSyncedArchetype, deviceCopy)) {
                await adoptNewerRowIntoDevice(selfPubkey, ownSyncedArchetype, anchorUrl);
            }
        } catch (e) {
            console.warn('[DB] Failed to adopt newer archetype row:', e);
        }
    }
    return true;
}

// Returns only the fetched messages that would actually change a local row: new ids
// (or rows consolidated into this conversation), changed metadata (reactions/read
// flags), or a new edit. Runs WITHOUT the sync lock so the common poll outcome —
// "nothing changed" — never joins the write queue at all.
async function diffChangedMessages(database: SQLite.SQLiteDatabase, conversationId: string, messages: any[]): Promise<any[]> {
    const localRows = await database.getAllAsync<{ id: string; metadata: string | null; edited_at: string | null; type: string | null }>(
        'SELECT id, metadata, edited_at, type FROM messages WHERE conversation_id = ?',
        [conversationId]
    );
    const localById = new Map(localRows.map(r => [r.id, r]));
    return messages.filter((m: any) => {
        const local = localById.get(m.id);
        if (!local) return true;
        if ((withoutSendState(m.metadata || null) || null) !== (local.metadata || null)) return true;
        const editedAt = m.editedAt || m.edited_at || null;
        if (editedAt && editedAt !== local.edited_at) return true;
        // A delete or a removal that the node recorded without touching the metadata we hold (an older row
        // with none at all) still has to land: the row's type is what changed.
        if (isRemovedPayload({ type: m.type, metadata: m.metadata || null }) &&
            !isRemovedPayload({ type: local.type, metadata: local.metadata })) return true;
        return false;
    });
}

/**
 * The fetched lines whose ids this file holds under no other conversation (§3.4 amendment 6 §4, the narrow gate): while
 * the pins are unread, a page of any chat never moves a DM's line by its id (upsertFetchedMessage's ON CONFLICT(id)).
 */
async function ownLinesOnly(database: SQLite.SQLiteDatabase, conversationId: string, msgs: any[]): Promise<any[]> {
    if (!msgs.length) return msgs;
    const ids = msgs.map((m: any) => m.id);
    const rows = await database.getAllAsync<{ id: string }>(`SELECT id FROM messages WHERE id IN (${ids.map(() => '?').join(', ')}) AND conversation_id != ?`, [...ids, conversationId]);
    const elsewhere = new Set(rows.map((r) => r.id));
    return msgs.filter((m: any) => !elsewhere.has(m.id));
}

// Single-message upsert shared by the batch and single-conversation sync paths.
//
// What the node's copy does to the phone's row is decided in utils/chat-sync.mergeIncomingMessage, not in
// SQL: the old `ON CONFLICT` could express "a newer edit replaces the text" and nothing else, so a DELETE
// (the node replaces the ciphertext and sets type = 'removed', with no editedAt) landed as a metadata-only
// update and the deleted words stayed on screen. The local row is read first — only CHANGED messages reach
// here, so that is one small read per actually-changed message, not one per poll tick.
//
// A group's sealed line is stored only with its chat's lock mark (`me`'s, GroupKeyStore noteLocked) in the same file and
// transaction: its node can take the line off again (a removal, its author's account deleted, a resync), never the mark (max
// review of #3358, T1). Only for a chat this phone keeps as a group's, or with no row of it, the page's own word
// (`pageType`). The mark lifts no DM guard. This run's key memory is told before the mark is written (noteLockedInCopy), so a
// ring of the copy that read its file before says locked at once, a readable line on its way included (U2).
async function upsertFetchedMessage(database: SQLite.SQLiteDatabase, conversationId: string, m: any, me?: string | null, pageType?: string | null) {
    const local = await database.getFirstAsync<LocalMessageRow>(
        'SELECT ciphertext, nonce, type, edited_at, metadata FROM messages WHERE id = ?',
        [m.id]
    );
    const merged = mergeIncomingMessage(local, {
        id: m.id,
        ciphertext: m.ciphertext || '',
        nonce: m.nonce || '',
        type: m.type || 'text',
        metadata: m.metadata || null,
        editedAt: m.editedAt || m.edited_at || null,
    });
    if (me && (isGroupSealedNonce(merged.nonce) || isGroupSealedNonce(local?.nonce))) {
        const kept = await database.getFirstAsync<{ kind: string | null }>(
            `SELECT IFNULL((SELECT IFNULL(type, 'dm') FROM conversations WHERE id = ?), ?) AS kind`,
            [conversationId, pageType ?? null]
        );
        if (kept?.kind === 'group_thread') {
            const copy = dbFileOf.get(database);
            if (copy) noteLockedInCopy(copy, me, conversationId);
            await database.runAsync('INSERT OR IGNORE INTO group_chat_key_state (group_id) VALUES (?)', [`${me}/${conversationId.toLowerCase()}`]);
        }
    }
    await database.runAsync(
        `INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp, edited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           metadata = excluded.metadata,
           timestamp = excluded.timestamp,
           ciphertext = excluded.ciphertext,
           nonce = excluded.nonce,
           type = excluded.type,
           edited_at = excluded.edited_at`,
        [m.id, conversationId, m.author_pubkey || m.authorPubkey || '', merged.ciphertext, merged.nonce, merged.type, m.systemType || m.system_type || null, merged.metadata, m.timestamp || m.created_at || new Date().toISOString(), merged.editedAt]
    );
    // The other end deleted it for everyone: this phone's decrypted copy of the photo goes too.
    if (merged.contentReplaced && merged.type === 'removed') await forgetCachedChatImage(m.id);
}

// Deleted accounts already blanked on this phone, per community copy (its file). The conversation list names them on every sync from
// then on, and an open chat's page can carry their tombstones on every poll: a pass already done is not run again.
const deletedAccountsBlanked = new Set<string>();

/**
 * Every line on this phone by an account its owner deleted reads "This message was deleted", and the copies of their photos
 * this phone decrypted go (Marty, 2026-10-01: "Yes, blank lines and photos").
 *
 * The node blanks every line of theirs (apps/server/src/engine/message-tombstone.ts blankMessagesOf), but a sync brings only
 * the newest 50 lines of a conversation and the delete sends no event per line: the older lines of a DM, which the chat
 * reads from here as you scroll up, kept their words, still decryptable, and their photos. So the phone blanks them itself,
 * in every conversation it holds (a group's and an event's lines are kept here too), from what a sync tells it: the
 * conversation list's `deletedAccounts`, or a tombstone of theirs in a conversation's answer (chat-sync.ts
 * accountDeletedAuthor). Both are state, not a socket event, so a phone that was offline when it happened catches it on its
 * next sync. Never this phone's own lines. Each line keeps its id, conversation and time; the node's own tombstone replaces
 * this one when a later sync carries it. Returns how many lines it blanked.
 */
async function blankLinesOfDeletedAccounts(database: SQLite.SQLiteDatabase, keys: Iterable<string>, myPubkey: string | null | undefined): Promise<number> {
    // Kept by the file `database` reads, never by the community in use (#3305 review F1): a page polled in place blanks that
    // community's copy, and the community in use still blanks its own.
    const copy = dbFileOf.get(database) ?? currentDbName ?? '';
    const pending = [...new Set(keys)].filter(k => typeof k === 'string' && k !== '' && k !== myPubkey && !deletedAccountsBlanked.has(`${copy}\u0001${k}`));
    if (pending.length === 0) return 0;
    const rows = await database.getAllAsync<{ id: string; author_pubkey: string; type: string | null; nonce: string | null; metadata: string | null }>(
        `SELECT id, author_pubkey, type, nonce, metadata FROM messages WHERE author_pubkey IN (${pending.map(() => '?').join(',')})`,
        pending
    );
    const toBlank = rows.filter(stillHoldsWords);
    const blanked: string[] = [];
    if (toBlank.length > 0) {
        // Stored as the node stores its tombstones: plain text, readable without the DM's key.
        const ciphertext = encodeBase64(encodeUtf8(DELETED_BY_AUTHOR_TEXT));
        const removedAt = new Date().toISOString();
        await acquireSyncLock();
        try {
            await database.withTransactionAsync(async () => {
                for (const r of toBlank) {
                    // Checked again here: a sync may have put the node's own tombstone in since the read above, and it stays.
                    const res = await database.runAsync(
                        `UPDATE messages SET type = 'removed', ciphertext = ?, nonce = 'plaintext-v1', metadata = ?
                         WHERE id = ? AND author_pubkey = ? AND NOT (IFNULL(type, '') = 'removed' AND IFNULL(nonce, '') LIKE 'plaintext%')`,
                        [ciphertext, accountDeletedMetadata(r.metadata, r.author_pubkey, removedAt), r.id, r.author_pubkey]
                    );
                    if (res.changes > 0) blanked.push(r.id);
                }
            });
        } finally {
            releaseSyncLock();
        }
    }
    for (const id of blanked) await forgetCachedChatImage(id);
    for (const k of pending) deletedAccountsBlanked.add(`${copy}\u0001${k}`);
    if (blanked.length > 0) console.log(`[Sync] Blanked ${blanked.length} line(s) of ${pending.length} deleted account(s)`);
    return blanked.length;
}

/**
 * The member's conversations and each one's newest lines, from the node into this phone. Failures are swallowed, so it
 * says whether the read worked: true when the list and every chat's page it asked for came back 2xx, false when any
 * didn't (a 503 while the node is full, a timeout on a weak link). The tabs' backstop counts only a read that worked, and
 * reads again on the next tick after one that didn't (app/(tabs)/_layout.tsx, review of #2558).
 */
export async function syncMessages(publicKey: string): Promise<boolean> {
    try {
        // The community asked and its file, taken together: every answer below is written into that file only, and none
        // once the phone has moved to another community while it was out (the pass then writes nothing more).
        const here = await chatCopyForRequest();
        const anchorUrl = here.anchorUrl;
        if (!anchorUrl) return false;
        // The account this list is asked for, and the copies as they are (ownListRead): the answer of an account that has
        // left the phone is written and kept nowhere, never under the next account's key or in its file (#3309 review P5).
        const asked = ownListRead(publicKey);
        const onThisCopy = async (database: SQLite.SQLiteDatabase) => (await here.handle()) === database;

        const expectedDbName = here.file;
        const kLastMembersSync = `pillar_sync_${expectedDbName}_members_last_sync`;
        const lastMembersSync = await AsyncStorage.getItem(kLastMembersSync);
        
        let localMembersCount = 0;
        try {
            const membersRow = await here.database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM members');
            localMembersCount = membersRow?.count || 0;
        } catch (e) {}

        // A community that reads members by key (node-profile.ts membersByKey, the worldwide one): never the whole
        // directory, nor its `membersComplete` garbage collection over the cards held (DESIGN-global-members-by-area §1,
        // §2.4 (d)). pillar-sync fetches the cards this phone has a reason to show by key. With no copy of the profile this
        // phone can't tell, so nothing is read whole here: a node with members on demand and anyone-can-join off answers a
        // whole read, which wrote every member (review of #1999, NB2). pillar-sync asks for the profile before it reads
        // anything, and the next check here reads as it says. Anywhere else, as it always was.
        const profile = await getCachedNodeProfile(anchorUrl).catch(() => null);
        const shouldFetchMembers = !!profile && !membersByKey(profile.features) && (!lastMembersSync ||
                                   (Date.now() - parseInt(lastMembersSync, 10)) > 3600_000 ||
                                   localMembersCount === 0);

        // Separate 10s budgets: one shared controller let a slow conversations response use up the
        // directory fetch's time too, so it was aborted by us rather than by the network.
        const controller1 = new AbortController();
        const timeout1 = setTimeout(() => controller1.abort(), 10000);
        
        let convRes;
        const decidedBefore = _requestDecisions;
        try {
            convRes = await signedGet(`/api/messages/conversations/${publicKey}`, { signal: controller1.signal, anchorUrl });
        } catch (e) {
            console.warn('[DB] conversations fetch failed:', e);
            clearTimeout(timeout1);
            return false;
        }
        clearTimeout(timeout1);

        let dirRes = null;
        const dirController = new AbortController();
        const dirTimeout = setTimeout(() => dirController.abort(), 10000);
        if (shouldFetchMembers) {
            try {
                dirRes = await signedGet('/api/members', { signal: dirController.signal, anchorUrl });
            } catch (e) {
                console.warn('[DB] members fetch failed:', e);
            }
        }
        clearTimeout(dirTimeout);
        
        if (dirRes && dirRes.ok) {
            try {
                const dirData = await dirRes.json();
                if (Array.isArray(dirData) && dirData.length > 0) {
                    // This used to be a SECOND members upsert with its own COALESCE, which made
                    // the viewer's own row follow two different rules depending on which writer
                    // won the hour boundary: `applyDelta` clears a stored avatar when the node's
                    // COMPLETE list says there is none, this one kept the stale URL for another
                    // hour — and while it was kept, `catchUpAvatar` read "the node has a photo"
                    // and refused to republish the canonical copy.
                    //
                    // It is the same endpoint, the same full directory and the same payload
                    // shape pillar-sync feeds `applyDelta`, so it goes through `applyDelta`
                    // instead: one upsert, one null-clears rule, one GC, one `profile_updated`
                    // emit. `applyDelta` takes the sync lock and re-checks the active node
                    // itself, so neither is done here.
                    await applyDelta({ members: dirData, membersComplete: true }, expectedDbName);
                    await AsyncStorage.setItem(kLastMembersSync, String(Date.now()));
                }
            } catch (e) {}
        } else if (dirRes && dirRes.status === 403) {
            // Refused as `members_on_demand`: this phone's copy of the profile is from before the node's switch. Noted, so
            // the sync reads the members by key from now on (pillar-sync syncMembersOnDemand) and nothing here asks whole.
            const refusal = await dirRes.json().catch(() => null);
            if (isMembersOnDemandRefusal(dirRes.status, refusal)) await noteMembersOnDemand(anchorUrl);
        }

        if (!convRes.ok) return false;

        const convData = await convRes.json();
        if (!convData.conversations) return false;

        // Identity, so we can attribute the peer's read cursor (read receipts): the account that asked, still the phone's,
        // with no copy cleared since, or nothing of this list is written or kept (ownListRead).
        const now = await asked.still();
        if (!now) return false;
        const myIdentity = now.identity;
        // The list's community's copy, or nothing at all: the member switched while it was on its way (dropped, never
        // written into the community the phone is on now).
        const database = await here.handle();
        if (!database) return false;

        // The people in these chats who deleted their accounts: the older lines of theirs this phone holds are blanked here,
        // since no page below brings them again (blankLinesOfDeletedAccounts). A node from before this sends none.
        const deletedAccounts = new Set<string>(
            Array.isArray(convData.deletedAccounts) ? convData.deletedAccounts.filter((k: unknown): k is string => typeof k === 'string') : []
        );
        // The pins before any line is blanked, through this pass's handle: the account's first read with this community's
        // file open seeds it from the rows and lines this phone holds there (§3.4 amendments 3 and 5). The gate: a pin store
        // that can't be read (or a seed that couldn't be written) stops this pass writing anything of the node's into the
        // DMs here, blanked lines included; they stand still until it reads, and the seed then runs over the phone's rows.
        let pinsUnread = false;
        if (myIdentity?.publicKey) {
            try {
                await dmPins.read(myIdentity.publicKey, database);
            } catch (e) {
                pinsUnread = true;
                console.warn('[Sync] Could not read the DM pins: the DMs here wait for the next pass', e);
            }
        }
        // The DM guard list where the pins are asked, before any row is written or pruned: after the member's reset its seed
        // reads the rows this pass hasn't touched (§3.4 amendment 8). Unreadable: the prune below waits (amendment 8 (a)).
        const listUnreadAtStart = await dmConversationsSeen(database).then(() => false, () => true);
        if (!pinsUnread) {
            try {
                await blankLinesOfDeletedAccounts(database, deletedAccounts, myIdentity?.publicKey);
            } catch (e) {
                console.warn('[Sync] Could not blank the lines of deleted accounts:', e);
            }
        }
        // And anyone a page below shows as deleted (a tombstone of theirs), who may no longer be in that chat.
        const seenDeleted = new Set<string>();

        // The DM pins (utils/dm-peer-pins.ts), changed once for the pass through their one queue and written at most once:
        // the DMs this phone already holds are pinned from its own rows first, then the listing offers another key for a
        // pinned DM, or pins one it meets for the first time, and never moves a pinned key. Kept apart from the rows below,
        // so the prune at the end of the pass can't touch them. Unreadable: left alone (every send refuses).
        if (myIdentity?.publicKey && !pinsUnread) {
            const me = myIdentity.publicKey;
            try {
                // The pins first (this file's seed keeps what this phone holds), then the DMs it couldn't pin from its rows
                // are judged on the lines it held then, before this pass writes a row or a line (§3.4 amendment 3).
                const before = await dmPins.read(me, database);
                const sights = myIdentity.privateKey ? await judgeHeldAtUpdate(me, database, myIdentity.privateKey, before, convData.conversations) : [];
                const held = await dmPeersHeld(database);
                await updatePinsWithList(me, database, (pins, verified) => {
                    // The book seeded this file's rows, checked, before this run's first write here; any held beyond
                    // those were written since, from the node, and pin unchecked: the lines judge them first.
                    const seeded = seedPinsFromRows(pins, me, held, false);
                    const judged = applyHeldSights(pins, sights, verified);
                    const listed = applyListingsToPins(pins, me, convData.conversations, verified);
                    return seeded || judged || listed;
                });
            } catch (e) {
                console.warn('[Sync] Could not read or write the DM pins:', e);
            }
        }

        // A pinned DM's participant rows are [me, the pinned key]: the listing is heard by the pin (an offer), never written
        // into its rows, so the chat names the person it is sealed to, and no reader has to put the rows back (each pass
        // writing the offered key in and each read taking it out again: #1872 ultrareview, U7).
        const pinsNow = myIdentity?.publicKey && !pinsUnread ? await dmPins.read(myIdentity.publicKey, database).catch(() => null) : null;
        // Kept for the community the list came from, and not at all if the phone has moved to another while it was out.
        if (myIdentity?.publicKey && await onThisCopy(database)) {
            await saveMessageRequests(publicKey, expectedDbName, convData.requests ?? null);
        }
        // Whether every chat's page this pass asked for came back: one that didn't may hold the line a doorbell rang for. A
        // chat left out of the pass to wait for the next one counts as not read too, so the next tick reads it.
        let everyPageRead = true;
        for (const conv of convData.conversations) {
            // Each chat's page is a network await: once the phone has moved to another community, nothing more is written.
            if (!(await onThisCopy(database))) return false;
            // Decide WITHOUT the lock whether this conversation row actually needs
            // writing. This loop runs on every full message-sync (badge backstop,
            // inbox focus, WS nudges); unconditionally rewriting every conv row was
            // one of the writers starving the sync lock (2026-07-18 on-device logs).
            // The gate: with the pins unread, nothing of the node's goes into a DM here this pass (its rows, lines, cursors).
            if (pinsUnread && await isDmHere(database, conv.id, conv.type)) { everyPageRead = false; continue; }
            const pinned = pinsNow && typeof conv.id === 'string' ? dmPinFor(pinsNow, conv.id) : null;
            const people: string[] | null = !Array.isArray(conv.participants) ? null : pinned && myIdentity?.publicKey ? [myIdentity.publicKey, pinned.peer] : conv.participants;
            const listedPeer = Array.isArray(conv.participants) ? conv.participants.find((p: string) => p && p !== myIdentity?.publicKey) : undefined;
            // The node's read cursor is its listed peer's: kept only for the key this phone pinned.
            const cursorPeer = pinned ? (pinKeyOf(listedPeer) === pinned.peer ? pinned.peer : null) : listedPeer;
            const postPhotoString = conv.postPhoto ? JSON.stringify([conv.postPhoto]) : null;
            // The chat's ⋮ menu reads this to show Mute or Unmute without a request of its own.
            if ('mute' in conv) rememberChatMute(conv.id, conv.mute ?? null);
            let needsConvWrite = false;
            // The row's request as this list leaves it (requestAfterReadHere): asked again just before the write, so a
            // decision taken here since the list was asked is never written over (PR #2540 review 4395706539).
            let heldRequest: string | null | undefined = null;
            const requestAfterList = () => requestAfterReadHere(conv.id, heldRequest, conv.request, decidedBefore);
            try {
                const localConv = await database.getFirstAsync<any>(
                    'SELECT id, type, post_title, post_status, post_photo, request, listed FROM conversations WHERE id = ?', [conv.id]);
                heldRequest = localConv?.request;
                const requestJson = requestAfterList();
                // The DM guard: a row's type is never rewritten from the node, and a DM it now types otherwise is logged.
                if (localConv?.type === 'dm' && conv.type && conv.type !== 'dm') {
                    console.warn(`[DM guard] the node calls DM ${String(conv.id).slice(0, 8)} a ${conv.type}: ignored, it stays a DM`);
                }
                if (!localConv) {
                    needsConvWrite = true;
                } else if (
                    (localConv.post_title ?? null) !== (conv.postTitle ?? null) ||
                    (localConv.post_status ?? null) !== (conv.postStatus ?? null) ||
                    (localConv.post_photo ?? null) !== postPhotoString ||
                    (requestJson !== undefined && (localConv.request ?? null) !== requestJson) ||
                    localConv.listed !== 1
                ) {
                    needsConvWrite = true;
                } else if (people) {
                    const rows = await database.getAllAsync<any>(
                        'SELECT public_key, last_read_at FROM conversation_participants WHERE conversation_id = ?', [conv.id]);
                    const haveReadAt = new Map(rows.map((r: any) => [r.public_key, r.last_read_at]));
                    for (const pub of people) {
                        if (!haveReadAt.has(pub)) { needsConvWrite = true; break; }
                    }
                    if (!needsConvWrite && conv.peerLastReadAt && myIdentity?.publicKey) {
                        if (cursorPeer) {
                            const cur = haveReadAt.get(cursorPeer);
                            if (cur == null || cur < conv.peerLastReadAt) needsConvWrite = true;
                        }
                    }
                    if (!needsConvWrite && conv.myLastReadAt && myIdentity?.publicKey) {
                        const cur = haveReadAt.get(myIdentity.publicKey);
                        if (cur == null || cur < conv.myLastReadAt) needsConvWrite = true;
                    }
                }
            } catch {
                needsConvWrite = true; // on any doubt, fall through to the write path
            }

            // The type this phone keeps (a known DM stays one: the DM guard); an existing row's type is never rewritten. A type
            // the guard can't decide (its list unreadable: §3.4 amendment 7 §3 iii) writes nothing of this conversation's this pass.
            let heldType: string;
            try {
                heldType = needsConvWrite ? await heldConversationType(conv.id, conv.type, myIdentity?.publicKey, true, database) : (conv.type || 'dm');
            } catch (e) {
                console.warn(`[DM guard] Could not tell whether ${String(conv.id).slice(0, 8)} is a DM: it waits for the next pass`, e);
                everyPageRead = false;
                continue;
            }
            if (needsConvWrite) {
            await acquireSyncLock();
            try {
                await database.withTransactionAsync(async () => {
                    const txn = database;
                    const localConv = await txn.getFirstAsync<any>('SELECT id FROM conversations WHERE id = ?', [conv.id]);
                    if (!localConv) {
                        await txn.runAsync(
                            'INSERT INTO conversations (id, type, post_id, name, created_by, created_at, post_title, post_status, post_photo, request, listed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
                            [
                                conv.id,
                                heldType,
                                conv.postId || conv.post_id || null,
                                conv.name || null,
                                conv.createdBy || '',
                                conv.createdAt || new Date().toISOString(),
                                conv.postTitle || null,
                                conv.postStatus || null,
                                postPhotoString,
                                requestAfterList() ?? null
                            ]
                        );
                    } else {
                        // Undefined: the row keeps the request it holds.
                        const requestJson = requestAfterList();
                        await txn.runAsync(
                            `UPDATE conversations SET post_title = ?, post_status = ?, post_photo = ?, ${requestJson === undefined ? '' : 'request = ?, '}listed = 1 WHERE id = ?`,
                            [
                                conv.postTitle || null,
                                conv.postStatus || null,
                                postPhotoString,
                                ...(requestJson === undefined ? [] : [requestJson]),
                                conv.id
                            ]
                        );
                    }
                    if (people) {
                        for (const pub of people) {
                            await txn.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conv.id, pub]);
                        }
                        // Read receipts: record the peer's read cursor (monotonic — never regress).
                        if (conv.peerLastReadAt && myIdentity?.publicKey) {
                            if (cursorPeer) {
                                await txn.runAsync(
                                    'UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ? AND (last_read_at IS NULL OR last_read_at < ?)',
                                    [conv.peerLastReadAt, conv.id, cursorPeer, conv.peerLastReadAt]
                                );
                            }
                        }
                        // Update my own read cursor if it is returned and is newer
                        if (conv.myLastReadAt && myIdentity?.publicKey) {
                            await txn.runAsync(
                                'UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ? AND (last_read_at IS NULL OR last_read_at < ?)',
                                [conv.myLastReadAt, conv.id, myIdentity.publicKey, conv.myLastReadAt]
                            );
                        }
                    }
                });
            } finally {
                releaseSyncLock();
            }
            }

            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 5000);
            let msgRes;
            try {
                msgRes = await signedGet(`/api/messages/${conv.id}`, { signal: controller2.signal, anchorUrl });
            } catch (err) {
                clearTimeout(timeout2);
                everyPageRead = false;
                continue;
            }
            clearTimeout(timeout2);
            if (!msgRes.ok) { everyPageRead = false; continue; }
            
            const msgData = await msgRes.json();
            const messages = msgData.messages;
            if (!Array.isArray(messages)) continue;
            if (!(await onThisCopy(database))) return false;
            for (const m of messages) {
                const gone = accountDeletedAuthor(m, conv.type);
                if (gone && !deletedAccounts.has(gone)) seenDeleted.add(gone);
            }

            // Diff outside the lock — unchanged conversations skip the write queue. With the pins unread, a chat that isn't
            // a DM syncs on, but none of its lines may take a held line's id from another conversation (the narrow gate).
            const fetched = await diffChangedMessages(database, conv.id, messages);
            const changed = pinsUnread ? await ownLinesOnly(database, conv.id, fetched) : fetched;
            if (changed.length === 0) continue;

            await acquireSyncLock();
            try {
                // Under the lock, with no await since: an account that began to leave meanwhile has its page written nowhere,
                // its chats' lock marks with it (ownListRead; max review of #3358, U1).
                if (!asked.stays()) return false;
                await database.withTransactionAsync(async () => {
                    for (const m of changed) {
                        await upsertFetchedMessage(database, conv.id, m, myIdentity?.publicKey, conv.type);
                    }
                });
            } finally {
                releaseSyncLock();
            }
        }

        // The last page was a network await too.
        if (!(await onThisCopy(database))) return false;
        if (seenDeleted.size > 0 && !pinsUnread) {
            try {
                await blankLinesOfDeletedAccounts(database, seenDeleted, myIdentity?.publicKey);
            } catch (e) {
                console.warn('[Sync] Could not blank the lines of deleted accounts:', e);
            }
        }

        // Local cleanup of conversations that were deleted/consolidated on the server; none while the pins are unread (the
        // gate: a prune is the node's word on a DM's rows too).
        try {
            const requestIds = (convData.requests?.conversations || []).map((c: any) => c.id);
            // One the list now names as a request waiting for the member is no longer known to be an ordinary chat.
            for (const id of requestIds) await database.runAsync('UPDATE conversations SET listed = NULL WHERE id = ? AND listed IS NOT NULL', [id]);
            const serverIds = [...convData.conversations.map((c: any) => c.id), ...requestIds];
            const localConvs = await database.getAllAsync<any>(
                'SELECT conversation_id FROM conversation_participants WHERE public_key = ?',
                [publicKey]
            );
            const localIds = localConvs.map(lc => lc.conversation_id);
            // And none while the DM guard list can't be read: a pruned DM's row is the re-seed's source after the member's
            // reset, so an unpinned DM the node omits now would be forgotten for good (§3.4 amendment 8 (a), GD5a).
            const listUnread = listUnreadAtStart || await dmConversationsSeen(database).then(() => false, () => true);
            const toDelete = pinsUnread || listUnread ? [] : localIds.filter(id => !serverIds.includes(id));
            if (toDelete.length > 0) {
                console.log(`[Sync] Pruning ${toDelete.length} legacy/consolidated conversations locally...`);
                await acquireSyncLock();
                try {
                    await database.withTransactionAsync(async () => {
                        for (const id of toDelete) {
                            await database.runAsync('DELETE FROM messages WHERE conversation_id = ?', [id]);
                            await database.runAsync('DELETE FROM conversation_participants WHERE conversation_id = ?', [id]);
                            await database.runAsync('DELETE FROM conversations WHERE id = ?', [id]);
                        }
                    });
                } finally {
                    releaseSyncLock();
                }
            }
        } catch (pruneErr) {
            console.error('[Sync] Failed to prune legacy conversations:', pruneErr);
        }

        // The DM guard: every conversation the node lists as a DM is remembered as one, and any held under another type
        // that is a known DM (seen as one, or holding an encrypted line) goes back to being one.
        await rememberDmConversations(convData.conversations.filter((c: any) => c?.id && (c.type || 'dm') === 'dm').map((c: any) => c.id), database);
        await holdDmTypes(database);

        // Let in once (slice S3b): a request waiting here from someone the member let in is accepted now, as a tap on its card
        // would (none with the pins unread: the block check needs every key the opener is known by here). The list kept loses
        // it, and one more pass brings the chat, as after the card's Accept (app/(tabs)/chats.tsx onAccepted).
        const listedRequests: any[] = Array.isArray(convData.requests?.conversations) ? convData.requests.conversations : [];
        const direct = listedRequests.filter((c) => isDirectRequestFor(c, publicKey));
        if (direct.length > 0 && pinsNow && !(await isGuestCopy(anchorUrl))) {
            const people = await requestPeople(database, direct, publicKey, pinsNow);
            // To this community only, the one the list was read from (#3319 review F3), and never over an answer of the
            // member's since that read (F2).
            const quiet = people ? await quietlyLetIn(publicKey, direct, people, anchorUrl, asked, decidedBefore) : new Set<string>();
            if (quiet.size > 0 && await onThisCopy(database) && await asked.still()) {
                const left = listedRequests.filter((c) => !quiet.has(String(c.id)));
                const count = Number.isSafeInteger(convData.requests.count) ? convData.requests.count : listedRequests.length;
                await saveMessageRequests(publicKey, expectedDbName, { ...convData.requests, count: Math.max(left.length, count - quiet.size), conversations: left });
                setTimeout(() => { void syncMessages(publicKey); }, 0);
            }
        }

        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('sync_data_updated');
        return everyPageRead;
    } catch (err) {
        console.log('[Sync] Failed to pull messages natively', err);
        return false;
    }
}

// Conversations with a fetch already in flight. The chat screen fires this every
// 3s AND on every WS nudge; when the node is slow (observed 5-10s responses on the
// 1cpu test VM under load), stacking overlapping requests onto it makes it slower —
// each tick must skip, not pile on.
// A caller that asks while one is in flight shares its answer: the chat's first poll then waits for the Requests card's
// preview fetch instead of returning before the node has answered (PR #2540 review 4393642152).
const _conversationSyncsInFlight = new Map<string, Promise<boolean>>();

// How many lines of mine the node has taken (its 200) per conversation, counted before the line's row says so: a page asked
// for before one of them was taken doesn't have it, so its poll drops none of my lines (dropMyWithdrawnRequestLines).
const _ownLinesTaken = new Map<string, number>();
function ownLineTaken(conversationId: string): void {
    _ownLinesTaken.set(conversationId, (_ownLinesTaken.get(conversationId) ?? 0) + 1);
}

// The decisions on a message request the node took from this phone (its 200), numbered, with the request as each one
// answered it: a read asked for before one of them doesn't carry it, so it writes that answer in place of its own (PR #2540
// review 4395706539). Each read notes the count as it is asked.
let _requestDecisions = 0;
const _requestDecided = new Map<string, { n: number; request: string }>();

/**
 * The member's own answers to message requests on this phone that let in once's quiet accept never goes over (#3319 review
 * F2): Accept, Ignore or Decline on one request on its way to the node (by conversation id; counted from the tap, before any
 * await), Decline all on its way (any community), and Decline all as a community's node took it (by its file: the decision
 * count then, as {@link _requestDecided} numbers each one).
 */
const _requestsAnswering = new Map<string, number>();
let _allRequestsDeclining = 0;
const _allRequestsDeclined = new Map<string, number>();

/** One more (`by` 1) or one fewer (-1) of the member's answers on its way for this request. */
function answeringRequest(conversationId: string, by: 1 | -1): void {
    const left = (_requestsAnswering.get(conversationId) ?? 0) + by;
    if (left > 0) _requestsAnswering.set(conversationId, left);
    else _requestsAnswering.delete(conversationId);
}

/**
 * Whether the member answered this request in `file`'s community on this phone since a list read when `asOf` decisions had
 * been taken (its own answer, or Decline all there), or an answer of theirs is on its way now: let in once then leaves it.
 */
function memberAnsweredSince(conversationId: string, file: string, asOf: number): boolean {
    return (_requestDecided.get(conversationId)?.n ?? 0) > asOf || (_allRequestsDeclined.get(file) ?? 0) > asOf
        || _requestsAnswering.has(conversationId) || _allRequestsDeclining > 0;
}

/** Let in once's quiet accept was not sent: the member answered that request themselves (memberAnsweredSince). */
class AnsweredByMemberError extends Error {
    constructor() {
        super('The member answered this message request themselves.');
        this.name = 'AnsweredByMemberError';
    }
}

/** True for a quiet accept left because the member answered the request themselves: never pressed again this run. */
export function isAnsweredByMember(e: unknown): boolean {
    return e instanceof AnsweredByMemberError;
}

/**
 * The request a read of the node's leaves on one conversation, the read asked for when `asOf` decisions had been taken
 * here, over the row's (`held`, its stored JSON; null or undefined for none): a decision taken since writes its own answer;
 * an acceptance held stays against a read of the same request still naming it waiting (core requestAfterRead), and
 * undefined says to leave the row as it is; otherwise the read's, as stored JSON or null. Asked just before the write, with
 * no await between, so a decision landing first is always seen.
 */
function requestAfterReadHere(conversationId: string, held: string | null | undefined, read: unknown, asOf: number): string | null | undefined {
    const decided = _requestDecided.get(conversationId);
    if (decided && decided.n > asOf) return decided.request;
    let prev: any = null;
    if (typeof held === 'string') { try { prev = JSON.parse(held); } catch { prev = null; } }
    const next = requestAfterRead(prev, { request: (read ?? null) as any });
    if (prev && next === prev) return undefined;
    return next ? JSON.stringify(next) : null;
}

/**
 * This conversation's newest lines and its request from the node, written to this phone. True once the node's answer has
 * been written here (its lines, and a request's people and withdrawn lines); false when there was no answer, or the pins'
 * gate kept it out, so the chat screen knows whether what it reads is the node's word yet.
 */
export function syncSingleConversation(conversationId: string, community?: ChatCommunity): Promise<boolean> {
    // One poll per chat and community at a time: a chat open in place is another community's, never shares the one in use's.
    const key = community ? `${getDatabaseFilenameForNode(community)}\n${conversationId}` : conversationId;
    const running = _conversationSyncsInFlight.get(key);
    if (running) return running;
    const run = syncSingleConversationOnce(conversationId, community).finally(() => _conversationSyncsInFlight.delete(key));
    _conversationSyncsInFlight.set(key, run);
    return run;
}

async function syncSingleConversationOnce(conversationId: string, community?: ChatCommunity): Promise<boolean> {
    // Before anything awaits: an account on its way off the phone as the poll begins, or that begins to leave before its page
    // is written, has nothing of it written, a group's lock mark least of all (account-leaving.ts; max review of #3358, U1).
    const stays = accountStays();
    try {
        // The community asked and its file, taken together (chatCopyForRequest): the page is written into that file only.
        // `community`: a chat open in place (slice S2), read from its own server into its own copy.
        const here = await chatCopyForRequest(community);
        const anchorUrl = here.anchorUrl;
        if (!anchorUrl) return false;
        // In place, only a chat that community's own copy already holds as a direct one (#3305 review F1): any other id (a
        // link can name an enterprise's discussion, a group's or an event's chat) asks that server nothing and writes
        // nothing, its lines, its pins, its DM guard list, its mute or its deleted accounts' memory, anywhere.
        if (here.inPlace && !(await heldAsDmThrough(here.database, conversationId))) return false;
        const takenBefore = _ownLinesTaken.get(conversationId) ?? 0;
        const decidedBefore = _requestDecisions;

        // 12s (not 5s) to ride out a slow node: an abort throws the whole response
        // away and the incoming message waits for the NEXT tick to try again — that
        // retry loop is how a "message took 20 seconds to arrive" report happens.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        let msgRes;
        try {
            msgRes = await signedGet(`/api/messages/${conversationId}`, { signal: controller.signal, anchorUrl });
        } catch (e: any) {
            console.warn(`[Sync] conversation ${String(conversationId).slice(0, 8)} fetch failed/timed out: ${e?.message || e}`);
            return false;
        } finally {
            clearTimeout(timeout);
        }

        if (!msgRes.ok) {
            console.warn(`[Sync] conversation ${String(conversationId).slice(0, 8)} fetch returned ${msgRes.status}`);
            return false;
        }

        const msgData = await msgRes.json();
        if (msgData?.conversation && 'mute' in msgData.conversation) {
            rememberChatMute(conversationId, msgData.conversation.mute ?? null);
        }
        const messages = msgData.messages;
        if (!Array.isArray(messages)) return false;

        // The page's community's copy, or nothing: the member switched while it was on its way (dropped, not an error). Nor
        // once an account has begun to leave the phone: a clear makes the copy again under the same name, so its handle alone
        // doesn't say so.
        const database = await here.handle();
        if (!database || !stays()) return false;

        // This runs every 3s while a chat is open (plus on every WS nudge), so the
        // no-change fast path matters: diff BEFORE taking the lock, and bail without
        // locking or emitting when the server state matches local. Re-upserting the
        // full history here on every tick is what built the 8–175s lock queues
        // observed on-device (2026-07-17).
        const changed = await diffChangedMessages(database, conversationId, messages);

        // Read receipts: apply peers' read cursors (newer servers include them),
        // so ticks flip to read while the chat is open. Monotonic — never regress.
        const myIdentity = await loadIdentity();
        // The pins before the node's lines, through this poll's handle: the account's first read with this file open seeds
        // it from the lines held before these (dmPins), and first sight judges on those (§3.4 amendments 3 and 5). The gate:
        // with the pins unread, nothing of the node's is written into a DM here; another chat's poll blanks nothing and moves
        // no held line by its id (§3.4 amendment 6 §4, the narrow gate), and its own lines go on arriving.
        let pollPinsUnread = false;
        if (myIdentity?.publicKey) {
            try {
                await dmPins.read(myIdentity.publicKey, database);
            } catch {
                // A chat open in place is a DM (slice S2): with its pins unread, nothing of the node's is written.
                if (here.inPlace || await isDmHere(database, conversationId, msgData.conversation?.type)) return false;
                pollPinsUnread = true;
            }
        }
        // A chat open in place (slice S2) has no full sync of its community to hear the node's listing of it (syncMessages,
        // when the phone is set there): its pin hears this page's listing instead, exactly as that pass and the refresh hear
        // it (writeConversationFromNode): an offer, never a move. The check before the next send or read then applies the
        // resting rule there (DESIGN-dm-key-signal-model: a notice and carry on, a verified person's change pauses).
        if (here.inPlace && myIdentity?.publicKey && msgData.conversation && Array.isArray(msgData.conversation.participants)) {
            const me = myIdentity.publicKey;
            await updatePinsWithList(me, database, (pins, verified) => applyListingsToPins(pins, me, [{ ...msgData.conversation, id: conversationId }], verified)).catch(() => {});
        }
        // The node's word on the chat's request, after the gate and never while the pins are unread: it decides whether the
        // chat is in the list (isRequestFor) and whether it has a composer (requestModeOf), so a node answering a request on a
        // DM held here would hide that chat and stop its sends in the very state the gate exists for (review 4395542064).
        // Never over a decision taken here since this page was asked, nor an acceptance it still names waiting (review
        // 4395706539).
        if (!pollPinsUnread && msgData?.conversation && 'request' in msgData.conversation) {
            try {
                const conv = msgData.conversation;
                const held = await database.getFirstAsync<{ request: string | null }>('SELECT request FROM conversations WHERE id = ?', [conversationId]);
                const reqJson = requestAfterReadHere(conversationId, held?.request, conv.request, decidedBefore);
                if (reqJson !== undefined) await database.runAsync(`
                    INSERT INTO conversations (id, type, post_id, name, created_by, created_at, request)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET request = excluded.request
                    WHERE request IS NOT excluded.request
                `, [
                    conversationId,
                    conv.type || 'dm',
                    conv.postId || conv.post_id || null,
                    conv.name || null,
                    conv.createdBy || '',
                    conv.createdAt || new Date().toISOString(),
                    reqJson
                ]);
            } catch (e: any) {
                console.warn(`[Sync] Could not update conversation request: ${e?.message || e}`);
            }
        }
        // A message request for this reader: its people, so its line opens and the chat is named (PR #2540 review
        // 4393642140), and none of its opener's lines the node no longer has (review 4393642158). None of this while the
        // pins are unread: the gate above.
        let withdrawn = 0;
        const req = msgData.conversation?.request;
        // In place too (slice S3): the gate above let only a chat that community's copy holds as a direct one through (a request
        // listed for this member by that community's own server is written there as one: requestsInPlace), so its people and
        // its withdrawn lines are written into that copy exactly as when the phone is set there.
        if (!pollPinsUnread && myIdentity?.publicKey && msgData.conversation?.type === 'dm' && typeof req?.from === 'string' && req.from !== myIdentity.publicKey) {
            try {
                const mine = await database.getFirstAsync('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?', [conversationId, myIdentity.publicKey]);
                if (!mine) await writeConversationFromNode(database, { ...msgData.conversation, id: conversationId }, decidedBefore);
            } catch (e: any) {
                console.warn(`[Sync] Could not write the request's people: ${e?.message || e}`);
            }
            try {
                withdrawn = await dropWithdrawnRequestLines(database, conversationId, req, messages);
            } catch (e: any) {
                console.warn(`[Sync] Could not drop the request's withdrawn lines: ${e?.message || e}`);
            }
        } else if (!pollPinsUnread && myIdentity?.publicKey && msgData.conversation?.type === 'dm' && req?.from === myIdentity.publicKey && req.state !== 'accepted') {
            // My own request, not accepted: none of my lines the node withdrew stay here either (Cancel request from the web
            // app, or a page from before this phone's own cancel; review 4394119880). Never one still sending or failed, and
            // none at all on a page asked for before the node took a line of mine.
            try {
                withdrawn = await dropMyWithdrawnRequestLines(database, conversationId, myIdentity.publicKey, messages,
                    () => (_ownLinesTaken.get(conversationId) ?? 0) === takenBefore);
            } catch (e: any) {
                console.warn(`[Sync] Could not drop my request's withdrawn lines: ${e?.message || e}`);
            }
        } else if (!pollPinsUnread && myIdentity?.publicKey && msgData.conversation?.type === 'dm' && req?.from === myIdentity.publicKey && req.state === 'accepted') {
            // My own request, accepted: none of the other person's lines the node withdrew stay here either (review
            // 4399348635). The one I made after they withdrew theirs, while they blocked me, reads as mine (the node turns
            // the row round for me); their line answered it, and their Cancel request took that line back. The stretch the
            // page covers alone, as for a request I accepted (above).
            const others = (Array.isArray(msgData.conversation.participants) ? msgData.conversation.participants : [])
                .filter((pk: unknown): pk is string => typeof pk === 'string' && pk !== '' && pk !== myIdentity.publicKey);
            if (others.length === 1) {
                try {
                    withdrawn = await dropWithdrawnRequestLines(database, conversationId, { from: others[0], state: 'accepted' }, messages);
                } catch (e: any) {
                    console.warn(`[Sync] Could not drop the other's withdrawn lines: ${e?.message || e}`);
                }
            }
        }
        const cursors = msgData.conversation?.readCursors;
        let cursorAdvances: Array<{ publicKey: string; lastReadAt: string }> = [];
        if (Array.isArray(cursors) && myIdentity?.publicKey) {
            const localCursors = await database.getAllAsync<{ public_key: string; last_read_at: string | null }>(
                'SELECT public_key, last_read_at FROM conversation_participants WHERE conversation_id = ?',
                [conversationId]
            );
            const localReadAt = new Map(localCursors.map(r => [r.public_key, r.last_read_at]));
            cursorAdvances = cursors.filter((cur: any) => {
                if (!cur?.publicKey || cur.publicKey === myIdentity.publicKey || !cur.lastReadAt) return false;
                if (!localReadAt.has(cur.publicKey)) return false; // no participant row to update
                const current = localReadAt.get(cur.publicKey);
                return current == null || current < cur.lastReadAt;
            });
        }

        // A tombstone of a deleted account on this page: the older lines of theirs on this phone go too
        // (blankLinesOfDeletedAccounts, which runs once per account, not on every poll).
        const gone = new Set<string>();
        for (const m of messages) {
            const k = accountDeletedAuthor(m, msgData.conversation?.type);
            if (k) gone.add(k);
        }
        let blanked = 0;
        if (gone.size > 0 && !pollPinsUnread) {
            try {
                blanked = await blankLinesOfDeletedAccounts(database, gone, myIdentity?.publicKey);
            } catch (e: any) {
                console.warn(`[Sync] Could not blank the lines of deleted accounts: ${e?.message || e}`);
            }
        }

        if (changed.length === 0 && cursorAdvances.length === 0) {
            if (blanked > 0 || withdrawn > 0) {
                emitAppEvent('sync_data_updated');
            }
            return true;
        }

        const own = pollPinsUnread ? await ownLinesOnly(database, conversationId, changed) : changed;
        await acquireSyncLock();
        try {
            // Under the lock, with no await since: a leave's clear waits for it, so none is half done under this write.
            if (!stays()) return false;
            // One transaction for the whole burst — a single commit instead of a
            // disk flush per message.
            await database.withTransactionAsync(async () => {
                for (const m of own) {
                    await upsertFetchedMessage(database, conversationId, m, myIdentity?.publicKey, msgData.conversation?.type);
                }
                for (const cur of cursorAdvances) {
                    await database.runAsync(
                        'UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ? AND (last_read_at IS NULL OR last_read_at < ?)',
                        [cur.lastReadAt, conversationId, cur.publicKey, cur.lastReadAt]
                    );
                }
            });
        } finally {
            releaseSyncLock();
        }
        // The DM guard: a chat whose lines are encrypted is a DM here, whatever type the node gives it. In place exactly as
        // when the phone is set there: only what the node calls a DM is remembered, in the file the page was written to.
        if (msgData?.conversation?.type === 'dm') await rememberDmConversations([conversationId], database);
        // The DM guard's sweep reads the copy in use's pins and key memory: never over a copy open in place.
        if (!here.inPlace) await holdDmTypes(database);

        emitAppEvent('sync_data_updated');
        return true;
    } catch (err: any) {
        // Background polling — don't alert, but DO leave a trace for USB debugging.
        console.warn(`[Sync] conversation ${String(conversationId).slice(0, 8)} sync failed: ${err?.message || err}`);
        return false;
    }
}

/** How many lines the node answers a conversation's read with when the phone names no limit (its clampLimit). */
const NODE_PAGE_LINES = 50;

/**
 * A request's lines on the phone of the person it was for that the node no longer has: its opener withdrew them (Cancel
 * request; PR #2540 review 4393642158), whatever the request's state now and however many lines the node still holds.
 * While it isn't accepted every line in it is the opener's, one a request, so the newest page holds them all; once
 * accepted, only the stretch the page covers is judged, as a line older than the page's oldest is still theirs. Only the
 * opener's lines go, never one of this reader's (their unsent ones neither). Their photos' decrypted copies go with them.
 * Also the other person's lines in the reader's own request once it is accepted (`req.from` is then that person; review
 * 4399348635).
 */
async function dropWithdrawnRequestLines(database: SQLite.SQLiteDatabase, conversationId: string, req: { from: string; state?: string }, messages: any[]): Promise<number> {
    const { where, args } = linesNotOnPage(conversationId, req.from, messages, req.state === 'accepted');
    const gone = await database.getAllAsync<{ id: string }>(`SELECT id FROM messages WHERE ${where}`, args);
    if (gone.length === 0) return 0;
    await database.runAsync(`DELETE FROM messages WHERE ${where}`, args);
    for (const g of gone) await forgetCachedChatImage(g.id);
    return gone.length;
}

/**
 * My own request's lines, not accepted, on my phone that the node no longer has (review 4394119880): I cancelled it from the
 * web app, or a page from before this phone's own cancel brought them back. Every line in it is mine, so the newest page
 * holds them all; a full one judges only the stretch it covers. One still sending or failed isn't on the node yet and stays
 * (review 4390653768), and none go when `pageIsCurrent` says, once they are read, that the node took a line of mine after
 * the page was asked for: the page lacks it. Each goes by its id, so a line written meanwhile is never among them. Their
 * photos' decrypted copies go with them.
 */
async function dropMyWithdrawnRequestLines(database: SQLite.SQLiteDatabase, conversationId: string, me: string, messages: any[], pageIsCurrent: () => boolean): Promise<number> {
    const { where, args } = linesNotOnPage(conversationId, me, messages, true);
    const rows = await database.getAllAsync<{ id: string; metadata: string | null }>(`SELECT id, metadata FROM messages WHERE ${where}`, args);
    const gone = rows.filter(r => !isUndeliveredRow(r.metadata, me, me));
    if (gone.length === 0 || !pageIsCurrent()) return 0;
    for (const g of gone) {
        await database.runAsync('DELETE FROM messages WHERE id = ? AND conversation_id = ?', [g.id, conversationId]);
        await forgetCachedChatImage(g.id);
    }
    return gone.length;
}

/** `author`'s lines in a conversation that the node's page doesn't list; with `pageOnly`, a full page's stretch alone. */
function linesNotOnPage(conversationId: string, author: string, messages: any[], pageOnly: boolean): { where: string; args: string[] } {
    const onNode = messages.map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === 'string');
    const stamps = messages.map((m: any) => m?.timestamp).filter((t: unknown): t is string => typeof t === 'string').sort();
    const where = ['conversation_id = ?', 'author_pubkey = ?'];
    const args: string[] = [conversationId, author];
    if (onNode.length > 0) { where.push(`id NOT IN (${onNode.map(() => '?').join(', ')})`); args.push(...onNode); }
    if (pageOnly && messages.length >= NODE_PAGE_LINES && stamps.length > 0) { where.push('timestamp > ?'); args.push(stamps[0]); }
    return { where: where.join(' AND '), args };
}


export async function getConversation(id: string, myPubkey?: string, community?: ChatCommunity) {
    // `community`: a chat open in place (slice S2), read from that community's own copy, its photos on its own server.
    const copy = await chatReadFor(community);
    const database = copy.database;
    let res: any;
    if (myPubkey) {
        res = await database.getFirstAsync<any>(`
            SELECT c.name, c.type as type, c.post_id as postId, c.request as request, c.listed as listed, c.created_by as createdBy, p.title as postTitle,
            COALESCE(
                (SELECT mt2.status FROM marketplace_transactions mt2
                 WHERE mt2.post_id = c.post_id
                   AND mt2.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                   AND mt2.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                 ORDER BY mt2.created_at DESC LIMIT 1),
                p.status,
                c.post_status
            ) as postStatus,
            p.price_type, p.price_c,
            ${otherParticipantSql('callsign')} as otherCallsign,
            ${otherParticipantSql('public_key')} as otherPubkey,
            ${otherParticipantSql('avatar_url')} as otherAvatar,
            ${otherKeysSql()} as otherKeys,
            mt.id as pendingTxId,
            mt.amount_c as pendingAmount_c,
            mt.buyer_pubkey as txBuyerPubkey,
            mt.seller_pubkey as txSellerPubkey
            FROM conversations c 
            LEFT JOIN posts p ON c.post_id = p.id
            LEFT JOIN marketplace_transactions mt ON mt.post_id = c.post_id AND mt.status = 'pending'
                AND (mt.buyer_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id)
                     AND mt.seller_pubkey IN (SELECT public_key FROM conversation_participants WHERE conversation_id = c.id))
            WHERE c.id = ?`, [myPubkey, myPubkey, myPubkey, myPubkey, id]);
        if (res) {
            // Every key the DM's other person is known by here (dm-blocked.ts): the thread is blocked when any is, so a block
            // holds across their re-key, after the pin has followed the listing to the new key too. Unreadable pins: the
            // participants alone.
            let pin: DmPeerPin | null = null;
            try { pin = dmPinFor(await dmPins.read(myPubkey, database), id); } catch { pin = null; }
            res.peerKeys = isDmType(res.type) ? dmPeerKeys(res.otherKeys, pin) : (res.otherPubkey ? [String(res.otherPubkey)] : []);
            if (copy.inPlace && copy.anchorUrl) res.otherAvatar = onCommunity(copy.anchorUrl, res.otherAvatar);
        }
    } else {
        res = await database.getFirstAsync<any>('SELECT name, post_id as postId, request FROM conversations WHERE id = ?', [id]);
    }
    if (res?.request && typeof res.request === 'string') {
        try { res.request = JSON.parse(res.request); } catch {}
    }
    return res;
}

/**
 * The lines the update's seed held for each DM it couldn't pin from its rows (§3.4 amendments 3-5), per account and
 * community file ({@link heldKey}): by the DM's folded id, each line as the open needs it ({@link HeldLine}), in the order
 * this phone stored them. First sight in that file judges those DMs on these, whatever the node rewrites, tombstones or
 * prunes meanwhile. Kept in storage too (dmLinesAtUpdateStoreKey, one key per file), so a DM the seed's run didn't judge
 * (listed with several keys, or not listed) is judged on them in a later run (#1872/#1873 confirmation 2, finding 1).
 * This is the run's copy; `stored`: it is what the store holds, so removing a DM's lines may be written there (the store
 * is written from the database once).
 */
const dmLinesHeldAtUpdate = new Map<string, { lines: Map<string, HeldLine[]>; stored: boolean }>();
const heldKey = (me: string, file: string) => `${me.toLowerCase()}\n${file}`;

/** One line as the update held it: the open's inputs only, never a date, a type or a decrypted word. */
interface HeldLine { id: string; conversation_id: string; author_pubkey: string; ciphertext: string; nonce: string; metadata: unknown }

function heldLineOf(r: any): HeldLine {
    return { id: r.id, conversation_id: r.conversation_id, author_pubkey: r.author_pubkey, ciphertext: r.ciphertext, nonce: r.nonce, metadata: r.metadata ?? null };
}

/** The stored held lines, or null when they aren't an object of arrays. */
function parseLinesHeldAtUpdate(raw: string): Map<string, HeldLine[]> | null {
    try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        return new Map(Object.entries(v as Record<string, unknown>).filter((e): e is [string, HeldLine[]] => Array.isArray(e[1])));
    } catch {
        return null;
    }
}

/**
 * The most one file's held lines may take in the store (§3.4 amendment 5, finding 3 of confirmation 3): Android's store
 * reads a value through a window of about 2 MB, so a bigger one is written and then never read again.
 */
const HELD_LINES_MAX_BYTES = 1024 * 1024;

/** True when `value`, as UTF-8, is over {@link HELD_LINES_MAX_BYTES}. */
function overHeldLinesCap(value: string): boolean {
    return value.length > HELD_LINES_MAX_BYTES || utf8Length(value) > HELD_LINES_MAX_BYTES;
}

/** UTF-8 bytes of a string, without building it. */
function utf8Length(value: string): number {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c < 0x80) bytes += 1;
        else if (c < 0x800) bytes += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
        else bytes += 3;
    }
    return bytes;
}

/**
 * The held lines one community file takes when the same community's copy at another address comes to it (a community
 * followed to its new address: utils/community-copy-carry.ts), add-only: the lines of each DM `here` holds none of are
 * added, while the value stays within {@link HELD_LINES_MAX_BYTES}; nothing here is replaced, and nothing is written over
 * a value that isn't held lines. Nothing here: the carried value as stored. Null: nothing to write.
 */
export function linesHeldWithCarried(here: string | null, carried: string): string | null {
    if (here == null) return carried;
    const mine = parseLinesHeldAtUpdate(here);
    const theirs = parseLinesHeldAtUpdate(carried);
    if (!mine || !theirs) {
        if (!mine) console.warn('[DM pins] A carried community\'s held lines were not added: the ones here can\'t be read, and nothing is written over them');
        return null;
    }
    let bytes = utf8Length(JSON.stringify(Object.fromEntries(mine)));
    let added = 0;
    let refused = 0;
    for (const [id, lines] of theirs) {
        if (mine.has(id)) continue;
        const more = utf8Length(JSON.stringify(id)) + 1 + utf8Length(JSON.stringify(lines)) + (mine.size ? 1 : 0);
        if (bytes + more > HELD_LINES_MAX_BYTES) { refused++; continue; }
        mine.set(id, lines);
        bytes += more;
        added++;
    }
    if (refused) console.warn(`[DM pins] ${refused} of a carried community's held chats couldn't be added here: over the cap; they stay under its old address`);
    return added ? JSON.stringify(Object.fromEntries(mine)) : null;
}

/**
 * The update's held lines for this account in this file: the run's copy, or the stored one, read once a run (none
 * stored, or not an object: none). Null when the store can't be read: tried again on the next call, and until then
 * nothing that needs judging there is judged (a send refuses), since what the update held can't be told apart from what
 * the node wrote since.
 */
async function linesHeldAtUpdate(me: string, file: string): Promise<Map<string, HeldLine[]> | null> {
    const key = heldKey(me, file);
    const copy = dmLinesHeldAtUpdate.get(key);
    if (copy) return copy.lines;
    let raw: string | null;
    try { raw = await AsyncStorage.getItem(dmLinesAtUpdateStoreKey(me, file)); } catch { return null; }
    const parsed = raw == null ? null : parseLinesHeldAtUpdate(raw);
    dmLinesHeldAtUpdate.set(key, { lines: parsed ?? new Map(), stored: parsed != null });
    return dmLinesHeldAtUpdate.get(key)!.lines;
}

/**
 * The seed's held lines for one file, kept for every later run (§3.4 amendments 4 and 5): written only when none are
 * stored for that file (`{}` when the rows pin every DM), so a later run that seeds the file again can't replace the
 * update's memory with what the node has written since. True when the store holds them. False when it can't: the write
 * failed (the store is full), the value is over {@link HELD_LINES_MAX_BYTES}, or the key can't be read (never written
 * over) or holds something that isn't held lines. Then this run judges on `lines`, and the seed marks those DMs heldLost.
 */
async function keepLinesHeldAtUpdate(me: string, file: string, lines: Map<string, HeldLine[]>): Promise<boolean> {
    const key = heldKey(me, file);
    let stored: string | null;
    try {
        stored = await AsyncStorage.getItem(dmLinesAtUpdateStoreKey(me, file));
    } catch {
        dmLinesHeldAtUpdate.set(key, { lines, stored: false });
        return false;
    }
    const parsed = stored == null ? null : parseLinesHeldAtUpdate(stored);
    if (parsed) {
        dmLinesHeldAtUpdate.set(key, { lines: parsed, stored: true });
        return true;
    }
    const value = JSON.stringify(Object.fromEntries(lines));
    if (stored != null || overHeldLinesCap(value)) {
        dmLinesHeldAtUpdate.set(key, { lines, stored: false });
        return false;
    }
    try {
        await AsyncStorage.setItem(dmLinesAtUpdateStoreKey(me, file), value);
    } catch {
        dmLinesHeldAtUpdate.set(key, { lines, stored: false });
        return false;
    }
    dmLinesHeldAtUpdate.set(key, { lines, stored: true });
    return true;
}

/**
 * After each pin write (§3.4 amendment 4), in the file the writer named: the held lines of each DM now pinned are dropped
 * from that file's store, since first sight never reads them again. An unchecked first-seen pin keeps them (its send or
 * check judges it on them), as do rule 5 and a DM never listed again. The key stays, `{}` once every DM is pinned. A
 * store this run couldn't keep, or read, is left alone.
 */
async function dropHeldLinesOfPinned(me: string, pins: DmPeerPins, file: string): Promise<void> {
    if (!(await linesHeldAtUpdate(me, file))) return;
    const copy = dmLinesHeldAtUpdate.get(heldKey(me, file));
    if (!copy?.stored) return;
    const left = new Map(copy.lines);
    for (const id of copy.lines.keys()) {
        const e = dmSightFor(pins, id);
        if (e && !isUnplacedSight(e) && (e.checked || e.by !== 'first-seen')) left.delete(id);
    }
    if (left.size === copy.lines.size) return;
    await AsyncStorage.setItem(dmLinesAtUpdateStoreKey(me, file), JSON.stringify(Object.fromEntries(left)));
    copy.lines = left;
}

/**
 * This phone's DM pins, one copy per account in memory, changed through one queue (utils/dm-peer-pins.ts), and the
 * update's seed, once per community file (§3.4 amendment 5). Every reader and writer names the database handle it holds
 * (never the open file looked up again afterwards), and the book seeds that handle's file at this account's first ask
 * with it, before answering: every writer of a DM's participant rows or lines asks first, and writes nothing of the
 * node's there when the ask throws, so the seed reads the rows and lines this phone held before this run's node writes.
 * A DM its rows pin is pinned from them, checked; one whose rows name more than one other key keeps the encrypted lines
 * first sight reads (judgeThread), as held now and kept for every later run in that file's own key, and the first sync
 * pass judges it on them before it writes a line (§3.4 amendment 3, companion a). The lines are kept first, then the
 * rows' pins and the file's name go in one pin write: where the lines couldn't be kept, that same write marks those DMs
 * heldLost (amendment 4). The pin's memory starts at the update (§3.7): a rewrite, a tombstone or a prune the node serves
 * after it moves nothing; one before it is the phone's history as it stands.
 *
 * After the member's reset (`reset`, the marker's date: §3.4 amendment 7) the rows are what this build wrote since the
 * update, not the phone's history, so they pin nothing on their word: each DM they name one other key in is judged on
 * the lines the file holds ({@link judgeRowsAfterReset}), and the same one pin write replaces the marker.
 */
const dmPins = createDmPinBook<SQLite.SQLiteDatabase>(AsyncStorage, (database) => dbFileOf.get(database), async (me, database, file, reset) => {
    // Through the handle the caller named, and thrown when the rows can't be read: a seed records nothing it didn't read.
    // The 2,000 DMs held longest only (§3.4 amendment 6 §1), rows' pins, kept lines and marks together; the rest pinless.
    const held = seedBudget(await readDmPeersHeld(database));
    const lines = new Map<string, HeldLine[]>();
    for (const id of dmsTheRowsDontPin(held, me)) {
        const window = await sightWindow(id, database);
        if (window.length) lines.set(id, window.map(heldLineOf));
    }
    const kept = await keepLinesHeldAtUpdate(me, file, lines);
    const sights = reset ? await judgeRowsAfterReset(me, file, database, held) : null;
    // The reset no longer costs marks (DESIGN-s7-blocks-verified-everywhere §3.3): the re-seed judges with the member's list.
    const verified = sights ? await dmVerified.read(me) : null;
    return (pins) => {
        const now = new Date().toISOString();
        const seeded = sights && verified ? applyResetSights(pins, sights, now, verified) : seedPinsFromRows(pins, me, held, true);
        return (!kept && markHeldLost(pins, lines.keys(), now)) || seeded;
    };
}, dropHeldLinesOfPinned);

/**
 * The member's verified keys (utils/dm-verified-keys.ts, DESIGN-s7-blocks-verified-everywhere §3.2): one list per account
 * for every community on the phone, read once per run. Written only by the member's Mark as verified, Continue on the
 * verified card and Remove verification (below); every other path here only reads it, to hand it to the pins' rules.
 */
const dmVerified = createDmVerifiedBook(AsyncStorage);

/**
 * A pin rule run in the pins' turn with the member's list as it stands in that turn (#3316 N2). Mark and Continue add to
 * the list inside the tapped chat's pins turn (markDmPeerVerified, acceptOfferedPeer), so a sync, a check or a refresh
 * queued behind a tap reads what the tap wrote, and one queued before it acts first: a listing that lands mid-Mark waits
 * and pauses, as when the mark lived on the pin. (Remove takes a key off first and rests the chat after, in its own turn:
 * a listing heard in between pauses, and that rest then moves it, the same end as one heard after.)
 */
function updatePinsWithList(me: string, database: SQLite.SQLiteDatabase, change: (pins: DmPeerPins, verified: DmVerifiedKeys) => boolean): Promise<boolean> {
    return dmPins.update(me, database, async (pins) => change(pins, await dmVerified.read(me)));
}

interface ResetSight { id: string; rowsKey: string; verdict: SightVerdict }

/**
 * The re-seed after the member's reset (§3.4 amendment 7 §1): each DM in `rows` ({@link seedBudget}'s) whose rows name
 * exactly one other key, judged by the history rule on the lines this file holds of it (the update's kept lines of that
 * file's key, then its {@link sightWindow}), with the rows' key as the listed one. At most SEED_DMS_MAX, once, in the
 * file's turn at the first read after the member's tap. Throws when there is no key to open them with.
 */
async function judgeRowsAfterReset(me: string, file: string, database: SQLite.SQLiteDatabase, rows: ReadonlyArray<any>): Promise<ResetSight[]> {
    const identity = await loadIdentity();
    if (!identity?.privateKey) throw new Error('No identity found.');
    const mine = me.toLowerCase();
    const others = new Map<string, Set<string>>();
    for (const r of rows) {
        const pk = typeof r?.pk === 'string' ? r.pk.toLowerCase() : '';
        if (!pk || pk === mine || typeof r?.id !== 'string') continue;
        const id = dmPinId(r.id);
        if (!others.has(id)) others.set(id, new Set());
        others.get(id)!.add(pk);
    }
    const keptLines = dmLinesHeldAtUpdate.get(heldKey(me, file))?.lines ?? new Map<string, HeldLine[]>();
    const sights: ResetSight[] = [];
    for (const [id, keys] of others) {
        if (keys.size !== 1) continue;
        const rowsKey = [...keys][0];
        const kept = keptLines.get(id) ?? [];
        const keptIds = new Set(kept.map((l) => l.id));
        const thread = new Map([[id, [...kept, ...(await sightWindow(id, database)).filter((r) => !keptIds.has(r.id))]]]);
        sights.push({ id, rowsKey, verdict: await judgeThread(id, identity.privateKey, me, rowsKey, undefined, thread, database) });
    }
    return sights;
}

/** {@link judgeRowsAfterReset}'s verdicts, each kept for a DM still keeping nothing. True when the pins changed. */
function applyResetSights(pins: DmPeerPins, sights: ReadonlyArray<ResetSight>, now: string, verified: DmVerifiedKeys): boolean {
    let changed = false;
    for (const s of sights) if (applyResetVerdict(pins, s.id, s.verdict, s.rowsKey, now, verified)) changed = true;
    return changed;
}

/** How many DMs one file's seed takes (§3.4 amendment 6 §1): a seed entry is about 250 bytes, so at most about 500 KiB. */
const SEED_DMS_MAX = 2000;

/**
 * The participant rows of the {@link SEED_DMS_MAX} DMs this file has held longest (its conversations' `rowid`, the phone's
 * own clock of amendment 3), ids over the cap left out (they get no entry of any kind). `rows`: {@link readDmPeersHeld},
 * in that order. A DM past the budget is pinless: judged at its first send or check, as first sight.
 */
function seedBudget(rows: ReadonlyArray<any>): any[] {
    const taken = new Set<string>();
    const kept: any[] = [];
    for (const r of rows) {
        if (typeof r?.id !== 'string' || !isPinnableId(r.id)) continue;
        const id = dmPinId(r.id);
        if (!taken.has(id)) {
            if (taken.size >= SEED_DMS_MAX) continue;
            taken.add(id);
        }
        kept.push(r);
    }
    return kept;
}

/** The community file a handle reads, as the pins and the held lines name it. */
function fileOfDb(database: SQLite.SQLiteDatabase): string {
    return dbFileOf.get(database) ?? '';
}

/**
 * The member's reset of one community's chat memory (Settings → Chat memory, §3.4 amendment 6 §3), never the
 * phone's own: that community's DM pins are set aside and replaced by the reset's marker, and the next read seeds them
 * over the community file's own rows and the lines the update held there (kept), judging every DM before it trusts one
 * (§3.4 amendment 7). A chat whose history the node withheld may open with the new key: the confirmation says so.
 * The same tap resets that community's DM guard list first (§3.4 amendment 8), in the pins' turn and before they go: its
 * marker keeps every id the pins keep anything for, so a DM whose pin the re-seed drops is still a DM here, never a
 * group's chat sent readable. A list marker that can't be written fails the reset with the pins untouched.
 * `community`: the node's address, as the switcher keeps it.
 */
export async function resetDmChatMemory(community: string): Promise<DmPinsReset> {
    const me = (await loadIdentity())?.publicKey;
    if (!me) throw new Error('No identity found.');
    const file = getDatabaseFilenameForNode(community);
    return dmPins.reset(me, file, (pinIds) => dmSeen.reset(me, file, pinIds));
}

/** As {@link seedDmPinsBeforeLeaving}, for the community open now, before Sign Out drops its tables. Never throws. */
export async function seedDmPinsHere(me: string): Promise<void> {
    try {
        await dmPins.read(me, await getDb());
    } catch (e) {
        console.warn('[DM pins] Could not keep what this phone held in the open community before it goes', e);
    }
    await seedDmGuardBeforeLeaving(me, await getDb().catch(() => null));
}

/** Sign Out's seed of one file's DM guard list from its `dm` rows (§3.4 amendment 8 (b)), as the pins'. Never throws. */
async function seedDmGuardBeforeLeaving(me: string, handle: SQLite.SQLiteDatabase | null): Promise<void> {
    const file = handle ? dbFileOf.get(handle) : null;
    try {
        if (!handle || !file) throw new DmGuardUnreadError();
        await dmSeen.read(me, file, dmRowsOf(handle));
    } catch (e) {
        console.warn(`[DM guard] Could not keep which chats were private in ${file ?? 'the open community'} before it goes`, e);
    }
}

/**
 * Before Sign Out deletes the community files (§3.4 amendment 6 §5): each named file is opened through a handle the pins
 * know, its pins read (which seeds a file not yet seeded since the update, from its own rows), and closed, so the pins
 * kept for the account remember what this phone held there. Never throws and never blocks: a seed that throws is logged,
 * and the file goes anyway.
 */
export async function seedDmPinsBeforeLeaving(me: string, files: readonly string[]): Promise<void> {
    for (const file of files) {
        let handle: SQLite.SQLiteDatabase | null = null;
        try {
            handle = await SQLite.openDatabaseAsync(file, { useNewConnection: true });
            dbFileOf.set(handle, file);
            await dmPins.read(me, handle).catch((e) => console.warn(`[DM pins] Could not keep what this phone held in ${file} before it goes`, e));
            await seedDmGuardBeforeLeaving(me, handle);
        } catch (e) {
            console.warn(`[DM pins] Could not keep what this phone held in ${file} before it goes`, e);
        } finally {
            await handle?.closeAsync().catch(() => {});
        }
    }
}

/**
 * Before a community's copy is carried to its new address (utils/community-copy-carry.ts, inside whileCopyMoves): in each
 * named file, opened through a handle the pins know, the signed-in account's pins are read, which runs the seed waiting
 * there over that file's own rows (the update's, or the re-seed after the member's reset: the reset judged on the rows it
 * was made for), and its DM guard list likewise. So the carry merges two pin books, never a reset's marker or nothing,
 * and no DM pinned at the old address is left to first sight at the new one (confirmation 3 of #2138). Throws when a
 * file's pins can't be read or seeded: the carry then changes nothing. A guard list that can't be read is logged: the
 * pins decide first, and the carry adds to it what it can. With no identity, no account's seed waits here.
 */
export async function seedDmPinsBeforeCarry(files: readonly string[]): Promise<void> {
    const me = (await loadIdentity())?.publicKey;
    if (!me) return;
    for (const file of files) {
        const handle = await SQLite.openDatabaseAsync(file, { useNewConnection: true });
        dbFileOf.set(handle, file);
        try {
            await dmPins.read(me, handle);
            await dmSeen.read(me, file, dmRowsOf(handle))
                .catch((e) => console.warn(`[DM guard] Could not read which chats are private in ${file} before it is carried; the carry adds what it can`, e));
        } finally {
            await handle.closeAsync().catch(() => {});
        }
    }
}

/** For tests: a fresh app session (an update, a restore): the DM pins are read from storage again. */
export function _resetDmPeerPinsForTests(): void {
    dmPins.forget();
    dmVerified.forget();
    dmLinesHeldAtUpdate.clear();
}

/** A DM's key context as its pin has it (utils/dm-peer-pins.ts). */
interface PinnedDmKeyContext extends DMKeyContext {
    /** Keys this phone sealed the DM to before the pinned one: its old lines open under them too. Never the key on offer (dmShownFormer). */
    formerPeers: string[];
    /** The key offered in place of the pinned one, waiting for the member (the DM screen's banner). */
    offered?: DmPeerOffer;
    /** My public key, as the rows name my lines. */
    myPubHex: string;
    /** True while nothing may be sealed here: another key is offered in place of the pinned one, for the member to decide. */
    keyChanged: boolean;
    /** The key offered in the pinned one's place (null: none, or the node lists several): its lines are marked, never read. */
    offeredPeer: string | null;
    /**
     * The pinned key is on the member's list of verified keys, as read (dm-verified-keys.ts showsVerifiedMark): the card's
     * "You marked … as verified" only. Never what decides a pause: the pins' rules do, with the list itself.
     */
    verified?: boolean;
    /** When this phone saw the key change, newest first: one notice each in the thread (getMessages). */
    changedAt?: string[];
}

/** How many encrypted lines first sight reads at each end of a thread (design §3.4 amendments 2 and 3). */
const FIRST_SIGHT_END = 20;

/**
 * The lines first sight judges a DM on (design §3.4 amendments 2 and 3): the 20 encrypted lines this phone has held
 * LONGEST and the 20 it holds MOST RECENTLY, under any spelling of its id (#1872/#1873 confirmation, finding 2), one set
 * when there are 40 or fewer, in the order this phone first stored them. That order is the phone's own clock: `rowid`,
 * which the sync's upsert keeps (ON CONFLICT DO UPDATE, never INSERT OR REPLACE), so a line keeps its place however the
 * node rewrites it. The node's timestamps are not consulted (they are its word; they stay for display and the banner's
 * date line): a flood dated before and after the thread lands at the new end, where it can only be offered, never
 * pinned (P21). The node serves each batch oldest-first by its own insert order (engine getConversationMessages), so
 * within one batch arrival is honest order too. Only encrypted lines count toward the 20 (exact prefix, no tombstones),
 * so rows that aren't lines can't push the old end out. Read through `database`, the handle the caller holds.
 */
async function sightWindow(conversationId: string, database: SQLite.SQLiteDatabase): Promise<any[]> {
    // The pin is kept under the folded id, so first sight reads the thread under every spelling of it this phone holds.
    const lines = `SELECT id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata FROM messages
        WHERE (conversation_id = ? OR conversation_id IN (SELECT id FROM conversations WHERE lower(id) = lower(?)))
        AND substr(nonce, 1, ${V2_NONCE_PREFIX.length}) = ? AND COALESCE(type, '') != 'removed'`;
    const args = [conversationId, conversationId, V2_NONCE_PREFIX];
    const oldest = await database.getAllAsync<any>(`${lines} ORDER BY rowid ASC LIMIT ${FIRST_SIGHT_END}`, args);
    const newest = await database.getAllAsync<any>(`${lines} ORDER BY rowid DESC LIMIT ${FIRST_SIGHT_END}`, args);
    const atOldEnd = new Set(oldest.map(r => r.id));
    return [...oldest, ...newest.reverse().filter(r => !atOldEnd.has(r.id))]
        .filter(r => dmLineKind({ authorPubkey: r.author_pubkey, nonce: r.nonce, type: r.type }) === 'encrypted');
}

/**
 * The history rule for one DM (design §3.4 amendments 1-3): its {@link sightWindow} (as the update's seed held it, for a
 * DM the seed kept lines of), each line with the key it opens under, judged by judgeFirstSight. The old end is the start
 * of the thread this phone can see, so a flood of new lines can't push it out of the judgement (finding 4, P17f); a node
 * that withholds or surrounds the old end in what it serves a restored phone is the stated residual (P23). A line is
 * tried under the listed key, then the keys the listing names as its former ones (`heard.tryKeys`, which only say what
 * to try), then the keys the rows name as authors; as mine sealed to that key, or as that key's own whoever the row names
 * (the node writes the rows, and a re-key moves old lines' author to the new key). One DH derivation per key tried, and
 * only lines not yet placed are tried again.
 */
async function judgeThread(conversationId: string, myPrivHex: string, me: string, listed: string | null, heard: DmHeard | undefined, held: ReadonlyMap<string, HeldLine[]>, database: SQLite.SQLiteDatabase): Promise<SightVerdict> {
    const rows: Array<HeldLine & { type?: string | null }> = held.get(dmPinId(conversationId)) ?? await sightWindow(conversationId, database);
    if (!rows.length) return judgeFirstSight([], listed);
    const mine = me.toLowerCase();
    const tries = [listed, ...(heard?.tryKeys ?? []), ...rows.map(r => pinKeyOf(r.author_pubkey))];
    const candidates = [...new Set(tries.filter((k): k is string => !!k && k !== mine))];
    const placed = new Map<string, string>();
    for (const key of candidates) {
        const left = rows.filter(r => !placed.has(r.id));
        if (!left.length) break;
        // Each spelling's lines under its own id: a line is sealed to the conversation it was written in.
        for (const spelling of new Set(left.map(r => String(r.conversation_id)))) {
            const mineHere = left.filter(r => String(r.conversation_id) === spelling);
            const views = checkDmThread(mineHere.map(r => ({
                id: r.id, authorPubkey: pinKeyOf(r.author_pubkey) === mine ? r.author_pubkey : key, ciphertext: r.ciphertext, nonce: r.nonce, type: r.type, metadata: r.metadata,
            })), { myEdPrivHex: myPrivHex, peerEdPubHex: key }, spelling);
            for (const r of mineHere) if (views.get(r.id)?.format != null) placed.set(r.id, key);
        }
    }
    return judgeFirstSight(rows.map(r => placed.get(r.id) ?? null), listed);
}

/** Kept for a DM, still to be judged on its lines: nothing yet, an unchecked first-seen pin, or a rule-5 record the listing has spoken on since. */
function sightToJudge(entry: DmPinEntry | null): boolean {
    if (!entry) return true;
    if (isUnplacedSight(entry)) return !!entry.stale;
    return entry.by === 'first-seen' && !entry.checked;
}

/**
 * Whether a send or the screen's check judges this DM now, with the update's held lines to judge it on (§3.4 amendment
 * 4), in this DM's community file. A heldLost mark is judged only on held lines of its own, and stays refused with none. Anything else
 * {@link sightToJudge} names is judged; with the held lines unreadable, it is refused this time ('refuse').
 */
async function sightToJudgeNow(me: string, file: string, conversationId: string, entry: DmPinEntry | null): Promise<{ held: ReadonlyMap<string, HeldLine[]> } | 'refuse' | null> {
    if (isHeldLostSight(entry)) {
        const held = await linesHeldAtUpdate(me, file);
        return held?.get(dmPinId(conversationId))?.length ? { held } : null;
    }
    if (!sightToJudge(entry)) return null;
    const held = await linesHeldAtUpdate(me, file);
    return held ? { held } : 'refuse';
}

/**
 * Resolve the E2E key context for a conversation, or null if it isn't a clean
 * 2-party DM (groups/system threads stay plaintext-v1 for now). Used to encrypt
 * outgoing and decrypt incoming direct messages (NAT-1).
 *
 * The peer is the key this phone pinned for the DM (utils/dm-peer-pins.ts), whatever the participant rows say: the node
 * writes those, and a prune and relist can put anyone in them (#1863 review, T5). Rows that differ are put back to
 * [me, the pinned key]. Throws DmPinStoreError when the pins can't be read: a send then refuses, and a thread reads as
 * unverified.
 *
 * First sight (design §3.4 amendment): history decides the pin, the listing only offers. With nothing kept yet, an
 * unchecked first-seen pin (taken from the listing or the rows with no line to check) or a rule-5 record the listing has
 * spoken on since, a send or the screen's check first judges the thread's own lines (judgeThread) and keeps the verdict
 * in the store: once lines placed a pin it is never judged again, so a prune and relist can't make it first sight again
 * (R5). Rule 5 (lines it can't place) keeps no pin: null, so a send is refused as not locked.
 *
 * `use`: 'seal' (a send) and 'check' (the DM screen asking whether it may send) judge first sight; a send also settles an
 * unchecked pin it seals to (the first key this phone sealed to there, §3.6). 'open' (the thread, a photo, an edit's own
 * line) only opens lines (#1872 review, finding 6): it never judges and never writes a pin, so with nothing pinned it
 * reads under the rows' one other key, as before pins; its keyChanged says only whether another key is offered and must
 * never decide a send. Only a send puts the rows back to [me, the pinned key]: a read or a check writes no row, so the
 * sync's listing and the screen don't write the offered key's row in and out on every pass (#1872 ultrareview, U7).
 *
 * The caps (§3.4 amendment 6): a DM under an id over DM_PIN_ID_MAX has no entry and is sealed to nobody (null); one with
 * nothing kept in a file whose pins have no room for it throws DmPinsFullError for a send or a check.
 */
async function getDmKeyContext(conversationId: string, use: 'seal' | 'check' | 'open' = 'seal', community?: ChatCommunity): Promise<PinnedDmKeyContext | null> {
    const identity = await loadIdentity();
    if (!identity?.publicKey || !identity?.privateKey) return null;
    // That community's copy and pins (dbFileOf): a chat open in place is judged exactly as when the phone is set there.
    const database = await chatDbFor(community);
    const conv = await database.getFirstAsync<any>('SELECT type, created_by FROM conversations WHERE id = ?', [conversationId]);
    if (!conv || conv.type !== 'dm') return null;
    const me = identity.publicKey;
    let entry = dmSightFor(await dmPins.read(me, database), conversationId);
    // The member's one list (DESIGN-s7-blocks-verified-everywhere §3.2): the same in every community, the one in use or one
    // open in place. Unreadable: every pin holds (no move by itself), and no ✓. Each pin rule below reads it again in its
    // own turn (updatePinsWithList), so a Mark that lands in between is the list it acts on (#3316 N2).
    let verified = await dmVerified.read(me);
    if (use !== 'open' && !isPinnableId(conversationId)) return null;
    const parts = await database.getAllAsync<any>('SELECT public_key FROM conversation_participants WHERE conversation_id = ?', [conversationId]);
    let peers = parts.map(p => p.public_key).filter((pk: string) => pk && pk !== identity.publicKey);
    const judging = use === 'open' ? null : await sightToJudgeNow(me, fileOfDb(database), conversationId, entry);
    if (judging === 'refuse') return null;
    if (judging) {
        let listed: string | null;
        let heard: DmHeard | undefined;
        if (!entry) {
            peers = await peersFromThread(database, conversationId, conv.created_by, me, peers, use === 'seal');
            if (peers.length !== 1) return null; // not a clean 2-party DM — don't encrypt
            listed = pinKeyOf(peers[0]);
        } else if (isUnplacedSight(entry)) {
            listed = entry.listed;
            heard = entry.heard;
        } else {
            listed = entry.offered ? entry.offered.peer : entry.peer;
            heard = entry.heard;
        }
        let verdict = await judgeThread(conversationId, identity.privateKey, me, listed, heard, judging.held, database);
        // Every listing of the chat this phone holds must name that one key (DESIGN-dm-key-signal-model §2.1): a twin the
        // node listed in other capitals whose rows name another key is a listing that disagrees. Where the thread's lines
        // already place the key this spelling lists (rules 1-2) it stands, as before; where first sight would take it
        // against the lines (rules 3-5), there is no single key: a keyless pause on the key the lines placed (rules 3-4),
        // or the rule-5 record. So no twin can carry the chat to its key by itself, and nothing is sent until one key is listed.
        const twinSays = listed ? (await otherSpellingsHeld(database, conversationId)).some((o) => o.participants.some((pk) => {
            const k = pinKeyOf(pk);
            return !!k && k !== me.toLowerCase() && k !== listed;
        })) : false;
        if (twinSays && (verdict.rule === 3 || verdict.rule === 4)) verdict = { rule: 3, pin: verdict.pin, offer: true };
        if (twinSays && verdict.rule !== 1 && verdict.rule !== 2) listed = null;
        const judged = entry;
        const now = new Date().toISOString();
        // Through the pins' queue, and only over what was kept when the lines were read: another writer's change stands,
        // but for the update's heldLost mark (the seed's, in this same write), which a verdict on its held lines replaces.
        const onHeld = judging.held.has(dmPinId(conversationId));
        await updatePinsWithList(me, database, (pins, inTurn) => {
            const kept = dmSightFor(pins, conversationId);
            return (kept === judged || (onHeld && isHeldLostSight(kept))) && applySightVerdict(pins, conversationId, verdict, listed, heard, now, inTurn);
        });
        entry = dmSightFor(await dmPins.read(me, database), conversationId);
        verified = await dmVerified.read(me);
    }
    // The resting rule before a send or the check answers (DESIGN-dm-key-signal-model §2.5): a person not marked verified
    // never rests on an offer naming one key, and a rule-5 record never on a listing naming one key, so a send never
    // depends on which path ran last. Never on 'open', which writes nothing.
    if (use !== 'open' && dmEntryRestless(entry, verified)) {
        const now = new Date().toISOString();
        await updatePinsWithList(me, database, (pins, inTurn) => restDmEntry(pins, conversationId, now, inTurn));
        entry = dmSightFor(await dmPins.read(me, database), conversationId);
        verified = await dmVerified.read(me);
    }
    if (!entry || isUnplacedSight(entry)) {
        if (use !== 'open') {
            if (!entry && noRoomForFirstSight(await dmPins.read(me, database), conversationId)) throw new DmPinsFullError();
            return null;
        }
        // Reading only, with no key pinned: the rows' one other key, as before pins. Nothing is written from a read.
        peers = await peersFromThread(database, conversationId, conv.created_by, me, peers, false);
        if (peers.length !== 1) return null;
        return { myEdPrivHex: identity.privateKey, peerEdPubHex: peers[0], conversationId, formerPeers: [], keyChanged: false, offeredPeer: null, myPubHex: me };
    }
    const pin = entry;
    if (use === 'seal' && !pin.checked && pin.by === 'first-seen' && !pin.offered) {
        await dmPins.update(me, database, (pins) => settleFirstSight(pins, conversationId));
    }
    if (use === 'seal' && (peers.length !== 1 || peers[0] !== pin.peer)) {
        await database.runAsync('DELETE FROM conversation_participants WHERE conversation_id = ? AND public_key NOT IN (?, ?)', [conversationId, identity.publicKey, pin.peer]).catch(() => {});
        await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conversationId, pin.peer]).catch(() => {});
        await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conversationId, identity.publicKey]).catch(() => {});
    }
    return {
        myEdPrivHex: identity.privateKey, peerEdPubHex: pin.peer, conversationId, formerPeers: dmShownFormer(pin), keyChanged: !!pin.offered, offered: pin.offered,
        offeredPeer: pin.offered?.peer ?? null, myPubHex: me, verified: showsVerifiedMark(pin, verified), changedAt: pin.changedAt ?? [],
    };
}

/**
 * The participant rows this phone holds for every OTHER spelling of a conversation's id (a twin the node listed in other
 * capitals), each as a listing: `{ id, type, participants }`. Under Signal's model a pin follows the one key every listing
 * of the chat names (DESIGN-dm-key-signal-model §2.3), so a path that hears one spelling (the screen's check, a push's
 * refresh) counts the others the phone already holds, as the sync pass that lists them together does. Unreadable: none.
 */
async function otherSpellingsHeld(database: SQLite.SQLiteDatabase, conversationId: string): Promise<Array<{ id: string; type: string; participants: string[] }>> {
    const rows = await database.getAllAsync<any>(
        'SELECT c.id AS id, c.type AS type, cp.public_key AS pk FROM conversations c JOIN conversation_participants cp ON cp.conversation_id = c.id WHERE lower(c.id) = lower(?) AND c.id != ?',
        [conversationId, conversationId],
    ).catch(() => [] as any[]);
    const byId = new Map<string, { id: string; type: string; participants: string[] }>();
    for (const r of rows) {
        if (typeof r?.id !== 'string' || typeof r?.pk !== 'string' || !r.pk) continue;
        if (!byId.has(r.id)) byId.set(r.id, { id: r.id, type: typeof r.type === 'string' ? r.type : 'dm', participants: [] });
        byId.get(r.id)!.participants.push(r.pk);
    }
    return [...byId.values()];
}

/**
 * The other person of a DM with no pin yet, when its participant rows haven't been written: from the thread's history,
 * or its creator. `write` (a send only): the rows are written for the one found. `peers` as the rows give them otherwise.
 */
async function peersFromThread(database: SQLite.SQLiteDatabase, conversationId: string, createdBy: string | null, me: string, peers: string[], write: boolean): Promise<string[]> {
    // Resilient fallback: if local participants cache hasn't populated yet, find peer from thread history or creator
    if (peers.length === 0) {
        const msgPeer = await database.getFirstAsync<any>(
            'SELECT author_pubkey FROM messages WHERE conversation_id = ? AND author_pubkey != ? AND author_pubkey != "SYSTEM" LIMIT 1',
            [conversationId, me]
        );
        if (msgPeer?.author_pubkey) {
            peers = [msgPeer.author_pubkey];
            if (write) {
                await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conversationId, msgPeer.author_pubkey]).catch(() => {});
                await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conversationId, me]).catch(() => {});
            }
        } else if (createdBy && createdBy !== me) {
            peers = [createdBy];
            if (write) {
                await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conversationId, createdBy]).catch(() => {});
                await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conversationId, me]).catch(() => {});
            }
        }
    }
    return peers;
}

/**
 * Pins for the DMs this phone already holds with exactly one other key and no pin yet, from its own rows, before the
 * node's listing is heard: the key this phone has been sealing to there (design §3.6). A phone updated to a build with
 * pins meets every DM it has as a DM it already knows, not as first sight on the listing's word; and a DM the first
 * pass prunes is pinned before its rows go. `fresh` (the account's first pass on a build with pins: the rows are the ones
 * this phone held before it): checked, so no later line can move them (design §3.4 amendment, the update case). After
 * that, rows may be ones this build wrote from a listing (the node's word), so a pin from them is unchecked: the send or
 * the screen's check judges it on the thread's lines first. Rows with two or more other keys pin nothing here: the
 * listing's key, unchecked, and then the thread's lines decide. `rows`: {@link dmPeersHeld}. True when the pins changed.
 */
function seedPinsFromRows(pins: DmPeerPins, myPubkey: string, rows: ReadonlyArray<any>, fresh: boolean): boolean {
    const me = myPubkey.toLowerCase();
    const others = new Map<string, Set<string>>();
    for (const r of rows) {
        const pk = typeof r?.pk === 'string' ? r.pk.toLowerCase() : '';
        if (!pk || pk === me || typeof r?.id !== 'string') continue;
        const id = dmPinId(r.id);
        if (dmSightFor(pins, id)) continue;
        let keys = others.get(id);
        if (!keys) others.set(id, keys = new Set());
        keys.add(pk);
    }
    const now = new Date().toISOString();
    let changed = false;
    for (const [id, keys] of others) if (keys.size === 1 && pinAtFirstSight(pins, id, [...keys][0], now, undefined, fresh)) changed = true;
    return changed;
}

/** The DMs (by folded id) whose rows name other than exactly one other key: {@link seedPinsFromRows} pins none of them. */
function dmsTheRowsDontPin(rows: ReadonlyArray<any>, myPubkey: string): string[] {
    const me = myPubkey.toLowerCase();
    const others = new Map<string, Set<string>>();
    for (const r of rows) {
        if (typeof r?.id !== 'string' || !isPinnableId(r.id)) continue;
        const id = dmPinId(r.id);
        if (!others.has(id)) others.set(id, new Set());
        const pk = typeof r?.pk === 'string' ? r.pk.toLowerCase() : '';
        if (pk && pk !== me) others.get(id)!.add(pk);
    }
    return [...others].filter(([, keys]) => keys.size !== 1).map(([id]) => id);
}

/**
 * The update's judgement (§3.4 amendment 3, companion a): each DM the seed of `database`'s file kept lines of and still keeps nothing for,
 * that `conversations` lists cleanly with one other key, judged on the lines held at the update with that key as the
 * listed one. Run by a sync pass or a push's refresh before it writes a row or line from the node, and applied in the
 * same change of the pins as the listing ({@link applyHeldSights}). A DM listed otherwise (several keys, or not at all)
 * waits for the send or the screen's check, in this run or a later one, which judge it on the same held lines.
 */
async function judgeHeldAtUpdate(me: string, database: SQLite.SQLiteDatabase, myPrivHex: string, pins: DmPeerPins, conversations: ReadonlyArray<any>): Promise<HeldSight[]> {
    const held = await linesHeldAtUpdate(me, fileOfDb(database));
    if (!held?.size) return [];
    const mine = me.toLowerCase();
    const listings = new Map<string, any[]>();
    for (const c of conversations) {
        if (typeof c?.id !== 'string' || !Array.isArray(c.participants)) continue;
        const id = dmPinId(c.id);
        const entry = dmSightFor(pins, id);
        if (held.has(id) && (!entry || isHeldLostSight(entry))) listings.set(id, [...(listings.get(id) ?? []), c]);
    }
    const sights: HeldSight[] = [];
    for (const [id, listed] of listings) {
        const others = listed.map((c) => [...new Set(c.participants.map(pinKeyOf).filter((k: string | null): k is string => !!k && k !== mine))]);
        if (!others.every((o) => o.length === 1 && o[0] === others[0][0])) continue;
        const key = others[0][0] as string;
        const heard = listed.length === 1 ? heardFromListing(listed[0], listed[0].participants.filter((p: unknown) => typeof p === 'string' && !!p && p.toLowerCase() !== mine)) : undefined;
        sights.push({ id, listed: key, heard, verdict: await judgeThread(id, myPrivHex, me, key, heard, held, database) });
    }
    return sights;
}

interface HeldSight { id: string; listed: string; heard: DmHeard | undefined; verdict: SightVerdict }

/** {@link judgeHeldAtUpdate}'s verdicts, each kept for a DM that still keeps nothing. True when the pins changed. */
function applyHeldSights(pins: DmPeerPins, sights: ReadonlyArray<HeldSight>, verified: DmVerifiedKeys): boolean {
    const now = new Date().toISOString();
    let changed = false;
    for (const s of sights) {
        const entry = dmSightFor(pins, s.id);
        if ((!entry || isHeldLostSight(entry)) && applySightVerdict(pins, s.id, s.verdict, s.listed, s.heard, now, verified)) changed = true;
    }
    return changed;
}

/** Every DM's participant rows in this file, for {@link seedPinsFromRows}; throws when they can't be read. */
async function readDmPeersHeld(database: SQLite.SQLiteDatabase): Promise<any[]> {
    return await database.getAllAsync<any>(
        "SELECT cp.conversation_id AS id, cp.public_key AS pk FROM conversation_participants cp JOIN conversations c ON c.id = cp.conversation_id WHERE c.type = 'dm' ORDER BY c.rowid"
    );
}

/** As {@link readDmPeersHeld}, for a sync pass after the seed. Unreadable: none (the listing is still heard). */
async function dmPeersHeld(database: SQLite.SQLiteDatabase): Promise<any[]> {
    return await readDmPeersHeld(database).catch(() => [] as any[]);
}

/**
 * What the node's listing of one or more conversations says about this account's DM pins: an offer where it names
 * another key in place of a pinned one, the offer cleared where it names the pinned key again, and a first-sight pin for
 * a DM it lists cleanly with one other person. `pins` is changed in place; true when it changed. The pinned key never
 * moves here (utils/dm-peer-pins.ts applyDmListings). A listing of any type counts against a pin (a DM the node retypes
 * is still the DM this phone pinned); only a DM's listing pins at first sight.
 */
function applyListingsToPins(pins: DmPeerPins, myPubkey: string, conversations: ReadonlyArray<any>, verified: DmVerifiedKeys): boolean {
    const me = myPubkey.toLowerCase();
    const byId = new Map<string, { others: string[]; dm: boolean; heard?: DmHeard }[]>();
    for (const c of conversations) {
        if (!c?.id || typeof c.id !== 'string' || !Array.isArray(c.participants)) continue;
        const id = dmPinId(c.id);
        const others = c.participants.filter((p: unknown): p is string => typeof p === 'string' && !!p && p.toLowerCase() !== me);
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id)!.push({ others, dm: (c.type || 'dm') === 'dm', heard: heardFromListing(c, others) });
    }
    const now = new Date().toISOString();
    let changed = false;
    for (const [id, listings] of byId) {
        if (!dmSightFor(pins, id) && listings.some(l => !l.dm)) continue;
        if (applyDmListings(pins, id, listings.map(l => l.others), now, verified, listings.length === 1 ? listings[0].heard : undefined)) changed = true;
    }
    return changed;
}

/**
 * What one listing says about the one other key it names (#1871 formerKeys, newest first): the former keys, for the
 * history rule to try lines under (never proof), and the date of the newest statement when it verifies against that key
 * (the banner's wording only, pick 4). Nothing for a listing naming several others.
 */
function heardFromListing(c: any, others: string[]): DmHeard | undefined {
    if (others.length !== 1 || !c?.formerKeys || typeof c.formerKeys !== 'object') return undefined;
    const listed = others[0];
    const own = Object.prototype.hasOwnProperty.call(c.formerKeys, listed) ? c.formerKeys[listed] : null;
    const chain: FormerKey[] = Array.isArray(own) ? own.slice(0, 8) : [];
    const tryKeys = [...new Set(chain.map(f => pinKeyOf(f?.pubkey)).filter((k): k is string => !!k && k !== pinKeyOf(listed)))];
    const heard: DmHeard = {};
    if (tryKeys.length) heard.tryKeys = tryKeys;
    let rekeyedAt: string | undefined;
    // As the pin keeps it: the instant it parses to, never the node's string (§3.4 amendment 6 §1).
    try { rekeyedAt = chain[0] && verifyKeySuccession(chain[0], listed) ? rekeyDateOf(chain[0].at) : undefined; } catch { rekeyedAt = undefined; }
    if (rekeyedAt) heard.rekeyedAt = rekeyedAt;
    return heard.tryKeys || heard.rekeyedAt ? heard : undefined;
}

/**
 * The conversation and its people as the node has them now, written to this phone: the other person may have arrived
 * since the chat was opened (a push, a link, a sync that hasn't run yet). Quiet on any failure; the caller decides.
 */
async function refreshConversationFromNode(conversationId: string, community?: ChatCommunity): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const decidedBefore = _requestDecisions;
    try {
        // Written into the file of the community asked, and nowhere once the phone has switched (chatCopyForRequest).
        const here = await chatCopyForRequest(community);
        // A chat open in place is a DM (slice S2): its row is that community's own, never typed from here.
        if (here.inPlace) return;
        const res = await signedGet(`/api/messages/${encodeURIComponent(conversationId)}?limit=1`, { signal: controller.signal, anchorUrl: here.anchorUrl });
        if (!res.ok) return;
        const conv = (await res.json())?.conversation;
        if (!conv?.id || typeof conv.type !== 'string') return;
        const database = await here.handle();
        if (!database) return;
        await writeConversationFromNode(database, conv, decidedBefore);
    } catch {
        // Offline or refused: the lock simply fails, and says so.
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * The node's answer for one conversation (GET /api/messages/:id's `conversation`) written to this phone: its row, with its
 * message request when the answer names one, so a request opened from a push or a link is one before its lines arrive
 * (PR #2540 review 4393642152), and its people, so its lines open and its chat is named (review 4393642140).
 */
async function writeConversationFromNode(database: SQLite.SQLiteDatabase, conv: any, asOf: number): Promise<void> {
    // The pins before the node's rows, through the handle they are written with: the account's first read with this file
    // open seeds it from the rows and lines held before these (dmPins), so the node's answer is only ever a listing,
    // judged on the lines held then.
    const identity = await loadIdentity().catch(() => null);
    const me = identity?.publicKey;
    const before = me ? await dmPins.read(me, database).catch(() => null) : null;
    // The gate (§3.4 amendment 5): with the pins unread, nothing of the node's is written into a DM here. Any other
    // chat's row is still written (#1872 ultrareview, U6): a group opened from a push routes as the group it is.
    if (me && !before && await isDmHere(database, conv.id, conv.type)) return;
    // The node answers for this one spelling; the phone's rows for any other spelling of the id count as listings too, so a
    // twin that disagrees leaves no single key (DESIGN-dm-key-signal-model §2.1), as in the sync pass that lists both.
    const heardWith = me && before ? [conv, ...await otherSpellingsHeld(database, conv.id)] : [conv];
    const sights = me && before && identity?.privateKey ? await judgeHeldAtUpdate(me, database, identity.privateKey, before, heardWith).catch(() => []) : [];
    // Its request as a read asked for when `asOf` decisions had been taken here leaves it (requestAfterReadHere), worked out
    // just before each write: a decision landing between them is never written over (PR #2540 review 4395706539).
    const read = 'request' in conv;
    const type = await heldConversationType(conv.id, conv.type, undefined, false, database);
    await database.runAsync(
        'INSERT OR IGNORE INTO conversations (id, type, post_id, name, created_by, created_at, request) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [conv.id, type, conv.postId ?? null, conv.name ?? null, conv.createdBy ?? null, conv.createdAt ?? new Date().toISOString(), read ? requestAfterReadHere(conv.id, null, conv.request, asOf) ?? null : null]
    );
    if (read) {
        const held = await database.getFirstAsync<{ request: string | null }>('SELECT request FROM conversations WHERE id = ?', [conv.id]);
        const request = requestAfterReadHere(conv.id, held?.request, conv.request, asOf);
        if (request !== undefined) await database.runAsync('UPDATE conversations SET request = ? WHERE id = ? AND request IS NOT ?', [request, conv.id, request]);
    }
    // A pinned DM's rows are [me, the pinned key], as the sync writes them; the listing is heard by the pin below.
    const pinned = me && before ? dmPinFor(before, conv.id) : null;
    for (const pk of pinned ? [me, pinned.peer] : Array.isArray(conv.participants) ? conv.participants : []) {
        if (typeof pk === 'string' && pk) {
            await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conv.id, pk]);
        }
    }
    // The DM's pin hears what the node says (an offer, never a move); an unreadable pin store refuses the send anyway.
    if (me && before) {
        await updatePinsWithList(me, database, (pins, verified) => [applyHeldSights(pins, sights, verified), applyListingsToPins(pins, me, heardWith, verified)].some(Boolean)).catch(() => {});
    }
}

/**
 * The pin store unreadable, or its community's value full, is the send's answer (fail closed); any other failure resolving
 * the key is "not locked".
 */
function keepPinStoreError(e: unknown): null {
    if (isDmPinStoreError(e) || isDmPinsFullError(e)) throw e;
    return null;
}

/**
 * This DM's key context, asking the node for the conversation once if the phone can't resolve the other person.
 * DmKeyChangedError while the node lists another key in place of the pinned one (nothing is sealed to a key the member
 * hasn't accepted), DmPinStoreError when the pins can't be read, DmPinsFullError when the DM has nothing kept and its
 * community's pins have no room: all before anything is written or sent.
 */
async function requireDmKeyContext(conversationId: string, community?: ChatCommunity): Promise<DMKeyContext> {
    let ctx = await getDmKeyContext(conversationId, 'seal', community).catch(keepPinStoreError);
    if (!ctx) {
        await refreshConversationFromNode(conversationId, community);
        ctx = await getDmKeyContext(conversationId, 'seal', community).catch(keepPinStoreError);
    }
    if (!ctx) throw new DmNotLockedError();
    if (ctx.keyChanged) throw new DmKeyChangedError();
    return ctx;
}

/**
 * True while this DM's sends are paused for a key change (utils/dm-peer-pins.ts): the DM screen disables its box and says
 * so in one line. False for any other conversation, and when the pins can't be read (a send then says that itself).
 */
export async function isDmKeyChangePending(conversationId: string): Promise<boolean> {
    try {
        return !!(await getDmKeyContext(conversationId, 'check'))?.keyChanged;
    } catch {
        return false;
    }
}

/**
 * True when first sight found lines in this DM it couldn't place and no single key is listed (§3.4 amendment, rule 5): no
 * key is pinned and every send is refused as not locked, the state in which the DM screen shows rule 5's line in the
 * composer (it reads that from getDmKeyChange's `unplaced`). Read as the resting rule would leave it, as the Inbox tag is
 * (dmEntryWaitsForMember): a record whose listing names one key waits for nobody, since the screen's check makes it a pin
 * on that key (restDmEntry, DESIGN-dm-key-signal-model §2.3 row 5). Reads only. False when the pins can't be read (a send
 * then says that itself).
 */
export async function isDmUnplaced(conversationId: string): Promise<boolean> {
    try {
        const me = (await loadIdentity())?.publicKey;
        if (!me) return false;
        const entry = dmSightFor(await dmPins.read(me, await getDb()), conversationId);
        return isUnplacedSight(entry) && dmEntryWaitsForMember(entry, await dmVerified.read(me));
    } catch {
        return false;
    }
}

/** What the DM screen's banner says about a key change (DESIGN-dm-peer-key-pin §3.5). */
export interface DmKeyChange {
    /**
     * The key the member would continue with: the one offered in place of the pinned one. Null when the node lists
     * several other keys: there is no one key to continue with, and the banner offers none.
     */
    offeredPeer: string | null;
    /**
     * True when first sight on this thread's own lines made the pause, or for a rule-5 record: only ever with no single key
     * listed (`offeredPeer` null), since first sight takes a single listed key itself (DESIGN-dm-key-signal-model §2.4).
     */
    firstSight: boolean;
    /** The member marked this person verified (DESIGN-dm-key-signal-model §4): the card opens with "You marked … as verified". */
    verified?: boolean;
    /** When the node says the account was re-keyed (slice 3). Only ever wording for the banner, never a reason to accept (pick 4). */
    rekeyedAt?: string;
    /**
     * The person's name: the pinned key's member row, else the offered key's (the community's current name for the
     * account after an honest re-key moves the row), else null (the banner's unknown-name sentences). Never the
     * conversation id (#1873 review, finding 2). For a rule-5 record: the listed key's row, else the rows' other key's.
     */
    name?: string | null;
    /**
     * First sight found lines it couldn't place (rule 5 of the §3.4 amendment; heldLost too) and no single key is listed:
     * no key is pinned, `offeredPeer` is null, and the box says so (DM_UNPLACED_LINE). A record whose listing names one key
     * is never a change: it becomes a pin on that key (restDmEntry, §2.3 row 5).
     */
    unplaced?: true;
}

/** A member's callsign by key, as this phone holds the directory; null when it holds none. */
async function callsignOfKey(pubkey: string | null | undefined, community?: ChatCommunity): Promise<string | null> {
    if (!pubkey) return null;
    const database = await chatDbFor(community);
    const row = await database.getFirstAsync<any>('SELECT callsign FROM members WHERE public_key IN (?, ?) LIMIT 1', [pubkey, pubkey.toLowerCase()]).catch(() => null);
    const name = typeof row?.callsign === 'string' ? row.callsign.trim() : '';
    return name || null;
}

/**
 * The key change waiting in this DM, or null when there is none. The DM screen's check whether it may send ('check':
 * first sight is judged on the thread's lines first). Throws DmPinStoreError when the pins can't be read (the screen
 * then keeps the box as it was, and a send says why).
 */
export async function getDmKeyChange(conversationId: string, community?: ChatCommunity): Promise<DmKeyChange | null> {
    const ctx = await getDmKeyContext(conversationId, 'check', community);
    if (!ctx) return unplacedKeyChange(conversationId, community);
    if (!ctx.keyChanged || !ctx.offered) return null;
    const name = (await callsignOfKey(ctx.peerEdPubHex, community)) ?? (await callsignOfKey(ctx.offered.peer, community));
    const change: DmKeyChange = { offeredPeer: ctx.offered.peer, firstSight: !!ctx.offered.firstSight, name };
    if (ctx.verified) change.verified = true;
    if (ctx.offered.nodeSays?.rekeyedAt) change.rekeyedAt = ctx.offered.nodeSays.rekeyedAt;
    return change;
}

/** What the key code screen shows for a DM (DESIGN-dm-key-signal-model §3): read from the pins only, nothing judged or written. */
export interface DmKeyCodeInfo {
    /** The key this chat is sealed to (its pin), or null when there is none yet. */
    peer: string | null;
    /** The person's name as this phone holds the directory, or null (the screen's unknown-name sentences). */
    name: string | null;
    /** The key it is sealed to is on the member's list of verified keys, as read: never true while the list can't be read. */
    verified: boolean;
    /** Sends wait for the member: a verified person's key changed, or no single key is listed. */
    paused: boolean;
    /** While paused, one new key is on offer (a verified person's change): removing the mark carries on with it. */
    offersKey: boolean;
    /** The member's list of verified keys can't be read: the screen says so in place of Mark, Remove and ✓. */
    listUnread?: true;
}

/**
 * The key code screen's read (§3): the pinned key's code, whether it is marked verified, and whether the chat waits.
 * Reads only, through the pins' book and the member's list. Null for anything that isn't a DM; throws DmPinStoreError
 * when the pins can't be read.
 */
export async function getDmKeyCodeInfo(conversationId: string, community?: ChatCommunity): Promise<DmKeyCodeInfo | null> {
    const me = (await loadIdentity())?.publicKey;
    if (!me) return null;
    const database = await chatDbFor(community);
    const conv = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]);
    if (!conv || conv.type !== 'dm') return null;
    const entry = dmSightFor(await dmPins.read(me, database), conversationId);
    const verified = await dmVerified.read(me);
    const pin = entry && !isUnplacedSight(entry) ? entry : null;
    const paused = dmEntryWaitsForMember(entry, verified);
    const info: DmKeyCodeInfo = { peer: pin?.peer ?? null, name: await callsignOfKey(pin?.peer, community), verified: showsVerifiedMark(pin, verified), paused, offersKey: paused && !!pin?.offered?.peer };
    if (!verified.readable) info.listUnread = true;
    return info;
}

/**
 * The member's "Mark as verified" (DESIGN-s7-blocks-verified-everywhere §3.2): puts `expectedPeer`, the key whose code the
 * screen showed, on the member's one list, so every chat sealed to it, in any community on the phone, is verified. Only
 * while this chat's pin still holds that key with no other offered, read in the pins' turn through this call's own
 * handle; false, nothing written, when it moved since the screen read it (the screen then shows the new code).
 *
 * All in that one turn (#3316 N2, as when the mark lived on the pin): the pin is checked, the key goes on the list, and
 * the pin is settled (`checked`, as markVerified did: #3316 N1), so no line judged later puts another key into its
 * `former` beside Verified ✓. A sync queued behind the tap reads the list it wrote (updatePinsWithList) and pauses on a
 * new listing; one queued before it moves the pin first, and the Mark then says false. Throws DmPinStoreError when the
 * pins can't be read or written, DmVerifiedStoreError when the list can't be read or written, DmVerifiedFullError at its cap.
 */
export async function markDmPeerVerified(conversationId: string, expectedPeer: string, community?: ChatCommunity): Promise<boolean> {
    const me = (await loadIdentity())?.publicKey;
    if (!me) return false;
    const database = await pinsCopyFor(community, conversationId);
    if (!database) return false;
    if (!(await dmVerified.read(me)).readable) throw new DmVerifiedStoreError();
    let marked = false;
    await dmPins.update(me, database, async (pins) => {
        const key = markableKey(pins, conversationId, expectedPeer);
        if (!key) return false;
        await dmVerified.add(me, key);
        marked = true;
        return settleMarkedPin(pins, conversationId, key);
    });
    return marked;
}

/**
 * The member's "Remove verification" (§3.3 Unverify): the key this chat is sealed to comes off the member's list, so no
 * chat sealed to it, in any community, is verified from now. In this chat a pause for one offered key then ends with the
 * pin moved to it (the resting rule, with its notice); every other chat rests at its own next check. Throws
 * DmPinStoreError when the pins can't be read or written, DmVerifiedStoreError when the list can't be read or written.
 */
export async function removeDmPeerVerification(conversationId: string, community?: ChatCommunity): Promise<boolean> {
    const me = (await loadIdentity())?.publicKey;
    if (!me) return false;
    const database = await pinsCopyFor(community, conversationId);
    if (!database) return false;
    const before = await dmVerified.read(me);
    if (!before.readable) throw new DmVerifiedStoreError();
    const pin = dmPinFor(await dmPins.read(me, database), conversationId);
    if (!pin || !isVerifiedPin(pin, before)) return false;
    if ((await dmVerified.remove(me, pin.peer)) !== 'removed') return false;
    const after = await dmVerified.read(me);
    const now = new Date().toISOString();
    await dmPins.update(me, database, (pins) => restDmEntry(pins, conversationId, now, after));
    return true;
}

/**
 * A rule-5 record's banner (15 Oct words design, D2), read after the 'check' judgement left no key pinned: no single key
 * to continue with, named by the rows' other key's member row. Read as the resting rule would leave it, as the Inbox tag
 * is (dmEntryWaitsForMember): a record whose listing names one key is no pause, since it becomes a pin on that key
 * (DESIGN-dm-key-signal-model §2.3 row 5). Reads only: nothing is written from here. Null for anything that isn't a DM
 * with a rule-5 record waiting for the member.
 */
async function unplacedKeyChange(conversationId: string, community?: ChatCommunity): Promise<DmKeyChange | null> {
    const me = (await loadIdentity())?.publicKey;
    if (!me) return null;
    const database = await chatDbFor(community);
    const conv = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]);
    if (!conv || conv.type !== 'dm') return null;
    const entry = dmSightFor(await dmPins.read(me, database), conversationId);
    if (!isUnplacedSight(entry) || !dmEntryWaitsForMember(entry, await dmVerified.read(me))) return null;
    const parts = await database.getAllAsync<any>('SELECT public_key FROM conversation_participants WHERE conversation_id = ?', [conversationId]).catch(() => []);
    const others = parts.map((p: any) => p.public_key).filter((pk: string) => pk && pk !== me);
    const name = others.length === 1 ? await callsignOfKey(others[0], community) : null;
    const change: DmKeyChange = { offeredPeer: null, firstSight: true, unplaced: true, name };
    if (entry.heard?.rekeyedAt) change.rekeyedAt = entry.heard.rekeyedAt;
    return change;
}

/**
 * The member's "Continue with the new key" on the banner (pick 1), after checking the key code with the person:
 * `expectedPeer` (the key whose code the banner showed) becomes the key this DM is sealed to, `by: 'member'`, and the one
 * before it is kept in `former` so the old lines still read (pick 3). The participant rows become [me, that key].
 *
 * Refuses (false, nothing written) unless `expectedPeer` is still the key on offer when the tap's turn comes in the pins'
 * queue: a sync that offers a third key, or clears the offer, between the banner and the tap moves nothing. A rule-5
 * record offers no key, so nothing continues from one. What the node says about a re-key never moves a pin here (pick 4);
 * only this call does. Throws DmPinStoreError when the pins can't be read or written.
 *
 * The card's tick says the new key's code matches, as Mark as verified does, so a verified person stays verified: the new
 * key goes on the member's list beside the old one (other communities may still list that), before the pin moves
 * (DESIGN-s7-blocks-verified-everywhere §3.2), in the same pins turn (#3316 N2). While the list can't be read nothing
 * moves (DmVerifiedStoreError); at its cap neither (DmVerifiedFullError).
 *
 * Through the pins' one queue (#1873 review, finding 4): the sync, first sight and the refresh write there too, so no
 * writer's older copy can be written over the member's choice, and the in-memory copy every send reads is the one changed.
 */
export async function acceptOfferedPeer(conversationId: string, expectedPeer: string, community?: ChatCommunity): Promise<boolean> {
    const identity = await loadIdentity();
    const expected = pinKeyOf(expectedPeer);
    if (!identity?.publicKey || !expected) return false;
    const me = identity.publicKey;
    // One handle for the pin and the rows (§3.4 amendment 5): the community this tap is in, never the one open afterwards.
    const database = await pinsCopyFor(community, conversationId);
    if (!database) return false;
    const verified = await dmVerified.read(me);
    if (!verified.readable) throw new DmVerifiedStoreError();
    const change = await getDmKeyChange(conversationId, community);
    if (!change || change.offeredPeer !== expected) return false;
    const now = new Date().toISOString();
    let moved = false;
    await dmPins.update(me, database, async (pins) => {
        const pin = dmPinFor(pins, conversationId);
        if (pin?.offered?.peer !== expected) return false;
        const inTurn = await dmVerified.read(me);
        if (!inTurn.readable) throw new DmVerifiedStoreError();
        if (isVerifiedPin(pin, inTurn)) await dmVerified.add(me, expected);
        return (moved = acceptOffer(pins, conversationId, expected, now));
    });
    if (!moved) return false;
    // The rows follow the pin (the next resolve puts them right if this fails; the pin has moved either way).
    await database.runAsync('DELETE FROM conversation_participants WHERE conversation_id = ? AND public_key NOT IN (?, ?)', [conversationId, me, expected]).catch(() => {});
    await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conversationId, expected]).catch(() => {});
    await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conversationId, me]).catch(() => {});
    return true;
}

/**
 * Open one part of a DM line under the pinned key, then under each key pinned before it (pick 3), as the thread check
 * does (core checkDmThread): a former key is tried only for a line the row names as mine, the pinned key's or that key's
 * own. Returns the keys and sender it opened under, so a photo opens under the same ones as its words. Throws the pinned
 * key's error when none opens.
 */
function openDmPartWithFormer(
    payload: { ciphertext: string; nonce: string },
    ctx: PinnedDmKeyContext,
    ref: { conversationId: string; senderPubHex: string; messageId: string; metadata: unknown; part: DmPart },
): { opened: ReturnType<typeof openDmLine>; keys: DMKeyContext; senderPubHex: string } {
    let first: unknown;
    try {
        return { opened: openDmLine(payload, ctx, ref), keys: ctx, senderPubHex: ref.senderPubHex };
    } catch (e) { first = e; }
    const mine = ctx.myPubHex && ref.senderPubHex === ctx.myPubHex;
    for (const peer of ctx.formerPeers) {
        if (!peer || peer === ctx.peerEdPubHex) continue;
        if (!mine && ref.senderPubHex !== ctx.peerEdPubHex && ref.senderPubHex !== peer) continue;
        const keys: DMKeyContext = { myEdPrivHex: ctx.myEdPrivHex, peerEdPubHex: peer, conversationId: ctx.conversationId };
        const senderPubHex = mine ? ref.senderPubHex : peer;
        try {
            return { opened: openDmLine(payload, keys, { ...ref, senderPubHex }), keys, senderPubHex };
        } catch { /* the next former key */ }
    }
    throw first;
}

/**
 * What a DM line is sealed and signed to besides its conversation (e2e-crypto, format 4): who sends it, under which message id the
 * node will store it, which part of the message it is, and the line it is written after.
 */
interface DmLineToSeal {
    senderPubHex: string;
    messageId: string;
    part?: DmPart;
    after?: string | null;
    /** The message a reply answers (its metadata's replyToId), which the node can read but not change unnoticed. */
    replyToId?: string | null;
}

/**
 * Seal a DM line and sign it as me, in one (core sealDmLine, format 4): every part, the photo too, so the other person can't
 * put one in my name. The signature is in the line's own ciphertext, which both apps check when they open it and a report
 * of it stands on (core dm-line-report.ts); nothing rides beside it.
 */
function lockWith(ctx: DMKeyContext, text: string, line: DmLineToSeal): { ciphertext: string; nonce: string } {
    try {
        return sealDmLine(text, ctx, line);
    } catch {
        throw new DmNotLockedError();
    }
}

/**
 * A line of mine this phone hasn't had confirmed by the node: `__sendState` 'sending' or 'failed', which only this phone
 * writes (the sync drops it from the node's metadata: chat-sync withoutSendState), on a row by my own key. Never another
 * person's row, whatever its metadata says.
 */
function isUndeliveredRow(metadata: string | null | undefined, author: string | null | undefined, myPubkey: string | null | undefined): boolean {
    if (!metadata || !myPubkey || author !== myPubkey) return false;
    try {
        const s = JSON.parse(metadata)?.__sendState;
        return s === 'sending' || s === 'failed';
    } catch {
        return false;
    }
}

/**
 * The line a new one is written after (sealed into it, so the other phone can tell when the node shows it out of order):
 * the newest encrypted line on this phone that the node has confirmed. Never one still sending or failed: a line resent
 * later lands after this one, and naming it would mark this one as reordered.
 */
async function lineToWriteAfter(conversationId: string, exceptId?: string, community?: ChatCommunity): Promise<string | null> {
    const database = await chatDbFor(community);
    const rows = await database.getAllAsync<any>(
        'SELECT id, nonce, metadata, author_pubkey FROM messages WHERE conversation_id = ? AND nonce LIKE ? ORDER BY timestamp DESC LIMIT 20',
        [conversationId, `${V2_NONCE_PREFIX}%`]
    ).catch(() => [] as any[]);
    const me = (await loadIdentity().catch(() => null))?.publicKey ?? null;
    const newestFirst = (rows || []).filter((r: any) => r?.id && r.id !== exceptId);
    return dmAfterReference(newestFirst.reverse().map((r: any) => ({ id: r.id, nonce: r.nonce, pending: isUndeliveredRow(r.metadata, r.author_pubkey, me) })));
}

/**
 * What one of my lines was sealed to besides its id, for its edit to keep: the line it was written after (an edit stays
 * where its line is) and the message it answers (its metadata's replyToId, which the line is bound to).
 */
async function sealOfLine(conversationId: string, messageId: string, community?: ChatCommunity): Promise<{ after: string | null; replyToId: string | null }> {
    const database = await chatDbFor(community);
    const row = await database.getFirstAsync<any>(
        'SELECT ciphertext, nonce, author_pubkey, metadata FROM messages WHERE id = ?', [messageId]
    ).catch(() => null);
    const replyToId = replyToIdOf(row?.metadata);
    if (!row || !isEncryptedNonce(row.nonce)) return { after: null, replyToId };
    const ctx = await getDmKeyContext(conversationId, 'open', community).catch(() => null);
    if (!ctx) return { after: null, replyToId };
    try {
        const after = openDmLine({ ciphertext: row.ciphertext, nonce: row.nonce }, ctx,
            { conversationId, senderPubHex: row.author_pubkey, messageId, part: 'body', metadata: row.metadata }).after;
        return { after, replyToId };
    } catch {
        return { after: null, replyToId };
    }
}

/** The message a line answers, from metadata as a send carries it (a JSON string): sealed into the line. */
function replyToIdOf(metadata: string | null | undefined): string | null {
    return dmReplyToOf(metadata ?? null) ?? null;
}

async function isNodeReadableConversation(conversationId: string): Promise<boolean> {
    const database = await getDb();
    let row = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]);
    if (!row) {
        // Not on this phone yet (a group chat opened from a push): ask the node what it is before deciding, or a
        // group chat's first line would be taken for a DM and refused as unlockable.
        await refreshConversationFromNode(conversationId);
        row = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]);
    }
    // A known DM is locked whatever type its row says (the DM guard): the node can't make this phone send it readable.
    if (isNodeReadableChatType(row?.type) && await isKnownDmConversation(conversationId)) return false;
    return isNodeReadableChatType(row?.type);
}

/**
 * A line as it goes to the node (utils/dm-lock.ts). A node-readable chat (group, event, enterprise) takes
 * plaintext-v1, as designed. Every other conversation is a DM, locked or not sent: DmNotLockedError when the other
 * person's key can't be resolved even after asking the node, or the encryption throws. Never a readable fallback.
 */
async function lockForConversation(conversationId: string, text: string, line: DmLineToSeal, here: ChatRequestCopy, community?: ChatCommunity): Promise<{ ciphertext: string; nonce: string; metadata?: Record<string, unknown>; last?: LastAsk }> {
    // A chat open in place (slice S2) is a direct one: sealed to the pin kept in that community's own file, under the same
    // key-pin gate (requireDmKeyContext: a key change pauses, unreadable pins refuse), or not sent. Never readable, never a
    // group's: its group key memory and DM guard are that community's, not the copy in use's, so nothing here asks them.
    if (here.inPlace) return lockWith(await requireDmKeyContext(conversationId, community), text, line);
    // A DM's key context decides before any group sealing (§3.4 amendment 7 §3 iv): a conversation whose group keys this
    // phone never held and that it knows as a DM (its pins first, which refuse when they can't be read) is sealed to its pin
    // or refused, whatever its row or the node now call it. With the group path asked first, a pinned DM the node relisted
    // as an unlocked group went out readable. Every guard here is asked of the community the line goes to (`here`: its file,
    // its key memory, its server), never of one the phone was set to since (second review of #3358, R1).
    const asked = await groupContextAt(here).catch(() => null);
    if (!(asked && await ringOf(asked, conversationId).holdsKeys()) && await isKnownDmConversation(conversationId, { pinsMustRead: true, at: here.database })) {
        return lockWith(await requireDmKeyContext(conversationId, community), text, line);
    }
    // A group's chat is locked since group chats step 2 (slice 3 here): sealed under the group's key, with its epoch in the
    // metadata the node checks. Only a node from before locked chats, which this phone never saw locked, still reads it.
    const groupLine = await sealForGroupConversation(conversationId, text, line, here);
    if (groupLine && groupLine !== 'readable') return groupLine;
    if (groupLine === 'readable' || await isNodeReadableConversation(conversationId)) {
        // An event's or an enterprise's thread by its type (their own screens post to their own routes; this is the DM
        // screen's path): readable only to a node whose own chat answer for this id says it isn't locked, never on a type
        // alone (confirmation 2 of #1788, finding 3).
        if (!asked || !(groupLine === 'readable' || await nodeChatIsUnlocked(asked, conversationId, community))) throw new DmNotLockedError();
        const { leaving, lastLook } = await readableLineTo(asked, conversationId);
        return { nonce: 'plaintext-v1', ciphertext: encodeBase64(encodeUtf8(text)), last: { leaving, lastLook } };
    }
    return lockWith(await requireDmKeyContext(conversationId, community), text, line);
}

/**
 * True once this phone has held a key of the group with this id (its own key memory: an epoch verified, opened or made,
 * kept per identity), whatever the node or the local row now calls the conversation. Such a group is locked here for good:
 * every path that can post into it seals or refuses (director's decision b). With no node or no identity nothing can be
 * sent at all, so that answers false. When the phone can't read its key memory (a SQLite error, a community switched
 * under it) this throws GROUP_KEY_STORE_UNREAD_TEXT: every send and edit that asks refuses, never "not held" (confirmation
 * 2 of #1788, finding 1). A link or a push can carry a group's id in capitals (push routes match ids case-insensitively):
 * groupKeyring() lower-cases it, so every spelling asks the group's one keyring.
 */
export async function isHeldGroupChat(conversationId: string, community?: ChatCommunity): Promise<boolean> {
    let ring: GroupKeyring;
    // In place (slice S6): a copy that can't be opened, or that doesn't hold the group, refuses; never "not held".
    try { ring = await groupKeyringFor(conversationId, community); } catch (e) { if (community) throw e; return false; }
    return ring.holdsKeys();
}

/**
 * True once this phone has held a key of the group with this id, or has seen its chat locked (GroupKeyring.seenLocked), in
 * the community in use. The chat's route asks it of an id that is no known DM (chat-route.ts): such a chat opens only in the
 * group's own screen, whatever its server now calls it (second review of #3358, R2). Throws as {@link isHeldGroupChat} does.
 */
export async function isLockedGroupChat(conversationId: string): Promise<boolean> {
    let ring: GroupKeyring;
    try { ring = await groupKeyringFor(conversationId); } catch { return false; }
    return ring.seenLocked();
}

/**
 * Whether a line of the DM screen's goes as a group's (sealed, or refused) whatever its row is called: that community's file
 * holds keys of it, or has seen it locked and no DM is known there by the id (the mark lifts no DM guard).
 */
async function goesAsGroup(conversationId: string, here: ChatRequestCopy): Promise<boolean> {
    const asked = await groupContextAt(here).catch(() => null);
    if (!asked) return false;
    const ring = ringOf(asked, conversationId);
    if (await ring.holdsKeys()) return true;
    return (await ring.seenLocked()) && !(await isKnownDmConversation(conversationId, { pinsMustRead: true, at: here.database }));
}

/**
 * A readable line's way out ({@link readableLineTo}), and a deal's step's ({@link dealStep}): its one address, and what is asked
 * last of all, with no await, as its request leaves. `signer`: the one account it may be signed by. `lastLook`: a readable
 * line's file asked once more, the last await before `leaving` (once the line is signed), so a lock that reached the file
 * meanwhile stops it ({@link readableLineTo}).
 */
interface ReadableTo extends LastAsk { address: string; signer?: string }
/** What is asked of a readable line as its request leaves: `lastLook` awaited, then `leaving`, then the request, with no await between those two. */
interface LastAsk { leaving(): void; lastLook?(): Promise<void> }

/**
 * The last thing asked before a readable chat line goes, and the address it goes to. It fails closed (third review of #3358,
 * S1): the line goes only to the community it was begun in, while the phone still has that community's file, and only on a
 * positive "never locked" of this phone's own: no DM known there ({@link refuseReadableIntoDm}), nothing in that file against
 * it ({@link refuseByItsFile}), and its key memory's own answer (GroupKeyring.neverLocked), which still holds as the request
 * leaves (`leaving`). Whatever its server now calls the chat. Else it throws and nothing goes. Every readable line asks it: an
 * old node's group post and edit, the DM screen's line and edit, an event's and an enterprise's chat (the table:
 * utils/__tests__/group-in-place-table.test.ts; second review, R1 and R2). The file is asked again as the request leaves
 * (`lastLook`, after the signing): a sync that stored the group's first sealed line meanwhile, its mark with it, stops the
 * line, as this run's memory does once that sync has told it (max review of #3358, U2).
 */
async function readableLineTo(asked: GroupContext, conversationId: string): Promise<ReadableTo> {
    const database = await asked.handle();
    if (!database) throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
    await refuseReadableIntoDm(conversationId, database);
    /** What the community's file says against the line now: thrown; else the key memory's "never locked". */
    const fileSays = async (): Promise<NeverLocked | null> => {
        const at = await asked.handle();
        if (!at) throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
        await refuseByItsFile(conversationId, at);
        return ringOf(asked, conversationId).neverLocked();
    };
    const never = await fileSays();
    const leaving = () => {
        const still = never?.still() ?? 'locked';
        if (still === 'locked') throw new GroupChatKeyError(GROUP_CHAT_LOCK_LOST_TEXT, 'refused');
        if (still !== 'never') throw new GroupChatKeyError(GROUP_KEY_STORE_UNREAD_TEXT, 'store');
    };
    leaving();
    // What this run knows first (its words are the true ones); then the file, whose read that fails says so, never SQLite's words.
    const lastLook = async () => {
        leaving();
        let again: NeverLocked | null;
        try {
            again = await fileSays();
        } catch (e: any) {
            if (e instanceof GroupChatKeyError || e instanceof DmNotLockedError || e?.message === SWITCHED_SINCE_CHAT_OPENED_TEXT) throw e;
            throw Object.assign(new GroupChatKeyError(GROUP_KEY_STORE_UNREAD_TEXT, 'store'), { why: e });
        }
        if (!again) throw new GroupChatKeyError(GROUP_CHAT_LOCK_LOST_TEXT, 'refused');
    };
    return { address: asked.nodeUrl, leaving, lastLook };
}

/**
 * What a community's file itself says against a readable line, in any spelling of the id the phone sends: a kind this build
 * doesn't know (never taken for one the node reads), or a group's sealed line kept of it (it was locked). No row of the chat
 * says nothing: an event's and an enterprise's are kept nowhere here. A read that fails throws, and nothing goes.
 */
async function refuseByItsFile(conversationId: string, database: SQLite.SQLiteDatabase): Promise<void> {
    const ids = [...new Set([conversationId, conversationId.toLowerCase(), conversationId.toUpperCase()])];
    const marks = ids.map(() => '?').join(', ');
    const rows = await database.getAllAsync<any>(`SELECT type FROM conversations WHERE id IN (${marks})`, ids);
    if (rows?.some((r) => !isNodeReadableChatType(r.type))) throw new DmNotLockedError();
    // LIKE ignores an ASCII letter's case, and so does the check of what it found: any one line refuses, and a line its node
    // wrote in other capitals never hides the rest (max review, T1).
    const sealed = await database.getFirstAsync<any>(`SELECT nonce FROM messages WHERE conversation_id IN (${marks}) AND nonce LIKE ? LIMIT 1`, [...ids, `${GROUP_NONCE_PREFIX}%`]);
    if (isGroupSealedNonce(sealed?.nonce)) throw new GroupChatKeyError(GROUP_CHAT_LOCK_LOST_TEXT, 'refused');
}

/** A nonce that reads as a group's sealed line's, in any capitals: evidence of a lock, for the line's chat (nothing opens by it). */
function isGroupSealedNonce(nonce: unknown): boolean {
    return typeof nonce === 'string' && nonce.slice(0, GROUP_NONCE_PREFIX.length).toLowerCase() === GROUP_NONCE_PREFIX;
}

/**
 * Where a line of an event's or an enterprise's chat goes (readable by design): the community in use as it is begun, or
 * (slice S6) the event's own, in place ({@link readableLineTo}).
 */
async function readableChatAddress(conversationId: string, community?: ChatCommunity): Promise<ReadableTo> {
    return readableLineTo(await groupContextAt(await onlyThreadInPlace(await chatCopyForRequest(community), conversationId, ['event'])), conversationId);
}

/**
 * A node answered this group's chat locked: kept in its own community's file before the answer is handed on, so nothing
 * readable is sent to it from this phone again, after a restart too (GroupKeyring.noteLocked; review of #3358, F1). `asked`
 * is the community the answer was asked of, taken before the ask: never the one in use as it lands (second review, R1). It
 * opens nothing and lifts no DM guard (that asks for keys held). In place, a file that won't take it (the chat was left with
 * the answer on its way) refuses the answer: never shown as locked on this run's memory alone. In use the screen keeps the
 * answer and the lock holds in the session's memory, which no ring's end takes (a send puts it first, GroupKeyring.locksSends;
 * the next answer puts it again); once the phone was set to another community meanwhile, its copy is opened in place for this
 * one write, or the answer is refused. An account on its way off the phone (account-leaving.ts) is marked nowhere, and its
 * answer is nobody's (max review, N1).
 */
async function noteGroupLocked(asked: GroupContext, groupId: string, community?: ChatCommunity): Promise<void> {
    // Whoever it was for and whatever becomes of the mark: from here nothing readable goes to that id this session.
    noteAnsweredLocked(groupId);
    // Another account signed in since, or this one leaving: nothing of this one's is written here any more, and its answer is nobody's.
    const nobodys = async () => (await loadIdentity())?.publicKey !== asked.identity.publicKey || !asked.stays();
    const put = async () => {
        if (await nobodys()) throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
        const ring = ringOf(asked, groupId);
        try {
            await ring.noteLocked();
        } catch (e) {
            // The rings were dropped as it was put (a Force Resync, a community taken off the phone): once more, on the one there is now (S1).
            if (await nobodys() || ringOf(asked, groupId) === ring) throw e;
            await ringOf(asked, groupId).noteLocked();
        }
    };
    try {
        await put();
    } catch (e) {
        if (community || await nobodys()) throw e;
        // The store refused because the phone was elsewhere (it may be back by now), or SQLite did and the phone has not left.
        const elsewhere = e instanceof GroupChatKeyError && (e.why as Error | undefined)?.message === SWITCHED_SINCE_CHAT_OPENED_TEXT;
        if (!elsewhere && await asked.handle().catch(() => null)) return;
        // Followed to a new address since: the mark is owed there (T3), wherever the phone is by now, and the old copy may be gone.
        const now = followedFrom(asked.store.copy ?? '');
        if (now) await whileChatInPlace(now.nodeUrl, () => ringOf({ ...asked, ...now }, groupId).noteLocked()).catch(() => {});
        await whileChatInPlace(asked.nodeUrl, put);
    }
}

/**
 * Why a phone that has held this group's keys sends nothing when the node refuses it the keys (404): the node now says
 * the chat isn't locked (the phone's own lock notice), or it refuses this phone the chat too (a removed member).
 */
async function heldGroupRefusal(asked: GroupContext, groupId: string, community?: ChatCommunity): Promise<GroupChatKeyError> {
    if (await nodeChatIsUnlocked(asked, groupId, community)) return new GroupChatKeyError(GROUP_CHAT_LOCK_LOST_TEXT, 'refused');
    return new GroupChatKeyError(GROUP_CHAT_NOT_MEMBER_TEXT, 'not_member');
}

/** How `asked`'s node answers this group's chat: 'unlocked' (no `encryption`), 'locked', or null (refused, unreachable). */
async function nodeChatAnswer(asked: GroupContext, groupId: string, community?: ChatCommunity): Promise<'unlocked' | 'locked' | null> {
    try {
        const res = await signedGet(`/api/groups/${encodeURIComponent(groupId)}/chat?limit=1`, { anchorUrl: asked.nodeUrl });
        if (!res.ok) return null;
        const answer = await res.json().catch(() => null);
        if (!answer || typeof answer !== 'object') return null;
        if (!chatIsLocked(answer)) return 'unlocked';
        await noteGroupLocked(asked, groupId, community);
        return 'locked';
    } catch {
        return null;
    }
}

/** True only when the node answers this group's chat with no `encryption`: a node from before locked chats (§14.3). */
async function nodeChatIsUnlocked(asked: GroupContext, groupId: string, community?: ChatCommunity): Promise<boolean> {
    return (await nodeChatAnswer(asked, groupId, community)) === 'unlocked';
}

/**
 * Why an edit of a group line the node answered 404 sent nothing: the node answers the chat, so it no longer has the
 * line; or it refuses this phone the chat too (a removed member). The phone's own words, never the node's (confirmation
 * 2 of #1788, J2).
 */
async function editRefusal(asked: GroupContext, groupId: string, community?: ChatCommunity): Promise<GroupChatKeyError> {
    if (await nodeChatAnswer(asked, groupId, community)) return new GroupChatKeyError(GROUP_EDIT_LINE_GONE_TEXT, 'refused');
    return new GroupChatKeyError(GROUP_CHAT_NOT_MEMBER_TEXT, 'not_member');
}

/**
 * A group chat line sealed by the keyring's pre-seal rules; 'readable' only when this phone never held the group's keys, nor saw it locked,
 * and the node's own chat answer for it has no `encryption` (a node from before locked chats, §14.3); null when the
 * conversation isn't a group's (a DM, an event's or an enterprise's thread).
 */
async function sealForGroupConversation(conversationId: string, text: string, line: DmLineToSeal, here: ChatRequestCopy): Promise<{ ciphertext: string; nonce: string; metadata: Record<string, unknown> } | 'readable' | null> {
    const database = here.database;
    let row = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]).catch(() => null);
    // A group this phone has held keys of is its group whatever the row says, with no row (a sync pruned it, a push landed
    // before it), or once something called it a DM: the phone's own key memory decides, never the node's or the row's
    // type (confirmation of #1788, 1), and it is asked FIRST (confirmation 2, finding 2). Only a group never held can be
    // a known DM, and lockForConversation, the one caller, hands that to its pin before this runs (§3.4 amendment 7 §3 iv):
    // no group key is ever synced for a known DM, so it never becomes held (the key-making paths below refuse it too,
    // refuseGroupKeysForDm).
    // One this phone has seen locked, with no key of it yet, is its group as much: sealed or refused, never readable.
    const mine = await groupContextAt(here).catch(() => null);
    // By this community's own knowledge alone: another's locked answer for the id never sends a direct chat's line down a group's
    // path here (max review, T2). It still refuses every readable line (readableLineTo).
    const held = !!mine && await ringOf(mine, conversationId).locksSends(true);
    if (!held) {
        if (!row) {
            // Not on this phone yet (a push tap or a link before the sync wrote it): ask the node what it is first, so a
            // group's first line goes through the keys and the node's own chat answer, never out readable on a missing row
            // (confirmation 2 of #1788, finding 3).
            await refreshConversationFromNode(conversationId);
            row = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]).catch(() => null);
        }
        if (row?.type !== 'group_thread') return null;
    }
    const asked = mine ?? await groupContextAt(here);
    const ring = ringOf(asked, conversationId);
    let sealedUnder: { epoch: number; key: Uint8Array };
    try {
        sealedUnder = await ring.prepareToSeal();
    } catch (e) {
        // A 404 is an old node (no keys route) or a new one refusing this phone its keys (not a member). Readable words go
        // only to an old node, by its own chat answer (no `encryption`), and only while this phone never held a key of, nor saw locked,
        // this group (review of #1788, finding 4; director's decision b).
        if (e instanceof GroupKeysRequestError && e.status === 404) {
            if (held || await ring.seenLocked()) throw await heldGroupRefusal(asked, conversationId);
            if (await nodeChatIsUnlocked(asked, conversationId)) return 'readable';
            throw new GroupChatKeyError(GROUP_CHAT_NOT_MEMBER_TEXT, 'not_member');
        }
        throw e;
    }
    const sealed = sealLine(text, {
        myEdPrivHex: asked.identity.privateKey, groupKey: sealedUnder.key, groupId: ring.groupId, epoch: sealedUnder.epoch,
        messageId: line.messageId, after: line.after ?? null, replyToId: line.replyToId ?? null,
    });
    return { ...sealed, metadata: { epoch: sealedUnder.epoch } };
}

/**
 * Home's "A chat" card (scratch/fable-design/DESIGN-home-chosen-chat-fable.md §1, slice C2): a pinned DM's sealed lines as
 * the node carried them (core HomeChatLine `sealed`), judged exactly as this chat's own screen judges its rows
 * (getMessages): under the key context this phone holds for the conversation (getDmKeyContext 'open': its pin, or the
 * rows' one other key; nothing is written from a read) by core's checkDmThread, the one opener. A line that doesn't open
 * is nobody's. Null when this phone holds no context for it (no row for the chat yet, or its pins can't be read): then
 * nothing opens and the card says the line is locked. The views go back to the caller's memory only: nothing here writes
 * to SQLite, to a file or to any cache, and nothing is fetched.
 */
export async function judgeHomeChatDmLines(
    conversationId: string,
    lines: ReadonlyArray<{ id: string; author: string; type: string; at?: string | null; sealed: { ciphertext: string; nonce: string; metadata: string | null } }>,
): Promise<Map<string, ReturnType<typeof checkDmThread> extends Map<string, infer V> ? V : never> | null> {
    let ctx: PinnedDmKeyContext | null = null;
    try { ctx = await getDmKeyContext(conversationId, 'open'); } catch { ctx = null; }
    if (!ctx) return null;
    return checkDmThread(
        // The node's time for each line: a line from before 1.4.0 opens as old, as the web's card opens it (conversion code, log row OLDCHAT, remove after 12 Dec 2026).
        lines.map(l => ({ id: l.id, authorPubkey: l.author, ciphertext: l.sealed.ciphertext, nonce: l.sealed.nonce, type: l.type, metadata: l.sealed.metadata, timestamp: l.at ?? null })),
        ctx, conversationId, ctx.formerPeers,
    );
}

/**
 * A conversation's rows as the chat screen shows them, oldest first. `limit`: only the newest that many. `notices` (the DM
 * screen): the thread notices that the key changed are merged in by time (withKeyChangedNotices), as items with
 * `keyChangedNotice: true` and no words of anyone's.
 */
export async function getMessages(conversationId: string, opts?: { limit?: number; notices?: boolean; community?: ChatCommunity }) {
    const community = opts?.community;
    const database = await chatDbFor(community);
    // With a limit, return only the NEWEST `limit` messages (WhatsApp-style history
    // window — the chat screen grows the window as the user scrolls up). Selected
    // newest-first then flipped back to chronological so the mapping below and all
    // callers see the same ascending order as the unlimited path.
    let rows: any[];
    if (opts?.limit && opts.limit > 0) {
        rows = await database.getAllAsync<any>(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?',
            [conversationId, opts.limit]
        );
        rows.reverse();
    } else {
        rows = await database.getAllAsync<any>(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
            [conversationId]
        );
    }
    // Load the DM key context once so v2-encrypted rows can be decrypted in the map below.
    let dmCtx: PinnedDmKeyContext | null = null;
    // The pins unreadable: no line can be shown as anyone's, and each says why (§3.4 amendment 6 §3), not "update your app".
    let pinsUnread = false;
    try { dmCtx = await getDmKeyContext(conversationId, 'open', community); } catch (e) { dmCtx = null; pinsUnread = isDmPinStoreError(e); }
    const encryptedUnshown = pinsUnread ? t(DM_PINS_WORDS.unreadLine) : '[Encrypted — update your app to read]';
    // A direct message: every conversation the node doesn't read by design (utils/dm-lock.ts). Its rows are judged by
    // the thread check below, whether or not this phone has the other person's key yet. Fails closed: a conversation
    // this phone has no row for yet (a chat opened from a push or a link, before the first full sync has written it) is
    // judged as a DM, so no row of it is shown as anyone's words unchecked. Only the DM screen reads this (a group's,
    // an event's and an enterprise's chats have their own views).
    let isDm = true;
    try {
        const convRow = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]);
        // A chat open in place is a DM whatever its row says (slice S2): its lines are judged as one, and fail closed.
        isDm = !!community || !!dmCtx || !convRow || !isNodeReadableChatType(convRow.type) || await isKnownDmConversation(conversationId);
    } catch {}
    // Read receipts: my pubkey (to flag outgoing) + the peer's read cursor.
    let myPubkey: string | null = null;
    let peerLastReadAt: string | null = null;
    try {
        const identity = await loadIdentity();
        myPubkey = identity?.publicKey ?? null;
        if (dmCtx) {
            const peerRow = await database.getFirstAsync<any>(
                'SELECT last_read_at FROM conversation_participants WHERE conversation_id = ? AND public_key = ?',
                [conversationId, dmCtx.peerEdPubHex]
            );
            peerLastReadAt = peerRow?.last_read_at ?? null;
        }
    } catch {}

    // Resolve fallback post details for formatting system messages
    let fallbackInfo: any = {};
    try {
        const infoRow = await database.getFirstAsync<any>(
            `SELECT c.post_id, p.author_pubkey as postAuthor, p.type as postType,
                    (SELECT mt3.buyer_pubkey FROM marketplace_transactions mt3 WHERE mt3.post_id = c.post_id ORDER BY mt3.created_at DESC LIMIT 1) as latestTxBuyer,
                    (SELECT mt3.seller_pubkey FROM marketplace_transactions mt3 WHERE mt3.post_id = c.post_id ORDER BY mt3.created_at DESC LIMIT 1) as latestTxSeller
             FROM conversations c
             LEFT JOIN posts p ON c.post_id = p.id
             WHERE c.id = ? LIMIT 1`,
            [conversationId]
        );
        if (infoRow) {
            fallbackInfo = {
                postAuthor: infoRow.postAuthor,
                postType: infoRow.postType,
                latestTxBuyer: infoRow.latestTxBuyer,
                latestTxSeller: infoRow.latestTxSeller
            };
        }
    } catch {}

    // Every line of a DM judged at once, in the order it is shown (by the node's timestamps, as selected above), by
    // e2e-crypto checkDmThread: an encrypted line is opened bound to the author and id this phone holds it under, and one
    // that doesn't open is never shown as anyone's words; a row in a member's name that isn't an encrypted line never is
    // either, nor one its named sender didn't sign; one the node moved or reordered is marked; the admin page's message
    // is shown as the community admins'. Only the node's own notices are left to the system formatting below.
    // The node's time for each line goes in too: a line from before 1.4.0 opens as old, read-only (conversion code, log row OLDCHAT, remove after 12 Dec 2026).
    const lineViews = isDm
        ? checkDmThread(rows.map(r => ({ id: r.id, authorPubkey: r.author_pubkey, ciphertext: r.ciphertext, nonce: r.nonce, type: r.type, metadata: r.metadata, timestamp: r.timestamp })), dmCtx, conversationId, dmCtx?.formerPeers)
        : null;
    // The lines that open only under the key offered in the pinned one's place (design §3.4 amendment 2, item 3): marked
    // so the screen draws one fixed line in their slot (dm-lock dmLineSlotText), and never read out (no text from a key the
    // member hasn't accepted). Only whether each opened is kept. Computed here, where it is drawn (#1872 ultrareview, U8).
    const fromOfferedKey = new Set<string>();
    if (lineViews && dmCtx?.offeredPeer) {
        const unopened = rows.filter(r => lineViews.get(r.id)?.mark === 'not-verified' && isEncryptedNonce(r.nonce));
        if (unopened.length) {
            const underOffer = checkDmThread(unopened.map(r => ({ id: r.id, authorPubkey: r.author_pubkey, ciphertext: r.ciphertext, nonce: r.nonce, type: r.type, metadata: r.metadata })),
                { myEdPrivHex: dmCtx.myEdPrivHex, peerEdPubHex: dmCtx.offeredPeer }, conversationId);
            for (const r of unopened) if (underOffer.get(r.id)?.format != null) fromOfferedKey.add(r.id);
        }
    }

    const shown = rows.map(row => {
        let displayTxt = row.ciphertext;
        let integrityNote: string | null = null;
        let unattributed = false;
        const view = lineViews?.get(row.id);
        if (view) {
            displayTxt = view.mark === 'not-verified' && !dmCtx && isEncryptedNonce(row.nonce)
                ? encryptedUnshown
                : dmLineShownText(view);
            // A line of mine still sending, or failed, is this phone's own row under this phone's clock: the node has
            // not had it, so it is never marked out of order (a clock behind the node's would sort it before the line it
            // follows). Only that mark, and only on my own unconfirmed row: no other mark applies to a line I just wrote,
            // and another person's row is never one (isUndeliveredRow).
            integrityNote = view.mark === 'out-of-order' && isUndeliveredRow(row.metadata, row.author_pubkey, myPubkey) ? null : dmLineMarkText(view.mark);
            // Shown in the middle of the chat as nobody's, never in its named author's bubble.
            unattributed = dmLineIsUnattributed(view);
        } else if (row.nonce === '00000') {
            displayTxt = formatSystemMessage(row.system_type, row.metadata, myPubkey, {
                ...fallbackInfo,
                defaultText: row.ciphertext
            });
        } else if (row.nonce && row.nonce.startsWith('plaintext')) {
            try {
                displayTxt = decodeUtf8(decodeBase64(row.ciphertext));
            } catch {
                displayTxt = '[Unreadable message]';
            }
        } else if (isEncryptedNonce(row.nonce)) {
            displayTxt = encryptedUnshown;
        }
        const outgoing = !!myPubkey && row.author_pubkey === myPubkey;
        const readByPeer = outgoing && !!peerLastReadAt &&
            new Date(row.timestamp).getTime() <= new Date(peerLastReadAt).getTime();
        let parsedMeta: any = undefined;
        if (row.metadata) {
            try { parsedMeta = JSON.parse(row.metadata); } catch {}
        }
        // If the app died mid-delivery the row would show a clock forever —
        // downgrade stale in-flight sends to 'failed' so the bubble offers resend.
        // Only my own row has a send state: another person's never does, whatever its metadata says.
        let sendState = outgoing ? parsedMeta?.__sendState : undefined;
        if (sendState === 'sending' && Date.now() - new Date(row.timestamp).getTime() > 60_000) {
            sendState = 'failed';
        }
        return {
            id: row.id,
            senderId: row.author_pubkey,
            authorPubkey: row.author_pubkey,
            text: displayTxt,
            type: row.type || 'text',
            systemType: row.system_type,
            metadata: parsedMeta,
            // The listing this line is about, opened from its own sealed part (core chat-about.ts); null for every other line.
            about: view && view.format != null && dmCtx
                ? chatAboutOfLine({ myEdPrivHex: dmCtx.myEdPrivHex, peerEdPubHex: dmCtx.peerEdPubHex }, { conversationId, senderPubHex: row.author_pubkey, messageId: row.id, metadata: row.metadata })
                // An old line's card, opened as part of its words (core chatAboutOfOldLine; conversion code, log row OLDCHAT, remove after 12 Dec 2026).
                : view && dmLineIsOld(view) && dmCtx && row.type !== 'removed'
                    ? chatAboutOfOldLine({ myEdPrivHex: dmCtx.myEdPrivHex, peerEdPubHex: dmCtx.peerEdPubHex },
                        { conversationId, senderPubHex: row.author_pubkey, messageId: row.id, metadata: row.metadata, timestamp: row.timestamp },
                        { ciphertext: row.ciphertext, nonce: row.nonce }, dmCtx.formerPeers)
                    : null,
            // 'sending' | 'failed' | undefined — optimistic-send delivery state
            sendState,
            outgoing,
            readByPeer,
            edited: !!row.edited_at,
            // Raw edit timestamp: pins the text content for cheap change detection
            // (chat screen compares (id, editedAt) instead of the decrypted text).
            editedAt: row.edited_at ?? null,
            // One line under a DM message the node moved or reordered, or the admin page's message.
            integrityNote,
            // A DM row shown as nobody's: a line that didn't open, one that wasn't encrypted, or the admin page's message.
            unattributed,
            // A DM line from before 1.4.0, opened as it was then: read-only, under the one label (conversion code, log row OLDCHAT, remove after 12 Dec 2026).
            oldLine: dmLineIsOld(view),
            // A DM line that opens only under the key offered in the pinned one's place: its text is the not-verified line,
            // never its words; the screen draws "Sent from the new key. Shown after you continue." in its slot.
            fromOfferedKey: fromOfferedKey.has(row.id),
            // Who a reply quoting this line shows it as from (e2e-crypto dmQuoteFrom): its check, never its row's name.
            quoteFrom: lineViews ? dmQuoteFrom({ authorPubkey: row.author_pubkey, nonce: row.nonce, type: row.type, metadata: row.metadata }, view) : 'author',
            rawTimestamp: row.timestamp,
            timestamp: new Date(row.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            keyChangedNotice: false,
        };
    });
    if (!opts?.notices) return shown;
    // The notice in the same shape as a line, with nothing of anyone's in it: the screen draws DmKeyChangedNotice for it.
    const notice = (d: string): (typeof shown)[number] => ({
        id: `key-changed:${d}`, senderId: '', authorPubkey: '', text: '', type: 'key-changed', systemType: null, metadata: undefined, about: null,
        sendState: undefined, outgoing: false, readByPeer: false, edited: false, editedAt: null, integrityNote: null, unattributed: false, oldLine: false,
        fromOfferedKey: false, quoteFrom: 'author', rawTimestamp: d, timestamp: new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        keyChangedNotice: true,
    });
    return withKeyChangedNotices(shown, dmCtx?.changedAt, !!opts.limit && rows.length >= opts.limit, notice);
}

/**
 * One notice item per date this phone saw the DM's key change (DESIGN-dm-key-signal-model §2.2: the pin's `changedAt`, the
 * phone's own clock), merged into the thread by time. `windowed`: the thread is a window of the newest lines, so a notice
 * older than its oldest line waits until the window reaches back to it. The phone writes these from its own memory, so a
 * node can't hide a key change from a phone that already had the chat.
 */
function withKeyChangedNotices<T extends { rawTimestamp?: string | null }>(shown: T[], changedAt: readonly string[] | undefined, windowed: boolean, notice: (date: string) => T): T[] {
    if (!changedAt?.length) return shown;
    const at = (iso: string | null | undefined) => { const ms = Date.parse(iso ?? ''); return Number.isFinite(ms) ? ms : 0; };
    const oldest = shown.length ? at(shown[0].rawTimestamp) : 0;
    const notices = changedAt.filter((d) => !windowed || at(d) >= oldest).map(notice).sort((a, b) => at(a.rawTimestamp) - at(b.rawTimestamp));
    const out: T[] = [];
    let n = 0;
    for (const item of shown) {
        while (n < notices.length && at(notices[n].rawTimestamp) < at(item.rawTimestamp)) out.push(notices[n++]);
        out.push(item);
    }
    while (n < notices.length) out.push(notices[n++]);
    return out;
}

// Resend path may pass the failed row's id so a retry of a send that actually
// landed (POST timed out after the server committed) is idempotent server-side
// instead of a real duplicate the peer sees twice. Non-UUID ids (old pending-
// prefixed rows from before client-generated ids) fall back to a fresh id.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function insertMessage(conversationId: string, authorPubkey: string, text: string, metadata?: string, reuseId?: string, about?: ChatAboutChip | null, community?: ChatCommunity) {
    // The community the line goes to and its file, taken together (chatCopyForRequest): the line is written there and sent
    // there, never written into one community's file and sent to another's node. `community`: a chat open in place (S2),
    // and only a direct one that community's copy holds (#3305 review F1).
    const here = await onlyDmInPlace(await chatCopyForRequest(community), conversationId);

    // The id is chosen first: a DM line is sealed and signed to it (e2e-crypto, format 4), so the node must store the line under
    // exactly this id. Lower case, as the node keeps it. A resend keeps its failed row's id (see below).
    const tempId = (reuseId && UUID_V4_RE.test(reuseId) ? reuseId : Crypto.randomUUID()).toLowerCase();

    // E2E-encrypt direct messages (NAT-1), or send nothing: DmNotLockedError before anything is written, so the chat
    // can put the words back in the box. A group chat stays plaintext-v1 (lockForConversation).
    const locked = await lockForConversation(conversationId, text, {
        senderPubHex: authorPubkey,
        messageId: tempId,
        after: await lineToWriteAfter(conversationId, reuseId, community),
        replyToId: replyToIdOf(metadata),
    }, here, community);
    const { ciphertext, nonce } = locked;
    // A group line names the epoch it was sealed under, beside whatever the caller's metadata says (a reply). A DM line
    // carries nothing beside it: its signature is in its own ciphertext (format 4).
    if (locked.metadata) {
        let m: any = {};
        try { m = metadata ? JSON.parse(metadata) || {} : {}; } catch { m = {}; }
        metadata = JSON.stringify({ ...m, ...locked.metadata });
    }
    // The listing this line is about (Message on a listing; core chat-about.ts): its own sealed part of the line, to the same
    // key and the same message id, carried in the metadata as sealed bytes. The node reads nothing new. A resend keeps the
    // one its failed row already holds (same id, same sender, same conversation, so it still opens).
    if (about) {
        const ctx = await requireDmKeyContext(conversationId, community);
        metadata = metadataWithAbout(metadata, sealChatAbout(about, ctx, { senderPubHex: authorPubkey, messageId: tempId, replyToId: replyToIdOf(metadata) }));
    }

    const anchorUrl = here.anchorUrl;
    if (!anchorUrl) {
        throw new Error('You are off-grid. Please connect to a BeanPool Node to send messages.');
    }

    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');

    // Optimistic send (WhatsApp-style): write the message locally first under a
    // temporary id so the bubble renders immediately with a "sending" clock, then
    // deliver to the node in the background. On ack the row adopts the server-vetted
    // id/timestamp and the clock becomes a tick; on failure it's flagged so the
    // bubble can offer resend. Callers therefore resolve in milliseconds — the
    // previous shape blocked the UI on a full server round-trip (~2s on-device).
    // Client-generated id (WhatsApp-style), sent to the node in the POST body.
    // A new node keeps it, so the optimistic row below and the server's row are
    // the same row by construction — the WS echo of an own-send upserts onto
    // this row instead of materializing a second bubble that vanishes when the
    // ack lands (the "duplicate then disappears" flicker). The id (tempId, above) is
    // also what the DM line is sealed to: every node since client ids keeps it, so the
    // ack's rename below is a no-op; a node that stored it under another id would leave
    // a line the other phone can't verify, and shows it so.
    let baseMeta: any = {};
    if (metadata) {
        try { baseMeta = JSON.parse(metadata) || {}; } catch {}
    }
    // A resend replaces its failed row only now, with the words locked: one that can't be locked (or finds no node)
    // leaves the failed bubble where it was, to be tried again. Nor once the phone has switched community while the words
    // were locked: nothing is written or sent, and the chat says so.
    const database = await here.handle();
    if (!database) throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
    if (reuseId) await database.runAsync('DELETE FROM messages WHERE id = ?', [reuseId]);
    await database.runAsync(
        'INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tempId, conversationId, authorPubkey, ciphertext, nonce, JSON.stringify({ ...baseMeta, __sendState: 'sending' }), new Date().toISOString()]
    );

    // Fire-and-forget: the returned promise is intentionally not awaited.
    _deliverPendingMessage(here, anchorUrl, identity, tempId, { id: tempId, conversationId, authorPubkey, ciphertext, nonce, metadata }, locked.last);
    // The line's id, which the node keeps: the chat follows it to the node's answer (a request's line waits for the 200).
    return tempId;
}

/** Background half of the optimistic send: POST to the node, then either adopt the
 *  server id/timestamp or mark the local row failed. Always emits sync_data_updated
 *  so any mounted thread re-renders the tick state. Sent to `here`'s community (`anchorUrl`, its address), and its
 *  answer written into `here`'s file only: once the phone has switched community, nothing is written (that community's
 *  next sync brings the node's row, which replaces the one still sending). */
async function _deliverPendingMessage(
    here: ChatRequestCopy,
    anchorUrl: string,
    identity: { privateKey: string; publicKey: string },
    tempId: string,
    body: { id: string; conversationId: string; authorPubkey: string; ciphertext: string; nonce: string; metadata?: string },
    /** A readable line's last ask ({@link readableLineTo}): throws, and the line is kept as not sent. */
    last?: LastAsk,
) {
    const { DeviceEventEmitter } = require('react-native');
    try {
        const bodyString = JSON.stringify(body);
        const headers = await buildSignedHeaders('POST', `${anchorUrl}/api/messages/send`, bodyString, identity.privateKey, identity.publicKey);
        await last?.lastLook?.();
        last?.leaving();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${anchorUrl}/api/messages/send`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            const txt = await res.text();
            let errMsg = 'Failed to deliver message.';
            try {
                const json = JSON.parse(txt);
                if (json.error) errMsg = json.error;
            } catch {
                if (txt) errMsg = refusalTextOf(res.status, txt, errMsg);
            }
            throw new Error(errMsg);
        }

        ownLineTaken(body.conversationId);
        const data = await res.json();
        const serverMsg = data.message;

        // In the tick the 200 arrives while the copy the row was written into is still open (openNow): no read of the chat
        // comes between the node taking the line and this row saying so. After a swap or a close, handle() decides.
        const database = here.openNow() ?? await here.handle();
        if (!database) return;
        // Adopt the server-vetted id + timestamp and drop the sending flag.
        // OR REPLACE: a 3s poll may have already synced the server's copy of this
        // message — in that case the confirmed local row simply replaces it.
        await database.runAsync(
            'UPDATE OR REPLACE messages SET id=?, timestamp=?, metadata=? WHERE id=?',
            [serverMsg.id, serverMsg.timestamp, body.metadata || null, tempId]
        );
        await requestLineTaken(database, body.conversationId, identity.publicKey);
    } catch (deliverErr: any) {
        console.warn(`[Messaging] Delivery failed for message ${tempId.slice(0, 8)}:`, deliverErr?.message || deliverErr);
        try {
            const database = here.openNow() ?? await here.handle();
            if (!database) return;
            const row = await database.getFirstAsync<any>('SELECT metadata FROM messages WHERE id=?', [tempId]);
            let meta: any = {};
            if (row?.metadata) {
                try { meta = JSON.parse(row.metadata) || {}; } catch {}
            }
            meta.__sendState = 'failed';
            if (deliverErr?.message) meta.__sendError = deliverErr.message;
            await database.runAsync('UPDATE messages SET metadata=? WHERE id=?', [JSON.stringify(meta), tempId]);
        } catch {}
    } finally {
        DeviceEventEmitter.emit('sync_data_updated');
    }
}

/**
 * The node took a line of `me`'s (200): where it was their message request's line, the chat's request now waits for the
 * other's answer (core requestAfterOwnLine), here as on the node, so the chat reads as waiting only from the 200 and a
 * reread of the row keeps it so until the next poll brings the node's word (PR #2540 review 4393642166). Never throws.
 */
async function requestLineTaken(database: SQLite.SQLiteDatabase, conversationId: string, me: string): Promise<void> {
    try {
        const row = await database.getFirstAsync<{ request: string | null }>('SELECT request FROM conversations WHERE id = ?', [conversationId]);
        if (!row?.request) return;
        const was = JSON.parse(row.request);
        const now = requestAfterOwnLine(was, me);
        if (now !== was) await database.runAsync('UPDATE conversations SET request = ? WHERE id = ?', [JSON.stringify(now), conversationId]);
    } catch { /* the next poll brings the node's word */ }
}

/**
 * The node took a decision on the chat's request (its 200; `request` the request as the member now reads it): written to
 * this phone's row, as on the node, and kept for a read asked for before it, which writes it in place of its own
 * (requestAfterReadHere): an open chat's poll, or a card's preview, in flight when Accept was tapped answers the request
 * waiting, and a list from before Cancel request names its line waiting (PR #2540 review 4395706539). Never throws.
 */
async function requestDecided(here: ChatRequestCopy, conversationId: string, request: unknown): Promise<void> {
    if (!request || typeof request !== 'object') return;
    try {
        const json = JSON.stringify(request);
        _requestDecided.set(conversationId, { n: ++_requestDecisions, request: json });
        // Into the file of the community that decided it only (chatCopyForRequest).
        const database = await here.handle();
        if (!database) return;
        await database.runAsync('UPDATE conversations SET request = ? WHERE id = ?', [json, conversationId]);
    } catch { /* the next poll brings the node's word */ }
}

/**
 * Remove a message row from this phone, and its photo's decrypted copy with it (used to discard or resend a failed
 * optimistic send, and by Cancel request, which takes the opener's own lines off: PR #2540 review 4397153864).
 */
export async function deleteLocalMessage(messageId: string, community?: ChatCommunity) {
    const copy = await chatReadFor(community);
    // In place, only a line of a direct chat that community's copy holds (#3305 review F1): nothing taken off otherwise.
    if (copy.inPlace && !(await dmLineHeldThrough(copy.database, messageId))) return;
    const database = copy.database;
    await database.runAsync('DELETE FROM messages WHERE id = ?', [messageId]);
    await forgetCachedChatImage(messageId);
}

/**
 * Edit a previously-sent text message within the 5-minute window. Re-encrypts the new text with
 * the same DM key and posts to the node, which enforces the window against its own clock and
 * re-broadcasts to participants. The node-returned editedAt is mirrored locally so a sync that
 * was already in flight (with the pre-edit content) can't revert the change.
 */
export async function editMessage(conversationId: string, messageId: string, newText: string, community?: ChatCommunity) {
    // The community the edit goes to and its file, taken together (chatCopyForRequest). `community`: a chat open in place,
    // and only a direct one that community's copy holds (#3305 review F1).
    const here = await onlyDmInPlace(await chatCopyForRequest(community), conversationId);
    const database = here.database;
    const identity = await loadIdentity();

    // A locked group chat's line: re-sealed under its own epoch, never the current one (utils/group-chat-lines.ts). Never in
    // place: a chat open in place is a DM (slice S2), its line sealed to that community's pin below.
    const convRow = await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]).catch(() => null);
    if (!here.inPlace && (convRow?.type === 'group_thread' || await goesAsGroup(conversationId, here))) {
        const row = await database.getFirstAsync<any>('SELECT nonce, metadata FROM messages WHERE id = ?', [messageId]).catch(() => null);
        if (row?.nonce && String(row.nonce).startsWith(GROUP_NONCE_PREFIX)) {
            let meta: any = {};
            try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
            await editThreadMessage(messageId, newText, { groupId: conversationId, metadata: meta, locked: true }, community);
            return;
        }
    }

    // New words: locked like a new message, or not sent (DmNotLockedError). Sealed to the line's own id, keeping the
    // line it was written after: an edit stays where its line is.
    const { ciphertext, nonce, metadata, last } = await lockForConversation(conversationId, newText, {
        senderPubHex: identity?.publicKey ?? '',
        messageId,
        ...(await sealOfLine(conversationId, messageId, community)),
    }, here, community);

    const anchorUrl = here.anchorUrl;
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node to edit messages.');
    if (!identity) throw new Error('No identity found.');

    const body = { messageId, authorPubkey: identity.publicKey, ciphertext, nonce, ...(metadata ? { metadata } : {}) };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', `${anchorUrl}/api/messages/edit`, bodyString, identity.privateKey, identity.publicKey);

    await last?.lastLook?.();
    last?.leaving();
    const res = await fetch(`${anchorUrl}/api/messages/edit`, { method: 'POST', headers, body: bodyString });
    if (!res.ok) {
        const txt = await res.text();
        let errMsg = 'Failed to edit message.';
        try { const j = JSON.parse(txt); if (j.error) errMsg = j.error; } catch { if (txt) errMsg = refusalTextOf(res.status, txt, errMsg); }
        throw new Error(errMsg);
    }
    const data = await res.json();
    const editedAt = data?.message?.editedAt || new Date().toISOString();
    // The node took it: mirrored in its community's file only, and not at all once the phone has switched (its next
    // sync there brings the edit).
    const copy = await here.handle();
    if (!copy) return;
    await copy.runAsync(
        'UPDATE messages SET ciphertext = ?, nonce = ?, edited_at = ? WHERE id = ?',
        [ciphertext, nonce, editedAt, messageId]
    );
}

/**
 * A chat the node reads by design (an event's, an enterprise's thread) takes no photo (DESIGN-group-chat-photos-fable.md
 * §4). Translated where it is shown (utils/chat-line-words.ts).
 */
const PHOTOS_NOT_IN_THIS_CHAT_TEXT = "Photos can't be sent in this chat.";

/**
 * Send an image in a DM (NAT-1 attachments). The image is E2E-encrypted with the
 * DM key and uploaded as a separate blob (lazy-loaded), so the node only ever holds
 * ciphertext and the message feed stays light.
 *
 * A group's chat goes as a group's photo (postGroupChatPhoto), decided by this phone's own key memory first: once it held
 * the group's keys, sealed under the keyring's epoch whatever the row says, never DM-sealed to whoever the node lists
 * (DESIGN-group-chat-photos-fable.md §5 S3). An event's or an enterprise's chat is refused, nothing sent.
 */
export async function sendImageMessage(conversationId: string, dataUri: string, caption: string = '', metadata?: string) {
    // The community the photo goes to and its file, taken together (chatCopyForRequest).
    const here = await chatCopyForRequest();
    const database = here.database;
    // Asked first: a conversation not on this phone yet is asked of the node, and a held group's row is written group_thread.
    const nodeReadable = await isNodeReadableConversation(conversationId);
    const groupChat = await goesAsGroup(conversationId, here)
        || (nodeReadable && (await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]))?.type === 'group_thread');
    if (groupChat) return postGroupChatPhoto(conversationId, { dataUri, caption, replyToId: replyToIdOf(metadata) });
    if (nodeReadable) throw new Error(PHOTOS_NOT_IN_THIS_CHAT_TEXT);
    // The picture and its caption are locked, or neither goes (DmNotLockedError). Both are sealed to the message's own
    // id, which goes to the node with them, each as its own part, so neither can stand in for the other.
    const dmCtx = await requireDmKeyContext(conversationId);
    const identity = await loadIdentity();
    const messageId = Crypto.randomUUID().toLowerCase();
    const line = { senderPubHex: identity?.publicKey ?? '', messageId, replyToId: replyToIdOf(metadata) };

    const encImg = lockWith(dmCtx, dataUri, { ...line, part: 'attachment' });   // big blob -> stored as attachment
    const encCap = lockWith(dmCtx, caption, { ...line, part: 'body', after: await lineToWriteAfter(conversationId) });   // (optional) caption -> message body

    const anchorUrl = here.anchorUrl;
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node to send messages.');
    if (!identity) throw new Error('No identity found.');

    const body = {
        id: messageId,
        conversationId,
        authorPubkey: identity.publicKey,
        ciphertext: encCap.ciphertext,
        nonce: encCap.nonce,
        type: 'image',
        attachment: { data: encImg.ciphertext, nonce: encImg.nonce, mime: 'image/jpeg' },
        metadata
    };
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', `${anchorUrl}/api/messages/send`, bodyString, identity.privateKey, identity.publicKey);
    const res = await fetch(`${anchorUrl}/api/messages/send`, { method: 'POST', headers, body: bodyString });
    if (!res.ok) {
        let errMsg = 'Failed to send image.';
        try { const j = JSON.parse(await res.text()); if (j.error) errMsg = j.error; } catch {}
        throw new Error(errMsg);
    }
    ownLineTaken(conversationId);
    const serverMsg = (await res.json()).message;
    // Written into the photo's community's file only: once the phone has switched, its next sync there brings the line.
    // A poll may have written it already, between the node's answer and here (#3300 r2): that row is the node's own, by
    // the same id, and stays; a plain INSERT failed on the id and said the sent photo hadn't gone.
    const copy = await here.handle();
    if (!copy) return;
    await copy.runAsync(
        'INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
        [serverMsg.id, conversationId, identity.publicKey, encCap.ciphertext, encCap.nonce, 'image', metadata || null, serverMsg.timestamp]
    );
    await requestLineTaken(copy, conversationId, identity.publicKey);
}

/**
 * Fetch + decrypt an image attachment for a DM message. Returns a data URI ready
 * for <Image>, or null if it can't be loaded/decrypted. The blob is fetched lazily
 * (only when an image bubble is rendered).
 *
 * `oldLine` (conversion code, log row OLDCHAT, remove after 12 Dec 2026): the line is one getMessages showed old (from
 * before 1.4.0, read-only): its photo opens as part of its words, as 1.2.36 opened it (oldLinePhoto below).
 */
export async function getDecryptedAttachment(conversationId: string, messageId: string, oldLine = false, community?: ChatCommunity): Promise<string | null> {
    try {
        // `community`: a chat open in place (slice S2): its copy, its pins and its server's copy of the photo.
        const here = await chatReadFor(community);
        // 1. The words first, always: the photo is part of its message, never on its own. They are opened bound to the
        //    author and id this phone holds the message under, in the conversation it is shown in (a local row, cheap).
        //    Words that don't open leave the photo locked, the cached copy included: the cache is keyed by message id
        //    alone and survives a wipe-and-fetch, so a photo opened once would otherwise show again under a line the node
        //    has since re-attributed or moved.
        const dmCtx = await getDmKeyContext(conversationId, 'open', community);
        if (!dmCtx) return null;
        const database = here.database;
        const msgRow = await database.getFirstAsync<any>(
            'SELECT ciphertext, nonce, author_pubkey, metadata, timestamp FROM messages WHERE id = ?', [messageId]
        );
        if (!msgRow || !isEncryptedNonce(msgRow.nonce)) return null;
        // Under the pinned key, or a key pinned before it (pick 3): a photo from before "Continue with the new key" still
        // opens, under the same key and sender as its words.
        const ref = { conversationId, senderPubHex: msgRow.author_pubkey, messageId, metadata: msgRow.metadata };
        // Old chat (conversion code, log row OLDCHAT, remove after 12 Dec 2026): a line from before 1.4.0 the thread showed old.
        if (oldLine) return await oldLinePhoto(dmCtx, msgRow, ref, here.anchorUrl);
        const words = openDmPartWithFormer({ ciphertext: msgRow.ciphertext, nonce: msgRow.nonce }, dmCtx, { ...ref, part: 'body' });

        // 2. Local cache next. Lives in the filesystem (survives a DB wipe-and-fetch), so an
        //    image is downloaded+decrypted at most once per device and re-opens instantly/offline.
        const cachePath = `${CHAT_IMAGE_CACHE_DIR}${messageId}.jpg`;
        const cached = await FileSystem.getInfoAsync(cachePath);
        if (cached.exists) return cachePath;

        // 3. Cache miss → fetch the encrypted blob + decrypt (lazy, on demand — never in bulk), bound as its words are and
        //    and signed by that sender (format 4), so neither a photo from another line nor one the other person sealed in
        //    the sender's name can stand in.
        const res = await signedGet(`/api/messages/${messageId}/attachment`, { anchorUrl: here.anchorUrl });
        if (!res.ok) return null;
        const { data, nonce } = await res.json();
        const decrypted = openDmLine({ ciphertext: data, nonce }, words.keys, { ...ref, senderPubHex: words.senderPubHex, part: 'attachment' }).text;

        // 4. Persist to the filesystem cache. Decrypted-at-rest is acceptable: E2E protects the
        //    image from the NODE, and the device owner already views it. Falls back to the inline
        //    data URI if it isn't a recognised image payload (don't cache an unknown shape).
        const m = decrypted.match(/^data:image\/\w+;base64,(.*)$/);
        if (!m) return decrypted;
        try { await FileSystem.makeDirectoryAsync(CHAT_IMAGE_CACHE_DIR, { intermediates: true }); } catch {}
        await FileSystem.writeAsStringAsync(cachePath, m[1], { encoding: FileSystem.EncodingType.Base64 });
        return cachePath;
    } catch {
        return null;
    }
}

/** A chat the node reads by design (an event's, an enterprise's) takes no voice message yet (§5.3: direct and group chats first). */
const VOICE_NOT_IN_THIS_CHAT_TEXT = "Voice messages can't be sent in this chat.";
/** The recording didn't pass core's checks (a file that isn't an .m4a, too long, too big): nothing was sent. */
const VOICE_CANT_SEND_TEXT = "This voice message can't be sent. Record it again.";
/**
 * The caller gave up on a send (the screen's 60 s) before its answer came, and has already said so: the word for an answer
 * that came too late.
 */
const VOICE_GIVEN_UP_TEXT = 'Sending the voice message is taking too long — please try again.';

/**
 * Send a voice message (DESIGN-cross-chat-voice-fable.md §5.4, slice V3): sealed on this phone as its message's own part
 * `voice`, as bytes (core sealDmVoice), under the DM's key, beside its words (empty), sealed as part 'body' as a photo's
 * caption is, so the thread check reads it like any line and the voice opens only once its words have. The node keeps the
 * sealed part where it keeps photos and serves it at GET /api/messages/:id/attachment, as `type: 'voice'` with the mime
 * VOICE_MIME (the node's side is slice V2). Then kept on this phone, so the sender plays it without fetching it.
 *
 * A group's chat goes as a group's voice line (postGroupChatVoice), decided as sendImageMessage decides; an event's or an
 * enterprise's chat is refused, nothing sent.
 *
 * Idempotent on the line's id (PR #3112 review, round 2): `opts.messageId` is the recording's own, the same on every try, so
 * a Send after a try that timed out but landed is the node's duplicate (engine/messaging.ts answers the line it stored), one
 * line, never two. The local row is written only if it isn't there yet. `opts.signal` is the caller giving up (the screen's
 * 60 s): it aborts the POST, and an answer that comes after it writes nothing here, so a late first try never shows its line
 * while the recorder says it wasn't sent.
 */
export async function sendVoiceMessage(conversationId: string, voice: VoiceInput, metadata?: string, opts: { messageId?: string; signal?: AbortSignal } = {}): Promise<void> {
    // The community the voice message goes to and its file, taken together (chatCopyForRequest).
    const here = await chatCopyForRequest();
    const database = here.database;
    const nodeReadable = await isNodeReadableConversation(conversationId);
    const groupChat = await goesAsGroup(conversationId, here)
        || (nodeReadable && (await database.getFirstAsync<any>('SELECT type FROM conversations WHERE id = ?', [conversationId]))?.type === 'group_thread');
    if (groupChat) {
        await postGroupChatVoice(conversationId, { voice, replyToId: replyToIdOf(metadata), clientId: opts.messageId, signal: opts.signal });
        return;
    }
    if (nodeReadable) throw new Error(VOICE_NOT_IN_THIS_CHAT_TEXT);
    const dmCtx = await requireDmKeyContext(conversationId);
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');
    const messageId = (opts.messageId && UUID_V4_RE.test(opts.messageId) ? opts.messageId : Crypto.randomUUID()).toLowerCase();
    const line = { senderPubHex: identity.publicKey, messageId, replyToId: replyToIdOf(metadata) };
    let encVoice: { ciphertext: string; nonce: string };
    try {
        encVoice = sealDmVoice(voice, dmCtx, line);
    } catch (e) {
        if (e instanceof VoiceRefusedError) throw new Error(VOICE_CANT_SEND_TEXT);
        throw new DmNotLockedError();
    }
    // Never after itself: a try that landed may already be on this phone.
    const encBody = lockWith(dmCtx, '', { ...line, part: 'body', after: await lineToWriteAfter(conversationId, messageId) });

    const anchorUrl = here.anchorUrl;
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node to send messages.');
    const bodyString = JSON.stringify({
        id: messageId, conversationId, authorPubkey: identity.publicKey, ciphertext: encBody.ciphertext, nonce: encBody.nonce,
        type: 'voice', attachment: { data: encVoice.ciphertext, nonce: encVoice.nonce, mime: VOICE_MIME }, metadata,
    });
    const headers = await buildSignedHeaders('POST', `${anchorUrl}/api/messages/send`, bodyString, identity.privateKey, identity.publicKey);
    const res = await fetch(`${anchorUrl}/api/messages/send`, { method: 'POST', headers, body: bodyString, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!res.ok) {
        let errMsg = 'Failed to send the voice message.';
        try { const j = JSON.parse(await res.text()); if (j.error) errMsg = j.error; } catch {}
        throw new Error(errMsg);
    }
    const serverMsg = (await res.json()).message;
    // Given up while the answer came: nothing written here; the recorder holds the recording for Send, the same line again.
    if (opts.signal?.aborted) throw new Error(VOICE_GIVEN_UP_TEXT);
    ownLineTaken(conversationId);
    // A retry the node answered with the line it stored: that line's own seal, and a row already here (the sync's) stays.
    const stored = typeof serverMsg?.ciphertext === 'string' && typeof serverMsg?.nonce === 'string';
    // Written into the voice message's community's file only: once the phone has switched, its next sync there brings it.
    const copy = await here.handle();
    if (copy) {
        await copy.runAsync(
            'INSERT OR IGNORE INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [serverMsg.id, conversationId, identity.publicKey, stored ? serverMsg.ciphertext : encBody.ciphertext, stored ? serverMsg.nonce : encBody.nonce,
                'voice', (stored ? (typeof serverMsg.metadata === 'string' ? serverMsg.metadata : null) : metadata) || null, serverMsg.timestamp]
        );
        await requestLineTaken(copy, conversationId, identity.publicKey);
    }
    await keepVoice(serverMsg.id, voice);
}

/**
 * Send a voice message in a group's chat: sealed under the group line's own message key as part `voice` (core
 * sealGroupVoice), beside empty words, through the group's sealed-line path (utils/group-chat-lines.ts), then kept here.
 *
 * `clientId` is the recording's own line id, the same on every try, so a Send after a try that timed out but landed is the
 * node's duplicate (engine/group-thread.ts answers the line it stored): one line. `signal` is the caller giving up: it aborts
 * the POST, and an answer after it keeps nothing here (PR #3112 review, round 2).
 */
export async function postGroupChatVoice(groupId: string, input: { voice: VoiceInput; clientId?: string; replyToId?: string | null; after?: string | null; signal?: AbortSignal }): Promise<any> {
    const asked = await groupContextFor(groupId, undefined);
    const { nodeUrl, identity, store } = asked;
    const ring = ringOf(asked, groupId);
    await refuseGroupKeysForDm(ring);
    const clientId = (input.clientId && UUID_V4_RE.test(input.clientId) ? input.clientId : Crypto.randomUUID()).toLowerCase();
    let answer: any;
    try {
        answer = await sendSealedGroupLine(nodeUrl, identity, store, {
            groupId, text: '', voice: input.voice, clientId, replyToId: input.replyToId, after: input.after, signal: input.signal,
        });
    } catch (e) {
        if (e instanceof VoiceRefusedError) throw new Error(VOICE_CANT_SEND_TEXT);
        if (e instanceof GroupKeysRequestError && e.status === 404 && await ring.seenLocked()) throw await heldGroupRefusal(asked, groupId);
        throw e;
    }
    if (input.signal?.aborted) throw new Error(VOICE_GIVEN_UP_TEXT);
    await keepVoice(clientId, input.voice);
    return answer;
}

/**
 * What a voice bubble plays: the phone's own copy, else the node's, opened and kept. 'gone': the node no longer has it
 * (after 30 days, §5.4) and this phone never kept it. 'refused': it didn't open or pass core's checks ("can't be played").
 * 'unavailable': the node couldn't be asked; try again later.
 */
export type VoiceOpenResult = { kind: 'ok'; voice: KeptVoice } | { kind: 'gone' } | { kind: 'refused' } | { kind: 'unavailable' };

/** A node's answer for an attachment that no longer exists: the 30-day expiry (V2) answers 404 or 410. */
const isGoneStatus = (status: number) => status === 404 || status === 410;

/**
 * A DM voice line's sound, in getDecryptedAttachment's order: its words first, opened under the pinned key or a former one
 * (so a kept copy never plays under a line the node re-attributed or moved), then the phone's own copy, then the node's,
 * opened as the part `voice` under the pinned key or a former one (utils/dm-voice.ts) and only under the key and sender its
 * words opened under: both parts of one message, one key.
 */
export async function getDecryptedVoice(conversationId: string, messageId: string, community?: ChatCommunity): Promise<VoiceOpenResult> {
    // `community`: a chat open in place (slice S2): its copy, its pins and its server's copy of the sound.
    let here: Awaited<ReturnType<typeof chatReadFor>>;
    try { here = await chatReadFor(community); } catch { return { kind: 'unavailable' }; }
    let dmCtx: PinnedDmKeyContext | null;
    try { dmCtx = await getDmKeyContext(conversationId, 'open', community); } catch { return { kind: 'unavailable' }; }
    if (!dmCtx) return { kind: 'refused' };
    const database = here.database;
    const msgRow = await database.getFirstAsync<any>('SELECT ciphertext, nonce, author_pubkey, metadata FROM messages WHERE id = ?', [messageId]).catch(() => null);
    if (!msgRow || !isEncryptedNonce(msgRow.nonce)) return { kind: 'refused' };
    const ref = { conversationId, senderPubHex: msgRow.author_pubkey, messageId, metadata: msgRow.metadata };
    let words: ReturnType<typeof openDmPartWithFormer>;
    try { words = openDmPartWithFormer({ ciphertext: msgRow.ciphertext, nonce: msgRow.nonce }, dmCtx, { ...ref, part: 'body' }); } catch { return { kind: 'refused' }; }
    const kept = await keptVoice(messageId);
    if (kept) return { kind: 'ok', voice: kept };
    let res: Response;
    try { res = await signedGet(`/api/messages/${encodeURIComponent(messageId)}/attachment`, { anchorUrl: here.anchorUrl }); } catch { return { kind: 'unavailable' }; }
    if (isGoneStatus(res.status)) return { kind: 'gone' };
    if (!res.ok) return { kind: 'unavailable' };
    try {
        const { data, nonce } = await res.json();
        const opened = openDmVoiceWithFormer({ ciphertext: data, nonce }, dmCtx, ref);
        if (opened.peerEdPubHex !== words.keys.peerEdPubHex || opened.senderPubHex !== words.senderPubHex) return { kind: 'refused' };
        const voice = await keepVoice(messageId, opened.voice);
        // Not kept (a full disk): played from a file this once is not possible without one, so it says so.
        return voice ? { kind: 'ok', voice } : { kind: 'unavailable' };
    } catch {
        return { kind: 'refused' };
    }
}

/** A group voice line's sound for GroupChatView: the phone's own copy, else the node's, opened under the line's epoch key. */
export async function getDecryptedGroupVoice(groupId: string, line: ServedGroupLine, view: GroupLineView, community?: ChatCommunity): Promise<VoiceOpenResult> {
    const { nodeUrl, identity, store } = await groupContextFor(groupId, community);
    return getDecryptedGroupVoiceLine(nodeUrl, identity, store, { groupId, line, view }, { kept: keptVoice, keep: keepVoice });
}

/**
 * Old chat's photo (conversion code, log row OLDCHAT, remove after 12 Dec 2026; Marty, 13 Nov 2026: "if they are there why
 * not view them?"): the photo of a line getMessages showed old, in getDecryptedAttachment's order. Its words first, opened as
 * an old line under the pinned key or a former one (core openDmOldLineWords), so a cached copy never shows under words that
 * don't; then the cache; then the node's copy, opened under the key, sender, conversation id and format its words opened in,
 * and only a picture (core openDmOldPhoto). Anything else, or no file on the node, is null: the bubble stays locked.
 */
async function oldLinePhoto(
    dmCtx: PinnedDmKeyContext,
    msgRow: { ciphertext: string; nonce: string; timestamp: string | null },
    ref: { conversationId: string; senderPubHex: string; messageId: string; metadata: unknown },
    anchorUrl?: string,
): Promise<string | null> {
    const words = { ciphertext: msgRow.ciphertext, nonce: msgRow.nonce };
    const keys = { myEdPrivHex: dmCtx.myEdPrivHex, peerEdPubHex: dmCtx.peerEdPubHex };
    const line = { ...ref, timestamp: msgRow.timestamp };
    openDmOldLineWords(words, keys, line, dmCtx.formerPeers);
    const cachePath = `${CHAT_IMAGE_CACHE_DIR}${ref.messageId}.jpg`;
    const cached = await FileSystem.getInfoAsync(cachePath);
    if (cached.exists) return cachePath;
    // `anchorUrl`: a chat open in place's own community (slice S2); left out, the community in use.
    const res = await signedGet(`/api/messages/${ref.messageId}/attachment`, { anchorUrl });
    if (!res.ok) return null;
    const { data, nonce } = await res.json();
    const m = openDmOldPhoto(words, { ciphertext: data, nonce }, keys, line, dmCtx.formerPeers).match(/^data:image\/\w+;base64,(.*)$/);
    if (!m) return null;
    try { await FileSystem.makeDirectoryAsync(CHAT_IMAGE_CACHE_DIR, { intermediates: true }); } catch {}
    await FileSystem.writeAsStringAsync(cachePath, m[1], { encoding: FileSystem.EncodingType.Base64 });
    return cachePath;
}

/** A group photo line's photo for GroupChatView: opened on this phone, kept in the group's folder (groupPhotoCache). */
export async function getDecryptedGroupPhoto(groupId: string, line: ServedGroupLine, view: GroupLineView, community?: ChatCommunity): Promise<string | null> {
    const { nodeUrl, identity, store } = await groupContextFor(groupId, community);
    return getDecryptedGroupAttachment(nodeUrl, identity, store, { groupId, line, view }, groupPhotoCache);
}

/** A list of keys as a set to compare: each lower-cased, once, sorted. */
function keySetOf(keys: unknown[]): string[] {
    return [...new Set(keys.map((k) => String(k ?? '').toLowerCase()))].sort();
}

// Only DMs are created here: the old chat group was removed (2026-09-19); a group chat is a Commons group's.
export async function createConversationApi(type: 'dm', participants: string[], createdBy: string, name?: string, postId?: string, community?: ChatCommunity): Promise<any> {
    // The community the chat is started in and its file, taken together (chatCopyForRequest). `community`: a contact's
    // community this phone holds, started there in place (slice S2).
    const here = await chatCopyForRequest(community);
    const anchorUrl = here.anchorUrl;
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a node first.');

    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found.');
    // Starting a DM asks nothing about notifications (slice N2a): the named line comes under the member's first message
    // sent, in the chat (app/chat/[id].tsx, components/NotifyLine.tsx).
    // The pins before the node's answer is written, through the handle it is written with (see refreshConversationFromNode):
    // its rows are never the update's seed. With the pins unread, nothing is asked or written (§3.4 amendment 5's gate).
    // Never once the phone has switched meanwhile (the handle is then null).
    const database = await here.handle();
    if (!database) throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
    await dmPins.read(identity.publicKey, database);

    const body: any = { type, participants, createdBy };
    if (name) body.name = name;
    if (postId) body.postId = postId;

    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders('POST', `${anchorUrl}/api/messages/conversation`, bodyString, identity.privateKey, identity.publicKey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
        const res = await fetch(`${anchorUrl}/api/messages/conversation`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            const txt = await res.text();
            let errMsg = 'Failed to create conversation thread.';
            try { const json = JSON.parse(txt); if (json.error) errMsg = json.error; } catch (e) { if (txt) errMsg = refusalTextOf(res.status, txt, errMsg); }
            throw new Error(errMsg);
        }
        const data = await res.json();
        const conv = data.conversation;

        // The keys this phone asked for are the member's intent; the answer's are the node's word (Fable's security review
        // of the trio, finding 2). An answer naming any other key is refused and nothing is written: its rows were the first
        // send's first sight, so a node answering [me, PUPPET] to a request for [me, Ben] had the first line sealed to PUPPET.
        // Honest answers name exactly the keys asked for (the conversation made with them, or the one already between them).
        const asked = keySetOf(participants);
        const answered = Array.isArray(conv?.participants) && conv.participants.length > 0 ? keySetOf(conv.participants) : asked;
        if (answered.length !== asked.length || answered.some((k, i) => k !== asked[i])) {
            console.warn('[DM pins] the node answered a new DM with keys this phone did not ask for: refused, nothing written');
            throw new Error(t("This community answered with someone else for this chat, so it wasn't started."));
        }

        // Persist the conv + participants locally so the Inbox sees it
        // immediately, without waiting for the next syncMessages cycle.
        if (conv?.id) {
            // The answer goes into the file of the community asked, never another's: switched meanwhile, nothing is written.
            const copy = await here.handle();
            if (!copy) throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
            let postTitle: string | null = null;
            let postStatus: string | null = null;
            let postPhoto: string | null = null;
            let postPrice_c: number | null = null;
            // This phone asked for a DM: it is one, whatever type the answer names (the DM guard). In place (slice S2) it is
            // remembered as one in that community's own list, and nothing of the copy in use is asked.
            const convType = here.inPlace ? 'dm' : await heldConversationType(conv.id, type, undefined, false, copy);
            if (here.inPlace) {
                // Never over a group that community's copy holds keys of, or a row of another kind there (#3305 review F1):
                // nothing is written or remembered, as the held guard keeps a group a group when the phone is set there.
                if (!(await newDmFitsIn(copy, conv.id))) throw new Error(t("This community answered with someone else for this chat, so it wasn't started."));
                await rememberDmConversations([conv.id], copy);
            }
            if (conv.type && conv.type !== convType) console.warn(`[DM guard] the node answered a new DM as a ${conv.type}: ignored`);
            const pid = convType === 'dm' ? null : (conv.postId || conv.post_id || postId);
            const lookupPid = conv.postId || conv.post_id || postId;
            if (lookupPid) {
                const post = await copy.getFirstAsync<{ title: string, status: string, photos: string, price_c: number | null }>('SELECT title, status, photos, price_c FROM posts WHERE id = ?', [lookupPid]);
                if (post) {
                    postTitle = post.title;
                    postStatus = post.status;
                    postPrice_c = isHundredths(post.price_c) ? post.price_c : null;
                    if (post.photos) {
                        try {
                            const arr = JSON.parse(post.photos);
                            if (Array.isArray(arr) && arr.length > 0) postPhoto = JSON.stringify([arr[0]]);
                        } catch {}
                    }
                }
            }
            await copy.runAsync(
                'INSERT OR IGNORE INTO conversations (id, type, post_id, name, created_by, created_at, post_title, post_status, post_photo, post_price_c) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    conv.id,
                    convType,
                    pid || null,
                    conv.name || name || null,
                    conv.createdBy || createdBy,
                    conv.createdAt || new Date().toISOString(),
                    postTitle,
                    postStatus,
                    postPhoto,
                    postPrice_c
                ]
            );
            // The key asked for is pinned now: a listing that names another key before the first send only offers it, the
            // key-change banner, never a silent seal to the node's key. A pin kept already, or a rule-5 record, stands. It is
            // pinned checked when this phone holds no line of the chat (a brand-new chat: nothing for the history rule to judge,
            // and the member's own request is the evidence), so a line the node plants before the first send can't re-pin it
            // (confirmation 11, finding 1: one PUPPET line and a listing naming PUPPET made it rule 2, PUPPET checked, sealed
            // to silently). With lines held (an existing chat the node answered with), or a read that fails, it stays
            // unchecked and the history rule judges it at the first send.
            const others = participants.filter((k) => typeof k === 'string' && k.toLowerCase() !== identity.publicKey.toLowerCase());
            if (convType === 'dm' && others.length === 1) {
                const now = new Date().toISOString();
                const heldLine = await copy.getFirstAsync<any>('SELECT 1 AS y FROM messages WHERE conversation_id = ? LIMIT 1', [conv.id]).catch(() => ({ y: 1 }));
                await dmPins.update(identity.publicKey, copy, (pins) => pinAtFirstSight(pins, conv.id, others[0], now, undefined, !heldLine));
            }
            const partList: string[] = participants;
            for (const pub of partList) {
                await copy.runAsync(
                    'INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)',
                    [conv.id, pub]
                );
            }
        }

        return conv;
    } catch (e: any) {
        clearTimeout(timeoutId);
        throw new Error(e.message || 'Network request failed when creating thread.');
    }
}

export interface InviteCheck {
    valid: boolean;
    /**
     * `admins_only`: a ticket a member made, where only the community's admins bring people in (the door). The phone's
     * own two (inviteCheckMiss), never a node's: `invites_off`, the address takes no invites (the global community);
     * `not_a_community`, nothing at the address answers as a BeanPool community (the website, a name nobody runs).
     */
    reason?: 'invalid' | 'used' | 'expired' | 'unknown_inviter' | 'malformed' | 'admins_only' | 'invites_off' | 'not_a_community';
    inviterCallsign?: string | null;
    communityName?: string | null;
}

// Pre-flight invite validation (Step 1 of onboarding), so a dud code fails
// before the user has done the name/photo/seed ceremony. Returns null when the
// answer is unknown (node unreachable, or an older node without the endpoint) —
// callers must fail OPEN and let redeemInvite give the definitive answer later.
// An offline ticket goes with its `BP-`: the node reads a code as a ticket only by
// it (engine/members.ts checkInvite). The redeem is the one that sends it without.
/**
 * A check that found no invite step at the address, so nothing is made or sent there (9 Nov: a code typed with the
 * address beanpool.org, which the invite message names as where to install from, or with the global community's, went on
 * to a redeem that could only fail, in words about a node): the global community, whose invites are off (404
 * `feature_off`), or an address where nothing answers as a BeanPool community does (a 404 or 405 that is a web page, not a
 * node's JSON). Anything else (busy, down, no answer in time, a node's own JSON) is null, and the redeem decides, as before.
 */
export function inviteCheckMiss(status: number, body: string): InviteCheck | null {
    if (status !== 404 && status !== 405) return null;
    let answer: unknown = null;
    try {
        answer = JSON.parse(body);
    } catch {
        return { valid: false, reason: 'not_a_community' };
    }
    if (answer && typeof answer === 'object') {
        return (answer as { code?: unknown }).code === 'feature_off' ? { valid: false, reason: 'invites_off' } : null;
    }
    return { valid: false, reason: 'not_a_community' };
}

export async function checkInvite(code: string, nodeUrl: string): Promise<InviteCheck | null> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(`${nodeUrl}/api/invite/check?code=${encodeURIComponent(code)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });
            if (!res.ok) return inviteCheckMiss(res.status, await res.text().catch(() => ''));
            const data = await res.json();
            if (typeof data?.valid !== 'boolean') return null;
            return data;
        } finally {
            clearTimeout(timeoutId);
        }
    } catch {
        return null;
    }
}

/** What a redeem with no answer by its `timeoutMs` throws (redeemInvite). */
export const REDEEM_NO_ANSWER = 'No answer from the community node in time. Check your connection and try again.';

/**
 * Redeem an invite against the active node.
 *
 * `nodeHasPhoto` is the node's OWN answer about the picture it holds for us: `/api/invite/redeem`
 * and `redeem-offline` both return the existing member row for someone who was already registered
 * (`engine/invites.ts`), so the answer is already in the response and the caller needs no extra
 * request. It was the follow-up publish's guard against putting the phone's copy of a photo chosen
 * in another community over whatever newer photo the node actually had; that copy is no longer
 * published (Profile S2), so the publish no longer asks. It stays the node's answer for a reader
 * that wants it (the join's offer of the last photo, S3).
 *
 * A self-referential `/api/avatar/<pk>` value is the broken-row case and counts as NO photo —
 * the node cannot serve it, so there is nothing there worth protecting. A brand-new join is
 * likewise no photo: there is no row yet.
 *
 * `timeoutMs`: the redeem is stopped with REDEEM_NO_ANSWER when the node hasn't answered by then
 * (the join wizard's Next, whose ways off are closed while it waits). It may still have landed:
 * the node answers a retry by the same key `alreadyMember`, and the wizard asks it (invite-next.ts).
 */
export async function redeemInvite(
    code: string,
    callsign: string,
    identityToRegister?: any,
    options: { timeoutMs?: number } = {},
): Promise<{ success: true; alreadyMember: boolean; nodeHasPhoto: boolean }> {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url') || (__DEV__ ? 'https://127.0.0.1:8443' : '');

        const identity = identityToRegister || await loadIdentity();
        if (!identity) throw new Error('No identity to register');

        const isOfflineTicket = code.startsWith('BP-') && code.length > 20;
        const codePayload = code.startsWith('BP-') ? code.slice(3) : code;
        const body = isOfflineTicket 
            ? { ticketB64: codePayload, publicKey: identity.publicKey, callsign }
            : { code: codePayload, publicKey: identity.publicKey, callsign };
        const bodyString = JSON.stringify(body);
        const endpoint = isOfflineTicket ? '/api/invite/redeem-offline' : '/api/invite/redeem';
        const headers = await buildSignedHeaders('POST', `${anchorUrl}${endpoint}`, bodyString, identity.privateKey, identity.publicKey);

        const stop = new AbortController();
        const timer = options.timeoutMs ? setTimeout(() => stop.abort(), options.timeoutMs) : undefined;
        let res: Response;
        try {
            res = await fetch(`${anchorUrl}${endpoint}`, {
                method: 'POST',
                headers,
                body: bodyString,
                signal: stop.signal,
            });
        } catch (e) {
            if (stop.signal.aborted) throw new Error(REDEEM_NO_ANSWER);
            throw e;
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            let errorMsg = `Failed to redeem invite (HTTP ${res.status})`;
            // A 429 first: the network in front of the node is busy (Cloudflare's page matches "cloudflare" and "<html" below
            // and would read as "unreachable"). Say so in the one busy sentence. The node's own JSON 429 is not busy: its
            // `error` is read below from the text already taken.
            let textBody: string | null = null;
            if (isBusyStatus(res.status)) {
                textBody = await res.text().catch(() => '');
                if (isBusyAnswer(res.status, textBody)) throw busyError(res.headers?.get?.('Retry-After'));
            }
            if (res.status === 530 || res.status === 502 || res.status === 503 || res.status === 504) {
                errorMsg = `Relay Node Offline: The selected community node is currently unreachable (HTTP ${res.status}).`;
            } else {
                try {
                    const bodyText: string = textBody !== null ? textBody : await res.text();
                    try {
                        const errJson = JSON.parse(bodyText);
                        if (errJson.error) errorMsg = errJson.error;
                    } catch {
                        if (bodyText.toLowerCase().includes('cloudflare') || bodyText.toLowerCase().includes('<html')) {
                            errorMsg = `Relay Node Offline: The selected community node is currently unreachable.`;
                        } else {
                            errorMsg += `: [Text] ${bodyText.substring(0, 100)}`;
                        }
                    }
                } catch (e: any) {
                    errorMsg += ` - Parse Error: ${e.message}`;
                }
            }
            throw new Error(errorMsg);
        }

        // A 2xx is not a registration on its own: a captive portal, a proxy page or a node
        // answering { success: false } all arrive as 200. Only an explicit success counts,
        // otherwise the member is told they joined while the node never recorded them.
        let data: any = null;
        try {
            data = await res.json();
        } catch {}
        if (data?.success !== true) {
            throw new Error(data?.error || 'The community node did not confirm the invite. Please try again.');
        }
        const alreadyMember = !!data.alreadyMember;
        // `member` is the engine's Member row, whose avatar field is `avatarUrl`; `avatar` is
        // read too so an older node (or the profile shape) answers the same question.
        const memberAvatar = data.member?.avatarUrl ?? data.member?.avatar ?? null;
        const nodeHasPhoto = alreadyMember && isServableAvatarValue(memberAvatar);

        // A member here now, new or not: no longer a guest visit (nodes.ts markGuestNode). Every invite join passes here,
        // and not every screen that calls this clears the mark itself; while it stands, the next sync sends this community
        // none of the phone's blocks (blocklist.ts). Each spelling the sync reads; never fails the join.
        try {
            const plain = anchorUrl.replace(/\/+$/, '');
            for (const url of new Set([anchorUrl, plain, `${plain}/`])) await clearGuestNode(url);
        } catch (e) {
            console.warn('[DB] Could not clear the guest mark for this community', e);
        }

        if (alreadyMember) {
            console.log('[DB] ℹ️ User is already a registered member of this community.');
        } else {
            console.log('[DB] ✅ Invite redeemed successfully!');
        }
        // A member here now: the phone's blocks go here at the join (blocklist.ts blocksAtJoin; S7 design §2.2), not at the
        // next round, nor an hour after this community last said the account was no member. A new member here keeps no block
        // list here yet, whatever the phone once sent to this address (a node set up again there). Not waited for; never
        // fails the join.
        try {
            const { blocksAtJoin } = await import('./blocklist');
            void blocksAtJoin(identity.publicKey, anchorUrl, !alreadyMember);
        } catch (e) {
            console.warn('[DB] Could not send the block list to the community just joined', e);
        }
        return { success: true, alreadyMember, nodeHasPhoto };
    } catch (e: any) {
        console.warn('[DB] Failed to redeem invite:', e.message);
        throw e;
    }
}

// ==========================================
// MARKETPLACE TRANSACTION AND RATING HELPERS
// ==========================================

// Push the user's locally-stored profile (callsign + avatar + bio + contact)
// to the anchor node. Returns true if the server accepted the update.
// Used both as a one-shot heal when marketplace actions fail with the
// "Please set a profile photo" error, and by pillar-sync's retry loop.
// Publish the user's profile (callsign + avatar + bio + contact) to the ACTIVE
// node. Used three ways: the marketplace "please set a profile photo" auto-heal,
// pillar-sync's offline-edit retry loop, and a proactive push right after joining
// a new node.
//
// It publishes the change waiting for the ACTIVE community (pending-profile-sync.ts) and no other:
// that community's own row, with the name and photo its entry keeps over the row's. The retry
// passes `community`, the community its sync cycle is for, and publishes nothing if the phone has
// moved on since: one community's change and row never reach another. A name the community refuses
// for good leaves the change (pendingNameRefused), and the rest goes again at once without a name.
//
// The avatar is resolved in two steps: a photo picked during an OFFLINE save, parked in this
// community's entry by the screen that could not publish it, always goes — it has
// reached nothing yet, so it is the newest copy anywhere. Otherwise `catchUpAvatar` decides, from
// this community's own row alone: a portable photo still sitting there goes, anything else sends
// nothing. The phone's copy of the last photo chosen in ANY community is not a source (Profile S2): a
// freshly-joined second community, whose row exists from registration but holds no photo, used to
// be given the picture the member chose in the first — a preset included — and showed it as theirs.
// A photo reaches a community when it is chosen there.
//
// The parked pick exists because the local row is NOT a durable place to keep it: both
// full-directory writers replace it with the node's own URL, and a single members sync landing
// before this retry succeeds used to turn the pick into "the node has a photo, say nothing"
// — the member's chosen photo then never reached the node and nothing ever resent it.
export async function pushProfileToServer(opts?: { community?: string }): Promise<boolean> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    const identity = await loadIdentity();
    if (!anchorUrl || !identity) return false;
    if (opts?.community !== undefined && plainOriginOf(opts.community) !== plainOriginOf(anchorUrl)) return false;
    // What waits for this community, read once: the publish is built from it, and only it is retired.
    const pending = await pendingProfileChange(anchorUrl, identity.publicKey);
    const profile = await getMemberProfile(identity.publicKey);
    // The row comes from the copy open when it was read (getDb follows a switch): with the phone moved on, it may be
    // another community's, and none of it goes to this one (#2461 review).
    if (!(await stillOnCommunity(anchorUrl))) return false;

    // Since #725 the members sync writes the node's own `/api/avatar/<pk>?size=thumb` string
    // into the local row, and `profile?.avatar_url` happily offered that — so this function
    // published the node's URL back to the node as the member's avatar, and from then on
    // `GET /api/avatar/<pk>` 404d: the photo was destroyed. The rule below only takes a portable value.
    // Through the one shared rule, which every publish path uses: a pick the offline branch of
    // settings Save / Re-run Setup parked for THIS community first (re-checked for portability,
    // since anything that is not a `data:`/`bundled://` value is not ours to publish), otherwise
    // a portable photo still sitting in this community's row (an offline pick). There is no session pick on this
    // path — it runs with no screen in front of it. The parked copy, and the change it waits in, retire only
    // after a verified 2xx: every `return false` below leaves them for the next retry.
    // A copy the member asked for from another community (Profile S4) is all that waits here: it sends the name and the photo
    // kept for it and nothing of this community's row, whose bio and contact may be older than the community's own.
    const copyOnly = pending?.chosenOnly === true;
    const decision = await resolveProfilePublishAvatar({
        parked: pending?.avatar,
        ...(copyOnly ? {} : { catchUp: { localRow: profile?.avatar_url } }),
    });
    const avatar = decision.avatar;

    // A name changed here and not yet accepted wins over the row's: a members sync landing first writes the name the
    // node still holds over the row. Once the community has refused the waiting name for good, no name goes (the row
    // may still hold the refused one), and the community keeps the name it holds (#2461 review r4368601839).
    // A copy that carries no name leaves the community's name as it is.
    const callsign = copyOnly
        ? pending?.callsign
        : pending?.callsign || (pending?.refusedCallsign !== undefined ? undefined : profile?.callsign || identity.callsign);
    // Profile S2-W: bio and contact belong to this community alone; no fallback to phone-wide canonical across communities.
    const bio = copyOnly ? '' : profile?.bio ?? '';
    const contactValue = copyOnly ? null : profile?.contact_value ?? null;
    const contactVisibility = copyOnly ? undefined : profile?.contact_visibility ?? undefined;
    // What waits for this community, or a device copy newer than its row: never its own row sent back, and never to a
    // community that doesn't say this key is a member (utils/working-style.ts). A copy sends none.
    const publicArchetype = copyOnly ? null : await archetypeToSend(anchorUrl, identity, profile?.archetype);

    // The bail-out used to be `if (!avatar)`, from when a picture was the only thing this
    // published. It now carries bio, contact and archetype too, so keying it on the avatar
    // dropped a quiz result on the floor for anyone who hadn't uploaded a photo — and cleared
    // the pending flag on the way out, so it never retried. Only give up when there is
    // genuinely nothing anywhere to publish. A new name waiting here is something to publish.
    if (!avatar && !bio && !contactValue && !publicArchetype && !pending?.callsign) {
        // Safe to drop this community's change here, parked value and all, and the only place it
        // is dropped unsent: `avatar` being null means the rule found nothing publishable, so
        // anything still parked is a value that is not portable and can never be published — a
        // portable pick would have been chosen above and kept this code out of this branch.
        await clearPendingProfileChange(anchorUrl, pending);
        return false;
    }

    // ADDITIVE ONLY. The server reads `update.avatar !== undefined ? update.avatar : existing`
    // (engine/members.ts), so a field sent as null or '' CLEARS it. This is the catch-up sync
    // path, not the explicit-edit path — settings.tsx sends its own payload when the user
    // actually edits something — so it must never clear a field it merely doesn't have locally.
    // That mattered less when the function bailed unless an avatar existed; now that a quiz
    // result alone can bring us here, sending `avatar: null` would wipe the picture off the node.
    const payloadObj: any = {
        publicKey: identity.publicKey,
    };
    if (callsign !== undefined) payloadObj.callsign = callsign;
    if (avatar) payloadObj.avatar = avatar;
    if (bio) payloadObj.bio = bio;
    if (contactValue) payloadObj.contact = { value: contactValue, visibility: contactVisibility ?? 'community' };
    if (publicArchetype) payloadObj.archetype = publicArchetype;
    const bodyString = JSON.stringify(payloadObj);
    const headers = await buildSignedHeaders('POST', `${anchorUrl}/api/profile/update`, bodyString, identity.privateKey, identity.publicKey);
    try {
        const res = await fetch(`${anchorUrl}/api/profile/update`, {
            method: 'POST',
            headers,
            body: bodyString,
        });
        if (!res.ok) {
            // The name refused for good (someone else's there, or too short) would be refused at every sync, and the
            // photo and bio with it never arrive: it leaves the change, the member is told once in Settings, in the
            // community's words, and the rest goes again now without a name. Any other answer waits for the next sync.
            if (pending && callsign !== undefined) {
                const answer = await res.json().catch(() => null);
                const said = { status: res.status, message: typeof answer?.message === 'string' ? answer.message : null };
                if (nameRefusedForGood(res.status, answer?.error) && await pendingNameRefused(anchorUrl, pending, callsign, said)) {
                    return await pushProfileToServer(opts);
                }
            }
            return false;
        }
        // A 200 alone isn't proof the avatar took: if we sent one but the node
        // echoed none back, the write didn't land — keep the pending flag and
        // retry rather than silently giving up (this previously stranded pics).
        let avatarPersisted = true;
        // The name the node answers it holds: the row takes it when this publish sent none.
        let heldName: string | undefined;
        try {
            const data = await res.json();
            const savedAvatar = data?.profile?.avatar || null;
            if (avatar && !savedAvatar) avatarPersisted = false;
            if (typeof data?.profile?.callsign === 'string') heldName = data.profile.callsign;
        } catch { /* non-JSON body — trust the 2xx */ }
        if (!avatarPersisted) return false;
        const rowCallsign = callsign ?? heldName;

        // This function IS the pending-sync retry and has just published everything this
        // community's change holds (its parked pick is always chosen above when portable), so the
        // change retires — otherwise an offline BIO-ONLY edit would re-publish on every sync for
        // ever. Only here, and only if it is still the one this payload was built from: every
        // `return false` above leaves it for the next retry, and a change kept while this was out
        // waits for the next.
        await clearPendingProfileChange(anchorUrl, pending);
        if (publicArchetype) await clearWaitingArchetype(anchorUrl, publicArchetype);
        // The local mirror writes the copy open now (getDb): after a switch while the update was out, that is another
        // community's, and this one's profile stays out of it. This community's next members sync brings it home.
        if (!(await stillOnCommunity(anchorUrl))) return true;
        // Mirror what was just published into THIS node's local DB when it was
        // missing, so local reads and the marketplace pre-check see it at once. A copied photo goes in over the one the row
        // holds (a node's own URL for the photo that was here): it is the member's new photo here.
        if (!profile?.avatar_url || publicArchetype || (copyOnly && avatar)) {
            try {
                await updateMemberProfile(identity.publicKey, {
                    callsign: rowCallsign ?? profile?.callsign ?? identity.callsign,
                    avatar_url: avatar || undefined,
                    bio: bio || undefined,
                    contact_value: contactValue || undefined,
                    contact_visibility: contactVisibility,
                    archetype: publicArchetype || undefined,
                });
            } catch { /* local mirror is best-effort */ }
        } else if (rowCallsign !== undefined && rowCallsign !== profile?.callsign) {
            // A name it has just taken (the one waiting here) goes into the row as well, and only the name: until the
            // next members sync the row still holds the old one, which the screens show and a later retry here falls
            // back on (#2461 review). With none sent, the name it holds replaces a refused one there.
            try {
                await updateMemberProfile(identity.publicKey, { callsign: rowCallsign });
            } catch { /* local mirror is best-effort */ }
        }
        return true;
    } catch {}
    return false;
}

/**
 * The working style waiting for `community`, sent at its own sync and nothing else with it: no name, bio, contact or
 * photo. The phone's copy of those can be older than the node's (a bio changed on the web), and a quiz taken in another
 * community is no reason to send them back. Only while the phone is on `community`, and only as archetypeToSend allows.
 * What waits stays for the next sync unless the community took it. Answers whether it did.
 */
export async function pushWaitingArchetype(opts: { community: string }): Promise<boolean> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    const identity = await loadIdentity();
    if (!anchorUrl || !identity || plainOriginOf(opts.community) !== plainOriginOf(anchorUrl)) return false;
    const removal = await waitingRemoval(anchorUrl, identity.publicKey);
    if (!removal && !(await waitingArchetype(anchorUrl, identity.publicKey))) return false;
    const row = await getMemberProfile(identity.publicKey);
    if (!(await stillOnCommunity(anchorUrl))) return false;
    if (removal) {
        // Remove my working style: this community's turn to hear it, as a null, where it holds a result (working-style.ts).
        if (!(await removalToSend(anchorUrl, identity)) || !(await stillOnCommunity(anchorUrl))) return false;
        const removeBody = JSON.stringify({ publicKey: identity.publicKey, archetype: null });
        const removeHeaders = await buildSignedHeaders('POST', `${anchorUrl}/api/profile/update`, removeBody, identity.privateKey, identity.publicKey);
        try {
            const res = await fetch(`${anchorUrl}/api/profile/update`, { method: 'POST', headers: removeHeaders, body: removeBody });
            if (!res.ok) return false;
        } catch {
            return false;
        }
        // The null is in. The row here goes before the removal stops waiting: a row left holding the result, with no removal
        // to judge it against, is what the next start adopts and carries to every other community. A copy that won't
        // clear keeps the removal waiting (the next turn finds the node holding none and tries again).
        await finishRemoval(anchorUrl, identity.publicKey, removal.removedOn);
        return true;
    }
    const archetype = await archetypeToSend(anchorUrl, identity, row?.archetype);
    if (!archetype) return false;
    const bodyString = JSON.stringify({ publicKey: identity.publicKey, archetype });
    const headers = await buildSignedHeaders('POST', `${anchorUrl}/api/profile/update`, bodyString, identity.privateKey, identity.publicKey);
    try {
        const res = await fetch(`${anchorUrl}/api/profile/update`, { method: 'POST', headers, body: bodyString });
        if (!res.ok) return false;
    } catch {
        return false;
    }
    await clearWaitingArchetype(anchorUrl, archetype);
    // Into this community's row at once, as pushProfileToServer does; after a switch, its next members sync brings it home.
    if (row?.callsign && (await stillOnCommunity(anchorUrl))) {
        await updateMemberProfile(identity.publicKey, { callsign: row.callsign, archetype }).catch(() => {});
    }
    return true;
}

/** Whether the phone is still on `community`: the copy getDb opens is that community's (pillar-sync's mid-sync check). */
async function stillOnCommunity(community: string): Promise<boolean> {
    return getDatabaseFilenameForNode(await AsyncStorage.getItem('beanpool_anchor_url')) === getDatabaseFilenameForNode(community);
}

function _isProfilePhotoError(msg: string): boolean {
    return typeof msg === 'string' && /set a profile photo/i.test(msg);
}

/**
 * A signed POST to the community the phone is on, or to `to` (a chat request's own community, chatCopyForRequest), so the
 * answer belongs to the file it is written into. Null `to`: no community, off-grid as before.
 */
async function _signedRequest(endpoint: string, payload: any, to?: string | null | ReadableTo) {
    const readable = to !== null && typeof to === 'object' ? to : null;
    const anchorUrl = to === undefined ? await AsyncStorage.getItem('beanpool_anchor_url') : readable ? readable.address : to as string | null;
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node to perform this action.');

    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found. You must be logged in.');
    // A deal's step is its own member's: never signed by another account that is on the phone by now.
    if (readable?.signer && readable.signer !== identity.publicKey) throw new Error(OTHER_ACCOUNT_SINCE_CHAT_OPENED_TEXT);

    const bodyString = JSON.stringify(payload);
    // The language this phone writes in, so the node can answer in it (utils/language-choice.ts; not signed, not stored).
    const headers = { ...await buildSignedHeaders('POST', `${anchorUrl}${endpoint}`, bodyString, identity.privateKey, identity.publicKey), ...languageHeader() };

    // A readable chat line's last ask, and a deal's step's: nothing is awaited between it and the request (its file first).
    await readable?.lastLook?.();
    readable?.leaving();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    let res;
    try {
        res = await fetch(`${anchorUrl}${endpoint}`, {
            method: 'POST',
            headers,
            body: bodyString,
            signal: controller.signal
        });
    } catch (e: any) {
        clearTimeout(timeoutId);
        throw new Error(e.message || 'Network request failed. You must be connected to a node.');
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
        let errorMsg = `Server returned ${res.status}`;
        // Whether the body carried a JSON `error` field, which is what tells a node ANSWERING from a node
        // that has no such route to answer with — see utils/chat-actions.chatActionErrorMessage.
        let nodeAnswered = false;
        // The node's sentence for the member, when its body has one beside the code (`{ error: 'not_found', message:
        // 'That post is not here any more.' }`). Carried as `nodeMessage`, not put in `message`: callers match on the
        // code in `message` (chatActionErrorMessage's old-node refusals, the profile-photo heal below), so a caller whose
        // error the member reads puts it there itself (reportAbuse).
        let nodeMessage: string | undefined;
        // The node's code beside its sentence (`shop_paused`: an Offer in a shop closed for now), so a screen can say why.
        let nodeCode: string | undefined;
        // How many are left now, beside `units_changed` (a take-up landed while the seller edited, §2.5).
        let nodeUnitsLeft: number | undefined;
        // What the body was, for telling a busy network's answer from the node's own: the JSON when it parsed, else its text.
        let errBody: unknown;
        let errText = '';
        try {
            const errJson = await res.json();
            errBody = errJson;
            // This key was replaced by a re-key: the old phone's offer of its old words (utils/key-replaced.ts).
            if (isKeyReplacedAnswer(res.status, errJson)) void noteKeyReplaced(anchorUrl, identity.publicKey);
            if (errJson.error) { errorMsg = errJson.error; nodeAnswered = true; }
            if (typeof errJson.message === 'string' && errJson.message.trim()) nodeMessage = errJson.message.trim();
            if (typeof errJson.code === 'string') nodeCode = errJson.code;
            if (typeof errJson.unitsLeft === 'number') nodeUnitsLeft = errJson.unitsLeft;
        } catch {
            try {
                const txt = await res.text();
                if (txt) errText = txt;
            } catch {}
        }
        // The network in front of the node is too busy (a 429 that is not the node's own JSON, such as Cloudflare's page):
        // one sentence, never its page, never "offline", never a sign-out or a key note (core busy-answer.ts). A write is
        // never sent again by itself: it may be the member's second tap that lands twice.
        if (isBusyAnswer(res.status, errBody ?? errText)) throw busyError(res.headers?.get?.('Retry-After'));
        // A proxy's page on any other status is not words: the generic `Server returned N` stands.
        if (errText) errorMsg = refusalTextOf(res.status, errText, errorMsg);
        // Auto-heal stale server profile: if the user has a local avatar but the
        // server doesn't know about it (common for users whose initial onboarding
        // publish failed), push the profile and retry the request once.
        // Only of the community in use: another community's refusal (a chat in place) asks the one in use nothing.
        if ((to === undefined || await stillOnCommunity(anchorUrl)) && _isProfilePhotoError(errorMsg)) {
            // The node itself just said it holds no photo for us. Whatever this community holds that never reached
            // it (a pick made here while offline) goes now; a photo chosen in another community does not (Profile S2),
            // so a member with none here is asked for one, as the node's words say.
            const healed = await pushProfileToServer();
            if (healed) {
                const retryHeaders = { ...await buildSignedHeaders('POST', `${anchorUrl}${endpoint}`, bodyString, identity.privateKey, identity.publicKey), ...languageHeader() };
                await readable?.lastLook?.();
                readable?.leaving();
                const retryRes = await fetch(`${anchorUrl}${endpoint}`, {
                    method: 'POST',
                    headers: retryHeaders,
                    body: bodyString,
                });
                if (retryRes.ok) return await retryRes.json();
            }
        }
        // The status and whether the node answered in its own words both ride along on the error: only a
        // missing route (404 with no `error` field) means "an older node has never heard of this verb", and
        // the chat shows the node's own sentence for everything else (utils/chat-actions.chatActionErrorMessage).
        const err: any = new Error(errorMsg);
        err.status = res.status;
        err.nodeAnswered = nodeAnswered;
        err.nodeMessage = nodeMessage;
        if (nodeCode) err.code = nodeCode;
        if (nodeUnitsLeft !== undefined) err.unitsLeft = nodeUnitsLeft;
        throw err;
    }

    // The node took a write this key signed: the key is current here, so a replaced-key note goes (finding 5 of #1844).
    void noteKeyAnswered(anchorUrl, identity.publicKey);
    return await res.json();
}

// Public wrapper around _signedRequest for use by other modules in the app
// (e.g. push-notifications, settings prefs). Keeps signing centralized: any
// new client callsite that hits a signature-protected endpoint must come
// through here.
export async function signedRequest(endpoint: string, payload: any) {
    return _signedRequest(endpoint, payload);
}

/** The message requests waiting for the member in the community the phone is on, as its node last listed them. */
export async function getMessageRequests(myPubkey: string): Promise<{ count: number; conversations: any[] } | null> {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return null;
        const file = getDatabaseFilenameForNode(anchorUrl);
        const raw = await AsyncStorage.getItem(messageRequestsStoreKey(myPubkey, file));
        const kept = raw ? JSON.parse(raw) : null;
        if (!kept || !Array.isArray(kept.conversations) || kept.conversations.length === 0) return kept;
        // A filter that fails hides no card: the list stays as the node gave it, as before S7b.
        return await withoutBlockedRequests(myPubkey, file, kept).catch((e) => {
            console.warn('[Requests] The block lists could not be read; no request card is hidden', e);
            return kept;
        });
    } catch {
        return null;
    }
}

/** No blocks known: what lists that can't be read hide (no card), as before slice S7b. */
const NO_BLOCK_LISTS: BlockLists = Object.freeze({ onPhone: new Set<string>(), once: new Set<string>(), seenThere: new Set<string>() });

/**
 * The requests kept for the community in use (`file`) less each whose opener is blocked anywhere (slice S7b, S7 design
 * §2.4 rule 4: blocklist.ts blockedAnywhere, a block made in the web app or on another device included), by any key the
 * person is known by in that copy: the listing's people and opener, the copy's own participant rows for the chat, and its
 * pin (dm-blocked.ts dmPeerKeys, as requestsInPlace judges a card in place). The server stops listing them once it holds the
 * block; this covers the minutes before. Their card and line preview never show, and `count` leaves them out. Nothing is
 * read from the copy while nobody is blocked anywhere; lists that can't be read hide nothing.
 */
async function withoutBlockedRequests(me: string, file: string, kept: { count: number; conversations: any[] }): Promise<{ count: number; conversations: any[] }> {
    const { blockedAnywhere, readBlockLists } = await import('./blocklist');
    const lists = await readBlockLists(me);
    if (!lists || (lists.onPhone.size === 0 && lists.seenThere.size === 0)) return kept;
    const database = await getDb();
    const pins = await dmPins.peek(me, file).catch(() => null);
    const shown: any[] = [];
    for (const c of kept.conversations) {
        const held = await database.getFirstAsync<{ otherKeys: string | null }>(`SELECT ${otherKeysSql('?')} AS otherKeys`, [String(c?.id ?? ''), me]).catch(() => null);
        const listed = [...(Array.isArray(c?.participants) ? c.participants : []), c?.request?.from].filter((k): k is string => typeof k === 'string' && k !== me);
        const keys = dmPeerKeys([...listed, ...(held?.otherKeys ? held.otherKeys.split(',') : [])], pins ? dmPinFor(pins, String(c?.id ?? '')) : null);
        if (!blockedAnywhere(lists, keys)) shown.push(c);
    }
    if (shown.length === kept.conversations.length) return kept;
    const hidden = kept.conversations.length - shown.length;
    return { ...kept, count: Math.max(shown.length, (Number.isSafeInteger(kept.count) ? kept.count : kept.conversations.length) - hidden), conversations: shown };
}

/** The message requests one community's node listed for the member, kept for that community (`file`) alone. */
export async function saveMessageRequests(myPubkey: string, file: string, requests: { count: number; conversations: any[] } | null): Promise<void> {
    try {
        if (requests) {
            await AsyncStorage.setItem(messageRequestsStoreKey(myPubkey, file), JSON.stringify(requests));
        } else {
            await AsyncStorage.removeItem(messageRequestsStoreKey(myPubkey, file));
        }
    } catch {}
}

/**
 * Accept, Ignore or Cancel request on the node. Its answer (200) is the request as the member now reads it, and it goes
 * into this phone's row before this returns (requestDecided): the chat opened next, as after Accept on a Requests card,
 * reads the decided request, and so does every reread of the row after it (PR #2540 review 4395706539). `quietSince`: let in
 * once's quiet accept (slice S3b), from a list read when that many decisions had been taken here; refused
 * (isAnsweredByMember) when the member answered the request since, or is answering it now.
 */
export async function decideMessageRequest(conversationId: string, decision: 'accept' | 'ignore' | 'cancel', community?: ChatCommunity, quietSince?: number): Promise<{ success: boolean; request?: any }> {
    // A tap: the member's own answer is on its way from now, before any await (memberAnsweredSince). Let in once's quiet
    // accept (`quietSince`) is not counted.
    const tapped = quietSince === undefined;
    if (tapped) answeringRequest(conversationId, 1);
    try {
        // In place, only a direct chat that community's copy holds (#3305 review F1).
        const here = await onlyDmInPlace(await chatCopyForRequest(community), conversationId);
        // Let in once (slice S3b): never over an answer of the member's taken since its list was read (`quietSince`
        // decisions then), or on its way (#3319 review F2). Asked after every await on the way here, as the POST is made
        // (only its signing comes between).
        if (!tapped && memberAnsweredSince(conversationId, here.file, quietSince)) throw new AnsweredByMemberError();
        const answer = await _signedRequest('/api/messages/request', { conversationId, decision }, here.anchorUrl);
        await requestDecided(here, conversationId, answer?.request);
        return answer;
    } finally {
        if (tapped) answeringRequest(conversationId, -1);
    }
}

/**
 * The message requests waiting for this member in `community`, another community this phone holds (slice S3,
 * scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Message requests", §6 S3): its "In {community}" cards act
 * there in place, with no switch.
 * - Asked of that community's own server (its saved address, signed for its name) through the chat request copy in place
 *   (chatCopyForRequest): the same list its own sync reads when the phone is set there, which only the member can read.
 *   One read per open of the requests and per decision; at 500 chats there it is the one answer the phone's round asks
 *   of the community in use every 120 s.
 * - Each listed request for this member that is a direct chat (the node types it `dm`, two people, the member one of them,
 *   the other its opener) is written into THAT community's copy as a DM row with its request and its people, as the poll
 *   writes a request when the phone is set there (`conv.type || 'dm'`), and never over a group whose keys that copy holds
 *   or a row of another kind (newDmFitsIn, #3305 review F1). A link can't reach this: only that server's list of the
 *   member's own requests. From then on S2's path (the preview's poll, the chat in place, Accept, Decline, Report) holds it.
 * - Never a request whose opener is blocked anywhere (blocklist.ts blockedAnywhere, slice S7b: on this phone's list, or on
 *   any community's own list as the phone last read it, a block made in the web app or on another device included), by any
 *   key the person is known by there (the listing's people, that copy's own participant rows for the chat and its pin, as
 *   Chat's list, the held rows and the chat screen judge a DM: dm-blocked.ts talkShowsChat; the block list names every key
 *   of a re-keyed person): no card, no line read, nothing written (#3309 review F1, N1). `count` leaves those out.
 * - That copy's DM pins are read first, through the handle the rows are written with (§3.4 amendment 5: every writer reads
 *   the pins first), and a pinned DM's people are [me, the pinned key], as writeConversationFromNode writes them. Pins
 *   unread: nothing is written, and null.
 * - The list is kept for that community's file alone (saveMessageRequests), where the phone set there reads it, as its
 *   server listed it (its addresses are that server's own paths).
 * - What comes back is for a card drawn while the phone is set elsewhere: each address a listing carries
 *   (listed-address-fields.ts) is made whole on `community`, never left as a path the community in use would be
 *   asked for (a member's photo carries their key and that community's face key: #3309 review F2).
 * - Only what that copy now holds comes back, and is kept: a listed request it would not write (group keys under its id, a
 *   row of another kind) is no card, and `count` leaves it out too (#3309 review N3): its Accept could only say the switch
 *   sentence, and its group would hide the card that moves the phone there.
 * - Written after the answer only through `here.handle()`: a switch, a removal, the account leaving or a close while the
 *   list was on its way writes nothing anywhere (that copy's next read brings it).
 * - The account that asked, still the phone's, with no copy cleared or removed since (ownListRead), before the first write
 *   and again before the list is kept and handed back: else nothing is written, kept or shown (#3309 review N2, P3).
 * - A deadline (REQUESTS_IN_PLACE_DEADLINE_MS, as the chat's poll), on the answer and its body: a community that never
 *   answers is no answer, and holds back no other community's cards (#3309 review N2, P4).
 * Null: no copy in place to read (the community in use, one not saved, a guest's look, a copy not on the phone), no
 * answer in time, that copy's pins unread, or the account or the copies changed; the card then moves the phone there, as
 * in S0.
 */
export async function requestsInPlace(myPubkey: string, community: ChatCommunity): Promise<{ count: number; conversations: any[] } | null> {
    if (!myPubkey || !community) return null;
    let here: ChatRequestCopy;
    try {
        here = await chatCopyForRequest(community);
    } catch {
        return null;
    }
    if (!here.inPlace || !here.anchorUrl) return null;
    const asked = ownListRead(myPubkey);
    // The member's answers taken here as the list is asked: let in once never goes over one taken since (#3319 review F2).
    const decidedBefore = _requestDecisions;
    let data: any;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), requestsInPlaceDeadlineMs);
    try {
        // Ended by the deadline even where a fetch doesn't give up on its abort.
        const res = await untilAborted(signedGet(`/api/messages/conversations/${myPubkey}`, { anchorUrl: here.anchorUrl, signal: deadline.signal }), deadline.signal);
        if (!res.ok) return null;
        data = await untilAborted(res.json(), deadline.signal);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
    const listed = data?.requests;
    const direct: any[] | null = listed && typeof listed === 'object' && Array.isArray(listed.conversations)
        ? listed.conversations.filter((c: any) => isDirectRequestFor(c, myPubkey))
        : null;
    // The account's blocks, here and as each community's own list was last read (S7b), read before the copy is taken, with
    // this community's own list read once in this run first when a request waits (S7 design §2.4: a block made there in the
    // web app hides its card from the first read). A read that fails, or lists that can't be read, hide no card, as before:
    // let in once reads them again, and lets nobody in on a guess.
    const { blockedAnywhere, blockListReadThisRun, readBlockLists } = await import('./blocklist');
    if (direct && direct.length > 0) await blockListReadThisRun(myPubkey, here.anchorUrl);
    const lists = (await readBlockLists(myPubkey)) ?? NO_BLOCK_LISTS;
    const database = await here.handle();
    if (!database) return null;
    // That copy's DM pins first, through this handle (§3.4 amendment 5): unread, nothing is written into a DM there.
    let pins: DmPeerPins;
    try {
        pins = await dmPins.read(myPubkey, database);
    } catch {
        return null;
    }
    // Every key the person is known by in that copy: the listing's, the copy's own rows for the chat, its pin (N1).
    const people = await requestPeople(database, direct ?? [], myPubkey, pins);
    if (!people) return null;
    const kept = (direct ?? []).filter((c) => !blockedAnywhere(lists, people.get(c.id) ?? []));
    // Before the first write: the account that asked is still the phone's (N2).
    if (!(await asked.still())) return null;
    const admitted: any[] = [];
    for (const conv of kept) {
        try {
            if (await admitRequestInto(database, conv, myPubkey, pins)) admitted.push(conv);
        } catch (e: any) {
            console.warn(`[Requests] Could not keep a request in place: ${e?.message || e}`);
        }
    }
    // Let in once (slice S3b): one from someone the member let in is accepted there now, as a tap would, and shows no card.
    const quiet = await quietlyLetIn(myPubkey, admitted, people, community, asked, decidedBefore);
    const waiting = admitted.filter((c) => !quiet.has(c.id));
    const requests = direct
        ? {
            // The node's count, less each listed one left out here (not a direct chat for the member, blocked, or not
            // written into that copy) and each accepted quietly.
            count: Math.max(waiting.length, (Number.isSafeInteger(listed.count) && listed.count >= 0 ? listed.count : listed.conversations.length) - (listed.conversations.length - admitted.length) - quiet.size),
            conversations: waiting,
        }
        : null;
    // Kept and handed back only for the account that asked (N2): never put back after it left the phone.
    if (!(await asked.still())) return null;
    await saveMessageRequests(myPubkey, here.file, requests);
    return requests && { count: requests.count, conversations: waiting.map((c) => listedOnCommunity(here.anchorUrl!, c)) };
}

/**
 * Every key the opener of each listed direct request is known by in `database`'s copy: the listing's people, that copy's own
 * participant rows for the chat, and its pin (#3309 review N1). Null when the copy can't be read.
 */
async function requestPeople(database: SQLite.SQLiteDatabase, requests: readonly any[], me: string, pins: DmPeerPins): Promise<Map<string, string[]> | null> {
    const out = new Map<string, string[]>();
    for (const c of requests) {
        const held = await database.getFirstAsync<{ otherKeys: string | null }>(`SELECT ${otherKeysSql('?')} AS otherKeys`, [c.id, me]).catch(() => null);
        if (!held) return null;
        const keys = [...c.participants.filter((p: string) => p !== me), ...(held.otherKeys ? held.otherKeys.split(',') : [])];
        out.set(c.id, dmPeerKeys(keys, dmPinFor(pins, c.id)));
    }
    return out;
}

/**
 * Let in once (slice S3b, utils/let-in.ts): each of `requests` (direct requests for `me`, listed by `community`'s own server)
 * whose opener the member let in, and whom no key they are known by (`people`) was ever blocked on this phone, is accepted by
 * exactly the signed POST /api/messages/request {accept} a tap on its card sends (decideMessageRequest), to `community` (the
 * one the list was read from: #3319 review F3), while `asked` is still the account on the phone, and never over an answer the
 * member gave it on this phone since the list was read, when `decidedBefore` decisions had been taken, or one on its way
 * (F2). The ids accepted; none when anything on the way fails (each is then an ordinary card).
 */
async function quietlyLetIn(me: string, requests: readonly any[], people: ReadonlyMap<string, string[]>, community: ChatCommunity, asked: OwnListRead, decidedBefore: number): Promise<Set<string>> {
    // Block first (slice S7b): `community`'s own block list is read in this run before any accept there.
    if (requests.length === 0 || typeof community !== 'string' || !community) return new Set();
    try {
        const { acceptLetIn } = await import('./let-in');
        return await acceptLetIn(me, community, requests.map((c) => ({ id: String(c.id), from: String(c.request?.from ?? ''), keys: people.get(c.id) ?? [] })),
            (id) => decideMessageRequest(id, 'accept', community, decidedBefore), asked.still);
    } catch (e) {
        console.warn('[LetIn] No request was accepted quietly', e);
        return new Set();
    }
}

/** The list read in place's deadline, on its answer and the answer's body (requestsInPlace): as the chat's poll, 12 s. */
const REQUESTS_IN_PLACE_DEADLINE_MS = 12_000;
let requestsInPlaceDeadlineMs = REQUESTS_IN_PLACE_DEADLINE_MS;
/** For tests: the deadline, shortened (null: back to 12 s). */
export function _setRequestsInPlaceDeadlineForTests(ms: number | null): void {
    requestsInPlaceDeadlineMs = ms ?? REQUESTS_IN_PLACE_DEADLINE_MS;
}

/** `work`, or a throw once `signal` aborts: a fetch or a body read that never ends is ended by the deadline it was asked under. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        work.catch(() => {});
        return Promise.reject(new Error('timed out'));
    }
    return new Promise<T>((resolve, reject) => {
        const stop = () => reject(new Error('timed out'));
        signal.addEventListener('abort', stop, { once: true });
        work.then(
            (v) => { signal.removeEventListener('abort', stop); resolve(v); },
            (e) => { signal.removeEventListener('abort', stop); reject(e); },
        );
    });
}

/** `conv` as `community`'s server listed it, each of its addresses (listed-address-fields.ts) on that server ({@link onCommunity}). */
function listedOnCommunity(community: string, conv: any): any {
    const out = { ...conv };
    for (const field of LISTED_ADDRESS_FIELDS) if (field in out) out[field] = onCommunity(community, out[field]);
    return out;
}

/** A listed request that is a direct chat for `me`: the node types it `dm`, two people, `me` one, the other its opener. */
function isDirectRequestFor(conv: any, me: string): boolean {
    const people = Array.isArray(conv?.participants) ? conv.participants : [];
    const from = conv?.request?.from;
    return typeof conv?.id === 'string' && !!conv.id && conv.type === 'dm' && people.length === 2
        && people.every((p: unknown) => typeof p === 'string' && !!p) && people.includes(me)
        && typeof from === 'string' && from !== me && people.includes(from);
}

/**
 * One listed request's row and people, into the copy `database` (requestsInPlace): nothing over a row it doesn't fit. `pins`:
 * that copy's, read first through this handle; a pinned DM's people are [me, the pinned key], as the sync and
 * writeConversationFromNode write them (the listing is heard by the pin at the chat's poll in place). True once that copy
 * holds it as a DM (written now, or held already); false when it doesn't fit and nothing was written (#3309 review N3).
 */
async function admitRequestInto(database: SQLite.SQLiteDatabase, conv: any, me: string, pins: DmPeerPins): Promise<boolean> {
    if (!(await newDmFitsIn(database, conv.id))) return false;
    await database.runAsync(
        `INSERT INTO conversations (id, type, post_id, name, created_by, created_at, request) VALUES (?, 'dm', NULL, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [conv.id, conv.name ?? null, conv.createdBy ?? '', conv.createdAt ?? new Date().toISOString(), JSON.stringify(conv.request)]
    );
    const pinned = dmPinFor(pins, conv.id);
    for (const p of pinned ? [me, pinned.peer] : conv.participants) {
        await database.runAsync('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)', [conv.id, p]);
    }
    return true;
}

export async function ignoreAllMessageRequests(): Promise<{ success: boolean; ignored: number }> {
    // On its way from the tap, and once the node took it, for the community it went to: let in once never accepts one of
    // those requests over it (memberAnsweredSince, #3319 review F2).
    _allRequestsDeclining++;
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        const answer = await _signedRequest('/api/messages/request/ignore-all', {}, anchorUrl);
        _allRequestsDeclined.set(getDatabaseFilenameForNode(anchorUrl), ++_requestDecisions);
        return answer;
    } finally {
        _allRequestsDeclining--;
    }
}

/**
 * Replay-proof signed GET request helper.
 * Under ENFORCE_READ_AUTH=true, gated GET endpoints require signed headers with an empty body.
 * `anchorUrl`: the community asked (a chat request's own, chatCopyForRequest); left out, the one the phone is on now.
 */
export async function signedGet(path: string, options?: { signal?: AbortSignal; customHeaders?: Record<string, string>; anchorUrl?: string | null }): Promise<Response> {
    const anchorUrl = options?.anchorUrl !== undefined ? options.anchorUrl : await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node.');

    // One ask: signed afresh each time (a signature carries its own nonce, so an ask is never sent twice as it was).
    const ask = async (): Promise<Response> => {
        // The language this phone writes in, as on a signed POST: a refused read comes back in it too (not signed, not stored).
        let headers: Record<string, string> = { 'Accept': 'application/json', ...languageHeader(), ...(options?.customHeaders || {}) };
        const identity = await loadIdentity();
        let signed = false;
        if (identity?.privateKey && identity?.publicKey) {
            try {
                // The URL fetched below: its host is what is signed for, its path (no query) what the node checks.
                const signedHeaders = await buildSignedHeaders('GET', `${anchorUrl}${path}`, '', identity.privateKey, identity.publicKey);
                headers = { ...headers, ...signedHeaders };
                signed = true;
            } catch (e) {
                console.warn('[signedGet] Could not sign GET request:', e);
            }
        }

        const res = await fetch(`${anchorUrl}${path}`, {
            method: 'GET',
            headers,
            signal: options?.signal,
        });
        if (identity?.publicKey) watchForReplacedKey(anchorUrl, identity.publicKey, res, signed);
        return res;
    };

    const first = await ask();
    // A busy network's 429 (not the node's own JSON one): a read is safe to ask again, ONCE, after the wait it named (core
    // busy-answer.ts). A second 429 is handed back as it is, for the caller's own not-ok path; never a loop.
    if (first.ok || !isBusyStatus(first.status) || !(await answerIsBusy(first))) return first;
    await waitBeforeRetry(retryAfterMs(first.headers?.get?.('Retry-After')), options?.signal);
    return ask();
}

/** Whether a 429 is the busy network's, not the node's own: read from a copy, so the caller's body is untouched. */
async function answerIsBusy(res: Response): Promise<boolean> {
    if (typeof res.clone !== 'function') return true;
    const text = await res.clone().text().catch(() => '');
    return isBusyAnswer(res.status, text);
}

/**
 * Report one onboarding step that only the device can see — a screen drawn, a choice made,
 * a guide finished. The server counts the rest for itself.
 *
 * ONCE PER PERSON, per node. The screen a caller sits on can be drawn many times over one
 * join — a remount, a back-and-forward, an app restart part way through — and every one of
 * those used to become another tally, which is how an operator came to be shown 56 people
 * reaching step 3 out of 20 who joined. The node cannot fix this for us: M2 gives the
 * counter table no column that could tell those 56 apart, and the whole point of M2 is that
 * it never will. So the phone keeps the one bit the node refuses to, and keeps it here
 * rather than in each caller, so a future fourth step cannot forget to.
 *
 * The flag is written only AFTER the report has actually landed. Written before, a member
 * joining on a flaky connection is marked as counted for a request that never arrived, and
 * is then missing from the funnel forever — the same "book it on the tap" mistake that
 * `hasNoAvatarYet` exists to prevent for step 2.
 *
 * Swallows everything, including the throw from being off-grid. A person joining a
 * community must never see an error, a delay, or a blocked button because a counter could
 * not be incremented; a funnel that costs somebody their signup has done more damage than
 * the missing number could ever be worth. Not awaited by its callers either — the screen
 * moves on regardless of whether this lands.
 */
export async function recordOnboardingEvent(event: string, variant = ''): Promise<void> {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        const identity = await loadIdentity();
        // Without both of these there is nothing to key the flag by, and _signedRequest
        // would throw on the next line anyway. Returning here means no flag is written, so
        // the step is still reported once the phone is anchored and signed in.
        if (!anchorUrl || !identity?.publicKey) return;

        const alreadyCounted = onboardingEventKey(anchorUrl, identity.publicKey, event);
        if (await AsyncStorage.getItem(alreadyCounted)) return;

        await _signedRequest('/api/funnel-event', { event, variant: oncePerPersonVariant(variant) });
        await AsyncStorage.setItem(alreadyCounted, '1');
    } catch {
        // Deliberately silent. Not even a console.warn: this runs on the join path, and a
        // red box in a fresh user's face over telemetry would be its own bug.
    }
}

export async function toggleMessageReactionApi(messageId: string, authorPubkey: string, emoji: string, community?: ChatCommunity, groupId?: string) {
    // The community the reaction goes to and its file, taken together (chatCopyForRequest): shown and sent in the same one.
    // In place, only on a line of a direct chat that community's copy holds (#3305 review F1), or of the group `groupId` there (S6).
    const here = await onlyLineInPlace(await chatCopyForRequest(community), messageId, groupId);
    const anchorUrl = here.anchorUrl;
    if (!anchorUrl) throw new Error('Offline');

    // 1. Optimistic local update
    const database = here.database;
    const row = await database.getFirstAsync<any>('SELECT * FROM messages WHERE id=?', [messageId]);
    if (row) {
        let metadata: any = {};
        if (row.metadata) {
            try { metadata = JSON.parse(row.metadata); } catch { metadata = {}; }
        }
        if (!metadata.reactions) metadata.reactions = [];

        const idx = metadata.reactions.findIndex((r: any) => r.author === authorPubkey);
        if (idx > -1) {
            if (metadata.reactions[idx].emoji === emoji) {
                metadata.reactions.splice(idx, 1);
            } else {
                metadata.reactions[idx].emoji = emoji;
            }
        } else {
            metadata.reactions.push({ emoji, author: authorPubkey });
        }
        await database.runAsync('UPDATE messages SET metadata=? WHERE id=?', [JSON.stringify(metadata), messageId]);
    }

    // 2. Transmit to server via secure signed request
    return _signedRequest('/api/messages/react', { messageId, authorPubkey, emoji }, anchorUrl);
}

/**
 * Accept an Offer. A listing priced per week or per month is taken up as a standing deal (DESIGN-standing-deals-fable §2.2):
 * `standing` is the payer's signed authorisation (utils/member-statements.ts signStandingStatement), and no hours go.
 * A listing priced for each one (DESIGN-per-item-price-fable.md §3) is taken up for `hours` of them, or all of them, with the
 * total the box showed (`item`: core itemTakeUpBox's send); the node refuses any other figure, and holds nothing then.
 */
export async function acceptMarketplacePost(
    postId: string, buyerPublicKey: string, hours?: number, standing?: StandingStartBody,
    item?: { itemOption: 'each' | 'lot'; expect_c: number },
) {
    const res = await _signedRequest('/api/marketplace/posts/accept', standing ? { postId, buyerPublicKey, standing }
        : item ? { postId, buyerPublicKey, hours, itemOption: item.itemOption, expect_c: item.expect_c }
        : { postId, buyerPublicKey, hours });

    // Await the local write: callers navigate into the chat as soon as this resolves,
    // and the chat screen reads the pending tx from local SQLite. The write itself is
    // milliseconds; the FIFO sync lock guarantees it isn't starved by background syncs.
    try {
        await acquireSyncLock({ urgent: true }); // user is mid accept-and-navigate — jump the sync queue
        try {
            const database = await getDb();
            const txId = res?.transaction?.id || null;
            console.log(`[Escrow] Offer accepted — txId=${txId}, postId=${postId}`);
            const postParam = await database.getFirstAsync<{ repeatable: number; price_type: string | null }>('SELECT repeatable, price_type FROM posts WHERE id = ?', [postId]);
            // A listing priced for each one stays on the board under its deals, as the node keeps it: its count comes with the
            // next read of it, never worked out here (a sync may have brought it already).
            if (postParam?.repeatable !== 1 && postParam?.price_type !== 'each' && !item) {
                await database.runAsync(
                    "UPDATE posts SET status = 'pending', accepted_by = ?, pending_transaction_id = ? WHERE id = ?",
                    [buyerPublicKey, txId, postId]
                );
            }

            if (res?.transaction) {
                const tx = res.transaction;
                let postTitle: string | null = null;
                const postRow = await database.getFirstAsync<{ title: string }>('SELECT title FROM posts WHERE id = ?', [postId]);
                if (postRow) postTitle = postRow.title;
                await database.runAsync(
                    'INSERT OR REPLACE INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, hours, status, created_at, cover_image, post_title, standing_id, period_no, standing, item_option) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [tx.id, tx.postId || postId, tx.buyerPublicKey || buyerPublicKey, tx.sellerPublicKey || null, dealAmountColumn(tx), tx.hours || null, tx.status || 'pending', tx.createdAt || new Date().toISOString(), tx.coverImage || null, postTitle, tx.standingId ?? null, tx.periodNo ?? null, standingJsonOf(tx), itemOptionColumn(tx)]
                );
            }

            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('sync_data_updated');
        } finally {
            releaseSyncLock();
        }
    } catch(e) {
        console.error('[Escrow] acceptMarketplacePost local update failed:', e);
    }

    // Balance refresh is a network round-trip — keep it off the caller's critical path
    refreshBalanceFromServer(buyerPublicKey).catch(() => null);

    return res;
}

/** A deal a money step is for (slice S6c): its own id, or a standing deal's. */
type DealNamed = { tx: string } | { standing: string };

/** Whether the copy `database` reads holds that deal as `me`'s, one of its two sides. One that can't be read is not held. */
async function holdsDealThrough(database: SQLite.SQLiteDatabase, me: string, deal: DealNamed): Promise<boolean> {
    const [column, id] = 'tx' in deal ? ['id', deal.tx] : ['standing_id', deal.standing];
    const row = await database.getFirstAsync(`SELECT id FROM marketplace_transactions WHERE ${column} = ? AND (buyer_pubkey = ? OR seller_pubkey = ?) LIMIT 1`, [id, me, me]).catch(() => null);
    return !!row;
}

/** The deal steps on their way, by community, account, route and body: the same step asked again meanwhile is that one's answer. */
const _dealStepsInFlight = new Map<string, Promise<{ res: any; here: ChatRequestCopy }>>();

/**
 * One step on a deal, asked of the deal's OWN community (slice S6c, scratch/fable-design/DESIGN-no-switch-messaging-fable.md §6):
 * its address and its copy are taken together as the step begins (chatCopyForRequest), the request is signed for that address
 * by `me`, the member it is for, and goes there or nowhere. Refused before anything is asked:
 * - another account is on the phone than `me` (asked again by the signing, and `leaving` refuses an account on its way off);
 * - `community` (a deal of a chat open in place) has no copy to open in place: a guest's look, a community taken off the phone,
 *   a chat left (copyInPlaceFor), or its copy doesn't hold that deal as `me`'s; and, as the request leaves, its copy has closed.
 * The same step asked twice at once (a double tap) is one request with one answer. A retry is a request for the same deal, which
 * its server takes once: a release already made answers `alreadyCompleted` and pays nothing (engine/escrow.ts), a cancel moves a
 * deal only from 'pending', a standing deal's stop and lowering only from what they name.
 * `kept`: what it changes in that community's own file, once its server has said yes (`here.handle()`): never in another's, and
 * nowhere once the phone has moved on (that community's next read brings it).
 */
async function dealStep(
    community: ChatCommunity, me: string, deal: DealNamed, endpoint: string, payload: object,
    kept?: (database: SQLite.SQLiteDatabase, here: ChatRequestCopy, res: any) => Promise<void>,
): Promise<{ res: any; here: ChatRequestCopy }> {
    const stays = accountStays();
    const here = await chatCopyForRequest(community);
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found. You must be logged in.');
    if (identity.publicKey !== me) throw new Error(OTHER_ACCOUNT_SINCE_CHAT_OPENED_TEXT);
    if (here.inPlace && !(await holdsDealThrough(here.database, me, deal))) throw new NoCopyInPlaceError();
    const leaving = () => {
        if (!stays()) throw new Error(OTHER_ACCOUNT_SINCE_CHAT_OPENED_TEXT);
        if (here.inPlace && !here.openNow()) throw new NoCopyInPlaceError();
    };
    // No await from this look to the note below: of two taps at once, one asks.
    const key = [here.file, me, endpoint, JSON.stringify(payload)].join('\n');
    const running = _dealStepsInFlight.get(key);
    if (running) return running;
    const run = (async () => {
        const res = await _signedRequest(endpoint, payload, { address: here.anchorUrl ?? '', leaving, signer: me });
        if (kept) {
            try {
                await acquireSyncLock({ urgent: true }); // the member's own step: it jumps the sync queue
                try {
                    const database = stays() ? await here.handle() : null;
                    if (database) await kept(database, here, res);
                } finally {
                    releaseSyncLock();
                }
            } catch (e) {
                console.error(`[Escrow] ${endpoint}: this phone's copy was not updated:`, e);
            }
        }
        return { res, here };
    })().finally(() => _dealStepsInFlight.delete(key));
    _dealStepsInFlight.set(key, run);
    return run;
}

/** Release a deal's Beans (its payer). `community`: a deal of a chat open in place, asked of its own community ({@link dealStep}). */
export async function completeMarketplaceTransaction(transactionId: string, confirmerPublicKey: string, finalHours?: number, community?: ChatCommunity) {
    // Awaits the local write so callers (and any screen they navigate to) read a consistent status.
    const { res, here } = await dealStep(community, confirmerPublicKey, { tx: transactionId }, '/api/marketplace/transactions/complete', { transactionId, confirmerPublicKey, finalHours }, async (database, at) => {
        const postParam = await database.getFirstAsync<{ repeatable: number, id: string }>('SELECT id, repeatable FROM posts WHERE pending_transaction_id = ?', [transactionId]);
        if (postParam && postParam.repeatable !== 1) {
            await database.runAsync("UPDATE posts SET status = 'completed' WHERE pending_transaction_id = ?", [transactionId]);
        }
        await database.runAsync("UPDATE marketplace_transactions SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), transactionId]);
        if (at.inPlace) return;
        // Emit events so Ledger screen refreshes immediately
        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('transaction_completed');
        DeviceEventEmitter.emit('sync_data_updated');
    });
    console.log(`[Escrow] Server complete response: success=${res?.success}, txId=${res?.transaction?.id}`);
    // A balance is asked of the community in use: another community's deal (in place, or the phone has moved on) asks it for none.
    if (here.inPlace || !here.openNow()) return res;
    // Balance refreshes are network round-trips — keep them off the caller's critical path
    const buyerPubkey = res?.transaction?.buyerPublicKey || confirmerPublicKey;
    const sellerPubkey = res?.transaction?.sellerPublicKey || null;
    if (buyerPubkey) refreshBalanceFromServer(buyerPubkey).catch(() => null);
    if (sellerPubkey) refreshBalanceFromServer(sellerPubkey).catch(() => null);

    return res;
}

/** Cancel a hold (either side): the Beans go back to the payer. `community`: as {@link completeMarketplaceTransaction}. */
export async function cancelMarketplaceTransaction(transactionId: string, cancellerPublicKey: string, community?: ChatCommunity) {
    const { res } = await dealStep(community, cancellerPublicKey, { tx: transactionId }, '/api/marketplace/transactions/cancel', { transactionId, cancellerPublicKey }, async (database, at) => {
        const postParam = await database.getFirstAsync<{ repeatable: number }>('SELECT repeatable FROM posts WHERE pending_transaction_id = ?', [transactionId]);
        if (postParam && postParam.repeatable !== 1) {
            await database.runAsync("UPDATE posts SET status = 'active', accepted_by = NULL, pending_transaction_id = NULL WHERE pending_transaction_id = ?", [transactionId]);
        }
        await database.runAsync("UPDATE marketplace_transactions SET status = 'cancelled' WHERE id = ?", [transactionId]);
        if (at.inPlace) return;
        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit('sync_data_updated');
    });
    return res;
}

/**
 * The deals between me and one person as a chat in place's own community answers them now (its GET /api/marketplace/transactions,
 * the member's own list), written into that community's copy and nowhere else (slice S6c). Resolves to the deals it wrote, by
 * id, each with what the node says of its listing (that copy may not hold the listing): the chat offers a money step only on
 * one of those, read back from that copy ({@link getDealsBetween}). Null when there was no answer, or nowhere of that
 * community's to keep it (the chat left, the phone switched, an account leaving): nothing then shows as that community's word.
 * In use: nothing asked (the phone's own sync keeps those).
 */
export async function syncDealsBetween(myPubkey: string, peerPubkey: string, community: ChatCommunity): Promise<Map<string, { postAuthorPublicKey?: string | null; postType?: string | null }> | null> {
    if (!community) return null;
    const stays = accountStays();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
        const here = await chatCopyForRequest(community);
        if (!here.inPlace || !here.anchorUrl || (await loadIdentity())?.publicKey !== myPubkey) return null;
        const res = await signedGet(`/api/marketplace/transactions?publicKey=${encodeURIComponent(myPubkey)}&limit=200`, { signal: controller.signal, anchorUrl: here.anchorUrl });
        const rows = res.ok ? await res.json() : null;
        if (!Array.isArray(rows)) return null;
        const pair = (a: unknown, b: unknown) => [String(a), String(b)].sort().join(' ');
        const ours = rows.filter((r: any) => typeof r?.id === 'string' && r.id && typeof r.postId === 'string'
            && pair(r.buyerPublicKey, r.sellerPublicKey) === pair(myPubkey, peerPubkey));
        await acquireSyncLock({ urgent: true });
        try {
            const database = stays() ? await here.handle() : null;
            if (!database) return null;
            for (const row of ours) await writeNodeDeal(database, row);
        } finally {
            releaseSyncLock();
        }
        return new Map(ours.map((r: any) => [r.id as string, { postAuthorPublicKey: r.postAuthorPublicKey ?? null, postType: r.postType ?? null }]));
    } catch (e: any) {
        console.warn(`[Deals] Could not read the deals of a chat in place: ${e?.message || e}`);
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function requestMarketplacePost(postId: string, buyerPublicKey: string, hours?: number) {
    // Unlike 'accept', requesting does not lock the post. It just creates a requested transaction.
    const res = await _signedRequest('/api/marketplace/posts/request', { postId, buyerPublicKey, hours });

    try {
        await acquireSyncLock({ urgent: true }); // user just requested the post — jump the sync queue
        try {
            const database = await getDb();
            if (res?.transaction) {
                const tx = res.transaction;
                let postTitle: string | null = null;
                const postRow = await database.getFirstAsync<{ title: string }>('SELECT title FROM posts WHERE id = ?', [postId]);
                if (postRow) postTitle = postRow.title;
                await database.runAsync(
                    'INSERT OR REPLACE INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, hours, status, created_at, cover_image, post_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [tx.id, tx.postId || postId, tx.buyerPublicKey || buyerPublicKey, tx.sellerPublicKey || null, dealAmountColumn(tx), tx.hours || null, tx.status || 'requested', tx.createdAt || new Date().toISOString(), tx.coverImage || null, postTitle]
                );
            }
        } finally {
            releaseSyncLock();
        }
    } catch(e) {
        console.warn('[Escrow] Failed to save requested transaction locally:', e);
    }

    return res;
}

/** Approve a request. On a Need priced per week or per month its author pays: `standing` is their signed authorisation (§4). */
export async function approveMarketplaceRequest(transactionId: string, authorPublicKey: string, standing?: StandingStartBody) {
    const res = await _signedRequest('/api/marketplace/transactions/approve', standing ? { transactionId, authorPublicKey, standing } : { transactionId, authorPublicKey });
    try {
        const database = await getDb();
        // The transaction becomes pending, and the post becomes pending unless repeatable.
        const postParam = await database.getFirstAsync<{ repeatable: number }>('SELECT repeatable FROM posts WHERE id = (SELECT post_id FROM marketplace_transactions WHERE id = ?)', [transactionId]);
        if (postParam?.repeatable !== 1) {
            await database.runAsync("UPDATE posts SET status = 'pending', pending_transaction_id = ? WHERE id = (SELECT post_id FROM marketplace_transactions WHERE id = ?)", [transactionId, transactionId]);
        }
        await database.runAsync("UPDATE marketplace_transactions SET status = 'pending' WHERE id = ?", [transactionId]);
        const tx = res?.transaction;
        if (tx?.standingId) {
            await database.runAsync('UPDATE marketplace_transactions SET amount_c = ?, standing_id = ?, period_no = ?, standing = ? WHERE id = ?',
                [dealAmountColumn(tx), tx.standingId, tx.periodNo ?? null, standingJsonOf(tx), transactionId]);
        }
    } catch(e) {}
    return res;
}

/**
 * The payer's standing authorisation for the community this phone is on (§6), as the web makes it: core's builder, through
 * utils/member-statements.ts signStandingStatement, for the address every request here goes to.
 */
export async function signStandingStart(fields: StandingAuthorisationFields): Promise<StandingStartBody> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node to perform this action.');
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found. You must be logged in.');
    const { signStandingStatement } = await import('./member-statements');
    return signStandingStatement(anchorUrl, fields, identity.privateKey);
}

/**
 * A step on a standing deal (the node reads the side from the signer). `me`: the member it is for; left out, the account on the
 * phone. `community`: a standing deal of a chat open in place, asked of its own community (slice S6c, {@link dealStep}).
 */
async function standingDealStep(standingId: string, step: string, payload: object, me: string | undefined, community: ChatCommunity) {
    const mine = me ?? (await loadIdentity())?.publicKey;
    if (!mine) throw new Error('No identity found. You must be logged in.');
    return (await dealStep(community, mine, { standing: standingId }, `/api/marketplace/standing/${encodeURIComponent(standingId)}/${step}`, payload)).res;
}

/** Stop a standing deal (either side): after the period already paid, or at once while it is short (in the grace). */
export async function stopStandingDeal(standingId: string, me?: string, community?: ChatCommunity) {
    return standingDealStep(standingId, 'stop', {}, me, community);
}

/**
 * A short week (DESIGN-getting-paid-fable §3.1): the payee lowers one period alone, or the payer asks to pay less for it
 * (the node reads the side from the signer). `changeId` is the app's UUID (core standingChangeId), the same on a retry.
 */
export async function lowerStandingPeriod(standingId: string, changeId: string, periodNo: number, beans_c: number, me?: string, community?: ChatCommunity) {
    return standingDealStep(standingId, 'lower', { id: changeId, periodNo, beans_c }, me, community);
}

/** The payee answers the payer's open ask: yes, that period costs what was asked; no, it stays as it was. */
export async function answerStandingAsk(standingId: string, changeId: string, yes: boolean, me?: string, community?: ChatCommunity) {
    return standingDealStep(standingId, `lower/${encodeURIComponent(changeId)}/answer`, { yes }, me, community);
}

/** The payer takes their open ask back: nothing changes. */
export async function withdrawStandingAsk(standingId: string, changeId: string, me?: string, community?: ChatCommunity) {
    return standingDealStep(standingId, `lower/${encodeURIComponent(changeId)}/withdraw`, {}, me, community);
}

// ── Bills (DESIGN-getting-paid-fable §4; the node's routes/bills.ts), read and answered on the node, never kept here ──

/** The signer's bills: those waiting on them (`toPay`) and those they sent (`sent`), newest first. Throws when unread. */
export async function getBills(): Promise<{ toPay: BillView[]; sent: BillView[] }> {
    const res = await signedGet('/api/bills');
    if (!res.ok) throw Object.assign(new Error(`Server returned ${res.status}`), { status: res.status });
    const body = await res.json();
    return { toPay: Array.isArray(body?.toPay) ? body.toPay : [], sent: Array.isArray(body?.sent) ? body.sent : [] };
}

/** Pay one, at once and for good. `requestId` (core billPayRequestFor) is the same on a retry, so it is never paid twice. */
export async function payBill(billId: string, requestId: string) {
    return billRequest(`/api/bills/${encodeURIComponent(billId)}/pay`, { requestId });
}

/** Decline one, quietly: its sender is not told. */
export async function declineBill(billId: string) {
    return billRequest(`/api/bills/${encodeURIComponent(billId)}/decline`, {});
}

/** The sender takes back one not paid. */
export async function withdrawBill(billId: string) {
    return billRequest(`/api/bills/${encodeURIComponent(billId)}/withdraw`, {});
}

/** Report a bill to the community's owners, with the reason picked: the node declines it and names its sender. */
export async function reportBill(billId: string, reason: string) {
    return billRequest('/api/reports', { reason, targetBillId: billId });
}

/** A bill's write: the node's sentence when it refused in words (`message`), with its status kept, as the web's request(). */
async function billRequest(endpoint: string, payload: object) {
    try {
        return await _signedRequest(endpoint, payload);
    } catch (e: any) {
        throw reportRefusal(e);
    }
}

export async function rejectMarketplaceRequest(transactionId: string, authorPublicKey: string) {
    const res = await _signedRequest('/api/marketplace/transactions/reject', { transactionId, authorPublicKey });
    try {
        const database = await getDb();
        await database.runAsync("UPDATE marketplace_transactions SET status = 'rejected' WHERE id = ?", [transactionId]);
    } catch(e) {}
    return res;
}

export async function cancelMarketplaceRequest(transactionId: string, buyerPublicKey: string) {
    const res = await _signedRequest('/api/marketplace/transactions/cancel-request', { transactionId, buyerPublicKey });
    try {
        const database = await getDb();
        await database.runAsync("UPDATE marketplace_transactions SET status = 'cancelled' WHERE id = ?", [transactionId]);
    } catch(e) {}
    return res;
}

/**
 * The report's reason as it goes for `id`: the reason picked (REPORT_REASONS, first, where the server reads it) always;
 * the member's words after it only where refuseReadableIntoDm lets readable words through for that id. Where it refuses
 * the reason picked goes alone, so a report is never held up and "Child safety" still alerts (#1938 confirmation 9, the
 * director's ruling: no readable words for a known DM's id anywhere), and the cause is kept for the dialog (case 14):
 * 'private' for a known DM's id (GroupChatKeyError), 'unread' when the guard can't tell (DmPinStoreError,
 * DmGuardUnreadError, the key memory unreadable (GroupChatKeyError 'store'), or anything else it throws). The server sorts and alerts on its own rule over the full reason
 * (@beanpool/core reportKind), which also reads the words; so when they stay here and that rule reads the full reason as
 * child safety, "Child safety" goes as the reason, and the urgent alert fires as it would have with the words (#1938
 * confirmation 10, finding 1, the director's ruling (i)). The words still never leave.
 */
async function reportReasonFor(id: string, reason: string, at?: SQLite.SQLiteDatabase): Promise<{ reason: string; wordsLeftOut?: ReportWordsLeftOut }> {
    const picked = REPORT_REASONS.find((r) => reason === r || reason.startsWith(`${r}: `));
    if (picked && !reason.slice(picked.length + 2).trim()) return { reason };
    try {
        await refuseReadableIntoDm(id, at);
        return { reason };
    } catch (e) {
        const sendAs = reportKind(reason) === 'child safety' ? CHILD_SAFETY_REASON : picked ?? 'Other';
        return { reason: sendAs, wordsLeftOut: e instanceof GroupChatKeyError && e.code !== 'store' ? 'private' : 'unread' };
    }
}

/**
 * Report a member, a post or an event (and, from the enterprise screen, an enterprise). The post and event screens show
 * a failure's message to the member, so it is the node's sentence when it sent one ("That post is not here any more."),
 * never its code (`not_found`), which stays on the error as `code`, with `status`. When the report went with the reason
 * picked but not the member's words (reportReasonFor), the node's answer comes back with `wordsLeftOut` saying why
 * ('private' or 'unread'), for the "Reported" dialog (reportedAlertBody); otherwise as the node sent it.
 */
export async function reportAbuse(reporterPublicKey: string, targetPublicKey: string, reason: string, postId?: string) {
    const sending = postId ? await reportReasonFor(postId, reason) : { reason };
    try {
        const res = await _signedRequest('/api/reports', { reporterPubkey: reporterPublicKey, targetPubkey: targetPublicKey, reason: sending.reason, targetPostId: postId });
        return sending.wordsLeftOut ? { ...res, wordsLeftOut: sending.wordsLeftOut } : res;
    } catch (e: any) {
        throw reportRefusal(e);
    }
}

/** A report's refusal as the member reads it: the node's sentence when it sent one, its code kept as `code`. */
function reportRefusal(e: any): any {
    if (typeof e?.nodeMessage !== 'string' || !e.nodeMessage) return e;
    const said: any = new Error(e.nodeMessage);
    said.status = e.status;
    said.code = e.message;
    said.nodeAnswered = e.nodeAnswered;
    return said;
}


/** Rate the other side of a deal. `community`: a deal of a chat open in place, rated in its own community ({@link dealStep}). */
export async function submitRating(raterPublicKey: string, targetPublicKey: string, rating: number, comment: string, transactionId?: string, community?: ChatCommunity) {
    const { res } = await dealStep(community, raterPublicKey, { tx: transactionId ?? '' }, '/api/ratings', { raterPubkey: raterPublicKey, targetPubkey: targetPublicKey, stars: rating, comment, transactionId }, async (database, _here, answer) => {
        if (!answer?.success || !transactionId) return;
        await database.withTransactionAsync(async () => {
            await database.runAsync(`
                UPDATE marketplace_transactions
                SET rated_by_buyer = CASE WHEN buyer_pubkey = ? THEN 1 ELSE rated_by_buyer END,
                    rated_by_seller = CASE WHEN seller_pubkey = ? THEN 1 ELSE rated_by_seller END
                WHERE id = ?
            `, [raterPublicKey, raterPublicKey, transactionId]);
            console.log(`[Rating] Optimistically marked tx ${transactionId} as rated in local SQLite`);

            const r = answer.rating;
            const stars = r?.stars ?? r?.rating;
            if (r && stars && stars >= 1 && stars <= 5 && r.id && r.targetPubkey && r.raterPubkey) {
                await database.runAsync(`
                    INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    r.id,
                    r.targetPubkey,
                    r.raterPubkey,
                    r.role ?? 'provider',
                    stars,
                    r.comment ?? null,
                    r.transactionId ?? r.transaction_id ?? null,
                    r.createdAt ?? r.created_at ?? new Date().toISOString()
                ]);
                console.log(`[Rating] Inserted rating ${r.id} into local SQLite ratings table`);
            }
        });
    });
    return res;
}

/** How many members' reviews the phone keeps as the node last answered (member_reviews_read): the market draws
 *  PostAuthorTrust on every card, about 120 a screen. */
const REVIEWS_READ_KEPT = 300; // not exported: utils/__tests__/net-spy-db.ts stands in only for string exports (the test uses 300)

type MemberRatings = { ratings: any[]; average: number; count: number; asProvider: { average: number; count: number }; asReceiver: { average: number; count: number } };

/** Keeps another member's reviews as the node answered them, by member: stars, words, side, date, and `mine` on the
 *  reader's own, and no rater and no deal, whatever the node sent. Forgets all but the REVIEWS_READ_KEPT read last. */
async function keepReviewsRead(database: Awaited<ReturnType<typeof getDb>>, targetPubkey: string, data: any): Promise<void> {
    const ratings = (data.ratings as any[])
        .map(r => ({ stars: r.stars ?? r.rating, comment: r.comment ?? null, role: r.role ?? 'provider', createdAt: r.createdAt ?? r.created_at ?? null, ...(r.mine === true ? { mine: true } : {}) }))
        .filter(r => typeof r.stars === 'number' && r.stars >= 1 && r.stars <= 5);
    const side = (s: any) => ({ average: Number(s?.average) || 0, count: Number(s?.count) || 0 });
    const answer = { ratings, average: Number(data.average) || 0, count: Number(data.count ?? ratings.length) || 0, asProvider: side(data.asProvider), asReceiver: side(data.asReceiver) };
    await database.runAsync('INSERT OR REPLACE INTO member_reviews_read (target_pubkey, answer, read_at) VALUES (?, ?, ?)', [targetPubkey, JSON.stringify(answer), new Date().toISOString()]);
    await database.runAsync('DELETE FROM member_reviews_read WHERE target_pubkey NOT IN (SELECT target_pubkey FROM member_reviews_read ORDER BY read_at DESC, rowid DESC LIMIT ?)', [REVIEWS_READ_KEPT]);
}

export async function getMemberRatings(publicKey: string): Promise<MemberRatings> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) {
        await acquireSyncLock();
        try {
            const database = await getDb();
            const rows = await database.getAllAsync<any>(`
                SELECT r.id, r.target_pubkey, r.rater_pubkey, r.stars, r.comment, r.role, r.transaction_id, r.created_at,
                       m.callsign as rater_callsign, m.avatar_url as rater_avatar
                FROM ratings r
                LEFT JOIN members m ON r.rater_pubkey = m.public_key
                WHERE r.target_pubkey = ?
                ORDER BY r.created_at DESC
            `, [publicKey]);
            
            const count = rows.length;
            const average = count > 0 ? rows.reduce((sum, r) => sum + r.stars, 0) / count : 0;
            const provRows = rows.filter(r => r.role === 'provider');
            const recvRows = rows.filter(r => r.role === 'receiver');
            const provAvg = provRows.length > 0 ? provRows.reduce((sum, r) => sum + r.stars, 0) / provRows.length : 0;
            const recvAvg = recvRows.length > 0 ? recvRows.reduce((sum, r) => sum + r.stars, 0) / recvRows.length : 0;
            
            return {
                ratings: rows.map(r => ({
                    id: r.id,
                    targetPubkey: r.target_pubkey,
                    raterPubkey: r.rater_pubkey,
                    stars: r.stars,
                    comment: r.comment,
                    role: r.role,
                    transactionId: r.transaction_id,
                    createdAt: r.created_at,
                    rater_callsign: r.rater_callsign || 'Unknown',
                    rater_avatar: r.rater_avatar || null
                })),
                average,
                count,
                asProvider: { average: provAvg, count: provRows.length },
                asReceiver: { average: recvAvg, count: recvRows.length }
            };
        } catch (e) {
            return { ratings: [], average: 0, count: 0, asProvider: { average: 0, count: 0 }, asReceiver: { average: 0, count: 0 } };
        } finally {
            releaseSyncLock();
        }
    }
    
    try {
        const res = await signedGet(`/api/ratings/${publicKey}`);
        if (!res.ok) {
            throw new Error(`Failed to fetch ratings: ${res.statusText}`);
        }
        const data = await res.json();
        if (Array.isArray(data.ratings)) {
            const me = (await loadIdentity().catch(() => null))?.publicKey;
            await acquireSyncLock();
            try {
                const database = await getDb();
                await database.withTransactionAsync(async () => {
                    for (const r of data.ratings) {
                        const stars = r.stars ?? r.rating;
                        if (!stars || stars < 1 || stars > 5) {
                            console.warn(`[DB] Skipping invalid rating in getMemberRatings:`, r);
                            continue;
                        }
                        const rId = r.id ?? null;
                        const targetPubkey = r.targetPubkey ?? r.target_pubkey ?? null;
                        const raterPubkey = r.raterPubkey ?? r.rater_pubkey ?? null;
                        // Another member's review as a third member reads it (#1914) names no rater and no deal: it is
                        // kept with that member's answer below, not here.
                        if (!rId || !targetPubkey || !raterPubkey) continue;
                        await database.runAsync(`
                            INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `, [
                            rId,
                            targetPubkey,
                            raterPubkey,
                            r.role ?? 'provider',
                            stars,
                            r.comment ?? null,
                            r.transactionId ?? r.transaction_id ?? null,
                            r.createdAt ?? r.created_at ?? new Date().toISOString()
                        ]);
                    }
                    // The member's own reviews stay in ratings alone, with their raters' names (unchanged).
                    if (publicKey !== me) await keepReviewsRead(database, publicKey, data);
                });
            } finally {
                releaseSyncLock();
            }
        }
        return data;
    } catch (e: any) {
        console.warn('Failed to fetch ratings, defaulting to local DB:', e.message);
        const me = (await loadIdentity().catch(() => null))?.publicKey;
        await acquireSyncLock();
        try {
            const database = await getDb();
            // Another member's reviews as the node last answered, when it has: the same count, average and rows offline.
            const kept = publicKey !== me
                ? await database.getFirstAsync<{ answer: string }>('SELECT answer FROM member_reviews_read WHERE target_pubkey = ?', [publicKey])
                : null;
            if (kept) return JSON.parse(kept.answer) as MemberRatings;
            const rows = await database.getAllAsync<any>(`
                SELECT r.id, r.target_pubkey, r.rater_pubkey, r.stars, r.comment, r.role, r.transaction_id, r.created_at,
                       m.callsign as rater_callsign, m.avatar_url as rater_avatar
                FROM ratings r
                LEFT JOIN members m ON r.rater_pubkey = m.public_key
                WHERE r.target_pubkey = ?
                ORDER BY r.created_at DESC
            `, [publicKey]);
            
            const count = rows.length;
            const average = count > 0 ? rows.reduce((sum, r) => sum + r.stars, 0) / count : 0;
            const provRows = rows.filter(r => r.role === 'provider');
            const recvRows = rows.filter(r => r.role === 'receiver');
            const provAvg = provRows.length > 0 ? provRows.reduce((sum, r) => sum + r.stars, 0) / provRows.length : 0;
            const recvAvg = recvRows.length > 0 ? recvRows.reduce((sum, r) => sum + r.stars, 0) / recvRows.length : 0;
            
            return {
                ratings: rows.map(r => ({
                    id: r.id,
                    targetPubkey: r.target_pubkey,
                    raterPubkey: r.rater_pubkey,
                    stars: r.stars,
                    comment: r.comment,
                    role: r.role,
                    transactionId: r.transaction_id,
                    createdAt: r.created_at,
                    rater_callsign: r.rater_callsign || 'Unknown',
                    rater_avatar: r.rater_avatar || null
                })),
                average,
                count,
                asProvider: { average: provAvg, count: provRows.length },
                asReceiver: { average: recvAvg, count: recvRows.length }
            };
        } catch (localErr) {
            return { ratings: [], average: 0, count: 0, asProvider: { average: 0, count: 0 }, asReceiver: { average: 0, count: 0 } };
        } finally {
            releaseSyncLock();
        }
    }
}

/** Reviews the given member has WRITTEN about others, newest first. */
export async function getRatingsGiven(raterPubkey: string): Promise<any[]> {
    try {
        const res = await signedGet(`/api/ratings/${raterPubkey}?direction=given`);
            if (res.ok) {
                const data = await res.json();
                if (data.ratings) {
                    await acquireSyncLock();
                    try {
                        const database = await getDb();
                        await database.withTransactionAsync(async () => {
                            for (const r of data.ratings) {
                                const stars = r.stars ?? r.rating;
                                if (!stars || stars < 1 || stars > 5) {
                                    console.warn(`[DB] Skipping invalid rating in getRatingsGiven:`, r);
                                    continue;
                                }
                                const rId = r.id ?? null;
                                const targetPubkey = r.targetPubkey ?? r.target_pubkey ?? null;
                                const raterPubkey = r.raterPubkey ?? r.rater_pubkey ?? null;
                                if (!rId || !targetPubkey || !raterPubkey) {
                                    console.warn(`[DB] Skipping rating due to missing required keys in getRatingsGiven:`, r);
                                    continue;
                                }
                                await database.runAsync(`
                                    INSERT OR REPLACE INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                `, [
                                    rId,
                                    targetPubkey,
                                    raterPubkey,
                                    r.role ?? 'provider',
                                    stars,
                                    r.comment ?? null,
                                    r.transactionId ?? r.transaction_id ?? null,
                                    r.createdAt ?? r.created_at ?? new Date().toISOString()
                                ]);
                            }
                        });
                    } finally {
                        releaseSyncLock();
                    }
                    
                    return data.ratings.map((r: any) => ({
                        id: r.id,
                        target_pubkey: r.targetPubkey || r.target_pubkey,
                        rater_pubkey: r.raterPubkey || r.rater_pubkey,
                        stars: r.stars,
                        comment: r.comment,
                        role: r.role,
                        transaction_id: r.transactionId || r.transaction_id,
                        created_at: r.createdAt || r.created_at,
                        target_callsign: r.target_callsign || r.targetCallsign || 'Unknown',
                        target_avatar: r.target_avatar || r.targetAvatar || null
                    }));
                }
            }
    } catch (e: any) {
        console.warn('Failed to fetch given ratings from server, falling back to local DB:', e.message);
    }

    await acquireSyncLock();
    try {
        const database = await getDb();
        return await database.getAllAsync<any>(`
            SELECT r.id, r.target_pubkey, r.stars, r.comment, r.role, r.transaction_id, r.created_at,
                   m.callsign as target_callsign, m.avatar_url as target_avatar
            FROM ratings r
            LEFT JOIN members m ON r.target_pubkey = m.public_key
            WHERE r.rater_pubkey = ?
            ORDER BY r.created_at DESC
        `, [raterPubkey]);
    } catch (e) {
        console.warn('getRatingsGiven failed:', e);
        return [];
    } finally {
        releaseSyncLock();
    }
}

export interface MarketplaceTransaction {
    id: string;
    postId: string;
    postTitle?: string | null;
    buyerPublicKey: string;
    buyerCallsign?: string | null;
    sellerPublicKey: string;
    sellerCallsign?: string | null;
    /** What the deal holds, whole hundredths of a Bean (the node's amount_c); null when the figure isn't one. */
    amount_c: number | null;
    hours?: number | null;
    status: string;
    createdAt: string;
    completedAt?: string | null;
    coverImage?: string | null;
    buyerAvatar?: string | null;
    sellerAvatar?: string | null;
    ratedByBuyer?: boolean;
    ratedBySeller?: boolean;
    postType?: string;
    postAuthorPublicKey?: string;
    postRepeatable?: boolean;
    postLendable?: boolean;
    /** A deal on an Offer priced for each one: 'each' (`hours` is how many) or 'lot' (all of them). Absent on every other deal. */
    itemOption?: 'each' | 'lot';
    /** A period of a standing deal, and on its current period's row the standing deal itself (standingOfRow; core StandingDealRow). */
    standingId?: string | null;
    periodNo?: number | null;
    standingPhase?: StandingPhase | null;
    /** Per period, whole hundredths of a Bean. */
    standingBeans_c?: number | null;
    standingUnit?: StandingPeriodUnit | null;
    standingMaxPeriods?: number | null;
    standingNextDueAt?: string | null;
    standingStartsAt?: string | null;
    standingShortSince?: string | null;
    /** On an ended standing deal's current row: why it ended, who tapped Stop (if anyone) and when it ended (its History line). */
    standingEndedReason?: string | null;
    standingStoppedBy?: string | null;
    standingEndedAt?: string | null;
    standingStopped?: boolean;
    /** A short week (core StandingDealRow): the period due's lowered amount, the payer's open ask, how many asks are left. */
    standingDueBeans_c?: number | null;
    standingAsk?: StandingAsk | null;
    standingAsksLeft?: number | null;
}

export async function getMarketplaceTransactions(publicKey: string, filter?: { status?: string }, limit = 50, offset = 0): Promise<MarketplaceTransaction[]> {
    const { database, anchorUrl } = await chatCopyForRequest();
    let query = `
        SELECT mt.*, COALESCE(p.title, mt.post_title) as postTitle, p.photos as postPhotos, m1.callsign as buyerCallsign, m1.avatar_url as buyerAvatar, m2.callsign as sellerCallsign, m2.avatar_url as sellerAvatar,
               p.type as postType, p.author_pubkey as postAuthorPublicKey,
               p.repeatable as postRepeatable,
               p.lendable as postLendable,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.buyer_pubkey) as ratedByBuyer,
               EXISTS(SELECT 1 FROM ratings r WHERE r.transaction_id = mt.id AND r.rater_pubkey = mt.seller_pubkey) as ratedBySeller
        FROM marketplace_transactions mt
        LEFT JOIN posts p ON mt.post_id = p.id
        LEFT JOIN members m1 ON mt.buyer_pubkey = m1.public_key
        LEFT JOIN members m2 ON mt.seller_pubkey = m2.public_key
        WHERE (mt.buyer_pubkey = ? OR mt.seller_pubkey = ?)
    `;
    const params: any[] = [publicKey, publicKey];
    if (filter?.status) { 
        query += " AND mt.status = ?"; 
        params.push(filter.status); 
    }
    query += " ORDER BY mt.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = await database.getAllAsync<any>(query, params);
    return rows.map(r => {
        let coverImg = r.cover_image;
        if (!coverImg && r.postPhotos) {
            try { 
                const arr = Array.isArray(r.postPhotos) ? r.postPhotos : JSON.parse(r.postPhotos); 
                if (arr.length > 0) coverImg = arr[0]; 
            } catch {}
        }
        if (coverImg) coverImg = photoOnCommunity(anchorUrl, coverImg);
        return {
            id: r.id, 
            postId: r.post_id, 
            postTitle: r.postTitle, 
            buyerPublicKey: r.buyer_pubkey, 
            buyerCallsign: r.buyerCallsign, 
            sellerPublicKey: r.seller_pubkey, 
            sellerCallsign: r.sellerCallsign, 
            amount_c: isHundredths(r.amount_c) ? r.amount_c : null,
            hours: typeof r.hours === 'number' ? r.hours : null,
            status: r.status, 
            createdAt: r.created_at, 
            completedAt: r.completed_at,
            coverImage: coverImg,
            buyerAvatar: r.buyerAvatar || null,
            sellerAvatar: r.sellerAvatar || null,
            ratedByBuyer: !!r.ratedByBuyer,
            ratedBySeller: !!r.ratedBySeller,
            postType: r.postType || undefined,
            postAuthorPublicKey: r.postAuthorPublicKey || undefined,
            postRepeatable: r.postRepeatable != null ? Boolean(r.postRepeatable) : undefined,
            postLendable: r.postLendable != null ? Boolean(r.postLendable) : undefined,
            ...(itemOptionColumn(r) ? { itemOption: itemOptionColumn(r)! } : {}),
            ...standingOfRow(r),
        };
    });
}

// ===================== FINANCIALS =====================

/**
 * Return pledge history for a user: transactions sent to project_ wallets.
 * Joins to the local projects table to get project titles.
 */
export async function getPledgeHistory(pubkey: string) {
    const database = await getDb();
    // Pledges are recorded as ledger transfers from the member to 'project_<id>'
    const rows = await database.getAllAsync<any>(
        `SELECT t.id, t.amount_c, t.memo, t.timestamp,
                REPLACE(t.to_pubkey, 'project_', '') as project_id,
                p.title as projectTitle
         FROM transactions t
         LEFT JOIN projects p ON p.id = REPLACE(t.to_pubkey, 'project_', '')
         WHERE t.from_pubkey = ? AND t.to_pubkey LIKE 'project_%'
         ORDER BY t.timestamp DESC LIMIT 50`,
        [pubkey]
    );
    return rows.map(r => ({
        id: r.id,
        amount_c: r.amount_c,
        projectId: r.project_id,
        projectTitle: r.projectTitle || 'Community Project',
        timestamp: r.timestamp,
        memo: r.memo,
    }));
}

/**
 * The Beans the node holds in escrow for this member: their 'pending' deals as the buyer, and nothing else.
 * The node moves a deal's Beans into escrow only when it is approved, or accepted in one step (both make it 'pending');
 * a 'requested' deal holds nothing (apps/server/src/engine/escrow.ts). Release, cancel and a dispute ruling take a deal
 * out of 'pending' to 'completed' or 'cancelled', and a request turned down or left to expire never held any. The same
 * rule as the node's own ledger export (engine/audit.ts exportLedgerFor, its Pending_Trade rows).
 */
/** In whole hundredths of a Bean: the deals' amount_c summed exactly (a deal with no figure counts nothing). */
export async function getEscrowTotal(pubkey: string): Promise<number> {
    const database = await getDb();
    const rows = await database.getAllAsync<any>(
        `SELECT COALESCE(SUM(amount_c), 0) as total
         FROM marketplace_transactions
         WHERE buyer_pubkey = ? AND status = 'pending'`,
        [pubkey]
    );
    return rows[0]?.total ?? 0;
}

// ===================== FRIENDS =====================

/** Get all friends from local SQLite (INNER JOIN to avoid ghost friends) */
export async function getFriendsLocal(ownerPubkey: string): Promise<any[]> {
    const database = await getDb();
    const rows = await database.getAllAsync<any>(
        `SELECT f.friend_pubkey as publicKey, m.callsign, m.avatar_url, f.added_at as addedAt, m.joined_at as joinedAt
         FROM friends f
         INNER JOIN members m ON f.friend_pubkey = m.public_key
         WHERE f.owner_pubkey = ?
         ORDER BY f.added_at DESC`,
        [ownerPubkey]
    );
    return rows;
}

/** Check if a pubkey is a friend */
export async function isFriendLocal(ownerPubkey: string, friendPubkey: string): Promise<boolean> {
    const database = await getDb();
    const row = await database.getFirstAsync<any>(
        'SELECT 1 FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?',
        [ownerPubkey, friendPubkey]
    );
    return !!row;
}

/**
 * Add a friend: the node first, then this phone's copy. The node tells the person added (their People tab's "added you"),
 * so it can refuse: past 100 adds in a day, or someone you blocked. Then this THROWS the node's own words and adds
 * nothing here, so the member is told, never left believing a refused add went through. When the node can't be reached
 * at all (off-grid, no answer), it is kept on this phone, as every add was before.
 */
export async function addFriendLocal(ownerPubkey: string, friendPubkey: string): Promise<void> {
    if (ownerPubkey === friendPubkey) return;
    try {
        await _syncFriendToServer('add', ownerPubkey, friendPubkey);
    } catch (e: any) {
        if (e?.nodeAnswered) throw new Error(String(e.message || 'Your community did not add them.'));
        console.warn('[Friends] Server sync failed:', e?.message);
    }
    const database = await getDb();
    await database.runAsync(
        'INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?)',
        [ownerPubkey, friendPubkey, new Date().toISOString()]
    );
}

/** Someone who added you lately and whom you haven't added back (GET /api/friends/added-you, your own only). */
export interface AddedYou {
    publicKey: string;
    callsign: string;
    avatarUrl: string | null;
    addedAt: string;
}

/** Who added you lately, newest first (at most 20) and how many more; nothing when the node can't say (an older node, off-grid). */
export async function fetchAddedYou(): Promise<{ addedYou: AddedYou[]; more: number }> {
    try {
        const res = await signedGet('/api/friends/added-you');
        if (res.ok) {
            const body = await res.json();
            if (Array.isArray(body?.addedYou)) return { addedYou: body.addedYou, more: Number(body.more) || 0 };
        }
    } catch (e) {
        console.warn('[Friends] Could not read who added you:', e);
    }
    return { addedYou: [], more: 0 };
}

/** Remove a friend locally + sync to server */
export async function removeFriendLocal(ownerPubkey: string, friendPubkey: string): Promise<void> {
    const database = await getDb();
    await database.runAsync(
        'DELETE FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?',
        [ownerPubkey, friendPubkey]
    );
    // Fire-and-forget server sync
    _syncFriendToServer('remove', ownerPubkey, friendPubkey).catch(e => console.warn('[Friends] Server sync failed:', e.message));
}

/**
 * Take someone you blocked off your friends (Settings → Manage Blocked Users): the node first, through the same route as
 * any removal, then this phone's copy. A block does not end a friendship (guide settings/blocking.md), and a block made
 * on the phone never reaches the node, so the node still has them as your friend until this. It THROWS when the node
 * did not take it, and removes nothing here: the member is told, never left believing they are off while the node still
 * shows them a contact set to Friends. A node with no such friend (one kept on this phone alone) has none to remove.
 * The block is left as it is.
 */
export async function removeFriendOnNode(ownerPubkey: string, friendPubkey: string): Promise<void> {
    try {
        await _syncFriendToServer('remove', ownerPubkey, friendPubkey);
    } catch (e: any) {
        const noneThere = e?.nodeAnswered && /relationship not found/i.test(String(e?.message));
        if (!noneThere) {
            throw new Error(e?.nodeAnswered
                ? String(e.message)
                : 'Couldn’t reach your community, so they are still your friend. Check your connection and try again.');
        }
    }
    const database = await getDb();
    await database.runAsync(
        'DELETE FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?',
        [ownerPubkey, friendPubkey]
    );
}

/** Server sync helper for friend add/remove */
async function _syncFriendToServer(action: 'add' | 'remove', ownerPubkey: string, friendPubkey: string) {
    const endpoint = action === 'add' ? '/api/friends/add' : '/api/friends/remove';
    await _signedRequest(endpoint, { ownerPubkey, friendPubkey });
}

/** Fetch friends from server (used by sync) */
export async function fetchFriendsFromServer(publicKey: string): Promise<any[]> {
    try {
        const res = await signedGet(`/api/friends/${publicKey}`);
        if (res.ok) return await res.json();
    } catch (e) {
        console.warn('[Friends] Failed to fetch from server:', e);
    }
    return [];
}

/**
 * Everyone this member has chatted with in a chat of two on this phone, a Market chat too: "Add people I've chatted with and
 * my friends" (private contacts C6, utils/contacts-former.ts), which links each of them by hand, and a linked contact is let
 * in on every community this phone holds (let-in.ts). So only a chat the member took part in themselves counts, by the same
 * test let in once reads ({@link MEMBERS_OWN_CHAT_SQL}: a line they wrote, or a request they accepted themselves; #3319
 * review at 1697ff89, R2-F1, Marty 21 Nov 2026): never a chat only the other person wrote in, nor one opened by someone
 * taking up the member's Offer, nor a request someone sent them that they haven't accepted. And only the key let in once
 * takes from such a chat ({@link letInOfRows}; #3319 final review, R3-F1): its pin's, else its one other person, nobody when
 * its rows name several, never a key pinned before nor one on offer. Each with a card in this copy, and with `keys`, every
 * key that chat knows them by (dm-blocked.ts dmPeerKeys), so a block under any of them holds (blocklist.ts
 * withoutBlockedPeople, slice S7b). Throws when this copy or its DM pins can't be read: nobody is offered on a guess.
 */
export async function getChattedWithMembers(myPubkey: string): Promise<{ publicKey: string; callsign: string; keys: string[] }[]> {
    const here = await chatCopyForRequest();
    const pins = await dmPins.peekReadable(myPubkey, here.file);
    const rows = await here.database.getAllAsync<{ id: string; keys: string | null }>(
        `SELECT c.id AS id, ${otherKeysSql()} AS keys FROM conversations c
         WHERE c.type = 'dm' AND c.id IN (SELECT conversation_id FROM conversation_participants WHERE public_key = ?)
           AND ${NOT_A_REQUEST_FOR_ME('c.request')}
           AND ${MEMBERS_OWN_CHAT_SQL('c')}`,
        [myPubkey, myPubkey, myPubkey, myPubkey]
    );
    const people = new Map<string, string[]>();
    for (const row of rows) {
        const [key] = letInOfRows([{ kind: 'dm', id: row.id, keys: row.keys }], pins, myPubkey);
        if (!key) continue;
        const keys = dmPeerKeys(row.keys ?? '', pins ? dmPinFor(pins, String(row.id)) : null);
        people.set(key, [...new Set([...(people.get(key) ?? []), ...keys])]);
    }
    if (people.size === 0) return [];
    const cards = await here.database.getAllAsync<{ publicKey: string; callsign: string }>(
        `SELECT public_key AS publicKey, callsign FROM members WHERE public_key IN (${[...people.keys()].map(() => '?').join(', ')})`,
        [...people.keys()]
    );
    return cards.map((m) => ({ publicKey: m.publicKey, callsign: m.callsign, keys: people.get(m.publicKey) ?? [m.publicKey] }));
}

/** Get recent chat peers (for "Recents" section in contact picker) */
export async function getRecentChatMembers(myPubkey: string, limit = 10): Promise<any[]> {
    const database = await getDb();
    return database.getAllAsync<any>(
        `SELECT DISTINCT m.public_key as publicKey, m.callsign, m.avatar_url, m.joined_at as joinedAt,
                MAX(msg.timestamp) as lastChatAt
         FROM conversation_participants cp
         JOIN conversations c ON cp.conversation_id = c.id
         JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.public_key != ?
         JOIN members m ON m.public_key = cp2.public_key
         LEFT JOIN messages msg ON msg.conversation_id = c.id
         WHERE cp.public_key = ? AND c.type = 'dm' AND c.post_id IS NULL
           AND ${NOT_A_REQUEST_FOR_ME('c.request')}
         GROUP BY m.public_key
         ORDER BY lastChatAt DESC
         LIMIT ?`,
        [myPubkey, myPubkey, myPubkey, limit]
    );
}



/**
 * A member's listings, for the profile screen.
 *
 * Events are left out. A profile's Listings section is a list of trades — a type badge, a bean amount and
 * Need styling — and an event has no price, so it rendered as "EVENT · 0 beans" once the phone started
 * caching events (slice 3). The web profile never shows one either: it asks the node with no `types=`, and
 * events are opt-in on that route (docs/events-on-the-map.md §2.6). A host page listing its events is
 * explicitly not in v1 (§1, §5); when it arrives it gets an events section of its own, date first.
 */
export async function getMemberPosts(pubkey: string) {
    const { database, anchorUrl } = await chatCopyForRequest();
    const rows = await database.getAllAsync<any>(`
        SELECT * FROM posts
        WHERE author_pubkey = ? AND status = 'active' AND COALESCE(type, '') != 'event'
        ORDER BY created_at DESC
    `, [pubkey]);

    return rows.map(r => {
        if (typeof r.photos === 'string') {
            try {
                r.photos = JSON.parse(r.photos);
                // Its photos' paths on this copy's own community (same as getPosts/getPost)
                if (Array.isArray(r.photos)) {
                    r.photos = r.photos.map((p: string) => photoOnCommunity(anchorUrl, p));
                }
            } catch (e) { r.photos = []; }
        }
        return r;
    });
}

export async function getUnreadCountForPost(postId: string, myPubkey: string, peerPubkey?: string): Promise<number> {
    const database = await getDb();
    let query = `
        SELECT COUNT(msg.id) as unreadCount 
        FROM messages msg
        JOIN conversations c ON msg.conversation_id = c.id
        WHERE c.post_id = ?
        AND msg.author_pubkey != ?
        AND (msg.timestamp > IFNULL((SELECT last_read_at FROM conversation_participants WHERE conversation_id = c.id AND public_key = ?), '2000-01-01'))
    `;
    const params: any[] = [postId, myPubkey, myPubkey];

    if (peerPubkey) {
        query += ` AND EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.public_key = ?)`;
        params.push(peerPubkey);
    }

    const row = await database.getFirstAsync<{unreadCount: number}>(query, params);
    return row?.unreadCount || 0;
}

export async function getDatabaseStats() {
    const database = await getDb();
    
    let membersCount = 0;
    let postsCount = 0;
    let txCount = 0;
    let msgCount = 0;
    let integrity = 'Unknown';

    try {
        const membersRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM members');
        membersCount = membersRow?.count || 0;
    } catch (e) {}

    try {
        // Mirror the server's authoritative count EXACTLY (getActivePostCount:
        // `active = 1 AND status = 'active'`) so the diagnostics "In Sync" badge is
        // reliable. Counting anything wider (e.g. including 'pending' deals or
        // 'paused'/disabled posts) drifts from the node's number and shows a
        // permanent false "out of sync". There is no `paused` column — paused is a
        // `status` value — and the old query referenced one, which threw and left
        // this count silently at 0 (the "0 Active Posts" bug).
        const postsRow = await database.getFirstAsync<{ count: number }>(
            "SELECT COUNT(*) as count FROM posts WHERE active = 1 AND status = 'active'"
        );
        postsCount = postsRow?.count || 0;
    } catch (e) {}

    try {
        const txRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM transactions');
        txCount = txRow?.count || 0;
    } catch (e) {}

    try {
        const msgRow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM messages');
        msgCount = msgRow?.count || 0;
    } catch (e) {}
    
    try {
        const integrityRow = await database.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
        integrity = integrityRow?.integrity_check || 'ok';
    } catch (e: any) {
        integrity = e.message || 'error';
    }

    return {
        members: membersCount,
        posts: postsCount,
        transactions: txCount,
        messages: msgCount,
        integrity
    };
}

// ===================== GROUPS & AUDIENCE SCOPING =====================
// Docs: docs/the-commons.md §9 (Item 10)
// Hard rules: roles are convenor / member / observer. Never "steward", never "admin".
// A group is an audience scope and NOTHING else.

export type GroupRole = 'convenor' | 'member' | 'observer';
export type JoinPolicy = 'open' | 'request_to_join' | 'invite_only';
export type GroupCategory = 'working_group' | 'social' | 'guild' | 'project' | 'general';
export type GroupMemberStatus = 'active' | 'pending_approval' | 'invited' | 'removed';

export interface GroupItem {
    id: string;
    name: string;
    slug: string;
    /** 'circle' on a place circle (@beanpool/core place-circle.ts): its name and purpose are shown in the member's language. */
    kind?: 'circle';
    /** A place circle's own rows, for someone in it. */
    circle?: import('@beanpool/core').CircleCard;
    description: string | null;
    avatarUrl: string | null;
    category: GroupCategory;
    createdBy: string;
    joinPolicy: JoinPolicy;
    createdAt: string;
    updatedAt: string;
    memberCount?: number;
    viewerRole?: GroupRole | null;
    viewerStatus?: GroupMemberStatus | null;
    /** The viewer's own open invitation: who sent it. */
    viewerInvitedBy?: { pubkey: string; callsign?: string; avatarUrl?: string };
    convenorPubkey?: string;
    convenorCallsign?: string;
    convenorAvatarUrl?: string | null;
    /** The group's LEAD convenor (2026-09-23): the one nobody can remove or demote. */
    leadPubkey?: string | null;
    leadCallsign?: string;
    /** When its members closed it by a vote (GET /api/groups/:id), or null: it stays to read and takes nothing new. */
    closedAt?: string | null;
    readOnly?: boolean;
}

export interface GroupMemberItem {
    groupId: string;
    memberPubkey: string;
    callsign?: string;
    avatarUrl?: string | null;
    role: GroupRole;
    status: GroupMemberStatus;
    joinedAt: string;
    invitedBy: string | null;
    updatedAt?: string;
    /** The member's earlier keys, each signed for by its successor (a node from before line-display design §5 sends none). */
    formerKeys?: FormerKey[] | null;
}

/**
 * Signed request helper supporting arbitrary HTTP methods (POST, PATCH, DELETE). `withStatus`: the thrown error also
 * carries the answer's `status`, and `unsaid` when the node gave no words of its own, so a screen can tell a refusal
 * (403, said in the node's words) from a blip. Opt-in: other callers' errors stay exactly as they were. `signal` lets the
 * caller give up on the request (the tool copy's, at its answer limit); without one, nothing changes. `anchorUrl`: the
 * community asked, when the caller needs to know which one answered (as signedGet's); left out, the one the phone is on now.
 */
export async function signedRequestWithMethod(method: string, endpoint: string, payload?: any, opts?: { withStatus?: boolean; signal?: AbortSignal; anchorUrl?: string | null }) {
    const anchorUrl = opts?.anchorUrl !== undefined ? opts.anchorUrl : await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node.');

    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found. You must be logged in.');

    const bodyString = payload !== undefined ? JSON.stringify(payload) : '';
    const headers = await buildSignedHeaders(method, `${anchorUrl}${endpoint}`, bodyString, identity.privateKey, identity.publicKey);

    const res = await fetch(`${anchorUrl}${endpoint}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...headers,
            ...languageHeader(),
        },
        body: payload !== undefined ? bodyString : undefined,
        ...(opts?.signal ? { signal: opts.signal } : {}),
    });

    if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const words = errJson.error || errJson.message;
        const error = new Error(words || `Request failed: ${res.status}`);
        // The node's code beside its sentence (a shop's `shop_deals_open`, say), so a screen can say what to do next.
        if (opts?.withStatus) Object.assign(error, { status: res.status }, words ? {} : { unsaid: true }, typeof errJson.code === 'string' ? { code: errJson.code } : {});
        // The node's sentence when its body has one beside a code in `error` (`{ error: 'not_found', message: 'That forum post
        // is not here any more.' }`), as _signedRequest carries it: a caller that says it reads it (utils/forum.ts forumRefusal).
        if (opts?.withStatus && typeof errJson.message === 'string' && errJson.message.trim()) Object.assign(error, { nodeMessage: errJson.message.trim() });
        throw error;
    }
    return await res.json();
}

export async function fetchGroups(filter?: { category?: string; memberPubkey?: string; search?: string }): Promise<GroupItem[]> {
    const params = new URLSearchParams();
    if (filter?.category) params.set('category', filter.category);
    if (filter?.memberPubkey) params.set('member', filter.memberPubkey);
    if (filter?.search) params.set('q', filter.search);

    try {
        // The groups of the community asked, kept in its file only (chatCopyForRequest). Each names the asking account's
        // role in it. An answer that lands after the phone switched community, or after that account left the phone, is
        // neither kept (its role written as the next account's) nor shown: the copy in use's own groups are (ownListRead,
        // #3309 review N2's class).
        const here = await chatCopyForRequest();
        const asked = ownListRead((await loadIdentity())?.publicKey);
        const res = await signedGet(`/api/groups${params.toString() ? '?' + params.toString() : ''}`, { anchorUrl: here.anchorUrl });
        if (res.ok) {
            const data = await res.json();
            const now = await asked.still();
            if (Array.isArray(data) && now) {
                // Update local cache
                const database = await here.handle();
                if (!database) return localGroups(filter);
                const identity = now.identity;
                for (const g of data) {
                    await database.runAsync(`
                        INSERT INTO groups (id, name, slug, description, avatar_url, category, created_by, join_policy, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            name = excluded.name,
                            slug = excluded.slug,
                            description = excluded.description,
                            avatar_url = excluded.avatar_url,
                            category = excluded.category,
                            join_policy = excluded.join_policy,
                            updated_at = excluded.updated_at
                    `, [
                        g.id, g.name, g.slug, g.description || null, g.avatarUrl || null,
                        g.category || 'general', g.createdBy, g.joinPolicy || 'open',
                        g.createdAt, g.updatedAt || g.createdAt
                    ]);

                    if (identity?.publicKey) {
                        if (g.viewerRole || g.viewerStatus) {
                            await database.runAsync(`
                                INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?)
                                ON CONFLICT(group_id, member_pubkey) DO UPDATE SET
                                    role = excluded.role,
                                    status = excluded.status,
                                    updated_at = excluded.updated_at
                            `, [
                                g.id, identity.publicKey, g.viewerRole || 'member',
                                g.viewerStatus || 'active', g.createdAt, g.updatedAt || g.createdAt
                            ]);
                        } else {
                            await database.runAsync(`
                                DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?
                            `, [g.id, identity.publicKey]);
                        }
                    }
                }
                return data;
            }
        }
    } catch (e) {
        console.warn('[Groups] Remote fetch failed, falling back to local DB:', e);
    }

    return localGroups(filter);
}

/** The groups this phone keeps for the community it is on now (fetchGroups' fallback when the node can't be asked). */
async function localGroups(filter?: { category?: string; memberPubkey?: string; search?: string }): Promise<GroupItem[]> {
    const database = await getDb();
    let query = `
        SELECT g.*,
            (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.status = 'active') as memberCount,
            (SELECT gm2.role FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.member_pubkey = ?) as viewerRole,
            (SELECT gm3.status FROM group_members gm3 WHERE gm3.group_id = g.id AND gm3.member_pubkey = ?) as viewerStatus
        FROM groups g
        WHERE 1=1
    `;
    const identity = await loadIdentity();
    const myPubkey = identity?.publicKey || filter?.memberPubkey || '';
    const queryParams: any[] = [myPubkey, myPubkey];
    if (filter?.category) {
        query += ' AND g.category = ?';
        queryParams.push(filter.category);
    }
    if (filter?.search) {
        query += ' AND (g.name LIKE ? OR g.description LIKE ?)';
        queryParams.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    query += ' ORDER BY g.updated_at DESC';

    const rows = await database.getAllAsync<any>(query, queryParams);
    return rows.map(r => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        description: r.description,
        avatarUrl: r.avatar_url,
        category: r.category,
        createdBy: r.created_by,
        joinPolicy: r.join_policy,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        memberCount: r.memberCount || 0,
        viewerRole: r.viewerRole || null,
        viewerStatus: r.viewerStatus || null,
    }));
}

/**
 * A group's card and its roster. `members` is null when the roster couldn't be read (the node busy with heavy lists
 * answers 503 with Retry-After, or the read failed): callers keep the roster they show and read it again next time,
 * never an empty one in its place.
 */
export async function fetchGroupDetails(id: string, community?: ChatCommunity): Promise<{ group: GroupItem; members: GroupMemberItem[] | null; rosterRefused?: boolean } | null> {
    try {
        const anchorUrl = await groupAddressOf(id, community);
        const [groupRes, membersRes] = await Promise.all([
            signedGet(`/api/groups/${encodeURIComponent(id)}`, { anchorUrl }),
            signedGet(`/api/groups/${encodeURIComponent(id)}/members`, { anchorUrl })
        ]);
        if (groupRes.ok) {
            const group = await groupRes.json();
            const members = membersRes.ok ? await membersRes.json() : null;
            // Where anyone can join in a minute, the roster is its members': anyone else is told to join (join_to_see).
            const refusal = !membersRes.ok && membersRes.status === 403 ? await membersRes.json().catch(() => null) : null;
            return { group, members: Array.isArray(members) ? members : null, rosterRefused: refusal?.code === 'join_to_see' };
        }
    } catch (e) {
        console.warn('[Groups] Failed to fetch group detail:', e);
    }
    return null;
}

/**
 * Who has been invited to a group and has not joined yet, and which of the viewer's own invitations were declined, as the
 * node lets THIS member read them (a convenor every pending one, any other member the ones they made; the node decides,
 * not this phone). Null when the node won't say (an older node, a refusal, no signal): the group's page then draws no list.
 */
export async function fetchGroupInvitations(groupId: string): Promise<GroupInvitations | null> {
    try {
        const res = await signedGet(`/api/groups/${encodeURIComponent(groupId)}/invitations`);
        if (!res.ok) return null;
        return readGroupInvitations(await res.json());
    } catch (e) {
        console.warn('[Groups] Failed to fetch the invitations:', e);
        return null;
    }
}

/**
 * Takes back an invitation still open: a convenor's for anyone's, the sender's for their own (the node decides). Its own
 * request, never the member removal (DELETE …/members/:pubkey): the list on screen may be minutes old, and if the person
 * has accepted since, a removal would remove a member who just joined. The node withdraws only a row still invited and
 * otherwise refuses, 409, saying they have joined (the thrown error carries those words). Nobody invited is in the chat,
 * so no key changes and no epoch is made for it.
 */
export async function withdrawGroupInvitationApi(groupId: string, memberPubkey: string): Promise<boolean> {
    const res = await signedRequestWithMethod('DELETE', `/api/groups/${encodeURIComponent(groupId)}/invitations/${encodeURIComponent(memberPubkey)}`);
    return Boolean(res?.success);
}

export async function createGroupApi(groupData: {
    name: string;
    slug?: string;
    description?: string;
    avatarUrl?: string;
    category?: string;
    joinPolicy?: JoinPolicy;
}): Promise<GroupItem> {
    return signedRequestWithMethod('POST', '/api/groups', groupData);
}

/**
 * Join a group, or accept its invitation. Joining an open group or accepting an invitation lets the joiner into the chat,
 * so they make its next key in the same request (group chat encryption §2.3, utils/group-chat-keys.ts); a request to
 * join an approval group lets nobody in yet and carries none. `onProgress` drives "Securing the chat…" on a big group.
 */
export async function joinGroupApi(groupId: string, info?: { joinPolicy?: string | null; viewerStatus?: string | null; onProgress?: (done: number, total: number) => void }): Promise<any> {
    const { nodeUrl, identity } = await groupKeyContext();
    await refuseGroupKeysForDm(groupKeyring(nodeUrl, identity, groupId, groupKeyStore(nodeUrl)));
    return joinGroupWithEpoch(nodeUrl, identity, groupKeyStore(nodeUrl), { id: groupId, joinPolicy: info?.joinPolicy, viewerStatus: info?.viewerStatus },
        info?.onProgress ? { onProgress: info.onProgress } : undefined);
}

/** A convenor approves a request: the approved member's first key is made here, in the same request (§2.3). */
export async function approveGroupMemberApi(groupId: string, memberPubkey: string, onProgress?: (done: number, total: number) => void): Promise<any> {
    const { nodeUrl, identity } = await groupKeyContext();
    await refuseGroupKeysForDm(groupKeyring(nodeUrl, identity, groupId, groupKeyStore(nodeUrl)));
    return approveWithEpoch(nodeUrl, identity, groupKeyStore(nodeUrl), groupId, memberPubkey, { memberPubkey, action: 'approve' },
        onProgress ? { onProgress } : undefined);
}

export async function inviteGroupMemberApi(groupId: string, memberPubkey: string, role: GroupRole = 'member'): Promise<any> {
    // With the status: a refusal (403) is said in the node's words (utils/group-invite-send.ts).
    return signedRequestWithMethod('POST', `/api/groups/${encodeURIComponent(groupId)}/members`, {
        memberPubkey,
        role,
        action: 'invite'
    }, { withStatus: true });
}

export async function setGroupMemberRoleApi(groupId: string, memberPubkey: string, role: GroupRole): Promise<any> {
    return signedRequestWithMethod('PATCH', `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberPubkey)}`, {
        role
    });
}

/**
 * The lead convenor hands the lead on (2026-09-23). The target must be an active convenor, or an active member
 * who becomes a convenor in the same step. Nobody can take the lead off the lead, so this is the only way it
 * moves by hand.
 */
export async function handOverGroupLeadApi(groupId: string, targetPubkey: string): Promise<any> {
    return signedRequestWithMethod('POST', `/api/groups/${encodeURIComponent(groupId)}/lead`, {
        targetPubkey,
    });
}

/**
 * The quiet-lead vote (2026-09-23). A group's lead cannot be removed or demoted by anyone, so a lead who has gone
 * quiet — or whose account a node admin has suspended — leaves the group stuck; the 30-day-silence vote is its way
 * out. The rules are the server's alone (apps/server/src/engine/group-succession.ts); these three calls are all a
 * screen needs, and `silence`, `proposals` and `canPropose` are what it may read.
 *
 * Signed, and for group members only. A node older than the route answers 404 and this throws RouteMissingError,
 * which is the screen's cue to show nothing at all rather than an error about a feature that community lacks.
 */
export async function fetchGroupSuccession(groupId: string): Promise<GroupSuccessionData> {
    const path = `/api/groups/${encodeURIComponent(groupId)}/succession`;
    const res = await signedGet(path);
    if (res.status === 404) throw new RouteMissingError(path);
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        let message = `Could not read the lead vote (${res.status})`;
        try { message = JSON.parse(txt)?.error || message; } catch { if (txt) message = refusalTextOf(res.status, txt, message); }
        throw new Error(message);
    }
    return await res.json();
}

/** Propose one member of the electorate as the new lead. Proposing yourself is allowed; it counts as your yes. */
export async function proposeGroupSuccessionApi(groupId: string, candidatePubkey: string): Promise<any> {
    return _signedRequest(`/api/groups/${encodeURIComponent(groupId)}/succession/propose`, { candidatePubkey });
}

/** Yes or no, once. The server refuses a second vote; nothing here can change one. */
export async function voteGroupSuccessionApi(groupId: string, proposalId: string, choice: 'yes' | 'no'): Promise<any> {
    return _signedRequest(
        `/api/groups/${encodeURIComponent(groupId)}/succession/${encodeURIComponent(proposalId)}/vote`,
        { choice },
    );
}

/**
 * Leave a group (your own key), or remove a member (a convenor, someone else's). A removal IS the chat's rotation: the
 * convenor's phone makes a key for everyone but the removed member, in the same request (§2.4). Leaving carries none:
 * the node marks the key stale and the next member to write makes a new one.
 */
export async function leaveGroupApi(groupId: string, memberPubkey: string, onProgress?: (done: number, total: number) => void, community?: ChatCommunity): Promise<boolean> {
    // `community`: the member's own leave of a group in place (slice S6). Anyone else's removal is that community's own page.
    const { nodeUrl, identity, store, handle } = await groupContextFor(groupId, community);
    if (community && memberPubkey !== identity.publicKey) throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
    const ring = groupKeyring(nodeUrl, identity, groupId, store);
    // Under the group's own id (lower-case), as its epochs are: a removal carries one (#1841 review, finding 3).
    const path = `/api/groups/${encodeURIComponent(ring.groupId)}/members/${encodeURIComponent(memberPubkey)}`;
    if (memberPubkey !== identity.publicKey) await refuseGroupKeysForDm(ring);
    const res = memberPubkey === identity.publicKey
        ? await signedRequestWithMethod('DELETE', path, undefined, { anchorUrl: nodeUrl })
        : await removeWithEpoch(nodeUrl, identity, store, groupId, memberPubkey, async (body) => {
            const bodyString = JSON.stringify(body);
            const headers = await buildSignedHeaders('DELETE', `${nodeUrl}${path}`, bodyString, identity.privateKey, identity.publicKey);
            return fetch(`${nodeUrl}${path}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: bodyString });
        }, onProgress ? { onProgress } : undefined);
    if (res?.success) {
        try {
            // In the file of the group's community only (nodeUrl, which the request went to): none once the phone switched.
            const database = await handle();
            if (database) await database.runAsync('DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?', [groupId, memberPubkey]);
        } catch (dbErr) {
            console.warn('[SQLite] Failed to remove group member locally:', dbErr);
        }
        // I left: the group's photos this phone opened go with its chat (DESIGN-group-chat-photos-fable.md §2.4).
        if (memberPubkey === identity.publicKey) await forgetGroupPhotos(ring.groupId);
    }
    return Boolean(res?.success);
}

export async function updateGroupApi(groupId: string, data: {
    name?: string;
    description?: string;
    avatarUrl?: string;
    category?: string;
    joinPolicy?: JoinPolicy;
}): Promise<{ success: boolean; group: GroupItem }> {
    // A group's name or about are words for its id (no screen sends one today: GroupDetailModal sends joinPolicy): a known
    // DM's id refuses first; a held group never waits, as createPost (#1938 confirmation 9).
    if ((data.name || data.description) && !(await isHeldGroupChat(groupId))) await refuseReadableIntoDm(groupId);
    return signedRequestWithMethod('PATCH', `/api/groups/${encodeURIComponent(groupId)}`, data);
}

export async function deleteGroupPostApi(groupId: string, postId: string): Promise<boolean> {
    const res = await signedRequestWithMethod('DELETE', `/api/groups/${encodeURIComponent(groupId)}/posts/${encodeURIComponent(postId)}`);
    if (res?.success) {
        try {
            const database = await getDb();
            await database.runAsync('DELETE FROM posts WHERE id = ?', [postId]);
            await database.runAsync('DELETE FROM post_photos WHERE post_id = ?', [postId]);
            const { DeviceEventEmitter } = require('react-native');
            DeviceEventEmitter.emit('sync_data_updated');
        } catch (dbErr) {
            console.warn('[SQLite] Failed to delete group post locally:', dbErr);
        }
    }
    return Boolean(res?.success);
}

// ===================== YOUR GROUPS & GROUP CHAT (groups slice 2) =====================
// Every call is signed and served only to the member; nothing here is cached on the phone.

/** GET /api/your-groups: every group, enterprise and event chat the member is in, newest first. */
export async function fetchYourGroups(): Promise<import('./your-groups').YourChatsResponse> {
    const res = await signedGet('/api/your-groups');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || 'Could not load your groups.');
    return { items: Array.isArray(body?.items) ? body.items : [], totalUnread: Number(body?.totalUnread || 0) };
}

/**
 * Another community's "Your groups" for its member (slice S6): one signed read of that community's own list, at the address
 * the caller names (held-chats.ts: a community this phone holds as a member, never a guest's look), for Chat's rows there.
 * Nothing is written to any copy; the groups and events it names are noted as that community's for this run ({@link holdsAsThread}). A
 * picture its node stored is that community's, never the one in use's. Null: not asked, not answered, or the account left
 * the phone meanwhile (ownListRead).
 */
export async function fetchHeldYourGroups(myPubkey: string, community: string, signal?: AbortSignal): Promise<import('./your-groups').YourChat[] | null> {
    // Signed by the account on the phone: never by another that signed in since this one's list was wanted.
    if ((await loadIdentity().catch(() => null))?.publicKey !== myPubkey) return null;
    const asked = ownListRead(myPubkey);
    try {
        const res = await signedGet('/api/your-groups', { anchorUrl: community, signal });
        if (!res.ok) return null;
        const body = await res.json();
        if (!(await asked.still()) || !Array.isArray(body?.items)) return null;
        const items = (body.items as import('./your-groups').YourChat[]).filter((c) => c && typeof c.conversationId === 'string');
        const there = `${myPubkey}\n${getDatabaseFilenameForNode(community)}`;
        const groups = new Set(items.filter((c) => c.kind === 'group').map((c) => c.conversationId));
        groupsListedThere.set(there, groups);
        eventsListedThere.set(there, new Set(items.filter((c) => c.kind === 'event' && !groups.has(c.conversationId)).map((c) => c.conversationId)));
        return items.map((c) => ({ ...c, avatarUrl: onCommunity(community, c.avatarUrl) }));
    } catch (e: any) {
        console.warn(`[Held] Could not read the groups of ${getDatabaseFilenameForNode(community)}: ${e?.message || e}`);
        return null;
    }
}

/** A group's chat as the member sees it. Throws the node's own message. */
export async function getGroupChat(groupId: string, limit = 50, offset = 0, community?: ChatCommunity): Promise<any> {
    // The community it is asked of, its address and its key memory, taken before the ask: what its answer says is kept there.
    // None in use with no account or address on the phone: asked as any signed-out read is, and no locked answer is handed on.
    const asked = await groupContextFor(groupId, community).catch((e) => { if (community) throw e; return null; });
    const res = await signedGet(`/api/groups/${encodeURIComponent(groupId)}/chat?limit=${limit}&offset=${offset}`, { anchorUrl: asked?.nodeUrl });
    const body = await res.json().catch(() => ({}));
    // The status goes with it: 403 or 404 is the node refusing someone not in the group now, not a failed read. A phone that
    // held the group's keys then takes the group's opened photos off, as the words are no longer served to it (§2.4).
    if (!res.ok) {
        if ((res.status === 403 || res.status === 404) && asked && await ringOf(asked, groupId).holdsKeys().catch(() => false)) await forgetGroupPhotos(groupId);
        throw Object.assign(new Error(body?.error || 'Could not open this group chat.'), { status: res.status });
    }
    if (chatIsLocked(body)) {
        if (!asked) {
            noteAnsweredLocked(groupId);
            throw new Error('No identity found. You must be logged in.');
        }
        await noteGroupLocked(asked, groupId, community);
    }
    forgetRemovedGroupPhotos(groupId, body?.messages);
    forgetRemovedVoices(body?.messages);
    return body;
}

/**
 * Send a photo in a group's chat (DESIGN-group-chat-photos-fable.md §2.2): its caption sealed as part 'body' and the photo
 * as part 'attachment' under the line's one message key and the keyring's epoch, both sealed again on a 409
 * (utils/group-chat-lines.ts sendSealedGroupLine). Only ever sealed: a known DM is refused before any key is asked; when the
 * node serves no keys, a group this phone held keys of is refused in the phone's lock words, and one it never held is
 * refused with an old node's notice (a node from before locked chats, §2.6) or as a chat it isn't in. Nothing goes then.
 */
export async function postGroupChatPhoto(
    groupId: string, photo: { dataUri: string; caption: string; clientId?: string; replyToId?: string | null },
    lock?: { after?: string | null; mentionCandidates?: { pubkey: string; callsign: string | null | undefined }[]; onProgress?: (done: number, total: number) => void },
): Promise<any> {
    const asked = await groupContextFor(groupId, undefined);
    const { nodeUrl, identity, store } = asked;
    const ring = ringOf(asked, groupId);
    await refuseGroupKeysForDm(ring);
    try {
        return await sendSealedGroupLine(nodeUrl, identity, store, {
            groupId, text: photo.caption, photo: photo.dataUri, clientId: photo.clientId || Crypto.randomUUID(), replyToId: photo.replyToId,
            after: lock?.after, mentionCandidates: lock?.mentionCandidates, progress: lock?.onProgress ? { onProgress: lock.onProgress } : undefined,
        });
    } catch (e) {
        // A 404 is an old node (no keys route) or a new one refusing this phone the group: never a reason to send it readable.
        if (e instanceof GroupKeysRequestError && e.status === 404) {
            if (await ring.seenLocked()) throw await heldGroupRefusal(asked, groupId);
            if (await nodeChatIsUnlocked(asked, groupId)) throw new GroupChatKeyError(GROUP_CHAT_OLD_NODE_NOTICE, 'refused');
            throw new GroupChatKeyError(GROUP_CHAT_NOT_MEMBER_TEXT, 'not_member');
        }
        throw e;
    }
}

/**
 * Send a line in a group's chat. With `lock` (the chat is locked), or once this phone has held a key of this group or seen it locked
 * whatever the node's answer says (review of #1788, finding 4): sealed on this phone under the group's key
 * (utils/group-chat-lines.ts sendSealedGroupLine), or refused with a sentence. Otherwise a node from before locked chats,
 * which takes `{ text }` as it always did (§14.3).
 */
export async function postGroupChatMessage(
    groupId: string, text: string, clientId?: string, replyToId?: string | null,
    lock?: { after?: string | null; mentionCandidates?: { pubkey: string; callsign: string | null | undefined }[]; onProgress?: (done: number, total: number) => void },
    community?: ChatCommunity,
): Promise<any> {
    const asked = await groupContextFor(groupId, community);
    const { nodeUrl, identity, store, at } = asked;
    const ring = ringOf(asked, groupId);
    await refuseGroupKeysForDm(ring, at);
    const locks = await ring.locksSends();
    if (locks || lock) {
        try {
            return await sendSealedGroupLine(nodeUrl, identity, store, {
                groupId, text, clientId: clientId || Crypto.randomUUID(), replyToId, after: lock?.after, mentionCandidates: lock?.mentionCandidates,
                progress: lock?.onProgress ? { onProgress: lock.onProgress } : undefined,
            });
        } catch (e) {
            if (e instanceof GroupKeysRequestError && e.status === 404 && (locks || await ring.seenLocked())) throw await heldGroupRefusal(asked, groupId, community);
            throw e;
        }
    }
    const to = await readableLineTo(asked, groupId);
    return _signedRequest(`/api/groups/${encodeURIComponent(groupId)}/chat/message`, { text, clientId, replyToId: replyToId || undefined }, to);
}

/**
 * The groups a history path may touch (sync, post a self-wrap or a top-up): never a conversation this phone knows as a DM
 * and never held a group's keys for (refuseGroupKeysForDm, confirmation 2 of #1788, finding 2). Each comes back under
 * ring.groupId, the group's id lower-cased, so the routes, records and top-ups agree with its one keyring (#1841).
 */
async function historyGroups(nodeUrl: string, identity: BeanPoolIdentity, groups: readonly HistoryGroup[]): Promise<HistoryGroup[]> {
    const out: HistoryGroup[] = [];
    for (const g of groups) {
        try {
            const ring = groupKeyring(nodeUrl, identity, g.id, groupKeyStore(nodeUrl));
            await refuseGroupKeysForDm(ring);
            out.push({ ...g, id: ring.groupId });
        } catch { /* a known DM: no group keys under its id */ }
    }
    return out;
}

/**
 * A group history from before this member changed phones (utils/group-history-unlock.ts; DESIGN-group-history-after-
 * rekey-fable.md §3, §4): the old 12 words, typed here, over every group of this account.
 */
export async function unlockGroupHistoryWithWords(typed: string | readonly string[], groups: HistoryGroup[], onProgress?: (done: number, total: number) => void): Promise<OldWordsResult> {
    const { nodeUrl, identity } = await groupKeyContext();
    const r = await unlockWithOldWords({ nodeUrl, identity, store: groupKeyStore(nodeUrl), groups: await historyGroups(nodeUrl, identity, groups), typed, signedHere: await oldKeySignedHere(nodeUrl, identity), onProgress });
    // A group whose keys landed and wasn't withheld shows no locked row once its chat reloads; forget its count now, so a
    // later run doesn't name it as withheld.
    for (const id of Object.keys(r.unlocked)) if (!r.withheld.some((g) => g.id === id)) await noteLockedHistoryCount(nodeUrl, identity.publicKey, id, 0);
    return r;
}

/** Per group (id lower-cased), the lines its chat last showed in the "from before you changed phones" row (§7). */
export async function lockedHistoryRows(): Promise<Record<string, number>> {
    const { nodeUrl, identity } = await groupKeyContext();
    return lockedHistoryCounts(nodeUrl, identity.publicKey);
}

/** The chat view's row count for one group as it shows it now (0 when there is no row). */
export async function noteLockedHistoryRow(groupId: string, n: number): Promise<void> {
    const { nodeUrl, identity } = await groupKeyContext();
    await noteLockedHistoryCount(nodeUrl, identity.publicKey, groupId, n);
}

/** The code this new phone shows a member to confirm it (§4), or null when this phone knows no old key of its own. */
export async function newPhoneCode(): Promise<string | null> {
    const { nodeUrl, identity } = await groupKeyContext();
    let old = await oldKeySignedHere(nodeUrl, identity);
    if (!old) {
        const listed = (await rekeysToMe(nodeUrl, identity)).filter((r) => r.attested);
        old = listed.length === 1 ? listed[0].pubkey : null;
    }
    return old ? newPhoneQrPayload(identity, old) : null;
}

/** A member's phone checks a scanned new-phone code (§4), over every group of this account. */
export async function checkScannedNewPhone(scanned: string, groups: HistoryGroup[]): Promise<NewPhoneCheck> {
    const { nodeUrl, identity } = await groupKeyContext();
    return checkNewPhone({ nodeUrl, identity, groups: await historyGroups(nodeUrl, identity, groups), scanned });
}

/** "Confirm" (§4): hand the confirmed phone the epochs whose record names the old key this phone remembers. */
export async function confirmScannedNewPhone(check: Extract<NewPhoneCheck, { ok: true }>, onProgress?: (handed: number, planned: number) => void) {
    const { nodeUrl, identity } = await groupKeyContext();
    return confirmNewPhone({ nodeUrl, identity, store: groupKeyStore(nodeUrl), check: { ...check, groups: await historyGroups(nodeUrl, identity, check.groups) }, onProgress });
}

/** While this new phone's code is on screen (§4): the keys other members had already handed it, to compare with later. */
export async function newPhoneHandOvers(groups: HistoryGroup[]): Promise<Set<string>> {
    const { nodeUrl, identity } = await groupKeyContext();
    return handOversHeld(nodeUrl, identity, groupKeyStore(nodeUrl), await historyGroups(nodeUrl, identity, groups));
}

/** The members who confirmed this phone since `before`, kept as local notes; every note, newest first. */
export async function newPhoneConfirmedNotes(before: Set<string> | null, groups: HistoryGroup[]): Promise<ConfirmedNote[]> {
    const { nodeUrl, identity } = await groupKeyContext();
    if (!before) return confirmedNotes(nodeUrl, identity.publicKey);
    return noteConfirmations({ nodeUrl, identity, store: groupKeyStore(nodeUrl), groups: await historyGroups(nodeUrl, identity, groups), before });
}

/**
 * This phone's chats with people in other communities, for one community (utils/outside-chat-store.ts): that community's own
 * file only. Once the phone has switched to another community, every call throws rather than read the other file.
 */
export function outsideStore(nodeUrl: string): OutsideChatStore {
    const file = getDatabaseFilenameForNode(nodeUrl);
    return outsideChatStore(async () => {
        const database = await getDb();
        if (dbFileOf.get(database) !== file) throw new Error('This phone has switched community since this chat was opened.');
        return database as any;
    });
}

/**
 * This phone's chats with people in other communities kept in `community`'s file, wherever the phone is set (slice S4,
 * scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3: "Same file, same rule, visible always"; no data moves). Each
 * read and write goes through chatCopyForRequest(community), taken afresh for that statement: the copy in use while that
 * community is the one in use, else its copy open in place (slice S2: a connection on that one file, only while a screen or a
 * round holds it, enterChatInPlace ... leaveChatInPlace). So a write lands in that file only, a switch mid-way included (onto
 * that community: the copy in use, the same file; away from it: its copy open in place, the same file), and when neither can
 * be had (a chat left, a close under way, the copy gone) it throws and nothing is written anywhere.
 */
export function outsideStoreOf(community: string): OutsideChatStore {
    const file = getDatabaseFilenameForNode(community);
    return outsideChatStore(async () => {
        const copy = await chatCopyForRequest(community);
        if (copy.file !== file || dbFileOf.get(copy.database) !== file) throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
        return copy.database as any;
    });
}

/**
 * The forum's kept copies for one community (utils/forum-kept.ts): that community's own file only. Once the phone has switched
 * to another community, every call throws rather than read or write the other file.
 */
export function forumKept(nodeUrl: string): ForumKeptStore {
    const file = getDatabaseFilenameForNode(nodeUrl);
    return forumKeptStore(async () => {
        const database = await getDb();
        if (dbFileOf.get(database) !== file) throw new Error('This phone has switched community since the forum was opened.');
        return database as any;
    });
}

const _groupKeyStores = new Map<string, GroupKeyStore>();
/**
 * This phone's group key store for one community (SQLite, that community's own file: utils/group-chat-store.ts). It reads
 * and writes only that file: once the phone has switched to another community, every call throws (the keyring refuses,
 * GROUP_KEY_STORE_UNREAD_TEXT) rather than read the other file and take a held group for never held (confirmation 2 of
 * #1788, finding 1). While a chat of that community is held in place (slice S6, chatsInPlaceHeld), it is that community's
 * copy open in place, that same file; let go, it throws again. And it throws while an account is leaving the phone, or if one
 * has begun to since the call (account-leaving.ts): nothing of the keys of an account that left is in a copy made since (N1).
 */
export function groupKeyStore(nodeUrl: string): GroupKeyStore {
    const file = getDatabaseFilenameForNode(nodeUrl);
    let s = _groupKeyStores.get(file);
    if (!s) {
        s = sqliteGroupKeyStore(async () => {
            const stays = accountStays();
            // A group's chat held in place (slice S6): its own community's copy, or the copy in use once the phone is there.
            const database = chatsInPlaceHeld.has(file) ? (await chatCopyForRequest(nodeUrl)).database : await getDb();
            if (dbFileOf.get(database) !== file) throw new Error(SWITCHED_SINCE_CHAT_OPENED_TEXT);
            if (!stays()) throw new Error('an account is leaving this phone');
            return database as any;
        }, file);
        _groupKeyStores.set(file, s);
    }
    return s;
}

/**
 * A conversation this phone knows as a DM, and has never held a group's keys for, gets no group keys here: nothing is
 * posted, edited, joined or rotated under its id as a group's. Group keys are what make a group held, and a held group
 * is asked first everywhere, so this keeps a known DM from ever becoming one (confirmation 2 of #1788, finding 2). The pins
 * are asked strictly (§3.4 amendment 7 §3 iv, "refusing when unreadable"), as an unreadable list already refuses here:
 * pins that can't be read throw DmPinStoreError, so a pinned DM the node relists as a locked group while they can't be read
 * gets no keys, and so never becomes a held group that outranks its pin for good (#1938 confirmation 7, finding 1). A
 * group whose keys this phone holds never asks; a locked group it never held waits until the pins can be read. `at` (slice
 * S6): a group of a chat in place, whose own community's copy, pins and list are the ones asked.
 */
async function refuseGroupKeysForDm(ring: GroupKeyring, at?: SQLite.SQLiteDatabase): Promise<void> {
    if (await ring.holdsKeys()) return;
    if (await isKnownDmInAnySpelling(ring.groupId, { pinsMustRead: true, at })) throw new GroupChatKeyError(GROUP_KEYS_FOR_DM_TEXT, 'refused');
}

/**
 * Before every readable send, the node reading the words (an old node's group post and edit, an event's chat, an enterprise's
 * thread from either screen): a known DM refuses, its pins asked strictly as the DM screen's send asks them (§3.4 amendment
 * 7 §3 iv, "refusing when unreadable"). Pins that can't be read throw DmPinStoreError, so nothing readable goes on the
 * list's word alone: a DM the full list never took, relisted by the node as one of these chats while the pins couldn't be
 * read, opens in that chat's own screen, and its next line went out readable (#1938 confirmation 6, finding 1).
 */
async function refuseReadableIntoDm(conversationId: string, at?: SQLite.SQLiteDatabase): Promise<void> {
    if (await isKnownDmConversation(conversationId, { pinsMustRead: true, at })) throw new GroupChatKeyError(GROUP_KEYS_FOR_DM_TEXT, 'refused');
}

async function groupKeyContext(): Promise<{ nodeUrl: string; identity: BeanPoolIdentity }> {
    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node.');
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found. You must be logged in.');
    return { nodeUrl: anchorUrl.replace(/\/+$/, ''), identity };
}

/** Where a group's chat is read, sealed and sent ({@link groupContextFor}). */
interface GroupContext {
    nodeUrl: string;
    identity: BeanPoolIdentity;
    store: GroupKeyStore;
    /** In place (slice S6): that community's copy, whose rows, pins and DM list guard the group's id. Undefined: the copy in use. */
    at?: SQLite.SQLiteDatabase;
    /** The copy a write after a network await reaches: that community's only, else null and nothing is written. */
    handle(): Promise<SQLite.SQLiteDatabase | null>;
    /** Whether no account has begun to leave the phone since it was asked (account-leaving.ts accountStays). */
    stays(): boolean;
}

/**
 * The community a group's chat lives in, for one call (slice S6): `community`'s own address, key store and copy, only for a
 * group that community's copy or list holds ({@link onlyThreadInPlace}; refused before anything is asked otherwise); left
 * out, the community in use, as before. `kinds`: an event's chat, or either, instead.
 */
async function groupContextFor(groupId: string, community: ChatCommunity, kinds: readonly ThreadKind[] = ['group']): Promise<GroupContext> {
    if (!community) {
        const stays = accountStays();
        const { nodeUrl, identity } = await groupKeyContext();
        return { nodeUrl, identity, store: groupKeyStore(nodeUrl), handle: () => copyStillFor(getDatabaseFilenameForNode(nodeUrl)), stays };
    }
    return groupContextAt(await onlyThreadInPlace(await chatCopyForRequest(community), groupId, kinds));
}

/** A chat request's copy as a group's context: the one community the request goes to, its key store and its copy. */
async function groupContextAt(here: ChatRequestCopy): Promise<GroupContext> {
    const stays = accountStays();
    if (!here.anchorUrl) throw new Error('You are off-grid. Please connect to a BeanPool Node.');
    const identity = await loadIdentity();
    if (!identity) throw new Error('No identity found. You must be logged in.');
    const nodeUrl = here.anchorUrl.replace(/\/+$/, '');
    return { nodeUrl, identity, store: groupKeyStore(nodeUrl), at: here.inPlace ? here.database : undefined, handle: here.handle, stays };
}

/** A group's keyring in the community `asked` was taken for (shared for the session). */
const ringOf = (asked: GroupContext, groupId: string): GroupKeyring => groupKeyring(asked.nodeUrl, asked.identity, groupId, asked.store);

/** The address a group's read goes to (`kinds`: an event's): `community`'s own in place (only for a chat held there), else the one in use (undefined). */
async function groupAddressOf(groupId: string, community: ChatCommunity, kinds?: readonly ThreadKind[]): Promise<string | undefined> {
    return community ? (await groupContextFor(groupId, community, kinds)).nodeUrl : undefined;
}

/** One group's keyring on this node, for this identity (shared for the session: the opened keys with it). */
export async function groupKeyringFor(groupId: string, community?: ChatCommunity): Promise<GroupKeyring> {
    const { nodeUrl, identity, store } = await groupContextFor(groupId, community);
    return groupKeyring(nodeUrl, identity, groupId, store);
}

/**
 * The keyring a group's screen opens, syncs and serves missing keys from (components/GroupChatView.tsx): refused with
 * GROUP_KEYS_FOR_DM_TEXT for a conversation this phone knows as a DM and never held a group's keys for, so no key is
 * synced onto a known DM's id whichever route drew the screen (#1815 review E3b, made structural; #1841 review, finding 1).
 */
export async function groupScreenKeyringFor(groupId: string, community?: ChatCommunity): Promise<GroupKeyring> {
    const { nodeUrl, identity, store, at } = await groupContextFor(groupId, community);
    const ring = groupKeyring(nodeUrl, identity, groupId, store);
    await refuseGroupKeysForDm(ring, at);
    return ring;
}

/** An enterprise's discussion thread — public to every member of the community, not only its keepers. */
export async function getEnterpriseChat(treasury: string, limit = 50): Promise<any> {
    const res = await signedGet(`/api/enterprise/${encodeURIComponent(treasury)}/thread?limit=${limit}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || 'Could not open this enterprise chat.');
    if (chatIsLocked(body)) noteAnsweredLocked(treasury);
    return body;
}

export async function postEnterpriseChatMessage(treasury: string, text: string, clientId?: string): Promise<any> {
    const to = await readableChatAddress(treasury);
    return _signedRequest(`/api/enterprise/${encodeURIComponent(treasury)}/thread/message`, { text, clientId }, to);
}

/**
 * People who can be invited to a group: the node's own directory (it already leaves out enterprises and other
 * treasury accounts), without the system account. Falls back to the phone's copy when offline.
 */
export async function getInvitablePeople(options?: { membersOnDemand?: boolean }): Promise<{ publicKey: string; callsign: string; avatarUrl: string | null }[]> {
    const notPeople = (pk: string) => pk === 'SYSTEM' || pk.startsWith('escrow_');
    // On a community that says `membersOnDemand` the whole list is never read (15 MB at 30k members): the cards held,
    // and the sheet's search asks the node (DESIGN-global-members-by-area §2.3).
    if (options?.membersOnDemand) {
        const held = await getAllCommunityMembers();
        return held.filter(m => !notPeople(m.publicKey)).map(m => ({ ...m, avatarUrl: null }));
    }
    try {
        const res = await signedGet('/api/community/members');
        if (res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows)) {
                return rows
                    .filter((m: any) => m?.publicKey && !notPeople(m.publicKey) && m.status !== 'pruned')
                    .map((m: any) => ({ publicKey: m.publicKey, callsign: m.callsign || m.publicKey.slice(0, 8), avatarUrl: m.avatarUrl ?? null }))
                    .sort((a, b) => a.callsign.localeCompare(b.callsign, undefined, { sensitivity: 'base' }));
            }
        }
    } catch { /* offline: the phone's copy below */ }
    const local = await getAllCommunityMembers();
    return local.filter(m => !notPeople(m.publicKey)).map(m => ({ ...m, avatarUrl: null }));
}

/**
 * Mute one chat for 8 hours, a week or always, or unmute it (groups decision 12). Works for a DM as well
 * as a group-like chat, so the ⋮ menu is the same menu in both.
 */
export async function muteChatApi(conversationId: string, duration: '8h' | '1w' | 'always' | 'off', community?: ChatCommunity): Promise<any> {
    // Kept by the chat's own community (slice S2: a chat open in place is muted there, by its own server), and in place only
    // a direct chat or (slice S6) a group's or an event's that community holds (#3305 review F1): nothing asked or remembered for any other id.
    const here = await onlyChatInPlace(await chatCopyForRequest(community), conversationId);
    const res = await _signedRequest('/api/messages/mute', { conversationId, duration }, here.anchorUrl);
    rememberChatMute(conversationId, duration === 'off' ? null : (res?.mute ?? { conversationId, mutedUntil: null, always: duration === 'always' }));
    return res;
}

/**
 * What the node last said about a chat's mute, remembered from whichever read went past it.
 *
 * A DM has no row of its own on the phone to hold this (a group's mute rides on its "Your groups" row), and
 * opening a chat must not cost an extra request to find out. The conversations sync and the per-conversation
 * read both carry it once the node is new enough; an older node never sets it and the menu simply offers
 * Mute, which is the truthful default.
 */
const _knownChatMutes = new Map<string, import('./your-groups').YourChatMute | null>();

export function rememberChatMute(conversationId: string, mute: import('./your-groups').YourChatMute | null): void {
    _knownChatMutes.set(conversationId, mute);
}

export function getKnownChatMute(conversationId: string): import('./your-groups').YourChatMute | null {
    return _knownChatMutes.get(conversationId) ?? null;
}

/**
 * Delete for everyone (chat parity, 2026-09-23). The author only, any time, no window — the node turns the
 * message into a tombstone and pushes it to everyone in the chat, and a DM's ciphertext is replaced on the
 * node so both phones pick it up on their next sync. Deleting twice is a no-op success.
 *
 * A convenor removing SOMEBODY ELSE'S message is the separate call below; the two are told apart by
 * `metadata.removedBy`.
 */
export async function deleteMessageApi(messageId: string, community?: ChatCommunity, groupId?: string): Promise<any> {
    // Asked of the community whose file holds the line, and mirrored there only (chatCopyForRequest). In place, only a line
    // of a direct chat that community's copy holds (#3305 review F1), or of the group `groupId` there (slice S6).
    const here = await onlyLineInPlace(await chatCopyForRequest(community), messageId, groupId);
    const res = await _signedRequest('/api/messages/delete', { messageId }, here.anchorUrl);
    // Mirror the tombstone locally at once (a DM's row is on this phone) so the bubble changes under the
    // finger rather than at the next 3s poll. A group chat has no local row and simply re-reads. Once the phone has
    // switched community meanwhile, nothing is mirrored: that community's next sync brings the tombstone.
    try {
        const database = await here.handle();
        const row = !database ? null : await database.getFirstAsync<any>('SELECT metadata, author_pubkey FROM messages WHERE id = ?', [messageId]);
        if (row && database) {
            let meta: any = {};
            if (row.metadata) { try { meta = JSON.parse(row.metadata) || {}; } catch { meta = {}; } }
            delete meta.reactions; delete meta.mentions; delete meta.replyToId;
            meta.removed = true;
            meta.removedBy = res?.message?.metadata?.removedBy || row.author_pubkey;
            meta.removedAt = res?.message?.metadata?.removedAt || new Date().toISOString();
            await database.runAsync(
                "UPDATE messages SET type = 'removed', ciphertext = ?, nonce = 'plaintext-v1', metadata = ? WHERE id = ?",
                [res?.message?.ciphertext ?? encodeBase64(encodeUtf8('This message was deleted')), JSON.stringify(meta), messageId]
            );
        }
    } catch { /* the node has it; the next sync brings the tombstone anyway */ }
    // The plaintext photo goes with the message, whether or not the local mirror above found a row: a group
    // chat has no local row, and its image was decrypted into the same cache.
    await forgetCachedChatImage(messageId);
    return res;
}

/** A convenor removes somebody else's message from a group chat. Unchanged endpoint, now reachable from the chat. */
export async function removeGroupChatMessage(groupId: string, messageId: string, community?: ChatCommunity): Promise<any> {
    return _signedRequest(`/api/groups/${encodeURIComponent(groupId)}/chat/remove`, { messageId }, await groupAddressOf(groupId, community));
}

/**
 * Report one line of a direct message to the community's moderators (core dm-line-report.ts): the sealed line as this phone
 * holds it, its sender's signature, and `words`, what it reads as here. No key goes, and nothing else of the chat.
 */
export async function reportDmLine(conversationId: string, messageId: string, words: string, reason: string, community?: ChatCommunity): Promise<any> {
    // `community`: a request or chat of another community this phone holds (slice S3): the line is read from that
    // community's copy, only a line of a direct chat it holds (#3305 review F1), and the report goes to its moderators.
    // Left out: the community in use, its copy and address taken together (chatCopyForRequest).
    const here = await onlyLineInPlace(await onlyDmInPlace(await chatCopyForRequest(community), conversationId), messageId);
    const row = await here.database.getFirstAsync<any>('SELECT ciphertext, nonce, metadata, conversation_id FROM messages WHERE id = ?', [messageId]);
    if (!row || (here.inPlace && row.conversation_id !== conversationId)) throw new Error('Message not found');
    try {
        return await _signedRequest('/api/messages/report', {
            messageId, reason,
            disclosure: dmLineDisclosureFor({ ciphertext: row.ciphertext, nonce: row.nonce, conversationId }, words),
        }, here.anchorUrl);
    } catch (e: any) {
        throw reportRefusal(e);
    }
}

/**
 * Report one line of a locked group chat to the community's moderators, with its key (group chat photos S6;
 * utils/group-chat-lines.ts reportSealedGroupLine): the key opens that one message and nothing else. Its group keys are
 * refused for an id this phone knows as a DM, as an edit's are. The member's words go as any report's do, unless the guard
 * can't let them (reportReasonFor, case 14): then the picked reason goes alone, and `wordsLeftOut` says why for the
 * "Reported" dialog (reportedAlertBody).
 */
export async function reportGroupChatLine(groupId: string, messageId: string, view: GroupLineView | null | undefined, reason: string, community?: ChatCommunity): Promise<any> {
    const { nodeUrl, identity, store, at } = await groupContextFor(groupId, community);
    await refuseGroupKeysForDm(groupKeyring(nodeUrl, identity, groupId, store), at);
    const sending = await reportReasonFor(groupId, reason, at);
    const res = await reportSealedGroupLine(nodeUrl, identity, store, { groupId, messageId, view, reason: sending.reason });
    return sending.wordsLeftOut ? { ...res, wordsLeftOut: sending.wordsLeftOut } : res;
}

/**
 * Edit a line in a group's chat. A locked chat (`line.locked`, the screen's word), or one whose keys this phone has held
 * whatever the node now says (director's decision b): sealed under the line's own epoch (utils/group-chat-lines.ts), or
 * refused. Only a node from before locked chats, which this phone never saw locked, takes base64 `plaintext-v1`.
 */
export async function editThreadMessage(messageId: string, newText: string, line: { groupId: string; metadata: any; locked: boolean }, community?: ChatCommunity): Promise<any> {
    const asked = await groupContextFor(line.groupId, community);
    const { nodeUrl, identity, store, at } = asked;
    const ring = ringOf(asked, line.groupId);
    await refuseGroupKeysForDm(ring, at);
    if (await ring.locksSends() || line.locked) {
        try {
            return await editSealedGroupLine(nodeUrl, identity, store, { groupId: line.groupId, messageId, metadata: line.metadata, text: newText });
        } catch (e) {
            // Only the edit route answers 404 here (a keys sync that fails is retried as "no key"): the line, not the keys.
            if (e instanceof GroupKeysRequestError && e.status === 404) throw await editRefusal(asked, line.groupId, community);
            throw e;
        }
    }
    const to = await readableLineTo(asked, line.groupId);
    return _signedRequest('/api/messages/edit', {
        messageId,
        ciphertext: encodeBase64(encodeUtf8(newText)),
        nonce: 'plaintext-v1',
    }, to);
}

/**
 * One group as the member sees it, for the invite landing: null when the node says not found, and the node's own
 * message (or "could not reach") thrown otherwise, so the page can tell "not available" from "no signal".
 */
export async function getGroupForLanding(id: string): Promise<GroupItem | null> {
    const res = await signedGet(`/api/groups/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body !== 'object') throw new Error(body?.error || 'Could not reach the node.');
    return body as GroupItem;
}

/** A group's active members (the faces on the invite landing). Throws when the node could not be reached. */
export async function getGroupActiveMembers(id: string): Promise<GroupMemberItem[]> {
    const res = await signedGet(`/api/groups/${encodeURIComponent(id)}/members?status=active`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || 'Could not load the members.');
    return Array.isArray(body) ? body : [];
}

/**
 * Move this member's read marker on a node-readable chat (group, enterprise) to now. Unlike markConversationRead
 * it is not throttled — callers send it only when there is something new to read — and it resolves once the node
 * has it, so "Your groups" can drop the count knowing a later refresh agrees.
 */
export async function markThreadReadOnNode(conversationId: string, myPubkey: string, community?: ChatCommunity): Promise<void> {
    // In place (slice S6): only a group or an event held there, marked on its own server; its row's count is that server's own list's.
    const anchorUrl = await groupAddressOf(conversationId, community, ['group', 'event']);
    if (!community) markConversationReadLocally(conversationId, myPubkey, community).catch(() => { });
    await _signedRequest('/api/messages/mark-read', { pubkey: myPubkey, conversationId }, anchorUrl);
}

