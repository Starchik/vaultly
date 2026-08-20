/**
 * WebAuthn: проверяем то, что не требует настоящего аутентификатора —
 * параметры церемоний и отказы. Подписать challenge в тесте нечем (для этого
 * нужен Touch ID / Windows Hello или виртуальный аутентификатор браузера),
 * поэтому успешный register-verify/login-verify здесь не воспроизводится —
 * он проверяется вручную по чек-листу.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, registerUser } = require('./helpers.js');

const PRF_SALT = Buffer.from('vaultly-master-key-unlock-v1').toString('base64url');

// Ключ доступа, каким он лежит в БД после настройки беспарольного входа.
// publicKey — заглушка: до проверки подписи ни один тест ниже не доходит.
function addCredential(server, overrides = {}) {
  const db = server.readDb();
  const cred = Object.assign({
    id: 'test-credential-id',
    userId: db.users[0].id,
    publicKey: Buffer.from('not-a-real-key').toString('base64'),
    counter: 0,
    transports: ['internal'],
    deviceLabel: 'Тестовое устройство',
    discoverable: true,
    wrappedMasterKey: { data: 'wrapped-master-key', iv: 'master-key-iv' },
    createdAt: Date.now(),
  }, overrides);
  db.webauthnCredentials.push(cred);
  server.writeDb(db);
  return cred;
}

test('PRF-соль постоянна и публична', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const guest = makeClient(server.url);

  const res = await guest.get('/api/webauthn/prf-salt');
  assert.equal(res.status, 200);
  assert.equal(res.data.salt, PRF_SALT, 'соль — доменный разделитель, менять её нельзя: сломается расшифровка мастер-ключа');
});

test('регистрация ключа запрашивается как discoverable с PRF', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client, 'keyowner', 'secret123');

  const res = await client.post('/api/webauthn/register-options', {});
  assert.equal(res.status, 200);
  const options = res.data;
  // resident key — то, ради чего при входе не нужно вводить ни пароль, ни логин
  assert.equal(options.authenticatorSelection.residentKey, 'required');
  assert.equal(options.authenticatorSelection.requireResidentKey, true);
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  assert.deepEqual(options.extensions.prf, {}, 'без PRF биометрия не сможет развернуть мастер-ключ');
  assert.equal(options.extensions.credProps, true);
  assert.equal(options.user.name, 'keyowner');
  assert.equal(options.rp.name, 'Vaultly');
  assert.ok(options.challenge);
  // userHandle = user.id: именно из него сервер узнаёт аккаунт при входе без логина
  assert.equal(
    Buffer.from(options.user.id, 'base64url').toString('utf8'),
    server.readDb().users[0].id
  );

  assert.equal((await makeClient(server.url).post('/api/webauthn/register-options', {})).status, 401);
});

test('уже зарегистрированный ключ попадает в excludeCredentials', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const cred = addCredential(server);

  const options = (await client.post('/api/webauthn/register-options', {})).data;
  assert.deepEqual(options.excludeCredentials.map(c => c.id), [cred.id], 'иначе на одном устройстве появятся дубли ключей');
});

test('вход без логина: 404, пока нет ни одного беспарольного ключа', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client, 'keyowner', 'secret123');
  const guest = makeClient(server.url);

  const empty = await guest.post('/api/webauthn/login-options', {});
  assert.equal(empty.status, 404);
  assert.match(empty.data.error, /ключа доступа/);

  // ключ есть, но беспарольный вход на нём не настроен (wrappedMasterKey нет)
  addCredential(server, { id: 'no-master-key', wrappedMasterKey: null });
  assert.equal((await guest.post('/api/webauthn/login-options', {})).status, 404);

  addCredential(server, { id: 'passwordless-key' });
  const ready = await guest.post('/api/webauthn/login-options', {});
  assert.equal(ready.status, 200);
  assert.ok(ready.data.challengeId);
  assert.equal(ready.data.options.userVerification, 'required');
  assert.equal(ready.data.options.extensions.prf.eval.first, PRF_SALT);
  assert.ok(
    !ready.data.options.allowCredentials || ready.data.options.allowCredentials.length === 0,
    'без логина список ключей не передаём — браузер сам покажет сохранённые на устройстве'
  );
});

test('вход с логином: fallback-режим и отказы', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client, 'keyowner', 'secret123');
  const guest = makeClient(server.url);

  const unknown = await guest.post('/api/webauthn/login-options', { username: 'nobody' });
  assert.equal(unknown.status, 404);

  const noKeys = await guest.post('/api/webauthn/login-options', { username: 'keyowner' });
  assert.equal(noKeys.status, 404);
  assert.match(noKeys.data.error, /беспарольный вход/);

  const cred = addCredential(server);
  const ok = await guest.post('/api/webauthn/login-options', { username: 'KEYOWNER' });
  assert.equal(ok.status, 200, 'логин должен сверяться без учёта регистра');
  assert.deepEqual(ok.data.options.allowCredentials.map(c => c.id), [cred.id]);
});

test('login-verify отклоняет мусор и устаревшие запросы', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  addCredential(server);
  const guest = makeClient(server.url);

  const noBody = await guest.post('/api/webauthn/login-verify', {});
  assert.equal(noBody.status, 400);

  const staleChallenge = await guest.post('/api/webauthn/login-verify', {
    assertionResponse: { id: 'test-credential-id' },
    challengeId: 'never-issued',
  });
  assert.equal(staleChallenge.status, 400);
  assert.match(staleChallenge.data.error, /устарел/);

  // challenge настоящий, но аутентификатор не сообщил, какой это аккаунт
  const issued = await guest.post('/api/webauthn/login-options', {});
  const noHandle = await guest.post('/api/webauthn/login-verify', {
    assertionResponse: { id: 'test-credential-id', response: {} },
    challengeId: issued.data.challengeId,
  });
  assert.equal(noHandle.status, 400);
  assert.match(noHandle.data.error, /какой это аккаунт/);
});

test('список и удаление ключей доступа', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);

  assert.deepEqual((await client.get('/api/webauthn/credentials')).data.credentials, []);
  const cred = addCredential(server);
  const list = (await client.get('/api/webauthn/credentials')).data.credentials;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    id: cred.id,
    deviceLabel: 'Тестовое устройство',
    createdAt: cred.createdAt,
    passwordless: true,
    discoverable: true,
  });
  assert.equal(list[0].publicKey, undefined, 'лишние поля наружу не отдаём');

  const stranger = makeClient(server.url);
  await registerUser(stranger, 'stranger', 'secret123');
  await stranger.del(`/api/webauthn/credentials/${cred.id}`);
  assert.equal(server.readDb().webauthnCredentials.length, 1, 'чужой ключ удалить нельзя');

  assert.equal((await client.del(`/api/webauthn/credentials/${cred.id}`)).status, 200);
  assert.equal(server.readDb().webauthnCredentials.length, 0);
});

test('обёрнутый мастер-ключ сохраняется только своему ключу доступа', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const cred = addCredential(server, { wrappedMasterKey: null });

  assert.equal((await client.post('/api/webauthn/wrap-key', { credentialId: cred.id })).status, 400);
  assert.equal((await client.post('/api/webauthn/wrap-key', {
    credentialId: cred.id,
    wrappedMasterKey: { data: 'x' },
  })).status, 400, 'без iv расшифровать мастер-ключ будет нечем');

  const missing = await client.post('/api/webauthn/wrap-key', {
    credentialId: 'no-such-credential',
    wrappedMasterKey: { data: 'x', iv: 'y' },
  });
  assert.equal(missing.status, 404);

  const ok = await client.post('/api/webauthn/wrap-key', {
    credentialId: cred.id,
    wrappedMasterKey: { data: 'wrapped', iv: 'iv' },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(server.readDb().webauthnCredentials[0].wrappedMasterKey, { data: 'wrapped', iv: 'iv' });
  assert.equal((await client.get('/api/webauthn/credentials')).data.credentials[0].passwordless, true);
});
