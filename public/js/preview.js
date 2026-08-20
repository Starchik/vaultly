/**
 * Предпросмотр медиа.
 *
 * Файл зашифрован AES-GCM целиком, одним буфером, поэтому «стримить» его прямо
 * в <video> нельзя: сначала скачиваем и расшифровываем полностью, потом отдаём
 * тегу через blob: URL. Для больших файлов спрашиваем подтверждение — иначе
 * браузер молча съест сотни мегабайт памяти.
 *
 * Использует глобальные icon() (icons.js), API, VLT, а также toast(), fmtSize()
 * и confirmModal() из app.js — файлы всегда подключаются вместе.
 */
const PREVIEW = (() => {
  const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'];
  // только то, что браузеры действительно играют: mkv/avi/wmv в <video> не откроются
  const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'ogv', 'mov'];
  const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus'];

  // attrs.type у файла может быть пустым (браузер не всегда определяет тип при
  // выборе), поэтому держим таблицу-подсказку по расширению
  const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
    ico: 'image/x-icon',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg',
  };

  const BIG_FILE = 200 * 1024 * 1024; // порог «спросить перед скачиванием целиком»

  let root = null;      // корень оверлея
  let blobUrl = null;   // текущий blob: URL — обязательно освобождаем при закрытии
  let keyHandler = null;

  const ext = (name) => (String(name).split('.').pop() || '').toLowerCase();
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

  function mimeFor(name, type) {
    return type || MIME_BY_EXT[ext(name)] || 'application/octet-stream';
  }

  // 'image' | 'video' | 'audio' | null — null значит «показывать нечем, качаем»
  function kindOf(name, type) {
    const mime = (type || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    const e = ext(name);
    if (IMAGE_EXT.includes(e)) return 'image';
    if (VIDEO_EXT.includes(e)) return 'video';
    if (AUDIO_EXT.includes(e)) return 'audio';
    return null;
  }

  function close() {
    if (!root) return;
    // Сначала останавливаем воспроизведение и рвём связь с blob-ом: иначе видео
    // продолжит играть в фоне, а память под расшифрованный файл не освободится.
    root.querySelectorAll('video, audio').forEach(el => {
      try { el.pause(); } catch (e) {}
      el.removeAttribute('src');
      el.load();
    });
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    root.remove();
    root = null;
  }

  function shell(name, onDownload) {
    close();
    root = document.createElement('div');
    root.className = 'preview-backdrop';
    root.innerHTML = `
      <div class="preview-box">
        <div class="preview-head">
          <span class="preview-name">${esc(name)}</span>
          <button class="btn btn-ghost preview-act" id="pvDownload" title="Скачать">${icon('download', 'icon-sm')}<span class="btn-label"> Скачать</span></button>
          <button class="btn btn-ghost preview-act" id="pvClose" title="Закрыть">${icon('x', 'icon-sm')}</button>
        </div>
        <div class="preview-body" id="pvBody"><div class="preview-note">${icon('lock', 'icon-lg')}<span>Расшифровка…</span></div></div>
      </div>`;
    document.body.appendChild(root);
    root.onclick = (e) => { if (e.target === root) close(); };
    root.querySelector('#pvClose').onclick = close;
    root.querySelector('#pvDownload').onclick = () => { if (onDownload) onDownload(); };
    keyHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', keyHandler);
    return root.querySelector('#pvBody');
  }

  function note(body, text, isError) {
    body.innerHTML = `<div class="preview-note${isError ? ' error' : ''}">${icon(isError ? 'x' : 'eye', 'icon-lg')}<span>${esc(text)}</span></div>`;
  }

  /**
   * opts: { file, name, type, fileKey, onDownload }
   * file — запись из списка (нужны id, size, contentIv), fileKey — уже
   * развёрнутый ключ файла (сервер его не видит).
   */
  async function open(opts) {
    const { file, name, type, fileKey, onDownload } = opts;
    const kind = kindOf(name, type);
    if (!kind || !fileKey) { if (onDownload) onDownload(); return; }

    if (file.size > BIG_FILE) {
      const ok = await confirmModal({
        icon: 'eye',
        title: 'Большой файл',
        text: `«${name}» весит ${fmtSize(file.size)}. Для предпросмотра его придётся скачать и расшифровать целиком — это займёт время и память браузера.`,
        okLabel: 'Всё равно открыть',
      });
      if (!ok) return;
    }

    const body = shell(name, onDownload);
    try {
      const buf = await API.downloadFile(file.id);
      const plain = await VLT.decryptBuffer(fileKey, VLT.b64.toBuf(file.contentIv), buf);
      if (!root) return; // успели закрыть, пока качали
      blobUrl = URL.createObjectURL(new Blob([plain], { type: mimeFor(name, type) }));

      let el;
      if (kind === 'image') {
        el = document.createElement('img');
      } else {
        el = document.createElement(kind === 'video' ? 'video' : 'audio');
        el.controls = true;
        el.autoplay = true;
      }
      el.className = 'preview-media';
      // Кодек может не поддерживаться (например, .mov с HEVC) — тогда честно
      // говорим об этом и оставляем кнопку «Скачать».
      el.onerror = () => note(body, 'Браузер не смог открыть этот файл — попробуйте скачать его', true);
      el.src = blobUrl;
      body.innerHTML = '';
      body.appendChild(el);
    } catch (e) {
      note(body, 'Не удалось открыть: ' + e.message, true);
    }
  }

  return { open, close, kindOf };
})();

window.PREVIEW = PREVIEW;
