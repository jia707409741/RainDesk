import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ---------- 全局状态 ----------
let store = { groups: [], todos: [], memos: [] };
let currentView = 'launcher';
let todoFilter = 'pending'; // 默认展示"进行中"
let selectedTodoIds = new Set(); // 批量删除：已勾选的待办 id
let visibleTodoIds = [];         // 当前筛选下可见的待办 id（用于全选）
let editingGroupId = null;
let editingShortcut = null; // { groupId, id }
let editingTodoId = null;
let editingMemoId = null;
let detailTodoId = null; // 详情弹窗当前展示的待办 id
let confirmAction = null;
let dataDirDefault = ''; // 应用默认数据目录，用于“恢复默认”

// 拖拽状态（纯鼠标事件：内部排序/跨组）
let mouseDrag = null; // { type, id, groupId, startX, startY, active, plan, ghost, source }
let suppressClick = false; // 拖拽结束后抑制一次 click / dblclick，避免误启动
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
    container.innerHTML = `<div class="empty"><span class="empty-icon"><svg class="ico" style="font-size:1em"><use href="#i-grid"/></svg></span>还没有分组，点击右上角「新建分组」开始吧</div>`;
    return;
  }
  container.innerHTML = store.groups.map((g) => {
    const shortcuts = g.shortcuts.map((s) => `
      <div class="shortcut" data-launch="${escapeHtml(s.id)}" data-sc="${escapeHtml(s.id)}" data-group="${escapeHtml(g.id)}" title="${escapeHtml(s.name)}（双击启动）">
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
            <button class="icon-btn" data-edit-group="${escapeHtml(g.id)}" title="编辑分组"><svg class="ico"><use href="#i-pencil"/></svg></button>
            <button class="icon-btn danger" data-del-group="${escapeHtml(g.id)}" title="删除分组"><svg class="ico"><use href="#i-trash"/></svg></button>
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
// 同步独立操作栏（办结/编辑/删除）的可用状态、提示文案，以及"全选"复选框状态
function updateTodoToolbar() {
  const n = selectedTodoIds.size;
  $('finishSelectedBtn').disabled = n === 0;
  $('editSelectedBtn').disabled = n !== 1; // 编辑仅对单条生效
  $('deleteSelectedBtn').disabled = n === 0;
  $('toolbarHint').textContent = n > 0 ? `已选中 ${n} 条待办` : '勾选待办后可执行操作';
  const box = $('selectAllTodo');
  if (box) {
    const all = visibleTodoIds.length > 0 && visibleTodoIds.every((id) => selectedTodoIds.has(id));
    const some = visibleTodoIds.some((id) => selectedTodoIds.has(id));
    box.checked = all;
    box.indeterminate = !all && some;
  }
}

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

  visibleTodoIds = list.map((t) => t.id);
  // 清掉已不存在的待办的选择，避免残留
  const existing = new Set(store.todos.map((t) => t.id));
  for (const id of selectedTodoIds) if (!existing.has(id)) selectedTodoIds.delete(id);

  if (list.length === 0) {
    container.innerHTML = `<div class="empty"><span class="empty-icon"><svg class="ico" style="font-size:1em"><use href="#i-check-square"/></svg></span>这里空空如也，添加一个待办吧</div>`;
  } else {
    container.innerHTML = list.map((t) => {
      const state = dueState(t);
      const stateClass = state ? ` ${state}` : '';
      const priority = normalizePriority(t.priority);
      const remindText = t.remindBefore > 0 ? `提前 ${t.remindBefore} 分钟` : '准时提醒';
      const selected = selectedTodoIds.has(t.id);
      const noteLine = t.note ? `<div class="todo-note" title="${escapeHtml(t.note)}">${escapeHtml(t.note)}</div>` : '';
      return `
      <div class="todo${stateClass}${t.done ? ' done' : ''}${selected ? ' selected' : ''}" data-todo="${escapeHtml(t.id)}">
        <input type="checkbox" class="todo-select" data-select-todo="${escapeHtml(t.id)}" ${selected ? 'checked' : ''} title="勾选该待办（仅选择，不改状态）" />
        <div class="todo-body">
          <div class="todo-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
          ${noteLine}
          <div class="todo-meta">
            <span class="priority-tag p-${priority}">${PRIORITY_LABEL[priority]}</span>
            <span class="todo-due"><svg class="ico"><use href="#i-clock"/></svg>${formatDue(t.due)}${t.due != null && !t.done ? ' · ' + timeLeftText(t) : ''}</span>
            ${t.due != null ? `<span class="remind-tag">${remindText}</span>` : ''}
            ${t.done ? '<span class="done-tag">✓ 已完成</span>' : ''}
          </div>
        </div>
        <button class="todo-detail-btn" data-detail="${escapeHtml(t.id)}" title="查看详情">详情<svg class="ico"><use href="#i-chevron-right"/></svg></button>
      </div>`;
    }).join('');
  }
  updateTodoToolbar();
}

function updateBadge() {
  const count = store.todos.filter((t) => !t.done).length;
  const badge = $('todoBadge');
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
}

// ---------- 渲染：备忘录 ----------
function memoUpdatedAt(m) {
  return m.updatedAt || m.createdAt || 0;
}

function formatMemoTime(ts) {
  if (!ts) return '刚刚';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function memoMode() {
  return store.settings?.memoView === 'list' ? 'list' : 'card';
}

function sortedMemos() {
  return (store.memos || []).slice().sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return memoUpdatedAt(b) - memoUpdatedAt(a);
  });
}

// 搜索：默认同时搜索标题和内容；支持「标题:」「内容:」（或 title:/content:）限定范围
function memoSearchState() {
  const raw = ($('memoSearch')?.value || '').trim();
  let field = 'all';
  let query = raw;
  const scoped = raw.match(/^(标题|内容|title|content)\s*[:：]\s*([\s\S]*)$/i);
  if (scoped) {
    field = ['标题', 'title'].includes(scoped[1].toLowerCase()) ? 'title' : 'content';
    query = scoped[2].trim();
  }
  return { raw, field, query, needle: query.toLocaleLowerCase() };
}

function memoMatches(m, s) {
  if (!s.needle) return true;
  const title = String(m.title || '').toLocaleLowerCase();
  const content = String(m.content || '').toLocaleLowerCase();
  if (s.field === 'title') return title.includes(s.needle);
  if (s.field === 'content') return content.includes(s.needle);
  return title.includes(s.needle) || content.includes(s.needle);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMemoText(text, needle, enabled) {
  const raw = String(text ?? '');
  if (!needle || !enabled) return escapeHtml(raw);
  const re = new RegExp(escapeRegExp(needle), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (m[0] === '') re.lastIndex++;
  }
  return out + escapeHtml(raw.slice(last));
}

// 内容命中位置在预览范围之外时，改为展示命中处附近的片段
function memoPreview(m, s) {
  const content = (m.content || '').trim();
  if (s.needle && s.field !== 'title') {
    const idx = content.toLocaleLowerCase().indexOf(s.needle);
    if (idx > 300) {
      const start = Math.max(0, idx - 60);
      const end = idx + s.needle.length + 120;
      return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
    }
  }
  return content.length > 300 ? content.slice(0, 300) + '…' : content;
}

function applyMemoViewUI() {
  const mode = memoMode();
  const box = $('memos');
  if (box) {
    box.classList.toggle('card', mode === 'card');
    box.classList.toggle('list', mode === 'list');
  }
  document.querySelectorAll('[data-memo-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.memoView === mode);
  });
}

function renderMemos() {
  const box = $('memos');
  if (!box) return;
  applyMemoViewUI();
  const s = memoSearchState();
  const all = sortedMemos();
  const memos = all.filter((m) => memoMatches(m, s));
  const countEl = $('memoSearchCount');
  if (countEl) countEl.textContent = s.query ? `找到 ${memos.length} / ${all.length} 条` : (all.length ? `共 ${all.length} 条` : '');
  const clearBtn = $('memoSearchClear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !s.raw);
  if (memos.length === 0) {
    const msg = all.length === 0
      ? '还没有备忘录，点击右上角「新建备忘录」开始吧'
      : `没有找到匹配的备忘录（关键词：${escapeHtml(s.query)}）`;
    box.innerHTML = `<div class="empty memo-empty"><span class="empty-icon"><svg class="ico" style="font-size:1em"><use href="#i-note"/></svg></span>${msg}</div>`;
    return;
  }
  box.innerHTML = memos.map((m) => {
    const pinned = !!m.pinned;
    const id = escapeHtml(m.id);
    const content = (m.content || '').trim();
    const preview = memoPreview(m, s);
    const updated = formatMemoTime(memoUpdatedAt(m));
    return `
    <article class="memo${pinned ? ' pinned' : ''}" data-memo="${id}">
      <div class="memo-head">
        <div class="memo-title" title="${escapeHtml(m.title || '')}">${highlightMemoText(m.title || '未命名备忘录', s.needle, s.field !== 'content')}</div>
        <button class="memo-pin${pinned ? ' on' : ''}" data-memo-pin="${id}" title="${pinned ? '取消置顶' : '置顶'}" aria-label="${pinned ? '取消置顶' : '置顶'}"><svg class="ico"><use href="#i-pin"/></svg></button>
      </div>
      <div class="memo-content" title="${escapeHtml(content)}">${highlightMemoText(preview, s.needle, s.field !== 'title') || '（空）'}</div>
      <div class="memo-foot">
        <span class="memo-time">${pinned ? '📌 已置顶 · ' : ''}更新于 ${updated}</span>
        <div class="memo-actions">
          <button class="memo-act" data-memo-export="${id}" title="导出这一条"><svg class="ico"><use href="#i-export"/></svg></button>
          <button class="memo-act" data-memo-edit="${id}" title="编辑"><svg class="ico"><use href="#i-pencil"/></svg></button>
          <button class="memo-act danger" data-memo-delete="${id}" title="删除"><svg class="ico"><use href="#i-trash"/></svg></button>
        </div>
      </div>
    </article>`;
  }).join('');
}

function renderAll() {
  renderGroups();
  renderTodos();
  renderMemos();
  updateBadge();
}

// ---------- 弹窗控制 ----------
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) {
  $(id).classList.add('hidden');
  // 关闭设置弹窗时若仍在录制快捷键，取消录制并恢复原快捷键注册
  if (id === 'settingsModal' && recordingHotkey) {
    const s = store.settings || {};
    invoke('set_shortcuts', {
      toggle: s.toggleShortcut || 'Ctrl+Shift+R',
      newTodo: s.newTodoShortcut || 'Ctrl+Shift+T',
    }).catch(() => {});
    stopRecording();
  }
}

function askConfirm(text, action) {
  $('confirmText').textContent = text;
  confirmAction = action;
  openModal('confirmModal');
}

// ---------- 事件：导航 ----------
function switchView(view) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  currentView = view;
  $('view-launcher').classList.toggle('hidden', currentView !== 'launcher');
  $('view-todos').classList.toggle('hidden', currentView !== 'todos');
  $('view-memos').classList.toggle('hidden', currentView !== 'memos');
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    todoFilter = btn.dataset.filter;
    selectedTodoIds.clear(); // 切换筛选时清空勾选，避免误删其他分页的待办
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
});

// 双击启动快捷方式（单击只选中/不启动，与拖拽排序共存）
$('groups').addEventListener('dblclick', (e) => {
  if (suppressClick) return; // 拖拽刚结束，忽略这次双击
  if (e.target.closest('button')) return; // 删除按钮等不触发启动
  const launch = e.target.closest('[data-launch]');
  if (!launch) return;
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
  suppressClick = true;  // 抑制拖拽后的 click / dblclick（避免误启动）
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
    icon: $('scIcon').value.trim() || '◇',
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
  const title = $('todoTitle').value.trim().slice(0, 20);
  if (!title) { toast('请输入待办标题'); return; }
  const dueVal = $('todoDue').value;
  const due = dueVal ? new Date(dueVal).getTime() : null;
  const data = {
    title,
    note: $('todoNote').value.trim().slice(0, 500),
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

// 点击待办右下角"详情"按钮打开详情弹窗
$('todos').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-detail]');
  if (!btn) return;
  openTodoDetail(btn.dataset.detail);
});

function openTodoDetail(id) {
  const t = store.todos.find((x) => x.id === id);
  if (!t) return;
  detailTodoId = id;
  const priority = normalizePriority(t.priority);
  const dueText = t.due != null ? formatDue(t.due) : '无截止时间';
  const remindText = t.remindBefore > 0 ? `提前 ${t.remindBefore} 分钟` : '准时提醒';
  $('detailModalTitle').textContent = t.done ? '待办详情（已完成）' : '待办详情';
  $('detailTitle').textContent = t.title;
  $('detailTitle').title = t.title;
  $('detailNote').textContent = t.note || '（无备注）';
  $('detailNote').title = t.note || '';
  $('detailDue').textContent = dueText;
  $('detailDue').title = dueText;
  $('detailPriority').textContent = PRIORITY_LABEL[priority];
  $('detailRemind').textContent = remindText;
  const finishBtn = $('detailFinishBtn');
  finishBtn.disabled = !!t.done;
  finishBtn.innerHTML = `<svg class="ico"><use href="#i-check"/></svg> ${t.done ? '已办结' : '办结'}`;
  openModal('todoDetailModal');
}

// 详情弹窗 · 编辑：打开编辑弹窗，保存后自动关闭详情
$('detailEditBtn').addEventListener('click', () => {
  const t = store.todos.find((x) => x.id === detailTodoId);
  if (!t) return;
  closeModal('todoDetailModal');
  openTodoModal(t);
});

// 详情弹窗 · 办结：将该待办设为已完成
$('detailFinishBtn').addEventListener('click', () => {
  const t = store.todos.find((x) => x.id === detailTodoId);
  if (t && !t.done) {
    t.done = true;
    t.reminded = true;
    selectedTodoIds.delete(t.id);
    save(); renderTodos(); updateBadge();
    toast('已办结');
  }
  closeModal('todoDetailModal');
});

// 复选框勾选：仅维护选择集，绝不改变待办状态
$('todos').addEventListener('change', (e) => {
  const box = e.target.closest('[data-select-todo]');
  if (!box) return;
  const id = box.dataset.selectTodo;
  if (box.checked) selectedTodoIds.add(id);
  else selectedTodoIds.delete(id);
  const row = box.closest('.todo');
  if (row) row.classList.toggle('selected', box.checked);
  updateTodoToolbar();
});

// 全选 / 取消全选当前筛选下的待办（同样只影响选择集）
$('selectAllTodo').addEventListener('change', (e) => {
  const checked = e.target.checked;
  for (const id of visibleTodoIds) {
    if (checked) selectedTodoIds.add(id);
    else selectedTodoIds.delete(id);
  }
  document.querySelectorAll('[data-select-todo]').forEach((box) => {
    box.checked = checked;
    const row = box.closest('.todo');
    if (row) row.classList.toggle('selected', checked);
  });
  updateTodoToolbar();
});

// 操作栏 · 办结：将选中的待办状态设为已完成
$('finishSelectedBtn').addEventListener('click', () => {
  const n = selectedTodoIds.size;
  if (n === 0) { toast('请先勾选要办结的待办'); return; }
  let done = 0;
  for (const t of store.todos) {
    if (selectedTodoIds.has(t.id) && !t.done) {
      t.done = true;
      t.reminded = true; // 办结后不再提醒
      done++;
    }
  }
  selectedTodoIds.clear();
  save(); renderTodos(); updateBadge();
  toast(done > 0 ? `已办结 ${done} 条待办` : '选中的待办均已完成');
});

// 操作栏 · 编辑：仅对单条选中项生效
$('editSelectedBtn').addEventListener('click', () => {
  if (selectedTodoIds.size !== 1) { toast('请仅勾选一条待办进行编辑'); return; }
  const id = [...selectedTodoIds][0];
  const t = store.todos.find((x) => x.id === id);
  if (t) openTodoModal(t);
});

// 操作栏 · 删除：删除所有已勾选的待办
$('deleteSelectedBtn').addEventListener('click', () => {
  const n = selectedTodoIds.size;
  if (n === 0) { toast('请先勾选要删除的待办'); return; }
  askConfirm(`确定删除选中的 ${n} 条待办吗？此操作不可撤销。`, () => {
    store.todos = store.todos.filter((t) => !selectedTodoIds.has(t.id));
    selectedTodoIds.clear();
    save(); renderTodos(); updateBadge();
    toast(`已删除 ${n} 条待办`);
  });
});

$('confirmOkBtn').addEventListener('click', () => {
  if (confirmAction) confirmAction();
  confirmAction = null;
  closeModal('confirmModal');
});

// ---------- 备忘录 ----------
function openMemoModal(memo) {
  editingMemoId = memo?.id ?? null;
  $('memoModalTitle').textContent = memo ? '编辑备忘录' : '新建备忘录';
  $('memoTitle').value = memo?.title ?? '';
  $('memoContent').value = memo?.content ?? '';
  openModal('memoModal');
  $('memoTitle').focus();
}

$('addMemoBtn').addEventListener('click', () => openMemoModal(null));

$('memoSearch').addEventListener('input', renderMemos);
$('memoSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('memoSearch').value) {
    e.stopPropagation();
    $('memoSearch').value = '';
    renderMemos();
  }
});
$('memoSearchClear').addEventListener('click', () => {
  $('memoSearch').value = '';
  renderMemos();
  $('memoSearch').focus();
});

$('saveMemoBtn').addEventListener('click', () => {
  const title = $('memoTitle').value.trim().slice(0, 40);
  const content = $('memoContent').value.trim().slice(0, 5000);
  if (!title && !content) { toast('请输入标题或内容'); return; }
  const now = Date.now();
  if (editingMemoId) {
    const m = (store.memos || []).find((x) => x.id === editingMemoId);
    if (m) {
      m.title = title || '未命名备忘录';
      m.content = content;
      m.updatedAt = now;
    }
  } else {
    (store.memos ||= []).push({
      id: uid('m'),
      title: title || '未命名备忘录',
      content,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    });
  }
  save();
  renderMemos();
  closeModal('memoModal');
  toast(editingMemoId ? '备忘录已更新' : '备忘录已创建');
});

// 卡片 / 列表切换（写入 settings 持久化）
$('memoViewSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-memo-view]');
  if (!btn) return;
  const mode = btn.dataset.memoView === 'list' ? 'list' : 'card';
  if (mode === memoMode()) return;
  updateSettings({ memoView: mode });
  renderMemos();
});

// 置顶 / 编辑 / 删除 / 单条导出
$('memos').addEventListener('click', (e) => {
  const pinBtn = e.target.closest('[data-memo-pin]');
  const editBtn = e.target.closest('[data-memo-edit]');
  const delBtn = e.target.closest('[data-memo-delete]');
  const exportBtn = e.target.closest('[data-memo-export]');
  const id = pinBtn?.dataset.memoPin || editBtn?.dataset.memoEdit
    || delBtn?.dataset.memoDelete || exportBtn?.dataset.memoExport;
  if (!id) return;
  const m = (store.memos || []).find((x) => x.id === id);
  if (!m) return;

  if (pinBtn) {
    m.pinned = !m.pinned;
    save();
    renderMemos();
    toast(m.pinned ? '已置顶' : '已取消置顶');
  } else if (editBtn) {
    openMemoModal(m);
  } else if (delBtn) {
    askConfirm(`确定删除备忘录「${m.title || '未命名备忘录'}」吗？此操作不可撤销。`, () => {
      store.memos = (store.memos || []).filter((x) => x.id !== id);
      save();
      renderMemos();
      toast('备忘录已删除');
    });
  } else if (exportBtn) {
    exportMemoFile([m], `${m.title || '备忘录'}.md`);
  }
});

function memoToMarkdown(m) {
  const updated = formatMemoTime(memoUpdatedAt(m));
  const pin = m.pinned ? '> 📌 已置顶\n\n' : '';
  return `## ${m.title || '未命名备忘录'}\n\n${pin}${m.content || ''}\n\n_更新于 ${updated}_\n`;
}

async function exportMemoFile(list, fileName) {
  if (!list.length) { toast('没有可导出的备忘录'); return; }
  const content = `# RainDesk 备忘录\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n---\n\n`
    + list.map(memoToMarkdown).join('\n---\n\n');
  try {
    const path = await invoke('export_memos', { content, defaultFileName: fileName });
    if (path) toast('已导出到：' + path);
  } catch (e) {
    toast('导出失败：' + e);
  }
}

$('exportMemosBtn').addEventListener('click', () => {
  exportMemoFile(sortedMemos(), 'RainDesk-备忘录.md');
});

// ---------- 数据目录 ----------
$('openDataDir').addEventListener('click', () => {
  invoke('open_data_dir').catch((e) => toast('打开失败：' + e));
});

// ---------- 设置 ----------
function currentTheme() {
  return store.settings?.theme === 'light' ? 'light' : 'dark';
}

// 应用主题到界面，并同步两个切换按钮的显示
function applyTheme() {
  const theme = currentTheme();
  const light = theme === 'light';
  document.body.classList.toggle('theme-light', light);
  // 标题栏按钮：显示当前主题对应的图标与提示
  const top = $('themeToggleTop');
  if (top) {
    top.innerHTML = `<svg class="ico"><use href="#i-${light ? 'sun' : 'moon'}"/></svg>`;
    top.title = light ? '当前：日间主题（点击切换夜间）' : '当前：夜间主题（点击切换日间）';
  }
  // 设置面板按钮
  const setIcon = $('setThemeIcon');
  const setText = $('setThemeText');
  const setLabel = $('themeLabel');
  if (setIcon) setIcon.innerHTML = `<svg class="ico"><use href="#i-${light ? 'sun' : 'moon'}"/></svg>`;
  if (setText) setText.textContent = light ? '日间' : '夜间';
  if (setLabel) setLabel.textContent = light ? '日间模式' : '夜间模式';
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  updateSettings({ theme: next });
  toast(next === 'light' ? '已切换到日间主题' : '已切换到夜间主题');
}

function applySettings() {
  const s = store.settings || { iconSize: 60, showNames: true };
  // 限制范围
  const size = Math.min(88, Math.max(44, Number(s.iconSize) || 60));
  document.documentElement.style.setProperty('--icon-size', size + 'px');
  document.body.classList.toggle('hide-names', s.showNames === false);
  applyTheme();
  applyMemoViewUI();
  // 启动时把按钮文字同步为真实注册的快捷键，
  // 否则界面一直显示 HTML 里的默认值，用户按显示值会以为快捷键失效。
  updateHotkeyButtons();
}

function loadSettingsUI() {
  const s = store.settings || { iconSize: 60, showNames: true };
  $('setIconSize').value = Math.min(88, Math.max(44, Number(s.iconSize) || 60));
  $('iconSizeLabel').textContent = `${$('setIconSize').value} px`;
  $('setShowNames').checked = s.showNames !== false;
  applyTheme();
  updateHotkeyButtons();
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
  store.settings = { iconSize: 60, showNames: true, theme: 'dark', ...(store.settings || {}), ...patch };
  applySettings();
  save();
}

$('openSettings').addEventListener('click', () => {
  loadSettingsUI();
  openModal('settingsModal');
});

// 主题切换：标题栏右上角 + 设置面板内，两处共用同一逻辑
$('themeToggleTop')?.addEventListener('click', toggleTheme);
$('setTheme')?.addEventListener('click', toggleTheme);

// ---------- 快捷键设置 ----------
// 把 KeyboardEvent 转成 global-hotkey 可解析的字符串，如 "Ctrl+Shift+R"
const DEFAULT_TOGGLE_HOTKEY = 'Ctrl+Shift+R';
const DEFAULT_NEW_TODO_HOTKEY = 'Ctrl+Shift+T';

// 记录当前正在录制哪个快捷键：'toggle' | 'newTodo' | null
let recordingHotkey = null;

function formatHotkey(str) {
  return (str || '').split('+').map((s) => s.trim()).filter(Boolean).join(' + ');
}

function updateHotkeyButtons() {
  const s = store.settings || {};
  const t = $('hotkeyToggle');
  const n = $('hotkeyNewTodo');
  if (t && recordingHotkey !== 'toggle') t.textContent = formatHotkey(s.toggleShortcut || DEFAULT_TOGGLE_HOTKEY);
  if (n && recordingHotkey !== 'newTodo') n.textContent = formatHotkey(s.newTodoShortcut || DEFAULT_NEW_TODO_HOTKEY);
}

// 把按键编码映射为解析器认可的名称
function codeToKeyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);      // KeyR -> R
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);    // Digit1 -> 1
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;  // F1..F24
  const map = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/',
    Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Backquote: '`',
  };
  return map[code] || null;
}

