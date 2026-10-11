import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(secret: string, timestamp: string, body: string | Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

export function verifySignature(opts: {
  secret: string;
  rawBody: Buffer;
  timestamp?: string;
  signature?: string;
  toleranceSec?: number;
  nowMs?: number;
}): boolean {
  const { secret, rawBody, timestamp, signature, toleranceSec = 300, nowMs = Date.now() } = opts;
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false; // block replays

  const expected = Buffer.from(sign(secret, timestamp, rawBody), 'hex');
  const given = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}