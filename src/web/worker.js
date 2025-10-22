// Web Worker for STL processing and WASM mesh conversion

let meshWasm = null;
let meshMemory = null;
let toolpathWasm = null;
let toolpathMemory = null;

// Initialize WASM modules
async function initWasm() {
    if (meshWasm && toolpathWasm) return;

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

        // Load toolpath generator WASM
        const toolpathResponse = await fetch('toolpath-generator.wasm');
        const toolpathBinary = await toolpathResponse.arrayBuffer();

        const toolpathResult = await WebAssembly.instantiate(toolpathBinary, importObject);
        toolpathWasm = toolpathResult.instance;
        toolpathMemory = toolpathWasm.exports.memory;

        if (toolpathWasm.exports._initialize) {
            console.log('Calling toolpath WASM _initialize');
            toolpathWasm.exports._initialize();
        }

        console.log('Toolpath WASM loaded:', Object.keys(toolpathWasm.exports));

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
    console.log('convertMesh: allocating', inputSize, 'bytes');
    const inputPtr = meshWasm.exports.malloc(inputSize);
    console.log('convertMesh: input pointer:', inputPtr);

    // Copy input data to WASM memory
    console.log('convertMesh: copying data to WASM memory');
    const inputArray = new Float32Array(meshMemory.buffer, inputPtr, positions.length);
    inputArray.set(positions);
    console.log('convertMesh: data copied');

    // Allocate memory for output count
    const countPtr = meshWasm.exports.malloc(4); // int = 4 bytes
    console.log('convertMesh: count pointer:', countPtr);

    // Call conversion function
    console.log('convertMesh: calling WASM convert_to_point_mesh...');

    const startTime = performance.now();
    const outputPtr = meshWasm.exports.convert_to_point_mesh(
        inputPtr,
        triangleCount,
        stepSize,
        countPtr,
        filterMode
    );
    const elapsed = performance.now() - startTime;
    console.log('convertMesh: WASM returned after', elapsed, 'ms, output pointer:', outputPtr);

    // Read output count
    const countArray = new Int32Array(meshMemory.buffer, countPtr, 1);
    const pointCount = countArray[0];
    console.log('convertMesh: point count:', pointCount);

    // Create a view of the output data (no copy needed!)
    // But we need to copy it because we'll transfer it to main thread and free the WASM memory
    const outputPositions = new Float32Array(meshMemory.buffer, outputPtr, pointCount * 3);
    console.log('convertMesh: creating result array, size:', pointCount * 3);
    const copyStart = performance.now();
    const result = new Float32Array(outputPositions);
    const copyTime = performance.now() - copyStart;
    console.log('convertMesh: array copy took', copyTime, 'ms');

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

// Generate toolpath using toolpath WASM
function generateToolpath(terrainPoints, toolPoints, xStep, yStep, oobZ) {
    console.log('generateToolpath: start');
    if (!toolpathWasm) {
        throw new Error('Toolpath WASM module not initialized');
    }

    const startTime = performance.now();

    // Allocate and copy terrain points
    const terrainSize = terrainPoints.length * 4;
    const terrainPtr = toolpathWasm.exports.malloc(terrainSize);
    const terrainArray = new Float32Array(toolpathMemory.buffer, terrainPtr, terrainPoints.length);
    terrainArray.set(terrainPoints);

    // Allocate and copy tool points
    const toolSize = toolPoints.length * 4;
    const toolPtr = toolpathWasm.exports.malloc(toolSize);
    const toolArray = new Float32Array(toolpathMemory.buffer, toolPtr, toolPoints.length);
    toolArray.set(toolPoints);

    // Create terrain grid
    const terrainPointCount = terrainPoints.length / 3;
    const terrainGridPtr = toolpathWasm.exports.create_grid(terrainPtr, terrainPointCount);
    console.log('generateToolpath: terrain grid created:', terrainGridPtr);

    // Create tool cloud (grid step = 0.5mm for now, should match terrain)
    const toolPointCount = toolPoints.length / 3;
    const toolCloudPtr = toolpathWasm.exports.create_tool(toolPtr, toolPointCount, 0.5);
    console.log('generateToolpath: tool cloud created:', toolCloudPtr);

    // Generate toolpath
    const toolpathPtr = toolpathWasm.exports.generate_path(
        terrainGridPtr,
        toolCloudPtr,
        xStep,
        yStep,
        oobZ
    );
    console.log('generateToolpath: toolpath generated:', toolpathPtr);

    // Get dimensions
    const dimPtr = toolpathWasm.exports.malloc(8); // 2 ints
    toolpathWasm.exports.get_path_dimensions(toolpathPtr, dimPtr, dimPtr + 4);
    const dimArray = new Int32Array(toolpathMemory.buffer, dimPtr, 2);
    const numScanlines = dimArray[0];
    const pointsPerLine = dimArray[1];
    console.log('generateToolpath: dimensions:', numScanlines, 'x', pointsPerLine);

    // Copy path data
    const pathDataSize = numScanlines * pointsPerLine;
    const pathDataPtr = toolpathWasm.exports.malloc(pathDataSize * 4);
    toolpathWasm.exports.copy_path_data(toolpathPtr, pathDataPtr);

    const pathData = new Float32Array(toolpathMemory.buffer, pathDataPtr, pathDataSize);
    const result = new Float32Array(pathData);

    const elapsed = performance.now() - startTime;
    console.log('generateToolpath: complete in', elapsed.toFixed(2), 'ms');

    // Free memory
    toolpathWasm.exports.free(dimPtr);
    toolpathWasm.exports.free(pathDataPtr);
    toolpathWasm.exports.free_toolpath(toolpathPtr);
    toolpathWasm.exports.free_tool_cloud(toolCloudPtr);
    toolpathWasm.exports.free_point_grid(terrainGridPtr);
    toolpathWasm.exports.free(toolPtr);
    toolpathWasm.exports.free(terrainPtr);

    return {
        pathData: result,
        numScanlines,
        pointsPerLine
    };
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
                    data: result
                }, [result.positions.buffer]); // Transfer ownership

                console.log('Worker: result sent to main thread');

                break;

            case 'generate-toolpath':
                console.log('Worker: generate-toolpath', data);
                const { terrainPoints, toolPoints, xStep, yStep, oobZ } = data;

                self.postMessage({ type: 'status', message: 'Generating toolpath...' });

                const pathStart = performance.now();
                const pathResult = generateToolpath(terrainPoints, toolPoints, xStep, yStep, oobZ);
                const pathTime = performance.now() - pathStart;
                console.log('Worker: toolpath generation took', pathTime.toFixed(2), 'ms');

                self.postMessage({
                    type: 'toolpath-complete',
                    data: pathResult
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
