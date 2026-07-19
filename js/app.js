import {
  createFolder, deleteItem, downloadItem, emptyTrash, getUsage,
  listItems, moveToTrash, restoreItem, updateItem, uploadFile
} from "./api.js?v=1";

const state = {
  user: null,
  app: null,
  scope: "files",
  currentFolderId: null,
  breadcrumbs: [],
  items: [],
  search: "",
  sort: "name.asc",
  view: localStorage.getItem("atero-files-view") || "grid",
  loading: false,
  nameMode: "folder",
  itemBeingEdited: null,
  confirmAction: null,
  activeMenuItem: null,
  dragDepth: 0
};

const elements = {};
const scopeCopy = {
  files: {
    title: "Meus arquivos",
    subtitle: "Organize seus arquivos e projetos Atero.",
    emptyTitle: "Nenhum arquivo por aqui",
    emptyMessage: "Crie uma pasta ou envie seu primeiro arquivo.",
    action: "Adicionar arquivo"
  },
  recent: {
    title: "Recentes",
    subtitle: "Os arquivos que você abriu ou alterou recentemente.",
    emptyTitle: "Nada recente ainda",
    emptyMessage: "Seus arquivos mais recentes aparecerão aqui.",
    action: null
  },
  favorites: {
    title: "Favoritos",
    subtitle: "Acesso rápido aos itens mais importantes.",
    emptyTitle: "Nenhum favorito",
    emptyMessage: "Marque arquivos e pastas com uma estrela para encontrá-los aqui.",
    action: null
  },
  trash: {
    title: "Lixeira",
    subtitle: "Restaure itens ou exclua-os permanentemente.",
    emptyTitle: "A lixeira está vazia",
    emptyMessage: "Os itens removidos aparecerão aqui.",
    action: null
  }
};

function cacheElements() {
  const ids = [
    "sidebar", "sidebar-close", "sidebar-scrim", "mobile-menu", "new-button",
    "new-popover", "file-input", "search-input", "refresh-button", "sort-select",
    "breadcrumbs", "page-title", "page-subtitle", "trash-toolbar", "empty-trash-button",
    "drop-zone", "loading-grid", "items-container", "empty-state", "empty-title",
    "empty-message", "empty-action", "context-menu", "name-dialog", "name-form",
    "name-dialog-kicker", "name-dialog-title", "name-input", "name-error", "name-submit",
    "confirm-dialog", "confirm-form", "confirm-title", "confirm-message", "confirm-submit",
    "upload-panel", "upload-panel-close", "upload-title", "upload-list", "toast-region",
    "storage-percent", "storage-bar", "storage-label", "account-avatar", "account-name",
    "account-email"
  ];
  ids.forEach((id) => { elements[id] = document.getElementById(id); });
  elements.sideNavItems = [...document.querySelectorAll(".side-nav-item")];
  elements.viewButtons = [...document.querySelectorAll("[data-view]")];
  elements.newActions = [...document.querySelectorAll("[data-new-action]")];
  elements.dialogCloseButtons = [...document.querySelectorAll("[data-close-dialog]")];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function icon(name) {
  return `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount.toFixed(amount >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Data desconhecida";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined
  }).format(date);
}

function initials(name, email) {
  const parts = String(name || email || "Atero").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "A";
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " error" : ""}`;
  toast.textContent = message;
  elements["toast-region"].append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function errorMessage(error, fallback = "Não foi possível concluir a operação.") {
  console.error(error);
  return error?.message || fallback;
}

function closeFloatingUi() {
  elements["new-popover"].hidden = true;
  elements["context-menu"].hidden = true;
  state.activeMenuItem = null;
}

function positionFloating(element, anchorRect, preferredWidth = 230) {
  const gap = 8;
  const left = Math.max(10, Math.min(anchorRect.left, window.innerWidth - preferredWidth - 10));
  const height = element.offsetHeight || 220;
  const top = anchorRect.bottom + gap + height < window.innerHeight
    ? anchorRect.bottom + gap
    : Math.max(10, anchorRect.top - height - gap);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

function openNewPopover() {
  const popover = elements["new-popover"];
  popover.hidden = false;
  requestAnimationFrame(() => positionFloating(popover, elements["new-button"].getBoundingClientRect()));
}

function setSidebar(open) {
  elements.sidebar.classList.toggle("is-open", open);
  elements["sidebar-scrim"].hidden = !open;
  document.body.style.overflow = open ? "hidden" : "";
}

function itemVisualType(item) {
  if (item.item_type === "folder") return { className: "folder", iconName: "folder", label: "Pasta" };
  const mime = String(item.mime_type || "");
  const extension = String(item.extension || "").toLowerCase();
  if (mime.startsWith("image/")) return { className: "image", iconName: "file", label: "Imagem" };
  if (mime === "application/pdf" || extension === "pdf") return { className: "pdf", iconName: "file", label: "PDF" };
  if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) return { className: "archive", iconName: "file", label: "Arquivo compactado" };
  return { className: "file", iconName: "file", label: extension ? extension.toUpperCase() : "Arquivo" };
}

function itemMeta(item) {
  if (item.item_type === "folder") return `Pasta · ${formatDate(item.updated_at)}`;
  return `${formatBytes(item.size_bytes)} · ${formatDate(item.updated_at)}`;
}

function renderBreadcrumbs() {
  const container = elements.breadcrumbs;
  container.innerHTML = "";
  if (state.scope !== "files") return;

  const root = document.createElement("button");
  root.type = "button";
  root.textContent = "Meus arquivos";
  root.addEventListener("click", () => openFolder(null, -1));
  container.append(root);

  state.breadcrumbs.forEach((crumb, index) => {
    const chevron = document.createElement("span");
    chevron.innerHTML = icon("chevron");
    container.append(chevron);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = crumb.name;
    button.title = crumb.name;
    button.addEventListener("click", () => openFolder(crumb.id, index));
    container.append(button);
  });
}

function updateHeading() {
  const copy = scopeCopy[state.scope];
  const folder = state.breadcrumbs.at(-1);
  elements["page-title"].textContent = state.scope === "files" && folder ? folder.name : copy.title;
  elements["page-subtitle"].textContent = copy.subtitle;
  elements["trash-toolbar"].hidden = state.scope !== "trash";
  renderBreadcrumbs();
}

function updateNavigation() {
  elements.sideNavItems.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.scope === state.scope);
  });
}

