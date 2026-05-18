const CONFIG = {
  // ⚠️ API key 当前暴露在前端 — 任何打开 DevTools 的用户可读写整个数据库
  //    生产环境建议添加后端代理层（如 Cloudflare Worker / Vercel Function），
  //    将 API key 放在服务端，前端只请求自己的代理接口。
  BASE_URL: "https://sheetdb.io/api/v1/bzgwqm00fnygm",
  SHEETS: {
    USERS: "users",
    GIFTS: "gifts",
    HISTORIES: "histories"
  },
  SYNC_MS: 15000,
  IMAGE_PLACEHOLDER: "https://placehold.co/600x400?text=No+Image"
};

const STORAGE_KEY = "reward_user_session_v2";

const state = {
  currentUser: null,
  gifts: [],
  managedUser: null,
  syncTimer: null,
  pendingOps: 0,
  isExchanging: false
};

const els = {};

document.addEventListener("DOMContentLoaded", init);

// ====== 全局未捕获异常兜底 ======

window.addEventListener("unhandledrejection", (event) => {
  console.error("未捕获的异步错误:", event.reason);
  showToast("发生意外错误，请刷新页面重试", true);
});

window.addEventListener("error", (event) => {
  console.error("运行时错误:", event.error || event.message);
  showToast("页面发生错误，请刷新重试", true);
});

// ====== 初始化 ======

async function init() {
  cacheElements();
  bindEvents();
  resetManagedUserUI();
  await restoreSession();
}

function cacheElements() {
  els.userDisplay = document.getElementById("user-display");
  els.logoutBtn = document.getElementById("logout-btn");
  els.loginContainer = document.getElementById("login-container");
  els.mainContent = document.getElementById("main-content");
  els.loginUsername = document.getElementById("login-username");
  els.loginPassword = document.getElementById("login-password");
  els.loginBtn = document.getElementById("login-btn");
  els.refreshBtn = document.getElementById("refresh-btn");
  els.giftList = document.getElementById("gift-list");
  els.adminSections = document.querySelectorAll(".admin-only");

  els.addGiftForm = document.getElementById("add-gift-form");

  els.manageUsername = document.getElementById("manage-username");
  els.searchUserBtn = document.getElementById("search-user-btn");
  els.managedUserStatus = document.getElementById("managed-user-status");
  els.managedUserPoints = document.getElementById("managed-user-points");
  els.updatePointsForm = document.getElementById("update-points-form");

  els.editModal = document.getElementById("edit-modal");
  els.editGiftForm = document.getElementById("edit-gift-form");
  els.cancelEditBtn = document.getElementById("cancel-edit-btn");
  els.editGiftId = document.getElementById("edit-gift-id");
  els.editGiftName = document.getElementById("edit-gift-name");
  els.editGiftPoints = document.getElementById("edit-gift-points");
  els.editGiftStock = document.getElementById("edit-gift-stock");
  els.editGiftImage = document.getElementById("edit-gift-image");

  els.loadingOverlay = document.getElementById("loading-overlay");
  els.loadingText = document.getElementById("loading-text");
  els.toast = document.getElementById("toast");
}

function bindEvents() {
  els.loginBtn.addEventListener("click", login);
  els.logoutBtn.addEventListener("click", logout);
  els.refreshBtn.addEventListener("click", manualRefresh);
  els.giftList.addEventListener("click", handleGiftActions);

  els.addGiftForm.addEventListener("submit", addGift);
  els.searchUserBtn.addEventListener("click", loadManagedUser);
  els.updatePointsForm.addEventListener("submit", updateManagedUserPoints);

  els.editGiftForm.addEventListener("submit", saveGiftEdit);
  els.cancelEditBtn.addEventListener("click", closeEditModal);
  els.editModal.addEventListener("click", (event) => {
    if (event.target === els.editModal) {
      closeEditModal();
    }
  });
}

// ====== 数据规范化 ======

function normalizeUser(row) {
  return {
    username: String(row?.username ?? "").trim(),
    password: String(row?.password ?? ""),
    points: toInt(row?.points),
    is_admin: row?.is_admin
  };
}

