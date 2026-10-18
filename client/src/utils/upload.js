const CHUNK_SIZE = 5 * 1024 * 1024; // debe coincidir con CHUNK_SIZE del servidor
// Igual que AuthContext.jsx: en un deploy con cliente y API en dominios distintos
// (VITE_API_URL seteado), las rutas relativas pegarían contra el origen del cliente.
const API_BASE = import.meta.env.VITE_API_URL || '';

async function parseError(res) {
  try {
    const data = await res.json();
    return data?.error || `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
}

// Sube un video en partes de 5MB: si se corta la conexión a mitad de camino, reintenta
// la parte en curso (hasta 3 veces) en vez de perder todo el archivo. Cancelable via signal.
//
// Con R2, /init devuelve una URL firmada por parte y cada una se manda DIRECTO a R2 — el servidor
// de Render ya no ve ni reenvía ningún byte del video. Antes cada parte viajaba Cliente → Render →
// R2 (el chunk se mandaba acá y el servidor lo reenviaba a R2), y ESE reenvío contaba como tráfico
// saliente de Render: con uso real de una agencia de video, agotaba el bandwidth gratuito del plan
// en días. Sin R2 (dev local), /init no manda partUrls y se sigue usando el camino viejo
// (POST de cada chunk al servidor), que sigue haciendo falta para guardar en disco.
export async function uploadVideoChunked({ file, projectId, title, version, taskId, stackWith, token, onProgress, signal }) {
  const initRes = await fetch(`${API_BASE}/api/projects/${projectId}/videos/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ originalName: file.name, mimetype: file.type, fileSize: file.size, title, version, task_id: taskId || null, stack_with: stackWith || null }),
    signal
  });
  if (!initRes.ok) throw new Error(await parseError(initRes));
  const { uploadId, partUrls } = await initRes.json();

  // El cleanup (DELETE de la sesión) cubre TODO lo que puede fallar después del init, incluido
  // el /complete final — cancelar justo mientras se está completando dejaba el temporal (o el
  // multipart upload abierto en R2) huérfano porque el fetch de /complete estaba fuera de este try.
  try {
    if (partUrls) {
      const parts = await uploadPartsDirectToR2(file, partUrls, signal, onProgress);
      const completeRes = await fetch(`${API_BASE}/api/videos/upload/${uploadId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ parts }),
        signal
      });
      if (!completeRes.ok) throw new Error(await parseError(completeRes));
      return await completeRes.json();
    }

    let offset = 0;
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      let attempt = 0;
      let advanced = false;
      while (!advanced) {
        try {
          const res = await fetch(`${API_BASE}/api/videos/upload/${uploadId}/chunk?offset=${offset}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
            body: chunk,
            signal
          });
          if (res.status === 409) {
            offset = (await res.json()).expectedOffset; // resync: re-cortar desde donde quedó el servidor
            advanced = true;
            break;
          }
          if (!res.ok) throw new Error(await parseError(res));
          offset = (await res.json()).receivedBytes;
          onProgress?.(Math.min(100, Math.round((offset / file.size) * 100)));
          advanced = true;
        } catch (e) {
          if (signal?.aborted) throw e;
          attempt++;
          if (attempt > 3) throw e;
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }

    const completeRes = await fetch(`${API_BASE}/api/videos/upload/${uploadId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal
    });
    if (!completeRes.ok) throw new Error(await parseError(completeRes));
    return await completeRes.json();
  } catch (e) {
    fetch(`${API_BASE}/api/videos/upload/${uploadId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    throw e;
  }
}

// Sube cada parte directo a su URL firmada de R2 (PUT, sin pasar por Render) y devuelve
// [{PartNumber, ETag}, ...] para que /complete pueda cerrar el multipart upload. Reintenta cada
// parte hasta 3 veces — subir dos veces la misma parte a R2 simplemente la pisa (incluida en el
// propio protocolo de multipart upload de S3/R2), así que no hace falta lógica extra de resync
// como la que sí necesita el camino viejo (ahí el servidor llevaba la cuenta de offset; acá cada
// parte es independiente).
async function uploadPartsDirectToR2(file, partUrls, signal, onProgress) {
  const parts = [];
  let uploadedBytes = 0;
  for (let i = 0; i < partUrls.length; i++) {
    const partNumber = i + 1;
    const start = i * CHUNK_SIZE;
    const chunk = file.slice(start, start + CHUNK_SIZE);
    let attempt = 0;
    for (;;) {
      try {
        const res = await fetch(partUrls[i], { method: 'PUT', body: chunk, signal });
        if (!res.ok) throw new Error(`Error ${res.status} subiendo la parte ${partNumber}`);
        // R2/S3 siempre trae ETag en la respuesta de un PUT de parte — se manda tal cual (con sus
        // comillas) de vuelta en /complete, es el formato que CompleteMultipartUpload espera.
        const etag = res.headers.get('ETag');
        if (!etag) throw new Error(`R2 no devolvió ETag para la parte ${partNumber}`);
        parts.push({ PartNumber: partNumber, ETag: etag });
        uploadedBytes += chunk.size;
        onProgress?.(Math.min(100, Math.round((uploadedBytes / file.size) * 100)));
        break;
      } catch (e) {
        if (signal?.aborted) throw e;
        attempt++;
        if (attempt > 3) throw e;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return parts;
}

// Captura un frame del video como miniatura, 100% en el navegador de quien sube — nunca hace
// falta procesar el video en el servidor (no hay ffmpeg instalado). Se busca 1 segundo adentro
// (o la mitad de la duración si el video dura menos) para evitar frames negros de fade-in típicos
// del primer instante. Best-effort: si algo falla acá, la subida del video en sí no se ve afectada.
export function captureVideoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;
    const cleanup = () => URL.revokeObjectURL(url);
    const fail = (e) => { cleanup(); reject(e instanceof Error ? e : new Error('No se pudo generar la miniatura')); };
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, (video.duration || 1) / 2);
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 360;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => { cleanup(); blob ? resolve(blob) : reject(new Error('No se pudo generar la miniatura')); }, 'image/jpeg', 0.8);
      } catch (e) { fail(e); }
    };
    video.onerror = fail;
  });
}

// Subida simple (un solo request) con progreso y cancelación, para adjuntos de chat
// que no necesitan reanudarse por partes (imágenes, audios, PDFs — normalmente chicos).
export function uploadWithProgress(url, file, token, { onProgress, xhrRef, fieldName = 'file' } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (xhrRef) xhrRef.current = xhr;
    xhr.open('POST', `${API_BASE}${url}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `Error ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Error de red al subir el archivo'));
    xhr.onabort = () => { const e = new Error('Subida cancelada'); e.name = 'AbortError'; reject(e); };
    const formData = new FormData();
    formData.append(fieldName, file);
    xhr.send(formData);
  });
}
