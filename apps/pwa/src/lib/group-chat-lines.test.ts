/**
 * Sending, editing and drawing a group chat's lines in the web app (group-chat-lines.ts): the sticky lock and the plan
 * that decides whether anything readable may go, the line-display rule's cases (DESIGN-group-chat-line-display-fable.md
 * §7: whose name goes on a line), a photo line's two parts (DESIGN-group-chat-photos-fable.md §2.2, §2.3), and in-thread
 * search. Against a node in memory; the real node is e2e/group-chat-check.mjs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore, type GroupLockStore } from './group-chat-keys';
import {
    groupChatSendPlan, groupChatNotice, heldGroupRefusal, sendSealedGroupLine, editSealedGroupLine, openGroupThread, groupLineShown, getDecryptedGroupAttachment,
    GROUP_CHAT_LOCK_LOST_TEXT, GROUP_CHAT_LOCKED_NOTICE, GROUP_CHAT_OLD_NODE_NOTICE, GROUP_CHAT_NOT_MEMBER_TEXT, GROUP_CHAT_UNREAD_TEXT,
    GROUP_LINE_UNSEALED_DETAILS, GROUP_LINE_DELETED_TEXT, GROUP_LINE_REMOVED_TEXT,
} from './group-chat-lines';
import { GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT, GROUP_LINE_NOT_IN_GROUP, searchShownLines } from './group-line-display';
import { sealLine, openLine } from './group-chat-crypto';
import { fakeGroupNode, person } from './group-chat-fake-node.test-support';

const G = '7a1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const locked = { encryption: { current: 1, stale: false, fromEpoch: 1 }, messages: [] };
const unlocked = { messages: [], notice: "End-to-end encrypted: only this group's members can read it." };

beforeEach(() => forgetGroupKeys());

const uuid = () => crypto.randomUUID();

describe('the sticky lock: whether anything readable may go', () => {
    it('a locked chat answer seals, and is remembered for good', async () => {
        const ana = person();
        const store = memoryGroupLockStore();
        const ring = groupKeyring(fakeGroupNode(G, [ana.publicKey]).as(ana.publicKey), ana, G, store);
        expect(await groupChatSendPlan(ring, locked)).toEqual({ kind: 'seal' });
        expect(store.rows.get(`${ana.publicKey}/${G}`)?.locked).toBe(true);
        // Later the node says the chat isn't locked (its own notice still claiming it is): still sealed, never readable.
        forgetGroupKeys();
        const again = groupKeyring(fakeGroupNode(G, [ana.publicKey]).as(ana.publicKey), ana, G, store);
        expect(await groupChatSendPlan(again, unlocked)).toEqual({ kind: 'seal' });
        expect(groupChatNotice({ nodeSaysLocked: false, seenLocked: await again.seenLocked() })).toBe(GROUP_CHAT_LOCK_LOST_TEXT);
    });

    it('a browser that never saw the group locked sends readable words only when the chat answer says unlocked', async () => {
        const ana = person();
        const ring = groupKeyring(fakeGroupNode(G, [ana.publicKey]).as(ana.publicKey), ana, G, memoryGroupLockStore());
        expect(await groupChatSendPlan(ring, unlocked)).toEqual({ kind: 'readable' });
        expect(groupChatNotice({ nodeSaysLocked: false, seenLocked: false })).toBe(GROUP_CHAT_OLD_NODE_NOTICE);
        expect(await groupChatSendPlan(ring, null, Object.assign(new Error('offline'), { status: 0 }))).toEqual({ kind: 'refuse', sentence: GROUP_CHAT_UNREAD_TEXT });
        expect(await groupChatSendPlan(ring, null, Object.assign(new Error('gone'), { status: 404 }))).toEqual({ kind: 'refuse', sentence: GROUP_CHAT_NOT_MEMBER_TEXT });
        expect(await groupChatSendPlan(ring, 'not an answer')).toEqual({ kind: 'refuse', sentence: GROUP_CHAT_UNREAD_TEXT });
        expect(groupChatNotice({ nodeSaysLocked: true, seenLocked: false })).toBe(GROUP_CHAT_LOCKED_NOTICE);
    });

    it('a lock store that cannot be read never lets readable words go (fails closed)', async () => {
        const ana = person();
        const broken: GroupLockStore = { load: async () => { throw new Error('no IndexedDB'); }, raiseHighest: async () => { }, markLocked: async () => { } };
        const ring = groupKeyring(fakeGroupNode(G, [ana.publicKey]).as(ana.publicKey), ana, G, broken);
        expect(await groupChatSendPlan(ring, unlocked)).toEqual({ kind: 'seal' });
    });

    it("a held group the node refuses keys to: the removed-member words, or the lock-lost words when the chat says unlocked", () => {
        expect(heldGroupRefusal(null, Object.assign(new Error('x'), { status: 404 }))).toBe(GROUP_CHAT_NOT_MEMBER_TEXT);
        expect(heldGroupRefusal(locked)).toBe(GROUP_CHAT_NOT_MEMBER_TEXT);
        expect(heldGroupRefusal(unlocked)).toBe(GROUP_CHAT_LOCK_LOST_TEXT);
    });
});

describe('sealed lines between two members', () => {
    it('Ana sends, Ben reads it under her name; Ana edits under the line\'s own epoch; nothing readable reaches the node', async () => {
        const ana = person(true);
        const ben = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const store = memoryGroupLockStore();
        const id = uuid();
        await sendSealedGroupLine(node.as(ana.publicKey), ana, store, {
            groupId: G, text: 'Working bee Saturday, @Ben', clientId: id,
            mentionCandidates: [{ pubkey: ben.publicKey, callsign: 'Ben' }, { pubkey: ana.publicKey, callsign: 'Ana' }],
        });
        expect(node.lines).toHaveLength(1);
        expect(node.lines[0].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(node.lines[0].metadata).toMatchObject({ epoch: 1, mentions: [ben.publicKey] });
        expect(Buffer.from(node.lines[0].ciphertext, 'base64').toString('latin1')).not.toContain('Working bee');

        const roster = [{ memberPubkey: ana.publicKey, callsign: 'Ana' }, { memberPubkey: ben.publicKey, callsign: 'Ben' }];
        const served = () => ({
            encryption: { current: node.current(), stale: false, fromEpoch: 1 },
            messages: node.lines.map((l) => ({ id: l.id, authorPubkey: l.author, ciphertext: l.ciphertext, nonce: l.nonce, metadata: JSON.stringify(l.metadata), type: 'text', editedAt: (l as any).editedAt ?? null })),
        });
        forgetGroupKeys();
        const benRing = groupKeyring(node.as(ben.publicKey), ben, G, store);
        let t = await openGroupThread(benRing, served(), roster);
        const shown = groupLineShown(served().messages[0], { locked: true, thread: t, me: ben.publicKey })!;
        expect(shown).toMatchObject({ text: 'Working bee Saturday, @Ben', name: 'Ana', mine: false, unattributed: false });

        forgetGroupKeys();
        await editSealedGroupLine(node.as(ana.publicKey), ana, store, { groupId: G, messageId: id, metadata: node.lines[0].metadata, text: 'Working bee Sunday' });
        (node.lines[0] as any).editedAt = new Date().toISOString();
        expect(node.lines[0].metadata.epoch).toBe(1);
        forgetGroupKeys();
        t = await openGroupThread(groupKeyring(node.as(ben.publicKey), ben, G, store), served(), roster);
        expect(groupLineShown(served().messages[0], { locked: true, thread: t, me: ben.publicKey })).toMatchObject({ text: 'Working bee Sunday', name: 'Ana' });
    });
});

describe('whose name goes on a line (line-display design §7)', () => {
    async function setup() {
        const ana = person();
        const ben = person();
        const mal = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey, mal.publicKey]);
        const store = memoryGroupLockStore();
        const { epoch, key } = await groupKeyring(node.as(ana.publicKey), ana, G, store).prepareToSeal();
        forgetGroupKeys();
        const ring = groupKeyring(node.as(ben.publicKey), ben, G, store);
        const seal = (by: { privateKey: string }, text: string, id = uuid()) => ({ id, ...sealLine(text, { myEdPrivHex: by.privateKey, groupKey: key, groupId: G, epoch, messageId: id }) });
        const sealEdit = (by: { privateKey: string }, text: string, id = uuid()) => ({ id, ...sealLine(text, { myEdPrivHex: by.privateKey, groupKey: key, groupId: G, epoch, messageId: id, part: 'edit', after: id }) });
        const roster = [{ memberPubkey: ana.publicKey, callsign: 'Ana' }, { memberPubkey: ben.publicKey, callsign: 'Ben' }, { memberPubkey: mal.publicKey, callsign: 'Mal' }];
        const view = async (lines: any[], r = roster) => {
            const t = await openGroupThread(ring, { encryption: { current: epoch, stale: false, fromEpoch: 1 }, messages: lines }, r);
            return lines.map((l) => groupLineShown(l, { locked: true, thread: t, me: ben.publicKey }));
        };
        return { ana, ben, mal, epoch, seal, sealEdit, view };
    }

    it('1. author column Ana, sender Mal, bytes by Mal: shown as Mal (never the author column)', async () => {
        const { ana, mal, epoch, seal, view } = await setup();
        const l = seal(mal, 'send Beans to Mal');
        const [s] = await view([{ ...l, authorPubkey: ana.publicKey, authorCallsign: 'Ana', type: 'text', metadata: { epoch, sender: mal.publicKey } }]);
        expect(s).toMatchObject({ name: 'Mal', signer: mal.publicKey, text: 'send Beans to Mal' });
    });

    it('2/3. sender wrong, author right → the signer by the fallback; both wrong → Unverified, no words', async () => {
        const { ana, mal, epoch, seal, view } = await setup();
        const l = seal(ana, 'from Ana');
        const [a, b] = await view([
            { ...l, authorPubkey: ana.publicKey, type: 'text', metadata: { epoch, sender: mal.publicKey } },
            { ...seal(ana, 'again'), authorPubkey: mal.publicKey, type: 'text', metadata: { epoch, sender: mal.publicKey } },
        ]);
        expect(a).toMatchObject({ name: 'Ana', text: 'from Ana' });
        expect(b).toMatchObject({ name: GROUP_LINE_UNVERIFIED_NAME, text: GROUP_LINE_UNVERIFIED_TEXT, mine: false, unattributed: true });
    });

    it('8. an ex-member signer: their name with "no longer in this group"', async () => {
        const { ana, ben, mal, epoch, seal, view } = await setup();
        const l = seal(mal, 'bye');
        const [s] = await view([{ ...l, authorPubkey: mal.publicKey, authorCallsign: 'Mal', type: 'text', metadata: { epoch, sender: mal.publicKey } }],
            [{ memberPubkey: ana.publicKey, callsign: 'Ana' }, { memberPubkey: ben.publicKey, callsign: 'Ben' }]);
        expect(s).toMatchObject({ name: 'Mal', nameHint: GROUP_LINE_NOT_IN_GROUP });
    });

    it('9. an edit sealed by Mal on Ana\'s line: the web shows the signer, Mal (it keeps no earlier verdict)', async () => {
        const { ana, mal, epoch, sealEdit, view } = await setup();
        // A node swaps in Mal's edit under Ana's author column, naming Mal as sender (or the line wouldn't open at all).
        const l = sealEdit(mal, 'pay Mal instead');
        const [s] = await view([{ ...l, authorPubkey: ana.publicKey, authorCallsign: 'Ana', type: 'text', editedAt: new Date().toISOString(), metadata: { epoch, sender: mal.publicKey } }]);
        expect(s).toMatchObject({ name: 'Mal', signer: mal.publicKey, text: 'pay Mal instead' });
    });

    it('a locked chat draws a readable row as nobody\'s, never as mine; tombstones and system lines in the app\'s words', async () => {
        const { ben, epoch, view } = await setup();
        const plainMine = { id: uuid(), authorPubkey: ben.publicKey, ciphertext: Buffer.from('I agree, send it').toString('base64'), nonce: 'plaintext-v1', type: 'text', metadata: '' };
        const emptyNonce = { ...plainMine, id: uuid(), nonce: '' };
        const withSystemType = { ...plainMine, id: uuid(), systemType: 'GROUP_MEMBER_JOINED' };
        const system = { id: uuid(), authorPubkey: 'SYSTEM', ciphertext: 'Mal joined', nonce: '00000', type: 'system', metadata: '' };
        const deleted = { id: uuid(), authorPubkey: ben.publicKey, ciphertext: 'eA==', nonce: 'plaintext-v1', type: 'removed', metadata: JSON.stringify({ epoch, removed: true, removedBy: ben.publicKey }) };
        const removed = { ...deleted, id: uuid(), metadata: JSON.stringify({ removed: true, removedBy: 'someone-else' }) };
        const [a, b, c, d, e, f] = await view([plainMine, emptyNonce, withSystemType, system, deleted, removed]);
        for (const s of [a, b, c]) expect(s).toMatchObject({ name: GROUP_LINE_UNVERIFIED_NAME, text: GROUP_LINE_UNVERIFIED_TEXT, details: GROUP_LINE_UNSEALED_DETAILS, mine: false, signer: '' });
        expect(d).toMatchObject({ nodeLine: true, text: null });
        expect(e).toMatchObject({ nodeLine: true, text: GROUP_LINE_DELETED_TEXT });
        expect(f).toMatchObject({ nodeLine: true, text: GROUP_LINE_REMOVED_TEXT });
        // An unlocked chat (an old node, never locked here) is drawn as it always was.
        expect(groupLineShown(plainMine, { locked: false, thread: null, me: ben.publicKey })).toBeNull();
    });

    it('a line from before this member\'s first epoch is hidden unopened', async () => {
        const { ana, ben, epoch, seal } = await setup();
        const l = { ...seal(ana, 'before you'), authorPubkey: ana.publicKey, type: 'text', metadata: { epoch } };
        const ring = groupKeyring(fakeGroupNode(G, [ana.publicKey, ben.publicKey]).as(ben.publicKey), ben, G, memoryGroupLockStore());
        const t = await openGroupThread(ring, { encryption: { current: epoch, stale: false, fromEpoch: epoch + 1 }, messages: [l] }, []);
        expect(groupLineShown(l, { locked: true, thread: t, me: ben.publicKey })?.hidden).toBe(true);
    });
});

describe('a photo line: its caption and its photo under one message key (DESIGN-group-chat-photos-fable.md §2.2, §2.3)', () => {
    const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
    const OTHER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAA';
    const conflict = (code: string) => new Response(JSON.stringify({ error: 'epoch', code }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    const served = (node: ReturnType<typeof fakeGroupNode>) => ({
        encryption: { current: node.current(), stale: false, fromEpoch: 1 },
        messages: node.lines.map((l) => ({ id: l.id, authorPubkey: l.author, ciphertext: l.ciphertext, nonce: l.nonce, metadata: JSON.stringify(l.metadata), type: l.type ?? 'text' })),
    });
    /** A member's opened key for an epoch, as a fresh page of theirs would hold it. */
    async function keyOf(node: ReturnType<typeof fakeGroupNode>, who: { publicKey: string; privateKey: string }, store: GroupLockStore, epoch: number) {
        forgetGroupKeys();
        const ring = groupKeyring(node.as(who.publicKey), who, G, store);
        await ring.sync([epoch]);
        return (await ring.keyFor(epoch))!;
    }

    it('goes as type image: the caption sealed as part body, the photo as part attachment, one id, epoch and reply; nothing readable', async () => {
        const ana = person(true);
        const ben = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const store = memoryGroupLockStore();
        const asked = uuid();
        await sendSealedGroupLine(node.as(ben.publicKey), ben, store, { groupId: G, text: 'Is the gate fixed?', clientId: asked });
        forgetGroupKeys();
        const id = uuid();
        await sendSealedGroupLine(node.as(ana.publicKey), ana, store, {
            groupId: G, text: 'Fixed, @Ben', photo: PHOTO, clientId: id, replyToId: asked,
            mentionCandidates: [{ pubkey: ben.publicKey, callsign: 'Ben' }],
        });
        const line = node.lines[1];
        expect(line).toMatchObject({ id, type: 'image', metadata: { epoch: 1, replyToId: asked, mentions: [ben.publicKey] } });
        const photo = { ciphertext: line.attachment?.data ?? '', nonce: line.attachment?.nonce ?? '' };
        expect(line.attachment?.mime).toBe('image/jpeg');
        expect(photo.nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(photo.nonce).not.toBe(line.nonce);
        expect(Buffer.from(photo.ciphertext, 'base64').toString('latin1')).not.toContain('/9j/');

        const key = await keyOf(node, ben, store, 1);
        const bind = { groupId: G, epoch: 1, senderPubHex: ana.publicKey, messageId: id, replyToId: asked };
        expect(openLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { ...bind, part: 'body' }, key).text).toBe('Fixed, @Ben');
        expect(openLine(photo, { ...bind, part: 'attachment' }, key).text).toBe(PHOTO);
        // Neither part stands in for the other, for another line's, or under another reply.
        expect(() => openLine(photo, { ...bind, part: 'body' }, key)).toThrow();
        expect(() => openLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { ...bind, part: 'attachment' }, key)).toThrow();
        expect(() => openLine(photo, { ...bind, part: 'attachment', messageId: uuid() }, key)).toThrow();
        expect(() => openLine(photo, { ...bind, part: 'attachment', replyToId: null }, key)).toThrow();
    });

    it('a 409 mid-send seals both parts again under the new epoch, once; a second 409 is the refusal', async () => {
        const ana = person(true);
        const ben = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const store = memoryGroupLockStore();
        await groupKeyring(node.as(ben.publicKey), ben, G, store).prepareToSeal();
        forgetGroupKeys();
        // Epoch 1 goes stale between Ana's seal and her send (a member left): the node refuses the line once.
        let refusals = 1;
        node.lie = (method, path) => {
            if (method !== 'POST' || !path.endsWith('/chat/message') || refusals === 0) return undefined;
            refusals--;
            node.stale = true;
            return conflict('epoch_stale');
        };
        const id = uuid();
        await sendSealedGroupLine(node.as(ana.publicKey), ana, store, { groupId: G, text: 'Gate', photo: PHOTO, clientId: id });
        const posts = node.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/chat/message'));
        expect(posts.map((c) => [c.body.metadata.epoch, c.body.type, typeof c.body.attachment?.data])).toEqual([[1, 'image', 'string'], [2, 'image', 'string']]);
        expect(posts[1].body.attachment.data).not.toBe(posts[0].body.attachment.data);
        expect(node.lines).toHaveLength(1);
        const line = node.lines[0];
        expect(line).toMatchObject({ id, type: 'image', metadata: { epoch: 2 } });
        const photo = { ciphertext: line.attachment?.data ?? '', nonce: line.attachment?.nonce ?? '' };
        const bind = { groupId: G, senderPubHex: ana.publicKey, messageId: id };
        const key2 = await keyOf(node, ben, store, 2);
        expect(openLine({ ciphertext: line.ciphertext, nonce: line.nonce }, { ...bind, epoch: 2, part: 'body' }, key2).text).toBe('Gate');
        expect(openLine(photo, { ...bind, epoch: 2, part: 'attachment' }, key2).text).toBe(PHOTO);
        const key1 = await keyOf(node, ben, store, 1);
        expect(() => openLine(photo, { ...bind, epoch: 1, part: 'attachment' }, key1)).toThrow();

        // Twice refused: answered once, then the node's refusal, and nothing stored.
        forgetGroupKeys();
        refusals = 2;
        node.calls.length = 0;
        await expect(sendSealedGroupLine(node.as(ana.publicKey), ana, store, { groupId: G, text: '', photo: OTHER, clientId: uuid() })).rejects.toMatchObject({ status: 409 });
        expect(node.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/chat/message'))).toHaveLength(2);
        expect(node.lines).toHaveLength(1);
    });

    it('opens only once its words did, under the key that opened them: a swapped photo is nothing, and a line waiting, unverified or hidden asks for none', async () => {
        const ana = person(true);
        const ben = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const store = memoryGroupLockStore();
        const [first, second] = [uuid(), uuid()];
        await sendSealedGroupLine(node.as(ana.publicKey), ana, store, { groupId: G, text: 'The gate', photo: PHOTO, clientId: first });
        await sendSealedGroupLine(node.as(ana.publicKey), ana, store, { groupId: G, text: '', photo: OTHER, clientId: second });
        forgetGroupKeys();
        const roster = [{ memberPubkey: ana.publicKey, callsign: 'Ana' }, { memberPubkey: ben.publicKey, callsign: 'Ben' }];
        const ring = groupKeyring(node.as(ben.publicKey), ben, G, store);
        const s = served(node);
        const thread = await openGroupThread(ring, s, roster);
        const [p1, p2] = s.messages;
        const open = (line: typeof p1, view = thread.views.get(line.id)) =>
            getDecryptedGroupAttachment(node.as(ben.publicKey), ben, store, { groupId: G, line, view });
        expect(groupLineShown(p1, { locked: true, thread, me: ben.publicKey })).toMatchObject({ text: 'The gate', name: 'Ana', unattributed: false });
        expect(await open(p1)).toBe(PHOTO);
        expect(await open(p2)).toBe(OTHER);

        // The node serves the second line's photo under the first's id: it opens as nothing, never as the other picture.
        node.lines[0].attachment = node.lines[1].attachment;
        expect(await open(p1)).toBeNull();

        const asked = () => node.calls.filter((c) => c.path.includes('/attachment')).length;
        const before = asked();
        const v = thread.views.get(p2.id)!;
        for (const view of [{ ...v, waitingKey: true }, { ...v, unverified: true }, { ...v, hidden: true }, { ...v, signer: null }, { ...v, epoch: null }, undefined]) {
            expect(await open(p2, view)).toBeNull();
        }
        // A words line is no photo line, whatever its view.
        expect(await open({ ...p2, type: 'text' })).toBeNull();
        expect(asked()).toBe(before);
    });
});

describe('in-thread search', () => {
    it('finds lines in the loaded thread by their opened words, any case; nothing is asked of the node', () => {
        const lines = [{ text: 'Working bee Saturday' }, { text: 'bring GLOVES' }, { text: 'see you' }];
        expect(searchShownLines(lines, 'gloves')).toEqual([{ text: 'bring GLOVES' }]);
        expect(searchShownLines(lines, '  ')).toEqual(lines);
    });
});
