import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useAlert } from '../context/AlertContext';

// Reproductor + herramientas de dibujo + timeline con marcadores + compositor de comentario,
// compartido entre el panel interno (VideoReview.jsx, admin/editor autenticado) y el link público
// de revisión para clientes (PublicReview.jsx, sin cuenta) — antes el público era una versión
// mucho más simple con <video controls> nativo; el pedido fue que sea "exactamente igual" al que
// ya usa el equipo, así que en vez de mantener dos copias que se van a desalinear con el tiempo,
// es el mismo componente en los dos lados. Lo que SÍ difiere entre ambos vive afuera de acá: la
// lista de comentarios (el interno tiene resolver/eliminar/responder, el público no) y cómo se
// guarda el comentario (onSubmit lo delega — el interno pega a /api/videos/:id/comments con
// FormData+auth, el público a /api/review/:token/comments con fetch plano).

// Los colores del pincel tienen que ser hex literales: canvas no resuelve variables CSS, así que
// asignarle 'var(--red)' a strokeStyle es un no-op silencioso y el trazo queda del color anterior
// (negro por defecto, invisible sobre material oscuro). Estos son los mismos valores que los
// tokens de index.css. El mapa cubre los dibujos ya guardados con el string var() adentro.
const DRAW_COLORS = ['#f0a83a', '#7c6af7', '#f05c5c', '#10b981', '#ffffff'];
const LEGACY_DRAW_COLORS = { 'var(--yellow)': '#f0a83a', 'var(--accent)': '#7c6af7', 'var(--red)': '#f05c5c', '#fff': '#ffffff' };
function resolveDrawColor(color) {
  if (!color) return DRAW_COLORS[0];
  return LEGACY_DRAW_COLORS[color] || (color.startsWith('var(') ? DRAW_COLORS[0] : color);
}

const ctrlBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: '#9898a8', fontSize: 17, padding: '4px 6px', borderRadius: 6, lineHeight: 1 };

