/* ==========================================================================
   SALA DE PROYECCIÓN — lógica principal (versión Supabase)
   Backend: Supabase (Postgres + Realtime), gratis, sin servidor propio
   ========================================================================== */

function showConfigBanner(message){
  const banner = document.getElementById("configErrorBanner");
  banner.className = "config-banner";
  banner.textContent = message;
  banner.style.display = "block";
}

// Chequeo temprano: ¿el propio SDK de Supabase no llegó a cargar? (bloqueadores
// de anuncios o protección de rastreo estricta pueden bloquear scripts externos)
if (typeof window.supabase === "undefined"){
  showConfigBanner("⚠ El navegador bloqueó el código de Supabase (probablemente un bloqueador de anuncios o protección de rastreo). Desactívalo para este sitio, o prueba con otro navegador/red.");
  throw new Error("El SDK de Supabase no se cargó (typeof window.supabase === 'undefined').");
}

// Chequeo temprano: ¿alguien olvidó reemplazar los datos de ejemplo?
if (!SUPABASE_CONFIG || String(SUPABASE_CONFIG.url || "").includes("PEGA_AQUI")){
  showConfigBanner("⚠ Falta configurar Supabase: supabase-config.js todavía tiene los datos de ejemplo. Esta sala no funcionará para nadie hasta corregirlo.");
  throw new Error("supabase-config.js no fue configurado con credenciales reales.");
}

let sb;
try{
  sb = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
} catch(e){
  showConfigBanner("⚠ Error al iniciar Supabase: " + e.message + ". Revisa la consola del navegador (F12) para más detalles.");
  throw e;
}

// Prueba de conexión real: si la URL, la anon key, o el SQL de configuración
// están mal, esto va a devolver un error en vez de fallar en silencio.
sb.from("rooms").select("id").limit(1).then(({ error }) => {
  if (error){
    showConfigBanner("⚠ No se pudo conectar con Supabase: " + error.message + ". Revisa la URL/anon key en supabase-config.js y que hayas ejecutado supabase-schema.sql.");
  }
});

// ---------------------------------------------------------------------------
// Estado local
// ---------------------------------------------------------------------------
let roomId = null;
let myName = "Invitado";
let clientId = sessionStorage.getItem("sp_clientId") || cryptoRandomId();
sessionStorage.setItem("sp_clientId", clientId);

let channel = null;            // canal de Supabase Realtime de esta sala
let ytPlayer = null;            // instancia del reproductor de YouTube
let currentVideoType = null;    // 'youtube' | 'file' | 'iframe'
let currentVideoData = null;    // último objeto de video recibido
let applyingRemote = false;     // evita bucles al aplicar cambios remotos
let ytReady = false;
let pendingVideoAfterYtReady = null;

let isHost = false;
let currentHostId = null;
let lastPlaybackState = { isPlaying:false, time:0 };
let lastViewersData = {};       // estado de presencia (espectadores conectados ahora)
let lastQueueRows = [];

function cryptoRandomId(){
  return Math.random().toString(36).slice(2, 10);
}

function generateRoomCode(){
  const words = ["LUNA","SOL","RIO","MONTE","NIEVE","FUEGO","ROCA","VIENTO","MAR","CIELO"];
  const w = words[Math.floor(Math.random()*words.length)];
  const n = Math.floor(1000 + Math.random()*9000);
  return `${w}-${n}`;
}

