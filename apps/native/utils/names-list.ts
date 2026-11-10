/**
 * The names list, on an owner's or admin's phone (community modes slice 2; the server is apps/server/src/routes/
 * names-list.ts and engine/names-list.ts; the design is scratch/global-node/DESIGN-names-list-trust-fable.md).
 *
 * The flows themselves (the open, the sync, the locked copy, the asked actions, the entries, confirming, the log, the PDF
 * and every sentence the screen says) are shared with the web app: @beanpool/core names-list-flows.ts
 * (DESIGN-names-list-web-fable.md S1, moved from here unchanged). What stays here is the phone's side of them: where its
 * pin is kept ({@link DEVICE_NAMES_STORE}: AsyncStorage for the sealed blob, the secure store for its key), its signed
 * request to the member's own community (buildSignedHeaders, fetch), the community's address as this phone keeps it
 * (push-pins communityAddress), and its word for itself. Everything the screens and tests import from here is the same
 * as before the move.
 */
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createNamesFlows, type NamesPinStore, type NamesPlatform } from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
import { communityAddress } from './push-pins';
import { KEY_ITEM_OPTIONS, type BeanPoolIdentity } from './identity';

/** The phone's own stores. */
export const DEVICE_NAMES_STORE: NamesPinStore = {
    getItem: (k) => AsyncStorage.getItem(k),
    setItem: (k, v) => AsyncStorage.setItem(k, v),
    getSecret: (name) => SecureStore.getItemAsync(name),
    setSecret: (name, value) => SecureStore.setItemAsync(name, value, KEY_ITEM_OPTIONS),
};

/**
 * The phone's side of the flows: a request signed with the member's own key, for that host (the node's middleware checks
 * both), with no body and no Content-Type on a GET or DELETE; React Native's fetch, stopped by the flows' time limits.
 */
export const PHONE_NAMES_PLATFORM: NamesPlatform<BeanPoolIdentity> = {
    async call(anchorUrl, identity, method, path, body, signal) {
        const url = `${anchorUrl.replace(/\/+$/, '')}${path}`;
        const raw = method === 'GET' || method === 'DELETE' ? '' : JSON.stringify(body ?? {});
        const headers = await buildSignedHeaders(method, url, raw, identity.privateKey, identity.publicKey);
        if (method === 'GET' || method === 'DELETE') delete headers['Content-Type'];
        return fetch(url, { method, headers: { Accept: 'application/json', ...headers }, ...(raw ? { body: raw } : {}), signal });
    },
    address: (anchor) => communityAddress(anchor),
    store: DEVICE_NAMES_STORE,
    device: 'this phone',
};

/** The phone's flows: made once, so every names-list action on this phone shares one pin chain. */
const flows = createNamesFlows(PHONE_NAMES_PLATFORM);
export const {
    setNamesRequestTimeout, fetchNamesState, fetchNamesList, fetchNamesLog, fetchHealthExceptions, fetchHealthSummary,
    fetchHealthLog, confirmMember, secondConfirmation, revokeConfirmation, fetchVouchers, fetchVoucherCard,
    makeNamesVoucher, makeAdminVoucher, stopNamesVoucher, setVoucherBudget, deleteNamesEntry, setNamesSettings, namesTrustStoreKey,
    readNamesPinFrom, writeNamesPinTo, saveNamesCopiesBeforeLeaving, checkEachOther, unkeptRemovalsOf, removeOldKey,
    removeOldKeyAndOpen, openNamesList, makeKeyOnThisPhone, putHistoryBack, followServerHistory, startAfreshOnThisPhone,
    sendKeysAgain, addNamesEntry, inviteForNamesEntry, revokeEntryInvite, readBoundInvites, editNamesEntry, pendingRemovals, saveNamesEntry,
} = flows;

export {
    NAMES_PATH, offersNamesList, UNREACHABLE, NAMES_TIMED_OUT, NAMES_REQUEST_TIMEOUT_MS, NAMES_STATE_TIMEOUT_MS,
    NAMES_LIST_MS_PER_ENTRY, namesPinSecretName, COPY_REFUSED_CODES, NAMES_SIGN_OUT_REQUEST_MS, NAMES_SIGN_OUT_TOTAL_MS,
    namesSignOutWords, namesPinAddresses, myKeyCheck, inPersonResult, noticeWords, holdersWhoWillSend, holdersCheckedHere,
    openEntries, filterEntries, sealedFor, newEntryId, confirmationLimit, confirmableMembers, confirmationLine,
    confirmationActions, logLineText, shortDate, escapeHtml, namesListHtml, listKeyOf, firstSentence, NAMES_COPY,
    followRemovesAny, planWords,
    mergeNamesPins,
} from '@beanpool/core';
export type {
    NamesAdminRow, NamesState, NamesMyCopy, SealedEntryRow, ConfirmationStatus, ConfirmationRow, NamesListBody,
    NamesAction, NamesLogLine, NamesResult, VoucherSummaryRow, VoucherSettings, VoucherHistoryLine, VoucherPersonRow,
    VoucherCardData, VouchersBlockBody, VoucherCandidate, VoucherCandidates, NamesPinStore, NamesCopyUnconfirmed, EachOtherCheck, NamesOpened, OpenedEntry,
    CommunityMember,
} from '@beanpool/core';
