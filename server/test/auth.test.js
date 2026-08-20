const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, registerUser } = require('./helpers.js');

test('регистрация, вход и профиль', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);

  const reg = await registerUser(client, 'alice', 'secret123');
  assert.equal(reg.username, 'alice');
  assert.match(reg.kdfSalt, /^[0-9a-f]{32}$/, 'соль для клиентского PBKDF2 должна приходить с сервера');
  assert.ok(reg.token);

  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.username, 'alice');
  assert.equal(me.data.used, 0);
  assert.equal(me.data.trashed, 0);
  assert.ok(me.data.quota > 0);

  const login = await client.post('/api/auth/login', { username: 'alice', password: 'secret123' });
  assert.equal(login.status, 200);
  assert.equal(login.data.kdfSalt, reg.kdfSalt, 'соль не должна меняться между входами — иначе ключи файлов не расшифруются');
});

test('логин занят — второй раз не зарегистрировать', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);

  await registerUser(client, 'bob', 'secret123');
  const again = await client.post('/api/auth/register', { username: 'BOB', password: 'secret123' });
  assert.equal(again.status, 409, 'сравнение логинов должно быть регистронезависимым');
});

test('короткий пароль и неверные данные входа', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);

  const short = await client.post('/api/auth/register', { username: 'carol', password: '12345' });
  assert.equal(short.status, 400);

  await registerUser(client, 'carol', 'secret123');
  const wrongPass = await client.post('/api/auth/login', { username: 'carol', password: 'wrong-one' });
  assert.equal(wrongPass.status, 401);
  const noUser = await client.post('/api/auth/login', { username: 'nobody', password: 'secret123' });
  assert.equal(noUser.status, 401, 'существование логина не должно утекать через разные статусы');
});

test('без токена и с мусорным токеном доступа нет', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  const anon = await client.get('/api/auth/me', { anonymous: true });
  assert.equal(anon.status, 401);

  client.setToken('not-a-jwt');
  const broken = await client.get('/api/folders');
  assert.equal(broken.status, 401);
});