// ---------------------------------------------------------------------------
// Parseo de URLs de video (idéntico a la versión Firebase)
// ---------------------------------------------------------------------------
function parseVideoUrl(raw){
  const url = raw.trim();

  const yt = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  if (yt) return { type:"youtube", id: yt[1], embedUrl:null, raw:url };

  const vimeo = url.match(/vimeo\.com\/(?:.*\/)?(\d+)/);
  if (vimeo) return { type:"iframe", id:vimeo[1], embedUrl:`https://player.vimeo.com/video/${vimeo[1]}`, raw:url };

  const okru = url.match(/ok\.ru\/(?:video|live)\/(\d+)/);
  if (okru) return { type:"iframe", id:okru[1], embedUrl:`https://ok.ru/videoembed/${okru[1]}`, raw:url };

  const archive = url.match(/archive\.org\/details\/([^\/\?]+)/);
  if (archive) return { type:"iframe", id:archive[1], embedUrl:`https://archive.org/embed/${archive[1]}`, raw:url };

  if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(url)) return { type:"file", id:null, embedUrl:url, raw:url };

  return { type:"iframe", id:null, embedUrl:url, raw:url };
}

// ---------------------------------------------------------------------------
// Arranque: pantalla de unirse
// ---------------------------------------------------------------------------
const joinScreen = document.getElementById("joinScreen");
const roomScreen = document.getElementById("roomScreen");
const nameInput = document.getElementById("nameInput");
const codeInput = document.getElementById("codeInput");
const joinBtn = document.getElementById("joinBtn");
const joinError = document.getElementById("joinError");

const hashMatch = location.hash.match(/room=([A-Za-z0-9-]+)/);
if (hashMatch) codeInput.value = hashMatch[1];

const savedName = localStorage.getItem("sp_name");
if (savedName) nameInput.value = savedName;

joinBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name){ joinError.textContent = "Escribe un nombre para entrar."; return; }
  localStorage.setItem("sp_name", name);
  myName = name;

  let code = codeInput.value.trim().toUpperCase();
  if (!code) code = generateRoomCode();

  enterRoom(code);
});

function enterRoom(code){
  roomId = code;
  location.hash = `room=${code}`;
  joinScreen.style.display = "none";
  roomScreen.classList.add("active");
  document.getElementById("roomCodeLabel").textContent = roomId;
  initRoomSync();
}

