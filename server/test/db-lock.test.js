/**
 * Регрессия на потерю параллельных записей.
 *
 * Старый слой БД сериализовал только запись: два одновременных запроса читали
 * одну и ту же версию db.json, мутировали каждый свою копию, и вторая запись
 * затирала первую. На этом тесте старый код падает (создаётся 25 папок,
 * доживают единицы), на транзакционном withDb — проходит.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, registerUser, uploadFile } = require('./helpers.js');

test('25 одновременных созданий папок не теряются', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const count = 25;
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) => client.post('/api/folders', { name: `folder-${i}` }))
  );
  for (const res of results) assert.equal(res.status, 200);

  const list = await client.get('/api/folders');
  assert.equal(list.data.folders.length, count, 'все папки должны быть в ответе API');
  assert.equal(server.readDb().folders.length, count, 'все папки должны быть в самом db.json');
});

test('одновременные загрузки файлов не теряются и не бьют квоту', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const count = 12;
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) => uploadFile(client, { content: `payload-${i}` }))
  );
  for (const res of results) assert.equal(res.status, 200);

  const db = server.readDb();
  assert.equal(db.files.length, count);
  assert.equal(server.blobCount(), count, 'на каждый файл должен быть ровно один блоб');

  const me = await client.get('/api/auth/me');
  const expected = db.files.reduce((sum, f) => sum + f.size, 0);
  assert.equal(me.data.used, expected);
});

test('db.json остаётся валидным JSON после параллельных записей', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  await Promise.all([
    client.post('/api/folders', { name: 'a' }),
    client.post('/api/folders', { name: 'b' }),
    uploadFile(client, { content: 'x' }),
    uploadFile(client, { content: 'y' }),
    client.post('/api/folders', { name: 'c' }),
  ]);

  assert.doesNotThrow(() => server.readDb(), 'файл не должен оставаться обрезанным');
  const db = server.readDb();
  assert.equal(db.folders.length, 3);
  assert.equal(db.files.length, 2);
});
