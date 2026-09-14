import assert from "node:assert/strict";
import test from "node:test";

import {
  ALIGNMENT_INVALID_REASONS,
  alignmentAnchorPoint,
  applyQuaternionToVector,
  resolveAlignmentFrame,
  resolveAlignmentSource,
  rotatedBoundsMinZ
} from "./alignmentFrame.js";

// 真实样本里的方向（samples/测试2特征识别.txt）
const SAMPLE_PRIME = [0, 0, -1];
const SAMPLE_ASSISTANT = [0, 1, 0];

test("摆正把 primeDirection 转到 +Z、assistantDirection 转到 +X", () => {
  const frame = resolveAlignmentFrame(SAMPLE_PRIME, SAMPLE_ASSISTANT);
  assert.equal(frame.ok, true);
  assert.deepEqual(frame.xAxis, [0, 1, 0]);
  assert.deepEqual(frame.yAxis, [1, 0, 0]);
  assert.deepEqual(frame.zAxis, [0, 0, -1]);

  const z = applyQuaternionToVector(frame.quaternion, SAMPLE_PRIME);
  const x = applyQuaternionToVector(frame.quaternion, SAMPLE_ASSISTANT);
  assert.ok(Math.abs(z[0]) < 1e-12 && Math.abs(z[1]) < 1e-12 && Math.abs(z[2] - 1) < 1e-12,
    `prime 应转到 +Z，实际 ${JSON.stringify(z)}`);
  assert.ok(Math.abs(x[0] - 1) < 1e-12 && Math.abs(x[1]) < 1e-12 && Math.abs(x[2]) < 1e-12,
    `assistant 应转到 +X，实际 ${JSON.stringify(x)}`);
});

test("摆正坐标系是右手系：R 之后 Y′ 仍是 X′ × ... 的第三个轴", () => {
  for (const [prime, assistant] of [
    [[0, 0, -1], [0, 1, 0]],
    [[0, -1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0]],
    [[0, 1, 0], [-1, 0, 0]]
  ]) {
    const frame = resolveAlignmentFrame(prime, assistant);
    assert.equal(frame.ok, true);
    for (const [axis, expected] of [
      [prime, [0, 0, 1]],
      [assistant, [1, 0, 0]]
    ]) {
      const got = applyQuaternionToVector(frame.quaternion, axis);
      for (let i = 0; i < 3; i += 1) {
        assert.ok(Math.abs(got[i] - expected[i]) < 1e-12,
          `${JSON.stringify(prime)}/${JSON.stringify(assistant)} → ${JSON.stringify(got)}`);
      }
    }
    // 行列式 +1（不产生镜像）：X′ × Y′ 应等于 Z′
    const cross = [
      frame.xAxis[1] * frame.yAxis[2] - frame.xAxis[2] * frame.yAxis[1],
      frame.xAxis[2] * frame.yAxis[0] - frame.xAxis[0] * frame.yAxis[2],
      frame.xAxis[0] * frame.yAxis[1] - frame.xAxis[1] * frame.yAxis[0]
    ];
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(cross[i] - frame.zAxis[i]) < 1e-12,
        `${JSON.stringify(prime)}/${JSON.stringify(assistant)}: X′×Y′=${JSON.stringify(cross)} 而 Z′=${JSON.stringify(frame.zAxis)}`);
    }
  }
});

test("轴对齐输入被吸附成精确整数，避免浮点残差", () => {
  const frame = resolveAlignmentFrame([0, 0, -0.9999999999], [0, 0.99999999, 0]);
  assert.equal(frame.ok, true);
  assert.equal(frame.axisAligned, true);
  assert.deepEqual(frame.zAxis, [0, 0, -1]);
  assert.deepEqual(frame.xAxis, [0, 1, 0]);
});

test("assistant 与 prime 不正交时用 Gram-Schmidt 正交化", () => {
  const frame = resolveAlignmentFrame([0, 0, 1], [1, 0, 1]);
  assert.equal(frame.ok, true);
  // (1,0,1) 去掉 +Z 分量后是 (1,0,0)
  assert.deepEqual(frame.xAxis, [1, 0, 0]);
  const x = applyQuaternionToVector(frame.quaternion, [1, 0, 0]);
  assert.ok(Math.abs(x[0] - 1) < 1e-12);
});

