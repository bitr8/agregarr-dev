# Lessons Learned

Project-specific learnings and gotchas for Agregarr development.

## Error Handling Patterns

### 2026-01-06: Sync errors must be propagated, not just logged
When a collection sync fails, returning `{ created: 0, updated: 0 }` without error info causes the caller to treat it as success. The `SyncResult` type already has an optional `error` field - use it. Errors must flow through the entire chain: orchestrator -> sync service -> settings -> API -> UI.

### 2026-01-06: markCollectionSynced should only be called on actual success
If a sync returns an error in its result, don't call `markCollectionSynced()`. Instead, persist the error with `setCollectionSyncError()` and keep `needsSync: true` so retries are possible.

## Code Review Patterns

### 2026-01-06: Variable scope in try/catch blocks
When adding error handling code, check that variables (like `result`) are in scope. In TypeScript, variables declared inside an `if`/`else` block aren't accessible outside. Move error checks inside the block where the variable is defined.

## SVG Processing

### 2026-01-06: Silent failures in SVG icon embedding
When embedding SVG icons in poster generation, several scenarios cause silent failures:
- Zero or NaN dimensions from malformed viewBox cause `scale = Infinity`
- Non-SVG files uploaded as icons return null without visible warning
- Empty `iconPath` on custom icon elements silently renders nothing

**Fix:** Added dimension validation with warn-level logging before scale calculation.

## Collection Features

### 2026-01-06: Collection exclusion works for placeholders
The mutual exclusion feature (`excludeFromCollections`) works for placeholder items. Placeholders have Plex rating keys like regular items, so `applyCollectionExclusions()` filters them correctly. Users configure exclusion on the TARGET collection (where they don't want items), selecting the SOURCE collection (containing placeholders) to exclude from.

## Prefetch/Caching Patterns

### 2026-01-09: Always initialize cache Maps before code that can throw
In `prefetchImdbRatings`, if an exception occurs before `this.preloadedImdbRatings = new Map()` is executed, the Map stays `undefined` and `buildRenderContext` silently falls back to individual API calls for every item (23x slower).

**Fix:** Initialize the Map at the very start of the function, before any code that could throw. Then wrap the rest in try/catch. Even if prefetch fails, items will see an empty Map (not undefined) and fallback behavior is logged.

### 2026-01-09: Add visibility to silent fallback paths
When a fast path (batch prefetch) fails and falls back to a slow path (individual API calls), log a warning. Without this, jobs run 23x slower with no indication why. The warning should include diagnostic info like `preloadedMapExists` and `preloadedMapSize` to help debug.

## UI Progress Display

### 2026-01-10: Guard against off-by-one in progress counters
When showing "Item X of Y" progress, be careful with `processedCount + 1`. If the backend increments `processedCount` after processing but before setting `running = false`, there's a brief window where `processedCount === totalCount` but `running` is still true. Showing `processedCount + 1` would display "N+1 of N".

**Fix:** Add guard: `showProgress = running && processedCount < totalCount`
