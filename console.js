/**
 * 現場物料與多階製程管理系統 - 主控台、現場表單與 BOM 編輯器 (Part 3: console.js)
 * ----------------------------------------------------------------------
 * 搭配 Part 1 (database.rules.json, Code.gs) 與 Part 2 (index.html, style.css, engine.js)
 * 特性：
 * 1. 所有寫入皆採 Firebase 多路徑原子更新，同步寫入 public_view、audit_logs 與 sync_queue。
 * 2. 外部即時同步刷新時，絕不清空使用者正在填寫的現場表單或 BOM 草稿。
 * 3. 本機展示模式可直接模擬管理員登入，離線即可完整測試所有主控台功能。
 * 4. 修正載入順序與登入驗證觸發時機，確保彈窗選完 Gmail 後立即解鎖主控台或明確提示白名單狀態。
 */

window.AppConsole = (function () {
  const S = window.AppState;
  const E = window.AppEngine;

  const DRAFT_KEY = 'factory_wms_field_draft_v1';
  const LAST_WORKLOG_KEY = 'factory_wms_last_worklog_v1';

  const CState = {
    initialized: false,
    mounted: false,
    isVerifyingAuth: false,
    fieldType: 'WORKLOG', // INBOUND | WORKLOG | OUTBOUND | ADJUST
    replacesTxId: null,
    ledgerSearch: '',
    ledgerStatus: 'ALL',
    adminSubTab: 'schedules', // schedules | whitelist | items | audit
    whitelist: {},
    auditLogs: {},
    bomEditorOpen: false,
    bomDraft: null,
    listenersAttached: false
  };

  /* ==================== 0. 注入主控台專屬樣式（免修改 style.css） ==================== */
  function injectConsoleStyles() {
    if (document.getElementById('console-injected-styles')) return;
    const style = document.createElement('style');
    style.id = 'console-injected-styles';
    style.textContent = `
      .field-mode-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
      .big-mode-btn {
        border: 2px solid var(--border); background: var(--surface); border-radius: 14px;
        padding: 16px 10px; cursor: pointer; text-align: center; transition: all 0.15s;
        display: flex; flex-direction: column; align-items: center; gap: 6px; font-weight: 700; font-size: 0.96rem;
      }
      .big-mode-btn .ico { font-size: 1.75rem; line-height: 1; }
      .big-mode-btn.active { border-color: var(--primary); background: var(--blue-bg); color: #1e3a8a; box-shadow: var(--shadow); }
      body.mode-mobile .field-mode-grid { grid-template-columns: repeat(2, 1fr); }
      body.mode-mobile .big-mode-btn { padding: 18px 8px; font-size: 1rem; }

      .replace-banner {
        background: #fffbeb; border: 2px solid #f59e0b; color: #92400e;
        padding: 10px 14px; border-radius: 10px; margin-bottom: 14px;
        display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;
      }
      .shortcut-card {
        background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px;
        padding: 10px 14px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;
      }
      .rework-toggle-box {
        background: #fff7ed; border: 1px solid #fdba74; border-radius: 10px;
        padding: 10px 12px; margin: 10px 0; display: flex; align-items: flex-start; gap: 10px;
      }
      .rework-toggle-box input { width: 20px; height: 20px; margin-top: 2px; flex-shrink: 0; }

      .mat-alloc-card {
        background: var(--surface-alt); border: 1px solid var(--border); border-radius: 10px;
        padding: 12px; margin-bottom: 10px;
      }
      .mat-alloc-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
      .lot-split-row { display: grid; grid-template-columns: 1fr 110px auto; gap: 8px; margin-bottom: 6px; align-items: center; }

      /* BOM 積木編輯器 */
      .bom-studio { margin-bottom: 18px; border: 2px solid #93c5fd; }
      .bom-studio-grid { display: grid; grid-template-columns: 1.35fr 0.85fr; gap: 16px; margin-top: 12px; }
      @media (max-width: 960px) { .bom-studio-grid { grid-template-columns: 1fr; } }
      body.mode-mobile .bom-studio-grid { grid-template-columns: 1fr; }
      .step-editor-card {
        background: var(--surface-alt); border: 1px solid #cbd5e1; border-radius: 12px;
        padding: 12px; margin-bottom: 12px;
      }
      .step-editor-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
      .bom-inp-row { display: grid; grid-template-columns: 1fr 110px auto; gap: 8px; margin-bottom: 6px; align-items: center; }
      .bom-preview-box {
        background: #f8fafc; border: 1px dashed #94a3b8; border-radius: 12px; padding: 14px;
        position: sticky; top: 14px;
      }
      .preview-tree-item { border-left: 2px solid var(--primary); padding-left: 10px; margin: 6px 0 6px 8px; font-size: 0.86rem; }

      /* 流水帳作廢列 */
      tr.tx-voided td { text-decoration: line-through; color: var(--muted); background: #f8fafc; opacity: 0.72; }
      tr.tx-reversal td { background: #fef2f2; color: #991b1b; }

      /* 管理員子頁籤 */
      .subtab-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
      .subtab-btn {
        border: 1px solid var(--border); background: var(--surface); border-radius: 999px;
        padding: 7px 14px; font-size: 0.86rem; font-weight: 700; cursor: pointer;
      }
      .subtab-btn.active { background: #7c3aed; color: #fff; border-color: #7c3aed; }

      /* 自訂 Modal */
      .wms-modal-backdrop {
        position: fixed; inset: 0; background: rgba(15, 23, 42, 0.55); z-index: 200;
        display: grid; place-items: center; padding: 16px;
      }
      .wms-modal {
        background: #fff; border-radius: 14px; max-width: 480px; width: 100%;
        padding: 20px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
      }
      .wms-modal h3 { margin: 0 0 8px; }
      .wms-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
      .warn-callout {
        background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b;
        border-radius: 8px; padding: 10px 12px; font-size: 0.86rem; margin: 10px 0;
      }
    `;
    document.head.appendChild(style);
  }

  /* ==================== 工具函式 ==================== */
  function emailToKey(email) {
    return String(email || '').trim().toLowerCase().replace(/\./g, ',');
  }

  function genId(prefix) {
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${rand}`;
  }

  function serverNow() {
    if (!S.isDemoMode && typeof firebase !== 'undefined' && firebase.database && firebase.database.ServerValue) {
      return firebase.database.ServerValue.TIMESTAMP;
    }
    return Date.now();
  }

  function ensureFirebaseRefs() {
    if (S.isDemoMode || typeof firebase === 'undefined' || !firebase.apps || !firebase.apps.length) return;
    if (!S.db) S.db = firebase.database();
    if (!S.authInstance) S.authInstance = firebase.auth();
  }

  function openReasonModal({ title, message, warningHtml = '', placeholder = '請輸入原因（必填）', confirmText = '確認送出' }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'wms-modal-backdrop';
      wrap.innerHTML = `
        <div class="wms-modal">
          <h3>${E.escapeHtml(title)}</h3>
          <p class="muted" style="margin-bottom:10px;">${E.escapeHtml(message)}</p>
          ${warningHtml ? `<div class="warn-callout">${warningHtml}</div>` : ''}
          <textarea id="wms-modal-reason" class="input" rows="3" placeholder="${E.escapeHtml(placeholder)}"></textarea>
          <div class="wms-modal-actions">
            <button type="button" class="btn btn-outline" id="wms-modal-cancel">取消</button>
            <button type="button" class="btn btn-danger" id="wms-modal-ok">${E.escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const input = wrap.querySelector('#wms-modal-reason');
      input.focus();

      const close = (val) => {
        wrap.remove();
        resolve(val);
      };
      wrap.querySelector('#wms-modal-cancel').addEventListener('click', () => close(null));
      wrap.querySelector('#wms-modal-ok').addEventListener('click', () => {
        const val = input.value.trim();
        if (!val) {
          E.showToast('請務必填寫原因以保留操作履歷', 'error');
          input.focus();
          return;
        }
        close(val);
      });
    });
  }

  /* ==================== 1. Gmail 白名單驗證與權限解鎖 ==================== */
  function applyAuthUi() {
    const isAuth = S.auth.isAuthorized;
    const isAdmin = isAuth && S.auth.role === 'admin';

    document.getElementById('btn-login-console').classList.toggle('hidden', isAuth);
    document.getElementById('auth-user-box').classList.toggle('hidden', !isAuth);

    if (isAuth) {
      const badge = document.getElementById('auth-role-badge');
      badge.textContent = isAdmin ? '管理員' : '操作員';
      badge.classList.toggle('admin', isAdmin);
      document.getElementById('auth-user-alias').textContent = S.auth.alias || S.auth.email;
    }

    document.querySelectorAll('.console-only').forEach(el => el.classList.toggle('hidden', !isAuth));
    document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin));

    const bomMount = document.getElementById('console-bom-mount');
    if (bomMount) bomMount.classList.toggle('hidden', !isAdmin);

    if (!isAuth && ['field', 'ledger', 'admin'].includes(S.ui.activeTab)) {
      E.setActiveTab('inventory');
    } else if (!isAdmin && S.ui.activeTab === 'admin') {
      E.setActiveTab('inventory');
    }

    if (isAuth) {
      mountConsolePanels();
      attachPrivateListeners();
    }
  }

  function attachPrivateListeners() {
    if (CState.listenersAttached) return;
    CState.listenersAttached = true;

    if (S.isDemoMode) {
      if (Object.keys(CState.whitelist).length === 0) {
        CState.whitelist = {
          'demo,admin@gmail,com': { email: 'demo.admin@gmail.com', alias: '管理員-展示', role: 'admin', active: true, addedAt: Date.now() - 86400000 },
          'operator01@gmail,com': { email: 'operator01@gmail.com', alias: '現場-02', role: 'operator', active: true, addedAt: Date.now() - 43200000 }
        };
      }
      if (Object.keys(CState.auditLogs).length === 0) {
        CState.auditLogs = {
          'LOG-DEMO-1': { logId: 'LOG-DEMO-1', action: 'TX_CREATE', refTxId: 'TX-DEMO-1', operatorEmail: 'demo.admin@gmail.com', operatorAlias: '倉管-01', customerOrTarget: '供應商甲', reason: '期初進貨展示', serverTime: Date.now() - 400000 },
          'LOG-DEMO-2': { logId: 'LOG-DEMO-2', action: 'TX_CREATE', refTxId: 'TX-DEMO-6', operatorEmail: 'demo.admin@gmail.com', operatorAlias: '倉管-01', customerOrTarget: '下一站-品保出貨區', reason: '展示出貨', serverTime: Date.now() - 50000 }
        };
      }
      renderAdminPanel();
      return;
    }

    ensureFirebaseRefs();
    if (!S.db) return;

    S.db.ref('private_console/audit_logs').limitToLast(200).on('value', snap => {
      CState.auditLogs = snap.val() || {};
      if (S.auth.role === 'admin' && CState.adminSubTab === 'audit') renderAdminPanel();
    });

    if (S.auth.role === 'admin') {
      S.db.ref('private_console/whitelist').on('value', snap => {
        CState.whitelist = snap.val() || {};
        if (CState.adminSubTab === 'whitelist') renderAdminPanel();
      });
    }
  }

  async function verifyWhitelistedUser(user) {
    if (!user || !user.email) {
      resetAuthState();
      return;
    }

    const emailLower = user.email.trim().toLowerCase();
    if (S.auth.isAuthorized && S.auth.email.toLowerCase() === emailLower) {
      return;
    }
    if (CState.isVerifyingAuth) return;
    CState.isVerifyingAuth = true;

    ensureFirebaseRefs();
    const key = emailToKey(emailLower);

    try {
      const snap = await S.db.ref(`private_console/whitelist/${key}`).once('value');
      const rec = snap.val();
      if (rec && rec.active === true && (rec.role === 'admin' || rec.role === 'operator')) {
        S.auth = {
          user,
          isAuthorized: true,
          role: rec.role,
          alias: rec.alias || user.displayName || emailLower.split('@')[0],
          email: emailLower
        };
        applyAuthUi();
        E.showToast(`歡迎回到主控台：${S.auth.alias}（${rec.role === 'admin' ? '管理員' : '操作員'}）`, 'success');
      } else {
        if (S.authInstance) await S.authInstance.signOut();
        resetAuthState();
        alert(`帳號待管理員開通！\n\n您的 Gmail：${emailLower}\n系統鍵值：${key}\n\n請確認 Firebase Realtime Database 的 private_console/whitelist/${key} 已建立且 active 為布林值 true。`);
      }
    } catch (err) {
      if (S.authInstance) await S.authInstance.signOut();
      resetAuthState();
      E.showToast('驗證白名單失敗：' + err.message, 'error');
    } finally {
      CState.isVerifyingAuth = false;
    }
  }

  function resetAuthState() {
    S.auth = { user: null, isAuthorized: false, role: 'public', alias: '', email: '' };
    CState.listenersAttached = false;
    CState.mounted = false;
    applyAuthUi();
  }

  async function handleLoginClick() {
    if (S.isDemoMode) {
      S.auth = {
        user: { email: 'demo.admin@gmail.com' },
        isAuthorized: true,
        role: 'admin',
        alias: '管理員-展示',
        email: 'demo.admin@gmail.com'
      };
      applyAuthUi();
      E.showToast('已進入展示主控台（管理員權限，所有異動僅存於本機記憶體）', 'success');
      return;
    }

    ensureFirebaseRefs();
    if (!S.authInstance) {
      E.showToast('Firebase Auth 尚未就緒，請重新整理網頁', 'error');
      return;
    }

    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const result = await S.authInstance.signInWithPopup(provider);
      if (result && result.user) {
        await verifyWhitelistedUser(result.user);
      }
    } catch (err) {
      if (err.code === 'auth/popup-blocked') {
        await S.authInstance.signInWithRedirect(provider);
      } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
        E.showToast('Google 登入失敗：' + err.message, 'error');
      }
    }
  }

  async function handleLogoutClick() {
    ensureFirebaseRefs();
    if (!S.isDemoMode && S.authInstance) {
      await S.authInstance.signOut();
    }
    resetAuthState();
    E.showToast('已登出主控台，切回公開檢視模式');
  }

  /* ==================== 2. 統一原子寫入層（同時相容 Firebase 與展示模式） ==================== */
  async function commitMultiPath(updates) {
    if (S.isDemoMode) {
      Object.keys(updates).forEach(path => {
        applyDemoPath(path, updates[path]);
      });
      E.recomputeAndRender();
      return;
    }
    ensureFirebaseRefs();
    await S.db.ref().update(updates);
  }

  function applyDemoPath(path, val) {
    const parts = path.split('/').filter(Boolean);
    const rootMap = {
      public_view: {
        items: S.items,
        boms: S.boms,
        transactions: S.transactions,
        schedules: S.schedules,
        meta: { processes: S.processes }
      },
      private_console: {
        whitelist: CState.whitelist,
        audit_logs: CState.auditLogs,
        sync_queue: {},
        sync_flags: {}
      }
    };
    let cur = rootMap;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    const last = parts[parts.length - 1];
    if (val === null) delete cur[last];
    else cur[last] = val;
  }

  /* ==================== 3. 現場大按鈕登錄表單 (#console-field-mount) ==================== */
  function mountConsolePanels() {
    if (!CState.mounted) {
      CState.mounted = true;
      renderFieldPanel();
      renderLedgerPanel();
      if (S.auth.role === 'admin') {
        renderBomEditorContainer();
        renderAdminPanel();
      }
    } else {
      renderLedgerTableBody();
      if (S.auth.role === 'admin') {
        renderBomEditorContainer();
        renderAdminPanel();
      }
    }
  }

  function getAvailableLotsForItem(itemCode) {
    const list = [];
    Object.keys(S.computed.lots || {}).forEach(k => {
      if (k.startsWith(`${itemCode}||`)) {
        const lotNo = k.split('||')[1];
        const qty = E.roundQty(S.computed.lots[k]);
        if (Math.abs(qty) > 0.0001) {
          list.push({ lotNo, qty });
        }
      }
    });
    return list.sort((a, b) => {
      if (a.lotNo === 'INIT') return -1;
      if (b.lotNo === 'INIT') return 1;
      return a.lotNo.localeCompare(b.lotNo);
    });
  }

  function autoAllocateFifo(itemCode, requiredQty) {
    const avail = getAvailableLotsForItem(itemCode).filter(l => l.qty > 0);
    const allocs = [];
    let remain = E.roundQty(requiredQty);

    for (const l of avail) {
      if (remain <= 0.0001) break;
      const take = E.roundQty(Math.min(l.qty, remain));
      allocs.push({ lotNo: l.lotNo, qty: take });
      remain = E.roundQty(remain - take);
    }
    if (remain > 0.0001) {
      if (allocs.length > 0) {
        allocs[allocs.length - 1].qty = E.roundQty(allocs[allocs.length - 1].qty + remain);
      } else {
        allocs.push({ lotNo: 'UNASSIGNED-NEG', qty: remain });
      }
    }
    return allocs;
  }

  function renderFieldPanel(prefill = null) {
    const mount = document.getElementById('console-field-mount');
    if (!mount || !S.auth.isAuthorized) return;

    const lastWork = (() => {
      try { return JSON.parse(localStorage.getItem(LAST_WORKLOG_KEY) || 'null'); } catch { return null; }
    })();

    const modeBtns = [
      { id: 'INBOUND', ico: '📥', label: '進貨入庫' },
      { id: 'WORKLOG', ico: '⚙️', label: '每日報工' },
      { id: 'OUTBOUND', ico: '🚚', label: '成品/半成品出貨' },
      { id: 'ADJUST', ico: '⚖️', label: '盤點調整' }
    ];

    const replaceBanner = CState.replacesTxId
      ? `<div class="replace-banner">
          <span>♻️ <strong>作廢重填模式</strong>：送出後新單將自動關聯原單 <code>${E.escapeHtml(CState.replacesTxId)}</code></span>
          <button type="button" class="btn btn-outline btn-sm" id="btn-cancel-replace">取消關聯</button>
        </div>`
      : '';

    const lastWorkCard = (CState.fieldType === 'WORKLOG' && lastWork && !prefill)
      ? `<div class="shortcut-card">
          <div>
            <strong>⚡ 延續上次報工：</strong>
            ${E.escapeHtml(lastWork.itemCode)} ｜ 站${lastWork.stepSeq} ${E.escapeHtml(lastWork.processName)}
            ${lastWork.lotNo ? `｜批號 <code>${E.escapeHtml(lastWork.lotNo)}</code>` : ''}
          </div>
          <button type="button" class="btn btn-primary btn-sm" id="btn-continue-last-work">一鍵帶入</button>
        </div>`
      : '';

    mount.innerHTML = `
      <div class="panel-header">
        <div>
          <h2>現場快速登錄（實名綁定：${E.escapeHtml(S.auth.alias)}）</h2>
          <p class="muted">所有送出紀錄皆綁定伺服器時間與 Gmail 履歷，並自動排入背景同步寫回 Google 試算表。</p>
        </div>
      </div>

      ${replaceBanner}

      <div class="field-mode-grid">
        ${modeBtns.map(b => `
          <button type="button" class="big-mode-btn ${CState.fieldType === b.id ? 'active' : ''}" data-field-mode="${b.id}">
            <span class="ico">${b.ico}</span>
            <span>${b.label}</span>
          </button>`).join('')}
      </div>

      ${lastWorkCard}

      <div class="card" id="field-form-card"></div>
    `;

    mount.querySelectorAll('[data-field-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        CState.fieldType = btn.dataset.fieldMode;
        CState.replacesTxId = null;
        renderFieldPanel();
      });
    });

    const cancelRep = mount.querySelector('#btn-cancel-replace');
    if (cancelRep) {
      cancelRep.addEventListener('click', () => {
        CState.replacesTxId = null;
        renderFieldPanel();
      });
    }

    const contBtn = mount.querySelector('#btn-continue-last-work');
    if (contBtn && lastWork) {
      contBtn.addEventListener('click', () => renderFieldFormBody(lastWork));
    }

    renderFieldFormBody(prefill);
  }

  function buildItemOptionsHtml(filterTypes = null, selected = '') {
    const codes = Object.keys(S.items || {}).sort().filter(c => {
      if (!filterTypes) return true;
      return filterTypes.includes(S.items[c].type);
    });
    if (codes.length === 0) return `<option value="">（尚無可選料號）</option>`;
    return codes.map(c => {
      const it = S.items[c];
      const stk = E.roundQty(S.computed.stock[c] || 0);
      return `<option value="${E.escapeHtml(c)}" ${c === selected ? 'selected' : ''}>${E.escapeHtml(c)} — ${E.escapeHtml(it.name || '')}［現存 ${stk} ${E.escapeHtml(it.unit || '')}］</option>`;
    }).join('');
  }

  function renderFieldFormBody(prefill = null) {
    const card = document.getElementById('field-form-card');
    if (!card) return;

    const draft = prefill || (() => {
      try {
        const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
        return (saved && saved.fieldType === CState.fieldType) ? saved : null;
      } catch { return null; }
    })();

    const txDate = (draft && draft.txDate) || E.todayStr();

    if (CState.fieldType === 'INBOUND') {
      const itemCode = (draft && draft.itemCode) || Object.keys(S.items).sort()[0] || '';
      card.innerHTML = `
        <h3>📥 進貨與原料批號登錄</h3>
        <form id="form-inbound">
          <div class="form-row-2">
            <div>
              <label>進貨日期</label>
              <input type="date" id="in-date" class="input" required value="${E.escapeHtml(txDate)}" />
            </div>
            <div>
              <label>進貨型號</label>
              <select id="in-item" class="input" required>${buildItemOptionsHtml(null, itemCode)}</select>
            </div>
          </div>
          <div class="form-row-2">
            <div>
              <label>進貨數量</label>
              <input type="number" id="in-qty" class="input" step="0.0001" min="0.0001" required value="${draft && draft.goodQty ? draft.goodQty : ''}" placeholder="例如 100" />
            </div>
            <div>
              <label>原料批號（供應商批號／必填供追溯）</label>
              <input type="text" id="in-lot" class="input" required value="${E.escapeHtml((draft && draft.lotNo) || '')}" placeholder="例如 LOT-261127-01" />
            </div>
          </div>
          <div class="form-row-2">
            <div>
              <label>供應商／來源（僅存私密履歷）</label>
              <input type="text" id="in-supplier" class="input" value="${E.escapeHtml((draft && draft.customerOrTarget) || '')}" placeholder="選填，公開頁面不可見" />
            </div>
            <div>
              <label>備註</label>
              <input type="text" id="in-note" class="input" value="${E.escapeHtml((draft && draft.reason) || '')}" placeholder="選填" />
            </div>
          </div>
          <button type="submit" class="btn btn-success btn-lg btn-block">✅ 確認送出進貨入庫</button>
        </form>`;

      card.querySelector('#form-inbound').addEventListener('submit', handleInboundSubmit);
      attachDraftAutoSave(card, () => ({
        fieldType: 'INBOUND',
        txDate: card.querySelector('#in-date').value,
        itemCode: card.querySelector('#in-item').value,
        goodQty: card.querySelector('#in-qty').value,
        lotNo: card.querySelector('#in-lot').value,
        customerOrTarget: card.querySelector('#in-supplier').value,
        reason: card.querySelector('#in-note').value
      }));
      return;
    }

    if (CState.fieldType === 'OUTBOUND') {
      const openScheds = Object.values(S.schedules || {}).filter(s => s && s.status !== 'CLOSED' && (Number(s.qty) - (Number(s.shippedQty) || 0)) > 0);
      const schedOpts = `<option value="">（不綁定排程，直接出貨／移轉）</option>` + openScheds.map(s => {
        const rem = E.roundQty(Number(s.qty) - (Number(s.shippedQty) || 0));
        return `<option value="${E.escapeHtml(s.schedId)}" ${draft && draft.schedId === s.schedId ? 'selected' : ''}>${E.escapeHtml(s.schedId)}｜${E.escapeHtml(s.dueDate)}｜${E.escapeHtml(s.itemCode)}（欠 ${rem}）</option>`;
      }).join('');

      const initItem = (draft && draft.itemCode) || Object.keys(S.items).filter(c => S.items[c].type !== 'RAW')[0] || Object.keys(S.items)[0] || '';

      card.innerHTML = `
        <h3>🚚 成品／半成品出貨登錄</h3>
        <form id="form-outbound">
          <div class="form-row">
            <label>關聯出貨排程（選填，送出後自動累加已出貨數）</label>
            <select id="out-sched" class="input">${schedOpts}</select>
          </div>
          <div class="form-row-2">
            <div>
              <label>出貨日期</label>
              <input type="date" id="out-date" class="input" required value="${E.escapeHtml(txDate)}" />
            </div>
            <div>
              <label>出貨型號（成品或半成品）</label>
              <select id="out-item" class="input" required>${buildItemOptionsHtml(null, initItem)}</select>
            </div>
          </div>
          <div class="form-row-2">
            <div>
              <label>出貨批號（供客訴雙向追溯）</label>
              <input type="text" id="out-lot" class="input" list="out-lot-list" required value="${E.escapeHtml((draft && draft.lotNo) || '')}" placeholder="選擇或輸入生產批號" />
              <datalist id="out-lot-list"></datalist>
              <div id="out-lot-hint" class="muted" style="margin-top:4px;"></div>
            </div>
            <div>
              <label>出貨數量</label>
              <input type="number" id="out-qty" class="input" step="0.0001" min="0.0001" required value="${draft && draft.goodQty ? draft.goodQty : ''}" placeholder="例如 20" />
            </div>
          </div>
          <div class="form-row-2">
            <div>
              <label>下一端／客戶對象（僅存私密履歷）</label>
              <input type="text" id="out-target" class="input" value="${E.escapeHtml((draft && draft.customerOrTarget) || '')}" placeholder="例如 下一站品保 / 客戶名稱" />
            </div>
            <div>
              <label>備註</label>
              <input type="text" id="out-note" class="input" value="${E.escapeHtml((draft && draft.reason) || '')}" placeholder="選填" />
            </div>
          </div>
          <button type="submit" class="btn btn-primary btn-lg btn-block">🚚 確認送出出貨紀錄</button>
        </form>`;

      const itemSel = card.querySelector('#out-item');
      const schedSel = card.querySelector('#out-sched');
      const refreshOutLots = () => {
        const lots = getAvailableLotsForItem(itemSel.value);
        card.querySelector('#out-lot-list').innerHTML = lots.map(l => `<option value="${E.escapeHtml(l.lotNo)}">餘量 ${l.qty}</option>`).join('');
        card.querySelector('#out-lot-hint').textContent = lots.length
          ? '現有批號：' + lots.map(l => `${l.lotNo}(${l.qty})`).join('、')
          : '目前無餘量批號（允許先出後補帳）';
        if (!card.querySelector('#out-lot').value && lots.length > 0) {
          card.querySelector('#out-lot').value = lots[0].lotNo;
        }
      };
      itemSel.addEventListener('change', () => {
        card.querySelector('#out-lot').value = '';
        refreshOutLots();
      });
      schedSel.addEventListener('change', () => {
        const sc = S.schedules[schedSel.value];
        if (sc) {
          itemSel.value = sc.itemCode;
          card.querySelector('#out-qty').value = E.roundQty(Math.max(0, Number(sc.qty) - (Number(sc.shippedQty) || 0)));
          card.querySelector('#out-lot').value = '';
          refreshOutLots();
        }
      });
      refreshOutLots();
      card.querySelector('#form-outbound').addEventListener('submit', handleOutboundSubmit);
      return;
    }

    if (CState.fieldType === 'ADJUST') {
      const initItem = (draft && draft.itemCode) || Object.keys(S.items).sort()[0] || '';
      card.innerHTML = `
        <h3>⚖️ 盤點差異調整單（有憑有據修正帳面）</h3>
        <form id="form-adjust">
          <div class="form-row-2">
            <div>
              <label>調整日期</label>
              <input type="date" id="adj-date" class="input" required value="${E.escapeHtml(txDate)}" />
            </div>
            <div>
              <label>料號</label>
              <select id="adj-item" class="input" required>${buildItemOptionsHtml(null, initItem)}</select>
            </div>
          </div>
          <div class="form-row-2">
            <div>
              <label>增減數量（盤盈填正數，盤虧或抽檢留樣填負數）</label>
              <input type="number" id="adj-qty" class="input" step="0.0001" required value="${draft && draft.goodQty ? draft.goodQty : ''}" placeholder="例如 +5 或 -2" />
            </div>
            <div>
              <label>對應批號</label>
              <input type="text" id="adj-lot" class="input" required value="${E.escapeHtml((draft && draft.lotNo) || 'ADJ-' + E.todayStr().replace(/-/g, '').slice(2))}" />
            </div>
          </div>
          <div class="form-row">
            <label>調整原因（必填，寫入 Audit Log）</label>
            <input type="text" id="adj-reason" class="input" required value="${E.escapeHtml((draft && draft.reason) || '')}" placeholder="例如 月底實物盤點盤盈 / 品管破壞性抽檢 2 顆" />
          </div>
          <button type="submit" class="btn btn-warning btn-lg btn-block">⚖️ 確認寫入盤點調整單</button>
        </form>`;
      card.querySelector('#form-adjust').addEventListener('submit', handleAdjustSubmit);
      return;
    }

    // ==================== WORKLOG（每日製程報工，支援重工與多批號混批） ====================
    const bomCodes = Object.keys(S.boms || {}).sort();
    if (bomCodes.length === 0) {
      card.innerHTML = `<div class="empty-state">尚未建立任何製程 BOM 配方。請由管理員至「🧩 製程 BOM」建立配方後再進行報工。</div>`;
      return;
    }

    const initItem = (draft && draft.itemCode && S.boms[draft.itemCode]) ? draft.itemCode : bomCodes[0];
    card.innerHTML = `
      <h3>⚙️ 每日製程報工單（自動依 BOM 扣料／移轉站間 WIP）</h3>
      <form id="form-worklog">
        <div class="form-row-2">
          <div>
            <label>報工日期</label>
            <input type="date" id="wk-date" class="input" required value="${E.escapeHtml(txDate)}" />
          </div>
          <div>
            <label>生產型號（已建 BOM）</label>
            <select id="wk-item" class="input" required>
              ${bomCodes.map(c => `<option value="${E.escapeHtml(c)}" ${c === initItem ? 'selected' : ''}>${E.escapeHtml(c)} — ${E.escapeHtml((S.items[c] && S.items[c].name) || '')}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="form-row">
          <label>執行製程站別</label>
          <select id="wk-step" class="input" required></select>
          <div id="wk-step-info" class="muted" style="margin-top:6px;"></div>
        </div>

        <label class="rework-toggle-box">
          <input type="checkbox" id="wk-is-rework" ${draft && draft.isRework ? 'checked' : ''} />
          <div>
            <strong>🔁 此筆為「重工報工（Rework）」</strong>
            <div class="muted" style="margin:0;">勾選後只消化本站待重工池，<strong>絕不二次扣減原料或上一站 WIP</strong>。</div>
          </div>
        </label>

        <div class="form-row-2" style="grid-template-columns: repeat(3, 1fr);">
          <div>
            <label>良品數</label>
            <input type="number" id="wk-good" class="input" step="0.0001" min="0" required value="${draft && draft.goodQty != null ? draft.goodQty : 10}" />
          </div>
          <div>
            <label>報廢不良數</label>
            <input type="number" id="wk-scrap" class="input" step="0.0001" min="0" value="${draft && draft.scrapQty != null ? draft.scrapQty : 0}" />
          </div>
          <div>
            <label>待重工數</label>
            <input type="number" id="wk-rework" class="input" step="0.0001" min="0" value="${draft && draft.reworkQty != null ? draft.reworkQty : 0}" />
          </div>
        </div>

        <div id="wk-materials-box"></div>

        <div class="form-row-2">
          <div>
            <label>產出／生產批號（單料純加工可自動沿用原料批號）</label>
            <input type="text" id="wk-lot" class="input" required value="${E.escapeHtml((draft && draft.lotNo) || '')}" placeholder="自動產生或手動輸入" />
          </div>
          <div>
            <label>今日作業備註</label>
            <input type="text" id="wk-note" class="input" value="${E.escapeHtml((draft && draft.reason) || '')}" placeholder="例如 機台 #2 研磨完成" />
          </div>
        </div>

        <button type="submit" class="btn btn-primary btn-lg btn-block">⚡ 確認送出每日報工</button>
      </form>`;

    const itemSel = card.querySelector('#wk-item');
    const stepSel = card.querySelector('#wk-step');
    const reworkChk = card.querySelector('#wk-is-rework');
    const goodInp = card.querySelector('#wk-good');
    const scrapInp = card.querySelector('#wk-scrap');
    const reworkInp = card.querySelector('#wk-rework');
    const lotInp = card.querySelector('#wk-lot');

    const getCurrentStepCtx = () => {
      const outCode = itemSel.value;
      const bom = S.boms[outCode];
      const steps = (bom && Array.isArray(bom.steps) ? bom.steps : []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const idx = steps.findIndex(st => String(st.seq) === String(stepSel.value));
      const st = steps[idx >= 0 ? idx : 0];
      const prevSt = idx > 0 ? steps[idx - 1] : null;
      const isFinal = idx === steps.length - 1;
      return { outCode, bom, steps, st, prevSt, isFinal };
    };

    const populateSteps = (targetSeq = null) => {
      const bom = S.boms[itemSel.value];
      const steps = (bom && Array.isArray(bom.steps) ? bom.steps : []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
      stepSel.innerHTML = steps.map((st, idx) => {
        const tag = idx === steps.length - 1 ? '（最終完工入庫）' : '（轉入站間 WIP）';
        const outTag = st.isOutsourced ? '［委外］' : '';
        return `<option value="${st.seq}" ${String(st.seq) === String(targetSeq) ? 'selected' : ''}>站 ${st.seq}：${E.escapeHtml(st.processName)}${outTag} ${tag}</option>`;
      }).join('');
      refreshWorklogStepDetail(true);
    };

    const refreshWorklogStepDetail = (autoResetLot = false, presetConsumed = null) => {
      const { outCode, st, prevSt, isFinal } = getCurrentStepCtx();
      if (!st) return;

      const isRework = reworkChk.checked;
      reworkInp.disabled = isRework;
      if (isRework) reworkInp.value = 0;

      const prevWipQty = prevSt ? E.roundQty(S.computed.wip[`${outCode}::站${prevSt.seq}`] || 0) : null;
      const reworkPoolQty = E.roundQty(S.computed.wip[`${outCode}::站${st.seq}(待重工)`] || 0);

      let infoParts = [];
      if (prevSt) infoParts.push(`前站（站${prevSt.seq} ${prevSt.processName}）可用 WIP：<strong>${prevWipQty}</strong>`);
      else infoParts.push('此站為首站（直接消耗投入原料）');
      infoParts.push(`本站待重工池：<strong>${reworkPoolQty}</strong>`);
      infoParts.push(isFinal ? '良品將直接<strong>入庫</strong>' : `良品將轉入 <strong>${outCode}::站${st.seq} WIP</strong>`);
      card.querySelector('#wk-step-info').innerHTML = infoParts.join(' ｜ ');

      const totalProcessed = E.roundQty((Number(goodInp.value) || 0) + (Number(scrapInp.value) || 0) + (isRework ? 0 : (Number(reworkInp.value) || 0)));
      const matBox = card.querySelector('#wk-materials-box');

      if (isRework || !Array.isArray(st.inputs) || st.inputs.length === 0) {
        matBox.innerHTML = isRework
          ? `<div class="muted" style="margin-bottom:10px;">🔁 重工模式：不扣減原料與前站 WIP，將從待重工池扣除 ${E.roundQty((Number(goodInp.value) || 0) + (Number(scrapInp.value) || 0))}。</div>`
          : `<div class="muted" style="margin-bottom:10px;">➡️ 本站無新增投入料件，將直接承接並消耗前站 WIP 共 <strong>${totalProcessed}</strong>。</div>`;
      } else {
        matBox.innerHTML = `<div style="margin-bottom:12px;">
          <label style="display:block; font-size:0.84rem; font-weight:700; margin-bottom:6px;">
            📦 本站投入料批號分配（總投入處理數 ${totalProcessed}；支援自動 FIFO 與混批拆扣）
          </label>
          ${st.inputs.map((inp, mIdx) => {
            const needQty = E.roundQty(totalProcessed * (Number(inp.qtyPerUnit) || 0));
            const availStk = E.roundQty(S.computed.stock[inp.itemCode] || 0);
            const warn = availStk < needQty ? `<span class="badge badge-red">庫存僅 ${availStk}（將轉負庫存待補帳）</span>` : `<span class="badge badge-green">現存 ${availStk}</span>`;
            const lots = getAvailableLotsForItem(inp.itemCode);

            let allocs = [];
            if (presetConsumed && Array.isArray(presetConsumed)) {
              allocs = presetConsumed.filter(c => c.itemCode === inp.itemCode).map(c => ({ lotNo: c.lotNo, qty: c.qty }));
            }
            if (allocs.length === 0) {
              allocs = needQty > 0 ? autoAllocateFifo(inp.itemCode, needQty) : [{ lotNo: (lots[0] && lots[0].lotNo) || 'INIT', qty: 0 }];
            }

            const lotDatalistId = `wk-dl-${mIdx}`;
            return `
              <div class="mat-alloc-card" data-mat-code="${E.escapeHtml(inp.itemCode)}" data-mat-need="${needQty}">
                <div class="mat-alloc-head">
                  <div>
                    <strong>${E.escapeHtml(inp.itemCode)}</strong>（每單位 × ${inp.qtyPerUnit}，共需 <strong>${needQty}</strong>）
                    ${warn}
                  </div>
                  <button type="button" class="btn btn-outline btn-sm" data-add-split="${mIdx}">＋ 混批拆分</button>
                </div>
                <datalist id="${lotDatalistId}">
                  ${lots.map(l => `<option value="${E.escapeHtml(l.lotNo)}">餘量 ${l.qty}</option>`).join('')}
                </datalist>
                <div class="split-rows" data-split-box="${mIdx}">
                  ${allocs.map(a => `
                    <div class="lot-split-row">
                      <input type="text" class="input split-lot" list="${lotDatalistId}" value="${E.escapeHtml(a.lotNo)}" placeholder="原料批號" required />
                      <input type="number" class="input split-qty" step="0.0001" min="0" value="${a.qty}" required />
                      <button type="button" class="btn btn-outline btn-sm btn-rm-split">✕</button>
                    </div>`).join('')}
                </div>
              </div>`;
          }).join('')}
        </div>`;

        matBox.querySelectorAll('[data-add-split]').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = btn.dataset.addSplit;
            const box = matBox.querySelector(`[data-split-box="${idx}"]`);
            const row = document.createElement('div');
            row.className = 'lot-split-row';
            row.innerHTML = `
              <input type="text" class="input split-lot" list="wk-dl-${idx}" placeholder="輸入另一批號" required />
              <input type="number" class="input split-qty" step="0.0001" min="0" value="0" required />
              <button type="button" class="btn btn-outline btn-sm btn-rm-split">✕</button>`;
            row.querySelector('.btn-rm-split').addEventListener('click', () => row.remove());
            box.appendChild(row);
          });
        });
        matBox.querySelectorAll('.btn-rm-split').forEach(btn => {
          btn.addEventListener('click', () => {
            const box = btn.closest('.split-rows');
            if (box.querySelectorAll('.lot-split-row').length > 1) btn.closest('.lot-split-row').remove();
          });
        });
      }

      if (autoResetLot || !lotInp.value) {
        if (st.inheritLot) {
          const firstSplitLot = matBox.querySelector('.split-lot');
          if (firstSplitLot && firstSplitLot.value && firstSplitLot.value !== 'UNASSIGNED-NEG') {
            lotInp.value = firstSplitLot.value;
          } else if (prevSt) {
            const recentPrev = Object.values(S.transactions || {})
              .filter(t => t && t.status === 'ACTIVE' && t.txType === 'WORKLOG' && t.itemCode === outCode && String(t.stepSeq) === String(prevSt.seq))
              .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
            lotInp.value = (recentPrev && recentPrev.lotNo) || `WO-${E.todayStr().replace(/-/g, '').slice(2)}-${outCode}`;
          } else {
            lotInp.value = `WO-${E.todayStr().replace(/-/g, '').slice(2)}-${outCode}`;
          }
        } else {
          const seqTail = String(Date.now()).slice(-3);
          lotInp.value = `WO-${E.todayStr().replace(/-/g, '').slice(2)}-${outCode}-${seqTail}`;
        }
      }
    };

    itemSel.addEventListener('change', () => populateSteps());
    stepSel.addEventListener('change', () => refreshWorklogStepDetail(true));
    reworkChk.addEventListener('change', () => refreshWorklogStepDetail(false));
    [goodInp, scrapInp, reworkInp].forEach(el => {
      el.addEventListener('input', () => refreshWorklogStepDetail(false));
    });

    populateSteps(draft && draft.stepSeq);
    if (draft && draft.consumedLots) {
      refreshWorklogStepDetail(false, draft.consumedLots);
      if (draft.lotNo) lotInp.value = draft.lotNo;
    }

    card.querySelector('#form-worklog').addEventListener('submit', e => handleWorklogSubmit(e, getCurrentStepCtx));
    attachDraftAutoSave(card, () => ({
      fieldType: 'WORKLOG',
      txDate: card.querySelector('#wk-date').value,
      itemCode: itemSel.value,
      stepSeq: Number(stepSel.value),
      isRework: reworkChk.checked,
      goodQty: Number(goodInp.value) || 0,
      scrapQty: Number(scrapInp.value) || 0,
      reworkQty: Number(reworkInp.value) || 0,
      lotNo: lotInp.value,
      reason: card.querySelector('#wk-note').value
    }));
  }

  function attachDraftAutoSave(container, getter) {
    container.addEventListener('input', () => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(getter())); } catch {}
    });
  }

  /* ==================== 現場送單處理（原子寫入 public + audit + sync_queue） ==================== */
  async function submitStandardTx(tx, { customerOrTarget = '', reason = '', extraUpdates = {} }) {
    const ts = serverNow();
    const logId = genId('LOG');
    const queueId = genId('Q');

    tx.createdAt = ts;
    tx.operatorAlias = S.auth.alias;
    if (CState.replacesTxId) {
      tx.replacesTxId = CState.replacesTxId;
    }

    const auditRec = {
      logId,
      action: 'TX_CREATE',
      refTxId: tx.txId,
      operatorEmail: S.auth.email,
      operatorAlias: S.auth.alias,
      customerOrTarget: customerOrTarget || '',
      reason: reason || '',
      serverTime: ts
    };

    const queueRec = {
      logId,
      action: 'TX_CREATE',
      refTxId: tx.txId,
      tx,
      operatorEmail: S.auth.email,
      operatorAlias: S.auth.alias,
      customerOrTarget: customerOrTarget || '',
      reason: reason || '',
      serverTime: ts
    };

    const updates = Object.assign({}, extraUpdates, {
      [`public_view/transactions/${tx.txId}`]: tx,
      [`private_console/audit_logs/${logId}`]: auditRec,
      [`private_console/sync_queue/${queueId}`]: queueRec,
      'private_console/sync_flags/mirrorDirty': true
    });

    await commitMultiPath(updates);
    localStorage.removeItem(DRAFT_KEY);
    CState.replacesTxId = null;
  }

  async function handleInboundSubmit(e) {
    e.preventDefault();
    const tx = {
      txId: genId('IN'),
      txType: 'INBOUND',
      status: 'ACTIVE',
      txDate: document.getElementById('in-date').value,
      itemCode: document.getElementById('in-item').value,
      goodQty: E.roundQty(document.getElementById('in-qty').value),
      scrapQty: 0,
      reworkQty: 0,
      lotNo: document.getElementById('in-lot').value.trim(),
      consumedLots: []
    };
    if (!tx.itemCode || tx.goodQty <= 0 || !tx.lotNo) {
      return E.showToast('請填寫型號、正數進貨量與原料批號', 'error');
    }
    try {
      await submitStandardTx(tx, {
        customerOrTarget: document.getElementById('in-supplier').value.trim(),
        reason: document.getElementById('in-note').value.trim()
      });
      E.showToast(`進貨單 ${tx.txId} 已入庫！`, 'success');
      renderFieldPanel();
    } catch (err) {
      E.showToast('寫入失敗：' + err.message, 'error');
    }
  }

  async function handleOutboundSubmit(e) {
    e.preventDefault();
    const schedId = document.getElementById('out-sched').value;
    const tx = {
      txId: genId('OUT'),
      txType: 'OUTBOUND',
      status: 'ACTIVE',
      txDate: document.getElementById('out-date').value,
      itemCode: document.getElementById('out-item').value,
      goodQty: E.roundQty(document.getElementById('out-qty').value),
      scrapQty: 0,
      reworkQty: 0,
      lotNo: document.getElementById('out-lot').value.trim(),
      schedId: schedId || '',
      consumedLots: []
    };
    if (!tx.itemCode || tx.goodQty <= 0 || !tx.lotNo) {
      return E.showToast('請填寫出貨型號、數量與批號', 'error');
    }

    const extraUpdates = {};
    if (schedId && S.schedules[schedId]) {
      const sc = S.schedules[schedId];
      const newShipped = E.roundQty((Number(sc.shippedQty) || 0) + tx.goodQty);
      extraUpdates[`public_view/schedules/${schedId}/shippedQty`] = newShipped;
      if (newShipped >= Number(sc.qty)) {
        extraUpdates[`public_view/schedules/${schedId}/status`] = 'CLOSED';
      }
    }

    try {
      await submitStandardTx(tx, {
        customerOrTarget: document.getElementById('out-target').value.trim(),
        reason: document.getElementById('out-note').value.trim(),
        extraUpdates
      });
      E.showToast(`出貨單 ${tx.txId} 已完成扣帳！`, 'success');
      renderFieldPanel();
    } catch (err) {
      E.showToast('寫入失敗：' + err.message, 'error');
    }
  }

  async function handleAdjustSubmit(e) {
    e.preventDefault();
    const qty = E.roundQty(document.getElementById('adj-qty').value);
    const reason = document.getElementById('adj-reason').value.trim();
    if (!qty || !reason) {
      return E.showToast('調整數量不可為 0 且必須填寫原因', 'error');
    }
    const tx = {
      txId: genId('ADJ'),
      txType: 'ADJUST',
      status: 'ACTIVE',
      txDate: document.getElementById('adj-date').value,
      itemCode: document.getElementById('adj-item').value,
      goodQty: qty,
      scrapQty: 0,
      reworkQty: 0,
      lotNo: document.getElementById('adj-lot').value.trim(),
      consumedLots: []
    };
    try {
      await submitStandardTx(tx, { reason });
      E.showToast(`盤點調整單 ${tx.txId} 已生效！`, 'success');
      renderFieldPanel();
    } catch (err) {
      E.showToast('寫入失敗：' + err.message, 'error');
    }
  }

  async function handleWorklogSubmit(e, getCurrentStepCtx) {
    e.preventDefault();
    const { outCode, bom, st, prevSt, isFinal } = getCurrentStepCtx();
    if (!st) return E.showToast('找不到選取的製程站別', 'error');

    const isRework = document.getElementById('wk-is-rework').checked;
    const goodQty = E.roundQty(document.getElementById('wk-good').value);
    const scrapQty = E.roundQty(document.getElementById('wk-scrap').value);
    const reworkQty = isRework ? 0 : E.roundQty(document.getElementById('wk-rework').value);
    const lotNo = document.getElementById('wk-lot').value.trim();

    if (goodQty + scrapQty + reworkQty <= 0) {
      return E.showToast('良品、報廢或待重工數至少需有一項大於 0', 'error');
    }
    if (!lotNo) return E.showToast('請填寫生產／產出批號', 'error');

    const consumedLots = [];
    if (!isRework) {
      const matCards = document.querySelectorAll('#wk-materials-box .mat-alloc-card');
      for (const mc of matCards) {
        const mCode = mc.dataset.matCode;
        const rows = mc.querySelectorAll('.lot-split-row');
        for (const r of rows) {
          const lNo = r.querySelector('.split-lot').value.trim();
          const q = E.roundQty(r.querySelector('.split-qty').value);
          if (q > 0) {
            if (!lNo) return E.showToast(`請填寫材料 ${mCode} 的消耗批號`, 'error');
            consumedLots.push({ itemCode: mCode, lotNo: lNo, qty: q });
          }
        }
      }
    }

    const tx = {
      txId: genId('WK'),
      txType: 'WORKLOG',
      status: 'ACTIVE',
      txDate: document.getElementById('wk-date').value,
      itemCode: outCode,
      stepSeq: Number(st.seq),
      prevStepSeq: prevSt ? Number(prevSt.seq) : null,
      processName: st.processName,
      isFinalStep: isFinal,
      isRework: isRework,
      goodQty,
      scrapQty,
      reworkQty,
      lotNo,
      consumedLots,
      bomVersion: (bom && bom.version) || 1
    };

    try {
      await submitStandardTx(tx, {
        reason: document.getElementById('wk-note').value.trim()
      });
      localStorage.setItem(LAST_WORKLOG_KEY, JSON.stringify({
        itemCode: outCode, stepSeq: st.seq, processName: st.processName, lotNo
      }));
      E.showToast(`報工單 ${tx.txId} 已完成扣料與入帳！`, 'success');
      renderFieldPanel();
    } catch (err) {
      E.showToast('報工寫入失敗：' + err.message, 'error');
    }
  }

  /* ==================== 4. 流水帳檢視、作廢與作廢重填沖銷 (#console-ledger-mount) ==================== */
  function renderLedgerPanel() {
    const mount = document.getElementById('console-ledger-mount');
    if (!mount || !S.auth.isAuthorized) return;

    mount.innerHTML = `
      <div class="panel-header">
        <div>
          <h2>不可變交易流水帳與作廢沖銷</h2>
          <p class="muted">嚴禁刪除歷史紀錄；填錯請按「作廢」或「作廢重填」，系統將自動押入負數沖銷單並回補批號餘量。</p>
        </div>
      </div>

      <div class="filter-bar">
        <input type="text" id="ledger-search" class="input" placeholder="搜尋單號、型號、批號、製程或操作員..." value="${E.escapeHtml(CState.ledgerSearch)}" />
        <div class="chip-group" id="ledger-status-chips">
          <button type="button" class="chip ${CState.ledgerStatus === 'ALL' ? 'active' : ''}" data-lstatus="ALL">全部紀錄</button>
          <button type="button" class="chip ${CState.ledgerStatus === 'ACTIVE' ? 'active' : ''}" data-lstatus="ACTIVE">有效正常單</button>
          <button type="button" class="chip ${CState.ledgerStatus === 'VOIDED' ? 'active' : ''}" data-lstatus="VOIDED">已作廢</button>
          <button type="button" class="chip ${CState.ledgerStatus === 'REVERSAL' ? 'active' : ''}" data-lstatus="REVERSAL">負數沖銷單</button>
        </div>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>單號 / 時間</th>
              <th>類型 / 站別</th>
              <th>型號 / 批號</th>
              <th class="num">良品 / 報廢 / 重工</th>
              <th>耗料明細 / 關聯單</th>
              <th>操作人</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="ledger-tbody"></tbody>
        </table>
      </div>`;

    mount.querySelector('#ledger-search').addEventListener('input', e => {
      CState.ledgerSearch = e.target.value;
      renderLedgerTableBody();
    });
    mount.querySelectorAll('[data-lstatus]').forEach(btn => {
      btn.addEventListener('click', () => {
        mount.querySelectorAll('[data-lstatus]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        CState.ledgerStatus = btn.dataset.lstatus;
        renderLedgerTableBody();
      });
    });

    renderLedgerTableBody();
  }

  function renderLedgerTableBody() {
    const tbody = document.getElementById('ledger-tbody');
    if (!tbody) return;

    const kw = CState.ledgerSearch.trim().toLowerCase();
    const list = Object.values(S.transactions || {})
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .filter(tx => {
        if (CState.ledgerStatus === 'ACTIVE' && (tx.status !== 'ACTIVE' || tx.txType === 'REVERSAL')) return false;
        if (CState.ledgerStatus === 'VOIDED' && tx.status !== 'VOIDED') return false;
        if (CState.ledgerStatus === 'REVERSAL' && tx.txType !== 'REVERSAL') return false;
        if (!kw) return true;
        return [tx.txId, tx.itemCode, tx.lotNo, tx.processName, tx.operatorAlias, tx.txDate].join(' ').toLowerCase().includes(kw);
      });

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">查無符合條件的流水紀錄</td></tr>`;
      return;
    }

    const typeMap = { INBOUND: '進貨', WORKLOG: '報工', OUTBOUND: '出貨', ADJUST: '盤點調整', REVERSAL: '負數沖銷' };

    tbody.innerHTML = list.map(tx => {
      const rowCls = tx.txType === 'REVERSAL' ? 'tx-reversal' : (tx.status === 'VOIDED' ? 'tx-voided' : '');
      const procTxt = tx.processName ? `站${tx.stepSeq} ${tx.processName}${tx.isRework ? '(重工)' : ''}` : '';
      const typeLabel = tx.txType === 'REVERSAL'
        ? `↩️ 沖銷(${typeMap[tx.reversalOfType] || tx.reversalOfType})`
        : (typeMap[tx.txType] || tx.txType);

      const consumedTxt = Array.isArray(tx.consumedLots) && tx.consumedLots.length > 0
        ? tx.consumedLots.map(c => `${c.itemCode}[${c.lotNo}]×${c.qty}`).join(', ')
        : '';
      const refTxt = tx.refTxId ? `沖銷原單：${tx.refTxId}` : (tx.replacesTxId ? `重填自：${tx.replacesTxId}` : '');

      const canVoid = tx.status === 'ACTIVE' && tx.txType !== 'REVERSAL';
      const actionHtml = canVoid
        ? `<div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button type="button" class="btn btn-outline btn-sm" data-void-id="${E.escapeHtml(tx.txId)}">作廢</button>
            <button type="button" class="btn btn-warning btn-sm" data-refill-id="${E.escapeHtml(tx.txId)}">作廢重填</button>
          </div>`
        : `<span class="badge ${tx.txType === 'REVERSAL' ? 'badge-red' : 'badge-raw'}">${tx.txType === 'REVERSAL' ? '沖銷憑證' : '已作廢'}</span>`;

      return `
        <tr class="${rowCls}">
          <td>
            <strong>${E.escapeHtml(tx.txId)}</strong>
            <div class="muted">${E.escapeHtml(tx.txDate)} · ${E.formatDateTime(tx.createdAt)}</div>
          </td>
          <td>
            <strong>${E.escapeHtml(typeLabel)}</strong>
            <div class="muted">${E.escapeHtml(procTxt)}</div>
          </td>
          <td>
            <strong>${E.escapeHtml(tx.itemCode)}</strong>
            <div><code>${E.escapeHtml(tx.lotNo || '--')}</code></div>
          </td>
          <td class="num">
            <strong>${tx.goodQty}</strong> / ${tx.scrapQty || 0} / ${tx.reworkQty || 0}
          </td>
          <td style="font-size:0.82rem;">
            ${consumedTxt ? `<div>耗料：${E.escapeHtml(consumedTxt)}</div>` : ''}
            ${refTxt ? `<div class="muted">${E.escapeHtml(refTxt)}</div>` : ''}
          </td>
          <td>${E.escapeHtml(tx.operatorAlias || '--')}</td>
          <td>${actionHtml}</td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-void-id]').forEach(btn => {
      btn.addEventListener('click', () => executeVoidFlow(btn.dataset.voidId, false));
    });
    tbody.querySelectorAll('[data-refill-id]').forEach(btn => {
      btn.addEventListener('click', () => executeVoidFlow(btn.dataset.refillId, true));
    });
  }

  function checkDownstreamConsumption(origTx) {
    if (!origTx || !origTx.lotNo) return 0;
    const isSupplyTx = origTx.txType === 'INBOUND' || (origTx.txType === 'WORKLOG' && origTx.isFinalStep);
    if (!isSupplyTx) return 0;

    let downstreamUsed = 0;
    Object.values(S.transactions || {}).forEach(t => {
      if (!t || t.status !== 'ACTIVE' || t.txType === 'REVERSAL' || t.txId === origTx.txId) return;
      if (t.txType === 'OUTBOUND' && t.itemCode === origTx.itemCode && t.lotNo === origTx.lotNo) {
        downstreamUsed += Number(t.goodQty) || 0;
      }
      if (Array.isArray(t.consumedLots)) {
        t.consumedLots.forEach(c => {
          if (c.itemCode === origTx.itemCode && c.lotNo === origTx.lotNo) {
            downstreamUsed += Number(c.qty) || 0;
          }
        });
      }
    });
    return E.roundQty(downstreamUsed);
  }

  async function executeVoidFlow(origTxId, isRefill) {
    const orig = S.transactions[origTxId];
    if (!orig || orig.status !== 'ACTIVE' || orig.txType === 'REVERSAL') {
      return E.showToast('該筆單據不可作廢', 'error');
    }

    const downstreamUsed = checkDownstreamConsumption(orig);
    let warningHtml = '';
    if (downstreamUsed > 0) {
      const currentRemain = E.roundQty(S.computed.lots[`${orig.itemCode}||${orig.lotNo}`] || 0);
      const afterRemain = E.roundQty(currentRemain - (Number(orig.goodQty) || 0));
      warningHtml = `⚠️ <strong>連鎖作廢警示</strong>：批號 <code>${E.escapeHtml(orig.lotNo)}</code> 已被後續報工或出貨消耗共 <strong>${downstreamUsed}</strong> 單位！<br>若強制繼續作廢，該批號餘量將變為 <strong>${afterRemain}</strong>${afterRemain < 0 ? '（將觸發負餘量待補帳警報）' : ''}。建議先作廢下游單據，或確認後再行重填。`;
    }

    const reason = await openReasonModal({
      title: isRefill ? `♻️ 作廢並重填：${origTxId}` : `🗑️ 確認作廢單據：${origTxId}`,
      message: `原單內容：${orig.itemCode}（批號 ${orig.lotNo || '--'}）良品 ${orig.goodQty} / 報廢 ${orig.scrapQty || 0} / 重工 ${orig.reworkQty || 0}。系統將自動建立負數沖銷紀錄。`,
      warningHtml,
      placeholder: '請輸入作廢原因（例如：現場誤植數量 50 應為 500）',
      confirmText: isRefill ? '確認作廢並帶入重填' : '確認作廢沖銷'
    });
    if (!reason) return;

    const ts = serverNow();
    const revTxId = genId('REV');
    const logVoidId = genId('LOGV');
    const logRevId = genId('LOGR');
    const qVoidId = genId('QV');
    const qRevId = genId('QR');

    const revTx = {
      txId: revTxId,
      txType: 'REVERSAL',
      reversalOfType: orig.txType,
      refTxId: orig.txId,
      status: 'ACTIVE',
      txDate: E.todayStr(),
      itemCode: orig.itemCode,
      stepSeq: orig.stepSeq || null,
      prevStepSeq: orig.prevStepSeq || null,
      processName: orig.processName || '',
      isFinalStep: Boolean(orig.isFinalStep),
      isRework: Boolean(orig.isRework),
      goodQty: E.roundQty(-(Number(orig.goodQty) || 0)),
      scrapQty: E.roundQty(-(Number(orig.scrapQty) || 0)),
      reworkQty: E.roundQty(-(Number(orig.reworkQty) || 0)),
      lotNo: orig.lotNo || '',
      consumedLots: Array.isArray(orig.consumedLots)
        ? orig.consumedLots.map(c => ({ itemCode: c.itemCode, lotNo: c.lotNo, qty: E.roundQty(-(Number(c.qty) || 0)) }))
        : [],
      operatorAlias: S.auth.alias,
      createdAt: ts
    };

    const updates = {
      [`public_view/transactions/${orig.txId}/status`]: 'VOIDED',
      [`public_view/transactions/${revTxId}`]: revTx,
      [`private_console/audit_logs/${logVoidId}`]: {
        logId: logVoidId, action: 'TX_VOID', refTxId: orig.txId,
        operatorEmail: S.auth.email, operatorAlias: S.auth.alias,
        customerOrTarget: '', reason, serverTime: ts
      },
      [`private_console/audit_logs/${logRevId}`]: {
        logId: logRevId, action: 'TX_REVERSAL', refTxId: revTxId,
        operatorEmail: S.auth.email, operatorAlias: S.auth.alias,
        customerOrTarget: '', reason: `沖銷原單 ${orig.txId}：${reason}`, serverTime: ts
      },
      [`private_console/sync_queue/${qVoidId}`]: {
        logId: logVoidId, action: 'TX_VOID', refTxId: orig.txId,
        operatorEmail: S.auth.email, operatorAlias: S.auth.alias,
        customerOrTarget: '', reason, serverTime: ts
      },
      [`private_console/sync_queue/${qRevId}`]: {
        logId: logRevId, action: 'TX_REVERSAL', refTxId: revTxId, tx: revTx,
        operatorEmail: S.auth.email, operatorAlias: S.auth.alias,
        customerOrTarget: '', reason: `沖銷原單 ${orig.txId}：${reason}`, serverTime: ts
      },
      'private_console/sync_flags/mirrorDirty': true
    };

    if (orig.txType === 'OUTBOUND' && orig.schedId && S.schedules[orig.schedId]) {
      const sc = S.schedules[orig.schedId];
      const backShipped = E.roundQty(Math.max(0, (Number(sc.shippedQty) || 0) - (Number(orig.goodQty) || 0)));
      updates[`public_view/schedules/${orig.schedId}/shippedQty`] = backShipped;
      if (backShipped < Number(sc.qty)) {
        updates[`public_view/schedules/${orig.schedId}/status`] = 'OPEN';
      }
    }

    try {
      await commitMultiPath(updates);
      E.showToast(`已完成作廢並產生沖銷單 ${revTxId}`, 'success');
      if (isRefill) {
        CState.fieldType = orig.txType;
        CState.replacesTxId = orig.txId;
        E.setActiveTab('field');
        renderFieldPanel({
          txDate: orig.txDate,
          itemCode: orig.itemCode,
          stepSeq: orig.stepSeq,
          isRework: orig.isRework,
          goodQty: orig.goodQty,
          scrapQty: orig.scrapQty,
          reworkQty: orig.reworkQty,
          lotNo: orig.lotNo,
          schedId: orig.schedId,
          consumedLots: orig.consumedLots,
          reason: `重填原單 ${orig.txId}`
        });
      }
    } catch (err) {
      E.showToast('作廢失敗：' + err.message, 'error');
    }
  }

  /* ==================== 5. 積木式多階製程 BOM 編輯器 (#console-bom-mount) ==================== */
  function renderBomEditorContainer() {
    const mount = document.getElementById('console-bom-mount');
    if (!mount || S.auth.role !== 'admin') return;

    if (CState.bomEditorOpen && CState.bomDraft && mount.querySelector('#bom-editor-body')) {
      renderBomLivePreview();
      return;
    }

    const producibleCodes = Object.keys(S.items || {}).sort().filter(c => S.items[c].type !== 'RAW');
    const allBomCodes = Object.keys(S.boms || {}).sort();

    mount.innerHTML = `
      <div class="card bom-studio">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
          <div>
            <h3 style="margin:0;">🧩 管理員積木式「多階製程 BOM 編輯器」</h3>
            <div class="muted">本編輯器為 BOM 唯一主檔；存檔自動觸發循環參照防呆、WIP 殘留檢查並背景鏡像回試算表。</div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <select id="bom-edit-selector" class="input" style="width:auto; min-width:210px;">
              <option value="">＋ 選擇既有配方編輯，或新增配方...</option>
              ${producibleCodes.map(c => `<option value="${E.escapeHtml(c)}">${E.escapeHtml(c)} — ${E.escapeHtml(S.items[c].name || '')} ${S.boms[c] ? '(已建BOM)' : '(尚未建檔)'}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-primary btn-sm" id="btn-open-bom-editor">✏️ 開啟編輯</button>
          </div>
        </div>
        <div id="bom-editor-body" class="${CState.bomEditorOpen ? '' : 'hidden'}"></div>
      </div>`;

    mount.querySelector('#btn-open-bom-editor').addEventListener('click', () => {
      const code = mount.querySelector('#bom-edit-selector').value || producibleCodes[0] || allBomCodes[0];
      if (!code) return E.showToast('請先建立至少一個半成品(SEMI)或成品(FG)料號', 'error');
      openBomDraftFor(code);
    });

    if (CState.bomEditorOpen && CState.bomDraft) {
      renderBomEditorWorkspace();
    }
  }

  function openBomDraftFor(outCode) {
    const existing = S.boms[outCode];
    if (existing) {
      CState.bomDraft = JSON.parse(JSON.stringify(existing));
      CState.bomDraft.steps = (CState.bomDraft.steps || []).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    } else {
      CState.bomDraft = {
        outCode,
        pattern: 'SINGLE_PROCESS',
        version: 0,
        steps: [
          { seq: 10, processName: getDefaultProc(0), scrapRate: 0.02, isOutsourced: false, inheritLot: true, inputs: [] }
        ]
      };
    }
    CState.bomEditorOpen = true;
    renderBomEditorWorkspace();
  }

  function getDefaultProc(idx) {
    const list = S.processes.length ? S.processes.map(p => p.name) : ['研磨', '雷雕', '清潔', '組裝', '品檢包裝'];
    return list[idx % list.length];
  }

  function applyBomTemplate(pattern) {
    if (!CState.bomDraft) return;
    const rawFirst = Object.keys(S.items).find(c => S.items[c].type === 'RAW') || '';
    const semiList = Object.keys(S.items).filter(c => S.items[c].type === 'SEMI' && c !== CState.bomDraft.outCode);

    CState.bomDraft.pattern = pattern;
    if (pattern === 'SINGLE_PROCESS') {
      CState.bomDraft.steps = [
        { seq: 10, processName: '研磨', scrapRate: 0.03, isOutsourced: false, inheritLot: true, inputs: rawFirst ? [{ itemCode: rawFirst, qtyPerUnit: 1 }] : [] },
        { seq: 20, processName: '清潔', scrapRate: 0.01, isOutsourced: false, inheritLot: true, inputs: [] }
      ];
    } else if (pattern === 'DIRECT_ASSEMBLY') {
      const twoRaws = Object.keys(S.items).filter(c => S.items[c].type !== 'FG' && c !== CState.bomDraft.outCode).slice(0, 2);
      CState.bomDraft.steps = [
        {
          seq: 10, processName: '組裝', scrapRate: 0.02, isOutsourced: false, inheritLot: false,
          inputs: twoRaws.map(c => ({ itemCode: c, qtyPerUnit: 1 }))
        }
      ];
    } else {
      const mixInputs = [
        ...(semiList.slice(0, 2).map(c => ({ itemCode: c, qtyPerUnit: 2 }))),
        ...(rawFirst ? [{ itemCode: rawFirst, qtyPerUnit: 1 }] : [])
      ];
      CState.bomDraft.steps = [
        { seq: 10, processName: '組裝', scrapRate: 0.02, isOutsourced: false, inheritLot: false, inputs: mixInputs },
        { seq: 20, processName: '品檢包裝', scrapRate: 0.01, isOutsourced: false, inheritLot: true, inputs: [] }
      ];
    }
    renderBomEditorWorkspace();
  }

  function renderBomEditorWorkspace() {
    const body = document.getElementById('bom-editor-body');
    const draft = CState.bomDraft;
    if (!body || !draft) return;
    body.classList.remove('hidden');

    const procNames = Array.from(new Set([
      ...(S.processes || []).map(p => p.name),
      ...draft.steps.map(s => s.processName),
      '研磨', '雷雕', '清潔', '表面處理', '組裝', '品檢包裝'
    ]));
    const allItemCodes = Object.keys(S.items || {}).sort().filter(c => c !== draft.outCode);

    body.innerHTML = `
      <hr style="border:none; border-top:1px solid var(--border); margin:14px 0;" />
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
        <div>
          <strong style="font-size:1.05rem;">正在編輯：${E.escapeHtml(draft.outCode)}（${E.escapeHtml((S.items[draft.outCode] && S.items[draft.outCode].name) || '')}）</strong>
          <span class="badge badge-blue">現行版本 v${draft.version || 0}</span>
        </div>
        <div class="chip-group">
          <span class="muted" style="align-self:center; margin-right:4px;">快速範本：</span>
          <button type="button" class="chip ${draft.pattern === 'SINGLE_PROCESS' ? 'active' : ''}" data-tpl="SINGLE_PROCESS">單料多製程</button>
          <button type="button" class="chip ${draft.pattern === 'DIRECT_ASSEMBLY' ? 'active' : ''}" data-tpl="DIRECT_ASSEMBLY">多料直接組裝</button>
          <button type="button" class="chip ${draft.pattern === 'MULTI_SEMI' ? 'active' : ''}" data-tpl="MULTI_SEMI">多製程半成品複合組裝</button>
        </div>
      </div>

      <div class="bom-studio-grid">
        <div>
          <div id="bom-steps-list">
            ${draft.steps.map((st, sIdx) => `
              <div class="step-editor-card" data-step-idx="${sIdx}">
                <div class="step-editor-top">
                  <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                    <span class="badge badge-semi">站 ${st.seq}</span>
                    ${sIdx > 0 ? `<span class="badge badge-blue">自動承接上一站產出</span>` : `<span class="badge badge-raw">首站</span>`}
                    ${sIdx === draft.steps.length - 1 ? `<span class="badge badge-green">最終完工站</span>` : ''}
                  </div>
                  <div style="display:flex; gap:4px;">
                    <button type="button" class="btn btn-outline btn-sm" data-move-up="${sIdx}" ${sIdx === 0 ? 'disabled' : ''}>↑</button>
                    <button type="button" class="btn btn-outline btn-sm" data-move-down="${sIdx}" ${sIdx === draft.steps.length - 1 ? 'disabled' : ''}>↓</button>
                    <button type="button" class="btn btn-danger btn-sm" data-del-step="${sIdx}" ${draft.steps.length <= 1 ? 'disabled' : ''}>刪站</button>
                  </div>
                </div>

                <div class="form-row-2" style="grid-template-columns: 1.4fr 1fr;">
                  <div>
                    <label>標準製程名稱</label>
                    <select class="input st-proc" data-sidx="${sIdx}">
                      ${procNames.map(p => `<option value="${E.escapeHtml(p)}" ${p === st.processName ? 'selected' : ''}>${E.escapeHtml(p)}</option>`).join('')}
                    </select>
                  </div>
                  <div>
                    <label>預估不良率（%）</label>
                    <input type="number" class="input st-scrap" data-sidx="${sIdx}" min="0" max="90" step="0.5" value="${E.roundQty((Number(st.scrapRate) || 0) * 100)}" />
                  </div>
                </div>

                <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:10px; font-size:0.84rem;">
                  <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
                    <input type="checkbox" class="st-out" data-sidx="${sIdx}" ${st.isOutsourced ? 'checked' : ''} /> 委外加工站
                  </label>
                  <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
                    <input type="checkbox" class="st-inherit" data-sidx="${sIdx}" ${st.inheritLot ? 'checked' : ''} /> 沿用前批號（免重編生產批號）
                  </label>
                </div>

                <div>
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <label style="margin:0; font-size:0.82rem; font-weight:700; color:var(--muted);">
                      本站投入材料（可掛多個半成品／原料與小數點數量）
                    </label>
                    <button type="button" class="btn btn-outline btn-sm" data-add-inp="${sIdx}">＋ 新增投入料</button>
                  </div>
                  ${(st.inputs || []).length === 0
                    ? `<div class="muted" style="font-size:0.82rem;">${sIdx === 0 ? '⚠️ 首站尚未指定投入材料' : '（不額外耗料，純對上一站產出加工）'}</div>`
                    : (st.inputs || []).map((inp, iIdx) => `
                        <div class="bom-inp-row">
                          <select class="input inp-code" data-sidx="${sIdx}" data-iidx="${iIdx}">
                            ${allItemCodes.map(c => `<option value="${E.escapeHtml(c)}" ${c === inp.itemCode ? 'selected' : ''}>${E.escapeHtml(c)} — ${E.escapeHtml(S.items[c].name || '')} (${S.items[c].type})</option>`).join('')}
                          </select>
                          <input type="number" class="input inp-qty" data-sidx="${sIdx}" data-iidx="${iIdx}" step="0.0001" min="0.0001" value="${inp.qtyPerUnit}" placeholder="用量" />
                          <button type="button" class="btn btn-outline btn-sm" data-del-inp="${sIdx}:${iIdx}">✕</button>
                        </div>`).join('')}
                </div>
              </div>`).join('')}
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
            <button type="button" class="btn btn-outline" id="btn-bom-add-step">＋ 新增下一道製程站</button>
            <button type="button" class="btn btn-success" id="btn-bom-save">💾 執行防呆並儲存配方</button>
            <button type="button" class="btn btn-outline" id="btn-bom-close">關閉編輯器</button>
          </div>
        </div>

        <div class="bom-preview-box" id="bom-live-preview"></div>
      </div>`;

    body.querySelectorAll('[data-tpl]').forEach(btn => {
      btn.addEventListener('click', () => applyBomTemplate(btn.dataset.tpl));
    });
    body.querySelectorAll('[data-move-up]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.moveUp);
        if (i > 0) {
          [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]];
          renumberBomSteps();
          renderBomEditorWorkspace();
        }
      });
    });
    body.querySelectorAll('[data-move-down]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.moveDown);
        if (i < draft.steps.length - 1) {
          [draft.steps[i], draft.steps[i + 1]] = [draft.steps[i + 1], draft.steps[i]];
          renumberBomSteps();
          renderBomEditorWorkspace();
        }
      });
    });
    body.querySelectorAll('[data-del-step]').forEach(btn => {
      btn.addEventListener('click', () => {
        draft.steps.splice(Number(btn.dataset.delStep), 1);
        renumberBomSteps();
        renderBomEditorWorkspace();
      });
    });
    body.querySelectorAll('[data-add-inp]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sIdx = Number(btn.dataset.addInp);
        if (!allItemCodes.length) return E.showToast('沒有其他可投入料號', 'error');
        draft.steps[sIdx].inputs = draft.steps[sIdx].inputs || [];
        draft.steps[sIdx].inputs.push({ itemCode: allItemCodes[0], qtyPerUnit: 1 });
        renderBomEditorWorkspace();
      });
    });
    body.querySelectorAll('[data-del-inp]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [sIdx, iIdx] = btn.dataset.delInp.split(':').map(Number);
        draft.steps[sIdx].inputs.splice(iIdx, 1);
        renderBomEditorWorkspace();
      });
    });

    body.querySelectorAll('.st-proc').forEach(el => el.addEventListener('change', () => {
      draft.steps[Number(el.dataset.sidx)].processName = el.value;
      renderBomLivePreview();
    }));
    body.querySelectorAll('.st-scrap').forEach(el => el.addEventListener('input', () => {
      draft.steps[Number(el.dataset.sidx)].scrapRate = Math.max(0, Math.min(0.9, (Number(el.value) || 0) / 100));
      renderBomLivePreview();
    }));
    body.querySelectorAll('.st-out').forEach(el => el.addEventListener('change', () => {
      draft.steps[Number(el.dataset.sidx)].isOutsourced = el.checked;
    }));
    body.querySelectorAll('.st-inherit').forEach(el => el.addEventListener('change', () => {
      draft.steps[Number(el.dataset.sidx)].inheritLot = el.checked;
    }));
    body.querySelectorAll('.inp-code').forEach(el => el.addEventListener('change', () => {
      draft.steps[Number(el.dataset.sidx)].inputs[Number(el.dataset.iidx)].itemCode = el.value;
      renderBomLivePreview();
    }));
    body.querySelectorAll('.inp-qty').forEach(el => el.addEventListener('input', () => {
      draft.steps[Number(el.dataset.sidx)].inputs[Number(el.dataset.iidx)].qtyPerUnit = E.roundQty(el.value);
      renderBomLivePreview();
    }));

    body.querySelector('#btn-bom-add-step').addEventListener('click', () => {
      const nextSeq = (draft.steps.length + 1) * 10;
      draft.steps.push({ seq: nextSeq, processName: getDefaultProc(draft.steps.length), scrapRate: 0.01, isOutsourced: false, inheritLot: true, inputs: [] });
      renderBomEditorWorkspace();
    });
    body.querySelector('#btn-bom-close').addEventListener('click', () => {
      CState.bomEditorOpen = false;
      CState.bomDraft = null;
      renderBomEditorContainer();
    });
    body.querySelector('#btn-bom-save').addEventListener('click', handleBomSave);

    renderBomLivePreview();
  }

  function renumberBomSteps() {
    if (!CState.bomDraft) return;
    CState.bomDraft.steps.forEach((st, idx) => { st.seq = (idx + 1) * 10; });
  }

  function renderBomLivePreview() {
    const box = document.getElementById('bom-live-preview');
    const draft = CState.bomDraft;
    if (!box || !draft) return;

    const cycle = E.checkBomCycle(draft.outCode, draft.steps, S.boms);
    const activeWips = E.getBomStepWip(draft.outCode);
    const tempBoms = Object.assign({}, S.boms, { [draft.outCode]: draft });

    const leafTotals = {};
    const expandTreeHtml = (code, qtyTheo, qtyWithScrap, depth) => {
      if (depth > 8) return `<div class="preview-tree-item">⚠️ 層級過深</div>`;
      const b = tempBoms[code];
      if (!b || !Array.isArray(b.steps) || b.steps.length === 0) {
        leafTotals[code] = {
          theo: E.roundQty((leafTotals[code] ? leafTotals[code].theo : 0) + qtyTheo),
          scrap: E.roundQty((leafTotals[code] ? leafTotals[code].scrap : 0) + qtyWithScrap)
        };
        return `<div class="preview-tree-item">🧱 <strong>${E.escapeHtml(code)}</strong>（底層料）｜理論 ${E.roundQty(qtyTheo)} / 含損耗 <strong>${E.roundQty(qtyWithScrap)}</strong></div>`;
      }

      const cumYield = b.steps.reduce((acc, st) => acc * (1 - (Number(st.scrapRate) || 0)), 1);
      const stepsSorted = b.steps.slice().sort((a, b2) => (a.seq || 0) - (b2.seq || 0));
      let curScrapMultiplier = 1;
      const childrenHtml = [];

      for (let i = stepsSorted.length - 1; i >= 0; i--) {
        const st = stepsSorted[i];
        const rate = Math.min(0.95, Math.max(0, Number(st.scrapRate) || 0));
        curScrapMultiplier = curScrapMultiplier / (1 - rate);
        (st.inputs || []).forEach(inp => {
          const u = Number(inp.qtyPerUnit) || 0;
          if (u > 0) {
            childrenHtml.unshift(expandTreeHtml(inp.itemCode, qtyTheo * u, qtyWithScrap * curScrapMultiplier * u, depth + 1));
          }
        });
      }

      return `
        <div class="preview-tree-item">
          ⚙️ <strong>${E.escapeHtml(code)}</strong>（${stepsSorted.length} 站，累積良率 ${E.roundQty(cumYield * 100)}%）
          ${childrenHtml.join('')}
        </div>`;
    };

    const treeHtml = cycle ? '' : expandTreeHtml(draft.outCode, 1, 1, 0);
    const leafSummaryHtml = Object.keys(leafTotals).map(k =>
      `<li><strong>${E.escapeHtml(k)}</strong>：理論 ${leafTotals[k].theo} ｜ 含損耗建議備料 <strong>${leafTotals[k].scrap}</strong></li>`
    ).join('');

    box.innerHTML = `
      <h4 style="margin:0 0 8px;">🔍 即時多階展階預覽（每產出 1 單位）</h4>
      ${cycle ? `<div class="warn-callout">❌ <strong>偵測到循環參照（禁止存檔）</strong>：${E.escapeHtml(cycle.join(' → '))}</div>` : ''}
      ${activeWips.length ? `<div class="warn-callout" style="background:#fffbeb; border-color:#f59e0b; color:#92400e;">⚠️ 此型號目前有站間 WIP：${activeWips.map(w => `${w.label}=${w.qty}`).join('、')}。刪改站別前請先清站。</div>` : ''}
      ${!cycle ? `
        ${treeHtml}
        <hr style="border:none; border-top:1px dashed #cbd5e1; margin:10px 0;" />
        <div style="font-size:0.85rem;">
          <strong>底層材料彙總（1 單位 ${E.escapeHtml(draft.outCode)}）：</strong>
          <ul style="margin:6px 0 0 18px; padding:0;">${leafSummaryHtml || '<li>尚未設定任何投入材料</li>'}</ul>
        </div>` : ''}
    `;
  }

  async function handleBomSave() {
    const draft = CState.bomDraft;
    if (!draft || !draft.steps || draft.steps.length === 0) {
      return E.showToast('配方至少需包含 1 道製程站', 'error');
    }
    const cycle = E.checkBomCycle(draft.outCode, draft.steps, S.boms);
    if (cycle) {
      return E.showToast(`禁止存檔：偵測到循環參照 ${cycle.join(' → ')}`, 'error');
    }
    if (!draft.steps[0].inputs || draft.steps[0].inputs.length === 0) {
      return E.showToast('首站必須至少指定 1 項投入材料與數量', 'error');
    }
    for (const st of draft.steps) {
      for (const inp of (st.inputs || [])) {
        if (!inp.itemCode || Number(inp.qtyPerUnit) <= 0) {
          return E.showToast(`站 ${st.seq} 的投入材料用量必須大於 0`, 'error');
        }
      }
    }

    const newSeqSet = new Set(draft.steps.map(s => String(s.seq)));
    const orphanWips = E.getBomStepWip(draft.outCode).filter(w => {
      const m = w.label.match(/^站(\d+)/);
      return m && !newSeqSet.has(m[1]);
    });
    if (orphanWips.length > 0) {
      const ok = confirm(
        `⚠️ WIP 殘留防護警示！\n\n以下站別已被刪除但廠內仍有在製品：\n${orphanWips.map(w => `${w.label}：${w.qty}`).join('\n')}\n\n強烈建議先將該站 WIP 報工清完再刪站。\n確定要強制覆寫嗎？`
      );
      if (!ok) return;
    }

    const ts = serverNow();
    const logId = genId('LOGB');
    const qId = genId('QB');
    const finalBom = {
      outCode: draft.outCode,
      pattern: draft.pattern || 'MULTI_SEMI',
      version: (Number(draft.version) || 0) + 1,
      steps: draft.steps,
      updatedAt: ts
    };

    const updates = {
      [`public_view/boms/${draft.outCode}`]: finalBom,
      [`private_console/audit_logs/${logId}`]: {
        logId, action: 'BOM_UPDATE', refTxId: draft.outCode,
        operatorEmail: S.auth.email, operatorAlias: S.auth.alias,
        customerOrTarget: '', reason: `更新製程 BOM 至 v${finalBom.version}（共 ${finalBom.steps.length} 站）`, serverTime: ts
      },
      [`private_console/sync_queue/${qId}`]: {
        logId, action: 'BOM_UPDATE', refTxId: draft.outCode,
        operatorEmail: S.auth.email, operatorAlias: S.auth.alias,
        customerOrTarget: '', reason: `更新製程 BOM 至 v${finalBom.version}`, serverTime: ts
      },
      'private_console/sync_flags/mirrorDirty': true
    };

    try {
      await commitMultiPath(updates);
      CState.bomDraft = JSON.parse(JSON.stringify(finalBom));
      E.showToast(`製程 BOM「${draft.outCode}」已儲存為 v${finalBom.version}！`, 'success');
      renderBomEditorWorkspace();
    } catch (err) {
      E.showToast('BOM 儲存失敗：' + err.message, 'error');
    }
  }

  /* ==================== 6. 主控台管理專區 (#console-admin-mount) ==================== */
  function renderAdminPanel() {
    const mount = document.getElementById('console-admin-mount');
    if (!mount || S.auth.role !== 'admin') return;

    const tabs = [
      { id: 'schedules', label: '📅 出貨排程管理' },
      { id: 'whitelist', label: '🔐 Gmail 白名單權限' },
      { id: 'items', label: '📦 快速新增料號' },
      { id: 'audit', label: '🕵️ 完整操作履歷 (Audit Log)' }
    ];

    mount.innerHTML = `
      <div class="panel-header">
        <div>
          <h2>🛡️ 管理員主控台</h2>
          <p class="muted">管理出貨排程、開通或停權操作員 Gmail、以及檢視含完整 Email 的稽核履歷。</p>
        </div>
      </div>
      <div class="subtab-bar">
        ${tabs.map(t => `<button type="button" class="subtab-btn ${CState.adminSubTab === t.id ? 'active' : ''}" data-admintab="${t.id}">${t.label}</button>`).join('')}
      </div>
      <div id="admin-sub-content"></div>`;

    mount.querySelectorAll('[data-admintab]').forEach(btn => {
      btn.addEventListener('click', () => {
        CState.adminSubTab = btn.dataset.admintab;
        renderAdminPanel();
      });
    });

    const box = mount.querySelector('#admin-sub-content');
    if (CState.adminSubTab === 'schedules') renderAdminSchedules(box);
    else if (CState.adminSubTab === 'whitelist') renderAdminWhitelist(box);
    else if (CState.adminSubTab === 'items') renderAdminItems(box);
    else renderAdminAudit(box);
  }

  function renderAdminSchedules(box) {
    const list = Object.values(S.schedules || {}).sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
    box.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <h3>＋ 新增正式出貨排程</h3>
        <form id="form-add-sched">
          <div class="form-row-2" style="grid-template-columns: repeat(4, 1fr);">
            <div>
              <label>出貨型號</label>
              <select id="sc-item" class="input" required>${buildItemOptionsHtml(['FG', 'SEMI'])}</select>
            </div>
            <div>
              <label>排程數量</label>
              <input type="number" id="sc-qty" class="input" min="1" required value="30" />
            </div>
            <div>
              <label>預計出貨日</label>
              <input type="date" id="sc-date" class="input" required value="${E.todayStr(3)}" />
            </div>
            <div>
              <label>優先權（1 最高）</label>
              <input type="number" id="sc-prio" class="input" min="1" max="99" value="1" />
            </div>
          </div>
          <div class="form-row-2" style="grid-template-columns: 1fr auto; align-items:end;">
            <div>
              <label>備註</label>
              <input type="text" id="sc-note" class="input" placeholder="例如 客戶急件／分批出貨" />
            </div>
            <button type="submit" class="btn btn-primary">＋ 建立排程</button>
          </div>
        </form>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>單號</th><th>出貨日</th><th>型號</th><th class="num">已出 / 排程</th><th>優先</th><th>狀態</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${list.length === 0 ? `<tr><td colspan="7" class="empty-state">尚無排程</td></tr>` : list.map(s => `
              <tr>
                <td><strong>${E.escapeHtml(s.schedId)}</strong></td>
                <td>${E.escapeHtml(s.dueDate)}</td>
                <td>${E.escapeHtml(s.itemCode)}</td>
                <td class="num">${s.shippedQty || 0} / <strong>${s.qty}</strong></td>
                <td>P${s.priority || 1}</td>
                <td><span class="badge ${s.status === 'CLOSED' ? 'badge-raw' : 'badge-green'}">${s.status || 'OPEN'}</span></td>
                <td>
                  <button type="button" class="btn btn-outline btn-sm" data-toggle-sched="${E.escapeHtml(s.schedId)}">
                    ${s.status === 'CLOSED' ? '重新開啟' : '結案'}
                  </button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    box.querySelector('#form-add-sched').addEventListener('submit', async e => {
      e.preventDefault();
      const schedId = genId('SCH');
      const rec = {
        schedId,
        itemCode: box.querySelector('#sc-item').value,
        qty: E.roundQty(box.querySelector('#sc-qty').value),
        shippedQty: 0,
        dueDate: box.querySelector('#sc-date').value,
        priority: Number(box.querySelector('#sc-prio').value) || 1,
        status: 'OPEN',
        note: box.querySelector('#sc-note').value.trim()
      };
      const ts = serverNow();
      const logId = genId('LOGS');
      await commitMultiPath({
        [`public_view/schedules/${schedId}`]: rec,
        [`private_console/audit_logs/${logId}`]: {
          logId, action: 'SCHED_CREATE', refTxId: schedId,
          operatorEmail: S.auth.email, operatorAlias: S.auth.alias,
          customerOrTarget: '', reason: `新增排程 ${rec.itemCode}×${rec.qty} (${rec.dueDate})`, serverTime: ts
        },
        'private_console/sync_flags/mirrorDirty': true
      });
      E.showToast(`排程 ${schedId} 已建立`, 'success');
      renderAdminPanel();
    });

    box.querySelectorAll('[data-toggle-sched]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.toggleSched;
        const sc = S.schedules[id];
        if (!sc) return;
        const nextStatus = sc.status === 'CLOSED' ? 'OPEN' : 'CLOSED';
        await commitMultiPath({
          [`public_view/schedules/${id}/status`]: nextStatus,
          'private_console/sync_flags/mirrorDirty': true
        });
        E.showToast(`排程 ${id} 已變更為 ${nextStatus}`);
        renderAdminPanel();
      });
    });
  }

  function renderAdminWhitelist(box) {
    const entries = Object.keys(CState.whitelist || {}).map(k => ({ key: k, ...CState.whitelist[k] }));
    box.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <h3>＋ 開通新 Gmail 寫入權限</h3>
        <form id="form-add-wl">
          <div class="form-row-2" style="grid-template-columns: 1.5fr 1fr 1fr auto; align-items:end;">
            <div>
              <label>使用者 Gmail</label>
              <input type="email" id="wl-email" class="input" required placeholder="colleague@gmail.com" />
            </div>
            <div>
              <label>公開頁面顯示代號（防洩個資）</label>
              <input type="text" id="wl-alias" class="input" required placeholder="例如 現場-03" />
            </div>
            <div>
              <label>角色等級</label>
              <select id="wl-role" class="input">
                <option value="operator">操作員（進出貨／報工／作廢）</option>
                <option value="admin">管理員（含 BOM 與權限管理）</option>
              </select>
            </div>
            <button type="submit" class="btn btn-primary">＋ 立即開通</button>
          </div>
        </form>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>Gmail</th><th>公開代號</th><th>角色</th><th>狀態</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${entries.map(u => `
              <tr>
                <td><strong>${E.escapeHtml(u.email)}</strong></td>
                <td>${E.escapeHtml(u.alias)}</td>
                <td><span class="badge ${u.role === 'admin' ? 'badge-semi' : 'badge-blue'}">${u.role === 'admin' ? '管理員' : '操作員'}</span></td>
                <td><span class="badge ${u.active ? 'badge-green' : 'badge-red'}">${u.active ? '已開通' : '已停權'}</span></td>
                <td>
                  ${u.email === S.auth.email
                    ? '<span class="muted">（目前登入帳號）</span>'
                    : `<button type="button" class="btn btn-outline btn-sm" data-toggle-wl="${E.escapeHtml(u.key)}">${u.active ? '停權' : '重新開通'}</button>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    box.querySelector('#form-add-wl').addEventListener('submit', async e => {
      e.preventDefault();
      const email = box.querySelector('#wl-email').value.trim().toLowerCase();
      const alias = box.querySelector('#wl-alias').value.trim();
      const role = box.querySelector('#wl-role').value;
      const key = emailToKey(email);
      const ts = serverNow();
      const logId = genId('LOGW');

      await commitMultiPath({
        [`private_console/whitelist/${key}`]: { email, alias, role, active: true, addedAt: ts },
        [`private_console/audit_logs/${logId}`]: {
          logId, action: 'WHITELIST_ADD', refTxId: email,
          operatorEmail: S.auth.email, operatorAlias: S.auth.alias,
          customerOrTarget: '', reason: `開通 ${email}（${alias} / ${role}）`, serverTime: ts
        }
      });
      E.showToast(`已開通 ${email}`, 'success');
      renderAdminPanel();
    });

    box.querySelectorAll('[data-toggle-wl]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.toggleWl;
        const u = CState.whitelist[key];
        if (!u) return;
        const nextActive = !u.active;
        const ts = serverNow();
        const logId = genId('LOGW');
        await commitMultiPath({
          [`private_console/whitelist/${key}/active`]: nextActive,
          [`private_console/audit_logs/${logId}`]: {
            logId, action: 'WHITELIST_TOGGLE', refTxId: u.email,
            operatorEmail: S.auth.email, operatorAlias: S.auth.alias,
            customerOrTarget: '', reason: `${nextActive ? '重新開通' : '停權'} ${u.email}`, serverTime: ts
          }
        });
        E.showToast(`${u.email} 已${nextActive ? '開通' : '停權'}`);
        renderAdminPanel();
      });
    });
  }

  function renderAdminItems(box) {
    box.innerHTML = `
      <div class="card">
        <h3>📦 快速新增料號（亦可在試算表 01_料號與期初主檔 批次維護）</h3>
        <form id="form-add-item">
          <div class="form-row-2" style="grid-template-columns: repeat(3, 1fr);">
            <div>
              <label>型號代碼（不可含 . $ # [ ] /）</label>
              <input type="text" id="it-code" class="input" required placeholder="例如 B-SEMI" />
            </div>
            <div>
              <label>品名規格</label>
              <input type="text" id="it-name" class="input" required placeholder="例如 B-半成品(雷雕)" />
            </div>
            <div>
              <label>類別</label>
              <select id="it-type" class="input">
                <option value="RAW">原料 RAW</option>
                <option value="SEMI">半成品 SEMI</option>
                <option value="FG">成品 FG</option>
              </select>
            </div>
          </div>
          <div class="form-row-2" style="grid-template-columns: repeat(3, 1fr);">
            <div>
              <label>單位</label>
              <input type="text" id="it-unit" class="input" value="顆" />
            </div>
            <div>
              <label>期初數量</label>
              <input type="number" id="it-init" class="input" step="0.0001" value="0" />
            </div>
            <div>
              <label>安全庫存</label>
              <input type="number" id="it-safe" class="input" step="0.0001" value="20" />
            </div>
          </div>
          <button type="submit" class="btn btn-primary">＋ 建立料號</button>
        </form>
      </div>`;

    box.querySelector('#form-add-item').addEventListener('submit', async e => {
      e.preventDefault();
      const code = box.querySelector('#it-code').value.trim();
      if (!code || /[.$#\[\]\/]/.test(code)) {
        return E.showToast('型號代碼格式不合法', 'error');
      }
      const ts = serverNow();
      await commitMultiPath({
        [`public_view/items/${code}`]: {
          code,
          name: box.querySelector('#it-name').value.trim(),
          type: box.querySelector('#it-type').value,
          unit: box.querySelector('#it-unit').value.trim() || '顆',
          initialQty: E.roundQty(box.querySelector('#it-init').value),
          safetyStock: E.roundQty(box.querySelector('#it-safe').value),
          note: '由網頁主控台建立',
          updatedAt: ts
        },
        'private_console/sync_flags/mirrorDirty': true
      });
      E.showToast(`料號 ${code} 已建立！`, 'success');
      box.querySelector('#form-add-item').reset();
    });
  }

  function renderAdminAudit(box) {
    const logs = Object.values(CState.auditLogs || {}).sort((a, b) => (b.serverTime || 0) - (a.serverTime || 0));
    box.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>伺服器時間</th><th>動作</th><th>關聯單號</th><th>填表人 Gmail（僅管理員可見）</th><th>對象/客戶</th><th>原因/備註</th></tr>
          </thead>
          <tbody>
            ${logs.length === 0 ? `<tr><td colspan="6" class="empty-state">尚無操作履歷</td></tr>` : logs.map(l => `
              <tr>
                <td>${E.formatDateTime(l.serverTime)}</td>
                <td><span class="badge badge-blue">${E.escapeHtml(l.action)}</span></td>
                <td><code>${E.escapeHtml(l.refTxId || '--')}</code></td>
                <td><strong>${E.escapeHtml(l.operatorEmail)}</strong> <span class="muted">(${E.escapeHtml(l.operatorAlias)})</span></td>
                <td>${E.escapeHtml(l.customerOrTarget || '--')}</td>
                <td>${E.escapeHtml(l.reason || '--')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  /* ==================== 7. 啟動與掛勾註冊 ==================== */
  function initConsole() {
    if (CState.initialized) return;
    CState.initialized = true;

    injectConsoleStyles();
    ensureFirebaseRefs();

    const loginBtn = document.getElementById('btn-login-console');
    const logoutBtn = document.getElementById('btn-logout-console');
    if (loginBtn) loginBtn.addEventListener('click', handleLoginClick);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogoutClick);

    if (!S.isDemoMode && S.authInstance) {
      S.authInstance.onAuthStateChanged(user => {
        if (user) verifyWhitelistedUser(user);
        else resetAuthState();
      });
    }

    // 註冊至 Part 2 引擎：當遠端資料變動時，只更新總表與預覽，絕不覆寫正在打字的現場表單
    E.registerConsoleHook(() => {
      if (!S.auth.isAuthorized) return;
      renderLedgerTableBody();
      if (S.auth.role === 'admin' && CState.bomEditorOpen) {
        renderBomLivePreview();
      }
      if (S.auth.role === 'admin' && S.ui.activeTab === 'admin' && CState.adminSubTab === 'schedules') {
        const box = document.getElementById('admin-sub-content');
        if (box && !box.querySelector('#sc-note:focus')) renderAdminSchedules(box);
      }
    });
  }

  if (document.readyState === 'complete') {
    initConsole();
  } else {
    window.addEventListener('load', initConsole);
  }

  return { handleLoginClick, handleLogoutClick };
})();
