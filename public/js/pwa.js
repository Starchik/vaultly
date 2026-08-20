if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // офлайн-режим не критичен для работы приложения — тихо пропускаем
    });
  });
}
