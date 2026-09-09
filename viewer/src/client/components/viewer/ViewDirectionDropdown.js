import { Box } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

// 展示区浮动工具条上的「切换视图」快捷下拉：固定立方体图标 trigger，展开列出 7 个
// 标准视图方向（俯/仰/左/右/前/后 + 等轴测）。id 与 viewportCameraKit 对齐：
// z=俯、zNeg=仰、xNeg=左、x=右、yNeg=前、y=后（VIEW_PLANE_FACES），isometric=默认等轴测
// （VIEW_PLANE_DEFAULT_PRESET）。方向没有"当前值"枚举状态（相机存快照，不可反推视图名），
// 因此菜单项为普通项、无选中高亮；点击由上层 viewerRef 调 CadViewer 的
// activateViewPlaneFace / activateDefaultViewPlane（仅旋转对齐，与右上角 ViewCube 一致）。
const VIEW_DIRECTION_OPTIONS = [
  { id: "z", label: "俯视图" },
  { id: "zNeg", label: "仰视图" },
  { id: "xNeg", label: "左视图" },
  { id: "x", label: "右视图" },
  { id: "yNeg", label: "前视图" },
  { id: "y", label: "后视图" },
  { id: "isometric", label: "等轴测视图" }
];

export function ViewDirectionDropdown({
  disabled = false,
  onSelectView,
  triggerClassName = "",
  iconClassName = "size-4",
  contentAlign = "end",
  contentSide = "bottom",
  contentSideOffset = 6
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="切换视图"
          title="切换视图"
          className={triggerClassName}
          disabled={disabled}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          <Box className={iconClassName} strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">切换视图</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={contentAlign}
        side={contentSide}
        sideOffset={contentSideOffset}
        className="w-max"
      >
        {VIEW_DIRECTION_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.id}
            className="text-base"
            onSelect={() => {
              onSelectView?.(option.id);
            }}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
