import { Fragment } from "react";
import {
  Contrast,
  Folder,
  LoaderCircle,
  SlidersHorizontal
} from "lucide-react";
import EntryIcon from "./EntryIcon";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/ui/utils";
import { entryIconStatus } from "@/workbench/entryIconStatus";
import FileAccessContextMenu from "./FileAccessContextMenu";
import {
  fileKey,
  listSidebarItems,
} from "@/workbench/sidebar";
import {
  buildBreadcrumbNodes,
  collapsedBreadcrumbNodes,
  directoryTitle,
  ellipsisBreadcrumbMenuDirectory
} from "@/workbench/breadcrumbs";

function fileSheetLabel(fileSheetKind) {
  if (fileSheetKind === "dxf") {
    return "DXF 图纸面板";
  }
  if (fileSheetKind === "urdf") {
    return "URDF 机器人面板";
  }
  if (fileSheetKind === "srdf") {
    return "SRDF 机器人面板";
  }
  if (fileSheetKind === "sdf") {
    return "SDF 机器人面板";
  }
  if (fileSheetKind === "step") {
    return "STEP 模型面板";
  }
  if (fileSheetKind === "implicit") {
    return "隐式 CAD 模型面板";
  }
  return "文件面板";
}

function sourceFormatForEntry(entry, entrySourceFormat) {
  const sourceFormat = typeof entrySourceFormat === "function"
    ? entrySourceFormat(entry)
    : (entry?.kind || "");
  return String(sourceFormat || "").trim().toLowerCase();
}

function entryStatusForMenu(entry, {
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasUrdf,
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true
}) {
  const sourceFormat = sourceFormatForEntry(entry, entrySourceFormat);
  const hasDxf = typeof entryHasDxf === "function" ? entryHasDxf(entry) : true;
  const hasUrdf = typeof entryHasUrdf === "function" ? entryHasUrdf(entry) : true;
  const hasMesh = typeof entryHasMesh === "function" ? entryHasMesh(entry) : true;

  return entryIconStatus(entry, {
    sourceFormat,
    hasMesh,
    hasDxf,
    hasUrdf,
    activeStepArtifactGenerationFile,
    stepArtifactGenerationAvailable
  });
}

function BreadcrumbEntryMenuItem({
  entry,
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasUrdf,
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true
}) {
  const key = fileKey(entry);
  const active = key === selectedKey;
  const label = typeof sidebarLabelForEntry === "function"
    ? sidebarLabelForEntry(entry)
    : key;
  const status = entryStatusForMenu(entry, {
    entrySourceFormat,
    entryHasMesh,
    entryHasDxf,
    entryHasUrdf,
    activeStepArtifactGenerationFile,
    stepArtifactGenerationAvailable
  });
  const { sourceFormat } = status;
  const title = [
    label,
    status.statusLabel,
    entry?.kind,
    String(entry?.file || key)
  ].filter(Boolean).join(" | ");

  return (
    <DropdownMenuItem
      data-active={active}
      className={cn(
        "min-w-0 max-w-80 text-xs focus:bg-sidebar-accent focus:text-sidebar-accent-foreground",
        "data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground"
      )}
      title={title}
      disabled={!key || typeof onSelectEntry !== "function"}
      aria-current={active ? "page" : undefined}
      onSelect={() => {
        if (key && typeof onSelectEntry === "function") {
          onSelectEntry(key);
        }
      }}
    >
      <EntryIcon
        entry={entry}
        sourceFormat={sourceFormat}
        status={status}
        className="size-3.5 shrink-0"
        spinning={status.loading}
      />
      <span className="block min-w-0 flex-1 truncate">{label}</span>
    </DropdownMenuItem>
  );
}

