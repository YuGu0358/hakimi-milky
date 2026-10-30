import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {PaymentsError} from '../shared/errors.mjs';
import {createMps} from './mps.mjs';
import {serveFake} from './mps-http.mjs';

test('a success returns the data and sends the key in the token header', async (t) => {
  const {baseUrl, tokens} = await serveFake(t, async () => ({id: 'p-1'}));
  const mps = createMps({baseUrl, token: 'test-token'});

  const data = await mps('/payment', {network: 'Preprod'});

  assert.deepEqual(data, {id: 'p-1'});
  assert.deepEqual(tokens, ['test-token']);
});

test('with a body it posts, without one it gets', async (t) => {
  const seen = [];
  const {baseUrl} = await serveFake(t, async (path, body) => {
    seen.push({path, body});
    return {};
  });
  const mps = createMps({baseUrl, token: 'test-token'});

  await mps('/payment', {a: 1});
  await mps('/registry?limit=100');

  assert.deepEqual(seen, [
    {path: '/payment', body: {a: 1}},
    {path: '/registry?limit=100', body: undefined},
  ]);
});

for (const [status, kind] of [
  [400, 'rejected'],
  [401, 'rejected'],
  [403, 'rejected'],
  [404, 'not-found'],
  [409, 'conflict'],
  [500, 'uncertain'],
]) {
  test(`HTTP ${status} throws with kind ${kind} and the service's message`, async (t) => {
    const {baseUrl} = await serveFake(t, async () => {
      throw new PaymentsError('Pay by time must be in the future', {status});
    });
    const mps = createMps({baseUrl, token: 'test-token'});

    await assert.rejects(mps('/payment', {}), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.kind, kind);
      assert.match(error.message, /Pay by time must be in the future/);
      return true;
    });
  });
}

test('a connection that fails has no status and counts as uncertain', async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const {port} = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const mps = createMps({baseUrl: `http://127.0.0.1:${port}`, token: 'test-token'});

  await assert.rejects(mps('/payment', {}), (error) => {
    assert.equal(error.status, null);
    assert.equal(error.kind, 'uncertain');
    return true;
  });
});

test('a redirect is refused, so the key never reaches another address', async (t) => {
  const elsewhere = await serveFake(t, async () => ({}));
  const server = createServer((_req, res) => {
    res.writeHead(302, {location: `${elsewhere.baseUrl}/api/v1/payment`});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const mps = createMps({baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-token'});

  await assert.rejects(mps('/payment', {}), (error) => error.kind === 'uncertain');

  assert.deepEqual(elsewhere.tokens, []);
});

test('an answer that is not JSON is an error, not a crash', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(502);
    res.end('<html>Bad gateway</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const mps = createMps({baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-token'});

  await assert.rejects(mps('/payment', {}), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.kind, 'uncertain');
    return true;
  });
});

test('a 200 that does not say success is refused', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({status: 'pending'}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const mps = createMps({baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-token'});

  await assert.rejects(mps('/payment', {}), /no message/);
});

test('missing settings fail at once', () => {
  assert.throws(() => createMps({baseUrl: undefined, token: 'test-token'}), /MPS_URL/);
  assert.throws(() => createMps({baseUrl: 'http://127.0.0.1:1', token: ''}), /key is missing/);
});
