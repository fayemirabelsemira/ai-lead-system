# AI Lead Qualification + Instant Response System

An AI-assisted lead management system for small businesses in the Philippines.
The AI analyzes and drafts replies. The business owner always approves before
anything is sent to a customer.

## Status
Working today: database schema (migrations 001-008), AI qualification module,
Telegram approval bot (approve / edit / reject / view).
Not built yet: form/webhook intake, saving AI analyses, job worker, email
delivery (Resend), delivery webhooks, follow-ups, dashboard, test form.

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
3. Run every file in supabase/migrations/ in order (001 -> 008) in the
   Supabase SQL Editor. 008 is safe to re-run.

## Running the backend
    cd backend
    npm install
    npm test            # offline tests, no keys needed
    npm run dev         # Telegram bot, reads ../.env
    npm run send-card -- <lead-uuid>
    npm run test-ai     # calls the real Groq API (uses tokens)

In production, set the environment variables on the host (no .env file)
and run `npm start`. Run exactly ONE bot instance: Telegram long polling
does not support two processes with the same bot token.
