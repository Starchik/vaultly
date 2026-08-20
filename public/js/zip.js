/**
 * Скачивание нескольких файлов или целой папки одним ZIP-архивом.
 *
 * Пишем формат руками, в режиме STORE (без сжатия): файлы уже зашифрованы, а
 * значит несжимаемы — DEFLATE только сжёг бы процессорное время. Zip64 не
 * поддерживаем, поэтому при объёме ≥ 4 ГБ честно отказываемся вместо того,
 * чтобы отдать битый архив.
 *
 * Использует глобальные icon() (icons.js), API, VLT, а также fmtSize(), toast()
 * и confirmModal() из app.js — файлы всегда подключаются вместе.
 */
const ZIP = (() => {
  const MAX_32 = 0xFFFFFFFF;                 // предел размеров без Zip64
  const MEM_WARN = 1.5 * 1024 * 1024 * 1024; // выше этого фолбэк «в память» опасен

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ZIP хранит время в формате MS-DOS: дата и время двумя 16-битными словами
  function dosStamp(ms) {
    const d = new Date(ms || Date.now());
    const year = Math.max(1980, d.getFullYear());
    return {
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    };
  }

  class ZipWriter {
    constructor(sink) { this.sink = sink; this.offset = 0; this.entries = []; }

    async put(bytes) {
      await this.sink.write(bytes);
      this.offset += bytes.length;
    }

    // name — путь внутри архива ('папка/файл.txt'), у каталога с '/' на конце
    async add(name, data, mtime, isDir) {
      const nameBytes = new TextEncoder().encode(name);
      const body = data || new Uint8Array(0);
      const crc = isDir ? 0 : crc32(body);
      const stamp = dosStamp(mtime);
      const headerOffset = this.offset;

      const head = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(head.buffer);
      dv.setUint32(0, 0x04034b50, true); // local file header
      dv.setUint16(4, 20, true);         // версия 2.0 — большего STORE не требует
      dv.setUint16(6, 0x0800, true);     // бит 11: имя в UTF-8
      dv.setUint16(8, 0, true);          // метод 0 = STORE
      dv.setUint16(10, stamp.time, true);
      dv.setUint16(12, stamp.date, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, body.length, true);
      dv.setUint32(22, body.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);         // extra
      head.set(nameBytes, 30);
      await this.put(head);
      if (body.length) await this.put(body);

      this.entries.push({
        nameBytes, crc, size: body.length, headerOffset,
        date: stamp.date, time: stamp.time, isDir: !!isDir,
      });
    }

    async finish() {
      const cdStart = this.offset;
      for (const e of this.entries) {
        const cd = new Uint8Array(46 + e.nameBytes.length);
        const dv = new DataView(cd.buffer);
        dv.setUint32(0, 0x02014b50, true); // central directory header
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 20, true);
        dv.setUint16(8, 0x0800, true);
        dv.setUint16(10, 0, true);
        dv.setUint16(12, e.time, true);
        dv.setUint16(14, e.date, true);
        dv.setUint32(16, e.crc, true);
        dv.setUint32(20, e.size, true);
        dv.setUint32(24, e.size, true);
        dv.setUint16(28, e.nameBytes.length, true);
        dv.setUint16(30, 0, true);        // extra
        dv.setUint16(32, 0, true);        // комментарий
        dv.setUint16(34, 0, true);        // номер диска
        dv.setUint16(36, 0, true);        // внутренние атрибуты
        dv.setUint32(38, e.isDir ? 0x10 : 0, true); // внешние: бит каталога
        dv.setUint32(42, e.headerOffset, true);
        cd.set(e.nameBytes, 46);
        await this.put(cd);
      }
      const eocd = new Uint8Array(22);
      const dv = new DataView(eocd.buffer);
      dv.setUint32(0, 0x06054b50, true); // end of central directory
      dv.setUint16(4, 0, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, this.entries.length, true);
      dv.setUint16(10, this.entries.length, true);
      dv.setUint32(12, this.offset - cdStart, true);
      dv.setUint32(16, cdStart, true);
      dv.setUint16(20, 0, true);
      await this.put(eocd);
      await this.sink.close();
    }
  }

  // ---------- имена ----------
  // Разделители пути разрезали бы структуру архива, остальное ломает
  // распаковщики и файловые системы; точки и пробелы в конце Windows отбрасывает.
  const BAD_CHARS = new RegExp('[\\\\/:*?"<>|\\u0000-\\u001f]', 'g');

  function safeName(name) {
    const cleaned = String(name || 'file').replace(BAD_CHARS, '_').replace(/[. ]+$/, '');
    return cleaned || 'file';
  }

  function uniqueName(used, name) {
    const base = safeName(name);
    if (!used.has(base.toLowerCase())) { used.add(base.toLowerCase()); return base; }
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let i = 2; ; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!used.has(candidate.toLowerCase())) { used.add(candidate.toLowerCase()); return candidate; }
    }
  }

  // ---------- сбор дерева ----------
  async function collectFolder(folderId, prefix, out, resolveMeta) {
    const res = await API.listFolder(folderId);
    const used = new Set();
    for (const file of res.files) {
      const meta = await resolveMeta(file);
      const name = uniqueName(used, meta && meta.name);
      out.push({ path: prefix + name, file, fileKey: meta && meta.fileKey, size: file.size });
    }
    for (const folder of res.folders) {
      const name = uniqueName(used, folder.name);
      // Каталог записываем отдельной записью — иначе пустые папки исчезнут
      out.push({ path: prefix + name + '/', dir: true, mtime: folder.createdAt, size: 0 });
      await collectFolder(folder.id, prefix + name + '/', out, resolveMeta);
    }
  }

  // ---------- прогресс ----------
  function panel(title) {
    const host = document.getElementById('uploadPanel');
    host.innerHTML = `<div class="upload-panel"><h4>${icon('archive', 'icon-sm')} ${title}</h4>
      <div class="upload-item"><div class="fname"><span id="zipName">Готовим список файлов…</span><span id="zipCount"></span></div>
      <div class="progress-line"><div class="progress-fill" id="zipFill"></div></div></div></div>`;
    const $ = (id) => document.getElementById(id);
    return {
      step(name, done, total) {
        if (!$('zipName')) return;
        $('zipName').textContent = name;
        $('zipCount').textContent = `${done} из ${total}`;
        $('zipFill').style.width = (total ? (done / total) * 100 : 0).toFixed(1) + '%';
      },
      hide(delay = 2500) { setTimeout(() => { host.innerHTML = ''; }, delay); },
    };
  }

  // ---------- куда писать ----------
  async function openSink(fileName, totalBytes) {
    // File System Access API пишет прямо на диск, не держа архив в памяти.
    // Он требует «свежего» жеста пользователя, а мы до этого успели сходить по
    // сети за списком файлов, поэтому отказ здесь нормален — уходим в фолбэк.
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'ZIP-архив', accept: { 'application/zip': ['.zip'] } }],
        });
        const stream = await handle.createWritable();
        return { streaming: true, write: (b) => stream.write(b), close: () => stream.close() };
      } catch (e) {
        if (e.name === 'AbortError') throw e; // пользователь сам отменил — не подменяем
      }
    }
    if (totalBytes > MEM_WARN) {
      const ok = await confirmModal({
        icon: 'archive',
        title: 'Архив собирается в памяти',
        text: `Браузер не дал сохранить файл напрямую, поэтому архив (${fmtSize(totalBytes)}) будет собран в памяти. На слабом устройстве вкладка может не выдержать.`,
        okLabel: 'Продолжить',
      });
      if (!ok) { const err = new Error('отменено'); err.name = 'AbortError'; throw err; }
    }
    const chunks = [];
    return {
      streaming: false,
      write: (b) => { chunks.push(b.slice()); },
      close() {
        const url = URL.createObjectURL(new Blob(chunks, { type: 'application/zip' }));
        const a = document.createElement('a');
        a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      },
    };
  }

  /**
   * items: [{ kind: 'folder', id, name, createdAt } | { kind: 'file', file, name }]
   * resolveMeta(file) -> { name, type, fileKey } — расшифровка attrs живёт в app.js
   */
  async function save(items, archiveName, resolveMeta) {
    const ui = panel('Сборка архива');
    try {
      const entries = [];
      const used = new Set();
      for (const it of items) {
        if (it.kind === 'folder') {
          const name = uniqueName(used, it.name);
          entries.push({ path: name + '/', dir: true, mtime: it.createdAt, size: 0 });
          await collectFolder(it.id, name + '/', entries, resolveMeta);
        } else {
          const meta = await resolveMeta(it.file);
          const name = uniqueName(used, (meta && meta.name) || it.name);
          entries.push({ path: name, file: it.file, fileKey: meta && meta.fileKey, size: it.file.size });
        }
      }

      const files = entries.filter(e => !e.dir);
      if (!files.length) { toast('Нечего архивировать: файлов не найдено', 'err'); ui.hide(0); return; }

      // Без Zip64 в заголовках нет места на размеры больше 4 ГБ — ни на файл,
      // ни на архив целиком. Проверяем до начала, чтобы не отдать битый ZIP.
      const total = entries.reduce((sum, e) => sum + e.size + 100 + e.path.length * 3, 0);
      if (total >= MAX_32 || files.some(e => e.size >= MAX_32)) {
        toast('Архив вышел бы больше 4 ГБ — такой ZIP не поддерживается, скачайте файлы по отдельности', 'err');
        ui.hide(0);
        return;
      }

      const sink = await openSink(archiveName, total);
      const writer = new ZipWriter(sink);
      let done = 0;
      for (const e of entries) {
        if (e.dir) { await writer.add(e.path, null, e.mtime, true); continue; }
        ui.step(e.path, done, files.length);
        if (!e.fileKey) throw new Error(`не удалось расшифровать ключ файла «${e.path}»`);
        const buf = await API.downloadFile(e.file.id);
        const plain = await VLT.decryptBuffer(e.fileKey, VLT.b64.toBuf(e.file.contentIv), buf);
        await writer.add(e.path, new Uint8Array(plain), e.file.createdAt, false);
        done++;
        ui.step(e.path, done, files.length);
      }
      await writer.finish();
      toast(`Архив готов, файлов внутри: ${files.length}`);
      ui.hide();
    } catch (e) {
      ui.hide(0);
      if (e.name === 'AbortError') return; // отмена — не ошибка
      toast('Не удалось собрать архив: ' + e.message, 'err');
    }
  }

  return { save };
})();

window.ZIP = ZIP;
