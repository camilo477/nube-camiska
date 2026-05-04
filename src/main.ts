import "./styles.css";

type Role = "admin" | "viewer";
type MediaType = "folder" | "image" | "video" | "audio" | "document" | "other";
type SortKey = "name" | "date" | "size";
type SortDirection = "asc" | "desc";
type ViewMode = "list" | "gallery";

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

type CloudResponse = {
  path: string;
  parent: string | null;
  items: CloudItem[];
};

type Dashboard = {
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
  count: number;
  byType: Record<string, number>;
  monthlyGrowth: Record<string, number>;
};

type IconName =
  | "arrow-left"
  | "cloud"
  | "copy"
  | "download"
  | "edit"
  | "file"
  | "folder"
  | "grid"
  | "image"
  | "list"
  | "move"
  | "music"
  | "plus"
  | "refresh"
  | "search"
  | "share"
  | "trash"
  | "upload"
  | "video";

const iconPaths: Record<IconName, string> = {
  "arrow-left": '<path d="m12 19-7-7 7-7" /><path d="M19 12H5" />',
  cloud: '<path d="M17.5 19H8a6 6 0 1 1 1.2-11.9A7 7 0 0 1 22 11.8 4.5 4.5 0 0 1 17.5 19Z" />',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" /><rect x="2" y="2" width="13" height="13" rx="2" />',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" />',
  edit: '<path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" />',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />',
  grid: '<rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />',
  image: '<rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />',
  list: '<path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />',
  move: '<path d="M12 2v20" /><path d="m15 5-3-3-3 3" /><path d="m15 19-3 3-3-3" /><path d="M2 12h20" /><path d="m5 9-3 3 3 3" /><path d="m19 9 3 3-3 3" />',
  music: '<path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />',
  plus: '<path d="M5 12h14" /><path d="M12 5v14" />',
  refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" />',
  search: '<circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />',
  share: '<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4" /><path d="m15.4 6.5-6.8 4" />',
  trash: '<path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" />',
  video: '<path d="m22 8-6 4 6 4V8Z" /><rect x="2" y="6" width="14" height="12" rx="2" />'
};

let currentPath = "";
let parentPath: string | null = null;
let items: CloudItem[] = [];
let role: Role = "viewer";
let query = "";
let sortKey: SortKey = "name";
let sortDirection: SortDirection = "asc";
let viewMode: ViewMode = "list";
let dashboard: Dashboard | null = null;
let isDragging = false;
let previewPath: string | null = null;

const appRoot = document.querySelector<HTMLDivElement>("#root");
if (!appRoot) throw new Error("Root element not found");
const rootElement = appRoot;

void boot();

async function boot() {
  await Promise.all([loadMe(), loadDashboard()]);
  await loadFiles();
}

async function loadMe() {
  const response = await fetch("/api/me");
  if (response.ok) {
    const data = (await response.json()) as { role: Role };
    role = data.role;
  }
}

