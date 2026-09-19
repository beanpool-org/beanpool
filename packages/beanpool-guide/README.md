# BeanPool Guide & Operator Manual

> Guides and documentation for BeanPool members and node operators. Compiles markdown sources into structured JSON bundles for mobile/manager apps and static HTML for the website.

---

## 1. Structure

* **`content/`**: The members' guide. Compiled into `apps/native/assets/guide.json` and static website pages under `apps/website/guide/`.
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

## 3. Build & Verification

```bash
# Build guide bundles and copy static assets
node scripts/build.mjs

# Verify generated outputs and images match sources
node scripts/build.mjs --check

# Run test suite
pnpm test
```

### 3.1 Website Isolation
Per protocol policy, the operator manual is not published on the public website (`PUBLISH_OPERATORS_WEBSITE = false`). The website output directory `apps/website/guide/` contains zero operator pages or operator image assets.
