type ThemePreference = "system" | "light" | "dark";

const storageKey = "camiska-theme";

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === "light" || value === "dark") return value;
  } catch {
    // La selección sigue funcionando aunque el navegador bloquee el almacenamiento.
  }
  return "system";
}

export function setupTheme() {
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = readPreference();

  function applyTheme() {
    const theme = preference === "system" ? (systemTheme.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#171819" : "#f5f4f0");
    document.querySelectorAll<HTMLSelectElement>("[data-theme-select]").forEach(select => { select.value = preference; });
  }

  applyTheme();
  systemTheme.addEventListener("change", applyTheme);
  document.addEventListener("change", event => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.hasAttribute("data-theme-select")) return;
    if (select.value !== "system" && select.value !== "light" && select.value !== "dark") return;
    preference = select.value;
    try {
      if (preference === "system") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, preference);
    } catch {
      // Conserva la preferencia en esta pestaña si no se puede guardar.
    }
    applyTheme();
  });
  window.addEventListener("storage", event => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = readPreference();
    applyTheme();
  });
}

export function themeControl() {
  const preference = document.documentElement.dataset.themePreference ?? "system";
  return `<label class="theme-control"><span>Tema</span><select data-theme-select aria-label="Tema de la aplicación"><option value="system" ${preference === "system" ? "selected" : ""}>Sistema</option><option value="light" ${preference === "light" ? "selected" : ""}>Claro</option><option value="dark" ${preference === "dark" ? "selected" : ""}>Oscuro</option></select></label>`;
}
