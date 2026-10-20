/**
 * The generic checks every registered tool passes (scratch/tools/DESIGN-tool-template-fable.md §1.5 (a), (b), (d)): the
 * manifest's shape and bounds, its document's reading of every stored value it ever wrote, and its pure functions
 * bounded on the tool's own fixtures. One sentence per problem, naming the tool, so a failing test says what to change.
 * The rest of the checklist (sentences, data, code size, registration in all three packages, the import fence) needs the
 * sources and is scripts/tools/check-tool-budgets.mjs's and eslint's.
 *
 * Pure: no I/O.
 */
import { SHOWCASE_FEATURES } from '../features.js';
import {
    SHOP_KINDS, TOOL_ID_PATTERN, TOOL_LIMITS, TOOL_PERMISSIONS, TOOL_SHELVES,
    type ToolDue, type ToolLine, type ToolManifest,
} from './manifest.js';

/** A tool's fixtures (`packages/beanpool-core/src/tools/<id>/fixtures.ts`, exported as FIXTURES). */
export interface ToolFixtures<D> {
    /** One stored value per version the tool ever wrote, and any odd value worth keeping, each with what this build reads. */
    stored: ReadonlyArray<{ name: string; raw: unknown; reads: D }>;
    /** The documents the generic tests and the screens are drawn with. `full` is as big as the tool lets a document grow. */
    docs: { empty: D; small: D; full: D };
    /** The moment the docs' dates are relative to. */
    now: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON with its keys sorted, so two values that mean the same compare equal. Undefined for a value JSON can't hold. */
function canonical(value: unknown): string | undefined {
    const sort = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sort);
        if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
        return v;
    };
    try {
        return JSON.stringify(sort(value));
    } catch {
        return undefined;
    }
}
const sameJson = (a: unknown, b: unknown) => canonical(a) !== undefined && canonical(a) === canonical(b);
/** What toolFixtureProblems' reread gives instead of a document, so each is a sentence and never a throw. */
const NOT_JSON = Symbol('not JSON');
const THROWS = Symbol('read() throws');

/** UTF-8 bytes of a value serialised as JSON, without TextEncoder (pure, every runtime). */
export function toolDocBytes(doc: unknown): number {
    const s = JSON.stringify(doc) ?? '';
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
        else n += 3;
    }
    return n;
}

const SCREEN_NAME = /^[a-z][a-z0-9-]{0,23}$/;
const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function repeated(list: readonly string[]): string[] {
    return [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];
}

