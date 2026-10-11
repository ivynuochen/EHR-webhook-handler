# EHR Webhook Processor

A Node.js + TypeScript service that receives patient-event webhooks from an EHR and applies each event's side effect **once**, even when the EHR delivers the same event more than once.

| Event                | Side effect                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `session.completed`  | Increments the patient's `session_count`                           |
| `session.no_show`    | Flags the patient for outreach (`needs_outreach = 1`, reason `no_show`) |
| `patient.discharged` | Marks the patient `inactive` and records `discharged_at`           |

The webhook behaviour is modelled on [Healthie](https://docs.gethealthie.com/). See [Relationship to Healthie](#relationship-to-healthie) for where this differs.

---

## Quick start

**Requirements:** Node.js **>= 22.13** (developed on Node 26). Storage uses Node's built-in `node:sqlite`, so there are no native modules to compile and no database to install.

```bash
npm install
npm test                                  # run the test suite
WEBHOOK_SECRET=dev_secret npm run dev     # start the server on http://localhost:3000
```

In a second terminal, send a signed test event using the included script:

```bash
# args: <type> <event_id> <patient_id>
WEBHOOK_SECRET=dev_secret npx tsx scripts/send.ts session.completed evt_1 pat_123
# -> 200 { status: 'processed' }

WEBHOOK_SECRET=dev_secret npx tsx scripts/send.ts session.completed evt_1 pat_123
# -> 200 { status: 'duplicate' }   (same event ID, not counted twice)

curl localhost:3000/patients/pat_123
# -> { "id": "pat_123", "session_count": 1, ... }
```

Other commands:

```bash
npm run typecheck    # tsc --noEmit
```

### Configuration

| Variable         | Default          | Notes |
| ---------------- | ---------------- | ----- |
| `PORT`           | `3000`           | |
| `DATABASE_PATH`  | `./webhooks.db`  | SQLite file, created on first run. Use `:memory:` for a throwaway store. |
| `WEBHOOK_SECRET` | *(unset)*        | Shared HMAC secret. **If unset, signature checks are skipped** and a warning is logged. This is for local development only. |

On Node 22 you may see an `ExperimentalWarning` for `node:sqlite`. It's harmless.

---

## API

### `POST /webhooks/ehr`

Headers:

| Header                | Value |
| --------------------- | ----- |
| `Content-Type`        | `application/json` |
| `X-Webhook-Timestamp` | Unix time in seconds when the request was sent |
| `X-Webhook-Signature` | `sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" using WEBHOOK_SECRET>` |

Body:

```json
{
  "id": "evt_01J...",
  "type": "session.completed",
  "created_at": "2026-10-11T14:00:00.000Z",
  "data": {
    "patient_id": "pat_123",
    "session_id": "ses_456",
    "occurred_at": "2026-10-11T13:00:00.000Z"
  }
}
```

`patient.discharged` has the same shape, but its `data` contains only `patient_id` and `occurred_at`.

Responses:

| Status | Body | Meaning |
| ------ | ---- | ------- |
| 200 | `{ "status": "processed" }` | Side effect applied |
| 200 | `{ "status": "duplicate" }` | Event ID already processed; nothing changed |
| 200 | `{ "status": "ignored" }` | Valid event of a type this service doesn't handle |
| 400 | `{ "error": ... }` | Invalid JSON, envelope or payload |
| 401 | `{ "error": "invalid signature" }` | Missing, wrong or expired signature |
| 415 | `{ "error": ... }` | Not `application/json` |
| 500 | `{ "error": "internal error" }` | Processing failed and was rolled back; safe to retry |

### `GET /patients/:id`

A read-only endpoint for debugging and demos. It returns the patient row, or 404.

---

## Project structure

```
src/
  app.ts         HTTP layer: the request pipeline and status-code mapping
  schema.ts      zod schemas: the envelope plus a discriminated union of handled events
  signature.ts   HMAC signing and verification (constant-time, replay window)
  processor.ts   Idempotency: record the event ID and apply its effect in one transaction
  handlers.ts    The side effect for each event type
  db.ts          SQLite schema and transaction helper
  server.ts      Entry point: reads env, opens the DB, starts listening
scripts/send.ts  Sends signed test webhooks to a running server
test/app.test.ts End-to-end tests through the HTTP layer
```

---

## Technical decisions

### Idempotency: record the event ID and apply the effect in the same transaction

Webhook providers deliver **at least once**. If the sender doesn't get a 2xx in time, it retries, so duplicates are normal. `session.no_show` and `patient.discharged` are naturally idempotent, because setting a flag twice is harmless. `session_count + 1` is not, and double-counting sessions could affect things like billing or session limits.

Every event carries a unique `id`. `processEvent` does two things inside **one SQLite transaction**:

1. `INSERT INTO processed_events (event_id, ...) ON CONFLICT DO NOTHING`
2. If a row was inserted, apply the side effect. If not, return `duplicate`.

Why the two steps must be in one transaction:

| Without a transaction | Crash between the steps | Result |
| --- | --- | --- |
| Record the ID, then apply | ID recorded, effect never applied; the retry is skipped as a duplicate | Lost event |
| Apply, then record the ID | Effect applied, ID not recorded; the retry applies it again | Double count |
| **Both in one transaction** | Either both commit or neither does | **Effectively once** |

Why `INSERT ... ON CONFLICT` and not "SELECT, then INSERT if missing": check-then-insert is a race when two deliveries of the same event arrive concurrently. The primary-key constraint is enforced atomically by the database, so only one insert can succeed. In this app `node:sqlite` is synchronous and Node is single-threaded, so the race can't actually happen, but the same code stays correct with an async driver such as Postgres or with several instances.

Why the sender's event ID and not a hash of the payload: two genuinely different events can have identical bodies, and a retry can re-serialize the same event into different bytes. The event ID is what identifies an event.

### Signature verification

Anyone who knows the URL can POST to it, and idempotency only stops *repeats*. It does nothing about *forged* events (for example, discharging every patient). So the request is authenticated **before** it is parsed:

- **HMAC-SHA256 over the raw request bytes.** The route uses `express.raw()`, not `express.json()`, because re-serializing parsed JSON can change the bytes and break the signature.
- **Constant-time comparison** (`crypto.timingSafeEqual`), so response timing doesn't reveal how much of a guessed signature was correct.
- **A timestamp in the signed content with a 5-minute window**, so a captured request can't be replayed later.

### Request pipeline order

Authenticate → parse JSON → validate envelope → ignore unknown types → validate the full payload → process. Cheap rejections come first, and no work is done for unauthenticated requests.

### Unknown event types get a 200, not a 400

Many providers treat any non-2xx as a failure, keep retrying, and may eventually disable the endpoint. Returning 400 for an event type we simply don't handle would let new EHR event types break the whole integration. Valid events of unknown types are acknowledged with `{ status: "ignored" }`. A *handled* type with a malformed payload is a real error and gets a 400.

### Synchronous processing inside the request

Each side effect is a single local SQLite write that takes milliseconds, so processing inline keeps the design simple and lets the response code honestly reflect the outcome (a 500 means "retry"). With slower work, such as calling the EHR API for details, I would switch to an inbox/queue (see [Production considerations](#known-limitations-and-production-considerations)).

### SQLite via `node:sqlite`

It needs no setup and is a real transactional database with unique constraints, which the idempotency design depends on. Because it's built into Node, `npm install` has no native build step. The design carries over to Postgres unchanged.

### Unknown patients are created on first event

The EHR is the source of truth for patients, so an event for a patient we haven't seen creates them (`INSERT ... ON CONFLICT DO NOTHING`) and then applies the effect. The alternative is to hold such events for manual review. That's safer if patient IDs could be wrong, but it adds an operational queue.

### Event time vs. receive time

`discharged_at` uses the event's `occurred_at`, not the time we received it, because a retried delivery can arrive hours late.

### Exhaustive event handling

`applyEvent` ends its `switch` with a `never` check, so adding a new event type to the schema without handling it is a compile error.

---

## Failure handling

| Scenario | Response | What happens |
| --- | --- | --- |
| Missing, invalid or expired signature | 401 | Nothing is processed. |
| Body isn't JSON, or envelope is invalid | 400 | Nothing is processed. The sender is at fault, so retrying won't help. |
| Handled event type, invalid payload | 400 | Same as above; `issues` in the response explains why. |
| Unknown event type | 200 `ignored` | Acknowledged so the sender stops retrying. |
| Duplicate delivery (same `id`) | 200 `duplicate` | No side effect. Not a 409, because a non-2xx would make the sender retry indefinitely. |
| Concurrent duplicates | 200 / 200 `duplicate` | The primary key on `processed_events.event_id` lets only one delivery be processed. |
| Database error during processing | 500 | The transaction rolls back, so the event ID is **not** recorded. The sender retries, and the retry processes it normally. (Covered by the "rolls back on failure" test.) |
| Process crashes mid-request | No response (sender times out) | The uncommitted transaction is discarded. Same outcome as above: the retry is safe. |
| Events arrive out of order (e.g. `session.completed` after `patient.discharged`) | 200 | Each effect is independent: the session is counted and the patient stays inactive. A late event never reactivates a discharged patient. |
| Event for a patient we've never seen | 200 | Patient is created, then the effect is applied (see above). |
| EHR gives up retrying (outage longer than its retry window) | n/a | **Not handled here.** In production I'd add a periodic reconciliation job that polls the EHR API and corrects any drift. Webhooks provide speed; polling provides a safety net. |

Logging records only event IDs and error details, never payloads, so patient data (PHI) doesn't end up in logs.

---

## Testing

```bash
npm test
```

The tests (`test/app.test.ts`) go through the real HTTP layer with `supertest` against an in-memory database. Each test uses a fresh database. They cover:

- `session.completed` increments the count
- A duplicate delivery returns `duplicate` and doesn't double-count
- Three concurrent deliveries of the same event are counted once
- No-show sets the outreach flag; discharge marks the patient inactive
- A bad signature is rejected with 401
- An unknown event type is accepted and ignored
- A malformed handled event is rejected with 400
- A database failure mid-transaction returns 500 and leaves no `processed_events` row, so a retry would succeed

---

## Relationship to Healthie

This service follows the general behaviour of [Healthie webhooks](https://docs.gethealthie.com/): HMAC-signed POSTs, retries on failure, and therefore idempotent processing on the receiving side. It deliberately differs in two ways:

- **Event names and payload.** Healthie's events use different names and are "thin": they identify the changed resource, and the receiver fetches details through Healthie's API. The brief specifies `session.completed`, `session.no_show` and `patient.discharged`, so this service defines its own self-contained payload with a unique event `id`. In a real Healthie integration, the idempotency key and the details would come from Healthie's payload and API.
- **Signature scheme.** Healthie signs the request using its own header format. This service uses a simpler `timestamp.body` HMAC scheme, which demonstrates the same properties: integrity, authenticity and replay protection.

---

## Known limitations and production considerations

- **Inbox pattern for slow work.** If processing needed an EHR API call, I'd store the raw event, return 200 immediately, and process it from a worker with retries and a dead-letter queue.
- **Postgres for multiple instances.** The same `INSERT ... ON CONFLICT DO NOTHING` inside a transaction works across instances.
- **`processed_events` grows forever.** It needs a retention job that deletes rows older than the sender's retry window.
- **Same ID, different payload isn't detected.** Storing a payload hash would let us log a warning.
- **The signature check can be turned off** by leaving `WEBHOOK_SECRET` unset. In production the service should refuse to start without it, and support two secrets during rotation.
- **No structured logging or metrics yet.** I'd add counts of processed, duplicate and failed events by type, and an alert when events stop arriving (which can mean the sender disabled the endpoint).
- **The outreach flag has no consumer.** Who acts on it and how it gets cleared are product questions this service doesn't answer.

---

## How I used AI tools

I used Claude Code throughout, mainly as a tutor.

**Starting point.** I knew little about webhooks before this take-home. My experience is mostly backend work built on polling. I first had an agent generate a solution in a separate repo, but when I read it I realized I couldn't follow it or explain why it was built that way. I set it aside and started over with the goal of understanding the design, not just submitting working code.

**Learning first.** I told Claude about my background and what I already knew, and asked for a walkthrough designed for learning as much as possible. It explained how webhooks differ from polling (the sender controls timing and retries, delivery is at least once, events can arrive out of order) and then gave me a staged build plan: a basic endpoint, validation, storage and side effects, deliberately reproducing the duplicate-processing bug, idempotency, signature verification, wiring up the route, tests, failure handling, and production concerns.

**Building and asking questions.** I built the project stage by stage in a fresh repo. Most of the implementation code came from that plan. Whenever something didn't work or I was curious, I asked Claude to explain it, and I went deep on a few topics, including webhook security (HMAC signatures, raw-body handling, constant-time comparison, replay protection) and testing.

**Packaging.** Claude also wrote the `.gitignore`, split the finished code into commits by layer (so the history is organized for review rather than being a record of the order things were built in), and produced the first draft of this README, which I reviewed and edited.

**Verification.** I checked the behaviour with the test suite and by sending duplicate events to the running server by hand. I've read every file and can walk through the code and explain the design decisions and tradeoffs above.
