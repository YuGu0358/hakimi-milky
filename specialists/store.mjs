import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const JOB_FILE = /^[0-9a-f-]{36}\.json$/;

// One JSON file per job. A job is written before any payment write that depends on it,
// so a crash leaves a record of what may have happened.
export function createJobStore(directory) {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const pathOf = (id) => join(directory, `${id}.json`);
  const load = (id) => JSON.parse(readFileSync(pathOf(id), 'utf8'));
  return {
    has: (id) => existsSync(pathOf(id)),
    load,
    // Write then rename, so a crash never leaves half a job.
    save(job) {
      const temporary = `${pathOf(job.id)}.tmp`;
      writeFileSync(temporary, JSON.stringify(job), {mode: 0o600});
      renameSync(temporary, pathOf(job.id));
      return job;
    },
    list: () =>
      readdirSync(directory)
        .filter((name) => JOB_FILE.test(name))
        .map((name) => load(name.slice(0, -'.json'.length))),
  };
}
