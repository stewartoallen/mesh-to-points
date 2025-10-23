// test-backends.mjs
// Command-line test for different toolpath generation backends

import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';

// Load WASM modules
const meshWasmBinary = readFileSync('build/mesh-converter.wasm');
const toolpathWasmBinary = readFileSync('build/toolpath-generator.wasm');

const importObject = {
    env: {
        emscripten_notify_memory_growth: (index) => {},
        emscripten_resize_heap: (size) => false
    },
    wasi_snapshot_preview1: {
        proc_exit: () => {},
        fd_close: () => 0,
        fd_write: () => 0,
        fd_read: () => 0,
        fd_seek: () => 0
    }
};

const meshWasmModule = await WebAssembly.instantiate(meshWasmBinary, importObject);
const meshWasm = meshWasmModule.instance;
const meshMemory = meshWasm.exports.memory;

const toolpathWasmModule = await WebAssembly.instantiate(toolpathWasmBinary, importObject);
const toolpathWasm = toolpathWasmModule.instance;
const toolpathMemory = toolpathWasm.exports.memory;

console.log('✓ WASM modules loaded\n');

// Parse binary STL
function parseBinarySTL(filename) {
    const buffer = readFileSync(filename);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const triangleCount = view.getUint32(80, true);

    const positions = new Float32Array(triangleCount * 9);
    let offset = 84;

    for (let i = 0; i < triangleCount; i++) {
        offset += 12; // Skip normal
        for (let j = 0; j < 9; j++) {
            positions[i * 9 + j] = view.getFloat32(offset, true);
            offset += 4;
        }
        offset += 2; // Skip attribute
    }

    return { positions, triangleCount };
}

// Convert mesh using WASM
function convertMesh(positions, triangleCount, stepSize, filterMode) {
    const inputSize = positions.length * 4;
    const inputPtr = meshWasm.exports.malloc(inputSize);
    const inputArray = new Float32Array(meshMemory.buffer, inputPtr, positions.length);
    inputArray.set(positions);

    const countPtr = meshWasm.exports.malloc(4);
    const outputPtr = meshWasm.exports.convert_to_point_mesh(
        inputPtr, triangleCount, stepSize, countPtr, filterMode
    );

    const pointCount = new Int32Array(meshMemory.buffer, countPtr, 1)[0];
    const outputPositions = new Float32Array(meshMemory.buffer, outputPtr, pointCount * 3);
    const result = new Float32Array(outputPositions);

    meshWasm.exports.free(inputPtr);
    meshWasm.exports.free(countPtr);

    return { positions: result, pointCount };
}

