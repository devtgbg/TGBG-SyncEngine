# Tuper's API compared with Zuper's

*Read-only test, 22 September 2026, against production: `api.tuper.golfbuggyguy.com` and Zuper (`eks-ap-south-1.zuperpro.com`).*

Tuper serves a copy of Zuper's API at Zuper's own paths, so that an application written for Zuper can switch to Tuper by changing the base URL and the key. This report tests that promise for reading. Each endpoint was asked the same question in both systems, and the answers were compared on four points: does it answer, is the answer shaped the same way, does it hold the same data, and how fast is it.

## Summary

Of the 169 read endpoints Tuper serves, 108 answer in both systems. Where both answer, Tuper returns a median of **94%** of the fields Zuper returns, and 27 endpoints return all of them. On the same record, a median of **87%** of the shared values are equal.

| Result | Endpoints |
|---|---|
| Both answer, with records to compare | 79 |
| Both answer, no records on either side | 29 |
| Tuper refuses where Zuper answers | 3 |
| Tuper only: Zuper's server does not serve the path | 16 |
| Zuper refuses: a feature is off, the record exists only in Tuper, or the path is not Zuper's | 10 |
| Both refuse: they need input neither side had | 4 |
| Not tested: no record on either side to test with | 28 |

- **Jobs are in very good shape.** The job list answers the same jobs, in the same order, under paging, sort order and six of Zuper's filters (work order, keyword, customer, category, assigned user, priority).
- **A few endpoints answer in a different shape altogether** (section 1). An application written for Zuper would break on these.
- **Summaries, invoices, contracts and products leave out large parts of Zuper's answer** (section 2).
- **Most value differences come from one cause.** User records embedded in other records carry Tuper's own timestamps and pictures instead of Zuper's (section 3).
- **Tuper is faster on small reads but 2–4 times slower on job lists and on single jobs, quotes and requests** (section 6).

## How it was tested

- **Endpoints.** Every `GET` route in Tuper's router (`apps/JMS/web/src/lib/api/router.ts`, `module-routes/*`, and the record modules in `modules.ts`), apart from Tuper's own `/api/sync/*`.
- **Same question to both.** Tuper accepts Zuper's uids, so each id was taken from Zuper's own list and sent to both systems unchanged. Lists were asked for `page=1&count=10`, and endpoints that require dates or a module were given them. A second pass sent the core lists 100 to a page, later pages, `sort=ASC` and Zuper's `filter.*` parameters.
- **Measures.**
  - *Coverage* is the share of Zuper's field paths (nested, e.g. `customer.customer_address.city`) that Tuper's answer also has.
  - *Agreement* is the share of shared fields with equal values, counted only when both answers are the same record. Timestamps are compared as instants, and numbers as numbers.
  - Array elements are paired by likeness, not by position, so a different order is not counted as a wrong value.
- **Safety.** Only `GET` requests were sent. Zuper was paced to about 40 calls a minute, because the live sync shares its limit.
- **Limits.** One record per endpoint, and the first page of each list. 28 endpoints could not be tried, because neither system has a record of that kind (telephony, documents, purchase orders, vendors, subcontractors, service orders, credit notes, expenses, service tasks, measurements, pricelists, transfer orders).

## 1. Endpoints answered in a different shape

An application written for Zuper cannot read these answers.

| Endpoint | Zuper answers | Tuper answers |
|---|---|---|
| `GET /api/jobs/{uid}/finance/stats` | `job {job_uid, job_title}`, `stats {approved_amount, invoiced_amount, amount_left_to_invoice, collected_amount, balance_amount, invoiced_rate, collection_rate, bad_debt_amount}`, `payments[]` | `revenue, cost, profit, profit_margin, discount, tax, billable, line_item_count`: no field in common |
| `GET /api/misc/{module}/events` | `data {module, module_name, events[] {event_key, event_name, description}}` | `data[] {event, label, module}` |
| `GET /api/jobs/{uid}/timelog_summary` | `data: []` for a job with no time logs | `data {total_minutes, entries, per_user[]}` |
| `GET /service/notifications/webhook_history` | each delivery nests `webhook {webhook_uid, webhook_name, webhook_module, webhook_url, webhook_event, content_type, request_method, headers}` and has `response_status` | the webhook's fields flattened onto the delivery, plus `status, response_code, error, attempts, duration_ms` |
| `GET /api/team` | every team in one answer (`data[]` and `count`), each with its `users[]` | 10 teams to a page (`total_records`, `paging`), with `user_count` and no `users[]` |
| `GET /api/timesheet/master_shifts/{uid}` | `shift_days` as a JSON-encoded **string**, plus `duration, repeat_frequency, repeat_every, repeat_on` | `shift_days` as an array, and no `duration` or repeat fields |

## 2. Parts of Zuper's answer that Tuper leaves out

