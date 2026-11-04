// glossary.test.mjs — the glossary, numbers and untranslatable checks of words:check (translation slice T0, scratch/fable-design/
// DESIGN-translation-tooling-fable.md §4) and the baseline that holds today's catalogs. words.test.mjs imports this file, so
// node --test scripts/words/words.test.mjs runs it. In memory, but for one temporary folder of fixtures under the OS temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    GLOSSARY_BASELINE, ROOT, baselineAt, baselineBase, catalogLangs, checkRepo, extractFromSource, extractRepo, loadCoreChecks, loadGlossary,
    ratchetCompare, readRatchet, unexplainedAdditions, updatedRatchet, violationId,
} from './words.mjs';
import { csvField, glossaryForBrief, parseCsv, parseGlossary } from './glossary.mjs';
import { writeBriefs } from './draft.mjs';

const pkgOf = (file, text) => {
    const { calls, found, problems } = extractFromSource(file, text);
    return { name: 'fixture', dirs: [], words: 'fixture/words', lint: true, files: 1, calls, found, problems };
};
const source = (...sentences) => `import { t } from '@beanpool/core';\nexport const a = () => [${sentences.map((s) => `t(${JSON.stringify(s)})`).join(', ')}];\n`;
const noCatalogs = { ru: {}, fr: {}, pt: {}, es: {} };

/**
 * One English sentence and its translation in `lang`, through words:check as it runs: `structural` is what words:check refused before
 * this slice (it is unchanged), `rules` is what the glossary, numbers and untranslatable checks refuse now.
 */
async function judge(lang, english, translation) {
    const { terms } = await loadGlossary();
    const catalogs = { 'fixture/words': { ...noCatalogs, [lang]: { [english]: translation } } };
    const r = await checkRepo({ extracted: [pkgOf('fixture/a.ts', source(english))], catalogs, glossary: terms });
    return { structural: r.problems, rules: r.violations.map((v) => `${v.rule}: ${v.problem}`) };
}

const describe = (v) => `${v.file}: ${JSON.stringify(v.key)}: ${v.rule}: ${v.problem}`;

test('a catalog value that translates or drops "BeanPool" fails; the structural check alone let it through', async () => {
    const english = 'BeanPool keeps your key on this phone';
    const translated = await judge('es', english, 'PoolDeFrijoles guarda tu clave en este teléfono');
    assert.deepEqual(translated.structural, [], 'main\'s words:check passed this');
    assert.equal(translated.rules.length, 1);
    assert.match(translated.rules[0], /^untranslatable: "BeanPool" stays "BeanPool" in every language/);
    assert.equal((await judge('ru', english, 'Пул хранит ваш ключ на этом телефоне')).rules.length, 1, 'transliterated or dropped, in any language');
    assert.equal((await judge('ja', english, 'このスマホに鍵を保管します')).rules.length, 1);
    assert.deepEqual((await judge('es', english, 'BeanPool guarda tu clave en este teléfono')).rules, []);
    // A label in capitals is the same word in capitals.
    assert.deepEqual((await judge('es', 'BEANPOOL', 'BEANPOOL')).rules, []);
    assert.equal((await judge('es', 'BEANPOOL', 'FRIJOLES')).rules.length, 1);
    // beanpool.org is an address, not the mark.
    assert.deepEqual((await judge('es', 'Open beanpool.org in a browser', 'Abre beanpool.org en un navegador')).rules, []);
});

test('typed words stay as typed; the same word as a verb in a label is translated', async () => {
    const typed = await judge('es', 'Type CONFIRM to view your 12 words', 'Escribe CONFIRMAR para ver tus 12 palabras');
    assert.deepEqual(typed.structural, []);
    assert.deepEqual(typed.rules, ['untranslatable: "CONFIRM" stays "CONFIRM" in every language, and the translation does not carry it']);
    assert.deepEqual((await judge('es', 'Type CONFIRM to view your 12 words', 'Escribe CONFIRM para ver tus 12 palabras')).rules, []);
    assert.equal((await judge('fr', "Enter 'WIPE' to go on", "Saisissez 'EFFACER' pour continuer")).rules.length, 1);
    // The phone passes the typed word as {word}: the label's own "CONFIRM" is the verb and is translated.
    assert.deepEqual((await judge('es', "TYPE '{word}' TO CONFIRM", "ESCRIBE '{word}' PARA CONFIRMAR")).rules, []);
});

