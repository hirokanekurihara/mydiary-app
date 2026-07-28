'use strict';

/* =========================================================
 * 日記アプリ script.js
 * ========================================================= */

/* ---------------------------------------------------------
 * 0. 共通ユーティリティ
 * --------------------------------------------------------- */
const TAGS_ALL = ['仕事', 'プライベート', '健康', 'アイデア', 'その他'];
const MOOD_EMOJI = { 1: '😢', 2: '😟', 3: '😐', 4: '🙂', 5: '😊' };

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function formatTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function todayStr() { return formatDate(new Date()); }

function showToast(msg, duration = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, duration);
}

function showError(userMsg, err) {
  if (err) console.error(userMsg, err);
  showToast('⚠️ ' + userMsg);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ---------------------------------------------------------
 * 1. IndexedDB ラッパー
 * --------------------------------------------------------- */
const DB_NAME = 'DiaryDB';
const DB_VERSION = 2;               // ★ 1 → 2 に変更
const STORE_NAME = 'entries';
const THOUGHT_STORE = 'thoughts';   // ★ 追加


let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) { resolve(dbInstance); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_date', 'date', { unique: false });
        store.createIndex('by_date_seq', ['date', 'seq'], { unique: true });
      }
      // ★思考記録用ストア：dateを主キーにすることで「一日一件」を自動保証する
if (!db.objectStoreNames.contains(THOUGHT_STORE)) {
  db.createObjectStore(THOUGHT_STORE, { keyPath: 'date' });
}
};

    req.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    req.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

async function dbGetAllEntries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetEntriesByDate(dateStr) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('by_date');
    const range = IDBKeyRange.only(dateStr);
    const req = idx.getAll(range);
    req.onsuccess = () => {
      const rows = (req.result || []).sort((a, b) => a.seq - b.seq);
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbGetMaxSeqForDate(dateStr) {
  const rows = await dbGetEntriesByDate(dateStr);
  if (rows.length === 0) return 0;
  return Math.max(...rows.map((r) => r.seq || 0));
}

async function dbAddEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDeleteEntry(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbClearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbBulkAdd(entries) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    entries.forEach((e) => {
      // idはautoIncrementの新規採番に任せる（重複キー衝突回避のため元idは保持しない）
      const clone = Object.assign({}, e);
      delete clone.id;
      store.add(clone);
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------------------------------------------------
 * 2. PINロック機能
 * --------------------------------------------------------- */
const PIN_KEY = 'diary_pin';
const PIN_FAIL_COUNT_KEY = 'diary_pin_fail_count';
const PIN_LOCK_UNTIL_KEY = 'diary_pin_lock_until';
const MAX_FAIL = 3;
const LOCK_DURATION_MS = 30 * 1000;

const pinState = {
  mode: null,       // 'setup1' | 'setup2' | 'verify'
  firstPin: null,
  current: '',
  lockTimerId: null
};

function getSavedPin() { return localStorage.getItem(PIN_KEY); }
function getFailCount() { return parseInt(localStorage.getItem(PIN_FAIL_COUNT_KEY) || '0', 10); }
function setFailCount(n) { localStorage.setItem(PIN_FAIL_COUNT_KEY, String(n)); }
function getLockUntil() {
  const v = localStorage.getItem(PIN_LOCK_UNTIL_KEY);
  return v ? parseInt(v, 10) : 0;
}
function setLockUntil(ts) {
  if (ts) localStorage.setItem(PIN_LOCK_UNTIL_KEY, String(ts));
  else localStorage.removeItem(PIN_LOCK_UNTIL_KEY);
}

function initPinScreen() {
  const savedPin = getSavedPin();
  pinState.current = '';
  pinState.firstPin = null;
  bioFailCount = 0; // アプリを開くたびにリセット

  const lockUntil = getLockUntil();
  if (lockUntil && lockUntil > Date.now()) {
    startLockCountdown(lockUntil);
  } else {
    setLockUntil(0);
  }

  if (savedPin) {
    pinState.mode = 'verify';
    const bioCredId = localStorage.getItem(BIO_CRED_ID_KEY);
    const bioAvailable = !!(bioCredId && window.PublicKeyCredential && window.isSecureContext);

   if (bioAvailable && !isPinLocked()) {
  setPinScreenUI('bio');
  document.getElementById('pin-message').textContent = 'Face ID / Touch ID で認証しています…';
  setTimeout(() => { triggerBiometricAuth(); }, 400);
} else {
  setPinScreenUI('pin');
  document.getElementById('pin-title').textContent = 'PINコードを入力';
  document.getElementById('pin-message').textContent = '4桁のPINを入力してください';
}


  } else {
    pinState.mode = 'setup1';
    setPinScreenUI('pin');
    document.getElementById('pin-title').textContent = 'PINコードを設定';
    document.getElementById('pin-message').textContent = '新しく使う4桁のPINを入力してください';
  }

  renderPinDots();
  bindPinKeypad();
  bindBiometricButton();
}



function bindPinKeypad() {
  const keypad = document.getElementById('pin-keypad');
  if (keypad.dataset.bound) return;
  keypad.dataset.bound = '1';
  keypad.addEventListener('click', (e) => {
    const btn = e.target.closest('.pin-key');
    if (!btn || btn.disabled) return;
    const key = btn.dataset.key;
    if (isPinLocked()) return;
    if (key === 'del') {
      pinState.current = pinState.current.slice(0, -1);
      renderPinDots();
      return;
    }
    if (pinState.current.length >= 4) return;
    pinState.current += key;
    renderPinDots();
    if (pinState.current.length === 4) {
      setTimeout(() => handlePinComplete(), 150);
    }
  });
}

function renderPinDots(errorMode = false) {
  const dots = document.querySelectorAll('#pin-dots .pin-dot');
  dots.forEach((dot, i) => {
    dot.classList.toggle('filled', i < pinState.current.length && !errorMode);
    dot.classList.toggle('error', errorMode);
  });
}

function isPinLocked() {
  const lockUntil = getLockUntil();
  return lockUntil && lockUntil > Date.now();
}

function startLockCountdown(lockUntil) {
  const keypad = document.getElementById('pin-keypad');
  const msgEl = document.getElementById('pin-lock-msg');
  keypad.querySelectorAll('.pin-key').forEach((b) => { b.disabled = true; });
  msgEl.hidden = false;

  clearInterval(pinState.lockTimerId);
  const tick = () => {
    const remain = Math.ceil((lockUntil - Date.now()) / 1000);
    if (remain <= 0) {
      clearInterval(pinState.lockTimerId);
      setLockUntil(0);
      setFailCount(0);
      msgEl.hidden = true;
      keypad.querySelectorAll('.pin-key').forEach((b) => {
        if (!b.classList.contains('pin-key-empty')) b.disabled = false;
      });
      pinState.current = '';
      renderPinDots();
    } else {
      msgEl.textContent = `あと${remain}秒で再試行可能です`;
    }
  };
  tick();
  pinState.lockTimerId = setInterval(tick, 500);
}

function handlePinComplete() {
  const entered = pinState.current;

  if (pinState.mode === 'setup1') {
    pinState.firstPin = entered;
    pinState.mode = 'setup2';
    pinState.current = '';
    document.getElementById('pin-message').textContent = 'もう一度同じPINを入力してください';
    renderPinDots();
    return;
  }

  if (pinState.mode === 'setup2') {
    if (entered === pinState.firstPin) {
      localStorage.setItem(PIN_KEY, entered);
      showToast('PINを設定しました');
      unlockApp();
    } else {
      document.getElementById('pin-message').textContent = '一致しませんでした。最初から入力してください';
      pinState.mode = 'setup1';
      pinState.firstPin = null;
      pinState.current = '';
      renderPinDots(true);
      setTimeout(() => renderPinDots(), 400);
    }
    return;
  }

  if (pinState.mode === 'verify') {
    const savedPin = getSavedPin();
    if (entered === savedPin) {
      setFailCount(0);
      setLockUntil(0);
      unlockApp();
    } else {
      const fails = getFailCount() + 1;
      setFailCount(fails);
      renderPinDots(true);
      pinState.current = '';
      if (fails >= MAX_FAIL) {
        const lockUntil = Date.now() + LOCK_DURATION_MS;
        setLockUntil(lockUntil);
        document.getElementById('pin-message').textContent = '入力を3回間違えました';
        startLockCountdown(lockUntil);
      } else {
        document.getElementById('pin-message').textContent = `PINが違います（あと${MAX_FAIL - fails}回）`;
      }
      setTimeout(() => renderPinDots(), 400);
    }
    return;
  }
}

function unlockApp() {
  document.getElementById('pin-screen').hidden = true;
  document.getElementById('app').hidden = false;
  initAppOnce();
  switchView('view-write'); // ★追加：ロック解除後は必ず「書く」タブを表示する
}


function resetPin() {
  if (!confirm('PINをリセットします。次回起動時に新しいPINを設定してください。よろしいですか？')) return;
  localStorage.removeItem(PIN_KEY);
  localStorage.removeItem(PIN_FAIL_COUNT_KEY);
  localStorage.removeItem(PIN_LOCK_UNTIL_KEY);
  showToast('PINをリセットしました。再読み込みします');
  setTimeout(() => location.reload(), 1000);
}

/* ---------------------------------------------------------
 * 3. アプリ状態
 * --------------------------------------------------------- */
const appState = {
  selectedMood: null,
  selectedTagsInput: new Set(),
  selectedTagsSearch: new Set(),
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(), // 0-indexed
  calSelectedDate: todayStr(),
  currentDetailEntry: null,
  appInitialized: false,
  lastSearchTarget: 'diary',    // ★追加：直近の検索対象（PDF出力に使う）
  lastSearchResults: []         // ★追加：直近の検索結果（PDF出力に使う）
};


/* ---------------------------------------------------------
 * 4. タブ切替
 * --------------------------------------------------------- */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const viewId = btn.dataset.view;
      switchView(viewId);
    });
  });
}

