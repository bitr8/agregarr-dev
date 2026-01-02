# Lessons Learned

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
