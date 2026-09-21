# Field parity — Zuper's answer against Tuper's, on the owner's account

Run 2026-09-21T19:41:54.783Z by `npm run compare:fields` (src/cli/compare.ts `--fields`, sample 40 per kind).

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
| customers | 39 | 0 | 0 | 1 | 15 | 52 | passed |
| assets | 40 | 0 | 0 | 0 | 34 | 89 | passed |
| requests | 8 | 0 | 0 | 0 | 23 | 44 | passed |
| quotes | 35 | 0 | 0 | 0 | 84 | 230 | passed |
| invoices | 13 | 0 | 0 | 0 | 75 | 164 | passed |
| service contracts | 1 | 0 | 0 | 0 | 12 | 14 | passed |

**243 fields across 6 record kinds answer differently.**

`self-check` is the instrument checking itself: each kind's first Zuper record is compared with a copy of itself, which must
produce nothing. A kind whose self-check failed cannot be believed. `npm run compare:fields -- --self-test` runs the
engine against a page of known answers without touching either system.

## The differences that matter most

13 of the fields below disagreed on at least half the records of their kind, with no cause already known. The first 30:

| records | field | what | how often | Zuper | Tuper |
|---|---|---|---|---|---|
| invoices | `invoice_date` | value | 13/13 | `2021-07-25T18:30:00.000Z` | `2021-07-25T00:00:00.000Z` |
| service contracts | `contract_package.line_items[]` | element_missing | 1/1 | `{"line_item_type":"ITEM","is_billable":true,"product_ref_id":"6553abe9` | _absent_ |
| service contracts | `template.template_options.border` | missing_in_tuper | 1/1 | `{"top":"15mm","right":"15mm","bottom":"15mm","left":"15mm"}` | _absent_ |
| invoices | `financing.is_enabled` | value | 12/13 | `true` | `false` |
| invoices | `due_date` | value | 11/13 | `2021-07-27T18:29:00.000Z` | `2021-07-27T00:00:00.000Z` |
| invoices | `template.template_options` | extra_in_tuper | 11/13 | _absent_ | `{"format":"A4","orientation":"portrait"}` |
| invoices | `line_items[].line_item_uid` | extra_in_tuper | 10/13 | _absent_ | `ef2f16f9-1e91-45ac-ba8d-e5542a670b14` |
| invoices | `line_items[].product_ref_id` | value | 10/13 | `{"_id":"610533c81049a1576bfa210a","product_id":"135","price":325,"purc` | `null` |
| invoices | `line_items[].product_uid` | value | 10/13 | `61a75cf0-f1f2-11eb-a7cf-cb490006ff82` | `null` |
| invoices | `line_items[].line_item_type` | extra_in_tuper | 9/13 | _absent_ | `ITEM` |
| invoices | `line_items[].tax` | extra_in_tuper | 9/13 | _absent_ | `{"tax_name":"","tax_exempt":false,"tax_amount":0}` |
| invoices | `customer.customer_all_addresses[]` | array_length | 8/13 | `2` | `0` |
| invoices | `status_history[]` | element_missing | 7/13 | `{"_id":"6110d7debc8ebe130b8cfcc4","status_name":"DRAFT","done_by":{"us` | _absent_ |

## customers

39 records compared — 3 from the first page of Zuper's list, and 37 drawn at random from the 4716 customers record(s) Tuper has mapped to a Zuper uid.

