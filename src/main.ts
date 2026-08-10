import "./styles.css";

type Role = "admin" | "viewer";
type MediaType = "folder" | "image" | "video" | "audio" | "document" | "other";
type ViewMode = "grid" | "list";
type Section = "files" | "recent" | "photos" | "videos" | "trash";
type SortKey = "name" | "date" | "size";
type CloudItem = {
  name: string;
  path: string;
  type: "file" | "folder";
  mediaType: MediaType;
  size: number | null;
  modifiedAt: string;
  url: string | null;
  checksum: string | null;
};
type Dashboard = { usedBytes: number; freeBytes: number; totalBytes: number; count: number; byType: Record<string, number> };
type UploadCandidate = { file: File; relativePath: string };
type UploadTask = UploadCandidate & { id: string; progress: number; status: "waiting" | "uploading" | "done" | "error" };
type DialogState = { type: "folder" | "rename" | "move" | "share" | "delete" | "empty-trash"; item?: CloudItem; paths?: string[] };
type NoteDraft = { path: string | null; title: string; text: string; saving: boolean };
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
type FileSystemEntryLike = { name: string; isFile: boolean; isDirectory: boolean };
type FileSystemFileEntryLike = FileSystemEntryLike & { file: (ok: (file: File) => void, fail?: (error: DOMException) => void) => void };
type FileSystemDirectoryEntryLike = FileSystemEntryLike & { createReader: () => { readEntries: (ok: (entries: FileSystemEntryLike[]) => void, fail?: (error: DOMException) => void) => void } };

const icons: Record<string, string> = {
  cloud: '<path d="M17.5 19H8a6 6 0 1 1 1.2-11.9A7 7 0 0 1 22 11.8 4.5 4.5 0 0 1 17.5 19Z"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4-4L5 21"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  file: '<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v5h5"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5"/><path d="M5 14v5h14v-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3" cy="6" r=".5"/><circle cx="3" cy="12" r=".5"/><circle cx="3" cy="18" r=".5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 20h14"/>',
  edit: '<path d="m4 20 4-1 11-11a2.8 2.8 0 0 0-4-4L4 15Z"/><path d="m13.5 5.5 5 5"/>',
  move: '<path d="M4 7h6l2 2h8v10H4Z"/><path d="m12 12 2-2 2 2m-2-2v6"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8 11 8-5m-8 7 8 5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  logout: '<path d="M10 4H5v16h5M14 8l4 4-4 4m4-4H9"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'
};

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("No se encontró #root");
const rootElement = root;

let authenticated = false;
let loginError = "";
let user = "";
let role: Role = "viewer";
let section: Section = "files";
let currentPath = "";
let items: CloudItem[] = [];
let dashboard: Dashboard | null = null;
let viewMode: ViewMode = "grid";
let sortKey: SortKey = "name";
let query = "";
let selected = new Set<string>();
let previewPath: string | null = null;
let menuPath: string | null = null;
let dialog: DialogState | null = null;
let noteDraft: NoteDraft | null = null;
let uploadTasks: UploadTask[] = [];
let toastTimer = 0;
let installPrompt: InstallPromptEvent | null = null;
let serviceWorkerRefreshing = false;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

setupPwa();
void boot();

async function boot() {
  try {
    const response = await fetch("/api/me");
    if (!response.ok) return renderLogin();
    const me = await response.json() as { user: string; role: Role };
    authenticated = true;
    user = me.user;
    role = me.role;
    await Promise.all([loadDashboard(), loadSection()]);
  } catch {
    renderOffline();
  }
}

function renderOffline() {
  document.body.classList.remove("login-page");
  rootElement.innerHTML = `<main class="offline-shell"><img src="/icons/icon-192.png" alt=""><span>Sin conexión</span><h1>Tu nube no está disponible</h1><p>La aplicación está instalada y lista. Conéctate a internet o comprueba que la Raspberry esté encendida para acceder a tus archivos.</p><button class="primary-button" id="retry-connection" type="button">Intentar de nuevo</button><small>Por seguridad, los archivos privados no se guardan en la caché offline.</small></main>`;
  document.querySelector("#retry-connection")?.addEventListener("click", () => void boot());
}

function setupPwa() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    refreshInstallControls();
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    refreshInstallControls();
    showPwaNotice("Nube Camiska quedó instalada en este dispositivo.");
  });

  window.addEventListener("offline", () => showPwaNotice("Sin conexión. Tus archivos privados no se guardan offline."));
  window.addEventListener("online", () => showPwaNotice("Conexión restablecida."));

  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", () => void registerServiceWorker());
}

async function registerServiceWorker() {
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    if (registration.waiting) showPwaUpdate(registration);

    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showPwaUpdate(registration);
      });
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (serviceWorkerRefreshing) return;
      serviceWorkerRefreshing = true;
      window.location.reload();
    });

    await registration.update();
  } catch {
    // La aplicación web continúa funcionando aunque el navegador no admita PWA.
  }
}

function canOfferInstall() {
  return !isStandalone() && (installPrompt !== null || isIos);
}

function refreshInstallControls() {
  document.querySelectorAll<HTMLButtonElement>("#install-app").forEach((button) => {
    button.hidden = !canOfferInstall();
  });
}

