// radial-padding-test.cjs
// Test that X-axis padding actually increases radial toolpath span

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
                    console.log('=== Radial Padding Test ===');

                    if (!navigator.gpu) {
                        return { error: 'WebGPU not available' };
                    }

                    // Import RasterPath API
                    const { RasterPath } = await import('./raster-path.js');
                    const rasterPath = new RasterPath();
                    await rasterPath.init();
                    console.log('✓ RasterPath initialized');

                    // Generate simple cylinder
                    const cylRadius = 20;
                    const cylHeight = 30;
                    const segments = 16;

                    const terrainTriangles = [];
                    for (let i = 0; i < segments; i++) {
                        const theta1 = (i / segments) * 2 * Math.PI;
                        const theta2 = ((i + 1) / segments) * 2 * Math.PI;

                        const x1 = cylRadius * Math.cos(theta1);
                        const y1 = cylRadius * Math.sin(theta1);
                        const x2 = cylRadius * Math.cos(theta2);
                        const y2 = cylRadius * Math.sin(theta2);

                        // Side face
                        terrainTriangles.push(
                            x1, y1, 0,
                            x2, y2, 0,
                            x1, y1, cylHeight
                        );
                        terrainTriangles.push(
                            x2, y2, 0,
                            x2, y2, cylHeight,
                            x1, y1, cylHeight
                        );

                        // Top cap
                        terrainTriangles.push(
                            0, 0, cylHeight,
                            x1, y1, cylHeight,
                            x2, y2, cylHeight
                        );
                    }

                    const triangles = new Float32Array(terrainTriangles);
                    console.log(\`✓ Generated cylinder: \${terrainTriangles.length/9} triangles\`);

                    // Generate ball tool
                    const toolRadius = 5;
                    const toolSegments = 8;
                    const toolTriangles = [];

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
                    const stepSize = 1.0;
                    const toolResult = await rasterPath.rasterizeMesh(tool, stepSize, 1);
                    console.log(\`✓ Tool rasterized: \${toolResult.pointCount} points\`);

                    // Original bounds (centered)
                    const originalBounds = {
                        min: { x: -cylRadius, y: -cylRadius, z: 0 },
                        max: { x: cylRadius, y: cylRadius, z: cylHeight }
                    };

                    // Padded bounds (add 50mm to X axis as requested)
                    const paddedBounds = {
                        min: { x: originalBounds.min.x - 50, y: originalBounds.min.y, z: originalBounds.min.z },
                        max: { x: originalBounds.max.x + 50, y: originalBounds.max.y, z: originalBounds.max.z }
                    };

                    console.log('\\n=== Test 1: Original Bounds ===');
                    console.log('X range:', originalBounds.min.x, 'to', originalBounds.max.x,
                                '(width:', originalBounds.max.x - originalBounds.min.x, 'mm)');

                    const result1 = await rasterPath.generateRadialToolpath(
                        triangles,
                        toolResult.positions,
                        30,  // rotation step
                        5,   // xStep
                        -100,
                        stepSize,
                        originalBounds
                    );

                    console.log('Points per line:', result1.pointsPerLine);
                    console.log('First scanline length:', result1.pointsPerLine);
                    const firstLine1 = Array.from(result1.pathData.slice(0, result1.pointsPerLine));
                    const nonFloorCount1 = firstLine1.filter(z => z > -99).length;
                    console.log('Non-floor points in first line:', nonFloorCount1);

                    console.log('\\n=== Test 2: Padded Bounds (+50mm X on each side) ===');
                    console.log('X range:', paddedBounds.min.x, 'to', paddedBounds.max.x,
                                '(width:', paddedBounds.max.x - paddedBounds.min.x, 'mm)');

                    const result2 = await rasterPath.generateRadialToolpath(
                        triangles,
                        toolResult.positions,
                        30,  // rotation step
                        5,   // xStep
                        -100,
                        stepSize,
                        paddedBounds
                    );

                    console.log('Points per line:', result2.pointsPerLine);
                    console.log('First scanline length:', result2.pointsPerLine);
                    const firstLine2 = Array.from(result2.pathData.slice(0, result2.pointsPerLine));
                    const nonFloorCount2 = firstLine2.filter(z => z > -99).length;
                    console.log('Non-floor points in first line:', nonFloorCount2);

                    console.log('\\n=== Comparison ===');
                    console.log('Original points per line:', result1.pointsPerLine);
                    console.log('Padded points per line:', result2.pointsPerLine);
                    console.log('Difference:', result2.pointsPerLine - result1.pointsPerLine);
                    console.log('Expected difference (100mm / 5 grid cells):', Math.floor(100 / stepSize / 5));

                    if (result2.pointsPerLine <= result1.pointsPerLine) {
                        return {
                            error: \`Padding did not increase points per line! Original: \${result1.pointsPerLine}, Padded: \${result2.pointsPerLine}\`
                        };
                    }

                    const expectedIncrease = Math.floor(100 / stepSize / 5); // 100mm padding / stepSize / xStep
                    const actualIncrease = result2.pointsPerLine - result1.pointsPerLine;

                    console.log('\\n✅ Padding test PASSED');
                    console.log('  Points per line increased from', result1.pointsPerLine, 'to', result2.pointsPerLine);
                    console.log('  Increase:', actualIncrease, 'points (expected ~', expectedIncrease, ')');

                    return {
                        success: true,
                        originalPoints: result1.pointsPerLine,
                        paddedPoints: result2.pointsPerLine,
                        increase: actualIncrease,
                        expectedIncrease
                    };

                } catch (error) {
                    console.error('Test error:', error);
                    return { error: error.message, stack: error.stack };
                }
            })();
        `;

        try {
            const result = await mainWindow.webContents.executeJavaScript(testScript);

            if (result.error) {
                console.error('❌ Test failed:', result.error);
                if (result.stack) {
                    console.error(result.stack);
                }
                app.exit(1);
                return;
            }

            console.log('\n=== Test Results ===');
            console.log('✅ Radial padding test successful');
            console.log(`   Original points per line: ${result.originalPoints}`);
            console.log(`   Padded points per line: ${result.paddedPoints}`);
            console.log(`   Increase: ${result.increase} points`);
            console.log(`   Expected: ~${result.expectedIncrease} points`);

            app.exit(0);
        } catch (error) {
            console.error('❌ Test execution failed:', error);
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