Not compared: 1 record could not be read — tuper 504: Gateway Timeout

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_by.created_at` | value (known cause) | 39/39 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `created_by.last_login_at` | value (known cause) | 39/39 100% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `created_by.updated_at` | value (known cause) | 39/39 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `updated_at` | value (known cause) | 39/39 100% of records | `2026-09-15T11:12:45.008Z` | `2026-09-21T19:00:40.734Z` |
| `created_by.profile_picture` | value (known cause) | 36/39 92% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `customer_category._id` | missing_in_tuper (known cause) | 4/39 10% of records | `60e6c26d011f2b13008795f1` | _absent_ |
| `customer_organization.updated_at` | value (known cause) | 3/39 8% of records | `2025-01-05T14:06:34.989Z` | `2026-09-21T00:53:11.804Z` |
| `accounts._id` | missing_in_tuper (known cause) | 1/39 3% of records | `692570660444ee1d1308d978` | _absent_ |
| `auto_charge._id` | missing_in_tuper (known cause) | 1/39 3% of records | `692570660444ee1d1308d977` | _absent_ |
| `custom_fields[].hide_field` | extra_in_tuper | 1/39 3% of records | _absent_ | `false` |
| `custom_fields[].read_only` | extra_in_tuper | 1/39 3% of records | _absent_ | `false` |
| `customer_contact_no._id` | missing_in_tuper (known cause) | 1/39 3% of records | `692570660444ee1d1308d97d` | _absent_ |
| `customer_notifications._id` | missing_in_tuper (known cause) | 1/39 3% of records | `692570660444ee1d1308d979` | _absent_ |
| `portal_permissions._id` | missing_in_tuper (known cause) | 1/39 3% of records | `692570660444ee1d1308d976` | _absent_ |
| `tax._id` | missing_in_tuper (known cause) | 1/39 3% of records | `692570660444ee1d1308d975` | _absent_ |

- `created_by.created_at`, `created_by.last_login_at`, `created_by.updated_at`, `created_by.profile_picture` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `customer_category._id`, `accounts._id`, `auto_charge._id`, `customer_contact_no._id`, `customer_notifications._id`, `portal_permissions._id`, `tax._id` — Zuper's internal id for a sub-record (MongoDB's ObjectId: a tax line, an address, a preferred window, a line's stock location as `location`). It names nothing a client can look up — the record's uid does that — and Tuper answers its own row id where it keeps the sub-record as a row, and none where it does not.
- `customer_organization.updated_at` — an embedded copy of another record, and its updated_at is that record's row in Tuper — which is when the sync last wrote it, not when Zuper's changed. The same cause as the record's own updated_at.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 34/39 |
| `created_by.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/d92e84a8-82d8-4c87-a7cc-e46c80ab55a0.jpeg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/df6401b5-8cfb-4795-aa82-7c6dabe88e06-baf645ad9574.jpg | 3/39 |
| `customer_organization.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 3/39 |

49 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (47): `accounts.billing_frequency`, `accounts.payment_term`, `accounts.tax_group`, `deactivated_at`, `delete_remarks`, `merged_into`, `sla_duration`, `tax.customer_code`, `tax.tax_provider`, `tax.entity_use_code`, `tax.tax_exempt_number`, `tax.tax_exempt_remarks`, `customer_address.geo_cordinates`, `customer_address.point_coordinates`, `customer_billing_address.geo_cordinates`, `customer_billing_address.point_coordinates`, `customer_category`, `customer_address.email`, `customer_address.first_name`, `customer_address.last_name`, `customer_address.phone_number`, `customer_billing_address.email`, `customer_billing_address.first_name`, `customer_billing_address.last_name`, `customer_billing_address.phone_number` …
- Zuper sends empty, Tuper omits (2): `customer_address.property`, `customer_organization.additional_emails`

Agreed although written differently: empty_shape ×28, whitespace ×2.

## assets

40 records compared — 3 from the first page of Zuper's list, and 37 drawn at random from the 2265 assets record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_by.created_at` | value (known cause) | 40/40 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `created_by.last_login_at` | value (known cause) | 40/40 100% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `created_by.updated_at` | value (known cause) | 40/40 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `updated_at` | value (known cause) | 40/40 100% of records | `2026-05-31T12:47:55.856Z` | `2026-09-21T15:48:07.485Z` |
| `__v` | value (known cause) | 33/40 83% of records | `10` | `0` |
| `customer.updated_at` | value (known cause) | 31/40 78% of records | `2026-09-15T11:15:11.696Z` | `2026-09-21T19:00:45.763Z` |
| `custom_fields[].module_name` | missing_in_tuper (known cause) | 21/40 53% of records | `PRODUCT` | _absent_ |
| `created_by.profile_picture` | value (known cause) | 16/40 40% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `customer.customer_organization.updated_at` | value (known cause) | 14/40 35% of records | `2026-04-22T09:28:11.817Z` | `2026-09-21T00:52:47.637Z` |
| `customer.customer_category._id` | missing_in_tuper (known cause) | 10/40 25% of records | `60e6c2a3011f2b13008796cf` | _absent_ |
| `organization.organization_address.geo_cordinates[]` | value (known cause) | 9/40 23% of records | `[0,0]` | `[]` |
| `organization.organization_address.point_coordinates` | value (known cause) | 9/40 23% of records | `{"type":"Point","coordinates":[0,0]}` | `null` |
| `customer.customer_organization.organization_address.geo_cordinates[]` | value (known cause) | 7/40 18% of records | `[0,0]` | `[]` |
| `customer.customer_organization.organization_address.point_coordinates` | value (known cause) | 7/40 18% of records | `{"type":"Point","coordinates":[0,0]}` | `null` |
| `customer.customer_organization.organization_billing_address.geo_cordinates[]` | value (known cause) | 7/40 18% of records | `[0,0]` | `[]` |
| `customer.customer_organization.organization_billing_address.point_coordinates` | value (known cause) | 7/40 18% of records | `{"type":"Point","coordinates":[0,0]}` | `null` |
| `custom_field_internal_object.asset_controller_serial_no__1` | extra_in_tuper (known cause) | 6/40 15% of records | _absent_ | `250900795` |
| `custom_field_internal_object.asset_battery_serial_no__1` | extra_in_tuper (known cause) | 5/40 13% of records | _absent_ | `113902-2211252310511000-076` |
| `custom_field_internal_object.asset_battery_serial_no._1` | missing_in_tuper (known cause) | 5/40 13% of records | `113902-2211252310511000-076` | _absent_ |
| `custom_fields[].type` | value (known cause) | 5/40 13% of records | `SINGLE_LINE` | `DATETIME` |
| `custom_field_internal_object.asset_motor_serial_number_1` | extra_in_tuper (known cause) | 4/40 10% of records | _absent_ | `250301094` |
| `custom_field_internal_object.asset_controller_serial_no._1` | missing_in_tuper (known cause) | 3/40 8% of records | `241002276` | _absent_ |
| `created_by.emp_code` | value | 2/40 5% of records | `CS` | `null` |
| `custom_field_internal_object.asset_charger_serial_no__1` | extra_in_tuper (known cause) | 2/40 5% of records | _absent_ | `430P2510070A` |
| `custom_field_internal_object.asset_community_registration_number_1` | extra_in_tuper (known cause) | 2/40 5% of records | _absent_ | `JGE 9999` |
| `custom_field_internal_object.asset_dc_serial_number_1` | extra_in_tuper (known cause) | 2/40 5% of records | _absent_ | `25110701010` |
| `custom_field_internal_object.asset_jge_registration_number_1` | extra_in_tuper (known cause) | 2/40 5% of records | _absent_ | `BG439` |
| `custom_field_internal_object.asset_rear_axle_serial_no__1` | extra_in_tuper (known cause) | 2/40 5% of records | _absent_ | `251100429/16:1` |
| `asset_attachments[]` | element_extra | 1/40 3% of records | _absent_ | `{"attachment_uid":"122d584e-a4da-4295-91ed-3a2ffa74823f","file_name":"` |
| `asset_manufacturer` | extra_in_tuper | 1/40 3% of records | _absent_ | `Club Car` |
| `asset_model` | extra_in_tuper | 1/40 3% of records | _absent_ | `2+2` |
| `asset_parts[]` | element_missing | 1/40 3% of records | `{"serial_nos":[],"_id":"611bb2c62c02912883d19261","product_id":{"produ` | _absent_ |
| `created_by.is_deleted` | value | 1/40 3% of records | `false` | `true` |
| `custom_fields[].meta_data` | missing_in_tuper | 1/40 3% of records | `{"attachment_details":[{"attachment_url":"https://s3.ap-south-1.amazon` | _absent_ |

