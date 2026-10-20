# BeanPool Translation Style Rules & Glossary

These style rules apply to all BeanPool translation drafting rounds (app words in `packages/beanpool-core`, `apps/native`, `apps/pwa`, guide titles/summaries in `packages/beanpool-guide/content/<lang>/manifest.json`, and full guide pages in `packages/beanpool-guide/content/<lang>/<section>/<slug>.md`).

---

## 1. General Voice and Tone

- **Warm, plain, short**: sentences a stranger understands on a small phone screen.
- **Do not invent or complicate**: stay direct and concise.
- **Gender-neutral**: write sentences that do not require gender agreement (e.g. Russian "X теперь в группе", not "присоединился/лась"). Avoid "he/she" pronouns.
- **"BeanPool" is the mark**: NEVER translate "BeanPool".
- **"Beans" is the community currency**: translate the bean metaphor into your language (ru бобы, fr haricots, pt feijões, es frijoles, etc.). Always match the app's existing translation from `_meta.glossary` or catalog entries.

---

## 2. Regional Language Decisions

- **Spanish (`es`)**: Neutral Latin American.
- **Portuguese (`pt`)**: Brazil-leaning with neutral forms.
- **French (`fr`)**: International French.
- **Simplified Chinese (`zh-Hans`)**: Standard Simplified.
- **Traditional Chinese (`zh-Hant`)**: Taiwan usage.
- **Tagalog/Filipino (`fil`)**: Natural Filipino / Tagalog.

---

## 3. Recurring Glossary

Reuse existing translations character-for-character across all files:
- **Beans**: The unit of trade.
- **Offer**: A post offering help, goods, or skills.
- **Need**: A post asking for help or goods.
- **Commons**: The shared pool and community resources.
- **Decision**: A proposal or poll decided by the community.
- **Keeper**: A custodian/guardian of shared community roles.
- **Pulse**: The live community activity stream.
- **community**: A local or global group of members.
- **node**: A server hosting a community.
- **12 words**: The member's recovery phrase / key.
- **Home**: The main home screen / feed.

Before translating, check your language's existing catalog `_meta.glossary` in:
- `packages/beanpool-core/words/<lang>.json`
- `apps/native/words/<lang>.json`
- `apps/pwa/words/<lang>.json`

---

## 4. Technical and Syntax Rules

1. **Placeholders must match exactly**:
   - Every `{name}`, `{count}`, `{amount}`, `{n}`, `{due}`, etc. must appear character-for-character.
   - Never drop a placeholder. Never add a placeholder that is not in the English source.
   - Placeholders may be reordered if the target grammar requires it, but none may be omitted.

2. **Formatting & Symbols**:
   - Preserve all emoji and special characters: ★ ↻ › → · etc.
   - Keep markdown markers `**bold**` exactly as in English.
   - For guide titles/summaries: no markdown links, no HTML, no `{placeholders}` or braces.

3. **Plurals (`tn()` keys)**:
   - Plural keys have the form `one|other` in English.
   - Translate into the exact plural categories required by your language (e.g. ru needs `one`, `few`, `many`, `other`; es/fr/pt need `one`, `other`). Check other plural entries in the same catalog file.

4. **Numbers, Limits & Amounts**:
   - Numbers, days, limits, and rules must stay EXACT (e.g. "30 days", "500 Beans", "2 must act together").
   - Levels and tiers are merit badges: they NEVER lock or unlock features. Never translate a level sentence as if it gates or restricts an action.

5. **Security & Safety Sentences**:
   - Sentences about keys, 12 words, recovery, sign-in, backups, admin visibility, re-key, and deleting account MUST be translated in FULL.
   - Never shorten, summarise, or omit a clause, condition, or warning (e.g. "never", "only", "irreversible").

6. **Literal Typed Words**:
   - Words that the member must type literally into an input stay in English (e.g. **CONFIRM**). The application validates the exact English word.

7. **Layout & Direction**:
   - "Left" and "right" stay as English: the app layout is left-to-right (LTR) everywhere across all languages (including Arabic, Persian, and Urdu).

8. **Recovery Phrase (12 Words)**:
   - The 12 recovery words STAY English words. Never translate example words or word lists. State in your language that the words are English words.

9. **App Component and Button References**:
   - A sentence quoting a button, tab, row, or screen name (e.g. "tap Show my 12 words", "Settings → Recovery", "Market", "Talk", "Pulse") must use THAT exact button or row translation from the app's catalogs. Search all three catalogs (`packages/beanpool-core/words/<lang>.json`, `apps/native/words/<lang>.json`, `apps/pwa/words/<lang>.json`). If no translation exists yet, retain the English name.

10. **Narrow Screen Constraints**:
    - Mobile buttons, tabs, chips, and pills at 320 dp and 1.3× text scale must not exceed ~1.35× the English character width.
    - Avoid single compound words longer than ~14 letters (e.g. in German split compounds: "Code zur Schlüsseländerung", not "Schlüsseländerungscode").

11. **Catalog File Format**:
    - Standard 2-space indented JSON.
    - UTF-8 encoding.
    - Do not escape non-ASCII Unicode characters (write `á`, `ñ`, `д`, `中` directly, not `\uXXXX`).
