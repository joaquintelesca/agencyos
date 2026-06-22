import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

const DARK = {
  bg0: '#0d0d0f', bg1: '#141417', bg2: '#1c1c21', bg3: '#2a2a31',
  text: '#f0f0f5', text2: '#9898a8', text3: '#5c5c70',
  accent: '#7c6af7', accentDim: '#7c6af720', accentText: '#9b8df9',
  orange: '#f0a83a', orangeDim: '#f0a83a20',
  red: '#f05c5c', border: '#2a2a31',
};

export default function VideoReview({ projectId, tasks = [], uploadForTaskId, onUploadForTaskHandled }) {
  const { api, user, socket } = useAuth();
  const [videos, setVideos] = useState([]);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [versionGroup, setVersionGroup] = useState([]); // all versions of same title
  const [comments, setComments] = useState([]);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState({ title: '', version: '', task_id: '' });
  const [uploadFile, setUploadFile] = useState(null);

  // Player state
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const playerContainerRef = useRef(null);

  // Tools
  const [tool, setTool] = useState('freehand'); // freehand | rect | arrow
  const [drawColor, setDrawColor] = useState('#f0a83a');
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [currentAnnotation, setCurrentAnnotation] = useState(null);

  // Comment state
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeStart, setRangeStart] = useState(null);
  const [rangeEnd, setRangeEnd] = useState(null);
  const [capturedTs, setCapturedTs] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [commentFiles, setCommentFiles] = useState([]);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [activeComment, setActiveComment] = useState(null);
  const [filter, setFilter] = useState('all');
  const [replyingTo, setReplyingTo] = useState(null); // comment id
  const [replyText, setReplyText] = useState('');
  const [replyFiles, setReplyFiles] = useState([]);
  const replyFileRef = useRef(null);
  const commentFileRef = useRef(null);

  useEffect(() => {
    api(`/api/projects/${projectId}/videos`).then(setVideos).catch(console.error);
  }, [projectId]);

  useEffect(() => {
    if (!selectedVideo) return;
    api(`/api/videos/${selectedVideo.id}/comments`).then(setComments).catch(console.error);
    // Build version group: same base title, different versions
    const baseName = selectedVideo.title.replace(/\s*v\d+$/i, '').trim();
    const group = videos.filter(v => v.title.replace(/\s*v\d+$/i, '').trim() === baseName || v.title === selectedVideo.title);
    setVersionGroup(group.length > 1 ? group : videos.filter(v => v.title === selectedVideo.title));
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
    const onReply = (reply) => setComments(prev => prev.map(c => c.id === reply.comment_id ? { ...c, replies: [...(c.replies || []), reply] } : c));
    socket.on('comment:created', onComment);
    socket.on('comment:deleted', onCommentDel);
    socket.on('comment:resolved', onCommentResolved);
    socket.on('comment:reply', onReply);
    return () => { socket.off('comment:created', onComment); socket.off('comment:deleted', onCommentDel); socket.off('comment:resolved', onCommentResolved); socket.off('comment:reply', onReply); };
  }, [socket, selectedVideo?.id]);

  useEffect(() => {
    if (uploadForTaskId) {
      setSelectedVideo(null);
      setUploadForm(prev => ({ ...prev, task_id: uploadForTaskId }));
      setShowUpload(true);
      onUploadForTaskHandled?.();
    }
  }, [uploadForTaskId]);

  const formatTime = (s) => {
    if (!s && s !== 0) return '--:--';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playing) { videoRef.current.pause(); setPlaying(false); }
    else { videoRef.current.play(); setPlaying(true); clearAnnotations(); setActiveComment(null); }
  };

  // When video pauses, auto-capture timestamp for comments
  const onVideoPause = () => {
    setPlaying(false);
    if (!rangeMode) {
      setCapturedTs({ type: 'single', ts: videoRef.current?.currentTime || 0 });
      setShowCommentInput(true);
    }
  };

  const onTimeUpdate = () => { if (videoRef.current) setCurrentTime(videoRef.current.currentTime); };
  const onLoadedMetadata = () => { if (videoRef.current) setDuration(videoRef.current.duration); };

  const seek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = pct * duration;
    if (videoRef.current) { videoRef.current.currentTime = t; setCurrentTime(t); setActiveComment(null); }
  };

  const setRate = (r) => {
    setPlaybackRate(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
  };

  const toggleFullscreen = () => {
    if (!isFullscreen) { playerContainerRef.current?.requestFullscreen?.(); setIsFullscreen(true); }
    else { document.exitFullscreen?.(); setIsFullscreen(false); }
  };

  // Range selection
  const markRangeStart = () => {
    if (videoRef.current) videoRef.current.pause();
    setRangeStart(videoRef.current?.currentTime || 0);
    setRangeEnd(null);
    setCapturedTs(null);
    setShowCommentInput(false);
  };
  const markRangeEnd = () => {
    const end = videoRef.current?.currentTime || 0;
    const start = rangeStart ?? 0;
    const ts = { type: 'range', start: Math.min(start, end), end: Math.max(start, end) };
    setRangeEnd(ts.end);
    setRangeStart(ts.start);
    setCapturedTs(ts);
    setShowCommentInput(true);
  };

  // Canvas drawing
  const getCanvasPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * canvas.width, y: ((e.clientY - rect.top) / rect.height) * canvas.height };
  };

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const active = activeComment && comments.find(c => c.id === activeComment && c.annotation);
    if (active) drawAnnotation(ctx, active.annotation);
    annotations.forEach(ann => drawAnnotation(ctx, ann));
    if (currentAnnotation) drawAnnotation(ctx, currentAnnotation);
  }, [annotations, comments, currentTime, currentAnnotation, activeComment]);

  const drawAnnotation = (ctx, ann) => {
    ctx.strokeStyle = ann.color || DARK.orange;
    ctx.fillStyle = ann.color || DARK.orange;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (ann.type === 'freehand' && ann.points?.length > 1) {
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      ann.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    } else if (ann.type === 'rect') {
      ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
    } else if (ann.type === 'arrow') {
      const dx = ann.x2 - ann.x1, dy = ann.y2 - ann.y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / len, uy = dy / len;
      const hl = 16;
      ctx.beginPath();
      ctx.moveTo(ann.x1, ann.y1);
      ctx.lineTo(ann.x2, ann.y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ann.x2, ann.y2);
      ctx.lineTo(ann.x2 - hl * (ux + uy * 0.5), ann.y2 - hl * (uy - ux * 0.5));
      ctx.lineTo(ann.x2 - hl * (ux - uy * 0.5), ann.y2 - hl * (uy + ux * 0.5));
      ctx.closePath();
      ctx.fill();
    }
  };

  useEffect(() => { redrawCanvas(); }, [redrawCanvas]);

  const onCanvasMouseDown = (e) => {
    const pos = getCanvasPos(e);
    setIsDrawing(true);
    setDrawStart(pos);
    if (tool === 'freehand') setAnnotations(prev => [...prev, { type: 'freehand', color: drawColor, points: [pos] }]);
  };

  const onCanvasMouseMove = (e) => {
    if (!isDrawing || !drawStart) return;
    const pos = getCanvasPos(e);
    if (tool === 'freehand') {
      setAnnotations(prev => { const last = { ...prev[prev.length - 1], points: [...prev[prev.length - 1].points, pos] }; return [...prev.slice(0, -1), last]; });
    } else if (tool === 'rect') {
      setCurrentAnnotation({ type: 'rect', x: drawStart.x, y: drawStart.y, w: pos.x - drawStart.x, h: pos.y - drawStart.y, color: drawColor });
    } else if (tool === 'arrow') {
      setCurrentAnnotation({ type: 'arrow', x1: drawStart.x, y1: drawStart.y, x2: pos.x, y2: pos.y, color: drawColor });
    }
    redrawCanvas();
  };

  const onCanvasMouseUp = () => {
    if (currentAnnotation) { setAnnotations(prev => [...prev, currentAnnotation]); setCurrentAnnotation(null); }
    setIsDrawing(false);
    setDrawStart(null);
  };

  const clearAnnotations = () => {
    setAnnotations([]);
    canvasRef.current?.getContext('2d')?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  };

  const submitComment = async () => {
    if (!commentText.trim()) return;
    // Use capturedTs or fall back to current video time
    const ts = capturedTs || { type: 'single', ts: videoRef.current?.currentTime || 0 };
    const fd = new FormData();
    fd.append('content', commentText);
    fd.append('timestamp_sec', ts.type === 'single' ? ts.ts : ts.start);
    if (ts.type === 'range') fd.append('timestamp_end', ts.end);
    if (annotations.length > 0) fd.append('annotation', JSON.stringify(annotations[annotations.length - 1]));
    commentFiles.forEach(f => fd.append('attachments', f));
    await api(`/api/videos/${selectedVideo.id}/comments`, { method: 'POST', body: fd });
    // Reload comments directly from server
    const updated = await api(`/api/videos/${selectedVideo.id}/comments`);
    setComments(updated);
    setCommentText('');
    setCommentFiles([]);
    setShowCommentInput(false);
    setCapturedTs(null);
    setRangeStart(null);
    setRangeEnd(null);
    clearAnnotations();
  };

  const jumpToComment = (c) => {
    setActiveComment(c.id);
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = c.timestamp_sec; setCurrentTime(c.timestamp_sec); }
  };

  const deleteComment = async (cid) => { await api(`/api/comments/${cid}`, { method: 'DELETE' }); };
  const resolveComment = async (cid) => {
    const updated = await api(`/api/comments/${cid}/resolve`, { method: 'PATCH' });
    setComments(prev => prev.map(c => c.id === cid ? { ...c, resolved: updated.resolved } : c));
  };

  const submitReply = async (commentId) => {
    if (!replyText.trim()) return;
    const fd = new FormData();
    fd.append('content', replyText);
    replyFiles.forEach(f => fd.append('attachments', f));
    setReplyText('');
    setReplyFiles([]);
    setReplyingTo(null);
    await api(`/api/comments/${commentId}/replies`, { method: 'POST', body: fd });
    // State updated via socket event only to avoid duplicates
  };
  const initials = (name) => name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const uploadVideo = async () => {
    if (!uploadFile) return;
    setUploading(true);
    const fd = new FormData();
    fd.append('video', uploadFile);
    fd.append('title', uploadForm.title || uploadFile.name);
    fd.append('version', uploadForm.version || '1');
    if (uploadForm.task_id) fd.append('task_id', uploadForm.task_id);
    try {
      const v = await api(`/api/projects/${projectId}/videos`, { method: 'POST', body: fd });
      setVideos(prev => [v, ...prev]);
      setSelectedVideo(v);
      setShowUpload(false);
      setUploadFile(null);
      setUploadForm({ title: '', version: '', task_id: '' });
    } finally { setUploading(false); }
  };

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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {videos.map(v => (
            <div key={v.id} onClick={() => setSelectedVideo(v)}
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, cursor: 'pointer', transition: 'all 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
              <div style={{ width: '100%', paddingBottom: '56%', background: 'var(--bg4)', borderRadius: 8, marginBottom: 10, position: 'relative' }}>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>▶️</div>
              </div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{v.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, background: 'var(--accent-glow)', color: 'var(--accent2)', padding: '2px 7px', borderRadius: 8, fontWeight: 700 }}>v{v.version}</span>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>{v.uploader_name}</span>
              </div>
              {v.task_title && (
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ flexShrink: 0 }}>📋</span> {v.task_title}
                </div>
              )}
            </div>
          ))}
        </div>
        {showUpload && (
          <div className="modal-overlay" onClick={() => setShowUpload(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Subir video</h2>
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
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" onClick={() => setShowUpload(false)}>Cancelar</button>
                <button className="btn btn-primary" onClick={uploadVideo} disabled={!uploadFile || uploading}>
                  {uploading ? '⏳ Subiendo...' : '⬆ Subir'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── PLAYER VIEW ─────────────────────────────────────────────────────────────
  const progressPct = duration ? (currentTime / duration) * 100 : 0;
  const rangePct = duration && rangeStart != null ? (rangeStart / duration) * 100 : null;
  const rangeEndPct = duration && rangeEnd != null ? (rangeEnd / duration) * 100 : null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: DARK.bg0 }}>

      {/* Top bar: back, version dropdown, title */}
      <div style={{ padding: '8px 14px', background: DARK.bg1, borderBottom: `1px solid ${DARK.border}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <button onClick={() => setSelectedVideo(null)}
          style={{ background: 'transparent', border: `1px solid ${DARK.border}`, borderRadius: 6, padding: '4px 10px', color: DARK.text2, fontSize: 12, cursor: 'pointer' }}>
          ← Volver
        </button>
        {/* Version selector */}
        <select value={selectedVideo.id}
          onChange={e => { const v = videos.find(x => x.id === e.target.value); if (v) setSelectedVideo(v); }}
          style={{ background: DARK.bg2, border: `1px solid ${DARK.border}`, borderRadius: 7, color: DARK.text, fontSize: 12, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>
          {/* All versions of all videos — grouped by title */}
          {videos.map(v => (
            <option key={v.id} value={v.id}>{v.title} — v{v.version}</option>
          ))}
        </select>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: DARK.accentDim, border: `1px solid ${DARK.accent}50`, borderRadius: 6, padding: '3px 9px', fontSize: 11, color: DARK.accentText, fontWeight: 600 }}>
          v{selectedVideo.version}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color: DARK.text, flex: 1 }}>{selectedVideo.title}</span>
        <span style={{ fontSize: 11, color: DARK.text3 }}>{comments.length} comentarios</span>
        <button className="btn btn-primary btn-sm" onClick={() => setShowUpload(true)}>⬆ Nueva versión</button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* LEFT: player + tools + timeline */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} ref={playerContainerRef}>

          {/* Video area */}
          <div style={{ flex: 1, background: '#000', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            <video ref={videoRef}
              src={`/uploads/${selectedVideo.filename}`}
              style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMetadata}
              onEnded={() => setPlaying(false)}
              onPause={onVideoPause}
              onPlay={() => { setPlaying(true); clearAnnotations(); setActiveComment(null); }}
            />
            <canvas ref={canvasRef} width={1280} height={720}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair' }}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasMouseUp}
            />
          </div>

          {/* Drawing toolbar */}
          <div style={{ background: DARK.bg1, borderTop: `1px solid ${DARK.border}`, borderBottom: `1px solid ${DARK.border}`, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: DARK.text3, marginRight: 4 }}>Dibujar:</span>
            {[['freehand', '✏️', 'Libre'], ['arrow', '↗', 'Flecha'], ['rect', '⬜', 'Rectángulo']].map(([t, icon, label]) => (
              <button key={t} onClick={() => setTool(t)}
                style={{ background: tool === t ? DARK.accentDim : 'transparent', border: `1px solid ${tool === t ? DARK.accent : DARK.border}`, borderRadius: 6, padding: '4px 10px', color: tool === t ? DARK.accentText : DARK.text2, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                {icon} {label}
              </button>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
              <span style={{ fontSize: 11, color: DARK.text3 }}>Color:</span>
              {[DARK.orange, DARK.accent, DARK.red, '#10b981', '#fff'].map(c => (
                <div key={c} onClick={() => setDrawColor(c)}
                  style={{ width: 18, height: 18, borderRadius: '50%', background: c, cursor: 'pointer', border: drawColor === c ? '2px solid #fff' : '2px solid transparent', transition: 'all 0.1s' }} />
              ))}
            </div>
            <div style={{ flex: 1 }} />
            {annotations.length > 0 && (
              <button onClick={clearAnnotations}
                style={{ background: 'transparent', border: `1px solid ${DARK.border}`, borderRadius: 6, padding: '4px 10px', color: DARK.red, fontSize: 12, cursor: 'pointer' }}>
                🗑 Limpiar dibujo
              </button>
            )}
          </div>

          {/* Timeline */}
          <div style={{ background: DARK.bg1, padding: '0 14px', flexShrink: 0 }}>
            <div style={{ position: 'relative', height: 40, display: 'flex', alignItems: 'center', cursor: 'pointer' }} onClick={seek}>
              <div style={{ width: '100%', height: 4, background: DARK.bg3, borderRadius: 2, position: 'relative' }}>
                {/* Progress */}
                <div style={{ width: `${progressPct}%`, height: '100%', background: DARK.accent, borderRadius: 2 }} />
                {/* Range highlight */}
                {rangePct != null && rangeEndPct != null && (
                  <div style={{ position: 'absolute', top: 0, left: `${rangePct}%`, width: `${rangeEndPct - rangePct}%`, height: '100%', background: `${DARK.orange}50`, borderLeft: `2px solid ${DARK.orange}`, borderRight: `2px solid ${DARK.orange}` }} />
                )}
                {/* Playhead */}
                <div style={{ position: 'absolute', top: '50%', left: `${progressPct}%`, transform: 'translate(-50%,-50%)', width: 13, height: 13, borderRadius: '50%', background: DARK.accent, border: '2px solid #fff', pointerEvents: 'none' }} />
                {/* Comment markers */}
                {comments.map(c => {
                  const pct = duration ? (c.timestamp_sec / duration) * 100 : 0;
                  const isRange = c.timestamp_end != null;
                  if (isRange) {
                    const endPct = duration ? (c.timestamp_end / duration) * 100 : 0;
                    return (
                      <div key={c.id} onClick={e => { e.stopPropagation(); jumpToComment(c); }}
                        style={{ position: 'absolute', top: 0, left: `${pct}%`, width: `${endPct - pct}%`, height: '100%', background: `${DARK.orange}40`, borderLeft: `2px solid ${DARK.orange}`, borderRight: `2px solid ${DARK.orange}`, cursor: 'pointer' }} />
                    );
                  }
                  return (
                    <div key={c.id} onClick={e => { e.stopPropagation(); jumpToComment(c); }}
                      style={{ position: 'absolute', top: '50%', left: `${pct}%`, transform: 'translate(-50%,-50%)', width: 3, height: 16, background: c.user_id === user.id ? DARK.accent : DARK.orange, borderRadius: 2, cursor: 'pointer' }}
                      title={c.content} />
                  );
                })}
              </div>
            </div>

            {/* Controls row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10 }}>
              <button onClick={() => { if (videoRef.current) { videoRef.current.currentTime = 0; setCurrentTime(0); } }}
                style={ctrlBtn}>⏮</button>
              <button onClick={togglePlay}
                style={{ ...ctrlBtn, color: DARK.text, fontSize: 20 }}>{playing ? '⏸' : '▶'}</button>
              <button onClick={() => { if (videoRef.current) { videoRef.current.currentTime = Math.min(duration, currentTime + 5); } }}
                style={ctrlBtn}>⏩</button>
              <span style={{ fontSize: 12, color: DARK.text2, fontVariantNumeric: 'tabular-nums', minWidth: 80 }}>
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
              <div style={{ flex: 1 }} />

              {/* Range mode button */}
              {!rangeMode ? (
                <button onClick={() => { setRangeMode(true); setRangeStart(null); setRangeEnd(null); }}
                  style={{ background: DARK.orangeDim, border: `1px solid ${DARK.orange}50`, borderRadius: 6, padding: '4px 10px', color: DARK.orange, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                  ⬌ Seleccionar rango
                </button>
              ) : (
                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  <button onClick={markRangeStart}
                    style={{ background: rangeStart != null ? DARK.orangeDim : 'transparent', border: `1px solid ${DARK.orange}`, borderRadius: 6, padding: '4px 10px', color: DARK.orange, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                    {rangeStart != null ? `▶ ${formatTime(rangeStart)}` : '▶ Marcar inicio'}
                  </button>
                  {rangeStart != null && (
                    <button onClick={markRangeEnd}
                      style={{ background: rangeEnd != null ? DARK.orangeDim : 'transparent', border: `1px solid ${DARK.orange}`, borderRadius: 6, padding: '4px 10px', color: DARK.orange, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      {rangeEnd != null ? `⏹ ${formatTime(rangeEnd)}` : '⏹ Marcar fin'}
                    </button>
                  )}
                  <button onClick={() => { setRangeMode(false); setRangeStart(null); setRangeEnd(null); setCapturedTs(null); setShowCommentInput(false); }}
                    style={{ background: 'transparent', border: `1px solid ${DARK.border}`, borderRadius: 6, padding: '4px 8px', color: DARK.text3, fontSize: 11, cursor: 'pointer' }}>✕</button>
                </div>
              )}

              {/* Playback speed */}
              {[0.5, 1, 1.5, 2].map(r => (
                <button key={r} onClick={() => setRate(r)}
                  style={{ background: playbackRate === r ? DARK.accentDim : 'transparent', border: `1px solid ${playbackRate === r ? DARK.accent : 'transparent'}`, borderRadius: 5, padding: '3px 7px', color: playbackRate === r ? DARK.accentText : DARK.text3, fontSize: 11, cursor: 'pointer' }}>
                  {r}×
                </button>
              ))}
              <button onClick={toggleFullscreen} style={{ ...ctrlBtn, fontSize: 14 }}>⛶</button>
              <button onClick={() => {
                if (videoRef.current) videoRef.current.pause();
                const t = videoRef.current?.currentTime || 0;
                setCapturedTs({ type: 'single', ts: t });
                setShowCommentInput(true);
              }} style={{ background: DARK.accentDim, border: `1px solid ${DARK.accent}`, borderRadius: 6, padding: '4px 10px', color: DARK.accentText, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                💬 Comentar aquí
              </button>
            </div>
          </div>

          {/* Comment input */}
          {showCommentInput && (
            <div style={{ background: DARK.bg1, borderTop: `1px solid ${DARK.border}`, padding: '10px 14px', flexShrink: 0 }}>
              {capturedTs?.type === 'range' ? (
                <div style={{ background: DARK.bg2, border: `1px solid ${DARK.orange}`, borderRadius: 7, padding: '6px 10px', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: DARK.orange, fontWeight: 600 }}>⬌ Rango: {formatTime(capturedTs.start)} → {formatTime(capturedTs.end)}</span>
                  <button onClick={() => { setShowCommentInput(false); setCapturedTs(null); setRangeMode(false); setRangeStart(null); setRangeEnd(null); }}
                    style={{ background: 'transparent', border: 'none', color: DARK.text3, cursor: 'pointer', fontSize: 13 }}>✕</button>
                </div>
              ) : (
                <div style={{ background: DARK.bg2, border: `1px solid ${DARK.accent}`, borderRadius: 7, padding: '6px 10px', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 11, color: DARK.accentText, fontWeight: 600 }}>⏸ Pausado en {formatTime(capturedTs.ts)}</span>
                  <button onClick={() => { setShowCommentInput(false); setCapturedTs(null); }}
                    style={{ background: 'transparent', border: 'none', color: DARK.text3, cursor: 'pointer', fontSize: 13 }}>✕</button>
                </div>
              )}
              <textarea value={commentText} onChange={e => setCommentText(e.target.value)}
                placeholder="Escribí tu feedback..."
                autoFocus
                style={{ width: '100%', background: DARK.bg2, border: `1px solid ${DARK.border}`, borderRadius: 8, padding: '8px 10px', color: DARK.text, fontSize: 13, fontFamily: 'inherit', resize: 'none', minHeight: 56, outline: 'none', boxSizing: 'border-box' }}
                onFocus={e => e.target.style.borderColor = DARK.accent}
                onBlur={e => e.target.style.borderColor = DARK.border}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitComment(); }}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => commentFileRef.current?.click()}
                    style={{ background: 'transparent', border: `1px solid ${DARK.border}`, borderRadius: 6, padding: '4px 10px', color: DARK.text2, fontSize: 12, cursor: 'pointer' }}>
                    📎 Adjuntar
                  </button>
                  <input ref={commentFileRef} type="file" multiple style={{ display: 'none' }} onChange={e => setCommentFiles(Array.from(e.target.files))} />
                  {commentFiles.length > 0 && <span style={{ fontSize: 11, color: DARK.text2 }}>{commentFiles.length} archivo(s)</span>}
                  {annotations.length > 0 && <span style={{ fontSize: 11, color: DARK.orange }}>✏️ Incluye dibujo</span>}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => { setShowCommentInput(false); setCapturedTs(null); }}
                    style={{ background: 'transparent', border: `1px solid ${DARK.border}`, borderRadius: 6, padding: '5px 12px', color: DARK.text2, fontSize: 12, cursor: 'pointer' }}>
                    Cancelar
                  </button>
                  <button onClick={submitComment} disabled={!commentText.trim()}
                    style={{ background: DARK.accent, border: 'none', borderRadius: 6, padding: '5px 14px', color: '#fff', fontSize: 12, fontWeight: 600, cursor: commentText.trim() ? 'pointer' : 'not-allowed', opacity: commentText.trim() ? 1 : 0.5 }}>
                    Comentar
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: comments panel */}
        <div style={{ width: 320, background: DARK.bg1, borderLeft: `1px solid ${DARK.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${DARK.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: DARK.text }}>Comentarios</span>
            <span style={{ fontSize: 11, color: DARK.text3 }}>{comments.length}</span>
          </div>
          <div style={{ display: 'flex', borderBottom: `1px solid ${DARK.border}`, flexShrink: 0 }}>
            {[['all','Todos'],['pending','Pendientes'],['resolved','Hechos']].map(([val, label]) => (
              <button key={val} onClick={() => setFilter(val)}
                style={{ flex: 1, background: 'transparent', border: 'none', borderBottom: filter === val ? `2px solid ${DARK.accent}` : '2px solid transparent', padding: '7px 4px', fontSize: 11, color: filter === val ? DARK.accentText : DARK.text3, cursor: 'pointer', fontWeight: filter === val ? 600 : 400, transition: 'all 0.15s' }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {comments.filter(c => filter === 'all' ? true : filter === 'resolved' ? c.resolved : !c.resolved).length === 0 && (
              <div style={{ padding: 30, textAlign: 'center', color: DARK.text3, fontSize: 13 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
                <div>Pausá el video para comentar</div>
              </div>
            )}
            {[...comments].sort((a, b) => a.timestamp_sec - b.timestamp_sec)
              .filter(c => filter === 'all' ? true : filter === 'resolved' ? c.resolved : !c.resolved)
              .map(c => (
              <div key={c.id} onClick={() => jumpToComment(c)}
                style={{ padding: '8px 12px', borderBottom: `1px solid ${DARK.bg2}`, cursor: 'pointer', background: activeComment === c.id ? DARK.bg2 : 'transparent', borderLeft: activeComment === c.id ? `2px solid ${DARK.accent}` : c.resolved ? `2px solid #10b981` : '2px solid transparent', opacity: c.resolved ? 0.6 : 1, transition: 'all 0.1s' }}
                onMouseEnter={e => { if (activeComment !== c.id) e.currentTarget.style.background = DARK.bg2; }}
                onMouseLeave={e => { if (activeComment !== c.id) e.currentTarget.style.background = 'transparent'; }}>
                {/* Timestamp badge */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  {c.timestamp_end != null ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: DARK.orangeDim, color: DARK.orange, fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10 }}>
                      ⬌ {formatTime(c.timestamp_sec)} → {formatTime(c.timestamp_end)}
                    </div>
                  ) : (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: DARK.accentDim, color: DARK.accentText, fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10 }}>
                      ▶ {formatTime(c.timestamp_sec)}
                    </div>
                  )}
                  <button onClick={e => { e.stopPropagation(); resolveComment(c.id); }}
                    title={c.resolved ? 'Marcar como pendiente' : 'Marcar como hecho'}
                    style={{ background: c.resolved ? '#10b98120' : 'transparent', border: `1px solid ${c.resolved ? '#10b981' : DARK.border}`, borderRadius: 6, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 13, transition: 'all 0.15s', flexShrink: 0 }}>
                    {c.resolved ? '✅' : '☐'}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ width: 24, height: 24, borderRadius: '50%', background: c.avatar_color || DARK.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                    {initials(c.user_name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: DARK.text2, marginBottom: 3 }}>{c.user_name}</div>
                    <div style={{ fontSize: 12, color: DARK.text, lineHeight: 1.5 }}>{c.content}</div>
                    {c.annotation && <div style={{ fontSize: 10, color: DARK.orange, marginTop: 3 }}>✏️ Incluye dibujo</div>}
                    {c.attachments?.length > 0 && (
                      <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {c.attachments.map(a => (
                          <a key={a.id} href={`/uploads/${a.filename}`} target="_blank" rel="noreferrer"
                            style={{ fontSize: 11, color: DARK.accentText, display: 'flex', alignItems: 'center', gap: 4, background: DARK.bg3, padding: '3px 7px', borderRadius: 5, textDecoration: 'none' }}
                            onClick={e => e.stopPropagation()}>
                            📎 {a.original_name}
                          </a>
                        ))}
                      </div>
                    )}
                    {/* Reply button */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      <button onClick={e => { e.stopPropagation(); setReplyingTo(replyingTo === c.id ? null : c.id); setReplyText(''); setReplyFiles([]); }}
                        style={{ background: 'transparent', border: 'none', color: DARK.text3, cursor: 'pointer', fontSize: 11, padding: 0, display: 'flex', alignItems: 'center', gap: 3 }}
                        onMouseEnter={e => e.currentTarget.style.color = DARK.text2}
                        onMouseLeave={e => e.currentTarget.style.color = DARK.text3}>
                        ↩ Responder
                      </button>
                      {(c.user_id === user.id || user.role === 'admin') && (
                        <button onClick={e => { e.stopPropagation(); deleteComment(c.id); }}
                          style={{ background: 'transparent', border: 'none', color: DARK.text3, cursor: 'pointer', fontSize: 11, padding: 0 }}
                          onMouseEnter={e => e.currentTarget.style.color = DARK.red}
                          onMouseLeave={e => e.currentTarget.style.color = DARK.text3}>
                          🗑 Eliminar
                        </button>
                      )}
                    </div>
                    {/* Reply thread */}
                    {c.replies?.length > 0 && (
                      <div style={{ marginTop: 8, borderTop: `1px solid ${DARK.bg3}`, paddingTop: 8, display: 'flex', gap: 6 }}>
                        <div style={{ width: 1, background: DARK.bg3, flexShrink: 0, marginLeft: 10 }} />
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {c.replies.map(r => (
                            <div key={r.id} style={{ display: 'flex', gap: 7 }}>
                              <div style={{ width: 20, height: 20, borderRadius: '50%', background: r.avatar_color || DARK.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                                {initials(r.user_name)}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 10, color: DARK.text3, marginBottom: 2 }}>{r.user_name}</div>
                                <div style={{ fontSize: 12, color: DARK.text, lineHeight: 1.4 }}>{r.content}</div>
                                {r.attachments?.length > 0 && r.attachments.map(a => (
                                  <a key={a.id} href={`/uploads/${a.filename}`} target="_blank" rel="noreferrer"
                                    style={{ fontSize: 11, color: DARK.accentText, display: 'flex', alignItems: 'center', gap: 3, marginTop: 3, textDecoration: 'none' }}
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
                      <div style={{ marginTop: 8, borderTop: `1px solid ${DARK.bg3}`, paddingTop: 8 }} onClick={e => e.stopPropagation()}>
                        <textarea
                          value={replyText}
                          onChange={e => setReplyText(e.target.value)}
                          placeholder="Dejá tu respuesta acá..."
                          autoFocus
                          rows={2}
                          style={{ width: '100%', background: DARK.bg0, border: `1px solid ${DARK.border}`, borderRadius: 7, padding: '6px 9px', color: DARK.text, fontSize: 12, fontFamily: 'inherit', resize: 'none', outline: 'none', boxSizing: 'border-box' }}
                          onFocus={e => e.target.style.borderColor = DARK.accent}
                          onBlur={e => e.target.style.borderColor = DARK.border}
                          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitReply(c.id); }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 5 }}>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <input ref={replyFileRef} type="file" multiple style={{ display: 'none' }} onChange={e => setReplyFiles(Array.from(e.target.files))} />
                            <button onClick={() => replyFileRef.current?.click()}
                              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: replyFiles.length > 0 ? DARK.orange : DARK.text3, fontSize: 16, padding: '2px 4px', borderRadius: 5 }}
                              title="Adjuntar archivo">📎</button>
                            {replyFiles.length > 0 && <span style={{ fontSize: 10, color: DARK.orange }}>{replyFiles.length} archivo(s)</span>}
                          </div>
                          <div style={{ display: 'flex', gap: 5 }}>
                            <button onClick={() => { setReplyingTo(null); setReplyText(''); setReplyFiles([]); }}
                              style={{ background: 'transparent', border: `1px solid ${DARK.border}`, borderRadius: 6, padding: '3px 9px', color: DARK.text2, fontSize: 11, cursor: 'pointer' }}>
                              Cancelar
                            </button>
                            <button onClick={() => submitReply(c.id)} disabled={!replyText.trim()}
                              style={{ background: replyText.trim() ? DARK.accent : DARK.bg3, border: 'none', borderRadius: 6, padding: '3px 10px', color: '#fff', fontSize: 11, fontWeight: 600, cursor: replyText.trim() ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: 4 }}>
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
        <div className="modal-overlay" onClick={() => setShowUpload(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Subir nueva versión</h2>
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
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowUpload(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={uploadVideo} disabled={!uploadFile || uploading}>
                {uploading ? '⏳ Subiendo...' : '⬆ Subir'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const ctrlBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: '#9898a8', fontSize: 17, padding: '4px 6px', borderRadius: 6, lineHeight: 1 };