test('every number in the English must be in the translation: "30 days" → "treinta días" fails', async () => {
    const english = 'An invite works for 30 days';
    const spelled = await judge('es', english, 'Una invitación sirve durante treinta días');
    assert.deepEqual(spelled.structural, [], 'main\'s words:check passed this');
    assert.deepEqual(spelled.rules, ['numbers: the English has 30 and the translation does not']);
    assert.deepEqual((await judge('es', english, 'Una invitación sirve durante 30 días')).rules, []);
    // Each number, not only the first.
    assert.equal((await judge('es', 'Between 2 and 30 days', 'Entre 2 y treinta días')).rules.length, 1);
    assert.equal((await judge('ar', 'Between 2 and 30 days', 'بين ٢ و٣٠ يومًا')).rules.length, 0, 'the language\'s own digits count');
    assert.deepEqual((await judge('de', 'A fee of 1.5% applies', 'Es fällt eine Gebühr von 1,5 % an')).rules, [], 'decimal comma');
    assert.deepEqual((await judge('ru', 'Up to 1,000 Beans', 'До 1 000 бобов')).rules.filter((r) => r.startsWith('numbers')), [], 'a space for thousands');
    // A sentence with no digit asks for none.
    assert.deepEqual((await judge('es', 'Tap Save', 'Toca Guardar')).rules, []);
});

test('numbersOf reads digits of any script, separators of any country, and leaves names alone', async () => {
    const { numbersOf } = await loadCoreChecks(ROOT);
    assert.deepEqual(numbersOf('1.5% fee, 1,000 Beans, 30 days'), ['1.5', '1000', '30']);
    assert.deepEqual(numbersOf('1,5 %, 1 000 frijoles, 30 días'), ['1.5', '1000', '30']);
    assert.deepEqual(numbersOf(`1${String.fromCharCode(160)}000 and 2${String.fromCharCode(8239)}500`), ['1000', '2500']);
    assert.deepEqual(numbersOf('١٢ كلمة، ٣٠ يومًا'), ['12', '30']);
    assert.deepEqual(numbersOf('१२ शब्द'), ['12']);
    assert.deepEqual(numbersOf('0.125 and 1.500'), ['0.125', '1500']);
    assert.deepEqual(numbersOf('E2E, v2, H264, {n1} and 5G'), ['5'], 'digits against a letter before them are names; placeholders are not numbers');
    assert.deepEqual(numbersOf('3 5 days'), ['3', '5'], 'two numbers, not one');
    assert.deepEqual(numbersOf(''), []);
});

test('the Arabic decimal and thousands marks are separators: a correct Persian decimal passes (PR #2829 review, numbers)', async () => {
    const { numbersOf } = await loadCoreChecks(ROOT);
    assert.deepEqual(numbersOf('۱٫۵٪ و ۱٬۰۰۰'), ['1.5', '1000'], 'U+066B is the decimal mark and U+066C the thousands mark');
    assert.deepEqual(numbersOf('برای مثال ۱۲٫۵۰'), ['12.50']);
    assert.deepEqual(numbersOf('٠٫١٢٥ و ١٬٥٠٠'), ['0.125', '1500'], 'Arabic-Indic digits too');
    // Through words:check as it runs: the English has 1.5, the Persian has it written with its own marks.
    assert.deepEqual((await judge('fa', '1.5% fee: You will receive {amount} B.', 'کارمزد ۱٫۵٪: شما {amount} B دریافت می‌کنید.')).rules, []);
    assert.deepEqual((await judge('fa', 'For example 12.50', 'برای مثال ۱۲٫۵۰')).rules, []);
    assert.deepEqual((await judge('fa', 'Up to 1,000 Beans', 'تا ۱٬۰۰۰ لوبیا')).rules, []);
    // The check still fails where a number is really gone, in the same script.
    assert.deepEqual((await judge('fa', 'A fee of 1.5% applies', 'کارمزد ۲٫۵٪ اعمال می‌شود')).rules, ['numbers: the English has 1.5 and the translation does not']);
});

