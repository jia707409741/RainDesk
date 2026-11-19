import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ---------- 全局状态 ----------
let store = { groups: [], todos: [] };
let currentView = 'launcher';
let todoFilter = 'all';
let editingGroupId = null;
let editingShortcut = null; // { groupId, id }
let editingTodoId = null;
let confirmAction = null;
let dataDirDefault = ''; // 应用默认数据目录，用于“恢复默认”

// 拖拽状态（纯鼠标事件：内部排序/跨组）
let mouseDrag = null; // { type, id, groupId, startX, startY, active, plan, ghost, source }
let suppressClick = false; // 拖拽结束后抑制一次 click，避免误启动
// 文件拖入状态
let fileDragActive = false;
let dropTargetGroupId = null;

const $ = (id) => document.getElementById(id);

// 优先级：数值越小越靠前；旧数据没有 priority 字段时按“中”处理
const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_LABEL = { urgent: '加急', high: '高', medium: '中', low: '低' };
function normalizePriority(p) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_ORDER, p) ? p : 'medium';
}

// ---------- 工具函数 ----------
function uid(prefix = 'x') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 快捷方式图标：优先渲染从文件提取的真实图标，否则回退到 emoji
function scIconHtml(s) {
  if (s.iconData && /^data:image\//.test(s.iconData)) {
    return `<img class="sc-real-icon" src="${s.iconData}" alt="">`;
  }
  return escapeHtml(s.icon || '📌');
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

async function save() {
  try {
    await invoke('save_store', { store });
  } catch (e) {
    toast('保存失败：' + e);
  }
}

// 把时间戳格式化为 datetime-local 输入值（本地时区）
function tsToLocalInput(ts) {
  if (ts == null) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDue(ts) {
  if (ts == null) return '无截止时间';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `今天 ${time}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

function dueState(todo) {
  if (todo.done || todo.due == null) return '';
  const trigger = todo.due - todo.remindBefore * 60000;
  const now = Date.now();
  if (now >= todo.due) return 'overdue';
  if (now >= trigger) return 'urgent';
  return '';
}

function timeLeftText(todo) {
  const diff = todo.due - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  let txt;
  if (days > 0) txt = `${days} 天`;
  else if (hours > 0) txt = `${hours} 小时`;
  else txt = `${Math.max(mins, 1)} 分钟`;
  return diff >= 0 ? `剩 ${txt}` : `已超时 ${txt}`;
}

// ---------- 渲染：快捷方式 ----------
function renderGroups() {
  const container = $('groups');
  if (store.groups.length === 0) {
    container.innerHTML = `<div class="empty"><span class="empty-icon">⚡</span>还没有分组，点击右上角「新建分组」开始吧</div>`;
    return;
  }
  container.innerHTML = store.groups.map((g) => {
    const shortcuts = g.shortcuts.map((s) => `
      <div class="shortcut" data-launch="${escapeHtml(s.id)}" data-sc="${escapeHtml(s.id)}" data-group="${escapeHtml(g.id)}" title="${escapeHtml(s.name)}">
        <button class="sc-del" data-del-sc="${escapeHtml(s.id)}" title="删除">×</button>
        <div class="sc-icon-box c-${escapeHtml(s.color)}">${scIconHtml(s)}</div>
        <div class="sc-name">${escapeHtml(s.name)}</div>
      </div>`).join('');
    return `
      <div class="group" data-group="${escapeHtml(g.id)}">
        <div class="group-header" data-group-header="${escapeHtml(g.id)}">
          <span class="group-icon">${escapeHtml(g.icon)}</span>
          <span class="group-title">${escapeHtml(g.name)}</span>
          <span class="group-count">${g.shortcuts.length} 项</span>
          <span class="group-drag-handle" title="拖动排序">⠿</span>
          <div class="group-menu">
            <button class="icon-btn" data-edit-group="${escapeHtml(g.id)}" title="编辑分组">✏️</button>
            <button class="icon-btn danger" data-del-group="${escapeHtml(g.id)}" title="删除分组">🗑️</button>
          </div>
        </div>
        <div class="shortcut-grid" data-drop-grid="${escapeHtml(g.id)}">
          ${shortcuts}
          <div class="add-shortcut" data-add-sc="${escapeHtml(g.id)}">
            <span class="plus">＋</span><span>添加</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ---------- 渲染：待办 ----------
function renderTodos() {
  const container = $('todos');
  let list = store.todos.slice();
  if (todoFilter === 'pending') list = list.filter((t) => !t.done);
  if (todoFilter === 'done') list = list.filter((t) => t.done);
  // 排序：未完成在前 → 优先级（加急>高>中>低）→ 截止时间升序 → 创建时间倒序
  list.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const pa = PRIORITY_ORDER[normalizePriority(a.priority)];
    const pb = PRIORITY_ORDER[normalizePriority(b.priority)];
    if (pa !== pb) return pa - pb;
    if (a.due == null && b.due == null) return b.createdAt - a.createdAt;
    if (a.due == null) return 1;
    if (b.due == null) return -1;
    if (a.due !== b.due) return a.due - b.due;
    return b.createdAt - a.createdAt;
  });

  if (list.length === 0) {
    container.innerHTML = `<div class="empty"><span class="empty-icon">✅</span>这里空空如也，添加一个待办吧</div>`;
    return;
  }

  container.innerHTML = list.map((t) => {
    const state = dueState(t);
    const stateClass = state ? ` ${state}` : '';
    const priority = normalizePriority(t.priority);
    const remindText = t.remindBefore > 0 ? `提前 ${t.remindBefore} 分钟` : '准时提醒';
    return `
      <div class="todo${stateClass}${t.done ? ' done' : ''}" data-todo="${escapeHtml(t.id)}">
        <button class="todo-check" data-toggle="${escapeHtml(t.id)}" title="切换完成">${t.done ? '✓' : ''}</button>
        <div class="todo-body">
          <div class="todo-title">${escapeHtml(t.title)}</div>
          ${t.note ? `<div class="todo-note">${escapeHtml(t.note)}</div>` : ''}
          <div class="todo-meta">
            <span class="priority-tag p-${priority}">${PRIORITY_LABEL[priority]}</span>
            <span class="todo-due">🕐 ${formatDue(t.due)}${t.due != null && !t.done ? ' · ' + timeLeftText(t) : ''}</span>
            ${t.due != null ? `<span class="remind-tag">${remindText}</span>` : ''}
          </div>
        </div>
        <div class="todo-actions">
          <button class="icon-btn" data-edit-todo="${escapeHtml(t.id)}" title="编辑">✏️</button>
          <button class="icon-btn danger" data-del-todo="${escapeHtml(t.id)}" title="删除">🗑️</button>
        </div>
      </div>`;
  }).join('');
}

function updateBadge() {
  const count = store.todos.filter((t) => !t.done).length;
  const badge = $('todoBadge');
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
}

function renderAll() {
  renderGroups();
  renderTodos();
  updateBadge();
}

// ---------- 弹窗控制 ----------
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function askConfirm(text, action) {
  $('confirmText').textContent = text;
  confirmAction = action;
  openModal('confirmModal');
}

// ---------- 事件：导航 ----------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    $('view-launcher').classList.toggle('hidden', currentView !== 'launcher');
    $('view-todos').classList.toggle('hidden', currentView !== 'todos');
  });
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    todoFilter = btn.dataset.filter;
    renderTodos();
  });
});

