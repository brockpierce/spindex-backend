/**
 * Lazily fetch cover art for one album from the Cover Art Archive, and
 * cache the resulting URL on the Album row so we never fetch it twice.
 *
 * WHY THIS IS SEPARATE FROM THE BULK IMPORT
 * The MusicBrainz dump doesn't include actual cover images -- only the
 * main metadata. Pre-fetching art for every album in a 500k+ row import
 * would be both slow and wasteful, since most of those albums will never
 * be opened by a user. Instead, we resolve cover art on demand: the first
 * time someone opens an album page (or it shows up in search results) and
 * coverArtUrl is still null, call getCoverArtUrl() once and save the
 * result. If CAA definitively says "no cover for this album," we cache
 * that as "none" so we don't ask again. If CAA times out or errors, we
 * leave the row alone so a future visit tries again.
 *
 * The Cover Art Archive (coverartarchive.org) is a separate service from
 * the main MusicBrainz API and -- as of this writing -- has no published
 * rate limit, but it's still good practice to cache aggressively.
 *
 * USAGE (from your Express route, e.g. GET /api/albums/:id):
 *   const { getCoverArtUrl } = require("./lib/coverart");
 *   if (!album.coverArtUrl && album.musicbrainzId) {
 *     const result = await getCoverArtUrl(album.musicbrainzId);
 *     if (result.confirmed) {
 *       // CAA answered definitively: url is either a real URL or null (no cover)
 *       await prisma.album.update({ where: { id: album.id }, data: { coverArtUrl: result.url || "none" } });
 *     }
 *     // else: transient failure, leave the row alone so we retry next time
 *   }
 */

const USER_AGENT = "Spindex/0.1.0 ( replace-with-your-contact-email@example.com )";

/**
 * Query the Cover Art Archive for the album's front cover.
 * Returns:
 *   { confirmed: true, url: "https://..." }  -- cover art exists at this URL
 *   { confirmed: true, url: null }           -- CAA definitively has no cover
 *   { confirmed: false }                     -- transient failure (timeout,
 *                                               5xx, network error) -- caller
 *                                               should NOT cache this as
 *                                               "none"; let a later request
 *                                               retry.
 */
async function getCoverArtUrl(musicbrainzReleaseGroupId) {
  const url = `https://coverartarchive.org/release-group/${musicbrainzReleaseGroupId}/front-500`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s max
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timeout);

    // Definitive "no cover exists for this release-group"
    if (response.status === 404) return { confirmed: true, url: null };

    // Definitive "cover found"
    if (response.ok) return { confirmed: true, url: response.url };

    // 429 (rate limit) or 5xx -- transient, don't cache as "none"
    console.warn(`Cover Art Archive returned ${response.status} for ${musicbrainzReleaseGroupId} -- treating as transient`);
    return { confirmed: false };
  } catch (err) {
    // Timeout / abort / network error -- also transient
    if (err.name === "AbortError") {
      console.warn(`Cover art fetch timed out for ${musicbrainzReleaseGroupId} -- treating as transient`);
    } else {
      console.warn(`Cover art fetch failed for ${musicbrainzReleaseGroupId}: ${err.message} -- treating as transient`);
    }
    return { confirmed: false };
  }
}

module.exports = { getCoverArtUrl };
