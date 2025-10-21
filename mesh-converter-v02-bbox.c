#include <stdlib.h>
#include <math.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#define PRINTF_DEBUG 0  // Set to 1 for debug output (won't work in WASM)

typedef struct {
    float x, y, z;
} Vec3;

typedef struct {
    Vec3 min;
    Vec3 max;
} BoundingBox;

typedef struct {
    Vec3 v0, v1, v2;
    // Precomputed 2D bounding box for fast culling
    float bbox_min_x, bbox_max_x;
    float bbox_min_y, bbox_max_y;
} Triangle;

// Global storage for output points (freed by caller)
static float* output_points = NULL;
static int output_capacity = 0;
static int output_count = 0;

// Global bounding box
static BoundingBox bounds;

// Helper function to calculate bounding box
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

// Fast ray-AABB (Axis-Aligned Bounding Box) test for Z-axis rays
// Returns 1 if ray (at x,y going through Z) could hit triangle, 0 otherwise
// Uses precomputed bbox from Triangle struct
inline int ray_could_hit_triangle_bbox(float ray_x, float ray_y, Triangle* tri) {
    return (ray_x >= tri->bbox_min_x && ray_x <= tri->bbox_max_x &&
            ray_y >= tri->bbox_min_y && ray_y <= tri->bbox_max_y);
}

// Ray-triangle intersection using Möller–Trumbore algorithm
// Returns 1 if intersection found, 0 otherwise
// If found, stores intersection point in 'out_point'
int ray_triangle_intersect(Vec3 ray_origin, Vec3 ray_dir, Triangle* tri, Vec3* out_point) {
    const float EPSILON = 0.0000001f;
    Vec3 edge1, edge2, h, s, q;
    float a, f, u, v, t;

    // Quick bounding box rejection test (very cheap!)
    if (!ray_could_hit_triangle_bbox(ray_origin.x, ray_origin.y, tri)) {
        return 0;
    }

    // Calculate edges
    edge1.x = tri->v1.x - tri->v0.x;
    edge1.y = tri->v1.y - tri->v0.y;
    edge1.z = tri->v1.z - tri->v0.z;

    edge2.x = tri->v2.x - tri->v0.x;
    edge2.y = tri->v2.y - tri->v0.y;
    edge2.z = tri->v2.z - tri->v0.z;

    // Cross product: ray_dir x edge2
    h.x = ray_dir.y * edge2.z - ray_dir.z * edge2.y;
    h.y = ray_dir.z * edge2.x - ray_dir.x * edge2.z;
    h.z = ray_dir.x * edge2.y - ray_dir.y * edge2.x;

    // Dot product: edge1 · h
    a = edge1.x * h.x + edge1.y * h.y + edge1.z * h.z;

    if (a > -EPSILON && a < EPSILON)
        return 0; // Ray is parallel to triangle

    f = 1.0f / a;

    // s = ray_origin - v0
    s.x = ray_origin.x - tri->v0.x;
    s.y = ray_origin.y - tri->v0.y;
    s.z = ray_origin.z - tri->v0.z;

    // u = f * (s · h)
    u = f * (s.x * h.x + s.y * h.y + s.z * h.z);

    if (u < 0.0f || u > 1.0f)
        return 0;

    // Cross product: s x edge1
    q.x = s.y * edge1.z - s.z * edge1.y;
    q.y = s.z * edge1.x - s.x * edge1.z;
    q.z = s.x * edge1.y - s.y * edge1.x;

    // v = f * (ray_dir · q)
    v = f * (ray_dir.x * q.x + ray_dir.y * q.y + ray_dir.z * q.z);

    if (v < 0.0f || u + v > 1.0f)
        return 0;

    // t = f * (edge2 · q)
    t = f * (edge2.x * q.x + edge2.y * q.y + edge2.z * q.z);

    if (t > EPSILON) {
        // Intersection found - calculate point
        out_point->x = ray_origin.x + ray_dir.x * t;
        out_point->y = ray_origin.y + ray_dir.y * t;
        out_point->z = ray_origin.z + ray_dir.z * t;
        return 1;
    }

    return 0;
}

// Add a point to the output array
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

// Main conversion function
EXPORT
float* convert_to_point_mesh(float* triangles, int triangle_count, float step_size, int* out_point_count) {
    // Reset output
    if (output_points != NULL) {
        free(output_points);
        output_points = NULL;
    }
    output_capacity = 0;
    output_count = 0;

    // Calculate bounding box
    calculate_bounds(triangles, triangle_count);

    // Parse triangles into array and precompute bounding boxes
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

        // Precompute 2D bounding box for fast ray culling
        tris[i].bbox_min_x = tris[i].v0.x;
        tris[i].bbox_max_x = tris[i].v0.x;
        tris[i].bbox_min_y = tris[i].v0.y;
        tris[i].bbox_max_y = tris[i].v0.y;

        if (tris[i].v1.x < tris[i].bbox_min_x) tris[i].bbox_min_x = tris[i].v1.x;
        if (tris[i].v1.x > tris[i].bbox_max_x) tris[i].bbox_max_x = tris[i].v1.x;
        if (tris[i].v1.y < tris[i].bbox_min_y) tris[i].bbox_min_y = tris[i].v1.y;
        if (tris[i].v1.y > tris[i].bbox_max_y) tris[i].bbox_max_y = tris[i].v1.y;

        if (tris[i].v2.x < tris[i].bbox_min_x) tris[i].bbox_min_x = tris[i].v2.x;
        if (tris[i].v2.x > tris[i].bbox_max_x) tris[i].bbox_max_x = tris[i].v2.x;
        if (tris[i].v2.y < tris[i].bbox_min_y) tris[i].bbox_min_y = tris[i].v2.y;
        if (tris[i].v2.y > tris[i].bbox_max_y) tris[i].bbox_max_y = tris[i].v2.y;
    }

    // Ray direction (pointing down -Z to +Z)
    Vec3 ray_dir = {0.0f, 0.0f, 1.0f};

    // Raster XY plane
    for (float x = bounds.min.x; x <= bounds.max.x; x += step_size) {
        for (float y = bounds.min.y; y <= bounds.max.y; y += step_size) {
            // Ray origin (start below the mesh)
            Vec3 ray_origin = {x, y, bounds.min.z - 1.0f};

            // Check intersection with all triangles
            for (int t = 0; t < triangle_count; t++) {
                Vec3 intersection;
                if (ray_triangle_intersect(ray_origin, ray_dir, &tris[t], &intersection)) {
                    add_point(intersection);
                }
            }
        }
    }

    free(tris);

    *out_point_count = output_count;
    return output_points;
}

// Get bounding box (call after convert_to_point_mesh)
EXPORT
void get_bounds(float* out_bounds) {
    out_bounds[0] = bounds.min.x;
    out_bounds[1] = bounds.min.y;
    out_bounds[2] = bounds.min.z;
    out_bounds[3] = bounds.max.x;
    out_bounds[4] = bounds.max.y;
    out_bounds[5] = bounds.max.z;
}

// Free the output array
EXPORT
void free_output() {
    if (output_points != NULL) {
        free(output_points);
        output_points = NULL;
    }
    output_capacity = 0;
    output_count = 0;
}

// Debug function to test data passing
EXPORT
float test_triangle_data(float* triangles, int count) {
    // Return sum of first 9 values as a simple test
    float sum = 0.0f;
    for (int i = 0; i < 9 && i < count * 9; i++) {
        sum += triangles[i];
    }
    return sum;
}
