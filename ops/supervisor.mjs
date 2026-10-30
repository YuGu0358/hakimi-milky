// Keeps services up. It starts what is down and leaves alone what already answers, so it can
// take over services started by hand. A service with no command is only watched: a person has
// to fix it, such as an expired login. Everything it needs comes in, so tests can drive the clock.

const DEFAULT_OPTIONS = Object.freeze({
  graceMs: 90_000,
  maxFailures: 3,
  minBackoffMs: 5_000,
  maxBackoffMs: 60_000,
  stableMs: 300_000,
});

export function createSupervisor({services, spawnService, isHealthy, clock = Date.now, log = console.log, notify = () => {}, options = {}}) {
  const settings = {...DEFAULT_OPTIONS, ...options};
  const states = new Map(
    services.map(({name}) => [
      name,
      {
        name,
        mode: 'unknown',
        healthy: false,
        child: null,
        restarts: 0,
        failures: 0,
        startedAt: null,
        nextStartAt: 0,
        nextCheckAt: 0,
        backoffMs: settings.minBackoffMs,
        hasRun: false,
        hasExited: false,
        isAnnouncedDown: false,
        lastHealthyAt: null,
      },
    ]),
  );
  let isStopped = false;
  let isRunning = false;

  const update = (name, change) => states.set(name, {...states.get(name), ...change});

  function announceDown(name, message) {
    if (states.get(name).isAnnouncedDown) return;
    update(name, {isAnnouncedDown: true});
    notify(message);
  }

  function handleExit(name, child, code) {
    const state = states.get(name);
    if (state.child !== child) return;
    log(`${name} exited with code ${code}`);
    update(name, {
      child: null,
      healthy: false,
      mode: 'down',
      hasExited: true,
      failures: 0,
      nextStartAt: clock() + state.backoffMs,
      backoffMs: Math.min(state.backoffMs * 2, settings.maxBackoffMs),
    });
    if (!isStopped) announceDown(name, `${name} stopped, restarting it`);
  }

  function start(service) {
    const {name} = service;
    const state = states.get(name);
    log(`Starting ${name}`);
    const child = spawnService(service);
    update(name, {
      child,
      mode: 'starting',
      startedAt: clock(),
      failures: 0,
      hasExited: false,
      hasRun: true,
      restarts: state.hasRun ? state.restarts + 1 : state.restarts,
    });
    child.onExit((code) => handleExit(name, child, code));
  }

  function onHealthy({name}) {
    const state = states.get(name);
    const isStable = state.startedAt === null || clock() - state.startedAt >= settings.stableMs;
    if (state.isAnnouncedDown) notify(`${name} is back`);
    update(name, {
      healthy: true,
      failures: 0,
      hasRun: true,
      isAnnouncedDown: false,
      lastHealthyAt: clock(),
      mode: state.child ? 'running' : 'adopted',
      backoffMs: isStable ? settings.minBackoffMs : state.backoffMs,
    });
  }

  function onChildUnhealthy(service, state) {
    const {name} = service;
    const graceMs = service.graceMs ?? settings.graceMs;
    if (clock() - state.startedAt < graceMs) {
      update(name, {healthy: false});
      return;
    }
    const failures = state.failures + 1;
    if (failures < settings.maxFailures) {
      update(name, {healthy: false, failures});
      return;
    }
    log(`${name} is not answering, killing it`);
    announceDown(name, `${name} stopped answering, restarting it`);
    state.child.kill();
    update(name, {healthy: false, failures: 0});
  }

  function onUnhealthy(service) {
    const {name} = service;
    const state = states.get(name);
    if (state.child) {
      onChildUnhealthy(service, state);
      return;
    }
    const failures = state.failures + 1;
    const isOnlyMaybeDown = state.lastHealthyAt !== null && !state.hasExited && failures < settings.maxFailures;
    if (isOnlyMaybeDown) {
      update(name, {healthy: false, failures});
      return;
    }
    if (state.lastHealthyAt !== null) announceDown(name, `${name} is down, restarting it`);
    update(name, {healthy: false, failures, mode: 'down'});
    if (clock() >= state.nextStartAt) start(service);
  }

  function onWatch({name}, healthy) {
    if (healthy && states.get(name).isAnnouncedDown) notify(`${name} is back`);
    if (!healthy) announceDown(name, `${name} check is failing, it needs a person`);
    update(name, {
      healthy,
      mode: 'watch',
      isAnnouncedDown: healthy ? false : states.get(name).isAnnouncedDown,
      lastHealthyAt: healthy ? clock() : states.get(name).lastHealthyAt,
    });
  }

  async function safelyHealthy(service) {
    try {
      return await isHealthy(service);
    } catch (error) {
      log(`Health check of ${service.name} failed: ${error.message}`);
      return false;
    }
  }

  async function check(service) {
    const {name, command, checkEveryMs} = service;
    if (clock() < states.get(name).nextCheckAt) return;
    const healthy = await safelyHealthy(service);
    if (isStopped) return;
    if (checkEveryMs) update(name, {nextCheckAt: clock() + checkEveryMs});
    if (!command) onWatch(service, healthy);
    else if (healthy) onHealthy(service);
    else onUnhealthy(service);
  }

  return {
    async tick() {
      if (isRunning || isStopped) return;
      isRunning = true;
      try {
        for (const service of services) await check(service);
      } finally {
        isRunning = false;
      }
    },

    // Only what it started itself: a service someone runs by hand stays up.
    stop() {
      isStopped = true;
      for (const {child} of states.values()) child?.kill();
    },

    status: () =>
      services.map(({name}) => {
        const {mode, healthy, restarts, child, lastHealthyAt} = states.get(name);
        return {name, mode, healthy, restarts, pid: child?.pid ?? null, lastHealthyAt};
      }),
  };
}
