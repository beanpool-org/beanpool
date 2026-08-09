/**
 * Keeper enrolment — splitting a new member's words and handing the pieces out.
 *
 * Runs silently immediately after invite redemption, before step 3 of the wizard is drawn
 * (docs/ONBOARDING.md Part 0). Step 3 does not ask anyone to enrol; it reports what they ended
 * up with. That ordering is the whole reason the screen can open with good news.
 *
 * ## Which keepers a member actually gets
 *
 * Never assumed, always counted. The doc's three states exist because the count genuinely
 * varies: K1 is absent for PWA users and anyone whose phone has no cloud backup, and K3 is
 * absent on bulk and admin invites where nobody human did the inviting. A screen that claimed
 * three keepers to a member who has two would be lying to exactly the people who most need the
 * truth, which is what {@link KeeperEnrolmentResult.enrolled} exists to prevent — it reports
 * what was achieved, not what was attempted.
 *
 * ## Why this can decline to do anything
 *
 * The first thing it does is run {@link checkRecoveryWorksHere}. If the split does not survive
 * a round trip on this device, enrolling would write fragments that cannot rebuild the phrase
 * and then tell the member they are covered — the precise false-success this model exists to
 * remove. Better to enrol nobody and leave them on their twelve words, which is exactly as
 * protected as every member is today.
 *
 * ## Ordering
 *
 * The device fragment is written to disk BEFORE the generation is uploaded. K1's bytes live on
 * the phone and nowhere else — the node records only that the keeper exists — so a phone that
 * failed to write the file while the node recorded the keeper would leave a member counted as
 * 3-of-N while actually holding 2. The reverse ordering costs nothing: a written file with no
 * matching generation is an orphan the next enrolment overwrites.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
// expo-file-system 55.x defaults to the new File/Paths API; the classic documentDirectory +
// writeAsStringAsync surface lives behind /legacy, which is what the rest of this app uses
// (db.ts, settings.tsx, ledger.tsx). Matching them rather than being the one file on the new API.
import * as FileSystem from 'expo-file-system/legacy';
import {
    RECOVERY_THRESHOLD,
    checkRecoveryWorksHere,
    recordShareForHub,
    sealShareToMember,
    splitRecoveryPhrase,
    type SealedShare,
} from '@beanpool/core';
import { buildSignedHeaders, encodeBase64 } from './crypto';
import type { BeanPoolIdentity } from './identity';

/** Where K1 lives. A plain file, deliberately — see {@link writeDeviceFragment}. */
export const DEVICE_FRAGMENT_FILE = 'beanpool-recovery-piece.bin';

/** The keeper kinds this function can enrol. K4 is a separate, user-initiated flow. */
export type EnrolledKeeper = 'device' | 'hub' | 'member';

export interface KeeperEnrolmentResult {
    /** Keepers that actually received a piece. The step 3 state is chosen by counting this. */
    enrolled: EnrolledKeeper[];
    /** The node's generation number, or null if nothing was uploaded. */
    generation: number | null;
    /** Why a keeper was not enrolled — for logs and for deciding what step 3 offers next. */
    skipped: { keeper: string; reason: string }[];
    /** Set when enrolment did not happen at all. For logs, never for a member. */
    error?: string;
}

interface InviterCandidate {
    eligible: boolean;
    reason?: string;
    publicKey?: string;
    callsign?: string;
}

async function anchorUrl(): Promise<string | null> {
    return AsyncStorage.getItem('beanpool_anchor_url');
}

async function signedPost(
    url: string, path: string, body: unknown, identity: BeanPoolIdentity,
): Promise<Response> {
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders(
        'POST', path, bodyString, identity.privateKey, identity.publicKey,
    );
    return fetch(`${url}${path}`, { method: 'POST', headers, body: bodyString });
}

/**
 * Ask the node whether this member has an inviter who can hold a piece (K3).
 *
 * The node answers rather than the client guessing, because "who invited you" resolves through
 * cases the client cannot see — a founder, an admin, or a bulk invite all leave a member with
 * no human inviter, and each is a legitimate 2-keeper outcome rather than an error.
 */
async function inviterKeeper(
    url: string, identity: BeanPoolIdentity,
): Promise<InviterCandidate> {
    try {
        const res = await signedPost(url, '/api/recovery/keeper-candidates', {}, identity);
        if (!res.ok) return { eligible: false, reason: `node returned ${res.status}` };
        const body = await res.json() as { inviter?: InviterCandidate };
        return body.inviter ?? { eligible: false, reason: 'none' };
    } catch (e) {
        return { eligible: false, reason: (e as Error).message };
    }
}