function render(errorMessage = "") {
  const visibleItems = getVisibleItems();
  rootElement.innerHTML = `
    <main>
      <nav class="topbar" aria-label="Navegación principal">
        <a href="/" class="topbar-brand">${icon("cloud", 22)} Nube Camiska</a>
        <div class="topbar-actions">
          <span class="role-pill">${role}</span>
          <button class="icon-button" id="refresh-button" type="button" aria-label="Actualizar" title="Actualizar">${icon("refresh", 18)}</button>
        </div>
      </nav>

      <section class="hero">
        <div class="hero-content">
          <div class="eyebrow">${icon("cloud", 16)} Raspberry personal</div>
          <h1>Archivos en tu nube.</h1>
          <p>Sube, organiza, comparte y previsualiza archivos del disco conectado a la Raspberry.</p>
        </div>
      </section>

      ${dashboard ? dashboardView(dashboard) : ""}

      <section class="workspace">
        <aside class="side-panel">
          ${uploadPanel()}
          ${trashPanel()}
        </aside>

        <div class="files-panel">
          <div class="panel-header">
            <div>
              <span>Ubicación</span>
              <h2>${escapeHtml(currentPath || "Inicio")}</h2>
            </div>
            <div class="header-actions">
              ${parentPath !== null ? `<button class="secondary-action" id="back-button" type="button">${icon("arrow-left", 16)} Atrás</button>` : ""}
              ${role === "admin" ? `<button class="secondary-action" id="new-folder-button" type="button">${icon("plus", 16)} Nueva carpeta</button>` : ""}
            </div>
          </div>

          <div class="tools-row">
            <label class="search-field">
              ${icon("search", 16)}
              <input id="search-input" type="search" value="${escapeAttribute(query)}" placeholder="Buscar por nombre" />
            </label>
            <select id="sort-key" aria-label="Ordenar por">
              <option value="name" ${sortKey === "name" ? "selected" : ""}>Nombre</option>
              <option value="date" ${sortKey === "date" ? "selected" : ""}>Fecha</option>
              <option value="size" ${sortKey === "size" ? "selected" : ""}>Tamaño</option>
            </select>
            <select id="sort-direction" aria-label="Dirección">
              <option value="asc" ${sortDirection === "asc" ? "selected" : ""}>Ascendente</option>
              <option value="desc" ${sortDirection === "desc" ? "selected" : ""}>Descendente</option>
            </select>
            <button class="icon-button" id="view-mode-button" type="button" aria-label="Cambiar vista" title="Cambiar vista">
              ${icon(viewMode === "list" ? "grid" : "list", 18)}
            </button>
          </div>

          ${errorMessage ? `<p class="error-message">${errorMessage}</p>` : ""}
          <div class="${viewMode === "gallery" ? "gallery-grid" : "files-list"}" id="files-list">
            ${visibleItems.length ? visibleItems.map(viewMode === "gallery" ? galleryCard : fileRow).join("") : emptyState()}
          </div>
        </div>
      </section>
      ${previewPath ? previewModal() : ""}
    </main>
  `;

  bindEvents();
}

function dashboardView(data: Dashboard) {
  const used = formatBytes(data.usedBytes);
  const free = formatBytes(data.freeBytes);
  const latestMonths = Object.entries(data.monthlyGrowth).sort(([a], [b]) => a.localeCompare(b)).slice(-6);
  const maxMonth = Math.max(1, ...latestMonths.map(([, value]) => value));

  return `
    <section class="dashboard">
      <article><span>Usado</span><strong>${used}</strong></article>
      <article><span>Libre aprox.</span><strong>${free}</strong></article>
      <article><span>Archivos</span><strong>${data.count}</strong></article>
      <article><span>Tipos</span><strong>${data.byType.images} img · ${data.byType.videos} vid · ${data.byType.documents} doc</strong></article>
      <div class="growth">
        ${latestMonths.map(([month, value]) => `<span title="${month}: ${formatBytes(value)}" style="height:${Math.max(8, (value / maxMonth) * 64)}px"></span>`).join("")}
      </div>
    </section>
  `;
}

function uploadPanel() {
  const disabled = role !== "admin" ? "is-disabled" : "";
  return `
    <div class="upload-panel ${isDragging ? "is-dragging" : ""} ${disabled}" id="drop-zone">
      <input id="file-input" type="file" multiple ${role !== "admin" ? "disabled" : ""} />
      <input id="folder-input" type="file" webkitdirectory multiple ${role !== "admin" ? "disabled" : ""} />
      <label for="file-input">
        <span class="upload-icon">${icon("upload", 26)}</span>
        <strong>Subir archivos</strong>
        <small>Arrastra aquí, elige archivos o sube una carpeta completa desde PC.</small>
      </label>
      <div class="upload-buttons">
        <button class="secondary-action" id="pick-files-button" type="button" ${role !== "admin" ? "disabled" : ""}>Archivos</button>
        <button class="secondary-action" id="pick-folder-button" type="button" ${role !== "admin" ? "disabled" : ""}>Carpeta</button>
      </div>
      <div class="progress-wrap"><span id="progress-bar"></span></div>
      <div class="upload-status" id="upload-status">${role === "viewer" ? "Modo solo lectura." : ""}</div>
    </div>
  `;
}

