import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupervisor} from './supervisor.mjs';

const OPTIONS = Object.freeze({graceMs: 90_000, maxFailures: 3, minBackoffMs: 5_000, maxBackoffMs: 60_000, stableMs: 300_000});
const CHECK_MS = 15_000;

function world({services = [{name: 'api', command: 'run api'}], health = {}, options = OPTIONS} = {}) {
  let now = 1_000_000;
  const spawned = [];
  const notes = [];
  const healthy = {...health};
  const checks = [];
  const spawnService = (service) => {
    const handlers = [];
    const child = {
      pid: 100 + spawned.length,
      service: service.name,
      killed: false,
      kill() {
        child.killed = true;
      },
      onExit: (handler) => handlers.push(handler),
      exit: (code = 1) => handlers.forEach((handler) => handler(code)),
    };
    spawned.push(child);
    return child;
  };
  const isHealthy = async (service) => {
    checks.push(service.name);
    if (healthy[service.name] instanceof Error) throw healthy[service.name];
    return healthy[service.name] ?? false;
  };
  const supervisor = createSupervisor({services, spawnService, isHealthy, clock: () => now, log: () => {}, notify: (note) => notes.push(note), options});
  return {
    supervisor,
    spawned,
    notes,
    healthy,
    checks,
    advance: (ms) => {
      now += ms;
    },
    statusOf: (name = 'api') => supervisor.status().find((item) => item.name === name),
  };
}

async function ticks(kit, count) {
  for (let index = 0; index < count; index += 1) {
    kit.advance(CHECK_MS);
    await kit.supervisor.tick();
  }
}

test('a service that is already running is left alone', async () => {
  const kit = world({health: {api: true}});

  await kit.supervisor.tick();

  assert.equal(kit.spawned.length, 0);
  assert.equal(kit.statusOf().mode, 'adopted');
  assert.equal(kit.statusOf().healthy, true);
});

test('a service that is down at the start is started at once', async () => {
  const kit = world();

  await kit.supervisor.tick();

  assert.equal(kit.spawned.length, 1);
  assert.equal(kit.statusOf().mode, 'starting');
  assert.equal(kit.statusOf().pid, 100);
});

test('a service that dies is started again after a wait, and the wait grows', async () => {
  const kit = world();
  await kit.supervisor.tick();

  kit.spawned[0].exit();
  await kit.supervisor.tick();
  const rightAfter = kit.spawned.length;
  kit.advance(5_000);
  await kit.supervisor.tick();
  const afterFirstWait = kit.spawned.length;
  kit.spawned[1].exit();
  kit.advance(5_000);
  await kit.supervisor.tick();
  const tooEarly = kit.spawned.length;
  kit.advance(5_000);
  await kit.supervisor.tick();

  assert.equal(rightAfter, 1);
  assert.equal(afterFirstWait, 2);
  assert.equal(tooEarly, 2);
  assert.equal(kit.spawned.length, 3);
  assert.equal(kit.statusOf().restarts, 2);
});

test('the wait never grows past its limit', async () => {
  const kit = world();
  await kit.supervisor.tick();
  for (let round = 0; round < 8; round += 1) {
    kit.spawned.at(-1).exit();
    kit.advance(60_000);
    await kit.supervisor.tick();
  }

  assert.equal(kit.spawned.length, 9);
});

test('the wait goes back to the shortest once the service has been stable', async () => {
  const kit = world();
  await kit.supervisor.tick();
  kit.spawned[0].exit();
  kit.advance(5_000);
  await kit.supervisor.tick();
  kit.spawned[1].exit();
  kit.advance(10_000);
  await kit.supervisor.tick();
  kit.healthy.api = true;
  await ticks(kit, 21);

  kit.spawned[2].exit();
  kit.healthy.api = false;
  kit.advance(5_000);
  await kit.supervisor.tick();

  assert.equal(kit.spawned.length, 4);
});