// 关闭弹窗按钮
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// ---------- 事件：分组 ----------
$('addGroupBtn').addEventListener('click', () => {
  editingGroupId = null;
  $('groupModalTitle').textContent = '新建分组';
  $('groupName').value = '';
  $('groupIcon').value = '';
  openModal('groupModal');
});

$('saveGroupBtn').addEventListener('click', () => {
  const name = $('groupName').value.trim();
  const icon = $('groupIcon').value.trim() || '📦';
  if (!name) { toast('请输入分组名称'); return; }
  if (editingGroupId) {
    const g = store.groups.find((x) => x.id === editingGroupId);
    if (g) { g.name = name; g.icon = icon; }
  } else {
    store.groups.push({ id: uid('g'), name, icon, shortcuts: [] });
  }
  save();
  renderGroups();
  closeModal('groupModal');
});

// ---------- 事件：快捷方式（事件委托）----------
$('groups').addEventListener('click', (e) => {
  if (suppressClick) return; // 拖拽刚结束，忽略这次 click
  const delGroup = e.target.closest('[data-del-group]');
  if (delGroup) {
    e.stopPropagation();
    const id = delGroup.dataset.delGroup;
    const g = store.groups.find((x) => x.id === id);
    askConfirm(`确定删除分组「${g?.name ?? ''}」及其中的所有快捷方式吗？`, () => {
      store.groups = store.groups.filter((x) => x.id !== id);
      save(); renderGroups();
    });
    return;
  }

  const editGroup = e.target.closest('[data-edit-group]');
  if (editGroup) {
    e.stopPropagation();
    editingGroupId = editGroup.dataset.editGroup;
    const g = store.groups.find((x) => x.id === editingGroupId);
    $('groupModalTitle').textContent = '编辑分组';
    $('groupName').value = g?.name ?? '';
    $('groupIcon').value = g?.icon ?? '';
    openModal('groupModal');
    return;
  }

  const addSc = e.target.closest('[data-add-sc]');
  if (addSc) {
    openShortcutModal(addSc.dataset.addSc, null);
    return;
  }

  const delSc = e.target.closest('[data-del-sc]');
  if (delSc) {
    e.stopPropagation();
    const id = delSc.dataset.delSc;
    askConfirm('确定删除这个快捷方式吗？', () => {
      store.groups.forEach((g) => { g.shortcuts = g.shortcuts.filter((s) => s.id !== id); });
      save(); renderGroups();
    });
    return;
  }

  const launch = e.target.closest('[data-launch]');
  if (launch) {
    const id = launch.dataset.launch;
    let found = null;
    for (const g of store.groups) {
      found = g.shortcuts.find((s) => s.id === id);
      if (found) break;
    }
    if (found) {
      invoke('launch_shortcut', { shortcut: found })
        .catch((err) => toast('启动失败：' + err));
    }
  }
});

