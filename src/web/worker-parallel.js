// worker-parallel.js
// Parallel toolpath generation using multiple workers

let meshWasm = null;
let meshMemory = null;
let toolpathWasm = null;
let toolpathMemory = null;

// Initialize WASM modules
async function initWasm() {
    if (meshWasm && toolpathWasm) return;

    try {
        // Load mesh converter WASM (with cache busting)
        const meshResponse = await fetch('mesh-converter.wasm?v=' + Date.now());
        const meshBinary = await meshResponse.arrayBuffer();
        console.log('Loaded mesh-converter.wasm:', meshBinary.byteLength, 'bytes');

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
            meshWasm.exports._initialize();
        }

        // Load toolpath generator WASM (with cache busting)
        const toolpathResponse = await fetch('toolpath-generator.wasm?v=' + Date.now());
        const toolpathBinary = await toolpathResponse.arrayBuffer();
        console.log('Loaded toolpath-generator.wasm:', toolpathBinary.byteLength, 'bytes');
        const toolpathResult = await WebAssembly.instantiate(toolpathBinary, importObject);
        toolpathWasm = toolpathResult.instance;
        toolpathMemory = toolpathWasm.exports.memory;
        console.log('Toolpath WASM exports:', Object.keys(toolpathWasm.exports));

        if (toolpathWasm.exports._initialize) {
            toolpathWasm.exports._initialize();
        }

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
    const numTriangles = dataView.getUint32(80, true);

    const positions = new Float32Array(numTriangles * 9);
    let offset = 84;

    for (let i = 0; i < numTriangles; i++) {
        offset += 12; // Skip normal

        for (let j = 0; j < 9; j++) {
            positions[i * 9 + j] = dataView.getFloat32(offset, true);
            offset += 4;
        }

        offset += 2; // Skip attribute
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
    if (!meshWasm) {
        throw new Error('WASM module not initialized');
    }

    const inputSize = positions.length * 4;
    const inputPtr = meshWasm.exports.malloc(inputSize);
    const inputArray = new Float32Array(meshMemory.buffer, inputPtr, positions.length);
    inputArray.set(positions);

    const countPtr = meshWasm.exports.malloc(4);

    const startTime = performance.now();
    const outputPtr = meshWasm.exports.convert_to_point_mesh(
        inputPtr,
        triangleCount,
        stepSize,
        countPtr,
        filterMode
    );
    const elapsed = performance.now() - startTime;

    const countArray = new Int32Array(meshMemory.buffer, countPtr, 1);
    const pointCount = countArray[0];

    const outputPositions = new Float32Array(meshMemory.buffer, outputPtr, pointCount * 3);
    const result = new Float32Array(outputPositions);

    const boundsPtr = meshWasm.exports.malloc(24);
    meshWasm.exports.get_bounds(boundsPtr);
    const boundsArray = new Float32Array(meshMemory.buffer, boundsPtr, 6);
    const bounds = {
        min: { x: boundsArray[0], y: boundsArray[1], z: boundsArray[2] },
        max: { x: boundsArray[3], y: boundsArray[4], z: boundsArray[5] }
    };

    meshWasm.exports.free(inputPtr);
    meshWasm.exports.free(countPtr);
    meshWasm.exports.free(boundsPtr);

    return { positions: result, pointCount, bounds };
}

// Generate partial toolpath for a range of scanlines
function generateToolpathPartial(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, startScanline, endScanline) {
    const t0 = performance.now();

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

    // Create terrain height map
    const terrainPointCount = terrainPoints.length / 3;
    const terrainMapPtr = toolpathWasm.exports.create_terrain_map(terrainPtr, terrainPointCount, gridStep);

    // Create tool height map
    const toolPointCount = toolPoints.length / 3;
    const toolMapPtr = toolpathWasm.exports.create_tool_map(toolPtr, toolPointCount, gridStep);

    const t1 = performance.now();
    console.log(`[Worker] ⏱️  Setup: ${(t1 - t0).toFixed(1)}ms`);

    // Get terrain dimensions
    const terrainDimPtr = toolpathWasm.exports.malloc(8);
    toolpathWasm.exports.get_map_dimensions(terrainMapPtr, terrainDimPtr, terrainDimPtr + 4);
    const terrainDims = new Int32Array(toolpathMemory.buffer, terrainDimPtr, 2);
    const terrainWidth = terrainDims[0];
    const terrainHeight = terrainDims[1];

    // Get tool dimensions
    const toolDimPtr = toolpathWasm.exports.malloc(8);
    toolpathWasm.exports.get_map_dimensions(toolMapPtr, toolDimPtr, toolDimPtr + 4);
    const toolDims = new Int32Array(toolpathMemory.buffer, toolDimPtr, 2);
    const toolWidth = toolDims[0];
    const toolHeight = toolDims[1];
    const toolDenseSize = toolWidth * toolHeight;

    console.log(`[Worker] 📏 Terrain grid: ${terrainWidth}x${terrainHeight}, Tool grid: ${toolWidth}x${toolHeight} (dense size: ${toolDenseSize})`);

    const pointsPerLine = Math.ceil(terrainWidth / xStep);
    const numScanlinesTotal = Math.ceil(terrainHeight / yStep);

    // Clamp scanline range
    startScanline = Math.max(0, startScanline);
    endScanline = Math.min(numScanlinesTotal, endScanline);
    const numScanlines = endScanline - startScanline;

    console.log(`[Worker] 📍 Processing scanlines ${startScanline}-${endScanline} (${numScanlines} lines)`);

    // Generate PARTIAL toolpath using new WASM function
    const t2 = performance.now();
    const toolpathPtr = toolpathWasm.exports.generate_path_partial(
        terrainMapPtr,
        toolMapPtr,
        xStep,
        yStep,
        oobZ,
        startScanline,
        endScanline
    );
    const t3 = performance.now();
    console.log(`[Worker] ⏱️  Generate path (PARTIAL): ${(t3 - t2).toFixed(1)}ms`);

    // Get sparse tool count for verification
    const sparseToolCount = toolpathWasm.exports.get_sparse_tool_count();
    const sparsityRatio = ((1 - sparseToolCount / toolDenseSize) * 100).toFixed(1);
    console.log(`[Worker] 🔧 Sparse tool: ${sparseToolCount} records vs ${toolDenseSize} dense (${sparsityRatio}% sparse)`);

    // Get dimensions of partial path
    const dimPtr = toolpathWasm.exports.malloc(8);
    toolpathWasm.exports.get_path_dimensions(toolpathPtr, dimPtr, dimPtr + 4);
    const dims = new Int32Array(toolpathMemory.buffer, dimPtr, 2);
    const actualNumScanlines = dims[0];
    const actualPointsPerLine = dims[1];

    // Copy partial path data
    const pathDataSize = actualNumScanlines * actualPointsPerLine;
    const pathDataPtr = toolpathWasm.exports.malloc(pathDataSize * 4);
    toolpathWasm.exports.copy_path_data(toolpathPtr, pathDataPtr);
    const pathData = new Float32Array(toolpathMemory.buffer, pathDataPtr, pathDataSize);
    const result = new Float32Array(pathData);

    const t4 = performance.now();
    console.log(`[Worker] ⏱️  Copy result: ${(t4 - t3).toFixed(1)}ms`);
    console.log(`[Worker] ⏱️  TOTAL: ${(t4 - t0).toFixed(1)}ms`);

    // Free memory
    toolpathWasm.exports.free(terrainDimPtr);
    toolpathWasm.exports.free(toolDimPtr);
    toolpathWasm.exports.free(dimPtr);
    toolpathWasm.exports.free(pathDataPtr);
    toolpathWasm.exports.free_toolpath(toolpathPtr);
    toolpathWasm.exports.free_height_map(toolMapPtr);
    toolpathWasm.exports.free_height_map(terrainMapPtr);
    toolpathWasm.exports.free(toolPtr);
    toolpathWasm.exports.free(terrainPtr);

    return {
        pathData: result,
        startScanline,
        endScanline,
        numScanlines: actualNumScanlines,
        pointsPerLine: actualPointsPerLine
    };
}

// Handle messages from main thread
self.onmessage = async function(e) {
    const { type, data } = e.data;

    try {
        switch (type) {
            case 'init':
                await initWasm();
                break;

            case 'process-stl':
                const { buffer, stepSize, filterMode } = data;

                self.postMessage({ type: 'status', message: 'Parsing STL...' });

                let parsed;
                const view = new Uint8Array(buffer);
                const header = String.fromCharCode(...view.slice(0, 5));

                if (header === 'solid') {
                    const text = new TextDecoder().decode(buffer);
                    if (text.includes('facet') && text.includes('vertex')) {
                        parsed = parseASCIISTL(text);
                    } else {
                        parsed = parseBinarySTL(buffer);
                    }
                } else {
                    parsed = parseBinarySTL(buffer);
                }

                self.postMessage({
                    type: 'status',
                    message: `Converting ${parsed.triangleCount} triangles...`
                });

                const conversionStart = performance.now();
                const filter = filterMode !== undefined ? filterMode : 0;
                const result = convertMesh(parsed.positions, parsed.triangleCount, stepSize, filter);
                const conversionTime = performance.now() - conversionStart;

                self.postMessage({
                    type: 'conversion-complete',
                    data: result,
                    conversionTime: conversionTime
                }, [result.positions.buffer]);

                break;

            case 'generate-toolpath-partial':
                const { terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep, startScanline, endScanline } = data;

                self.postMessage({ type: 'status', message: `Generating partial toolpath...` });

                const pathResult = generateToolpathPartial(
                    terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep,
                    startScanline, endScanline
                );

                self.postMessage({
                    type: 'toolpath-partial-complete',
                    data: pathResult
                }, [pathResult.pathData.buffer]);

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