test('a `name` term is not found where its capital only opens a sentence before a lower-case word, or where the text is all capitals (PR #2829 review, glossary)', async () => {
    // A correct translation of a label that starts with the verb, or with a plain plural, is not a problem.
    assert.deepEqual((await judge('es', 'Offer to help', 'Ofrecer ayuda')).rules, [], 'Offer is the verb here, not the post');
    assert.deepEqual((await judge('es', 'Needs review', 'Requiere revisión')).rules, []);
    assert.deepEqual((await judge('es', 'Needs you', 'Te necesita')).rules, []);
    assert.deepEqual((await judge('fr', 'Chat with {name}', 'Discuter avec {name}')).rules, []);
    assert.deepEqual((await judge('pt', 'Map your skills', 'Descreva suas habilidades')).rules, []);
    assert.deepEqual((await judge('fr', 'People who joined this week.', 'Les personnes arrivées cette semaine.')).rules, [], 'the plain plural');
    // After a full stop, a question mark, an emoji.
    assert.deepEqual((await judge('es', 'Recommended for deep accuracy. Maps your primary archetype.', 'Recomendado para más precisión. Describe tu arquetipo.')).rules, []);
    assert.deepEqual((await judge('es', '✋ Offer to Fulfill', '✋ Ofrecer cumplir')).rules, []);
    assert.deepEqual((await judge('ru', 'Let {n} in? People who tap Going later still wait.', 'Впустить {n}? Те, кто нажмёт «Иду» позже, всё равно ждут.')).rules, []);
    // A heading in capitals: its capitals say nothing about which word is a name.
    assert.deepEqual((await judge('es', 'WHAT DO YOU NEED?', '¿QUÉ NECESITAS?')).rules, []);
    assert.deepEqual((await judge('ru', '📌 NOTE FOR PEOPLE WHO ARE GOING', '📌 ЗАМЕТКА ДЛЯ ТЕХ, КТО ИДЁТ')).rules, []);

    // What still counts: a name that is the label itself, a name in the middle of a sentence, a Title Case label.
    const needs = (r) => r.map((x) => x.replace(/: .*"(\w+)" is .*/, ' $1'));
    assert.deepEqual(needs((await judge('es', 'Offer', 'Ayuda')).rules), ['glossary Offer'], 'a label of one word is the term');
    assert.deepEqual(needs((await judge('es', 'Offers', 'Ayudas')).rules), ['glossary Offer']);
    assert.deepEqual((await judge('es', 'Offers', 'Ofertas')).rules, []);
    assert.deepEqual(needs((await judge('es', 'Post an Offer', 'Publicar ayuda')).rules), ['glossary Offer'], 'in the middle of a sentence');
    assert.deepEqual(needs((await judge('es', 'Offer Details', 'Detalles de la ayuda')).rules), ['glossary Offer'], 'a label in Title Case');
    assert.deepEqual(needs((await judge('es', 'Settings → Chat memory', 'Ajustes → Memoria de conversación')).rules), ['glossary Chat'], 'after an arrow is a place, not a new sentence');
    // The verb opens the sentence, the post is named in the middle of it: only the post is held to the glossary.
    assert.deepEqual((await judge('es', 'Offer to Fulfill this Need?', '¿Ofrecer cumplir esta Necesidad?')).rules, []);
    assert.deepEqual(needs((await judge('es', 'Offer to Fulfill this Need?', '¿Ofrecer cumplir esta petición?')).rules), ['glossary Need']);
    // A word that is not flagged `name` is found in any case, at the start of a sentence too.
    assert.equal((await judge('es', 'Group chat rules', 'Reglas de la charla')).rules.length, 1);
    // A text that is a single word in capitals is still the label itself.
    assert.deepEqual(needs((await judge('es', 'OFFERS', 'AYUDAS')).rules), ['glossary Offer']);
});

test('a key with "group" whose es value lacks the glossary term fails', async () => {
    const english = 'Only the coordinator can rename this group';
    const bad = await judge('es', english, 'Solo el coordinador puede cambiar el nombre de este chat');
    assert.deepEqual(bad.structural, [], 'main\'s words:check passed this');
    assert.deepEqual(bad.rules, ['glossary: "group" is "Grupo" in es, and the translation has neither']);
    assert.deepEqual((await judge('es', english, 'Solo el coordinador puede cambiar el nombre de este grupo')).rules, []);
    assert.deepEqual((await judge('es', 'Your groups', 'Tus Grupos')).rules, [], 'a plural, any case');
    // A language the glossary has no column for is not checked (nothing is invented).
    assert.deepEqual((await judge('de', english, 'Nur der Koordinator kann diese Runde umbenennen')).rules, []);
    // A {placeholder} is not a word.
    assert.deepEqual((await judge('es', 'Add {group} to the list', 'Añade {group} a la lista')).rules, []);
    // Whole words only: "regroup" is not "group".
    assert.deepEqual((await judge('es', 'Please regroup first', 'Por favor reorganiza primero')).rules, []);
});

