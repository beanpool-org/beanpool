# Root Cause Investigation: Native Map Filter Row Position

## 1. Summary of the Bug

On the native Map tab (`apps/native/app/(tabs)/map.tsx`), the filter row containing `"All | Offers | Needs | 🏷️ Category"` was observed floating in the vertical middle of the screen (approx. 40% down the screen) rather than sitting neatly at the top of the map just beneath the top tab bar.

---

## 2. Container Hierarchy and Layout Analysis

### Container Structure (`apps/native/app/(tabs)/_layout.tsx`)
In `_layout.tsx`:
1. **Root View**: `<View style={{ flex: 1 }}>` (line 192).
2. **Header Spacer**:
   ```tsx
   // _layout.tsx:207-209
   <View style={isMapScreen ? { height: measuredHeaderHeight } : undefined}>
       <GlobalHeader onMeasure={onHeaderMeasure} />
   </View>
   ```
   `GlobalHeader.tsx` calculates `headerHeight = Math.max(insets.top + 10, 40) + 56` (approx. 96–113dp depending on top inset/notch). On `/map`, `GlobalHeader` is styled with `headerAbsolute` (`position: 'absolute'`), but the parent `<View>` in `_layout.tsx` is in regular flow and reserves `height: measuredHeaderHeight`.
3. **Top Tab Bar Navigator**:
   ```tsx
   // _layout.tsx:210-222
   <Tabs backBehavior="none" screenOptions={{
       tabBarPosition: 'top',
       headerShown: false,
       tabBarStyle: {
           backgroundColor: colors.surface.app,
           borderTopWidth: 0,
           elevation: 0,
           height: TAB_BAR_HEIGHT, // 58dp
           paddingTop: 0,
       },
   ```
   The `<Tabs>` component sits in regular flow below the header spacer. Its top tab bar renders at the top of `<Tabs>` with `height: 58`.
4. **Map Screen Container (`styles.container`)**:
   The active tab screen component (`apps/native/app/(tabs)/map.tsx`) is rendered in the tab view container below the top tab bar:
   - The top edge of `styles.container` (`y = 0`) is positioned **directly at the bottom edge of the top tab bar**.
   - In screen coordinates from the device top edge:
     `Y_map_top = measuredHeaderHeight (approx. 113dp) + TAB_BAR_HEIGHT (58dp) = approx. 171dp`.

---

## 3. The Root Cause in `apps/native/app/(tabs)/map.tsx`

Two compounded mechanisms caused the filter row to float roughly 40% down the screen:

### Mechanism A: Legacy Hardcoded Offset (`paddingTop: 100`)
- **File & Line**: `apps/native/app/(tabs)/map.tsx:223`
  ```tsx
  filterBarWrapper: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', zIndex: 90, paddingTop: 100 },
  ```
- **Why it was there**: In the original architecture (commit `f6ddb31`), the tab bar was at the bottom of the phone screen, and `(tabs)/map.tsx` was configured with `headerTransparent: true`. The map container started at `y = 0` (top of device window, behind the translucent `GlobalHeader`). The `GlobalHeader` was approx. 96–100dp high. Therefore, `paddingTop: 100` was hardcoded to push the filter bar below that header.
- **What happened when top tabs were added**: In commit `642d382`, the tab bar moved to the top and `styles.container` was placed below the header and tab bar (`y ≈ 171dp`). The hardcoded `paddingTop: 100` was never updated, pushing the filter bar an extra 100dp below the tab bar.

### Mechanism B: Double Safe-Area Inset via `<SafeAreaView>`
- **File & Line**: `apps/native/app/(tabs)/map.tsx:996`
  ```tsx
  <SafeAreaView style={styles.filterBarWrapper} pointerEvents="box-none">
  ```
- **Why it occurred**: `react-native-safe-area-context`'s `SafeAreaView` defaults to all edges (`['top', 'left', 'bottom', 'right']`) with `top: 'additive'`. Even though safe-area insets were already consumed at the top of the window by `GlobalHeader` and the header spacer in `_layout.tsx`, `<SafeAreaView>` inspected the device window insets and added `insets.top` (e.g., 47dp on iOS, 24–40dp on Android) as additional padding.
- **Precedent in commit `642d382`**: This is identical to the bug noted in `apps/native/app/(tabs)/pulse.tsx` during commit `642d382`:
  > *"Pulse applied the top safe-area inset twice — a leftover `edges={['top', ...]}` from when it was a standalone screen, now stacking on the header's inset and leaving a dead gap under the tab bar. No other tab screen does this."*
  Commit `642d382` resolved this in `pulse.tsx` by setting `edges={['left', 'right']}`, but `map.tsx` was overlooked and retained `<SafeAreaView>` with default edges and `paddingTop: 100`.

