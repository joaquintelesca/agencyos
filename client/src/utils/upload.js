const CHUNK_SIZE = 5 * 1024 * 1024; // debe coincidir con CHUNK_SIZE del servidor

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
export async function uploadVideoChunked({ file, projectId, title, version, taskId, stackWith, token, onProgress, signal }) {
  const initRes = await fetch(`/api/projects/${projectId}/videos/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ originalName: file.name, mimetype: file.type, fileSize: file.size, title, version, task_id: taskId || null, stack_with: stackWith || null }),
    signal
  });
  if (!initRes.ok) throw new Error(await parseError(initRes));
  const { uploadId } = await initRes.json();

  try {
    let offset = 0;
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      let attempt = 0;
      let advanced = false;
      while (!advanced) {
        try {
          const res = await fetch(`/api/videos/upload/${uploadId}/chunk?offset=${offset}`, {
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
  } catch (e) {
    fetch(`/api/videos/upload/${uploadId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    throw e;
  }

  const completeRes = await fetch(`/api/videos/upload/${uploadId}/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal
  });
  if (!completeRes.ok) throw new Error(await parseError(completeRes));
  return completeRes.json();
}

// Subida simple (un solo request) con progreso y cancelación, para adjuntos de chat
// que no necesitan reanudarse por partes (imágenes, audios, PDFs — normalmente chicos).
export function uploadWithProgress(url, file, token, { onProgress, xhrRef, fieldName = 'file' } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (xhrRef) xhrRef.current = xhr;
    xhr.open('POST', url);
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
