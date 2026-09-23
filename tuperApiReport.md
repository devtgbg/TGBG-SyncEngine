# Tuper against Zuper: records, API and webhooks

*Second pass, 23 September 2026. Read-only, against production on both sides: `api.tuper.golfbuggyguy.com` (commit `279c4ae`, deployed 09:45 Dubai) and Zuper (`eks-ap-south-1.zuperpro.com`). The first pass is kept as `tuperApiReport-2026-09-22.md`.*

Three questions, three tools:

1. **Does Tuper hold the same records?** `npm run compare` across all ten kinds, record by record.
2. **Do the two APIs answer the same?** All 169 read endpoints asked of both with the same ids and filters, plus `npm run compare:fields` on a sample of real records per kind.
3. **Do the webhooks match?** Every module's event catalogue on both sides, what is registered on each, and the real deliveries each system has sent, compared key by key.

## Verdict

Most of what the first pass found is fixed. Records are in step, and the API answers Zuper's shape almost everywhere.

| Measure | 22 Sep | 23 Sep |
|---|---|---|
| Endpoints where Tuper returns every field Zuper does | 27 | **46** |
| Median field coverage | 94% | **100%** |
| Median value agreement on the same record | 87% | **98%** |
| Value differences across the compared records | 369 | **129** (109 setting aside Zuper's `_id`, `__v`, `id`) |
| Endpoints answering in a different shape | 6 | **0** |
| Records missing from Tuper | — | **0, in all ten kinds** |

It is not, however, all shape-level. Setting aside Zuper's internal ids, its revision counter, timestamps and re-hosted pictures, **about a dozen substantive items remain** — the largest being a job's `parent_job`, the asset activity log, and the team each assignee is listed under. And on the webhook side, **283 of Tuper's 419 deliveries in the last 30 days failed** because the body carries no record id.

## 1. Records: does Tuper hold what Zuper holds?

`npm run compare`, all ten kinds, read-only, 13 minutes.

| Kind | In Zuper | In Tuper | Missing | Behind | Held by Tuper, not listed by Zuper |
|---|---|---|---|---|---|
| Jobs | 47,032 | 49,156 | 0 | 1* | 2,115 (2,109 flagged deleted, 6 live*) |
| Customers | 4,712 | 4,765 | 0 | 0 | 53, all flagged deleted |
| Organizations | 1,013 | 1,016 | 0 | 0 | 3, all flagged deleted |
| Users | 38 | 61 | 0 | 0 | 7 (6 flagged deleted, 1 live*) |
| Assets | 2,268 | 2,268 | 0 | 0 | 0 |
| Parts and services | 2,074 | 2,092 | 0 | 0 | 18, all flagged deleted |
| Contracts | 1 | 1 | 0 | 0 | 0 |
| Requests | 8 | 8 | 0 | 0 | 0 |
| Quotes | 35 | 35 | 0 | 0 | 0 |
| Invoices | 13 | 13 | 0 | 0 | 0 |

\* Every outlier was retried against Zuper directly, and each answered on the first attempt:

- **The 6 "live" jobs** (work orders 54978–54983) exist in **both** systems and are not deleted. They were created while the compare was walking Zuper's list month by month, so that pass never saw them. Not a gap.
- **The 1 job "behind"** (54727): Zuper last changed it at 06:28, Tuper wrote it at 06:47. Tuper's copy is the newer one. Not a gap.
- **The 1 live user** is a real difference — see below.

**So: nothing is missing, and nothing is genuinely behind.** The Tuper-only records are ones Zuper's lists no longer return, already flagged deleted in Tuper, which is what the sync is supposed to do.

One user does differ. The same Zuper uid (same email, same employee code, same role) is **deleted and inactive in Zuper** and **active in Tuper**, and the name differs: Zuper has "Chalana Sameera Jayarathna", Tuper has "Chalana Dommanige". The deletion never reached Tuper, and the name is stale.

Transient errors seen during the run were Zuper's, not Tuper's: 329 × 404 (records asked for by uid that Zuper no longer has) and 6 × `ECONNRESET`, all of which succeeded on retry.

## 2. The API, endpoint by endpoint

169 read endpoints; 109 answered on both sides (29 of those have no records on either side), 39 could not be tested because neither system holds a record of that kind, 16 are paths Zuper's own server does not serve, and 2 refuse on Tuper.

### Fixed since the first pass

Every endpoint that answered in a different shape now answers in Zuper's:

| Endpoint | Was | Now |
|---|---|---|
| `GET /api/jobs/{uid}/finance/stats` | no field in common | 100% |
| `GET /api/misc/{module}/events` | flat list instead of `{module, module_name, events[]}` | 100% |
| `GET /service/notifications/webhook_history` | flattened, 18% | 100% |
| `GET /api/team` | paged 10 at a time, no members, 30% | 100%, all 11 teams in one answer |
| `GET /api/jobs/{uid}/timelog_summary` | object where Zuper sends `[]` | matches |
| `GET /api/timesheet/master_shifts/{uid}` | 85% | 100% |

And the large gaps closed: `/api/notes` 0% → 98% (it now answers without a filter), the four summaries 49–67% → 100%, `/api/jobs/category` 32% → 100%, `/api/products/category` 19% → 96%, `/api/invoice/{uid}` 78% → 99%, `/api/service_contract/{uid}` 74% → 100%, `/api/estimate/{uid}` 83% → 100%, `/api/recurring_jobs` 72% → 100%, `/api/jobs/template/{uid}` 39% → 98%.

28 kinds of value difference disappeared entirely, including the ones that would have misled a caller: the work-order prefix, `is_expired`, invoice dates shifted by the Dubai offset, `acceptance_status` (`AWAIT_RESPONSE` vs `PENDING`), `due_date_dt` off by a day, and lower-cased emails.

### What is still missing

Excluding Zuper's own `_id`, `__v` and `id`, 98 field paths are still absent from Tuper's answers, concentrated in six places:

| Endpoint | Missing | What |
|---|---|---|
| `GET /api/jobs/{uid}` | 34 | **`parent_job` is `null`** where Zuper returns the parent job (23 of these fields). Also `customer.customer_category`, `customer_address.property_id`, `assigned_to[].user.user_meta_data.burden_rate`, and `external_id.hubspot_ticket` / `hubspot_deal` |
| `GET /api/assets/{uid}/summary` | 24 | the whole **`transactions.activity`** block: Zuper has 3 recent activities, Tuper reports 0 and `latest_transaction` empty |
| `GET /api/assets/{uid}` | 9 | **`billing_address` is `{}`** where Zuper returns the full address; `useful_life.type` |
| `GET /api/timesheets/summary` | 8 | **`timesheet_data[].timesheets[]` is empty** where Zuper lists each day worked (`date, shift_start, shift_end, total_work_time, total_break_time, total_over_time, check_in_time, check_out_time`) |
| `GET /api/assisted_scheduling` | 6 | **`availability[].slots[]` is empty** (Zuper returns 9 slots with `start_time`, `end_time`, `users_available`, `users[]`); the user list is 25 against Zuper's 37 |
| `GET /api/jobs/status/{categoryUid}` | 3 | `is_deleted`, `created_at`, `updated_at` |
| `GET /api/product/transaction`, `/api/assets/template` | 3 each | `module_uid` and `from_location` on a transaction; the category's dates and description on a template |

### What still answers a different value

109 value differences remain once Zuper's internals are set aside. By cause:

| Cause | Count | Comment |
|---|---|---|
| Timestamps on imported rows (`created_at`, `updated_at`, `last_login_at`, `assigned_at`, `synced_at`) | ~23 | Tuper's own write times, usually seconds or minutes apart. Largely cosmetic, but `updated_at` still means "when Tuper wrote it" |
| Re-hosted images (`profile_picture`, `asset_image`) | ~21 | Zuper's S3 URL against Tuper's Supabase copy, or `null` |
| Child-record ids (`line_item_uid`, `payment_term_uid`, `billing_period_uid`, `status_history_uid`) | ~8 | Tuper's own uuids for records that came from Zuper |
| **The team each assignee is listed under** | 6 | Zuper: both assignees in "JGE Techs". Tuper: "JGE All" and "Expo City Dubai Techs" |
| **A line item's stock location** | 4 | On one invoice, Zuper says "JGE Workshop", Tuper says "Agronomy Center" |
| **A contract's product line** | 3 | `product_id` "SERAMCJGE1" vs "AMCJGE SERAMCJGE1", `prefix` "AMCJGE" vs "", `quantity` 0 vs 1 |
| Links to the record (`public_url`, `payment_url`) | 3 | Tuper's own host, or `null` for Zuper's payment link |
| Remainder | ~41 | `gallery.is_enabled`, `actual_duration` 0 vs `null`, geo points (`[0,0]` vs `[]`), status snapshots, `company_id`, `group_type` |

`GET /api/attachments/group` deserves its own line: both systems now sort oldest first, but Zuper's first group is 1 August 2021 and Tuper's is 10 August 2021, so Tuper's gallery does not have the earliest attachments.

### Endpoints that still refuse on Tuper

Both are records Tuper never received, not code faults: `GET /api/assets/template/{uid}` (an asset template) and `GET /api/product/transaction/{uid}` (a 2023 stock transaction).

### Lists under filters and paging

Everything an application actually sends now agrees:

| Query | Result |
|---|---|
| Jobs: 100 a page, page 3, `sort=ASC`, by work order, customer, status, category, assigned user, priority | identical records, in identical order |
| Customers: page 1 and page 5 | identical, in order (the default order was completely different before) |
| Organizations, quotes, requests, contracts, parts, teams | identical, in order |
| Deleted customers | Zuper 51, Tuper 59 — the 4,407 phantom deletions are gone |
| Deleted jobs | Zuper 2,110, Tuper 2,120 |
| Keyword search on jobs | Zuper 20,852, Tuper 22,234; 83 of the first 100 shared — Tuper matches on more than Zuper does |
| Jobs scheduled in a 7-day window | Zuper 659, Tuper 561 |
| `filter.updated_at_from` alone | Zuper **ignores** it (returns all 47,047) unless `updated_at_to` is given too; Tuper applies it. With both bounds: Zuper 181, Tuper 231 |

The last two are the only query behaviours left that differ, and the `updated_at` one follows from Tuper's `updated_at` being its own write time.

## 3. Field parity on real records (`compare:fields`)

12 records per kind — the newest from Zuper's own list plus a random draw from everything Tuper has mapped — each asked of both systems and compared field by field. Zupersync refuses to call a difference where the comparison cannot settle it (an id each system may legitimately answer differently, a date against a timestamp, array records with no uid to pair by); those are reported separately.

**184 fields disagree across 12 kinds; 696 could not be settled.** No record failed to answer, and none was missing from either side.

| Class | Count | Does it break a Zuper client? |
|---|---|---|
| `extra_in_tuper` — Tuper sends a field Zuper does not | 83 | No |
| `value` — both send it, the values differ | 74 | Depends; see above |
| `missing_in_tuper` | 23 | 19 of them are Zuper's `_id` / `__v` |
| `array_length`, `element_missing` | 4 | Yes, where the records differ |

Setting aside extras, Zuper's internals, timestamps and pictures, **56 substantive differences remain**. The three most frequent, all flagged by the tool as having no known cause:

| Kind | Field | How often | Zuper | Tuper |
|---|---|---|---|---|
| Requests | `organization.is_active` | 7 of 8 | absent | `true` |
| Invoices | `customer.customer_all_addresses[]` | 7 of 10 | 2 addresses | 0 |
| Invoices | `line_items[].product_ref_id.location_availability[].min_quantity` | 7 of 10 | `null` | `0` |

The report with every field and real examples is `scratchpad/apitest/FIELD-PARITY.md`.

## 4. Webhooks, 1:1

### The catalogue: identical

Both systems offer the same 15 modules and the same **236 events**, with no event on one side missing from the other:

`ASSETS` 17 · `CUSTOMER` 15 · `ESTIMATES` 13 · `INVOICE` 19 · `JOB` 35 · `ORGANIZATION` 10 · `PRODUCTS` 12 · `PROJECT` 22 · `PROPERTY` 11 · `PURCHASE_ORDER` 6 · `REQUEST` 8 · `SERVICE_CONTRACTS` 11 · `TEAM` 5 · `TIMESHEET` 36 · `USER` 16

(`GET /api/misc/modules` is served by Tuper and not by Zuper, so the module list itself could only be read from Tuper.)

### What is registered

| | Registered | To Zupersync | Elsewhere | Inactive |
|---|---|---|---|---|
| Zuper | 236 | 138 | 98 (68 external, 30 to other TGBG services) | 0 |
| Tuper | 10 | 10 | 0 | 0 |

Zupersync acts on 188 Zuper events, of which **59 are not registered in Zuper** — mostly modules GBG does not use (22 project, 5 purchase order, 5 team) plus attachment and timesheet-approval events. Nothing is registered that Zupersync ignores.

### What the deliveries look like

Comparing the real bodies both systems have sent for the same event, from Zupersync's own store:

| Event | Zuper keys | Tuper keys | Shared | Tuper carries the record id | Result |
|---|---|---|---|---|---|
| `job.assign_users` | 25 | 28 | 25 | yes | **every Zuper key present**; Tuper adds 3 |
| `job.unassign_users` | 25 | 28 | 25 | yes | **every Zuper key present** |
| `job.status_update` | 42 | 48 | 42 | yes | **every Zuper key present**; Tuper adds remarks, time on status, signature |
| `job.update_schedule` | — | — | — | yes | applied cleanly (5 of 5) |
| `job.update` | 246 | 92 / 23 | — | only when the customer changed | two shapes, see below |
| `job.new` | 232 | 40 | 34 | **no** | 121 deliveries, all failed |
| `job.delete` | 19 | 22 | 19 | **no** (`job_uid: null`) | 42 deliveries, all failed |
| `customer.create` | 35 | 21 | 18 | **no** | 40 deliveries, all failed |
| `customer.update` | 25 | 21 | 18 | **no** | 55 deliveries, all failed |
| `customer.delete` | — | — | — | **no** | 25 deliveries, all failed |

**283 of Tuper's 419 deliveries in the last 30 days failed**, every one for the same reason: no record id in the body.

- `job.new` sends `id: null`, `_id: null` and no `job_uid` at all — 40 keys against Zuper's 232.
- `job.delete` sends `job_uid: null`.
- `customer.create`, `customer.update` and `customer.delete` send no `customer_uid`.
- `job.update` arrives in two shapes: when the customer changed it carries the whole job and its `job_uid` (8 deliveries, all applied); for a title, category, priority or schedule change it carries a 23-key stub with no `job_uid` (34 deliveries, all failed).

The four events that do carry the id are applied cleanly, and their payloads match Zuper's field for field. So this is not the module naming alone: **the payload builder omits the record for those five events and for most `job.update` paths.**

Tuper's 10 webhooks are still registered under the modules `JOBS` and `CUSTOMERS`, where Tuper's own catalogue names them `JOB` and `CUSTOMER`. Worth correcting either way, but the evidence above shows the body is built without the record even for a module Tuper knows.

## 5. Speed

Measured while a bulk import was writing to Tuper at roughly 3,600 calls a minute, so these are worse than Tuper's quiet-time figures; the first pass's numbers are the fairer baseline.

Median over the endpoints both answered: Zuper 303 ms, Tuper 298 ms. Under that load Tuper stayed slower on the heaviest reads (job lists 0.9–4.0 s against Zuper's 0.4–0.6 s), and faster on searches (customer keyword 0.17 s against Zuper's 3.1 s; Zuper took 14.5 s on a job keyword search).

## 6. What remains

In the order I would fix them:

1. **Webhook payloads** — `job.new`, `job.delete`, `customer.create/update/delete`, and `job.update` for every change except the customer, send no record id. Nothing from Tuper reaches Zupersync for those events today. Re-registering the 10 webhooks as `JOB` / `CUSTOMER` is worth doing at the same time.
2. **`parent_job` is `null`** on a job — 23 fields Zuper returns.
3. **An asset's `billing_address` is `{}`**, and the asset summary's `transactions.activity` block is empty where Zuper has entries.
4. **`/api/timesheets/summary`** returns no daily rows, and **`/api/assisted_scheduling`** returns no slots.
5. **The team each assignee is listed under** differs from Zuper's, on both the job list and a single job.
6. **One deleted user is still active in Tuper**, with a stale name.
7. **Invoice and contract line details**: a wrong stock location on one invoice, and `product_id`, `prefix`, `quantity` on a contract line.
8. **Smaller**: `external_id.hubspot_*` on jobs, `is_deleted`/`created_at`/`updated_at` on a category's statuses, `module_uid` and `from_location` on a stock transaction, the earliest attachment group, `organization.is_active` on requests, `customer_all_addresses` on invoices.

Everything else left is what you chose to leave: Zuper's `_id` and `__v`, its numeric `id`, timestamps that record when Tuper wrote the row, images re-hosted on Tuper's storage, ids Tuper mints for child records, and the extra fields Tuper returns beyond Zuper's answer.

---

## Appendix A: every endpoint

Coverage counts Zuper field paths Tuper also returns. “Left” columns exclude Zuper's own `_id`, `__v` and `id`.

| # | Module | Path | Result | Z total | T total | Coverage | Missing left | Differs left | Z ms | T ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | assets | `/api/assets` | both answer | 2268 | 2269 | 99% | 0 | 3 | 832 | 889 |
| 2 | assets | `/api/assets/template` | both answer |  |  | 77% | 3 |  | 303 | 298 |
| 3 | assets | `/api/assets/template/:templateUid` | **Tuper refuses** (404) |  |  |  |  |  | 321 | 148 |
| 4 | assets | `/api/assets/:uid/history` | both answer, no records | 0 | 0 |  | 0 |  | 330 | 232 |
| 5 | assets | `/api/assets/:uid/summary` | both answer |  |  | 45% | 24 | 2 | 311 | 462 |
| 6 | assets | `/api/imports/asset` | both answer |  |  | 100% |  |  | 466 | 215 |
| 7 | assets | `/api/imports/asset/sample_import` | both answer |  |  | 100% |  |  | 531 | 219 |
| 8 | assets | `/api/assets/inspection_form/:formUid/:fieldUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 9 | assets | `/api/assets/inspection_form/master` | both answer | 3 | 4 | 97% | 0 | 1 | 310 | 311 |
| 10 | assets | `/api/assets/inspection_form` | both answer, no records | 0 | 0 |  | 0 |  | 276 | 381 |
| 11 | assets | `/api/assets/inspection_form/:submissionUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 12 | commissions | `/api/commissions` | both answer, no records | 0 | 0 |  | 0 |  | 295 | 575 |
| 13 | commissions | `/api/commissions/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 14 | communications | `/telephony/calls/:uid/details` | not tested: no record either side |  |  |  |  |  |  |  |
| 15 | communications | `/telephony/calls/:uid/activities` | not tested: no record either side |  |  |  |  |  |  |  |
| 16 | communications | `/telephony/message/conversation/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 17 | customers | `/api/customers` | both answer | 4712 | 4722 | 95% | 1 | 0 | 291 | 884 |
| 18 | customers | `/api/customers/merge` | both refuse |  |  |  |  |  | 279 | 165 |
| 19 | customers | `/api/customers/:uid` | both answer |  |  | 99% | 1 | 0 | 343 | 196 |
| 20 | customers | `/api/customers/:uid/summary` | both answer |  |  | 100% | 0 | 2 | 13373 | 748 |
| 21 | customers | `/api/customers/:uid/attachments` | Tuper only |  |  |  |  |  | 288 | 143 |
| 22 | customers | `/api/customers/:uid/note` | both answer, no records |  | 0 |  | 0 |  | 278 | 538 |
| 23 | customers | `/api/customers/:uid/cards` | Tuper only |  |  |  |  |  | 271 | 241 |
| 24 | documents | `/api/documents` | both answer, no records | 0 | 0 |  | 0 |  | 272 | 185 |
| 25 | documents | `/api/documents/:uid/pdf` | not tested: no record either side |  |  |  |  |  |  |  |
| 26 | documents | `/api/documents/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 27 | invoices | `/api/invoice/payment_mode` | Zuper refuses (404) |  | 0 |  |  |  | 300 | 177 |
| 28 | invoices | `/api/invoice/payment_term` | Zuper refuses (404) |  | 4 |  |  |  | 282 | 334 |
| 29 | invoices | `/api/payments/payment_request` | both answer, no records | 0 | 0 |  | 0 |  | 271 | 378 |
| 30 | invoices | `/api/payments/payment_request/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 31 | invoices | `/api/payments/transactions` | both answer, no records | 0 | 0 |  | 0 |  | 290 | 133 |
| 32 | invoices | `/api/payments/:uid/transactions` | not tested: no record either side |  |  |  |  |  |  |  |
| 33 | invoices | `/api/accounting/credit_notes` | both answer, no records | 0 | 0 |  | 0 |  | 284 | 288 |
| 34 | invoices | `/api/accounting/credit_history` | both answer, no records | 0 | 0 |  | 0 |  | 271 | 261 |
| 35 | invoices | `/api/accounting/credit_notes/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 36 | jobs | `/api/service_tasks` | both answer, no records | 0 | 0 |  | 0 |  | 301 | 106 |
| 37 | jobs | `/api/service_tasks/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 38 | jobs | `/api/appointments` | Zuper refuses (403) |  | 0 |  |  |  | 272 | 132 |
| 39 | jobs | `/api/appointments/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 40 | jobs | `/api/expenses` | both answer, no records | 0 | 0 |  | 0 |  | 285 | 157 |
| 41 | jobs | `/api/expenses/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 42 | jobs | `/api/attachments/folders` | both answer, no records | 0 | 0 |  | 0 |  | 269 | 323 |
| 43 | jobs | `/api/attachments/folders/:uid/share` | not tested: no record either side |  |  |  |  |  |  |  |
| 44 | jobs | `/api/attachments/group` | both answer | 121826 | 118480 | 100% | 0 | 13 | 619 | 1952 |
| 45 | jobs | `/api/comments` | both answer, no records | 0 | 0 |  | 0 |  | 277 | 81 |
| 46 | jobs | `/api/jobs/timelog_summary` | both answer | 2018 | 1997 | 100% | 0 |  | 866 | 766 |
| 47 | measurements | `/api/measurements` | both answer, no records | 0 | 0 |  | 0 |  | 303 | 184 |
| 48 | measurements | `/api/measurements/:uid/details` | not tested: no record either side |  |  |  |  |  |  |  |
| 49 | measurements | `/api/measurements/categories` | both answer, no records |  |  |  | 0 |  | 282 | 108 |
| 50 | measurements | `/api/measurements/providers` | both answer, no records |  |  |  | 0 |  | 271 | 400 |
| 51 | organizations_properties | `/api/organization` | both answer | 1013 | 1013 | 100% | 0 | 0 | 351 | 336 |
| 52 | organizations_properties | `/api/organization/:uid` | both answer |  |  | 100% | 0 | 0 | 284 | 160 |
| 53 | organizations_properties | `/api/organization/:uid/summary` | both answer |  |  | 100% | 0 | 0 | 348 | 256 |
| 54 | organizations_properties | `/api/property` | both answer | 1 | 1 | 100% | 0 | 0 | 305 | 404 |
| 55 | organizations_properties | `/api/property/:uid` | both answer |  |  | 94% | 1 | 0 | 283 | 675 |
| 56 | organizations_properties | `/api/property/:uid/summary` | both answer |  |  | 100% | 0 | 0 | 345 | 279 |
| 57 | parts_services | `/api/product/group` | both answer | 3 | 3 | 100% | 0 | 0 | 305 | 253 |
| 58 | parts_services | `/api/product/group/:uid` | both answer |  |  | 100% | 0 | 1 | 280 | 436 |
| 59 | parts_services | `/api/products/category` | both answer | 2 | 3 | 96% | 0 | 0 | 270 | 255 |
| 60 | parts_services | `/api/product/transaction` | both answer | 773 | 315 | 89% | 3 |  | 301 | 366 |
| 61 | parts_services | `/api/product/transaction/:uid` | **Tuper refuses** (404) |  |  |  |  |  | 279 | 90 |
| 62 | parts_services | `/api/products/transfer_orders` | both answer, no records | 0 | 0 |  | 0 |  | 275 | 186 |
| 63 | parts_services | `/api/products/transfer_orders/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 64 | parts_services | `/api/products/pricelist` | both answer, no records | 0 | 0 |  | 0 |  | 273 | 75 |
| 65 | parts_services | `/api/products/pricelist/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 66 | projects | `/api/projects` | both answer, no records | 0 | 0 |  | 0 |  | 271 | 82 |
| 67 | projects | `/api/projects/status` | Zuper refuses (400) |  |  |  |  |  | 262 | 115 |
| 68 | projects | `/api/projects/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 69 | projects | `/api/projects/:uid/assign` | not tested: no record either side |  |  |  |  |  |  |  |
| 70 | projects | `/api/projects/:uid/jobs` | not tested: no record either side |  |  |  |  |  |  |  |
| 71 | projects | `/api/projects/:uid/milestone` | not tested: no record either side |  |  |  |  |  |  |  |
| 72 | projects | `/api/projects/:uid/phases` | not tested: no record either side |  |  |  |  |  |  |  |
| 73 | projects | `/api/projects/:uid/dependencies` | not tested: no record either side |  |  |  |  |  |  |  |
| 74 | projects | `/api/projects/:uid/finance/stats` | not tested: no record either side |  |  |  |  |  |  |  |
| 75 | projects | `/api/projects/:uid/note` | not tested: no record either side |  |  |  |  |  |  |  |
| 76 | projects | `/api/projects/:uid/timelog` | not tested: no record either side |  |  |  |  |  |  |  |
| 77 | purchase_orders_vendors | `/api/purchase_orders` | both answer, no records | 0 | 0 |  | 0 |  | 301 | 640 |
| 78 | purchase_orders_vendors | `/api/purchase_orders/meta` | both answer |  |  | 100% | 0 | 0 | 305 | 212 |
| 79 | purchase_orders_vendors | `/api/purchase_orders/meta/filter` | both answer |  |  | 100% | 0 | 0 | 325 | 185 |
| 80 | purchase_orders_vendors | `/api/purchase_orders/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 81 | purchase_orders_vendors | `/api/purchase_orders/:uid/note` | not tested: no record either side |  |  |  |  |  |  |  |
| 82 | purchase_orders_vendors | `/api/vendors` | both answer, no records | 0 | 0 |  | 0 |  | 277 | 85 |
| 83 | purchase_orders_vendors | `/api/vendors/meta` | both answer |  |  | 100% | 0 | 0 | 323 | 119 |
| 84 | purchase_orders_vendors | `/api/vendors/meta/filter` | both answer |  |  | 100% | 0 | 0 | 313 | 88 |
| 85 | purchase_orders_vendors | `/api/vendors/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 86 | purchase_orders_vendors | `/api/vendor_catalogs` | both refuse |  |  |  |  |  | 278 | 135 |
| 87 | quotes | `/api/invoice_estimate/package` | both answer, no records | 0 | 0 |  | 0 |  | 281 | 147 |
| 88 | quotes | `/api/invoice_estimate/package/:packageUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 89 | quotes | `/api/invoice_estimate/proposal_template` | both answer, no records | 0 | 0 |  | 0 |  | 273 | 208 |
| 90 | quotes | `/api/invoice_estimate/proposal_template/:templateUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 91 | quotes | `/api/estimate/:uid/deposit` | Tuper only |  |  |  |  |  | 274 | 795 |
| 92 | requests | `/api/request/:uid/assign` | Tuper only |  |  |  |  |  | 289 | 207 |
| 93 | requests | `/api/request/:uid/status/history` | Tuper only |  |  |  |  |  | 292 | 180 |
| 94 | service_contracts | `/api/service_contract/:uid/payment_history` | Tuper only |  |  |  |  |  | 266 | 254 |
| 95 | subcontractors_work_orders | `/api/subcontractors` | both answer, no records | 0 | 0 |  | 0 |  | 557 | 79 |
| 96 | subcontractors_work_orders | `/api/subcontractors/meta` | both answer |  |  | 100% | 0 | 0 | 309 | 303 |
| 97 | subcontractors_work_orders | `/api/subcontractors/meta/filter` | both answer |  |  | 100% | 0 | 0 | 350 | 134 |
| 98 | subcontractors_work_orders | `/api/subcontractors/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 99 | subcontractors_work_orders | `/api/service_orders` | both answer, no records | 0 | 0 |  | 0 |  | 287 | 114 |
| 100 | subcontractors_work_orders | `/api/service_orders/meta` | both answer |  |  | 100% | 0 | 0 | 287 | 403 |
| 101 | subcontractors_work_orders | `/api/service_orders/meta/filter` | both answer |  |  | 100% | 0 | 0 | 292 | 217 |
| 102 | subcontractors_work_orders | `/api/service_orders/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 103 | timesheets | `/api/timesheets` | both answer | 3 | 3 | 100% | 0 | 0 | 294 | 209 |
| 104 | timesheets | `/api/timesheets/summary` | both answer |  |  | 79% | 8 | 5 | 312 | 1095 |
| 105 | timesheets | `/api/timesheets/request/timeoff` | both answer |  |  | 100% | 0 | 3 | 512 | 1597 |
| 106 | timesheets | `/api/timesheets/request/timeoff/:uid` | both answer |  |  | 100% | 0 | 2 | 283 | 523 |
| 107 | timesheets | `/api/timesheet/location` | both answer, no records | 0 | 0 |  | 0 |  | 288 | 190 |
| 108 | timesheets | `/api/timesheet/location/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 109 | timesheets | `/api/timesheet/request/timeoff_type` | both answer |  |  | 100% | 0 | 0 | 314 | 142 |
| 110 | timesheets | `/api/timesheets/request/timeoff_availability` | both answer |  |  | 100% | 0 | 2 | 277 | 993 |
| 111 | timesheets | `/api/timesheet/approval` | both answer | 1 | 1 | 100% | 0 | 1 | 280 | 749 |
| 112 | timesheets | `/api/timesheet/approval/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 113 | timesheets | `/api/timesheet/approval_hierarchy` | both answer |  |  | 100% | 0 | 1 | 337 | 198 |
| 114 | timesheets | `/api/timesheet/master_shifts` | both answer | 4 | 4 | 100% | 0 | 1 | 281 | 771 |
| 115 | timesheets | `/api/timesheet/master_shifts/:uid` | both answer |  |  | 100% | 0 | 1 | 275 | 198 |
| 116 | timesheets | `/api/timesheet/user_shifts` | both answer, no records | 0 | 0 |  | 0 |  | 439 | 113 |
| 117 | users_teams | `/api/user/all` | both answer | 55 | 59 | 100% | 0 | 0 | 315 | 1112 |
| 118 | users_teams | `/api/user/:uid` | both answer |  |  | 100% | 0 | 0 | 290 | 151 |
| 119 | users_teams | `/api/user/:user_uid}` | both refuse |  |  |  |  |  | 142 | 194 |
| 120 | users_teams | `/api/user/:uid/work_hours` | both answer |  |  | 100% | 0 | 2 | 678 | 248 |
| 121 | users_teams | `/api/user/preferences` | both answer |  |  | 100% | 0 | 0 | 294 | 391 |
| 122 | users_teams | `/api/user/sos` | Zuper refuses (404) |  | 0 |  |  |  | 280 | 245 |
| 123 | users_teams | `/api/users/:uid/skill` | both answer, no records |  |  |  | 0 |  | 343 | 89 |
| 124 | users_teams | `/api/users/:uid/resources` | both answer, no records |  |  |  | 0 |  | 301 | 138 |
| 125 | users_teams | `/api/users/timelog` | both answer | 55 | 59 | 100% | 0 | 0 | 415 | 744 |
| 126 | users_teams | `/api/users/:uid/timelog` | both answer |  |  | 100% | 0 | 0 | 360 | 177 |
| 127 | users_teams | `/api/teams/summary` | both answer | 11 | 11 | 100% | 0 | 1 | 345 | 109 |
| 128 | users_teams | `/api/team` | both answer |  |  | 100% | 0 | 1 | 319 | 361 |
| 129 | users_teams | `/api/team/:uid` | both answer |  |  | 100% | 0 | 2 | 293 | 690 |
| 130 | users_teams | `/api/business_units` | both answer, no records | 0 | 0 |  | 0 |  | 303 | 298 |
| 131 | users_teams | `/api/business_units/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 132 | core | `/api/jobs/category` | both answer |  |  | 100% | 0 | 0 | 296 | 659 |
| 133 | core | `/api/jobs/status/:categoryUid` | both answer |  |  | 82% | 3 | 1 | 329 | 224 |
| 134 | core | `/api/settings/checklist/:checklistUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 135 | core | `/api/assisted_scheduling` | both answer |  |  | 80% | 6 | 2 | 897 | 909 |
| 136 | core | `/api/routes` | both answer, no records | 0 | 0 |  | 0 |  | 308 | 277 |
| 137 | core | `/api/routes/count` | both answer |  |  | 100% | 0 | 0 | 295 | 126 |
| 138 | core | `/api/routes/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 139 | core | `/api/jobs/:uid/note` | both answer, no records |  | 0 |  | 0 |  | 285 | 154 |
| 140 | core | `/api/jobs/:uid` | both answer |  |  | 90% | 34 | 17 | 318 | 993 |
| 141 | core | `/api/jobs` | both answer | 47047 | 47049 | 99% | 2 | 11 | 332 | 868 |
| 142 | core | `/api/request/:uid` | both answer |  |  | 99% | 0 | 0 | 309 | 979 |
| 143 | core | `/api/request` | both answer | 8 | 8 | 97% | 0 | 0 | 304 | 472 |
| 144 | core | `/api/notes` | both answer | 39682 | 39186 | 98% | 0 | 0 | 758 | 1197 |
| 145 | core | `/api/jobs/unscheduled` | both answer | 37 | 38 | 99% | 0 | 4 | 477 | 776 |
| 146 | core | `/api/jobs/:uid/attachments` | Tuper only |  |  |  |  |  | 293 | 72 |
| 147 | core | `/api/jobs/:uid/finance/stats` | both answer |  |  | 100% | 0 | 0 | 290 | 504 |
| 148 | core | `/api/jobs/:uid/timelog_summary` | both answer, no records |  |  |  | 0 |  | 287 | 190 |
| 149 | core | `/api/jobs/:uid/timelog` | both answer, no records |  |  |  | 0 |  | 309 | 999 |
| 150 | core | `/api/jobs/template` | both answer |  |  | 100% | 0 | 0 | 298 | 572 |
| 151 | core | `/api/jobs/template/:templateUid` | both answer |  |  | 98% | 0 | 0 | 290 | 423 |
| 152 | core | `/api/estimate` | both answer | 35 | 35 | 98% | 0 | 1 | 313 | 1354 |
| 153 | core | `/api/estimate/:uid` | both answer |  |  | 100% | 0 | 2 | 309 | 1470 |
| 154 | core | `/service/notifications/webhook_history` | both answer | 32223 | 420 | 100% | 0 |  | 342 | 112 |
| 155 | core | `/service/notifications/webhook` | both answer | 236 | 10 | 91% | 1 |  | 286 | 330 |
| 156 | core | `/service/notifications/webhook/:uid` | both answer |  |  | 91% | 1 | 7 | 285 | 137 |
| 157 | core | `/api/misc/modules` | Tuper only |  |  |  |  |  | 285 | 81 |
| 158 | core | `/api/misc/:module/events` | both answer |  |  | 100% | 0 | 0 | 280 | 179 |
| 159 | records | `/api/recurring_jobs` | both answer | 1320 | 1324 | 100% | 0 | 0 | 391 | 659 |
| 160 | records | `/api/recurring_jobs/:uid` | Tuper only |  |  |  |  |  | 282 | 210 |
| 161 | records | `/api/invoice` | both answer | 13 | 13 | 99% | 0 | 0 | 312 | 1599 |
| 162 | records | `/api/invoice/:uid` | both answer |  |  | 99% | 0 | 6 | 315 | 379 |
| 163 | records | `/api/assets/:uid` | both answer |  |  | 92% | 9 | 3 | 296 | 825 |
| 164 | records | `/api/service_contract` | both answer | 1 | 1 | 98% | 1 | 2 | 303 | 458 |
| 165 | records | `/api/service_contract/:uid` | both answer |  |  | 100% | 0 | 8 | 300 | 551 |
| 166 | records | `/api/product` | both answer | 2074 | 2075 | 98% | 0 | 1 | 334 | 300 |
| 167 | records | `/api/product/:uid` | both answer |  |  | 98% | 0 | 0 | 305 | 169 |
| 168 | records | `/api/products` | Tuper only |  | 2075 |  |  |  | 275 | 595 |
| 169 | records | `/api/products/:uid` | Tuper only |  |  |  |  |  | 275 | 314 |

