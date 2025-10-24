// toolpath-regression.cjs
// Comprehensive regression test for full toolpath generation
// Tests terrain rasterization + tool rasterization + toolpath generation
// Stores complete Z-height output for comparison

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, '../../test-output');
const BASELINE_FILE = path.join(OUTPUT_DIR, 'toolpath-baseline.txt');
const CURRENT_FILE = path.join(OUTPUT_DIR, 'toolpath-current.txt');
const DIFF_FILE = path.join(OUTPUT_DIR, 'toolpath-diff.txt');

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
                console.log('=== Full Toolpath Regression Test ===');

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

                // Use normal GPU limit - don't force tiling for baseline test
                worker.postMessage({
                    type: 'init',
                    data: {
                        config: {
                            maxGPUMemoryMB: 256,  // Normal limit - no tiling needed
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
                console.log('✓ Worker initialized');

                // Generate test terrain (hemisphere-like surface)
                const terrainTriangles = [];
                const radius = 20;
                const segments = 8;

                for (let i = 0; i < segments; i++) {
                    for (let j = 0; j < segments; j++) {
                        const theta1 = (i / segments) * Math.PI;
                        const theta2 = ((i + 1) / segments) * Math.PI;
                        const phi1 = (j / segments) * 2 * Math.PI;
                        const phi2 = ((j + 1) / segments) * 2 * Math.PI;

                        // Four corners of quad
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

                        // Triangle 1
                        terrainTriangles.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
                        // Triangle 2
                        terrainTriangles.push(x1, y1, z1, x3, y3, z3, x4, y4, z4);
                    }
                }

                const terrainData = new Float32Array(terrainTriangles);
                console.log('Generated test terrain:', terrainData.length / 9, 'triangles');

                // Generate tool (simple sphere)
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
                console.log('Generated test tool:', toolData.length / 9, 'triangles');

                // Test parameters - FINE detail for comprehensive test
                const stepSize = 0.05; // 0.05mm high resolution
                const xStep = 1;
                const yStep = 1;
                const zFloor = -100;

                console.log('\\nTest parameters:');
                console.log('  Step size:', stepSize, 'mm');
                console.log('  XY step:', xStep + 'x' + yStep, 'points');
                console.log('  Z floor:', zFloor, 'mm');

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
                console.log('✓ Terrain:', terrainResult.pointCount, 'points in', terrainResult.conversionTime.toFixed(1), 'ms');

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
                console.log('✓ Tool:', toolResult.pointCount, 'points in', toolResult.conversionTime.toFixed(1), 'ms');

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
                console.log('✓ Toolpath:', toolpathResult.numScanlines + 'x' + toolpathResult.pointsPerLine, '=', toolpathResult.pathData.length, 'Z-values');
                console.log('  Generation time:', toolpathResult.generationTime.toFixed(1), 'ms');

                worker.terminate();

                // Format output: one Z-value per line for easy diffing
                const zValues = [];
                for (let i = 0; i < toolpathResult.pathData.length; i++) {
                    // Round to 2 decimals (0.01mm precision) for consistent comparison
                    zValues.push(toolpathResult.pathData[i].toFixed(2));
                }

                return {
                    success: true,
                    output: {
                        parameters: {
                            stepSize,
                            xStep,
                            yStep,
                            zFloor,
                            terrainTriangles: terrainData.length / 9,
                            toolTriangles: toolData.length / 9
                        },
                        result: {
                            terrainPoints: terrainResult.pointCount,
                            toolPoints: toolResult.pointCount,
                            toolpathSize: toolpathResult.pathData.length,
                            numScanlines: toolpathResult.numScanlines,
                            pointsPerLine: toolpathResult.pointsPerLine
                        },
                        zValues: zValues.join('\\n')
                    }
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

            // Save current output
            const currentOutput = [
                '# Toolpath Regression Test Output',
                '# Parameters:',
                `#   Step size: ${result.output.parameters.stepSize}mm`,
                `#   XY step: ${result.output.parameters.xStep}x${result.output.parameters.yStep}`,
                `#   Z floor: ${result.output.parameters.zFloor}mm`,
                `#   Terrain triangles: ${result.output.parameters.terrainTriangles}`,
                `#   Tool triangles: ${result.output.parameters.toolTriangles}`,
                '# Result:',
                `#   Terrain points: ${result.output.result.terrainPoints}`,
                `#   Tool points: ${result.output.result.toolPoints}`,
                `#   Toolpath: ${result.output.result.numScanlines}x${result.output.result.pointsPerLine} = ${result.output.result.toolpathSize} values`,
                '# Z-values (one per line):',
                result.output.zValues
            ].join('\n');

            fs.writeFileSync(CURRENT_FILE, currentOutput);
            console.log('\n✓ Saved current output to', CURRENT_FILE);
            console.log(`  Total Z-values: ${result.output.result.toolpathSize}`);

            // Check if baseline exists
            if (!fs.existsSync(BASELINE_FILE)) {
                console.log('\n📝 No baseline found - saving current as baseline');
                fs.writeFileSync(BASELINE_FILE, currentOutput);
                console.log('✅ Baseline created');
                app.exit(0);
                return;
            }

            // Compare with baseline
            const baseline = fs.readFileSync(BASELINE_FILE, 'utf8');
            const baselineLines = baseline.split('\n').filter(l => !l.startsWith('#'));
            const currentLines = result.output.zValues.split('\n');

            console.log('\n=== Comparison ===');
            console.log('Baseline Z-values:', baselineLines.length);
            console.log('Current Z-values:', currentLines.length);

            let passed = true;
            const diffs = [];
            const TOLERANCE = 0.001; // 0.001mm tolerance

            if (baselineLines.length !== currentLines.length) {
                console.error('❌ Length mismatch!');
                passed = false;
            } else {
                let diffCount = 0;
                for (let i = 0; i < baselineLines.length; i++) {
                    const baseVal = parseFloat(baselineLines[i]);
                    const currVal = parseFloat(currentLines[i]);
                    const diff = Math.abs(baseVal - currVal);

                    if (diff > TOLERANCE) {
                        diffCount++;
                        if (diffs.length < 10) { // Store first 10 diffs
                            diffs.push({
                                index: i,
                                baseline: baseVal,
                                current: currVal,
                                diff: diff
                            });
                        }
                    }
                }

                if (diffCount > 0) {
                    console.error(`❌ Found ${diffCount} differences > ${TOLERANCE}mm`);
                    console.error('First few differences:');
                    diffs.forEach(d => {
                        console.error(`  Line ${d.index}: ${d.baseline} → ${d.current} (Δ${d.diff.toFixed(6)})`);
                    });

                    // Write diff file
                    const diffOutput = [
                        `# Found ${diffCount} differences > ${TOLERANCE}mm`,
                        '# Format: line_number baseline_value current_value difference',
                        ...diffs.map(d => `${d.index} ${d.baseline} ${d.current} ${d.diff.toFixed(6)}`)
                    ].join('\n');
                    fs.writeFileSync(DIFF_FILE, diffOutput);
                    console.error('Wrote differences to', DIFF_FILE);

                    passed = false;
                } else {
                    console.log('✓ All Z-values within tolerance');
                }
            }

            if (passed) {
                console.log('\n✅ All checks passed - output matches baseline');
                if (fs.existsSync(DIFF_FILE)) {
                    fs.unlinkSync(DIFF_FILE);
                }
                app.exit(0);
            } else {
                console.log('\n❌ Regression detected - output differs from baseline');
                console.log('To compare: diff', BASELINE_FILE, CURRENT_FILE);
                console.log('To update baseline: cp', CURRENT_FILE, BASELINE_FILE);
                app.exit(1);
            }

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
