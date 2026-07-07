# Product Image Population Utility

CLI tools to bulk populate product images for shop catalog items from the internet.

## Quick Start

```bash
# Set your API token
export API_TOKEN="your_admin_token_here"

# Populate all items without images
./tools/populate-images.sh

# Or with Node.js directly
node tools/populate-images.js
```

## Installation

The scripts are part of the InvisibleERP project and require:
- Node.js 22.x or higher
- Valid API token (with `md_item` permission)

## Usage

### Shell Script (Recommended)

```bash
# Basic usage
./tools/populate-images.sh

# With environment variable
API_TOKEN=your_token ./tools/populate-images.sh

# Populate specific items
API_TOKEN=your_token ./tools/populate-images.sh --items ITEM-001,ITEM-002,ITEM-003

# Custom API endpoint
API_TOKEN=your_token ./tools/populate-images.sh --api http://api.example.com:3001
```

### Node.js Script

```bash
# Basic usage
API_TOKEN=your_token node tools/populate-images.js

# With explicit options
node tools/populate-images.js \
  --api http://localhost:3001 \
  --token your_token \
  --items LAPTOP,MONITOR,KEYBOARD
```

## Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--api URL` | - | `http://localhost:3001` | API endpoint URL |
| `--token TOKEN` | - | (from `API_TOKEN` env) | Authentication token |
| `--items IDS` | - | (all items) | Comma-separated item IDs |
| `--help` | `-h` | - | Show help message |

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `API_URL` | API endpoint (optional) | `http://api.example.com:3001` |
| `API_TOKEN` | Authentication token (required) | `abc123xyz...` |

## Examples

### 1. Populate All Items

Fetches images for all items without existing images:

```bash
API_TOKEN=$(cat ~/.auth/token.txt) ./tools/populate-images.sh
```

**Output:**
```
📸 Product Image Population

API Endpoint: http://localhost:3001
Mode: Populate all items without images

⏳ Fetching images...

✅ Complete!

Results:
  Processed:  47 items
  ✓ Success:  45 items
  ✗ Failed:   2 items

Details (showing first 5 of 47 items):
  ✓ LAPTOP: Image fetched and stored
  ✓ MONITOR: Image fetched and stored
  ✓ KEYBOARD: Image fetched and stored
  ✗ ITEM-NODESC: Could not fetch image
  ✓ RICE-5KG: Image fetched and stored
  ... and 42 more items

📊 Success Rate: 95%
```

### 2. Populate Specific Items

Only fetch images for selected items:

```bash
API_TOKEN=your_token ./tools/populate-images.sh --items LAPTOP,MONITOR,KEYBOARD
```

### 3. Batch Processing

Process in multiple batches to avoid timeouts:

```bash
#!/bin/bash

ITEMS=(
  "LAPTOP,MONITOR,KEYBOARD"
  "MOUSE,USB-CABLE,HDMI-CABLE"
  "DESK,CHAIR,MONITOR-ARM"
)

for batch in "${ITEMS[@]}"; do
  echo "Processing batch: $batch"
  API_TOKEN=your_token ./tools/populate-images.sh --items "$batch"
  sleep 5  # Wait between batches
done

echo "✅ All batches completed"
```

### 4. Get Auth Token Programmatically

If using OAuth/SSO, get token before running:

```bash
# Using curl and jq
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}' | jq -r '.access_token')

API_TOKEN=$TOKEN ./tools/populate-images.sh
```

### 5. Schedule Periodic Population

Run on a schedule using cron:

```bash
# Every day at 2 AM
0 2 * * * /home/user/invisibleERP/tools/populate-images.sh >> /var/log/populate-images.log 2>&1

# Or with explicit token from file
0 2 * * * API_TOKEN=$(cat ~/.auth/token.txt) /home/user/invisibleERP/tools/populate-images.sh
```

## How It Works

1. **Connects to API**: Uses the specified API endpoint and authentication token
2. **Fetches Items**: Queries the item catalog (filtered by ID if specified)
3. **Downloads Images**: Searches Wikimedia Commons for matching product images
4. **Converts Format**: Converts images to base64 data URLs
5. **Stores Results**: Saves images to the `item_images` database table
6. **Reports Progress**: Shows real-time success/failure counts

## Performance

- **Speed**: ~5-10 items per second (network dependent)
- **Timeout**: 10 seconds per image fetch
- **Batch Size**: Process up to 100 items per API call
- **Fallback**: Uses placeholder images if search fails

### Estimated Times