function switchView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active-view'));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(viewId).classList.add('active-view');
  document.querySelector(`.tab-btn[data-view="${viewId}"]`).classList.add('active');

  if (viewId === 'view-write') {
    // タイトル・本文がまだ空の場合のみ、現在時刻に更新する
    // （過去日付に変更して書きかけの内容がある場合は、上書きしないようにする）
    const titleEmpty = document.getElementById('entry-title').value.trim() === '';
    const bodyEmpty  = document.getElementById('entry-body').value.trim() === '';
    if (titleEmpty && bodyEmpty) {
      setEntryFormDateTime();
    }
  }
  if (viewId === 'view-list') refreshListView();
  if (viewId === 'view-calendar') refreshCalendarView();
  if (viewId === 'view-racket') {
    document.getElementById('racket-form-view').hidden = true;
    document.getElementById('racket-list-view').hidden = false;
    refreshRacketList();
  }
  if (viewId === 'view-thought') {
    showThoughtListView();
    refreshThoughtList();
  }
}



/* ---------------------------------------------------------
 * 5. 「書く」フォーム
 * --------------------------------------------------------- */
/** 「書く」フォームの日時欄に現在の日時をセットし、年月日表示も更新する */
function setEntryFormDateTime() {
  const now = new Date();
  document.getElementById('entry-date').value = formatDate(now);
  document.getElementById('entry-time').value = formatTime(now);
  updateEntryDateDisplay();
}

/** 日付入力欄の下に、日本語の年月日表示を更新する（formatDateJpは思考記録タブで定義済みの関数を再利用） */
function updateEntryDateDisplay() {
  const val = document.getElementById('entry-date').value;
  document.getElementById('entry-date-display').textContent = formatDateJp(val);
}


function initWriteForm() {
  // フォーム初期化時に現在の日時をデフォルトでセットする
  setEntryFormDateTime();

  // 日付を変更したら、下の年月日表示もリアルタイムで更新する
  document.getElementById('entry-date').addEventListener('change', updateEntryDateDisplay);

  document.getElementById('mood-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('.mood-btn');
    if (!btn) return;
    const mood = parseInt(btn.dataset.mood, 10);
    appState.selectedMood = (appState.selectedMood === mood) ? null : mood;
    renderMoodPicker();
  });

  document.getElementById('tag-chips-input').addEventListener('click', (e) => {
    const btn = e.target.closest('.tag-chip');
    if (!btn) return;
    const tag = btn.dataset.tag;
    if (appState.selectedTagsInput.has(tag)) appState.selectedTagsInput.delete(tag);
    else appState.selectedTagsInput.add(tag);
    renderTagChips('tag-chips-input', appState.selectedTagsInput);
  });

  document.getElementById('entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleSaveEntry();
  });
}


function renderMoodPicker() {
  document.querySelectorAll('#mood-picker .mood-btn').forEach((btn) => {
    const mood = parseInt(btn.dataset.mood, 10);
    btn.classList.toggle('selected', mood === appState.selectedMood);
  });
}

function renderTagChips(containerId, selectedSet) {
  document.querySelectorAll(`#${containerId} .tag-chip`).forEach((btn) => {
    btn.classList.toggle('selected', selectedSet.has(btn.dataset.tag));
  });
}

async function handleSaveEntry() {
  const dateEl  = document.getElementById('entry-date');
  const timeEl  = document.getElementById('entry-time');
  const titleEl = document.getElementById('entry-title');
  const bodyEl  = document.getElementById('entry-body');

  const date  = dateEl.value;
  const time  = timeEl.value;
  const title = titleEl.value.trim();
  const body  = bodyEl.value.trim();

  if (!date || !time) { showToast('日付と時刻を入力してください'); return; }
  if (!title || !body) { showToast('タイトルと本文を入力してください'); return; }

  try {
    // 入力された日付を基準に、その日の最大通し番号を取得して+1する
    const maxSeq = await dbGetMaxSeqForDate(date);
    const seq = maxSeq + 1;

    const entry = {
      date, time, seq, title, body,
      mood: appState.selectedMood,
      tags: Array.from(appState.selectedTagsInput),
      createdAt: new Date().toISOString()
    };

    await dbAddEntry(entry);

    // フォームクリア
    titleEl.value = '';
    bodyEl.value = '';
    appState.selectedMood = null;
    appState.selectedTagsInput.clear();
    renderMoodPicker();
    renderTagChips('tag-chips-input', appState.selectedTagsInput);

    // 保存後は日時欄を「今」にリセットする（次の新規入力に備える）
    setEntryFormDateTime();

    showToast('保存しました ✅');

    document.getElementById('list-date-picker').value = date;
    appState.calSelectedDate = date;
  } catch (err) {
    showError('保存に失敗しました', err);
  }
}


/* ---------------------------------------------------------
 * 6. 一覧表示
 * --------------------------------------------------------- */
function initListView() {
  const picker = document.getElementById('list-date-picker');
  picker.value = todayStr();
  picker.addEventListener('change', () => {
    appState.calSelectedDate = picker.value;
    refreshListView();
  });

  document.getElementById('btn-pdf-day').addEventListener('click', () => {
    const date = document.getElementById('list-date-picker').value;
    if (!date) { showToast('日付を選択してください'); return; }
    exportDayToPdf(date);
  });
}

async function refreshListView() {
  const date = document.getElementById('list-date-picker').value || todayStr();
  const listEl = document.getElementById('entry-list');
  const emptyEl = document.getElementById('entry-list-empty');
  try {
    const rows = await dbGetEntriesByDate(date);
    renderEntryList(listEl, rows, false);
    emptyEl.hidden = rows.length > 0;
  } catch (err) {
    showError('一覧の取得に失敗しました', err);
  }
}