function normalizeGift(row) {
  return {
    id: String(row?.id ?? "").trim(),
    name: String(row?.name ?? "未命名礼品").trim(),
    points: toInt(row?.points),
    stock: toInt(row?.stock),
    image: String(row?.image ?? "").trim() || CONFIG.IMAGE_PLACEHOLDER
  };
}

function toInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isAdmin(user) {
  const raw = String(user?.is_admin ?? "").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ====== 网络请求 ======

function buildUrl(path = "", query = {}) {
  const url = new URL(`${CONFIG.BASE_URL}${path}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function requestSheet(path = "", options = {}) {
  const { method = "GET", query = {}, body } = options;
  const requestInit = { method, headers: {} };
  if (body !== undefined) {
    requestInit.headers["Content-Type"] = "application/json";
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(buildUrl(path, query), requestInit);
  if (!response.ok) {
    throw new Error(`接口请求失败 (${response.status})`);
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function toArray(data) {
  return Array.isArray(data) ? data : [];
}

async function sheetGetAll(sheetName) {
  const data = await requestSheet("", { query: { sheet: sheetName } });
  return toArray(data);
}

async function sheetSearch(sheetName, filters) {
  const data = await requestSheet("/search", {
    query: { ...filters, sheet: sheetName }
  });
  return toArray(data);
}

async function sheetPatchBy(sheetName, column, value, patchData) {
  return requestSheet(`/${encodeURIComponent(column)}/${encodeURIComponent(value)}`, {
    method: "PATCH",
    query: { sheet: sheetName },
    body: patchData
  });
}

async function sheetDeleteBy(sheetName, column, value) {
  return requestSheet(`/${encodeURIComponent(column)}/${encodeURIComponent(value)}`, {
    method: "DELETE",
    query: { sheet: sheetName }
  });
}

async function sheetAppendRow(sheetName, rowData) {
  return requestSheet("", {
    method: "POST",
    query: { sheet: sheetName },
    body: { data: [rowData] }
  });
}

/**
 * 校验 PATCH 请求的响应，确认数据实际被更新。
 * SheetDB 返回 {"updated": 0} 时（数据未匹配）状态码仍为 200，
 * 此处主动将其视为错误。
 */
async function requirePatchApplied(promise, label) {
  const result = await promise;
  if (result && typeof result === "object" && "updated" in result && result.updated === 0) {
    throw new Error(`${label}失败：数据未找到或未变更`);
  }
  return result;
}

// ====== 数据查询 ======

async function fetchUserByUsername(username) {
  const rows = await sheetSearch(CONFIG.SHEETS.USERS, { username });
  if (rows.length === 0) {
    return null;
  }
  return normalizeUser(rows[0]);
}

async function fetchGiftById(giftId) {
  const rows = await sheetSearch(CONFIG.SHEETS.GIFTS, { id: giftId });
  if (rows.length === 0) {
    return null;
  }
  return normalizeGift(rows[0]);
}

// ====== 加载状态管理 ======

async function withLoading(text, action) {
  setLoading(true, text);
  try {
    return await action();
  } finally {
    setLoading(false);
  }
}

function setLoading(show, text = "处理中...") {
  if (show) {
    state.pendingOps += 1;
    if (state.pendingOps === 1) {
      els.loadingOverlay.classList.remove("hidden");
      els.loadingOverlay.classList.add("flex");
      setControlsDisabled(true);
    }
    els.loadingText.textContent = text;
    return;
  }

  state.pendingOps = Math.max(0, state.pendingOps - 1);
  if (state.pendingOps === 0) {
    els.loadingOverlay.classList.add("hidden");
    els.loadingOverlay.classList.remove("flex");
    setControlsDisabled(false);
  }
}

function setControlsDisabled(disabled) {
  const controls = document.querySelectorAll("button, input, select, textarea");
  controls.forEach((control) => {
    if (disabled) {
      control.dataset.prevDisabled = control.disabled ? "1" : "0";
      control.disabled = true;
      return;
    }
    if (control.dataset.prevDisabled === "0") {
      control.disabled = false;
    }
    delete control.dataset.prevDisabled;
  });
}

// ====== Toast 提示 ======

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden", "bg-slate-900", "bg-rose-700");
  els.toast.classList.add(isError ? "bg-rose-700" : "bg-slate-900");
  setTimeout(() => {
    els.toast.classList.add("hidden");
  }, 2200);
}

// ====== 会话管理 ======

function saveSession(user) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ username: user.username }));
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

async function restoreSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    renderSessionUI();
    return;
  }

  try {
    const session = JSON.parse(raw);
    if (!session?.username) {
      clearSession();
      renderSessionUI();
      return;
    }

    await withLoading("正在恢复登录状态...", async () => {
      const cloudUser = await fetchUserByUsername(session.username);
      if (!cloudUser) {
        clearSession();
        renderSessionUI();
        return;
      }
      state.currentUser = cloudUser;
      renderSessionUI();
      await loadGifts({ silent: false });
      startSync();
      showToast("已自动登录");
    });
  } catch (_error) {
    clearSession();
    renderSessionUI();
  }
}

function renderSessionUI() {
  const loggedIn = Boolean(state.currentUser);
  els.loginContainer.classList.toggle("hidden", loggedIn);
  els.mainContent.classList.toggle("hidden", !loggedIn);
  els.logoutBtn.classList.toggle("hidden", !loggedIn);

  if (!loggedIn) {
    els.userDisplay.textContent = "";
    els.giftList.innerHTML = "";
    closeEditModal();
    resetManagedUserUI();
    return;
  }

  updateUserDisplay();
  const admin = isAdmin(state.currentUser);
  els.adminSections.forEach((section) => {
    section.classList.toggle("hidden", !admin);
  });

  if (!admin) {
    resetManagedUserUI();
  }
}

function updateUserDisplay() {
  if (!state.currentUser) {
    els.userDisplay.textContent = "";
    return;
  }
  const adminTag = isAdmin(state.currentUser) ? " (管理员)" : "";
  els.userDisplay.textContent = `${state.currentUser.username}${adminTag} | 积分: ${state.currentUser.points}`;
}

// ====== 登录 / 退出 ======

async function login() {
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;

  if (!username || !password) {
    showToast("请输入用户名和密码", true);
    return;
  }

  try {
    await withLoading("正在登录...", async () => {
      const usersRaw = await sheetSearch(CONFIG.SHEETS.USERS, { username });
      const users = usersRaw.map(normalizeUser);
      const matchedUser = users.find((user) => user.password === password);

      if (!matchedUser) {
        throw new Error("用户名或密码错误");
      }

      state.currentUser = matchedUser;
      saveSession(matchedUser);
      renderSessionUI();
      await loadGifts({ silent: false });
      startSync();
      showToast("登录成功");
    });
  } catch (error) {
    showToast(error.message || "登录失败", true);
  }
}

function logout() {
  stopSync();
  clearSession();
  state.currentUser = null;
  state.gifts = [];
  closeEditModal();
  renderSessionUI();
  showToast("已退出登录");
}

// ====== 自动同步 ======

function startSync() {
  stopSync();
  state.syncTimer = setInterval(async () => {
    if (!state.currentUser || state.pendingOps > 0) {
      return;
    }
    await Promise.all([
      loadGifts({ silent: true }),
      refreshCurrentUser({ silent: true })
    ]);
  }, CONFIG.SYNC_MS);
}

function stopSync() {
  if (state.syncTimer) {
    clearInterval(state.syncTimer);
    state.syncTimer = null;
  }
}

async function refreshCurrentUser({ silent = false } = {}) {
  if (!state.currentUser?.username) {
    return;
  }

  try {
    const cloudUser = await fetchUserByUsername(state.currentUser.username);
    if (!cloudUser) {
      return;
    }
    state.currentUser = cloudUser;
    saveSession(cloudUser);
    updateUserDisplay();
  } catch (_error) {
    if (!silent) {
      showToast("用户状态同步失败", true);
    }
  }
}

async function manualRefresh() {
  if (!state.currentUser) {
    return;
  }
  try {
    await withLoading("正在刷新数据...", async () => {
      await Promise.all([
        loadGifts({ silent: true }),
        refreshCurrentUser({ silent: true })
      ]);
    });
    showToast("数据已刷新");
  } catch (_error) {
    showToast("刷新失败，请稍后重试", true);
  }
}

// ====== 礼品列表 ======

async function loadGifts({ silent = false } = {}) {
  if (!silent) {
    els.giftList.innerHTML = "<p class='col-span-full text-center text-slate-500'>正在加载礼品...</p>";
  }

  try {
    const giftsRaw = await sheetGetAll(CONFIG.SHEETS.GIFTS);
    state.gifts = giftsRaw.map(normalizeGift);
    renderGiftList();
  } catch (_error) {
    if (!silent) {
      els.giftList.innerHTML = "<p class='col-span-full text-center text-rose-600'>礼品加载失败，请刷新重试</p>";
      showToast("礼品加载失败", true);
    }
  }
}

function renderGiftList() {
  if (!state.currentUser) {
    return;
  }
  if (state.gifts.length === 0) {
    els.giftList.innerHTML = "<p class='col-span-full rounded border border-slate-200 bg-white p-4 text-center text-slate-500'>暂无礼品</p>";
    return;
  }

  const admin = isAdmin(state.currentUser);
  const cards = state.gifts.map((gift) => {
    // 按钮文案：优先显示最具体的限制原因
    let exchangeText, canExchange;
    if (gift.stock <= 0) {
      exchangeText = "已售罄";
      canExchange = false;
    } else if (state.currentUser.points < gift.points) {
      exchangeText = "积分不足";
      canExchange = false;
    } else {
      exchangeText = "兑换";
      canExchange = true;
    }

    const adminActions = admin
      ? `
        <div class="mt-2 flex gap-2">
          <button data-action="edit" data-id="${escapeHtml(gift.id)}" class="w-full rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">编辑</button>
          <button data-action="delete" data-id="${escapeHtml(gift.id)}" class="w-full rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100">删除</button>
        </div>
      `
      : "";

    return `
      <article class="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <img src="${escapeHtml(gift.image)}"
             alt="${escapeHtml(gift.name)}"
             class="mb-3 h-40 w-full rounded object-cover"
             loading="lazy"
             onerror="this.onerror=null;this.src='${CONFIG.IMAGE_PLACEHOLDER}'">
        <h3 class="line-clamp-1 text-base font-semibold">${escapeHtml(gift.name)}</h3>
        <p class="mt-1 text-sm text-blue-700">所需积分: ${gift.points}</p>
        <p class="mt-1 text-sm text-slate-600">库存: ${gift.stock}</p>
        <button
          data-action="exchange"
          data-id="${escapeHtml(gift.id)}"
          ${canExchange ? "" : "disabled"}
          class="mt-3 w-full rounded px-3 py-2 text-sm font-medium text-white ${canExchange ? "bg-orange-500 hover:bg-orange-600" : "cursor-not-allowed bg-slate-400"}">
          ${exchangeText}
        </button>
        ${adminActions}
      </article>
    `;
  });

  els.giftList.innerHTML = cards.join("");
}

// ====== 礼品操作事件路由 ======

function handleGiftActions(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.action;
  const giftId = button.dataset.id;

  if (action === "exchange") {
    exchangeGift(giftId);
    return;
  }
  if (action === "edit") {
    openEditModal(giftId);
    return;
  }
  if (action === "delete") {
    deleteGift(giftId);
  }
}

// ====== 兑换礼品（含防超卖与回滚） ======

async function exchangeGift(giftId) {
  if (!state.currentUser) return;

  // 防止并发兑换（双击或网络延迟导致重复提交）
  if (state.isExchanging) {
    showToast("正在处理兑换，请稍候...", true);
    return;
  }

  // 从本地列表查找礼品，用于确认弹窗展示
  const gift = state.gifts.find((g) => g.id === giftId);
  if (!gift) {
    showToast("礼品不存在", true);
    return;
  }

  // 兑换前二次确认
  if (!window.confirm(`确认兑换「${gift.name}」（消耗 ${gift.points} 积分）？`)) {
    return;
  }

  state.isExchanging = true;
  try {
    await withLoading("正在兑换礼品...", async () => {
      // 1. 从云端实时拉取最新数据，避免本地缓存导致的竞态
      const [latestUser, latestGift] = await Promise.all([
        fetchUserByUsername(state.currentUser.username),
        fetchGiftById(giftId)
      ]);

      if (!latestUser || !latestGift) {
        throw new Error("用户或礼品数据不存在");
      }
      if (latestUser.points < latestGift.points) {
        throw new Error("积分不足");
      }
      if (latestGift.stock <= 0) {
        throw new Error("库存不足");
      }

      const newPoints = latestUser.points - latestGift.points;
      const newStock = latestGift.stock - 1;

      // 2. 扣减用户积分，校验响应确认写入成功
      await requirePatchApplied(
        sheetPatchBy(CONFIG.SHEETS.USERS, "username", latestUser.username, {
          points: String(newPoints)
        }),
        "积分扣除"
      );

      // 3. 扣减库存，若失败则回滚用户积分
      try {
        await requirePatchApplied(
          sheetPatchBy(CONFIG.SHEETS.GIFTS, "id", latestGift.id, {
            stock: String(newStock)
          }),
          "库存更新"
        );
      } catch (stockError) {
        // 回滚：将积分恢复至兑换前的数值
        try {
          await sheetPatchBy(CONFIG.SHEETS.USERS, "username", latestUser.username, {
            points: String(latestUser.points)
          });
        } catch (_rollbackError) {
          // 回滚也失败时抛出致命错误，提醒人工介入
          throw new Error("兑换失败且积分回滚异常，请联系管理员手动处理");
        }
        // 回滚成功，给用户明确提示
        throw new Error("兑换失败，已自动回滚积分");
      }

      // 4. 记录兑换历史
      const now = new Date();
      await sheetAppendRow(CONFIG.SHEETS.HISTORIES, {
        username: latestUser.username,
        gift_id: latestGift.id,
        gift_name: latestGift.name,
        cost: String(latestGift.points),
        date: now.toLocaleString("zh-CN"),
        timestamp: now.toISOString()
      });

      // 5. 更新本地状态与 UI
      state.currentUser = { ...latestUser, points: newPoints };
      saveSession(state.currentUser);
      updateUserDisplay();
      await loadGifts({ silent: true });
      showToast("兑换成功");
    });
  } catch (error) {
    showToast(error.message || "兑换失败", true);
  } finally {
    state.isExchanging = false;
  }
}

// ====== 编辑礼品弹窗 ======

function openEditModal(giftId) {
  if (!isAdmin(state.currentUser)) {
    showToast("没有管理员权限", true);
    return;
  }
  const gift = state.gifts.find((item) => item.id === giftId);
  if (!gift) {
    showToast("未找到礼品", true);
    return;
  }
  els.editGiftId.value = gift.id;
  els.editGiftName.value = gift.name;
  els.editGiftPoints.value = gift.points;
  els.editGiftStock.value = gift.stock;
  els.editGiftImage.value = gift.image === CONFIG.IMAGE_PLACEHOLDER ? "" : gift.image;
  els.editModal.classList.remove("hidden");
  els.editModal.classList.add("flex");
}

function closeEditModal() {
  els.editGiftForm.reset();
  els.editModal.classList.add("hidden");
  els.editModal.classList.remove("flex");
}

async function saveGiftEdit(event) {
  event.preventDefault();
  if (!isAdmin(state.currentUser)) {
    showToast("没有管理员权限", true);
    return;
  }

  const giftId = els.editGiftId.value.trim();
  const name = els.editGiftName.value.trim();
  const points = toInt(els.editGiftPoints.value);
  const stock = toInt(els.editGiftStock.value);
  const image = els.editGiftImage.value.trim() || CONFIG.IMAGE_PLACEHOLDER;

  if (!giftId || !name) {
    showToast("礼品信息不完整", true);
    return;
  }

  try {
    await withLoading("正在保存礼品...", async () => {
      await requirePatchApplied(
        sheetPatchBy(CONFIG.SHEETS.GIFTS, "id", giftId, {
          name,
          points: String(points),
          stock: String(stock),
          image
        }),
        "礼品更新"
      );
      closeEditModal();
      await loadGifts({ silent: true });
      showToast("礼品已更新");
    });
  } catch (_error) {
    showToast("保存失败，请检查网络或接口权限", true);
  }
}

// ====== 删除礼品 ======

async function deleteGift(giftId) {
  if (!isAdmin(state.currentUser)) {
    showToast("没有管理员权限", true);
    return;
  }
  if (!window.confirm("确认删除该礼品吗？此操作不可恢复。")) {
    return;
  }

  try {
    await withLoading("正在删除礼品...", async () => {
      await sheetDeleteBy(CONFIG.SHEETS.GIFTS, "id", giftId);
      await loadGifts({ silent: true });
      showToast("礼品已删除");
    });
  } catch (_error) {
    showToast("删除失败，请稍后重试", true);
  }
}

// ====== 新增礼品 ======

async function addGift(event) {
  event.preventDefault();
  if (!isAdmin(state.currentUser)) {
    showToast("没有管理员权限", true);
    return;
  }

  const formData = new FormData(els.addGiftForm);
  const id = String(formData.get("id") ?? "").trim() || `gift_${Date.now()}`;
  const name = String(formData.get("name") ?? "").trim();
  const points = toInt(formData.get("points"));
  const stock = toInt(formData.get("stock"));
  const image = String(formData.get("image") ?? "").trim() || CONFIG.IMAGE_PLACEHOLDER;

  if (!name) {
    showToast("请输入礼品名称", true);
    return;
  }

  try {
    await withLoading("正在新增礼品...", async () => {
      const existing = await fetchGiftById(id);
      if (existing) {
        throw new Error("礼品ID已存在，请更换");
      }

      await sheetAppendRow(CONFIG.SHEETS.GIFTS, {
        id,
        name,
        points: String(points),
        stock: String(stock),
        image
      });

      els.addGiftForm.reset();
      await loadGifts({ silent: true });
      showToast("礼品新增成功");
    });
  } catch (error) {
    showToast(error.message || "新增失败，请稍后重试", true);
  }
}

// ====== 积分管理（管理员功能） ======

function resetManagedUserUI() {
  state.managedUser = null;
  if (els.managedUserStatus) {
    els.managedUserStatus.textContent = "未选择用户";
  }
  if (els.manageUsername) {
    els.manageUsername.value = "";
  }
  if (els.managedUserPoints) {
    els.managedUserPoints.value = "";
  }
}

async function loadManagedUser() {
  if (!isAdmin(state.currentUser)) {
    showToast("没有管理员权限", true);
    return;
  }
  const username = els.manageUsername.value.trim();
  if (!username) {
    showToast("请输入用户名", true);
    return;
  }

  try {
    await withLoading("正在检索用户...", async () => {
      const user = await fetchUserByUsername(username);
      if (!user) {
        throw new Error("未找到该用户");
      }
      state.managedUser = user;
      els.managedUserStatus.textContent = `当前用户: ${user.username} | 积分: ${user.points}`;
      els.managedUserPoints.value = user.points;
      showToast("用户检索成功");
    });
  } catch (error) {
    showToast(error.message || "检索失败", true);
  }
}

async function updateManagedUserPoints(event) {
  event.preventDefault();
  if (!isAdmin(state.currentUser)) {
    showToast("没有管理员权限", true);
    return;
  }
  if (!state.managedUser) {
    showToast("请先检索用户", true);
    return;
  }

  const newPoints = toInt(els.managedUserPoints.value);
  if (newPoints < 0) {
    showToast("积分不能小于 0", true);
    return;
  }

  try {
    await withLoading("正在更新积分...", async () => {
      await requirePatchApplied(
        sheetPatchBy(CONFIG.SHEETS.USERS, "username", state.managedUser.username, {
          points: String(newPoints)
        }),
        "积分更新"
      );

      state.managedUser.points = newPoints;
      els.managedUserStatus.textContent = `当前用户: ${state.managedUser.username} | 积分: ${newPoints}`;

      if (state.currentUser && state.currentUser.username === state.managedUser.username) {
        state.currentUser.points = newPoints;
        saveSession(state.currentUser);
        updateUserDisplay();
      }

      showToast("积分更新成功");
    });
  } catch (_error) {
    showToast("积分更新失败", true);
  }
}
