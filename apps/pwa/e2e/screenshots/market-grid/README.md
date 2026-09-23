# Market grid — pictures for review

Card View at every column count, light and dark, from the branch that stopped the grid stretching listing tiles
to the height of the tallest thing in their row (`fix/market-grid-heights`).

- `after/` — this branch, at 1440px (5 columns), 1200px (4), 800px (3), 640px (2) and 320px (1, at normal and at
  1.3x text), light and dark.
- `after/poll-last-column-*` — the same widths from `md` up with the poll moved to the last column of the first
  row, where the two columns it takes will not fit. The grid is `grid-flow-row-dense`, so instead of the poll
  moving down and leaving that cell blank, a tile from after it fills the cell and the poll takes the next row.
  (At 1200px the feed already lands the poll there, so that picture is the same as `4col-1200-light.png`.)
- `before/` — the same feed on `origin/main` at 1440px and 800px, for contrast: the dead space between a tile's
  description and its VIEW button, and the truncated poll answers.

## Regenerating them

```
pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium   # once
pnpm --filter @beanpool/pwa screenshots:market-grid <out-dir>
```

`e2e/market-grid-shots.mjs` builds `e2e/harness.html` — the real MarketplacePage on its own — answers every /api
request from `e2e/fixtures.mjs`, and prints what each picture is meant to show, measured from the live layout:
tile heights, the gap between a description and its VIEW button, whether the VIEW buttons in a row line up, the
poll's column span, whether any poll answer is truncated, and whether any row of the grid has an empty cell in
it. It exits non-zero if any of that is wrong. Nothing in it talks to a node.

## The pictures are not in git

Like every other harness in the repo, this one writes pictures you regenerate, not files you commit: `*.png` under
`e2e/screenshots/` is git-ignored. The set shown to Marty for #1092 was taken at 33d249a3 and kept with the
review, outside the repo. The script is the thing worth keeping.
