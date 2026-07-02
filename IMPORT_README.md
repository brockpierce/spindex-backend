# Importing albums from MusicBrainz

This sets up your local album catalog from MusicBrainz's public data dump.
You only need to do this once (and occasionally re-run it to pick up new
releases).

## 1. Install dependencies

```
cd backend
npm install
cp .env.example .env
npx prisma migrate dev --name init
```

That last command creates `backend/dev.db` -- your actual SQLite database
file -- with all the tables described in `prisma/schema.prisma`.

## 2. Download the MusicBrainz release-group dump

Go to:
https://data.metabrainz.org/pub/musicbrainz/data/json-dumps/LATEST/

Download `release-group.tar.xz` from that folder (this is the largest
single piece -- expect it to be a multi-gigabyte download; it contains
every album, single, and EP ever entered into MusicBrainz).

## 3. Extract it

```
tar -xf release-group.tar.xz
```

This creates a folder called `mbdump/` containing one file named
`release-group` (no file extension). That file is what you point the
import script at.

If you're on Windows and don't have `tar`, use 7-Zip (it can open
.tar.xz directly), or run the above command inside WSL.

## 4. Run the import

Start small to make sure everything works before committing to the full
file, which can take a while:

```
node scripts/import-musicbrainz.js /path/to/mbdump/release-group --limit=2000
```

Check `npx prisma studio` (opens a browser-based table viewer) to confirm
the Album table now has rows that look right.

Once you're happy, run it for real without the limit:

```
node scripts/import-musicbrainz.js /path/to/mbdump/release-group
```

This will take a while -- the release-group dump has several million
entries total, and since we import every type by default (not just full
albums), this is the larger end of that range. Expect anywhere from 20
minutes to a couple hours depending on your machine, since SQLite writes
are the bottleneck, not reading the file. The script prints progress
every 500 albums so you can watch it move and confirm it's not stuck.

By default, this imports type "Album" and "EP" release-groups (singles,
broadcasts, and other minor release types are skipped). Compilations are
already covered -- MusicBrainz files most compilations as primary-type
"Album" with a secondary "Compilation" tag, so they come along for free
whenever "Album" is included; there's no separate "Compilation" type to
filter on.

Useful flags if you want to narrow it down further, or widen it back out:
- `--types=Album` -- only full albums, skip EPs too
- `--types=Album,EP,Single,Broadcast,Other` -- import everything MusicBrainz has
- `--min-year=1960` -- skip anything released before 1960
- `--limit=N` -- stop after N albums (handy for testing)

The script is safe to re-run. It matches on MusicBrainz ID, so running it
twice won't create duplicate albums.

## 5. Cover art

The dump doesn't include actual images, only metadata. Cover art is
fetched lazily, per-album, the first time someone views it -- see
`lib/coverart.js` for that logic and how to wire it into your album
detail route. This avoids fetching images for albums nobody ever looks at.

## 6. Keeping it fresh later

MusicBrainz publishes a new dump twice a week. For a hobby project,
re-running this import every month or so (re-downloading the latest dump)
is plenty to catch new releases. You don't need real-time sync.
