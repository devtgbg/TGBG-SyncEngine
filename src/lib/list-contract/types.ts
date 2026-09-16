// ── Universal list contract — types (architecture/04-api-contract.md ADR-017) ──
// Pure types, no Supabase/Next imports, so the core is unit-testable in isolation.

/** Field types the filter engine understands. Operators derive from THIS, not the entity. */
export type FieldType =
  | "TEXT"
  | "NUMBER"
  | "DECIMAL"
  | "DATE"
  | "DATE_TIME"
  | "DROPDOWN"
  | "LOOKUP"
  | "BOOLEAN";

/** The operator set. A rule's operator must be valid for its field_type (see operators.ts). */
export type Operator =
  | "EQUAL_TO"
  | "NOT_EQUAL_TO"
  | "GREATER_THAN"
  | "LESS_THAN"
  | "BETWEEN"
  | "CONTAINS"
  | "NOT_CONTAINS"
  | "IS_EMPTY"
  | "IS_NOT_EMPTY";

/** One filter clause from the client. Carries its own type metadata (spec/05 §3). */
export interface FilterRule {
  key: string;
  field_type: FieldType;
  operator: Operator;
  value?: unknown;
  module?: string;
  type?: "default_field" | "custom_field";
}

/** Body of POST /{entity}/filter. */
export interface FilterRequest {
  page?: number;
  limit?: number;
  sort?: "ASC" | "DESC";
  sort_by?: string;
  filter_rules?: FilterRule[];
  filter_rule_operator?: "AND" | "OR";
  /** Rules ANDed with everything else whatever filter_rule_operator says (the list's search box). */
  and_rules?: FilterRule[];
  preferred_timezone?: string;
  include_deleted?: boolean;
  /** The columns to return, in order (Customize columns, report 05); cleaned against the descriptor's catalog. */
  columns?: string[];
}

/** A filterable/sortable field on an entity. */
export interface FieldDef {
  /** External key used by the client (e.g. "email", "role.name"). */
  key: string;
  label: string;
  field_type: FieldType;
  /** The physical column this maps to (may differ from key; may be a joined column). */
  column: string;
  filterable?: boolean;
  sortable?: boolean;
  /** Expose as an inline "quick filter" dropdown above the list (DROPDOWN fields with options). */
  quick?: boolean;
  /** DROPDOWN options, for meta/filter. */
  options?: { label: string; value: string }[];
  /**
   * For a display-only LOOKUP column: a PostgREST embed fragment selected instead of the raw column,
   * e.g. "category:category_id(name)". The row then carries row[key] = { …embedded }, which the
   * list renders via `displayPath` (default "name"). Never sortable (it's not a physical column).
   */
  embed?: string;
  displayPath?: string;
  /**
   * A computed column with no physical backing — excluded from the SELECT (so PostgREST never sees it),
   * never sortable/filterable. The value is supplied client-side (e.g. via ListTable's `augment` hook,
   * which fetches an aggregate per row id) and shown through a renderCell. Used for AR Balance.
   */
  virtual?: boolean;
  /** The field's name in the Filters drawer when it differs from its column header (Zuper's "Job Status" for Status). */
  filterLabel?: string;
  /** The conditions offered, when not every operator of the field type makes sense (an array column, a computed field). */
  operators?: Operator[];
  /** The column holds an array (job_tags, or a computed id list): EQUAL_TO / CONTAINS mean "has any of the values",
   *  NOT_EQUAL_TO / NOT_CONTAINS "has none of them", IS_EMPTY "has none at all". */
  array?: boolean;
  /** Filterable, but left out of the Filters drawer's list (another field stands for it there; old saved views still work). */
  filterHidden?: boolean;
}

/** Everything the generic handler needs to serve one entity. Registered once per entity. */
export interface EntityDescriptor {
  entity: string;
  schema: string; // e.g. "jms"
  table: string; // e.g. "users"
  /** Columns returned by default in the list. */
  defaultColumns: string[];
  /** Every column the list can show (Customize columns, report 05), in its order; defaults to defaultColumns. */
  columnCatalog?: string[];
  /** Columns that can't be removed or moved (Zuper's locked ID and title), always shown first. */
  lockedColumns?: string[];
  /**
   * Extra field keys always SELECTed but never shown as columns — for display helpers that need
   * them (e.g. the customer Name cell and customer pickers join first_name + last_name).
   */
  extraSelect?: string[];
  fields: FieldDef[];
  /** Default sort applied when the request names none. */
  defaultSort: { column: string; dir: "ASC" | "DESC" };
  /** The read permission required to list this entity (ADR-009, D-09). */
  readPermission: string;
  /** Whether the entity has a soft-delete flag (is_deleted). */
  softDelete?: boolean;
  /** Fixed clauses always ANDed on top (e.g. a Technicians view = users where role = FE). */
  baseFilter?: WhereClause[];
  /** The order of the Filters drawer's field list (Zuper's), by field key; fields not named follow in field order. */
  filterOrder?: string[];
  /** The field the list's search box looks in (by default the first text column). */
  searchKey?: string;
  /** Zuper's KPI cards over the list (Show KPIs — its Quotes list, report 44): the first card counts every row the list's
   *  filters leave except `total.excludeStatuses`; each other card the rows in its statuses, with `valueColumn` added up.
   *  Picking a card narrows the list to its statuses through `statusKey`. */
  stats?: {
    statusKey: string;
    statusColumn: string;
    valueColumn: string;
    total: { key: string; label: string; excludeStatuses: string[] };
    cards: { key: string; label: string; statuses: string[] }[];
  };
}

/** A resolved, executable filter — the pure output of the query planner. */
export interface WhereClause {
  column: string;
  op: Operator;
  value?: unknown;
  /** From a LOOKUP field: a value that isn't record ids is a name, matched against the linked records before the query
   *  runs (lookup-filters.ts). */
  lookup?: boolean;
  /** From an array field (FieldDef.array). */
  array?: boolean;
}

/** The normalized, executable plan. Pure data — the executor turns this into a Supabase query. */
export interface QueryPlan {
  schema: string;
  table: string;
  columns: string[];
  /** Tenant + scope + user filters, already combined. */
  where: WhereClause[];
  /** How the user filter_rules combine (tenant/scope clauses are always ANDed on top). */
  filterCombinator: "AND" | "OR";
  /** Number of leading `where` clauses that are mandatory (tenant + scope) and AND-ed. */
  mandatoryCount: number;
  orderBy: { column: string; dir: "ASC" | "DESC" };
  limit: number;
  offset: number;
  /** The entity has an is_deleted column (so the executor may filter on it). */
  softDelete: boolean;
  includeDeleted: boolean;
}

/** The minimal caller identity the planner/scope needs. */
export interface Principal {
  userId: string;
  tenantId: string;
  /** Coarse role: 'admin' is unscoped; 'tl'/'fe' are row-scoped. */
  coarseRole: "admin" | "tl" | "fe";
  /** Permission keys granted to this caller. */
  permissions: Set<string>;
  /** The caller's access role id (for status role-gates). */
  accessRoleId?: string | null;
}
