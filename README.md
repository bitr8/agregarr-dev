# Agregarr (Personal Fork)

Personal fork of [Agregarr](https://github.com/agregarr/agregarr) with features and fixes I wanted but aren't in upstream yet. Changes are submitted as PRs when ready.

## Docker Image

```yaml
services:
  agregarr:
    image: bitr8/agregarr:develop
    container_name: agregarr
    volumes:
      - /path/to/config:/app/config
      - /path/to/placeholder/movies:/data/movies # Optional: Coming Soon
      - /path/to/placeholder/tv:/data/tv         # Optional: Coming Soon
    environment:
      - TZ=Australia/Sydney
    ports:
      - 7171:7171
    restart: unless-stopped
```

Full setup docs at [agregarr.org](https://agregarr.org/docs/installation).

## What's Different

### Real-time Overlay Job Progress

Live overlay job status on the dashboard with progress bar, ETA, item counts, and stop button.

![Overlay Jobs Status](public/images/overlay-jobs-status.png)

### Performance

- **Batch IMDb Prefetch**: Fetches all IMDb ratings upfront in batches of 100 instead of per-item. Turns 2800+ calls into ~29.
- **Adaptive TTL Caching**: IMDb ratings cached based on content age (12h for new, 30 days for older).
- **Plex GUID Extraction**: Pulls IMDb IDs from Plex metadata, skips TMDB lookup for 99%+ of items.
- **Stale Cache Fallback**: Returns cached data when APIs fail instead of breaking the job.
- **TMDB Poster Caching**: Caches poster downloads for 7 days.

### UX

- **Configurable Rating Cache**: Settings UI to adjust IMDb/RT cache duration (7-90 days).
- **Daily Show Filter**: Keeps soap operas out of Coming Soon collections.
- **IMDb Top 250 English**: Collection source for English-language movies only.

### Security

- **Error Sanitization**: No internal paths or stack traces in API responses.
- **Input Validation**: Extra checks on user input.

## Upstream PRs

### Open

| PR | Description |
|----|-------------|
| [#358](https://github.com/agregarr/agregarr/pull/358) | IMDb Top 250 English Movies collection type |
| [#356](https://github.com/agregarr/agregarr/pull/356) | Handle 404 gracefully when deleting hub items |
| [#355](https://github.com/agregarr/agregarr/pull/355) | Add missing /user/{userId}/settings/main to OpenAPI spec |
| [#354](https://github.com/agregarr/agregarr/pull/354) | Preserve placeholders for released content in non-Coming Soon collections |
| [#350](https://github.com/agregarr/agregarr/pull/350) | Validate SVG icon dimensions and file type |
| [#349](https://github.com/agregarr/agregarr/pull/349) | Don't double-estimate digital release dates |
| [#348](https://github.com/agregarr/agregarr/pull/348) | Fix scheduler startNow immediate sync and deadlock bugs |

### Merged

| PR | Description |
|----|-------------|
| [#345](https://github.com/agregarr/agregarr/pull/345) | Multi-source label regex for collection matching |
| [#340](https://github.com/agregarr/agregarr/pull/340) | Handle Jellyfin trickplay directories during cleanup |
| [#332](https://github.com/agregarr/agregarr/pull/332) | Trigger Plex scan after placeholder cleanup |
| [#321](https://github.com/agregarr/agregarr/pull/321) | Surface per-collection sync errors to UI |
| [#306](https://github.com/agregarr/agregarr/pull/306) | Uniform scaling for non-standard poster aspect ratios |
| [#305](https://github.com/agregarr/agregarr/pull/305) | Downgrade library mismatch message to debug level |
| [#304](https://github.com/agregarr/agregarr/pull/304) | Sync networksCountry to sources array on change |
| [#303](https://github.com/agregarr/agregarr/pull/303) | Fetch Maintainerr collections in overlay test route |
| [#302](https://github.com/agregarr/agregarr/pull/302) | Return episodeNumber from fetchReleaseDateInfo |
| [#300](https://github.com/agregarr/agregarr/pull/300) | Harden API clients and file operations |
| [#282](https://github.com/agregarr/agregarr/pull/282) | Sanitize error responses |
| [#278](https://github.com/agregarr/agregarr/pull/278) | Filter daily shows from Coming Soon collections |
| [#277](https://github.com/agregarr/agregarr/pull/277) | TMDB poster caching and race condition fixes |

## Fork-Only Features

Not yet submitted upstream:

- **Real-time Job Progress**: Dashboard shows live overlay progress with ETA and stop button
- **Batch IMDb Prefetch**: Fetches ratings in bulk instead of per-item
- **Adaptive TTL Caching**: Cache duration based on content age
- **Plex GUID Extraction**: Skips TMDB lookup when IMDb ID is in Plex metadata
- **Configurable Rating Cache**: Settings UI for cache duration
- **RT Certified Fresh Overlay**: Preset for Rotten Tomatoes Certified Fresh badge
- **Stale Cache Fallback**: Returns cached data when APIs fail

## License

GPL-3.0, same as upstream.

## Credits

All the real work is by the [Agregarr](https://github.com/agregarr/agregarr) team.
