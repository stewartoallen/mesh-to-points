# Quick Start Guide

Get the STL to Point Mesh Converter running in minutes.

## Prerequisites

- **Modern Chrome browser** (or any Chromium-based browser)
- **Node.js** (for running the local server)
- **STL file** for testing

## Running the Application

### 1. Start Local Server

From the project directory, run:

```bash
npx serve
```

This will start a local web server (typically on port 3000 or 5000).

**Note:** We prefer Node-based tools like `npx serve` over Python's `http.server` for this project.

### 2. Open in Browser

Navigate to the URL shown in the terminal, usually:
```
http://localhost:3000
```

or

```
http://localhost:5000
```

### 3. Load an STL File

You have two options:

- **Drag & Drop**: Drag an STL file onto the drop zone in the center of the screen
- **Click to Browse**: Click the drop zone to open a file picker

### 4. View the Result

Once processed:
- The point cloud will render in the 3D viewport
- An info panel appears in the top-right showing:
  - **Status**: Current processing state
  - **Points**: Number of points generated
  - **Bounds**: Bounding box dimensions

## Controls

- **Orbit**: Left-click and drag
- **Pan**: Right-click and drag
- **Zoom**: Scroll wheel

## What to Expect

The conversion process:
1. Parses the STL file (binary or ASCII format)
2. Sends triangle data to Web Worker
3. WASM module performs XY rastering with 0.05mm step size
4. Casts rays through Z-axis to find surface intersections
5. Displays resulting point cloud

Processing time depends on:
- STL file size (number of triangles)
- Model dimensions (affects raster grid size)
- Your CPU performance

## Test Files

For testing, you can:
- Use any existing STL file you have
- Download free STL models from [Thingiverse](https://www.thingiverse.com/)
- Generate test geometry from CAD software

Start with smaller models (< 10,000 triangles) to verify everything works.

## Troubleshooting

### WASM Module Not Loading

**Problem**: Console shows "Failed to load WASM"

**Solution**: Ensure you're using a local server (not opening `index.html` directly). Web Workers and WASM require HTTP/HTTPS protocol.

### No Points Generated

**Problem**: Status shows "Complete" but point count is 0

**Possible causes**:
- STL file may be empty or corrupted
- Model dimensions might be very small or very large
- Check browser console for errors

### Performance Issues

**Problem**: Browser becomes unresponsive during conversion

**Solutions**:
- Try a smaller STL file
- Check model triangle count (smaller is faster)
- The Web Worker should keep UI responsive, but very large models take time

### CORS Errors

**Problem**: Console shows cross-origin errors

**Solution**: Make sure you're running through the local server (`npx serve`), not opening the file directly in the browser.

## Development Workflow

If you're modifying the code:

1. **Edit C code** (`mesh-converter.c`)
2. **Test natively** (optional but recommended):
   ```bash
   gcc test-converter.c -o test-converter -lm -O2
   ./test-converter inner.stl 0.05
   ```
3. **Recompile WASM**:
   ```bash
   emcc mesh-converter.c -o mesh-converter.wasm \
     -s WASM=1 \
     -s STANDALONE_WASM \
     -s EXPORTED_FUNCTIONS='["_convert_to_point_mesh","_get_bounds","_free_output","_malloc","_free","_test_triangle_data"]' \
     -s ALLOW_MEMORY_GROWTH=1 \
     -O3 \
     --no-entry
   ```
4. **Test WASM** (optional but recommended):
   ```bash
   node test-wasm.js
   ```
5. **Refresh browser** (hard refresh with Cmd+Shift+R or Ctrl+Shift+R to clear cache)

For JavaScript/HTML/CSS changes, a simple refresh is sufficient.

## Command-Line Testing

Two test programs are available for debugging without the browser:

### Native C Test (`test-converter.c`)
Tests the algorithm directly without WASM compilation:
```bash
gcc test-converter.c -o test-converter -lm -O2
./test-converter <stl-file> [step-size]
```

Example output:
```
Loading STL file: inner.stl
Step size: 0.050
Binary STL: 6120 triangles
Points generated: 4803032
Bounding box:
  Min: (-42.200, -42.195, 0.000)
  Max: (42.200, 42.195, 28.250)
```

### WASM Test (`test-wasm.js`)
Tests the compiled WASM module using Node.js:
```bash
node test-wasm.js
```

This validates:
- WASM module loads correctly
- Memory is properly allocated
- Data passes correctly between JS and WASM
- Conversion produces expected results

Both tests should produce similar point counts (~4.8M points for inner.stl at 0.05mm step).

## Browser Console

Open Developer Tools (F12 or Cmd+Option+I) to see:
- Status messages
- Processing times
- Any errors or warnings
- WASM module initialization

## Next Steps

- See [README.md](README.md) for detailed technical documentation
- Explore the algorithm parameters in `app.js` (STEP_SIZE constant)
- Check `mesh-converter.c` for the rastering algorithm implementation
- Review future enhancements in README.md

## Notes for Future Development

- **Server preference**: Always use Node-based servers (like `npx serve`) rather than Python-based alternatives
- **Step size**: Currently hardcoded to 0.05mm, but can be made configurable
- **Point cloud format**: Currently displays as cyan points, but colors/sizes can be customized in `app.js`
