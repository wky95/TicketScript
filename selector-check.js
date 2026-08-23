// ==UserScript==
// @name         拓元頁面結構檢測
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  於實際頁面檢測腳本所用 CSS selector 是否相符。唯讀操作，不會修改頁面或觸發點擊。
// @author       -
// @match        https://tixcraft.com/*
// @match        https://*.tixcraft.com/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // 本腳本僅執行 querySelectorAll 與文字讀取，不會點擊、送出或修改頁面內容。
    // 用途：確認腳本所用 selector 與拓元現行 HTML 是否相符。

    const CHECKS = {
        '場次頁 /activity/': [
            'a.btn-signup',
            'button.btn-signup',
            '.btn-primary',
            'button[onclick^="join"]',
            'button[data-href]',
            'div.game-list-item',
            '#gameList tr',
            'table tr',
        ],
        '購票碼頁 /ticket/verify/': [
            'input[name^="checkCode"]',
            'button[type="submit"].btn-primary',
        ],
        '票區頁 /ticket/area/': [
            'li.select_form_b',
            'tr.select_form_b',
            '.area-list > li',
            '.zone-area-list > div',
            '#zoneList li',
            'font[color="#FF0000"]',
            'font[color="red"]',
        ],
        '選票頁 /ticket/ticket/': [
            '#TicketForm_verifyCode-image',
            '#TicketForm_verifyCode',
            'input[name^="verify"]',
            'select[name*="ticketPrice"]',
            'select[id*="ticketPrice"]',
            'select[name*="TicketForm"]',
            'button.btn.btn-primary.btn-green',
            'button.btn-primary.btn-green',
            '#submitQty',
            '#submitButton',
            'form button[type="submit"]',
        ],
    };

    function snippet(el, n) {
        n = n || 60;
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return t.length > n ? t.slice(0, n) + '…' : t;
    }

    function describe(el) {
        let d = el.tagName.toLowerCase();
        if (el.id) d += '#' + el.id;
        if (el.className && typeof el.className === 'string') {
            d += '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.');
        }
        if (el.name) d += ' [name=' + el.name + ']';
        return d;
    }

    const lines = [];
    const P = (s) => lines.push(s);

    P('===== 拓元頁面結構檢測報告 =====');
    P('URL   : ' + location.href.replace(/\?.*$/, ''));
    P('TITLE : ' + document.title);
    P('TIME  : ' + new Date().toISOString());
    P('');

    for (const group in CHECKS) {
        P('## ' + group);
        CHECKS[group].forEach(sel => {
            let found;
            try { found = document.querySelectorAll(sel); }
            catch (e) { P('  [selector 語法錯誤] ' + sel); return; }
            const mark = found.length > 0 ? '✅' : '❌';
            P('  ' + mark + ' ' + found.length + '  ' + sel);
            if (found.length > 0) {
                P('        → ' + describe(found[0]) + ' | "' + snippet(found[0]) + '"');
            }
        });
        P('');
    }

    // 票數選單清查。腳本會對 select 寫入張數，若誤選到無關的 select 將導致張數錯誤。
    P('## 全頁 <select> 清查 (共 ' + document.querySelectorAll('select').length + ' 個)');
    document.querySelectorAll('select').forEach((s, i) => {
        const opts = Array.from(s.options).map(o => String(o.value).trim());
        const row = s.closest('tr') || s.closest('li') || s.parentElement;
        P('  [' + i + '] ' + describe(s));
        P('        options(' + opts.length + '): ' + JSON.stringify(opts.slice(0, 12)) + (opts.length > 12 ? ' …' : ''));
        P('        目前值: "' + s.value + '"');
        P('        所在列文字: "' + (row ? snippet(row, 90) : '(無)') + '"');
    });
    P('');

    P('## 表單內 checkbox (共 ' + document.querySelectorAll('form input[type="checkbox"]').length + ' 個)');
    document.querySelectorAll('form input[type="checkbox"]').forEach((c, i) => {
        P('  [' + i + '] ' + describe(c) + ' checked=' + c.checked);
    });
    P('');

    // 票價與剩餘數的文字格式，用於驗證價格與剩餘數解析的正則是否正確
    P('## 頁面上的票價與剩餘數字樣 (前 15 筆)');
    const bodyTxt = (document.body.innerText || '');
    const priceHits = bodyTxt.match(/(?:NT\$|NTD|\$|＄)\s*[\d,]+|[\d,]+\s*元/g) || [];
    const seatHits  = bodyTxt.match(/剩餘\s*\d+|已?售完|完售|\d+\s*seats?/gi) || [];
    P('  票價字樣: ' + JSON.stringify([...new Set(priceHits)].slice(0, 15)));
    P('  剩餘字樣: ' + JSON.stringify([...new Set(seatHits)].slice(0, 15)));
    P('');
    // ===== 結構推導：不依賴 class 名稱，改由文字內容反查 DOM =====
    // 票區頁各活動的字樣不一致，因此改以「含狀態字樣的元素」推導容器結構。
    function minimalMatches(re, limit) {
        const all = Array.from(document.querySelectorAll('li, tr, div, a, span, p'));
        const hit = all.filter(el => re.test(el.textContent || ''));
        // 只留最小單位：子元素不再單獨符合的那一層
        const leaves = hit.filter(el => !Array.from(el.children).some(c => re.test(c.textContent || '')));
        return leaves.slice(0, limit || 8);
    }

    function outline(el, depth) {
        const chain = [];
        let n = el;
        for (let i = 0; i < (depth || 4) && n && n.tagName !== 'BODY'; i++) {
            chain.unshift(describe(n));
            n = n.parentElement;
        }
        return chain.join(' > ');
    }

    const STATUS_RE = /剩餘\s*\d+|已?售完|完售|熱賣中|熱賣|搶購/;
    const PRICE_RE  = /(?:NT\$|\$|＄)\s*[\d,]+|[\d,]+\s*元/;

    const statusRows = minimalMatches(STATUS_RE, 8);
    P('## 含「狀態字樣」的最小元素 （票區列候選） — 共 ' + statusRows.length + ' 筆樣本');
    if (statusRows.length === 0) P('  （此頁無狀態字樣，可能非票區頁）');
    statusRows.forEach((el, i) => {
        const a = el.querySelector('a') || (el.tagName === 'A' ? el : null);
        P('  [' + i + '] ' + outline(el));
        P('        文字  : "' + snippet(el, 70) + '"');
        P('        有連結: ' + (a ? 'YES → ' + describe(a) + ' href=' + (a.getAttribute('href') || '(無)') : 'NO'));
        P('        display: ' + (el.style.display || '(未設)') + '  可見: ' + (el.offsetParent !== null));
        P('        HTML  : ' + (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 260));
    });
    P('');

    const priceRows = minimalMatches(PRICE_RE, 6);
    P('## 含「票價字樣」的最小元素 （群組標題候選） — 共 ' + priceRows.length + ' 筆樣本');
    if (priceRows.length === 0) P('  （未偵測到 $ 或「元」字樣）');
    priceRows.forEach((el, i) => {
        P('  [' + i + '] ' + outline(el));
        P('        文字: "' + snippet(el, 70) + '"');
        P('        HTML: ' + (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 200));
    });
    P('');

    // 已售完與可購買項目的結構差異，用於判定能否不依賴文字進行辨識
    P('## 售完列 vs 有票列 的結構差異');
    const soldOut  = minimalMatches(/已?售完|完售/, 3);
    const onSale   = minimalMatches(/剩餘\s*\d+|熱賣中/, 3);
    P('  已售完樣本 class : ' + JSON.stringify(soldOut.map(e => e.className || '(無)')));
    P('  已售完樣本 有連結: ' + JSON.stringify(soldOut.map(e => !!e.querySelector('a'))));
    P('  可購買樣本 class : ' + JSON.stringify(onSale.map(e => e.className || '(無)')));
    P('  可購買樣本 有連結: ' + JSON.stringify(onSale.map(e => !!e.querySelector('a'))));
    P('');

    P('===== 報告結束 =====');

    const report = lines.join('\n');
    console.log(report);

    GM_addStyle(`
        #sel-check { position: fixed; top: 10px; left: 10px; width: 520px; z-index: 2147483647;
            background: #111; color: #0f0; border: 2px solid #0f0; border-radius: 8px; padding: 8px;
            font-family: monospace; font-size: 11px; box-shadow: 0 0 20px rgba(0,0,0,.8); }
        #sel-check textarea { width: 100%; height: 320px; background: #000; color: #9f9;
            border: 1px solid #333; font-family: monospace; font-size: 10px; resize: vertical; }
        #sel-check button { margin-top: 6px; padding: 6px 10px; cursor: pointer;
            background: #060; color: #fff; border: none; border-radius: 4px; margin-right: 6px; }
    `);

    const box = document.createElement('div');
    box.id = 'sel-check';
    box.innerHTML = '<div style="margin-bottom:6px;font-weight:bold">頁面結構檢測報告（唯讀，不會修改頁面）</div>'
        + '<textarea id="sel-check-txt" readonly></textarea>'
        + '<button id="sel-check-copy">📋 複製全部</button>'
        + '<button id="sel-check-close">✕ 關閉</button>';
    document.body.appendChild(box);
    document.getElementById('sel-check-txt').value = report;
    document.getElementById('sel-check-copy').onclick = () => {
        const ta = document.getElementById('sel-check-txt');
        ta.removeAttribute('readonly'); ta.select();
        document.execCommand('copy');
        ta.setAttribute('readonly', 'readonly');
        document.getElementById('sel-check-copy').innerText = '✅ 已複製';
    };
    document.getElementById('sel-check-close').onclick = () => box.remove();
})();
