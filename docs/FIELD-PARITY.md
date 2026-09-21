# Field parity — Zuper's answer against Tuper's, on the owner's account

Run 2026-09-21T16:26:17.618Z by `npm run compare:fields` (src/cli/compare.ts `--fields`, sample 40 per kind).

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
| assets | 40 | 0 | 0 | 0 | 35 | 96 | passed |
| requests | 8 | 0 | 0 | 0 | 25 | 48 | passed |
| quotes | 35 | 0 | 0 | 0 | 83 | 244 | passed |
| service contracts | 1 | 0 | 0 | 0 | 12 | 14 | passed |

**155 fields across 4 record kinds answer differently.**

`self-check` is the instrument checking itself: each kind's first Zuper record is compared with a copy of itself, which must
produce nothing. A kind whose self-check failed cannot be believed. `npm run compare:fields -- --self-test` runs the
engine against a page of known answers without touching either system.

## The differences that matter most

2 of the fields below disagreed on at least half the records of their kind, with no cause already known. The first 30:

| records | field | what | how often | Zuper | Tuper |
|---|---|---|---|---|---|
| service contracts | `contract_package.line_items[]` | element_missing | 1/1 | `{"line_item_type":"ITEM","is_billable":true,"product_ref_id":"6553abe9` | _absent_ |
| service contracts | `template.template_options.border` | missing_in_tuper | 1/1 | `{"top":"15mm","right":"15mm","bottom":"15mm","left":"15mm"}` | _absent_ |

## assets

40 records compared — 3 from the first page of Zuper's list, and 37 drawn at random from the 2265 assets record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_by.created_at` | value (known cause) | 40/40 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `created_by.last_login_at` | value (known cause) | 40/40 100% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `created_by.updated_at` | value (known cause) | 40/40 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `updated_at` | value (known cause) | 40/40 100% of records | `2026-05-31T12:47:55.856Z` | `2026-09-21T15:48:07.485Z` |
| `__v` | value (known cause) | 39/40 98% of records | `10` | `0` |
| `customer.updated_at` | value (known cause) | 34/40 85% of records | `2026-09-15T11:15:11.696Z` | `2026-09-21T14:45:03.548Z` |
| `custom_fields[].module_name` | missing_in_tuper (known cause) | 31/40 78% of records | `PRODUCT` | _absent_ |
| `created_by.profile_picture` | value (known cause) | 26/40 65% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `customer.customer_organization.updated_at` | value (known cause) | 22/40 55% of records | `2025-06-24T10:15:21.949Z` | `2026-09-21T00:52:58.359Z` |
| `customer.customer_category` | missing_in_tuper (known cause) | 21/40 53% of records | `{"_id":"60e6c26d011f2b13008795f1","is_deleted":false,"category_name":"` | _absent_ |
| `organization.no_of_customers` | value (known cause) | 12/40 30% of records | `56` | `52` |
| `organization.organization_address.geo_cordinates[]` | value (known cause) | 9/40 23% of records | `[0,0]` | `[]` |
| `organization.organization_address.point_coordinates` | value (known cause) | 9/40 23% of records | `{"type":"Point","coordinates":[0,0]}` | `null` |
| `custom_field_internal_object.asset_community_registration_number_1` | extra_in_tuper (known cause) | 8/40 20% of records | _absent_ | `JGE 9999` |
| `custom_field_internal_object.asset_jge_registration_number_1` | extra_in_tuper (known cause) | 8/40 20% of records | _absent_ | `BG339` |
| `customer.customer_organization.organization_address.geo_cordinates[]` | value (known cause) | 7/40 18% of records | `[0,0]` | `[]` |
| `customer.customer_organization.organization_address.point_coordinates` | value (known cause) | 7/40 18% of records | `{"type":"Point","coordinates":[0,0]}` | `null` |
| `customer.customer_organization.organization_billing_address.geo_cordinates[]` | value (known cause) | 7/40 18% of records | `[0,0]` | `[]` |
| `customer.customer_organization.organization_billing_address.point_coordinates` | value (known cause) | 7/40 18% of records | `{"type":"Point","coordinates":[0,0]}` | `null` |
| `created_by.is_deleted` | value | 6/40 15% of records | `false` | `true` |
| `custom_field_internal_object.asset_controller_serial_no__1` | extra_in_tuper (known cause) | 4/40 10% of records | _absent_ | `241000623` |
| `custom_fields[].meta_data` | missing_in_tuper | 4/40 10% of records | `{"attachment_details":[{"attachment_url":"https://s3.ap-south-1.amazon` | _absent_ |
| `custom_field_internal_object.asset_battery_serial_no__1` | extra_in_tuper (known cause) | 2/40 5% of records | _absent_ | `DEEN117137, DEEN117139, DEEN117134, DEEN117135` |
| `custom_field_internal_object.asset_controller_serial_no._1` | missing_in_tuper (known cause) | 2/40 5% of records | `240903684` | _absent_ |
| `custom_field_internal_object.asset_motor_serial_number_1` | extra_in_tuper (known cause) | 2/40 5% of records | _absent_ | `241001225` |
| `custom_fields[].type` | value (known cause) | 2/40 5% of records | `SINGLE_LINE` | `DATETIME` |
| `asset_manufacturer` | extra_in_tuper | 1/40 3% of records | _absent_ | `Club Car` |
| `asset_model` | extra_in_tuper | 1/40 3% of records | _absent_ | `2+2` |
| `asset_parts[]` | element_missing | 1/40 3% of records | `{"serial_nos":[],"_id":"611bb2c62c02912883d19261","product_id":{"produ` | _absent_ |
| `created_by.emp_code` | value | 1/40 3% of records | `CS` | `null` |
| `custom_field_internal_object.asset_battery_serial_no._1` | missing_in_tuper (known cause) | 1/40 3% of records | `4003220241012047` | _absent_ |
| `custom_field_internal_object.asset_battery_warranty_length_a_1` | missing_in_tuper (known cause) | 1/40 3% of records | `5 Years` | _absent_ |
| `custom_field_internal_object.asset_charger_serial_no__1` | extra_in_tuper (known cause) | 1/40 3% of records | _absent_ | `430P2510244A` |
| `custom_field_internal_object.asset_dc_serial_number_1` | extra_in_tuper (known cause) | 1/40 3% of records | _absent_ | `25112101070` |
| `custom_field_internal_object.asset_rear_axle_serial_no__1` | extra_in_tuper (known cause) | 1/40 3% of records | _absent_ | `251100320` |

