const elements = {
  scanButton: document.getElementById('scan-button'),
  limit: document.getElementById('limit'),
  sort: document.getElementById('sort'),
  engagementUnit: document.getElementById('engagement-unit'),
  excludeShorts: document.getElementById('exclude-shorts'),
  selectAll: document.getElementById('select-all'),
  selectNone: document.getElementById('select-none'),
  copySelected: document.getElementById('copy-selected'),
  downloadTxt: document.getElementById('download-txt'),
  downloadCsv: document.getElementById('download-csv'),
  status: document.getElementById('status'),
  list: document.getElementById('result-list'),
  stats: document.getElementById('result-stats'),
  template: document.getElementById('result-item-template'),
};

let state = {
  source: null,
  items: [],
  engagementUnit: 'minute',
};

async function withCurrentTab(fn) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('アクティブなタブが見つかりません');
  return fn(tab);
}

function setStatus(text) {
  elements.status.textContent = text;
}

function parseNumber(text) {
  if (!text) return 0;
  const normalized = text.replace(/,/g, '').trim();
  const num = Number(normalized);
  if (!Number.isNaN(num)) return num;
  return 0;
}

function dedupe(items) {
  const map = new Map();
  items.forEach((item) => {
    const key = item.url.split('#')[0];
    if (!map.has(key)) {
      map.set(key, item);
    }
  });
  return Array.from(map.values());
}

function formatNumber(num) {
  if (num == null || Number.isNaN(num)) return '';
  return num.toLocaleString();
}

function computeEngagementValue(item, unit) {
  const count = item.source === 'note' ? item.like_count : item.view_count;
  if (!count || !item.elapsed_minutes) return '';
  const minutes = item.elapsed_minutes;
  const divisor = unit === 'day' ? minutes / 1440 : unit === 'hour' ? minutes / 60 : minutes;
  if (!divisor || divisor <= 0) return '';
  return +(count / divisor).toFixed(2);
}

function sortItems(items, sortBy, unit) {
  const sorted = [...items];
  const getPublishTime = (item) => (item.publish_datetime_iso ? Date.parse(item.publish_datetime_iso) : 0);
  const getCount = (item) => (item.source === 'note' ? item.like_count || 0 : item.view_count || 0);

  sorted.sort((a, b) => {
    if (sortBy === 'publish') {
      return getPublishTime(b) - getPublishTime(a);
    }
    if (sortBy === 'count') {
      return getCount(b) - getCount(a);
    }
    if (sortBy === 'order') {
      return (a.order ?? 0) - (b.order ?? 0);
    }
    const engagementA = computeEngagementValue(a, unit) || 0;
    const engagementB = computeEngagementValue(b, unit) || 0;
    if (engagementA === engagementB) {
      return getPublishTime(b) - getPublishTime(a);
    }
    return engagementB - engagementA;
  });
  return sorted;
}

function render(items) {
  const sorted = sortItems(items, elements.sort.value, state.engagementUnit);
  elements.list.innerHTML = '';

  sorted.forEach((item) => {
    const node = elements.template.content.firstElementChild.cloneNode(true);
    const checkbox = node.querySelector('.item-select');
    const titleEl = node.querySelector('.item-title');
    const urlEl = node.querySelector('.item-url');
    const metaEl = node.querySelector('.item-details');
    const sourceBadge = node.querySelector('.badge.source');
    const paidBadge = node.querySelector('.badge.paid');

    checkbox.dataset.url = item.url;
    checkbox.checked = item.selected ?? true;

    titleEl.textContent = item.title || '(タイトルなし)';
    urlEl.textContent = item.url;

    sourceBadge.textContent = item.source;
    paidBadge.hidden = !item.is_paid;

    const parts = [];
    if (item.like_count != null) parts.push(`❤️ ${formatNumber(item.like_count)}`);
    if (item.view_count != null) parts.push(`👁️ ${formatNumber(item.view_count)}`);
    if (item.channel_name) parts.push(`📺 ${item.channel_name}`);
    if (item.publish_datetime_raw) parts.push(`📅 ${item.publish_datetime_raw}`);

    const engagementValue = computeEngagementValue(item, state.engagementUnit);
    if (engagementValue) {
      const approx = item.engagement_time_is_approx ? '~' : '';
      parts.push(`⚡ ${approx}${engagementValue} / ${state.engagementUnit}`);
    }

    metaEl.textContent = parts.join(' ・ ');

    checkbox.addEventListener('change', () => {
      item.selected = checkbox.checked;
    });

    elements.list.appendChild(node);
  });

  const selectedCount = sorted.filter((i) => i.selected ?? true).length;
  elements.stats.textContent = `${sorted.length} 件（選択 ${selectedCount} 件）`;
}

