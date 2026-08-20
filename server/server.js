/**
 * Vaultly Server
 * -----------------
 * Приватный файлообменник с шифрованием нулевого разглашения (zero-knowledge).
 *
 * Ключевая особенность: сервер НИКОГДА не видит ключи шифрования файлов.
 * Файлы шифруются в браузере (AES-256-GCM, Web Crypto API) ДО отправки
 * на сервер. Сервер хранит только зашифрованные байты + зашифрованные
 * метаданные (имя, размер).
 *
 * Ключ файла хранится в "обёрнутом" виде (зашифрован мастер-ключом
 * пользователя) — так пользователь видит список своих файлов после логина.
 * Для публичных ссылок сырой ключ файла кладётся во фрагмент URL (после #),
 * который браузер никогда не отправляет на сервер — сервер физически не
 * может его узнать.
 *
 * Хранилище метаданных: простой JSON-файл (db.json). Для хобби-проекта
 * этого достаточно; для продакшена замените на настоящую БД.
 *
 * Биометрия (WebAuthn + расширение PRF): биометрический вход не просто
 * "подтверждает личность" — он ещё и восстанавливает мастер-ключ
 * шифрования без ввода пароля. Это возможно благодаря расширению PRF:
 * аутентификатор (Touch ID/Face ID/Windows Hello/отпечаток на Android)
 * детерминированно выводит секрет, которым на клиенте обёрнут мастер-ключ.
 * Сервер этот секрет никогда не видит — только обёрнутый (зашифрованный)
 * мастер-ключ и публичный ключ WebAuthn-credential для проверки подписи.
 * Поддержка PRF зависит от браузера/устройства — если её нет, кнопка
 * биометрического входа для нового устройства скрыта.
 *
 * Ключи доступа регистрируются как discoverable (resident key): аутентификатор
 * хранит их вместе с userHandle, поэтому при входе не нужно вводить ни пароль,
 * ни логин — сервер узнаёт аккаунт из подписанного userHandle. Логин при входе
 * принимается лишь как fallback для ключей, созданных до этого изменения.
 */

const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const PORT = process.env.PORT || 7860;
// DATA_DIR — куда пишутся данные (БД, JWT-секрет, загруженные файлы).
// По умолчанию — рядом с сервером, но на платформах с эфемерной ФС
// (Render, Hugging Face Spaces и т.п.) нужно смонтировать постоянный том
// и указать его путь через переменную окружения DATA_DIR — тогда данные
// переживут перезапуск/передеплой контейнера.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'db.json');
const STORAGE_DIR = path.join(DATA_DIR, 'storage');
const SECRET_PATH = path.join(DATA_DIR, '.jwt-secret');
const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB на пользователя по умолчанию
// Через сколько дней содержимое корзины удаляется безвозвратно (0 — никогда).
// Без этого удалённые файлы лежали в storage/ вечно: из интерфейса они уходят,
// а место на диске занимают.
const TRASH_TTL_DAYS = Number.isFinite(Number(process.env.TRASH_TTL_DAYS))
  ? Number(process.env.TRASH_TTL_DAYS)
  : 30;
const TRASH_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- JWT-секрет: персистентный, переживает перезапуски сервера ----------
// Раньше секрет генерировался заново при каждом старте процесса — из-за этого
// любой перезапуск сервера (падение, авто-рестарт при разработке и т.п.)
// мгновенно делал недействительными ВСЕ выданные токены, и все запросы
// начинали падать с "Требуется авторизация"/"Недействительный токен",
// хотя внешне выглядело как случайный баг то тут, то там.
function loadOrCreateJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, 'utf-8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = loadOrCreateJwtSecret();

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ users: [], folders: [], files: [], shares: [], webauthnCredentials: [] }, null, 2));
}

// ---------- простая JSON "БД" с транзакциями ----------
// Раньше сериализовалась только ЗАПИСЬ, а не весь цикл: два параллельных
// запроса читали одну и ту же версию db.json, мутировали каждый свою копию,
// и вторая запись затирала первую (создали две папки — осталась одна).
// Теперь под замком идёт весь цикл чтение→мутация→запись, а файл подменяется
// атомарным rename: падение процесса посреди записи больше не может оставить
// обрезанный db.json (то есть потерю всего аккаунта).
function readDb() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (!db.webauthnCredentials) db.webauthnCredentials = [];
  return db;
}

let dbLock = Promise.resolve();
function withDb(fn) {
  const run = dbLock.then(async () => {
    const db = readDb();
    const result = await fn(db);
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_PATH);
    return result;
  });
  // ошибка (в т.ч. брошенный HttpError) не должна вставать поперёк очереди:
  // изменения этой транзакции просто не записываются
  dbLock = run.then(() => {}, () => {});
  return run;
}

