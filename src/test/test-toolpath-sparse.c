// test-toolpath-sparse.c
// CLI test for sparse tool representation algorithm

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

// Simple STL parser (binary format only)
typedef struct {
    float* vertices;  // Flat array of vertices (x,y,z per vertex)
    int triangle_count;
} STLMesh;

STLMesh* load_stl_binary(const char* filename) {
    FILE* file = fopen(filename, "rb");
    if (!file) {
        printf("Error: Cannot open file %s\n", filename);
        return NULL;
    }

    // Skip header (80 bytes)
    fseek(file, 80, SEEK_SET);

    // Read triangle count
    uint32_t triangle_count;
    fread(&triangle_count, 4, 1, file);
    printf("Loading %u triangles from %s\n", triangle_count, filename);

    // Allocate vertices array (9 floats per triangle)
    STLMesh* mesh = (STLMesh*)malloc(sizeof(STLMesh));
    mesh->triangle_count = triangle_count;
    mesh->vertices = (float*)malloc(triangle_count * 9 * sizeof(float));

    // Read triangles
    for (uint32_t i = 0; i < triangle_count; i++) {
        // Skip normal (12 bytes)
        fseek(file, 12, SEEK_CUR);

        // Read 3 vertices (9 floats)
        fread(&mesh->vertices[i * 9], sizeof(float), 9, file);

        // Skip attribute (2 bytes)
        fseek(file, 2, SEEK_CUR);
    }

    fclose(file);
    return mesh;
}

// Stub mesh converter - we'll use pre-converted points
#include "../wasm/mesh-converter-lib.h"

// Include toolpath generator
#include "../wasm/toolpath-generator.c"