- `created_by.created_at`, `created_by.last_login_at`, `created_by.updated_at`, `created_by.profile_picture` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `__v` — Zuper's own revision counter for the record (MongoDB's version key: 0 on 92 of the newest 150 assets, up to 6 on the rest). It counts Zuper's saves; Tuper keeps no revision count, so it answers 0.
- `customer.updated_at`, `customer.customer_organization.updated_at` — an embedded copy of another record, and its updated_at is that record's row in Tuper — which is when the sync last wrote it, not when Zuper's changed. The same cause as the record's own updated_at.
- `custom_fields[].module_name` — Zuper puts module_name on about half of the records and not on the other half for the same field, and says PRODUCT on an asset's and on a person's alike (measured over 300 assets); it describes no field, so Tuper does not answer it (load.ts loadZuperCustomFields).
- `customer.customer_category._id` — Zuper's internal id for a sub-record (MongoDB's ObjectId: a tax line, an address, a preferred window, a line's stock location as `location`). It names nothing a client can look up — the record's uid does that — and Tuper answers its own row id where it keeps the sub-record as a row, and none where it does not.
- `organization.organization_address.geo_cordinates[]`, `organization.organization_address.point_coordinates`, `customer.customer_organization.organization_address.geo_cordinates[]`, `customer.customer_organization.organization_address.point_coordinates`, `customer.customer_organization.organization_billing_address.geo_cordinates[]`, `customer.customer_organization.organization_billing_address.point_coordinates` — an address's map point. Zuper writes [0, 0] (and a Point at 0,0) for an address it never located; the sync keeps no point for those rather than one in the Gulf of Guinea. The other way round, Tuper's own geocoder has placed a few addresses Zuper left unplaced.
- `custom_field_internal_object.asset_controller_serial_no__1`, `custom_field_internal_object.asset_battery_serial_no__1`, `custom_field_internal_object.asset_battery_serial_no._1`, `custom_field_internal_object.asset_motor_serial_number_1`, `custom_field_internal_object.asset_controller_serial_no._1`, `custom_field_internal_object.asset_charger_serial_no__1`, `custom_field_internal_object.asset_community_registration_number_1`, `custom_field_internal_object.asset_dc_serial_number_1`, `custom_field_internal_object.asset_jge_registration_number_1`, `custom_field_internal_object.asset_rear_axle_serial_no__1` — Zuper keeps this object per record, not per field: measured 2026-09-21, the same field is keyed 'asset_battery_serial_no._1' on some assets and 'asset_battery_serial_no__1' on others, and assets made before a field existed carry no key for it even once it is filled ('Community Registration Number' = 'JGE 9999' on a 2021 asset, absent from its object). Tuper keeps one key per field, taken from the first record the sync saw.
- `custom_fields[].type` — Zuper names a field's kind per record, and older assets keep the older name: 'JGE Registration Expiry' is DATETIME on today's assets and SINGLE_LINE on older ones. Tuper keeps one per field, the newest record's (zuper_seen_at).

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 40/40 |
| `customer.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 27/40 |
| `created_by.profile_picture` | url_host — different host AND path: s3.ap-south-1.amazonaws.com/prod.app.zuperpro/attachments/a5dee8af-9576-4a74-9a1c-382ccbeb9262/2322c28a-5af1-4ade-86e6-5cdd5cfe53f0.jpeg vs supabase.golfbuggyguy.com/storage/v1/object/public/jms-avatars/00000000-0000-0000-0000-000000000001/70da7e7f-7e88-4404-b99a-b41a2aac4449-74f4189a0359.jpg | 24/40 |
| `customer.customer_organization.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 7/40 |

