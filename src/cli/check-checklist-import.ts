/**
 * What the Zuper checklist import preserves.
 *
 *   npm run check-checklist-import
 *
 * These assertions used to live in Tuper's _checklist_builder_check.ts, which is
 * the check for Tuper's own checklist builder. They moved here with the code they
 * exercise: `checklistFields` maps Zuper's field types, meta_options, dependency
 * semantics and validations, so it is Zupersync's concern, not Tuper's.
 *
 * Pure — no database, no Zuper API, no env vars. It checks the mapping only.
 */

import { checklistFields } from "../lib/migration/zuper-sync.js";
import { hasSetting, timeInterval } from "../lib/list-contract/checklist-field-settings.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => (c ? (pass++, console.log("  pass  " + n)) : (fail++, console.log("  FAIL  " + n)));

// Zuper's per-type settings lists (its builder's checklistFormAttributes).
ok("per-type settings: a title has only a condition; a picture has Restrict to Camera but no Read Only or Visibility",
  hasSetting("SECTION_HEADER", "DEPENDENCY") && !hasSetting("SECTION_HEADER", "REQUIRED") && !hasSetting("SECTION_HEADER", "READ_ONLY")
  && hasSetting("MULTI_IMAGE", "RESTRICT_CAMERA") && !hasSetting("MULTI_IMAGE", "READ_ONLY") && !hasSetting("MULTI_IMAGE", "HIDDEN") && !hasSetting("MULTI_IMAGE", "HIDE_TO"));
ok("…a signature can be hidden from technicians but not hidden; only a dropdown has a default option; only times have an interval",
  hasSetting("SIGNATURE", "HIDE_TO") && !hasSetting("SIGNATURE", "HIDDEN") && hasSetting("DROPDOWN", "DEFAULT_OPTION") && !hasSetting("SINGLE_SELECTION", "DEFAULT_OPTION")
  && hasSetting("DATE_TIME", "TIME_INTERVAL") && hasSetting("TIME", "TIME_INTERVAL") && !hasSetting("DATE", "TIME_INTERVAL"));
ok("Time Interval: 30 minutes unless another of Zuper's steps is set",
  timeInterval({}) === 30 && timeInterval({ time_interval: 15 }) === 15 && timeInterval({ time_interval: 7 }) === 30);

const synced = checklistFields([
  { field_name: "Pick", field_type: "SINGLE_ITEM", field_options: ["A", "B"], default_option: true, hide_to_fe: true, read_only: true, meta_options: { restrict_to_camera: true } },
  { field_name: "When", field_type: "DATETIME", field_meta: { time_interval: 15 }, hide_field: true },
  { field_name: "Photo", field_type: "MULTI_IMAGE", read_only: true, meta_options: { restrict_to_camera: true, watermark_timestamp: true } },
  { field_name: "Volts", field_type: "SINGLE_LINE", field_validation: "number", min_value: 0, max_value: 15 },
  { field_name: "Sign", field_type: "SIGNATURE", hide_to_fe: true, hide_field: true, is_dependent: true, dependent_on: "Pick", dependent_options: ["A"] },
]);
const sc = (i: number) => JSON.stringify(Object.entries(synced[i].config ?? {}).sort(([x], [y]) => x.localeCompare(y)));
ok("the Zuper import keeps a dropdown's default option, Read Only and Hide to FE (not Restrict to Camera)",
  sc(0) === JSON.stringify([["default_option", true], ["hide_to_fe", true], ["read_only", true]]));
ok("…a date & time question's interval and hidden flag", sc(1) === JSON.stringify([["hidden", true], ["time_interval", 15]]));
ok("…a picture's Restrict to Camera and Stamp Date & Time, not Read Only", sc(2) === JSON.stringify([["restrict_to_camera", true], ["stamp_date_time", true]]));
ok("…a number validation with its limits", sc(3) === JSON.stringify([["max_value", 15], ["min_value", 0], ["validation", "number"]]));
ok("…and a signature's condition and Hide to FE, but not hidden", sc(4) === JSON.stringify([["depends_on", "pick"], ["hide_to_fe", true], ["show_when", ["A"]]]));

const pics = checklistFields([
  { field_name: "Cable Photo", field_type: "IMAGE", meta_options: { restrict_to_camera: false, watermark_timestamp: true, watermark_geo_cords: true } },
  { field_name: "Notes", field_type: "SINGLE_LINE", meta_options: { watermark_timestamp: true } },
]);
ok("…a picture's Stamp Date & Time and Stamp GPS Coordinates (a text question has no stamps)",
  JSON.stringify(pics[0].config) === JSON.stringify({ stamp_date_time: true, stamp_gps: true }) && Object.keys(pics[1].config ?? {}).length === 0);

console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
