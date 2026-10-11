import { z } from 'zod';

export const EVENT_TYPES = ['session.completed', 'session.no_show', 'patient.discharged'] as const;

// The minimum every event must have, even types we don't handle.
export const Envelope = z.object({
  id: z.string().min(1),          // unique per event, used as the idempotency key
  type: z.string().min(1),
  created_at: z.string().datetime(),
});

const sessionData = z.object({
  patient_id: z.string().min(1),
  session_id: z.string().min(1),
  occurred_at: z.string().datetime(),
});

export const WebhookEvent = z.discriminatedUnion('type', [
  Envelope.extend({ type: z.literal('session.completed'), data: sessionData }),
  Envelope.extend({ type: z.literal('session.no_show'), data: sessionData }),
  Envelope.extend({
    type: z.literal('patient.discharged'),
    data: z.object({ patient_id: z.string().min(1), occurred_at: z.string().datetime() }),
  }),
]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;