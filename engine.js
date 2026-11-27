/**
 * 現場物料與多階製程管理系統 - 核心計算與公開檢視引擎 (Part 2: engine.js)
 * ----------------------------------------------------------------------
 * 包含模組：
 * 1. Firebase 連線與本機展示模式自動切換
 * 2. 會計級即時庫存 / 站間 WIP / 待重工池 / 批號餘量引擎（與 Code.gs 100% 同公式）
 * 3. 多階倒推齊料評估引擎（由最終站倒推扣 WIP、逐站無條件進位損耗、跨排程共用料預扣、二分法最大可出數）
 * 4. What-if 瀏覽器沙盒模擬（不碰正式帳目）
 * 5. 雙向批號追溯引擎（以 itemCode||lotNo 為鍵，完美相容單料批號沿用與多料混批）
 * 6. 循環參照檢查（Cycle Detection）與 WIP 殘留防護工具（供第 3 部分 BOM 編輯器呼叫）
 */

// ==================== 請貼上你的 Firebase Web App 設定 ====================
const firebaseConfig = {
  apiKey: "AIzaSyBk2kStuqO_OxBKvvTcU44nghJqfr9E2A8", // 請至 Firebase 主控台的專案設定中取得
  authDomain: "pc-control-a3d35.firebaseapp.com",
  databaseURL: "https://pc-control-a3d35-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "pc-control-a3d35",
  storageBucket: "pc-control-a3d35.firebasestorage.app", // 亦可使用 pc-control-a3d35.appspot.com
  messagingSenderId: "24088661658",
  appId: "1:24088661658:web:21c6917c08a16e1fc09923" // 請至 Firebase 主控台的專案設定中取得
};
// =========================================================================

window.AppState = {
  isDemoMode: false,
  db: null,
  authInstance: null,
  auth: {
    user: null,
    isAuthorized: false,
    role: 'public', // public | operator | admin
    alias: '',
    email: ''
  },
  items: {},
  boms: {},
  processes: [],
  transactions: {},
  schedules: {},
  computed: {
    stock: {},
    wip: {},
    lots: {},
    readiness: []
  },
  whatIf: {
    addedOrders: [],
    addedStock: {},
    scrapOverrides: {} // key: `${outCode}::${seq}` -> decimal rate
  },
  ui: {
    activeTab: 'inventory',
    invSearch: '',
    invFilter: 'ALL',
    viewMode: window.innerWidth <= 768 ? 'mobile' : 'desktop',
    manualModeLocked: false
  },
  consoleHooks: [] // 供第 3 部分 console.js 註冊渲染與互動掛勾
};

