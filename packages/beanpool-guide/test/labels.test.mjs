import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guideBodyHash, parseGuideMarkdown } from '../src/guide.mjs';
import {
    checkGuideLabels, checkTranslatedPage, labelIndex, bareLabel, againstBaseline, readBaseline, LABEL_EXCEPTIONS, pairBolds,
} from '../src/labels.mjs';

// The translated guide pages name the app's buttons in the app's words (src/labels.mjs; #3247 review round 1: Manage,
// Chat groups and Invite 2 people left in English, and « Entreprises » for the page « Projets et entreprises »).

const page = body => `---\nslug: one\ntitle: One\nsummary: A page.\nrelated: two\n---\n\n${body}\n`;
const check = (lang, english, translated, catalogs, titles) => checkTranslatedPage({
    file: `${lang}/talk/one.md`, english: page(english), translated: page(translated), index: labelIndex(lang, catalogs), titles,
});
const messages = r => r.findings.map(f => f.message);

test('every translated page at today\'s English names the app\'s labels and pages in its language (the baseline only shrinks)', () => {
    const { findings, checked } = checkGuideLabels();
    assert.ok(checked > 0);
    const { fresh, gone } = againstBaseline(findings, readBaseline());
    assert.deepEqual(fresh.map(f => f.message), [], 'fix each line to the catalog value (src/labels.mjs says how)');
    assert.deepEqual(gone, [], 'fixed: take these out of src/labels-baseline.json (node packages/beanpool-guide/src/labels.mjs --shrink)');
});

test('the pages this round redrafted, Groups and Event chat, are clean in every language, with no baseline', () => {
    const { findings } = checkGuideLabels();
    assert.deepEqual(findings.filter(f => /\/talk\/(groups|event-chat)\.md$/.test(f.file)).map(f => f.message), []);
    assert.equal(readBaseline().filter(k => /\/talk\/(groups|event-chat)\.md:/.test(k)).length, 0);
});

test('a label left in English, or worded unlike the app, fails; the catalog\'s word passes', () => {
    const catalogs = [{ key: 'Manage ›', value: '管理 ›' }, { key: 'Groups', value: 'グループ' }];
    const english = 'Open **Groups** and tap **Manage**.';
    assert.deepEqual(messages(check('ja', english, '**グループ**を開き、**管理**をタップします。', catalogs)), []);
    assert.deepEqual(messages(check('ja', english, '**グループ**を開き、**Manage**をタップします。', catalogs)),
        ['ja/talk/one.md:8: **Manage** is **管理** in the app; the line bolds **グループ**, **Manage**']);
    assert.equal(check('ja', english, '**グループ**を開き、**管理する**をタップします。', catalogs).findings.length, 1);
    // A bold whose English is no catalog sentence is the page's own emphasis: not checked.
    assert.deepEqual(messages(check('ja', '**Nobody can remove the lead.**', '**誰も外せません。**', catalogs)), []);
});

test('what the app draws around a label (an emoji, an arrow) is not part of it; capitals aside', () => {
    const catalogs = [{ key: '👥 Chat groups', value: '👥 チャットグループ' }, { key: 'observer', value: 'Observateur' }];
    assert.deepEqual(messages(check('ja', 'The chips **Chat groups**.', 'チップ **チャットグループ**。', catalogs)), []);
    assert.deepEqual(messages(check('ja', 'The chips **👥 Chat groups**.', 'チップ **チャットグループ**。', catalogs)), []);
    assert.equal(check('ja', 'The chips **Chat groups**.', 'チップ **Chat groups**。', catalogs).findings.length, 1);
    assert.deepEqual(messages(check('fr', 'An **observer** reads.', 'Un **observateur** lit.', catalogs)), []);
    assert.equal(bareLabel('🏛️ Enterprises'), 'Enterprises');
    assert.equal(bareLabel('Start a project or an enterprise →'), 'Start a project or an enterprise');
});

