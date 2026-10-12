# OpenCode Go: monthly reset now comes from the status API

Researched 2026-10-12. Question: the OpenCode Go console now appears to expose
the monthly reset/cooldown in `GET /console/api/go/status`; what does the
`opencode-go-usage` extension need to change to use it instead of deriving the
monthly reset from the billing renewal date (`access.endsAt`)?

## Answer

The month meter now carries its own `resetsAt`, and the extension's parser
already prefers it (`m.resetsAt ?? periodEnd`), so the monthly countdown
switches automatically with no functional change required. Two things are still
worth doing:

1. The `access.endsAt` fallback is currently applied to **all three** meters.
   `fiveHour.resetsAt` is nullable, and a null there means the period has not
   opened yet, not "resets at billing period end" — so the fallback should be
   scoped to the month meter only.
2. The header comment and the inline comment in `src/dashboard.ts` state the
   month meter has no `resetsAt`; that is now stale.

### Why the 5h countdown sometimes showed the month reset

That is the same bug. The fallback was applied to every meter, and
`fiveHour.resetsAt` is nullable: while the 5h period has not opened (the
console renders "Starts on first use"), the parser substituted `access.endsAt` —
which is the month reset — so the 5h countdown displayed the month countdown.

## Evidence

### 1. Live response (probed 2026-10-12)

`curl -H 'x-org-id: wrk_…' -H 'Cookie: __Host-console_session=st_…' \
https://opencode.ai/console/api/go/status` returned HTTP 200 with
`access.meters.month.resetsAt` present (values below redacted to placeholders):

```json
{
  "cancelAtPeriodEnd": false,
  "resumability": "renewing",
  "access": {
    "startsAt": "2026-10-05T01:38:04.000Z",
    "endsAt": "2026-11-05T01:38:04.000Z",
    "cancelAtPeriodEnd": false,
    "meters": {
      "fiveHour": {
        "startsAt": "...",
        "resetsAt": "2026-10-12T03:31:48.000Z",
        "limitMicroCents": "…",
        "usedMicroCents": "…"
      },
      "week": {
        "startsAt": "2026-10-12T00:00:00.000Z",
        "resetsAt": "2026-10-19T00:00:00.000Z",
        "limitMicroCents": "…",
        "usedMicroCents": "…"
      },
      "month": {
        "resetsAt": "2026-11-05T01:38:04.000Z",
        "limitMicroCents": "…",
        "usedMicroCents": "…"
      }
    }
  }
}
```

Two facts from this probe:

- `month.resetsAt` exists and is a string (not null).
- In the normal renewing case it equals `access.endsAt`
  (`2026-11-05T01:38:04.000Z`). So the two are interchangeable while the
  subscription is merely renewing.

### 2. Console bundle schema

The console's own schema (current bundle
[`index-DfrCDTRy.js`](https://opencode.ai/console/assets/index-DfrCDTRy.js),
observed 2026-10-12) defines the meters as:

```js
const QW = x({
  startsAt: I(kn),
  resetsAt: I(kn),
  limitMicroCents: Wo,
  usedMicroCents: Wo,
}); // fiveHour
const JW = x({
  startsAt: kn,
  resetsAt: kn,
  limitMicroCents: Wo,
  usedMicroCents: Wo,
}); // week
const YW = x({ resetsAt: kn, limitMicroCents: Wo, usedMicroCents: Wo }); // month
const ZW = x({ fiveHour: QW, week: JW, month: YW });
const XW = x({ startsAt: kn, endsAt: kn, cancelAtPeriodEnd: T, meters: ZW });
// ...
access: I(XW);
```

- `kn` is the Date schema; `I(...)` marks nullable. So `fiveHour.resetsAt` is
  **nullable**, while `week.resetsAt` and **`month.resetsAt` are not**.
- The month meter has no `startsAt`; its only fields are `resetsAt`,
  `limitMicroCents`, and `usedMicroCents`.
- `startsAt` / `endsAt` / `cancelAtPeriodEnd` live on `access`, separate from
  the meters.

The bundle registers the route as `"/api/go/status"` relative to its API base,
i.e. the same `/console/api/go/status` the extension calls.

### 3. How the console uses these fields

From the Go page bundle
([`app-pages-BR5CO2AK.js`](https://opencode.ai/console/assets/app-pages-BR5CO2AK.js),
observed 2026-10-12):

- The monthly meter row reads its own field:
  `{ label: "Monthly", meter: v.month, resetsAt: v.month.resetsAt, ends: a.data?.cancelAtPeriodEnd === true }`.
  `access.endsAt` is **not** used to compute the monthly reset.
- The countdown label depends on the meter and on cancellation:
  `` `${e.ends ? "Ends" : "Resets"} in ${ei(e.resetsAt, e.now)}` ``, and when
  `e.resetsAt` is falsy the console shows `"Starts on first use"`.
- During a failed/retrying renewal, the grace period is derived from the month
  meter's reset: `get graceEndsAt() { return Se().meters.month.resetsAt }`, and
  the retry window is `{ startsAt: access.endsAt, endsAt: graceEndsAt }`. This
  is the case where `month.resetsAt` can differ from `access.endsAt`
  (grace extends past the renewal date), which is why reading the meter is the
  correct source.
- `access.startsAt` / `access.endsAt` remain in use for subscription/billing
  UI (invoice periods, "next …" dates).

### 4. Repo history confirming the old contract

`git show 3340ccd` ("fix(opencode-go-usage): derive monthly reset from
access.endsAt", 2026-09-21) records the prior state: "The month meter carries no
resetsAt; the console page shows the billing-period end as the monthly reset
date." That is the behavior being superseded.

## What to change

Endpoint, auth, and `UsageMeter` shape stay the same. The change is confined to
`opencode-go-usage/src/dashboard.ts`:

- `parseStatusPayload` — apply the `access.endsAt` fallback only to the month
  meter; leave a null `fiveHour.resetsAt` as null so the panel shows `—`
  instead of a bogus billing-end date:

  ```ts
  const ownResetsAt =
    typeof m.resetsAt === "string" && m.resetsAt ? m.resetsAt : null;
  // access.endsAt is the billing period end. Only the monthly meter has ever
  // shared it, and only as a legacy fallback; a null fiveHour.resetsAt means
  // the period has not opened yet ("starts on first use" in the console).
  const resetsAt = ownResetsAt ?? (period === "monthly" ? periodEnd : null);
  ```

- Update the file header comment and the inline comment that claim the month
  meter has no `resetsAt`, and add `month.resetsAt` to the example payload in
  the header.

No README change is required: the README documents the endpoint and the
"partial data" behavior but never states how the monthly reset is derived.

### Out of scope (noted, not required)

The console labels the monthly countdown "Ends in" when
`access.cancelAtPeriodEnd` is true, and "Starts on first use" when a meter's
`resetsAt` is null. The extension always renders the panel column as
"Resets in" and shows `—` for a null reset. Adopting those labels would need
`cancelAtPeriodEnd` plumbed into `UsageMeter` (and a footer string change); the
request only covers using the newly provided month reset.

## Verified vs not verified

- Verified: the live status response contains `month.resetsAt`; the console
  bundle's month meter schema requires `resetsAt` and marks `fiveHour.resetsAt`
  nullable; the console frontend reads `month.resetsAt` for the monthly reset
  and for `graceEndsAt`; the repo's prior commit documented the missing field.
- Not verified: the server-side handler that computes `month.resetsAt` (the
  console is served as a bundle; no first-party source for the handler was
  found), and whether `month.resetsAt` differs from `access.endsAt` in every
  renewal-retry variant rather than only when the grace period extends.
