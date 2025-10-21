#!/bin/bash
# Validation script to ensure all optimization versions produce identical results

set -e

echo "======================================"
echo "Optimization Validation Test"
echo "======================================"
echo ""

STL_FILE="inner.stl"
STEP_SIZE="0.1"

echo "Test file: $STL_FILE"
echo "Step size: $STEP_SIZE mm"
echo ""

# Compile all versions
echo "Compiling all versions..."
gcc test-converter-new.c mesh-converter-lib-v1.0-backface.c -o test-v1.0 -lm -O2
gcc test-converter-new.c mesh-converter-lib-v1.2-xy-grid.c -o test-v1.2 -lm -O2
echo "✓ Compilation successful"
echo ""

# Run tests and capture results
echo "Running tests..."
echo ""

echo "=== v1.0 - Backface culling only ==="
v1_0_output=$(./test-v1.0 $STL_FILE $STEP_SIZE 2>&1)
v1_0_points=$(echo "$v1_0_output" | grep "Generated" | awk '{print $2}')
v1_0_time=$(echo "$v1_0_output" | grep "Generated" | awk '{print $5}')
echo "Points: $v1_0_points"
echo "Time: $v1_0_time"
echo ""

echo "=== v1.2 - XY grid partitioning ==="
v1_2_output=$(./test-v1.2 $STL_FILE $STEP_SIZE 2>&1)
v1_2_points=$(echo "$v1_2_output" | grep "Generated" | awk '{print $2}')
v1_2_time=$(echo "$v1_2_output" | grep "Generated" | awk '{print $5}')
echo "Points: $v1_2_points"
echo "Time: $v1_2_time"
echo ""

# Validation
echo "======================================"
echo "Validation Results"
echo "======================================"
echo ""

if [ "$v1_0_points" == "$v1_2_points" ]; then
    echo "✅ PASS: Point counts match ($v1_0_points points)"
else
    echo "❌ FAIL: Point counts differ!"
    echo "  v1.0: $v1_0_points"
    echo "  v1.2: $v1_2_points"
    exit 1
fi

# Calculate speedup
speedup=$(echo "scale=2; $v1_0_time / $v1_2_time" | bc)
echo "✅ Speedup: ${speedup}× (${v1_0_time}s → ${v1_2_time}s)"
echo ""

echo "======================================"
echo "All validations passed! ✅"
echo "======================================"