test('a name matches its capitalised or upper-case word, not the verb; an allowed variant, a stem and a lost accent count', async () => {
    const core = await loadCoreChecks(ROOT);
    const { terms } = await loadGlossary();
    const row = (name) => terms.find((t) => t.term === name);
    const offer = core.termPattern(row('Offer'));
    assert.ok(offer.test('Post an Offer') && offer.test('OFFER') && offer.test('Offers near you'));
    assert.ok(!offer.test('We offer help') && !offer.test('offer'), 'lower-case "offer" is the verb');
    // Only a row flagged `name` is case-bound: Beans and Keeper are the same thing in lower case ("Time and tools are beans").
    assert.ok(row('Offer').flags.includes('name') && row('BeanPool').flags.includes('name') && !row('Beans').flags.includes('name'));
    const beans = core.termPattern(row('Beans'));
    assert.ok(beans.test('Time and tools are beans') && beans.test('BEANS') && beans.test('Beans') && !beans.test('Bean'));
    assert.ok(core.termPattern(row('Keeper')).test('Lead keeper') && core.termPattern(row('Keeper')).test('Keepers eat last'));
    assert.ok(core.termPattern(row('BeanPool')).test('BEANPOOL') && !core.termPattern(row('BeanPool')).test('Open beanpool.org'));
    assert.ok(core.termPattern(row('Home')).test('Back to Home') && !core.termPattern(row('Home')).test('your home address'));
    const group = core.termPattern(row('group'));
    assert.ok(group.test('Group') && group.test('groups') && group.test('GROUP'));
    assert.ok(!group.test('regroup') && !group.test('grouping'));
    const community = core.termPattern(row('community'));
    assert.ok(community.test('Communities near you') && community.test("this community's admin"));
    // Allowed variants and stems (Russian endings), accents (Spanish drops one in the plural).
    assert.ok(core.hasRendering('Los miembros de esta comunidad', 'comunidad'));
    assert.ok(core.hasRendering('Los miembros de esta COMUNIDAD', 'comunidad'));
    assert.ok(core.hasRendering('Нет бобов', 'боб~') && core.hasRendering('Бобами', 'боб~') && !core.hasRendering('Забобы', 'боб~'), 'a stem starts a word');
    assert.ok(core.hasRendering('tus publicaciones', 'Publicación'));
    assert.ok(!core.hasRendering('no', 'nó') && core.hasRendering('um nó', 'nó'), 'a two-letter rendering must match as written');
    assert.ok(!core.hasRendering('x', '~'), 'an empty stem matches nothing');
    // A row lists the rendering first, then its allowed variants (the tab word is one for Commons).
    assert.deepEqual(row('Commons').renderings.es, ['Bienes comunes', 'Comunes']);
});

test('a plural entry is read form by form against the English form it stands for', async () => {
    const core = await loadCoreChecks(ROOT);
    const { terms } = await loadGlossary();
    const key = '{n} group|{n} groups';
    const ok = core.checkCatalogRules('es', { [key]: { one: '{n} grupo', other: '{n} grupos' } }, terms);
    assert.deepEqual(ok, []);
    const bad = core.checkCatalogRules('es', { [key]: { one: '{n} grupo', other: '{n} equipos' } }, terms);
    assert.deepEqual(bad.map((p) => [p.key, p.rule]), [[key, 'glossary']]);
    // The same failure in two forms is one problem; an empty or missing form is untranslated, not a problem.
    assert.equal(core.checkCatalogRules('es', { [key]: { one: '{n} equipo', other: '{n} equipos' } }, terms).length, 1);
    assert.deepEqual(core.checkCatalogRules('es', { [key]: { one: '', other: '' }, 'Group': '', _meta: { language: 'es' } }, terms), []);
    // A context key is checked against its English, not its context.
    assert.deepEqual(core.checkCatalogRules('es', { [`Save${core.CONTEXT_SEPARATOR}in a group`]: 'Guardar' }, terms), []);
});

