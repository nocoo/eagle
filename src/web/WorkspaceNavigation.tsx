import { Button, Input } from "@nocoo/basalt";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@nocoo/basalt/components/popover";
import { Check, ChevronDown, Layers3 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Space } from "../shared/schema.ts";
import { workspaceTabs } from "./workspace-navigation.ts";

export function WorkspaceNavigation({
  spaces,
  space,
  panelId,
  mobile,
  onWorkspace,
}: {
  spaces: Space[];
  space: Space;
  panelId: string;
  mobile: boolean;
  onWorkspace: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const results = useRef(new Map<string, HTMLButtonElement>());
  const selection = useRef<string | null>(null);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { visible, hidden } = workspaceTabs(
    spaces.map((s) => s.id),
    space.id,
    width,
  );
  const visibleSpaces = spaces.filter((s) => visible.includes(s.id));
  const hasPicker = mobile || hidden.length > 0;
  const filtered = spaces.filter((s) =>
    `${s.name} ${s.id}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Changing layout is not a workspace selection or a transport event.
    setOpen(false);
    setQuery("");
  }, [mobile, hasPicker]);
  const choose = (id: string) => {
    selection.current = id;
    setOpen(false);
    setQuery("");
    if (id !== space.id) onWorkspace(id);
  };
  return (
    <div className="workspace-navigation" ref={container}>
      {!mobile && (
        <div role="tablist" aria-label="切换工作区" className="workspace-tabs">
          {visibleSpaces.map((item, index) => (
            <Button
              key={item.id}
              ref={(node) => {
                if (node) tabs.current.set(item.id, node);
                else tabs.current.delete(item.id);
              }}
              variant={item.id === space.id ? "secondary" : "ghost"}
              role="tab"
              id={`${panelId}-tab-${item.id}`}
              aria-controls={panelId}
              aria-selected={item.id === space.id}
              tabIndex={item.id === space.id ? 0 : -1}
              aria-label={item.name}
              title={`${item.name} · ${item.id}`}
              className="workspace-tab"
              onClick={() => {
                if (item.id !== space.id) onWorkspace(item.id);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? visibleSpaces.length - 1
                      : event.key === "ArrowRight"
                        ? (index + 1) % visibleSpaces.length
                        : event.key === "ArrowLeft"
                          ? (index + visibleSpaces.length - 1) %
                            visibleSpaces.length
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                const id = visibleSpaces[next].id;
                tabs.current.get(id)?.focus();
                if (id !== space.id) onWorkspace(id);
              }}
            >
              <Layers3 size={13} />
              <span>{item.name}</span>
              <small>{item.tabs.flatMap((t) => t.panes).length}</small>
            </Button>
          ))}
        </div>
      )}
      {hasPicker && (
        <Popover
          open={open}
          onOpenChange={(value) => {
            selection.current = null;
            setQuery("");
            setOpen(value);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              ref={trigger}
              variant="ghost"
              className={
                mobile
                  ? "workspace-picker-trigger"
                  : "workspace-overflow-trigger"
              }
              aria-label={
                mobile ? "选择工作区" : `更多工作区（${hidden.length}）`
              }
              title={mobile ? space.name : "搜索和切换全部工作区"}
            >
              {mobile && <Layers3 size={14} />}
              <span>{mobile ? space.name : `更多 (${hidden.length})`}</span>
              <ChevronDown size={14} />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="workspace-picker"
            align={mobile ? "start" : "end"}
            collisionPadding={8}
            arrow={false}
            aria-label="全部工作区"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              search.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              if (!selection.current || mobile) return;
              event.preventDefault();
              (tabs.current.get(selection.current) ?? trigger.current)?.focus();
              selection.current = null;
            }}
          >
            <PopoverTitle>
              工作区 <small>{spaces.length}</small>
            </PopoverTitle>
            <Input
              ref={search}
              aria-label="搜索工作区"
              placeholder="搜索名称或 ID…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const item =
                    event.key === "ArrowDown" ? filtered[0] : filtered.at(-1);
                  if (item) results.current.get(item.id)?.focus();
                }
              }}
            />
            <div className="workspace-picker-results">
              {!filtered.length && <p role="status">没有匹配的工作区</p>}
              {filtered.map((item, index) => (
                <Button
                  key={item.id}
                  ref={(node) => {
                    if (node) results.current.set(item.id, node);
                    else results.current.delete(item.id);
                  }}
                  variant="ghost"
                  className="workspace-picker-item"
                  aria-label={`切换到 ${item.name}`}
                  aria-pressed={item.id === space.id}
                  onClick={() => choose(item.id)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) {
                      if (event.key === "Enter") event.preventDefault();
                      return;
                    }
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? filtered.length - 1
                          : event.key === "ArrowDown"
                            ? (index + 1) % filtered.length
                            : event.key === "ArrowUp"
                              ? index - 1
                              : -2;
                    if (next === -2) return;
                    event.preventDefault();
                    if (next === -1) search.current?.focus();
                    else results.current.get(filtered[next].id)?.focus();
                  }}
                >
                  <Layers3 size={14} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.id}</small>
                  </span>
                  {item.id === space.id && <Check size={14} />}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
