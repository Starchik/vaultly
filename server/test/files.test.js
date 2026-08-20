const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer, makeClient, registerUser, uploadFile } = require('./helpers.js');

test('загрузка, скачивание и листинг', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const up = await uploadFile(client, { content: 'зашифрованные байты' });
  assert.equal(up.status, 200);
  const file = up.data;
  assert.ok(file.id);
  assert.ok(file.storedName);
  assert.equal(file.folderId, null);
  assert.equal(file.deleted, false);
  assert.equal(file.deletedAt, null);
  assert.equal(file.attrsEncrypted, 'attrs-encrypted', 'зашифрованные атрибуты должны сохраняться как есть');
  assert.ok(fs.existsSync(server.blobPath(file.storedName)), 'блоб должен лечь в storage/');

  const list = await client.get('/api/folders');
  assert.equal(list.data.files.length, 1);
  assert.equal(list.data.files[0].id, file.id);
  assert.deepEqual(list.data.breadcrumb, []);

  const dl = await client.get(`/api/files/${file.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.data.toString(), 'зашифрованные байты', 'сервер должен отдавать байты байт в байт');

  const other = makeClient(server.url);
  await registerUser(other, 'stranger', 'secret123');
  const foreign = await other.get(`/api/files/${file.id}/download`);
  assert.equal(foreign.status, 404, 'чужой файл не должен быть виден');
});

test('перенос файла между папками', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const folder = (await client.post('/api/folders', { name: 'Документы' })).data;
  const file = (await uploadFile(client)).data;

  const moved = await client.patch(`/api/files/${file.id}`, { folderId: folder.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.folderId, folder.id);

  const root = await client.get('/api/folders');
  assert.equal(root.data.files.length, 0, 'из корня файл должен уйти');
  const inside = await client.get(`/api/folders?parentId=${folder.id}`);
  assert.equal(inside.data.files.length, 1);
  assert.deepEqual(inside.data.breadcrumb, [{ id: folder.id, name: 'Документы' }]);

  const back = await client.patch(`/api/files/${file.id}`, { folderId: null });
  assert.equal(back.data.folderId, null);

  const nowhere = await client.patch(`/api/files/${file.id}`, { folderId: 'no-such-folder' });
  assert.equal(nowhere.status, 404);
});

test('корзина: удаление, восстановление, срок отсчёта', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const file = (await uploadFile(client, { content: 'в корзину' })).data;
  const trashed = await client.patch(`/api/files/${file.id}`, { deleted: true });
  assert.equal(trashed.status, 200);
  assert.equal(trashed.data.deleted, true);
  assert.ok(trashed.data.deletedAt > 0, 'deletedAt нужен для автоочистки по TTL');

  assert.equal((await client.get('/api/folders')).data.files.length, 0);
  const rubbish = await client.get('/api/rubbish');
  assert.equal(rubbish.data.files.length, 1);
  assert.equal(rubbish.data.size, file.size);
  assert.equal(rubbish.data.trashTtlDays, 30);
  assert.ok(fs.existsSync(server.blobPath(file.storedName)), 'мягкое удаление блоб не трогает');

  const restored = await client.patch(`/api/files/${file.id}`, { deleted: false });
  assert.equal(restored.data.deleted, false);
  assert.equal(restored.data.deletedAt, null);
  assert.equal((await client.get('/api/folders')).data.files.length, 1);
  assert.equal((await client.get('/api/rubbish')).data.files.length, 0);
});

test('жёсткое удаление файла уносит блоб с диска', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const file = (await uploadFile(client)).data;
  const share = await client.post(`/api/files/${file.id}/share`, {});
  assert.equal(share.status, 200);

  const del = await client.del(`/api/files/${file.id}`);
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(server.blobPath(file.storedName)), false);

  const db = server.readDb();
  assert.equal(db.files.length, 0);
  assert.equal(db.shares.length, 0, 'ссылка на удалённый файл не должна оставаться');

  assert.equal((await client.del(`/api/files/${file.id}`)).status, 404);
});

test('удаление папки уносит всё поддерево, не оставляя сирот', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const outer = (await client.post('/api/folders', { name: 'внешняя' })).data;
  const inner = (await client.post('/api/folders', { name: 'вложенная', parentId: outer.id })).data;
  const deep = (await client.post('/api/folders', { name: 'глубокая', parentId: inner.id })).data;
  const fileOuter = (await uploadFile(client, { folderId: outer.id })).data;
  const fileDeep = (await uploadFile(client, { folderId: deep.id })).data;
  const untouched = (await uploadFile(client)).data;
  assert.equal(server.blobCount(), 3);

  const del = await client.del(`/api/folders/${outer.id}`);
  assert.equal(del.status, 200);

  const db = server.readDb();
  assert.deepEqual(db.folders.map(f => f.id), [], 'вложенные папки тоже должны исчезнуть');
  assert.deepEqual(db.files.map(f => f.id), [untouched.id]);
  assert.equal(fs.existsSync(server.blobPath(fileOuter.storedName)), false);
  assert.equal(fs.existsSync(server.blobPath(fileDeep.storedName)), false);
  assert.equal(server.blobCount(), 1, 'на диске должен остаться только файл из корня');
  assert.ok(inner.id && deep.id);
});

test('очистка корзины удаляет записи, блобы и содержимое удалённых папок', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const folder = (await client.post('/api/folders', { name: 'на выброс' })).data;
  // файл внутри папки сам как удалённый НЕ помечается — уходит вместе с папкой
  const inFolder = (await uploadFile(client, { content: '12345', folderId: folder.id })).data;
  const loose = (await uploadFile(client, { content: '123' })).data;
  const keep = (await uploadFile(client, { content: 'остаётся' })).data;

  await client.patch(`/api/folders/${folder.id}`, { deleted: true });
  await client.patch(`/api/files/${loose.id}`, { deleted: true });

  const empty = await client.post('/api/rubbish/empty', {});
  assert.equal(empty.status, 200);
  assert.equal(empty.data.files, 1, 'помеченным удалённым был только один файл');
  assert.equal(empty.data.folders, 1);
  assert.equal(empty.data.freed, loose.size);

  const db = server.readDb();
  assert.deepEqual(db.files.map(f => f.id), [keep.id]);
  assert.equal(db.folders.length, 0);
  assert.equal(fs.existsSync(server.blobPath(inFolder.storedName)), false, 'файл внутри удалённой папки не должен остаться на диске');
  assert.equal(fs.existsSync(server.blobPath(loose.storedName)), false);
  assert.equal(server.blobCount(), 1);

  const rubbish = await client.get('/api/rubbish');
  assert.equal(rubbish.data.files.length, 0);
  assert.equal(rubbish.data.size, 0);
});

test('upload без файла отклоняется', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const res = await client.post('/api/files/upload', new FormData());
  assert.equal(res.status, 400);
  assert.equal(server.blobCount(), 0);
});
