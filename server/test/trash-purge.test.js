const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, makeClient, registerUser, uploadFile } = require('./helpers.js');

const DAY = 24 * 60 * 60 * 1000;

// Ждать 30 дней в тесте нельзя — сдвигаем deletedAt в прошлое прямо в db.json.
function backdate(server, predicate, daysAgo) {
  const db = server.readDb();
  for (const rec of db.files.concat(db.folders)) {
    if (predicate(rec)) rec.deletedAt = Date.now() - daysAgo * DAY;
  }
  server.writeDb(db);
}

test('просроченные файлы из корзины удаляются, свежие остаются', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const old = (await uploadFile(client, { content: 'старый' })).data;
  const fresh = (await uploadFile(client, { content: 'свежий' })).data;
  const alive = (await uploadFile(client, { content: 'не удалялся' })).data;
  await client.patch(`/api/files/${old.id}`, { deleted: true });
  await client.patch(`/api/files/${fresh.id}`, { deleted: true });
  backdate(server, rec => rec.id === old.id, 40);

  const result = await server.purgeExpiredTrash();
  assert.deepEqual(result, { files: 1, folders: 0 });

  const db = server.readDb();
  assert.deepEqual(db.files.map(f => f.id).sort(), [fresh.id, alive.id].sort());
  assert.equal(fs.existsSync(server.blobPath(old.storedName)), false, 'блоб просроченного файла должен уйти с диска');
  assert.ok(fs.existsSync(server.blobPath(fresh.storedName)));
  assert.equal((await client.get('/api/auth/me')).data.trashed, fresh.size);
});

test('просроченная папка удаляется вместе со вложенным содержимым', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const folder = (await client.post('/api/folders', { name: 'давно удалена' })).data;
  const nested = (await client.post('/api/folders', { name: 'внутри', parentId: folder.id })).data;
  const inside = (await uploadFile(client, { folderId: nested.id })).data;
  await client.patch(`/api/folders/${folder.id}`, { deleted: true });
  backdate(server, rec => rec.id === folder.id, 31);

  const result = await server.purgeExpiredTrash();
  assert.equal(result.folders, 1);

  const db = server.readDb();
  assert.equal(db.folders.length, 0, 'вложенная папка тоже должна исчезнуть');
  assert.equal(db.files.length, 0);
  assert.equal(fs.existsSync(server.blobPath(inside.storedName)), false);
  assert.equal(server.blobCount(), 0);
});

test('записям без deletedAt отсчёт начинается с первого прохода', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  // так выглядят данные, удалённые версией без TTL: deleted есть, deletedAt нет
  const file = (await uploadFile(client)).data;
  await client.patch(`/api/files/${file.id}`, { deleted: true });
  const db = server.readDb();
  db.files.find(f => f.id === file.id).deletedAt = null;
  server.writeDb(db);

  const result = await server.purgeExpiredTrash();
  assert.deepEqual(result, { files: 0, folders: 0 }, 'старые записи не должны сноситься сразу же');
  const stamped = server.readDb().files.find(f => f.id === file.id);
  assert.ok(stamped.deletedAt > 0, 'штамп должен быть проставлен, чтобы срок начал идти');
});

test('TRASH_TTL_DAYS=0 отключает автоочистку', async (t) => {
  const server = await startServer({ trashTtlDays: 0 });
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const file = (await uploadFile(client)).data;
  await client.patch(`/api/files/${file.id}`, { deleted: true });
  backdate(server, rec => rec.id === file.id, 3650);

  const result = await server.purgeExpiredTrash();
  assert.deepEqual(result, { files: 0, folders: 0 });
  assert.equal(server.readDb().files.length, 1, 'с нулевым TTL корзина живёт вечно');
  assert.ok(fs.existsSync(server.blobPath(file.storedName)));
  assert.equal((await client.get('/api/rubbish')).data.trashTtlDays, 0);
});