test('a word we do not use is refused in every language, with the renderings the glossary lists; the check reads no meaning but the translation', async () => {
    assert.equal((await judge('fr', 'Neighbours help each other', 'Les voisins renforcent leur résilience')).rules.length, 1);
    assert.equal((await judge('es', 'Neighbours help each other', 'Los vecinos fortalecen la Resiliencia local')).rules.length, 1);
    assert.equal((await judge('ru', 'Neighbours help each other', 'Соседи укрепляют устойчивость района')).rules.length, 1);
    assert.equal((await judge('de', 'Neighbours help each other', 'Nachbarn und survival')).rules.length, 1, 'the English word itself, in a language with no column');
    assert.deepEqual((await judge('fr', 'Neighbours help each other', 'Les voisins s\'entraident')).rules, []);
    assert.match((await judge('fr', 'Neighbours help each other', 'résilience')).rules[0], /^glossary: ".*" is a word we do not use/);
});

test('today\'s catalogs pass against the recorded baseline: no problem that is not recorded', async () => {
    const { terms, problems: glossaryProblems } = await loadGlossary();
    assert.deepEqual(glossaryProblems, []);
    const { problems, violations, catalogCount } = await checkRepo({ extracted: extractRepo(ROOT), glossary: terms });
    assert.deepEqual(problems, []);
    assert.equal(catalogCount, 96);
    const baseline = readRatchet();
    assert.ok(baseline && baseline.known, `${GLOSSARY_BASELINE} is committed`);
    assert.deepEqual(ratchetCompare(violations, baseline).fresh.map(describe), []);
    // Every catalog the baseline names exists (a renamed folder would otherwise leave dead entries).
    for (const catalog of Object.keys(baseline.known)) assert.ok(fs.existsSync(path.join(ROOT, `${catalog}.json`)), `${catalog}.json exists`);
    // A glossary row that gains an allowed variant keeps its known problems known: the id is the cause, not the wording.
    const widened = terms.map((t) => (t.term === 'community' ? { ...t, renderings: { ...t.renderings, es: [...t.renderings.es, 'vecindad'] } } : t));
    const again = await checkRepo({ extracted: extractRepo(ROOT), glossary: widened });
    assert.deepEqual(ratchetCompare(again.violations, baseline).fresh.map(describe), []);
});

const violation = (catalog, rule, key) => ({ catalog, file: `${catalog}.json`, key, rule, what: 'term', problem: 'p' });

test('the baseline records the problems, not a count: a fixed one cannot hide a new one; a rise needs a reason; a fall needs nothing', () => {
    const a = violation('apps/native/es', 'glossary', 'A');
    const b = violation('apps/native/es', 'glossary', 'B');
    const c = violation('apps/native/es', 'glossary', 'C');
    const n = violation('apps/pwa/ru', 'numbers', 'N');
    const first = updatedRatchet(null, [b, a, n]).doc;
    assert.deepEqual(first.known, { 'apps/native/es': { glossary: [violationId(a), violationId(b)].sort() }, 'apps/pwa/ru': { numbers: [violationId(n)] } });
    assert.equal(first.raises, undefined, 'the first recording needs no reason');
    // b is fixed and c is new: the count is the same (3), the problem is not.
    const swapped = ratchetCompare([a, c, n], first);
    assert.deepEqual(swapped.fresh, [c]);
    assert.equal(swapped.fixed, 1);
    assert.deepEqual(ratchetCompare([a, b, n], first), { fresh: [], fixed: 0 });
    // Not recorded without a reason; recorded with one.
    assert.deepEqual(updatedRatchet(first, [a, b, c, n]).error, [c]);
    assert.deepEqual(updatedRatchet(first, [a, b, c, n], { raise: '   ' }).error, [c]);
    const raised = updatedRatchet(first, [a, b, c, n], { raise: 'new glossary row: shop', date: '2026-11-04' }).doc;
    assert.deepEqual(raised.raises, [{ date: '2026-11-04', reason: 'new glossary row: shop', added: 1 }]);
    // A fall is recorded as it is, and the history stays.
    const fell = updatedRatchet(raised, [a]).doc;
    assert.deepEqual(fell.known, { 'apps/native/es': { glossary: [violationId(a)] } });
    assert.deepEqual(fell.raises, raised.raises);
    assert.deepEqual(updatedRatchet(fell, []).doc.known, {});
    // The id names the cause, not the words that describe it: a glossary row that gains a variant keeps its known problems known.
    assert.equal(violationId(a), violationId({ ...a, problem: 'the same cause, said another way' }));
    assert.notEqual(violationId(a), violationId({ ...a, what: 'another term' }));
    assert.notEqual(violationId(a), violationId({ ...a, rule: 'numbers' }));
    // Edited by hand to make a new problem pass: caught against main's file, unless a new raise says how many.
    const handEdited = { ...first, known: { ...first.known, 'apps/native/es': { glossary: [...first.known['apps/native/es'].glossary, violationId(c)].sort() } } };
    assert.equal(unexplainedAdditions(first, handEdited).length, 1);
    assert.deepEqual(unexplainedAdditions(first, raised), []);
    assert.deepEqual(unexplainedAdditions(first, fell), [], 'a fall is never a problem');
    assert.deepEqual(unexplainedAdditions(first, { ...handEdited, raises: [{ date: 'x', reason: '', added: 1 }] }).length, 1, 'a raise needs a reason');
    assert.deepEqual(unexplainedAdditions(null, handEdited), [], 'main has no baseline yet');
});