// Generate toolpath (single-threaded WASM)
function generateToolpathSingle(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep) {
    const t0 = performance.now();

    // Setup terrain
    const terrainSize = terrainPoints.length * 4;
    const terrainPtr = toolpathWasm.exports.malloc(terrainSize);
    new Float32Array(toolpathMemory.buffer, terrainPtr, terrainPoints.length).set(terrainPoints);

    const terrainPointCount = terrainPoints.length / 3;
    const terrainMapPtr = toolpathWasm.exports.create_terrain_map(terrainPtr, terrainPointCount, gridStep);

    // Setup tool
    const toolSize = toolPoints.length * 4;
    const toolPtr = toolpathWasm.exports.malloc(toolSize);
    new Float32Array(toolpathMemory.buffer, toolPtr, toolPoints.length).set(toolPoints);

    const toolPointCount = toolPoints.length / 3;
    const toolMapPtr = toolpathWasm.exports.create_tool_map(toolPtr, toolPointCount, gridStep);

    // Get dimensions
    const terrainDimPtr = toolpathWasm.exports.malloc(8);
    toolpathWasm.exports.get_map_dimensions(terrainMapPtr, terrainDimPtr, terrainDimPtr + 4);
    const terrainDims = new Int32Array(toolpathMemory.buffer, terrainDimPtr, 2);
    const terrainWidth = terrainDims[0];
    const terrainHeight = terrainDims[1];

    const toolDimPtr = toolpathWasm.exports.malloc(8);
    toolpathWasm.exports.get_map_dimensions(toolMapPtr, toolDimPtr, toolDimPtr + 4);
    const toolDims = new Int32Array(toolpathMemory.buffer, toolDimPtr, 2);
    const toolWidth = toolDims[0];
    const toolHeight = toolDims[1];

    const t1 = performance.now();

    // Generate full toolpath (using partial with 0 to 999999)
    const toolpathPtr = toolpathWasm.exports.generate_path_partial(
        terrainMapPtr, toolMapPtr, xStep, yStep, oobZ, 0, 999999
    );

    const t2 = performance.now();

    // Get sparse tool count
    const sparseToolCount = toolpathWasm.exports.get_sparse_tool_count();
    const toolDenseSize = toolWidth * toolHeight;
    const sparsityRatio = ((1 - sparseToolCount / toolDenseSize) * 100).toFixed(1);

    // Get dimensions and copy data
    const dimPtr = toolpathWasm.exports.malloc(8);
    toolpathWasm.exports.get_path_dimensions(toolpathPtr, dimPtr, dimPtr + 4);
    const dims = new Int32Array(toolpathMemory.buffer, dimPtr, 2);
    const numScanlines = dims[0];
    const pointsPerLine = dims[1];

    const pathDataSize = numScanlines * pointsPerLine;
    const pathDataPtr = toolpathWasm.exports.malloc(pathDataSize * 4);
    toolpathWasm.exports.copy_path_data(toolpathPtr, pathDataPtr);
    const result = new Float32Array(new Float32Array(toolpathMemory.buffer, pathDataPtr, pathDataSize));

    const t3 = performance.now();

    // Cleanup
    toolpathWasm.exports.free(terrainDimPtr);
    toolpathWasm.exports.free(toolDimPtr);
    toolpathWasm.exports.free(dimPtr);
    toolpathWasm.exports.free(pathDataPtr);
    toolpathWasm.exports.free_toolpath(toolpathPtr);
    toolpathWasm.exports.free_height_map(toolMapPtr);
    toolpathWasm.exports.free_height_map(terrainMapPtr);
    toolpathWasm.exports.free(toolPtr);
    toolpathWasm.exports.free(terrainPtr);

    console.log(`🔨 [WASM Single]`);
    console.log(`  Terrain: ${terrainWidth}x${terrainHeight}`);
    console.log(`  Tool: ${toolWidth}x${toolHeight} (dense: ${toolDenseSize})`);
    console.log(`  Sparse tool: ${sparseToolCount} records (${sparsityRatio}% sparse)`);
    console.log(`  Output: ${pointsPerLine}x${numScanlines}`);
    console.log(`  Setup: ${(t1-t0).toFixed(1)}ms`);
    console.log(`  Generate: ${(t2-t1).toFixed(1)}ms`);
    console.log(`  Copy: ${(t3-t2).toFixed(1)}ms`);
    console.log(`  Total: ${(t3-t0).toFixed(1)}ms`);

    return { pathData: result, numScanlines, pointsPerLine, totalTime: t3-t0 };
}

