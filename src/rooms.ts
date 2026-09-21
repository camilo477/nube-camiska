import QRCode from "qrcode";
import { chooseRoomImages, roomImageExtensions } from "./room-image-picker";

type RoomFile = { name: string; size: number; modifiedAt: string; mediaType: string; url: string; text?: string };
export type Room = { token: string; name: string; createdAt: string; expiresAt: string | null; serverTime: number; participantCount: number; canSave: boolean; uploadsEnabled: boolean; files: RoomFile[]; totalBytes: number; maxBytes: number };

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function browserId() {
  try {
    const existing = localStorage.getItem("camiska-room-device");
    if (existing && /^[a-f0-9-]{32,36}$/.test(existing)) return existing;
    const id = randomId();
    localStorage.setItem("camiska-room-device", id);
    return id;
  } catch { return randomId(); }
}

export async function openQuickRoom(root: HTMLElement, token: string) {
  const participantId = browserId();
  const connectionId = randomId();
  const endpoint = `/api/rooms/public/${token}`;
  const roomUrl = `${location.origin}/room/${token}`;
  let room: Room | null = null;
  let stopped = false;
  let busy = false;
  let poll = 0;
  let countdown = 0;
  let itemsSignature = "";
  let mounted = false;
  let serverOffset = 0;
  let polling = false;
  let suspended = false;
  let presenceRequest: AbortController | null = null;
  let presenceSequence = 0;
  let noticeTimer = 0;
  let closeImagePicker: (() => void) | undefined;

  document.body.classList.remove("login-page", "drawer-open");
  root.innerHTML = '<main class="public-room-shell public-room-error"><h1>Abriendo sala…</h1><p>Conectando con el otro dispositivo.</p></main>';

  function notice(message: string, error = false) {
    const element = root.querySelector<HTMLElement>("#room-notice");
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("error", error);
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => { element.textContent = ""; }, 6000);
  }

  function leave() {
    if (stopped) return;
    suspended = true;
    window.clearTimeout(poll);
    presenceRequest?.abort();
    void fetch(`${endpoint}/presence`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participantId, connectionId, present: false, sequence: ++presenceSequence }), keepalive: true
    }).catch(() => undefined);
  }

  function close(message: string) {
    stopped = true;
    closeImagePicker?.();
    window.clearTimeout(poll);
    window.clearInterval(countdown);
    window.removeEventListener("pagehide", leave);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("online", resume);
    document.removeEventListener("visibilitychange", visible);
    root.innerHTML = `<main class="public-room-shell public-room-error"><div class="public-room-brand">Nube Camiska</div><h1>Sala cerrada</h1><p>${escape(message)}</p>${room?.canSave ? '<a class="primary-button" href="/">Volver a mi nube</a>' : '<p>Pide un nuevo enlace a quien te invitó.</p>'}</main>`;
  }

  function status() {
    if (!room) return;
    if (!room.canSave || !room.uploadsEnabled || busy) closeImagePicker?.();
    const count = root.querySelector("#room-participants");
    const expiry = root.querySelector("#room-expiry");
    if (count) count.textContent = `${room.participantCount} dispositivo${room.participantCount === 1 ? "" : "s"} conectado${room.participantCount === 1 ? "" : "s"}`;
    if (expiry) {
      const remaining = room.expiresAt ? Math.max(0, Math.ceil((Date.parse(room.expiresAt) - Date.now() - serverOffset) / 1000)) : 0;
      expiry.textContent = room.expiresAt ? `Se cierra en ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} si no hay dos dispositivos` : "La sala sigue abierta mientras haya dos dispositivos conectados";
    }
    root.querySelector("#room-back")?.toggleAttribute("hidden", !room.canSave);
    root.querySelectorAll<HTMLButtonElement>("[data-compose]").forEach(button => { button.disabled = busy || !room?.uploadsEnabled; });
    const upload = root.querySelector("#room-upload-state");
    if (upload) upload.textContent = !room.uploadsEnabled ? "El creador pausó los envíos." : busy ? "Compartiendo…" : "También puedes pegar o arrastrar imágenes aquí.";
  }

  function renderItems() {
    if (!room) return;
    const signature = JSON.stringify([room.files, room.canSave]);
    if (signature === itemsSignature) return;
    itemsSignature = signature;
    const list = root.querySelector("#room-items");
    if (!list) return;
    list.innerHTML = room.files.length ? room.files.map((file, index) => `<article class="room-message" data-room-item="${index}">
      ${file.text !== undefined ? `<pre class="room-message-text">${escape(file.text)}</pre>` : file.mediaType === "image" ? `<a class="room-message-image" href="${escape(file.url)}" target="_blank" rel="noopener"><img src="${escape(file.url)}" alt="${escape(file.name)}" loading="lazy"></a>` : `<p>${escape(file.name)}</p>`}
      <div class="room-message-meta"><span>${file.text !== undefined ? "Texto compartido" : escape(file.name)}</span><time>${new Date(file.modifiedAt).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}</time></div>
      <div class="room-message-actions">${file.text !== undefined ? '<button class="soft-button" data-room-action="copy-text">Copiar texto</button>' : file.mediaType === "image" ? '<button class="soft-button" data-room-action="copy-image">Copiar imagen</button>' : ""}<a class="soft-button" href="${escape(file.url)}?download=1" download="${escape(file.name)}">Descargar${file.text !== undefined ? " .txt" : ""}</a>${room!.canSave ? '<button class="primary-button" data-room-action="save">Guardar en mi nube</button>' : ""}</div>
    </article>`).join("") : '<div class="room-files-empty"><b>Todo listo para compartir</b><span>Envía un texto o una imagen desde cualquiera de los dispositivos.</span></div>';
  }

  function mount() {
    if (!room) return;
    mounted = true;
    root.innerHTML = `<main class="public-room-shell quick-room">
      <header class="public-room-header"><span class="public-room-brand">Nube Camiska</span><a class="soft-button" id="room-back" href="/" ${room.canSave ? "" : "hidden"}>Volver a mi nube</a><button class="soft-button" id="room-leave">Salir de la sala</button></header>
      <section class="public-room-hero"><span class="eyebrow">Sala rápida</span><h1>${escape(room.name)}</h1><p>Comparte texto e imágenes entre dispositivos.</p><div class="room-presence"><strong id="room-participants"></strong><span id="room-expiry"></span></div></section>
      <details class="room-invitation" ${room.canSave ? "open" : ""}><summary>Invitar por enlace o QR</summary><div class="room-share-panel"><div class="room-qr"><canvas id="room-qr" aria-label="Código QR para entrar a la sala"></canvas></div><div><h2>Abre esta sala en el otro dispositivo</h2><p>Quien tenga el enlace solo podrá ver lo compartido aquí.</p><div class="room-url"><input aria-label="Enlace de la sala" value="${escape(roomUrl)}" readonly><button class="soft-button" id="room-copy-link">Copiar enlace</button></div></div></div></details>
      <section class="room-composer"><form id="room-text-form"><label for="room-text">Compartir texto</label><textarea id="room-text" name="text" rows="4" maxlength="65536" placeholder="Escribe o pega aquí…"></textarea><div class="room-compose-actions"><button class="primary-button" type="submit" data-compose>Compartir texto</button><button class="soft-button" id="room-pick-images" type="button" data-compose>Añadir imágenes</button><input class="hidden-input" id="room-images" type="file" accept="image/*" multiple></div></form><p id="room-upload-state"></p><p id="room-notice" class="room-notice" role="status" aria-live="polite"></p></section>
      <section class="room-conversation"><div class="room-conversation-heading"><h2>Contenido compartido</h2><button class="soft-button" id="room-refresh">Actualizar</button></div><div id="room-items" class="room-messages"></div></section>
      <p class="room-lifetime-note">Con menos de dos dispositivos conectados durante 8 minutos, la sala se cierra y su contenido temporal se elimina. Lo que guardes en tu nube permanece allí.</p>
    </main>`;
    const canvas = root.querySelector<HTMLCanvasElement>("#room-qr");
    if (canvas) void QRCode.toCanvas(canvas, roomUrl, { width: 196, margin: 1, color: { dark: "#1e1f20", light: "#ffffff" } }).catch(() => notice("No pudimos dibujar el QR. Puedes copiar el enlace.", true));
    root.querySelector("#room-copy-link")?.addEventListener("click", () => { void copyText(roomUrl).then(() => notice("Enlace copiado")).catch(() => notice("Selecciona el enlace para copiarlo.", true)); });
    root.querySelector("#room-pick-images")?.addEventListener("click", () => {
      if (busy || stopped || !room?.uploadsEnabled) return;
      const fromDevice = () => root.querySelector<HTMLInputElement>("#room-images")?.click();
      if (!room.canSave) return fromDevice();
      closeImagePicker?.();
      closeImagePicker = chooseRoomImages(root, fromDevice, paths => { void shareCloudImages(paths); });
    });
    root.querySelector<HTMLInputElement>("#room-images")?.addEventListener("change", event => {
      const input = event.currentTarget as HTMLInputElement;
      const files = Array.from(input.files ?? []);
      input.value = "";
      void uploadImages(files);
    });
    root.querySelector("#room-text-form")?.addEventListener("submit", event => { event.preventDefault(); void sendText(); });
    root.querySelector("#room-refresh")?.addEventListener("click", () => { void refresh(); });
    root.querySelector("#room-leave")?.addEventListener("click", () => { leave(); close("Saliste de la sala. Puedes volver a entrar con el enlace mientras siga abierta."); });
    root.querySelector("#room-items")?.addEventListener("click", event => { void itemAction(event); });
    root.onpaste = event => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith("image/"));
      if (files.length) { event.preventDefault(); void uploadImages(files); }
    };
    root.ondragover = event => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); };
    root.ondrop = event => { event.preventDefault(); void uploadImages(Array.from(event.dataTransfer?.files ?? [])); };
    countdown = window.setInterval(status, 1000);
  }

  async function refresh() {
    if (stopped || suspended || polling) return;
    polling = true;
    window.clearTimeout(poll);
    try {
      presenceRequest = new AbortController();
      const timeout = window.setTimeout(() => presenceRequest?.abort(), 10000);
      let response: Response;
      try {
        response = await fetch(`${endpoint}/presence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ participantId, connectionId, sequence: ++presenceSequence }), signal: presenceRequest.signal });
      } finally { window.clearTimeout(timeout); }
      if (stopped || suspended) return;
      if (response.status === 404) return close("La sala se cerró o el enlace ya no está disponible. El contenido temporal se eliminó.");
      if (!response.ok) throw new Error("No pudimos conectar con la sala.");
      room = await response.json() as Room;
      serverOffset = room.serverTime - Date.now();
      if (!mounted) mount();
      status();
      renderItems();
    } catch {
      if (!stopped && !suspended) {
        if (mounted) notice("Sin conexión con la sala. Intentaremos reconectar.", true);
        else root.innerHTML = '<main class="public-room-shell public-room-error"><h1>Conectando con la sala…</h1><p>Comprueba tu conexión. Volveremos a intentarlo automáticamente.</p></main>';
      }
    } finally {
      polling = false;
      presenceRequest = null;
      if (!stopped && !suspended) poll = window.setTimeout(() => { void refresh(); }, 4000);
    }
  }

  async function checkResponse(response: Response) {
    if (response.ok) return;
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 404) close("La sala se cerró y su contenido temporal se eliminó.");
    if (body.error === "source_not_found") throw new Error("Una imagen ya no está en esa carpeta. Vuelve a seleccionarla desde tu nube.");
    if (body.error === "invalid_path") throw new Error("No se puede compartir esa imagen. Elige otra imagen de tu nube.");
    const messages: Record<string, string> = { room_quota_exceeded: "La sala alcanzó su límite de almacenamiento.", text_too_large: "El texto supera el límite de 64 KB.", uploads_disabled: "El creador pausó los envíos.", image_required: "Elige imágenes JPG, PNG, GIF, WebP, HEIC u otro formato de imagen compatible.", file_too_large: "La imagen supera el tamaño permitido.", too_many_files: "Puedes enviar hasta 20 imágenes a la vez." };
    throw new Error(messages[body.error ?? ""] ?? (response.status === 401 ? "Tu sesión venció. Vuelve a iniciar sesión en tu nube." : response.status === 403 ? "No tienes permiso para esta acción." : response.status === 429 ? "Demasiados envíos. Intenta más tarde." : "No pudimos completar la acción."));
  }

  async function sendText() {
    const input = root.querySelector<HTMLTextAreaElement>("#room-text");
    if (!input || !input.value.trim() || busy || !room?.uploadsEnabled) return;
    const text = input.value;
    busy = true;
    status();
    try {
      await checkResponse(await fetch(`${endpoint}/text`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }));
      if (input.value === text) input.value = "";
      notice("Texto compartido");
      await refresh();
    } catch (error) { notice(error instanceof Error ? error.message : "No pudimos compartir el texto.", true); }
    finally { busy = false; status(); }
  }

  async function uploadImages(files: File[]) {
    if (!files.length || busy || !room?.uploadsEnabled || stopped) return;
    if (files.length > 20) return notice("Puedes enviar hasta 20 imágenes a la vez.", true);
    if (files.some(file => !roomImageExtensions.test(file.name))) return notice("Solo se admiten imágenes. Para texto, usa el cuadro de arriba.", true);
    busy = true;
    status();
    const body = new FormData();
    for (const file of files) body.append("files", file, file.name);
    try {
      await checkResponse(await fetch(`${endpoint}/upload`, { method: "POST", body }));
      notice(`${files.length} ${files.length === 1 ? "imagen compartida" : "imágenes compartidas"}`);
      await refresh();
    } catch (error) { notice(error instanceof Error ? error.message : "No pudimos compartir las imágenes.", true); }
    finally { busy = false; status(); }
  }

  async function shareCloudImages(paths: string[]) {
    if (!paths.length || busy || stopped || !room?.canSave || !room.uploadsEnabled) return;
    busy = true;
    status();
    try {
      const response = await fetch(`/api/rooms/${token}/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
      await checkResponse(response);
      const result = await response.json() as { saved: RoomFile[] };
      notice(`${result.saved.length} ${result.saved.length === 1 ? "imagen compartida" : "imágenes compartidas"} desde tu nube`);
      await refresh();
    } catch (error) { notice(error instanceof Error ? error.message : "No pudimos compartir las imágenes de tu nube.", true); }
    finally { busy = false; status(); }
  }

  async function itemAction(event: Event) {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-room-action]");
    const article = button?.closest<HTMLElement>("[data-room-item]");
    const file = article && room?.files[Number(article.dataset.roomItem)];
    if (!button || !file || button.disabled) return;
    button.disabled = true;
    try {
      if (button.dataset.roomAction === "copy-text") {
        await copyText(file.text ?? "");
        notice("Texto copiado");
      } else if (button.dataset.roomAction === "copy-image") {
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Este navegador no permite copiar imágenes. Usa Descargar.");
        await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardImage(file.url) })]);
        notice("Imagen copiada");
      } else if (button.dataset.roomAction === "save") {
        const response = await fetch(`/api/rooms/${token}/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [file.name] }) });
        await checkResponse(response);
        const data = await response.json() as { saved: string[]; destination: string };
        if (!data.saved.length) throw new Error("El contenido ya no está disponible.");
        notice(`Guardado en tu nube: ${data.destination}`);
      }
    } catch (error) { notice(error instanceof Error ? error.message : "No pudimos completar la acción.", true); }
    finally { button.disabled = false; }
  }

  function resume() { suspended = false; void refresh(); }
  function visible() { if (document.visibilityState === "visible") resume(); }
  window.addEventListener("pagehide", leave);
  window.addEventListener("pageshow", resume);
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", visible);
  await refresh();
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement("textarea");
  input.value = text;
  input.className = "clipboard-fallback";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Selecciona el texto para copiarlo manualmente.");
}

async function clipboardImage(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("La imagen ya no está disponible.");
  const image = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No pudimos copiar esta imagen. Usa Descargar.");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("No pudimos copiar esta imagen. Usa Descargar.")), "image/png"));
  } finally { image.close(); }
}