// ---------- 内部拖拽：排序 / 跨分组移动（纯鼠标事件实现） ----------
// WebView2 中 HTML5 原生 DnD 的 drop 派发不稳定，这里完全改用 pointer 事件，
// 自己判断落点，确保排序 / 跨组移动在真实鼠标操作下可靠工作。

function clearDropHints() {
  document.querySelectorAll('.drop-before, .drop-after, .drag-over, .drag-over-group, .dragging, .dragging-group')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drag-over', 'drag-over-group', 'dragging', 'dragging-group'));
}

// 从落点元素计算移动计划
function computePlan(clientX, clientY) {
  if (!mouseDrag) return null;
  // 浮层 pointer-events:none，elementFromPoint 能拿到下面的真实元素
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;

  if (mouseDrag.type === 'shortcut') {
    const sc = el.closest('.shortcut');
    if (sc && sc.dataset.sc !== mouseDrag.id) {
      const rect = sc.getBoundingClientRect();
      const after = clientX > rect.left + rect.width / 2;
      return { targetGroupId: sc.dataset.group, targetScId: sc.dataset.sc, insertAfter: after };
    }
    const grid = el.closest('.shortcut-grid');
    if (grid) return { targetGroupId: grid.dataset.dropGrid, targetScId: null };
    const group = el.closest('.group');
    if (group) return { targetGroupId: group.dataset.group, targetScId: null };
    return null;
  } else {
    const group = el.closest('.group');
    if (group && group.dataset.group !== mouseDrag.id) {
      const rect = group.getBoundingClientRect();
      return { groupId: group.dataset.group, insertAfter: clientY > rect.top + rect.height / 2 };
    }
    return null;
  }
}

function clearDropTargetsOnly() {
  document.querySelectorAll('.drop-before, .drop-after, .drag-over, .drag-over-group')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drag-over', 'drag-over-group'));
}