function renderEntryList(listEl, rows, showDate) {
  listEl.innerHTML = '';
  rows.forEach((row) => {
    const li = document.createElement('li');
    li.className = 'entry-item';
    const moodEmoji = row.mood ? MOOD_EMOJI[row.mood] : '';
    const tagsHtml = (row.tags || []).map((t) => `<span class="tag-badge">${escapeHtml(t)}</span>`).join('');
    li.innerHTML = `
      <div class="entry-item-head">
        <span class="entry-seq">#${pad2(row.seq)}</span>
        ${showDate ? `<span class="entry-date-label">${escapeHtml(row.date)}</span>` : ''}
        <span class="entry-time">${escapeHtml(row.time)}</span>
        ${moodEmoji ? `<span class="entry-mood">${moodEmoji}</span>` : ''}
        <span class="entry-title-text">${escapeHtml(row.title)}</span>
      </div>
      ${tagsHtml ? `<div class="tag-badges">${tagsHtml}</div>` : ''}
      <div class="entry-item-actions">
        <button type="button" class="btn-racket-migrate" data-id="${row.id}">🎭 ラケット感情へ</button>
      </div>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.btn-racket-migrate')) return; // ボタン押下時は詳細を開かない
      openDetailModal(row);
    });
    listEl.appendChild(li);
  });
}


/* ---------------------------------------------------------
 * 7. 詳細モーダル
 * --------------------------------------------------------- */
function initDetailModal() {
  document.getElementById('detail-close').addEventListener('click', closeDetailModal);
  document.getElementById('detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal') closeDetailModal();
  });
  document.getElementById('detail-delete').addEventListener('click', async () => {
    if (!appState.currentDetailEntry) return;
    if (!confirm('この記録を削除します。よろしいですか？')) return;
    try {
      await dbDeleteEntry(appState.currentDetailEntry.id);
      showToast('削除しました');
      closeDetailModal();
      refreshListView();
      refreshCalendarView();
    } catch (err) {
      showError('削除に失敗しました', err);
    }
  });
}

function openDetailModal(row) {
  appState.currentDetailEntry = row;
  const moodEmoji = row.mood ? MOOD_EMOJI[row.mood] : '未選択';
  document.getElementById('detail-meta').textContent =
    `${row.date} #${pad2(row.seq)}｜${row.time}｜気分：${moodEmoji}`;
  document.getElementById('detail-title').textContent = row.title;
  document.getElementById('detail-body').textContent = row.body;
  const tagsHtml = (row.tags || []).map((t) => `<span class="tag-badge">${escapeHtml(t)}</span>`).join('');
  document.getElementById('detail-tags').innerHTML = tagsHtml;
  document.getElementById('detail-modal').hidden = false;
}

function closeDetailModal() {
  document.getElementById('detail-modal').hidden = true;
  appState.currentDetailEntry = null;
}

/* ---------------------------------------------------------
 * 8. カレンダービュー
 * --------------------------------------------------------- */
function initCalendarView() {
  document.getElementById('cal-prev').addEventListener('click', () => {
    appState.calMonth -= 1;
    if (appState.calMonth < 0) { appState.calMonth = 11; appState.calYear -= 1; }
    refreshCalendarView();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    appState.calMonth += 1;
    if (appState.calMonth > 11) { appState.calMonth = 0; appState.calYear += 1; }
    refreshCalendarView();
  });
}

async function refreshCalendarView() {
  const { calYear, calMonth } = appState;
  document.getElementById('cal-month-label').textContent = `${calYear}年${calMonth + 1}月`;

  let allRows = [];
  try {
    allRows = await dbGetAllEntries();
  } catch (err) {
    showError('カレンダーデータの取得に失敗しました', err);
  }
  const datesWithEntry = new Set(allRows.map((r) => r.date));

  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  const firstDay = new Date(calYear, calMonth, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const todayS = todayStr();

  for (let i = 0; i < startWeekday; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day empty';
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${pad2(calMonth + 1)}-${pad2(d)}`;
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    if (dateStr === todayS) cell.classList.add('today');
    if (dateStr === appState.calSelectedDate) cell.classList.add('selected');
    const hasEntry = datesWithEntry.has(dateStr);
    cell.innerHTML = `<span>${d}</span>${hasEntry ? '<span class="cal-dot"></span>' : ''}`;
    cell.addEventListener('click', () => {
      appState.calSelectedDate = dateStr;
      document.getElementById('list-date-picker').value = dateStr;
      switchView('view-list');
    });
    grid.appendChild(cell);
  }
}

/* ---------------------------------------------------------
 * 9. 検索（日記／思考記録／ラケット感情の統合）
 * --------------------------------------------------------- */
function initSearchView() {
  document.getElementById('tag-chips-search').addEventListener('click', (e) => {
    const btn = e.target.closest('.tag-chip');
    if (!btn) return;
    const tag = btn.dataset.tag;
    if (appState.selectedTagsSearch.has(tag)) appState.selectedTagsSearch.delete(tag);
    else appState.selectedTagsSearch.add(tag);
    renderTagChips('tag-chips-search', appState.selectedTagsSearch);
  });

  document.getElementById('btn-search').addEventListener('click', runSearch);

  // ★イベント委譲方式：親要素に1つだけリスナーを付けることで、より確実に動作させる
  const targetContainer = document.querySelector('.search-target-selector');
  targetContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.target-btn');
    if (!btn) return; // ボタン以外がクリックされた場合は何もしない

    document.querySelectorAll('.target-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.target;
    appState.lastSearchTarget = target;

    document.getElementById('search-tags-row').hidden = (target !== 'diary');

    const kw = document.getElementById('search-keyword');
    if (target === 'diary')   kw.placeholder = 'タイトル・本文から検索';
    if (target === 'thought') kw.placeholder = '出来事から検索';
    if (target === 'racket')  kw.placeholder = '出来事・考え・感情から検索';

    document.getElementById('search-result-list').innerHTML = '';
    document.getElementById('search-result-empty').hidden = true;
    document.getElementById('search-thought-averages').hidden = true;
    document.getElementById('btn-search-pdf').hidden = true;
  });

  document.getElementById('btn-search-pdf').addEventListener('click', () => {
    exportSearchResultsToPdf(
      appState.lastSearchTarget,
      appState.lastSearchResults,
      document.getElementById('search-date-from').value,
      document.getElementById('search-date-to').value
    );
  });
}



/** 思考記録の平均スコアを計算し、パネルに描画する */
function renderThoughtAverages(rows) {
  const fields = [
    { key: 'pac',            label: '② PAC（自他肯定の構え）' },
    { key: 'parallelFamily', label: '③ 平行交流：家族（配偶者）' },
    { key: 'parallelOther',  label: '③ 平行交流：他者' },
    { key: 'objectivity',    label: '④ 客観性（A）' },
    { key: 'selfAffirm',     label: '⑤ 自己肯定' },
    { key: 'otherAffirm',    label: '⑥ 他者肯定' },
    { key: 'emotion',        label: '⑦ 感情表現（FC）' },
    { key: 'mood',           label: '⑧ 気分点数（ー100〜＋100）' }
  ];

  const gridEl = document.getElementById('averages-grid');
  gridEl.innerHTML = '';

  fields.forEach(({ key, label }) => {
    const validValues = rows.map((r) => r[key]).filter((v) => v != null);
    let displayVal = '−';
    let moodClass = '';
    if (validValues.length > 0) {
      const avg = validValues.reduce((sum, v) => sum + Number(v), 0) / validValues.length;
      if (key === 'mood') {
        displayVal = avg > 0 ? `+${avg.toFixed(1)}` : avg.toFixed(1);
        moodClass = avg > 0 ? 'mood-positive' : avg < 0 ? 'mood-negative' : 'mood-neutral';
      } else {
        displayVal = `${avg.toFixed(1)} / 10`;
      }
    }
    const item = document.createElement('div');
    item.className = 'avg-item';
    item.innerHTML = `<span class="avg-item-label">${escapeHtml(label)}</span><span class="avg-item-value ${moodClass}">${escapeHtml(displayVal)}</span>`;
    gridEl.appendChild(item);
  });

  document.getElementById('avg-count').textContent = String(rows.length);
}


/** 思考記録の検索結果を一覧カードとして描画する */
function renderSearchThoughtCards(listEl, rows) {
  listEl.innerHTML = '';
  rows.forEach((row) => {
    const preview = (row.event || '').replace(/\n/g, ' ');
 const scoreText = [
  row.pac            != null ? `②PAC：${row.pac}` : '',
  row.parallelFamily != null ? `③平行交流(家族)：${row.parallelFamily}` : '',
  row.parallelOther  != null ? `③平行交流(他者)：${row.parallelOther}` : '',
  row.objectivity    != null ? `④客観性(A)：${row.objectivity}` : '',
  row.selfAffirm     != null ? `⑤自己肯定：${row.selfAffirm}` : '',
  row.otherAffirm    != null ? `⑥他者肯定：${row.otherAffirm}` : '',
  row.emotion        != null ? `⑦感情表現(FC)：${row.emotion}` : '',
  row.mood           != null ? `⑧気分点数：${row.mood > 0 ? '+' : ''}${row.mood}` : ''
].filter(Boolean).join('　');



    const li = document.createElement('li');
    li.className = 'thought-entry-item';
    li.innerHTML = `
      <div class="thought-entry-head">
        <span class="thought-badge">🧠 思考記録</span>
        <span class="entry-date-label">${escapeHtml(formatDateJp(row.date))}</span>
      </div>
      <div class="thought-entry-scores">${escapeHtml(scoreText)}</div>
      <div class="thought-entry-preview">${escapeHtml(preview)}</div>
    `;
    li.addEventListener('click', () => openThoughtForm(row));
    listEl.appendChild(li);
  });
}

/** ラケット感情の検索結果を一覧カードとして描画する（①②③の内容を表示） */
function renderSearchRacketCards(listEl, rows) {
  const preview = (text, len = 24) => {
    if (!text) return '（未記入）';
    return text.length > len ? text.slice(0, len) + '…' : text;
  };
  listEl.innerHTML = '';
  rows.forEach((row) => {
    const li = document.createElement('li');
    li.className = 'racket-entry-item';
    li.innerHTML = `
      <div class="racket-entry-head">
        <span class="racket-badge">🎭 ラケット感情</span>
        <span class="entry-date-label">${escapeHtml(row.date)}</span>
        <span class="entry-seq">#${pad2(row.seq)}</span>
      </div>
      <div class="racket-entry-title">${escapeHtml(row.title)}</div>
      <div class="racket-preview">
        <div><strong>①出来事：</strong>${escapeHtml(preview(row.racket.event))}</div>
        <div><strong>②考え：</strong>${escapeHtml(preview(row.racket.thought))}</div>
        <div><strong>③感情：</strong>${escapeHtml(preview(row.racket.feeling))}</div>
      </div>
    `;
    li.addEventListener('click', () => openRacketTab(row));
    listEl.appendChild(li);
  });
}

async function runSearch() {
  const target   = document.querySelector('.target-btn.active').dataset.target;
  const keyword  = document.getElementById('search-keyword').value.trim().toLowerCase();
  const dateFrom = document.getElementById('search-date-from').value;
  const dateTo   = document.getElementById('search-date-to').value;
  const tags     = appState.selectedTagsSearch;

  const listEl  = document.getElementById('search-result-list');
  const emptyEl = document.getElementById('search-result-empty');
  const avgEl   = document.getElementById('search-thought-averages');
  const pdfBtn  = document.getElementById('btn-search-pdf');

  appState.lastSearchTarget = target;
  appState.lastSearchResults = [];

  try {
    if (target === 'diary') {
      avgEl.hidden = true;
      const all = await dbGetAllEntries();
      let filtered = all.filter((row) => {
        if (keyword) {
          const inTitle = (row.title || '').toLowerCase().includes(keyword);
          const inBody = (row.body || '').toLowerCase().includes(keyword);
          if (!inTitle && !inBody) return false;
        }
        if (dateFrom && row.date < dateFrom) return false;
        if (dateTo && row.date > dateTo) return false;
        if (tags.size > 0) {
          if (!(row.tags || []).some((t) => tags.has(t))) return false;
        }
        return true;
      });
      filtered.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.seq - b.seq));
      renderEntryList(listEl, filtered, true);
      emptyEl.hidden = filtered.length > 0;
      appState.lastSearchResults = filtered;
      pdfBtn.hidden = filtered.length === 0;

    } else if (target === 'thought') {
      const all = await dbGetAllThoughts();
      let filtered = all.filter((row) => {
        if (keyword && !(row.event || '').toLowerCase().includes(keyword)) return false;
        if (dateFrom && row.date < dateFrom) return false;
        if (dateTo && row.date > dateTo) return false;
        return true;
      });
      // ★日毎に並べる（古い日付→新しい日付）
      filtered.sort((a, b) => (a.date < b.date ? -1 : 1));

      renderSearchThoughtCards(listEl, filtered);
      emptyEl.hidden = filtered.length > 0;
      appState.lastSearchResults = filtered;
      pdfBtn.hidden = filtered.length === 0;

      if (filtered.length > 0) {
        renderThoughtAverages(filtered);
        avgEl.hidden = false;
      } else {
        avgEl.hidden = true;
      }

    } else if (target === 'racket') {
      avgEl.hidden = true;
      const all = await dbGetAllEntries();
      let filtered = all.filter((row) => {
        if (!row.racket || (!row.racket.event && !row.racket.thought && !row.racket.feeling)) return false;
        if (keyword) {
          const r = row.racket;
          if (![r.event, r.thought, r.feeling].some((t) => (t || '').toLowerCase().includes(keyword))) return false;
        }
        if (dateFrom && row.date < dateFrom) return false;
        if (dateTo && row.date > dateTo) return false;
        return true;
      });
      // ★日記・思考記録と同じく、日毎に並べる（古い日付→新しい日付）
      filtered.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.seq - b.seq));
      renderSearchRacketCards(listEl, filtered);
      emptyEl.hidden = filtered.length > 0;
      appState.lastSearchResults = filtered;
      pdfBtn.hidden = filtered.length === 0;
    }
  } catch (err) {
    showError('検索に失敗しました', err);
  }
}



/* ---------------------------------------------------------
 * 10. PDF出力（日本語フォント：実行時フェッチ＋キャッシュ方式）
 * --------------------------------------------------------- */
const JP_FONT_CACHE_KEY = 'diary_jp_font_base64_v1';
// jsDelivr（CORS許可・GitHub上のgoogle/fontsリポジトリから日本語フォントを配信）
// ※ Noto Sans JPは可変フォント(Variable Font)のみの配信でjsPDFとの相性が悪いため、
//   固定ウェイトの日本語対応フォント「M PLUS 1p」を使用する
const JP_FONT_URL = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/mplus1p/MPLUS1p-Regular.ttf';

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

async function getJapaneseFontBase64() {
  const cached = localStorage.getItem(JP_FONT_CACHE_KEY);
  if (cached) return cached;

  const res = await fetch(JP_FONT_URL, { mode: 'cors' });
  if (!res.ok) throw new Error('フォント取得に失敗: HTTP ' + res.status);
  const buffer = await res.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  try {
    localStorage.setItem(JP_FONT_CACHE_KEY, base64);
  } catch (e) {
    // 容量オーバー等はキャッシュ失敗しても致命的ではないので握りつぶす
    console.error('フォントキャッシュ保存に失敗', e);
  }
  return base64;
}

async function exportDayToPdf(dateStr) {
  showToast('PDFを生成しています…');
  try {
    const rows = await dbGetEntriesByDate(dateStr);
    if (rows.length === 0) {
      showToast('この日の記録がありません');
      return;
    }

    let fontBase64;
    try {
      fontBase64 = await getJapaneseFontBase64();
    } catch (err) {
      console.error('日本語フォント取得エラー', err);
      showToast('⚠️ 日本語フォントの読み込みに失敗しました。ネット接続を確認して再度お試しください');
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });

    doc.addFileToVFS('NotoSansJP-Regular.ttf', fontBase64);
    doc.addFont('NotoSansJP-Regular.ttf', 'NotoSansJP', 'normal');
    doc.setFont('NotoSansJP');

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginX = 40;
    const marginBottom = 50;
    let y = 60;

    // 対象日付を大きく表示
    doc.setFontSize(22);
    doc.text(dateStr, marginX, y);
    y += 34;
    doc.setDrawColor(200);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 26;

    function ensureSpace(neededHeight) {
      if (y + neededHeight > pageHeight - marginBottom) {
        doc.addPage();
        doc.setFont('NotoSansJP');
        y = 50;
      }
    }

    rows.forEach((row, idx) => {
      if (idx > 0) {
        ensureSpace(20);
        doc.setDrawColor(220);
        doc.line(marginX, y, pageWidth - marginX, y);
        y += 20;
      }

      const moodEmoji = row.mood ? (MOOD_EMOJI[row.mood] || '') : '';
      const heading = `#${pad2(row.seq)}｜${row.time}｜${moodEmoji}｜${row.title}`;
      ensureSpace(26);
      doc.setFontSize(14);
      const headingLines = doc.splitTextToSize(heading, pageWidth - marginX * 2);
      headingLines.forEach((line) => {
        ensureSpace(20);
        doc.text(line, marginX, y);
        y += 20;
      });

      if (row.tags && row.tags.length > 0) {
        ensureSpace(18);
        doc.setFontSize(10);
        doc.text('タグ: ' + row.tags.join('、'), marginX, y);
        y += 18;
      }

      doc.setFontSize(11);
      const bodyLines = doc.splitTextToSize(row.body || '', pageWidth - marginX * 2);
      bodyLines.forEach((line) => {
        ensureSpace(16);
        doc.text(line, marginX, y);
        y += 16;
      });

      y += 8;
    });

    doc.save(`diary_${dateStr}.pdf`);
    showToast('PDFを保存しました 📄');
  } catch (err) {
    showError('PDF出力に失敗しました', err);
  }
}

/* ---------------------------------------------------------
 * 11. バックアップ・インポート
 * --------------------------------------------------------- */
const LAST_BACKUP_KEY = 'lastBackupAt';

function initSettingsView() {
  document.getElementById('btn-backup').addEventListener('click', doBackup);
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });
  document.getElementById('import-file-input').addEventListener('change', handleImportFile);
  document.getElementById('btn-reset-pin').addEventListener('click', resetPin);
  refreshBackupInfo();
}

