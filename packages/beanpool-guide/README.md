# BeanPool Guide & Operator Manual

> Guides and documentation for BeanPool members and node operators. Compiles markdown sources into structured JSON bundles for mobile/manager apps and static HTML for the website.

---

## 1. Structure

* **`content/`**: The members' guide. Published as `packages/beanpool-guide/generated/guide.json` (bundled by the native app and the web app) and as static website pages under `apps/website/guide/` (whose `guide.json`, the same bytes, is the copy the apps fetch to update without an app release).
* **`operators/`**: The node operator manual. Compiled into `packages/beanpool-guide/generated/operators.json`, loaded directly by the node manager app (`apps/manager/src/components/manual/Manual.tsx`).
* **`operators/images/`**: Screenshots and diagrams referenced by the operator manual pages.

---

## 2. Operator Manual Screenshots

Manual screenshots illustrate each section and screen of node Settings.

### 2.1 Format & Storage
* All screenshots are stored as **WebP** (`.webp`) images in `packages/beanpool-guide/operators/images/`.
* Images are kept under an ~80 KB budget (typically 10–35 KB) and are taken at 390px mobile viewport width to verify readability at 320dp + 1.3× text scaling.
* During build (`node scripts/build.mjs`), images in `operators/images/` are synchronized directly to `apps/manager/public/images/`, where Vite serves them under `/settings/images/`.

### 2.2 Re-taking Screenshots
Screenshots can be regenerated at any time with a single command:

```bash
pnpm --filter @beanpool/guide screenshots
```

(or `pnpm --filter @beanpool/manager manual-shots`)

This script (`apps/manager/e2e/manual-shots.mjs`):
1. Boots the local manager app against the mock API harness (`apps/manager/e2e/harness.mjs`).
2. Navigates through all 5 Settings sections and key modals.
3. Renders each viewport into an HTML5 `<canvas>` inside Chromium to encode high-quality WebP images without requiring external binaries (`cwebp` or `sharp`).
4. Writes the resulting files into `packages/beanpool-guide/operators/images/`.

---

## 3. Versions and publishing

An app only replaces its copy of the guide (or Settings' copy of the manual) with a **higher** version. So every change to the text has to reach `main` under a new, higher version, and never the same version with different text. Since 2026-09-30 (Marty's decision) that version is set on `main`, after merge, and never in a pull request:

* **A pull request changes only the pages** (`content/`, `operators/`, including a section's `"pages"` line in `manifest.json`). It never edits a version (the manifests hold none) and never commits `generated/` or `apps/website/guide/`. Two PRs that change guide text therefore touch only their own pages, and never conflict on a version or a generated file.
* **The director publishes after merging**, with one command from the repo root:

  ```bash
  pnpm guide:publish --merge
  ```

  It takes `origin/main` into a temporary worktree (never the checkout it is run from), writes the published copies with each collection one version higher where its text changed, opens a pull request of only those files, merges it (squash, admin) and shows that the merge landed. With nothing to publish it says so and exits 0, so it is safe to run after every merge. Without `--merge` it stops once the PR is open; `--dry-run` pushes nothing.
* **Until the publish**, `main` still carries the last published copy: the old text under the old version, which is what every build from `main` ships (the apps, Settings and the website all read the published copy). A build can therefore never carry new text under an old version; it can only be behind. Publish before a release: `pnpm --filter @beanpool/guide pending` exits 1 while text waits.
* **Tests pin what a page says on the pages**, not on the published copy (the bundled `guide.json` / `operators.json`): the PR that changes the words then changes the pin with them, instead of the pin breaking at the publish. The same goes for a "?" in Settings that names a page: it is checked against `operators/`; the page's "?" appears once the page is published.

Why this design, and not a version counted from git history: the website is served as committed static files (Cloudflare Pages, no build step), and both the Docker build in CI (`actions/checkout` at depth 1) and EAS local builds (`git clone --depth 1`) have no history to count. Each build path reads the committed published copy, so the version has to be committed on `main`. The `main` ruleset only lets an admin merge, so the publish is the director's command, not a bot.

## 4. Build & Verification

```bash
# What an author runs after editing pages: checks them, copies the manual's pictures to the manager, and
# re-renders the website pages from the published copies (for a change to the renderer). Writes no version.
pnpm --filter @beanpool/guide generate

# Write nothing; fail on a page that does not build, a generated file that is not exactly what the published
# copies produce, or (compared with the commit this change starts from) changed text under an old version, the
# same text under a new version, a skipped version, a published copy that is not the pages' text, or a change
# that edits pages AND publishes them. Run by `pnpm test`, so CI enforces it.
node scripts/build.mjs --check

# Does anything wait to be published? (exit 1 if so)
pnpm --filter @beanpool/guide pending

# Run test suite (test/guide.test.mjs, and test/versions.test.mjs, which acts out PRs, merges and publishes
# in throwaway git repositories)
pnpm test
```

If the check says a change "edits the pages AND publishes them", restore main's published copy with the `git checkout <commit> -- packages/beanpool-guide/generated apps/website/guide` it prints, then run `generate`.

### 4.1 Website Isolation
Per protocol policy, the operator manual is not published on the public website (`PUBLISH_OPERATORS_WEBSITE = false`). The website output directory `apps/website/guide/` contains zero operator pages or operator image assets.
