// regression-test.js
// Regression test for rasterization output
// Generates output and compares against baseline

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, '../../test-output');
const BASELINE_FILE = path.join(OUTPUT_DIR, 'baseline.json');
const CURRENT_FILE = path.join(OUTPUT_DIR, 'current.json');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

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
                console.log('=== Regression Test ===');

                // Check WebGPU
                if (!navigator.gpu) {
                    return { error: 'WebGPU not available' };
                }
                console.log('✓ WebGPU available');

                // Initialize WebGPU worker
                const worker = new Worker('webgpu-worker.js');

                const workerReady = new Promise((resolve) => {
                    worker.onmessage = function(e) {
                        if (e.data.type === 'webgpu-ready') {
                            resolve(e.data.data.success);
                        }
                    };
                });

                worker.postMessage({ type: 'init' });
                const ready = await workerReady;

                if (!ready) {
                    return { error: 'Failed to initialize WebGPU worker' };
                }
                console.log('✓ Worker initialized');

                // Generate a simple test STL (pyramid)
                const triangles = new Float32Array([
                    // Base triangle 1
                    -10, -10, 0,  10, -10, 0,  10, 10, 0,
                    // Base triangle 2
                    -10, -10, 0,  10, 10, 0,  -10, 10, 0,
                    // Side 1
                    -10, -10, 0,  0, 0, 10,  10, -10, 0,
                    // Side 2
                    10, -10, 0,  0, 0, 10,  10, 10, 0,
                    // Side 3
                    10, 10, 0,  0, 0, 10,  -10, 10, 0,
                    // Side 4
                    -10, 10, 0,  0, 0, 10,  -10, -10, 0,
                ]);

                console.log('Generated test pyramid:', triangles.length / 9, 'triangles');

                // Rasterize with specific parameters
                const stepSize = 1.0;
                const filterMode = 0;

                const result = await new Promise((resolve, reject) => {
                    worker.onmessage = function(e) {
                        if (e.data.type === 'rasterize-complete') {
                            resolve(e.data.data);
                        } else if (e.data.type === 'error') {
                            reject(new Error(e.data.message));
                        }
                    };
                    worker.onerror = reject;

                    worker.postMessage({
                        type: 'rasterize',
                        data: {
                            triangles,
                            stepSize,
                            filterMode,
                            isForTool: false,
                            boundsOverride: null
                        }
                    }, [triangles.buffer]);
                });

                console.log('✓ Rasterization complete:', result.pointCount, 'points');

                // Create output data
                const output = {
                    parameters: {
                        stepSize,
                        filterMode,
                        triangleCount: 6
                    },
                    result: {
                        pointCount: result.pointCount,
                        bounds: result.bounds,
                        // First 30 points for comparison
                        samplePoints: Array.from(result.positions.slice(0, 90)),
                        // Hash of all points for quick comparison
                        checksum: hashArray(result.positions)
                    }
                };

                worker.terminate();
                return { success: true, output };
            })();

            function hashArray(arr) {
                let hash = 0;
                for (let i = 0; i < arr.length; i++) {
                    const val = Math.round(arr[i] * 1000); // Round to 3 decimals
                    hash = ((hash << 5) - hash) + val;
                    hash = hash & hash; // Convert to 32bit integer
                }
                return hash;
            }
        `;

        try {
            const result = await mainWindow.webContents.executeJavaScript(testScript);

            if (result.error) {
                console.error('❌ Test failed:', result.error);
                app.exit(1);
                return;
            }

            // Save current output
            fs.writeFileSync(CURRENT_FILE, JSON.stringify(result.output, null, 2));
            console.log('✓ Saved current output to', CURRENT_FILE);

            // Check if baseline exists
            if (!fs.existsSync(BASELINE_FILE)) {
                console.log('📝 No baseline found - saving current as baseline');
                fs.writeFileSync(BASELINE_FILE, JSON.stringify(result.output, null, 2));
                console.log('✅ Baseline created');
                app.quit();
                return;
            }

            // Compare with baseline
            const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));

            console.log('\n=== Comparison ===');
            console.log('Point count:', result.output.result.pointCount, 'vs baseline:', baseline.result.pointCount);
            console.log('Checksum:', result.output.result.checksum, 'vs baseline:', baseline.result.checksum);

            let passed = true;

            // Check point count
            if (result.output.result.pointCount !== baseline.result.pointCount) {
                console.error('❌ Point count mismatch!');
                passed = false;
            }

            // Check checksum
            if (result.output.result.checksum !== baseline.result.checksum) {
                console.error('❌ Output checksum mismatch!');
                console.error('This indicates the point positions have changed');
                passed = false;
            }

            // Check bounds
            const boundsMatch =
                Math.abs(result.output.result.bounds.min.x - baseline.result.bounds.min.x) < 0.001 &&
                Math.abs(result.output.result.bounds.min.y - baseline.result.bounds.min.y) < 0.001 &&
                Math.abs(result.output.result.bounds.max.x - baseline.result.bounds.max.x) < 0.001 &&
                Math.abs(result.output.result.bounds.max.y - baseline.result.bounds.max.y) < 0.001;

            if (!boundsMatch) {
                console.error('❌ Bounds mismatch!');
                console.log('Current:', result.output.result.bounds);
                console.log('Baseline:', baseline.result.bounds);
                passed = false;
            }

            if (passed) {
                console.log('\n✅ All checks passed - output matches baseline');
                app.exit(0);
            } else {
                console.log('\n❌ Regression detected - output differs from baseline');
                console.log('To update baseline: cp', CURRENT_FILE, BASELINE_FILE);
                app.exit(1);
            }

        } catch (error) {
            console.error('Error running test:', error);
            app.exit(1);
        }
    });

    mainWindow.webContents.on('console-message', (event, level, message) => {
        if (level === 2) { // Error
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