function setLoading(loading) {
  state.loading = loading;
  elements["loading-grid"].hidden = !loading;
  if (loading) {
    elements["items-container"].hidden = true;
    elements["empty-state"].hidden = true;
  }
}

function renderEmptyState() {
  const copy = scopeCopy[state.scope];
  elements["empty-title"].textContent = state.search ? "Nenhum resultado" : copy.emptyTitle;
  elements["empty-message"].textContent = state.search
    ? `Não encontramos itens com “${state.search}”.`
    : copy.emptyMessage;
  const action = copy.action && !state.search ? copy.action : null;
  elements["empty-action"].hidden = !action;
  elements["empty-action"].textContent = action || "";
  elements["empty-state"].hidden = false;
}

function renderItems() {
  const container = elements["items-container"];
  container.className = `items-container is-${state.view}`;
  container.innerHTML = "";

  if (!state.items.length) {
    container.hidden = true;
    renderEmptyState();
    return;
  }

  elements["empty-state"].hidden = true;
  container.hidden = false;

  for (const item of state.items) {
    const visual = itemVisualType(item);
    const article = document.createElement("article");
    article.className = "item-card";
    article.dataset.itemId = item.id;
    article.innerHTML = `
      <button class="item-card-main" type="button" aria-label="Abrir ${escapeHtml(item.name)}">
        <span class="item-card-top"><span class="item-type-icon ${visual.className}">${icon(visual.iconName)}</span></span>
        <span><h3 title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3><span class="item-meta">${escapeHtml(itemMeta(item))}</span></span>
      </button>
      <button class="item-menu-button" type="button" aria-label="Ações para ${escapeHtml(item.name)}">${icon("more")}</button>
      ${item.is_favorite && state.scope !== "trash" ? `<span class="favorite-badge" title="Favorito">${icon("star")}</span>` : ""}
    `;
    article.querySelector(".item-card-main").addEventListener("click", () => activateItem(item));
    article.querySelector(".item-menu-button").addEventListener("click", (event) => {
      event.stopPropagation();
      openContextMenu(item, event.currentTarget);
    });
    container.append(article);
  }
}

async function loadItems({ silent = false } = {}) {
  if (state.loading) return;
  if (!silent) setLoading(true);
  try {
    const result = await listItems({
      parentId: state.scope === "files" ? state.currentFolderId : null,
      scope: state.scope,
      search: state.search,
      sort: state.sort
    });
    state.items = result?.items || [];
    renderItems();
  } catch (error) {
    state.items = [];
    renderItems();
    showToast(errorMessage(error, "Não foi possível carregar seus arquivos."), "error");
  } finally {
    setLoading(false);
  }
}

