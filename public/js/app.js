// ---------- сессия ----------
const token = sessionStorage.getItem('vlt_token');
const mkB64 = sessionStorage.getItem('vlt_mk');
if (!token || !mkB64) location.href = 'index.html';

let masterKey = null;
let currentFolderId = null;
let currentItems = { folders: [], files: [] };
let viewMode = 'grid';
let inRubbish = false;
let trashTtlDays = 0;   // сколько дней корзина хранит удалённое (0 = бессрочно)
const nameCache = new Map(); // fileId -> decrypted name/size (для поиска/иконок)

// ---------- выделение ----------
// Ключи вида 'f:<id>' (файл) и 'd:<id>' (папка) — чтобы одним Set покрыть
// оба типа и не заводить два параллельных списка.
const selection = new Set();
let lastSelKey = null;              // якорь для выделения диапазона по Shift
let renderedOrder = [];             // порядок элементов на экране (для Shift)
const itemEls = new Map();          // ключ -> DOM-элемент (обновление без перерисовки)
const ITEMS_MIME = 'application/x-vaultly-items'; // внутреннее перетаскивание

const itemKey = (kind, item) => (kind === 'file' ? 'f:' : 'd:') + item.id;
const findFile = (id) => currentItems.files.find(f => f.id === id);
const findFolder = (id) => currentItems.folders.find(f => f.id === id);

const contentEl = document.getElementById('content');
const breadcrumbEl = document.getElementById('breadcrumb');
const toastStack = document.getElementById('toastStack');
const modalRoot = document.getElementById('modalRoot');
const uploadPanel = document.getElementById('uploadPanel');

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = icon(kind === 'err' ? 'x' : 'check', 'icon-sm') + `<span>${escapeHtml(msg)}</span>`;
  toastStack.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

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

async function init() {
  const raw = VLT.b64.toBuf(mkB64);
  masterKey = await VLT.importKeyRaw(raw);

  const sidebarEl = document.getElementById('sidebar');
  const backdropEl = document.getElementById('sidebarBackdrop');
  const openSidebar = () => { sidebarEl.classList.add('open'); backdropEl.classList.add('open'); };
  const closeSidebar = () => { sidebarEl.classList.remove('open'); backdropEl.classList.remove('open'); };
  document.getElementById('hamburgerBtn').onclick = () => {
    sidebarEl.classList.contains('open') ? closeSidebar() : openSidebar();
  };
  backdropEl.onclick = closeSidebar;

  document.getElementById('navDrive').onclick = () => { inRubbish = false; currentFolderId = null; load(); closeSidebar(); };
  document.getElementById('navRubbish').onclick = () => { inRubbish = true; loadRubbish(); closeSidebar(); };
  document.getElementById('navLogout').onclick = () => { sessionStorage.clear(); location.href = 'index.html'; };
  document.getElementById('navBiometric').onclick = () => { showBiometricModal(); closeSidebar(); };
  document.getElementById('newFolderBtn').onclick = showNewFolderModal;
  document.getElementById('uploadBtn').onclick = () => { document.getElementById('fileInput').click(); closeSidebar(); };
  document.getElementById('fabUpload').onclick = () => document.getElementById('fileInput').click();
  document.getElementById('fileInput').onchange = (e) => handleUpload([...e.target.files]);
  document.getElementById('viewGridBtn').onclick = () => setView('grid');
  document.getElementById('viewListBtn').onclick = () => setView('list');
  document.getElementById('searchBox').oninput = renderCurrent;

  // Зона загрузки реагирует только на файлы из системы: без этой проверки
  // перетаскивание внутри диска (папка в папку) мигало бы «отпустите файлы».
  const dz = document.getElementById('dropZone');
  const fromOutside = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  dz.addEventListener('dragover', (e) => {
    if (!fromOutside(e)) return;
    e.preventDefault(); dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    if (!fromOutside(e)) return;
    e.preventDefault(); dz.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleUpload([...e.dataTransfer.files]);
  });
  // Клик по пустому месту снимает выделение — привычно для файловых менеджеров
  dz.addEventListener('click', (e) => {
    if (e.target === dz || e.target.id === 'content') clearSelection();
  });
  document.addEventListener('click', hideCtxMenu);
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'Escape' && selection.size) { clearSelection(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'ф')) { e.preventDefault(); selectAll(); }
  });

  await refreshQuota();
  await load();
}

async function refreshQuota() {
  const trashEl = document.getElementById('quotaTrash');
  try {
    const me = await API.me();
    const pct = Math.min(100, (me.used / me.quota) * 100);
    document.getElementById('quotaFill').style.width = pct.toFixed(1) + '%';
    document.getElementById('quotaText').textContent = `${fmtSize(me.used)} из ${fmtSize(me.quota)}`;
    // Корзина входит в занятое место — иначе «удалил, а места не прибавилось»
    // выглядело бы как ошибка. Показываем отдельной строкой, чтобы было видно,
    // сколько освободится после очистки.
    trashTtlDays = me.trashTtlDays;
    if (me.trashed > 0) {
      trashEl.hidden = false;
      trashEl.textContent = `в корзине: ${fmtSize(me.trashed)}`;
    } else {
      trashEl.hidden = true;
    }
  } catch (e) {
    document.getElementById('quotaText').textContent = '—';
    trashEl.hidden = true;
  }
}

function setView(mode) {
  viewMode = mode;
  document.getElementById('viewGridBtn').classList.toggle('active', mode === 'grid');
  document.getElementById('viewListBtn').classList.toggle('active', mode === 'list');
  renderCurrent();
}

// ---------- загрузка данных папки ----------
async function load() {
  document.getElementById('navDrive').classList.toggle('active', !inRubbish);
  document.getElementById('navRubbish').classList.toggle('active', inRubbish);
  clearSelection(false);
  const res = await API.listFolder(currentFolderId);
  currentItems = res;
  renderBreadcrumb(res.breadcrumb);
  await decorateNames(res.files);
  renderCurrent();
}

async function loadRubbish() {
  document.getElementById('navDrive').classList.toggle('active', false);
  document.getElementById('navRubbish').classList.toggle('active', true);
  clearSelection(false);
  breadcrumbEl.innerHTML = '<span class="crumb current">Корзина</span>';
  const res = await API.rubbish();
  currentItems = res;
  trashTtlDays = res.trashTtlDays;
  await decorateNames(res.files);
  renderCurrent();
}