// Exportado porque el panel de comentarios de VideoReview.jsx (afuera de este componente) también
// necesita formatear timestamps — mejor un solo lugar que dos copias que se puedan desalinear.
export function formatTime(s) {
  if (!s && s !== 0) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ref expone hasUnsavedDraft/confirmDiscardDraft para que el padre (VideoReview) los use antes de
// navegar a otro video o a la lista — el compositor de comentario vive DENTRO de este componente,
// así que el padre no tiene otra forma de saber si hay algo sin enviar.
const VideoPlayerAnnotator = forwardRef(function VideoPlayerAnnotator(
  { src, comments, currentUserId, activeComment, onActiveCommentChange, allowAttachments = true, onSubmit },
  ref
) {
  const { alert, confirm } = useAlert();
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const playerContainerRef = useRef(null);
  const suppressPauseComposerRef = useRef(false);
  const submittingRef = useRef(false);
  const commentFileRef = useRef(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [tool, setTool] = useState('freehand'); // freehand | rect | arrow
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [currentAnnotation, setCurrentAnnotation] = useState(null);

  const [rangeMode, setRangeMode] = useState(false);
  const [rangeStart, setRangeStart] = useState(null);
  const [rangeEnd, setRangeEnd] = useState(null);
  const [capturedTs, setCapturedTs] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [commentFiles, setCommentFiles] = useState([]);
  const [showCommentInput, setShowCommentInput] = useState(false);

  const formatT = formatTime;

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playing) { videoRef.current.pause(); setPlaying(false); }
    else { videoRef.current.play(); setPlaying(true); clearAnnotations(); onActiveCommentChange?.(null); }
  };

  const onVideoPause = () => {
    setPlaying(false);
    if (suppressPauseComposerRef.current) { suppressPauseComposerRef.current = false; return; }
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
    if (videoRef.current) { videoRef.current.currentTime = t; setCurrentTime(t); onActiveCommentChange?.(null); }
  };

  const setRate = (r) => {
    setPlaybackRate(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
  };

  const toggleFullscreen = () => {
    if (!isFullscreen) playerContainerRef.current?.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

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

  const getCanvasPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height
    };
  };

  const drawAnnotation = (ctx, ann) => {
    const color = resolveDrawColor(ann.color);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
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

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const active = activeComment && comments.find(c => c.id === activeComment && c.annotation);
    // Comentarios viejos guardaron un solo dibujo (objeto); los nuevos guardan todos los trazos (array).
    if (active) (Array.isArray(active.annotation) ? active.annotation : [active.annotation]).forEach(ann => drawAnnotation(ctx, ann));
    annotations.forEach(ann => drawAnnotation(ctx, ann));
    if (currentAnnotation) drawAnnotation(ctx, currentAnnotation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, comments, currentAnnotation, activeComment]);

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

  const jumpToComment = (c) => {
    onActiveCommentChange?.(c.id);
    if (videoRef.current) {
      if (!videoRef.current.paused) suppressPauseComposerRef.current = true;
      videoRef.current.pause();
      videoRef.current.currentTime = c.timestamp_sec;
      setCurrentTime(c.timestamp_sec);
    }
  };

  const hasUnsavedDraft = () => commentText.trim().length > 0 || annotations.length > 0 || commentFiles.length > 0;
  // jumpToComment se expone acá porque la lista de comentarios (afuera de este componente, en el
  // panel lateral de VideoReview.jsx) necesita poder seekear el video al hacer click en una tarjeta
  // — el <video>/canvas son internos, no hay otra forma de llegar a ellos desde el padre.
  useImperativeHandle(ref, () => ({
    hasUnsavedDraft,
    confirmDiscardDraft: async () => !hasUnsavedDraft() || await confirm('Tenés un comentario sin enviar. ¿Salir de todos modos? Se va a perder.', { confirmText: 'Salir', danger: true }),
    jumpToComment,
  }));

  const submitComment = async () => {
    if (!commentText.trim() || submittingRef.current) return;
    submittingRef.current = true;
    const ts = capturedTs || { type: 'single', ts: videoRef.current?.currentTime || 0 };
    try {
      await onSubmit({
        content: commentText,
        timestampSec: ts.type === 'single' ? ts.ts : ts.start,
        timestampEnd: ts.type === 'range' ? ts.end : null,
        annotations,
        files: commentFiles,
      });
      setCommentText('');
      setCommentFiles([]);
      if (commentFileRef.current) commentFileRef.current.value = '';
      setShowCommentInput(false);
      setCapturedTs(null);
      setRangeMode(false);
      setRangeStart(null);
      setRangeEnd(null);
      clearAnnotations();
    } catch (e) { console.error(e); await alert('Error al enviar el comentario: ' + e.message); }
    finally { submittingRef.current = false; }
  };

  const progressPct = duration ? (currentTime / duration) * 100 : 0;
  const rangePct = duration && rangeStart != null ? (rangeStart / duration) * 100 : null;
  const rangeEndPct = duration && rangeEnd != null ? (rangeEnd / duration) * 100 : null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} ref={playerContainerRef}>
      {/* Video area */}
      <div style={{ flex: 1, background: '#000', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <video ref={videoRef}
          src={src}
          style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={() => setPlaying(false)}
          onPause={onVideoPause}
          onPlay={() => { setPlaying(true); clearAnnotations(); onActiveCommentChange?.(null); }}
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
      <div style={{ background: 'var(--bg2)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: 'var(--text3)', marginRight: 4 }}>Dibujar:</span>
        {[['freehand', '✏️', 'Libre'], ['arrow', '↗', 'Flecha'], ['rect', '⬜', 'Rectángulo']].map(([t, icon, label]) => (
          <button key={t} onClick={() => setTool(t)}
            style={{ background: tool === t ? 'var(--accent-glow)' : 'transparent', border: `1px solid ${tool === t ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, padding: '4px 10px', color: tool === t ? 'var(--accent2)' : 'var(--text2)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            {icon} {label}
          </button>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Color:</span>
          {DRAW_COLORS.map(c => (
            <div key={c} onClick={() => setDrawColor(c)}
              style={{ width: 18, height: 18, borderRadius: '50%', background: c, cursor: 'pointer', border: drawColor === c ? '2px solid #fff' : '2px solid transparent', transition: 'all 0.1s' }} />
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {annotations.length > 0 && (
          <button onClick={clearAnnotations}
            style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', color: 'var(--red)', fontSize: 12, cursor: 'pointer' }}>
            🗑 Limpiar dibujo
          </button>
        )}
      </div>

      {/* Timeline */}
      <div style={{ background: 'var(--bg2)', padding: '0 14px', flexShrink: 0 }}>
        <div style={{ position: 'relative', height: 40, display: 'flex', alignItems: 'center', cursor: 'pointer' }} onClick={seek}>
          <div style={{ width: '100%', height: 4, background: 'var(--border)', borderRadius: 2, position: 'relative' }}>
            <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
            {rangePct != null && rangeEndPct != null && (
              <div style={{ position: 'absolute', top: 0, left: `${rangePct}%`, width: `${rangeEndPct - rangePct}%`, height: '100%', background: 'rgba(240,168,58,0.31)', borderLeft: '2px solid var(--yellow)', borderRight: '2px solid var(--yellow)' }} />
            )}
            <div style={{ position: 'absolute', top: '50%', left: `${progressPct}%`, transform: 'translate(-50%,-50%)', width: 13, height: 13, borderRadius: '50%', background: 'var(--accent)', border: '2px solid #fff', pointerEvents: 'none' }} />
            {comments.map(c => {
              const pct = duration ? (c.timestamp_sec / duration) * 100 : 0;
              const isRange = c.timestamp_end != null;
              if (isRange) {
                const endPct = duration ? (c.timestamp_end / duration) * 100 : 0;
                return (
                  <div key={c.id} onClick={e => { e.stopPropagation(); jumpToComment(c); }}
                    style={{ position: 'absolute', top: 0, left: `${pct}%`, width: `${endPct - pct}%`, height: '100%', background: 'rgba(240,168,58,0.25)', borderLeft: '2px solid var(--yellow)', borderRight: '2px solid var(--yellow)', cursor: 'pointer' }} />
                );
              }
              return (
                <div key={c.id} onClick={e => { e.stopPropagation(); jumpToComment(c); }}
                  style={{ position: 'absolute', top: '50%', left: `${pct}%`, transform: 'translate(-50%,-50%)', width: 3, height: 16, background: c.user_id === currentUserId ? 'var(--accent)' : 'var(--yellow)', borderRadius: 2, cursor: 'pointer' }}
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
            style={{ ...ctrlBtn, color: 'var(--text)', fontSize: 20 }}>{playing ? '⏸' : '▶'}</button>
          <button onClick={() => { if (videoRef.current) { videoRef.current.currentTime = Math.min(duration, currentTime + 5); } }}
            style={ctrlBtn}>⏩</button>
          <span style={{ fontSize: 12, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums', minWidth: 80 }}>
            {formatT(currentTime)} / {formatT(duration)}
          </span>
          <div style={{ flex: 1 }} />

          {!rangeMode ? (
            <button onClick={() => { setRangeMode(true); setRangeStart(null); setRangeEnd(null); }}
              style={{ background: 'rgba(240,168,58,0.15)', border: '1px solid rgba(240,168,58,0.31)', borderRadius: 6, padding: '4px 10px', color: 'var(--yellow)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
              ⬌ Seleccionar rango
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <button onClick={markRangeStart}
                style={{ background: rangeStart != null ? 'rgba(240,168,58,0.15)' : 'transparent', border: '1px solid var(--yellow)', borderRadius: 6, padding: '4px 10px', color: 'var(--yellow)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                {rangeStart != null ? `▶ ${formatT(rangeStart)}` : '▶ Marcar inicio'}
              </button>
              {rangeStart != null && (
                <button onClick={markRangeEnd}
                  style={{ background: rangeEnd != null ? 'rgba(240,168,58,0.15)' : 'transparent', border: '1px solid var(--yellow)', borderRadius: 6, padding: '4px 10px', color: 'var(--yellow)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                  {rangeEnd != null ? `⏹ ${formatT(rangeEnd)}` : '⏹ Marcar fin'}
                </button>
              )}
              <button onClick={() => { setRangeMode(false); setRangeStart(null); setRangeEnd(null); setCapturedTs(null); setShowCommentInput(false); }}
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--text3)', fontSize: 11, cursor: 'pointer' }}>✕</button>
            </div>
          )}

          {[0.5, 1, 1.5, 2].map(r => (
            <button key={r} onClick={() => setRate(r)}
              style={{ background: playbackRate === r ? 'var(--accent-glow)' : 'transparent', border: `1px solid ${playbackRate === r ? 'var(--accent)' : 'transparent'}`, borderRadius: 5, padding: '3px 7px', color: playbackRate === r ? 'var(--accent2)' : 'var(--text3)', fontSize: 11, cursor: 'pointer' }}>
              {r}×
            </button>
          ))}
          <button onClick={toggleFullscreen} style={{ ...ctrlBtn, fontSize: 14 }}>⛶</button>
          <button onClick={() => {
            if (videoRef.current) videoRef.current.pause();
            const t = videoRef.current?.currentTime || 0;
            setCapturedTs({ type: 'single', ts: t });
            setShowCommentInput(true);
          }} style={{ background: 'var(--accent-glow)', border: '1px solid var(--accent)', borderRadius: 6, padding: '4px 10px', color: 'var(--accent2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            💬 Comentar aquí
          </button>
        </div>
      </div>

      {/* Comment input */}
      {showCommentInput && (
        <div style={{ background: 'var(--bg2)', borderTop: '1px solid var(--border)', padding: '10px 14px', flexShrink: 0 }}>
          {capturedTs?.type === 'range' ? (
            <div style={{ background: 'var(--bg3)', border: '1px solid var(--yellow)', borderRadius: 7, padding: '6px 10px', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: 'var(--yellow)', fontWeight: 600 }}>⬌ Rango: {formatT(capturedTs.start)} → {formatT(capturedTs.end)}</span>
              <button onClick={() => { setShowCommentInput(false); setCapturedTs(null); setRangeMode(false); setRangeStart(null); setRangeEnd(null); clearAnnotations(); }}
                style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
          ) : (
            <div style={{ background: 'var(--bg3)', border: '1px solid var(--accent)', borderRadius: 7, padding: '6px 10px', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600 }}>⏸ Pausado en {formatT(capturedTs.ts)}</span>
              <button onClick={() => { setShowCommentInput(false); setCapturedTs(null); clearAnnotations(); }}
                style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
          )}
          <textarea value={commentText} onChange={e => setCommentText(e.target.value)}
            placeholder="Escribí tu feedback..."
            autoFocus
            style={{ width: '100%', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit', resize: 'none', minHeight: 56, outline: 'none', boxSizing: 'border-box' }}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitComment(); }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {allowAttachments && (
                <>
                  <button onClick={() => commentFileRef.current?.click()}
                    style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>
                    📎 Adjuntar
                  </button>
                  <input ref={commentFileRef} type="file" multiple style={{ display: 'none' }} onChange={e => setCommentFiles(Array.from(e.target.files))} />
                  {commentFiles.length > 0 && <span style={{ fontSize: 11, color: 'var(--text2)' }}>{commentFiles.length} archivo(s)</span>}
                </>
              )}
              {annotations.length > 0 && <span style={{ fontSize: 11, color: 'var(--yellow)' }}>✏️ Incluye dibujo</span>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setShowCommentInput(false); setCapturedTs(null); clearAnnotations(); }}
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 12px', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>
                Cancelar
              </button>
              <button onClick={submitComment} disabled={!commentText.trim()}
                style={{ background: 'var(--accent)', border: 'none', borderRadius: 6, padding: '5px 14px', color: '#fff', fontSize: 12, fontWeight: 600, cursor: commentText.trim() ? 'pointer' : 'not-allowed', opacity: commentText.trim() ? 1 : 0.5 }}>
                Comentar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default VideoPlayerAnnotator;
