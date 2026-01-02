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
