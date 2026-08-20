function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[i];
}
function extIconName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image',
    mp4: 'video', mov: 'video', mkv: 'video', avi: 'video',
    mp3: 'audio', wav: 'audio', flac: 'audio',
    pdf: 'pdf', doc: 'file', docx: 'file', xls: 'sheet', xlsx: 'sheet', ppt: 'slides', pptx: 'slides',
    zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
    txt: 'code', md: 'code', json: 'code', csv: 'sheet',
  };
  return map[ext] || 'package';
}

function showState(name) {
  ['stateLoading', 'statePassword', 'stateReady', 'stateError'].forEach(id => {
    document.getElementById(id).style.display = id === name ? 'block' : 'none';
  });
}

function fail(text) {
  document.getElementById('errText').textContent = text;
  showState('stateError');
}

// Срок и лимит сервер проверяет сам, здесь только человеческие формулировки.
function describeError(e, fallback) {
  if (e.status === 404) return 'Ссылка не найдена или была отключена владельцем';
  if (e.status === 410) return e.message;              // «Срок действия истёк» / «Лимит исчерпан»
  return fallback + e.message;
}

// Верификатор пароля нужен и для скачивания, поэтому держим его рядом с ключом.
let shareVerifier = null;

async function main() {
  // формат фрагмента: #<publicId>!<base64url fileKey> — либо просто
  // #<publicId>, если ссылка под паролем (тогда ключ обёрнут и лежит на сервере)
  const frag = location.hash.slice(1);
  const [publicId, keyB64Url] = frag.split('!');
  if (!publicId) { fail('Ссылка повреждена или неполная'); return; }

  let meta;
  try {
    meta = await API.shareMeta(publicId);
  } catch (e) {
    fail(describeError(e, 'Не удалось загрузить файл: '));
    return;
  }

  if (meta.requiresPassword) {
    askPassword(publicId, meta);
    return;
  }

  if (!keyB64Url) { fail('В ссылке нет ключа расшифровки — вероятно, она скопирована не полностью'); return; }
  let fileKey;
  try {
    fileKey = await VLT.importKeyRaw(VLT.b64.toBufUrl(keyB64Url));
  } catch (e) {
    fail('Ключ в ссылке испорчен');
    return;
  }
  await showFile(publicId, meta, fileKey);
}

function askPassword(publicId, meta) {
  const input = document.getElementById('pwInput');
  const btn = document.getElementById('pwBtn');
  const errEl = document.getElementById('pwError');
  showState('statePassword');
  input.focus();

  const submit = async () => {
    const password = input.value;
    if (!password) return;
    errEl.style.display = 'none';
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.innerHTML = `${icon('lock', 'icon-sm')} Проверяем…`;
    try {
      // Пароль остаётся здесь: на сервер уходит только верификатор — вторая
      // половина PBKDF2-вывода, по которой ключ обёртки не восстановить.
      const { wrapKey, verifier } = await VLT.deriveShareSecrets(password, meta.passwordSalt);
      const wrapped = await API.shareUnlock(publicId, verifier);
      const fileKey = await VLT.unwrapFileKey(wrapKey, wrapped.keyWrapped, wrapped.keyWrapIv);
      shareVerifier = verifier;
      await showFile(publicId, meta, fileKey);
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = label;
      input.select();
      if (e.status === 401) errEl.textContent = 'Неверный пароль';
      else if (e.status === 429) errEl.textContent = e.message; // слишком много попыток
      else if (e.status === 410 || e.status === 404) { fail(describeError(e, '')); return; }
      else errEl.textContent = 'Не удалось открыть: ' + e.message;
      errEl.style.display = 'block';
    }
  };

  btn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

async function showFile(publicId, meta, fileKey) {
  let attrs;
  try {
    attrs = await VLT.decryptJson(fileKey, meta.attrsEncrypted, meta.attrsIv);
  } catch (e) {
    fail('Не удалось расшифровать метаданные — ключ не подходит к этому файлу');
    return;
  }

  document.getElementById('fileIcon').innerHTML = icon(extIconName(attrs.name), 'icon-xl');
  document.getElementById('fileName').textContent = attrs.name;
  document.getElementById('fileSize').textContent = fmtSize(meta.size);

  const limits = [];
  if (meta.maxDownloads) limits.push(`осталось скачиваний: ${Math.max(0, meta.maxDownloads - meta.downloads)}`);
  if (meta.expiresAt) limits.push(`действует до ${new Date(meta.expiresAt).toLocaleString()}`);
  const limitsEl = document.getElementById('shareLimits');
  limitsEl.textContent = limits.join(' · ');
  limitsEl.style.display = limits.length ? 'block' : 'none';
  showState('stateReady');

  document.getElementById('downloadBtn').onclick = async () => {
    const btn = document.getElementById('downloadBtn');
    const progLine = document.getElementById('progLine');
    const progFill = document.getElementById('progFill');
    btn.disabled = true; btn.innerHTML = `${icon('download', 'icon-sm')} Скачивание…`;
    progLine.style.display = 'block'; progFill.style.width = '0%';
    try {
      // полоса идёт по фактически полученным байтам; остаток шкалы оставлен
      // на расшифровку, она начинается только после полной загрузки
      const buf = await API.shareDownload(publicId, shareVerifier, (ratio) => {
        progFill.style.width = (ratio * 92).toFixed(1) + '%';
      });
      const plain = await VLT.decryptBuffer(fileKey, VLT.b64.toBuf(meta.contentIv), buf);
      progFill.style.width = '100%';
      const blob = new Blob([plain], { type: attrs.type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = attrs.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      btn.innerHTML = `${icon('check', 'icon-sm')} Скачано`;
    } catch (e) {
      // Лимит мог закончиться, пока страница была открыта — тогда объясняем это,
      // а не предлагаем бессмысленно повторить попытку.
      if (e.status === 410 || e.status === 404) { fail(describeError(e, '')); return; }
      btn.innerHTML = `${icon('x', 'icon-sm')} Ошибка, попробовать снова`;
      btn.disabled = false;
      progLine.style.display = 'none';
    }
  };
}

main();