function showPlanHints(plan) {
  clearDropTargetsOnly(); // 不清 dragging，保持源元素半透明
  if (!plan) return;
  if (mouseDrag.type === 'shortcut') {
    if (plan.targetScId) {
      const target = document.querySelector(`.shortcut[data-sc="${CSS.escape(plan.targetScId)}"]`);
      if (target) target.classList.add(plan.insertAfter ? 'drop-after' : 'drop-before');
    } else if (plan.targetGroupId) {
      const grid = document.querySelector(`.shortcut-grid[data-drop-grid="${CSS.escape(plan.targetGroupId)}"]`);
      if (grid) grid.classList.add('drag-over');
    }
  } else if (plan.groupId) {
    const g = document.querySelector(`.group[data-group="${CSS.escape(plan.groupId)}"]`);
    if (g) g.classList.add('drag-over-group');
  }
}

// pointerdown：记录候选拖拽对象（尚未激活，等待移动阈值）
$('groups').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // 只响应左键
  const sc = e.target.closest('.shortcut');
  const gh = e.target.closest('.group-header');
  // 删除按钮、编辑/删除分组按钮不触发拖拽
  if (e.target.closest('button')) return;
  if (sc) {
    mouseDrag = { type: 'shortcut', id: sc.dataset.sc, groupId: sc.dataset.group,
      startX: e.clientX, startY: e.clientY, active: false, plan: null, ghost: null, source: sc };
  } else if (gh) {
    mouseDrag = { type: 'group', id: gh.dataset.groupHeader,
      startX: e.clientX, startY: e.clientY, active: false, plan: null, ghost: null, source: gh.closest('.group') };
  } else {
    mouseDrag = null;
  }
});

// pointermove：超过阈值后激活拖拽，创建跟随浮层并计算落点
document.addEventListener('pointermove', (e) => {
  if (!mouseDrag) return;
  if (!mouseDrag.active) {
    const dist = Math.hypot(e.clientX - mouseDrag.startX, e.clientY - mouseDrag.startY);
    if (dist < 5) return; // 未超过阈值，视为点击
    mouseDrag.active = true;
    // 源元素半透明
    if (mouseDrag.type === 'shortcut') mouseDrag.source.classList.add('dragging');
    else mouseDrag.source.classList.add('dragging-group');
    // 创建跟随浮层
    const ghost = mouseDrag.source.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('dragging', 'dragging-group');
    ghost.style.width = mouseDrag.source.getBoundingClientRect().width + 'px';
    document.body.appendChild(ghost);
    mouseDrag.ghost = ghost;
  }
  e.preventDefault();
  // 移动浮层
  if (mouseDrag.ghost) {
    mouseDrag.ghost.style.left = (e.clientX + 14) + 'px';
    mouseDrag.ghost.style.top = (e.clientY + 14) + 'px';
  }
  mouseDrag.plan = computePlan(e.clientX, e.clientY);
  showPlanHints(mouseDrag.plan);
});

// pointerup：清理视觉状态并执行计划
document.addEventListener('pointerup', () => {
  if (!mouseDrag) return;
  const d = mouseDrag;
  mouseDrag = null;
  if (d.ghost) d.ghost.remove();
  clearDropHints();
  if (!d.active) return; // 只是点击，不执行移动
  suppressClick = true;  // 抑制拖拽后的 click（避免误启动）
  setTimeout(() => { suppressClick = false; }, 0);
  performDropWith(d);
});

// 用指定 drag 对象执行（pointerup 时 mouseDrag 已清空）
function performDropWith(d) {
  if (!d.plan) return;
  const plan = d.plan;
  if (d.type === 'shortcut') {
    const srcGroup = store.groups.find((g) => g.id === d.groupId);
    const tgtGroup = store.groups.find((g) => g.id === plan.targetGroupId);
    if (!srcGroup || !tgtGroup) return;
    const scIndex = srcGroup.shortcuts.findIndex((s) => s.id === d.id);
    if (scIndex < 0) return;
    const [moved] = srcGroup.shortcuts.splice(scIndex, 1);
    let insertIndex = tgtGroup.shortcuts.length;
    if (plan.targetScId) {
      const ti = tgtGroup.shortcuts.findIndex((s) => s.id === plan.targetScId);
      if (ti >= 0) insertIndex = ti + (plan.insertAfter ? 1 : 0);
    }
    tgtGroup.shortcuts.splice(insertIndex, 0, moved);
    save();
    renderGroups();
    toast(d.groupId !== plan.targetGroupId ? `已移动到「${tgtGroup.name}」` : '顺序已更新');
  } else if (d.type === 'group') {
    const from = store.groups.findIndex((g) => g.id === d.id);
    if (from < 0 || !plan.groupId) return;
    const [moved] = store.groups.splice(from, 1);
    let insertIndex = store.groups.findIndex((g) => g.id === plan.groupId);
    if (insertIndex < 0) insertIndex = store.groups.length;
    if (plan.insertAfter) insertIndex += 1;
    store.groups.splice(insertIndex, 0, moved);
    save();
    renderGroups();
    toast('分组顺序已更新');
  }
}

