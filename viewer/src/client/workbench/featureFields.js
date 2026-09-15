// 特征参数的结构化描述：字段字典（L1）+ 类型声明（L2）。
//
// 为什么需要它：特征识别 JSON 本身是结构化的 —— 例如 hole.counterbore[i] 下就是
// diameterMax.{diameter,depth} / diameterMin.{diameter,depth} / through / direction /
// relatedEntityIds。但 featureRecognition.js 一直把整个 item 拍平成一句 label 字符串再交给
// 渲染层，于是 UI 只能显示一长串裸文本：既无法纵向对齐，也分不清哪段是数值、哪段是语义。
//
// 两部分的分工：
//   L1 —— FIELD_DICT：字段名 → 中文标签 / 单位 / 语义类别。这是一份**共享词汇表**，
//         各特征类型只是取它的子集（约 15 个字段覆盖全部 16 种特征类型），
//         所以治理对象是"字典"，而不是"每种类型一套模型"。
//   L2 —— FEATURE_BLOCKS：每种特征的字段切成若干**字段块**。块内可以含多个字段值
//         （沉头孔的 Φ11/6.6 就来自 diameterMax + diameterMin），块之间是结构化的。
//
// 渲染层的约束：**只遍历字段块，不 switch(type)**。本表没有的类型返回 null，
// 调用方回退到原来的 label 字符串 —— 所以后端新增特征类型时前端零改动。
//
// 这个模块不碰 React、不碰 DOM，只吃 item 吐数据，因此可以直接单测。

/** 与 featureRecognition.js 的 fmtDim 同规则：最多两位小数、去掉尾随零。 */
export function formatFieldNumber(value) {
  // ⚠️ 必须先挡住 null / undefined / 空串：Number(null) === 0、Number("") === 0，
  // 直接转换会把"字段缺失"渲染成一个假的 0（原 fmtDim 就有这个问题）。
  if (value == null || value === "") {
    return "";
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }
  // toFixed(2) 保证一定带小数点，所以 /\.?0+$/ 不会误吃掉整数末尾的零（如 100 → 100）
  return String(numeric.toFixed(2)).replace(/\.?0+$/, "") || "0";
}

const num = formatFieldNumber;
const join = (values) => values.map(num).filter((text) => text !== "").join("/");

/**
 * L1：字段字典。kind 决定渲染方式 —— measure / compound 用等宽数字，
 * boolean / enum 用普通文字。units 以识别结果为准，这里只做兜底。
 */
export const FIELD_DICT = Object.freeze({
  diameter: { label: "直径", unit: "mm", kind: "measure", prefix: "Φ" },
  diameterMajor: { label: "大径", unit: "mm", kind: "measure", prefix: "Φ" },
  depth: { label: "深度", unit: "mm", kind: "measure", labelByContext: { boss: "高度", groove: "槽深" } },
  depthMajor: { label: "螺纹深度", unit: "mm", kind: "measure" },
  length: { label: "长度", unit: "mm", kind: "measure" },
  width: { label: "宽度", unit: "mm", kind: "measure" },
  height: { label: "高度", unit: "mm", kind: "measure" },
  angle: { label: "角度", unit: "°", kind: "measure" },
  radius: { label: "半径", unit: "mm", kind: "measure", prefix: "R" },
  pitch: { label: "螺距", unit: "mm", kind: "measure" },
  through: { label: "贯穿", unit: "", kind: "boolean" },
  basalArea: { label: "底面积", unit: "mm²", kind: "measure" },
  basalPerimeter: { label: "底周长", unit: "mm", kind: "measure" },
  superficialArea: { label: "面积", unit: "mm²", kind: "measure" },
  volume: { label: "体积", unit: "mm³", kind: "measure" },
  cuttingVolume: { label: "切削体积", unit: "mm³", kind: "measure" },
  type: { label: "类型", unit: "", kind: "enum" }
});

