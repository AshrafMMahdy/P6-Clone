# Vico Schedule Planner / Vico Control project file (.dpp)

Reverse-engineered, read-only. Implemented in `core/lob/vico.ts` (`readVicoDpp`), tested in `tests/vico.test.ts`.

**Sources.** Five files written by Trimble Vico Schedule Planner v6.8.84.139: the reference file
("Case Studies II -- Vico Term Project II -- After Optimization 16 January 2024.dpp", 26 841 bytes), its "Before
Optimization" version, an autosave copy (`~...Before Optimization.dpp`), and two "Vico Workshop" projects. Ground truth
came from the user's screenshots of the reference file and from the MS Project XML Schedule Planner exported next to it
("VICO to MSProject Optimized.xml": task/line start, finish and working durations, and the calendar). Every value the
reader returns for the reference file matches that ground truth: 14 tasks, dates, crews, durations, quantities,
consumptions, 281 857.4 man-hours and EUR 11 061 220 BoQ cost.

Offsets below are byte offsets into the *decompressed* body of the reference file unless they say "file offset";
`#n` is an object id and `cls n` a record class.

## 1. Container

| File offset | Bytes | Meaning |
|---|---|---|
| 0 | `44 53 53 1A` | magic `"DSS\x1a"` |
| 4 | `72 17 00 00` | u32 LE 6002. Same in all samples; probably a format version |
| 8 | 25 bytes ASCII | `"GraphisoftControl Project"` |
| 33 | `1A 00` | terminator byte, then 0 |
| 35 | `88 13 00 00` | u32 LE 5000. Same in all samples; meaning unknown |
| 39 | `78 DA ...` | a single zlib stream (best compression) to end of file |

The uncompressed size is not stored in the header. The reference file inflates to 197 564 bytes. The reader checks the
magic and the signature, then looks for a zlib header from offset 33 on.

## 2. Body: records

The body is a flat sequence of records, with no nesting. They point at each other by object id.

```
record   := u32 length (whole record, header included) | u32 objectId | u32 class | property*
property := u16 propertyId | u8 type | payload
```

The record stream ends with a sentinel record of length 16 whose id and class are both `0xFFFFFFFF` (offset 197 548).
The reference file has 1 405 records in 63 classes. All integers are little-endian. A property id can repeat inside one
record (class 63 does this, see §6).

| type | payload |
|---|---|
| `0x02` | i32 |
| `0x03` | i64 time in seconds since 1970. Holds wall-clock time encoded as if it were UTC: a task start of 07:00 is the calendar's 07:00. Also used for durations (seconds of working time) |
| `0x05` | f64 |
| `0x06` | u32 byte length, then UTF-16LE text including a trailing NUL |
| `0x07` | u32 length, then a blob (only the calendar uses one, see §7) |
| `0x08` | u32: an object reference or an enum |
| `0x09`, `0x0B` | array: u32 element size, u32 count, then the elements. Size 4 holds object ids; size 8 holds f64 |
| `0x0A` | map: u32 key size, u32 value size, u32 count, then the (key, value) pairs. 4/4 maps an id to an id; 4/8 maps an id to an f64 |
| `0x80 \| t` | the default (zero or empty) value of type `t`, with no payload. Seen: `0x82 0x83 0x85 0x86 0x87 0x88` |

No other type codes occur in the samples. The reader throws on an unknown type, because without a known length the rest
of the record cannot be skipped. Most records begin with the same three properties: `2` name, `3` code and `6` a list
of attached setting records (class 42).

## 3. Project (class 2, always the first record: `#3` at 0)

| prop | meaning | reference value |
|---|---|---|
| 2 / 3 | name / code | "Case Studies II -- Vico Term Project II" / "CSII-TPII" |
| 303 | project start (time) | 2025-01-31 00:00 |
| 313 | project end (time) | 2027-01-01 23:59:59 |
| 343 | a time | 2024-01-05 23:59:59. Meaning unknown (date saved / status date?) |
| 302 | → class 79 `#4`, prop 100 = list of calendars [`#5`] | |
| 306 | every location, in breakdown order (depth first) | 21 ids |
| 310 | units of measure (class 17: 2 = name, e.g. "M2") | 14 ids |
| 353 | breakdown levels (class 10), top first | [`#38` "Main", `#1943` "Parts", `#5146` "Floors"] |
| 365 | → class 101 `#18`; its prop 100 is the task order of the task list | PW, WP, PAW ... ELE |
| 372 | → class 103 `#19`, the schedule results (§6) | |
| 367 | currency symbol | "€" |
| 6 | project information as class-42 records: 2 = field name, 102 = text value, 101 = int value | `#101` "Company's name" = "Metropolia and HTW Berlin"; `#104` "Creator's name" = "Group" |

