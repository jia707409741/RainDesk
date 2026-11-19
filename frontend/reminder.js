import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

let currentTodo = null;

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDue(ts) {
  if (ts == null) return '';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function render(todo, count) {
  currentTodo = todo;
  $('todoTitle').textContent = todo.title;
  $('todoNote').textContent = todo.note || '';
  $('dueText').textContent = todo.due != null ? `🕐 截止时间：${formatDue(todo.due)}` : '⏰ 该处理了';
  $('extraCount').textContent = count > 1 ? `还有 ${count - 1} 条待办同时到期` : '到时间啦，快去处理';
}

function $(id) { return document.getElementById(id); }

function hide() {
  invoke('hide_reminder').catch(() => {});
}

// 接收后端推送的待办数据
listen('reminder-data', (event) => {
  const [todo, count] = event.payload;
  render(todo, count);
});

$('closeBtn').addEventListener('click', hide);
$('laterBtn').addEventListener('click', hide);
$('doneBtn').addEventListener('click', async () => {
  if (currentTodo) {
    try {
      await invoke('complete_todo', { id: currentTodo.id });
    } catch (_) {}
  }
  hide();
});

// 窗口关闭事件：通知后端重置标记
listen('tauri://close-requested', () => {
  invoke('noop').catch(() => {});
  hide();
});