async function loadUsage() {
  try {
    const usage = (await getUsage())?.usage || {};
    const used = Number(usage.used_bytes || 0);
    const limit = Number(usage.limit_bytes || 0);
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    elements["storage-percent"].textContent = limit > 0 ? `${percent}%` : "—";
    elements["storage-bar"].style.width = `${percent}%`;
    elements["storage-label"].textContent = limit > 0
      ? `${formatBytes(used)} de ${formatBytes(limit)} usados`
      : `${formatBytes(used)} usados · sem limite definido`;
  } catch (error) {
    console.warn("Uso de armazenamento indisponível.", error);
    elements["storage-percent"].textContent = "—";
    elements["storage-label"].textContent = "Uso indisponível no momento";
  }
}

async function refreshAll({ silent = false } = {}) {
  await Promise.all([loadItems({ silent }), loadUsage()]);
}

function switchScope(scope) {
  if (!scopeCopy[scope]) return;
  state.scope = scope;
  state.currentFolderId = null;
  state.breadcrumbs = [];
  state.search = "";
  elements["search-input"].value = "";
  updateNavigation();
  updateHeading();
  setSidebar(false);
  closeFloatingUi();
  loadItems();
}

function openFolder(folderId, breadcrumbIndex = null, folderItem = null) {
  state.scope = "files";
  state.currentFolderId = folderId;
  if (breadcrumbIndex === -1) state.breadcrumbs = [];
  else if (Number.isInteger(breadcrumbIndex)) state.breadcrumbs = state.breadcrumbs.slice(0, breadcrumbIndex + 1);
  else if (folderItem) state.breadcrumbs.push({ id: folderItem.id, name: folderItem.name });
  state.search = "";
  elements["search-input"].value = "";
  updateNavigation();
  updateHeading();
  loadItems();
}

async function activateItem(item) {
  closeFloatingUi();
  if (state.scope === "trash") {
    const button = document.querySelector(`[data-item-id="${CSS.escape(item.id)}"] .item-menu-button`);
    if (button) openContextMenu(item, button);
    return;
  }
  if (item.item_type === "folder") {
    openFolder(item.id, null, item);
    return;
  }
  try { await downloadItem(item); }
  catch (error) { showToast(errorMessage(error, "Não foi possível baixar o arquivo."), "error"); }
}

function contextButton({ label, iconName, action, danger = false }) {
  return `<button type="button" data-action="${action}" class="${danger ? "danger" : ""}">${icon(iconName)}<span>${escapeHtml(label)}</span></button>`;
}

function openContextMenu(item, anchor) {
  closeFloatingUi();
  state.activeMenuItem = item;
  const menu = elements["context-menu"];
  if (state.scope === "trash") {
    menu.innerHTML = [
      contextButton({ label: "Restaurar", iconName: "restore", action: "restore" }),
      '<div class="context-divider"></div>',
      contextButton({ label: "Excluir permanentemente", iconName: "trash", action: "delete", danger: true })
    ].join("");
  } else {
    const buttons = [];
    buttons.push(item.item_type === "folder"
      ? contextButton({ label: "Abrir", iconName: "folder", action: "open" })
      : contextButton({ label: "Baixar", iconName: "download", action: "download" }));
    buttons.push(contextButton({ label: "Renomear", iconName: "rename", action: "rename" }));
    buttons.push(contextButton({
      label: item.is_favorite ? "Remover dos favoritos" : "Adicionar aos favoritos",
      iconName: "star", action: "favorite"
    }));
    buttons.push('<div class="context-divider"></div>');
    buttons.push(contextButton({ label: "Mover para a lixeira", iconName: "trash", action: "trash", danger: true }));
    menu.innerHTML = buttons.join("");
  }
  menu.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleContextAction(button.dataset.action, item));
  });
  menu.hidden = false;
  requestAnimationFrame(() => positionFloating(menu, anchor.getBoundingClientRect()));
}

