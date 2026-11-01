/**
 * A community's new main name, beside an address that keeps working (rename S1, design
 * scratch/fable-design/DESIGN-rename-primary-name-fable.md §2, §4).
 *
 * A claim that replaces where the community lived keeps the old address (engine/own-addresses.ts keepReplacedAddress), and
 * leaves the members' notice due. They are told once, when the new name is where the community lives (primaryAddress) and
 * they can reach it: at the claim when it answers live, or when a gated claim is approved, whichever of the public-address
 * agent's tick and Settings' status read finds that first, and for a name on this server's tunnel not before that tunnel
 * connects (tunnel-connector.ts tellMembersWhenReachable). Until then nothing is true to say: the name has no route yet.
 * The due name is kept in this server's local config, so a restart before then does not lose it; a standby takes none
 * over and tells nobody.
 *
 * The notice is an announcement like any other: the push is the fixed line for `community.notice`, in the phone's language
 * (@beanpool/core push-notice.ts), with no address in it. These words, with the name in them, are the notice's details,
 * in English as every notice a node writes is.
 *
 * Not sent when the old address does not keep working: a live tunnel name replaced goes dark, as the server runs one
 * connector, until one connector per name (slice S2). routes/public-address.ts says the critical words for that one.
 */

import { word, wordsFor } from '@beanpool/core';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { adminBroadcastAnnouncement, getNodeConfig } from '../state-engine.js';
import { keepReplacedAddress, primaryAddress } from '../engine/own-addresses.js';
import { registrarHostOf } from '../engine/registrar-names.js';

// The words layer in English (a node never writes in the device language: core words.test N11).
const { t: tr } = wordsFor('en');

const NOTICE = {
    title: word('This community has a new address'),
    body: word('This community is also at {address}. The old address keeps working.'),
};

function setDue(host: string | null): void {
    if ((getLocalConfig().addressNoticeDue ?? null) !== host) updateLocalConfig({ addressNoticeDue: host });
}

/**
 * Whether a claim of `claimed`, once stored, takes this server's live tunnel name dark: it runs one connector, so another
 * name stored stops that name's tunnel, until slice S2. A direct name's record stays at the address service. Asked before
 * the stored address changes.
 */
export function claimTakesTunnelDark(claimed: string): boolean {
    const pa = (getNodeConfig() as any).publicAddress;
    return !!pa?.name && pa.status === 'live' && pa.mode !== 'direct' && registrarHostOf(pa) !== claimed;
}

/**
 * A claim of `claimed` answered, by Settings or the public-address agent, before it is recorded and stored: keeps the
 * address it replaces, and leaves the members' notice due unless that address goes dark. Returns the address replaced, or
 * null when the claim replaces none. A claim of the name already stored replaces nothing and leaves the notice alone: the
 * form stays on screen while a tunnel retries, and that name may yet be told. Any other claim that replaces none ends a
 * notice left due by an earlier claim: its name is not on its way any more.
 */
export function claimReplacesAddress(claimed: string): string | null {
    if (registrarHostOf((getNodeConfig() as any).publicAddress) === claimed) return null;
    const replaced = keepReplacedAddress(claimed);
    setDue(replaced && !claimTakesTunnelDark(claimed) ? claimed : null);
    return replaced;
}

/** The name a notice was due for was taken offline, so the members are never told of it. */
export function forgetAddressNotice(): void {
    setDue(null);
}

/** Tells the members, once, if a notice is due and its name is where the community lives now. Never throws. */
export function tellMembersOfNewAddress(): void {
    const address = getLocalConfig().addressNoticeDue;
    if (!address || primaryAddress() !== address) return;
    setDue(null);
    try {
        adminBroadcastAnnouncement(tr(NOTICE.title), tr(NOTICE.body, { address }), 'info');
    } catch (e: any) {
        console.warn('[PublicAddr] The members could not be told of the new address:', e?.message || e);
    }
}
