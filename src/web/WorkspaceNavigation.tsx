import { Button, Input } from "@nocoo/basalt";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@nocoo/basalt/components/popover";
import { Check, ChevronDown, Layers3, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Space } from "../shared/schema.ts";

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
  const search = useRef<HTMLInputElement>(null);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = spaces.filter((s) =>
    `${s.name} ${s.id}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [mobile]);
  useEffect(() => {
    if (!mobile)
      items.current.get(space.id)?.scrollIntoView({ block: "nearest" });
  }, [mobile, space.id]);
  const choose = (id: string) => {
    if (mobile) {
      setOpen(false);
      setQuery("");
    }
    if (id !== space.id) onWorkspace(id);
  };
  const searchField = (
    <div className="workspace-search">
      <Search size={14} aria-hidden="true" />
      <Input
        ref={search}
        data-workspace-search
        size="sm"
        aria-label="搜索工作区"
        placeholder="搜索名称或 ID…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && !mobile && query) {
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const item =
              event.key === "ArrowDown" ? filtered[0] : filtered.at(-1);
            if (item) items.current.get(item.id)?.focus();
          }
        }}
      />
    </div>
  );
  const list = (
    <>
      {!filtered.length && <p role="status">没有匹配的工作区</p>}
      {filtered.map((item, index) => (
        <Button
          key={item.id}
          ref={(node) => {
            if (node) items.current.set(item.id, node);
            else items.current.delete(item.id);
          }}
          variant={item.id === space.id ? "secondary" : "ghost"}
          role={mobile ? undefined : "tab"}
          aria-controls={mobile ? undefined : panelId}
          aria-selected={mobile ? undefined : item.id === space.id}
          aria-pressed={mobile ? item.id === space.id : undefined}
          tabIndex={
            mobile ||
            item.id === space.id ||
            (!filtered.some((s) => s.id === space.id) && index === 0)
              ? 0
              : -1
          }
          aria-label={mobile ? `切换到 ${item.name}` : item.name}
          title={`${item.name} · ${item.id}`}
          className={mobile ? "workspace-picker-item" : "workspace-tab"}
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
                      ? (index + filtered.length - 1) % filtered.length
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            const id = filtered[next].id;
            items.current.get(id)?.focus();
            if (!mobile) choose(id);
          }}
        >
          <Layers3 size={14} strokeWidth={1.5} />
          <span className="workspace-tab-copy">
            <strong>{item.name}</strong>
            <small>{item.id}</small>
          </span>
          {mobile ? (
            item.id === space.id && <Check size={14} />
          ) : (
            <span className="workspace-tab-count" title="终端数量">
              {item.tabs.reduce((count, tab) => count + tab.panes.length, 0)}
            </span>
          )}
        </Button>
      ))}
    </>
  );
  if (!mobile)
    return (
      <div className="workspace-navigation">
        <div className="workspace-navigation-heading">
          <span>工作区</span>
          <span>{spaces.length}</span>
        </div>
        {searchField}
        <div
          className="workspace-tabs"
          role="tablist"
          aria-label="切换工作区"
          aria-orientation="vertical"
        >
          {list}
        </div>
      </div>
    );
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setQuery("");
        setOpen(value);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="workspace-picker-trigger"
          aria-label="选择工作区"
          title={space.name}
        >
          <Layers3 size={14} />
          <span>{space.name}</span>
          <ChevronDown size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="workspace-picker"
        align="start"
        collisionPadding={8}
        arrow={false}
        aria-label="全部工作区"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          search.current?.focus();
        }}
      >
        <PopoverTitle>
          工作区 <small>{spaces.length}</small>
        </PopoverTitle>
        {searchField}
        <div className="workspace-picker-results">{list}</div>
      </PopoverContent>
    </Popover>
  );
}
