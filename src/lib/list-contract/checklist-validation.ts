// Zuper's Validation on a checklist's text answer (the edit panel's None / Number / Email / Phone Number / Address Lookup /
// Regex, read in its builder 2026-09-15). Its form checks a number against the question's min/max and a pattern against
// the whole answer (Angular's Validators.pattern). Address Lookup is Google Places search, which Tuper doesn't have a key
// for yet, so it checks nothing. Pure: the checklist page shows the problem, and the server refuses the answer.
export type ChecklistValidation = "number" | "email" | "phone" | "address" | "regex";
export const VALIDATIONS: { value: "" | ChecklistValidation; label: string }[] = [
  { value: "", label: "None" }, { value: "number", label: "Number" }, { value: "email", label: "Email" },
  { value: "phone", label: "Phone Number" }, { value: "address", label: "Address Lookup" }, { value: "regex", label: "Regex" },
];
export const VALIDATION_KEYS = new Set<string>(VALIDATIONS.map((v) => v.value).filter(Boolean));

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()\-.]{6,20}$/;

/** What's wrong with a (non-empty) answer under the question's validation, e.g. "must be an email address"; null if fine. */
export function validationProblem(
  c: { validation?: string; regex_value?: string; min_value?: number; max_value?: number } | null | undefined, value: string,
): string | null {
  switch (c?.validation) {
    case "number": {
      if (!/^-?\d+(\.\d+)?$/.test(value)) return "must be a number";
      const n = Number(value);
      if (typeof c.min_value === "number" && n < c.min_value) return `must be at least ${c.min_value}`;
      if (typeof c.max_value === "number" && n > c.max_value) return `must be at most ${c.max_value}`;
      return null;
    }
    case "email": return EMAIL.test(value) ? null : "must be an email address";
    case "phone": return PHONE.test(value) && (value.match(/\d/g)?.length ?? 0) >= 6 ? null : "must be a phone number";
    case "regex": {
      if (!c.regex_value) return null;
      try { return new RegExp(`^(?:${c.regex_value})$`).test(value) ? null : "doesn't match the required format"; } catch { return null; }
    }
    default: return null;
  }
}
