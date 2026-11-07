# Nightly reconciliation — plan

**Goal.** Every night, read everything Zuper has, compare it against what Tuper holds, and answer three
questions: *what differs*, *why*, and *what was done about it*. The point is not to find bugs once; it is
that `jms.*` is treated by other applications as Zuper's data, so any divergence is a defect in that promise,
and a divergence nobody is told about is the worst kind.

Four applications now read this copy: Tuper itself, the AMC Engine (live on `jms` since 2026-10-10, with
**no fallback** to Zuper's API), the client and staff portals, and DataHouse. The AMC Engine books customer
appointments from it.

---

## 1. Most of this already exists — do not rebuild it

`src/cli/compare.ts` already reads **Zuper's whole list** for a kind and **every Tuper record mapped to a
Zuper uid** (`zuper_sync_map`, through Tuper's API), and classifies:

| bucket | meaning |
|---|---|
| `missing` | Zuper lists it, Tuper never wrote it |
| `behind` | Zuper changed it after Tuper last wrote it (`updated_at > synced_at`) |
| `only in Tuper` | Tuper holds it, Zuper no longer lists it — split into flagged-deleted and still-live |

It already supports `--apply` (re-sync missing and behind, paced, recorded as an admin re-sync),
`--deletions` (verify each by uid before flagging — absence from a list is **not** taken as proof),
`--out report.json`, and `--fields` for field-by-field parity on a sample.

**So the work is not "build a comparison". It is: schedule it, persist it, explain it, alert on it, and
close the blind spots below.**

---

## 2. What it does not cover today

Record-presence mode covers 10 kinds: jobs, customers, organizations, users, assets, products, contracts,
requests, estimates, invoices.

**Not covered, and three of them are entities we already know are stale:**

| kind | why it matters |
|---|---|
| `job_categories` | **No Zuper webhook exists and no sweep covers it.** A rename never arrives. AMC matches "AMC - Workshop" **by name**. |
| `job_statuses` | Same. AMC matches TBC/Scheduled **by name**. |
| `recurring_jobs` | Frozen since a one-off CLI run on 2026-09-22. Zuper had 1,360 series against jms's 1,325 on 2026-10-13, and a dated divergence was found on 2026-10-19. |
| `teams` | Covered by `--fields` but not by presence. |
| `properties` | Not covered either way. |
| `asset_history` | jms holds **0 rows**. Zuper fires `asset.history` with no asset uid, so it is unroutable; history is read from the asset's side instead. |

A nightly check that omits the entities most likely to be wrong would report green while the known faults
persist. **Closing this list is the highest-value part of the work**, not the scheduling.

---

## 3. Design

### 3.1 Where it runs

Follow the existing shape. `reconcile.ts` exports `startReplay`/`stopReplay` and `sweep.ts` exports
`startSweep`/`stopSweep`; both are started and stopped from `src/index.ts` according to the live settings
document. A nightly reconciliation is a third of these — `startNightly`/`stopNightly`, gated on its own
setting so it can be turned off from the dashboard without a deploy, like everything else.

It must **not** run inside the webhook request path, and must refuse to start a second pass while one is
running (the same rule `reconcile.ts` already states for its own ticks).

### 3.2 When

Once a day at a fixed local hour, defaulting to roughly 02:00 Asia/Dubai — after the day's work and before
the AMC Engine's 05:45 drift check, so a problem it finds is already visible when that runs.

### 3.3 Cost, measured rather than guessed

| kind | Zuper rows | list calls |
|---|---|---|
| jobs | 48,468 | ~485 pages + ~140 empty windows (`jobsByMonth` walks 30-day `updated_at` windows back to 2015) |
| customers | 4,144 | 42 |
| assets | 2,292 | 23 |
| organizations | 1,019 | 11 |
| everything else | small | ~20 |

**Roughly 700–750 Zuper calls, about 16 minutes at the sweep's 45/min cap.** Zuper's measured ceiling on
this account is ~150/min (`x-rate-limit`), not the 200–700 the docs advertise, and live webhook re-fetches
compete for it — so the nightly pass must use the same pacer and never the full ceiling.

Verifying `only in Tuper` by uid costs one call per record. Today that is ~650 customers (a one-off backlog
from a Zuper cleanup), then a handful a night.

### 3.4 What it writes

A new table in Zupersync's **own** store (not jms): one row per run per kind, with the counts, the sample
uids, the run's duration, and the classified causes below. The dashboard gets a page; the engine's
`sync.engine` heartbeat already proves it is running, which is a different question from whether it is
*complete*.

---

## 4. The "why" — classifying each difference

Counting differences is the easy half. Each bucket has distinguishable causes, and the cause decides the fix:

**`missing` (Zuper lists it, Tuper never wrote it)**
- a delivery that never arrived — Zuper gives up after `max_retries: 4`
- a delivery that failed and hit the 5-attempt cap: **these never retry again** and sit waiting for a person
  (one has been stranded since 2026-09-30). Join to `sync.webhook_events` on the uid to say which.
- a record type we deliberately do not import — must be declared, not inferred

**`behind` (`updated_at > synced_at`)**
- a change whose webhook never arrived, or arrived and failed
- a change Zuper makes **without firing any event**: a custom-field-only edit has no webhook at all, and a
  customer merge reassigns jobs without touching each job

**`only in Tuper`, and the split matters**
- **404 by uid → genuinely deleted in Zuper.** 650 customers were in this state on 2026-10-22 after a Zuper
  cleanup, because Zuper has **no `customer.delete` event** and the sweep compares rows that exist rather
  than noticing absence.
- **still live in Zuper → not a deletion at all**, usually a merge: Wayne Blumrick's duplicate was deleted
  and his **1,925 jobs** were moved to the surviving record in Zuper around May 2026, while jms kept the old
  link. Our copy is not missing those jobs — it has them pointing at the wrong customer.
- **absent from a list but alive** — Zuper's lists omit some records. Never conclude deletion from a list.

**field drift with equal timestamps** — a field we do not map, or a change that does not bump `updated_at`.

---

## 5. What it may fix automatically, and what it may not

| difference | action |
|---|---|
| `missing`, `behind` | **Re-sync automatically.** Idempotent, and exactly what a webhook does. Paced, capped per run. |
| stranded deliveries at the attempt cap | **Reset and replay automatically**, scoped to those uids. Nothing else ever retries them. |
| `only in Tuper`, 404 by uid | **Report, do not delete,** until the behaviour has been watched for a few nights. Then flag deleted. |
| `only in Tuper`, still live | **Never auto-act.** This is the merge case; deleting would turn a wrong link into a missing record. Re-read the record and its children instead. |
| field drift | Report only. A field we do not map is a code change, not a data fix. |

**Deleting is the one thing worth being slow about.** Every other action restores Zuper's truth; a deletion
destroys a row on the strength of an absence, and we have already seen absence mean "merged" rather than
"gone".

---

## 6. Traps this must be built around

Each of these was found the hard way in production and will silently corrupt the result if forgotten:

1. **`filter.customer_uid` on `/api/jobs` is silently ignored** and returns all 48,468 rows as if they
   matched. The working parameter is `filter.customer`. **Assert that a filter narrowed the result before
   trusting it** — an ignored filter is indistinguishable from a huge match.
2. **`updated_at` in jms is ZUPER's timestamp, not ours.** Compare against `zuper_sync_map.synced_at`.
   A row written late carries an older `updated_at` than its write.
3. **Zuper repeats the last page past the end** — stop on a repeated first row, not only on an empty page.
4. **Zuper answers 200 on failure** in places; check the envelope, not just the status.
5. **`POST /api/jobs/filter` accepts filter keys and ignores them**, returning the whole table.
6. **The job list errors past roughly 27k offset**, which is why `jobsByMonth` windows by `updated_at`.
7. **Lists omit records** (inactive users, for one). Absence is a question, not an answer.
8. **Zuper's customer list carries no `updated_at`**, so "behind" cannot be computed for customers the same
   way — the existing sweep compares those field by field instead.

---

## 7. Phases

**Phase 1 — make tonight's answer exist.** Schedule the existing `compare.ts` logic nightly, read-only,
persisting counts and samples per kind. No auto-fix. Gives a baseline and a week of evidence about how noisy
each bucket really is.

**Phase 2 — close the blind spots.** Add `job_categories`, `job_statuses`, `recurring_jobs`, `teams`,
`properties`, `asset_history` to the comparison. These are the entities most likely to be wrong and least
likely to self-heal.

**Phase 3 — explain, don't just count.** Join each difference to `sync.webhook_events` and
`sync.api_calls` so the report says *why*: never delivered, failed and capped, no event exists, merged.

**Phase 4 — act.** Turn on auto re-sync for `missing` and `behind` and auto-replay for stranded
deliveries. Leave deletions reporting-only until the numbers have been watched.

**Phase 5 — alert.** Surface it on the dashboard and raise something when a bucket exceeds a threshold, or
when the run itself fails to complete. A nightly check nobody reads is worth very little.

---

## 8. Decisions — settled 2026-11-05

1. **Watch first.** Phase 1 runs read-only for a week. No auto-fix until the normal nightly noise floor is known.
2. **A document every night**, reviewed after a week.
3. **Deletions flagged automatically**, once the watching week is done.
4. **The ~16 minutes of Zuper budget at 02:00 is acceptable.**
5. **Why not just make the 30-minute sweep do this?** — answered below.

---

## 9. Why the sweep cannot replace this

The proposal was reasonable: if the sweep runs every 30 minutes, keep fixing the sync until the sweep finds
nothing, test that for months, and skip the nightly pass. It does not work, and the reason is structural
rather than a matter of tuning.

**The sweep asks a different question.** `src/sweep.ts` builds its input as:

    const to = new Date();
    const from = new Date(to.getTime() - minutesBack * 60_000);   // 180 minutes

and asks Zuper *what changed between those two times*. So its question is **"what did Zuper change in the
last 3 hours?"** The nightly question is **"does everything Zuper has match what we have?"**

Those are not the same question at two frequencies. Running the first more often, or for months, never
answers the second — a record whose `updated_at` has not moved in 3 hours is not something the sweep
examines and fails on; it is never in the input at all.

**This is not theoretical. The sweep ran every 30 minutes, clean, throughout all of the following:**

| fault | why the sweep could never see it |
|---|---|
| **650 customers** deleted in Zuper, still live here | it compares the rows Zuper *lists*; an absent row is not in the comparison set |
| **1,925 jobs** on the wrong customer since May 2026 | the merge moved them in Zuper without each job's `updated_at` moving |
| **recurring_jobs** frozen since 2026-09-22 | not a swept entity at all |
| **asset_history**, 0 rows | not a swept entity at all |
| **job_categories / job_statuses** renames | no webhook exists *and* not swept |

Every one was invisible **by construction**. A sweep reporting "nothing to update" for months is exactly
what we observed while all five were wrong — so that signal cannot be used as proof of completeness.

### 9.1 And a sixth, measured on 2026-11-05: the sweep's cap silently loses a bulk edit

The 1,530 jobs this reconciliation found behind were not a scatter of missed deliveries. Every one of them
carries the same Zuper `updated_at` — **`2026-10-15T16:40:03.098Z`, identical to the millisecond** on jobs
created between 2021 and 2026, confirmed against Zuper's own API. That is a single bulk UPDATE inside Zuper.
It touched **2,355 jobs in that one minute**, and **1,496 of the 1,530 had no webhook delivery of any kind** —
Zuper's bulk operations do not fire events per record.

The sweep did see them, and could not finish:

| | |
|---|---|
| jobs the bulk touched in one minute | 2,355 |
| `SWEEP_MAX_RESYNCS`, per pass | **200** |
| passes before the 180-minute window slides past 16:40 | ~6 |
| most the sweep could ever repair | ~1,200 |
| actually repaired | ~905 |
| **stranded until 2026-11-05** | **1,530** |

Once `updated_at` falls out of the window, the remainder is not retried — it is not in the sweep's input any
more. So the sweep's own cap converts "too much changed at once" into permanent divergence, and
`stoppedEarly` was printed to the console and persisted nowhere, so it disappeared with the container's logs.

**Two consequences, both acted on:** `capped` and `jobsLeftBehind` now go into the engine's state document so
the condition is visible rather than inferred; and this is the case Phase 4 exists for — the nightly pass is
the only thing whose input is "everything", so it is the only thing that can drain a backlog the window has
already slid past. Raising the cap does not fix it: a larger bulk edit loses the remainder just the same.

**And the cheap version of the proposal is the expensive one.** Making the sweep "see what was left" over
the whole dataset means reading the whole dataset: ~700 Zuper calls. At every 30 minutes that is **~33,600
calls a day** against a measured ~150/min shared ceiling, starving the live webhook re-fetches that keep the
copy current. The 180-minute window is precisely what makes the sweep cheap enough to run 48 times a day.

**Both, and they are complementary:**

| | sweep, every 30 min | nightly reconciliation |
|---|---|---|
| question | what changed recently that we missed? | does everything match? |
| input | Zuper's last 3 hours | Zuper's entire list |
| catches | a missed delivery, within the hour | deletions, merges, frozen entities, anything older than the window |
| cost | small, continuous | ~700 calls, once |

The goal the proposal describes — *fix the live path until nothing is ever left behind* — is the right goal.
The nightly pass is how we would **know** it had been reached. Without it, "the sweep found nothing" means
only that nothing broke in the last three hours.
