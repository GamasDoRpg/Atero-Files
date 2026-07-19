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

async function cancelPendingUpload(itemId) {
  if (!itemId) return;
  try {
    await request(`/uploads/${encodeURIComponent(itemId)}`, { method: "DELETE" });
  } catch (error) {
    console.warn("Não foi possível cancelar o upload pendente.", error);
  }
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
  const prepared = await request("/uploads", {
    method: "POST",
    json: {
      name: file.name,
      size_bytes: file.size,
      mime_type: file.type || "application/octet-stream",
      parent_id: parentId
    },
    signal
  });

  const itemId = prepared?.item?.id;
  const upload = prepared?.upload;
  if (!itemId || !upload?.url) {
    await cancelPendingUpload(itemId);
    throw new FilesApiError(
      "A API não retornou uma autorização de upload válida.",
      500,
      "invalid_upload_authorization"
    );
  }

  try {
    const uploadResponse = await fetch(upload.url, {
      method: upload.method || "PUT",
      mode: "cors",
      cache: "no-store",
      headers: upload.headers || { "Content-Type": file.type || "application/octet-stream" },
      body: file,
      signal
    });

    if (!uploadResponse.ok) {
      throw new FilesApiError(
        `O Cloudflare R2 recusou o upload com o status ${uploadResponse.status}.`,
        uploadResponse.status,
        "r2_upload_failed"
      );
    }

    return await request(`/uploads/${encodeURIComponent(itemId)}/complete`, {
      method: "POST",
      signal
    });
  } catch (error) {
    await cancelPendingUpload(itemId);
    throw error;
  }
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
  const download = await request(`/items/${encodeURIComponent(item.id)}/download`);
  if (!download?.url) {
    throw new FilesApiError(
      "A API não retornou um link de download válido.",
      500,
      "invalid_download_url"
    );
  }

  const anchor = document.createElement("a");
  anchor.href = download.url;
  anchor.download = download.filename || item.name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
