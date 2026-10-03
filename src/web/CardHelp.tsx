import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@nocoo/basalt";
import { Info } from "lucide-react";
import { type ReactNode, useState } from "react";

export function CardHelp({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen} delayDuration={0}>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 text-basalt-muted-foreground"
          aria-label={label}
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <Info size={14} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        className="max-w-xs space-y-2 text-xs leading-relaxed"
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