function BreadcrumbDirectoryMenuItems({
  directory,
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasUrdf,
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onExportModelFile,
  onRevealFileAsset,
  onCopyFileAssetReference
}) {
  const items = listSidebarItems(directory);

  if (!items.length) {
    return (
      <DropdownMenuItem disabled className="max-w-80 text-xs">
        <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="block min-w-0 truncate">{String(directory?.name || "Empty")}</span>
      </DropdownMenuItem>
    );
  }

  return items.map((item) => {
    if (item.type === "directory") {
      return (
        <BreadcrumbDirectorySubMenu
          key={item.key}
          directory={item.value}
          selectedKey={selectedKey}
          onSelectEntry={onSelectEntry}
          sidebarLabelForEntry={sidebarLabelForEntry}
          entrySourceFormat={entrySourceFormat}
          entryHasMesh={entryHasMesh}
          entryHasDxf={entryHasDxf}
          entryHasUrdf={entryHasUrdf}
          activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
          stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
          canRevealFileAssets={canRevealFileAssets}
          canCopyFileAssetLinks={canCopyFileAssetLinks}
          canCopyFileAssetPaths={canCopyFileAssetPaths}
          fileAccessBusyKey={fileAccessBusyKey}
          onDownloadFileAsset={onDownloadFileAsset}
          onExportModelFile={onExportModelFile}
          onRevealFileAsset={onRevealFileAsset}
          onCopyFileAssetReference={onCopyFileAssetReference}
        />
      );
    }

    return (
      <BreadcrumbEntryMenuItem
        key={item.key}
        entry={item.value}
        selectedKey={selectedKey}
        onSelectEntry={onSelectEntry}
        sidebarLabelForEntry={sidebarLabelForEntry}
        entrySourceFormat={entrySourceFormat}
        entryHasMesh={entryHasMesh}
        entryHasDxf={entryHasDxf}
        entryHasUrdf={entryHasUrdf}
        activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
        stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
        canRevealFileAssets={canRevealFileAssets}
        canCopyFileAssetLinks={canCopyFileAssetLinks}
        canCopyFileAssetPaths={canCopyFileAssetPaths}
        fileAccessBusyKey={fileAccessBusyKey}
        onDownloadFileAsset={onDownloadFileAsset}
        onExportModelFile={onExportModelFile}
        onRevealFileAsset={onRevealFileAsset}
        onCopyFileAssetReference={onCopyFileAssetReference}
      />
    );
  });
}

function DropdownMenuScrollArea({ children }) {
  return (
    <ScrollArea
      className="max-h-96 w-full"
      type="auto"
      viewportClassName="max-h-96"
    >
      {children}
    </ScrollArea>
  );
}

