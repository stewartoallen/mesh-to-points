// test-parallel.mjs
// Test parallel toolpath generation using worker_threads in Node.js

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

// Generate full toolpath (single-threaded baseline)
function generateToolpathSingle(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep) {
    const t0 = performance.now();

    // Setup
    const terrainSize = terrainPoints.length * 4;
    const terrainPtr = toolpathWasm.exports.malloc(terrainSize);
    new Float32Array(toolpathMemory.buffer, terrainPtr, terrainPoints.length).set(terrainPoints);

    const toolSize = toolPoints.length * 4;
    const toolPtr = toolpathWasm.exports.malloc(toolSize);
    new Float32Array(toolpathMemory.buffer, toolPtr, toolPoints.length).set(toolPoints);

    const terrainPointCount = terrainPoints.length / 3;
    const terrainMapPtr = toolpathWasm.exports.create_terrain_map(terrainPtr, terrainPointCount, gridStep);

    const toolPointCount = toolPoints.length / 3;
    const toolMapPtr = toolpathWasm.exports.create_tool_map(toolPtr, toolPointCount, gridStep);

    const t1 = performance.now();

    // Generate
    const toolpathPtr = toolpathWasm.exports.generate_path(
        terrainMapPtr, toolMapPtr, xStep, yStep, oobZ
    );

    const t2 = performance.now();

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
    toolpathWasm.exports.free(dimPtr);
    toolpathWasm.exports.free(pathDataPtr);
    toolpathWasm.exports.free_toolpath(toolpathPtr);
    toolpathWasm.exports.free_height_map(toolMapPtr);
    toolpathWasm.exports.free_height_map(terrainMapPtr);
    toolpathWasm.exports.free(toolPtr);
    toolpathWasm.exports.free(terrainPtr);

    console.log(`Single-threaded: setup=${(t1-t0).toFixed(1)}ms, generate=${(t2-t1).toFixed(1)}ms, copy=${(t3-t2).toFixed(1)}ms, total=${(t3-t0).toFixed(1)}ms`);

    return { pathData: result, numScanlines, pointsPerLine };
}

// Generate partial toolpath
function generateToolpathPartial(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, startScanline, endScanline) {
    const terrainSize = terrainPoints.length * 4;
    const terrainPtr = toolpathWasm.exports.malloc(terrainSize);
    new Float32Array(toolpathMemory.buffer, terrainPtr, terrainPoints.length).set(terrainPoints);

    const toolSize = toolPoints.length * 4;
    const toolPtr = toolpathWasm.exports.malloc(toolSize);
    new Float32Array(toolpathMemory.buffer, toolPtr, toolPoints.length).set(toolPoints);

    const terrainPointCount = terrainPoints.length / 3;
    const terrainMapPtr = toolpathWasm.exports.create_terrain_map(terrainPtr, terrainPointCount, gridStep);

    const toolPointCount = toolPoints.length / 3;
    const toolMapPtr = toolpathWasm.exports.create_tool_map(toolPtr, toolPointCount, gridStep);

    // Generate partial
    const toolpathPtr = toolpathWasm.exports.generate_path_partial(
        terrainMapPtr, toolMapPtr, xStep, yStep, oobZ, startScanline, endScanline
    );

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

    // Cleanup
    toolpathWasm.exports.free(dimPtr);
    toolpathWasm.exports.free(pathDataPtr);
    toolpathWasm.exports.free_toolpath(toolpathPtr);
    toolpathWasm.exports.free_height_map(toolMapPtr);
    toolpathWasm.exports.free_height_map(terrainMapPtr);
    toolpathWasm.exports.free(toolPtr);
    toolpathWasm.exports.free(terrainPtr);

    return { pathData: result, startScanline, endScanline, numScanlines, pointsPerLine };
}

