/**
 * The comparisons of the twin suite (test-takeover-parity.ts; not a suite itself): a promoted standby S against T, a copy
 * of its main server's data directory taken at S's last copy. Every difference gets a stable key, so the suite can hold
 * the ones main has today in its KNOWN_GAPS list and fail on any other.
 *
 * Keys:
 *  - `db:<table> rows missing` / `db:<table> rows extra`: a row T has and S hasn't, or the other way round (rows are
 *    matched by the manifest's key, else the primary key);
 *  - `db:<table>.<column>`: a row both have, with another value in that column;
 *  - `db:<table> (not copied)`: any of those in a table main doesn't copy at all (one gap, whatever the standby's own
 *    writes left in it);
 *  - `setting:<where>.<name>`: a community setting (engine/replication-manifest.ts LOCAL_CONFIG_FIELDS, NODE_CONFIG_*);
 *  - `http:<call>`: the same signed call answered differently, after normalising times, new ids and ports.
 */

import type { SettingEntry } from './engine/replication-manifest.js';

export interface TableDump {
    key: string[];
    columns: string[];
    rows: Record<string, unknown>[];
    /** The gap id of a table main doesn't copy at all: any difference in it is that one gap, `db:<table> (not copied)`. */
    notCopied?: string;
}
export type DbDump = Record<string, TableDump>;

export interface SettingsDump {
    localConfig: Record<string, unknown>;
    localConfigKeys: string[];
    nodeConfig: Record<string, string>;
    nodeConfigBlob: Record<string, unknown>;
}

/** Differences by key, each with a few examples of what differed. */
export type Differences = Map<string, string[]>;

const MAX_EXAMPLES = Number(process.env.PARITY_EXAMPLES) || 3;

function note(out: Differences, key: string, example: string): void {
    const list = out.get(key) ?? [];
    if (list.length < MAX_EXAMPLES) list.push(example);
    out.set(key, list);
}