async function doBackup() {
  try {
    const entries = await dbGetAllEntries();
    const nowIso = new Date().toISOString();
    const thoughts = await dbGetAllThoughts();  // ★ 追加
const payload = {
  version: 1,
  exportedAt: nowIso,
  entries,
  customTags,
  thoughts   // ★ 追加
};


    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const fname = `diary_backup_${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}.json`;
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    localStorage.setItem(LAST_BACKUP_KEY, nowIso);
    refreshBackupInfo();
    showToast('バックアップを保存しました 📦');
  } catch (err) {
    showError('バックアップに失敗しました', err);
  }
}

function refreshBackupInfo() {
  const infoEl = document.getElementById('last-backup-info');
  const warnEl = document.getElementById('backup-warning');
  const lastIso = localStorage.getItem(LAST_BACKUP_KEY);
  if (!lastIso) {
    infoEl.textContent = '前回バックアップ：まだありません';
    warnEl.hidden = false;
    return;
  }
  const d = new Date(lastIso);
  const label = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  infoEl.textContent = `前回バックアップ：${label}`;

  const diffDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  warnEl.hidden = diffDays < 7;
}

async function handleImportFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  try {
    const text = await file.text();
    const json = JSON.parse(text);

    if (typeof json !== 'object' || json === null || !Array.isArray(json.entries)) {
      throw new Error('不正なバックアップファイル形式です');
    }
    if (json.version !== 1) {
      console.error('未知のバックアップバージョン:', json.version);
    }

    if (!confirm(`${json.entries.length}件の記録を復元します。既存のデータはすべて削除されます。よろしいですか？`)) {
      return;
    }

    // ①日記データを入れ替え
    await dbClearAll();
    await dbBulkAdd(json.entries);

    // ②カスタムタグがあれば復元（★tryブロックの中に移動）
    if (Array.isArray(json.customTags)) {
      customTags = json.customTags;
      saveCustomTags();
      renderTagManageList();
      renderAllTagChipContainers();
    }

    // ③思考記録があれば復元（★tryブロックの中に移動）
    if (Array.isArray(json.thoughts)) {
      await dbBulkAddThoughts(json.thoughts);
    }

    showToast('復元が完了しました ✅');
    await refreshListView();
    await refreshCalendarView();
    document.getElementById('search-result-list').innerHTML = '';
    document.getElementById('search-result-empty').hidden = true;
  } catch (err) {
    showError('インポートに失敗しました。ファイル形式を確認してください', err);
  }
}


/* ---------------------------------------------------------
 * 12. 初期化
 * --------------------------------------------------------- */