// Ошибка с HTTP-статусом — чтобы проверки внутри транзакции могли просто
// бросить исключение вместо отправки ответа из середины withDb.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const httpError = (status, message) => new HttpError(status, message);

// ---------- хранилище блобов и корзина ----------

function removeBlob(storedName) {
  try {
    const blobPath = path.join(STORAGE_DIR, storedName);
    if (fs.existsSync(blobPath)) fs.unlinkSync(blobPath);
  } catch (e) {
    // потеря блоба не должна валить транзакцию — запись в БД всё равно уходит
    console.error('Не удалось удалить блоб', storedName, e);
  }
}

// Занятое место. Файлы в корзине ТОЖЕ считаются: они физически лежат на диске,
// и делать вид, что корзина бесплатна, было бы нечестно.
function usedBytes(db, userId) {
  return db.files.filter(f => f.userId === userId).reduce((sum, f) => sum + f.size, 0);
}
function trashedBytes(db, userId) {
  return db.files.filter(f => f.userId === userId && f.deleted).reduce((sum, f) => sum + f.size, 0);
}

// Все папки поддерева, включая корневую (обход вниз по parentId).
function collectFolderIds(db, userId, rootId) {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++) {
    for (const folder of db.folders) {
      if (folder.userId === userId && folder.parentId === ids[i]) ids.push(folder.id);
    }
  }
  return ids;
}

// Жёсткое удаление файлов: записи, блобы на диске и публичные ссылки на них.
function hardDeleteFiles(db, files) {
  if (!files.length) return 0;
  const ids = new Set(files.map(f => f.id));
  for (const file of files) removeBlob(file.storedName);
  db.files = db.files.filter(f => !ids.has(f.id));
  db.shares = db.shares.filter(s => !ids.has(s.fileId));
  return files.length;
}

// Жёсткое удаление папки со всем содержимым. Раньше удалялась только запись
// самой папки — вложенные папки и файлы оставались сиротами: в интерфейс уже
// не попадали, а место на диске занимали навсегда.
function hardDeleteFolderTree(db, userId, rootId) {
  const folderIds = new Set(collectFolderIds(db, userId, rootId));
  hardDeleteFiles(db, db.files.filter(f => f.userId === userId && folderIds.has(f.folderId)));
  db.folders = db.folders.filter(f => !(f.userId === userId && folderIds.has(f.id)));
}

// Автоочистка корзины по сроку. Экспортируется, чтобы её можно было вызвать в тестах.
function purgeExpiredTrash() {
  if (!(TRASH_TTL_DAYS > 0)) return Promise.resolve({ files: 0, folders: 0 });
  const ttlMs = TRASH_TTL_DAYS * 24 * 60 * 60 * 1000;
  return withDb((db) => {
    const now = Date.now();
    // у записей из старых версий deletedAt нет — начинаем отсчёт с этого прохода
    for (const rec of db.files.concat(db.folders)) {
      if (rec.deleted && !rec.deletedAt) rec.deletedAt = now;
    }
    const expired = (rec) => rec.deleted && rec.deletedAt && now - rec.deletedAt > ttlMs;
    const files = db.files.filter(expired);
    hardDeleteFiles(db, files);
    const folders = db.folders.filter(expired);
    for (const folder of folders) hardDeleteFolderTree(db, folder.userId, folder.id);
    if (files.length || folders.length) {
      console.log(`Корзина: безвозвратно удалено файлов ${files.length}, папок ${folders.length}`);
    }
    return { files: files.length, folders: folders.length };
  });
}

// Не даём процессу падать из-за необработанных ошибок в асинхронных хендлерах
// (раньше это могло уронить сервер и — вместе со случайным JWT-секретом —
// разлогинить всех пользователей без видимой причины).
process.on('unhandledRejection', (err) => {
  console.error('Необработанная ошибка (сервер продолжает работу):', err);
});

// оборачиваем async-хендлеры, чтобы отклонённый промис превращался в
// аккуратный ответ, а не в необработанное исключение
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err instanceof HttpError) {
      if (!res.headersSent) res.status(err.status).json({ error: err.message });
      return;
    }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });
}

// ---------- приложение ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Сессия истекла, войдите заново' });
  }
}

function getRpID(req) {
  // домен без порта и протокола, как того требует WebAuthn
  return (req.hostname || 'localhost');
}
function getOrigin(req) {
  return req.headers.origin || `${req.protocol}://${req.get('host')}`;
}