// pointercancel：异常中断时清理
document.addEventListener('pointercancel', () => {
  if (mouseDrag?.ghost) mouseDrag.ghost.remove();
  mouseDrag = null;
  clearDropHints();
});

function openShortcutModal(groupId, shortcut) {
  editingShortcut = { groupId, id: shortcut?.id ?? null };
  $('shortcutModalTitle').textContent = shortcut ? '编辑快捷方式' : '添加快捷方式';
  $('scName').value = shortcut?.name ?? '';
  $('scKind').value = shortcut?.kind ?? 'app';
  $('scTarget').value = shortcut?.target ?? '';
  $('scIcon').value = shortcut?.icon ?? '';
  $('scColor').value = shortcut?.color ?? 'blue';
  openModal('shortcutModal');
}

$('saveShortcutBtn').addEventListener('click', () => {
  const name = $('scName').value.trim();
  const target = $('scTarget').value.trim();
  if (!name || !target) { toast('请填写名称和目标'); return; }
  const data = {
    name,
    kind: $('scKind').value,
    target,
    icon: $('scIcon').value.trim() || '🔹',
    color: $('scColor').value,
  };
  const group = store.groups.find((g) => g.id === editingShortcut.groupId);
  if (!group) { closeModal('shortcutModal'); return; }
  if (editingShortcut.id) {
    const s = group.shortcuts.find((x) => x.id === editingShortcut.id);
    if (s) Object.assign(s, data);
  } else {
    group.shortcuts.push({ id: uid('s'), ...data });
  }
  save();
  renderGroups();
  closeModal('shortcutModal');
});

// ---------- 事件：待办 ----------
$('addTodoBtn').addEventListener('click', () => openTodoModal(null));

function openTodoModal(todo) {
  editingTodoId = todo?.id ?? null;
  $('todoModalTitle').textContent = todo ? '编辑待办' : '新建待办';
  $('todoTitle').value = todo?.title ?? '';
  $('todoNote').value = todo?.note ?? '';
  $('todoDue').value = tsToLocalInput(todo?.due ?? null);
  $('todoPriority').value = normalizePriority(todo?.priority);
  $('todoRemind').value = String(todo?.remindBefore ?? 0);
  openModal('todoModal');
}

$('saveTodoBtn').addEventListener('click', () => {
  const title = $('todoTitle').value.trim();
  if (!title) { toast('请输入待办标题'); return; }
  const dueVal = $('todoDue').value;
  const due = dueVal ? new Date(dueVal).getTime() : null;
  const data = {
    title,
    note: $('todoNote').value.trim(),
    due,
    priority: normalizePriority($('todoPriority').value),
    remindBefore: Number($('todoRemind').value),
  };
  if (editingTodoId) {
    const t = store.todos.find((x) => x.id === editingTodoId);
    if (t) {
      Object.assign(t, data);
      // 修改截止时间后允许再次提醒
      t.reminded = false;
    }
  } else {
    store.todos.push({
      id: uid('t'), ...data,
      done: false, reminded: false, createdAt: Date.now(),
    });
  }
  save();
  renderTodos();
  updateBadge();
  closeModal('todoModal');
});