## Appendix B: lists under filters and paging

| List | Query | Z total | T total | Zuper records also in Tuper | Same order | Z ms | T ms |
|---|---|---|---|---|---|---|---|
| jobs | page 1, 100 a page | 47047 | 47049 | 100 of 100 | yes | 616 | 4024 |
| jobs | page 3, 50 a page | 47047 | 47049 | 50 of 50 | yes | 550 | 933 |
| jobs | oldest first (sort=ASC) | 47047 | 47049 | 25 of 25 | yes | 363 | 1517 |
| jobs | by work order number | 1 | 1 | 1 of 1 | yes | 307 | 515 |
| jobs | keyword "Buggy" | 20852 | 22234 | 83 of 100 | no | 14458 | 3739 |
| jobs | by customer | 34 | 34 | 34 of 34 | yes | 13089 | 1443 |
| jobs | by current status | 38 | 38 | 38 of 38 | yes | 425 | 1157 |
| jobs | by category | 5185 | 5185 | 100 of 100 | yes | 875 | 1943 |
| jobs | by assigned user | 3293 | 3293 | 100 of 100 | yes | 586 | 1777 |
| jobs | by priority LOW | 45818 | 45819 | 100 of 100 | yes | 949 | 1704 |
| jobs | scheduled in the last 7 days | 659 | 561 | 47 of 100 | no | 560 | 2828 |
| jobs | updated in the last day | 47047 | 9898 | 97 of 100 | no | 466 | 2296 |
| jobs | deleted jobs | 2110 | 2120 | 90 of 100 | no | 557 | 1266 |
| customers | page 1, 100 a page | 4712 | 4722 | 100 of 100 | yes | 327 | 538 |
| customers | page 5, 50 a page | 4712 | 4722 | 50 of 50 | yes | 306 | 379 |
| customers | keyword (a customer first name) | 3 | 4 | 3 of 3 | no | 3055 | 174 |
| customers | by email | 3 | 4 | 3 of 3 | no | 321 | 121 |
| customers | deleted customers | 51 | 59 | 51 of 51 | no | 348 | 209 |
| organizations | page 1, 100 a page | 1013 | 1013 | 100 of 100 | yes | 337 | 857 |
| properties | page 1, 100 a page | 1 | 1 | 1 of 1 | yes | 298 | 287 |
| assets | page 1, 100 a page | 2268 | 2269 | 99 of 100 | no | 413 | 1661 |
| invoices | page 1, 100 a page | 13 | 13 | 13 of 13 | yes | 330 | 1014 |
| quotes | page 1, 100 a page | 35 | 35 | 35 of 35 | yes | 321 | 703 |
| requests | page 1, 100 a page | 8 | 8 | 8 of 8 | yes | 329 | 274 |
| contracts | page 1, 100 a page | 1 | 1 | 1 of 1 | yes | 306 | 308 |
| products | page 1, 100 a page | 2074 | 2075 | 100 of 100 | yes | 371 | 1511 |
| users | all users | 55 | 59 | 10 of 10 | no | 297 | 272 |
| teams | teams | 11 | 11 | 11 of 11 | yes | 307 | 162 |
| notes | a job's notes | 0 | 0 | 0 of 0 | no | 310 | 133 |