// ===================== AUTH =====================

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Логин обязателен, пароль минимум 6 символов' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  // соль для клиентского PBKDF2 (вывод мастер-ключа шифрования) — отдельная от bcrypt
  const kdfSalt = crypto.randomBytes(16).toString('hex');
  // проверка занятости логина и вставка — в одной транзакции, иначе два
  // одновременных запроса могли создать двух пользователей с одним именем
  const user = await withDb((db) => {
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
      throw httpError(409, 'Пользователь с таким именем уже существует');
    }
    const rec = {
      id: uuidv4(),
      username,
      passwordHash,
      kdfSalt,
      quota: DEFAULT_QUOTA_BYTES,
      createdAt: Date.now(),
    };
    db.users.push(rec);
    return rec;
  });
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, kdfSalt: user.kdfSalt });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const db = readDb();
  const user = db.users.find(u => u.username.toLowerCase() === (username || '').toLowerCase());
  if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Неверный логин или пароль' });
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, kdfSalt: user.kdfSalt });
}));

app.get('/api/auth/me', authMiddleware, asyncHandler(async (req, res) => {
  const db = readDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  // used включает корзину (файлы никуда с диска не делись), trashed показываем
  // отдельной строкой, чтобы было видно, сколько освободит очистка
  res.json({
    username: user.username,
    kdfSalt: user.kdfSalt,
    quota: user.quota,
    used: usedBytes(db, user.id),
    trashed: trashedBytes(db, user.id),
    trashTtlDays: TRASH_TTL_DAYS,
  });
}));

// ===================== FOLDERS =====================
// Имена папок хранятся в открытом виде (сознательное упрощение — полное
// шифрование дерева папок сильно усложнило бы навигацию). Содержимое и
// имена ФАЙЛОВ — шифруются полностью.

app.get('/api/folders', authMiddleware, asyncHandler(async (req, res) => {
  const db = readDb();
  const parentId = req.query.parentId || null;
  const folders = db.folders.filter(f => f.userId === req.userId && !f.deleted && f.parentId === parentId);
  const files = db.files.filter(f => f.userId === req.userId && !f.deleted && f.folderId === parentId);
  // хлебные крошки
  const breadcrumb = [];
  let cur = parentId;
  while (cur) {
    const fld = db.folders.find(f => f.id === cur);
    if (!fld) break;
    breadcrumb.unshift({ id: fld.id, name: fld.name });
    cur = fld.parentId;
  }
  res.json({ folders, files, breadcrumb });
}));

app.post('/api/folders', authMiddleware, asyncHandler(async (req, res) => {
  const { name, parentId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите имя папки' });
  const folder = await withDb((db) => {
    const rec = {
      id: uuidv4(),
      userId: req.userId,
      parentId: parentId || null,
      name: name.trim(),
      createdAt: Date.now(),
      deleted: false,
      deletedAt: null,
    };
    db.folders.push(rec);
    return rec;
  });
  res.json(folder);
}));

app.patch('/api/folders/:id', authMiddleware, asyncHandler(async (req, res) => {
  const folder = await withDb((db) => {
    const rec = db.folders.find(f => f.id === req.params.id && f.userId === req.userId);
    if (!rec) throw httpError(404, 'Папка не найдена');
    if (req.body.name) rec.name = req.body.name.trim();
    if ('parentId' in req.body) {
      const target = req.body.parentId || null;
      if (target) {
        const dest = db.folders.find(f => f.id === target && f.userId === req.userId && !f.deleted);
        if (!dest) throw httpError(404, 'Папка назначения не найдена');
        // Защита от цикла: поднимаемся от новой папки-родителя к корню и следим,
        // не встретится ли перемещаемая папка. Клиент этого проверить не может —
        // у него на руках только текущий уровень дерева.
        let cursor = dest;
        while (cursor) {
          if (cursor.id === rec.id) throw httpError(400, 'Нельзя переместить папку внутрь себя');
          cursor = cursor.parentId ? db.folders.find(f => f.id === cursor.parentId) : null;
        }
      }
      rec.parentId = target;
    }
    if ('deleted' in req.body) {
      rec.deleted = !!req.body.deleted;
      rec.deletedAt = rec.deleted ? Date.now() : null;
    }
    return rec;
  });
  res.json(folder);
}));

// Жёсткое удаление — вместе со всем содержимым (вложенные папки, файлы, блобы,
// публичные ссылки). Мягкое удаление в корзину делается через PATCH.
app.delete('/api/folders/:id', authMiddleware, asyncHandler(async (req, res) => {
  await withDb((db) => {
    const folder = db.folders.find(f => f.id === req.params.id && f.userId === req.userId);
    if (!folder) throw httpError(404, 'Папка не найдена');
    hardDeleteFolderTree(db, req.userId, folder.id);
  });
  res.json({ ok: true });
}));

// ===================== FILES =====================

app.post('/api/files/upload', authMiddleware, upload.single('blob'), asyncHandler(async (req, res) => {
  const { folderId, size, contentIv, attrsEncrypted, attrsIv, keyWrapped, keyWrapIv } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const incomingSize = Number(size) || req.file.size;
  const storedName = uuidv4();
  fs.writeFileSync(path.join(STORAGE_DIR, storedName), req.file.buffer);
  try {
    const fileRec = await withDb((db) => {
      const user = db.users.find(u => u.id === req.userId);
      if (!user) throw httpError(401, 'Сессия истекла, войдите заново');
      // проверка квоты и вставка — в одной транзакции: разнесённые, они
      // позволяли параллельным загрузкам вместе перескочить лимит
      if (usedBytes(db, req.userId) + incomingSize > user.quota) {
        throw httpError(413, 'Превышена квота хранилища');
      }
      const rec = {
        id: uuidv4(),
        userId: req.userId,
        folderId: folderId || null,
        storedName,
        size: incomingSize,
        contentIv,
        attrsEncrypted,
        attrsIv,
        keyWrapped,
        keyWrapIv,
        createdAt: Date.now(),
        deleted: false,
        deletedAt: null,
      };
      db.files.push(rec);
      return rec;
    });
    res.json(fileRec);
  } catch (e) {
    // блоб уже на диске, а записи о нём не будет — убираем, чтобы не копился мусор
    removeBlob(storedName);
    throw e;
  }
}));

app.get('/api/files/:id/meta', authMiddleware, asyncHandler(async (req, res) => {
  const db = readDb();
  const file = db.files.find(f => f.id === req.params.id && f.userId === req.userId);
  if (!file) return res.status(404).json({ error: 'Файл не найден' });
  res.json(file);
}));

app.get('/api/files/:id/download', authMiddleware, asyncHandler(async (req, res) => {
  const db = readDb();
  const file = db.files.find(f => f.id === req.params.id && f.userId === req.userId);
  if (!file) return res.status(404).json({ error: 'Файл не найден' });
  const filePath = path.join(STORAGE_DIR, file.storedName);
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'Содержимое файла отсутствует на диске' });
  res.sendFile(filePath);
}));

