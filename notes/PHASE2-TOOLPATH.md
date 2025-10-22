# Phase 2: CNC Toolpath Generation

## Overview

Phase 2 adds CNC toolpath generation capability to the existing STL-to-point-cloud converter. The system now supports loading both terrain and tool geometries, converting them to point clouds with different filtering modes, and generating toolpaths by simulating tool movement over the terrain surface.

## Implementation Summary

**Date**: January 2025
**Status**: Complete
**Key Features**:
- Dual STL loading (terrain + tool)
- Face filtering (upward for terrain, downward for tool)
- Tool reference point as lowest Z (tool tip)
- Configurable X/Y step sizes for toolpath scanning
- Z floor parameter for out-of-bounds areas
- Real-time 3D visualization (cyan terrain, orange-red toolpath)
- Recompute support for resolution changes

## Architecture

### Three-Module System

1. **Mesh Converter** (`mesh-converter-lib.c`)
   - Converts STL triangles to point clouds via XY rastering
   - Supports filter modes: upward-facing (terrain), downward-facing (tool)
   - Keeps only best Z intersection per XY grid position
   - Output: Float32Array of point positions

2. **Toolpath Generator** (`toolpath-generator.c`)
   - Creates indexed 2D grids from point clouds
   - Builds tool cloud with offsets relative to tool tip
   - Generates toolpath via collision detection
   - Output: 2D array of tool center Z heights

3. **Web Worker Integration** (`worker.js`)
   - Loads both WASM modules
   - Handles terrain and tool conversion separately
   - Manages toolpath generation pipeline
   - Transfers ownership via ArrayBuffer for performance

## Algorithm Details

### Face Filtering Strategy

**Problem**: Both terrain and tool need different triangle orientations
- **Terrain**: Need top surface (upward-facing triangles, normal_z > 0)
- **Tool**: Need cutting surface/tip (downward-facing triangles, normal_z < 0)

**Solution**: Added `filter_mode` parameter to mesh converter
```c
#define FILTER_UPWARD_FACING 0   // For terrain
#define FILTER_DOWNWARD_FACING 1 // For tools
#define FILTER_NONE 2            // Keep all
```

**Implementation**:
```c
// In triangle filtering loop:
if (filter_mode == FILTER_UPWARD_FACING && tris[t].normal_z <= 0) continue;
if (filter_mode == FILTER_DOWNWARD_FACING && tris[t].normal_z >= 0) continue;

// In intersection selection:
if (filter_mode == FILTER_UPWARD_FACING) {
    if (intersection.z > best_intersection.z) best_intersection = intersection;
} else {
    if (intersection.z < best_intersection.z) best_intersection = intersection;
}
```

### Tool Reference Point

**Critical Design Decision**: Tool reference point must be the **lowest Z point** (tool tip), not the average or highest point.

**Rationale**:
- Tool tip is the first point of contact with terrain
- Ensures proper collision detection
- Prevents tool from "hovering" above flat surfaces
- Matches CNC machining conventions

**Implementation**:
```c
// Find tool center (tool tip = lowest Z)
float center_z = 1e10f;  // Start very high
for (int i = 0; i < point_count; i++) {
    float z = points[i * 3 + 2];
    if (z < center_z) center_z = z;  // Find lowest Z
}
```

### Collision Detection

**Process**:
1. For each XY position in scan grid:
2. Test all tool points (as offsets from tool center)
3. For each tool point:
   - Calculate world position: tool_center + tool_offset
   - Find corresponding terrain Z at that XY position
   - Calculate delta: terrain_z - tool_point_z
4. Find minimum delta (first collision point)
5. Tool center Z = terrain_z where first contact occurs

**Key Insight**: This simulates physical contact - the tool descends until ANY point touches the terrain.

### Coordinate System

- **Grid Space**: Integer XY indices into 2D array
- **World Space**: Float XYZ coordinates in millimeters
- **Mapping**: `world = bounds.min + (grid_index * step_size)`

**Critical**: All three components (terrain, tool, toolpath) must use the **same grid step size** for correct alignment.

## Key Challenges and Solutions

### Challenge 1: Terrain Replacement on Tool Load

**Problem**: Loading a tool would replace the terrain geometry.

**Root Cause**: Both terrain and tool sent `'conversion-complete'` messages to the same handler.

