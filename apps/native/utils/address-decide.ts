/**
 * What the phone does with what its community's addresses said (scratch/fable-design/DESIGN-several-addresses-fable.md
 * §3.2 to §3.5, slice S4; decided by Marty 16 Nov). Pure: no network, no storage. utils/address-verify.ts asks the
 * addresses and writes what this decides into the community's record (utils/community-record.ts).
 *
 * An address is the community's on this phone only when the community's own signed list names it AND it signed this
 * phone's fresh question with the community's key, at a take-over count no lower than the highest the phone has seen
 * (§3.2 "proved"). Only such an address is ever used. Per address, this round:
 *   - proved at the count, or higher: good (a higher count raises what the phone keeps);
 *   - proved at a lower count, or answered as anything else (another key, another address, an older question, no proof
 *     route, not on that server's list, a replaced server): dropped on this phone, never used (§7);
 *   - no answer: not yet; nothing changes for it.
 *
 * Then, from the state of the address in use, the main address and the others (§3.4):
 *   - in use answers as something else: `switch` at once to the main address if it is proved, else to another proved
 *     address, with a line; with none, `refuse` (nothing proved to go to);
 *   - in use no longer on the list: `follow` to the main address once it is proved, with the line; until then keep;
 *   - in use not answering for the 2 Nov card's time (5 minutes of tries, or at app open): `switch` to the main address or
 *     another proved one, with a line; with none, keep;
 *   - in use good: `follow` to the main address when it is another and proved: with the line when that main is new to
 *     this phone, quietly when it is the main the phone left for a while (§3.4 "On a second address, and main proves
 *     again"); else keep;
 *   - keep with addresses dropped this round is `drop`: the phone stays, and those addresses are refused.
 * One address answering with another key is dropped alone; the rest stay one community (Marty's pick 3).
 */

/** What one address said this round. */
export type AddressAnswer =
    /** It signed this phone's question with the community's key, naming this list number. */
    | { kind: 'proved'; epoch: number; seq: number }
    /** It answered, but not as the community for this question (why: for the record). */
    | { kind: 'other-key'; why: string }
    /** No answer. */
    | { kind: 'silent' };

export interface AddressSituation {
    /** The address in use (requests go there now). */
    using: string;
    /** The kept list's main address, and its addresses; null and none before a list is kept. */
    main: string | null;
    listed: readonly string[];
    /** The main address this phone last followed or stood on; another one is new to it. */
    mainSeen: string | null;
    /** The highest take-over count the phone has seen for the community. */
    epoch: number;
    /** Addresses proved before this round, with the take-over count each proved at. */
    proved: Readonly<Record<string, { epoch?: number }>>;
    /** What each address asked this round said; an address not asked is absent. */
    answers: Readonly<Record<string, AddressAnswer>>;
    /** The address in use has not answered for the 2 Nov card's time (5 minutes of tries, or no answer at app open). */
    silentDue: boolean;
}

export type AddressAction = 'keep' | 'follow' | 'switch' | 'drop' | 'refuse';

/** The one line Home shows after a move (§8): which sentence. */
export type AddressLineKind = 'followed' | 'left' | 'not-answering';

export interface AddressDecision {
    action: AddressAction;
    /** Where requests go from now: for `follow` and `switch`, else null. */
    to: string | null;
    /** The take-over count kept from now: never lower than before. */
    epoch: number;
    /** Addresses refused on this phone from this round. */
    drop: string[];
    /** Listed addresses that proved this round at `epoch`. */
    proved: string[];
    /** The line Home shows once, or null for none. */
    line: AddressLineKind | null;
}

/** Decide (the file's comment). */
export function decideAddress(s: AddressSituation): AddressDecision {
    let epoch = s.epoch;
    for (const a of Object.values(s.answers)) if (a.kind === 'proved' && a.epoch > epoch) epoch = a.epoch;
    const listed = new Set(s.listed);
    const drop: string[] = [];
    const provedNow: string[] = [];
    for (const [address, a] of Object.entries(s.answers)) {
        if (a.kind === 'other-key' || (a.kind === 'proved' && a.epoch < epoch)) drop.push(address);
        else if (a.kind === 'proved' && listed.has(address)) provedNow.push(address);
    }
    // Usable: on the list, not dropped or silent this round, and proved this round or before at the count kept now.
    const usable = (address: string): boolean => listed.has(address) && !drop.includes(address)
        && s.answers[address]?.kind !== 'silent'
        && (provedNow.includes(address) || (s.proved[address] !== undefined && (s.proved[address].epoch ?? 0) >= epoch));
    const mainOk = s.main !== null && s.main !== s.using && usable(s.main);
    const other = s.listed.find((a) => a !== s.using && a !== s.main && usable(a)) ?? null;
    const target = mainOk ? s.main : other;
    const out = (action: AddressAction, to: string | null, line: AddressLineKind | null): AddressDecision =>
        ({ action, to, epoch, drop, proved: provedNow, line });
    const keep = () => out(drop.length ? 'drop' : 'keep', null, null);

    if (drop.includes(s.using)) return target ? out('switch', target, 'left') : out('refuse', null, null);
    if (s.main !== null && !listed.has(s.using)) return mainOk ? out('follow', s.main, 'followed') : keep();
    if (s.answers[s.using]?.kind === 'silent') return s.silentDue && target ? out('switch', target, 'not-answering') : keep();
    if (mainOk) return out('follow', s.main, s.mainSeen === s.main ? null : 'followed');
    return keep();
}
