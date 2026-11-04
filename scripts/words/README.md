# BeanPool Words Tooling & Translation Drafting

This directory contains the tools for managing translations and the words layer across BeanPool (DESIGN-translation-fable.md §5 and §7 row S8).

---

## 1. Overview of Commands

- `pnpm words:check`: Validates that every `t()` and `tn()` call is structurally valid against English sources and catalogs. Checks placeholder parity, plural forms, and ensures no stray catalog files. It also holds each translation to `GLOSSARY.csv`, to the numbers in the English, and to the words that never change (see section 3), against a recorded baseline of known problems. `words:check --known` lists them; `words:check --update` records a fall.
- `pnpm words:lint`: Checks the ratchet on English literals outside `t()` per directory against `lint-baseline.json`: JSX text, text props and alert arguments (`counts`), and English sentence constants that reach a screen (`constants`, see "On-screen constants" below). `words:lint --update` records falls; rises require `--raise "<reason>"`.
- `pnpm words:extract`: Extracts English calls and writes `<catalog>/en.sources.json` mapping keys to `file:line` locations.
- `pnpm words:count`: Reports counts of user-facing strings and word totals per package.
- `pnpm words:draft --report`: Heartbeat report listing missing, stale, and orphaned counts across app words, guide titles, guide pages, and website pages per language. Exit 0, or 2 with `words:draft: SCAN ERROR — …` on stderr and no summary line when a scan fails.
- `pnpm words:draft --briefs <dir>`: Generates self-contained drafting briefs for AGY Flash runs.

---

## 1b. On-screen constants (the second rule of `words:lint`)

