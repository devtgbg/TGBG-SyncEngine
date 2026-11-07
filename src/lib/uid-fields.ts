/**
 * Which uid field each entity's records carry.
 *
 * A self-fetching entity is handed nothing but a uid: `syncOne` builds a stub, and the transform then reads the
 * uid back off that stub under Zuper's own name for it — `asset_history_live` fetches
 * `/api/assets/{r.asset_uid}/history`. Get the name wrong, or leave it out, and the path is built from
 * `undefined`: Zuper answers, the sync reports success, and nothing was read.
 *
 * It lives in its own module with no imports so `npm run check-routes` can assert that every self-fetching
 * entity appears here. TypeScript cannot: the table is a Record<string, string>, so an absent entity is not a
 * type error, it is a 404 at whatever hour Zuper sends that event.
 */

export const UID_FIELD_BY_ENTITY: Record<string, string> = {
  jobs: "job_uid", job_details: "job_uid", job_activity: "job_uid",
  customers: "customer_uid", organizations: "organization_uid", users: "user_uid",
  assets: "asset_uid", asset_history_live: "asset_uid",
  estimates: "estimate_uid", estimate_activity: "estimate_uid", invoices: "invoice_uid",
  contracts: "service_contract_uid", products: "product_uid", requests: "request_uid",
};

/** Give a stub record the uid field its entity reads. */
export function stubUidFields(entityName: string, uid: string): Record<string, string> {
  const k = UID_FIELD_BY_ENTITY[entityName];
  return k ? { [k]: uid } : { uid };
}
