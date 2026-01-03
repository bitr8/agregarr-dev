# Lessons Learned

## Security

### 2026-01-02: Error message sanitization approach
- **Issue:** Blacklist approach for sensitive patterns is too permissive
- **Solution:** Use whitelist approach - only show messages matching known-safe patterns
- **Pattern:** `SAFE_MESSAGE_PATTERNS` for allowed messages, `SENSITIVE_PATTERNS` for always-masked

### 2026-01-02: Streaming size enforcement
- **Issue:** `res.text()` buffers entire response before size check - ineffective for large payloads
- **Solution:** Use `ReadableStream` with running byte counter, abort immediately when limit exceeded

### 2026-01-02: Symlink escape in path validation
- **Issue:** `path.resolve()` doesn't follow symlinks - attacker can create symlink inside allowed root pointing outside
- **Solution:** Use `fs.realpath()` to resolve symlinks before containment check

## Code Review

### 2026-01-02: Multi-AI review catches different issues
- Claude found initial 6 critical issues
- Codex found 4 additional issues in the fixes
- **Takeaway:** Run multiple AI reviews for security-critical code

## API Design

### 2026-01-02: Always include optional fields for compatibility
- **Issue:** Conditionally omitting `message` field broke client expectations
- **Solution:** Always include `message` field even if same as `error`

## Plex Display Quirks

### 2026-01-02: Recently Added shows season vs show artwork inconsistently
- Plex "Recently Added" row may show season artwork instead of show artwork
- Agregarr only applies overlays to show-level posters, not seasons
- This can cause confusion when a show appears without overlay in Recently Added but has overlay on the show page
- Root cause: Plex chooses which artwork to display based on what was recently added (season vs show)

## GitHub Actions / CI

### 2026-01-02: Fork PRs require workflow approval
- PRs from forks to upstream repos trigger `action_required` status
- GitHub security feature - maintainer must approve workflow runs
- Pushing new commits triggers new workflow runs but they still need approval
- Empty commits (`git commit --allow-empty`) work to retrigger CI

### 2026-01-02: CI failures may be stale
- If CI fails but local passes, check if the branch was pushed after fixes
- Use `gh run list --repo <repo>` to see workflow run timestamps
- Compare with local commit timestamps to verify CI ran on latest code

### 2026-01-03: Always run validator before pushing
- `~/.claude/skills/pre-commit-validator/validate.sh` catches privacy and type issues
- Don't rely on `pnpm typecheck` alone - CI may have stricter settings
- Rule added to CLAUDE.md but must actually follow it

## Data Sources

### 2026-01-03: TMDB vs Sonarr data disconnect
- **Issue:** Coming Soon collection used Sonarr data, but overlay context used TMDB
- **Result:** Shows appeared in collection but had no countdown overlay
- **Root cause:** TMDB `next_episode_to_air` often missing for non-US shows
- **Solution:** Implement fallback chain: TMDB → Sonarr → TMDB seasons

### 2026-01-03: Timezone handling for air dates
- **Issue:** Date-only strings (`YYYY-MM-DD`) parsed as UTC midnight may be wrong day locally
- **Example:** `2026-01-08T15:30:00Z` = Jan 9 2:30am AEDT (different calendar day!)
- **Solution:** Parse full datetime before converting to local timezone, then extract calendar date
- **Enhancement:** If TMDB returns date-only, get precise time from Sonarr

## TypeScript

### 2026-01-03: Generic types need explicit parameters
- `Record` requires two type arguments: `Record<string, string>`
- `Set` requires one type argument: `Set<string>`
- Local `pnpm typecheck` may pass but Docker CI fails with stricter settings
- Use `npx tsc --project server/tsconfig.json --noEmit` for consistent checking

## Error Handling

### 2026-01-03: Transient API failures can corrupt state
- **Issue:** IMDb API timeout (504) caused overlay system to proceed with missing data
- **Result:** Poster regenerated without IMDb rating → no rating overlays matched → poster stripped
- **Root cause:** Error caught and logged, but processing continued with incomplete context
- **Solution:** Return `criticalApiFailed` flag from context builder, skip item if true
- **Principle:** When external API fails, preserve existing state rather than apply incomplete update

## CI / Build

### 2026-01-03: Docker Build Cloud has monthly minute limits
- **Issue:** CI builds failed with "prepaid build minutes limit of 200 reached"
- **Solution:** Switch from `driver: cloud` to standard GitHub-hosted buildx
- **Change:** Remove `version`, `driver`, `endpoint` from `docker/setup-buildx-action`
- **Trade-off:** GitHub runners are slower but have no minute limits for public repos