| Endpoint | Coverage | Missing in Tuper |
|---|---|---|
| `GET /api/customers/{uid}/summary` | 49% | the latest job's `job_status[]` history and its status `category`; `assigned_to[].is_primary`. Where the customer has no record of a kind, Zuper sends `latest_transaction: null` and Tuper an empty object `{}`, for project, quote, invoice, payment, property, request, asset, service contract and recurring job |
| `GET /api/property/{uid}/summary` | 51% | `transactions.activity`: Tuper sends the latest activity as `null` where Zuper has one |
| `GET /api/assets/{uid}/summary` | 57% | `transactions.activity` (`null` in Tuper), and the latest job's status category, `job_timezone` and `due_date` |
| `GET /api/organization/{uid}/summary` | 67% | `transactions.activity` (`null` in Tuper) |
| `GET /api/invoice/{uid}` | 78% | `status_history` is an empty list where Zuper has the invoice's history (`status_name, done_by, done_by_type, created_at`); `line_items[].product_ref_id` is `null` where Zuper embeds the product (category, brand, type, meta data); `discount` is `null` where Zuper has `{type, discount_applicability, discount_label}`; `taxation_meta.tax_provider`; organisation custom fields |
| `GET /api/service_contract/{uid}` | 74% | `line_items[].product_ref_id` is `null` where Zuper embeds the product; `contract_package.line_items` is an empty list where Zuper has the package's lines; `template.template_options.border` |
| `GET /api/product`, `/api/product/{uid}` | 55%, 66% | `created_by` is `null` where Zuper embeds the user; `_id` on `meta_data[]` and `location_availability[]` |
| `GET /api/products/category` | 19% | `created_by` is `null`; `id` |
| `GET /api/jobs/category` | 32% | `display_order, category_description, created_at, updated_at, created_by`, `job_statuses` |
| `GET /api/jobs/template/{uid}` | 39% | `created_by`, `render_engine`, `associated_to[]` details, `job_category.category_description` |
| `GET /api/recurring_jobs` | 72% | `created_by` is `null` |
| `GET /api/jobs/{uid}` | 84% | `parent_job` is `null` where Zuper returns the parent job (seen on a child AMC visit); `job_status[].category`, `job_status[].time_on_status`; `assigned_to[].user.user_meta_data.labor_type_uid` and `burden_rate`; `assets[].asset.custom_fields`; `external_id` is `{}` where Zuper has `hubspot_ticket` and `hubspot_deal`; `business_unit` |
| `GET /api/jobs` | 96% | `job_status[].category`, `time_on_status`, `service_territory.conflicts`, `external_id`, `business_unit` |
| `GET /api/estimate/{uid}` | 83% | `vendor, pending_option_selection, payment_methods, surcharge, await_signature_by, taxation_meta.tax_provider` |
| `GET /api/timesheets/summary` | 76% | `timesheet_data[].timesheets[]` is empty where Zuper lists each day of the week asked for (4 per user in the test), each with `date, shift_start, shift_end, total_work_time, total_break_time, total_over_time, check_in_time, check_out_time` |
| `GET /api/assets/inspection_form/master` | 47% | most of the embedded `created_by` user |

Tuper often returns *more* than Zuper as well: full addresses with coordinates, the customer's account figures, extra job fields. Extra fields do not break a Zuper client, so they are not listed here; the appendix counts them.

## 3. Values that differ on the same record

369 values differed across the compared records. Four fields account for 61% of them, and they all belong to user objects embedded in other records (`created_by`, `assigned_to[].user`, `done_by`):

| Field | Zuper | Tuper | Differences |
|---|---|---|---|
| `updated_at` | the user's last change in Zuper | Tuper's last write of the row, e.g. today's import | 84, in 37 endpoints |
| `created_at` | when the user was created in Zuper (2021–2025) | when Tuper imported them (2026-09-11) | 53, in 33 endpoints |
| `profile_picture` | Zuper's S3 URL | empty, or a copy on Tuper's storage | 46, in 33 endpoints |
| `last_login_at` | the last sign-in to Zuper | `null` | 43, in 30 endpoints |

