# Field parity — Zuper's answer against Tuper's, on the owner's account

Run 2026-09-20T22:51:05.421Z by `npm run compare:fields` (src/cli/compare.ts `--fields`, sample 12 per kind).

Read-only on both systems: every call is a GET, or one of the POST …/filter list reads Zuper offers in place of one.

The example columns hold real values from the account — customer names, addresses and email addresses among them.
Run with `--no-examples` for a copy that names the fields and not their contents.

For a sample of real records, each system was asked for the same record by the same Zuper uid and the two answers
compared field by field. Ordering, the formatting of the same instant or number, and empty written two ways are not
differences. Where the comparison cannot settle a difference — an id each system may legitimately answer differently, a
date against a timestamp, array records with no uid to pair them by — it is listed under **Cannot be settled from here**
rather than counted as a field that disagrees.

## What was compared

| records | compared | not in Tuper | not in Zuper | failed | fields that disagree | unsettled | self-check |
|---|---|---|---|---|---|---|---|
| jobs | 12 | 0 | 0 | 0 | 149 | 128 | passed |
| customers | 12 | 0 | 0 | 0 | 28 | 36 | passed |
| organizations | 12 | 0 | 0 | 0 | 5 | 21 | passed |
| users | 11 | 0 | 0 | 0 | 15 | 9 | passed |
| teams | 9 | 0 | 2 | 0 | 22 | 6 | passed |
| assets | 12 | 0 | 0 | 0 | 81 | 66 | passed |
| parts and services | 12 | 0 | 0 | 0 | 14 | 10 | passed |
| requests | 8 | 0 | 0 | 0 | 39 | 32 | passed |
| quotes | 12 | 0 | 0 | 0 | 118 | 114 | passed |
| invoices | 11 | 0 | 0 | 0 | 153 | 108 | passed |
| service contracts | 1 | 0 | 0 | 0 | 33 | 7 | passed |
| timesheet punches | 12 | 0 | 0 | 0 | 6 | 2 | passed |
| time off requests | 12 | 0 | 0 | 0 | 32 | 3 | passed |
| time off types | 5 | 0 | 1 | 0 | 3 | 0 | passed |

**698 fields across 14 record kinds answer differently.**

`self-check` is the instrument checking itself: each kind's first Zuper record is compared with a copy of itself, which must
produce nothing. A kind whose self-check failed cannot be believed. `npm run compare:fields -- --self-test` runs the
engine against a page of known answers without touching either system.

## The differences that matter most

312 of the fields below disagreed on at least half the records of their kind, with no cause already known. The first 30:

| records | field | what | how often | Zuper | Tuper |
|---|---|---|---|---|---|
| jobs | `service_task` | extra_in_tuper | 12/12 | _absent_ | `{"is_enabled":false,"execution_type":"PARALLEL"}` |
| customers | `created_by` | value | 12/12 | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | `null` |
| customers | `custom_fields[]` | element_missing | 12/12 | `{"label":"Zoho CRM Contact ID","value":"4740393000002848032","hide_to_` | _absent_ |
| customers | `customer_notifications.call` | value | 12/12 | `true` | `false` |
| customers | `customer_notifications.sms` | value | 12/12 | `true` | `false` |
| customers | `customer_tags[]` | value | 12/12 | `["Zoho_Contacts_4740393000002848032"]` | `[]` |
| customers | `is_deleted` | extra_in_tuper | 12/12 | _absent_ | `false` |
| organizations | `created_by` | value | 12/12 | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | `null` |
| organizations | `custom_fields[]` | element_missing | 12/12 | `{"label":"Zoho CRM Account ID","value":"4740393000073913017","hide_to_` | _absent_ |
| assets | `billing_address.city` | missing_in_tuper | 12/12 | `Jumeirah Golf Estate` | _absent_ |
| assets | `billing_address.street` | missing_in_tuper | 12/12 | `53 Flame Tree Ridge` | _absent_ |
| assets | `custom_fields[]` | element_missing | 12/12 | `{"label":"Rental Number","value":"","type":"SINGLE_LINE","hide_to_fe":` | _absent_ |
| assets | `id` | extra_in_tuper | 12/12 | _absent_ | `4ddfc9eb-6abe-4a3c-ac51-be83893f0cb3` |
| assets | `useful_life` | value | 12/12 | `{"type":"YEARS","value":null}` | `null` |
| parts and services | `created_by` | missing_in_tuper | 12/12 | `{"user_uid":"9f709f80-e528-4207-99e7-1ff6c56e70f7","first_name":"Mike"` | _absent_ |
| parts and services | `currency` | value | 12/12 | `` | `AED` |
| parts and services | `custom_fields` | extra_in_tuper | 12/12 | _absent_ | `[{"label":"Zoho Inventory Item ID","type":"SINGLE_LINE_TEXT","module_n` |
| parts and services | `markup` | extra_in_tuper | 12/12 | _absent_ | `{"markup_type":null,"markup_value":0}` |
| parts and services | `meta_data[]` | element_extra | 12/12 | _absent_ | `{"label":"Zuper Test","type":"SINGLE_LINE_TEXT","module_name":"PRODUCT` |
| parts and services | `meta_data[]._id` | missing_in_tuper | 12/12 | `657ea1c3fdd08b696d374019` | _absent_ |
| parts and services | `meta_data[].hide_field` | extra_in_tuper | 12/12 | _absent_ | `false` |
| parts and services | `meta_data[].module_name` | extra_in_tuper | 12/12 | _absent_ | `PRODUCT` |
| parts and services | `meta_data[].type` | extra_in_tuper | 12/12 | _absent_ | `SINGLE_LINE_TEXT` |
| parts and services | `original_price` | extra_in_tuper | 12/12 | _absent_ | `29500` |
| quotes | `associations.notes` | missing_in_tuper | 12/12 | `0` | _absent_ |
| quotes | `created_by.role` | extra_in_tuper | 12/12 | _absent_ | `{"role_uid":"77f94c92-0c6d-4ab1-a062-843ce590cf86","role_key":"ADMIN",` |
| quotes | `financing` | value | 12/12 | `{"is_enabled":true}` | `null` |
| quotes | `tax` | value | 12/12 | `[{"_id":"60ffb63d9c526e2b50abe2c8","tax_uid":"a6cc92f0-e937-11eb-b563-` | `4.5` |
| quotes | `taxation_meta` | value | 12/12 | `{"status_history":[]}` | `null` |
| quotes | `total_markup` | extra_in_tuper | 12/12 | _absent_ | `0` |

## jobs

