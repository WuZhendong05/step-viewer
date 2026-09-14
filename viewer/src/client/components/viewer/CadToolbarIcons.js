// 底部浮动工具条上的三个自定义图标。
//
// 原本「切换视图」和「零件摆正」都用 lucide 的 Box，长得一模一样、无法区分。
// 这里保留同一个立方体几何，各加一个特征：
//   * 切换视图 —— 立方体顶面着色
//   * 零件摆正 —— 立方体缩小下移，上方加一条带箭头的半圆弧（绕轴摆正）
// 第三个「外包围盒 + 尺寸标注」另起一套几何（角括号 + 双向箭头），见文件末尾。
//
// 三个图标都用 currentColor，所以按钮高亮、深浅主题都自动跟随，不需要维护两套颜色。

// lucide box 的几何（viewBox 0 0 24 24）。三条 path 原样保留，
// 这样两个新图标与工具栏里其它 lucide 图标的笔形完全一致。
const BOX_OUTLINE =
  "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z";
const BOX_TOP_EDGE = "m3.3 7 8.7 5 8.7-5";
const BOX_CENTER_SEAM = "M12 22V12";

// 顶面填充：从左肩沿轮廓的上弧段走到右肩，再沿 V 形棱折回左肩。
// 刻意复用轮廓的弧段与 V 形顶点（20.7/7、12/12、3.3/7），否则填充会与描边错开、
// 露出白边。fillOpacity 用属性而非 currentColor 的透明度，方便一处调整浓淡。
const BOX_TOP_FACE =
  "M3 8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8L20.7 7 12 12 3.3 7Z";
const BOX_TOP_FACE_OPACITY = 0.3;

// 零件摆正：立方体缩到 80%（弧已经压到最小可辨识半径，立方体就尽量放大）并向
// 下移一点，给上方半圆弧让位；整体内容高度 21.2 单位，比原始 lucide Box 的 20.7 还略大，
// 所以在工具栏里看起来不会比原来小。
// 缩放会把描边一起缩细，所以组内 strokeWidth 要除以缩放比，缩回后才是调用方给的粗细。
const ALIGN_CUBE_SCALE = 0.8;
const ALIGN_CUBE_TRANSFORM = `translate(12 15) scale(${ALIGN_CUBE_SCALE}) translate(-12 -12.25)`;

// 半圆弧：圆心 (12,5.6)、半径 4、上凸（最高点 (12,1.6)），两端悬在立方体上方。
// 半径 4 是下限：再小的话 16px 显示时弧高不足 2.7px，基本看不出是弧。
const ALIGN_ARC_PATH = "M8 5.6A4 4 0 0 1 16 5.6";
// 弧右端的顺时针箭头（顶点落在弧的终点上，两条边朝上张开）。
const ALIGN_ARROW_PATH = "M16.89 3.92 16 5.6 15.11 3.92";

export function ViewDirectionCubeIcon({ className, strokeWidth = 2, ...rest }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={BOX_TOP_FACE} fill="currentColor" fillOpacity={BOX_TOP_FACE_OPACITY} stroke="none" />
      <path d={BOX_OUTLINE} />
      <path d={BOX_TOP_EDGE} />
      <path d={BOX_CENTER_SEAM} />
    </svg>
  );
}

export function PartAlignmentIcon({ className, strokeWidth = 2, ...rest }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <g transform={ALIGN_CUBE_TRANSFORM} strokeWidth={strokeWidth / ALIGN_CUBE_SCALE}>
        <path d={BOX_OUTLINE} />
        <path d={BOX_TOP_EDGE} />
        <path d={BOX_CENTER_SEAM} />
      </g>
      <path d={ALIGN_ARC_PATH} />
      <path d={ALIGN_ARROW_PATH} />
    </svg>
  );
}

// 外包围盒 + 尺寸标注：四个角括号（包围盒）+ 一条双向尺寸箭头（标注）。
// 刻意不用立方体几何：工具条上已经有「切换视图」「零件摆正」两个立方体图标，
// 再来一个就分不清了；角括号 + 双向箭头是"测量"的通用语义。
const BBOX_BRACKETS = [
  "M3 8.5 L3 3 L8.5 3",
  "M15.5 3 L21 3 L21 8.5",
  "M3 15.5 L3 21 L8.5 21",
  "M15.5 21 L21 21 L21 15.5"
];
const BBOX_DIM_SHAFT = "M6.5 12 L17.5 12";
const BBOX_DIM_ARROWS = ["M9 9.8 L6.5 12 L9 14.2", "M15 9.8 L17.5 12 L15 14.2"];

export function BoundingBoxIcon({ className, strokeWidth = 2, ...rest }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {BBOX_BRACKETS.map((path) => (
        <path key={path} d={path} />
      ))}
      <path d={BBOX_DIM_SHAFT} />
      {BBOX_DIM_ARROWS.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
