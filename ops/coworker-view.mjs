// What the terminal panel shows about the Coworker. Pure text, so it can be tested without a terminal.

export const STALE_AFTER_MS = 60_000;

const LABEL_WIDTH = 16;
const MAX_TASKS_SHOWN = 5;
const MAX_TEXT = 60;
const FINISHED_TASKS = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'CANCELED']);
const PARTS = Object.freeze([
  ['coworker-agent', 'Agent'],
  ['coworker-worker', 'Worker'],
  ['coworker-api', 'Seller API'],
  ['sokosumi-login', 'Login'],
  ['payment-service', 'Payment Service'],
  ['specialists', 'Specialists'],
]);

const line = (label, text) => `${label.padEnd(LABEL_WIDTH)}${text}`;
const cut = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

function describePart({healthy, restarts}) {
  const state = healthy ? 'healthy' : 'NOT HEALTHY';
  if (restarts === 0) return state;
  return `${state}, ${restarts} ${restarts === 1 ? 'restart' : 'restarts'}`;
}

function serviceLines(status, now) {
  if (!status) return ['The supervisor is not running. Start it with: npm run online'];
  const stale = now - Date.parse(status.updatedAt) > STALE_AFTER_MS ? [`The supervisor looks stuck: last update ${status.updatedAt}`] : [];
  const parts = PARTS.flatMap(([name, label]) => {
    const part = status.services.find((item) => item.name === name);
    return part ? [line(label, describePart(part))] : [];
  });
  return [...stale, ...parts];
}

const newestFirst = (items) => [...items].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

function taskLines({items, error}) {
  const warning = error ? [`Tasks could not be read: ${cut(error)}`] : [];
  if (items.length === 0) return [...warning, line('Tasks', 'none yet')];
  const active = items.filter(({status}) => !FINISHED_TASKS.has(status)).length;
  const rows = newestFirst(items)
    .slice(0, MAX_TASKS_SHOWN)
    .map(({id, status, description}) => `  ${String(status).padEnd(12)} ${String(id).slice(0, 8)}  ${cut(description ?? '')}`);
  return [...warning, line('Tasks', `${items.length} total, ${active} active`), ...rows];
}

export function renderView({now, coworker, status, tasks}) {
  return [
    `Hakimi Milky Coworker  ${clock(now)}`,
    '',
    line('Coworker', coworker.id ?? 'COWORKER_ID is not set'),
    line('Workspace', coworker.organizationSlug ?? 'personal'),
    '',
    ...serviceLines(status, now),
    '',
    ...taskLines(tasks),
  ].join('\n');
}