test('a service it took over is started only after several failed checks', async () => {
  const kit = world({health: {api: true}});
  await kit.supervisor.tick();
  kit.healthy.api = false;

  await ticks(kit, 2);
  const afterTwo = kit.spawned.length;
  await ticks(kit, 1);

  assert.equal(afterTwo, 0);
  assert.equal(kit.spawned.length, 1);
  assert.match(kit.notes.join('\n'), /api/);
});

test('its own child gets time to boot before it counts as failing', async () => {
  const kit = world();
  await kit.supervisor.tick();

  await ticks(kit, 5);

  assert.equal(kit.spawned[0].killed, false);
  assert.equal(kit.spawned.length, 1);
});

test('a child that boots and then hangs is killed and started again', async () => {
  const kit = world();
  await kit.supervisor.tick();
  kit.healthy.api = true;
  await ticks(kit, 7);
  kit.healthy.api = false;

  await ticks(kit, 3);
  const killed = kit.spawned[0].killed;
  kit.spawned[0].exit();
  await ticks(kit, 1);

  assert.equal(killed, true);
  assert.equal(kit.spawned.length, 2);
});

test('a child that never comes up is killed after its boot time', async () => {
  const kit = world();
  await kit.supervisor.tick();

  await ticks(kit, 9);

  assert.equal(kit.spawned[0].killed, true);
});

test('a service can have its own boot time', async () => {
  const kit = world({services: [{name: 'api', command: 'run api', graceMs: 300_000}]});
  await kit.supervisor.tick();

  await ticks(kit, 15);

  assert.equal(kit.spawned[0].killed, false);
});

test('a failed health check that throws counts as unhealthy', async () => {
  const kit = world({health: {api: new Error('refused')}});

  await kit.supervisor.tick();

  assert.equal(kit.spawned.length, 1);
});

test('going down and coming back are each announced once', async () => {
  const kit = world({health: {api: true}});
  await kit.supervisor.tick();
  kit.healthy.api = false;
  await ticks(kit, 6);
  const whileDown = kit.notes.length;
  kit.healthy.api = true;
  await ticks(kit, 2);

  assert.equal(whileDown, 1);
  assert.equal(kit.notes.length, 2);
  assert.match(kit.notes[1], /back/);
});

test('a service that starts up for the first time is not announced as coming back', async () => {
  const kit = world();
  await kit.supervisor.tick();
  kit.healthy.api = true;
  await ticks(kit, 1);

  assert.deepEqual(kit.notes, []);
});

test('stop kills its own children, leaves the others and restarts nothing', async () => {
  const kit = world({services: [{name: 'own', command: 'a'}, {name: 'other', command: 'b'}], health: {other: true}});
  await kit.supervisor.tick();

  kit.supervisor.stop();
  kit.spawned[0].exit();
  await ticks(kit, 5);

  assert.equal(kit.spawned.length, 1);
  assert.equal(kit.spawned[0].killed, true);
});

const WATCH = Object.freeze({name: 'login', checkEveryMs: 60_000});

test('a watch never starts anything and warns once while it fails', async () => {
  const kit = world({services: [WATCH]});

  await kit.supervisor.tick();
  await ticks(kit, 8);

  assert.equal(kit.spawned.length, 0);
  assert.equal(kit.notes.length, 1);
  assert.match(kit.notes[0], /login/);
  assert.equal(kit.statusOf('login').healthy, false);
});

test('a watch says when it recovers', async () => {
  const kit = world({services: [WATCH]});
  await kit.supervisor.tick();
  kit.healthy.login = true;

  await ticks(kit, 4);

  assert.equal(kit.notes.length, 2);
  assert.equal(kit.statusOf('login').healthy, true);
});

test('a watch is checked only as often as it asks', async () => {
  const kit = world({services: [WATCH], health: {login: true}});

  await kit.supervisor.tick();
  await ticks(kit, 3);
  const beforeTheMinute = kit.checks.length;
  await ticks(kit, 1);

  assert.equal(beforeTheMinute, 1);
  assert.equal(kit.checks.length, 2);
});

test('two ticks at once start a service once', async () => {
  const kit = world();

  await Promise.all([kit.supervisor.tick(), kit.supervisor.tick()]);

  assert.equal(kit.spawned.length, 1);
});
