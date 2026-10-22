const prisma = require("./prisma");

// Profile badges. Earned automatically from activity; permanent once earned
// (stored in UserBadge). Three badges from the design spec are intentionally
// omitted for now because the data to compute them doesn't exist yet:
//   - globetrotter (albums from 10 countries)  -> Album has no country field
//   - tastemaker   (queues after review views) -> no review-view tracking
//   - earlybird    (joined during beta)        -> no beta cutoff defined
// Display order below matches the design, with those three removed.
const BADGES = [
  { id: "first_spin",  name: "First spin",  category: "blue",   goal: null, desc: "Log your first album." },
  { id: "critic",      name: "Critic",      category: "blue",   goal: 25,   desc: "Write 25 reviews." },
  { id: "mixer",       name: "Mixer",       category: "blue",   goal: 5,    desc: "Make 5 mixes." },
  { id: "superfan",    name: "Superfan",    category: "blue",   goal: null, desc: "Give an album a 10/10." },
  { id: "second_take", name: "Second take", category: "pink",   goal: null, desc: "Log your first re-listen." },
  { id: "ninja",       name: "Ninja",       category: "pink",   goal: 10,   desc: "Rate 10 albums without writing a review." },
  { id: "hater",       name: "Hater",       category: "lime",   goal: 10,   desc: "Give 10 albums a rating of 3 or lower." },
  { id: "trendsetter", name: "Trendsetter", category: "orange", goal: null, desc: "Review an album before it has 10 ratings." },
  { id: "socialite",   name: "Socialite",   category: "orange", goal: 50,   desc: "Reach 50 followers." },
  { id: "celeb",       name: "Celeb",       category: "orange", goal: 100,  desc: "Reach 100 followers." },
  { id: "chatty",      name: "Chatty",      category: "orange", goal: 5,    desc: "Leave 5 comments." },
];

const BADGE_IDS = BADGES.map((b) => b.id);

// createdAt of the nth (1-based) item in an asc-ordered list, or null.
const nth = (arr, n) => (arr.length >= n ? arr[n - 1].createdAt : null);
const hasText = (t) => !!(t && String(t).trim());

// Compute each badge's live state for a user:
//   { earned: bool, progress: number, earnedAt: Date|null (best-effort) }
// earnedAt is derived from the triggering record's timestamp where cheap, so a
// badge discovered for the first time still gets a meaningful date. For badges
// persisted in UserBadge the stored date wins (see the route).
async function computeLiveBadges(userId) {
  const [reviews, relistens, mixes, follows, comments] = await Promise.all([
    prisma.review.findMany({
      where: { userId },
      select: { rating: true, reviewText: true, albumId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.relisten.findMany({
      where: { userId },
      select: { rating: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.albumMix.findMany({
      where: { userId },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.follow.findMany({
      where: { followedId: userId },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.reviewComment.findMany({
      where: { userId },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const written = reviews.filter((r) => hasText(r.reviewText));
  const silent = reviews.filter((r) => !hasText(r.reviewText));
  const low = reviews.filter((r) => r.rating <= 3);

  // superfan: earliest 10/10 across reviews or re-listens.
  const tenDates = [
    ...reviews.filter((r) => r.rating === 10).map((r) => r.createdAt),
    ...relistens.filter((r) => r.rating === 10).map((r) => r.createdAt),
  ].sort((a, b) => a - b);

  // trendsetter: did the user review an album that currently has < 10 ratings?
  // (Approximates "while it had < 10" using the current total — close enough,
  // and only ever under-counts as albums grow.)
  let trendsetterDate = null;
  if (reviews.length) {
    const albumIds = [...new Set(reviews.map((r) => r.albumId))];
    const grouped = await prisma.review.groupBy({
      by: ["albumId"],
      where: { albumId: { in: albumIds } },
      _count: { albumId: true },
    });
    const small = new Set(grouped.filter((g) => g._count.albumId < 10).map((g) => g.albumId));
    const hit = reviews.find((r) => small.has(r.albumId));
    if (hit) trendsetterDate = hit.createdAt;
  }

  const S = {};
  S.first_spin  = { earned: reviews.length > 0,   progress: Math.min(reviews.length, 1),        earnedAt: nth(reviews, 1) };
  S.critic      = { earned: written.length >= 25,  progress: written.length,                     earnedAt: nth(written, 25) };
  S.mixer       = { earned: mixes.length >= 5,      progress: mixes.length,                        earnedAt: nth(mixes, 5) };
  S.superfan    = { earned: tenDates.length > 0,    progress: tenDates.length > 0 ? 1 : 0,         earnedAt: tenDates[0] || null };
  S.second_take = { earned: relistens.length > 0,   progress: Math.min(relistens.length, 1),       earnedAt: nth(relistens, 1) };
  S.ninja       = { earned: silent.length >= 10,    progress: silent.length,                       earnedAt: nth(silent, 10) };
  S.hater       = { earned: low.length >= 10,       progress: low.length,                          earnedAt: nth(low, 10) };
  S.trendsetter = { earned: !!trendsetterDate,      progress: trendsetterDate ? 1 : 0,             earnedAt: trendsetterDate };
  S.socialite   = { earned: follows.length >= 50,   progress: follows.length,                      earnedAt: nth(follows, 50) };
  S.celeb       = { earned: follows.length >= 100,  progress: follows.length,                      earnedAt: nth(follows, 100) };
  S.chatty      = { earned: comments.length >= 5,   progress: comments.length,                     earnedAt: nth(comments, 5) };
  return S;
}

module.exports = { BADGES, BADGE_IDS, computeLiveBadges };
