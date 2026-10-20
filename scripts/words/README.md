# BeanPool Words Tooling & Translation Drafting

This directory contains the tools for managing translations and the words layer across BeanPool (DESIGN-translation-fable.md §5 and §7 row S8).

---

## 1. Overview of Commands

- `pnpm words:check`: Validates that every `t()` and `tn()` call is structurally valid against English sources and catalogs. Checks placeholder parity, plural forms, and ensures no stray catalog files.
- `pnpm words:lint`: Checks the ratchet on English literals outside `t()` per directory against `lint-baseline.json`. `words:lint --update` records falls; rises require `--raise "<reason>"`.
- `pnpm words:extract`: Extracts English calls and writes `<catalog>/en.sources.json` mapping keys to `file:line` locations.
- `pnpm words:count`: Reports counts of user-facing strings and word totals per package.
- `pnpm words:draft --report`: Heartbeat report listing missing, stale, and orphaned counts across app words, guide titles, guide pages, and website pages per language. Exit 0 always.
- `pnpm words:draft --briefs <dir>`: Generates self-contained drafting briefs for AGY Flash runs.

---

## 2. Drafting Tool: `words:draft`

### 2.1 Heartbeat Reporting

```bash
pnpm words:draft --report [--langs <l1,l2>]
```

Always exits with code `0`. Outputs:
1. Website pages status (or `website pages: skipped (S6 not yet implemented)` until slice S6 exists).
2. Per-language breakdown:
   - App words per catalog (`packages/beanpool-core/words`, `apps/native/words`, `apps/pwa/words`): missing, stale (0), and orphaned.
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
LANGS=$(pnpm words:draft --report | grep -E '^[a-z]{2}(-[A-Za-z]+)?:' | tr -d ':')
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
