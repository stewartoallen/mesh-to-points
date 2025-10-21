// Web Worker for STL processing and WASM mesh conversion

let wasmModule = null;
let wasmMemory = null;

// Initialize WASM module
async function initWasm() {
    if (wasmModule) return;

    try {
        const response = await fetch('mesh-converter.wasm');
        const wasmBinary = await response.arrayBuffer();

        // Let WASM create its own memory (don't provide one)
        const importObject = {
            env: {
                emscripten_notify_memory_growth: (index) => {
                    // Called when memory grows
                },
                emscripten_resize_heap: (size) => {
                    // Handle memory growth if needed
                    return false;
                }
            },
            wasi_snapshot_preview1: {
                // Stub WASI functions if needed
                proc_exit: () => {},
                fd_close: () => 0,
                fd_write: () => 0,
                fd_read: () => 0,
                fd_seek: () => 0
            }
        };

        const result = await WebAssembly.instantiate(wasmBinary, importObject);
        wasmModule = result.instance;

        // Use the memory exported by WASM
        wasmMemory = wasmModule.exports.memory;

        // Initialize WASM if needed
        if (wasmModule.exports._initialize) {
            console.log('Calling WASM _initialize');
            wasmModule.exports._initialize();
        }

        console.log('WASM exports:', Object.keys(wasmModule.exports));

        self.postMessage({ type: 'wasm-ready' });
    } catch (error) {
        self.postMessage({
            type: 'error',
            message: 'Failed to load WASM: ' + error.message
        });
    }
}

// Parse binary STL file
function parseBinarySTL(buffer) {
    const dataView = new DataView(buffer);
    const numTriangles = dataView.getUint32(80, true); // Little endian

    const positions = new Float32Array(numTriangles * 9); // 3 vertices * 3 coords per triangle

    let offset = 84; // Header (80) + triangle count (4)

    for (let i = 0; i < numTriangles; i++) {
        // Skip normal (12 bytes)
        offset += 12;

        // Read 3 vertices (9 floats)
        for (let j = 0; j < 9; j++) {
            positions[i * 9 + j] = dataView.getFloat32(offset, true);
            offset += 4;
        }

        // Skip attribute byte count (2 bytes)
        offset += 2;
    }

    return { positions, triangleCount: numTriangles };
}

// Parse ASCII STL file
function parseASCIISTL(text) {
    const positions = [];
    const lines = text.split('\n');

    let inFacet = false;
    const vertices = [];

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('facet')) {
            inFacet = true;
            vertices.length = 0;
        } else if (trimmed.startsWith('vertex')) {
            if (inFacet) {
                const parts = trimmed.split(/\s+/);
                vertices.push(
                    parseFloat(parts[1]),
                    parseFloat(parts[2]),
                    parseFloat(parts[3])
                );
            }
        } else if (trimmed.startsWith('endfacet')) {
            if (vertices.length === 9) {
                positions.push(...vertices);
            }
            inFacet = false;
        }
    }

    return {
        positions: new Float32Array(positions),
        triangleCount: positions.length / 9
    };
}