function renderBreadcrumb(trail) {
  breadcrumbEl.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'crumb' + (trail.length === 0 ? ' current' : '');
  root.textContent = 'Облачный диск';
  root.onclick = () => { currentFolderId = null; load(); };
  makeDropTarget(root, null); // в корень можно перетащить из любой папки
  breadcrumbEl.appendChild(root);
  trail.forEach((f, idx) => {
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.innerHTML = icon('chevronRight');
    breadcrumbEl.appendChild(sep);
    const c = document.createElement('span');
    c.className = 'crumb' + (idx === trail.length - 1 ? ' current' : '');
    c.textContent = f.name;
    c.onclick = () => { currentFolderId = f.id; load(); };
    makeDropTarget(c, f.id); // крошки — удобный способ «поднять на уровень выше»
    breadcrumbEl.appendChild(c);
  });
}

// расшифровываем имя/размер файла (attrs) для отображения
async function decorateNames(files) {
  for (const f of files) {
    if (nameCache.has(f.id)) continue;
    try {
      const fileKey = await VLT.unwrapFileKey(masterKey, f.keyWrapped, f.keyWrapIv);
      const attrs = await VLT.decryptJson(fileKey, f.attrsEncrypted, f.attrsIv);
      nameCache.set(f.id, { name: attrs.name, type: attrs.type || '', fileKey });
    } catch (e) {
      nameCache.set(f.id, { name: '(не удалось расшифровать)', type: '', fileKey: null });
    }
  }
}

// ZIP-сборщику нужны имена файлов из вложенных папок, которых на экране не было
async function resolveFileMeta(f) {
  if (!nameCache.has(f.id)) await decorateNames([f]);
  return nameCache.get(f.id);
}

// ---------- рендер ----------
function renderCurrent() {
  const q = (document.getElementById('searchBox').value || '').toLowerCase();
  const folders = currentItems.folders.filter(f => f.name.toLowerCase().includes(q));
  const files = currentItems.files.filter(f => (nameCache.get(f.id)?.name || '').toLowerCase().includes(q));

  // Порядок нужен выделению диапазона по Shift, и считаем мы его по тому, что
  // реально видно: иначе поиск выделял бы скрытые элементы между краями.
  renderedOrder = [...folders.map(f => 'd:' + f.id), ...files.map(f => 'f:' + f.id)];
  itemEls.clear();
  // выделение могло остаться на элементах, которых на экране больше нет
  for (const key of [...selection]) if (!renderedOrder.includes(key)) selection.delete(key);

  contentEl.innerHTML = '';
  if (inRubbish && (currentItems.folders.length || currentItems.files.length)) {
    contentEl.appendChild(renderRubbishBar());
  }
  const bar = document.createElement('div');
  bar.className = 'selection-bar'; bar.id = 'selectionBar'; bar.hidden = true;
  contentEl.appendChild(bar);

  if (!folders.length && !files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = icon(inRubbish ? 'trash' : 'drive', 'icon-xl') +
      `<span>${inRubbish ? 'Корзина пуста' : 'Здесь пока пусто — перетащите файлы или нажмите «Загрузить»'}</span>`;
    contentEl.appendChild(empty);
    updateSelectionBar();
    return;
  }

  if (viewMode === 'grid') {
    const grid = document.createElement('div'); grid.className = 'grid';
    folders.forEach(f => grid.appendChild(renderFolderCard(f)));
    files.forEach(f => grid.appendChild(renderFileCard(f)));
    contentEl.appendChild(grid);
  } else {
    const list = document.createElement('div'); list.className = 'list';
    const header = document.createElement('div');
    header.className = 'list-row list-header';
    header.innerHTML = '<span></span><span>Имя</span><span class="row-size">Размер</span><span class="row-date">Добавлено</span><span></span>';
    list.appendChild(header);
    folders.forEach(f => list.appendChild(renderFolderRow(f)));
    files.forEach(f => list.appendChild(renderFileRow(f)));
    contentEl.appendChild(list);
  }
  updateSelectionBar();
}

function renderRubbishBar() {
  const bar = document.createElement('div');
  bar.className = 'rubbish-bar';
  const note = document.createElement('div');
  note.className = 'rubbish-note';
  // Корзина считается в квоту, поэтому прямо говорим, сколько она занимает и
  // когда исчезнет сама — иначе «удалил, а места не прибавилось» непонятно.
  note.textContent = trashTtlDays > 0
    ? `Корзина занимает ${fmtSize(currentItems.size || 0)} в вашей квоте и очищается автоматически через ${trashTtlDays} дн.`
    : `Корзина занимает ${fmtSize(currentItems.size || 0)} в вашей квоте.`;
  bar.appendChild(note);
  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost bar-danger';
  btn.innerHTML = icon('trash', 'icon-sm') + '<span> Очистить корзину</span>';
  btn.onclick = emptyRubbish;
  bar.appendChild(btn);
  return bar;
}

function selBox(key) {
  return `<span class="sel-box">${icon(selection.has(key) ? 'squareCheck' : 'square', 'icon-sm')}</span>`;
}

// Общее поведение карточки/строки: выделение, контекстное меню, перетаскивание.
function wireItem(el, kind, item, open) {
  const key = itemKey(kind, item);
  itemEls.set(key, el);
  el.classList.toggle('selected', selection.has(key));

  const box = el.querySelector('.sel-box');
  if (box) box.onclick = (e) => { e.stopPropagation(); toggleSelect(key); };

  el.onclick = (e) => {
    if (e.ctrlKey || e.metaKey) { toggleSelect(key); return; }
    if (e.shiftKey) { selectRange(key); return; }
    // В корзине открывать нечего — там клик просто выбирает, что восстановить.
    if (inRubbish) { toggleSelect(key); return; }
    // Пока что-то выделено, обычный клик переставляет выделение, а не открывает
    // элемент: иначе легко случайно скачать файл вместо того, чтобы выбрать его.
    if (selection.size) { selectOnly(key); return; }
    open();
  };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    // правой по выделенному — действия для всего выделения, иначе по одному элементу
    if (selection.has(key) && selection.size > 1) showCtxMenu(e, selectionMenuItems());
    else showCtxMenu(e, kind === 'file' ? fileMenuItems(item) : folderMenuItems(item));
  };
  const menuBtn = el.querySelector('.card-menu, .row-menu');
  if (menuBtn) menuBtn.onclick = (e) => {
    e.stopPropagation();
    showCtxMenu(e, kind === 'file' ? fileMenuItems(item) : folderMenuItems(item));
  };

  if (!inRubbish) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      // тащим всё выделение, если элемент в него входит, иначе — только его
      const keys = selection.has(key) ? [...selection] : [key];
      e.dataTransfer.setData(ITEMS_MIME, JSON.stringify(keys));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    if (kind === 'folder') makeDropTarget(el, item.id);
  }
  return el;
}

