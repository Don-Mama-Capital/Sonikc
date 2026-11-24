import { claimJob, failJob, finishJob } from '../src/lib/server/jobs';
import { onJobGiveUp, PermanentError, runJob } from '../src/lib/server/processing';
import { housekeeping } from '../src/lib/server/housekeeping';

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
  let lastHousekeeping = 0;
  let lastSweep = 0;
  while (!stopping) {
    if (Date.now() - lastHousekeeping > 3600_000) {
      lastHousekeeping = Date.now();
      await housekeeping().then((r) => console.log('ménage', r), (e) => console.error('ménage en échec', e));
      // Fichiers des comptes supprimés dont l'effacement a échoué : nouvel essai.
      const { removePendingFiles } = await import('../src/lib/server/account');
      await removePendingFiles().then((n) => n && console.log('fichiers de comptes supprimés', n), (e) => console.error('effacement en échec', e));
      const { purgeTrialMarks } = await import('../src/lib/server/billing');
      await purgeTrialMarks().catch((e) => console.error('purge des empreintes d’essai en échec', e));
    }
    // Paiements : reprise de tout ce qui a échoué (remboursements, virements, reprises, livraisons).
    if (Date.now() - lastSweep > 10 * 60_000) {
      lastSweep = Date.now();
      const { paymentsEnabled } = await import('../src/lib/server/stripe');
      if (paymentsEnabled()) {
        const { sweepPayments } = await import('../src/lib/server/commerce');
        await sweepPayments().then((r) => console.log('paiements', r), (e) => console.error('balayage paiements en échec', e));
      }
    }
    const n = await drain((m) => console.log(m));
    if (n === 0) await new Promise((r) => setTimeout(r, 1000));
  }
  process.exit(0);
}
