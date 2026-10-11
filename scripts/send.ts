import { sign } from '../src/signature';

const [type = 'session.completed', id = crypto.randomUUID(), patient = 'pat_123'] = process.argv.slice(2);
const now = new Date().toISOString();
const body = JSON.stringify({ id, type, created_at: now, data: { patient_id: patient, session_id: 'ses_1', occurred_at: now } });
const ts = Math.floor(Date.now() / 1000).toString();

const res = await fetch('http://localhost:3000/webhooks/ehr', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-webhook-timestamp': ts,
    'x-webhook-signature': `sha256=${sign(process.env.WEBHOOK_SECRET ?? 'dev_secret', ts, body)}`,
  },
  body,
});
console.log(res.status, await res.json());