int main(int argc, char** argv) {
    if (argc < 3) {
        printf("Usage: %s <terrain.stl> <tool.stl> [step_size] [x_step] [y_step]\n", argv[0]);
        return 1;
    }

    const char* terrain_file = argv[1];
    const char* tool_file = argv[2];
    float step_size = argc > 3 ? atof(argv[3]) : 0.5f;
    int x_step = argc > 4 ? atoi(argv[4]) : 5;
    int y_step = argc > 5 ? atoi(argv[5]) : 5;

    printf("\n=== Sparse Tool Algorithm Test ===\n");
    printf("Step size: %.2fmm\n", step_size);
    printf("X/Y steps: %d/%d\n", x_step, y_step);

    // Load and convert terrain
    printf("\n--- Converting Terrain ---\n");
    STLMesh* terrain_stl = load_stl_binary(terrain_file);
    if (!terrain_stl) return 1;

    clock_t start = clock();
    int terrain_point_count;
    float* terrain_points = convert_to_point_mesh(
        terrain_stl->vertices,
        terrain_stl->triangle_count,
        step_size,
        &terrain_point_count,
        0  // FILTER_UPWARD_FACING
    );
    clock_t terrain_time = clock() - start;
    printf("Terrain: %d points in %.3f seconds\n",
           terrain_point_count,
           (double)terrain_time / CLOCKS_PER_SEC);

    // Load and convert tool
    printf("\n--- Converting Tool ---\n");
    STLMesh* tool_stl = load_stl_binary(tool_file);
    if (!tool_stl) return 1;

    start = clock();
    int tool_point_count;
    float* tool_points = convert_to_point_mesh(
        tool_stl->vertices,
        tool_stl->triangle_count,
        step_size,
        &tool_point_count,
        1  // FILTER_DOWNWARD_FACING
    );
    clock_t tool_time = clock() - start;
    printf("Tool: %d points in %.3f seconds\n",
           tool_point_count,
           (double)tool_time / CLOCKS_PER_SEC);

    // Create height maps
    printf("\n--- Creating Height Maps ---\n");
    start = clock();
    HeightMap* terrain_map = create_terrain_map(terrain_points, terrain_point_count, step_size);
    HeightMap* tool_map = create_tool_map(tool_points, tool_point_count, step_size);
    clock_t map_time = clock() - start;

    printf("Terrain map: %d x %d (%.3f seconds)\n",
           terrain_map->width, terrain_map->height,
           (double)map_time / CLOCKS_PER_SEC);
    printf("Tool map: %d x %d\n", tool_map->width, tool_map->height);

    // Convert tool to sparse representation
    printf("\n--- Converting Tool to Sparse ---\n");
    start = clock();
    SparseTool* sparse_tool = create_sparse_tool_from_map(tool_map);
    clock_t sparse_time = clock() - start;
    printf("Sparse tool: %d points (%.6f seconds)\n", sparse_tool->count,
           (double)sparse_time / CLOCKS_PER_SEC);
    printf("Sparsity: %.1f%% (dense would be %d points)\n",
           100.0 * sparse_tool->count / (tool_map->width * tool_map->height),
           tool_map->width * tool_map->height);

    // Generate toolpath using SPARSE algorithm
    printf("\n--- Generating Toolpath (SPARSE) ---\n");
    start = clock();
    ToolPath* sparse_path = generate_toolpath_sparse(terrain_map, sparse_tool, x_step, y_step, -100.0f);
    clock_t sparse_path_time = clock() - start;

    printf("Toolpath: %d x %d = %d points\n",
           sparse_path->points_per_line, sparse_path->num_scanlines,
           sparse_path->points_per_line * sparse_path->num_scanlines);
    printf("Generation time: %.6f seconds (%.3f ms)\n",
           (double)sparse_path_time / CLOCKS_PER_SEC,
           (double)sparse_path_time / CLOCKS_PER_SEC * 1000.0);

    // For comparison, also run dense algorithm
    printf("\n--- Generating Toolpath (DENSE - for comparison) ---\n");
    start = clock();
    ToolPath* dense_path = generate_toolpath_dense(terrain_map, tool_map, x_step, y_step, -100.0f);
    clock_t dense_path_time = clock() - start;

    printf("Toolpath: %d x %d = %d points\n",
           dense_path->points_per_line, dense_path->num_scanlines,
           dense_path->points_per_line * dense_path->num_scanlines);
    printf("Generation time: %.6f seconds (%.3f ms)\n",
           (double)dense_path_time / CLOCKS_PER_SEC,
           (double)dense_path_time / CLOCKS_PER_SEC * 1000.0);

    // Calculate speedup
    double speedup = (double)dense_path_time / (double)sparse_path_time;
    printf("\n=== Performance Comparison ===\n");
    printf("Dense:  %.3f ms\n", (double)dense_path_time / CLOCKS_PER_SEC * 1000.0);
    printf("Sparse: %.3f ms\n", (double)sparse_path_time / CLOCKS_PER_SEC * 1000.0);
    printf("Speedup: %.2fx\n", speedup);

    // Verify results match (all points)
    printf("\n--- Verification ---\n");
    int total_points = sparse_path->num_scanlines * sparse_path->points_per_line;
    int mismatches = 0;
    float max_diff = 0.0f;
    int max_diff_idx = -1;

    for (int i = 0; i < total_points; i++) {
        float sparse_z = sparse_path->path_data[i];
        float dense_z = dense_path->path_data[i];
        float diff = fabs(sparse_z - dense_z);

        if (diff > max_diff) {
            max_diff = diff;
            max_diff_idx = i;
        }

        if (diff > 0.001f) {
            if (mismatches < 10) {  // Only print first 10 mismatches
                printf("Mismatch at point %d: sparse=%.6f, dense=%.6f, diff=%.6f\n",
                       i, sparse_z, dense_z, diff);
            }
            mismatches++;
        }
    }

    printf("Checked %d total points\n", total_points);
    printf("Maximum difference: %.6f at point %d\n", max_diff, max_diff_idx);

    if (mismatches == 0) {
        printf("✓ All points match between sparse and dense algorithms (within 0.001 tolerance)\n");
    } else {
        printf("✗ Found %d mismatches out of %d points (%.2f%%)\n",
               mismatches, total_points, 100.0 * mismatches / total_points);
    }

    // Cleanup
    free_toolpath(sparse_path);
    free_toolpath(dense_path);
    free_sparse_tool(sparse_tool);
    free_height_map(tool_map);
    free_height_map(terrain_map);
    free(tool_stl->vertices);
    free(tool_stl);
    free(terrain_stl->vertices);
    free(terrain_stl);

    printf("\n=== Test Complete ===\n");
    return 0;
}
