# Zendesk Summarizer — Quick Start

Concise, actionable documentation for the backend and the two frontend iframes (Navbar & Sidebar).

## What this project does
- Backend (`backend/server.js`): ingestion, chunking, embeddings (GenAI), Pinecone index management, ticket summarization, and RAG reply composition.
- Navbar iframe (`Navbar/assets/iframe.html`): UI for auto-import (date range) and manual file upload.
- Sidebar iframe (`Sidebar/assets/iframe.html`): ticket summarization and AI reply composer for Zendesk tickets.

## Quick setup & run (local)
1. Create a `.env` file in `backend/` with the required environment variables (below).
2. From the repo root run:

```bash
# start backend
node backend/server.js
```

Default backend URL used by the iframes: `http://localhost:3000`.

## Required environment variables
- `GEMINI_API_KEY` — required (used by GoogleGenerativeAI for embeddings & generation).
- `PINECONE_API_KEY` — required (used to create/access Pinecone index).
- `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN`, `ZENDESK_DOMAIN` — optional but required for `/auto-import-tickets` to fetch real Zendesk tickets.

## Key constants & limits
- Pinecone index name: `zendesk-kb` (embedding dimension enforced to 768).
- Multer upload limit: 10 MB (file uploads). Internal extractor rejects parsing files > 5 MB.
- Supported upload types in UI: `.txt, .md, .csv, .json`.
- Rate-limiting in code: 1s between Zendesk paged requests; 500ms between ticket enrichments.

## Short API reference (most-used)

- GET `/health`
  - Returns: `{ status: 'ok', timestamp }`

- POST `/auto-import-tickets`
  - Body: `{ startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }`
  - Action: fetches Zendesk tickets in range, enriches with comments, chunks, embeds, upserts to Pinecone.
  - Response: `{ status, ticketsProcessed, totalChunks, processingTime, dateRange }`

- POST `/import-file` (multipart/form-data)
  - Form field: `file` (single file)
  - Action: parse file (JSON ticket exports or text), chunk, embed, upsert to Pinecone.
  - Response: success object with `fileName`, `type` and counts.

- POST `/summarize`
  - Body: ticket payload (must include `ticketId`, plus `subject`, `description`, `customFields` etc.)
  - Action: generates a short AI summary.
  - Response: `{ summary, ticketId }`

- POST `/compose-reply`
  - Body: ticket fields including `subject`, `description`, optional `tone` (e.g., `professional`).
  - Action: queries Pinecone for top KB chunks, generates a reply (RAG).
  - Response: `{ ticketId, reply, sources: [{ title, type, score }] }`

- POST `/ingest-kb`
  - Body: `{ articles: [ { id?, title?, content?, metadata? } ] }`
  - Action: batch ingest articles to Pinecone.

- POST `/debug-search`
  - Body: `{ query: '...' }` — returns Pinecone matches for quick testing.

- GET `/index-stats` — returns Pinecone index stats.
- DELETE `/reset-kb` — deletes all vectors (keeps index).
- DELETE `/force-delete-index` — deletes the entire Pinecone index (restart server to recreate).

## File processing & chunking (summary)
- JSON ticket exports are parsed into tickets via `extractTicketsFromJSON`.
- `chunkTicketData(ticket)` creates small chunks: `ticket_overview`, `conversation`, and `resolution` (if present).
- Embeddings created by `embedText(text)` using the generative model `text-embedding-004`.

## Frontend integration (what each iframe calls)
- `Navbar/assets/iframe.html`
  - Calls: POST `/auto-import-tickets` (JSON `{ startDate, endDate }`) and POST `/import-file` (multipart upload `file`).
  - Expects backend at `http://localhost:3000` (variable `BACKEND_URL` in file).

- `Sidebar/assets/iframe.html`
  - Calls: POST `/summarize` (full ticket payload) and POST `/compose-reply` (ticket + `tone`). Also checks `/health` on load.
  - Uses Zendesk App Framework to collect ticket data before POSTing.

## Troubleshooting (short)
- Missing Zendesk creds: `/auto-import-tickets` will not work — add `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN`, `ZENDESK_DOMAIN`.
- Dimension mismatch in Pinecone: call DELETE `/force-delete-index` then restart server to recreate with dimension 768.
- Upload failures: check file size (10MB multer limit; 5MB parsing limit) and file type.
- Backend unreachable from iframe: ensure backend is running and accessible at `BACKEND_URL`.

## Where to look in the repo
- `backend/server.js` — main server logic, endpoints, Pinecone and GenAI usage.
- `Navbar/assets/iframe.html` — navbar UI for import/upload.
- `Sidebar/assets/iframe.html` — sidebar UI for summarize/compose reply.

---
If you want, I can also add a few one-line `curl` examples for the most important endpoints or create a `README` in `backend/` with env var examples — tell me which you prefer.
