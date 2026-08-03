// k6 load test for the noteblock API.
//
//   brew install k6
//   # 1) Local — find the app's RAW ceiling (start the server first):
//   BASE_URL=http://localhost:3001 k6 run loadtest/smoke.js
//   # 2) Gentle prod smoke (keep PEAK low — see README, single-IP hits the limiter):
//   BASE_URL=https://spindex-backend.onrender.com PEAK=10 k6 run loadtest/smoke.js
//   # optional: exercise authed read paths by passing a JWT
//   TOKEN=<jwt> BASE_URL=... k6 run loadtest/smoke.js
//
// Read-only: hits health, album search (the heaviest read — FTS), qotd, and
// (if TOKEN set) the public feed. No writes, so it never pollutes the DB.
// See loadtest/README.md for how to interpret results and test the WRITE path.
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3001";
const TOKEN = __ENV.TOKEN || "";
const PEAK = Number(__ENV.PEAK || 100); // peak virtual users

const errors = new Rate("errors");

export const options = {
  stages: [
    { duration: "30s", target: Math.ceil(PEAK * 0.2) }, // warm up
    { duration: "1m", target: Math.ceil(PEAK * 0.5) },  // ramp
    { duration: "1m", target: PEAK },                    // sustained peak
    { duration: "30s", target: 0 },                      // ramp down
  ],
  thresholds: {
    http_req_failed: ["rate<0.02"],   // <2% failed requests
    http_req_duration: ["p(95)<800"], // 95th percentile under 800ms
    errors: ["rate<0.02"],
  },
};

const SEARCHES = [
  "radiohead", "the beatles", "kendrick", "taylor swift", "miles davis",
  "daft punk", "nirvana", "sza", "tyler the creator", "boards of canada",
];
const authParams = TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {};

export default function () {
  let r = http.get(`${BASE}/api/health`);
  check(r, { "health 200": (x) => x.status === 200 }) || errors.add(1);

  // Album search exercises the FTS query — the heaviest read path.
  const q = SEARCHES[Math.floor(Math.random() * SEARCHES.length)];
  r = http.get(`${BASE}/api/albums?search=${encodeURIComponent(q)}&limit=25`);
  check(r, { "search ok": (x) => x.status === 200 }) || errors.add(1);

  r = http.get(`${BASE}/api/qotd`);
  check(r, { "qotd ok": (x) => x.status === 200 || x.status === 404 }) || errors.add(1);

  if (TOKEN) {
    r = http.get(`${BASE}/api/feed/public?limit=25`, authParams);
    check(r, { "feed 200": (x) => x.status === 200 }) || errors.add(1);
  }

  sleep(Math.random() + 0.5); // 0.5–1.5s think time
}
