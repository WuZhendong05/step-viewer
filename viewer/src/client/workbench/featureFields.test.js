import test from "node:test";
import assert from "node:assert/strict";

import {
  describeFeature,
  formatFieldNumber,
  hasFeatureBlocks,
  splitValueUnit
} from "./featureFields.js";
import { FEATURE_TYPES, buildFeatureTree } from "./featureRecognition.js";

test("formatFieldNumber：最多两位小数、去尾随零，且不吃掉整数末尾的零", () => {
  assert.equal(formatFieldNumber(11), "11");
  assert.equal(formatFieldNumber(6.6), "6.6");
  assert.equal(formatFieldNumber("8.00"), "8");
  // toFixed(2) 保证先出现小数点，所以 100 不能被削成 1
  assert.equal(formatFieldNumber(100), "100");
  assert.equal(formatFieldNumber(0), "0");
  assert.equal(formatFieldNumber(null), "");
  assert.equal(formatFieldNumber(undefined), "");
});

test("沉头孔：拆成 直径 / 深度 / 贯穿 三块，复合值用斜杠连接", () => {
  const result = describeFeature({
    featureKey: "counterbore",
    subKey: "",
    item: {
      diameterMax: { diameter: 11, depth: 8 },
      diameterMin: { diameter: 6.6, depth: 12 },
      through: true,
      direction: "top"
    }
  });
  assert.equal(result.typeLabel, "沉头孔");
  assert.deepEqual(result.blocks.map((block) => block.id), ["diameter", "depth", "through"]);
  assert.equal(result.blocks[0].label, "Φ");
  assert.equal(result.blocks[0].value, "11/6.6");
  assert.equal(result.blocks[0].unit, "mm");
  assert.equal(result.blocks[0].kind, "compound");
  assert.equal(result.blocks[0].role, "沉头/底孔");
  assert.equal(result.blocks[1].value, "8/12");
  assert.equal(result.blocks[2].value, "贯穿");
  assert.equal(result.blocks[2].kind, "boolean");
});

test("沉头孔中间段（diameterMid）存在时按 沉头/中段/底孔 三段拼接", () => {
  const result = describeFeature({
    featureKey: "counterbore",
    subKey: "",
    item: {
      diameterMax: { diameter: 11, depth: 8 },
      diameterMid: { diameter: 8 },
      diameterMin: { diameter: 6.6, depth: 12 },
      through: false
    }
  });
  assert.equal(result.blocks[0].value, "11/8/6.6");
  assert.equal(result.blocks[2].value, "盲孔");
});

test("通孔与盲孔：类型名跟随 through，且末块是布尔块", () => {
  const through = describeFeature({
    featureKey: "throughAndBlindHoles",
    subKey: "",
    item: { diameter: 10, depth: 5, through: true }
  });
  assert.equal(through.typeLabel, "通孔");
  assert.equal(through.blocks.at(-1).value, "贯穿");

  const blind = describeFeature({
    featureKey: "throughAndBlindHoles",
    subKey: "",
    item: { diameter: 10, depth: 5, through: false }
  });
  assert.equal(blind.typeLabel, "盲孔");
  assert.equal(blind.blocks.at(-1).value, "盲孔");
});

test("矩形槽：通与盲、尖角与圆角都由 subKey 决定（不读 item.through）", () => {
  // 故意给一个与 subKey 矛盾的 through，确认判定确实只认 subKey
  const item = { length: 28, width: 20, depth: 20, through: false };

  const throughSharp = describeFeature({ featureKey: "rectangularGroove", subKey: "throughSharp", item });
  assert.equal(throughSharp.typeLabel, "矩形通槽");
  assert.equal(throughSharp.blocks[0].value, "通槽");
  assert.equal(throughSharp.blocks.at(-1).value, "尖角");

  const nonThroughRounded = describeFeature({
    featureKey: "rectangularGroove",
    subKey: "nonThroughRounded",
    item: { ...item, radius: 0 }
  });
  assert.equal(nonThroughRounded.typeLabel, "矩形盲槽");
  assert.equal(nonThroughRounded.blocks[0].value, "盲槽");
  assert.equal(nonThroughRounded.blocks.at(-1).value, "四角R0");
});

test("圆角：凸/凹圆角进类型块，宽度单独成块", () => {
  const convex = describeFeature({
    featureKey: "fillet",
    subKey: "open",
    item: { width: 3, type: "convexFillet" }
  });
  assert.equal(convex.typeLabel, "圆角");
  assert.deepEqual(convex.blocks.map((block) => block.id), ["width", "type"]);
  assert.equal(convex.blocks[0].value, "3");
  assert.equal(convex.blocks[1].value, "凸圆角");
});

test("未覆盖的类型返回 null，调用方才能回退到原 label（向后兼容的关键）", () => {
  assert.equal(hasFeatureBlocks("pmi"), false);
  assert.equal(describeFeature({ featureKey: "pmi", subKey: "linearTolerance", item: {} }), null);
  assert.equal(describeFeature({ featureKey: "某个未来类型", subKey: "", item: { a: 1 } }), null);
  assert.equal(describeFeature({ featureKey: "counterbore", subKey: "", item: null }), null);
});