85 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (73): `additional_info`, `asset_barcode`, `location`, `asset_manufacturer`, `asset_model`, `customer.accounts.tax`, `customer.customer_description`, `customer.plain_text_description`, `asset_location.country`, `billing_address.country`, `custom_field_internal_object.asset_battery_serial_no__1`, `custom_field_internal_object.asset_controller_serial_no__1`, `custom_field_internal_object.asset_cart_ignition_code_1`, `custom_field_internal_object.asset_jge_registration_expiry_1`, `custom_field_internal_object.asset_jge_rental_number_1`, `asset_location.geo_cordinates`, `asset_location.point_coordinates`, `billing_address.geo_cordinates`, `billing_address.point_coordinates`, `custom_field_internal_object.asset_community_registration_number_1`, `custom_field_internal_object.asset_charger_serial_no__1`, `custom_field_internal_object.asset_dc_serial_number_1`, `custom_field_internal_object.asset_motor_serial_number_1`, `custom_field_internal_object.asset_rear_axle_serial_no__1`, `asset_location.zip_code` …
- Zuper sends empty, Tuper omits (12): `useful_life.value`, `custom_field_internal_object.asset_cpo_purchase_form_1`, `custom_field_internal_object.asset_ampcore_warranty_1`, `organization.additional_emails`, `custom_field_internal_object.asset_battery_warranty_length_a_1`, `customer.customer_organization.additional_emails`, `custom_field_internal_object.asset_notes/comments_1`, `customer.customer_category`, `organization.organization_logo`, `customer.customer_organization.organization_logo`, `custom_field_internal_object.asset_controller_serial_no._1`, `custom_field_internal_object.asset_battery_serial_no._1`

Agreed although written differently: empty_shape ×332, whitespace ×3.

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
| `request_source.updated_at` | value (known cause) | 8/8 100% of records | `2025-05-13T13:37:07.879Z` | `2026-09-21T18:01:24.317Z` |
| `updated_at` | value (known cause) | 8/8 100% of records | `2026-02-16T14:41:16.451Z` | `2026-09-21T18:01:24.376Z` |
| `request_status._id` | missing_in_tuper (known cause) | 7/8 88% of records | `69932b2172640c9d7589401e` | _absent_ |
| `asset.custom_fields[].module_name` | missing_in_tuper (known cause) | 5/8 63% of records | `PRODUCT` | _absent_ |
| `asset.updated_at` | value (known cause) | 5/8 63% of records | `2026-06-17T16:34:16.039Z` | `2026-09-21T15:49:12.391Z` |
| `request_preferred_date2._id` | value (known cause) | 4/8 50% of records | `69932c8cca8c2a3dcb3efd61` | `4fc0e0e3-3585-4728-80cc-64c9fab619d7:preferred2` |
| `markdown_description` | extra_in_tuper (known cause) | 3/8 38% of records | _absent_ | `Test only Just checkink` |
| `plain_text_description` | extra_in_tuper (known cause) | 3/8 38% of records | _absent_ | `Test only Just checkink` |
| `asset.custom_fields[].meta_data` | missing_in_tuper | 2/8 25% of records | `{"attachment_details":[{"attachment_url":"https://s3.ap-south-1.amazon` | _absent_ |
| `billing_address.point_coordinates` | extra_in_tuper (known cause) | 1/8 13% of records | _absent_ | `{"type":"Point","coordinates":[55.279747,25.1972295]}` |
| `customer.custom_fields` | extra_in_tuper | 1/8 13% of records | _absent_ | `[{"label":"Zoho CRM Contact ID","value":"4740393000000549037","hide_to` |
| `service_address.point_coordinates` | extra_in_tuper (known cause) | 1/8 13% of records | _absent_ | `{"type":"Point","coordinates":[55.279747,25.1972295]}` |
| `status_history[].done_by.created_at` | value (known cause) | 1/8 13% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `status_history[].done_by.last_login_at` | value (known cause) | 1/8 13% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `status_history[].done_by.profile_picture` | value (known cause) | 1/8 13% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `status_history[].done_by.updated_at` | value (known cause) | 1/8 13% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |

