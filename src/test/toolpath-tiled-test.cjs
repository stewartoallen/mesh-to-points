// toolpath-tiled-test.cjs
// Test case specifically for tiled toolpath generation
// Forces tiling by using a large grid

const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableBlinkFeatures: 'WebGPU',
        }
    });

    const htmlPath = path.join(__dirname, '../../build/index.html');
    mainWindow.loadFile(htmlPath);

    mainWindow.webContents.on('did-finish-load', async () => {
        console.log('✓ Page loaded');

        const testScript = `
            (async function() {
                console.log('=== Tiled Toolpath Test ===');

                if (!navigator.gpu) {
                    return { error: 'WebGPU not available' };
                }

                // Initialize WebGPU worker with SMALL memory limit to force tiling
                const worker = new Worker('webgpu-worker.js');

                const workerReady = new Promise((resolve) => {
                    worker.onmessage = function(e) {
                        if (e.data.type === 'webgpu-ready') {
                            resolve(e.data.data.success);
                        }
                    };
                });

                // Force tiling with small memory limit (1MB)
                worker.postMessage({
                    type: 'init',
                    data: {
                        config: {
                            maxGPUMemoryMB: 1,  // Tiny limit to force tiling
                            gpuMemorySafetyMargin: 0.8,
                            tileOverlapMM: 10,
                            autoTiling: true,
                            minTileSize: 50
                        }
                    }
                });
                const ready = await workerReady;

                if (!ready) {
                    return { error: 'Failed to initialize WebGPU worker' };
                }
                console.log('✓ Worker initialized with 1MB limit (forces tiling)');

                // Generate larger test terrain (hemisphere)
                const terrainTriangles = [];
                const radius = 50;  // Larger radius
                const segments = 20; // More segments for bigger terrain

                for (let i = 0; i < segments; i++) {
                    for (let j = 0; j < segments; j++) {
                        const theta1 = (i / segments) * Math.PI;
                        const theta2 = ((i + 1) / segments) * Math.PI;
                        const phi1 = (j / segments) * 2 * Math.PI;
                        const phi2 = ((j + 1) / segments) * 2 * Math.PI;

                        const x1 = radius * Math.sin(theta1) * Math.cos(phi1);
                        const y1 = radius * Math.sin(theta1) * Math.sin(phi1);
                        const z1 = radius * Math.cos(theta1);

                        const x2 = radius * Math.sin(theta2) * Math.cos(phi1);
                        const y2 = radius * Math.sin(theta2) * Math.sin(phi1);
                        const z2 = radius * Math.cos(theta2);

                        const x3 = radius * Math.sin(theta2) * Math.cos(phi2);
                        const y3 = radius * Math.sin(theta2) * Math.sin(phi2);
                        const z3 = radius * Math.cos(theta2);

                        const x4 = radius * Math.sin(theta1) * Math.cos(phi2);
                        const y4 = radius * Math.sin(theta1) * Math.sin(phi2);
                        const z4 = radius * Math.cos(theta1);

                        terrainTriangles.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
                        terrainTriangles.push(x1, y1, z1, x3, y3, z3, x4, y4, z4);
                    }
                }

                const terrainData = new Float32Array(terrainTriangles);
                console.log('Generated terrain:', terrainData.length / 9, 'triangles');

                // Generate tool
                const toolTriangles = [];
                const toolRadius = 2.5;
                const toolSegs = 6;

                for (let i = 0; i < toolSegs; i++) {
                    for (let j = 0; j < toolSegs; j++) {
                        const theta1 = (i / toolSegs) * Math.PI;
                        const theta2 = ((i + 1) / toolSegs) * Math.PI;
                        const phi1 = (j / toolSegs) * 2 * Math.PI;
                        const phi2 = ((j + 1) / toolSegs) * 2 * Math.PI;

                        const x1 = toolRadius * Math.sin(theta1) * Math.cos(phi1);
                        const y1 = toolRadius * Math.sin(theta1) * Math.sin(phi1);
                        const z1 = toolRadius * Math.cos(theta1);

                        const x2 = toolRadius * Math.sin(theta2) * Math.cos(phi1);
                        const y2 = toolRadius * Math.sin(theta2) * Math.sin(phi1);
                        const z2 = toolRadius * Math.cos(theta2);

                        const x3 = toolRadius * Math.sin(theta2) * Math.cos(phi2);
                        const y3 = toolRadius * Math.sin(theta2) * Math.sin(phi2);
                        const z3 = toolRadius * Math.cos(theta2);

                        const x4 = toolRadius * Math.sin(theta1) * Math.cos(phi2);
                        const y4 = toolRadius * Math.sin(theta1) * Math.sin(phi2);
                        const z4 = toolRadius * Math.cos(theta1);

                        toolTriangles.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
                        toolTriangles.push(x1, y1, z1, x3, y3, z3, x4, y4, z4);
                    }
                }

                const toolData = new Float32Array(toolTriangles);
                console.log('Generated tool:', toolData.length / 9, 'triangles');

                const stepSize = 0.2; // Coarser to keep test fast but still force tiling
                const xStep = 1;
                const yStep = 1;
                const zFloor = -100;

                console.log('\\nTest parameters:');
                console.log('  Step size:', stepSize, 'mm');
                console.log('  Memory limit: 1 MB (should force tiling)');

                // Rasterize terrain
                console.log('\\n1. Rasterizing terrain...');
                const terrainResult = await new Promise((resolve, reject) => {
                    worker.onmessage = function(e) {
                        if (e.data.type === 'rasterize-complete' && !e.data.isForTool) {
                            resolve(e.data.data);
                        } else if (e.data.type === 'error') {
                            reject(new Error(e.data.message));
                        }
                    };

                    const terrainCopy = new Float32Array(terrainData);
                    worker.postMessage({
                        type: 'rasterize',
                        data: {
                            triangles: terrainCopy,
                            stepSize,
                            filterMode: 0,
                            isForTool: false,
                            boundsOverride: null
                        }
                    }, [terrainCopy.buffer]);
                });
                console.log('✓ Terrain:', terrainResult.pointCount, 'points');
                if (terrainResult.tileCount) {
                    console.log('  Used', terrainResult.tileCount, 'tiles for terrain rasterization');
                }

                // Rasterize tool
                console.log('\\n2. Rasterizing tool...');
                const toolResult = await new Promise((resolve, reject) => {
                    worker.onmessage = function(e) {
                        if (e.data.type === 'rasterize-complete' && e.data.isForTool) {
                            resolve(e.data.data);
                        } else if (e.data.type === 'error') {
                            reject(new Error(e.data.message));
                        }
                    };

                    const toolCopy = new Float32Array(toolData);
                    worker.postMessage({
                        type: 'rasterize',
                        data: {
                            triangles: toolCopy,
                            stepSize,
                            filterMode: 1,
                            isForTool: true,
                            boundsOverride: null
                        }
                    }, [toolCopy.buffer]);
                });
                console.log('✓ Tool:', toolResult.pointCount, 'points');

                // Generate toolpath
                console.log('\\n3. Generating toolpath...');
                const toolpathResult = await new Promise((resolve, reject) => {
                    worker.onmessage = function(e) {
                        if (e.data.type === 'toolpath-complete') {
                            resolve(e.data.data);
                        } else if (e.data.type === 'error') {
                            reject(new Error(e.data.message));
                        }
                    };

                    worker.postMessage({
                        type: 'generate-toolpath',
                        data: {
                            terrainPoints: terrainResult.positions,
                            toolPoints: toolResult.positions,
                            xStep,
                            yStep,
                            oobZ: zFloor,
                            gridStep: stepSize,
                            terrainBounds: terrainResult.bounds
                        }
                    });
                });

                console.log('✓ Toolpath:', toolpathResult.pathData.length, 'Z-values');
                console.log('  Generation time:', toolpathResult.generationTime.toFixed(1), 'ms');

                worker.terminate();

                return {
                    success: true,
                    tilingUsed: terrainResult.tileCount > 1,
                    terrainTiles: terrainResult.tileCount || 1,
                    toolpathSize: toolpathResult.pathData.length
                };
            })();
        `;

        try {
            const result = await mainWindow.webContents.executeJavaScript(testScript);

            if (result.error) {
                console.error('❌ Test failed:', result.error);
                app.exit(1);
                return;
            }

            if (!result.tilingUsed) {
                console.error('❌ Test failed: Tiling was not triggered (expected tiling with 32MB limit)');
                app.exit(1);
                return;
            }

            console.log('\n✅ Tiled toolpath test passed!');
            console.log('  Terrain tiles:', result.terrainTiles);
            console.log('  Toolpath size:', result.toolpathSize);
            app.exit(0);

        } catch (error) {
            console.error('Error running test:', error);
            app.exit(1);
        }
    });

    mainWindow.webContents.on('console-message', (event, level, message) => {
        if (level === 2) {
            console.error(message);
        } else {
            console.log(message);
        }
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    app.quit();
});
