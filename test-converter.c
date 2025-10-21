#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

// Include the mesh converter code
typedef struct {
    float x, y, z;
} Vec3;

typedef struct {
    Vec3 min;
    Vec3 max;
} BoundingBox;

typedef struct {
    Vec3 v0, v1, v2;
} Triangle;

// Global storage for output points
static float* output_points = NULL;
static int output_capacity = 0;
static int output_count = 0;
static BoundingBox bounds;

// Function prototypes
void calculate_bounds(float* triangles, int triangle_count);
int ray_triangle_intersect(Vec3 ray_origin, Vec3 ray_dir, Triangle tri, Vec3* out_point);
void add_point(Vec3 point);
float* convert_to_point_mesh(float* triangles, int triangle_count, float step_size, int* out_point_count);
void get_bounds(float* out_bounds);
void free_output();

// Helper function implementations
void calculate_bounds(float* triangles, int triangle_count) {
    bounds.min.x = bounds.min.y = bounds.min.z = 1e10f;
    bounds.max.x = bounds.max.y = bounds.max.z = -1e10f;

    for (int i = 0; i < triangle_count * 9; i += 3) {
        float x = triangles[i];
        float y = triangles[i + 1];
        float z = triangles[i + 2];

        if (x < bounds.min.x) bounds.min.x = x;
        if (y < bounds.min.y) bounds.min.y = y;
        if (z < bounds.min.z) bounds.min.z = z;

        if (x > bounds.max.x) bounds.max.x = x;
        if (y > bounds.max.y) bounds.max.y = y;
        if (z > bounds.max.z) bounds.max.z = z;
    }
}

int ray_triangle_intersect(Vec3 ray_origin, Vec3 ray_dir, Triangle tri, Vec3* out_point) {
    const float EPSILON = 0.0000001f;
    Vec3 edge1, edge2, h, s, q;
    float a, f, u, v, t;

    edge1.x = tri.v1.x - tri.v0.x;
    edge1.y = tri.v1.y - tri.v0.y;
    edge1.z = tri.v1.z - tri.v0.z;

    edge2.x = tri.v2.x - tri.v0.x;
    edge2.y = tri.v2.y - tri.v0.y;
    edge2.z = tri.v2.z - tri.v0.z;

    h.x = ray_dir.y * edge2.z - ray_dir.z * edge2.y;
    h.y = ray_dir.z * edge2.x - ray_dir.x * edge2.z;
    h.z = ray_dir.x * edge2.y - ray_dir.y * edge2.x;

    a = edge1.x * h.x + edge1.y * h.y + edge1.z * h.z;

    if (a > -EPSILON && a < EPSILON)
        return 0;

    f = 1.0f / a;

    s.x = ray_origin.x - tri.v0.x;
    s.y = ray_origin.y - tri.v0.y;
    s.z = ray_origin.z - tri.v0.z;

    u = f * (s.x * h.x + s.y * h.y + s.z * h.z);

    if (u < 0.0f || u > 1.0f)
        return 0;

    q.x = s.y * edge1.z - s.z * edge1.y;
    q.y = s.z * edge1.x - s.x * edge1.z;
    q.z = s.x * edge1.y - s.y * edge1.x;

    v = f * (ray_dir.x * q.x + ray_dir.y * q.y + ray_dir.z * q.z);

    if (v < 0.0f || u + v > 1.0f)
        return 0;

    t = f * (edge2.x * q.x + edge2.y * q.y + edge2.z * q.z);

    if (t > EPSILON) {
        out_point->x = ray_origin.x + ray_dir.x * t;
        out_point->y = ray_origin.y + ray_dir.y * t;
        out_point->z = ray_origin.z + ray_dir.z * t;
        return 1;
    }

    return 0;
}

void add_point(Vec3 point) {
    if (output_count >= output_capacity) {
        output_capacity = output_capacity == 0 ? 1024 : output_capacity * 2;
        output_points = (float*)realloc(output_points, output_capacity * 3 * sizeof(float));
    }

    output_points[output_count * 3] = point.x;
    output_points[output_count * 3 + 1] = point.y;
    output_points[output_count * 3 + 2] = point.z;
    output_count++;
}

float* convert_to_point_mesh(float* triangles, int triangle_count, float step_size, int* out_point_count) {
    if (output_points != NULL) {
        free(output_points);
        output_points = NULL;
    }
    output_capacity = 0;
    output_count = 0;

    calculate_bounds(triangles, triangle_count);

    Triangle* tris = (Triangle*)malloc(triangle_count * sizeof(Triangle));
    for (int i = 0; i < triangle_count; i++) {
        int base = i * 9;
        tris[i].v0.x = triangles[base];
        tris[i].v0.y = triangles[base + 1];
        tris[i].v0.z = triangles[base + 2];
        tris[i].v1.x = triangles[base + 3];
        tris[i].v1.y = triangles[base + 4];
        tris[i].v1.z = triangles[base + 5];
        tris[i].v2.x = triangles[base + 6];
        tris[i].v2.y = triangles[base + 7];
        tris[i].v2.z = triangles[base + 8];
    }

    Vec3 ray_dir = {0.0f, 0.0f, 1.0f};

    for (float x = bounds.min.x; x <= bounds.max.x; x += step_size) {
        for (float y = bounds.min.y; y <= bounds.max.y; y += step_size) {
            Vec3 ray_origin = {x, y, bounds.min.z - 1.0f};

            for (int t = 0; t < triangle_count; t++) {
                Vec3 intersection;
                if (ray_triangle_intersect(ray_origin, ray_dir, tris[t], &intersection)) {
                    add_point(intersection);
                }
            }
        }
    }

    free(tris);

    *out_point_count = output_count;
    return output_points;
}