// Convert mesh using WASM
function convertMesh(positions, triangleCount, stepSize) {
    console.log('convertMesh: start');
    if (!wasmModule) {
        throw new Error('WASM module not initialized');
    }

    // Allocate memory for input triangles
    const inputSize = positions.length * 4; // 4 bytes per float
    console.log('convertMesh: allocating', inputSize, 'bytes');
    const inputPtr = wasmModule.exports.malloc(inputSize);
    console.log('convertMesh: input pointer:', inputPtr);

    // Copy input data to WASM memory
    console.log('convertMesh: copying data to WASM memory');
    const inputArray = new Float32Array(wasmMemory.buffer, inputPtr, positions.length);
    inputArray.set(positions);
    console.log('convertMesh: data copied');

    // Allocate memory for output count
    const countPtr = wasmModule.exports.malloc(4); // int = 4 bytes
    console.log('convertMesh: count pointer:', countPtr);

    // Call conversion function
    console.log('convertMesh: calling WASM convert_to_point_mesh...');
    console.log('convertMesh: function exists?', typeof wasmModule.exports.convert_to_point_mesh);
    console.log('convertMesh: parameters:', { inputPtr, triangleCount, stepSize, countPtr });

    const startTime = performance.now();
    const outputPtr = wasmModule.exports.convert_to_point_mesh(
        inputPtr,
        triangleCount,
        stepSize,
        countPtr
    );
    const elapsed = performance.now() - startTime;
    console.log('convertMesh: WASM returned after', elapsed, 'ms, output pointer:', outputPtr);

    // Read output count
    const countArray = new Int32Array(wasmMemory.buffer, countPtr, 1);
    const pointCount = countArray[0];
    console.log('convertMesh: point count:', pointCount);

    // Create a view of the output data (no copy needed!)
    // But we need to copy it because we'll transfer it to main thread and free the WASM memory
    const outputPositions = new Float32Array(wasmMemory.buffer, outputPtr, pointCount * 3);
    console.log('convertMesh: creating result array, size:', pointCount * 3);
    const copyStart = performance.now();
    const result = new Float32Array(outputPositions);
    const copyTime = performance.now() - copyStart;
    console.log('convertMesh: array copy took', copyTime, 'ms');

    // Get bounding box
    const boundsPtr = wasmModule.exports.malloc(24); // 6 floats * 4 bytes
    wasmModule.exports.get_bounds(boundsPtr);
    const boundsArray = new Float32Array(wasmMemory.buffer, boundsPtr, 6);
    const bounds = {
        min: { x: boundsArray[0], y: boundsArray[1], z: boundsArray[2] },
        max: { x: boundsArray[3], y: boundsArray[4], z: boundsArray[5] }
    };

    // Free allocated memory
    wasmModule.exports.free(inputPtr);
    wasmModule.exports.free(countPtr);
    wasmModule.exports.free(boundsPtr);
    // Note: output array is freed by free_output() or next conversion

    return { positions: result, pointCount, bounds };
}

// Handle messages from main thread
self.onmessage = async function(e) {
    console.log('Worker received message:', e.data.type);
    const { type, data } = e.data;

    try {
        switch (type) {
            case 'init':
                console.log('Worker: init');
                await initWasm();
                break;

            case 'process-stl':
                console.log('Worker: process-stl', data);
                const { buffer, stepSize } = data;

                console.log('Worker: parsing STL, buffer size:', buffer?.byteLength);
                self.postMessage({ type: 'status', message: 'Parsing STL...' });

                // Determine if binary or ASCII
                let parsed;
                const view = new Uint8Array(buffer);
                const header = String.fromCharCode(...view.slice(0, 5));

                if (header === 'solid') {
                    // Likely ASCII (but could be binary with "solid" in header)
                    const text = new TextDecoder().decode(buffer);
                    if (text.includes('facet') && text.includes('vertex')) {
                        parsed = parseASCIISTL(text);
                    } else {
                        parsed = parseBinarySTL(buffer);
                    }
                } else {
                    parsed = parseBinarySTL(buffer);
                }

                console.log('Worker: parsed triangles:', parsed.triangleCount);
                self.postMessage({
                    type: 'status',
                    message: `Converting ${parsed.triangleCount} triangles...`
                });

                console.log('Worker: calling convertMesh');
                const result = convertMesh(parsed.positions, parsed.triangleCount, stepSize);
                console.log('Worker: conversion complete, point count:', result.pointCount);

                self.postMessage({
                    type: 'conversion-complete',
                    data: result
                }, [result.positions.buffer]); // Transfer ownership

                console.log('Worker: result sent to main thread');

                break;

            default:
                self.postMessage({
                    type: 'error',
                    message: 'Unknown message type: ' + type
                });
        }
    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({
            type: 'error',
            message: error.message,
            stack: error.stack
        });
    }
};

// Initialize on load
initWasm();
