import { createApp } from './app';
import { openDb } from './db';

const db = openDb(process.env.DATABASE_PATH ?? './webhooks.db');
const secret = process.env.WEBHOOK_SECRET;
if (!secret) console.warn('WEBHOOK_SECRET not set: signature checks DISABLED (dev only)');

createApp({ db, secret }).listen(Number(process.env.PORT ?? 3000), () => console.log('listening'));