app.patch('/api/files/:id', authMiddleware, asyncHandler(async (req, res) => {
  const file = await withDb((db) => {
    const rec = db.files.find(f => f.id === req.params.id && f.userId === req.userId);
    if (!rec) throw httpError(404, 'Файл не найден');
    // переименование зашифровано на клиенте — сюда прилетают новые attrsEncrypted/attrsIv
    if (req.body.attrsEncrypted) rec.attrsEncrypted = req.body.attrsEncrypted;
    if (req.body.attrsIv) rec.attrsIv = req.body.attrsIv;
    if ('folderId' in req.body) {
      const target = req.body.folderId || null;
      if (target && !db.folders.find(f => f.id === target && f.userId === req.userId && !f.deleted)) {
        throw httpError(404, 'Папка назначения не найдена');
      }
      rec.folderId = target;
    }
    if ('deleted' in req.body) {
      rec.deleted = !!req.body.deleted;
      // deletedAt — точка отсчёта для автоочистки корзины
      rec.deletedAt = rec.deleted ? Date.now() : null;
    }
    return rec;
  });
  res.json(file);
}));

app.delete('/api/files/:id', authMiddleware, asyncHandler(async (req, res) => {
  await withDb((db) => {
    const file = db.files.find(f => f.id === req.params.id && f.userId === req.userId);
    if (!file) throw httpError(404, 'Файл не найден');
    hardDeleteFiles(db, [file]);
  });
  res.json({ ok: true });
}));

// ===================== RUBBISH BIN =====================

app.get('/api/rubbish', authMiddleware, asyncHandler(async (req, res) => {
  const db = readDb();
  const folders = db.folders.filter(f => f.userId === req.userId && f.deleted);
  const files = db.files.filter(f => f.userId === req.userId && f.deleted);
  res.json({ folders, files, size: trashedBytes(db, req.userId), trashTtlDays: TRASH_TTL_DAYS });
}));

// Очистка корзины целиком: записи, блобы, публичные ссылки. Папки удаляются
// вместе с содержимым — внутри них могут лежать файлы, которые сами по себе
// как удалённые не помечались.
app.post('/api/rubbish/empty', authMiddleware, asyncHandler(async (req, res) => {
  const removed = await withDb((db) => {
    const files = db.files.filter(f => f.userId === req.userId && f.deleted);
    const folders = db.folders.filter(f => f.userId === req.userId && f.deleted);
    const freed = files.reduce((sum, f) => sum + f.size, 0);
    hardDeleteFiles(db, files);
    for (const folder of folders) hardDeleteFolderTree(db, req.userId, folder.id);
    return { files: files.length, folders: folders.length, freed };
  });
  res.json({ ok: true, ...removed });
}));

