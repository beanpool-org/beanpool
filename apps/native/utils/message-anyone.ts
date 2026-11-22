/**
 * Message anyone, on the phone (slice S5 part 2: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Which path a
 * new chat takes", §6 row S5; Marty 19 Nov 2026, "yes to all 5"). Message on a contact or a New message result goes where
 * core's one rule says (@beanpool/core message-path.ts messagePathFor): an existing chat with that person wins, else the
 * community the phone shares with them (the one it is set to first), else a chat across, made from the contact's link.
 * Nothing switches, and no question is asked.
 *
 * The chats it weighs are the ones Chat lists, read by Chat's own readers (#3354 review): the community in use's direct chats
 * (db.ts getConversations, less any Talk hides: dm-blocked.ts talkShowsChat), each other held community's direct and across
 * chats (held-chats.ts heldChatsWith), and the across chats in the community in use's file (outside-mail.ts chatsShown), an
 * across chat only while Chat lists it, open or a request (core acrossChatListed). So nothing a block hid is reopened, and a
 * chat across the member declined (no composer, no Accept) is no existing chat: the community shared opens, or across
 * reopens it as an address card does. A read that fails counts as no chat there: the next rule then decides.
 *
 * Nothing it opens or makes is a chat the member can't write in now (#3354 review round 4, the rule's own invariant), and no
 * message goes to no one: a chat across counts only where its community takes messages from other communities and has an
 * address of its own to send from ({@link acrossRefusal}), and its person is for certain in no community the phone shares with
 * them (utils/community-homes.ts: one rule, every community with a claim to an address asked now). Where that can't be said
 * for certain, nothing opens: `switch`, what the contact offered before this slice, to go to the address itself.
 *
 * Nor in a held community that removed the member: it stays on this phone, its chats too, and its server refuses the account
 * everything (403). So one that decides where Message goes is asked how the account stands there ({@link standingNow}); where
 * it was removed, the rule goes on as for a community the phone doesn't hold, and a visitor there, or a member whose account
 * there is suspended, has only the direct chats already there. No answer: as this phone holds it, a member's.
 *
 * Nor across from the community in use where its server refuses the account's lines: a suspended member's, or no member's. It
 * is asked at the tap too, where a chat across there would be opened or made ({@link standsInUse}), since the app's own ask
 * (app/NodeStatusContext.tsx) isn't made after an ordinary switch. No answer: as it last said (utils/standing-here.ts), else a
 * member's. An account it closed is sent to the not-recognised screen by the app's own ask, and a new direct chat there is its
 * server's to refuse, with its words: none is made.
 *
 * On a guest's look (the phone set to a community it only visits as a guest, nodes.ts isGuestCopy) there is no community in
 * use (core's `setTo` null): nothing there is shared, and no chat across is weighed or made in its copy ({@link
 * openAcrossChat}). A direct chat the member already has there opens (a visitor's own row may write in it: core's `look`).
 *
 * A block is asked first, on every path ({@link blockedForMessage}): someone blocked on this phone's own list (the list
 * Chat reads; Marty 22 Nov, the S7 rule) is refused, with the words the across path already said, and nothing opens or is made.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FIND_WORDS, acrossChatListed, messagePathFor, t, whoseName, type KnownChat, type MessageLink, type MessagePath, type WhoseName } from '@beanpool/core';
import type { getConversations } from './db';
import { askedNow, doubted, keptAsOne, keptNames, keptNamesWith, type PhoneNames } from './community-homes';
import { readMembershipAnswer } from './membership-answer';
import type { NodeProfile } from './node-profile';
import { sameCommunity } from './push-pins';
import { noteStandingHere, suspendedHere } from './standing-here';

/** A chat of the community in use as Chat's list has it (db.ts getConversations): the fields Message reads. */
export type HereChat = Pick<Awaited<ReturnType<typeof getConversations>>[number], 'id' | 'type' | 'peerPubkey' | 'peerKeys'>;