test("FEATURE_TYPES 里除 PMI 外的每种特征都有字段块声明（防遗漏）", () => {
  const missing = [];
  for (const type of FEATURE_TYPES) {
    if (type.id === "pmi") {
      continue;
    }
    for (const sub of type.subs) {
      if (!hasFeatureBlocks(sub.key)) {
        missing.push(sub.key);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("空 item 不抛异常，且块内不留空值（宁可少显示也不要空芯片）", () => {
  for (const type of FEATURE_TYPES) {
    for (const sub of type.subs) {
      if (!hasFeatureBlocks(sub.key)) {
        continue;
      }
      const result = describeFeature({ featureKey: sub.key, subKey: "", item: {} });
      if (!result) {
        continue;
      }
      for (const block of result.blocks) {
        assert.ok(block.id, `${sub.key} 的字段块缺 id`);
        assert.notEqual(block.value, "", `${sub.key} 的字段块 ${block.id} 值为空`);
      }
    }
  }
});

test("splitValueUnit：拆出数值与单位，普通文本原样保留", () => {
  assert.deepEqual(splitValueUnit("12970.00 mm²"), { value: "12970.00", unit: "mm²" });
  assert.deepEqual(splitValueUnit("39338.29 mm³"), { value: "39338.29", unit: "mm³" });
  assert.deepEqual(splitValueUnit("282.85 mm"), { value: "282.85", unit: "mm" });
  assert.deepEqual(splitValueUnit("[0.00, 1.00, 0.00]"), { value: "[0.00, 1.00, 0.00]", unit: "" });
  assert.deepEqual(splitValueUnit("2"), { value: "2", unit: "" });
  assert.deepEqual(splitValueUnit(""), { value: "", unit: "" });
  // 只吃掉结尾的单位，不能误伤内部出现的 mm
  assert.deepEqual(splitValueUnit("宽3 mm"), { value: "宽3", unit: "mm" });
});

// 跨模块契约：整体信息的叶子必须带 metric（渲染层据此把数字右对齐成列），
// 而特征叶子必须带 feature —— 两者是不同形态，不能互相顶替。
test("整体信息叶子带 metric；特征叶子带 feature", () => {
  const trees = buildFeatureTree({
    partType: "rectangular_part",
    rectangular_part: {
      partGeometryInformation: { surfaceArea: 12970, volume: 39338.29, basalArea: 2303.37 },
      machinedSurface: { numberOfMachiningSurface: 2, numberOfBevels: 0, numberOfSides: 0 },
      hole: {
        counterbore: [{
          number: 1,
          diameterMax: { diameter: 11, depth: 8 },
          diameterMin: { diameter: 6.6, depth: 12 },
          through: true,
          direction: "top",
          relatedEntityIds: [[1, 2, 3]]
        }]
      }
    }
  });
  const find = (node, id) => {
    if (!node || typeof node !== "object") {
      return null;
    }
    if (node.id === id) {
      return node;
    }
    for (const child of node.children || []) {
      const hit = find(child, id);
      if (hit) {
        return hit;
      }
    }
    return null;
  };
  const tree = trees[0];

  const area = find(tree, "info:sa");
  assert.ok(area, "没找到 info:sa");
  assert.deepEqual(area.metric, { value: "12970.00", unit: "mm²" });
  assert.equal(area.feature, undefined, "整体信息不该有 feature");

  const faces = find(tree, "info:nms");
  assert.deepEqual(faces.metric, { value: "2", unit: "" });

  const hole = find(tree, "feat:H-001");
  assert.ok(hole, "没找到 feat:H-001");
  assert.ok(hole.feature, "特征叶子缺 feature");
  assert.equal(hole.feature.typeLabel, "沉头孔");
  // 方向用短名（2026-09-15 起去掉"表面"后缀，侧栏里 364px 宽、且树里每行都是特征面）
  assert.equal(hole.feature.directionLabel, "上");
  assert.equal(hole.feature.faceCount, 3);
  assert.equal(hole.metric, undefined, "特征叶子不该有 metric");
  assert.deepEqual(hole.feature.blocks.map((block) => block.value), ["11/6.6", "8/12", "贯穿"]);
});

test("DFM 节点带 dfm 标记且组头带计数，非 DFM 节点不受影响", () => {
  const trees = buildFeatureTree({
    partType: "rectangular_part",
    rectangular_part: {
      partGeometryInformation: { surfaceArea: 100 },
      DFM: {
        5001: [{ relatedEntityIds: [1, 2] }, { relatedEntityIds: [3] }],
        3002: [{ relatedEntityIds: [4] }]
      }
    }
  });
  const find = (node, id) => {
    if (!node || typeof node !== "object") {
      return null;
    }
    if (node.id === id) {
      return node;
    }
    for (const child of node.children || []) {
      const hit = find(child, id);
      if (hit) {
        return hit;
      }
    }
    return null;
  };
  const tree = trees[0];

  const root = find(tree, "dfm");
  assert.ok(root, "没找到 dfm 根");
  assert.equal(root.dfm, true);
  assert.equal(root.sub, "2 条", "组头应显示条数");

  assert.equal(find(tree, "dfm:sharp").dfm, true);
  assert.equal(find(tree, "dfm:thinwall").dfm, true);

  const leaf = find(tree, "dfm:5001");
  assert.equal(leaf.dfm, true);
  assert.deepEqual(leaf.badges, ["5001", "共 2 组实体ID"]);

  // 整体信息 / 特征不该被误标成警示
  assert.equal(find(tree, "info").dfm, undefined);
  assert.equal(find(tree, "info:sa").dfm, undefined);
});
