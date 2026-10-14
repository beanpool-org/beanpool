import type Database from 'better-sqlite3';

type Db = Database.Database;

/**
 * The ONE rule by which two member names are "the same name" on a node: the lookup for a sign-in restore, the
 * recovery collect, the availability check and the rename gate all compare `foldName` of both sides.
 *
 * SQLite's `lower()` folds A–Z only, while the server folded the typed name with JS `toLowerCase()` (all of Unicode),
 * so "Олег" or "Émile", typed exactly as stored, matched nothing, and a taken non-ASCII name read as free.
 *
 *   1. NFKC: a precomposed "É" and "E" + combining acute are one name; so are fullwidth "Ｍａｒｔｙ" and "Marty".
 *   2. Upper, then lower: full case folding, so "STRASSE" and "Straße" are one name, as are "ΣΟΦΙΑ" and "σοφια".
 *   3. Greek final sigma "ς" is "σ", wherever it sits ("Οδυσσευς" typed with either is one name).
 *   4. Turkish: "İ" (dotted capital) and "ı" (dotless small) are "i", so "İpek", "Ipek", "ipek" and "ıpek" are one
 *      name. This does not follow Turkish casing (where İ/i and I/ı are separate letters) on purpose: the rule must
 *      be the same for every member of a community whatever their language, and a pair that differ only there would
 *      look the same to most members, so they may not both be taken.
 *
 * Accents are NOT dropped: "Émile" and "Emile" are different names. No trimming either: callers trim what was typed.
 */
export function foldName(name: string): string {
    return name.normalize('NFKC').toUpperCase().toLowerCase()
        .replace(/ς/g, 'σ')
        .replace(/i̇/g, 'i')
        .replace(/ı/g, 'i')
        .normalize('NFKC');
}

/**
 * Registers `name_fold(text)`, which is `foldName`, on a connection. NULL for NULL. A function lives on the connection,
 * not in the file, so no index, trigger or stored column uses it: any other handle on the file (a backup reader, the
 * sqlite3 shell) would fail on the members table. Every connection that runs a name query registers it, and a query
 * on one that forgot fails loudly ("no such function"), never silently.
 */
const registered = new WeakSet<Db>();

export function registerNameFunctions(db: Db): void {
    if (registered.has(db)) return;
    registered.add(db);
    db.function('name_fold', { deterministic: true }, (v: unknown) => (v == null ? null : foldName(String(v))));
}