- `request_preferred_date1._id`, `request_status._id`, `request_preferred_date2._id` — Zuper's internal id for a sub-record (MongoDB's ObjectId: a tax line, an address, a preferred window, a line's stock location as `location`). It names nothing a client can look up — the record's uid does that — and Tuper answers its own row id where it keeps the sub-record as a row, and none where it does not.
- `request_priority` — Tuper's own field: its request list, filters and detail card are built on jms.requests.priority, so every request carries one (LOW by default). Zuper's request record has no priority at all.
- `request_source.__v` — Zuper's own revision counter for the record (MongoDB's version key: 0 on 92 of the newest 150 assets, up to 6 on the rest). It counts Zuper's saves; Tuper keeps no revision count, so it answers 0.
- `request_source.created_by.created_at`, `request_source.created_by.last_login_at`, `request_source.created_by.profile_picture`, `request_source.created_by.updated_at`, `status_history[].done_by.created_at`, `status_history[].done_by.last_login_at`, `status_history[].done_by.profile_picture`, `status_history[].done_by.updated_at` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `request_source.updated_at`, `asset.updated_at` — an embedded copy of another record, and its updated_at is that record's row in Tuper — which is when the sync last wrote it, not when Zuper's changed. The same cause as the record's own updated_at.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `asset.custom_fields[].module_name` — Zuper puts module_name on about half of the records and not on the other half for the same field, and says PRODUCT on an asset's and on a person's alike (measured over 300 assets); it describes no field, so Tuper does not answer it (load.ts loadZuperCustomFields).
- `markdown_description`, `plain_text_description` — Zuper's request gained these two over time: the older requests answer only request_description. Tuper answers all three for every request.
- `billing_address.point_coordinates`, `service_address.point_coordinates` — an address's map point. Zuper writes [0, 0] (and a Point at 0,0) for an address it never located; the sync keeps no point for those rather than one in the Gulf of Guinea. The other way round, Tuper's own geocoder has placed a few addresses Zuper left unplaced.

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `billing_address._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 8/8 |
| `request_source.created_by.role.role_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 8/8 |
| `service_address._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 8/8 |
| `status_history[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 8/8 |
| `asset.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 5/8 |
| `status_history[].done_by.role.role_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 1/8 |

38 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (32): `billing_address.email`, `billing_address.first_name`, `billing_address.last_name`, `billing_address.phone_number`, `customer.customer_description`, `customer.plain_text_description`, `request_source.created_by.user_meta_data`, `service_address.email`, `service_address.first_name`, `service_address.last_name`, `service_address.phone_number`, `billing_address.geo_cordinates`, `billing_address.point_coordinates`, `customer.custom_fields`, `customer.customer_address.geo_cordinates`, `customer.customer_address.point_coordinates`, `service_address.geo_cordinates`, `service_address.point_coordinates`, `customer.customer_address.email`, `customer.customer_address.first_name`, `customer.customer_address.landmark`, `customer.customer_address.last_name`, `customer.customer_address.phone_number`, `customer.customer_address.zip_code`, `customer.customer_contact_no.home` …
- Zuper sends empty, Tuper omits (6): `assigned_to`, `assigned_to_team`, `attachments`, `created_by`, `custom_fields`, `customer.customer_address.property_id`

Agreed although written differently: empty_shape ×26, whitespace ×16, same_number ×8.

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
| `customer.customer_all_addresses[]` | array_length | 11/35 31% of records | `2` | `0` |
| `line_items[].plain_text_description` | extra_in_tuper (known cause) | 11/35 31% of records | _absent_ | `1. Visual inspection, adjust, and lubricate as required. Check the ove` |
| `customer.custom_fields[].type` | missing_in_tuper | 9/35 26% of records | `SINGLE_LINE` | _absent_ |
| `status_history[].done_by.created_at` | value (known cause) | 9/35 26% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `status_history[].done_by.last_login_at` | value (known cause) | 9/35 26% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `status_history[].done_by.updated_at` | value (known cause) | 9/35 26% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `line_items[].total_purchase_price` | extra_in_tuper (known cause) | 8/35 23% of records | _absent_ | `2940` |
| `status_history[].done_by.profile_picture` | value (known cause) | 8/35 23% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `customer.customer_category._id` | missing_in_tuper (known cause) | 7/35 20% of records | `60e6c2a3011f2b13008796cf` | _absent_ |
| `customer.customer_organization.updated_at` | value (known cause) | 6/35 17% of records | `2025-01-05T14:06:34.262Z` | `2026-09-21T00:53:23.668Z` |
| `organization.updated_at` | value (known cause) | 6/35 17% of records | `2025-01-05T14:06:34.470Z` | `2026-09-21T00:53:45.929Z` |
| `profit_breakdown` | value (known cause) | 5/35 14% of records | `{"products":3183,"services":0,"total_cost":3183,"estimate_total":4320,` | `null` |
| `tax_exempt` | extra_in_tuper (known cause) | 5/35 14% of records | _absent_ | `false` |
| `cpq_status` | value (known cause) | 4/35 11% of records | `{"errors":[],"formatted_errors":[]}` | `null` |
| `pending_option_selection` | missing_in_tuper (known cause) | 4/35 11% of records | `false` | _absent_ |
| `is_expired` | value (known cause) | 3/35 9% of records | `false` | `true` |
| `sub_total` | value (known cause) | 3/35 9% of records | `null` | `0` |
| `total_discount` | value (known cause) | 3/35 9% of records | `null` | `0` |
| `customer.custom_fields[]` | element_missing | 2/35 6% of records | `{"label":"Zoho CRM Contact ID","value":"4740393000002169005","hide_to_` | _absent_ |
| … | | 44 more, in the JSON | | |

- `created_by.created_at`, `created_by.updated_at`, `created_by.last_login_at`, `created_by.profile_picture`, `status_history[].done_by.created_at`, `status_history[].done_by.last_login_at`, `status_history[].done_by.updated_at`, `status_history[].done_by.profile_picture`, `notes[].created_by.created_at`, `notes[].created_by.last_login_at`, `notes[].created_by.updated_at`, `sold_by_user.created_at`, `sold_by_user.profile_picture`, `sold_by_user.updated_at`, `notes[].created_by.profile_picture` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `customer.updated_at`, `job.updated_at`, `customer.customer_organization.updated_at`, `organization.updated_at` — an embedded copy of another record, and its updated_at is that record's row in Tuper — which is when the sync last wrote it, not when Zuper's changed. The same cause as the record's own updated_at.
- `tax[]._id`, `line_items[].location`, `customer.customer_category._id`, `notes[]._id`, `attachments[]._id`, `customer.accounts._id`, `customer.customer_billing_address._id`, `customer.customer_contact_no._id` — Zuper's internal id for a sub-record (MongoDB's ObjectId: a tax line, an address, a preferred window, a line's stock location as `location`). It names nothing a client can look up — the record's uid does that — and Tuper answers its own row id where it keeps the sub-record as a row, and none where it does not.
- `total_markup`, `is_proposal`, `waiting_on_mr`, `waiting_on_po`, `line_items[].line_item_type`, `line_items[].line_item_uid`, `line_items[].tax`, `custom_fields[].hide_field`, `custom_fields[].read_only`, `line_items[].plain_text_description`, `line_items[].total_purchase_price`, `profit_breakdown`, `tax_exempt`, `cpq_status`, `pending_option_selection`, `sub_total`, `total_discount` — Zuper's quote has gained keys over time and each quote keeps the set it was saved with — measured on all 35 of GBG's quotes, 2026-09-21: is_proposal, waiting_on_mr/po and profit_breakdown appear only on quotes from 2026, total_markup from May 2025, cpq_status from July 2022; the oldest three answer null for sub_total and total_discount; lines gained line_item_type/uid and tax the same way. Tuper answers the complete quote for every quote. The same cause as a job's growing profitability block.
- `line_items[].product_ref_id`, `line_items[].product_uid` — the line names a part Zuper has since deleted — 13 distinct parts on 31 of GBG's 43 quote lines, each answering is_deleted: true inside the line. Owner decision 2026-09-21: deleted parts are not imported (the same decision as the 464 stock movements), so Tuper's line keeps the part's name and number but no link. product_ref_id is the part record itself, which Zuper embeds and Tuper does not.
- `public_url` — Zuper's link to the quote on its own customer portal. Tuper's customer-facing quote page belongs to the portal, which is outside this work, so Tuper answers no link rather than one not known to open.
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
| `deposit_payment_url` | url_host — different host AND path: ap-south-1.zuperpro.com/api/customer_portal/estimates/collect_deposit vs os.golfbuggyguy.com/quotes/7ebf1e8a-f2a5-44da-8279-9b79c52d993f/deposit | 15/35 |
| `job.job_status[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 14/35 |
| `job.job_status[].created_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].status_color` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].status_name` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].status_type` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].status_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 13/35 |
| `job.job_status[].synced_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].updated_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `status_history[].done_by` | positional — value: one side answers a value, the other a structure — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 13/35 |
| `job.job_status[].checklist_internal_object` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/35 |
| `job.job_status[].checklist[]` | positional — array_length: these array records carry no uid to pair them by, so only the count can be compared — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 12/35 |
| `line_items[].line_item_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 12/35 |
| … | 49 more, in the JSON | |

156 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (134): `created_by.user_meta_data`, `proposal_template`, `asset`, `customer_billing_address.geo_cordinates`, `customer_billing_address.point_coordinates`, `proposal_title`, `status_history[].done_by.user_meta_data`, `converted_date`, `customer.customer_description`, `customer.plain_text_description`, `status_history[].remarks`, `estimate_description`, `profit_breakdown`, `project`, `request`, `service_contract`, `cpq_status`, `line_items[].profit`, `line_items[].profit_margin`, `remarks`, `waiting_on_mr_uids`, `waiting_on_po_uids`, `prefix`, `line_items[].associated_products`, `line_items[].markdown_description` …
- Zuper sends empty, Tuper omits (22): `status_history[].customer_signature`, `customer.customer_address.property_id`, `status_history[].attachments`, `status_history[].line_items_status`, `taxation_meta.tax_provider`, `customer.customer_category`, `financing.promo_message`, `job.job_timezone`, `deposit.credits`, `financing.apr`, `financing.monthly_installment`, `financing.term`, `assets`, `customer.customer_all_addresses[].property_id`, `signatures`, `await_signature_by`, `option_groups`, `discount_breakups`, `line_items[].group_uid`, `line_items[].purchase_price`, `line_items[].tax.tax_code`, `vendor`

Agreed although written differently: empty_shape ×186, same_number ×143, whitespace ×30.

## invoices

13 records compared — 3 from the first page of Zuper's list, and 10 drawn at random from the 13 invoices record(s) Tuper has mapped to a Zuper uid.

### Fields that disagree

| field | what | how often | Zuper | Tuper |
|---|---|---|---|---|
| `created_by.created_at` | value (known cause) | 13/13 100% of records | `2021-07-08T08:59:49.000Z` | `2026-09-11T15:45:36.232Z` |
| `created_by.last_login_at` | value (known cause) | 13/13 100% of records | `2026-09-09T17:35:37.000Z` | `null` |
| `created_by.profile_picture` | value (known cause) | 13/13 100% of records | `https://s3.ap-south-1.amazonaws.com/prod.app.zuperpro/assets/profile_p` | `` |
| `created_by.updated_at` | value (known cause) | 13/13 100% of records | `2026-07-22T20:42:52.000Z` | `2026-09-15T10:39:58.926Z` |
| `customer.updated_at` | value (known cause) | 13/13 100% of records | `2026-07-02T15:25:56.148Z` | `2026-09-21T14:10:19.543Z` |
| `invoice_date` | value | 13/13 100% of records | `2021-07-25T18:30:00.000Z` | `2021-07-25T00:00:00.000Z` |
| `updated_at` | value (known cause) | 13/13 100% of records | `2025-06-25T11:49:19.749Z` | `2026-09-21T15:30:51.879Z` |
| `financing.is_enabled` | value | 12/13 92% of records | `true` | `false` |
| `due_date` | value | 11/13 85% of records | `2021-07-27T18:29:00.000Z` | `2021-07-27T00:00:00.000Z` |
| `tax[]._id` | missing_in_tuper (known cause) | 11/13 85% of records | `6571697ae80214da78ba6088` | _absent_ |
| `template.template_options` | extra_in_tuper | 11/13 85% of records | _absent_ | `{"format":"A4","orientation":"portrait"}` |
| `line_items[].line_item_uid` | extra_in_tuper | 10/13 77% of records | _absent_ | `ef2f16f9-1e91-45ac-ba8d-e5542a670b14` |
| `line_items[].product_ref_id` | value | 10/13 77% of records | `{"_id":"610533c81049a1576bfa210a","product_id":"135","price":325,"purc` | `null` |
| `line_items[].product_uid` | value | 10/13 77% of records | `61a75cf0-f1f2-11eb-a7cf-cb490006ff82` | `null` |
| `line_items[].line_item_type` | extra_in_tuper | 9/13 69% of records | _absent_ | `ITEM` |
| `line_items[].tax` | extra_in_tuper | 9/13 69% of records | _absent_ | `{"tax_name":"","tax_exempt":false,"tax_amount":0}` |
| `customer.customer_all_addresses[]` | array_length | 8/13 62% of records | `2` | `0` |
| `line_items[].location` | value (known cause) | 8/13 62% of records | `60f68e4aed5d6812f465f0ff` | `1befc7c5-3bec-430a-bda0-dc58e21eba17` |
| `job.updated_at` | value (known cause) | 7/13 54% of records | `2025-12-23T11:06:28.788Z` | `2026-09-16T08:01:28.240Z` |
| `status_history[]` | element_missing | 7/13 54% of records | `{"_id":"6110d7debc8ebe130b8cfcc4","status_name":"DRAFT","done_by":{"us` | _absent_ |
| `status_history[]` | array_length | 6/13 46% of records | `2` | `0` |
| `line_items[].total_purchase_price` | extra_in_tuper | 5/13 38% of records | _absent_ | `50` |
| `custom_fields[].hide_field` | missing_in_tuper | 4/13 31% of records | `false` | _absent_ |
| `custom_fields[].read_only` | missing_in_tuper | 4/13 31% of records | `false` | _absent_ |
| `discount` | value | 4/13 31% of records | `{"discount_applicability":"LINE_ITEM","discount_label":"Discount"}` | `null` |
| `estimate.__v` | missing_in_tuper (known cause) | 4/13 31% of records | `4` | _absent_ |
| `estimate.created_by` | missing_in_tuper | 4/13 31% of records | `{"user_uid":"a85133b2-5f05-4f45-b265-fc9f265b9b7b","first_name":"Richa` | _absent_ |
| `estimate.deposit` | missing_in_tuper | 4/13 31% of records | `{"collected_at":"2021-07-27T07:27:00.097Z","created_at":"2021-07-27T07` | _absent_ |
| `estimate.estimate_date` | value | 4/13 31% of records | `2021-07-25T18:30:00.000Z` | `2021-07-25T00:00:00.000Z` |
| `estimate.expiry_date` | value | 4/13 31% of records | `2021-07-30T18:30:00.000Z` | `2021-07-30T00:00:00.000Z` |
| `estimate.financing` | missing_in_tuper | 4/13 31% of records | `{"is_enabled":true}` | _absent_ |
| `estimate.line_items` | missing_in_tuper | 4/13 31% of records | `[{"serial_nos":[],"discount_type":"FIXED","_id":"60ffb5449c526e2b50abd` | _absent_ |
| `estimate.sent_date` | missing_in_tuper | 4/13 31% of records | `2021-07-27T07:48:18.317Z` | _absent_ |
| `estimate.updated_at` | value | 4/13 31% of records | `2025-06-25T11:49:19.631Z` | `2026-09-21T15:28:40.925Z` |
| `customer.custom_fields[].type` | missing_in_tuper | 3/13 23% of records | `SINGLE_LINE` | _absent_ |
| `estimate.job` | missing_in_tuper | 3/13 23% of records | `{"is_deleted":false,"scheduled_start_time":"2025-12-22T07:30:00.000Z",` | _absent_ |
| `job.current_job_status.status_name` | value (known cause) | 3/13 23% of records | `Invoiced` | `Workshop Complete` |
| `job.job_status[].is_offline` | extra_in_tuper | 3/13 23% of records | _absent_ | `false` |
| `job.job_status[].status_history_uid` | extra_in_tuper | 3/13 23% of records | _absent_ | `305fe0f7-6ed4-43a4-85ce-fece236952b3` |
| `job.job_status[].status_name` | value (known cause) | 3/13 23% of records | `Completed` | `Technical Sign Off` |
| … | | 35 more, in the JSON | | |

