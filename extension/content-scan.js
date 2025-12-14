(() => {
  function normalizeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      parsed.hash = '';
      return parsed.toString();
    } catch (error) {
      return url;
    }
  }

  function parseNumberFromText(text) {
    if (!text) return null;
    const normalized = text
      .replace(/,/g, '')
      .replace(/視聴|回|いいね|スキ|likes?|Views?/gi, '')
      .trim();

    const units = [
      { symbol: '億', multiplier: 100000000 },
      { symbol: '万', multiplier: 10000 },
      { symbol: 'k', multiplier: 1000 },
      { symbol: 'K', multiplier: 1000 },
      { symbol: 'm', multiplier: 1000000 },
      { symbol: 'M', multiplier: 1000000 },
      { symbol: 'b', multiplier: 1000000000 },
      { symbol: 'B', multiplier: 1000000000 },
    ];

    for (const unit of units) {
      if (normalized.includes(unit.symbol)) {
        const base = parseFloat(normalized.replace(unit.symbol, ''));
        return Number.isNaN(base) ? null : Math.round(base * unit.multiplier);
      }
    }

    const num = parseFloat(normalized.replace(/[^0-9.\-]/g, ''));
    return Number.isNaN(num) ? null : Math.round(num);
  }

  function parsePublishDate(text) {
    if (!text) return { raw: '', iso: '', minutes: null, approx: false };
    const raw = text.trim();

    const absolute = Date.parse(raw);
    if (!Number.isNaN(absolute)) {
      const iso = new Date(absolute).toISOString();
      const minutes = Math.max(1, Math.floor((Date.now() - absolute) / 60000));
      return { raw, iso, minutes, approx: false };
    }

    const patterns = [
      { regex: /(\d+)\s*分钟前/, multiplier: 1 },
      { regex: /(\d+)\s*min\.?\s*ago/i, multiplier: 1 },
      { regex: /(\d+)\s*時間前/, multiplier: 60 },
      { regex: /(\d+)\s*h(?:ours?)?\s*ago/i, multiplier: 60 },
      { regex: /(\d+)\s*日前/, multiplier: 1440 },
      { regex: /(\d+)\s*d(?:ays?)?\s*ago/i, multiplier: 1440 },
      { regex: /(\d+)\s*週間前/, multiplier: 10080 },
      { regex: /(\d+)\s*w(?:eeks?)?\s*ago/i, multiplier: 10080 },
      { regex: /(\d+)\s*(?:か月|ヶ月|月)前/, multiplier: 43200, approx: true },
      { regex: /(\d+)\s*m(?:onths?)?\s*ago/i, multiplier: 43200, approx: true },
      { regex: /(\d+)\s*年前/, multiplier: 525600, approx: true },
      { regex: /(\d+)\s*y(?:ears?)?\s*ago/i, multiplier: 525600, approx: true },
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern.regex);
      if (match) {
        const value = Number(match[1]);
        if (!Number.isNaN(value)) {
          const minutes = value * pattern.multiplier;
          const approx = Boolean(pattern.approx);
          const iso = new Date(Date.now() - minutes * 60000).toISOString();
          return { raw, iso, minutes, approx };
        }
      }
    }

    return { raw, iso: '', minutes: null, approx: false };
  }

  function scanNote(limit) {
    const results = [];
    const cards = document.querySelectorAll('a[href*="note.com/"]');
    let order = 0;

    for (const anchor of cards) {
      const href = anchor.getAttribute('href');
      if (!href || (!href.includes('/n/') && !href.includes('/note/'))) continue;

      const url = normalizeUrl(href.startsWith('http') ? href : `https://note.com${href}`);
      const container = anchor.closest('article, section, li, div') || anchor.parentElement;
      const title = (anchor.getAttribute('title') || anchor.textContent || '').trim();
      if (!title) continue;

      const priceText = container ? container.textContent : '';
      const isPaid = /¥\s*\d|有料/.test(priceText);
      if (isPaid) continue;

      let likeCount = null;
      const likeCandidate = container?.querySelectorAll('span, div, p') || [];
      for (const el of likeCandidate) {
        if (/スキ|いいね|likes?/i.test(el.textContent || '')) {
          likeCount = parseNumberFromText(el.textContent);
          if (likeCount != null) break;
        }
      }

      let publishText = '';
      const timeEl = container?.querySelector('time');
      if (timeEl) {
        publishText = timeEl.getAttribute('datetime') || timeEl.textContent || '';
      }
      if (!publishText) {
        const meta = container?.querySelector('[class*="date"], [class*="time"], [data-publish]');
        publishText = meta?.textContent || '';
      }

      const publish = parsePublishDate(publishText || '');

      results.push({
        source: 'note',
        url,
        title,
        channel_name: '',
        like_count: likeCount,
        view_count: null,
        publish_datetime_raw: publish.raw,
        publish_datetime_iso: publish.iso,
        elapsed_minutes: publish.minutes,
        engagement_time_is_approx: publish.minutes == null ? '' : publish.approx ? 'true' : 'false',
        is_paid: isPaid,
        order: order++,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  function isShortVideo(node, url) {
    if (url.includes('/shorts/')) return true;
    const badge = node.querySelector('ytd-thumbnail-overlay-time-status-renderer');
    const badgeText = badge?.textContent?.trim().toLowerCase();
    if (badgeText && badgeText.includes('shorts')) return true;
    const overlay = node.querySelector('ytd-thumbnail-overlay-now-playing-renderer');
    const overlayText = overlay?.textContent?.trim().toLowerCase();
    return overlayText?.includes('shorts');
  }

  function scanYouTube(limit, excludeShorts) {
    const results = [];
    const selectors = ['ytd-video-renderer', 'ytd-rich-item-renderer', 'ytd-grid-video-renderer'];
    let order = 0;

    const nodes = document.querySelectorAll(selectors.join(','));
    for (const node of nodes) {
      const titleAnchor = node.querySelector('a#video-title, a#video-title-link');
      if (!titleAnchor) continue;
      const href = titleAnchor.getAttribute('href');
      if (!href) continue;
      const url = normalizeUrl(href.startsWith('http') ? href : `https://www.youtube.com${href}`);

      if (excludeShorts && isShortVideo(node, url)) continue;

      const title = (titleAnchor.textContent || '').trim();
      if (!title) continue;

      const channelName = (node.querySelector('#channel-name, #text-container')?.textContent || '').trim();
      const metadataSpans = node.querySelectorAll('#metadata-line span');
      let viewCount = null;
      let publishText = '';

      if (metadataSpans.length >= 1) {
        viewCount = parseNumberFromText(metadataSpans[0].textContent);
      }
      if (metadataSpans.length >= 2) {
        publishText = metadataSpans[1].textContent || '';
      }

      if (!publishText) {
        const altMeta = node.querySelector('span.inline-metadata-item:last-child');
        publishText = altMeta?.textContent || '';
      }

      const publish = parsePublishDate(publishText);

      results.push({
        source: 'youtube',
        url,
        title,
        channel_name: channelName,
        like_count: null,
        view_count: viewCount,
        publish_datetime_raw: publish.raw,
        publish_datetime_iso: publish.iso,
        elapsed_minutes: publish.minutes,
        engagement_time_is_approx: publish.minutes == null ? '' : publish.approx ? 'true' : 'false',
        is_paid: false,
        order: order++,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  function detectSource() {
    if (location.hostname.includes('note.com')) return 'note';
    if (location.hostname.includes('youtube.com')) return 'youtube';
    return 'unknown';
  }

  window.__urlExtractorScan = (settings = {}) => {
    const limit = settings.limit || 50;
    const excludeShorts = settings.excludeShorts !== false;
    const source = detectSource();

    if (source === 'note') {
      return { source, items: scanNote(limit) };
    }
    if (source === 'youtube') {
      return { source, items: scanYouTube(limit, excludeShorts) };
    }
    return { source: 'unsupported', items: [] };
  };
})();
