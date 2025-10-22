// test-toolpath-tiled.c
// Benchmark tiled terrain implementation with various tile sizes

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

// Simple STL parser (binary format only)
typedef struct {
    float* vertices;
    int triangle_count;
} STLMesh;

STLMesh* load_stl_binary(const char* filename) {
    FILE* file = fopen(filename, "rb");
    if (!file) {
        printf("Error: Cannot open file %s\n", filename);
        return NULL;
    }

    fseek(file, 80, SEEK_SET);
    uint32_t triangle_count;
    fread(&triangle_count, 4, 1, file);
    printf("Loading %u triangles from %s\n", triangle_count, filename);

    STLMesh* mesh = (STLMesh*)malloc(sizeof(STLMesh));
    mesh->triangle_count = triangle_count;
    mesh->vertices = (float*)malloc(triangle_count * 9 * sizeof(float));

    for (uint32_t i = 0; i < triangle_count; i++) {
        fseek(file, 12, SEEK_CUR);  // Skip normal
        fread(&mesh->vertices[i * 9], sizeof(float), 9, file);
        fseek(file, 2, SEEK_CUR);  // Skip attribute
    }

    fclose(file);
    return mesh;
}

#include "../wasm/mesh-converter-lib.h"
#include "../wasm/toolpath-generator.c"

void run_test(const char* label, HeightMap* terrain_map, HeightMap* tool_map,
              int tile_size, int x_step, int y_step) {
    printf("\n--- %s (tile_size=%d) ---\n", label, tile_size);

    // Convert to sparse tool
    clock_t start = clock();
    SparseTool* sparse_tool = create_sparse_tool_from_map(tool_map);
    clock_t sparse_time = clock() - start;
    printf("Sparse tool conversion: %.3f ms\n", (double)sparse_time / CLOCKS_PER_SEC * 1000.0);

    // Create tiled terrain
    start = clock();
    TiledTerrain* tiled = create_tiled_terrain(terrain_map, tile_size);
    clock_t tile_time = clock() - start;
    printf("Tiled terrain creation: %.3f ms (%dx%d tiles)\n",
           (double)tile_time / CLOCKS_PER_SEC * 1000.0,
           tiled->tiles_x, tiled->tiles_y);

    // Generate toolpath
    start = clock();
    ToolPath* path = generate_toolpath_tiled(tiled, sparse_tool, x_step, y_step, -100.0f);
    clock_t path_time = clock() - start;

    printf("Toolpath generation: %.3f ms (%.3f s)\n",
           (double)path_time / CLOCKS_PER_SEC * 1000.0,
           (double)path_time / CLOCKS_PER_SEC);
    printf("Output: %d x %d = %d points\n",
           path->points_per_line, path->num_scanlines,
           path->points_per_line * path->num_scanlines);

    // Cleanup
    free_toolpath(path);
    free_tiled_terrain(tiled);
    free_sparse_tool(sparse_tool);
}

int main(int argc, char** argv) {
    if (argc < 3) {
        printf("Usage: %s <terrain.stl> <tool.stl> [step_size] [x_step] [y_step]\n", argv[0]);
        return 1;
    }

    const char* terrain_file = argv[1];
    const char* tool_file = argv[2];
    float step_size = argc > 3 ? atof(argv[3]) : 0.05f;
    int x_step = argc > 4 ? atoi(argv[4]) : 5;
    int y_step = argc > 5 ? atoi(argv[5]) : 5;

    printf("\n=== Tiled Terrain Benchmark ===\n");
    printf("Step size: %.2fmm\n", step_size);
    printf("X/Y steps: %d/%d\n\n", x_step, y_step);

    // Load and convert terrain
    STLMesh* terrain_stl = load_stl_binary(terrain_file);
    if (!terrain_stl) return 1;

    clock_t start = clock();
    int terrain_point_count;
    float* terrain_points = convert_to_point_mesh(
        terrain_stl->vertices,
        terrain_stl->triangle_count,
        step_size,
        &terrain_point_count,
        0
    );
    printf("Terrain: %d points in %.3f seconds\n\n",
           terrain_point_count,
           (double)(clock() - start) / CLOCKS_PER_SEC);

    // Load and convert tool
    STLMesh* tool_stl = load_stl_binary(tool_file);
    if (!tool_stl) return 1;

    start = clock();
    int tool_point_count;
    float* tool_points = convert_to_point_mesh(
        tool_stl->vertices,
        tool_stl->triangle_count,
        step_size,
        &tool_point_count,
        1
    );
    printf("Tool: %d points in %.3f seconds\n",
           tool_point_count,
           (double)(clock() - start) / CLOCKS_PER_SEC);

    // Create height maps
    HeightMap* terrain_map = create_terrain_map(terrain_points, terrain_point_count, step_size);
    HeightMap* tool_map = create_tool_map(tool_points, tool_point_count, step_size);

    printf("Terrain map: %d x %d\n", terrain_map->width, terrain_map->height);
    printf("Tool map: %d x %d\n", tool_map->width, tool_map->height);

    // Benchmark different tile sizes
    int tile_sizes[] = {64, 128, 198, 256, 512, 1024};
    int num_tile_sizes = sizeof(tile_sizes) / sizeof(tile_sizes[0]);

    for (int i = 0; i < num_tile_sizes; i++) {
        run_test("Tiled", terrain_map, tool_map, tile_sizes[i], x_step, y_step);
    }

    // Also benchmark non-tiled for comparison
    printf("\n--- Non-tiled (baseline) ---\n");
    SparseTool* sparse_tool = create_sparse_tool_from_map(tool_map);
    start = clock();
    ToolPath* baseline_path = generate_toolpath_sparse(terrain_map, sparse_tool, x_step, y_step, -100.0f);
    clock_t baseline_time = clock() - start;
    printf("Toolpath generation: %.3f ms (%.3f s)\n",
           (double)baseline_time / CLOCKS_PER_SEC * 1000.0,
           (double)baseline_time / CLOCKS_PER_SEC);
    free_toolpath(baseline_path);
    free_sparse_tool(sparse_tool);

    // Cleanup
    free_height_map(tool_map);
    free_height_map(terrain_map);
    free(tool_stl->vertices);
    free(tool_stl);
    free(terrain_stl->vertices);
    free(terrain_stl);

    printf("\n=== Test Complete ===\n");
    return 0;
}