/** 一个字段块。text 为空则丢弃（调用方不再判空）。 */
function block(id, value, options = {}) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  return {
    id,
    label: String(options.label ?? "").trim(),
    value: text,
    unit: String(options.unit ?? "").trim(),
    kind: options.kind || "measure",
    role: String(options.role ?? "").trim()
  };
}

const clean = (list) => list.filter(Boolean);

const throughBlock = (through) => block(
  "through",
  through ? "贯穿" : "盲孔",
  { kind: "boolean" }
);

const roundTypeText = (type) => (type === "cone" ? "锥形" : type === "plane" ? "平面" : String(type || ""));

/**
 * L2：每种特征的字段块声明。key = JSON 里的 sub-feature key（与 FEATURE_TYPES 对齐）。
 * 函数签名统一为 (item, subKey)，因为矩形槽 / U 形槽的通与盲由 subKey 决定，
 * 而不是 item 里的布尔字段（见原 grooveDesc 的实现）。
 */
const FEATURE_BLOCKS = Object.freeze({
  // ---------- 孔 ----------
  threadedHole: (item) => clean([
    block("diameter", join([item.diameter, item.diameterMajor]), { label: "Φ", unit: "mm", kind: "compound", role: "小径/大径" }),
    block("depth", join([item.depth, item.depthMajor]), { label: "深", unit: "mm", kind: "compound", role: "孔深/螺纹深" }),
    block("pitch", num(item.pitch), { label: "螺距", unit: "mm" }),
    throughBlock(item.through)
  ]),
  throughAndBlindHoles: (item) => clean([
    block("diameter", num(item.diameter), { label: "Φ", unit: "mm" }),
    block("depth", num(item.depth), { label: "深", unit: "mm" }),
    throughBlock(item.through)
  ]),
  counterbore: (item) => clean([
    block("diameter", join([item.diameterMax?.diameter, item.diameterMid?.diameter, item.diameterMin?.diameter]), {
      label: "Φ", unit: "mm", kind: "compound", role: "沉头/底孔"
    }),
    block("depth", join([item.diameterMax?.depth, item.diameterMin?.depth]), {
      label: "深", unit: "mm", kind: "compound", role: "沉头深/底孔深"
    }),
    throughBlock(item.through)
  ]),
  precisionHole: (item) => clean([
    item.diameter != null
      ? block("diameter", num(item.diameter), { label: "Φ", unit: "mm" })
      : block("diameter", join([item.diameterMax?.diameter, item.diameterMin?.diameter]), {
        label: "Φ", unit: "mm", kind: "compound", role: "外径/内径"
      }),
    item.diameter != null
      ? block("depth", num(item.depth), { label: "深", unit: "mm" })
      : block("depth", join([item.diameterMax?.depth, item.diameterMin?.depth]), {
        label: "深", unit: "mm", kind: "compound", role: "外深/内深"
      }),
    throughBlock(item.through)
  ]),

  // ---------- 槽 ----------
  rectangularGroove: (item, subKey) => clean([
    block("through", subKey === "throughRounded" || subKey === "throughSharp" ? "通槽" : "盲槽", { kind: "enum" }),
    block("length", num(item.length), { label: "长", unit: "mm" }),
    block("width", num(item.width), { label: "宽", unit: "mm" }),
    block("depth", num(item.depth), { label: "深", unit: "mm" }),
    subKey === "throughSharp" || subKey === "nonThroughSharp"
      ? block("corner", "尖角", { kind: "enum" })
      : block("corner", item.radius != null ? `四角R${num(item.radius)}` : "", { kind: "enum" })
  ]),
  irregularGroove: (item) => clean([
    block("depth", num(item.depth), { label: "深", unit: "mm" }),
    block("through", item.through ? "通槽" : "非通槽", { kind: "enum" })
  ]),
  sawGroove: (item) => clean([
    block("length", num(item.length), { label: "长", unit: "mm" }),
    block("width", num(item.width), { label: "宽", unit: "mm" }),
    block("depth", num(item.depth), { label: "深", unit: "mm" })
  ]),
  uGroove: (item, subKey) => clean([
    block("through", subKey === "through" ? "通槽" : "盲槽", { kind: "enum" }),
    block("length", num(item.length), { label: "长", unit: "mm" }),
    block("width", num(item.width), { label: "宽", unit: "mm" }),
    block("depth", num(item.depth), { label: "深", unit: "mm" })
  ]),
  flat: (item) => clean([
    block("length", num(item.length), { label: "长", unit: "mm" }),
    block("width", num(item.width), { label: "宽", unit: "mm" }),
    block("depth", num(item.depth), { label: "深", unit: "mm" })
  ]),
  keyway: (item) => clean([
    block("length", num(item.length), { label: "长", unit: "mm" }),
    block("width", num(item.width), { label: "宽", unit: "mm" }),
    block("depth", num(item.depth), { label: "深", unit: "mm" }),
    item.through ? block("through", "贯穿", { kind: "boolean" }) : null
  ]),
  unRegularRB: (item) => clean([
    block("depth", num(item.depth), { label: "深", unit: "mm" })
  ]),

  // ---------- 凸台 / 回转 ----------
  step: (item) => clean([
    block("depth", num(item.depth), { label: "高", unit: "mm" }),
    block("basalArea", num(item.basalArea), { label: "底面积", unit: "mm²" })
  ]),
  convex: (item) => clean([
    block("depth", num(item.depth), { label: "高", unit: "mm" }),
    block("basalArea", num(item.basalArea), { label: "底面积", unit: "mm²" }),
    block("basalPerimeter", num(item.basalPerimeter), { label: "底周长", unit: "mm" })
  ]),
  outerCircle: (item) => clean([
    block("diameter", num(item.diameter), { label: "Φ", unit: "mm" }),
    block("length", num(item.length), { label: "长", unit: "mm" })
  ]),
  innerCircle: (item) => clean([
    block("diameter", num(item.diameter), { label: "Φ", unit: "mm" }),
    block("length", num(item.length), { label: "长", unit: "mm" }),
    block("type", roundTypeText(item.type), { kind: "enum" })
  ]),
  centreDrilling: (item) => clean([
    block("diameter", num(item.diameter), { label: "Φ", unit: "mm" }),
    block("length", num(item.length), { label: "长", unit: "mm" }),
    block("type", roundTypeText(item.type), { kind: "enum" })
  ]),
  coneCircle: (item) => clean([
    block("angle", num(item.angle), { label: "角度", unit: "°" }),
    block("diameter", num(item.diameter), { label: "Φ", unit: "mm" }),
    block("length", num(item.length), { label: "长", unit: "mm" })
  ]),
  circlip: (item) => clean([
    block("diameter", join([item.diameterMax, item.diameterMin]), { label: "Φ", unit: "mm", kind: "compound", role: "外径/内径" }),
    block("length", num(item.length), { label: "长", unit: "mm" })
  ]),
  circularGroove: (item) => clean([
    block("diameter", join([item.diameterMax, item.diameterMin]), { label: "Φ", unit: "mm", kind: "compound", role: "外径/内径" }),
    block("length", num(item.length), { label: "长", unit: "mm" })
  ]),

  // ---------- 特殊 / 倒角 / 圆角 / 曲面 / 斜面 ----------
  carve: (item) => clean([
    block("depth", num(item.depth), { label: "深", unit: "mm" }),
    block("basalArea", num(item.basalArea), { label: "底面积", unit: "mm²" })
  ]),
  normalSP: (item) => clean([
    block("depth", num(item.depth), { label: "深", unit: "mm" })
  ]),
  solidThread: (item) => clean([
    block("length", num(item.length), { label: "长", unit: "mm" })
  ]),
  chamfer: (item) => clean([
    block("width", num(item.width), { label: "宽", unit: "mm" })
  ]),
  fillet: (item) => clean([
    block("width", num(item.width), { label: "宽", unit: "mm" }),
    block(
      "type",
      item.type === "concaveFillet" ? "内凹圆角" : item.type === "convexFillet" ? "凸圆角" : String(item.type || ""),
      { kind: "enum" }
    )
  ]),
  curvedSurface: (item) => clean([
    block("superficialArea", num(item.superficialArea), { label: "面积", unit: "mm²" }),
    block("volume", num(item.volume), { label: "体积", unit: "mm³" }),
    block("depth", num(item.depth), { label: "深", unit: "mm" })
  ]),
  bevel: (item) => clean([
    block("angle", num(item.angle), { label: "倾角", unit: "°" }),
    block("depth", num(item.depth), { label: "深", unit: "mm" })
  ])
});

