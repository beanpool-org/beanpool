/**
 * The one quiet row for the lines from before a member changed phones (DESIGN-group-history-after-rekey-fable.md §7,
 * Marty's pick 5 of 13 Oct): which lines collapse into it, and that it, its sheet and the chat menu's "Confirm new phone"
 * hold at the floor, 320dp wide with the phone's text at 1.3× (memory product-audience-small-screens). The widths are a
 * model of the components' own numbers read from their source, with a generous glyph width (0.62em, a bold Latin face),
 * as key-changed-320.test.ts does.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn(), randomUUID: vi.fn(), digest: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}), deleteItemAsync: vi.fn(async () => {}) }));

import {
    collapseLockedHistory, lockedHistoryRowText, LOCKED_HISTORY_ASK, LOCKED_HISTORY_KEEP, LOCKED_HISTORY_ROW_ID, LOCKED_HISTORY_SHEET_TITLE,
    LOCKED_HISTORY_WORDS, NEW_PHONE_CONFIRM_MENU,
} from '../group-history-unlock';

type L = { id: string; text: string };
const line = (id: string): L => ({ id, text: id });

describe('which lines collapse into the row', () => {
    // a, b (epoch 1) and d (epoch 2) wait from before the first epoch read (c, 3); e (4) waits after it: a lost wrap.
    const epochs: Record<string, number> = { a: 1, b: 1, c: 3, d: 2, e: 4 };
    const waiting = new Set(['a', 'b', 'd', 'e']);
    const lines = ['a', 'b', 'c', 'd', 'e'].map(line);
    const opts = {
        epochOf: (id: string) => epochs[id] ?? null,
        waiting: (id: string) => waiting.has(id),
        row: (n: number): L => ({ id: LOCKED_HISTORY_ROW_ID, text: lockedHistoryRowText(n) }),
    };

    it('a member who changed phones: every waiting line from before the first epoch this phone reads is one row, where the first was', () => {
        const out = collapseLockedHistory(lines, { ...opts, changedPhones: true });
        expect(out.map((l) => l.id)).toEqual([LOCKED_HISTORY_ROW_ID, 'c', 'e']);
        expect(out[0].text).toBe('🔒 3 messages from before you changed phones. Unlock →');
    });

    it('a waiting line after the first read epoch (a lost wrap) keeps its own sentence', () => {
        const out = collapseLockedHistory(lines, { ...opts, changedPhones: true });
        expect(out.some((l) => l.id === 'e')).toBe(true);
    });

    it('a member who never changed phones: nothing changes', () => {
        expect(collapseLockedHistory(lines, { ...opts, changedPhones: false })).toEqual(lines);
    });

    it('nothing read yet: every waiting line with an epoch is in the row; one message says "message"', () => {
        const out = collapseLockedHistory([line('a')], { ...opts, changedPhones: true });
        expect(out.map((l) => l.text)).toEqual(['🔒 1 message from before you changed phones. Unlock →']);
    });
});

describe('the row, its sheet and the menu label at 320dp with 1.3× text', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../components/GroupChatView.tsx'), 'utf8');
    const chatStyles = fs.readFileSync(path.join(__dirname, '../../components/chat/styles.ts'), 'utf8');
    const num = (from: string, re: RegExp) => Number(re.exec(from)?.[1]);
    const SCALE = 1.3;
    const GLYPH = 0.62;
    const widest = (text: string, fontSize: number) => Math.max(...text.split(/\s+/).map((w) => [...w].length)) * fontSize * SCALE * GLYPH;

    it('the row wraps (no line limit), is a 48dp target, and its longest word fits its width', () => {
        const comp = /function LockedHistoryRow[\s\S]*?\n}\n/.exec(src)?.[0] ?? '';
        expect(comp).not.toBe('');
        expect(comp).not.toMatch(/numberOfLines/);
        const style = /lockedHistoryRow: \{([\s\S]*?)\},/.exec(src)?.[1] ?? '';
        expect(num(style, /minHeight: (\d+)/)).toBeGreaterThanOrEqual(48);
        const font = num(/lockedHistoryText: \{([\s\S]*?)\}/.exec(src)?.[1] ?? '', /fontSize: (\d+)/);
        const wrapPad = num(/systemWrap: \{([\s\S]*?)\}/.exec(src)?.[1] ?? '', /paddingHorizontal: (\d+)/);
        const rowPad = num(style, /paddingHorizontal: (\d+)/);
        const width = 320 - 2 * wrapPad - 2 * rowPad;
        expect(widest(lockedHistoryRowText(1234), font)).toBeLessThan(width);
    });

    it('the sheet\'s title, body and choices wrap; each choice is a 56dp row and its longest word fits', () => {
        const comp = /function LockedHistorySheet[\s\S]*?\n}\n/.exec(src)?.[0] ?? '';
        expect(comp).not.toBe('');
        expect(comp).not.toMatch(/numberOfLines/);
        const row = /menuRow: \{([^}]*)\}/.exec(chatStyles)?.[1] ?? '';
        const label = /menuLabel: \{([^}]*)\}/.exec(chatStyles)?.[1] ?? '';
        expect(num(row, /minHeight: (\d+)/)).toBeGreaterThanOrEqual(48);
        const width = 320 - 2 * num(row, /paddingHorizontal: (\d+)/) - 22 - num(row, /gap: (\d+)/);
        for (const t of [LOCKED_HISTORY_WORDS, LOCKED_HISTORY_ASK, LOCKED_HISTORY_KEEP, LOCKED_HISTORY_SHEET_TITLE]) {
            expect(widest(t, num(label, /fontSize: (\d+)/))).toBeLessThan(width);
        }
    });

    it('"Confirm new phone" fits the chat menu\'s one line whole', () => {
        const row = /menuRow: \{([^}]*)\}/.exec(chatStyles)?.[1] ?? '';
        const label = /menuLabel: \{([^}]*)\}/.exec(chatStyles)?.[1] ?? '';
        const width = 320 - 2 * num(row, /paddingHorizontal: (\d+)/) - 22 - num(row, /gap: (\d+)/);
        const whole = [...NEW_PHONE_CONFIRM_MENU].length * num(label, /fontSize: (\d+)/) * SCALE * GLYPH;
        expect(whole).toBeLessThan(width);
    });
});