// Simulate WebGPU data preparation (can't actually run GPU compute in Node)
function simulateWebGPUPrep(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep) {
    const t0 = performance.now();

    // Find terrain bounds
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    const terrainPointCount = terrainPoints.length / 3;

    for (let i = 0; i < terrainPointCount; i++) {
        const x = terrainPoints[i * 3 + 0];
        const y = terrainPoints[i * 3 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    const terrainWidth = Math.round((maxX - minX) / gridStep) + 1;
    const terrainHeight = Math.round((maxY - minY) / gridStep) + 1;
    const terrainGridSize = terrainWidth * terrainHeight;

    // Create terrain grid
    const terrainGrid = new Float32Array(terrainGridSize);
    terrainGrid.fill(NaN);

    for (let i = 0; i < terrainPointCount; i++) {
        const x = terrainPoints[i * 3 + 0];
        const y = terrainPoints[i * 3 + 1];
        const z = terrainPoints[i * 3 + 2];

        const gx = Math.round((x - minX) / gridStep);
        const gy = Math.round((y - minY) / gridStep);

        if (gx >= 0 && gx < terrainWidth && gy >= 0 && gy < terrainHeight) {
            const idx = gy * terrainWidth + gx;
            if (isNaN(terrainGrid[idx]) || z > terrainGrid[idx]) {
                terrainGrid[idx] = z;
            }
        }
    }

    const t1 = performance.now();

    // Find tool bounds and create sparse representation
    minX = Infinity; maxX = -Infinity;
    minY = Infinity; maxY = -Infinity;
    const toolPointCount = toolPoints.length / 3;

    for (let i = 0; i < toolPointCount; i++) {
        const x = toolPoints[i * 3 + 0];
        const y = toolPoints[i * 3 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    const toolWidth = Math.round((maxX - minX) / gridStep) + 1;
    const toolHeight = Math.round((maxY - minY) / gridStep) + 1;
    const centerX = Math.floor(toolWidth / 2);
    const centerY = Math.floor(toolHeight / 2);

    // Create sparse tool
    const tempGrid = new Map();
    for (let i = 0; i < toolPointCount; i++) {
        const x = toolPoints[i * 3 + 0];
        const y = toolPoints[i * 3 + 1];
        const z = toolPoints[i * 3 + 2];

        const gx = Math.round((x - minX) / gridStep);
        const gy = Math.round((y - minY) / gridStep);

        if (gx >= 0 && gx < toolWidth && gy >= 0 && gy < toolHeight) {
            const key = `${gx},${gy}`;
            if (!tempGrid.has(key) || z > tempGrid.get(key)) {
                tempGrid.set(key, z);
            }
        }
    }

    const sparseCount = tempGrid.size;
    const sparseData = new Float32Array(sparseCount * 3);

    let idx = 0;
    for (const [key, z] of tempGrid.entries()) {
        const [gx, gy] = key.split(',').map(Number);
        sparseData[idx * 3 + 0] = gx - centerX; // x_offset
        sparseData[idx * 3 + 1] = gy - centerY; // y_offset
        sparseData[idx * 3 + 2] = z; // z_value
        idx++;
    }

    const t2 = performance.now();

    // Calculate output dimensions
    const pointsPerLine = Math.ceil(terrainWidth / xStep);
    const numScanlines = Math.ceil(terrainHeight / yStep);
    const outputSize = pointsPerLine * numScanlines;

    const toolDenseSize = toolWidth * toolHeight;
    const sparsityRatio = ((1 - sparseCount / toolDenseSize) * 100).toFixed(1);

    console.log(`🎮 [WebGPU Prep Simulation]`);
    console.log(`  Terrain: ${terrainWidth}x${terrainHeight} (${terrainGridSize} cells)`);
    console.log(`  Tool: ${toolWidth}x${toolHeight} (dense: ${toolDenseSize})`);
    console.log(`  Sparse tool: ${sparseCount} records (${sparsityRatio}% sparse)`);
    console.log(`  Output: ${pointsPerLine}x${numScanlines} (${outputSize} points)`);
    console.log(`  Terrain prep: ${(t1-t0).toFixed(1)}ms`);
    console.log(`  Tool prep: ${(t2-t1).toFixed(1)}ms`);
    console.log(`  Total prep: ${(t2-t0).toFixed(1)}ms`);
    console.log(`  Note: GPU compute would run after this (not available in Node)`);

    return { terrainGrid, sparseData, sparseCount, pointsPerLine, numScanlines };
}

// Main test
console.log('=== Backend Comparison Test ===\n');

const stepSize = 0.05;
const xStep = 5;
const yStep = 5;
const oobZ = -100.0;

// Load and convert terrain
console.log('Loading terrain...');
const terrainSTL = parseBinarySTL('benchmark/fixtures/terrain.stl');
const terrainResult = convertMesh(terrainSTL.positions, terrainSTL.triangleCount, stepSize, 0);
console.log(`✓ Terrain: ${terrainResult.pointCount} points\n`);

// Load and convert tool
console.log('Loading tool...');
const toolSTL = parseBinarySTL('benchmark/fixtures/tool.stl');
const toolResult = convertMesh(toolSTL.positions, toolSTL.triangleCount, stepSize, 1);
console.log(`✓ Tool: ${toolResult.pointCount} points\n`);

// Test 1: Single-threaded WASM
console.log('--- Test 1: Single-threaded WASM ---');
const wasmResult = generateToolpathSingle(
    terrainResult.positions, toolResult.positions, xStep, yStep, oobZ, stepSize
);
console.log('');

// Test 2: WebGPU data prep simulation
console.log('--- Test 2: WebGPU Data Prep (Simulation) ---');
const webgpuPrep = simulateWebGPUPrep(
    terrainResult.positions, toolResult.positions, xStep, yStep, oobZ, stepSize
);
console.log('');

// Summary
console.log('=== Summary ===');
console.log(`WASM Single: ${wasmResult.totalTime.toFixed(1)}ms`);
console.log(`WebGPU Prep: ${(webgpuPrep.terrainGrid ? 'Ready' : 'Failed')} (GPU compute not available in Node)`);
console.log('');
console.log('To test WebGPU compute performance, use the browser at build/index.html');
console.log('Expected WebGPU speedup: 10-20x faster than WASM single');
