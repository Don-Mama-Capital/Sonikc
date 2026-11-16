import { claimJob, failJob, finishJob } from '../src/lib/server/jobs';
import { onJobGiveUp, PermanentError, runJob } from '../src/lib/server/processing';

/** Traite les tâches en attente jusqu'à ce que la file soit vide. Rend le nombre de tâches traitées. */
export async function drain(log: (m: string) => void = () => {}) {
  let n = 0;
  for (;;) {
    const job = await claimJob();
    if (!job) return n;
    n++;
    try {
      await runJob(job);
      await finishJob(job.id);
      log(`ok  #${job.id} ${job.kind}`);
    } catch (e) {
      const permanent = e instanceof PermanentError;
      const msg = permanent ? (e as Error).message : 'Le traitement a échoué. Réessaie, ou envoie un autre fichier.';
      const gaveUp = await failJob(job, `${(e as Error).message}`, permanent);
      if (gaveUp) await onJobGiveUp(job, msg);
      log(`err #${job.id} ${job.kind}: ${(e as Error).message}${gaveUp ? ' (abandon)' : ' (nouvel essai plus tard)'}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config } = await import('./env');
  config();
  console.log('worker démarré');
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  while (!stopping) {
    const n = await drain((m) => console.log(m));
    if (n === 0) await new Promise((r) => setTimeout(r, 1000));
  }
  process.exit(0);
}
