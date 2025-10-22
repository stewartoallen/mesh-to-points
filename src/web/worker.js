// Web Worker for STL processing and WASM mesh conversion

let meshWasm = null;
let meshMemory = null;
let toolpathWasmV1 = null;
let toolpathMemoryV1 = null;
let toolpathWasmV2 = null;
let toolpathMemoryV2 = null;

// Default generator version (can be overridden by message)
let defaultGeneratorVersion = 'v2';

// Initialize WASM modules
async function initWasm() {
    if (meshWasm && toolpathWasmV1 && toolpathWasmV2) return;

    try {
        // Load mesh converter WASM
        const meshResponse = await fetch('mesh-converter.wasm');
        const meshBinary = await meshResponse.arrayBuffer();

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

        const meshResult = await WebAssembly.instantiate(meshBinary, importObject);
        meshWasm = meshResult.instance;
        meshMemory = meshWasm.exports.memory;

        if (meshWasm.exports._initialize) {
            console.log('Calling mesh WASM _initialize');
            meshWasm.exports._initialize();
        }

        console.log('Mesh WASM loaded:', Object.keys(meshWasm.exports));

        // Load both toolpath generator WASM files (v1 and v2)
        console.log('Loading toolpath generator v1...');
        const toolpathV1Response = await fetch('toolpath-generator.wasm');
        const toolpathV1Binary = await toolpathV1Response.arrayBuffer();
        const toolpathV1Result = await WebAssembly.instantiate(toolpathV1Binary, importObject);
        toolpathWasmV1 = toolpathV1Result.instance;
        toolpathMemoryV1 = toolpathWasmV1.exports.memory;

        if (toolpathWasmV1.exports._initialize) {
            toolpathWasmV1.exports._initialize();
        }

        console.log('Toolpath V1 WASM loaded');

        console.log('Loading toolpath generator v2...');
        const toolpathV2Response = await fetch('toolpath-generator-v2.wasm');
        const toolpathV2Binary = await toolpathV2Response.arrayBuffer();
        const toolpathV2Result = await WebAssembly.instantiate(toolpathV2Binary, importObject);
        toolpathWasmV2 = toolpathV2Result.instance;
        toolpathMemoryV2 = toolpathWasmV2.exports.memory;

        if (toolpathWasmV2.exports._initialize) {
            toolpathWasmV2.exports._initialize();
        }

        console.log('Toolpath V2 WASM loaded');

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
function convertMesh(positions, triangleCount, stepSize, filterMode) {
    console.log('convertMesh: start, filterMode:', filterMode);
    if (!meshWasm) {
        throw new Error('WASM module not initialized');
    }

    // Allocate memory for input triangles
    const inputSize = positions.length * 4; // 4 bytes per float
    const inputPtr = meshWasm.exports.malloc(inputSize);

    // Copy input data to WASM memory
    const inputArray = new Float32Array(meshMemory.buffer, inputPtr, positions.length);
    inputArray.set(positions);

    // Allocate memory for output count
    const countPtr = meshWasm.exports.malloc(4); // int = 4 bytes

    // Call conversion function

    const startTime = performance.now();
    const outputPtr = meshWasm.exports.convert_to_point_mesh(
        inputPtr,
        triangleCount,
        stepSize,
        countPtr,
        filterMode
    );
    const elapsed = performance.now() - startTime;

    // Read output count
    const countArray = new Int32Array(meshMemory.buffer, countPtr, 1);
    const pointCount = countArray[0];

    // Create a view of the output data and copy it for transfer
    const outputPositions = new Float32Array(meshMemory.buffer, outputPtr, pointCount * 3);
    const result = new Float32Array(outputPositions);

    // Get bounding box
    const boundsPtr = meshWasm.exports.malloc(24); // 6 floats * 4 bytes
    meshWasm.exports.get_bounds(boundsPtr);
    const boundsArray = new Float32Array(meshMemory.buffer, boundsPtr, 6);
    const bounds = {
        min: { x: boundsArray[0], y: boundsArray[1], z: boundsArray[2] },
        max: { x: boundsArray[3], y: boundsArray[4], z: boundsArray[5] }
    };

    // Free allocated memory
    meshWasm.exports.free(inputPtr);
    meshWasm.exports.free(countPtr);
    meshWasm.exports.free(boundsPtr);
    // Note: output array is freed by free_output() or next conversion

    return { positions: result, pointCount, bounds };
}

// Generate toolpath using toolpath WASM (v2 - height map based)
function generateToolpathV2(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep) {
    const startTime = performance.now();

    // Allocate and copy terrain points
    const terrainSize = terrainPoints.length * 4;
    const terrainPtr = toolpathWasmV2.exports.malloc(terrainSize);
    const terrainArray = new Float32Array(toolpathMemoryV2.buffer, terrainPtr, terrainPoints.length);
    terrainArray.set(terrainPoints);

    // Allocate and copy tool points
    const toolSize = toolPoints.length * 4;
    const toolPtr = toolpathWasmV2.exports.malloc(toolSize);
    const toolArray = new Float32Array(toolpathMemoryV2.buffer, toolPtr, toolPoints.length);
    toolArray.set(toolPoints);

    // Create terrain height map
    const terrainPointCount = terrainPoints.length / 3;
    const terrainMapPtr = toolpathWasmV2.exports.create_terrain_map(terrainPtr, terrainPointCount, gridStep);

    // Create tool height map
    const toolPointCount = toolPoints.length / 3;
    const toolMapPtr = toolpathWasmV2.exports.create_tool_map(toolPtr, toolPointCount, gridStep);

    // Get terrain dimensions for verification
    const terrainDimPtr = toolpathWasmV2.exports.malloc(8);
    toolpathWasmV2.exports.get_map_dimensions(terrainMapPtr, terrainDimPtr, terrainDimPtr + 4);

    // Get tool dimensions for verification
    const toolDimPtr = toolpathWasmV2.exports.malloc(8);
    toolpathWasmV2.exports.get_map_dimensions(toolMapPtr, toolDimPtr, toolDimPtr + 4);

    // Generate toolpath
    const toolpathPtr = toolpathWasmV2.exports.generate_path(
        terrainMapPtr,
        toolMapPtr,
        xStep,
        yStep,
        oobZ
    );

    // Get dimensions
    const dimPtr = toolpathWasmV2.exports.malloc(8); // 2 ints
    toolpathWasmV2.exports.get_path_dimensions(toolpathPtr, dimPtr, dimPtr + 4);
    const dimArray = new Int32Array(toolpathMemoryV2.buffer, dimPtr, 2);
    const numScanlines = dimArray[0];
    const pointsPerLine = dimArray[1];

    // Copy path data
    const pathDataSize = numScanlines * pointsPerLine;
    const pathDataPtr = toolpathWasmV2.exports.malloc(pathDataSize * 4);
    toolpathWasmV2.exports.copy_path_data(toolpathPtr, pathDataPtr);

    const pathData = new Float32Array(toolpathMemoryV2.buffer, pathDataPtr, pathDataSize);
    const result = new Float32Array(pathData);

    const elapsed = performance.now() - startTime;

    // Free memory
    toolpathWasmV2.exports.free(terrainDimPtr);
    toolpathWasmV2.exports.free(toolDimPtr);
    toolpathWasmV2.exports.free(dimPtr);
    toolpathWasmV2.exports.free(pathDataPtr);
    toolpathWasmV2.exports.free_toolpath(toolpathPtr);
    toolpathWasmV2.exports.free_height_map(toolMapPtr);
    toolpathWasmV2.exports.free_height_map(terrainMapPtr);
    toolpathWasmV2.exports.free(toolPtr);
    toolpathWasmV2.exports.free(terrainPtr);

    return {
        pathData: result,
        numScanlines,
        pointsPerLine
    };
}

// Generate toolpath using toolpath WASM (v1 - original)
function generateToolpathV1(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep) {
    console.log('generateToolpathV1: start, gridStep:', gridStep);

    const startTime = performance.now();

    // Allocate and copy terrain points
    const terrainSize = terrainPoints.length * 4;
    const terrainPtr = toolpathWasmV1.exports.malloc(terrainSize);
    const terrainArray = new Float32Array(toolpathMemoryV1.buffer, terrainPtr, terrainPoints.length);
    terrainArray.set(terrainPoints);

    // Allocate and copy tool points
    const toolSize = toolPoints.length * 4;
    const toolPtr = toolpathWasmV1.exports.malloc(toolSize);
    const toolArray = new Float32Array(toolpathMemoryV1.buffer, toolPtr, toolPoints.length);
    toolArray.set(toolPoints);

    // Create terrain grid
    const terrainPointCount = terrainPoints.length / 3;
    const terrainGridPtr = toolpathWasmV1.exports.create_grid(terrainPtr, terrainPointCount);
    console.log('generateToolpathV1: terrain grid created:', terrainGridPtr);

    // Create tool cloud with the actual grid step used
    const toolPointCount = toolPoints.length / 3;
    const toolCloudPtr = toolpathWasmV1.exports.create_tool(toolPtr, toolPointCount, gridStep);
    console.log('generateToolpathV1: tool cloud created:', toolCloudPtr);

    // Generate toolpath
    const toolpathPtr = toolpathWasmV1.exports.generate_path(
        terrainGridPtr,
        toolCloudPtr,
        xStep,
        yStep,
        oobZ
    );
    console.log('generateToolpathV1: toolpath generated:', toolpathPtr);

    // Get dimensions
    const dimPtr = toolpathWasmV1.exports.malloc(8); // 2 ints
    toolpathWasmV1.exports.get_path_dimensions(toolpathPtr, dimPtr, dimPtr + 4);
    const dimArray = new Int32Array(toolpathMemoryV1.buffer, dimPtr, 2);
    const numScanlines = dimArray[0];
    const pointsPerLine = dimArray[1];
    console.log('generateToolpathV1: dimensions:', numScanlines, 'x', pointsPerLine);

    // Copy path data
    const pathDataSize = numScanlines * pointsPerLine;
    const pathDataPtr = toolpathWasmV1.exports.malloc(pathDataSize * 4);
    toolpathWasmV1.exports.copy_path_data(toolpathPtr, pathDataPtr);

    const pathData = new Float32Array(toolpathMemoryV1.buffer, pathDataPtr, pathDataSize);
    const result = new Float32Array(pathData);

    const elapsed = performance.now() - startTime;
    console.log('generateToolpathV1: complete in', elapsed.toFixed(2), 'ms');

    // Free memory
    toolpathWasmV1.exports.free(dimPtr);
    toolpathWasmV1.exports.free(pathDataPtr);
    toolpathWasmV1.exports.free_toolpath(toolpathPtr);
    toolpathWasmV1.exports.free_tool_cloud(toolCloudPtr);
    toolpathWasmV1.exports.free_point_grid(terrainGridPtr);
    toolpathWasmV1.exports.free(toolPtr);
    toolpathWasmV1.exports.free(terrainPtr);

    return {
        pathData: result,
        numScanlines,
        pointsPerLine
    };
}

// Generate toolpath using selected version
function generateToolpath(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, version = 'v2') {
    if (!toolpathWasmV1 || !toolpathWasmV2) {
        throw new Error('Toolpath WASM modules not initialized');
    }

    return version === 'v2'
        ? generateToolpathV2(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep)
        : generateToolpathV1(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep);
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
                const { buffer, stepSize, filterMode } = data;

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
                const conversionStart = performance.now();
                // Default to upward-facing if not specified (for backward compatibility)
                const filter = filterMode !== undefined ? filterMode : 0;
                const result = convertMesh(parsed.positions, parsed.triangleCount, stepSize, filter);
                const conversionTime = performance.now() - conversionStart;
                console.log('Worker: TOTAL conversion took', conversionTime.toFixed(2), 'ms');
                console.log('Worker: conversion complete, point count:', result.pointCount);

                self.postMessage({
                    type: 'conversion-complete',
                    data: result,
                    conversionTime: conversionTime
                }, [result.positions.buffer]); // Transfer ownership

                console.log('Worker: result sent to main thread');

                break;

            case 'generate-toolpath':
                console.log('Worker: generate-toolpath', data);
                const { terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, version } = data;
                const useVersion = version || defaultGeneratorVersion;

                self.postMessage({ type: 'status', message: `Generating toolpath (${useVersion})...` });

                const pathStart = performance.now();
                const pathResult = generateToolpath(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, useVersion);
                const pathTime = performance.now() - pathStart;
                console.log('Worker: toolpath generation took', pathTime.toFixed(2), 'ms using', useVersion);

                self.postMessage({
                    type: 'toolpath-complete',
                    data: pathResult,
                    generationTime: pathTime
                }, [pathResult.pathData.buffer]); // Transfer ownership

                console.log('Worker: toolpath result sent to main thread');
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
