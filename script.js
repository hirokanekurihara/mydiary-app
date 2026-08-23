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
const DB_VERSION = 3;               // ★ 2 → 3 に変更
const STORE_NAME = 'entries';
const THOUGHT_STORE = 'thoughts';
const VOICE_STORE = 'voices';       // ★ 追加



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
      // ★心のメモ用ストア（idの自動連番を主キーにする）
      if (!db.objectStoreNames.contains(VOICE_STORE)) {
        db.createObjectStore(VOICE_STORE, { keyPath: 'id', autoIncrement: true });
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
      // ★変更点：通し番号(seq)順ではなく、時刻(time)が早い順（古い順）に並べる
      const rows = (req.result || []).sort((a, b) => {
        if (a.time !== b.time) return a.time < b.time ? -1 : 1;
        return (a.seq || 0) - (b.seq || 0); // 時刻が同じ場合のみ、通し番号で並べる
      });
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
    if (viewId === 'view-voice') {
    showVoiceListView();
    refreshVoiceList();
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
      filtered.sort((a, b) => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;       // 日付の古い順
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;       // 同じ日付内は時刻の古い順
  return (a.seq || 0) - (b.seq || 0);                            // 時刻も同じ場合のフォールバック
});

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
      filtered.sort((a, b) => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;       // 日付の古い順
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;       // 同じ日付内は時刻の古い順
  return (a.seq || 0) - (b.seq || 0);                            // 時刻も同じ場合のフォールバック
});

      renderSearchRacketCards(listEl, filtered);
      emptyEl.hidden = filtered.length > 0;
      appState.lastSearchResults = filtered;
      pdfBtn.hidden = filtered.length === 0;
    }
  } catch (err) {
    showError('検索に失敗しました', err);
  }
}
