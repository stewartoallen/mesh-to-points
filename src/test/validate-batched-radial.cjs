// validate-batched-radial.cjs
// Validate that batched radial output matches sequential output

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
                try {
                    console.log('=== Batched Radial Validation Test ===');
                    console.log('Comparing sequential vs batched outputs...');

                    if (!navigator.gpu) {
                        return { error: 'WebGPU not available' };
                    }

                    const { RasterPath } = await import('./raster-path.js');

                    // Generate simple terrain (cone)
                    const terrainTriangles = [];
                    const radius = 20;
                    const height = 30;
                    const radialSegments = 8;
                    const heightSegments = 8;

                    for (let i = 0; i < radialSegments; i++) {
                        const theta1 = (i / radialSegments) * 2 * Math.PI;
                        const theta2 = ((i + 1) / radialSegments) * 2 * Math.PI;

                        for (let j = 0; j < heightSegments; j++) {
                            const h1 = (j / heightSegments) * height;
                            const h2 = ((j + 1) / heightSegments) * height;
                            const r1 = radius * (1 - j / heightSegments);
                            const r2 = radius * (1 - (j + 1) / heightSegments);

                            const x1a = r1 * Math.cos(theta1);
                            const y1a = r1 * Math.sin(theta1);
                            const x2a = r1 * Math.cos(theta2);
                            const y2a = r1 * Math.sin(theta2);
                            const x1b = r2 * Math.cos(theta1);
                            const y1b = r2 * Math.sin(theta1);
                            const x2b = r2 * Math.cos(theta2);
                            const y2b = r2 * Math.sin(theta2);

                            terrainTriangles.push(
                                x1a, y1a, h1,
                                x2a, y2a, h1,
                                x1b, y1b, h2
                            );
                            terrainTriangles.push(
                                x2a, y2a, h1,
                                x2b, y2b, h2,
                                x1b, y1b, h2
                            );
                        }
                    }

                    const triangles = new Float32Array(terrainTriangles);
                    console.log(\`✓ Generated terrain: \${terrainTriangles.length/9} triangles\`);

                    // Calculate terrain bounds
                    let minX = Infinity, minY = Infinity, minZ = Infinity;
                    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                    for (let i = 0; i < triangles.length; i += 3) {
                        minX = Math.min(minX, triangles[i]);
                        maxX = Math.max(maxX, triangles[i]);
                        minY = Math.min(minY, triangles[i + 1]);
                        maxY = Math.max(maxY, triangles[i + 1]);
                        minZ = Math.min(minZ, triangles[i + 2]);
                        maxZ = Math.max(maxZ, triangles[i + 2]);
                    }
                    const terrainBounds = {
                        min: { x: minX, y: minY, z: minZ },
                        max: { x: maxX, y: maxY, z: maxZ }
                    };

                    // Generate simple ball tool
                    const toolTriangles = [];
                    const toolRadius = 3;
                    const toolSegments = 6;

                    for (let i = 0; i < toolSegments; i++) {
                        for (let j = 0; j < toolSegments; j++) {
                            const theta1 = (i / toolSegments) * Math.PI;
                            const theta2 = ((i + 1) / toolSegments) * Math.PI;
                            const phi1 = (j / toolSegments) * 2 * Math.PI;
                            const phi2 = ((j + 1) / toolSegments) * 2 * Math.PI;

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

                    const tool = new Float32Array(toolTriangles);
                    const stepSize = 0.1;

                    // Test 1: Sequential
                    console.log('\\n--- Sequential (no workers) ---');
                    const rasterPathSeq = new RasterPath({ parallelWorkers: 0 });
                    await rasterPathSeq.init();
                    const toolResultSeq = await rasterPathSeq.rasterizeMesh(tool, stepSize, 1);
                    console.log(\`✓ Tool rasterized: \${toolResultSeq.pointCount} points\`);

                    const xRotationStep = 45;  // Test with 8 rotations (45° steps)
                    const xStep = 2;
                    const zFloor = 0;

                    const seqResult = await rasterPathSeq.generateRadialToolpath(
                        triangles,
                        toolResultSeq.positions,
                        xRotationStep,
                        xStep,
                        zFloor,
                        stepSize,
                        terrainBounds
                    );
                    console.log(\`✓ Sequential: \${seqResult.numRotations} rotations, \${seqResult.pointsPerLine} points/line\`);
                    rasterPathSeq.dispose();

                    // Test 2: Batched
                    console.log('\\n--- Batched GPU (with workers) ---');
                    const rasterPathBatch = new RasterPath({ parallelWorkers: 4 });
                    await rasterPathBatch.init();
                    await rasterPathBatch.initWorkerPool();
                    const toolResultBatch = await rasterPathBatch.rasterizeMesh(tool, stepSize, 1);

                    const batchResult = await rasterPathBatch.generateRadialToolpath(
                        triangles,
                        toolResultBatch.positions,
                        xRotationStep,
                        xStep,
                        zFloor,
                        stepSize,
                        terrainBounds
                    );
                    console.log(\`✓ Batched: \${batchResult.numRotations} rotations, \${batchResult.pointsPerLine} points/line\`);
                    rasterPathBatch.dispose();

                    // Validate outputs match
                    console.log('\\n--- Validation ---');

                    if (seqResult.pathData.length !== batchResult.pathData.length) {
                        return {
                            error: \`Length mismatch: seq=\${seqResult.pathData.length} batch=\${batchResult.pathData.length}\`
                        };
                    }

                    let maxDiff = 0;
                    let diffCount = 0;
                    const tolerance = 0.001;  // 1mm tolerance

                    for (let i = 0; i < seqResult.pathData.length; i++) {
                        const diff = Math.abs(seqResult.pathData[i] - batchResult.pathData[i]);
                        if (diff > tolerance) {
                            diffCount++;
                            maxDiff = Math.max(maxDiff, diff);
                        }
                    }

                    console.log(\`✓ Array lengths match: \${seqResult.pathData.length} points\`);
                    console.log(\`✓ Differences > \${tolerance}mm: \${diffCount} (\${(diffCount/seqResult.pathData.length*100).toFixed(2)}%)\`);
                    console.log(\`✓ Max difference: \${maxDiff.toFixed(4)}mm\`);
                    console.log('\\nFirst 10 sequential values:', Array.from(seqResult.pathData.slice(0, 10)).map(v => v.toFixed(3)).join(', '));
                    console.log('First 10 batched values:   ', Array.from(batchResult.pathData.slice(0, 10)).map(v => v.toFixed(3)).join(', '));

                    const passed = diffCount === 0;
                    if (passed) {
                        console.log('\\n✅ VALIDATION PASSED: Outputs match exactly!');
                    } else {
                        console.log(\`\\n⚠️  VALIDATION WARNING: \${diffCount} points differ\`);
                    }

                    return {
                        success: true,
                        passed,
                        totalPoints: seqResult.pathData.length,
                        diffCount,
                        maxDiff,
                        percentDifferent: (diffCount/seqResult.pathData.length*100).toFixed(2)
                    };

                } catch (error) {
                    console.error('Validation error:', error);
                    return { error: error.message, stack: error.stack };
                }
            })();
        `;

        try {
            const result = await mainWindow.webContents.executeJavaScript(testScript);

            if (result.error) {
                console.error('❌ Validation failed:', result.error);
                if (result.stack) {
                    console.error(result.stack);
                }
                app.exit(1);
                return;
            }

            console.log('\n=== Final Result ===');
            if (result.passed) {
                console.log('✅ Batched output matches sequential output exactly');
            } else {
                console.log(`⚠️  ${result.diffCount} / ${result.totalPoints} points differ (${result.percentDifferent}%)`);
                console.log(`   Max difference: ${result.maxDiff.toFixed(4)}mm`);
            }

            app.exit(result.passed ? 0 : 1);
        } catch (error) {
            console.error('❌ Validation execution failed:', error);
            app.exit(1);
        }
    });

    mainWindow.webContents.on('console-message', (event, level, message) => {
        console.log('[Renderer]', message);
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    app.quit();
});
