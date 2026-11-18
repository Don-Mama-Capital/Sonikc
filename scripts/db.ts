import { startPostgres } from './pg';
import { migrate } from './migrate';

// `npm run db` : Postgres local persistant sur le port 54322, migrations appliquées.
const pg = await startPostgres({ dir: '.data/pg', port: 54322, persistent: true });
await migrate(pg.url);
console.log(`Postgres prêt : ${pg.url} (Ctrl+C pour arrêter)`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
