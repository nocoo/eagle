import { Button } from "@nocoo/basalt";
import { ArrowDown } from "@nocoo/basalt/icons";
import { useLayoutEffect, useRef, useState } from "react";
import type { LiveFrame } from "../../../../packages/contracts/src/realtime.ts";
import { compactRenderedFrame } from "../../../../packages/contracts/src/terminal-display.ts";
import { TerminalText } from "./TerminalText.tsx";

export interface TerminalPosition {
  top: number;
  left: number;
  following: boolean;
  unread: boolean;
  content: string;
}

export function TerminalOutput({
  frame,
  selected,
  position,
  onPosition,
}: {
  frame?: LiveFrame;
  selected: boolean;
  position?: TerminalPosition;
  onPosition?: (position: TerminalPosition) => void;
}) {
  const screen = useRef<HTMLPreElement>(null);
  const following = useRef(position?.following ?? true);
  const initialPosition = useRef(position);
  const coordinates = useRef({
    top: position?.top ?? 0,
    left: position?.left ?? 0,
  });
  const geometry = useRef({ height: 0, client: 0, top: 0 });
  const touchY = useRef<number | undefined>(undefined);
  const selecting = useRef(false);
  const initialized = useRef(false);
  const [unread, setUnread] = useState(position?.unread ?? false);
  const latestFrame = useRef(frame);
  latestFrame.current = frame;
  const [selectedFrame, setSelectedFrame] = useState<LiveFrame | null>(null);
  const incoming = frame ? compactRenderedFrame(frame) : undefined;
  const display =
    frame && selectedFrame ? compactRenderedFrame(selectedFrame) : incoming;
  useLayoutEffect(() => {
    const selectionChanged = () => {
      const selection = document.getSelection();
      const el = screen.current;
      const active = !!(
        selection &&
        !selection.isCollapsed &&
        el &&
        selection.containsNode(el, true)
      );
      selecting.current = active;
      if (active) {
        following.current = false;
        setSelectedFrame((old) => old ?? latestFrame.current ?? null);
      } else setSelectedFrame(null);
    };
    document.addEventListener("selectionchange", selectionChanged);
    return () =>
      document.removeEventListener("selectionchange", selectionChanged);
  }, []);
  const content = JSON.stringify([incoming?.text, incoming?.runs]);
  const previous = useRef(position?.content ?? content);
  const save = useRef(onPosition);
  save.current = onPosition;
  const toBottom = () => {
    const el = screen.current;
    if (el?.clientHeight) {
      el.scrollTop = el.scrollHeight;
      geometry.current = {
        height: el.scrollHeight,
        client: el.clientHeight,
        top: el.scrollTop,
      };
    }
  };
  const restore = () => {
    const el = screen.current;
    if (!initialized.current && el?.clientHeight) {
      initialized.current = true;
      el.scrollTop = initialPosition.current?.top ?? 0;
      el.scrollLeft = initialPosition.current?.left ?? 0;
    }
  };
  useLayoutEffect(() => {
    restore();
    const changed = previous.current !== content;
    previous.current = content;
    if (following.current) {
      toBottom();
      setUnread(false);
    } else if (changed && frame) setUnread(true);
  }, [content, selectedFrame, selected]);
  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    const record = () => {
      if (el.clientHeight)
        coordinates.current = { top: el.scrollTop, left: el.scrollLeft };
      save.current?.({
        ...coordinates.current,
        following: following.current,
        unread,
        content: previous.current,
      });
    };
    record();
    return record;
  }, [unread]);
  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      restore();
      if (following.current) toBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="live-output">
      <pre
        ref={screen}
        data-compact-footer={!!frame && display?.text !== frame.text}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Output is a keyboard-scrollable region, not an input control.
        tabIndex={0}
        onWheel={(event) => {
          if (event.deltaY < 0) following.current = false;
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") following.current = false;
        }}
        onTouchStart={(event) => {
          touchY.current = event.touches[0]?.clientY;
        }}
        onTouchMove={(event) => {
          const y = event.touches[0]?.clientY;
          if (
            y !== undefined &&
            touchY.current !== undefined &&
            y > touchY.current
          )
            following.current = false;
          touchY.current = y;
        }}
        onTouchEnd={() => {
          touchY.current = undefined;
        }}
        onTouchCancel={() => {
          touchY.current = undefined;
        }}
        onKeyDown={(event) => {
          if (
            ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
            (event.key === " " && event.shiftKey)
          )
            following.current = false;
        }}
        onScroll={() => {
          const el = screen.current;
          if (!el?.clientHeight) return;
          // A layout-induced scroll can arrive before ResizeObserver. Keep
          // following across viewport changes, but never across user selection.
          if (selecting.current) following.current = false;
          else if (
            following.current &&
            (geometry.current.height !== el.scrollHeight ||
              geometry.current.client !== el.clientHeight) &&
            el.scrollTop >=
              Math.min(
                geometry.current.top,
                el.scrollHeight - el.clientHeight,
              ) -
                1
          )
            toBottom();
          else
            following.current =
              el.scrollHeight - el.clientHeight - el.scrollTop <= 12;
          geometry.current = {
            height: el.scrollHeight,
            client: el.clientHeight,
            top: el.scrollTop,
          };
          coordinates.current = { top: el.scrollTop, left: el.scrollLeft };
          save.current?.({
            ...coordinates.current,
            following: following.current,
            unread: following.current ? false : unread,
            content: previous.current,
          });
          if (following.current) setUnread(false);
        }}
      >
        <TerminalText
          text={display?.text ?? "等待画面…"}
          runs={display?.runs}
        />
      </pre>
      {selectedFrame && frame && (
        <span className="live-selection-notice" role="status">
          选择文字中，画面已暂停更新
        </span>
      )}
      {unread && (
        <Button
          className="live-follow"
          size="sm"
          variant="secondary"
          aria-label="新输出，回到底部"
          onClick={() => {
            if (selecting.current) document.getSelection()?.removeAllRanges();
            selecting.current = false;
            setSelectedFrame(null);
            following.current = true;
            toBottom();
            setUnread(false);
          }}
        >
          <ArrowDown size={13} aria-hidden="true" />
          新输出 · 回到底部
        </Button>
      )}
    </div>
  );
}
