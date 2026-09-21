import { useState, useRef } from 'react';
import { formatTime } from './VideoPlayerAnnotator';
import useModalA11y from '../hooks/useModalA11y';

// Comparar dos versiones de un mismo video lado a lado, con play/pausa/seek sincronizados —
// antes la única forma de comparar un cambio entre versiones era abrir cada una por separado y
// acordarse de memoria cómo se veía la otra. Deliberadamente NO reusa VideoPlayerAnnotator: acá no
// hace falta dibujar ni comentar, solo mirar dos videos a la vez, así que un <video> simple por
// lado alcanza y evita la complejidad de sincronizar dos sets de herramientas de dibujo.
export default function VideoCompareModal({ videos, initialLeftId, initialRightId, mediaUrl, onClose }) {
  const [leftId, setLeftId] = useState(initialLeftId);
  const [rightId, setRightId] = useState(initialRightId);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  // Reproducir las dos pistas de audio a la vez es ruido — silenciada por default, con un botón
  // de volumen por lado para elegir de cuál escuchar (mutuamente excluyente).
  const [audioSide, setAudioSide] = useState(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const modalRef = useModalA11y(true, onClose);

  const leftVideo = videos.find(v => v.id === leftId);
  const rightVideo = videos.find(v => v.id === rightId);

  const togglePlay = () => {
    if (playing) {
      leftRef.current?.pause();
      rightRef.current?.pause();
      setPlaying(false);
    } else {
      leftRef.current?.play().catch(() => {});
      rightRef.current?.play().catch(() => {});
      setPlaying(true);
    }
  };

  const seekBoth = (t) => {
    if (leftRef.current) leftRef.current.currentTime = t;
    if (rightRef.current) rightRef.current.currentTime = t;
    setCurrentTime(t);
  };

  // Las dos versiones pueden durar distinto (un recorte, un agregado) — la barra usa la más larga
  // de las dos para no cortar la que dura más, y seekear más allá del final de la corta la clampea
  // sola el navegador.
  const onLoadedMetadata = () => {
    const d = Math.max(leftRef.current?.duration || 0, rightRef.current?.duration || 0);
    if (d > 0) setDuration(d);
  };
  const onTimeUpdate = (side) => () => {
    if (side === 'left' && leftRef.current) setCurrentTime(leftRef.current.currentTime);
  };

  const pane = (side, video, ref, setId) => (
    <div style={{ flex: 1, minWidth: 260 }}>
      <select className="input" value={video?.id || ''} onChange={e => setId(e.target.value)}
        style={{ marginBottom: 8, fontSize: 12, padding: '5px 8px' }}>
        {videos.map(v => <option key={v.id} value={v.id}>v{v.version} — {v.title}</option>)}
      </select>
      <div style={{ position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden', aspectRatio: '16/9' }}>
        {video && (
          <video
            ref={ref}
            src={mediaUrl(`/uploads/${video.filename}`)}
            playsInline
            muted={audioSide !== side}
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={onTimeUpdate(side)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
          />
        )}
        <button onClick={() => setAudioSide(prev => prev === side ? null : side)}
          title={audioSide === side ? 'Silenciar' : 'Escuchar este audio'}
          aria-label={audioSide === side ? 'Silenciar' : 'Escuchar este audio'}
          style={{ position: 'absolute', bottom: 8, right: 8, width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer', background: audioSide === side ? 'var(--accent)' : 'rgba(0,0,0,0.55)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>
          {audioSide === side ? '🔊' : '🔇'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 1080, width: '95%' }} onClick={e => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="compare-modal-title">
        <button className="modal-close" onClick={onClose} title="Cerrar" aria-label="Cerrar">✕</button>
        <h2 id="compare-modal-title">Comparar versiones</h2>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          {pane('left', leftVideo, leftRef, setLeftId)}
          {pane('right', rightVideo, rightRef, setRightId)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-primary btn-sm" onClick={togglePlay}>{playing ? '⏸ Pausar' : '▶ Reproducir'}</button>
          <input type="range" min={0} max={duration || 0} step={0.1} value={Math.min(currentTime, duration)}
            onChange={e => seekBoth(parseFloat(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer' }} />
          <span style={{ fontSize: 12, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums', minWidth: 80 }}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>
      </div>
    </div>
  );
}