The first rule sees English written where a screen draws it (JSX text, a text prop, an alert's literal arguments). It cannot see English written once and shown elsewhere: `export const KIT_TITLE = '…'` in one file, `dialogTitle: KIT_TITLE` in another. The second rule follows such a constant to the screen. It is a heuristic, written down so nobody has to guess what turns it red.

**A sentence constant counts when all of these hold:**

1. It is declared at module level (exported or not) in a package the ratchet covers (`lint: true` in `words.mjs`: the phone, the web app, core), as a string, or as a string inside an object or array literal (`Object.freeze(…)`, `as const` and `satisfies` are looked through). A function, a call or a variable is not read.
2. The text is an English sentence written in words: it starts with a capital letter, has a space, a lowercase letter, and either a lowercase word after the first or closing punctuation (`Save as PDF`, `Keep this file off cloud backups.`). A name is not a sentence: `Tiếng Việt` and `Bahasa Indonesia` (the language list's own names, never translated), `Ho Chi Minh`. A URL, a key (`beanpool-language`) and a SQL line never start like one.
3. Its value reaches a screen, in the file that declares it or in any scanned file that imports it by name (an alias is followed). An import is followed by its relative path; for a package name (`@beanpool/core`) by the name, when exactly one scanned file declares a constant of that name (an ambiguous name is not guessed). The value reaches a screen when it is, after being followed through `COPY.title`, `COPY['title']`, `(…)`, `as`, `!`, `a || b`, `a ?? b`, `c && a`, `c ? a : b`, `a + b` and a template literal:
   - a JSX child: `<Text>{LINE}</Text>`;
   - the value of a text prop (`title`, `placeholder`, `label`, `subtitle`, `hint`, `message`, `description`, `heading`, `accessibilityLabel`, `accessibilityHint`, `aria-label`, `alt`);
   - one of the first two arguments of an alert call (`Alert.alert`, `alert`, `window.alert`, `confirm`, `Alert.prompt`), including an `alert` the caller passes in;
   - the `title`, `message`, `body`, `text`, `subtitle`, `label` or `dialogTitle` of an object given to a share sheet or a push call (`share`, `shareAsync`, `scheduleNotificationAsync`, `presentNotificationAsync`, `sendPush…`, `sendNotification…`, `pushNotification…`; one level of nested object is looked through, as in `content: { body }`).
   Reading `COPY.title` counts only the sentences under `title`; a computed read (`COPY[key]`) counts every sentence under `COPY`.

**What never counts:** a log call (`console.*`, `logger.*`); a name that a parameter, a local variable, a catch or a loop variable shadows; a constant no screen shows; any file under `__tests__`, `*.test.ts(x)`, `test-*.ts`, `e2e` (they are not scanned); and **a sentence that is already a words key**, a `t('…')` or `word('…')` anywhere in the scanned packages with the same text. Such a constant is the English key of a table (`components/welcome/welcome-lines.ts`: `'Save as PDF': word('Save as PDF')`) and the screen translates it where it shows it (`welcomeLineWords(…)`), so counting it would be a false red.

**What it does not see (so a screen can still show English outside the index):** a constant stored in state or a variable and shown later, one handed to a helper that renders it (`setError(LINE)`, `showToast(LINE)`), one thrown in an `Error` and read as `e.message`, one put into an HTML string (the printable recovery kit page), and a sentence made by a function. The rule counts what it can follow; it is not a proof that nothing else is shown.

**The ratchet:** the counts are per directory of the file that declares the constant, in `lint-baseline.json` under `constants`, beside `counts`. `words:lint` fails when a directory's count is higher than recorded. `words:lint --update` lowers the recorded numbers; a rise needs `--update --raise "<reason>"` (recorded in `raises` with `"section": "constants"`), and `words.test.mjs` compares with `origin/main` as it does for `counts`. The first time the `constants` section was recorded (words-wire-2, 4 Nov 2026) nothing was recorded before, so `--update` wrote it without a raise.

**To fix a red:** make the constant `word('…')` where it is declared and `t()` it where it is shown (`wordn` and `tn` for a count), or add its English to a table keyed by the English as `welcome-lines.ts` does.

---

## 2. Drafting Tool: `words:draft`

### 2.1 Heartbeat Reporting

```bash
pnpm words:draft --report [--langs <l1,l2>]
```

Exits with code `0`, or `2` when a scan fails (stderr `words:draft: SCAN ERROR — <what failed>`, and no `words:draft: … missing` line, so a heartbeat never reads a failed scan as a clean tree). Outputs:
1. Website pages status (or `website pages: skipped (S6 not yet implemented)` until slice S6 exists).
2. Per-language breakdown:
   - App words per catalog (`packages/beanpool-core/words`, `apps/native/words`, `apps/pwa/words`, `apps/server/words`): missing, stale (0), and orphaned. What counts as missing follows the tests (2.4): `native: 690 missing (6 all-at-once), …`.
   - Guide titles & summaries (`packages/beanpool-guide/content/<lang>/manifest.json`): missing and stale.
   - Guide pages (`packages/beanpool-guide/content/<lang>/<section>/<slug>.md`): missing (no file) and stale (source-hash behind).
   - SAFETY/MONEY count: missing and stale items requiring meaning-check.
3. Summary line parsed by the director's hourly heartbeat:
   ```
   words:draft: N missing, M stale across L languages
   ```

### 2.2 Brief Generation

```bash
pnpm words:draft --briefs <dir> [--langs <l1,l2>] [--max-keys N]
```

Writes deterministic, self-contained Markdown briefs (`<dir>/brief-<lang>.md`) for each language with work.
Each brief contains:
- Embedded shared style rules and glossary from `scripts/words/STYLE.md`.
- Exact missing and stale keys / pages with today's English and source hashes.
- Source file and line context for app words.
- Exact commit and push sequence per catalog and page.
- Option `--max-keys N` to cap the number of app word keys in large top-up rounds. It never cuts a sentence of an all-or-none group (2.4).

A language with nothing left to ask for gets no brief, and the run says which all-at-once sentences it left out.

### 2.3 Safety / Money Pattern List

The director meaning-checks translations touching sensitive security or financial topics after each round. The reviewed pattern list matches:
- **recovery**: account and key recovery.
- **12 words**: the 12-word recovery phrase / key.
- **sign-in**: sign-in and authentication flows.
- **delete/remove**: account deletion, leaving communities, removing members.
- **Beans amounts**: currency balances, circulation fees, and transfer amounts.
- **limits**: partner limits, rate limits, and credit lines.
- **privacy**: profile visibility, admin access, "who can see".

### 2.4 What counts as missing: the tests decide

`--report` and `--briefs` list a key as missing only if drafting it cannot turn a test red (4 Nov, #2841 and #2842: a round gave the phone and web catalogs a bare `Your deals`, and six welcome sentences in four languages only, and broke 21 checks). Two rules:

1. **A sentence core's own sources use is core's.** The phone and the web app load `[their catalog, core's]` for a language, core's last, so a copy of a core sentence in an app catalog would never show; `your-deals-words.test.ts` forbids it for `Your deals`. In `draft.mjs`, `APP_CATALOG_DEFS` marks these packages `throughCore` (`native`, `pwa`; not the server, whose refusals use its own catalog alone). A key such a package uses that core's sources also use is missing in core only. It is still a used key there, so an older copy is not orphaned.
2. **An all-or-none group is drafted whole.** `all-or-none.mjs` lists them; today the welcome screens' sentences (`app/welcome.tsx` and `components/WelcomeDoors.tsx`), which `language-switch-render.test.ts` needs in every phone catalog or in none. That test reads its sentences from the same file, so the two cannot differ. For a group sentence:
   - **no catalog has it** (*all-at-once*): a brief asks for it only when the run covers every language (no `--langs`); a shorter run marks it as "draft in all languages at once" and leaves it out. `--report` counts it as missing and says `(N all-at-once)`.
   - **some catalog has it** (*complete the set*): every other catalog is missing it, tagged `[COMPLETE THE SET]`, even when core also has it.

   A group sentence is never cut by `--max-keys`. The director merges a round that drafted such a group for all languages together.

To add a group, add it to `ALL_OR_NONE_GROUPS` in `all-or-none.mjs` and have its test read its sentences from there; `draft.test.mjs` checks that the welcome test does.

---

## 3. The glossary, numbers and untranslatable checks (slice T0)

`GLOSSARY.csv` is the one list of the words that must be rendered the same way every time (columns: `term, meaning, flags`, then one column per language that has renderings: `es, pt, fr, ru` today; more columns are added as languages are settled). Edit it in a sheet or by hand; `words:check` reads it, `words:draft --briefs` puts it in every drafting brief, and Weblate can import it later (slice T3). The checks are core's (`packages/beanpool-core/src/words-check.ts`, `checkCatalogRules`) and read pairs of (English, translation), so moving the catalogs to PO changes only the reader.

| Check | A translation fails when |
| --- | --- |
| glossary | its English has a glossary term (whole word, with a plural; any case unless the row is flagged `name`, which is found only as a capitalised name: not where the capital only opens a sentence or label before a lower-case word, like the verb in "Offer to help" or "Needs you" or the plural in "People who joined", and not in a heading in capitals) and the translation has neither the language's rendering nor one of the row's allowed variants; or it has a `forbidden` word, in any language |
| numbers | a number in the English is not in the translation. Digits of any script count and decimal or thousands separators of any country ("1.5%" = "1,5 %", "1,000" = "1 000", "۱٫۵٪" and "۱٬۰۰۰" with the Arabic marks U+066B and U+066C); a number written out in words ("treinta días") does not; digits against a letter before them ("E2E", "v2") are names, not numbers |
| untranslatable | its English has "BeanPool" (or a typed word like `Type CONFIRM`) and the translation does not carry it as written |

**A cell** is the rendering, then ` | ` and its allowed variants (`Bienes comunes | Comunes`). A trailing `~` is a stem for languages whose endings change (`боб~` matches бобы, бобов, бобами). Matching ignores case, and accents once a rendering has four letters or more. An empty cell means no rendering is settled: nothing is checked and nothing is invented. A rendering is in the CSV only if it is in a catalog of that language (a test refuses a made-up one). A variant is another form of the same word (plural, singular, adjective) or a label the catalogs already use (a tab word); a different word for the same thing is drift, and stays a known problem until the sentence is fixed.

**The baseline** (`glossary-baseline.json`) records the problems that are in the catalogs today (they are machine drafts), as a short hash of rule + key + cause per catalog, so fixing one sentence cannot hide a new mistake in another. `words:check` fails on a problem that is not recorded; it never counts a fall against you. To record a fall: `words:check --update`. A rise is refused; the one exception is a new glossary row, which turns up new problems: `words:check --update --raise "<reason>"` (kept in the file; `words.test.mjs` compares with origin/main, as it does for the lint baseline). To fix a failure, change the translation (the message names the term and the language's rendering), not the baseline.

Known false positives stay in the baseline until a person moves the sentence: a name inside another name ("Google Maps" is not the Map), a verb the language uses for the noun ("you are a member" as "you belong"), and "Commons Pool", which the catalogs' own label renders with "Bienes comunes" but some sentences with "Fondo común".

**When the translation is right and the check is wrong.** A `name` term is told from the verb by its capital, so a capitalised verb or plain plural that opens a sentence or label before a lower-case word is not the term ("Offer to help" → "Ofrecer ayuda", "Needs review", "Chat with {name}", "People who joined"), and neither is a word in a heading in capitals ("WHAT DO YOU NEED?"). The cost is that a noun used this way ("Chat menu") is not checked either. Some shapes are still caught ("Offer →", "Needs {pct}%", "Google Maps"): do not bend the translation to the glossary word ("Oferta de ayuda" for "Offer to help" is the drift this check exists to stop). Record it as a false positive instead: `words:check --update --raise "false positive: <term> as a verb"`. The reason is kept in the file's `raises`, so it shows in the diff for a director to read.

## 4. How the Director Runs a Round from These Briefs

The hourly heartbeat checks `pnpm words:draft --report`. When anything is missing or stale, the director initiates a drafting round following the `scratch/words-topup/run-*.sh` pattern.

### Step 1: Generate Briefs
From the repository root:
```bash
pnpm words:draft --briefs scratch/words-topup/briefs
```

### Step 2: Run AGY Flash across Languages
A runner script (modeled on `scratch/words-topup/run-1020.sh` and `run-guide-pages-2.sh`) orchestrates parallel AGY Flash agents in isolated worktrees:

```bash
#!/bin/bash
set -u
R=/Users/marty/projects/beanpool
BASE=$(git rev-parse HEAD)
LANGS=$(pnpm words:draft --report | grep -E '^[a-z]{2,3}(-[A-Za-z]+)?:' | tr -d ':')
BRIEFS_DIR=$R/scratch/words-topup/briefs

run_one() {
  l=$1
  W=$R/.claude/worktrees/agy-words-$l
  B=words/draft-$(date +%m%d)-$l
  [ -d $W ] || git -C $R worktree add -q -b $B $W $BASE || return 1
  brief=$BRIEFS_DIR/brief-$l.md
  [ -f $brief ] || return 0

  echo "[$(date +%H:%M)] $l starting"
  ( cd $W && caffeinate -i /Users/marty/.local/bin/agy -p="$(cat $brief)" \
      --model gemini-3.8-flash-high --print-timeout 60m --output-format stream-json )
  echo "[$(date +%H:%M)] $l finished (exit $?)"
}
export -f run_one; export R BASE BRIEFS_DIR
echo "$LANGS" | xargs -P 8 -I{} bash -c 'run_one {}'
```

### Step 3: Agent Execution & Safeguards
Each AGY Flash agent:
- Operates strictly inside its assigned worktree.
- Translates missing keys according to `STYLE.md`.
- Verifies structural integrity:
  - App words: `node scripts/words/words.mjs check`
  - Guide: `node packages/beanpool-guide/scripts/build.mjs --check`
- Commits and pushes per catalog and page.
- Exits cleanly without creating pull requests.

### Step 4: Verification and Merge
1. The director re-runs `pnpm words:draft --report` to confirm missing and stale counts drop to `0`.
2. The director inspects the Safety/Money keys identified by `--report`.
3. The director merges the round branches into `main` and publishes guide versions if guide pages were updated (`pnpm guide:publish --merge`).
4. **The sign-in return pages** (`apps/website/auth/*.html`, `apps/pwa/public/auth/facebook.html`) carry core's translations of their five sentences (`packages/beanpool-core/src/auth-bounce-words.ts`; keys in core's catalogs like any other). They are generated: after a round that fills any of those keys, run `node scripts/website-build.mjs` and commit the pages, or `node scripts/website-build.mjs --check` (and the `website_links` check) fails with "out of sync".
