# GPU Tiling Implementation

## Overview

The raster-path library now includes automatic GPU memory-aware tiling for processing large STL files that would exceed WebGPU buffer limits. The system automatically detects when tiling is needed and processes the mesh in tiles, then stitches the results together seamlessly.

## Key Features

- **Automatic tiling detection**: Based on GPU buffer size limits and safety margins
- **Runtime configuration**: All tiling parameters can be configured at initialization or updated during runtime
- **Query interfaces**: Apps can interrogate system capabilities and memory requirements before processing
- **Transparent operation**: Tiling happens automatically when needed - no API changes required
- **Performance tracking**: UI shows whether tiling was used and how many tiles were processed

## Configuration

### ESM API Configuration

```javascript
import { RasterPath } from './src/index.js';

const converter = new RasterPath({
    maxGPUMemoryMB: 256,           // Max GPU memory per tile (default: 256MB)
    gpuMemorySafetyMargin: 0.8,    // Safety margin 80% of limit (default: 0.8)
    tileOverlapMM: 10,              // Overlap between tiles for toolpath (default: 10mm)
    autoTiling: true,               // Enable automatic tiling (default: true)
    minTileSize: 50                 // Minimum tile size in mm (default: 50mm)
});

await converter.init();
```

### Runtime Configuration Updates

```javascript
// Update config after initialization
converter.updateConfig({
    maxGPUMemoryMB: 512,           // Increase tile size
    gpuMemorySafetyMargin: 0.7     // More aggressive use of GPU memory
});
```

## Query Interfaces

### Get Device Capabilities

```javascript
const capabilities = converter.getDeviceCapabilities();
console.log(capabilities);
// {
//     maxStorageBufferBindingSize: 1073741824,  // 1GB
//     maxBufferSize: 1073741824,
//     maxComputeWorkgroupSizeX: 256,
//     maxComputeWorkgroupSizeY: 256
// }
```

### Estimate Memory Requirements

```javascript
const bounds = {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 500, y: 500, z: 100 }
};
const stepSize = 0.05; // 0.05mm resolution

const estimate = converter.estimateMemory(bounds, stepSize);
console.log(estimate);
// {
//     gridWidth: 10001,
//     gridHeight: 10001,
//     totalPoints: 100020001,
//     gpuMemoryMB: 1600.32,      // GPU memory needed
//     maxSafeMB: 819.2,          // Safe limit (80% of 1GB)
//     needsTiling: true,         // Tiling will be used
//     estimatedTiles: 4          // Estimated number of tiles
// }
```

### Check If Tiling Will Be Used

```javascript
const willTile = converter.willUseTiling(bounds, stepSize);
console.log(willTile); // true
```

## How It Works

### 1. Memory Estimation

Before rasterization, the system calculates:
- Grid dimensions based on bounds and step size
- GPU buffer size needed = `gridWidth × gridHeight × 4 × 4` bytes
  - Output buffer: 3 floats (xyz) × 4 bytes
  - Valid mask: 1 uint × 4 bytes
- Compares against device limit × safety margin

### 2. Automatic Tiling Decision

```javascript
function shouldUseTiling(bounds, stepSize) {
    const totalGPUMemory = gridWidth * gridHeight * 16; // 16 bytes per point
    const maxSafeSize = deviceLimit * safetyMargin;
    return autoTiling && (totalGPUMemory > maxSafeSize);
}
```

### 3. Tile Creation

If tiling is needed:
- Uses binary search to find optimal tile dimensions
- Divides bounds into regular grid of tiles
- Each tile gets:
  - **Core bounds**: Area this tile "owns"
  - **Extended bounds**: Core + overlap for toolpath continuity

```
Tiles with overlap (for toolpath):
┌─────────┬─────────┐
│ Tile 0  │ Tile 1  │
│ [Core]  │ [Core]  │
│ ◄─►overlap◄─►     │
├─────────┼─────────┤
│ Tile 2  │ Tile 3  │
│         │         │
└─────────┴─────────┘
```

### 4. Tile Processing

Each tile is rasterized independently:
```javascript
for (const tile of tiles) {
    const result = await rasterizeTile(triangles, stepSize, filterMode, tile.coreBounds);
    tileResults.push(result);
}
```

### 5. Stitching

Results are combined into a single point cloud:
```javascript
function stitchTiles(tileResults) {
    const totalPoints = tileResults.reduce((sum, r) => sum + r.pointCount, 0);
    const allPositions = new Float32Array(totalPoints * 3);

    let offset = 0;
    for (const result of tileResults) {
        allPositions.set(result.positions, offset);
        offset += result.positions.length;
    }

    return { positions: allPositions, pointCount: totalPoints, ... };
}
```

## Performance Characteristics

### Without Tiling
- **Pros**: Single GPU kernel launch, fastest for datasets that fit
- **Cons**: Hard fails if dataset exceeds GPU buffer limit

