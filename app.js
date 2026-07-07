/* ==========================================================================
   SALA DE PROYECCIÓN — lógica principal
   Backend: Firebase Realtime Database (gratis, sin servidor propio)
   ========================================================================== */

function showConfigBanner(message){
  const banner = document.getElementById("configErrorBanner");
  banner.className = "config-banner";
  banner.textContent = message;
  banner.style.display = "block";
}

// Chequeo temprano: ¿el propio SDK de Firebase no llegó a cargar? (bloqueadores
// de anuncios, modo "Shields" de Brave, o protección de rastreo estricta suelen
// bloquear scripts de gstatic.com/Google, y esto rompe el sitio en silencio)
if (typeof firebase === "undefined"){
  showConfigBanner("⚠ El navegador bloqueó el código de Firebase (probablemente un bloqueador de anuncios o protección de rastreo). Desactívalo para este sitio, o prueba con otro navegador/red.");
  throw new Error("El SDK de Firebase no se cargó (typeof firebase === 'undefined').");
}

// Chequeo temprano: ¿alguien olvidó reemplazar los datos de ejemplo?
if (!firebaseConfig || String(firebaseConfig.apiKey || "").includes("PEGA_AQUI")){
  showConfigBanner("⚠ Falta configurar Firebase: firebase-config.js todavía tiene los datos de ejemplo. Esta sala no funcionará para nadie hasta corregirlo.");
  throw new Error("firebase-config.js no fue configurado con credenciales reales.");
}

let db;
try{
  firebase.initializeApp(firebaseConfig);
  db = firebase.database();
} catch(e){
  showConfigBanner("⚠ Error al iniciar Firebase: " + e.message + ". Revisa la consola del navegador (F12) para más detalles.");
  throw e;
}

// Monitor de conexión real (distinto de "el código cargó bien"): si no logra
// conectarse en unos segundos, probablemente la databaseURL o las reglas están mal.
setTimeout(() => {
  db.ref(".info/connected").once("value").then(snap => {
    if (snap.val() !== true){
      showConfigBanner("⚠ No se pudo conectar con la base de datos de Firebase. Revisa que la databaseURL tenga la región correcta y que las Reglas permitan lectura/escritura.");
    }
  }).catch(() => {
    showConfigBanner("⚠ Error al conectar con Firebase. Revisa la consola del navegador (F12) para más detalles.");
  });
}, 4000);

// ---------------------------------------------------------------------------
// Estado local
// ---------------------------------------------------------------------------
let roomId = null;
let myName = "Invitado";
let clientId = sessionStorage.getItem("sp_clientId") || cryptoRandomId();
sessionStorage.setItem("sp_clientId", clientId);

let ytPlayer = null;          // instancia del reproductor de YouTube
let currentVideoType = null;  // 'youtube' | 'file' | 'iframe'
let currentVideoData = null;  // último objeto de video recibido (para reconstruir el reproductor)
let applyingRemote = false;   // evita bucles al aplicar cambios remotos
let ytReady = false;
let pendingVideoAfterYtReady = null;

let isHost = false;                                  // ¿tengo yo el control ahora mismo?
let lastPlaybackState = { isPlaying:false, time:0 };  // último estado conocido, para resincronizar tras reconstruir el reproductor
let lastViewersData = {};                             // última lista de espectadores (para re-renderizar al cambiar el control)

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
// Parseo de URLs de video
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

  // último recurso: intentar como iframe genérico (puede que el sitio bloquee el embed)
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

