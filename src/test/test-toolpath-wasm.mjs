// test-toolpath-wasm.mjs
// Node.js test for WASM toolpath generator performance

import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';

// Load WASM module
const wasmBinary = readFileSync('build/toolpath-generator.wasm');
const wasmModule = await WebAssembly.instantiate(wasmBinary, {
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
});

const wasm = wasmModule.instance;
const memory = wasm.exports.memory;

console.log('WASM loaded, available exports:', Object.keys(wasm.exports).filter(k => !k.startsWith('_')));

// Parse binary STL
function parseBinarySTL(filename) {
    const buffer = readFileSync(filename);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    const triangleCount = view.getUint32(80, true);
    console.log(`Loading ${triangleCount} triangles from ${filename}`);

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

// Load mesh converter WASM for point conversion
const meshWasmBinary = readFileSync('build/mesh-converter.wasm');
const meshWasmModule = await WebAssembly.instantiate(meshWasmBinary, {
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
});

const meshWasm = meshWasmModule.instance;
const meshMemory = meshWasm.exports.memory;

console.log('\n=== WASM Toolpath Test ===\n');

// Load terrain
const terrainSTL = parseBinarySTL('benchmark/fixtures/terrain.stl');
const stepSize = 0.05;

// Convert terrain to points
let start = performance.now();
const terrainInputSize = terrainSTL.positions.length * 4;
const terrainInputPtr = meshWasm.exports.malloc(terrainInputSize);
const terrainInputArray = new Float32Array(meshMemory.buffer, terrainInputPtr, terrainSTL.positions.length);
terrainInputArray.set(terrainSTL.positions);

const terrainCountPtr = meshWasm.exports.malloc(4);
const terrainPointsPtr = meshWasm.exports.convert_to_point_mesh(
    terrainInputPtr,
    terrainSTL.triangleCount,
    stepSize,
    terrainCountPtr,
    0 // FILTER_UPWARD_FACING
);
const terrainPointCount = new Int32Array(meshMemory.buffer, terrainCountPtr, 1)[0];
const terrainPoints = new Float32Array(meshMemory.buffer, terrainPointsPtr, terrainPointCount * 3);
console.log(`Terrain: ${terrainPointCount} points in ${(performance.now() - start).toFixed(3)}s`);

// Load tool
const toolSTL = parseBinarySTL('benchmark/fixtures/tool.stl');

// Convert tool to points
start = performance.now();
const toolInputSize = toolSTL.positions.length * 4;
const toolInputPtr = meshWasm.exports.malloc(toolInputSize);
const toolInputArray = new Float32Array(meshMemory.buffer, toolInputPtr, toolSTL.positions.length);
toolInputArray.set(toolSTL.positions);

const toolCountPtr = meshWasm.exports.malloc(4);
const toolPointsPtr = meshWasm.exports.convert_to_point_mesh(
    toolInputPtr,
    toolSTL.triangleCount,
    stepSize,
    toolCountPtr,
    1 // FILTER_DOWNWARD_FACING
);
const toolPointCount = new Int32Array(meshMemory.buffer, toolCountPtr, 1)[0];
const toolPoints = new Float32Array(meshMemory.buffer, toolPointsPtr, toolPointCount * 3);
console.log(`Tool: ${toolPointCount} points in ${(performance.now() - start).toFixed(3)}s\n`);

// Copy points to toolpath WASM memory
const terrainSize = terrainPointCount * 3 * 4;
const terrainPtr = wasm.exports.malloc(terrainSize);
const terrainArray = new Float32Array(memory.buffer, terrainPtr, terrainPointCount * 3);
terrainArray.set(terrainPoints);

const toolSize = toolPointCount * 3 * 4;
const toolPtr = wasm.exports.malloc(toolSize);
const toolArray = new Float32Array(memory.buffer, toolPtr, toolPointCount * 3);
toolArray.set(toolPoints);

// Create height maps
console.log('Creating height maps...');
start = performance.now();
const terrainMapPtr = wasm.exports.create_terrain_map(terrainPtr, terrainPointCount, stepSize);
const toolMapPtr = wasm.exports.create_tool_map(toolPtr, toolPointCount, stepSize);
console.log(`Height maps created in ${(performance.now() - start).toFixed(3)}s\n`);

// Generate toolpath
const xStep = 5;
const yStep = 5;
const oobZ = -100.0;

console.log(`Generating toolpath (x_step=${xStep}, y_step=${yStep})...`);
start = performance.now();
const toolpathPtr = wasm.exports.generate_path(terrainMapPtr, toolMapPtr, xStep, yStep, oobZ);
const elapsed = performance.now() - start;

// Check algorithm marker
const algorithmMarker = new Int32Array(memory.buffer, 0x10000, 1)[0];
if (algorithmMarker === -1) {
    console.log('Algorithm: DENSE');
} else {
    console.log(`Algorithm: SPARSE with ${algorithmMarker} tool points`);
}

// Get dimensions
const dimPtr = wasm.exports.malloc(8);
wasm.exports.get_path_dimensions(toolpathPtr, dimPtr, dimPtr + 4);
const dims = new Int32Array(memory.buffer, dimPtr, 2);
const numScanlines = dims[0];
const pointsPerLine = dims[1];

console.log(`\nToolpath: ${pointsPerLine} x ${numScanlines} = ${pointsPerLine * numScanlines} points`);
console.log(`Generation time: ${elapsed.toFixed(3)}ms (${(elapsed / 1000).toFixed(3)}s)`);

// Cleanup
wasm.exports.free_toolpath(toolpathPtr);
wasm.exports.free_height_map(toolMapPtr);
wasm.exports.free_height_map(terrainMapPtr);
wasm.exports.free(toolPtr);
wasm.exports.free(terrainPtr);

console.log('\n=== Test Complete ===');