- `created_by.created_at`, `created_by.last_login_at`, `created_by.updated_at`, `created_by.profile_picture` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `__v` — Zuper's own revision counter for the record (MongoDB's version key: 0 on 92 of the newest 150 assets, up to 6 on the rest). It counts Zuper's saves; Tuper keeps no revision count, so it answers 0.
- `customer.updated_at`, `customer.customer_organization.updated_at` — an embedded copy of another record, and its updated_at is that record's row in Tuper — which is when the sync last wrote it, not when Zuper's changed. The same cause as the record's own updated_at.
- `custom_fields[].module_name` — Zuper puts module_name on about half of the records and not on the other half for the same field, and says PRODUCT on an asset's and on a person's alike (measured over 300 assets); it describes no field, so Tuper does not answer it (load.ts loadZuperCustomFields).
- `customer.customer_category`, `organization.no_of_customers` — CUSTOMER RE-SYNC NEEDED (owner's OK). The customers importer pages Zuper's customer list, which carries no category, no address list and no organization — only a customer's by-uid read does. So 9,130 of 9,136 customers have no category in Tuper, their extra addresses and organization links never came over, and an organization counts only the customers a job happened to link (52 of Zuper's 56). Fixing it is an importer change plus a by-uid re-read of every customer.
- `organization.organization_address.geo_cordinates[]`, `organization.organization_address.point_coordinates`, `customer.customer_organization.organization_address.geo_cordinates[]`, `customer.customer_organization.organization_address.point_coordinates`, `customer.customer_organization.organization_billing_address.geo_cordinates[]`, `customer.customer_organization.organization_billing_address.point_coordinates` — an address's map point. Zuper writes [0, 0] (and a Point at 0,0) for an address it never located; the sync keeps no point for those rather than one in the Gulf of Guinea. The other way round, Tuper's own geocoder has placed a few addresses Zuper left unplaced.
- `custom_field_internal_object.asset_community_registration_number_1`, `custom_field_internal_object.asset_jge_registration_number_1`, `custom_field_internal_object.asset_controller_serial_no__1`, `custom_field_internal_object.asset_battery_serial_no__1`, `custom_field_internal_object.asset_controller_serial_no._1`, `custom_field_internal_object.asset_motor_serial_number_1`, `custom_field_internal_object.asset_battery_serial_no._1`, `custom_field_internal_object.asset_battery_warranty_length_a_1`, `custom_field_internal_object.asset_charger_serial_no__1`, `custom_field_internal_object.asset_dc_serial_number_1`, `custom_field_internal_object.asset_rear_axle_serial_no__1` — Zuper keeps this object per record, not per field: measured 2026-09-21, the same field is keyed 'asset_battery_serial_no._1' on some assets and 'asset_battery_serial_no__1' on others, and assets made before a field existed carry no key for it even once it is filled ('Community Registration Number' = 'JGE 9999' on a 2021 asset, absent from its object). Tuper keeps one key per field, taken from the first record the sync saw.
- `custom_fields[].type` — Zuper names a field's kind per record, and older assets keep the older name: 'JGE Registration Expiry' is DATETIME on today's assets and SINGLE_LINE on older ones. Tuper keeps one per field, the newest record's (zuper_seen_at).

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 40/40 |
| `customer.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 19/40 |
| `created_by.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/2322c28a-5af1-4ade-86e6-5cdd5cfe53f0.jpeg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/70da7e7f-7e88-4404-b99a-b41a2aac4449-74f4189a0359.jpg | 14/40 |
| `customer.customer_organization.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 13/40 |

92 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (78): `additional_info`, `asset_barcode`, `location`, `asset_manufacturer`, `asset_model`, `customer.accounts.tax`, `customer.customer_description`, `customer.plain_text_description`, `asset_location.country`, `billing_address.country`, `custom_field_internal_object.asset_battery_serial_no__1`, `custom_field_internal_object.asset_cart_ignition_code_1`, `custom_field_internal_object.asset_controller_serial_no__1`, `custom_field_internal_object.asset_jge_registration_expiry_1`, `custom_field_internal_object.asset_jge_rental_number_1`, `custom_field_internal_object.asset_motor_serial_number_1`, `custom_field_internal_object.asset_charger_serial_no__1`, `custom_field_internal_object.asset_dc_serial_number_1`, `custom_field_internal_object.asset_rear_axle_serial_no__1`, `custom_field_internal_object.asset_community_registration_number_1`, `billing_address.zip_code`, `billing_address.landmark`, `asset_product`, `custom_field_internal_object.asset_jge_registration_number_1`, `organization.organization_address.geo_cordinates` …
- Zuper sends empty, Tuper omits (14): `useful_life.value`, `custom_field_internal_object.asset_cpo_purchase_form_1`, `custom_field_internal_object.asset_battery_warranty_length_a_1`, `organization.additional_emails`, `custom_field_internal_object.asset_ampcore_warranty_1`, `customer.customer_organization.organization_logo`, `organization.organization_logo`, `customer.customer_organization.additional_emails`, `customer.customer_category`, `custom_field_internal_object.asset_notes/comments_1`, `custom_field_internal_object.asset_battery_serial_no._1`, `custom_field_internal_object.asset_controller_serial_no._1`, `customer.customer_organization.organization_address`, `customer.customer_organization.organization_billing_address`

Agreed although written differently: empty_shape ×371, whitespace ×7.

## requests

8 records compared — 3 from the first page of Zuper's list, and 5 drawn at random from the 8 requests record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `request_preferred_date1._id` | value (known cause) | 8/8 100% of records | `69932c8cca8c2a3dcb3efd60` | `4fc0e0e3-3585-4728-80cc-64c9fab619d7:preferred1` |
| `request_priority` | extra_in_tuper (known cause) | 8/8 100% of records | _absent_ | `LOW` |
| `request_source.__v` | missing_in_tuper (known cause) | 8/8 100% of records | `0` | _absent_ |
| `request_source.created_by.created_at` | value (known cause) | 8/8 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `request_source.created_by.last_login_at` | value (known cause) | 8/8 100% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `request_source.created_by.profile_picture` | value (known cause) | 8/8 100% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `request_source.created_by.updated_at` | value (known cause) | 8/8 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `request_source.updated_at` | value (known cause) | 8/8 100% of records | `2025-05-13T13:37:07.879Z` | `2026-09-21T15:15:49.893Z` |
| `request_status.status_color` | value (known cause) | 8/8 100% of records | `#27ae60` | `null` |
| `request_status.status_name` | value (known cause) | 8/8 100% of records | `Open` | `New` |
| `updated_at` | value (known cause) | 8/8 100% of records | `2026-02-16T14:41:16.451Z` | `2026-09-21T15:15:54.400Z` |
| `organization.no_of_customers` | value (known cause) | 7/8 88% of records | `56` | `52` |
| `request_status._id` | missing_in_tuper (known cause) | 7/8 88% of records | `69932b2172640c9d7589401e` | _absent_ |
| `request_status.status_type` | value (known cause) | 7/8 88% of records | `OPEN` | `NEW` |
| `asset.custom_fields[].module_name` | missing_in_tuper (known cause) | 5/8 63% of records | `PRODUCT` | _absent_ |
| `asset.updated_at` | value (known cause) | 5/8 63% of records | `2026-06-17T16:34:16.039Z` | `2026-09-21T15:49:12.391Z` |
| `request_preferred_date2._id` | value (known cause) | 4/8 50% of records | `69932c8cca8c2a3dcb3efd61` | `4fc0e0e3-3585-4728-80cc-64c9fab619d7:preferred2` |
| `markdown_description` | extra_in_tuper (known cause) | 3/8 38% of records | _absent_ | `Test only Just checkink` |
| `plain_text_description` | extra_in_tuper (known cause) | 3/8 38% of records | _absent_ | `Test only Just checkink` |
| `status_history[]` | element_missing (known cause) | 3/8 38% of records | `{"status_uid":"c4c6e160-ab48-4b1d-a01f-f723319bc084","status_color":"#` | _absent_ |
| `status_history[]` | element_extra (known cause) | 3/8 38% of records | _absent_ | `{"status_uid":"f1000000-0000-0000-0000-000000000004","status_color":nu` |
| `asset.custom_fields[].meta_data` | missing_in_tuper | 2/8 25% of records | `{"attachment_details":[{"attachment_url":"https://s3.ap-south-1.amazon` | _absent_ |
| `billing_address.point_coordinates` | extra_in_tuper (known cause) | 1/8 13% of records | _absent_ | `{"type":"Point","coordinates":[55.279747,25.1972295]}` |
| `customer.custom_fields` | extra_in_tuper (known cause) | 1/8 13% of records | _absent_ | `[{"label":"Zoho CRM Contact ID","value":"4740393000000549037","hide_to` |
| `service_address.point_coordinates` | extra_in_tuper (known cause) | 1/8 13% of records | _absent_ | `{"type":"Point","coordinates":[55.279747,25.1972295]}` |

