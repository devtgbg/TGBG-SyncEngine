// ── Operators by field type (architecture/04 ADR-017) ──
// Operators are a function of field_type, NOT of the entity — so the filter engine is generic.
import type { FieldType, Operator, FilterRule, FieldDef } from "./types";

export const OPERATORS_BY_TYPE: Record<FieldType, Operator[]> = {
  TEXT: ["CONTAINS", "NOT_CONTAINS", "EQUAL_TO", "NOT_EQUAL_TO", "IS_EMPTY", "IS_NOT_EMPTY"],
  NUMBER: ["EQUAL_TO", "NOT_EQUAL_TO", "GREATER_THAN", "LESS_THAN", "BETWEEN"],
  DECIMAL: ["EQUAL_TO", "NOT_EQUAL_TO", "GREATER_THAN", "LESS_THAN", "BETWEEN"],
  DATE: ["EQUAL_TO", "GREATER_THAN", "LESS_THAN", "BETWEEN"],
  DATE_TIME: ["EQUAL_TO", "GREATER_THAN", "LESS_THAN", "BETWEEN"],
  DROPDOWN: ["EQUAL_TO", "NOT_EQUAL_TO", "IS_EMPTY", "IS_NOT_EMPTY"],
  // EQUAL_TO/NOT_EQUAL_TO added so a LOOKUP can be filtered by its FK id (e.g. the Jobs "Job Category"
  // quick filter maps category → category_id = <uuid>). CONTAINS still matches on the embedded label.
  LOOKUP: ["EQUAL_TO", "NOT_EQUAL_TO", "CONTAINS", "NOT_CONTAINS", "IS_EMPTY", "IS_NOT_EMPTY"],
  BOOLEAN: ["EQUAL_TO"],
};

/** Operators that carry no value. */
export const VALUELESS_OPERATORS: ReadonlySet<Operator> = new Set(["IS_EMPTY", "IS_NOT_EMPTY"]);

export class FilterValidationError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = "FilterValidationError";
  }
}

/**
 * Validate one rule against the field it targets. Rejects — never silently ignores —
 * an unknown field, a wrong operator for the type, or a missing value (Tuper D-07:
 * Zuper silently drops these; Tuper rejects).
 */
export function validateRule(rule: FilterRule, field: FieldDef | undefined): void {
  if (!field) {
    throw new FilterValidationError(`unknown filter key '${rule.key}'`);
  }
  // Explicit opt-in, matching Zuper's per-column meta flags: a field is filterable
  // only if it says so. A field present for display/sort but not filtering is rejected.
  if (field.filterable !== true) {
    throw new FilterValidationError(`field '${rule.key}' is not filterable`);
  }
  if (rule.field_type !== field.field_type) {
    throw new FilterValidationError(
      `field '${rule.key}' is ${field.field_type}, not ${rule.field_type}`,
    );
  }
  const allowed = field.operators ?? OPERATORS_BY_TYPE[field.field_type];
  if (!allowed.includes(rule.operator)) {
    throw new FilterValidationError(
      `operator '${rule.operator}' is not valid for a ${field.field_type} field`,
    );
  }
  const needsValue = !VALUELESS_OPERATORS.has(rule.operator);
  if (needsValue && (rule.value === undefined || rule.value === null || rule.value === "")) {
    throw new FilterValidationError(`operator '${rule.operator}' requires a value`);
  }
  if (rule.operator === "BETWEEN" && (!Array.isArray(rule.value) || rule.value.length !== 2)) {
    throw new FilterValidationError(`operator 'BETWEEN' requires a two-element array`);
  }
}
