const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, registerUser, uploadFile } = require('./helpers.js');

// Квота по умолчанию — 100 ГБ, столько в тест не загрузить. Урезаем её прямо в
// db.json: сервер читает файл на каждой транзакции, поэтому правка подхватится.
function setQuota(server, bytes) {
  const db = server.readDb();
  db.users[0].quota = bytes;
  server.writeDb(db);
}

test('загрузка сверх квоты отклоняется и не оставляет мусор на диске', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  setQuota(server, 100);

  const first = await uploadFile(client, { content: 'a'.repeat(60) });
  assert.equal(first.status, 200);

  const second = await uploadFile(client, { content: 'b'.repeat(60) });
  assert.equal(second.status, 413);
  assert.match(second.data.error, /квота/i);
  assert.equal(server.readDb().files.length, 1);
  assert.equal(server.blobCount(), 1, 'блоб отклонённой загрузки должен быть удалён');

  // ровно под лимит пройти можно
  const fits = await uploadFile(client, { content: 'c'.repeat(40) });
  assert.equal(fits.status, 200);
  assert.equal((await client.get('/api/auth/me')).data.used, 100);
});

test('файл в корзине продолжает занимать квоту, очистка её освобождает', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  setQuota(server, 100);

  const file = (await uploadFile(client, { content: 'a'.repeat(80) })).data;
  await client.patch(`/api/files/${file.id}`, { deleted: true });

  const me = await client.get('/api/auth/me');
  assert.equal(me.data.used, 80, 'корзина честно занимает место — файл никуда с диска не делся');
  assert.equal(me.data.trashed, 80);
  assert.equal(me.data.quota, 100);

  const blocked = await uploadFile(client, { content: 'b'.repeat(50) });
  assert.equal(blocked.status, 413, 'место, занятое корзиной, не должно быть доступно повторно');

  const empty = await client.post('/api/rubbish/empty', {});
  assert.equal(empty.data.freed, 80);
  const afterEmpty = await client.get('/api/auth/me');
  assert.equal(afterEmpty.data.used, 0);
  assert.equal(afterEmpty.data.trashed, 0);

  const now = await uploadFile(client, { content: 'b'.repeat(50) });
  assert.equal(now.status, 200);
});

test('квота считается по каждому пользователю отдельно', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const first = makeClient(server.url);
  await registerUser(first, 'first', 'secret123');
  const second = makeClient(server.url);
  await registerUser(second, 'second', 'secret123');

  const db = server.readDb();
  for (const user of db.users) user.quota = 100;
  server.writeDb(db);

  assert.equal((await uploadFile(first, { content: 'a'.repeat(90) })).status, 200);
  assert.equal((await uploadFile(second, { content: 'b'.repeat(90) })).status, 200);
  assert.equal((await first.get('/api/auth/me')).data.used, 90);
  assert.equal((await second.get('/api/auth/me')).data.used, 90);
});