async function installApp() {
  if (installPrompt) {
    const prompt = installPrompt;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") installPrompt = null;
    refreshInstallControls();
    return;
  }

  if (isIos) showPwaNotice("En Safari, abre Compartir y elige “Añadir a pantalla de inicio”.", true);
}

function showPwaNotice(message: string, persistent = false) {
  document.querySelector(".pwa-notice")?.remove();
  const notice = document.createElement("div");
  notice.className = "pwa-notice";
  const text = document.createElement("span");
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Cerrar");
  close.textContent = "×";
  close.addEventListener("click", () => notice.remove());
  notice.append(text, close);
  document.body.append(notice);
  if (!persistent) window.setTimeout(() => notice.remove(), 4500);
}

function showPwaUpdate(registration: ServiceWorkerRegistration) {
  document.querySelector(".pwa-update")?.remove();
  const notice = document.createElement("div");
  notice.className = "pwa-update";
  const text = document.createElement("span");
  text.textContent = "Hay una nueva versión disponible.";
  const update = document.createElement("button");
  update.type = "button";
  update.textContent = "Actualizar";
  update.addEventListener("click", () => registration.waiting?.postMessage({ type: "SKIP_WAITING" }));
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Cerrar");
  close.textContent = "×";
  close.addEventListener("click", () => notice.remove());
  notice.append(text, update, close);
  document.body.append(notice);
}

function renderLogin() {
  authenticated = false;
  document.body.classList.add("login-page");
  rootElement.innerHTML = `
    <main class="login-shell">
      <section class="login-art" aria-hidden="true">
        <div class="login-brand">${icon("cloud", 30)} <span>Nube <strong>Camiska</strong></span></div>
        <div class="orb orb-one"></div><div class="orb orb-two"></div>
        <div class="login-message"><span>Tu espacio privado</span><h1>Todo lo importante,<br>siempre cerca.</h1><p>Fotos, videos y archivos guardados de forma segura en tu nube personal.</p></div>
        <div class="floating-card card-photo">${icon("image", 24)}<span><b>Recuerdos</b><small>Fotos y videos</small></span></div>
        <div class="floating-card card-files">${icon("folder", 24)}<span><b>Mis archivos</b><small>Todo organizado</small></span></div>
      </section>
      <section class="login-panel">
        <form class="login-form" id="login-form">
          <div class="mobile-brand">${icon("cloud", 26)} Nube Camiska</div>
          <span class="welcome-pill">Bienvenido</span>
          <h2>Entra a tu nube</h2>
          <p>Usa el mismo usuario y contraseña que ya tienes configurados.</p>
          <label>Usuario<input id="login-user" name="username" autocomplete="username" required autofocus placeholder="Tu usuario"></label>
          <label>Contraseña<div class="password-field"><input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Tu contraseña"><button id="toggle-password" type="button" aria-label="Mostrar contraseña">${icon("eye", 18)}</button></div></label>
          ${loginError ? `<div class="login-error">${escapeHtml(loginError)}</div>` : ""}
          <button class="primary-button login-button" type="submit"><span>Entrar a mi nube</span>${icon("chevron", 18)}</button>
          <button class="pwa-install" id="install-app" type="button" ${canOfferInstall() ? "" : "hidden"}>Instalar Nube Camiska</button>
          <small class="privacy-note">${icon("cloud", 15)} Conexión privada · Tus archivos permanecen en tu servidor</small>
        </form>
      </section>
    </main>`;
  document.querySelector("#login-form")?.addEventListener("submit", event => void submitLogin(event));
  document.querySelector("#toggle-password")?.addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("#login-password");
    if (input) input.type = input.type === "password" ? "text" : "password";
  });
  document.querySelector("#install-app")?.addEventListener("click", () => void installApp());
}

async function submitLogin(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  const data = new FormData(form);
  if (button) { button.disabled = true; button.querySelector("span")!.textContent = "Entrando…"; }
  const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: data.get("username"), password: data.get("password") }) });
  if (!response.ok) {
    loginError = response.status === 429 ? "Demasiados intentos. Espera unos minutos." : "El usuario o la contraseña no son correctos.";
    return renderLogin();
  }
  const me = await response.json() as { user: string; role: Role };
  authenticated = true; user = me.user; role = me.role; loginError = "";
  document.body.classList.remove("login-page");
  await Promise.all([loadDashboard(), loadSection()]);
}