function trashPanel() {
  return `
    <div class="trash-panel">
      <strong>${icon("trash", 16)} Papelera</strong>
      <small>Eliminar mueve a .trash.</small>
      ${role === "admin" ? `<button class="danger-wide" id="empty-trash-button" type="button">Vaciar papelera</button>` : ""}
    </div>
  `;
}

function fileRow(item: CloudItem) {
  const canPreview = item.type === "file" && isPreviewable(item);
  const primaryAction =
    item.type === "folder"
      ? `<button class="file-action open-folder" data-path="${escapeAttribute(item.path)}" type="button">Abrir</button>`
      : canPreview
        ? `<button class="file-action open-preview" data-path="${escapeAttribute(item.path)}" type="button">${icon(iconForItem(item), 15)} Ver</button>`
        : `<a class="file-action" href="${item.url}" target="_blank" rel="noreferrer">${icon("download", 15)} Descargar</a>`;

  return `
    <article class="file-row">
      <button class="file-main ${item.type === "folder" ? "open-folder" : canPreview ? "open-preview" : ""}" data-path="${escapeAttribute(item.path)}" type="button">
        <span class="file-icon">${icon(iconForItem(item), 22)}</span>
        <span>
          <strong>${escapeHtml(item.name)}</strong>
          <small>${item.type === "folder" ? "Carpeta" : formatBytes(item.size ?? 0)} · ${formatDate(item.modifiedAt)}${item.checksum ? ` · sha256 ${item.checksum.slice(0, 10)}` : ""}</small>
        </span>
      </button>
      <div class="file-actions">
        ${primaryAction}
        ${itemActions(item)}
      </div>
    </article>
  `;
}

function galleryCard(item: CloudItem) {
  return `
    <article class="gallery-card">
      <button class="preview ${item.type === "folder" ? "open-folder" : isPreviewable(item) ? "open-preview" : ""}" data-path="${escapeAttribute(item.path)}" type="button">
        ${previewFor(item)}
      </button>
      <div class="gallery-meta">
        <strong>${escapeHtml(item.name)}</strong>
        <small>${item.type === "folder" ? "Carpeta" : formatBytes(item.size ?? 0)}</small>
      </div>
      <div class="file-actions compact">
        ${item.type === "folder" ? `<button class="file-action open-folder" data-path="${escapeAttribute(item.path)}" type="button">Abrir</button>` : isPreviewable(item) ? `<button class="file-action open-preview" data-path="${escapeAttribute(item.path)}" type="button">Ver</button>` : `<a class="file-action" href="${item.url}" target="_blank" rel="noreferrer">Descargar</a>`}
        ${itemActions(item)}
      </div>
    </article>
  `;
}

function previewModal() {
  const item = items.find((candidate) => candidate.path === previewPath);
  if (!item || !item.url) return "";

  const previewableItems = items.filter(isPreviewable);
  const index = previewableItems.findIndex((candidate) => candidate.path === item.path);
  const hasPrevious = index > 0;
  const hasNext = index >= 0 && index < previewableItems.length - 1;

  return `
    <section class="viewer-backdrop" role="dialog" aria-modal="true" aria-label="Vista previa">
      <div class="viewer-shell">
        <header class="viewer-header">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <small>${formatBytes(item.size ?? 0)} · ${formatDate(item.modifiedAt)}</small>
          </div>
          <div class="viewer-actions">
            <a class="file-action" href="${item.url}" target="_blank" rel="noreferrer">${icon("download", 15)} Abrir</a>
            <button class="icon-button" id="close-preview-button" type="button" aria-label="Cerrar">×</button>
          </div>
        </header>
        <div class="viewer-body">
          <button class="viewer-nav" id="previous-preview-button" type="button" ${hasPrevious ? "" : "disabled"} aria-label="Anterior">‹</button>
          <div class="viewer-media">${largePreviewFor(item)}</div>
          <button class="viewer-nav" id="next-preview-button" type="button" ${hasNext ? "" : "disabled"} aria-label="Siguiente">›</button>
        </div>
      </div>
    </section>
  `;
}

