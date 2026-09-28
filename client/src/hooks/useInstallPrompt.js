import { useState, useEffect, useCallback } from 'react';

// Chrome/Android no muestra su propio banner de instalación si la app ya cumple los requisitos
// (manifest + service worker) — en cambio dispara este evento y espera que la app decida cuándo
// ofrecerlo. `preventDefault()` lo guarda para poder mostrarlo con un botón propio en vez del
// mini-infobar nativo del navegador, que es fácil de perderse o descartar sin querer. iOS Safari
// no dispara este evento nunca (no soporta beforeinstallprompt) — ahí no hay nada que ofrecer acá,
// instalar sigue siendo "Compartir → Agregar a inicio" a mano, como cualquier otra PWA en iPhone.
export default function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installed, setInstalled] = useState(
    () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true
  );

  useEffect(() => {
    const onBeforeInstall = (e) => { e.preventDefault(); setDeferredPrompt(e); };
    const onInstalled = () => { setDeferredPrompt(null); setInstalled(true); };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    // El evento solo se puede usar una vez — si el usuario lo descartó, no vuelve a aparecer
    // hasta que el navegador decida disparar beforeinstallprompt de nuevo por su cuenta.
    setDeferredPrompt(null);
  }, [deferredPrompt]);

  return { canInstall: !installed && !!deferredPrompt, promptInstall };
}