test("缺字段 / 非法值 / 平行都拒绝，并给出原因", () => {
  assert.equal(resolveAlignmentFrame(null, SAMPLE_ASSISTANT).reason, ALIGNMENT_INVALID_REASONS.MISSING_PRIME);
  assert.equal(resolveAlignmentFrame(SAMPLE_PRIME, null).reason, ALIGNMENT_INVALID_REASONS.MISSING_ASSISTANT);
  assert.equal(resolveAlignmentFrame([0, 0], SAMPLE_ASSISTANT).reason, ALIGNMENT_INVALID_REASONS.PRIME_INVALID);
  assert.equal(resolveAlignmentFrame([0, 0, Number.NaN], SAMPLE_ASSISTANT).reason, ALIGNMENT_INVALID_REASONS.PRIME_INVALID);
  // null / "" 不能被 Number() 悄悄当成 0
  assert.equal(resolveAlignmentFrame([0, null, -1], SAMPLE_ASSISTANT).reason, ALIGNMENT_INVALID_REASONS.PRIME_INVALID);
  assert.equal(resolveAlignmentFrame(SAMPLE_PRIME, [0, "", 0]).reason, ALIGNMENT_INVALID_REASONS.ASSISTANT_INVALID);
  assert.equal(resolveAlignmentFrame([0, 0, 0], SAMPLE_ASSISTANT).reason, ALIGNMENT_INVALID_REASONS.PRIME_ZERO);
  assert.equal(resolveAlignmentFrame(SAMPLE_PRIME, [0, 0, 0]).reason, ALIGNMENT_INVALID_REASONS.ASSISTANT_ZERO);

  const parallel = resolveAlignmentFrame([0, 0, 1], [0, 0, -1]);
  assert.equal(parallel.ok, false);
  assert.equal(parallel.reason, ALIGNMENT_INVALID_REASONS.PARALLEL);
  // 拒绝时给出的是单位四元数，调用方不会拿到半边坐标系
  assert.deepEqual(parallel.quaternion, [0, 0, 0, 1]);
});

test("锚点取法向为 +prime 的那个包围盒面的中心", () => {
  const bounds = { min: [-50, -20, -10], max: [50, 20, 10] };
  // prime = -Z ⇒ 法向朝 -Z 的面（z = -10）
  assert.deepEqual(alignmentAnchorPoint(bounds, [0, 0, -1]), [0, 0, -10]);
  // prime = +Y ⇒ y = 20 的面
  assert.deepEqual(alignmentAnchorPoint(bounds, [0, 1, 0]), [0, 20, 0]);
  assert.equal(alignmentAnchorPoint(null, [0, 0, 1]), null);
});

test("摆正后按新最低点算地板高度", () => {
  const bounds = { min: [-50, -20, -10], max: [50, 20, 10] };
  const offset = [0, 0, 0];
  // 未摆正：最低点是 z = -10
  assert.equal(rotatedBoundsMinZ(bounds, offset, [0, 0, 0, 1]), -10);
  // prime = +Y ⇒ 参与 Z′ 的是 authored 的 Y 轴（半长 20）
  const frame = resolveAlignmentFrame([0, 1, 0], [1, 0, 0]);
  assert.equal(rotatedBoundsMinZ(bounds, offset, frame.quaternion), -20);
});

test("多实体取体积最大的那一段（用户决策 3）", () => {
  const payload = {
    parts: [
      { partType: "rectangular_part", rectangular_part: { partGeometryInformation: { volume: 100, primeDirection: [0, 1, 0], assistantDirection: [1, 0, 0] } } },
      { partType: "rectangular_part", rectangular_part: { partGeometryInformation: { volume: 900, primeDirection: [0, 0, -1], assistantDirection: [0, 1, 0] } } },
      { partType: "rectangular_part", rectangular_part: { partGeometryInformation: { volume: 500, primeDirection: [-1, 0, 0], assistantDirection: [0, 1, 0] } } }
    ]
  };
  const source = resolveAlignmentSource(payload);
  assert.equal(source.segmentIndex, 1);
  assert.equal(source.volume, 900);
  assert.deepEqual(source.primeDirection, [0, 0, -1]);
});

test("单段（无 parts 包裹）也能解析，缺数字段返回 null", () => {
  const single = resolveAlignmentSource({
    partType: "rectangular_part",
    rectangular_part: { partGeometryInformation: { volume: 12, primeDirection: SAMPLE_PRIME, assistantDirection: SAMPLE_ASSISTANT } }
  });
  assert.equal(single.segmentIndex, 0);
  assert.deepEqual(single.assistantDirection, SAMPLE_ASSISTANT);

  const round = resolveAlignmentSource({
    partType: "round_pure_part",
    round_pure_part: { partGeometryInformation: { volume: 12 } }
  });
  assert.equal(round.primeDirection, null);
  assert.equal(resolveAlignmentSource({}), null);
  assert.equal(resolveAlignmentSource(null), null);
});
