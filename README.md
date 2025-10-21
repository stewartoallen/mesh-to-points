# STL to Point Mesh Converter

A single-page Three.js application that converts STL files to point cloud meshes using WebAssembly.

## Overview

This application allows users to drag and drop STL files, which are then converted to point meshes using a custom rastering algorithm. The conversion happens in a Web Worker using WebAssembly (compiled from C) for optimal performance.

## Architecture

### Frontend Stack
- **Vanilla JavaScript** - No build tooling, runs directly in browser
- **Three.js** - 3D rendering and orbit controls
- **Web Workers** - Off-main-thread STL processing
- **WebAssembly (C)** - High-performance mesh conversion

Target: Modern Chrome/V8 (evergreen browsers only)

## Algorithm Design

### STL to Point Mesh Conversion

The conversion uses an XY rastering approach:

1. **Input**: Flat Float32Array of triangle vertices (same format as Three.js positions: x,y,z,x,y,z,...)
2. **Process**:
   - Calculate bounding box of input geometry (done in WASM)
   - Raster XY plane at fixed intervals (default step: 0.05mm)
   - For each XY grid point, cast a ray through Z axis
   - Detect ray-triangle intersections with input mesh
   - Record intersection points where ray hits surfaces
3. **Output**:
   - Single Float32Array containing point positions (x,y,z,x,y,z,...)
   - Bounding box information

### Parameters
- **Step size**: 0.5mm default (configurable via function parameter)
- **Output**: Points only where rays intersect surfaces (no volume filling)

### Performance Characteristics

Algorithm complexity: O(grid_points × triangles)

Typical performance for inner.stl (6,120 triangles, 84×84×28mm):
- **0.05mm step**: 4.8M points, ~280 seconds (not practical for interactive use)
- **0.1mm step**: 1.2M points, ~20 seconds
- **0.5mm step**: 48K points, ~0.8 seconds ✓ **recommended**
- **1.0mm step**: 12K points, ~0.2 seconds

Browser WASM is approximately 1.5× slower than native C compilation.

## File Structure

```
/
├── index.html          - Main HTML page with drag/drop interface
├── app.js              - Three.js scene setup and main application logic
├── worker.js           - Web Worker for STL processing
├── mesh-converter.c    - C source for mesh conversion algorithm
├── mesh-converter.wasm - Compiled WebAssembly module
├── style.css           - Application styling
├── test-converter.c    - Native C test program
├── test-wasm.js        - Node.js WASM test program
├── README.md           - This file (project documentation)
└── QUICKSTART.md       - Quick start and testing guide
```

## WebAssembly Interface

### C Function Signature
```c
// Converts triangle mesh to point cloud via XY rastering
// Parameters:
//   - triangles: flat array of triangle vertices (x,y,z for each vertex)
//   - triangle_count: number of triangles
//   - step_size: XY raster step in mm (e.g., 0.05)
//   - out_point_count: pointer to store resulting point count
// Returns: pointer to flat array of point positions
float* convert_to_point_mesh(float* triangles, int triangle_count, float step_size, int* out_point_count);
```

## Development Notes

### WASM Compilation

Requires [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) to be installed.

```bash
# Compile C to WASM with standalone mode
emcc mesh-converter.c -o mesh-converter.wasm \
  -s WASM=1 \
  -s STANDALONE_WASM \
  -s EXPORTED_FUNCTIONS='["_convert_to_point_mesh","_get_bounds","_free_output","_malloc","_free"]' \
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

Two test programs are available for validation:

**Native C test:**
```bash
gcc test-converter.c -o test-converter -lm -O2
./test-converter inner.stl 0.05
```

**WASM test (Node.js):**
```bash
node test-wasm.js
```

Both tests validate the algorithm and WASM integration without requiring a browser. See QUICKSTART.md for more details.

## Future Enhancements
- [ ] Adjustable step size via UI
- [ ] **Spatial acceleration structures** (BVH, octree, or uniform grid) to reduce O(n×m) to O(n×log(m))
- [ ] Progressive rendering (start coarse, refine over time)
- [ ] Multiple rastering strategies (adaptive sampling, importance sampling)
- [ ] Export point cloud formats
- [ ] Support for other 3D file formats
- [ ] JS-owned memory buffers to avoid copies and enable shared buffers with Three.js
