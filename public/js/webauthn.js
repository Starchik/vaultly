/**
 * Биометрический вход (WebAuthn + расширение PRF).
 *
 * Важно понимать, ЧТО именно защищает биометрия здесь: не просто "вместо
 * пароля стучимся на сервер" — расширение PRF даёт браузеру детерминированный
 * секрет, зависящий от конкретного аутентификатора (Touch ID/Face ID/
 * Windows Hello/отпечаток на Android). Этим секретом на клиенте обёрнут
 * мастер-ключ шифрования. Сервер видит только обёрнutый (зашифрованный)
 * мастер-ключ и публичный ключ WebAuthn-credential — сам секрет PRF и
 * расшифрованный мастер-ключ никогда не покидают устройство.
 *
 * Поддержка PRF зависит от браузера/устройства (хорошо — свежий Chrome/
 * Android, ограниченно — Safari/iOS). Если PRF недоступен, беспарольный
 * вход на этом устройстве настроить нельзя — это явно сообщается пользователю,
 * никакой имитации "фейковой" защиты здесь нет.
 *
 * Логин при входе не нужен: ключ доступа регистрируется как discoverable,
 * аутентификатор хранит его вместе с userHandle и сам сообщает серверу,
 * какой это аккаунт.
 */

const WEBAUTHN = (() => {
  function supportsWebAuthn() {
    return !!(window.PublicKeyCredential && window.SimpleWebAuthnBrowser && window.SimpleWebAuthnBrowser.browserSupportsWebAuthn());
  }

  async function fetchPrfSaltBuffer() {
    const { salt } = await API.webauthnPrfSalt();
    return VLT.b64.toBufUrl(salt);
  }

  // сервер не конвертирует поле extensions — делаем это сами: PRF-соль
  // приходит как base64url-строка, а WebAuthn API требует ArrayBuffer
  function injectPrfEval(optionsJSON, saltBuffer) {
    optionsJSON.extensions = optionsJSON.extensions || {};
    optionsJSON.extensions.prf = { eval: { first: saltBuffer } };
    return optionsJSON;
  }

  /**
   * Регистрирует это устройство для входа по биометрии.
   * masterKey — CryptoKey (уже расшифрованный мастер-ключ текущей сессии).
   * Возвращает { passwordless: boolean } — true, если PRF поддерживается
   * и беспарольный вход настроен; false — устройство зарегистрировано
   * только для подтверждения личности (пароль всё равно понадобится).
   */
  async function enroll(masterKey, deviceLabel) {
    if (!supportsWebAuthn()) {
      throw new Error('Этот браузер не поддерживает вход по биометрии (WebAuthn)');
    }
    const regOptions = await API.webauthnRegisterOptions();
    regOptions.extensions = Object.assign({}, regOptions.extensions, { prf: {} });

    const attestationResponse = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: regOptions });
    const { credentialId } = await API.webauthnRegisterVerify(attestationResponse, deviceLabel);

    const prfEnabled = !!(attestationResponse.clientExtensionResults && attestationResponse.clientExtensionResults.prf && attestationResponse.clientExtensionResults.prf.enabled);
    if (!prfEnabled) {
      return { passwordless: false };
    }

    // вторая (короткая) биометрическая проверка — нужна, чтобы получить
    // сам PRF-секрет и обернуть им мастер-ключ
    const saltBuffer = await fetchPrfSaltBuffer();
    const assertOptions = {
      challenge: VLT.b64.fromBufUrl(crypto.getRandomValues(new Uint8Array(32))),
      rpId: location.hostname,
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
      userVerification: 'required',
    };
    injectPrfEval(assertOptions, saltBuffer);
    const assertion = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: assertOptions });
    const prfResult = assertion.clientExtensionResults && assertion.clientExtensionResults.prf && assertion.clientExtensionResults.prf.results && assertion.clientExtensionResults.prf.results.first;
    if (!prfResult) {
      return { passwordless: false };
    }

    const wrapKey = await deriveAesKeyFromPrf(prfResult);
    const rawMaster = await VLT.exportKeyRaw(masterKey);
    const { ciphertext, iv } = await VLT.encryptBuffer(wrapKey, rawMaster);
    await API.webauthnWrapKey(credentialId, { data: VLT.b64.fromBuf(ciphertext), iv: VLT.b64.fromBuf(iv) });
    return { passwordless: true };
  }

  // PRF выдаёт 32+ байт "сырой" случайности — прогоняем через HKDF/SHA-256,
  // чтобы гарантированно получить корректный 256-битный ключ AES-GCM
  async function deriveAesKeyFromPrf(prfResultBuffer) {
    const hash = await crypto.subtle.digest('SHA-256', prfResultBuffer);
    return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /**
   * Вход по биометрии без пароля и без логина. username передавать не нужно —
   * он остался только как fallback для ключей, зарегистрированных до перехода
   * на discoverable credentials. Возвращает { token, username, kdfSalt,
   * masterKey } либо бросает ошибку с понятным пользователю текстом.
   */
  async function login(username) {
    if (!supportsWebAuthn()) {
      throw new Error('Этот браузер не поддерживает вход по биометрии');
    }
    const { options, challengeId } = await API.webauthnLoginOptions(username);
    const saltBuffer = await fetchPrfSaltBuffer();
    injectPrfEval(options, saltBuffer);

    const assertionResponse = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    return finishAssertion(assertionResponse, challengeId);
  }

  /**
   * Тот же вход, но через "conditional UI": браузер сам предлагает ключ
   * доступа прямо в поле логина, без нажатия кнопки. Церемония висит в
   * фоне, пока пользователь не выберет ключ (или пока её не прервёт другой
   * вызов WebAuthn — тогда промис отклоняется с AbortError).
   */
  async function loginWithAutofill() {
    if (!supportsWebAuthn()) {
      throw new Error('Этот браузер не поддерживает вход по биометрии');
    }
    const { options, challengeId } = await API.webauthnLoginOptions();
    const saltBuffer = await fetchPrfSaltBuffer();
    injectPrfEval(options, saltBuffer);

    const assertionResponse = await SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: options,
      useBrowserAutofill: true,
    });
    return finishAssertion(assertionResponse, challengeId);
  }

  function supportsAutofill() {
    if (!supportsWebAuthn()) return Promise.resolve(false);
    return SimpleWebAuthnBrowser.browserSupportsWebAuthnAutofill();
  }

  // Общий хвост обоих сценариев: сервер проверяет подпись и отдаёт обёрнутый
  // мастер-ключ, а мы распаковываем его PRF-секретом уже здесь, на устройстве.
  async function finishAssertion(assertionResponse, challengeId) {
    const result = await API.webauthnLoginVerify(assertionResponse, challengeId);

    const prfResult = assertionResponse.clientExtensionResults && assertionResponse.clientExtensionResults.prf && assertionResponse.clientExtensionResults.prf.results && assertionResponse.clientExtensionResults.prf.results.first;
    if (!prfResult) {
      throw new Error('Это устройство не смогло разблокировать шифрование по биометрии. Войдите паролем.');
    }
    const wrapKey = await deriveAesKeyFromPrf(prfResult);
    const rawMaster = await VLT.decryptBuffer(wrapKey, VLT.b64.toBuf(result.wrappedMasterKey.iv), VLT.b64.toBuf(result.wrappedMasterKey.data));
    const masterKey = await VLT.importKeyRaw(rawMaster);
    return { token: result.token, username: result.username, kdfSalt: result.kdfSalt, masterKey };
  }

  return { supportsWebAuthn, supportsAutofill, enroll, login, loginWithAutofill };
})();