/** Problems with a manifest's shape and bounds, one sentence each; empty when it is a tool. */
export function toolManifestProblems(m: ToolManifest): string[] {
    const out: string[] = [];
    const id = typeof m?.id === 'string' ? m.id : String(m?.id);
    const say = (s: string) => out.push(`Tool ${id}: ${s}`);
    if (!TOOL_ID_PATTERN.test(id) || id.length > TOOL_LIMITS.idChars) {
        say(`its id is 2 to ${TOOL_LIMITS.idChars} lowercase letters and hyphens, a letter at each end and never two hyphens together.`);
    }
    if (typeof m.name !== 'string' || m.name.trim() === '') say("its name is a word('…') sentence.");
    if (typeof m.line !== 'string' || m.line.trim() === '') say("its line is a word('…') sentence.");
    if (typeof m.icon !== 'string' || !/\p{Extended_Pictographic}/u.test(m.icon) || /[\p{L}\p{N}\s]/u.test(m.icon) || m.icon.length > 16) {
        say('its icon is one emoji.');
    }
    if (!TOOL_SHELVES.includes(m.shelf)) say(`its shelf is one of ${TOOL_SHELVES.join(', ')}.`);
    if (m.shopKinds !== 'all') {
        if (!Array.isArray(m.shopKinds)) say("its shopKinds are 'all' or a list of shop kinds.");
        else {
            const unknown = m.shopKinds.filter((k) => !(SHOP_KINDS as readonly string[]).includes(k));
            if (unknown.length) say(`${unknown.join(', ')} is not a shop kind (${SHOP_KINDS.join(', ')}).`);
            if (repeated(m.shopKinds).length) say(`its shopKinds name ${repeated(m.shopKinds).join(', ')} more than once.`);
        }
    }
    if (!['member', 'enterprise', 'both'].includes(m.owner)) say("its owner is 'member', 'enterprise' or 'both'.");
    const permissions = Array.isArray(m.permissions) ? m.permissions : [];
    if (!Array.isArray(m.permissions)) say('its permissions are a list.');
    const unknownPermissions = permissions.filter((p) => !(TOOL_PERMISSIONS as readonly string[]).includes(p));
    if (unknownPermissions.length) say(`${unknownPermissions.join(', ')} is not a permission (${TOOL_PERMISSIONS.join(', ')}).`);
    if (repeated(permissions).length) say(`its permissions name ${repeated(permissions).join(', ')} more than once.`);
    if (m.reminders && !permissions.includes('reminders')) say("it has reminders but does not ask for the 'reminders' permission.");
    if (!m.reminders && permissions.includes('reminders')) say("it asks for 'reminders' but has none: ask only for what it uses.");
    const screens = Array.isArray(m.screens) ? m.screens : [];
    if (screens[0] !== 'main') say("its screens start with 'main'.");
    const badScreens = screens.filter((s) => typeof s !== 'string' || !SCREEN_NAME.test(s));
    if (badScreens.length) say(`screen ${badScreens.join(', ')} is not 1 to 24 lowercase letters, digits and hyphens.`);
    if (repeated(screens).length) say(`its screens name ${repeated(screens).join(', ')} more than once.`);
    if (!Array.isArray(m.examples) || m.examples.length < 1 || m.examples.length > TOOL_LIMITS.examples) {
        say(`it has 1 to ${TOOL_LIMITS.examples} examples for the "I'm starting out" door.`);
    }
    if (m.guide !== undefined && (typeof m.guide !== 'string' || !GUIDE_SLUG.test(m.guide))) say("its guide is a members' guide page slug.");
    for (const [action, feature] of Object.entries(m.needs ?? {})) {
        if (!(SHOWCASE_FEATURES as readonly string[]).includes(feature)) say(`needs.${action} is not a node feature (${SHOWCASE_FEATURES.join(', ')}).`);
    }
    const reminderIds = (m.reminders?.list ?? []).map((r) => r.id);
    if (m.reminders && reminderIds.length === 0) say('its reminders list names at least one.');
    if (repeated(reminderIds).length) say(`its reminders name ${repeated(reminderIds).join(', ')} more than once.`);
    if (m.homeCard && (typeof m.homeCard.line !== 'string' || m.homeCard.line.trim() === '')) say("its Home card's line is a word('…') sentence.");

    const doc = m.doc;
    if (!doc || !Number.isInteger(doc.version) || doc.version < 1) {
        say('its document has a version, a whole number from 1.');
        return out;
    }
    const max = doc.maxBytes ?? TOOL_LIMITS.docBytes;
    if (max > TOOL_LIMITS.docBytes) say(`its document is at most ${TOOL_LIMITS.docBytes} bytes, the node's bound.`);
    let empty: unknown;
    try {
        empty = doc.empty();
    } catch {
        say('its empty() throws.');
        return out;
    }
    if (!isPlainObject(empty) || empty.v !== doc.version) say(`its empty() is an object with v: ${doc.version}.`);
    for (const [what, raw] of [['nothing', undefined], ['null', null], ['a number', 7], ['text', 'x'], ['a list', []], ['an object with no v', {}]] as const) {
        try {
            const read = doc.read(raw);
            if (!isPlainObject(read) || typeof read.v !== 'number') say(`its read() of ${what} is not a document.`);
        } catch {
            say(`its read() throws on ${what}: it must never throw (an unreadable value is empty()).`);
        }
    }
    try {
        if (!sameJson(doc.read(empty), empty)) say('its read() of empty() is not empty().');
    } catch {
        say('its read() throws on its own empty().');
    }
    return out;
}

/** A line or a due reminder's problem with the screens it may open. */
function lineProblem(line: ToolLine | ToolDue, screens: readonly string[]): string | null {
    if (!isPlainObject(line) || typeof line.key !== 'string' || line.key.trim() === '') return 'is not { key, values? }';
    if (line.screen !== undefined && !screens.includes(line.screen)) return `opens ${line.screen}, which is not one of its screens`;
    return null;
}

/**
 * Problems with a tool's fixtures and with its pure functions on them, one sentence each: every stored value reads as
 * the fixture says, reading twice is reading once, every version 1 to `version` has a stored value, a newer version's
 * unknown keys are kept (at the top and on its records), the full document fits its bound, and row(), the Home card's
 * lines() and due() are the same twice and within their bounds.
 */
