/**
 * What a node found when it checked one of its addresses from outside (apps/server services/address-check.ts; design
 * scratch/fable-design/DESIGN-dns-robustness-fable.md §5, §8 slice 1). One wording for everywhere it is shown: the node's
 * own `/check` page and report here, the owners' Addresses screen and the assistant's read after it.
 */
import { word, wordn, type TFunction, type TnFunction } from './words.js';

/**
 * What answered at the address: `own` this server's key; `other` another valid key; `other-origin` something that is no
 * attestation (a page, an origin's 404); `silence` nothing, or a Cloudflare error; `tls` a certificate a phone would refuse,
 * or a TLS handshake that failed.
 */
export type AddressAnswer = 'own' | 'other' | 'other-origin' | 'silence' | 'tls';

/**
 * The one next step the check leads to. `home-network`: nothing outside can reach it, by its shape. `home-network-from-here`:
 * a name this server reads as a home-network address, which says nothing of what phones outside reach (split DNS).
 * `no-longer-ours`: a former or lost name that doesn't answer as this server, which nobody should chase.
 */
export type AddressStep = 'fine' | 'new-name' | 'no-dns-beanpool' | 'no-dns-own' | 'no-answer' | 'from-inside' | 'another-server'
    | 'something-else' | 'certificate' | 'home-network' | 'home-network-from-here' | 'no-longer-ours';

/** The check's words, marked here and shown with t() where each is drawn. */
export const ADDRESS_CHECK_WORDS = {
    fine: word('Answers as this server. Nothing to do.'),
    newName: wordn(
        "Made {n} minute ago. Some networks remember 'no such name' for up to 30 minutes. Try mobile data, or wait.",
        "Made {n} minutes ago. Some networks remember 'no such name' for up to 30 minutes. Try mobile data, or wait.",
    ),
    noDnsBeanPool: word('No DNS answer for this name. The address service keeps its record and repairs it by itself. Still here after an hour? Ask the BeanPool project.'),
    noDnsOwn: word("No DNS answer for this name. Add or fix its A record where you run your domain's DNS."),
    noAnswer: word('No answer here, checked from this server. Open the check link on your phone, on mobile data, to see what members see.'),
    fromInside: word('Checked from inside this server. A home router can fail this while phones outside reach it. Open the check link on your phone, on mobile data.'),
    anotherServer: word("Another server answers here, with a key that isn't this server's. Check where this address points."),
    somethingElse: word('Something other than a BeanPool server answers here. Check where this address points.'),
    certificate: word('Answers, but not with a certificate phones trust. Check that port 80 is open and this address points at this server.'),
    homeNetwork: word("On a home network: nothing outside can reach it, so this server doesn't check it."),
    homeNetworkFromHere: word("From this server this name points at a home-network address, so it can't be checked from here. Open the check link on your phone, on mobile data."),
    noLongerOurs: word("No longer this community's address. Nothing to do."),
    /** The `/check` page, opened from outside: who answered, where, by which key, and when. */
    pageHereAt: word('This is {name} at {host}.'),
    pageHere: word('This is {name}.'),
    pageKey: word('Server key {key}'),
    pageTime: word('Time {time}'),
} as const;

/** The next step's sentence. `minutes`: how long ago a `new-name` was made. */
export function addressNextStep(step: AddressStep, minutes: number | null, w: { t: TFunction; tn: TnFunction }): string {
    const W = ADDRESS_CHECK_WORDS;
    switch (step) {
        case 'fine': return w.t(W.fine);
        case 'new-name': return w.tn(minutes ?? 1, W.newName.one, W.newName.other);
        case 'no-dns-beanpool': return w.t(W.noDnsBeanPool);
        case 'no-dns-own': return w.t(W.noDnsOwn);
        case 'no-answer': return w.t(W.noAnswer);
        case 'from-inside': return w.t(W.fromInside);
        case 'another-server': return w.t(W.anotherServer);
        case 'something-else': return w.t(W.somethingElse);
        case 'certificate': return w.t(W.certificate);
        case 'home-network': return w.t(W.homeNetwork);
        case 'home-network-from-here': return w.t(W.homeNetworkFromHere);
        case 'no-longer-ours': return w.t(W.noLongerOurs);
    }
}