function initAppOnce() {
  if (appState.appInitialized) return;
  appState.appInitialized = true;

  loadCustomTags();
  renderAllTagChipContainers();
  initTagManagement();
  initTabOrderSettings();
  initBiometricSettings();   // ★この1行を追加
  initOcrHelper();   // ★この1行を追加


  initTabs();
  initWriteForm();
  initListView();
  initDetailModal();
  initEditModal();
  initCalendarView();
  initSearchView();
  initSettingsView();
  initRacketTab();
  initThoughtTab();   // ★ 追加


  bindRacketMigrateButtons(document.getElementById('entry-list'));
  bindRacketMigrateButtons(document.getElementById('search-result-list'));

  refreshListView();
  refreshCalendarView();
}




document.addEventListener('DOMContentLoaded', () => {
  initPinScreen();
});

/* ---------------------------------------------------------
 * 13. 編集（修正）機能
 * --------------------------------------------------------- */

/** IDでエントリを1件取得する */
async function dbGetEntryById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** エントリを上書き保存する（put = 同じidのレコードを更新） */
async function dbUpdateEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* 編集モーダル専用の状態（既存のappStateとは分離して管理） */
const editState = {
  selectedMood: null,
  selectedTags: new Set()
};

function initEditModal() {
  // 気分ピッカー（編集用）
  document.getElementById('edit-mood-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('.mood-btn');
    if (!btn) return;
    const mood = parseInt(btn.dataset.mood, 10);
    editState.selectedMood = (editState.selectedMood === mood) ? null : mood;
    renderEditMoodPicker();
  });

  // タグチップ（編集用）：既存のrenderTagChipsを再利用
  document.getElementById('edit-tag-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.tag-chip');
    if (!btn) return;
    const tag = btn.dataset.tag;
    if (editState.selectedTags.has(tag)) editState.selectedTags.delete(tag);
    else editState.selectedTags.add(tag);
    renderTagChips('edit-tag-chips', editState.selectedTags);
  });

  // 保存
  document.getElementById('edit-form').addEventListener('submit', handleEditSubmit);

  // 閉じる系
  document.getElementById('edit-close').addEventListener('click', closeEditModal);
  document.getElementById('edit-cancel').addEventListener('click', closeEditModal);
  document.getElementById('edit-modal').addEventListener('click', (e) => {
    if (e.target.id === 'edit-modal') closeEditModal();
  });

  // 詳細モーダルの「編集」ボタン
  // ※ 既存の initDetailModal() は変更せず、こちらで独立してイベントを設定する
  document.getElementById('detail-edit').addEventListener('click', () => {
    const entry = appState.currentDetailEntry;
    if (!entry) return;
    openEditModal(entry);
  });
}

function renderEditMoodPicker() {
  document.querySelectorAll('#edit-mood-picker .mood-btn').forEach((btn) => {
    const mood = parseInt(btn.dataset.mood, 10);
    btn.classList.toggle('selected', mood === editState.selectedMood);
  });
}

function openEditModal(entry) {
  // 詳細モーダルを閉じる（appState.currentDetailEntryはリセットせず、
  // entryをパラメータで直接受け取ることで安全に処理する）
  document.getElementById('detail-modal').hidden = true;

  document.getElementById('edit-id').value    = entry.id;
  document.getElementById('edit-date').value  = entry.date;
  document.getElementById('edit-time').value  = entry.time;
  document.getElementById('edit-title').value = entry.title;
  document.getElementById('edit-body').value  = entry.body;

  editState.selectedMood = entry.mood ?? null;
  renderEditMoodPicker();

  editState.selectedTags = new Set(Array.isArray(entry.tags) ? entry.tags : []);
  renderTagChips('edit-tag-chips', editState.selectedTags);

  document.getElementById('edit-modal').hidden = false;
}

function closeEditModal() {
  document.getElementById('edit-modal').hidden = true;
}

async function handleEditSubmit(e) {
  e.preventDefault();

  const id       = Number(document.getElementById('edit-id').value);
  const newDate  = document.getElementById('edit-date').value;
  const newTime  = document.getElementById('edit-time').value;
  const newTitle = document.getElementById('edit-title').value.trim();
  const newBody  = document.getElementById('edit-body').value.trim();

  if (!newDate || !newTime) { showToast('日付と時刻を入力してください'); return; }
  if (!newTitle) { showToast('タイトルを入力してください'); return; }
  if (!newBody)  { showToast('本文を入力してください'); return; }

  try {
    const original = await dbGetEntryById(id);
    if (!original) { showToast('記録が見つかりませんでした'); return; }

    // 日付を変更した場合のみ、移動先の日付の末尾に新しいseqを採番する
    let newSeq = original.seq;
    if (newDate !== original.date) {
      const maxSeq = await dbGetMaxSeqForDate(newDate);
      newSeq = maxSeq + 1;
    }

    const updated = {
      ...original, // id, createdAt はそのまま保持
      date: newDate,
      time: newTime,
      seq: newSeq,
      title: newTitle,
      body: newBody,
      mood: editState.selectedMood,
      tags: Array.from(editState.selectedTags),
      updatedAt: new Date().toISOString()
    };

    await dbUpdateEntry(updated);

    closeEditModal();
    showToast('記録を更新しました ✅');

    await refreshListView();
    await refreshCalendarView();

    // 検索タブを開いていた場合は、検索結果も更新する
    const searchView = document.getElementById('view-search');
    if (searchView && searchView.classList.contains('active-view')) {
      runSearch();
    }
  } catch (err) {
    showError('更新に失敗しました', err);
  }
}
/* ---------------------------------------------------------
 * 14. タグ管理（設定画面）
 * --------------------------------------------------------- */
const CUSTOM_TAGS_KEY = 'diary_custom_tags';
let customTags = [];

function loadCustomTags() {
  const saved = localStorage.getItem(CUSTOM_TAGS_KEY);
  if (saved) {
    try { customTags = JSON.parse(saved); } catch (e) { customTags = [...TAGS_ALL]; }
  } else {
    customTags = [...TAGS_ALL]; // 初回は今までの固定タグを初期値にする
    localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(customTags));
  }
}
function saveCustomTags() {
  localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(customTags));
}
function renderAllTagChipContainers() {
  ['tag-chips-input', 'edit-tag-chips', 'tag-chips-search'].forEach((id) => {
    const container = document.getElementById(id);
    if (!container) return;
    container.innerHTML = customTags
      .map((tag) => `<button type="button" class="tag-chip" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`)
      .join('');
  });
  renderTagChips('tag-chips-input', appState.selectedTagsInput);
  renderTagChips('tag-chips-search', appState.selectedTagsSearch);
  if (typeof editState !== 'undefined') renderTagChips('edit-tag-chips', editState.selectedTags);
}
function renderTagManageList() {
  const listEl = document.getElementById('settings-tag-list');
  listEl.innerHTML = '';
  customTags.forEach((tag) => {
    const item = document.createElement('div');
    item.className = 'tag-manage-item';
    item.innerHTML = `<span>${escapeHtml(tag)}</span><button type="button" data-tag="${escapeHtml(tag)}">×</button>`;
    listEl.appendChild(item);
  });
}
function initTagManagement() {
  renderTagManageList();

  document.getElementById('btn-add-tag').addEventListener('click', () => {
    const input = document.getElementById('new-tag-input');
    const newTag = input.value.trim();
    if (!newTag) { showToast('タグ名を入力してください'); return; }
    if (customTags.includes(newTag)) { showToast('そのタグは既に存在します'); return; }
    customTags.push(newTag);
    saveCustomTags();
    input.value = '';
    renderTagManageList();
    renderAllTagChipContainers();
    showToast('タグを追加しました ✅');
  });

  document.getElementById('settings-tag-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tag]');
    if (!btn) return;
    const tag = btn.dataset.tag;
    if (!confirm(`タグ「${tag}」を削除しますか？（既存の記録に付いているタグはそのまま残ります）`)) return;
    customTags = customTags.filter((t) => t !== tag);
    saveCustomTags();
    renderTagManageList();
    renderAllTagChipContainers();
    showToast('タグを削除しました');
  });
}

/* ---------------------------------------------------------
 * 15. ラケット感情タブ
 * --------------------------------------------------------- */
function openRacketTab(entry) {
  switchView('view-racket'); // ①まず一覧モードにリセット＆背景で一覧を更新

  // ②そのあとでフォーム表示に上書きする（この順序が逆だと正しく動作しません）
  document.getElementById('racket-list-view').hidden = true;
  document.getElementById('racket-form-view').hidden = false;

  document.getElementById('racket-target-id').value = entry.id;
  document.getElementById('racket-target-title').textContent = entry.title;
  document.getElementById('racket-target-date').textContent = `${entry.date} #${pad2(entry.seq)}`;

  if (entry.racket) {
    document.getElementById('racket-event').value   = entry.racket.event   || '';
    document.getElementById('racket-thought').value = entry.racket.thought || '';
    document.getElementById('racket-feeling').value = entry.racket.feeling || '';
  } else {
    document.getElementById('racket-event').value   = entry.body || '';
    document.getElementById('racket-thought').value = '';
    document.getElementById('racket-feeling').value = '';
  }
}


