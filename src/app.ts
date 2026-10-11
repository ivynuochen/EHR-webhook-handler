import express from 'express';
import type { DB } from './db';
import { Envelope, EVENT_TYPES, WebhookEvent } from './schema';
import { verifySignature } from './signature';
import { processEvent } from './processor';

const KNOWN = new Set<string>(EVENT_TYPES);

export function createApp(deps: { db: DB; secret?: string }) {
  const { db, secret } = deps;
  const app = express();

  app.post('/webhooks/ehr', express.raw({ type: 'application/json', limit: '100kb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) { res.status(415).json({ error: 'expected application/json' }); return; }
    const rawBody = req.body;

    // 1. Authenticate before parsing anything
    if (secret && !verifySignature({
      secret, rawBody,
      timestamp: req.header('x-webhook-timestamp'),
      signature: req.header('x-webhook-signature'),
    })) { res.status(401).json({ error: 'invalid signature' }); return; }

    // 2. Parse
    let json: unknown;
    try { json = JSON.parse(rawBody.toString('utf8')); }
    catch { res.status(400).json({ error: 'invalid JSON' }); return; }

    // 3. Envelope check, then accept and ignore unknown types
    const env = Envelope.safeParse(json);
    if (!env.success) { res.status(400).json({ error: 'invalid envelope' }); return; }
    if (!KNOWN.has(env.data.type)) { res.status(200).json({ status: 'ignored' }); return; }

    // 4. Strict validation for known types
    const parsed = WebhookEvent.safeParse(json);
    if (!parsed.success) { res.status(400).json({ error: 'invalid payload', issues: parsed.error.issues }); return; }

    // 5. Process exactly once
    try {
      const outcome = processEvent(db, parsed.data);
      res.status(200).json({ status: outcome });
    } catch (err) {
      // The transaction rolled back, so nothing was recorded. A 5xx tells the sender to retry,
      // and that's safe because processing is idempotent.
      console.error('webhook processing failed', { eventId: parsed.data.id, err }); // log IDs only, never PHI
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Read-only endpoint for debugging and demos
  app.get('/patients/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
    if (!row) { res.sendStatus(404); return; }
    res.json(row);
  });

  return app;
}