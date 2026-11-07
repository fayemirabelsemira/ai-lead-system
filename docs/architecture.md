# Architecture

## Principle
AI assists. The business owner approves. Nothing is sent to a customer
without human approval. n8n orchestrates; the backend enforces security
and business rules.

## Layers
| Layer         | Technology                 | Responsibility                                      |
|---------------|----------------------------|-----------------------------------------------------|
| Frontend      | Dashboard (Cloudflare)     | Business dashboard and onboarding                   |
| Backend       | Node.js (TypeScript)       | Auth, validation, authorization, business logic     |
| AI engine     | Groq (swappable wrapper)   | Lead analysis, scoring, intent, reply drafts        |
| Database      | Supabase / PostgreSQL      | Data storage, RLS tenant isolation                  |
| Automation    | n8n (Docker)               | Scheduling, retries, job orchestration              |
| Communication | Telegram + Resend email    | Owner approvals, customer delivery                  |

## Lead flow
1. Customer submits a form (custom / Tally / generic webhook)
2. Backend validates, verifies the webhook, resolves the business, dedupes, saves the lead
3. A job is queued; n8n triggers analysis
4. Groq returns structured JSON; the backend validates it and saves it
5. Telegram sends the owner an approval request
6. Owner approves / edits / rejects; backend checks user ID, token, version, expiry
7. Approved message goes to an outbox, then to Resend (idempotent)
8. Delivery webhooks update message status
9. Follow-up scheduler checks all conditions, then asks the owner for approval again

## Security rules
- Secrets only in .env (never committed, never in frontend code)
- Service-role key is server-side only
- Tenant isolation via RLS plus server-side checks
- Customer text is untrusted input; the AI has no database or tool access
- Webhooks: signature checks, event IDs, idempotency
- Telegram approvals: allowlisted user IDs, expiring tokens, message versioning

## Known limitations
- Groq, Supabase, and Resend free tiers have limits and may change
- Email needs a verified domain to reach real customers
- Phone-only leads need a manual "copy and send" flow in the MVP
- Local n8n needs a tunnel to receive public webhooks during development
- Production needs an always-on host