function largePreviewFor(item: CloudItem) {
  if (!item.url) return "";
  if (item.mediaType === "image") return `<img src="${item.url}" alt="${escapeAttribute(item.name)}" />`;
  if (item.mediaType === "video") return `<video src="${item.url}" controls autoplay preload="metadata"></video>`;
  if (item.mediaType === "audio") return `<audio src="${item.url}" controls autoplay preload="metadata"></audio>`;
  if (item.mediaType === "document" && item.name.toLowerCase().endsWith(".pdf")) return `<iframe src="${item.url}" title="${escapeAttribute(item.name)}"></iframe>`;
  return `<div class="empty-state">${icon(iconForItem(item), 44)}<strong>Sin vista previa</strong></div>`;
}

function itemActions(item: CloudItem) {
  if (role !== "admin") return "";

  return `
    <button class="icon-action rename-action" data-path="${escapeAttribute(item.path)}" data-name="${escapeAttribute(item.name)}" type="button" aria-label="Renombrar" title="Renombrar">${icon("edit", 15)}</button>
    <button class="icon-action move-action" data-path="${escapeAttribute(item.path)}" type="button" aria-label="Mover" title="Mover">${icon("move", 15)}</button>
    ${item.type === "file" ? `<button class="icon-action share-action" data-path="${escapeAttribute(item.path)}" type="button" aria-label="Compartir" title="Compartir">${icon("share", 15)}</button>` : ""}
    <button class="danger-action delete-action" data-path="${escapeAttribute(item.path)}" data-name="${escapeAttribute(item.name)}" type="button" aria-label="Eliminar" title="Eliminar">${icon("trash", 15)}</button>
  `;
}

function previewFor(item: CloudItem) {
  if (item.type === "folder") return icon("folder", 42);
  if (item.mediaType === "image") return `<img src="${item.url}" alt="${escapeAttribute(item.name)}" loading="lazy" />`;
  if (item.mediaType === "video") return `<video src="${item.url}" controls preload="metadata"></video>`;
  if (item.mediaType === "audio") return `<div class="audio-preview">${icon("music", 42)}<audio src="${item.url}" controls preload="metadata"></audio></div>`;
  if (item.mediaType === "document" && item.name.toLowerCase().endsWith(".pdf")) return `<iframe src="${item.url}" title="${escapeAttribute(item.name)}"></iframe>`;
  return icon(iconForItem(item), 42);
}

function emptyState() {
  return `
    <div class="empty-state">
      ${icon("folder", 34)}
      <strong>No hay archivos</strong>
      <span>Sube algo o ajusta la búsqueda.</span>
    </div>
  `;
}

