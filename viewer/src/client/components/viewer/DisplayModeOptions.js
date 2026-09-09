import {
  Contrast,
  Eye,
  EyeOff,
  Layers,
  Paintbrush,
  Spline,
  SquareDashed
} from "lucide-react";
import { CAD_DISPLAY_MODE } from "cadjs/lib/displaySettings";

export const DISPLAY_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: CAD_DISPLAY_MODE.SOLID, label: "实体", title: "带 CAD 边线的着色", Icon: Layers }),
  Object.freeze({ value: CAD_DISPLAY_MODE.RENDERED, label: "渲染", title: "无边线叠加的材质主题着色", Icon: Paintbrush }),
  Object.freeze({ value: CAD_DISPLAY_MODE.TRANSPARENT, label: "透视", title: "半透明实体并显示 CAD 边线", Icon: Eye }),
  Object.freeze({ value: CAD_DISPLAY_MODE.HIDDEN_EDGES, label: "隐藏边", title: "着色并显示隐藏边线", Icon: EyeOff }),
  Object.freeze({ value: CAD_DISPLAY_MODE.HIDDEN_LINES_REMOVED, label: "线条", title: "显示可见线、移除隐藏线", Icon: SquareDashed }),
  Object.freeze({ value: CAD_DISPLAY_MODE.UNSHADED, label: "平涂", title: "无着色的纯色显示", Icon: Contrast }),
  Object.freeze({ value: CAD_DISPLAY_MODE.WIREFRAME, label: "线框", title: "完整线框", Icon: Spline })
]);

export function displayModeOptionForValue(value) {
  return DISPLAY_MODE_OPTIONS.find((option) => option.value === value) || DISPLAY_MODE_OPTIONS[0];
}