test('the committed glossary baseline records nothing main\'s does not, unless a --raise says why (when main has the file; in CI too)', (t) => {
    const base = baselineBase();
    assert.ok(!base.broken, base.why);
    if (!base.ref) {
        // Nothing to compare with (not a git checkout, or a merge with no origin/main): say so, as the lint test does.
        console.log(`⚪ SKIP: the glossary baseline not compared: ${base.why}`);
        t.skip(base.why);
        return;
    }
    const main = baselineAt(base.ref, ROOT, GLOSSARY_BASELINE);
    // The change that adds the file has nothing in main to compare it with: every entry is new, which is what a first recording is.
    // That is not a skipped check (test-all records no green for a skip); from the next change on, main has the file.
    if (!main) {
        assert.ok(readRatchet()?.known, `main (${base.ref.slice(0, 8)}) has no ${GLOSSARY_BASELINE}, so this change must add it`);
        return;
    }
    assert.deepEqual(unexplainedAdditions(main, readRatchet()), []);
});

test('baselineAt reads a baseline file at a commit, and null where the commit has none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'words-baseline-at-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=words', '-c', 'user.email=words@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
        git('init', '-q');
        fs.mkdirSync(path.join(dir, 'scripts/words'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'scripts/words/other.txt'), 'x');
        git('add', 'scripts/words/other.txt');
        git('commit', '-q', '-m', 'before');
        const before = git('rev-parse', 'HEAD');
        const doc = { known: { 'apps/native/es': { glossary: ['0123456789'] } } };
        fs.writeFileSync(path.join(dir, GLOSSARY_BASELINE), JSON.stringify(doc));
        git('add', GLOSSARY_BASELINE);
        git('commit', '-q', '-m', 'after');
        assert.equal(baselineAt(before, dir, GLOSSARY_BASELINE), null);
        assert.deepEqual(baselineAt(git('rev-parse', 'HEAD'), dir, GLOSSARY_BASELINE), doc);
        assert.equal(baselineAt(git('rev-parse', 'HEAD'), dir), null, 'the lint baseline is a different file');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── GLOSSARY.csv ────────────────────────────────────────────────────────────────────────────────────────────────

const DESIGN_TERMS = [
    'BeanPool', 'Beans', 'community', 'global community', 'member', 'admin', 'owner', 'node', 'Keeper', 'Commons', 'Decision', 'Pulse', 'Offer', 'Need',
    'listing', 'deal', 'held in trust', 'credit line', 'circulation fee', '12 words', 'recovery kit', 'key vault', 'sign-in', 'recovery code', 'invite',
    'vouch', 'enterprise', 'steward', 'standby', 'level', 'tier',
    // The design's "+" rows, one term each.
    'Home', 'Market', 'Map', 'Chat', 'Ledger', 'People', 'Settings', 'group', 'channel', 'shop', 'event', 'assistant', 'claim code', 'CONFIRM', 'WIPE', 'DELETE',
    'resilience', 'survival',
];

test('GLOSSARY.csv reads clean and holds the design\'s 30 terms, with the flags and columns the checks use', async () => {
    const { terms, problems } = await loadGlossary();
    assert.deepEqual(problems, []);
    assert.deepEqual(terms.map((t) => t.term), DESIGN_TERMS);
    const flags = (name) => terms.find((t) => t.term === name).flags;
    for (const name of ['BeanPool', 'CONFIRM', 'WIPE', 'DELETE']) assert.ok(flags(name).includes('untranslatable'), name);
    for (const name of ['resilience', 'survival']) assert.ok(flags(name).includes('forbidden'), name);
    assert.ok(terms.every((t) => t.meaning.length > 0));
    // The two words ruled out are in no meaning (only the forbidden rows' own term and renderings).
    const raw = fs.readFileSync(path.join(ROOT, 'scripts/words/GLOSSARY.csv'), 'utf8');
    for (const row of parseCsv(raw).slice(1)) assert.doesNotMatch(row[1], /resilien|surviv/i, row[0]);
    // The columns are catalog languages.
    const langs = await catalogLangs();
    for (const t of terms) for (const lang of Object.keys(t.renderings)) assert.ok(langs.includes(lang), `${t.term}: ${lang}`);
    assert.deepEqual(Object.keys(terms.find((t) => t.term === 'group').renderings).sort(), ['es', 'fr', 'pt', 'ru']);
});

test('GLOSSARY.csv invents nothing: every rendering is in a catalog of its language', async () => {
    const { terms } = await loadGlossary();
    const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const text = {};
    for (const lang of ['es', 'pt', 'fr', 'ru']) {
        const parts = [];
        for (const folder of ['apps/native/words', 'apps/pwa/words', 'packages/beanpool-core/words', 'apps/server/words']) {
            const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, folder, `${lang}.json`), 'utf8'));
            for (const [key, value] of Object.entries(catalog)) {
                if (key === '_meta') continue;
                parts.push(...(typeof value === 'string' ? [value] : Object.values(value ?? {}).filter((v) => typeof v === 'string')));
            }
        }
        text[lang] = fold(parts.join('\n'));
    }
    for (const t of terms) {
        for (const [lang, forms] of Object.entries(t.renderings)) {
            for (const form of forms) {
                assert.ok(text[lang].includes(fold(form.replace(/~$/, ''))), `"${form}" (${t.term}, ${lang}) is in no ${lang} catalog: the glossary does not invent a rendering`);
            }
        }
    }
});