function initRacketTab() {
  document.getElementById('racket-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = Number(document.getElementById('racket-target-id').value);
    try {
      const entry = await dbGetEntryById(id);
      if (!entry) { showToast('対象の記録が見つかりません'); return; }
      entry.racket = {
        event:     document.getElementById('racket-event').value.trim(),
        thought:   document.getElementById('racket-thought').value.trim(),
        feeling:   document.getElementById('racket-feeling').value.trim(),
        updatedAt: new Date().toISOString()
      };
      await dbUpdateEntry(entry);
      showToast('ラケット感情分析を保存しました 🎭');

      document.getElementById('racket-form-view').hidden = true;
      document.getElementById('racket-list-view').hidden = false;
      refreshRacketList();
    } catch (err) {
      showError('保存に失敗しました', err);
    }
  });

  document.getElementById('racket-back-btn').addEventListener('click', () => {
    document.getElementById('racket-form-view').hidden = true;
    document.getElementById('racket-list-view').hidden = false;
    refreshRacketList();
  });

  // 「🗑 分析だけ削除」ボタン（一覧側、イベント委任で処理）
  document.getElementById('racket-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-racket-delete');
    if (!btn) return;
    e.stopPropagation();
    const id = Number(btn.dataset.id);
    if (!confirm('このラケット感情分析だけを削除します（日記本体は残ります）。よろしいですか？')) return;
    try {
      const entry = await dbGetEntryById(id);
      if (entry) {
        delete entry.racket;
        await dbUpdateEntry(entry);
      }
      showToast('ラケット感情分析を削除しました');
      refreshRacketList();
    } catch (err) {
      showError('削除に失敗しました', err);
    }
  });
}

