const scanButton = document.querySelector('#scan');
const results = document.querySelector('#results');
const statusEl = document.querySelector('#status');
const looseEl = document.querySelector('#loose');
// Runs inside the page. Return strings only, never execute page-origin code.
function collectIdentifiers(loose) {
  // Search the entire visible page, regardless of HTML nesting or ISBN labels.
  // meta tags cover common citation metadata not visible in the body.
  const sources = [document.body?.innerText || '', document.body?.textContent || '',
    ...Array.from(document.querySelectorAll('meta[name],meta[property]'))
      .filter(el => /isbn|issn|citation|dc\.identifier/i.test((el.name || '') + ' ' + (el.getAttribute('property') || '')))
      .map(el => el.content || '')];
  const found = new Map();
  function validISBN(v) {
    if (v.length === 10) return [...v].reduce((s,c,i) => s + (10-i)*(c === 'X' ? 10 : Number(c)), 0) % 11 === 0;
    return [...v].reduce((s,c,i) => s + Number(c)*(i%2 ? 3 : 1), 0) % 10 === 0;
  }
  function validISSN(v) {
    return [...v].reduce((s,c,i) => s + (8-i)*(c === 'X' ? 10 : Number(c)), 0) % 11 === 0;
  }
  function add(type, raw) {
    const value = raw.replace(/[\s\-‐‑‒–—]/g, '').toUpperCase();
    if (type === 'ISBN' && !(/^\d{13}$/.test(value) || /^\d{9}[\dX]$/.test(value))) return;
    if (type === 'ISSN' && !/^\d{7}[\dX]$/.test(value)) return;
    if (!(type === 'ISBN' ? validISBN(value) : validISSN(value))) return;
    found.set(type + ':' + value, {type, value});
  }
  for (const text of sources) {
    // Labeled identifiers, even when the label is in a different element.
    for (const m of text.matchAll(/\b(ISBN(?:-1[03])?|ISSN)\s*[:：#]?\s*([0-9X][0-9X\-‐‑‒–— ]{6,24}[0-9X])/gi)) {
      const type = /^ISBN/i.test(m[1]) ? 'ISBN' : 'ISSN';
      add(type, m[2]);
    }
    if (!loose) continue;
    // Match whole number sequences in arbitrary elements, with no label or ancestor requirement.
    // Exclude letters/digits touching either end to reduce false positives.
    const patterns = [
      {type:'ISBN', regex:/(?<![0-9A-Za-z])97[89](?:[\-‐‑‒–— ]?\d){10}(?![0-9A-Za-z])/g},
      {type:'ISBN', regex:/(?<![0-9A-Za-z])\d(?:[\-‐‑‒–— ]?\d){8}(?:[\-‐‑‒–— ]?[\dX])(?![0-9A-Za-z])/gi},
      {type:'ISSN', regex:/(?<![0-9A-Za-z])\d{4}[\-‐‑‒–— ]?\d{3}[\dX](?![0-9A-Za-z])/gi}
    ];
    for (const {type, regex} of patterns) {
      for (const m of text.matchAll(regex)) add(type, m[0]);
    }
  }
  return {identifiers:[...found.values()].slice(0,100), textLength:sources[0].length, fallbackLength:sources[1].length, pageTitle:document.title};
}
function elm(tag, cls, text) { const e=document.createElement(tag); if(cls)e.className=cls; if(text!==undefined)e.textContent=text; return e; }
function link(parent, text, url) {const a=elm('a','',text);a.href=url;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);return a;}
function childrenByLocalName(parent,name){return [...parent.getElementsByTagName('*')].filter(e=>e.localName===name);}
function firstText(parent, name){return childrenByLocalName(parent,name)[0]?.textContent?.trim()||'';}
function ndlSearchUrl(type,code){return `https://ndlsearch.ndl.go.jp/search?cs=bib&from=0&size=20&q=${encodeURIComponent(code)}`;}
function parseEmbeddedXml(text) {
  // SRU recordPacking=string and extraResponseData sometimes carry escaped XML.
  // DOMParser converts &lt; to literal '<' in textContent. Wrap fragments in a root.
  if (!text || !text.includes('<')) return null;
  const parsed = new DOMParser().parseFromString(`<root>${text}</root>`, 'application/xml');
  if (parsed.getElementsByTagName('parsererror').length) return null;
  return parsed;
}
function getFacetDocument(xml) {
  const extra = childrenByLocalName(xml, 'extraResponseData')[0];
  if (!extra) return xml;
  // Ordinary response: facets are actual child elements.
  if (childrenByLocalName(extra, 'lst').length) return extra;
  // NDL response: encoded markup such as &lt;facets&gt; becomes textContent.
  return parseEmbeddedXml(extra.textContent) || extra;
}
function getLibraryFacet(facetsRoot) {
  const lists = childrenByLocalName(facetsRoot, 'lst').filter(n =>
    (n.getAttribute('name') || '').trim().toUpperCase() === 'LIBRARY');
  const names = new Map();
  for (const list of lists) {
    for (const node of list.children) {
      if (node.localName !== 'int') continue;
      const name = node.getAttribute('name')?.trim();
      if (name) names.set(name, (names.get(name) || 0) + (Number(node.textContent) || 0));
    }
  }
  return [...names].map(([name, count]) => ({name, count}));
}
// Fallback for unusual encodings. Never render XML as HTML.
function getLibraryFacetFromRaw(body) {
  const decoded = body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const names = new Map();
  const blocks = [...decoded.matchAll(/<(?:[\w.-]+:)?lst\b[^>]*\bname\s*=\s*["']LIBRARY["'][^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?lst\s*>/gi)];
  for (const [, block] of blocks) {
    for (const match of block.matchAll(/<(?:[\w.-]+:)?int\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?int\s*>/gi)) {
      const name = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
      if (name) names.set(name, (names.get(name) || 0) + Number(match[2]));
    }
  }
  return [...names].map(([name, count]) => ({name, count}));
}
function sruUrl(type, code) {
  const query = `${type.toLowerCase()}=="${code}" `; // Match the user's working SRU query including the trailing space.
  return 'https://ndlsearch.ndl.go.jp/api/sru?' + new URLSearchParams({
    operation: 'searchRetrieve', maximumRecords: '10', query
  }).toString();
}
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'ndlSRUv023:';
const MIN_REQUEST_GAP_MS = 3000; // Gap between individual SRU searches.
const MAX_429_ATTEMPTS = 3; // Initial request + at most two retries.
const RETRY_DELAYS_MS = [5000, 10000]; // 429 without Retry-After: 5s, then 10s.
const MAX_RETRY_WAIT_MS = 30000; // Don't keep a scan open for a long server-directed wait.
const REQUEST_TIMEOUT_MS = 90000; // Long responses have been observed.
let lastRequestAt = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Earlier versions saved a 15-minute local cooldown. Discard it on upgrade.
try { localStorage.removeItem('ndlCooldownUntil'); } catch (_) {}
function retryAfterMs(value) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.max(0, Number(value.trim()) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
function http429Error(reason) {
  const error = new Error(reason);
  error.rateLimited = true;
  return error;
}
async function searchNDL(type, code, report = () => {}) {
  const cacheKey = `${CACHE_PREFIX}${type}:${code}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.expires > Date.now()) {
      report('保存済みの検索結果を表示');
      return {...cached.data, source:'24時間キャッシュ'};
    }
  } catch (_) { try { localStorage.removeItem(cacheKey); } catch (_) {} }
  const elapsedSinceLast = Date.now() - lastRequestAt;
  if (lastRequestAt && elapsedSinceLast < MIN_REQUEST_GAP_MS) {
    report('APIへの連続アクセスを避けるため待機中…');
    await sleep(MIN_REQUEST_GAP_MS - elapsedSinceLast);
  }
  const url = sruUrl(type, code);
  let body;
  let responseInfo = {};
  for (let attempt = 1; attempt <= MAX_429_ATTEMPTS; attempt++) {
    report(`SRU応答待ち…（${attempt}/${MAX_429_ATTEMPTS}回目）`);
    lastRequestAt = Date.now();
    const started = performance.now();
    let response;
    try {
      // No custom headers. Chrome adds its normal fetch headers.
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'follow' });
      responseInfo = {
        finalUrl: response.url, contentType: response.headers.get('Content-Type') || '不明',
        status: response.status, elapsed: ((performance.now()-started)/1000).toFixed(1),
        retryAfter: response.headers.get('Retry-After') || '', attempt
      };
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      if (timedOut) throw Error(`SRU APIが${REQUEST_TIMEOUT_MS / 1000}秒以内に応答しませんでした。`);
      throw error;
    }
    if (response.status === 429) {
      const retryAfter = responseInfo.retryAfter;
      const serverWait = retryAfterMs(retryAfter);
      if (attempt === MAX_429_ATTEMPTS) {
        throw http429Error(`NDL APIからHTTP 429が${attempt}回続いたため停止しました。最後の応答まで${responseInfo.elapsed}秒。${retryAfter ? `Retry-After: ${retryAfter}。` : ''}時間をおいて再度お試しください。`);
      }
      if (serverWait !== null && serverWait > MAX_RETRY_WAIT_MS) {
        throw http429Error(`NDL APIがHTTP 429を返しました。Retry-After: ${retryAfter}（待機約${Math.ceil(serverWait / 1000)}秒）が指定されたため、このスキャンでは再試行しません。`);
      }
      const delay = Math.max(RETRY_DELAYS_MS[attempt - 1], serverWait ?? 0);
      report(`HTTP 429を受信。${Math.ceil(delay/1000)}秒後に再試行します（次回${attempt+1}/${MAX_429_ATTEMPTS}回目）…`);
      await sleep(delay);
      continue;
    }
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    try { body = await response.text(); }
    catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw Error(`SRU APIの応答受信が${REQUEST_TIMEOUT_MS / 1000}秒でタイムアウトしました。`);
      throw error;
    }
    break;
  }
  const xml = new DOMParser().parseFromString(body, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) throw Error('SRU応答XMLの解析に失敗しました');
  const diagnostic = firstText(xml, 'diagnostic');
  if (diagnostic) throw Error('SRU診断: ' + diagnostic.slice(0, 180));
  const count = Number(firstText(xml, 'numberOfRecords')) || 0;
  const records = childrenByLocalName(xml, 'record').map(record => {
    const data = childrenByLocalName(record, 'recordData')[0];
    let title = data && firstText(data, 'title');
    let creator = data && firstText(data, 'creator');
    let publisher = data && firstText(data, 'publisher');
    if (data && !title && /<[^>]+>/.test(data.textContent)) {
      const inner = parseEmbeddedXml(data.textContent);
      if (inner) {
        title = firstText(inner, 'title'); creator = firstText(inner, 'creator'); publisher = firstText(inner, 'publisher');
      }
    }
    return {title:title || 'タイトル不明', creator:creator || '', publisher:publisher || ''};
  });
  const facetDoc = getFacetDocument(xml);
  const facetNames = [...new Set(childrenByLocalName(facetDoc, 'lst').map(n => n.getAttribute('name') || '(無名)'))];
  const parsedLibraries = getLibraryFacet(facetDoc);
  const libraries = parsedLibraries.length ? parsedLibraries : getLibraryFacetFromRaw(body);
  const data = {count, libraries, records, facetNames, responseBytes:body.length, responseInfo, responseXml: libraries.length ? '' : body.slice(0, 12000)};
  // Do not cache a response lacking the LIBRARY facet: it may reflect a different server response.
  if (libraries.length) {try {localStorage.setItem(cacheKey, JSON.stringify({expires:Date.now()+CACHE_TTL_MS, data}));} catch (_) {}}
  return {...data, source:'APIから新規取得'};
}

async function run(){
  scanButton.disabled=true;results.replaceChildren();statusEl.textContent='ページから番号を抽出しています…';
  try{
    const tabs=await chrome.tabs.query({active:true,lastFocusedWindow:true});
    const tab=tabs[0] || (await chrome.tabs.query({active:true,currentWindow:true}))[0];
    if(!tab?.id || !/^https?:/.test(tab.url||''))throw Error('通常のHTTP(S)ページを開いてください。chrome:// やPDFビューアは対象外です。');
    const response=await chrome.scripting.executeScript({target:{tabId:tab.id},func:collectIdentifiers,args:[looseEl.checked]});
    const result=response[0]?.result;
    if(!result)throw Error('ページからスキャン結果を受信できません。');
    const identifiers=result.identifiers;
    const diag=elm('p','muted',`対象: ${tab.title||tab.url} ／ 本文 ${result.textLength}文字（補助 ${result.fallbackLength}文字）`);
    results.append(diag);
    statusEl.textContent=`${identifiers.length} 件の番号を検出${identifiers.length===100?'（上限100件）':''}。照合中…`;
    if(!identifiers.length){results.append(elm('p','muted','ISBN/ISSNを検出できませんでした。番号が画面に表示されているか、ページを再読み込みしてからスキャンしてください。iframe・画像・PDF内の文字は対象外です。'));return;}
    let index=0;
    // Sequential requests prevent a burst of API traffic.
    for(const id of identifiers){
      index++;
      const card=elm('section','item');
      const top=elm('div','top');top.append(elm('strong','number',id.value),elm('span','tag',id.type));card.append(top);
      const links=elm('div','links');link(links,'NDLサーチで検索',ndlSearchUrl(id.type,id.value));link(links,'SRU XMLを直接確認',sruUrl(id.type,id.value));card.append(links);
      results.append(card);statusEl.textContent=`${index}/${identifiers.length} 件を照合中…`;
      try{
        const {count, libraries, records, facetNames=[], responseBytes=0, responseInfo={}, responseXml='', source='取得元不明'}=await searchNDL(id.type,id.value, message => {statusEl.textContent=`${index}/${identifiers.length}件：${id.value} ${message}`;});
        card.append(elm('p','muted',`SRU書誌ヒット：${count}件 ／ ${source}`));
        card.append(elm('p','diagnostic',`HTTP: ${responseInfo.status ?? 'キャッシュ'} ／ 応答時間: ${responseInfo.elapsed ? responseInfo.elapsed+'秒' : '―'} ／ 試行回数: ${responseInfo.attempt || '―'}`));
        if (!count) {
          card.append(elm('p','muted','一致する書誌がありません。'));
          continue;
        }
        for (const record of records) {
          const block=elm('div','record');block.append(elm('div','title',record.title));
          if(record.creator)block.append(elm('div','muted',record.creator));
          if(record.publisher)block.append(elm('div','muted',record.publisher));
          card.append(block);
        }
        if (libraries.length) {
          card.append(elm('h3','library-heading',`所蔵館（SRU集計）：${libraries.length}館`));
          const list=elm('ul','library-list');
          for (const library of libraries) {
            const li=elm('li','',library.name);
            if (count > 1) li.append(elm('span','muted',`（集計 ${library.count}）`));
            list.append(li);
          }
          card.append(list);
        } else {
          card.append(elm('p','muted','拡張機能が取得したXMLにはLIBRARYファセットを確認できませんでした。'));
          card.append(elm('p','muted',`受信文字数: ${responseBytes} ／ 検出ファセット: ${facetNames.join(', ') || 'なし'} ／ HTTP ${responseInfo.status ?? '不明'} ／ 応答時間: ${responseInfo.elapsed ?? '不明'}秒 ／ Content-Type: ${responseInfo.contentType || '不明'}`));
          const details = elm('details','');
          details.append(elm('summary','', '受信したXMLを表示（診断用）'));
          const pre=elm('pre','raw-xml',responseXml || 'XML本文を取得できませんでした');
          details.append(pre);
          const copy=elm('button','', '診断用XMLをコピー');
          copy.type='button';
          copy.addEventListener('click', async () => {try {await navigator.clipboard.writeText(`URL: ${responseInfo.finalUrl || sruUrl(id.type,id.value)}\nStatus: ${responseInfo.status || '不明'}\nContent-Type: ${responseInfo.contentType || '不明'}\n\n${responseXml}`); copy.textContent='コピーしました';} catch(e){copy.textContent='コピーに失敗しました';}});
          details.append(copy); card.append(details);
          card.append(elm('p','muted','直接確認リンクのXMLと、この診断用XMLの内容を比較してください。')); 
        }
        if(count>1)card.append(elm('p','muted','※所蔵館は検索ヒット全体の集計です。個別書誌ごとの所蔵館を示すものではありません。'));
      }catch(error){
        card.append(elm('p','error','API照合失敗: '+error.message));
        if (error.rateLimited) { statusEl.textContent='HTTP 429が続いたため、これ以降のISBN・ISSN検索を停止しました。'; break; }
      }
    }
    if (!results.querySelector('.error')) statusEl.textContent=`完了：${identifiers.length} 件の番号を検出しました。`;
  }catch(error){statusEl.textContent='読み取り失敗：'+error.message;results.append(elm('p','error','Chromeの拡張機能管理画面でサイトへのアクセスを許可し、ページを再読み込みしてお試しください。'));}
  finally{scanButton.disabled=false;}
}
scanButton.addEventListener('click',run);
// API requests begin only when the user clicks the scan button.
statusEl.textContent='「このページをスキャン」を押すと検索します。';
