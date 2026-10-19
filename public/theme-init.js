// Aplica el tema antes de pintar la página, respetando la política de scripts.
(() => {
  let preference;
  try { preference = localStorage.getItem("camiska-theme"); } catch {}
  const theme = preference === "light" || preference === "dark"
    ? preference
    : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#171819" : "#f5f4f0";
})();
