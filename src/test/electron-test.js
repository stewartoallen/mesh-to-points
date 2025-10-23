// electron-test.js
// Electron-based test harness for WebGPU backend testing

const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false, // Don't show window for automated testing
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableBlinkFeatures: 'WebGPU', // Enable WebGPU
        }
    });

    // Load the built HTML
    const htmlPath = path.join(__dirname, '../../build/index.html');
    mainWindow.loadFile(htmlPath);

    // Wait for page to load
    mainWindow.webContents.on('did-finish-load', async () => {
        console.log('✓ Page loaded\n');

        // Inject test script
        const testScript = `
            (async function() {
                console.log('=== Automated WebGPU Test ===\\n');

                // Check WebGPU availability
                if (!navigator.gpu) {
                    console.error('❌ WebGPU not available');
                    return { error: 'WebGPU not available' };
                }
                console.log('✓ WebGPU available\\n');

                // Load terrain.stl
                console.log('Loading terrain.stl...');
                const terrainResponse = await fetch('benchmark/fixtures/terrain.stl');
                const terrainBuffer = await terrainResponse.arrayBuffer();
                console.log('✓ Terrain loaded:', terrainBuffer.byteLength, 'bytes\\n');

                // Load tool.stl
                console.log('Loading tool.stl...');
                const toolResponse = await fetch('benchmark/fixtures/tool.stl');
                const toolBuffer = await toolResponse.arrayBuffer();
                console.log('✓ Tool loaded:', toolBuffer.byteLength, 'bytes\\n');

                // Process files through workers (terrain and tool conversion)
                console.log('Converting STL files to point clouds...\\n');

                const terrainWorker = new Worker('worker.js');
                const terrainData = await new Promise((resolve, reject) => {
                    terrainWorker.onmessage = function(e) {
                        if (e.data.type === 'conversion-complete') {
                            terrainWorker.terminate();
                            resolve(e.data.data);
                        } else if (e.data.type === 'error') {
                            terrainWorker.terminate();
                            reject(new Error(e.data.message));
                        }
                    };
                    terrainWorker.onerror = reject;
                    // Wait for WASM ready
                    setTimeout(() => {
                        terrainWorker.postMessage({
                            type: 'process-stl',
                            data: { buffer: terrainBuffer, stepSize: 0.05, filterMode: 0 }
                        });
                    }, 100);
                });
                console.log('✓ Terrain converted:', terrainData.pointCount, 'points\\n');

                const toolWorker = new Worker('worker.js');
                const toolData = await new Promise((resolve, reject) => {
                    toolWorker.onmessage = function(e) {
                        if (e.data.type === 'conversion-complete') {
                            toolWorker.terminate();
                            resolve(e.data.data);
                        } else if (e.data.type === 'error') {
                            toolWorker.terminate();
                            reject(new Error(e.data.message));
                        }
                    };
                    toolWorker.onerror = reject;
                    setTimeout(() => {
                        toolWorker.postMessage({
                            type: 'process-stl',
                            data: { buffer: toolBuffer, stepSize: 0.05, filterMode: 1 }
                        });
                    }, 100);
                });
                console.log('✓ Tool converted:', toolData.pointCount, 'points\\n');

                // Import WebGPU module
                const { initWebGPU, generateToolpathWebGPU } = await import('./toolpath-webgpu.js');

                // Initialize WebGPU
                console.log('Initializing WebGPU...');
                const webgpuAvailable = await initWebGPU();
                if (!webgpuAvailable) {
                    console.error('❌ Failed to initialize WebGPU');
                    return { error: 'Failed to initialize WebGPU' };
                }
                console.log('✓ WebGPU initialized\\n');

                // Test parameters
                const xStep = 5;
                const yStep = 5;
                const zFloor = -100.0;
                const gridStep = 0.05;

                console.log('Parameters:', { xStep, yStep, zFloor, gridStep });
                console.log('');

                // Run WebGPU test
                console.log('--- Test: WebGPU Backend ---');
                const webgpuResult = await generateToolpathWebGPU(
                    terrainData.positions,
                    toolData.positions,
                    xStep,
                    yStep,
                    zFloor,
                    gridStep
                );
                console.log('');

                return {
                    success: true,
                    webgpu: {
                        time: webgpuResult.generationTime,
                        output: {
                            numScanlines: webgpuResult.numScanlines,
                            pointsPerLine: webgpuResult.pointsPerLine,
                            totalPoints: webgpuResult.pathData.length
                        }
                    }
                };
            })().then(result => {
                if (result.success) {
                    console.log('=== Test Complete ===');
                    console.log('WebGPU Time:', result.webgpu.time.toFixed(1) + 'ms');
                    console.log('Output:', result.webgpu.output.pointsPerLine + 'x' + result.webgpu.output.numScanlines, '=', result.webgpu.output.totalPoints, 'points');
                } else if (result.error) {
                    console.error('Test failed:', result.error);
                }
                // Signal completion
                window.__testComplete = result;
            }).catch(err => {
                console.error('Test error:', err);
                window.__testComplete = { error: err.message };
            });
        `;

        // Execute test script
        try {
            await mainWindow.webContents.executeJavaScript(testScript);

            // Wait for test completion
            const checkComplete = setInterval(async () => {
                const result = await mainWindow.webContents.executeJavaScript('window.__testComplete');
                if (result) {
                    clearInterval(checkComplete);
                    console.log('\n✓ All tests complete\n');
                    app.quit();
                }
            }, 100);

        } catch (error) {
            console.error('Error running test:', error);
            app.quit();
        }
    });

    // Forward console output
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(message);
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    app.quit();
});
