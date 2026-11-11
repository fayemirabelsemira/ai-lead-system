# Portfolio demo: public, always-on, free

A public page that lets anyone try the automation: pick a sample business,
send an inquiry, watch the workflow, then approve/edit/reject the reply as the
owner. Files: `showcase/` (the page), `api/analyze.js` (the live AI endpoint),
`vercel.json`.

## What is real and what is simulated
- **Live:** the AI analysis and the safety checks. `api/analyze.js` runs the
  production code in `backend/src/ai/` (same prompt, JSON schema, validation
  and safety rules) on the Groq API.
- **Simulated (and labeled on the page):** the Telegram approval card, sending
  the email, and saving the lead. The demo never touches Supabase, Telegram or
  Gmail, and stores nothing.
- If the AI is not configured, busy or rate-limited, the AI steps switch to a
  rule-based simulation (`showcase/simulate.js`), and the page says so.
- Your real system (`backend/`, the bot, the dashboard) is unchanged and is
  NOT deployed by this.

## Try it on your laptop
```bash
npm run showcase
```
(from the project folder, not `backend/`), then open http://localhost:4321.
It uses `GROQ_API_KEY` and `GROQ_MODEL` from your `.env`.

## Put it online (Vercel, free, no card)
1. **Make a separate Groq key for the demo** (so you can revoke it without
   touching your real system): console.groq.com -> API Keys -> Create API Key,
   name it `portfolio-demo`. On Groq's free plan, heavy traffic hits Groq's
   limits instead of costing money. The demo then shows its simulation.
2. Go to vercel.com -> **Sign Up** -> **Continue with GitHub** -> pick the free
   **Hobby** plan.
3. **Add New... -> Project** -> import `ai-lead-system`.
   - Framework Preset: **Other**. Root Directory: leave as `./`.
   - Leave Build and Output settings alone (`vercel.json` sets them).
4. **Environment Variables** (on the same screen):
   - `GROQ_API_KEY` = the new demo key
   - `GROQ_MODEL` = `openai/gpt-oss-120b` (same as your `.env`)

   Add nothing else: no Supabase, Telegram or Gmail values.
5. **Deploy.** After about a minute you get `https://<name>.vercel.app`.
   Open it: the banner should say **Live AI**.
6. Optional nicer address: Project -> Settings -> Domains -> edit the
   `.vercel.app` name (e.g. `ai-lead-demo.vercel.app`, if free).

From then on, every `git push` to `main` updates the demo automatically.

Limits built in: each visitor gets 6 live tries per 10 minutes (best effort,
per server instance), messages are capped at 600 characters, and the endpoint
refuses calls from other websites' pages.

## Link it from your portfolio
Replace the address with yours.

**A link or button** (simplest, works everywhere):
```html
<a href="https://ai-lead-demo.vercel.app" target="_blank" rel="noopener">Try the live demo</a>
```

**Embedded on your page** (`?embed=1` shows only the interactive part):
```html
<iframe src="https://ai-lead-demo.vercel.app/?embed=1"
        title="AI Lead Automation live demo" loading="lazy"
        style="width:100%; height:1100px; border:0; border-radius:16px;"></iframe>
```
On phones the demo is taller. If your portfolio is narrow, prefer the link.

**Suggested portfolio card text:**
> **AI Lead Qualification & Instant Response**. A multi-tenant automation
> for Philippine small businesses: AI scores each web inquiry, drafts a reply
> in English, Tagalog or Taglish, and blocks made-up facts and prompt
> injection. The owner approves every reply from Telegram. Node.js,
> PostgreSQL/Supabase (row-level security), Groq, Telegram Bot API.
> [Live demo] · [Source]