function bindEvents() {
  document.querySelector("#refresh-button")?.addEventListener("click", () => void refreshAll());
  document.querySelector("#back-button")?.addEventListener("click", () => {
    currentPath = parentPath ?? "";
    void loadFiles();
  });
  document.querySelector("#new-folder-button")?.addEventListener("click", () => void createFolder());
  document.querySelector("#empty-trash-button")?.addEventListener("click", () => void emptyTrash());
  document.querySelector("#pick-files-button")?.addEventListener("click", () => document.querySelector<HTMLInputElement>("#file-input")?.click());
  document.querySelector("#pick-folder-button")?.addEventListener("click", () => document.querySelector<HTMLInputElement>("#folder-input")?.click());
  document.querySelector("#view-mode-button")?.addEventListener("click", () => {
    viewMode = viewMode === "list" ? "gallery" : "list";
    render();
  });

  document.querySelector<HTMLInputElement>("#search-input")?.addEventListener("input", (event) => {
    query = (event.currentTarget as HTMLInputElement).value;
    render();
  });
  document.querySelector<HTMLSelectElement>("#sort-key")?.addEventListener("change", (event) => {
    sortKey = (event.currentTarget as HTMLSelectElement).value as SortKey;
    render();
  });
  document.querySelector<HTMLSelectElement>("#sort-direction")?.addEventListener("change", (event) => {
    sortDirection = (event.currentTarget as HTMLSelectElement).value as SortDirection;
    render();
  });

  document.querySelectorAll<HTMLInputElement>("#file-input, #folder-input").forEach((input) => {
    input.addEventListener("change", () => {
      void uploadFiles(Array.from(input.files ?? []));
      input.value = "";
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".open-folder").forEach((button) => {
    button.addEventListener("click", () => {
      currentPath = button.dataset.path ?? "";
      void loadFiles();
    });
  });
  document.querySelectorAll<HTMLButtonElement>(".open-preview").forEach((button) => {
    button.addEventListener("click", () => {
      previewPath = button.dataset.path ?? null;
      render();
    });
  });
  document.querySelector("#close-preview-button")?.addEventListener("click", () => {
    previewPath = null;
    render();
  });
  document.querySelector(".viewer-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      previewPath = null;
      render();
    }
  });
  document.querySelector("#previous-preview-button")?.addEventListener("click", () => movePreview(-1));
  document.querySelector("#next-preview-button")?.addEventListener("click", () => movePreview(1));
  document.addEventListener("keydown", handlePreviewKeys, { once: true });
  document.querySelectorAll<HTMLButtonElement>(".rename-action").forEach((button) => {
    button.addEventListener("click", () => void renameItem(button.dataset.path ?? "", button.dataset.name ?? ""));
  });
  document.querySelectorAll<HTMLButtonElement>(".move-action").forEach((button) => {
    button.addEventListener("click", () => void moveItem(button.dataset.path ?? ""));
  });
  document.querySelectorAll<HTMLButtonElement>(".share-action").forEach((button) => {
    button.addEventListener("click", () => void shareItem(button.dataset.path ?? ""));
  });
  document.querySelectorAll<HTMLButtonElement>(".delete-action").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.name ?? "este elemento";
      if (window.confirm(`Mover "${name}" a la papelera? Las carpetas se moverán con todo su contenido.`)) {
        void deleteItem(button.dataset.path ?? "");
      }
    });
  });

  const dropZone = document.querySelector<HTMLDivElement>("#drop-zone");
  dropZone?.addEventListener("dragover", (event) => {
    if (role !== "admin") return;
    event.preventDefault();
    isDragging = true;
    dropZone.classList.add("is-dragging");
  });
  dropZone?.addEventListener("dragleave", () => {
    isDragging = false;
    dropZone.classList.remove("is-dragging");
  });
  dropZone?.addEventListener("drop", (event) => {
    if (role !== "admin") return;
    event.preventDefault();
    isDragging = false;
    dropZone.classList.remove("is-dragging");
    void uploadFiles(Array.from(event.dataTransfer?.files ?? []));
  });
}

function handlePreviewKeys(event: KeyboardEvent) {
  if (!previewPath) return;
  if (event.key === "Escape") {
    previewPath = null;
    render();
  }
  if (event.key === "ArrowLeft") movePreview(-1);
  if (event.key === "ArrowRight") movePreview(1);
}

function movePreview(direction: -1 | 1) {
  const previewableItems = items.filter(isPreviewable);
  const index = previewableItems.findIndex((item) => item.path === previewPath);
  const next = previewableItems[index + direction];
  if (!next) return;
  previewPath = next.path;
  render();
}

async function refreshAll() {
  await Promise.all([loadDashboard(), loadFiles()]);
}

async function loadFiles() {
  try {
    const response = await fetch(`/api/files?path=${encodeURIComponent(currentPath)}`);
    if (!response.ok) throw new Error("No se pudo leer la nube.");
    const data = (await response.json()) as CloudResponse;
    currentPath = data.path;
    parentPath = data.parent;
    items = data.items;
    render();
  } catch (error) {
    render(error instanceof Error ? error.message : "Error cargando archivos.");
  }
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  if (response.ok) dashboard = (await response.json()) as Dashboard;
}

async function createFolder() {
  const name = window.prompt("Nombre de la carpeta");
  if (!name) return;
  const response = await postJson("/api/folders", { path: currentPath, name });
  if (!response.ok) return showError("No se pudo crear la carpeta.");
  await loadFiles();
}