| Items | Estimated Time |
|-------|-----------------|
| 10 | ~2 seconds |
| 50 | ~10 seconds |
| 100 | ~20 seconds |
| 500 | ~2-3 minutes |
| 1000 | ~5-10 minutes |

## Troubleshooting

### Error: "API token is required"

**Solution:** Set the `API_TOKEN` environment variable

```bash
export API_TOKEN="your_token"
./tools/populate-images.sh
```

### Error: "HTTP 401: Unauthorized"

**Solution:** Token is invalid or expired. Get a new token:

```bash
# Login to get new token
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_password"}'
```

### Error: "HTTP 403: Forbidden"

**Solution:** User doesn't have `md_item` permission. Assign the permission to your user account in the admin panel.

### Some Images Fail to Fetch

This is normal. Wikimedia Commons may not have images for all products:

- **Rare/Obscure Items**: Fallback to a generated placeholder tile (stable color + initials,
  derived from a hash of the item description — no network call, so it never shows an
  unrelated real photo in place of the actual product)
- **Thai/Non-English Names**: Translated via a curated Thai product/ingredient dictionary
  (substring-matched, since Thai compound words have no spaces) before searching
- **No Dictionary Match / Generic Names**: Search is skipped and the item gets the placeholder
  tile rather than a guessed — and possibly wrong — Wikimedia result

**Workaround:** Manually upload images for failed items via the admin panel, or add the missing
term to the Thai dictionary in `image-fetch.service.ts`.

### Timeout After Many Items

If processing 1000+ items, the API may timeout. Use batch processing:

```bash
# Split items into batches
API_TOKEN=token ./tools/populate-images.sh --items "ITEM-001,ITEM-002,...ITEM-050"
sleep 5
API_TOKEN=token ./tools/populate-images.sh --items "ITEM-051,ITEM-052,...ITEM-100"
```

## Integration

### In CI/CD Pipelines

```bash
# GitHub Actions
- name: Populate Product Images
  run: |
    API_TOKEN=${{ secrets.API_TOKEN }} \
    ./tools/populate-images.sh
```

### In Docker

```dockerfile
FROM node:22

COPY tools/populate-images.js /app/tools/
WORKDIR /app

ENTRYPOINT ["node", "tools/populate-images.js"]
```

Run with:
```bash
docker run -e API_TOKEN=your_token \
  -e API_URL=http://api:3001 \
  image-populator --items ITEM-001,ITEM-002
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success (all items populated) |
| `1` | Partial failure (some items failed) or error |

Use in scripts to handle failures:

```bash
if ./tools/populate-images.sh; then
  echo "✅ All images populated successfully"
else
  echo "⚠️ Some images failed to populate"
  # Send alert, retry, etc.
fi
```

## Advanced Usage

### Dry Run (Simulation)

The utility doesn't have a built-in dry-run, but you can test with a single item:

```bash
API_TOKEN=token ./tools/populate-images.sh --items TEST-ITEM
```

### Retry Failed Items

After a run, you can extract failed items and retry:

1. Check the output for failed items
2. Run again with only those items
3. Check if they succeed the second time

```bash
API_TOKEN=token ./tools/populate-images.sh --items FAILED-ITEM-1,FAILED-ITEM-2
```

### Monitor Progress

For long-running operations, monitor in real-time:

```bash
# In one terminal
API_TOKEN=token ./tools/populate-images.sh | tee populate.log

# In another terminal
tail -f populate.log
```

## Support

For issues:

1. Check the troubleshooting section above
2. Verify API is running: `curl http://localhost:3001/api/health`
3. Check authentication: `curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3001/api/auth/me`
4. Review API logs for errors

## Related Commands

```bash
# View items without images (need to query DB directly or via admin panel)
# Admin Panel: Master Data → Items → Filter by missing images

# Manually upload images
# Admin Panel: Master Data → Items → Upload

# View populated images
# Shop: /shop → Browse catalog → View product tiles
```

## Security Notes

- **Token Safety**: Never commit tokens to version control
- **Store Safely**: Use environment files, secret managers, or CI/CD secrets
- **Scope Minimally**: Use tokens with only `md_item` permission
- **Rotate Regularly**: Change tokens periodically

## Performance Optimization

For large deployments:

1. **Parallel Processing**: Run multiple instances with different item batches
2. **Off-Peak Hours**: Schedule during low-traffic periods
3. **Batch Size**: Keep batches under 100 items
4. **Network**: Ensure stable internet connectivity for image downloads

## License & Attribution

Images fetched from Wikimedia Commons are under various open licenses.
Placeholder images are generated locally (SVG initials tile) — no external
service or license involved.
