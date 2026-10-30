import {createServer} from 'node:http';

// Serves a fake Payment Service over HTTP in the real one's envelope, for tests of the real client.
export async function serveFake(t, request) {
  const tokens = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const text = Buffer.concat(parts).toString('utf8');
    tokens.push(req.headers.token);
    const answer = (status, data) => {
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify(data));
    };
    try {
      const data = await request(req.url.replace('/api/v1', ''), text ? JSON.parse(text) : undefined);
      answer(200, {status: 'success', data});
    } catch (error) {
      answer(error.status ?? 500, {status: 'error', error: {message: error.message}});
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {baseUrl: `http://127.0.0.1:${server.address().port}`, tokens};
}