function renderApp(error = "") {
  if (!authenticated) return renderLogin();
  document.body.classList.remove("login-page");
  rootElement.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="#">${icon("cloud", 27)}<span>Nube <b>Camiska</b></span></a>
        ${role === "admin" ? `<button class="primary-button upload-main" id="pick-files">${icon("plus", 19)} Subir archivos</button><button class="folder-upload" id="pick-folder">${icon("folder", 16)} Subir una carpeta</button><input class="hidden-input" id="file-input" type="file" multiple><input class="hidden-input" id="folder-input" type="file" webkitdirectory multiple>` : ""}
        <nav class="side-nav" aria-label="Secciones">
          ${navItem("files", "home", "Mis archivos")}${navItem("recent", "clock", "Recientes")}${navItem("photos", "image", "Fotos")}${navItem("videos", "video", "Videos")}<button class="nav-item ${section === "files" && currentPath === "Notas" ? "active" : ""}" id="open-notes">${icon("edit", 20)}<span>Notas</span></button>${role === "admin" ? `<span class="nav-separator"></span>${navItem("trash", "trash", "Papelera")}` : ""}
        </nav>
        <div class="sidebar-bottom">
          ${storageView()}
          <button class="profile" id="logout"><span class="avatar">${escapeHtml(user.slice(0, 1).toUpperCase())}</span><span><b>${escapeHtml(user)}</b><small>${role === "admin" ? "Administrador" : "Solo lectura"}</small></span>${icon("logout", 17)}</button>
        </div>
      </aside>
      <div class="main-area">
        <header class="topbar">
          <button class="mobile-menu" id="mobile-menu" aria-label="Abrir menú">${icon("list", 21)}</button>
          <label class="global-search">${icon("search", 19)}<input id="search" value="${escapeAttribute(query)}" placeholder="Buscar en esta vista…"></label>
          <div class="top-actions"><button class="soft-button install-action" id="install-app" type="button" ${canOfferInstall() ? "" : "hidden"}>${icon("download", 17)}<span>Instalar</span></button>${role === "admin" ? `<button class="soft-button" id="new-note">${icon("edit", 17)}<span>Nueva nota</span></button><button class="soft-button" id="new-folder" ${section !== "files" ? "disabled" : ""}>${icon("folder", 17)}<span>Nueva carpeta</span></button>` : ""}<button class="avatar top-avatar" title="${escapeAttribute(user)}">${escapeHtml(user.slice(0, 1).toUpperCase())}</button></div>
        </header>
        <main class="content">
          <div class="content-header">
            <div>${breadcrumbs()}<h1>${sectionTitle()}</h1><p>${sectionSubtitle()}</p></div>
            <div class="view-actions">${section === "trash" && role === "admin" && items.length ? `<button class="soft-button empty-trash" id="empty-trash">${icon("trash", 16)} Vaciar papelera</button>` : `<label class="sort-control">Ordenar por <select id="sort"><option value="name" ${sortKey === "name" ? "selected" : ""}>Nombre</option><option value="date" ${sortKey === "date" ? "selected" : ""}>Fecha</option><option value="size" ${sortKey === "size" ? "selected" : ""}>Tamaño</option></select></label><div class="segmented"><button data-view="grid" class="${viewMode === "grid" ? "active" : ""}" aria-label="Cuadrícula">${icon("grid", 18)}</button><button data-view="list" class="${viewMode === "list" ? "active" : ""}" aria-label="Lista">${icon("list", 18)}</button></div>`}</div>
          </div>
          ${error ? `<div class="error-banner">${escapeHtml(error)}</div>` : ""}
          ${selected.size ? selectionBarMarkup() : ""}<div id="content-items">${itemsMarkup()}</div>
        </main>
      </div>
      ${role === "admin" ? `<div class="drop-overlay" id="drop-overlay">${icon("upload", 38)}<strong>Suelta tus archivos aquí</strong><span>Se guardarán en ${escapeHtml(currentPath || "Mis archivos")}</span></div>` : ""}
      <div id="upload-queue">${uploadQueueMarkup()}</div>
      ${previewPath ? previewMarkup() : ""}${dialog ? dialogMarkup() : ""}${noteDraft ? noteEditorMarkup() : ""}
      <div class="toast" id="toast" role="status"></div>
    </div>`;
  bindAppEvents();
}

function navItem(target: Section, iconName: string, label: string) {
  return `<button class="nav-item ${section === target ? "active" : ""}" data-section="${target}">${icon(iconName, 20)}<span>${label}</span>${target === "photos" && dashboard ? `<small>${dashboard.byType.images ?? 0}</small>` : target === "videos" && dashboard ? `<small>${dashboard.byType.videos ?? 0}</small>` : ""}</button>`;
}

function storageView() {
  if (!dashboard) return "";
  const total = dashboard.totalBytes || dashboard.usedBytes + dashboard.freeBytes;
  const diskUsed = Math.max(0, total - dashboard.freeBytes);
  const percent = total ? Math.min(100, Math.round((diskUsed / total) * 100)) : 0;
  return `<div class="storage"><div>${icon("cloud", 18)}<b>Almacenamiento</b><span>${percent}%</span></div><div class="storage-track"><i style="width:${percent}%"></i></div><small>${formatBytes(dashboard.usedBytes)} en la nube · ${formatBytes(dashboard.freeBytes)} libres</small></div>`;
}

function selectionBarMarkup() {
  return `<div class="selection-bar"><b>${selected.size} seleccionado${selected.size === 1 ? "" : "s"}</b><button class="soft-button" id="selected-move">${icon("move", 16)} Mover</button><button class="soft-button selection-delete" id="selected-delete">${icon("trash", 16)} Papelera</button><button class="round-button" id="selected-clear" aria-label="Cancelar selección">${icon("close", 17)}</button></div>`;
}

function breadcrumbs() {
  if (section !== "files") return `<span class="eyebrow">${section === "trash" ? "Administración" : "Biblioteca"}</span>`;
  const parts = currentPath.split("/").filter(Boolean);
  return `<div class="breadcrumbs"><button data-path="">Mi nube</button>${parts.map((part, index) => `${icon("chevron", 13)}<button data-path="${escapeAttribute(parts.slice(0, index + 1).join("/"))}">${escapeHtml(part)}</button>`).join("")}</div>`;
}

function sectionTitle() { return section === "files" ? (currentPath.split("/").pop() || "Mis archivos") : section === "recent" ? "Recientes" : section === "photos" ? "Fotos" : section === "videos" ? "Videos" : "Papelera"; }
function sectionSubtitle() {
  const count = items.length;
  if (section === "files") return `${count} elemento${count === 1 ? "" : "s"} en esta carpeta`;
  if (section === "recent") return "Lo último que has guardado en tu nube";
  if (section === "trash") return `${count} elemento${count === 1 ? "" : "s"} esperando eliminación definitiva`;
  return `${count} ${section === "photos" ? "imagen" : "video"}${count === 1 ? "" : "s"} en toda tu nube`;
}

function visibleItems() {
  const filtered = items.filter(item => item.name.toLocaleLowerCase("es").includes(query.toLocaleLowerCase("es")));
  return [...filtered].sort((a, b) => {
    if (section === "files" && a.type !== b.type) return a.type === "folder" ? -1 : 1;
    if (sortKey === "date") return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    if (sortKey === "size") return (b.size ?? 0) - (a.size ?? 0);
    return a.name.localeCompare(b.name, "es", { sensitivity: "base" });
  });
}

function itemsMarkup() {
  const list = visibleItems();
  if (section === "trash" && list.length) return `<div class="trash-list">${list.map(item => `<article><span>${icon(item.type === "folder" ? "folder" : iconFor(item), 21)}</span><div><b>${escapeHtml(item.name)}</b><small>${item.type === "folder" ? "Carpeta" : formatBytes(item.size ?? 0)} · Eliminado ${formatDate(item.modifiedAt)}</small></div></article>`).join("")}</div>`;
  if (!list.length) return `<div class="empty-state"><span>${icon(section === "photos" ? "image" : section === "videos" ? "video" : "folder", 34)}</span><h2>${query ? "No encontramos coincidencias" : "Este espacio está vacío"}</h2><p>${query ? "Prueba con otro nombre." : role === "admin" ? "Sube archivos o arrástralos aquí para comenzar." : "Todavía no hay archivos para mostrar."}</p>${role === "admin" && !query ? `<button class="primary-button" id="empty-upload">${icon("upload", 17)} Subir archivos</button>` : ""}</div>`;
  return `<div class="collection ${viewMode}">${list.map(itemCard).join("")}</div>`;
}

function itemCard(item: CloudItem) {
  const selectedClass = selected.has(item.path) ? "selected" : "";
  return `<article class="item-card ${selectedClass}" data-item="${escapeAttribute(item.path)}">
    ${role === "admin" ? `<label class="item-check"><input type="checkbox" data-select="${escapeAttribute(item.path)}" ${selected.has(item.path) ? "checked" : ""}><span>${icon("check", 13)}</span></label>` : ""}
    <button class="item-preview" data-open="${escapeAttribute(item.path)}">${thumbnail(item)}</button>
    <div class="item-info"><span class="type-icon">${icon(iconFor(item), 17)}</span><span><b title="${escapeAttribute(item.name)}">${escapeHtml(item.name)}</b><small>${item.type === "folder" ? "Carpeta" : `${formatBytes(item.size ?? 0)} · ${formatDate(item.modifiedAt)}`}</small></span></div>
    <div class="item-menu-wrap"><button class="more-button" data-menu="${escapeAttribute(item.path)}" aria-label="Acciones">${icon("more", 19)}</button>${menuPath === item.path ? actionMenu(item) : ""}</div>
  </article>`;
}

function thumbnail(item: CloudItem) {
  if (item.mediaType === "image" && item.url) return `<img src="${item.url}" alt="" loading="lazy">`;
  if (item.mediaType === "video" && item.url) return `<video src="${item.url}#t=0.2" preload="metadata" muted></video><span class="play">▶</span>`;
  return `<span class="file-visual ${item.mediaType}">${icon(iconFor(item), item.type === "folder" ? 52 : 39)}<small>${fileExtension(item.name)}</small></span>`;
}

function actionMenu(item: CloudItem) {
  return `<div class="action-menu">
    ${item.type === "folder" || isPreviewable(item) ? `<button data-open="${escapeAttribute(item.path)}">${icon("eye", 16)} ${item.type === "folder" ? "Abrir" : "Vista previa"}</button>` : ""}
    ${item.type === "file" && item.url ? `<a href="${item.url}" download>${icon("download", 16)} Descargar</a>` : ""}
    ${role === "admin" ? `<hr>${isTextNote(item) ? `<button data-action="edit-note" data-path="${escapeAttribute(item.path)}">${icon("edit", 16)} Editar nota</button>` : ""}<button data-action="rename" data-path="${escapeAttribute(item.path)}">${icon("edit", 16)} Renombrar</button><button data-action="move" data-path="${escapeAttribute(item.path)}">${icon("move", 16)} Mover</button>${item.type === "file" ? `<button data-action="share" data-path="${escapeAttribute(item.path)}">${icon("share", 16)} Compartir</button>` : ""}<hr><button class="danger" data-action="delete" data-path="${escapeAttribute(item.path)}">${icon("trash", 16)} Mover a papelera</button>` : ""}
  </div>`;
}

function previewMarkup() {
  const item = items.find(candidate => candidate.path === previewPath);
  if (!item?.url) return "";
  const media = item.mediaType === "image" ? `<img src="${item.url}" alt="${escapeAttribute(item.name)}">` : item.mediaType === "video" ? `<video src="${item.url}" controls autoplay></video>` : item.mediaType === "audio" ? `<audio src="${item.url}" controls autoplay></audio>` : `<iframe src="${item.url}" title="${escapeAttribute(item.name)}"></iframe>`;
  const previewable = visibleItems().filter(isPreviewable);
  const index = previewable.findIndex(candidate => candidate.path === item.path);
  return `<div class="viewer" role="dialog" aria-modal="true"><header><div><b>${escapeHtml(item.name)}</b><small>${formatBytes(item.size ?? 0)} · ${formatDate(item.modifiedAt)}</small></div><div><a class="soft-button" href="${item.url}" download>${icon("download", 17)} Descargar</a><button class="round-button" id="close-preview">${icon("close", 20)}</button></div></header><main><button class="viewer-arrow" id="preview-prev" ${index <= 0 ? "disabled" : ""}>‹</button><div class="viewer-media">${media}</div><button class="viewer-arrow" id="preview-next" ${index < 0 || index >= previewable.length - 1 ? "disabled" : ""}>›</button></main></div>`;
}

function noteEditorMarkup() {
  if (!noteDraft) return "";
  const editing = noteDraft.path !== null;
  return `<div class="modal-backdrop note-backdrop" role="dialog" aria-modal="true" aria-label="${editing ? "Editar nota" : "Nueva nota"}">
    <form class="note-editor" id="note-form">
      <header><div><span class="modal-kicker">Notas</span><h2>${editing ? "Editar nota" : "Nueva nota"}</h2><small>${editing ? escapeHtml(noteDraft.path ?? "") : "Se guardará en la carpeta Notas"}</small></div><button class="round-button" id="close-note" type="button" aria-label="Cerrar">${icon("close", 19)}</button></header>
      <label>Título<input id="note-title" value="${escapeAttribute(noteDraft.title)}" ${editing ? "disabled" : ""} required placeholder="Nombre de la nota"></label>
      <label class="note-content">Contenido<textarea id="note-text" required placeholder="Escribe aquí…">${escapeHtml(noteDraft.text)}</textarea></label>
      <footer><button class="soft-button" id="cancel-note" type="button">Cancelar</button><button class="primary-button" type="submit" ${noteDraft.saving ? "disabled" : ""}>${noteDraft.saving ? "Guardando…" : editing ? "Actualizar nota" : "Guardar nota"}</button></footer>
    </form>
  </div>`;
}

function dialogMarkup() {
  if (!dialog) return "";
  const item = dialog.item;
  const titles = { folder: "Nueva carpeta", rename: "Cambiar nombre", move: selected.size > 1 ? `Mover ${selected.size} elementos` : "Mover elemento", share: "Compartir archivo", delete: selected.size > 1 ? `Eliminar ${selected.size} elementos` : "Mover a papelera", "empty-trash": "Vaciar papelera" };
  if (dialog.type === "delete" || dialog.type === "empty-trash") return `<div class="modal-backdrop"><form class="modal danger-modal" id="dialog-form"><span class="modal-icon">${icon("trash", 24)}</span><h2>${titles[dialog.type]}</h2><p>${dialog.type === "empty-trash" ? "Esta acción eliminará definitivamente todo lo que está en la papelera y no se puede deshacer." : "Podrás vaciar la papelera posteriormente. Las carpetas conservarán todo su contenido."}</p><div class="modal-actions"><button class="soft-button" type="button" data-close>Cancelar</button><button class="danger-button" type="submit">${dialog.type === "empty-trash" ? "Eliminar definitivamente" : "Mover a papelera"}</button></div></form></div>`;
  const label = dialog.type === "folder" ? "Nombre de la carpeta" : dialog.type === "rename" ? "Nuevo nombre" : dialog.type === "move" ? "Carpeta de destino" : "Validez del enlace";
  const value = dialog.type === "rename" ? item?.name ?? "" : dialog.type === "move" ? currentPath : dialog.type === "share" ? "24" : "";
  const hint = dialog.type === "move" ? "Déjalo vacío para mover a Mis archivos." : dialog.type === "share" ? "Número de horas, entre 1 y 168." : "";
  return `<div class="modal-backdrop"><form class="modal" id="dialog-form"><span class="modal-kicker">Nube Camiska</span><h2>${titles[dialog.type]}</h2><label>${label}<input id="dialog-value" value="${escapeAttribute(value)}" ${dialog.type === "share" ? 'type="number" min="1" max="168"' : ""} required></label>${hint ? `<p>${hint}</p>` : ""}<div class="modal-actions"><button class="soft-button" type="button" data-close>Cancelar</button><button class="primary-button" type="submit">${dialog.type === "share" ? "Crear enlace" : dialog.type === "move" ? "Mover" : "Guardar"}</button></div></form></div>`;
}

function uploadQueueMarkup() {
  if (!uploadTasks.length) return "";
  const pending = uploadTasks.filter(task => task.status === "waiting" || task.status === "uploading").length;
  const done = uploadTasks.filter(task => task.status === "done").length;
  return `<section class="upload-queue"><header><div><b>${pending ? `Subiendo ${pending} archivo${pending === 1 ? "" : "s"}` : `${done} archivo${done === 1 ? "" : "s"} subido${done === 1 ? "" : "s"}`}</b><small>${pending ? "Puedes seguir usando tu nube" : uploadTasks.some(task => task.status === "error") ? "Algunos archivos no se pudieron subir" : "Todo está listo"}</small></div><button id="close-queue" ${pending ? "disabled" : ""}>${icon("close", 18)}</button></header><div class="queue-list">${uploadTasks.map(task => `<div class="queue-item"><span>${task.status === "done" ? icon("check", 15) : icon(iconForFile(task.file), 15)}</span><div><b>${escapeHtml(task.file.name)}</b><i><em style="width:${task.progress}%"></em></i></div><small>${task.status === "error" ? "Error" : task.status === "done" ? "Listo" : `${task.progress}%`}</small></div>`).join("")}</div></section>`;
}

function bindAppEvents() {
  document.querySelectorAll<HTMLElement>("[data-section]").forEach(button => button.addEventListener("click", () => { section = button.dataset.section as Section; currentPath = ""; query = ""; selected.clear(); void loadSection(); }));
  document.querySelector("#logout")?.addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); authenticated = false; renderLogin(); });
  document.querySelector("#mobile-menu")?.addEventListener("click", () => document.querySelector(".sidebar")?.classList.toggle("open"));
  document.querySelector("#install-app")?.addEventListener("click", () => void installApp());
  document.querySelector("#pick-files")?.addEventListener("click", () => document.querySelector<HTMLInputElement>("#file-input")?.click());
  document.querySelector("#pick-folder")?.addEventListener("click", () => document.querySelector<HTMLInputElement>("#folder-input")?.click());
  document.querySelector("#empty-upload")?.addEventListener("click", () => document.querySelector<HTMLInputElement>("#file-input")?.click());
  document.querySelector("#open-notes")?.addEventListener("click", () => { section = "files"; currentPath = "Notas"; query = ""; void loadSection(); });
  document.querySelector("#new-note")?.addEventListener("click", () => { noteDraft = { path: null, title: `nota-${new Date().toISOString().slice(0, 10)}`, text: "", saving: false }; renderApp(); });
  document.querySelector("#new-folder")?.addEventListener("click", () => { dialog = { type: "folder" }; renderApp(); });
  document.querySelector("#empty-trash")?.addEventListener("click", () => { dialog = { type: "empty-trash" }; renderApp(); });
  document.querySelectorAll<HTMLInputElement>("#file-input,#folder-input").forEach(input => input.addEventListener("change", () => { const candidates = Array.from(input.files ?? []).map(file => ({ file, relativePath: file.webkitRelativePath || file.name })); input.value = ""; void enqueueUploads(candidates); }));
  document.querySelector<HTMLInputElement>("#search")?.addEventListener("input", event => { query = (event.currentTarget as HTMLInputElement).value; updateItems(); });
  document.querySelector<HTMLSelectElement>("#sort")?.addEventListener("change", event => { sortKey = (event.currentTarget as HTMLSelectElement).value as SortKey; updateItems(); });
  document.querySelectorAll<HTMLElement>("[data-view]").forEach(button => button.addEventListener("click", () => { viewMode = button.dataset.view as ViewMode; renderApp(); }));
  document.querySelector("#selected-move")?.addEventListener("click", () => { dialog = { type: "move", paths: [...selected] }; renderApp(); });
  document.querySelector("#selected-delete")?.addEventListener("click", () => { dialog = { type: "delete", paths: [...selected] }; renderApp(); });
  document.querySelector("#selected-clear")?.addEventListener("click", () => { selected.clear(); renderApp(); });
  bindCollectionEvents();
  bindOverlayEvents();
  bindDropEvents();
  document.querySelector("#note-form")?.addEventListener("submit", event => void submitNote(event));
  document.querySelectorAll("#close-note,#cancel-note").forEach(button => button.addEventListener("click", () => { noteDraft = null; renderApp(); }));
  document.querySelector("#close-queue")?.addEventListener("click", () => { uploadTasks = []; renderApp(); });
}

function bindCollectionEvents() {
  document.querySelectorAll<HTMLElement>("[data-open]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); openItem(button.dataset.open ?? ""); }));
  document.querySelectorAll<HTMLInputElement>("[data-select]").forEach(input => input.addEventListener("change", () => { const path = input.dataset.select!; input.checked ? selected.add(path) : selected.delete(path); menuPath = null; renderApp(); }));
  document.querySelectorAll<HTMLElement>("[data-menu]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); menuPath = menuPath === button.dataset.menu ? null : button.dataset.menu ?? null; renderApp(); }));
  document.querySelectorAll<HTMLElement>("[data-action]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    const item = items.find(candidate => candidate.path === button.dataset.path);
    if (!item) return;
    menuPath = null;
    if (button.dataset.action === "edit-note") { void openNoteEditor(item); return; }
    dialog = { type: button.dataset.action as DialogState["type"], item };
    renderApp();
  }));
  document.querySelectorAll<HTMLElement>("[data-path]").forEach(button => button.addEventListener("click", () => { currentPath = button.dataset.path ?? ""; void loadSection(); }));
}

function bindOverlayEvents() {
  document.querySelector("#close-preview")?.addEventListener("click", () => { previewPath = null; renderApp(); });
  document.querySelector("#preview-prev")?.addEventListener("click", () => movePreview(-1));
  document.querySelector("#preview-next")?.addEventListener("click", () => movePreview(1));
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => { dialog = null; renderApp(); }));
  document.querySelector("#dialog-form")?.addEventListener("submit", event => void submitDialog(event));
}

let dragDepth = 0;
function bindDropEvents() {
  if (role !== "admin") { document.ondragenter = null; document.ondragover = null; return; }
  const overlay = document.querySelector("#drop-overlay");
  document.ondragenter = event => { event.preventDefault(); dragDepth += 1; overlay?.classList.add("visible"); };
  document.ondragover = event => event.preventDefault();
  if (overlay instanceof HTMLElement) {
    overlay.ondragleave = () => { dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; overlay.classList.remove("visible"); } };
    overlay.ondrop = event => { event.preventDefault(); dragDepth = 0; overlay.classList.remove("visible"); void handleDrop(event.dataTransfer); };
  }
}

function updateItems() {
  const container = document.querySelector("#content-items");
  if (!container) return;
  container.innerHTML = itemsMarkup();
  bindCollectionEvents();
  document.querySelector("#empty-upload")?.addEventListener("click", () => document.querySelector<HTMLInputElement>("#file-input")?.click());
}

function openItem(path: string) {
  const item = items.find(candidate => candidate.path === path);
  if (!item) return;
  if (item.type === "folder") { section = "files"; currentPath = item.path; void loadSection(); return; }
  if (isPreviewable(item)) { previewPath = item.path; renderApp(); return; }
  if (item.url) window.open(item.url, "_blank", "noopener");
}

async function loadSection() {
  try {
    const url = section === "files" ? `/api/files?path=${encodeURIComponent(currentPath)}` : section === "trash" ? "/api/trash" : `/api/library?view=${section}`;
    const response = await fetch(url);
    if (response.status === 401) { authenticated = false; return renderLogin(); }
    if (!response.ok) throw new Error("No pudimos cargar esta vista.");
    const data = await response.json() as { path?: string; parent?: string | null; items: CloudItem[] };
    items = section === "trash" ? data.items.map(item => ({ ...item, name: item.name.replace(/^\d+-/, ""), path: item.name, mediaType: item.mediaType ?? "other", url: null, checksum: null })) : data.items;
    currentPath = data.path ?? currentPath; selected.clear(); menuPath = null; renderApp();
  } catch (error) { renderApp(error instanceof Error ? error.message : "Ocurrió un error inesperado."); }
}

async function loadDashboard() { const response = await fetch("/api/dashboard"); if (response.ok) dashboard = await response.json() as Dashboard; }

async function openNoteEditor(item: CloudItem) {
  try {
    const response = await fetch(`/api/notes/preview?path=${encodeURIComponent(item.path)}`);
    if (!response.ok) throw new Error("note_load_failed");
    const data = await response.json() as { content: string };
    noteDraft = { path: item.path, title: item.name.replace(/\.(txt|md)$/i, ""), text: data.content, saving: false };
    renderApp();
  } catch {
    showToast("No se pudo abrir la nota", true);
  }
}

async function submitNote(event: Event) {
  event.preventDefault();
  if (!noteDraft || noteDraft.saving) return;
  const title = document.querySelector<HTMLInputElement>("#note-title")?.value.trim() ?? "";
  const text = document.querySelector<HTMLTextAreaElement>("#note-text")?.value ?? "";
  noteDraft = { ...noteDraft, title, text, saving: true };
  renderApp();
  const response = noteDraft.path
    ? await fetch("/api/notes", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: noteDraft.path, text }) })
    : await postJson("/api/notes", { title, text });
  if (!response.ok) {
    noteDraft = { ...noteDraft, saving: false };
    renderApp();
    showToast("No se pudo guardar la nota", true);
    return;
  }
  noteDraft = null;
  section = "files";
  currentPath = "Notas";
  showToast("Nota guardada");
  await Promise.all([loadDashboard(), loadSection()]);
}

async function submitDialog(event: Event) {
  event.preventDefault();
  if (!dialog) return;
  const value = document.querySelector<HTMLInputElement>("#dialog-value")?.value.trim() ?? "";
  const paths = dialog.paths ?? (dialog.item ? [dialog.item.path] : [...selected]);
  let response: Response | null = null;
  if (dialog.type === "folder") response = await postJson("/api/folders", { path: currentPath, name: value });
  if (dialog.type === "rename" && dialog.item) response = await postJson("/api/rename", { path: dialog.item.path, name: value });
  if (dialog.type === "move") { for (const path of paths) { response = await postJson("/api/move", { path, destination: value }); if (!response.ok) break; } }
  if (dialog.type === "share" && dialog.item) { response = await postJson("/api/share", { path: dialog.item.path, hours: Number(value) }); if (response.ok) { const data = await response.json() as { url: string }; const url = new URL(data.url, location.origin).toString(); await navigator.clipboard?.writeText(url); showToast("Enlace copiado al portapapeles"); } }
  if (dialog.type === "delete") { for (const path of paths) { response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { method: "DELETE" }); if (!response.ok) break; } }
  if (dialog.type === "empty-trash") response = await fetch("/api/trash", { method: "DELETE" });
  if (response && !response.ok) { showToast("No se pudo completar la acción", true); return; }
  dialog = null; selected.clear(); await Promise.all([loadDashboard(), loadSection()]);
}

async function enqueueUploads(candidates: UploadCandidate[]) {
  if (!candidates.length || role !== "admin") return;
  const newTasks = candidates.map((candidate, index) => ({ ...candidate, id: `${Date.now()}-${index}`, progress: 0, status: "waiting" as const }));
  uploadTasks.push(...newTasks); renderApp();
  const workers = Array.from({ length: Math.min(2, newTasks.length) }, () => uploadWorker(newTasks));
  await Promise.all(workers);
  await Promise.all([loadDashboard(), loadSection()]);
}

async function uploadWorker(tasks: UploadTask[]) {
  while (true) {
    const task = tasks.find(candidate => candidate.status === "waiting");
    if (!task) return;
    task.status = "uploading"; refreshQueue();
    try { await uploadOne(task); task.status = "done"; task.progress = 100; }
    catch { task.status = "error"; }
    refreshQueue();
  }
}

function uploadOne(task: UploadTask) {
  return new Promise<void>((resolve, reject) => {
    const form = new FormData(); form.append("files", task.file, task.relativePath);
    const xhr = new XMLHttpRequest(); xhr.open("POST", `/api/upload?path=${encodeURIComponent(section === "files" ? currentPath : "")}`);
    xhr.upload.onprogress = event => { if (event.lengthComputable) { task.progress = Math.round(event.loaded / event.total * 100); refreshQueue(); } };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText));
    xhr.onerror = () => reject(new Error("network_error")); xhr.send(form);
  });
}

function refreshQueue() { const container = document.querySelector("#upload-queue"); if (container) { container.innerHTML = uploadQueueMarkup(); document.querySelector("#close-queue")?.addEventListener("click", () => { uploadTasks = []; renderApp(); }); } }

async function handleDrop(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return;
  const entries = Array.from(dataTransfer.items ?? []).map(item => {
    const entryItem = item as unknown as { webkitGetAsEntry?: () => FileSystemEntryLike | null };
    return entryItem.webkitGetAsEntry?.() ?? null;
  }).filter((entry): entry is FileSystemEntryLike => entry !== null);
  if (!entries.length) return enqueueUploads(Array.from(dataTransfer.files).map(file => ({ file, relativePath: file.name })));
  const candidates = (await Promise.all(entries.map(entry => readDroppedEntry(entry, "")))).flat();
  await enqueueUploads(candidates);
}

async function readDroppedEntry(entry: FileSystemEntryLike, parent: string): Promise<UploadCandidate[]> {
  const entryPath = [parent, entry.name].filter(Boolean).join("/");
  if (entry.isFile) { const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntryLike).file(resolve, reject)); return [{ file, relativePath: entryPath }]; }
  if (!entry.isDirectory) return [];
  const reader = (entry as FileSystemDirectoryEntryLike).createReader(); const children: FileSystemEntryLike[] = [];
  while (true) { const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject)); if (!batch.length) break; children.push(...batch); }
  return (await Promise.all(children.map(child => readDroppedEntry(child, entryPath)))).flat();
}

function movePreview(direction: -1 | 1) { const list = visibleItems().filter(isPreviewable); const index = list.findIndex(item => item.path === previewPath); const next = list[index + direction]; if (next) { previewPath = next.path; renderApp(); } }
function postJson(url: string, body: unknown) { return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
function showToast(message: string, error = false) { const toast = document.querySelector("#toast"); if (!toast) return; toast.textContent = message; toast.className = `toast visible ${error ? "error" : ""}`; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500); }
function isPreviewable(item: CloudItem) { return item.type === "file" && (["image", "video", "audio"].includes(item.mediaType) || item.mediaType === "document" && (item.name.toLowerCase().endsWith(".pdf") || isTextNote(item))); }
function isTextNote(item: CloudItem) { return item.type === "file" && item.mediaType === "document" && /\.(txt|md)$/i.test(item.name); }
function iconFor(item: CloudItem) { return item.type === "folder" ? "folder" : item.mediaType === "image" ? "image" : item.mediaType === "video" ? "video" : item.mediaType === "audio" ? "music" : "file"; }
function iconForFile(file: File) { return file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "music" : "file"; }
function icon(name: string, size = 20) { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.file}</svg>`; }
function fileExtension(name: string) { const value = name.includes(".") ? name.split(".").pop()!.slice(0, 5).toUpperCase() : ""; return escapeHtml(value); }
function formatBytes(bytes: number) { const units = ["B", "KB", "MB", "GB", "TB"]; let size = bytes; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(new Date(value)); }
function escapeHtml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function escapeAttribute(value: string) { return escapeHtml(value); }

document.addEventListener("keydown", event => {
  if (event.key === "Escape") { if (previewPath || dialog || menuPath) { previewPath = null; dialog = null; menuPath = null; renderApp(); } }
  if (previewPath && event.key === "ArrowLeft") movePreview(-1);
  if (previewPath && event.key === "ArrowRight") movePreview(1);
});
