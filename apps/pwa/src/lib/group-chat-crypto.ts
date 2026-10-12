/**
 * group-chat-crypto — the one door every group-chat crypto call in the web app goes through (group chats slice 4; design
 * scratch/global-node/DESIGN-group-chat-encryption-fable.md §7, §16).
 *
 * Each function here is core's @noble code (packages/beanpool-core/src/group-crypto.ts): the same bytes the node checks
 * and the phone sends (apps/native/utils/group-chat-crypto.ts), pinned by core's vectors, which run against THIS module
 * in group-chat-crypto.test.ts. No web file imports core's group functions directly.
 *
 * Nothing here talks to the node or keeps anything: group-chat-keys.ts holds the keys (in memory only), and
 * group-line-display.ts decides what a line shows.
 */
import {
    makeGroupEpochRecordAsync,
    makeGroupEpochRecord as coreMakeGroupEpochRecord,
    openMyGroupKey,
    openGroupEpochRecord as coreOpenGroupEpochRecord,
    verifyGroupEpochRecord,
    groupEpochCoversExactly,
    makeGroupTopUp,
    verifyGroupTopUp,
    openGroupTopUp,
    sealGroupLine,
    openGroupLine,
    openGroupLineWithMessageKey,
    groupMessageKey,
    makeKeySuccession,
    verifyKeySuccession,
    walkKeySuccession,
    detectMentions,
    isGroupEncryptedNonce,
    GROUP_NONCE_PREFIX,
    GroupKeyNotVerifiedError,
    GroupLineNotVerifiedError,
    type FormerKey,
    type GroupEpochProgress,
    type GroupEpochReason,
    type GroupEpochRecord,
    type GroupKeyWrap,
    type GroupLineBinding,
    type GroupLinePart,
    type GroupLinePayload,
    type GroupLineVerifyMemo,
    type GroupServedWrap,
    type GroupTopUp,
    type MakeGroupEpochInput,
    type OpenedGroupLine,
} from '@beanpool/core';

export {
    groupEpochCoversExactly, detectMentions, isGroupEncryptedNonce, GROUP_NONCE_PREFIX, GroupKeyNotVerifiedError, GroupLineNotVerifiedError,
    verifyGroupEpochRecord, verifyGroupTopUp, openGroupTopUp, groupMessageKey, openGroupLineWithMessageKey, makeKeySuccession,
    verifyKeySuccession, walkKeySuccession,
};
export type {
    FormerKey, GroupEpochProgress, GroupEpochReason, GroupEpochRecord, GroupKeyWrap, GroupLineBinding, GroupLinePart, GroupLinePayload,
    GroupLineVerifyMemo, GroupServedWrap, GroupTopUp, MakeGroupEpochInput, OpenedGroupLine,
};

/** A new epoch: a fresh key wrapped to every recipient, signed. Yields every 10 wraps. */
export function makeEpochRecord(input: MakeGroupEpochInput, progress?: GroupEpochProgress): Promise<{ record: GroupEpochRecord; groupKey: Uint8Array }> {
    return makeGroupEpochRecordAsync(input, progress);
}

/** The served shape (GET …/keys): verify the record from its header, open my wrap, check the key against its commitment. */
export function openMyKey(record: GroupEpochRecord, wrap: GroupServedWrap, myEdPrivHex: string, groupId: string): Uint8Array {
    return openMyGroupKey(record, wrap, myEdPrivHex, { groupId, epoch: record.epoch });
}

/** Seal a line (words, an edit) as me under an epoch key. */
export function sealLine(text: string, input: Parameters<typeof sealGroupLine>[1]): GroupLinePayload {
    return sealGroupLine(text, input);
}

/** Open a line under an epoch key and verify its signer; `memo` keeps verdicts for the page's life. */
export function openLine(payload: GroupLinePayload, ref: GroupLineBinding, groupKey: Uint8Array, memo?: GroupLineVerifyMemo): OpenedGroupLine {
    return openGroupLine(payload, ref, groupKey, memo);
}

/** Hand a key I hold to a member who lacks a wrap for it, signed as me. */
export function makeTopUp(groupKey: Uint8Array, input: { myEdPrivHex: string; groupId: string; epoch: number; recipientPubHex: string }): GroupTopUp {
    return makeGroupTopUp(groupKey, input);
}

/** The whole module as core's vector checker sees it (checkGroupCryptoVectors): the same names and shapes as core's. */
export const groupCryptoForVectors = {
    makeGroupEpochRecord: coreMakeGroupEpochRecord,
    verifyGroupEpochRecord,
    openGroupEpochRecord: coreOpenGroupEpochRecord,
    openMyGroupKey,
    makeGroupTopUp,
    verifyGroupTopUp,
    openGroupTopUp,
    groupMessageKey,
    sealGroupLine,
    openGroupLine: (p: GroupLinePayload, r: GroupLineBinding, k: Uint8Array) => openGroupLine(p, r, k),
    openGroupLineWithMessageKey: (p: GroupLinePayload, r: GroupLineBinding, k: Uint8Array) => openGroupLineWithMessageKey(p, r, k),
    makeKeySuccession,
    verifyKeySuccession,
    walkKeySuccession,
};