async function renameItem(path: string, currentName: string) {
  const name = window.prompt("Nuevo nombre", currentName);
  if (!name || name === currentName) return;
  const response = await postJson("/api/rename", { path, name });
  if (!response.ok) return showError("No se pudo renombrar.");
  await loadFiles();
}

async function moveItem(path: string) {
  const destination = window.prompt("Mover a carpeta. Deja vacío para Inicio.", currentPath);
  if (destination === null) return;
  const response = await postJson("/api/move", { path, destination });
  if (!response.ok) return showError("No se pudo mover.");
  await loadFiles();
}

async function shareItem(path: string) {
  const hoursRaw = window.prompt("Horas de validez del link", "1");
  if (!hoursRaw) return;
  const response = await postJson("/api/share", { path, hours: Number(hoursRaw) });
  if (!response.ok) return showError("No se pudo crear el link.");
  const data = (await response.json()) as { url: string; expiresAt: string };
  const absoluteUrl = new URL(data.url, window.location.origin).toString();
  await navigator.clipboard?.writeText(absoluteUrl).catch(() => undefined);
  window.alert(`Link copiado:\n${absoluteUrl}\nVence: ${formatDate(data.expiresAt)}`);
}

async function uploadFiles(files: File[]) {
  if (!files.length || role !== "admin") return;

  const status = document.querySelector<HTMLDivElement>("#upload-status");
  const progress = document.querySelector<HTMLSpanElement>("#progress-bar");
  const formData = new FormData();

  files.forEach((file) => {
    const relativePath = "webkitRelativePath" in file && file.webkitRelativePath ? file.webkitRelativePath : file.name;
    formData.append("files", file, relativePath);
  });

  await uploadWithProgress(`/api/upload?path=${encodeURIComponent(currentPath)}`, formData, (percent) => {
    if (progress) progress.style.width = `${percent}%`;
    if (status) status.textContent = `Subiendo ${files.length} archivo${files.length === 1 ? "" : "s"}... ${percent}%`;
  })
    .then(async () => {
      if (status) status.textContent = "Subida lista.";
      await refreshAll();
    })
    .catch(() => {
      if (status) status.textContent = "No se pudo subir. Revisa tamaño, conexión o permisos.";
    });
}

async function deleteItem(path: string) {
  const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  if (!response.ok) return showError("No se pudo mover a papelera.");
  await refreshAll();
}

async function emptyTrash() {
  if (!window.confirm("Vaciar la papelera permanentemente?")) return;
  const response = await fetch("/api/trash", { method: "DELETE" });
  if (!response.ok) return showError("No se pudo vaciar la papelera.");
  window.alert("Papelera vacía.");
}

function uploadWithProgress(url: string, body: FormData, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText)));
    xhr.onerror = () => reject(new Error("network_error"));
    xhr.send(body);
  });
}

function getVisibleItems() {
  const filtered = items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  const modifier = sortDirection === "desc" ? -1 : 1;
  return filtered.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    if (sortKey === "size") return ((a.size ?? 0) - (b.size ?? 0)) * modifier;
    if (sortKey === "date") return (new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()) * modifier;
    return a.name.localeCompare(b.name, "es", { sensitivity: "base" }) * modifier;
  });
}

function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function showError(message: string) {
  window.alert(message);
}

function icon(name: IconName, size = 20) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${iconPaths[name]}
    </svg>
  `;
}

function iconForItem(item: CloudItem): IconName {
  if (item.type === "folder") return "folder";
  if (item.mediaType === "image") return "image";
  if (item.mediaType === "video") return "video";
  if (item.mediaType === "audio") return "music";
  return "file";
}

function isPreviewable(item: CloudItem) {
  return (
    item.type === "file" &&
    (item.mediaType === "image" ||
      item.mediaType === "video" ||
      item.mediaType === "audio" ||
      (item.mediaType === "document" && item.name.toLowerCase().endsWith(".pdf")))
  );
}

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
