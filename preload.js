// MemoryOS 桌面版 preload — 仅向引导页暴露保存配置的桥
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("memoryos", {
  saveConfig: (cfg) => ipcRenderer.send("welcome-save-config", cfg),
});

if (typeof window !== "undefined" && window.location.protocol === "http:" && window.location.hostname === "127.0.0.1") {
  const syncTheme = () => {
    const theme = document.documentElement?.getAttribute("data-theme") === "dark" ? "dark" : "light";
    ipcRenderer.send("main-window:set-theme", theme);
  };
  const observeTheme = () => {
    const root = document.documentElement;
    if (!root) return;
    syncTheme();
    new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observeTheme, { once: true });
  else observeTheme();
}