import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useAlert } from '../context/AlertContext';
import MentionInput from './MentionInput';

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

// Set de íconos propio en vez de emoji: un emoji del mismo control (▶, 🔇, ⛶) se ve distinto en
// cada sistema operativo/navegador, así que dos personas viendo el mismo reproductor ven pesos
// visuales distintos. SVG de trazo fino da un look consistente sin depender de una fuente externa.
const Icon = {
  play: () => <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7Z" /></svg>,
  pause: () => <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>,
  skipBack: () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>,
  skipForward: () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></svg>,
  volume: () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4Z" /><path d="M16 8a5 5 0 0 1 0 8" /></svg>,
  mute: () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4Z" /><path d="M23 9l-6 6M17 9l6 6" /></svg>,
  fullscreen: () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>,
  pencil: () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>,
  arrow: () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M9 7h8v8" /></svg>,
  rect: () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="6" width="16" height="12" rx="1.5" /></svg>,
  trash: () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>,
  comment: () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.4 8.5 8.5 0 0 1-4-1L3 20l1.1-5.5A8.38 8.38 0 0 1 3.5 11 8.5 8.5 0 1 1 21 11.5Z" /></svg>,
  range: () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4v16M18 4v16M6 12h12" /></svg>,
  undo: () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>,
  text: () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 6h14M12 6v13" /></svg>,
  check: () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>,
  compare: () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="8" height="14" rx="1.5" /><rect x="13" y="5" width="8" height="14" rx="1.5" /></svg>,
};

const iconBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 7, flexShrink: 0 };
const STROKE_WIDTHS = [1.5, 2.5, 4.5];
const RATES = [0.5, 1, 1.5, 2];

