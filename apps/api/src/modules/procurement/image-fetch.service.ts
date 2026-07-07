import { Injectable } from '@nestjs/common';

// Image fetching service — retrieves product images from the internet and converts to base64 data-URLs
// for storage in the item_images table. Supports multiple image sources with fallbacks.
@Injectable()
export class ImageFetchService {
  // Convert image URL to base64 data URL
  async urlToDataUrl(imageUrl: string): Promise<string> {
    try {
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

  // Common product names translated to English (Thai → English mappings)
  private readonly thaiToEnglish: Record<string, string> = {
    // Electronics
    แล็ปท็อป: 'laptop',
    'แล็บท็อป': 'laptop',
    คอมพิวเตอร์: 'computer',
    จอภาพ: 'monitor',
    'จออ': 'monitor',
    เมาส์: 'mouse',
    คีย์บอร์ด: 'keyboard',
    อุปกรณ์: 'device',
    อุปกรณ์ส่ง: 'equipment',
    // Office
    โต๊ะ: 'desk',
    เก้าอี้: 'chair',
    ตู้: 'cabinet',
    // General
    ชุด: 'set',
    ร่ม: 'umbrella',
    กระเป๋า: 'bag',
    กล่อง: 'box',
    ถุง: 'bag',
  };

  private extractSearchTerms(description: string): string {
    if (!description?.trim()) return '';

    const trimmed = description.trim();
    // Check if it's Thai text
    const thaiPattern = /[฀-๿]/;
    if (thaiPattern.test(trimmed)) {
      // For Thai text, try to translate common words or use first word
      const words = trimmed.split(/[\s,]+/);
      for (const word of words) {
        const translated = this.thaiToEnglish[word.toLowerCase()];
        if (translated) return translated;
      }
      // If no translation found, use first word anyway
      return words[0] ?? '';
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

      if (!data.query?.search?.[0]) return '';

      // Get image details from the first search result
      const fileName = encodeURIComponent(data.query.search[0].title);
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

  // Fallback: Generate a placeholder image with the item name
  // Uses a placeholder service like Placeholder.com or PlaceholderImage
  async generatePlaceholder(itemDescription: string): Promise<string> {
    if (!itemDescription?.trim()) return '';
    try {
      // Use picsum.photos as a fallback (public domain photos)
      // Hash the item description to get a stable ID
      let hash = 0;
      for (let i = 0; i < itemDescription.length; i++) {
        const char = itemDescription.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      const imageId = Math.abs(hash) % 1000;
      const placeholderUrl = `https://picsum.photos/400/300?random=${imageId}`;
      return await this.urlToDataUrl(placeholderUrl);
    } catch (error) {
      console.error('Placeholder generation failed:', error);
    }
    return '';
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
