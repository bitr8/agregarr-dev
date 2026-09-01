# Posterizarr integration

Agregarr can work with Posterizarr as an artwork follow-up service. After an
Arr-triggered Posterizarr job uploads artwork to Plex, Posterizarr can notify
Agregarr to update collection membership and apply the configured overlays to
that item.

For Sonarr imports, the callback can include season and episode numbers. This
lets Agregarr update the show's main poster, its season poster, and the episode
title card without running a full-library sync.

## Configure the integration

1. In Agregarr, copy the API key from **Settings > General**.
2. In Posterizarr, open **Auto Triggers > Agregarr**.
3. Enable the integration and enter the Agregarr base URL and API key.
4. Use **Test connection**, then save the settings.

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
quick overlay syncs. Movie libraries only expose main posters. Show libraries
can process main, season, and episode artwork. Episode rating presets are
applied only when the episode itself has a usable IMDb rating; otherwise the
clean title card is kept or restored.

## Processing behavior

For each accepted callback, Agregarr:

1. resolves the Plex library from the root rating key;
2. adds the movie or show to matching collections and removes replaced
   placeholders;
3. resolves the requested Plex season and episode, when supplied; and
4. applies templates whose artwork targets match the resolved items.

Callbacks are queued and processed serially so they cannot race collection or
overlay jobs. Duplicate callbacks for the same root/season/episode coordinates
are coalesced for 60 seconds. A Posterizarr job sends its callback only after a
Plex artwork upload succeeds.

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
work. Queue state and the last completed result are available from the status
endpoint.