// 从按键事件构建热键字符串；返回 null 表示只有修饰键/不支持
function buildHotkey(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const key = codeToKeyName(e.code);
  if (!key) return null;               // 仅按了修饰键，继续等待
  if (mods.length === 0) return { error: '必须包含 Ctrl / Alt / Shift / Win 修饰键' };
  return { hotkey: [...mods, key].join('+') };
}

function startRecording(which) {
  if (recordingHotkey) return;
  recordingHotkey = which;
  const btn = which === 'toggle' ? $('hotkeyToggle') : $('hotkeyNewTodo');
  btn.classList.add('recording');
  btn.textContent = '请按下组合键…';
  // 录制期间先注销全局快捷键，避免旧组合触发主面板显示/隐藏
  invoke('suspend_shortcuts').catch(() => {});
}

function stopRecording() {
  recordingHotkey = null;
  $('hotkeyToggle').classList.remove('recording');
  $('hotkeyNewTodo').classList.remove('recording');
  updateHotkeyButtons();
}

async function applyHotkey(which, hotkey) {
  const s = store.settings || {};
  const toggle = which === 'toggle' ? hotkey : (s.toggleShortcut || DEFAULT_TOGGLE_HOTKEY);
  const newTodo = which === 'newTodo' ? hotkey : (s.newTodoShortcut || DEFAULT_NEW_TODO_HOTKEY);
  if (toggle === newTodo) {
    toast('两个快捷键不能相同');
    // 重新注册回原快捷键
    invoke('set_shortcuts', {
      toggle: s.toggleShortcut || DEFAULT_TOGGLE_HOTKEY,
      newTodo: s.newTodoShortcut || DEFAULT_NEW_TODO_HOTKEY,
    }).catch(() => {});
    return false;
  }
  try {
    await invoke('set_shortcuts', { toggle, newTodo });
    store.settings = { ...s, toggleShortcut: toggle, newTodoShortcut: newTodo };
    updateHotkeyButtons();
    toast(`快捷键已更新：${formatHotkey(hotkey)}`);
    return true;
  } catch (e) {
    toast('设置快捷键失败：' + e);
    // 后端已回滚到旧快捷键
    return false;
  }
}

