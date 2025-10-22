# STL to Point Mesh Converter & CNC Toolpath Generator

A single-page Three.js application that converts STL files to point cloud meshes and generates CNC toolpaths using WebAssembly.

> **Note**: See the [`notes/`](notes/) directory for detailed documentation about optimization process, performance analysis, UI improvements, and development session summaries.

## Overview

This application provides two main capabilities:

1. **STL to Point Cloud**: Convert STL files to point meshes using a custom XY rastering algorithm
2. **CNC Toolpath Generation**: Generate toolpaths by simulating tool movement over terrain surfaces

All processing happens in Web Workers using WebAssembly (compiled from C) for optimal performance.

## Architecture

### Frontend Stack
- **Vanilla JavaScript** - No build tooling, runs directly in browser
- **Three.js** - 3D rendering and orbit controls
- **Web Workers** - Off-main-thread STL processing
- **WebAssembly (C)** - High-performance mesh conversion

Target: Modern Chrome/V8 (evergreen browsers only)

## Algorithm Design

### 1. STL to Point Mesh Conversion

The conversion uses an XY rastering approach with face filtering:

**Process**:
1. Calculate bounding box of input geometry
2. Filter triangles based on surface normal:
   - **Terrain**: Keep upward-facing triangles (normal_z > 0)
   - **Tool**: Keep downward-facing triangles (normal_z < 0)
3. Raster XY plane at configurable intervals (0.05mm - 1.0mm)
4. For each XY grid point, cast ray through Z axis
5. Find intersections and keep:
   - **Terrain**: Highest Z intersection (top surface)
   - **Tool**: Lowest Z intersection (tool tip/cutting surface)

**Output**: Float32Array of point positions (x,y,z,x,y,z,...)

### 2. CNC Toolpath Generation

**Process**:
1. Convert terrain and tool point clouds to indexed 2D grids
2. Define tool reference point as lowest Z point (tool tip)
3. Scan tool over terrain in XY grid with configurable step sizes
4. At each position, calculate collision:
   - Test all tool points against terrain
   - Find minimum delta between tool and terrain
   - Tool center Z = terrain Z where first contact occurs
5. Generate scanline-based toolpath

**Output**: 2D array of tool center Z heights at each XY position

### Parameters
- **Step size**: 0.1mm - 1.0mm (configurable via UI dropdown)
- **X/Y steps**: Grid point intervals for toolpath scanning
- **Z floor**: Out-of-bounds Z value for areas without terrain

### Performance Characteristics

**Mesh Conversion Complexity**: O(grid_points × triangles)

Typical performance for inner.stl (6,120 triangles, 84×84×28mm):
- **0.05mm step**: 4.8M points, ~280 seconds (not practical for interactive use)
- **0.1mm step**: 1.2M points, ~20 seconds
- **0.5mm step**: 48K points, ~0.8 seconds ✓ **recommended**
- **1.0mm step**: 12K points, ~0.2 seconds

**Toolpath Generation**: Near-instant (<0.01s) for typical terrain/tool combinations
- Terrain: 23K points (0.5mm, inner.stl)
- Tool: 378 points (0.5mm, 5mm hemisphere)
- Toolpath: 1,548 points (X/Y step: 2/10)

Browser WASM is approximately 1.5× slower than native C compilation.

## File Structure

```
/
├── src/
│   ├── web/
│   │   ├── index.html              - Main HTML page with drag/drop interface
│   │   ├── app.js                  - Three.js scene setup and main application logic
│   │   ├── worker.js               - Web Worker for STL processing
│   │   ├── style.css               - Application styling
│   │   ├── mesh-converter.wasm     - Compiled mesh conversion module
│   │   └── toolpath-generator.wasm - Compiled toolpath generation module
│   ├── wasm/
│   │   ├── mesh-converter.c        - C wrapper for mesh conversion
│   │   ├── mesh-converter-lib.c    - Mesh conversion algorithm implementation
│   │   ├── mesh-converter-lib.h    - Shared header with filter mode constants
│   │   └── toolpath-generator.c    - CNC toolpath generation algorithm
│   └── test/
│       ├── test-converter-new.c    - Native C test for mesh conversion
│       ├── test-toolpath.c         - Native C test for toolpath generation
│       └── generate-hemisphere.js  - Node.js script to generate test tool STL
├── benchmark/
│   ├── fixtures/                   - Test STL files
│   └── versions/                   - Historical algorithm versions
├── notes/                          - Detailed documentation and session notes
├── package.json                    - Project metadata and build scripts
└── README.md                       - This file (project documentation)
```