Class-42 records also hold view and UI settings, for example "PlacetimeView::Show Dependencies" and
"ControlTime:FollowCalendar" (101 = 1).

## 4. Location breakdown

**Levels** (class 10): 2 = level name. The reference file has `#38` "Main" (the project level), `#1943` "Parts" and
`#5146` "Floors".

**Locations** (class 37):

| prop | meaning |
|---|---|
| 2 / 3 | name / code (code empty in all samples) |
| 301 | parent location (empty for the top location) |
| 302 | child locations, in order |
| 305 | 1-based position among its siblings |
| 304, 309 | → a class-5 record (201 = f64 1.0) and an empty class-162 record. Meaning unknown |

The level of a location is its depth in the tree. Reference file: `#35` "Jordanian Embassy Residential Building"
(level 0) → `#1944` "1", `#1948` "2" (Parts) → `#5143..#5169` "1".."9" under part 1, `#5175..#5199` under part 2
(Floors). Names repeat under different parents, so the reader builds codes as name paths below the top location:
"1", "1/9", "2/1" and so on. The breakdown is not always Parts over Floors: the autosave file has levels
"1" / "Floors" / "Parts", and the workshop has "1" / "Floors" / "Sections" with 3, 3 and 2 sections per floor.

## 5. Tasks, task-locations, quantities, crews

**Task** (class 12, e.g. `#667` "Plaster Works" / "PW" at 46 770):

| prop | meaning |
|---|---|
| 2 / 3 | name / code |
| 315 | the locations the task is planned in. Their level is the task's location precision: Parts in the reference file, Sections in the workshop |
| 516 | map location → task-location record (class 11) |
| 540 | the task's sub-tasks (class 130) in order. Schedule Planner shows them as "Plaster Works-1", "Plaster Works-2"; the MS Project export shows them as summary rows |
| 541 | → class 98, prop 100 = the task's quantity items (class 43) |
| 507 | units used (class 17) |
| 515, 519, 545, 547 | → class-98 records with two id lists (100, 101). Empty in every sample. A plausible home for logic, not confirmed |
| 525 | → class 113 (112 = back-reference to the task) |
| 529, 530 | → class 122 (100..102 = f64 −1) |
| 514, 517, 522, 532, 533, 535 (=10000), 543 (random 16-letter key), 544 (map location → f64, the same numbers as 527 on the task-locations) | not decoded |

**Sub-task / line** (class 130, e.g. `#674` "Plaster Works-1" at 47 537):

| prop | meaning |
|---|---|
| 300 | owning task |
| 301 | its task-location records (class 11), in execution order |
| 302 | planned start (time). Reference: 2025-07-10 07:00 |
| 305 | → crew assignment (class 32) |
| 304 | i32 1 on 13 of 28 lines. Not decoded |

**Task-location** (class 11, e.g. `#5315` at 120 060): one task in one location.

| prop | meaning |
|---|---|
| 315 | the location |
| 516 / 526 | owning task / owning sub-task |
| 500 | **productivity factor**: the effective consumption is the item consumption divided by this factor. Reference PW: 3.7546 (part 1) and 3.7071 (part 2) |
| 528 | **number of crews** (the number Schedule Planner prints at the end of each flowline) |
| 414 | → class 63, its scheduled start and duration (§6) |
| 527 | f64, unique 1..28 across the file. Not decoded (drawing order or colour?) |
| 520, 521, 522, 523, 529, 512 | not decoded |

**Quantity item** (class 43, e.g. `#151` "Plaster" / "PL" at 33 932):