test('a label with a count is the form the language uses for that number', () => {
    const key = 'Invite {n} person|Invite {n} people';
    const ml = [{ key, value: { one: '{n} ആളെ ക്ഷണിക്കുക', other: '{n} ആളുകളെ ക്ഷണിക്കുക' } }];
    const english = 'Tap the button (for example **Invite 2 people**).';
    assert.deepEqual(messages(check('ml', english, 'ബട്ടൺ (ഉദാഹരണത്തിന് **2 ആളുകളെ ക്ഷണിക്കുക**).', ml)), []);
    assert.deepEqual(messages(check('ml', english, 'ബട്ടൺ (ഉദാഹരണത്തിന് **Invite 2 people**).', ml)),
        ['ml/talk/one.md:8: **Invite 2 people** is **2 ആളുകളെ ക്ഷണിക്കുക** in the app; the line bolds **Invite 2 people**']);
    // Russian: 2 takes `few`, 5 takes `many`.
    const ru = [{ key, value: { one: 'Пригласить {n} человека', few: 'Пригласить {n} человек', many: 'Пригласить {n} человек', other: 'Пригласить {n} человека' } }];
    assert.deepEqual(labelIndex('ru', ru).expected('Invite 2 people'), ['Пригласить 2 человек']);
    assert.deepEqual(labelIndex('ru', ru).expected('Invite 21 person'), ['Пригласить 21 человека']);
    // A placeholder stands for digits only: "{a} and {b}" is not "Owner and admin limit".
    const es = [{ key: '{a} and {b}', value: '{a} y {b}' }, { key: 'Community {name}', value: 'Comunidad {name}' }];
    assert.equal(labelIndex('es', es).expected('Owner and admin limit'), null);
    assert.equal(labelIndex('es', es).expected('Community admin'), null);
});

test('one English word in several contexts: any of the app\'s words for it passes', () => {
    const catalogs = [{ key: 'Open\u0004join policy', value: '自由参加' }, { key: 'Open\u0004a vote', value: '進行中' }];
    assert.deepEqual(labelIndex('ja', catalogs).expected('Open').sort(), ['自由参加', '進行中'].sort());
    assert.deepEqual(messages(check('ja', 'Choose **Open**.', '**自由参加**を選びます。', catalogs)), []);
    assert.equal(check('ja', 'Choose **Open**.', '**オープン**を選びます。', catalogs).findings.length, 1);
});

test('two labels the language says with one word: each English bold needs a bold of its own (one for one)', () => {
    // vi says Remove and Delete both "Xóa" (fa: حذف). Before, a line bolding "Xóa" once passed both, and a wrong
    // second bold hid behind it.
    const catalogs = [{ key: 'Remove', value: 'Xóa' }, { key: 'Delete', value: 'Xóa' }, { key: 'Groups', value: 'Nhóm' }];
    const english = 'Tap **Remove**, then **Delete**.';
    assert.deepEqual(messages(check('vi', english, 'Nhấn **Xóa**, rồi **Xóa**.', catalogs)), []);
    assert.deepEqual(messages(check('vi', english, 'Nhấn **Xóa**, rồi **Gỡ bỏ**.', catalogs)),
        ['vi/talk/one.md:8: **Delete** is **Xóa** in the app; the line bolds **Xóa**, **Gỡ bỏ**']);
    assert.deepEqual(messages(check('vi', english, 'Nhấn **Xóa**, rồi xóa hẳn.', catalogs)),
        ['vi/talk/one.md:8: **Delete** is **Xóa** in the app; the line bolds **Xóa**']);
    // The same label twice on a line is bolded twice.
    assert.equal(check('vi', 'Open **Groups**; **Groups** lists them.', 'Mở **Nhóm**; danh sách ở đó.', catalogs).findings.length, 1);
    // In order, but a translation may say two labels the other way round: each still has its own bold.
    assert.deepEqual(messages(check('vi', 'Under **Groups**, tap **Remove**.', 'Nhấn **Xóa** trong **Nhóm**.', catalogs)), []);
});

test('pairBolds: each English bold its own translated bold, the earliest free one, moving an earlier one when it must', () => {
    const w = (...xs) => new Set(xs);
    assert.deepEqual(pairBolds([w('xóa'), w('xóa')], ['xóa', 'xóa']), [0, 1]);
    assert.deepEqual(pairBolds([w('xóa'), w('xóa')], ['xóa', 'gỡ']), [0, -1]);
    // The first could take either; the second only the first: the first moves.
    assert.deepEqual(pairBolds([w('a', 'b'), w('a')], ['a', 'b']), [1, 0]);
    assert.deepEqual(pairBolds([w('a')], []), [-1]);
    assert.deepEqual(pairBolds([], ['a']), []);
});

