const API = (() => {
  const base = '/api';
  function token() {
    return sessionStorage.getItem('vlt_token');
  }
  // opts: { form: true } — тело уже FormData, Content-Type выставит браузер;
  //       { headers } — дополнительные заголовки (например, верификатор пароля)
  async function req(method, url, body, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    let payload = body;
    if (body && !opts.form) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error || ''; } catch (e) {}
      throw failure(res.status, url, msg);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.arrayBuffer();
  }

  // Разбор неуспешного ответа, общий для fetch- и XHR-путей.
  function failure(status, url, msg) {
    // сессия истекла или недействительна — не оставляем пользователя
    // молча биться в стену, а отправляем обратно на вход
    if (status === 401 && !url.startsWith('/webauthn/') && !url.startsWith('/auth/login') && !url.startsWith('/auth/register') && !url.startsWith('/share/')) {
      sessionStorage.clear();
      if (!location.pathname.endsWith('index.html') && !location.pathname.endsWith('share.html')) {
        location.href = 'index.html?expired=1';
      }
    }
    const err = new Error(msg || 'Ошибка запроса');
    err.status = status;
    return err;
  }

  // fetch() не сообщает, сколько байт тела уже ушло на сервер, поэтому запросы
  // с полосой прогресса идут через XHR — только ради событий progress.
  // onUploadProgress/onDownloadProgress получают долю 0..1 и вызываются лишь
  // когда известен полный размер; без них запрос ведёт себя как обычный.
  function reqWithProgress(method, url, body, opts = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, base + url);
      xhr.responseType = 'arraybuffer';
      const t = token();
      if (t) xhr.setRequestHeader('Authorization', 'Bearer ' + t);
      for (const [k, v] of Object.entries(opts.headers || {})) xhr.setRequestHeader(k, v);
      let payload = body;
      if (body && !opts.form) {
        xhr.setRequestHeader('Content-Type', 'application/json');
        payload = JSON.stringify(body);
      }
      const track = (target, cb) => {
        if (cb) target.onprogress = (e) => { if (e.lengthComputable && e.total) cb(e.loaded / e.total); };
      };
      track(xhr.upload, opts.onUploadProgress);
      track(xhr, opts.onDownloadProgress);
      xhr.onload = () => {
        const text = () => new TextDecoder().decode(xhr.response || new ArrayBuffer(0));
        if (xhr.status < 200 || xhr.status > 299) {
          let msg = '';
          try { msg = JSON.parse(text()).error || ''; } catch (e) {}
          return reject(failure(xhr.status, url, msg));
        }
        if ((xhr.getResponseHeader('content-type') || '').includes('application/json')) {
          try { return resolve(JSON.parse(text())); } catch (e) { return reject(new Error('Некорректный ответ сервера')); }
        }
        resolve(xhr.response);
      };
      xhr.onerror = () => reject(new Error('Нет связи с сервером'));
      xhr.onabort = () => reject(new Error('Загрузка отменена'));
      xhr.send(payload === undefined ? null : payload);
    });
  }
  return {
    register: (username, password) => req('POST', '/auth/register', { username, password }),
    login: (username, password) => req('POST', '/auth/login', { username, password }),
    me: () => req('GET', '/auth/me'),
    listFolder: (parentId) => req('GET', '/folders' + (parentId ? `?parentId=${parentId}` : '')),
    createFolder: (name, parentId) => req('POST', '/folders', { name, parentId }),
    patchFolder: (id, body) => req('PATCH', `/folders/${id}`, body),
    deleteFolder: (id) => req('DELETE', `/folders/${id}`),
    rubbish: () => req('GET', '/rubbish'),
    emptyRubbish: () => req('POST', '/rubbish/empty', {}),
    // onProgress получает долю отправленных байт (0..1)
    uploadFile: (formData, onProgress) =>
      reqWithProgress('POST', '/files/upload', formData, { form: true, onUploadProgress: onProgress }),
    fileMeta: (id) => req('GET', `/files/${id}/meta`),
    downloadFile: (id) => req('GET', `/files/${id}/download`),
    patchFile: (id, body) => req('PATCH', `/files/${id}`, body),
    deleteFile: (id) => req('DELETE', `/files/${id}`),
    // settings: { ttlHours, maxDownloads, password }. Пропущенное поле означает
    // «оставить как было» — так модалка может менять срок, не зная пароля.
    createShare: (id, settings = {}) => req('POST', `/files/${id}/share`, settings),
    getShare: (id) => req('GET', `/files/${id}/share`),
    deleteShare: (id) => req('DELETE', `/files/${id}/share`),
    shareMeta: (publicId) => req('GET', `/share/${publicId}/meta`),
    shareUnlock: (publicId, verifier) => req('POST', `/share/${publicId}/unlock`, { verifier }),
    // верификатор идёт заголовком, а не в URL: так он не попадёт в логи прокси
    shareDownload: (publicId, verifier, onProgress) =>
      reqWithProgress('GET', `/share/${publicId}/download`, undefined, {
        headers: verifier ? { 'x-share-verifier': verifier } : {},
        onDownloadProgress: onProgress,
      }),
    // WebAuthn / биометрия
    webauthnRegisterOptions: () => req('POST', '/webauthn/register-options', {}),
    webauthnRegisterVerify: (attestationResponse, deviceLabel) => req('POST', '/webauthn/register-verify', { attestationResponse, deviceLabel }),
    webauthnWrapKey: (credentialId, wrappedMasterKey) => req('POST', '/webauthn/wrap-key', { credentialId, wrappedMasterKey }),
    webauthnCredentials: () => req('GET', '/webauthn/credentials'),
    webauthnDeleteCredential: (id) => req('DELETE', `/webauthn/credentials/${id}`),
    webauthnPrfSalt: () => req('GET', '/webauthn/prf-salt'),
    // username необязателен: без него сервер отдаёт options для входа
    // без логина (по ключу доступа, сохранённому на устройстве)
    webauthnLoginOptions: (username) => req('POST', '/webauthn/login-options', username ? { username } : {}),
    webauthnLoginVerify: (assertionResponse, challengeId) => req('POST', '/webauthn/login-verify', { assertionResponse, challengeId }),
  };
})();
