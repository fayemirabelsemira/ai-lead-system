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
fall back to copy-and-send), development test form.
Not built yet: approval-expiry sweep, follow-ups, Tally/generic webhooks,
dashboard, Resend (custom-domain email).

## Folder structure
- backend/            API, webhooks, AI wrapper, business logic
- dashboard/          business dashboard (frontend)
- n8n/                automation engine setup (no credentials)
- supabase/migrations/ SQL files, run manually in the Supabase SQL Editor
- test-form/          custom test form for development
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
    npm run create-form -- <business-uuid>   # prints the form id + test link
    npm run send-card -- <lead-uuid>
    npm run email -- test <your-email>       # check Gmail settings
    npm run email -- on|off <business-uuid>  # automatic email per business
    npm run test-ai     # calls the real Groq API (uses tokens)

In development, open http://localhost:3000/test-form?form=<form id> to
submit a lead. It is analyzed by the AI and arrives in Telegram as a card.

In production, set the environment variables on the host (no .env file),
set NODE_ENV=production (this turns the test form off) and run `npm start`.
Health check: GET /health. Run exactly ONE bot instance: Telegram long polling
does not support two processes with the same bot token.
