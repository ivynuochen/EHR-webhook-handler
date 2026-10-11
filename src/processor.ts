import { transaction, type DB } from './db';
import { applyEvent } from './handlers';
import type { WebhookEvent } from './schema';

export type Outcome = 'processed' | 'duplicate';

export function processEvent(db: DB, event: WebhookEvent): Outcome {
  return transaction(db, () => {
    const claim = db
      .prepare(`INSERT INTO processed_events (event_id, type, received_at)
                VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING`)
      .run(event.id, event.type, new Date().toISOString());

    if (claim.changes === 0) return 'duplicate'; // already processed

    applyEvent(db, event);
    return 'processed';
  });
}