window.AppEngine = (function () {
  const S = window.AppState;

  /* ==================== 工具函式 ==================== */
  function roundQty(n) {
    return Math.round((Number(n) || 0) * 10000) / 10000;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateTime(ms) {
    if (!ms) return '--';
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function todayStr(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }

  function showToast(msg, type = '') {
    const box = document.getElementById('toast-container');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function cloneDeep(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /* ==================== 1. 會計級即時庫存 / WIP / 批號引擎 ==================== */
  function computeInventoryState(itemsObj, bomsObj, txsObj) {
    const stock = {};
    const wip = {};
    const lots = {};

    Object.keys(itemsObj || {}).forEach(code => {
      const init = Number(itemsObj[code].initialQty) || 0;
      stock[code] = init;
      if (init > 0) {
        lots[`${code}||INIT`] = init;
      }
    });

    const addStock = (code, delta) => { stock[code] = (stock[code] || 0) + delta; };
    const addWip = (key, delta) => { wip[key] = (wip[key] || 0) + delta; };
    const addLot = (code, lotNo, delta) => {
      if (!lotNo) return;
      const key = `${code}||${lotNo}`;
      lots[key] = (lots[key] || 0) + delta;
    };

    Object.keys(txsObj || {}).forEach(txId => {
      const tx = txsObj[txId];
      if (!tx) return;

      const effType = tx.txType === 'REVERSAL' ? tx.reversalOfType : tx.txType;
      const good = Number(tx.goodQty) || 0;
      const scrap = Number(tx.scrapQty) || 0;
      const rework = Number(tx.reworkQty) || 0;
      const totalProcessed = good + scrap + rework;

      if (effType === 'INBOUND' || effType === 'ADJUST') {
        addStock(tx.itemCode, good);
        addLot(tx.itemCode, tx.lotNo, good);
      } else if (effType === 'OUTBOUND') {
        addStock(tx.itemCode, -good);
        addLot(tx.itemCode, tx.lotNo, -good);
      } else if (effType === 'WORKLOG') {
        if (tx.isRework) {
          // 重工單：只消耗待重工池，絕不二次扣原料或上一站 WIP
          addWip(`${tx.itemCode}::站${tx.stepSeq}(待重工)`, -(good + scrap));
          if (tx.isFinalStep) {
            addStock(tx.itemCode, good);
            addLot(tx.itemCode, tx.lotNo, good);
          } else {
            addWip(`${tx.itemCode}::站${tx.stepSeq}`, good);
          }
        } else {
          if (Array.isArray(tx.consumedLots)) {
            tx.consumedLots.forEach(c => {
              const cQty = Number(c.qty) || 0;
              addStock(c.itemCode, -cQty);
              addLot(c.itemCode, c.lotNo, -cQty);
            });
          }
          if (tx.prevStepSeq) {
            addWip(`${tx.itemCode}::站${tx.prevStepSeq}`, -totalProcessed);
          }
          if (tx.isFinalStep) {
            addStock(tx.itemCode, good);
            addLot(tx.itemCode, tx.lotNo, good);
          } else {
            addWip(`${tx.itemCode}::站${tx.stepSeq}`, good);
          }
          if (rework !== 0) {
            addWip(`${tx.itemCode}::站${tx.stepSeq}(待重工)`, rework);
          }
        }
      }
    });

    return { stock, wip, lots };
  }

  /* ==================== 2. 多階倒推含 WIP 與不良率齊料評估引擎 ==================== */
  function deductRequirement(itemCode, needQty, pool, bomsObj, useScrap, scrapOverrides, shortages, wipUsedLog, depth) {
    if (depth > 15 || needQty <= 0.0001) return;

    // 步驟 1：優先抵扣該型號現有可用庫存
    const avail = Math.max(0, pool.stock[itemCode] || 0);
    const used = Math.min(avail, needQty);
    pool.stock[itemCode] = (pool.stock[itemCode] || 0) - used;
    const netNeed = roundQty(needQty - used);
    if (netNeed <= 0.0001) return;

    // 步驟 2：檢查是否有製程 BOM 可往下展階
    const bom = bomsObj[itemCode];
    if (!bom || !Array.isArray(bom.steps) || bom.steps.length === 0) {
      shortages[itemCode] = roundQty((shortages[itemCode] || 0) + netNeed);
      return;
    }

    // 步驟 3：從最後一站倒推回第一站，逐站套用良率並扣減前一站 WIP（避免重複算不良率）
    const steps = bom.steps.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    let stepNeed = netNeed;

    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i];
      const overrideKey = `${itemCode}::${st.seq}`;
      const rawRate = (scrapOverrides && scrapOverrides[overrideKey] != null)
        ? Number(scrapOverrides[overrideKey])
        : (Number(st.scrapRate) || 0);
      const rate = Math.min(0.95, Math.max(0, rawRate));

      const inputNeeded = (useScrap && rate > 0)
        ? Math.ceil((stepNeed / (1 - rate)) - 1e-9)
        : stepNeed;

      // 扣除本站新增投入材料（可零個、一個或多個含數量）
      if (Array.isArray(st.inputs)) {
        st.inputs.forEach(inp => {
          const matNeed = roundQty(inputNeeded * (Number(inp.qtyPerUnit) || 0));
          if (matNeed > 0) {
            deductRequirement(inp.itemCode, matNeed, pool, bomsObj, useScrap, scrapOverrides, shortages, wipUsedLog, depth + 1);
          }
        });
      }

      // 若非第一站，先扣除前一站已加工完的站間 WIP
      if (i > 0) {
        const prevSeq = steps[i - 1].seq;
        const wipKey = `${itemCode}::站${prevSeq}`;
        const availWip = Math.max(0, pool.wip[wipKey] || 0);
        const usedWip = Math.min(availWip, inputNeeded);
        if (usedWip > 0) {
          pool.wip[wipKey] = (pool.wip[wipKey] || 0) - usedWip;
          wipUsedLog.push(`${itemCode} 站${prevSeq} WIP×${roundQty(usedWip)}`);
        }
        stepNeed = roundQty(inputNeeded - usedWip);
        if (stepNeed <= 0.0001) break;
      }
    }
  }

  function calcMaxShippable(itemCode, maxTarget, prePool, bomsObj, scrapOverrides) {
    let lo = 0;
    let hi = Math.floor(maxTarget);
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const testPool = cloneDeep(prePool);
      const testShort = {};
      deductRequirement(itemCode, mid, testPool, bomsObj, true, scrapOverrides, testShort, [], 0);
      if (Object.keys(testShort).length === 0) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function evaluateSchedules(baseState, bomsObj, schedulesList, opts = {}) {
    const addedStock = opts.addedStock || {};
    const scrapOverrides = opts.scrapOverrides || {};

    const initPool = {
      stock: Object.assign({}, baseState.stock),
      wip: Object.assign({}, baseState.wip)
    };
    Object.keys(addedStock).forEach(code => {
      initPool.stock[code] = (initPool.stock[code] || 0) + (Number(addedStock[code]) || 0);
    });

    const poolWithScrap = cloneDeep(initPool);
    const poolTheo = cloneDeep(initPool);

    const openList = schedulesList
      .filter(s => s && s.status !== 'CLOSED' && (Number(s.qty) - (Number(s.shippedQty) || 0)) > 0)
      .slice()
      .sort((a, b) => {
        const dCmp = String(a.dueDate || '9999-99-99').localeCompare(String(b.dueDate || '9999-99-99'));
        if (dCmp !== 0) return dCmp;
        return (Number(a.priority) || 50) - (Number(b.priority) || 50);
      });

    return openList.map(sched => {
      const remaining = roundQty(Math.max(0, (Number(sched.qty) || 0) - (Number(sched.shippedQty) || 0)));
      const preScrapPool = cloneDeep(poolWithScrap);
      const preFgStock = Math.max(0, roundQty(poolWithScrap.stock[sched.itemCode] || 0));

      const scrapShortages = {};
      const theoShortages = {};
      const wipUsedLog = [];

      deductRequirement(sched.itemCode, remaining, poolWithScrap, bomsObj, true, scrapOverrides, scrapShortages, wipUsedLog, 0);
      deductRequirement(sched.itemCode, remaining, poolTheo, bomsObj, false, scrapOverrides, theoShortages, [], 0);

      const hasScrapShort = Object.keys(scrapShortages).length > 0;
      const hasTheoShort = Object.keys(theoShortages).length > 0;

      let light = 'GREEN';
      let lightText = '🟢 齊料安全（含損耗緩衝）';
      if (hasTheoShort) {
        light = 'RED';
        lightText = '🔴 明確缺料';
      } else if (hasScrapShort) {
        light = 'YELLOW';
        lightText = '🟡 理論齊料，但計入不良率有缺口風險';
      }

      const maxShippable = hasScrapShort
        ? calcMaxShippable(sched.itemCode, remaining, preScrapPool, bomsObj, scrapOverrides)
        : remaining;

      return {
        ...sched,
        remaining,
        preFgStock,
        light,
        lightText,
        maxShippable,
        scrapShortages,
        theoShortages,
        wipUsedLog
      };
    });
  }

  /* ==================== 3. 雙向批號追溯引擎 ==================== */
  function traceLot(queryLot) {
    const q = String(queryLot || '').trim().toUpperCase();
    if (!q) return null;

    const activeTxs = Object.values(S.transactions || {})
      .filter(tx => tx && tx.status === 'ACTIVE' && tx.txType !== 'REVERSAL')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    // 建立以 itemCode||lotNo 為鍵的雙向索引（完美相容單料繼承批號與多料混批）
    const producedBy = {};  // key -> txs[]
    const consumedBy = {};  // key -> txs[]
    const shippedBy = {};   // key -> txs[]
    const matchedKeys = new Set();

    const pushMap = (map, key, val) => {
      if (!map[key]) map[key] = [];
      map[key].push(val);
    };

    activeTxs.forEach(tx => {
      if (tx.lotNo) {
        const key = `${tx.itemCode}||${tx.lotNo}`;
        if (String(tx.lotNo).toUpperCase().includes(q)) matchedKeys.add(key);

        if (tx.txType === 'INBOUND' || tx.txType === 'ADJUST' || tx.txType === 'WORKLOG') {
          pushMap(producedBy, key, tx);
        } else if (tx.txType === 'OUTBOUND') {
          pushMap(shippedBy, key, tx);
        }
      }
      if (Array.isArray(tx.consumedLots)) {
        tx.consumedLots.forEach(c => {
          const cKey = `${c.itemCode}||${c.lotNo}`;
          if (String(c.lotNo).toUpperCase().includes(q)) matchedKeys.add(cKey);
          pushMap(consumedBy, cKey, { tx, qty: c.qty });
        });
      }
    });

    // 也從目前尚有餘量的期初/庫存批號補齊
    Object.keys(S.computed.lots || {}).forEach(lKey => {
      const lotNo = lKey.split('||')[1] || '';
      if (lotNo.toUpperCase().includes(q)) matchedKeys.add(lKey);
    });

    if (matchedKeys.size === 0) return { query: queryLot, roots: [] };

    const buildUpstream = (key, visited) => {
      if (visited.has(key)) return { key, cycleStop: true, events: [], parents: [] };
      const nextVisited = new Set(visited);
      nextVisited.add(key);

      const events = producedBy[key] || [];
      const parents = [];
      events.forEach(tx => {
        if (Array.isArray(tx.consumedLots)) {
          tx.consumedLots.forEach(c => {
            const pKey = `${c.itemCode}||${c.lotNo}`;
            if (pKey !== key) {
              parents.push({
                usedQty: c.qty,
                viaTx: tx,
                node: buildUpstream(pKey, nextVisited)
              });
            }
          });
        }
      });

      return {
        key,
        itemCode: key.split('||')[0],
        lotNo: key.split('||')[1],
        remainQty: roundQty(S.computed.lots[key] || 0),
        events,
        parents
      };
    };

    const buildDownstream = (key, visited, shippedAlerts) => {
      if (visited.has(key)) return { key, cycleStop: true, shipments: [], children: [] };
      const nextVisited = new Set(visited);
      nextVisited.add(key);

      const shipments = shippedBy[key] || [];
      shipments.forEach(tx => {
        shippedAlerts.push({
          itemCode: tx.itemCode,
          lotNo: tx.lotNo,
          qty: tx.goodQty,
          txDate: tx.txDate,
          txId: tx.txId,
          operatorAlias: tx.operatorAlias
        });
      });

      const children = [];
      (consumedBy[key] || []).forEach(entry => {
        const outKey = `${entry.tx.itemCode}||${entry.tx.lotNo}`;
        if (outKey !== key) {
          children.push({
            consumedQty: entry.qty,
            viaTx: entry.tx,
            node: buildDownstream(outKey, nextVisited, shippedAlerts)
          });
        }
      });

      return {
        key,
        itemCode: key.split('||')[0],
        lotNo: key.split('||')[1],
        remainQty: roundQty(S.computed.lots[key] || 0),
        shipments,
        children
      };
    };

    const roots = Array.from(matchedKeys).map(key => {
      const shippedAlerts = [];
      return {
        key,
        itemCode: key.split('||')[0],
        lotNo: key.split('||')[1],
        remainQty: roundQty(S.computed.lots[key] || 0),
        upstream: buildUpstream(key, new Set()),
        downstream: buildDownstream(key, new Set(), shippedAlerts),
        shippedAlerts
      };
    });

    return { query: queryLot, roots };
  }

  /* ==================== 4. BOM 編輯防呆工具（供 Part 3 共用） ==================== */
  function checkBomCycle(targetOutCode, candidateSteps, bomsObj) {
    const tempBoms = Object.assign({}, bomsObj, {
      [targetOutCode]: { outCode: targetOutCode, steps: candidateSteps }
    });
    const visited = new Set();
    const stack = new Set();

    function dfs(code, path) {
      if (stack.has(code)) return [...path, code];
      if (visited.has(code)) return null;
      visited.add(code);
      stack.add(code);

      const bom = tempBoms[code];
      if (bom && Array.isArray(bom.steps)) {
        for (const st of bom.steps) {
          for (const inp of (st.inputs || [])) {
            const cycle = dfs(inp.itemCode, [...path, code]);
            if (cycle) return cycle;
          }
        }
      }
      stack.delete(code);
      return null;
    }
    return dfs(targetOutCode, []);
  }

  function getBomStepWip(itemCode) {
    const result = [];
    Object.keys(S.computed.wip || {}).forEach(wKey => {
      if (wKey.startsWith(`${itemCode}::`) && Math.abs(S.computed.wip[wKey]) > 0.0001) {
        result.push({ key: wKey, label: wKey.replace(`${itemCode}::`, ''), qty: roundQty(S.computed.wip[wKey]) });
      }
    });
    return result;
  }

  /* ==================== 5. 畫面渲染邏輯 ==================== */
  function recomputeAndRender() {
    S.computed = computeInventoryState(S.items, S.boms, S.transactions);
    S.computed.readiness = evaluateSchedules(S.computed, S.boms, Object.values(S.schedules || {}));

    renderKpis();
    renderInventoryTable();
    renderReadinessList('readiness-list', S.computed.readiness);
    renderWhatIfControls();
    renderWhatIfResults();
    renderTraceQuickChips();
    renderPublicBomViewer();

    // 觸發第 3 部分 console.js 註冊的所有渲染掛勾
    S.consoleHooks.forEach(fn => {
      try { fn(); } catch (err) { console.error('[ConsoleHook]', err); }
    });
  }

  function renderKpis() {
    const readiness = S.computed.readiness;
    const redSched = readiness.filter(r => r.light === 'RED').length;
    const yellowSched = readiness.filter(r => r.light === 'YELLOW').length;
    const greenSched = readiness.filter(r => r.light === 'GREEN').length;

    let negStock = 0;
    let lowSafety = 0;
    Object.keys(S.items).forEach(code => {
      const qty = roundQty(S.computed.stock[code] || 0);
      const safe = Number(S.items[code].safetyStock) || 0;
      if (qty < 0) negStock++;
      else if (qty <= safe) lowSafety++;
    });

    let totalWip = 0;
    let totalRework = 0;
    Object.keys(S.computed.wip).forEach(k => {
      const val = roundQty(S.computed.wip[k]);
      if (val > 0) {
        if (k.includes('(待重工)')) totalRework += val;
        else totalWip += val;
      }
    });

    document.getElementById('kpi-red-count').textContent = redSched + negStock;
    document.getElementById('kpi-red-desc').textContent = `缺料排程 ${redSched} 筆｜負庫存待補帳 ${negStock} 項`;
    document.getElementById('kpi-yellow-count').textContent = yellowSched + lowSafety;
    document.getElementById('kpi-green-count').textContent = greenSched;
    document.getElementById('kpi-wip-count').textContent = roundQty(totalWip);
    document.getElementById('kpi-rework-desc').textContent = `待重工池：${roundQty(totalRework)}`;
  }

  function getFilteredInventoryRows() {
    const kw = S.ui.invSearch.trim().toLowerCase();
    const filter = S.ui.invFilter;

    return Object.keys(S.items).sort().map(code => {
      const it = S.items[code];
      const qty = roundQty(S.computed.stock[code] || 0);
      const safety = Number(it.safetyStock) || 0;

      const wipEntries = getBomStepWip(code);
      const lotEntries = [];
      Object.keys(S.computed.lots).forEach(lKey => {
        if (lKey.startsWith(`${code}||`) && Math.abs(S.computed.lots[lKey]) > 0.0001) {
          lotEntries.push({ lotNo: lKey.split('||')[1], qty: roundQty(S.computed.lots[lKey]) });
        }
      });

      let status = 'OK';
      if (qty < 0) status = 'NEG';
      else if (qty <= safety) status = 'LOW';

      return { code, it, qty, safety, status, wipEntries, lotEntries };
    }).filter(row => {
      if (filter === 'RAW' || filter === 'SEMI' || filter === 'FG') {
        if (row.it.type !== filter) return false;
      } else if (filter === 'ALERT') {
        if (row.status === 'OK') return false;
      } else if (filter === 'WIP') {
        if (row.wipEntries.length === 0) return false;
      }
      if (!kw) return true;
      const hay = [
        row.code, row.it.name, row.it.note,
        ...row.lotEntries.map(l => l.lotNo)
      ].join(' ').toLowerCase();
      return hay.includes(kw);
    });
  }

  function renderInventoryTable() {
    const tbody = document.getElementById('inv-tbody');
    const rows = getFilteredInventoryRows();
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">目前篩選條件無符合料號</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const typeCls = r.it.type === 'FG' ? 'badge-fg' : (r.it.type === 'SEMI' ? 'badge-semi' : 'badge-raw');
      const lightHtml = r.status === 'NEG'
        ? `<span class="badge badge-red">🔴 負庫存待補帳</span>`
        : (r.status === 'LOW'
          ? `<span class="badge badge-yellow">🟡 低於安全庫存</span>`
          : `<span class="badge badge-green">🟢 正常</span>`);

      const wipHtml = r.wipEntries.length === 0
        ? `<span class="muted">--</span>`
        : r.wipEntries.map(w => {
            const cls = w.label.includes('待重工') ? 'wip-pill rework' : 'wip-pill';
            return `<span class="${cls}">${escapeHtml(w.label)}: ${w.qty}</span>`;
          }).join('');

      const lotHtml = r.lotEntries.length === 0
        ? `<span class="muted">--</span>`
        : r.lotEntries.map(l => {
            const cls = l.qty < 0 ? 'lot-pill neg' : 'lot-pill';
            return `<span class="${cls}" data-jump-lot="${escapeHtml(l.lotNo)}" title="點擊立即雙向追溯">${escapeHtml(l.lotNo)} (${l.qty})</span>`;
          }).join('');

      return `
        <tr>
          <td>
            <strong>${escapeHtml(r.code)}</strong>
            <div class="muted">${escapeHtml(r.it.name || '')}</div>
          </td>
          <td><span class="badge ${typeCls}">${escapeHtml(r.it.type)}</span></td>
          <td class="num"><strong>${r.qty}</strong> <span class="muted">${escapeHtml(r.it.unit || '')}</span></td>
          <td class="num">${r.safety}</td>
          <td>${lightHtml}</td>
          <td>${wipHtml}</td>
          <td>${lotHtml}</td>
        </tr>`;
    }).join('');

    // 點擊批號標籤直接跳轉雙向追溯
    tbody.querySelectorAll('[data-jump-lot]').forEach(el => {
      el.addEventListener('click', () => {
        const lot = el.getAttribute('data-jump-lot');
        document.getElementById('trace-lot-input').value = lot;
        setActiveTab('trace');
        renderTraceResult(lot);
      });
    });
  }

  function renderReadinessList(containerId, list) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!list || list.length === 0) {
      el.innerHTML = `<div class="empty-state">目前沒有待出貨排程。</div>`;
      return;
    }

    el.innerHTML = list.map(r => {
      const itemName = (S.items[r.itemCode] && S.items[r.itemCode].name) || r.itemCode;
      const badgeCls = r.light === 'GREEN' ? 'badge-green' : (r.light === 'YELLOW' ? 'badge-yellow' : 'badge-red');
      const shortKeys = Object.keys(r.scrapShortages || {});

      let shortageHtml = '';
      if (shortKeys.length > 0) {
        const isYellow = r.light === 'YELLOW';
        const lines = shortKeys.map(code => {
          const name = (S.items[code] && S.items[code].name) || code;
          const sQty = r.scrapShortages[code];
          const tQty = r.theoShortages[code] || 0;
          return `<li><strong>${escapeHtml(code)}</strong>（${escapeHtml(name)}）：含損耗缺 <strong>${sQty}</strong>（純理論缺 ${tQty}）</li>`;
        }).join('');
        shortageHtml = `
          <div class="shortage-box ${isYellow ? 'yellow' : ''}">
            <strong>${isYellow ? '⚠️ 損耗風險提醒（理論夠料，但加計不良率緩衝尚缺）：' : '❌ 底層缺料明細（已扣除先出排程預留之共用料）：'}</strong>
            <ul style="margin:6px 0 0 18px; padding:0;">${lines}</ul>
          </div>`;
      }

      const wipHtml = r.wipUsedLog && r.wipUsedLog.length > 0
        ? `<div>⚙️ 已計入站間 WIP：${escapeHtml(r.wipUsedLog.join('、'))}</div>`
        : '';

      return `
        <div class="sched-card ${r.light} ${r.isSimulated ? 'simulated' : ''}">
          <div class="sched-head">
            <div>
              <div class="sched-title">
                <span>${r.isSimulated ? '🧪 [模擬] ' : ''}${escapeHtml(r.itemCode)} — ${escapeHtml(itemName)}</span>
                <span class="badge ${badgeCls}">${r.lightText}</span>
              </div>
              <div class="sched-meta">
                排程單號：${escapeHtml(r.schedId)} ｜ 預計出貨日：<strong>${escapeHtml(r.dueDate)}</strong> ｜ 優先序：P${r.priority || 1}
                ${r.note ? `｜備註：${escapeHtml(r.note)}` : ''}
              </div>
            </div>
            <div style="text-align:right;">
              <div class="muted">待出貨欠數</div>
              <div style="font-size:1.35rem; font-weight:800;">${r.remaining} <span class="muted" style="font-size:0.8rem;">/ 排程 ${r.qty}</span></div>
            </div>
          </div>
          <div class="sched-metrics">
            <div>📦 分配前現貨：<strong>${r.preFgStock}</strong></div>
            <div>✅ 依現有庫存與損耗，最多可先出：<strong>${r.maxShippable}</strong></div>
            ${wipHtml}
          </div>
          ${shortageHtml}
        </div>`;
    }).join('');
  }

  /* ==================== What-if 模擬渲染與操作 ==================== */
  function isWhatIfActive() {
    return S.whatIf.addedOrders.length > 0 ||
      Object.keys(S.whatIf.addedStock).length > 0 ||
      Object.keys(S.whatIf.scrapOverrides).length > 0;
  }

  function renderWhatIfControls() {
    const itemCodes = Object.keys(S.items).sort();
    const orderSel = document.getElementById('wf-order-item');
    const stockSel = document.getElementById('wf-stock-item');
    const scrapSel = document.getElementById('wf-scrap-target');
    const dateInput = document.getElementById('wf-order-date');

    if (dateInput && !dateInput.value) dateInput.value = todayStr(2);

    const buildOpts = (codes) => codes.map(c =>
      `<option value="${escapeHtml(c)}">${escapeHtml(c)} - ${escapeHtml(S.items[c].name || '')} (${S.items[c].type})</option>`
    ).join('');

    const fgSemiCodes = itemCodes.filter(c => S.items[c].type !== 'RAW');
    if (orderSel) {
      const prev = orderSel.value;
      orderSel.innerHTML = buildOpts(fgSemiCodes.length ? fgSemiCodes : itemCodes);
      if (prev) orderSel.value = prev;
    }
    if (stockSel) {
      const prev = stockSel.value;
      stockSel.innerHTML = buildOpts(itemCodes);
      if (prev) stockSel.value = prev;
    }
    if (scrapSel) {
      const prev = scrapSel.value;
      const opts = [];
      Object.keys(S.boms).sort().forEach(outCode => {
        (S.boms[outCode].steps || []).forEach(st => {
          const val = `${outCode}::${st.seq}`;
          const pct = roundQty((Number(st.scrapRate) || 0) * 100);
          opts.push(`<option value="${escapeHtml(val)}">${escapeHtml(outCode)} 站${st.seq} ${escapeHtml(st.processName)}（原 ${pct}%）</option>`);
        });
      });
      scrapSel.innerHTML = opts.join('') || `<option value="">尚未建立製程 BOM</option>`;
      if (prev) scrapSel.value = prev;
    }

    // 渲染已加入的模擬條件清單
    const orderUl = document.getElementById('wf-order-list');
    orderUl.innerHTML = S.whatIf.addedOrders.map((o, idx) => `
      <li>
        <span>${escapeHtml(o.itemCode)} × ${o.qty}（${escapeHtml(o.dueDate)} / P${o.priority}）</span>
        <button type="button" class="btn btn-outline btn-sm" data-rm-wf-order="${idx}">移除</button>
      </li>`).join('');
    orderUl.querySelectorAll('[data-rm-wf-order]').forEach(btn => {
      btn.addEventListener('click', () => {
        S.whatIf.addedOrders.splice(Number(btn.dataset.rmWfOrder), 1);
        renderWhatIfControls();
        renderWhatIfResults();
      });
    });

    const stockUl = document.getElementById('wf-stock-list');
    stockUl.innerHTML = Object.keys(S.whatIf.addedStock).map(code => `
      <li>
        <span>${escapeHtml(code)} ＋ ${S.whatIf.addedStock[code]}</span>
        <button type="button" class="btn btn-outline btn-sm" data-rm-wf-stock="${escapeHtml(code)}">移除</button>
      </li>`).join('');
    stockUl.querySelectorAll('[data-rm-wf-stock]').forEach(btn => {
      btn.addEventListener('click', () => {
        delete S.whatIf.addedStock[btn.dataset.rmWfStock];
        renderWhatIfControls();
        renderWhatIfResults();
      });
    });

    const scrapUl = document.getElementById('wf-scrap-list');
    scrapUl.innerHTML = Object.keys(S.whatIf.scrapOverrides).map(k => `
      <li>
        <span>${escapeHtml(k.replace('::', ' 站'))} → 不良率 ${roundQty(S.whatIf.scrapOverrides[k] * 100)}%</span>
        <button type="button" class="btn btn-outline btn-sm" data-rm-wf-scrap="${escapeHtml(k)}">移除</button>
      </li>`).join('');
    scrapUl.querySelectorAll('[data-rm-wf-scrap]').forEach(btn => {
      btn.addEventListener('click', () => {
        delete S.whatIf.scrapOverrides[btn.dataset.rmWfScrap];
        renderWhatIfControls();
        renderWhatIfResults();
      });
    });

    document.getElementById('whatif-banner').classList.toggle('hidden', !isWhatIfActive());
  }

  function renderWhatIfResults() {
    const combinedScheds = [
      ...Object.values(S.schedules || {}),
      ...S.whatIf.addedOrders
    ];
    const results = evaluateSchedules(S.computed, S.boms, combinedScheds, {
      addedStock: S.whatIf.addedStock,
      scrapOverrides: S.whatIf.scrapOverrides
    });
    renderReadinessList('whatif-result-list', results);
  }

  /* ==================== 雙向批號追溯渲染 ==================== */
  function renderTraceQuickChips() {
    const lotSet = new Set();
    Object.values(S.transactions || {}).forEach(tx => {
      if (tx && tx.status === 'ACTIVE' && tx.lotNo) lotSet.add(tx.lotNo);
    });
    Object.keys(S.computed.lots || {}).forEach(k => {
      const lot = k.split('||')[1];
      if (lot && lot !== 'INIT') lotSet.add(lot);
    });
    const list = Array.from(lotSet).slice(0, 20);

    const dl = document.getElementById('trace-lot-datalist');
    dl.innerHTML = list.map(l => `<option value="${escapeHtml(l)}"></option>`).join('');

    const chips = document.getElementById('quick-lot-chips');
    chips.innerHTML = list.slice(0, 10).map(l =>
      `<button type="button" class="chip" data-quick-lot="${escapeHtml(l)}">${escapeHtml(l)}</button>`
    ).join('');
    chips.querySelectorAll('[data-quick-lot]').forEach(b => {
      b.addEventListener('click', () => {
        document.getElementById('trace-lot-input').value = b.dataset.quickLot;
        renderTraceResult(b.dataset.quickLot);
      });
    });
  }

  function renderUpstreamTreeHtml(node) {
    if (!node) return '';
    if (node.cycleStop) return `<div class="trace-node">↻ 已追溯至關聯節點 ${escapeHtml(node.key)}</div>`;
    const evHtml = (node.events || []).map(ev => {
      const cls = ev.txType === 'INBOUND' ? 'inbound' : '';
      const proc = ev.processName ? `｜站${ev.stepSeq} ${ev.processName}` : '';
      return `<div class="muted">${escapeHtml(ev.txDate)} [${escapeHtml(ev.txType)}${escapeHtml(proc)}] 良品 ${ev.goodQty}${ev.scrapQty ? ` / 報廢 ${ev.scrapQty}` : ''}（${escapeHtml(ev.operatorAlias)}）</div>`;
    }).join('') || `<div class="muted">來源：期初盤點或尚未有進貨登錄</div>`;

    const parentsHtml = (node.parents || []).map(p => `
      <div style="margin-left:14px;">
        <div class="muted">↖ 耗用上游材料（消耗 ${p.usedQty}｜${escapeHtml(p.viaTx.txDate)} 站${p.viaTx.stepSeq || ''} ${escapeHtml(p.viaTx.processName || '')}）</div>
        ${renderUpstreamTreeHtml(p.node)}
      </div>`).join('');

    return `
      <div class="trace-node ${node.events.some(e => e.txType === 'INBOUND') ? 'inbound' : ''}">
        <strong>${escapeHtml(node.itemCode)}</strong> ｜ 批號 <code>${escapeHtml(node.lotNo)}</code>
        <span class="badge badge-blue">現存餘量 ${node.remainQty}</span>
        ${evHtml}
        ${parentsHtml}
      </div>`;
  }

  function renderDownstreamTreeHtml(node) {
    if (!node) return '';
    if (node.cycleStop) return `<div class="trace-node">↻ 已追蹤至關聯節點 ${escapeHtml(node.key)}</div>`;

    const shipHtml = (node.shipments || []).map(tx => `
      <div class="trace-node shipped">
        🚨 <strong>已出貨／移轉至下一端</strong>：出貨日 <strong>${escapeHtml(tx.txDate)}</strong>｜數量 <strong>${tx.goodQty}</strong>｜單號 ${escapeHtml(tx.txId)}
      </div>`).join('');

    const childHtml = (node.children || []).map(ch => `
      <div style="margin-left:14px;">
        <div class="muted">↘ 投入生產（扣用 ${ch.consumedQty}｜${escapeHtml(ch.viaTx.txDate)} 站${ch.viaTx.stepSeq || ''} ${escapeHtml(ch.viaTx.processName || '')}）</div>
        ${renderDownstreamTreeHtml(ch.node)}
      </div>`).join('');

    return `
      <div class="trace-node">
        <strong>${escapeHtml(node.itemCode)}</strong> ｜ 批號 <code>${escapeHtml(node.lotNo)}</code>
        <span class="badge badge-blue">廠內餘量 ${node.remainQty}</span>
        ${shipHtml}
        ${childHtml || (shipHtml ? '' : '<div class="muted">尚未進一步投入加工或出貨</div>')}
      </div>`;
  }

  function renderTraceResult(queryLot) {
    const out = document.getElementById('trace-output');
    const res = traceLot(queryLot);
    if (!res || res.roots.length === 0) {
      out.innerHTML = `<div class="empty-state">查無包含「${escapeHtml(queryLot)}」的批號紀錄。</div>`;
      return;
    }

    out.innerHTML = res.roots.map(root => {
      const alertBanner = root.shippedAlerts.length > 0
        ? `<div class="trace-alert-banner">
            🚨 流出警報：此批號（或其衍生成品）已有 <strong>${root.shippedAlerts.reduce((a, b) => a + (Number(b.qty) || 0), 0)}</strong> 單位出貨至下一端！
            <ul style="margin:6px 0 0 18px; font-weight:500;">
              ${root.shippedAlerts.map(a => `<li>出貨日 ${escapeHtml(a.txDate)}｜${escapeHtml(a.itemCode)}［${escapeHtml(a.lotNo)}］× ${a.qty}（單號 ${escapeHtml(a.txId)}）</li>`).join('')}
            </ul>
          </div>`
        : `<div class="card" style="margin-bottom:12px; border-left:5px solid var(--green);">
            ✅ <strong>目前尚未流出廠外</strong>：此批號與下游衍生品皆仍在廠內控制範圍（本批號餘量：${root.remainQty}）。
          </div>`;

      return `
        <div class="card" style="margin-bottom:16px;">
          <h3>批號節點：${escapeHtml(root.itemCode)} — <code>${escapeHtml(root.lotNo)}</code></h3>
          ${alertBanner}
          <div class="trace-grid">
            <div>
              <h4>⬆️ 反向追溯（來源原料與製程族譜）</h4>
              ${renderUpstreamTreeHtml(root.upstream)}
            </div>
            <div>
              <h4>⬇️ 正向追蹤（流向半成品、成品與出貨攔截）</h4>
              ${renderDownstreamTreeHtml(root.downstream)}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  /* ==================== 公開唯讀製程 BOM 檢視 ==================== */
  function renderPublicBomViewer() {
    const box = document.getElementById('public-bom-viewer');
    const keys = Object.keys(S.boms || {}).sort();
    if (keys.length === 0) {
      box.innerHTML = `<div class="empty-state">尚未建立製程 BOM 配方（管理員登入主控台後可於此建立）。</div>`;
      return;
    }

    const patternLabel = {
      SINGLE_PROCESS: '單料多製程',
      DIRECT_ASSEMBLY: '多料直接組裝',
      MULTI_SEMI: '多製程半成品複合組裝'
    };

    box.innerHTML = keys.map(outCode => {
      const bom = S.boms[outCode];
      const itemName = (S.items[outCode] && S.items[outCode].name) || outCode;
      const steps = (bom.steps || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));

      // 計算此配方累積良率
      const cumYield = steps.reduce((acc, st) => acc * (1 - (Number(st.scrapRate) || 0)), 1);
      const stepsHtml = steps.map((st, idx) => {
        const inputsHtml = (st.inputs || []).length > 0
          ? st.inputs.map(inp => `<span class="lot-pill">${escapeHtml(inp.itemCode)} × <strong>${inp.qtyPerUnit}</strong></span>`).join('')
          : `<span class="muted">（承接上一站產出，無新增耗料）</span>`;
        const inheritTag = idx > 0 ? `<span class="badge badge-blue">承接前站</span>` : '';
        const outTag = st.isOutsourced ? `<span class="badge badge-yellow">委外站</span>` : '';
        return `
          <div class="bom-step-box">
            <div class="bom-step-head">
              <span>站 ${st.seq}：${escapeHtml(st.processName)} ${inheritTag} ${outTag}</span>
              <span class="muted">不良率 ${roundQty((Number(st.scrapRate) || 0) * 100)}%</span>
            </div>
            <div style="margin-top:6px;">投入材料：${inputsHtml}</div>
          </div>`;
      }).join('');

      return `
        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div>
              <h3 style="margin:0;">${escapeHtml(outCode)} — ${escapeHtml(itemName)}</h3>
              <div class="muted">版本 v${bom.version || 1} ｜ 累積良率約 <strong>${roundQty(cumYield * 100)}%</strong></div>
            </div>
            <span class="badge badge-semi">${patternLabel[bom.pattern] || '自訂配方'}</span>
          </div>
          ${stepsHtml}
        </div>`;
    }).join('');
  }

  /* ==================== CSV 匯出（含 UTF-8 BOM 防 Excel 亂碼） ==================== */
  function exportStockCsv() {
    const rows = getFilteredInventoryRows();
    const header = ['型號代碼', '品名', '類別', '即時可用庫存', '單位', '安全庫存', '狀態', '站間WIP與待重工', '現有批號餘量'];
    const lines = [header.join(',')];

    rows.forEach(r => {
      const statusTxt = r.status === 'NEG' ? '負庫存待補帳' : (r.status === 'LOW' ? '低於安全庫存' : '正常');
      const wipTxt = r.wipEntries.map(w => `${w.label}:${w.qty}`).join(' | ');
      const lotTxt = r.lotEntries.map(l => `${l.lotNo}(${l.qty})`).join(' ; ');
      const cols = [r.code, r.it.name || '', r.it.type, r.qty, r.it.unit || '', r.safety, statusTxt, wipTxt, lotTxt]
        .map(v => `"${String(v).replace(/"/g, '""')}"`);
      lines.push(cols.join(','));
    });

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `即時庫存總表_${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已匯出 CSV（支援 Excel 繁體中文直接開啟）', 'success');
  }

  /* ==================== 介面切換與模式管理 ==================== */
  function setActiveTab(tabId) {
    S.ui.activeTab = tabId;
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`panel-${tabId}`);
    if (target) target.classList.add('active');

    document.querySelectorAll('.nav-tab, .mnav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
  }

  function applyViewMode(mode) {
    S.ui.viewMode = mode;
    document.body.classList.toggle('mode-mobile', mode === 'mobile');
    document.body.classList.toggle('mode-desktop', mode !== 'mobile');
    const btn = document.getElementById('btn-toggle-mode');
    if (btn) {
      btn.textContent = mode === 'mobile' ? '🖥️ 切換電腦管理版' : '📱 切換手機現場版';
    }
  }

  function toggleViewMode() {
    S.ui.manualModeLocked = true;
    applyViewMode(S.ui.viewMode === 'mobile' ? 'desktop' : 'mobile');
  }

  /* ==================== 本機展示範例資料（未設 Firebase 時自動載入） ==================== */
  function loadDemoData() {
    S.isDemoMode = true;
    document.getElementById('demo-banner').classList.remove('hidden');
    document.getElementById('sync-status-text').textContent = '本機展示模式（內建三種製程情境範例）';

    S.processes = [
      { name: '研磨', defaultOutsourced: false },
      { name: '雷雕', defaultOutsourced: false },
      { name: '清潔', defaultOutsourced: false },
      { name: '組裝', defaultOutsourced: false },
      { name: '品檢包裝', defaultOutsourced: false }
    ];

    S.items = {
      'A-RAW': { code: 'A-RAW', name: '共用金屬胚件 A', type: 'RAW', unit: '顆', initialQty: 20, safetyStock: 30, note: 'D 與 G 共用料' },
      'B-RAW': { code: 'B-RAW', name: '外殼組件 B', type: 'RAW', unit: '顆', initialQty: 80, safetyStock: 20, note: '' },
      'E-RAW': { code: 'E-RAW', name: '專用支架 E', type: 'RAW', unit: '顆', initialQty: 60, safetyStock: 20, note: '' },
      'X-RAW': { code: 'X-RAW', name: '單料毛胚 X', type: 'RAW', unit: '顆', initialQty: 40, safetyStock: 20, note: '純加工直接變成品 Y' },
      'A-SEMI': { code: 'A-SEMI', name: 'A-半成品(研磨雷雕)', type: 'SEMI', unit: '顆', initialQty: 10, safetyStock: 15, note: '可共用、可單獨出貨' },
      'D-FG': { code: 'D-FG', name: 'D 成品(複合組裝)', type: 'FG', unit: '顆', initialQty: 5, safetyStock: 10, note: '每顆需 2 個 A-半 + 1 個 B' },
      'G-FG': { code: 'G-FG', name: 'G 成品(共用組裝)', type: 'FG', unit: '顆', initialQty: 0, safetyStock: 10, note: '每顆需 1 個 A-半 + 1 個 E' },
      'Y-FG': { code: 'Y-FG', name: 'Y 成品(單料研磨清潔)', type: 'FG', unit: '顆', initialQty: 0, safetyStock: 10, note: '無結合其他料件' }
    };

    S.boms = {
      'A-SEMI': {
        outCode: 'A-SEMI', pattern: 'SINGLE_PROCESS', version: 1,
        steps: [
          { seq: 10, processName: '研磨', scrapRate: 0.05, isOutsourced: false, inheritLot: true, inputs: [{ itemCode: 'A-RAW', qtyPerUnit: 1 }] },
          { seq: 20, processName: '雷雕', scrapRate: 0.02, isOutsourced: false, inheritLot: true, inputs: [] }
        ]
      },
      'D-FG': {
        outCode: 'D-FG', pattern: 'MULTI_SEMI', version: 1,
        steps: [
          { seq: 10, processName: '組裝', scrapRate: 0.03, isOutsourced: false, inheritLot: false, inputs: [{ itemCode: 'A-SEMI', qtyPerUnit: 2 }, { itemCode: 'B-RAW', qtyPerUnit: 1 }] },
          { seq: 20, processName: '品檢包裝', scrapRate: 0.01, isOutsourced: false, inheritLot: true, inputs: [] }
        ]
      },
      'G-FG': {
        outCode: 'G-FG', pattern: 'DIRECT_ASSEMBLY', version: 1,
        steps: [
          { seq: 10, processName: '組裝', scrapRate: 0.02, isOutsourced: false, inheritLot: false, inputs: [{ itemCode: 'A-SEMI', qtyPerUnit: 1 }, { itemCode: 'E-RAW', qtyPerUnit: 1 }] }
        ]
      },
      'Y-FG': {
        outCode: 'Y-FG', pattern: 'SINGLE_PROCESS', version: 1,
        steps: [
          { seq: 10, processName: '研磨', scrapRate: 0.05, isOutsourced: false, inheritLot: true, inputs: [{ itemCode: 'X-RAW', qtyPerUnit: 1 }] },
          { seq: 20, processName: '清潔', scrapRate: 0.02, isOutsourced: false, inheritLot: true, inputs: [] }
        ]
      }
    };

    const now = Date.now();
    S.transactions = {
      'TX-DEMO-1': {
        txId: 'TX-DEMO-1', txType: 'INBOUND', status: 'ACTIVE', txDate: todayStr(-4),
        itemCode: 'A-RAW', goodQty: 100, scrapQty: 0, reworkQty: 0, lotNo: 'LOT-A01',
        operatorAlias: '倉管-01', createdAt: now - 400000
      },
      'TX-DEMO-2': {
        txId: 'TX-DEMO-2', txType: 'WORKLOG', status: 'ACTIVE', txDate: todayStr(-3),
        itemCode: 'A-SEMI', stepSeq: 10, prevStepSeq: null, processName: '研磨', isFinalStep: false, isRework: false,
        goodQty: 40, scrapQty: 2, reworkQty: 3, lotNo: 'LOT-A01',
        consumedLots: [{ itemCode: 'A-RAW', lotNo: 'LOT-A01', qty: 45 }],
        operatorAlias: '現場-02', createdAt: now - 300000
      },
      'TX-DEMO-3': {
        txId: 'TX-DEMO-3', txType: 'WORKLOG', status: 'ACTIVE', txDate: todayStr(-2),
        itemCode: 'A-SEMI', stepSeq: 20, prevStepSeq: 10, processName: '雷雕', isFinalStep: true, isRework: false,
        goodQty: 38, scrapQty: 2, reworkQty: 0, lotNo: 'LOT-A01',
        consumedLots: [],
        operatorAlias: '現場-02', createdAt: now - 200000
      },
      'TX-DEMO-4': {
        txId: 'TX-DEMO-4', txType: 'WORKLOG', status: 'ACTIVE', txDate: todayStr(-1),
        itemCode: 'D-FG', stepSeq: 10, prevStepSeq: null, processName: '組裝', isFinalStep: false, isRework: false,
        goodQty: 15, scrapQty: 0, reworkQty: 0, lotNo: 'WO-D-001',
        consumedLots: [
          { itemCode: 'A-SEMI', lotNo: 'LOT-A01', qty: 30 },
          { itemCode: 'B-RAW', lotNo: 'INIT', qty: 15 }
        ],
        operatorAlias: '現場-03', createdAt: now - 150000
      },
      'TX-DEMO-5': {
        txId: 'TX-DEMO-5', txType: 'WORKLOG', status: 'ACTIVE', txDate: todayStr(-1),
        itemCode: 'D-FG', stepSeq: 20, prevStepSeq: 10, processName: '品檢包裝', isFinalStep: true, isRework: false,
        goodQty: 15, scrapQty: 0, reworkQty: 0, lotNo: 'WO-D-001',
        consumedLots: [],
        operatorAlias: '現場-03', createdAt: now - 100000
      },
      'TX-DEMO-6': {
        txId: 'TX-DEMO-6', txType: 'OUTBOUND', status: 'ACTIVE', txDate: todayStr(0),
        itemCode: 'D-FG', goodQty: 10, scrapQty: 0, reworkQty: 0, lotNo: 'WO-D-001',
        operatorAlias: '倉管-01', createdAt: now - 50000
      },
      'TX-DEMO-7': {
        txId: 'TX-DEMO-7', txType: 'WORKLOG', status: 'ACTIVE', txDate: todayStr(0),
        itemCode: 'Y-FG', stepSeq: 10, prevStepSeq: null, processName: '研磨', isFinalStep: false, isRework: false,
        goodQty: 25, scrapQty: 1, reworkQty: 0, lotNo: 'LOT-X99',
        consumedLots: [{ itemCode: 'X-RAW', lotNo: 'INIT', qty: 26 }],
        operatorAlias: '現場-02', createdAt: now - 30000
      }
    };

    S.schedules = {
      'SCH-01': { schedId: 'SCH-01', dueDate: todayStr(2), itemCode: 'D-FG', qty: 35, shippedQty: 0, priority: 1, status: 'OPEN', note: '週三第一批出貨（與 G 搶共用料 A）' },
      'SCH-02': { schedId: 'SCH-02', dueDate: todayStr(4), itemCode: 'G-FG', qty: 40, shippedQty: 0, priority: 2, status: 'OPEN', note: '週五第二批出貨' },
      'SCH-03': { schedId: 'SCH-03', dueDate: todayStr(5), itemCode: 'Y-FG', qty: 35, shippedQty: 0, priority: 3, status: 'OPEN', note: '含 25 顆已研磨 WIP 等清潔' }
    };

    recomputeAndRender();
  }

  /* ==================== Firebase 初始化與即時監聽 ==================== */
  function initFirebase() {
    const isUnconfigured = !FIREBASE_CONFIG.databaseURL || FIREBASE_CONFIG.databaseURL.includes('YOUR_PROJECT_ID');
    if (isUnconfigured || typeof firebase === 'undefined') {
      loadDemoData();
      return;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }
      S.db = firebase.database();
      S.authInstance = firebase.auth();

      const pubRef = S.db.ref('public_view');
      pubRef.on('value', snap => {
        const val = snap.val() || {};
        S.items = val.items || {};
        S.boms = val.boms || {};
        S.processes = (val.meta && Array.isArray(val.meta.processes)) ? val.meta.processes : [];
        S.transactions = val.transactions || {};
        S.schedules = val.schedules || {};

        document.getElementById('sync-status-text').textContent = `雲端即時連線中｜最後更新 ${formatDateTime(Date.now())}`;
        recomputeAndRender();
      }, err => {
        document.getElementById('sync-status-text').textContent = 'Firebase 讀取失敗：' + err.message;
        showToast('無法讀取公開資料：' + err.message, 'error');
      });
    } catch (err) {
      console.error(err);
      showToast('Firebase 初始化失敗，暫切換展示模式', 'error');
      loadDemoData();
    }
  }

  /* ==================== 事件綁定與啟動 ==================== */
  function bindEvents() {
    // 分頁切換
    document.querySelectorAll('.nav-tab, .mnav-btn').forEach(btn => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    });

    // 手動切換電腦 / 手機模式
    document.getElementById('btn-toggle-mode').addEventListener('click', toggleViewMode);
    window.addEventListener('resize', () => {
      if (!S.ui.manualModeLocked) {
        applyViewMode(window.innerWidth <= 768 ? 'mobile' : 'desktop');
      }
    });

    // 庫存搜尋與篩選
    document.getElementById('inv-search').addEventListener('input', e => {
      S.ui.invSearch = e.target.value;
      renderInventoryTable();
    });
    document.querySelectorAll('#inv-type-chips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#inv-type-chips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        S.ui.invFilter = chip.dataset.filter;
        renderInventoryTable();
      });
    });
    document.getElementById('btn-export-csv').addEventListener('click', exportStockCsv);
    document.getElementById('btn-goto-whatif').addEventListener('click', () => setActiveTab('whatif'));

    // What-if 操作
    document.getElementById('btn-wf-add-order').addEventListener('click', () => {
      const itemCode = document.getElementById('wf-order-item').value;
      const qty = Number(document.getElementById('wf-order-qty').value);
      const dueDate = document.getElementById('wf-order-date').value || todayStr(1);
      const priority = Number(document.getElementById('wf-order-priority').value) || 1;
      if (!itemCode || qty <= 0) return showToast('請選擇型號並輸入大於 0 的數量', 'error');

      S.whatIf.addedOrders.push({
        schedId: `SIM-${Date.now().toString().slice(-4)}`,
        itemCode, qty, shippedQty: 0, dueDate, priority,
        status: 'OPEN', isSimulated: true, note: '模擬插單'
      });
      renderWhatIfControls();
      renderWhatIfResults();
      showToast('已加入模擬排程，右側已重新試算全廠衝擊', 'success');
    });

    document.getElementById('btn-wf-add-stock').addEventListener('click', () => {
      const code = document.getElementById('wf-stock-item').value;
      const qty = Number(document.getElementById('wf-stock-qty').value);
      if (!code || !qty) return showToast('請選擇料號與數量', 'error');
      S.whatIf.addedStock[code] = roundQty((S.whatIf.addedStock[code] || 0) + qty);
      renderWhatIfControls();
      renderWhatIfResults();
    });

    document.getElementById('btn-wf-add-scrap').addEventListener('click', () => {
      const target = document.getElementById('wf-scrap-target').value;
      const pct = Number(document.getElementById('wf-scrap-rate').value);
      if (!target || pct < 0 || pct >= 95) return showToast('請選擇站別並輸入 0～94.9% 不良率', 'error');
      S.whatIf.scrapOverrides[target] = pct / 100;
      renderWhatIfControls();
      renderWhatIfResults();
    });

    const resetWhatIf = () => {
      S.whatIf.addedOrders = [];
      S.whatIf.addedStock = {};
      S.whatIf.scrapOverrides = {};
      renderWhatIfControls();
      renderWhatIfResults();
      showToast('已清除全部模擬參數');
    };
    document.getElementById('btn-reset-whatif').addEventListener('click', resetWhatIf);
    document.getElementById('btn-exit-whatif').addEventListener('click', resetWhatIf);

    // 雙向批號追溯
    document.getElementById('btn-run-trace').addEventListener('click', () => {
      const q = document.getElementById('trace-lot-input').value;
      renderTraceResult(q);
    });
    document.getElementById('trace-lot-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') renderTraceResult(e.target.value);
    });
  }

  function registerConsoleHook(fn) {
    if (typeof fn === 'function') S.consoleHooks.push(fn);
  }

  function init() {
    applyViewMode(S.ui.viewMode);
    bindEvents();
    initFirebase();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    roundQty,
    escapeHtml,
    formatDateTime,
    todayStr,
    showToast,
    computeInventoryState,
    evaluateSchedules,
    traceLot,
    checkBomCycle,
    getBomStepWip,
    recomputeAndRender,
    setActiveTab,
    applyViewMode,
    registerConsoleHook
  };
})();