// ---------------------------------------------------------------------------
// Sincronización con Supabase
// ---------------------------------------------------------------------------
async function initRoomSync(){
  // 1. asegurar que la fila de la sala exista
  const { data: existing } = await sb.from("rooms").select("id").eq("id", roomId).maybeSingle();
  if (!existing) await sb.from("rooms").insert({ id: roomId });

  // 2. intentar ser el anfitrión: solo se aplica si nadie más lo es todavía
  //    (equivalente a la transacción que usábamos en Firebase)
  await sb.from("rooms").update({ host_id: clientId, host_name: myName }).eq("id", roomId).is("host_id", null);

  // 3. cargar estado inicial de la sala (video, reproducción, anfitrión)
  const { data: room } = await sb.from("rooms").select("*").eq("id", roomId).single();
  applyRoomRow(room);

  // 4. cargar historial de chat (últimos 100 mensajes)
  const { data: chatHistory } = await sb.from("room_chat").select("*").eq("room_id", roomId).order("ts", { ascending:true }).limit(100);
  (chatHistory || []).forEach(renderChatMessage);

  // 5. cargar la cola actual
  const { data: queueRows } = await sb.from("room_queue").select("*").eq("room_id", roomId).order("ts", { ascending:true });
  lastQueueRows = queueRows || [];
  renderQueue(lastQueueRows);

  requestWakeLock(); // evita que el dispositivo se duerma durante la función

  // 6. canal en tiempo real: presencia (quién está conectado, se actualiza sola
  //    al instante cuando alguien cierra la pestaña — no hace falta heartbeat)
  channel = sb.channel(`room:${roomId}`, { config: { presence: { key: clientId } } });

  channel.on("presence", { event: "sync" }, () => {
    lastViewersData = channel.presenceState();
    document.getElementById("viewerCount").textContent = Object.keys(lastViewersData).length;
    renderViewers();
    maybePromoteNewHost();
  });

  channel.on("postgres_changes", { event:"UPDATE", schema:"public", table:"rooms", filter:`id=eq.${roomId}` }, payload => {
    applyRoomRow(payload.new);
  });

  channel.on("postgres_changes", { event:"INSERT", schema:"public", table:"room_chat", filter:`room_id=eq.${roomId}` }, payload => {
    renderChatMessage(payload.new);
  });

  channel.on("postgres_changes", { event:"*", schema:"public", table:"room_queue", filter:`room_id=eq.${roomId}` }, async () => {
    const { data: rows } = await sb.from("room_queue").select("*").eq("room_id", roomId).order("ts", { ascending:true });
    lastQueueRows = rows || [];
    renderQueue(lastQueueRows);
  });

  await channel.subscribe(async status => {
    if (status === "SUBSCRIBED") await channel.track({ name: myName, joined_at: Date.now() });
  });

  // --- controles UI ---
  document.getElementById("loadVideoBtn").addEventListener("click", () => {
    if (!isHost) return;
    const raw = document.getElementById("videoUrlInput").value.trim();
    if (!raw) return;
    const parsed = parseVideoUrl(raw);
    sb.from("rooms").update({
      video_type: parsed.type, video_id: parsed.id, video_embed_url: parsed.embedUrl, video_raw: parsed.raw,
      playback_is_playing:false, playback_time:0, playback_updated_at: new Date().toISOString()
    }).eq("id", roomId);
    document.getElementById("videoUrlInput").value = "";
  });

  document.getElementById("chatSendBtn").addEventListener("click", sendChat);
  document.getElementById("chatInput").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

  document.getElementById("queueAddBtn").addEventListener("click", () => {
    const raw = document.getElementById("queueUrlInput").value.trim();
    if (!raw) return;
    const parsed = parseVideoUrl(raw);
    sb.from("room_queue").insert({
      room_id: roomId, video_type: parsed.type, video_id: parsed.id,
      embed_url: parsed.embedUrl, raw: parsed.raw, added_by: myName
    });
    document.getElementById("queueUrlInput").value = "";
  });

  document.getElementById("copyLinkBtn").addEventListener("click", () => {
    const link = `${location.origin}${location.pathname}#room=${roomId}`;
    navigator.clipboard.writeText(link).then(() => {
      document.getElementById("copyLinkBtn").textContent = "¡Copiado!";
      setTimeout(() => document.getElementById("copyLinkBtn").textContent = "Copiar enlace", 1500);
    });
  });

  document.getElementById("leaveBtn").addEventListener("click", async () => {
    await channel.untrack();
    await channel.unsubscribe();
    location.reload();
  });

  // --- finalizar la sala (solo disponible para quien tiene el control) ---
  const endRoomBtn = document.getElementById("endRoomBtn");
  const endConfirmOverlay = document.getElementById("endConfirmOverlay");

  endRoomBtn.addEventListener("click", () => {
    if (!isHost) return;
    endConfirmOverlay.classList.add("active");
  });
  document.getElementById("cancelEndBtn").addEventListener("click", () => {
    endConfirmOverlay.classList.remove("active");
  });
  document.getElementById("confirmEndBtn").addEventListener("click", async () => {
    if (!isHost) return;
    endConfirmOverlay.classList.remove("active");
    await sb.from("rooms").update({ closed_by: myName, closed_at: new Date().toISOString() }).eq("id", roomId);
    // se espera un momento para que el aviso llegue a todos antes de borrar los datos de la sala
    setTimeout(() => sb.from("rooms").delete().eq("id", roomId), 3000);
  });

  // --- modo pantalla ampliada (el video crece dentro de la página, sin usar
  //     el fullscreen nativo del navegador; el chat flota encima con blur) ---
  const theaterBtn = document.getElementById("theaterBtn");
  const sidebarPanel = document.getElementById("sidebarPanel");
  const chatToggleTab = document.getElementById("chatToggleTab");

  theaterBtn.addEventListener("click", () => {
    const isTheater = roomScreen.classList.toggle("theater");
    theaterBtn.textContent = isTheater ? "⤡" : "⤢";
    theaterBtn.title = isTheater ? "Volver al tamaño normal" : "Ampliar reproductor";
    if (!isTheater){
      sidebarPanel.classList.remove("sidebar-hidden");
      chatToggleTab.textContent = "›";
      chatToggleTab.classList.remove("chat-hidden");
    }
  });

  chatToggleTab.addEventListener("click", () => {
    const hidden = sidebarPanel.classList.toggle("sidebar-hidden");
    chatToggleTab.classList.toggle("chat-hidden", hidden);
    chatToggleTab.textContent = hidden ? "‹" : "›";
  });

  // tabs
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

// ---------------------------------------------------------------------------
// Aplica una fila de la tabla `rooms` (video, reproducción, anfitrión, cierre)
// ---------------------------------------------------------------------------
function applyRoomRow(row){
  if (!row) return;

  const wasHost = isHost;
  currentHostId = row.host_id || null;
  isHost = row.host_id === clientId;
  updateHostUI(row.host_id ? { id: row.host_id, name: row.host_name } : null);

  const videoChanged = !currentVideoData ||
    currentVideoData.type !== row.video_type ||
    currentVideoData.embedUrl !== row.video_embed_url ||
    currentVideoData.id !== row.video_id;

  lastPlaybackState = { isPlaying: !!row.playback_is_playing, time: row.playback_time || 0 };

  if (row.video_type){
    currentVideoData = { type: row.video_type, id: row.video_id, embedUrl: row.video_embed_url, raw: row.video_raw };
    if (videoChanged || wasHost !== isHost) buildPlayer(currentVideoData);
    else applyRemotePlayback(lastPlaybackState);
  }

  if (row.closed_at) showRoomClosed(row.closed_by || row.host_name);
}

function showRoomClosed(byWhom){
  document.getElementById("roomClosedMsg").textContent = `${byWhom || "El anfitrión"} finalizó la sala.`;
  document.getElementById("roomClosedOverlay").classList.add("active");
  if (wakeLockRef) wakeLockRef.release().catch(()=>{});
  setTimeout(() => {
    location.hash = "";
    location.href = location.pathname;
  }, 2500);
}

// si el anfitrión actual ya no está conectado, se cede el control automáticamente
// a quien lleve más tiempo conectado (para que la sala nunca quede sin control)
function maybePromoteNewHost(){
  if (!currentHostId) return;
  if (lastViewersData[currentHostId]) return; // el anfitrión sigue conectado
  const remaining = Object.entries(lastViewersData)
    .sort((a,b) => (a[1][0]?.joined_at || 0) - (b[1][0]?.joined_at || 0));
  if (remaining.length){
    const [newId, metas] = remaining[0];
    sb.from("rooms").update({ host_id:newId, host_name: metas[0]?.name || "Invitado" }).eq("id", roomId);
  }
}

function sendChat(){
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;
  sb.from("room_chat").insert({ room_id: roomId, name: myName, text });
  input.value = "";
}

function renderChatMessage(msg){
  const log = document.getElementById("chatLog");
  const el = document.createElement("div");
  el.className = "msg";
  const time = msg.ts ? new Date(msg.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : "";
  el.innerHTML = `<span class="who">${escapeHtml(msg.name)}</span>${escapeHtml(msg.text)}<span class="when">${time}</span>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function renderQueue(rows){
  const list = document.getElementById("queueList");
  list.innerHTML = "";
  if (!rows.length){
    list.innerHTML = `<p class="hint">La cola está vacía.</p>`;
    return;
  }
  rows.forEach(item => {
    const row = document.createElement("div");
    row.className = "queue-item";
    const controlsHtml = isHost
      ? `<button data-action="play">Proyectar</button><button data-action="remove">Quitar</button>`
      : `<span class="hint" style="margin:0;">sugerido por ${escapeHtml(item.added_by || "alguien")}</span>`;
    row.innerHTML = `
      <span>${escapeHtml(item.raw)}</span>
      <span style="display:flex;gap:8px;flex-shrink:0;align-items:center;">${controlsHtml}</span>`;
    if (isHost){
      row.querySelector('[data-action="play"]').addEventListener("click", () => {
        sb.from("rooms").update({
          video_type: item.video_type, video_id: item.video_id, video_embed_url: item.embed_url, video_raw: item.raw,
          playback_is_playing:false, playback_time:0, playback_updated_at: new Date().toISOString()
        }).eq("id", roomId);
        sb.from("room_queue").delete().eq("id", item.id);
      });
      row.querySelector('[data-action="remove"]').addEventListener("click", () => {
        sb.from("room_queue").delete().eq("id", item.id);
      });
    }
    list.appendChild(row);
  });
}

function renderViewers(){
  const list = document.getElementById("viewersList");
  list.innerHTML = "";
  Object.entries(lastViewersData).forEach(([id, metas]) => {
    const name = metas[0]?.name || "Invitado";
    const row = document.createElement("div");
    row.className = "viewer-row";
    row.innerHTML = `<span class="dot"></span>${escapeHtml(name)}`;
    if (isHost && id !== clientId){
      const btn = document.createElement("button");
      btn.className = "give-control-btn";
      btn.textContent = "Dar control";
      btn.addEventListener("click", () => {
        sb.from("rooms").update({ host_id:id, host_name:name }).eq("id", roomId);
      });
      row.appendChild(btn);
    }
    list.appendChild(row);
  });
}

function updateHostUI(hostObj){
  const badge = document.getElementById("hostBadge");
  badge.textContent = isHost
    ? "👑 Tú tienes el control"
    : (hostObj ? `👑 ${hostObj.name} tiene el control` : "Sin anfitrión asignado");

  const loadInput = document.getElementById("videoUrlInput");
  const loadBtn = document.getElementById("loadVideoBtn");
  loadInput.disabled = !isHost;
  loadBtn.disabled = !isHost;
  loadInput.placeholder = isHost
    ? "Pega un link: YouTube, Vimeo, ok.ru, archive.org o un .mp4 directo"
    : "Solo quien tiene el control puede proyectar un video";

  document.getElementById("endRoomBtn").style.display = isHost ? "inline-block" : "none";

  renderViewers();
  if (lastQueueRows.length || document.getElementById("queueList").children.length) renderQueue(lastQueueRows);
}

function escapeHtml(str){
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Reproductor: construcción según tipo de fuente (idéntico a la versión Firebase)
// ---------------------------------------------------------------------------
function buildPlayer(video){
  const frame = document.getElementById("playerFrame");
  const syncNote = document.getElementById("syncNote");
  const expandBtn = document.getElementById("theaterBtn");
  frame.innerHTML = "";
  frame.appendChild(expandBtn);
  currentVideoType = video.type;
  ytPlayer = null;

  if (video.type === "youtube"){
    syncNote.textContent = isHost
      ? "Sincronización: exacta — tienes el control (play, pausa y segundo se comparten con todos)."
      : "Sincronización: exacta — solo quien tiene el control puede reproducir, pausar o adelantar.";
    const div = document.createElement("div");
    div.id = "ytPlayerEl";
    frame.insertBefore(div, expandBtn);
    pendingVideoAfterYtReady = lastPlaybackState;
    const create = () => {
      ytPlayer = new YT.Player("ytPlayerEl", {
        videoId: video.id,
        playerVars: {
          autoplay: 0, playsinline: 1,
          controls: isHost ? 1 : 0,
          disablekb: isHost ? 0 : 1,
          fs: 0
        },
        events: {
          onReady: () => { if (pendingVideoAfterYtReady){ applyRemotePlayback(pendingVideoAfterYtReady); pendingVideoAfterYtReady = null; } },
          onStateChange: onYtStateChange
        }
      });
    };
    if (ytReady) create(); else window.__pendingYtCreate = create;

  } else if (video.type === "file"){
    syncNote.textContent = isHost
      ? "Sincronización: exacta — tienes el control (play, pausa y segundo se comparten con todos)."
      : "Sincronización: exacta — solo quien tiene el control puede reproducir, pausar o adelantar.";
    const v = document.createElement("video");
    v.id = "filePlayerEl";
    v.src = video.embedUrl;
    v.controls = isHost;
    v.disablePictureInPicture = !isHost;
    if (isHost){
      v.addEventListener("play", () => writeLocalPlayback(true));
      v.addEventListener("pause", () => writeLocalPlayback(false));
      v.addEventListener("seeked", () => writeLocalPlayback(!v.paused));
    }
    frame.insertBefore(v, expandBtn);
    if (lastPlaybackState){
      v.currentTime = lastPlaybackState.time || 0;
      if (lastPlaybackState.isPlaying) v.play().catch(()=>{});
    }

  } else {
    syncNote.textContent = "Sincronización: solo se comparte el enlace cargado — el play/pausa de este reproductor no se puede controlar de forma remota (limitación del sitio de origen).";
    const iframe = document.createElement("iframe");
    iframe.src = video.embedUrl;
    iframe.allow = "autoplay; fullscreen; picture-in-picture";
    iframe.allowFullscreen = true;
    frame.insertBefore(iframe, expandBtn);
  }
}

function onYtStateChange(e){
  if (applyingRemote || !isHost) return;
  if (e.data === YT.PlayerState.PLAYING) writeLocalPlayback(true);
  else if (e.data === YT.PlayerState.PAUSED) writeLocalPlayback(false);
}

function writeLocalPlayback(isPlaying){
  if (!roomId || !isHost) return;
  let time = 0;
  if (currentVideoType === "youtube" && ytPlayer && ytPlayer.getCurrentTime) time = ytPlayer.getCurrentTime();
  if (currentVideoType === "file"){
    const v = document.getElementById("filePlayerEl");
    if (v) time = v.currentTime;
  }
  sb.from("rooms").update({
    playback_is_playing:isPlaying, playback_time:time, playback_updated_at: new Date().toISOString()
  }).eq("id", roomId);
}

function applyRemotePlayback(p){
  applyingRemote = true;
  if (currentVideoType === "youtube"){
    if (!ytPlayer){ pendingVideoAfterYtReady = p; applyingRemote = false; return; }
    const drift = Math.abs(ytPlayer.getCurrentTime() - p.time);
    if (drift > 1.5) ytPlayer.seekTo(p.time, true);
    if (p.isPlaying) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
  } else if (currentVideoType === "file"){
    const v = document.getElementById("filePlayerEl");
    if (v){
      if (Math.abs(v.currentTime - p.time) > 1.5) v.currentTime = p.time;
      if (p.isPlaying) v.play().catch(()=>{}); else v.pause();
    }
  }
  setTimeout(() => applyingRemote = false, 300);
}

// ---------------------------------------------------------------------------
// Mantener el dispositivo despierto durante sesiones largas (5+ horas)
// ---------------------------------------------------------------------------
let wakeLockRef = null;
async function requestWakeLock(){
  if (!("wakeLock" in navigator)) return;
  try{
    wakeLockRef = await navigator.wakeLock.request("screen");
    wakeLockRef.addEventListener("release", () => { wakeLockRef = null; });
  } catch(e){ /* el navegador pudo negarlo; no es crítico */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !wakeLockRef && roomId) requestWakeLock();
});

// La API de YouTube llama a esta función global cuando termina de cargar
function onYouTubeIframeAPIReady(){
  ytReady = true;
  if (window.__pendingYtCreate){ window.__pendingYtCreate(); window.__pendingYtCreate = null; }
}