// Exportado porque el panel de comentarios de VideoReview.jsx (afuera de este componente) también
// necesita formatear timestamps — mejor un solo lugar que dos copias que se puedan desalinear.
export function formatTime(s) {
  if (!s && s !== 0) return '--:--';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ref expone hasUnsavedDraft/confirmDiscardDraft para que el padre (VideoReview) los use antes de
// navegar a otro video o a la lista — el compositor de comentario vive DENTRO de este componente,
// así que el padre no tiene otra forma de saber si hay algo sin enviar.
const VideoPlayerAnnotator = forwardRef(function VideoPlayerAnnotator(
  { src, comments, currentUserId, activeComment, onActiveCommentChange, allowAttachments = true, onSubmit, approvedAt, approvedByName, onApprove, onUnapprove, members = [] },
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
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  // Antes no había forma de bajar/silenciar el audio del video DESDE la app — si el feedback era
  // justo sobre el audio ("bajale la música acá"), no había con qué comparar sin salir a los
  // controles del sistema operativo.
  const [videoLoading, setVideoLoading] = useState(true);
  const [videoError, setVideoError] = useState(false);

  const [tool, setTool] = useState('freehand'); // freehand | rect | arrow
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState(STROKE_WIDTHS[1]);
  // La barra de dibujo arranca oculta: antes ocupaba una fila fija siempre, aunque la mayoría de
  // las veces el feedback es solo texto. "Dibujar" la despliega como overlay sobre el video en
  // vez de sumar un panel más a los que ya están apilados (timeline, controles, compositor).
  const [drawToolbarOpen, setDrawToolbarOpen] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [currentAnnotation, setCurrentAnnotation] = useState(null);
  // Posición (en espacio del canvas) de un texto en edición todavía no confirmado — la herramienta
  // "Texto" no arrastra como las demás, solo necesita un punto y abre un input flotante ahí mismo.
  const [textInputPos, setTextInputPos] = useState(null);
  const [textInputValue, setTextInputValue] = useState('');

  const [rangeMode, setRangeMode] = useState(false);
  const [rangeStart, setRangeStart] = useState(null);
  const [rangeEnd, setRangeEnd] = useState(null);
  const [capturedTs, setCapturedTs] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [commentFiles, setCommentFiles] = useState([]);
  // submittingRef (no solo este state) es lo que de verdad frena un doble click — un state puede
  // quedar un tick atrás por el batching de React y dejar pasar un segundo submit antes de
  // re-renderizar. Este state es solo para el "Enviando..." visual del botón.
  const [submitting, setSubmitting] = useState(false);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [approving, setApproving] = useState(false);

  const formatT = formatTime;

  const hasUnsavedDraft = () => commentText.trim().length > 0 || annotations.length > 0 || commentFiles.length > 0;

  const handleApproveClick = async () => {
    if (approving) return;
    setApproving(true);
    try {
      await (approvedAt ? onUnapprove?.() : onApprove?.());
    } catch (e) { await alert(e.message || 'Error al actualizar la aprobación'); }
    finally { setApproving(false); }
  };

  const togglePlay = async () => {
    if (!videoRef.current) return;
    if (playing) { videoRef.current.pause(); setPlaying(false); return; }
    // Dar play borra el dibujo del canvas (no tiene sentido superpuesto a un video en movimiento),
    // pero antes lo hacía en silencio — un play accidental mientras se estaba dibujando un comentario
    // te hacía perder la anotación sin ningún aviso, sin forma de recuperarla.
    if (annotations.length > 0 && !await confirm('Tenés un dibujo sin enviar en el comentario. Si reproducís el video, se pierde. ¿Continuar?', { confirmText: 'Reproducir y descartar', danger: true })) {
      return;
    }
    videoRef.current.play(); setPlaying(true); clearAnnotations(); onActiveCommentChange?.(null);
  };

  const onVideoPause = () => {
    setPlaying(false);
    if (suppressPauseComposerRef.current) { suppressPauseComposerRef.current = false; return; }
    if (rangeMode) return;
    // Si ya hay un comentario sin enviar (texto o dibujo) Y un timestamp ya capturado, un segundo
    // pause — play accidental y pausa de nuevo, por ejemplo — no le pisa el timestamp en silencio:
    // antes recapturaba siempre, así que el feedback que ya habías escrito terminaba mandado con
    // el momento equivocado sin ningún aviso. Si no hay timestamp capturado todavía (por ejemplo,
    // se acaba de cancelar una selección de rango), no hay nada que proteger — cae al caso normal
    // de abajo, que sí lo captura (evita un `capturedTs` nulo que rompe el compositor al renderizar).
    if (hasUnsavedDraft() && capturedTs) { setShowCommentInput(true); return; }
    setCapturedTs({ type: 'single', ts: videoRef.current?.currentTime || 0 });
    setShowCommentInput(true);
  };

  // Espacio y flechas son la convención de facto en cualquier reproductor (YouTube, Vimeo, el
  // <video controls> nativo) — antes no existía ningún atajo. Se ignora si el foco está en un
  // campo de texto (el textarea del comentario, el input de nombre del invitado en la pública)
  // para no pisarle el tipeo normal a esa tecla.
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { if (videoRef.current) videoRef.current.currentTime = Math.min(duration, videoRef.current.currentTime + 5); }
      else if (e.key === 'ArrowLeft') { if (videoRef.current) videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 5); }
      // Ctrl/Cmd+Z deshace el último trazo — antes la única forma de corregir un dibujo era
      // "Limpiar dibujo", que borra TODO, aunque el error fuera solo el último trazo.
      else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); setAnnotations(prev => prev.slice(0, -1)); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, playing]);

  const onTimeUpdate = () => { if (videoRef.current) setCurrentTime(videoRef.current.currentTime); };
  const onLoadedMetadata = () => { if (videoRef.current) setDuration(videoRef.current.duration); };
  // canplay (no loadeddata) porque es el evento que garantiza que ya se puede arrancar a
  // reproducir sin cortes — loadeddata puede disparar con apenas el primer frame decodificado.
  const onCanPlay = () => setVideoLoading(false);
  const onVideoError = () => { setVideoLoading(false); setVideoError(true); };

  // Reintentar no alcanza con volver a poner el mismo `src` (React no vuelve a montar el <video>
  // si la prop no cambia de valor) — hay que forzar la recarga real del elemento con .load().
  const retryVideo = () => {
    setVideoError(false);
    setVideoLoading(true);
    videoRef.current?.load();
  };

  useEffect(() => {
    setVideoLoading(true);
    setVideoError(false);
  }, [src]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (videoRef.current) videoRef.current.muted = next;
  };
  const onVolumeChange = (e) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    setMuted(v === 0);
    if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0; }
  };

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

  const posFromClient = (clientX, clientY) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height
    };
  };
  const getCanvasPos = (e) => posFromClient(e.clientX, e.clientY);
  // El link público es justo donde más importa esto: un cliente casi siempre abre el link desde
  // el celular, y sin esto podía ver el video y comentar pero NO dibujar — el touch no dispara los
  // eventos de mouse en un <canvas>. touches[0] al mover/tocar, changedTouches[0] al soltar (en
  // touchend ya no hay ningún touch activo en `touches`).
  const getTouchCanvasPos = (e) => {
    const t = e.touches[0] || e.changedTouches[0];
    return posFromClient(t.clientX, t.clientY);
  };

  const drawAnnotation = (ctx, ann) => {
    const color = resolveDrawColor(ann.color);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = ann.strokeWidth || 2.5;
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
    } else if (ann.type === 'text' && ann.text) {
      // Familia de fuente literal (no var()) por la misma razón que el color: canvas no resuelve
      // variables CSS, así que 'var(--font)' quedaría en la tipografía por default del navegador.
      ctx.font = `700 ${ann.fontSize || 28}px 'DM Sans', sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(ann.text, ann.x, ann.y);
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

  // Un solo camino para mouse y touch: cada handler de touch solo resuelve la posición distinto
  // y llama a estas mismas funciones, así el dibujo se comporta idéntico en los dos casos.
  const startDrawAt = (pos) => {
    // "Texto" no arrastra: un solo click/tap abre un input flotante en ese punto en vez de
    // empezar un trazo — por eso no toca isDrawing/drawStart, que son solo para las otras 3.
    if (tool === 'text') { setTextInputPos(pos); setTextInputValue(''); return; }
    setIsDrawing(true);
    setDrawStart(pos);
    if (tool === 'freehand') setAnnotations(prev => [...prev, { type: 'freehand', color: drawColor, strokeWidth, points: [pos] }]);
  };
  const commitTextAnnotation = () => {
    if (textInputValue.trim()) {
      setAnnotations(prev => [...prev, { type: 'text', x: textInputPos.x, y: textInputPos.y, text: textInputValue.trim(), color: drawColor, fontSize: 28 }]);
    }
    setTextInputPos(null);
    setTextInputValue('');
  };
  const moveDrawTo = (pos) => {
    if (!isDrawing || !drawStart) return;
    if (tool === 'freehand') {
      setAnnotations(prev => { const last = { ...prev[prev.length - 1], points: [...prev[prev.length - 1].points, pos] }; return [...prev.slice(0, -1), last]; });
    } else if (tool === 'rect') {
      setCurrentAnnotation({ type: 'rect', x: drawStart.x, y: drawStart.y, w: pos.x - drawStart.x, h: pos.y - drawStart.y, color: drawColor, strokeWidth });
    } else if (tool === 'arrow') {
      setCurrentAnnotation({ type: 'arrow', x1: drawStart.x, y1: drawStart.y, x2: pos.x, y2: pos.y, color: drawColor, strokeWidth });
    }
    redrawCanvas();
  };

  // preventDefault: sin esto, un click en el canvas (que no es focusable) puede terminar
  // corriéndole el foco al <body> apenas después del mousedown — invisible normalmente, pero le
  // robaba el foco al input flotante de la herramienta "Texto" apenas se montaba con autoFocus,
  // así que el onBlur lo cerraba solo antes de que se llegara a escribir nada.
  const onCanvasMouseDown = (e) => { e.preventDefault(); startDrawAt(getCanvasPos(e)); };
  const onCanvasMouseMove = (e) => moveDrawTo(getCanvasPos(e));
  const onCanvasTouchStart = (e) => { e.preventDefault(); startDrawAt(getTouchCanvasPos(e)); };
  const onCanvasTouchMove = (e) => { e.preventDefault(); moveDrawTo(getTouchCanvasPos(e)); };
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
    setSubmitting(true);
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
    finally { submittingRef.current = false; setSubmitting(false); }
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
          // Sin esto, iOS Safari fuerza el video a fullscreen NATIVO del sistema apenas se le da
          // play — no es opcional, es el comportamiento fijo de WebKit. Eso tapa el canvas, los
          // controles y el compositor: justo lo que se acaba de arreglar para que se pueda dibujar
          // con el dedo dejaba de verse en el momento exacto en que el cliente le da play.
          playsInline
          style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onCanPlay={onCanPlay}
          onError={onVideoError}
          onEnded={() => setPlaying(false)}
          onPause={onVideoPause}
          onPlay={() => { setPlaying(true); clearAnnotations(); onActiveCommentChange?.(null); }}
        />
        {/* Antes un video roto (URL vencida, red cortada) quedaba en negro sin ningún aviso — ni
            para el equipo ni, peor, para el cliente en el link público, que no tiene a quién
            preguntarle "che, esto no carga". */}
        {videoLoading && !videoError && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div className="spinner" />
          </div>
        )}
        {videoError && (
          // zIndex por encima del canvas: sin esto, el canvas (que se dibuja después en el DOM y
          // cubre el mismo inset:0) le tapaba el click al botón — se detectó recién probando
          // el estado de error en el navegador, no se veía leyendo el código.
          <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center', padding: 20 }}>
            <span style={{ fontSize: 13, color: 'var(--text2)' }}>⚠️ No se pudo cargar el video</span>
            <button className="btn-retry" onClick={retryVideo}>Reintentar</button>
          </div>
        )}
        <canvas ref={canvasRef} width={1280} height={720}
          // touchAction:'none' es lo que realmente evita que el navegador interprete el dedo
          // dibujando como un gesto de scroll/zoom — el preventDefault() de los handlers de touch
          // es respaldo, pero esta propiedad CSS es la forma confiable de lograrlo.
          // pointerEvents solo se activa con el modo "Dibujar" prendido: antes el canvas capturaba
          // clicks/touches SIEMPRE (aun sin querer dibujar nada), tapando cualquier otra cosa que
          // se pusiera encima del video (como el botón de comentar de acá abajo).
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: drawToolbarOpen ? (tool === 'text' ? 'text' : 'crosshair') : 'default', touchAction: 'none', pointerEvents: drawToolbarOpen ? 'auto' : 'none' }}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={onCanvasMouseUp}
          onTouchStart={onCanvasTouchStart}
          onTouchMove={onCanvasTouchMove}
          onTouchEnd={onCanvasMouseUp}
          onTouchCancel={onCanvasMouseUp}
        />

        {/* Input flotante de la herramienta "Texto" — posicionado en % sobre el mismo contenedor
            que el canvas (inset:0), así que las coordenadas van directo en espacio del canvas
            (0-1280 / 0-720) sin necesitar otro ref ni cuentas de bounding rect aparte. */}
        {textInputPos && (
          <input
            autoFocus
            value={textInputValue}
            onChange={e => setTextInputValue(e.target.value)}
            onBlur={commitTextAnnotation}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitTextAnnotation(); }
              else if (e.key === 'Escape') { setTextInputPos(null); setTextInputValue(''); }
            }}
            style={{
              position: 'absolute', zIndex: 4,
              left: `${(textInputPos.x / 1280) * 100}%`, top: `${(textInputPos.y / 720) * 100}%`,
              transform: 'translateY(-2px)', minWidth: 140, background: 'rgba(20,20,23,0.9)',
              border: `1.5px dashed ${resolveDrawColor(drawColor)}`, borderRadius: 6, padding: '3px 6px',
              color: resolveDrawColor(drawColor), fontFamily: "'DM Sans', sans-serif", fontWeight: 700, fontSize: 16, outline: 'none',
            }}
          />
        )}

        {/* Toggle de modo dibujo — reemplaza la barra de dibujo que antes estaba siempre visible
            debajo del video ocupando una fila fija aunque casi nunca se usara. */}
        <button onClick={() => setDrawToolbarOpen(o => !o)} title="Dibujar sobre el video"
          style={{ position: 'absolute', top: 10, left: 10, zIndex: 3, display: 'flex', alignItems: 'center', gap: 6, background: drawToolbarOpen ? 'var(--accent)' : 'rgba(20,20,23,0.82)', border: `1px solid ${drawToolbarOpen ? 'var(--accent)' : 'var(--border2)'}`, color: drawToolbarOpen ? '#fff' : 'var(--text2)', fontSize: 11.5, fontWeight: 600, padding: '6px 11px', borderRadius: 999, cursor: 'pointer' }}>
          <Icon.pencil /> Dibujar
        </button>

        {/* "Aprobado" antes era solo un estado inferido de la ausencia de comentarios sin resolver
            — esto le da una acción real y explícita, tanto al equipo como al cliente sin cuenta
            desde el link público (mismo componente, mismo botón, cada lado delega a su propio
            endpoint vía onApprove/onUnapprove). Un comentario nuevo la invalida (ver servidor). */}
        {(onApprove || onUnapprove) && (
          <button onClick={handleApproveClick} disabled={approving}
            title={approvedAt ? `Aprobado por ${approvedByName || 'alguien'} — click para quitar la aprobación` : 'Marcar como aprobado'}
            style={{ position: 'absolute', top: 10, right: 10, zIndex: 3, display: 'flex', alignItems: 'center', gap: 6, background: approvedAt ? 'var(--green)' : 'rgba(20,20,23,0.82)', border: `1px solid ${approvedAt ? 'var(--green)' : 'var(--border2)'}`, color: approvedAt ? '#fff' : 'var(--text2)', fontSize: 11.5, fontWeight: 600, padding: '6px 11px', borderRadius: 999, cursor: approving ? 'default' : 'pointer', opacity: approving ? 0.7 : 1 }}>
            <Icon.check /> {approvedAt ? `Aprobado${approvedByName ? ` por ${approvedByName}` : ''}` : 'Aprobar'}
          </button>
        )}

        {drawToolbarOpen && (
          <div style={{ position: 'absolute', top: 46, left: 10, right: 10, zIndex: 3, background: 'rgba(20,20,23,0.92)', border: '1px solid var(--border2)', borderRadius: 12, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 3 }}>
              {[['freehand', Icon.pencil, 'Libre'], ['arrow', Icon.arrow, 'Flecha'], ['rect', Icon.rect, 'Rectángulo'], ['text', Icon.text, 'Texto']].map(([t, IconCmp, label]) => (
                <button key={t} onClick={() => setTool(t)} title={label} aria-label={label} aria-pressed={tool === t}
                  style={{ ...iconBtn, background: tool === t ? 'var(--bg4)' : 'transparent', color: tool === t ? 'var(--text)' : 'var(--text2)', border: `1px solid ${tool === t ? 'var(--border2)' : 'transparent'}` }}>
                  <IconCmp />
                </button>
              ))}
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border2)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {DRAW_COLORS.map(c => (
                <button key={c} onClick={() => setDrawColor(c)} title={c} aria-label={`Color de dibujo ${c}`} aria-pressed={drawColor === c}
                  style={{ width: 17, height: 17, borderRadius: '50%', background: c, cursor: 'pointer', padding: 0, border: drawColor === c ? '2px solid #fff' : '2px solid transparent', boxShadow: drawColor === c ? '0 0 0 2px rgba(0,0,0,0.4)' : 'none' }} />
              ))}
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border2)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              {STROKE_WIDTHS.map(w => (
                <button key={w} onClick={() => setStrokeWidth(w)} title={w === STROKE_WIDTHS[0] ? 'Fino' : w === STROKE_WIDTHS[1] ? 'Medio' : 'Grueso'}
                  aria-label={w === STROKE_WIDTHS[0] ? 'Trazo fino' : w === STROKE_WIDTHS[1] ? 'Trazo medio' : 'Trazo grueso'} aria-pressed={strokeWidth === w}
                  style={{ ...iconBtn, width: 22, height: 22 }}>
                  <span style={{ display: 'block', borderRadius: '50%', width: w + 2, height: w + 2, background: strokeWidth === w ? 'var(--text)' : 'var(--text3)' }} />
                </button>
              ))}
            </div>
            {annotations.length > 0 && (
              <>
                <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border2)' }} />
                <button onClick={() => setAnnotations(prev => prev.slice(0, -1))} title="Deshacer último trazo (Ctrl+Z)" aria-label="Deshacer último trazo" style={iconBtn}>
                  <Icon.undo />
                </button>
                <button onClick={clearAnnotations} title="Limpiar dibujo" aria-label="Limpiar dibujo" style={{ ...iconBtn, color: 'var(--red)' }}>
                  <Icon.trash />
                </button>
              </>
            )}
          </div>
        )}

        {/* "Comentar aquí" como acción flotante propia, separada de la barra de controles — antes
            competía por espacio ahí al lado del volumen, sin ninguna jerarquía visual clara siendo
            la acción principal de todo el reproductor. */}
        <button onClick={() => {
          if (videoRef.current) videoRef.current.pause();
          // Mismo cuidado que onVideoPause: si ya hay un timestamp capturado, no lo pisa en
          // silencio. Si no hay ninguno todavía, cae al caso normal de abajo.
          if (hasUnsavedDraft() && capturedTs) { setShowCommentInput(true); return; }
          const t = videoRef.current?.currentTime || 0;
          setCapturedTs({ type: 'single', ts: t });
          setShowCommentInput(true);
        }}
          style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 3, display: 'flex', alignItems: 'center', gap: 7, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 999, padding: '9px 15px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', boxShadow: '0 6px 20px rgba(124,106,247,0.45)' }}>
          <Icon.comment /> Comentar aquí
        </button>
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

        {/* Controls row — íconos en vez de emoji+texto y velocidad en un solo botón cíclico
            (antes 4 botones separados) para que quepa en una fila también en mobile; flexWrap
            como red de seguridad si aun así no entra todo, en vez de desbordar o aplastarse. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingBottom: 10, flexWrap: 'wrap', rowGap: 6 }}>
          <button onClick={() => { if (videoRef.current) { videoRef.current.currentTime = 0; setCurrentTime(0); } }}
            title="Ir al inicio" aria-label="Ir al inicio" style={iconBtn}><Icon.skipBack /></button>
          <button onClick={togglePlay} title={playing ? 'Pausar' : 'Reproducir'} aria-label={playing ? 'Pausar' : 'Reproducir'}
            style={{ ...iconBtn, width: 34, height: 34, background: 'var(--bg4)', color: 'var(--text)' }}>
            {playing ? <Icon.pause /> : <Icon.play />}
          </button>
          <button onClick={() => { if (videoRef.current) { videoRef.current.currentTime = Math.min(duration, currentTime + 5); } }}
            title="Adelantar 5s" aria-label="Adelantar 5 segundos" style={iconBtn}><Icon.skipForward /></button>
          <span style={{ fontSize: 11.5, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums', padding: '0 4px', whiteSpace: 'nowrap' }}>
            {formatT(currentTime)} / {formatT(duration)}
          </span>
          <div style={{ flex: 1 }} />

          {!rangeMode ? (
            <button onClick={() => { setRangeMode(true); setRangeStart(null); setRangeEnd(null); }} title="Seleccionar rango"
              style={{ ...iconBtn, width: 'auto', gap: 5, padding: '0 9px', color: 'var(--yellow)' }}>
              <Icon.range /> <span style={{ fontSize: 11, fontWeight: 600 }}>Rango</span>
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
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
                title="Cancelar selección de rango" aria-label="Cancelar selección de rango"
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--text3)', fontSize: 11, cursor: 'pointer' }}>✕</button>
            </div>
          )}

          <button onClick={() => setRate(RATES[(RATES.indexOf(playbackRate) + 1) % RATES.length])} title="Velocidad de reproducción" aria-label={`Velocidad de reproducción, actualmente ${playbackRate}×`}
            style={{ fontFamily: 'inherit', fontSize: 11, fontWeight: 600, color: playbackRate !== 1 ? 'var(--accent2)' : 'var(--text2)', background: playbackRate !== 1 ? 'var(--accent-glow)' : 'transparent', border: `1px solid ${playbackRate !== 1 ? 'var(--accent)' : 'var(--border2)'}`, borderRadius: 7, padding: '5px 8px', cursor: 'pointer', minWidth: 34 }}>
            {playbackRate}×
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={toggleMute} title={muted || volume === 0 ? 'Activar sonido' : 'Silenciar'} aria-label={muted || volume === 0 ? 'Activar sonido' : 'Silenciar'} style={iconBtn}>
              {muted || volume === 0 ? <Icon.mute /> : <Icon.volume />}
            </button>
            <input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={onVolumeChange}
              style={{ width: 52, accentColor: 'var(--accent)', cursor: 'pointer' }} title="Volumen" aria-label="Volumen" />
          </div>
          <button onClick={toggleFullscreen} title="Pantalla completa" aria-label="Pantalla completa" style={iconBtn}><Icon.fullscreen /></button>
        </div>
      </div>

      {/* Comment input */}
      {showCommentInput && (
        <div style={{ background: 'var(--bg2)', borderTop: '1px solid var(--border)', padding: '10px 14px', flexShrink: 0 }}>
          {capturedTs?.type === 'range' ? (
            <div style={{ background: 'var(--bg3)', border: '1px solid var(--yellow)', borderRadius: 7, padding: '6px 10px', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: 'var(--yellow)', fontWeight: 600 }}>⬌ Rango: {formatT(capturedTs.start)} → {formatT(capturedTs.end)}</span>
              <button className="icon-btn" onClick={() => { setShowCommentInput(false); setCapturedTs(null); setRangeMode(false); setRangeStart(null); setRangeEnd(null); clearAnnotations(); }}
                title="Descartar rango marcado" aria-label="Descartar rango marcado"
                style={{ color: 'var(--text3)', fontSize: 14 }}>✕</button>
            </div>
          ) : (
            <div style={{ background: 'var(--bg3)', border: '1px solid var(--accent)', borderRadius: 7, padding: '6px 10px', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: 'var(--accent2)', fontWeight: 600 }}>⏸ Pausado en {formatT(capturedTs?.ts ?? currentTime)}</span>
              <button className="icon-btn" onClick={() => { setShowCommentInput(false); setCapturedTs(null); clearAnnotations(); }}
                title="Descartar marca de tiempo" aria-label="Descartar marca de tiempo"
                style={{ color: 'var(--text3)', fontSize: 14 }}>✕</button>
            </div>
          )}
          <MentionInput as="textarea" value={commentText} onChange={setCommentText} members={members}
            placeholder="Escribí tu feedback... (@ para mencionar)"
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
              <button onClick={submitComment} disabled={!commentText.trim() || submitting}
                style={{ background: 'var(--accent)', border: 'none', borderRadius: 6, padding: '5px 14px', color: '#fff', fontSize: 12, fontWeight: 600, cursor: (commentText.trim() && !submitting) ? 'pointer' : 'not-allowed', opacity: (commentText.trim() && !submitting) ? 1 : 0.5 }}>
                {submitting ? 'Enviando...' : 'Comentar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default VideoPlayerAnnotator;