// si venimos de un link compartido (#room=CODIGO), precargar el código
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
// Sincronización con Firebase
// ---------------------------------------------------------------------------
function initRoomSync(){
  const roomRef = db.ref(`rooms/${roomId}`);

  // --- presencia ---
  const myViewerRef = roomRef.child(`viewers/${clientId}`);
  myViewerRef.set({ name: myName, joinedAt: firebase.database.ServerValue.TIMESTAMP, lastSeen: firebase.database.ServerValue.TIMESTAMP });
  myViewerRef.onDisconnect().remove();

  // "latido" cada 60s: mantiene tu presencia viva en sesiones largas (varias horas),
  // incluso si el navegador estuvo en segundo plano y Firebase perdió el hilo del socket.
  setInterval(() => {
    myViewerRef.update({ lastSeen: firebase.database.ServerValue.TIMESTAMP });
  }, 60000);

  requestWakeLock(); // evita que el dispositivo se duerma durante la función

  // --- control de la sala: el primero en entrar a una sala vacía queda como anfitrión ---
  const hostRef = roomRef.child("host");
  hostRef.transaction(current => current === null ? { id: clientId, name: myName } : current);

  hostRef.on("value", snap => {
    const h = snap.val();
    const wasHost = isHost;
    isHost = !!h && h.id === clientId;
    updateHostUI(h);
    // si acabo de ganar o perder el control, reconstruyo el reproductor con los
    // controles correctos (solo el anfitrión puede reproducir/pausar/adelantar)
    if (wasHost !== isHost && currentVideoData) buildPlayer(currentVideoData);
  });

  window.__hostRef = hostRef; // usado al ceder el control desde la lista de espectadores

  roomRef.child("viewers").on("value", snap => {
    const all = snap.val() || {};
    const now = Date.now();
    // descarta viewers cuyo latido lleva más de 3 min sin actualizarse (conexión fantasma)
    const viewers = {};
    Object.entries(all).forEach(([id, v]) => {
      if (!v.lastSeen || now - v.lastSeen < 180000) viewers[id] = v;
    });
    lastViewersData = viewers;
    const ids = Object.keys(viewers);
    document.getElementById("viewerCount").textContent = ids.length;
    renderViewers();

    // si el anfitrión actual ya no está en la sala, se cede el control automáticamente
    // a quien lleve más tiempo conectado (para que la sala nunca quede sin control)
    hostRef.once("value").then(hsnap => {
      const h = hsnap.val();
      if (h && !viewers[h.id]){
        const remaining = Object.entries(viewers).sort((a,b) => (a[1].joinedAt||0) - (b[1].joinedAt||0));
        if (remaining.length) hostRef.set({ id: remaining[0][0], name: remaining[0][1].name });
        else hostRef.remove();
      }
    });
  });

  // --- video actual ---
  roomRef.child("video").on("value", snap => {
    const v = snap.val();
    if (v){ currentVideoData = v; buildPlayer(v); }
  });

  // --- estado de reproducción (solo aplica a youtube / file) ---
  roomRef.child("playback").on("value", snap => {
    const p = snap.val();
    if (p){ lastPlaybackState = p; applyRemotePlayback(p); }
  });

  // --- chat ---
  roomRef.child("chat").limitToLast(100).on("child_added", snap => {
    renderChatMessage(snap.val());
  });

  // --- cola ---
  roomRef.child("queue").on("value", snap => {
    renderQueue(snap.val() || {});
  });

  // --- controles UI ---
  document.getElementById("loadVideoBtn").addEventListener("click", () => {
    if (!isHost) return; // por seguridad extra: el botón ya está deshabilitado visualmente
    const raw = document.getElementById("videoUrlInput").value.trim();
    if (!raw) return;
    const parsed = parseVideoUrl(raw);
    roomRef.child("video").set(parsed);
    roomRef.child("playback").set({ isPlaying:false, time:0, updatedAt: firebase.database.ServerValue.TIMESTAMP });
    document.getElementById("videoUrlInput").value = "";
  });

  document.getElementById("chatSendBtn").addEventListener("click", () => sendChat(roomRef));
  document.getElementById("chatInput").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(roomRef); });

  document.getElementById("queueAddBtn").addEventListener("click", () => {
    const raw = document.getElementById("queueUrlInput").value.trim();
    if (!raw) return;
    const parsed = parseVideoUrl(raw);
    roomRef.child("queue").push({ ...parsed, addedBy: myName, ts: firebase.database.ServerValue.TIMESTAMP });
    document.getElementById("queueUrlInput").value = "";
  });

  document.getElementById("copyLinkBtn").addEventListener("click", () => {
    const link = `${location.origin}${location.pathname}#room=${roomId}`;
    navigator.clipboard.writeText(link).then(() => {
      document.getElementById("copyLinkBtn").textContent = "¡Copiado!";
      setTimeout(() => document.getElementById("copyLinkBtn").textContent = "Copiar enlace", 1500);
    });
  });

  document.getElementById("leaveBtn").addEventListener("click", () => {
    myViewerRef.remove();
    location.reload();
  });

  // --- finalizar la sala (solo disponible para quien tiene el control) ---
  const endRoomBtn = document.getElementById("endRoomBtn");
  const endConfirmOverlay = document.getElementById("endConfirmOverlay");

  endRoomBtn.addEventListener("click", () => {
    if (!isHost) return; // por seguridad extra: el botón ya está oculto para los demás
    endConfirmOverlay.classList.add("active");
  });
  document.getElementById("cancelEndBtn").addEventListener("click", () => {
    endConfirmOverlay.classList.remove("active");
  });
  document.getElementById("confirmEndBtn").addEventListener("click", () => {
    if (!isHost) return;
    endConfirmOverlay.classList.remove("active");
    roomRef.child("closed").set({ by: myName, ts: firebase.database.ServerValue.TIMESTAMP });
    // se espera un momento para que el aviso llegue a todos antes de borrar los datos de la sala
    setTimeout(() => roomRef.remove(), 3000);
  });

  // --- todos (incluido el anfitrión) escuchan si la sala fue finalizada ---
  roomRef.child("closed").on("value", snap => {
    const c = snap.val();
    if (!c) return;
    document.getElementById("roomClosedMsg").textContent = `${c.by || "El anfitrión"} finalizó la sala.`;
    document.getElementById("roomClosedOverlay").classList.add("active");
    if (wakeLockRef) wakeLockRef.release().catch(()=>{});
    setTimeout(() => {
      location.hash = "";
      location.href = location.pathname;
    }, 2500);
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
    // al salir del modo ampliado, el chat siempre vuelve a estar visible
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

  window.__roomRef = roomRef; // usado por el reproductor para escribir cambios locales
}

function sendChat(roomRef){
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;
  roomRef.child("chat").push({ name: myName, text, ts: firebase.database.ServerValue.TIMESTAMP });
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

function renderQueue(queue){
  window.__lastQueueData = queue;
  const list = document.getElementById("queueList");
  list.innerHTML = "";
  const entries = Object.entries(queue);
  if (entries.length === 0){
    list.innerHTML = `<p class="hint">La cola está vacía.</p>`;
    return;
  }
  entries.forEach(([key, item]) => {
    const row = document.createElement("div");
    row.className = "queue-item";
    const controlsHtml = isHost
      ? `<button data-action="play">Proyectar</button><button data-action="remove">Quitar</button>`
      : `<span class="hint" style="margin:0;">sugerido por ${escapeHtml(item.addedBy || "alguien")}</span>`;
    row.innerHTML = `
      <span>${escapeHtml(item.raw)}</span>
      <span style="display:flex;gap:8px;flex-shrink:0;align-items:center;">${controlsHtml}</span>`;
    if (isHost){
      row.querySelector('[data-action="play"]').addEventListener("click", () => {
        window.__roomRef.child("video").set(item);
        window.__roomRef.child("playback").set({ isPlaying:false, time:0, updatedAt: firebase.database.ServerValue.TIMESTAMP });
        window.__roomRef.child(`queue/${key}`).remove();
      });
      row.querySelector('[data-action="remove"]').addEventListener("click", () => {
        window.__roomRef.child(`queue/${key}`).remove();
      });
    }
    list.appendChild(row);
  });
}

function renderViewers(){
  const list = document.getElementById("viewersList");
  list.innerHTML = "";
  Object.entries(lastViewersData).forEach(([id, v]) => {
    const row = document.createElement("div");
    row.className = "viewer-row";
    row.innerHTML = `<span class="dot"></span>${escapeHtml(v.name || "Invitado")}`;
    if (isHost && id !== clientId){
      const btn = document.createElement("button");
      btn.className = "give-control-btn";
      btn.textContent = "Dar control";
      btn.addEventListener("click", () => {
        window.__hostRef.set({ id, name: v.name || "Invitado" });
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

  // solo quien tiene el control puede cambiar lo que se está proyectando
  const loadInput = document.getElementById("videoUrlInput");
  const loadBtn = document.getElementById("loadVideoBtn");
  loadInput.disabled = !isHost;
  loadBtn.disabled = !isHost;
  loadInput.placeholder = isHost
    ? "Pega un link: YouTube, Vimeo, ok.ru, archive.org o un .mp4 directo"
    : "Solo quien tiene el control puede proyectar un video";

  document.getElementById("endRoomBtn").style.display = isHost ? "inline-block" : "none";

  renderViewers();
  if (window.__lastQueueData) renderQueue(window.__lastQueueData);
}

function escapeHtml(str){
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Reproductor: construcción según tipo de fuente
// ---------------------------------------------------------------------------
function buildPlayer(video){
  const frame = document.getElementById("playerFrame");
  const syncNote = document.getElementById("syncNote");
  const expandBtn = document.getElementById("theaterBtn");
  frame.innerHTML = "";
  frame.appendChild(expandBtn); // se conserva al reconstruir el reproductor
  currentVideoType = video.type;
  ytPlayer = null;

  if (video.type === "youtube"){
    syncNote.textContent = isHost
      ? "Sincronización: exacta — tienes el control (play, pausa y segundo se comparten con todos)."
      : "Sincronización: exacta — solo quien tiene el control puede reproducir, pausar o adelantar.";
    const div = document.createElement("div");
    div.id = "ytPlayerEl";
    frame.insertBefore(div, expandBtn);
    pendingVideoAfterYtReady = lastPlaybackState; // resincroniza al (re)crear el reproductor
    const create = () => {
      ytPlayer = new YT.Player("ytPlayerEl", {
        videoId: video.id,
        playerVars: {
          autoplay: 0, playsinline: 1,
          controls: isHost ? 1 : 0,   // solo el anfitrión ve los botones de YouTube
          disablekb: isHost ? 0 : 1,  // y solo el anfitrión puede usar el teclado para controlar
          fs: 0                       // se desactiva el fullscreen nativo: usamos nuestro botón ⤢
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
    v.controls = isHost; // sin controles visibles para quien no tiene el control
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
  if (!window.__roomRef || !isHost) return;
  let time = 0;
  if (currentVideoType === "youtube" && ytPlayer && ytPlayer.getCurrentTime) time = ytPlayer.getCurrentTime();
  if (currentVideoType === "file"){
    const v = document.getElementById("filePlayerEl");
    if (v) time = v.currentTime;
  }
  window.__roomRef.child("playback").set({
    isPlaying, time, updatedAt: firebase.database.ServerValue.TIMESTAMP
  });
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
  if (!("wakeLock" in navigator)) return; // no soportado en este navegador, se ignora
  try{
    wakeLockRef = await navigator.wakeLock.request("screen");
    wakeLockRef.addEventListener("release", () => { wakeLockRef = null; });
  } catch(e){ /* el navegador pudo negarlo (ej. pestaña no visible); no es crítico */ }
}
// si la pestaña vuelve a estar visible después de estar en segundo plano, reintenta el wake lock
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !wakeLockRef && roomId) requestWakeLock();
});

// La API de YouTube llama a esta función global cuando termina de cargar
function onYouTubeIframeAPIReady(){
  ytReady = true;
  if (window.__pendingYtCreate){ window.__pendingYtCreate(); window.__pendingYtCreate = null; }
}