- `created_by.created_at`, `created_by.last_login_at`, `created_by.profile_picture`, `created_by.updated_at`, `notes[].created_by.created_at`, `notes[].created_by.last_login_at`, `notes[].created_by.profile_picture`, `notes[].created_by.updated_at` — an embedded copy of a user record. Tuper answers its own row's timestamps — the users were created when Zuper's were imported — and has no login history or Zuper-hosted profile picture. Who the user IS is compared as normal, and does disagree where it says so.
- `customer.updated_at`, `job.updated_at`, `customer.customer_organization.updated_at`, `organization.updated_at` — an embedded copy of another record, and its updated_at is that record's row in Tuper — which is when the sync last wrote it, not when Zuper's changed. The same cause as the record's own updated_at.
- `updated_at` — Tuper answers when its own row last changed — which is when the sync wrote it, not when Zuper's record changed. Inherent to a mirror; but a client that watches updated_at to detect a change is watching Tuper's clock, not Zuper's.
- `tax[]._id`, `line_items[].location`, `customer.customer_category._id`, `customer.customer_contact_no._id`, `job.customer_address._id`, `job.customer_billing_address._id`, `notes[]._id` — Zuper's internal id for a sub-record (MongoDB's ObjectId: a tax line, an address, a preferred window, a line's stock location as `location`). It names nothing a client can look up — the record's uid does that — and Tuper answers its own row id where it keeps the sub-record as a row, and none where it does not.
- `estimate.__v` — Zuper's own revision counter for the record (MongoDB's version key: 0 on 92 of the newest 150 assets, up to 6 on the rest). It counts Zuper's saves; Tuper keeps no revision count, so it answers 0.
- `job.current_job_status.status_name`, `job.job_status[].status_name` — Zuper keeps each job's own copy of a status's name from when the job entered it: GBG's status deb6531b was 'Invoiced' in 2021 and is 'Closed' today, and a 2021 job still answers 'Invoiced'. Tuper links the status and answers its name as it is now (the colour it does keep per job, 00100).