async function handleContextAction(action, item) {
  closeFloatingUi();
  if (action === "open") return openFolder(item.id, null, item);
  if (action === "download") {
    try { await downloadItem(item); }
    catch (error) { showToast(errorMessage(error, "Não foi possível baixar o arquivo."), "error"); }
    return;
  }
  if (action === "rename") return openNameDialog("rename", item);
  if (action === "favorite") {
    try {
      await updateItem(item.id, { is_favorite: !item.is_favorite });
      showToast(item.is_favorite ? "Removido dos favoritos." : "Adicionado aos favoritos.");
      await refreshAll({ silent: true });
    } catch (error) { showToast(errorMessage(error), "error"); }
    return;
  }
  if (action === "trash") {
    openConfirm({
      title: "Mover para a lixeira?",
      message: `“${item.name}” ficará disponível para restauração.`,
      buttonLabel: "Mover para a lixeira",
      action: async () => {
        await moveToTrash(item.id);
        showToast("Item movido para a lixeira.");
        await refreshAll({ silent: true });
      }
    });
    return;
  }
  if (action === "restore") {
    try {
      await restoreItem(item.id);
      showToast("Item restaurado.");
      await refreshAll({ silent: true });
    } catch (error) { showToast(errorMessage(error, "Não foi possível restaurar o item."), "error"); }
    return;
  }
  if (action === "delete") {
    openConfirm({
      title: "Excluir permanentemente?",
      message: `“${item.name}” será apagado e não poderá ser recuperado.`,
      buttonLabel: "Excluir permanentemente",
      action: async () => {
        await deleteItem(item.id);
        showToast("Item excluído permanentemente.");
        await refreshAll({ silent: true });
      }
    });
  }
}

function openNameDialog(mode, item = null) {
  state.nameMode = mode;
  state.itemBeingEdited = item;
  elements["name-error"].hidden = true;
  elements["name-error"].textContent = "";
  if (mode === "folder") {
    elements["name-dialog-kicker"].textContent = "Nova pasta";
    elements["name-dialog-title"].textContent = "Criar pasta";
    elements["name-submit"].textContent = "Criar";
    elements["name-input"].value = "";
  } else {
    elements["name-dialog-kicker"].textContent = item?.item_type === "folder" ? "Pasta" : "Arquivo";
    elements["name-dialog-title"].textContent = "Renomear item";
    elements["name-submit"].textContent = "Salvar";
    elements["name-input"].value = item?.name || "";
  }
  elements["name-dialog"].showModal();
  window.setTimeout(() => elements["name-input"].select(), 30);
}

function openConfirm({ title, message, buttonLabel, action }) {
  state.confirmAction = action;
  elements["confirm-title"].textContent = title;
  elements["confirm-message"].textContent = message;
  elements["confirm-submit"].textContent = buttonLabel;
  elements["confirm-dialog"].showModal();
}

async function submitNameForm(event) {
  event.preventDefault();
  const name = elements["name-input"].value.trim();
  if (!name) {
    elements["name-error"].textContent = "Digite um nome.";
    elements["name-error"].hidden = false;
    return;
  }
  elements["name-submit"].disabled = true;
  try {
    if (state.nameMode === "folder") {
      await createFolder({ name, parentId: state.currentFolderId });
      showToast("Pasta criada.");
    } else if (state.itemBeingEdited) {
      await updateItem(state.itemBeingEdited.id, { name });
      showToast("Item renomeado.");
    }
    elements["name-dialog"].close();
    await loadItems({ silent: true });
  } catch (error) {
    elements["name-error"].textContent = errorMessage(error);
    elements["name-error"].hidden = false;
  } finally { elements["name-submit"].disabled = false; }
}

async function submitConfirmForm(event) {
  event.preventDefault();
  if (!state.confirmAction) return elements["confirm-dialog"].close();
  elements["confirm-submit"].disabled = true;
  try {
    await state.confirmAction();
    elements["confirm-dialog"].close();
  } catch (error) { showToast(errorMessage(error), "error"); }
  finally {
    state.confirmAction = null;
    elements["confirm-submit"].disabled = false;
  }
}

function addUploadRow(file) {
  elements["upload-panel"].hidden = false;
  const row = document.createElement("div");
  row.className = "upload-row";
  row.innerHTML = `
    <span class="upload-row-icon">${icon("file")}</span>
    <span class="upload-row-copy"><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></span>
    <span class="upload-status">Na fila</span>`;
  elements["upload-list"].append(row);
  return row;
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter((file) => file instanceof File);
  if (!files.length) return;
  if (state.scope !== "files") switchScope("files");
  elements["upload-list"].innerHTML = "";
  elements["upload-title"].textContent = `Enviando ${files.length} arquivo${files.length === 1 ? "" : "s"}`;
  const rows = files.map((file) => ({ file, row: addUploadRow(file) }));
  let successCount = 0;
  for (const entry of rows) {
    const status = entry.row.querySelector(".upload-status");
    status.textContent = "Enviando";
    try {
      await uploadFile(entry.file, state.currentFolderId);
      status.textContent = "Concluído";
      successCount += 1;
    } catch (error) {
      status.textContent = "Falhou";
      status.classList.add("error");
      entry.row.title = errorMessage(error);
    }
  }
  elements["upload-title"].textContent = `${successCount} de ${files.length} concluído${files.length === 1 ? "" : "s"}`;
  if (successCount) {
    showToast(`${successCount} arquivo${successCount === 1 ? " enviado" : "s enviados"}.`);
    await refreshAll({ silent: true });
  }
  if (successCount !== files.length) showToast("Alguns arquivos não puderam ser enviados.", "error");
  elements["file-input"].value = "";
}

