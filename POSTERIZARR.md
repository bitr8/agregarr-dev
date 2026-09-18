# Posterizarr integration

Agregarr can work with Posterizarr as an artwork follow-up service. After an
Arr-triggered Posterizarr job uploads artwork to Plex, Posterizarr can notify
Agregarr to update collection membership and apply the configured overlays to
that item.

For Sonarr imports, the callback can include season and episode numbers. This
lets Agregarr update the show's main poster, its season poster, and the episode
title card without running a full-library sync.

## Configure the integration

1. In Agregarr, open **Overlay System > Overlay Output Settings**, enable
   **Posterizarr Integration**, and save.
2. Copy the Agregarr API key from **Settings > General**.
3. In Posterizarr's **Config Editor > Language & Notifications**, set
   **AgregarrTriggerEnabled**, **AgregarrUrl**, and **AgregarrApiKey**.
4. Use the **Test** button beside the URL, then save the settings.
5. **AgregarrRetryTimeout** controls Posterizarr's retry window (60 seconds by
   default; 0 disables retries). Increase it if imports regularly overlap long
   Agregarr syncs.

The URL must be reachable from the Posterizarr container. If both applications
share a Docker network, a service-name URL such as `http://agregarr:7171` can be
used. Otherwise, use the reachable address of the Agregarr host.

Posterizarr authenticates through Agregarr's normal `X-API-Key` header. The
callback endpoints are:

- `POST /api/v1/posterizarr/trigger`
- `GET /api/v1/posterizarr/status`

## Configure overlay targets

Each overlay template can target one or more artwork types:

- **Main poster** for movies and shows
- **Season poster** for TV seasons
- **Episode card** for TV episodes

Existing templates default to **Main poster**. Episode templates use a 16:9
preview and should normally use a 1920 x 1080 canvas.

The library configuration also controls which targets are included in full and
quick overlay syncs. **Posterizarr callbacks use the Quick sync targets** and
still require a matching enabled template. An empty Quick sync selection disables
callback overlays for that library, but does not disable collection membership
updates. Movie libraries only expose main posters. Show libraries
can process main, season, and episode artwork. Upgraded libraries keep their
main-poster scope until you select season/episode targets and enable compatible
templates; choices saved by earlier integration builds are preserved.
IMDb templates use the episode's own positive rating, and season IMDb ratings
are derived from rated episodes in that season. TMDB templates use the season
or episode's own TMDB rating. Missing IMDb ratings do not suppress independent
TMDB or technical templates.

## Processing behavior

For each accepted callback, Agregarr:

1. resolves the Plex library from the root rating key;
2. adds the movie or show to matching collections and removes replaced
   placeholders;
3. resolves the requested Plex season and episode only as needed by the library's
   Quick sync targets; and
4. applies templates whose artwork targets match the selected, resolved items.

Callbacks are queued and processed serially, with mutual exclusion against full
collection and overlay syncs. Duplicate callbacks for the same root/season/episode coordinates
are coalesced for 60 seconds. The queue accepts at most 100 waiting items.
Callbacks arriving during a full collection or overlay sync, or after the queue
fills, receive a retryable response instead of accumulating unbounded work. A
full sync also declines to start while Posterizarr work is queued or running. A
Posterizarr job sends its callback only after a Plex artwork upload succeeds.
Skipped full syncs log a warning and are not automatically deferred: they must
be started manually or wait for the next scheduled run. Sustained callback
traffic can therefore postpone a full sync across multiple scheduled runs.

## Poster selection and metadata compatibility

When Plex is the base-poster source, Agregarr reads Plex's poster list and uses
the selected poster. Selected uploaded posters, including Posterizarr uploads,
are downloaded through Plex's content-addressed file endpoint so the exact
poster bytes are used even if another process changes the selection during a
job. If Plex omits its selected marker, Agregarr safely falls back to the
library item's current thumbnail instead of guessing among stale uploads.

Agregarr writes an ownership marker into generated JPEG metadata. Posterizarr
can recognize this marker and will not treat an Agregarr overlay as an
unmanaged poster. Reset and restore operations preserve recognized Posterizarr
ownership metadata when re-encoding artwork.

The JPEG output is deliberate: the ownership marker must be stored where
Posterizarr can read it reliably. The first full overlay sync after upgrading
from an older WebP-producing build re-renders and re-uploads eligible artwork
owned by Agregarr because the output format and render hash changed. Collection
syncs with **Apply overlays during sync** enabled, or item callbacks, can refresh
their eligible items earlier. Quick sync only picks up items without a metadata
row, so it does not perform this migration for already-tracked artwork. Later
full syncs return to normal hash-based unchanged detection.

To postpone the JPEG overlay re-render through all these paths, **disable all
overlay templates for the library**. Deselecting full/quick sync targets alone
does not stop collection sync overlays; disabling the Posterizarr callback
setting alone does not stop scheduled overlay or collection jobs.

Outcome details are retained in memory for the current or last run, capped at
5,000 items per library. Search and CSV export include only retained details;
the overall counters still include every processed item.

## Manual callback example

```sh
curl -X POST http://agregarr:7171/api/v1/posterizarr/trigger \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: your-agregarr-api-key' \
  -d '{
    "ratingKey": "12345",
    "mediaType": "show",
    "title": "Example Show",
    "seasonNumber": 2,
    "episodeNumber": 5
  }'
```

The endpoint returns HTTP 202 when the item is queued or coalesced with recent
work. It returns 409 during a full sync and 429 when the queue is full; both
responses include a `Retry-After` header that callers should honor. Queue state
and the last completed result
are available from the status endpoint.
