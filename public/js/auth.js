const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');

document.getElementById('showRegister').onclick = (e) => { e.preventDefault(); loginForm.style.display = 'none'; registerForm.style.display = 'block'; };
document.getElementById('showLogin').onclick = (e) => { e.preventDefault(); registerForm.style.display = 'none'; loginForm.style.display = 'block'; };

if (new URLSearchParams(location.search).get('expired')) {
  document.getElementById('loginError').textContent = 'Сессия истекла, войдите заново';
}

async function finishAuth(token, username, masterKey) {
  sessionStorage.setItem('vlt_token', token);
  sessionStorage.setItem('vlt_username', username);
  const raw = await VLT.exportKeyRaw(masterKey);
  sessionStorage.setItem('vlt_mk', VLT.b64.fromBuf(raw));
  location.href = 'app.html';
}

async function afterAuth(res, password) {
  // выводим мастер-ключ шифрования из пароля и соли — храним только в
  // памяти вкладки (sessionStorage), никогда не отправляем на сервер
  const masterKey = await VLT.deriveMasterKey(password, res.kdfSalt);
  await finishAuth(res.token, res.username, masterKey);
}

document.getElementById('loginBtn').onclick = async () => {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const res = await API.login(username, password);
    await afterAuth(res, password);
  } catch (e) {
    errEl.textContent = e.message;
  }
};

document.getElementById('regBtn').onclick = async () => {
  const username = document.getElementById('regUser').value.trim();
  const password = document.getElementById('regPass').value;
  const errEl = document.getElementById('regError');
  errEl.textContent = '';
  try {
    const res = await API.register(username, password);
    await afterAuth(res, password);
  } catch (e) {
    errEl.textContent = e.message;
  }
};

// ---------- вход по биометрии ----------
// Логин вводить не нужно: ключ доступа discoverable, поэтому браузер сам
// показывает список аккаунтов. Логин в поле учитывается только как fallback
// для ключей, добавленных до перехода на resident keys.
const bioBtn = document.getElementById('bioLoginBtn');
if (WEBAUTHN.supportsWebAuthn()) {
  bioBtn.style.display = 'flex';
}

function bioErrorText(e) {
  // отмена запроса и "подходящих ключей нет" приходят одной и той же ошибкой,
  // поэтому подсказываем оба выхода сразу
  if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
    return 'Ключ доступа не выбран. Если биометрия на этом устройстве настраивалась до обновления, введите логин и нажмите «Войти по биометрии» ещё раз.';
  }
  return e.message;
}

bioBtn.onclick = async () => {
  const username = document.getElementById('loginUser').value.trim();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  bioBtn.disabled = true;
  try {
    const res = await WEBAUTHN.login(username || undefined);
    await finishAuth(res.token, res.username, res.masterKey);
  } catch (e) {
    errEl.textContent = bioErrorText(e);
    startAutofill(); // клик прервал фоновую церемонию — возвращаем подсказку в поле логина
  } finally {
    bioBtn.disabled = false;
  }
};

// Conditional UI: церемония висит в фоне, и браузер предлагает ключ доступа
// прямо в поле логина (для этого у поля autocomplete="username webauthn").
// Любая ошибка здесь молчаливая: пользователь ничего не просил, а "ключей нет"
// и "церемонию прервали" — это норма, а не повод пугать красным текстом.
let autofillActive = false;
async function startAutofill() {
  if (autofillActive || !WEBAUTHN.supportsWebAuthn()) return;
  if (!(await WEBAUTHN.supportsAutofill())) return;
  autofillActive = true;
  try {
    const res = await WEBAUTHN.loginWithAutofill();
    await finishAuth(res.token, res.username, res.masterKey);
  } catch (e) {
    /* тишина — см. комментарий выше */
  } finally {
    autofillActive = false;
  }
}
startAutofill();

// enter-to-submit
document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('loginBtn').click(); });
document.getElementById('regPass').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('regBtn').click(); });
