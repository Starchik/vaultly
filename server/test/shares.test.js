const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, registerUser, uploadFile, sharePassword } = require('./helpers.js');

// Сдвигаем срок жизни ссылки в прошлое — ждать реальный час в тесте нечем.
function expireShare(server, publicId) {
  const db = server.readDb();
  db.shares.find(s => s.publicId === publicId).expiresAt = Date.now() - 1000;
  server.writeDb(db);
}

test('ссылка без пароля: создание, метаданные, скачивание, счётчик', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const file = (await uploadFile(client, { content: 'публичные байты' })).data;

  const created = await client.post(`/api/files/${file.id}/share`, {});
  assert.equal(created.status, 200);
  assert.ok(created.data.publicId);
  assert.deepEqual(created.data, {
    publicId: created.data.publicId,
    expiresAt: null,
    maxDownloads: null,
    downloads: 0,
    requiresPassword: false,
  });

  const again = await client.post(`/api/files/${file.id}/share`, {});
  assert.equal(again.data.publicId, created.data.publicId, 'повторное создание не должно менять ссылку');

  const settings = await client.get(`/api/files/${file.id}/share`);
  assert.equal(settings.data.publicId, created.data.publicId);

  // публичные эндпоинты — без токена
  const guest = makeClient(server.url);
  const meta = await guest.get(`/api/share/${created.data.publicId}/meta`);
  assert.equal(meta.status, 200);
  assert.equal(meta.data.size, file.size);
  assert.equal(meta.data.contentIv, 'content-iv');
  assert.equal(meta.data.attrsEncrypted, 'attrs-encrypted');
  assert.equal(meta.data.requiresPassword, false);
  assert.equal(meta.data.passwordSalt, null);
  assert.equal(meta.data.keyWrapped, undefined, 'ключ файла публично отдавать нельзя ни в каком виде');

  const dl = await guest.get(`/api/share/${created.data.publicId}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.data.toString(), 'публичные байты');
  assert.equal((await client.get(`/api/files/${file.id}/share`)).data.downloads, 1);

  const del = await client.del(`/api/files/${file.id}/share`);
  assert.equal(del.status, 200);
  assert.equal((await guest.get(`/api/share/${created.data.publicId}/meta`)).status, 404);
  assert.equal((await client.get(`/api/files/${file.id}/share`)).status, 404);
});

test('истёкший срок и удалённый файл закрывают ссылку', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const guest = makeClient(server.url);

  const first = (await uploadFile(client)).data;
  const expiring = (await client.post(`/api/files/${first.id}/share`, { ttlHours: 1 })).data;
  assert.ok(expiring.expiresAt > Date.now(), 'ttlHours должен превращаться в момент истечения');
  assert.equal((await guest.get(`/api/share/${expiring.publicId}/meta`)).status, 200);

  expireShare(server, expiring.publicId);
  const meta = await guest.get(`/api/share/${expiring.publicId}/meta`);
  assert.equal(meta.status, 410);
  assert.match(meta.data.error, /Срок действия/);
  assert.equal((await guest.get(`/api/share/${expiring.publicId}/download`)).status, 410);
  assert.equal(server.readDb().shares[0].downloads, 0, 'мёртвая ссылка не должна крутить счётчик');

  const second = (await uploadFile(client)).data;
  const trashedShare = (await client.post(`/api/files/${second.id}/share`, {})).data;
  await client.patch(`/api/files/${second.id}`, { deleted: true });
  const gone = await guest.get(`/api/share/${trashedShare.publicId}/meta`);
  assert.equal(gone.status, 404, 'файл в корзине по ссылке отдаваться не должен');
  assert.match(gone.data.error, /недоступен/);
});

test('лимит скачиваний исчерпывается и поднимается заново', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const guest = makeClient(server.url);
  const file = (await uploadFile(client)).data;

  const share = (await client.post(`/api/files/${file.id}/share`, { maxDownloads: 2 })).data;
  assert.equal(share.maxDownloads, 2);
  assert.equal((await guest.get(`/api/share/${share.publicId}/download`)).status, 200);
  assert.equal((await guest.get(`/api/share/${share.publicId}/download`)).status, 200);

  const third = await guest.get(`/api/share/${share.publicId}/download`);
  assert.equal(third.status, 410);
  assert.match(third.data.error, /Лимит/);
  assert.equal((await guest.get(`/api/share/${share.publicId}/meta`)).status, 410);

  // Настройки перезаписываются той же ссылкой. Смена лимита обнуляет счётчик,
  // иначе поднять лимит у уже упёршейся ссылки было бы невозможно.
  const raised = await client.post(`/api/files/${file.id}/share`, { maxDownloads: 3 });
  assert.equal(raised.data.publicId, share.publicId);
  assert.equal(raised.data.downloads, 0);
  assert.equal((await guest.get(`/api/share/${share.publicId}/download`)).status, 200);

  const resaved = await client.post(`/api/files/${file.id}/share`, { maxDownloads: 3 });
  assert.equal(resaved.data.downloads, 1, 'сохранение тех же настроек счётчик не сбрасывает');
});

test('некорректные настройки ссылки отклоняются', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const file = (await uploadFile(client)).data;
  const url = `/api/files/${file.id}/share`;

  assert.equal((await client.post(url, { ttlHours: 0 })).status, 400);
  assert.equal((await client.post(url, { ttlHours: -5 })).status, 400);
  assert.equal((await client.post(url, { ttlHours: 'скоро' })).status, 400);
  assert.equal((await client.post(url, { maxDownloads: 0 })).status, 400);
  assert.equal((await client.post(url, { maxDownloads: 1.5 })).status, 400);
  assert.equal((await client.post(url, { password: { salt: 'a', keyWrapped: 'b' } })).status, 400);
  assert.equal((await client.post(url, { password: sharePassword({ salt: 'x'.repeat(200) }) })).status, 400);
  assert.equal((await client.post('/api/files/no-such-file/share', {})).status, 404);
  assert.equal(server.readDb().shares.length, 0, 'ни одна отклонённая настройка не должна создать ссылку');
});

test('ссылка с паролем: обёртка ключа только после проверки, байты — только с верификатором', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const guest = makeClient(server.url);
  const file = (await uploadFile(client, { content: 'секрет под паролем' })).data;
  const password = sharePassword();

  const share = (await client.post(`/api/files/${file.id}/share`, { password })).data;
  assert.equal(share.requiresPassword, true);

  const meta = await guest.get(`/api/share/${share.publicId}/meta`);
  assert.equal(meta.status, 200);
  assert.equal(meta.data.requiresPassword, true);
  assert.equal(meta.data.passwordSalt, password.salt, 'соль публична — без неё пароль не развернуть в ключ');
  assert.equal(meta.data.keyWrapped, undefined, 'обёртка ключа не должна отдаваться до проверки пароля');

  const wrong = await guest.post(`/api/share/${share.publicId}/unlock`, { verifier: 'wrong-verifier' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.keyWrapped, undefined);
  const noVerifier = await guest.post(`/api/share/${share.publicId}/unlock`, {});
  assert.equal(noVerifier.status, 401);

  const ok = await guest.post(`/api/share/${share.publicId}/unlock`, { verifier: password.verifier });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.keyWrapped, password.keyWrapped);
  assert.equal(ok.data.keyWrapIv, password.keyWrapIv);

  assert.equal(server.readDb().shares[0].downloads, 0, 'проверки пароля не должны расходовать лимит');

  const bare = await guest.get(`/api/share/${share.publicId}/download`);
  assert.equal(bare.status, 401, 'без верификатора байты не отдаём — иначе пароль обходится напрямую');
  const forged = await guest.get(`/api/share/${share.publicId}/download`, { headers: { 'x-share-verifier': 'wrong-verifier' } });
  assert.equal(forged.status, 401);
  assert.equal(server.readDb().shares[0].downloads, 0);

  const dl = await guest.get(`/api/share/${share.publicId}/download`, { headers: { 'x-share-verifier': password.verifier } });
  assert.equal(dl.status, 200);
  assert.equal(dl.data.toString(), 'секрет под паролем');
  assert.equal(server.readDb().shares[0].downloads, 1);
});

test('в db.json не попадает ни ключ файла, ни сам верификатор', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const file = (await uploadFile(client)).data;
  const password = sharePassword();
  await client.post(`/api/files/${file.id}/share`, { password });

  const stored = server.readDb().shares[0];
  assert.deepEqual(Object.keys(stored.password).sort(), ['keyWrapIv', 'keyWrapped', 'salt', 'verifierHash']);
  assert.match(stored.password.verifierHash, /^[0-9a-f]{64}$/);
  assert.equal(stored.password.verifier, undefined);
  const dump = JSON.stringify(server.readDb());
  assert.equal(dump.includes(password.verifier), false, 'верификатор хранится только в виде SHA-256');
});

test('перебор пароля по ссылке ограничен', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const guest = makeClient(server.url);
  const file = (await uploadFile(client)).data;
  const password = sharePassword();
  const share = (await client.post(`/api/files/${file.id}/share`, { password })).data;
  const unlock = `/api/share/${share.publicId}/unlock`;

  for (let i = 1; i <= 10; i++) {
    const res = await guest.post(unlock, { verifier: `guess-${i}` });
    assert.equal(res.status, 401, `попытка ${i} должна просто отклоняться`);
  }
  const blocked = await guest.post(unlock, { verifier: password.verifier });
  assert.equal(blocked.status, 429, 'после 10 попыток должен включаться тайм-аут — даже для верного пароля');
  assert.match(blocked.data.error, /попыток/);
});

test('пропущенное поле настроек не сбрасывает остальные', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const guest = makeClient(server.url);
  const file = (await uploadFile(client)).data;
  const password = sharePassword();

  const share = (await client.post(`/api/files/${file.id}/share`, {
    ttlHours: 24,
    maxDownloads: 5,
    password,
  })).data;

  // модалка меняет только лимит: пароля она не знает, а срок хранится
  // абсолютным моментом и в «часах до истечения» не восстанавливается
  const patched = (await client.post(`/api/files/${file.id}/share`, { maxDownloads: 7 })).data;
  assert.equal(patched.maxDownloads, 7);
  assert.equal(patched.requiresPassword, true, 'пароль должен сохраниться');
  assert.equal(patched.expiresAt, share.expiresAt, 'срок не должен ни сбрасываться, ни продлеваться');

  const unlock = await guest.post(`/api/share/${share.publicId}/unlock`, { verifier: password.verifier });
  assert.equal(unlock.status, 200, 'старый пароль должен продолжать работать');

  // явный null — снять ограничение
  const cleared = (await client.post(`/api/files/${file.id}/share`, { ttlHours: null, maxDownloads: null })).data;
  assert.equal(cleared.expiresAt, null);
  assert.equal(cleared.maxDownloads, null);
  assert.equal(cleared.requiresPassword, true);
});

test('снятие пароля возвращает ссылку в открытый режим', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const client = makeClient(server.url);
  await registerUser(client);
  const guest = makeClient(server.url);
  const file = (await uploadFile(client)).data;
  const share = (await client.post(`/api/files/${file.id}/share`, { password: sharePassword() })).data;

  const opened = await client.post(`/api/files/${file.id}/share`, { password: null });
  assert.equal(opened.data.publicId, share.publicId);
  assert.equal(opened.data.requiresPassword, false);
  assert.equal(server.readDb().shares[0].password, null);

  assert.equal((await guest.get(`/api/share/${share.publicId}/download`)).status, 200);
  const unlock = await guest.post(`/api/share/${share.publicId}/unlock`, { verifier: 'что-нибудь' });
  assert.equal(unlock.status, 400, 'разблокировать ссылку без пароля нечем');
});