**Solution**: Added `pendingToolLoad` flag to distinguish between terrain and tool loads:
```javascript
let pendingToolLoad = false;

// When loading tool:
pendingToolLoad = true;
worker.postMessage({ type: 'process-stl', data: { filterMode: 1 } });

// In message handler:
case 'conversion-complete':
    if (pendingToolLoad) {
        toolData = data;
        pendingToolLoad = false;
    } else {
        terrainData = data;
        displayPointCloud(data);
    }
```

### Challenge 2: Multiple Z Intersections

**Problem**: Code was adding ALL Z intersections for each XY position, creating multiple points at the same XY location.

**Impact**:
- Incorrect point counts
- Wrong surface representation
- Performance degradation

**Solution**: Track only the **best** intersection per XY grid position based on filter mode:
- Terrain: highest Z (top surface)
- Tool: lowest Z (tool tip/cutting surface)

**Implementation**: Use temporary variable to track best intersection during grid scan, only add to output array once per XY position.

### Challenge 3: Tool Hovering Above Surfaces

**Problem**: Tool was hovering above flat terrain areas instead of touching the surface.

**Root Cause**: Tool center calculated as average Z instead of lowest Z (tool tip).

**User Feedback**: "you should use the LOWEST tool point, not highest. now it's hovering even higher"

**Solution**: Changed tool center calculation to find minimum Z value:
```c
// OLD (incorrect):
float center_z = sum_z / point_count;  // Average

// NEW (correct):
if (z < center_z) center_z = z;  // Minimum (tool tip)
```

### Challenge 4: Grid Step Size Mismatch

**Problem**: After recomputing with different step sizes, toolpath would be scaled/offset incorrectly.

**Root Cause**: Hardcoded 0.5mm grid step in toolpath generator, didn't match terrain's new step size.

**Impact**: Tool offsets calculated in wrong coordinate space, causing misalignment.

**Solution**: Pass actual `STEP_SIZE` through entire pipeline:
```javascript
// In app.js:
const STEP_SIZE = parseFloat(stepSizeSelect.value);

// Pass to toolpath generator:
worker.postMessage({
    type: 'generate-toolpath',
    data: {
        terrainPoints: terrainData.positions,
        toolPoints: toolData.positions,
        xStep, yStep, oobZ,
        gridStep: STEP_SIZE  // Critical: actual grid resolution
    }
});

// In worker.js:
const toolCloudPtr = toolpathWasm.exports.create_tool(toolPtr, toolPointCount, gridStep);
```

### Challenge 5: Recompute Replacing Terrain with Tool

**Problem**: Clicking "Recompute" would replace terrain with the tool geometry.

**Root Cause**: Both terrain and tool recompute messages sent simultaneously, flag timing issue.

**Solution**: Proper sequencing of flag and message:
```javascript
recomputeBtn.addEventListener('click', async () => {
    toolData = null;
    processFile(lastLoadedFile);  // Terrain first

    if (toolFile) {
        // CRITICAL: Set flag BEFORE sending message
        pendingToolLoad = true;
        const buffer = await toolFile.arrayBuffer();
        worker.postMessage({
            type: 'process-stl',
            data: { buffer, stepSize: STEP_SIZE, filterMode: 1 }
        });
    }
});
```

### Challenge 6: Axis Labels All Showing "Z"

**Problem**: All three axis labels displayed "Z" instead of "X", "Y", "Z".

**Root Cause**: Reused the same canvas element for all three labels.

**User Feedback**: "amusingly ALL the axes are labeled Z"

**Solution**: Create new canvas inside `createTextSprite()` function for each label:
```javascript
function createTextSprite(text, color) {
    const canvas = document.createElement('canvas');  // New canvas each time
    const context = canvas.getContext('2d');
    // ... render text
    return sprite;
}
```

## Testing Strategy

### CLI Testing First

Before web integration, validated core algorithm with native C test program:

```bash
# Compile test
gcc src/test/test-toolpath.c src/wasm/toolpath-generator.c -o test-toolpath -lm -O2

# Run test
./test-toolpath benchmark/fixtures/inner.stl src/test/5mm-hemisphere.stl
```

**Results**:
- Terrain: 23,520 points (0.5mm step)
- Tool: 378 points (0.5mm step, 5mm hemisphere)
- Toolpath: 1,548 points (X step: 2, Y step: 10)
- Generation time: 0.001 seconds

**Validation**: CLI test verified algorithm correctness before dealing with browser complexity.

### Browser Testing