## Appendix C: webhooks

### Events each system offers, by module

| Module | Zuper | Tuper | In both | Only one side |
|---|---|---|---|---|
| ASSETS | 17 | 17 | 17 | none |
| CUSTOMER | 15 | 15 | 15 | none |
| ESTIMATES | 13 | 13 | 13 | none |
| INVOICE | 19 | 19 | 19 | none |
| JOB | 35 | 35 | 35 | none |
| ORGANIZATION | 10 | 10 | 10 | none |
| PRODUCTS | 12 | 12 | 12 | none |
| PROJECT | 22 | 22 | 22 | none |
| PROPERTY | 11 | 11 | 11 | none |
| PURCHASE_ORDER | 6 | 6 | 6 | none |
| REQUEST | 8 | 8 | 8 | none |
| SERVICE_CONTRACTS | 11 | 11 | 11 | none |
| TEAM | 5 | 5 | 5 | none |
| TIMESHEET | 36 | 36 | 36 | none |
| USER | 16 | 16 | 16 | none |

### Tuper's registrations

| Module registered | Event | Active | Sends to |
|---|---|---|---|
| CUSTOMERS | `customer.delete` | yes | zupersync.golfbuggyguy.com |
| CUSTOMERS | `customer.update` | yes | zupersync.golfbuggyguy.com |
| CUSTOMERS | `customer.create` | yes | zupersync.golfbuggyguy.com |
| JOBS | `job.unassign_users` | yes | zupersync.golfbuggyguy.com |
| JOBS | `job.assign_users` | yes | zupersync.golfbuggyguy.com |
| JOBS | `job.status_update` | yes | zupersync.golfbuggyguy.com |
| JOBS | `job.update_schedule` | yes | zupersync.golfbuggyguy.com |
| JOBS | `job.delete` | yes | zupersync.golfbuggyguy.com |
| JOBS | `job.update` | yes | zupersync.golfbuggyguy.com |
| JOBS | `job.new` | yes | zupersync.golfbuggyguy.com |

