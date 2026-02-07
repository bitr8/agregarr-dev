# Agregarr (Personal Fork)

Personal fork of [Agregarr](https://github.com/agregarr/agregarr) for testing changes before submitting upstream. Automatically builds to `bitr8/agregarr:develop` on Docker Hub.

## Docker Image

Available on Docker Hub as [`bitr8/agregarr`](https://hub.docker.com/r/bitr8/agregarr). Both `develop` and `latest` tags track the develop branch and include all fork-only features plus open upstream PRs. The image rebuilds automatically on every push to develop.

**amd64 only** — no arm64/Apple Silicon builds.

**Switching from upstream?** Replace the image line in your existing compose file — config volumes are compatible:

```diff
-    image: agregarr/agregarr:latest
+    image: bitr8/agregarr:develop
```

### Compose example

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

For general Agregarr configuration (services, collections, overlays etc.), see the [upstream docs](https://agregarr.org/docs/installation) — note that they reference the upstream image, not this fork.

## Fork-Only Features

Features not yet submitted upstream:

### Real-time Overlay Job Progress

Live dashboard status showing progress, item counts, ETA, and a stop button for each library.

![Overlay Jobs Status](public/images/overlay-jobs-status.png)

### Performance Optimizations

- **Batch IMDb Prefetch**: Fetches IMDb ratings upfront in batches of 20 via TMDB lookup, then queries IMDb in bulk. Reduces thousands of API calls to tens.
- **Adaptive TTL Caching**: Cache duration based on content age. New releases cache for 12 hours, older content up to 30 days.
- **Stale Cache Fallback**: Returns cached ratings when external APIs fail instead of breaking the overlay job.
- **Configurable Rating Cache**: Settings UI option to adjust maximum IMDb/RT cache duration (7-90 days).
- **Collection Sync Cache**: Caches `getAllCollections()` across loop iterations during collection sync. Invalidates on mutations (create, update, delete). Saves ~25-30s on full sync jobs.
- **Batch Overlay Metadata**: Fetches metadata for multiple items per Plex API call using `/library/metadata/{key1,key2,...}`. Chunks into batches of 200. Falls back to individual fetch on failure.
- **AniList Retry Cap**: Caps rate-limit retries at 5 attempts. Fixes pre-existing `parseInt` NaN bug that caused tight loops on non-numeric Retry-After headers.
- **Persistent TMDB Resolution Cache**: SQLite cache of Letterboxd title-to-TMDB-ID mappings with adaptive TTL. Reduces subsequent full syncs from ~45 min to ~10-15 min by avoiding 33,000+ redundant TMDB API calls.

### Direct Plex Deletion for Placeholder Cleanup

Improves placeholder cleanup reliability when Plex's built-in trash mechanism fails.

**Problem:** Plex ignores empty directories during library scans. When a placeholder file is deleted and its directory becomes empty, `scanLibrary()` + `emptyTrash()` won't remove the stale database entry.

**Solution:** Delete stale Plex items directly via API:

1. Track which placeholder file paths were deleted during cleanup
2. Query Plex once per library for items referencing those exact paths
3. Delete stale items via `DELETE /library/metadata/{ratingKey}`
4. Fall back to scan+emptyTrash only when direct deletion can't find matches

**Safeguards:** Only tracks successfully deleted placeholder files, uses exact path matching, deduplicates rating keys, and only considers files matching placeholder patterns.

### Sonarr Folder Naming for TV Placeholders

TV placeholders use Sonarr's folder naming convention when the show exists in Sonarr.

**Problem:** Agregarr created placeholders at `/tv/Show (2024)/` but Sonarr uses `/tv/Show (2024) [imdbid-tt1234567]/`. When real content arrived, Plex saw them as different shows, leaving orphaned entries.

**Solution:** Extract the folder name from Sonarr's series path for placeholder creation. Falls back to standard naming if the show isn't in Sonarr.

## Upstream PRs

### Open

| PR                                                    | Description                                                 | Depends On |
| ----------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| [#453](https://github.com/agregarr/agregarr/pull/453) | Re-apply placeholder markers during global discovery (#414) | -          |
| [#452](https://github.com/agregarr/agregarr/pull/452) | Disambiguate TMDB person search for person spotlight        | -          |
| [#450](https://github.com/agregarr/agregarr/pull/450) | Use episode air date for TV recently released filtered hubs | -          |
| [#444](https://github.com/agregarr/agregarr/pull/444) | Use correct Plex API endpoint for collection title updates  | -          |
| [#404](https://github.com/agregarr/agregarr/pull/404) | Check \*arr download status for placeholder lifecycle       | -          |

### Pending Submission

| Feature                                         | Blocked By |
| ----------------------------------------------- | ---------- |
| Direct Plex API deletion for stale placeholders | -          |
| Use Sonarr folder naming for TV placeholders    | #404       |

> **Note:** Sonarr folder naming extends `batchCheckDownloadStatus()` from #404, adding `folderName` to the `showsByTvdbId` map. Cannot submit until #404 merges.

> **Legacy Cleanup:** TV placeholders created before the Sonarr folder naming fix may not match Sonarr's naming convention. If orphaned placeholders appear after real content arrives, delete the placeholder folder and let the next sync recreate it correctly.

### Merged

| PR                                                    | Description                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| [#446](https://github.com/agregarr/agregarr/pull/446) | Add date format options for US and UK/AU locales                     |
| [#445](https://github.com/agregarr/agregarr/pull/445) | Persist applyOverlaysDuringSync for pre-existing collections         |
| [#413](https://github.com/agregarr/agregarr/pull/413) | Pass options to ExternalAPI constructor correctly                    |
| [#405](https://github.com/agregarr/agregarr/pull/405) | Fix Letterboxd title extraction from data-item-name                  |
| [#400](https://github.com/agregarr/agregarr/pull/400) | Empty Plex trash after placeholder cleanup                           |
| [#387](https://github.com/agregarr/agregarr/pull/387) | Skip date filtering for non-Coming-Soon with includeAllReleasedItems |
| [#358](https://github.com/agregarr/agregarr/pull/358) | IMDb Top 250 English Movies collection type                          |
| [#356](https://github.com/agregarr/agregarr/pull/356) | Handle 404 gracefully when deleting hub items                        |
| [#350](https://github.com/agregarr/agregarr/pull/350) | Validate SVG icon dimensions and file type                           |
| [#349](https://github.com/agregarr/agregarr/pull/349) | Don't double-estimate digital release dates                          |
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
