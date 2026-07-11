# 18 · HR — Training & Certifications

**Status: DRAFT v0.1**

This chapter is for **HR / People Ops**. It covers the training course catalogue,
scheduled sessions, employee enrollments, and the certification-compliance control
**HR-07** (mandatory-training tracking with automatic certification expiry).

**Screen:** `/hcm/training` · **Required permission:** `hr` or `hr_admin` (exec may
view; an employee sees their own training/certifications via self-service `ess`).

Tabs: **Courses** · **Sessions & enrollments** · **Certifications & compliance**.

---

## 1. Build the course catalogue

1. Go to **Training** (`/hcm/training`) → **Courses** tab.
2. Enter a course code (e.g. `SAFETY`), a name, and a category
   (`Safety` / `Compliance` / `Technical` / `General`).
3. Set **Validity (months)** to the recert cadence — e.g. `12` means a certification
   earned on this course expires 12 months after completion. Leave it blank for a
   non-expiring credential.
4. Tick **Mandatory** to flag a course whose certification lapse is a compliance
   finding, and **Requires a score** to force a score at completion, then **Save**.

## 2. Schedule sessions and enroll employees

1. Open the **Sessions & enrollments** tab.
2. Under **New session**, enter the course code, a session date, an instructor and a
   capacity, then **Save**.
3. Under **Enroll an employee**, enter the **Session ID** and the employee code, then
   **Enroll**. The enrollment starts as **enrolled**.

## 3. Complete an enrollment (mints a certification)

1. In the enrollments table, a row that is still `enrolled`/`attended` shows a score
   box and a **Complete** button.
2. Enter a score if the course requires one, then click **Complete**. A course flagged
   **Requires a score** cannot be completed without a score (`SCORE_REQUIRED`).
3. On completion of a **mandatory** or **recert** course, a certification is minted or
   renewed automatically, with an expiry of **completion date + validity months**. A
   renewal supersedes the employee's prior certification for that course.

## 4. Certifications & compliance

1. Open the **Certifications & compliance** tab.
2. The **compliance panel** lists employees whose mandatory-course certifications are
   **expired or expiring** within the window (default 30 days). Change **Window (days)**
   to widen or narrow the horizon; the badges summarise the expired / expiring counts.
3. The certification register below lists every credential with its issue date, expiry
   and status (`Active` / `Expired` / `Superseded`).

## 5. Control callout — HR-07 (mandatory-training / certification compliance)

Completing a course cannot be recorded without its required assessment, a certification
is minted automatically with a tracked expiry, and the compliance panel surfaces any
mandatory certification that has lapsed or is about to. This keeps safety- and
compliance-critical training current and evidenced for audit.

## 6. Troubleshooting

| Message | Meaning | Fix |
|---|---|---|
| `SCORE_REQUIRED` | The course requires a score and none was entered | Enter a score before clicking **Complete** |
| `COURSE_EXISTS` | Duplicate course code | Use a unique course code |
| `ALREADY_ENROLLED` | The employee is already enrolled in that session | Enroll in a different session |
| `ENROLLMENT_NOT_FOUND` | The enrollment does not exist (or belongs to another company) | Refresh the list and retry with a valid enrollment |
| `COURSE_NOT_FOUND` / `SESSION_NOT_FOUND` | The referenced course/session does not exist | Create the course/session first |
