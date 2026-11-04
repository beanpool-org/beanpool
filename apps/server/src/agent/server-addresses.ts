/**
 * server_health's `addresses` (DNS robustness S6, design scratch/fable-design/DESIGN-dns-robustness-fable.md §5.3, §8 slice 6):
 * each address this community publishes, with what this server's own check round last found there (services/address-check.ts),
 * and the one next step in words an assistant passes on, the Addresses screen's sentence in English.
 *
 * What it carries is the `/check` page's rule (routes/check-page.ts): a host, a time and words. Each host is one this community
 * already publishes (`/api/community/info`; node_overview's addressHost is one of them). Never what a name points at (the
 * round's DNS answers: a server's number, a tunnel's name), another server's key or this one's, or when this server's key last
 * answered: Settings shows those, an assistant doesn't need them to say what to do.
 *
 * Only on the main server: a standby checks nothing (address-check.ts runRound), so its row says nothing of today, and its
 * server_health is what it was before this slice. An owner's grant and an admin's read the same list, as owners and admins read
 * the same report in Settings (routes/app-addresses.ts). Reading it asks nothing of the network and writes nothing.
 */
import type { AddressAnswer, AddressStep } from '@beanpool/core';
import { getNodeRole } from '../config/node-role.js';
import { isBeanPoolName, primaryAddress, publishedAddresses } from '../engine/own-addresses.js';
import { isIpLiteral } from '../engine/host-kinds.js';
import { addressReaches } from '../services/address-check.js';

export const SERVER_ADDRESS_KINDS = ['beanpool-name', 'number', 'own-domain'] as const;
export type ServerAddressKind = (typeof SERVER_ADDRESS_KINDS)[number];

/** A published address the round hasn't reached yet: just added, or the server only just started. */
export const NOT_CHECKED_STEP = 'not-checked';
/** MCP tool text, outside the words index (English: the assistant says it in its reader's language). */
export const NOT_CHECKED_WORDS = 'Not checked from this server yet: it checks every 15 minutes. '
    + 'An owner or admin can press Check now in Settings → Appliance & Data → Addresses.';

export interface ServerAddress {
    host: string;
    /** A beanpool.org name, this server's number, or a domain of the community's own. */
    kind: ServerAddressKind;
    /** Where the community lives now (primaryAddress): one at most. */
    main: boolean;
    /** What answered at the last check; null when it wasn't asked (a home-network address) or isn't checked yet. */
    answers: AddressAnswer | null;
    checkedAt: string | null;
    step: AddressStep | typeof NOT_CHECKED_STEP;
    nextStep: string;
}

const kindOf = (host: string): ServerAddressKind => (isBeanPoolName(host) ? 'beanpool-name' : isIpLiteral(host) ? 'number' : 'own-domain');

/** The published addresses, the main one first; null on a standby, which leaves the field out. */
export function serverAddresses(now = Date.now()): ServerAddress[] | null {
    if (getNodeRole() !== 'primary') return null;
    const reaches = addressReaches(now);
    const main = primaryAddress();
    const hosts = publishedAddresses();
    const ordered = main && hosts.includes(main) ? [main, ...hosts.filter((h) => h !== main)] : hosts;
    return ordered.map((host) => {
        const r = reaches.get(host);
        return {
            host,
            kind: kindOf(host),
            main: host === main,
            answers: r?.answers ?? null,
            checkedAt: r?.checkedAt ?? null,
            step: r?.step ?? NOT_CHECKED_STEP,
            nextStep: r?.nextStep ?? NOT_CHECKED_WORDS,
        };
    });
}