12 records compared — 3 from the first page of Zuper's list, and 9 drawn at random from the 47137 jobs record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `service_task` | extra_in_tuper | 12/12 100% of records | _absent_ | `{"is_enabled":false,"execution_type":"PARALLEL"}` |
| `updated_at` | value (known cause) | 12/12 100% of records | `2026-09-20T15:24:50.700Z` | `2026-09-20T15:24:51.577Z` |
| `assigned_to_team[].team.created_at` | extra_in_tuper | 11/12 92% of records | _absent_ | `2021-07-20T14:11:45.000Z` |
| `assigned_to_team[].team.updated_at` | extra_in_tuper | 11/12 92% of records | _absent_ | `2026-09-20T21:35:50.528Z` |
| `assigned_to[].assigned_at` | value | 11/12 92% of records | `2026-09-20T15:23:48.679Z` | `2026-09-20T15:24:51.710Z` |
| `assigned_to[].user.created_at` | value (known cause) | 11/12 92% of records | `2026-08-13T04:58:03.000Z` | `2026-09-11T15:45:47.712Z` |
| `assigned_to[].user.last_login_at` | value (known cause) | 11/12 92% of records | `2026-09-14T04:39:37.000Z` | `null` |
| `assigned_to[].user.role.created_at` | missing_in_tuper | 11/12 92% of records | `2018-01-22T00:00:00.000Z` | _absent_ |
| `assigned_to[].user.role.role_id` | missing_in_tuper | 11/12 92% of records | `3` | _absent_ |
| `assigned_to[].user.role.updated_at` | missing_in_tuper | 11/12 92% of records | `2018-01-22T00:00:00.000Z` | _absent_ |
| `assigned_to[].user.updated_at` | value (known cause) | 11/12 92% of records | `2026-08-18T09:53:17.000Z` | `2026-09-15T10:40:03.394Z` |
| `service_territory.conflicts[]` | value | 11/12 92% of records | `["NO_TERRITORY_FOUND"]` | `[]` |
| `service_territory.is_conflict` | value | 11/12 92% of records | `true` | `false` |
| `created_by.created_at` | value (known cause) | 10/12 83% of records | `2025-05-18T16:11:55.000Z` | `2026-09-11T15:45:42.992Z` |
| `created_by.last_login_at` | value (known cause) | 10/12 83% of records | `2026-09-16T06:48:21.000Z` | `null` |
| `created_by.role.created_at` | missing_in_tuper | 10/12 83% of records | `2018-01-22T00:00:00.000Z` | _absent_ |
| `created_by.role.role_id` | missing_in_tuper | 10/12 83% of records | `1` | _absent_ |
| `created_by.role.updated_at` | missing_in_tuper | 10/12 83% of records | `2018-01-22T00:00:00.000Z` | _absent_ |
| `created_by.updated_at` | value (known cause) | 10/12 83% of records | `2025-12-24T14:35:47.000Z` | `2026-09-15T10:40:01.171Z` |
| `custom_fields[]._id` | value | 10/12 83% of records | `6aaffa846666d18ba81b9d6a` | `null` |
| `customer.customer_all_addresses` | extra_in_tuper | 10/12 83% of records | _absent_ | `[{"landmark":"","city":"Jumeirah Golf Estates","state":"Dubai","street` |
| `customer.has_card_on_file` | extra_in_tuper | 10/12 83% of records | _absent_ | `false` |
| `customer.no_of_jobs` | extra_in_tuper | 10/12 83% of records | _absent_ | `53` |
| `customer.tax` | extra_in_tuper | 10/12 83% of records | _absent_ | `{"tax_exempt":false}` |
| `customer.updated_at` | value | 10/12 83% of records | `2026-09-15T12:35:59.710Z` | `2026-09-20T19:24:38.011Z` |
| `assigned_to[].team.created_at` | extra_in_tuper | 9/12 75% of records | _absent_ | `2021-07-20T14:11:57.000Z` |
| `assigned_to[].team.team_color` | value | 9/12 75% of records | `#4960a0` | `#27ae60` |
| `assigned_to[].team.team_name` | value | 9/12 75% of records | `JGE Techs` | `Wash & Clean Crew` |
| `assigned_to[].team.updated_at` | extra_in_tuper | 9/12 75% of records | _absent_ | `2026-09-20T21:35:50.779Z` |
| `total_rebate` | extra_in_tuper | 9/12 75% of records | _absent_ | `0` |
| `all_day_schedule` | extra_in_tuper | 8/12 67% of records | _absent_ | `false` |
| `associations.material_requests` | extra_in_tuper | 8/12 67% of records | _absent_ | `0` |
| `associations.pending_documents` | extra_in_tuper | 8/12 67% of records | _absent_ | `0` |
| `associations.purchase_orders` | extra_in_tuper | 8/12 67% of records | _absent_ | `0` |
| `associations.service_orders` | extra_in_tuper | 8/12 67% of records | _absent_ | `0` |
| `associations.total_documents` | extra_in_tuper | 8/12 67% of records | _absent_ | `0` |
| `customer.custom_fields[]` | element_missing | 8/12 67% of records | `{"label":"Zoho CRM Contact ID","value":"4740393000016282131","hide_to_` | _absent_ |
| `gallery` | extra_in_tuper | 8/12 67% of records | _absent_ | `{"is_enabled":true,"gallery_url":"https://tuper.golfbuggyguy.com/dashb` |
| `assigned_to[].user.user_meta_data.burden_rate` | missing_in_tuper | 7/12 58% of records | `{"type":"FIXED","value":0}` | _absent_ |
| `is_dispatchable` | extra_in_tuper | 7/12 58% of records | _absent_ | `true` |
| … | | 109 more, in the JSON | | |

- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `assigned_to[].user.created_at`, `assigned_to[].user.last_login_at`, `assigned_to[].user.updated_at`, `created_by.created_at`, `created_by.last_login_at`, `created_by.updated_at`, `created_by.profile_picture`, `assigned_to[].user.profile_picture`, `job_status[].done_by.created_at`, `job_status[].done_by.last_login_at`, `job_status[].done_by.updated_at`, `job_status[].done_by.profile_picture` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `details_url` | url_host — different host AND path: ap-south-1.zuperpro.com/api/customer_portal/jobs vs tuper.golfbuggyguy.com/dashboard/jobs/3ed13435-070d-4f88-872f-9d05f6221e6b | 12/12 |
| `feedback_url` | url_host — different host AND path: ap-south-1.zuperpro.com/api/customer_portal/feedback vs tuper.golfbuggyguy.com/dashboard/jobs/3ed13435-070d-4f88-872f-9d05f6221e6b | 12/12 |
| `job_status[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 12/12 |
| `job_status[].done_by.role.role_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 12/12 |
| `assigned_to[].user.role.role_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 11/12 |
| `created_by.role.role_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 10/12 |
| `assigned_to[].team.team_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 9/12 |
| `job_status[].done_by.created_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 9/12 |
| `job_status[].done_by.last_login_at` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 9/12 |
| `job_status[].done_by.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/2322c28a-5af1-4ade-86e6-5cdd5cfe53f0.jpeg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/70da7e7f-7e88-4404-b99a-b41a2aac4449-74f4189a0359.jpg | 9/12 |
| `job_status[].done_by.role.created_at` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 9/12 |
| `job_status[].done_by.role.role_id` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 9/12 |
| `job_status[].done_by.role.updated_at` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 9/12 |
| `job_status[].done_by.updated_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 9/12 |
| `job_status[].status_history_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 9/12 |
| `job_status[].updated_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 9/12 |
| `assigned_to[].user.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/db8120d3-9b51-4b5e-ad95-2089824a2070.jpeg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/9879f534-9584-4b5d-8614-6b5c72bf2ad6-087dc533b4a6.jpg | 8/12 |
| `job_status[].synced_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 8/12 |
| `created_by.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/2322c28a-5af1-4ade-86e6-5cdd5cfe53f0.jpeg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/70da7e7f-7e88-4404-b99a-b41a2aac4449-74f4189a0359.jpg | 6/12 |
| `job_status[].category` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 6/12 |
| `job_status[].created_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 6/12 |
| `job_status[].done_by.user_meta_data.burden_rate` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 6/12 |
| `job_status[].status_color` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 6/12 |
| `job_status[].status_name` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 6/12 |
| `job_status[].status_type` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 6/12 |
| … | 34 more, in the JSON | |

69 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (51): `job_status[].remarks`, `job_status[].remarks_free_text`, `assigned_to_team[].team.team_description`, `customer.accounts.tax`, `customer.additional_emails`, `customer.customer_address.geo_cordinates`, `customer.customer_billing_address.geo_cordinates`, `recurring_job`, `customer_address.geo_cordinates`, `customer_billing_address.geo_cordinates`, `discount_breakups`, `rebates`, `assigned_to[].team.team_description`, `customer.customer_address.email`, `customer.customer_address.first_name`, `customer.customer_address.last_name`, `customer.customer_address.phone_number`, `parent_job`, `cover_image`, `customer.customer_billing_address.email`, `customer.customer_billing_address.first_name`, `customer.customer_billing_address.last_name`, `customer.customer_billing_address.phone_number`, `due_date`, `due_date_dt` …
- Zuper sends empty, Tuper omits (18): `external_id.hubspot_deal`, `external_id.hubspot_ticket`, `job_status[].done_by.user_meta_data.labor_type_uid`, `assigned_to[].user.user_meta_data.labor_type_uid`, `created_by.user_meta_data.labor_type_uid`, `job_status[].customer_signature`, `customer.customer_address.property_id`, `job_status[].time_on_status`, `business_unit`, `assets[].remarks`, `customer.customer_category`, `route`, `assigned_to[].user.user_meta_data.burden_rate`, `customer.customer_organization.organization_description`, `customer.customer_organization.organization_email`, `job_status[].done_by.user_meta_data.burden_rate`, `created_by.user_meta_data.burden_rate`, `customer.source`

Agreed although written differently: empty_shape ×35, whitespace ×9, same_instant ×6.

## customers

12 records compared — 3 from the first page of Zuper's list, and 9 drawn at random from the 4714 customers record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_by` | value | 12/12 100% of records | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | `null` |
| `custom_fields[]` | element_missing | 12/12 100% of records | `{"label":"Zoho CRM Contact ID","value":"4740393000002848032","hide_to_` | _absent_ |
| `customer_notifications.call` | value | 12/12 100% of records | `true` | `false` |
| `customer_notifications.sms` | value | 12/12 100% of records | `true` | `false` |
| `customer_tags[]` | value | 12/12 100% of records | `["Zoho_Contacts_4740393000002848032"]` | `[]` |
| `is_deleted` | extra_in_tuper | 12/12 100% of records | _absent_ | `false` |
| `updated_at` | value (known cause) | 12/12 100% of records | `2026-09-15T11:12:45.008Z` | `2026-09-15T10:36:21.071Z` |
| `customer_all_addresses[]` | array_length | 10/12 83% of records | `2` | `1` |
| `customer_billing_address.city` | value | 8/12 67% of records | `Jumeirah Golf Estates` | `Dubai` |
| `customer_address.city` | value | 5/12 42% of records | `Jumeirah Golf Estates` | `Dubai` |
| `customer_billing_address.street` | value | 4/12 33% of records | `F50 Jumeirah Luxury Living` | `F50 Jumeirah Luxury Living, Jumeirah Golf Estates` |
| `customer_address.street` | value | 2/12 17% of records | `Parkway Vista Villa 15` | `Parkway Vista Villa 15, Dubai Hills` |
| `accounts._id` | missing_in_tuper | 1/12 8% of records | `6727260b7715c70ea7a1a156` | _absent_ |
| `auto_charge._id` | missing_in_tuper | 1/12 8% of records | `6727260b7715c70ea7a1a155` | _absent_ |
| `customer_address.state` | value | 1/12 8% of records | `Dubai` | `` |
| `customer_billing_address.state` | value | 1/12 8% of records | `Dubai` | `` |
| `customer_billing_address.zip_code` | value | 1/12 8% of records | `PO Box 500372` | `null` |
| `customer_contact_no._id` | missing_in_tuper | 1/12 8% of records | `6727260b7715c70ea7a1a15b` | _absent_ |
| `customer_notifications._id` | missing_in_tuper | 1/12 8% of records | `6727260b7715c70ea7a1a157` | _absent_ |
| `customer_organization` | missing_in_tuper | 1/12 8% of records | `{"is_active":true,"is_deleted":false,"organization_name":"Eventify Ent` | _absent_ |
| `customer_organization.created_at` | missing_in_tuper | 1/12 8% of records | `2022-05-09T10:48:09.075Z` | _absent_ |
| `customer_organization.custom_fields` | missing_in_tuper | 1/12 8% of records | `[{"label":"Zoho CRM Account ID","value":"4740393000011272077","hide_to` | _absent_ |
| `customer_organization.is_active` | missing_in_tuper | 1/12 8% of records | `true` | _absent_ |
| `customer_organization.is_deleted` | missing_in_tuper | 1/12 8% of records | `false` | _absent_ |
| `customer_organization.tax` | missing_in_tuper | 1/12 8% of records | `{"tax_exempt":false}` | _absent_ |
| `customer_organization.updated_at` | missing_in_tuper | 1/12 8% of records | `2025-01-05T14:06:34.379Z` | _absent_ |
| `portal_permissions._id` | missing_in_tuper | 1/12 8% of records | `6727260b7715c70ea7a1a150` | _absent_ |
| `tax._id` | missing_in_tuper | 1/12 8% of records | `6727260b7715c70ea7a1a151` | _absent_ |

- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `customer_all_addresses[]._id` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/12 |
| `customer_all_addresses[].is_primary` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/12 |

34 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (31): `accounts.billing_frequency`, `accounts.payment_term`, `accounts.tax_group`, `deactivated_at`, `delete_remarks`, `merged_into`, `sla_duration`, `tax.customer_code`, `tax.entity_use_code`, `tax.tax_exempt_number`, `tax.tax_exempt_remarks`, `tax.tax_provider`, `customer_address.email`, `customer_address.first_name`, `customer_address.geo_cordinates`, `customer_address.last_name`, `customer_address.phone_number`, `customer_billing_address.geo_cordinates`, `customer_category`, `customer_billing_address.email`, `customer_billing_address.first_name`, `customer_billing_address.last_name`, `customer_billing_address.phone_number`, `customer_address.landmark`, `customer_address.zip_code` …
- Zuper sends empty, Tuper omits (3): `customer_address.property`, `customer_organization.organization_description`, `customer_organization.organization_email`

Agreed although written differently: empty_shape ×4.

## organizations

12 records compared — 3 from the first page of Zuper's list, and 9 drawn at random from the 1011 organizations record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_by` | value | 12/12 100% of records | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | `null` |
| `custom_fields[]` | element_missing | 12/12 100% of records | `{"label":"Zoho CRM Account ID","value":"4740393000073913017","hide_to_` | _absent_ |
| `updated_at` | value (known cause) | 12/12 100% of records | `2026-09-18T12:03:22.730Z` | `2026-09-18T12:03:23.026Z` |
| `no_of_customers` | value | 5/12 42% of records | `2` | `0` |
| `markdown_description` | value | 1/12 8% of records | `Interested in rental of 3x Mule buggies from 2 February - 2 March 2023` | `null` |

- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.

21 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (21): `organization_logo`, `pricelist`, `tax.customer_code`, `tax.entity_use_code`, `tax.tax_exempt_number`, `tax.tax_exempt_remarks`, `tax.tax_provider`, `additional_emails`, `organization_address.email`, `organization_address.first_name`, `organization_address.geo_cordinates`, `organization_address.last_name`, `organization_address.phone_number`, `organization_billing_address.email`, `organization_billing_address.first_name`, `organization_billing_address.geo_cordinates`, `organization_billing_address.last_name`, `organization_billing_address.phone_number`, `tax.tax_group`, `organization_address`, `organization_billing_address`

Agreed although written differently: empty_shape ×35.

## users

11 records compared — 3 from the first page of Zuper's list, and 8 drawn at random from the 54 users record(s) Tuper has mapped to a Zuper uid.

