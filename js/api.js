const API_BASE_URL = "https://api.atero.space/files";

export class FilesApiError extends Error {
  constructor(message, status = 500, code = "files_error", details = null) {
    super(message);
    this.name = "FilesApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function readPayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  try { return await response.json(); } catch { return null; }
}

function errorFromResponse(response, payload) {
  const detail = payload?.detail;
  const message = detail?.message || payload?.message ||
    (typeof detail === "string" ? detail : null) ||
    `A API retornou o erro HTTP ${response.status}.`;
  return new FilesApiError(
    message,
    response.status,
    detail?.code || payload?.code || "files_request_failed",
    payload
  );
}

async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");

  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-Atero-Request", "1");
  }
  if (options.json !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    signal: options.signal
  });

  if (response.status === 401) {
    const returnTo = encodeURIComponent(window.location.href);
    window.location.replace(`https://atero.space/auth-bridge.html?return_to=${returnTo}`);
    throw new FilesApiError("Sua sessão expirou.", 401, "session_expired");
  }

  const payload = await readPayload(response);
  if (!response.ok) throw errorFromResponse(response, payload);
  return payload;
}

export async function listItems({ parentId = null, scope = "files", search = "", sort = "name.asc" } = {}) {
  const params = new URLSearchParams({ scope, sort });
  if (parentId) params.set("parent_id", parentId);
  if (search.trim()) params.set("search", search.trim());
  return request(`/items?${params.toString()}`);
}

export async function createFolder({ name, parentId = null }) {
  return request("/folders", { method: "POST", json: { name, parent_id: parentId } });
}

export async function uploadFile(file, parentId = null, signal = undefined) {
  const form = new FormData();
  form.append("file", file, file.name);
  if (parentId) form.append("parent_id", parentId);
  return request("/upload", { method: "POST", body: form, signal });
}

export async function updateItem(itemId, changes) {
  return request(`/items/${encodeURIComponent(itemId)}`, { method: "PATCH", json: changes });
}

export async function moveToTrash(itemId) {
  return request(`/items/${encodeURIComponent(itemId)}/trash`, { method: "POST" });
}

export async function restoreItem(itemId) {
  return request(`/items/${encodeURIComponent(itemId)}/restore`, { method: "POST" });
}

export async function deleteItem(itemId) {
  return request(`/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

export async function emptyTrash() {
  return request("/trash", { method: "DELETE" });
}

export async function getUsage() {
  return request("/usage");
}

export async function downloadItem(item) {
  const response = await fetch(`${API_BASE_URL}/items/${encodeURIComponent(item.id)}/download`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/octet-stream" }
  });

  if (!response.ok) {
    const payload = await readPayload(response);
    throw errorFromResponse(response, payload);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = item.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