The same pattern (Tuper's own dates on imported rows) applies to roles: `role.created_at` is 2026-08-31 in Tuper and 2018-01-22 in Zuper.

The rest, each one a specific fix:

| Where | Zuper | Tuper |
|---|---|---|
| `assigned_to[].acceptance_status` (a job) | `AWAIT_RESPONSE` | `PENDING`, a value Zuper does not use |
| `invoice_date` (invoices) | `2023-12-13T20:00:00Z`, midnight in Dubai | `2023-12-14T00:00:00Z`, midnight UTC: 4 hours late |
| `due_date` (invoices) | `2024-01-13T19:59:00Z`, 23:59 in Dubai | `2024-01-13T00:00:00Z`: the time is dropped, 20 hours early |
| `due_date_dt` (unscheduled jobs) | `…-09-01` | `…-08-31`: a day early |
| emails (users, customers) | as typed, mixed case | lower-cased |
| work order number in a summary's latest job | `JGE-P54757` | `54757`: the prefix is dropped |
| `is_expired` (a quote) | `false` | `true` |
| `service_territory.is_conflict` (a job) | `true`, with 1 conflict | `false`, 0 conflicts |
| `gallery.is_enabled` (a job) | `false` | `true` |
| `group_type` (a product group) | `PRODUCT_GROUP` | `null` |
| `company_id` (a master shift) | `135` | `null` |
| `markdown_description` (contract line items) | Markdown-escaped (`1\. Visual…`) | unescaped (`1. Visual…`) |
| ids of child records: `role_uid`, `line_item_uid`, `payment_term_uid`, `billing_period_uid`, `status_history_uid`, `custom_fields[]._id` | Zuper's uid | Tuper's own uuid, even though the record came from Zuper |

`details_url`, `feedback_url` and the gallery URLs point to Tuper instead of Zuper's customer portal, which is presumably intended.

## 4. How queries behave

Measured with the core lists; each row asks both systems the same thing.

| Query | Zuper | Tuper | Finding |
|---|---|---|---|
| jobs: 100 a page, page 3 of 50, `sort=ASC`, work order, keyword, customer, category, assigned user, priority | — | — | the same jobs, in the same order |
| jobs: current status | 55 | 58 | 3 more in Tuper |
| jobs: `filter.from_date`/`filter.to_date`, last 7 days | 673 | 598 | a different set: 66 of Zuper's first 100 are in Tuper's answer |
| jobs: `filter.updated_at_from`, last day | 46,971 | 24,687 | Zuper ignores this parameter. Tuper applies it to its own `updated_at`, which every import run touches, so "changed since" does not mean changed in Zuper |
| jobs: `filter.is_deleted=true` | 2,108 | 310 | see section 5 |
| customers: `filter.is_deleted=true` | 51 | 4,407 | see section 5 |
| customers, products: page 1 and page 5 | — | — | no records in common: the default order differs, so paging through both does not line up |
| attachments (`/api/attachments/group`) | oldest first | newest first | the default order differs |
| `GET /api/notes` with no filter | all notes, 39,608 | none | Tuper answers only with `filter.job` or `filter.customer` |
| `GET /api/user/all?count=100` | 10 (ignores `count`) | 48 | Tuper honours `count` where Zuper does not |
| `GET /api/comments?filter.module=JOB&…` | answers | 400, "module must be ATTACHMENT" | Tuper keeps comments only on attachments |
| `GET /api/timesheet/user_shifts` | answers without dates | 400 without `filter.start_date` and `filter.end_date` | Tuper is stricter |
| `GET /api/assisted_scheduling?from_date=2026-09-22` | 400, needs `YYYY-MM-DD HH:mm:ss` | answers | Tuper is more lenient; with the full format both answer |

## 5. Data held on each side

These are differences in what Tuper holds, not in how its API works. They come from the import and sync (Zupersync), from records made in Tuper, or from test data.

| Records | Zuper | Tuper |
|---|---|---|
| Jobs | 46,971 | 46,975 |
| Customers | 4,710 | 4,731 |
| Organisations | 1,011 | 1,011 |
| Assets | 2,265 | 2,267 |
| Products | 2,074 | 2,075 |
| Quotes | 35 | 38 |
| Invoices | 13 | 21 |
| Requests | 8 | 8 |
| Teams | 11 | 12 |
| Users | 55 | 48 |
| Recurring jobs | 1,320 | 1,072 |
| Stock transactions | 773 | 309 |
| Job time-log summaries | 2,008 | 1,078 |
| Payment transactions | 0 | 10 |
| Business units | 0 | 4 |
| Projects | 0 | 1 |
| Deleted jobs | 2,108 | 310 |
| Deleted customers | 51 | 4,407 |
| Attachments | 121,550 | 365,618 |

- Two of Tuper's three refusals are records it does not hold: an asset template (`GET /api/assets/template/{uid}`) and a stock transaction from 2023 (`GET /api/product/transaction/{uid}`). A recurring job listed by Zuper is also not found in Tuper.
- **Production Tuper holds test records:** three customers named `TUPER-TEST …`, `TEST-CUST-001`, `ZZ WBTest`, a job `TUPER-TEST JOBWORK job`, and a user `TUPER-TEST Person …`, which is the first entry in `/api/user/all`. They account for part of Tuper's extra customers and jobs.
- The 4,407 deleted customers and the attachment count, three times Zuper's, are not explained by this test.

## 6. Speed

Median time over the 108 endpoints both answered: Zuper 298 ms, Tuper 167 ms. Tuper is quicker on small reads and on searches, but slower on the heaviest reads:

| Request | Zuper | Tuper |
|---|---|---|
| jobs, 100 a page | 0.7 s | 1.7 s |
| jobs, page 3 of 50 | 0.4 s | 1.4 s |
| jobs by category / by assigned user | 0.45 s / 0.7 s | 1.5 s / 1.5 s |
| jobs scheduled in the last 7 days | 0.6 s | 1.6 s |
| a single job | 0.34 s | 0.9 s |
| a single quote | 0.32 s | 1.2 s |
| a single request | 0.29 s | 0.86 s |
| jobs by keyword | 3.1 s | 2.0 s |
| customers by keyword | 2.6 s | 0.14 s |
| a customer's summary | 14.5 s | 0.4 s |

## 7. Not compared

- **Tuper only (16).** Zuper's server answers `Cannot GET` for these, so no Zuper client can depend on them:
  - `/api/customers/{uid}/attachments`, `/api/customers/{uid}/cards`;
  - `/api/jobs/{uid}/attachments`;
  - `/api/projects/{uid}/assign`, `/jobs`, `/milestone`, `/dependencies`, `/note`, `/timelog`;
  - `/api/estimate/{uid}/deposit`;
  - `/api/request/{uid}/assign`, `/api/request/{uid}/status/history`;
  - `/api/service_contract/{uid}/payment_history`;
  - `/api/misc/modules`;
  - `/api/products`, `/api/products/{uid}`.

  Either Zuper's reference lists paths its server does not serve, or Zuper serves them with another method.
- **Zuper refuses (10).**
  - `/api/appointments`: the feature is off in this Zuper account.
  - `/api/projects/{uid}`, `/phases` and `/finance/stats`: the only project exists only in Tuper.
  - `/api/projects/status`: Zuper needs a project category.
  - `/api/business_units/{uid}`: business units exist only in Tuper.
  - `/api/payments/{uid}/transactions`: the payment exists only in Tuper.
  - `/api/invoice/payment_mode`, `/api/invoice/payment_term` and `/api/user/sos`: Zuper reads the last word as a record id, so these paths are not Zuper's.
- **Both refuse (4).**
  - `/api/customers/merge` and `/api/vendor_catalogs`: need input neither side had.
  - `/api/user/{user_uid}}`: copies the stray brace in Zuper's reference and cannot match a real request.
  - `/api/recurring_jobs/{uid}`: Zuper does not serve it, and the recurring job used is not in Tuper.
- **Webhook registrations** differ by design: each system lists its own (Zuper 236, Tuper 10). A single webhook's detail has the same shape on both sides.

---

## Appendix A: every endpoint

Z and T are Zuper and Tuper. Totals are `total_records` where the endpoint gives one. Times are single requests.

| # | Module | Path | Result | Z total | T total | Coverage | Tuper extra fields | Agreement | Z ms | T ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | assets | `/api/assets` | both answer | 2265 | 2267 | 91% | 40 | 94% | 809 | 885 |
| 2 | assets | `/api/assets/template` | both answer |  |  | 77% | 6 |  | 303 | 123 |
| 3 | assets | `/api/assets/template/:templateUid` | **Tuper refuses** (404) |  |  |  |  |  | 286 | 148 |
| 4 | assets | `/api/assets/:uid/history` | both answer, no records | 0 | 0 |  |  |  | 296 | 336 |
| 5 | assets | `/api/assets/:uid/summary` | both answer |  |  | 57% | 1 | 85% | 381 | 224 |
| 6 | assets | `/api/imports/asset` | both answer |  |  | 100% | 0 | 100% | 473 | 221 |
| 7 | assets | `/api/imports/asset/sample_import` | both answer |  |  | 100% | 0 | 100% | 593 | 223 |
| 8 | assets | `/api/assets/inspection_form/:formUid/:fieldUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 9 | assets | `/api/assets/inspection_form/master` | both answer | 3 | 4 | 47% | 1 | 86% | 313 | 259 |
| 10 | assets | `/api/assets/inspection_form` | both answer, no records | 0 | 0 |  |  |  | 278 | 114 |
| 11 | assets | `/api/assets/inspection_form/:submissionUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 12 | commissions | `/api/commissions` | both answer, no records | 0 | 0 |  |  |  | 306 | 164 |
| 13 | commissions | `/api/commissions/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 14 | communications | `/telephony/calls/:uid/details` | not tested: no record either side |  |  |  |  |  |  |  |
| 15 | communications | `/telephony/calls/:uid/activities` | not tested: no record either side |  |  |  |  |  |  |  |
| 16 | communications | `/telephony/message/conversation/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 17 | customers | `/api/customers` | both answer | 4711 | 4731 | 95% | 37 |  | 336 | 274 |
| 18 | customers | `/api/customers/merge` | both refuse |  |  |  |  |  | 289 | 134 |
| 19 | customers | `/api/customers/:uid` | both answer |  |  | 99% | 25 | 93% | 296 | 378 |
| 20 | customers | `/api/customers/:uid/summary` | both answer |  |  | 49% | 2 | 91% | 14538 | 398 |
| 21 | customers | `/api/customers/:uid/attachments` | Tuper only |  |  |  |  |  | 282 | 136 |
| 22 | customers | `/api/customers/:uid/note` | both answer, no records |  |  |  |  |  | 284 | 172 |
| 23 | customers | `/api/customers/:uid/cards` | Tuper only |  |  |  |  |  | 294 | 83 |
| 24 | documents | `/api/documents` | both answer, no records | 0 | 0 |  |  |  | 284 | 154 |
| 25 | documents | `/api/documents/:uid/pdf` | not tested: no record either side |  |  |  |  |  |  |  |
| 26 | documents | `/api/documents/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 27 | invoices | `/api/invoice/payment_mode` | Zuper refuses (404) |  | 0 |  |  |  | 283 | 122 |
| 28 | invoices | `/api/invoice/payment_term` | Zuper refuses (404) |  | 4 |  |  |  | 304 | 86 |
| 29 | invoices | `/api/payments/payment_request` | both answer, no records | 0 | 0 |  |  |  | 279 | 74 |
| 30 | invoices | `/api/payments/payment_request/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 31 | invoices | `/api/payments/transactions` | both answer | 0 | 10 |  |  |  | 290 | 206 |
| 32 | invoices | `/api/payments/:uid/transactions` | Zuper refuses (404) |  |  |  |  |  | 290 | 179 |
| 33 | invoices | `/api/accounting/credit_notes` | both answer, no records | 0 | 0 |  |  |  | 289 | 277 |
| 34 | invoices | `/api/accounting/credit_history` | both answer, no records | 0 | 0 |  |  |  | 283 | 129 |
| 35 | invoices | `/api/accounting/credit_notes/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 36 | jobs | `/api/service_tasks` | both answer, no records | 0 | 0 |  |  |  | 286 | 76 |
| 37 | jobs | `/api/service_tasks/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 38 | jobs | `/api/appointments` | Zuper refuses (403) |  | 0 |  |  |  | 329 | 122 |
| 39 | jobs | `/api/appointments/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 40 | jobs | `/api/expenses` | both answer, no records | 0 | 0 |  |  |  | 300 | 167 |
| 41 | jobs | `/api/expenses/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 42 | jobs | `/api/attachments/folders` | both answer, no records | 0 | 0 |  |  |  | 633 | 236 |
| 43 | jobs | `/api/attachments/folders/:uid/share` | not tested: no record either side |  |  |  |  |  |  |  |
| 44 | jobs | `/api/attachments/group` | both answer | 121550 | 365618 | 96% | 1 |  | 1553 | 1951 |
| 45 | jobs | `/api/comments` | **Tuper refuses** (400) | 0 |  |  |  |  | 272 | 63 |
| 46 | jobs | `/api/jobs/timelog_summary` | both answer | 2008 | 1078 | 100% | 11 |  | 313 | 675 |
| 47 | measurements | `/api/measurements` | both answer, no records | 0 | 0 |  |  |  | 283 | 115 |
| 48 | measurements | `/api/measurements/:uid/details` | not tested: no record either side |  |  |  |  |  |  |  |
| 49 | measurements | `/api/measurements/categories` | both answer, no records |  |  |  |  |  | 287 | 118 |
| 50 | measurements | `/api/measurements/providers` | both answer, no records |  |  |  |  |  | 286 | 96 |
| 51 | organizations_properties | `/api/organization` | both answer | 1011 | 1011 | 85% | 8 | 86% | 314 | 266 |
| 52 | organizations_properties | `/api/organization/:uid` | both answer |  |  | 100% | 7 | 87% | 291 | 320 |
| 53 | organizations_properties | `/api/organization/:uid/summary` | both answer |  |  | 67% | 3 | 96% | 328 | 179 |
| 54 | organizations_properties | `/api/property` | both answer | 1 | 1 | 83% | 12 | 93% | 298 | 224 |
| 55 | organizations_properties | `/api/property/:uid` | both answer |  |  | 94% | 8 | 94% | 309 | 405 |
| 56 | organizations_properties | `/api/property/:uid/summary` | both answer |  |  | 51% | 1 | 91% | 352 | 242 |
| 57 | parts_services | `/api/product/group` | both answer | 3 | 3 | 100% | 7 | 85% | 296 | 154 |
| 58 | parts_services | `/api/product/group/:uid` | both answer |  |  | 100% | 7 | 81% | 286 | 173 |
| 59 | parts_services | `/api/products/category` | both answer | 2 | 3 | 19% | 5 | 100% | 376 | 122 |
| 60 | parts_services | `/api/product/transaction` | both answer | 773 | 309 | 89% | 8 |  | 311 | 502 |
| 61 | parts_services | `/api/product/transaction/:uid` | **Tuper refuses** (404) |  |  |  |  |  | 291 | 119 |
| 62 | parts_services | `/api/products/transfer_orders` | both answer, no records | 0 | 0 |  |  |  | 282 | 130 |
| 63 | parts_services | `/api/products/transfer_orders/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 64 | parts_services | `/api/products/pricelist` | both answer, no records | 0 | 0 |  |  |  | 280 | 93 |
| 65 | parts_services | `/api/products/pricelist/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 66 | projects | `/api/projects` | both answer | 0 | 1 |  |  |  | 285 | 310 |
| 67 | projects | `/api/projects/status` | Zuper refuses (400) |  |  |  |  |  | 278 | 100 |
| 68 | projects | `/api/projects/:uid` | Zuper refuses (404) |  |  |  |  |  | 279 | 600 |
| 69 | projects | `/api/projects/:uid/assign` | Tuper only |  |  |  |  |  | 305 | 181 |
| 70 | projects | `/api/projects/:uid/jobs` | Tuper only |  |  |  |  |  | 276 | 90 |
| 71 | projects | `/api/projects/:uid/milestone` | Tuper only |  |  |  |  |  | 282 | 90 |
| 72 | projects | `/api/projects/:uid/phases` | Zuper refuses (404) |  |  |  |  |  | 281 | 244 |
| 73 | projects | `/api/projects/:uid/dependencies` | Tuper only |  |  |  |  |  | 287 | 195 |
| 74 | projects | `/api/projects/:uid/finance/stats` | Zuper refuses (404) |  |  |  |  |  | 280 | 119 |
| 75 | projects | `/api/projects/:uid/note` | Tuper only |  |  |  |  |  | 283 | 201 |
| 76 | projects | `/api/projects/:uid/timelog` | Tuper only |  |  |  |  |  | 277 | 223 |
| 77 | purchase_orders_vendors | `/api/purchase_orders` | both answer, no records | 0 | 0 |  |  |  | 289 | 121 |
| 78 | purchase_orders_vendors | `/api/purchase_orders/meta` | both answer |  |  | 100% | 0 |  | 308 | 159 |
| 79 | purchase_orders_vendors | `/api/purchase_orders/meta/filter` | both answer |  |  | 100% | 0 |  | 325 | 126 |
| 80 | purchase_orders_vendors | `/api/purchase_orders/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 81 | purchase_orders_vendors | `/api/purchase_orders/:uid/note` | not tested: no record either side |  |  |  |  |  |  |  |
| 82 | purchase_orders_vendors | `/api/vendors` | both answer, no records | 0 | 0 |  |  |  | 308 | 317 |
| 83 | purchase_orders_vendors | `/api/vendors/meta` | both answer |  |  | 100% | 0 |  | 289 | 100 |
| 84 | purchase_orders_vendors | `/api/vendors/meta/filter` | both answer |  |  | 100% | 0 |  | 301 | 128 |
| 85 | purchase_orders_vendors | `/api/vendors/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 86 | purchase_orders_vendors | `/api/vendor_catalogs` | both refuse |  |  |  |  |  | 281 | 98 |
| 87 | quotes | `/api/invoice_estimate/package` | both answer, no records | 0 | 0 |  |  |  | 293 | 127 |
| 88 | quotes | `/api/invoice_estimate/package/:packageUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 89 | quotes | `/api/invoice_estimate/proposal_template` | both answer, no records | 0 | 0 |  |  |  | 316 | 127 |
| 90 | quotes | `/api/invoice_estimate/proposal_template/:templateUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 91 | quotes | `/api/estimate/:uid/deposit` | Tuper only |  |  |  |  |  | 276 | 165 |
| 92 | requests | `/api/request/:uid/assign` | Tuper only |  |  |  |  |  | 290 | 142 |
| 93 | requests | `/api/request/:uid/status/history` | Tuper only |  |  |  |  |  | 288 | 205 |
| 94 | service_contracts | `/api/service_contract/:uid/payment_history` | Tuper only |  |  |  |  |  | 278 | 155 |
| 95 | subcontractors_work_orders | `/api/subcontractors` | both answer, no records | 0 | 0 |  |  |  | 289 | 115 |
| 96 | subcontractors_work_orders | `/api/subcontractors/meta` | both answer |  |  | 100% | 0 |  | 288 | 150 |
| 97 | subcontractors_work_orders | `/api/subcontractors/meta/filter` | both answer |  |  | 100% | 0 |  | 287 | 92 |
| 98 | subcontractors_work_orders | `/api/subcontractors/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 99 | subcontractors_work_orders | `/api/service_orders` | both answer, no records | 0 | 0 |  |  |  | 289 | 152 |
| 100 | subcontractors_work_orders | `/api/service_orders/meta` | both answer |  |  | 100% | 0 |  | 291 | 83 |
| 101 | subcontractors_work_orders | `/api/service_orders/meta/filter` | both answer |  |  | 100% | 0 |  | 294 | 89 |
| 102 | subcontractors_work_orders | `/api/service_orders/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 103 | timesheets | `/api/timesheets` | both answer | 3 | 3 | 100% | 0 | 86% | 313 | 88 |
| 104 | timesheets | `/api/timesheets/summary` | both answer |  |  | 76% | 1 | 28% | 309 | 128 |
| 105 | timesheets | `/api/timesheets/request/timeoff` | both answer |  |  | 99% | 0 | 84% | 562 | 885 |
| 106 | timesheets | `/api/timesheets/request/timeoff/:uid` | both answer |  |  | 98% | 20 | 86% | 283 | 178 |
| 107 | timesheets | `/api/timesheet/location` | both answer, no records | 0 | 0 |  |  |  | 534 | 158 |
| 108 | timesheets | `/api/timesheet/location/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 109 | timesheets | `/api/timesheet/request/timeoff_type` | both answer |  |  | 100% | 0 | 85% | 357 | 148 |
| 110 | timesheets | `/api/timesheets/request/timeoff_availability` | both answer |  |  | 100% | 0 | 81% | 295 | 298 |
| 111 | timesheets | `/api/timesheet/approval` | both answer | 1 | 1 | 100% | 0 | 84% | 284 | 220 |
| 112 | timesheets | `/api/timesheet/approval/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 113 | timesheets | `/api/timesheet/approval_hierarchy` | both answer |  |  | 100% | 0 | 83% | 280 | 157 |
| 114 | timesheets | `/api/timesheet/master_shifts` | both answer | 4 | 4 | 100% | 0 | 86% | 292 | 212 |
| 115 | timesheets | `/api/timesheet/master_shifts/:uid` | both answer |  |  | 85% | 7 | 83% | 281 | 228 |
| 116 | timesheets | `/api/timesheet/user_shifts` | both answer, no records | 0 | 0 |  |  |  | 613 | 140 |
| 117 | users_teams | `/api/user/all` | both answer | 55 | 48 | 100% | 36 |  | 293 | 519 |
| 118 | users_teams | `/api/user/:uid` | both answer |  |  | 97% | 7 | 82% | 304 | 207 |
| 119 | users_teams | `/api/user/:user_uid}` | both refuse |  |  |  |  |  | 281 | 153 |
| 120 | users_teams | `/api/user/:uid/work_hours` | both answer |  |  | 100% | 0 |  | 283 | 149 |
| 121 | users_teams | `/api/user/preferences` | both answer |  |  | 100% | 0 | 100% | 285 | 84 |
| 122 | users_teams | `/api/user/sos` | Zuper refuses (404) |  | 0 |  |  |  | 285 | 103 |
| 123 | users_teams | `/api/users/:uid/skill` | both answer, no records |  |  |  |  |  | 275 | 264 |
| 124 | users_teams | `/api/users/:uid/resources` | both answer, no records |  |  |  |  |  | 283 | 190 |
| 125 | users_teams | `/api/users/timelog` | both answer | 55 | 48 | 100% | 3 | 93% | 412 | 298 |
| 126 | users_teams | `/api/users/:uid/timelog` | both answer |  |  | 100% | 0 |  | 299 | 234 |
| 127 | users_teams | `/api/teams/summary` | both answer | 11 | 12 | 100% | 1 | 92% | 288 | 239 |
| 128 | users_teams | `/api/team` | both answer |  | 12 | 30% | 2 | 100% | 310 | 157 |
| 129 | users_teams | `/api/team/:uid` | both answer |  |  | 95% | 17 | 82% | 305 | 670 |
| 130 | users_teams | `/api/business_units` | both answer | 0 | 4 |  |  |  | 449 | 174 |
| 131 | users_teams | `/api/business_units/:uid` | Zuper refuses (404) |  |  |  |  |  | 287 | 152 |
| 132 | core | `/api/jobs/category` | both answer |  |  | 32% | 0 | 100% | 293 | 99 |
| 133 | core | `/api/jobs/status/:categoryUid` | both answer |  |  | 82% | 3 | 96% | 297 | 147 |
| 134 | core | `/api/settings/checklist/:checklistUid` | not tested: no record either side |  |  |  |  |  |  |  |
| 135 | core | `/api/assisted_scheduling` | both answer |  |  | 94% | 3 | 64% | 1056 | 634 |
| 136 | core | `/api/routes` | both answer, no records | 0 | 0 |  |  |  | 289 | 126 |
| 137 | core | `/api/routes/count` | both answer |  |  | 100% | 0 |  | 286 | 78 |
| 138 | core | `/api/routes/:uid` | not tested: no record either side |  |  |  |  |  |  |  |
| 139 | core | `/api/jobs/:uid/note` | both answer, no records |  | 0 |  |  |  | 290 | 125 |
| 140 | core | `/api/jobs/:uid` | both answer |  |  | 84% | 38 | 86% | 343 | 908 |
| 141 | core | `/api/jobs` | both answer | 46971 | 46975 | 96% | 159 | 85% | 319 | 1909 |
| 142 | core | `/api/request/:uid` | both answer |  |  | 94% | 15 | 90% | 290 | 857 |
| 143 | core | `/api/request` | both answer | 8 | 8 | 90% | 86 | 90% | 308 | 447 |
| 144 | core | `/api/notes` | both answer | 39608 | 0 | 0% | 0 |  | 814 | 77 |
| 145 | core | `/api/jobs/unscheduled` | both answer | 37 | 41 | 61% | 146 | 85% | 315 | 641 |
| 146 | core | `/api/jobs/:uid/attachments` | Tuper only |  |  |  |  |  | 281 | 114 |
| 147 | core | `/api/jobs/:uid/finance/stats` | both answer |  |  | 0% | 8 |  | 304 | 112 |
| 148 | core | `/api/jobs/:uid/timelog_summary` | both answer |  |  | 0% | 2 |  | 285 | 101 |
| 149 | core | `/api/jobs/:uid/timelog` | both answer, no records |  |  |  |  |  | 290 | 108 |
| 150 | core | `/api/jobs/template` | both answer |  |  | 74% | 3 | 86% | 283 | 185 |
| 151 | core | `/api/jobs/template/:templateUid` | both answer |  |  | 39% | 0 | 89% | 293 | 135 |
| 152 | core | `/api/estimate` | both answer | 35 | 38 | 82% | 29 | 87% | 313 | 681 |
| 153 | core | `/api/estimate/:uid` | both answer |  |  | 83% | 19 | 88% | 316 | 1233 |
| 154 | core | `/service/notifications/webhook_history` | both answer | 28913 | 337 | 18% | 10 |  | 379 | 94 |
| 155 | core | `/service/notifications/webhook` | both answer | 236 | 10 | 91% | 1 |  | 291 | 191 |
| 156 | core | `/service/notifications/webhook/:uid` | both answer |  |  | 91% | 1 |  | 281 | 61 |
| 157 | core | `/api/misc/modules` | Tuper only |  |  |  |  |  | 350 | 71 |
| 158 | core | `/api/misc/:module/events` | both answer |  |  | 0% | 4 |  | 280 | 62 |
| 159 | records | `/api/recurring_jobs` | both answer | 1320 | 1072 | 72% | 12 |  | 391 | 181 |
| 160 | records | `/api/recurring_jobs/:uid` | both refuse |  |  |  |  |  | 286 | 96 |
| 161 | records | `/api/invoice` | both answer | 13 | 21 | 97% | 177 | 92% | 307 | 545 |
| 162 | records | `/api/invoice/:uid` | both answer |  |  | 78% | 45 | 90% | 333 | 283 |
| 163 | records | `/api/assets/:uid` | both answer |  |  | 98% | 11 | 93% | 297 | 133 |
| 164 | records | `/api/service_contract` | both answer | 1 | 1 | 84% | 81 | 85% | 311 | 120 |
| 165 | records | `/api/service_contract/:uid` | both answer |  |  | 74% | 4 | 90% | 311 | 160 |
| 166 | records | `/api/product` | both answer | 2074 | 2075 | 55% | 21 |  | 312 | 155 |
| 167 | records | `/api/product/:uid` | both answer |  |  | 66% | 21 | 84% | 304 | 105 |
| 168 | records | `/api/products` | Tuper only |  | 2075 |  |  |  | 280 | 131 |
| 169 | records | `/api/products/:uid` | Tuper only |  |  |  |  |  | 279 | 98 |

Coverage is blank where Zuper returned no fields to compare against. Agreement is blank where the two answers were not the same record (a list whose first page differs) or had no shared fields.

## Appendix B: lists under filters and paging

Sample values (a work order, customer, status, category, user, keyword) were taken from a recent Zuper job and customer.

| List | Query | Z total | T total | Zuper records also in Tuper | Same order | Z ms | T ms |
|---|---|---|---|---|---|---|---|
| jobs | page 1, 100 a page | 46971 | 46975 | 100 of 100 | yes | 682 | 1660 |
| jobs | page 3, 50 a page | 46971 | 46975 | 50 of 50 | yes | 398 | 1438 |
| jobs | oldest first (sort=ASC) | 46971 | 46975 | 25 of 25 | yes | 362 | 562 |
| jobs | by work order number | 1 | 1 | 1 of 1 | yes | 305 | 346 |
| jobs | keyword "Delivery" | 5799 | 5798 | 100 of 100 | yes | 3070 | 2046 |
| jobs | by customer | 33 | 33 | 33 of 33 | yes | 665 | 776 |
| jobs | by current status | 55 | 58 | 55 of 55 | no | 417 | 733 |
| jobs | by category | 976 | 976 | 100 of 100 | yes | 449 | 1461 |
| jobs | by assigned user | 4063 | 4062 | 100 of 100 | yes | 708 | 1474 |
| jobs | by priority LOW | 45742 | 45737 | 100 of 100 | yes | 721 | 986 |
| jobs | scheduled in the last 7 days | 673 | 598 | 66 of 100 | no | 575 | 1645 |
| jobs | updated in the last day | 46971 | 24687 | 100 of 100 | yes | 523 | 1108 |
| jobs | deleted jobs | 2108 | 310 | 84 of 100 | no | 537 | 832 |
| customers | page 1, 100 a page | 4710 | 4731 | 0 of 100 | no | 339 | 288 |
| customers | page 5, 50 a page | 4710 | 4731 | 0 of 50 | no | 315 | 188 |
| customers | keyword (a customer first name) | 3 | 4 | 3 of 3 | no | 2559 | 144 |
| customers | by email | 3 | 4 | 3 of 3 | no | 363 | 153 |
| customers | deleted customers | 51 | 4407 | 0 of 51 | no | 321 | 276 |
| organizations | page 1, 100 a page | 1011 | 1011 | 100 of 100 | yes | 344 | 199 |
| properties | page 1, 100 a page | 1 | 1 | 1 of 1 | yes | 322 | 122 |
| assets | page 1, 100 a page | 2265 | 2267 | 98 of 100 | no | 555 | 747 |
| invoices | page 1, 100 a page | 13 | 21 | 13 of 13 | no | 309 | 474 |
| quotes | page 1, 100 a page | 35 | 38 | 35 of 35 | no | 346 | 594 |
| requests | page 1, 100 a page | 8 | 8 | 8 of 8 | yes | 328 | 206 |
| contracts | page 1, 100 a page | 1 | 1 | 1 of 1 | yes | 307 | 147 |
| products | page 1, 100 a page | 2074 | 2075 | 0 of 100 | no | 393 | 565 |
| users | all users | 55 | 48 | 9 of 10 | no | 300 | 419 |
| teams | teams | 11 | 12 | 11 of 11 | no | 330 | 173 |
| notes | a job's notes | 0 | 0 | 0 of 0 | no | 304 | 312 |
