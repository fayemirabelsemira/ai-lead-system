# AI Lead Qualification + Instant Response System

An AI-assisted lead management system for small businesses in the Philippines.
The AI analyzes and drafts replies. The business owner always approves before
anything is sent to a customer.

## Status
Working today: database schema (migrations 001-013), website-form intake API,
job worker (AI analysis -> Telegram card), Telegram approval bot
(approve / edit / reject / view), copy-and-send delivery (the owner copies
the approved reply, sends it by SMS/Viber/Messenger/email, taps "I sent it"),
automatic email from the owner's Gmail (optional, per business; failures
fall back to copy-and-send), customer form page at /f/<form id>,
`add-business` onboarding script, crash recovery (stuck jobs and emails,
undelivered cards, approval expiry), owner dashboard at /app (approve/edit
replies, outcome and notes).
Not built yet: follow-ups, Tally/generic webhooks, Resend (custom-domain email).

## Folder structure
- backend/            API, webhooks, AI wrapper, business logic
- dashboard/          owner dashboard (served at /app)
- n8n/                automation engine setup (no credentials)
- supabase/migrations/ SQL files, run manually in the Supabase SQL Editor
- form/               the customer inquiry form page (served at /f/<form id>)
- deploy/             server setup (Oracle Cloud / any Ubuntu server)
- docs/               architecture, deployment guide
- showcase/, api/     public portfolio demo (Vercel); see docs/portfolio-demo.md

## Setup
1. Copy .env.example to .env
2. Fill in real values (never commit .env)
3. Run every file in supabase/migrations/ in order (001 -> 013) in the
   Supabase SQL Editor. 008-013 are safe to re-run.
   On a production database, skip 006 (test data).

## Running the backend
    cd backend
    npm install
    npm test            # offline tests, no keys needed
    npm run dev         # bot + job worker + HTTP API, reads ../.env
    npm run demo        # same, plus a free public HTTPS link (Cloudflare quick tunnel)
    npm run add-business -- business.json    # add/update a business + form link
    npm run add-business -- --show-ids       # Telegram ids already in the database
    npm run create-form -- <business-uuid>   # prints a business's form link
    npm run send-card -- <lead-uuid>
    npm run email -- test <your-email>       # check Gmail settings
    npm run email -- on|off <business-uuid>  # automatic email per business
    npm run test-ai     # calls the real Groq API (uses tokens)

## Portfolio demo
A public, always-on demo page (live AI + clearly labeled simulated
approval/sending), deployable free on Vercel. Locally: `npm run showcase`
from the project root. Setup and embedding: docs/portfolio-demo.md.

## Adding your business
1. `cp business.example.json business.json` (inside backend/; business.json
   is not committed because it holds the owner's contact details).
2. Fill it in. The AI answers ONLY from description, services, pricing,
   faq answers and operating_hours, so write what you want it to say.
   Every REPLACE_ME must go. For the Telegram ids run
   `npm run add-business -- --show-ids`; in a private chat with the bot the
   chat id is the same number as your user id.
3. `npm run add-business -- business.json`. It shows what it will change and
   asks first. If your Telegram chat belongs to a "[TEST] ..." sample
   business, that sample is switched off (its data is kept) and the chat
   moves to your business.
4. To change the info later, edit business.json and run it again: the
   business is matched by its Telegram chat.

## Dashboard
`npm run dev` / `npm run demo` print `Dashboard: <address>/app`. Business owners
sign in with a code emailed by Supabase (no password; only existing owner
accounts can sign in). White by default, with a dark-mode switch (remembered
per browser). It shows inquiries per day, lead quality, reply speed, deals won,
what needs attention, and every lead with search and filters.

On a lead, the owner can do what the Telegram card does:
- approve the AI's reply as is, or edit it first, or reject it
- write a reply when the AI did not draft one (or the draft was rejected/expired)
- copy a copy-and-send reply and mark "I sent it"
- set the outcome (Open / Won / Lost / Not interested) and keep private notes

Approved replies go out the same way as from Telegram (email if it is on for
the business, otherwise copy-and-send). Whichever is used first wins: the
other one then says the reply was already handled. The actions are database
functions in migration 013 that check the signed-in owner's role; database
rules (RLS) make sure an owner only ever sees their own business. It needs
SUPABASE_PUBLISHABLE_KEY and migration 013.

One-time Supabase settings (Authentication section):
- Emails -> Templates -> **Magic Link**: add the code to the email, e.g.
  `<p>Your sign-in code: <strong>{{ .Token }}</strong></p>`
- URL Configuration -> Redirect URLs: add `http://localhost:3000/app` and
  `https://*.trycloudflare.com/app` (so the link in the email also works).
Supabase's built-in email allows only a few emails per hour; sessions last,
so you rarely need a new code.

## Crash recovery
Every minute (and right after start) the backend checks for interrupted work:
- a job stuck for 10+ minutes is retried; out of attempts, you get a
  "NEEDS HUMAN REVIEW" message in Telegram
- a card that never reached Telegram is cancelled and sent again
- an approval nobody answered before it expired (business_settings
  approval_expiry_hours, default 24) is closed; you get the unsent text
- an email interrupted while sending is NEVER resent automatically (it may
  have gone out): you are asked to check Gmail "Sent" and get an
  "I sent it" button

`npm run dev` prints every form link. Open it, send an inquiry, and it arrives
in Telegram as a card. The form page shows a "Development server" note
unless NODE_ENV=production.

## Demo from your laptop (free, no account)
`brew install cloudflared` once, then stop `npm run dev` and run `npm run demo`.
It opens a Cloudflare quick tunnel, starts the backend with that address, and
prints a public form link like https://random-words.trycloudflare.com/f/<id>
that works on any phone. The link works only while `npm run demo` runs and
changes every time it starts. Ctrl+C stops both.

Putting it online on a free Oracle Cloud server: see docs/deploy-oracle.md
(scripts in deploy/).

In production, set the environment variables on the host (no .env file),
set NODE_ENV=production and PUBLIC_BASE_URL (the address customers use),
and run `npm start`.
Health check: GET /health. Run exactly ONE bot instance: Telegram long polling
does not support two processes with the same bot token.
