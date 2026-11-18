import { inject } from 'vitest';
import path from 'node:path';

process.env.DATABASE_URL = inject('databaseUrl');
process.env.APP_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.APP_URL = 'http://localhost:3000';
process.env.STORAGE_DIR = path.join(inject('dataDir'), 'storage');
process.env.MAIL_DIR = path.join(inject('dataDir'), 'mail');