export function toolFixtureProblems<D>(m: ToolManifest<D>, fx: ToolFixtures<D>): string[] {
    const out: string[] = [];
    const say = (s: string) => out.push(`Tool ${m.id}: ${s}`);
    /** `d` stored (through JSON) and read again, or which of the two it can't be. */
    const reread = (d: unknown): unknown => {
        let stored: unknown;
        try {
            stored = JSON.parse(JSON.stringify(d));
        } catch {
            return NOT_JSON;
        }
        try {
            return m.doc.read(stored);
        } catch {
            return THROWS;
        }
    };
    const versions = new Set<number>();
    for (const s of fx.stored ?? []) {
        if (isPlainObject(s.raw) && typeof s.raw.v === 'number') versions.add(s.raw.v);
        let got: D;
        try {
            got = m.doc.read(s.raw);
        } catch {
            say(`read() throws on the stored value "${s.name}".`);
            continue;
        }
        if (!sameJson(got, s.reads)) say(`read() of the stored value "${s.name}" is not what its fixture says it reads as.`);
        const again = reread(got);
        if (again === NOT_JSON) say(`read() of the stored value "${s.name}" is not JSON, so it can't be stored.`);
        else if (again === THROWS) say(`read() throws on its own reading of "${s.name}": it must never throw.`);
        else if (!sameJson(again, got)) say(`read() of "${s.name}" read again is not the same: reading twice must be reading once.`);
    }
    for (let v = 1; v <= m.doc.version; v++) {
        if (!versions.has(v)) say(`its fixtures have no stored value of version ${v}: keep one of every version it ever wrote.`);
    }
    const max = m.doc.maxBytes ?? TOOL_LIMITS.docBytes;
    for (const [name, d] of Object.entries(fx.docs ?? {}) as [string, D][]) {
        const again = reread(d);
        if (again === NOT_JSON) {
            say(`its ${name} document is not JSON, so it can't be stored.`);
            continue;
        }
        if (again === THROWS) say(`read() throws on its ${name} document: it must never throw.`);
        else if (!sameJson(again, d)) say(`its ${name} document does not read back as itself.`);
        if (toolDocBytes(d) > max) say(`its ${name} document is ${toolDocBytes(d)} bytes, over its ${max}.`);
    }
    const full = fx.docs?.full;
    if (isPlainObject(full)) {
        // A newer app's keys at the top and on the first record of each list of records.
        const later = { kept: true };
        const lists = Object.keys(full).filter((k) => Array.isArray(full[k]) && isPlainObject((full[k] as unknown[])[0]));
        const newer: Record<string, unknown> = { ...full, v: m.doc.version + 1, __later: later };
        for (const k of lists) {
            const [first, ...rest] = full[k] as Record<string, unknown>[];
            newer[k] = [{ ...first, __later: later }, ...rest];
        }
        try {
            const read = m.doc.read(newer) as unknown;
            if (!isPlainObject(read) || !sameJson(read.__later, later)) {
                say("read() of a newer version drops keys it doesn't know: keep them, so a newer app's document survives this one's write.");
            } else {
                for (const k of lists) {
                    const kept = Array.isArray(read[k]) && (read[k] as unknown[]).some((r) => isPlainObject(r) && sameJson(r.__later, later));
                    if (!kept) say(`read() of a newer version drops the keys it doesn't know on a record in ${k}: keep them too.`);
                }
            }
        } catch {
            say('read() throws on a newer version.');
        }
    }
    const screens = m.screens;
    for (const [name, d] of Object.entries(fx.docs ?? {}) as [string, D][]) {
        const twice = <T>(what: string, f: () => T): T | undefined => {
            try {
                const a = f();
                if (!sameJson(a, f())) say(`its ${what} on the ${name} document is not the same twice: it must be pure.`);
                return a;
            } catch {
                say(`its ${what} throws on the ${name} document.`);
                return undefined;
            }
        };
        const row = twice('row()', () => m.row(d, fx.now));
        if (row) {
            const p = lineProblem(row, screens);
            if (p) say(`its row() on the ${name} document ${p}.`);
        }
        if (m.homeCard) {
            const lines = twice("Home card's lines()", () => m.homeCard!.lines(d, fx.now)) ?? [];
            if (lines.length > TOOL_LIMITS.homeLines) say(`its Home card has ${lines.length} lines on the ${name} document, over ${TOOL_LIMITS.homeLines}.`);
            for (const l of lines) {
                const p = lineProblem(l, screens);
                if (p) say(`a Home card line on the ${name} document ${p}.`);
            }
        }
        if (m.reminders) {
            const ids = m.reminders.list.map((r) => r.id);
            const due = twice('due()', () => m.reminders!.due(d, fx.now)) ?? [];
            if (due.length > TOOL_LIMITS.due) say(`its due() returns ${due.length} on the ${name} document, over ${TOOL_LIMITS.due}.`);
            for (const r of due) {
                const p = lineProblem(r, screens);
                if (p) say(`a reminder due on the ${name} document ${p}.`);
                if (!ids.includes(r.reminder)) say(`a reminder due on the ${name} document is ${r.reminder}, not one of its reminders.`);
                if (!Number.isFinite(r.at)) say(`a reminder due on the ${name} document has no time.`);
            }
        }
    }
    return out;
}