/** 类型短名（显示在"类型"位置）。函数形式用于需要看 item 才能定名的类型。 */
const FEATURE_TYPE_LABELS = Object.freeze({
  threadedHole: "螺纹孔",
  throughAndBlindHoles: (item) => (item.through ? "通孔" : "盲孔"),
  counterbore: "沉头孔",
  precisionHole: "精密孔",
  rectangularGroove: (item, subKey) => (subKey === "throughRounded" || subKey === "throughSharp" ? "矩形通槽" : "矩形盲槽"),
  irregularGroove: "不规则槽",
  sawGroove: "锯片槽",
  uGroove: (item, subKey) => (subKey === "through" ? "U 形通槽" : "U 形盲槽"),
  flat: "平槽",
  keyway: "键槽",
  unRegularRB: "不规则回转槽",
  step: "台阶",
  convex: "凸台",
  outerCircle: "外圆",
  innerCircle: "内圆",
  centreDrilling: "中心钻",
  coneCircle: "锥面",
  circlip: "卡簧槽",
  circularGroove: "环形槽",
  carve: "雕刻",
  normalSP: "特殊加工",
  solidThread: "实体螺纹",
  chamfer: "倒角",
  fillet: "圆角",
  curvedSurface: "曲面",
  bevel: "斜面"
});

