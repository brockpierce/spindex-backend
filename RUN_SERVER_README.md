# Running the real server

This makes the app talk to a real database instead of fake data. Here's
the whole process, step by step.

## 1. One-time setup

Open a terminal, go to the `backend` folder, and run:

```
cd backend
npm install
cp .env.example .env
npx prisma migrate dev --name init
```

What each line does:
- `npm install` -- downloads all the code libraries the server needs
- `cp .env.example .env` -- copies the settings file so the server knows
  where to put its database
- `npx prisma migrate dev --name init` -- actually creates the database
  file (`dev.db`) with all the right tables in it

## 2. Start the server

```
npm run dev
```

You should see:
```
Server running at http://localhost:3001
```

Leave this terminal window open and running -- closing it stops the
server. While it's running, your app can talk to it.

## 3. Get some albums into it

If you haven't already, follow `IMPORT_README.md` to pull real albums in
from MusicBrainz. You can do this anytime, even while the server above
is running in a different terminal window.

## 4. Try it

With the server running, open a second terminal and run:

```
curl http://localhost:3001/api/health
```

You should see `{"ok":true}`. That confirms the server is alive and
answering requests.

To see real albums (assuming you've run the import):

```
curl http://localhost:3001/api/albums
```

## What's still missing

This server can now answer every question the app needs to ask --
albums, reviews, lists, follows, the home feed, all of it. What's not
done yet is updating the actual app screens (the demo) to ask this
server these questions instead of using the hardcoded fake data. That's
a separate, follow-up piece of work -- swapping each screen's fake array
for a real network request. Let me know when you want to tackle that
and we'll go through it one screen at a time.

## Common problems

**"Cannot find module '@prisma/client'"** -- you skipped `npm install`,
or it failed partway. Run it again and watch for red error text.

**"command not found: npx"** -- Node.js isn't installed, or your
terminal can't find it. Run `node --version` to check; if that also
fails, you need to install Node.js first (nodejs.org).

**Server starts but every request says "logged in" errors** -- that's
expected for most routes until you actually sign up a user through
`/api/auth/signup`. Most of the app's features require being logged in,
same as the real Letterboxd or any social app.
