/**
 * Shared utilities for AudioForge Stream Deck property inspectors.
 *
 * sdpi-components.js handles settings persistence automatically via the
 * "setting" attribute.  For dynamic data (catalog) we fetch directly from
 * the AudioForge local HTTP API.  Connection settings (host, port, apiKey)
 * are read from the global-settings inputs already on the page.
 */

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8329;

/** Read the host field value from the page, falling back to default. */
function getHost() {
  const el = document.getElementById("host-input");
  return (el && el.value) || DEFAULT_HOST;
}

/** Read the port field value from the page, falling back to default. */
function getPort() {
  const el = document.getElementById("port-input");
  const v = el && parseInt(el.value, 10);
  return v && v > 0 ? v : DEFAULT_PORT;
}

/** Read the API key field value from the page. */
function getApiKey() {
  const el = document.getElementById("apikey-input");
  return (el && el.value) || "";
}

function apiBaseUrl() {
  return `http://${getHost()}:${getPort()}`;
}

/**
 * Fetch the AudioForge catalog (libraries + categories).
 * Returns null on failure.
 */
async function fetchCatalog() {
  try {
    const key = getApiKey();
    const url = `${apiBaseUrl()}/api/catalog${key ? "?apiKey=" + encodeURIComponent(key) : ""}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Update the connection-status indicator.
 * Expects elements with id="connection-status" and id="status-dot".
 */
async function updateConnectionStatus() {
  const el = document.getElementById("connection-status");
  const dot = document.getElementById("status-dot");
  if (!el) return;
  try {
    const key = getApiKey();
    const url = `${apiBaseUrl()}/api/state${key ? "?apiKey=" + encodeURIComponent(key) : ""}`;
    const resp = await fetch(url);
    if (resp.ok) {
      el.textContent = "Connected";
      el.style.color = "#4caf50";
      if (dot) dot.classList.add("ok");
    } else {
      el.textContent = "Error (" + resp.status + ")";
      el.style.color = "#f44336";
      if (dot) dot.classList.remove("ok");
    }
  } catch {
    el.textContent = "Offline";
    el.style.color = "#f44336";
    if (dot) dot.classList.remove("ok");
  }
}

/**
 * Poll AudioForge connection status. When a transition from disconnected
 * to connected is detected, refresh the given datasource selects so they
 * re-request data from the plugin (which now has catalog data).
 *
 * @param {string[]} datasourceSelectors  CSS selectors for sdpi-select[datasource] elements
 * @param {number}   intervalMs           polling interval (default 3000)
 */
let _wasConnected = false;

function startConnectionPolling(datasourceSelectors = [], intervalMs = 3000, onReconnect = null) {
  const poll = async () => {
    await updateConnectionStatus();
    const statusEl = document.getElementById("connection-status");
    const isConnected = statusEl && statusEl.textContent === "Connected";

    if (isConnected && !_wasConnected) {
      // Just transitioned to connected — refresh datasource selects
      for (const sel of datasourceSelectors) {
        const el = document.querySelector(sel);
        if (el && typeof el.refresh === "function") {
          el.refresh();
        }
      }
      if (typeof onReconnect === "function") onReconnect();
    }
    _wasConnected = !!isConnected;
  };

  setInterval(poll, intervalMs);
}

/**
 * Populate a <select> element with category options from the catalog.
 *
 * @param {string} selectId    - DOM id of the <select>
 * @param {string} section     - "Music" or "Ambiance"
 * @param {string} currentUuid - currently selected category UUID
 */
async function populateCategories(selectId, section, currentUuid) {
  const select = document.getElementById(selectId);
  if (!select) return;

  const catalog = await fetchCatalog();
  if (!catalog || !catalog.libraries) {
    select.innerHTML = '<option value="">Audio Forge not reachable</option>';
    return;
  }

  const lib =
    catalog.libraries.find((l) => l.uuid === catalog.activeLibraryUuid) ||
    catalog.libraries[0];
  if (!lib) {
    select.innerHTML = '<option value="">No libraries found</option>';
    return;
  }

  const cats = section === "Ambiance" ? lib.ambiance : lib.music;
  select.innerHTML = '<option value="">Select a category...</option>';
  for (const cat of cats) {
    const opt = document.createElement("option");
    opt.value = cat.uuid;
    opt.textContent = cat.name;
    if (cat.uuid === currentUuid) opt.selected = true;
    select.appendChild(opt);
  }
}

/**
 * Populate a <select> element with library options from the catalog.
 *
 * @param {string} selectId    - DOM id of the <select>
 * @param {string} currentUuid - currently selected library UUID
 */
async function populateLibraries(selectId, currentUuid) {
  const select = document.getElementById(selectId);
  if (!select) return;

  const catalog = await fetchCatalog();
  if (!catalog || !catalog.libraries) {
    select.innerHTML = '<option value="">Audio Forge not reachable</option>';
    return;
  }

  select.innerHTML = '<option value="">Select a library...</option>';
  for (const lib of catalog.libraries) {
    const opt = document.createElement("option");
    opt.value = lib.uuid;
    opt.textContent = lib.name;
    if (lib.uuid === currentUuid) opt.selected = true;
    select.appendChild(opt);
  }
}