$('todos').addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const t = store.todos.find((x) => x.id === toggle.dataset.toggle);
    if (t) { t.done = !t.done; save(); renderTodos(); updateBadge(); }
    return;
  }
  const edit = e.target.closest('[data-edit-todo]');
  if (edit) {
    const t = store.todos.find((x) => x.id === edit.dataset.editTodo);
    if (t) openTodoModal(t);
    return;
  }
  const del = e.target.closest('[data-del-todo]');
  if (del) {
    const id = del.dataset.delTodo;
    askConfirm('确定删除这条待办吗？', () => {
      store.todos = store.todos.filter((x) => x.id !== id);
      save(); renderTodos(); updateBadge();
    });
  }
});

$('confirmOkBtn').addEventListener('click', () => {
  if (confirmAction) confirmAction();
  confirmAction = null;
  closeModal('confirmModal');
});

// ---------- 数据目录 ----------
$('openDataDir').addEventListener('click', () => {
  invoke('open_data_dir').catch((e) => toast('打开失败：' + e));
});

// ---------- 设置 ----------
function applySettings() {
  const s = store.settings || { iconSize: 60, showNames: true };
  // 限制范围
  const size = Math.min(88, Math.max(44, Number(s.iconSize) || 60));
  document.documentElement.style.setProperty('--icon-size', size + 'px');
  document.body.classList.toggle('hide-names', s.showNames === false);
}

function loadSettingsUI() {
  const s = store.settings || { iconSize: 60, showNames: true };
  $('setIconSize').value = Math.min(88, Math.max(44, Number(s.iconSize) || 60));
  $('iconSizeLabel').textContent = `${$('setIconSize').value} px`;
  $('setShowNames').checked = s.showNames !== false;
  // 开机自启动状态从系统读取
  invoke('get_autostart')
    .then((on) => { $('setAutostart').checked = !!on; })
    .catch(() => { $('setAutostart').checked = false; });
  // 数据目录状态从后端读取
  invoke('get_data_dir_info')
    .then((info) => updateDataDirUI(info, false))
    .catch((e) => { $('dataDirHint').textContent = '读取目录信息失败：' + e; });
}

function updateDataDirUI(info, applied) {
  dataDirDefault = info.default || dataDirDefault;
  $('dataDirInput').value = info.current || '';
  $('dataDirInput').placeholder = info.default || '输入数据目录路径';
  $('resetDataDirBtn').disabled = !info.customized;
  if (applied) {
    $('dataDirHint').textContent = info.mode === 'switched'
      ? '已切换到该目录中已有的数据。'
      : '数据已复制到新目录，原文件仍保留在默认目录作为备份。';
  } else {
    $('dataDirHint').textContent = info.customized
      ? '当前使用自定义目录。点击「恢复默认」可切回应用默认目录。'
      : '当前使用默认目录。切换到空目录会复制当前数据（原文件保留备份）；选择已有 store.json 的目录则直接使用其中数据。';
  }
}

async function applyDataDir(path) {
  const value = (path || '').trim();
  if (!value) { toast('请输入数据目录路径'); return false; }
  try {
    const info = await invoke('set_data_dir', { path: value });
    // 后端可能已经切换到另一份数据，前端必须重新加载
    store = await invoke('get_store');
    renderAll();
    applySettings();
    updateDataDirUI(info, true);
    toast(info.mode === 'switched' ? '已切换到该目录的数据' : '数据已复制到新目录，设置已生效');
    return true;
  } catch (e) {
    toast('设置数据目录失败：' + e);
    return false;
  }
}

$('pickDataDirBtn').addEventListener('click', async () => {
  try {
    const picked = await invoke('pick_data_dir');
    if (picked) {
      $('dataDirInput').value = picked;
      toast('已选择目录，点击「应用」生效');
    }
  } catch (e) {
    toast('选择目录失败：' + e);
  }
});

$('applyDataDirBtn').addEventListener('click', () => applyDataDir($('dataDirInput').value));

$('openDataDirBtn').addEventListener('click', () => {
  invoke('open_data_dir').catch((e) => toast('打开失败：' + e));
});

$('resetDataDirBtn').addEventListener('click', () => {
  if (dataDirDefault) applyDataDir(dataDirDefault);
  else toast('无法获取默认目录');
});

function updateSettings(patch) {
  store.settings = { iconSize: 60, showNames: true, ...(store.settings || {}), ...patch };
  applySettings();
  save();
}

