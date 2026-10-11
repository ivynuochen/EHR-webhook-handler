import type { DB } from './db';
import type { WebhookEvent } from './schema';

export function applyEvent(db: DB, event: WebhookEvent): void {
  const now = new Date().toISOString();
  const patientId = event.data.patient_id;

  // The EHR is the source of truth. If we haven't seen this patient, create them.
  db.prepare(`INSERT INTO patients (id, updated_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`)
    .run(patientId, now);

  switch (event.type) {
    case 'session.completed':
      db.prepare(`UPDATE patients SET session_count = session_count + 1, updated_at = ? WHERE id = ?`)
        .run(now, patientId);
      break;
    case 'session.no_show':
      db.prepare(`UPDATE patients SET needs_outreach = 1, outreach_reason = 'no_show', updated_at = ? WHERE id = ?`)
        .run(now, patientId);
      break;
    case 'patient.discharged':
      db.prepare(`UPDATE patients SET status = 'inactive', discharged_at = ?, updated_at = ? WHERE id = ?`)
        .run(event.data.occurred_at, now, patientId);
      break;
    default: {
      const unreachable: never = event; // compile error if you add a type and forget to handle it
      throw new Error(`Unhandled event: ${JSON.stringify(unreachable)}`);
    }
  }
}