function renderFolderCard(f) {
  const key = itemKey('folder', f);
  const el = document.createElement('div'); el.className = 'card';
  el.innerHTML = `${selBox(key)}<div class="thumb is-folder icon-xl">${icon('folder', 'icon-xl')}</div><div class="name">${escapeHtml(f.name)}</div><div class="sub">Папка</div><span class="card-menu">${icon('moreVertical', 'icon-sm')}</span>`;
  return wireItem(el, 'folder', f, () => { currentFolderId = f.id; load(); });
}
function renderFolderRow(f) {
  const key = itemKey('folder', f);
  const el = document.createElement('div'); el.className = 'list-row';
  el.innerHTML = `<span class="row-icon is-folder">${selBox(key)}${icon('folder')}</span><span>${escapeHtml(f.name)}</span><span class="row-size">—</span><span class="row-date">${new Date(f.createdAt).toLocaleDateString()}</span><span class="row-menu">${icon('moreVertical', 'icon-sm')}</span>`;
  return wireItem(el, 'folder', f, () => { currentFolderId = f.id; load(); });
}
function renderFileCard(f) {
  const meta = nameCache.get(f.id) || { name: '?' };
  const key = itemKey('file', f);
  const el = document.createElement('div'); el.className = 'card';
  const previewable = PREVIEW.kindOf(meta.name, meta.type) ? `<span class="thumb-badge">${icon('eye', 'icon-sm')}</span>` : '';
  el.innerHTML = `${selBox(key)}<div class="thumb icon-xl">${icon(extIconName(meta.name), 'icon-xl')}${previewable}</div><div class="name">${escapeHtml(meta.name)}</div><div class="sub">${fmtSize(f.size)}</div><span class="card-menu">${icon('moreVertical', 'icon-sm')}</span>`;
  return wireItem(el, 'file', f, () => openFile(f));
}
function renderFileRow(f) {
  const meta = nameCache.get(f.id) || { name: '?' };
  const key = itemKey('file', f);
  const el = document.createElement('div'); el.className = 'list-row';
  el.innerHTML = `<span class="row-icon">${selBox(key)}${icon(extIconName(meta.name))}</span><span>${escapeHtml(meta.name)}</span><span class="row-size">${fmtSize(f.size)}</span><span class="row-date">${new Date(f.createdAt).toLocaleDateString()}</span><span class="row-menu">${icon('moreVertical', 'icon-sm')}</span>`;
  return wireItem(el, 'file', f, () => openFile(f));
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ---------- выделение ----------
const parseKey = (key) => ({ kind: key[0] === 'f' ? 'file' : 'folder', id: key.slice(2) });

function selectedItems() {
  return [...selection].map(key => {
    const { kind, id } = parseKey(key);
    const item = kind === 'file' ? findFile(id) : findFolder(id);
    return item ? { kind, id, item } : null;
  }).filter(Boolean);
}

// перекрашиваем один элемент вместо полной перерисовки списка
function paintSelection(key) {
  const el = itemEls.get(key);
  if (!el) return;
  const on = selection.has(key);
  el.classList.toggle('selected', on);
  const box = el.querySelector('.sel-box');
  if (box) box.innerHTML = icon(on ? 'squareCheck' : 'square', 'icon-sm');
}

function toggleSelect(key) {
  if (selection.has(key)) selection.delete(key);
  else { selection.add(key); lastSelKey = key; }
  paintSelection(key);
  updateSelectionBar();
}

function selectOnly(key) {
  const previous = [...selection];
  selection.clear();
  selection.add(key);
  lastSelKey = key;
  previous.forEach(paintSelection);
  paintSelection(key);
  updateSelectionBar();
}

function selectRange(key) {
  const from = renderedOrder.indexOf(lastSelKey);
  const to = renderedOrder.indexOf(key);
  if (from < 0 || to < 0) { toggleSelect(key); return; }
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = a; i <= b; i++) { selection.add(renderedOrder[i]); paintSelection(renderedOrder[i]); }
  updateSelectionBar();
}

function selectAll() {
  renderedOrder.forEach(k => { selection.add(k); paintSelection(k); });
  lastSelKey = renderedOrder[renderedOrder.length - 1] || null;
  updateSelectionBar();
}

function clearSelection(repaint = true) {
  const previous = [...selection];
  selection.clear();
  lastSelKey = null;
  if (repaint) { previous.forEach(paintSelection); updateSelectionBar(); }
}

function updateSelectionBar() {
  const bar = document.getElementById('selectionBar');
  if (!bar) return;
  if (!selection.size) { bar.hidden = true; bar.innerHTML = ''; return; }
  const items = selectedItems();
  bar.hidden = false;
  bar.innerHTML = `<span class="sel-count">${icon('squareCheck', 'icon-sm')} Выбрано: ${items.length}</span>`;
  const add = (label, ic, action, danger) => {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost' + (danger ? ' bar-danger' : '');
    b.innerHTML = icon(ic, 'icon-sm') + `<span> ${escapeHtml(label)}</span>`;
    b.onclick = action;
    bar.appendChild(b);
  };
  if (inRubbish) {
    add('Восстановить', 'undo', bulkRestore);
    add('Удалить навсегда', 'x', bulkDeleteForever, true);
  } else {
    if (items.some(i => i.kind === 'file')) add('Скачать', 'download', bulkDownload);
    add('Скачать ZIP', 'archive', bulkZip);
    add('Переместить…', 'move', () => showMoveModal(selectedItems()));
    add('В корзину', 'trash', bulkTrash, true);
  }
  add('Выбрать всё', 'square', selectAll);
  add('Снять', 'x', () => clearSelection());
}

