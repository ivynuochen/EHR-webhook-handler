import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { openDb, type DB } from '../src/db';
import { sign } from '../src/signature';

const SECRET = 'test_secret';
let db: DB;
let app: ReturnType<typeof createApp>;

beforeEach(() => { db = openDb(':memory:'); app = createApp({ db, secret: SECRET }); });

function event(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return { id: 'evt_1', type: 'session.completed', created_at: now,
    data: { patient_id: 'pat_1', session_id: 'ses_1', occurred_at: now }, ...overrides };
}

function post(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  return request(app).post('/webhooks/ehr')
    .set('content-type', 'application/json')
    .set('x-webhook-timestamp', ts)
    .set('x-webhook-signature', `sha256=${sign(secret, ts, raw)}`)
    .send(raw);
}

const patient = (id = 'pat_1') => db.prepare('SELECT * FROM patients WHERE id = ?').get(id) as any;

describe('webhooks', () => {
  it('increments session count', async () => {
    await post(event()).expect(200, { status: 'processed' });
    expect(patient().session_count).toBe(1);
  });

  it('ignores a duplicate delivery', async () => {
    await post(event()).expect(200);
    await post(event()).expect(200, { status: 'duplicate' });
    expect(patient().session_count).toBe(1);
  });

  it('handles concurrent duplicates', async () => {
    await Promise.all([post(event()), post(event()), post(event())]);
    expect(patient().session_count).toBe(1);
  });

  it('flags no-shows and discharges patients', async () => {
    await post(event({ id: 'e1', type: 'session.no_show' })).expect(200);
    await post(event({ id: 'e2', type: 'patient.discharged' })).expect(200);
    expect(patient()).toMatchObject({ needs_outreach: 1, status: 'inactive' });
  });

  it('rejects a bad signature', async () => {
    await post(event(), 'wrong_secret').expect(401);
  });

  it('accepts and ignores unknown types', async () => {
    await post(event({ type: 'appointment.created' })).expect(200, { status: 'ignored' });
  });

  it('rejects a malformed known event', async () => {
    await post(event({ data: {} })).expect(400);
  });

  it('rolls back on failure so a retry can succeed', async () => {
    db.exec('DROP TABLE patients');          // simulate a DB failure mid-transaction
    await post(event()).expect(500);
    const seen = db.prepare('SELECT COUNT(*) AS n FROM processed_events').get() as any;
    expect(seen.n).toBe(0);                  // not marked processed, so a retry will reprocess it
  });
});