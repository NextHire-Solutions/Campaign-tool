# Instantly API v2 — what was verified before building

Docs: **https://developer.instantly.ai** · index `llms.txt` · OpenAPI at
`/api-reference/openapi.json` (1.5 MB, 124 paths, 167 operations — saved as
`docs/instantly-openapi.json`). **Read these before probing.** On EmailBison,
guessing route names cost hours and still got the wrong answer.

Base `https://api.instantly.ai/api/v2` · `Authorization: Bearer <key>`.
The key is a **v2** key: v1 (`/api/v1/*`) rejects it with `ERR_AUTH_FAILED`.

## The workspace ("Client Facing"), measured 2026-09-09

| | Instantly | EmailBison |
|---|---|---|
| Campaigns | **317** | 180 |
| Inboxes / accounts | 536 | 1,496 |
| Emails sent | **840,416** | ~435,000 |
| Replies | **22,685** (18,790 unique) | ~5,700 |
| Bounced | 9,445 | ~6,500 |
| Auto-replies | 954 | — |

Instantly is the **larger half of the operation** by sends and replies, and none
of it reached the dashboard before this work.

## Rate limits — one endpoint is special

- Workspace-wide: **100 requests/second, 6,000/minute**, shared across v1 and v2
  and across every API key. 429 on breach.
- **`GET /emails` is capped at 20 requests/minute.** At 100 rows per page and
  22,685 replies that is 227 pages ≈ **11+ minutes** for a full walk. The reply
  sync must be incremental and paced; everything else has ample headroom.

## Pagination

`?limit=N&starting_after=<last id>`; the response carries `next_starting_after`.

- **`limit` maxes at 100.** 200 and above return **400**, not a clamped page.
- Verified stable: two identical walks of `/campaigns` returned the same 317 ids
  in the same order, zero duplicates.

## Analytics — better shaped than EmailBison's

| Endpoint | What it gives |
|---|---|
| `GET /campaigns/analytics` | **per-campaign metrics in ONE call** — sent, contacted, replies, bounced, opens, clicks, completed, opportunities |
| `GET /campaigns/analytics?start_date&end_date` | the same, windowed; returns **only campaigns active in the window** (18 of 317 for 1–9 Sept) |
| `GET /campaigns/analytics/daily` | a true per-day series: date, sent, contacted, opened, replies, unique_replies, clicks, opportunities |
| `GET /campaigns/analytics/overview` | workspace totals |

**Internally consistent**, checked both ways: per-campaign daily summed to that
campaign's ranged total (942 = 942), and the workspace daily series summed to the
sum of the ranged per-campaign figures (1,728 = 1,728).

Two traps that look like bugs and are not:

- `?id=X&start_date=…` returns `[]` when campaign X had **no activity in the
  window**. Dormant, not broken — the same applies to the daily endpoint.
- **The daily rows carry no `campaign_id`.** Without the parameter the series is
  workspace-wide; per-campaign needs one call each (317 calls, comfortably
  inside the rate limit).

`open_count` is 0 across the workspace — open tracking is off, exactly as on
EmailBison, so opens must not be presented as a real zero.

## Replies (`GET /emails`)

Fields: `id, timestamp_created, timestamp_email, message_id, subject, body,
eaccount, from_address_email, campaign_id, lead, ue_type, step, i_status,
ai_interest_value, thread_id, content_preview`.

- **`min_timestamp_created` / `max_timestamp_created` (ISO)** — this is what
  makes an incremental, watermarked sync possible despite the 20/min cap.
- Also filterable by `campaign_id`, `eaccount`, `lead`, `email_type`, `i_status`.
- `lead` is the lead's **email address**, not an id.
- `ue_type` observed 1 / 2 / 3; `i_status` and `ai_interest_value` observed
  1 / -1 / absent — Instantly's own interest signal. **Not** the sentiment
  authority here: MasterInbox labels are (see migration 046/048), and mixing a
  second opinion into Positive is what made Positive wrong for months.

## Identity — why parallel tables

Instantly is **UUID-keyed** (campaigns, emails) and accounts are keyed by
**email address**. Our tables are `BIGINT` on EmailBison's integer ids. They
cannot share a primary key, which is why Instantly gets its own tables and the
read layer unions them, rather than a `platform` column on the existing ones.

## Open question: every account reports "Paused" while sending continues

`GET /accounts` documents `status` as **1 Active · 2 Paused · 3 Maintenance ·
-1 Connection Error · -2 Soft Bounce Error · -3 Sending Error**.

All **536** accounts report `status = 2`. Filtering the API by `status=1`
returns nothing and `status=2` returns everything, so the field is
self-consistent — but the workspace sent **786 emails on 2026-09-08** and
**6,139 on 2026-08-31**, and sends have occurred on 38 of the last 59 days.

So "Paused" does not mean what it implies for this workspace. `warmup_status`
is 0 on every account too. Until it is understood, the sync records the raw
status counts and NOTHING derives an "active accounts" figure from them — a
headline of "0 active inboxes" beside 786 sends would be a confident claim the
data next to it contradicts.