function selectionMenuItems() {
  if (inRubbish) {
    return [
      { icon: 'undo', label: `Восстановить (${selection.size})`, action: bulkRestore },
      { icon: 'x', label: `Удалить навсегда (${selection.size})`, danger: true, action: bulkDeleteForever },
    ];
  }
  return [
    { icon: 'download', label: 'Скачать', action: bulkDownload },
    { icon: 'archive', label: 'Скачать ZIP', action: bulkZip },
    { icon: 'move', label: 'Переместить…', action: () => showMoveModal(selectedItems()) },
    { icon: 'trash', label: `В корзину (${selection.size})`, danger: true, action: bulkTrash },
  ];
}

// ---------- массовые операции ----------
// Одна нотификация на всю пачку: N тостов подряд читать невозможно.
async function bulkApply(items, fn) {
  let ok = 0; const errors = [];
  for (const it of items) {
    try { await fn(it); ok++; }
    catch (e) { errors.push(e.message); }
  }
  return { ok, errors };
}

async function bulkTrash() {
  const items = selectedItems();
  const { ok, errors } = await bulkApply(items, (it) => it.kind === 'file'
    ? API.patchFile(it.id, { deleted: true })
    : API.patchFolder(it.id, { deleted: true }));
  clearSelection(false);
  if (errors.length) toast(`Перемещено: ${ok}, не удалось: ${errors.length} (${errors[0]})`, 'err');
  else toast(`Перемещено в корзину: ${ok}`);
  await load();
  refreshQuota();
}

async function bulkRestore() {
  const items = selectedItems();
  const { ok, errors } = await bulkApply(items, (it) => it.kind === 'file'
    ? API.patchFile(it.id, { deleted: false })
    : API.patchFolder(it.id, { deleted: false }));
  clearSelection(false);
  if (errors.length) toast(`Восстановлено: ${ok}, не удалось: ${errors.length} (${errors[0]})`, 'err');
  else toast(`Восстановлено: ${ok}`);
  await loadRubbish();
}

async function bulkDeleteForever() {
  const items = selectedItems();
  const confirmed = await confirmModal({
    icon: 'trash', danger: true,
    title: 'Удалить навсегда',
    text: `Выбрано элементов: ${items.length}. Они будут стёрты без возможности восстановления, вместе со всем содержимым папок.`,
    okLabel: 'Удалить',
  });
  if (!confirmed) return;
  const { ok, errors } = await bulkApply(items, (it) => {
    if (it.kind === 'file') { nameCache.delete(it.id); return API.deleteFile(it.id); }
    return API.deleteFolder(it.id);
  });
  clearSelection(false);
  if (errors.length) toast(`Удалено: ${ok}, не удалось: ${errors.length} (${errors[0]})`, 'err');
  else toast(`Удалено навсегда: ${ok}`);
  await loadRubbish();
  refreshQuota();
}

async function bulkDownload() {
  const files = selectedItems().filter(i => i.kind === 'file');
  const skipped = selection.size - files.length;
  toast(`Скачивание ${files.length} файл(ов)…`);
  for (const { item } of files) await downloadFile(item, true);
  if (skipped) toast('Папки пропущены — для них используйте «Скачать ZIP»', 'err');
}

async function bulkZip() {
  const items = selectedItems().map(i => i.kind === 'file'
    ? { kind: 'file', file: i.item, name: (nameCache.get(i.id) || {}).name }
    : { kind: 'folder', id: i.id, name: i.item.name, createdAt: i.item.createdAt });
  if (!items.length) return;
  const name = items.length === 1 && items[0].kind === 'folder' ? items[0].name : 'vaultly';
  await ZIP.save(items, name + '.zip', resolveFileMeta);
}

async function zipFolder(f) {
  await ZIP.save([{ kind: 'folder', id: f.id, name: f.name, createdAt: f.createdAt }], f.name + '.zip', resolveFileMeta);
}