### Deliveries received in the last 30 days

| Source | Event | Deliveries | Carrying a record id | Applied | Failed |
|---|---|---|---|---|---|
| Tuper | `job.new` | 121 | 0 | 0 | 121 |
| Tuper | `customer.update` | 55 | 0 | 0 | 55 |
| Tuper | `job.delete` | 42 | 0 | 0 | 42 |
| Tuper | `job.update` | 42 | 8 | 8 | 34 |
| Tuper | `customer.create` | 40 | 0 | 0 | 40 |
| Tuper | `job.assign_users` | 33 | 33 | 33 | 0 |
| Tuper | `job.unassign_users` | 33 | 33 | 33 | 0 |
| Tuper | `customer.delete` | 25 | 0 | 0 | 25 |
| Tuper | `job.status_update` | 23 | 23 | 23 | 0 |
| Tuper | `job.update_schedule` | 5 | 5 | 5 | 0 |
| Zuper | `job.status_update` | 2074 | 2074 | 2074 | 0 |
| Zuper | `job.update_schedule` | 1107 | 1107 | 1105 | 0 |
| Zuper | `job.update_acceptance` | 427 | 427 | 426 | 0 |
| Zuper | `job.new` | 417 | 417 | 417 | 0 |
| Zuper | `job.update` | 417 | 414 | 413 | 0 |
| Zuper | `job.unassign_users` | 342 | 342 | 341 | 0 |
| Zuper | `job.assign_users` | 334 | 334 | 333 | 0 |
| Zuper | `job.new_note` | 317 | 317 | 317 | 0 |
| Zuper | `asset.update` | 262 | 262 | 262 | 0 |
| Zuper | `job.feedback` | 190 | 190 | 190 | 0 |

*(Zuper: the ten busiest of 34 events; 6,570 deliveries in all.)*
