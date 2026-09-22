import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useUndo } from '../context/UndoContext';
import { useAlert } from '../context/AlertContext';
import { initials } from '../utils/format';
import { uploadVideoChunked, captureVideoThumbnail } from '../utils/upload';
import VideoPlayerAnnotator, { formatTime } from './VideoPlayerAnnotator';
import VideoCompareModal from './VideoCompareModal';
import MentionInput, { renderMentions } from './MentionInput';
import useNarrowViewport from '../hooks/useNarrowViewport';
import useModalA11y from '../hooks/useModalA11y';

export default function VideoReview({ projectId, tasks = [], uploadForTaskId, onUploadForTaskHandled, initialVideoId }) {
  const { api, user, socket, mediaUrl, token } = useAuth();
  const { scheduleDelete } = useUndo();
  const { alert, confirm } = useAlert();
  // El panel de comentarios (320px fijo) al lado del video no entra en un celular — abajo de este
  // ancho se apilan: video arriba, comentarios abajo con su propia altura y scroll.
  const isNarrowViewport = useNarrowViewport();
  const [videos, setVideos] = useState([]);
  const [selectedVideo, setSelectedVideo] = useState(null);
  // Para el autocompletado de @menciones en el composer de comentarios (ver MentionInput).
  const [members, setMembers] = useState([]);
  const appliedInitialVideoRef = useRef(null);
  const [comments, setComments] = useState([]);
  const [showUpload, setShowUpload] = useState(false);
  const [shareModal, setShareModal] = useState(false);
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [share, setShare] = useState(undefined); // undefined = sin cargar, null = sin link activo
  const [shareDays, setShareDays] = useState(30);
  const [shareBusy, setShareBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadForm, setUploadForm] = useState({ title: '', version: '', task_id: '' });
  const [uploadFile, setUploadFile] = useState(null);
  const uploadAbortRef = useRef(null);

  // El reproductor+dibujo+timeline+compositor de comentario viven en VideoPlayerAnnotator
  // (compartido con PublicReview.jsx, el link de revisión sin cuenta) — acá solo queda la
  // referencia para pedirle el estado del borrador antes de navegar a otro video.
  const playerRef = useRef(null);

  const [activeComment, setActiveComment] = useState(null);
  const [filter, setFilter] = useState('all');
  const [editingComment, setEditingComment] = useState(null); // comment id
  const [editText, setEditText] = useState('');
  const [replyingTo, setReplyingTo] = useState(null); // comment id
  const [replyText, setReplyText] = useState('');
  const [replyFiles, setReplyFiles] = useState([]);
  const replyFileRef = useRef(null);

  // Stack / drag-and-drop state
  const [dragVideoId, setDragVideoId] = useState(null);
  const [dragOverTarget, setDragOverTarget] = useState(null);
  const [expandedGroup, setExpandedGroup] = useState(null);
  // El drag-and-drop nativo (draggable/onDragStart) no dispara en touch — para apilar videos
  // desde el celular usamos un long-press manual: mantener 350ms sin moverse activa el arrastre,
  // después seguimos el dedo con elementFromPoint. justDraggedRef evita que el "click" fantasma
  // que dispara el navegador al soltar el touch abra el video en vez de soltar el drag.
  const touchStartRef = useRef({ x: 0, y: 0, videoId: null });
  const dragActiveRef = useRef(false);
  const longPressTimerRef = useRef(null);
  const justDraggedRef = useRef(false);

  const reloadVideos = useCallback(() => {
    api(`/api/projects/${projectId}/videos`).then(setVideos).catch(console.error);
  }, [projectId]);

  useEffect(() => { reloadVideos(); }, [reloadVideos]);

  useEffect(() => {
    api(`/api/projects/${projectId}/members`).then(setMembers).catch(console.error);
  }, [projectId]);

  useEffect(() => () => clearTimeout(longPressTimerRef.current), []);

  useEffect(() => {
    if (!socket) return;
    const onVideoUpdated = (data) => { if (data.projectId === projectId) reloadVideos(); };
    // Otro usuario (admin o el editor que lo subió) puede borrar un video mientras esta
    // pantalla está abierta — lo sacamos de la grilla y cerramos su vista si era el seleccionado.
    const onVideoDeleted = (data) => {
      if (data.projectId !== projectId) return;
      setVideos(prev => prev.filter(v => v.id !== data.id));
      setSelectedVideo(prev => (prev && prev.id === data.id) ? null : prev);
    };
    socket.on('video:updated', onVideoUpdated);
    socket.on('video:deleted', onVideoDeleted);
    // Tras una reconexión (WiFi cortado, laptop cerrada) pueden haber quedado videos o
    // comentarios sin enterarse — reloadVideos() dispara también el refetch de comentarios
    // del video seleccionado, porque ese efecto depende de [selectedVideo, videos].
    socket.on('connect', reloadVideos);
    return () => { socket.off('video:updated', onVideoUpdated); socket.off('video:deleted', onVideoDeleted); socket.off('connect', reloadVideos); };
  }, [socket, projectId, reloadVideos]);

  // Deep link desde una notificación (?tab=videos&video=X): seleccionar ese video apenas cargue.
  useEffect(() => {
    if (!initialVideoId || appliedInitialVideoRef.current === initialVideoId) return;
    const v = videos.find(x => x.id === initialVideoId);
    if (v) { setSelectedVideo(v); appliedInitialVideoRef.current = initialVideoId; }
  }, [initialVideoId, videos]);

  // selectedVideo es una copia tomada en el momento del click — un `reloadVideos()` disparado por
  // otra sesión (por ejemplo, alguien más aprobando el mismo video) actualiza `videos` pero no esta
  // copia. La sincroniza con lo último que llegó del server sin perder la selección.
  useEffect(() => {
    if (!selectedVideo) return;
    const fresh = videos.find(v => v.id === selectedVideo.id);
    if (fresh && fresh !== selectedVideo) setSelectedVideo(fresh);
  }, [videos, selectedVideo]);

  const gridItems = useMemo(() => {
    const groups = {};
    const standalone = [];
    videos.forEach(v => {
      if (v.group_id) {
        if (!groups[v.group_id]) groups[v.group_id] = [];
        groups[v.group_id].push(v);
      } else {
        standalone.push(v);
      }
    });
    Object.values(groups).forEach(g => g.sort((a, b) => b.version - a.version));
    const items = [];
    Object.entries(groups).forEach(([gid, vids]) => {
      items.push({ type: 'stack', groupId: gid, videos: vids, latest: vids[0] });
    });
    standalone.forEach(v => items.push({ type: 'single', video: v }));
    return items;
  }, [videos]);

  useEffect(() => {
    if (!selectedVideo) return;
    // Si el usuario cambia de video antes de que responda el servidor, descartamos la respuesta
    // vieja para no mostrar comentarios de un video distinto al que está seleccionado ahora.
    let cancelled = false;
    api(`/api/videos/${selectedVideo.id}/comments`).then(c => { if (!cancelled) setComments(c); }).catch(console.error);
    return () => { cancelled = true; };
  }, [selectedVideo, videos]);

  useEffect(() => {
    if (!socket) return;
    const onComment = (c) => {
      if (c.video_id === selectedVideo?.id) {
        setComments(prev => {
          if (prev.find(x => x.id === c.id)) return prev;
          return [...prev, c];
        });
      }
    };
    const onCommentDel = ({ id }) => setComments(prev => prev.filter(c => c.id !== id));
    const onCommentResolved = ({ id, resolved }) => setComments(prev => prev.map(c => c.id === id ? { ...c, resolved } : c));
    const onCommentUpdated = ({ id, content }) => setComments(prev => prev.map(c => c.id === id ? { ...c, content } : c));
    const onReply = (reply) => setComments(prev => prev.map(c => c.id === reply.comment_id ? { ...c, replies: [...(c.replies || []), reply] } : c));
    socket.on('comment:created', onComment);
    socket.on('comment:deleted', onCommentDel);
    socket.on('comment:resolved', onCommentResolved);
    socket.on('comment:updated', onCommentUpdated);
    socket.on('comment:reply', onReply);
    return () => { socket.off('comment:created', onComment); socket.off('comment:deleted', onCommentDel); socket.off('comment:resolved', onCommentResolved); socket.off('comment:updated', onCommentUpdated); socket.off('comment:reply', onReply); };
  }, [socket, selectedVideo?.id]);

  useEffect(() => {
    if (uploadForTaskId) {
      setSelectedVideo(null);
      setUploadForm(prev => ({ ...prev, task_id: uploadForTaskId }));
      setShowUpload(true);
      onUploadForTaskHandled?.();
    }
  }, [uploadForTaskId]);


  const deleteComment = (cid) => {
    const comment = comments.find(c => c.id === cid);
    if (!comment) return;
    setComments(prev => prev.filter(c => c.id !== cid));
    scheduleDelete('Comentario eliminado', {
      onCommit: async () => {
        try {
          await api(`/api/comments/${cid}`, { method: 'DELETE' });
        } catch (e) {
          // 404: alguien más ya lo borró mientras tanto — no es un error real, ya está afuera
          // de la lista local como se buscaba.
          if (e.status === 404) return;
          throw e;
        }
      },
      onUndo: () => setComments(prev => [...prev, comment])
    });
  };
  const resolveComment = async (cid) => {
    try {
      const updated = await api(`/api/comments/${cid}/resolve`, { method: 'PATCH' });
      setComments(prev => prev.map(c => c.id === cid ? { ...c, resolved: updated.resolved } : c));
    } catch (e) {
      if (e.status === 404) { setComments(prev => prev.filter(c => c.id !== cid)); return; }
      console.error(e); await alert('Error al resolver el comentario: ' + e.message);
    }
  };

  // Solo actualiza `videos` — el efecto de sincronización de acá arriba se encarga de reflejarlo
  // en `selectedVideo` (evita mantener el mismo patch en dos lugares distintos).
  const approveVideo = async () => {
    try {
      await api(`/api/videos/${selectedVideo.id}/approve`, { method: 'PATCH' });
      const patch = { approved_at: new Date().toISOString(), approved_by_name: user.name };
      setVideos(prev => prev.map(v => v.id === selectedVideo.id ? { ...v, ...patch } : v));
    } catch (e) { console.error(e); await alert('No se pudo aprobar el video: ' + e.message); }
  };
  const unapproveVideo = async () => {
    try {
      await api(`/api/videos/${selectedVideo.id}/approve`, { method: 'DELETE' });
      const patch = { approved_at: null, approved_by_name: null };
      setVideos(prev => prev.map(v => v.id === selectedVideo.id ? { ...v, ...patch } : v));
    } catch (e) { console.error(e); await alert('No se pudo quitar la aprobación: ' + e.message); }
  };

  const startEditComment = (c) => { setEditingComment(c.id); setEditText(c.content); };
  const saveEditComment = async (cid) => {
    if (!editText.trim()) return;
    try {
      const updated = await api(`/api/comments/${cid}`, { method: 'PATCH', body: { content: editText } });
      setComments(prev => prev.map(c => c.id === cid ? { ...c, content: updated.content } : c));
      setEditingComment(null);
    } catch (e) {
      if (e.status === 404) { setComments(prev => prev.filter(c => c.id !== cid)); setEditingComment(null); return; }
      console.error(e); await alert('Error al editar el comentario: ' + e.message);
    }
  };

  const submitReply = async (commentId) => {
    if (!replyText.trim()) return;
    const fd = new FormData();
    fd.append('content', replyText);
    replyFiles.forEach(f => fd.append('attachments', f));
    setReplyText('');
    setReplyFiles([]);
    if (replyFileRef.current) replyFileRef.current.value = '';
    setReplyingTo(null);
    try {
      await api(`/api/comments/${commentId}/replies`, { method: 'POST', body: fd });
      const updated = await api(`/api/videos/${selectedVideo.id}/comments`);
      setComments(updated);
    } catch (e) { console.error(e); await alert('Error al enviar la respuesta: ' + e.message); }
  };

  const uploadVideo = async () => {
    if (!uploadFile) return;
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploading(true);
    setUploadProgress(0);
    try {
      const v = await uploadVideoChunked({
        file: uploadFile,
        projectId,
        title: uploadForm.title || uploadFile.name,
        version: uploadForm.version || '1',
        taskId: uploadForm.task_id || null,
        stackWith: selectedVideo ? selectedVideo.id : null,
        token,
        onProgress: setUploadProgress,
        signal: controller.signal
      });
      // Best-effort: si la miniatura falla (video corrupto, navegador raro), el video ya subió
      // bien igual — no vale la pena hacer fallar toda la subida por esto.
      try {
        const thumb = await captureVideoThumbnail(uploadFile);
        const fd = new FormData();
        fd.append('thumbnail', thumb, 'thumb.jpg');
        const { thumbnail_filename } = await api(`/api/videos/${v.id}/thumbnail`, { method: 'POST', body: fd });
        v.thumbnail_filename = thumbnail_filename;
      } catch (e) { console.error('No se pudo generar la miniatura:', e); }
      setVideos(prev => [v, ...prev]);
      setSelectedVideo(v);
      setShowUpload(false);
      setUploadFile(null);
      setUploadForm({ title: '', version: '', task_id: '' });
      reloadVideos();
    } catch (e) {
      if (e.name !== 'AbortError') { console.error(e); await alert('Error al subir el video: ' + e.message); }
    } finally {
      setUploading(false);
      setUploadProgress(0);
      uploadAbortRef.current = null;
    }
  };

  const cancelUpload = () => { uploadAbortRef.current?.abort(); };

  const handleDrop = async (targetVideoId) => {
    if (!dragVideoId || dragVideoId === targetVideoId) return;
    setDragOverTarget(null);
    setDragVideoId(null);
    try {
      await api(`/api/videos/${dragVideoId}/stack`, { method: 'PATCH', body: { targetVideoId } });
      reloadVideos();
    } catch (e) { console.error(e); await alert('Error al agrupar los videos: ' + e.message); }
  };

  const deleteVideo = (v) => {
    setVideos(prev => prev.filter(x => x.id !== v.id));
    setSelectedVideo(prev => (prev && prev.id === v.id) ? null : prev);
    scheduleDelete('Video eliminado', {
      onCommit: async () => {
        try {
          await api(`/api/videos/${v.id}`, { method: 'DELETE' });
        } catch (e) {
          if (e.status === 404) return;
          throw e;
        }
      },
      onUndo: () => setVideos(prev => [v, ...prev])
    });
  };

  const openShareModal = async () => {
    setShareModal(true);
    setShare(undefined);
    try {
      setShare(await api(`/api/videos/${selectedVideo.id}/share`));
    } catch (e) { console.error(e); setShare(null); }
  };

  const createShare = async () => {
    setShareBusy(true);
    try {
      setShare(await api(`/api/videos/${selectedVideo.id}/share`, { method: 'POST', body: { expiresInDays: shareDays } }));
    } catch (e) { console.error(e); await alert('No se pudo generar el link: ' + e.message); }
    finally { setShareBusy(false); }
  };

  const revokeShare = async () => {
    if (!share || !await confirm('¿Desactivar este link? El cliente ya no va a poder abrirlo.', { confirmText: 'Desactivar', danger: true })) return;
    setShareBusy(true);
    try {
      await api(`/api/video-shares/${share.id}/revoke`, { method: 'PATCH' });
      setShare(null);
    } catch (e) { console.error(e); await alert('No se pudo desactivar el link: ' + e.message); }
    finally { setShareBusy(false); }
  };

  const handleUnstack = async (videoId) => {
    try {
      await api(`/api/videos/${videoId}/unstack`, { method: 'PATCH' });
      setExpandedGroup(null);
      reloadVideos();
    } catch (e) { console.error(e); await alert('Error al desagrupar el video: ' + e.message); }
  };

  const stackShadow = (count) => {
    const layers = [];
    const n = Math.min(count - 1, 3);
    for (let i = 1; i <= n; i++) {
      layers.push(`${i * 6}px ${i * 6}px 0 -1px var(--bg2)`);
      layers.push(`${i * 6}px ${i * 6}px 0 0.5px var(--text3)`);
    }
    return layers.join(', ');
  };

  const cardDragProps = (videoId) => ({
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.setData('text/plain', videoId); e.dataTransfer.effectAllowed = 'move'; setDragVideoId(videoId); },
    onDragEnd: () => { setDragVideoId(null); setDragOverTarget(null); },
  });

  const dropTargetProps = (videoId) => ({
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragVideoId && dragVideoId !== videoId) setDragOverTarget(videoId); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverTarget(null); },
    onDrop: (e) => { e.preventDefault(); handleDrop(videoId); },
  });

  const LONG_PRESS_MS = 350;
  const MOVE_CANCEL_PX = 10;

  const touchDragProps = (videoId) => ({
    'data-video-id': videoId,
    onTouchStart: (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      touchStartRef.current = { x: t.clientX, y: t.clientY, videoId };
      dragActiveRef.current = false;
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        dragActiveRef.current = true;
        setDragVideoId(videoId);
        if (navigator.vibrate) navigator.vibrate(15);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e) => {
      const t = e.touches[0];
      if (!t) return;
      if (!dragActiveRef.current) {
        const dx = t.clientX - touchStartRef.current.x;
        const dy = t.clientY - touchStartRef.current.y;
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) clearTimeout(longPressTimerRef.current);
        return;
      }
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const targetId = el?.closest('[data-video-id]')?.getAttribute('data-video-id');
      setDragOverTarget(targetId && targetId !== touchStartRef.current.videoId ? targetId : null);
    },
    onTouchEnd: (e) => {
      clearTimeout(longPressTimerRef.current);
      if (dragActiveRef.current) {
        justDraggedRef.current = true;
        setTimeout(() => { justDraggedRef.current = false; }, 300);
        const t = e.changedTouches[0];
        const el = t && document.elementFromPoint(t.clientX, t.clientY);
        const targetId = el?.closest('[data-video-id]')?.getAttribute('data-video-id');
        if (targetId && targetId !== touchStartRef.current.videoId) handleDrop(targetId);
        else { setDragVideoId(null); setDragOverTarget(null); }
      }
      dragActiveRef.current = false;
    },
  });

  const renderVideoCard = (v, { isDragOver, isExpanded } = {}) => (
    <div
      className="video-card"
      {...cardDragProps(v.id)}
      {...dropTargetProps(v.id)}
      {...touchDragProps(v.id)}
      onClick={() => { if (justDraggedRef.current) return; setSelectedVideo(v); }}
      style={{ position: 'relative', background: 'var(--bg2)', border: `2px solid ${isDragOver ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 12, padding: 16, cursor: dragVideoId ? 'grabbing' : 'pointer', transition: 'border-color 0.15s, box-shadow 0.15s', opacity: dragVideoId === v.id ? 0.4 : 1, touchAction: dragVideoId ? 'none' : 'auto' }}
      onMouseEnter={e => { if (!isDragOver && !dragVideoId) e.currentTarget.style.borderColor = 'var(--accent)'; }}
      onMouseLeave={e => { if (!isDragOver) e.currentTarget.style.borderColor = 'var(--border)'; }}>
      {(user.role === 'admin' || v.uploaded_by === user.id) && (
        <button
          className="video-delete-btn"
          onClick={e => { e.stopPropagation(); deleteVideo(v); }}
          title="Eliminar video"
          aria-label="Eliminar video"
          style={{ position: 'absolute', top: 10, right: 10, zIndex: 1, width: 26, height: 26, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          🗑
        </button>
      )}
      <div style={{ width: '100%', paddingBottom: '56%', background: 'var(--bg4)', borderRadius: 8, marginBottom: 10, position: 'relative', overflow: 'hidden' }}>
        {v.thumbnail_filename
          ? <img src={mediaUrl(`/uploads/${v.thumbnail_filename}`)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>▶️</div>}
        {v.approved_at && (
          <div title={`Aprobado${v.approved_by_name ? ` por ${v.approved_by_name}` : ''}`}
            style={{ position: 'absolute', bottom: 6, left: 6, width: 20, height: 20, borderRadius: '50%', background: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 700 }}>
            ✓
          </div>
        )}
      </div>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{v.title}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="badge" style={{ padding: '2px 7px', background: 'var(--accent-glow)', color: 'var(--accent2)', fontWeight: 700 }}>v{v.version}</span>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{v.uploader_name}</span>
      </div>
      {v.task_title && (
        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ flexShrink: 0 }}>📋</span> {v.task_title}
        </div>
      )}
      {isExpanded && (
        <button className="btn-outline" onClick={e => { e.stopPropagation(); handleUnstack(v.id); }}
          style={{ marginTop: 8, width: '100%', borderRadius: 6, padding: '4px 0', color: 'var(--text3)', fontSize: 11 }}>
          Desapilar
        </button>
      )}
    </div>
  );

  const uploadModalRef = useModalA11y(showUpload, () => { if (!uploading) setShowUpload(false); });
  const shareModalRef = useModalA11y(shareModal, () => setShareModal(false));

  // ─── VIDEO LIST ──────────────────────────────────────────────────────────────
  if (!selectedVideo) {
    return (
      <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ fontWeight: 700, fontSize: 18 }}>Videos del proyecto</h3>
          <button className="btn btn-primary" onClick={() => setShowUpload(true)}>⬆ Subir video</button>
        </div>
        {videos.length === 0 && (
          <div className="empty"><div className="empty-icon">🎬</div><p>Sin videos todavía</p><p>Subí el primer video para empezar el feedback</p></div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 20 }}>
          {gridItems.map(item => {
            if (item.type === 'single') {
              return <div key={item.video.id}>{renderVideoCard(item.video, { isDragOver: dragOverTarget === item.video.id })}</div>;
            }
            const isExpanded = expandedGroup === item.groupId;
            const stackDragOver = !isExpanded && dragOverTarget === item.latest.id;
            if (isExpanded) {
              return (
                <div key={item.groupId} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>{item.videos.length} versiones</span>
                    <button className="btn-outline" onClick={() => setExpandedGroup(null)}
                      style={{ borderRadius: 6, padding: '2px 8px', fontSize: 11, color: 'var(--text3)' }}>
                      Colapsar
                    </button>
                  </div>
                  {item.videos.map(v => renderVideoCard(v, { isDragOver: dragOverTarget === v.id, isExpanded: true }))}
                </div>
              );
            }
            return (
              <div key={item.groupId}
                {...dropTargetProps(item.latest.id)}
                {...cardDragProps(item.latest.id)}
                {...touchDragProps(item.latest.id)}
                onClick={() => { if (justDraggedRef.current) return; setSelectedVideo(item.latest); }}
                style={{
                  background: 'var(--bg2)', borderRadius: 12, padding: 16,
                  cursor: dragVideoId ? 'grabbing' : 'pointer', transition: 'border-color 0.15s, box-shadow 0.15s',
                  border: `2px solid ${stackDragOver ? 'var(--accent)' : 'var(--border)'}`,
                  boxShadow: stackShadow(item.videos.length),
                  marginBottom: Math.min(item.videos.length - 1, 3) * 6,
                  marginRight: Math.min(item.videos.length - 1, 3) * 6,
                  opacity: dragVideoId === item.latest.id ? 0.4 : 1,
                  touchAction: dragVideoId ? 'none' : 'auto',
                }}
                onMouseEnter={e => { if (!stackDragOver && !dragVideoId) e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onMouseLeave={e => { if (!stackDragOver) e.currentTarget.style.borderColor = 'var(--border)'; }}>
                <div style={{ width: '100%', paddingBottom: '56%', background: 'var(--bg4)', borderRadius: 8, marginBottom: 10, position: 'relative', overflow: 'hidden' }}>
                  {item.latest.thumbnail_filename
                    ? <img src={mediaUrl(`/uploads/${item.latest.thumbnail_filename}`)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>▶️</div>}
                </div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{item.latest.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span className="badge" style={{ padding: '2px 7px', background: 'var(--accent-glow)', color: 'var(--accent2)', fontWeight: 700 }}>v{item.latest.version}</span>
                    <button onClick={e => { e.stopPropagation(); setExpandedGroup(item.groupId); }}
                      style={{ fontSize: 10, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '2px 7px', color: 'var(--text2)', cursor: 'pointer', fontWeight: 600 }}>
                      {item.videos.length} versiones
                    </button>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>{item.latest.uploader_name}</span>
                </div>
                {item.latest.task_title && (
                  <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ flexShrink: 0 }}>📋</span> {item.latest.task_title}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {showUpload && (
          <div className="modal-overlay">
            <div className="modal" onClick={e => e.stopPropagation()} ref={uploadModalRef} role="dialog" aria-modal="true" aria-labelledby="upload-modal-title">
              {!uploading && <button className="modal-close" onClick={() => setShowUpload(false)} title="Cerrar" aria-label="Cerrar">✕</button>}
              <h2 id="upload-modal-title">Subir video</h2>
              <div className="form-group">
                <label>Archivo de video</label>
                <input type="file" accept="video/*" onChange={e => setUploadFile(e.target.files[0])} style={{ color: 'var(--text)', fontSize: 13 }} />
              </div>
              <div className="form-group">
                <label>Título</label>
                <input className="input" value={uploadForm.title} onChange={e => setUploadForm(p => ({ ...p, title: e.target.value }))} placeholder="ej: comercial_verano" />
              </div>
              <div className="form-group">
                <label>Versión</label>
                <input className="input" value={uploadForm.version} onChange={e => setUploadForm(p => ({ ...p, version: e.target.value }))} placeholder="ej: v1, v2, v3..." />
              </div>
              {tasks.length > 0 && (
                <div className="form-group">
                  <label>Tarea asociada</label>
                  <select className="input" value={uploadForm.task_id} onChange={e => setUploadForm(p => ({ ...p, task_id: e.target.value }))}>
                    <option value="">Sin tarea</option>
                    {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                </div>
              )}
              {uploading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <div style={{ flex: 1, height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text3)', minWidth: 32, textAlign: 'right' }}>{uploadProgress}%</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" onClick={() => uploading ? cancelUpload() : setShowUpload(false)}>
                  {uploading ? 'Cancelar subida' : 'Cancelar'}
                </button>
                <button className="btn btn-primary" onClick={uploadVideo} disabled={!uploadFile || uploading}>
                  {uploading ? `⏳ Subiendo... ${uploadProgress}%` : '⬆ Subir'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── PLAYER VIEW ─────────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>

      {/* Top bar: back, version dropdown, title */}
      <div style={{ padding: '8px 14px', background: 'var(--bg2)', borderBottom: `1px solid var(--border)`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <button onClick={async () => { if (await (playerRef.current?.confirmDiscardDraft() ?? true)) setSelectedVideo(null); }}
          style={{ background: 'transparent', border: `1px solid var(--border)`, borderRadius: 6, padding: '4px 10px', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>
          ← Volver
        </button>
        {/* Version selector */}
        <select value={selectedVideo.id}
          onChange={async e => { if (!(await (playerRef.current?.confirmDiscardDraft() ?? true))) return; const v = videos.find(x => x.id === e.target.value); if (v) setSelectedVideo(v); }}
          style={{ background: 'var(--bg3)', border: `1px solid var(--border)`, borderRadius: 7, color: 'var(--text)', fontSize: 12, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>
          {/* All versions of all videos — grouped by title */}
          {videos.map(v => (
            <option key={v.id} value={v.id}>{v.title} — v{v.version}</option>
          ))}
        </select>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--accent-glow)', border: `1px solid rgba(124,106,247,0.31)`, borderRadius: 6, padding: '3px 9px', fontSize: 11, color: 'var(--accent2)', fontWeight: 600 }}>
          v{selectedVideo.version}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', flex: 1 }}>{selectedVideo.title}</span>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{comments.length} comentarios</span>
        {/* Solo tiene sentido si hay al menos otra versión del mismo video (mismo group_id) —
            comparar contra un video sin relación no es lo que alguien espera de "comparar versiones". */}
        {videos.filter(v => v.group_id && v.group_id === selectedVideo.group_id).length > 1 && (
          <button onClick={() => setShowCompareModal(true)} title="Comparar con otra versión"
            style={{ background: 'transparent', border: `1px solid var(--border)`, borderRadius: 6, padding: '4px 10px', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>
            🔀 Comparar
          </button>
        )}
        {/* Admin-only a propósito, no "admin o quien subió" como Eliminar — decidir qué sale a
            un cliente externo es una decisión de la agencia, no de un editor individual. */}
        {user.role === 'admin' && (
          <button onClick={openShareModal} title="Compartir con el cliente"
            style={{ background: 'transparent', border: `1px solid var(--border)`, borderRadius: 6, padding: '4px 10px', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>
            🔗 Compartir
          </button>
        )}
        {(user.role === 'admin' || selectedVideo.uploaded_by === user.id) && (
          <button onClick={() => deleteVideo(selectedVideo)} title="Eliminar video"
            style={{ background: 'transparent', border: `1px solid var(--border)`, borderRadius: 6, padding: '4px 10px', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>
            🗑 Eliminar
          </button>
        )}
        <button className="btn btn-primary btn-sm" onClick={() => setShowUpload(true)}>⬆ Nueva versión</button>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: isNarrowViewport ? 'column' : 'row', overflow: 'hidden' }}>
        {/* LEFT (o arriba, en angosto): player + tools + timeline (compartido con PublicReview.jsx) */}
        <VideoPlayerAnnotator
          ref={playerRef}
          src={mediaUrl(`/uploads/${selectedVideo.filename}`)}
          comments={comments}
          currentUserId={user.id}
          activeComment={activeComment}
          onActiveCommentChange={setActiveComment}
          allowAttachments={true}
          members={members}
          approvedAt={selectedVideo.approved_at}
          approvedByName={selectedVideo.approved_by_name}
          onApprove={approveVideo}
          onUnapprove={unapproveVideo}
          onSubmit={async ({ content, timestampSec, timestampEnd, annotations, files }) => {
            const fd = new FormData();
            fd.append('content', content);
            fd.append('timestamp_sec', timestampSec);
            if (timestampEnd != null) fd.append('timestamp_end', timestampEnd);
            if (annotations.length > 0) fd.append('annotation', JSON.stringify(annotations));
            files.forEach(f => fd.append('attachments', f));
            await api(`/api/videos/${selectedVideo.id}/comments`, { method: 'POST', body: fd });
            const updated = await api(`/api/videos/${selectedVideo.id}/comments`);
            setComments(updated);
          }}
        />

        {/* RIGHT (o abajo, en angosto): comments panel */}
        <div style={{
          width: isNarrowViewport ? '100%' : 320, height: isNarrowViewport ? '40vh' : 'auto',
          background: 'var(--bg2)', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0,
          ...(isNarrowViewport ? { borderTop: `1px solid var(--border)` } : { borderLeft: `1px solid var(--border)` })
        }}>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid var(--border)`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Comentarios</span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{comments.length}</span>
          </div>
          <div style={{ display: 'flex', borderBottom: `1px solid var(--border)`, flexShrink: 0 }}>
            {[['all','Todos'],['pending','Pendientes'],['resolved','Hechos']].map(([val, label]) => (
              <button key={val} className="icon-btn" onClick={() => setFilter(val)}
                style={{ flex: 1, borderBottom: filter === val ? `2px solid var(--accent)` : '2px solid transparent', padding: '7px 4px', fontSize: 11, color: filter === val ? 'var(--accent2)' : 'var(--text3)', fontWeight: filter === val ? 600 : 400, transition: 'all 0.15s' }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {comments.filter(c => filter === 'all' ? true : filter === 'resolved' ? c.resolved : !c.resolved).length === 0 && (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
                <div>Pausá el video para comentar</div>
              </div>
            )}
            {[...comments].sort((a, b) => a.timestamp_sec - b.timestamp_sec)
              .filter(c => filter === 'all' ? true : filter === 'resolved' ? c.resolved : !c.resolved)
              .map(c => (
              <div key={c.id} onClick={() => playerRef.current?.jumpToComment(c)}
                style={{ padding: '8px 12px', borderBottom: `1px solid var(--bg3)`, cursor: 'pointer', background: activeComment === c.id ? 'var(--bg3)' : 'transparent', borderLeft: activeComment === c.id ? `2px solid var(--accent)` : c.resolved ? `2px solid #10b981` : '2px solid transparent', opacity: c.resolved ? 0.6 : 1, transition: 'all 0.1s' }}
                onMouseEnter={e => { if (activeComment !== c.id) e.currentTarget.style.background = 'var(--bg3)'; }}
                onMouseLeave={e => { if (activeComment !== c.id) e.currentTarget.style.background = 'transparent'; }}>
                {/* Timestamp badge */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  {c.timestamp_end != null ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(240,168,58,0.15)', color: 'var(--yellow)', fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10 }}>
                      ⬌ {formatTime(c.timestamp_sec)} → {formatTime(c.timestamp_end)}
                    </div>
                  ) : (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--accent-glow)', color: 'var(--accent2)', fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10 }}>
                      ▶ {formatTime(c.timestamp_sec)}
                    </div>
                  )}
                  <button onClick={e => { e.stopPropagation(); resolveComment(c.id); }}
                    title={c.resolved ? 'Marcar como pendiente' : 'Marcar como hecho'}
                    aria-label={c.resolved ? 'Marcar como pendiente' : 'Marcar como hecho'}
                    style={{ background: c.resolved ? '#10b98120' : 'transparent', border: `1px solid ${c.resolved ? '#10b981' : 'var(--border)'}`, borderRadius: 6, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 13, transition: 'all 0.15s', flexShrink: 0 }}>
                    {c.resolved ? '✅' : '☐'}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div className="avatar" style={{ width: 24, height: 24, background: c.avatar_color || 'var(--accent)', fontSize: 9, fontWeight: 700 }}>
                    {initials(c.user_name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                      <span style={{ fontSize: 11, color: 'var(--text2)' }}>{c.user_name}</span>
                      {/* Sin user_id es un comentario del link de revisión (cliente externo, sin
                          cuenta) — se distingue del resto para no confundirlo con feedback interno. */}
                      {!c.user_id && <span className="badge" style={{ fontSize: 9, padding: '1px 6px', background: 'var(--accent-glow)', color: 'var(--accent2)' }}>Cliente</span>}
                    </div>
                    {editingComment === c.id ? (
                      <div onClick={e => e.stopPropagation()}>
                        <textarea value={editText} onChange={e => setEditText(e.target.value)} autoFocus rows={2}
                          style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 7, padding: '6px 9px', color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', resize: 'none', outline: 'none', boxSizing: 'border-box' }}
                          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEditComment(c.id); if (e.key === 'Escape') setEditingComment(null); }} />
                        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                          <button className="btn-outline" onClick={() => setEditingComment(null)}
                            style={{ borderRadius: 6, padding: '2px 8px', color: 'var(--text2)', fontSize: 11 }}>
                            Cancelar
                          </button>
                          <button onClick={() => saveEditComment(c.id)} disabled={!editText.trim()}
                            style={{ background: 'var(--accent)', border: 'none', borderRadius: 6, padding: '2px 10px', color: '#fff', fontSize: 11, fontWeight: 600, cursor: editText.trim() ? 'pointer' : 'not-allowed', opacity: editText.trim() ? 1 : 0.5 }}>
                            Guardar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5 }}>{renderMentions(c.content)}</div>
                    )}
                    {c.annotation && <div style={{ fontSize: 10, color: 'var(--yellow)', marginTop: 3 }}>✏️ Incluye dibujo</div>}
                    {c.attachments?.length > 0 && (
                      <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {c.attachments.map(a => (
                          <a key={a.id} href={mediaUrl(`/uploads/${a.filename}`)} target="_blank" rel="noreferrer"
                            style={{ fontSize: 11, color: 'var(--accent2)', display: 'flex', alignItems: 'center', gap: 4, background: 'var(--border)', padding: '3px 7px', borderRadius: 5, textDecoration: 'none' }}
                            onClick={e => e.stopPropagation()}>
                            📎 {a.original_name}
                          </a>
                        ))}
                      </div>
                    )}
                    {/* Reply button */}
                    {editingComment !== c.id && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        <button className="icon-btn" onClick={e => { e.stopPropagation(); setReplyingTo(replyingTo === c.id ? null : c.id); setReplyText(''); setReplyFiles([]); }}
                          style={{ color: 'var(--text3)', fontSize: 11, padding: 0, display: 'flex', alignItems: 'center', gap: 3 }}
                          onMouseEnter={e => e.currentTarget.style.color = 'var(--text2)'}
                          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}>
                          ↩ Responder
                        </button>
                        {(c.user_id === user.id || user.role === 'admin') && (
                          <button className="icon-btn" onClick={e => { e.stopPropagation(); startEditComment(c); }}
                            style={{ color: 'var(--text3)', fontSize: 11, padding: 0 }}
                            onMouseEnter={e => e.currentTarget.style.color = 'var(--text2)'}
                            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}>
                            ✏️ Editar
                          </button>
                        )}
                        {(c.user_id === user.id || user.role === 'admin') && (
                          <button className="icon-btn" onClick={e => { e.stopPropagation(); deleteComment(c.id); }}
                            style={{ color: 'var(--text3)', fontSize: 11, padding: 0 }}
                            onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
                            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}>
                            🗑 Eliminar
                          </button>
                        )}
                      </div>
                    )}
                    {/* Reply thread */}
                    {c.replies?.length > 0 && (
                      <div style={{ marginTop: 8, borderTop: `1px solid var(--border)`, paddingTop: 8, display: 'flex', gap: 6 }}>
                        <div style={{ width: 1, background: 'var(--border)', flexShrink: 0, marginLeft: 10 }} />
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {c.replies.map(r => (
                            <div key={r.id} style={{ display: 'flex', gap: 7 }}>
                              <div className="avatar" style={{ width: 20, height: 20, background: r.avatar_color || 'var(--accent)', fontSize: 8, fontWeight: 700 }}>
                                {initials(r.user_name)}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>{r.user_name}</div>
                                <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.4 }}>{renderMentions(r.content)}</div>
                                {r.attachments?.length > 0 && r.attachments.map(a => (
                                  <a key={a.id} href={mediaUrl(`/uploads/${a.filename}`)} target="_blank" rel="noreferrer"
                                    style={{ fontSize: 11, color: 'var(--accent2)', display: 'flex', alignItems: 'center', gap: 3, marginTop: 3, textDecoration: 'none' }}
                                    onClick={e => e.stopPropagation()}>
                                    📎 {a.original_name}
                                  </a>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Reply input */}
                    {replyingTo === c.id && (
                      <div style={{ marginTop: 8, borderTop: `1px solid var(--border)`, paddingTop: 8 }} onClick={e => e.stopPropagation()}>
                        <MentionInput as="textarea"
                          value={replyText}
                          onChange={setReplyText}
                          members={members}
                          placeholder="Dejá tu respuesta acá... (@ para mencionar)"
                          autoFocus
                          rows={2}
                          style={{ width: '100%', background: 'var(--bg)', border: `1px solid var(--border)`, borderRadius: 7, padding: '6px 9px', color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', resize: 'none', outline: 'none', boxSizing: 'border-box' }}
                          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                          onBlur={e => e.target.style.borderColor = 'var(--border)'}
                          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitReply(c.id); }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 5 }}>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <input ref={replyFileRef} type="file" multiple style={{ display: 'none' }} onChange={e => setReplyFiles(Array.from(e.target.files))} />
                            <button className="icon-btn" onClick={() => replyFileRef.current?.click()}
                              style={{ color: replyFiles.length > 0 ? 'var(--yellow)' : 'var(--text3)', fontSize: 16, padding: '2px 4px', borderRadius: 5 }}
                              title="Adjuntar archivo" aria-label="Adjuntar archivo">📎</button>
                            {replyFiles.length > 0 && <span style={{ fontSize: 10, color: 'var(--yellow)' }}>{replyFiles.length} archivo(s)</span>}
                          </div>
                          <div style={{ display: 'flex', gap: 5 }}>
                            <button onClick={() => { setReplyingTo(null); setReplyText(''); setReplyFiles([]); }}
                              style={{ background: 'transparent', border: `1px solid var(--border)`, borderRadius: 6, padding: '3px 9px', color: 'var(--text2)', fontSize: 11, cursor: 'pointer' }}>
                              Cancelar
                            </button>
                            <button onClick={() => submitReply(c.id)} disabled={!replyText.trim()}
                              style={{ background: replyText.trim() ? 'var(--accent)' : 'var(--border)', border: 'none', borderRadius: 6, padding: '3px 10px', color: '#fff', fontSize: 11, fontWeight: 600, cursor: replyText.trim() ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: 4 }}>
                              ↑ Enviar
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Upload modal */}
      {showUpload && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} ref={uploadModalRef} role="dialog" aria-modal="true" aria-labelledby="upload-modal-title">
            {!uploading && <button className="modal-close" onClick={() => setShowUpload(false)} title="Cerrar" aria-label="Cerrar">✕</button>}
            <h2 id="upload-modal-title">Subir nueva versión</h2>
            <div className="form-group">
              <label>Archivo de video</label>
              <input type="file" accept="video/*" onChange={e => setUploadFile(e.target.files[0])} style={{ color: 'var(--text)', fontSize: 13 }} />
            </div>
            <div className="form-group">
              <label>Título</label>
              <input className="input" value={uploadForm.title} onChange={e => setUploadForm(p => ({ ...p, title: e.target.value }))} placeholder={selectedVideo?.title || 'Nombre del video'} />
            </div>
            <div className="form-group">
              <label>Versión</label>
              <input className="input" value={uploadForm.version} onChange={e => setUploadForm(p => ({ ...p, version: e.target.value }))} placeholder={`v${(selectedVideo?.version || 0) + 1}`} />
            </div>
            {tasks.length > 0 && (
              <div className="form-group">
                <label>Tarea asociada</label>
                <select className="input" value={uploadForm.task_id} onChange={e => setUploadForm(p => ({ ...p, task_id: e.target.value }))}>
                  <option value="">Sin tarea</option>
                  {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                </select>
              </div>
            )}
            {uploading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1, height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
                </div>
                <span style={{ fontSize: 11, color: 'var(--text3)', minWidth: 32, textAlign: 'right' }}>{uploadProgress}%</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => uploading ? cancelUpload() : setShowUpload(false)}>
                {uploading ? 'Cancelar subida' : 'Cancelar'}
              </button>
              <button className="btn btn-primary" onClick={uploadVideo} disabled={!uploadFile || uploading}>
                {uploading ? `⏳ Subiendo... ${uploadProgress}%` : '⬆ Subir'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Share modal — link de revisión para el cliente */}
      {shareModal && (
        <div className="modal-overlay" onClick={() => setShareModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} ref={shareModalRef} role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
            <button className="modal-close" onClick={() => setShareModal(false)} title="Cerrar" aria-label="Cerrar">✕</button>
            <h2 id="share-modal-title">Compartir con el cliente</h2>
            {share === undefined && <div style={{ padding: '20px 0', textAlign: 'center' }}><div className="spinner" /></div>}
            {share === null && (
              <>
                <p style={{ fontSize: 'var(--fs-base)', color: 'var(--text2)', lineHeight: 'var(--lh-normal)', marginBottom: 16 }}>
                  Se genera un link público para este video puntual — sin cuenta ni contraseña, el cliente puede verlo y dejar comentarios con timestamp igual que acá. No ve otros videos, tareas ni información de pago.
                </p>
                <div className="form-group">
                  <label>Vence en</label>
                  <select className="input" value={shareDays} onChange={e => setShareDays(Number(e.target.value))}>
                    <option value={7}>7 días</option>
                    <option value={30}>30 días</option>
                    <option value={90}>90 días</option>
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost" onClick={() => setShareModal(false)}>Cancelar</button>
                  <button className="btn btn-primary" onClick={createShare} disabled={shareBusy}>{shareBusy ? 'Generando...' : 'Generar link'}</button>
                </div>
              </>
            )}
            {share && (
              <>
                <div className="form-group">
                  <label>Link para el cliente</label>
                  <input className="input" readOnly value={`${window.location.origin}/review/${share.id}`}
                    onClick={e => e.target.select()} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                  <span className="badge" style={{ fontWeight: 500, background: 'rgba(34,201,122,0.12)', color: 'var(--green)' }}>✓ Activo</span>
                  <span style={{ fontSize: 12, color: 'var(--text3)' }}>vence el {new Date(share.expires_at).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-danger" onClick={revokeShare} disabled={shareBusy}>Desactivar</button>
                  <button className="btn btn-primary" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/review/${share.id}`); }}>Copiar link</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showCompareModal && (() => {
        const siblings = videos.filter(v => v.group_id && v.group_id === selectedVideo.group_id);
        const other = siblings.find(v => v.id !== selectedVideo.id) || siblings[0];
        return (
          <VideoCompareModal
            videos={siblings}
            initialLeftId={other.id}
            initialRightId={selectedVideo.id}
            mediaUrl={mediaUrl}
            onClose={() => setShowCompareModal(false)}
          />
        );
      })()}
    </div>
  );
}