test('a page named on the English line is named by its title in the page\'s language', () => {
    const titles = new Map([['Projects and enterprises', ['Projets et entreprises']]]);
    const english = 'A project or an enterprise (see "Projects and enterprises").';
    assert.deepEqual(messages(check('fr', english, 'Un projet ou une entreprise (voir « Projets et entreprises »).', [], titles)), []);
    assert.deepEqual(messages(check('fr', english, 'Un projet ou une entreprise (voir « Entreprises »).', [], titles)),
        ['fr/talk/one.md:8: "Projects and enterprises" is the page "Projets et entreprises" in this language; the line does not name it']);
    // A quoted phrase that is no page's title (a heading inside a page, a notification's words) is not checked.
    assert.deepEqual(messages(check('fr', 'Under "A quiet lead convenor".', 'Sous « Un coordinateur discret ».', [], titles)), []);
});

test('lines pair by position; a page whose lines do not pair is not checked line by line', () => {
    const catalogs = [{ key: 'Groups', value: 'Groupes' }];
    const r = check('fr', 'Tap **Groups**.\n\nThen wait.', 'Touchez **Groups**.', catalogs);
    assert.equal(r.paired, false);
    assert.deepEqual(r.findings, []);
    // Paired: the second line's label is held to the second English line.
    const p = check('fr', 'Then wait.\n\nTap **Groups**.', 'Puis attendez.\n\nTouchez **Groups**.', catalogs);
    assert.deepEqual(p.findings.map(f => [f.line, f.english]), [[10, 'Groups']]);
});

test('a deliberate exception is a problem\'s key; the list starts empty', () => {
    assert.deepEqual([...LABEL_EXCEPTIONS], []);
    const catalogs = [{ key: 'Groups', value: 'Groupes' }];
    const r = checkTranslatedPage({ file: 'fr/talk/one.md', english: page('Tap **Groups**.'), translated: page('Touchez **Groups**.'),
        index: labelIndex('fr', catalogs), exceptions: ['fr/talk/one.md: **Groups**'] });
    assert.deepEqual(r.findings, []);
});

test('the baseline: a problem it does not hold fails, and one it holds that is gone must come out', () => {
    const f = key => ({ key, message: key });
    assert.deepEqual(againstBaseline([f('a'), f('a'), f('b')], ['a', 'a', 'b']), { fresh: [], gone: [] });
    assert.deepEqual(againstBaseline([f('a'), f('a'), f('c')], ['a', 'b']).fresh.map(x => x.key), ['a', 'c']);
    assert.deepEqual(againstBaseline([f('a')], ['a', 'b']).gone, ['b']);
});

test('only a page at today\'s English fails; a page behind it is listed for its drafting round', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-labels-'));
    try {
        const content = path.join(dir, 'packages/beanpool-guide/content');
        const english = page('Tap **Groups**.');
        fs.mkdirSync(path.join(content, 'talk'), { recursive: true });
        fs.writeFileSync(path.join(content, 'talk/one.md'), english);
        fs.mkdirSync(path.join(dir, 'apps/native/words'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'apps/native/words/fr.json'), JSON.stringify({ _meta: {}, Groups: 'Groupes' }));
        const hash = guideBodyHash(parseGuideMarkdown(english, 'one.md'));
        const translated = h => `---\nslug: one\ntitle: Un\nsummary: Une page.\nrelated: two\nsource-hash: ${h}\n---\n\nTouchez **Groups**.\n`;
        fs.mkdirSync(path.join(content, 'fr/talk'), { recursive: true });
        fs.writeFileSync(path.join(content, 'fr/talk/one.md'), translated(hash));
        const current = checkGuideLabels({ contentDir: content, root: dir, langs: ['fr'] });
        assert.deepEqual(current.findings.map(x => x.key), ['fr/talk/one.md: **Groups**']);
        assert.equal(current.checked, 1);
        fs.writeFileSync(path.join(content, 'fr/talk/one.md'), translated('0123456789abcdef'));
        const behind = checkGuideLabels({ contentDir: content, root: dir, langs: ['fr'] });
        assert.deepEqual(behind.findings, []);
        assert.deepEqual(behind.behind, ['fr/talk/one.md']);
        assert.deepEqual(behind.behindFindings.map(x => x.key), ['fr/talk/one.md: **Groups**']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
