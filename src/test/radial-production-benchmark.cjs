// radial-production-benchmark.cjs
// Benchmark radial toolpath with production settings
// Matches typical user workflow: 0.05mm detail, 5° rotation, X step 1

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
                    console.log('=== Radial Production Benchmark ===');
                    console.log('Settings: Detail 0.05mm, Rotation 5°, X step 1');

                    if (!navigator.gpu) {
                        return { error: 'WebGPU not available' };
                    }

                    const { RasterPath } = await import('./raster-path.js');

                    // Test 1: Sequential (disable worker pool)
                    console.log('\\n--- Test 1: Sequential Processing ---');
                    const rasterPathSeq = new RasterPath({ parallelWorkers: 0 });
                    await rasterPathSeq.init();
                    console.log('✓ RasterPath initialized (sequential mode)');

                    // Generate moderately complex terrain
                    const terrainTriangles = [];
                    const radius = 20;
                    const height = 30;
                    const radialSegments = 32; // More detailed than simple test
                    const heightSegments = 16;

                    // Generate a more complex surface (cone with ribs)
                    for (let i = 0; i < radialSegments; i++) {
                        const theta1 = (i / radialSegments) * 2 * Math.PI;
                        const theta2 = ((i + 1) / radialSegments) * 2 * Math.PI;

                        for (let j = 0; j < heightSegments; j++) {
                            const h1 = (j / heightSegments) * height;
                            const h2 = ((j + 1) / heightSegments) * height;
                            const r1 = radius * (1 - j / heightSegments);
                            const r2 = radius * (1 - (j + 1) / heightSegments);

                            // Add ribs for complexity
                            const rib = (i % 4 === 0) ? 1.2 : 1.0;

                            const x1a = r1 * Math.cos(theta1) * rib;
                            const y1a = r1 * Math.sin(theta1) * rib;
                            const x2a = r1 * Math.cos(theta2) * rib;
                            const y2a = r1 * Math.sin(theta2) * rib;
                            const x1b = r2 * Math.cos(theta1) * rib;
                            const y1b = r2 * Math.sin(theta1) * rib;
                            const x2b = r2 * Math.cos(theta2) * rib;
                            const y2b = r2 * Math.sin(theta2) * rib;

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

                    // Generate ball tool
                    const toolTriangles = [];
                    const toolRadius = 3;
                    const toolSegments = 8;

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
                    const stepSize = 0.05; // Production detail level
                    const toolResult = await rasterPathSeq.rasterizeMesh(tool, stepSize, 1);
                    console.log(\`✓ Tool rasterized: \${toolResult.pointCount} points\`);

                    // Production settings
                    const xRotationStep = 5;  // 5° steps = 72 rotations
                    const xStep = 1;          // Sample every grid point
                    const zFloor = 0;

                    console.log('Generating sequential radial toolpath...');
                    const seqStart = performance.now();
                    const seqResult = await rasterPathSeq.generateRadialToolpath(
                        triangles,
                        toolResult.positions,
                        xRotationStep,
                        xStep,
                        zFloor,
                        stepSize,
                        terrainBounds
                    );
                    const seqTime = performance.now() - seqStart;
                    console.log(\`✅ Sequential complete: \${seqTime.toFixed(1)}ms\`);

                    // Clean up sequential instance
                    rasterPathSeq.dispose();

                    // Test 2: Parallel (with worker pool)
                    console.log('\\n--- Test 2: Parallel Processing (4 workers) ---');
                    const rasterPathPar = new RasterPath({ parallelWorkers: 4 });
                    await rasterPathPar.init();
                    await rasterPathPar.initWorkerPool();
                    console.log('✓ RasterPath initialized with worker pool');

                    // Rasterize tool again for parallel instance
                    const toolResultPar = await rasterPathPar.rasterizeMesh(tool, stepSize, 1);

                    console.log('Generating parallel radial toolpath...');
                    const parStart = performance.now();
                    const parResult = await rasterPathPar.generateRadialToolpath(
                        triangles,
                        toolResultPar.positions,
                        xRotationStep,
                        xStep,
                        zFloor,
                        stepSize,
                        terrainBounds
                    );
                    const parTime = performance.now() - parStart;
                    console.log(\`✅ Parallel complete: \${parTime.toFixed(1)}ms\`);

                    // Calculate speedup
                    const speedup = seqTime / parTime;

                    console.log('\\n=== Benchmark Results ===');
                    console.log(\`Sequential: \${seqTime.toFixed(1)}ms\`);
                    console.log(\`Parallel:   \${parTime.toFixed(1)}ms\`);
                    console.log(\`Speedup:    \${speedup.toFixed(2)}x\`);
                    console.log(\`Rotations:  \${seqResult.numRotations}\`);
                    console.log(\`Points/line: \${seqResult.pointsPerLine}\`);
                    console.log(\`Total points: \${seqResult.pathData.length}\`);

                    // Clean up parallel instance
                    rasterPathPar.dispose();

                    return {
                        success: true,
                        sequentialTime: seqTime,
                        parallelTime: parTime,
                        speedup,
                        numRotations: seqResult.numRotations,
                        pointsPerLine: seqResult.pointsPerLine,
                        totalPoints: seqResult.pathData.length,
                        triangles: terrainTriangles.length / 9
                    };

                } catch (error) {
                    console.error('Benchmark error:', error);
                    return { error: error.message, stack: error.stack };
                }
            })();
        `;

        try {
            const result = await mainWindow.webContents.executeJavaScript(testScript);

            if (result.error) {
                console.error('❌ Benchmark failed:', result.error);
                if (result.stack) {
                    console.error(result.stack);
                }
                app.exit(1);
                return;
            }

            console.log('\n=== Final Results ===');
            console.log('✅ Production benchmark complete');
            console.log(`   Terrain: ${result.triangles} triangles`);
            console.log(`   Rotations: ${result.numRotations}`);
            console.log(`   Points per line: ${result.pointsPerLine}`);
            console.log(`   Total points: ${result.totalPoints}`);
            console.log(`   Sequential: ${result.sequentialTime.toFixed(1)}ms`);
            console.log(`   Parallel:   ${result.parallelTime.toFixed(1)}ms`);
            console.log(`   Speedup:    ${result.speedup.toFixed(2)}x`);

            app.exit(0);
        } catch (error) {
            console.error('❌ Benchmark execution failed:', error);
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
