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