const show = (v: unknown, n = 70): string => {
    const s = JSON.stringify(v) ?? 'undefined';
    return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** Every difference between two databases, table by table, in the columns the manifest compares. */
export function diffDatabases(twin: DbDump, promoted: DbDump, out: Differences = new Map()): Differences {
    for (const table of new Set([...Object.keys(twin), ...Object.keys(promoted)])) {
        const t = twin[table];
        const s = promoted[table];
        if (!t || !s) {
            note(out, `db:${table} not compared on both`, `twin ${!!t}, promoted ${!!s}`);
            continue;
        }
        const keyOf = (r: Record<string, unknown>) => JSON.stringify(t.key.map((k) => r[k]));
        const whole = t.notCopied ? `db:${table} (not copied)` : null;
        const sRows = new Map(s.rows.map((r) => [keyOf(r), r]));
        const tKeys = new Set<string>();
        for (const tr of t.rows) {
            const k = keyOf(tr);
            tKeys.add(k);
            const sr = sRows.get(k);
            if (!sr) {
                note(out, whole ?? `db:${table} rows missing`, `missing ${show(k, 60)}`);
                continue;
            }
            for (const c of t.columns) {
                if (JSON.stringify(tr[c]) !== JSON.stringify(sr[c])) {
                    note(out, whole ?? `db:${table}.${c}`, `${show(k, 40)}${whole ? ` ${c}` : ''}: twin ${show(tr[c], 50)}, promoted ${show(sr[c], 50)}`);
                }
            }
        }
        for (const [k] of sRows) if (!tKeys.has(k)) note(out, whole ?? `db:${table} rows extra`, `extra ${show(k, 60)}`);
    }
    return out;
}

export interface SettingClassifiers {
    localConfig: (field: string) => SettingEntry | undefined;
    nodeConfigKey: (key: string) => SettingEntry | undefined;
    nodeConfigBlob: (field: string) => SettingEntry | undefined;
    mustMatch: (entry: SettingEntry) => boolean;
}

/**
 * Every community setting the promoted standby holds otherwise than its main server did, and every setting either one
 * holds that the manifest doesn't classify (`setting:unclassified …`, never a known gap: classify it).
 */
export function diffSettings(twin: SettingsDump, promoted: SettingsDump, c: SettingClassifiers, out: Differences = new Map()): Differences {
    // An empty list and no list say the same: the take-over writes `[]` where its main server had never written one.
    const same = (a: unknown, b: unknown) => {
        const v = (x: unknown) => JSON.stringify(Array.isArray(x) && x.length === 0 ? null : x ?? null);
        return v(a) === v(b);
    };
    const compare = (where: string, name: string, entry: SettingEntry | undefined, a: unknown, b: unknown) => {
        if (!entry) {
            note(out, `setting:unclassified ${where}.${name}`, `twin ${show(a)}, promoted ${show(b)}`);
            return;
        }
        if (c.mustMatch(entry) && !same(a, b)) {
            note(out, `setting:${where}.${name}`, `twin ${show(a)}, promoted ${show(b)}`);
        }
    };
    for (const f of new Set([...twin.localConfigKeys, ...promoted.localConfigKeys, ...Object.keys(twin.localConfig)])) {
        compare('local-config', f, c.localConfig(f), twin.localConfig[f], promoted.localConfig[f]);
    }
    for (const k of new Set([...Object.keys(twin.nodeConfig), ...Object.keys(promoted.nodeConfig)])) {
        if (k === 'node_config') continue;
        compare('node_config', k, c.nodeConfigKey(k), twin.nodeConfig[k], promoted.nodeConfig[k]);
    }
    for (const f of new Set([...Object.keys(twin.nodeConfigBlob), ...Object.keys(promoted.nodeConfigBlob)])) {
        compare('node_config.node_config', f, c.nodeConfigBlob(f), twin.nodeConfigBlob[f], promoted.nodeConfigBlob[f]);
    }
    return out;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PORT = /(127\.0\.0\.1|localhost):\d+/g;

/**
 * An answer as the comparison sees it: times as `<time>`, ids neither server had before the call as `<new-id>`, local
 * ports as `<port>`. Everything else is kept, order included.
 */
export function normaliseAnswer(value: unknown, knownIds: Set<string>): unknown {
    if (typeof value === 'string') {
        if (ISO_TIME.test(value)) return '<time>';
        return value
            .replace(PORT, '$1:<port>')
            .replace(UUID, (id) => (knownIds.has(id.toLowerCase()) ? id : '<new-id>'));
    }
    if (typeof value === 'number') return value > 1e12 && value < 1e13 ? '<ms>' : value;
    if (Array.isArray(value)) return value.map((v) => normaliseAnswer(v, knownIds));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = normaliseAnswer(v, knownIds);
        return out;
    }
    return value;
}

/** Every id-shaped string in a value, lower case. */
export function idsIn(value: unknown): Set<string> {
    return new Set((JSON.stringify(value) ?? '').match(UUID)?.map((s) => s.toLowerCase()) ?? []);
}

const hasIds = (xs: unknown[]) => xs.length > 0 && xs.every((x) => x !== null && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string');

/**
 * The first few paths at which two JSON values differ. Two lists of things with ids (listings, deals) are compared by id:
 * which ones only one side has, whether the order differs, and then each one's fields.
 */
export function firstDifferences(a: unknown, b: unknown, path = '$', out: string[] = [], max = 3): string[] {
    if (out.length >= max) return out;
    if (JSON.stringify(a) === JSON.stringify(b)) return out;
    const isObj = (v: unknown) => v !== null && typeof v === 'object';
    if (Array.isArray(a) && Array.isArray(b) && (hasIds(a) || hasIds(b))) {
        const byId = (xs: unknown[]) => new Map(xs.map((x) => [(x as { id: string }).id, x as Record<string, unknown>]));
        const ta = byId(a);
        const tb = byId(b);
        const name = (x: Record<string, unknown>) => String(x.title ?? x.name ?? x.id);
        const onlyA = [...ta.values()].filter((x) => !tb.has(x.id as string)).map(name);
        const onlyB = [...tb.values()].filter((x) => !ta.has(x.id as string)).map(name);
        if (onlyA.length) out.push(`${path}: only the twin shows ${show(onlyA, 120)}`);
        if (onlyB.length && out.length < max) out.push(`${path}: only the promoted server shows ${show(onlyB, 120)}`);
        const shared = (xs: unknown[], other: Map<string, unknown>) => xs.map((x) => (x as { id: string }).id).filter((id) => other.has(id));
        if (out.length < max && JSON.stringify(shared(a, tb)) !== JSON.stringify(shared(b, ta))) out.push(`${path}: in another order`);
        for (const [id, x] of ta) {
            if (out.length >= max) break;
            if (tb.has(id)) firstDifferences(x, tb.get(id), `${path}[${name(x)}]`, out, max);
        }
        return out;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) out.push(`${path}: ${a.length} items vs ${b.length}`);
        for (let i = 0; i < Math.min(a.length, b.length) && out.length < max; i++) firstDifferences(a[i], b[i], `${path}[${i}]`, out, max);
        return out;
    }
    if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
        const ao = a as Record<string, unknown>;
        const bo = b as Record<string, unknown>;
        for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
            if (out.length >= max) break;
            firstDifferences(ao[k], bo[k], `${path}.${k}`, out, max);
        }
        return out;
    }
    out.push(`${path}: twin ${show(a, 60)}, promoted ${show(b, 60)}`);
    return out;
}

/** A known gap: a difference main has today, with the design's gap id. */
export interface KnownGap {
    key: string;
    gap: string;
    why: string;
}

/**
 * The strict check: every difference found is a known gap, and every known gap still differs. Answers the two lists
 * that break it.
 */
export function checkKnownGaps(found: Differences, known: KnownGap[]): { unlisted: string[]; noLongerDiffer: KnownGap[]; listedTwice: string[] } {
    const keys = known.map((g) => g.key);
    return {
        unlisted: [...found.keys()].filter((k) => !keys.includes(k)).sort(),
        noLongerDiffer: known.filter((g) => !found.has(g.key)),
        listedTwice: keys.filter((k, i) => keys.indexOf(k) !== i),
    };
}
