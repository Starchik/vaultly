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
      let msg = 'Ошибка запроса';
      try { msg = (await res.json()).error || msg; } catch (e) {}
      // сессия истекла или недействительна — не оставляем пользователя
      // молча биться в стену, а отправляем обратно на вход
      if (res.status === 401 && !url.startsWith('/webauthn/') && !url.startsWith('/auth/login') && !url.startsWith('/auth/register') && !url.startsWith('/share/')) {
        sessionStorage.clear();
        if (!location.pathname.endsWith('index.html') && !location.pathname.endsWith('share.html')) {
          location.href = 'index.html?expired=1';
        }
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.arrayBuffer();
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
    async uploadFile(formData) {
      return req('POST', '/files/upload', formData, { form: true });
    },
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
    shareDownload: (publicId, verifier) =>
      req('GET', `/share/${publicId}/download`, undefined, verifier ? { headers: { 'x-share-verifier': verifier } } : {}),
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