// ===================== SHARES =====================
// Сырой ключ файла сюда НЕ передаётся и не хранится.
//
// Режим без пароля: ключ остаётся у клиента и попадает во фрагмент ссылки
// (#...), который браузер не отправляет на сервер.
// Режим с паролем: ключ файла оборачивается ключом, выведенным из пароля
// (PBKDF2 на клиенте), и на сервер приходит уже обёрнутым — расшифровать его
// без пароля нельзя, а ссылка при этом ключа не содержит вовсе. Дополнительно
// клиент присылает "верификатор" (вторая половина того же PBKDF2-вывода);
// сервер хранит только его SHA-256 и по нему пускает к обёртке и к байтам.

const SHARE_LIMITS = { salt: 64, keyWrapped: 128, keyWrapIv: 32, verifier: 128 };
const UNLOCK_MAX_ATTEMPTS = 10;
const UNLOCK_WINDOW_MS = 5 * 60 * 1000;
const unlockAttempts = new Map(); // publicId -> { count, resetAt }

const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// Ограничиваем онлайн-перебор пароля по ссылке (офлайн-перебор тем, у кого на
// руках db.json, этим не остановить — об этом честно сказано в README).
function checkUnlockRate(publicId) {
  const now = Date.now();
  if (unlockAttempts.size > 500) {
    for (const [key, rec] of unlockAttempts) if (now > rec.resetAt) unlockAttempts.delete(key);
  }
  const rec = unlockAttempts.get(publicId);
  if (!rec || now > rec.resetAt) {
    unlockAttempts.set(publicId, { count: 1, resetAt: now + UNLOCK_WINDOW_MS });
    return;
  }
  rec.count += 1;
  if (rec.count > UNLOCK_MAX_ATTEMPTS) {
    throw httpError(429, 'Слишком много попыток ввода пароля — подождите несколько минут');
  }
}

