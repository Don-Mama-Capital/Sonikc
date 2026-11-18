import type { Tx } from './db';
import { asService } from './db';

export type JobKind = 'process_version' | 'unzip_import';

export async function enqueue(tx: Tx, kind: JobKind, payload: Record<string, unknown>) {
  await tx`insert into jobs (kind, payload) values (${kind}, ${tx.json(payload as never)})`;
}

export type Job = { id: number; kind: JobKind; payload: Record<string, string>; attempts: number; maxAttempts: number };

/** Réserve la prochaine tâche (SKIP LOCKED : plusieurs workers peuvent tourner en parallèle). */
export async function claimJob(): Promise<Job | null> {
  return asService(async (tx) => {
    // Une tâche bloquée depuis plus de 15 min (worker tombé) repart dans la file.
    await tx`update jobs set status = 'queued', locked_at = null
             where status = 'running' and locked_at < now() - interval '15 minutes'`;
    const [job] = await tx<Job[]>`
      update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
      where id = (select id from jobs where status = 'queued' and run_after <= now() order by id limit 1 for update skip locked)
      returning id, kind, payload, attempts, max_attempts as "maxAttempts"`;
    return job ?? null;
  });
}

export async function finishJob(id: number) {
  await asService((tx) => tx`update jobs set status = 'done', finished_at = now(), last_error = null where id = ${id}`);
}

/** Échec : nouvel essai plus tard (30 s, 2 min, …) ou abandon définitif. Rend true si abandonné. */
export async function failJob(job: Job, error: string, permanent = false): Promise<boolean> {
  const giveUp = permanent || job.attempts >= job.maxAttempts;
  await asService((tx) => tx`
    update jobs set
      status = ${giveUp ? 'failed' : 'queued'},
      last_error = ${error.slice(0, 2000)},
      run_after = now() + ${`${30 * 4 ** (job.attempts - 1)} seconds`}::interval,
      finished_at = ${giveUp ? new Date() : null},
      locked_at = null
    where id = ${job.id}`);
  return giveUp;
}