function BreadcrumbDirectorySubMenu({
  directory,
  label = "",
  title: titleProp = "",
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasUrdf,
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onExportModelFile,
  onRevealFileAsset,
  onCopyFileAssetReference
}) {
  const labelText = String(label || directory?.name || "文件夹");
  const title = String(titleProp || directoryTitle(directory));

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="min-w-0 max-w-80 text-xs"
        title={title}
      >
        <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="block min-w-0 flex-1 truncate">{labelText}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-max max-w-80">
        <DropdownMenuScrollArea>
          <BreadcrumbDirectoryMenuItems
            directory={directory}
            selectedKey={selectedKey}
            onSelectEntry={onSelectEntry}
            sidebarLabelForEntry={sidebarLabelForEntry}
            entrySourceFormat={entrySourceFormat}
            entryHasMesh={entryHasMesh}
            entryHasDxf={entryHasDxf}
            entryHasUrdf={entryHasUrdf}
            activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
            stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
            canRevealFileAssets={canRevealFileAssets}
            canCopyFileAssetLinks={canCopyFileAssetLinks}
            canCopyFileAssetPaths={canCopyFileAssetPaths}
            fileAccessBusyKey={fileAccessBusyKey}
            onDownloadFileAsset={onDownloadFileAsset}
            onExportModelFile={onExportModelFile}
            onRevealFileAsset={onRevealFileAsset}
            onCopyFileAssetReference={onCopyFileAssetReference}
          />
        </DropdownMenuScrollArea>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function BreadcrumbNodeDropdown({
  node,
  current,
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasUrdf,
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  selectedStepSourceStatus = null,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onExportModelFile,
  onRevealFileAsset,
  onRevealInExplorerView,
  onCopyFileAssetReference,
  filenameLoadActivity
}) {
  const label = String(node?.label || "");
  const title = String(node?.title || label);
  const menuDirectory = node?.type === "directory" || node?.type === "placeholder" || node?.type === "entry"
    ? node?.menuDirectory || null
    : null;
  const canBrowse = !!menuDirectory && listSidebarItems(menuDirectory).length > 0;

  if (!canBrowse) {
    const labelNode = (
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-2 text-xs font-medium",
          current ? "max-w-[min(36rem,55vw)] text-foreground" : "max-w-32"
        )}
        title={title}
      >
        {current && node?.type === "entry" ? (
          <FilenameLoadStatus activity={filenameLoadActivity} />
        ) : null}
        <span className="block min-w-0 truncate">{label}</span>
      </span>
    );

    if (node?.type !== "entry" || !node?.entry) {
      return labelNode;
    }

    return (
      <FileAccessContextMenu
        entry={node.entry}
        stepSourceStatus={selectedStepSourceStatus}
        canRevealFileAssets={canRevealFileAssets}
        canCopyFileAssetLinks={canCopyFileAssetLinks}
        canCopyFileAssetPaths={canCopyFileAssetPaths}
        busyKey={fileAccessBusyKey}
        onDownloadFileAsset={onDownloadFileAsset}
        onExportModelFile={onExportModelFile}
        onRevealFileAsset={onRevealFileAsset}
        onRevealInExplorerView={onRevealInExplorerView}
        onCopyFileAssetReference={onCopyFileAssetReference}
      >
        {labelNode}
      </FileAccessContextMenu>
    );
  }

  const triggerButton = (
    <button
      type="button"
      className={cn(
        "inline-flex min-w-0 items-center gap-2 rounded-sm text-xs font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        current
          ? "max-w-[min(36rem,55vw)] text-foreground"
          : "max-w-32 text-muted-foreground"
      )}
      aria-label={`浏览 ${label}`}
      aria-current={current ? "page" : undefined}
      title={title}
      onPointerDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      }}
    >
      {current && node?.type === "entry" ? (
        <FilenameLoadStatus activity={filenameLoadActivity} />
      ) : null}
      <span className="block min-w-0 truncate">{label}</span>
    </button>
  );
  const dropdownTrigger = (
    <DropdownMenuTrigger asChild>
      {triggerButton}
    </DropdownMenuTrigger>
  );
  const trigger = node?.type === "entry" && node?.entry ? (
    <FileAccessContextMenu
      entry={node.entry}
      stepSourceStatus={selectedStepSourceStatus}
      canRevealFileAssets={canRevealFileAssets}
      canCopyFileAssetLinks={canCopyFileAssetLinks}
      canCopyFileAssetPaths={canCopyFileAssetPaths}
      busyKey={fileAccessBusyKey}
      onDownloadFileAsset={onDownloadFileAsset}
      onExportModelFile={onExportModelFile}
      onRevealFileAsset={onRevealFileAsset}
      onRevealInExplorerView={onRevealInExplorerView}
      onCopyFileAssetReference={onCopyFileAssetReference}
    >
      {dropdownTrigger}
    </FileAccessContextMenu>
  ) : dropdownTrigger;

  return (
    <DropdownMenu>
      {trigger}
      <DropdownMenuContent align="start" sideOffset={6} className="w-max max-w-80">
        <DropdownMenuScrollArea>
          <BreadcrumbDirectoryMenuItems
            directory={menuDirectory}
            selectedKey={selectedKey}
            onSelectEntry={onSelectEntry}
            sidebarLabelForEntry={sidebarLabelForEntry}
            entrySourceFormat={entrySourceFormat}
            entryHasMesh={entryHasMesh}
            entryHasDxf={entryHasDxf}
            entryHasUrdf={entryHasUrdf}
            activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
            stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
            canRevealFileAssets={canRevealFileAssets}
            canCopyFileAssetLinks={canCopyFileAssetLinks}
            canCopyFileAssetPaths={canCopyFileAssetPaths}
            fileAccessBusyKey={fileAccessBusyKey}
            onDownloadFileAsset={onDownloadFileAsset}
            onExportModelFile={onExportModelFile}
            onRevealFileAsset={onRevealFileAsset}
            onCopyFileAssetReference={onCopyFileAssetReference}
          />
        </DropdownMenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BreadcrumbEllipsisDropdown({
  nodes,
  selectedKey,
  onSelectEntry,
  sidebarLabelForEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasUrdf,
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onExportModelFile,
  onRevealFileAsset,
  onCopyFileAssetReference,
  title
}) {
  const hiddenNodes = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  const menuTitle = hiddenNodes.map((node) => node.label).join(" / ") || title;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 min-w-7 items-center justify-center rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="显示折叠的路径文件夹"
          title={menuTitle}
        >
          <span aria-hidden="true">…</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-max max-w-80">
        <DropdownMenuScrollArea>
          {hiddenNodes.map((node, index) => {
            const directory = ellipsisBreadcrumbMenuDirectory(node);
            if (node.type === "directory" && directory) {
              return (
                <BreadcrumbDirectorySubMenu
                  key={`${node.type}:${node.id}:${index}`}
                  directory={directory}
                  label={node.label}
                  title={node.title}
                  selectedKey={selectedKey}
                  onSelectEntry={onSelectEntry}
                  sidebarLabelForEntry={sidebarLabelForEntry}
                  entrySourceFormat={entrySourceFormat}
                  entryHasMesh={entryHasMesh}
                  entryHasDxf={entryHasDxf}
                  entryHasUrdf={entryHasUrdf}
                  activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
                  stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
                  canRevealFileAssets={canRevealFileAssets}
                  canCopyFileAssetLinks={canCopyFileAssetLinks}
                  canCopyFileAssetPaths={canCopyFileAssetPaths}
                  fileAccessBusyKey={fileAccessBusyKey}
                  onDownloadFileAsset={onDownloadFileAsset}
                  onExportModelFile={onExportModelFile}
                  onRevealFileAsset={onRevealFileAsset}
                  onCopyFileAssetReference={onCopyFileAssetReference}
                />
              );
            }

            if (node.type === "entry" && node.entry) {
              return (
                <BreadcrumbEntryMenuItem
                  key={`${node.type}:${fileKey(node.entry)}:${index}`}
                  entry={node.entry}
                  selectedKey={selectedKey}
                  onSelectEntry={onSelectEntry}
                  sidebarLabelForEntry={sidebarLabelForEntry}
                  entrySourceFormat={entrySourceFormat}
                  entryHasMesh={entryHasMesh}
                  entryHasDxf={entryHasDxf}
                  entryHasUrdf={entryHasUrdf}
                  activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
                  stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
                  canRevealFileAssets={canRevealFileAssets}
                  canCopyFileAssetLinks={canCopyFileAssetLinks}
                  canCopyFileAssetPaths={canCopyFileAssetPaths}
                  fileAccessBusyKey={fileAccessBusyKey}
                  onDownloadFileAsset={onDownloadFileAsset}
                  onExportModelFile={onExportModelFile}
                  onRevealFileAsset={onRevealFileAsset}
                  onCopyFileAssetReference={onCopyFileAssetReference}
                />
              );
            }

            return (
              <DropdownMenuItem key={`${node.type}:${node.label}:${index}`} disabled className="max-w-80 text-xs">
                <span className="block min-w-0 truncate">{node.label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A bare spinner, left of the filename. No chip, no text, no percent.
 *
 * The overlay already carries the words and the number; repeating them in the breadcrumb
 * gave the same state two competing readouts that could disagree mid-poll. This says only
 * "this file is busy" and leaves the detail to the one place that owns it. The label still
 * rides on `title` and the screen-reader text, so nothing is lost for a11y or hover.
 */
function FilenameLoadStatus({ activity }) {
  if (!activity?.loading) {
    return null;
  }

  const label = String(activity?.label || "").trim();
  const title = String(activity?.title || label || "加载中").trim();

  return (
    <span role="status" aria-live="polite" title={title} className="inline-flex shrink-0 items-center">
      <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">{title}</span>
    </span>
  );
}


const topBarIconButtonClasses = "size-7";
const topBarIconClasses = "size-4";

export default function CadWorkspaceTopBar({
  previewMode,
  sidebarLabelForEntry,
  directoryTree = null,
  selectedKey = "",
  selectedEntry,
  onSelectEntry,
  entrySourceFormat,
  entryHasMesh,
  entryHasDxf,
  entryHasUrdf,
  activeStepArtifactGenerationFile = "",
  stepArtifactGenerationAvailable = true,
  filenameLoadActivity = null,
  selectedStepSourceStatus = null,
  canRevealFileAssets = false,
  canCopyFileAssetLinks = false,
  canCopyFileAssetPaths = false,
  fileAccessBusyKey = "",
  onDownloadFileAsset,
  onExportModelFile,
  onRevealFileAsset,
  onRevealInExplorerView,
  onCopyFileAssetReference,
  fileSheetKind = "",
  fileSheetOpen = false,
  onToggleFileSheet,
  themeEditing = false,
  onToggleThemeEditor,
  navigationAvailable = true
}) {
  if (previewMode) {
    return null;
  }

  const selectedFileLabel = selectedEntry && typeof sidebarLabelForEntry === "function"
    ? sidebarLabelForEntry(selectedEntry)
    : "选择文件";
  const selectedFileTitle = selectedEntry
    ? String(selectedEntry.file || selectedEntry.id || selectedFileLabel)
    : selectedFileLabel;
  const breadcrumbAvailable = navigationAvailable || Boolean(selectedEntry);
  const breadcrumbNodes = buildBreadcrumbNodes({
    directoryTree: navigationAvailable ? directoryTree : null,
    selectedEntry,
    selectedFileLabel,
    selectedFileTitle
  });
  const breadcrumbItems = collapsedBreadcrumbNodes(breadcrumbNodes);
  const mobileBreadcrumbNode = breadcrumbNodes[breadcrumbNodes.length - 1] || null;
  const activeIconButtonClasses = "bg-accent text-accent-foreground";
  const showFileSheetToggle = !!fileSheetKind && typeof onToggleFileSheet === "function";
  const fileSheetToggleLabel = fileSheetOpen
    ? `收起${fileSheetLabel(fileSheetKind)}`
    : `展开${fileSheetLabel(fileSheetKind)}`;
  const themeToggleLabel = themeEditing ? "关闭主题设置" : "打开主题设置";

  return (
    <header
      className="cad-glass-surface pointer-events-auto flex h-11 shrink-0 items-center gap-2 border-b border-sidebar-border px-2 text-sidebar-foreground"
    >
      {showFileSheetToggle ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={fileSheetToggleLabel}
          title={fileSheetToggleLabel}
          aria-pressed={fileSheetOpen && !themeEditing}
          onClick={onToggleFileSheet}
          className={`${topBarIconButtonClasses} ${fileSheetOpen && !themeEditing ? activeIconButtonClasses : ""}`}
        >
          <SlidersHorizontal className={topBarIconClasses} />
          <span className="sr-only">{fileSheetToggleLabel}</span>
        </Button>
      ) : null}

      {breadcrumbAvailable ? (
      <Breadcrumb className="min-w-0 overflow-hidden">
        <ScrollArea
          className="h-8 min-w-0 whitespace-nowrap"
          type="auto"
          viewportClassName="overflow-y-hidden"
          scrollbars="horizontal"
        >
          {mobileBreadcrumbNode ? (
            <BreadcrumbList className="flex h-8 min-w-full flex-nowrap gap-1.5 pr-2 text-xs sm:hidden">
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbNodeDropdown
                  node={mobileBreadcrumbNode}
                  current
                  selectedKey={selectedKey}
                  onSelectEntry={onSelectEntry}
                  sidebarLabelForEntry={sidebarLabelForEntry}
                  entrySourceFormat={entrySourceFormat}
                  entryHasMesh={entryHasMesh}
                  entryHasDxf={entryHasDxf}
                  entryHasUrdf={entryHasUrdf}
                  activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
                  stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
                  selectedStepSourceStatus={selectedStepSourceStatus}
                  canRevealFileAssets={canRevealFileAssets}
                  canCopyFileAssetLinks={canCopyFileAssetLinks}
                  canCopyFileAssetPaths={canCopyFileAssetPaths}
                  fileAccessBusyKey={fileAccessBusyKey}
                  onDownloadFileAsset={onDownloadFileAsset}
                  onExportModelFile={onExportModelFile}
                  onRevealFileAsset={onRevealFileAsset}
                  onRevealInExplorerView={onRevealInExplorerView}
                  onCopyFileAssetReference={onCopyFileAssetReference}
                  filenameLoadActivity={filenameLoadActivity}
                />
              </BreadcrumbItem>
            </BreadcrumbList>
          ) : null}
          <BreadcrumbList className="hidden h-8 min-w-full w-max flex-nowrap gap-1.5 pr-2 text-xs sm:flex sm:gap-1.5">
            {breadcrumbItems.map((item, index) => (
              <Fragment key={`${item.type}:${item.node?.type || ""}:${item.node?.id || item.node?.label || index}:${index}`}>
                <BreadcrumbItem className="min-w-0">
                  {item.type === "ellipsis" ? (
                    <BreadcrumbEllipsisDropdown
                      nodes={item.nodes}
                      selectedKey={selectedKey}
                      onSelectEntry={onSelectEntry}
                      sidebarLabelForEntry={sidebarLabelForEntry}
                      entrySourceFormat={entrySourceFormat}
                      entryHasMesh={entryHasMesh}
                      entryHasDxf={entryHasDxf}
                      entryHasUrdf={entryHasUrdf}
                      activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
                      stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
                      canRevealFileAssets={canRevealFileAssets}
                      canCopyFileAssetLinks={canCopyFileAssetLinks}
                      canCopyFileAssetPaths={canCopyFileAssetPaths}
                      fileAccessBusyKey={fileAccessBusyKey}
                      onDownloadFileAsset={onDownloadFileAsset}
                      onExportModelFile={onExportModelFile}
                      onRevealFileAsset={onRevealFileAsset}
                      onCopyFileAssetReference={onCopyFileAssetReference}
                      title={selectedFileTitle}
                    />
                  ) : (
                    <BreadcrumbNodeDropdown
                      node={item.node}
                      current={index === breadcrumbItems.length - 1}
                      selectedKey={selectedKey}
                      onSelectEntry={onSelectEntry}
                      sidebarLabelForEntry={sidebarLabelForEntry}
                      entrySourceFormat={entrySourceFormat}
                      entryHasMesh={entryHasMesh}
                      entryHasDxf={entryHasDxf}
                      entryHasUrdf={entryHasUrdf}
                      activeStepArtifactGenerationFile={activeStepArtifactGenerationFile}
                      stepArtifactGenerationAvailable={stepArtifactGenerationAvailable}
                      selectedStepSourceStatus={selectedStepSourceStatus}
                      canRevealFileAssets={canRevealFileAssets}
                      canCopyFileAssetLinks={canCopyFileAssetLinks}
                      canCopyFileAssetPaths={canCopyFileAssetPaths}
                      fileAccessBusyKey={fileAccessBusyKey}
                      onDownloadFileAsset={onDownloadFileAsset}
                      onExportModelFile={onExportModelFile}
                      onRevealFileAsset={onRevealFileAsset}
                      onRevealInExplorerView={onRevealInExplorerView}
                      onCopyFileAssetReference={onCopyFileAssetReference}
                      filenameLoadActivity={filenameLoadActivity}
                    />
                  )}
                </BreadcrumbItem>
                {index < breadcrumbItems.length - 1 ? (
                  <BreadcrumbSeparator className="text-muted-foreground/60" />
                ) : null}
              </Fragment>
            ))}
          </BreadcrumbList>
        </ScrollArea>
      </Breadcrumb>
      ) : (
        <div className="min-w-0" />
      )}

      <div className="min-w-0 flex-1" />

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={themeToggleLabel}
          title={themeToggleLabel}
          aria-pressed={themeEditing}
          onClick={onToggleThemeEditor}
          className={`${topBarIconButtonClasses} ${themeEditing ? activeIconButtonClasses : ""}`}
        >
          <Contrast className={topBarIconClasses} strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">{themeToggleLabel}</span>
        </Button>
        </div>
    </header>
  );
}
