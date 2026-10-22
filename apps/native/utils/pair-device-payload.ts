/**
 * The account as "Link a device" seals it for the other device (app/pair-device.tsx), and the name its sheet shows.
 *
 * A phone's copy of the account can hold no name: some joins and restores save it with none (draftIdentity(''), a
 * restore whose community named nobody), while the app shows the name from the community's member record. Such a phone
 * sent the empty name, and the browser refused the account (tester report, 22 Oct). The member record's name now goes in
 * its place; with none known the name goes empty, and the browser asks its community for it (WelcomePage). Only the
 * name: the key fields go exactly as stored, and the stored account is never written here.
 */

/** What pairingPayload needs of the stored account (BeanPoolIdentity). */
export interface PairingAccount {
    callsign: string;
    publicKey: string;
    privateKey: string;
    createdAt: string;
}

/**
 * The account's name for the community it goes to: the phone's copy's, or else `memberName` (the member record's there,
 * read on this phone), or ''. Never one made up.
 */
export function pairingName(storedName: string | null | undefined, memberName: string | null | undefined): string {
    if (typeof storedName === 'string' && storedName.trim()) return storedName;
    return typeof memberName === 'string' && memberName.trim() ? memberName : '';
}

/** What is sealed to the other device: the stored account with pairingName's name, and the 12 words when the phone has them. */
export function pairingPayload(identity: PairingAccount, mnemonic: string[] | null, memberName: string | null | undefined) {
    return {
        callsign: pairingName(identity.callsign, memberName),
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        mnemonic: mnemonic || undefined,
        createdAt: identity.createdAt,
        version: 1,
    };
}

/** The sheet's Account row: the name that is sent, or with none the key's short form (as the members list shows one). */
export function pairingAccountLabel(identity: Pick<PairingAccount, 'callsign' | 'publicKey'>, memberName: string | null | undefined): string {
    return pairingName(identity.callsign, memberName) || identity.publicKey.slice(0, 8);
}
