import { Injectable } from '@nestjs/common';
import { assertPublicUrl } from '../../common/net-guard';

// Image fetching service — retrieves product images from the internet and converts to base64 data-URLs
// for storage in the item_images table. Supports multiple image sources with fallbacks.
@Injectable()
export class ImageFetchService {
  // Convert image URL to base64 data URL
  async urlToDataUrl(imageUrl: string): Promise<string> {
    try {
      // SSRF defense-in-depth (security review L-6): the URL here is derived from Wikimedia's imageinfo
      // response (an external source), so re-resolve it and refuse internal / cloud-metadata / RFC1918 /
      // loopback destinations before fetching. `allowHttp: false` — image URLs are https. A blocked or
      // malformed URL throws, is caught below, and the item falls back to the local placeholder.
      await assertPublicUrl(imageUrl, { allowHttp: false });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InvisibleERP/1.0)' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      return `data:${contentType};base64,${base64}`;
    } catch (error) {
      console.error(`Failed to fetch image from ${imageUrl}:`, error);
      return '';
    }
  }

  // Thai product/ingredient terms → English search terms. Thai text has no spaces between
  // compound words (e.g. "ซอสสไปซีมิโสะ" is one unbroken string), so this is matched by
  // substring scan (longest-first, non-overlapping), not word-splitting.
  private readonly thaiTerms: ReadonlyArray<readonly [string, string]> = [
    // Electronics / office (checked first since some are longer compounds)
    ['แล็ปท็อป', 'laptop'],
    ['แล็บท็อป', 'laptop'],
    ['คอมพิวเตอร์', 'computer'],
    ['จอภาพ', 'monitor'],
    ['คีย์บอร์ด', 'keyboard'],
    ['เมาส์', 'mouse'],
    ['โต๊ะ', 'desk'],
    ['เก้าอี้', 'chair'],
    ['ตู้', 'cabinet'],
    ['กระเป๋า', 'bag'],
    ['กล่อง', 'box'],
    ['ถุง', 'bag'],
    ['ร่ม', 'umbrella'],
    ['กระดาษ', 'paper'],
    ['ปากกา', 'pen'],
    ['ดินสอ', 'pencil'],
    // Sauces / condiments (food & kitchen catalog)
    ['สไปซีมิโสะ', 'spicy miso'],
    ['มิโสะ', 'miso'],
    ['สไปซี', 'spicy'],
    ['โซยุ', 'soy sauce'],
    ['ซีอิ๊ว', 'soy sauce'],
    ['น้ำปลา', 'fish sauce'],
    ['น้ำส้มสายชู', 'vinegar'],
    ['ซอส', 'sauce'],
    ['พริกไทย', 'pepper'],
    ['พริก', 'chili'],
    ['กระเทียม', 'garlic'],
    ['หอมแดง', 'shallot'],
    ['น้ำมันหอย', 'oyster sauce'],
    ['น้ำมันงา', 'sesame oil'],
    ['น้ำมัน', 'oil'],
    ['น้ำตาล', 'sugar'],
    ['เกลือ', 'salt'],
    ['แป้ง', 'flour'],
    ['ข้าว', 'rice'],
    ['เส้น', 'noodles'],
    ['ไข่', 'egg'],
    ['นม', 'milk'],
    ['เนย', 'butter'],
    ['ผัก', 'vegetable'],
    ['ผลไม้', 'fruit'],
    ['เนื้อ', 'meat'],
    ['หมู', 'pork'],
    ['ไก่', 'chicken'],
    ['กุ้ง', 'shrimp'],
    ['ปลา', 'fish'],
  ];

  // Greedy longest-match, non-overlapping scan over Thai compound text — collects up to 3
  // translated terms so a multi-part product name (e.g. ซอสสไปซีมิโสะ) yields a compound
  // search query ("spicy miso sauce") instead of failing to match at all.
  private translateThai(description: string): string {
    const matched: string[] = [];
    const consumed = new Array(description.length).fill(false);

    for (const [thai, english] of [...this.thaiTerms].sort((a, b) => b[0].length - a[0].length)) {
      let searchFrom = 0;
      let idx: number;
      while ((idx = description.indexOf(thai, searchFrom)) !== -1 && matched.length < 3) {
        const overlaps = consumed.slice(idx, idx + thai.length).some(Boolean);
        if (!overlaps) {
          matched.push(english);
          for (let i = idx; i < idx + thai.length; i++) consumed[i] = true;
        }
        searchFrom = idx + thai.length;
      }
      if (matched.length >= 3) break;
    }

    return matched.join(' ');
  }

  private extractSearchTerms(description: string): string {
    if (!description?.trim()) return '';

    const trimmed = description.trim();
    // Check if it's Thai text
    const thaiPattern = /[฀-๿]/;
    if (thaiPattern.test(trimmed)) {
      const translated = this.translateThai(trimmed);
      if (translated) return translated;
      // No known term matched — do NOT fall back to the raw Thai word: Wikimedia Commons has
      // almost no Thai-tagged content, so a raw-Thai search reliably returns an unrelated
      // "closest text match" result rather than no result. Signal "no good search term" so the
      // caller skips straight to the local placeholder instead of an actively misleading photo.
      return '';
    }

    // For English, filter out generic/stopwords and use meaningful terms
    const stopwords = new Set(['a', 'an', 'the', 'and', 'or', 'is', 'in', 'for', 'of', 'to', 'with', 'by', 'on']);
    const words = trimmed.split(/[\s,]+/)
      .filter(w => w.length > 2 && !stopwords.has(w.toLowerCase()));

    if (words.length > 0) {
      return words.slice(0, 3).join('+');
    }
    // Fallback to first word if filtered list is empty
    const allWords = trimmed.split(/[\s,]+/);
    return allWords[0] ?? '';
  }

  // Fetch from Wikimedia Commons (free, high-quality, API-friendly)
  // Searches for an image matching the product description
  async fetchFromWikimedia(itemDescription: string): Promise<string> {
    if (!itemDescription?.trim()) return '';
    try {
      const searchTerm = this.extractSearchTerms(itemDescription);
      if (!searchTerm) return '';

      const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchTerm)}&format=json&srnamespace=6&srlimit=5`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InvisibleERP/1.0)' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        query?: { search?: Array<{ title: string }> };
      };

      // Only accept a hit whose title actually shares a meaningful word with the search term —
      // Commons free-text search will otherwise happily return its "closest" match (a totally
      // unrelated travel/landscape photo) rather than no result, which is worse than no image.
      const queryWords = searchTerm.split(/[\s+]+/).map(w => w.toLowerCase()).filter(w => w.length > 2);
      const hit = data.query?.search?.find(r => {
        const title = r.title.toLowerCase();
        return queryWords.some(w => title.includes(w));
      });
      if (!hit) return '';

      // Get image details from the matched search result
      const fileName = encodeURIComponent(hit.title);
      const fileUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=File:${fileName}&prop=imageinfo&iiprop=url&format=json`;

      const fileController = new AbortController();
      const fileTimeoutId = setTimeout(() => fileController.abort(), 10000);

      const fileResponse = await fetch(fileUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InvisibleERP/1.0)' },
        signal: fileController.signal,
      });

      clearTimeout(fileTimeoutId);

      if (!fileResponse.ok) return '';
      interface WikimediaPageInfo {
        imageinfo?: Array<{ url?: string }>;
      }
      const fileData = (await fileResponse.json()) as {
        query?: { pages?: Record<string, WikimediaPageInfo> };
      };

      const pages = Object.values(
        (fileData.query?.pages ?? {}) as Record<string, WikimediaPageInfo>,
      );
      if (pages[0]?.imageinfo?.[0]?.url) {
        return await this.urlToDataUrl(pages[0].imageinfo[0].url);
      }
    } catch (error) {
      console.error('Wikimedia fetch failed:', error);
    }
    return '';
  }

  // Fallback: generate a placeholder LOCALLY (an SVG initials tile), never a real photo — a real
  // photo (even a "random public-domain" one) reads as the actual product image and misleads the
  // user, whereas a colored initials tile is unambiguously a placeholder. Stable per item
  // (color + initials derived from a hash of the description) and has no network dependency.
  private hashString(s: string): number {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = (hash << 5) - hash + s.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  private escapeXml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
  }

  async generatePlaceholder(itemDescription: string): Promise<string> {
    const description = itemDescription?.trim();
    if (!description) return '';

    const hash = this.hashString(description);
    const hue = hash % 360;
    const background = `hsl(${hue}, 55%, 45%)`;
    const initials = this.escapeXml(Array.from(description).slice(0, 2).join('').toUpperCase());

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
      <rect width="400" height="300" fill="${background}"/>
      <text x="200" y="150" font-family="sans-serif" font-size="96" fill="white" fill-opacity="0.85"
        text-anchor="middle" dominant-baseline="central">${initials}</text>
    </svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  // Main method: Try to fetch image with fallbacks
  // Tries Wikimedia first (free, high-quality), then placeholder
  async fetchProductImage(itemDescription: string): Promise<string> {
    if (!itemDescription?.trim()) return '';

    const dataUrl = await this.fetchFromWikimedia(itemDescription);
    if (dataUrl) return dataUrl;

    // Fallback to placeholder if all attempts fail
    return await this.generatePlaceholder(itemDescription);
  }
}