function verifierMatches(share, verifier) {
  if (!share.password) return true;
  if (!verifier) return false;
  const expected = Buffer.from(share.password.verifierHash, 'hex');
  const actual = Buffer.from(sha256Hex(verifier), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Из присланного клиентом объекта в запись БД попадает всё, кроме верификатора:
// вместо него храним хэш, чтобы утечка db.json не давала доступ к обёртке.
function normalizeSharePassword(input) {
  if (!input) return null;
  const { salt, keyWrapped, keyWrapIv, verifier } = input;
  if (!salt || !keyWrapped || !keyWrapIv || !verifier) {
    throw httpError(400, 'Некорректные данные пароля для ссылки');
  }
  for (const [field, value] of Object.entries({ salt, keyWrapped, keyWrapIv, verifier })) {
    if (typeof value !== 'string' || value.length > SHARE_LIMITS[field]) {
      throw httpError(400, 'Некорректные данные пароля для ссылки');
    }
  }
  return { salt, keyWrapped, keyWrapIv, verifierHash: sha256Hex(verifier) };
}

// Пропущенное поле означает «оставить как было»: модалка настроек не знает
// пароля уже защищённой ссылки и не смогла бы прислать его заново, а срок
// хранится абсолютным моментом и в «часах до истечения» не восстанавливается.
// Явный null (или пустая строка) — снять ограничение.
function parseShareSettings(body) {
  const { ttlHours, maxDownloads, password } = body || {};
  const settings = {};
  if (ttlHours !== undefined) {
    if (ttlHours === null || ttlHours === '') {
      settings.expiresAt = null;
    } else {
      const hours = Number(ttlHours);
      if (!Number.isFinite(hours) || hours <= 0) throw httpError(400, 'Некорректный срок действия ссылки');
      settings.expiresAt = Date.now() + hours * 60 * 60 * 1000;
    }
  }
  if (maxDownloads !== undefined) {
    if (maxDownloads === null || maxDownloads === '') {
      settings.maxDownloads = null;
    } else {
      const value = Number(maxDownloads);
      if (!Number.isInteger(value) || value < 1) throw httpError(400, 'Лимит скачиваний должен быть целым числом от 1');
      settings.maxDownloads = value;
    }
  }
  if (password !== undefined) settings.password = normalizeSharePassword(password);
  return settings;
}

const shareInfo = (share) => ({
  publicId: share.publicId,
  expiresAt: share.expiresAt || null,
  maxDownloads: share.maxDownloads || null,
  downloads: share.downloads || 0,
  requiresPassword: !!share.password,
});

// Находит живую ссылку или бросает понятную ошибку (не найдена / файл удалён /
// срок истёк / лимит исчерпан).
function resolveShare(db, publicId) {
  const share = db.shares.find(s => s.publicId === publicId);
  if (!share) throw httpError(404, 'Ссылка не найдена');
  const file = db.files.find(f => f.id === share.fileId && !f.deleted);
  if (!file) throw httpError(404, 'Файл больше недоступен');
  if (share.expiresAt && Date.now() > share.expiresAt) throw httpError(410, 'Срок действия ссылки истёк');
  if (share.maxDownloads && (share.downloads || 0) >= share.maxDownloads) {
    throw httpError(410, 'Лимит скачиваний исчерпан');
  }
  return { share, file };
}

app.post('/api/files/:id/share', authMiddleware, asyncHandler(async (req, res) => {
  const settings = parseShareSettings(req.body);
  const share = await withDb((db) => {
    const file = db.files.find(f => f.id === req.params.id && f.userId === req.userId);
    if (!file) throw httpError(404, 'Файл не найден');
    let rec = db.shares.find(s => s.fileId === file.id);
    if (!rec) {
      rec = {
        publicId: uuidv4(),
        fileId: file.id,
        createdAt: Date.now(),
        downloads: 0,
        expiresAt: null,
        maxDownloads: null,
        password: null,
      };
      db.shares.push(rec);
    }
    if ('maxDownloads' in settings && (rec.maxDownloads || null) !== settings.maxDownloads) {
      // лимит изменили — счётчик начинаем заново, иначе ссылка, уже упёршаяся
      // в старый лимит, осталась бы мёртвой при попытке его поднять
      rec.downloads = 0;
    }
    if ('expiresAt' in settings) rec.expiresAt = settings.expiresAt;
    if ('maxDownloads' in settings) rec.maxDownloads = settings.maxDownloads;
    if ('password' in settings) rec.password = settings.password;
    return rec;
  });
  res.json(shareInfo(share));
}));

// Текущие настройки ссылки владельцу файла (без секретов).
app.get('/api/files/:id/share', authMiddleware, asyncHandler(async (req, res) => {
  const db = readDb();
  const file = db.files.find(f => f.id === req.params.id && f.userId === req.userId);
  if (!file) return res.status(404).json({ error: 'Файл не найден' });
  const share = db.shares.find(s => s.fileId === file.id);
  if (!share) return res.status(404).json({ error: 'Ссылка не найдена' });
  res.json(shareInfo(share));
}));

app.delete('/api/files/:id/share', authMiddleware, asyncHandler(async (req, res) => {
  await withDb((db) => {
    const file = db.files.find(f => f.id === req.params.id && f.userId === req.userId);
    if (!file) throw httpError(404, 'Файл не найден');
    db.shares = db.shares.filter(s => s.fileId !== file.id);
  });
  res.json({ ok: true });
}));

// Публичные эндпоинты — без авторизации, для страницы share.html
app.get('/api/share/:publicId/meta', asyncHandler(async (req, res) => {
  const db = readDb();
  const { share, file } = resolveShare(db, req.params.publicId);
  res.json({
    size: file.size,
    contentIv: file.contentIv,
    attrsEncrypted: file.attrsEncrypted,
    attrsIv: file.attrsIv,
    expiresAt: share.expiresAt || null,
    maxDownloads: share.maxDownloads || null,
    downloads: share.downloads || 0,
    requiresPassword: !!share.password,
    // соль публична по своей природе — она нужна, чтобы вывести ключ из пароля.
    // Саму обёртку ключа здесь НЕ отдаём: только после проверки пароля в /unlock.
    passwordSalt: share.password ? share.password.salt : null,
  });
}));

// Обмен "верификатора" (доказательства знания пароля) на обёрнутый ключ файла.
app.post('/api/share/:publicId/unlock', asyncHandler(async (req, res) => {
  const { verifier } = req.body || {};
  const db = readDb();
  const { share } = resolveShare(db, req.params.publicId);
  if (!share.password) return res.status(400).json({ error: 'Эта ссылка не защищена паролем' });
  checkUnlockRate(share.publicId);
  if (!verifierMatches(share, verifier)) return res.status(401).json({ error: 'Неверный пароль' });
  unlockAttempts.delete(share.publicId);
  res.json({ keyWrapped: share.password.keyWrapped, keyWrapIv: share.password.keyWrapIv });
}));

app.get('/api/share/:publicId/download', asyncHandler(async (req, res) => {
  // Счётчик увеличиваем до отправки байтов. Оборванная закачка тоже расходует
  // лимит — иначе его можно было бы обойти, обрывая соединение.
  const { file } = await withDb((db) => {
    const resolved = resolveShare(db, req.params.publicId);
    if (resolved.share.password && !verifierMatches(resolved.share, req.headers['x-share-verifier'])) {
      throw httpError(401, 'Требуется пароль для скачивания');
    }
    resolved.share.downloads = (resolved.share.downloads || 0) + 1;
    return resolved;
  });
  const filePath = path.join(STORAGE_DIR, file.storedName);
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'Содержимое файла отсутствует на диске' });
  res.sendFile(filePath);
}));

