import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useAlert } from '../context/AlertContext';
import { initials as initialsBase } from '../utils/format';
import { uploadWithProgress } from '../utils/upload';

const formatRecordingTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Reproductor propio para notas de voz (estilo Slack) en vez de <audio controls> nativo: los
// .webm que graba MediaRecorder no siempre reportan su propia duración de forma confiable en
// los controles del navegador (queda en Infinity/NaN, o directamente 0), así que el total
// mostrado viene de `knownDuration` (el cronómetro real del cliente al grabar, guardado en
// chat_messages.file_duration) en vez de la metadata del archivo. La posición durante la
// reproducción sí es siempre confiable vía el propio evento timeupdate del audio.
function VoiceNotePlayer({ src, knownDuration }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [fallbackDuration, setFallbackDuration] = useState(null);
  const total = knownDuration || fallbackDuration || 0;

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause(); else audio.play();
  };

  const seek = (e) => {
    const audio = audioRef.current;
    if (!audio || !total) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * total;
    setCurrentTime(audio.currentTime);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 190 }}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentTime(0); }}
        onTimeUpdate={e => setCurrentTime(e.target.currentTime)}
        onLoadedMetadata={e => {
          // Solo se usa si no vino una duración ya conocida — best-effort para mensajes viejos.
          if (!knownDuration && isFinite(e.target.duration) && e.target.duration > 0) {
            setFallbackDuration(e.target.duration);
          }
        }}
        style={{ display: 'none' }}
      />
      <button onClick={togglePlay} title={playing ? 'Pausar' : 'Reproducir'} style={{
        background: 'var(--accent)', border: 'none', borderRadius: '50%', width: 26, height: 26,
        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        flexShrink: 0, color: '#fff', fontSize: 10
      }}>
        {playing ? '⏸' : '▶'}
      </button>
      <div onClick={seek} style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, cursor: total ? 'pointer' : 'default', position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2, background: 'var(--accent)', width: `${total ? Math.min(100, (currentTime / total) * 100) : 0}%` }} />
      </div>
      <span style={{ fontSize: 11, color: 'var(--text3)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {formatRecordingTime(currentTime)} / {total ? formatRecordingTime(total) : '--:--'}
      </span>
    </div>
  );
}

