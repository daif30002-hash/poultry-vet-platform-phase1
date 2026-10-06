/* eslint-disable no-console */
import { join } from 'node:path';
import { migrate } from './migrator.ts';

// Run from the backend directory: npm run migrate
const url = process.env['MIGRATION_DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('MIGRATION_DATABASE_URL is required');
  process.exit(1);
}

migrate(url, join(process.cwd(), 'migrations'), (message) => console.log(message))
  .then((count) => {
    console.log(count === 0 ? 'database is up to date' : `applied ${count} migration(s)`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
