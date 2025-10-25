// radial-toolpath-test.cjs
// Test for radial toolpath generation (lathe-like operation)
// Tests terrain rotation + strip rasterization + scanline generation

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, '../../test-output');
const RADIAL_OUTPUT = path.join(OUTPUT_DIR, 'radial-toolpath-output.txt');

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
                try {
                console.log('=== Radial Toolpath Test ===');

                if (!navigator.gpu) {
                    return { error: 'WebGPU not available' };
                }
                console.log('✓ WebGPU available');

                // Import RasterPath API
                const { RasterPath } = await import('./raster-path.js');

                // Initialize RasterPath
                const rasterPath = new RasterPath();
                await rasterPath.init();
                console.log('✓ RasterPath initialized');

                // Initialize worker pool for parallel processing
                try {
                    await rasterPath.initWorkerPool();
                    console.log('✓ Worker pool initialized');
                } catch (error) {
                    console.warn('Failed to initialize worker pool:', error);
                }

                // Generate test terrain: simple cone
                // This is a good test for radial mode since it's rotationally symmetric
                const terrainTriangles = [];
                const coneRadius = 20;
                const coneHeight = 30;
                const segments = 16;

                // Generate cone triangles
                for (let i = 0; i < segments; i++) {
                    const theta1 = (i / segments) * 2 * Math.PI;
                    const theta2 = ((i + 1) / segments) * 2 * Math.PI;

                    // Bottom circle point 1
                    const x1 = coneRadius * Math.cos(theta1);
                    const y1 = coneRadius * Math.sin(theta1);
                    const z1 = 0;

                    // Bottom circle point 2
                    const x2 = coneRadius * Math.cos(theta2);
                    const y2 = coneRadius * Math.sin(theta2);
                    const z2 = 0;

                    // Top center point
                    const x3 = 0;
                    const y3 = 0;
                    const z3 = coneHeight;

                    // Triangle forming side of cone
                    terrainTriangles.push(
                        x1, y1, z1,
                        x2, y2, z2,
                        x3, y3, z3
                    );

                    // Bottom cap triangle
                    terrainTriangles.push(
                        0, 0, 0,
                        x1, y1, z1,
                        x2, y2, z2
                    );
                }

                const triangles = new Float32Array(terrainTriangles);
                console.log(\`✓ Generated cone: \${terrainTriangles.length/9} triangles\`);

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
                console.log('✓ Terrain bounds:', terrainBounds);

                // Generate simple ball tool (sphere)
                const toolTriangles = [];
                const toolRadius = 5;
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

                        toolTriangles.push(
                            x1, y1, z1,
                            x2, y2, z2,
                            x3, y3, z3
                        );
                        toolTriangles.push(
                            x1, y1, z1,
                            x3, y3, z3,
                            x4, y4, z4
                        );
                    }
                }

                const tool = new Float32Array(toolTriangles);
                console.log(\`✓ Generated tool: \${toolTriangles.length/9} triangles\`);

                // Rasterize tool
                const stepSize = 1.0; // 1mm grid
                const toolResult = await rasterPath.rasterizeMesh(tool, stepSize, 1); // filterMode=1 for min Z (tool)
                console.log(\`✓ Tool rasterized: \${toolResult.pointCount} points\`);

                // Generate radial toolpath
                const xRotationStep = 30; // degrees (12 rotations for 360°)
                const xStep = 5; // sample every 5 grid points along X
                const zFloor = -50;

                console.log('Generating radial toolpath...');
                console.log(\`  Rotation step: \${xRotationStep}°\`);
                console.log(\`  X step: \${xStep} points\`);
                console.log(\`  Z floor: \${zFloor} mm\`);
                console.log(\`  Grid step: \${stepSize} mm\`);

                const startTime = performance.now();
                const result = await rasterPath.generateRadialToolpath(
                    triangles,
                    toolResult.positions,
                    xRotationStep,
                    xStep,
                    zFloor,
                    stepSize,
                    terrainBounds
                );
                const endTime = performance.now();

                console.log(\`✓ Radial toolpath generated in \${(endTime - startTime).toFixed(1)}ms\`);
                console.log(\`  Rotations: \${result.numRotations}\`);
                console.log(\`  Points per line: \${result.pointsPerLine}\`);
                console.log(\`  Total points: \${result.pathData.length}\`);

                // Validate output
                const expectedRotations = Math.floor(360 / xRotationStep);
                if (result.numRotations !== expectedRotations) {
                    return {
                        error: \`Expected \${expectedRotations} rotations, got \${result.numRotations}\`
                    };
                }

                // Check for reasonable Z values
                let outputMinZ = Infinity, outputMaxZ = -Infinity;
                let floorCount = 0;
                for (let i = 0; i < result.pathData.length; i++) {
                    const z = result.pathData[i];
                    if (z === zFloor) floorCount++;
                    outputMinZ = Math.min(outputMinZ, z);
                    outputMaxZ = Math.max(outputMaxZ, z);
                }

                console.log(\`  Z range: [\${outputMinZ.toFixed(2)}, \${outputMaxZ.toFixed(2)}]\`);
                console.log(\`  Floor values: \${floorCount} / \${result.pathData.length}\`);

                // Check first rotation (should be similar values since cone is symmetric)
                const firstRotation = result.pathData.slice(0, result.pointsPerLine);
                console.log('  First rotation (first 10 points):',
                    Array.from(firstRotation.slice(0, 10)).map(v => v.toFixed(2)).join(', '));

                return {
                    success: true,
                    numRotations: result.numRotations,
                    pointsPerLine: result.pointsPerLine,
                    totalPoints: result.pathData.length,
                    generationTime: endTime - startTime,
                    zRange: { min: outputMinZ, max: outputMaxZ },
                    floorCount,
                    pathData: Array.from(result.pathData)
                };
                } catch (error) {
                    console.error('Test script error:', error);
                    return { error: error.message, stack: error.stack };
                }
            })();
        `;

        try {
            const result = await mainWindow.webContents.executeJavaScript(testScript);

            if (result.error) {
                console.error('❌ Test failed:', result.error);
                app.exit(1);
                return;
            }

            console.log('\n=== Test Results ===');
            console.log('✅ Radial toolpath generation successful');
            console.log(`   Rotations: ${result.numRotations}`);
            console.log(`   Points per line: ${result.pointsPerLine}`);
            console.log(`   Total points: ${result.totalPoints}`);
            console.log(`   Generation time: ${result.generationTime.toFixed(1)}ms`);
            console.log(`   Z range: [${result.zRange.min.toFixed(2)}, ${result.zRange.max.toFixed(2)}]`);
            console.log(`   Floor values: ${result.floorCount} / ${result.totalPoints}`);

            // Save output for inspection
            const output = {
                timestamp: new Date().toISOString(),
                ...result
            };
            fs.writeFileSync(RADIAL_OUTPUT, JSON.stringify(output, null, 2));
            console.log(`\n📝 Output saved to: ${RADIAL_OUTPUT}`);

            console.log('\n✅ All tests passed');
            app.exit(0);
        } catch (error) {
            console.error('❌ Test execution failed:', error);
            app.exit(1);
        }
    });

    mainWindow.webContents.on('console-message', (event, level, message) => {
        console.log(`[Renderer]`, message);
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    app.quit();
});
