// Where Zuper's Update Field can copy a checklist answer (copy_to_field, captured read-only 2026-09-15). For a job its
// Select Field lists Default Fields — Job Title, Job Description, Priority, Service Address, Billing Address — then the
// job's custom fields. The two addresses need Address Lookup (Google Places) to fill an address, so they wait for a
// Places key. For a customer, its checklist form reads the phones (customer_contact_no.mobile/home/work) and the
// description; its custom fields follow. Pure, for the builder and the server.
export type CopyModule = "JOB" | "CUSTOMER";
export const COPY_DEFAULTS: Record<CopyModule, { key: string; label: string }[]> = {
  JOB: [
    { key: "job_title", label: "Job Title" },
    { key: "job_description", label: "Job Description" },
    { key: "job_priority", label: "Priority" },
  ],
  CUSTOMER: [
    { key: "customer_mobile_phone", label: "Mobile Phone" },
    { key: "customer_home_phone", label: "Home Phone" },
    { key: "customer_work_phone", label: "Work Phone" },
    { key: "customer_description", label: "Description" },
  ],
};
/** Question types whose answer can be copied to a field (not a title, a file, a photo or a signature). */
export const COPYABLE_TYPES = new Set([
  "SINGLE_LINE_TEXT", "MULTI_LINE_TEXT", "DATE", "TIME", "DATE_TIME", "SINGLE_SELECTION", "MULTI_SELECTION", "DROPDOWN", "BARCODE_SCAN",
]);