/**
 * 把一条特征实例描述成 { typeLabel, blocks }。
 *
 * - `featureKey`：FEATURE_TYPES 里的 sub-feature key（如 "rectangularGroove"），用来查表。
 * - `subKey`：JSON 内层 key（如 "throughSharp"），矩形槽 / U 形槽靠它区分通与盲。
 *
 * 本模块不认识该 featureKey 时返回 null，调用方回退到原 label 字符串（保证向后兼容）。
 */
export function describeFeature({ featureKey, subKey, item }) {
  const builder = FEATURE_BLOCKS[featureKey];
  if (!builder || !item || typeof item !== "object") {
    return null;
  }
  const blocks = clean(builder(item, subKey));
  if (!blocks.length) {
    return null;
  }
  const rawLabel = FEATURE_TYPE_LABELS[featureKey];
  const typeLabel = typeof rawLabel === "function" ? rawLabel(item, subKey) : String(rawLabel || "");
  return { typeLabel, blocks };
}

/** 本模块是否覆盖该 sub-feature key（供测试与调试用）。 */
export function hasFeatureBlocks(featureKey) {
  return Object.prototype.hasOwnProperty.call(FEATURE_BLOCKS, featureKey);
}

/**
 * 把 "12970.00 mm²" 这类已拼好的文本拆成 { value, unit }。
 * 整体信息的叶子目前直接存"值 + 单位"的拼接串，这里在不改数据层的前提下把它拆开，
 * 让数字与单位可以分色（数字等宽右对齐、单位弱化小一号）。
 */
export function splitValueUnit(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return { value: "", unit: "" };
  }
  const match = raw.match(/^([\s\S]*?)\s*(mm³|mm²|mm|°|%)$/);
  if (!match) {
    return { value: raw, unit: "" };
  }
  return { value: match[1].trim(), unit: match[2] };
}
