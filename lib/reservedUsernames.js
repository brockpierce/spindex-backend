// Usernames that can't be registered or changed to. Edit these lists freely —
// they're applied on BOTH signup and username change (see routes/auth.js).

// Exact matches: brand/system names, app routes, and handles to claim later.
const RESERVED = new Set([
  // system / brand / routes
  "admin", "administrator", "root", "support", "help", "staff", "team",
  "mod", "moderator", "system", "official", "noteblock", "mynoteblock",
  "api", "www", "mail", "email", "noreply", "no-reply", "postmaster",
  "about", "settings", "login", "signup", "logout", "home", "profile",
  "explore", "search", "security", "billing", "null", "undefined", "me",
  // --- handles to claim later: add your own below ---
  "brock",
].map((s) => s.toLowerCase()));

// Offensive terms blocked anywhere in the username (plain substring). These
// rarely appear inside innocent words, so a substring match is safe. Add freely.
const OFFENSIVE_SUBSTRING = [
  "fuck", "shit", "cunt", "pussy", "slut", "whore", "bastard",
  "nigger", "nigga", "faggot", "retard", "tranny", "kike",
  "chink", "wetback", "nazi", "molest", "kkk", "pedophile",
].map((s) => s.toLowerCase());

// Offensive terms that ARE substrings of innocent words (grape/therapist →
// "rape", raccoon → "coon", spicy → "spic", torpedo → "pedo"). These match only
// as a whole token — bounded by the start/end or a digit/underscore, never
// mid-word — so real words slip through while slurs on their own are caught.
const OFFENSIVE_TOKEN = [
  "rape", "rapist", "coon", "spic", "dyke", "pedo",
].map((s) => s.toLowerCase());

// Expects an already-normalized (lowercased, trimmed) username [a-z0-9_].
// Returns { ok: true } or { ok: false, reason }.
function checkUsername(normalized) {
  const u = String(normalized || "");
  if (RESERVED.has(u)) return { ok: false, reason: "That username isn't available." };
  for (const bad of OFFENSIVE_SUBSTRING) {
    if (bad && u.includes(bad)) return { ok: false, reason: "That username isn't allowed." };
  }
  for (const bad of OFFENSIVE_TOKEN) {
    // Letters are "word" chars; digits/underscore/ends are boundaries.
    if (bad && new RegExp(`(^|[^a-z])${bad}([^a-z]|$)`).test(u)) {
      return { ok: false, reason: "That username isn't allowed." };
    }
  }
  return { ok: true };
}

module.exports = { checkUsername, RESERVED, OFFENSIVE_SUBSTRING, OFFENSIVE_TOKEN };