function bindEvents() {
  elements["new-button"].addEventListener("click", (event) => {
    event.stopPropagation();
    elements["new-popover"].hidden ? openNewPopover() : closeFloatingUi();
  });
  elements.newActions.forEach((button) => button.addEventListener("click", () => {
    closeFloatingUi();
    button.dataset.newAction === "folder" ? openNameDialog("folder") : elements["file-input"].click();
  }));
  elements["file-input"].addEventListener("change", () => uploadFiles(elements["file-input"].files));
  elements.sideNavItems.forEach((button) => button.addEventListener("click", () => switchScope(button.dataset.scope)));
  elements.viewButtons.forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    localStorage.setItem("atero-files-view", state.view);
    elements.viewButtons.forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
    renderItems();
  }));

  let searchTimer = null;
  elements["search-input"].addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.search = elements["search-input"].value.trim();
      loadItems();
    }, 280);
  });
  elements["sort-select"].addEventListener("change", () => {
    state.sort = elements["sort-select"].value;
    loadItems();
  });
  elements["refresh-button"].addEventListener("click", () => refreshAll());
  elements["empty-action"].addEventListener("click", () => openNewPopover());
  elements["mobile-menu"].addEventListener("click", () => setSidebar(true));
  elements["sidebar-close"].addEventListener("click", () => setSidebar(false));
  elements["sidebar-scrim"].addEventListener("click", () => setSidebar(false));
  elements["name-form"].addEventListener("submit", submitNameForm);
  elements["confirm-form"].addEventListener("submit", submitConfirmForm);
  elements.dialogCloseButtons.forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
  elements["empty-trash-button"].addEventListener("click", () => openConfirm({
    title: "Esvaziar a lixeira?",
    message: "Todos os itens serão apagados permanentemente.",
    buttonLabel: "Esvaziar lixeira",
    action: async () => {
      await emptyTrash();
      showToast("Lixeira esvaziada.");
      await refreshAll({ silent: true });
    }
  }));
  elements["upload-panel-close"].addEventListener("click", () => { elements["upload-panel"].hidden = true; });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#new-popover") && !event.target.closest("#new-button") && !event.target.closest("#context-menu")) closeFloatingUi();
  });
  window.addEventListener("resize", closeFloatingUi);
  window.addEventListener("scroll", closeFloatingUi, true);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      elements["search-input"].focus();
    }
    if (event.key === "Escape") {
      closeFloatingUi();
      setSidebar(false);
    }
  });

  document.addEventListener("dragenter", (event) => {
    if (![...event.dataTransfer?.types || []].includes("Files")) return;
    event.preventDefault();
    state.dragDepth += 1;
    elements["drop-zone"].hidden = false;
  });
  document.addEventListener("dragover", (event) => {
    if ([...event.dataTransfer?.types || []].includes("Files")) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
  });
  document.addEventListener("dragleave", (event) => {
    if (![...event.dataTransfer?.types || []].includes("Files")) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) elements["drop-zone"].hidden = true;
  });
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    elements["drop-zone"].hidden = true;
    if (event.dataTransfer?.files?.length) uploadFiles(event.dataTransfer.files);
  });
}

function configureAccount(user) {
  const displayName = user?.display_name || user?.email?.split("@")[0] || "Conta Atero";
  elements["account-name"].textContent = displayName;
  elements["account-email"].textContent = user?.email || "Conta conectada";
  elements["account-avatar"].textContent = initials(displayName, user?.email);
}

export async function iniciarAplicativo({ usuario, aplicativo }) {
  state.user = usuario;
  state.app = aplicativo;
  cacheElements();
  configureAccount(usuario);
  bindEvents();
  elements.viewButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.view === state.view));
  elements["sort-select"].value = state.sort;
  updateNavigation();
  updateHeading();
  await refreshAll();
}