### Cannot be settled from here

| field | why | how often |
|---|---|---|
| `custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 13/13 |
| `customer.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 13/13 |
| `line_items[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 13/13 |
| `payment_term.payment_term_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 13/13 |
| `job.job_status[].remarks_free_text` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 8/13 |
| `job.job_status[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 7/13 |
| `job.job_status[].remarks` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 6/13 |
| `job.job_status[].checklist_internal_object` | positional — missing_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 4/13 |
| `job.job_status[].checklist[]` | positional — array_length: these array records carry no uid to pair them by, so only the count can be compared — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 4/13 |
| `job.job_status[].created_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 4/13 |
| `job.job_status[].status_color` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 4/13 |
| `job.job_status[].status_name` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 4/13 |
| `job.job_status[].status_type` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 4/13 |
| `job.job_status[].status_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 4/13 |
| `job.job_status[].synced_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 4/13 |
| `job.job_status[].updated_at` | positional — value — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 4/13 |
| `job.custom_fields[]._id` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 3/13 |
| `job.job_description` | markup — the same words, different HTML | 3/13 |
| `job.job_status[].status_history_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 3/13 |
| `line_items[].line_item_uid` | id — both are opaque identifiers: Tuper answers its own where the record has no Zuper one, so this may be correct | 3/13 |
| `line_items[].location` | positional — value: two different identifiers in a field that is not named as an id — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/13 |
| `line_items[].tax.tax_amount` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 3/13 |
| `line_items[].description` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/13 |
| `line_items[].product_uid` | positional — value: Zuper sends a value, Tuper sends nothing here — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 2/13 |
| `job.job_status[].status_history_uid` | positional — extra_in_tuper — inside an array whose records carry no key, so the two were paired by order and this may be a pairing artefact | 1/13 |
| … | 9 more, in the JSON | |

130 fields one side sends empty and the other leaves out — nothing is lost, but a client reading the key sees `undefined` on one of the two:
- Tuper sends empty, Zuper omits (116): `created_by.user_meta_data`, `customer.customer_description`, `customer.plain_text_description`, `dealer_fee`, `description`, `paid_date`, `prefix`, `reference_no`, `service_contract`, `customer_billing_address.geo_cordinates`, `customer_billing_address.phone_number`, `customer_billing_address.point_coordinates`, `line_items[].brand`, `line_items[].uom`, `payment_url`, `public_url`, `customer_billing_address.email`, `customer_billing_address.first_name`, `customer_billing_address.last_name`, `discount`, `financing.promo_message`, `line_items[].taxes`, `customer_billing_address.country`, `customer_billing_address.landmark`, `customer_billing_address.state` …
- Zuper sends empty, Tuper omits (14): `customer.customer_address.property_id`, `estimate.fees`, `estimate.organization`, `job.job_timezone`, `taxation_meta.tax_provider`, `line_items[].specification`, `assets`, `customer.customer_all_addresses[].property_id`, `customer.customer_category`, `line_items[].associated_products`, `line_items[].markdown_description`, `line_items[].meta_data`, `line_items[].plain_text_description`, `secondary_customers`

Agreed although written differently: empty_shape ×32, same_number ×24, whitespace ×7.

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
