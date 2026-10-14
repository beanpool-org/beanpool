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
 *   2. Lower, upper, then lower: full case folding, so "STRASSE", "Straße" and "STRAẞE" are one name, as are "ΣΟΦΙΑ"
 *      and "σοφια". The first lower is for capital "ẞ" (U+1E9E), whose upper case is itself: without it "ẞ" folded to
 *      "ß", not "ss", the one code point where the fold was not idempotent (deciding review of #1956, N1).
 *   3. Greek final sigma "ς" is "σ", wherever it sits ("Οδυσσευς" typed with either is one name).
 *   4. Turkish: "İ" (dotted capital) and "ı" (dotless small) are "i", so "İpek", "Ipek", "ipek" and "ıpek" are one
 *      name. This does not follow Turkish casing (where İ/i and I/ı are separate letters) on purpose: the rule must
 *      be the same for every member of a community whatever their language, and a pair that differ only there would
 *      look the same to most members, so they may not both be taken.
 *
 * Accents are NOT dropped: "Émile" and "Emile" are different names. No trimming either: callers trim what was typed.
 */
export function foldName(name: string): string {
    return name.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase()
        .replace(/ς/g, 'σ')
        .replace(/i̇/g, 'i')
        .replace(/ı/g, 'i')
        .normalize('NFKC');
}

/**
 * The member name of a project's enterprise row (a crowdfund's, a Commons proposal's) for `title`: its first 40 characters,
 * or, when another live row (not migrated, not pruned) holds a name that folds the same, those cut to 33 with "-" and the
 * row id's first six. A project's title is free text and two may be alike; the row's name is a member name like any other,
 * so it takes the one name rule at the create and at every title edit, which wrote the title there unchecked (review of
 * #1956, N3). The title itself is stored as typed (projects, commons_projects).
 */
export function projectRowName(db: Db, title: string, id: string): string {
    const base = (title || 'Project').trim().slice(0, 40) || 'Project';
    const taken = db.prepare(`SELECT 1 FROM members WHERE callsign_fold = ? AND status NOT IN ('migrated', 'pruned') AND public_key != ? LIMIT 1`)
        .get(foldName(base), id);
    return taken ? `${base.slice(0, 33)}-${id.slice(0, 6)}` : base;
}

/**
 * Registers `name_fold(text)`, which is `foldName`, on a connection. NULL for NULL. A function lives on the connection,
 * not in the file, so nothing stored in the file (an index, a trigger, a view) may call it: SQLite compiles a trigger into
 * every statement that fires it, so a stored one would make every other handle on the file (the previous image after a
 * rollback, the sqlite3 shell, a plain better-sqlite3 handle) fail to add a member or change a name (deciding review of
 * #1956, B1). Reads bind `foldName(x)` from JS instead, so they need it on no connection.
 */
const registered = new WeakSet<Db>();

export function registerNameFunctions(db: Db): void {
    if (registered.has(db)) return;
    registered.add(db);
    db.function('name_fold', { deterministic: true }, (v: unknown) => (v == null ? null : foldName(String(v))));
}

/**
 * `name_fold` on this connection, and its two TEMP triggers, which write `members.callsign_fold` on every INSERT and every
 * UPDATE OF callsign (an upsert and an INSERT OR REPLACE included) made through it. TEMP: they live in this connection's
 * temp schema (sqlite_temp_master), never in the file, so a handle without them writes members as it always did, and
 * the next boot's re-fold (the server's db.ts migrateCallsignFold) repairs the fold of whatever it wrote. The body names
 * `members` unqualified (SQLite allows no schema there); with no temp.members it is main's. Nothing to do
 * on a database without the column (one no server of this version has booted yet): the boot adds it, then calls this.
 */
export function installNameFold(db: Db): void {
    registerNameFunctions(db);
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('members') WHERE name = 'callsign_fold'`).get()) return;
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS members_callsign_fold_on_insert AFTER INSERT ON main.members BEGIN
        UPDATE members SET callsign_fold = name_fold(NEW.callsign) WHERE public_key = NEW.public_key;
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS members_callsign_fold_on_rename AFTER UPDATE OF callsign ON main.members BEGIN
        UPDATE members SET callsign_fold = name_fold(NEW.callsign) WHERE public_key = NEW.public_key;
    END;`);
}