$('hotkeyToggle')?.addEventListener('click', () => startRecording('toggle'));
$('hotkeyNewTodo')?.addEventListener('click', () => startRecording('newTodo'));

$('resetHotkeysBtn')?.addEventListener('click', async () => {
  const ok = await applyHotkey('toggle', DEFAULT_TOGGLE_HOTKEY);
  if (ok) {
    await applyHotkey('newTodo', DEFAULT_NEW_TODO_HOTKEY);
    updateHotkeyButtons();
    toast('已恢复默认快捷键');
  }
});

// 录制态键盘监听（捕获阶段，优先于其他处理）
document.addEventListener('keydown', async (e) => {
  if (!recordingHotkey) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    // 取消录制：恢复原快捷键注册
    const s = store.settings || {};
    invoke('set_shortcuts', {
      toggle: s.toggleShortcut || DEFAULT_TOGGLE_HOTKEY,
      newTodo: s.newTodoShortcut || DEFAULT_NEW_TODO_HOTKEY,
    }).catch(() => {});
    stopRecording();
    toast('已取消快捷键录制');
    return;
  }
  const r = buildHotkey(e);
  if (!r) return;               // 仅修饰键，继续等待
  if (r.error) { toast(r.error); return; }
  const which = recordingHotkey;
  stopRecording();
  await applyHotkey(which, r.hotkey);
  updateHotkeyButtons();
}, true);

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
  toast(`有 ${event.payload} 条待办到期了`);
});

// 全局快捷键 Ctrl+Shift+T：切到待办视图并打开新建待办弹窗
listen('quick-new-todo', () => {
  switchView('todos');
  openTodoModal(null);
  $('todoTitle')?.focus();
});

// ---------- 初始化 ----------
async function init() {
  try {
    store = await invoke('get_store');
  } catch (e) {
    toast('加载数据失败：' + e);
    store = { groups: [], todos: [], memos: [] };
  }
  renderAll();
  applySettings();
  setupWindowControls();
  setupFileDrop();
  // 每分钟刷新一次相对时间显示
  setInterval(() => { if (currentView === 'todos') renderTodos(); }, 60000);
}

init();
