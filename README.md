# AI Lead Qualification + Instant Response System

An AI-assisted lead management system for small businesses in the Philippines.
The AI analyzes and drafts replies. The business owner always approves before
anything is sent to a customer.

## Status
Working today: database schema (migrations 001-011), website-form intake API,
job worker (AI analysis -> Telegram card), Telegram approval bot
(approve / edit / reject / view), copy-and-send delivery (the owner copies
the approved reply, sends it by SMS/Viber/Messenger/email, taps "I sent it"),
automatic email from the owner's Gmail (optional, per business; failures
fall back to copy-and-send), customer form page at /f/<form id>,
`add-business` onboarding script.
Not built yet: approval-expiry sweep, follow-ups, Tally/generic webhooks,
dashboard, Resend (custom-domain email).

## Folder structure
- backend/            API, webhooks, AI wrapper, business logic
- dashboard/          business dashboard (frontend)
- n8n/                automation engine setup (no credentials)
- supabase/migrations/ SQL files, run manually in the Supabase SQL Editor
- form/               the customer inquiry form page (served at /f/<form id>)
- docs/               architecture and runbooks

## Setup
1. Copy .env.example to .env
2. Fill in real values (never commit .env)
3. Run every file in supabase/migrations/ in order (001 -> 011) in the
   Supabase SQL Editor. 008-011 are safe to re-run.
   On a production database, skip 006 (test data).

## Running the backend
    cd backend
    npm install
    npm test            # offline tests, no keys needed
    npm run dev         # bot + job worker + HTTP API, reads ../.env
    npm run add-business -- business.json    # add/update a business + form link
    npm run add-business -- --show-ids       # Telegram ids already in the database
    npm run create-form -- <business-uuid>   # prints a business's form link
    npm run send-card -- <lead-uuid>
    npm run email -- test <your-email>       # check Gmail settings
    npm run email -- on|off <business-uuid>  # automatic email per business
    npm run test-ai     # calls the real Groq API (uses tokens)

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

`npm run dev` prints every form link. Open it, send an inquiry, and it arrives
in Telegram as a card. The form page shows a "Development server" note
unless NODE_ENV=production.

In production, set the environment variables on the host (no .env file),
set NODE_ENV=production and PUBLIC_BASE_URL (the address customers use),
and run `npm start`.
Health check: GET /health. Run exactly ONE bot instance: Telegram long polling
does not support two processes with the same bot token.