_only active users are given a Tuper account (owner decision 2026-09-11), so an inactive user from Zuper's list is recorded as not found rather than as a difference_

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_at` | value (known cause) | 11/11 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `custom_fields[]` | element_missing | 11/11 100% of records | `{"label":"Nickname","value":"","type":"SINGLE_LINE","hide_to_fe":false` | _absent_ |
| `labor_charges_enabled` | extra_in_tuper | 11/11 100% of records | _absent_ | `false` |
| `last_login_at` | value (known cause) | 11/11 100% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `updated_at` | value (known cause) | 11/11 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `access_role` | value | 9/11 82% of records | `{"access_role_uid":"bac078d1-6147-494c-b04f-aef700a7a0d1","role_name":` | `null` |
| `created_by` | value | 8/11 73% of records | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | `null` |
| `custom_field_internal_object.EMPLOYEE_Nickname_1` | missing_in_tuper | 6/11 55% of records | `Thara` | _absent_ |
| `meta_data.burden_rate` | value | 6/11 55% of records | `{"type":"FIXED","value":0}` | `null` |
| `meta_data.upcoming_job_visibility` | missing_in_tuper | 6/11 55% of records | `ALL` | _absent_ |
| `profile_picture` | value (known cause) | 6/11 55% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `meta_data` | value | 5/11 45% of records | `null` | `{"worker_comp_code":"","burden_rate":null}` |
| `is_deleted` | value | 2/11 18% of records | `false` | `true` |
| `emp_code` | value | 1/11 9% of records | `Mechanic` | `null` |
| `meta_data.default_product_location` | missing_in_tuper | 1/11 9% of records | `bcf8cce0-89d7-11ee-a09b-c3557f7a0d39` | _absent_ |

- `created_at`, `last_login_at`, `profile_picture` — Tuper's users were created at the import (2026-09-11) with no password and no invite (owner decision), so their created_at is the import, they have never signed in, and their picture is not Zuper's S3 copy.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `role.role_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 11/11 |
| `profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/32ba8796-3390-4ad9-b79e-f05603bedf88.jpg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/14ad187b-8bda-479d-addc-5f74baa7a907-6197e47b96c5.jpg | 5/11 |

7 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (1): `user_meta_data`
- Zuper sends empty, Tuper omits (6): `meta_data.base_location`, `meta_data.base_location_geo`, `meta_data.dispatch_board`, `meta_data.labor_type_uid`, `meta_data.default_product_location`, `custom_field_internal_object.EMPLOYEE_Nickname_1`

Agreed although written differently: whitespace ×6.

## teams

9 records compared — 3 from the first page of Zuper's list, and 8 drawn at random from the 14 teams record(s) Tuper has mapped to a Zuper uid.

_the record is the whole { team, users } envelope Zuper answers for a team, both sides compared as sent_

Tuper holds 2 sampled records Zuper does not answer for: c01559d4-1025-4d18-b2a2-a602c635179c, 270f51ca-1898-4ae9-bd89-0514be3461e3.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `team.updated_at` | value | 9/9 100% of records | `2026-09-18T08:12:13.000Z` | `2026-09-20T21:35:50.528Z` |
| `users[].access_role` | value | 9/9 100% of records | `{"access_role_uid":"bac078d1-6147-494c-b04f-aef700a7a0d1","role_name":` | `null` |
| `users[].created_at` | value (known cause) | 9/9 100% of records | `2021-07-20T14:16:31.000Z` | `2026-09-11T15:45:36.531Z` |
| `users[].is_team_leader` | extra_in_tuper | 9/9 100% of records | _absent_ | `false` |
| `users[].labor_charges_enabled` | extra_in_tuper | 9/9 100% of records | _absent_ | `false` |
| `users[].last_login_at` | value (known cause) | 9/9 100% of records | `2026-08-31T04:53:29.000Z` | `null` |
| `users[].meta_data` | extra_in_tuper | 9/9 100% of records | _absent_ | `{"worker_comp_code":"","burden_rate":null}` |
| `users[].profile_picture` | value (known cause) | 9/9 100% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `users[].updated_at` | value (known cause) | 9/9 100% of records | `2026-03-06T17:19:26.000Z` | `2026-09-15T10:39:59.003Z` |
| `users[].emp_code` | value | 7/9 78% of records | `Cleaner` | `null` |
| `team.created_by.created_at` | value (known cause) | 6/9 67% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `team.created_by.last_login_at` | value (known cause) | 6/9 67% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `team.created_by.profile_picture` | value (known cause) | 6/9 67% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `team.created_by.role` | extra_in_tuper | 6/9 67% of records | _absent_ | `{"role_uid":"77f94c92-0c6d-4ab1-a062-843ce590cf86","role_key":"ADMIN",` |
| `team.created_by.updated_at` | value (known cause) | 6/9 67% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `team.user_count` | value | 3/9 33% of records | `16` | `15` |
| `users[]` | element_missing | 3/9 33% of records | `{"user_uid":"9003902f-c0f7-44c0-ae57-f921722e9c78","first_name":"Rick"` | _absent_ |
| `users[].access_role.access_role_description` | extra_in_tuper | 2/9 22% of records | _absent_ | `Full access (Tuper default)` |
| `users[].access_role.access_role_name` | extra_in_tuper | 2/9 22% of records | _absent_ | `Administrator` |
| `users[].access_role.is_active` | extra_in_tuper | 2/9 22% of records | _absent_ | `true` |
| `users[].access_role.role_description` | missing_in_tuper | 2/9 22% of records | `Full Access` | _absent_ |
| `users[].access_role.role_name` | missing_in_tuper | 2/9 22% of records | `Super Admin` | _absent_ |

- `users[].created_at`, `users[].last_login_at`, `users[].profile_picture`, `users[].updated_at`, `team.created_by.created_at`, `team.created_by.last_login_at`, `team.created_by.profile_picture`, `team.created_by.updated_at` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `users[].profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/32ba8796-3390-4ad9-b79e-f05603bedf88.jpg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/14ad187b-8bda-479d-addc-5f74baa7a907-6197e47b96c5.jpg | 9/9 |
| `users[].role.role_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 9/9 |
| `users[].access_role.access_role_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 2/9 |

3 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (3): `users[].business_units`, `users[].created_by`, `users[].user_meta_data`

Agreed although written differently: empty_shape ×24, whitespace ×13.

## assets

12 records compared — 3 from the first page of Zuper's list, and 9 drawn at random from the 2265 assets record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `billing_address.city` | missing_in_tuper | 12/12 100% of records | `Jumeirah Golf Estate` | _absent_ |
| `billing_address.street` | missing_in_tuper | 12/12 100% of records | `53 Flame Tree Ridge` | _absent_ |
| `custom_fields[]` | element_missing | 12/12 100% of records | `{"label":"Rental Number","value":"","type":"SINGLE_LINE","hide_to_fe":` | _absent_ |
| `id` | extra_in_tuper | 12/12 100% of records | _absent_ | `4ddfc9eb-6abe-4a3c-ac51-be83893f0cb3` |
| `updated_at` | value (known cause) | 12/12 100% of records | `2026-05-31T12:47:55.856Z` | `2026-09-15T10:38:05.070Z` |
| `useful_life` | value | 12/12 100% of records | `{"type":"YEARS","value":null}` | `null` |
| `asset_location.city` | missing_in_tuper | 11/12 92% of records | `Jumeirah Golf Estate` | _absent_ |
| `asset_location.street` | missing_in_tuper | 11/12 92% of records | `53 Flame Tree Ridge` | _absent_ |
| `billing_address.state` | missing_in_tuper | 11/12 92% of records | `Dubai` | _absent_ |
| `created_by` | value | 11/12 92% of records | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | `null` |
| `asset_category.category_description` | value | 10/12 83% of records | `Not to be Used` | `null` |
| `asset_location.state` | missing_in_tuper | 10/12 83% of records | `Dubai` | _absent_ |
| `billing_address.first_name` | missing_in_tuper | 10/12 83% of records | `Will` | _absent_ |
| `billing_address.last_name` | missing_in_tuper | 10/12 83% of records | `Moroney` | _absent_ |
| `__v` | value | 9/12 75% of records | `10` | `0` |
| `asset_location.email` | missing_in_tuper | 9/12 75% of records | `willmoroney@outlook.com` | _absent_ |
| `asset_location.first_name` | missing_in_tuper | 9/12 75% of records | `Will` | _absent_ |
| `asset_location.last_name` | missing_in_tuper | 9/12 75% of records | `Moroney` | _absent_ |
| `asset_location.point_coordinates` | missing_in_tuper | 9/12 75% of records | `{"type":"Point","coordinates":[55.20057502252731,25.026917537006018]}` | _absent_ |
| `billing_address.email` | missing_in_tuper | 9/12 75% of records | `willmoroney@outlook.com` | _absent_ |
| `billing_address.geo_cordinates` | missing_in_tuper | 9/12 75% of records | `[25.026917537006018,55.20057502252731]` | _absent_ |
| `billing_address.phone_number` | missing_in_tuper | 9/12 75% of records | `(971)(50)457-1508` | _absent_ |
| `billing_address.point_coordinates` | missing_in_tuper | 9/12 75% of records | `{"type":"Point","coordinates":[55.20057502252731,25.026917537006018]}` | _absent_ |
| `customer.customer_address` | extra_in_tuper | 9/12 75% of records | _absent_ | `{"landmark":"","city":"Jumeirah Golf Estates","state":"Dubai","street"` |
| `customer.customer_all_addresses` | extra_in_tuper | 9/12 75% of records | _absent_ | `[{"landmark":"","city":"Jumeirah Golf Estates","state":"Dubai","street` |
| `customer.customer_billing_address` | extra_in_tuper | 9/12 75% of records | _absent_ | `{"landmark":"","city":"Jumeirah Golf Estate","state":"Dubai","street":` |
| `customer.has_card_on_file` | extra_in_tuper | 9/12 75% of records | _absent_ | `false` |
| `customer.no_of_jobs` | extra_in_tuper | 9/12 75% of records | _absent_ | `24` |
| `customer.tax` | extra_in_tuper | 9/12 75% of records | _absent_ | `{"tax_exempt":false}` |
| `customer.updated_at` | value | 9/12 75% of records | `2026-09-15T11:15:11.696Z` | `2026-09-15T10:36:21.067Z` |
| `asset_location.geo_cordinates` | missing_in_tuper | 8/12 67% of records | `[25.026917537006018,55.20057502252731]` | _absent_ |
| `asset_location.phone_number` | missing_in_tuper | 8/12 67% of records | `(971)(50)457-1508` | _absent_ |
| `customer.custom_fields[]` | element_missing | 8/12 67% of records | `{"label":"Zoho CRM Contact ID","value":"4740393000000610091","hide_to_` | _absent_ |
| `organization` | value | 6/12 50% of records | `{"organization_uid":"0b49c642-e09a-482c-bea6-53d86870c6f9","organizati` | `null` |
| `owned_by_customer` | value | 6/12 50% of records | `false` | `true` |
| `asset_location.country` | missing_in_tuper | 5/12 42% of records | `United Arab Emirates` | _absent_ |
| `billing_address.country` | missing_in_tuper | 5/12 42% of records | `United Arab Emirates` | _absent_ |
| `custom_field_internal_object.asset_amc_type_1` | missing_in_tuper | 5/12 42% of records | `No AMC` | _absent_ |
| `asset_image` | value | 4/12 33% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5de` | `null` |
| `custom_field_internal_object.asset_battery_type_1` | missing_in_tuper | 4/12 33% of records | `150ah 72v` | _absent_ |
| … | | 41 more, in the JSON | | |

- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `created_by.created_at`, `created_by.last_login_at`, `created_by.profile_picture`, `created_by.updated_at` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.

66 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (15): `additional_info`, `asset_barcode`, `location`, `asset_manufacturer`, `asset_model`, `customer.accounts.tax`, `customer.customer_description`, `customer.plain_text_description`, `placed_in_service`, `purchase_date`, `asset_product`, `warranty_expiry_date`, `asset_category.category_description`, `asset_location.country`, `created_by.user_meta_data`
- Zuper sends empty, Tuper omits (51): `custom_field_internal_object.asset_amc_expiry_1`, `custom_field_internal_object.asset_insurance_ref_1`, `custom_field_internal_object.asset_jge_registration_doc_1`, `custom_field_internal_object.asset_rfid_code_1`, `billing_address.landmark`, `custom_field_internal_object.asset_gps_iot_picture_1`, `custom_field_internal_object.asset_gps_ref_number_1`, `custom_field_internal_object.asset_handover_form_1`, `asset_location.landmark`, `billing_address.zip_code`, `custom_field_internal_object.asset_amc_contract_1`, `custom_field_internal_object.asset_battery_manufacturer_1`, `custom_field_internal_object.asset_community_reg_number_1`, `custom_field_internal_object.asset_dc_s_n_1`, `custom_field_internal_object.asset_notes_comments_1`, `custom_field_internal_object.asset_rear_axle_s_n_1`, `asset_location.zip_code`, `custom_field_internal_object.asset_ampcore_warranty_1`, `custom_field_internal_object.asset_battery_type_1`, `custom_field_internal_object.asset_charger_s_n_1`, `custom_field_internal_object.asset_ignition_code_1`, `custom_field_internal_object.asset_controller_s_n_1`, `custom_field_internal_object.asset_motor_s_n_1`, `custom_field_internal_object.asset_battery_s_n_1`, `custom_field_internal_object.asset_rental_number_1` …

Agreed although written differently: empty_shape ×2.

## parts and services

12 records compared — 3 from the first page of Zuper's list, and 9 drawn at random from the 2074 products record(s) Tuper has mapped to a Zuper uid.

_Zuper serves a product at /api/product/{uid} (singular) and answers 404 at /api/products/{uid}; Tuper answers both_

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_by` | missing_in_tuper | 12/12 100% of records | `{"user_uid":"9f709f80-e528-4207-99e7-1ff6c56e70f7","first_name":"Mike"` | _absent_ |
| `currency` | value | 12/12 100% of records | `` | `AED` |
| `custom_fields` | extra_in_tuper | 12/12 100% of records | _absent_ | `[{"label":"Zoho Inventory Item ID","type":"SINGLE_LINE_TEXT","module_n` |
| `markup` | extra_in_tuper | 12/12 100% of records | _absent_ | `{"markup_type":null,"markup_value":0}` |
| `meta_data[]` | element_extra | 12/12 100% of records | _absent_ | `{"label":"Zuper Test","type":"SINGLE_LINE_TEXT","module_name":"PRODUCT` |
| `meta_data[]._id` | missing_in_tuper | 12/12 100% of records | `657ea1c3fdd08b696d374019` | _absent_ |
| `meta_data[].hide_field` | extra_in_tuper | 12/12 100% of records | _absent_ | `false` |
| `meta_data[].module_name` | extra_in_tuper | 12/12 100% of records | _absent_ | `PRODUCT` |
| `meta_data[].type` | extra_in_tuper | 12/12 100% of records | _absent_ | `SINGLE_LINE_TEXT` |
| `original_price` | extra_in_tuper | 12/12 100% of records | _absent_ | `29500` |
| `updated_at` | extra_in_tuper (known cause) | 12/12 100% of records | _absent_ | `2026-09-15T10:30:45.646Z` |
| `markdown_description` | value | 4/12 33% of records | `System: 48V 4KW AC system Batteries: Trojan T-875 Controller: 350A Cha` | `` |
| `uom` | extra_in_tuper | 3/12 25% of records | _absent_ | `pcs` |
| `low_stock` | extra_in_tuper | 1/12 8% of records | _absent_ | `false` |

- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `product_category.category_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 12/12 |
| `location_availability[]._id` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 10/12 |
| `location_availability[].created_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 10/12 |
| `location_availability[].location.location_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 10/12 |

6 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (6): `reorder_level`, `specification`, `tax.entity_use_code`, `tax.tax_exempt_number`, `tax.tax_exempt_remarks`, `brand`

Agreed although written differently: empty_shape ×25, whitespace ×3.

## requests

8 records compared — 3 from the first page of Zuper's list, and 5 drawn at random from the 8 requests record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `billing_address._id` | missing_in_tuper | 8/8 100% of records | `69932c8cca8c2a3dcb3efd66` | _absent_ |
| `customer.accounts` | extra_in_tuper | 8/8 100% of records | _absent_ | `{"ltv":0,"receivables":0,"credits":0,"tax":{}}` |
| `customer.created_at` | extra_in_tuper | 8/8 100% of records | _absent_ | `2025-10-01T17:26:28.529Z` |
| `customer.customer_all_addresses` | extra_in_tuper | 8/8 100% of records | _absent_ | `[{"landmark":"","city":"Dubai","state":"Dubai","street":"Dubai Mall - ` |
| `customer.customer_billing_address` | extra_in_tuper | 8/8 100% of records | _absent_ | `{"landmark":"","city":"Dubai","state":"Dubai","street":"Dubai Mall - D` |
| `customer.has_card_on_file` | extra_in_tuper | 8/8 100% of records | _absent_ | `false` |
| `customer.no_of_jobs` | extra_in_tuper | 8/8 100% of records | _absent_ | `0` |
| `customer.tax` | extra_in_tuper | 8/8 100% of records | _absent_ | `{"tax_exempt":false}` |
| `customer.updated_at` | extra_in_tuper | 8/8 100% of records | _absent_ | `2026-09-15T10:37:44.397Z` |
| `request_preferred_date1._id` | missing_in_tuper | 8/8 100% of records | `69932c8cca8c2a3dcb3efd60` | _absent_ |
| `request_preferred_date1.end_time` | value | 8/8 100% of records | `2026-02-18T08:30:00.000Z` | `null` |
| `request_priority` | extra_in_tuper | 8/8 100% of records | _absent_ | `LOW` |
| `request_source.__v` | missing_in_tuper | 8/8 100% of records | `0` | _absent_ |
| `request_source.created_at` | missing_in_tuper | 8/8 100% of records | `2025-05-13T13:37:07.879Z` | _absent_ |
| `request_source.created_by` | missing_in_tuper | 8/8 100% of records | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | _absent_ |
| `request_source.display_order` | missing_in_tuper | 8/8 100% of records | `1` | _absent_ |
| `request_source.is_deleted` | missing_in_tuper | 8/8 100% of records | `false` | _absent_ |
| `request_source.request_source_description` | missing_in_tuper | 8/8 100% of records | `Customer portal` | _absent_ |
| `request_source.request_source_uid` | missing_in_tuper | 8/8 100% of records | `ab195a01-2941-4afe-8eb4-5529954d563e` | _absent_ |
| `request_source.updated_at` | missing_in_tuper | 8/8 100% of records | `2025-05-13T13:37:07.879Z` | _absent_ |
| `request_status.status_color` | missing_in_tuper | 8/8 100% of records | `#27ae60` | _absent_ |
| `request_status.status_name` | value | 8/8 100% of records | `Open` | `New` |
| `request_status.status_uid` | missing_in_tuper | 8/8 100% of records | `c4c6e160-ab48-4b1d-a01f-f723319bc084` | _absent_ |
| `service_address._id` | missing_in_tuper | 8/8 100% of records | `69932c8cca8c2a3dcb3efd67` | _absent_ |
| `status_history` | missing_in_tuper | 8/8 100% of records | `[{"status_uid":"c4c6e160-ab48-4b1d-a01f-f723319bc084","status_color":"` | _absent_ |
| `updated_at` | value (known cause) | 8/8 100% of records | `2026-02-16T14:41:16.451Z` | `2026-09-15T10:38:44.470Z` |
| `organization` | missing_in_tuper | 7/8 88% of records | `{"organization_uid":"1e071c80-7240-11ee-a8aa-854b1b70c6b4","organizati` | _absent_ |
| `request_status._id` | missing_in_tuper | 7/8 88% of records | `69932b2172640c9d7589401e` | _absent_ |
| `request_status.status_type` | value | 7/8 88% of records | `OPEN` | `NEW` |
| `customer.customer_organization` | extra_in_tuper | 6/8 75% of records | _absent_ | `{"organization_uid":"1e071c80-7240-11ee-a8aa-854b1b70c6b4","organizati` |
| `asset` | missing_in_tuper | 5/8 63% of records | `{"asset_uid":"3cce6b18-2ec8-4e8c-be48-71ae748932b6","asset_code":"(OP)` | _absent_ |
| `is_converted` | missing_in_tuper | 5/8 63% of records | `true` | _absent_ |
| `request_preferred_date2._id` | missing_in_tuper | 4/8 50% of records | `69932c8cca8c2a3dcb3efd61` | _absent_ |
| `request_preferred_date2.end_time` | value | 4/8 50% of records | `2026-02-18T08:30:00.000Z` | `null` |
| `plain_text_description` | extra_in_tuper | 3/8 38% of records | _absent_ | `hi, please etc etc.. test` |
| `markdown_description` | missing_in_tuper | 2/8 25% of records | `Please Ignore` | _absent_ |
| `billing_address.geo_cordinates[]` | value | 1/8 13% of records | `[25.1972295,55.279747]` | `[]` |
| `customer.customer_address.point_coordinates` | missing_in_tuper | 1/8 13% of records | `{"type":"Point","coordinates":[55.279747,25.1972295]}` | _absent_ |
| `service_address.geo_cordinates[]` | value | 1/8 13% of records | `[25.1972295,55.279747]` | `[]` |

- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `request_description` | markup — the same words, different HTML | 5/8 |

31 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (24): `billing_address.email`, `billing_address.first_name`, `billing_address.last_name`, `billing_address.phone_number`, `customer.custom_fields`, `customer.customer_description`, `customer.plain_text_description`, `service_address.email`, `service_address.first_name`, `service_address.last_name`, `service_address.phone_number`, `billing_address.geo_cordinates`, `customer.customer_address.geo_cordinates`, `service_address.geo_cordinates`, `customer.customer_address.email`, `customer.customer_address.first_name`, `customer.customer_address.landmark`, `customer.customer_address.last_name`, `customer.customer_address.phone_number`, `customer.customer_address.zip_code`, `customer.customer_contact_no.home`, `customer.customer_contact_no.work`, `plain_text_description`, `customer.customer_address.country`
- Zuper sends empty, Tuper omits (7): `assigned_to`, `assigned_to_team`, `attachments`, `created_by`, `custom_fields`, `customer.customer_address.property_id`, `markdown_description`

Agreed although written differently: empty_shape ×26, whitespace ×15, same_number ×8.

## quotes

12 records compared — 3 from the first page of Zuper's list, and 9 drawn at random from the 35 estimates record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `associations.notes` | missing_in_tuper | 12/12 100% of records | `0` | _absent_ |
| `created_by.created_at` | value (known cause) | 12/12 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `created_by.role` | extra_in_tuper | 12/12 100% of records | _absent_ | `{"role_uid":"77f94c92-0c6d-4ab1-a062-843ce590cf86","role_key":"ADMIN",` |
| `created_by.updated_at` | value (known cause) | 12/12 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `financing` | value | 12/12 100% of records | `{"is_enabled":true}` | `null` |
| `tax` | value | 12/12 100% of records | `[{"_id":"60ffb63d9c526e2b50abe2c8","tax_uid":"a6cc92f0-e937-11eb-b563-` | `4.5` |
| `taxation_meta` | value | 12/12 100% of records | `{"status_history":[]}` | `null` |
| `total_markup` | extra_in_tuper | 12/12 100% of records | _absent_ | `0` |
| `updated_at` | value (known cause) | 12/12 100% of records | `2025-06-25T11:49:19.631Z` | `2026-09-17T17:19:47.885Z` |
| `created_by.last_login_at` | value (known cause) | 11/12 92% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `created_by.profile_picture` | value (known cause) | 11/12 92% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `customer_name` | value | 11/12 92% of records | `Suraj R` | `` |
| `customer.accounts.tax.tax_exempt` | missing_in_tuper | 11/12 92% of records | `false` | _absent_ |
| `customer.custom_fields[]` | element_missing | 11/12 92% of records | `{"label":"Zoho CRM Contact ID","value":"4740393000002598046","hide_to_` | _absent_ |
| `customer.customer_all_addresses[]` | array_length | 11/12 92% of records | `2` | `0` |
| `customer.customer_first_name` | value | 11/12 92% of records | `Suraj` | `` |
| `customer.customer_last_name` | value | 11/12 92% of records | `R` | `` |
| `customer.customer_uid` | value | 11/12 92% of records | `397c98d0-eeaa-11eb-89c3-8313a5f2ea62` | `null` |
| `customer.no_of_jobs` | extra_in_tuper | 11/12 92% of records | _absent_ | `0` |
| `customer.updated_at` | value | 11/12 92% of records | `2026-07-02T15:25:56.148Z` | `2026-09-12T14:02:11.445Z` |
| `estimate_date` | value | 11/12 92% of records | `2021-07-26T18:30:00.000Z` | `2021-07-26T00:00:00.000Z` |
| `template.is_deleted` | missing_in_tuper | 11/12 92% of records | `false` | _absent_ |
| `template.template` | missing_in_tuper | 11/12 92% of records | `<meta charset="utf-8">     <title>Quotation</title>      <link href="h` | _absent_ |
| `template.template_description` | missing_in_tuper | 11/12 92% of records | `Quotation Template` | _absent_ |
| `template.template_options` | missing_in_tuper | 11/12 92% of records | `{"format":"A4","orientation":"portrait"}` | _absent_ |
| `template.type` | missing_in_tuper | 11/12 92% of records | `ESTIMATE` | _absent_ |
| `customer.customer_email` | value | 10/12 83% of records | `suraj.zuper@gmail.com` | `` |
| `deposit_payment_url` | extra_in_tuper | 10/12 83% of records | _absent_ | `https://os.golfbuggyguy.com/quotes/07fe1610-eeac-11eb-89c3-8313a5f2ea6` |
| `is_proposal` | extra_in_tuper | 10/12 83% of records | _absent_ | `false` |
| `waiting_on_mr` | extra_in_tuper | 10/12 83% of records | _absent_ | `false` |
| `waiting_on_po` | extra_in_tuper | 10/12 83% of records | _absent_ | `false` |
| `custom_fields[].type` | value | 9/12 75% of records | `SINGLE_LINE` | `SINGLE_LINE_TEXT` |
| `deposit.status` | extra_in_tuper | 9/12 75% of records | _absent_ | `NOT_COLLECTED` |
| `deposit.total` | extra_in_tuper | 9/12 75% of records | _absent_ | `0` |
| `discount` | extra_in_tuper | 9/12 75% of records | _absent_ | `0` |
| `expiry_date` | value | 9/12 75% of records | `2021-07-30T18:30:00.000Z` | `2021-07-30T00:00:00.000Z` |
| `line_items[].discount_type` | value | 9/12 75% of records | `FIXED` | `AMOUNT` |
| `line_items[].line_item_type` | extra_in_tuper | 9/12 75% of records | _absent_ | `ITEM` |
| `line_items[].line_item_uid` | extra_in_tuper | 9/12 75% of records | _absent_ | `50a6e2e9-c299-488a-8769-56c9228f9eb3` |
| `line_items[].product_id` | value | 9/12 75% of records | `1` | `null` |
| … | | 78 more, in the JSON | | |

- `created_by.created_at`, `created_by.updated_at`, `created_by.last_login_at`, `created_by.profile_picture` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `status_history[]._id` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/12 |
| `status_history[].done_by` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/12 |
| `status_history[].done_by_type` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/12 |
| `status_history[].status` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/12 |
| `status_history[].status_name` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/12 |
| `status_history[].user` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/12 |
| `template.template_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 11/12 |
| `line_items[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 10/12 |
| `custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 9/12 |
| `deposit_payment_url` | url_host — different host AND path: ap-south-1.zuperpro.com/api/customer_portal/estimates/collect_deposit vs os.golfbuggyguy.com/quotes/9eb3206b-9cfc-4082-9f00-e8b2b2de21e7/deposit | 2/12 |
| `created_by.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/4c358775-7554-4bb0-82d8-de59087e71a5.jpg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/6b44def9-3dd8-4012-a9ec-f9161ad57832-976c3a6ea9f7.jpg | 1/12 |
| `line_items[].discount_type` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/12 |
| `line_items[].line_item_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 1/12 |
| `line_items[].location` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/12 |
| `line_items[].location_name` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/12 |
| `line_items[].location_uid` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/12 |
| `line_items[].product_id` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/12 |
| `line_items[].product_ref_id` | positional — value: one side answers a value, the other a structure — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/12 |
| `line_items[].product_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 1/12 |
| `line_items[].tax.tax_amount` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/12 |
| `line_items[].total_purchase_price` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/12 |
| `status_history[].customer_signature` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/12 |

92 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (68): `asset`, `created_by.user_meta_data`, `proposal_template`, `proposal_title`, `status_history[].remarks`, `customer_billing_address.geo_cordinates`, `customer.customer_description`, `customer.plain_text_description`, `estimate_description`, `prefix`, `profit_breakdown`, `project`, `remarks`, `request`, `service_contract`, `sold_by`, `cpq_status`, `line_items[].associated_products`, `line_items[].markdown_description`, `line_items[].product_type`, `line_items[].profit`, `line_items[].profit_margin`, `public_url`, `secondary_customers`, `waiting_on_mr_uids` …
- Zuper sends empty, Tuper omits (24): `status_history[].customer_signature`, `customer.customer_billing_address.landmark`, `customer.customer_billing_address.zip_code`, `customer.customer_address.property_id`, `customer.customer_category`, `job.job_category.business_unit`, `job.job_timezone`, `customer.customer_address.landmark`, `customer.customer_address.zip_code`, `status_history[].attachments`, `status_history[].line_items_status`, `assets`, `await_signature_by`, `deposit.credits`, `signatures`, `customer.customer_address.phone_number`, `customer.customer_billing_address.phone_number`, `discount_breakups`, `job.custom_fields`, `option_groups`, `organization.organization_description`, `organization.organization_email`, `status_history[].done_by`, `vendor`

Agreed although written differently: same_number ×47, empty_shape ×43, whitespace ×9.

## invoices

11 records compared — 3 from the first page of Zuper's list, and 8 drawn at random from the 13 invoices record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `associations.line_items` | extra_in_tuper | 11/11 100% of records | _absent_ | `1` |
| `associations.notes` | missing_in_tuper | 11/11 100% of records | `0` | _absent_ |
| `associations.payments` | extra_in_tuper | 11/11 100% of records | _absent_ | `0` |
| `created_by.created_at` | value (known cause) | 11/11 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `created_by.last_login_at` | value (known cause) | 11/11 100% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `created_by.profile_picture` | value (known cause) | 11/11 100% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `created_by.role` | extra_in_tuper | 11/11 100% of records | _absent_ | `{"role_uid":"77f94c92-0c6d-4ab1-a062-843ce590cf86","role_key":"ADMIN",` |
| `created_by.updated_at` | value (known cause) | 11/11 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `custom_fields[]` | element_missing | 11/11 100% of records | `{"label":"Zoho Books Invoice ID","value":"2471991000001398010","type":` | _absent_ |
| `customer.accounts.tax.tax_exempt` | missing_in_tuper | 11/11 100% of records | `false` | _absent_ |
| `customer.custom_fields[]` | element_missing | 11/11 100% of records | `{"label":"Zoho CRM Contact ID","value":"4740393000002598046","hide_to_` | _absent_ |
| `customer.no_of_jobs` | extra_in_tuper | 11/11 100% of records | _absent_ | `0` |
| `customer.updated_at` | value | 11/11 100% of records | `2026-07-02T15:25:56.148Z` | `2026-09-12T14:02:11.445Z` |
| `invoice_date` | value | 11/11 100% of records | `2021-07-25T18:30:00.000Z` | `2021-07-25T00:00:00.000Z` |
| `invoice_title` | value | 11/11 100% of records | `Suraj R` | `` |
| `payment_term` | value | 11/11 100% of records | `{"payment_term_name":"Immediatly","no_of_days":0,"payment_term_uid":"8` | `null` |
| `tax` | value | 11/11 100% of records | `[{"tax_id":{"tax_applicable_to":[],"is_active":true,"tax_name":"Standa` | `4.5` |
| `template` | value | 11/11 100% of records | `{"is_deleted":false,"template":"\n\n\n    <meta charset=\"utf-8\">\n  ` | `null` |
| `updated_at` | value (known cause) | 11/11 100% of records | `2025-06-25T11:49:19.749Z` | `2026-09-16T06:23:48.143Z` |
| `custom_field_internal_object.INVOICE_Zoho_Books_Invoice_ID_1` | missing_in_tuper | 10/11 91% of records | `2471991000001398010` | _absent_ |
| `financing.is_enabled` | value | 10/11 91% of records | `true` | `false` |
| `customer.customer_all_addresses[]` | array_length | 9/11 82% of records | `2` | `0` |
| `due_date` | value | 9/11 82% of records | `2021-07-27T18:29:00.000Z` | `2021-07-27T00:00:00.000Z` |
| `line_items[].discount_type` | value | 8/11 73% of records | `FIXED` | `AMOUNT` |
| `line_items[].display_quantity` | extra_in_tuper | 8/11 73% of records | _absent_ | `1` |
| `line_items[].display_total` | extra_in_tuper | 8/11 73% of records | _absent_ | `325` |
| `line_items[].display_unit_price` | extra_in_tuper | 8/11 73% of records | _absent_ | `325` |
| `line_items[].line_item_uid` | extra_in_tuper | 8/11 73% of records | _absent_ | `12fcf392-ddab-4736-9842-04d3a43c6d49` |
| `line_items[].product_id` | value | 8/11 73% of records | `135` | `null` |
| `line_items[].product_ref_id` | value | 8/11 73% of records | `{"_id":"610533c81049a1576bfa210a","product_id":"135","price":325,"purc` | `null` |
| `line_items[].product_uid` | value | 8/11 73% of records | `61a75cf0-f1f2-11eb-a7cf-cb490006ff82` | `null` |
| `line_items[].total_purchase_price` | extra_in_tuper | 8/11 73% of records | _absent_ | `0` |
| `discount` | extra_in_tuper | 7/11 64% of records | _absent_ | `0` |
| `job.created_at` | missing_in_tuper | 7/11 64% of records | `2021-07-27T07:17:18.777Z` | _absent_ |
| `job.current_job_status` | missing_in_tuper | 7/11 64% of records | `{"status_uid":"e35a53cc-3666-4957-b3d7-f146edf660fe","status_name":"Jo` | _absent_ |
| `job.customer_address` | missing_in_tuper | 7/11 64% of records | `{"first_name":"Suraj","last_name":"R","email":"suraj@zuper.co","phone_` | _absent_ |
| `job.is_deleted` | missing_in_tuper | 7/11 64% of records | `false` | _absent_ |
| `job.job_category` | missing_in_tuper | 7/11 64% of records | `{"category_uid":"b19a224b-014c-4607-9990-9791699ab2a2","category_name"` | _absent_ |
| `job.job_priority` | missing_in_tuper | 7/11 64% of records | `LOW` | _absent_ |
| `job.job_status` | missing_in_tuper | 7/11 64% of records | `[{"status_history_uid":"adc12378-db2a-45bb-b3e0-ffe427a70bcc","status_` | _absent_ |
| … | | 113 more, in the JSON | | |

- `created_by.created_at`, `created_by.last_login_at`, `created_by.profile_picture`, `created_by.updated_at` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `line_items[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 11/11 |
| `line_items[].discount_type` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].display_quantity` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].display_total` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].display_unit_price` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].line_item_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 3/11 |
| `line_items[].location` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].location_name` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].location_uid` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].product_id` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].purchase_price` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].tax.tax_amount` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `line_items[].total_purchase_price` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/11 |
| `customer.customer_all_addresses[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 2/11 |
| `customer.customer_all_addresses[].email` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/11 |
| `customer.customer_all_addresses[].first_name` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/11 |
| `customer.customer_all_addresses[].is_primary` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/11 |
| `customer.customer_all_addresses[].last_name` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/11 |
| `customer.customer_all_addresses[].phone_number` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/11 |
| `line_items[].product_uid` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/11 |
| `customer.customer_all_addresses[].city` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/11 |
| `customer.customer_all_addresses[].country` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/11 |
| `line_items[].description` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/11 |
| `line_items[].name` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/11 |
| `line_items[].product_ref_id` | positional — value: one side answers a value, the other a structure — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/11 |
| … | 4 more, in the JSON | |

79 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (58): `created_by.user_meta_data`, `customer.customer_description`, `customer.plain_text_description`, `dealer_fee`, `description`, `line_items[].display_uom`, `line_items[].product_type`, `line_items[].profit`, `line_items[].profit_margin`, `paid_date`, `prefix`, `reference_no`, `service_contract`, `line_items[].associated_products`, `line_items[].markdown_description`, `line_items[].plain_text_description`, `line_items[].description`, `line_items[].specification`, `line_items[].brand`, `line_items[].uom`, `payment_url`, `public_url`, `financing.promo_message`, `line_items[].taxes`, `estimate` …
- Zuper sends empty, Tuper omits (21): `customer.customer_address.property_id`, `estimate.custom_field_internal_object`, `estimate.fees`, `estimate.markdown_description`, `estimate.organization`, `estimate.plain_text_description`, `estimate.tags`, `job.custom_fields`, `job.job_description`, `job.job_timezone`, `taxation_meta.tax_provider`, `assets`, `custom_field_internal_object.INVOICE_Zoho_Books_Invoice_ID_1`, `customer_service_address.landmark`, `customer_service_address.zip_code`, `customer.customer_category`, `customer.customer_organization.organization_description`, `customer.customer_organization.organization_email`, `line_items[].meta_data`, `organization.organization_description`, `secondary_customers`

Agreed although written differently: empty_shape ×19, same_number ×11.

## service contracts

1 record compared — 1 from the first page of Zuper's list, and 0 drawn at random from the 1 contracts record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `activation_date` | value | 1/1 100% of records | `2026-01-10T04:30:00.000Z` | `2026-01-01T00:00:00.000Z` |
| `await_approval_by` | value | 1/1 100% of records | `{"user_uid":"342ddf8c-f908-4c0b-8900-4f32a5158050","first_name":"Mike"` | `efb2a4ae-2a4b-4fc4-9eb9-33f4eca7629c` |
| `billing_address` | missing_in_tuper | 1/1 100% of records | `{"landmark":"","city":"Jumeirah Golf Estates","state":"Dubai","street"` | _absent_ |
| `booking_settings` | missing_in_tuper | 1/1 100% of records | `{"auto_generate":false}` | _absent_ |
| `contract_number` | value | 1/1 100% of records | `17` | `AMCJGE-17` |
| `contract_package` | missing_in_tuper | 1/1 100% of records | `{"is_deleted":false,"line_items":[{"line_item_type":"ITEM","is_billabl` | _absent_ |
| `contract_subtotal` | value | 1/1 100% of records | `1650` | `0` |
| `created_by` | value | 1/1 100% of records | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | `null` |
| `customer_address` | missing_in_tuper | 1/1 100% of records | `{"landmark":"","city":"Jumeirah Golf Estates","state":"Dubai","street"` | _absent_ |
| `description` | missing_in_tuper | 1/1 100% of records | `Annual Maintenance Contract for JGE` | _absent_ |
| `discount` | missing_in_tuper | 1/1 100% of records | `{"discount_applicability":"TRANSACTION"}` | _absent_ |
| `end_date` | value | 1/1 100% of records | `2026-12-31T19:59:00.000Z` | `2026-12-31T00:00:00.000Z` |
| `id` | extra_in_tuper | 1/1 100% of records | _absent_ | `fa28fca1-93f6-4c8a-b415-db672dbddd51` |
| `invoice_settings.auto_charge_enabled` | missing_in_tuper | 1/1 100% of records | `false` | _absent_ |
| `invoice_settings.auto_generate` | missing_in_tuper | 1/1 100% of records | `false` | _absent_ |
| `invoice_settings.billing_period` | missing_in_tuper | 1/1 100% of records | `{"is_active":true,"is_deleted":false,"billing_period_uid":"59ae6660-df` | _absent_ |
| `invoice_settings.generate_invoice_days` | missing_in_tuper | 1/1 100% of records | `14` | _absent_ |
| `invoice_settings.invoice_template` | missing_in_tuper | 1/1 100% of records | `{"is_deleted":false,"type":"INVOICE","template_name":"Invoice","templa` | _absent_ |
| `invoice_settings.payment_term` | missing_in_tuper | 1/1 100% of records | `{"is_deleted":false,"payment_term_name":"Immediatly","no_of_days":0,"p` | _absent_ |
| `invoice_settings.send_to_customer` | missing_in_tuper | 1/1 100% of records | `false` | _absent_ |
| `job_settings` | missing_in_tuper | 1/1 100% of records | `{"auto_generate":false}` | _absent_ |
| `line_items` | missing_in_tuper | 1/1 100% of records | `[{"line_item_type":"ITEM","line_item_uid":"30ef0746-1ee5-423c-bd9f-450` | _absent_ |
| `markdown_description` | missing_in_tuper | 1/1 100% of records | `Annual Maintenance Contract for JGE` | _absent_ |
| `non_billable_total` | missing_in_tuper | 1/1 100% of records | `0` | _absent_ |
| `plain_text_description` | missing_in_tuper | 1/1 100% of records | `Annual Maintenance Contract for JGE` | _absent_ |
| `prefix` | value | 1/1 100% of records | `AMCJGE` | `` |
| `start_date` | value | 1/1 100% of records | `2026-01-01T04:30:00.000Z` | `2026-01-01T00:00:00.000Z` |
| `tax` | missing_in_tuper | 1/1 100% of records | `[{"tax_id":{"tax_applicable_to":[],"is_active":true,"tax_name":"Standa` | _absent_ |
| `tax_exempt` | missing_in_tuper | 1/1 100% of records | `false` | _absent_ |
| `template` | missing_in_tuper | 1/1 100% of records | `{"template_options":{"format":"A4","orientation":"portrait","border":{` | _absent_ |
| `term_months` | value | 1/1 100% of records | `12` | `null` |
| `total_markup` | missing_in_tuper | 1/1 100% of records | `0` | _absent_ |
| `updated_at` | value (known cause) | 1/1 100% of records | `2025-12-30T07:54:14.843Z` | `2026-09-15T10:38:38.161Z` |

- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.

7 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Zuper sends empty, Tuper omits (7): `applicable_locations`, `approval_history`, `assets`, `attachments`, `payment_history`, `properties`, `secondary_customers`

Agreed although written differently: empty_shape ×1.

## timesheet punches

12 records compared — punches between 2026-08-22 and 2026-09-21.

_Zuper lists punches at POST /api/timesheets/filter; Tuper's equivalent list is GET /api/timesheets, whose rows arrive under data.timesheets. The window is the last 30 days on both sides._

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_user.created_at` | value (known cause) | 12/12 100% of records | `2025-11-25T10:14:43.000Z` | `2026-09-11T15:45:44.482Z` |
| `created_user.last_login_at` | value (known cause) | 12/12 100% of records | `2026-09-19T04:07:20.000Z` | `null` |
| `created_user.updated_at` | value (known cause) | 12/12 100% of records | `2026-07-29T16:11:07.000Z` | `2026-09-15T10:40:01.796Z` |
| `users.created_at` | value | 12/12 100% of records | `2025-11-25T10:14:43.000Z` | `2026-09-11T15:45:44.482Z` |
| `users.last_login_at` | value | 12/12 100% of records | `2026-09-19T04:07:20.000Z` | `null` |
| `users.updated_at` | value | 12/12 100% of records | `2026-07-29T16:11:07.000Z` | `2026-09-15T10:40:01.796Z` |

- `created_user.created_at`, `created_user.last_login_at`, `created_user.updated_at` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `created_user.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/3d0ddebd-f250-406d-a309-8ac7444df387.jpeg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/cee326ab-cb64-4296-8e7e-3b981d658643-6735e2a24e2e.jpg | 12/12 |
| `users.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/3d0ddebd-f250-406d-a309-8ac7444df387.jpeg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/cee326ab-cb64-4296-8e7e-3b981d658643-6735e2a24e2e.jpg | 12/12 |

## time off requests

12 records compared — the whole list from each side (GET /api/timesheets/request/timeoff).

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `approval_remarks` | value | 12/12 100% of records | `Auto Approved` | `null` |
| `approved_by_user.created_at` | value (known cause) | 12/12 100% of records | `2026-02-20T07:36:42.000Z` | `2026-09-11T15:45:46.114Z` |
| `approved_by_user.last_login_at` | value (known cause) | 12/12 100% of records | `2026-08-31T03:18:54.000Z` | `null` |
| `approved_by_user.profile_picture` | value (known cause) | 12/12 100% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `approved_by_user.updated_at` | value (known cause) | 12/12 100% of records | `2026-04-07T06:28:29.000Z` | `2026-09-15T10:40:02.583Z` |
| `created_by_user.created_at` | value (known cause) | 12/12 100% of records | `2026-02-20T07:36:42.000Z` | `2026-09-11T15:45:42.398Z` |
| `created_by_user.designation` | value | 12/12 100% of records | `Operations Manager` | `Paintshop` |
| `created_by_user.email` | value | 12/12 100% of records | `stephanie@golfbuggyguy.com` | `lakmaltgbg@gmail.com` |
| `created_by_user.emp_code` | value | 12/12 100% of records | `TGBG-OPS-OPSM-001` | `Paint 5` |
| `created_by_user.external_login_id` | value | 12/12 100% of records | `stephanie` | `lakmaltgbg@gmail.com` |
| `created_by_user.first_name` | value | 12/12 100% of records | `Stephanie` | `Lakmal` |
| `created_by_user.hourly_labor_charge` | value | 12/12 100% of records | `0` | `165` |
| `created_by_user.last_login_at` | value (known cause) | 12/12 100% of records | `2026-08-31T03:18:54.000Z` | `null` |
| `created_by_user.last_name` | value | 12/12 100% of records | `Deighton` | `Waduge` |
| `created_by_user.updated_at` | value (known cause) | 12/12 100% of records | `2026-04-07T06:28:29.000Z` | `2026-09-15T10:40:01.015Z` |
| `created_by_user.work_phone_number` | value | 12/12 100% of records | `0507497192` | `null` |
| `request_from` | value | 12/12 100% of records | `2026-09-19T04:30:00.000Z` | `2026-09-18T20:00:00.000Z` |
| `request_remarks` | value | 12/12 100% of records | `` | `SICK` |
| `request_to` | value | 12/12 100% of records | `2026-09-19T14:00:00.000Z` | `2026-09-19T19:59:00.000Z` |
| `requested_by.created_at` | value (known cause) | 12/12 100% of records | `2025-02-19T15:03:08.000Z` | `2026-09-11T15:45:42.398Z` |
| `requested_by.last_login_at` | value (known cause) | 12/12 100% of records | `2026-09-10T05:08:01.000Z` | `null` |
| `requested_by.updated_at` | value (known cause) | 12/12 100% of records | `2026-03-06T17:22:28.000Z` | `2026-09-15T10:40:01.015Z` |
| `request_reason` | value | 6/12 50% of records | `SICK` | `OTHERS` |
| `timeoff_request_type.no_of_days_per_year` | value | 6/12 50% of records | `52` | `0` |
| `timeoff_request_type.updated_at` | value | 6/12 50% of records | `2026-06-05T11:14:54.000Z` | `2026-09-17T12:44:05.885Z` |
| `created_by_user.mobile_phone_number` | value | 4/12 33% of records | `null` | `+971 58 515 4344` |
| `created_by_user.home_phone_number` | value | 3/12 25% of records | `null` | `(971)(52)206-8219` |
| `created_by_user.profile_picture` | value (known cause) | 2/12 17% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `requested_by.profile_picture` | value (known cause) | 2/12 17% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `all_day` | value | 1/12 8% of records | `false` | `true` |
| `no_of_days` | value | 1/12 8% of records | `0.5` | `1` |
| `requested_by.emp_code` | value | 1/12 8% of records | `CS` | `null` |

- `approved_by_user.created_at`, `approved_by_user.last_login_at`, `approved_by_user.profile_picture`, `approved_by_user.updated_at`, `created_by_user.created_at`, `created_by_user.last_login_at`, `created_by_user.updated_at`, `requested_by.created_at`, `requested_by.last_login_at`, `requested_by.updated_at`, `created_by_user.profile_picture`, `requested_by.profile_picture` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `created_by_user.user_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 12/12 |
| `created_by_user.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_picture.jpg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/3647f356-da32-4164-81e9-684e7fc79b3d-2c1890de0c29.jpg | 10/12 |
| `requested_by.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/a07794fa-d08d-4d9d-848f-a761d77eeefc.jpeg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/3647f356-da32-4164-81e9-684e7fc79b3d-2c1890de0c29.jpg | 10/12 |

Agreed although written differently: whitespace ×5.

## time off types

5 records compared — the whole list from each side (GET /api/timesheet/request/timeoff_type).

Tuper holds 1 sampled record Zuper does not answer for: a6000000-0000-0000-0000-000000000001.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_by_user` | value | 5/5 100% of records | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | `null` |
| `no_of_days_per_year` | value | 5/5 100% of records | `15` | `0` |
| `display_order` | value | 3/5 60% of records | `1` | `null` |

## What this does not cover

- Only the record kinds above, and only the read-by-uid (or whole-list) endpoint for each. The other endpoints of
  Tuper's 437 — sub-resources, searches, writes — are not compared here, and writes never will be: Zuper is read-only.
- A field both systems leave out is not checked, because neither sends it.
- Counts are per sampled record, not per record in the account: a field that disagrees on 3 of 8 sampled jobs is not
  a claim that it disagrees on 37% of 47,000 jobs.
- `not in Tuper` and `not in Zuper` are presence, which `npm run compare` measures properly over the whole account.
