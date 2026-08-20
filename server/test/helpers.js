/**
 * Общая обвязка для тестов (node:test, без внешних зависимостей).
 *
 * server.js читает DATA_DIR и TRASH_TTL_DAYS один раз — при загрузке модуля.
 * Поэтому перед каждым подъёмом сервера мы сбрасываем его из кэша require и
 * подменяем переменные окружения: каждый тест получает свой пустой временный
 * каталог данных и свой экземпляр приложения на случайном порту (listen(0)).
 * Каталог удаляется после теста.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = require.resolve('../server.js');
// server.js при каждой загрузке вешает свой process.on('unhandledRejection'),
// а в одном файле тестов серверов бывает больше десяти — иначе Node ругается
// на "возможную утечку слушателей".
process.setMaxListeners(50);

async function startServer(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultly-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.JWT_SECRET = 'test-jwt-secret';
  if (options.trashTtlDays === undefined) delete process.env.TRASH_TTL_DAYS;
  else process.env.TRASH_TTL_DAYS = String(options.trashTtlDays);

  delete require.cache[SERVER_PATH];
  const mod = require(SERVER_PATH);
  const listener = mod.app.listen(0);
  await new Promise((resolve, reject) => {
    listener.once('listening', resolve);
    listener.once('error', reject);
  });
  const dbPath = path.join(dataDir, 'db.json');

  return {
    url: `http://127.0.0.1:${listener.address().port}`,
    dataDir,
    purgeExpiredTrash: mod.purgeExpiredTrash,
    // Прямой доступ к файлу БД — чтобы подделать состояние, которого иначе
    // пришлось бы ждать (истёкший срок ссылки, старая запись в корзине).
    // Безопасно только когда сервер простаивает: транзакции идут через withDb.
    readDb: () => JSON.parse(fs.readFileSync(dbPath, 'utf-8')),
    writeDb: (db) => fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)),
    blobPath: (storedName) => path.join(dataDir, 'storage', storedName),
    blobCount: () => fs.readdirSync(path.join(dataDir, 'storage')).length,
    async close() {
      // fetch (undici) держит keep-alive соединения открытыми, а listener.close()
      // ждёт их закрытия — без closeAllConnections тест зависал бы на выходе.
      await new Promise((resolve) => {
        listener.close(resolve);
        if (typeof listener.closeAllConnections === 'function') listener.closeAllConnections();
      });
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch (e) {
        // на Windows файл может быть ещё занят отдающим его потоком — временный
        // каталог всё равно подчистит ОС, ронять из-за этого тест не за что
      }
    },
  };
}

function makeClient(baseUrl) {
  let token = null;
  async function request(method, urlPath, body, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    if (token && !opts.anonymous) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      payload = body; // Content-Type выставит fetch (вместе с boundary)
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(baseUrl + urlPath, { method, headers, body: payload });
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await res.json()
      : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (p, opts) => request('GET', p, undefined, opts),
    post: (p, body, opts) => request('POST', p, body, opts),
    patch: (p, body, opts) => request('PATCH', p, body, opts),
    del: (p, body, opts) => request('DELETE', p, body, opts),
    setToken: (value) => { token = value; },
    getToken: () => token,
  };
}

async function registerUser(client, username = 'tester', password = 'secret123') {
  const res = await client.post('/api/auth/register', { username, password });
  if (res.status !== 200) throw new Error('Регистрация не удалась: ' + JSON.stringify(res.data));
  client.setToken(res.data.token);
  return res.data;
}

// Загружает "зашифрованный" файл. Сервер содержимое не разбирает — ему всё
// равно, настоящий это шифртекст или нет, поэтому шифровать в тестах не нужно.
async function uploadFile(client, options = {}) {
  const content = options.content === undefined ? 'encrypted-bytes' : options.content;
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const form = new FormData();
  form.set('blob', new Blob([bytes]), options.name || 'blob.bin');
  form.set('size', String(options.size === undefined ? bytes.length : options.size));
  form.set('contentIv', 'content-iv');
  form.set('attrsEncrypted', 'attrs-encrypted');
  form.set('attrsIv', 'attrs-iv');
  form.set('keyWrapped', 'key-wrapped');
  form.set('keyWrapIv', 'key-wrap-iv');
  if (options.folderId) form.set('folderId', options.folderId);
  return client.post('/api/files/upload', form);
}

// Полезная нагрузка для ссылки с паролем. На реальном клиенте это результат
// PBKDF2: первые 32 байта — ключ обёртки (остаётся в браузере), последние 32 —
// верификатор. Серверу всё равно, что именно за строки, поэтому берём заглушки.
function sharePassword(overrides = {}) {
  return Object.assign({
    salt: 'a'.repeat(32),
    keyWrapped: 'wrapped-file-key',
    keyWrapIv: 'wrap-iv',
    verifier: 'correct-verifier',
  }, overrides);
}

module.exports = { startServer, makeClient, registerUser, uploadFile, sharePassword };