/** The direct chats here with any of `keys`, from what Chat lists (`chats`, as getConversations returns them, less any `shows` hides). */
export function directChatsHere(chats: readonly HereChat[], keys: readonly string[], community: string, shows: (c: HereChat) => boolean): KnownChat[] {
    const want = new Set(keys);
    const out: KnownChat[] = [];
    for (const c of chats) {
        if (c.type !== 'dm' || !shows(c)) continue;
        // Every key Talk knows them by here (dm-blocked.ts talkShowsChat reads the same two fields).
        const theirs = new Set([...(Array.isArray(c.peerKeys) ? c.peerKeys : []), ...(c.peerPubkey ? [c.peerPubkey] : [])]);
        for (const key of theirs) if (want.has(key)) out.push({ kind: 'direct', community, id: String(c.id), key });
    }
    return out;
}

/**
 * Every chat Chat lists with any of `keys`: direct ones in the copy in use (`inFront`, the community the phone is set to, a
 * guest's look too) and in the other held communities, across ones in any of their files while Chat lists them (open or a
 * request; in the copy in use only as its `member`). Each source is read on its own: one that fails counts as no chat there,
 * and the others still count.
 */
export async function knownChatsWith(me: string, keys: readonly string[], { inFront, member }: { inFront: string | null; member: boolean }): Promise<KnownChat[]> {
    const want = new Set(keys);
    const directHere = async (): Promise<KnownChat[]> => {
        if (!inFront) return [];
        const db = await import('./db');
        const { talkShowsChat } = await import('./dm-blocked');
        const { getBlockedUsers } = await import('./blocklist');
        const [here, blocked] = await Promise.all([db.getConversations(me), getBlockedUsers()]);
        return directChatsHere(here, keys, inFront, (c) => talkShowsChat(c, blocked));
    };
    const held = async (): Promise<KnownChat[]> => (await import('./held-chats')).heldChatsWith(me, keys);
    const acrossHere = async (): Promise<KnownChat[]> => {
        if (!member) return [];
        const { outsideContext } = await import('./outside-chat-live');
        const { chatsShown } = await import('./outside-mail');
        const ctx = await outsideContext();
        return ctx ? (await chatsShown(ctx)).filter((c) => want.has(c.peerKey) && acrossChatListed(c.state))
            .map((c) => ({ kind: 'across' as const, community: null, id: c.id, key: c.peerKey, home: c.peerHome })) : [];
    };
    const none = (): KnownChat[] => [];
    return [...await directHere().catch(none), ...await held().catch(none), ...await acrossHere().catch(none)];
}

/**
 * Whether Message refuses this person (#3354 review), by any key `links` names them by: blocked on this phone's own list
 * (the list Chat, the across list, the address card and Contacts read). A block seen only on another community's own list
 * (a block made in that community's web app) does not refuse it: Marty, 22 Nov, keeping his S7 answer to question 2 (such a
 * block stops the quiet Accept and hides the request card, nothing more), so Message and Chats never disagree. Someone
 * blocked once and unblocked since is not refused either (only a quiet let in asks `once`). Null when the lists can't be
 * read: nothing opens on a guess.
 */
export async function blockedForMessage(me: string, keys: readonly string[]): Promise<boolean | null> {
    const { readBlockLists } = await import('./blocklist');
    const lists = await readBlockLists(me).catch(() => null);
    return lists ? keys.some((k) => lists.onPhone.has(k)) : null;
}

/** How long Message waits for a community's word on the account, as for its word on its names (outside-chat-live.ts answerNow). */
const STANDING_MS = 5_000;

/**
 * How the account stands in a community: a member; one that only answers, in a direct chat it has, starts none and sends
 * nothing across from there (a visitor's row, or a member whose account there is suspended); or removed (closed or retired
 * there, or its key replaced): its server takes nothing of it.
 */
export type Standing = 'member' | 'visitor' | 'suspended' | 'removed';

/** Whether an account so standing only answers, in the direct chats it has ({@link Standing}). */
const onlyAnswers = (standing: Standing | null | undefined): boolean => standing === 'visitor' || standing === 'suspended';

/** Whether a community takes no line across from an account so standing there ({@link Standing}; not known: it takes them). */
const sendsNothing = (standing: Standing | null | undefined): boolean => onlyAnswers(standing) || standing === 'removed';

/**
 * How the account stands in `community`, asked now (the membership probe, signed by its key: membership-probe.ts) and noted
 * (standing-here.ts). Null: no answer in time.
 */