/**
 * Write K1 to a plain file in the app's document directory.
 *
 * Deliberately unencrypted and behind no hardware key. Revisions 1 and 2 of this model tried to
 * sync a *secret* through platform backup and both mechanisms were broken — iCloud Keychain
 * sync needs an attribute `expo-secure-store` does not expose, and Android SecureStore encrypts
 * with a non-exportable Keystore key, so Auto Backup captures a blob whose key never leaves the
 * old device. Storing a fragment in the clear is what makes K1 work at all: a single piece
 * reveals nothing, so there is nothing here for a key to protect. Secrecy is not load-bearing;
 * the threshold is.
 */
async function writeDeviceFragment(fragment: Uint8Array): Promise<string | null> {
    try {
        const dir = FileSystem.documentDirectory;
        if (!dir) return 'no document directory on this platform';
        await FileSystem.writeAsStringAsync(
            `${dir}${DEVICE_FRAGMENT_FILE}`,
            encodeBase64(fragment),
            { encoding: FileSystem.EncodingType.UTF8 },
        );
        return null;
    } catch (e) {
        return (e as Error).message;
    }
}

/**
 * Split this member's words and hand the pieces to whoever can hold one.
 *
 * Never throws. A caller is running this in the background of a wizard step, and an exception
 * escaping would break signup over a feature that is meant to be an improvement layered on top.
 */
export async function enrolKeepers(identity: BeanPoolIdentity): Promise<KeeperEnrolmentResult> {
    const skipped: { keeper: string; reason: string }[] = [];
    const nothing = (error: string): KeeperEnrolmentResult =>
        ({ enrolled: [], generation: null, skipped, error });

    const words = identity.mnemonic;
    if (!words || words.length === 0) {
        // A legacy identity from before seed phrases. There is nothing to split, and that is a
        // fact about the account rather than a failure of this device.
        return nothing('this identity has no recovery words to split');
    }

    const url = await anchorUrl();
    if (!url) return nothing('no node configured yet');

    // Before anything is written or uploaded. See the note at the top of the file.
    const deviceCheck = await checkRecoveryWorksHere();
    if (!deviceCheck.ok) {
        return nothing(`recovery does not work on this device (${deviceCheck.failedAt}: ${deviceCheck.detail})`);
    }

    const inviter = await inviterKeeper(url, identity);
    if (!inviter.eligible) skipped.push({ keeper: 'member', reason: inviter.reason ?? 'none' });

    // The hub and the phone are always available on native; the inviter may not be. Counted
    // rather than assumed, because the split has to be sized to the keepers that exist — asking
    // for more fragments than there are holders leaves pieces nobody keeps.
    const holders: EnrolledKeeper[] = ['device', 'hub'];
    if (inviter.eligible && inviter.publicKey) holders.push('member');

    if (holders.length < RECOVERY_THRESHOLD) {
        // Two keepers cannot rebuild a 3-of-N split, so there is no point writing one. The
        // member stays on their words and step 3 says so plainly — State B in the doc, where
        // sign-in is the third keeper rather than a bonus.
        return nothing(
            `only ${holders.length} keepers available, threshold is ${RECOVERY_THRESHOLD}`,
        );
    }

    let fragments: Uint8Array[];
    try {
        fragments = await splitRecoveryPhrase(words.join(' '), holders.length);
    } catch (e) {
        return nothing(`could not split the phrase: ${(e as Error).message}`);
    }

    // Device first, and its failure is fatal to the whole enrolment rather than a skip: the
    // count this returns decides what the member is TOLD, and a phone that silently holds no
    // piece while the node thinks it does is the one arrangement nobody can detect later.
    const deviceError = await writeDeviceFragment(fragments[0]);
    if (deviceError) return nothing(`could not store this phone's piece: ${deviceError}`);

    const shares: (SealedShare & { holderType: string; holderRef: string; shareIndex: number })[] = [];
    try {
        // shareIndex is 1-based and must match the fragment's position in the split — the node
        // enforces uniqueness but cannot check the correspondence, because it cannot read them.
        shares.push({
            holderType: 'device', holderRef: 'self', shareIndex: 1,
            // The bytes stay on the phone. The node records that the keeper exists, nothing more,
            // and REFUSES a device fragment that arrives with ciphertext.
            encryptedShare: '', shareIv: '', shareTag: '', kdfParams: '',
        });
        shares.push({
            holderType: 'hub', holderRef: 'node', shareIndex: 2,
            ...recordShareForHub(fragments[1]),
        });
        if (inviter.eligible && inviter.publicKey) {
            shares.push({
                holderType: 'member', holderRef: inviter.publicKey, shareIndex: 3,
                ...sealShareToMember(fragments[2], inviter.publicKey),
            });
        }
    } catch (e) {
        return nothing(`could not seal the pieces: ${(e as Error).message}`);
    }

    try {
        const res = await signedPost(url, '/api/recovery/shares', { shares }, identity);
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            return nothing(`node refused the fragments (${res.status}): ${detail.slice(0, 200)}`);
        }
        const body = await res.json() as { generation?: number };
        return { enrolled: holders, generation: body.generation ?? null, skipped };
    } catch (e) {
        return nothing(`could not reach the node: ${(e as Error).message}`);
    }
}