**Workflow**:
1. Load terrain STL (inner.stl)
2. Load tool STL (5mm-hemisphere.stl)
3. Adjust X/Y step parameters
4. Generate toolpath
5. Verify visual alignment
6. Test recompute with different resolutions

**Visual Verification**:
- Terrain: Cyan point cloud
- Toolpath: Orange-red line (GL.LINE_STRIP)
- Tool should follow terrain contours
- No hovering above flat areas
- Proper boundary handling (Z floor for out-of-bounds)

## Performance Characteristics

**Mesh Conversion** (inner.stl, 6,120 triangles):
- 0.5mm step: 23K points, ~0.8 seconds ✓ recommended
- 0.1mm step: 1.2M points, ~20 seconds

**Tool Conversion** (5mm hemisphere, 992 triangles):
- 0.5mm step: 378 points, <0.1 seconds

**Toolpath Generation**:
- 23K terrain + 378 tool points
- X step: 2, Y step: 10
- Output: 1,548 path points
- Time: <0.01 seconds

**Browser WASM**: ~1.5× slower than native C

## UI Controls

### Terrain Section
- **Detail dropdown**: 0.05mm, 0.1mm, 0.5mm (recommended), 1.0mm
- **Recompute button**: Regenerates both terrain and tool at new resolution

### Toolpath Section
- **Tool STL input**: File picker for tool geometry
- **X Step**: Grid point intervals for horizontal scanning (default: 5)
- **Y Step**: Grid point intervals for vertical scanning (default: 5)
- **Z Floor**: Out-of-bounds Z value (default: -100mm)
- **Generate button**: Creates toolpath
- **Clear button**: Removes toolpath visualization

## File Changes

### New Files
- `src/wasm/toolpath-generator.c` - Core toolpath algorithm
- `src/wasm/mesh-converter-lib.h` - Shared header with filter modes
- `src/test/test-toolpath.c` - CLI test program
- `src/test/generate-hemisphere.js` - Node.js tool STL generator
- `src/web/toolpath-generator.wasm` - Compiled module

### Modified Files
- `src/wasm/mesh-converter-lib.c` - Added filter_mode parameter
- `src/web/worker.js` - Dual WASM loading, toolpath generation
- `src/web/app.js` - Tool loading, pendingToolLoad flag, STEP_SIZE passing
- `src/web/index.html` - Toolpath control panel
- `README.md` - Phase 2 documentation
- `package.json` - Build scripts for both WASM modules

## API Design

### Mesh Converter
```c
float* convert_to_point_mesh(
    float* triangles,      // Input geometry
    int triangle_count,
    float step_size,       // Grid resolution
    int* out_point_count,  // Output size
    int filter_mode        // 0=upward, 1=downward
);
```

### Toolpath Generator
```c
PointGrid* create_grid(float* points, int point_count);
ToolCloud* create_tool(float* points, int point_count, float grid_step);
ToolPath* generate_path(PointGrid* terrain, ToolCloud* tool,
                        int x_step, int y_step, float oob_z);
```

## Lessons Learned

1. **Filter Modes Are Critical**: Terrain and tool need opposite face filtering
2. **Tool Tip Is Reference**: Lowest Z point, not average or highest
3. **One Intersection Per XY**: Only keep best Z value for each grid position
4. **Grid Resolution Matters**: All components must use same step size
5. **CLI Testing Saves Time**: Validate algorithms before browser complexity
6. **Flag Timing Is Critical**: Set pendingToolLoad immediately before postMessage
7. **Canvas Reuse Fails**: Create new canvas element for each sprite
8. **Coordinate Space Matters**: Distinguish grid space from world space

## Future Improvements

- [ ] Adaptive step sizing based on terrain complexity
- [ ] Multiple toolpath strategies (contour, spiral, raster)
- [ ] G-code export
- [ ] Real-time toolpath preview during parameter adjustment
- [ ] Tool collision visualization (show contact points)
- [ ] Support for multiple tool types (flat, ball, v-bit)
- [ ] Spatial acceleration for larger terrains (BVH, octree)
- [ ] Parallel toolpath generation (multiple scanlines)

## Conclusion

Phase 2 successfully adds CNC toolpath generation to the application. The implementation uses efficient C algorithms compiled to WebAssembly, maintains interactive performance, and provides real-time 3D visualization. Key technical achievements include proper face filtering, tool reference point selection, and grid resolution synchronization across the entire pipeline.