export async function standingNow(me: string, community: string): Promise<Standing | null> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), STANDING_MS);
    try {
        const { fetchMembership } = await import('./membership-probe');
        const res = await fetchMembership(community, me, stop.signal);
        const body: unknown = await res.json().catch(() => null);
        const answer = readMembershipAnswer(res.status, body);
        if (answer) noteStandingHere(me, community, answer);
        if (answer?.kind === 'member') return answer.suspended ? 'suspended' : 'member';
        if (answer?.kind === 'closed') return 'removed';
        // A recovery under way there for this key: not settled, so as this phone holds it.
        if (answer?.kind === 'stranger') return answer.recovering ? null : 'visitor';
        return res.status === 403 && (body as { code?: unknown } | null)?.code === 'key_invalidated' ? 'removed' : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** How the account stands in the community in use, asked now ({@link standingNow}); with no answer, as that community last said. */
async function standsInUse(me: string, community: string): Promise<Standing | null> {
    return await standingNow(me, community) ?? (suspendedHere(me, community) ? 'suspended' : null);
}

/**
 * Where Message on a person goes from this phone: the block first ({@link blockedForMessage}), then core's rule over the
 * chats Chat lists ({@link knownChatsWith}). `held`: the other communities it holds as a member, in the order it lists
 * them (a guest's look among them is left out, and the community in use under another of its addresses). On a guest's look
 * the community in use is none (core's `setTo` null, the look its `look`). `nothing` too when the block lists can't be read.
 *
 * Whose an address is, is first taken from what needs no asking; what that leaves uncertain is asked now, of each community
 * with a claim to it, before anything but an existing chat is opened. Before anything is opened, an existing chat included,
 * each held community that changes where this goes is asked how the account stands there, once, and so is the one in use where
 * its chats across do; no other is.
 */
export async function messagePathOnPhone(me: string, links: readonly MessageLink[], held: readonly string[]): Promise<MessagePath> {
    const inFront = await anchorUrl();
    const look = inFront && await guestLook(inFront) ? inFront : null;
    const setTo = look ? null : inFront;
    const others: string[] = [];
    for (const h of held) {
        if (await guestLook(h)) continue;
        if (![...(inFront ? [inFront] : []), ...others].some((c) => keptAsOne(c, h))) others.push(h);
    }
    const keys = links.map((l) => l.key);
    const blocked = keys.length ? await blockedForMessage(me, keys) : false;
    if (blocked === null) return { open: 'nothing' };
    let names = await keptNames([...(inFront ? [inFront] : []), ...others]);
    // Each chat's community as this rule names it: the phone's own row, however the chat's reader spells it.
    const placed = (c: KnownChat): KnownChat => (c.community === null ? c : { ...c, community: names.find((n) => keptAsOne(n.community, c.community!))?.community ?? c.community });
    const chats = keys.length && !blocked ? (await knownChatsWith(me, keys, { inFront, member: setTo !== null })).map(placed) : [];
    const { outsideMessagesOn } = await import('./node-profile');
    let weighed: MessageLink[] = [...links];
    let whose = whoseOf(names);
    /** How the account stands in each community asked so far (null: no answer, so as this phone holds it: a member's). */
    const standing = new Map<string, Standing | null>();
    const over = (from: readonly string[], acrossHere: boolean): MessagePath => messagePathFor({
        links: weighed, chats, setTo, look, held: from, blocked, whose,
        // Not heard from yet: its chats across still count (only a community that says it takes none is left out).
        takesAcross: (c) => { const profile = profileOf(names, c); return (acrossHere || c !== setTo) && (!profile || acrossRefusal(profile, outsideMessagesOn) === null); },
    });
    /**
     * The rule over the communities the account may write in: a held one it was removed from is left out, and where it only
     * answers, only a direct chat there counts; the one in use stays, its chats across counted only where it takes the account's
     * lines. `without`: one that takes none, asked or not.
     */
    const path = (without: string | null = null): MessagePath => {
        const acrossHere = !(setTo && (without === setTo || sendsNothing(standing.get(setTo))));
        const from = others.filter((c) => c !== without && standing.get(c) !== 'removed');
        const to = over(from, acrossHere);
        return to.open === 'existing' && to.chat.kind === 'direct' ? to : over(from.filter((c) => !onlyAnswers(standing.get(c))), acrossHere);
    };
    /** {@link path}, once every community that would change it by taking none of the account's lines has been asked how the account stands there. */
    const settled = async (): Promise<MessagePath> => {
        for (;;) {
            const to = path();
            const asked = [...(setTo ? [setTo] : []), ...others].filter((c) => !standing.has(c) && JSON.stringify(path(c)) !== JSON.stringify(to));
            if (asked.length === 0) return to;
            await Promise.all(asked.map(async (c) => { standing.set(c, await (c === setTo ? standsInUse : standingNow)(me, c)); }));
        }
    };
    const first = path();
    if (first.open === 'blocked' || first.open === 'nothing') return first;
    if (first.open === 'existing') {
        const there = await settled();
        if (there.open === 'existing' || there.open === 'nothing') return there;
    }
    // Side by side: each community with a claim to an address, and what is known already of where the account may write.
    [names] = await Promise.all([
        askedNow(names, [...links.map((l) => l.community), ...chats.map((c) => (c.kind === 'across' ? c.home : null))]),
        settled(),
    ]);
    whose = whoseOf(names);
    // One after another: each held read closes the handles Chat doesn't need (held-chats.ts).
    weighed = [];
    for (const l of links) weighed.push(await doubted(names, l.community, l.key, inFront) ? { ...l, doubted: true } : l);
    return settled();
}

/** {@link whoseName}, each address worked out once: {@link messagePathOnPhone} weighs the same few several times over. */
function whoseOf(names: readonly PhoneNames[]): (address: string | null | undefined) => WhoseName {
    const of = whoseName(names);
    const known = new Map<string | null | undefined, WhoseName>();
    return (address) => {
        const got = known.get(address) ?? of(address);
        known.set(address, got);
        return got;
    };
}

/** A community's info among `names`: its answer now, else as this phone keeps it. */
function profileOf(names: readonly PhoneNames[], community: string): NodeProfile | null {
    return names.find((n) => n.community === community)?.profile ?? null;
}

/**
 * Why no chat across is made from `card` (the address card's check, Message's rule too), or null: its person is in the
 * community in use at `community` (`home`: its home as this phone signs as it, or null), where the direct chat is theirs; or
 * that community says it has no address of its own, so its server sends no line. Uncertain whose: null, the card's own box
 * as ever, whose line the server refuses, with words, where the address turns out to be its own.
 */
export async function cardRefusal(community: string, card: { key: string; home: string }, home: string | null): Promise<'here' | 'no-home' | null> {
    if (card.home === home) return 'here';
    const names = await askedNow(await keptNamesWith(community), [card.home]);
    const whose = whoseName(names)(card.home);
    if (whose.whose === 'one' && whose.community === community) return 'here';
    return profileOf(names, community)?.noHome ? 'no-home' : null;
}

/**
 * Why a community takes no messages across, by its info, or null: its switch is off (not heard from: taken as off), or it
 * says it has no address of its own (core saysNoHome: its server answers every send 503, so a line would stay "Sending…").
 */
function acrossRefusal(profile: NodeProfile | null, on: (features: NodeProfile['features'] | undefined) => boolean): 'off' | 'no-home' | null {
    return !on(profile?.features) ? 'off' : profile?.noHome ? 'no-home' : null;
}

/** What became of an across chat asked for: opened (its id); the person is in the community in use after all (`here`, their key); or why not (`uncertain`: whose the address is can't be said). */
export type AcrossOpened = { chatId: string } | { here: string } | { refused: AcrossRefused };
export type AcrossRefused = 'no-community' | 'off' | 'no-home' | 'not-member' | 'blocked' | 'uncertain';

/** What Message says where nothing goes across, on every screen; not for `uncertain`, whose screen offers what it can. */
export function acrossRefusedWords(refused: Exclude<AcrossRefused, 'uncertain'>): string {
    switch (refused) {
        case 'off': return t("This community doesn't take messages from other communities.");
        case 'no-home': return t("This community's server knows none of its own names yet, so it can't send to another community.");
        // The words its server refuses the line in (routes/relay.ts), and the web's.
        case 'not-member': return t(FIND_WORDS.notAMember);
        case 'blocked': return t('You have blocked this user. Messaging is disabled.');
        case 'no-community': return t('Connect to your community to start a chat.');
    }
}

/**
 * A chat across with someone in a community the phone shares none with, made from the contact's link as an address card
 * makes one (outside-mail.ts openChatFromCard: kept in the community in use's file, open, named as the link names them; a
 * declined one there is opened again, and one kept with another home goes to the link's now). Refused with no community in
 * use (a guest's look included: its copy is not the member's, and its server would refuse the line), where the community
 * in use doesn't take messages from other communities, has no address of its own to send from, or takes none of the account's
 * lines (suspended there, or no member of it: asked now, always, {@link standsInUse}), or for someone the account blocked;
 * nothing is made then. Nor when the link's address is one of the community in use's own (asked now, always: a name it took on
 * since this phone last heard), where the direct chat here is theirs: its server refuses every line across to one of its own
 * names. Nor when whose the address is can't be said for certain (utils/community-homes.ts).
 */
export async function openAcrossChat(target: { key: string; home: string; name: string | null }): Promise<AcrossOpened> {
    const inFront = await anchorUrl();
    if (!inFront || await guestLook(inFront)) return { refused: 'no-community' };
    const live = await import('./outside-chat-live');
    const ctx = await live.outsideContext().catch(() => null);
    if (!ctx) return { refused: 'no-community' };
    // Side by side, for the one deadline: the names of the communities with a claim, and how the account stands in this one.
    const [names, standing] = await Promise.all([
        keptNamesWith(ctx.nodeUrl).then((kept) => askedNow(kept, [target.home], (n) => n.community === ctx.nodeUrl)),
        standsInUse(ctx.identity.publicKey, ctx.nodeUrl),
    ]);
    const { outsideMessagesOn } = await import('./node-profile');
    const whose = whoseName(names)(target.home);
    if (whose.whose === 'one' && whose.community === ctx.nodeUrl) return { here: target.key };
    if (whose.whose === 'uncertain' || await doubted(names, target.home, target.key, ctx.nodeUrl)) return { refused: 'uncertain' };
    const refused = acrossRefusal(profileOf(names, ctx.nodeUrl), outsideMessagesOn);
    if (refused) return { refused };
    if (sendsNothing(standing)) return { refused: 'not-member' };
    const { openChatFromCard } = await import('./outside-mail');
    const chatId = await openChatFromCard(ctx, { key: target.key, home: target.home, name: target.name });
    return chatId ? { chatId } : { refused: 'blocked' };
}

/**
 * A direct chat with `key` started in `community`, another community this phone holds, in place (slice S2): by the address
 * the phone saved for it, however the link spells it, held in place while it starts (db.ts enterChatInPlace ... leaveChatInPlace).
 * Throws db.ts's refusals as they come (isNoCopyInPlace: that copy can't be opened in place now).
 */
export async function startChatInPlace(me: string, key: string, community: string): Promise<{ id: string; community: string }> {
    const db = await import('./db');
    const { getSavedNodes } = await import('./nodes');
    const saved = (await getSavedNodes().catch(() => [])).find((n) => sameCommunity(n.url, community))?.url ?? community;
    db.enterChatInPlace(saved);
    try {
        const conv = await db.createConversationApi('dm', [me, key], me, undefined, undefined, saved);
        return { id: String(conv.id), community: saved };
    } finally {
        void db.leaveChatInPlace(saved);
    }
}

/**
 * The chat route Message pushes for a chat that exists: here (`inFront`: the community the phone is set to, a guest's look
 * too), in place in a held community (slice S2), or across (slice S4).
 */
export function existingChatRoute(chat: KnownChat, inFront: string | null, nameOf: (community: string) => string):
    string | { pathname: '/chat/[id]'; params: { id: string; community: string; communityName: string } } {
    if (chat.kind === 'across') return chat.community ? `/outside-chat/${chat.id}?community=${encodeURIComponent(chat.community)}` : `/outside-chat/${chat.id}`;
    if (inFront && keptAsOne(inFront, chat.community)) return `/chat/${chat.id}`;
    return { pathname: '/chat/[id]', params: { id: chat.id, community: chat.community, communityName: nameOf(chat.community) } };
}

/** The community the phone is set to, as a member or as a guest's look: its address, or null. */
export async function anchorUrl(): Promise<string | null> {
    return (await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null)) || null;
}

/** Whether `community` is a guest's look on this phone, however spelled (nodes.ts isGuestCopy). A mark that can't be read counts as one: nothing is weighed or made on a guess. */
async function guestLook(community: string): Promise<boolean> {
    const { isGuestCopy } = await import('./nodes');
    return isGuestCopy(community).catch(() => true);
}