// ===================== WEBAUTHN (биометрия) =====================
// Challenges — временные, живут только в памяти процесса (не переживают
// перезапуск сервера, что абсолютно нормально для сессии из нескольких секунд).
const regChallenges = new Map(); // userId -> challenge
const loginChallenges = new Map(); // challengeId -> { challenge, userId } (userId=null — вход без логина)

// Фиксированная "соль" для PRF-расширения WebAuthn. Не секрет — это просто
// доменный разделитель, чтобы PRF-вывод этого приложения не совпадал с
// PRF-выводом какого-то другого сайта на том же ключе устройства.
const PRF_SALT_B64URL = Buffer.from('vaultly-master-key-unlock-v1').toString('base64url');
app.get('/api/webauthn/prf-salt', (req, res) => res.json({ salt: PRF_SALT_B64URL }));

app.post('/api/webauthn/register-options', authMiddleware, asyncHandler(async (req, res) => {
  const db = readDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const existing = db.webauthnCredentials.filter(c => c.userId === user.id);
  const options = await generateRegistrationOptions({
    rpName: 'Vaultly',
    rpID: getRpID(req),
    userName: user.username,
    userDisplayName: user.username, // подпись аккаунта в системном списке ключей доступа
    userID: Buffer.from(user.id, 'utf8'),
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: {
      // residentKey: 'required' — ключ хранится НА устройстве вместе с userHandle,
      // поэтому при входе браузер сам подставляет аккаунт и логин вводить не нужно.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    },
    // credProps — чтобы узнать, действительно ли ключ получился discoverable
    extensions: { prf: {}, credProps: true },
  });
  regChallenges.set(user.id, options.challenge);
  res.json(options);
}));

app.post('/api/webauthn/register-verify', authMiddleware, asyncHandler(async (req, res) => {
  const { attestationResponse, deviceLabel } = req.body || {};
  const db = readDb();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const expectedChallenge = regChallenges.get(user.id);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Запрос на регистрацию устарел, попробуйте ещё раз' });
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: attestationResponse,
      expectedChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpID(req),
    });
  } catch (e) {
    regChallenges.delete(user.id);
    return res.status(400).json({ error: 'Не удалось подтвердить биометрический ключ: ' + e.message });
  }
  regChallenges.delete(user.id);
  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'Не удалось подтвердить биометрический ключ' });
  }
  const { credential } = verification.registrationInfo;
  // rk === false означает, что аутентификатор сохранил ключ не на себе —
  // тогда вход без логина через этот ключ невозможен (нужен allowCredentials).
  const rk = attestationResponse?.clientExtensionResults?.credProps?.rk;
  await withDb((tx) => {
    tx.webauthnCredentials.push({
      id: credential.id,
      userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: credential.transports || [],
      deviceLabel: (deviceLabel || 'Это устройство').slice(0, 60),
      discoverable: rk !== false,
      wrappedMasterKey: null,
      createdAt: Date.now(),
    });
  });
  res.json({ ok: true, credentialId: credential.id });
}));

// Сохраняем обёрнутый (зашифрованным на клиенте PRF-секретом) мастер-ключ
// для конкретного credential — это то, что позволяет следующему входу
// пройти вообще без пароля.
app.post('/api/webauthn/wrap-key', authMiddleware, asyncHandler(async (req, res) => {
  const { credentialId, wrappedMasterKey } = req.body || {};
  if (!credentialId || !wrappedMasterKey?.data || !wrappedMasterKey?.iv) {
    return res.status(400).json({ error: 'Некорректные данные' });
  }
  await withDb((db) => {
    const cred = db.webauthnCredentials.find(c => c.id === credentialId && c.userId === req.userId);
    if (!cred) throw httpError(404, 'Ключ доступа не найден');
    cred.wrappedMasterKey = wrappedMasterKey;
  });
  res.json({ ok: true });
}));

app.get('/api/webauthn/credentials', authMiddleware, asyncHandler(async (req, res) => {
  const db = readDb();
  const list = db.webauthnCredentials
    .filter(c => c.userId === req.userId)
    .map(c => ({ id: c.id, deviceLabel: c.deviceLabel, createdAt: c.createdAt, passwordless: !!c.wrappedMasterKey, discoverable: c.discoverable !== false }));
  res.json({ credentials: list });
}));

app.delete('/api/webauthn/credentials/:id', authMiddleware, asyncHandler(async (req, res) => {
  await withDb((db) => {
    db.webauthnCredentials = db.webauthnCredentials.filter(c => !(c.id === req.params.id && c.userId === req.userId));
  });
  res.json({ ok: true });
}));

