// planar-vs-radial-test.cjs
// Compare planar midline vs radial scanline to verify padding consistency

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
                    console.log('=== Planar vs Radial Padding Test ===');

                    if (!navigator.gpu) {
                        return { error: 'WebGPU not available' };
                    }

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

                    // Test with padding: +50mm on X axis
                    const paddedBounds = {
                        min: { x: -70, y: -20, z: 0 },
                        max: { x: 70, y: 20, z: cylHeight }
                    };

                    const xStep = 5;
                    const yStep = 5;
                    const zFloor = -100;

                    console.log('\\n=== Generating Planar Toolpath ===');
                    const planarResult = await rasterPath.generatePlanarToolpath(
                        triangles,
                        toolResult.positions,
                        xStep,
                        yStep,
                        zFloor,
                        stepSize,
                        paddedBounds
                    );

                    console.log(\`Points per line: \${planarResult.pointsPerLine}\`);
                    console.log(\`Number of lines: \${planarResult.numLines}\`);

                    // Extract middle line from planar (y=0 is at index numLines/2)
                    const midLineIndex = Math.floor(planarResult.numLines / 2);
                    const planarMidline = Array.from(
                        planarResult.pathData.slice(
                            midLineIndex * planarResult.pointsPerLine,
                            (midLineIndex + 1) * planarResult.pointsPerLine
                        )
                    );
                    console.log(\`Planar midline (line \${midLineIndex}): \${planarMidline.length} points\`);
                    console.log(\`First 10: \${planarMidline.slice(0, 10).map(v => v.toFixed(2)).join(', ')}\`);

                    console.log('\\n=== Generating Radial Toolpath (0° only) ===');
                    const radialResult = await rasterPath.generateRadialToolpath(
                        triangles,
                        toolResult.positions,
                        360,  // Only one rotation at 0°
                        xStep,
                        zFloor,
                        stepSize,
                        paddedBounds
                    );

                    console.log(\`Points per line: \${radialResult.pointsPerLine}\`);
                    console.log(\`Number of rotations: \${radialResult.numRotations}\`);

                    const radialScanline = Array.from(radialResult.pathData);
                    console.log(\`Radial scanline: \${radialScanline.length} points\`);
                    console.log(\`First 10: \${radialScanline.slice(0, 10).map(v => v.toFixed(2)).join(', ')}\`);

                    // Compare lengths
                    console.log('\\n=== Comparison ===');
                    console.log(\`Planar midline length: \${planarMidline.length}\`);
                    console.log(\`Radial scanline length: \${radialScanline.length}\`);

                    if (planarMidline.length !== radialScanline.length) {
                        return {
                            error: \`Length mismatch! Planar: \${planarMidline.length}, Radial: \${radialScanline.length}\`
                        };
                    }

                    // Compare values
                    let maxDiff = 0;
                    let diffCount = 0;
                    const threshold = 0.1; // 0.1mm tolerance

                    for (let i = 0; i < planarMidline.length; i++) {
                        const diff = Math.abs(planarMidline[i] - radialScanline[i]);
                        if (diff > threshold) {
                            diffCount++;
                            maxDiff = Math.max(maxDiff, diff);
                        }
                    }

                    console.log(\`Max difference: \${maxDiff.toFixed(3)}mm\`);
                    console.log(\`Points with diff > \${threshold}mm: \${diffCount} / \${planarMidline.length}\`);

                    if (maxDiff > 1.0) {
                        return {
                            error: \`Large difference detected: \${maxDiff.toFixed(3)}mm\`,
                            planarMidline,
                            radialScanline
                        };
                    }

                    console.log('\\n✅ Planar and radial match (within tolerance)');
                    return {
                        success: true,
                        planarLength: planarMidline.length,
                        radialLength: radialScanline.length,
                        maxDiff,
                        diffCount,
                        planarMidline,
                        radialScanline
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
            console.log('✅ Planar vs Radial comparison successful');
            console.log(`   Planar midline: ${result.planarLength} points`);
            console.log(`   Radial scanline: ${result.radialLength} points`);
            console.log(`   Max difference: ${result.maxDiff.toFixed(3)}mm`);
            console.log(`   Points with significant diff: ${result.diffCount}`);

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