test('the CSV reader: quotes, commas, line breaks, and what it refuses', () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n"two\nlines",z'), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
    assert.equal(csvField('plain'), 'plain');
    assert.equal(csvField('a, "b"'), '"a, ""b"""');
    const langs = ['es', 'pt', 'fr', 'ru'];
    const { terms, problems } = parseGlossary('term,meaning,flags,es,fr\nOffer,"a post, offering help",terminology,Oferta | oferta,Offre\ngroup,a chat,,,\n', langs);
    assert.deepEqual(problems, []);
    assert.deepEqual(terms[0], { term: 'Offer', meaning: 'a post, offering help', flags: ['terminology'], renderings: { es: ['Oferta', 'oferta'], fr: ['Offre'] } });
    assert.deepEqual(terms[1].renderings, {}, 'an empty cell is no rendering');
    const bad = (csv) => parseGlossary(csv, langs).problems.join('\n');
    assert.match(bad('term,meaning,flags\nA,x,loud'), /flag "loud" is not one of/);
    assert.match(bad('term,meaning,flags\nA,x,\nA,y,'), /"A" is already a row/);
    assert.match(bad('term,meaning,flags\nA,,'), /"A" has no meaning/);
    assert.match(bad('term,meaning,flags\nA,builds resilience,'), /meaning of "A" uses a word we do not use/);
    assert.match(bad('term,meaning,flags\nA,about survival,'), /uses a word we do not use/);
    assert.match(bad('term,meaning,flags,xx\nA,x,'), /column "xx" is not one of/);
    assert.match(bad('term,meaning,flags,es,es\nA,x,,a,b'), /column "es" appears twice/);
    assert.match(bad('term,meaning,flags\nA,x,forbidden;untranslatable'), /both forbidden and untranslatable/);
    assert.match(bad('word,meaning,flags\nA,x,'), /column 1 must be "term"/);
    assert.match(bad('term,meaning,flags\nA,x,,extra'), /4 fields, the header has 3/);
    assert.match(bad('term,meaning,flags\n,x,'), /no term/);
    assert.match(bad(''), /empty/);
});

