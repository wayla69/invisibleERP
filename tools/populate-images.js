#!/usr/bin/env node

/**
 * CLI utility to bulk populate product images for shop catalog items.
 * Fetches images from the internet based on item descriptions.
 *
 * Usage:
 *   node tools/populate-images.js [OPTIONS]
 *
 * Examples:
 *   # Populate all items without images
 *   node tools/populate-images.js
 *
 *   # Populate specific items
 *   node tools/populate-images.js --items ITEM-001,ITEM-002,ITEM-003
 *
 *   # Custom API endpoint
 *   node tools/populate-images.js --api http://api.example.com --token YOUR_TOKEN
 *
 *   # Show help
 *   node tools/populate-images.js --help
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

// Parse command-line arguments
const options = {
  api: process.env.API_URL || 'http://localhost:3001',
  token: process.env.API_TOKEN || '',
  items: '',
  help: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    options.help = true;
  } else if (arg === '--api') {
    options.api = args[++i];
  } else if (arg === '--token') {
    options.token = args[++i];
  } else if (arg === '--items') {
    options.items = args[++i];
  }
}

function showHelp() {
  console.log(`
Populate Product Images CLI
============================

Fetches and stores product images for shop catalog items from the internet
based on item descriptions.

USAGE:
  node tools/populate-images.js [OPTIONS]

OPTIONS:
  --api URL              API endpoint (default: http://localhost:3001)
                         Env: API_URL
  --token TOKEN          Authentication token
                         Env: API_TOKEN
  --items IDS            Comma-separated item IDs to populate
                         If omitted, populates all items without images
  --help, -h             Show this help message

EXAMPLES:
  # Populate all items without images (requires auth)
  API_TOKEN=your_token node tools/populate-images.js

  # Populate specific items
  API_TOKEN=your_token node tools/populate-images.js --items ITEM-001,ITEM-002,ITEM-003

  # Using custom API endpoint
  node tools/populate-images.js \\
    --api http://api.example.com:3001 \\
    --token your_token

ENVIRONMENT VARIABLES:
  API_URL    API endpoint (default: http://localhost:3001)
  API_TOKEN  Authentication token (required)

OUTPUT:
  Shows progress and results in real-time:
  - Total items processed
  - Success count (items with fetched images)
  - Failed count (items without images)
  - Per-item status (first 5 items)
`);
}

if (options.help) {
  showHelp();
  process.exit(0);
}

// Validate required options
if (!options.token) {
  console.error('❌ Error: API token is required');
  console.error('   Set via --token flag or API_TOKEN environment variable');
  console.error('\nExample:');
  console.error('  API_TOKEN=your_token node tools/populate-images.js');
  process.exit(1);
}

// Make HTTP request
function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const requestOptions = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.token}`,
        ...(options.headers || {}),
      },
    };

    const request = protocol.request(url, requestOptions, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, data });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    request.on('error', reject);

    if (body) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

// Format numbers with commas
function formatNum(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Main function
async function main() {
  console.log('\n📸 Product Image Population\n');
  console.log(`API Endpoint: ${options.api}`);

  if (options.items) {
    const itemList = options.items.split(',').map((s) => s.trim()).filter(Boolean);
    console.log(`Items to populate: ${itemList.join(', ')}`);
  } else {
    console.log('Mode: Populate all items without images');
  }

  console.log('\n⏳ Fetching images...\n');

  try {
    const url = new URL('/api/procurement/catalog/populate-images', options.api);
    const body = options.items
      ? { item_ids: options.items.split(',').map((s) => s.trim()).filter(Boolean) }
      : {};

    const result = await makeRequest(url.toString(), { method: 'POST', token: options.token }, body);
    const data = result.data;

    // Display results
    console.log('✅ Complete!\n');
    console.log('Results:');
    console.log(`  Processed:  ${formatNum(data.processed)} items`);
    console.log(`  ✓ Success:  ${formatNum(data.succeeded)} items`);

    if (data.failed > 0) {
      console.log(`  ✗ Failed:   ${formatNum(data.failed)} items`);
    }

    // Show per-item details
    if (data.items && data.items.length > 0) {
      const itemsToShow = data.items.slice(0, 5);
      console.log(`\nDetails (showing first ${itemsToShow.length} of ${data.items.length} items):`);
      itemsToShow.forEach((item) => {
        const icon = item.status === 'success' ? '✓' : '✗';
        const color = item.status === 'success' ? '\x1b[32m' : '\x1b[31m'; // green or red
        const reset = '\x1b[0m';
        console.log(`  ${color}${icon}${reset} ${item.item_id}: ${item.message}`);
      });

      if (data.items.length > 5) {
        console.log(`  ... and ${data.items.length - 5} more items`);
      }
    }

    console.log(`\n📊 Success Rate: ${formatNum(Math.round((data.succeeded / data.processed) * 100))}%`);
    console.log('');

    // Exit with appropriate code
    process.exit(data.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    console.error('\nTroubleshooting:');
    console.error('  - Verify API endpoint is running');
    console.error('  - Check authentication token is valid');
    console.error('  - Ensure API_TOKEN environment variable is set');
    console.error(`\nUsage: API_TOKEN=your_token node tools/populate-images.js`);
    process.exit(1);
  }
}

main();