### With Tiling
- **Pros**: Can process arbitrarily large datasets
- **Cons**: Multiple GPU kernel launches, sequential processing

### Overhead
- Tiling overhead is minimal (~1-5% per tile boundary)
- Most time is still spent in GPU compute
- Stitching is very fast (simple memory copy)

## Example: Large Dataset

```javascript
// 500mm × 500mm terrain at 0.05mm = 100M points
// Would need 1.6GB GPU buffer without tiling

const stlBuffer = await loadSTL('large-terrain.stl');

// This will automatically use tiling
const result = await converter.rasterizeSTL(
    stlBuffer,
    0.05,              // High resolution
    0,                 // Max Z filter
    {                  // Large padded bounds
        min: { x: -50, y: -50, z: -10 },
        max: { x: 550, y: 550, z: 110 }
    }
);

// Result contains tileCount if tiling was used
console.log(`Processed with ${result.tileCount || 1} tiles`);
```

## Web UI Integration

The web UI automatically displays tiling information:

### Performance Panel
- **Tiling**: Shows "No tiling" or "4 tiles" based on processing
- **GPU Limit**: Shows device's max storage buffer size

### Console Output
When tiling is used, you'll see:
```
[WebGPU Worker] Creating 2x2 = 4 tiles (250mm × 250mm each)
[WebGPU Worker] 🔲 Using tiling: 2x2 = 4 tiles
[WebGPU Worker] Processing tile 1/4 (tile_0_0)...
[WebGPU Worker] Tile 1/4 complete: 6250001 points
...
[WebGPU Worker] ✅ Tiled rasterization complete: 25000004 points from 4 tiles
```

## Toolpath Generation with Tiling

For toolpath generation, tiles use overlap regions to ensure continuity:

```javascript
const tiles = createTiles(bounds, stepSize, maxMemory, toolRadius);
// Each tile's extendedBounds includes overlap = toolRadius

for (const tile of tiles) {
    // Rasterize with overlap
    const heightMap = await getTileHeightMap(tile.extendedBounds);

    // Generate toolpath with full context
    const toolpath = await generateToolpath(heightMap, ...);

    // Extract only core region (discard overlap)
    const coreToolpath = clipToBounds(toolpath, tile.coreBounds);
}
```

This ensures smooth toolpaths across tile boundaries without discontinuities.

## Best Practices

1. **Use safety margin**: Default 80% is conservative, can go to 90-95% if needed
2. **Monitor tiling status**: Check `result.tileCount` to understand processing
3. **Adjust for your use case**:
   - Small parts: Can disable tiling (`autoTiling: false`)
   - Large terrains: Increase safety margin for more predictable memory usage
4. **Test with estimation**: Use `estimateMemory()` before processing large jobs

## Troubleshooting

### Still Getting Buffer Errors?
- Increase `gpuMemorySafetyMargin` to 0.9 or 0.95
- Reduce `maxGPUMemoryMB` to force smaller tiles
- Check device limits: `converter.getDeviceCapabilities()`

### Performance Issues?
- Tiling adds overhead - avoid for small datasets
- Disable with `autoTiling: false` if dataset fits in memory
- Each tile requires GPU kernel launch + memory copy

### Tile Count Too High?
- Reduce safety margin (more aggressive memory use)
- Increase `maxGPUMemoryMB` if device supports it
- Consider lower resolution (larger step size)

## Technical Details

### Memory Calculation
```javascript
// GPU buffer requirements
const outputBuffer = gridWidth * gridHeight * 3 * 4;  // xyz positions
const maskBuffer = gridWidth * gridHeight * 4;        // valid mask
const totalGPU = outputBuffer + maskBuffer;

// JS memory (only valid points)
const jsMemory = validPointCount * 3 * 4;  // Typically much smaller!
```

### Tile Size Optimization
Binary search finds largest tile that fits in memory:
```javascript
let low = minTileSize, high = max(width, height);
while (low <= high) {
    const mid = (low + high) / 2;
    const memory = calculateTileMemory(mid);
    if (memory <= maxSafe) {
        bestSize = mid;
        low = mid + 1;
    } else {
        high = mid - 1;
    }
}
```

### Data Structures
- **Tiles**: `{ id, gridX, gridY, coreBounds, extendedBounds }`
- **Results**: `{ positions, pointCount, bounds, conversionTime, tileCount? }`
- **Capabilities**: `{ maxStorageBufferBindingSize, maxBufferSize, ... }`

## Future Enhancements

Potential improvements for the future:
- Parallel tile processing (multiple GPU contexts)
- LRU cache for tile results (useful for pan/zoom)
- IndexedDB persistence for very large datasets
- Progressive rendering (stream tiles to display)
- LOD (Level of Detail) based on camera distance
