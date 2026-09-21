export const roomImageExtensions = /\.(avif|bmp|gif|heic|heif|ico|jfif|jpe?g|png|tiff?|webp)$/i;

type CloudItem = { name: string; path: string; type: "folder" | "file"; url: string | null };
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export function chooseRoomImages(root: HTMLElement, fromDevice: () => void, fromCloud: (paths: string[]) => void) {
  const dialog = document.createElement("dialog");
  dialog.className = "room-image-dialog";
  dialog.setAttribute("aria-labelledby", "room-image-title");
  dialog.innerHTML = `<header class="room-image-heading"><h2 id="room-image-title">Añadir imágenes</h2><button type="button" class="soft-button" data-close>Cerrar</button></header>
    <div class="room-image-body"><p>¿De dónde quieres elegirlas?</p><div class="room-image-sources"><button type="button" class="soft-button" data-device>Del dispositivo</button><button type="button" class="primary-button" data-cloud>De mi nube</button></div></div>`;
  const selected = new Set<string>();
  let request: AbortController | null = null;
  let closed = false;
  let currentPath = "";
  let items: CloudItem[] = [];

  function close() {
    if (closed) return;
    closed = true;
    request?.abort();
    dialog.close();
    dialog.remove();
  }

  function updateSelection() {
    const count = dialog.querySelector("[data-count]");
    if (count) count.textContent = `${selected.size} de 20 seleccionadas`;
    const submit = dialog.querySelector<HTMLButtonElement>("[data-share]");
    if (submit) submit.disabled = !selected.size;
    dialog.querySelectorAll<HTMLInputElement>("[data-image]").forEach(input => {
      const item = items[Number(input.dataset.image)];
      input.checked = selected.has(item.path);
      input.disabled = selected.size >= 20 && !input.checked;
    });
  }

  async function browse(folder: string) {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    currentPath = folder;
    const body = dialog.querySelector<HTMLElement>(".room-image-body")!;
    body.innerHTML = `<p>Selecciona las imágenes que quieres compartir. Los originales permanecen en tu nube.</p>
      <nav class="room-cloud-navigation" aria-label="Carpeta de imágenes"><button type="button" class="soft-button" data-root>Mi nube</button>${folder ? '<button type="button" class="soft-button" data-parent>Subir carpeta</button>' : ""}<span>${escape(folder || "Todas mis carpetas")}</span></nav>
      <p class="room-cloud-status" role="status">Cargando imágenes…</p><div class="room-cloud-grid" aria-label="Imágenes y carpetas"></div>`;
    try {
      const response = await fetch(`/api/files?path=${encodeURIComponent(folder)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? "Tu sesión venció. Vuelve a iniciar sesión en tu nube." : "No pudimos abrir esta carpeta. Intenta de nuevo desde Mi nube.");
      const result = await response.json() as { items: CloudItem[] };
      if (closed || controller.signal.aborted) return;
      items = result.items.filter(item => item.type === "folder" || roomImageExtensions.test(item.name));
      body.querySelector(".room-cloud-status")!.textContent = items.length ? "" : "No hay imágenes en esta carpeta.";
      body.querySelector(".room-cloud-grid")!.innerHTML = items.map((item, index) => item.type === "folder"
        ? `<button type="button" class="room-cloud-folder" data-folder="${index}"><span aria-hidden="true">📁</span><span>${escape(item.name)}</span><small>Abrir carpeta</small></button>`
        : `<label class="room-cloud-image"><input type="checkbox" data-image="${index}" aria-label="${escape(item.name)}"><img src="${escape(item.url ?? "")}" alt="" loading="lazy"><span>${escape(item.name)}</span></label>`).join("");
      updateSelection();
    } catch (error) {
      if (closed || controller.signal.aborted) return;
      const status = body.querySelector(".room-cloud-status")!;
      status.textContent = error instanceof Error ? error.message : "No pudimos cargar tus imágenes.";
      status.setAttribute("role", "alert");
    }
  }

  dialog.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!button) return;
    if (button.hasAttribute("data-close")) close();
    else if (button.hasAttribute("data-device")) { close(); fromDevice(); }
    else if (button.hasAttribute("data-cloud")) {
      dialog.querySelector("h2")!.textContent = "Imágenes de mi nube";
      dialog.insertAdjacentHTML("beforeend", '<footer class="room-image-footer"><span data-count role="status">0 de 20 seleccionadas</span><button type="button" class="primary-button" data-share disabled>Compartir en la sala</button></footer>');
      void browse("");
    } else if (button.hasAttribute("data-root")) void browse("");
    else if (button.hasAttribute("data-parent")) void browse(currentPath.split("/").slice(0, -1).join("/"));
    else if (button.hasAttribute("data-folder")) void browse(items[Number(button.dataset.folder)].path);
    else if (button.hasAttribute("data-share") && selected.size) { close(); fromCloud([...selected]); }
  });
  dialog.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    if (!input.matches("[data-image]")) return;
    const item = items[Number(input.dataset.image)];
    if (input.checked && selected.size < 20) selected.add(item.path);
    else selected.delete(item.path);
    updateSelection();
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  root.append(dialog);
  dialog.showModal();
  return close;
}