// ---------- перетаскивание между папками ----------
function makeDropTarget(el, targetFolderId) {
  el.addEventListener('dragover', (e) => {
    // реагируем только на своё перетаскивание: файлы извне — дело #dropZone
    if (!e.dataTransfer.types.includes(ITEMS_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.types.includes(ITEMS_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-target');
    let keys = [];
    try { keys = JSON.parse(e.dataTransfer.getData(ITEMS_MIME)); } catch (err) { return; }
    await moveKeys(keys, targetFolderId);
  });
}

async function moveKeys(keys, targetFolderId) {
  const items = keys.map(parseKey);
  if (!items.length) return;
  if ((targetFolderId || null) === (currentFolderId || null)) return; // уже здесь
  // Папку в саму себя не пускаем сразу; остальные циклы (вложенность на любую
  // глубину) отсекает сервер — полного дерева у клиента нет.
  if (items.some(it => it.kind === 'folder' && it.id === targetFolderId)) {
    toast('Нельзя переместить папку внутрь себя', 'err');
    return;
  }
  const { ok, errors } = await bulkApply(items, (it) => it.kind === 'file'
    ? API.patchFile(it.id, { folderId: targetFolderId })
    : API.patchFolder(it.id, { parentId: targetFolderId }));
  clearSelection(false);
  if (errors.length) toast(`Перемещено: ${ok}, не удалось: ${errors.length} (${errors[0]})`, 'err');
  else toast(`Перемещено: ${ok}`);
  await load();
}

// Выбор папки-получателя: спускаемся по дереву уровень за уровнем, потому что
// целиком дерево клиенту никто не отдаёт (и отдавать не нужно).
async function showMoveModal(items) {
  if (!items.length) return;
  let pickerId = null;
  const skip = new Set(items.filter(i => i.kind === 'folder').map(i => i.id));

  showModal(`
    <h3>${icon('move', 'icon-sm')} Переместить (${items.length})</h3>
    <div class="picker-path" id="pkPath"></div>
    <div class="picker-list" id="pkList">Загрузка…</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="pkCancel">Отмена</button>
      <button class="btn btn-primary" id="pkOk" style="width:auto">Переместить сюда</button>
    </div>
  `);
  document.getElementById('pkCancel').onclick = closeModal;
  document.getElementById('pkOk').onclick = async () => {
    const target = pickerId;
    closeModal();
    await moveKeys(items.map(i => (i.kind === 'file' ? 'f:' : 'd:') + i.id), target);
  };

  async function renderLevel() {
    const listEl = document.getElementById('pkList');
    const pathEl = document.getElementById('pkPath');
    if (!listEl) return;
    listEl.textContent = 'Загрузка…';
    try {
      const res = await API.listFolder(pickerId);
      if (!document.getElementById('pkList')) return; // модалку закрыли
      pathEl.innerHTML = '';
      const crumb = (label, id, current) => {
        const c = document.createElement('span');
        c.className = 'crumb' + (current ? ' current' : '');
        c.textContent = label;
        c.onclick = () => { pickerId = id; renderLevel(); };
        pathEl.appendChild(c);
      };
      crumb('Облачный диск', null, !pickerId);
      res.breadcrumb.forEach((f, i) => {
        const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.innerHTML = icon('chevronRight');
        pathEl.appendChild(sep);
        crumb(f.name, f.id, i === res.breadcrumb.length - 1);
      });

      listEl.innerHTML = '';
      const subs = res.folders.filter(f => !skip.has(f.id));
      if (!subs.length) {
        listEl.innerHTML = '<div class="picker-empty">Вложенных папок нет</div>';
      } else {
        subs.forEach(f => {
          const row = document.createElement('div');
          row.className = 'picker-row';
          row.innerHTML = `${icon('folder', 'icon-sm')}<span>${escapeHtml(f.name)}</span>${icon('chevronRight', 'icon-sm')}`;
          row.onclick = () => { pickerId = f.id; renderLevel(); };
          listEl.appendChild(row);
        });
      }
      document.getElementById('pkOk').disabled = (pickerId || null) === (currentFolderId || null);
    } catch (e) {
      listEl.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
    }
  }
  renderLevel();
}

// ---------- корзина ----------
async function emptyRubbish() {
  const ok = await confirmModal({
    icon: 'trash', danger: true,
    title: 'Очистить корзину',
    text: `Всё содержимое корзины (${fmtSize(currentItems.size || 0)}) будет удалено без возможности восстановления.`,
    okLabel: 'Очистить',
  });
  if (!ok) return;
  try {
    const res = await API.emptyRubbish();
    toast(`Корзина очищена, освобождено ${fmtSize(res.freed)}`);
  } catch (e) {
    toast('Не удалось очистить корзину: ' + e.message, 'err');
    return;
  }
  clearSelection(false);
  await loadRubbish();
  refreshQuota();
}

// ---------- контекстное меню ----------
function showCtxMenu(e, items) {
  hideCtxMenu();
  const menu = document.createElement('div'); menu.className = 'ctx-menu'; menu.id = 'ctxMenu';
  items.forEach(it => {
    const row = document.createElement('div');
    row.className = 'ctx-item' + (it.danger ? ' danger' : '');
    row.innerHTML = icon(it.icon, 'icon-sm') + `<span>${escapeHtml(it.label)}</span>`;
    row.onclick = () => { hideCtxMenu(); it.action(); };
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 200));
  const y = Math.max(8, Math.min(e.clientY, window.innerHeight - items.length * 38 - 10));
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
}
function hideCtxMenu() { const m = document.getElementById('ctxMenu'); if (m) m.remove(); }

function folderMenuItems(f) {
  if (inRubbish) {
    return [
      { icon: 'undo', label: 'Восстановить', action: () => restoreFolder(f) },
      { icon: 'x', label: 'Удалить навсегда', danger: true, action: () => deleteFolderForever(f) },
    ];
  }
  return [
    { icon: 'archive', label: 'Скачать папкой (ZIP)', action: () => zipFolder(f) },
    { icon: 'move', label: 'Переместить…', action: () => showMoveModal([{ kind: 'folder', id: f.id, item: f }]) },
    { icon: 'pencil', label: 'Переименовать', action: () => showRenameFolderModal(f) },
    { icon: 'trash', label: 'В корзину', danger: true, action: () => trashFolder(f) },
  ];
}
function fileMenuItems(f) {
  if (inRubbish) {
    return [
      { icon: 'undo', label: 'Восстановить', action: () => restoreFile(f) },
      { icon: 'x', label: 'Удалить навсегда', danger: true, action: () => deleteFileForever(f) },
    ];
  }
  const meta = nameCache.get(f.id) || {};
  const items = [{ icon: 'download', label: 'Скачать', action: () => downloadFile(f) }];
  // предпросмотр показываем только для того, что браузер действительно откроет
  if (PREVIEW.kindOf(meta.name, meta.type)) {
    items.unshift({ icon: 'eye', label: 'Просмотр', action: () => openFile(f) });
  }
  items.push(
    { icon: 'link', label: 'Получить ссылку', action: () => showShareModal(f) },
    { icon: 'move', label: 'Переместить…', action: () => showMoveModal([{ kind: 'file', id: f.id, item: f }]) },
    { icon: 'pencil', label: 'Переименовать', action: () => showRenameFileModal(f) },
    { icon: 'trash', label: 'В корзину', danger: true, action: () => trashFile(f) },
  );
  return items;
}

// ---------- операции с папками ----------
function showNewFolderModal() {
  showModal(`
    <h3>${icon('folderPlus', 'icon-sm')} Новая папка</h3>
    <div class="field"><input id="mfName" placeholder="Имя папки" /></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mfCancel">Отмена</button>
      <button class="btn btn-primary" id="mfOk" style="width:auto">Создать</button>
    </div>
  `);
  document.getElementById('mfCancel').onclick = closeModal;
  document.getElementById('mfOk').onclick = async () => {
    const name = document.getElementById('mfName').value.trim();
    if (!name) return;
    const btn = document.getElementById('mfOk');
    btn.disabled = true;
    try {
      await API.createFolder(name, currentFolderId);
      closeModal(); toast('Папка создана'); load();
    } catch (e) {
      btn.disabled = false;
      toast('Не удалось создать папку: ' + e.message, 'err');
    }
  };
}
function showRenameFolderModal(f) {
  showModal(`
    <h3>${icon('pencil', 'icon-sm')} Переименовать папку</h3>
    <div class="field"><input id="mfName" value="${escapeHtml(f.name)}" /></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mfCancel">Отмена</button>
      <button class="btn btn-primary" id="mfOk" style="width:auto">Сохранить</button>
    </div>
  `);
  document.getElementById('mfCancel').onclick = closeModal;
  document.getElementById('mfOk').onclick = async () => {
    const name = document.getElementById('mfName').value.trim();
    if (!name) return;
    try {
      await API.patchFolder(f.id, { name });
      closeModal(); toast('Переименовано'); load();
    } catch (e) {
      toast('Не удалось переименовать: ' + e.message, 'err');
    }
  };
}
async function trashFolder(f) {
  try { await API.patchFolder(f.id, { deleted: true }); toast('Перемещено в корзину'); load(); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}
async function restoreFolder(f) {
  try { await API.patchFolder(f.id, { deleted: false }); toast('Восстановлено'); loadRubbish(); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}
async function deleteFolderForever(f) {
  try { await API.deleteFolder(f.id); toast('Удалено навсегда'); loadRubbish(); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}

// ---------- операции с файлами ----------
async function trashFile(f) {
  try { await API.patchFile(f.id, { deleted: true }); toast('Перемещено в корзину'); load(); refreshQuota(); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}
async function restoreFile(f) {
  try { await API.patchFile(f.id, { deleted: false }); toast('Восстановлено'); loadRubbish(); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}
async function deleteFileForever(f) {
  try { await API.deleteFile(f.id); nameCache.delete(f.id); toast('Удалено навсегда'); loadRubbish(); refreshQuota(); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}

function showRenameFileModal(f) {
  const meta = nameCache.get(f.id);
  showModal(`
    <h3>${icon('pencil', 'icon-sm')} Переименовать файл</h3>
    <div class="field"><input id="mfName" value="${escapeHtml(meta.name)}" /></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mfCancel">Отмена</button>
      <button class="btn btn-primary" id="mfOk" style="width:auto">Сохранить</button>
    </div>
  `);
  document.getElementById('mfCancel').onclick = closeModal;
  document.getElementById('mfOk').onclick = async () => {
    const newName = document.getElementById('mfName').value.trim();
    if (!newName) return;
    try {
      const { data, iv } = await VLT.encryptJson(meta.fileKey, { name: newName, type: meta.type });
      await API.patchFile(f.id, { attrsEncrypted: data, attrsIv: iv });
      nameCache.delete(f.id);
      closeModal(); toast('Переименовано'); load();
    } catch (e) {
      toast('Не удалось переименовать: ' + e.message, 'err');
    }
  };
}

async function downloadFile(f, quiet) {
  try {
    if (!quiet) toast('Расшифровка и скачивание…');
    const meta = nameCache.get(f.id);
    const buf = await API.downloadFile(f.id);
    const plain = await VLT.decryptBuffer(meta.fileKey, VLT.b64.toBuf(f.contentIv), buf);
    const blob = new Blob([plain], { type: meta.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = meta.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    toast('Ошибка скачивания: ' + e.message, 'err');
  }
}

// Клик по файлу: медиа открываем на месте, остальное скачиваем как раньше.
function openFile(f) {
  const meta = nameCache.get(f.id) || {};
  if (meta.fileKey && PREVIEW.kindOf(meta.name, meta.type)) {
    PREVIEW.open({ file: f, name: meta.name, type: meta.type, fileKey: meta.fileKey, onDownload: () => downloadFile(f) });
  } else {
    downloadFile(f);
  }
}

const fmtWhen = (ms) => new Date(ms).toLocaleString();

async function showShareModal(f) {
  const meta = nameCache.get(f.id);
  // Настройки уже созданной ссылки читаем заранее: 404 значит «ссылки ещё нет».
  let current = null;
  try {
    current = await API.getShare(f.id);
  } catch (e) {
    if (e.status !== 404) { toast('Не удалось прочитать настройки ссылки: ' + e.message, 'err'); return; }
  }

  const hasExpiry = !!(current && current.expiresAt);
  const hasPassword = !!(current && current.requiresPassword);
  // «Не менять» нужен потому, что срок хранится абсолютным моментом: превратить
  // его обратно в «часы от сейчас» без продления ссылки нельзя.
  const ttlOptions = [
    hasExpiry ? `<option value="keep" selected>Не менять (до ${escapeHtml(fmtWhen(current.expiresAt))})</option>` : '',
    `<option value=""${hasExpiry ? '' : ' selected'}>Без ограничения</option>`,
    '<option value="1">1 час</option>',
    '<option value="24">24 часа</option>',
    '<option value="168">7 дней</option>',
    '<option value="720">30 дней</option>',
  ].join('');

  showModal(`
    <h3>${icon('link', 'icon-sm')} Ссылка на файл</h3>
    <p class="modal-note">Файл «${escapeHtml(meta.name)}» расшифровывается только у получателя. Без пароля ключ едет во фрагменте ссылки и на сервер не попадает. С паролем ключ лежит на сервере обёрнутым в пароль — развернуть его сервер не может, но слабый пароль теоретически перебирается по украденной базе.</p>
    <div class="field"><label>${icon('clock', 'icon-sm')} Срок действия</label><select id="shTtl">${ttlOptions}</select></div>
    <div class="field"><label>${icon('download', 'icon-sm')} Лимит скачиваний</label><input id="shMax" type="number" min="1" step="1" placeholder="без лимита" value="${current && current.maxDownloads ? current.maxDownloads : ''}" /></div>
    <div class="field">
      <label>${icon('lock', 'icon-sm')} Пароль ${hasPassword ? '— уже установлен' : '— необязательно'}</label>
      <input id="shPass" type="password" autocomplete="new-password" placeholder="${hasPassword ? 'оставьте пустым, чтобы не менять' : 'без пароля'}" />
      ${hasPassword ? '<label class="check-line"><input type="checkbox" id="shDropPass" /> снять пароль</label>' : ''}
    </div>
    <div class="share-stats" id="shStats"></div>
    <div class="row"><input id="shareLink" readonly placeholder="ссылка появится после сохранения" /><button class="btn btn-primary" id="copyBtn" style="width:auto">${icon('copy', 'icon-sm')} Копировать</button></div>
    <div class="modal-actions">
      <button class="btn btn-ghost bar-danger" id="revokeBtn"${current ? '' : ' hidden'}>Отключить ссылку</button>
      <button class="btn btn-ghost" id="closeBtn">Закрыть</button>
      <button class="btn btn-primary" id="saveBtn" style="width:auto">${current ? 'Сохранить' : 'Создать ссылку'}</button>
    </div>
  `);

  const linkEl = document.getElementById('shareLink');
  const statsEl = document.getElementById('shStats');
  const dropPass = document.getElementById('shDropPass');
  const passEl = document.getElementById('shPass');
  let link = '';

  if (dropPass) {
    // «снять пароль» и «поставить новый» — взаимоисключающие действия
    dropPass.onchange = () => { passEl.disabled = dropPass.checked; if (dropPass.checked) passEl.value = ''; };
  }

  async function refresh(rec) {
    current = rec;
    const parts = [`скачиваний: ${rec.downloads}`];
    if (rec.maxDownloads) parts.push(`осталось: ${Math.max(0, rec.maxDownloads - rec.downloads)}`);
    if (rec.expiresAt) parts.push(`действует до ${fmtWhen(rec.expiresAt)}`);
    parts.push(rec.requiresPassword ? 'защищена паролем' : 'без пароля');
    statsEl.textContent = parts.join(' · ');
    // В режиме с паролем ключа в ссылке нет — он обёрнут паролем и лежит на сервере
    if (rec.requiresPassword) {
      link = `${location.origin}/share.html#${rec.publicId}`;
    } else {
      const raw = await VLT.exportKeyRaw(meta.fileKey);
      link = `${location.origin}/share.html#${rec.publicId}!${VLT.b64.fromBufUrl(raw)}`;
    }
    linkEl.value = link;
    document.getElementById('revokeBtn').hidden = false;
    document.getElementById('saveBtn').textContent = 'Сохранить';
  }

  if (current) await refresh(current);

  document.getElementById('saveBtn').onclick = async () => {
    const btn = document.getElementById('saveBtn');
    const existed = !!current;
    btn.disabled = true;
    try {
      const settings = {};
      const ttl = document.getElementById('shTtl').value;
      if (ttl !== 'keep') settings.ttlHours = ttl === '' ? null : Number(ttl);
      const max = document.getElementById('shMax').value.trim();
      settings.maxDownloads = max === '' ? null : Number(max);

      if (dropPass && dropPass.checked) {
        settings.password = null;
      } else if (passEl.value) {
        // Ключ файла оборачиваем ключом из пароля прямо здесь: сервер получает
        // только обёртку и верификатор, самого пароля он не видит никогда.
        const salt = VLT.randomSaltHex();
        const { wrapKey, verifier } = await VLT.deriveShareSecrets(passEl.value, salt);
        const wrapped = await VLT.wrapFileKey(wrapKey, meta.fileKey);
        settings.password = { salt, keyWrapped: wrapped.keyWrapped, keyWrapIv: wrapped.keyWrapIv, verifier };
      } else if (!hasPassword) {
        settings.password = null;
      }
      // Пустое поле у уже защищённой ссылки — поле просто не отправляем, и
      // сервер оставляет прежний пароль (переслать его мы всё равно не можем).

      await refresh(await API.createShare(f.id, settings));
      passEl.value = '';
      toast(existed ? 'Настройки ссылки сохранены' : 'Ссылка создана');
    } catch (e) {
      toast('Не удалось сохранить: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('copyBtn').onclick = () => {
    if (!link) { toast('Сначала создайте ссылку', 'err'); return; }
    linkEl.select();
    navigator.clipboard.writeText(link);
    toast('Ссылка скопирована');
  };
  document.getElementById('revokeBtn').onclick = async () => {
    try { await API.deleteShare(f.id); toast('Ссылка отключена'); closeModal(); }
    catch (e) { toast('Не удалось отключить: ' + e.message, 'err'); }
  };
  document.getElementById('closeBtn').onclick = closeModal;
}

// ---------- модалки ----------
function showModal(html) {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="backdrop"><div class="modal">${html}</div></div>`;
  document.getElementById('backdrop').onclick = (e) => { if (e.target.id === 'backdrop') closeModal(); };
}
function closeModal() { modalRoot.innerHTML = ''; }

// Подтверждение необратимых действий. Отмена по фону/кнопке резолвится в false,
// иначе вызывающий код завис бы навсегда.
function confirmModal({ title, text, okLabel = 'Продолжить', icon: ic = 'check', danger }) {
  return new Promise((resolve) => {
    showModal(`
      <h3>${icon(ic, 'icon-sm')} ${escapeHtml(title)}</h3>
      <p class="modal-note">${escapeHtml(text)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="cfCancel">Отмена</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cfOk" style="width:auto">${escapeHtml(okLabel)}</button>
      </div>
    `);
    const done = (value) => { closeModal(); resolve(value); };
    document.getElementById('backdrop').onclick = (e) => { if (e.target.id === 'backdrop') done(false); };
    document.getElementById('cfCancel').onclick = () => done(false);
    document.getElementById('cfOk').onclick = () => done(true);
  });
}

// ---------- загрузка (шифрование в браузере) ----------
async function handleUpload(fileList) {
  if (!fileList.length) return;
  uploadPanel.innerHTML = `<div class="upload-panel"><h4>${icon('upload', 'icon-sm')} Загрузка файлов (${fileList.length})</h4><div id="upItems"></div></div>`;
  const itemsEl = document.getElementById('upItems');

  for (const file of fileList) {
    const row = document.createElement('div'); row.className = 'upload-item';
    row.innerHTML = `<div class="fname"><span>${escapeHtml(file.name)}</span><span>0%</span></div><div class="progress-line"><div class="progress-fill"></div></div>`;
    itemsEl.appendChild(row);
    const fill = row.querySelector('.progress-fill');
    const pctEl = row.querySelector('.fname span:last-child');
    try {
      // события прогресса сыпятся часто — перерисовываем только на смене процента
      let shown = -1;
      await uploadOne(file, (pct) => {
        if (pct === shown) return;
        shown = pct;
        fill.style.width = pct + '%'; pctEl.textContent = pct + '%';
      });
      fill.style.width = '100%'; pctEl.innerHTML = icon('check', 'icon-sm');
    } catch (e) {
      pctEl.textContent = 'Ошибка';
      toast(`Не удалось загрузить ${file.name}: ${e.message}`, 'err');
    }
  }
  setTimeout(() => { uploadPanel.innerHTML = ''; }, 3000);
  document.getElementById('fileInput').value = '';
  load(); refreshQuota();
}

// Вехи полосы загрузки. Чтение и шифрование быстрые и от сети не зависят,
// поэтому им отдано только начало шкалы; всё остальное — отправка, где прогресс
// приходит от XHR по фактически ушедшим байтам. При отправке до 100% не
// дотягиваем: последние проценты закрывает ответ сервера, иначе полоса
// показывала бы «готово», пока сервер ещё принимает файл.
const UP_READ = 4, UP_ENCRYPTED = 12, UP_SENT = 97;

async function uploadOne(file, onProgress) {
  const fileKey = await VLT.generateFileKey();
  const buffer = await file.arrayBuffer();
  onProgress(UP_READ);
  const { ciphertext, iv } = await VLT.encryptBuffer(fileKey, buffer);
  const { data: attrsEncrypted, iv: attrsIv } = await VLT.encryptJson(fileKey, { name: file.name, type: file.type });
  const { keyWrapped, keyWrapIv } = await VLT.wrapFileKey(masterKey, fileKey);
  onProgress(UP_ENCRYPTED);

  const form = new FormData();
  form.append('blob', new Blob([ciphertext]), 'blob');
  form.append('folderId', currentFolderId || '');
  form.append('size', String(file.size));
  form.append('contentIv', VLT.b64.fromBuf(iv));
  form.append('attrsEncrypted', attrsEncrypted);
  form.append('attrsIv', attrsIv);
  form.append('keyWrapped', keyWrapped);
  form.append('keyWrapIv', keyWrapIv);

  await API.uploadFile(form, (ratio) => {
    onProgress(UP_ENCRYPTED + Math.round(ratio * (UP_SENT - UP_ENCRYPTED)));
  });
  onProgress(100);
}

// ---------- биометрия ----------
function guessDeviceLabel() {
  const ua = navigator.userAgent;
  let os = 'Устройство';
  if (/iPhone|iPad/.test(ua)) os = 'iPhone/iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X/.test(ua)) os = 'Mac';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  let browser = '';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return browser ? `${os} · ${browser}` : os;
}

async function showBiometricModal() {
  const supported = WEBAUTHN.supportsWebAuthn();
  showModal(`
    <h3>${icon('fingerprint', 'icon-sm')} Вход по биометрии</h3>
    <p style="color:var(--text-dim);font-size:13px">
      Разблокирует хранилище без пароля и без ввода логина на этом устройстве —
      через Face ID, Touch ID, Windows Hello или отпечаток на Android. Секрет
      никогда не покидает устройство: сервер хранит только зашифрованный
      им мастер-ключ.
    </p>
    <div id="credList" style="margin:14px 0;display:flex;flex-direction:column;gap:8px"></div>
    ${supported
      ? `<button class="btn btn-primary" id="enrollBtn">${icon('fingerprint', 'icon-sm')} Добавить это устройство</button>`
      : `<p class="error-msg" style="margin:0">Этот браузер не поддерживает вход по биометрии (WebAuthn).</p>`}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mfCancel">Закрыть</button>
    </div>
  `);
  document.getElementById('mfCancel').onclick = closeModal;

  async function refreshList() {
    const listEl = document.getElementById('credList');
    if (!listEl) return;
    listEl.innerHTML = 'Загрузка…';
    try {
      const { credentials } = await API.webauthnCredentials();
      if (!credentials.length) {
        listEl.innerHTML = '<div style="color:var(--text-dim);font-size:13px">Пока ни одно устройство не добавлено</div>';
        return;
      }
      listEl.innerHTML = '';
      credentials.forEach(c => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px';
        // discoverable === false — ключ не хранится на устройстве, поэтому при
        // входе им всё равно придётся вводить логин: предлагаем пересоздать
        let badge;
        if (!c.passwordless) {
          badge = `<span style="color:var(--text-dim);font-size:11px">Только подтверждение</span>`;
        } else if (c.discoverable === false) {
          badge = `<span style="color:var(--danger);font-size:11px">Без пароля, но с вводом логина — удалите и добавьте заново</span>`;
        } else {
          badge = `<span style="color:var(--ok);font-size:11px">Без пароля и логина</span>`;
        }
        row.innerHTML = `${icon('smartphone', 'icon-sm')}<div style="flex:1;min-width:0"><div style="font-size:13px">${escapeHtml(c.deviceLabel)}</div>${badge}</div>`;
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-ghost'; delBtn.style.width = 'auto'; delBtn.style.padding = '6px';
        delBtn.innerHTML = icon('x', 'icon-sm');
        delBtn.onclick = async () => {
          try { await API.webauthnDeleteCredential(c.id); toast('Устройство удалено'); refreshList(); }
          catch (e) { toast('Ошибка: ' + e.message, 'err'); }
        };
        row.appendChild(delBtn);
        listEl.appendChild(row);
      });
    } catch (e) {
      listEl.innerHTML = `<div class="error-msg">Не удалось загрузить список: ${escapeHtml(e.message)}</div>`;
    }
  }
  refreshList();

  const enrollBtn = document.getElementById('enrollBtn');
  if (enrollBtn) {
    enrollBtn.onclick = async () => {
      enrollBtn.disabled = true;
      enrollBtn.innerHTML = 'Ждём подтверждение…';
      try {
        const result = await WEBAUTHN.enroll(masterKey, guessDeviceLabel());
        if (result.passwordless) {
          toast('Готово! Теперь вход на этом устройстве — без пароля и без логина');
        } else {
          toast('Устройство добавлено, но это браузер/ОС не поддерживает разблокировку без пароля — при входе всё равно понадобится пароль', 'err');
        }
        refreshList();
      } catch (e) {
        // самые частые случаи объясняем по-русски: библиотека отдаёт их текстом на английском
        if (e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
          toast('Это устройство уже в списке — сначала удалите старую запись (×), потом добавьте заново', 'err');
        } else if (e.code === 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT') {
          toast('Устройство не умеет хранить ключ доступа у себя — вход без логина на нём невозможен', 'err');
        } else {
          toast('Не удалось настроить биометрию: ' + e.message, 'err');
        }
      } finally {
        enrollBtn.disabled = false;
        enrollBtn.innerHTML = `${icon('fingerprint', 'icon-sm')} Добавить это устройство`;
      }
    };
  }
}

init();