$('openSettings').addEventListener('click', () => {
  loadSettingsUI();
  openModal('settingsModal');
});

$('setIconSize').addEventListener('input', (e) => {
  const size = Number(e.target.value);
  $('iconSizeLabel') && ($('iconSizeLabel').textContent = `${size} px`);
  updateSettings({ iconSize: size });
});

$('setShowNames').addEventListener('change', (e) => {
  updateSettings({ showNames: e.target.checked });
});

$('setAutostart').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  invoke('set_autostart', { enabled })
    .then(() => toast(enabled ? '已开启开机自启动' : '已关闭开机自启动'))
    .catch((err) => {
      e.target.checked = !enabled; // 失败时回滚开关
      toast('设置开机自启动失败：' + err);
    });
});

// ---------- 从系统拖入文件创建快捷方式 ----------
async function setupFileDrop() {
  try {
    const webview = getCurrentWebview();
    await webview.onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === 'enter' || p.type === 'over') {
        fileDragActive = true;
        const dpr = window.devicePixelRatio || 1;
        const cssX = (p.position?.x ?? 0) / dpr;
        const cssY = (p.position?.y ?? 0) / dpr;
        const el = document.elementFromPoint(cssX, cssY);
        const grp = el?.closest?.('.group');
        dropTargetGroupId = grp?.dataset?.group
          ?? store.groups[0]?.id
          ?? null;
        const g = store.groups.find((x) => x.id === dropTargetGroupId);
        $('dropHint').textContent = g ? `将添加到「${g.name}」` : '请先创建一个分组';
        $('dropOverlay').classList.remove('hidden');
        if (grp) {
          document.querySelectorAll('.drop-group-target').forEach((x) => x.classList.remove('drop-group-target'));
          grp.classList.add('drop-group-target');
        }
      } else if (p.type === 'drop') {
        handleFileDrop(p.paths || []);
      } else if (p.type === 'leave') {
        resetFileDrop();
      }
    });
  } catch (e) {
    console.warn('文件拖放监听注册失败:', e);
  }
}

function resetFileDrop() {
  fileDragActive = false;
  dropTargetGroupId = null;
  $('dropOverlay').classList.add('hidden');
  document.querySelectorAll('.drop-group-target').forEach((x) => x.classList.remove('drop-group-target'));
}

async function handleFileDrop(paths) {
  const droppedTarget = dropTargetGroupId;
  resetFileDrop();
  if (!paths.length) return;
  if (currentView !== 'launcher') {
    toast('请切换到「快捷方式」页再拖入');
    return;
  }
  let targetId = droppedTarget || store.groups[0]?.id;
  if (!targetId) { toast('请先创建一个分组'); return; }

  try {
    const newItems = await invoke('shortcuts_from_paths', { paths });
    const group = store.groups.find((g) => g.id === targetId);
    if (!group) { toast('目标分组不存在'); return; }
    group.shortcuts.push(...newItems);
    save();
    renderGroups();
    toast(`已添加 ${newItems.length} 个快捷方式到「${group.name}」`);
  } catch (e) {
    toast('添加失败：' + e);
  }
}

// ---------- 窗口控制 ----------
function setupWindowControls() {
  const win = getCurrentWindow();
  $('winMin')?.addEventListener('click', () => win.minimize());
  $('winMax')?.addEventListener('click', () => win.toggleMaximize());
  $('winClose')?.addEventListener('click', () => win.close());
}

// ---------- 后端事件 ----------
listen('todo-due', (event) => {
  // 后端已弹窗提醒；这里刷新列表以更新到期高亮和红点
  renderTodos();
  updateBadge();
  toast(`⏰ 有 ${event.payload} 条待办到期了！`);
});

// ---------- 初始化 ----------
async function init() {
  try {
    store = await invoke('get_store');
  } catch (e) {
    toast('加载数据失败：' + e);
    store = { groups: [], todos: [] };
  }
  renderAll();
  applySettings();
  setupWindowControls();
  setupFileDrop();
  // 每分钟刷新一次相对时间显示
  setInterval(() => { if (currentView === 'todos') renderTodos(); }, 60000);
}

init();