// Вход по биометрии — без обычной авторизации (это ей на замену).
// Логин указывать НЕ нужно: ключ доступа discoverable, аутентификатор сам хранит
// userHandle и сообщает его при подписи. Логин принимается только как fallback
// для ключей, зарегистрированных до перехода на resident keys.
app.post('/api/webauthn/login-options', asyncHandler(async (req, res) => {
  const { username } = req.body || {};
  const db = readDb();

  let userId = null;
  let allowCredentials;
  if (username) {
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const creds = db.webauthnCredentials.filter(c => c.userId === user.id && c.wrappedMasterKey);
    if (!creds.length) {
      return res.status(404).json({ error: 'Для этого аккаунта не настроен беспарольный вход на этом или другом устройстве' });
    }
    userId = user.id;
    allowCredentials = creds.map(c => ({ id: c.id, transports: c.transports }));
  } else {
    // Беспарольный режим без логина: allowCredentials не передаём вовсе —
    // браузер сам покажет ключи доступа, сохранённые на этом устройстве.
    if (!db.webauthnCredentials.some(c => c.wrappedMasterKey)) {
      return res.status(404).json({ error: 'На сервере нет ни одного ключа доступа для беспарольного входа — включите биометрию после входа паролем' });
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpID(req),
    userVerification: 'required',
    ...(allowCredentials ? { allowCredentials } : {}),
    extensions: { prf: { eval: { first: PRF_SALT_B64URL } } },
  });
  const challengeId = uuidv4();
  loginChallenges.set(challengeId, { challenge: options.challenge, userId });
  // unref: challenge живёт в памяти, и таймер его уборки не должен держать
  // процесс живым (иначе тесты висели бы после последней проверки ещё 5 минут)
  setTimeout(() => loginChallenges.delete(challengeId), 5 * 60 * 1000).unref();
  res.json({ options, challengeId });
}));

app.post('/api/webauthn/login-verify', asyncHandler(async (req, res) => {
  const { assertionResponse, challengeId } = req.body || {};
  if (!assertionResponse?.id) return res.status(400).json({ error: 'Некорректные данные' });
  const pending = loginChallenges.get(challengeId);
  if (!pending) return res.status(400).json({ error: 'Запрос на вход устарел, попробуйте ещё раз' });
  const db = readDb();

  // Кто именно вошёл: при входе с логином — пользователь из challenge,
  // при входе без логина — userHandle, который аутентификатор вернул вместе
  // с подписью (мы кладём туда user.id при регистрации ключа).
  let userId = pending.userId;
  if (!userId) {
    const handle = assertionResponse?.response?.userHandle;
    if (!handle) {
      loginChallenges.delete(challengeId);
      return res.status(400).json({ error: 'Устройство не сообщило, какой это аккаунт — введите логин и попробуйте снова' });
    }
    userId = Buffer.from(handle, 'base64url').toString('utf8');
  }

  const cred = db.webauthnCredentials.find(c => c.id === assertionResponse.id && c.userId === userId);
  if (!cred) return res.status(404).json({ error: 'Ключ доступа не найден' });
  if (!cred.wrappedMasterKey) {
    return res.status(400).json({ error: 'На этом ключе доступа не настроен беспарольный вход — войдите паролем' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge: pending.challenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpID(req),
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey, 'base64'),
        counter: cred.counter,
        transports: cred.transports,
      },
    });
  } catch (e) {
    loginChallenges.delete(challengeId);
    return res.status(400).json({ error: 'Не удалось подтвердить вход: ' + e.message });
  }
  loginChallenges.delete(challengeId);
  if (!verification.verified) return res.status(400).json({ error: 'Не удалось подтвердить вход' });

  cred.counter = verification.authenticationInfo.newCounter;
  await withDb((tx) => {
    const stored = tx.webauthnCredentials.find(c => c.id === cred.id && c.userId === userId);
    if (stored) stored.counter = verification.authenticationInfo.newCounter;
  });

  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    username: user.username,
    kdfSalt: user.kdfSalt,
    wrappedMasterKey: cred.wrappedMasterKey,
  });
}));

// ---------- автоочистка корзины ----------
if (TRASH_TTL_DAYS > 0) {
  purgeExpiredTrash().catch(e => console.error('Не удалось очистить корзину при старте:', e));
  const sweep = setInterval(() => {
    purgeExpiredTrash().catch(e => console.error('Не удалось очистить корзину:', e));
  }, TRASH_SWEEP_INTERVAL_MS);
  // таймер не должен держать процесс живым (иначе тесты не завершаются)
  sweep.unref();
}

// Запускаем сервер только при прямом вызове (`node server.js`), чтобы тесты
// могли импортировать приложение и поднять его на случайном порту.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Vaultly server запущен: http://localhost:${PORT}`);
  });
}

module.exports = { app, purgeExpiredTrash };
