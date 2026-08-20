const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, registerUser } = require('./helpers.js');

test('создание, переименование, вложенность и крошки', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const empty = await client.post('/api/folders', { name: '   ' });
  assert.equal(empty.status, 400, 'папка без имени создаваться не должна');

  const root = (await client.post('/api/folders', { name: '  Фото  ' })).data;
  assert.equal(root.name, 'Фото', 'имя должно обрезаться по краям');
  const child = (await client.post('/api/folders', { name: '2026', parentId: root.id })).data;

  const renamed = await client.patch(`/api/folders/${child.id}`, { name: 'Лето 2026' });
  assert.equal(renamed.data.name, 'Лето 2026');

  const level = await client.get(`/api/folders?parentId=${child.id}`);
  assert.deepEqual(level.data.breadcrumb, [
    { id: root.id, name: 'Фото' },
    { id: child.id, name: 'Лето 2026' },
  ]);
  assert.equal((await client.get('/api/folders')).data.folders.length, 1, 'в корне видна только верхняя папка');
});

test('перенос папки: обычный, в корень и в несуществующую', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const a = (await client.post('/api/folders', { name: 'A' })).data;
  const b = (await client.post('/api/folders', { name: 'B' })).data;

  const moved = await client.patch(`/api/folders/${b.id}`, { parentId: a.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.parentId, a.id);
  assert.equal((await client.get('/api/folders')).data.folders.length, 1);

  const toRoot = await client.patch(`/api/folders/${b.id}`, { parentId: null });
  assert.equal(toRoot.data.parentId, null);

  const nowhere = await client.patch(`/api/folders/${b.id}`, { parentId: 'no-such-folder' });
  assert.equal(nowhere.status, 404);

  const trashed = (await client.post('/api/folders', { name: 'C' })).data;
  await client.patch(`/api/folders/${trashed.id}`, { deleted: true });
  const intoTrashed = await client.patch(`/api/folders/${b.id}`, { parentId: trashed.id });
  assert.equal(intoTrashed.status, 404, 'папка из корзины не может быть местом назначения');
});

test('папку нельзя переместить внутрь себя или своего потомка', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const top = (await client.post('/api/folders', { name: 'верх' })).data;
  const mid = (await client.post('/api/folders', { name: 'середина', parentId: top.id })).data;
  const low = (await client.post('/api/folders', { name: 'низ', parentId: mid.id })).data;

  const self = await client.patch(`/api/folders/${top.id}`, { parentId: top.id });
  assert.equal(self.status, 400);
  assert.match(self.data.error, /внутрь себя/);

  // Клиент такой цикл поймать не может — у него на руках только текущий уровень
  const intoDescendant = await client.patch(`/api/folders/${top.id}`, { parentId: low.id });
  assert.equal(intoDescendant.status, 400);

  const db = server.readDb();
  assert.equal(db.folders.find(f => f.id === top.id).parentId, null, 'дерево должно остаться нетронутым');
  assert.equal(db.folders.find(f => f.id === mid.id).parentId, top.id);
});

test('чужие папки недоступны', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const owner = makeClient(server.url);
  await registerUser(owner, 'owner', 'secret123');
  const folder = (await owner.post('/api/folders', { name: 'приватная' })).data;

  const stranger = makeClient(server.url);
  await registerUser(stranger, 'stranger', 'secret123');
  assert.equal((await stranger.patch(`/api/folders/${folder.id}`, { name: 'взлом' })).status, 404);
  assert.equal((await stranger.del(`/api/folders/${folder.id}`)).status, 404);
  assert.equal((await stranger.get('/api/folders')).data.folders.length, 0);
  assert.equal(server.readDb().folders.find(f => f.id === folder.id).name, 'приватная');
});
