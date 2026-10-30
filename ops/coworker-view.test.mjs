import test from 'node:test';
import assert from 'node:assert/strict';
import {renderView} from './coworker-view.mjs';

const NOW = Date.parse('2026-10-30T12:00:30.000Z');
const COWORKER = Object.freeze({id: '01a189e8-8258-707e-97c5-c06718385eb7', organizationSlug: null});

const service = (name, healthy = true, restarts = 0) => ({name, healthy, restarts, mode: 'adopted', pid: null});
const HEALTHY = Object.freeze({
  updatedAt: '2026-10-30T12:00:20.000Z',
  services: ['coworker-agent', 'coworker-worker', 'sokosumi-login', 'payment-service', 'specialists'].map((name) => service(name)),
});

const render = (overrides = {}) => renderView({now: NOW, coworker: COWORKER, status: HEALTHY, tasks: {items: []}, ...overrides});

test('it names the Coworker and where it takes tasks from', () => {
  const view = render();

  assert.match(view, /01a189e8-8258-707e-97c5-c06718385eb7/);
  assert.match(view, /personal/);
});

test('a connected Workspace is named', () => {
  assert.match(render({coworker: {...COWORKER, organizationSlug: 'tum-hackathon-u4ve65'}}), /tum-hackathon-u4ve65/);
});

test('every part the Coworker depends on gets a line', () => {
  const view = render();

  for (const label of ['Agent', 'Worker', 'Login', 'Payment Service', 'Specialists']) {
    assert.match(view, new RegExp(`${label}\\s+healthy`));
  }
});

test('something unhealthy stands out', () => {
  const services = HEALTHY.services.map((item) => (item.name === 'coworker-worker' ? {...item, healthy: false} : item));

  assert.match(render({status: {...HEALTHY, services}}), /Worker\s+NOT HEALTHY/);
});

test('restarts are shown only once there are some', () => {
  const services = HEALTHY.services.map((item) => (item.name === 'specialists' ? {...item, restarts: 2} : item));

  const view = render({status: {...HEALTHY, services}});

  assert.match(view, /Specialists\s+healthy, 2 restarts/);
  assert.doesNotMatch(view, /Agent\s+healthy,/);
});

test('without a supervisor it says so instead of showing old news', () => {
  assert.match(render({status: null}), /supervisor is not running/);
});

test('a status that has stopped changing is called out', () => {
  assert.match(render({status: {...HEALTHY, updatedAt: '2026-10-30T11:50:00.000Z'}}), /looks stuck/);
});

test('tasks are counted, with the unfinished ones called active', () => {
  const items = [
    {id: '01a189ec-044e-70af-b07e-4b28e6042fe8', status: 'COMPLETED', description: 'Suggest names.'},
    {id: '01a18d00-044e-70af-b07e-4b28e6042fe8', status: 'IN_PROGRESS', description: 'Clean my table.'},
    {id: '01a18d01-044e-70af-b07e-4b28e6042fe8', status: 'READY', description: 'Another one.'},
  ];

  const view = render({tasks: {items}});

  assert.match(view, /3 total, 2 active/);
  assert.match(view, /IN_PROGRESS\s+01a18d00\s+Clean my table\./);
});

test('no tasks is a plain statement', () => {
  assert.match(render(), /Tasks\s+none yet/);
});

test('only the newest tasks are listed, and long text is cut', () => {
  const items = Array.from({length: 9}, (_, index) => ({id: `0000000${index}-aaaa`, status: 'COMPLETED', description: 'x'.repeat(200)}));

  const view = render({tasks: {items}});

  assert.match(view, /9 total/);
  assert.equal(view.split('\n').filter((line) => line.includes('COMPLETED')).length, 5);
  assert.ok(view.split('\n').every((line) => line.length <= 90));
});

test('a task with no description still gets a line', () => {
  assert.match(render({tasks: {items: [{id: 'abcdefgh-1', status: 'READY'}]}}), /READY\s+abcdefgh/);
});

test('when tasks cannot be read it says so and keeps the last ones', () => {
  const view = render({tasks: {items: [{id: 'abcdefgh-1', status: 'READY', description: 'Kept'}], error: 'Command failed'}});

  assert.match(view, /could not be read/);
  assert.match(view, /Command failed/);
  assert.match(view, /Kept/);
});

test('it shows the time, so a frozen panel can be spotted', () => {
  assert.match(render(), /\d\d:\d\d:\d\d/);
});