async function injectScanner(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scan.js'] });
}

async function runScan() {
  setStatus('スキャン中...');
  elements.scanButton.disabled = true;

  try {
    const limit = parseNumber(elements.limit.value) || 50;
    const excludeShorts = elements.excludeShorts.checked;
    state.engagementUnit = elements.engagementUnit.value;

    await withCurrentTab(async (tab) => {
      await injectScanner(tab.id);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (settings) => {
          return window.__urlExtractorScan(settings);
        },
        args: [{ limit, excludeShorts }],
      });

      if (!result?.result?.items) {
        throw new Error('対象ページでスキャンできませんでした。');
      }

      if (result.result.source === 'unsupported') {
        throw new Error('このページではスキャンできません。note.com または YouTube で実行してください');
      }

      const items = dedupe(result.result.items).map((item) => ({
        ...item,
        selected: true,
      }));

      state = {
        source: result.result.source,
        items,
        engagementUnit: state.engagementUnit,
      };

      setStatus(`${result.result.source} をスキャンしました (${items.length} 件)`);
      render(items);
    });
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'スキャンに失敗しました');
    elements.list.innerHTML = '';
    elements.stats.textContent = '0 件';
  } finally {
    elements.scanButton.disabled = false;
  }
}

function getSelectedItems() {
  return state.items.filter((item) => item.selected !== false);
}

function copySelected() {
  const urls = getSelectedItems().map((item) => item.url);
  if (!urls.length) return;
  navigator.clipboard.writeText(urls.join('\n'));
  setStatus(`${urls.length} 件コピーしました`);
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadTxt() {
  const urls = getSelectedItems().map((item) => item.url).join('\n');
  download('urls.txt', urls, 'text/plain');
}

function downloadCsv() {
  const header = [
    'source',
    'url',
    'title',
    'channel_name',
    'like_count',
    'view_count',
    'publish_datetime_raw',
    'publish_datetime_iso',
    'engagement_unit',
    'engagement_value',
    'engagement_time_is_approx',
  ];

  const rows = getSelectedItems().map((item) => {
    const engagementValue = computeEngagementValue(item, state.engagementUnit);
    return [
      item.source || '',
      item.url || '',
      item.title || '',
      item.channel_name || '',
      item.like_count ?? '',
      item.view_count ?? '',
      item.publish_datetime_raw || '',
      item.publish_datetime_iso || '',
      state.engagementUnit,
      engagementValue === '' ? '' : engagementValue,
      item.engagement_time_is_approx ?? '',
    ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',');
  });

  download('urls.csv', [header.join(','), ...rows].join('\n'), 'text/csv');
}

function wireEvents() {
  elements.scanButton.addEventListener('click', runScan);
  elements.limit.addEventListener('change', runScan);
  elements.excludeShorts.addEventListener('change', runScan);
  elements.sort.addEventListener('change', () => render(state.items));
  elements.engagementUnit.addEventListener('change', () => {
    state.engagementUnit = elements.engagementUnit.value;
    render(state.items);
  });
  elements.selectAll.addEventListener('click', () => {
    state.items.forEach((item) => { item.selected = true; });
    render(state.items);
  });
  elements.selectNone.addEventListener('click', () => {
    state.items.forEach((item) => { item.selected = false; });
    render(state.items);
  });
  elements.copySelected.addEventListener('click', copySelected);
  elements.downloadTxt.addEventListener('click', downloadTxt);
  elements.downloadCsv.addEventListener('click', downloadCsv);
}

function init() {
  wireEvents();
  runScan();
}

document.addEventListener('DOMContentLoaded', init);