// ── briefs ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('words:draft --briefs embeds the glossary with the language\'s renderings, and says what is not decided yet', async () => {
    const { terms } = await loadGlossary();
    const ru = glossaryForBrief(terms, 'ru');
    assert.match(ru, /^\| Term \| Meaning \| Flags \| In ru \|$/m);
    assert.match(ru, /^\| Beans \| .+ \| terminology \| Бобы \(also fine: боб…\) \|$/m);
    assert.match(ru, /^\| BeanPool \| .+ \| untranslatable, name \| keep exactly as written \|$/m);
    assert.match(ru, /^\| resilience \| .+ \| forbidden \| never use: устойчивост…, стойкост… \|$/m);
    assert.match(ru, /^\| admin \| .+ \| _no rendering yet: pick one plain word and use it every time_ \|$/m);
    assert.match(glossaryForBrief(terms, 'de'), /^\| group \| .+ \| _no rendering yet/m, 'a language with no column gets the meanings and the rules');
    assert.match(glossaryForBrief(terms, 'de'), /^\| survival \| .+ \| forbidden \| never use \|$/m);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'words-glossary-brief-'));
    try {
        const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };
        write('packages/beanpool-guide/content/manifest.json', JSON.stringify({ sections: [{ id: 'about', title: 'About', summary: 'Sum', pages: ['faq', 'intro'] }] }));
        write('packages/beanpool-guide/content/about/faq.md', '---\nslug: faq\ntitle: FAQ\nsummary: Questions\nrelated: intro\n---\n\n## Questions\n\nAnswers.\n');
        write('packages/beanpool-guide/content/about/intro.md', '---\nslug: intro\ntitle: Intro\nsummary: Overview\nrelated: faq\n---\n\n## Intro\n\nText.\n');
        write('packages/beanpool-guide/content/es/manifest.json', JSON.stringify({ sections: {}, pages: {} }));
        for (const folder of ['packages/beanpool-core', 'apps/native', 'apps/pwa']) write(`${folder}/words/es.json`, JSON.stringify({ _meta: {} }));
        write('scripts/words/STYLE.md', '# Style Rules\n- Warm and plain\n');
        const extracted = [{ name: 'core', words: 'packages/beanpool-core/words', calls: [{ fn: 't', text: 'Offer a hand', concatenated: false, at: 'x.ts:1' }], found: [], problems: [] }];
        const briefs = path.join(tmp, 'briefs');
        // No GLOSSARY.csv in the tree: no glossary section, and nothing else changes.
        await writeBriefs({ root: tmp, dir: briefs, langs: ['es'], extracted });
        const without = fs.readFileSync(path.join(briefs, 'brief-es.md'), 'utf8');
        assert.doesNotMatch(without, /## Glossary/);
        write('scripts/words/GLOSSARY.csv', 'term,meaning,flags,es\nOffer,"a post, offering help",terminology,Oferta\nBeanPool,the mark,untranslatable,BeanPool\n');
        await writeBriefs({ root: tmp, dir: briefs, langs: ['es'], extracted });
        const withGlossary = fs.readFileSync(path.join(briefs, 'brief-es.md'), 'utf8');
        assert.match(withGlossary, /## Glossary \(scripts\/words\/GLOSSARY\.csv\)/);
        // A drafter is told a capitalised verb is not the term, so it does not force "Oferta de ayuda" into "Offer to help" (PR #2829 review).
        assert.match(withGlossary, /"Offer to help"[\s\S]*NOT the term/);
        assert.match(withGlossary, /^\| Offer \| a post, offering help \| terminology \| Oferta \|$/m);
        assert.match(withGlossary, /^\| BeanPool \| the mark \| untranslatable \| keep exactly as written \|$/m);
        // After the style rules, before the items to draft; the same text on a second run.
        assert.ok(withGlossary.indexOf('# Style Rules') < withGlossary.indexOf('## Glossary') && withGlossary.indexOf('## Glossary') < withGlossary.indexOf('## Exact Items to Draft'));
        await writeBriefs({ root: tmp, dir: briefs, langs: ['es'], extracted });
        assert.equal(fs.readFileSync(path.join(briefs, 'brief-es.md'), 'utf8'), withGlossary);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