async function refreshRacketList() {
  const listEl  = document.getElementById('racket-list');
  const emptyEl = document.getElementById('racket-list-empty');
  try {
    const all = await dbGetAllEntries();
    const racketEntries = all
      .filter((row) => row.racket && (row.racket.event || row.racket.thought || row.racket.feeling))
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1; // 新しい日付が先
        return b.seq - a.seq;
      });

    const preview = (text, len = 18) => {
      if (!text) return '（未記入）';
      return text.length > len ? text.slice(0, len) + '…' : text;
    };

    listEl.innerHTML = '';
    racketEntries.forEach((row) => {
      const li = document.createElement('li');
      li.className = 'racket-entry-item';
      li.innerHTML = `
        <div class="racket-entry-head">
          <span class="racket-badge">🎭 ラケット感情</span>
          <span class="entry-date-label">${escapeHtml(row.date)}</span>
          <span class="entry-seq">#${pad2(row.seq)}</span>
        </div>
        <div class="racket-entry-title">${escapeHtml(row.title)}</div>
        <div class="racket-preview">
          <div><strong>①出来事：</strong>${escapeHtml(preview(row.racket.event))}</div>
          <div><strong>②考え：</strong>${escapeHtml(preview(row.racket.thought))}</div>
          <div><strong>③感情：</strong>${escapeHtml(preview(row.racket.feeling))}</div>
        </div>
        <div class="racket-entry-actions">
          <button type="button" class="btn-racket-delete" data-id="${row.id}">🗑 分析だけ削除</button>
        </div>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.btn-racket-delete')) return;
        openRacketTab(row);
      });
      listEl.appendChild(li);
    });

    emptyEl.hidden = racketEntries.length > 0;
  } catch (err) {
    showError('ラケット感情一覧の取得に失敗しました', err);
  }
}


function bindRacketMigrateButtons(listEl) {
  if (!listEl) return;
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-racket-migrate');
    if (!btn) return;
    e.stopPropagation();
    const id = Number(btn.dataset.id);
    try {
      const entry = await dbGetEntryById(id);
      if (!entry) { showToast('記録が見つかりません'); return; }
      openRacketTab(entry);
    } catch (err) {
      showError('移行に失敗しました', err);
    }
  });
}
/* ---------------------------------------------------------
 * 16. タブの並び替え
 * --------------------------------------------------------- */
const TAB_ORDER_KEY = 'diary_tab_order';

// 並び替え対象のタブ（設定タブは対象外）
const SORTABLE_TABS = [
  { id: 'view-write',    icon: '✏️', label: '書く' },
  { id: 'view-list',     icon: '📋', label: '一覧' },
  { id: 'view-calendar', icon: '📅', label: 'カレンダー' },
  { id: 'view-search',   icon: '🔍', label: '検索' },
  { id: 'view-racket',   icon: '🎭', label: 'ラケット' },
  { id: 'view-thought',  icon: '🧠', label: '思考記録' }
];


let currentTabOrder = [];

function loadTabOrder() {
  const saved = localStorage.getItem(TAB_ORDER_KEY);
  let order = SORTABLE_TABS.map((t) => t.id);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      const valid = parsed.filter((id) => SORTABLE_TABS.some((t) => t.id === id));
      SORTABLE_TABS.forEach((t) => { if (!valid.includes(t.id)) valid.push(t.id); });
      order = valid;
    } catch (e) {
      console.error('タブ順序の読み込みに失敗', e);
    }
  }
  return order;
}

function saveTabOrder(order) {
  localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order));
}

function applyTabOrder(order) {
  const tabBar = document.querySelector('.tab-bar');
  order.forEach((id) => {
    const btn = tabBar.querySelector(`.tab-btn[data-view="${id}"]`);
    if (btn) tabBar.appendChild(btn); // 既存要素を移動するだけなので、クリックイベントは維持される
  });
  const settingsBtn = tabBar.querySelector('.tab-btn[data-view="view-settings"]');
  if (settingsBtn) tabBar.appendChild(settingsBtn); // 設定タブは常に最後に固定
}

function renderTabOrderList() {
  const listEl = document.getElementById('tab-order-list');
  listEl.innerHTML = '';
  currentTabOrder.forEach((id, index) => {
    const conf = SORTABLE_TABS.find((t) => t.id === id);
    if (!conf) return;
    const item = document.createElement('div');
    item.className = 'tab-order-item';
    item.innerHTML = `
      <span class="tab-order-name">${conf.icon} ${conf.label}</span>
      <div class="tab-order-actions">
        <button type="button" data-action="up"   data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-action="down" data-index="${index}" ${index === currentTabOrder.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
    `;
    listEl.appendChild(item);
  });

  listEl.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.index);
      const targetIdx = btn.dataset.action === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= currentTabOrder.length) return;
      [currentTabOrder[idx], currentTabOrder[targetIdx]] = [currentTabOrder[targetIdx], currentTabOrder[idx]];
      saveTabOrder(currentTabOrder);
      applyTabOrder(currentTabOrder);
      renderTabOrderList();
    });
  });
}

function initTabOrderSettings() {
  currentTabOrder = loadTabOrder();
  applyTabOrder(currentTabOrder);
  renderTabOrderList();
}

/* ---------------------------------------------------------
 * 17. 生体認証（Face ID / Touch ID）※WebAuthnを使用、サーバー不要
 * --------------------------------------------------------- */
const BIO_CRED_ID_KEY = 'diary_bio_cred_id';

let bioFailCount = 0;
const MAX_BIO_FAIL = 3;

/** 画面表示を「生体認証モード」「PINモード」に切り替える */
function setPinScreenUI(mode) {
  const pinDots = document.getElementById('pin-dots');
  const pinKeypad = document.getElementById('pin-keypad');
  const bioContainer = document.getElementById('biometric-container');

  if (mode === 'bio') {
    // 生体認証モード：PINキーパッドとボタンの両方を隠し、メッセージのみ表示する
    pinDots.style.display = 'none';
    pinKeypad.style.display = 'none';
    bioContainer.hidden = true; // ボタンは表示しない（自動実行のみで完結させる）
    document.getElementById('pin-title').textContent = 'ロック解除';
  } else {
    // PINモード：キーパッドを表示する
    pinDots.style.display = '';
    pinKeypad.style.display = '';
    bioContainer.hidden = true;
  }
}


/** 生体認証を3回失敗した際に、PIN入力モードへ切り替える */
function switchToPinAfterBioFail() {
  setPinScreenUI('pin');
  document.getElementById('pin-title').textContent = 'PINコードを入力';
  document.getElementById('pin-message').textContent = '生体認証に失敗しました。PINを入力してください';
  pinState.mode = 'verify';
  pinState.current = '';
  renderPinDots();
}

/** 生体認証を実行し、失敗回数を管理する */
async function triggerBiometricAuth() {
  try {
    await verifyBiometric();
    // 成功時はverifyBiometric()内でunlockApp()が呼ばれるため、ここには戻ってきません
  } catch (err) {
    console.error('生体認証エラー', err.name, err.message);
    bioFailCount++;
    // ★自動再試行は行わず、その場で静かにPIN入力へ切り替える
    //  （Face IDの失敗は環境的な要因が多く、その場で連続して呼び出しても
    //    同じ結果になりがちで、結果的にダイアログが連続表示され混乱を招くため）
    switchToPinAfterBioFail();
  }
}





// arrayBufferToBase64() は「10. PDF出力」のセクションで定義済みのものを再利用します

function base64ToArrayBuffer(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bindBiometricButton() {
  const btn = document.getElementById('btn-bio-auth');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => { triggerBiometricAuth(); });
}


async function registerBiometric() {
  if (!window.PublicKeyCredential) {
    showToast('この端末・ブラウザは生体認証に対応していません');
    return;
  }
  if (!window.isSecureContext) {
    showToast('HTTPS接続でないため生体認証は使えません（GitHub Pagesで開いてください）');
    return;
  }
  try {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const userId = new Uint8Array(16);
    crypto.getRandomValues(userId);

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: '日記アプリ', id: window.location.hostname },
        user: { id: userId, name: 'diary-user', displayName: '日記アプリ利用者' },
        pubKeyCredParams: [
          { alg: -7,   type: 'public-key' }, // ES256
          { alg: -257, type: 'public-key' }  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform', // Face ID / Touch IDなど端末内蔵の認証器を指定
          userVerification: 'required'
        },
        timeout: 60000,
        attestation: 'none'
      }
    });

    const credentialIdBase64 = arrayBufferToBase64(credential.rawId);
    localStorage.setItem(BIO_CRED_ID_KEY, credentialIdBase64);
    showToast('生体認証を登録しました ✅');
    updateBioSettingsUI();
  } catch (err) {
    console.error('生体認証登録エラー', err);
    showToast('登録がキャンセルされたか、失敗しました');
  }
}

async function verifyBiometric() {
  const credIdBase64 = localStorage.getItem(BIO_CRED_ID_KEY);
  if (!credIdBase64) return;

  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{
        id: base64ToArrayBuffer(credIdBase64),
        type: 'public-key',
        transports: ['internal']
      }],
      userVerification: 'required',
      timeout: 60000
    }
  });

  if (assertion) {
    // 個人利用のローカル日記アプリのため、署名の暗号学的検証（本来サーバーで行う工程）は省略し、
    // 「ブラウザ側でFace ID/Touch ID認証に成功した」という事実のみでロックを解除する
    setFailCount(0);
    setLockUntil(0);
    unlockApp();
  }
}

function updateBioSettingsUI() {
  const credId = localStorage.getItem(BIO_CRED_ID_KEY);
  const btnReg = document.getElementById('btn-register-bio');
  const btnRem = document.getElementById('btn-remove-bio');
  const msgEl  = document.getElementById('bio-support-msg');
  if (!btnReg || !btnRem) return;

  if (!window.PublicKeyCredential) {
    btnReg.hidden = true;
    btnRem.hidden = true;
    if (msgEl) msgEl.hidden = false;
    return;
  }
  btnReg.hidden = !!credId;
  btnRem.hidden = !credId;
}

function initBiometricSettings() {
  updateBioSettingsUI();
  document.getElementById('btn-register-bio').addEventListener('click', registerBiometric);
  document.getElementById('btn-remove-bio').addEventListener('click', () => {
    if (!confirm('生体認証の登録を解除します。次回からPINコードでの解除に戻ります。よろしいですか？')) return;
    localStorage.removeItem(BIO_CRED_ID_KEY);
    showToast('生体認証の登録を解除しました');
    updateBioSettingsUI();
  });
}
/* ---------------------------------------------------------
 * 18. 思考記録タブ
 * --------------------------------------------------------- */

async function dbGetAllThoughts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(THOUGHT_STORE, 'readonly').objectStore(THOUGHT_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => (a.date < b.date ? 1 : -1)));
    req.onerror = () => reject(req.error);
  });
}
async function dbGetThoughtByDate(dateStr) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(THOUGHT_STORE, 'readonly').objectStore(THOUGHT_STORE).get(dateStr);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function dbSaveThought(thought) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(THOUGHT_STORE, 'readwrite').objectStore(THOUGHT_STORE).put(thought);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function dbDeleteThought(dateStr) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(THOUGHT_STORE, 'readwrite').objectStore(THOUGHT_STORE).delete(dateStr);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function dbBulkAddThoughts(thoughts) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THOUGHT_STORE, 'readwrite');
    thoughts.forEach((t) => tx.objectStore(THOUGHT_STORE).put(t));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const THOUGHT_SCORE_FIELDS = ['pac', 'parallelFamily', 'parallelOther', 'objectivity', 'selfAffirm', 'otherAffirm', 'emotion'];
let thoughtScores = {};

function resetThoughtScores() {
  thoughtScores = {};
  THOUGHT_SCORE_FIELDS.forEach((f) => (thoughtScores[f] = null));
  document.querySelectorAll('.thought-score-selector').forEach((sel) => renderThoughtScore(sel));
  document.getElementById('thought-mood').value = 0;
  updateMoodDisplay(0);
}
function renderThoughtScore(selector) {
  const field = selector.dataset.field;
  const val = thoughtScores[field];
  const label = document.getElementById(`${field}-label`);
  if (label) label.textContent = val == null ? '未選択' : String(val);
  selector.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', Number(b.dataset.val) === val));
}
function updateMoodDisplay(val) {
  const el = document.getElementById('thought-mood-value');
  el.textContent = val > 0 ? `+${val}` : String(val);
  el.classList.toggle('positive', val > 0);
  el.classList.toggle('negative', val < 0);
}
function formatDateJp(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}
function updateThoughtDateDisplay() {
  const val = document.getElementById('thought-date').value;
  document.getElementById('thought-date-display').textContent = formatDateJp(val);
}

function initThoughtScoreSelectors() {
  document.querySelectorAll('.thought-score-selector').forEach((selector) => {
    const field = selector.dataset.field;
    selector.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = Number(btn.dataset.val);
        thoughtScores[field] = (thoughtScores[field] === val) ? null : val;
        renderThoughtScore(selector);
      });
    });
  });
  document.getElementById('thought-mood').addEventListener('input', (e) => updateMoodDisplay(Number(e.target.value)));
  document.getElementById('thought-date').addEventListener('change', updateThoughtDateDisplay);
}

function showThoughtListView() {
  document.getElementById('thought-list-view').hidden = false;
  document.getElementById('thought-form-view').hidden = true;
}
function showThoughtFormView() {
  document.getElementById('thought-list-view').hidden = true;
  document.getElementById('thought-form-view').hidden = false;
}

async function openThoughtForm(record) {
  resetThoughtScores();
  const date = record ? record.date : todayStr();

  document.getElementById('thought-edit-date').value = date; // ★元の日付を記憶
  document.getElementById('thought-date').value = date;
  updateThoughtDateDisplay();
  document.getElementById('thought-event').value = record ? (record.event || '') : '';

  if (record) {
    THOUGHT_SCORE_FIELDS.forEach((f) => (thoughtScores[f] = record[f] ?? null));
    document.getElementById('thought-mood').value = record.mood ?? 0;
    updateMoodDisplay(record.mood ?? 0);
    document.querySelectorAll('.thought-score-selector').forEach((sel) => renderThoughtScore(sel));
  } else {
    const existing = await dbGetThoughtByDate(date);
    if (existing) {
      showToast('今日の記録が既にあります。編集モードで開きます');
      return openThoughtForm(existing);
    }
  }
  showThoughtFormView();
}

async function refreshThoughtList() {
  const listEl = document.getElementById('thought-list');
  const emptyEl = document.getElementById('thought-list-empty');
  try {
    const rows = await dbGetAllThoughts();
    listEl.innerHTML = '';
    rows.forEach((row) => {
      const preview = (row.event || '').replace(/\n/g, ' ');
    const scoreText = [
  row.pac            != null ? `②PAC：${row.pac}` : '',
  row.parallelFamily != null ? `③平行交流(家族)：${row.parallelFamily}` : '',
  row.parallelOther  != null ? `③平行交流(他者)：${row.parallelOther}` : '',
  row.objectivity    != null ? `④客観性(A)：${row.objectivity}` : '',
  row.selfAffirm     != null ? `⑤自己肯定：${row.selfAffirm}` : '',
  row.otherAffirm    != null ? `⑥他者肯定：${row.otherAffirm}` : '',
  row.emotion        != null ? `⑦感情表現(FC)：${row.emotion}` : '',
  row.mood           != null ? `⑧気分点数：${row.mood > 0 ? '+' : ''}${row.mood}` : ''
].filter(Boolean).join('　');

      const li = document.createElement('li');
      li.className = 'thought-entry-item';
      li.innerHTML = `
        <div class="thought-entry-head">
          <span class="thought-badge">🧠 思考記録</span>
          <span class="entry-date-label">${escapeHtml(formatDateJp(row.date))}</span>
        </div>
        <div class="thought-entry-scores">${escapeHtml(scoreText)}</div>
        <div class="thought-entry-preview">${escapeHtml(preview)}</div>
        <div class="thought-entry-actions">
          <button type="button" class="btn-thought-delete" data-date="${row.date}">🗑 削除</button>
        </div>`;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.btn-thought-delete')) return;
        openThoughtForm(row);
      });
      listEl.appendChild(li);
    });
    emptyEl.hidden = rows.length > 0;
  } catch (err) {
    showError('思考記録一覧の取得に失敗しました', err);
  }
}

function initThoughtTab() {
  initThoughtScoreSelectors();

  document.getElementById('btn-new-thought').addEventListener('click', () => openThoughtForm(null));
  document.getElementById('thought-back-btn').addEventListener('click', () => { showThoughtListView(); refreshThoughtList(); });
  document.getElementById('thought-cancel').addEventListener('click', () => { showThoughtListView(); refreshThoughtList(); });

  document.getElementById('thought-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-thought-delete');
    if (!btn) return;
    e.stopPropagation();
    if (!confirm('この思考記録を削除します。よろしいですか？')) return;
    try {
      await dbDeleteThought(btn.dataset.date);
      showToast('削除しました');
      refreshThoughtList();
    } catch (err) { showError('削除に失敗しました', err); }
  });

  document.getElementById('thought-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newDate = document.getElementById('thought-date').value;
    const originalDate = document.getElementById('thought-edit-date').value;
    const eventText = document.getElementById('thought-event').value.trim();

    if (!newDate) { showToast('日付を入力してください'); return; }
    if (!eventText) { showToast('⑨ 出来事を入力してください'); return; }

    // ★日付を変更した場合、移動先に既存レコードがあれば確認し、元のレコードは必ず削除する
    if (originalDate && originalDate !== newDate) {
      const conflict = await dbGetThoughtByDate(newDate);
      if (conflict && !confirm(`${formatDateJp(newDate)}の記録が既にあります。上書きしますか？`)) return;
      await dbDeleteThought(originalDate);
    }

    const thought = {
      date: newDate,
      pac: thoughtScores.pac,
      parallelFamily: thoughtScores.parallelFamily,
      parallelOther: thoughtScores.parallelOther,
      objectivity: thoughtScores.objectivity,
      selfAffirm: thoughtScores.selfAffirm,
      otherAffirm: thoughtScores.otherAffirm,
      emotion: thoughtScores.emotion,
      mood: Number(document.getElementById('thought-mood').value),
      event: eventText,
      updatedAt: new Date().toISOString()
    };

    try {
      await dbSaveThought(thought);
      showToast('思考記録を保存しました 🧠');
      showThoughtListView();
      refreshThoughtList();
    } catch (err) { showError('保存に失敗しました', err); }
  });
}
/* ---------------------------------------------------------
 * 19. OCR補助機能（カメラ画像プレビュー＋クリップボード貼り付け）
 * --------------------------------------------------------- */
function initOcrHelper() {
  const fileInput   = document.getElementById('ocr-file-input');
  const previewArea = document.getElementById('ocr-preview-area');
  const previewImg  = document.getElementById('ocr-preview-img');
  const textarea    = document.getElementById('thought-event');

  document.getElementById('btn-ocr-camera').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      previewImg.src = ev.target.result;
      previewArea.hidden = false;
      previewArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btn-ocr-close').addEventListener('click', () => {
    previewImg.src = '';
    previewArea.hidden = true;
  });

  document.getElementById('btn-ocr-paste').addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        showToast('この端末では自動貼り付けに対応していません。テキストエリアを長押しして「ペースト」を選んでください');
        return;
      }
      const text = await navigator.clipboard.readText();
      if (!text) { showToast('クリップボードにテキストがありません'); return; }

      const start = textarea.selectionStart;
      const end   = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + text + textarea.value.substring(end);
      const pos = start + text.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
      showToast(`${text.length}文字を貼り付けました ✅`);
    } catch (err) {
      console.error('クリップボード読み取りエラー', err);
      showToast('クリップボードへのアクセスが許可されていません。テキストエリアを長押しして「ペースト」を選んでください');
    }
  });
}
/* ---------------------------------------------------------
 * 20. 検索結果のPDF出力
 * --------------------------------------------------------- */
async function exportSearchResultsToPdf(target, rows, dateFrom, dateTo) {
  if (!rows || rows.length === 0) { showToast('出力する検索結果がありません'); return; }
  showToast('PDFを生成しています…');

  try {
    let fontBase64;
    try {
      fontBase64 = await getJapaneseFontBase64();
    } catch (err) {
      showToast('⚠️ 日本語フォントの読み込みに失敗しました。ネット接続を確認して再度お試しください');
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.addFileToVFS('NotoSansJP-Regular.ttf', fontBase64);
    doc.addFont('NotoSansJP-Regular.ttf', 'NotoSansJP', 'normal');
    doc.setFont('NotoSansJP');

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginX = 40;
    const marginBottom = 50;
    let y = 60;

    function ensureSpace(h) {
      if (y + h > pageHeight - marginBottom) {
        doc.addPage();
        doc.setFont('NotoSansJP');
        y = 50;
      }
    }
    function drawLine(color = 220) {
      ensureSpace(16);
      doc.setDrawColor(color);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 16;
    }
    function writeText(text, size, indent = 0) {
      doc.setFontSize(size);
      const lines = doc.splitTextToSize(text, pageWidth - marginX * 2 - indent);
      lines.forEach((line) => {
        ensureSpace(size * 1.5);
        doc.text(line, marginX + indent, y);
        y += size * 1.5;
      });
    }

    const targetLabel = target === 'diary' ? '📔 日記' : target === 'thought' ? '🧠 思考記録' : '🎭 ラケット感情';
    const periodLabel = (dateFrom || dateTo) ? `${dateFrom || '〜'}　〜　${dateTo || '〜'}` : '全期間';

    doc.setFontSize(20);
    doc.text(targetLabel + ' 検索結果', marginX, y);
    y += 30;
    doc.setFontSize(12);
    doc.text(`期間：${periodLabel}　　件数：${rows.length}件`, marginX, y);
    y += 10;
    drawLine(180);

    // ===== 思考記録：表紙に期間平均スコアを掲載 =====
    if (target === 'thought') {
      const scoreFields = [
        { key: 'pac',            label: '② PAC（自他肯定の構え）' },
        { key: 'parallelFamily', label: '③ 平行交流：家族（配偶者）' },
        { key: 'parallelOther',  label: '③ 平行交流：他者' },
        { key: 'objectivity',    label: '④ 客観性（A）' },
        { key: 'selfAffirm',     label: '⑤ 自己肯定' },
        { key: 'otherAffirm',    label: '⑥ 他者肯定' },
        { key: 'emotion',        label: '⑦ 感情表現（FC）' },
        { key: 'mood',           label: '⑧ 気分点数' }
      ];
      ensureSpace(20);
      doc.setFontSize(13);
      doc.text('■ 期間平均スコア', marginX, y);
      y += 20;
      scoreFields.forEach(({ key, label }) => {
        const vals = rows.map((r) => r[key]).filter((v) => v != null);
        let valStr = '−（未記入）';
        if (vals.length > 0) {
          const avg = vals.reduce((s, v) => s + Number(v), 0) / vals.length;
          valStr = key === 'mood' ? (avg > 0 ? `+${avg.toFixed(1)}` : avg.toFixed(1)) : `${avg.toFixed(1)} / 10`;
          valStr += `（${vals.length}件の平均）`;
        }
        ensureSpace(16);
        doc.setFontSize(10);
        doc.text(`${label}：${valStr}`, marginX + 10, y);
        y += 16;
      });
      drawLine(200);
    }

    // ===== 本文：日付順に各レコードを出力 =====
    rows.forEach((row, idx) => {
      if (idx > 0) drawLine(220);

      if (target === 'diary') {
        const moodEmoji = row.mood ? (MOOD_EMOJI[row.mood] || '') : '';
        writeText(`#${pad2(row.seq)}　${row.date}　${row.time}　${moodEmoji}`, 13);
        if (row.tags && row.tags.length > 0) writeText('タグ：' + row.tags.join('、'), 9);
        writeText(row.title, 12);
        writeText(row.body || '', 10);

      } else if (target === 'thought') {
        writeText(formatDateJp(row.date), 13);
        const scores = [
          row.pac            != null ? `②PAC:${row.pac}` : '',
          row.parallelFamily != null ? `③平行(家族):${row.parallelFamily}` : '',
          row.parallelOther  != null ? `③平行(他者):${row.parallelOther}` : '',
          row.objectivity    != null ? `④客観性(A):${row.objectivity}` : '',
          row.selfAffirm     != null ? `⑤自己肯定:${row.selfAffirm}` : '',
          row.otherAffirm    != null ? `⑥他者肯定:${row.otherAffirm}` : '',
          row.emotion        != null ? `⑦感情(FC):${row.emotion}` : '',
          row.mood           != null ? `⑧気分:${row.mood > 0 ? '+' : ''}${row.mood}` : ''
        ].filter(Boolean).join('　');
        if (scores) writeText(scores, 9);
        writeText('【⑨出来事】', 10);
        writeText(row.event || '', 10);

      } else if (target === 'racket') {
        writeText(`${row.date}　#${pad2(row.seq)}　${row.title}`, 13);
        writeText('【①出来事】', 10);
        writeText(row.racket.event   || '（未記入）', 10);
        writeText('【②考え】', 10);
        writeText(row.racket.thought || '（未記入）', 10);
        writeText('【③感情】', 10);
        writeText(row.racket.feeling || '（未記入）', 10);
      }
    });

    const fromSlug = dateFrom ? dateFrom.replace(/-/g, '') : 'all';
    const toSlug   = dateTo   ? dateTo.replace(/-/g, '')   : 'all';
    doc.save(`search_${target}_${fromSlug}-${toSlug}.pdf`);
    showToast('PDFを保存しました 📄');
  } catch (err) {
    showError('PDF出力に失敗しました', err);
  }
}
