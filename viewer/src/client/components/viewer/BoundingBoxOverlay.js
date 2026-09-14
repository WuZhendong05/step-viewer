// 外包围盒 + 三向尺寸的屏幕空间叠加层。
//
// 为什么用 2D SVG 叠加而不是 3D 线框：本项目的相机是**固定的**（换视角只转 viewGroup），
// 所以把包围盒 8 个角点投到屏幕即可 —— 尺寸数字永远正立可读，虚实线型与虚线节距也能
// 精确控制。这与左下角坐标轴指示器（AxesIndicator）的做法一致。
//
// 全部坐标由 boundingBoxGeometry.buildBoundingBoxOverlay() 算好，这里只负责画。
// 纯展示：pointer-events-none，绝不抢画布的指针事件（拾取/框选/绘制都不受影响）。

// 包围盒用琥珀色（与"这是一个测量辅助件、不是零件几何"的语义一致），
// 尺寸线用主题前景色 —— 浅色主题下是深色（与参考图一致），深色主题下自动变浅色。
const BOX_COLOR = "#BA7517";
const BOX_DASH = "5 3.5";

const DIM_ARROW_ID = "cadBoundingBoxDimArrow";

export default function BoundingBoxOverlay({ overlay }) {
  if (!overlay || !overlay.edges?.length) {
    return null;
  }
  // 只画朝向相机的 9 条边。与"隐藏角"相连的那 3 条**完全不画** ——
  // 旋转时它们会整组换位，透出来反而让盒子看着乱、还容易和零件轮廓混淆。
  // （几何模块仍会标记它们：尺寸标注靠这个标记把尺寸线推到盒子外侧、不压在背面上。）
  const visible = [];
  overlay.edges.forEach((edge, index) => {
    if (!edge.hidden) {
      visible.push({ edge, index });
    }
  });

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-20 h-full w-full text-foreground"
      viewBox={`0 0 ${overlay.width} ${overlay.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        {/* orient=auto-start-reverse 让同一个 marker 在两端都朝外指，
            正是尺寸线的画法（箭头在尺寸线两端、尖端顶住引出线）。 */}
        <marker
          id={DIM_ARROW_ID}
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 1L10 5L0 9Z" fill="currentColor" />
        </marker>
      </defs>

      <g stroke={BOX_COLOR} strokeWidth={1} strokeDasharray={BOX_DASH} fill="none">
        {visible.map(({ edge, index }) => (
          <line key={`v${index}`} x1={edge.ax} y1={edge.ay} x2={edge.bx} y2={edge.by} />
        ))}
      </g>

      {overlay.dimensions.map((dimension) => (
        <g key={`dim${dimension.axis}`}>
          <g stroke="currentColor" strokeWidth={0.6} fill="none">
            {dimension.extensions.map((extension, index) => (
              <line
                key={`e${index}`}
                x1={extension.from.x}
                y1={extension.from.y}
                x2={extension.to.x}
                y2={extension.to.y}
              />
            ))}
          </g>
          <line
            x1={dimension.from.x}
            y1={dimension.from.y}
            x2={dimension.to.x}
            y2={dimension.to.y}
            stroke="currentColor"
            strokeWidth={0.9}
            fill="none"
            markerStart={`url(#${DIM_ARROW_ID})`}
            markerEnd={`url(#${DIM_ARROW_ID})`}
          />
          <text
            x={dimension.label.x}
            y={dimension.label.y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={13}
            fontWeight={500}
            fill="currentColor"
            fontFamily="var(--font-sans)"
          >
            {dimension.label.text}
          </text>
        </g>
      ))}
    </svg>
  );
}
