/**
 * A change to a line across communities: an edit, a reaction, a delete for everyone (outside-chat.ts; slice X6). Sealed and
 * signed as a line is, opened only as its envelope's own kind, judged by one rule both apps take, and shown by one rule.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    OUTSIDE_CHANGE_KINDS, OUTSIDE_REACTIONS, OutsideLineNotVerifiedError, gateOutsideItem, openOutsideChange, openOutsideLine,
    outsideChangeOutcome, outsideChangesKept, outsideChangeVerdict, outsideLineActions, outsideLineReportedWords, outsideLineShown, outsideLineWords,
    sealOutsideChange, sealOutsideLine, type OutsideChange, type OutsideChangeKind, type OutsideChangeState,
} from '../outside-chat.js';
import { relayConversationId, relayPayloadHash, signRelayEnvelope, type RelayEnvelope, type RelayItemKind } from '../relay-envelope.js';

const seed = (name: string) => sha256(utf8ToBytes(`beanpool relay vector: ${name}`));
const pub = (s: Uint8Array) => bytesToHex(ed25519.getPublicKey(s));
const ANA = seed('Ana'), BEN = seed('Ben'), CY = seed('Cy');
const ana = { key: pub(ANA), edPrivHex: bytesToHex(ANA) };
const ben = { key: pub(BEN), edPrivHex: bytesToHex(BEN) };
const cy = { key: pub(CY), edPrivHex: bytesToHex(CY) };
const LINE = '5f0c2d1e-8a7b-4c3d-9e1f-0a2b3c4d5e6f';
const uuid = () => crypto.randomUUID();

async function changeItem(from: typeof ana, to: typeof ben, kind: OutsideChangeKind, extra: { text?: string; emoji?: string } = {},
    opts: { envKind?: RelayItemKind; signer?: Uint8Array; at?: number } = {}): Promise<{ envelope: RelayEnvelope; payload: string }> {
    const itemId = uuid();
    const payload = sealOutsideChange({ kind, lineId: LINE, ...extra, myEdPrivHex: from.edPrivHex, myKey: from.key, peerKey: to.key, itemId });
    const envelope = await signRelayEnvelope({
        kind: opts.envKind ?? kind, itemId, senderKey: from.key, senderHome: 'a.example', recipient: to.key, recipientHome: 'b.example',
        at: opts.at ?? 1_763_020_800_000, payloadHash: relayPayloadHash(payload),
    }, (b) => ed25519.sign(b, opts.signer ?? (from === ana ? ANA : from === ben ? BEN : CY)));
    return { envelope, payload };
}

describe('sealed and opened as its own kind only', () => {
    const cases: Array<[OutsideChangeKind, { text?: string; emoji?: string }, Partial<OutsideChange>]> = [
        ['dm-edit', { text: 'Fixed the time: 3 pm' }, { text: 'Fixed the time: 3 pm' }],
        ['dm-reaction', { emoji: '❤️' }, { emoji: '❤️' }],
        ['dm-reaction', { emoji: '' }, { emoji: '' }],
        ['dm-delete', {}, {}],
    ];
    for (const [kind, extra, want] of cases) {
        it(`${kind} ${JSON.stringify(extra)}: Ben opens it as Ana's, naming the line; nobody else can`, async () => {
            const it = await changeItem(ana, ben, kind, extra);
            const opened = openOutsideChange(it.payload, it.envelope, ben);
            expect(opened).toEqual({ kind, itemId: it.envelope.itemId, lineId: LINE, author: ana.key, at: it.envelope.at, ...want });
            expect(() => openOutsideChange(it.payload, it.envelope, cy)).toThrow(OutsideLineNotVerifiedError);
            expect(() => openOutsideChange(it.payload, { ...it.envelope, recipient: cy.key }, cy)).toThrow(OutsideLineNotVerifiedError);
            expect(() => openOutsideLine(it.payload, { ...it.envelope, kind: 'dm-line' }, ben)).toThrow(OutsideLineNotVerifiedError);
            for (const other of OUTSIDE_CHANGE_KINDS.filter((k) => k !== kind)) {
                expect(() => openOutsideChange(it.payload, { ...it.envelope, kind: other }, ben)).toThrow(OutsideLineNotVerifiedError);
            }
        });
    }

    it('a line never opens as a change; a change under another id or sender does not open', async () => {
        const id = uuid();
        const payload = sealOutsideLine({ text: 'Hi', name: 'Ana', myEdPrivHex: ana.edPrivHex, myKey: ana.key, peerKey: ben.key, messageId: id });
        const env = { v: 1 as const, kind: 'dm-edit' as const, itemId: id, senderKey: ana.key, senderHome: 'a.example', recipient: ben.key, recipientHome: 'b.example', at: 1, payloadHash: relayPayloadHash(payload), sig: 'x' };
        expect(() => openOutsideChange(payload, env, ben)).toThrow(OutsideLineNotVerifiedError);
        const it2 = await changeItem(ana, ben, 'dm-delete');
        expect(() => openOutsideChange(it2.payload, { ...it2.envelope, itemId: uuid() }, ben)).toThrow(OutsideLineNotVerifiedError);
        expect(() => openOutsideChange(it2.payload, { ...it2.envelope, senderKey: cy.key }, ben)).toThrow(OutsideLineNotVerifiedError);
        expect(() => openOutsideChange(it2.payload, it2.envelope, ana)).toThrow(OutsideLineNotVerifiedError);
    });

    it('refuses to seal what is not a change: no words, too many, an emoji not the chat\'s, a delete with words, a bad id', () => {
        const base = { myEdPrivHex: ana.edPrivHex, myKey: ana.key, peerKey: ben.key, itemId: uuid(), lineId: LINE };
        expect(() => sealOutsideChange({ ...base, kind: 'dm-edit', text: '  ' })).toThrow();
        expect(() => sealOutsideChange({ ...base, kind: 'dm-edit', text: 'x'.repeat(8001) })).toThrow();
        expect(() => sealOutsideChange({ ...base, kind: 'dm-reaction', emoji: '🦄' })).toThrow();
        expect(() => sealOutsideChange({ ...base, kind: 'dm-reaction', emoji: '👍', text: 'x' })).toThrow();
        expect(() => sealOutsideChange({ ...base, kind: 'dm-delete', text: 'x' })).toThrow();
        expect(() => sealOutsideChange({ ...base, kind: 'dm-delete', lineId: 'not-a-line' })).toThrow();
        expect(() => sealOutsideChange({ ...base, kind: 'dm-delete', itemId: 'itm-0001' })).toThrow();
        expect(OUTSIDE_REACTIONS).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏', '😁']);
    });
});

describe('the gate: an open chat takes changes; nothing else does', () => {
    for (const kind of OUTSIDE_CHANGE_KINDS) {
        it(kind, () => {
            expect(gateOutsideItem({ kind, chat: { state: 'open', theirLines: 0 }, doorOpen: false, blocked: false })).toBe('change');
            expect(gateOutsideItem({ kind, chat: { state: 'open', theirLines: 3 }, doorOpen: true, blocked: true })).toBe('drop');
            for (const chat of [null, { state: 'request' as const, theirLines: 0 }, { state: 'request' as const, theirLines: 1 }, { state: 'declined' as const, theirLines: 1 }]) {
                for (const doorOpen of [true, false]) expect(gateOutsideItem({ kind, chat, doorOpen, blocked: false })).toBe('drop');
            }
        });
    }
});

describe('the verdict, every case', () => {
    const chatId = relayConversationId(ana.key, ben.key);
    const gates = ['line', 'request', 'change', 'drop'] as const;
    const lines = [
        null,
        { chatId, author: ana.key, deleted: false },
        { chatId, author: ben.key, deleted: false },
        { chatId, author: ana.key, deleted: true },
        { chatId: relayConversationId(cy.key, ben.key), author: cy.key, deleted: false },
    ];
    const want = (kind: OutsideChangeKind, gate: string, line: typeof lines[number]) => {
        if (gate !== 'change') return 'drop';
        if (!line) return 'apply';
        if (line.chatId !== chatId) return 'refuse';
        if (line.deleted) return 'drop';
        return kind !== 'dm-reaction' && line.author !== ana.key ? 'refuse' : 'apply';
    };
    for (const kind of OUTSIDE_CHANGE_KINDS) for (const gate of gates) for (const line of lines) {
        const w = want(kind, gate, line);
        it(`${kind}, gate ${gate}, line ${line ? `${line.author === ana.key ? 'Ana' : line.author === ben.key ? 'Ben' : 'Cy'}'s${line.deleted ? ', deleted' : ''}${line.chatId !== chatId ? ', another chat' : ''}` : 'not here'}: ${w}`, () => {
            expect(outsideChangeVerdict({ change: { kind, author: ana.key }, gate, chatId, line })).toBe(w);
        });
    }
});

describe('a line as shown', () => {
    const line = { id: LINE, author: ana.key, text: 'Meet at 2' };
    const ch = (c: Partial<OutsideChange> & Pick<OutsideChange, 'kind' | 'author' | 'at'>): OutsideChange => ({ itemId: uuid(), lineId: LINE, ...c });

    it('untouched', () => {
        expect(outsideLineShown(line, [], ben.key)).toEqual({ text: 'Meet at 2', edited: false, deleted: false, reactions: [] });
    });

    it('the newest edit by its writer wins, by time then id; anyone else\'s edit changes nothing', () => {
        const shown = outsideLineShown(line, [
            ch({ kind: 'dm-edit', author: ana.key, at: 5, text: 'Meet at 3' }),
            ch({ kind: 'dm-edit', author: ana.key, at: 9, text: 'Meet at 4' }),
            ch({ kind: 'dm-edit', author: ana.key, at: 7, text: 'Meet at 5' }),
            ch({ kind: 'dm-edit', author: ben.key, at: 99, text: 'Ben was here' }),
        ], ben.key);
        expect(shown).toMatchObject({ text: 'Meet at 4', edited: true, deleted: false });
        const tie = outsideLineShown(line, [
            ch({ kind: 'dm-edit', author: ana.key, at: 9, itemId: 'aaaaaaaa-0000-4000-8000-000000000000', text: 'A' }),
            ch({ kind: 'dm-edit', author: ana.key, at: 9, itemId: 'bbbbbbbb-0000-4000-8000-000000000000', text: 'B' }),
        ], ben.key);
        expect(tie.text).toBe('B');
        expect(outsideLineShown(line, [ch({ kind: 'dm-edit', author: ben.key, at: 1, text: 'x' })], ben.key)).toMatchObject({ text: 'Meet at 2', edited: false });
    });

    it('one reaction a person, their newest, changeable and removable; mine is marked', () => {
        const shown = outsideLineShown(line, [
            ch({ kind: 'dm-reaction', author: ana.key, at: 1, emoji: '👍' }),
            ch({ kind: 'dm-reaction', author: ana.key, at: 2, emoji: '❤️' }),
            ch({ kind: 'dm-reaction', author: ben.key, at: 1, emoji: '❤️' }),
            ch({ kind: 'dm-reaction', author: cy.key, at: 1, emoji: '😂' }),
            ch({ kind: 'dm-reaction', author: cy.key, at: 2, emoji: '' }),
        ], ben.key);
        expect(shown.reactions).toEqual([{ emoji: '❤️', count: 2, mine: true }]);
    });

    it('deleted by its writer: nothing more shows; a delete by anyone else does nothing', () => {
        const all = [ch({ kind: 'dm-edit', author: ana.key, at: 9, text: 'x' }), ch({ kind: 'dm-reaction', author: ben.key, at: 1, emoji: '👍' })];
        expect(outsideLineShown(line, [...all, ch({ kind: 'dm-delete', author: ana.key, at: 1 })], ben.key)).toEqual({ text: '', edited: false, deleted: true, reactions: [] });
        expect(outsideLineShown(line, [...all, ch({ kind: 'dm-delete', author: ben.key, at: 1 })], ben.key)).toMatchObject({ deleted: false, text: 'x' });
    });

    it('a change to another line changes nothing here', () => {
        expect(outsideLineShown(line, [{ ...ch({ kind: 'dm-delete', author: ana.key, at: 1 }), lineId: uuid() }], ben.key).deleted).toBe(false);
    });
});

describe('which changes a device keeps, and what an answer about mine means (round 2: one rule both apps take)', () => {
    type Row = { at: number; itemId: string; state: OutsideChangeState };
    const row = (at: number, state: OutsideChangeState): Row => ({ at, itemId: `${String(at).padStart(8, '0')}-0000-4000-8000-000000000000`, state });
    const kept = (rows: Row[]) => outsideChangesKept(rows).map((r) => `${r.at}:${r.state ?? 'theirs'}`);

    it('theirs: the newest only, an older one arriving changes nothing', () => {
        expect(kept([row(1, null), row(3, null), row(2, null)])).toEqual(['3:theirs']);
    });
    it('mine: the newest that reached them, and each of mine still on its way that is newer; nothing older', () => {
        expect(kept([row(1, 'sent'), row(2, 'sent'), row(3, 'queued'), row(4, 'sending')])).toEqual(['2:sent', '3:queued', '4:sending']);
        expect(kept([row(1, 'sending'), row(2, 'sent')])).toEqual(['2:sent']);
        expect(kept([row(1, 'sending'), row(2, 'queued')])).toEqual(['1:sending', '2:queued']);
    });
    it('my newest failing (taken out) falls back to what is left: the one that reached them, never the line as written', () => {
        const left = [row(1, 'sent'), row(2, 'sending')].filter((r) => r.at !== 2);
        expect(kept(left)).toEqual(['1:sent']);
        const shownAfter = outsideLineShown({ id: LINE, author: ben.key, text: 'As written' },
            [{ kind: 'dm-edit', itemId: left[0].itemId, lineId: LINE, author: ben.key, at: 1, text: 'First fix' }], ben.key);
        expect(shownAfter).toMatchObject({ text: 'First fix', edited: true });
    });
    const answers: Array<[unknown, ReturnType<typeof outsideChangeOutcome>]> = [
        ['queued', 'queued'], ['sent', 'sent'], ['delivered', 'sent'], ['expired', 'sent'], ['failed', 'failed'], ['sending', null], [undefined, null], ['nonsense', null],
    ];
    for (const [state, want] of answers) {
        it(`an answer of ${String(state)}: ${String(want)}${state === 'expired' ? ' (a change is never receipted: expired means it reached them)' : ''}`, () => {
            expect(outsideChangeOutcome(state)).toBe(want);
        });
    }
});

describe('a line in one string: the Chats list, a screen reader and a report read what the bubble shows', () => {
    const line = { id: LINE, author: ana.key, text: 'hi' };
    const edit = { kind: 'dm-edit' as const, itemId: uuid(), lineId: LINE, author: ana.key, at: 2, text: 'Something else' };
    const del = { kind: 'dm-delete' as const, itemId: uuid(), lineId: LINE, author: ana.key, at: 3 };
    it('as written, edited, deleted', () => {
        expect(outsideLineWords(line, [], ben.key)).toBe('hi');
        expect(outsideLineWords(line, [edit], ben.key)).toBe('Something else');
        expect(outsideLineWords(line, [edit, del], ben.key)).toBe('This message was deleted');
    });
    it('a report: the edited words the member saw, never only the first ones; a delete landing meanwhile keeps the last seen', () => {
        expect(outsideLineReportedWords(line, [], ben.key)).toBe('hi');
        expect(outsideLineReportedWords(line, [edit], ben.key)).toBe('Something else');
        expect(outsideLineReportedWords(line, [edit, del], ben.key)).toBe('Something else');
    });
});

describe('what a tap on a line offers: one rule for both apps (outsideLineActions)', () => {
    // Every line of theirs not deleted can be reported, in every state of the chat; only what changes the chat needs it open.
    // "blocked" is a chat as Block leaves it: declined, its sender on the blocklist.
    const states = { request: 'request', open: 'open', declined: 'declined', blocked: 'declined' } as const;
    const lines = { theirs: { mine: false, deleted: false }, mine: { mine: true, deleted: false }, 'theirs, deleted': { mine: false, deleted: true }, 'mine, deleted': { mine: true, deleted: true } };
    const none = { react: false, edit: false, remove: false, report: false };
    const table: Record<keyof typeof states, Record<keyof typeof lines, typeof none>> = {
        request: { theirs: { ...none, report: true }, mine: none, 'theirs, deleted': none, 'mine, deleted': none },
        open: { theirs: { ...none, react: true, report: true }, mine: { ...none, react: true, edit: true, remove: true }, 'theirs, deleted': none, 'mine, deleted': none },
        declined: { theirs: { ...none, report: true }, mine: none, 'theirs, deleted': none, 'mine, deleted': none },
        blocked: { theirs: { ...none, report: true }, mine: none, 'theirs, deleted': none, 'mine, deleted': none },
    };
    for (const [s, state] of Object.entries(states) as Array<[keyof typeof states, (typeof states)[keyof typeof states]]>) {
        for (const [l, line] of Object.entries(lines) as Array<[keyof typeof lines, (typeof lines)[keyof typeof lines]]>) {
            it(`${s} chat, ${l} line`, () => expect(outsideLineActions(state, line)).toEqual(table[s][l]));
        }
    }
    it('the invariant, over every case: theirs and not deleted = Report; anything else that shows needs the chat open', () => {
        for (const state of ['request', 'open', 'declined'] as const) {
            for (const mine of [false, true]) {
                for (const deleted of [false, true]) {
                    const a = outsideLineActions(state, { mine, deleted });
                    expect(a.report).toBe(!mine && !deleted);
                    if (a.react || a.edit || a.remove) expect(state === 'open' && !deleted).toBe(true);
                }
            }
        }
    });
});