void get_bounds(float* out_bounds) {
    out_bounds[0] = bounds.min.x;
    out_bounds[1] = bounds.min.y;
    out_bounds[2] = bounds.min.z;
    out_bounds[3] = bounds.max.x;
    out_bounds[4] = bounds.max.y;
    out_bounds[5] = bounds.max.z;
}

void free_output() {
    if (output_points != NULL) {
        free(output_points);
        output_points = NULL;
    }
    output_capacity = 0;
    output_count = 0;
}

// STL parsing functions
typedef struct {
    float* positions;
    int triangle_count;
} STLData;

STLData parse_binary_stl(const char* filename) {
    FILE* file = fopen(filename, "rb");
    if (!file) {
        fprintf(stderr, "Error: Cannot open file %s\n", filename);
        STLData empty = {NULL, 0};
        return empty;
    }

    // Read header (80 bytes)
    char header[80];
    fread(header, 1, 80, file);

    // Read triangle count
    uint32_t triangle_count;
    fread(&triangle_count, 4, 1, file);

    printf("Binary STL: %u triangles\n", triangle_count);

    // Allocate positions array
    float* positions = (float*)malloc(triangle_count * 9 * sizeof(float));

    // Read triangles
    for (uint32_t i = 0; i < triangle_count; i++) {
        // Skip normal (12 bytes)
        float normal[3];
        fread(normal, 4, 3, file);

        // Read vertices (3 vertices * 3 floats)
        fread(&positions[i * 9], 4, 9, file);

        // Skip attribute byte count (2 bytes)
        uint16_t attr;
        fread(&attr, 2, 1, file);
    }

    fclose(file);

    STLData result = {positions, triangle_count};
    return result;
}

// Test program
int main(int argc, char* argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <stl_file> [step_size]\n", argv[0]);
        return 1;
    }

    const char* filename = argv[1];
    float step_size = (argc > 2) ? atof(argv[2]) : 0.05f;

    printf("Loading STL file: %s\n", filename);
    printf("Step size: %.3f\n", step_size);

    // Parse STL
    STLData stl = parse_binary_stl(filename);
    if (!stl.positions) {
        return 1;
    }

    printf("Triangles loaded: %d\n", stl.triangle_count);
    printf("Position array size: %d floats\n", stl.triangle_count * 9);

    // Print first triangle as sanity check
    printf("\nFirst triangle:\n");
    printf("  v0: (%.3f, %.3f, %.3f)\n", stl.positions[0], stl.positions[1], stl.positions[2]);
    printf("  v1: (%.3f, %.3f, %.3f)\n", stl.positions[3], stl.positions[4], stl.positions[5]);
    printf("  v2: (%.3f, %.3f, %.3f)\n", stl.positions[6], stl.positions[7], stl.positions[8]);

    // Convert to point mesh
    printf("\nConverting to point mesh...\n");
    int point_count = 0;
    float* points = convert_to_point_mesh(stl.positions, stl.triangle_count, step_size, &point_count);

    printf("Points generated: %d\n", point_count);

    // Get bounds
    float bounds_data[6];
    get_bounds(bounds_data);
    printf("\nBounding box:\n");
    printf("  Min: (%.3f, %.3f, %.3f)\n", bounds_data[0], bounds_data[1], bounds_data[2]);
    printf("  Max: (%.3f, %.3f, %.3f)\n", bounds_data[3], bounds_data[4], bounds_data[5]);
    printf("  Size: (%.3f, %.3f, %.3f)\n",
           bounds_data[3] - bounds_data[0],
           bounds_data[4] - bounds_data[1],
           bounds_data[5] - bounds_data[2]);

    // Calculate expected grid size
    float x_range = bounds_data[3] - bounds_data[0];
    float y_range = bounds_data[4] - bounds_data[1];
    int x_steps = (int)(x_range / step_size) + 1;
    int y_steps = (int)(y_range / step_size) + 1;
    printf("\nGrid size: %d x %d = %d rays\n", x_steps, y_steps, x_steps * y_steps);

    // Print a few sample points
    if (point_count > 0) {
        printf("\nFirst 5 points:\n");
        int samples = point_count < 5 ? point_count : 5;
        for (int i = 0; i < samples; i++) {
            printf("  Point %d: (%.3f, %.3f, %.3f)\n", i,
                   points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
        }
    }

    // Cleanup
    free(stl.positions);
    free_output();

    return 0;
}