| prop | meaning |
|---|---|
| 2 / 3 | name / code |
| 501 | base consumption, in hours per unit (PW: 1.84789) |
| 505 | map location → quantity (f64), at floor level (finer than the task's precision): 18 × 3 944.44 = 71 000 M2 |
| 506 | → unit (class 17, e.g. `#46` "M2") |
| 508 | owning task |
| 513 | unit price. Cost = quantity × price, e.g. CS 7 050 × 75 = 528 750; the sum over all items is 11 061 220 |
| 521 | → class 139 (100 = 4). Not decoded |

**Crew assignment** (class 32, e.g. `#675` at 47 676): 200 = resources (class 31), 204 = f64 people per crew for each
resource. **Resource** (class 31, e.g. `#1119` "Plastering Crew" / "PC "): 106 → unit (class 17 "HOURS"), 104 = colour.

**Derived values, verified against the reference file:**

- crew size = Σ(204) × 528. PW: 2 × 7 = 14; CS: 5 × 5 = 25; EISF: 3 × 1 = 3.
- effective consumption = Σ_loc q × base ÷ factor(task-location containing loc) ÷ Σ q. PW: 0.495; ELE: 274.587. These
  are the "Consumption" values Schedule Planner shows. Σ q × effective consumption = 281 857.4 man-hours, the project
  report's figure.
- duration of a task-location (working hours) = Σ q × base ÷ factor ÷ crew size. PW part 1: 35 500 × 1.84789 ÷ 3.75458
  ÷ 14 = 1 248 h. This equals the duration stored in class 63.
- Gantt "duration" (days) = Σ task-location durations ÷ 8 h. PW: (1 248 + 1 264) ÷ 8 = 314.
- "Production rate" = total quantity ÷ (finish − start in working days). PW: 71 000 ÷ 201 = 353.2. The reader does not
  return it.

## 6. Schedule results

**Class 63** (task-location timing, e.g. `#5316` at 120 242): prop 100 occurs 7 times (times) and prop 101 occurs 7
times (durations, in seconds of working time). The first three pairs are the task-location's start and duration
(PW part 1: 2025-07-10 07:00 and 4 492 800 s = 1 248 h). The last four pairs are always (project start, 28 800 s).
102 → the calendar. The meaning of the repeats (planned / forecast / actual?) is not known; the reader uses the first
pair.

**Finish dates.** Project 372 → `#19` (class 103). Its prop 103 maps task → class 105 (100 = task, 109 = one class-104
record per sub-task); class 104 prop 101 is that sub-task's finish. Example: `#700` = 2026-02-25 15:00 and `#19159` =
2026-04-29 15:00 for PW. Prop 105 of `#19` maps four tasks to a second set of class-105 records holding a stale value
(the project start). Recomputing start + working duration on the calendar reproduces every stored finish, and the MS
Project export's finishes, for all 28 lines of the reference file. In the "Before" file, the ELE finish stored in the
.dpp (2026-12-22) is consistent with its own durations; that file's XML export (2026-08-17) came from a different edit
of ELE.

## 7. Calendar (class 19, `#5` at 943)

Prop 100 is a blob that is **big-endian**, unlike the rest of the file (803 bytes):

```
u32 12 (version?) | u32 n + n UTF-16LE chars name ("default") | u8 1 |
7 × (u32 start-of-work seconds after midnight, u32 working seconds), Monday first   -> Mon..Fri 25200 (07:00), 28800 (8 h); Sat, Sun 0
u32 holidayCount (13) | per holiday: u32 n + UTF-16LE name, u8 kind,
    kind 3: i64 from, i64 to, u8 flag      -> fixed date, yearly (flag 1); e.g. Christmas 2006-12-25
    kind 5: i64 date, u8 weekday (0=Mon)   -> first <weekday> on or after that month-day; e.g. Memorial Day 05-25 + Mon,
                                              Thanksgiving 11-22 + Thu (3), Election Day 11-02 + Tue (1)
u32 13, then 13 × u32 0..12 (an index list), then 8 zero bytes
```

Expanding these 13 rules for 2020-2036 gives exactly the 182 non-working weekdays in the MS Project export. The export
also lists 2020-01-01 and 2020-01-20; those two fall before its window. Prop 101 is f64 1.0, not decoded. Only one
calendar occurs in the samples, and every class-63 record references it.

## 8. What is not decoded

- **Logic.** None of the five samples has a task-to-task dependency. The class sets of the five files match
  (apart from view-state class 157), the only records that reference several tasks are task-keyed lists and maps (task order, schedule results, view
  layout), and the candidate class-98 lists on tasks are
  empty. The reference schedule is driven by fixed sub-task start
  dates; its float report (Façade 0, Plaster 111 ...) is distance to the latest finish. Lags, buffers, location lags and
  the link types are therefore unknown. The reader returns `links: []`. If it meets a record class outside the
  reference set, it says so in `notes`.
- **Timing mode** (paced / as soon as possible / continuous), the **location order direction**, and splitting /
  discontinuity settings. Candidates are the integer flags on class 12 (514, 517, 522, 532, 533, 535) and 304 on class
  130; they could not be told apart with these samples.
- The header u32s 6002 and 5000, class-5, class-7 (crew/resource factor records, all 1.0), class-76/77/96/99/151/159/160
  (view and layout state), class-117 (checklist items such as "Availability of Resources ensured" with dates), and
  class-101 prop 109 (monthly time → record map).
- Multiple calendars, resources with more than one member type, multiple quantity items per task, and actuals or
  progress all appear only in degenerate form, so they have not been verified.
