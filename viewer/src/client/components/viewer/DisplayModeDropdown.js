import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  DISPLAY_MODE_OPTIONS,
  displayModeOptionForValue
} from "./DisplayModeOptions";

// 展示区浮动工具条上的「模式」快捷下拉：trigger 图标随当前模式动态变化，
// 展开列出全部 7 种显示模式（实体/渲染/透视/…，与右侧「显示→视图→模式」同一份
// DISPLAY_MODE_OPTIONS），单选、当前项自带选中指示。与右侧面板行共用同一 state
// （CadWorkspace.displaySettings.mode），切换自动双向同步。
// 结构仿 StepExportDropdown：裸 button + triggerClassName（工具条按钮样式），
// onPointerDown stopPropagation 避免抢画布拖拽事件。
export function DisplayModeDropdown({
  value,
  onValueChange,
  triggerClassName = "",
  iconClassName = "size-4",
  contentAlign = "end",
  contentSide = "bottom",
  contentSideOffset = 6
}) {
  const current = displayModeOptionForValue(value);
  const ModeIcon = current.Icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`显示模式：${current.label}`}
          title={`显示模式：${current.label}`}
          className={triggerClassName}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          <ModeIcon className={iconClassName} strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">{`显示模式：${current.label}`}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={contentAlign}
        side={contentSide}
        sideOffset={contentSideOffset}
        className="w-max"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
          {DISPLAY_MODE_OPTIONS.map((option) => {
            const OptionIcon = option.Icon;
            return (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                title={option.title}
                className="gap-2.5 text-base"
              >
                <OptionIcon className="size-4" strokeWidth={2} aria-hidden="true" />
                <span>{option.label}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
