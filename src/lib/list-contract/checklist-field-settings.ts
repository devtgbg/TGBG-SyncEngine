// Which settings Zuper's checklist builder offers for each kind of question: its checklistFormAttributes, read in its
// builder code (field-form-builder) 2026-09-15, in Tuper's type names. The builder shows only these, and the server keeps
// only these (checklists.ts cleanConfig). Every question also has a Field Name and a Description.
// - A title has only a condition (Dependent Field): nothing to answer, so no Required, Read Only or Visibility.
// - A picture has Restrict to Camera and the stamps, tags and albums, but no Read Only and no Visibility; a signature can
//   be hidden from technicians but not hidden; a barcode and a video have neither.
// - Time Interval is the time picker's minute step (Zuper's field_meta.time_interval: 5 to 45, 30 when unset), and
//   "Choose first option by default" starts a dropdown on its first option (Zuper's default_option).
export type ChecklistSetting =
  | "PLACEHOLDER" | "REQUIRED" | "READ_ONLY" | "HIDDEN" | "HIDE_TO" | "VALIDATION" | "OPTION" | "DEFAULT_OPTION"
  | "RESTRICT_STATUS" | "TIME_INTERVAL" | "RESTRICT_CAMERA" | "STAMP_DATE_TIME" | "STAMP_GPS" | "ASSOCIATE_TAGS"
  | "AUTO_ALBUM" | "COPY_TO_FIELDS" | "DEPENDENCY";

const TEXT: ChecklistSetting[] = ["PLACEHOLDER", "REQUIRED", "DEPENDENCY", "HIDE_TO", "READ_ONLY", "HIDDEN", "COPY_TO_FIELDS"];
const CHOICE: ChecklistSetting[] = ["OPTION", "REQUIRED", "DEPENDENCY", "HIDE_TO", "READ_ONLY", "HIDDEN", "RESTRICT_STATUS", "COPY_TO_FIELDS"];
const PICTURE: ChecklistSetting[] = ["REQUIRED", "RESTRICT_CAMERA", "STAMP_DATE_TIME", "STAMP_GPS", "DEPENDENCY", "COPY_TO_FIELDS", "ASSOCIATE_TAGS", "AUTO_ALBUM"];
const LISTS: Record<string, ChecklistSetting[]> = {
  SECTION_HEADER: ["DEPENDENCY"],
  SINGLE_LINE_TEXT: [...TEXT, "VALIDATION"],
  MULTI_LINE_TEXT: TEXT,
  DATE: TEXT,
  TIME: [...TEXT, "TIME_INTERVAL"],
  DATE_TIME: [...TEXT, "TIME_INTERVAL"],
  SINGLE_SELECTION: CHOICE,
  MULTI_SELECTION: CHOICE,
  DROPDOWN: [...CHOICE, "DEFAULT_OPTION"],
  BARCODE_SCAN: ["PLACEHOLDER", "REQUIRED", "DEPENDENCY", "COPY_TO_FIELDS"],
  UPLOAD: ["PLACEHOLDER", "REQUIRED", "READ_ONLY", "HIDDEN", "DEPENDENCY", "HIDE_TO", "COPY_TO_FIELDS"],
  SINGLE_IMAGE: PICTURE,
  MULTI_IMAGE: PICTURE,
  SIGNATURE: ["REQUIRED", "DEPENDENCY", "HIDE_TO", "COPY_TO_FIELDS"],
  VIDEO: ["REQUIRED", "DEPENDENCY", "COPY_TO_FIELDS"],
};
const SETS = new Map(Object.entries(LISTS).map(([type, list]) => [type, new Set(list)]));

/** Whether Zuper's builder offers this setting on this type of question. */
export const hasSetting = (fieldType: string, setting: ChecklistSetting): boolean => SETS.get(fieldType)?.has(setting) ?? false;

/** Zuper's Time Interval choices, in minutes, and the step its time pickers use when none is set. */
export const TIME_INTERVALS: readonly number[] = [5, 10, 15, 20, 30, 45];
export const DEFAULT_TIME_INTERVAL = 30;
/** A date & time or time question's minute step. */
export function timeInterval(config: { time_interval?: unknown } | null | undefined): number {
  const n = Number(config?.time_interval);
  return TIME_INTERVALS.includes(n) ? n : DEFAULT_TIME_INTERVAL;
}