// Generate using multiple "simulated workers" (sequential but split)
async function generateToolpathParallel(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, numWorkers) {
    const t0 = performance.now();

    // Get terrain dimensions to calculate total scanlines
    const terrainSize = terrainPoints.length * 4;
    const terrainPtr = toolpathWasm.exports.malloc(terrainSize);
    new Float32Array(toolpathMemory.buffer, terrainPtr, terrainPoints.length).set(terrainPoints);

    const terrainPointCount = terrainPoints.length / 3;
    const terrainMapPtr = toolpathWasm.exports.create_terrain_map(terrainPtr, terrainPointCount, gridStep);

    const dimPtr = toolpathWasm.exports.malloc(8);
    toolpathWasm.exports.get_map_dimensions(terrainMapPtr, dimPtr, dimPtr + 4);
    const dims = new Int32Array(toolpathMemory.buffer, dimPtr, 2);
    const terrainWidth = dims[0];
    const terrainHeight = dims[1];

    toolpathWasm.exports.free(dimPtr);
    toolpathWasm.exports.free_height_map(terrainMapPtr);
    toolpathWasm.exports.free(terrainPtr);

    const pointsPerLine = Math.ceil(terrainWidth / xStep);
    const totalScanlines = Math.ceil(terrainHeight / yStep);

    // Split scanlines across workers
    const scanlinesPerWorker = Math.ceil(totalScanlines / numWorkers);
    const ranges = [];
    for (let i = 0; i < numWorkers; i++) {
        const start = i * scanlinesPerWorker;
        const end = Math.min(start + scanlinesPerWorker, totalScanlines);
        if (start < totalScanlines) {
            ranges.push({ start, end });
        }
    }

    console.log(`Splitting ${totalScanlines} scanlines across ${ranges.length} workers:`);
    ranges.forEach((r, i) => console.log(`  Worker ${i}: scanlines ${r.start}-${r.end} (${r.end - r.start} lines)`));

    const t1 = performance.now();

    // Process each range (simulating parallel - in real impl these would run concurrently)
    const results = [];
    for (let i = 0; i < ranges.length; i++) {
        const { start, end } = ranges[i];
        const t2 = performance.now();
        const result = generateToolpathPartial(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, start, end);
        const t3 = performance.now();
        console.log(`  Worker ${i} completed in ${(t3-t2).toFixed(1)}ms`);
        results.push(result);
    }

    const t4 = performance.now();

    // Merge results
    const totalPoints = totalScanlines * pointsPerLine;
    const merged = new Float32Array(totalPoints);

    for (const result of results) {
        const startIdx = result.startScanline * result.pointsPerLine;
        merged.set(result.pathData, startIdx);
    }

    const t5 = performance.now();

    console.log(`Parallel (${numWorkers} workers): setup=${(t1-t0).toFixed(1)}ms, generate=${(t4-t1).toFixed(1)}ms, merge=${(t5-t4).toFixed(1)}ms, total=${(t5-t0).toFixed(1)}ms`);

    return { pathData: merged, numScanlines: totalScanlines, pointsPerLine };
}

// Main test
console.log('=== Parallel Toolpath Generation Test ===\n');

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

// Test single-threaded (baseline)
console.log('--- Single-threaded (baseline) ---');
const singleResult = generateToolpathSingle(
    terrainResult.positions, toolResult.positions, xStep, yStep, oobZ, stepSize
);
console.log(`Output: ${singleResult.pointsPerLine} x ${singleResult.numScanlines} = ${singleResult.pathData.length} points\n`);

// Test with different worker counts
for (const numWorkers of [2, 4, 8]) {
    console.log(`--- Parallel (${numWorkers} workers) ---`);
    const parallelResult = await generateToolpathParallel(
        terrainResult.positions, toolResult.positions, xStep, yStep, oobZ, stepSize, numWorkers
    );
    console.log(`Output: ${parallelResult.pointsPerLine} x ${parallelResult.numScanlines} = ${parallelResult.pathData.length} points`);

    // Verify results match
    let mismatches = 0;
    let maxDiff = 0;
    for (let i = 0; i < singleResult.pathData.length; i++) {
        const diff = Math.abs(singleResult.pathData[i] - parallelResult.pathData[i]);
        if (diff > maxDiff) maxDiff = diff;
        if (diff > 0.001) mismatches++;
    }

    if (mismatches === 0) {
        console.log(`✓ Results match (max diff: ${maxDiff.toFixed(6)})`);
    } else {
        console.log(`✗ ${mismatches} mismatches found (max diff: ${maxDiff.toFixed(6)})`);
    }
    console.log('');
}

console.log('=== Test Complete ===');
