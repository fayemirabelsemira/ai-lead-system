# AI Lead Qualification + Instant Response System

An AI-assisted lead management system for small businesses in the Philippines.
The AI analyzes and drafts replies. The business owner always approves before
anything is sent to a customer.

## Status
Phase 1: project foundation (in progress)

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
