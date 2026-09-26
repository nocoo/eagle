import { Button, Input } from "@nocoo/basalt";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nocoo/basalt/components/select";
import { Layers3, Search } from "lucide-react";
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
  const items = useRef(new Map<string, HTMLButtonElement>());
  const [query, setQuery] = useState("");
  const filtered = spaces.filter((s) =>
    `${s.name} ${s.id}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  useEffect(() => {
    setQuery("");
  }, [mobile]);
  useEffect(() => {
    if (!mobile)
      items.current.get(space.id)?.scrollIntoView({ block: "nearest" });
  }, [mobile, space.id]);
  const choose = (id: string) => {
    if (id !== space.id) onWorkspace(id);
  };
  const searchField = (
    <div className="workspace-search">
      <Search size={14} aria-hidden="true" />
      <Input
        data-workspace-search
        size="sm"
        aria-label="搜索工作区"
        placeholder="搜索名称或 ID…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && query) {
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
          role="tab"
          aria-controls={panelId}
          aria-selected={item.id === space.id}
          tabIndex={
            item.id === space.id ||
            (!filtered.some((s) => s.id === space.id) && index === 0)
              ? 0
              : -1
          }
          aria-label={item.name}
          title={`${item.name} · ${item.id}`}
          className="workspace-tab"
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
            choose(id);
          }}
        >
          <Layers3 size={14} strokeWidth={1.5} />
          <span className="workspace-tab-copy">
            <strong>{item.name}</strong>
            <small>{item.id}</small>
          </span>
          <span className="workspace-tab-count" title="终端数量">
            {item.tabs.reduce((count, tab) => count + tab.panes.length, 0)}
          </span>
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
    <Select value={space.id} onValueChange={choose}>
      <SelectTrigger
        className="workspace-picker-trigger"
        aria-label="选择工作区"
        title={space.name}
      >
        <Layers3 size={14} />
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        className="workspace-picker"
        align="start"
        collisionPadding={8}
      >
        {spaces.map((item) => (
          <SelectItem
            key={item.id}
            value={item.id}
            title={`${item.name} · ${item.id}`}
          >
            {item.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
