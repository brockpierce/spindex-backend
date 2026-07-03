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
 * coverArtUrl is still null, call getCoverArtUrl() once, save the result,
 * and never ask again.
 *
 * The Cover Art Archive (coverartarchive.org) is a separate service from
 * the main MusicBrainz API and -- as of this writing -- has no published
 * rate limit, but it's still good practice to cache aggressively and
 * avoid re-fetching for albums you already have an answer for (including
 * a cached "no art available" result, see below).
 *
 * USAGE (from your Express route, e.g. GET /api/albums/:id):
 *   const { getCoverArtUrl } = require("./lib/coverart");
 *   if (!album.coverArtUrl && album.musicbrainzId) {
 *     const url = await getCoverArtUrl(album.musicbrainzId);
 *     await prisma.album.update({ where: { id: album.id }, data: { coverArtUrl: url || "none" } });
 *   }
 */

const USER_AGENT = "Spindex/0.1.0 ( replace-with-your-contact-email@example.com )";

/**
 * Returns a direct image URL for the album's front cover, or null if no
 * cover art has been uploaded for this release-group.
 */
async function getCoverArtUrl(musicbrainzReleaseGroupId) {
  const url = `https://coverartarchive.org/release-group/${musicbrainzReleaseGroupId}/front-500`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s max
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    clearTimeout(timeout);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`Cover Art Archive returned ${response.status} for ${musicbrainzReleaseGroupId}`);
      return null;
    }
    return response.url;
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn(`Cover art fetch timed out for ${musicbrainzReleaseGroupId}`);
    } else {
      console.warn(`Cover art fetch failed for ${musicbrainzReleaseGroupId}: ${err.message}`);
    }
    return null;
  }
}

module.exports = { getCoverArtUrl };
