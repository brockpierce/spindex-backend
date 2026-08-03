# Load testing noteblock

Goal: **know your ceiling before your users find it.** Find how many concurrent
users the API serves before latency/errors climb, then either raise the ceiling
or throttle to it.

## Setup

```bash
brew install k6   # or: https://k6.io/docs/get-started/installation/
```

## 1. Local run — the app's raw ceiling (recommended first)

Start the backend locally, then point k6 at it:

```bash
# terminal 1
npm start
# terminal 2
BASE_URL=http://localhost:3001 k6 run loadtest/smoke.js
```

This measures the Node app + SQLite on your machine with no proxy/rate-limit in
the way. Watch `http_req_duration p(95)` and `http_req_failed` climb as VUs
ramp — the VU count where p95 crosses ~800ms or errors start is your read
ceiling. Tune the peak with `PEAK=200 k6 run ...`.

## 2. Prod smoke — keep it gentle

⚠️ Two reasons **not** to blast production:
1. **The rate limiter caps single-IP load.** `apiLimiter` allows 3000 req / 15
   min per IP, so from one machine you'll hit 429s and measure the *limiter*,
   not the server. For a real distributed test use k6 Cloud, or temporarily
   raise the limit on a staging deploy.
2. You'd be degrading the service for real users.

For a *smoke* check that prod is alive under mild concurrency:

```bash
BASE_URL=https://spindex-backend.onrender.com PEAK=10 k6 run loadtest/smoke.js
```

## 3. Testing the WRITE ceiling (the real SQLite bottleneck)

`smoke.js` is read-only. The thing most likely to break under a spike is
**write contention** — SQLite has a single writer, so concurrent posts/likes/
follows/DMs serialize (and `busy_timeout` is 5s before a write errors).

Do **not** load-test writes against production — it pollutes the DB and can
trigger the very outage you're testing for. Instead:
- Stand up a **staging** deploy with a *copy* of the prod DB, or
- Run locally against a representative-sized DB copy,

then use a write-path script (signup → post → react → follow in a loop). Ask
and I'll add `loadtest/write.js` for a staging target.

## Interpreting results

| Signal | Meaning |
|---|---|
| `http_req_duration p(95)` rising with VUs | approaching capacity |
| `http_req_failed` > 0 (non-429) | server erroring under load — you found the ceiling |
| lots of 429s | rate limiter engaged (expected on single-IP prod runs) |
| p95 flat as VUs climb | headroom remaining |

The number you want in hand before launch: **peak concurrent users at which p95
stays acceptable and errors stay ~0.** If that number is below what a launch
spike could bring, that's your signal to move images to a CDN and/or migrate to
Postgres (see the scaling ladder discussed with the team).