### The Arithmetic of the 40% Offset
On a modern device with an 844dp tall screen (e.g. iPhone 14 / modern Android):
- Screen coordinate of map container top: `~171dp` (Header spacer `113dp` + Top tab bar `58dp`)
- Safe area top inset added by `SafeAreaView`: `~47dp`
- Hardcoded legacy offset `paddingTop: 100`: `+100dp`
- **Total distance from top of screen**: `171 + 47 + 100 = 318dp`
- **Position on screen**: `318dp / 844dp ≈ 37.7% – 40%` (floating in the vertical middle).

---

## 4. Git History Analysis

- `git log --oneline -20 -- "apps/native/app/(tabs)/map.tsx"`:
  Shows recent commits:
  - `22083b3` Merge pull request #510 (`useLocalSearchParams` types)
  - `4f19813` Expo: add type parameter to `useLocalSearchParams`
  - `27a1fe4` Bolt: O(1) category lookups in Native MapScreen
  - `4b1a424` fix(categories): re-export normalizeCategory
  None of these touched `filterBarWrapper`. `filterBarWrapper` was untouched since initial commit `f6ddb31`.
- Commit `642d382` (`feat(native): top tab bar, Talk merge, Pulse as a tab, profile and header fixes (#645)` around 2026-09-06):
  Restructured `_layout.tsx` to introduce the top tab bar, top spacer for `GlobalHeader`, and merged tabs. `map.tsx` was not modified in that commit, leaving the legacy `paddingTop: 100` and `<SafeAreaView>` in place.

---

## 5. Audit of Other Overlays in `apps/native/app/(tabs)/map.tsx`

We audited all other floating overlays in `map.tsx` to determine if they suffer from similar offset problems:

1. **`pinDropBanner` (`apps/native/app/(tabs)/map.tsx:265`, `1149`)**:
   - Style: `pinDropBanner: { position: 'absolute', top: 60, left: 20, right: 20, ... }`
   - JSX: Wrapped in `<View style={styles.pinDropBanner}>` (does **not** use `SafeAreaView`, so no duplicate safe-area inset).
   - Finding: It has a hardcoded `top: 60`. In the old layout, `top: 60` was under the old header; now it renders 60dp below the tab bar during pin drop mode (`pinDropMode && showNewPost && postLat == null`). While not causing a 40% vertical middle float, 60dp is an arbitrary gap.
2. **`fabPill` (Zoom/Locate/Theme Left Pill) (`apps/native/app/(tabs)/map.tsx:238`, `1032`)**:
   - Style: `fabPill: { position: 'absolute', width: 48, ... }` with `{ bottom: 120, left: 16 }`
   - Finding: Anchored to bottom-left. **Unaffected** by top header/tab bar changes.
3. **`previewCardWrapper` (Selected Post Bottom Card) (`apps/native/app/(tabs)/map.tsx:245`, `1053`)**:
   - Style: `previewCardWrapper: { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 150, justifyContent: 'flex-end' }`
   - JSX: Uses `<SafeAreaView style={styles.previewCardWrapper} pointerEvents="box-none">`
   - Finding: Anchored to `bottom: 0`. It uses `SafeAreaView` intentionally to respect the bottom home indicator / navigation bar. **Unaffected** by top header/tab bar changes.
4. **`fab` (ADD POST Button) (`apps/native/app/(tabs)/map.tsx:262`, `1118`)**:
   - Style: `fab: { position: 'absolute', bottom: 32, right: 24, ... }`
   - JSX: Uses `<SafeAreaView style={StyleSheet.absoluteFill} pointerEvents="box-none">`
   - Finding: Anchored to bottom-right. **Unaffected** by top header/tab bar changes.
5. **`sheetWrapper` (Pin Drop Confirm/Cancel Footer) (`apps/native/app/(tabs)/map.tsx:269`, `1156`)**:
   - Style: `sheetWrapper: { position: 'absolute', bottom: 0, left: 0, right: 0, ... }`
   - Finding: Anchored to bottom. **Unaffected** by top header/tab bar changes.
6. **Map Legend**:
   - Finding: There is no legend component in `map.tsx`.
