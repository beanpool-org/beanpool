# BeanPool Words Tooling & Translation Drafting

This directory contains the tools for managing translations and the words layer across BeanPool (DESIGN-translation-fable.md §5 and §7 row S8).

---

## 1. Overview of Commands

- `pnpm words:check`: Validates that every `t()` and `tn()` call is structurally valid against English sources and catalogs. Checks placeholder parity, plural forms, and ensures no stray catalog files.
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
   - App words per catalog (`packages/beanpool-core/words`, `apps/native/words`, `apps/pwa/words`, `apps/server/words`): missing, stale (0), and orphaned.
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
- Option `--max-keys N` to cap the number of app word keys in large top-up rounds.

### 2.3 Safety / Money Pattern List

The director meaning-checks translations touching sensitive security or financial topics after each round. The reviewed pattern list matches:
- **recovery**: account and key recovery.
- **12 words**: the 12-word recovery phrase / key.
- **sign-in**: sign-in and authentication flows.
- **delete/remove**: account deletion, leaving communities, removing members.
- **Beans amounts**: currency balances, circulation fees, and transfer amounts.
- **limits**: partner limits, rate limits, and credit lines.
- **privacy**: profile visibility, admin access, "who can see".

---

## 3. How the Director Runs a Round from These Briefs

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
