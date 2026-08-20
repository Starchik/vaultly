/**
 * Криптография на стороне клиента.
 * Сервер никогда не получает пароль в открытом виде "для шифрования" и
 * никогда не получает мастер-ключ или ключи файлов — только зашифрованные
 * байты. Это принцип "zero-knowledge" шифрования — сервер в буквальном
 * смысле не может прочитать ваши файлы, даже если бы захотел.
 */
const VLT = {};

VLT.b64 = {
  fromBuf(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  },
  toBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  },
  // URL-safe вариант — для ключа во фрагменте ссылки
  fromBufUrl(buf) {
    return VLT.b64.fromBuf(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  toBufUrl(b64url) {
    let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return VLT.b64.toBuf(b64);
  },
};

// Вывод мастер-ключа пользователя из пароля (PBKDF2 -> AES-GCM key)
VLT.deriveMasterKey = async (password, saltHex) => {
  const enc = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
};

VLT.randomSaltHex = (bytes = 16) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * Пароль на публичной ссылке. Из одного PBKDF2-вывода (512 бит) получаем две
 * независимые половины:
 *   wrapKey  — первые 32 байта, AES-GCM-ключ. Им оборачивается ключ файла.
 *              Никогда не покидает браузер.
 *   verifier — последние 32 байта. Уходит на сервер как доказательство знания
 *              пароля; сервер хранит только его SHA-256, поэтому из БД ключ
 *              обёртки не вывести.
 * Итерации те же 150 000, что и у мастер-ключа: перебор слабого пароля по
 * украденной БД дорожает ровно во столько же раз.
 */
VLT.deriveShareSecrets = async (password, saltHex) => {
  const enc = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    baseKey,
    512
  );
  return {
    wrapKey: await VLT.importKeyRaw(bits.slice(0, 32)),
    verifier: VLT.b64.fromBuf(bits.slice(32)),
  };
};

VLT.generateFileKey = async () => {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
};

VLT.exportKeyRaw = async (key) => crypto.subtle.exportKey('raw', key);
VLT.importKeyRaw = async (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

VLT.encryptBuffer = async (key, buffer) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return { ciphertext, iv };
};

VLT.decryptBuffer = async (key, ivBuf, ciphertextBuf) => {
  const iv = new Uint8Array(ivBuf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertextBuf);
};

VLT.encryptJson = async (key, obj) => {
  const enc = new TextEncoder();
  const { ciphertext, iv } = await VLT.encryptBuffer(key, enc.encode(JSON.stringify(obj)));
  return { data: VLT.b64.fromBuf(ciphertext), iv: VLT.b64.fromBuf(iv) };
};

VLT.decryptJson = async (key, dataB64, ivB64) => {
  const plain = await VLT.decryptBuffer(key, VLT.b64.toBuf(ivB64), VLT.b64.toBuf(dataB64));
  return JSON.parse(new TextDecoder().decode(plain));
};

// "Оборачиваем" ключ файла мастер-ключом пользователя, чтобы хранить в своём
// облаке (нужен для показа списка файлов после логина без ссылки).
VLT.wrapFileKey = async (masterKey, fileKey) => {
  const raw = await VLT.exportKeyRaw(fileKey);
  const { ciphertext, iv } = await VLT.encryptBuffer(masterKey, raw);
  return { keyWrapped: VLT.b64.fromBuf(ciphertext), keyWrapIv: VLT.b64.fromBuf(iv) };
};

VLT.unwrapFileKey = async (masterKey, keyWrappedB64, keyWrapIvB64) => {
  const raw = await VLT.decryptBuffer(masterKey, VLT.b64.toBuf(keyWrapIvB64), VLT.b64.toBuf(keyWrappedB64));
  return VLT.importKeyRaw(raw);
};

window.VLT = VLT;