## WebAssembly Interface

### Mesh Converter Module

```c
// Converts triangle mesh to point cloud via XY rastering
// Parameters:
//   - triangles: flat array of triangle vertices (x,y,z for each vertex)
//   - triangle_count: number of triangles
//   - step_size: XY raster step in mm (e.g., 0.5)
//   - out_point_count: pointer to store resulting point count
//   - filter_mode: 0=upward-facing (terrain), 1=downward-facing (tool)
// Returns: pointer to flat array of point positions
float* convert_to_point_mesh(float* triangles, int triangle_count, float step_size,
                              int* out_point_count, int filter_mode);
```

### Toolpath Generator Module

```c
// Create indexed 2D grid from point cloud
PointGrid* create_grid(float* points, int point_count);

// Create tool cloud with offsets relative to lowest Z (tool tip)
ToolCloud* create_tool(float* points, int point_count, float grid_step);

// Generate toolpath by scanning tool over terrain
// Parameters:
//   - x_step, y_step: grid point intervals for scanning
//   - oob_z: Z value for out-of-bounds areas
ToolPath* generate_path(PointGrid* terrain, ToolCloud* tool,
                        int x_step, int y_step, float oob_z);
```

## Development Notes

### WASM Compilation

Requires [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) to be installed.

```bash
# Build both WASM modules
npm run build:wasm

# Or compile individually:

# Mesh converter
emcc src/wasm/mesh-converter.c -o src/web/mesh-converter.wasm \
  -s WASM=1 \
  -s STANDALONE_WASM \
  -s EXPORTED_FUNCTIONS='["_convert_to_point_mesh","_get_bounds","_free_output","_malloc","_free"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -O3 \
  --no-entry

# Toolpath generator
emcc src/wasm/toolpath-generator.c -o src/web/toolpath-generator.wasm \
  -s WASM=1 \
  -s STANDALONE_WASM \
  -s EXPORTED_FUNCTIONS='["_create_grid","_create_tool","_generate_path","_get_path_dimensions","_copy_path_data","_free_point_grid","_free_tool_cloud","_free_toolpath","_malloc","_free"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -O3 \
  --no-entry
```

### Running the Application

The application requires a local web server (for Web Workers and WASM module loading).

**Preferred method (Node-based):**
```bash
npx serve
```

Then open `http://localhost:3000` in Chrome.

See [QUICKSTART.md](QUICKSTART.md) for detailed setup and testing instructions.

### Testing

Test programs are available for validation:

**Mesh Converter (Native C):**
```bash
gcc src/test/test-converter-new.c src/wasm/mesh-converter-lib.c -o test-converter -lm -O2
./test-converter benchmark/fixtures/inner.stl 0.5
```

**Toolpath Generator (Native C):**
```bash
# Generate test tool
node src/test/generate-hemisphere.js

# Compile and run test
gcc src/test/test-toolpath.c src/wasm/toolpath-generator.c -o test-toolpath -lm -O2
./test-toolpath benchmark/fixtures/inner.stl src/test/5mm-hemisphere.stl
```

Both tests validate the algorithms without requiring a browser. See QUICKSTART.md for more details.

## Future Enhancements
- [x] ~~Adjustable step size via UI~~ (Implemented: 0.05mm - 1.0mm with recompute button)
- [ ] **Spatial acceleration structures** (BVH, octree, or uniform grid) to reduce O(n×m) to O(n×log(m))
- [ ] Progressive rendering (start coarse, refine over time)
- [ ] Multiple rastering strategies (adaptive sampling, importance sampling)
- [ ] Export point cloud and toolpath formats (G-code, PLY, etc.)
- [ ] Support for other 3D file formats (OBJ, 3MF)
- [ ] JS-owned memory buffers to avoid copies and enable shared buffers with Three.js
- [ ] Adaptive toolpath strategies (constant scallop height, contour following)