export default function Chat() {
  const { user, api, socket, onlineUsers, mediaUrl, token } = useAuth();
  const { alert } = useAlert();
  const [conversations, setConversations] = useState([]);
  const [channels, setChannels] = useState([]);
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [input, setInput] = useState('');
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  // Espejo en refs de lo que hay que soltar al desmontar: el cleanup corre con deps [] y no puede
  // leer el state de la grabación en curso.
  const mediaRecorderRef = useRef(null);
  const micStreamRef = useRef(null);
  const recordedAudioUrlRef = useRef(null);
  const sendingMessageRef = useRef(false);
  const WAVE_BARS = 24;
  const [waveLevels, setWaveLevels] = useState(() => Array(WAVE_BARS).fill(0));
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const waveRafRef = useRef(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recordingSecondsRef = useRef(0); // mismo valor que el state, pero legible sin closures viejas (ver mr.onstop)
  const recordingTimerRef = useRef(null);
  const [recordedAudio, setRecordedAudio] = useState(null); // { blob, url, ext } — pendiente de enviar o descartar
  const [sendingRecordedAudio, setSendingRecordedAudio] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [channelForm, setChannelForm] = useState({ name: '', members: [] });
  const [allUsers, setAllUsers] = useState([]);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const uploadXhrRef = useRef(null);
  const [search, setSearch] = useState('');
  const [dmsCollapsed, setDmsCollapsed] = useState(false);
  const [channelsCollapsed, setChannelsCollapsed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [dmTabs, setDmTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const fileInputRef = useRef(null);
  // true justo después de cargar los mensajes de una conversación recién abierta (o un cambio de
  // tab dentro de un DM) — hace que el scroll al fondo sea instantáneo en vez de animado, y evita
  // que la animación quede "a mitad de camino" si el layout crece mientras tanto (ver más abajo).
  const justLoadedRef = useRef(false);

  // Usar refs para valores que el socket handler necesita sin re-registrarse
  const activeConvRef = useRef(null);
  const activeTabRef = useRef(null);
  const userRef = useRef(null);
  const setMessagesRef = useRef(setMessages);
  const setUnreadCountsRef = useRef(setUnreadCounts);
  const setConversationsRef = useRef(setConversations);
  const setChannelsRef = useRef(setChannels);

  // Si se navega fuera del chat a mitad de una grabación hay que soltar TODO a mano. El comentario
  // anterior acá daba por hecho que el stream del micrófono se cortaba solo al desmontar; no
  // existía tal cleanup, así que el indicador de micrófono del navegador quedaba prendido y el
  // MediaRecorder seguía acumulando chunks por el resto de la sesión.
  useEffect(() => () => {
    if (waveRafRef.current) cancelAnimationFrame(waveRafRef.current);
    audioCtxRef.current?.close().catch(() => {});
    clearInterval(recordingTimerRef.current);
    try {
      if (mediaRecorderRef.current?.state && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } catch { /* el recorder ya podía estar muerto */ }
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    // Una nota de voz grabada pero nunca enviada ni descartada deja su blob colgado en memoria.
    if (recordedAudioUrlRef.current) URL.revokeObjectURL(recordedAudioUrlRef.current);
  }, []);

  useEffect(() => { recordedAudioUrlRef.current = recordedAudio?.url || null; }, [recordedAudio]);

  useEffect(() => { activeConvRef.current = activeConv; }, [activeConv]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { userRef.current = user; }, [user]);

  const initials = (name) => initialsBase(name, '?');
  const isOnline = (id) => onlineUsers.includes(id);

  // Cargar conversaciones y no leídos al montar
  useEffect(() => {
    loadConversations();
    api('/api/chat/unread').then(setUnreadCounts).catch(console.error);
    if (user?.role === 'admin') {
      api('/api/users')
        .then(u => setAllUsers(u.filter(x => x.id !== user.id)))
        .catch(console.error);
    }
  }, []); // eslint-disable-line

  // Handler del socket — registrado UNA sola vez con socket
  useEffect(() => {
    if (!socket) return;

    const handleChatMessage = (msg) => {
      const conv = activeConvRef.current;
      const me = userRef.current;
      if (!me) return;

      const isForActiveConv = conv && (
        (conv.type === 'dm' && msg.type === 'dm' &&
          ((msg.sender_id === me.id && msg.receiver_id === conv.id) ||
           (msg.sender_id === conv.id && msg.receiver_id === me.id))) ||
        (conv.type === 'channel' && msg.type === 'channel' && msg.channel_id === conv.id)
      );

      if (isForActiveConv) {
        const tab = activeTabRef.current;
        const msgTab = msg.client_id || null;
        const tabMatches = conv.type !== 'dm' || tab === msgTab;
        if (tabMatches) {
          setMessagesRef.current(prev =>
            prev.some(m => m.id === msg.id) ? prev : [...prev, msg]
          );
        }
        api('/api/chat/read', { method: 'POST', body: { type: conv.type, id: conv.id } })
          .catch(() => {});
      } else if (msg.sender_id !== me.id) {
        // Incrementar badge de no leídos
        const key = msg.type === 'dm'
          ? `dm:${msg.sender_id}`
          : `channel:${msg.channel_id}`;
        setUnreadCountsRef.current(prev => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
      }

      // Actualizar preview del sidebar
      const preview = msg.content || (msg.file_type ? '📎 Archivo' : '');
      if (msg.type === 'dm') {
        const otherId = msg.sender_id === me.id ? msg.receiver_id : msg.sender_id;
        setConversationsRef.current(prev =>
          prev.map(c => c.id === otherId ? { ...c, last_message: preview } : c)
        );
      } else if (msg.type === 'channel') {
        setChannelsRef.current(prev =>
          prev.map(c => c.id === msg.channel_id ? { ...c, last_message: preview } : c)
        );
      }
    };

    const handleChatRead = ({ type, id }) => {
      const key = type === 'dm' ? `dm:${id}` : `channel:${id}`;
      setUnreadCountsRef.current(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    };

    // Tras una reconexión (WiFi cortado, pestaña dormida) pueden haber quedado mensajes sin
    // enterarse — se resincroniza la lista de conversaciones, los no leídos, y si hay una
    // conversación abierta, sus mensajes.
    const onReconnect = () => {
      loadConversations();
      api('/api/chat/unread').then(setUnreadCountsRef.current).catch(() => {});
      const conv = activeConvRef.current;
      if (conv) {
        const tab = activeTabRef.current;
        const tabParam = (conv.type === 'dm' && tab) ? `&client_id=${tab}` : '';
        // Igual que en openConv: si el usuario cambió de conversación/tab mientras esta
        // respuesta de reconexión estaba en vuelo, no pisar lo que se está mostrando ahora.
        api(`/api/chat/messages?type=${conv.type}&id=${conv.id}${tabParam}`)
          .then(msgs => {
            if (activeConvRef.current?.id !== conv.id || activeConvRef.current?.type !== conv.type || activeTabRef.current !== tab) return;
            setMessagesRef.current(msgs);
          })
          .catch(() => {});
      }
    };

    socket.on('chat:message', handleChatMessage);
    socket.on('chat:read', handleChatRead);
    socket.on('connect', onReconnect);

    return () => {
      socket.off('chat:message', handleChatMessage);
      socket.off('chat:read', handleChatRead);
      socket.off('connect', onReconnect);
    };
  }, [socket]); // solo depende del socket, no de activeConv ni user

  // Scroll al último mensaje. Al recién abrir una conversación (o cambiar de tab dentro de un DM)
  // va instantáneo (justLoadedRef), no animado — con "smooth" el destino se calcula una sola vez al
  // arrancar la animación, así que si el layout todavía estaba creciendo (una imagen sin cargar
  // corriendo el alto del mensaje hacia abajo) el scroll quedaba "corto", a mitad de camino en vez
  // de llegar al final real. El onLoad de las imágenes (más abajo) corrige ese caso además de esto.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: justLoadedRef.current ? 'auto' : 'smooth' });
    justLoadedRef.current = false;
  }, [messages]);

  // Si una imagen recién cargada empuja el contenido hacia abajo y ya estábamos cerca del final,
  // reajusta el scroll — sin el chequeo de distancia, esto tironearía la vista de alguien que
  // scrolleó arriba a propósito para leer mensajes viejos con imágenes todavía sin cachear.
  const rescrollIfNearBottom = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  };

  const loadConversations = async () => {
    try {
      const data = await api('/api/chat/conversations');
      setConversations(data.dms || []);
      setChannels(data.channels || []);
    } catch (e) {
      console.error('Error cargando conversaciones:', e);
    }
  };

  const openConv = async (conv) => {
    activeConvRef.current = conv;
    setActiveConv(conv);
    setMessages([]);
    setDmTabs([]);
    setActiveTab(null);
    activeTabRef.current = null;
    // Antes, apenas se limpiaba messages a [] ya se mostraba "sin mensajes todavía" mientras
    // la carga real seguía en vuelo — un parpadeo confuso en conexiones lentas. Con este flag,
    // el placeholder de vacío solo aparece cuando de verdad terminó de cargar y no hay nada.
    setLoadingMessages(true);

    const key = conv.type === 'dm' ? `dm:${conv.id}` : `channel:${conv.id}`;
    setUnreadCounts(prev => { const n = { ...prev }; delete n[key]; return n; });

    // Si el usuario ya cambió de conversación cuando estas respuestas llegan, las descartamos
    // (si no, una respuesta lenta de la conversación anterior pisa lo que se está mostrando ahora).
    const isStale = () => activeConvRef.current?.id !== conv.id || activeConvRef.current?.type !== conv.type;

    try {
      if (conv.type === 'dm') {
        const tabs = await api(`/api/chat/dm-tabs?userId=${conv.id}`);
        if (isStale()) return;
        setDmTabs(tabs || []);
      }
      const msgs = await api(`/api/chat/messages?type=${conv.type}&id=${conv.id}`);
      if (isStale()) return;
      justLoadedRef.current = true;
      setMessages(msgs);
      setHasMore(msgs.length >= 50);
      await api('/api/chat/read', { method: 'POST', body: { type: conv.type, id: conv.id } });
    } catch (e) {
      console.error('Error cargando mensajes:', e);
    } finally {
      if (!isStale()) setLoadingMessages(false);
    }
  };

  const switchTab = async (clientId) => {
    setActiveTab(clientId);
    activeTabRef.current = clientId;
    setMessages([]);
    setHasMore(true);
    const conv = activeConvRef.current;
    if (!conv || conv.type !== 'dm') return;
    try {
      const tabParam = clientId ? `&client_id=${clientId}` : '';
      const msgs = await api(`/api/chat/messages?type=dm&id=${conv.id}${tabParam}`);
      if (activeTabRef.current !== clientId || activeConvRef.current !== conv) return;
      justLoadedRef.current = true;
      setMessages(msgs);
      setHasMore(msgs.length >= 50);
    } catch (e) {
      console.error('Error cargando mensajes del tab:', e);
    }
  };

  const loadOlderMessages = useCallback(async () => {
    const conv = activeConvRef.current;
    if (!conv || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      const oldest = messages[0];
      if (!oldest) return;
      const tabParam = (conv.type === 'dm' && activeTabRef.current) ? `&client_id=${activeTabRef.current}` : '';
      const older = await api(`/api/chat/messages?type=${conv.type}&id=${conv.id}&before=${oldest.id}${tabParam}`);
      if (older.length < 50) setHasMore(false);
      if (older.length > 0) {
        const container = messagesContainerRef.current;
        const prevHeight = container?.scrollHeight || 0;
        setMessages(prev => [...older, ...prev]);
        requestAnimationFrame(() => {
          if (container) container.scrollTop = container.scrollHeight - prevHeight;
        });
      }
    } catch (e) {
      console.error('Error cargando mensajes anteriores:', e);
    } finally {
      setLoadingOlder(false);
    }
  }, [messages, loadingOlder, hasMore, api]);

  const sendMessage = async (content, fileUrl, fileType, fileName, fileDuration) => {
    const conv = activeConvRef.current;
    if (!conv) return;
    if (!content?.trim() && !fileUrl) return;
    // El input recién se limpia con la respuesta del POST, así que en una conexión lenta (o con
    // el cold start de Render) el texto sigue ahí y un segundo Enter mandaba el mismo mensaje dos
    // veces. El guard va en un ref y no en state porque tiene que valer ya en el mismo tick.
    if (sendingMessageRef.current) return;
    sendingMessageRef.current = true;

    const body = {
      type: conv.type,
      receiver_id: conv.type === 'dm' ? conv.id : null,
      channel_id: conv.type === 'channel' ? conv.id : null,
      content: content || '',
      file_url: fileUrl || null,
      file_type: fileType || null,
      file_name: fileName || null,
      file_duration: fileDuration || null,
      client_id: conv.type === 'dm' ? (activeTabRef.current || null) : null,
    };

    try {
      await api('/api/chat/messages', { method: 'POST', body });
      setInput('');
    } catch (e) {
      await alert('No se pudo enviar: ' + e.message);
    } finally {
      sendingMessageRef.current = false;
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadingFile(true);
    setUploadProgress(0);
    try {
      const res = await uploadWithProgress('/api/chat/upload', file, token, {
        onProgress: setUploadProgress,
        xhrRef: uploadXhrRef
      });

      const fileUrl = res?.url;
      if (!fileUrl) throw new Error('No se pudo obtener la URL del archivo');

      let fileType = 'file';
      const mime = file.type.toLowerCase();
      if (mime.startsWith('image/')) fileType = 'image';
      else if (mime.startsWith('video/')) fileType = 'video';
      else if (mime.startsWith('audio/')) fileType = 'audio';

      await sendMessage('', fileUrl, fileType, file.name);
    } catch (err) {
      if (err.name !== 'AbortError') await alert('Error al subir archivo: ' + err.message);
    } finally {
      setUploadingFile(false);
      setUploadProgress(0);
      uploadXhrRef.current = null;
      e.target.value = '';
    }
  };

  const cancelFileUpload = () => { uploadXhrRef.current?.abort(); };

  // Forma de onda en vivo mientras se graba (estilo WhatsApp/Slack), vía Web Audio API sobre
  // el mismo stream del micrófono — no toca nada de la grabación en sí, es puramente visual.
  const startWaveform = (stream) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return; // navegador sin soporte: la grabación sigue andando igual
    const audioCtx = new AudioContextClass();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    audioCtxRef.current = audioCtx;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      // RMS de la desviación respecto al centro (128 = silencio) normalizado a 0-1.
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const level = Math.min(1, Math.sqrt(sumSquares / data.length) * 4);
      setWaveLevels(prev => [...prev.slice(1), level]);
      waveRafRef.current = requestAnimationFrame(tick);
    };
    waveRafRef.current = requestAnimationFrame(tick);
  };

  const stopWaveform = () => {
    if (waveRafRef.current) cancelAnimationFrame(waveRafRef.current);
    waveRafRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    setWaveLevels(Array(WAVE_BARS).fill(0));
    clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    setRecordingSeconds(0);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      await alert('Tu navegador no soporta grabación. Usá Chrome o Firefox.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startWaveform(stream);

      // Detectar codec compatible
      const mimeType =
        MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
        MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' :
        MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorderRef.current = mr;
      micStreamRef.current = stream;
      const chunks = [];

      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        mediaRecorderRef.current = null;
        micStreamRef.current = null;
        // Se lee antes de stopWaveform (que resetea el state, aunque no esta ref) para tener
        // la duración real ya calculada — los .webm de MediaRecorder no siempre reportan su
        // propia duración de forma confiable, así que no dependemos del navegador para mostrarla.
        const durationSec = recordingSecondsRef.current;
        stopWaveform();
        if (chunks.length === 0) return;
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        // No se sube todavía — se muestra un preview escuchable (como Slack) y recién se sube
        // si el usuario confirma con "Enviar". Descartar simplemente tira el blob, sin request.
        setRecordedAudio({ blob, url: URL.createObjectURL(blob), ext, durationSec });
      };

      mr.onerror = () => {
        stream.getTracks().forEach(t => t.stop());
        mediaRecorderRef.current = null;
        micStreamRef.current = null;
        stopWaveform();
        setRecording(false);
        setMediaRecorder(null);
      };

      mr.start(250);
      setMediaRecorder(mr);
      setRecording(true);
      setRecordingSeconds(0);
      recordingSecondsRef.current = 0;
      recordingTimerRef.current = setInterval(() => {
        recordingSecondsRef.current += 1;
        setRecordingSeconds(recordingSecondsRef.current);
      }, 1000);
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        await alert('Permiso de micrófono denegado. Habilitalo en ajustes del navegador.');
      } else if (err.name === 'NotFoundError') {
        await alert('No se encontró micrófono. Conectá uno e intentá de nuevo.');
      } else {
        await alert('Error al grabar: ' + err.message);
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    setMediaRecorder(null);
    setRecording(false);
  };

  const discardRecordedAudio = () => {
    if (recordedAudio) URL.revokeObjectURL(recordedAudio.url);
    setRecordedAudio(null);
  };

  const sendRecordedAudio = async () => {
    if (!recordedAudio || sendingRecordedAudio) return;
    setSendingRecordedAudio(true);
    try {
      const formData = new FormData();
      formData.append('file', recordedAudio.blob, `nota-de-voz.${recordedAudio.ext}`);
      const res = await api('/api/chat/upload', { method: 'POST', body: formData });
      const fileUrl = typeof res === 'string' ? null : res.url;
      if (fileUrl) await sendMessage('', fileUrl, 'audio', `Nota de voz.${recordedAudio.ext}`, recordedAudio.durationSec);
      discardRecordedAudio();
    } catch (err) {
      await alert('Error al enviar nota de voz: ' + err.message);
    } finally {
      setSendingRecordedAudio(false);
    }
  };

  const createChannel = async () => {
    if (!channelForm.name.trim()) return;
    try {
      const newChannel = await api('/api/chat/channels', { method: 'POST', body: channelForm });
      setChannels(prev => [...prev, { ...newChannel, last_message: null }]);
      setShowNewChannel(false);
      setChannelForm({ name: '', members: [] });
      openConv({ type: 'channel', id: newChannel.id, name: newChannel.name });
    } catch (e) {
      await alert('Error al crear canal: ' + e.message);
    }
  };

  const totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
  const filteredDms = conversations.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  const filteredChannels = channels.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* ── SIDEBAR ── */}
      <div style={{ width: 240, background: 'var(--bg2)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>

        {/* Header del sidebar */}
        <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>Chat</span>
              <span tabIndex={0}
                title="Mensajes directos: 1 a 1 con otra persona. Canales: grupales, con varios miembros. Notas (📝): tu bloc de notas personal, solo vos lo ves. Cada proyecto tiene además su propio chat, en la pestaña 'Chat' dentro del proyecto."
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, borderRadius: '50%', background: 'var(--bg3)', color: 'var(--text3)', fontSize: 10, cursor: 'default' }}>
                ⓘ
              </span>
            </div>
            {totalUnread > 0 && (
              <span className="badge badge-count" style={{ fontSize: 10, padding: '1px 7px' }}>
                {totalUnread}
              </span>
            )}
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar..."
            style={{ width: '100%', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font)', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>

          {/* Sección DMs */}
          <div style={{ padding: '10px 10px 4px' }}>
            <button
              onClick={() => setDmsCollapsed(p => !p)}
              style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 5, marginBottom: 4 }}
            >
              <span style={{ fontSize: 10, color: 'var(--text3)', display: 'inline-block', transition: 'transform 0.15s', transform: dmsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1, textAlign: 'left' }}>Mensajes directos</span>
            </button>

            {!dmsCollapsed && (
              <>
                {filteredDms.length === 0 && !search && (
                  <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--text3)' }}>Sin conversaciones</div>
                )}
                {filteredDms.map(c => {
                  const key = `dm:${c.id}`;
                  return (
                    <SidebarItem
                      key={c.id}
                      label={c.name}
                      subtitle={c.is_self ? (c.last_message || 'Tu bloc de notas personal') : c.last_message}
                      active={activeConv?.type === 'dm' && activeConv?.id === c.id}
                      unread={unreadCounts[key] || 0}
                      online={!c.is_self && isOnline(c.id)}
                      color={c.color}
                      isUser
                      initials={c.is_self ? '📝' : initials(c.name)}
                      onClick={() => openConv({ type: 'dm', id: c.id, name: c.name, color: c.color, isSelf: c.is_self })}
                    />
                  );
                })}
                {user?.role === 'admin' && allUsers.length > 0 && (
                  <select
                    value=""
                    onChange={e => {
                      const u = allUsers.find(x => x.id === e.target.value);
                      if (u) openConv({ type: 'dm', id: u.id, name: u.name, color: u.avatar_color });
                    }}
                    style={{ width: '100%', background: 'transparent', border: '1px dashed var(--border)', borderRadius: 7, padding: '5px 8px', color: 'var(--text3)', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font)', marginTop: 4 }}
                  >
                    <option value="">＋ Nuevo mensaje directo</option>
                    {allUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                )}
              </>
            )}
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '4px 10px' }} />

          {/* Sección Canales */}
          <div style={{ padding: '4px 10px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
              <button
                onClick={() => setChannelsCollapsed(p => !p)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 5 }}
              >
                <span style={{ fontSize: 10, color: 'var(--text3)', display: 'inline-block', transition: 'transform 0.15s', transform: channelsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Canales</span>
              </button>
              {user?.role === 'admin' && (
                <button
                  onClick={() => setShowNewChannel(true)}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}
                  title="Nuevo canal"
                >＋</button>
              )}
            </div>

            {!channelsCollapsed && (
              <>
                {filteredChannels.length === 0 && !search && (
                  <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--text3)' }}>
                    {user?.role === 'admin' ? 'Creá un canal con ＋' : 'Sin canales asignados'}
                  </div>
                )}
                {filteredChannels.map(c => {
                  const key = `channel:${c.id}`;
                  return (
                    <SidebarItem
                      key={c.id}
                      label={c.name}
                      subtitle={c.last_message}
                      active={activeConv?.type === 'channel' && activeConv?.id === c.id}
                      unread={unreadCounts[key] || 0}
                      isChannel
                      memberCount={c.member_count}
                      onClick={() => openConv({ type: 'channel', id: c.id, name: c.name })}
                    />
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* Footer: usuario actual */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ position: 'relative' }}>
            <div className="avatar" style={{ background: user?.avatar_color || 'var(--accent)', width: 28, height: 28, fontSize: 11 }}>
              {initials(user?.name)}
            </div>
            <div style={{ position: 'absolute', bottom: 0, right: 0, width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', border: '2px solid var(--bg2)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
            <div style={{ fontSize: 10, color: 'var(--green)' }}>En línea</div>
          </div>
        </div>
      </div>

      {/* ── ÁREA PRINCIPAL ── */}
      {!activeConv ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, color: 'var(--text3)' }}>
          <div style={{ fontSize: 48 }}>💬</div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--text2)', marginBottom: 6 }}>Bienvenido al chat</p>
            <p style={{ fontSize: 13 }}>Seleccioná un mensaje directo o un canal</p>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Header */}
          <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            {activeConv.type === 'dm' ? (
              <>
                <div style={{ position: 'relative' }}>
                  <div className="avatar" style={{ background: activeConv.color || 'var(--accent)', width: 36, height: 36, fontSize: 13 }}>
                    {activeConv.isSelf ? '📝' : initials(activeConv.name)}
                  </div>
                  {!activeConv.isSelf && isOnline(activeConv.id) && (
                    <div style={{ position: 'absolute', bottom: 0, right: 0, width: 10, height: 10, borderRadius: '50%', background: 'var(--green)', border: '2px solid var(--bg)' }} />
                  )}
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{activeConv.name}</div>
                  <div style={{ fontSize: 11, color: activeConv.isSelf ? 'var(--text3)' : isOnline(activeConv.id) ? 'var(--green)' : 'var(--text3)' }}>
                    {activeConv.isSelf ? 'Solo vos podés ver estos mensajes' : isOnline(activeConv.id) ? '● En línea' : '○ Desconectado'}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: 'var(--text2)' }}>#</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{activeConv.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>Canal</div>
                </div>
              </>
            )}
          </div>

          {/* Pestañas por cliente (solo DMs con tabs) */}
          {activeConv.type === 'dm' && dmTabs.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0, overflowX: 'auto' }}>
              <button onClick={() => switchTab(null)} style={{
                padding: '10px 16px', background: 'transparent', border: 'none',
                borderBottom: !activeTab ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer', fontSize: 13, fontWeight: !activeTab ? 700 : 500,
                color: !activeTab ? 'var(--accent)' : 'var(--text3)',
                fontFamily: 'var(--font)', whiteSpace: 'nowrap', transition: 'all 0.15s'
              }}>General</button>
              {dmTabs.map(client => (
                <button key={client.id} onClick={() => switchTab(client.id)} style={{
                  padding: '10px 16px', background: 'transparent', border: 'none',
                  borderBottom: activeTab === client.id ? '2px solid var(--accent)' : '2px solid transparent',
                  cursor: 'pointer', fontSize: 13, fontWeight: activeTab === client.id ? 700 : 500,
                  color: activeTab === client.id ? 'var(--accent)' : 'var(--text3)',
                  fontFamily: 'var(--font)', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6,
                  transition: 'all 0.15s'
                }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: client.color || '#6366f1', flexShrink: 0 }} />
                  {client.name}
                </button>
              ))}
            </div>
          )}

          {/* Lista de mensajes */}
          <div
            ref={messagesContainerRef}
            onScroll={e => { if (e.target.scrollTop < 80 && hasMore && !loadingOlder) loadOlderMessages(); }}
            style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 2 }}
          >
            {hasMore && messages.length > 0 && (
              <div style={{ textAlign: 'center', padding: '8px 0' }}>
                <button
                  onClick={loadOlderMessages}
                  disabled={loadingOlder}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}
                >
                  {loadingOlder ? 'Cargando...' : 'Cargar mensajes anteriores'}
                </button>
              </div>
            )}
            {loadingMessages && messages.length === 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 60 }}><div className="spinner" /></div>
            )}
            {!loadingMessages && messages.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text3)', fontSize: 13, marginTop: 60 }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>{activeConv.isSelf ? '📝' : '👋'}</div>
                <p>{activeConv.type === 'channel' ? `Inicio de #${activeConv.name}` : activeConv.isSelf ? 'Anotá lo que quieras, solo vos lo vas a ver' : activeTab ? `Sin mensajes sobre ${dmTabs.find(t => t.id === activeTab)?.name || 'este cliente'}` : `Inicio de la conversación con ${activeConv.name}`}</p>
              </div>
            )}
            {messages.map((msg, i) => {
              const prev = messages[i - 1];
              const compact = prev &&
                prev.sender_id === msg.sender_id &&
                (new Date(msg.created_at) - new Date(prev.created_at)) < 5 * 60 * 1000;
              return (
                <Message
                  key={msg.id}
                  msg={msg}
                  isMe={msg.sender_id === user?.id}
                  compact={compact}
                  initials={initials}
                  mediaUrl={mediaUrl}
                  onImageLoad={rescrollIfNearBottom}
                />
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            {recordedAudio ? (
              // Preview de la nota de voz ya grabada — nada se sube todavía, hace falta
              // confirmar con "Enviar" (mismo patrón que Slack: grabar no es enviar).
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg2)', borderRadius: 12, padding: '8px 12px', border: '1px solid var(--border)' }}>
                <button
                  onClick={discardRecordedAudio}
                  disabled={sendingRecordedAudio}
                  style={{ ...btnStyle, color: 'var(--text3)' }}
                  title="Descartar"
                >
                  🗑
                </button>
                <VoiceNotePlayer src={recordedAudio.url} knownDuration={recordedAudio.durationSec} />
                <button
                  onClick={sendRecordedAudio}
                  disabled={sendingRecordedAudio}
                  style={{
                    background: 'var(--accent)', border: 'none', borderRadius: 8, width: 32, height: 32,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: sendingRecordedAudio ? 'default' : 'pointer', opacity: sendingRecordedAudio ? 0.6 : 1,
                    transition: 'all 0.15s', flexShrink: 0
                  }}
                  title="Enviar nota de voz"
                >
                  <span style={{ fontSize: 14, color: '#fff' }}>{sendingRecordedAudio ? '…' : '↑'}</span>
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', borderRadius: 12, padding: '8px 12px', border: '1px solid var(--border)' }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                  accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.zip,.txt"
                />
                <button
                  onClick={() => !uploadingFile && fileInputRef.current?.click()}
                  style={{ ...btnStyle, opacity: uploadingFile ? 0.5 : 1 }}
                  title={uploadingFile ? 'Subiendo...' : 'Adjuntar archivo'}
                  disabled={uploadingFile}
                >
                  {uploadingFile ? '⏳' : '📎'}
                </button>
                {uploadingFile && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text3)' }}>
                    {uploadProgress}%
                    <button onClick={cancelFileUpload} title="Cancelar subida"
                      style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                      ✕
                    </button>
                  </span>
                )}
                <button
                  onClick={recording ? stopRecording : startRecording}
                  style={{ ...btnStyle, color: recording ? 'var(--red)' : undefined }}
                  title={recording ? 'Detener grabación' : 'Nota de voz'}
                >
                  {recording ? '⏹' : '🎤'}
                </button>
                {recording && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }}>
                    <span style={{ fontSize: 10, color: 'var(--red)' }}>●</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 20 }}>
                      {waveLevels.map((lvl, i) => (
                        <div key={i} style={{
                          width: 2.5,
                          height: Math.max(2, lvl * 18),
                          borderRadius: 2,
                          background: 'var(--red)',
                          opacity: 0.5 + lvl * 0.5,
                          transition: 'height 0.05s linear'
                        }} />
                      ))}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text3)', fontVariantNumeric: 'tabular-nums' }}>{formatRecordingTime(recordingSeconds)}</span>
                  </div>
                )}
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage(input);
                    }
                  }}
                  placeholder={activeConv.type === 'channel' ? `Mensaje en #${activeConv.name}...` : activeConv.isSelf ? 'Escribí una nota...' : activeTab ? `Mensaje a ${activeConv.name} sobre ${dmTabs.find(t => t.id === activeTab)?.name || 'cliente'}...` : `Mensaje a ${activeConv.name}...`}
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--font)' }}
                />
                <button
                  onClick={() => sendMessage(input)}
                  disabled={!input.trim() && !recording}
                  style={{
                    background: input.trim() ? 'var(--accent)' : 'var(--bg4)',
                    border: 'none', borderRadius: 8, width: 32, height: 32,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: input.trim() ? 'pointer' : 'default',
                    transition: 'all 0.15s', flexShrink: 0
                  }}
                >
                  <span style={{ fontSize: 14, color: '#fff' }}>↑</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal nuevo canal */}
      {showNewChannel && user?.role === 'admin' && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowNewChannel(false)} title="Cerrar">✕</button>
            <h2>Nuevo canal</h2>
            <div className="form-group">
              <label>Nombre del canal</label>
              <input
                className="input"
                value={channelForm.name}
                onChange={e => setChannelForm(p => ({ ...p, name: e.target.value.toLowerCase().replace(/\s+/g, '-') }))}
                placeholder="ej: entregas, general, feedback"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Agregar miembros</label>
              <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {allUsers.map(u => (
                  <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '5px 4px', borderRadius: 6 }}>
                    <input
                      type="checkbox"
                      checked={channelForm.members.includes(u.id)}
                      onChange={e => setChannelForm(p => ({
                        ...p,
                        members: e.target.checked
                          ? [...p.members, u.id]
                          : p.members.filter(id => id !== u.id)
                      }))}
                    />
                    <div className="avatar" style={{ background: u.avatar_color, width: 24, height: 24, fontSize: 10 }}>
                      {initials(u.name)}
                    </div>
                    <span style={{ fontSize: 13 }}>{u.name}</span>
                  </label>
                ))}
                {allUsers.length === 0 && (
                  <p style={{ fontSize: 12, color: 'var(--text3)' }}>No hay otros usuarios disponibles</p>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn btn-ghost" onClick={() => setShowNewChannel(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={createChannel} disabled={!channelForm.name.trim()}>
                Crear canal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ESTILOS ──
const btnStyle = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  fontSize: 17, padding: '2px 4px', borderRadius: 6,
  color: 'var(--text2)', lineHeight: 1
};

// ── COMPONENTES ──

function SidebarItem({ label, subtitle, active, unread, online, color, isUser, isChannel, initials, memberCount, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9,
        padding: '6px 8px', borderRadius: 7, marginBottom: 1,
        cursor: 'pointer',
        background: active ? 'var(--accent)' : hover ? 'var(--bg3)' : 'transparent',
        transition: 'background 0.1s'
      }}
    >
      {isUser && (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div className="avatar" style={{ background: color || 'var(--accent)', width: 26, height: 26, fontSize: 10 }}>
            {initials}
          </div>
          {online && (
            <div style={{ position: 'absolute', bottom: 0, right: 0, width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', border: '2px solid var(--bg2)' }} />
          )}
        </div>
      )}
      {isChannel && (
        <span style={{ fontSize: 14, fontWeight: 700, color: active ? '#fff' : 'var(--text3)', width: 26, textAlign: 'center', flexShrink: 0 }}>#</span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: unread > 0 ? 700 : 500, color: active ? '#fff' : 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </div>
        {subtitle && (
          <div style={{ fontSize: 11, color: active ? 'rgba(255,255,255,0.65)' : 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        )}
      </div>
      {unread > 0 && (
        <div style={{ background: active ? '#fff' : 'var(--red)', color: active ? 'var(--accent)' : '#fff', fontSize: 10, borderRadius: 10, padding: '1px 6px', fontWeight: 700, flexShrink: 0 }}>
          {unread}
        </div>
      )}
      {isChannel && !unread && memberCount != null && (
        <span style={{ fontSize: 10, color: active ? 'rgba(255,255,255,0.5)' : 'var(--text3)', flexShrink: 0 }}>{memberCount}</span>
      )}
    </div>
  );
}

function Message({ msg, isMe, compact, initials, mediaUrl, onImageLoad }) {
  const timeStr = new Date(msg.created_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  return (
    <div style={{ display: 'flex', gap: 10, padding: compact ? '1px 0' : '8px 0 2px', alignItems: 'flex-start' }}>
      <div style={{ width: 36, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {!compact ? (
          <div className="avatar" style={{ background: msg.sender_color || 'var(--accent)', width: 34, height: 34, fontSize: 12 }}>
            {initials(msg.sender_name)}
          </div>
        ) : (
          <span style={{ fontSize: 10, color: 'var(--text3)', paddingTop: 2 }}>{timeStr}</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!compact && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: isMe ? 'var(--accent)' : 'var(--text)' }}>
              {msg.sender_name}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{timeStr}</span>
          </div>
        )}
        {msg.file_type === 'image' && (
          <img
            src={mediaUrl(msg.file_url)}
            alt={msg.file_name || 'imagen'}
            style={{ maxWidth: 300, maxHeight: 220, borderRadius: 8, display: 'block', cursor: 'pointer', marginBottom: 2 }}
            onClick={() => window.open(mediaUrl(msg.file_url), '_blank')}
            onLoad={onImageLoad}
          />
        )}
        {msg.file_type === 'video' && (
          <video
            src={mediaUrl(msg.file_url)}
            controls
            style={{ maxWidth: 360, borderRadius: 8, display: 'block', marginBottom: 2, background: '#000' }}
          />
        )}
        {msg.file_type === 'audio' && (
          <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 16, padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <span style={{ fontSize: 16 }}>🎤</span>
            <VoiceNotePlayer src={mediaUrl(msg.file_url)} knownDuration={msg.file_duration} />
          </div>
        )}
        {msg.file_type === 'file' && (
          <a href={mediaUrl(msg.file_url)} download={msg.file_name} style={{ textDecoration: 'none', display: 'inline-block', marginBottom: 2 }}>
            <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>📎</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{msg.file_name}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>Descargar</div>
              </div>
            </div>
          </a>
        )}
        {msg.content && (
          <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.55, wordBreak: 'break-word' }}>
            {msg.content}
          </div>
        )}
      </div>
    </div>
  );
}