- `request_preferred_date1._id`, `request_status._id`, `request_preferred_date2._id` — Zuper's internal id for a sub-record (MongoDB's ObjectId: a tax line, an address, a preferred window, a line's stock location as `location`). It names nothing a client can look up — the record's uid does that — and Tuper answers its own row id where it keeps the sub-record as a row, and none where it does not.
- `request_priority` — Tuper's own field: its request list, filters and detail card are built on jms.requests.priority, so every request carries one (LOW by default). Zuper's request record has no priority at all.
- `request_source.__v` — Zuper's own revision counter for the record (MongoDB's version key: 0 on 92 of the newest 150 assets, up to 6 on the rest). It counts Zuper's saves; Tuper keeps no revision count, so it answers 0.
- `request_source.created_by.created_at`, `request_source.created_by.last_login_at`, `request_source.created_by.profile_picture`, `request_source.created_by.updated_at` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `request_source.updated_at`, `asset.updated_at` — an embedded copy of another record, and its updated_at is that record's row in Tuper — which is when the sync last wrote it, not when Zuper's changed. The same cause as the record's own updated_at.
- `request_status.status_color`, `request_status.status_name`, `request_status.status_type`, `status_history[]`, `status_history[]` — OWNER DECISION PENDING. Tuper's request statuses are its four seeds (New, In Review, Converted, Closed — no colour); GBG's Zuper account uses Open, Booked and Canceled (+ an On Hold). Replacing Tuper's with Zuper's changes the Requests screens' workflow, so it waits on the owner.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `organization.no_of_customers`, `customer.custom_fields` — CUSTOMER RE-SYNC NEEDED (owner's OK). The customers importer pages Zuper's customer list, which carries no category, no address list and no organization — only a customer's by-uid read does. So 9,130 of 9,136 customers have no category in Tuper, their extra addresses and organization links never came over, and an organization counts only the customers a job happened to link (52 of Zuper's 56). Fixing it is an importer change plus a by-uid re-read of every customer.
- `asset.custom_fields[].module_name` — Zuper puts module_name on about half of the records and not on the other half for the same field, and says PRODUCT on an asset's and on a person's alike (measured over 300 assets); it describes no field, so Tuper does not answer it (load.ts loadZuperCustomFields).
- `markdown_description`, `plain_text_description` — Zuper's request gained these two over time: the older requests answer only request_description. Tuper answers all three for every request.
- `billing_address.point_coordinates`, `service_address.point_coordinates` — an address's map point. Zuper writes [0, 0] (and a Point at 0,0) for an address it never located; the sync keeps no point for those rather than one in the Gulf of Guinea. The other way round, Tuper's own geocoder has placed a few addresses Zuper left unplaced.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `billing_address._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 8/8 |
| `request_source.created_by.role.role_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 8/8 |
| `request_status.status_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 8/8 |
| `service_address._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 8/8 |
| `asset.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 5/8 |
| `status_history[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 5/8 |
| `status_history[].status_color` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 5/8 |
| `status_history[].status_name` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 5/8 |
| `status_history[].status_type` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 5/8 |
| `status_history[].status_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 5/8 |
| `status_history[].created_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/8 |

37 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (31): `billing_address.email`, `billing_address.first_name`, `billing_address.last_name`, `billing_address.phone_number`, `customer.customer_description`, `customer.plain_text_description`, `request_source.created_by.user_meta_data`, `service_address.email`, `service_address.first_name`, `service_address.last_name`, `service_address.phone_number`, `billing_address.geo_cordinates`, `billing_address.point_coordinates`, `customer.custom_fields`, `customer.customer_address.geo_cordinates`, `customer.customer_address.point_coordinates`, `service_address.geo_cordinates`, `service_address.point_coordinates`, `customer.customer_address.email`, `customer.customer_address.first_name`, `customer.customer_address.landmark`, `customer.customer_address.last_name`, `customer.customer_address.phone_number`, `customer.customer_address.zip_code`, `customer.customer_contact_no.home` …
- Zuper sends empty, Tuper omits (6): `assigned_to`, `assigned_to_team`, `attachments`, `created_by`, `custom_fields`, `customer.customer_address.property_id`

Agreed although written differently: empty_shape ×26, whitespace ×15, same_number ×8.

## quotes

35 records compared — 3 from the first page of Zuper's list, and 32 drawn at random from the 35 estimates record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_by.created_at` | value (known cause) | 35/35 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `created_by.updated_at` | value (known cause) | 35/35 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `updated_at` | value (known cause) | 35/35 100% of records | `2025-06-25T11:49:19.631Z` | `2026-09-21T15:28:40.110Z` |
| `created_by.last_login_at` | value (known cause) | 33/35 94% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `customer.updated_at` | value (known cause) | 33/35 94% of records | `2026-07-02T15:25:56.148Z` | `2026-09-21T14:10:19.543Z` |
| `tax[]._id` | missing_in_tuper (known cause) | 31/35 89% of records | `60ffb63d9c526e2b50abe2c8` | _absent_ |
| `total_markup` | extra_in_tuper (known cause) | 30/35 86% of records | _absent_ | `0` |
| `is_proposal` | extra_in_tuper (known cause) | 29/35 83% of records | _absent_ | `false` |
| `waiting_on_mr` | extra_in_tuper (known cause) | 29/35 83% of records | _absent_ | `false` |
| `waiting_on_po` | extra_in_tuper (known cause) | 29/35 83% of records | _absent_ | `false` |
| `created_by.profile_picture` | value (known cause) | 28/35 80% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `customer.customer_all_addresses[]` | array_length (known cause) | 20/35 57% of records | `2` | `0` |
| `line_items[].line_item_type` | extra_in_tuper (known cause) | 20/35 57% of records | _absent_ | `ITEM` |
| `line_items[].line_item_uid` | extra_in_tuper (known cause) | 20/35 57% of records | _absent_ | `a2c43fd0-94f4-4bbc-9a73-327a68fc253f` |
| `line_items[].product_ref_id` | value (known cause) | 20/35 57% of records | `{"product_id":"311","price":90,"purchase_price":50,"has_custom_tax":fa` | `null` |
| `line_items[].product_uid` | value (known cause) | 20/35 57% of records | `95885410-eeab-11eb-89c3-8313a5f2ea62` | `null` |
| `line_items[].tax` | extra_in_tuper (known cause) | 20/35 57% of records | _absent_ | `{"tax_name":"","tax_exempt":false,"tax_amount":0}` |
| `custom_fields[].hide_field` | extra_in_tuper (known cause) | 17/35 49% of records | _absent_ | `false` |
| `custom_fields[].read_only` | extra_in_tuper (known cause) | 17/35 49% of records | _absent_ | `false` |
| `public_url` | value (known cause) | 15/35 43% of records | `https://ap-south-1.zuperpro.com/api/customer_portal/estimates?company_` | `null` |
| `job.updated_at` | value (known cause) | 14/35 40% of records | `2025-12-23T11:06:28.788Z` | `2026-09-16T08:01:28.240Z` |
| `line_items[].location` | value (known cause) | 13/35 37% of records | `60f68e4aed5d6812f465f0ff` | `1befc7c5-3bec-430a-bda0-dc58e21eba17` |
| `line_items[].plain_text_description` | extra_in_tuper (known cause) | 11/35 31% of records | _absent_ | `EXIDE TUBULAR  BATTERY     Voltage  8V 165 Ah @ C20 hours rate Dimensi` |
| `customer.custom_fields[].type` | missing_in_tuper (known cause) | 9/35 26% of records | `SINGLE_LINE` | _absent_ |
| `status_history[].done_by.created_at` | value (known cause) | 9/35 26% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `status_history[].done_by.last_login_at` | value (known cause) | 9/35 26% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `status_history[].done_by.updated_at` | value (known cause) | 9/35 26% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `job.custom_fields[]` | element_missing (known cause) | 8/35 23% of records | `{"hide_to_fe":false,"_id":"60ffb2fe9c526e2b50abd19d","label":"AMC Silv` | _absent_ |
| `line_items[].total_purchase_price` | extra_in_tuper (known cause) | 8/35 23% of records | _absent_ | `2940` |
| `status_history[].done_by.profile_picture` | value (known cause) | 8/35 23% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `customer.customer_category` | missing_in_tuper (known cause) | 7/35 20% of records | `{"_id":"60e6c2a3011f2b13008796cf","category_name":"Rental","category_u` | _absent_ |
| `customer.customer_organization.updated_at` | value (known cause) | 6/35 17% of records | `2025-01-05T14:06:34.470Z` | `2026-09-21T00:53:45.929Z` |
| `organization.updated_at` | value (known cause) | 6/35 17% of records | `2025-01-05T14:06:36.286Z` | `2026-09-21T00:53:33.251Z` |
| `profit_breakdown` | value (known cause) | 5/35 14% of records | `{"products":0,"services":0,"total_cost":0,"estimate_total":360,"profit` | `null` |
| `tax_exempt` | extra_in_tuper (known cause) | 5/35 14% of records | _absent_ | `false` |
| `cpq_status` | value (known cause) | 4/35 11% of records | `{"errors":[],"formatted_errors":[]}` | `null` |
| `pending_option_selection` | missing_in_tuper (known cause) | 4/35 11% of records | `false` | _absent_ |
| `is_expired` | value (known cause) | 3/35 9% of records | `false` | `true` |
| `sub_total` | value (known cause) | 3/35 9% of records | `null` | `0` |
| `total_discount` | value (known cause) | 3/35 9% of records | `null` | `0` |
| … | | 43 more, in the JSON | | |

- `created_by.created_at`, `created_by.updated_at`, `created_by.last_login_at`, `created_by.profile_picture`, `status_history[].done_by.created_at`, `status_history[].done_by.last_login_at`, `status_history[].done_by.updated_at`, `status_history[].done_by.profile_picture`, `notes[].created_by.created_at`, `notes[].created_by.last_login_at`, `notes[].created_by.updated_at`, `sold_by_user.created_at`, `sold_by_user.profile_picture`, `sold_by_user.updated_at`, `notes[].created_by.profile_picture` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `customer.updated_at`, `job.updated_at`, `customer.customer_organization.updated_at`, `organization.updated_at` — an embedded copy of another record, and its updated_at is that record's row in Tuper — which is when the sync last wrote it, not when Zuper's changed. The same cause as the record's own updated_at.
- `tax[]._id`, `line_items[].location`, `notes[]._id`, `attachments[]._id`, `customer.accounts._id`, `customer.customer_billing_address._id`, `customer.customer_contact_no._id` — Zuper's internal id for a sub-record (MongoDB's ObjectId: a tax line, an address, a preferred window, a line's stock location as `location`). It names nothing a client can look up — the record's uid does that — and Tuper answers its own row id where it keeps the sub-record as a row, and none where it does not.
- `total_markup`, `is_proposal`, `waiting_on_mr`, `waiting_on_po`, `line_items[].line_item_type`, `line_items[].line_item_uid`, `line_items[].tax`, `custom_fields[].hide_field`, `custom_fields[].read_only`, `line_items[].plain_text_description`, `line_items[].total_purchase_price`, `profit_breakdown`, `tax_exempt`, `cpq_status`, `pending_option_selection`, `sub_total`, `total_discount` — Zuper's quote has gained keys over time and each quote keeps the set it was saved with — measured on all 35 of GBG's quotes, 2026-09-21: is_proposal, waiting_on_mr/po and profit_breakdown appear only on quotes from 2026, total_markup from May 2025, cpq_status from July 2022; the oldest three answer null for sub_total and total_discount; lines gained line_item_type/uid and tax the same way. Tuper answers the complete quote for every quote. The same cause as a job's growing profitability block.
- `customer.customer_all_addresses[]`, `customer.custom_fields[].type`, `customer.customer_category`, `customer.custom_fields[]` — CUSTOMER RE-SYNC NEEDED (owner's OK). The customers importer pages Zuper's customer list, which carries no category, no address list and no organization — only a customer's by-uid read does. So 9,130 of 9,136 customers have no category in Tuper, their extra addresses and organization links never came over, and an organization counts only the customers a job happened to link (52 of Zuper's 56). Fixing it is an importer change plus a by-uid re-read of every customer.
- `line_items[].product_ref_id`, `line_items[].product_uid` — the line names a part Zuper has since deleted — 13 distinct parts on 31 of GBG's 43 quote lines, each answering is_deleted: true inside the line. Owner decision 2026-09-21: deleted parts are not imported (the same decision as the 464 stock movements), so Tuper's line keeps the part's name and number but no link. product_ref_id is the part record itself, which Zuper embeds and Tuper does not.
- `public_url` — Zuper's link to the quote on its own customer portal. Tuper's customer-facing quote page belongs to the portal, which is outside this work, so Tuper answers no link rather than one not known to open.
- `job.custom_fields[]` — JOB RE-SYNC NEEDED (owner's OK). Zuper lists every custom field a job carries, empty ones too; the jobs importer still uses the older helper that skips empty values, so a job's empty fields are missing. Moving jobs to writeZuperCustomFields means re-syncing 46,577 jobs.
- `is_expired` — Zuper stores this flag when its own expiry pass runs; it is not a rule over the status and the date. Measured on GBG's 35 quotes: two archived quotes past their expiry say false, a third says true, and a 2021 quote still awaiting a response says false. Tuper works it out (past expiry while sent or archived).
- `job.current_job_status.status_name`, `job.job_status[].status_name` — Zuper keeps each job's own copy of a status's name from when the job entered it: GBG's status deb6531b was 'Invoiced' in 2021 and is 'Closed' today, and a 2021 job still answers 'Invoiced'. Tuper links the status and answers its name as it is now (the colour it does keep per job, 00100).

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `status_history[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 34/35 |
| `line_items[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 32/35 |
| `customer.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 31/35 |
| `job.job_status[].remarks_free_text` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 26/35 |
| `custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 25/35 |
| `status_history[].done_by.created_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 25/35 |
| `status_history[].done_by.updated_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 25/35 |
| `status_history[].done_by.profile_picture` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 23/35 |
| `status_history[].done_by.last_login_at` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 22/35 |
| `job.job_status[].remarks` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 18/35 |
| `status_history[].created_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 18/35 |
| `status_history[].status_name` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 17/35 |
| `deposit_payment_url` | url_host — different host AND path: ap-south-1.zuperpro.com/api/customer_portal/estimates/collect_deposit vs os.golfbuggyguy.com/quotes/d0f1a8cd-01fe-4fb9-b68c-87be5b5df254/deposit | 15/35 |
| `job.job_status[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 14/35 |
| `customer.customer_all_addresses[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 13/35 |
| `job.job_status[].created_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].status_color` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].status_name` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].status_type` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].status_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 13/35 |
| `job.job_status[].synced_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].updated_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `status_history[].done_by` | positional — value: one side answers a value, the other a structure — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `customer.customer_all_addresses[].email` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/35 |
| `customer.customer_all_addresses[].first_name` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/35 |
| … | 58 more, in the JSON | |

161 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (139): `created_by.user_meta_data`, `proposal_template`, `asset`, `customer_billing_address.geo_cordinates`, `customer_billing_address.point_coordinates`, `proposal_title`, `status_history[].done_by.user_meta_data`, `converted_date`, `customer.customer_description`, `customer.plain_text_description`, `status_history[].remarks`, `estimate_description`, `profit_breakdown`, `project`, `request`, `service_contract`, `cpq_status`, `line_items[].profit`, `line_items[].profit_margin`, `remarks`, `waiting_on_mr_uids`, `waiting_on_po_uids`, `prefix`, `line_items[].associated_products`, `line_items[].markdown_description` …
- Zuper sends empty, Tuper omits (22): `status_history[].customer_signature`, `customer.customer_address.property_id`, `status_history[].attachments`, `status_history[].line_items_status`, `taxation_meta.tax_provider`, `customer.customer_category`, `financing.promo_message`, `job.job_timezone`, `deposit.credits`, `financing.apr`, `financing.monthly_installment`, `financing.term`, `assets`, `signatures`, `await_signature_by`, `customer.customer_all_addresses[].property_id`, `option_groups`, `discount_breakups`, `line_items[].group_uid`, `line_items[].purchase_price`, `line_items[].tax.tax_code`, `vendor`

Agreed although written differently: empty_shape ×178, same_number ×143, whitespace ×32.

## service contracts

1 record compared — 1 from the first page of Zuper's list, and 0 drawn at random from the 1 contracts record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `await_approval_by.created_at` | value (known cause) | 1/1 100% of records | `2023-02-19T09:24:25.000Z` | `2026-09-11T15:45:38.306Z` |
| `await_approval_by.last_login_at` | value (known cause) | 1/1 100% of records | `2026-09-17T03:38:08.000Z` | `null` |
| `await_approval_by.profile_picture` | value (known cause) | 1/1 100% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `await_approval_by.updated_at` | value (known cause) | 1/1 100% of records | `2026-01-02T08:38:58.000Z` | `2026-09-21T01:19:03.876Z` |
| `contract_package.line_items[]` | element_missing | 1/1 100% of records | `{"line_item_type":"ITEM","is_billable":true,"product_ref_id":"6553abe9` | _absent_ |
| `created_by.created_at` | value (known cause) | 1/1 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `created_by.last_login_at` | value (known cause) | 1/1 100% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `created_by.profile_picture` | value (known cause) | 1/1 100% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `created_by.updated_at` | value (known cause) | 1/1 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `tax[]._id` | missing_in_tuper (known cause) | 1/1 100% of records | `6953852675d34efbf2888dc9` | _absent_ |
| `template.template_options.border` | missing_in_tuper | 1/1 100% of records | `{"top":"15mm","right":"15mm","bottom":"15mm","left":"15mm"}` | _absent_ |
| `updated_at` | value (known cause) | 1/1 100% of records | `2025-12-30T07:54:14.843Z` | `2026-09-21T15:39:57.612Z` |

- `await_approval_by.created_at`, `await_approval_by.last_login_at`, `await_approval_by.profile_picture`, `await_approval_by.updated_at`, `created_by.created_at`, `created_by.last_login_at`, `created_by.profile_picture`, `created_by.updated_at` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `tax[]._id` — Zuper's internal id for a sub-record (MongoDB's ObjectId: a tax line, an address, a preferred window, a line's stock location as `location`). It names nothing a client can look up — the record's uid does that — and Tuper answers its own row id where it keeps the sub-record as a row, and none where it does not.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `contract_package.package_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 1/1 |
| `invoice_settings.billing_period.billing_period_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 1/1 |
| `invoice_settings.payment_term.payment_term_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 1/1 |
| `line_items[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 1/1 |
| `line_items[].line_item_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 1/1 |
| `line_items[].markdown_description` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/1 |
| `line_items[].product_ref_id` | positional — value: one side answers a value, the other a structure — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/1 |

7 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (7): `await_approval_by.user_meta_data`, `billing_address.geo_cordinates`, `billing_address.point_coordinates`, `created_by.user_meta_data`, `customer_address.geo_cordinates`, `customer_address.point_coordinates`, `organization`

Agreed although written differently: whitespace ×1, same_number ×1.

## What this does not cover

- Only the record kinds above, and only the read-by-uid (or whole-list) endpoint for each. The other endpoints of
  Tuper's 437 — sub-resources, searches, writes — are not compared here, and writes never will be: Zuper is read-only.
- A field both systems leave out is not checked, because neither sends it.
- Counts are per sampled record, not per record in the account: a field that disagrees on 3 of 8 sampled jobs is not
  a claim that it disagrees on 37% of 47,000 jobs.
- `not in Tuper` and `not in Zuper` are presence, which `npm run compare` measures properly over the whole account.
