// ==UserScript==
// @name         拓元搶票全自動搶票腳本
// @namespace    http://tampermonkey.net/
// @version      10.0
// @description  融合版：v9.x 正確性修正 + v41 四階段自動化。票區用結構推導(不靠 class)，選區 5 種模式，優先清單可拖曳排序。
// @author       Combined
// @match        https://tixcraft.com/*
// @match        https://*.tixcraft.com/*
// @connect      127.0.0.1
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // =========================================================
    // 0. 攔截 alert / confirm
    // =========================================================
    // 攔截但「保留訊息」到 dataset。這是選票頁重試的唯一觸發來源 ——
    // 驗證碼錯誤時網站只會 alert，若攔截後未保留訊息，重試機制將無從觸發 (v41 的缺陷)。
    (function() {
        const s = document.createElement('script');
        s.textContent = `
            (function() {
                window.alert = function(msg) {
                    console.log('[攔截 alert]', msg);
                    document.documentElement.dataset.botAlertMsg = msg;
                    document.documentElement.dataset.botAlertTime = Date.now();
                    return true;
                };
                window.confirm = function() { return true; };
            })();`;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
    })();

    // =========================================================
    // 1. 設定
    // =========================================================
    const DEFAULTS = {
        BOT_ENABLED: true,

        TICKET_QTY: 2,
        PROMO_CODE: "",
        SESSION_KEYS: "",              // 目標日期 MM/DD，逗號分隔

        // priority_any  文字優先清單，未命中時改為不限條件選取
        // priority_wait 文字優先清單，未命中時等待並重新整理
        // expensive     最高票價優先
        // range         指定價格區間
        // any           不限條件，依剩餘數選取
        AREA_MODE: "",
        PRIORITY_LIST: "",             // 有順序，前面優先
        EXCLUDE_KEYWORDS: "身障,輪椅,站席,陪同",
        MIN_PRICE: 0,
        MAX_PRICE: 100000,
        MIN_VALID_PRICE: 400,

        CLICK_DELAY: 0,
        JITTER: 20,
        NO_TICKET_WAIT: 3000,
        ERROR_RETRY: 200,
        SCAN_TIMEOUT: 3000,
        SUBMIT_WATCHDOG: 4000,

        API_URL_1: "http://127.0.0.1:8000/ocr",
        API_URL_2: "",
        OCR_TIMEOUT: 3000,
        CAPTCHA_LENGTH: 4,

        SYNC_ENABLED: true,
        KEEPALIVE: true,
        GUI_POS: null
    };

    const CONFIG = {};
    Object.keys(DEFAULTS).forEach(k => { CONFIG[k] = GM_getValue(k, DEFAULTS[k]); });

    // 從舊版的 STRATEGY 遷移
    if (!CONFIG.AREA_MODE) {
        CONFIG.AREA_MODE = (GM_getValue('STRATEGY', 'default') === 'range') ? 'range' : 'expensive';
    }

    // =========================================================
    // 2. 工具
    // =========================================================
    function onReady(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
        else fn();
    }
    function listOf(csv) { return String(csv || "").split(',').map(s => s.trim()).filter(Boolean); }
    function norm(s) { return String(s || "").replace(/\s+/g, ''); }
    function textOf(el) { return el ? (el.innerText || el.textContent || '') : ''; }
    function clickDelay() { return CONFIG.CLICK_DELAY + Math.floor(Math.random() * Math.max(0, CONFIG.JITTER)); }

    function addLog(msg) {
        const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
        console.log(`[UBot ${time}] ${msg}`);
        let logs = [];
        try { logs = JSON.parse(sessionStorage.getItem('ubot_logs') || "[]"); } catch (e) {}
        logs.unshift(`<span style="color:#666">${time}</span> ${msg}`);
        if (logs.length > 40) logs.length = 40;
        try { sessionStorage.setItem('ubot_logs', JSON.stringify(logs)); } catch (e) {}
        const el = document.getElementById('ubot-log');
        if (el) el.innerHTML = logs.join('<br>');
    }
    function setStatus(t) { const el = document.getElementById('ubot-status'); if (el) el.innerText = t; }

    // =========================================================
    // 3. 跨分頁互斥
    // =========================================================
    // v41 的實作為單向且無期限：任一分頁進入選票頁即廣播 HALT，
    // 其餘分頁將暫停至重新整理為止，即使該分頁後續失敗亦然。
    // 此處改為具期限的租約搭配心跳：持有者每 5 秒續約 15 秒，
    // 分頁關閉或異常終止後，租約到期即自動解除。
    const MY_ID = Math.random().toString(36).slice(2);
    let channel = null;
    let peerUntil = 0;

    if (CONFIG.SYNC_ENABLED) {
        try {
            channel = new BroadcastChannel('UBot_Sync');
            channel.onmessage = (e) => {
                const d = e.data || {};
                if (d.id === MY_ID) return;
                if (d.type === 'HOLD') peerUntil = Math.max(peerUntil, d.until || 0);
                else if (d.type === 'RELEASE') peerUntil = 0;
            };
        } catch (e) {}
    }

    function peerHolding() {
        if (!CONFIG.SYNC_ENABLED) return false;
        if (Date.now() < peerUntil) { setStatus("其他分頁結帳中，暫停"); return true; }
        return false;
    }
    function claimHold() {
        if (!channel) return;
        const beat = () => { try { channel.postMessage({ type: 'HOLD', id: MY_ID, until: Date.now() + 15000 }); } catch (e) {} };
        beat();
        const id = setInterval(beat, 5000);
        window.addEventListener('beforeunload', () => {
            clearInterval(id);
            try { channel.postMessage({ type: 'RELEASE', id: MY_ID }); } catch (e) {}
        });
    }
    function canAct() { return CONFIG.BOT_ENABLED && !peerHolding(); }

    // =========================================================
    // 4. 票區探索（版面無關）
    // =========================================================
    // 本模組不預設任何 class 名稱或文字格式。實測拓元至少存在三種版面：
    //   A) 特A3區 (best available) 剩餘 39   標題「…VIP限量套票 $9700」
    //   B) 橙207區4880 已售完                 標題「2F 4880區」(無 $)
    //   C) 全區 剩餘 96                       標題「VIP PACKAGE」(完全沒有價格)
    // 逐一針對版面撰寫規則無法涵蓋後續變更，因此改以結構特徵判定：
    // 無論版面如何調整，票區列必為一組「結構相同且多數可點擊的兄弟節點」。
    // 已知 class、狀態字樣、指向購票流程的 href 僅作為加權條件。

    const STATUS_RE = /剩餘\s*\d+|已?售完|完售|熱賣|搶購|Sold\s*Out/i;

    const KNOWN_ROW_SELECTORS = [
        'li.select_form_b', 'tr.select_form_b',
        'ul.area-list > li', '.zone-area-list > div', '#zoneList li'
    ];

    // 導覽列、頁尾、座位圖 SVG 及本腳本面板均不可能為票區列。
    // 其中 SVG 尤須排除：座位圖包含數百個結構相同且可點擊的 <path>，
    // 未排除時其分數將高於實際的票區清單。
    const SKIP_SEL = 'header, nav, footer, aside, svg, #ubot-gui';
    function isSkipped(el) { return !!(el.closest && el.closest(SKIP_SEL)); }

    // 可點擊目標：自己或子孫的 a/button，或掛了 onclick 的元素
    function linkOf(el) {
        if (el.tagName === 'A' || el.tagName === 'BUTTON') return el;
        const a = el.querySelector && el.querySelector('a, button');
        if (a) return a;
        if (el.hasAttribute && (el.hasAttribute('onclick') || el.getAttribute('role') === 'button')) return el;
        return null;
    }

    // 結構簽章：同一組票區列的 tag + class 會一致
    function sigOf(el) {
        return el.tagName + '.' + Array.from(el.classList || []).sort().join('.');
    }

    function scoreBucket(members, lenient) {
        let clickable = 0, status = 0, ticketHref = 0, len = 0;
        for (const m of members) {
            const link = linkOf(m);
            if (link) {
                clickable++;
                const href = (link.getAttribute && (link.getAttribute('href') || link.getAttribute('data-href'))) || '';
                if (href.indexOf('/ticket/') >= 0) ticketHref++;
            }
            if (STATUS_RE.test(m.textContent || '')) status++;
            len += norm(textOf(m)).length;
        }
        if (clickable === 0) return null;
        if (!lenient && members.length < 2) return null;
        // 寬鬆模式（僅存單一票區）需具備更明確的佐證
        if (lenient && members.length < 2 && status === 0 && ticketHref === 0) return null;

        const avg = len / members.length;
        if (avg < 2 || avg > 120) return null;      // 過短者可能為圖示，過長者可能為內文段落
        return {
            members, clickable, status, ticketHref, avg,
            score: members.length + clickable * 2 + status * 4 + ticketHref * 3
        };
    }

    function bestBucket(lenient) {
        let best = null;
        for (const p of document.querySelectorAll('body *')) {
            if (!p.children || p.children.length < 1 || isSkipped(p)) continue;
            const buckets = new Map();
            for (const c of p.children) {
                if (c.style && c.style.display === 'none') continue;
                const k = sigOf(c);
                if (!buckets.has(k)) buckets.set(k, []);
                buckets.get(k).push(c);
            }
            for (const [k, members] of buckets) {
                const s = scoreBucket(members, lenient);
                if (s && (!best || s.score > best.score)) { s.sigKey = k; best = s; }
            }
        }
        return best;
    }

    function discoverRows() {
        // 優先路徑：已知 class 命中時直接採用，精確且成本低
        for (const sel of KNOWN_ROW_SELECTORS) {
            const f = Array.from(document.querySelectorAll(sel))
                .filter(el => el.style.display !== 'none' && !isSkipped(el));
            if (f.length > 0) return { rows: f, how: `class ${sel}` };
        }
        // 泛用路徑
        let b = bestBucket(false) || bestBucket(true);
        if (b) return { rows: b.members, how: `結構 ${b.sigKey} 分${b.score}` };
        return { rows: [], how: null };
    }

    // 群組標題定義為向前搜尋到的第一個非票區列兄弟節點，判定不涉及價格，
    // 因此「VIP PACKAGE」這類不含價格的標題亦可取得。
    // 分兩輪執行：第一輪略過所有票區列；若標題與票區列結構簽章相同而被誤收，
    // 第二輪僅略過可點擊的票區列，即可取得不可點擊的標題。
    function findGroupEl(el, allRows, clickableRows) {
        const walk = (skipSet) => {
            const wrapsRow = (n) => {
                for (const r of skipSet) { if (n !== r && n.contains && n.contains(r)) return true; }
                return false;
            };
            let node = el;
            for (let d = 0; d < 4 && node && node.tagName !== 'BODY'; d++) {
                let sib = node.previousElementSibling;
                while (sib) {
                    if (!skipSet.has(sib) && norm(textOf(sib)).length > 0 && !wrapsRow(sib)) return sib;
                    sib = sib.previousElementSibling;
                }
                node = node.parentElement;
            }
            return null;
        };
        return walk(allRows) || walk(clickableRows);
    }

    // =========================================================
    // 5. 票價 / 剩餘數
    // =========================================================
    // 解析票價前先移除非價格數字：
    //   1. 狀態字樣 —— 否則「剩餘 500」之 500 將被誤判為票價
    //   2. 區號標籤 —— 「綠518區2080」之 518 超過門檻將被誤判為票價，
    //      導致價格解析為 518~2080
    function stripNoise(text) {
        return String(text || "")
            .replace(/剩餘\s*\d+/g, ' ')
            .replace(/已?售完|完售|熱賣中|熱賣|熱門|搶購中|Sold\s*Out|best\s*available/gi, ' ')
            .replace(/[^\d\s,$＄]+\d+區/g, ' ');
    }

    function parsePrices(text) {
        const out = [];
        const re = /(?:NT\$|NTD|\$|＄)\s*([\d,]+)|([\d,]+)\s*元/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            const n = parseInt((m[1] || m[2]).replace(/,/g, ''), 10);
            if (Number.isFinite(n) && n > 0) out.push(n);
        }
        if (out.length > 0) return out;

        // 含千分位逗號之數字可判定為金額，且必須連同逗號一併擷取：
        // 舊版使用 /\d+/g 會將「9,700」切分為 ["9","700"] 而解析為 700，
        // 「10,000」「2,000」「1,200」則解析為 0。
        const grouped = (text.match(/\d{1,3}(?:,\d{3})+/g) || [])
            .map(n => parseInt(n.replace(/,/g, ''), 10))
            .filter(n => Number.isFinite(n) && n > 0);
        if (grouped.length > 0) return grouped;

        return (text.match(/\d+/g) || [])
            .map(n => parseInt(n, 10))
            .filter(n => Number.isFinite(n) && n >= CONFIG.MIN_VALID_PRICE);
    }

    // 回傳 {min,max} 或 null。群組標題可能是區間 ($5800~$9200)。
    function priceOf(el, groupEl) {
        let p = parsePrices(stripNoise(textOf(el)));
        if (p.length === 0 && groupEl) p = parsePrices(stripNoise(textOf(groupEl)));
        if (p.length === 0) return null;
        return { min: Math.min(...p), max: Math.max(...p) };
    }

    // 採三種狀態而非二元判定：
    //   「剩餘 39」→ 39   「已售完」→ 0   「熱賣中」或未標示 → null（有票，數量未知）
    // 舊版將「熱賣中」判定為 0（視為無票），v41 判定為 999（視為充足），兩者皆不正確。
    // 未知字樣一律視為「有票但數量未知」並放行：最差情況為進入後發現無票並重新整理，
    // 優於誤判為無票而直接放棄。
    function seatsOf(el) {
        const t = textOf(el);
        if (/已?售完|完售|Sold\s*Out/i.test(t)) return 0;
        const m = t.match(/剩餘\s*(\d+)/) || t.match(/(\d+)\s*seats?\s*(?:left|available)/i);
        if (m) return parseInt(m[1], 10);
        return null;
    }

    function hasExcluded(text) {
        const t = norm(text);
        return listOf(CONFIG.EXCLUDE_KEYWORDS).some(k => t.includes(norm(k)));
    }

    // 只勾表單內的 checkbox，並觸發事件通知前端框架 (Vue/jQuery)。
    // 僅設定 .checked 不會更新框架的 model，同意條款可能被判定為未勾選。
    function checkAgreements() {
        const scope = document.querySelector('form') || document;
        scope.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            if (!cb.checked) {
                cb.checked = true;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
                cb.dispatchEvent(new Event('click', { bubbles: true }));
            }
        });
    }

    // =========================================================
    // 6. GUI
    // =========================================================
    const MODES = [
        ['priority_any',  '優先清單（未命中時不限條件）'],
        ['priority_wait', '優先清單（未命中時等待）'],
        ['expensive',     '最貴優先'],
        ['range',         '價格區間'],
        ['any',           '不限條件（剩餘數優先）']
    ];

    let edDates = listOf(CONFIG.SESSION_KEYS);
    let edPrio = listOf(CONFIG.PRIORITY_LIST);
    let edExcl = listOf(CONFIG.EXCLUDE_KEYWORDS);

    function numOpts(max) {
        return Array.from({ length: max }, (_, i) => {
            const v = String(i + 1).padStart(2, '0');
            return `<option value="${v}">${v}</option>`;
        }).join('');
    }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    // 可拖曳 + ▲▼ 調整順序的清單
    function renderSortable(containerId, arr) {
        const c = document.getElementById(containerId);
        if (!c) return;
        c.innerHTML = '';
        if (arr.length === 0) {
            c.innerHTML = '<div class="ubot-empty">（尚未設定）</div>';
            return;
        }
        arr.forEach((val, i) => {
            const row = document.createElement('div');
            row.className = 'ubot-item';
            row.draggable = true;
            row.innerHTML =
                `<span class="ubot-num">${i + 1}</span>` +
                `<span class="ubot-txt">${esc(val)}</span>` +
                `<span class="ubot-mv" data-up="${i}" title="上移">▲</span>` +
                `<span class="ubot-mv" data-dn="${i}" title="下移">▼</span>` +
                `<span class="ubot-x" data-rm="${i}" title="刪除">×</span>`;
            row.ondragstart = (e) => { c.dataset.from = String(i); e.dataTransfer.effectAllowed = 'move'; };
            row.ondragover = (e) => { e.preventDefault(); row.classList.add('over'); };
            row.ondragleave = () => row.classList.remove('over');
            row.ondrop = (e) => {
                e.preventDefault();
                row.classList.remove('over');
                const from = parseInt(c.dataset.from, 10);
                if (Number.isFinite(from) && from !== i) {
                    const [moved] = arr.splice(from, 1);
                    arr.splice(i, 0, moved);
                    renderSortable(containerId, arr);
                }
            };
            c.appendChild(row);
        });
        const swap = (a, b) => {
            if (b < 0 || b >= arr.length) return;
            [arr[a], arr[b]] = [arr[b], arr[a]];
            renderSortable(containerId, arr);
        };
        c.querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
            const i = parseInt(b.dataset.up, 10); swap(i, i - 1);
        });
        c.querySelectorAll('[data-dn]').forEach(b => b.onclick = () => {
            const i = parseInt(b.dataset.dn, 10); swap(i, i + 1);
        });
        c.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
            arr.splice(parseInt(b.dataset.rm, 10), 1);
            renderSortable(containerId, arr);
        });
    }

    function renderTags(id, arr, cls) {
        const c = document.getElementById(id);
        if (!c) return;
        c.innerHTML = '';
        arr.forEach((tag, i) => {
            const el = document.createElement('span');
            el.className = 'ubot-tag ' + (cls || '');
            el.innerHTML = esc(tag) + ` <span class="ubot-x" data-rm="${i}">×</span>`;
            c.appendChild(el);
        });
        c.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
            arr.splice(parseInt(b.dataset.rm, 10), 1);
            renderTags(id, arr, cls);
        });
    }

    function createGUI() {
        if (document.getElementById('ubot-gui')) return;

        GM_addStyle(`
            #ubot-gui { position: fixed; width: 322px; background: rgba(16,16,18,.96); backdrop-filter: blur(20px);
                color: #e5e5ea; border: 1px solid rgba(255,255,255,.14); border-radius: 14px; z-index: 2147483647;
                font-family: -apple-system, "Microsoft JhengHei", sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.7); }
            #ubot-handle { padding: 10px 14px; cursor: move; border-bottom: 1px solid rgba(255,255,255,.08);
                display: flex; justify-content: space-between; align-items: center; user-select: none; }
            #ubot-handle b { font-size: 13px; color: #fff; letter-spacing: .5px; }
            .ubot-icon { cursor: pointer; color: #8e8e93; font-size: 15px; padding: 0 4px; }
            .ubot-icon:hover { color: #fff; }
            #ubot-dash { padding: 14px; }
            #ubot-clock { font-family: ui-monospace, monospace; font-size: 34px; font-weight: 800; color: #fff;
                text-align: center; margin-bottom: 6px; letter-spacing: 1px; }
            #ubot-status { text-align: center; font-size: 11px; color: #0a84ff; margin-bottom: 8px;
                font-weight: 700; min-height: 14px; }
            #ubot-log { height: 132px; overflow-y: auto; background: rgba(0,0,0,.45); padding: 8px; font-size: 10px;
                color: #d1d1d6; font-family: ui-monospace, monospace; border-radius: 7px; line-height: 1.6;
                border: 1px solid rgba(255,255,255,.06); }
            #ubot-set { padding: 12px; display: none; max-height: 62vh; overflow-y: auto; }
            .ubot-grp { background: rgba(255,255,255,.05); padding: 10px; border-radius: 9px; margin-bottom: 9px; }
            .ubot-grp-t { font-size: 10px; color: #0a84ff; font-weight: 800; letter-spacing: 1px;
                margin-bottom: 7px; border-bottom: 1px solid rgba(255,255,255,.06); padding-bottom: 4px; }
            .ubot-r { display: flex; justify-content: space-between; align-items: center; margin-bottom: 7px; gap: 6px; }
            .ubot-r label { font-size: 11px; color: #aeaeb2; font-weight: 600; }
            .ubot-in { background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.1); color: #fff;
                border-radius: 5px; padding: 4px 6px; font-size: 12px; outline: none; box-sizing: border-box; }
            .ubot-in[type=number] { width: 64px; text-align: center; }
            select.ubot-in { cursor: pointer; }
            .ubot-add { display: flex; gap: 5px; margin-top: 4px; }
            .ubot-add .ubot-in { flex: 1; min-width: 0; }
            .ubot-b { background: #2c2c2e; color: #fff; border: 1px solid #48484a; border-radius: 5px;
                cursor: pointer; padding: 4px 9px; font-size: 11px; white-space: nowrap; }
            .ubot-b:hover { background: #0a84ff; border-color: #0a84ff; }
            .ubot-hint { font-size: 9px; color: #6e6e73; margin-top: 4px; line-height: 1.4; }
            .ubot-empty { font-size: 10px; color: #5a5a5e; padding: 5px 2px; }
            .ubot-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
            .ubot-tag { background: rgba(10,132,255,.18); border: 1px solid #0a84ff; color: #fff;
                padding: 2px 6px; border-radius: 4px; font-size: 10px; }
            .ubot-tag.date { background: rgba(255,214,10,.14); border-color: #ffd60a; color: #ffd60a; font-family: ui-monospace, monospace; }
            .ubot-tag.exc { background: rgba(255,69,58,.14); border-color: #ff453a; color: #ff453a; }
            .ubot-x { cursor: pointer; opacity: .55; margin-left: 4px; font-weight: bold; }
            .ubot-x:hover { opacity: 1; color: #ff453a; }
            #ubot-prio { margin-top: 6px; }
            .ubot-item { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,.06);
                border: 1px solid rgba(255,255,255,.1); border-radius: 6px; padding: 4px 6px; margin-bottom: 4px;
                cursor: grab; font-size: 11px; }
            .ubot-item.over { border-color: #0a84ff; background: rgba(10,132,255,.18); }
            .ubot-num { background: #0a84ff; color: #fff; width: 15px; height: 15px; border-radius: 50%;
                font-size: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-weight: 700; }
            .ubot-txt { flex: 1; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .ubot-mv { cursor: pointer; color: #8e8e93; font-size: 9px; padding: 0 1px; }
            .ubot-mv:hover { color: #0a84ff; }
            .ubot-btn { width: 100%; padding: 10px; border-radius: 9px; font-weight: 700; cursor: pointer;
                border: none; margin-top: 8px; font-size: 13px; }
            .ubot-p { background: #0a84ff; color: #fff; } .ubot-d { background: #ff453a; color: #fff; }
            .ubot-s { background: rgba(255,255,255,.14); color: #fff; }
            #ubot-gui ::-webkit-scrollbar { width: 4px; }
            #ubot-gui ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.2); border-radius: 2px; }
        `);

        const g = document.createElement('div');
        g.id = 'ubot-gui';
        const pos = CONFIG.GUI_POS || { top: 20, left: Math.max(10, window.innerWidth - 342) };
        g.style.top = parseInt(pos.top, 10) + 'px';
        g.style.left = parseInt(pos.left, 10) + 'px';

        g.innerHTML = `
            <div id="ubot-handle"><b>自動搶票 v10.0</b><span id="ubot-gear" class="ubot-icon">⚙</span></div>
            <div id="ubot-dash">
                <div id="ubot-clock">00:00:00</div>
                <div id="ubot-status">待機中</div>
                <div id="ubot-log"></div>
                <button id="ubot-master" class="ubot-btn ${CONFIG.BOT_ENABLED ? 'ubot-d' : 'ubot-p'}">
                    ${CONFIG.BOT_ENABLED ? '停止運行' : '啟動運行'}</button>
            </div>
            <div id="ubot-set">
                <div class="ubot-grp">
                    <div class="ubot-grp-t">目標</div>
                    <div class="ubot-r"><label>購票數量</label>
                        <select id="c-qty" class="ubot-in" style="width:74px">
                        ${[1,2,3,4].map(n => `<option value="${n}" ${CONFIG.TICKET_QTY === n ? 'selected' : ''}>${n} 張</option>`).join('')}
                        </select></div>
                    <div class="ubot-r"><label>優先購票碼</label>
                        <input type="text" id="c-promo" class="ubot-in" style="width:132px" value="${esc(CONFIG.PROMO_CODE)}"></div>
                    <div class="ubot-r"><label>目標日期</label>
                        <div style="display:flex;gap:3px;align-items:center">
                            <select id="c-mm" class="ubot-in" style="width:50px">${numOpts(12)}</select>/
                            <select id="c-dd" class="ubot-in" style="width:50px">${numOpts(31)}</select>
                            <button id="c-add-date" class="ubot-b">新增</button>
                        </div></div>
                    <div id="ubot-dates" class="ubot-tags"></div>
                    <div class="ubot-hint">留空表示不限定日期，將選取第一個可購買的場次</div>
                </div>

                <div class="ubot-grp">
                    <div class="ubot-grp-t">選區模式</div>
                    <select id="c-mode" class="ubot-in" style="width:100%">
                    ${MODES.map(([v, t]) => `<option value="${v}" ${CONFIG.AREA_MODE === v ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                    <div id="box-prio" style="margin-top:8px">
                        <label style="font-size:11px;color:#aeaeb2;font-weight:600">優先清單（可拖曳，或使用 ▲▼ 調整順序）</label>
                        <div class="ubot-add">
                            <input type="text" id="i-prio" class="ubot-in" placeholder="VIP / 紅219區 / 6680">
                            <button id="c-add-prio" class="ubot-b">＋ 新增</button>
                        </div>
                        <div id="ubot-prio"></div>
                        <div class="ubot-hint">採子字串比對，比對範圍包含票區列文字及其群組標題。<br>
                            當不同群組的票區同名（例如皆為「全區」）時，請輸入群組名稱以區分。<br>
                            輸入「A1」將同時符合 A10、A11，建議連同「區」一併輸入。</div>
                    </div>
                    <div id="box-range" style="margin-top:8px">
                        <div class="ubot-r"><label>價格範圍</label>
                            <div style="display:flex;gap:4px;align-items:center">
                                <input type="number" id="c-min" class="ubot-in" value="${CONFIG.MIN_PRICE}">～
                                <input type="number" id="c-max" class="ubot-in" value="${CONFIG.MAX_PRICE}">
                            </div></div>
                    </div>
                </div>

                <div class="ubot-grp">
                    <div class="ubot-grp-t">排除（場次 / 票區 / 票種 全域）</div>
                    <div class="ubot-add">
                        <input type="text" id="i-excl" class="ubot-in" placeholder="身障 / 輪椅 …">
                        <button id="c-add-excl" class="ubot-b">＋ 新增</button>
                    </div>
                    <div id="ubot-excl" class="ubot-tags"></div>
                </div>

                <div class="ubot-grp">
                    <div class="ubot-grp-t">OCR</div>
                    <div class="ubot-r"><label>端點 1</label>
                        <input type="text" id="c-api1" class="ubot-in" style="width:178px" value="${esc(CONFIG.API_URL_1)}"></div>
                    <div class="ubot-r"><label>端點 2（可留空）</label>
                        <input type="text" id="c-api2" class="ubot-in" style="width:178px" value="${esc(CONFIG.API_URL_2)}"></div>
                    <div class="ubot-r"><label>超時 (ms)</label>
                        <input type="number" id="c-ocrto" class="ubot-in" value="${CONFIG.OCR_TIMEOUT}"></div>
                    <div class="ubot-r"><label>驗證碼長度</label>
                        <input type="number" id="c-caplen" class="ubot-in" value="${CONFIG.CAPTCHA_LENGTH}"></div>
                    <div class="ubot-hint">填入兩個端點時將同時發送，採用最先回應者</div>
                </div>

                <div class="ubot-grp">
                    <div class="ubot-grp-t">節奏與連線</div>
                    <div class="ubot-r"><label>點擊延遲 (ms)</label>
                        <input type="number" id="c-delay" class="ubot-in" value="${CONFIG.CLICK_DELAY}"></div>
                    <div class="ubot-r"><label>隨機抖動 (ms)</label>
                        <input type="number" id="c-jitter" class="ubot-in" value="${CONFIG.JITTER}"></div>
                    <div class="ubot-r"><label>無票刷新 (ms)</label>
                        <input type="number" id="c-wait" class="ubot-in" value="${CONFIG.NO_TICKET_WAIT}"></div>
                    <div class="ubot-r"><label title="其他分頁進入結帳流程時暫停動作">跨分頁互斥</label>
                        <input type="checkbox" id="c-sync" ${CONFIG.SYNC_ENABLED ? 'checked' : ''}></div>
                    <div class="ubot-r"><label title="等待開賣期間定期發送輕量請求以維持連線">連線保溫</label>
                        <input type="checkbox" id="c-keep" ${CONFIG.KEEPALIVE ? 'checked' : ''}></div>
                </div>

                <button id="ubot-save" class="ubot-btn ubot-s">儲存並套用</button>
            </div>`;
        document.body.appendChild(g);

        try {
            document.getElementById('ubot-log').innerHTML =
                JSON.parse(sessionStorage.getItem('ubot_logs') || "[]").join('<br>');
        } catch (e) {}

        const $ = id => document.getElementById(id);
        const draw = () => {
            renderTags('ubot-dates', edDates, 'date');
            renderTags('ubot-excl', edExcl, 'exc');
            renderSortable('ubot-prio', edPrio);
        };
        draw();

        const syncMode = () => {
            const m = $('c-mode').value;
            $('box-prio').style.display = m.indexOf('priority') === 0 ? 'block' : 'none';
            $('box-range').style.display = (m === 'range') ? 'block' : 'none';
        };
        $('c-mode').onchange = syncMode;
        syncMode();

        $('c-add-date').onclick = () => {
            const v = `${$('c-mm').value}/${$('c-dd').value}`;
            if (!edDates.includes(v)) { edDates.push(v); draw(); }
        };
        const adder = (inputId, arr) => () => {
            const v = $(inputId).value.trim();
            if (v && !arr.includes(v)) { arr.push(v); $(inputId).value = ''; draw(); }
        };
        $('c-add-prio').onclick = adder('i-prio', edPrio);
        $('c-add-excl').onclick = adder('i-excl', edExcl);
        $('i-prio').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('c-add-prio').click(); } };
        $('i-excl').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('c-add-excl').click(); } };

        $('ubot-gear').onclick = () => {
            const d = $('ubot-dash'), s = $('ubot-set');
            const showing = d.style.display !== 'none';
            d.style.display = showing ? 'none' : 'block';
            s.style.display = showing ? 'block' : 'none';
        };
        $('ubot-master').onclick = () => { GM_setValue('BOT_ENABLED', !CONFIG.BOT_ENABLED); location.reload(); };

        $('ubot-save').onclick = () => {
            GM_setValue('TICKET_QTY', parseInt($('c-qty').value, 10) || 1);
            GM_setValue('PROMO_CODE', $('c-promo').value.toUpperCase().trim());
            GM_setValue('SESSION_KEYS', edDates.join(','));
            GM_setValue('AREA_MODE', $('c-mode').value);
            GM_setValue('PRIORITY_LIST', edPrio.join(','));
            GM_setValue('EXCLUDE_KEYWORDS', edExcl.join(','));
            GM_setValue('MIN_PRICE', parseInt($('c-min').value, 10) || 0);
            GM_setValue('MAX_PRICE', parseInt($('c-max').value, 10) || 100000);
            GM_setValue('API_URL_1', $('c-api1').value.trim());
            GM_setValue('API_URL_2', $('c-api2').value.trim());
            GM_setValue('OCR_TIMEOUT', parseInt($('c-ocrto').value, 10) || 3000);
            GM_setValue('CAPTCHA_LENGTH', parseInt($('c-caplen').value, 10) || 4);
            GM_setValue('CLICK_DELAY', parseInt($('c-delay').value, 10) || 0);
            GM_setValue('JITTER', parseInt($('c-jitter').value, 10) || 0);
            GM_setValue('NO_TICKET_WAIT', parseInt($('c-wait').value, 10) || 3000);
            GM_setValue('SYNC_ENABLED', $('c-sync').checked);
            GM_setValue('KEEPALIVE', $('c-keep').checked);
            addLog("設定已儲存");
            setTimeout(() => location.reload(), 250);
        };

        // 拖曳面板
        const h = $('ubot-handle');
        let px = 0, py = 0;
        h.onmousedown = (e) => {
            if (e.target.id === 'ubot-gear') return;
            px = e.clientX; py = e.clientY;
            const move = (ev) => {
                const t = Math.min(Math.max(0, g.offsetTop - (py - ev.clientY)), window.innerHeight - 50);
                const l = Math.min(Math.max(0, g.offsetLeft - (px - ev.clientX)), window.innerWidth - 60);
                px = ev.clientX; py = ev.clientY;
                g.style.top = t + 'px'; g.style.left = l + 'px';
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                GM_setValue('GUI_POS', { top: parseInt(g.style.top, 10), left: parseInt(g.style.left, 10) });
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        };

        setInterval(() => {
            const c = document.getElementById('ubot-clock');
            if (c) c.innerText = new Date().toLocaleTimeString('zh-TW', { hour12: false });
        }, 250);
    }

    onReady(createGUI);

    // 錯誤頁自動重整。只比對 title 的完整字樣 ——
    // 拿 "502" 去 includes 整頁文字，正常頁面有這數字也會誤觸。
    onReady(() => {
        const t = document.title || "";
        if (["502 Bad Gateway", "503 Service", "504 Gateway", "Service Unavailable", "Too Many Requests"]
            .some(s => t.includes(s))) {
            addLog("偵測到錯誤頁面，重新整理");
            setTimeout(() => location.reload(), 400 + Math.floor(Math.random() * 400));
        }
    });

    function startKeepAlive() {
        if (!CONFIG.KEEPALIVE) return null;
        return setInterval(() => {
            if (CONFIG.BOT_ENABLED) fetch('/favicon.ico', { method: 'HEAD', cache: 'no-store' }).catch(() => {});
        }, 2500);
    }

    // =========================================================
    // 7. 選區決策
    // =========================================================
    // 同關鍵字/同價位中選剩餘最多的。剩餘未知的 (熱賣中) 排在已知的後面。
    function pickBySeats(list) {
        if (list.length === 0) return [];
        const known = list.filter(z => z.seats !== null);
        if (known.length === 0) return list;
        const top = Math.max(...known.map(z => z.seats));
        return known.filter(z => z.seats === top);
    }

    // zones: [{ el, link, rowText, groupText, matchText, seats, price }]
    // 回傳 { picked, wait }
    function decideZones(zones) {
        const mode = CONFIG.AREA_MODE;

        // 文字模式完全不看價格 —— 群組標題的判定也不依賴價格，
        // 所以「VIP PACKAGE」這種沒有價格的標題一樣能比對。
        if (mode === 'priority_any' || mode === 'priority_wait') {
            const keys = listOf(CONFIG.PRIORITY_LIST);
            if (keys.length === 0) {
                addLog("優先清單未設定，改為不限條件選取");
                return { picked: pickBySeats(zones) };
            }
            for (const key of keys) {
                const k = norm(key);
                const hits = zones.filter(z => z.matchText.includes(k));
                if (hits.length > 0) {
                    const picked = pickBySeats(hits);
                    addLog(`命中「${key}」×${hits.length} → ${picked.slice(0, 2).map(z => z.label).join(' / ')}`);
                    return { picked };
                }
            }
            if (mode === 'priority_wait') {
                addLog(`優先清單 (${keys.length} 項) 無可選票區，持續等待`);
                return { picked: [], wait: true };
            }
            addLog("優先清單無可選票區，改為不限條件選取");
            return { picked: pickBySeats(zones) };
        }

        if (mode === 'any') return { picked: pickBySeats(zones) };

        // 價格模式。抓不到任何票價時不要把全部篩掉然後無限重整
        // (舊版就是這樣：票價其實在群組標題，每區都算 0 元，「價格區間」永遠一個都不符合)。
        const priced = zones.filter(z => z.price !== null);
        if (priced.length === 0) {
            addLog("無法解析票價，改依剩餘數選取");
            return { picked: pickBySeats(zones) };
        }

        if (mode === 'range') {
            // 群組標題可能是區間 ($5800~$9200)，所以用「範圍重疊」判斷而非單點比較
            const hits = priced.filter(z => z.price.max >= CONFIG.MIN_PRICE && z.price.min <= CONFIG.MAX_PRICE);
            addLog(`區間 ${CONFIG.MIN_PRICE}~${CONFIG.MAX_PRICE}：符合 ${hits.length} 個`);
            return { picked: pickBySeats(hits) };
        }
        const top = Math.max(...priced.map(z => z.price.max));
        addLog(`最貴 ${top} 元`);
        return { picked: pickBySeats(priced.filter(z => z.price.max === top)) };
    }

    // =========================================================
    // 8. 頁面路由
    // =========================================================
    const url = location.href;

    // ---------- 場次頁 ----------
    // 實測按鈕文字是「立即訂購」，日期欄是「2027/01/24 (日) 19:30」，
    // 所以目標日期用 MM/DD 子字串比對就對得上。
    if (/\/activity\/(detail|game)\//.test(url)) {
        onReady(() => {
            setStatus("等待開賣");
            const keep = startKeepAlive();
            const BTN = 'a.btn-signup, button.btn-signup, button[data-href], a[href*="/ticket/area/"], .btn-primary';
            const WANT = ['立即', '訂購', '購票', 'BuyNow', 'Buy Now'];

            const timer = setInterval(() => {
                if (!canAct()) return;
                setStatus("掃描場次");

                for (const btn of document.querySelectorAll(BTN)) {
                    if (!WANT.some(w => textOf(btn).includes(w))) continue;

                    // 抓整行，因為日期不在按鈕上
                    const row = btn.closest('tr') || btn.closest('li') || btn.parentElement;
                    const rowText = norm(textOf(row));
                    if (hasExcluded(rowText)) continue;   // 例如整場是身障專場

                    const dates = listOf(CONFIG.SESSION_KEYS);
                    if (dates.length > 0 && !dates.some(d => rowText.includes(norm(d)))) continue;

                    clearInterval(timer);
                    if (keep) clearInterval(keep);
                    addLog(`進入場次 ${rowText.slice(0, 22)}`);

                    // 先 click 讓網站自己的 JS 帶著 token 導頁。
                    // v41 於 click 後又直接指定 location.href，兩者會競爭導頁行為。
                    // 此處改為僅在 click 未生效時，才以 href 作為備援。
                    const href = btn.getAttribute('href') || btn.getAttribute('data-href');
                    const before = location.href;
                    setTimeout(() => {
                        btn.click();
                        if (href && href !== '#' && !href.startsWith('javascript')) {
                            setTimeout(() => { if (location.href === before) location.href = href; }, 400);
                        }
                    }, clickDelay());
                    return;
                }
            }, 50);
        });
    }

    // ---------- 購票碼頁 ----------
    if (url.includes('/ticket/verify')) {
        onReady(() => {
            if (!CONFIG.BOT_ENABLED) return;
            if (!CONFIG.PROMO_CODE) {
                // v41 於此處以 30ms interval 持續輪詢，且永不送出。
                // 未設定購票碼時不應推測輸入內容，改為明確告知使用者。
                setStatus("需要購票碼");
                addLog("此頁需要購票碼，設定為空，請手動處理");
                return;
            }
            let sent = false;
            const timer = setInterval(() => {
                if (!CONFIG.BOT_ENABLED || sent) return;
                const input = document.querySelector('input[name*="checkCode"]')
                    || document.querySelector('form input[type="text"]');
                if (!input) return;
                input.value = CONFIG.PROMO_CODE;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                checkAgreements();
                const btn = document.querySelector('button[type="submit"]') || document.querySelector('form .btn-primary');
                if (btn) {
                    sent = true;
                    clearInterval(timer);
                    addLog("送出購票碼");
                    setTimeout(() => btn.click(), clickDelay());
                }
            }, 50);
            setTimeout(() => clearInterval(timer), 10000);
        });
    }

    // ---------- 票區頁 ----------
    if (url.includes('/ticket/area/')) {
        onReady(() => {
            if (!CONFIG.BOT_ENABLED) { setStatus("已暫停"); return; }
            setStatus("分析票區");

            const t0 = Date.now();
            let done = false;

            // 輪詢而不是 window 'load'。'load' 要等所有圖片載完，尖峰期會慢好幾秒；
            // 而且舊版只判斷一次，票區晚 render 就誤判無票。
            const scan = setInterval(() => {
                if (done || !CONFIG.BOT_ENABLED) { clearInterval(scan); return; }
                if (peerHolding()) return;

                const found = discoverRows();
                if (found.rows.length > 0) {
                    done = true; clearInterval(scan);
                    decide(found);
                } else if (Date.now() - t0 > CONFIG.SCAN_TIMEOUT) {
                    done = true; clearInterval(scan);
                    addLog("未偵測到票區元素");
                    noTicket();
                }
            }, 40);

            function decide(found) {
                addLog(`票區 ${found.rows.length} 個（${found.how}）`);

                const allRows = new Set(found.rows);
                // 先判定可點擊的項目。不可點擊者多為已售完或群組標題，
                // 此為結構性訊號，不依賴任何文字內容。
                const linkMap = new Map();
                found.rows.forEach(el => { const l = linkOf(el); if (l) linkMap.set(el, l); });

                // 全部都不可點時（頁面把 handler 掛在列本身），退為點整列
                if (linkMap.size === 0) {
                    addLog("票區無連結元素，改為點擊整列");
                    found.rows.forEach(el => linkMap.set(el, el));
                }
                const clickableRows = new Set(linkMap.keys());

                // 群組標題的判定不依賴價格 —— 實測有「VIP PACKAGE」這種
                // 完全沒有價格的標題，而它底下的票區叫「全區」，
                // 跟另一個群組的「全區」同名，不把標題納入比對就無法區分。
                let zones = Array.from(clickableRows).map(el => {
                    const groupEl = findGroupEl(el, allRows, clickableRows);
                    const rowText = textOf(el);
                    const groupText = groupEl ? textOf(groupEl) : '';
                    return {
                        el, link: linkMap.get(el),
                        seats: seatsOf(el),
                        price: priceOf(el, groupEl),
                        rowText, groupText,
                        matchText: norm(rowText + ' ' + groupText),
                        label: norm(rowText).slice(0, 12) + (groupText ? `@${norm(groupText).slice(0, 10)}` : '')
                    };
                });

                // 排除關鍵字絕不 fallback。舊版是「安全清單為空就退回全部」，
                // 等同於僅剩身障區時仍會選取，可能購得不符資格之票券。
                // 這裡連群組標題一起看，整個群組是身障專區也擋得住。
                const n0 = zones.length;
                zones = zones.filter(z => !hasExcluded(z.matchText));
                if (zones.length < n0) addLog(`排除 ${n0 - zones.length} 個票區`);

                zones = zones.filter(z => {
                    if (z.seats === 0) return false;                     // 確定售完
                    return z.seats === null || z.seats >= CONFIG.TICKET_QTY;   // 未知放行
                });
                if (zones.length === 0) { noTicket(); return; }

                const { picked, wait } = decideZones(zones);
                if (picked.length === 0) { noTicket(wait); return; }

                const z = picked[Math.floor(Math.random() * picked.length)];
                const pl = !z.price ? '?' : (z.price.min === z.price.max ? z.price.min : `${z.price.min}~${z.price.max}`);
                setStatus(`鎖定 ${pl} / 餘${z.seats === null ? '?' : z.seats}`);
                addLog(`鎖定 ${z.label} (${pl})`);
                z.link.style.outline = '4px solid #ff453a';
                setTimeout(() => { if (CONFIG.BOT_ENABLED) z.link.click(); }, clickDelay());
            }

            function noTicket(isWaiting) {
                if (!CONFIG.BOT_ENABLED) return;
                const secs = Math.round(CONFIG.NO_TICKET_WAIT / 1000);
                if (!isWaiting) addLog(`無符合票區，${secs} 秒後重新整理`);
                let left = secs;
                // 只改狀態列，不去動面板標題 —— 舊版把標題存起來再寫回，
                // 重入時會將「無票...2」等中間狀態存為原始值，導致標題永久失效。
                const tick = setInterval(() => {
                    if (!CONFIG.BOT_ENABLED) { clearInterval(tick); return; }
                    if (--left > 0) setStatus(`等待中 ${left}s`); else clearInterval(tick);
                }, 1000);
                setTimeout(() => { if (CONFIG.BOT_ENABLED) location.reload(); }, CONFIG.NO_TICKET_WAIT);
            }
        });
    }

    // ---------- 選票 / 驗證碼頁 ----------
    if (url.includes('/ticket/ticket/')) {
        onReady(() => {
            if (!CONFIG.BOT_ENABLED) { setStatus("已暫停"); return; }
            claimHold();
            setStatus("選擇張數");

            const qty = CONFIG.TICKET_QTY;
            let qtyDone = false;
            let reason = "尚未掃描";

            // 實測票數選單是 name="TicketForm[ticketPrice][01]"，options 為 "0".."4"。
            // 舊版對全頁每個 <select> 一律寫入張數：有幾個票種即各購買 N 張，
            // 總數超過上限而遭退回；且未檢查對應 option 是否存在，
            // 寫入失敗時值會靜默變為空字串，仍被送出。
            const QTY_SEL = ['select[name*="ticketPrice"]', 'select[id*="ticketPrice"]', 'select[name*="TicketForm"]'];

            function qtySelects() {
                for (const s of QTY_SEL) {
                    const f = Array.from(document.querySelectorAll(s));
                    if (f.length > 0) return f;
                }
                const scope = document.querySelector('form') || document;
                return Array.from(scope.querySelectorAll('select')).filter(s =>
                    s.options.length > 1 && Array.from(s.options).every(o => /^\d*$/.test(String(o.value).trim())));
            }

            // 整批張數放進「單一個」票種，不跨票種分配 ——
            // 跨票種會變成 1 張全票 + 1 張學生票，你不一定符合資格。
            function selectQty() {
                const sels = qtySelects();
                if (sels.length === 0) { reason = "未偵測到票數選單"; return false; }

                let best = null, nExc = 0, nOut = 0;
                for (const sel of sels) {
                    const row = sel.closest('tr') || sel.closest('li') || sel.parentElement;
                    if (hasExcluded(textOf(row))) { nExc++; continue; }

                    // options 只有 ["0"] 代表這票種沒票。實測遇過整頁只剩
                    // 「身障優惠票」「身障陪同票」且兩個都是 ["0"]。
                    const vals = Array.from(sel.options)
                        .map(o => parseInt(String(o.value).trim(), 10))
                        .filter(n => Number.isFinite(n) && n > 0);
                    if (vals.length === 0) { nOut++; continue; }

                    const take = Math.min(Math.max(...vals), qty);
                    if (!best || take > best.take) best = { sel, take };
                    if (take === qty) break;
                }
                if (!best) {
                    reason = `${sels.length} 個票種都不可選（排除 ${nExc} / 無票 ${nOut}）`;
                    return false;
                }

                best.sel.focus();
                best.sel.value = String(best.take);
                best.sel.dispatchEvent(new Event('change', { bubbles: true }));
                best.sel.blur();

                // 設定後立刻讀回驗證，而不是等下一個 tick（舊版固定浪費 100ms）
                if (parseInt(best.sel.value, 10) !== best.take) { reason = "選單設定後回讀值不符"; return false; }
                addLog(best.take < qty ? `僅可選取 ${best.take} 張（目標 ${qty} 張）` : `已選取 ${best.take} 張`);
                return true;
            }

            const qtyTimer = setInterval(() => {
                if (!CONFIG.BOT_ENABLED) { clearInterval(qtyTimer); return; }
                checkAgreements();
                if (selectQty()) { qtyDone = true; clearInterval(qtyTimer); startCaptcha(); }
            }, 60);

            setTimeout(() => {
                if (!qtyDone) {
                    clearInterval(qtyTimer);
                    addLog(`${reason}，重新整理`);
                    if (CONFIG.BOT_ENABLED) location.reload();
                }
            }, CONFIG.SCAN_TIMEOUT + 2000);

            // ----- OCR -----
            // 用「世代編號」而不是單一 boolean。舊版送出後有個寫死的
            // setTimeout(() => isOcrRunning = false, 5000)，與 alert 重試機制共用同一旗標：
            // 舊 timer 到期時可能正處於新一輪 OCR 執行中而提前解鎖，造成重複送出。
            // 現行做法為每個回呼攜帶各自的 gen，過期者一律忽略。
            let gen = 0, busy = false, lastAlert = 0, watchdog = null;
            const IMG = "#TicketForm_verifyCode-image";
            const INPUT = "#TicketForm_verifyCode";

            function startCaptcha() {
                const img = document.querySelector(IMG);
                if (!img || !document.querySelector(INPUT)) {
                    addLog("未偵測到驗證碼元素，重新整理");
                    setTimeout(() => { if (CONFIG.BOT_ENABLED) location.reload(); }, CONFIG.NO_TICKET_WAIT);
                    return;
                }

                // 不採用 MutationObserver 監聽整個 body。舊版監聽 body 全部 attribute 變動，
                // 而本腳本面板亦位於 body 內並持續更新，將反覆觸發自身的 observer，
                // 造成高頻率的無效執行且從未 disconnect。
                // 驗證碼更換必定觸發 img 的 load 事件，監聽該事件即已足夠。
                img.addEventListener('load', () => { if (!busy && CONFIG.BOT_ENABLED) solve(); });

                lastAlert = parseInt(document.documentElement.dataset.botAlertTime || 0, 10);
                setInterval(() => {
                    if (!CONFIG.BOT_ENABLED) return;
                    const t = parseInt(document.documentElement.dataset.botAlertTime || 0, 10);
                    if (t > lastAlert) {
                        lastAlert = t;
                        addLog(`Alert: ${String(document.documentElement.dataset.botAlertMsg || '').slice(0, 24)}`);
                        retry();
                    }
                }, 150);

                solve();
            }

            function ocrOnce(apiUrl, b64) {
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "POST", url: apiUrl,
                        headers: { "Content-Type": "application/json" },
                        data: JSON.stringify({ image: b64 }),
                        timeout: CONFIG.OCR_TIMEOUT,   // 舊版未設 timeout，後端無回應時整體流程將停止且無提示
                        onload: (r) => {
                            let code = null, err = null;
                            try {
                                const d = JSON.parse(r.responseText);
                                // ocr.py 出錯時回的是 HTTP 200 + {"error": ...}，
                                // 舊版的 if (status === 200) 一定成立，然後 d.result 是 undefined，
                                // 就把字串 "undefined" 填進驗證碼送出。
                                if (d && typeof d.result === 'string') code = d.result.trim();
                                else if (d && d.error) err = String(d.error).slice(0, 40);
                            } catch (e) { err = "回應不是 JSON"; }
                            if (!code) return reject(new Error(err || "無結果"));
                            // 長度不符即判定失敗，避免送出必然被拒絕的請求
                            if (code.length !== CONFIG.CAPTCHA_LENGTH) return reject(new Error(`長度 ${code.length}`));
                            resolve(code);
                        },
                        ontimeout: () => reject(new Error("超時")),
                        onerror: () => reject(new Error("連線失敗"))
                    });
                });
            }

            function solve() {
                if (!CONFIG.BOT_ENABLED || busy || !qtyDone) return;
                const img = document.querySelector(IMG);
                const input = document.querySelector(INPUT);
                if (!img || !input || !img.complete || !img.naturalWidth) return;   // load 事件會再叫我們

                busy = true;
                const my = ++gen;
                setStatus("識別驗證碼");

                let b64;
                try {
                    const cv = document.createElement("canvas");
                    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
                    cv.getContext("2d").drawImage(img, 0, 0);
                    b64 = cv.toDataURL("image/png").split(',')[1];
                } catch (e) { addLog("驗證碼圖片擷取失敗"); retry(my); return; }

                const urls = [CONFIG.API_URL_1, CONFIG.API_URL_2].filter(u => u && u.trim());
                if (urls.length === 0) { addLog("未設定 OCR 端點"); busy = false; return; }

                // 兩個端點競速，先回來的算。只填一個時等同一般請求。
                Promise.any(urls.map(u => ocrOnce(u, b64))).then(code => {
                    if (my !== gen) return;
                    addLog(`辨識 ${code}`);
                    input.value = code;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    submit(my);
                }).catch(agg => {
                    if (my !== gen) return;
                    const why = (agg && agg.errors && agg.errors[0]) ? agg.errors[0].message : '未知';
                    addLog(`OCR 失敗（${why}）`);
                    retry(my);
                });
            }

            function submit(my) {
                if (!CONFIG.BOT_ENABLED) { busy = false; return; }
                checkAgreements();
                const btn = document.querySelector('button.btn.btn-primary.btn-green')
                    || document.querySelector('button.btn-primary.btn-green')
                    || document.querySelector('form button[type="submit"]');
                if (!btn) { addLog("未偵測到送出按鈕"); retry(my); return; }

                setStatus("送出中");
                btn.click();

                // 送出後若頁面沒跳轉也沒 alert 就重試。
                // 此機制取代舊版固定 5 秒的解鎖邏輯（該邏輯與 alert 重試機制互相干擾）。
                if (watchdog) clearTimeout(watchdog);
                watchdog = setTimeout(() => {
                    if (my !== gen) return;      // 已被 alert 重試接手
                    addLog("送出後無回應，重試");
                    retry(my);
                }, CONFIG.SUBMIT_WATCHDOG);
            }

            // 換一張驗證碼再試。my 不符代表這是過期的呼叫，忽略。
            function retry(my) {
                if (typeof my === 'number' && my !== gen) return;
                if (!CONFIG.BOT_ENABLED) { busy = false; return; }
                if (watchdog) { clearTimeout(watchdog); watchdog = null; }

                gen++;                 // 讓所有還在飛的舊回呼失效
                busy = false;
                const now = gen;

                const img = document.querySelector(IMG);
                const input = document.querySelector(INPUT);
                if (input) input.value = '';
                if (!img) return;

                setStatus("更換驗證碼");
                img.click();           // 換圖；load 事件會觸發 solve()

                // 圖片沒換（click 沒作用）時的逾時保護
                setTimeout(() => { if (now === gen && !busy && CONFIG.BOT_ENABLED) solve(); }, CONFIG.ERROR_RETRY);
            }
        });
    }
})();
