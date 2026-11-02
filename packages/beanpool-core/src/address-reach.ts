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
 * `no-longer-ours`: a former or lost name that doesn't answer as this server, which nobody should chase. `stopped`: blocked,
 * or paused by the BeanPool project, which alone lifts either. `paused`: paused by the address service on its own, which this
 * server asks back by itself.
 */
export type AddressStep = 'fine' | 'new-name' | 'no-dns-beanpool' | 'no-dns-own' | 'no-answer' | 'from-inside' | 'another-server'
    | 'something-else' | 'certificate' | 'home-network' | 'home-network-from-here' | 'no-longer-ours'
    | 'awaiting-approval' | 'stopped' | 'paused';

/** What a DNS lookup saw for a host name (node:dns A, AAAA, CNAME). */
export interface DnsSeen {
    outcome: 'answers' | 'no-such-name' | 'failed';
    a: string[];
    aaaa: string[];
    cname: string[];
}

/** One address reachability result, as the report and Addresses screen show it. */
export interface AddressReach {
    answers: AddressAnswer | null;
    ownAt: string | null;
    checkedAt: string;
    dns: DnsSeen | null;
    step: AddressStep;
    /** How long ago a `new-name` was made. */
    minutes: number | null;
    /** The step's sentence in English; the screens draw it with addressNextStep in their reader's language. */
    nextStep: string;
}

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
    awaitingApproval: word('Awaiting approval by the BeanPool project. It moves over by itself once approved.'),
    stopped: word('Stopped by the address service. Ask the BeanPool project.'),
    paused: word('Paused by the address service: something else answered at this name. Your server asks for it back by itself.'),
    /** The `/check` page, opened from outside: who answered, where, by which key, and when. */
    pageHereAt: word('This is {name} at {host}.'),
    pageHere: word('This is {name}.'),
    pageKey: word('Server key {key}'),
    pageTime: word('Time {time}'),
} as const;

/** Words for the Addresses screen (apps/manager, design §5.2). */
export const ADDRESS_SCREEN_WORDS = {
    screenTitle: word('Addresses'),
    screenIntro: word('Every address members and browsers reach this community at, whether it answers from outside, and what to do next.'),
    checkNow: word('Check now'),
    checking: word('Checking…'),
    checkedAt: word('Checked from this server at {time}'),
    checkFromPhone: word('Check from your phone'),
    addAddress: word('Add an address'),
    makeMain: word('Make main'),
    mainBadge: word('main'),
    colAddress: word('Address'),
    colPointsAt: word('Points at'),
    colPointsAtLabel: word('Points at:'),
    colAnswers: word('Answers from outside'),
    colAnswersLabel: word('Answers from outside:'),
    colAppsToday: word('Apps today'),
    colCanSign: word('Apps can sign'),
    colNextStep: word('Next step'),
    kindBeanPool: word('BeanPool name'),
    kindNumber: word("this server's number"),
    kindDomain: word('your own domain'),
    pointsTunnelConnected: word("Cloudflare, then this server's tunnel (connected)"),
    pointsTunnelDisconnected: word("Cloudflare, then this server's tunnel (disconnected)"),
    pointsTunnelRetrying: word("Cloudflare, then this server's tunnel (retrying)"),
    pointsTunnelStarting: word("Cloudflare, then this server's tunnel (starting)"),
    pointsTunnelOff: word("Cloudflare, then this server's tunnel (off)"),
    pointsNoDns: word('no DNS answer yet'),
    answersAnswered: word('answered as this server {time}'),
    answersNotFound: word('no answer: name not found'),
    answersAnother: word('answers as another server'),
    answersTls: word('certificate not trusted'),
    answersOther: word('something else answers'),
    answersSilence: word('no answer'),
    answersHome: word('on a home network'),
    signYes: word('yes'),
    signNotAdvertised: word('yes, not advertised'),
    signLost: word('no (lost)'),
    appsCount: wordn('{n} app today', '{n} apps today'),
    choiceBeanPool: word('a free BeanPool name'),
    choiceNumber: word("this server's number"),
    choiceDomain: word('your own domain'),
    recoveryReminder: word("A .beanpool.org name belongs to this server's key. Make sure you keep a recovery code in Backups, so a new server can keep the name if this server is ever lost."),
    badgeFormer: word('Former'),
    badgeLost: word('Lost'),
    release: word('Release'),
    remove: word('Remove'),
    checkedFromOutside: word('Addresses checked from outside.'),
    stillChecking: word('Still checking, press again in a moment.'),
    checkedAlready: word('Already checked at {time}. Press again in half a minute for a new check.'),
    nothingChecked: word('Nothing could be checked from this server yet.'),
    /** Said in place of the full sentence beside a name's standing, which says what to do: never "Nothing to do" there. */
    reachFine: word('Answers as this server.'),
    reachNoLonger: word("No longer this community's address."),
    /** Remove on a BeanPool name: it only leaves what this community advertises. Release is what gives a name up. */
    removeNameQuestion: word("This community stops advertising {address}, and no name is given up. While its key holds {address}, members' apps that use it are still accepted. If the key doesn't hold it, they are refused after this."),
    removeNameMain: word("It is this community's address now. After this, new members are sent to another of its addresses, if it has one."),
    removedName: word('{address} is no longer advertised. No name was given up.'),
    /** Make main answered with anything but live: a claim stores the answer (routes/public-address.ts), so this server has moved. */
    notMainYet: word('{address} is not the main address yet: the address service says {status}. This server has moved to it and keeps asking for it, so the panel below now shows it.'),
    membersStillAt: word('Members still reach this community at {current}.'),
    /** What an admin reads where an owner is told to press Add an address, which is an owner's. */
    noAddressOwnerAdds: word('No public address currently assigned. An owner of this community can add one.'),
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
        case 'awaiting-approval': return w.t(W.awaitingApproval);
        case 'stopped': return w.t(W.stopped);
        case 'paused': return w.t(W.paused);
    }
}
