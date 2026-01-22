# Agregarr (Personal Fork)

Personal fork of [Agregarr](https://github.com/agregarr/agregarr) for testing changes before submitting upstream. Automatically builds to `bitr8/agregarr:develop` on Docker Hub.

## Docker Image

```yaml
services:
  agregarr:
    image: bitr8/agregarr:develop
    container_name: agregarr
    volumes:
      - /path/to/config:/app/config
      - /path/to/placeholder/movies:/data/movies # Optional: Coming Soon
      - /path/to/placeholder/tv:/data/tv # Optional: Coming Soon
    environment:
      - TZ=Australia/Sydney
    ports:
      - 7171:7171
    restart: unless-stopped
```

Full setup docs at [agregarr.org](https://agregarr.org/docs/installation).

## Fork-Only Features

Features not yet submitted upstream:

### Real-time Overlay Job Progress

Live status on the dashboard showing progress, item counts, ETA, and a stop button for each library.

![Overlay Jobs Status](public/images/overlay-jobs-status.png)

### Performance Optimizations

- **Batch IMDb Prefetch**: Fetches all IMDb ratings upfront in batches of 20 via TMDB lookup, then queries IMDb in bulk. Reduces thousands of individual API calls to tens.
- **Adaptive TTL Caching**: Cache duration based on content age. New releases: 12 hours. Older content: up to 30 days.
- **Stale Cache Fallback**: Returns cached ratings when external APIs fail instead of breaking the overlay job.

### Settings

- **Configurable Rating Cache**: Settings UI option to adjust maximum IMDb/RT cache duration (7-90 days).

### Direct Plex Deletion for Placeholder Cleanup

Improves placeholder cleanup reliability when Plex's built-in trash mechanism fails.

**Problem:** Plex ignores empty directories during library scans (protection against accidental removal). When a placeholder file is deleted and its directory becomes empty, `scanLibrary()` + `emptyTrash()` won't remove the stale database entry.

**Solution:** Directly delete stale Plex items via API instead of relying on scan/trash:

1. Tracks which placeholder file paths were deleted during cleanup
2. Queries Plex once per library for items referencing those exact paths
3. Deletes stale items directly via `DELETE /library/metadata/{ratingKey}`
4. Falls back to scan+emptyTrash only for libraries where direct deletion couldn't find matches

**Safeguards:**
- Only tracks paths of successfully deleted placeholder files
- Exact path matching only (no partial/fuzzy matching)
- Deduplicates rating keys to prevent double-deletion
- Only files matching placeholder patterns are ever considered

### Sonarr Folder Naming for TV Placeholders

TV placeholders now use Sonarr's folder naming convention when the show exists in Sonarr.

**Problem:** Agregarr created TV placeholders at `/tv/Show (2024)/` but Sonarr uses `/tv/Show (2024) [imdbid-tt1234567]/`. When real content arrived, Plex saw them as different shows, leaving orphaned placeholder entries.

**Solution:** Extract the folder name from Sonarr's series path and use it for placeholder creation. Falls back to standard naming if the show isn't in Sonarr.

## Upstream PRs

### Open

| PR                                                    | Description                                           | Depends On |
| ----------------------------------------------------- | ----------------------------------------------------- | ---------- |
| [#404](https://github.com/agregarr/agregarr/pull/404) | Check \*arr download status for placeholder lifecycle | -          |

### Pending Submission

| Commit    | Description                                      | Blocked By |
| --------- | ------------------------------------------------ | ---------- |
| `15a8496` | Direct Plex API deletion for stale placeholders  | -          |
| `db5e56d` | Use Sonarr folder naming for TV placeholders     | #404       |

> **Note:** The Sonarr folder naming fix extends `batchCheckDownloadStatus()` from #404. It adds `folderName` to the `showsByTvdbId` map. Cannot submit until #404 merges. The direct Plex deletion fix can be submitted independently.

> **Legacy Placeholder Cleanup:** TV placeholders created before the Sonarr folder naming fix use simplified folder names (e.g., `Show Name (2024)`) that may not match Sonarr's naming (e.g., `Show Name (2024) [imdbid-tt1234567]`). When real content arrives, this mismatch can cause orphaned placeholder files. To fix: delete the placeholder folder and let the next sync recreate it with the correct naming.

### Merged

| PR                                                    | Description                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| [#405](https://github.com/agregarr/agregarr/pull/405) | Fix Letterboxd title extraction from data-item-name                  |
| [#400](https://github.com/agregarr/agregarr/pull/400) | Empty Plex trash after placeholder cleanup                           |
| [#387](https://github.com/agregarr/agregarr/pull/387) | Skip date filtering for non-Coming-Soon with includeAllReleasedItems |
| [#349](https://github.com/agregarr/agregarr/pull/349) | Don't double-estimate digital release dates                          |
| [#358](https://github.com/agregarr/agregarr/pull/358) | IMDb Top 250 English Movies collection type                          |
| [#356](https://github.com/agregarr/agregarr/pull/356) | Handle 404 gracefully when deleting hub items                        |
| [#350](https://github.com/agregarr/agregarr/pull/350) | Validate SVG icon dimensions and file type                           |
| [#348](https://github.com/agregarr/agregarr/pull/348) | Fix scheduler startNow immediate sync and deadlock bugs              |
| [#345](https://github.com/agregarr/agregarr/pull/345) | Multi-source label regex for collection matching                     |
| [#340](https://github.com/agregarr/agregarr/pull/340) | Handle Jellyfin trickplay directories during cleanup                 |
| [#332](https://github.com/agregarr/agregarr/pull/332) | Trigger Plex scan after placeholder cleanup                          |
| [#321](https://github.com/agregarr/agregarr/pull/321) | Surface per-collection sync errors to UI                             |
| [#306](https://github.com/agregarr/agregarr/pull/306) | Uniform scaling for non-standard poster aspect ratios                |
| [#305](https://github.com/agregarr/agregarr/pull/305) | Downgrade library mismatch message to debug level                    |
| [#304](https://github.com/agregarr/agregarr/pull/304) | Sync networksCountry to sources array on change                      |
| [#303](https://github.com/agregarr/agregarr/pull/303) | Fetch Maintainerr collections in overlay test route                  |
| [#302](https://github.com/agregarr/agregarr/pull/302) | Return episodeNumber from fetchReleaseDateInfo                       |
| [#300](https://github.com/agregarr/agregarr/pull/300) | Harden API clients and file operations                               |
| [#282](https://github.com/agregarr/agregarr/pull/282) | Sanitize error responses                                             |
| [#278](https://github.com/agregarr/agregarr/pull/278) | Filter daily shows from Coming Soon collections                      |
| [#277](https://github.com/agregarr/agregarr/pull/277) | TMDB poster caching and race condition fixes                         |

## License

GPL-3.0, same as upstream.

## Credits

All the real work is by the [Agregarr](https://github.com/agregarr/agregarr) team.
