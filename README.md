# Agregarr (Personal Fork)

Personal fork of [Agregarr](https://github.com/agregarr/agregarr) with features and performance fixes I wanted but aren't in upstream yet. Changes are submitted as PRs when they're ready.

This is for my own use, but if you see something useful, go for it.

## Docker Image

```yaml
services:
  agregarr:
    image: bitr8/agregarr:develop
    container_name: agregarr
    volumes:
      - /path/to/config:/app/config
      - /path/to/placeholder/movies:/data/movies  # Optional: Coming Soon feature
      - /path/to/placeholder/tv:/data/tv          # Optional: Coming Soon feature
    environment:
      - TZ=Australia/Sydney
    ports:
      - 7171:7171
    restart: unless-stopped
```

Full setup docs at [agregarr.org](https://agregarr.org/docs/installation).

## What's Different

### Performance

- **Batch IMDb Prefetch**: Fetches all IMDb ratings upfront in batches of 100, instead of one API call per item. Turns 2800+ calls into ~29.
- **Adaptive TTL Caching**: IMDb ratings cached based on content age (12h for new stuff, 30 days for older content).
- **Plex GUID Extraction**: Pulls IMDb IDs straight from Plex metadata, skips TMDB lookup for 99%+ of items.
- **Stale Cache Fallback**: Returns cached data when APIs fail instead of breaking the whole job.
- **TMDB Poster Caching**: Caches poster downloads for 7 days (upstream downloads fresh every run).

### UX

- **Job Progress**: Shows current item and percentage during overlay runs.
- **Daily Show Filter**: Keeps soap operas out of Coming Soon (they always show as "upcoming" because of yearly seasons).

### Security

- **Error Sanitization**: No more internal paths or stack traces in API responses.
- **Input Validation**: Extra checks on user input.

## Open PRs

| PR | What it does | Status |
|----|--------------|--------|
| [#277](https://github.com/agregarr/agregarr/pull/277) | TMDB caching + perf fixes | Open |
| [#278](https://github.com/agregarr/agregarr/pull/278) | Filter daily shows from Coming Soon | Open |
| [#280](https://github.com/agregarr/agregarr/pull/280) | Job progress feedback | Awaiting CI |
| [#281](https://github.com/agregarr/agregarr/pull/281) | Error logging hardening | Awaiting CI |
| [#282](https://github.com/agregarr/agregarr/pull/282) | Sanitize error responses | Awaiting CI |

## What's Not Upstream Yet

- Batch IMDb prefetch
- Adaptive TTL caching

These might become PRs once I've tested them more.

## License

GPL-3.0, same as upstream.

## Credits

All the real work is by the [Agregarr](https://github.com/agregarr/agregarr) team.
